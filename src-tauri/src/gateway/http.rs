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

/// Web origins of the application's own webview: packaged builds per platform
/// and the development server. Browser code from any other origin is not
/// granted access; every request still needs the API key.
const APP_ORIGINS: [&str; 4] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
];

tokio::task_local! {
    /// The allowed `Origin` of the request being answered, if any. Every
    /// response writer below adds the matching CORS header, so handlers and
    /// stream translators need no knowledge of it.
    static CORS_ORIGIN: Option<String>;
}

pub(super) fn allowed_origin(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .get("origin")
        .filter(|origin| APP_ORIGINS.contains(&origin.as_str()))
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

/// The parsed request line and headers of a request whose body has not been
/// read yet. Reading the head first lets the listener authenticate a caller
/// before it buffers anything they send.
pub(super) struct Head {
    pub method: String,
    /// Request path without the query string.
    pub path: String,
    /// Header names are lower-cased.
    pub headers: HashMap<String, String>,
    content_length: usize,
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

async fn read_head_inner(stream: &mut TcpStream) -> Result<Head, ApiError> {
    let mut bytes = Vec::with_capacity(8192);
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
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
    let path = target.split('?').next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err(ApiError::new(
            411,
            "length_required",
            "chunked request bodies are not supported; send a Content-Length header",
        ));
    }
    let content_length = match headers.get("content-length") {
        None => 0,
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| bad_request("Content-Length is not a valid number"))?,
    };
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
    Ok(Head {
        method,
        path,
        headers,
        content_length,
        received: bytes[header_end..].to_vec(),
    })
}

async fn read_body_inner(stream: &mut TcpStream, head: Head) -> Result<Request, ApiError> {
    let Head {
        method,
        path,
        headers,
        content_length,
        received: mut body,
    } = head;
    if body.len() < content_length
        && headers
            .get("expect")
            .is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
    {
        // curl waits for this before sending a large body; without it every
        // such request stalls for a second. It is sent only once the caller
        // is known to be allowed to send the body.
        stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .map_err(|error| bad_request(&format!("request read failed: {error}")))?;
    }
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
/// `APP_ORIGINS`, and the request that follows still needs the key.
pub(super) async fn write_preflight(
    stream: &mut TcpStream,
    headers: &HashMap<String, String>,
) -> Result<(), String> {
    let mut head = String::from("HTTP/1.1 204 No Content\r\n");
    if let Some(origin) = allowed_origin(headers) {
        let requested = headers.get("access-control-request-headers").map_or(
            "authorization, content-type, x-api-key, anthropic-version",
            |value| value.as_str(),
        );
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: {requested}\r\nAccess-Control-Max-Age: 600\r\n"
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
    let data = serde_json::to_string(&value)
        .map_err(|error| format!("gateway SSE encode failed: {error}"))?;
    stream
        .write_all(format!("event: {event}\ndata: {data}\n\n").as_bytes())
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
    async fn chunked_and_malformed_length_requests_are_rejected_with_a_status() {
        let error = parse(b"POST /v1/messages HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, 411);
        let error = parse(b"POST /v1/messages HTTP/1.1\r\nContent-Length: nope\r\n\r\n")
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, 400);
    }

    #[tokio::test]
    async fn oversized_headers_are_refused() {
        let mut raw = b"GET /v1/models HTTP/1.1\r\nX-Filler: ".to_vec();
        raw.extend(std::iter::repeat_n(b'a', MAX_HEADER_BYTES + 1));
        let error = parse(&raw).await.err().unwrap();
        assert_eq!(error.status, 431);
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
}
