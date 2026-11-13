//! Loopback API listener owned by the app, independent of any model process.
//!
//! One listener serves the OpenAI routes, the Anthropic `/v1/messages` route
//! and the Responses routes. It authenticates callers with an app-lifetime key
//! that is unrelated to the private key of any model process, and resolves the
//! model process for every request at request time (see `routing`), so models
//! can be loaded, unloaded or replaced while the listener keeps running.
#[cfg(test)]
mod api_tests;
mod http;
mod multipart;
mod routing;

pub use routing::ModelSource;

use crate::error::AppError;
use futures_util::StreamExt;
#[cfg(test)]
use http::read_request;
use http::{
    allowed_origin, discard_unread, read_body, read_head, with_cors_origin, write_api_error,
    write_event, write_json_response, write_preflight, write_stream_head, Api, ApiError, Head,
    Request,
};
use routing::{Lease, RouteError};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
#[cfg(test)]
use tokio::task::JoinHandle;
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::{Notify, Semaphore},
    task::JoinSet,
};

const MAX_UPSTREAM_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_STREAM_PENDING_BYTES: usize = 4 * 1024 * 1024;
/// A non-streaming generation sends nothing until it finishes, so this idle
/// bound has to outlast the longest request a model process accepts (its own
/// `--timeout` defaults to one hour).
const UPSTREAM_READ_TIMEOUT: Duration = Duration::from_secs(3600);

fn upstream_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| build_upstream_client(UPSTREAM_READ_TIMEOUT))
}

fn build_upstream_client(read_timeout: Duration) -> reqwest::Client {
    // This gateway targets the managed loopback server. Preserve connection pooling
    // and bound stalled reads without limiting the duration of an active stream.
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(read_timeout)
        .build()
        .expect("static gateway client configuration must be valid")
}

async fn bounded_upstream_bytes(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, AppError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(AppError::unavailable(format!(
            "OpenAI upstream response exceeds the {limit} byte limit"
        )));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            let message = format!("OpenAI upstream response read failed: {error}");
            if error.is_timeout() {
                AppError::timeout(message)
            } else {
                AppError::unavailable(message)
            }
        })?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(AppError::unavailable(format!(
                "OpenAI upstream response exceeds the {limit} byte limit"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn bounded_upstream_text(response: reqwest::Response) -> String {
    bounded_upstream_bytes(response, 2 * 1024 * 1024)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_else(|_| "upstream returned an oversized or unreadable error".into())
}

async fn bounded_upstream_json(response: reqwest::Response) -> Result<Value, String> {
    let bytes = bounded_upstream_bytes(response, MAX_UPSTREAM_JSON_BYTES).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid OpenAI upstream response: {error}"))
}

/// A running API listener. Stopping it closes the socket and every open
/// connection; it never touches a model process.
pub struct GatewayHandle {
    pub port: u16,
    shutdown: Arc<Notify>,
    task: crate::procutil::OwnedTask<()>,
}

impl GatewayHandle {
    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    /// Drop the listener and its connections without waiting, for the exit path.
    pub fn abort(&self) {
        self.task.abort();
    }
}

const MAX_RESPONSES: usize = 128;

/// Return one complete SSE line and advance a cursor without moving the
/// buffered suffix. The caller compacts the consumed prefix once per chunk.
fn take_sse_line<'a>(pending: &'a [u8], cursor: &mut usize) -> Option<&'a [u8]> {
    let relative = pending[*cursor..].iter().position(|byte| *byte == b'\n')?;
    let end = *cursor + relative;
    let line = pending[*cursor..end]
        .strip_suffix(b"\r")
        .unwrap_or(&pending[*cursor..end]);
    *cursor = end + 1;
    Some(line)
}

fn parse_sse_value(line: &[u8]) -> Option<Value> {
    let line = String::from_utf8_lossy(line);
    let data = line.trim().strip_prefix("data:")?.trim();
    serde_json::from_str(data).ok()
}

struct HistoryNode {
    parent: Option<Arc<HistoryNode>>,
    turn: Vec<Value>,
}

impl HistoryNode {
    fn append(
        parent: Option<Arc<HistoryNode>>,
        mut turn: Vec<Value>,
        assistant: Value,
    ) -> Arc<Self> {
        turn.push(assistant);
        Arc::new(Self { parent, turn })
    }

    fn flatten(&self) -> Vec<Value> {
        let mut nodes = Vec::new();
        let mut current = Some(self);
        let mut capacity = 0;
        while let Some(node) = current {
            capacity += node.turn.len();
            nodes.push(node);
            current = node.parent.as_deref();
        }
        let mut messages = Vec::with_capacity(capacity);
        for node in nodes.into_iter().rev() {
            messages.extend(node.turn.iter().cloned());
        }
        messages
    }
}

impl Drop for HistoryNode {
    fn drop(&mut self) {
        let mut parent = self.parent.take();
        // Detach unique ancestors before each node drops so a deep chain does
        // not recurse through Arc's field destructor. `into_inner` consumes a
        // non-unique Arc without a separate failed-unwrapping drop race.
        while let Some(node) = parent {
            match Arc::into_inner(node) {
                Some(mut owned) => parent = owned.parent.take(),
                None => break,
            }
        }
    }
}

#[derive(Clone)]
struct StoredResponse {
    response: Value,
    history: Arc<HistoryNode>,
}

struct Ctx {
    models: ModelSource,
    api_key: Arc<str>,
    responses: Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
}

/// Bind `127.0.0.1:port` (`0` picks a free port) and serve until stopped.
/// `api_key` is what clients must present; it is never logged.
pub async fn start(
    models: ModelSource,
    api_key: Arc<str>,
    port: u16,
) -> Result<GatewayHandle, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| {
            AppError::unavailable(format!(
                "cannot listen on 127.0.0.1:{port}: {error}. Choose another API port in Settings or close the program using it."
            ))
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| {
            AppError::unavailable(format!("cannot inspect the API listener address: {error}"))
        })?
        .port();
    let shutdown = Arc::new(Notify::new());
    let ctx = Arc::new(Ctx {
        models,
        api_key,
        responses: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    });
    let task = tokio::spawn(run(listener, ctx, Arc::clone(&shutdown)));
    Ok(GatewayHandle {
        port,
        shutdown,
        task: task.into(),
    })
}

pub async fn stop(handle: GatewayHandle) {
    handle.shutdown.notify_one();
    let _ = handle.task.await;
}

async fn run(listener: TcpListener, ctx: Arc<Ctx>, shutdown: Arc<Notify>) {
    let mut connections = JoinSet::new();
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
                        let ctx = Arc::clone(&ctx);
                        connections.spawn(async move {
                            let _permit = permit;
                            handle_connection(stream, ctx).await;
                        });
                    }
                }
                // Out of descriptors and the like: back off instead of spinning.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    drop(listener);
    // Aborting drops each connection's model lease, so nothing keeps counting
    // as an active request once the listener is gone.
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

