//! A synthetic local HTTP service takes the real CLI discovery/connection,
//! generated registration and owned app proxy path. This proves plumbing only;
//! it makes no inference, hardware or named-engine compatibility claim.
use aiolm_lib::{config, providers, server, AppConfig, ErrBuf};
use base64::Engine;
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
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
}
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "aiolm auto {{preview}} 눈길 {}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(path.join("profile")).unwrap();
        let profile = path.join("profile");
        // This single combined test owns and restores every data-root variable
        // before even the parent process calls config::load_result.
        let environment = [
            ("AIOLM_HOME", path.clone()),
            ("HOME", profile.clone()),
            ("USERPROFILE", profile.clone()),
            ("APPDATA", profile.join("roaming")),
            ("LOCALAPPDATA", profile.join("local")),
            ("XDG_CONFIG_HOME", profile.join("config")),
            ("XDG_DATA_HOME", profile.join("data")),
            ("XDG_CACHE_HOME", profile.join("cache")),
        ];
        let previous = environment
            .iter()
            .map(|(name, value)| {
                let previous = std::env::var_os(name);
                std::env::set_var(name, value);
                (*name, previous)
            })
            .collect();
        Self { path, previous }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        for (name, previous) in &self.previous {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
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
        "CLI {args:?}: status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
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
    benchmark_calls: Arc<AtomicUsize>,
) {
    let Some((line, body, head)) = request(&mut socket).await else {
        return;
    };
    if head.contains(APP_KEY) || head.contains("bench-") {
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
        assert_ne!(value.pointer("/messages/0/content").and_then(Value::as_str), Some("Reply with OK."));
        let measured = value
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            .is_some_and(|text| text.len() == 1024);
        if measured {
            benchmark_calls.fetch_add(1, Ordering::AcqRel);
        }
        if value.get("stream_options").is_some() {
            assert_eq!(value["stream_options"], json!({"include_usage":true}));
            if measured {
                assert_eq!(value["max_tokens"], 128);
                assert_eq!(value["messages"][0]["content"].as_str().unwrap().len(), 1024);
            }
            let body = "{\"error\":\"optional stream_options unsupported\"}";
            let response = format!("HTTP/1.1 400 Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            let _ = socket.write_all(response.as_bytes()).await;
            return;
        }
        if measured {
            let body = value.as_object().unwrap();
            assert_eq!(
                body.len(),
                5,
                "no defaults, force controls, or usage request"
            );
            assert_eq!(body["max_tokens"], 128);
            assert_eq!(body["temperature"], 0);
            assert_eq!(body["stream"], true);
            assert_eq!(body["messages"].as_array().unwrap().len(), 1);
            assert_eq!(body["messages"][0]["role"], "user");
            assert_eq!(body["messages"][0]["content"].as_str().unwrap().len(), 1024);
        }
        if value["model"] != MODEL {
            (
                400,
                "application/json",
                "{\"error\":\"unknown model\"}".into(),
            )
        } else if value["stream"] == true {
            stream_calls.fetch_add(1, Ordering::AcqRel);
            let content = json!({"model":MODEL,"choices":[{"index":0,"delta":{"role":"assistant","content":if measured { "short output" } else { "5" }},"finish_reason":null}]});
            let mut finish =
                json!({"model":MODEL,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
            if !measured {
                finish["usage"] = json!({"prompt_tokens":4,"completion_tokens":1,"total_tokens":5});
            }
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
    let benchmark_calls = Arc::new(AtomicUsize::new(0));
    let benchmark_control = benchmark_calls.clone();
    let counters = (json_calls.clone(), stream_calls.clone(), leaked_key.clone());
    let serving = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        loop {
            let Ok((socket, _)) = upstream.accept().await else {
                break;
            };
            let counters = counters.clone();
            handlers.spawn(respond(
                socket,
                counters.0,
                counters.1,
                counters.2,
                benchmark_control.clone(),
            ));
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
        .unwrap_or_else(|| {
            panic!("the actual local model service was not discovered: {discovery}")
        });
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
    let attached_schema =
        providers::runtime_schema::effective(&providers::registry::root(), &cfg, true).unwrap();
    assert!(!attached_schema.supports_launch_args);
    assert!(attached_schema.schema.options.is_empty());
    assert!(attached_schema.entry.is_none());
    let errors = Arc::new(ErrBuf::default());
    let server::SpawnedServer {
        child,
        url,
        readiness,
        ..
    } = server::spawn(&cfg, APP_KEY, &errors, &Default::default(), None).unwrap();
    let state = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut state = state.lock().unwrap();
        state.engine = Some(providers::execution::info(&cfg).unwrap());
        state.child = Some(child);
    }
    let result = async {
        server::wait_ready(state.clone(), &url, APP_KEY, 15, &errors, readiness).await?;
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
    let saved_configuration = fs::read(config::config_path()).unwrap();
    {
        // The app owns only a proxy; Cold Prompt still supports the attached
        // engine without restarting or claiming ownership of upstream compute.
        use aiolm_lib::performance_bench as bench;
        let request = bench::PerformanceBenchRequest {
            run_id: "attached-serving".into(),
            method: Default::default(),
            context_profile: "novel_ja".into(),
            prompt_bytes: vec![1024],
            max_output_tokens: 128,
            concurrencies: vec![1, 2],
            repetitions: 1,
            warmup: false,
            // Usage is requested; this upstream rejects the optional field.
            request_usage: true,
        };
        // App updates replace the generated AioLM helper, not the user's
        // engine. Admission stays read-only; launch adopts the current helper.
        let registration_path = providers::registry::root()
            .join(engine)
            .join(runtime)
            .join("registration.json");
        let mut registration: Value =
            serde_json::from_slice(&fs::read(&registration_path).unwrap()).unwrap();
        registration["executable_sha256"] = json!("0".repeat(64));
        registration["probe_sha256"] = json!("0".repeat(64));
        let prior_build = serde_json::to_vec(&registration).unwrap();
        fs::write(&registration_path, &prior_build).unwrap();
        assert_eq!(
            bench::admission(cfg.clone(), request.clone()).await.status,
            "supported"
        );
        assert_eq!(fs::read(&registration_path).unwrap(), prior_build);
        let artifact = registration["manifest"]["artifacts"][0].as_str().unwrap();
        let original = fs::read(artifact).unwrap();
        let mut changed = original.clone();
        changed.push(b' ');
        fs::write(artifact, changed).unwrap();
        assert_ne!(
            bench::admission(cfg.clone(), request.clone()).await.status,
            "supported",
            "an app update must not authorize changed connection artifacts"
        );
        fs::write(artifact, original).unwrap();
        let runtime = bench::RuntimeInfo::prepare(&cfg, &request).await.unwrap();
        let process = Arc::new(Mutex::new(None));
        let messages = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = messages.clone();
        let result = bench::run(
            cfg.clone(),
            request,
            Default::default(),
            Arc::new(AtomicBool::new(false)),
            process.clone(),
            Arc::new(move |event| {
                if let Some(message) = event.message {
                    observed.lock().unwrap().push(message);
                }
            }),
            runtime,
        )
        .await;
        assert_eq!(result.status, "complete", "{:?}", result.message);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(benchmark_calls.load(Ordering::Acquire), 4,
            "one rejected first measured request, then three accepted requests; no workload warmup");
        for row in &result.rows {
            assert_eq!(row.output_bytes, 12 * u64::from(row.concurrency));
            assert!(row.e2e_ms > 0.0);
            assert_eq!(row.usage_status, "missing");
            assert!(row.reported_prompt_tokens.is_none());
            assert!(row.reported_completion_tokens.is_none());
            assert!(row.prefill_tokens_per_second.is_none());
            assert!(row.decode_tokens_per_second.is_none());
            assert!(row.tpot_ms.is_none());
            assert_eq!(row.input_sha256_by_request.len(), row.concurrency as usize);
            assert!(row.peak_memory_bytes.is_none(), "an attached proxy is not owned compute");
            assert_eq!(row.finish_reasons, vec!["stop"; row.concurrency as usize]);
        }
        let recorded = serde_json::to_value(&result).unwrap();
        assert_eq!(recorded["provenance"]["method"]["version"], 5);
        assert_eq!(recorded["provenance"]["workload"]["cache_policy"], "cold_prompt");
        // The entirely rejected first measured batch freezes usage off.
        assert_eq!(recorded["provenance"]["execution"]["memory_scope"], "unavailable");
        assert_eq!(recorded["provenance"]["workload"]["request_usage"], false);
        assert!(recorded["provenance"]["execution"]["settings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|setting| setting["name"] != "stream_options.include_usage"));
        let hashes: Vec<_> = recorded["rows"].as_array().unwrap().iter()
            .flat_map(|row| row["input_sha256_by_request"].as_array().unwrap()).collect();
        assert_eq!(hashes.len(), 3);
        assert_eq!(hashes.iter().map(|hash| hash.as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>().len(), 3);
        assert!(process.lock().unwrap().is_none());
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
        assert!(client
            .get(format!("http://127.0.0.1:{upstream_port}/health"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
    }
    assert_eq!(
        fs::read(config::config_path()).unwrap(),
        saved_configuration
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
    managed_options_and_probe_cache_journey(&home.path).await;
    managed_readable_served_alias_journey(&home.path).await;
}

/// Read a legacy managed spec through settings, then exercise the real helper
/// and engine on probe and serve. The copied fake executable is opt-in only.
async fn managed_options_and_probe_cache_journey(home: &Path) {
    let folder = home.join("managed engine");
    fs::create_dir(&folder).unwrap();
    let engine_program = folder.join(format!(
        "aiolm-auto-options-fixture{}",
        std::env::consts::EXE_SUFFIX
    ));
    fs::copy(env!("CARGO_BIN_EXE_fake-llama-server"), &engine_program).unwrap();
    // GNU Windows links the shared app library's WebView loader dynamically.
    // Keep the copied fixture executable's existing runtime dependency beside it.
    #[cfg(windows)]
    {
        let loader = Path::new(env!("CARGO_BIN_EXE_fake-llama-server"))
            .parent()
            .unwrap()
            .join("WebView2Loader.dll");
        if loader.is_file() {
            fs::copy(loader, folder.join("WebView2Loader.dll")).unwrap();
        }
    }
    let model = folder.join("synthetic-model.gguf");
    fs::write(&model, b"synthetic model data, not an inference claim").unwrap();
    let engine = "custom.auto-0123456789abcdee";
    let runtime = "connection-0123456789abcdee";
    let directory = providers::registry::root().join(engine).join(runtime);
    fs::create_dir_all(&directory).unwrap();
    let spec_path = directory.join("connection.json");
    let launch = json!({
        "program": engine_program,
        "args": ["serve","llm","--model","{model}","--port","{port}",
            "--host","{host}","--served-model-name","{model_alias}"],
        "env":{}, "working_directory":folder,
    });
    // Exactly the original v1 target shape; no profile values or schema are
    // added to immutable connection metadata to make old connections work.
    let spec = serde_json::to_vec(&json!({
        "version":1,"engine_id":engine,"runtime_id":runtime,
        "target":{"kind":"managed","launch":launch,"artifacts":[]},
        "model_path":model,"upstream_model":null,
    }))
    .unwrap();
    fs::write(&spec_path, &spec).unwrap();
    let address = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(spec_path.to_str().unwrap().as_bytes());
    let manifest = json!({
        "schema_version":1,"adapter_version":1,"engine_id":engine,"runtime_id":runtime,
        "display_name":"Synthetic managed options","compute_ownership":"descendant",
        "platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],
        "protocol":"openai-v1",
        "probe":{"program":env!("CARGO_BIN_EXE_aiolm-cli"),
            "args":["--internal-runtime-auto","probe",address,"{model}"],
            "env":{},"working_directory":null},
        "launch":{"program":env!("CARGO_BIN_EXE_aiolm-cli"),
            "args":["--internal-runtime-auto","serve",address,"{model}","{port}"],
            "env":{"AIO_CONNECT_KEY":"{api_key}"},"working_directory":null},
        "options":[],"model_formats":["unknown"],
        "models":[{"path":model,"name":"Synthetic model"}],
        "artifacts":[spec_path,engine_program],"health_path":"/health",
        "health_authenticated":false,
    });
    let manifest_path = folder.join("owned-manifest.json");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    cli(
        home,
        &[
            "runtime",
            "register-manifest",
            manifest_path.to_str().unwrap(),
        ],
    )
    .await;
    cli(home, &["runtime", "select", engine, runtime]).await;
    cli(
        home,
        &["config", "set", "active_model", model.to_str().unwrap()],
    )
    .await;
    let cfg = config::load_result().unwrap();
    let root = providers::registry::root();
    assert!(!directory.join("help/accepted.json").exists());
    let schema = providers::runtime_schema::effective(&root, &cfg, true).unwrap();
    assert!(schema.supports_launch_args);
    assert_eq!(schema.scope, ["serve", "llm"]);
    assert_eq!(
        schema.help_state,
        providers::runtime_schema::HelpState::Current
    );
    let key_for = |flag: &str| {
        schema
            .schema
            .options
            .iter()
            .find(|option| {
                option
                    .spellings
                    .iter()
                    .any(|spelling| spelling.flag == flag)
            })
            .unwrap()
            .key
            .clone()
    };
    let label_key = key_for("--fresh-label");
    let count_key = key_for("--fresh-count");
    let log = folder.join("automatic-launches.jsonl");
    assert!(!log.exists(), "settings help must not load the model");
    assert_eq!(fs::read(&spec_path).unwrap(), spec);
    let accepted = fs::read(directory.join("help/accepted.json")).unwrap();
    providers::runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(
        fs::read(directory.join("help/accepted.json")).unwrap(),
        accepted
    );
    let saved_options = |count: u64, raw: &str| {
        json!({
            engine: {
                label_key.clone(): "{port}",
                count_key.clone(): count.to_string(),
                "extra_args": ["--not-in-help",raw],
            }
        })
        .to_string()
    };
    cli(
        home,
        &[
            "config",
            "set",
            "provider_options",
            &saved_options(3, "{model}"),
        ],
    )
    .await;
    let launches = || {
        fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Vec<String>>(line).unwrap())
            .collect::<Vec<_>>()
    };
    cli(home, &["runtime", "probe", engine, runtime]).await;
    assert_eq!(launches().len(), 1);
    let check_options = |argv: &[String], count: &str, raw: &str| {
        assert_eq!(&argv[..2], ["serve", "llm"]);
        for (flag, value) in [
            ("--model", model.to_str().unwrap()),
            ("--host", "127.0.0.1"),
            ("--served-model-name", "aiolm-connection-0123456789abcdee"),
            ("--fresh-label", "{port}"),
            ("--fresh-count", count),
            ("--not-in-help", raw),
        ] {
            assert_eq!(
                argv.iter().filter(|token| token.as_str() == flag).count(),
                1,
                "{flag} must reach the engine exactly once: {argv:?}"
            );
            let index = argv.iter().position(|token| token == flag).unwrap();
            assert_eq!(argv[index + 1], value, "{flag}");
        }
        assert_eq!(
            argv.len(),
            16,
            "no helper transport tokens leak to the engine"
        );
    };
    check_options(&launches()[0], "3", "{model}");
    cli(home, &["server", "start"]).await;
    cli(home, &["server", "stop"]).await;
    let first = launches();
    assert_eq!(
        first.len(),
        2,
        "matching probe must not load the model again before serving"
    );
    check_options(&first[1], "3", "{model}");
    cli(home, &["server", "start"]).await;
    cli(home, &["server", "stop"]).await;
    assert_eq!(
        launches().len(),
        3,
        "unchanged repeated start loads only its serving engine"
    );
    cli(
        home,
        &[
            "config",
            "set",
            "provider_options",
            &saved_options(7, "{model}"),
        ],
    )
    .await;
    cli(home, &["server", "start"]).await;
    cli(home, &["server", "stop"]).await;
    let changed = launches();
    assert_eq!(
        changed.len(),
        4,
        "changed options are verified in the serving load, not a throwaway load"
    );
    check_options(&changed[3], "7", "{model}");
    cli(
        home,
        &[
            "config",
            "set",
            "provider_options",
            &saved_options(7, "path with spaces/{host}"),
        ],
    )
    .await;
    cli(home, &["server", "start"]).await;
    cli(home, &["server", "stop"]).await;
    let raw_changed = launches();
    assert_eq!(
        raw_changed.len(),
        5,
        "changed raw options are verified in the serving load"
    );
    check_options(&raw_changed[4], "7", "path with spaces/{host}");
    cli(home, &["runtime", "probe", engine, runtime]).await;
    assert_eq!(
        launches().len(),
        6,
        "an explicit model probe still checks changed options"
    );
    assert_eq!(fs::read(&spec_path).unwrap(), spec);
    assert_eq!(
        fs::read(directory.join("help/accepted.json")).unwrap(),
        accepted
    );
    // Managed connections use one normal launch and retain ordinary readiness.
    {
        use aiolm_lib::performance_bench as bench;
        let cfg = config::load_result().unwrap();
        let saved = fs::read(config::config_path()).unwrap();
        let http_log = folder.join("automatic-http-requests.jsonl");
        let http_before = fs::read_to_string(&http_log).unwrap().lines().count();
        let launch_count = launches().len();
        let request = bench::PerformanceBenchRequest {
            run_id: "managed-standard-serving".into(),
            method: Default::default(),
            context_profile: "novel_en".into(),
            prompt_bytes: vec![1024],
            max_output_tokens: 128,
            concurrencies: vec![1, 2],
            repetitions: 1,
            warmup: false,
            request_usage: false,
        };
        let runtime = bench::RuntimeInfo::prepare(&cfg, &request).await.unwrap();
        let process = Arc::new(Mutex::new(None));
        let result = bench::run(
            cfg,
            request,
            Default::default(),
            Arc::new(AtomicBool::new(false)),
            process.clone(),
            Arc::new(|_| {}),
            runtime,
        )
        .await;
        assert_eq!(result.status, "complete", "{:?}", result.message);
        assert_eq!(result.rows.len(), 2);
        assert!(result
            .rows
            .iter()
            .all(|row| row.output_bytes == 12 * u64::from(row.concurrency)
                && row.e2e_ms > 0.0
                && row.usage_status == "missing"
                && row.reported_prompt_tokens.is_none()
                && row.reported_completion_tokens.is_none()
                && row.prefill_tokens_per_second.is_none()
                && row.decode_tokens_per_second.is_none()
                && row.tpot_ms.is_none()
                && row.input_sha256_by_request.len() == row.concurrency as usize));
        let recorded = serde_json::to_value(&result).unwrap();
        assert_eq!(recorded["provenance"]["method"]["version"], 5);
        assert_eq!(recorded["provenance"]["workload"]["request_usage"], false);
        let bodies: Vec<Value> =
            fs::read_to_string(folder.join("automatic-benchmark-requests.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        assert_eq!(bodies.len(), 3, "no generating benchmark warmup or usage probe");
        for body in bodies {
            assert_eq!(body.as_object().unwrap().len(), 5);
            assert_eq!(body["model"], "aiolm-connection-0123456789abcdee");
            assert_eq!(body["max_tokens"], 128);
            assert_eq!(body["temperature"], 0);
            assert_eq!(body["stream"], true);
            assert_eq!(body["messages"][0]["content"].as_str().unwrap().len(), 1024);
        }
        assert_eq!(launches().len(), launch_count + 1, "one engine load for all points");
        let http: Vec<Value> = fs::read_to_string(&http_log).unwrap().lines()
            .skip(http_before).map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(http.iter().map(|call| call["pid"].as_u64().unwrap())
            .collect::<std::collections::BTreeSet<_>>().len(), 1,
            "every point is served by the same normally launched engine");
        let texts: Vec<_> = http.iter()
            .filter(|call| call["body"]["max_tokens"] == 128)
            .map(|call| call["body"]["messages"][0]["content"].as_str().unwrap())
            .collect();
        assert_eq!(texts.len(), 3);
        assert_eq!(texts.iter().collect::<std::collections::BTreeSet<_>>().len(), 3);
        assert!(process.lock().unwrap().is_none());
        let launched = launches();
        let argv = launched.last().unwrap();
        let port_index = argv.iter().position(|arg| arg == "--port").unwrap();
        let bench_port: u16 = argv[port_index + 1].parse().unwrap();
        assert!(std::net::TcpStream::connect(("127.0.0.1", bench_port)).is_err());
        assert_eq!(fs::read(config::config_path()).unwrap(), saved);
        assert_eq!(fs::read(&spec_path).unwrap(), spec);
        assert_eq!(
            fs::read(directory.join("help/accepted.json")).unwrap(),
            accepted
        );
    }
    // Accepted evidence stays pinned; changed executable bytes never become
    // silently accepted or launchable through the automatic-owned exception.
    let mut changed_engine = fs::read(&engine_program).unwrap();
    changed_engine.push(0);
    fs::write(&engine_program, changed_engine).unwrap();
    let cfg = config::load_result().unwrap();
    let stale = providers::runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(
        stale.help_state,
        providers::runtime_schema::HelpState::Stale
    );
    assert_eq!(
        fs::read(directory.join("help/accepted.json")).unwrap(),
        accepted
    );
    assert!(providers::registry::command(&cfg, cfg.port, "").is_err());
    cli(home, &["runtime", "remove", engine, runtime]).await;
}

/// A managed connection registered with a readable served alias exposes that
/// model name end to end: engine argv, probe evidence, the external model list
/// and request routing. The opaque connection id is no longer advertised.
async fn managed_readable_served_alias_journey(home: &Path) {
    let folder = home.join("readable alias engine");
    fs::create_dir(&folder).unwrap();
    let engine_program = folder.join(format!(
        "aiolm-auto-options-fixture{}",
        std::env::consts::EXE_SUFFIX
    ));
    fs::copy(env!("CARGO_BIN_EXE_fake-llama-server"), &engine_program).unwrap();
    #[cfg(windows)]
    {
        let loader = Path::new(env!("CARGO_BIN_EXE_fake-llama-server"))
            .parent()
            .unwrap()
            .join("WebView2Loader.dll");
        if loader.is_file() {
            fs::copy(loader, folder.join("WebView2Loader.dll")).unwrap();
        }
    }
    let model = folder.join("synthetic-model.gguf");
    fs::write(&model, b"synthetic model data, not an inference claim").unwrap();
    let engine = "custom.auto-0123456789abcded";
    let runtime = "connection-0123456789abcded";
    let directory = providers::registry::root().join(engine).join(runtime);
    fs::create_dir_all(&directory).unwrap();
    let spec_path = directory.join("connection.json");
    let launch = json!({
        "program": engine_program,
        "args": ["serve","llm","--model","{model}","--port","{port}",
            "--host","{host}","--served-model-name","{model_alias}"],
        "env":{}, "working_directory":folder,
    });
    let spec = serde_json::to_vec(&json!({
        "version":1,"engine_id":engine,"runtime_id":runtime,
        "target":{"kind":"managed","launch":launch,"artifacts":[]},
        "model_path":model,"upstream_model":null,
        "served_alias":"Synthetic-model",
    }))
    .unwrap();
    fs::write(&spec_path, &spec).unwrap();
    let address = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(spec_path.to_str().unwrap().as_bytes());
    let manifest = json!({
        "schema_version":1,"adapter_version":1,"engine_id":engine,"runtime_id":runtime,
        "display_name":"Synthetic readable alias","compute_ownership":"descendant",
        "platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],
        "protocol":"openai-v1",
        "probe":{"program":env!("CARGO_BIN_EXE_aiolm-cli"),
            "args":["--internal-runtime-auto","probe",address,"{model}"],
            "env":{},"working_directory":null},
        "launch":{"program":env!("CARGO_BIN_EXE_aiolm-cli"),
            "args":["--internal-runtime-auto","serve",address,"{model}","{port}"],
            "env":{"AIO_CONNECT_KEY":"{api_key}"},"working_directory":null},
        "options":[],"model_formats":["unknown"],
        "models":[{"path":model,"name":"Synthetic model.gguf"}],
        "artifacts":[spec_path,engine_program],"health_path":"/health",
        "health_authenticated":false,
    });
    let manifest_path = folder.join("owned-manifest.json");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    cli(
        home,
        &[
            "runtime",
            "register-manifest",
            manifest_path.to_str().unwrap(),
        ],
    )
    .await;
    cli(home, &["runtime", "select", engine, runtime]).await;
    cli(
        home,
        &["config", "set", "active_model", model.to_str().unwrap()],
    )
    .await;
    cli(home, &["runtime", "probe", engine, runtime]).await;
    let registration: Value =
        serde_json::from_slice(&fs::read(directory.join("registration.json")).unwrap())
            .unwrap();
    assert_eq!(
        registration["probe"]["served_model"], "Synthetic-model",
        "the connection probe must verify the readable name, not the connection id"
    );
    cli(home, &["server", "start"]).await;
    let launches: Vec<Vec<String>> =
        fs::read_to_string(folder.join("automatic-launches.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    let argv = launches.last().unwrap();
    let index = argv
        .iter()
        .position(|arg| arg == "--served-model-name")
        .unwrap();
    assert_eq!(argv[index + 1], "Synthetic-model");
    let cfg = config::load_result().unwrap();
    let client = reqwest::Client::new();
    let listed: Value = client
        .get(format!("http://127.0.0.1:{}/v1/models", cfg.port))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["data"][0]["id"], "Synthetic-model");
    let chat: Value = client
        .post(format!(
            "http://127.0.0.1:{}/v1/chat/completions",
            cfg.port
        ))
        .json(&json!({
            "model":"Synthetic-model",
            "messages":[{"role":"user","content":"hi"}],
            "max_tokens":8
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(chat["model"], "Synthetic-model");
    assert_eq!(chat["choices"][0]["message"]["content"], "5");
    let legacy = client
        .post(format!(
            "http://127.0.0.1:{}/v1/chat/completions",
            cfg.port
        ))
        .json(&json!({
            "model":format!("aiolm-{runtime}"),
            "messages":[{"role":"user","content":"hi"}],
            "max_tokens":8
        }))
        .send()
        .await
        .unwrap();
    let legacy_status = legacy.status();
    let legacy_body: Value = legacy.json().await.unwrap();
    assert!(
        !legacy_status.is_success(),
        "the opaque connection id must no longer be an addressable model: {legacy_status} {legacy_body}"
    );
    cli(home, &["server", "stop"]).await;
    cli(home, &["runtime", "remove", engine, runtime]).await;
}
