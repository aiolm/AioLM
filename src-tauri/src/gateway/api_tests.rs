//! End-to-end tests of the API listener against synthetic loopback upstreams.
//! No model process is started: every session is a `ServerState` marked ready
//! and pointed at a tiny in-process HTTP server.
use super::*;
use crate::server::{ErrBuf, Lifecycle, ServerState};
use crate::session::SessionManager;
use std::sync::Mutex;
use std::time::Instant;
use tokio::io::AsyncReadExt;

const EXTERNAL_KEY: &str = "sk-external-test-key";
const WAIT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn dropping_the_gateway_owner_releases_listener_and_open_connections() {
    for _ in 0..3 {
        let mut api = TestApi::start().await;
        let mut connection = TcpStream::connect(("127.0.0.1", api.port)).await.unwrap();
        connection
            .write_all(b"GET /v1/models HTTP/1.1\r\n")
            .await
            .unwrap();
        drop(api.handle.take());
        let mut byte = [0];
        let closed = tokio::time::timeout(WAIT, connection.read(&mut byte))
            .await
            .unwrap();
        assert!(matches!(closed, Ok(0) | Err(_)), "connection remained open");
        let listener = TcpListener::bind(("127.0.0.1", api.port))
            .await
            .expect("listener port must be released");
        drop(listener);
    }
}

async fn eventually(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !condition() {
        assert!(Instant::now() < deadline, "condition never became true");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[derive(Clone, Debug)]
struct Recorded {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Recorded {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

enum Chunk {
    Data(String),
    /// Hold the response open until the test releases it.
    Wait(Arc<Notify>),
}

struct Reply {
    status: u16,
    content_type: &'static str,
    with_length: bool,
    /// Hold the whole response, headers included, until the test releases it:
    /// a model that is still processing the prompt.
    before_head: Option<Arc<Notify>>,
    chunks: Vec<Chunk>,
}

impl Reply {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            with_length: true,
            before_head: None,
            chunks: vec![Chunk::Data(body.to_string())],
        }
    }

    fn sse(chunks: Vec<Chunk>) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            with_length: false,
            before_head: None,
            chunks,
        }
    }

    fn after(mut self, gate: Arc<Notify>) -> Self {
        self.before_head = Some(gate);
        self
    }
}

fn sse_data(value: Value) -> Chunk {
    Chunk::Data(format!("data: {value}\n\n"))
}

fn delta(text: &str) -> Chunk {
    sse_data(json!({"choices":[{"delta":{"content":text},"finish_reason":null}]}))
}

fn finish() -> Chunk {
    sse_data(
        json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}),
    )
}

fn done() -> Chunk {
    Chunk::Data("data: [DONE]\n\n".into())
}

fn completion(text: &str) -> Value {
    json!({"id":"chatcmpl-1","object":"chat.completion","model":"upstream","choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})
}

async fn write_reply(socket: &mut TcpStream, reply: Reply) -> std::io::Result<()> {
    if let Some(gate) = &reply.before_head {
        gate.notified().await;
    }
    let length = reply.chunks.iter().fold(0, |total, chunk| match chunk {
        Chunk::Data(text) => total + text.len(),
        Chunk::Wait(_) => total,
    });
    let mut head = format!(
        "HTTP/1.1 {} Synthetic\r\nContent-Type: {}\r\nConnection: close\r\n",
        reply.status, reply.content_type
    );
    if reply.with_length {
        head.push_str(&format!("Content-Length: {length}\r\n"));
    }
    head.push_str("\r\n");
    socket.write_all(head.as_bytes()).await?;
    for chunk in reply.chunks {
        match chunk {
            Chunk::Data(text) => {
                socket.write_all(text.as_bytes()).await?;
                socket.flush().await?;
            }
            Chunk::Wait(gate) => gate.notified().await,
        }
    }
    socket.shutdown().await
}

/// A synthetic stand-in for one llama-server process.
struct Upstream {
    url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    task: JoinHandle<()>,
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Upstream {
    async fn spawn(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(handler);
        let recorded = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let handler = handler.clone();
                let recorded = recorded.clone();
                tokio::spawn(async move {
                    let Ok(request) = read_request(&mut socket).await else {
                        return;
                    };
                    let request = Recorded {
                        method: request.method,
                        path: request.path,
                        headers: request.headers,
                        body: request.body,
                    };
                    let reply = handler(&request);
                    recorded.lock().unwrap().push(request);
                    let _ = write_reply(&mut socket, reply).await;
                });
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}/v1"),
            requests,
            task,
        }
    }

    async fn json(status: u16, body: Value) -> Self {
        Self::spawn(move |_| Reply::json(status, body.clone())).await
    }

    fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

/// An SSE upstream that sends `first`, waits for the returned gate, then
/// sends the rest of a normal completion.
async fn gated_stream(first: &str, rest: &str) -> (Upstream, Arc<Notify>) {
    let gate = Arc::new(Notify::new());
    let held = gate.clone();
    let (first, rest) = (first.to_string(), rest.to_string());
    let upstream = Upstream::spawn(move |_| {
        Reply::sse(vec![
            delta(&first),
            Chunk::Wait(held.clone()),
            delta(&rest),
            finish(),
            done(),
        ])
    })
    .await;
    (upstream, gate)
}

struct TestApi {
    port: u16,
    handle: Option<GatewayHandle>,
    default: Arc<Mutex<ServerState>>,
    sessions: Arc<SessionManager>,
    http: reqwest::Client,
}

#[tokio::test]
async fn python_engine_routes_apply_loaded_capabilities_and_keep_media_and_model_identity() {
    use crate::providers::{artifacts::Modalities, protocol::EngineInfo, ProviderId};
    for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
        let api = TestApi::start().await;
        let upstream = Upstream::json(200, completion("answer")).await;
        api.load_default(
            &upstream,
            "private-worker-key",
            "/synthetic/models/vision-model",
        );
        api.default.lock().unwrap().engine = Some(EngineInfo {
            provider,
            runtime_id: "synthetic-runtime".into(),
            runtime_variant: String::new(),
            speech_model_type: None,
            upstream_model: "loaded-model-alias".into(),
            modalities: Modalities {
                text: true,
                image: true,
                audio: true,
                video: false,
            },
            tasks: vec!["generate".into()],
            request_fields: json!({"temperature":0.3}).as_object().unwrap().clone(),
            request_lora: None,
            embedding_model: Some("loaded-embedding-alias".into()),
            embedding_namespace: Some("synthetic-revision".into()),
            tools_auto: true,
            tool_parser: true,
        });
        let request = json!({"model":"vision-model","messages":[{"role":"user","content":[
            {"type":"text","text":"describe"},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}},
            {"type":"input_audio","input_audio":{"data":"data:audio/wav;base64,AA=="}}
        ]}]});
        let response = api
            .post("/v1/chat/completions", &request)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{provider:?}");
        let seen = upstream.requests()[0].json();
        assert_eq!(seen["model"], "loaded-model-alias");
        assert_eq!(seen["temperature"], 0.3);
        assert_eq!(seen["messages"][0]["content"].as_array().unwrap().len(), 3);
        assert_eq!(
            seen["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AA=="
        );
        let response = api
            .post(
                "/v1/embeddings",
                &json!({"model":"vision-model","input":"document"}),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            upstream.requests()[1].json()["model"],
            "loaded-embedding-alias"
        );
        let response = api.post("/v1/chat/completions", &json!({"model":"vision-model","messages":[{"role":"user","content":[{"type":"video_url","video_url":{"url":"data:video/mp4;base64,AA=="}}]}]})).send().await.unwrap();
        assert_eq!(response.status(), 400);
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["error"]["code"], "unsupported_input");
        assert_eq!(
            upstream.count(),
            2,
            "unsupported input must not reach the engine"
        );
        assert_eq!(
            api.active(),
            0,
            "rejected requests release their model lease"
        );
    }
}