enum Failure {
    /// Nothing has been written yet; the caller renders this to the client.
    Api(ApiError),
    /// The connection failed or a stream broke after its head was sent, so
    /// there is nobody left to tell.
    Connection,
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl From<String> for Failure {
    fn from(_: String) -> Self {
        Self::Connection
    }
}

type Handled = Result<(), Failure>;

async fn handle_connection(mut stream: TcpStream, ctx: Arc<Ctx>) {
    let _ = stream.set_nodelay(true);
    let head = match read_head(&mut stream).await {
        Ok(head) => head,
        Err(error) => {
            let _ = write_api_error(&mut stream, Api::OpenAi, &error).await;
            discard_unread(&mut stream).await;
            return;
        }
    };
    if !head
        .headers
        .get("host")
        .is_some_and(|host| is_loopback_host(host))
    {
        let error = ApiError::new(
            421,
            "misdirected_request",
            "Host must name a loopback address",
        );
        let _ = write_api_error(&mut stream, Api::OpenAi, &error).await;
        discard_unread(&mut stream).await;
        return;
    }
    if head.method == "OPTIONS" && head.headers.contains_key("access-control-request-method") {
        let _ = write_preflight(&mut stream, &head.headers).await;
        return;
    }
    let origin = allowed_origin(&head.headers);
    with_cors_origin(origin, serve(stream, ctx, head)).await;
}

async fn serve(mut stream: TcpStream, ctx: Arc<Ctx>, head: Head) {
    let api = if head.path == "/v1/messages" {
        Api::Anthropic
    } else {
        Api::OpenAi
    };
    // Authenticate before reading the body, so a caller without the key cannot
    // make the app buffer what it sends.
    if !authorized(&head.headers, &ctx.api_key) {
        let error = ApiError::new(
            401,
            "invalid_api_key",
            "missing or invalid API key; send it as `Authorization: Bearer <key>` or `x-api-key`",
        );
        let _ = write_api_error(&mut stream, api, &error).await;
        discard_unread(&mut stream).await;
        return;
    }
    let request = match read_body(&mut stream, head).await {
        Ok(request) => request,
        Err(error) => {
            let _ = write_api_error(&mut stream, api, &error).await;
            return;
        }
    };
    if let Err(Failure::Api(error)) = route(&mut stream, &ctx, request).await {
        let _ = write_api_error(&mut stream, api, &error).await;
    }
}

fn is_loopback_host(value: &str) -> bool {
    let allowed = |host: &str| {
        host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost") || host == "[::1]"
    };
    allowed(value)
        || value.rsplit_once(':').is_some_and(|(host, port)| {
            allowed(host)
                && !port.is_empty()
                && port.bytes().all(|byte| byte.is_ascii_digit())
                && port.parse::<u16>().is_ok()
        })
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let mut difference = left.len() ^ right.len();
    for (index, byte) in right.bytes().enumerate() {
        difference |= usize::from(byte ^ left.as_bytes().get(index).copied().unwrap_or(0));
    }
    difference == 0
}

/// The app-lifetime key, presented as a Bearer token (OpenAI style) or as
/// `x-api-key` (Anthropic style).
fn authorized(headers: &HashMap<String, String>, key: &str) -> bool {
    let bearer = headers.get("authorization").and_then(|value| {
        let (scheme, token) = value.split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
    });
    [bearer, headers.get("x-api-key").map(String::as_str)]
        .into_iter()
        .flatten()
        .any(|presented| constant_time_eq(presented, key))
}

/// Resolves once the client has closed its side of the connection. The request
/// has been read in full and every response ends the connection, so nothing
/// more is expected from the client; stray bytes are ignored.
async fn client_left(client: &TcpStream) {
    let mut probe = [0_u8; 1];
    loop {
        match client.peek(&mut probe).await {
            Ok(0) | Err(_) => return,
            Ok(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

/// Wait for `work` unless the client goes away first. Abandoning the wait
/// drops the upstream request, and the caller's lease ends with the handler, so
/// a cancelled request never keeps its model pinned - not while the model is
/// still processing the prompt, and not between streamed chunks.
async fn unless_client_leaves<F: std::future::Future>(
    client: &TcpStream,
    work: F,
) -> Result<F::Output, String> {
    tokio::select! {
        output = work => Ok(output),
        _ = client_left(client) => Err("the client disconnected before the response finished".into()),
    }
}

async fn route(stream: &mut TcpStream, ctx: &Ctx, request: Request) -> Handled {
    let method = request.method.clone();
    let path = request.path.clone();
    match (method.as_str(), path.as_str()) {
        ("GET", "/v1/models") => list_models(stream, ctx).await,
        ("POST", "/v1/chat/completions") => {
            proxy_openai(stream, ctx, request, "chat/completions").await
        }
        ("POST", "/v1/completions") => proxy_openai(stream, ctx, request, "completions").await,
        ("POST", "/v1/embeddings") => proxy_openai(stream, ctx, request, "embeddings").await,
        ("POST", "/v1/audio/transcriptions") => {
            proxy_audio(stream, ctx, request, "audio/transcriptions").await
        }
        ("POST", "/v1/audio/translations") => {
            proxy_audio(stream, ctx, request, "audio/translations").await
        }
        ("POST", "/v1/messages") => handle_messages(stream, ctx, request).await,
        (_, "/v1/responses") => handle_responses(stream, ctx, request).await,
        (_, path) if path.starts_with("/v1/responses/") => {
            handle_responses(stream, ctx, request).await
        }
        (
            _,
            "/v1/models"
            | "/v1/chat/completions"
            | "/v1/completions"
            | "/v1/embeddings"
            | "/v1/audio/transcriptions"
            | "/v1/audio/translations"
            | "/v1/messages",
        ) => Err(ApiError::new(
            405,
            "method_not_allowed",
            format!("{path} does not support {method}"),
        )
        .into()),
        _ => Err(ApiError::new(404, "not_found", format!("unknown route {method} {path}")).into()),
    }
}

fn requested_model(body: &Value) -> Result<Option<&str>, ApiError> {
    let Some(object) = body.as_object() else {
        return Err(ApiError::new(
            400,
            "invalid_request",
            "request body must be a JSON object",
        ));
    };
    match object.get("model") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) => Ok(Some(name)),
        Some(_) => Err(
            ApiError::new(400, "invalid_request", "`model` must be a string").with_param("model"),
        ),
    }
}

fn upstream_post(lease: &Lease, endpoint: &str) -> reqwest::RequestBuilder {
    upstream_client()
        .post(format!(
            "{}/{endpoint}",
            lease.upstream().trim_end_matches('/')
        ))
        .header("Authorization", format!("Bearer {}", lease.upstream_key()))
}

/// Report a model process that could not be reached without naming its
/// private loopback port.
fn upstream_failure(error: reqwest::Error) -> ApiError {
    let error = error.without_url();
    if error.is_timeout() {
        ApiError::new(
            504,
            "upstream_timeout",
            "the model process did not answer in time",
        )
    } else {
        ApiError::new(
            502,
            "upstream_unavailable",
            format!("the model process could not be reached: {error}"),
        )
    }
}

async fn list_models(stream: &mut TcpStream, ctx: &Ctx) -> Handled {
    let created = chrono_like_timestamp();
    let data: Vec<Value> = ctx
        .models
        .snapshot()
        .ready
        .iter()
        .map(|candidate| {
            json!({"id":candidate.advertised,"object":"model","created":created,"owned_by":"aiolm"})
        })
        .collect();
    write_json_response(stream, 200, json!({"object":"list","data":data})).await?;
    Ok(())
}

/// Relay an OpenAI request untouched to the model it names and relay the
/// answer back as it arrives: status, body and SSE chunks all pass through,
/// including the model process's own error responses.
async fn proxy_openai(
    stream: &mut TcpStream,
    ctx: &Ctx,
    request: Request,
    endpoint: &str,
) -> Handled {
    let mut parsed: Value = serde_json::from_slice(&request.body).map_err(|error| {
        ApiError::new(
            400,
            "invalid_json",
            format!("request body is not valid JSON: {error}"),
        )
    })?;
    // The lease counts this request as active on its model until the handler
    // returns, however the answer ends, so the model cannot be unloaded or
    // replaced underneath a response that is still being delivered.
    let lease = ctx
        .models
        .acquire(requested_model(&parsed)?)
        .map_err(RouteError::into_api_error)?;
    let response = unless_client_leaves(
        stream,
        upstream_post(&lease, endpoint)
            .header("Content-Type", "application/json")
            .json({
                lease.adapt(endpoint, &mut parsed)?;
                &parsed
            })
            .send(),
    )
    .await?
    .map_err(upstream_failure)?;
    relay_openai_response(stream, response).await
}

async fn proxy_audio(
    stream: &mut TcpStream,
    ctx: &Ctx,
    request: Request,
    endpoint: &str,
) -> Handled {
    let content_type = request
        .headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or_default();
    let mut form = multipart::AudioForm::parse(content_type, &request.body)
        .map_err(|error| ApiError::new(400, "invalid_audio_form", error))?;
    let mut fields = Value::Object(std::mem::take(&mut form.fields));
    let lease = ctx
        .models
        .acquire(requested_model(&fields)?)
        .map_err(RouteError::into_api_error)?;
    lease.adapt(endpoint, &mut fields)?;
    let fields = match fields {
        Value::Object(fields) => fields,
        _ => {
            return Err(ApiError::new(
                400,
                "invalid_audio_form",
                "audio fields must remain an object",
            )
            .into())
        }
    };
    form.fields = fields;
    let body = form
        .encode()
        .map_err(|error| ApiError::new(400, "invalid_audio_form", error))?;
    let response = unless_client_leaves(
        stream,
        upstream_post(&lease, endpoint)
            .header("Content-Type", form.content_type())
            .body(body)
            .send(),
    )
    .await?
    .map_err(upstream_failure)?;
    relay_openai_response(stream, response).await
}

async fn relay_openai_response(stream: &mut TcpStream, response: reqwest::Response) -> Handled {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    write_stream_head(stream, status, &content_type, response.content_length()).await?;
    let mut body = response.bytes_stream();
    while let Some(chunk) = unless_client_leaves(stream, body.next()).await? {
        let chunk = chunk
            .map_err(|error| format!("upstream response read failed: {}", error.without_url()))?;
        stream
            .write_all(&chunk)
            .await
            .map_err(|error| format!("gateway response write failed: {error}"))?;
    }
    stream
        .shutdown()
        .await
        .map_err(|error| format!("gateway shutdown failed: {error}"))?;
    Ok(())
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Transcription {
    pub text: String,
    pub session_id: String,
    pub model: String,
}

/// Local attachment transcription uses the same selected-session lease and
/// protocol adapter as the public API, with no caller-controlled URL or key.
pub(crate) async fn transcribe_audio(
    models: ModelSource,
    session_id: String,
    audio: crate::media::OwnedAudio,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Transcription, AppError> {
    let lease = models
        .acquire_session(&session_id)
        .map_err(|error| match error.code {
            "transcription_session_unavailable" => AppError::not_found(error.message),
            "model_changed" => AppError::busy(error.message),
            _ => AppError::internal(error.message),
        })?;
    let mut form = multipart::AudioForm::from_audio(audio);
    let mut fields = json!({"response_format":"json"});
    lease
        .adapt("audio/transcriptions", &mut fields)
        .map_err(|error| AppError::validation(error.message))?;
    let fields = match fields {
        Value::Object(fields) => fields,
        _ => {
            return Err(AppError::validation(
                "transcription fields must be an object",
            ))
        }
    };
    let model = fields
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    form.fields = fields;
    let body = form.encode()?;
    let work = async {
        let response = upstream_post(&lease, "audio/transcriptions")
            .header("Content-Type", form.content_type())
            .body(body)
            .send()
            .await
            .map_err(|error| {
                let timed_out = error.is_timeout();
                let message = upstream_failure(error).message;
                if timed_out {
                    AppError::timeout(message)
                } else {
                    AppError::unavailable(message)
                }
            })?;
        if !response.status().is_success() {
            return Err(AppError::unavailable(format!(
                "transcription failed (HTTP {}): {}",
                response.status().as_u16(),
                bounded_upstream_text(response).await
            )));
        }
        let bytes = bounded_upstream_bytes(response, 1024 * 1024).await?;
        let response: Value = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::unavailable(format!("invalid transcription response: {error}"))
        })?;
        let text = response
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty() && text.len() <= 64 * 1024)
            .ok_or_else(|| AppError::unavailable("transcription returned empty or oversized text"))?
            .to_owned();
        Ok(Transcription {
            text,
            session_id,
            model,
        })
    };
    let cancelled = async {
        loop {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    if cancel.load(std::sync::atomic::Ordering::Acquire) {
        return Err(AppError::cancelled("media preparation cancelled"));
    }
    tokio::select! {
        result = work => result,
        _ = cancelled => Err(AppError::cancelled("media preparation cancelled")),
        _ = tokio::time::sleep(Duration::from_secs(600)) => Err(AppError::timeout("transcription did not finish within ten minutes")),
    }
}

async fn handle_messages(stream: &mut TcpStream, ctx: &Ctx, request: Request) -> Handled {
    if !request.headers.contains_key("anthropic-version") {
        return Err(ApiError::new(
            400,
            "invalid_request",
            "anthropic-version header is required",
        )
        .into());
    }
    let body: Value = serde_json::from_slice(&request.body).map_err(|error| {
        ApiError::new(
            400,
            "invalid_request",
            format!("invalid Anthropic JSON: {error}"),
        )
    })?;
    let stream_requested = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let openai_request = anthropic_to_openai(&body)
        .map_err(|message| ApiError::new(400, "invalid_request", message))?;
    // The lease counts this request as active on its model until the handler
    // returns, however the answer ends, so the model cannot be unloaded or
    // replaced underneath a response that is still being delivered.
    let lease = ctx
        .models
        .acquire(requested_model(&body)?)
        .map_err(RouteError::into_api_error)?;
    let mut openai_request = openai_request;
    lease.adapt("chat/completions", &mut openai_request)?;
    let mut request_builder = upstream_post(&lease, "chat/completions").json(&openai_request);
    if stream_requested {
        request_builder = request_builder.header("Accept", "text/event-stream");
    }
    let response = unless_client_leaves(stream, request_builder.send())
        .await?
        .map_err(upstream_failure)?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = bounded_upstream_text(response).await;
        write_json_response(stream, status, json!({"type":"error","error":{"type":"api_error","message":text.chars().take(2000).collect::<String>()}})).await?;
        return Ok(());
    }
    if stream_requested {
        stream_response(stream, response, &body).await?;
    } else {
        let value = unless_client_leaves(stream, bounded_upstream_json(response))
            .await?
            .map_err(|message| ApiError::new(502, "bad_upstream_response", message))?;
        write_json_response(stream, 200, openai_to_anthropic(&value)).await?;
    }
    Ok(())
}

async fn handle_responses(stream: &mut TcpStream, ctx: &Ctx, request: Request) -> Handled {
    let responses = &ctx.responses;
    let method = request.method.as_str();
    let path = request.path.as_str();
    if let Some(id) = path.strip_prefix("/v1/responses/") {
        if let Some(cancel_id) = id.strip_suffix("/cancel") {
            if cancel_id.is_empty() || cancel_id.contains('/') || method != "POST" {
                write_json_response(stream, 405, json!({"error":{"type":"method_not_allowed","message":"use POST /v1/responses/{id}/cancel"}})).await?;
            } else {
                let removed = responses.lock().await.remove(cancel_id).is_some();
                write_json_response(stream, if removed { 200 } else { 404 }, json!({"id":cancel_id,"object":"response","status":if removed { "cancelled" } else { "not_found" }})).await?;
            }
            return Ok(());
        }
        if id.is_empty() || id.contains('/') {
            write_json_response(
                stream,
                404,
                json!({"error":{"type":"not_found","message":"response id is invalid"}}),
            )
            .await?;
            return Ok(());
        }
        match method {
            "GET" => {
                let stored = responses.lock().await.get(id).cloned();
                if let Some(stored) = stored {
                    write_json_response(stream, 200, stored.response).await?;
                } else {
                    write_json_response(stream, 404, json!({"error":{"type":"not_found","message":"response was not found"}})).await?;
                }
            }
            "DELETE" => {
                let removed = responses.lock().await.remove(id).is_some();
                write_json_response(stream, if removed { 200 } else { 404 }, json!({"id":id,"object":"response","deleted":removed})).await?;
            }
            _ => write_json_response(stream, 405, json!({"error":{"type":"method_not_allowed","message":"use GET or DELETE for a response id"}})).await?,
        }
        return Ok(());
    }

    if method != "POST" || path != "/v1/responses" {
        write_json_response(stream, 404, json!({"error":{"type":"not_found","message":"supported response route is POST /v1/responses"}})).await?;
        return Ok(());
    }
    let body: Value = serde_json::from_slice(&request.body).map_err(|error| {
        ApiError::new(
            400,
            "invalid_request",
            format!("invalid Responses JSON: {error}"),
        )
    })?;
    let response_id = format!("resp_{}", uuid::Uuid::new_v4().simple());
    let previous_id = body.get("previous_response_id").and_then(Value::as_str);
    let parent_history = if let Some(previous_id) = previous_id {
        let history = responses
            .lock()
            .await
            .get(previous_id)
            .map(|stored| Arc::clone(&stored.history));
        let Some(history) = history else {
            write_json_response(stream, 404, json!({"error":{"type":"not_found","message":format!("previous_response_id {previous_id} was not found")}})).await?;
            return Ok(());
        };
        Some(history)
    } else {
        None
    };
    let turn_messages = responses_input_to_openai(&body)
        .map_err(|message| ApiError::new(400, "invalid_request", message))?;
    let mut request_messages = parent_history
        .as_deref()
        .map(HistoryNode::flatten)
        .unwrap_or_default();
    request_messages.extend(turn_messages.iter().cloned());
    let openai_request = responses_to_openai(&body, request_messages)
        .map_err(|message| ApiError::new(400, "invalid_request", message))?;
    let stream_requested = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    // The lease counts this request as active on its model until the handler
    // returns, however the answer ends, so the model cannot be unloaded or
    // replaced underneath a response that is still being delivered.
    let lease = ctx
        .models
        .acquire(requested_model(&body)?)
        .map_err(RouteError::into_api_error)?;
    let mut openai_request = openai_request;
    lease.adapt("chat/completions", &mut openai_request)?;
    let mut request_builder = upstream_post(&lease, "chat/completions").json(&openai_request);
    if stream_requested {
        request_builder = request_builder.header("Accept", "text/event-stream");
    }
    let response = unless_client_leaves(stream, request_builder.send())
        .await?
        .map_err(upstream_failure)?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = bounded_upstream_text(response).await;
        write_json_response(stream, status, json!({"error":{"type":"api_error","message":text.chars().take(2000).collect::<String>()}})).await?;
        return Ok(());
    }
    if stream_requested {
        stream_responses(
            stream,
            response,
            &body,
            response_id,
            parent_history,
            turn_messages,
            Arc::clone(responses),
        )
        .await?;
    } else {
        let value = unless_client_leaves(stream, bounded_upstream_json(response))
            .await?
            .map_err(|message| ApiError::new(502, "bad_upstream_response", message))?;
        let assistant = openai_assistant_message(&value);
        let response_value = openai_to_responses(&value, &body, &response_id);
        let history = HistoryNode::append(parent_history, turn_messages, assistant);
        remember_response(responses, response_id, response_value.clone(), history).await;
        write_json_response(stream, 200, response_value).await?;
    }
    Ok(())
}

fn responses_input_to_openai(request: &Value) -> Result<Vec<Value>, String> {
    let mut messages = Vec::new();
    if let Some(instructions) = request.get("instructions") {
        if !instructions.is_null() {
            messages
                .push(json!({"role":"system","content":response_content_to_openai(instructions)?}));
        }
    }
    let Some(input) = request.get("input") else {
        return Err("input is required for a Responses request".into());
    };
    if let Some(text) = input.as_str() {
        messages.push(json!({"role":"user","content":text}));
        return Ok(messages);
    }
    let items = input
        .as_array()
        .ok_or_else(|| "input must be a string or array".to_string())?;
    let mut pending_reasoning = String::new();
    for item in items {
        if let Some(text) = item.as_str() {
            pending_reasoning.clear();
            messages.push(json!({"role":"user","content":text}));
            continue;
        }
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                    for text in summary
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .filter(|text| !text.is_empty())
                    {
                        if !pending_reasoning.is_empty() {
                            pending_reasoning.push('\n');
                        }
                        pending_reasoning.push_str(text);
                    }
                }
                continue;
            }
            Some("function_call") => {
                let call = json!({
                    "id":item.get("call_id"),
                    "type":"function",
                    "function":{"name":item.get("name"),"arguments":item.get("arguments")}
                });
                if messages
                    .last()
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    != Some("assistant")
                {
                    messages.push(json!({"role":"assistant","content":null,"tool_calls":[]}));
                }
                let assistant = messages.last_mut().unwrap().as_object_mut().unwrap();
                if !pending_reasoning.is_empty() {
                    assistant.insert(
                        "reasoning_content".into(),
                        Value::String(std::mem::take(&mut pending_reasoning)),
                    );
                }
                assistant
                    .entry("tool_calls")
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap()
                    .push(call);
                continue;
            }
            Some("function_call_output") => {
                pending_reasoning.clear();
                let empty = Value::String(String::new());
                messages.push(json!({
                    "role":"tool","tool_call_id":item.get("call_id"),
                    "content":response_content_to_openai(item.get("output").unwrap_or(&empty))?
                }));
                continue;
            }
            _ => {}
        }
        let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
        let empty_content = Value::String(String::new());
        let content = item
            .get("content")
            .or_else(|| item.get("output"))
            .unwrap_or(&empty_content);
        let mut message = json!({"role":role,"content":response_content_to_openai(content)?});
        if role == "assistant" && !pending_reasoning.is_empty() {
            message["reasoning_content"] = Value::String(std::mem::take(&mut pending_reasoning));
        } else {
            pending_reasoning.clear();
        }
        messages.push(message);
    }
    Ok(messages)
}

