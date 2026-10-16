//! Adapter option metadata that names an observed help positional, from
//! native CLI registration through actual help discovery and review to the
//! effective schema, a confirmed static entry role, the saved profile, the
//! display copies that hide the slot's literal entry token and the argv the
//! spawned engine (or a real argparse parser) actually receives unchanged.
//! Declarations naming no positional, a flag option's key or a slot whose
//! sensitivity is left unknown hide nothing; changed metadata makes the
//! reviewed help stale and refuses launch while the token stays hidden.
//!
//! Every case runs in a child of this test binary with its own `AIOLM_HOME`;
//! the parent test never changes its process environment. The real
//! interpreter case is opt-in: set AIOLM_TEST_PYTHON to a Python 3
//! executable and run with `--ignored`. No inference claims.
use aiolm_lib::{
    providers::{
        self,
        runtime_help::HelpService,
        runtime_help_store, runtime_metadata,
        runtime_options::{Certainty, ManagedBinding, OptionDefinition, Source},
        runtime_schema::{self, ConfirmedSyntax, HelpState, REDACTED},
    },
    server, AppConfig, ErrBuf,
};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};

/// Present only in a spawned child; names the case it runs.
const CHILD_MODE: &str = "AIOLM_POSITIONAL_METADATA_JOURNEY";
const ENGINE: &str = "custom.positionalfixture";
/// A synthetic literal entry token in the slot the metadata declares secret.
const TOKEN: &str = "entry-4R-synthetic-static-token";
/// A synthetic saved value of a plain option; it must stay readable.
const PLAIN: &str = "plain-8M-synthetic-label";

fn owned_home() -> PathBuf {
    let base = std::env::temp_dir().canonicalize().unwrap();
    let home = base.join(format!("aiolm positional {}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).unwrap();
    home
}

/// Run one case in a child of this binary with an isolated home, then
/// remove only that home. The child's own summary proves the case ran.
fn run_child(mode: &str) {
    let parent_home = std::env::var_os("AIOLM_HOME");
    let home = owned_home();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "positional_metadata_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("AIOLM_HOME", &home)
        .env(CHILD_MODE, mode)
        .output();
    let base = std::env::temp_dir().canonicalize().unwrap();
    let owned = home.canonicalize().unwrap();
    assert!(owned.starts_with(&base), "refusing to remove {owned:?}");
    fs::remove_dir_all(&owned).unwrap();
    assert_eq!(
        std::env::var_os("AIOLM_HOME"),
        parent_home,
        "the parent process environment stays untouched"
    );
    let output = output.unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{mode} case failed ({:?}):\nstdout:\n{stdout}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("test result: ok. 1 passed"),
        "{mode} case did not run:\n{stdout}"
    );
}

#[test]
fn registered_positional_metadata_hides_its_static_entry_token_from_displays_only() {
    run_child("engine");
}

#[test]
#[ignore = "set AIOLM_TEST_PYTHON to a Python 3 executable and run with --ignored"]
fn a_real_argparse_entry_marker_declared_secret_by_metadata_is_hidden_but_parsed() {
    let python = std::env::var("AIOLM_TEST_PYTHON")
        .expect("AIOLM_TEST_PYTHON names the Python 3 executable to run");
    assert!(PathBuf::from(&python).is_file(), "{python} is not a file");
    run_child("python");
}

/// Child entry point for the cases above; a plain suite run returns at once.
#[tokio::test]
async fn positional_metadata_child() {
    let Ok(mode) = std::env::var(CHILD_MODE) else {
        return;
    };
    let home = PathBuf::from(std::env::var_os("AIOLM_HOME").expect("isolated home"));
    match mode.as_str() {
        "engine" => engine_journey(&home).await,
        "python" => python_journey(&home).await,
        other => panic!("unknown positional metadata case {other}"),
    }
}

fn metadata(revision: &str, options: Value) -> Value {
    json!({
        "version": 1, "engine_id": ENGINE,
        "adapter": {"id": "synthetic.adapter", "revision": revision},
        "options": options
    })
}

/// `aiolm-cli` against the isolated home, as a user would run it.
fn cli(home: &Path, args: &[&str]) -> (bool, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_aiolm-cli"))
        .args(args)
        .env("AIOLM_HOME", home)
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.success(), text)
}

