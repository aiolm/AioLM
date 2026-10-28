//! App-owned verification for discovered local HTTP servers. This module reads
//! models and exercises the public protocol; it never starts, stops or claims
//! ownership of the server process and never infers capabilities from a name.
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    net::IpAddr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const EVENT_LIMIT: usize = 64 * 1024;
const MODEL_LIMIT: usize = 256;
const OUTPUT_LIMIT: usize = 4096;
const INSPECT_TIMEOUT: Duration = Duration::from_secs(2);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EndpointInfo {
    /// Canonical API root, including /v1. It contains no credentials or query.
    pub base_url: String,
    pub models: Vec<Model>,
}

// Do not derive Debug/Serialize: API keys are transient request data, not logs
// or registration metadata.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeRequest {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VerifiedCapabilities {
    pub text_generation: bool,
    pub streaming: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Verification {
    pub base_url: String,
    pub model: String,
    pub verified_at_unix_ms: u64,
    pub capabilities: VerifiedCapabilities,
    /// A protocol/sample check does not measure model quality, performance or
    /// image, audio, tools, embeddings or hardware compatibility.
    pub checks: Vec<String>,
}

/// Automatic discovery is limited to local services. Redirects and proxy use
/// are disabled too, so a local candidate cannot move this probe elsewhere.
/// An explicit remote connection belongs to the existing advanced flow.
pub fn normalize_base_url(base_url: &str) -> Result<String, String> {
    if base_url.len() > 4096 || base_url.chars().any(char::is_control) {
        return Err("invalid local server URL".into());
    }
    let mut url = Url::parse(base_url).map_err(|_| "invalid local server URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "local server URL must be HTTP(S) without credentials, query or fragment".into(),
        );
    }
    let host = url.host_str().unwrap_or_default();
    let local = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !local {
        return Err("automatic connection only inspects loopback servers".into());
    }
    let path = url.path().trim_end_matches('/');
    if path.ends_with("/models") || path.ends_with("/chat/completions") {
        return Err("use the server or /v1 URL, not an individual API endpoint".into());
    }
    let api_path = if path.ends_with("/v1") {
        path.to_string()
    } else {
        format!("{path}/v1")
    };
    url.set_path(&api_path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(750))
        .build()
        .map_err(|_| "could not create local verification client".into())
}

fn authenticated(
    request: reqwest::RequestBuilder,
    api_key: Option<&str>,
) -> Result<reqwest::RequestBuilder, String> {
    match api_key.filter(|key| !key.is_empty()) {
        Some(key) if key.len() <= 16_384 && !key.chars().any(char::is_control) => {
            Ok(request.bearer_auth(key))
        }
        Some(_) => Err("invalid server credential".into()),
        None => Ok(request),
    }
}

async fn body(mut response: Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "local server returned HTTP {}; connection is unverified",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > RESPONSE_LIMIT as u64)
    {
        return Err("local verification response exceeds 2 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "local verification response was interrupted")?
    {
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err("local verification response exceeds 2 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn valid_model_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 2048 && !id.chars().any(char::is_control)
}

fn parse_models(bytes: &[u8]) -> Result<Vec<Model>, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "local server did not return a JSON model list")?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("local server did not return an OpenAI model list")?;
    if data.len() > MODEL_LIMIT {
        return Err("local server model list exceeds 256 entries".into());
    }
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for item in data {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_model_id(id))
            .ok_or("local server returned an invalid model identifier")?;
        if seen.insert(id.to_string()) {
            models.push(Model { id: id.to_string() });
        }
    }
    Ok(models)
}

async fn models(
    client: &Client,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<Model>, String> {
    let response = authenticated(client.get(format!("{base_url}/models")), api_key)?
        .send()
        .await
        .map_err(|_| "local server did not answer model discovery")?;
    parse_models(&body(response).await?)
}

/// Listing models establishes a candidate only. An empty list is permitted and
/// must remain unverified until the user loads/selects an actual model.
pub async fn inspect_endpoint(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<EndpointInfo, String> {
    let base_url = normalize_base_url(base_url)?;
    let client = client()?;
    let models = tokio::time::timeout(INSPECT_TIMEOUT, models(&client, &base_url, api_key))
        .await
        .map_err(|_| "local model discovery timed out")??;
    Ok(EndpointInfo { base_url, models })
}

fn completion_text(bytes: &[u8], model: &str) -> Result<String, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "local server returned invalid completion JSON")?;
    if value.get("model").and_then(Value::as_str) != Some(model) {
        return Err("completion did not confirm the selected model identity".into());
    }
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .filter(|choices| choices.len() == 1)
        .ok_or("local completion did not contain one choice")?;
    let choice = &choices[0];
    if choice.pointer("/message/role").and_then(Value::as_str) != Some("assistant")
        || !choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| !reason.is_empty())
    {
        return Err("local completion was not a finished assistant message".into());
    }
    let text = choice
        .pointer("/message/content")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty() && text.len() <= OUTPUT_LIMIT)
        .ok_or("local completion did not generate bounded text")?;
    if value
        .pointer("/usage/completion_tokens")
        .and_then(Value::as_u64)
        == Some(0)
    {
        return Err("local completion reported no generated tokens".into());
    }
    Ok(text.to_string())
}

