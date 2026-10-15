//! Actual synthetic help, persisted settings and subprocess parser acceptance.
//! Does not certify inference, a Python interpreter or a native engine.
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
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf, process::Command};
struct Home {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("aiolm context {}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
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

#[tokio::test]
async fn declared_global_and_nested_scope_options_reach_the_actual_parser_in_order() {
    let home = Home::new();
    let program = env!("CARGO_BIN_EXE_fake-llama-server");
    let model = home.path.join("synthetic model.bin");
    fs::write(&model, b"synthetic").unwrap();
    let script = home.path.join("literal script 눈길.py");
    fs::write(&script, b"synthetic entry token").unwrap();
    let prefix = vec![
        "--adapter-command-contract-fixture".to_owned(),
        script.to_string_lossy().into_owned(),
        "--label".into(),
        "serve".into(),
        "serve".into(),
        "api".into(),
    ];
    let mut args = prefix.clone();
    args.extend(["--model", "{model}", "--port", "{port}"].map(String::from));
    let manifest = json!({"schema_version":1,"adapter_version":1,"engine_id":"custom.commandfixture","runtime_id":"r1","display_name":"Synthetic command contract","platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],"protocol":"openai-v1","model_formats":["unknown"],"health_path":"/health",
      "command_layout":{"version":1,"subcommands":[4,5],"options":[{"index":0,"values":0},{"index":2,"values":1}]},
      "launch_bindings":{"version":1,"prefix_len":6,"bindings":[{"name":"model","argument":{"kind":"flag","flag":"--model"}},{"name":"port","argument":{"kind":"flag","flag":"--port"}}]},
      "launch":{"program":program,"args":args,"env":{},"working_directory":home.path},
      "probe":{"program":program,"args":["--adapter-probe","custom.commandfixture","r1","{model}","{options_json}"],"env":{}},
      "artifacts":[script],
      "options":[{"key":"global_name","flag":"--global-name","kind":{"type":"text","max_len":128},"target":"launch","scope":[]},{"key":"worker_mode","flag":"--worker-mode","kind":{"type":"text","max_len":128},"target":"launch","scope":["serve"]}],
      "option_metadata":{"version":1,"engine_id":"custom.commandfixture","adapter":{"id":"synthetic.command","revision":"r1"},"options":[{"flag":"--fresh-pair","repeatable":true}]}});
    let source = home.path.join("manifest.json");
    fs::write(&source, serde_json::to_vec(&manifest).unwrap()).unwrap();
    providers::registry::register(&source, None).await.unwrap();
    let mut cfg = AppConfig {
        active_provider: "custom.commandfixture".into(),
        active_runtime: "r1".into(),
        active_model: model.to_string_lossy().into_owned(),
        ..Default::default()
    };
    cfg.normalize();
    let root = providers::registry::root();
    let mut request = runtime_schema::help_target(&root, &cfg).unwrap().request;
    assert_eq!(request.scope, vec!["serve", "api"]);
    request
        .args
        .insert(request.args.len() - 1, "--adapter-help-fixture".into());
    let command = runtime_schema::help_command(&cfg, &request).unwrap();
    let (_, descriptor) = runtime_help_store::discover_persist_describe(
        &HelpService::default(),
        &root,
        "command",
        cfg.active_provider.as_str(),
        "r1",
        &command,
        &[],
    )
    .unwrap();
    runtime_schema::accept(&root, &cfg, &descriptor.fingerprint, &request).unwrap();
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert!(effective
        .schema
        .options
        .iter()
        .find(|o| o.key == "global_name")
        .unwrap()
        .scope
        .is_empty());
    let imported=runtime_ordered::import_plan_text(&effective.schema,&effective.scope,"--global-name serve serve --worker-mode api api --fresh-pair first second --fresh-count 7 --fresh-pair third fourth").unwrap();
    assert!(
        imported.unrecognized.is_empty(),
        "{:?}",
        imported.unrecognized
    );
    assert!(imported.managed.is_empty());
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
    cfg.provider_options
        .insert(cfg.active_provider.clone(), values.clone());
    aiolm_lib::config::save(&cfg).unwrap();
    cfg = aiolm_lib::config::load_result().unwrap();
    assert_eq!(cfg.provider_options[&cfg.active_provider], values);
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let mut invalid = cfg.clone();
    invalid
        .provider_options
        .get_mut(&cfg.active_provider)
        .unwrap()["global_name"] =
        json!({"spelling":"--global-name","occurrences":[["x".repeat(129)]]});
    let registered = providers::registry::manifest(
        providers::ProviderId::parse(&cfg.active_provider).unwrap(),
        "r1",
    )
    .unwrap();
    assert!(
        providers::registry::saved_option_issues(
            &invalid,
            &registered,
            &invalid.provider_options[&cfg.active_provider]
        )
        .iter()
        .any(|issue| issue.key == "global_name" && issue.message.contains("length")),
        "existing manifest max_len must still protect every occurrence"
    );
    let launch = providers::registry::command(&cfg, cfg.port, "").unwrap();
    let mut actual = Command::new(&launch.program);
    actual
        .args(&launch.args)
        .env_clear()
        .envs(launch.env.iter().map(|(key, value)| (key, value)))
        .current_dir(launch.working_directory.unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        actual.creation_flags(0x08000000);
    }
    let output = actual.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed["argv"], json!(launch.args));
    assert_eq!(observed["parsed"]["label"], "serve");
    assert_eq!(observed["parsed"]["global"], "serve");
    assert_eq!(observed["parsed"]["worker"], "api");
    assert_eq!(
        observed["parsed"]["pairs"],
        json!([["first", "second"], ["third", "fourth"]])
    );
    assert_eq!(observed["parsed"]["count"], 7);
    assert_eq!(observed["parsed"]["model"], json!(model));
    let expected = vec![
        prefix[0].clone(),
        prefix[1].clone(),
        "--label".into(),
        "serve".into(),
        "--global-name".into(),
        "serve".into(),
        "serve".into(),
        "--worker-mode".into(),
        "api".into(),
        "api".into(),
        "--model".into(),
        cfg.active_model.clone(),
        "--port".into(),
        cfg.port.to_string(),
        "--fresh-pair".into(),
        "first".into(),
        "second".into(),
        "--fresh-count".into(),
        "7".into(),
        "--fresh-pair".into(),
        "third".into(),
        "fourth".into(),
    ];
    assert_eq!(launch.args, expected);
    let mut changed = registered.clone();
    changed
        .options
        .iter_mut()
        .find(|option| option.key == "global_name")
        .unwrap()
        .scope = Some(vec!["serve".into()]);
    let before = runtime_schema::manifest_help_command(&registered, &request)
        .unwrap()
        .identity(&Default::default())
        .unwrap();
    let after = runtime_schema::manifest_help_command(&changed, &request)
        .unwrap()
        .identity(&Default::default())
        .unwrap();
    assert_ne!(before.fingerprint,after.fingerprint,"changing explicit option scope must invalidate reviewed help even when prefix bytes stay the same");

    // The help's TARGET positional: unmapped until its role is confirmed;
    // a saved value is retained and refused with that reason.
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    let target = effective
        .schema
        .options
        .iter()
        .find(|o| o.key == "target")
        .unwrap();
    assert_eq!(target.managed, Some(ManagedBinding::Discovery));
    let entry = effective.entry.clone().unwrap();
    assert_eq!(entry.positional_bindings, Some(vec![]));
    let mut unmapped = cfg.clone();
    unmapped
        .provider_options
        .get_mut(&cfg.active_provider)
        .unwrap()
        .insert("target".into(), json!("entry-one"));
    assert!(providers::registry::saved_option_issues(
        &unmapped,
        &registered,
        &unmapped.provider_options[&cfg.active_provider]
    )
    .iter()
    .any(|issue| issue.key == "target" && issue.message.contains("not mapped")));
    let roles = |role: Value| -> BTreeMap<String, ConfirmedSyntax> {
        serde_json::from_value(json!({ "target": { "positional": role } })).unwrap()
    };
    // `--model` is a flag binding; it fills no positional slot.
    assert!(runtime_schema::save_supplement(
        &root,
        &cfg,
        &descriptor.fingerprint,
        roles(json!({"role": "binding", "name": "model"}))
    )
    .unwrap_err()
    .contains("not a positional binding"));
    let identity =
        |cfg: &AppConfig| runtime_schema::launch_identity(&root, cfg, &effective.compat_keys);
    let unmapped_identity = identity(&cfg);
    runtime_schema::save_supplement(
        &root,
        &cfg,
        &descriptor.fingerprint,
        roles(json!({"role": "user"})),
    )
    .unwrap();
    assert_ne!(
        identity(&cfg),
        unmapped_identity,
        "a positional role is part of what launches"
    );
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(
        effective
            .schema
            .options
            .iter()
            .find(|o| o.key == "target")
            .unwrap()
            .managed,
        None
    );

    // A full pasted command for this registered entry imports cleanly: the
    // program and literal entry tokens are skipped exactly, app bindings go
    // to review and the bare word fills the mapped user slot.
    let quote = |text: &str| format!("'{text}'");
    let pasted = format!(
        "{} {} {} --label serve --global-name serve serve --worker-mode api api --model {} --port 1 --fresh-count 9 entry-two",
        quote(program),
        quote(&prefix[0]),
        quote(&prefix[1]),
        quote(&cfg.active_model)
    );
    let imported = runtime_ordered::import_plan_for_entry(
        &effective.schema,
        &effective.scope,
        Some(&entry),
        &pasted,
        CommandSyntax::Posix,
    )
    .unwrap();
    assert!(
        imported.unrecognized.is_empty(),
        "{:?}",
        imported.unrecognized
    );
    assert_eq!(
        imported.managed,
        vec![
            "--model".to_string(),
            cfg.active_model.clone(),
            "--port".into(),
            "1".into()
        ]
    );
    let values = serde_json::to_value(runtime_ordered::overrides_from_plan(&imported.plan))
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
    assert_eq!(values["target"]["occurrences"], json!([["entry-two"]]));
    cfg.provider_options
        .insert(cfg.active_provider.clone(), values.clone());
    aiolm_lib::config::save(&cfg).unwrap();
    cfg = aiolm_lib::config::load_result().unwrap();
    assert_eq!(cfg.provider_options[&cfg.active_provider], values);
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let launch = providers::registry::command(&cfg, cfg.port, "").unwrap();
    assert_eq!(launch.args.last().map(String::as_str), Some("entry-two"));
    let mut actual = Command::new(&launch.program);
    actual
        .args(&launch.args)
        .env_clear()
        .envs(launch.env.iter().map(|(key, value)| (key, value)))
        .current_dir(launch.working_directory.clone().unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        actual.creation_flags(0x08000000);
    }
    let output = actual.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed["argv"], json!(launch.args));
    assert_eq!(observed["parsed"]["target"], "entry-two");
    assert_eq!(observed["parsed"]["global"], "serve");
    assert_eq!(observed["parsed"]["count"], 9);

    // Without its confirmed role the saved value is kept, not launched.
    runtime_schema::clear_supplement(&root, &cfg).unwrap();
    assert!(providers::registry::command(&cfg, cfg.port, "").is_err());
    assert_eq!(
        aiolm_lib::config::load_result().unwrap().provider_options[&cfg.active_provider]["target"]
            ["occurrences"],
        json!([["entry-two"]])
    );
}
