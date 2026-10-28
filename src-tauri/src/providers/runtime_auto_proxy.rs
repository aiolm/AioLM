//! An app-owned loopback listener for an explicitly verified local OpenAI server.
//! Stopping this listener drops its requests, never the upstream process.
use reqwest::{redirect::Policy, Client, Url};
use serde_json::{json, Value};
use std::{collections::HashMap, net::IpAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
    time::timeout,
};

const HEADER_LIMIT: usize = 32 * 1024;
const BODY_LIMIT: usize = 8 * 1024 * 1024;
const STREAM_LIMIT: usize = 64 * 1024 * 1024;
// Match the existing gateway's serving window. Setup samples have a separate,
// shorter deadline; ordinary chat must retain time for long generations.
const REQUEST_BUDGET: Duration = Duration::from_secs(3600);
const READ_BUDGET: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 16;

/// Credentials are intentionally not serializable or printable.
pub struct ProxyConfig {
    pub upstream_base: String,
    pub model: String,
    pub port: u16,
    pub api_key: String,
    pub upstream_api_key: Option<String>,
}

struct State {
    client: Client,
    upstream: Url,
    model: String,
    api_key: String,
    upstream_api_key: Option<String>,
    budget: Duration,
}

impl State {
    fn new(config: ProxyConfig) -> Result<Self, String> {
        let mut upstream = Url::parse(&config.upstream_base)
            .map_err(|_| "invalid local server base URL".to_string())?;
        let loopback = upstream.host_str().is_some_and(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
        });
        if upstream.scheme() != "http"
            || !loopback
            || !upstream.username().is_empty()
            || upstream.password().is_some()
            || upstream.query().is_some()
            || upstream.fragment().is_some()
            || !matches!(upstream.path(), "/v1" | "/v1/")
            || upstream.port_or_known_default() == Some(config.port)
            || config.port == 0
        {
            return Err(
                "the upstream must be a different literal loopback HTTP /v1 endpoint".into(),
            );
        }
        if config.model.is_empty()
            || config.model.len() > 8192
            || config.model.chars().any(char::is_control)
        {
            return Err("invalid selected model identifier".into());
        }
        if (!config.api_key.is_empty() && !valid_key(&config.api_key))
            || config
                .upstream_api_key
                .as_ref()
                .is_some_and(|key| !valid_key(key) || key_matches(key, &config.api_key))
        {
            return Err(
                "proxy and upstream credentials must be valid, separate bearer tokens".into(),
            );
        }
        upstream.set_path("/v1/");
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .http1_only()
            .connect_timeout(Duration::from_secs(5))
            .timeout(REQUEST_BUDGET)
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| "cannot initialize the local server HTTP client".to_string())?;
        Ok(Self {
            client,
            upstream,
            model: config.model,
            api_key: config.api_key,
            upstream_api_key: config.upstream_api_key,
            budget: REQUEST_BUDGET,
        })
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 4096 && key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn key_matches(actual: &str, expected: &str) -> bool {
    let mut different = actual.len() ^ expected.len();
    for (index, byte) in expected.bytes().enumerate() {
        different |= usize::from(byte ^ actual.as_bytes().get(index).copied().unwrap_or(0));
    }
    different == 0
}

/// Serve until the owning helper process exits or this future is cancelled.
pub async fn run(config: ProxyConfig) -> Result<(), String> {
    let port = config.port;
    let state = Arc::new(State::new(config)?);
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|error| format!("cannot bind the app-owned loopback proxy: {error}"))?;
    serve(listener, state).await
}

async fn serve(listener: TcpListener, state: Arc<State>) -> Result<(), String> {
    // Dropping this set aborts every owned handler, including its upstream read.
    let mut requests = JoinSet::new();
    loop {
        if requests.len() >= MAX_CONNECTIONS {
            requests.join_next().await;
            continue;
        }
        tokio::select! {
            accepted = listener.accept() => {
                let (socket, _) = accepted.map_err(|error| format!("loopback proxy accept failed: {error}"))?;
                let state = Arc::clone(&state);
                requests.spawn(async move { handle(socket, state).await; });
            }
            _ = requests.join_next(), if !requests.is_empty() => {}
        }
    }
}

struct Failure {
    status: u16,
    message: &'static str,
}

fn failure(status: u16, message: &'static str) -> Failure {
    Failure { status, message }
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    length: usize,
    has_length: bool,
    prefix: Vec<u8>,
}