#[derive(Default)]
struct StreamCheck {
    pending: Vec<u8>,
    event_data: Vec<String>,
    output: String,
    total: usize,
    skip_lf: bool,
    started: bool,
    reported_completion_tokens: Option<u64>,
    finished: bool,
    done: bool,
}

impl StreamCheck {
    fn event(&mut self, model: &str) -> Result<(), String> {
        if self.event_data.is_empty() {
            return Ok(());
        }
        let data = self.event_data.join("\n");
        self.event_data.clear();
        if self.done {
            return Err("local stream contained data after its terminator".into());
        }
        if data == "[DONE]" {
            if !self.finished || self.output.trim().is_empty() {
                return Err("local stream ended before completed text generation".into());
            }
            if self.reported_completion_tokens == Some(0) {
                return Err("local stream reported no generated tokens".into());
            }
            self.done = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(&data)
            .map_err(|_| "local stream contained invalid completion JSON")?;
        if value.get("model").and_then(Value::as_str) != Some(model) {
            return Err("local stream did not confirm the selected model identity".into());
        }
        if let Some(tokens) = value
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64)
        {
            self.reported_completion_tokens = Some(tokens);
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or("local stream did not contain completion choices")?;
        if choices.is_empty() {
            // An optional final usage frame is metadata, never generated text.
            return Ok(());
        }
        if choices.len() != 1 || self.finished {
            return Err("local stream contained unexpected completion choices".into());
        }
        let choice = &choices[0];
        if let Some(role) = choice.pointer("/delta/role") {
            if role.as_str() != Some("assistant") {
                return Err("local stream did not generate an assistant message".into());
            }
        }
        if let Some(content) = choice.pointer("/delta/content").filter(|v| !v.is_null()) {
            let content = content
                .as_str()
                .ok_or("local stream generated non-text content")?;
            if self.output.len().saturating_add(content.len()) > OUTPUT_LIMIT {
                return Err("local verification stream generated too much text".into());
            }
            self.output.push_str(content);
        }
        if choice.get("finish_reason").is_some_and(|v| !v.is_null()) {
            if !choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .is_some_and(|reason| !reason.is_empty())
            {
                return Err("local stream returned an invalid finish reason".into());
            }
            self.finished = true;
        }
        Ok(())
    }

    fn line(&mut self, line: &[u8], model: &str) -> Result<(), String> {
        let line = if self.started {
            line
        } else {
            self.started = true;
            line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(line)
        };
        let line = std::str::from_utf8(line).map_err(|_| "local stream is not UTF-8")?;
        if line.is_empty() {
            return self.event(model);
        }
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.strip_prefix(' ').unwrap_or(data);
            let size: usize = self.event_data.iter().map(String::len).sum();
            if size.saturating_add(data.len()) > EVENT_LIMIT {
                return Err("local stream event exceeds 64 KiB".into());
            }
            self.event_data.push(data.to_string());
        }
        // Other SSE fields/comments are not completion data.
        Ok(())
    }

    fn push(&mut self, chunk: &[u8], model: &str) -> Result<(), String> {
        self.total = self.total.saturating_add(chunk.len());
        if self.total > RESPONSE_LIMIT {
            return Err("local verification stream exceeds 2 MiB".into());
        }
        for byte in chunk {
            if self.skip_lf && *byte == b'\n' {
                self.skip_lf = false;
                continue;
            }
            self.skip_lf = false;
            if matches!(*byte, b'\r' | b'\n') {
                let line = std::mem::take(&mut self.pending);
                self.line(&line, model)?;
                self.skip_lf = *byte == b'\r';
            } else {
                self.pending.push(*byte);
                if self.pending.len() > EVENT_LIMIT {
                    return Err("local stream line exceeds 64 KiB".into());
                }
            }
        }
        Ok(())
    }