fn response_content_to_openai(value: &Value) -> Result<Value, String> {
    if value.is_string() {
        return Ok(value.clone());
    }
    let Some(blocks) = value.as_array() else {
        return Ok(value.clone());
    };
    let mut output = Vec::new();
    for block in blocks {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("input_text");
        match kind {
            "input_text" | "output_text" | "text" => output.push(json!({"type":"text","text":block.get("text").cloned().unwrap_or(Value::String(String::new()))})),
            "input_image" | "image" => {
                let image = block.get("image_url").or_else(|| block.get("url")).cloned().unwrap_or(Value::Null);
                let url = image.as_str().map(str::to_owned).or_else(|| block.get("image_url").and_then(|value| value.get("url")).and_then(Value::as_str).map(str::to_owned));
                let url = url.ok_or_else(|| "Responses image input requires an image URL or data URI".to_string())?;
                output.push(json!({"type":"image_url","image_url":{"url":url}}));
            }
            _ => return Err(format!("Responses input type {kind} cannot be represented by this adapter; use /v1/chat/completions for supported audio and video input")),
        }
    }
    Ok(
        if output.len() == 1 && output[0].get("type").and_then(Value::as_str) == Some("text") {
            output
                .remove(0)
                .get("text")
                .cloned()
                .unwrap_or(Value::String(String::new()))
        } else {
            Value::Array(output)
        },
    )
}

