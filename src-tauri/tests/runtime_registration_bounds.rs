//! A registration is only published when this app can read it back: the
//! complete record (manifest, option metadata, hashes and probe result) stays
//! within the 256 KiB registration reader limit. Oversized option metadata
//! literals and manifests are refused with a concrete diagnostic before the
//! probe runs, through the entry-point draft and manifest file paths, and
//! files already in the runtime directory are left untouched. No inference
//! claims.
use aiolm_lib::providers::{
    self,
    registry::{ArgBinding, AuthBinding, EntrypointDraft, ProcessSpec, ServingProtocol},
    runtime_schema,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

struct TestHome {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl TestHome {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "aiolm-registration-bounds-{}",
            uuid::Uuid::new_v4()
        ));
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

const ENGINE: &str = "custom.boundsfixture";
const BIG: usize = 300 * 1024;

fn engine() -> providers::ProviderId {
    providers::ProviderId::parse(ENGINE).unwrap()
}

fn metadata(entry: Value, constraints: Value) -> Value {
    json!({"version": 1, "engine_id": ENGINE, "adapter": {"id": "synthetic.adapter", "revision": "r1"},
        "options": [entry], "constraints": constraints})
}

fn draft(area: &Path, marker: &Path, metadata: Value) -> EntrypointDraft {
    let program = env!("CARGO_BIN_EXE_fake-llama-server").to_string();
    EntrypointDraft {
        launch_resources: None,
        models: vec![],
        engine_id: engine(),
        runtime_id: "build-1".into(),
        display_name: "Synthetic bounds engine".into(),
        program: program.clone(),
        prefix: vec!["--adapter-engine".into(), "--adapter-no-health-auth".into()],
        working_directory: Some(area.to_string_lossy().into_owned()),
        artifacts: vec![],
        environment: BTreeMap::new(),
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
            program,
            args: vec![
                "--adapter-probe".into(),
                ENGINE.into(),
                "build-1".into(),
                "{model}".into(),
            ],
            env: BTreeMap::from([(
                "FAKE_PROBE_MARKER".to_string(),
                marker.to_string_lossy().into_owned(),
            )]),
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: None,
        option_metadata: Some(serde_json::from_value(metadata).unwrap()),
    }
}

#[tokio::test]
async fn oversized_registrations_are_refused_before_probe_and_publication() {
    let area = TestHome::new();
    let root = providers::registry::root();
    let marker = area.path.join("probed.txt");
    let big = "x".repeat(BIG);
    // Reviewed help kept in the runtime directory must survive a refusal.
    let help_dir = root.join(ENGINE).join("build-1").join("help");
    fs::create_dir_all(&help_dir).unwrap();
    let kept = help_dir.join("keep.json");
    fs::write(&kept, b"{\"synthetic\":true}").unwrap();
    let registration = root.join(ENGINE).join("build-1").join("registration.json");

    // One literal each: a default, a choice and a constraint operand.
    for (name, document) in [
        (
            "default",
            metadata(
                json!({"flag": "--fresh-label", "kind": "text", "runtime_default": {"literal": big}}),
                json!([]),
            ),
        ),
        (
            "choice",
            metadata(
                json!({"flag": "--fresh-label", "choices": ["short", big]}),
                json!([]),
            ),
        ),
        (
            "constraint",
            metadata(
                json!({"flag": "--fresh-label", "sensitive": true}),
                json!([{"kind": "excludes", "when": {"flag": "--fresh-label", "equals": big}, "other": {"flag": "--fresh-count"}}]),
            ),
        ),
    ] {
        let draft = draft(&area.path, &marker, document);
        let error = runtime_schema::register_entrypoint(&root, &draft, None)
            .await
            .unwrap_err();
        assert!(error.contains("KiB"), "{name}: {error}");
        assert!(!marker.exists(), "{name}: the probe must not run");
        assert!(!registration.exists(), "{name}: nothing is published");
        assert_eq!(fs::read(&kept).unwrap(), b"{\"synthetic\":true}");
        // The manifest preview shown before registering refuses it too.
        let preview = providers::registry::manifest_from_draft(&draft).unwrap_err();
        assert!(preview.contains("KiB"), "{name} preview: {preview}");
    }

    // A manifest file under the reader limit whose complete (pretty-printed)
    // registration record would not be readable is refused the same way.
    let program = env!("CARGO_BIN_EXE_fake-llama-server");
    let choices = (0..1150)
        .map(|i| format!("{i:05}{}", "c".repeat(209)))
        .collect::<Vec<_>>();
    let options = choices
        .chunks(115)
        .enumerate()
        .map(|(i, chunk)| json!({"key": format!("wide_{i}"), "flag": format!("--wide-{i}"), "target": "launch", "kind": {"type": "choice", "choices": chunk}}))
        .collect::<Vec<_>>();
    let manifest = json!({
        "schema_version": 1, "adapter_version": 1, "engine_id": ENGINE, "runtime_id": "build-1",
        "display_name": "Synthetic bounds engine", "protocol": "openai-v1",
        "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
        "probe": {"program": program, "args": ["--adapter-probe", ENGINE, "build-1", "{model}", "{options_json}"], "env": {"FAKE_PROBE_MARKER": marker}},
        "launch": {"program": program, "args": ["--adapter-engine", "--model", "{model}", "--port", "{port}"]},
        "model_formats": ["unknown"], "health_path": "/health", "options": options
    });
    let source = area.path.join("runtime.json");
    let bytes = serde_json::to_vec(&manifest).unwrap();
    assert!(bytes.len() < 256 * 1024, "the file itself is readable");
    fs::write(&source, bytes).unwrap();
    let error = providers::registry::register(&source, None)
        .await
        .unwrap_err();
    assert!(error.contains("KiB"), "{error}");
    assert!(!marker.exists(), "the probe must not run");
    assert!(!registration.exists());
    assert_eq!(fs::read(&kept).unwrap(), b"{\"synthetic\":true}");

    // A normal registration of the same engine still publishes and reads back.
    let normal = draft(
        &area.path,
        &marker,
        metadata(
            json!({"flag": "--fresh-label", "sensitive": true}),
            json!([]),
        ),
    );
    runtime_schema::register_entrypoint(&root, &normal, None)
        .await
        .unwrap();
    assert!(marker.exists());
    let stored = providers::registry::manifest(engine(), "build-1").unwrap();
    assert_eq!(stored.option_metadata, normal.option_metadata);
    assert!(fs::metadata(&registration).unwrap().len() <= 256 * 1024);
}
