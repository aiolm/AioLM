use super::*;
#[test]
fn discovery_scopes_bindings_to_the_selected_installation_without_format_claims() {
    let area = std::env::temp_dir().join(format!("aiolm-model-selection-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&area).unwrap();
    let deployment = area.join("deployment.json");
    fs::write(&deployment, b"{}").unwrap();
    let mut selected = example();
    selected.model_formats = vec!["gguf".into()];
    selected.models = vec![ModelBinding {
        path: deployment.to_string_lossy().into_owned(),
        name: "Selected deployment".into(),
    }];
    let mut other_build = selected.clone();
    other_build.runtime_id = "build-2".into();
    other_build.models[0].name = "Other build's label".into();
    let mut other_engine = selected.clone();
    other_engine.engine_id = ProviderId::parse("custom.other").unwrap();
    other_engine.models[0].name = "Other engine's label".into();
    let models = model_bindings(
        [other_build, other_engine, selected.clone()],
        Some((selected.engine_id, "build-1")),
    );
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].name, "Selected deployment");
    assert!(models[0].missing.is_empty());
    let mut gguf = models[0].clone();
    gguf.format = super::super::artifacts::ArtifactFormat::Gguf;
    let result = assess(&gguf, selected.engine_id);
    assert_eq!(result.status, super::super::compat::CompatStatus::Unknown);
    assert!(!result.loadable());
    assert!(result.tasks.is_empty());
    assert!(!result.modalities.text);
    assert!(model_bindings(
        [selected.clone()],
        Some((selected.engine_id, "not-installed"))
    )
    .is_empty());
    fs::remove_file(&deployment).unwrap();
    let missing = model_bindings([selected.clone()], Some((selected.engine_id, "build-1")));
    assert_eq!(missing[0].missing, ["registered model binding is missing"]);
    assert_eq!(
        assess(&missing[0], selected.engine_id).readiness,
        missing[0].missing
    );
    fs::remove_dir(&area).unwrap();
}
fn example() -> RuntimeManifest {
    let root = std::env::temp_dir().join("aiolm-synthetic-adapter");
    let probe = root.join("probe");
    let server = root.join("server");
    serde_json::from_value(serde_json::json!({"schema_version":1,"adapter_version":1,"engine_id":"custom.example","runtime_id":"build-1","display_name":"Example engine","protocol":"openai-v1","platforms":[{"os":"linux","arch":"x86_64"}],"probe":{"program":probe,"args":["{model}","{options_json}"]},"launch":{"program":server,"args":["--model","{model}","--port","{port}","--alias","{model_alias}"],"env":{"ENGINE_KEY":"{api_key}"}},"model_formats":["unknown"],"health_path":"/health","options":[{"key":"workers","flag":"--workers","target":"launch","kind":{"type":"integer","min":1,"max":8}},{"key":"temperature","target":"request","kind":{"type":"number","min":0,"max":2}}]})).unwrap()
}

#[test]
fn unvalidated_option_schemas_report_issues_instead_of_panicking() {
    let mut manifest = example();
    let source = super::super::runtime_schema::adapter_source("custom.example", "test");
    for kind in [
        serde_json::json!({"type":"choice"}),
        serde_json::json!({"type":"choice","choices":"a"}),
        serde_json::json!({"type":"choice","choices":[]}),
        serde_json::json!({"type":"text"}),
        serde_json::json!({"type":"text","max_len":"10"}),
        serde_json::json!({"type":"text","max_len":32769}),
        serde_json::json!({"type":"number","min":2,"max":1}),
        serde_json::json!({"type":"integer","min":1,"max":8,"choices":[9]}),
        serde_json::json!({"type":"integer","min":1,"max":8,"sentinel_values":[-1.5]}),
    ] {
        manifest.options[0].kind = kind;
        assert!(validate_manifest(&manifest).is_err());
        assert!(
            super::super::runtime_schema::from_external(&manifest.options[0], &source,).is_none()
        );
        let issues = option_issues(
            &manifest,
            serde_json::json!({"workers":"a"}).as_object().unwrap(),
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].key, "workers");
        assert_eq!(issues[0].code, "type");
        assert_eq!(
            issues[0].message,
            "unsupported or invalid adapter option: workers"
        );
    }
}

fn metadata_probe() -> ProbeResult {
    serde_json::from_value(serde_json::json!({
        "schema_version":1,"engine_id":"custom.example","runtime_id":"build-1",
        "version":"machine-local display version","accelerator":"unverified",
        "model":"selected","model_supported":true,"served_model":"private-model",
        "capabilities":{"tasks":["generate"],"modalities":{"text":true,"image":false,"audio":false,"video":false},"chat":true}
    })).unwrap()
}

