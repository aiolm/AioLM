//! Minimal HTTP/1.1 plumbing for the loopback API listener: request parsing
//! with explicit guards, structured error bodies and response writers.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

/// Large enough for base64 images inside a chat request, small enough that a
/// buggy client cannot make the app buffer an unbounded body.
pub(super) const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Bounds how long a client may take to deliver its headers and body. It does
/// not apply to the response, so long generations are unaffected.
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(60);

tokio::task_local! {
    /// The allowed `Origin` of the request being answered, if any. Every
    /// response writer below adds the matching CORS header, so handlers and
    /// stream translators need no knowledge of it.
    static CORS_ORIGIN: Option<String>;
}

pub(super) fn allowed_origin(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .get("origin")
        .filter(|origin| crate::app_origin::is_allowed(origin))
        .cloned()
}

/// Run `work` with every response it writes carrying the CORS header for `origin`.
pub(super) async fn with_cors_origin<F: Future>(origin: Option<String>, work: F) -> F::Output {
    CORS_ORIGIN.scope(origin, work).await
}

/// CORS header lines for the response being written, or nothing.
fn cors_lines() -> String {
    CORS_ORIGIN
        .try_with(|origin| {
            origin
                .as_ref()
                .map(|origin| format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"))
        })
        .ok()
        .flatten()
        .unwrap_or_default()
}

pub(super) struct Request {
    pub method: String,
    /// Request path without the query string.
    pub path: String,
    /// Header names are lower-cased.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Which wire dialect an error body is rendered in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Api {
    OpenAi,
    Anthropic,
}

/// A gateway-originated failure. Errors returned by a model process are never
/// wrapped in this type on the OpenAI routes; they are forwarded verbatim.
#[derive(Debug)]
pub(super) struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub param: Option<&'static str>,
}

impl ApiError {
    pub(super) fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            param: None,
        }
    }

    pub(super) fn with_param(mut self, param: &'static str) -> Self {
        self.param = Some(param);
        self
    }

    pub(super) fn body(&self, api: Api) -> Value {
        match api {
            Api::OpenAi => {
                let kind = match self.status {
                    401 => "authentication_error",
                    500.. => "server_error",
                    _ => "invalid_request_error",
                };
                json!({"error":{"message":self.message,"type":kind,"param":self.param,"code":self.code}})
            }
            Api::Anthropic => {
                let kind = match self.status {
                    401 => "authentication_error",
                    404 => "not_found_error",
                    413 => "request_too_large",
                    503 => "overloaded_error",
                    500.. => "api_error",
                    _ => "invalid_request_error",
                };
                json!({"type":"error","error":{"type":kind,"message":self.message}})
            }
        }
    }
}

const SINGLETON_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "authorization",
    "x-api-key",
    "content-type",
];

enum BodyFraming {
    Length(usize),
    Chunked,
}

/// The parsed request line and headers of a request whose body has not been
/// read yet. Reading the head first lets the listener authenticate a caller
/// before it buffers anything they send.
pub(super) struct Head {
    pub method: String,
    /// Request path without the query string.
    pub path: String,
    /// Header names are lower-cased.
    pub headers: HashMap<String, String>,
    framing: BodyFraming,
    /// Body bytes that arrived together with the headers.
    received: Vec<u8>,
}

fn request_timeout() -> ApiError {
    ApiError::new(408, "request_timeout", "timed out waiting for the request")
}

pub(super) async fn read_head(stream: &mut TcpStream) -> Result<Head, ApiError> {
    tokio::time::timeout(REQUEST_READ_TIMEOUT, read_head_inner(stream))
        .await
        .unwrap_or_else(|_| Err(request_timeout()))
}

pub(super) async fn read_body(stream: &mut TcpStream, head: Head) -> Result<Request, ApiError> {
    tokio::time::timeout(REQUEST_READ_TIMEOUT, read_body_inner(stream, head))
        .await
        .unwrap_or_else(|_| Err(request_timeout()))
}

#[cfg(test)]
pub(super) async fn read_request(stream: &mut TcpStream) -> Result<Request, ApiError> {
    let head = read_head(stream).await?;
    read_body(stream, head).await
}

