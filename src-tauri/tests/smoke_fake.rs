//! Deterministic counterpart to `tests/smoke.rs`: exercises the same
//! process-spawn / `/health` polling / SSE-streaming path in `server.rs`
//! against a tiny fake `llama-server` fixture (`src/bin/fake-llama-server.rs`)
//! instead of a real multi-GB model. Unlike `smoke.rs` and
//! `runtime_install.rs`, this test always runs in the default `cargo test`
//! gate — it needs no environment variable and no network access, so a
//! regression in the spawn/readiness/streaming plumbing fails CI instead of
//! being masked by the gated tests' early-return "pass".
use std::fs;
use std::sync::{Arc, Mutex};

use aiolm_lib::{server, AppConfig, ErrBuf};

/// Copies the compiled fake-llama-server fixture into a throwaway managed
/// runtime directory (`{build}-{backend}/llama-server[.exe]` under an
/// isolated data root) so `server::server_bin` resolves it exactly like a
/// real AioLM-installed runtime. Only runtimes installed in AioLM are ever
/// used, so the fixture must not rely on the removed PATH lookup.
fn stage_fake_managed_runtime() -> tempfile_dir::TempDir {
    let fixture = env!("CARGO_BIN_EXE_fake-llama-server");
    let dir = tempfile_dir::TempDir::new();
    let runtime_dir = dir.path().join("runtimes").join("local_fake-cpu");
    std::fs::create_dir_all(&runtime_dir).expect("create fake managed runtime dir");
    let staged_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    fs::copy(fixture, runtime_dir.join(staged_name)).expect("stage fake llama-server fixture");

    // `runtimes_root()` derives from the data folder; point it at the
    // throwaway root. This test binary is single-threaded at the point this
    // runs (no other test in this file spawns threads that read this
    // variable), so there is no data race with the mutation edition 2024's
    // `set_var` guards against.
    unsafe {
        std::env::set_var("AIOLM_HOME", dir.path());
    }
    dir
}

