//! A real interpreter command: `python -I engine.py --label serve serve api
//! MARKER {model} --port {port}` with an argparse parser. Its actual help is
//! discovered and reviewed; explicit positional roles interleave user slots
//! with the app's model binding and a fixed entry literal; a full pasted
//! command imports through the registered entry; saved values reload and the
//! real parser accepts the exact launch argv. Opt-in: set AIOLM_TEST_PYTHON
//! to a Python 3 executable and run with `--ignored`. This certifies argv and
//! parser acceptance only, not inference or any engine.
use aiolm_lib::{
    providers::{
        self,
        options::CommandSyntax,
        runtime_help::HelpService,
        runtime_help_store,
        runtime_options::ManagedBinding,
        runtime_ordered::{self, OrderEntry, SavedOrder, ORDER_KEY},
        runtime_schema::{self, ConfirmedSyntax},
    },
    AppConfig,
};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, fs, path::PathBuf, process::Command};

struct Home {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl Home {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("aiolm interpreter 눈길 {}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // One test per integration binary; no concurrent reader of this.
        std::env::set_var("AIOLM_HOME", &path);
        Self { path, previous }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("AIOLM_HOME", value),
            None => std::env::remove_var("AIOLM_HOME"),
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

const ENGINE: &str = "custom.interpreterfixture";

const SCRIPT: &str = r#"import argparse, json, os, sys
p = argparse.ArgumentParser(prog="engine")
p.add_argument("--label", required=True)
p.add_argument("--global-name")
top = p.add_subparsers(dest="command", required=True)
serve = top.add_parser("serve")
serve.add_argument("--worker-mode")
leaf = serve.add_subparsers(dest="leaf", required=True)
api = leaf.add_parser("api")
api.add_argument("input", help="user input file")
api.add_argument("model", help="model path")
api.add_argument("marker", help="fixed marker")
api.add_argument("output", help="user output file")
api.add_argument("--port", required=True)
api.add_argument("--pair", nargs=2, metavar=("X", "Y"), action="append")
api.add_argument("--count", type=int)
a = p.parse_args()
print(json.dumps({"argv": sys.argv[1:], "parsed": vars(a), "key": os.environ.get("FRESH_KEY")}))
"#;

fn issues(cfg: &AppConfig, values: &Map<String, Value>) -> Vec<(String, String)> {
    let engine = providers::ProviderId::parse(ENGINE).unwrap();
    let manifest = providers::registry::manifest(engine, &cfg.active_runtime).unwrap();
    providers::registry::saved_option_issues(cfg, &manifest, values)
        .into_iter()
        .map(|issue| (issue.key, issue.message))
        .collect()
}

#[tokio::test]
#[ignore = "set AIOLM_TEST_PYTHON to a Python 3 executable and run with --ignored"]
async fn a_real_interpreter_command_interleaves_mapped_positionals_in_slot_order() {
    let python = std::env::var("AIOLM_TEST_PYTHON")
        .expect("AIOLM_TEST_PYTHON names the Python 3 executable to run");
    assert!(PathBuf::from(&python).is_file(), "{python} is not a file");
    let home = Home::new();
    let script = home.path.join("engine 눈길.py");
    fs::write(&script, SCRIPT).unwrap();
    let model = home.path.join("synthetic model.bin");
    fs::write(&model, b"synthetic").unwrap();
    let script_text = script.to_string_lossy().into_owned();
    let prefix: Vec<String> = [
        "-I",
        script_text.as_str(),
        "--label",
        "serve",
        "serve",
        "api",
        "MARKER",
    ]
    .map(String::from)
    .to_vec();
    let mut args = prefix.clone();
    args.extend(["{model}", "--port", "{port}"].map(String::from));
    let probe = env!("CARGO_BIN_EXE_fake-llama-server");
    let manifest = json!({"schema_version":1,"adapter_version":1,"engine_id":ENGINE,"runtime_id":"r1","display_name":"Real interpreter command","platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],"protocol":"openai-v1","model_formats":["unknown"],"health_path":"/health",
      "command_layout":{"version":1,"subcommands":[4,5],"options":[{"index":0,"values":0},{"index":2,"values":1}]},
      "launch_bindings":{"version":1,"prefix_len":7,"bindings":[{"name":"model","argument":{"kind":"positional"}},{"name":"port","argument":{"kind":"flag","flag":"--port"}}]},
      "launch":{"program":python,"args":args,"env":{"FRESH_KEY":"{api_key}"},"working_directory":home.path},
      "probe":{"program":probe,"args":["--adapter-probe",ENGINE,"r1","{model}","{options_json}"],"env":{}},
      "artifacts":[script],
      "options":[{"key":"global_name","flag":"--global-name","kind":{"type":"text","max_len":128},"target":"launch","scope":[]},{"key":"worker_mode","flag":"--worker-mode","kind":{"type":"text","max_len":128},"target":"launch","scope":["serve"]}]});
    let source = home.path.join("manifest.json");
    fs::write(&source, serde_json::to_vec(&manifest).unwrap()).unwrap();
    providers::registry::register(&source, None).await.unwrap();
    let mut cfg = AppConfig {
        active_provider: ENGINE.into(),
        active_runtime: "r1".into(),
        active_model: model.to_string_lossy().into_owned(),
        ..Default::default()
    };
    cfg.normalize();
    let root = providers::registry::root();

    // The actual argparse help of the leaf command, through the same prefix.
    let request = runtime_schema::help_target(&root, &cfg).unwrap().request;
    assert_eq!(request.scope, vec!["serve", "api"]);
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
    let slot = |effective: &runtime_schema::EffectiveSchema, key: &str| {
        effective
            .schema
            .options
            .iter()
            .find(|o| o.key == key && o.position.is_some())
            .unwrap_or_else(|| panic!("{key} positional"))
            .clone()
    };
    for key in ["input", "model", "marker", "output"] {
        assert_eq!(
            slot(&effective, key).managed,
            Some(ManagedBinding::Discovery)
        );
    }
    let entry = effective.entry.clone().unwrap();
    assert_eq!(entry.positional_bindings, Some(vec!["model".to_string()]));
    assert_eq!(entry.static_candidates(), vec![6]);

    let confirm = |entries: Value| -> Result<runtime_schema::EffectiveSchema, String> {
        let options: BTreeMap<String, ConfirmedSyntax> = serde_json::from_value(entries).unwrap();
        runtime_schema::save_supplement(&root, &cfg, &descriptor.fingerprint, options)
    };
    // Incomplete, gapped, misbound and non-positional mappings are refused.
    assert!(confirm(json!({"input": {"positional": {"role": "user"}}}))
        .unwrap_err()
        .contains("binding model"));
    assert!(confirm(json!({
        "model": {"positional": {"role": "binding", "name": "model"}},
        "marker": {"positional": {"role": "static", "index": 6}},
        "output": {"positional": {"role": "user"}}}))
    .unwrap_err()
    .contains("earlier positional input"));
    assert!(confirm(json!({
        "input": {"positional": {"role": "binding", "name": "port"}}}))
    .is_err());
    assert!(confirm(json!({
        "input": {"positional": {"role": "static", "index": 3}}}))
    .is_err());
    // [user input, app model, fixed marker, user output] plus the tuple
    // option's repetition, which argparse help cannot show.
    let effective = confirm(json!({
        "input": {"positional": {"role": "user"}},
        "model": {"positional": {"role": "binding", "name": "model"}},
        "marker": {"positional": {"role": "static", "index": 6}},
        "output": {"positional": {"role": "user"}},
        "pair": {"repeatable": true}}))
    .unwrap();
    assert_eq!(slot(&effective, "input").managed, None);
    assert_eq!(
        slot(&effective, "model").managed,
        Some(ManagedBinding::Model)
    );
    assert_eq!(
        slot(&effective, "marker").managed,
        Some(ManagedBinding::EntryPoint)
    );
    assert_eq!(slot(&effective, "output").managed, None);
    let entry = effective.entry.clone().unwrap();
    assert_eq!(entry.positional_roles.len(), 4);
    // A changed declared script is refused before any template token is
    // relocated, even with no user value saved (the artifact gate fires
    // first; the reviewed-help check also covers relocated slots).
    providers::adapter::refresh(&cfg, None).await.unwrap();
    fs::write(&script, format!("{SCRIPT}\n# changed\n")).unwrap();
    let stale = providers::registry::command(&cfg, cfg.port, "synthetic-key").unwrap_err();
    assert!(
        stale.contains("artifact changed") || stale.contains("changed since"),
        "{stale}"
    );
    fs::write(&script, SCRIPT).unwrap();
    // Isolated: the accepted review's help command no longer matches what
    // would run (its stored request differs; no artifact changed, no user
    // value is saved, the confirmed roles stay pinned). The template tokens
    // the roles would relocate are refused instead of launched.
    let accepted = root
        .join(ENGINE)
        .join("r1")
        .join("help")
        .join("accepted.json");
    let reviewed = fs::read(&accepted).unwrap();
    let mut record: Value = serde_json::from_slice(&reviewed).unwrap();
    record["request"]["args"]
        .as_array_mut()
        .unwrap()
        .push(json!("--help"));
    fs::write(&accepted, serde_json::to_vec(&record).unwrap()).unwrap();
    let stale = providers::registry::command(&cfg, cfg.port, "synthetic-key").unwrap_err();
    assert!(stale.contains("changed since"), "{stale}");
    fs::write(&accepted, &reviewed).unwrap();

    // A full pasted Windows-syntax command for this registered entry.
    let pasted = format!(
        r#""{python}" -I "{script_text}" --label serve --global-name serve serve --worker-mode api api in.txt "{}" MARKER out.txt --port 9 --pair a b --count 7 --pair c d"#,
        cfg.active_model
    );
    let imported = runtime_ordered::import_plan_for_entry(
        &effective.schema,
        &effective.scope,
        Some(&entry),
        &pasted,
        CommandSyntax::Windows,
    )
    .unwrap();
    assert!(
        imported.unrecognized.is_empty(),
        "{:?}",
        imported.unrecognized
    );
    assert_eq!(
        imported.managed,
        vec![cfg.active_model.clone(), "--port".into(), "9".into()]
    );
    let keys: Vec<&str> = imported.plan.iter().map(|row| row.key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "global_name",
            "worker_mode",
            "input",
            "output",
            "pair",
            "count",
            "pair"
        ]
    );
    let mut values = serde_json::to_value(runtime_ordered::overrides_from_plan(&imported.plan))
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
    values.insert(
        ORDER_KEY.into(),
        serde_json::to_value(SavedOrder {
            version: 1,
            occurrences: imported
                .plan
                .iter()
                .map(|row| OrderEntry {
                    key: row.key.clone(),
                    spelling: row.spelling.clone(),
                })
                .collect(),
        })
        .unwrap(),
    );
    cfg.provider_options.insert(ENGINE.into(), values.clone());
    aiolm_lib::config::save(&cfg).unwrap();
    cfg = aiolm_lib::config::load_result().unwrap();
    assert_eq!(cfg.provider_options[ENGINE], values);
    assert!(
        issues(&cfg, &values).is_empty(),
        "{:?}",
        issues(&cfg, &values)
    );

    providers::adapter::refresh(&cfg, None).await.unwrap();
    let launch = providers::registry::command(&cfg, cfg.port, "synthetic-key").unwrap();
    let port = cfg.port.to_string();
    let expected: Vec<String> = [
        "-I",
        script_text.as_str(),
        "--label",
        "serve",
        "--global-name",
        "serve",
        "serve",
        "--worker-mode",
        "api",
        "api",
        "--port",
        port.as_str(),
        "--pair",
        "a",
        "b",
        "--count",
        "7",
        "--pair",
        "c",
        "d",
        "in.txt",
        cfg.active_model.as_str(),
        "MARKER",
        "out.txt",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(launch.args, expected);
    let mut actual = Command::new(&launch.program);
    actual
        .args(&launch.args)
        .env_clear()
        .envs(launch.env.iter().map(|(key, value)| (key, value)))
        .current_dir(launch.working_directory.clone().unwrap());
    if let Some(root) = std::env::var_os("SYSTEMROOT") {
        actual.env("SYSTEMROOT", root);
    }
    let output = actual.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value = serde_json::from_slice(&output.stdout).unwrap();
    // The interpreter consumes `-I` and the script path itself.
    assert_eq!(observed["argv"], json!(launch.args[2..]));
    let parsed = &observed["parsed"];
    assert_eq!(parsed["label"], "serve");
    assert_eq!(parsed["global_name"], "serve");
    assert_eq!(parsed["command"], "serve");
    assert_eq!(parsed["worker_mode"], "api");
    assert_eq!(parsed["leaf"], "api");
    assert_eq!(parsed["input"], "in.txt");
    assert_eq!(parsed["model"], json!(cfg.active_model));
    assert_eq!(parsed["marker"], "MARKER");
    assert_eq!(parsed["output"], "out.txt");
    assert_eq!(parsed["port"], json!(port));
    assert_eq!(parsed["pair"], json!([["a", "b"], ["c", "d"]]));
    assert_eq!(parsed["count"], 7);
    assert_eq!(observed["key"], "synthetic-key");

    // A missing earlier user slot is refused, never shifted.
    let mut gap = values.clone();
    gap.remove("input");
    gap.remove(ORDER_KEY);
    assert!(issues(&cfg, &gap)
        .iter()
        .any(|(key, message)| key == "input" && message.contains("earlier positional")));
    // The app-owned model slot cannot be set as a generic value.
    let mut forged = values.clone();
    forged.insert("model".into(), json!("other.bin"));
    assert!(issues(&cfg, &forged).iter().any(|(key, _)| key == "model"));
    // Without the roles the saved values are retained and launch refuses.
    runtime_schema::clear_supplement(&root, &cfg).unwrap();
    assert!(providers::registry::command(&cfg, cfg.port, "synthetic-key").is_err());
    assert_eq!(
        aiolm_lib::config::load_result().unwrap().provider_options[ENGINE],
        values
    );

    // A plain `python -I tool.py INPUT OUTPUT`, with and without a declared
    // command layout: the interpreter flag and script path stay exactly in
    // place and only the script's own positionals are mapped.
    let tool = home.path.join("tool 눈길.py");
    fs::write(&tool, TOOL).unwrap();
    for (runtime, layout) in [("simple-layout", true), ("simple-plain", false)] {
        simple_entry(&python, &home.path, &tool, &mut cfg, runtime, layout).await;
    }
}

const TOOL: &str = r#"import argparse, json, sys
p = argparse.ArgumentParser(prog="tool")
p.add_argument("input", help="input file")
p.add_argument("output", help="output file")
p.add_argument("--model", required=True)
p.add_argument("--port", required=True)
p.add_argument("--count", type=int)
print(json.dumps({"argv": sys.argv[1:], "parsed": vars(p.parse_args())}))
"#;

async fn simple_entry(
    python: &str,
    home: &std::path::Path,
    tool: &std::path::Path,
    cfg: &mut AppConfig,
    runtime: &str,
    layout: bool,
) {
    let tool_text = tool.to_string_lossy().into_owned();
    let probe = env!("CARGO_BIN_EXE_fake-llama-server");
    let mut manifest = json!({"schema_version":1,"adapter_version":1,"engine_id":ENGINE,"runtime_id":runtime,"display_name":"Plain interpreter script","platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],"protocol":"openai-v1","model_formats":["unknown"],"health_path":"/health",
      "launch_bindings":{"version":1,"prefix_len":2,"bindings":[{"name":"model","argument":{"kind":"flag","flag":"--model"}},{"name":"port","argument":{"kind":"flag","flag":"--port"}}]},
      "launch":{"program":python,"args":["-I",tool_text,"--model","{model}","--port","{port}"],"env":{},"working_directory":home},
      "probe":{"program":probe,"args":["--adapter-probe",ENGINE,runtime,"{model}","{options_json}"],"env":{}},
      "artifacts":[tool]});
    if layout {
        manifest["command_layout"] =
            json!({"version":1,"subcommands":[],"options":[{"index":0,"values":0}]});
    }
    let source = home.join(format!("{runtime}.json"));
    fs::write(&source, serde_json::to_vec(&manifest).unwrap()).unwrap();
    providers::registry::register(&source, None).await.unwrap();
    cfg.active_runtime = runtime.into();
    let root = providers::registry::root();
    let request = runtime_schema::help_target(&root, cfg).unwrap().request;
    let command = runtime_schema::help_command(cfg, &request).unwrap();
    let (_, descriptor) = runtime_help_store::discover_persist_describe(
        &HelpService::default(),
        &root,
        runtime,
        ENGINE,
        runtime,
        &command,
        &[],
    )
    .unwrap();
    runtime_schema::accept(&root, cfg, &descriptor.fingerprint, &request).unwrap();
    let options: BTreeMap<String, ConfirmedSyntax> = serde_json::from_value(json!({
        "input": {"positional": {"role": "user"}},
        "output": {"positional": {"role": "user"}}}))
    .unwrap();
    let effective =
        runtime_schema::save_supplement(&root, cfg, &descriptor.fingerprint, options).unwrap();
    let entry = effective.entry.clone().unwrap();
    let pasted = format!(
        r#""{python}" -I "{tool_text}" --model "{}" --port 1 in.txt out.txt --count 3"#,
        cfg.active_model
    );
    let imported = runtime_ordered::import_plan_for_entry(
        &effective.schema,
        &effective.scope,
        Some(&entry),
        &pasted,
        CommandSyntax::Windows,
    )
    .unwrap();
    assert!(imported.unrecognized.is_empty(), "{runtime}: {imported:?}");
    let values = serde_json::to_value(runtime_ordered::overrides_from_plan(&imported.plan))
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
    cfg.provider_options.insert(ENGINE.into(), values.clone());
    aiolm_lib::config::save(cfg).unwrap();
    *cfg = aiolm_lib::config::load_result().unwrap();
    assert_eq!(cfg.provider_options[ENGINE], values);
    providers::adapter::refresh(cfg, None).await.unwrap();
    let launch = providers::registry::command(cfg, cfg.port, "").unwrap();
    let port = cfg.port.to_string();
    let expected: Vec<String> = [
        "-I",
        tool_text.as_str(),
        "--model",
        cfg.active_model.as_str(),
        "--port",
        port.as_str(),
        "--count",
        "3",
        "in.txt",
        "out.txt",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(launch.args, expected, "{runtime}");
    let mut actual = Command::new(&launch.program);
    actual
        .args(&launch.args)
        .env_clear()
        .current_dir(launch.working_directory.clone().unwrap());
    if let Some(root) = std::env::var_os("SYSTEMROOT") {
        actual.env("SYSTEMROOT", root);
    }
    let output = actual.output().unwrap();
    assert!(
        output.status.success(),
        "{runtime}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed["parsed"]["input"], "in.txt", "{runtime}");
    assert_eq!(observed["parsed"]["output"], "out.txt", "{runtime}");
    assert_eq!(observed["parsed"]["count"], 3, "{runtime}");
    assert_eq!(observed["parsed"]["model"], json!(cfg.active_model));
}