fn cli_register(home: &Path, area: &Path, name: &str, manifest: &Value) -> (bool, String) {
    let source = area.join(format!("{name}.json"));
    fs::write(&source, serde_json::to_vec(manifest).unwrap()).unwrap();
    cli(
        home,
        &["runtime", "register-manifest", &source.to_string_lossy()],
    )
}

fn engine() -> providers::ProviderId {
    providers::ProviderId::parse(ENGINE).unwrap()
}

fn slot(effective: &runtime_schema::EffectiveSchema, key: &str) -> OptionDefinition {
    effective
        .schema
        .options
        .iter()
        .find(|o| o.key == key && o.position.is_some())
        .unwrap_or_else(|| panic!("{key} positional"))
        .clone()
}

fn issues(cfg: &AppConfig) -> Vec<String> {
    let manifest = providers::registry::manifest(engine(), &cfg.active_runtime).unwrap();
    providers::registry::saved_option_issues(
        cfg,
        &manifest,
        cfg.provider_options.get(ENGINE).unwrap_or(&Map::new()),
    )
    .into_iter()
    .map(|issue| format!("{}:{}", issue.key, issue.message))
    .collect()
}

fn confirm(
    root: &Path,
    cfg: &AppConfig,
    fingerprint: &str,
    entries: Value,
) -> runtime_schema::EffectiveSchema {
    let options: BTreeMap<String, ConfirmedSyntax> = serde_json::from_value(entries).unwrap();
    runtime_schema::save_supplement(root, cfg, fingerprint, options).unwrap()
}

fn assert_adapter_secret(option: &OptionDefinition, revision: &str) {
    assert_eq!(option.sensitive.supported(), Some(&true), "{option:?}");
    assert_eq!(option.sensitive.certainty, Certainty::Documented);
    assert!(
        matches!(&option.sensitive.source, Some(Source::Adapter { id, revision: r }) if id == "synthetic.adapter" && r == revision),
        "{option:?}"
    );
}

// --- synthetic engine through the app's own spawn path ---------------------

fn engine_manifest(area: &Path, argv_file: &Path, runtime: &str, metadata: Value) -> Value {
    let program = env!("CARGO_BIN_EXE_fake-llama-server");
    let env = json!({"FAKE_ENGINE_ARGV_FILE": argv_file, "FAKE_ENGINE_HELP": "metadata"});
    json!({
        "schema_version": 1, "adapter_version": 1, "engine_id": ENGINE, "runtime_id": runtime,
        "display_name": "Synthetic positional metadata engine", "protocol": "openai-v1",
        "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
        "probe": {"program": program, "args": ["--adapter-probe", ENGINE, runtime, "{model}", "{options_json}"], "env": env, "working_directory": area},
        "launch": {"program": program, "args": ["--adapter-engine", "--adapter-no-health-auth", TOKEN, "--model", "{model}", "--host", "{host}", "--port", "{port}"], "env": env, "working_directory": area},
        "command_layout": {"version": 1, "subcommands": [], "options": [{"index": 0, "values": 0}, {"index": 1, "values": 0}]},
        "launch_bindings": {"version": 1, "prefix_len": 3, "bindings": [
            {"name": "model", "argument": {"kind": "flag", "flag": "--model"}},
            {"name": "host", "argument": {"kind": "flag", "flag": "--host"}},
            {"name": "port", "argument": {"kind": "flag", "flag": "--port"}}]},
        "model_formats": ["unknown"], "health_path": "/health",
        "option_metadata": metadata
    })
}