fn responses_to_openai(request: &Value, messages: Vec<Value>) -> Result<Value, String> {
    let mut body = Map::new();
    body.insert(
        "model".into(),
        request
            .get("model")
            .cloned()
            .unwrap_or(Value::String("local-model".into())),
    );
    body.insert("messages".into(), Value::Array(messages));
    body.insert(
        "stream".into(),
        request.get("stream").cloned().unwrap_or(Value::Bool(false)),
    );
    if request.get("stream").and_then(Value::as_bool) == Some(true) {
        body.insert("stream_options".into(), json!({"include_usage": true}));
    }
    for (source, target) in [
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("max_output_tokens", "max_tokens"),
        ("stop", "stop"),
        ("response_format", "response_format"),
    ] {
        if let Some(value) = request.get(source) {
            body.insert(target.into(), value.clone());
        }
    }
    if let Some(tools) = request.get("tools") {
        let tools = tools
            .as_array()
            .ok_or_else(|| "tools must be an array".to_string())?;
        let mut converted = Vec::with_capacity(tools.len());
        for tool in tools {
            let kind = tool.get("type").and_then(Value::as_str).unwrap_or("");
            if kind != "function" {
                return Err(format!(
                    "Responses tool type {kind} cannot be represented by this adapter"
                ));
            }
            let mut function = Map::new();
            for field in ["name", "description", "parameters", "strict"] {
                if let Some(value) = tool.get(field) {
                    function.insert(field.into(), value.clone());
                }
            }
            converted.push(json!({"type":"function","function":function}));
        }
        body.insert("tools".into(), Value::Array(converted));
    }
    if let Some(choice) = request.get("tool_choice") {
        let converted = if choice.is_string() {
            choice.clone()
        } else {
            let kind = choice.get("type").and_then(Value::as_str).unwrap_or("");
            if kind != "function" {
                return Err(format!(
                    "Responses tool choice type {kind} cannot be represented by this adapter"
                ));
            }
            json!({"type":"function","function":{"name":choice.get("name")}})
        };
        body.insert("tool_choice".into(), converted);
    }
    if let Some(reasoning) = request.get("reasoning") {
        body.insert(
            "reasoning_effort".into(),
            reasoning
                .get("effort")
                .cloned()
                .unwrap_or(Value::String("default".into())),
        );
    }
    Ok(Value::Object(body))
}

fn openai_assistant_message(value: &Value) -> Value {
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({"role":"assistant","content":""}))
}

fn response_usage(value: &Value) -> Value {
    let usage = value.get("usage").cloned().unwrap_or_else(|| json!({}));
    json!({
        "input_tokens": usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens": usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        "total_tokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0)
    })
}

fn openai_to_responses(value: &Value, request: &Value, response_id: &str) -> Value {
    let message = openai_assistant_message(value);
    let text = message.get("content").and_then(Value::as_str).unwrap_or("");
    let reasoning = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut output = Vec::new();
    if !reasoning.is_empty() {
        output.push(reasoning_item(reasoning, "completed"));
    }
    let calls = message.get("tool_calls").and_then(Value::as_array);
    if !text.is_empty() || calls.is_none_or(Vec::is_empty) {
        output.push(message_item(text, "completed"));
    }
    if let Some(calls) = calls {
        for call in calls {
            output.push(function_call_item(call, "completed"));
        }
    }
    response_value(
        response_id,
        request
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("local-model"),
        text,
        output,
        response_usage(value),
        "completed",
    )
}

fn reasoning_item(text: &str, status: &str) -> Value {
    json!({"id":format!("rs_{}", uuid::Uuid::new_v4().simple()),"type":"reasoning","status":status,"summary":[{"type":"summary_text","text":text}]})
}