/// Read and discard what the client is still sending after an early error
/// response. Closing a socket that holds unread data resets the connection,
/// which can destroy the response before the client has read it.
pub(super) async fn discard_unread(stream: &mut TcpStream) {
    let mut sink = [0_u8; 8192];
    let mut budget = 4 * 1024 * 1024_usize;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while budget > 0 {
            match stream.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(count) => budget = budget.saturating_sub(count),
            }
        }
    })
    .await;
}

fn bad_request(message: &str) -> ApiError {
    ApiError::new(400, "invalid_request", message)
}

fn normalize_target_path(target: &str) -> Result<String, ApiError> {
    let raw = if let Some(rest) = target
        .as_bytes()
        .get(..7)
        .is_some_and(|head| head.eq_ignore_ascii_case(b"http://"))
        .then(|| &target[7..])
        .or_else(|| {
            target
                .as_bytes()
                .get(..8)
                .is_some_and(|head| head.eq_ignore_ascii_case(b"https://"))
                .then(|| &target[8..])
        }) {
        let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
        let after_authority = &rest[authority_end..];
        if after_authority.starts_with('/') {
            after_authority
        } else {
            "/"
        }
    } else {
        target
    };
    let mut path = raw.split('?').next().unwrap_or_default();
    if path.is_empty() || !path.starts_with('/') {
        return Err(bad_request("malformed request target"));
    }
    if path.len() > 1 && path.ends_with('/') {
        path = path.trim_end_matches('/');
        if path.is_empty() {
            path = "/";
        }
    }
    Ok(path.to_string())
}

async fn read_head_inner(stream: &mut TcpStream) -> Result<Head, ApiError> {
    let mut bytes = Vec::with_capacity(8192);
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let header_end = index + 4;
            if header_end > MAX_HEADER_BYTES {
                return Err(ApiError::new(
                    431,
                    "headers_too_large",
                    "request headers exceed the 64 KiB limit",
                ));
            }
            break header_end;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(ApiError::new(
                431,
                "headers_too_large",
                "request headers exceed the 64 KiB limit",
            ));
        }
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| bad_request(&format!("request read failed: {error}")))?;
        if count == 0 {
            return Err(bad_request(
                "client closed before the headers were complete",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
    };
    let header_text = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or_default();
    if method.is_empty() || target.is_empty() {
        return Err(bad_request("malformed request line"));
    }
    let path = normalize_target_path(target)?;
    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| bad_request("malformed request header"))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || value
                .bytes()
                .any(|byte| byte == 0x7f || (byte < 0x20 && byte != b'\t'))
        {
            return Err(bad_request("invalid request header name or value"));
        }
        let name = name.to_ascii_lowercase();
        let trimmed = value.trim_matches([' ', '\t']);
        if let Some(existing) = headers.get_mut(&name) {
            if SINGLETON_HEADERS.contains(&name.as_str()) {
                return Err(bad_request(&format!(
                    "duplicate {name} header is not supported"
                )));
            }
            if !trimmed.is_empty() {
                if !existing.is_empty() {
                    existing.push_str(", ");
                }
                existing.push_str(trimmed);
            }
        } else {
            headers.insert(name, trimmed.to_string());
        }
    }
    if headers.contains_key("transfer-encoding") && headers.contains_key("content-length") {
        return Err(bad_request(
            "Transfer-Encoding and Content-Length cannot both be present",
        ));
    }
    let framing = if let Some(encoding) = headers.get("transfer-encoding") {
        if !encoding.trim().eq_ignore_ascii_case("chunked") {
            return Err(bad_request("only Transfer-Encoding: chunked is supported"));
        }
        BodyFraming::Chunked
    } else if let Some(value) = headers.get("content-length") {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(bad_request("Content-Length is not a valid number"));
        }
        let content_length = value
            .parse::<usize>()
            .map_err(|_| bad_request("Content-Length is not a valid number"))?;
        if content_length > MAX_BODY {
            return Err(ApiError::new(
                413,
                "request_too_large",
                format!(
                    "request body exceeds the {} MiB limit",
                    MAX_BODY / (1024 * 1024)
                ),
            ));
        }
        BodyFraming::Length(content_length)
    } else {
        BodyFraming::Length(0)
    };
    Ok(Head {
        method,
        path,
        headers,
        framing,
        received: bytes[header_end..].to_vec(),
    })
}

