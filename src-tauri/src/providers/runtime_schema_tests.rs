use super::*;
use super::{
    effective::apply_supplement,
    launch::{resolve_launch_plan, strip_scope, with_template_slots},
    persistence::{accepted_path, supplement_path, SUPPLEMENT_FILE, SUPPLEMENT_LIMIT},
    redaction::sensitive_entry_tokens,
};
use serde_json::json;

#[tokio::test]
async fn entrypoint_help_resume_preserves_the_checked_registration_without_running_a_probe() {
    use registry::{
        ArgBinding, AuthBinding, DraftHelp, EntrypointDraft, ProcessSpec, ServingProtocol,
    };
    use std::fs;
    const CHILD: &str = "AIOLM_ENTRYPOINT_HELP_RESUME_FIXTURE";
    const FILTER: &str = "providers::runtime_schema::tests::entrypoint_help_resume_preserves_the_checked_registration_without_running_a_probe";
    if std::env::var_os(CHILD).is_none() {
        let previous = std::env::var_os("AIOLM_HOME");
        let home = owned_fixture_home();
        fs::write(
            home.join(".help-resume-fixture-owner"),
            b"synthetic help resume fixture",
        )
        .unwrap();
        let mut command = crate::procutil::std_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", FILTER, "--nocapture"])
            .env(CHILD, &home)
            .env("AIOLM_HOME", &home);
        let output = crate::procutil::capture_output_cancellable(
            &mut command,
            std::time::Duration::from_secs(30),
            256 * 1024,
            None,
        )
        .unwrap();
        assert_eq!(std::env::var_os("AIOLM_HOME"), previous);
        assert!(
            output.status.success(),
            "isolated help resume failed; retained home: {}\nstdout:{}\nstderr:{}",
            home.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"));
        remove_owned_fixture_home(&home);
        return;
    }
    let home = PathBuf::from(std::env::var_os("AIOLM_HOME").unwrap());
    assert_eq!(PathBuf::from(std::env::var_os(CHILD).unwrap()), home);
    let canonical = fs::canonicalize(&home).unwrap();
    let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
    assert_eq!(canonical, home);
    assert_eq!(canonical.parent(), Some(temporary.as_path()));
    assert_eq!(
        fs::read(home.join(".help-resume-fixture-owner")).unwrap(),
        b"synthetic help resume fixture"
    );
    let launch = home.join("synthetic-launch.bin");
    let probe_program = home.join("synthetic-probe.bin");
    let artifact = home.join("synthetic-artifact.data");
    let marker = home.join("probe-marker.txt");
    // These are deliberately not executable. A successful repair cannot
    // have re-run a probe; the marker also detects accidental rewrites.
    for path in [&launch, &probe_program, &artifact] {
        fs::write(path, b"synthetic engine bytes").unwrap();
    }
    fs::write(&marker, b"preserve later probe sentinel").unwrap();
    let engine = ProviderId::parse("custom.helpresume").unwrap();
    let request = HelpRequest {
        encoding: None,
        locale: None,
        working_directory: None,
        program: None,
        args: vec!["--help".into()],
        scope: vec![],
    };
    let mut draft = EntrypointDraft {
        command_layout: None,
        options_separator: None,
        launch_resources: None,
        models: vec![],
        engine_id: engine,
        runtime_id: "pending-help".into(),
        display_name: "Synthetic help recovery".into(),
        program: launch.to_string_lossy().into_owned(),
        prefix: vec![],
        working_directory: Some(home.to_string_lossy().into_owned()),
        artifacts: vec![artifact.to_string_lossy().into_owned()],
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
            program: probe_program.to_string_lossy().into_owned(),
            args: vec!["{model}".into()],
            env: BTreeMap::from([(
                "FAKE_PROBE_MARKER".into(),
                marker.to_string_lossy().into_owned(),
            )]),
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: None,
        option_metadata: None,
    };
    let manifest = registry::manifest_from_draft(&draft).unwrap();
    let identity = manifest_help_command(&manifest, &request)
        .unwrap()
        .identity(&AtomicBool::new(false))
        .unwrap();
    let mut report = complete_help_report(&identity.fingerprint);
    report.identity = identity.clone();
    report.stdout.text =
        "Options:\n  --model MODEL  model path\n  --port PORT  listen port\n".into();
    report.stdout.clean_text = report.stdout.text.clone();
    let schema = super::super::runtime_help_parse::parse_help_report(
        &report,
        super::super::runtime_options::SchemaBinding {
            engine: engine.as_str().into(),
            runtime: draft.runtime_id.clone(),
            fingerprint: identity.fingerprint.clone(),
        },
    )
    .unwrap();
    let root = registry::root();
    let snapshot = HelpSnapshot { report, schema };
    let snapshot_path =
        runtime_help_store::save_snapshot(&root, engine.as_str(), &draft.runtime_id, &snapshot)
            .unwrap();
    draft.help = Some(DraftHelp {
        fingerprint: identity.fingerprint.clone(),
        request: request.clone(),
    });
    let digest = |path: &Path| format!("{:x}", Sha256::digest(fs::read(path).unwrap()));
    let mut record = json!({"manifest":manifest,"executable_sha256":digest(&launch),"probe_sha256":digest(&probe_program),
        "artifacts_sha256":BTreeMap::from([(artifact.to_string_lossy().into_owned(),digest(&artifact))]),
        "probe":{"schema_version":1,"engine_id":engine,"runtime_id":draft.runtime_id,"version":"synthetic-1","accelerator":"cpu",
            "model":"","model_supported":true,"served_model":"synthetic","capabilities":{"tasks":["generate"],
            "modalities":{"text":true,"image":false,"audio":false,"video":false},"chat":true,"tools":false}}});
    let directory = root.join(engine.as_str()).join(&draft.runtime_id);
    let registered = directory.join("registration.json");
    let accepted = directory.join("help").join("accepted.json");
    fs::write(&registered, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    let reject = |draft: &EntrypointDraft, needle: &str| {
        let current = fs::read(&registered).unwrap();
        let pin = fs::read(&accepted).ok();
        let error = resume_entrypoint_help(&root, draft).unwrap_err();
        assert!(error.message.contains(needle), "{error}");
        assert_eq!(fs::read(&registered).unwrap(), current);
        assert_eq!(fs::read(&accepted).ok(), pin);
        assert_eq!(fs::read(&marker).unwrap(), b"preserve later probe sentinel");
    };
    fs::create_dir(&accepted).unwrap();
    reject(&draft, "");
    reject(&draft, "");
    fs::remove_dir(&accepted).unwrap();
    let initial_bytes = fs::read(&registered).unwrap();
    assert_eq!(resume_entrypoint_help(&root, &draft).unwrap(), manifest);
    assert_eq!(fs::read(&registered).unwrap(), initial_bytes);
    assert_eq!(
        load_accepted(&root, engine.as_str(), &draft.runtime_id)
            .unwrap()
            .unwrap()
            .fingerprint,
        identity.fingerprint
    );
    assert_eq!(fs::read(&marker).unwrap(), b"preserve later probe sentinel");

    let mut changed = draft.clone();
    changed.health_path = "/different-health".into();
    let different = registry::manifest_from_draft(&changed).unwrap();
    assert_eq!(
        manifest_help_command(&different, &request)
            .unwrap()
            .identity(&AtomicBool::new(false))
            .unwrap()
            .fingerprint,
        identity.fingerprint
    );
    reject(&changed, "registered runtime changed");
    let mut without_help = draft.clone();
    without_help.help = None;
    reject(&without_help, "no reviewed help");
    for path in [&launch, &probe_program, &artifact] {
        let bytes = fs::read(path).unwrap();
        fs::write(path, b"changed engine bytes").unwrap();
        reject(&draft, "changed");
        fs::remove_file(path).unwrap();
        reject(&draft, "unreadable");
        fs::write(path, bytes).unwrap();
    }
    let snapshot_bytes = fs::read(&snapshot_path).unwrap();
    fs::remove_file(&snapshot_path).unwrap();
    reject(&draft, "missing");
    fs::write(&snapshot_path, b"not a snapshot").unwrap();
    reject(&draft, "");
    fs::write(&snapshot_path, &snapshot_bytes).unwrap();
    let baseline_record = record.clone();
    for bad in [
        Value::Null,
        json!({"schema_version":2}),
        json!({"runtime_id":"another-runtime"}),
        json!({"version":""}),
        json!({"accelerator":"x".repeat(129)}),
        json!({"capabilities":{"tasks":["invented-task"],"modalities":{"text":true,"image":false,"audio":false,"video":false},"chat":true,"tools":false}}),
    ] {
        record = baseline_record.clone();
        if bad.is_null() {
            record["probe"] = Value::Null;
        } else {
            for (key, value) in bad.as_object().unwrap() {
                record["probe"][key] = value.clone();
            }
        }
        fs::write(&registered, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
        reject(&draft, "");
    }
    record = baseline_record.clone();
    record["artifacts_sha256"] = json!({});
    fs::write(&registered, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    reject(&draft, "artifact hashes");
    // The complete manifest matches, but help must still document its bindings.
    let mut bad_binding = draft.clone();
    bad_binding.model = ArgBinding::Flag {
        flag: "--typo".into(),
        equals: false,
    };
    record = baseline_record.clone();
    record["manifest"] =
        serde_json::to_value(registry::manifest_from_draft(&bad_binding).unwrap()).unwrap();
    fs::write(&registered, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    reject(&bad_binding, "--typo");
    record = baseline_record.clone();
    // A legitimate later selected-model result need not claim model support
    // or Ready to allow saving the reviewed options of this same build.
    record["probe"]["model"] = json!(home.join("selected-model").to_string_lossy());
    record["probe"]["model_supported"] = json!(false);
    record["probe"]["capabilities"]["tasks"] = json!([]);
    record["probe"]["version"] = json!("synthetic-later-model-probe");
    fs::write(&registered, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    let current_bytes = fs::read(&registered).unwrap();
    assert_eq!(resume_entrypoint_help(&root, &draft).unwrap(), manifest);
    assert_eq!(fs::read(&registered).unwrap(), current_bytes);
    assert_eq!(fs::read(&marker).unwrap(), b"preserve later probe sentinel");
    assert!(
        matches!(register_entrypoint_outcome(&root,&draft,None).await,Err(error) if error.message.contains("already registered"))
    );
    assert!(register_entrypoint(&root, &draft, None)
        .await
        .unwrap_err()
        .message
        .contains("already registered"));
    fs::remove_file(&registered).unwrap();
    assert!(resume_entrypoint_help(&root, &draft)
        .unwrap_err()
        .message
        .contains("cannot read runtime registration"));
    assert!(!registered.exists());
}

#[test]
fn selected_vllm_schema_enforces_sampling_boundaries_before_request_forwarding() {
    let root = owned_fixture_home();
    let runtime = super::super::python_env::PythonRuntimeManifest {
        format: 1,
        provider: ProviderId::Vllm,
        id: "synthetic-bounds".into(),
        kind: super::super::python_env::InstallationKind::External,
        python: "/synthetic/python".into(),
        requested_version: None,
        probe: None,
    };
    let selected = Selected::python(&runtime).unwrap();
    let cfg = AppConfig::default();
    let values = json!({"temperature": 2.0, "top_p": 0.000001, "repetition_penalty": 0.000001,
        "top_k": -1, "min_p": 1, "max_tokens": 1})
    .as_object()
    .unwrap()
    .clone();
    let effective = effective_for(&root, &cfg, &selected, false).unwrap();
    let resolved =
        runtime_ordered::resolve_saved(&effective.schema, &effective.scope, &values).unwrap();
    assert_eq!(resolved.request, values);
    assert!(resolved.argv.is_empty());
    for (key, value) in [
        ("top_p", json!(0)),
        ("repetition_penalty", json!(0)),
        ("temperature", json!(2.01)),
    ] {
        let mut invalid = values.clone();
        invalid.insert(key.into(), value);
        let before = invalid.clone();
        let issues = saved_issues_for(
            &root,
            &cfg,
            Ok(Selected::python(&runtime).unwrap()),
            &invalid,
            &BTreeSet::new(),
        );
        assert!(issues.iter().any(|issue| issue.key == key));
        assert!(
            runtime_ordered::resolve_saved(&effective.schema, &effective.scope, &invalid).is_err()
        );
        assert_eq!(invalid, before);
    }
    for rank in [1, 8, 16, 32, 64, 128, 256, 320, 512] {
        let values = json!({"max_lora_rank": rank}).as_object().unwrap().clone();
        assert!(options::validate(ProviderId::Vllm, &values).is_empty());
        let (resolved, _) = resolve_launch_plan(&root, &cfg, &selected, values, None, &[]).unwrap();
        assert_eq!(
            resolved.argv,
            ["--max-lora-rank".to_string(), rank.to_string()]
        );
    }
    for rank in [2, 4096] {
        let values = json!({"max_lora_rank": rank}).as_object().unwrap().clone();
        assert_eq!(
            options::validate(ProviderId::Vllm, &values)[0].code,
            "choice"
        );
        assert!(resolve_launch_plan(&root, &cfg, &selected, values, None, &[]).is_err());
    }
    for length in [-1, 1, 4096] {
        let values = json!({"max_model_len": length})
            .as_object()
            .unwrap()
            .clone();
        let (resolved, _) = resolve_launch_plan(&root, &cfg, &selected, values, None, &[]).unwrap();
        assert_eq!(
            resolved.argv,
            ["--max-model-len".to_string(), length.to_string()]
        );
    }
    let invalid = json!({"max_model_len": 0}).as_object().unwrap().clone();
    assert!(resolve_launch_plan(&root, &cfg, &selected, invalid, None, &[]).is_err());
    remove_owned_fixture_home(&root);
}

#[test]
fn help_review_does_not_report_valid_catalog_or_dedicated_settings_as_removed() {
    let runtime = super::super::python_env::PythonRuntimeManifest {
        format: 1,
        provider: ProviderId::Vllm,
        id: "synthetic-review".into(),
        kind: super::super::python_env::InstallationKind::External,
        python: "/synthetic/python".into(),
        requested_version: None,
        probe: None,
    };
    let selected = Selected::python(&runtime).unwrap();
    let reserved = json!({
        "@option_order": {"version": 1, "occurrences": []},
        "draft_model": "/synthetic/draft",
        "extra_args": ["--synthetic"],
        "lora_adapters": [{"name": "selected", "path": "/synthetic/adapter"}],
        "request_lora": "selected",
        "trust_remote_code": false
    });
    let mut mixed = reserved.as_object().unwrap().clone();
    mixed.insert(
        "alpha".into(),
        json!({"nested": ["값", false, null, 18446744073709551615_u64]}),
    );
    mixed.insert("removed".into(), json!("retained"));
    mixed.insert("temperature".into(), json!(0.7));
    mixed.insert("한글".into(), json!({"unchanged": [0, ""]}));
    for (label, values, expected_discovery, expected_entrypoint) in [
        ("absent", None, vec![], vec![]),
        ("empty", Some(Map::new()), vec![], vec![]),
        (
            "all reserved",
            Some(reserved.as_object().unwrap().clone()),
            vec![],
            vec![],
        ),
        (
            "mixed",
            Some(mixed),
            vec!["alpha", "removed", "한글"],
            vec!["alpha", "removed", "temperature", "한글"],
        ),
    ] {
        let mut provider_options = BTreeMap::from([(
            "mlx-vlm".into(),
            json!({"other_provider_only": {"nested": ["foreign"]}})
                .as_object()
                .unwrap()
                .clone(),
        )]);
        if let Some(values) = values {
            provider_options.insert("vllm".into(), values);
        }
        let cfg = AppConfig {
            active_provider: "mlx-vlm".into(),
            provider_options,
            ..Default::default()
        };
        assert_ne!(cfg.active_provider, selected.key.provider.as_str());
        let before = serde_json::to_vec(&cfg).unwrap();
        assert_eq!(
            discovery_saved_keys(&cfg, &selected).unwrap(),
            expected_discovery,
            "{label}",
        );
        assert_eq!(
            entrypoint_saved_keys(&cfg, ProviderId::Vllm),
            expected_entrypoint,
            "{label}",
        );
        assert_eq!(serde_json::to_vec(&cfg).unwrap(), before, "{label}");
    }
}

#[test]
fn a_shadowed_help_alias_cannot_override_the_selected_model() {
    let source = adapter_source("custom.example", "manifest-v1");
    let option = from_external(
        &serde_json::from_value(json!({
            "key":"checkpoint", "flag":"--checkpoint", "target":"launch",
            "kind":{"type":"path"}
        }))
        .unwrap(),
        &source,
    )
    .unwrap();
    let mut help = option.clone();
    help.key = "weights".into();
    help.spellings.push(Spelling {
        flag: "--weights".into(),
        style: ValueStyle::Separate,
        polarity: None,
    });
    let mut compat = Compat {
        explicit_scopes: BTreeMap::new(),
        options: vec![option],
        managed_flags: BTreeMap::from([("--weights".into(), ManagedBinding::Model)]),
        metadata: None,
        entry: None,
    };
    protect_binding_aliases(&mut compat, &[help]);
    let mut schema = help_schema();
    schema.options = compat.options;
    let saved: super::super::runtime_options::Overrides = serde_json::from_value(json!({
        "checkpoint":{"occurrences":[["/synthetic/other.model"]]}
    }))
    .unwrap();
    let original = saved.clone();
    let issues = schema.resolve(&[], &saved).unwrap_err();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].key, "checkpoint");
    assert!(issues[0].message.contains("managed by the app"));
    assert_eq!(
        saved, original,
        "invalid stored values stay available for review"
    );
    assert!(schema.resolve(&[], &Default::default()).is_ok());
}

#[test]
fn accepted_shadowed_aliases_refuse_raw_overrides_and_preserve_literal_arguments() {
    const CHILD: &str = "AIOLM_PROTECTED_ALIAS_FIXTURE";
    const FILTER: &str = "providers::runtime_schema::tests::accepted_shadowed_aliases_refuse_raw_overrides_and_preserve_literal_arguments";
    if std::env::var_os(CHILD).is_none() {
        let previous = std::env::var_os("AIOLM_HOME");
        let home = owned_fixture_home();
        let output = crate::procutil::std_command(std::env::current_exe().unwrap())
            .args(["--exact", FILTER, "--nocapture"])
            .env(CHILD, &home)
            .env("AIOLM_HOME", &home)
            .output()
            .unwrap();
        assert_eq!(std::env::var_os("AIOLM_HOME"), previous);
        assert!(
            output.status.success(),
            "isolated alias fixture failed; retained home: {}\nstdout:{}\nstderr:{}",
            home.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"));
        remove_owned_fixture_home(&home);
        return;
    }
    let home = PathBuf::from(std::env::var_os(CHILD).unwrap());
    assert_eq!(std::env::var_os("AIOLM_HOME").unwrap(), home.as_os_str());
    let root = registry::root();
    let (engine, runtime, secret) = synthetic_engine_ids();
    let mut manifest = manifest_with_static_prefix(&engine, &runtime, &home, &secret);
    manifest.command_layout = Some(super::super::runtime_command::CommandLayout {
        version: 1,
        subcommands: vec![0],
        options: vec![],
    });
    manifest.launch.args = [
        "serve",
        "--weights",
        "{model}",
        "--listen-port",
        "{port}",
        "--listen-host",
        "{host}",
    ]
    .map(str::to_owned)
    .to_vec();
    let bindings = manifest.launch_bindings.as_mut().unwrap();
    bindings.prefix_len = 1;
    bindings.bindings = [
        ("model", "--weights"),
        ("port", "--listen-port"),
        ("host", "--listen-host"),
    ]
    .map(|(name, flag)| registry::BoundArgument {
        name: name.into(),
        argument: registry::ArgBinding::Flag {
            flag: flag.into(),
            equals: false,
        },
    })
    .to_vec();
    manifest.options = serde_json::from_value(json!([
        {"key":"workers", "flag":"--threads", "target":"launch", "kind":{"type":"integer", "min":1, "max":64}},
        {"key":"checkpoint", "flag":"--checkpoint", "target":"launch", "kind":{"type":"path"}},
        {"key":"address", "flag":"--address", "target":"launch", "kind":{"type":"text", "max_len":256}},
        {"key":"endpoint", "flag":"--endpoint", "target":"launch", "kind":{"type":"integer", "min":1, "max":65535}}
    ]))
    .unwrap();
    manifest.probe.args.push("{options_json}".into());
    registry::validate_manifest(&manifest).unwrap();
    for program in [&manifest.launch.program, &manifest.probe.program] {
        std::fs::write(program, b"synthetic engine bytes").unwrap();
    }
    let request = HelpRequest {
        encoding: None,
        locale: None,
        working_directory: None,
        program: None,
        args: vec!["serve".into(), "--help".into()],
        scope: vec!["serve".into()],
    };
    let identity = manifest_help_command(&manifest, &request)
        .unwrap()
        .identity(&AtomicBool::new(false))
        .unwrap();
    let mut report = complete_help_report(&identity.fingerprint);
    report.identity = identity.clone();
    report.scope = request.scope.clone();
    report.stdout.text = "Options:\n  -j, --threads N                         worker count\n  -q, --checkpoint, --weights FILE        model path\n  -a, --address, --listen-host HOST       listen address\n  -p, --endpoint, --listen-port PORT      listen port\n".into();
    report.stdout.clean_text = report.stdout.text.clone();
    let schema = super::super::runtime_help_parse::parse_help_report(
        &report,
        super::super::runtime_options::SchemaBinding {
            engine: engine.clone(),
            runtime: runtime.clone(),
            fingerprint: identity.fingerprint.clone(),
        },
    )
    .unwrap();
    let record = json!({"manifest":manifest, "executable_sha256":"e".repeat(64), "probe_sha256":"f".repeat(64)});
    let registration = root.join(&engine).join(&runtime).join("registration.json");
    std::fs::create_dir_all(registration.parent().unwrap()).unwrap();
    std::fs::write(&registration, serde_json::to_vec(&record).unwrap()).unwrap();
    runtime_help_store::save_snapshot(&root, &engine, &runtime, &HelpSnapshot { report, schema })
        .unwrap();
    write_accepted(
        &root,
        &engine,
        &runtime,
        &AcceptedHelp {
            version: ACCEPTED_VERSION,
            working_directory: None,
            fingerprint: identity.fingerprint,
            request,
        },
    )
    .unwrap();
    let mut cfg = AppConfig {
        active_provider: engine.clone(),
        active_runtime: runtime,
        ..Default::default()
    };
    let template = [
        "serve",
        "--weights",
        "/synthetic/model.bin",
        "--listen-port",
        "8080",
        "--listen-host",
        "127.0.0.1",
    ]
    .map(str::to_owned);
    // Shadowed aliases remain validation evidence, not new syntax for a
    // manifest value whose declaration still controls serialization.
    cfg.provider_options.insert(
        engine.clone(),
        json!({"workers":{"spelling":"-j", "occurrences":[[4]]}})
            .as_object()
            .unwrap()
            .clone(),
    );
    assert!(assemble_registered_arguments(&root, &cfg, &manifest, &template).is_err());
    for raw in [
        json!(["-j", "16"]),
        json!(["-j16"]),
        json!(["--threads=16"]),
        json!(["-q", "other.bin"]),
        json!(["-qother.bin"]),
        json!(["-q=other.bin"]),
        json!(["--checkpoint=other.bin"]),
        json!(["-a0.0.0.0"]),
        json!(["--address=0.0.0.0"]),
        json!(["-p9000"]),
        json!(["--endpoint=9000"]),
    ] {
        let values = json!({"workers":4, "extra_args":raw})
            .as_object()
            .unwrap()
            .clone();
        cfg.provider_options.insert(engine.clone(), values.clone());
        assert!(additional_launch_args(&root, &cfg).is_err(), "{raw}");
        let issues = saved_issues_for(
            &root,
            &cfg,
            Selected::from_config(&cfg),
            &values,
            &BTreeSet::new(),
        );
        assert!(
            issues.iter().any(|issue| issue.key == "extra_args"),
            "{raw}: {issues:?}"
        );
        assert_eq!(cfg.provider_options[&engine], values);
    }
    for (key, value) in [
        ("checkpoint", json!("other.bin")),
        ("address", json!("0.0.0.0")),
        ("endpoint", json!(9000)),
    ] {
        let values = Map::from_iter([(key.into(), value)]);
        cfg.provider_options.insert(engine.clone(), values.clone());
        assert!(assemble_registered_arguments(&root, &cfg, &manifest, &template).is_err());
        assert!(saved_issues_for(
            &root,
            &cfg,
            Selected::from_config(&cfg),
            &values,
            &BTreeSet::new(),
        )
        .iter()
        .any(|issue| issue.key == key));
    }
    let values = json!({"workers":4, "extra_args":["--experimental-cache", "path with spaces/{model}", "--offset=-4"]})
        .as_object()
        .unwrap()
        .clone();
    cfg.provider_options.insert(engine.clone(), values.clone());
    assert!(saved_issues_for(
        &root,
        &cfg,
        Selected::from_config(&cfg),
        &values,
        &BTreeSet::new(),
    )
    .is_empty());
    let mut argv = assemble_registered_arguments(&root, &cfg, &manifest, &template).unwrap();
    argv.extend(additional_launch_args(&root, &cfg).unwrap());
    assert_eq!(
        argv,
        [
            "serve",
            "--weights",
            "/synthetic/model.bin",
            "--listen-port",
            "8080",
            "--listen-host",
            "127.0.0.1",
            "--threads",
            "4",
            "--experimental-cache",
            "path with spaces/{model}",
            "--offset=-4",
        ]
    );
}

#[test]
fn accepted_native_model_source_options_cannot_replace_app_bindings() {
    let temporary = std::env::temp_dir().canonicalize().unwrap();
    let root = temporary.join(format!("aiolm-model-source-help-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let presets = [
        "--embd-gemma-default",
        "--fim-qwen-1.5b-default",
        "--fim-qwen-3b-default",
        "--fim-qwen-7b-default",
        "--fim-qwen-7b-spec",
        "--fim-qwen-14b-spec",
        "--fim-qwen-30b-default",
        "--gpt-oss-20b-default",
        "--gpt-oss-120b-default",
        "--vision-gemma-4b-default",
        "--vision-gemma-12b-default",
    ];
    let text = format!("Options:\n  -hf, -hfr, --hf-repo REPO           model source\n  -hff, --hf-file FILE               model file\n  -mu, --model-url URL               model source URL\n  -dr, --docker-repo REPO            model source\n  --spec-draft-hf, -hfd, -hfrd, --hf-repo-draft REPO   draft source\n{}", presets.iter().map(|flag|format!("  {flag}  replaces model and port")).collect::<Vec<_>>().join("\n"));
    let fingerprint = "a".repeat(64);
    let output = |text: &str| json!({"text":text,"clean_text":text,"encoding":"utf-8","decoding_loss":false,"truncated":false,"read_error":null});
    let report: super::super::runtime_help::HelpReport = serde_json::from_value(json!({
        "identity":{"fingerprint":fingerprint,"executable_sha256":"b".repeat(64),"artifacts_sha256":{},"parser_version":super::super::runtime_help::PARSER_VERSION},
        "scope":[],"stdout":output(&text),"stderr":output(""),"exit_code":0,"success":true,"cancelled":false,"timed_out":false,"error":null,"elapsed_ms":1
    })).unwrap();
    let schema = super::super::runtime_help_parse::parse_help_report(
        &report,
        super::super::runtime_options::SchemaBinding {
            engine: "llama.cpp".into(),
            runtime: "cpu-source-test".into(),
            fingerprint: fingerprint.clone(),
        },
    )
    .unwrap();
    runtime_help_store::save_snapshot(
        &root,
        "llama.cpp",
        "cpu-source-test",
        &HelpSnapshot { report, schema },
    )
    .unwrap();
    write_accepted(
        &root,
        "llama.cpp",
        "cpu-source-test",
        &AcceptedHelp {
            version: ACCEPTED_VERSION,
            working_directory: None,
            fingerprint,
            request: HelpRequest {
                encoding: None,
                locale: None,
                working_directory: None,
                program: None,
                args: vec!["--help".into()],
                scope: vec![],
            },
        },
    )
    .unwrap();
    let cfg = AppConfig {
        active_backend: "cpu".into(),
        active_build: "source-test".into(),
        ..Default::default()
    };
    // Test the effective schema composition without pretending that a
    // synthetic help report proves an installed engine's identity.
    let effective = effective(&root, &cfg, false).unwrap();
    for flag in [
        "-hf",
        "-hfr",
        "--hf-repo",
        "-hff",
        "--hf-file",
        "-mu",
        "--model-url",
        "-dr",
        "--docker-repo",
        "--spec-draft-hf",
        "-hfd",
        "-hfrd",
        "--hf-repo-draft",
    ]
    .into_iter()
    .chain(presets)
    {
        let option = effective
            .schema
            .options
            .iter()
            .find(|option| {
                option
                    .spellings
                    .iter()
                    .any(|spelling| spelling.flag == flag)
            })
            .expect(flag);
        let value = if option.kind.supported() == Some(&ValueKind::Boolean) {
            json!(true)
        } else {
            json!("synthetic/other-model")
        };
        let overrides = BTreeMap::from([(
            option.key.clone(),
            super::super::runtime_options::Override {
                spelling: Some(flag.into()),
                occurrences: vec![vec![value]],
            },
        )]);
        let issues = effective.schema.resolve(&[], &overrides).unwrap_err();
        assert!(
            issues.iter().any(
                |issue| issue.key == option.key && issue.message.contains("managed by the app")
            ),
            "{flag}: {issues:?}"
        );
        let raw = AppConfig {
            server_args: vec![flag.into()],
            ..Default::default()
        };
        assert!(
            super::super::adapter::native_arguments(&raw, "", &crate::gpu::ResolvedGpu::default())
                .unwrap_err()
                .contains("app-managed"),
            "raw argv must not bypass {flag}"
        );
    }
    assert_eq!(root.parent(), Some(temporary.as_path()));
    std::fs::remove_dir_all(root).unwrap();
}

/// Accept synthetic llama-server help for an uninstalled test build so the
/// effective schema is composed exactly as the settings UI receives it.
fn accepted_llama_help(text: &str) -> (PathBuf, AppConfig) {
    let temporary = std::env::temp_dir().canonicalize().unwrap();
    let root = temporary.join(format!("aiolm-llama-metadata-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let fingerprint = "c".repeat(64);
    let output = |text: &str| json!({"text":text,"clean_text":text,"encoding":"utf-8","decoding_loss":false,"truncated":false,"read_error":null});
    let report: super::super::runtime_help::HelpReport = serde_json::from_value(json!({
        "identity":{"fingerprint":fingerprint,"executable_sha256":"d".repeat(64),"artifacts_sha256":{},"parser_version":super::super::runtime_help::PARSER_VERSION},
        "scope":[],"stdout":output(text),"stderr":output(""),"exit_code":0,"success":true,"cancelled":false,"timed_out":false,"error":null,"elapsed_ms":1
    })).unwrap();
    let schema = super::super::runtime_help_parse::parse_help_report(
        &report,
        super::super::runtime_options::SchemaBinding {
            engine: "llama.cpp".into(),
            runtime: "cpu-metadata-test".into(),
            fingerprint: fingerprint.clone(),
        },
    )
    .unwrap();
    runtime_help_store::save_snapshot(
        &root,
        "llama.cpp",
        "cpu-metadata-test",
        &HelpSnapshot { report, schema },
    )
    .unwrap();
    write_accepted(
        &root,
        "llama.cpp",
        "cpu-metadata-test",
        &AcceptedHelp {
            version: ACCEPTED_VERSION,
            working_directory: None,
            fingerprint,
            request: HelpRequest {
                encoding: None,
                locale: None,
                working_directory: None,
                program: None,
                args: vec!["--help".into()],
                scope: vec![],
            },
        },
    )
    .unwrap();
    let cfg = AppConfig {
        active_backend: "cpu".into(),
        active_build: "metadata-test".into(),
        ..Default::default()
    };
    (root, cfg)
}

#[test]
fn reviewed_llama_help_marks_only_the_documented_access_token_sensitive() {
    // The pinned llama.cpp source defines `-hft, --hf-token TOKEN` as the
    // Hugging Face access token. Help prose alone never makes it secret,
    // and an unrelated name containing "token" stays unknown.
    let (root, cfg) = accepted_llama_help(
        "Options:\n  -hft, --hf-token TOKEN   Hugging Face access token (default: value from HF_TOKEN environment variable)\n  --fresh-token-count N    synthetic count whose name mentions a token\n  -t, --threads N          number of threads\n",
    );
    let effective = effective(&root, &cfg, false).unwrap();
    let by_flag = |flag: &str| {
        effective
            .schema
            .options
            .iter()
            .find(|option| option.spellings.iter().any(|s| s.flag == flag))
            .unwrap_or_else(|| panic!("{flag}"))
            .clone()
    };
    let token = by_flag("-hft");
    assert_eq!(token.sensitive.supported(), Some(&true));
    assert!(
        matches!(&token.sensitive.source, Some(Source::Adapter { id, .. }) if id == "llama.cpp"),
        "{:?}",
        token.sensitive.source
    );
    assert!(token.managed.is_none(), "the token stays a user setting");
    for flag in ["--fresh-token-count", "--threads"] {
        assert!(by_flag(flag).sensitive.supported().is_none(), "{flag}");
    }
    // Masking needs no saved value to change: the syntax still comes from
    // help and the value reaches argv unchanged.
    let overrides = BTreeMap::from([(
        token.key.clone(),
        super::super::runtime_options::Override {
            spelling: None,
            occurrences: vec![vec![json!("synthetic-access-token")]],
        },
    )]);
    let argv = effective.schema.resolve(&[], &overrides).unwrap().argv;
    assert_eq!(
        argv,
        [token.spellings[0].flag.as_str(), "synthetic-access-token"]
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn help_parsed_by_an_earlier_parser_is_stale_and_its_values_are_kept() {
    let (root, mut cfg) = accepted_llama_help(
        "--no-host   bypass host buffer allowing extra buffers to be used\n--host HOST   IP addresses to listen on\n-hft, --hf-token TOKEN   Hugging Face access token\n",
    );
    // Rewrite the accepted snapshot as the earlier parser recorded it.
    let path = runtime_help_store::snapshot_root(&root, "llama.cpp", "cpu-metadata-test")
        .unwrap()
        .join(format!("{}.json", "c".repeat(64)));
    let mut raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    raw["report"]["identity"]["parser_version"] =
        json!(super::super::runtime_help::PARSER_VERSION - 1);
    std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
    let effective = effective(&root, &cfg, false).unwrap();
    assert_eq!(effective.help_state, HelpState::Stale);
    assert!(effective.help_keys.is_empty());
    let values: Map<String, Value> =
        serde_json::from_value(json!({"host": false, "no_host": true})).unwrap();
    cfg.provider_options
        .insert("llama.cpp".into(), values.clone());
    let issues = saved_issues(&root, &cfg, &values, &BTreeSet::new());
    for key in ["host", "no_host"] {
        assert!(
            issues.iter().any(|issue| issue.key == key),
            "{key}: {issues:?}"
        );
    }
    assert_eq!(cfg.provider_options["llama.cpp"], values);
    // The stale snapshot still says which stored value is secret, so it
    // stays hidden in display copies while help is rediscovered.
    let mut stored = values.clone();
    stored.insert("hf_token".into(), json!("synthetic-hub-credential"));
    cfg.provider_options.insert("llama.cpp".into(), stored);
    assert!(sensitive_keys(&root, &cfg).contains("hf_token"));
    assert_eq!(
        mask_argv(
            &root,
            &cfg,
            vec!["-hft".into(), "synthetic-hub-credential".into()],
            REDACTED
        ),
        ["-hft", REDACTED]
    );
    let mut projection = serde_json::to_value(&cfg).unwrap();
    mask_config(&root, &cfg, &mut projection, REDACTED);
    assert_eq!(
        projection["provider_options"]["llama.cpp"]["hf_token"],
        REDACTED
    );
    assert_eq!(projection["provider_options"]["llama.cpp"]["no_host"], true);
    std::fs::remove_dir_all(root).unwrap();
}

fn help_schema() -> OptionSchema {
    let help = Source::Help {
        document: "stdout".into(),
        start_line: 1,
        end_line: 1,
    };
    let mut pair = blank("fresh_pair", "", Target::Launch);
    pair.spellings.push(Spelling {
        flag: "--fresh-pair".into(),
        style: ValueStyle::Separate,
        polarity: None,
    });
    pair.arity = Fact {
        value: Some(Arity {
            min: 2,
            max: Some(2),
        }),
        certainty: Certainty::Verified,
        source: Some(help.clone()),
    };
    let mut items = blank("fresh_items", "", Target::Launch);
    items.spellings.push(Spelling {
        flag: "--fresh-items".into(),
        style: ValueStyle::Separate,
        polarity: None,
    });
    let mut port = items.clone();
    port.key = "port".into();
    port.spellings[0].flag = "--port".into();
    port.managed = Some(ManagedBinding::Port);
    OptionSchema {
        schema_version: SCHEMA_VERSION,
        binding: super::super::runtime_options::SchemaBinding {
            engine: "custom.example".into(),
            runtime: "build-1".into(),
            fingerprint: "a".repeat(64),
        },
        options: vec![pair, items, port],
        constraints: vec![],
        raw_help: vec![super::super::runtime_options::RawHelp {
            id: "stdout".into(),
            scope: vec![],
            stream: super::super::runtime_options::HelpStream::Stdout,
            text: "--fresh-pair A B\n".into(),
            truncated: false,
        }],
        end_of_options: Fact::default(),
    }
}

#[test]
fn mapped_template_tokens_move_into_declared_slot_order() {
    // [user input, app model, fixed marker, user output] behind
    // `-I engine.py --label serve serve api MARKER {model} --port {port}`.
    let mut schema = help_schema();
    let scope = vec!["serve".to_string(), "api".to_string()];
    for (position, key, managed) in [
        (0, "input", None),
        (1, "model", Some(ManagedBinding::Model)),
        (2, "marker", Some(ManagedBinding::EntryPoint)),
        (3, "output", None),
    ] {
        let mut slot = blank(key, "", Target::Launch);
        slot.position = Some(position);
        slot.scope = scope.clone();
        slot.managed = managed;
        if managed.is_none() {
            slot.arity = Fact {
                value: Some(Arity {
                    min: 1,
                    max: Some(1),
                }),
                certainty: Certainty::Verified,
                source: Some(Source::Help {
                    document: "stdout".into(),
                    start_line: 1,
                    end_line: 1,
                }),
            };
        }
        schema.options.push(slot);
    }
    for option in &mut schema.options {
        option.scope = scope.clone();
    }
    let tokens = vec![
        ("model".to_string(), "/m/model.bin".to_string()),
        ("marker".to_string(), "MARKER".to_string()),
    ];
    let values: Map<String, Value> = serde_json::from_value(json!({
        "output": "out.txt", "input": "in.txt",
        "fresh_pair": {"occurrences": [["a", "b"]]}
    }))
    .unwrap();
    let (with_slots, values) = with_template_slots(&schema, values, &tokens);
    let resolved = runtime_ordered::resolve_saved(&with_slots, &scope, &values).unwrap();
    let prefix: Vec<String> = [
        "-I",
        "engine.py",
        "--label",
        "serve",
        "serve",
        "api",
        "MARKER",
    ]
    .map(String::from)
    .to_vec();
    let mut template = prefix.clone();
    template.extend(["/m/model.bin", "--port", "9"].map(String::from));
    let layout = super::super::runtime_command::CommandLayout {
        version: 1,
        subcommands: vec![4, 5],
        options: vec![
            super::super::runtime_command::PrefixOption {
                index: 0,
                values: 0,
            },
            super::super::runtime_command::PrefixOption {
                index: 2,
                values: 1,
            },
        ],
    };
    let argv = layout
        .assemble(
            &prefix,
            &template,
            &resolved.sections(&scope).unwrap(),
            &[6, 7],
        )
        .unwrap();
    assert_eq!(
        argv,
        [
            "-I",
            "engine.py",
            "--label",
            "serve",
            "serve",
            "api",
            "--port",
            "9",
            "--fresh-pair",
            "a",
            "b",
            "in.txt",
            "/m/model.bin",
            "MARKER",
            "out.txt"
        ]
    );
    // Tokens before the leaf command never move.
    assert!(layout
        .assemble(
            &prefix,
            &template,
            &resolved.sections(&scope).unwrap(),
            &[1]
        )
        .is_err());
    // A value saved for an app-filled slot is kept and refused.
    let mut forged: Map<String, Value> =
        serde_json::from_value(json!({"model": "/other.bin", "input": "in.txt"})).unwrap();
    forged.insert("output".into(), json!("out.txt"));
    let (with_slots, forged) = with_template_slots(&schema, forged, &tokens);
    assert!(runtime_ordered::resolve_saved(&with_slots, &scope, &forged)
        .unwrap_err()
        .iter()
        .any(|issue| issue.key == "model"));
}

fn confirmations(entries: Value) -> BTreeMap<String, ConfirmedSyntax> {
    serde_json::from_value(entries).unwrap()
}

#[test]
fn confirmed_syntax_fills_only_unknown_help_facts_and_stays_user_sourced() {
    let keys = vec![
        "fresh_pair".to_string(),
        "fresh_items".into(),
        "port".into(),
    ];
    let saved = Supplement {
        version: SUPPLEMENT_VERSION,
        fingerprint: "a".repeat(64),
        options: confirmations(json!({
            "fresh_pair": {"arity": {"min": 1, "max": 1}, "repeatable": true},
            "fresh_items": {"arity": {"min": 0, "max": null}},
            "port": {"repeatable": true},
            "removed": {"repeatable": true}
        })),
    };
    let mut schema = help_schema();
    let view = apply_supplement(&mut schema, &keys, None, saved.clone(), true);
    schema.validate().unwrap();
    let find = |schema: &OptionSchema, key: &str| {
        schema
            .options
            .iter()
            .find(|o| o.key == key)
            .unwrap()
            .clone()
    };
    // Repetition was unknown and is now user-confirmed, never verified.
    let pair = find(&schema, "fresh_pair");
    assert_eq!(pair.repeatable.certainty, Certainty::UserConfirmed);
    assert!(matches!(pair.repeatable.source, Some(Source::User { .. })));
    // The observed arity wins; the contradicting confirmation is shown.
    assert_eq!(pair.arity.certainty, Certainty::Verified);
    assert_eq!(pair.arity.value.unwrap().min, 2);
    assert!(view.conflicts.iter().any(|c| c.key == "fresh_pair"
        && c.field == "arity"
        && c.help == json!({"min": 2, "max": 2})));
    // A variadic count the help left unknown now generates argv.
    let items = find(&schema, "fresh_items");
    assert_eq!(items.arity.certainty, Certainty::UserConfirmed);
    let overrides = runtime_help_store::overrides_from_map(
        &serde_json::from_value(
            json!({"fresh_items": {"spelling": null, "occurrences": [["a", "b c"]]}}),
        )
        .unwrap(),
    );
    assert_eq!(
        schema.resolve(&[], &overrides).unwrap().argv,
        ["--fresh-items", "a", "b c"]
    );
    // App-owned bindings and vanished options are never supplemented.
    assert!(find(&schema, "port").repeatable.supported().is_none());
    for key in ["port", "removed"] {
        assert!(view
            .conflicts
            .iter()
            .any(|c| c.key == key && c.field == "option"));
    }
    assert_eq!(view.applied, ["fresh_items", "fresh_pair"]);

    // Confirmations for another help fingerprint never apply, but their
    // differences from the current help are still shown for review.
    let mut stale = help_schema();
    let view = apply_supplement(&mut stale, &keys, None, saved, false);
    assert!(!view.current && view.applied.is_empty());
    assert!(find(&stale, "fresh_items").arity.supported().is_none());
    assert!(view.conflicts.iter().any(|c| c.field == "arity"));
    let unknown = runtime_help_store::overrides_from_map(
        &serde_json::from_value(json!({"fresh_items": "kept"})).unwrap(),
    );
    assert!(stale.resolve(&[], &unknown).unwrap_err()[0]
        .message
        .contains("arity is unknown"));
}

#[test]
fn saved_confirmations_refuse_future_malformed_and_oversized_files() {
    let root = std::env::temp_dir().join(format!("aiolm-supplement-{}", uuid::Uuid::new_v4()));
    let dir = runtime_help_store::snapshot_root(&root, "custom.example", "build-1").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(SUPPLEMENT_FILE);
    let load = || load_supplement(&root, "custom.example", "build-1");
    assert_eq!(load().unwrap(), None);
    let good = json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"fresh_items": {"arity": {"min": 1, "max": null}}}});
    std::fs::write(&path, good.to_string()).unwrap();
    assert_eq!(load().unwrap().unwrap().options.len(), 1);
    let roles = json!({"version": 2, "fingerprint": "a".repeat(64), "options": {
        "model": {"positional": {"role": "binding", "name": "model"}},
        "output": {"positional": {"role": "user"}, "arity": {"min": 1, "max": 1}}}});
    std::fs::write(&path, roles.to_string()).unwrap();
    assert_eq!(
        load().unwrap().unwrap().options["output"].positional,
        Some(PositionalRole::User)
    );
    for (bad, needle) in [
        (
            json!({"version": 3, "fingerprint": "a".repeat(64), "options": {}}),
            "version 3",
        ),
        // Positional roles exist only from version 2, so version-1
        // readers never meet one they would misread.
        (
            json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"x": {"positional": {"role": "user"}}}}),
            "cannot hold positional",
        ),
        (
            json!({"version": 2, "fingerprint": "a".repeat(64), "options": {"x": {"positional": {"role": "later"}}}}),
            "malformed",
        ),
        (
            json!({"version": 1, "fingerprint": "a".repeat(64), "options": {}, "auto": true}),
            "malformed",
        ),
        (
            json!({"version": 1, "fingerprint": "short", "options": {}}),
            "invalid",
        ),
        (
            json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"x": {}}}),
            "invalid",
        ),
        (
            json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"x": {"arity": {"min": 3, "max": 2}}}}),
            "invalid",
        ),
        (
            json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"x": {"kind": "integer"}}}),
            "malformed",
        ),
    ] {
        std::fs::write(&path, bad.to_string()).unwrap();
        let error = load().unwrap_err();
        assert!(error.message.contains(needle), "{error}");
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    }
    std::fs::write(&path, vec![b' '; SUPPLEMENT_LIMIT as usize + 1]).unwrap();
    assert!(load().unwrap_err().message.contains("bounded"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn scope_words_are_stripped_only_from_the_front() {
    let scope = vec!["serve".to_string()];
    assert_eq!(
        strip_scope(vec!["serve".into(), "--a".into(), "1".into()], &scope).unwrap(),
        vec!["--a".to_string(), "1".into()]
    );
    assert!(strip_scope(vec!["--a".into(), "serve".into()], &scope).is_err());
    assert_eq!(strip_scope(vec!["--a".into()], &[]).unwrap(), vec!["--a"]);
}
/// Isolated-home fixture: the parent test never touches the process
/// environment. It creates an owned temp home, spawns this test binary
/// with an exact fixture filter plus isolated `AIOLM_HOME`, checks the
/// child status with its output preserved, then removes only the owned
/// home it created. The child builds every fixture under that home.
const STATIC_PREFIX_FIXTURE_MODE: &str = "AIOLM_STATIC_PREFIX_FIXTURE_MODE";

/// Create the temp home this parent test owns. Only this exact directory
/// is ever removed, after checking it stays inside the temp root.
fn owned_fixture_home() -> PathBuf {
    let base = std::env::temp_dir()
        .canonicalize()
        .expect("temp dir resolves");
    let home = base.join(format!("aiolm-static-prefix-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&home).expect("create owned fixture home");
    home
}

fn remove_owned_fixture_home(home: &Path) {
    let base = std::env::temp_dir()
        .canonicalize()
        .expect("temp dir resolves");
    let owned = home.canonicalize().expect("owned fixture home exists");
    assert!(
        owned.starts_with(&base),
        "refusing to remove outside the owned temp home"
    );
    std::fs::remove_dir_all(&owned).expect("remove owned fixture home");
}

fn run_static_prefix_fixture(mode: &str) {
    // The parent never assigns the process environment: the isolated
    // home travels to the child through its own spawn environment only.
    let parent_home = std::env::var_os("AIOLM_HOME");
    let home = owned_fixture_home();
    let output =
        match crate::procutil::std_command(std::env::current_exe().expect("current test binary"))
            .args([
                "--exact",
                "providers::runtime_schema::tests::isolated_static_prefix_mask_fixture",
                "--nocapture",
            ])
            .env("AIOLM_HOME", &home)
            .env(STATIC_PREFIX_FIXTURE_MODE, mode)
            .output()
        {
            Ok(output) => output,
            Err(error) => {
                remove_owned_fixture_home(&home);
                panic!("failed to spawn isolated mask fixture: {error}");
            }
        };
    remove_owned_fixture_home(&home);
    assert_eq!(
        std::env::var_os("AIOLM_HOME"),
        parent_home,
        "the parent process environment must stay untouched"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "isolated mask fixture {mode} failed:\nstdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // An exact filter matching nothing also exits successfully, so require
    // the child's own summary: the mask case really ran and passed.
    assert!(
        stdout.contains("test result: ok. 1 passed"),
        "isolated mask fixture {mode} ran no mask case:\n{stdout}"
    );
}

fn synthetic_engine_ids() -> (String, String, String) {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    (
        format!("custom.staticprefix{}", &tag[..24]),
        format!("staticprefix-{}", &tag[..12]),
        format!("synthetic-entry-amber-{}", &tag[..8]),
    )
}

fn prefix_with_static_secret(secret: &str) -> Vec<String> {
    ["-I", "engine.py", "serve", secret, "plain-token"]
        .iter()
        .map(|token| token.to_string())
        .collect()
}

fn manifest_with_static_prefix(
    engine: &str,
    runtime: &str,
    home: &Path,
    secret: &str,
) -> registry::RuntimeManifest {
    let program = home
        .join("static-prefix-engine.exe")
        .to_string_lossy()
        .into_owned();
    let probe = home
        .join("static-prefix-probe.exe")
        .to_string_lossy()
        .into_owned();
    let mut args = prefix_with_static_secret(secret);
    args.push("{model}".into());
    args.push("--port".into());
    args.push("{port}".into());
    registry::RuntimeManifest {
        command_layout: Some(super::super::runtime_command::CommandLayout {
            version: 1,
            subcommands: vec![2],
            options: vec![super::super::runtime_command::PrefixOption {
                index: 0,
                values: 0,
            }],
        }),
        schema_version: registry::VERSION,
        adapter_version: registry::VERSION,
        engine_id: super::ProviderId::parse(engine).unwrap(),
        runtime_id: runtime.into(),
        display_name: "Synthetic static-prefix engine".into(),
        public_engine: None,
        compute_ownership: None,
        platforms: vec![registry::Platform {
            os: "windows".into(),
            arch: "x86_64".into(),
        }],
        protocol: "openai-v1".into(),
        probe: registry::ProcessSpec {
            program: probe,
            args: vec!["{model}".into()],
            env: BTreeMap::new(),
            working_directory: None,
        },
        launch: registry::ProcessSpec {
            program,
            args,
            env: BTreeMap::new(),
            working_directory: None,
        },
        launch_bindings: Some(registry::LaunchBindings {
            version: 1,
            options_separator: None,
            prefix_len: 5,
            bindings: vec![
                registry::BoundArgument {
                    name: "model".into(),
                    argument: registry::ArgBinding::Positional,
                },
                registry::BoundArgument {
                    name: "port".into(),
                    argument: registry::ArgBinding::Flag {
                        flag: "--port".into(),
                        equals: false,
                    },
                },
            ],
        }),
        bridge_command: None,
        launch_resources: None,
        option_metadata: None,
        options: vec![],
        model_formats: vec!["unknown".into()],
        models: vec![],
        artifacts: vec![],
        health_path: "/health".into(),
        health_authenticated: false,
    }
}

fn positional_slot(key: &str, position: u16, sensitive: Fact<bool>) -> OptionDefinition {
    let mut option = blank(key, "options", Target::Launch);
    option.position = Some(position);
    option.sensitive = sensitive;
    option.help = format!("{key} help");
    option
}

fn documented_sensitive() -> Fact<bool> {
    Fact {
        value: Some(true),
        certainty: Certainty::Documented,
        source: Some(Source::Adapter {
            id: "synthetic.role".into(),
            revision: "1".into(),
        }),
    }
}

fn schema_with_sensitive_slot(
    engine: &str,
    runtime: &str,
    fingerprint: &str,
    marker_sensitive: Fact<bool>,
) -> OptionSchema {
    OptionSchema {
        schema_version: SCHEMA_VERSION,
        binding: super::super::runtime_options::SchemaBinding {
            engine: engine.into(),
            runtime: runtime.into(),
            fingerprint: fingerprint.into(),
        },
        options: vec![
            positional_slot(
                "modelslot",
                0,
                Fact {
                    value: Some(false),
                    certainty: Certainty::Documented,
                    source: Some(Source::Adapter {
                        id: "synthetic.role".into(),
                        revision: "1".into(),
                    }),
                },
            ),
            positional_slot("marker", 1, marker_sensitive),
            positional_slot("plain", 2, Fact::default()),
        ],
        constraints: vec![],
        raw_help: vec![],
        end_of_options: Fact::default(),
    }
}

fn complete_help_report(fingerprint: &str) -> super::super::runtime_help::HelpReport {
    let output = |text: &str| super::super::runtime_help::TextOutput {
        text: text.into(),
        clean_text: text.into(),
        encoding: "utf-8".into(),
        decoding_loss: false,
        truncated: false,
        read_error: None,
        raw_bytes_base64: None,
    };
    super::super::runtime_help::HelpReport {
        identity: super::super::runtime_help::Identity {
            fingerprint: fingerprint.into(),
            executable_sha256: "e".repeat(64),
            artifacts_sha256: BTreeMap::new(),
            parser_version: super::super::runtime_help::PARSER_VERSION,
        },
        scope: vec![],
        stdout: output("synthetic help"),
        stderr: output(""),
        exit_code: Some(0),
        success: true,
        cancelled: false,
        timed_out: false,
        error: None,
        elapsed_ms: 1,
    }
}

fn supplement_with_static_roles(fingerprint: &str) -> Supplement {
    let mut options = BTreeMap::new();
    options.insert(
        "modelslot".into(),
        ConfirmedSyntax {
            arity: None,
            repeatable: None,
            positional: Some(PositionalRole::Binding {
                name: "model".into(),
            }),
        },
    );
    options.insert(
        "marker".into(),
        ConfirmedSyntax {
            arity: None,
            repeatable: None,
            positional: Some(PositionalRole::Static { index: 3 }),
        },
    );
    options.insert(
        "plain".into(),
        ConfirmedSyntax {
            arity: None,
            repeatable: None,
            positional: Some(PositionalRole::Static { index: 4 }),
        },
    );
    Supplement {
        version: SUPPLEMENT_POSITIONAL_VERSION,
        fingerprint: fingerprint.into(),
        options,
    }
}

/// Plant a manifest, accepted snapshot and supplement under the given
/// adapters root. `supplement_fp` equal to `snapshot_fp` is current;
/// different is stale. Filesystem writes only; the process environment
/// is never read or changed here.
fn build_engine_fixture(
    adapters: &Path,
    home: &Path,
    snapshot_fp: &str,
    supplement_fp: &str,
    marker_sensitive: Fact<bool>,
) -> (AppConfig, String, String, String) {
    let (engine, runtime, secret) = synthetic_engine_ids();
    let manifest = manifest_with_static_prefix(&engine, &runtime, home, &secret);
    registry::validate_manifest(&manifest).unwrap();
    let record = serde_json::json!({
        "manifest": serde_json::to_value(&manifest).unwrap(),
        "executable_sha256": "e".repeat(64),
        "probe_sha256": "f".repeat(64),
    });
    let registration = adapters
        .join(&engine)
        .join(&runtime)
        .join("registration.json");
    std::fs::create_dir_all(registration.parent().unwrap()).unwrap();
    std::fs::write(&registration, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    let schema = schema_with_sensitive_slot(&engine, &runtime, snapshot_fp, marker_sensitive);
    runtime_help_store::save_snapshot(
        adapters,
        &engine,
        &runtime,
        &HelpSnapshot {
            report: complete_help_report(snapshot_fp),
            schema,
        },
    )
    .unwrap();
    write_accepted(
        adapters,
        &engine,
        &runtime,
        &AcceptedHelp {
            version: ACCEPTED_VERSION,
            working_directory: None,
            fingerprint: snapshot_fp.into(),
            request: HelpRequest {
                encoding: None,
                locale: None,
                working_directory: None,
                program: None,
                args: vec!["--help".into()],
                scope: vec![],
            },
        },
    )
    .unwrap();
    let supplement = supplement_with_static_roles(supplement_fp);
    let dir = runtime_help_store::snapshot_root(adapters, &engine, &runtime).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(SUPPLEMENT_FILE),
        serde_json::to_vec(&supplement).unwrap(),
    )
    .unwrap();
    let cfg = AppConfig {
        active_provider: engine.clone(),
        active_runtime: runtime.clone(),
        ..Default::default()
    };
    (cfg, engine, runtime, secret)
}

#[test]
fn static_entry_prefix_secrets_are_masked_for_current_help() {
    run_static_prefix_fixture("current");
}

#[test]
fn stale_static_roles_stay_masked_without_applying_launch() {
    run_static_prefix_fixture("stale");
}

#[test]
fn unknown_sensitivity_never_masks_entry_tokens() {
    run_static_prefix_fixture("unknown");
}

/// Child entry point for the isolated mask cases above. Runs only when
/// spawned with an isolated `AIOLM_HOME`; a plain suite run returns
/// immediately without touching the process environment. Never spawns.
#[test]
fn isolated_static_prefix_mask_fixture() {
    // The mode variable only travels with a spawned isolated child; a
    // plain suite run (whose ambient environment may well define a home)
    // returns immediately without touching anything.
    let Ok(mode) = std::env::var(STATIC_PREFIX_FIXTURE_MODE) else {
        return;
    };
    let Some(home) = std::env::var_os("AIOLM_HOME") else {
        return;
    };
    let home = PathBuf::from(home);
    let adapters = home.join("runtimes").join("adapters");
    match mode.as_str() {
        "current" => current_mask_case(&adapters, &home),
        "stale" => stale_mask_case(&adapters, &home),
        "unknown" => unknown_mask_case(&adapters, &home),
        "old-parser" => old_parser_static_prefix_mask_case(&adapters, &home),
        "old-parser-negative" => historical_static_prefix_negative_case(&adapters, &home),
        "old-parser-metadata" => historical_static_prefix_metadata_case(&adapters, &home),
        mode => panic!("unknown static prefix fixture mode: {mode}"),
    }
}

fn current_mask_case(root: &Path, home: &Path) {
    let snapshot = "a".repeat(64);
    let (cfg, engine, runtime, secret) =
        build_engine_fixture(root, home, &snapshot, &snapshot, documented_sensitive());
    // The stored registration is legal and keeps the real token.
    let manifest =
        registry::manifest(super::ProviderId::parse(&engine).unwrap(), &runtime).unwrap();
    assert!(manifest.launch.args.contains(&secret));
    assert_eq!(manifest.launch.args[3], secret);
    let argv = vec![
        "C:\\synthetic\\static-prefix-engine.exe".into(),
        "-I".into(),
        "engine.py".into(),
        "serve".into(),
        secret.clone(),
        "plain-token".into(),
        format!("--token={secret}"),
    ];
    let masked = mask_argv(root, &cfg, argv.clone(), REDACTED);
    let redacted_token = format!("--token={REDACTED}");
    let expected = [
        "C:\\synthetic\\static-prefix-engine.exe",
        "-I",
        "engine.py",
        "serve",
        REDACTED,
        "plain-token",
        redacted_token.as_str(),
    ];
    assert_eq!(
        masked,
        expected
            .iter()
            .map(|token| token.to_string())
            .collect::<Vec<_>>()
    );
    // The input argv and the stored manifest keep their exact bytes.
    assert!(argv.contains(&secret));
    assert!(manifest.launch.args.contains(&secret));
    // Current roles still configure launch.
    let effective = effective(root, &cfg, false).unwrap();
    assert_eq!(
        effective
            .entry
            .as_ref()
            .unwrap()
            .positional_roles
            .get("marker"),
        Some(&PositionalRole::Static { index: 3 })
    );
}

fn stale_mask_case(root: &Path, home: &Path) {
    let (cfg, _engine, _runtime, secret) = build_engine_fixture(
        root,
        home,
        &"a".repeat(64),
        &"b".repeat(64),
        documented_sensitive(),
    );
    let argv = vec![
        "C:\\synthetic\\static-prefix-engine.exe".into(),
        "serve".into(),
        secret.clone(),
        "plain-token".into(),
    ];
    let masked = mask_argv(root, &cfg, argv.clone(), REDACTED);
    let expected = [
        "C:\\synthetic\\static-prefix-engine.exe",
        "serve",
        REDACTED,
        "plain-token",
    ];
    assert_eq!(
        masked,
        expected
            .iter()
            .map(|token| token.to_string())
            .collect::<Vec<_>>()
    );
    assert!(argv.contains(&secret));
    // A stale role never configures launch, only display copies.
    let effective = effective(root, &cfg, false).unwrap();
    assert!(!effective.supplement.as_ref().unwrap().current);
    assert!(effective
        .entry
        .as_ref()
        .unwrap()
        .positional_roles
        .is_empty());
}

fn unknown_mask_case(root: &Path, home: &Path) {
    let snapshot = "a".repeat(64);
    let (cfg, _engine, _runtime, secret) = build_engine_fixture(
        root,
        home,
        &snapshot,
        &snapshot,
        Fact {
            value: Some(true),
            certainty: Certainty::Unknown,
            source: None,
        },
    );
    let argv = vec!["serve".into(), secret.clone(), "plain-token".into()];
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), argv);
}

#[test]
fn sensitive_entry_tokens_cover_only_proven_prefix_positions() {
    let entry = CommandEntry {
        version: 1,
        program: "/synthetic/engine".into(),
        prefix: prefix_with_static_secret("synthetic-entry-secret"),
        layout: None,
        separator: None,
        positional_bindings: None,
        positional_roles: BTreeMap::new(),
    };
    let mut options = BTreeMap::new();
    options.insert(
        "marker".into(),
        ConfirmedSyntax {
            arity: None,
            repeatable: None,
            positional: Some(PositionalRole::Static { index: 3 }),
        },
    );
    // Guessed roles for unproven slots must not widen the mask.
    options.insert(
        "guess".into(),
        ConfirmedSyntax {
            arity: None,
            repeatable: None,
            positional: Some(PositionalRole::Static { index: 4 }),
        },
    );
    options.insert(
        "far".into(),
        ConfirmedSyntax {
            arity: None,
            repeatable: None,
            positional: Some(PositionalRole::Static { index: 99 }),
        },
    );
    let view = |sensitive: Fact<bool>| {
        let mut schema_options = vec![
            positional_slot("marker", 1, sensitive),
            positional_slot("guess", 2, Fact::default()),
        ];
        // A request-scoped secret is not a launch token.
        let mut request = positional_slot("request", 3, documented_sensitive());
        request.target = Target::Request;
        schema_options.push(request);
        // A non-positional launch secret has no prefix position.
        let mut flag = positional_slot("flag", 4, documented_sensitive());
        flag.position = None;
        schema_options.push(flag);
        EffectiveSchema {
            supports_launch_args: true,
            additional_arg_flags: BTreeMap::new(),
            schema: OptionSchema {
                schema_version: SCHEMA_VERSION,
                binding: super::super::runtime_options::SchemaBinding {
                    engine: "custom.example".into(),
                    runtime: "build-1".into(),
                    fingerprint: "a".repeat(64),
                },
                options: schema_options,
                constraints: vec![],
                raw_help: vec![],
                end_of_options: Fact::default(),
            },
            benchmark_names: BTreeMap::new(),
            scope: vec![],
            help_state: HelpState::Current,
            help_detail: String::new(),
            accepted_fingerprint: Some("a".repeat(64)),
            compat_keys: vec![],
            help_keys: vec![
                "marker".into(),
                "guess".into(),
                "far".into(),
                "request".into(),
                "flag".into(),
            ],
            shadowed: vec![],
            conflicts: vec![],
            metadata: None,
            supplement: Some(SupplementView {
                fingerprint: "a".repeat(64),
                options: options.clone(),
                current: true,
                applied: vec!["marker".into()],
                conflicts: vec![],
            }),
            supplement_error: None,
            entry: Some(entry.clone()),
        }
    };
    // Only the proven sensitive slot's token is covered; the program,
    // the plain neighbour and every unproven role stay exact.
    assert_eq!(
        sensitive_entry_tokens(&view(documented_sensitive())),
        BTreeSet::from(["synthetic-entry-secret".into()])
    );
    assert!(sensitive_entry_tokens(&view(Fact::default())).is_empty());
}
#[test]
fn rejected_help_prefix_does_not_echo_literal_entry_arguments() {
    let secret = "synthetic-static-credential";
    let manifest = manifest_with_static_prefix(
        "custom.help-diagnostic",
        "build-2",
        Path::new("/synthetic"),
        secret,
    );
    let request: HelpRequest = serde_json::from_value(json!({
        "program": null, "args": ["--help"], "scope": []
    }))
    .unwrap();
    let error = manifest_help_command(&manifest, &request).unwrap_err();
    assert!(error
        .message
        .contains("help arguments must start with the registered entry point"));
    assert!(
        !error.message.contains(secret),
        "help errors are displayed while a replaced runtime's saved command is stale"
    );
    assert!(!error.message.contains("plain-token"));
    assert_eq!(
        manifest.launch.args[3], secret,
        "validation must preserve the registered argv"
    );
}
// No real engine is spawned. The existing isolated-home wrapper starts only
// this crate's exact Rust test child and requires its one-test pass summary.

#[test]
fn static_entry_prefix_secrets_stay_masked_after_parser_upgrade() {
    run_static_prefix_fixture("old-parser");
}

fn old_parser_static_prefix_mask_case(root: &Path, home: &Path) {
    let snapshot_fp = "a".repeat(64);
    let (cfg, engine, runtime, secret) = build_engine_fixture(
        root,
        home,
        &snapshot_fp,
        &snapshot_fp,
        documented_sensitive(),
    );
    let provider = super::ProviderId::parse(&engine).unwrap();
    let manifest = registry::manifest(provider, &runtime).unwrap();
    let registration_path = root.join(&engine).join(&runtime).join("registration.json");
    let registration_before = std::fs::read(&registration_path).unwrap();
    let accepted_path = accepted_path(root, &engine, &runtime).unwrap();
    let accepted_before = std::fs::read(&accepted_path).unwrap();
    let supplement_path = supplement_path(root, &engine, &runtime).unwrap();
    let supplement_before = std::fs::read(&supplement_path).unwrap();
    let cfg_before = serde_json::to_value(&cfg).unwrap();
    let argv = vec![
        "C:\\synthetic\\static-prefix-engine.exe".into(),
        "-I".into(),
        "engine.py".into(),
        "serve".into(),
        secret.clone(),
        "plain-token".into(),
        format!("--token={secret}"),
    ];
    let argv_before = argv.clone();
    let expected = vec![
        "C:\\synthetic\\static-prefix-engine.exe".into(),
        "-I".into(),
        "engine.py".into(),
        "serve".into(),
        REDACTED.into(),
        "plain-token".into(),
        format!("--token={REDACTED}"),
    ];
    assert_eq!(manifest.launch.args[3], secret);
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), expected);

    let snapshot_path = runtime_help_store::snapshot_root(root, &engine, &runtime)
        .unwrap()
        .join(format!("{snapshot_fp}.json"));
    let snapshot_before = std::fs::read(&snapshot_path).unwrap();
    let original: Value = serde_json::from_slice(&snapshot_before).unwrap();
    let mut historical = original.clone();
    let previous_parser = super::super::runtime_help::PARSER_VERSION
        .checked_sub(1)
        .unwrap();
    historical["report"]["identity"]["parser_version"] = json!(previous_parser);
    let historical_bytes = serde_json::to_vec(&historical).unwrap();
    std::fs::write(&snapshot_path, &historical_bytes).unwrap();
    let mut restored = historical.clone();
    restored["report"]["identity"]["parser_version"] =
        original["report"]["identity"]["parser_version"].clone();
    assert_eq!(
        restored, original,
        "the fixture changes only the parser version"
    );

    assert!(
        runtime_help_store::load_snapshot(root, &engine, &runtime, &snapshot_fp)
            .unwrap()
            .is_none()
    );
    let stale = effective(root, &cfg, false).unwrap();
    assert_eq!(stale.help_state, HelpState::Stale);
    assert!(stale.help_keys.is_empty());
    assert!(stale.entry.as_ref().unwrap().positional_roles.is_empty());
    assert!(sensitive_keys(root, &cfg).contains("marker"));
    let retained: Map<String, Value> =
        serde_json::from_value(json!({"marker":"synthetic-retained-user-value"})).unwrap();
    let launch_error = launch_arguments(root, &cfg, &retained).unwrap_err();
    assert!(
        launch_error.contains("accepted help snapshot is missing"),
        "{launch_error}"
    );
    assert!(
        launch_error.contains("Saved options marker were retained"),
        "{launch_error}"
    );

    let actual = mask_argv(root, &cfg, argv.clone(), REDACTED);
    assert_eq!(argv, argv_before, "the caller's launch argv stays exact");
    assert_eq!(serde_json::to_value(&cfg).unwrap(), cfg_before);
    assert_eq!(registry::manifest(provider, &runtime).unwrap(), manifest);
    assert_eq!(
        std::fs::read(&registration_path).unwrap(),
        registration_before
    );
    assert_eq!(std::fs::read(&accepted_path).unwrap(), accepted_before);
    assert_eq!(std::fs::read(&supplement_path).unwrap(), supplement_before);
    assert_eq!(std::fs::read(&snapshot_path).unwrap(), historical_bytes);
    // Public-output receipt precedes the intended privacy assertion, so RED
    // retains complete actual/expected argv and byte-ownership identities.
    println!(
        "R61_OLD_PARSER_STATIC_MASK {}",
        json!({
            "actual": actual, "expected": expected, "argv_unchanged": argv == argv_before,
            "registration_sha256": format!("{:x}", Sha256::digest(&registration_before)),
            "snapshot_before_sha256": format!("{:x}", Sha256::digest(&snapshot_before)),
            "snapshot_historical_sha256": format!("{:x}", Sha256::digest(&historical_bytes)),
            "accepted_sha256": format!("{:x}", Sha256::digest(&accepted_before)),
            "supplement_sha256": format!("{:x}", Sha256::digest(&supplement_before)),
            "help_state": stale.help_state, "launch_error": launch_error,
        })
    );
    assert_eq!(
        actual, expected,
        "an explicitly known-sensitive static prefix token stays hidden after a parser upgrade"
    );
}

#[test]
fn historical_static_prefix_mask_requires_reviewed_evidence() {
    run_static_prefix_fixture("old-parser-negative");
}

fn historical_static_prefix_negative_case(root: &Path, home: &Path) {
    let fingerprint = "a".repeat(64);
    let (cfg, engine, runtime, secret) = build_engine_fixture(
        root,
        home,
        &fingerprint,
        &fingerprint,
        documented_sensitive(),
    );
    let snapshot_path = runtime_help_store::snapshot_root(root, &engine, &runtime)
        .unwrap()
        .join(format!("{fingerprint}.json"));
    let supplement_path = supplement_path(root, &engine, &runtime).unwrap();
    let supplement_bytes = std::fs::read(&supplement_path).unwrap();
    let mut snapshot: HelpSnapshot =
        serde_json::from_slice(&std::fs::read(&snapshot_path).unwrap()).unwrap();
    snapshot.report.identity.parser_version = super::super::runtime_help::PARSER_VERSION
        .checked_sub(1)
        .unwrap();
    let historical_bytes = serde_json::to_vec(&snapshot).unwrap();
    std::fs::write(&snapshot_path, &historical_bytes).unwrap();
    let argv = vec!["serve".into(), secret.clone(), format!("--token={secret}")];
    let expected = vec![
        "serve".into(),
        REDACTED.into(),
        format!("--token={REDACTED}"),
    ];
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), expected);

    // These schemas are otherwise valid, so each secrecy/target/index
    // guard is exercised independently of malformed-schema rejection.
    let mut unknown = snapshot.clone();
    unknown.schema.options[1].sensitive.certainty = Certainty::Unknown;
    let mut public = snapshot.clone();
    public.schema.options[1].sensitive.value = Some(false);
    let mut request = snapshot.clone();
    request.schema.options[1].target = Target::Request;
    request.schema.options[1].position = None;
    request.schema.options[1].request_field =
        documented("marker".into(), &adapter_source("synthetic.role", "1"));
    let mut flag = snapshot.clone();
    flag.schema.options[1].position = None;
    flag.schema.options[1].spellings = vec![Spelling {
        flag: "--marker".into(),
        style: ValueStyle::Separate,
        polarity: None,
    }];
    for (name, candidate) in [
        ("unknown sensitivity", unknown),
        ("explicit public", public),
        ("request target", request),
        ("nonpositional option", flag),
    ] {
        candidate.schema.validate().expect(name);
        std::fs::write(&snapshot_path, serde_json::to_vec(&candidate).unwrap()).unwrap();
        assert_eq!(
            mask_argv(root, &cfg, argv.clone(), REDACTED),
            argv,
            "{name}"
        );
    }

    let mut foreign_engine = snapshot.clone();
    foreign_engine.schema.binding.engine = "custom.foreign".into();
    let mut foreign_runtime = snapshot.clone();
    foreign_runtime.schema.binding.runtime = "foreign-runtime".into();
    let mut foreign_fingerprint = snapshot.clone();
    foreign_fingerprint.schema.binding.fingerprint = "b".repeat(64);
    let mut invalid_schema = snapshot.clone();
    invalid_schema.schema.schema_version = SCHEMA_VERSION + 1;
    for (name, candidate) in [
        ("foreign engine", foreign_engine),
        ("foreign runtime", foreign_runtime),
        ("foreign schema fingerprint", foreign_fingerprint),
        ("unsupported schema", invalid_schema),
    ] {
        std::fs::write(&snapshot_path, serde_json::to_vec(&candidate).unwrap()).unwrap();
        assert_eq!(
            mask_argv(root, &cfg, argv.clone(), REDACTED),
            argv,
            "{name}"
        );
    }
    std::fs::write(&snapshot_path, b"{").unwrap();
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), argv);
    std::fs::remove_file(&snapshot_path).unwrap();
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), argv);
    std::fs::write(&snapshot_path, &historical_bytes).unwrap();

    let original_supplement: Supplement = serde_json::from_slice(&supplement_bytes).unwrap();
    let mut foreign_supplement = original_supplement.clone();
    foreign_supplement.fingerprint = "b".repeat(64);
    let mut far_index = original_supplement.clone();
    far_index.options.get_mut("marker").unwrap().positional =
        Some(PositionalRole::Static { index: 99 });
    let mut invalid_index = original_supplement.clone();
    invalid_index.options.get_mut("marker").unwrap().positional =
        Some(PositionalRole::Static { index: 128 });
    let mut unknown_key = original_supplement.clone();
    let role = unknown_key.options.remove("marker").unwrap();
    unknown_key.options.insert("unknown_slot".into(), role);
    let mut user_role = original_supplement.clone();
    user_role.options.get_mut("marker").unwrap().positional = Some(PositionalRole::User);
    for (name, candidate) in [
        ("foreign supplement fingerprint", foreign_supplement),
        ("outside prefix index", far_index),
        ("invalid stored index", invalid_index),
        ("unknown slot key", unknown_key),
        ("user role", user_role),
    ] {
        std::fs::write(&supplement_path, serde_json::to_vec(&candidate).unwrap()).unwrap();
        assert_eq!(
            mask_argv(root, &cfg, argv.clone(), REDACTED),
            argv,
            "{name}"
        );
    }
    std::fs::write(&supplement_path, b"{").unwrap();
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), argv);
    std::fs::remove_file(&supplement_path).unwrap();
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), argv);
    std::fs::write(&supplement_path, &supplement_bytes).unwrap();
    // Restoring valid evidence restores masking on the next call.
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), expected);
    assert_eq!(std::fs::read(&snapshot_path).unwrap(), historical_bytes);
    assert_eq!(std::fs::read(&supplement_path).unwrap(), supplement_bytes);
}