impl TestApi {
    async fn start() -> Self {
        let default = Arc::new(Mutex::new(ServerState::new()));
        let sessions = Arc::new(SessionManager::new());
        let models = ModelSource::new(
            default.clone(),
            Arc::new(ErrBuf::default()),
            sessions.clone(),
        );
        let handle = start(models, EXTERNAL_KEY.into(), 0).await.unwrap();
        Self {
            port: handle.port,
            handle: Some(handle),
            default,
            sessions,
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.get(self.url(path)).bearer_auth(EXTERNAL_KEY)
    }

    fn post(&self, path: &str, body: &Value) -> reqwest::RequestBuilder {
        self.http
            .post(self.url(path))
            .bearer_auth(EXTERNAL_KEY)
            .json(body)
    }

    fn post_messages(&self, body: &Value) -> reqwest::RequestBuilder {
        self.http
            .post(self.url("/v1/messages"))
            .header("x-api-key", EXTERNAL_KEY)
            .header("anthropic-version", "2023-06-01")
            .json(body)
    }

    async fn model_ids(&self) -> Vec<String> {
        let list: Value = self
            .get("/v1/models")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(list["object"], "list");
        list["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| {
                assert_eq!(model["object"], "model");
                model["id"].as_str().unwrap().to_string()
            })
            .collect()
    }

    fn load(target: &Arc<Mutex<ServerState>>, upstream: &Upstream, key: &str, model: &str) {
        let mut state = target.lock().unwrap();
        state.lifecycle = Lifecycle::Ready;
        state.url = upstream.url.clone();
        state.api_key = key.into();
        state.model = model.into();
    }

    fn load_default(&self, upstream: &Upstream, key: &str, model: &str) {
        Self::load(&self.default, upstream, key, model);
    }

    fn load_named(&self, id: &str, upstream: &Upstream, key: &str, model: &str) {
        let entry = self.sessions.get_or_create(id, model).unwrap();
        Self::load(&entry.state, upstream, key, model);
    }

    /// What stopping a session does to its state.
    fn unload(target: &Arc<Mutex<ServerState>>) {
        let mut state = target.lock().unwrap();
        state.lifecycle = Lifecycle::Stopped;
        state.url.clear();
        state.api_key.clear();
        state.model.clear();
        state.active_requests = 0;
    }

    fn active(&self) -> u32 {
        self.default.lock().unwrap().active_requests
    }

    async fn stop(&mut self) {
        stop(self.handle.take().unwrap()).await;
    }
}