/// Minimal `tempfile`-alike so this test doesn't need a new dependency: a
/// directory under `std::env::temp_dir()` that removes itself on drop.
mod tempfile_dir {
    use std::path::{Path, PathBuf};

    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "aiolm-smoke-fake-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_nanos())
                    .unwrap_or_default()
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir for fake server fixture");
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn smoke_fake_server_spawn_health_and_chat_stream() {
    // Both successful and failed launches share one isolated runtime in this
    // test so no other test races the process-wide data-root override.
    let _dir = stage_fake_managed_runtime();

    let cfg = AppConfig {
        active_model: "fake-model.gguf".to_string(),
        active_backend: "cpu".to_string(),
        active_build: "local_fake".to_string(),
        port: 18099,
        ngl: 0,
        ctx_size: 512,
        flash_attn: "off".into(),
        ..AppConfig::default()
    };

    let ring = Arc::new(ErrBuf::default());
    let api_key = "fake-smoke-token";
    let (child, url, api_key_file) = server::spawn(
        &cfg,
        api_key,
        &ring,
        &aiolm_lib::gpu::ResolvedGpu::default(),
    )
    .unwrap_or_else(|e| panic!("spawn failed: {e}\nstderr: {}", ring.tail()));
    let shared = Arc::new(Mutex::new(server::ServerState::default()));
    shared.lock().expect("server state lock").attach_starting(
        child,
        url.clone(),
        api_key.to_string(),
        cfg.active_model.clone(),
        cfg.mmproj.clone(),
        cfg.spec_draft_model.clone(),
    );
    shared.lock().unwrap().engine = Some(aiolm_lib::providers::protocol::EngineInfo::llama(
        &cfg.active_model,
        aiolm_lib::providers::artifacts::Modalities::text_only(),
    ));

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let ready =
        rt.block_on(async { server::wait_ready(shared.clone(), &url, api_key, 20, &ring).await });
    server::cleanup_api_key_file(api_key_file.as_deref());
    if let Err(e) = ready {
        panic!("wait_ready failed against fake server: {e}");
    }

    let base = url.replace("/v1", "");
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "fake-model",
        "messages": [{"role":"user","content":"Reply with exactly: OK"}],
        "stream": true,
    });
    let got = rt.block_on(async {
        let resp = client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .expect("chat request failed");
        assert!(resp.status().is_success(), "chat HTTP {}", resp.status());
        resp.text().await.expect("read chat response body")
    });
    assert!(
        got.contains("data:"),
        "expected SSE 'data:' frames, got: {got}"
    );
    assert!(
        got.contains("[DONE]"),
        "expected SSE completion marker, got: {got}"
    );

    // Config-file mode is not present in the app's argv prediction. Resolve it
    // through the owned endpoint and reject unknown/unusable tasks before Ready.
    // The original server remains alive throughout failure cleanup.
    for (flag, expected_error) in [
        ("--fake-embedding-mode", None),
        ("--fake-rerank-mode", Some("--rerank")),
        ("--fake-invalid-pooling", Some("pooling settings")),
        ("--fake-unverified-task-api", Some("no task was certified")),
        ("--fake-no-generation", Some("did not verify generation")),
    ] {
        let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let case = AppConfig {
            port: reservation.local_addr().unwrap().port(),
            server_args: vec![flag.into()],
            ..cfg.clone()
        };
        drop(reservation);
        let (child, case_url, key_file) = server::spawn(
            &case,
            api_key,
            &ring,
            &aiolm_lib::gpu::ResolvedGpu::default(),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(server::ServerState::default()));
        state.lock().unwrap().attach_starting(
            child,
            case_url.clone(),
            api_key.into(),
            case.active_model.clone(),
            String::new(),
            String::new(),
        );
        state.lock().unwrap().engine = Some(aiolm_lib::providers::protocol::EngineInfo::llama(
            &case.active_model,
            aiolm_lib::providers::artifacts::Modalities::text_only(),
        ));
        let outcome = rt.block_on(server::wait_ready(
            state.clone(),
            &case_url,
            api_key,
            20,
            &ring,
        ));
        if let Some(message) = expected_error {
            assert!(outcome.unwrap_err().contains(message), "{flag}");
            assert!(
                state.lock().unwrap().child.is_none(),
                "failed verification must reap its owned child"
            );
            assert!(
                std::net::TcpListener::bind(("127.0.0.1", case.port)).is_ok(),
                "failed verification must free its port"
            );
        } else {
            outcome.unwrap();
            let engine = state.lock().unwrap().engine.clone().unwrap();
            assert_eq!(engine.tasks, ["embed"]);
            assert_eq!(engine.chat_supported, Some(false));
            assert!(!engine.tools_auto && !engine.tool_parser);
            server::kill(&mut state.lock().unwrap().child, None);
        }
        server::cleanup_api_key_file(key_file.as_deref());
        assert!(key_file.is_none_or(|path| !path.exists()));
        let healthy = rt
            .block_on(client.get(format!("{base}/health")).send())
            .unwrap();
        assert!(
            healthy.status().is_success(),
            "other server protected during {flag}"
        );
    }

    server::kill(
        &mut shared.lock().expect("server state lock").child,
        Some(ring.clone()),
    );

    // Engines may write their core error to stdout and a much longer API
    // wrapper traceback to stderr. The wrapper must not erase that root error.
    let failing_cfg = AppConfig {
        server_args: vec!["--fake-startup-failure".into()],
        ..cfg
    };
    let (child, url, key_file) = server::spawn(
        &failing_cfg,
        api_key,
        &ring,
        &aiolm_lib::gpu::ResolvedGpu::default(),
    )
    .expect("spawn failing engine fixture");
    shared.lock().unwrap().attach_starting(
        child,
        url.clone(),
        api_key.into(),
        failing_cfg.active_model,
        String::new(),
        String::new(),
    );
    let failure = rt
        .block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                server::wait_ready(shared.clone(), &url, api_key, 20, &ring),
            )
            .await
        })
        .expect("a failed engine must report promptly")
        .expect_err("the engine must not become ready");
    assert!(
        failure.contains("server exited before ready (7)"),
        "{failure}"
    );
    assert!(
        failure.contains("engine core: synthetic allocation failed 🙂"),
        "missing core error: {failure}"
    );
    assert!(
        failure.contains("API wrapper: engine initialization failed"),
        "missing wrapper error: {failure}"
    );
    assert!(failure.contains("[REDACTED]"));
    assert!(!failure.contains(api_key));
    assert!(
        failure.len() < 16384,
        "large process output must stay bounded"
    );
    assert!(shared.lock().unwrap().child.is_none());
    assert!(key_file.as_ref().is_none_or(|path| !path.exists()));

    assert_loaded_binding_survives_served_id(_dir.path());
}

// Keep the launched filesystem bindings after readiness reports a served model ID.
// This shares the existing test's isolated home and managed fake runtime.
struct BindingServerOwner {
    shared: Arc<Mutex<server::ServerState>>,
    ring: Arc<ErrBuf>,
    key_file: Option<std::path::PathBuf>,
    stop_deadline: Option<std::sync::mpsc::Sender<()>>,
    deadline: Option<std::thread::JoinHandle<()>>,
}