fn message_item(text: &str, status: &str) -> Value {
    json!({"id":format!("msg_{}", uuid::Uuid::new_v4().simple()),"type":"message","status":status,"role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn function_call_item(call: &Value, status: &str) -> Value {
    json!({
        "id":format!("fc_{}", uuid::Uuid::new_v4().simple()),
        "type":"function_call","call_id":call.get("id"),
        "name":call.get("function").and_then(|function| function.get("name")),
        "arguments":call.get("function").and_then(|function| function.get("arguments")).and_then(Value::as_str).unwrap_or(""),
        "status":status
    })
}

fn response_value(
    id: &str,
    model: &str,
    text: &str,
    output: Vec<Value>,
    usage: Value,
    status: &str,
) -> Value {
    json!({"id":id,"object":"response","created_at":chrono_like_timestamp(),"status":status,"model":model,"output":output,"output_text":text,"usage":usage})
}

fn chrono_like_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

async fn remember_response(
    responses: &Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
    id: String,
    response: Value,
    history: Arc<HistoryNode>,
) {
    let mut guard = responses.lock().await;
    guard.insert(id, StoredResponse { response, history });
    while guard.len() > MAX_RESPONSES {
        if let Some(key) = guard.keys().next().cloned() {
            guard.remove(&key);
        } else {
            break;
        }
    }
}

async fn stream_responses(
    stream: &mut TcpStream,
    response: reqwest::Response,
    request: &Value,
    response_id: String,
    parent_history: Option<Arc<HistoryNode>>,
    turn_messages: Vec<Value>,
    responses: Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
) -> Result<(), String> {
    write_stream_head(stream, 200, "text/event-stream", None).await?;
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("local-model");
    let created = response_value(
        &response_id,
        model,
        "",
        Vec::new(),
        json!({}),
        "in_progress",
    );
    write_event(
        stream,
        "response.created",
        json!({"type":"response.created","response":created,"sequence_number":0}),
    )
    .await?;
    let mut state = ResponseStreamState::default();
    let mut pending = Vec::new();
    let mut pending_cursor = 0;
    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = unless_client_leaves(stream, body_stream.next()).await? {
        let chunk =
            chunk.map_err(|error| format!("Responses upstream SSE read failed: {error}"))?;
        pending.extend_from_slice(&chunk);
        if pending.len() > MAX_STREAM_PENDING_BYTES {
            return Err("upstream SSE line exceeded the 4 MiB limit".into());
        }
        while let Some(line) = take_sse_line(&pending, &mut pending_cursor) {
            if let Some(value) = parse_sse_value(line) {
                write_events(stream, state.apply(&value)).await?;
            }
        }
        if pending_cursor > 0 {
            pending.drain(..pending_cursor);
            pending_cursor = 0;
        }
    }
    if let Some(value) = parse_sse_value(&pending) {
        write_events(stream, state.apply(&value)).await?;
    }
    write_events(stream, state.finish()).await?;
    let assistant = state.assistant_message();
    let completed = response_value(
        &response_id,
        model,
        &state.text,
        std::mem::take(&mut state.output),
        state.usage.take().unwrap_or_else(|| json!({})),
        "completed",
    );
    let history = HistoryNode::append(parent_history, turn_messages, assistant);
    remember_response(&responses, response_id, completed.clone(), history).await;
    let event = state.event(json!({"type":"response.completed","response":completed}));
    write_events(stream, vec![event]).await?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("Responses SSE shutdown failed: {error}"))
}

async fn write_events(stream: &mut TcpStream, events: Vec<Value>) -> Result<(), String> {
    for event in events {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("error")
            .to_owned();
        write_event(stream, &kind, event).await?;
    }
    Ok(())
}

#[derive(Default)]
struct ResponseStreamState {
    text: String,
    reasoning: String,
    usage: Option<Value>,
    output: Vec<Value>,
    text_index: Option<usize>,
    reasoning_index: Option<usize>,
    tool_indices: Vec<(u64, usize)>,
    sequence_number: u64,
}

impl ResponseStreamState {
    fn event(&mut self, mut event: Value) -> Value {
        self.sequence_number += 1;
        event["sequence_number"] = json!(self.sequence_number);
        event
    }

    fn add_item(&mut self, item: Value, events: &mut Vec<Value>) -> usize {
        let index = self.output.len();
        events.push(
            self.event(
                json!({"type":"response.output_item.added","output_index":index,"item":item}),
            ),
        );
        self.output.push(item);
        index
    }

    fn apply(&mut self, value: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        if value.get("usage").is_some_and(Value::is_object) {
            self.usage = Some(response_usage(value));
        }
        let Some(delta) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|choice| choice.get("delta"))
        else {
            return events;
        };
        if let Some(text) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = match self.reasoning_index {
                Some(index) => index,
                None => {
                    let index = self.add_item(reasoning_item("", "in_progress"), &mut events);
                    self.reasoning_index = Some(index);
                    index
                }
            };
            self.reasoning.push_str(text);
            if let Value::String(summary) = &mut self.output[index]["summary"][0]["text"] {
                summary.push_str(text);
            }
            events.push(self.event(json!({"type":"response.reasoning_summary_text.delta",
                "item_id":self.output[index]["id"],"output_index":index,"summary_index":0,"delta":text})));
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = match self.text_index {
                Some(index) => index,
                None => {
                    let index = self.add_item(message_item("", "in_progress"), &mut events);
                    self.text_index = Some(index);
                    index
                }
            };
            self.text.push_str(text);
            if let Value::String(content) = &mut self.output[index]["content"][0]["text"] {
                content.push_str(text);
            }
            events.push(self.event(json!({"type":"response.output_text.delta",
                "item_id":self.output[index]["id"],"output_index":index,"content_index":0,"delta":text})));
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let upstream_index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let index = if let Some((_, index)) = self
                    .tool_indices
                    .iter()
                    .find(|(key, _)| *key == upstream_index)
                {
                    *index
                } else {
                    let initial = json!({"id":tool_call_id(call),"function":{
                        "name":call.get("function").and_then(|function| function.get("name")),
                        "arguments":""
                    }});
                    let index =
                        self.add_item(function_call_item(&initial, "in_progress"), &mut events);
                    self.tool_indices.push((upstream_index, index));
                    index
                };
                if let Some(id) = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    self.output[index]["call_id"] = json!(id);
                }
                if let Some(name) = call
                    .get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                {
                    self.output[index]["name"] = json!(name);
                }
                if let Some(arguments) = call
                    .get("function")
                    .and_then(|function| function.get("arguments"))
                    .and_then(Value::as_str)
                    .filter(|arguments| !arguments.is_empty())
                {
                    if let Value::String(full) = &mut self.output[index]["arguments"] {
                        full.push_str(arguments);
                    }
                    events.push(self.event(json!({"type":"response.function_call_arguments.delta",
                        "item_id":self.output[index]["id"],"output_index":index,"delta":arguments})));
                }
            }
        }
        events
    }

    fn finish(&mut self) -> Vec<Value> {
        let mut events = Vec::new();
        if self.text_index.is_none() && self.tool_indices.is_empty() {
            let index = self.add_item(message_item("", "in_progress"), &mut events);
            self.text_index = Some(index);
        }
        for index in 0..self.output.len() {
            self.output[index]["status"] = json!("completed");
            if self.output[index]["type"] == "function_call" {
                events.push(self.event(json!({"type":"response.function_call_arguments.done",
                    "item_id":self.output[index]["id"],"output_index":index,
                    "name":self.output[index]["name"],"arguments":self.output[index]["arguments"]})));
            }
            events.push(self.event(json!({"type":"response.output_item.done","output_index":index,"item":self.output[index]})));
        }
        events
    }

    fn assistant_message(&self) -> Value {
        let mut assistant =
            json!({"role":"assistant","content":self.text,"reasoning_content":self.reasoning});
        let calls: Vec<Value> = self
            .output
            .iter()
            .filter(|item| item["type"] == "function_call")
            .map(|item| {
                json!({"id":item["call_id"],"type":"function",
                "function":{"name":item["name"],"arguments":item["arguments"]}})
            })
            .collect();
        if !calls.is_empty() {
            assistant["tool_calls"] = Value::Array(calls);
        }
        assistant
    }
}

async fn stream_response(
    stream: &mut TcpStream,
    response: reqwest::Response,
    request: &Value,
) -> Result<(), String> {
    write_stream_head(stream, 200, "text/event-stream", None).await?;
    let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    write_event(stream, "message_start", json!({"type":"message_start","message":{"id":message_id,"type":"message","role":"assistant","model":request.get("model").and_then(Value::as_str).unwrap_or("local-model"),"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}})).await?;
    let mut parser = OpenAiStream::default();
    let mut pending = Vec::new();
    let mut pending_cursor = 0;
    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = unless_client_leaves(stream, body_stream.next()).await? {
        let chunk = chunk.map_err(|error| format!("upstream SSE read failed: {error}"))?;
        pending.extend_from_slice(&chunk);
        if pending.len() > MAX_STREAM_PENDING_BYTES {
            return Err("upstream SSE line exceeded the 4 MiB limit".into());
        }
        while let Some(line) = take_sse_line(&pending, &mut pending_cursor) {
            if let Some(value) = parse_sse_value(line) {
                write_events(stream, parser.apply(&value)).await?;
            }
        }
        if pending_cursor > 0 {
            pending.drain(..pending_cursor);
            pending_cursor = 0;
        }
    }
    if let Some(value) = parse_sse_value(&pending) {
        write_events(stream, parser.apply(&value)).await?;
    }
    write_events(stream, parser.finish()).await?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("gateway SSE shutdown failed: {error}"))
}

#[derive(Default)]
struct OpenAiStream {
    open_block: Option<(&'static str, u32)>,
    next_index: u32,
    tools: Vec<AnthropicStreamTool>,
    finish_reason: Option<String>,
    usage: Option<Value>,
}

struct AnthropicStreamTool {
    upstream_index: u64,
    id: String,
    name: Value,
    fragments: Vec<String>,
}

fn tool_call_id(call: &Value) -> String {
    call.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple()))
}

impl OpenAiStream {
    fn close_block(&mut self, events: &mut Vec<Value>) {
        if let Some((_, index)) = self.open_block.take() {
            events.push(json!({"type":"content_block_stop","index":index}));
        }
    }

    fn begin_block(&mut self, kind: &'static str, block: Value, events: &mut Vec<Value>) -> u32 {
        self.close_block(events);
        let index = self.next_index;
        self.next_index += 1;
        self.open_block = Some((kind, index));
        events.push(json!({"type":"content_block_start","index":index,"content_block":block}));
        index
    }

    fn apply(&mut self, value: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        if let Some(usage) = value.get("usage").filter(|usage| usage.is_object()) {
            self.usage = Some(usage.clone());
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        else {
            return events;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta") else {
            return events;
        };
        for (kind, text) in [
            (
                "thinking",
                delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning")),
            ),
            ("text", delta.get("content")),
        ] {
            if let Some(text) = text.and_then(Value::as_str).filter(|text| !text.is_empty()) {
                let index = match self.open_block {
                    Some((open_kind, index)) if open_kind == kind => index,
                    _ => self.begin_block(
                        kind,
                        if kind == "thinking" {
                            json!({"type":"thinking","thinking":""})
                        } else {
                            json!({"type":"text","text":""})
                        },
                        &mut events,
                    ),
                };
                let delta = if kind == "thinking" {
                    json!({"type":"thinking_delta","thinking":text})
                } else {
                    json!({"type":"text_delta","text":text})
                };
                events.push(json!({"type":"content_block_delta","index":index,"delta":delta}));
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let upstream_index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let index = match self
                    .tools
                    .iter()
                    .position(|tool| tool.upstream_index == upstream_index)
                {
                    Some(index) => index,
                    None => {
                        self.tools.push(AnthropicStreamTool {
                            upstream_index,
                            id: tool_call_id(call),
                            name: Value::Null,
                            fragments: Vec::new(),
                        });
                        self.tools.len() - 1
                    }
                };
                let tool = &mut self.tools[index];
                if let Some(id) = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    id.clone_into(&mut tool.id);
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                    {
                        tool.name = json!(name);
                    }
                    if let Some(arguments) = function
                        .get("arguments")
                        .and_then(Value::as_str)
                        .filter(|arguments| !arguments.is_empty())
                    {
                        tool.fragments.push(arguments.to_owned());
                    }
                }
            }
        }
        events
    }

    fn finish(&mut self) -> Vec<Value> {
        let mut events = Vec::new();
        // Parallel OpenAI calls may interleave fragments. Buffer tool blocks until
        // generation ends so Anthropic blocks never overlap or reopen after stop.
        for tool in std::mem::take(&mut self.tools) {
            let index = self.begin_block(
                "tool_use",
                json!({
                    "type":"tool_use","id":tool.id,"name":tool.name,"input":{}
                }),
                &mut events,
            );
            for fragment in tool.fragments {
                events.push(json!({"type":"content_block_delta","index":index,
                    "delta":{"type":"input_json_delta","partial_json":fragment}}));
            }
        }
        self.close_block(&mut events);
        let stop_reason = match self.finish_reason.as_deref() {
            Some("length") => "max_tokens",
            Some("tool_calls") => "tool_use",
            Some("content_filter") => "refusal",
            _ => "end_turn",
        };
        let input_tokens = self
            .usage
            .as_ref()
            .and_then(|usage| usage.get("prompt_tokens"))
            .and_then(Value::as_u64);
        let output_tokens = self
            .usage
            .as_ref()
            .and_then(|usage| usage.get("completion_tokens"))
            .and_then(Value::as_u64);
        if let (Some(input_tokens), Some(output_tokens)) = (input_tokens, output_tokens) {
            events.push(json!({"type":"message_delta","delta":{"stop_reason":stop_reason,"stop_sequence":null},"usage":{"input_tokens":input_tokens,"output_tokens":output_tokens}}));
            events.push(json!({"type":"message_stop"}));
        } else {
            // Anthropic completion requires token counts; character counts
            // cannot replace an engine's missing usage report.
            events.push(json!({"type":"error","error":{"type":"api_error","message":"The inference engine did not report token usage for this streamed response."}}));
        }
        events
    }
}

fn anthropic_to_openai(request: &Value) -> Result<Value, String> {
    let messages = request
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "messages must be an array".to_string())?;
    let mut converted = Vec::new();
    if let Some(system) = request.get("system") {
        let content = content_blocks_to_openai(system)?;
        converted.push(json!({"role":"system","content":content}));
    }
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "message role is required".to_string())?;
        let content = message
            .get("content")
            .cloned()
            .unwrap_or(Value::String(String::new()));
        if let Some(blocks) = content.as_array() {
            let tool_results = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"));
            let mut had_tool_result = false;
            for block in tool_results {
                had_tool_result = true;
                converted.push(json!({
                    "role": "tool",
                    "tool_call_id": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                    "content": content_blocks_to_openai(block.get("content").unwrap_or(&Value::String(String::new())))?
                }));
            }
            let tool_calls: Vec<Value> = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
                .map(|block| {
                    json!({
                        "id": block.get("id").cloned().unwrap_or(Value::String(format!("call_{}", uuid::Uuid::new_v4().simple()))),
                        "type": "function",
                        "function": {
                            "name": block.get("name").cloned().unwrap_or(Value::String("tool".into())),
                            "arguments": serde_json::to_string(block.get("input").unwrap_or(&Value::Object(Map::new()))).unwrap_or_else(|_| "{}".into())
                        }
                    })
                })
                .collect();
            let remaining = content_blocks_to_openai(&content)?;
            if !tool_calls.is_empty() {
                converted
                    .push(json!({"role":"assistant","content":remaining,"tool_calls":tool_calls}));
            } else if !had_tool_result || remaining.as_str().is_none_or(|text| !text.is_empty()) {
                converted.push(json!({"role":role,"content":remaining}));
            }
        } else {
            converted.push(json!({"role":role,"content":content_blocks_to_openai(&content)?}));
        }
    }
    let mut body = Map::new();
    body.insert(
        "model".into(),
        request
            .get("model")
            .cloned()
            .unwrap_or(Value::String("local-model".into())),
    );
    body.insert("messages".into(), Value::Array(converted));
    body.insert(
        "stream".into(),
        request.get("stream").cloned().unwrap_or(Value::Bool(false)),
    );
    if request.get("stream").and_then(Value::as_bool) == Some(true) {
        body.insert("stream_options".into(), json!({"include_usage": true}));
    }
    for field in ["temperature", "top_p", "stop", "max_tokens"] {
        if let Some(value) = request.get(field) {
            body.insert(field.into(), value.clone());
        }
    }
    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        body.insert("tools".into(), Value::Array(tools.iter().map(|tool| json!({"type":"function","function":{"name":tool.get("name"),"description":tool.get("description"),"parameters":tool.get("input_schema")}})).collect()));
    }
    Ok(Value::Object(body))
}