    fn complete(mut self, model: &str) -> Result<String, String> {
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.line(&line, model)?;
        }
        self.event(model)?;
        if !self.done {
            return Err("local stream was interrupted before its terminator".into());
        }
        Ok(self.output)
    }
}

async fn stream(mut response: Response, model: &str) -> Result<String, String> {
    if !response.status().is_success() {
        return Err(format!(
            "local streaming request returned HTTP {}; connection is unverified",
            response.status().as_u16()
        ));
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/event-stream"))
        })
    {
        return Err("local server did not return an event stream".into());
    }
    let mut check = StreamCheck::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "local completion stream was interrupted")?
    {
        check.push(&chunk, model)?;
        // [DONE] is the application-level end. Drop the response here rather
        // than waiting forever for an otherwise valid keep-alive connection.
        if check.done {
            break;
        }
    }
    check.complete(model)
}

fn request_body(model: &str, streaming: bool) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [{"role":"user", "content":"What is 2 + 3? Reply with only the digit."}],
        "temperature": 0,
        "max_tokens": 32,
        "stream": streaming
    });
    if streaming {
        // The desktop chat client requests usage in this exact standard field.
        // Verify it too, so a server that rejects it cannot pass setup first.
        body["stream_options"] = json!({"include_usage":true});
    }
    body
}