async fn read_more_chunk_bytes(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    cursor: &mut usize,
) -> Result<(), ApiError> {
    if *cursor > 0 {
        buf.drain(..*cursor);
        *cursor = 0;
    }
    let mut chunk = [0_u8; 8192];
    let count = stream
        .read(&mut chunk)
        .await
        .map_err(|error| bad_request(&format!("request body read failed: {error}")))?;
    if count == 0 {
        return Err(bad_request(
            "client closed before the chunked body was complete",
        ));
    }
    buf.extend_from_slice(&chunk[..count]);
    Ok(())
}

async fn read_chunked_body(stream: &mut TcpStream, mut buf: Vec<u8>) -> Result<Vec<u8>, ApiError> {
    const MAX_CHUNK_LINE: usize = 4096;
    let mut cursor = 0_usize;
    let mut decoded = Vec::new();
    loop {
        let line_len = loop {
            if let Some(pos) = buf[cursor..]
                .windows(2)
                .position(|window| window == b"\r\n")
            {
                break pos;
            }
            if buf.len() - cursor > MAX_CHUNK_LINE {
                return Err(bad_request("chunk size line is too long"));
            }
            read_more_chunk_bytes(stream, &mut buf, &mut cursor).await?;
        };
        if line_len > MAX_CHUNK_LINE {
            return Err(bad_request("chunk size line is too long"));
        }
        let line = std::str::from_utf8(&buf[cursor..cursor + line_len])
            .map_err(|_| bad_request("chunk size line is not valid UTF-8"))?;
        let hex = line
            .split(';')
            .next()
            .unwrap_or_default()
            .trim_matches([' ', '\t']);
        if hex.is_empty() || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(bad_request("invalid chunk size"));
        }
        let chunk_size = usize::from_str_radix(hex, 16)
            .map_err(|_| bad_request("chunk size is out of range"))?;
        cursor += line_len + 2;

        if chunk_size == 0 {
            loop {
                if buf.len() - cursor >= 2 && &buf[cursor..cursor + 2] == b"\r\n" {
                    break;
                }
                if let Some(end) = buf[cursor..]
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                {
                    if end + 4 > MAX_HEADER_BYTES {
                        return Err(ApiError::new(
                            431,
                            "headers_too_large",
                            "chunked trailers exceed the 64 KiB limit",
                        ));
                    }
                    break;
                }
                if buf.len() - cursor > MAX_HEADER_BYTES {
                    return Err(ApiError::new(
                        431,
                        "headers_too_large",
                        "chunked trailers exceed the 64 KiB limit",
                    ));
                }
                read_more_chunk_bytes(stream, &mut buf, &mut cursor).await?;
            }
            break;
        }

        if decoded
            .len()
            .checked_add(chunk_size)
            .is_none_or(|total| total > MAX_BODY)
        {
            return Err(ApiError::new(
                413,
                "request_too_large",
                format!(
                    "request body exceeds the {} MiB limit",
                    MAX_BODY / (1024 * 1024)
                ),
            ));
        }

        while buf.len() - cursor < chunk_size + 2 {
            read_more_chunk_bytes(stream, &mut buf, &mut cursor).await?;
        }
        if &buf[cursor + chunk_size..cursor + chunk_size + 2] != b"\r\n" {
            return Err(bad_request("malformed chunk terminator"));
        }
        decoded.extend_from_slice(&buf[cursor..cursor + chunk_size]);
        cursor += chunk_size + 2;
        if cursor >= 8192 || cursor == buf.len() {
            buf.drain(..cursor);
            cursor = 0;
        }
    }
    Ok(decoded)
}

async fn read_body_inner(stream: &mut TcpStream, head: Head) -> Result<Request, ApiError> {
    let Head {
        method,
        path,
        headers,
        framing,
        received,
    } = head;
    let should_continue = headers
        .get("expect")
        .is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
        && match framing {
            BodyFraming::Length(len) => received.len() < len,
            BodyFraming::Chunked => received.is_empty(),
        };
    if should_continue {
        // curl waits for this before sending a large body; without it every
        // such request stalls for a second. It is sent only once the caller
        // is known to be allowed to send the body.
        stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .map_err(|error| bad_request(&format!("request read failed: {error}")))?;
    }
    let body = match framing {
        BodyFraming::Length(content_length) => {
            let mut body = received;
            let mut buffer = [0_u8; 8192];
            while body.len() < content_length {
                let count = stream
                    .read(&mut buffer)
                    .await
                    .map_err(|error| bad_request(&format!("request body read failed: {error}")))?;
                if count == 0 {
                    return Err(bad_request("client closed before the body was complete"));
                }
                body.extend_from_slice(&buffer[..count]);
            }
            body.truncate(content_length);
            body
        }
        BodyFraming::Chunked => read_chunked_body(stream, received).await?,
    };
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn reason_phrase(status: u16) -> &'static str {
    reqwest::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or("Upstream Error")
}