/// Discover the synthetic help through the registered entry prefix, check
/// what the metadata review establishes before acceptance, and accept it.
fn discover_engine_help(root: &Path, cfg: &AppConfig, runtime: &str) -> (String, Value) {
    let mut request = runtime_schema::help_target(root, cfg).unwrap().request;
    request.args = [
        "--adapter-engine",
        "--adapter-no-health-auth",
        TOKEN,
        "--adapter-help-fixture",
        "--help",
    ]
    .map(String::from)
    .to_vec();
    let command = runtime_schema::help_command(cfg, &request).unwrap();
    let (report, descriptor) = runtime_help_store::discover_persist_describe(
        &HelpService::default(),
        root,
        "positional-owner",
        ENGINE,
        runtime,
        &command,
        &[],
    )
    .unwrap();
    assert!(report.complete(), "{report:?}");
    // Help alone shows the positional's syntax, never its sensitivity.
    let target = descriptor
        .schema
        .options
        .iter()
        .find(|o| o.key == "target")
        .unwrap();
    assert!(target.position.is_some() && target.spellings.is_empty());
    assert!(target.sensitive.supported().is_none());
    let metadata = runtime_schema::selected_metadata(cfg).unwrap().unwrap().0;
    let review = runtime_metadata::review(&descriptor.schema, &metadata, false);
    runtime_schema::accept(root, cfg, &descriptor.fingerprint, &request).unwrap();
    (
        descriptor.fingerprint,
        serde_json::to_value(review).unwrap(),
    )
}

