//! Adapter-owned parts of a registered entry point, through registration,
//! validation and the actual spawned argv: options the fixed entry prefix
//! already spells (a serving layer's `--engine strata`) cannot be re-set by
//! a saved generic option, and options the adapter's metadata reserves for
//! app-owned lifecycle and tools are refused with their reason while saved
//! values are kept. App credentials stay app-owned. Synthetic only; the
//! option shapes mirror a two-layer serving entry point.
use aiolm_lib::{
    providers::{
        self,
        registry::{
            ArgBinding, AuthBinding, DraftHelp, EntrypointDraft, EntrypointHelp, ProcessSpec,
            ServingProtocol,
        },
        runtime_help::HelpService,
        runtime_help_store::{self, Baseline},
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
        let path = std::env::temp_dir().join(format!("aiolm-entry-owner-{}", uuid::Uuid::new_v4()));
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

const ENGINE: &str = "custom.entryowner";

fn prefix() -> Vec<String> {
    [
        "--adapter-engine",
        "--adapter-no-health-auth",
        "--engine",
        "strata",
    ]
    .map(String::from)
    .to_vec()
}

fn entry(area: &Path, runtime: &str, metadata: Option<Value>) -> (EntrypointHelp, HelpRequest) {
    let program = env!("CARGO_BIN_EXE_fake-llama-server").to_string();
    let entry = EntrypointHelp {
        engine_id: providers::ProviderId::parse(ENGINE).unwrap(),
        runtime_id: runtime.into(),
        program,
        prefix: prefix(),
        working_directory: Some(area.to_string_lossy().into_owned()),
        artifacts: vec![],
        environment: BTreeMap::from([
            (
                "FAKE_ENGINE_ARGV_FILE".to_string(),
                area.join("argv.json").to_string_lossy().into_owned(),
            ),
            ("FAKE_ENGINE_HELP".to_string(), "server".to_string()),
        ]),
        protocol: ServingProtocol::OpenaiHttp,
        option_metadata: metadata.map(|value| serde_json::from_value(value).unwrap()),
    };
    let mut args = prefix();
    args.extend(["--adapter-help-fixture".to_string(), "--help".to_string()]);
    (
        entry,
        HelpRequest {
            working_directory: None,
            program: None,
            args,
            scope: vec![],
        },
    )
}

async fn register(area: &Path, runtime: &str, metadata: Option<Value>) -> Result<(), String> {
    let (entry, request) = entry(area, runtime, metadata);
    let root = providers::registry::root();
    let provisional = providers::registry::provisional_manifest(&entry)?;
    let command = runtime_schema::manifest_help_command(&provisional, &request)?;
    let (_, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        &root,
        "owner",
        ENGINE,
        runtime,
        &command,
        &[],
        Baseline::Latest,
    )?;
    let draft = EntrypointDraft {
        options_separator: None,
        launch_resources: None,
        models: vec![],
        engine_id: entry.engine_id,
        runtime_id: entry.runtime_id.clone(),
        display_name: "Synthetic serving entry".into(),
        program: entry.program.clone(),
        prefix: entry.prefix.clone(),
        working_directory: entry.working_directory.clone(),
        artifacts: vec![],
        environment: entry.environment.clone(),
        model: ArgBinding::Flag {
            flag: "--config".into(),
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
            name: "FRESH_SERVING_KEY".into(),
        },
        protocol: ServingProtocol::OpenaiHttp,
        probe: ProcessSpec {
            program: entry.program.clone(),
            args: vec![
                "--adapter-probe".into(),
                ENGINE.into(),
                runtime.into(),
                "{model}".into(),
            ],
            env: BTreeMap::new(),
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
    .map(|issue| format!("{}:{}:{}", issue.key, issue.code, issue.message))
    .collect()
}

fn saved(cfg: &mut AppConfig, values: Value) {
    let Value::Object(values) = values else {
        unreachable!()
    };
    cfg.provider_options.insert(ENGINE.into(), values);
}

#[tokio::test]
async fn fixed_entry_options_and_adapter_reservations_stay_app_owned() {
    let area = TestHome::new();
    let model = area.path.join("deployment.json");
    fs::write(&model, b"{}").unwrap();
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: ENGINE.into(),
        active_runtime: "local-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    register(&area.path, "local-1", None).await.unwrap();
    let root = providers::registry::root();

    // The entry prefix fixes `--engine strata`; the documented selector
    // cannot be saved over it, so launch never claims a different engine.
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    let selector = effective
        .schema
        .options
        .iter()
        .find(|o| o.key == "engine")
        .unwrap();
    assert!(selector.managed.is_some(), "{selector:?}");
    saved(&mut cfg, json!({"engine": "mock", "fit_max_tokens": true}));
    let found = issues(&cfg);
    assert!(
        found
            .iter()
            .any(|i| i.starts_with("engine:") && i.contains("entry point")),
        "{found:?}"
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    assert!(providers::registry::command(&cfg, port, "synthetic-key").is_err());
    // The app credential is already app-owned through every spelling.
    saved(&mut cfg, json!({"api_key": "synthetic-override"}));
    assert!(issues(&cfg)
        .iter()
        .any(|i| i.starts_with("api_key:") && i.contains("managed")));

    // Without adapter metadata, lifecycle and tool switches are ordinary
    // documented options; nothing is guessed from their names.
    saved(&mut cfg, json!({"lazy": true}));
    assert!(issues(&cfg).is_empty(), "{:?}", issues(&cfg));

    // The adapter reserves them explicitly, with its reason.
    let reasons = json!({"version": 1, "engine_id": ENGINE, "adapter": {"id": "synthetic.serving", "revision": "r1"},
    "options": [
        {"flag": "--lazy", "reserved": "the app loads the model before reporting Ready"},
        {"flag": "--idle-unload", "reserved": "the app owns model unloading"},
        {"flag": "--before-load", "reserved": "the app owns commands run around loading"},
        {"flag": "--mcp-config", "reserved": "the app owns MCP tool servers"}
    ]});
    register(&area.path, "local-2", Some(reasons))
        .await
        .unwrap();
    cfg.active_runtime = "local-2".into();
    let reserved = json!({"lazy": true, "idle_unload": "60", "before_load": "synthetic-command", "mcp_config": "synthetic.json", "fit_max_tokens": true});
    saved(&mut cfg, reserved.clone());
    let found = issues(&cfg);
    for (key, reason) in [
        ("lazy", "loads the model"),
        ("idle_unload", "unloading"),
        ("before_load", "around loading"),
        ("mcp_config", "MCP tool servers"),
    ] {
        assert!(
            found
                .iter()
                .any(|i| i.starts_with(&format!("{key}:")) && i.contains(reason)),
            "{key}: {found:?}"
        );
    }
    providers::adapter::refresh(&cfg, None).await.unwrap();
    assert!(providers::registry::command(&cfg, port, "synthetic-key").is_err());
    aiolm_lib::config::save(&cfg).unwrap();
    assert_eq!(
        Value::Object(aiolm_lib::config::load_result().unwrap().provider_options[ENGINE].clone()),
        reserved
    );

    // A permitted option still launches with the fixed prefix untouched.
    saved(&mut cfg, json!({"fit_max_tokens": true}));
    assert!(issues(&cfg).is_empty(), "{:?}", issues(&cfg));
    providers::adapter::refresh(&cfg, None).await.unwrap();
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
    let argv: Vec<String> =
        serde_json::from_slice(&fs::read(area.path.join("argv.json")).unwrap()).unwrap();
    assert!(argv.starts_with(&prefix()), "{argv:?}");
    assert_eq!(
        argv.iter().filter(|a| *a == "--engine").count(),
        1,
        "{argv:?}"
    );
    assert!(
        argv.ends_with(&["--fit-max-tokens".to_string()]),
        "{argv:?}"
    );
    {
        let mut state = shared.lock().unwrap();
        server::kill(&mut state.child, Some(err.clone()));
    }
}