#[test]
fn historical_static_prefix_secrecy_uses_explicit_runtime_metadata() {
    run_static_prefix_fixture("old-parser-metadata");
}

fn historical_static_prefix_metadata_case(root: &Path, home: &Path) {
    let fingerprint = "a".repeat(64);
    let (cfg, engine, runtime, secret) =
        build_engine_fixture(root, home, &fingerprint, &fingerprint, Fact::default());
    let registration_path = root.join(&engine).join(&runtime).join("registration.json");
    let mut registration: Value =
        serde_json::from_slice(&std::fs::read(&registration_path).unwrap()).unwrap();
    registration["manifest"]["option_metadata"] = json!({
        "version": runtime_metadata::METADATA_VERSION,
        "engine_id": engine,
        "adapter": {"id": "synthetic.role", "revision": "1"},
        "options": [{"positional": "marker", "sensitive": true}],
    });
    let registration_bytes = serde_json::to_vec(&registration).unwrap();
    std::fs::write(&registration_path, &registration_bytes).unwrap();
    let argv = vec!["serve".into(), secret.clone(), format!("--token={secret}")];
    let expected = vec![
        "serve".into(),
        REDACTED.into(),
        format!("--token={REDACTED}"),
    ];
    let current_mask = mask_argv(root, &cfg, argv.clone(), REDACTED);
    assert_eq!(current_mask, expected);
    let snapshot_path = runtime_help_store::snapshot_root(root, &engine, &runtime)
        .unwrap()
        .join(format!("{fingerprint}.json"));
    let mut snapshot: HelpSnapshot =
        serde_json::from_slice(&std::fs::read(&snapshot_path).unwrap()).unwrap();
    assert!(snapshot.schema.options[1].sensitive.supported().is_none());
    snapshot.report.identity.parser_version = super::super::runtime_help::PARSER_VERSION
        .checked_sub(1)
        .unwrap();
    let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
    std::fs::write(&snapshot_path, &snapshot_bytes).unwrap();
    let stale = effective(root, &cfg, false).unwrap();
    assert_eq!(stale.help_state, HelpState::Stale);
    assert!(stale.help_keys.is_empty());
    assert!(stale.entry.as_ref().unwrap().positional_roles.is_empty());
    assert!(sensitive_keys(root, &cfg).contains("marker"));
    let actual = mask_argv(root, &cfg, argv.clone(), REDACTED);
    assert_eq!(
        std::fs::read(&registration_path).unwrap(),
        registration_bytes
    );
    assert_eq!(std::fs::read(&snapshot_path).unwrap(), snapshot_bytes);
    println!(
        "R61_HISTORICAL_METADATA_STATIC_MASK {}",
        json!({"actual": actual, "expected": expected, "current_mask": current_mask})
    );
    assert_eq!(
        actual, expected,
        "explicit runtime metadata preserves historical static-slot secrecy"
    );

    // Metadata only fills observed unknowns. It cannot contradict an
    // explicit public fact or infer a slot from an unrelated selector.
    snapshot.schema.options[1].sensitive = Fact {
        value: Some(false),
        certainty: Certainty::Documented,
        source: Some(adapter_source("synthetic.role", "1")),
    };
    std::fs::write(&snapshot_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert!(!sensitive_keys(root, &cfg).contains("marker"));
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), argv);
    snapshot.schema.options[1].sensitive = Fact::default();
    std::fs::write(&snapshot_path, &snapshot_bytes).unwrap();
    registration["manifest"]["option_metadata"]["options"][0]["positional"] =
        json!("unrelated_slot");
    std::fs::write(
        &registration_path,
        serde_json::to_vec(&registration).unwrap(),
    )
    .unwrap();
    assert!(!sensitive_keys(root, &cfg).contains("marker"));
    assert_eq!(mask_argv(root, &cfg, argv.clone(), REDACTED), argv);
}