async fn head(socket: &mut TcpStream) -> Result<Request, Failure> {
    let mut bytes = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            if index + 4 > HEADER_LIMIT {
                return Err(failure(431, "request headers exceed the size limit"));
            }
            break index + 4;
        }
        if bytes.len() >= HEADER_LIMIT {
            return Err(failure(431, "request headers exceed the size limit"));
        }
        let mut chunk = [0; 2048];
        let count = socket
            .read(&mut chunk)
            .await
            .map_err(|_| failure(400, "cannot read request headers"))?;
        if count == 0 {
            return Err(failure(400, "incomplete request headers"));
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let text = std::str::from_utf8(&bytes[..header_end - 4])
        .map_err(|_| failure(400, "request headers must be valid text"))?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let method = request_line.next().unwrap_or_default();
    let path = request_line.next().unwrap_or_default();
    if request_line.next() != Some("HTTP/1.1")
        || request_line.next().is_some()
        || method.is_empty()
        || !method.bytes().all(|byte| byte.is_ascii_uppercase())
        || !path.starts_with('/')
        || path.len() > 2048
        || !path.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(failure(
            400,
            "expected a bounded HTTP/1.1 origin-form request",
        ));
    }
    let mut headers = HashMap::new();
    for (index, line) in lines.enumerate() {
        if index >= 100 {
            return Err(failure(431, "too many request headers"));
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| failure(400, "invalid request header"))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || value
                .bytes()
                .any(|byte| byte == 0x7f || (byte < 0x20 && byte != b'\t'))
        {
            return Err(failure(400, "invalid request header"));
        }
        if headers
            .insert(
                name.to_ascii_lowercase(),
                value.trim_matches([' ', '\t']).to_string(),
            )
            .is_some()
        {
            return Err(failure(400, "duplicate request headers are not supported"));
        }
    }
    if !headers.contains_key("host") || headers.contains_key("transfer-encoding") {
        return Err(failure(
            400,
            "send one Host header and a Content-Length body, without transfer encoding",
        ));
    }
    let has_length = headers.contains_key("content-length");
    let length = match headers.get("content-length") {
        None => 0,
        Some(value) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            value
                .parse::<usize>()
                .ok()
                .filter(|length| *length <= BODY_LIMIT)
                .ok_or_else(|| failure(413, "request body exceeds the size limit"))?
        }
        Some(_) => return Err(failure(400, "invalid Content-Length")),
    };
    Ok(Request {
        method: method.into(),
        path: path.into(),
        headers,
        length,
        has_length,
        prefix: bytes[header_end..].to_vec(),
    })
}

