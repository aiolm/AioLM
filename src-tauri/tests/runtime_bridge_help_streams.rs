//! A bridge's help is one document. AioLM parses a non-empty stdout alone,
//! so a bridge that prints its bindings on stdout and leaves a native build's
//! stderr-only help on stderr exposes no native option at all. A bridge that
//! gives the native child the same stdout pipe makes those options part of
//! the effective schema (with stdout provenance), where adapter metadata can
//! reserve one and the others reach the separated engine argv. Synthetic
//! processes only; no inference or engine support claim.
use aiolm_lib::{
    providers::{
        self,
        registry::*,
        runtime_help::HelpService,
        runtime_help_store::{self, Baseline},
        runtime_options::{ManagedBinding, Source},
        runtime_schema::{self, HelpRequest},
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
            std::env::temp_dir().join(format!("aiolm-bridge-streams-{}", uuid::Uuid::new_v4()));
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

const ENGINE: &str = "custom.bridgestreams";

fn bridge_prefix() -> Vec<String> {
    [
        "--adapter-bridge-fixture",
        "--adapter-engine",
        "--adapter-no-health-auth",
    ]
    .map(String::from)
    .to_vec()
}

async fn register(area: &Path, runtime: &str, streams: &str) -> Result<(), String> {
    let bridge = env!("CARGO_BIN_EXE_fake-llama-server").to_string();
    let engine_file = area.join(format!("native engine{}", std::env::consts::EXE_SUFFIX));
    if !engine_file.is_file() {
        fs::copy(&bridge, &engine_file).unwrap();
    }
    let engine = engine_file.to_string_lossy().into_owned();
    let model = area.join("deployment.json");
    let id = providers::ProviderId::parse(ENGINE).unwrap();
    let environment = BTreeMap::from([
        ("FAKE_BRIDGE_NATIVE_HELP".to_string(), streams.to_string()),
        (
            "FAKE_BRIDGE_LINK_FILE".into(),
            area.join("link.json").to_string_lossy().into_owned(),
        ),
        (
            "FAKE_BRIDGE_CHILD_ARGV_FILE".into(),
            area.join("engine-argv.json").to_string_lossy().into_owned(),
        ),
        (
            "FAKE_ENGINE_ARGV_FILE".into(),
            area.join("bridge-argv.json").to_string_lossy().into_owned(),
        ),
    ]);
    let protocol = ServingProtocol::Bridge {
        program: bridge.clone(),
        prefix: bridge_prefix(),
        engine_argv_env: Some("SYNTHETIC_ENGINE_ARGV".into()),
    };
    // The adapter reserves the native device selection its deployment owns
    // and documents the other native option's value kind.
    let metadata = serde_json::from_value(json!({"version": 1, "engine_id": ENGINE,
    "adapter": {"id": "synthetic.native-bridge", "revision": "r1"},
    "options": [
        {"flag": "--fresh-device", "reserved": "the selected deployment owns its visible devices"},
        {"flag": "--fresh-native", "kind": "integer"}
    ]}))
    .unwrap();
    let entry = EntrypointHelp {
        command_layout: None,
        engine_id: id,
        runtime_id: runtime.into(),
        program: engine.clone(),
        prefix: vec!["--bridge-engine-argv-fixture".into()],
        working_directory: Some(area.to_string_lossy().into_owned()),
        artifacts: vec![],
        environment: environment.clone(),
        protocol: protocol.clone(),
        option_metadata: Some(metadata),
    };
    let mut args = bridge_prefix();
    args.push("--help".into());
    let request = HelpRequest {
        working_directory: None,
        program: None,
        args,
        scope: vec![],
    };
    let root = providers::registry::root();
    let provisional = provisional_manifest(&entry)?;
    let command = runtime_schema::manifest_help_command(&provisional, &request)?;
    let (report, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        &root,
        "streams-owner",
        ENGINE,
        runtime,
        &command,
        &[],
        Baseline::Latest,
    )?;
    assert!(report.complete());
    let mut probe_args = bridge_prefix();
    probe_args.extend([
        "--adapter-probe".into(),
        ENGINE.into(),
        runtime.into(),
        "{model}".into(),
    ]);
    let draft = EntrypointDraft {
        command_layout: None,
        options_separator: Some("--".into()),
        launch_resources: None,
        models: vec![ModelBinding {
            path: model.to_string_lossy().into_owned(),
            name: "Synthetic deployment".into(),
        }],
        engine_id: id,
        runtime_id: runtime.into(),
        display_name: "Synthetic native bridge".into(),
        program: engine,
        prefix: entry.prefix.clone(),
        working_directory: entry.working_directory.clone(),
        artifacts: vec![],
        environment: environment.clone(),
        model: ArgBinding::Flag {
            flag: "--model".into(),
            equals: false,
        },
        port: ArgBinding::Flag {
            flag: "--port".into(),
            equals: false,
        },
        host: None,
        served_model: None,
        auth: AuthBinding::None,
        protocol,
        probe: ProcessSpec {
            program: bridge,
            args: probe_args,
            env: environment,
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: Some(DraftHelp {
            fingerprint: descriptor.fingerprint,
            request,
        }),
        option_metadata: entry.option_metadata.clone(),
    };
    runtime_schema::register_entrypoint(&root, &draft, None)
        .await
        .map(|_| ())
}

fn issues(cfg: &AppConfig) -> Vec<String> {
    let engine = providers::ProviderId::parse(ENGINE).unwrap();
    let manifest = providers::registry::manifest(engine, &cfg.active_runtime).unwrap();
    providers::registry::saved_option_issues(
        cfg,
        &manifest,
        cfg.provider_options.get(ENGINE).unwrap_or(&Map::new()),
    )
    .into_iter()
    .map(|issue| format!("{}:{}", issue.key, issue.message))
    .collect()
}

fn saved(cfg: &mut AppConfig, values: Value) {
    let Value::Object(values) = values else {
        unreachable!()
    };
    cfg.provider_options.insert(ENGINE.into(), values);
}

#[tokio::test]
async fn native_stderr_help_reaches_the_schema_only_through_the_bridge_stdout() {
    let area = TestHome::new();
    let model = area.path.join("deployment.json");
    fs::write(&model, b"{}").unwrap();
    let root = providers::registry::root();
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: ENGINE.into(),
        active_runtime: "separate".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    let flags = |cfg: &AppConfig| {
        runtime_schema::effective(&root, cfg, true)
            .unwrap()
            .schema
            .options
            .into_iter()
            .map(|o| (o.key.clone(), o))
            .collect::<BTreeMap<_, _>>()
    };

    // Native rows left on stderr are shadowed by the bridge's stdout rows.
    register(&area.path, "separate", "separate").await.unwrap();
    let shadowed = flags(&cfg);
    assert!(shadowed.contains_key("model") && shadowed.contains_key("port"));
    assert!(
        !shadowed.contains_key("fresh_native") && !shadowed.contains_key("fresh_device"),
        "{:?}",
        shadowed.keys()
    );

    // One stdout document: the native rows become effective options.
    register(&area.path, "merged", "merged").await.unwrap();
    cfg.active_runtime = "merged".into();
    let options = flags(&cfg);
    let native = &options["fresh_native"];
    assert!(
        matches!(&native.arity.source, Some(Source::Help { document, .. }) if document == "stdout"),
        "{:?}",
        native.arity.source
    );
    assert_eq!(native.managed, None);
    assert_eq!(
        options["fresh_device"].managed,
        Some(ManagedBinding::Reserved)
    );
    assert_eq!(options["model"].managed, Some(ManagedBinding::Model));
    assert_eq!(options["port"].managed, Some(ManagedBinding::Port));

    // A reserved native option is refused with its reason; the saved value
    // is kept for review rather than stripped or launched.
    let reserved = json!({"fresh_device": "1", "fresh_native": 3});
    saved(&mut cfg, reserved.clone());
    let found = issues(&cfg);
    assert!(
        found
            .iter()
            .any(|i| i.starts_with("fresh_device:") && i.contains("visible devices")),
        "{found:?}"
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    assert!(providers::registry::command(&cfg, port, "").is_err());
    aiolm_lib::config::save(&cfg).unwrap();
    assert_eq!(
        Value::Object(aiolm_lib::config::load_result().unwrap().provider_options[ENGINE].clone()),
        reserved
    );

    // A permitted native option crosses the explicit boundary to the engine.
    saved(&mut cfg, json!({"fresh_native": 3}));
    assert!(issues(&cfg).is_empty(), "{:?}", issues(&cfg));
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let tail = ["--".to_string(), "--fresh-native".into(), "3".into()];
    assert!(providers::registry::command(&cfg, port, "")
        .unwrap()
        .args
        .ends_with(&tail));
    let err = Arc::new(ErrBuf::default());
    let (child, url, _) = server::spawn(&cfg, "", &err, &Default::default()).unwrap();
    let state = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut shared = state.lock().unwrap();
        shared.child = Some(child);
        shared.engine = Some(providers::execution::info(&cfg).unwrap());
    }
    let ready = server::wait_ready(state.clone(), &url, "", 5, &err).await;
    // Stop the exact owned process even if readiness fails.
    server::kill(&mut state.lock().unwrap().child, Some(err.clone()));
    ready.unwrap();
    let actual: Vec<String> =
        serde_json::from_slice(&fs::read(area.path.join("engine-argv.json")).unwrap()).unwrap();
    assert!(actual.ends_with(&tail), "{actual:?}");
    assert!(!actual.iter().any(|a| a == "--fresh-device"), "{actual:?}");
}
