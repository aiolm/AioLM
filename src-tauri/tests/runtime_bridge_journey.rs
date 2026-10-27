//! Synthetic bridge contract: bridge help configures bridge options; a
//! separate engine receives explicit JSON argv and forwarded options. No
//! inference or platform support claim is made by this fixture.
use aiolm_lib::{
    providers::{
        self,
        registry::*,
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
        let path = std::env::temp_dir().join(format!("aiolm-bridge-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // This integration binary has one test, so no concurrent env readers.
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
async fn bridge_help_probe_and_launch_share_an_explicit_engine_command() {
    let area = TestHome::new();
    // Preparation failures leave the selected installation untouched. This
    // test binary is the sole owner of AIOLM_HOME and these generated paths.
    use providers::launch_resources::{self, Request};
    let request = Request {
        version: 1,
        directory_env: "SYNTHETIC_LAUNCH_DIRECTORY".into(),
    };
    assert!(Request {
        version: 2,
        ..request.clone()
    }
    .validate()
    .is_err());
    assert!(Request {
        directory_env: "BAD-NAME".into(),
        ..request.clone()
    }
    .validate()
    .is_err());
    assert!(Request {
        directory_env: "aiolm_home".into(),
        ..request.clone()
    }
    .validate()
    .is_err());
    let mut collision = vec![("synthetic_launch_directory".into(), "existing".into())];
    assert!(launch_resources::prepare(Some(request.clone()), &mut collision).is_err());
    assert!(launch_resources::cleanup("../selected-engine", 1).is_err());
    let mut temporary_env = vec![];
    let mut guard = launch_resources::prepare(Some(request.clone()), &mut temporary_env)
        .unwrap()
        .unwrap();
    let directory = PathBuf::from(&temporary_env[0].1);
    let guard_id = guard.id().to_owned();
    guard.bind(9123).unwrap();
    fs::write(directory.join("effective-config.json"), b"synthetic").unwrap();
    assert!(launch_resources::cleanup(&guard_id, 9124).is_err());
    assert!(directory.join("effective-config.json").is_file());
    guard.release();
    assert!(directory.exists(), "headless release retains its resources");
    launch_resources::cleanup(&guard_id, 9123).unwrap();
    assert!(!directory.exists());
    launch_resources::cleanup(&guard_id, 9123).unwrap();
    let mut temporary_env = vec![];
    let guard = launch_resources::prepare(Some(request.clone()), &mut temporary_env).unwrap();
    let aborted = PathBuf::from(&temporary_env[0].1);
    drop(guard);
    assert!(
        !aborted.exists(),
        "an aborted launch cleans its unbound directory"
    );
    let resource_request = request;
    let bridge = env!("CARGO_BIN_EXE_fake-llama-server").to_string();
    let engine_file = area
        .path
        .join(format!("별도 engine{}", std::env::consts::EXE_SUFFIX));
    fs::copy(&bridge, &engine_file).unwrap();
    let engine = engine_file.to_string_lossy().into_owned();
    let model = area.path.join("synthetic model.bin");
    fs::write(&model, b"synthetic model").unwrap();
    let prefix = vec![
        "--bridge-engine-argv-fixture".into(),
        "한글 path ; &".into(),
        "".into(),
    ];
    let bridge_prefix = vec![
        "--adapter-bridge-fixture".into(),
        "--adapter-resource-fixture".into(),
        "--adapter-engine".into(),
        "--adapter-no-health-auth".into(),
    ];
    let link_file = area.path.join("bridge-link.json");
    let child_argv = area.path.join("engine-argv.json");
    let bridge_argv = area.path.join("bridge-argv.json");
    let resource_record = area.path.join("launch-directory.txt");
    let environment = BTreeMap::from([
        (
            "FAKE_RESOURCE_RECORD".into(),
            resource_record.to_string_lossy().into_owned(),
        ),
        (
            "FAKE_BRIDGE_LINK_FILE".into(),
            link_file.to_string_lossy().into_owned(),
        ),
        (
            "FAKE_BRIDGE_CHILD_ARGV_FILE".into(),
            child_argv.to_string_lossy().into_owned(),
        ),
        (
            "FAKE_ENGINE_ARGV_FILE".into(),
            bridge_argv.to_string_lossy().into_owned(),
        ),
    ]);
    let id = providers::ProviderId::parse("custom.bridgefixture").unwrap();
    let protocol = ServingProtocol::Bridge {
        program: bridge.clone(),
        prefix: bridge_prefix.clone(),
        engine_argv_env: Some("SYNTHETIC_ENGINE_ARGV".into()),
    };
    let entry = EntrypointHelp {
        command_layout: None,
        engine_id: id,
        runtime_id: "bridge-1".into(),
        program: engine.clone(),
        prefix: prefix.clone(),
        working_directory: Some(area.path.to_string_lossy().into_owned()),
        artifacts: vec![],
        environment: environment.clone(),
        protocol: protocol.clone(),
        option_metadata: None,
    };
    let mut args = bridge_prefix.clone();
    args.extend(["--adapter-help-fixture".into(), "--help".into()]);
    let request = HelpRequest {
        encoding: None,
        locale: None,
        working_directory: None,
        program: None,
        args,
        scope: vec![],
    };
    let provisional = provisional_manifest(&entry).unwrap();
    let command = runtime_schema::manifest_help_command(&provisional, &request).unwrap();
    assert_eq!(command.program, PathBuf::from(&bridge));
    let root = providers::registry::root();
    let (report, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        &root,
        "bridge-owner",
        id.as_str(),
        "bridge-1",
        &command,
        &[],
        Baseline::Latest,
    )
    .unwrap();
    assert!(report.complete());
    let mut probe_args = bridge_prefix.clone();
    probe_args.extend([
        "--adapter-probe".into(),
        id.as_str().into(),
        "bridge-1".into(),
        "{model}".into(),
    ]);
    let draft = EntrypointDraft {
        command_layout: None,
        options_separator: Some("--".into()),
        launch_resources: Some(resource_request),
        models: vec![ModelBinding {
            path: model.to_string_lossy().into_owned(),
            name: "Synthetic bridge model".into(),
        }],
        engine_id: id,
        runtime_id: entry.runtime_id.clone(),
        display_name: "Synthetic explicit bridge".into(),
        program: engine.clone(),
        prefix: prefix.clone(),
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
            program: bridge.clone(),
            args: probe_args,
            env: environment,
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: Some(DraftHelp {
            fingerprint: descriptor.fingerprint,
            request: request.clone(),
        }),
        option_metadata: None,
    };
    let manifest = manifest_from_draft(&draft).unwrap();
    assert_eq!(manifest.launch.args.last().unwrap(), "--");
    assert_eq!(launch_prefix(&manifest), bridge_prefix);
    let mut invalid_boundary = draft.clone();
    invalid_boundary.options_separator = Some("--unknown-boundary".into());
    assert!(manifest_from_draft(&invalid_boundary).is_err());
    assert_eq!(manifest.models, draft.models);
    let mut invalid_resources = manifest.clone();
    invalid_resources.launch_resources.as_mut().unwrap().version = 2;
    assert!(validate_manifest(&invalid_resources).is_err());
    let mut collision = manifest.clone();
    collision
        .launch
        .env
        .insert("synthetic_launch_directory".into(), "existing".into());
    assert!(validate_manifest(&collision).is_err());
    // An artifact's help remains available for inspection. It cannot become
    // the bridge's launch schema, even with a cached complete snapshot.
    let inspection = HelpRequest {
        encoding: None,
        locale: None,
        working_directory: None,
        program: Some(engine.clone()),
        args: vec!["--adapter-help-fixture".into(), "--help".into()],
        scope: vec![],
    };
    let inspect_command = runtime_schema::manifest_help_command(&manifest, &inspection).unwrap();
    let (_, inspect_descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        &root,
        "engine-inspection",
        id.as_str(),
        "bridge-1",
        &inspect_command,
        &[],
        Baseline::Latest,
    )
    .unwrap();
    let mut wrong = draft.clone();
    wrong.help = Some(DraftHelp {
        fingerprint: inspect_descriptor.fingerprint.clone(),
        request: inspection.clone(),
    });
    assert!(runtime_schema::draft_acceptance(&root, &wrong, &manifest)
        .unwrap_err()
        .contains("inspection only"));
    runtime_schema::register_entrypoint(&root, &draft, None)
        .await
        .unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut cfg = AppConfig {
        active_provider: id.as_str().into(),
        active_runtime: "bridge-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    assert!(
        runtime_schema::accept(&root, &cfg, &inspect_descriptor.fingerprint, &inspection)
            .unwrap_err()
            .contains("inspection only")
    );
    assert_eq!(
        runtime_schema::effective(&root, &cfg, true)
            .unwrap()
            .help_state,
        HelpState::Current
    );
    cfg.provider_options.insert(
        id.as_str().into(),
        json!({"fresh_label":"눈길 ; & \"quoted\"", "fresh_count":"0"})
            .as_object()
            .unwrap()
            .clone(),
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let planned = providers::registry::command(&cfg, port, "").unwrap();
    let tail = vec![
        "--fresh-count".to_string(),
        "0".into(),
        "--fresh-label".into(),
        "눈길 ; & \"quoted\"".into(),
    ];
    assert!(planned.args.ends_with(&tail));
    let err = Arc::new(ErrBuf::default());
    let (child, url, _) = server::spawn(&cfg, "", &err, &Default::default()).unwrap();
    let state = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut shared = state.lock().unwrap();
        shared.child = Some(child);
        shared.engine = Some(providers::execution::info(&cfg).unwrap());
    }
    let ready = server::wait_ready(state.clone(), &url, "", 5, &err).await;
    // A launch file can stay open briefly after the job reports its tree
    // gone, as the production Strata GUI unload left engine.log. Unload must
    // keep retrying that sharing error within its existing teardown budget.
    #[cfg(windows)]
    let closing_log = fs::read_to_string(&resource_record).ok().map(|directory| {
        use std::os::windows::fs::OpenOptionsExt;
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .share_mode(0x1) // FILE_SHARE_READ: deletion is refused while open
            .open(PathBuf::from(directory).join("engine.log"))
            .unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(1));
            drop(log);
        })
    });
    // Stop the exact owned process even if readiness fails.
    {
        server::kill(&mut state.lock().unwrap().child, Some(err.clone()));
    }
    #[cfg(windows)]
    if let Some(closing_log) = closing_log {
        closing_log.join().unwrap();
    }
    ready.unwrap();
    let launched_directory = PathBuf::from(fs::read_to_string(&resource_record).unwrap());
    assert!(
        !launched_directory.exists(),
        "stopping the owned bridge removes its effective config"
    );
    let actual: Vec<String> = serde_json::from_slice(&fs::read(child_argv).unwrap()).unwrap();
    assert!(actual.starts_with(&prefix), "{actual:?}");
    assert!(actual.ends_with(&tail), "{actual:?}");
    assert_eq!(actual[actual.len() - tail.len() - 1], "--");
    assert!(actual
        .windows(2)
        .any(|pair| pair == ["--model", cfg.active_model.as_str()]));
    let link: Value = serde_json::from_slice(&fs::read(link_file).unwrap()).unwrap();
    let expected = std::iter::once(engine).chain(prefix).collect::<Vec<_>>();
    for phase in ["help", "probe", "launch"] {
        assert_eq!(link[phase], json!(expected), "{phase}");
    }
    let actual_bridge: Vec<String> =
        serde_json::from_slice(&fs::read(bridge_argv).unwrap()).unwrap();
    assert!(actual_bridge.starts_with(&bridge_prefix));
    assert!(actual_bridge.ends_with(&tail));
    assert_eq!(actual_bridge[actual_bridge.len() - tail.len() - 1], "--");

    // A background CLI start outlives its command process. Its persisted
    // state retains the UUID; a later CLI stop cleans only that launch.
    aiolm_lib::config::save(&cfg).unwrap();
    let cli = |action: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_aiolm-cli"))
            .args(["server", action])
            .env("AIOLM_HOME", &area.path)
            .output()
            .unwrap()
    };
    let started = cli("start");
    if !started.status.success() {
        let _ = cli("stop");
        panic!("headless start failed: {started:?}");
    }
    let background_directory = PathBuf::from(fs::read_to_string(&resource_record).unwrap());
    let retained = background_directory.join("effective-config.json").is_file();
    let stopped = cli("stop");
    assert!(
        stopped.status.success(),
        "headless stop failed: {stopped:?}"
    );
    assert!(
        retained,
        "the live background process retains its effective config"
    );
    assert!(!background_directory.exists());
}
