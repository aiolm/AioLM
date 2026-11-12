use super::*;
use crate::providers::python_env::ProbeRecord;
use serde_json::json;
use std::collections::BTreeSet;

fn metal_runtime() -> PythonRuntimeManifest {
    let mut runtime = runtime(ProviderId::Vllm);
    let probe = runtime.probe.as_mut().unwrap();
    probe.variant = "vllm-metal".into();
    probe.metal_version = "0.30.0".into();
    probe.version = "0.30.0+cpu".into();
    probe.metal_gguf = true;
    runtime
}

fn metal_snapshot(dir: &Path, model_type: &str, architecture: &str, extra: Value) {
    let mut config =
        json!({"model_type":model_type,"architectures":[architecture],"vocab_size":32});
    for (key, value) in extra.as_object().unwrap() {
        config[key] = value.clone();
    }
    write(dir, "config.json", config.to_string().as_bytes());
    write(dir, "model.safetensors", b"synthetic");
    write(dir, "tokenizer.json", b"{}");
    write(
        dir,
        "tokenizer_config.json",
        br#"{"chat_template":"synthetic"}"#,
    );
}

#[test]
fn metal_schema_filters_semantically_unsupported_flags_and_preserves_linux() {
    let mut runtime = metal_runtime();
    let schema = option_schema(&runtime);
    assert!(!schema
        .iter()
        .any(|s| METAL_UNSUPPORTED_KEYS.contains(&s.key)));
    let kv = schema.iter().find(|s| s.key == "kv_cache_dtype").unwrap();
    assert_eq!(
        kv.kind,
        options::OptionKind::Choice {
            choices: METAL_KV_DTYPES
        }
    );
    let saved = json!({"cpu_offload_gb":1,"tensor_parallel_size":2,"kv_cache_dtype":"fp8"});
    let issues = runtime_option_issues(&runtime, saved.as_object().unwrap());
    for key in ["cpu_offload_gb", "tensor_parallel_size", "kv_cache_dtype"] {
        assert!(issues
            .iter()
            .any(|issue| issue.key == key && issue.code == "variant"));
    }
    runtime.probe.as_mut().unwrap().server_flags = vec!["--max-model-len".into()];
    let schema = option_schema(&runtime);
    assert!(schema.iter().any(|s| s.key == "max_model_len"));
    assert!(!schema.iter().any(|s| s.key == "dtype"));
    let linux = self::runtime(ProviderId::Vllm);
    assert!(option_schema(&linux)
        .iter()
        .any(|s| s.key == "cpu_offload_gb"));
}

#[test]
fn metal_raw_options_cannot_select_a_loader_backend_or_companion() {
    let runtime = metal_runtime();
    for args in [
        json!(["--device", "cuda"]),
        json!(["--model-impl", "transformers"]),
        json!(["--tokenizer", "remote/model"]),
        json!(["--hf-config-path=x"]),
        json!(["--additional-config", "{}"]),
        json!(["--distributed-executor-backend=ray"]),
        json!(["--pooler-config", "{\"task\":\"classify\"}"]),
        json!(["--disable-log-stats=true"]),
        json!(["--worker-cls", "x"]),
    ] {
        let options = json!({"extra_args":args});
        assert!(
            runtime_option_issues(&runtime, options.as_object().unwrap())
                .iter()
                .any(|issue| issue.code == "variant")
        );
    }
    let options = json!({"extra_args":["--disable_log_stats","--no-async-scheduling"]});
    assert!(runtime_option_issues(&runtime, options.as_object().unwrap()).is_empty());
    for saved in [
        json!({"kv_cache_dtype":"bfloat16","dtype":"half"}),
        json!({"limit_mm_per_prompt":{"audio":1}}),
        json!({"speculative_config":{"method":"eagle","num_speculative_tokens":3}}),
    ] {
        assert!(!runtime_option_issues(&runtime, saved.as_object().unwrap()).is_empty());
    }
}