async fn engine_journey(home: &Path) {
    let area = home.join("engine area");
    fs::create_dir(&area).unwrap();
    let model = area.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let argv_file = area.join("argv.json");
    let declared = |revision: &str| {
        metadata(
            revision,
            json!([
                {"positional": "target", "sensitive": true},
                {"flag": "--fresh-amber", "sensitive": true}
            ]),
        )
    };

    // The native CLI refuses ambiguous, malformed or ownership-changing
    // declarations and registers nothing.
    for (options, needle) in [
        (
            json!([{"flag": "--fresh-label", "positional": "target", "sensitive": true}]),
            "exactly one",
        ),
        (json!([{"sensitive": true}]), "exactly one"),
        (
            json!([{"positional": "-target", "sensitive": true}]),
            "positional",
        ),
        (
            json!([{"positional": "target", "sensitive": true}, {"positional": "target", "unit": "s"}]),
            "distinct",
        ),
        (
            json!([{"positional": "target", "reserved": "the app owns it"}]),
            "reserved",
        ),
    ] {
        let manifest = engine_manifest(&area, &argv_file, "build-1", metadata("r1", options));
        let (ok, text) = cli_register(home, &area, "refused", &manifest);
        assert!(!ok && text.contains(needle), "{needle}: {text}");
        assert!(providers::registry::manifest(engine(), "build-1").is_err());
    }
    let manifest = engine_manifest(&area, &argv_file, "build-1", declared("r1"));
    let (ok, text) = cli_register(home, &area, "build-1", &manifest);
    assert!(ok, "{text}");
    // The stored registration keeps the real entry token.
    let stored = providers::registry::manifest(engine(), "build-1").unwrap();
    assert_eq!(stored.launch.args[2], TOKEN);

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
    let (fingerprint, review) = discover_engine_help(&root, &cfg, "build-1");
    assert!(
        review["applied"]
            .as_array()
            .unwrap()
            .contains(&json!("target")),
        "{review:#}"
    );

    // The effective schema carries the adapter's fact on the observed slot,
    // whose role the user has yet to confirm.
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(effective.help_state, HelpState::Current);
    let target = slot(&effective, "target");
    assert_adapter_secret(&target, "r1");
    assert_eq!(target.managed, Some(ManagedBinding::Discovery));
    let label = effective
        .schema
        .options
        .iter()
        .find(|o| o.key == "fresh_label")
        .unwrap();
    assert!(label.sensitive.supported().is_none());
    assert!(effective.metadata.as_ref().unwrap().conflicts.is_empty());
    let entry = effective.entry.clone().unwrap();
    assert_eq!(entry.static_candidates(), vec![2]);
    // Until the token's role is confirmed nothing claims it is in the slot.
    let program = stored.launch.program.clone();
    let shown = vec![program.clone(), TOKEN.into(), PLAIN.into()];
    assert_eq!(
        runtime_schema::mask_argv(&root, &cfg, shown.clone(), REDACTED),
        shown
    );

    let effective = confirm(
        &root,
        &cfg,
        &fingerprint,
        json!({"target": {"positional": {"role": "static", "index": 2}}}),
    );
    let target = slot(&effective, "target");
    assert_eq!(target.managed, Some(ManagedBinding::EntryPoint));
    assert_adapter_secret(&target, "r1");

    let mut values = Map::new();
    values.insert("fresh_label".into(), json!(PLAIN));
    cfg.provider_options.insert(ENGINE.into(), values.clone());
    assert!(issues(&cfg).is_empty(), "{:?}", issues(&cfg));
    aiolm_lib::config::save(&cfg).unwrap();
    let loaded = aiolm_lib::config::load_result().unwrap();
    assert_eq!(loaded.provider_options[ENGINE], values);
    providers::adapter::refresh(&loaded, None).await.unwrap();
    let planned = providers::registry::command(&loaded, port, "synthetic-key").unwrap();
    assert_eq!(planned.args.iter().filter(|a| *a == TOKEN).count(), 1);
    assert!(planned.args.contains(&PLAIN.to_string()), "{planned:?}");

    // Display copies hide exactly that token; everything else stays.
    let preview = providers::command_preview(&loaded).unwrap();
    assert!(!preview.iter().any(|a| a.contains(TOKEN)), "{preview:?}");
    assert_eq!(preview.iter().filter(|a| *a == REDACTED).count(), 1);
    let restored: Vec<String> = preview
        .iter()
        .map(|a| {
            if a == REDACTED {
                TOKEN.into()
            } else {
                a.clone()
            }
        })
        .collect();
    assert!(restored.ends_with(&planned.args), "{preview:?}");
    assert!(preview.contains(&PLAIN.to_string()));
    let (ok, shown_config) = cli(home, &["config", "get"]);
    assert!(ok, "{shown_config}");
    assert!(!shown_config.contains(TOKEN) && shown_config.contains(PLAIN));

    // The spawned engine receives the exact planned argv, token included.
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
    {
        let mut state = shared.lock().unwrap();
        server::kill(&mut state.child, Some(err.clone()));
    }
    assert_eq!(argv, planned.args);

    // Changed metadata under the same runtime ID makes the reviewed help
    // stale: launch is refused, the token stays hidden in displays, and the
    // registration and saved values are untouched.
    providers::registry::remove(engine(), "build-1").unwrap();
    let manifest = engine_manifest(&area, &argv_file, "build-1", declared("r2"));
    let (ok, text) = cli_register(home, &area, "build-1-r2", &manifest);
    assert!(ok, "{text}");
    let stale = runtime_schema::effective(&root, &loaded, true).unwrap();
    assert_eq!(stale.help_state, HelpState::Stale);
    providers::adapter::refresh(&loaded, None).await.unwrap();
    assert!(providers::registry::command(&loaded, port, "synthetic-key").is_err());
    assert_eq!(
        runtime_schema::mask_argv(&root, &loaded, shown.clone(), REDACTED),
        vec![program.clone(), REDACTED.into(), PLAIN.into()]
    );
    assert_eq!(
        providers::registry::manifest(engine(), "build-1")
            .unwrap()
            .launch
            .args[2],
        TOKEN
    );
    assert_eq!(
        aiolm_lib::config::load_result().unwrap().provider_options[ENGINE],
        values
    );

    // Another runtime declares facts for the same slot without sensitivity,
    // plus declarations for an absent positional and for a flag option's
    // key: nothing is hidden and nothing attaches to a neighbour.
    let manifest = engine_manifest(
        &area,
        &argv_file,
        "build-2",
        metadata(
            "r3",
            json!([
                {"positional": "target", "unit": "entries"},
                {"positional": "absent_slot", "sensitive": true},
                {"positional": "fresh_label", "sensitive": true}
            ]),
        ),
    );
    let (ok, text) = cli_register(home, &area, "build-2", &manifest);
    assert!(ok, "{text}");
    let mut other = loaded.clone();
    other.active_runtime = "build-2".into();
    let (fingerprint, review) = discover_engine_help(&root, &other, "build-2");
    let reported = |positional: &str| {
        review["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["positional"] == positional && c["field"] == "option" && c["flag"] == "")
    };
    assert!(
        reported("absent_slot") && reported("fresh_label"),
        "{review:#}"
    );
    let effective = confirm(
        &root,
        &other,
        &fingerprint,
        json!({"target": {"positional": {"role": "static", "index": 2}}}),
    );
    let target = slot(&effective, "target");
    assert!(target.sensitive.supported().is_none());
    assert_eq!(target.unit.supported().map(String::as_str), Some("entries"));
    assert!(effective
        .schema
        .options
        .iter()
        .find(|o| o.key == "fresh_label")
        .unwrap()
        .sensitive
        .supported()
        .is_none());
    assert_eq!(
        runtime_schema::mask_argv(&root, &other, shown.clone(), REDACTED),
        shown
    );
}

// --- a real argparse parser behind an interpreter command -------------------

const SCRIPT: &str = r#"import argparse, json, sys
p = argparse.ArgumentParser(prog="engine")
p.add_argument("--label", required=True)
p.add_argument("marker", help="entry marker")
p.add_argument("source", help="user input file")
p.add_argument("--model", required=True)
p.add_argument("--port", required=True)
print(json.dumps({"argv": sys.argv[1:], "parsed": vars(p.parse_args())}))
"#;

fn python_manifest(python: &str, home: &Path, script: &Path, revision: &str) -> Value {
    let probe = env!("CARGO_BIN_EXE_fake-llama-server");
    let script_text = script.to_string_lossy();
    json!({"schema_version":1,"adapter_version":1,"engine_id":ENGINE,"runtime_id":"r1","display_name":"Real interpreter marker","platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],"protocol":"openai-v1","model_formats":["unknown"],"health_path":"/health",
      "command_layout":{"version":1,"subcommands":[],"options":[{"index":0,"values":0},{"index":2,"values":1}]},
      "launch_bindings":{"version":1,"prefix_len":5,"bindings":[{"name":"model","argument":{"kind":"flag","flag":"--model"}},{"name":"port","argument":{"kind":"flag","flag":"--port"}}]},
      "launch":{"program":python,"args":["-I",script_text,"--label","serve",TOKEN,"--model","{model}","--port","{port}"],"env":{},"working_directory":home},
      "probe":{"program":probe,"args":["--adapter-probe",ENGINE,"r1","{model}","{options_json}"],"env":{}},
      "artifacts":[script],
      "option_metadata": metadata(revision, json!([{"positional": "marker", "sensitive": true}]))})
}

async fn python_journey(home: &Path) {
    let python = std::env::var("AIOLM_TEST_PYTHON").unwrap();
    let area = home.join("interpreter 눈길");
    fs::create_dir(&area).unwrap();
    let script = area.join("engine 눈길.py");
    fs::write(&script, SCRIPT).unwrap();
    let model = area.join("synthetic model.bin");
    fs::write(&model, b"synthetic").unwrap();
    let (ok, text) = cli_register(
        home,
        &area,
        "r1",
        &python_manifest(&python, &area, &script, "r1"),
    );
    assert!(ok, "{text}");
    let mut cfg = AppConfig {
        active_provider: ENGINE.into(),
        active_runtime: "r1".into(),
        active_model: model.to_string_lossy().into_owned(),
        ..Default::default()
    };
    cfg.normalize();
    let root = providers::registry::root();

    // The actual argparse help through the same entry prefix.
    let request = runtime_schema::help_target(&root, &cfg).unwrap().request;
    let command = runtime_schema::help_command(&cfg, &request).unwrap();
    let (report, descriptor) = runtime_help_store::discover_persist_describe(
        &HelpService::default(),
        &root,
        "interpreter",
        ENGINE,
        "r1",
        &command,
        &[],
    )
    .unwrap();
    assert!(report.complete(), "{report:?}");
    runtime_schema::accept(&root, &cfg, &descriptor.fingerprint, &request).unwrap();
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_adapter_secret(&slot(&effective, "marker"), "r1");
    assert!(slot(&effective, "source").sensitive.supported().is_none());
    // The script path is a candidate too; only the marker is confirmed.
    assert!(effective
        .entry
        .clone()
        .unwrap()
        .static_candidates()
        .contains(&4));
    let effective = confirm(
        &root,
        &cfg,
        &descriptor.fingerprint,
        json!({
            "marker": {"positional": {"role": "static", "index": 4}},
            "source": {"positional": {"role": "user"}}}),
    );
    assert_eq!(
        slot(&effective, "marker").managed,
        Some(ManagedBinding::EntryPoint)
    );

    let mut values = Map::new();
    values.insert("source".into(), json!("in.txt"));
    cfg.provider_options.insert(ENGINE.into(), values.clone());
    assert!(issues(&cfg).is_empty(), "{:?}", issues(&cfg));
    aiolm_lib::config::save(&cfg).unwrap();
    let cfg = aiolm_lib::config::load_result().unwrap();
    assert_eq!(cfg.provider_options[ENGINE], values);
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let launch = providers::registry::command(&cfg, cfg.port, "synthetic-key").unwrap();
    assert_eq!(launch.args.iter().filter(|a| *a == TOKEN).count(), 1);

    let preview = providers::command_preview(&cfg).unwrap();
    assert!(!preview.iter().any(|a| a.contains(TOKEN)), "{preview:?}");
    assert_eq!(preview.iter().filter(|a| *a == REDACTED).count(), 1);
    let script_text = script.to_string_lossy().into_owned();
    for visible in ["in.txt", "serve", script_text.as_str(), python.as_str()] {
        assert!(
            preview.iter().any(|a| a == visible),
            "{visible}: {preview:?}"
        );
    }

    // The real parser receives the exact argv and the token in its slot.
    let mut actual = Command::new(&launch.program);
    actual
        .args(&launch.args)
        .env_clear()
        .envs(launch.env.iter().map(|(key, value)| (key, value)))
        .current_dir(launch.working_directory.clone().unwrap());
    if let Some(system) = std::env::var_os("SYSTEMROOT") {
        actual.env("SYSTEMROOT", system);
    }
    let output = actual.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed["argv"], json!(launch.args[2..]));
    let parsed = &observed["parsed"];
    assert_eq!(parsed["marker"], TOKEN);
    assert_eq!(parsed["source"], "in.txt");
    assert_eq!(parsed["label"], "serve");
    assert_eq!(parsed["model"], json!(cfg.active_model));
    assert_eq!(parsed["port"], json!(cfg.port.to_string()));

    // A new metadata revision makes the review stale: launch is refused and
    // the stored token stays hidden in display copies.
    providers::registry::remove(engine(), "r1").unwrap();
    let (ok, text) = cli_register(
        home,
        &area,
        "r1-r2",
        &python_manifest(&python, &area, &script, "r2"),
    );
    assert!(ok, "{text}");
    assert_eq!(
        runtime_schema::effective(&root, &cfg, true)
            .unwrap()
            .help_state,
        HelpState::Stale
    );
    providers::adapter::refresh(&cfg, None).await.unwrap();
    assert!(providers::registry::command(&cfg, cfg.port, "synthetic-key").is_err());
    let shown = vec![python.clone(), TOKEN.into(), "in.txt".into()];
    assert_eq!(
        runtime_schema::mask_argv(&root, &cfg, shown, REDACTED),
        vec![python.clone(), REDACTED.into(), "in.txt".into()]
    );
}