fn content_blocks_to_openai(value: &Value) -> Result<Value, String> {
    let Some(blocks) = value.as_array() else {
        return Ok(value.clone());
    };
    let mut output = Vec::new();
    let mut text = String::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" | "thinking" => if let Some(value) = block.get(if block.get("type").and_then(Value::as_str) == Some("thinking") { "thinking" } else { "text" }).and_then(Value::as_str) { text.push_str(value); },
            "image" => output.push(json!({"type":"image_url","image_url":{"url":block.get("source").and_then(|source| source.get("data")).and_then(Value::as_str).map(|data| format!("data:{};base64,{}", block.get("source").and_then(|source| source.get("media_type")).and_then(Value::as_str).unwrap_or("image/png"), data)).or_else(|| block.get("source").and_then(|source| source.get("url")).and_then(Value::as_str).map(str::to_owned))}})),
            // These blocks are translated to separate OpenAI tool messages above.
            "tool_use" | "tool_result" => {}
            kind => return Err(format!("Anthropic input type {kind} cannot be represented by this adapter; use /v1/chat/completions for supported audio and video input")),
        }
    }
    if output.is_empty() {
        Ok(Value::String(text))
    } else {
        if !text.is_empty() {
            output.insert(0, json!({"type":"text","text":text}));
        }
        Ok(Value::Array(output))
    }
}