async fn body(socket: &mut TcpStream, request: &Request) -> Result<Vec<u8>, Failure> {
    if request.prefix.len() > request.length {
        return Err(failure(400, "request data exceeds Content-Length"));
    }
    let mut bytes = request.prefix.clone();
    while bytes.len() < request.length {
        let remaining = (request.length - bytes.len()).min(8192);
        let mut chunk = [0; 8192];
        let count = socket
            .read(&mut chunk[..remaining])
            .await
            .map_err(|_| failure(400, "cannot read request body"))?;
        if count == 0 {
            return Err(failure(400, "incomplete request body"));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(bytes)
}

fn authorized(request: &Request, state: &State) -> bool {
    // The existing headless CLI explicitly runs its loopback server without a
    // credential. An empty key preserves that policy; desktop keys stay strict.
    if state.api_key.is_empty() {
        return true;
    }
    request.headers.get("authorization").is_some_and(|value| {
        value.split_once(' ').is_some_and(|(scheme, token)| {
            scheme.eq_ignore_ascii_case("bearer") && key_matches(token, &state.api_key)
        })
    })
}

async fn client_closed(socket: &TcpStream) -> Failure {
    // The complete Content-Length request has already been consumed, and each
    // connection serves one request. Further input or EOF ends that ownership.
    // Race this against upstream waits so Stop need not wait for another token.
    let mut byte = [0; 1];
    match socket.peek(&mut byte).await {
        Ok(0) | Err(_) => failure(400, "client closed its request"),
        Ok(_) => failure(400, "pipelined requests are not supported"),
    }
}

async fn dispatch(
    socket: &mut TcpStream,
    state: &State,
    started: &mut bool,
    origin: &mut Option<String>,
) -> Result<(), Failure> {
    let request = timeout(READ_BUDGET.min(state.budget), head(socket))
        .await
        .map_err(|_| failure(408, "request headers timed out"))??;
    if let Some(request_origin) = request.headers.get("origin") {
        if !crate::app_origin::is_allowed(request_origin) {
            return Err(failure(403, "this browser origin is not allowed"));
        }
        *origin = Some(request_origin.clone());
    }
    if request.method == "OPTIONS" {
        return preflight(socket, &request, origin.as_deref(), started).await;
    }
    let health = request.method == "GET" && request.path == "/health";
    if !health && !authorized(&request, state) {
        return Err(failure(401, "a valid app bearer token is required"));
    }
    if health || (request.method == "GET" && request.path == "/v1/models") {
        if request.length != 0 || !request.prefix.is_empty() {
            return Err(failure(400, "this endpoint does not accept a request body"));
        }
        let value = if health {
            json!({"status":"ok"})
        } else {
            json!({"object":"list","data":[{"id":state.model,"object":"model","owned_by":"external"}]})
        };
        return json_response(socket, 200, &value, started, origin.as_deref()).await;
    }
    if request.path != "/v1/chat/completions" {
        return Err(failure(
            404,
            "this proxy supports only health, model listing and verified chat completions",
        ));
    }
    if request.method != "POST" {
        return Err(failure(405, "chat completions requires POST"));
    }
    if !request.has_length {
        return Err(failure(411, "chat completions requires Content-Length"));
    }
    if !request.headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return Err(failure(415, "chat completions requires application/json"));
    }
    if let Some(expectation) = request.headers.get("expect") {
        if !expectation.eq_ignore_ascii_case("100-continue") {
            return Err(failure(417, "unsupported request expectation"));
        }
        socket
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .map_err(|_| failure(400, "cannot acknowledge request body"))?;
    }
    let bytes = timeout(READ_BUDGET.min(state.budget), body(socket, &request))
        .await
        .map_err(|_| failure(408, "request body timed out"))??;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| failure(400, "invalid JSON request body"))?;
    if value.get("model").and_then(Value::as_str) != Some(state.model.as_str()) {
        return Err(failure(400, "request model must match the selected model"));
    }
    let streaming = match value.get("stream") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err(failure(400, "stream must be a boolean")),
    };
    let endpoint = state
        .upstream
        .join("chat/completions")
        .map_err(|_| failure(502, "invalid upstream chat endpoint"))?;
    let mut upstream = state.client.post(endpoint).json(&value).header(
        "Accept",
        if streaming {
            "text/event-stream"
        } else {
            "application/json"
        },
    );
    // Incoming headers, including the app credential, never enter this request.
    if let Some(key) = &state.upstream_api_key {
        upstream = upstream.bearer_auth(key);
    }
    let mut response = tokio::select! {
        response = upstream.send() => response.map_err(|_| failure(502, "upstream chat request failed"))?,
        closed = client_closed(socket) => return Err(closed),
    };
    if response
        .headers()
        .iter()
        .map(|(name, value)| name.as_str().len() + value.as_bytes().len() + 4)
        .sum::<usize>()
        > HEADER_LIMIT
    {
        return Err(failure(
            502,
            "upstream response headers exceed the size limit",
        ));
    }
    if !response.status().is_success() {
        return Err(failure(
            if response.status().is_redirection() {
                502
            } else {
                response.status().as_u16()
            },
            "upstream server rejected the chat request",
        ));
    }
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim();
    if streaming {
        if !kind.eq_ignore_ascii_case("text/event-stream") {
            return Err(failure(502, "upstream did not return an event stream"));
        }
        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n{}Connection: close\r\n\r\n", cors_lines(origin.as_deref()));
        socket
            .write_all(header.as_bytes())
            .await
            .map_err(|_| failure(502, "cannot send stream headers"))?;
        *started = true;
        let mut total = 0usize;
        loop {
            let next = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|_| failure(502, "upstream event stream failed"))?,
                closed = client_closed(socket) => return Err(closed),
            };
            let Some(chunk) = next else { break };
            total = total
                .checked_add(chunk.len())
                .ok_or_else(|| failure(502, "upstream event stream exceeds the size limit"))?;
            if total > STREAM_LIMIT {
                return Err(failure(502, "upstream event stream exceeds the size limit"));
            }
            socket
                .write_all(&chunk)
                .await
                .map_err(|_| failure(502, "client closed its event stream"))?;
        }
        Ok(())
    } else {
        if !kind.eq_ignore_ascii_case("application/json") {
            return Err(failure(502, "upstream did not return JSON"));
        }
        let mut bytes = Vec::new();
        loop {
            let next = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|_| failure(502, "upstream JSON response failed"))?,
                closed = client_closed(socket) => return Err(closed),
            };
            let Some(chunk) = next else { break };
            if bytes.len().saturating_add(chunk.len()) > BODY_LIMIT {
                return Err(failure(
                    502,
                    "upstream JSON response exceeds the size limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| failure(502, "upstream returned invalid JSON"))?;
        json_response(socket, 200, &value, started, origin.as_deref()).await
    }
}

async fn handle(mut socket: TcpStream, state: Arc<State>) {
    let mut started = false;
    let mut origin = None;
    let result = timeout(
        state.budget,
        dispatch(&mut socket, &state, &mut started, &mut origin),
    )
    .await;
    let error = match result {
        Ok(Ok(())) => return,
        Ok(Err(error)) => error,
        Err(_) => failure(504, "proxy request timed out"),
    };
    let value = json!({"error":{"message":error.message,"type":"aiolm_proxy_error"}});
    if started {
        let event = format!("data: {value}\n\n");
        let _ = timeout(Duration::from_secs(1), socket.write_all(event.as_bytes())).await;
    } else {
        let _ = timeout(
            Duration::from_secs(1),
            json_response(
                &mut socket,
                error.status,
                &value,
                &mut started,
                origin.as_deref(),
            ),
        )
        .await;
    }
}

async fn json_response(
    socket: &mut TcpStream,
    status: u16,
    value: &Value,
    started: &mut bool,
    origin: Option<&str>,
) -> Result<(), Failure> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| failure(500, "cannot encode proxy response"))?;
    let auth = if status == 401 {
        "WWW-Authenticate: Bearer\r\n"
    } else {
        ""
    };
    let header = format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{auth}{}Connection: close\r\n\r\n", bytes.len(), cors_lines(origin));
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|_| failure(502, "cannot send proxy response headers"))?;
    *started = true;
    socket
        .write_all(&bytes)
        .await
        .map_err(|_| failure(502, "cannot send proxy response"))
}

