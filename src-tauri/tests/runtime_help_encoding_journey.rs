//! Help written in a Windows code page (CP949) and a chosen locale, through
//! the product path: entry-point discovery with an explicit encoding and
//! locale, registration, rediscovery, accepted schema, a saved profile value
//! and the actual spawned argv. Without the explicit encoding the bytes are
//! reported lossy and nothing can be accepted. A real subprocess emits fixed
//! synthetic bytes; no engine, system code page or locale setting is used.
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
use serde_json::{json, Value};
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
            std::env::temp_dir().join(format!("aiolm 도움말 encoding {}", uuid::Uuid::new_v4()));
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

const ENGINE: &str = "custom.codepage";
/// "모델 이름 표시" as Python's cp949 codec writes it.
const KOREAN: &str = "모델 이름 표시";

fn entry(area: &Path) -> EntrypointHelp {
    EntrypointHelp {
        command_layout: None,
        engine_id: providers::ProviderId::parse(ENGINE).unwrap(),
        runtime_id: "cp949".into(),
        program: env!("CARGO_BIN_EXE_fake-llama-server").to_string(),
        prefix: vec!["--adapter-engine".into(), "--adapter-no-health-auth".into()],
        working_directory: Some(area.to_string_lossy().into_owned()),
        artifacts: vec![],
        environment: BTreeMap::from([
            ("FAKE_ENGINE_HELP".to_string(), "cp949".to_string()),
            (
                "FAKE_ENGINE_ARGV_FILE".to_string(),
                area.join("argv.json").to_string_lossy().into_owned(),
            ),
        ]),
        protocol: ServingProtocol::OpenaiHttp,
        option_metadata: None,
    }
}

fn request(extra: Value) -> HelpRequest {
    let mut value = json!({
        "program": null,
        "args": ["--adapter-engine", "--adapter-no-health-auth", "--adapter-help-fixture", "--help"],
        "scope": []
    });
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    serde_json::from_value(value).unwrap()
}

fn discover(
    area: &Path,
    request: &HelpRequest,
) -> Result<
    (
        providers::runtime_help::HelpReport,
        runtime_help_store::RuntimeDescriptor,
    ),
    String,
> {
    let provisional = providers::registry::provisional_manifest(&entry(area))?;
    let command = runtime_schema::manifest_help_command(&provisional, request)?;
    runtime_help_store::discover_against(
        &HelpService::default(),
        &providers::registry::root(),
        "codepage",
        ENGINE,
        "cp949",
        &command,
        &[],
        Baseline::Latest,
    )
}