pub(super) async fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    value: Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(&value)
        .map_err(|error| format!("gateway response encode failed: {error}"))?;
    let mut response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
        reason_phrase(status),
        body.len(),
        cors_lines()
    )
    .into_bytes();
    response.extend_from_slice(&body);
    stream
        .write_all(&response)
        .await
        .map_err(|error| format!("gateway response write failed: {error}"))?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("gateway shutdown failed: {error}"))
}

pub(super) async fn write_api_error(
    stream: &mut TcpStream,
    api: Api,
    error: &ApiError,
) -> Result<(), String> {
    write_json_response(stream, error.status, error.body(api)).await
}

/// Write the head of a response whose body follows as a stream. Without a
/// `content_length` the body is delimited by closing the connection.
pub(super) async fn write_stream_head(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    content_length: Option<u64>,
) -> Result<(), String> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\n",
        reason_phrase(status)
    );
    if content_type.starts_with("text/event-stream") {
        head.push_str("Cache-Control: no-cache\r\n");
    }
    if let Some(length) = content_length {
        head.push_str(&format!("Content-Length: {length}\r\n"));
    }
    head.push_str(&cors_lines());
    head.push_str("Connection: close\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|error| format!("gateway response header failed: {error}"))
}

/// Answer a browser's CORS preflight. It cannot carry the API key, so it is
/// answered before authentication; it grants nothing to origins outside
/// the shared app origin policy, and the request that follows still needs the key.
pub(super) async fn write_preflight(
    stream: &mut TcpStream,
    headers: &HashMap<String, String>,
) -> Result<(), String> {
    let mut head = String::from("HTTP/1.1 204 No Content\r\n");
    if let Some(origin) = allowed_origin(headers) {
        // Browser-managed headers (Host, Origin, Content-Length and the
        // preflight metadata) are not caller-requestable CORS permissions.
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type, x-api-key, anthropic-version, expect\r\nAccess-Control-Max-Age: 600\r\n"
        ));
    }
    head.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|error| format!("gateway preflight write failed: {error}"))?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("gateway shutdown failed: {error}"))
}

