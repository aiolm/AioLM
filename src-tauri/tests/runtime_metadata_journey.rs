//! Explicit option metadata embedded in a synthetic engine's manifest, from
//! registration through reviewed help to the effective schema, validation,
//! the saved profile and the argv its spawned process actually receives.
//! Foreign, unknown-version and malformed metadata is refused; a metadata
//! change invalidates the reviewed help and model probe instead of reusing
//! them. The option names are fresh; no app code knows them. No inference
//! claims.
use aiolm_lib::{
    providers::{
        self,
        runtime_help::HelpService,
        runtime_help_store, runtime_metadata,
        runtime_schema::{self, HelpState},
    },
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
            std::env::temp_dir().join(format!("aiolm-metadata-journey-{}", uuid::Uuid::new_v4()));
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

const ENGINE: &str = "custom.metadatafixture";
/// A synthetic value of an option only metadata marks sensitive.
const AMBER: &str = "amber-7Q-synthetic-value";
/// A synthetic value of a manifest option another runtime marks sensitive.
const LABEL: &str = "label-9K-synthetic-value";

/// `aiolm-cli config get` against this test home, as a user would run it.
fn cli_config(home: &Path) -> String {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aiolm-cli"))
        .args(["config", "get"])
        .env("AIOLM_HOME", home)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).unwrap()
}

fn manifest(area: &Path, argv_file: &Path, metadata: Option<Value>) -> Value {
    let program = env!("CARGO_BIN_EXE_fake-llama-server");
    let env = json!({"FAKE_ENGINE_ARGV_FILE": argv_file, "FAKE_ENGINE_HELP": "metadata"});
    let mut manifest = json!({
        "schema_version": 1, "adapter_version": 1, "engine_id": ENGINE, "runtime_id": "build-1",
        "display_name": "Synthetic metadata engine", "protocol": "openai-v1",
        "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
        "probe": {"program": program, "args": ["--adapter-probe", ENGINE, "build-1", "{model}", "{options_json}"], "env": env, "working_directory": area},
        "launch": {"program": program, "args": ["--adapter-engine", "--adapter-no-health-auth", "--model", "{model}", "--host", "{host}", "--port", "{port}"], "env": env, "working_directory": area},
        "model_formats": ["unknown"], "health_path": "/health"
    });
    if let Some(metadata) = metadata {
        manifest["option_metadata"] = metadata;
    }
    manifest
}

/// Adapter metadata describing what the synthetic help leaves unknown, plus
/// declarations the help contradicts or does not contain.
fn metadata(revision: &str, unit: &str) -> Value {
    json!({
        "version": 1, "engine_id": ENGINE,
        "adapter": {"id": "synthetic.adapter", "revision": revision},
        "options": [
            {"flag": "--fresh-secret", "sensitive": true, "restart_required": true},
            {"flag": "--fresh-cache", "kind": "integer", "range": {"min": 0, "max": 4096}, "unit": unit,
             "restart_required": true, "runtime_default": {"literal": 256}},
            {"flag": "--fresh-count", "kind": "integer"},
            {"flag": "--fresh-mode", "choices": ["fast", "exact"]},
            {"flag": "--absent-flag", "sensitive": true},
            {"flag": "--port", "sensitive": true},
            // A name with no secret-like word: only the metadata says so.
            {"flag": "--fresh-amber", "sensitive": true}
        ],
        "constraints": [
            {"kind": "requires", "when": {"flag": "--fresh-switch"}, "other": {"flag": "--fresh-cache"}}
        ]
    })
}

async fn register(area: &Path, manifest: &Value) -> Result<(), String> {
    let source = area.join("runtime.json");
    fs::write(&source, serde_json::to_vec(manifest).unwrap()).unwrap();
    providers::registry::register(&source, None)
        .await
        .map(|_| ())
}

fn engine() -> providers::ProviderId {
    providers::ProviderId::parse(ENGINE).unwrap()
}

fn saved(cfg: &mut AppConfig, values: Value) {
    let Value::Object(values) = values else {
        unreachable!()
    };
    cfg.provider_options.insert(ENGINE.into(), values);
}