impl BindingServerOwner {
    fn cleanup(&mut self) {
        server::kill(
            &mut self.shared.lock().unwrap_or_else(|e| e.into_inner()).child,
            Some(self.ring.clone()),
        );
        server::cleanup_api_key_file(self.key_file.as_deref());
        if let Some(stop) = self.stop_deadline.take() {
            let _ = stop.send(());
        }
        if let Some(deadline) = self.deadline.take() {
            let _ = deadline.join();
        }
    }
}

impl Drop for BindingServerOwner {
    fn drop(&mut self) {
        self.cleanup();
    }
}

struct BindingObservation {
    memory: server::MemoryEstimate,
    stopped_memory: server::MemoryEstimate,
    status: serde_json::Value,
    before_model: String,
    after_model: String,
    loaded_path: String,
    saved_before: serde_json::Value,
    saved_after: serde_json::Value,
    expected_saved: serde_json::Value,
    child_removed: bool,
    key_removed: bool,
    port_released: bool,
    ready: Result<(), String>,
    readers_released: bool,
    #[cfg(windows)]
    tree_exited: bool,
}

fn observe_loaded_binding(root: &std::path::Path) -> Result<BindingObservation, String> {
    let model_root = root.join("loaded-binding-models");
    fs::create_dir(&model_root).map_err(|e| e.to_string())?;
    let primary = model_root.join("loaded-00001-of-00002.gguf");
    let second = model_root.join("loaded-00002-of-00002.gguf");
    let projector = model_root.join("projector.gguf");
    let adapter = model_root.join("adapter.gguf");
    let selected = model_root.join("selected.gguf");
    // Minimal synthetic GGUF headers and sparse lengths, never real model data.
    for (path, mib) in [
        (&primary, 8),
        (&second, 4),
        (&projector, 2),
        (&adapter, 1),
        (&selected, 16),
    ] {
        use std::io::Write;
        let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
        file.write_all(b"GGUF\x03\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0")
            .map_err(|e| e.to_string())?;
        file.set_len(mib * 1024 * 1024).map_err(|e| e.to_string())?;
    }
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = reservation.local_addr().map_err(|e| e.to_string())?.port();
    let loaded = AppConfig {
        models_dir: model_root.to_string_lossy().into_owned(),
        active_model: primary.to_string_lossy().into_owned(),
        mmproj: projector.to_string_lossy().into_owned(),
        active_backend: "cpu".into(),
        active_build: "local_fake".into(),
        port,
        ctx_size: 512,
        parallel: 2,
        ngl: 0,
        flash_attn: "off".into(),
        lora_adapters: vec![aiolm_lib::config::LoraAdapterConfig {
            path: adapter.to_string_lossy().into_owned(),
            scale: 1.0,
            enabled: true,
        }],
        ..Default::default()
    };
    loaded.validate()?;
    // This exercises public server helpers, not desktop launch validation or IPC.
    let selected_cfg = AppConfig {
        active_model: selected.to_string_lossy().into_owned(),
        mmproj: String::new(),
        lora_adapters: Vec::new(),
        ctx_size: 1024,
        parallel: 1,
        ..loaded.clone()
    };
    aiolm_lib::config::save(&selected_cfg)?;
    // Complete normal profile recovery before pinning the selected B baseline.
    let recovered = aiolm_lib::config::load_result()?;
    let saved = aiolm_lib::config::save(&recovered)?;
    let expected_saved = serde_json::to_value(&saved).map_err(|e| e.to_string())?;
    let saved_before =
        serde_json::to_value(aiolm_lib::config::load_result()?).map_err(|e| e.to_string())?;
    let ring = Arc::new(ErrBuf::default());
    let key = "synthetic-binding-token";
    drop(reservation);
    let (child, url, key_file) = server::spawn(&loaded, key, &ring, &Default::default())?;
    let shared = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
        state.attach_starting(
            child,
            url.clone(),
            key.into(),
            loaded.active_model.clone(),
            loaded.mmproj.clone(),
            String::new(),
        );
        state.engine = Some(aiolm_lib::providers::protocol::EngineInfo::llama(
            &loaded.active_model,
            aiolm_lib::providers::artifacts::Modalities::text_only(),
        ));
    }
    let mut owner = BindingServerOwner {
        shared: shared.clone(),
        ring: ring.clone(),
        key_file,
        stop_deadline: None,
        deadline: None,
    };
    let tree = shared
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .child
        .as_ref()
        .and_then(|child| child.process_handle())
        .ok_or("fixture has no process-tree owner")?;
    let deadline_tree = tree.clone();
    let (stop_deadline, deadline_rx) = std::sync::mpsc::channel();
    owner.deadline = Some(
        std::thread::Builder::new()
            .name("binding-fixture-deadline".into())
            .spawn(move || {
                if deadline_rx
                    .recv_timeout(std::time::Duration::from_secs(20))
                    .is_err()
                {
                    deadline_tree.terminate();
                }
            })
            .map_err(|e| e.to_string())?,
    );
    owner.stop_deadline = Some(stop_deadline);
    let before_model = shared
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .model
        .clone();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let ready = rt.block_on(async {
        tokio::time::timeout(
            std::time::Duration::from_secs(20),
            server::wait_ready(shared.clone(), &url, key, 20, &ring),
        )
        .await
        .map_err(|_| "fixture readiness exceeded its existing allowance".to_owned())?
    });
    // wait_ready itself does not set Ready/execution. Reproduce the existing
    // successful caller's publication only after the actual readiness Result.
    let (after_model, status, memory, stopped_memory) = {
        let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
        let after_model = state.model.clone();
        if ready.is_ok() {
            state.lifecycle = server::Lifecycle::Ready;
            state.execution = Some(loaded.clone());
        }
        let status = serde_json::to_value(aiolm_lib::session::build_status(
            "named-A", "loaded A", &mut state, &ring,
        ))
        .map_err(|e| e.to_string())?;
        let memory = server::estimate_status_memory(&saved, &state);
        let live = state.lifecycle;
        state.lifecycle = server::Lifecycle::Stopped;
        let stopped_memory = server::estimate_status_memory(&saved, &state);
        state.lifecycle = live;
        (after_model, status, memory, stopped_memory)
    };
    let saved_after =
        serde_json::to_value(aiolm_lib::config::load_result()?).map_err(|e| e.to_string())?;
    // Own all cleanup before any regression assertion, including dropped-future failure.
    owner.cleanup();
    drop(rt);
    let readers_released = Arc::strong_count(&ring) == 2;
    #[cfg(windows)]
    let tree_exited = tree.wait_exited(std::time::Duration::from_secs(10));
    let child_removed = shared
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .child
        .is_none();
    let key_removed = owner.key_file.as_ref().is_some_and(|path| !path.exists());
    let port_released = std::net::TcpListener::bind(("127.0.0.1", port)).is_ok();
    Ok(BindingObservation {
        memory,
        stopped_memory,
        status,
        before_model,
        after_model,
        loaded_path: loaded.active_model,
        saved_before,
        saved_after,
        expected_saved,
        child_removed,
        key_removed,
        port_released,
        ready,
        readers_released,
        #[cfg(windows)]
        tree_exited,
    })
}