fn cors_lines(origin: Option<&str>) -> String {
    origin
        .filter(|origin| crate::app_origin::is_allowed(origin))
        .map(|origin| format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"))
        .unwrap_or_default()
}

/// A browser preflight cannot carry the app token. Grant only the existing app
/// origins and this proxy's actual methods/headers; the following request still
/// passes normal bearer authentication. Headless requests need no Origin.
async fn preflight(
    socket: &mut TcpStream,
    request: &Request,
    origin: Option<&str>,
    started: &mut bool,
) -> Result<(), Failure> {
    let origin = origin.ok_or_else(|| failure(403, "preflight requires an allowed app origin"))?;
    let method = match request.path.as_str() {
        "/health" | "/v1/models" => "GET",
        "/v1/chat/completions" => "POST",
        _ => return Err(failure(404, "unverified preflight route")),
    };
    if request.length != 0
        || !request.prefix.is_empty()
        || request
            .headers
            .get("access-control-request-method")
            .map(String::as_str)
            != Some(method)
        || request
            .headers
            .get("access-control-request-headers")
            .is_some_and(|headers| {
                headers.split(',').any(|header| {
                    !matches!(
                        header.trim().to_ascii_lowercase().as_str(),
                        "authorization" | "content-type"
                    )
                })
            })
    {
        return Err(failure(
            400,
            "unsupported preflight method, headers or body",
        ));
    }
    let private_network = match request
        .headers
        .get("access-control-request-private-network")
        .map(String::as_str)
    {
        None => "",
        Some("true") => "Access-Control-Allow-Private-Network: true\r\n",
        Some(_) => return Err(failure(400, "invalid private network preflight")),
    };
    let header = format!(
        "HTTP/1.1 204 No Content\r\n{}Access-Control-Allow-Methods: {method}, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type\r\nAccess-Control-Max-Age: 600\r\n{private_network}Content-Length: 0\r\nConnection: close\r\n\r\n",
        cors_lines(Some(origin)),
    );
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|_| failure(400, "cannot answer preflight"))?;
    *started = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::{
        sync::{Mutex, Notify},
        task::JoinHandle,
    };

    const APP_KEY: &str = "synthetic-app-key";
    const MODEL: &str = "synthetic-model";

    struct Recorded {
        headers: HashMap<String, String>,
        value: Value,
    }

    #[derive(Clone)]
    enum Answer {
        Stream,
        Json,
        Redirect(String),
        StalledStream,
        FirstStreamStalls,
    }

    struct Upstream {
        address: SocketAddr,
        recorded: Arc<Mutex<Vec<Recorded>>>,
        closed: Arc<Notify>,
        task: JoinHandle<()>,
    }

    impl Drop for Upstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn upstream(answer: Answer) -> Upstream {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&recorded);
        let closed = Arc::new(Notify::new());
        let observed_closed = Arc::clone(&closed);
        let task = tokio::spawn(async move {
            let mut handlers = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break };
                        let recorded = Arc::clone(&observed);
                        let answer = answer.clone();
                        let closed = Arc::clone(&observed_closed);
                        handlers.spawn(async move {
                            let request = head(&mut socket).await.unwrap_or_else(|error| panic!("{}", error.message));
                            let bytes = body(&mut socket, &request).await.unwrap_or_else(|error| panic!("{}", error.message));
                            let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                            let sequence = {
                                let mut recorded = recorded.lock().await;
                                recorded.push(Recorded { headers: request.headers, value });
                                recorded.len()
                            };
                            if request.path == "/v1/models" {
                                let value = json!({"object":"list","data":[{"id":MODEL}]});
                                let _ = json_response(&mut socket, 200, &value, &mut false, None).await;
                                return;
                            }
                            match answer {
                                Answer::Json => {
                                    let value = json!({"model":MODEL,"choices":[{"message":{"content":"5"}}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}});
                                    let _ = json_response(&mut socket, 200, &value, &mut false, None).await;
                                }
                                Answer::Redirect(location) => {
                                    let response = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                    let _ = socket.write_all(response.as_bytes()).await;
                                }
                                Answer::Stream | Answer::StalledStream | Answer::FirstStreamStalls => {
                                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await;
                                    let _ = socket.write_all(b"data: {\"model\":\"synthetic-model\",\"choices\":[{\"delta\":{\"content\":\"5\"}}]}\n\n").await;
                                    if matches!(answer, Answer::StalledStream) || (matches!(answer, Answer::FirstStreamStalls) && sequence == 1) {
                                        let mut byte = [0; 1];
                                        assert!(matches!(socket.read(&mut byte).await, Ok(0) | Err(_)));
                                        closed.notify_one();
                                        return;
                                    }
                                    tokio::task::yield_now().await;
                                    let _ = socket.write_all(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":1,\"total_tokens\":5}}\n\ndata: [DONE]\n\n").await;
                                }
                            }
                        });
                    }
                    _ = handlers.join_next(), if !handlers.is_empty() => {}
                }
            }
        });
        Upstream {
            address,
            recorded,
            closed,
            task,
        }
    }

    struct Proxy {
        address: SocketAddr,
        task: JoinHandle<Result<(), String>>,
    }

    impl Drop for Proxy {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn config(upstream: SocketAddr, port: u16) -> ProxyConfig {
        ProxyConfig {
            upstream_base: format!("http://{upstream}/v1"),
            model: MODEL.into(),
            port,
            api_key: APP_KEY.into(),
            upstream_api_key: None,
        }
    }

    async fn proxy(upstream: &Upstream, budget: Duration, upstream_key: Option<&str>) -> Proxy {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let mut config = config(upstream.address, address.port());
        config.upstream_api_key = upstream_key.map(str::to_string);
        let mut state = State::new(config).unwrap();
        state.budget = budget;
        let task = tokio::spawn(serve(listener, Arc::new(state)));
        Proxy { address, task }
    }

    async fn exchange(address: SocketAddr, request: &str) -> String {
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8(bytes).unwrap()
    }

    fn get(path: &str, key: Option<&str>) -> String {
        let auth = key
            .map(|key| format!("Authorization: Bearer {key}\r\n"))
            .unwrap_or_default();
        format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n{auth}\r\n")
    }

    fn chat(model: &str, streaming: bool) -> String {
        let bytes = json!({"model":model,"stream":streaming,"messages":[{"role":"user","content":"Return 5"}]}).to_string();
        format!("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {APP_KEY}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{bytes}", bytes.len())
    }

    #[test]
    fn only_literal_loopback_endpoints_and_distinct_credentials_are_accepted() {
        let address = "127.0.0.1:19101".parse().unwrap();
        for base in [
            "https://127.0.0.1:19101/v1",
            "http://localhost:19101/v1",
            "http://192.0.2.1:19101/v1",
            "http://127.0.0.1:19101/other",
            "http://127.0.0.1:19101/v1?key=synthetic",
            "http://synthetic@127.0.0.1:19101/v1",
            "http://127.0.0.1:19101/v1#fragment",
        ] {
            let mut candidate = config(address, 19102);
            candidate.upstream_base = base.into();
            assert!(State::new(candidate).is_err(), "{base}");
        }
        assert!(State::new(config(address, 19101)).is_err());
        assert!(State::new(config(address, 0)).is_err());
        let mut candidate = config(address, 19102);
        candidate.upstream_api_key = Some(APP_KEY.into());
        assert!(State::new(candidate).is_err());
        let mut candidate = config(address, 19102);
        candidate.upstream_base = "http://[::1]:19101/v1/".into();
        assert!(State::new(candidate).is_ok());
    }

    #[tokio::test]
    async fn local_health_and_authenticated_model_listing_do_not_contact_the_upstream() {
        let upstream = upstream(Answer::Json).await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        assert!(exchange(proxy.address, &get("/health", None))
            .await
            .starts_with("HTTP/1.1 200 "));
        assert!(exchange(proxy.address, &get("/v1/models", None))
            .await
            .starts_with("HTTP/1.1 401 "));
        assert!(
            exchange(proxy.address, &get("/v1/models", Some("wrong-key")))
                .await
                .starts_with("HTTP/1.1 401 ")
        );
        let response = exchange(proxy.address, &get("/v1/models", Some(APP_KEY))).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
        assert!(response.contains(MODEL));
        assert!(upstream.recorded.lock().await.is_empty());
    }

    fn with_origin(request: &str, origin: &str) -> String {
        request.replacen(
            "Host: localhost\r\n",
            &format!("Host: localhost\r\nOrigin: {origin}\r\n"),
            1,
        )
    }

    fn options(origin: &str, method: &str, headers: &str) -> String {
        format!("OPTIONS /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nOrigin: {origin}\r\nAccess-Control-Request-Method: {method}\r\nAccess-Control-Request-Headers: {headers}\r\n\r\n")
    }

    #[tokio::test]
    async fn app_origins_can_preflight_without_a_key_but_still_authenticate_actual_requests() {
        let upstream = upstream(Answer::Json).await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:1420",
        ] {
            let response = exchange(
                proxy.address,
                &options(origin, "POST", "authorization, content-type"),
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 204 "));
            assert!(response.contains(&format!("Access-Control-Allow-Origin: {origin}\r\n")));
            assert!(
                response.contains("Access-Control-Allow-Headers: authorization, content-type\r\n")
            );
            assert!(!response.contains("Access-Control-Allow-Origin: *"));
            let denied = exchange(
                proxy.address,
                &with_origin(&get("/v1/models", None), origin),
            )
            .await;
            assert!(denied.starts_with("HTTP/1.1 401 "));
            assert!(denied.contains(&format!("Access-Control-Allow-Origin: {origin}\r\n")));
        }
        assert!(upstream.recorded.lock().await.is_empty());
    }

    #[tokio::test]
    async fn foreign_origins_and_unverified_preflight_methods_headers_and_bodies_are_rejected() {
        let upstream = upstream(Answer::Json).await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        for origin in [
            "null",
            "https://example.invalid",
            "http://tauri.localhost.evil.invalid",
            "http://localhost:1421",
        ] {
            for request in [
                options(origin, "POST", "authorization, content-type"),
                with_origin(&chat(MODEL, false), origin),
            ] {
                let response = exchange(proxy.address, &request).await;
                assert!(response.starts_with("HTTP/1.1 403 "));
                assert!(!response.contains("Access-Control-Allow-Origin:"));
            }
        }
        for request in [
            options("http://localhost:1420", "DELETE", "authorization"),
            options(
                "http://localhost:1420",
                "POST",
                "authorization, x-unverified",
            ),
            options("http://localhost:1420", "POST", "*"),
        ] {
            assert!(exchange(proxy.address, &request)
                .await
                .starts_with("HTTP/1.1 400 "));
        }
        let body = options("http://localhost:1420", "POST", "authorization").replacen(
            "\r\n\r\n",
            "\r\nContent-Length: 1\r\n\r\nx",
            1,
        );
        assert!(exchange(proxy.address, &body)
            .await
            .starts_with("HTTP/1.1 400 "));
        assert!(upstream.recorded.lock().await.is_empty());
    }

    #[tokio::test]
    async fn json_and_stream_responses_keep_app_cors_without_forwarding_origin_or_app_credentials()
    {
        for answer in [Answer::Json, Answer::Stream] {
            let streaming = matches!(answer, Answer::Stream);
            let upstream = upstream(answer).await;
            let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
            let request = with_origin(&chat(MODEL, streaming), "http://localhost:1420");
            let response = exchange(proxy.address, &request).await;
            assert!(response.starts_with("HTTP/1.1 200 "));
            assert!(response.contains(
                "Access-Control-Allow-Origin: http://localhost:1420\r\nVary: Origin\r\n"
            ));
            let recorded = upstream.recorded.lock().await;
            assert_eq!(recorded.len(), 1);
            assert!(!recorded[0].headers.contains_key("origin"));
            assert!(!recorded[0].headers.contains_key("authorization"));
        }
    }

    #[tokio::test]
    async fn explicit_headless_empty_key_preserves_local_unauthenticated_requests() {
        let upstream = upstream(Answer::Json).await;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let mut config = config(upstream.address, address.port());
        config.api_key.clear();
        let state = Arc::new(State::new(config).unwrap());
        let proxy = Proxy {
            address,
            task: tokio::spawn(serve(listener, state)),
        };
        let models = exchange(proxy.address, &get("/v1/models", None)).await;
        assert!(models.starts_with("HTTP/1.1 200 "));
        assert!(models.contains(MODEL));
        let request =
            chat(MODEL, false).replace(&format!("Authorization: Bearer {APP_KEY}\r\n"), "");
        let response = exchange(proxy.address, &request).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
        assert!(response.contains("\"content\":\"5\""));
        assert!(!upstream.recorded.lock().await[0]
            .headers
            .contains_key("authorization"));
    }

    #[tokio::test]
    async fn streams_chunks_without_forwarding_the_app_credential() {
        let upstream = upstream(Answer::Stream).await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        let response = exchange(proxy.address, &chat(MODEL, true)).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
        assert!(response.contains("Content-Type: text/event-stream"));
        assert!(response.contains("\"content\":\"5\""));
        assert!(response.contains("\"total_tokens\":5"));
        assert!(response.ends_with("data: [DONE]\n\n"));
        let recorded = upstream.recorded.lock().await;
        assert_eq!(recorded.len(), 1);
        assert!(!recorded[0].headers.contains_key("authorization"));
        assert_eq!(recorded[0].value["model"], MODEL);
        assert_eq!(recorded[0].value["stream"], true);
    }

    #[tokio::test]
    async fn a_separate_upstream_credential_is_the_only_credential_forwarded() {
        let upstream = upstream(Answer::Json).await;
        let proxy = proxy(
            &upstream,
            Duration::from_secs(2),
            Some("synthetic-upstream-key"),
        )
        .await;
        let response = exchange(proxy.address, &chat(MODEL, false)).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
        let recorded = upstream.recorded.lock().await;
        assert_eq!(
            recorded[0].headers.get("authorization").map(String::as_str),
            Some("Bearer synthetic-upstream-key")
        );
        assert!(!response.contains(APP_KEY));
        assert!(!response.contains("synthetic-upstream-key"));
    }

    #[tokio::test]
    async fn unselected_models_and_unverified_routes_are_refused_before_forwarding() {
        let upstream = upstream(Answer::Stream).await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        assert!(exchange(proxy.address, &chat("other-model", true))
            .await
            .starts_with("HTTP/1.1 400 "));
        for path in [
            "/v1/completions",
            "/v1/chat/completions?override=1",
            "/admin",
            "/v1/chat%2fcompletions",
        ] {
            let request = chat(MODEL, true).replacen("/v1/chat/completions", path, 1);
            assert!(exchange(proxy.address, &request)
                .await
                .starts_with("HTTP/1.1 404 "));
        }
        assert!(upstream.recorded.lock().await.is_empty());
    }

    #[tokio::test]
    async fn unauthorized_expect_continue_is_rejected_before_acknowledging_or_reading_a_body() {
        let upstream = upstream(Answer::Json).await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        let request = "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n";
        let response = exchange(proxy.address, request).await;
        assert!(response.starts_with("HTTP/1.1 401 "));
        assert!(!response.contains("100 Continue"));
        assert!(upstream.recorded.lock().await.is_empty());
    }

    #[tokio::test]
    async fn ambiguous_framing_and_oversized_bodies_are_rejected() {
        let upstream = upstream(Answer::Json).await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        for headers in [
            "Content-Length: 0\r\nContent-Length: 0\r\n",
            "Transfer-Encoding: chunked\r\nContent-Length: 0\r\n",
            "Content-Length: +0\r\n",
            "Authorization: Bearer duplicate\r\nContent-Length: 0\r\n",
        ] {
            let request = format!("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {APP_KEY}\r\nContent-Type: application/json\r\n{headers}\r\n");
            assert!(exchange(proxy.address, &request)
                .await
                .starts_with("HTTP/1.1 400 "));
        }
        let request = format!("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {APP_KEY}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", BODY_LIMIT + 1);
        assert!(exchange(proxy.address, &request)
            .await
            .starts_with("HTTP/1.1 413 "));
        assert!(upstream.recorded.lock().await.is_empty());
    }

    #[tokio::test]
    async fn redirects_are_not_followed_to_another_listener() {
        let destination = upstream(Answer::Stream).await;
        let upstream = upstream(Answer::Redirect(format!(
            "http://{}/v1/chat/completions",
            destination.address
        )))
        .await;
        let proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        let response = exchange(proxy.address, &chat(MODEL, true)).await;
        assert!(response.starts_with("HTTP/1.1 502 "));
        assert_eq!(upstream.recorded.lock().await.len(), 1);
        assert!(destination.recorded.lock().await.is_empty());
    }

    #[tokio::test]
    async fn stalled_streams_end_with_an_error_within_the_shared_request_deadline() {
        let upstream = upstream(Answer::StalledStream).await;
        let proxy = proxy(&upstream, Duration::from_millis(500), None).await;
        let response = exchange(proxy.address, &chat(MODEL, true)).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
        assert!(response.contains("\"content\":\"5\""));
        assert!(response.contains("aiolm_proxy_error"));
        assert!(!response.contains("[DONE]"));
        assert!(exchange(proxy.address, &get("/health", None))
            .await
            .starts_with("HTTP/1.1 200 "));
    }

    #[tokio::test]
    async fn stopping_the_proxy_leaves_the_external_server_listener_alive() {
        let upstream = upstream(Answer::StalledStream).await;
        let mut proxy = proxy(&upstream, Duration::from_secs(2), None).await;
        let mut client = TcpStream::connect(proxy.address).await.unwrap();
        client
            .write_all(chat(MODEL, true).as_bytes())
            .await
            .unwrap();
        let mut chunk = [0; 4096];
        let count = timeout(Duration::from_secs(2), client.read(&mut chunk))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&chunk[..count]).contains("HTTP/1.1 200"));
        proxy.task.abort();
        let _ = (&mut proxy.task).await;
        assert!(TcpStream::connect(proxy.address).await.is_err());
        let response = exchange(upstream.address, &get("/v1/models", None)).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
        assert!(response.contains(MODEL));
    }

    #[tokio::test]
    async fn cancelling_one_stalled_client_drops_its_upstream_and_keeps_followup_inference_working()
    {
        let upstream = upstream(Answer::FirstStreamStalls).await;
        let proxy = proxy(&upstream, Duration::from_secs(30), None).await;
        let mut client = TcpStream::connect(proxy.address).await.unwrap();
        client
            .write_all(chat(MODEL, true).as_bytes())
            .await
            .unwrap();
        let mut received = String::new();
        timeout(Duration::from_secs(2), async {
            while !received.contains("\"content\":\"5\"") {
                let mut chunk = [0; 4096];
                let count = client.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                received.push_str(std::str::from_utf8(&chunk[..count]).unwrap());
            }
        })
        .await
        .unwrap();
        drop(client);
        timeout(Duration::from_secs(2), upstream.closed.notified())
            .await
            .unwrap();
        let response = exchange(proxy.address, &chat(MODEL, true)).await;
        assert!(response.starts_with("HTTP/1.1 200 "));
        assert!(response.contains("\"content\":\"5\""));
        assert!(response.ends_with("data: [DONE]\n\n"));
        assert_eq!(upstream.recorded.lock().await.len(), 2);
        assert!(!proxy.task.is_finished());
    }
}