#[test]
fn metal_launch_accepts_complete_hf_and_mlx_text_with_app_owned_environment() {
    let dir = temp_dir("metal-text");
    let runtime = metal_runtime();
    for extra in [
        json!({}),
        json!({"quantization":{"bits":4,"group_size":64}}),
    ] {
        metal_snapshot(&dir, "qwen3", "Qwen3ForCausalLM", extra);
        let mut cfg = config(ProviderId::Vllm, json!({"max_model_len":128}));
        cfg.active_model = dir.to_string_lossy().into_owned();
        let command = engine_command(&cfg, &runtime, 2, "secret").unwrap();
        let plugin_names = command
            .env
            .iter()
            .find(|(key, _)| key == "VLLM_PLUGINS")
            .expect("Metal needs an explicit plugin allowlist")
            .1
            .to_str()
            .expect("plugin entry-point names are UTF-8")
            .split(',')
            .collect::<Vec<_>>();
        // Platform discovery and general model loaders use the same
        // allowlist; the isolated launch must permit both entry points.
        assert!(plugin_names.contains(&"metal"));
        assert!(plugin_names.contains(&"gguf_metal"));
        assert!(command.env.contains(&("HF_HUB_OFFLINE".into(), "1".into())));
        assert!(command
            .env
            .contains(&("VLLM_METAL_MULTIMODAL_MODE".into(), "auto".into())));
        assert!(!command.args.iter().any(|arg| arg.contains("secret")));
    }
    std::fs::remove_file(dir.join("model.safetensors")).unwrap();
    let mut cfg = config(ProviderId::Vllm, json!({}));
    cfg.active_model = dir.to_string_lossy().into_owned();
    assert!(engine_command(&cfg, &runtime, 2, "").is_err());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn metal_pooling_and_lora_bindings_are_checked_before_launch() {
    let dir = temp_dir("metal-bindings");
    let adapter = dir.join("adapter");
    std::fs::create_dir(&adapter).unwrap();
    write(
        &adapter,
        "adapter_config.json",
        br#"{"r":8,"lora_alpha":16,"target_modules":["q_proj"],"bias":"none"}"#,
    );
    write(&adapter, "adapter_model.safetensors", b"synthetic");
    metal_snapshot(&dir, "qwen3", "Qwen3ForCausalLM", json!({}));
    let runtime = metal_runtime();
    let lora = json!({"lora_adapters":[{"name":"style","path":adapter.to_string_lossy()}],"request_lora":"style"});
    let mut cfg = config(ProviderId::Vllm, lora.clone());
    cfg.active_model = dir.to_string_lossy().into_owned();
    assert!(engine_command(&cfg, &runtime, 2, "")
        .unwrap()
        .args
        .contains(&"--enable-lora".into()));
    cfg.provider_options
        .get_mut("vllm")
        .unwrap()
        .insert("runner".into(), json!("pooling"));
    assert!(engine_command(&cfg, &runtime, 2, "")
        .unwrap_err()
        .contains("LoRA"));
    cfg.provider_options.insert(
        "vllm".into(),
        json!({"runner":"pooling"}).as_object().unwrap().clone(),
    );
    assert!(engine_command(&cfg, &runtime, 2, "").is_ok());
    metal_snapshot(&dir, "llama", "LlamaForCausalLM", json!({}));
    assert!(engine_command(&cfg, &runtime, 2, "")
        .unwrap_err()
        .contains("pooling"));
    cfg.provider_options
        .insert("vllm".into(), lora.as_object().unwrap().clone());
    cfg.provider_options.get_mut("vllm").unwrap().insert(
        "speculative_config".into(),
        json!({"method":"ngram","num_speculative_tokens":3}),
    );
    assert!(engine_command(&cfg, &runtime, 2, "")
        .unwrap_err()
        .contains("LoRA"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn metal_speculation_requires_local_matching_vocab_and_full_attention_draft() {
    let dir = temp_dir("metal-spec");
    let draft = dir.join("draft");
    std::fs::create_dir(&draft).unwrap();
    metal_snapshot(&dir, "qwen3", "Qwen3ForCausalLM", json!({}));
    metal_snapshot(&draft, "qwen3", "Qwen3ForCausalLM", json!({}));
    let runtime = metal_runtime();
    let mut cfg = config(
        ProviderId::Vllm,
        json!({"speculative_config":{"method":"draft_model","model":draft.to_string_lossy(),"num_speculative_tokens":3}}),
    );
    let model_arg = dir.to_string_lossy().into_owned();
    let draft_arg = draft.to_string_lossy().into_owned();
    cfg.active_model = model_arg.clone();
    let unordered = engine_command(&cfg, &runtime, 2, "").unwrap();
    assert!(unordered.args.contains(&"--no-async-scheduling".into()));
    cfg.provider_options.get_mut("vllm").unwrap().insert(
        "@option_order".into(),
        json!({"version":1,"occurrences":[{"key":"speculative_config"}]}),
    );
    let command = engine_command(&cfg, &runtime, 2, "").unwrap();
    let served = served_model_name(&model_arg);
    let speculative = json!({
        "method": "draft_model",
        "model": draft_arg,
        "num_speculative_tokens": 3
    })
    .to_string();
    assert_eq!(command.program, PathBuf::from(&runtime.python));
    assert_eq!(
        command.args,
        vec![
            "-I".into(),
            "-m".into(),
            "vllm.entrypoints.cli.main".into(),
            "serve".into(),
            model_arg,
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            "2".into(),
            "--served-model-name".into(),
            served.clone(),
            "--no-async-scheduling".into(),
            "--speculative-config".into(),
            speculative,
        ]
    );
    assert_eq!(
        command.env,
        vec![
            ("VLLM_PLUGINS".into(), "metal,gguf_metal".into()),
            ("VLLM_MLX_DEVICE".into(), "gpu".into()),
            ("VLLM_METAL_MULTIMODAL_MODE".into(), "auto".into()),
            ("VLLM_USE_V2_MODEL_RUNNER".into(), "0".into()),
            ("HF_HUB_OFFLINE".into(), "1".into()),
            ("TRANSFORMERS_OFFLINE".into(), "1".into()),
        ]
    );
    assert_eq!(command.working_directory, None);
    assert_eq!(command.upstream_model, served.clone());
    assert_eq!(
        command.readiness,
        Readiness {
            health_path: "/health".into(),
            health_authenticated: false,
            expected_model: served,
            expected_model_aliases: Vec::new(),
        }
    );
    metal_snapshot(
        &draft,
        "qwen3",
        "Qwen3ForCausalLM",
        json!({"vocab_size":64}),
    );
    assert!(engine_command(&cfg, &runtime, 2, "")
        .unwrap_err()
        .contains("vocab_size"));
    metal_snapshot(
        &draft,
        "qwen3",
        "Qwen3ForCausalLM",
        json!({"sliding_window":128}),
    );
    assert!(engine_command(&cfg, &runtime, 2, "")
        .unwrap_err()
        .contains("full-attention"));
    cfg.provider_options.insert(
        "vllm".into(),
        json!({"speculative_config":{"method":"ngram","num_speculative_tokens":3}})
            .as_object()
            .unwrap()
            .clone(),
    );
    assert!(engine_command(&cfg, &runtime, 2, "").is_ok());
    metal_snapshot(&dir, "qwen3_next", "Qwen3NextForCausalLM", json!({}));
    assert!(engine_command(&cfg, &runtime, 2, "")
        .unwrap_err()
        .contains("non-hybrid"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn metal_local_gguf_launch_owns_matching_companion_arguments() {
    use crate::gguf::fixture::{file, Value as GgufValue};
    let dir = temp_dir("metal-gguf-command");
    let path = dir.join("weights.gguf");
    write(
        &dir,
        "config.json",
        br#"{"model_type":"qwen3","architectures":["Qwen3ForCausalLM"]}"#,
    );
    write(&dir, "tokenizer.json", b"{}");
    let bytes = file(
        &[("general.architecture".into(), GgufValue::Str("qwen3"))],
        &[
            ("token_embd.weight".into(), vec![32, 32], 4096),
            ("output_norm.weight".into(), vec![32], 128),
            ("blk.0.attn_q.weight".into(), vec![32, 32], 4096),
        ],
    );
    write(&dir, "weights.gguf", &bytes);
    let mut cfg = config(ProviderId::Vllm, json!({}));
    cfg.active_model = path.to_string_lossy().into_owned();
    let runtime = metal_runtime();
    let command = engine_command(&cfg, &runtime, 2, "").unwrap();
    for flag in ["--tokenizer", "--hf-config-path"] {
        let index = command.args.iter().position(|arg| arg == flag).unwrap();
        assert_eq!(command.args[index + 1], dir.to_string_lossy());
    }
    let mut missing_extra = runtime.clone();
    missing_extra.probe.as_mut().unwrap().metal_gguf = false;
    assert!(engine_command(&cfg, &missing_extra, 2, "")
        .unwrap_err()
        .contains("gguf>=0.17.0"));
    std::fs::remove_dir_all(dir).unwrap();
}

fn runtime(provider: ProviderId) -> PythonRuntimeManifest {
    PythonRuntimeManifest {
        format: 1,
        provider,
        id: "managed-x".into(),
        kind: InstallationKind::Managed,
        python: "/opt/aiolm/venv/bin/python".into(),
        requested_version: None,
        probe: Some(ProbeRecord {
            version: "1".into(),
            ..Default::default()
        }),
    }
}

fn config(provider: ProviderId, options: Value) -> AppConfig {
    let mut cfg = AppConfig {
        active_provider: provider.as_str().into(),
        active_runtime: "managed-x".into(),
        active_model: "/models/Qwen2.5-VL-7B".into(),
        ..Default::default()
    };
    cfg.provider_options.insert(
        provider.as_str().into(),
        options.as_object().unwrap().clone(),
    );
    cfg
}

#[test]
fn saved_option_order_reaches_python_engine_argv_without_duplicates() {
    let order = json!({"version": 1, "occurrences": [
        {"key": "enable_prefix_caching"}, {"key": "max_model_len"}
    ]});
    let cfg = config(
        ProviderId::Vllm,
        json!({"max_model_len": 8192, "enable_prefix_caching": false, "temperature": 0.3,
            "@option_order": order}),
    );
    let command = engine_command(&cfg, &runtime(ProviderId::Vllm), 41000, "").unwrap();
    assert!(
        command.args.ends_with(&[
            "Qwen2.5-VL-7B".into(),
            "--no-enable-prefix-caching".into(),
            "--max-model-len".into(),
            "8192".into(),
        ]),
        "{:?}",
        command.args
    );
    assert_eq!(
        command
            .args
            .iter()
            .filter(|arg| *arg == "--max-model-len")
            .count(),
        1
    );
    // Without the record the same values keep their catalog order.
    let mut plain = cfg.clone();
    plain
        .provider_options
        .get_mut("vllm")
        .unwrap()
        .remove("@option_order");
    assert!(
        engine_command(&plain, &runtime(ProviderId::Vllm), 41000, "")
            .unwrap()
            .args
            .ends_with(&[
                "--max-model-len".into(),
                "8192".into(),
                "--no-enable-prefix-caching".into(),
            ])
    );
    // A record from a newer app blocks the launch; values stay saved.
    let mut future = cfg.clone();
    future.provider_options.get_mut("vllm").unwrap()["@option_order"]["version"] = json!(2);
    let error = engine_command(&future, &runtime(ProviderId::Vllm), 41000, "").unwrap_err();
    assert!(error.contains("version 2"), "{error}");
    assert_eq!(
        future.provider_options["vllm"]["max_model_len"],
        json!(8192)
    );
}

#[test]
fn vllm_command_owns_identity_network_and_credentials() {
    let cfg = config(
        ProviderId::Vllm,
        json!({"max_model_len": 8192, "enable_prefix_caching": false, "temperature": 0.3}),
    );
    let runtime = runtime(ProviderId::Vllm);
    let saved_cfg = serde_json::to_vec(&cfg).unwrap();
    let saved_runtime = serde_json::to_vec(&runtime).unwrap();
    let command = engine_command(&cfg, &runtime, 41000, "secret").unwrap();
    assert_eq!(
        command,
        EngineCommand {
            program: PathBuf::from(&runtime.python),
            args: [
                "-I",
                "-m",
                "vllm.entrypoints.cli.main",
                "serve",
                "/models/Qwen2.5-VL-7B",
                "--host",
                "127.0.0.1",
                "--port",
                "41000",
                "--served-model-name",
                "Qwen2.5-VL-7B",
                "--max-model-len",
                "8192",
                "--no-enable-prefix-caching",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            env: vec![("VLLM_API_KEY".into(), "secret".into())],
            working_directory: None,
            upstream_model: "Qwen2.5-VL-7B".into(),
            readiness: Readiness {
                health_path: "/health".into(),
                health_authenticated: false,
                expected_model: "Qwen2.5-VL-7B".into(),
                expected_model_aliases: Vec::new(),
            },
        }
    );
    assert!(!command.args.iter().any(|arg| arg.contains("secret")));
    assert_eq!(serde_json::to_vec(&cfg).unwrap(), saved_cfg);
    assert_eq!(serde_json::to_vec(&runtime).unwrap(), saved_runtime);
}

#[test]
fn mlx_command_preloads_the_exact_model_path_and_reads_the_key_from_env() {
    let cfg = config(
        ProviderId::MlxVlm,
        json!({"kv_bits": 4, "enable_thinking": true}),
    );
    let command = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 41001, "k").unwrap();
    assert_eq!(
        &command.args[..9],
        &[
            "-I",
            "-m",
            "mlx_vlm.server",
            "--host",
            "127.0.0.1",
            "--port",
            "41001",
            "--model",
            "/models/Qwen2.5-VL-7B",
        ]
    );
    assert!(command
        .args
        .ends_with(&["--kv-bits".into(), "4".into(), "--enable-thinking".into()]));
    assert_eq!(
        command.env,
        vec![("MLX_VLM_SERVER_API_KEY".into(), "k".into())]
    );
    assert_eq!(command.upstream_model, "/models/Qwen2.5-VL-7B");
    assert!(command.readiness.health_authenticated);
}

#[test]
fn mlx_kv_budget_is_available_during_server_import_and_matches_the_cli() {
    let cfg = config(ProviderId::MlxVlm, json!({"max_kv_size": 256}));
    let command = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 41001, "").unwrap();
    assert!(command
        .args
        .windows(2)
        .any(|pair| pair == ["--max-kv-size", "256"]));
    assert_eq!(command.env, vec![("MAX_KV_SIZE".into(), "256".into())]);

    let cfg = config(ProviderId::MlxVlm, json!({}));
    let command = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 41001, "").unwrap();
    assert!(command.env.is_empty());
    assert!(!command.args.iter().any(|arg| arg == "--max-kv-size"));
}

#[test]
fn invalid_or_foreign_options_block_the_launch() {
    let cfg = config(ProviderId::Vllm, json!({"ctx_size": 4096}));
    let error = engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "").unwrap_err();
    assert!(error.contains("ctx_size"));
    let cfg = config(
        ProviderId::MlxVlm,
        json!({"lora_adapters": [{"name":"a","path":"/x"},{"name":"b","path":"/y"}]}),
    );
    let issues = option_issues(
        ProviderId::MlxVlm,
        &provider_options(&cfg, ProviderId::MlxVlm),
    );
    assert_eq!(
        serde_json::to_value(&issues).unwrap(),
        json!([{
            "key": "lora_adapters",
            "code": "binding",
            "message": "mlx-vlm loads one adapter per server (--adapter-path)"
        }])
    );
    let cfg = config(
        ProviderId::Vllm,
        json!({"draft_model": "/d", "request_lora": "missing"}),
    );
    let issues = option_issues(ProviderId::Vllm, &provider_options(&cfg, ProviderId::Vllm));
    assert_eq!(
        serde_json::to_value(&issues).unwrap(),
        json!([
            {"key": "request_lora", "code": "binding", "message": "the request adapter must name a configured adapter"},
            {"key": "draft_model", "code": "binding", "message": "vLLM configures draft models through speculative_config"}
        ])
    );

    let mixed = json!({
        "aaa_unknown": {"nested": ["한글", false, null]},
        "draft_model": "/synthetic/draft",
        "dtype": "fp4",
        "enable_auto_tool_choice": true,
        "lora_adapters": [{"name": "style", "path": "/synthetic/adapter"}],
        "max_lora_rank": 24,
        "max_model_len": "big",
        "request_lora": "missing",
        "trust_remote_code": true,
        "zzz_unknown": false
    });
    let values = mixed.as_object().unwrap();
    let saved_values = serde_json::to_vec(&mixed).unwrap();
    let expected = [
        ("aaa_unknown", "unknown"),
        ("dtype", "choice"),
        ("max_lora_rank", "choice"),
        ("max_model_len", "type"),
        ("trust_remote_code", "managed"),
        ("zzz_unknown", "unknown"),
        ("request_lora", "binding"),
        ("draft_model", "binding"),
        ("enable_auto_tool_choice", "binding"),
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let standard = runtime(ProviderId::Vllm);
    for issues in [
        option_issues(ProviderId::Vllm, values),
        runtime_option_issues(&standard, values),
    ] {
        let classified = issues
            .iter()
            .map(|issue| (issue.key.as_str(), issue.code))
            .collect::<BTreeSet<_>>();
        assert_eq!(classified, expected);
        assert_eq!(
            issues.len(),
            classified.len(),
            "one actionable issue per rejected option"
        );
    }
    assert_eq!(serde_json::to_vec(&mixed).unwrap(), saved_values);

    // Direct catalog validation still reports these dedicated keys as unknown.
    let bindings = json!({
        "draft_model": "/synthetic/draft",
        "lora_adapters": [{"name": "style", "path": "/synthetic/adapter"}],
        "request_lora": "style"
    });
    let saved_bindings = serde_json::to_vec(&bindings).unwrap();
    assert_eq!(
        serde_json::to_value(options::validate(
            ProviderId::Vllm,
            bindings.as_object().unwrap(),
        ))
        .unwrap(),
        json!([
            {"key": "draft_model", "code": "unknown", "message": "draft_model is not an option of vllm"},
            {"key": "lora_adapters", "code": "unknown", "message": "lora_adapters is not an option of vllm"},
            {"key": "request_lora", "code": "unknown", "message": "request_lora is not an option of vllm"}
        ])
    );
    assert_eq!(serde_json::to_vec(&bindings).unwrap(), saved_bindings);

    let mut missing_model = config(ProviderId::Vllm, json!({"dtype": "fp4"}));
    missing_model.active_model.clear();
    let saved_cfg = serde_json::to_vec(&missing_model).unwrap();
    let saved_runtime = serde_json::to_vec(&standard).unwrap();
    assert_eq!(
        engine_command(&missing_model, &standard, 1, "").unwrap_err(),
        "vllm settings need attention before starting: dtype does not accept 'fp4'"
    );
    assert_eq!(serde_json::to_vec(&missing_model).unwrap(), saved_cfg);
    assert_eq!(serde_json::to_vec(&standard).unwrap(), saved_runtime);

    // Offline editing validates bindings without loading runtimes or model files.
    let mut dormant = config(ProviderId::Vllm, json!({"max_model_len": 16}));
    dormant.active_runtime.clear();
    let saved_dormant = serde_json::to_vec(&dormant).unwrap();
    let valid_input = json!({
        "mlx-vlm": {
            "draft_model": "/synthetic/draft",
            "enable_thinking": true,
            "lora_adapters": [{"name": "solo", "path": "/synthetic/solo"}]
        },
        "vllm": {
            "lora_adapters": [{"name": "style", "path": "/synthetic/style"}],
            "max_model_len": 4,
            "request_lora": "style",
            "temperature": 0.25,
            "@option_order": {"version": 1, "occurrences": [{"key": "max_model_len"}]}
        }
    })
    .to_string();
    let saved_input = valid_input.as_bytes().to_vec();
    let parsed = super::super::adapter::parse_option_maps(&dormant, &valid_input).unwrap();
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        serde_json::from_str::<Value>(&valid_input).unwrap()
    );
    assert_eq!(valid_input.as_bytes(), saved_input);
    assert_eq!(serde_json::to_vec(&dormant).unwrap(), saved_dormant);
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("aiolm-launch-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &Path, name: &str, contents: &[u8]) {
    std::fs::write(dir.join(name), contents).unwrap();
}

/// A complete synthetic snapshot: configuration, one weight file and,
/// unless it is a drafter, a tokenizer.
fn snapshot(label: &str, config: Value, tokenizer: bool) -> PathBuf {
    let dir = temp_dir(label);
    write(&dir, "config.json", config.to_string().as_bytes());
    write(&dir, "model.safetensors", b"weights");
    if tokenizer {
        write(&dir, "tokenizer.json", b"{}");
    }
    dir
}

fn with_flags(provider: ProviderId, flags: &[&str]) -> PythonRuntimeManifest {
    let mut runtime = runtime(provider);
    runtime.probe.as_mut().unwrap().server_flags =
        flags.iter().map(|flag| flag.to_string()).collect();
    runtime
}

#[test]
fn vllm_enables_probed_telemetry_without_persisting_defaults_across_platforms() {
    let cfg = config(ProviderId::Vllm, json!({}));
    let saved_options = cfg.provider_options.clone();
    let mut runtime = with_flags(
        ProviderId::Vllm,
        &[
            "--host",
            "--port",
            "--served-model-name",
            "--enable-prompt-tokens-details",
            "--enable-per-request-metrics",
        ],
    );
    for platform in ["Darwin", "Linux", "Windows"] {
        runtime.probe.as_mut().unwrap().platform_system = platform.into();
        let command = engine_command(&cfg, &runtime, 1, "").unwrap();
        for flag in [
            "--enable-prompt-tokens-details",
            "--enable-per-request-metrics",
        ] {
            assert_eq!(command.args.iter().filter(|arg| *arg == flag).count(), 1);
        }
        assert_eq!(cfg.provider_options, saved_options);
    }
}

#[test]
fn telemetry_defaults_follow_partial_and_missing_probe_capabilities() {
    let cfg = config(ProviderId::Vllm, json!({}));
    let base = ["--host", "--port", "--served-model-name"];
    let older = with_flags(ProviderId::Vllm, &base);
    let mut partial_flags = base.to_vec();
    partial_flags.push("--enable-prompt-tokens-details");
    let partial = with_flags(ProviderId::Vllm, &partial_flags);
    let partial_command = engine_command(&cfg, &partial, 1, "").unwrap();
    assert!(partial_command
        .args
        .contains(&"--enable-prompt-tokens-details".into()));
    assert!(!partial_command
        .args
        .contains(&"--enable-per-request-metrics".into()));
    let mut no_probe = runtime(ProviderId::Vllm);
    no_probe.probe = None;
    for unknown in [older, runtime(ProviderId::Vllm), no_probe] {
        let command = engine_command(&cfg, &unknown, 1, "").unwrap();
        assert!(!command
            .args
            .iter()
            .any(|arg| arg.starts_with("--enable-prompt-tokens-details")
                || arg.starts_with("--enable-per-request-metrics")));
    }
}

#[test]
fn vllm_telemetry_respects_explicit_opt_outs_and_stats_dependencies() {
    let runtime = with_flags(
        ProviderId::Vllm,
        &[
            "--host",
            "--port",
            "--served-model-name",
            "--disable-log-stats",
            "--enable-prompt-tokens-details",
            "--enable-per-request-metrics",
        ],
    );
    for options in [
        json!({"enable_prompt_tokens_details":false,"enable_per_request_metrics":false}),
        json!({"enable_prompt_tokens_details":false,"extra_args":["--disable_log_stats"]}),
    ] {
        let command = engine_command(&config(ProviderId::Vllm, options), &runtime, 1, "").unwrap();
        assert!(!command
            .args
            .contains(&"--enable-prompt-tokens-details".into()));
        assert!(!command
            .args
            .contains(&"--enable-per-request-metrics".into()));
    }
    let cfg = config(
        ProviderId::Vllm,
        json!({"extra_args":["--disable-log-stats"]}),
    );
    let command = engine_command(&cfg, &runtime, 1, "").unwrap();
    assert!(command
        .args
        .contains(&"--enable-prompt-tokens-details".into()));
    assert!(!command
        .args
        .contains(&"--enable-per-request-metrics".into()));
    let cfg = config(
        ProviderId::Vllm,
        json!({"enable_per_request_metrics":true,"extra_args":["--disable_log_stats"]}),
    );
    assert!(
        runtime_option_issues(&runtime, &provider_options(&cfg, ProviderId::Vllm))
            .iter()
            .any(|issue| issue.key == "enable_per_request_metrics" && issue.code == "dependency")
    );
    assert!(engine_command(&cfg, &runtime, 1, "")
        .unwrap_err()
        .contains("remove --disable-log-stats"));
}

#[test]
fn standard_vllm_raw_telemetry_opt_out_overrides_typed_enable_before_dependency_validation() {
    let runtime = with_flags(
        ProviderId::Vllm,
        &[
            "--host",
            "--port",
            "--served-model-name",
            "--disable-log-stats",
            "--enable-prompt-tokens-details",
            "--enable-per-request-metrics",
            "--no-enable-per-request-metrics",
        ],
    );
    for raw in [
        "--no-enable-per-request-metrics",
        "--no_enable_per_request_metrics",
    ] {
        let cfg = config(
            ProviderId::Vllm,
            json!({
                "enable_per_request_metrics": true,
                "extra_args": ["--disable_log_stats", raw],
            }),
        );
        let saved_options = cfg.provider_options.clone();
        let options = provider_options(&cfg, ProviderId::Vllm);
        assert!(runtime_option_issues(&runtime, &options).is_empty());
        let command = engine_command(&cfg, &runtime, 1, "").unwrap();
        let enable = command
            .args
            .iter()
            .position(|arg| arg == "--enable-per-request-metrics")
            .unwrap();
        let disable = command.args.iter().position(|arg| arg == raw).unwrap();
        assert!(enable < disable);
        assert_eq!(cfg.provider_options, saved_options);

        let mut unsupported = runtime.clone();
        unsupported
            .probe
            .as_mut()
            .unwrap()
            .server_flags
            .retain(|flag| flag != "--no-enable-per-request-metrics");
        assert!(runtime_option_issues(&unsupported, &options)
            .iter()
            .any(|issue| issue.key == options::EXTRA_ARGS_KEY && issue.code == "version"));

        let mut metal = metal_runtime();
        metal.probe.as_mut().unwrap().server_flags =
            runtime.probe.as_ref().unwrap().server_flags.clone();
        assert!(runtime_option_issues(&metal, &options)
            .iter()
            .any(|issue| issue.key == options::EXTRA_ARGS_KEY && issue.code == "variant"));
    }
}

#[test]
fn metal_telemetry_defaults_use_the_selected_probe_and_leave_other_engines_unchanged() {
    let dir = temp_dir("metal-telemetry");
    metal_snapshot(&dir, "qwen3", "Qwen3ForCausalLM", json!({}));
    let mut runtime = metal_runtime();
    runtime.probe.as_mut().unwrap().server_flags = [
        "--host",
        "--port",
        "--served-model-name",
        "--enable-prompt-tokens-details",
        "--enable-per-request-metrics",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let mut cfg = config(ProviderId::Vllm, json!({}));
    cfg.active_model = dir.to_string_lossy().into_owned();
    let command = engine_command(&cfg, &runtime, 1, "").unwrap();
    assert!(command
        .args
        .contains(&"--enable-prompt-tokens-details".into()));
    assert!(command
        .args
        .contains(&"--enable-per-request-metrics".into()));
    let mlx = with_flags(
        ProviderId::MlxVlm,
        &[
            "--host",
            "--port",
            "--model",
            "--enable-prompt-tokens-details",
            "--enable-per-request-metrics",
        ],
    );
    let command = engine_command(&config(ProviderId::MlxVlm, json!({})), &mlx, 1, "").unwrap();
    assert!(!command
        .args
        .iter()
        .any(|arg| arg.starts_with("--enable-prompt-tokens-details")
            || arg.starts_with("--enable-per-request-metrics")));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn llama_lora_files_are_not_accepted_as_engine_adapters() {
    let dir = temp_dir("lora");
    let gguf = dir.join("adapter.gguf");
    std::fs::write(&gguf, b"GGUF").unwrap();
    assert!(adapter_problem(ProviderId::Vllm, &gguf, None).is_some());
    assert!(adapter_problem(ProviderId::Vllm, &dir, None)
        .unwrap()
        .contains("adapter_config.json"));
    write(
        &dir,
        "adapter_config.json",
        br#"{"r":8,"lora_alpha":16,"target_modules":["q_proj"]}"#,
    );
    assert!(adapter_problem(ProviderId::Vllm, &dir, None)
        .unwrap()
        .contains("adapter_model.safetensors"));
    write(&dir, "adapter_model.safetensors", b"tensors");
    assert!(adapter_problem(ProviderId::Vllm, &dir, None).is_none());
    let cfg = config(
        ProviderId::Vllm,
        json!({"lora_adapters": [{"name":"style","path": dir.to_string_lossy()}], "request_lora": "style"}),
    );
    let command = engine_command(&cfg, &runtime(ProviderId::Vllm), 2, "").unwrap();
    let position = command
        .args
        .iter()
        .position(|arg| arg == "--lora-modules")
        .unwrap();
    assert_eq!(command.args[position - 1], "--enable-lora");
    assert_eq!(
        command.args[position + 1],
        format!("style={}", dir.to_string_lossy())
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn adapters_are_checked_against_what_each_pinned_engine_loads() {
    let dir = temp_dir("peft");
    write(&dir, "adapter_model.safetensors", b"tensors");
    for (config, expected) in [
        (
            r#"{"lora_alpha":16,"target_modules":"all-linear"}"#,
            "positive integer `r`",
        ),
        (
            r#"{"r":0,"lora_alpha":16,"target_modules":["q"]}"#,
            "positive integer `r`",
        ),
        (r#"{"r":8,"target_modules":["q"]}"#, "lora_alpha"),
        (r#"{"r":8,"lora_alpha":16}"#, "target_modules"),
        (
            r#"{"r":8,"lora_alpha":16,"target_modules":["q"],"bias":"all"}"#,
            "bias",
        ),
        (
            r#"{"r":8,"lora_alpha":16,"target_modules":["q"],"use_dora":true}"#,
            "DoRA",
        ),
        (
            r#"{"r":8,"lora_alpha":16,"target_modules":["q"],"modules_to_save":["lm_head"]}"#,
            "modules_to_save",
        ),
        (
            r#"{"r":32,"lora_alpha":16,"target_modules":["q"]}"#,
            "exceeds max_lora_rank 16",
        ),
        ("[1]", "valid JSON object"),
    ] {
        write(&dir, "adapter_config.json", config.as_bytes());
        let problem = adapter_problem(ProviderId::Vllm, &dir, None).unwrap_or_default();
        assert!(problem.contains(expected), "{config}: {problem}");
    }
    write(
        &dir,
        "adapter_config.json",
        br#"{"r":32,"lora_alpha":16,"target_modules":["q"],"modules_to_save":["score"]}"#,
    );
    assert!(adapter_problem(ProviderId::Vllm, &dir, Some(64)).is_none());
    // A PEFT adapter is not an mlx-vlm adapter, and the reverse.
    assert!(adapter_problem(ProviderId::MlxVlm, &dir, None)
        .unwrap()
        .contains("`rank`"));
    write(&dir, "adapter_config.json", br#"{"rank":8,"alpha":16}"#);
    assert!(adapter_problem(ProviderId::MlxVlm, &dir, None)
        .unwrap()
        .contains("adapters.safetensors"));
    write(&dir, "adapters.safetensors", b"tensors");
    assert!(adapter_problem(ProviderId::MlxVlm, &dir, None).is_none());
    write(
        &dir,
        "adapter_config.json",
        br#"{"lora_parameters":{"rank":8}}"#,
    );
    assert!(adapter_problem(ProviderId::MlxVlm, &dir, None).is_none());
    let cfg = config(
        ProviderId::Vllm,
        json!({"lora_adapters": [{"name":"a","path": dir.to_string_lossy()}]}),
    );
    assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
        .unwrap_err()
        .contains("positive integer `r`"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn vllm_embedding_only_models_launch_the_pooling_runner_whatever_their_role() {
    // BertModel without sentence-transformers files is a plain `Model`
    // artifact, but vLLM registers it for pooling only.
    let model = snapshot(
        "bert",
        json!({"architectures":["BertModel"],"model_type":"bert"}),
        true,
    );
    assert_eq!(
        artifacts::inspect_snapshot(&model).role,
        artifacts::ArtifactRole::Model
    );
    let mut cfg = config(ProviderId::Vllm, json!({}));
    cfg.active_model = model.to_string_lossy().into_owned();
    let args = engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
        .unwrap()
        .args;
    let runner = args.iter().position(|arg| arg == "--runner").unwrap();
    assert_eq!(args[runner + 1], "pooling");
    cfg.provider_options.insert(
        "vllm".into(),
        json!({"runner":"auto"}).as_object().unwrap().clone(),
    );
    let args = engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
        .unwrap()
        .args;
    assert_eq!(args.iter().filter(|arg| *arg == "--runner").count(), 1);
    assert!(args.windows(2).any(|pair| pair == ["--runner", "pooling"]));
    cfg.provider_options.insert(
        "vllm".into(),
        json!({"runner":"generate"}).as_object().unwrap().clone(),
    );
    assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
        .unwrap_err()
        .contains("pooling runner"));
    // A model vLLM registers for generation keeps the engine's own choice.
    let chat = snapshot(
        "qwen2",
        json!({"architectures":["Qwen2ForCausalLM"],"model_type":"qwen2"}),
        true,
    );
    cfg.active_model = chat.to_string_lossy().into_owned();
    cfg.provider_options.insert("vllm".into(), Map::new());
    assert!(!engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
        .unwrap()
        .args
        .contains(&"--runner".to_string()));
    std::fs::remove_dir_all(model).unwrap();
    std::fs::remove_dir_all(chat).unwrap();
}

#[test]
fn mlx_embedding_models_and_companions_follow_the_compatibility_verdict() {
    let bert = snapshot(
        "mlx-bert",
        json!({"architectures":["BertModel"],"model_type":"bert"}),
        true,
    );
    let mut cfg = config(ProviderId::MlxVlm, json!({}));
    cfg.active_model = bert.to_string_lossy().into_owned();
    let args = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
        .unwrap()
        .args;
    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "--embedding-model" && pair[1] == cfg.active_model));
    assert!(!args.contains(&"--model".to_string()));
    // A chat model is not an embedding companion.
    let chat = snapshot(
        "mlx-llama",
        json!({"architectures":["LlamaForCausalLM"],"model_type":"llama"}),
        true,
    );
    cfg.active_model = chat.to_string_lossy().into_owned();
    cfg.provider_options.insert(
        "mlx-vlm".into(),
        json!({"embedding_model": chat.to_string_lossy()})
            .as_object()
            .unwrap()
            .clone(),
    );
    assert!(engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
        .unwrap_err()
        .contains("embedding_model"));
    cfg.provider_options.insert(
        "mlx-vlm".into(),
        json!({"embedding_model": bert.to_string_lossy()})
            .as_object()
            .unwrap()
            .clone(),
    );
    let args = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
        .unwrap()
        .args;
    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "--model" && pair[1] == cfg.active_model));
    assert!(args.windows(2).any(|pair| pair[0] == "--embedding-model"));
    std::fs::remove_dir_all(bert).unwrap();
    std::fs::remove_dir_all(chat).unwrap();
}

#[test]
fn mlx_draft_models_must_be_complete_snapshots_of_the_selected_kind() {
    assert!(
        draft_problem(Path::new("/definitely/missing/drafter"), None)
            .unwrap()
            .contains("does not exist")
    );
    let drafter = snapshot(
        "drafter",
        json!({"architectures":["Gemma4AssistantModel"],"model_type":"gemma4_assistant"}),
        false,
    );
    assert!(
        draft_problem(&drafter, None).is_none(),
        "drafters need no tokenizer"
    );
    assert!(draft_problem(&drafter, Some("mtp")).is_none());
    assert!(draft_problem(&drafter, Some("dflash"))
        .unwrap()
        .contains("'mtp' drafter"));
    write(&drafter, "model-00002.safetensors.aiolm-part", b"x");
    assert!(draft_problem(&drafter, None)
        .unwrap()
        .contains("did not complete"));
    let mut cfg = config(
        ProviderId::MlxVlm,
        json!({"draft_model": drafter.to_string_lossy(), "draft_kind": "mtp"}),
    );
    cfg.active_model = "/models/target".into();
    assert!(engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
        .unwrap_err()
        .contains("did not complete"));
    std::fs::remove_file(drafter.join("model-00002.safetensors.aiolm-part")).unwrap();
    let args = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
        .unwrap()
        .args;
    assert!(args.windows(2).any(|pair| pair[0] == "--draft-model"));
    std::fs::remove_dir_all(drafter).unwrap();
}

#[test]
fn probed_server_flags_govern_bindings_as_well_as_options() {
    let adapter = temp_dir("flags");
    write(
        &adapter,
        "adapter_config.json",
        br#"{"r":8,"lora_alpha":16,"target_modules":["q"]}"#,
    );
    write(&adapter, "adapter_model.safetensors", b"tensors");
    let options = json!({
        "lora_adapters": [{"name":"a","path": adapter.to_string_lossy()}],
        "enable_prefix_caching": false,
        "max_model_len": 4096
    });
    let cfg = config(ProviderId::Vllm, options.clone());
    let base = ["--host", "--port", "--served-model-name", "--max-model-len"];
    // The runtime lacks LoRA serving and the negated prefix-caching flag.
    let runtime = with_flags(ProviderId::Vllm, &base);
    let issues = runtime_option_issues(&runtime, options.as_object().unwrap());
    let flagged = issues
        .iter()
        .map(|issue| (issue.key.as_str(), issue.message.clone()))
        .collect::<Vec<_>>();
    assert!(flagged
        .iter()
        .any(|(key, message)| *key == "lora_adapters" && message.contains("--lora-modules")));
    assert!(flagged
        .iter()
        .any(|(key, message)| *key == "enable_prefix_caching"
            && message.contains("--no-enable-prefix-caching")));
    assert!(!flagged.iter().any(|(key, _)| *key == "max_model_len"));
    assert!(engine_command(&cfg, &runtime, 1, "")
        .unwrap_err()
        .contains("does not support"));
    let full = with_flags(
        ProviderId::Vllm,
        &[
            &base[..],
            &[
                "--enable-lora",
                "--lora-modules",
                "--no-enable-prefix-caching",
                "--enable-prefix-caching",
            ],
        ]
        .concat(),
    );
    assert!(runtime_option_issues(&full, options.as_object().unwrap()).is_empty());
    engine_command(&cfg, &full, 1, "").unwrap();
    // The pooling runner is a binding too: a runtime without `--runner`
    // cannot serve an embedding-only model.
    let model = snapshot(
        "flags-bert",
        json!({"architectures":["BertModel"],"model_type":"bert"}),
        true,
    );
    let mut cfg = config(ProviderId::Vllm, json!({}));
    cfg.active_model = model.to_string_lossy().into_owned();
    assert!(
        engine_command(&cfg, &with_flags(ProviderId::Vllm, &base), 1, "")
            .unwrap_err()
            .contains("--runner")
    );
    std::fs::remove_dir_all(adapter).unwrap();
    std::fs::remove_dir_all(model).unwrap();
}

#[test]
fn vllm_rank_and_tool_settings_match_what_the_server_accepts() {
    let issues = option_issues(
        ProviderId::Vllm,
        json!({"max_lora_rank": 24}).as_object().unwrap(),
    );
    assert_eq!(
        issues.iter().map(|issue| issue.code).collect::<Vec<_>>(),
        vec!["choice"]
    );
    assert!(option_issues(
        ProviderId::Vllm,
        json!({"max_lora_rank": 320}).as_object().unwrap()
    )
    .is_empty());
    let issues = option_issues(
        ProviderId::Vllm,
        json!({"enable_auto_tool_choice": true})
            .as_object()
            .unwrap(),
    );
    assert_eq!(issues[0].key, "enable_auto_tool_choice");
    assert!(option_issues(
        ProviderId::Vllm,
        json!({"enable_auto_tool_choice": true, "tool_call_parser": "hermes"})
            .as_object()
            .unwrap()
    )
    .is_empty());
    let issues = option_issues(
        ProviderId::Vllm,
        json!({"trust_remote_code": true}).as_object().unwrap(),
    );
    assert_eq!(issues[0].code, "managed");
    assert!(option_issues(
        ProviderId::MlxVlm,
        json!({"trust_remote_code": false}).as_object().unwrap()
    )
    .is_empty());
}

#[test]
fn served_names_are_safe_for_clients() {
    assert_eq!(served_model_name("/m/org/My Model:v1/"), "My-Model-v1");
    assert_eq!(
        served_model_name("C:\\models\\qwen"),
        if cfg!(windows) {
            "qwen"
        } else {
            "C--models-qwen"
        }
    );
    assert_eq!(served_model_name("/"), "model");
}

#[test]
fn vllm_adapters_load_only_from_safetensors() {
    let dir = temp_dir("pickle");
    write(
        &dir,
        "adapter_config.json",
        br#"{"r":8,"lora_alpha":16,"target_modules":["q"]}"#,
    );
    for pickle in ["adapter_model.bin", "adapter_model.pt"] {
        write(&dir, pickle, b"pickle");
        let problem = adapter_problem(ProviderId::Vllm, &dir, None).unwrap();
        assert!(
            problem.contains(pickle) && problem.contains("safetensors"),
            "{problem}"
        );
        let cfg = config(
            ProviderId::Vllm,
            json!({"lora_adapters": [{"name":"a","path": dir.to_string_lossy()}]}),
        );
        assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap_err()
            .contains("pickle checkpoint"));
        std::fs::remove_file(dir.join(pickle)).unwrap();
    }
    // vLLM reads adapter_model.safetensors first, so a leftover pickle
    // beside it is never loaded.
    write(&dir, "adapter_model.bin", b"pickle");
    write(&dir, "adapter_model.safetensors", b"tensors");
    assert!(adapter_problem(ProviderId::Vllm, &dir, None).is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn values_that_argparse_would_read_as_options_are_refused() {
    assert!(!valid_adapter_name("-x"));
    assert!(valid_adapter_name("style-1"));
    let mut cfg = config(ProviderId::Vllm, json!({}));
    cfg.active_model = "--port".into();
    assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
        .unwrap_err()
        .contains("must not start with '-'"));
    let cfg = config(
        ProviderId::Vllm,
        json!({"lora_adapters": [{"name":"a","path":"--host"}]}),
    );
    assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
        .unwrap_err()
        .contains("must not start with '-'"));
    let cfg = config(ProviderId::MlxVlm, json!({"draft_model": "-d"}));
    assert!(engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
        .unwrap_err()
        .contains("must not start with '-'"));
    assert_eq!(served_model_name("/m/--evil"), "evil");
    assert_eq!(served_model_name("/m/---"), "model");
}

#[test]
fn raw_arguments_are_compared_to_probed_flags_in_the_spelling_vllm_parses() {
    let runtime = with_flags(
        ProviderId::Vllm,
        &["--disable-log-stats", "--max-model-len"],
    );
    let options = json!({"extra_args": ["--disable_log_stats"]});
    assert!(runtime_option_issues(&runtime, options.as_object().unwrap()).is_empty());
    let options = json!({"extra_args": ["--disable_log_request"]});
    let issues = runtime_option_issues(&runtime, options.as_object().unwrap());
    assert!(issues
        .iter()
        .any(|issue| issue.message.contains("--disable-log-request")));
}
