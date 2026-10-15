//! Saved command-line order and user-confirmed option syntax, from a
//! synthetic registered engine's reviewed help to the argv its spawned
//! process actually receives. Interleaved occurrences (A1 B2 A3), a
//! different equivalent alias per occurrence, repeated fixed tuples and a
//! value count the help leaves unknown survive save/reload, validation,
//! preview and launch; tampered or newer records and confirmations are
//! refused with the saved values retained, and a rebuilt engine never
//! inherits confirmations made for the previous help. No inference claims.
use aiolm_lib::{
    providers::{
        self,
        registry::{Platform, ProcessSpec, RuntimeManifest},
        runtime_help::HelpService,
        runtime_help_store::{self, Baseline},
        runtime_schema::{self, ConfirmedSyntax, HelpRequest, HelpState},
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
            std::env::temp_dir().join(format!("aiolm-order-journey-{}", uuid::Uuid::new_v4()));
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
        launch_resources: None,
        schema_version: 1,
        adapter_version: 1,
        launch_bindings: None,
        bridge_command: None,
        option_metadata: None,
        engine_id: engine,
        runtime_id: "build-1".into(),
        display_name: "Synthetic order engine".into(),
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

fn saved(cfg: &mut AppConfig, engine: &str, values: &Value) {
    cfg.provider_options
        .insert(engine.into(), values.as_object().unwrap().clone());
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

fn confirmations(entries: Value) -> BTreeMap<String, ConfirmedSyntax> {
    serde_json::from_value(entries).unwrap()
}

fn discover_and_accept(
    service: &HelpService,
    root: &Path,
    cfg: &AppConfig,
    request: &HelpRequest,
) -> String {
    let key = runtime_schema::runtime_key(cfg).unwrap();
    let accepted = runtime_schema::load_accepted(root, &key.engine, &key.runtime).unwrap();
    let baseline = accepted.and_then(|accepted| {
        runtime_help_store::load_snapshot(root, &key.engine, &key.runtime, &accepted.fingerprint)
            .unwrap()
    });
    let command = runtime_schema::help_command(cfg, request).unwrap();
    let (_, descriptor) = runtime_help_store::discover_against(
        service,
        root,
        "order-owner",
        &key.engine,
        &key.runtime,
        &command,
        &[],
        Baseline::Accepted(baseline.map(Box::new)),
    )
    .unwrap();
    runtime_schema::accept(root, cfg, &descriptor.fingerprint, request).unwrap();
    descriptor.fingerprint
}

async fn spawned_argv(cfg: &AppConfig, argv_file: &Path) -> Vec<String> {
    let _ = fs::remove_file(argv_file);
    let info = providers::execution::info(cfg).unwrap();
    let err = Arc::new(ErrBuf::default());
    let (child, url, _) = server::spawn(cfg, "synthetic-key", &err, &Default::default()).unwrap();
    let shared = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut state = shared.lock().unwrap();
        state.child = Some(child);
        state.engine = Some(info);
    }
    server::wait_ready(shared.clone(), &url, "synthetic-key", 5, &err)
        .await
        .unwrap();
    let argv = serde_json::from_slice(&fs::read(argv_file).unwrap()).unwrap();
    let mut state = shared.lock().unwrap();
    server::kill(&mut state.child, Some(err.clone()));
    argv
}

#[tokio::test]
async fn saved_order_and_confirmed_syntax_reach_the_launched_engine_argv() {
    let area = TestHome::new();
    let engine = providers::ProviderId::parse("custom.orderfixture").unwrap();
    let model = area.path.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let argv_file = area.path.join("argv.json");
    let v1 = manifest(engine, &area.path, &argv_file, "order");
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
    let service = HelpService::default();
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
    let fingerprint = discover_and_accept(&service, &root, &cfg, &request);
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(effective.help_state, HelpState::Current);
    let option = |schema: &aiolm_lib::providers::runtime_options::OptionSchema, key: &str| {
        schema
            .options
            .iter()
            .find(|option| option.key == key)
            .unwrap_or_else(|| panic!("missing {key}"))
            .clone()
    };
    // Help states the pair's two values and the tag's alias, but neither
    // repetition nor (with disagreeing aliases) the item count.
    let pair = option(&effective.schema, "fresh_pair");
    assert!(pair.repeatable.supported().is_none());
    assert_eq!(pair.arity.supported().unwrap().min, 2);
    let tag = option(&effective.schema, "fresh_tag");
    assert_eq!(
        tag.spellings
            .iter()
            .map(|s| s.flag.as_str())
            .collect::<Vec<_>>(),
        ["-t", "--fresh-tag"]
    );
    assert!(option(&effective.schema, "fresh_items")
        .arity
        .supported()
        .is_none());

    // A1 B2 A3 with a different equivalent alias per tag occurrence, an
    // explicit zero, a variadic value set and an explicit empty label.
    let values = json!({
        "workers": 2,
        "fresh_pair": {"spelling": null, "occurrences": [["a", "b c"], ["한글", "d"]]},
        "fresh_tag": {"spelling": null, "occurrences": [["x"], ["y"]]},
        "fresh_count": "0",
        "fresh_items": {"spelling": null, "occurrences": [["p", "q r", "s"]]},
        "fresh_label": "",
        "@option_order": {"version": 1, "occurrences": [
            {"key": "fresh_pair"},
            {"key": "fresh_tag"},
            {"key": "fresh_count"},
            {"key": "fresh_pair"},
            {"key": "fresh_tag", "spelling": "--fresh-tag"},
            {"key": "fresh_items"}
        ]}
    });
    saved(&mut cfg, engine.as_str(), &values);
    // Without confirmed syntax, repetition and the unknown count block
    // launch; the order record itself is valid and the values are kept.
    let before = issues(&cfg, &v1);
    assert!(
        before
            .iter()
            .any(|i| i.starts_with("fresh_pair:help") && i.contains("repetition")),
        "{before:?}"
    );
    assert!(
        !before.iter().any(|i| i.starts_with("@option_order")),
        "{before:?}"
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    assert!(providers::registry::command(&cfg, port, "synthetic-key").is_err());

    // Confirmations cannot replace observed help, claim app-owned bindings
    // or name options the reviewed help does not describe.
    for (bad, needle) in [
        (
            json!({"fresh_pair": {"arity": {"min": 1, "max": 1}}}),
            "already documents",
        ),
        (json!({"port": {"repeatable": true}}), "managed"),
        (json!({"workers": {"repeatable": true}}), "not an option"),
        (json!({"fresh_tag": {}}), "valid"),
    ] {
        let error = runtime_schema::save_supplement(&root, &cfg, &fingerprint, confirmations(bad))
            .unwrap_err();
        assert!(error.contains(needle), "{error}");
    }
    assert!(runtime_schema::save_supplement(
        &root,
        &cfg,
        &"b".repeat(64),
        confirmations(json!({"fresh_tag": {"repeatable": true}}))
    )
    .is_err());
    let confirmed = runtime_schema::save_supplement(
        &root,
        &cfg,
        &fingerprint,
        confirmations(json!({
            "fresh_pair": {"repeatable": true},
            "fresh_tag": {"repeatable": true},
            "fresh_items": {"arity": {"min": 1, "max": null}}
        })),
    )
    .unwrap();
    let view = confirmed.supplement.as_ref().unwrap();
    assert!(view.current && view.conflicts.is_empty());
    let items = option(&confirmed.schema, "fresh_items");
    assert_eq!(
        items.arity.certainty,
        aiolm_lib::providers::runtime_options::Certainty::UserConfirmed
    );
    assert!(issues(&cfg, &v1).is_empty(), "{:?}", issues(&cfg, &v1));

    // Saved and reloaded exactly, then validated and launched in order.
    cfg.validate().unwrap();
    aiolm_lib::config::save(&cfg).unwrap();
    let loaded = aiolm_lib::config::load_result().unwrap();
    assert_eq!(
        Value::Object(loaded.provider_options[engine.as_str()].clone()),
        values
    );
    let expected_tail: Vec<String> = [
        "--workers",
        "2",
        "--fresh-label",
        "",
        "--fresh-pair",
        "a",
        "b c",
        "-t",
        "x",
        "--fresh-count",
        "0",
        "--fresh-pair",
        "한글",
        "d",
        "--fresh-tag",
        "y",
        "-i",
        "p",
        "q r",
        "s",
    ]
    .map(String::from)
    .to_vec();
    // Confirmations and order are part of the launch identity.
    assert!(providers::registry::command(&loaded, port, "synthetic-key")
        .unwrap_err()
        .contains("fresh adapter probe"));
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let planned = providers::registry::command(&loaded, port, "synthetic-key").unwrap();
    assert!(planned.args.ends_with(&expected_tail), "{:?}", planned.args);
    let argv = spawned_argv(&loaded, &argv_file).await;
    assert!(argv.ends_with(&expected_tail), "{argv:?}");

    // A tampered record (an occurrence count that disagrees with the values)
    // and a record from a newer app are refused, not repaired.
    for (field, tampered, needle) in [
        (
            "occurrences",
            json!([{"key": "fresh_pair"}, {"key": "fresh_tag"}, {"key": "fresh_tag"}, {"key": "fresh_count"}, {"key": "fresh_items"}]),
            "1 occurrence(s) of fresh_pair",
        ),
        ("version", json!(2), "version 2"),
    ] {
        let mut bad = loaded.clone();
        bad.provider_options.get_mut(engine.as_str()).unwrap()["@option_order"][field] = tampered;
        let before = bad.provider_options.clone();
        assert!(
            issues(&bad, &v1)
                .iter()
                .any(|i| i.starts_with("@option_order:order") && i.contains(needle)),
            "{:?}",
            issues(&bad, &v1)
        );
        providers::adapter::refresh(&bad, None).await.unwrap();
        assert!(providers::registry::command(&bad, port, "synthetic-key")
            .unwrap_err()
            .contains(needle));
        assert_eq!(bad.provider_options, before);
    }

    // A confirmation file from a newer app is refused; launch blocks with
    // values retained until the user discards it.
    let key = runtime_schema::runtime_key(&loaded).unwrap();
    let supplement = root
        .join(&key.engine)
        .join(&key.runtime)
        .join("help")
        .join("supplement.json");
    let original = fs::read(&supplement).unwrap();
    let mut future: Value = serde_json::from_slice(&original).unwrap();
    future["version"] = json!(2);
    fs::write(&supplement, future.to_string()).unwrap();
    let refused = runtime_schema::effective(&root, &loaded, true).unwrap();
    assert!(refused.supplement.is_none());
    assert!(refused
        .supplement_error
        .as_deref()
        .unwrap()
        .contains("version 2"));
    assert!(issues(&loaded, &v1)
        .iter()
        .any(|i| i.starts_with("@confirmed_syntax")));
    providers::adapter::refresh(&loaded, None).await.unwrap();
    assert!(providers::registry::command(&loaded, port, "synthetic-key")
        .unwrap_err()
        .contains("version 2"));
    let cleared = runtime_schema::clear_supplement(&root, &loaded).unwrap();
    assert!(cleared.supplement.is_none() && cleared.supplement_error.is_none());
    assert!(!supplement.exists());
    fs::write(&supplement, &original).unwrap();

    // A rebuilt engine documents the item count. Accepting its new help
    // never carries the old confirmations over: they are shown with the
    // contradiction, and launch waits for a fresh confirmation.
    providers::registry::remove(engine, "build-1").unwrap();
    let v2 = manifest(engine, &area.path, &argv_file, "order2");
    register(&area.path, &v2).await;
    let rebuilt = discover_and_accept(&service, &root, &loaded, &request);
    assert_ne!(rebuilt, fingerprint);
    let stale = runtime_schema::effective(&root, &loaded, true).unwrap();
    let view = stale.supplement.as_ref().unwrap();
    assert!(!view.current && view.applied.is_empty());
    assert!(view.conflicts.iter().any(|c| c.key == "fresh_items"
        && c.field == "arity"
        && c.help == json!({"min": 2, "max": 2})));
    assert!(option(&stale.schema, "fresh_pair")
        .repeatable
        .supported()
        .is_none());
    assert!(issues(&loaded, &v1)
        .iter()
        .any(|i| i.starts_with("fresh_pair:help") && i.contains("repetition")));
    assert_eq!(
        Value::Object(
            aiolm_lib::config::load_result().unwrap().provider_options[engine.as_str()].clone()
        ),
        values
    );
    runtime_schema::save_supplement(
        &root,
        &loaded,
        &rebuilt,
        confirmations(
            json!({"fresh_pair": {"repeatable": true}, "fresh_tag": {"repeatable": true}}),
        ),
    )
    .unwrap();
    // The new build's documented count rejects the three saved items.
    assert!(issues(&loaded, &v1)
        .iter()
        .any(|i| i.starts_with("fresh_items:help") && i.contains("arity")));
    let mut fixed = loaded.clone();
    fixed.provider_options.get_mut(engine.as_str()).unwrap()["fresh_items"] =
        json!({"spelling": null, "occurrences": [["p", "q r"]]});
    assert!(issues(&fixed, &v2).is_empty(), "{:?}", issues(&fixed, &v2));
    providers::adapter::refresh(&fixed, None).await.unwrap();
    let argv = spawned_argv(&fixed, &argv_file).await;
    assert!(
        argv.ends_with(
            &[
                "--fresh-pair",
                "a",
                "b c",
                "-t",
                "x",
                "--fresh-count",
                "0",
                "--fresh-pair",
                "한글",
                "d",
                "--fresh-tag",
                "y",
                "--fresh-items",
                "p",
                "q r"
            ]
            .map(String::from)
        ),
        "{argv:?}"
    );

    // The public CLI validates the selected runtime's map with the same
    // effective schema, record and confirmations instead of a closed catalog.
    let cli = |args: &[&str]| {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_aiolm-cli"))
            .args(args)
            .output()
            .unwrap();
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
        )
    };
    let fixed_map = json!({engine.as_str(): fixed.provider_options[engine.as_str()]});
    let (ok, output) = cli(&["config", "set", "provider_options", &fixed_map.to_string()]);
    assert!(ok, "{output}");
    let saved_map = || {
        Value::Object(
            aiolm_lib::config::load_result().unwrap().provider_options[engine.as_str()].clone(),
        )
    };
    assert_eq!(saved_map(), fixed_map[engine.as_str()]);
    let mut tampered = fixed_map.clone();
    tampered[engine.as_str()]["@option_order"]["occurrences"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    let mut unknown = fixed_map.clone();
    unknown[engine.as_str()]["fresh_unknown"] = json!("1");
    for (map, needle) in [
        (tampered, "1 occurrence(s) of fresh_pair"),
        (unknown, "fresh_unknown"),
        (
            json!({"llama.cpp": {"fixture_native_value": "x"}}),
            "until a llama.cpp runtime is selected",
        ),
    ] {
        let (ok, output) = cli(&["config", "set", "provider_options", &map.to_string()]);
        assert!(!ok && output.contains(needle), "{output}");
        assert_eq!(saved_map(), fixed_map[engine.as_str()]);
    }

    // The managed native adapter honors the same record and confirmations.
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
    let native_fingerprint = discover_and_accept(&service, &root, &native, &native_request);
    saved(
        &mut native,
        "llama.cpp",
        &json!({
            "fixture_native_value": {"spelling": null, "occurrences": [["first"], ["third"]]},
            "top_k": "3",
            "@option_order": {"version": 1, "occurrences": [
                {"key": "fixture_native_value"}, {"key": "top_k"}, {"key": "fixture_native_value"}
            ]}
        }),
    );
    native.validate().unwrap();
    let launch = |cfg: &AppConfig| {
        providers::adapter::resolve(cfg).launch(cfg, port, "synthetic-key", &Default::default())
    };
    assert!(launch(&native).unwrap_err().contains("repetition"));
    runtime_schema::save_supplement(
        &root,
        &native,
        &native_fingerprint,
        confirmations(json!({"fixture_native_value": {"repeatable": true}})),
    )
    .unwrap();
    let native_plan = launch(&native).unwrap();
    assert!(
        native_plan.args.ends_with(
            &[
                "--fixture-native-value",
                "first",
                "--top-k",
                "3",
                "--fixture-native-value",
                "third"
            ]
            .map(String::from)
        ),
        "{:?}",
        native_plan.args
    );
    // An app-owned native setting cannot be positioned through the record.
    let mut owned = native.clone();
    saved(
        &mut owned,
        "llama.cpp",
        &json!({"threads": "3", "@option_order": {"version": 1, "occurrences": [{"key": "threads"}]}}),
    );
    assert!(launch(&owned).unwrap_err().contains("managed"));
}
