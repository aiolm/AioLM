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
mod routing;

pub use routing::ModelSource;

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
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::Notify,
    task::{JoinHandle, JoinSet},
};

const MAX_UPSTREAM_JSON_BYTES: usize = 8 * 1024 * 1024;
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
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!(
            "OpenAI upstream response exceeds the {limit} byte limit"
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("OpenAI upstream response read failed: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!(
                "OpenAI upstream response exceeds the {limit} byte limit"
            ));
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
    task: JoinHandle<()>,
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

#[derive(Clone)]
struct StoredResponse {
    response: Value,
    messages: Vec<Value>,
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
) -> Result<GatewayHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| {
            format!(
                "cannot listen on 127.0.0.1:{port}: {error}. Choose another API port in Settings or close the program using it."
            )
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("cannot inspect the API listener address: {error}"))?
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
        task,
    })
}

pub async fn stop(handle: GatewayHandle) {
    handle.shutdown.notify_one();
    let _ = handle.task.await;
}

async fn run(listener: TcpListener, ctx: Arc<Ctx>, shutdown: Arc<Notify>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    connections.spawn(handle_connection(stream, Arc::clone(&ctx)));
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

fn constant_time_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
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
    let parsed: Value = serde_json::from_slice(&request.body).map_err(|error| {
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
            .body(request.body)
            .send(),
    )
    .await?
    .map_err(upstream_failure)?;
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
    let history = if let Some(previous_id) = previous_id {
        let history = responses
            .lock()
            .await
            .get(previous_id)
            .map(|stored| stored.messages.clone());
        let Some(history) = history else {
            write_json_response(stream, 404, json!({"error":{"type":"not_found","message":format!("previous_response_id {previous_id} was not found")}})).await?;
            return Ok(());
        };
        history
    } else {
        Vec::new()
    };
    let mut messages = history;
    messages.extend(
        responses_input_to_openai(&body)
            .map_err(|message| ApiError::new(400, "invalid_request", message))?,
    );
    let openai_request = responses_to_openai(&body, messages.clone())
        .map_err(|message| ApiError::new(400, "invalid_request", message))?;
    let stream_requested = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    // The lease counts this request as active on its model until the handler
    // returns, however the answer ends, so the model cannot be unloaded or
    // replaced underneath a response that is still being delivered.
    let lease = ctx
        .models
        .acquire(requested_model(&body)?)
        .map_err(RouteError::into_api_error)?;
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
            messages,
            Arc::clone(responses),
        )
        .await?;
    } else {
        let value = unless_client_leaves(stream, bounded_upstream_json(response))
            .await?
            .map_err(|message| ApiError::new(502, "bad_upstream_response", message))?;
        let assistant = openai_assistant_message(&value);
        messages.push(assistant);
        let response_value = openai_to_responses(&value, &body, &response_id);
        remember_response(responses, response_id, response_value.clone(), messages).await;
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
    for item in items {
        if let Some(text) = item.as_str() {
            messages.push(json!({"role":"user","content":text}));
            continue;
        }
        let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
        let empty_content = Value::String(String::new());
        let content = item
            .get("content")
            .or_else(|| item.get("output"))
            .unwrap_or(&empty_content);
        messages.push(json!({"role":role,"content":response_content_to_openai(content)?}));
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
                if let Some(url) = url { output.push(json!({"type":"image_url","image_url":{"url":url}})); }
            }
            "function_call_output" => output.push(json!({"type":"text","text":block.get("output").cloned().unwrap_or(Value::String(String::new()))})),
            _ => {}
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
    for (source, target) in [
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("max_output_tokens", "max_tokens"),
        ("stop", "stop"),
        ("tools", "tools"),
        ("tool_choice", "tool_choice"),
        ("response_format", "response_format"),
    ] {
        if let Some(value) = request.get(source) {
            body.insert(target.into(), value.clone());
        }
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
    response_value(
        response_id,
        request
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("local-model"),
        text,
        reasoning,
        response_usage(value),
        "completed",
    )
}

fn response_value(
    id: &str,
    model: &str,
    text: &str,
    reasoning: &str,
    usage: Value,
    status: &str,
) -> Value {
    let mut output = Vec::new();
    if !reasoning.is_empty() {
        output.push(json!({"id":format!("rs_{}", uuid::Uuid::new_v4().simple()),"type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":reasoning}]}));
    }
    output.push(json!({"id":format!("msg_{}", uuid::Uuid::new_v4().simple()),"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}));
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
    messages: Vec<Value>,
) {
    let mut guard = responses.lock().await;
    guard.insert(id, StoredResponse { response, messages });
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
    mut messages: Vec<Value>,
    responses: Arc<tokio::sync::Mutex<HashMap<String, StoredResponse>>>,
) -> Result<(), String> {
    write_stream_head(stream, 200, "text/event-stream", None).await?;
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("local-model");
    let created = response_value(&response_id, model, "", "", json!({}), "in_progress");
    write_event(
        stream,
        "response.created",
        json!({"type":"response.created","response":created}),
    )
    .await?;
    let mut state = ResponseStreamState::default();
    let mut pending = String::new();
    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = unless_client_leaves(stream, body_stream.next()).await? {
        let chunk =
            chunk.map_err(|error| format!("Responses upstream SSE read failed: {error}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        if pending.len() > MAX_STREAM_PENDING_BYTES {
            return Err("upstream SSE line exceeded the 4 MiB limit".into());
        }
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim_end_matches('\r').to_string();
            pending.drain(..=index);
            if let Some(data) = line.strip_prefix("data:") {
                if data.trim() == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                    state.apply(&value, stream).await?;
                }
            }
        }
    }
    if !pending.trim().is_empty() {
        if let Some(data) = pending.trim().strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                state.apply(&value, stream).await?;
            }
        }
    }
    messages
        .push(json!({"role":"assistant","content":state.text,"reasoning_content":state.reasoning}));
    let completed = response_value(
        &response_id,
        model,
        &state.text,
        &state.reasoning,
        state.usage.unwrap_or_else(|| json!({})),
        "completed",
    );
    remember_response(&responses, response_id, completed.clone(), messages).await;
    write_event(
        stream,
        "response.completed",
        json!({"type":"response.completed","response":completed}),
    )
    .await?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("Responses SSE shutdown failed: {error}"))
}