#[test]
fn serving_observations_preserve_authoritative_nulls_unknowns_and_selected_format() {
    use super::super::{
        artifacts::ArtifactFormat,
        protocol::{ServingMemoryScope, ServingTopology},
    };
    let mut manifest = example();
    manifest.public_engine = Some(PublicEngine {
        name: Some("sglang".into()),
        version: Some("1.2".into()),
        ..PublicEngine::default()
    });
    manifest.compute_ownership = Some(ComputeOwnership::Direct);
    manifest.model_formats = vec!["gguf".into(), "mlx".into()];
    let mut probe = metadata_probe();
    let inherited = serving_metadata(&manifest, &probe);
    assert_eq!(inherited.runtime, manifest.public_engine.clone().unwrap());
    assert_eq!(inherited.topology, ServingTopology::Owned);
    // A supported-format inventory never establishes selected-model format.
    assert_eq!(
        serving_metadata(&manifest, &probe).model_format,
        ArtifactFormat::Unknown
    );

    probe.public_engine = Some(PublicEngine::default());
    probe.compute_ownership = Some(ComputeOwnership::Unknown);
    probe.model_format = Some(ArtifactFormat::Unknown);
    let unknown = serving_metadata(&manifest, &probe);
    assert_eq!(unknown.runtime, PublicEngine::default());
    assert_eq!(unknown.topology, ServingTopology::Unknown);
    assert_eq!(unknown.memory_scope, ServingMemoryScope::Unavailable);
    assert_eq!(unknown.model_format, ArtifactFormat::Unknown);
    probe.model_format = Some(ArtifactFormat::Mlx);
    assert_eq!(
        serving_metadata(&manifest, &probe).model_format,
        ArtifactFormat::Mlx
    );

    probe.public_engine = None;
    manifest.public_engine = None;
    let private = serving_metadata(&manifest, &probe);
    assert_eq!(private.runtime, PublicEngine::default());
    let json = serde_json::to_string(&private).unwrap();
    for secret in [
        "custom.example",
        "build-1",
        "private-model",
        "machine-local",
        "unverified",
    ] {
        assert!(!json.contains(secret));
    }
}

