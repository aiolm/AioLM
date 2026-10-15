//! Manifest option declarations against a synthetic engine's reviewed help:
//! a declaration whose value count contradicts the observed syntax blocks
//! launch with the saved value retained, while an alias spelled under a
//! different key or different documented choices are shown without breaking
//! the legacy key mapping or a valid launch. No inference claims.
use aiolm_lib::{
    providers::{self, runtime_help::HelpService, runtime_help_store, runtime_schema},
    server, AppConfig, ErrBuf,
};
use serde_json::{json, Map, Value};
use std::{
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
            std::env::temp_dir().join(format!("aiolm-conflict-journey-{}", uuid::Uuid::new_v4()));
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

fn manifest(engine: &str, area: &Path, argv_file: &Path) -> Value {
    let program = env!("CARGO_BIN_EXE_fake-llama-server");
    let env = json!({"FAKE_ENGINE_ARGV_FILE": argv_file, "FAKE_ENGINE_HELP": "metadata"});
    json!({
        "schema_version": 1, "adapter_version": 1, "engine_id": engine, "runtime_id": "build-1",
        "display_name": "Synthetic conflict engine", "protocol": "openai-v1",
        "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
        "probe": {"program": program, "args": ["--adapter-probe", engine, "build-1", "{model}", "{options_json}"], "env": env, "working_directory": area},
        "launch": {"program": program, "args": ["--adapter-engine", "--adapter-no-health-auth", "--model", "{model}", "--host", "{host}", "--port", "{port}"], "env": env, "working_directory": area},
        "options": [
            // Help shows a switch; this declaration would emit a value.
            {"key": "fresh_switch", "flag": "--fresh-switch", "target": "launch", "kind": {"type": "text", "max_len": 64}},
            // An alias the help names fresh_label.
            {"key": "label", "flag": "--fresh-label", "target": "launch", "kind": {"type": "text", "max_len": 64}},
            // Stored under another key; declares a choice help does not list.
            {"key": "speed", "flag": "--fresh-mode", "target": "launch", "kind": {"type": "choice", "choices": ["fast", "exact"]}},
            {"key": "workers", "flag": "--workers", "target": "launch", "kind": {"type": "integer", "min": 1, "max": 8}}
        ],
        "model_formats": ["unknown"], "health_path": "/health",
        // A relation the reviewed help cannot honor (its other side is absent).
        // The mode value is declared secret: diagnostics must not print it.
        "option_metadata": {"version": 1, "engine_id": engine, "adapter": {"id": "synthetic.adapter", "revision": "r1"},
            "options": [{"flag": "--fresh-mode", "sensitive": true}],
            "constraints": [{"kind": "requires", "when": {"flag": "--fresh-count"}, "other": {"flag": "--gone-flag"}}]}
    })
}

fn saved(cfg: &mut AppConfig, engine: &str, values: Value) {
    let Value::Object(values) = values else {
        unreachable!()
    };
    cfg.provider_options.insert(engine.into(), values);
}

fn issues(cfg: &AppConfig, engine: providers::ProviderId) -> Vec<String> {
    let manifest = providers::registry::manifest(engine, "build-1").unwrap();
    providers::registry::saved_option_issues(
        cfg,
        &manifest,
        cfg.provider_options
            .get(engine.as_str())
            .unwrap_or(&Map::new()),
    )
    .into_iter()
    .map(|issue| format!("{}:{}:{}", issue.key, issue.code, issue.message))
    .collect()
}

#[tokio::test]
async fn declared_option_facts_that_contradict_reviewed_help_are_shown_and_unsafe_ones_block() {
    let area = TestHome::new();
    let engine = providers::ProviderId::parse("custom.conflictfixture").unwrap();
    let model = area.path.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let argv_file = area.path.join("argv.json");
    let source = area.path.join("runtime.json");
    fs::write(
        &source,
        serde_json::to_vec(&manifest(engine.as_str(), &area.path, &argv_file)).unwrap(),
    )
    .unwrap();
    providers::registry::register(&source, None).await.unwrap();
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
    let request = runtime_schema::HelpRequest {
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
    let (_, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        &root,
        "conflict-owner",
        engine.as_str(),
        "build-1",
        &command,
        &[],
        runtime_help_store::Baseline::Accepted(None),
    )
    .unwrap();
    runtime_schema::accept(&root, &cfg, &descriptor.fingerprint, &request).unwrap();

    // Every difference is shown with its provenance and which side applies.
    let effective =
        serde_json::to_value(runtime_schema::effective(&root, &cfg, true).unwrap()).unwrap();
    let conflicts = effective["conflicts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let find = |flag: &str, field: &str| {
        conflicts
            .iter()
            .find(|c| c["flag"] == flag && c["field"] == field)
            .unwrap_or_else(|| panic!("{flag} {field}: {conflicts:#?}"))
            .clone()
    };
    let arity = find("--fresh-switch", "arity");
    assert_eq!(arity["observed"], json!({"min": 0, "max": 0}));
    assert_eq!(arity["declared"], json!({"min": 1, "max": 1}));
    assert_eq!(arity["blocking"], true);
    assert!(arity["declared_by"]
        .as_str()
        .unwrap()
        .contains("custom.conflictfixture"));
    let alias = find("--fresh-label", "key");
    assert_eq!(alias["observed"], "fresh_label");
    assert_eq!(alias["declared"], "label");
    assert_eq!(alias["blocking"], false);
    assert_eq!(alias["applies"], "declared");
    let choices = find("--fresh-mode", "choices");
    assert_eq!(choices["observed"], json!(["fast", "safe"]));
    assert_eq!(choices["declared"], json!(["fast", "exact"]));
    assert_eq!(choices["key"], "speed");
    // A saved value the help does not list is refused; listed ones launch.
    assert_eq!(choices["blocking"], true);
    assert_eq!(find("--fresh-mode", "key")["blocking"], false);
    // The legacy key mapping stays in effect: help rows remain shadowed.
    assert!(effective["shadowed"]
        .as_array()
        .unwrap()
        .contains(&json!("fresh_label")));

    // A saved value the declaration would serialize against the observed
    // syntax blocks validation and launch; the value itself is retained.
    let unsafe_values = json!({"fresh_switch": "on", "workers": 2});
    saved(&mut cfg, engine.as_str(), unsafe_values.clone());
    let found = issues(&cfg, engine);
    let blocking = found
        .iter()
        .find(|issue| issue.starts_with("fresh_switch:conflict:"))
        .unwrap_or_else(|| panic!("{found:?}"));
    assert!(
        blocking.contains("retained") && blocking.contains("Remove the saved value"),
        "{blocking}"
    );
    // A saved order that includes the refused value is not reported as
    // describing an unknown option; the one reason stays the conflict.
    let mut ordered = cfg.clone();
    let mut values_with_order = unsafe_values.clone();
    values_with_order["@option_order"] =
        json!({"version": 1, "occurrences": [{"key": "workers"}, {"key": "fresh_switch"}]});
    saved(&mut ordered, engine.as_str(), values_with_order);
    let found = issues(&ordered, engine);
    assert!(
        found
            .iter()
            .any(|i| i.starts_with("fresh_switch:conflict:"))
            && !found.iter().any(|i| i.starts_with("@option_order")),
        "{found:?}"
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let error = providers::registry::command(&cfg, port, "synthetic-key").unwrap_err();
    assert!(error.contains("--fresh-switch"), "{error}");
    aiolm_lib::config::save(&cfg).unwrap();
    assert_eq!(
        Value::Object(
            aiolm_lib::config::load_result().unwrap().provider_options[engine.as_str()].clone()
        ),
        unsafe_values
    );

    // A declared choice the reviewed help does not list is refused for save,
    // import, preview and launch alike, under its legacy key, and retained.
    let imported = providers::runtime_ordered::import_plan_text_with_syntax(
        &runtime_schema::effective(&root, &cfg, false)
            .unwrap()
            .schema,
        &[],
        "--fresh-mode exact",
        Default::default(),
    )
    .unwrap();
    assert_eq!(imported.plan[0].key, "speed");
    assert_eq!(imported.plan[0].values, [json!("exact")]);
    let outside = json!({"speed": "exact", "workers": 2});
    saved(&mut cfg, engine.as_str(), outside.clone());
    let found = issues(&cfg, engine);
    let refused = found
        .iter()
        .find(|issue| issue.starts_with("speed:conflict:"))
        .unwrap_or_else(|| panic!("{found:?}"));
    assert!(
        refused.contains("fast, safe") && refused.contains("retained"),
        "{refused}"
    );
    // The option is declared secret, so neither the saved value nor the
    // declared choices it came from are printed; the reason still is.
    assert!(!refused.contains("exact"), "{refused}");
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let error = providers::registry::command(&cfg, port, "synthetic-key").unwrap_err();
    assert!(error.contains("--fresh-mode"), "{error}");
    assert_eq!(
        cfg.provider_options[engine.as_str()],
        *outside.as_object().unwrap()
    );

    // An adapter constraint the help cannot honor never silently stops
    // applying: the value it governs is refused with the reason and kept.
    saved(&mut cfg, engine.as_str(), json!({"fresh_count": "1"}));
    let found = issues(&cfg, engine);
    assert!(
        found
            .iter()
            .any(|i| i.starts_with("fresh_count:conflict:") && i.contains("--gone-flag")),
        "{found:?}"
    );

    // Informational differences never break a valid launch: the alias key
    // and the declared choice keep their legacy serialization.
    let values = json!({"label": "x y", "speed": "fast", "workers": 2});
    saved(&mut cfg, engine.as_str(), values.clone());
    assert!(
        issues(&cfg, engine).is_empty(),
        "{:?}",
        issues(&cfg, engine)
    );
    aiolm_lib::config::save(&cfg).unwrap();
    let loaded = aiolm_lib::config::load_result().unwrap();
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let expected_tail = [
        "--fresh-label",
        "x y",
        "--fresh-mode",
        "fast",
        "--workers",
        "2",
    ]
    .map(String::from);
    let planned = providers::registry::command(&loaded, port, "synthetic-key").unwrap();
    assert!(planned.args.ends_with(&expected_tail), "{:?}", planned.args);
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
    assert!(argv.ends_with(&expected_tail), "{argv:?}");
    {
        let mut state = shared.lock().unwrap();
        server::kill(&mut state.child, Some(err.clone()));
    }
}
