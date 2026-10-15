//! Exercise a fourth engine through the actual registry, process owner and
//! readiness/HTTP stack. This synthetic engine makes no inference claims.
use aiolm_lib::{
    providers::{
        self,
        registry::{Platform, ProcessSpec, RuntimeManifest},
    },
    server, AppConfig, ErrBuf,
};
use futures_util::StreamExt;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct TestHome {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl TestHome {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("aiolm-adapter-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // This integration binary contains one test. Other binaries have their
        // own environment, so no concurrent test can read this mutation.
        std::env::set_var("AIOLM_HOME", &path);
        Self { path, previous }
    }
}
impl Drop for TestHome {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("AIOLM_HOME", value),
            None => std::env::remove_var("AIOLM_HOME"),
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[tokio::test]
async fn external_engine_registration_preserves_identity_and_owns_only_its_processes() {
    let area = TestHome::new();
    let engine = providers::ProviderId::parse("custom.echo").unwrap();
    let model = area.path.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let adapter_source = area.path.join("adapter-source.txt");
    fs::write(&adapter_source, b"synthetic adapter source").unwrap();
    let program = PathBuf::from(env!("CARGO_BIN_EXE_fake-llama-server"));
    let process = ProcessSpec {
        program: program.to_string_lossy().into_owned(),
        args: vec![],
        env: BTreeMap::new(),
        working_directory: Some(area.path.to_string_lossy().into_owned()),
    };
    let manifest = RuntimeManifest {
        command_layout: None,
        launch_resources: None,
        schema_version: 1,
        adapter_version: 1,
        launch_bindings: None,
        bridge_command: None,
        option_metadata: None,
        engine_id: engine,
        runtime_id: "fixture-1".into(),
        display_name: "Synthetic external engine".into(),
        platforms: vec![Platform {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
        }],
        protocol: "openai-v1".into(),
        probe: ProcessSpec {
            args: vec![
                "--adapter-probe".into(),
                engine.as_str().into(),
                "fixture-1".into(),
                "{model}".into(),
                "--adapter-probe-jitter".into(),
            ],
            ..process.clone()
        },
        launch: ProcessSpec {
            args: vec![
                "--adapter-engine".into(),
                "--adapter-no-health-auth".into(),
                "--model".into(),
                "{model}".into(),
                "--host".into(),
                "{host}".into(),
                "--port".into(),
                "{port}".into(),
            ],
            ..process
        },
        options: vec![],
        artifacts: vec![adapter_source.to_string_lossy().into_owned()],
        model_formats: vec!["unknown".into()],
        models: vec![providers::registry::ModelBinding {
            path: model.to_string_lossy().into_owned(),
            name: "Synthetic external model".into(),
        }],
        health_path: "/health".into(),
        health_authenticated: false,
    };
    let source = area.path.join("runtime.json");
    fs::write(&source, serde_json::to_vec(&manifest).unwrap()).unwrap();
    providers::registry::register(&source, None).await.unwrap();
    assert!(providers::registry::register(&source, None)
        .await
        .unwrap_err()
        .contains("already registered"));
    assert_eq!(providers::ProviderId::ALL.len(), 3);
    assert!(providers::list_runtime_instances()
        .iter()
        .any(|runtime| runtime.provider == engine && runtime.id == "fixture-1"));
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: engine.as_str().into(),
        active_runtime: "fixture-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    cfg.validate().unwrap();
    aiolm_lib::config::save(&cfg).unwrap();
    let loaded = aiolm_lib::config::load_result().unwrap();
    assert_eq!(loaded.active_provider, engine.as_str());
    assert!(loaded
        .settings_profiles
        .unwrap()
        .entries
        .iter()
        .any(|profile| profile.provider == engine.as_str()));
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let slow_model = area.path.join("slow-model.model");
    fs::write(&slow_model, b"synthetic second model").unwrap();
    let mut slow_cfg = cfg.clone();
    slow_cfg.active_model = slow_model.to_string_lossy().into_owned();
    let (slow_result, fast_result) = tokio::join!(
        providers::adapter::refresh(&slow_cfg, None),
        providers::adapter::refresh(&cfg, None)
    );
    slow_result.unwrap();
    fast_result.unwrap();
    assert!(
        providers::execution::info(&cfg).is_ok(),
        "late other-model probe must not invalidate current model"
    );
    assert!(providers::registry::registered_models()
        .iter()
        .any(|artifact| artifact.path == cfg.active_model && artifact.ownership == "external"));
    let info = providers::execution::info(&cfg).unwrap();
    assert_eq!(info.provider, engine);
    assert_eq!(info.upstream_model, "fake-model");
    assert!(!info.tools_auto);
    assert_eq!(info.tasks, ["generate"]);
    let err = Arc::new(ErrBuf::default());
    let (child, url, key_file) =
        server::spawn(&cfg, "synthetic-key", &err, &Default::default()).unwrap();
    assert!(key_file.is_none());
    let shared = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut state = shared.lock().unwrap();
        state.child = Some(child);
        state.engine = Some(info);
    }
    server::wait_ready(shared.clone(), &url, "synthetic-key", 5, &err)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let answer = client.post(format!("{url}/chat/completions")).json(&serde_json::json!({"model":"fake-model","messages":[{"role":"user","content":"synthetic"}],"stream":true})).send().await.unwrap().text().await.unwrap();
    assert!(answer.contains("OK") && answer.contains("prompt_tokens") && answer.contains("[DONE]"));
    let response = client.post(format!("{url}/chat/completions")).json(&serde_json::json!({"model":"fake-model","messages":[{"role":"user","content":"slow"}],"stream":true})).send().await.unwrap();
    let mut stream = response.bytes_stream();
    assert!(stream.next().await.unwrap().is_ok());
    drop(stream);
    assert!(client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    {
        let mut state = shared.lock().unwrap();
        server::kill(&mut state.child, Some(err.clone()));
    }
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    assert!(providers::adapter::require_feature(
        &cfg,
        providers::adapter::RuntimeFeature::ExactBenchmark
    )
    .unwrap_err()
    .contains("unsupported"));
    fs::write(&adapter_source, b"changed adapter source").unwrap();
    assert!(providers::execution::info(&cfg)
        .unwrap_err()
        .contains("changed"));
    fs::write(&adapter_source, b"synthetic adapter source").unwrap();
    // Forgetting a registration cannot rewrite a saved engine into llama.cpp.
    providers::registry::remove(engine, "fixture-1").unwrap();
    let loaded = aiolm_lib::config::load_result().unwrap();
    assert_eq!(loaded.active_provider, engine.as_str());
    assert_eq!(loaded.active_runtime, "fixture-1");
    assert!(providers::execution::info(&loaded).is_err());
    assert!(program.is_file());
    assert_eq!(fs::read(&model).unwrap(), b"synthetic weights");
    assert!(source.is_file());
    // The unchanged executable/config can be registered again without rebuilding AioLM.
    providers::registry::register(&source, None).await.unwrap();
    providers::adapter::refresh(&cfg, None).await.unwrap();
    assert_eq!(providers::execution::info(&cfg).unwrap().provider, engine);
    let mut mismatched = manifest.clone();
    mismatched.runtime_id = "wrong-identity".into();
    let wrong_source = area.path.join("wrong.json");
    fs::write(&wrong_source, serde_json::to_vec(&mismatched).unwrap()).unwrap();
    assert!(providers::registry::register(&wrong_source, None)
        .await
        .unwrap_err()
        .contains("mismatch"));
    assert!(!providers::registry::root()
        .join(engine.as_str())
        .join("wrong-identity")
        .exists());
    let mut failed = manifest.clone();
    failed.runtime_id = "probe-fail".into();
    failed.probe.args[2] = failed.runtime_id.clone();
    failed.probe.args.push("--adapter-probe-fail".into());
    let failed_source = area.path.join("failed.json");
    fs::write(&failed_source, serde_json::to_vec(&failed).unwrap()).unwrap();
    assert!(providers::registry::register(&failed_source, None)
        .await
        .unwrap_err()
        .contains("selected loader dependency is missing"));
    // Cancellation of an actual probe is authoritative and publishes no staging.
    let mut slow = manifest;
    slow.runtime_id = "fixture-slow".into();
    slow.probe.args[2] = slow.runtime_id.clone();
    slow.probe.args.push("--adapter-probe-slow".into());
    let slow_source = area.path.join("slow.json");
    fs::write(&slow_source, serde_json::to_vec(&slow).unwrap()).unwrap();
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = cancel.clone();
    let cancellation = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        flag.store(true, std::sync::atomic::Ordering::Release);
    });
    assert_eq!(
        providers::registry::register(&slow_source, Some(cancel))
            .await
            .unwrap_err(),
        "runtime probe cancelled"
    );
    cancellation.await.unwrap();
    assert!(!providers::registry::root()
        .join(engine.as_str())
        .join("fixture-slow")
        .exists());
}
