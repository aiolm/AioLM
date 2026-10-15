//! Entry-point registration from explicit choices: an interpreter-style
//! program with a script prefix (spaces and Unicode), help discovered before
//! registration through the same command derivation, bindings checked against
//! that help, an explicit credential variable and probe, and the reviewed help
//! applying to the registered engine without rediscovery. Synthetic only.
use aiolm_lib::{
    providers::{
        self,
        registry::{
            ArgBinding, AuthBinding, DraftHelp, EntrypointDraft, EntrypointHelp, ProcessSpec,
            ServingProtocol,
        },
        runtime_help::HelpService,
        runtime_help_store::{self, Baseline},
        runtime_schema::{self, HelpRequest, HelpState},
    },
    server, AppConfig, ErrBuf,
};
use serde_json::{json, Value};
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
        let path = std::env::temp_dir().join(format!("aiolm-entrypoint-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // One test per integration binary; no concurrent reader of this.
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
async fn explicit_entrypoint_registration_pins_reviewed_help_for_launch() {
    let area = TestHome::new();
    let engine = providers::ProviderId::parse("custom.entryfixture").unwrap();
    let program = env!("CARGO_BIN_EXE_fake-llama-server").to_string();
    let scripts = area.path.join("엔진 scripts");
    fs::create_dir(&scripts).unwrap();
    let script = scripts.join("serve engine.py");
    fs::write(&script, b"synthetic entry script v1").unwrap();
    let other_script = scripts.join("other.py");
    fs::write(&other_script, b"synthetic other script").unwrap();
    let model = area.path.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let argv_file = area.path.join("argv.json");
    let prefix = vec![
        script.to_string_lossy().into_owned(),
        "--adapter-engine".to_string(),
        "--adapter-no-health-auth".to_string(),
    ];
    let entry = EntrypointHelp {
        engine_id: engine,
        runtime_id: "local-1".into(),
        program: program.clone(),
        prefix: prefix.clone(),
        working_directory: Some(area.path.to_string_lossy().into_owned()),
        artifacts: vec![script.to_string_lossy().into_owned()],
        environment: BTreeMap::from([(
            "FAKE_ENGINE_ARGV_FILE".to_string(),
            argv_file.to_string_lossy().into_owned(),
        )]),
        protocol: ServingProtocol::OpenaiHttp,
        option_metadata: None,
    };
    let mut help_args = prefix.clone();
    help_args.extend(["--adapter-help-fixture".to_string(), "--help".to_string()]);
    let request = HelpRequest {
        program: None,
        args: help_args,
        scope: vec![],
    };
    // Help before registration, through the registered engine's derivation.
    let provisional = providers::registry::provisional_manifest(&entry).unwrap();
    let command = runtime_schema::manifest_help_command(&provisional, &request).unwrap();
    assert!(command.artifacts.contains(&script));
    let root = providers::registry::root();
    let (report, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        &root,
        "entry-owner",
        engine.as_str(),
        "local-1",
        &command,
        &[],
        Baseline::Latest,
    )
    .unwrap();
    assert!(report.complete());
    let help = DraftHelp {
        fingerprint: descriptor.fingerprint.clone(),
        request: request.clone(),
    };
    let draft = EntrypointDraft {
        engine_id: engine,
        runtime_id: "local-1".into(),
        display_name: "Synthetic entry point".into(),
        program: program.clone(),
        prefix: prefix.clone(),
        working_directory: entry.working_directory.clone(),
        artifacts: entry.artifacts.clone(),
        environment: entry.environment.clone(),
        model: ArgBinding::Flag {
            flag: "--model".into(),
            equals: false,
        },
        port: ArgBinding::Flag {
            flag: "--port".into(),
            equals: false,
        },
        host: Some(ArgBinding::Flag {
            flag: "--host".into(),
            equals: false,
        }),
        served_model: None,
        auth: AuthBinding::Env {
            name: "SYNTHETIC_API_KEY".into(),
        },
        protocol: ServingProtocol::OpenaiHttp,
        probe: ProcessSpec {
            program: program.clone(),
            args: vec![
                "--adapter-probe".into(),
                engine.as_str().into(),
                "local-1".into(),
                "{model}".into(),
            ],
            env: BTreeMap::new(),
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: Some(help),
        option_metadata: None,
    };

    // The manifest is exactly the user's choices: no invented credential
    // variable, probe arguments, bindings or protocol.
    let manifest = providers::registry::manifest_from_draft(&draft).unwrap();
    let mut expected_args = prefix.clone();
    expected_args
        .extend(["--model", "{model}", "--host", "{host}", "--port", "{port}"].map(String::from));
    assert_eq!(manifest.launch.args, expected_args);
    assert_eq!(
        manifest
            .launch
            .env
            .get("SYNTHETIC_API_KEY")
            .map(String::as_str),
        Some("{api_key}")
    );
    assert!(!manifest.launch.env.contains_key("ENGINE_KEY"));
    assert_eq!(manifest.probe, draft.probe);
    assert_eq!(providers::registry::launch_prefix(&manifest), prefix);

    // Binding spellings must be documented by the discovered help.
    let mut typo = draft.clone();
    typo.model = ArgBinding::Flag {
        flag: "--modle".into(),
        equals: false,
    };
    let typo_manifest = providers::registry::manifest_from_draft(&typo).unwrap();
    assert!(
        runtime_schema::draft_acceptance(&root, &typo, &typo_manifest)
            .unwrap_err()
            .contains("--modle")
    );
    // A draft whose engine changed after discovery is refused.
    let mut moved = draft.clone();
    moved
        .environment
        .insert("FAKE_ENGINE_HELP".into(), "v2".into());
    let moved_manifest = providers::registry::manifest_from_draft(&moved).unwrap();
    assert!(
        runtime_schema::draft_acceptance(&root, &moved, &moved_manifest)
            .unwrap_err()
            .contains("changed")
    );

    // Register; the pre-registration discovery is the accepted help.
    let registered = runtime_schema::register_entrypoint(&root, &draft, None)
        .await
        .unwrap();
    assert_eq!(registered, manifest);
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: engine.as_str().into(),
        active_runtime: "local-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(effective.help_state, HelpState::Current);
    let Value::Object(values) = json!({"fresh_label": "Ünïcode value", "fresh_count": "3"})
    else {
        unreachable!()
    };
    cfg.provider_options.insert(engine.as_str().into(), values);
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let planned = providers::registry::command(&cfg, port, "synthetic-key").unwrap();
    let tail = ["--fresh-count", "3", "--fresh-label", "Ünïcode value"].map(String::from);
    assert!(planned.args.ends_with(&tail), "{:?}", planned.args);
    assert!(planned
        .env
        .iter()
        .any(|(name, value)| name == "SYNTHETIC_API_KEY" && value == "synthetic-key"));

    // The spawned process receives the script prefix and options verbatim.
    let info = providers::execution::info(&cfg).unwrap();
    let err = Arc::new(ErrBuf::default());
    let (child, url, _) = server::spawn(&cfg, "synthetic-key", &err, &Default::default()).unwrap();
    let shared = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut state = shared.lock().unwrap();
        state.child = Some(child);
        state.engine = Some(info);
    }
    server::wait_ready(shared.clone(), &url, "synthetic-key", 5, &err)
        .await
        .unwrap();
    let argv: Vec<String> = serde_json::from_slice(&fs::read(&argv_file).unwrap()).unwrap();
    assert!(argv.starts_with(&prefix), "{argv:?}");
    assert!(argv.ends_with(&tail), "{argv:?}");
    {
        let mut state = shared.lock().unwrap();
        server::kill(&mut state.child, Some(err.clone()));
    }

    // Another script through the same interpreter is not this engine's help.
    let mut other_args = prefix.clone();
    other_args[0] = other_script.to_string_lossy().into_owned();
    other_args.push("--help".into());
    assert!(runtime_schema::help_command(
        &cfg,
        &HelpRequest {
            program: None,
            args: other_args,
            scope: vec![],
        }
    )
    .unwrap_err()
    .contains("entry point"));
    // Editing the declared script is detected before anything runs.
    fs::write(&script, b"synthetic entry script v2").unwrap();
    assert!(providers::registry::command(&cfg, port, "synthetic-key")
        .unwrap_err()
        .contains("changed"));
}
