//! Help to launched argv for a synthetic registered engine: adapter-derived
//! help command, discovery, explicit acceptance, saved profile values, the
//! actual spawned process argv, app-owned binding refusal and a rebuilt
//! runtime that invalidates the reviewed help while keeping saved values.
//! The option names are fresh; no app code knows them. No inference claims.
use aiolm_lib::{
    providers::{
        self,
        registry::{Platform, ProcessSpec, RuntimeManifest},
        runtime_help::HelpService,
        runtime_help_store::{self, Baseline},
        runtime_schema::{self, HelpRequest, HelpState},
    },
    server, AppConfig, ErrBuf,
};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

struct TestHome {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl TestHome {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("aiolm-help-journey-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // This integration binary contains one test, so no concurrent test
        // reads this environment mutation.
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

fn manifest(
    engine: providers::ProviderId,
    area: &Path,
    argv_file: &Path,
    help_mode: &str,
) -> RuntimeManifest {
    let program = PathBuf::from(env!("CARGO_BIN_EXE_fake-llama-server"));
    let process = ProcessSpec {
        program: program.to_string_lossy().into_owned(),
        args: vec![],
        env: BTreeMap::from([
            (
                "FAKE_ENGINE_ARGV_FILE".to_string(),
                argv_file.to_string_lossy().into_owned(),
            ),
            ("FAKE_ENGINE_HELP".to_string(), help_mode.to_string()),
        ]),
        working_directory: Some(area.to_string_lossy().into_owned()),
    };
    RuntimeManifest {
        schema_version: 1,
        adapter_version: 1,
        launch_bindings: None,
        bridge_command: None,
        engine_id: engine,
        runtime_id: "build-1".into(),
        display_name: "Synthetic help engine".into(),
        platforms: vec![Platform {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
        }],
        protocol: "openai-v1".into(),
        probe: ProcessSpec {
            args: vec![
                "--adapter-probe".into(),
                engine.as_str().into(),
                "build-1".into(),
                "{model}".into(),
                "{options_json}".into(),
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
        options: vec![serde_json::from_value(json!({
            "key": "workers", "flag": "--workers", "target": "launch",
            "kind": {"type": "integer", "min": 1, "max": 8}
        }))
        .unwrap()],
        artifacts: vec![],
        model_formats: vec!["unknown".into()],
        models: vec![],
        health_path: "/health".into(),
        health_authenticated: false,
    }
}

async fn register(area: &Path, manifest: &RuntimeManifest) {
    let source = area.join("runtime.json");
    fs::write(&source, serde_json::to_vec(manifest).unwrap()).unwrap();
    providers::registry::register(&source, None).await.unwrap();
}

fn saved(cfg: &mut AppConfig, engine: &str, values: Value) {
    let Value::Object(values) = values else {
        unreachable!()
    };
    cfg.provider_options.insert(engine.into(), values);
}

fn issues(cfg: &AppConfig, manifest: &RuntimeManifest) -> Vec<String> {
    providers::registry::saved_option_issues(
        cfg,
        manifest,
        cfg.provider_options
            .get(manifest.engine_id.as_str())
            .unwrap_or(&Map::new()),
    )
    .into_iter()
    .map(|issue| format!("{}:{}:{}", issue.key, issue.code, issue.message))
    .collect()
}

#[tokio::test]
async fn accepted_help_options_reach_the_launched_engine_argv() {
    let area = TestHome::new();
    let engine = providers::ProviderId::parse("custom.helpfixture").unwrap();
    let model = area.path.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let argv_file = area.path.join("argv.json");
    let v1 = manifest(engine, &area.path, &argv_file, "v1");
    register(&area.path, &v1).await;
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: engine.as_str().into(),
        active_runtime: "build-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    let root = providers::registry::root();

    // A value no reviewed help describes is reported, retained and blocks
    // launch instead of being dropped or emitted.
    saved(&mut cfg, engine.as_str(), json!({"fresh_count": "0"}));
    assert!(issues(&cfg, &v1)
        .iter()
        .any(|issue| issue.starts_with("fresh_count:unknown")));
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let error = providers::registry::command(&cfg, port, "synthetic-key").unwrap_err();
    assert!(
        error.contains("fresh_count") && error.contains("accept its help"),
        "{error}"
    );

    // The adapter derives the help command: launch program, its entry prefix,
    // literal adapter environment; never templated credentials or ports.
    let target = runtime_schema::help_target(&root, &cfg).unwrap();
    assert!(!target.fixed);
    // The entry prefix is the exact launch token sequence before the first
    // app-owned binding, not a guess at the first option.
    assert_eq!(
        target.prefix,
        ["--adapter-engine", "--adapter-no-health-auth"]
    );
    assert_eq!(target.program, v1.launch.program);
    let request = HelpRequest {
        program: None,
        args: vec![
            "--adapter-engine".into(),
            "--adapter-no-health-auth".into(),
            "--adapter-help-fixture".into(),
            "--help".into(),
        ],
        scope: vec![],
    };
    let command = runtime_schema::help_command(&cfg, &request).unwrap();
    assert_eq!(
        command
            .environment
            .get("FAKE_ENGINE_HELP")
            .map(String::as_str),
        Some("v1")
    );
    assert!(command
        .environment
        .values()
        .all(|value| !value.contains('{')));
    let foreign = HelpRequest {
        program: Some(area.path.join("other.exe").to_string_lossy().into_owned()),
        ..request.clone()
    };
    assert!(runtime_schema::help_command(&cfg, &foreign).is_err());
    let unprefixed = HelpRequest {
        args: vec!["--adapter-help-fixture".into(), "--help".into()],
        ..request.clone()
    };
    assert!(runtime_schema::help_command(&cfg, &unprefixed)
        .unwrap_err()
        .contains("entry point"));

    // Discovery alone changes nothing: help success is not acceptance and
    // establishes no protocol or capability.
    let service = HelpService::default();
    let (report, descriptor) = runtime_help_store::discover_against(
        &service,
        &root,
        "test-owner",
        engine.as_str(),
        "build-1",
        &command,
        &[],
        Baseline::Accepted(None),
    )
    .unwrap();
    assert!(report.complete());
    assert_eq!(
        runtime_schema::effective(&root, &cfg, true)
            .unwrap()
            .help_state,
        HelpState::None
    );
    runtime_schema::accept(&root, &cfg, &descriptor.fingerprint, &request).unwrap();
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(effective.help_state, HelpState::Current);
    let option = |key: &str| {
        effective
            .schema
            .options
            .iter()
            .find(|option| option.key == key)
            .unwrap_or_else(|| panic!("missing {key}"))
    };
    for fresh in ["fresh_count", "fresh_label", "fresh_pair", "fresh_switch"] {
        assert!(option(fresh).managed.is_none(), "{fresh}");
    }
    // App-owned bindings come from the launch template: every spelling of a
    // bound option (the -p alias of --port) and every positional slot.
    for owned in ["model", "host", "port"] {
        assert!(option(owned).managed.is_some(), "{owned}");
    }
    assert!(effective
        .schema
        .options
        .iter()
        .filter(|option| option.position.is_some())
        .all(|option| option.managed.is_some()));

    // Explicit zero, explicit empty text, a fixed tuple keeping spaces and
    // Unicode as single arguments, and a switch, in the stored profile shapes.
    let values = json!({
        "workers": 2,
        "fresh_count": "0",
        "fresh_label": "",
        "fresh_pair": {"spelling": null, "occurrences": [["x y", "한글"]]},
        "fresh_switch": true
    });
    saved(&mut cfg, engine.as_str(), values.clone());
    assert!(issues(&cfg, &v1).is_empty(), "{:?}", issues(&cfg, &v1));
    cfg.validate().unwrap();
    aiolm_lib::config::save(&cfg).unwrap();
    let loaded = aiolm_lib::config::load_result().unwrap();
    assert_eq!(
        Value::Object(loaded.provider_options[engine.as_str()].clone()),
        values
    );
    // Manifest and help options resolve together, in schema order.
    let expected_tail = [
        "--workers",
        "2",
        "--fresh-count",
        "0",
        "--fresh-label",
        "",
        "--fresh-pair",
        "x y",
        "한글",
        "--fresh-switch",
    ];
    // Changed launch options need a fresh model probe, like any launch change.
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let planned = providers::registry::command(&loaded, port, "synthetic-key").unwrap();
    assert!(
        planned.args.ends_with(&expected_tail.map(String::from)),
        "{:?}",
        planned.args
    );

    // The real process receives exactly those arguments.
    let info = providers::execution::info(&loaded).unwrap();
    let err = Arc::new(ErrBuf::default());
    let (child, url, _) =
        server::spawn(&loaded, "synthetic-key", &err, &Default::default()).unwrap();
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
    assert!(argv.ends_with(&expected_tail.map(String::from)), "{argv:?}");
    assert!(argv
        .windows(2)
        .any(|pair| pair[0] == "--port" && pair[1] == port.to_string()));
    {
        let mut state = shared.lock().unwrap();
        server::kill(&mut state.child, Some(err.clone()));
    }

    // App-owned bindings cannot be set generically, through any spelling.
    let mut owned = loaded.clone();
    saved(
        &mut owned,
        engine.as_str(),
        json!({"port": {"spelling": "-p", "occurrences": [["1"]]}}),
    );
    assert!(issues(&owned, &v1)
        .iter()
        .any(|issue| issue.starts_with("port:help") && issue.contains("managed")));
    assert!(providers::registry::command(&owned, port, "synthetic-key").is_err());

    // A rebuilt runtime under the same ID (here: a changed adapter
    // environment) invalidates the reviewed help. Launch is refused and the
    // saved values stay exactly as they were.
    providers::registry::remove(engine, "build-1").unwrap();
    let v2 = manifest(engine, &area.path, &argv_file, "v2");
    register(&area.path, &v2).await;
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let stale = runtime_schema::effective(&root, &loaded, true).unwrap();
    assert_eq!(stale.help_state, HelpState::Stale);
    let error = providers::registry::command(&loaded, port, "synthetic-key").unwrap_err();
    assert!(
        error.contains("changed") && error.contains("retained"),
        "{error}"
    );
    assert_eq!(
        Value::Object(
            aiolm_lib::config::load_result().unwrap().provider_options[engine.as_str()].clone()
        ),
        values
    );
    // Rediscovery is compared with the reviewed help, then accepted again.
    let old = runtime_help_store::load_snapshot(
        &root,
        engine.as_str(),
        "build-1",
        &descriptor.fingerprint,
    )
    .unwrap();
    let command = runtime_schema::help_command(&loaded, &request).unwrap();
    let (_, review) = runtime_help_store::discover_against(
        &service,
        &root,
        "test-owner",
        engine.as_str(),
        "build-1",
        &command,
        &loaded.provider_options[engine.as_str()]
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        Baseline::Accepted(old.map(Box::new)),
    )
    .unwrap();
    assert!(review
        .diff
        .as_ref()
        .unwrap()
        .added
        .contains(&"fresh_extra".to_string()));
    runtime_schema::accept(&root, &loaded, &review.fingerprint, &request).unwrap();
    // The reviewed help is part of the launch identity: a fresh model probe
    // is required before the changed runtime runs.
    assert!(providers::registry::command(&loaded, port, "synthetic-key")
        .unwrap_err()
        .contains("fresh adapter probe"));
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let planned = providers::registry::command(&loaded, port, "synthetic-key").unwrap();
    assert!(planned.args.ends_with(&expected_tail.map(String::from)));

    // The managed native adapter uses the same reviewed schema, and its
    // profile snapshot keeps new options without copying another engine's map.
    let native_dir = aiolm_lib::runtime::runtime_dir("cpu", "b1").unwrap();
    fs::create_dir_all(&native_dir).unwrap();
    let native_bin = native_dir.join(aiolm_lib::runtime::server_executable_name());
    fs::copy(env!("CARGO_BIN_EXE_fake-llama-server"), &native_bin).unwrap();
    let mut native = AppConfig {
        active_backend: "cpu".into(),
        active_build: "b1".into(),
        active_model: model.to_string_lossy().into_owned(),
        ..Default::default()
    };
    let native_request = runtime_schema::help_target(&root, &native).unwrap().request;
    let command = runtime_schema::help_command(&native, &native_request).unwrap();
    let key = runtime_schema::runtime_key(&native).unwrap();
    let (_, descriptor) = runtime_help_store::discover_against(
        &service,
        &root,
        "native-test-owner",
        &key.engine,
        &key.runtime,
        &command,
        &[],
        Baseline::Accepted(None),
    )
    .unwrap();
    runtime_schema::accept(&root, &native, &descriptor.fingerprint, &native_request).unwrap();
    saved(
        &mut native,
        "llama.cpp",
        json!({"fixture_native_value":"한글 native value"}),
    );
    native.validate().unwrap();
    let native_plan = providers::adapter::resolve(&native)
        .launch(&native, port, "synthetic-key", &Default::default())
        .unwrap();
    assert!(native_plan
        .args
        .ends_with(&["--fixture-native-value".into(), "한글 native value".into()]));
    let mut owned = native.clone();
    saved(&mut owned, "llama.cpp", json!({"port":"9000"}));
    assert!(providers::adapter::resolve(&owned)
        .launch(&owned, port, "", &Default::default())
        .is_err());
    // Changing the selected build retains the saved map but cannot reuse acceptance.
    native.active_build = "b2".into();
    assert!(providers::adapter::resolve(&native)
        .launch(&native, port, "", &Default::default())
        .is_err());
}