fn openai_to_anthropic(value: &Value) -> Value {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or(Value::Null);
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let mut content = Vec::new();
    if let Some(thinking) = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        content.push(json!({"type":"thinking","thinking":thinking}));
    }
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        content.push(json!({"type":"text","text":text}));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            let input = function
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .unwrap_or_else(|| json!({}));
            content.push(json!({"type":"tool_use","id":tool_call_id(call),"name":function.get("name"),"input":input}));
        }
    }
    let finish = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(|reason| match reason {
            "tool_calls" => "tool_use",
            "length" => "max_tokens",
            _ => "end_turn",
        })
        .unwrap_or("end_turn");
    json!({"id":value.get("id").cloned().unwrap_or(Value::String(format!("msg_{}", uuid::Uuid::new_v4().simple()))),"type":"message","role":"assistant","model":value.get("model").cloned().unwrap_or(Value::String("local-model".into())),"content":content,"stop_reason":finish,"stop_sequence":null,"usage":{"input_tokens":value.get("usage").and_then(|usage| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0),"output_tokens":value.get("usage").and_then(|usage| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0)}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_stream_tool_indices_follow_reasoning_and_text_items() {
        let mut state = ResponseStreamState::default();
        let events = state.apply(&json!({"choices":[{"delta":{
            "reasoning":"think","content":"Checking","tool_calls":[
                {"index":7,"id":"call_a","function":{"name":"lookup","arguments":"{}"}}
            ]
        }}]}));
        assert_eq!(events[0]["item"]["type"], "reasoning");
        assert_eq!(events[2]["item"]["type"], "message");
        assert_eq!(events[4]["item"]["type"], "function_call");
        assert_eq!(events[4]["output_index"], 2);
        assert_eq!(events[5]["output_index"], 2);
        let done = state.finish();
        assert_eq!(done[2]["type"], "response.function_call_arguments.done");
        assert_eq!(done[2]["item_id"], events[4]["item"]["id"]);
        assert_eq!(state.output[0]["summary"][0]["text"], "think");
        assert_eq!(state.output[1]["content"][0]["text"], "Checking");
        let completed = response_value(
            "resp_mixed",
            "m",
            &state.text,
            state.output.clone(),
            json!({}),
            "completed",
        );
        assert_eq!(completed["output"][2], done[3]["item"]);
    }

    #[test]
    fn non_stream_responses_history_keeps_assistant_tool_calls_for_follow_up() {
        let upstream = json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
            {"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{}"}}
        ]}}]});
        let history = HistoryNode::append(None, Vec::new(), openai_assistant_message(&upstream));
        let mut messages = history.flatten();
        messages.extend(
            responses_input_to_openai(&json!({
                "previous_response_id":"resp_parent",
                "input":[{"type":"function_call_output","call_id":"call_a","output":"found"}]
            }))
            .unwrap(),
        );
        let request = responses_to_openai(&json!({}), messages).unwrap();
        assert_eq!(request["messages"][0]["tool_calls"][0]["id"], "call_a");
        assert_eq!(
            request["messages"][1],
            json!({"role":"tool","tool_call_id":"call_a","content":"found"})
        );
    }

    #[test]
    fn anthropic_stream_serializes_text_and_interleaved_tool_argument_fragments() {
        let mut state = OpenAiStream::default();
        let mut events = state.apply(&json!({"choices":[{"delta":{"content":"Checking"}}]}));
        events.extend(state.apply(&json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_a","function":{"name":"lookup","arguments":"{\"q\":"}},
            {"index":1,"id":"call_b","function":{"name":"next","arguments":"{"}}
        ]}}]})));
        events.extend(state.apply(&json!({"choices":[{"delta":{"tool_calls":[
            {"index":1,"id":"","function":{"name":"","arguments":"}"}},
            {"index":0,"id":"","function":{"name":null,"arguments":"1}"}}
        ]},"finish_reason":"tool_calls"}]})));
        events.extend(
            state.apply(&json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}})),
        );
        events.extend(state.finish());
        assert_eq!(
            events,
            vec![
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_a","name":"lookup","input":{}}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"q\":"}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}),
                json!({"type":"content_block_stop","index":1}),
                json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_b","name":"next","input":{}}}),
                json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{"}}),
                json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"}"}}),
                json!({"type":"content_block_stop","index":2}),
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":3,"output_tokens":4}}),
                json!({"type":"message_stop"}),
            ]
        );
    }

    #[test]
    fn anthropic_stream_closes_thinking_before_text_and_preserves_missing_usage_error() {
        let mut state = OpenAiStream::default();
        let mut events =
            state.apply(&json!({"choices":[{"delta":{"reasoning":"think","content":"answer"}}]}));
        events.extend(state.finish());
        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "error",
            ]
        );
        assert_eq!(events[3]["index"], 1);
        let mut state = OpenAiStream::default();
        state.apply(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{}"}}]}}]}));
        let events = state.finish();
        assert!(events[0]["content_block"]["id"]
            .as_str()
            .unwrap()
            .starts_with("call_"));
        let non_stream = openai_to_anthropic(
            &json!({"choices":[{"message":{"tool_calls":[{"function":{"name":"lookup","arguments":"{}"}}]}}]}),
        );
        assert!(non_stream["content"][0]["id"]
            .as_str()
            .unwrap()
            .starts_with("call_"));
    }

    #[test]
    fn responses_outputs_include_function_calls_without_empty_assistant_messages() {
        let upstream = json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
            {"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{\"q\":1}"}},
            {"id":"call_b","type":"function","function":{"name":"next","arguments":"{}"}}
        ]}}]});
        let response = openai_to_responses(&upstream, &json!({"model":"m"}), "resp_test");
        let items = response["output"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0]["id"].as_str().unwrap().starts_with("fc_"));
        assert_eq!(items[0]["type"], "function_call");
        assert_eq!(items[0]["call_id"], "call_a");
        assert_eq!(items[0]["name"], "lookup");
        assert_eq!(items[0]["arguments"], "{\"q\":1}");
        assert_eq!(items[0]["status"], "completed");
        assert_eq!(items[1]["call_id"], "call_b");
        let mut with_text = upstream;
        with_text["choices"][0]["message"]["content"] = json!("Checking");
        let response = openai_to_responses(&with_text, &json!({}), "resp_text");
        assert_eq!(response["output"][0]["type"], "message");
        assert_eq!(response["output"][1]["type"], "function_call");
    }

    #[test]
    fn responses_stream_tracks_parallel_tools_with_stable_items_and_history() {
        let mut state = ResponseStreamState::default();
        let mut events = state.apply(&json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_a","function":{"name":"lookup","arguments":"{\"q\":"}},
            {"index":1,"id":"call_b","function":{"name":"next","arguments":"{"}}
        ]}}]}));
        events.extend(state.apply(&json!({"choices":[{"delta":{"tool_calls":[
            {"index":1,"id":"","function":{"name":"","arguments":"}"}},
            {"index":0,"id":"","function":{"name":null,"arguments":"1}"}}
        ]}}]})));
        events.extend(state.finish());
        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "response.output_item.added",
                "response.function_call_arguments.delta",
                "response.output_item.added",
                "response.function_call_arguments.delta",
                "response.function_call_arguments.delta",
                "response.function_call_arguments.delta",
                "response.function_call_arguments.done",
                "response.output_item.done",
                "response.function_call_arguments.done",
                "response.output_item.done",
            ]
        );
        for (sequence, event) in events.iter().enumerate() {
            assert_eq!(event["sequence_number"], sequence + 1);
        }
        assert_eq!(events[0]["output_index"], 0);
        assert_eq!(events[2]["output_index"], 1);
        assert_eq!(events[1]["item_id"], events[0]["item"]["id"]);
        assert_eq!(events[4]["item_id"], events[2]["item"]["id"]);
        assert_eq!(events[6]["arguments"], "{\"q\":1}");
        assert_eq!(events[8]["arguments"], "{}");
        let completed = response_value(
            "resp_tool",
            "m",
            &state.text,
            state.output.clone(),
            json!({}),
            "completed",
        );
        assert_eq!(completed["output"][0], events[7]["item"]);
        assert_eq!(completed["output"][1], events[9]["item"]);
        let parent = HistoryNode::append(
            None,
            vec![json!({"role":"user","content":"check"})],
            state.assistant_message(),
        );
        let mut next = parent.flatten();
        next.extend(
            responses_input_to_openai(&json!({
                "previous_response_id":"resp_tool",
                "input":[
                    {"type":"function_call_output","call_id":"call_a","output":"one"},
                    {"type":"function_call_output","call_id":"call_b","output":"two"}
                ]
            }))
            .unwrap(),
        );
        assert_eq!(
            next[1]["tool_calls"],
            json!([
                {"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{\"q\":1}"}},
                {"id":"call_b","type":"function","function":{"name":"next","arguments":"{}"}}
            ])
        );
        assert_eq!(
            next[2],
            json!({"role":"tool","tool_call_id":"call_a","content":"one"})
        );
        assert_eq!(
            next[3],
            json!({"role":"tool","tool_call_id":"call_b","content":"two"})
        );
    }

    #[test]
    fn sse_lines_preserve_utf8_at_every_network_split_and_unterminated_tail() {
        let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"한글🙂\"}}]}\r\n";
        for split in 0..=wire.len() {
            let mut pending = Vec::new();
            let mut parsed = Vec::new();
            let mut cursor = 0;
            for chunk in [&wire.as_bytes()[..split], &wire.as_bytes()[split..]] {
                pending.extend_from_slice(chunk);
                while let Some(line) = take_sse_line(&pending, &mut cursor) {
                    parsed.push(parse_sse_value(line).unwrap());
                }
                pending.drain(..cursor);
                cursor = 0;
            }
            assert!(pending.is_empty());
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0]["choices"][0]["delta"]["content"], "한글🙂");
            let mut anthropic = OpenAiStream::default();
            let anthropic_events = anthropic.apply(&parsed[0]);
            assert_eq!(anthropic_events[1]["delta"]["text"], "한글🙂");
            let mut responses = ResponseStreamState::default();
            let response_events = responses.apply(&parsed[0]);
            assert_eq!(response_events[1]["delta"], "한글🙂");
            assert_eq!(
                parse_sse_value(wire.trim_end().as_bytes()).unwrap(),
                parsed[0]
            );
        }
    }

    #[test]
    fn responses_function_tools_and_choices_use_chat_completion_shapes() {
        let request = json!({
            "tools":[{"type":"function","name":"lookup","description":"Find a value",
                "parameters":{"type":"object"},"strict":true}],
            "tool_choice":{"type":"function","name":"lookup"}
        });
        let converted = responses_to_openai(&request, Vec::new()).unwrap();
        assert_eq!(
            converted["tools"],
            json!([{"type":"function","function":{
                "name":"lookup","description":"Find a value","parameters":{"type":"object"},"strict":true
            }}])
        );
        assert_eq!(
            converted["tool_choice"],
            json!({"type":"function","function":{"name":"lookup"}})
        );
        for choice in ["auto", "none", "required"] {
            assert_eq!(
                responses_to_openai(&json!({"tool_choice":choice}), Vec::new()).unwrap()
                    ["tool_choice"],
                choice
            );
        }
        for request in [
            json!({"tools":[{"type":"web_search"}]}),
            json!({"tool_choice":{"type":"web_search"}}),
        ] {
            assert!(responses_to_openai(&request, Vec::new())
                .unwrap_err()
                .contains("web_search"));
        }
    }

    #[test]
    fn responses_function_items_merge_assistant_calls_and_preserve_tool_results() {
        let messages = responses_input_to_openai(&json!({"input":[
            {"role":"assistant","content":[{"type":"output_text","text":"Checking"}]},
            {"type":"function_call","call_id":"call_a","name":"lookup","arguments":"{\"q\":1}"},
            {"type":"function_call","call_id":"call_b","name":"lookup","arguments":"{\"q\":2}"},
            {"type":"function_call_output","call_id":"call_a","output":"one"},
            {"type":"function_call_output","call_id":"call_b","output":[{"type":"input_text","text":"two"}]},
            {"type":"function_call","call_id":"call_c","name":"done","arguments":"{}"}
        ]})).unwrap();
        assert_eq!(
            messages,
            vec![
                json!({"role":"assistant","content":"Checking","tool_calls":[
                    {"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{\"q\":1}"}},
                    {"id":"call_b","type":"function","function":{"name":"lookup","arguments":"{\"q\":2}"}}
                ]}),
                json!({"role":"tool","tool_call_id":"call_a","content":"one"}),
                json!({"role":"tool","tool_call_id":"call_b","content":"two"}),
                json!({"role":"assistant","content":null,"tool_calls":[
                    {"id":"call_c","type":"function","function":{"name":"done","arguments":"{}"}}
                ]}),
            ]
        );
    }

    #[test]
    fn streamed_tool_calls_generate_and_retain_ids_for_empty_upstream_ids() {
        let first = json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"","function":{"name":"lookup","arguments":"{"}}
        ]}}]});
        let continuation = json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":null,"function":{"name":null,"arguments":"}"}}
        ]}}]});
        let mut anthropic = OpenAiStream::default();
        let _ = anthropic.apply(&first);
        let _ = anthropic.apply(&continuation);
        let events = anthropic.finish();
        let block = &events[0]["content_block"];
        assert!(!block["id"].as_str().unwrap().is_empty());
        assert_eq!(block["name"], "lookup");

        let mut responses = ResponseStreamState::default();
        let events = responses.apply(&first);
        let announced_id = events[0]["item"]["call_id"].as_str().unwrap();
        assert!(!announced_id.is_empty());
        let _ = responses.apply(&continuation);
        let _ = responses.finish();
        let assistant = responses.assistant_message();
        assert_eq!(assistant["tool_calls"][0]["id"], announced_id);
        assert_eq!(assistant["tool_calls"][0]["function"]["name"], "lookup");
        assert_eq!(assistant["tool_calls"][0]["function"]["arguments"], "{}");
    }

    #[test]
    fn responses_reasoning_and_function_output_round_trip_as_assistant_turns() {
        for streamed in [false, true] {
            for text in ["", "Checking"] {
                let upstream = json!({"choices":[{"message":{
                    "role":"assistant","content":text,"reasoning_content":"Need lookup",
                    "tool_calls":[{"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{}"}}]
                }}]});
                let output = if streamed {
                    let mut state = ResponseStreamState::default();
                    let _ = state
                        .apply(&json!({"choices":[{"delta":upstream["choices"][0]["message"]}]}));
                    let _ = state.finish();
                    Value::Array(state.output)
                } else {
                    let mut response =
                        openai_to_responses(&upstream, &json!({}), "resp_round_trip");
                    response["output"].take()
                };
                let Value::Array(output) = output else {
                    panic!("response output must be an array")
                };
                let mut input = vec![json!({"role":"user","content":"Find it"})];
                input.extend(output);
                input.push(
                    json!({"type":"function_call_output","call_id":"call_a","output":"found"}),
                );
                let messages = responses_input_to_openai(&json!({"input":input})).unwrap();
                let content = if text.is_empty() {
                    Value::Null
                } else {
                    json!(text)
                };
                assert_eq!(
                    messages,
                    vec![
                        json!({"role":"user","content":"Find it"}),
                        json!({"role":"assistant","content":content,"reasoning_content":"Need lookup",
                        "tool_calls":[{"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{}"}}]}),
                        json!({"role":"tool","tool_call_id":"call_a","content":"found"}),
                    ],
                    "streamed={streamed}, text={text:?}"
                );
            }
        }
    }

    #[test]
    fn history_nodes_flatten_in_order_and_share_branch_ancestors() {
        let root = HistoryNode::append(
            None,
            vec![json!({"role":"user","content":"one"})],
            json!({"role":"assistant","content":"one answer"}),
        );
        let left = HistoryNode::append(
            Some(Arc::clone(&root)),
            vec![json!({"role":"user","content":"left"})],
            json!({"role":"assistant","content":"left answer"}),
        );
        let right = HistoryNode::append(
            Some(Arc::clone(&root)),
            vec![json!({"role":"user","content":"right"})],
            json!({"role":"assistant","content":"right answer"}),
        );

        assert_eq!(Arc::strong_count(&root), 3);
        assert_eq!(
            left.flatten(),
            vec![
                json!({"role":"user","content":"one"}),
                json!({"role":"assistant","content":"one answer"}),
                json!({"role":"user","content":"left"}),
                json!({"role":"assistant","content":"left answer"}),
            ]
        );
        assert_eq!(
            right.flatten(),
            vec![
                json!({"role":"user","content":"one"}),
                json!({"role":"assistant","content":"one answer"}),
                json!({"role":"user","content":"right"}),
                json!({"role":"assistant","content":"right answer"}),
            ]
        );
        drop(right);
        assert_eq!(Arc::strong_count(&root), 2);
        drop(left);
        assert_eq!(Arc::strong_count(&root), 1);
    }

    #[test]
    fn dropping_a_deep_history_chain_does_not_recurse_through_parents() {
        let mut history = None;
        for index in 0..(MAX_RESPONSES * 64) {
            history = Some(HistoryNode::append(
                history,
                vec![json!({"role":"user","content":index})],
                json!({"role":"assistant","content":index}),
            ));
        }
        let history = history.unwrap();
        assert_eq!(history.flatten().len(), MAX_RESPONSES * 64 * 2);
        drop(history);
    }

    #[test]
    fn a_descendant_keeps_history_after_its_parent_entry_is_removed() {
        let parent = HistoryNode::append(
            None,
            vec![json!({"role":"user","content":"parent"})],
            json!({"role":"assistant","content":"answer"}),
        );
        let descendant = HistoryNode::append(
            Some(Arc::clone(&parent)),
            vec![json!({"role":"user","content":"next"})],
            json!({"role":"assistant","content":"next answer"}),
        );
        drop(parent);
        assert_eq!(
            descendant.flatten(),
            vec![
                json!({"role":"user","content":"parent"}),
                json!({"role":"assistant","content":"answer"}),
                json!({"role":"user","content":"next"}),
                json!({"role":"assistant","content":"next answer"}),
            ]
        );
    }

    #[test]
    fn concurrent_deep_branch_owner_drops_are_bounded() {
        const DEPTH: usize = MAX_RESPONSES * 4;
        let mut shared = None;
        for index in 0..DEPTH {
            shared = Some(HistoryNode::append(
                shared,
                vec![json!({"role":"user","content":index})],
                json!({"role":"assistant","content":index}),
            ));
        }
        let shared = shared.unwrap();
        let branches = (0..3)
            .map(|index| {
                HistoryNode::append(
                    Some(Arc::clone(&shared)),
                    vec![json!({"role":"user","content":format!("branch-{index}")})],
                    json!({"role":"assistant","content":format!("answer-{index}")}),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(Arc::strong_count(&shared), 4);

        let barrier = Arc::new(std::sync::Barrier::new(branches.len() + 1));
        let owners = branches
            .into_iter()
            .map(|branch| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    drop(branch);
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        drop(shared);
        for owner in owners {
            owner.join().unwrap();
        }
    }

    #[tokio::test]
    async fn active_stream_can_outlive_the_idle_read_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            for _ in 0..8 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                socket.write_all(b"x").await.unwrap();
            }
        });
        let client = build_upstream_client(Duration::from_millis(500));
        let received = tokio::time::timeout(Duration::from_secs(5), async {
            client
                .get(format!("http://{address}/stream"))
                .header(reqwest::header::CONTENT_LENGTH, "0")
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(&received[..], b"xxxxxxxx");
        server.await.unwrap();
    }

    #[test]
    fn translates_anthropic_text_and_tools_to_openai() {
        let request = json!({"model":"m","max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"tools":[{"name":"search","input_schema":{"type":"object"}}]});
        let output = anthropic_to_openai(&request).unwrap();
        assert_eq!(output["messages"][0]["content"], "hello");
        assert_eq!(output["tools"][0]["function"]["name"], "search");
    }

    #[test]
    fn wire_adapters_refuse_unrepresentable_media_instead_of_dropping_it() {
        for kind in ["input_audio", "input_video", "future_media"] {
            let content = json!([{"type":"text","text":"describe"},{"type":kind}]);
            assert!(response_content_to_openai(&content)
                .unwrap_err()
                .contains(kind));
            assert!(content_blocks_to_openai(&content)
                .unwrap_err()
                .contains(kind));
        }
        assert!(response_content_to_openai(&json!([{"type":"input_image"}])).is_err());
        // A tool result must not suppress validation of other blocks in the same message.
        assert!(
            anthropic_to_openai(&json!({"messages":[{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"call","content":"done"},
                {"type":"input_audio"}
            ]}]}))
            .is_err()
        );
    }

    #[test]
    fn anthropic_tool_results_preserve_other_user_content() {
        let output = anthropic_to_openai(&json!({"messages":[{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"call","content":[{"type":"text","text":"done"}]},
            {"type":"text","text":"next question"}
        ]}]}))
        .unwrap();
        assert_eq!(output["messages"][0]["content"], "done");
        assert_eq!(output["messages"][1]["content"], "next question");
    }

    #[test]
    fn translates_openai_stop_and_usage_to_anthropic() {
        let response = json!({"id":"chatcmpl-1","model":"m","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}});
        let output = openai_to_anthropic(&response);
        assert_eq!(output["content"][0]["text"], "ok");
        assert_eq!(output["usage"]["input_tokens"], 3);
        assert_eq!(output["stop_reason"], "end_turn");
    }

    #[test]
    fn translates_anthropic_tool_result_and_tool_use_without_empty_duplicate_messages() {
        let request = json!({
            "model": "m",
            "max_tokens": 32,
            "messages": [
                {"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"search","input":{"q":"llama"}}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"found"}]}
            ]
        });
        let output = anthropic_to_openai(&request).unwrap();
        assert_eq!(output["messages"].as_array().unwrap().len(), 2);
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["function"]["name"],
            "search"
        );
        assert_eq!(output["messages"][1]["role"], "tool");
    }

    #[test]
    fn translates_responses_input_and_preserves_previous_turn_shape() {
        let request = json!({
            "model": "m",
            "instructions": "Be concise.",
            "input": [{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
            "max_output_tokens": 24,
            "stream": true
        });
        let messages = responses_input_to_openai(&request).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["content"], "hello");
        let output = responses_to_openai(&request, messages).unwrap();
        assert_eq!(output["max_tokens"], 24);
        assert_eq!(output["stream"], true);
    }

    #[test]
    fn converts_openai_response_to_stateful_responses_shape() {
        let request = json!({"model":"m"});
        let response = json!({"model":"m","choices":[{"message":{"role":"assistant","content":"done","reasoning":"think"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}});
        let output = openai_to_responses(&response, &request, "resp_test");
        assert_eq!(output["object"], "response");
        assert_eq!(output["id"], "resp_test");
        assert_eq!(output["output_text"], "done");
        assert_eq!(output["usage"]["total_tokens"], 6);
        assert_eq!(output["output"][0]["type"], "reasoning");
        assert_eq!(output["output"][1]["content"][0]["type"], "output_text");
    }
}