#[derive(Default)]
struct ResponseStreamState {
    text: String,
    reasoning: String,
    usage: Option<Value>,
}

impl ResponseStreamState {
    async fn apply(&mut self, value: &Value, stream: &mut TcpStream) -> Result<(), String> {
        if let Some(usage) = value.get("usage") {
            self.usage = Some(response_usage(value));
            let _ = usage;
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        else {
            return Ok(());
        };
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        if let Some(text) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.reasoning.push_str(text);
            write_event(
                stream,
                "response.reasoning_summary_text.delta",
                json!({"type":"response.reasoning_summary_text.delta","delta":text}),
            )
            .await?;
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.text.push_str(text);
            write_event(
                stream,
                "response.output_text.delta",
                json!({"type":"response.output_text.delta","delta":text}),
            )
            .await?;
        }
        Ok(())
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
    let mut pending = String::new();
    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = unless_client_leaves(stream, body_stream.next()).await? {
        let chunk = chunk.map_err(|error| format!("upstream SSE read failed: {error}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        if pending.len() > MAX_STREAM_PENDING_BYTES {
            return Err("upstream SSE line exceeded the 4 MiB limit".into());
        }
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim_end_matches('\r').to_string();
            pending.drain(..=index);
            if let Some(data) = line.strip_prefix("data:") {
                if data.trim() == "[DONE]" {
                    break;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                    parser.apply(&value, stream).await?;
                }
            }
        }
    }
    if !pending.trim().is_empty() && pending.trim() != "data: [DONE]" {
        if let Some(data) = pending.trim().strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                parser.apply(&value, stream).await?;
            }
        }
    }
    parser.finish(stream).await
}

#[derive(Default)]
struct OpenAiStream {
    thinking_index: Option<u32>,
    text_index: Option<u32>,
    output_tokens: u64,
    finish_reason: Option<String>,
    usage: Option<Value>,
}

impl OpenAiStream {
    async fn apply(&mut self, value: &Value, stream: &mut TcpStream) -> Result<(), String> {
        if let Some(usage) = value.get("usage") {
            self.usage = Some(usage.clone());
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        else {
            return Ok(());
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        if let Some(text) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = if let Some(index) = self.thinking_index {
                index
            } else {
                let index = 0;
                self.thinking_index = Some(index);
                write_event(stream, "content_block_start", json!({"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":""}})).await?;
                index
            };
            self.output_tokens += text.chars().count() as u64;
            write_event(stream, "content_block_delta", json!({"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":text}})).await?;
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = if let Some(index) = self.text_index {
                index
            } else {
                let index = if self.thinking_index.is_some() { 1 } else { 0 };
                self.text_index = Some(index);
                write_event(stream, "content_block_start", json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}})).await?;
                index
            };
            self.output_tokens += text.chars().count() as u64;
            write_event(stream, "content_block_delta", json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}})).await?;
        }
        Ok(())
    }

    async fn finish(&self, stream: &mut TcpStream) -> Result<(), String> {
        if let Some(index) = self.thinking_index {
            write_event(
                stream,
                "content_block_stop",
                json!({"type":"content_block_stop","index":index}),
            )
            .await?;
        }
        if let Some(index) = self.text_index {
            write_event(
                stream,
                "content_block_stop",
                json!({"type":"content_block_stop","index":index}),
            )
            .await?;
        }
        let stop_reason = match self.finish_reason.as_deref() {
            Some("length") => "max_tokens",
            Some("tool_calls") => "tool_use",
            Some("content_filter") => "refusal",
            _ => "end_turn",
        };
        write_event(stream, "message_delta", json!({"type":"message_delta","delta":{"stop_reason":stop_reason,"stop_sequence":null},"usage":{"output_tokens":self.usage.as_ref().and_then(|v| v.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(self.output_tokens)}})).await?;
        write_event(stream, "message_stop", json!({"type":"message_stop"})).await?;
        stream
            .shutdown()
            .await
            .map_err(|error| format!("gateway SSE shutdown failed: {error}"))
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
                    "content": block.get("content").cloned().unwrap_or(Value::String(String::new()))
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
            if !tool_calls.is_empty() {
                converted.push(json!({"role":"assistant","content":content_blocks_to_openai(&content)?,"tool_calls":tool_calls}));
            } else if !had_tool_result {
                converted.push(json!({"role":role,"content":content_blocks_to_openai(&content)?}));
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
            _ => {}
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
            content.push(json!({"type":"tool_use","id":call.get("id"),"name":function.get("name"),"input":input}));
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