#[test]
fn manifests_and_probes_reject_unsafe_or_non_strict_public_observations() {
    let identity = serde_json::to_value(PublicEngine::default()).unwrap();
    for malformed in [
        serde_json::json!({"name":null}),
        serde_json::json!({"name":null,"version":null,"backend":null,"build":null,"variant":null,"plugin_version":null,"extra":null}),
    ] {
        let mut manifest = serde_json::to_value(example()).unwrap();
        manifest["public_engine"] = malformed.clone();
        assert!(serde_json::from_value::<RuntimeManifest>(manifest).is_err());
        let mut probe = serde_json::to_value(metadata_probe()).unwrap();
        probe["public_engine"] = malformed;
        assert!(serde_json::from_value::<ProbeResult>(probe).is_err());
    }
    for invalid in [
        "",
        "/private/engine",
        "host:port",
        "user@host",
        "back\\slash",
        "line\nbreak",
        "\u{7f}",
    ] {
        let mut malformed = identity.clone();
        malformed["version"] = Value::String(invalid.into());
        assert!(serde_json::from_value::<PublicEngine>(malformed).is_err());
        let mut manifest = example();
        manifest.public_engine = Some(PublicEngine {
            version: Some(invalid.into()),
            ..PublicEngine::default()
        });
        assert!(validate_manifest(&manifest).is_err());
        let mut probe = metadata_probe();
        probe.public_engine = manifest.public_engine.clone();
        assert!(validate_probe_result(&probe, &example(), Some("selected")).is_err());
    }
    for (key, value) in [("compute_ownership", "proxy"), ("model_format", "weights")] {
        let mut manifest = serde_json::to_value(example()).unwrap();
        manifest[key] = value.into();
        assert!(serde_json::from_value::<RuntimeManifest>(manifest).is_err());
        let mut probe = serde_json::to_value(metadata_probe()).unwrap();
        probe[key] = value.into();
        assert!(serde_json::from_value::<ProbeResult>(probe).is_err());
    }
}
#[test]
fn fixed_output_declarations_need_a_matching_request_option_and_usage() {
    let declared = |control: &str, kind: Value, usage: Value| {
        let mut manifest = example();
        manifest.options.push(ExternalOption {
            scope: None,
            key: control.into(),
            flag: None,
            kind,
            target: "request".into(),
            group: options_group(),
            runtime_default: None,
        });
        validate_manifest(&manifest).unwrap();
        let mut probe = serde_json::to_value(metadata_probe()).unwrap();
        probe["capabilities"]["fixed_output"] = control.into();
        probe["capabilities"]["stream_usage_supported"] = usage;
        let probe: ProbeResult = serde_json::from_value(probe).unwrap();
        validate_probe_result(&probe, &manifest, Some("selected"))
    };
    let toggle = serde_json::json!({"type":"toggle"});
    let range = serde_json::json!({"type":"integer","min":0,"max":MAX_FIXED_OUTPUT_TOKENS});
    declared("ignore_eos", toggle.clone(), true.into()).unwrap();
    declared(
        "ignore_eos",
        serde_json::json!({"type":"flag"}),
        true.into(),
    )
    .unwrap();
    declared("min_tokens", range.clone(), true.into()).unwrap();
    declared(
        "min_tokens",
        serde_json::json!({"type":"integer","min":0,"max":MAX_FIXED_OUTPUT_TOKENS,"sentinel_values":[-1]}),
        true.into(),
    )
    .unwrap();
    for usage in [Value::Null, false.into()] {
        let error = declared("ignore_eos", toggle.clone(), usage).unwrap_err();
        assert!(error.contains("stream_usage_supported"), "{error}");
    }
    for (control, kind) in [
        ("ignore_eos", range.clone()),
        ("min_tokens", toggle.clone()),
        (
            "min_tokens",
            serde_json::json!({"type":"integer","min":1,"max":32768}),
        ),
        (
            "min_tokens",
            serde_json::json!({"type":"integer","min":1,"max":32768,"sentinel_values":[MAX_FIXED_OUTPUT_TOKENS]}),
        ),
        (
            "min_tokens",
            serde_json::json!({"type":"integer","min":1024,"max":MAX_FIXED_OUTPUT_TOKENS,"sentinel_values":[1]}),
        ),
        (
            "min_tokens",
            serde_json::json!({"type":"integer","min":1,"max":MAX_FIXED_OUTPUT_TOKENS,"choices":[1024]}),
        ),
        (
            "min_tokens",
            serde_json::json!({"type":"number","min":0,"max":MAX_FIXED_OUTPUT_TOKENS}),
        ),
    ] {
        assert!(declared(control, kind, true.into()).is_err(), "{control}");
    }
    // Without the request option the declaration cannot be honored.
    let mut probe = serde_json::to_value(metadata_probe()).unwrap();
    probe["capabilities"]["fixed_output"] = "min_tokens".into();
    probe["capabilities"]["stream_usage_supported"] = true.into();
    let probe: ProbeResult = serde_json::from_value(probe).unwrap();
    let error = validate_probe_result(&probe, &example(), Some("selected")).unwrap_err();
    assert!(error.contains("request option"), "{error}");
    // Unknown controls are not accepted, and absent stays unsupported.
    let mut unknown = serde_json::to_value(metadata_probe()).unwrap();
    unknown["capabilities"]["fixed_output"] = "max_tokens".into();
    assert!(serde_json::from_value::<ProbeResult>(unknown).is_err());
    let absent = metadata_probe();
    assert_eq!(absent.capabilities.fixed_output, None);
    validate_probe_result(&absent, &example(), Some("selected")).unwrap();
    assert!(!serde_json::to_string(&absent)
        .unwrap()
        .contains("fixed_output"));
}
#[test]
fn manifest_artifacts_allow_256_paths_within_both_serialized_budgets() {
    // A pinned Strata build on a system ROCm declares 189 library paths
    // (every alias of its library folder plus the loader-resolved nested
    // dependencies), past the earlier 64-path cap.
    let root = std::env::temp_dir()
        .join("aiolm-synthetic-adapter")
        .join("lib");
    let paths = |count: usize, width: usize| -> Vec<String> {
        (0..count)
            .map(|i| {
                root.join(format!("{}{i:03}.so", "l".repeat(width)))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    };
    let record = |manifest: RuntimeManifest| Registration {
        artifacts_sha256: manifest
            .artifacts
            .iter()
            .map(|path| (path.clone(), "c".repeat(64)))
            .collect(),
        manifest,
        executable_sha256: "a".repeat(64),
        probe_sha256: "b".repeat(64),
        probe: None,
        model_fingerprint: String::new(),
        launch_fingerprint: String::new(),
        error: None,
    };
    let mut manifest = example();
    manifest.artifacts = paths(256, 16);
    validate_manifest(&manifest).unwrap();
    record_bytes(&record(manifest.clone())).unwrap();
    manifest.artifacts = paths(257, 16);
    assert!(validate_manifest(&manifest)
        .unwrap_err()
        .contains("bounded absolute paths"));
    // The count never widens the manifest's serialized 256 KiB ...
    manifest.artifacts = paths(256, 1100);
    assert!(validate_manifest(&manifest)
        .unwrap_err()
        .contains("limited to 256 KiB"));
    // ... or the stored record, which repeats every path beside its hash.
    manifest.artifacts = paths(256, 700);
    validate_manifest(&manifest).unwrap();
    assert!(record_bytes(&record(manifest))
        .unwrap_err()
        .contains("limited to 256 KiB"));
}
#[test]
fn manifest_rejects_unsupported_versions_bindings_and_managed_overrides() {
    let good = example();
    validate_manifest(&good).unwrap();
    assert!(serde_json::to_value(&good)
        .unwrap()
        .get("launch_bindings")
        .is_none());
    let mut bad = good.clone();
    bad.adapter_version = 2;
    assert!(validate_manifest(&bad).unwrap_err().contains("version"));
    let mut bad = good.clone();
    bad.launch.args.push("{future_binding}".into());
    assert!(validate_manifest(&bad).unwrap_err().contains("binding"));
    let mut bad = good.clone();
    bad.options[0].flag = Some("--port".into());
    assert!(validate_manifest(&bad).unwrap_err().contains("app-owned"));
    let mut bad = good.clone();
    bad.launch.args.push("{api_key}".into());
    assert!(validate_manifest(&bad).unwrap_err().contains("credentials"));
    let mut bad = good.clone();
    bad.probe.args.clear();
    assert!(validate_manifest(&bad).unwrap_err().contains("selected"));
    let mut bad = good;
    bad.health_path = "//external.example/health".into();
    assert!(validate_manifest(&bad).is_err());
}
#[test]
fn manifest_options_cannot_replace_arbitrarily_named_template_bindings() {
    for args in [
        vec!["--weights", "{model}", "--listen", "{port}"],
        vec!["--weights={model}", "--listen={port}"],
    ] {
        for flag in ["--weights", "--listen"] {
            let mut manifest = example();
            manifest.launch.args = args.iter().map(|arg| (*arg).into()).collect();
            manifest.options[0].flag = Some(flag.into());
            let error = validate_manifest(&manifest)
                .expect_err("generic options must not replace the selected model or app port");
            assert!(error.contains("app-owned"), "{error}");
        }
    }
    // The binding names do not prevent unrelated options in the same engine.
    let mut manifest = example();
    manifest.launch.args = vec!["--weights={model}".into(), "--listen={port}".into()];
    validate_manifest(&manifest).unwrap();
}
#[test]
fn invalid_old_option_contracts_remain_visible_for_inventory_recovery() {
    let mut manifest = example();
    manifest.launch.args = vec!["--weights={model}".into(), "--listen={port}".into()];
    manifest.options[0].flag = Some("--weights".into());
    assert!(validate_manifest(&manifest).is_err());
    let record: Registration = serde_json::from_value(serde_json::json!({
        "manifest":manifest,"executable_sha256":"a".repeat(64),"probe_sha256":"b".repeat(64)
    }))
    .unwrap();
    let view = registration_for_inventory(record).unwrap();
    assert_eq!(view.manifest.engine_id, manifest.engine_id);
    assert_eq!(view.manifest.runtime_id, manifest.runtime_id);
    assert!(view.manifest.options.is_empty());
    assert!(view.error.as_ref().unwrap().contains("app-owned"));
    // A malformed launch contract is still rejected, not downgraded to
    // a runnable or supported registration by the inventory fallback.
    let mut invalid = view;
    invalid.manifest.launch.args.clear();
    assert_eq!(
        registration_for_inventory(invalid).err().unwrap().kind,
        crate::error::ErrorKind::Validation
    );
}
fn positional_draft() -> EntrypointDraft {
    let base = example();
    serde_json::from_value(serde_json::json!({
        "engine_id":base.engine_id,"runtime_id":"positional-1","display_name":"Positional engine",
        "program":base.launch.program,"prefix":["--server"],
        "model":{"kind":"positional"},"port":{"kind":"flag","flag":"--listen"},
        "auth":{"kind":"none"},"protocol":{"kind":"openai_http"},
        "probe":base.probe,"health_path":"/health","model_formats":["unknown"]
    }))
    .unwrap()
}

#[test]
fn explicit_positional_model_keeps_the_static_boolean_entry_prefix() {
    let draft = positional_draft();
    let manifest = manifest_from_draft(&draft).unwrap();
    for manifest in [
        manifest.clone(),
        serde_json::from_value(serde_json::to_value(&manifest).unwrap()).unwrap(),
    ] {
        assert_eq!(launch_prefix(&manifest), ["--server"]);
        let (flags, positional) = bound_launch_flags(&manifest);
        assert!(positional);
        assert_eq!(flags, [("--listen".into(), "port".into())]);
    }
}

#[test]
fn bridge_keeps_engine_argv_literal_and_requires_an_explicit_link() {
    let mut draft = positional_draft();
    let engine = draft.program.clone();
    draft.prefix = vec![
        "-m".into(),
        "synthetic.engine".into(),
        "한글 path ; &".into(),
        "".into(),
    ];
    let bridge = example().probe.program;
    draft.protocol = ServingProtocol::Bridge {
        program: bridge.clone(),
        prefix: vec!["--http".into()],
        engine_argv_env: None,
    };
    assert!(manifest_from_draft(&draft)
        .unwrap_err()
        .contains("explicitly receive"));
    draft.protocol = ServingProtocol::Bridge {
        program: bridge.clone(),
        prefix: vec!["--http".into()],
        engine_argv_env: Some("BRIDGE_ENGINE_ARGV".into()),
    };
    let manifest = manifest_from_draft(&draft).unwrap();
    assert_eq!(manifest.launch.program, bridge);
    assert_eq!(launch_prefix(&manifest), ["--http"]);
    let (name, json) = bridge_environment(&manifest).unwrap().unwrap();
    assert_eq!(name, "BRIDGE_ENGINE_ARGV");
    let expected = std::iter::once(engine)
        .chain(draft.prefix.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::from_str::<Vec<String>>(&json).unwrap(),
        expected
    );
    let request = super::super::runtime_schema::HelpRequest {
        encoding: None,
        locale: None,
        working_directory: None,
        program: None,
        args: vec!["--http".into(), "--help".into()],
        scope: vec![],
    };
    let help = super::super::runtime_schema::manifest_help_command(&manifest, &request).unwrap();
    assert_eq!(help.environment.get(&name), Some(&json));
    assert_eq!(help.args, request.args);
    assert!(manifest.artifacts.contains(&draft.program));

    let mut changed = manifest.clone();
    changed
        .bridge_command
        .as_mut()
        .unwrap()
        .argv
        .push("changed".into());
    assert_ne!(
        launch_fingerprint(&manifest, &AppConfig::default()),
        launch_fingerprint(&changed, &AppConfig::default())
    );
    for invalid in [
        "AIOLM_HOME",
        "aiolm_home",
        "LLAMA_BOARD_HOME",
        "llama_board_home",
        "bad-name",
        "",
    ] {
        let mut changed = manifest.clone();
        changed
            .bridge_command
            .as_mut()
            .unwrap()
            .environment_variable = invalid.into();
        assert!(validate_manifest(&changed).is_err());
    }
    for probe in [true, false] {
        let mut changed = manifest.clone();
        let env = if probe {
            &mut changed.probe.env
        } else {
            &mut changed.launch.env
        };
        env.insert("bridge_engine_argv".into(), "collision".into());
        assert!(validate_manifest(&changed).is_err());
    }
    let mut changed = manifest.clone();
    changed.bridge_command.as_mut().unwrap().version = 2;
    assert!(validate_manifest(&changed).is_err());
    let mut changed = manifest.clone();
    changed.bridge_command.as_mut().unwrap().argv[0] = "undeclared".into();
    assert!(validate_manifest(&changed).is_err());
    let mut changed = manifest;
    changed.bridge_command.as_mut().unwrap().argv[1] = "\0".into();
    assert!(validate_manifest(&changed).is_err());
    // Legacy direct manifests keep their old JSON contract.
    assert!(serde_json::to_value(example())
        .unwrap()
        .get("bridge_command")
        .is_none());
}

#[test]
fn explicit_binding_metadata_must_match_the_template_and_reprobes_on_changed_choices() {
    let manifest = manifest_from_draft(&positional_draft()).unwrap();
    let mut changed = manifest.clone();
    changed.launch_bindings.as_mut().unwrap().prefix_len = 0;
    assert!(validate_manifest(&changed)
        .unwrap_err()
        .contains("launch template"));
    let mut future = manifest.clone();
    future.launch_bindings.as_mut().unwrap().version = 2;
    assert!(validate_manifest(&future)
        .unwrap_err()
        .contains("metadata version"));
    let mut renamed = manifest.clone();
    renamed.launch_bindings.as_mut().unwrap().bindings[0].name = "guessed_model".into();
    assert!(validate_manifest(&renamed)
        .unwrap_err()
        .contains("binding name"));
    // The same argv can have two explicitly different meanings: static
    // boolean + positional, or a flag binding. Changing the choice must
    // invalidate readiness even though the executable/argv bytes match.
    let mut other_choice = manifest.clone();
    let bindings = other_choice.launch_bindings.as_mut().unwrap();
    bindings.prefix_len = 0;
    bindings.bindings[0].argument = ArgBinding::Flag {
        flag: "--server".into(),
        equals: false,
    };
    validate_manifest(&other_choice).unwrap();
    assert_eq!(manifest.launch.args, other_choice.launch.args);
    let mut duplicate = other_choice.clone();
    duplicate.launch_bindings.as_mut().unwrap().bindings[1].argument = ArgBinding::Flag {
        flag: "--server".into(),
        equals: false,
    };
    duplicate.launch.args[2] = "--server".into();
    assert!(validate_manifest(&duplicate)
        .unwrap_err()
        .contains("share a flag"));
    let mut oversized = manifest.clone();
    oversized.launch_bindings.as_mut().unwrap().prefix_len = 129;
    assert!(validate_manifest(&oversized)
        .unwrap_err()
        .contains("bounds"));
    let mut duplicate_name = manifest.clone();
    duplicate_name.launch_bindings.as_mut().unwrap().bindings[1].name = "model".into();
    assert!(validate_manifest(&duplicate_name)
        .unwrap_err()
        .contains("duplicate"));
    let cfg = AppConfig {
        active_provider: manifest.engine_id.as_str().into(),
        active_runtime: manifest.runtime_id.clone(),
        ..Default::default()
    };
    assert_ne!(
        launch_fingerprint(&manifest, &cfg),
        launch_fingerprint(&other_choice, &cfg)
    );
}
#[test]
fn external_ids_round_trip_without_promoting_unknown_engines_to_llama() {
    for name in ["custom.strata", "custom.my-engine", "custom.x"] {
        let id = ProviderId::parse(name).unwrap();
        assert!(id.is_custom());
        assert!(!id.is_python());
        assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{name}\""));
        assert_eq!(
            serde_json::from_str::<ProviderId>(&format!("\"{name}\"")).unwrap(),
            id
        );
        let cfg = AppConfig {
            active_provider: name.into(),
            active_runtime: "build-1".into(),
            ..Default::default()
        };
        assert_eq!(super::super::provider_of(&cfg), id);
    }
    for name in [
        "custom.",
        "custom...",
        "custom.X",
        "custom.a/../../",
        "unknown",
        "custom.한국어",
    ] {
        assert!(ProviderId::parse(name).is_none());
    }
}
#[test]
fn manifest_numeric_constraints_reach_validation_and_argument_resolution() {
    let mut manifest = example();
    manifest.options[0].kind = serde_json::json!({
        "type": "number", "min": 0, "max": 1, "min_exclusive": true, "max_exclusive": true,
    });
    validate_manifest(&manifest).unwrap();
    let source = super::super::runtime_schema::adapter_source("custom.example", "test");
    let definition =
        super::super::runtime_schema::from_external(&manifest.options[0], &source).unwrap();
    for value in [0.00000001, 0.5] {
        let values = serde_json::json!({"workers": value})
            .as_object()
            .unwrap()
            .clone();
        assert!(option_issues(&manifest, &values).is_empty());
        assert!(definition
            .resolve_one(&None, &[serde_json::json!(value)])
            .is_ok());
    }
    for value in [0.0, 1.0] {
        let values = serde_json::json!({"workers": value})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(option_issues(&manifest, &values).len(), 1);
        assert!(definition
            .resolve_one(&None, &[serde_json::json!(value)])
            .is_err());
    }
    manifest.options[0].kind =
        serde_json::json!({"type": "integer", "min": 1, "max": 8, "choices": [1, 8]});
    validate_manifest(&manifest).unwrap();
    let definition =
        super::super::runtime_schema::from_external(&manifest.options[0], &source).unwrap();
    assert!(definition
        .resolve_one(&None, &[serde_json::json!(8)])
        .is_ok());
    assert!(definition
        .resolve_one(&None, &[serde_json::json!(2)])
        .is_err());
    assert_eq!(
        option_issues(
            &manifest,
            serde_json::json!({"workers":2}).as_object().unwrap()
        )
        .len(),
        1
    );
    manifest.options[0].kind["min_exclusive"] = serde_json::json!("true");
    assert!(validate_manifest(&manifest).is_err());
    manifest.options[0].kind =
        serde_json::json!({"type": "integer", "min": 1, "max": 8, "sentinel_values": [-1]});
    validate_manifest(&manifest).unwrap();
    let definition =
        super::super::runtime_schema::from_external(&manifest.options[0], &source).unwrap();
    for value in [-1, 1] {
        let values = serde_json::json!({"workers":value})
            .as_object()
            .unwrap()
            .clone();
        assert!(option_issues(&manifest, &values).is_empty());
        assert!(definition
            .resolve_one(&None, &[serde_json::json!(value)])
            .is_ok());
    }
    assert_eq!(
        option_issues(
            &manifest,
            serde_json::json!({"workers":0}).as_object().unwrap()
        )
        .len(),
        1
    );
    assert!(definition
        .resolve_one(&None, &[serde_json::json!(0)])
        .is_err());
    manifest.options[0].kind["sentinel_values"] = serde_json::json!([-1.5]);
    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn options_validate_types_ranges_and_request_changes_keep_launch_identity() {
    let manifest = example();
    for value in [
        serde_json::json!(true),
        serde_json::json!(0),
        serde_json::json!(9),
        serde_json::json!("2"),
    ] {
        assert_eq!(
            option_issues(
                &manifest,
                &serde_json::json!({"workers":value})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .len(),
            1
        );
    }
    let cfg = AppConfig {
        active_provider: "custom.example".into(),
        provider_options: BTreeMap::from([(
            "custom.example".into(),
            serde_json::json!({"workers":2,"temperature":0.5})
                .as_object()
                .unwrap()
                .clone(),
        )]),
        ..Default::default()
    };
    let mut request_changed = cfg.clone();
    request_changed
        .provider_options
        .get_mut("custom.example")
        .unwrap()
        .insert("temperature".into(), serde_json::json!(1.0));
    assert_eq!(
        launch_fingerprint(&manifest, &cfg),
        launch_fingerprint(&manifest, &request_changed)
    );
    let mut raw_changed = cfg.clone();
    raw_changed
        .provider_options
        .get_mut("custom.example")
        .unwrap()
        .insert(
            "extra_args".into(),
            serde_json::json!(["--undocumented-cache", "small"]),
        );
    assert_ne!(
        launch_fingerprint(&manifest, &cfg),
        launch_fingerprint(&manifest, &raw_changed)
    );
    request_changed
        .provider_options
        .get_mut("custom.example")
        .unwrap()
        .insert("workers".into(), serde_json::json!(3));
    assert_ne!(
        launch_fingerprint(&manifest, &cfg),
        launch_fingerprint(&manifest, &request_changed)
    );
    assert_eq!(
        expand(
            "--model={model}",
            &AppConfig {
                active_model: "/synthetic/model with spaces".into(),
                ..Default::default()
            },
            123,
            "private",
            "served"
        )
        .unwrap(),
        "--model=/synthetic/model with spaces"
    );

    // Literal output includes every saved value; provider lookup stays raw.
    const ENCODED: &str = r#"{"array":[null,true,false,-7,1.25,-0.0],"nested":{"escaped":"\"\\\n","unicode":"한글🙂"},"scalar":7}"#;
    let raw_provider = " custom.example ";
    let mut cfg = AppConfig {
        active_provider: raw_provider.into(),
        provider_options: BTreeMap::from([(
            "custom.example".into(),
            serde_json::from_value(serde_json::json!({"wrong":true})).unwrap(),
        )]),
        ..Default::default()
    };
    for (saved, encoded) in [
        (None, "{}"),
        (Some(Map::new()), "{}"),
        (Some(serde_json::from_str(ENCODED).unwrap()), ENCODED),
    ] {
        cfg.provider_options.remove(raw_provider);
        if let Some(saved) = saved {
            cfg.provider_options.insert(raw_provider.into(), saved);
        }
        let before = serde_json::to_value(&cfg).unwrap();
        let output = expand(
            "before={options_json};again={options_json}",
            &cfg,
            123,
            "private",
            "served",
        )
        .unwrap();
        let expected = format!("before={encoded};again={encoded}");
        assert_eq!(output, expected);
        assert_eq!(serde_json::to_value(&cfg).unwrap(), before);
        cfg.provider_options.remove(raw_provider);
        assert_eq!(
            expand("{options_json}", &cfg, 123, "private", "served").unwrap(),
            "{}"
        );
        assert_eq!(output, expected);
    }
}
#[test]
fn launch_template_defines_entry_prefix_and_app_owned_bindings() {
    let mut manifest = example();
    manifest.launch.args = vec![
        "C:/synthetic/server script.py".into(),
        "serve".into(),
        "--model".into(),
        "{model}".into(),
        "--listen={host}".into(),
        "-p".into(),
        "{port}".into(),
        "{model_alias}".into(),
    ];
    assert_eq!(
        launch_prefix(&manifest),
        vec!["C:/synthetic/server script.py".to_string(), "serve".into()]
    );
    let (flags, positional) = bound_launch_flags(&manifest);
    assert_eq!(
        flags,
        vec![
            ("--model".to_string(), "model".to_string()),
            ("--listen".into(), "host".into()),
            ("-p".into(), "port".into())
        ]
    );
    assert!(positional);
    // Interpreter flags, a module or script and static options before the
    // first binding stay part of the exact entry prefix.
    manifest.launch.args = vec![
        "-I".into(),
        "-u".into(),
        "C:/synthetic/한글 dir/serve.py".into(),
        "--static".into(),
        "--model".into(),
        "{model}".into(),
    ];
    assert_eq!(
        launch_prefix(&manifest),
        ["-I", "-u", "C:/synthetic/한글 dir/serve.py", "--static"]
    );
    manifest.launch.args = vec!["-m".into(), "synthetic.server".into(), "{model}".into()];
    assert_eq!(launch_prefix(&manifest), ["-m", "synthetic.server"]);
    manifest.launch.args = vec!["--model={model}".into()];
    assert!(launch_prefix(&manifest).is_empty());
}

#[test]
fn catalog_reuses_one_inventory_without_changing_host_recovery_order_or_freshness() {
    const CHILD: &str = "AIOLM_REGISTRY_CATALOG_FIXTURE";
    const FILTER: &str = "providers::registry::tests::catalog_reuses_one_inventory_without_changing_host_recovery_order_or_freshness";
    const OWNER: &str = ".catalog-fixture-owner";
    if std::env::var_os(CHILD).is_none() {
        let original_home = std::env::var_os("AIOLM_HOME");
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let area = base.join(format!("aiolm-registry-catalog-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&area).unwrap();
        let area = fs::canonicalize(area).unwrap();
        assert_eq!(area.parent(), Some(base.as_path()));
        struct Cleanup {
            area: PathBuf,
            base: PathBuf,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let Ok(area) = fs::canonicalize(&self.area) else {
                    return;
                };
                let Ok(base) = fs::canonicalize(&self.base) else {
                    return;
                };
                if area == self.area
                    && base == self.base
                    && area.parent() == Some(base.as_path())
                    && fs::read(area.join(OWNER))
                        .is_ok_and(|bytes| bytes == b"synthetic catalog fixture")
                {
                    let _ = fs::remove_dir_all(area);
                }
            }
        }
        fs::write(area.join(OWNER), b"synthetic catalog fixture").unwrap();
        let _cleanup = Cleanup {
            area: area.clone(),
            base,
        };
        let mut command = crate::procutil::std_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", FILTER, "--nocapture", "--test-threads=1"])
            .env(CHILD, &area)
            .env("AIOLM_HOME", &area);
        let output = crate::procutil::capture_output_cancellable(
            &mut command,
            Duration::from_secs(30),
            256 * 1024,
            None,
        )
        .unwrap();
        assert_eq!(std::env::var_os("AIOLM_HOME"), original_home);
        print!("{}", String::from_utf8_lossy(&output.stdout));
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        assert!(output.status.success(), "isolated catalog fixture failed");
        assert!(String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("test result: ok. 1 passed; 0 failed;")));
        return;
    }

    let area = PathBuf::from(std::env::var_os("AIOLM_HOME").unwrap());
    assert!(area.is_absolute());
    assert!(area
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("aiolm-registry-catalog-"));
    assert_eq!(PathBuf::from(std::env::var_os(CHILD).unwrap()), area);
    assert_eq!(
        fs::read(area.join(OWNER)).unwrap(),
        b"synthetic catalog fixture"
    );

    fn record(
        area: &Path,
        engine: &str,
        runtime: usize,
        os: &str,
        recovered: bool,
    ) -> Registration {
        let mut manifest = example();
        manifest.engine_id = ProviderId::parse(engine).unwrap();
        manifest.runtime_id = format!("build-{runtime}");
        manifest.display_name = format!("Synthetic {engine} {runtime}");
        manifest.probe.program = area.join("unused-probe").to_string_lossy().into_owned();
        manifest.launch.program = area.join("unused-server").to_string_lossy().into_owned();
        manifest.platforms = vec![Platform {
            os: os.into(),
            arch: std::env::consts::ARCH.into(),
        }];
        if recovered {
            manifest.options[0].flag = Some("--port".into());
            assert!(validate_manifest(&manifest)
                .unwrap_err()
                .contains("app-owned"));
        } else {
            validate_manifest(&manifest).unwrap();
        }
        Registration {
            manifest,
            executable_sha256: "a".repeat(64),
            probe_sha256: "b".repeat(64),
            artifacts_sha256: BTreeMap::new(),
            probe: None,
            model_fingerprint: String::new(),
            launch_fingerprint: String::new(),
            error: None,
        }
    }

    fn expected_row(record: &Registration, supported: bool, recovered: bool) -> Value {
        let availability = if supported {
            serde_json::json!({"supported":true,"detail":""})
        } else {
            serde_json::json!({"supported":false,"reason":"external-runtime-unavailable",
                "detail":"Register this external engine for the current OS/architecture before running it. Saved selections remain preserved."})
        };
        let options = if recovered {
            vec![]
        } else {
            record.manifest.options.clone()
        };
        serde_json::json!({"id":record.manifest.engine_id,
            "engine":record.manifest.display_name,"server":"openai-v1",
            "availability":availability,"options":options,"managed_version":null,
            "kind":"external-process","capabilities":{"benchmark":"unsupported",
                "deep_verification":"unsupported","portable":"unsupported"}})
    }

    fn stored_bytes(records: &[Registration]) -> Vec<(PathBuf, Vec<u8>)> {
        records
            .iter()
            .map(|record| {
                let path = path(record.manifest.engine_id, &record.manifest.runtime_id).unwrap();
                let bytes = fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect()
    }

    fn measure(expected: &[Value], label: &str) -> (usize, usize) {
        REGISTRY_INVENTORY_COUNTS.with(|counts| {
            assert!(counts.replace(Some((0, 0))).is_none());
        });
        let started = std::time::Instant::now();
        let actual = catalog();
        let elapsed = started.elapsed();
        let counts = REGISTRY_INVENTORY_COUNTS.with(|counts| counts.replace(None).unwrap());
        let output = serde_json::to_string(&actual).unwrap();
        eprintln!(
            "CATALOG_FIXTURE {label} scans={} records={} elapsed_us={} rows={} sha256={:x} output={output}",
            counts.0,
            counts.1,
            elapsed.as_micros(),
            actual.len(),
            Sha256::digest(output.as_bytes())
        );
        assert_eq!(actual.as_slice(), expected);
        counts
    }

    let foreign_os = if std::env::consts::OS == "linux" {
        "windows"
    } else {
        "linux"
    };
    let cases = [
        ("custom.a-mixed", true, false),
        ("custom.b-unavailable", false, false),
        ("custom.c-recovery", true, true),
        ("custom.d", true, false),
        ("custom.e", true, false),
        ("custom.f", true, false),
        ("custom.g", true, false),
        ("custom.h-last", true, false),
    ];
    let mut records = Vec::new();
    // Opposite creation order makes the public sorted first-runtime choice observable.
    for &(engine, supported, recovered) in cases.iter().rev() {
        for runtime in (0..4).rev() {
            let os = if !supported || (engine == "custom.a-mixed" && runtime == 0) {
                foreign_os
            } else {
                std::env::consts::OS
            };
            let record = record(&area, engine, runtime, os, recovered && runtime == 0);
            save(&record).unwrap();
            records.push(record);
        }
    }
    let before = stored_bytes(&records);
    let mut expected = cases
        .iter()
        .map(|&(engine, supported, recovered)| {
            let record = records
                .iter()
                .find(|record| {
                    record.manifest.engine_id.as_str() == engine
                        && record.manifest.runtime_id == "build-0"
                })
                .unwrap();
            expected_row(record, supported, recovered)
        })
        .collect::<Vec<_>>();
    let mut samples = Vec::new();
    for label in ["initial-1", "initial-2", "initial-3"] {
        samples.push(measure(&expected, label));
    }
    for (path, bytes) in before {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    for record in records
        .iter()
        .filter(|record| record.manifest.engine_id.as_str() == "custom.h-last")
    {
        remove(record.manifest.engine_id, &record.manifest.runtime_id).unwrap();
    }
    records.retain(|record| record.manifest.engine_id.as_str() != "custom.h-last");
    expected.retain(|row| row["id"] != "custom.h-last");
    let changed = records
        .iter_mut()
        .find(|record| {
            record.manifest.engine_id.as_str() == "custom.b-unavailable"
                && record.manifest.runtime_id == "build-3"
        })
        .unwrap();
    changed.manifest.platforms[0].os = std::env::consts::OS.into();
    save(changed).unwrap();
    expected[1]["availability"] = serde_json::json!({"supported":true,"detail":""});
    for runtime in (0..4).rev() {
        let added = record(
            &area,
            "custom.z-fresh",
            runtime,
            std::env::consts::OS,
            false,
        );
        if runtime == 0 {
            expected.push(expected_row(&added, true, false));
        }
        save(&added).unwrap();
        records.push(added);
    }
    let before_fresh = stored_bytes(&records);
    samples.push(measure(&expected, "after-add-remove-platform-change"));
    for (path, bytes) in before_fresh {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    for (scans, records) in samples {
        assert_eq!(scans, 1, "one catalog request must reuse its inventory");
        assert_eq!(records, 32, "each captured registration is read once");
    }
}
