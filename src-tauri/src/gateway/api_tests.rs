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