#[tokio::test]
async fn code_page_help_needs_an_explicit_encoding_and_keeps_its_locale() {
    let home = TestHome::new();
    let area = home.path.clone();
    let model = area.join("deployment.json");
    fs::write(&model, b"{}").unwrap();

    // Old requests (no encoding or locale) keep their exact wire form.
    let old = r#"{"program":null,"args":["--help"],"scope":[]}"#;
    let parsed: HelpRequest = serde_json::from_str(old).unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), old);

    // Default (Auto): the CP949 bytes are not valid UTF-8. The capture says
    // so, and nothing lossy becomes an accepted schema.
    let auto = discover(&area, &request(json!({}))).unwrap_err();
    assert!(auto.contains("incomplete"), "{auto}");
    assert!(auto.contains("help encoding"), "{auto}");
    let provisional = providers::registry::provisional_manifest(&entry(&area)).unwrap();
    let capture = providers::runtime_help::discover(
        &runtime_schema::manifest_help_command(&provisional, &request(json!({}))).unwrap(),
        &Default::default(),
    )
    .unwrap();
    assert!(capture.stdout.decoding_loss);
    assert!(!capture.complete());
    assert!(capture.stdout.text.contains("LC_ALL=C"), "default locale");

    // Unknown encodings and malformed locales fail before any child runs.
    assert!(serde_json::from_value::<HelpRequest>(json!({
        "program": null, "args": ["--help"], "scope": [], "encoding": "cp1251-guess"
    }))
    .is_err());
    for bad in ["", "../ko", "ko KR", "ko\nKR", "ko\0KR", &"x".repeat(65)] {
        assert!(
            runtime_schema::manifest_help_command(&provisional, &request(json!({ "locale": bad })))
                .is_err(),
            "{bad:?}"
        );
    }

    // Explicit CP949 and locale: exact text, the locale reached the child.
    let chosen = request(json!({ "encoding": "cp949", "locale": "ko_KR.UTF-8" }));
    let (report, descriptor) = discover(&area, &chosen).unwrap();
    assert!(report.complete(), "{report:?}");
    assert_eq!(report.stdout.encoding, "windows-949");
    assert!(
        report.stdout.text.contains(KOREAN),
        "{}",
        report.stdout.text
    );
    assert!(report.stdout.text.contains("LC_ALL=ko_KR.UTF-8"));
    assert!(
        report.stderr.text.contains(KOREAN),
        "{}",
        report.stderr.text
    );
    assert!(report.stdout.raw_bytes_base64.is_some());
    assert!(report.stderr.raw_bytes_base64.is_some());
    let mut malformed = provisional.clone();
    malformed
        .launch
        .env
        .insert("FAKE_ENGINE_HELP".into(), "cp949-broken".into());
    let malformed_command = runtime_schema::manifest_help_command(&malformed, &chosen).unwrap();
    let malformed_report =
        providers::runtime_help::discover(&malformed_command, &Default::default()).unwrap();
    assert!(malformed_report.stdout.decoding_loss);
    assert!(!malformed_report.complete());
    let failure = providers::runtime_help_store::discover_against(
        &HelpService::default(),
        &providers::registry::root(),
        "broken-codepage",
        ENGINE,
        "cp949",
        &malformed_command,
        &[],
        Baseline::Latest,
    )
    .unwrap_err();
    assert!(failure.contains("help encoding"), "{failure}");
    // Encoding and locale are part of what was reviewed.
    let (_, other_locale) = discover(
        &area,
        &request(json!({ "encoding": "cp949", "locale": "C" })),
    )
    .unwrap();
    assert_ne!(descriptor.fingerprint, other_locale.fingerprint);
    let windows_1252 = discover(&area, &request(json!({ "encoding": "windows-1252" })))
        .map(|(_, d)| d.fingerprint)
        .unwrap();
    assert_ne!(descriptor.fingerprint, windows_1252);

    // Register with that reviewed help; the saved request keeps the choice.
    let entry = entry(&area);
    let draft = EntrypointDraft {
        command_layout: None,
        options_separator: None,
        launch_resources: None,
        models: vec![],
        engine_id: entry.engine_id,
        runtime_id: entry.runtime_id.clone(),
        display_name: "Code page engine".into(),
        program: entry.program.clone(),
        prefix: entry.prefix.clone(),
        working_directory: entry.working_directory.clone(),
        artifacts: vec![],
        environment: entry.environment.clone(),
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
        protocol: ServingProtocol::OpenaiHttp,
        probe: ProcessSpec {
            program: entry.program.clone(),
            args: vec![
                "--adapter-probe".into(),
                ENGINE.into(),
                "cp949".into(),
                "{model}".into(),
            ],
            env: BTreeMap::new(),
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: Some(DraftHelp {
            fingerprint: descriptor.fingerprint.clone(),
            request: chosen.clone(),
        }),
        option_metadata: None,
    };
    let root = providers::registry::root();
    runtime_schema::register_entrypoint(&root, &draft, None)
        .await
        .unwrap();
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: ENGINE.into(),
        active_runtime: "cp949".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    let target = runtime_schema::help_target(&root, &cfg).unwrap();
    assert_eq!(
        target.request, chosen,
        "rediscovery starts from the saved choice"
    );
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(effective.help_state, runtime_schema::HelpState::Current);
    let label = effective
        .schema
        .options
        .iter()
        .find(|o| o.key == "fresh_label")
        .unwrap();
    assert_eq!(label.help, KOREAN);

    // Registered-runtime rediscovery uses the same explicit path.
    let rediscovery = runtime_schema::help_command(&cfg, &target.request).unwrap();
    assert_eq!(
        rediscovery.environment.get("LC_ALL").map(String::as_str),
        Some("ko_KR.UTF-8"),
        "an explicit locale is not replaced by the default"
    );

    // A profile value reaches the actual spawned engine argv.
    cfg.provider_options.insert(
        ENGINE.into(),
        json!({"fresh_label": "값 ; &"})
            .as_object()
            .unwrap()
            .clone(),
    );
    let profile: aiolm_lib::config::profiles::SettingsProfile = serde_json::from_value(json!({
        "provider": ENGINE, "id": "synthetic-codepage-profile", "name": "Code page profile",
        "scope": "global", "revision": 1,
        "settings": { "provider_options": { ENGINE: { "fresh_label": "값 ; &" } } }
    }))
    .unwrap();
    let library = cfg.settings_profiles.as_mut().unwrap();
    library.entries.push(profile.clone());
    library.revision += 1;
    aiolm_lib::config::save(&cfg).unwrap();
    cfg = aiolm_lib::config::load_result().unwrap();
    assert_eq!(
        cfg.settings_profiles
            .as_ref()
            .unwrap()
            .entries
            .iter()
            .find(|entry| entry.id == profile.id),
        Some(&profile)
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let err = Arc::new(ErrBuf::default());
    let (child, url, _) = server::spawn(&cfg, "", &err, &Default::default()).unwrap();
    let state = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut shared = state.lock().unwrap();
        shared.child = Some(child);
        shared.engine = Some(providers::execution::info(&cfg).unwrap());
    }
    let ready = server::wait_ready(state.clone(), &url, "", 5, &err).await;
    server::kill(&mut state.lock().unwrap().child, Some(err.clone()));
    ready.unwrap();
    let argv: Vec<String> =
        serde_json::from_slice(&fs::read(area.join("argv.json")).unwrap()).unwrap();
    assert!(
        argv.ends_with(&["--fresh-label".to_string(), "값 ; &".into()]),
        "{argv:?}"
    );

    // Reviewing again under another locale is a different review: the
    // accepted CP949/ko_KR identity cannot be reused for it.
    let changed = request(json!({ "encoding": "cp949", "locale": "C" }));
    assert!(
        runtime_schema::accept(&root, &cfg, &descriptor.fingerprint, &changed).is_err(),
        "a review is pinned to its encoding and locale"
    );
    // A newly accepted text setting is also a new launch/probe identity.
    for (fingerprint, next) in [
        (other_locale.fingerprint, changed),
        (windows_1252, request(json!({ "encoding": "windows-1252" }))),
    ] {
        runtime_schema::accept(&root, &cfg, &fingerprint, &next).unwrap();
        let refusal = providers::registry::command(&cfg, cfg.port, "").unwrap_err();
        assert!(refusal.contains("fresh adapter probe"), "{refusal}");
        providers::adapter::refresh(&cfg, None).await.unwrap();
        providers::registry::command(&cfg, cfg.port, "").unwrap();
    }
    assert_eq!(
        Value::Object(aiolm_lib::config::load_result().unwrap().provider_options[ENGINE].clone()),
        json!({"fresh_label": "값 ; &"})
    );
    assert_eq!(
        aiolm_lib::config::load_result()
            .unwrap()
            .settings_profiles
            .as_ref()
            .unwrap()
            .entries
            .iter()
            .find(|entry| entry.id == profile.id),
        Some(&profile)
    );
}
