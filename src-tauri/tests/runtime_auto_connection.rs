//! A synthetic local HTTP service takes the real CLI discovery/connection,
//! generated registration and owned app proxy path. This proves plumbing only;
//! it makes no inference, hardware or named-engine compatibility claim.
use aiolm_lib::{config, providers, server, AppConfig, ErrBuf};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const MODEL: &str = "independent-test-model";
const APP_KEY: &str = "synthetic-app-connection-key";

struct Home {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "aiolm auto {{preview}} 눈길 {}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(path.join("profile")).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // This integration binary has one test and owns its environment.
        std::env::set_var("AIOLM_HOME", &path);
        Self { path, previous }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("AIOLM_HOME", value),
            None => std::env::remove_var("AIOLM_HOME"),
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

async fn cli(home: &Path, args: &[&str]) -> Value {
    let profile = home.join("profile");
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_aiolm-cli"));
    command
        .args(args)
        .kill_on_drop(true)
        .env("AIOLM_HOME", home)
        .env("HOME", &profile)
        .env("USERPROFILE", &profile)
        .env("APPDATA", profile.join("roaming"))
        .env("LOCALAPPDATA", profile.join("local"))
        .env("XDG_CONFIG_HOME", profile.join("config"))
        .env("XDG_DATA_HOME", profile.join("data"))
        .env("XDG_CACHE_HOME", profile.join("cache"));
    let output = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("CLI timed out")
        .expect("spawn real CLI");
    assert!(
        output.status.success(),
        "CLI {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("CLI returned invalid JSON: {error}"))
}

async fn request(socket: &mut TcpStream) -> Option<(String, Vec<u8>, String)> {
    let mut bytes = Vec::new();
    let (end, length, first, head) = loop {
        if bytes.len() > 64 * 1024 {
            return None;
        }
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let head = std::str::from_utf8(&bytes[..index]).ok()?.to_owned();
            let length = head
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>())
                .transpose()
                .ok()?
                .unwrap_or(0);
            if length > 512 * 1024 {
                return None;
            }
            let first = head.lines().next()?.to_owned();
            break (index + 4, length, first, head);
        }
        let mut buffer = [0; 4096];
        let count = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut buffer))
            .await
            .ok()?
            .ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
    };
    while bytes.len() < end + length {
        let mut buffer = [0; 4096];
        let count = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut buffer))
            .await
            .ok()?
            .ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Some((first, bytes[end..end + length].to_vec(), head))
}