fn issues(cfg: &AppConfig) -> Vec<String> {
    let manifest = providers::registry::manifest(engine(), "build-1").unwrap();
    providers::registry::saved_option_issues(
        cfg,
        &manifest,
        cfg.provider_options.get(ENGINE).unwrap_or(&Map::new()),
    )
    .into_iter()
    .map(|issue| format!("{}:{}:{}", issue.key, issue.code, issue.message))
    .collect()
}

fn request() -> runtime_schema::HelpRequest {
    runtime_schema::HelpRequest {
        program: None,
        args: vec![
            "--adapter-engine".into(),
            "--adapter-no-health-auth".into(),
            "--adapter-help-fixture".into(),
            "--help".into(),
        ],
        scope: vec![],
    }
}

fn discover_and_accept(root: &Path, cfg: &AppConfig) -> String {
    let command = runtime_schema::help_command(cfg, &request()).unwrap();
    // The help command's identity names the exact metadata it is reviewed with.
    let metadata = runtime_schema::selected_metadata(cfg).unwrap().unwrap().0;
    assert!(command.runtime_version.ends_with(&metadata.digest()));
    let (_, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        root,
        "metadata-owner",
        ENGINE,
        "build-1",
        &command,
        &[],
        runtime_help_store::Baseline::Accepted(None),
    )
    .unwrap();
    // Before acceptance, the review shows what the metadata establishes on
    // this help and what the help contradicts; nothing is applied yet.
    let review = runtime_metadata::review(&descriptor.schema, &metadata, false);
    assert!(
        review.applied.contains(&"fresh_secret".to_string()),
        "{review:?}"
    );
    assert!(review
        .conflicts
        .iter()
        .any(|c| c.flag == "--fresh-mode" && c.field == "choices"));
    assert!(descriptor
        .schema
        .options
        .iter()
        .all(|option| option.sensitive.supported().is_none()));
    runtime_schema::accept(root, cfg, &descriptor.fingerprint, &request()).unwrap();
    descriptor.fingerprint
}