pub(super) async fn write_event(
    stream: &mut TcpStream,
    event: &str,
    value: Value,
) -> Result<(), String> {
    // One buffer sized for the framing, the event name and a typical token
    // event's JSON, which is serialized straight into it; larger events grow
    // it. The whole frame still goes out in one write.
    let mut frame = Vec::with_capacity(event.len() + 144);
    frame.extend_from_slice(b"event: ");
    frame.extend_from_slice(event.as_bytes());
    frame.extend_from_slice(b"\ndata: ");
    serde_json::to_writer(&mut frame, &value)
        .map_err(|error| format!("gateway SSE encode failed: {error}"))?;
    frame.extend_from_slice(b"\n\n");
    stream
        .write_all(&frame)
        .await
        .map_err(|error| format!("gateway SSE write failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    async fn connected_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (client, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
        (client.unwrap(), accepted.unwrap().0)
    }

    async fn parse(raw: &[u8]) -> Result<Request, ApiError> {
        let (mut client, mut server) = connected_pair().await;
        client.write_all(raw).await.unwrap();
        read_request(&mut server).await
    }

    fn complete_head_of_length(length: usize) -> Vec<u8> {
        let prefix = b"GET /v1/models HTTP/1.1\r\nX-Filler: ";
        let suffix = b"\r\n\r\n";
        assert!(length >= prefix.len() + suffix.len());
        let mut raw = Vec::with_capacity(length);
        raw.extend_from_slice(prefix);
        raw.extend(std::iter::repeat_n(
            b'a',
            length - prefix.len() - suffix.len(),
        ));
        raw.extend_from_slice(suffix);
        raw
    }

    #[tokio::test]
    async fn a_get_request_needs_no_content_length_and_loses_its_query_string() {
        let request = parse(b"GET /v1/models?limit=2 HTTP/1.1\r\nHost: x\r\nX-Api-Key: k\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/v1/models");
        assert_eq!(request.headers["x-api-key"], "k");
        assert!(request.body.is_empty());
    }

    #[tokio::test]
    async fn the_head_is_available_before_any_body_byte_arrives() {
        let (mut client, mut server) = connected_pair().await;
        client
            .write_all(
                b"POST /v1/chat/completions HTTP/1.1\r\nContent-Length: 5\r\nX-Api-Key: k\r\n\r\n",
            )
            .await
            .unwrap();
        let head = read_head(&mut server).await.unwrap();
        assert_eq!(head.path, "/v1/chat/completions");
        assert_eq!(head.headers["x-api-key"], "k");
        client.write_all(b"hello").await.unwrap();
        let request = read_body(&mut server, head).await.unwrap();
        assert_eq!(request.body, b"hello");
    }

    #[tokio::test]
    async fn a_body_split_across_reads_is_reassembled_and_truncated_to_its_length() {
        let (mut client, mut server) = connected_pair().await;
        client
            .write_all(b"POST /v1/chat/completions HTTP/1.1\r\nContent-Length: 5\r\n\r\nhe")
            .await
            .unwrap();
        let reader = tokio::spawn(async move { read_request(&mut server).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        client.write_all(b"lloEXTRA").await.unwrap();
        let request = reader.await.unwrap().unwrap();
        assert_eq!(request.body, b"hello");
    }

    #[tokio::test]
    async fn an_oversized_declared_body_is_refused_before_it_is_read() {
        let raw = format!(
            "POST /v1/chat/completions HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        let error = parse(raw.as_bytes()).await.err().unwrap();
        assert_eq!((error.status, error.code), (413, "request_too_large"));
    }

    #[tokio::test]
    async fn malformed_transfer_and_length_requests_are_rejected_with_400() {
        for raw in [
            &b"POST /v1/messages HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n"[..],
            &b"POST /v1/messages HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n"[..],
            &b"POST /v1/messages HTTP/1.1\r\nContent-Length: nope\r\n\r\n"[..],
            &b"POST /v1/messages HTTP/1.1\r\nContent-Length: +5\r\n\r\n"[..],
        ] {
            let error = parse(raw).await.err().unwrap();
            assert_eq!(error.status, 400);
        }
    }

    #[tokio::test]
    async fn oversized_headers_are_refused() {
        let mut raw = b"GET /v1/models HTTP/1.1\r\nX-Filler: ".to_vec();
        raw.extend(std::iter::repeat_n(b'a', MAX_HEADER_BYTES + 1));
        let error = parse(&raw).await.err().unwrap();
        assert_eq!(error.status, 431);
    }

    #[tokio::test]
    async fn the_complete_header_limit_is_inclusive_and_rejects_one_byte_over() {
        let request = parse(&complete_head_of_length(MAX_HEADER_BYTES))
            .await
            .unwrap();
        assert_eq!(request.path, "/v1/models");

        let error = parse(&complete_head_of_length(MAX_HEADER_BYTES + 1))
            .await
            .err()
            .unwrap();
        assert_eq!((error.status, error.code), (431, "headers_too_large"));
    }

    #[tokio::test]
    async fn a_header_that_crosses_the_limit_in_a_later_chunk_is_refused() {
        let raw = complete_head_of_length(MAX_HEADER_BYTES + 1);
        let (mut client, mut server) = connected_pair().await;
        client
            .write_all(&raw[..MAX_HEADER_BYTES - 1])
            .await
            .unwrap();
        let reader = tokio::spawn(async move { read_head(&mut server).await });
        tokio::task::yield_now().await;
        client
            .write_all(&raw[MAX_HEADER_BYTES - 1..])
            .await
            .unwrap();

        let error = reader.await.unwrap().err().unwrap();
        assert_eq!((error.status, error.code), (431, "headers_too_large"));
    }

    #[tokio::test]
    async fn a_small_head_can_share_a_read_with_a_large_body() {
        let body = vec![b'b'; MAX_HEADER_BYTES + 1];
        let mut raw = format!(
            "POST /v1/chat/completions HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        raw.extend_from_slice(&body);

        let request = parse(&raw).await.unwrap();
        assert_eq!(request.body, body);
    }

    #[tokio::test]
    async fn a_client_that_disconnects_mid_body_gets_a_bad_request() {
        let (mut client, mut server) = connected_pair().await;
        client
            .write_all(b"POST /v1/messages HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc")
            .await
            .unwrap();
        drop(client);
        let error = read_request(&mut server).await.err().unwrap();
        assert_eq!(error.status, 400);
    }

    #[tokio::test]
    async fn expect_continue_is_acknowledged_before_the_body_arrives() {
        let (mut client, mut server) = connected_pair().await;
        client
            .write_all(
                b"POST /v1/chat/completions HTTP/1.1\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n",
            )
            .await
            .unwrap();
        let reader = tokio::spawn(async move { read_request(&mut server).await });
        let mut interim = [0_u8; 25];
        tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut interim))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&interim, b"HTTP/1.1 100 Continue\r\n\r\n");
        client.write_all(b"{}").await.unwrap();
        assert_eq!(reader.await.unwrap().unwrap().body, b"{}");
    }

    #[tokio::test]
    async fn an_event_frame_is_compact_escaped_json_and_a_closed_stream_fails_to_write() {
        let (mut client, mut server) = connected_pair().await;
        write_event(
            &mut server,
            "response.output_text.delta",
            json!({"type":"response.output_text.delta","delta":"q\"b\\s\n\r\t\u{1}\u{7f}\u{e9}\u{1f600}\u{2028}</"}),
        )
        .await
        .unwrap();
        server.shutdown().await.unwrap();
        let error = write_event(&mut server, "message_stop", json!({"type":"message_stop"}))
            .await
            .unwrap_err();
        assert!(error.starts_with("gateway SSE write failed: "), "{error}");

        let mut wire = Vec::new();
        client.read_to_end(&mut wire).await.unwrap();
        let expected = concat!(
            "event: response.output_text.delta\n",
            r#"data: {"delta":"q\"b\\s\n\r\t\u0001"#,
            "\u{7f}\u{e9}\u{1f600}\u{2028}</",
            r#"","type":"response.output_text.delta"}"#,
            "\n\n",
        );
        assert_eq!(String::from_utf8(wire).unwrap(), expected);
    }

    #[test]
    fn errors_render_in_the_dialect_of_the_route() {
        let error = ApiError::new(503, "model_not_loaded", "no model").with_param("model");
        let openai = error.body(Api::OpenAi);
        assert_eq!(openai["error"]["type"], "server_error");
        assert_eq!(openai["error"]["code"], "model_not_loaded");
        assert_eq!(openai["error"]["param"], "model");
        let anthropic = error.body(Api::Anthropic);
        assert_eq!(anthropic["type"], "error");
        assert_eq!(anthropic["error"]["type"], "overloaded_error");
        assert_eq!(
            ApiError::new(401, "invalid_api_key", "x").body(Api::OpenAi)["error"]["type"],
            "authentication_error"
        );
    }

    #[tokio::test]
    async fn chunked_bodies_with_extensions_and_trailers_decode_and_oversize_returns_413() {
        let request = parse(
            b"POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
        )
        .await
        .unwrap();
        assert_eq!(request.body, b"hello world");

        let with_trailer = parse(
            b"POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\nX-Checksum: abc\r\n\r\n",
        )
        .await
        .unwrap();
        assert_eq!(with_trailer.body, b"hi");

        let oversized_hex = format!("{:x}", MAX_BODY + 1);
        let oversized = format!(
            "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n{oversized_hex}\r\n"
        );
        let error = parse(oversized.as_bytes()).await.err().unwrap();
        assert_eq!((error.status, error.code), (413, "request_too_large"));
    }

    #[tokio::test]
    async fn duplicate_singleton_headers_are_rejected_and_targets_are_normalized() {
        for dup in [
            b"POST /v1/models HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n".as_slice(),
            b"POST /v1/models HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
            b"POST /v1/models HTTP/1.1\r\nAuthorization: Bearer a\r\nAuthorization: Bearer b\r\n\r\n",
        ] {
            let error = parse(dup).await.err().unwrap();
            assert_eq!(error.status, 400);
        }

        let request = parse(
            b"POST http://127.0.0.1:8080/v1/chat/completions/?a=1 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nAccept: application/json\r\nAccept: text/event-stream\r\n\r\n",
        )
        .await
        .unwrap();
        assert_eq!(request.path, "/v1/chat/completions");
        assert_eq!(
            request.headers["accept"],
            "application/json, text/event-stream"
        );
    }
}