async fn respond(
    mut socket: TcpStream,
    json_calls: Arc<AtomicUsize>,
    stream_calls: Arc<AtomicUsize>,
    leaked_key: Arc<AtomicBool>,
) {
    let Some((line, body, head)) = request(&mut socket).await else {
        return;
    };
    if head.contains(APP_KEY) {
        leaked_key.store(true, Ordering::Release);
    }
    let path = line.split_whitespace().nth(1).unwrap_or("");
    let (status, content_type, body) = if path == "/v1/models" {
        (
            200,
            "application/json",
            json!({"object":"list","data":[{"id":MODEL,"object":"model"}]}).to_string(),
        )
    } else if path == "/health" {
        (200, "application/json", "{\"status\":\"ok\"}".into())
    } else if path == "/v1/chat/completions" {
        let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if value["model"] != MODEL {
            (
                400,
                "application/json",
                "{\"error\":\"unknown model\"}".into(),
            )
        } else if value["stream"] == true {
            stream_calls.fetch_add(1, Ordering::AcqRel);
            let content = json!({"model":MODEL,"choices":[{"index":0,"delta":{"role":"assistant","content":"5"},"finish_reason":null}]});
            let finish = json!({"model":MODEL,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}});
            (
                200,
                "text/event-stream",
                format!("data: {content}\n\ndata: {finish}\n\ndata: [DONE]\n\n"),
            )
        } else {
            json_calls.fetch_add(1, Ordering::AcqRel);
            (200, "application/json", json!({"model":MODEL,"choices":[{"index":0,"message":{"role":"assistant","content":"5"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}).to_string())
        }
    } else {
        (404, "application/json", "{}".into())
    };
    let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_cli_connection_verifies_and_registers_an_independent_service_without_owning_it()
{
    let home = Home::new();
    let user_file = home.path.join("preserved-user-data.txt");
    fs::write(&user_file, b"existing user data").unwrap();
    let upstream = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream.local_addr().unwrap().port();
    let json_calls = Arc::new(AtomicUsize::new(0));
    let stream_calls = Arc::new(AtomicUsize::new(0));
    let leaked_key = Arc::new(AtomicBool::new(false));
    let counters = (json_calls.clone(), stream_calls.clone(), leaked_key.clone());
    let serving = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = upstream.accept().await else {
                break;
            };
            let counters = counters.clone();
            tokio::spawn(respond(socket, counters.0, counters.1, counters.2));
        }
    });
    let discovery = cli(&home.path, &["runtime", "discover"]).await;
    let candidates = discovery["candidates"].as_array().unwrap();
    let candidate = candidates
        .iter()
        .find(|candidate| {
            candidate["endpoints"]
                .as_array()
                .unwrap()
                .iter()
                .any(|endpoint| endpoint["port"] == upstream_port)
        })
        .expect("the actual local model service was not discovered");
    assert!(
        candidate.get("command").is_none(),
        "public CLI discovery must not print captured process arguments"
    );
    let id = candidate["id"].as_str().unwrap();
    let connected = cli(&home.path, &["runtime", "connect", id, MODEL]).await;
    assert_eq!(connected["mode"], "attached");
    let engine = connected["engine_id"].as_str().unwrap();
    let runtime = connected["runtime_id"].as_str().unwrap();
    let model_path = connected["model_path"].as_str().unwrap();
    cli(&home.path, &["runtime", "select", engine, runtime]).await;
    cli(&home.path, &["config", "set", "active_model", model_path]).await;
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    cli(&home.path, &["config", "set", "port", &port.to_string()]).await;
    // Helper migration must see the real CLI executable, not this test runner.
    cli(&home.path, &["runtime", "probe", engine, runtime]).await;
    let cfg: AppConfig = config::load_result().unwrap();
    let errors = Arc::new(ErrBuf::default());
    let (child, url, _) = server::spawn(&cfg, APP_KEY, &errors, &Default::default()).unwrap();
    let state = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut state = state.lock().unwrap();
        state.engine = Some(providers::execution::info(&cfg).unwrap());
        state.child = Some(child);
    }
    let result = async {
        server::wait_ready(state.clone(), &url, APP_KEY, 15, &errors).await?;
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(15)).build().unwrap();
        let response = client.post(format!("{url}/chat/completions")).bearer_auth(APP_KEY)
            .json(&json!({"model":MODEL,"messages":[{"role":"user","content":"Synthetic connection check"}],"stream":true}))
            .send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
        if !response.contains("[DONE]") || !response.contains("\"content\":\"5\"") { return Err("The owned app proxy did not return the actual upstream stream.".into()); }
        Ok::<_,String>(())
    }.await;
    server::kill(&mut state.lock().unwrap().child, None);
    result.unwrap_or_else(|error| panic!("{error}; {}", errors.tail()));
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    let headless = cli(&home.path, &["server", "start"]).await;
    let headless_url = headless["url"].as_str().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let headless_response = client.post(format!("{headless_url}/chat/completions"))
        .json(&json!({"model":MODEL,"messages":[{"role":"user","content":"Synthetic headless connection check"}],"stream":false}))
        .send().await;
    let stopped = cli(&home.path, &["server", "stop"]).await;
    assert_eq!(stopped["state"], "stopped");
    let headless_response: Value = headless_response.unwrap().json().await.unwrap();
    assert_eq!(
        headless_response
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        Some("5")
    );
    assert!(
        client
            .get(format!("http://127.0.0.1:{upstream_port}/health"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success(),
        "stopping the app-owned proxy must not stop the independently running service"
    );
    cli(&home.path, &["runtime", "remove", engine, runtime]).await;
    assert_eq!(fs::read(&user_file).unwrap(), b"existing user data");
    let saved = config::load_result().unwrap();
    assert_eq!(saved.active_provider, engine);
    assert_eq!(saved.active_runtime, runtime);
    assert_eq!(saved.active_model, model_path);
    assert!(
        providers::registry::manifest(providers::ProviderId::parse(engine).unwrap(), runtime)
            .is_err()
    );
    assert!(json_calls.load(Ordering::Acquire) >= 2 && stream_calls.load(Ordering::Acquire) >= 2);
    assert!(
        !leaked_key.load(Ordering::Acquire),
        "the application credential must not reach the independent upstream server"
    );
    serving.abort();
}