fn assert_loaded_binding_survives_served_id(root: &std::path::Path) {
    let observed = observe_loaded_binding(root).expect("owned fixture setup and observations");
    assert!(
        observed.child_removed && observed.key_removed && observed.port_released,
        "fixture cleanup before semantic assertions"
    );
    assert!(
        observed.readers_released,
        "both output reader Arc owners released after teardown"
    );
    #[cfg(windows)]
    assert!(
        observed.tree_exited,
        "owned process tree has no live members"
    );
    eprintln!(
        "binding cleanup: child/key/readers/listener released; readiness={:?}",
        observed.ready
    );
    observed
        .ready
        .expect("actual fake-server readiness, ownership and task confirmation");
    assert_eq!(observed.before_model, observed.loaded_path);
    assert_eq!(
        observed.after_model, "fake-model",
        "real wait_ready assignment must be traversed"
    );
    assert_eq!(observed.status["state"], "running");
    assert_eq!(
        observed.status["model"], "fake-model",
        "served ID wire contract remains unchanged"
    );
    assert_eq!(
        observed.status["engine"]["upstream_model"],
        observed.loaded_path
    );
    assert_eq!(
        observed.status["execution"]["active_model"],
        observed.loaded_path
    );
    assert_eq!(observed.saved_before, observed.expected_saved);
    assert_eq!(
        observed.saved_after, observed.expected_saved,
        "all selected B settings remain unchanged"
    );
    eprintln!("binding preconditions: actual readiness PASS; before={}, served={}, status={}, saved whole JSON preserved; memory={:?}", observed.before_model, observed.after_model, observed.status, observed.memory);
    assert_eq!(
        observed.memory.model_mb, 8,
        "live A path remains independent of the served ID"
    );
    assert_eq!(observed.memory.projector_mb, 2);
    assert_eq!(observed.memory.adapters_mb, 1);
    assert_eq!(observed.memory.context_mb, 1);
    assert_eq!(observed.memory.kv_mb, 8);
    assert_eq!(observed.memory.total_mb, 21);
    assert_eq!(observed.memory.source, "filesystem");
    assert_eq!(
        observed.stopped_memory.model_mb, 16,
        "stopped status follows selected B"
    );
    assert_eq!(observed.stopped_memory.projector_mb, 0);
    assert_eq!(observed.stopped_memory.adapters_mb, 0);
}
