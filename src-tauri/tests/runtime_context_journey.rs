//! The same selected runtime/profile is used by independent app processes
//! launched from different directories. No global working-directory mutation.
use aiolm_lib::{
    providers::{
        self,
        runtime_help::HelpService,
        runtime_help_store,
        runtime_schema::{self, HelpRequest},
    },
    AppConfig,
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command};

struct Home {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("aiolm context {}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
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

#[tokio::test]
async fn accepted_execution_context_survives_a_different_app_launcher_directory() {
    let home = Home::new();
    let old = r#"{"version":1,"fingerprint":"legacy","request":{"program":null,"args":["--help"],"scope":[]}}"#;
    let legacy: runtime_schema::AcceptedHelp = serde_json::from_str(old).unwrap();
    assert_eq!(
        serde_json::to_string(&legacy).unwrap(),
        old,
        "old omitted fields retain their exact serialization"
    );
    let program = env!("CARGO_BIN_EXE_fake-llama-server");
    let model = home.path.join("synthetic-model.bin");
    fs::write(&model, b"synthetic").unwrap();
    let probe_directory = home.path.join("probe-directory.json");
    let manifest = json!({"schema_version":1,"adapter_version":1,"engine_id":"custom.contextfixture","runtime_id":"r1",
        "display_name":"Synthetic context fixture","platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],
        "protocol":"openai-v1","model_formats":["unknown"],"health_path":"/health",
        "probe":{"program":program,"args":["--adapter-probe","custom.contextfixture","r1","{model}"],"env":{"FAKE_PROBE_CWD_RECORD":probe_directory}},
        "launch":{"program":program,"args":["--adapter-observe-context-fixture","--model","{model}","--port","{port}"],"env":{}}});
    let source = home.path.join("runtime.json");
    fs::write(&source, serde_json::to_vec(&manifest).unwrap()).unwrap();
    providers::registry::register(&source, None).await.unwrap();
    let mut cfg = AppConfig {
        active_provider: "custom.contextfixture".into(),
        active_runtime: "r1".into(),
        active_model: model.to_string_lossy().into_owned(),
        ..Default::default()
    };
    cfg.normalize();
    let root = providers::registry::root();
    let request = HelpRequest {
        encoding: None,
        locale: None,
        working_directory: None,
        program: None,
        args: vec![
            "--adapter-observe-context-fixture".into(),
            "--adapter-help-fixture".into(),
            "--help".into(),
        ],
        scope: vec![],
    };
    let command = runtime_schema::help_command(&cfg, &request).unwrap();
    let (_, descriptor) = runtime_help_store::discover_persist_describe(
        &HelpService::default(),
        &root,
        "context",
        cfg.active_provider.as_str(),
        "r1",
        &command,
        &[],
    )
    .unwrap();
    runtime_schema::accept(&root, &cfg, &descriptor.fingerprint, &request).unwrap();
    cfg.provider_options.insert(
        cfg.active_provider.clone(),
        json!({"fresh_count":"7"}).as_object().unwrap().clone(),
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    aiolm_lib::config::save(&cfg).unwrap();
    let mut results = Vec::<Value>::new();
    for name in ["GUI launcher", "CLI shortcut 눈길"] {
        let directory = home.path.join(name);
        fs::create_dir(&directory).unwrap();
        let output = Command::new(program)
            .arg("--adapter-context-contract-fixture")
            .current_dir(&directory)
            .env("AIOLM_HOME", &home.path)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        results.push(serde_json::from_slice(&output.stdout).unwrap());
    }
    assert!(
        results[0].get("error").is_none(),
        "first launcher: {}",
        results[0]
    );
    assert!(
        results[1].get("error").is_none(),
        "second launcher: {}",
        results[1]
    );
    assert_eq!(results[0]["help"], descriptor.fingerprint);
    assert_eq!(results[0]["help"], results[1]["help"]);
    assert_eq!(results[0]["actual"]["cwd"], results[1]["actual"]["cwd"]);
    assert_eq!(results[0]["actual"]["argv"], results[1]["actual"]["argv"]);

    let original_options = cfg.provider_options.clone();
    let run = || -> Value {
        let output = Command::new(program)
            .arg("--adapter-context-contract-fixture")
            .current_dir(home.path.join("CLI shortcut 눈길"))
            .env("AIOLM_HOME", &home.path)
            .output()
            .unwrap();
        assert!(output.status.success());
        serde_json::from_slice(&output.stdout).unwrap()
    };
    let accept = |request: &HelpRequest| {
        let command = runtime_schema::help_command(&cfg, request).unwrap();
        let (_, descriptor) = runtime_help_store::discover_persist_describe(
            &HelpService::default(),
            &root,
            "context",
            cfg.active_provider.as_str(),
            "r1",
            &command,
            &[],
        )
        .unwrap();
        runtime_schema::accept(&root, &cfg, &descriptor.fingerprint, request).unwrap()
    };
    let chosen = home.path.join("user chosen context");
    fs::create_dir(&chosen).unwrap();
    let mut explicit = request.clone();
    explicit.working_directory = Some(chosen.to_string_lossy().into_owned());
    let changed = accept(&explicit);
    assert_ne!(changed.fingerprint, descriptor.fingerprint);
    assert!(
        run()["error"].as_str().unwrap().contains("probe"),
        "changing context requires a new model probe"
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let actual = run();
    assert!(actual.get("error").is_none(), "{actual}");
    assert_eq!(
        PathBuf::from(actual["actual"]["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        chosen.canonicalize().unwrap()
    );
    assert_eq!(actual["actual"]["argv"], results[0]["actual"]["argv"]);
    let probed: PathBuf = serde_json::from_slice(&fs::read(&probe_directory).unwrap()).unwrap();
    assert_eq!(
        probed.canonicalize().unwrap(),
        chosen.canonicalize().unwrap()
    );
    fs::remove_dir(&chosen).unwrap();
    assert!(run()["error"]
        .as_str()
        .unwrap()
        .contains("execution directory"));
    let recovered = home.path.join("recovered context");
    fs::create_dir(&recovered).unwrap();
    explicit.working_directory = Some(recovered.to_string_lossy().into_owned());
    accept(&explicit);
    providers::adapter::refresh(&cfg, None).await.unwrap();
    assert!(
        run().get("error").is_none(),
        "a new explicit context repairs a removed pinned directory"
    );

    let engine = providers::ProviderId::parse(&cfg.active_provider).unwrap();
    for name in ["declared A", "declared B"] {
        let directory = home.path.join(name);
        fs::create_dir(&directory).unwrap();
        providers::registry::remove(engine, "r1").unwrap();
        let mut declared = manifest.clone();
        declared["launch"]["working_directory"] = json!(directory);
        fs::write(&source, serde_json::to_vec(&declared).unwrap()).unwrap();
        providers::registry::register(&source, None).await.unwrap();
        // Even the first model-independent probe uses the declared context,
        // rather than the app launcher or an earlier runtime registration.
        let probed: PathBuf = serde_json::from_slice(&fs::read(&probe_directory).unwrap()).unwrap();
        assert_eq!(
            probed.canonicalize().unwrap(),
            directory.canonicalize().unwrap()
        );
        assert_eq!(
            runtime_schema::effective(&root, &cfg, true)
                .unwrap()
                .help_state,
            runtime_schema::HelpState::Stale
        );
        assert!(
            runtime_schema::help_command(&cfg, &explicit).is_err(),
            "a requested cwd cannot override the adapter declaration"
        );
        let accepted = accept(&request);
        assert_ne!(accepted.fingerprint, changed.fingerprint);
        providers::adapter::refresh(&cfg, None).await.unwrap();
        let actual = run();
        assert!(actual.get("error").is_none(), "{actual}");
        assert_eq!(
            PathBuf::from(actual["actual"]["cwd"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            directory.canonicalize().unwrap()
        );
    }
    assert_eq!(cfg.provider_options, original_options);
    assert_eq!(
        aiolm_lib::config::load_result().unwrap().provider_options,
        original_options
    );
}