/// Verify the selected, currently loaded model with two bounded inference
/// requests. All checks must succeed; callers must never turn an error into a
/// ready registration. Cancelling/dropping this future closes its HTTP work.
pub async fn verify(request: ProbeRequest) -> Result<Verification, String> {
    let base_url = normalize_base_url(&request.base_url)?;
    if !valid_model_id(&request.model) {
        return Err("select a valid discovered model before verification".into());
    }
    let client = client()?;
    tokio::time::timeout(VERIFY_TIMEOUT, async {
        let available = models(&client, &base_url, request.api_key.as_deref()).await?;
        if !available.iter().any(|model| model.id == request.model) {
            return Err("selected model is no longer listed by this server".into());
        }
        let endpoint = format!("{base_url}/chat/completions");
        let response = authenticated(
            client
                .post(&endpoint)
                .json(&request_body(&request.model, false)),
            request.api_key.as_deref(),
        )?
        .send()
        .await
        .map_err(|_| "local server did not answer text verification")?;
        let text = completion_text(&body(response).await?, &request.model)?;
        if text.trim() != "5" {
            return Err(
                "local model did not pass the short text sample; connection remains unverified"
                    .into(),
            );
        }
        let response = authenticated(
            client
                .post(&endpoint)
                .json(&request_body(&request.model, true)),
            request.api_key.as_deref(),
        )?
        .send()
        .await
        .map_err(|_| "local server did not answer streaming verification")?;
        let text = stream(response, &request.model).await?;
        if text.trim() != "5" {
            return Err(
                "local model did not pass the streaming text sample; connection remains unverified"
                    .into(),
            );
        }
        Ok(Verification {
            base_url,
            model: request.model,
            verified_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "system clock is before the Unix epoch")?
                .as_millis()
                .try_into()
                .map_err(|_| "system clock exceeds verification timestamp range")?,
            capabilities: VerifiedCapabilities {
                text_generation: true,
                streaming: true,
            },
            checks: vec![
                "model-listed".into(),
                "model-identity".into(),
                "text-sample".into(),
                "completed-event-stream".into(),
            ],
        })
    })
    .await
    .map_err(|_| "local inference verification timed out; connection remains unverified")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };

    const MODEL: &str = "synthetic-model";

    fn model_list() -> String {
        json!({"data":[{"id":MODEL}]}).to_string()
    }

    fn completion(model: &str, text: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "model":model,
            "choices":[{"message":{"role":"assistant","content":text},"finish_reason":"stop"}],
            "usage":{"completion_tokens":1}
        }))
        .unwrap()
    }

    fn events(model: &str) -> String {
        format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"model":model,"choices":[{"delta":{"role":"assistant","content":"5"},"finish_reason":null}]}),
            json!({"model":model,"choices":[{"delta":{},"finish_reason":"stop"}]})
        )
    }

    fn response(status: &str, kind: &str, data: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",
            data.len()
        )
        .into_bytes()
    }

    async fn server(responses: Vec<Vec<u8>>) -> (String, JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 4096];
                loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..n]);
                    assert!(request.len() <= 64 * 1024);
                    if let Some(headers_end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..headers_end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= headers_end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(request);
                socket.write_all(&response).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });
        (url, task)
    }

    #[test]
    fn automatic_urls_are_loopback_without_credentials_or_redirect_targets() {
        for valid in [
            "http://127.0.0.1:3210",
            "http://[::1]:3210/v1/",
            "https://localhost:3210/api/",
        ] {
            assert!(normalize_base_url(valid).unwrap().ends_with("/v1"));
        }
        for invalid in [
            "http://example.invalid:3210",
            "http://192.0.2.1:3210",
            "http://localhost.example.invalid",
            "file:///tmp/model",
            "http://user:password@localhost",
            "http://localhost?token=secret",
            "http://localhost/#fragment",
            "http://localhost/v1/models",
            "http://localhost/v1/chat/completions",
        ] {
            assert!(normalize_base_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn discovered_model_ids_are_opaque_deduplicated_and_bounded() {
        assert_eq!(
            parse_models(br#"{"data":[{"id":"unfamiliar/model"},{"id":"unfamiliar/model"},{"id":"another"}]}"#).unwrap(),
            vec![Model { id:"unfamiliar/model".into() }, Model { id:"another".into() }]
        );
        assert!(parse_models(br#"{"data":[]}"#).unwrap().is_empty());
        assert!(parse_models(br#"{"data":[{"id":""}]}"#).is_err());
        assert!(parse_models(br#"{"data":[{"id":"a\nb"}]}"#).is_err());
        assert!(parse_models(br#"{"models":["unsupported-shape"]}"#).is_err());
        assert!(parse_models(
            &serde_json::to_vec(&json!({"data":vec![json!({"id":"x"});MODEL_LIMIT+1]})).unwrap()
        )
        .is_err());
    }

    #[test]
    fn completion_confirms_model_finished_text_and_nonzero_reported_usage() {
        assert_eq!(
            completion_text(&completion(MODEL, "5"), MODEL).unwrap(),
            "5"
        );
        assert!(completion_text(&completion("other-model", "5"), MODEL).is_err());
        assert!(completion_text(&completion(MODEL, ""), MODEL).is_err());
        let mut value: Value = serde_json::from_slice(&completion(MODEL, "5")).unwrap();
        value["usage"]["completion_tokens"] = json!(0);
        assert!(completion_text(&serde_json::to_vec(&value).unwrap(), MODEL).is_err());
        value["usage"]["completion_tokens"] = json!(1);
        value["choices"][0]["finish_reason"] = Value::Null;
        assert!(completion_text(&serde_json::to_vec(&value).unwrap(), MODEL).is_err());
    }

    #[test]
    fn stream_handles_every_byte_boundary_and_all_sse_line_endings() {
        for ending in ["\n", "\r\n", "\r"] {
            let data =
                format!("\u{feff}: keepalive\n{}", events("모델-unknown")).replace('\n', ending);
            let mut check = StreamCheck::default();
            for byte in data.as_bytes() {
                check.push(&[*byte], "모델-unknown").unwrap();
            }
            assert_eq!(check.complete("모델-unknown").unwrap(), "5");
        }
    }

    #[test]
    fn stream_requires_finished_generation_then_terminator() {
        for invalid in [
            events(MODEL).replace("data: [DONE]\n\n", ""),
            "data: [DONE]\n\n".into(),
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"model":MODEL,"choices":[{"delta":{"content":"5"},"finish_reason":null}]})
            ),
            events("wrong-model"),
            "data: {\"error\":\"unavailable\"}\n\n".into(),
        ] {
            let mut check = StreamCheck::default();
            let result = check
                .push(invalid.as_bytes(), MODEL)
                .and_then(|()| check.complete(MODEL));
            assert!(result.is_err());
        }
    }

    #[test]
    fn stream_does_not_treat_reasoning_or_tool_arguments_as_text() {
        let mut check = StreamCheck::default();
        let data = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"model":MODEL,"choices":[{"delta":{"reasoning_content":"5","tool_calls":[{"function":{"arguments":"5"}}]},"finish_reason":"tool_calls"}]})
        );
        assert!(check.push(data.as_bytes(), MODEL).is_err());
    }

    #[test]
    fn stream_limits_unterminated_lines_events_and_output() {
        assert!(StreamCheck::default()
            .push(&vec![b'x'; EVENT_LIMIT + 1], MODEL)
            .is_err());
        let mut check = StreamCheck::default();
        let huge = format!(
            "data: {}\n\n",
            json!({"model":MODEL,"choices":[{"delta":{"content":"x".repeat(OUTPUT_LIMIT+1)}}]})
        );
        assert!(check.push(huge.as_bytes(), MODEL).is_err());
        let mut check = StreamCheck::default();
        let multiline = format!(
            "data: {}\ndata: {}\n",
            "x".repeat(EVENT_LIMIT / 2),
            "y".repeat(EVENT_LIMIT / 2 + 1)
        );
        assert!(check.push(multiline.as_bytes(), MODEL).is_err());
    }

    #[tokio::test]
    async fn inspection_lists_models_without_sending_an_inference_request() {
        let (url, task) = server(vec![response("200 OK", "application/json", &model_list())]).await;
        let info = inspect_endpoint(&url, None).await.unwrap();
        assert_eq!(info.models, vec![Model { id: MODEL.into() }]);
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with(b"GET /v1/models HTTP/1.1"));
    }

    #[tokio::test]
    async fn verification_exercises_both_real_protocol_forms_without_claiming_extra_capabilities() {
        let (url, task) = server(vec![
            response("200 OK", "application/json", &model_list()),
            response(
                "200 OK",
                "application/json",
                std::str::from_utf8(&completion(MODEL, "5")).unwrap(),
            ),
            response("200 OK", "text/event-stream; charset=utf-8", &events(MODEL)),
        ])
        .await;
        let result = verify(ProbeRequest {
            base_url: url,
            model: MODEL.into(),
            api_key: Some("synthetic-credential".into()),
        })
        .await
        .unwrap();
        assert!(result.capabilities.text_generation && result.capabilities.streaming);
        assert_eq!(result.model, MODEL);
        assert!(result.verified_at_unix_ms > 0);
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("synthetic-credential"));
        assert!(!serialized.contains("vision"));
        let requests = task.await.unwrap();
        for (index, request) in requests.iter().enumerate() {
            let request = std::str::from_utf8(request).unwrap();
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-credential"));
            if index > 0 {
                let body: Value =
                    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(body["model"], MODEL);
                assert_eq!(body["stream"], index == 2);
                if index == 2 {
                    assert_eq!(body["stream_options"], json!({"include_usage":true}));
                } else {
                    assert!(body.get("stream_options").is_none());
                }
                assert!(!body.as_object().unwrap().contains_key("tools"));
            }
        }
    }

    #[tokio::test]
    async fn missing_selected_model_stops_before_inference() {
        let (url, task) = server(vec![response(
            "200 OK",
            "application/json",
            "{\"data\":[]}",
        )])
        .await;
        let error = verify(ProbeRequest {
            base_url: url,
            model: MODEL.into(),
            api_key: None,
        })
        .await
        .unwrap_err();
        assert!(error.contains("no longer listed"));
        assert_eq!(task.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn incorrect_text_sample_never_becomes_verified() {
        let (url, task) = server(vec![
            response("200 OK", "application/json", &model_list()),
            response(
                "200 OK",
                "application/json",
                std::str::from_utf8(&completion(MODEL, "not 5")).unwrap(),
            ),
        ])
        .await;
        assert!(verify(ProbeRequest {
            base_url: url,
            model: MODEL.into(),
            api_key: None
        })
        .await
        .unwrap_err()
        .contains("sample"));
        assert_eq!(task.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn local_redirect_is_not_followed() {
        let (url, task) = server(vec![b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/v1/models\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()]).await;
        assert!(inspect_endpoint(&url, None)
            .await
            .unwrap_err()
            .contains("HTTP 302"));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_content_length_stops_without_reading_the_body() {
        let (url, task) = server(vec![format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", RESPONSE_LIMIT+1).into_bytes()]).await;
        assert!(inspect_endpoint(&url, None)
            .await
            .unwrap_err()
            .contains("exceeds"));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn discovery_deadline_covers_a_response_body_that_never_finishes() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{").await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let error = inspect_endpoint(&url, None).await.unwrap_err();
        assert!(error.contains("timed out"));
        fixture.abort();
    }

    #[tokio::test]
    async fn a_valid_done_event_does_not_wait_for_socket_close() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            let data = events(MODEL);
            socket
                .write_all(format!("{:x}\r\n{data}\r\n", data.len()).as_bytes())
                .await
                .unwrap();
            // Leave the HTTP body open: [DONE] is the completion boundary.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let response = client().unwrap().get(url).send().await.unwrap();
        let text = tokio::time::timeout(Duration::from_secs(1), stream(response, MODEL))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(text, "5");
        fixture.abort();
    }
}