async fn next_chunk(response: &mut reqwest::Response) -> Option<String> {
    tokio::time::timeout(WAIT, response.chunk())
        .await
        .expect("timed out waiting for a stream chunk")
        .unwrap()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

async fn drain(response: &mut reqwest::Response) -> String {
    let mut text = String::new();
    while let Some(chunk) = next_chunk(response).await {
        text.push_str(&chunk);
    }
    text
}

fn sse_events(text: &str) -> Vec<(String, Value)> {
    text.split("\n\n")
        .filter_map(|block| {
            let event = block
                .lines()
                .find_map(|line| line.strip_prefix("event: "))?;
            let data = block.lines().find_map(|line| line.strip_prefix("data: "))?;
            Some((event.to_string(), serde_json::from_str(data).ok()?))
        })
        .collect()
}

#[tokio::test]
async fn an_empty_server_lists_no_models_and_answers_inference_with_a_structured_503() {
    let api = TestApi::start().await;
    assert!(api.model_ids().await.is_empty());
    for (path, body) in [
        ("/v1/chat/completions", json!({"model":"m","messages":[]})),
        ("/v1/completions", json!({"model":"m","prompt":"hi"})),
        ("/v1/embeddings", json!({"model":"m","input":"hi"})),
        ("/v1/responses", json!({"model":"m","input":"hi"})),
    ] {
        let response = api.post(path, &body).send().await.unwrap();
        assert_eq!(response.status(), 503, "{path}");
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["error"]["code"], "model_not_loaded", "{path}");
        assert_eq!(error["error"]["type"], "server_error", "{path}");
        assert!(error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("load a model"));
    }
    let response = api
        .post_messages(
            &json!({"model":"m","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["type"], "overloaded_error");
}

#[tokio::test]
async fn a_model_that_is_still_loading_is_reported_as_loading_not_missing() {
    let api = TestApi::start().await;
    api.default.lock().unwrap().lifecycle = Lifecycle::Starting;
    assert!(api.model_ids().await.is_empty());
    let response = api
        .post("/v1/chat/completions", &json!({"model":"m","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "model_loading");
}

#[tokio::test]
async fn every_route_needs_the_external_key_and_worker_keys_are_refused() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, completion("hi")).await;
    api.load_default(&upstream, "worker-private-key", "m.gguf");
    let routes = [
        ("GET", "/v1/models"),
        ("POST", "/v1/chat/completions"),
        ("POST", "/v1/completions"),
        ("POST", "/v1/embeddings"),
        ("POST", "/v1/messages"),
        ("POST", "/v1/responses"),
        ("GET", "/v1/responses/resp_x"),
        ("DELETE", "/v1/responses/resp_x"),
        ("GET", "/v1/nothing-here"),
    ];
    for (method, path) in routes {
        let method: reqwest::Method = method.parse().unwrap();
        let attempts = [
            ("none", api.http.request(method.clone(), api.url(path))),
            (
                "wrong bearer",
                api.http
                    .request(method.clone(), api.url(path))
                    .bearer_auth("nope"),
            ),
            (
                "worker bearer",
                api.http
                    .request(method.clone(), api.url(path))
                    .bearer_auth("worker-private-key"),
            ),
            (
                "worker x-api-key",
                api.http
                    .request(method.clone(), api.url(path))
                    .header("x-api-key", "worker-private-key"),
            ),
            (
                "basic scheme",
                api.http
                    .request(method.clone(), api.url(path))
                    .header("authorization", format!("Basic {EXTERNAL_KEY}")),
            ),
        ];
        for (label, request) in attempts {
            let response = request.body("{}").send().await.unwrap();
            assert_eq!(response.status(), 401, "{method} {path} with {label}");
            let error: Value = response.json().await.unwrap();
            assert!(
                error["error"]["type"] == "authentication_error",
                "{method} {path}: {error}"
            );
        }
    }
    assert_eq!(upstream.count(), 0, "no rejected request may reach a model");
    assert_eq!(api.active(), 0);

    let bearer = api.get("/v1/models").send().await.unwrap();
    assert_eq!(bearer.status(), 200);
    let lowercase_scheme = api
        .http
        .get(api.url("/v1/models"))
        .header("authorization", format!("bearer {EXTERNAL_KEY}"))
        .send()
        .await
        .unwrap();
    assert_eq!(lowercase_scheme.status(), 200);
    let x_api_key = api
        .http
        .get(api.url("/v1/models"))
        .header("x-api-key", EXTERNAL_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(x_api_key.status(), 200);
}

#[tokio::test]
async fn models_load_unload_and_are_replaced_under_a_listener_that_keeps_running() {
    let api = TestApi::start().await;
    let first = Upstream::json(200, completion("from first")).await;
    let second = Upstream::json(200, completion("from second")).await;

    api.load_default(&first, "worker-1", "C:\\models\\first.gguf");
    assert_eq!(api.model_ids().await, ["first.gguf"]);
    let request = json!({"model":"first.gguf","messages":[{"role":"user","content":"hello"}],"temperature":0.2});
    let response = api
        .post("/v1/chat/completions", &request)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let answer: Value = response.json().await.unwrap();
    assert_eq!(answer["choices"][0]["message"]["content"], "from first");
    let seen = first.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("POST", "/v1/chat/completions")
    );
    assert_eq!(
        seen[0].json(),
        request,
        "the body must be relayed untouched"
    );
    assert_eq!(seen[0].headers["authorization"], "Bearer worker-1");
    assert!(!seen[0].headers["authorization"].contains(EXTERNAL_KEY));

    TestApi::unload(&api.default);
    assert!(api.model_ids().await.is_empty());
    let gone = api
        .post("/v1/chat/completions", &request)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 503);

    // A different model in the same slot is served by the very same listener.
    api.load_default(&second, "worker-2", "/models/second.gguf");
    assert_eq!(api.model_ids().await, ["second.gguf"]);
    let stale = api
        .post("/v1/chat/completions", &request)
        .send()
        .await
        .unwrap();
    assert_eq!(
        stale.status(),
        404,
        "the replaced model's name no longer routes"
    );
    let error: Value = stale.json().await.unwrap();
    assert_eq!(error["error"]["code"], "model_not_found");
    let fresh = json!({"model":"second.gguf","messages":[]});
    let answer: Value = api
        .post("/v1/chat/completions", &fresh)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(answer["choices"][0]["message"]["content"], "from second");
    assert_eq!(first.count(), 1, "nothing may reach the unloaded model");
    assert_eq!(
        second.requests()[0].headers["authorization"],
        "Bearer worker-2"
    );

    // Replacing in place, with no unload in between, is picked up on the next request.
    api.load_default(&first, "worker-3", "/models/first.gguf");
    assert_eq!(api.model_ids().await, ["first.gguf"]);
    api.post("/v1/chat/completions", &request)
        .send()
        .await
        .unwrap();
    assert_eq!(
        first.requests()[1].headers["authorization"],
        "Bearer worker-3"
    );
    assert_eq!(second.count(), 1);
}

#[tokio::test]
async fn completions_and_embeddings_are_relayed_to_their_own_endpoints() {
    let api = TestApi::start().await;
    let upstream = Upstream::spawn(|request| match request.path.as_str() {
        "/v1/completions" => Reply::json(
            200,
            json!({"object":"text_completion","choices":[{"text":"t"}]}),
        ),
        "/v1/embeddings" => Reply::json(200, json!({"object":"list","data":[{"embedding":[0.5]}]})),
        _ => Reply::json(404, json!({"error":"unexpected"})),
    })
    .await;
    api.load_default(&upstream, "worker", "embed.gguf");
    let text: Value = api
        .post(
            "/v1/completions",
            &json!({"model":"embed.gguf","prompt":"hi"}),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(text["choices"][0]["text"], "t");
    let vectors: Value = api
        .post(
            "/v1/embeddings",
            &json!({"model":"embed.gguf","input":"hi"}),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(vectors["data"][0]["embedding"][0], 0.5);
    let paths: Vec<String> = upstream.requests().into_iter().map(|r| r.path).collect();
    assert_eq!(paths, ["/v1/completions", "/v1/embeddings"]);
}

#[tokio::test]
async fn requests_reach_the_session_named_by_their_model_and_ambiguity_is_never_guessed() {
    let api = TestApi::start().await;
    let default = Upstream::json(200, completion("default")).await;
    let alpha = Upstream::json(200, completion("alpha")).await;
    let beta = Upstream::json(200, completion("beta")).await;
    api.load_default(&default, "k-default", "/m/base.gguf");
    api.load_named("s-alpha", &alpha, "k-alpha", "/m/alpha.gguf");
    api.load_named("s-beta", &beta, "k-beta", "/other/beta.gguf");
    assert_eq!(
        api.model_ids().await,
        ["alpha.gguf", "base.gguf", "beta.gguf"]
    );
    let ask = |model: Option<&str>| {
        let mut body = json!({"messages":[{"role":"user","content":"hi"}]});
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        api.post("/v1/chat/completions", &body)
    };
    async fn said(response: reqwest::RequestBuilder) -> String {
        let response = response.send().await.unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap()
            .to_string()
    }
    assert_eq!(said(ask(Some("alpha.gguf"))).await, "alpha");
    assert_eq!(said(ask(Some("beta.gguf"))).await, "beta");
    assert_eq!(said(ask(Some("base.gguf"))).await, "default");
    assert_eq!(
        said(ask(None)).await,
        "default",
        "no model means the default session"
    );

    let missing = ask(Some("gamma.gguf")).send().await.unwrap();
    assert_eq!(missing.status(), 404);
    let error: Value = missing.json().await.unwrap();
    assert_eq!(error["error"]["code"], "model_not_found");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("alpha.gguf"));

    // The same file loaded twice: both stay reachable, neither by the bare name.
    let twin = Upstream::json(200, completion("twin")).await;
    api.load_named("s-twin", &twin, "k-twin", "/elsewhere/alpha.gguf");
    assert_eq!(
        api.model_ids().await,
        [
            "alpha.gguf@s-alpha",
            "alpha.gguf@s-twin",
            "base.gguf",
            "beta.gguf"
        ]
    );
    let before = (alpha.count(), twin.count());
    let ambiguous = ask(Some("alpha.gguf")).send().await.unwrap();
    assert_eq!(ambiguous.status(), 400);
    let error: Value = ambiguous.json().await.unwrap();
    assert_eq!(error["error"]["code"], "ambiguous_model");
    let message = error["error"]["message"].as_str().unwrap();
    assert!(message.contains("alpha.gguf@s-alpha") && message.contains("alpha.gguf@s-twin"));
    assert_eq!(
        (alpha.count(), twin.count()),
        before,
        "nothing may be sent anywhere"
    );
    assert_eq!(said(ask(Some("alpha.gguf@s-twin"))).await, "twin");
    assert_eq!(said(ask(Some("alpha.gguf@s-alpha"))).await, "alpha");

    // Losing the default session leaves several models and no default.
    TestApi::unload(&api.default);
    let required = ask(None).send().await.unwrap();
    assert_eq!(required.status(), 400);
    let error: Value = required.json().await.unwrap();
    assert_eq!(error["error"]["code"], "model_required");
}

#[tokio::test]
async fn an_sse_stream_is_relayed_as_it_arrives_and_pins_its_model_until_it_ends() {
    let api = TestApi::start().await;
    let (upstream, gate) = gated_stream("Hel", "lo").await;
    api.load_default(&upstream, "worker", "m.gguf");
    let mut response = api
        .post(
            "/v1/chat/completions",
            &json!({"model":"m.gguf","stream":true,"messages":[]}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    assert_eq!(response.headers()["cache-control"], "no-cache");

    // The first chunk is delivered while the upstream is still mid-response.
    let first = next_chunk(&mut response).await.unwrap();
    assert!(first.contains("Hel") && !first.contains("lo\""), "{first}");
    {
        let state = api.default.lock().unwrap();
        assert_eq!(state.active_requests, 1);
        // The condition the model lifecycle uses to refuse unload and replacement.
        assert!(state.lifecycle.blocks_resource_change() && state.active_requests > 0);
    }

    gate.notify_one();
    let rest = drain(&mut response).await;
    assert!(
        rest.contains("lo") && rest.contains("\"finish_reason\":\"stop\""),
        "{rest}"
    );
    assert!(rest.trim_end().ends_with("data: [DONE]"), "{rest}");
    eventually(|| api.active() == 0).await;
}

#[tokio::test]
async fn a_finished_stream_of_a_replaced_model_never_uncounts_the_new_models_request() {
    let api = TestApi::start().await;
    let (old, old_gate) = gated_stream("old", " done").await;
    let (new, new_gate) = gated_stream("new", " done").await;
    let body = json!({"model":"m.gguf","stream":true,"messages":[]});

    api.load_default(&old, "worker-old", "m.gguf");
    let mut first = api
        .post("/v1/chat/completions", &body)
        .send()
        .await
        .unwrap();
    next_chunk(&mut first).await.unwrap();
    assert_eq!(api.active(), 1);

    // The model is stopped and replaced while that response is still open.
    TestApi::unload(&api.default);
    api.load_default(&new, "worker-new", "m.gguf");
    let mut second = api
        .post("/v1/chat/completions", &body)
        .send()
        .await
        .unwrap();
    assert!(next_chunk(&mut second).await.unwrap().contains("new"));
    assert_eq!(api.active(), 1);

    old_gate.notify_one();
    drain(&mut first).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        api.active(),
        1,
        "the new model is still serving its request"
    );

    new_gate.notify_one();
    drain(&mut second).await;
    eventually(|| api.active() == 0).await;
}

#[tokio::test]
async fn concurrent_requests_are_counted_on_the_session_that_serves_them() {
    let api = TestApi::start().await;
    let (default_upstream, default_gate) = gated_stream("a", "b").await;
    let (named_upstream, named_gate) = gated_stream("c", "d").await;
    api.load_default(&default_upstream, "k1", "one.gguf");
    api.load_named("s2", &named_upstream, "k2", "two.gguf");
    let named_state = api.sessions.get("s2").unwrap().state.clone();
    let stream = |model: &str| {
        api.post(
            "/v1/chat/completions",
            &json!({"model":model,"stream":true,"messages":[]}),
        )
        .send()
    };
    let mut on_default = stream("one.gguf").await.unwrap();
    let mut on_named_a = stream("two.gguf").await.unwrap();
    let mut on_named_b = stream("two.gguf").await.unwrap();
    for response in [&mut on_default, &mut on_named_a, &mut on_named_b] {
        next_chunk(response).await.unwrap();
    }
    assert_eq!(api.active(), 1);
    assert_eq!(named_state.lock().unwrap().active_requests, 2);

    default_gate.notify_one();
    drain(&mut on_default).await;
    eventually(|| api.active() == 0).await;
    assert_eq!(named_state.lock().unwrap().active_requests, 2);

    named_gate.notify_one();
    named_gate.notify_one();
    drain(&mut on_named_a).await;
    drain(&mut on_named_b).await;
    eventually(|| named_state.lock().unwrap().active_requests == 0).await;
}

#[tokio::test]
async fn upstream_errors_keep_their_status_and_body() {
    let api = TestApi::start().await;
    let refusal = json!({"error":{"message":"slow down","type":"rate_limit_error","code":"busy"}});
    let upstream = Upstream::json(429, refusal.clone()).await;
    api.load_default(&upstream, "worker", "m.gguf");
    let chat = api
        .post(
            "/v1/chat/completions",
            &json!({"model":"m.gguf","messages":[]}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(chat.status(), 429);
    assert_eq!(chat.headers()["content-type"], "application/json");
    assert_eq!(chat.json::<Value>().await.unwrap(), refusal);

    let messages = api
        .post_messages(
            &json!({"model":"m.gguf","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(messages.status(), 429);
    let error: Value = messages.json().await.unwrap();
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["type"], "api_error");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("slow down"));

    let responses = api
        .post("/v1/responses", &json!({"model":"m.gguf","input":"hi"}))
        .send()
        .await
        .unwrap();
    assert_eq!(responses.status(), 429);
    let error: Value = responses.json().await.unwrap();
    assert_eq!(error["error"]["type"], "api_error");
    eventually(|| api.active() == 0).await;
}

#[tokio::test]
async fn an_unreachable_model_process_is_a_502_that_hides_its_private_port() {
    let api = TestApi::start().await;
    let unused = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = unused.local_addr().unwrap().port();
    drop(unused);
    {
        let mut state = api.default.lock().unwrap();
        state.lifecycle = Lifecycle::Ready;
        state.url = format!("http://127.0.0.1:{port}/v1");
        state.api_key = "worker-private-key".into();
        state.model = "m.gguf".into();
    }
    let response = api
        .post(
            "/v1/chat/completions",
            &json!({"model":"m.gguf","messages":[]}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    let text = response.text().await.unwrap();
    assert!(text.contains("upstream_unavailable"), "{text}");
    assert!(!text.contains(&port.to_string()), "{text}");
    assert!(!text.contains("worker-private-key"), "{text}");
    eventually(|| api.active() == 0).await;
}

#[tokio::test]
async fn stopping_the_api_closes_open_streams_and_releases_them_without_touching_the_model() {
    let mut api = TestApi::start().await;
    let (upstream, _never_released) = gated_stream("partial", "unreachable").await;
    api.load_default(&upstream, "worker-key", "m.gguf");
    let mut response = api
        .post(
            "/v1/chat/completions",
            &json!({"model":"m.gguf","stream":true,"messages":[]}),
        )
        .send()
        .await
        .unwrap();
    next_chunk(&mut response).await.unwrap();
    assert_eq!(api.active(), 1);

    tokio::time::timeout(WAIT, api.stop())
        .await
        .expect("stopping the API must not wait for the stream");

    let mut seen = String::new();
    let ended = tokio::time::timeout(WAIT, async {
        while let Ok(Some(chunk)) = response.chunk().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
    })
    .await;
    assert!(ended.is_ok(), "the open stream must be closed");
    assert!(
        !seen.contains("[DONE]"),
        "the stream must not look complete"
    );
    assert!(
        TcpStream::connect(("127.0.0.1", api.port)).await.is_err(),
        "the port must be free"
    );
    eventually(|| api.active() == 0).await;
    let state = api.default.lock().unwrap();
    assert_eq!(state.lifecycle, Lifecycle::Ready);
    assert_eq!(state.model, "m.gguf");
    assert_eq!(state.api_key, "worker-key");
    assert_eq!(state.url, upstream.url);
}

#[tokio::test]
async fn malformed_requests_are_refused_with_a_status_before_they_reach_a_model() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, completion("hi")).await;
    api.load_default(&upstream, "worker", "m.gguf");
    for path in [
        "/v1/chat/completions",
        "/v1/completions",
        "/v1/embeddings",
        "/v1/responses",
    ] {
        let invalid = api
            .http
            .post(api.url(path))
            .bearer_auth(EXTERNAL_KEY)
            .body("{not json")
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), 400, "{path}");
        let error: Value = invalid.json().await.unwrap();
        assert_eq!(error["error"]["type"], "invalid_request_error", "{path}");

        let not_object = api.post(path, &json!([1, 2])).send().await.unwrap();
        assert_eq!(not_object.status(), 400, "{path}");
        let bad_model = api
            .post(path, &json!({"model":7,"input":"x"}))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_model.status(), 400, "{path}");
        let error: Value = bad_model.json().await.unwrap();
        assert_eq!(error["error"]["param"], "model", "{path}");
    }

    let no_version = api
        .http
        .post(api.url("/v1/messages"))
        .header("x-api-key", EXTERNAL_KEY)
        .json(&json!({"model":"m.gguf","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(no_version.status(), 400);
    let error: Value = no_version.json().await.unwrap();
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["type"], "invalid_request_error");
    let bad_messages = api
        .post_messages(&json!({"model":"m.gguf","max_tokens":8}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_messages.status(), 400);

    let unknown = api.get("/v1/nothing").send().await.unwrap();
    assert_eq!(unknown.status(), 404);
    let wrong_method = api.get("/v1/chat/completions").send().await.unwrap();
    assert_eq!(wrong_method.status(), 405);
    let wrong_method = api
        .http
        .delete(api.url("/v1/models"))
        .bearer_auth(EXTERNAL_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_method.status(), 405);

    assert_eq!(upstream.count(), 0);
    assert_eq!(api.active(), 0);
}

#[tokio::test]
async fn an_oversized_or_chunked_request_gets_an_error_instead_of_a_dropped_connection() {
    let api = TestApi::start().await;
    for (head, expected) in [
        (
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nAuthorization: Bearer {EXTERNAL_KEY}\r\nContent-Length: {}\r\n\r\n",
                http::MAX_BODY + 1
            ),
            "413",
        ),
        (
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nAuthorization: Bearer {EXTERNAL_KEY}\r\nTransfer-Encoding: chunked\r\n\r\n"
            ),
            "411",
        ),
    ] {
        let mut socket = TcpStream::connect(("127.0.0.1", api.port)).await.unwrap();
        socket.write_all(head.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(WAIT, socket.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.starts_with(&format!("HTTP/1.1 {expected} ")), "{response}");
        assert!(response.contains("\"error\""), "{response}");
    }
}

#[tokio::test]
async fn anthropic_messages_are_translated_on_the_same_listener() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, completion("ok")).await;
    api.load_default(&upstream, "worker", "claude-local.gguf");
    let response = api
        .post_messages(&json!({
            "model":"claude-local.gguf","max_tokens":16,"system":"be brief",
            "messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let message: Value = response.json().await.unwrap();
    assert_eq!(message["type"], "message");
    assert_eq!(message["content"][0]["text"], "ok");
    assert_eq!(message["stop_reason"], "end_turn");
    assert_eq!(message["usage"]["input_tokens"], 3);
    let seen = &upstream.requests()[0];
    assert_eq!(seen.path, "/v1/chat/completions");
    assert_eq!(seen.headers["authorization"], "Bearer worker");
    let translated = seen.json();
    assert_eq!(
        translated["messages"][0],
        json!({"role":"system","content":"be brief"})
    );
    assert_eq!(translated["messages"][1]["content"], "hi");
    assert_eq!(translated["model"], "claude-local.gguf");
}

#[tokio::test]
async fn anthropic_streams_are_translated_event_by_event() {
    let api = TestApi::start().await;
    let upstream =
        Upstream::spawn(|_| Reply::sse(vec![delta("Hel"), delta("lo"), finish(), done()])).await;
    api.load_default(&upstream, "worker", "m.gguf");
    let mut response = api
        .post_messages(&json!({
            "model":"m.gguf","max_tokens":16,"stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let events = sse_events(&drain(&mut response).await);
    let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]
    );
    assert_eq!(events[2].1["delta"]["text"], "Hel");
    assert_eq!(events[5].1["delta"]["stop_reason"], "end_turn");
    eventually(|| api.active() == 0).await;
}

#[tokio::test]
async fn responses_keep_their_history_and_stream_on_the_same_listener() {
    let api = TestApi::start().await;
    let upstream = Upstream::spawn(|request| {
        if request.json()["stream"] == true {
            Reply::sse(vec![delta("Hel"), delta("lo"), finish(), done()])
        } else {
            Reply::json(200, completion("done"))
        }
    })
    .await;
    api.load_default(&upstream, "worker", "m.gguf");

    let first: Value = api
        .post("/v1/responses", &json!({"model":"m.gguf","input":"one"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["object"], "response");
    assert_eq!(first["output_text"], "done");
    let first_id = first["id"].as_str().unwrap().to_string();

    let second: Value = api
        .post(
            "/v1/responses",
            &json!({"model":"m.gguf","input":"two","previous_response_id":first_id}),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let history = upstream.requests()[1].json()["messages"].clone();
    assert_eq!(
        history,
        json!([
            {"role":"user","content":"one"},
            {"role":"assistant","content":"done"},
            {"role":"user","content":"two"}
        ])
    );
    let fetched: Value = api
        .get(&format!("/v1/responses/{}", second["id"].as_str().unwrap()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(fetched["id"], second["id"]);

    let mut streamed = api
        .post(
            "/v1/responses",
            &json!({"model":"m.gguf","input":"three","stream":true}),
        )
        .send()
        .await
        .unwrap();
    let events = sse_events(&drain(&mut streamed).await);
    let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "response.created",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.completed"
        ]
    );
    assert_eq!(events[3].1["response"]["output_text"], "Hello");
    let streamed_id = events[3].1["response"]["id"].as_str().unwrap();
    assert_eq!(
        api.get(&format!("/v1/responses/{streamed_id}"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    let removed = api
        .http
        .delete(api.url(&format!("/v1/responses/{streamed_id}")))
        .bearer_auth(EXTERNAL_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 200);
    assert_eq!(
        api.get(&format!("/v1/responses/{streamed_id}"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let unknown_history = api
        .post(
            "/v1/responses",
            &json!({"model":"m.gguf","input":"x","previous_response_id":"resp_missing"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(unknown_history.status(), 404);
    eventually(|| api.active() == 0).await;
}

#[tokio::test]
async fn a_caller_without_the_key_is_refused_before_its_body_is_read() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, completion("hi")).await;
    api.load_default(&upstream, "worker", "m.gguf");

    // Far more than a socket buffer holds: the refusal must still arrive intact.
    let response = api
        .http
        .post(api.url("/v1/chat/completions"))
        .body("x".repeat(3 * 1024 * 1024))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    // A curl-style caller is never invited to send the body at all.
    let mut socket = TcpStream::connect(("127.0.0.1", api.port)).await.unwrap();
    socket
        .write_all(
            b"POST /v1/chat/completions HTTP/1.1\r\nExpect: 100-continue\r\nContent-Length: 1000000\r\n\r\n",
        )
        .await
        .unwrap();
    let mut answer = String::new();
    tokio::time::timeout(WAIT, socket.read_to_string(&mut answer))
        .await
        .unwrap()
        .unwrap();
    assert!(answer.starts_with("HTTP/1.1 401 "), "{answer}");
    assert!(!answer.contains("100 Continue"), "{answer}");

    // With the key, the same Expect handshake lets the body through.
    let mut socket = TcpStream::connect(("127.0.0.1", api.port)).await.unwrap();
    let body = json!({"model":"m.gguf","messages":[]}).to_string();
    socket
        .write_all(
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nAuthorization: Bearer {EXTERNAL_KEY}\r\nExpect: 100-continue\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut interim = [0_u8; 25];
    tokio::time::timeout(WAIT, socket.read_exact(&mut interim))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&interim, b"HTTP/1.1 100 Continue\r\n\r\n");
    socket.write_all(body.as_bytes()).await.unwrap();
    let mut answer = String::new();
    tokio::time::timeout(WAIT, socket.read_to_string(&mut answer))
        .await
        .unwrap()
        .unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 "), "{answer}");
    assert_eq!(
        upstream.count(),
        1,
        "only the authorised request got through"
    );
}

fn request_for(api: &TestApi, route: &str, stream: bool) -> reqwest::RequestBuilder {
    match route {
        "chat" => api.post(
            "/v1/chat/completions",
            &json!({"model":"m.gguf","stream":stream,"messages":[]}),
        ),
        "messages" => api.post_messages(&json!({
            "model":"m.gguf","max_tokens":8,"stream":stream,
            "messages":[{"role":"user","content":"hi"}]
        })),
        _ => api.post(
            "/v1/responses",
            &json!({"model":"m.gguf","stream":stream,"input":"hi"}),
        ),
    }
}

async fn released(api: &TestApi, route: &str) {
    let deadline = Instant::now() + WAIT;
    while api.active() != 0 {
        assert!(
            Instant::now() < deadline,
            "{route}: the cancelled request still holds its model"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_client_that_gives_up_before_the_model_answers_releases_its_lease() {
    for route in ["chat", "messages", "responses"] {
        let api = TestApi::start().await;
        let gate = Arc::new(Notify::new());
        let held = gate.clone();
        let upstream =
            Upstream::spawn(move |_| Reply::json(200, completion("late")).after(held.clone()))
                .await;
        api.load_default(&upstream, "worker", "m.gguf");
        let call = tokio::spawn(request_for(&api, route, false).send());
        eventually(|| upstream.count() == 1).await;
        assert_eq!(api.active(), 1, "{route}: the model is busy with it");

        // The client hangs up while the model is still processing the prompt.
        call.abort();
        released(&api, route).await;
    }
}

#[tokio::test]
async fn a_client_that_leaves_between_stream_chunks_releases_its_lease() {
    for route in ["chat", "messages", "responses"] {
        let api = TestApi::start().await;
        let (upstream, _held_back) = gated_stream("first", "never sent").await;
        api.load_default(&upstream, "worker", "m.gguf");
        let mut response = request_for(&api, route, true).send().await.unwrap();
        next_chunk(&mut response).await.unwrap();
        assert_eq!(api.active(), 1, "{route}: the stream is open");

        // The model is silent (prefill, a long thought); the client walks away.
        drop(response);
        released(&api, route).await;
    }
}

#[tokio::test]
async fn the_apps_own_origin_may_preflight_without_the_key_and_other_origins_get_nothing() {
    let api = TestApi::start().await;
    let preflight = |origin: &str| {
        api.http
            .request(reqwest::Method::OPTIONS, api.url("/v1/models"))
            .header("origin", origin.to_string())
            .header("access-control-request-method", "GET")
            .header(
                "access-control-request-headers",
                "authorization,content-type",
            )
    };
    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
    ] {
        let response = preflight(origin).send().await.unwrap();
        assert_eq!(response.status(), 204, "{origin}");
        assert_eq!(response.headers()["access-control-allow-origin"], origin);
        assert_eq!(
            response.headers()["access-control-allow-headers"],
            "authorization,content-type"
        );
        assert!(response.headers()["access-control-allow-methods"]
            .to_str()
            .unwrap()
            .contains("POST"));
        assert_eq!(response.headers()["vary"], "Origin");
    }
    for origin in [
        "https://evil.example",
        "http://localhost:3000",
        "null",
        "http://tauri.localhost.evil.example",
    ] {
        let response = preflight(origin).send().await.unwrap();
        assert_eq!(response.status(), 204, "{origin}");
        assert!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_none(),
            "{origin} must not be granted access"
        );
    }
    // A plain OPTIONS that is not a preflight still needs the key.
    let plain = api
        .http
        .request(reqwest::Method::OPTIONS, api.url("/v1/models"))
        .send()
        .await
        .unwrap();
    assert_eq!(plain.status(), 401);
}

#[tokio::test]
async fn cors_headers_accompany_every_kind_of_response_to_the_apps_origin_only() {
    let api = TestApi::start().await;
    let upstream = Upstream::spawn(|request| {
        if request.json()["stream"] == true {
            Reply::sse(vec![delta("Hi"), finish(), done()])
        } else {
            Reply::json(200, completion("ok"))
        }
    })
    .await;
    api.load_default(&upstream, "worker", "m.gguf");
    let app = "http://tauri.localhost";
    let granted = |response: &reqwest::Response| {
        response
            .headers()
            .get("access-control-allow-origin")
            .map(|value| value.to_str().unwrap().to_string())
    };

    let listed = api
        .get("/v1/models")
        .header("origin", app)
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), 200);
    assert_eq!(granted(&listed).as_deref(), Some(app));

    // A refusal must be readable by the page that was refused.
    let refused = api
        .http
        .get(api.url("/v1/models"))
        .header("origin", app)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 401);
    assert_eq!(granted(&refused).as_deref(), Some(app));

    let unknown = api
        .post(
            "/v1/chat/completions",
            &json!({"model":"nope","messages":[]}),
        )
        .header("origin", app)
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);
    assert_eq!(granted(&unknown).as_deref(), Some(app));

    for (route, stream) in [
        ("chat", false),
        ("chat", true),
        ("messages", false),
        ("messages", true),
        ("responses", false),
        ("responses", true),
    ] {
        let mut response = request_for(&api, route, stream)
            .header("origin", app)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{route} stream={stream}");
        assert_eq!(
            granted(&response).as_deref(),
            Some(app),
            "{route} stream={stream}"
        );
        drain(&mut response).await;
    }

    let foreign = api
        .get("/v1/models")
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 200, "the key still opens the API");
    assert!(granted(&foreign).is_none());
    let no_origin = api.get("/v1/models").send().await.unwrap();
    assert!(granted(&no_origin).is_none());
}

// Synthetic audio-transcription coverage. Every session below is a ready
// `ServerState` pointed at an in-process loopback upstream; no engine,
// Python or device is used. `EngineInfo` fixtures only carry the verified
// task lists (Whisper `transcription`+`translate`, Qwen3-ASR `transcription`
// only) so the protocol adapter can be exercised through the gateway.

const AUDIO_BOUNDARY: &str = "testaudioboundary123";

fn stt_engine(tasks: &[&str], upstream_model: &str) -> crate::providers::protocol::EngineInfo {
    crate::providers::protocol::EngineInfo {
        provider: crate::providers::ProviderId::Vllm,
        runtime_id: "synthetic-runtime".into(),
        runtime_variant: String::new(),
        speech_model_type: None,
        upstream_model: upstream_model.into(),
        modalities: crate::providers::artifacts::Modalities::default(),
        tasks: tasks.iter().map(|task| task.to_string()).collect(),
        request_fields: serde_json::Map::new(),
        request_lora: None,
        embedding_model: None,
        embedding_namespace: None,
        tools_auto: false,
        tool_parser: false,
    }
}

fn install_stt_engine(target: &Arc<Mutex<ServerState>>, tasks: &[&str], upstream_model: &str) {
    target.lock().unwrap().engine = Some(stt_engine(tasks, upstream_model));
}

fn audio_body(boundary: &str, fields: &[(&str, &str)], file_bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(file_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn post_audio(
    api: &TestApi,
    endpoint: &str,
    boundary: &str,
    body: Vec<u8>,
) -> reqwest::RequestBuilder {
    api.http
        .post(api.url(endpoint))
        .bearer_auth(EXTERNAL_KEY)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
}

fn parse_upstream_form(recorded: &Recorded) -> serde_json::Map<String, Value> {
    let content_type = recorded
        .headers
        .get("content-type")
        .expect("upstream content-type");
    super::multipart::AudioForm::parse(content_type, &recorded.body)
        .expect("upstream form parses")
        .fields
}

fn body_contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn synthetic_audio(bytes: &[u8]) -> crate::media::OwnedAudio {
    crate::media::OwnedAudio {
        filename: "clip.wav".into(),
        mime: "audio/wav",
        bytes: bytes.to_vec(),
    }
}

fn native_models(api: &TestApi) -> ModelSource {
    ModelSource::new(
        api.default.clone(),
        Arc::new(ErrBuf::default()),
        api.sessions.clone(),
    )
}

#[tokio::test]
async fn audio_transcription_rewrites_public_alias_and_preserves_binary_and_timestamps() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, json!({"text": "hello synthetic"})).await;
    api.load_default(&upstream, "private-stt-key", "/synthetic/stt.gguf");
    install_stt_engine(
        &api.default,
        &["transcription", "translate"],
        "synthetic-stt-private",
    );
    let audio: &[u8] = b"RIFF\x00\xff\xfe synthetic-audio \r\n--testaudioboundary123-nearly";
    let body = audio_body(
        AUDIO_BOUNDARY,
        &[
            ("model", "stt.gguf"),
            ("language", "en"),
            ("response_format", "json"),
            ("temperature", "0.0"),
            ("timestamp_granularities[]", "word"),
            ("timestamp_granularities[]", "segment"),
        ],
        audio,
    );
    let response = post_audio(&api, "/v1/audio/transcriptions", AUDIO_BOUNDARY, body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let transcript: Value = response.json().await.unwrap();
    assert_eq!(transcript["text"], "hello synthetic");
    assert_eq!(upstream.count(), 1);
    let recorded = upstream.requests().pop().unwrap();
    assert_eq!(
        (recorded.method.as_str(), recorded.path.as_str()),
        ("POST", "/v1/audio/transcriptions")
    );
    assert_eq!(
        recorded.headers.get("authorization").map(String::as_str),
        Some("Bearer private-stt-key")
    );
    assert!(
        !recorded.headers["authorization"].contains(EXTERNAL_KEY),
        "the external key must never travel upstream"
    );
    let fields = parse_upstream_form(&recorded);
    assert_eq!(
        fields["model"],
        json!("synthetic-stt-private"),
        "the public alias must be rewritten"
    );
    assert_eq!(fields["language"], json!("en"));
    assert_eq!(
        fields["timestamp_granularities"],
        json!(["word", "segment"]),
        "repeated timestamp fields travel as one array"
    );
    assert!(
        body_contains(&recorded.body, audio),
        "binary file bytes must travel unchanged"
    );
    assert_eq!(api.active(), 0, "the audio lease must be released");
}

#[tokio::test]
async fn audio_requests_route_to_the_selected_ready_session_with_its_private_key() {
    let api = TestApi::start().await;
    let default_upstream = Upstream::json(200, json!({"text": "base"})).await;
    let named_upstream = Upstream::json(200, json!({"text": "named"})).await;
    api.load_default(&default_upstream, "k-default-private", "/m/base.gguf");
    api.load_named(
        "s-stt",
        &named_upstream,
        "k-named-private",
        "/m/stt-named.gguf",
    );
    install_stt_engine(
        &api.default,
        &["transcription", "translate"],
        "private-base",
    );
    let named_state = api.sessions.get("s-stt").unwrap().state.clone();
    install_stt_engine(
        &named_state,
        &["transcription", "translate"],
        "private-named",
    );
    let audio: &[u8] = b"RIFF synthetic";

    let response = post_audio(
        &api,
        "/v1/audio/transcriptions",
        AUDIO_BOUNDARY,
        audio_body(
            AUDIO_BOUNDARY,
            &[("model", "stt-named.gguf"), ("response_format", "json")],
            audio,
        ),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(named_upstream.count(), 1);
    assert_eq!(default_upstream.count(), 0);
    let recorded = named_upstream.requests().pop().unwrap();
    assert_eq!(recorded.path, "/v1/audio/transcriptions");
    assert_eq!(recorded.headers["authorization"], "Bearer k-named-private");
    assert_eq!(
        parse_upstream_form(&recorded)["model"],
        json!("private-named")
    );

    let response = post_audio(
        &api,
        "/v1/audio/translations",
        AUDIO_BOUNDARY,
        audio_body(
            AUDIO_BOUNDARY,
            &[("model", "stt-named.gguf"), ("response_format", "json")],
            audio,
        ),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(named_upstream.count(), 2);
    assert_eq!(
        named_upstream.requests().pop().unwrap().path,
        "/v1/audio/translations"
    );

    let response = post_audio(
        &api,
        "/v1/audio/transcriptions",
        AUDIO_BOUNDARY,
        audio_body(
            AUDIO_BOUNDARY,
            &[("model", "base.gguf"), ("response_format", "json")],
            audio,
        ),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(default_upstream.count(), 1);
    assert_eq!(
        default_upstream.requests().pop().unwrap().headers["authorization"],
        "Bearer k-default-private"
    );

    let before = (default_upstream.count(), named_upstream.count());
    let valid = audio_body(AUDIO_BOUNDARY, &[("model", "stt-named.gguf")], audio);
    let no_key = api
        .http
        .post(api.url("/v1/audio/transcriptions"))
        .header(
            "content-type",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
        )
        .body(valid.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(no_key.status(), 401);
    let worker_key = api
        .http
        .post(api.url("/v1/audio/transcriptions"))
        .bearer_auth("k-named-private")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
        )
        .body(valid)
        .send()
        .await
        .unwrap();
    assert_eq!(worker_key.status(), 401);
    assert_eq!(
        (default_upstream.count(), named_upstream.count()),
        before,
        "rejected callers must not reach a model"
    );
    assert_eq!(api.active(), 0);
    assert_eq!(named_state.lock().unwrap().active_requests, 0);
}

#[tokio::test]
async fn audio_unsupported_task_and_translate_refusal_never_reach_upstream() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, json!({"text": "ok"})).await;
    api.load_default(&upstream, "k-gen", "/m/gen.gguf");
    install_stt_engine(&api.default, &["generate"], "private-gen");
    let audio: &[u8] = b"RIFF synthetic";

    for endpoint in ["/v1/audio/transcriptions", "/v1/audio/translations"] {
        let response = post_audio(
            &api,
            endpoint,
            AUDIO_BOUNDARY,
            audio_body(AUDIO_BOUNDARY, &[("model", "gen.gguf")], audio),
        )
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), 400, "{endpoint}");
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["error"]["code"], "unsupported_task", "{endpoint}");
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("speech-to-text"),
            "{error}"
        );
    }
    assert_eq!(upstream.count(), 0);
    assert_eq!(api.active(), 0);

    // Qwen3-ASR serves transcriptions only: transcription passes, translation is refused.
    install_stt_engine(&api.default, &["transcription"], "private-asr");
    let response = post_audio(
        &api,
        "/v1/audio/transcriptions",
        AUDIO_BOUNDARY,
        audio_body(AUDIO_BOUNDARY, &[("model", "gen.gguf")], audio),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(upstream.count(), 1);
    let response = post_audio(
        &api,
        "/v1/audio/translations",
        AUDIO_BOUNDARY,
        audio_body(AUDIO_BOUNDARY, &[("model", "gen.gguf")], audio),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 400);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "unsupported_task");
    assert_eq!(upstream.count(), 1, "the refused translation stays local");
    assert_eq!(api.active(), 0);
}

#[tokio::test]
async fn audio_malformed_duplicate_and_truncated_forms_are_refused_before_routing() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, json!({"text": "ok"})).await;
    api.load_default(&upstream, "worker", "/m/stt.gguf");
    install_stt_engine(&api.default, &["transcription", "translate"], "private-stt");
    let audio: &[u8] = b"RIFF synthetic";
    let valid = audio_body(AUDIO_BOUNDARY, &[("model", "stt.gguf")], audio);

    let cases: Vec<(&str, String, Vec<u8>)> = vec![
        (
            "non-multipart content type",
            "application/json".into(),
            br#"{"model":"stt.gguf"}"#.to_vec(),
        ),
        (
            "missing boundary",
            "multipart/form-data".into(),
            valid.clone(),
        ),
        (
            "duplicate model field",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
            audio_body(
                AUDIO_BOUNDARY,
                &[("model", "stt.gguf"), ("model", "stt.gguf")],
                audio,
            ),
        ),
        (
            "truncated closing boundary",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
            valid[..valid.len() - 5].to_vec(),
        ),
        (
            "missing file part",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
            format!(
                "--{AUDIO_BOUNDARY}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nstt.gguf\r\n--{AUDIO_BOUNDARY}--\r\n"
            )
            .into_bytes(),
        ),
        (
            "empty file part",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
            audio_body(AUDIO_BOUNDARY, &[("model", "stt.gguf")], b""),
        ),
        (
            "scalar timestamp field",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
            audio_body(
                AUDIO_BOUNDARY,
                &[
                    ("model", "stt.gguf"),
                    ("timestamp_granularities", "word"),
                ],
                audio,
            ),
        ),
        (
            "duplicate boundary parameter",
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}; boundary=other"),
            valid.clone(),
        ),
    ];
    for (label, content_type, body) in cases {
        let response = api
            .http
            .post(api.url("/v1/audio/transcriptions"))
            .bearer_auth(EXTERNAL_KEY)
            .header("content-type", content_type)
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "{label}");
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["error"]["code"], "invalid_audio_form", "{label}");
    }
    assert_eq!(upstream.count(), 0, "malformed forms stay local");
    assert_eq!(api.active(), 0);
}

#[tokio::test]
async fn audio_source_fields_cannot_smuggle_paths_urls_or_keys() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, json!({"text": "ok"})).await;
    api.load_default(&upstream, "worker", "/m/stt.gguf");
    install_stt_engine(&api.default, &["transcription", "translate"], "private-stt");
    let audio: &[u8] = b"RIFF synthetic";
    // `file` without a filename is a text field smuggling a path, not binary audio.
    let file_as_text = format!(
        "--{AUDIO_BOUNDARY}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nstt.gguf\r\n--{AUDIO_BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n/etc/passwd\r\n--{AUDIO_BOUNDARY}--\r\n"
    )
    .into_bytes();
    let mut cases: Vec<(String, String, Vec<u8>)> = vec![(
        "file-as-text".into(),
        format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
        file_as_text,
    )];
    for field in [
        "url",
        "key",
        "api_key",
        "stream",
        "logit_bias",
        "min_tokens",
        "audio_url",
    ] {
        cases.push((
            field.into(),
            format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
            audio_body(
                AUDIO_BOUNDARY,
                &[("model", "stt.gguf"), (field, "/etc/passwd")],
                audio,
            ),
        ));
    }
    // Translations additionally refuse a language field that would select nothing.
    cases.push((
        "translation-language".into(),
        format!("multipart/form-data; boundary={AUDIO_BOUNDARY}"),
        audio_body(
            AUDIO_BOUNDARY,
            &[("model", "stt.gguf"), ("language", "en")],
            audio,
        ),
    ));
    for (label, content_type, body) in cases {
        let endpoint = if label == "translation-language" {
            "/v1/audio/translations"
        } else {
            "/v1/audio/transcriptions"
        };
        let response = api
            .http
            .post(api.url(endpoint))
            .bearer_auth(EXTERNAL_KEY)
            .header("content-type", content_type)
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400, "{label}");
        let text = response.text().await.unwrap();
        assert!(
            text.contains("unsupported_field") || text.contains("invalid_audio"),
            "{label}: {text}"
        );
        assert!(
            !text.contains("/etc/passwd"),
            "{label}: the refusal must not echo the smuggled path"
        );
    }
    assert_eq!(upstream.count(), 0, "smuggled sources stay local");
    assert_eq!(api.active(), 0);
}

#[tokio::test]
async fn audio_client_disconnect_while_upstream_pending_releases_its_lease() {
    for endpoint in ["audio/transcriptions", "audio/translations"] {
        let api = TestApi::start().await;
        let gate = Arc::new(Notify::new());
        let held = gate.clone();
        let upstream =
            Upstream::spawn(move |_| Reply::json(200, json!({"text": "late"})).after(held.clone()))
                .await;
        api.load_default(&upstream, "worker", "m.gguf");
        install_stt_engine(&api.default, &["transcription", "translate"], "private");
        let body = audio_body(AUDIO_BOUNDARY, &[("model", "m.gguf")], b"RIFF synthetic");
        let path = format!("/v1/{endpoint}");
        let call = tokio::spawn(post_audio(&api, &path, AUDIO_BOUNDARY, body).send());
        eventually(|| upstream.count() == 1).await;
        assert_eq!(api.active(), 1, "{endpoint}: the model is busy with it");
        call.abort();
        released(&api, endpoint).await;
    }
}

#[tokio::test]
async fn native_transcribe_uses_the_exact_named_session_without_fallback() {
    use std::sync::atomic::AtomicBool;

    let api = TestApi::start().await;
    let default_upstream = Upstream::json(200, json!({"text": "default hello"})).await;
    let named_upstream = Upstream::json(200, json!({"text": "named hello"})).await;
    api.load_default(&default_upstream, "k-default", "/m/base.gguf");
    api.load_named("s-stt", &named_upstream, "k-named", "/m/stt.gguf");
    install_stt_engine(
        &api.default,
        &["transcription", "translate"],
        "private-base",
    );
    let named_state = api.sessions.get("s-stt").unwrap().state.clone();
    install_stt_engine(
        &named_state,
        &["transcription", "translate"],
        "private-named",
    );
    let models = native_models(&api);
    let cancel = Arc::new(AtomicBool::new(false));
    let result = super::transcribe_audio(
        models.clone(),
        "s-stt".to_string(),
        synthetic_audio(b"RIFF named"),
        cancel,
    )
    .await
    .unwrap();
    assert_eq!(result.text, "named hello");
    assert_eq!(result.session_id, "s-stt");
    assert_eq!(result.model, "private-named");
    assert_eq!(named_upstream.count(), 1);
    assert_eq!(
        default_upstream.count(),
        0,
        "no fallback to the default session"
    );
    let recorded = named_upstream.requests().pop().unwrap();
    assert_eq!(recorded.headers["authorization"], "Bearer k-named");

    let before = (default_upstream.count(), named_upstream.count());
    let missing = super::transcribe_audio(
        models.clone(),
        "s-missing".to_string(),
        synthetic_audio(b"RIFF"),
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    let error = missing.unwrap_err();
    assert!(
        error.contains("transcription_session_unavailable") || error.contains("not running"),
        "{error}"
    );
    assert_eq!(
        (default_upstream.count(), named_upstream.count()),
        before,
        "unknown sessions never contact a model"
    );

    TestApi::unload(&named_state);
    let gone = super::transcribe_audio(
        models.clone(),
        "s-stt".to_string(),
        synthetic_audio(b"RIFF"),
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    assert!(
        gone.is_err(),
        "an unloaded session is not replaced by the default"
    );
    assert_eq!(
        default_upstream.count(),
        0,
        "the default session must not serve as fallback"
    );
    assert_eq!(api.default.lock().unwrap().active_requests, 0);
    assert_eq!(named_state.lock().unwrap().active_requests, 0);
}

#[tokio::test]
async fn native_transcribe_returns_json_transcript_with_model_and_session_identity() {
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, json!({"text": "hello synthetic"})).await;
    api.load_named("s-stt", &upstream, "k-named", "/m/stt.gguf");
    let named_state = api.sessions.get("s-stt").unwrap().state.clone();
    install_stt_engine(&named_state, &["transcription", "translate"], "private-stt");
    let models = native_models(&api);
    let audio: &[u8] = b"RIFF\x00\xff synthetic-attachment";
    let result = super::transcribe_audio(
        models,
        "s-stt".to_string(),
        synthetic_audio(audio),
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert_eq!(result.text, "hello synthetic");
    assert_eq!(result.session_id, "s-stt");
    assert_eq!(result.model, "private-stt");
    assert_eq!(upstream.count(), 1);
    let recorded = upstream.requests().pop().unwrap();
    assert_eq!(recorded.path, "/v1/audio/transcriptions");
    assert_eq!(recorded.headers["authorization"], "Bearer k-named");
    let fields = parse_upstream_form(&recorded);
    assert_eq!(fields["model"], json!("private-stt"));
    assert_eq!(fields["response_format"], json!("json"));
    assert!(
        body_contains(&recorded.body, audio),
        "the owned attachment bytes travel unchanged"
    );
    assert_eq!(named_state.lock().unwrap().active_requests, 0);
}

#[tokio::test]
async fn native_transcribe_cancellation_while_upstream_pending_releases_lease() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let api = TestApi::start().await;
    let gate = Arc::new(Notify::new());
    let held = gate.clone();
    let upstream =
        Upstream::spawn(move |_| Reply::json(200, json!({"text": "late"})).after(held.clone()))
            .await;
    api.load_default(&upstream, "worker", "/m/stt.gguf");
    install_stt_engine(&api.default, &["transcription", "translate"], "private-stt");
    let models = native_models(&api);
    let cancel = Arc::new(AtomicBool::new(false));
    let work = tokio::spawn(super::transcribe_audio(
        models.clone(),
        "default".to_string(),
        synthetic_audio(b"RIFF pending"),
        cancel.clone(),
    ));
    eventually(|| upstream.count() == 1).await;
    assert_eq!(api.active(), 1, "the transcription holds its lease");
    cancel.store(true, Ordering::Release);
    let result = work.await.unwrap();
    let error = result.unwrap_err();
    assert!(error.contains("media preparation cancelled"), "{error}");
    eventually(|| api.active() == 0).await;

    // A caller that is already cancelled never contacts the model.
    let api = TestApi::start().await;
    let upstream = Upstream::json(200, json!({"text": "late"})).await;
    api.load_default(&upstream, "worker", "/m/stt.gguf");
    install_stt_engine(&api.default, &["transcription", "translate"], "private-stt");
    let models = native_models(&api);
    let error = super::transcribe_audio(
        models,
        "default".to_string(),
        synthetic_audio(b"RIFF"),
        Arc::new(AtomicBool::new(true)),
    )
    .await
    .unwrap_err();
    assert!(error.contains("media preparation cancelled"), "{error}");
    assert_eq!(upstream.count(), 0);
    assert_eq!(api.active(), 0);
}

#[tokio::test]
async fn native_transcribe_reports_failed_oversize_and_empty_transcripts() {
    async fn failed_with(api: &TestApi, session: &str) -> String {
        let models = native_models(api);
        super::transcribe_audio(
            models,
            session.to_string(),
            synthetic_audio(b"RIFF case"),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .await
        .unwrap_err()
    }

    let api = TestApi::start().await;
    let failed = Upstream::json(500, json!({"error": "boom"})).await;
    api.load_default(&failed, "worker", "/m/stt.gguf");
    install_stt_engine(&api.default, &["transcription", "translate"], "private");
    let error = failed_with(&api, "default").await;
    assert!(error.contains("transcription failed (HTTP 500)"), "{error}");
    assert_eq!(api.active(), 0);

    for (label, body) in [
        ("empty", json!({"text": ""})),
        ("whitespace", json!({"text": "   "})),
        ("missing-text", json!({"no_text": 1})),
        ("oversize", json!({"text": "x".repeat(70 * 1024)})),
    ] {
        let api = TestApi::start().await;
        let upstream = Upstream::json(200, body).await;
        api.load_default(&upstream, "worker", "/m/stt.gguf");
        install_stt_engine(&api.default, &["transcription", "translate"], "private");
        let error = failed_with(&api, "default").await;
        assert!(error.contains("empty or oversized"), "{label}: {error}");
        assert_eq!(upstream.count(), 1, "{label}");
        assert_eq!(api.active(), 0, "{label}");
    }

    let api = TestApi::start().await;
    let invalid = Upstream::spawn(|_| Reply {
        status: 200,
        content_type: "application/json",
        with_length: true,
        before_head: None,
        chunks: vec![Chunk::Data("not json".into())],
    })
    .await;
    api.load_default(&invalid, "worker", "/m/stt.gguf");
    install_stt_engine(&api.default, &["transcription", "translate"], "private");
    let error = failed_with(&api, "default").await;
    assert!(error.contains("invalid transcription response"), "{error}");
    assert_eq!(api.active(), 0);
}