fn by_flag(effective: &Value, flag: &str) -> Value {
    effective["schema"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|option| {
            option["spellings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["flag"] == flag)
        })
        .unwrap_or_else(|| panic!("{flag}"))
        .clone()
}

#[tokio::test]
async fn manifest_option_metadata_reaches_the_schema_validation_profile_and_spawned_argv() {
    let area = TestHome::new();
    let model = area.path.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let argv_file = area.path.join("argv.json");

    // Foreign, unknown-version, malformed or inconsistent metadata is refused
    // and registers nothing.
    for (change, needle) in [
        (json!({"version": 2}), "option metadata version 2"),
        (json!({"engine_id": "custom.otherengine"}), "another engine"),
        (
            json!({"adapter": {"id": "", "revision": "r1"}}),
            "provenance",
        ),
        (
            json!({"adapter": {"id": "synthetic.adapter", "revision": ""}}),
            "provenance",
        ),
        (
            json!({"options": [{"flag": "--fresh-secret", "request_field": "secret"}]}),
            "unknown field",
        ),
        (
            json!({"options": [{"flag": "--fresh-cache", "range": {"min": 0, "max": 1}}]}),
            "range",
        ),
        (
            json!({"options": [{"flag": "--fresh-cache", "kind": "integer", "runtime_default": {"literal": "big"}}]}),
            "default",
        ),
        (json!({"options": [{"flag": "--fresh-cache"}]}), "no fact"),
        (
            json!({"options": [{"flag": "fresh-cache", "sensitive": true}]}),
            "flag",
        ),
    ] {
        let mut bad = metadata("r1", "MiB");
        for (key, value) in change.as_object().unwrap() {
            bad[key] = value.clone();
        }
        let error = register(&area.path, &manifest(&area.path, &argv_file, Some(bad)))
            .await
            .unwrap_err();
        assert!(error.contains(needle), "{needle}: {error}");
        assert!(providers::registry::manifest(engine(), "build-1").is_err());
    }
    // A manifest without metadata keeps its exact earlier serialization.
    let legacy: providers::registry::RuntimeManifest =
        serde_json::from_value(manifest(&area.path, &argv_file, None)).unwrap();
    assert!(serde_json::to_value(&legacy)
        .unwrap()
        .get("option_metadata")
        .is_none());

    register(
        &area.path,
        &manifest(&area.path, &argv_file, Some(metadata("r1", "MiB"))),
    )
    .await
    .unwrap();
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: ENGINE.into(),
        active_runtime: "build-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    let root = providers::registry::root();
    discover_and_accept(&root, &cfg);

    // The effective schema carries the adapter facts with their provenance;
    // help observations win where they differ and every difference is shown.
    let effective =
        serde_json::to_value(runtime_schema::effective(&root, &cfg, true).unwrap()).unwrap();
    assert_eq!(effective["help_state"], "current");
    let adapter = json!({"kind": "adapter", "id": "synthetic.adapter", "revision": "r1"});
    let secret = by_flag(&effective, "--fresh-secret");
    assert_eq!(secret["sensitive"]["value"], true);
    assert_eq!(secret["sensitive"]["source"], adapter);
    assert_eq!(secret["restart_required"]["value"], true);
    let cache = by_flag(&effective, "--fresh-cache");
    assert_eq!(cache["kind"]["value"], "integer");
    assert_eq!(cache["range"]["value"], json!({"min": 0.0, "max": 4096.0}));
    assert_eq!(cache["unit"]["value"], "MiB");
    assert_eq!(cache["runtime_default"]["value"], json!({"literal": 256}));
    assert_eq!(
        cache["arity"]["source"]["kind"], "help",
        "syntax stays observed"
    );
    let mode = by_flag(&effective, "--fresh-mode");
    assert_eq!(mode["choices"]["value"], json!(["fast", "safe"]));
    assert_eq!(mode["choices"]["source"]["kind"], "help");
    let port_option = by_flag(&effective, "--port");
    assert!(port_option["managed"].is_string());
    assert_ne!(port_option["sensitive"]["value"], true);
    let view = &effective["metadata"];
    assert_eq!(view["adapter"], "synthetic.adapter");
    assert_eq!(view["revision"], "r1");
    let conflict = |flag: &str, field: &str| {
        view["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["flag"] == flag && c["field"] == field && c["applies"] == "observed")
    };
    assert!(conflict("--fresh-mode", "choices"), "{view:#}");
    assert!(conflict("--absent-flag", "option"), "{view:#}");
    assert!(conflict("--port", "binding"), "{view:#}");
    assert_eq!(
        effective["schema"]["constraints"].as_array().unwrap().len(),
        1
    );

    // One validator: typed, ranged, constrained and observed choices.
    for (values, needle) in [
        (json!({"fresh_cache": 5000}), "fresh_cache:"),
        (json!({"fresh_cache": "512"}), "fresh_cache:"),
        (json!({"fresh_switch": true}), "requires"),
        (json!({"fresh_mode": "exact"}), "fresh_mode:"),
        (json!({"fresh_count": "two"}), "fresh_count:"),
    ] {
        saved(&mut cfg, values.clone());
        let found = issues(&cfg);
        assert!(
            found.iter().any(|issue| issue.contains(needle)),
            "{values}: {found:?}"
        );
    }

    let values = json!({
        "fresh_secret": "synthetic-secret-value", "fresh_cache": 512,
        "fresh_switch": true, "fresh_mode": "safe", "fresh_count": 0,
        "fresh_amber": AMBER
    });
    saved(&mut cfg, values.clone());
    assert!(issues(&cfg).is_empty(), "{:?}", issues(&cfg));
    aiolm_lib::config::save(&cfg).unwrap();
    let loaded = aiolm_lib::config::load_result().unwrap();
    assert_eq!(
        Value::Object(loaded.provider_options[ENGINE].clone()),
        values
    );
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let expected_tail = [
        "--fresh-count",
        "0",
        "--fresh-switch",
        "--fresh-secret",
        "synthetic-secret-value",
        "--fresh-cache",
        "512",
        "--fresh-mode",
        "safe",
        "--fresh-amber",
        AMBER,
    ]
    .map(String::from);
    let planned = providers::registry::command(&loaded, port, "synthetic-key").unwrap();
    assert!(planned.args.ends_with(&expected_tail), "{:?}", planned.args);
    // Display and record projections hide schema-secret values; the launch
    // argv above keeps them exactly.
    let preview = providers::command_preview(&loaded).unwrap();
    assert!(
        !preview.iter().any(|arg| arg.contains(AMBER)),
        "{preview:?}"
    );
    assert!(!preview
        .iter()
        .any(|arg| arg.contains("synthetic-secret-value")));
    assert!(
        preview.ends_with(&["--fresh-amber".into(), "[REDACTED]".into()]),
        "{preview:?}"
    );
    assert!(
        preview.contains(&"512".to_string()),
        "other values stay readable"
    );
    let shown = cli_config(&area.path);
    assert!(!shown.contains(AMBER), "{shown}");
    assert!(shown.contains("fresh_amber"), "{shown}");
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

    // Changed metadata under the same runtime ID invalidates the reviewed
    // help and the model probe; the saved values stay exactly as they were.
    providers::registry::remove(engine(), "build-1").unwrap();
    register(
        &area.path,
        &manifest(&area.path, &argv_file, Some(metadata("r2", "GiB"))),
    )
    .await
    .unwrap();
    let stale = runtime_schema::effective(&root, &loaded, true).unwrap();
    assert_eq!(stale.help_state, HelpState::Stale);
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let error = providers::registry::command(&loaded, port, "synthetic-key").unwrap_err();
    assert!(error.contains("retained"), "{error}");
    assert_eq!(
        Value::Object(aiolm_lib::config::load_result().unwrap().provider_options[ENGINE].clone()),
        values
    );
    // While the reviewed help is stale the stored secret stays hidden.
    let shown = cli_config(&area.path);
    assert!(!shown.contains(AMBER), "{shown}");
    discover_and_accept(&root, &loaded);
    assert!(providers::registry::command(&loaded, port, "synthetic-key")
        .unwrap_err()
        .contains("fresh adapter probe"));
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let planned = providers::registry::command(&loaded, port, "synthetic-key").unwrap();
    assert!(planned.args.ends_with(&expected_tail), "{:?}", planned.args);
    let renewed =
        serde_json::to_value(runtime_schema::effective(&root, &loaded, true).unwrap()).unwrap();
    assert_eq!(by_flag(&renewed, "--fresh-cache")["unit"]["value"], "GiB");
    assert_eq!(renewed["metadata"]["revision"], "r2");

    // A second runtime of the same engine declares another option secret,
    // through a manifest option it describes without any reviewed help.
    let mut second = manifest(
        &area.path,
        &argv_file,
        Some(json!({"version": 1, "engine_id": ENGINE,
            "adapter": {"id": "synthetic.adapter", "revision": "r3"},
            "options": [{"flag": "--fresh-label", "sensitive": true}]})),
    );
    second["runtime_id"] = json!("build-2");
    second["probe"]["args"][2] = json!("build-2");
    second["options"] = json!([{"key": "label_text", "flag": "--fresh-label", "target": "launch", "kind": {"type": "text", "max_len": 64}}]);
    register(&area.path, &second).await.unwrap();
    // Switching to another engine keeps this engine's values and profiles;
    // public projections still hide every value its runtimes declare secret.
    let mut away = loaded.clone();
    let mut kept = values.as_object().unwrap().clone();
    kept.insert("label_text".into(), json!(LABEL));
    away.provider_options.insert(ENGINE.into(), kept.clone());
    away.active_provider = "llama.cpp".into();
    away.active_runtime.clear();
    aiolm_lib::config::save(&away).unwrap();
    let shown = cli_config(&area.path);
    for secret in [AMBER, LABEL, "synthetic-secret-value"] {
        assert!(!shown.contains(secret), "{secret}: {shown}");
    }
    assert!(shown.contains("fresh_amber") && shown.contains("label_text"));
    assert!(shown.contains("\"fresh_cache\": 512"), "{shown}");
    // Stored values are untouched.
    assert_eq!(
        aiolm_lib::config::load_result().unwrap().provider_options[ENGINE],
        kept
    );
}
