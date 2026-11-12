use super::*;

#[test]
fn saving_invalid_configuration_preserves_validation_kind_without_writing() {
    let path =
        std::env::temp_dir().join(format!("aiolm-invalid-save-{}.json", uuid::Uuid::new_v4()));
    let cfg = AppConfig {
        config_version: CURRENT_CONFIG_VERSION + 1,
        ..AppConfig::default()
    };
    let error = save_to_path(&cfg, &path).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert_eq!(
        error.message,
        format!(
            "config schema {} is newer than this app supports (current {})",
            CURRENT_CONFIG_VERSION + 1,
            CURRENT_CONFIG_VERSION
        )
    );
    assert!(!path.exists());
}

#[test]
fn app_config_fields_match_the_frontend_contract() {
    // Include fields omitted by serde for None/empty values so this checks
    // the complete interface, not just the fresh-install JSON subset.
    let mut cfg = AppConfig {
        settings_profiles: Some(profiles::SettingsProfileLibrary::default()),
        ..AppConfig::default()
    };
    cfg.recent_runtimes
        .insert("vllm".into(), "synthetic-runtime".into());
    let rust = serde_json::to_value(cfg).unwrap();
    let frontend: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/direct/app-config-keys.json")).unwrap();
    let mut rust_keys = rust.as_object().unwrap().keys().collect::<Vec<_>>();
    let mut frontend_keys = frontend.as_object().unwrap().keys().collect::<Vec<_>>();
    rust_keys.sort();
    frontend_keys.sort();
    assert_eq!(rust_keys, frontend_keys);
}

#[test]
fn concurrent_migration_reuses_an_identical_backup_and_is_idempotent() {
    for interrupted_backup in [false, true] {
        let directory =
            std::env::temp_dir().join(format!("aiolm-concurrent-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        let original = b"{\"config_version\":12,\"models_dir\":\"models\",\"ctx_size\":8192}\n";
        fs::write(&path, original).unwrap();
        let backup = path.with_extension(format!("v12-before-v{CURRENT_CONFIG_VERSION}.json"));
        if interrupted_backup {
            // Simulate a prior attempt interrupted after the durable backup.
            atomic_write(&backup, original).unwrap();
        }
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let readers = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let loaded = load_from_path(&path).unwrap();
                    assert_eq!(loaded.config_version, CURRENT_CONFIG_VERSION);
                    assert_eq!(loaded.ctx_size, 8192);
                })
            })
            .collect::<Vec<_>>();
        for reader in readers {
            reader.join().unwrap();
        }
        assert_eq!(fs::read(&backup).unwrap(), original);
        let migrated_bytes = fs::read(&path).unwrap();
        load_from_path(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), migrated_bytes);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn inherited_batch_settings_survive_save_reload_without_cross_clamping_raw_values() {
    let directory = std::env::temp_dir().join(format!("aiolm-batch-defaults-{}", Uuid::new_v4()));
    let path = directory.join("config.json");
    for inherited in ["batch_size", "ubatch_size"] {
        let cfg = AppConfig {
            models_dir: "models".into(),
            active_model: "model.gguf".into(),
            ctx_size: 0,
            batch_size: 128,
            ubatch_size: 1024,
            runtime_defaults: vec![inherited.into()],
            ..Default::default()
        };
        save_to_path(&cfg, &path).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert_eq!(loaded.ctx_size, 0);
        assert_eq!(loaded.batch_size, 128);
        assert_eq!(loaded.ubatch_size, 1024);
        assert_eq!(loaded.runtime_defaults, vec![inherited]);
        let snapshot = execution::snapshot(&loaded);
        assert_eq!(snapshot["ubatch_size"], serde_json::json!(1024));
        let args = crate::server::build_args(&loaded, "");
        assert_eq!(
            args.iter().any(|arg| arg == "--batch-size"),
            inherited != "batch_size"
        );
        assert_eq!(
            args.iter().any(|arg| arg == "--ubatch-size"),
            inherited != "ubatch_size"
        );
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn sampling_and_keep_sentinels_survive_save_reload_sessions_and_launch() {
    let directory = std::env::temp_dir().join(format!("aiolm-sampling-{}", Uuid::new_v4()));
    let path = directory.join("config.json");
    let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
        "models_dir": "models",
        "active_model": "model.gguf",
        "keep": -1,
        "top_k": 0,
        "temperature": 1.5,
        "runtime_defaults": [],
        "sessions": [{
            "id": "saved",
            "models": {"primary_model": "model.gguf"},
            "execution": {"keep": -1, "top_k": 0, "temperature": 1.5}
        }]
    }))
    .unwrap();
    for keep in [-1, 0, 64] {
        cfg.keep = keep;
        save_to_path(&cfg, &path).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert_eq!(loaded.keep, keep);
        assert_eq!(loaded.top_k, 0);
        assert_eq!(loaded.temperature, 1.5);
        let snapshot = execution::snapshot(&loaded);
        assert_eq!(snapshot["keep"], serde_json::json!(keep));
        let effective = execution::session_config(&loaded, &loaded.sessions[0]).unwrap();
        assert_eq!(effective.keep, -1);
        assert_eq!(effective.top_k, 0);
        assert_eq!(effective.temperature, 1.5);
        let args = crate::server::build_args(&effective, "");
        assert!(args.windows(2).any(|pair| pair == ["--keep", "-1"]));
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn legacy_keep_all_arguments_migrate_without_changing_ordinary_keep_values() {
    for (argument, expected) in [("-1", -1), ("0", 0), ("64", 64)] {
        let migrated = migrate_value(serde_json::json!({
            "config_version": 7,
            "models_dir": "models",
            "top_k": 0,
            "server_args": ["--keep", argument]
        }))
        .unwrap();
        assert_eq!(migrated.keep, expected);
        assert_eq!(migrated.top_k, 0);
        assert!(migrated.server_args.is_empty());
    }
}

#[test]
fn a_fresh_installation_gets_its_default_model_folder_and_keeps_what_is_in_it() {
    let home = std::env::temp_dir().join(format!("aiolm-models-init-{}", Uuid::new_v4()));
    let default = home.join(".aiolm").join("models");
    // Nothing is read from the developer machine: a configuration that has
    // never been saved points at the default folder, and that folder is the
    // one created.
    let mut cfg = load_from_path(&home.join("config.json")).unwrap();
    assert_eq!(Path::new(&cfg.models_dir), default_models_dir());
    // The rest of the check runs against a temporary home so it never
    // touches the folder this machine actually uses.
    cfg.models_dir = default.to_string_lossy().into_owned();
    ensure_models_dir_at(&cfg, &default).unwrap();
    assert!(default.is_dir());

    // Running it again is a no-op that keeps every model already stored.
    let model = default.join("kept.gguf");
    fs::write(&model, b"model bytes").unwrap();
    ensure_models_dir_at(&cfg, &default).unwrap();
    assert_eq!(fs::read(&model).unwrap(), b"model bytes");

    fs::remove_dir_all(&home).unwrap();
}

#[test]
fn a_model_folder_the_user_chose_is_never_created_for_them() {
    let root = std::env::temp_dir().join(format!("aiolm-models-custom-{}", Uuid::new_v4()));
    let default = root.join("default");
    let chosen = root.join("detached-volume").join("models");
    let cfg = AppConfig {
        models_dir: chosen.to_string_lossy().into_owned(),
        ..AppConfig::default()
    };
    ensure_models_dir_at(&cfg, &default).unwrap();
    // A chosen folder that is missing means the volume holding it is not
    // attached. Creating an empty one in its place would hide the models.
    assert!(!chosen.exists());
    assert!(!default.exists());
}

#[test]
fn a_default_model_folder_that_cannot_be_created_reports_why() {
    let root = std::env::temp_dir().join(format!("aiolm-models-blocked-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let blocked = root.join("models");
    fs::write(&blocked, b"not a folder").unwrap();
    let cfg = AppConfig {
        models_dir: blocked.to_string_lossy().into_owned(),
        ..AppConfig::default()
    };
    let error = ensure_models_dir_at(&cfg, &blocked).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Internal);
    assert!(error.message.contains("failed to create the model folder"));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn closing_the_window_hides_to_the_tray_unless_the_setting_was_turned_off() {
    assert!(AppConfig::default().close_to_tray);
    // A configuration written before the tray existed carries no field and
    // takes the default.
    let existing: AppConfig =
        serde_json::from_value(serde_json::json!({"config_version": 11, "models_dir": "models"}))
            .unwrap();
    assert!(existing.close_to_tray);
    let opted_out: AppConfig = serde_json::from_value(
        serde_json::json!({"config_version": 11, "models_dir": "models", "close_to_tray": false}),
    )
    .unwrap();
    assert!(!opted_out.close_to_tray);
}

fn write_config(path: &Path, value: &serde_json::Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn onboarding_on_disk(path: &Path) -> Option<serde_json::Value> {
    let raw: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    raw.get("onboarding_completed").cloned()
}

#[test]
fn a_fresh_installation_keeps_onboarding_pending_until_it_is_completed() {
    let directory = std::env::temp_dir().join(format!("aiolm-onboarding-fresh-{}", Uuid::new_v4()));
    let path = directory.join("config.json");
    // A missing config file is the only sign of a first run.
    assert!(!AppConfig::default().onboarding_completed);
    let mut cfg = load_from_path(&path).unwrap();
    assert!(!cfg.onboarding_completed);

    // Onboarding interrupted after a save writes an explicit `false`, so the
    // next launch does not read the file as one that predates onboarding.
    cfg.models_dir = "models".into();
    assert!(!save_to_path(&cfg, &path).unwrap().onboarding_completed);
    assert_eq!(onboarding_on_disk(&path), Some(serde_json::json!(false)));
    let mut pending = load_from_path(&path).unwrap();
    assert!(!pending.onboarding_completed);
    pending.normalize();
    assert!(!pending.onboarding_completed);
    pending.port = 9090;
    save_to_path(&pending, &path).unwrap();
    assert!(!load_from_path(&path).unwrap().onboarding_completed);

    // Once completed, later unrelated saves and reloads keep it completed.
    let mut completed = load_from_path(&path).unwrap();
    completed.onboarding_completed = true;
    save_to_path(&completed, &path).unwrap();
    let mut updated = load_from_path(&path).unwrap();
    assert!(updated.onboarding_completed);
    updated.port = 9091;
    save_to_path(&updated, &path).unwrap();
    assert!(load_from_path(&path).unwrap().onboarding_completed);
    assert_eq!(onboarding_on_disk(&path), Some(serde_json::json!(true)));

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn configs_written_before_onboarding_existed_count_as_completed() {
    let directory =
        std::env::temp_dir().join(format!("aiolm-onboarding-legacy-{}", Uuid::new_v4()));
    for version in [None, Some(7), Some(11), Some(CURRENT_CONFIG_VERSION)] {
        let mut legacy = serde_json::json!({ "models_dir": "models" });
        if let Some(version) = version {
            legacy["config_version"] = version.into();
        }
        let path = directory
            .join(format!("v{}", version.unwrap_or_default()))
            .join("config.json");
        write_config(&path, &legacy);
        // An existing user updating the app must not be sent through
        // onboarding again.
        let loaded = load_from_path(&path).unwrap();
        assert!(loaded.onboarding_completed, "{version:?}");
        // Loading an older schema rewrites the file, and the rewrite must
        // record completion rather than the fresh-install default.
        let rewritten_on_load = version != Some(CURRENT_CONFIG_VERSION);
        assert_eq!(
            onboarding_on_disk(&path),
            rewritten_on_load.then_some(serde_json::json!(true)),
            "{version:?}"
        );
        save_to_path(&loaded, &path).unwrap();
        assert_eq!(
            onboarding_on_disk(&path),
            Some(serde_json::json!(true)),
            "{version:?}"
        );
        let reloaded = load_from_path(&path).unwrap();
        assert!(reloaded.onboarding_completed, "{version:?}");
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn schema_migration_keeps_a_saved_onboarding_state() {
    // After a later schema bump, files that already carry the field go
    // through migration, which must keep the saved answer instead of
    // falling back to either default.
    let directory =
        std::env::temp_dir().join(format!("aiolm-onboarding-migrate-{}", Uuid::new_v4()));
    let path = directory.join("config.json");
    for completed in [false, true] {
        write_config(
            &path,
            &serde_json::json!({
                "config_version": CURRENT_CONFIG_VERSION - 1,
                "models_dir": "models",
                "onboarding_completed": completed
            }),
        );
        assert_eq!(
            load_from_path(&path).unwrap().onboarding_completed,
            completed
        );
        assert_eq!(
            onboarding_on_disk(&path),
            Some(serde_json::json!(completed))
        );
        assert_eq!(
            load_from_path(&path).unwrap().onboarding_completed,
            completed
        );
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn engine_option_keys_match_the_keys_used_by_launch_and_recent_selection() {
    let mut cfg = AppConfig::default();
    cfg.provider_options.insert(
        "vllm".into(),
        serde_json::json!({"temperature":0.5})
            .as_object()
            .unwrap()
            .clone(),
    );
    cfg.recent_runtimes
        .insert("mlx-vlm".into(), "synthetic-runtime".into());
    cfg.validate().unwrap();
    let mut wrong_options = cfg.clone();
    let options = wrong_options.provider_options.remove("vllm").unwrap();
    wrong_options
        .provider_options
        .insert(" vllm".into(), options);
    assert!(wrong_options.validate().unwrap_err().contains("canonical"));
    cfg.recent_runtimes
        .insert(" mlx-vlm".into(), "synthetic-runtime".into());
    assert!(cfg.validate().unwrap_err().contains("recent runtime"));
}

#[test]
fn runtime_migration_keeps_exact_original_bytes_and_preserves_an_existing_backup() {
    let directory =
        std::env::temp_dir().join(format!("aiolm-provider-migration-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("config.json");
    let original = "{\n  \"config_version\": 12, \"future_field\": {\"preserved\":true}\n}\n";
    fs::write(&path, original).unwrap();
    let migrated = load_from_path(&path).unwrap();
    assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
    assert_eq!(migrated.active_provider, "llama.cpp");
    let backup = path.with_extension(format!("v12-before-v{CURRENT_CONFIG_VERSION}.json"));
    assert_eq!(fs::read_to_string(&backup).unwrap(), original);
    // A second older document cannot replace the first recovery point.
    fs::write(&path, "{\"config_version\":12,\"ctx_size\":8192}").unwrap();
    assert_eq!(load_from_path(&path).unwrap().ctx_size, 8192);
    assert_eq!(fs::read_to_string(&backup).unwrap(), original);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn adapter_schema_upgrade_preserves_builtin_options_profiles_and_exact_backup() {
    let directory =
        std::env::temp_dir().join(format!("aiolm-adapter-migration-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("config.json");
    let mut previous = AppConfig {
        active_provider: "vllm".into(),
        active_runtime: "synthetic-build".into(),
        ctx_size: 8192,
        ..Default::default()
    };
    previous.provider_options.insert(
        "vllm".into(),
        serde_json::json!({"temperature":0.4})
            .as_object()
            .unwrap()
            .clone(),
    );
    previous.normalize();
    profiles::initialize_profiles(&mut previous, true, false, false).unwrap();
    previous.config_version = 13;
    let original = serde_json::to_vec_pretty(&previous).unwrap();
    fs::write(&path, &original).unwrap();
    let migrated = load_from_path(&path).unwrap();
    assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
    assert_eq!(migrated.active_provider, previous.active_provider);
    assert_eq!(migrated.active_runtime, previous.active_runtime);
    assert_eq!(migrated.ctx_size, previous.ctx_size);
    assert_eq!(migrated.provider_options, previous.provider_options);
    assert_eq!(migrated.settings_profiles, previous.settings_profiles);
    assert_eq!(
        fs::read(path.with_extension(format!("v13-before-v{CURRENT_CONFIG_VERSION}.json")))
            .unwrap(),
        original
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn first_install_loads_and_saves_one_default_for_each_provider() {
    let directory =
        std::env::temp_dir().join(format!("aiolm-profile-initialization-{}", Uuid::new_v4()));
    let path = directory.join("config.json");
    let mut cfg = load_from_path(&path).unwrap();
    let profiles = cfg.settings_profiles.as_ref().unwrap();
    assert_eq!(profiles, &profiles::SettingsProfileLibrary::default());
    assert_eq!(profiles.entries.len(), 3);
    assert_eq!(
        profiles.applied["model:"].profile_id.as_deref(),
        Some("profile-default")
    );
    assert!(!profiles.legacy_imported);
    cfg.models_dir = "models".into();
    save_to_path(&cfg, &path).unwrap();
    let restored = load_from_path(&path).unwrap();
    assert_eq!(restored.settings_profiles, cfg.settings_profiles);
    fs::remove_file(path).unwrap();
    fs::remove_dir(directory).unwrap();
}

#[test]
fn v10_sessions_keep_inheritance_and_v11_overrides_are_normalized() {
    let cfg = migrate_value(serde_json::json!({
        "config_version": 10,
        "sessions": [{"id":"legacy","models":{"primary_model":"model.gguf"}}]
    }))
    .unwrap();
    assert_eq!(cfg.config_version, CURRENT_CONFIG_VERSION);
    assert_eq!(
        cfg.sessions[0].execution.as_ref().unwrap()["active_provider"],
        "llama.cpp"
    );
    assert!(!cfg.sessions[0]
        .execution
        .as_ref()
        .unwrap()
        .contains_key("temperature"));
    let migrated = migrate_value(serde_json::json!({
        "config_version":11,
        "sessions":[{"id":"isolated","model_profile_id":" profile-a ","execution":{"temperature":99,"ctx_size":256}}]
    })).unwrap();
    let execution = migrated.sessions[0].execution.as_ref().unwrap();
    assert_eq!(execution["temperature"], 2.0);
    assert_eq!(execution["ctx_size"], 512);
    assert_eq!(
        migrated.sessions[0].model_profile_id.as_deref(),
        Some("profile-a")
    );
    for invalid in [
        serde_json::json!({"port":9000}),
        serde_json::json!({"temperature":"invalid"}),
    ] {
        assert!(
            migrate_value(serde_json::json!({"sessions":[{"id":"bad","execution":invalid}]}))
                .is_err()
        );
    }
}

#[test]
fn normalize_keeps_a_context_and_layer_count_the_editor_accepted() {
    // Saving used to hand these back changed: the editor offered the model's
    // own trained context and the "all layers" idiom, and normalize quietly
    // cut both down to figures this app had picked.
    let mut cfg = AppConfig {
        ngl: 999,
        ctx_size: 262_144,
        ..AppConfig::default()
    };
    cfg.normalize();
    assert_eq!(cfg.ngl, 999);
    assert_eq!(cfg.ctx_size, 262_144);
}

#[test]
fn normalize_still_refuses_a_context_no_machine_could_hold() {
    let mut cfg = AppConfig {
        ctx_size: u32::MAX,
        ..AppConfig::default()
    };
    cfg.normalize();
    assert_eq!(cfg.ctx_size, MAX_CONTEXT);
}

#[test]
fn normalize_clamps_tuning_ranges() {
    let mut cfg = AppConfig {
        ngl: 9_999,
        ctx_size: 128,
        batch_size: 0,
        ubatch_size: 999_999,
        keep: 999_999,
        cache_type_k: "invalid".into(),
        cache_type_v: "invalid".into(),
        n_cpu_moe: 99,
        threads: 99,
        temperature: 3.0,
        top_p: -1.0,
        top_k: 9999,
        spec_draft_n_max: 999,
        spec_draft_p_min: 2.0,
        spec_draft_p_split: -1.0,
        reasoning: "invalid".into(),
        reasoning_format: "invalid".into(),
        reasoning_effort: "invalid".into(),
        reasoning_budget: -2,
        reasoning_preserve: "invalid".into(),
        flash_attn: "invalid".into(),
        ..AppConfig::default()
    };
    cfg.normalize();
    // A large layer count and a large context are both things a user means;
    // only values below the floor, or past what a machine could hold, move.
    assert_eq!(cfg.ngl, 999);
    assert_eq!(cfg.ctx_size, 512);
    assert_eq!(cfg.batch_size, 1);
    assert_eq!(cfg.ubatch_size, 1);
    assert_eq!(cfg.keep, 131_072);
    assert_eq!(cfg.cache_type_k, "f16");
    assert_eq!(cfg.cache_type_v, "f16");
    assert_eq!(cfg.n_cpu_moe, 64);
    assert_eq!(cfg.threads, 64);
    assert_eq!(cfg.temperature, 2.0);
    assert_eq!(cfg.top_p, 0.01);
    assert_eq!(cfg.top_k, 200);
    assert_eq!(cfg.spec_draft_n_max, 64);
    assert_eq!(cfg.spec_draft_p_min, 1.0);
    assert_eq!(cfg.spec_draft_p_split, 0.0);
    assert_eq!(cfg.reasoning, "auto");
    assert_eq!(cfg.reasoning_format, "auto");
    assert_eq!(cfg.reasoning_effort, "default");
    assert_eq!(cfg.reasoning_budget, -1);
    assert_eq!(cfg.reasoning_preserve, "auto");
    assert_eq!(cfg.flash_attn, "auto");
}

#[test]
fn advanced_settings_round_trip_and_protect_app_owned_fields() {
    let mut cfg = AppConfig {
        server_args: vec!["--min-p".into(), "0.05".into()],
        ..AppConfig::default()
    };
    cfg.chat_options
        .insert("dry_multiplier".into(), serde_json::json!(0.8));
    let migrated = migrate(cfg).expect("advanced settings should validate");
    assert_eq!(migrated.server_args, ["--min-p", "0.05"]);
    assert_eq!(
        migrated.chat_options["dry_multiplier"],
        serde_json::json!(0.8)
    );

    let blocked_server_arg = AppConfig {
        server_args: vec!["--host=0.0.0.0".into()],
        ..AppConfig::default()
    };
    assert!(blocked_server_arg.validate().is_err());

    let mut blocked_chat_option = AppConfig::default();
    blocked_chat_option
        .chat_options
        .insert("stream".into(), serde_json::json!(false));
    assert!(blocked_chat_option.validate().is_err());
}

#[test]
fn defaults_are_model_neutral() {
    let cfg = AppConfig::default();
    // Where the data folder itself resolves to is covered by `home`'s tests.
    assert_eq!(
        Path::new(&cfg.models_dir),
        crate::home::aiolm_home().join("models")
    );
    assert_eq!(cfg.ngl, 99);
    assert_eq!(cfg.ctx_size, 4096);
    assert_eq!(cfg.batch_size, 2048);
    assert_eq!(cfg.ubatch_size, 512);
    assert_eq!(cfg.keep, 0);
    assert_eq!(cfg.cache_type_k, "f16");
    assert_eq!(cfg.cache_type_v, "f16");
    assert_eq!(cfg.flash_attn, "auto");
    assert_eq!(cfg.temperature, 0.8);
    assert_eq!(cfg.top_p, 0.95);
    assert_eq!(cfg.top_k, 40);
    assert_eq!(cfg.spec_type, "none");
    assert_eq!(cfg.spec_draft_n_max, 3);
    assert_eq!(cfg.spec_draft_ngl, "auto");
    assert_eq!(cfg.reasoning, "auto");
    assert_eq!(cfg.reasoning_format, "auto");
    assert_eq!(cfg.reasoning_effort, "default");
    assert_eq!(cfg.reasoning_preserve, "auto");
    assert!(cfg.server_args.is_empty());
    assert!(cfg.chat_options.is_empty());
}

#[test]
fn advanced_args_cannot_override_dedicated_settings() {
    for name in [
        "--n-gpu-layers",
        "--gpu-layers",
        "-ngl",
        "--ctx-size",
        "-c",
        "--batch-size",
        "-b",
        "--ubatch-size",
        "-ub",
        "--keep",
        "--cache-type-k",
        "-ctk",
        "--cache-type-v",
        "-ctv",
        "--flash-attn",
        "-fa",
        "--n-cpu-moe",
        "--threads",
        "-t",
        "--parallel",
        "-np",
        "--timeout",
        "-to",
        "--sleep-idle-seconds",
        "--lora",
        "--lora-scaled",
        "--spec-type",
        "--spec-draft-n-max",
        "--spec-draft-n-min",
        "--spec-draft-p-min",
        "--draft-p-min",
        "--spec-draft-p-split",
        "--draft-p-split",
        "--spec-draft-ngl",
        "--gpu-layers-draft",
        "--n-gpu-layers-draft",
        "--spec-draft-device",
        "-devd",
        "--device-draft",
        "--spec-draft-model",
        "-md",
        "--model-draft",
        "--reasoning",
        "-rea",
        "--reasoning-format",
        "--reasoning-effort",
        "--reasoning-budget",
        "--reasoning-budget-message",
        "--reasoning-preserve",
        "--no-reasoning-preserve",
    ] {
        let cfg = AppConfig {
            server_args: vec![name.into(), "value".into()],
            ..AppConfig::default()
        };
        assert!(cfg.validate().is_err(), "{name} should be app-managed");
    }
}

/// build_args only supplies --cont-batching/--no-webui when server_args is
/// silent (see build_args_recognizes_cont_batching_and_webui_aliases in
/// server.rs), so these spellings must stay user-overridable here too.
#[test]
fn advanced_args_allow_cont_batching_and_webui_overrides() {
    for name in [
        "--cont-batching",
        "-cb",
        "--no-cont-batching",
        "-nocb",
        "--webui",
        "--ui",
        "--no-webui",
        "--no-ui",
    ] {
        let cfg = AppConfig {
            server_args: vec![name.into()],
            ..AppConfig::default()
        };
        assert!(cfg.validate().is_ok(), "{name} should remain overridable");
    }
}

#[test]
fn atomic_write_replaces_complete_content() {
    let root = std::env::temp_dir().join(format!("aiolm-config-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp directory");
    let path = root.join("config.json");
    atomic_write(&path, br#"{"version":1}"#).expect("first write");
    atomic_write(&path, br#"{"version":2,"safe":true}"#).expect("second write");
    assert_eq!(
        fs::read_to_string(&path).expect("read config"),
        "{\"version\":2,\"safe\":true}"
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn atomic_write_replaces_files_beyond_the_legacy_windows_path_limit() {
    use std::os::windows::ffi::OsStrExt;
    // A Unicode/space home plus ordinary engine/runtime IDs and a
    // help-snapshot file name passes 260 UTF-16 units. Every write and
    // replace must reach the file, not only the std::fs calls.
    let root = std::env::temp_dir().join(format!("aiolm long home 눈길 長い {}", Uuid::new_v4()));
    let dir = root
        .join("runtimes")
        .join("adapters")
        .join("custom.interpreterfixture")
        .join("simple-layout")
        .join("help")
        .join("x".repeat(40));
    let path = dir.join(format!("{}.json", "e".repeat(64)));
    assert!(path.as_os_str().encode_wide().count() > 260, "{path:?}");
    atomic_write(&path, br#"{"version":1}"#).expect("first long-path write");
    atomic_write(&path, br#"{"version":2}"#).expect("long-path replace");
    assert_eq!(
        fs::read_to_string(&path).expect("read long path"),
        "{\"version\":2}"
    );
    assert_eq!(
        fs::read_dir(&dir).expect("list long path").count(),
        1,
        "no temporary file is left behind"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn migration_upgrades_old_config_and_rejects_future_config() {
    let migrated =
        migrate_value(serde_json::json!({ "config_version": 1 })).expect("old config migrates");
    assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
    assert_eq!(migrated.spec_draft_n_max, 3);
    assert_eq!(migrated.spec_draft_p_split, 0.1);
    assert_eq!(migrated.reasoning_budget, -1);
    let future = AppConfig {
        config_version: CURRENT_CONFIG_VERSION + 1,
        ..AppConfig::default()
    };
    assert!(migrate(future).is_err());
}

#[test]
fn versionless_config_migrates_missing_fields_but_preserves_explicit_zeroes() {
    let versionless = serde_json::json!({
        "models_dir": "models",
        "spec_draft_n_max": 0,
        "spec_draft_p_split": 0.0,
        "reasoning_budget": 0
    });
    let parsed: AppConfig =
        serde_json::from_value(versionless.clone()).expect("versionless config");
    assert_eq!(parsed.config_version, 0);
    let migrated = migrate_value(versionless).expect("versionless config migrates");
    assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
    assert_eq!(migrated.spec_draft_n_max, 0);
    assert_eq!(migrated.spec_draft_p_split, 0.0);
    assert_eq!(migrated.reasoning_budget, 0);

    let missing_fields = serde_json::json!({ "config_version": 5 });
    let migrated = migrate_value(missing_fields).expect("missing fields migrate");
    assert_eq!(migrated.spec_draft_n_max, 3);
    assert_eq!(migrated.spec_draft_p_split, 0.1);
    assert_eq!(migrated.reasoning_budget, -1);
}

#[test]
fn v7_config_migrates_without_panicking_and_backfills_batch_defaults() {
    // Every config file written before this change (including this
    // repo's own test fixtures) carries config_version 7 and predates
    // batch_size/ubatch_size/keep/cache_type_k/cache_type_v. The version
    // match previously jumped from `2..=6` straight to
    // `CURRENT_CONFIG_VERSION` (8), so a real v7 config on disk hit
    // `_ => unreachable!()` and panicked on load.
    let v7 = serde_json::json!({ "config_version": 7, "models_dir": "models" });
    let migrated = migrate_value(v7).expect("v7 config migrates without panicking");
    assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
    assert_eq!(migrated.batch_size, default_batch_size());
    assert_eq!(migrated.ubatch_size, default_ubatch_size());
    assert_eq!(migrated.keep, default_keep());
    assert_eq!(migrated.cache_type_k, default_cache_type());
    assert_eq!(migrated.cache_type_v, default_cache_type());
}

#[test]
fn legacy_typed_server_args_migrate_to_fields_and_preserve_unmanaged_args() {
    let legacy = serde_json::json!({
        "config_version": 7,
        "models_dir": "models",
        "server_args": [
            "--batch-size", "1024",
            "-ub", "256",
            "--keep=64",
            "-ctk", "q8_0",
            "--cache-type-v", "q4_0",
            "--parallel", "2",
            "--jinja"
        ]
    });
    let migrated = migrate_value(legacy).expect("legacy typed arguments migrate");
    assert_eq!(migrated.batch_size, 1024);
    assert_eq!(migrated.ubatch_size, 256);
    assert_eq!(migrated.keep, 64);
    assert_eq!(migrated.cache_type_k, "q8_0");
    assert_eq!(migrated.cache_type_v, "q4_0");
    assert_eq!(migrated.parallel, 2);
    assert_eq!(migrated.server_args, ["--jinja"]);

    let explicit = serde_json::json!({
        "config_version": 7,
        "batch_size": 2048,
        "server_args": ["--batch-size", "1024", "--keep", "12"]
    });
    let migrated = migrate_value(explicit).expect("explicit typed values win");
    assert_eq!(migrated.batch_size, 2048);
    assert_eq!(migrated.keep, 12);
}

#[test]
fn model_source_arguments_survive_migration_for_explicit_runtime_review() {
    let args = serde_json::json!(["--hf-repo", "synthetic/old-source", "--fim-qwen-7b-spec"]);
    for version in [7, CURRENT_CONFIG_VERSION] {
        let migrated = migrate_value(serde_json::json!({
            "config_version": version,
            "active_model": "/synthetic/selected.model",
            "server_args": args
        }))
        .unwrap();
        assert_eq!(serde_json::to_value(&migrated.server_args).unwrap(), args);
        assert_eq!(migrated.active_model, "/synthetic/selected.model");
        // Ownership belongs to launch validation, so opening old settings
        // never strips these arguments or replaces the user's selection.
        migrated.validate().unwrap();
    }
}

#[test]
fn v8_config_migrates_without_panicking_and_defaults_the_session_policy() {
    // A config saved before multi-session support existed carries
    // config_version 8 and has never heard of `stop_existing_sessions_on_load`,
    // `sessions`, or `gpu`. The version match must not treat 8 as "future"
    // now that CURRENT_CONFIG_VERSION is 9 (see the v7 regression above
    // for why this class of bug is easy to reintroduce).
    let v8 = serde_json::json!({ "config_version": 8, "models_dir": "models" });
    let migrated = migrate_value(v8).expect("v8 config migrates without panicking");
    assert_eq!(migrated.config_version, CURRENT_CONFIG_VERSION);
    assert!(
        migrated.stop_existing_sessions_on_load,
        "policy must default true for backwards compatibility"
    );
    assert!(migrated.sessions.is_empty());
    assert!(migrated.gpu.is_empty());
}

#[test]
fn stop_existing_sessions_on_load_defaults_true_when_field_is_absent() {
    let migrated = migrate_value(serde_json::json!({})).expect("empty config migrates");
    assert!(migrated.stop_existing_sessions_on_load);
    // An explicit `false` must still be honored, i.e. this is a default,
    // not a value pinned by migration.
    let explicit = migrate_value(serde_json::json!({ "stop_existing_sessions_on_load": false }))
        .expect("explicit policy value migrates");
    assert!(!explicit.stop_existing_sessions_on_load);
}

#[test]
fn gpu_placement_flags_are_app_managed() {
    for name in [
        "--device",
        "-dev",
        "--main-gpu",
        "-mg",
        "--split-mode",
        "-sm",
        "--tensor-split",
        "-ts",
    ] {
        let cfg = AppConfig {
            server_args: vec![name.into(), "value".into()],
            ..AppConfig::default()
        };
        assert!(cfg.validate().is_err(), "{name} should be app-managed");
    }
}

#[test]
fn gpu_placement_normalizes_blank_ids_and_rejects_non_finite_tensor_split() {
    let mut gpu = GpuPlacement {
        gpu_ids: vec!["  ".into(), " gpu-a ".into()],
        main_gpu: Some("  ".into()),
        draft_gpu_id: Some(" gpu-b ".into()),
        tensor_split: vec![f32::NAN, -1.0, 0.5],
        ..GpuPlacement::default()
    };
    gpu.normalize();
    assert_eq!(gpu.gpu_ids, vec!["gpu-a".to_string()]);
    assert_eq!(gpu.main_gpu, None);
    assert_eq!(gpu.draft_gpu_id, Some("gpu-b".to_string()));
    assert_eq!(gpu.tensor_split, vec![0.0, 0.0, 0.5]);

    let invalid = GpuPlacement {
        tensor_split: vec![f32::INFINITY],
        ..GpuPlacement::default()
    };
    assert!(invalid.validate().is_err());
    assert!(GpuPlacement::default().validate().is_ok());
}

#[test]
fn gpu_placement_requires_main_gpu_to_be_one_of_the_selected_gpu_ids() {
    let mismatched = GpuPlacement {
        gpu_ids: vec!["gpu-a".into()],
        main_gpu: Some("gpu-b".into()),
        ..GpuPlacement::default()
    };
    assert!(mismatched.validate().is_err());

    let matching = GpuPlacement {
        gpu_ids: vec!["gpu-a".into(), "gpu-b".into()],
        main_gpu: Some("gpu-b".into()),
        ..GpuPlacement::default()
    };
    assert!(matching.validate().is_ok());

    // Empty gpu_ids (the default/single-GPU path) places no constraint on
    // main_gpu, and an unrelated draft GPU placement stays independent.
    let no_ids = GpuPlacement {
        main_gpu: Some("gpu-a".into()),
        draft_gpu_id: Some("gpu-z".into()),
        ..GpuPlacement::default()
    };
    assert!(no_ids.validate().is_ok());
}

#[test]
fn session_definitions_validate_ids_and_reject_duplicates() {
    let mut cfg = AppConfig {
        sessions: vec![
            SessionDefinition {
                id: "s1".into(),
                models: SessionModels {
                    primary_model: "model.gguf".into(),
                    ..SessionModels::default()
                },
                ..SessionDefinition::default()
            },
            SessionDefinition {
                id: "s2".into(),
                ..SessionDefinition::default()
            },
        ],
        ..AppConfig::default()
    };
    assert!(cfg.validate().is_ok());

    cfg.sessions[1].id = "s1".into();
    assert!(cfg.validate().unwrap_err().contains("duplicate session id"));

    let mut blank_id = AppConfig::default();
    blank_id.sessions.push(SessionDefinition::default());
    assert!(blank_id.validate().is_err());
}

#[test]
fn normalize_deduplicates_and_bounds_session_definitions() {
    let mut cfg = AppConfig::default();
    for _ in 0..(MAX_SESSIONS + 5) {
        cfg.sessions.push(SessionDefinition {
            id: "dup".into(),
            ..SessionDefinition::default()
        });
    }
    cfg.normalize();
    // Every pushed session shares the id "dup", so dedup collapses them
    // to one entry well before the MAX_SESSIONS truncation would matter.
    assert_eq!(cfg.sessions.len(), 1);
}

mod configuration_contract_tests {
    use super::*;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::process::Command;

    const CHILD_MODE: &str = "AIOLM_CONFIG_CONTRACT_CHILD";
    const OWNED_MARKER: &str = "synthetic-config-contract-v1";

    struct OwnedHome(PathBuf);

    impl OwnedHome {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("aiolm-config-contract-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("owned-fixture.marker"), OWNED_MARKER).unwrap();
            Self(path)
        }
    }

    impl Drop for OwnedHome {
        fn drop(&mut self) {
            // Only this object's newly-created UUID directory is removed.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn synthetic_config() -> AppConfig {
        AppConfig {
            models_dir: "models".into(),
            ..AppConfig::default()
        }
    }

    fn saved_value(cfg: &AppConfig) -> Value {
        // Preserve the same f32 number spelling as the actual saved format.
        serde_json::from_slice(&serde_json::to_vec(cfg).unwrap()).unwrap()
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn inherited_session(id: &str) -> SessionDefinition {
        SessionDefinition {
            id: id.into(),
            name: " owned session ".into(),
            models: SessionModels {
                primary_model: " primary.gguf ".into(),
                mmproj: " vision.gguf ".into(),
                draft_model: " draft.gguf ".into(),
            },
            model_profile_id: Some(" profile-owned ".into()),
            ..SessionDefinition::default()
        }
    }

    #[test]
    fn normalization_preserves_complete_configuration_and_session_bindings() {
        for mode in ["empty", "inherited", "override", "deduplicate-and-bound"] {
            let mut cfg = synthetic_config();
            cfg.port = 0;
            cfg.ctx_size = 256;
            cfg.ngl = 1_000;
            cfg.temperature = 99.0;
            cfg.active_provider = " llama.cpp ".into();
            cfg.active_runtime = " ".into();
            cfg.gpu.gpu_ids = vec![" gpu-a ".into(), " ".into()];
            cfg.gpu.main_gpu = Some(" gpu-a ".into());
            cfg.gpu.tensor_split = vec![-1.0, 2.0];
            cfg.gpu.draft_gpu_id = Some(" ".into());
            match mode {
                "empty" => {}
                "inherited" => cfg.sessions.push(inherited_session(" inherited ")),
                "override" => {
                    let mut session = inherited_session(" isolated ");
                    session.execution = Some(
                        json!({"temperature":99,"ctx_size":256,"spec_draft_p_min":0.3})
                            .as_object()
                            .unwrap()
                            .clone(),
                    );
                    cfg.sessions.push(session);
                }
                "deduplicate-and-bound" => {
                    cfg.sessions.push(inherited_session(" session-0 "));
                    let mut duplicate = inherited_session("session-0");
                    duplicate.name = "later duplicate must disappear".into();
                    cfg.sessions.push(duplicate);
                    for index in 1..70 {
                        cfg.sessions
                            .push(inherited_session(&format!(" session-{index} ")));
                    }
                }
                _ => unreachable!(),
            }
            let mut expected = cfg.clone();
            expected.port = 8080;
            expected.ctx_size = 512;
            expected.ngl = 999;
            expected.temperature = 2.0;
            expected.active_provider = "llama.cpp".into();
            expected.active_runtime.clear();
            expected.gpu.gpu_ids = vec!["gpu-a".into()];
            expected.gpu.main_gpu = Some("gpu-a".into());
            expected.gpu.tensor_split = vec![0.0, 2.0];
            expected.gpu.draft_gpu_id = None;
            if mode == "deduplicate-and-bound" {
                expected.sessions.remove(1);
                expected.sessions.truncate(64);
            }
            for session in &mut expected.sessions {
                session.id = session.id.trim().into();
                session.name = "owned session".into();
                session.models.primary_model = "primary.gguf".into();
                session.models.mmproj = "vision.gguf".into();
                session.models.draft_model = "draft.gguf".into();
                session.model_profile_id = Some("profile-owned".into());
                if let Some(execution) = &mut session.execution {
                    execution.insert("temperature".into(), json!(2.0));
                    execution.insert("ctx_size".into(), json!(512));
                }
            }
            cfg.normalize();
            assert_eq!(saved_value(&cfg), saved_value(&expected), "{mode}");
            cfg.validate().unwrap();
            let once = saved_value(&cfg);
            cfg.normalize();
            assert_eq!(saved_value(&cfg), once, "second normalization: {mode}");
            println!(
                "CONFIG_CONTRACT {}",
                json!({"case":mode,"configuration":once})
            );
        }
    }

    #[test]
    fn session_validation_preserves_definition_execution_and_duplicate_error_order() {
        let invalid_patch = json!({"port":9000}).as_object().unwrap().clone();
        let mut cases = Vec::new();
        let mut invalid_id = synthetic_config();
        invalid_id.sessions.push(SessionDefinition {
            execution: Some(invalid_patch.clone()),
            ..SessionDefinition::default()
        });
        cases.push((
            "id-before-execution",
            invalid_id,
            "session id must be a non-empty string up to 128 characters",
        ));
        let mut execution_before_duplicate = synthetic_config();
        execution_before_duplicate.sessions = vec![
            SessionDefinition {
                id: "same".into(),
                ..SessionDefinition::default()
            },
            SessionDefinition {
                id: "same".into(),
                execution: Some(invalid_patch),
                ..SessionDefinition::default()
            },
        ];
        cases.push((
            "execution-before-duplicate",
            execution_before_duplicate,
            "unsupported execution setting: port",
        ));
        let mut duplicate_before_gpu = synthetic_config();
        duplicate_before_gpu.sessions = vec![
            SessionDefinition {
                id: "same".into(),
                ..SessionDefinition::default()
            },
            SessionDefinition {
                id: "same".into(),
                ..SessionDefinition::default()
            },
        ];
        duplicate_before_gpu.gpu.gpu_ids = vec!["gpu-a".into()];
        duplicate_before_gpu.gpu.main_gpu = Some("missing".into());
        cases.push((
            "duplicate-before-gpu",
            duplicate_before_gpu,
            "duplicate session id: same",
        ));
        let mut gpu_before_library = synthetic_config();
        gpu_before_library.gpu.gpu_ids = vec!["gpu-a".into()];
        gpu_before_library.gpu.main_gpu = Some("missing".into());
        gpu_before_library
            .settings_profiles
            .as_mut()
            .unwrap()
            .version = 99;
        cases.push((
            "gpu-before-library",
            gpu_before_library,
            "main_gpu 'missing' must be one of the selected gpu_ids",
        ));
        let mut count_before_id = synthetic_config();
        count_before_id.sessions = vec![SessionDefinition::default(); 65];
        cases.push((
            "count-before-id",
            count_before_id,
            "too many saved sessions (max 64)",
        ));
        for (name, cfg, expected) in cases {
            let before = saved_value(&cfg);
            let error = cfg.validate().unwrap_err();
            assert_eq!(error, expected, "{name}");
            assert_eq!(
                saved_value(&cfg),
                before,
                "validate must not mutate: {name}"
            );
            println!(
                "CONFIG_CONTRACT {}",
                json!({"case":name,"error":error,
            "configuration":before})
            );
        }
    }

    fn run_isolated_child(mode: &str) {
        let home = OwnedHome::new();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "config::tests::configuration_contract_tests::isolated_public_config_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_MODE, mode)
            .env("AIOLM_HOME", &home.0)
            .output()
            .unwrap();
        // The child is reaped before any parent assertion and its own directory
        // is removed by RAII even if status/assertion fails.
        print!("{}", String::from_utf8_lossy(&output.stdout));
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        assert!(
            output.status.success(),
            "child mode {mode}: {}",
            output.status
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("CONFIG_CHILD_DONE"));
    }

    #[test]
    fn public_load_preserves_presence_schema_backup_and_error_contracts() {
        for mode in [
            "missing",
            "current",
            "freshness",
            "onboarding-absent",
            "legacy",
            "existing-backup",
            "versionless",
            "legacy-absent",
            "typed-present",
            "typed-absent",
            "malformed-json",
            "malformed-type",
            "future",
        ] {
            run_isolated_child(mode);
        }
    }

    #[test]
    fn isolated_public_config_child() {
        let Ok(mode) = std::env::var(CHILD_MODE) else {
            return;
        };
        let root = PathBuf::from(std::env::var_os("AIOLM_HOME").unwrap());
        assert!(root.is_absolute());
        assert!(root.starts_with(std::env::temp_dir()));
        assert_eq!(
            fs::read_to_string(root.join("owned-fixture.marker")).unwrap(),
            OWNED_MARKER
        );
        assert_eq!(config_path(), root.join("config.json"));
        let path = config_path();
        let original_version = match mode.as_str() {
            "versionless" => 0,
            "legacy-absent" => 1,
            _ => 13,
        };
        let old_case = matches!(
            mode.as_str(),
            "legacy" | "existing-backup" | "versionless" | "legacy-absent"
        );
        let backup = path.with_extension(format!(
            "v{original_version}-before-v{CURRENT_CONFIG_VERSION}.json"
        ));
        let source_cfg = synthetic_config();
        let mut source = saved_value(&source_cfg);
        let mut original = None;
        if mode != "missing" {
            match mode.as_str() {
                "current" | "freshness" => {
                    source["owned_unknown"] = json!({"retained":true});
                }
                "onboarding-absent" => {
                    source
                        .as_object_mut()
                        .unwrap()
                        .remove("onboarding_completed");
                }
                "legacy" | "existing-backup" | "versionless" | "legacy-absent" => {
                    source["config_version"] = json!(original_version);
                    source["owned_unknown"] = json!({"exact_original":true});
                    source["ctx_size"] = json!(0);
                    source["stop_existing_sessions_on_load"] = json!(false);
                    if mode == "versionless" {
                        source.as_object_mut().unwrap().remove("config_version");
                        source["spec_draft_n_max"] = json!(0);
                        source["spec_draft_p_split"] = json!(0.0);
                        source["reasoning_budget"] = json!(0);
                    }
                    if mode == "legacy-absent" {
                        for field in [
                            "spec_draft_n_max",
                            "spec_draft_p_split",
                            "reasoning_budget",
                            "flash_attn",
                            "iters",
                        ] {
                            source.as_object_mut().unwrap().remove(field);
                        }
                    }
                }
                "typed-present" | "typed-absent" => {
                    source["server_args"] = json!([
                        "--ctx-size",
                        "2048",
                        "--verbose",
                        "--sleep-idle-seconds",
                        "-1"
                    ]);
                    if mode == "typed-absent" {
                        source.as_object_mut().unwrap().remove("ctx_size");
                    } else {
                        source["ctx_size"] = json!(8192);
                    }
                }
                "malformed-json" => {}
                "malformed-type" => {
                    source["port"] = json!("not-a-port");
                }
                "future" => {
                    source["config_version"] = json!(CURRENT_CONFIG_VERSION + 1);
                }
                _ => panic!("unknown child mode: {mode}"),
            }
            let bytes = if mode == "malformed-json" {
                b"{\n  invalid owned fixture\n".to_vec()
            } else {
                let mut bytes = serde_json::to_vec_pretty(&source).unwrap();
                bytes.push(b'\n');
                bytes
            };
            fs::write(&path, &bytes).unwrap();
            original = Some(bytes);
        }
        if mode == "existing-backup" {
            fs::write(&backup, b"first owned recovery point\n").unwrap();
        }
        let mut result = load_result();
        let mut fact = json!({"case":mode});
        if mode == "freshness" {
            let first = result.as_ref().unwrap();
            assert_eq!(saved_value(first), saved_value(&source_cfg));
            assert_eq!(fs::read(&path).unwrap(), *original.as_ref().unwrap());
            fact["first_configuration"] = saved_value(first);
            source["ctx_size"] = json!(16_384);
            let mut changed = serde_json::to_vec_pretty(&source).unwrap();
            changed.push(b'\n');
            fs::write(&path, &changed).unwrap();
            original = Some(changed);
            // Same process, same public path and same home: a second call must
            // actually observe the changed disk document, without rewriting it.
            result = load_result();
        }
        match mode.as_str() {
            "malformed-json" | "malformed-type" | "future" => {
                let error = result.unwrap_err();
                assert_eq!(error.kind, crate::error::ErrorKind::Validation);
                if mode == "future" {
                    assert_eq!(
                        error.message,
                        format!(
                            "config schema {} is newer than this app supports (current {})",
                            CURRENT_CONFIG_VERSION + 1,
                            CURRENT_CONFIG_VERSION
                        )
                    );
                } else {
                    assert!(error
                        .message
                        .starts_with(&format!("invalid config at {}:", path.display())));
                }
                assert_eq!(fs::read(&path).unwrap(), *original.as_ref().unwrap());
                assert!(!backup.exists());
                fact["error"] = json!(error
                    .message
                    .replace(&path.to_string_lossy().to_string(), "<owned-config-path>"));
            }
            _ => {
                let cfg = result.unwrap();
                cfg.validate().unwrap();
                assert_eq!(cfg.config_version, CURRENT_CONFIG_VERSION);
                match mode.as_str() {
                    "missing" => {
                        let expected = AppConfig::default();
                        assert_eq!(saved_value(&cfg), saved_value(&expected));
                        assert_eq!(
                            cfg.models_dir,
                            root.join("models").to_string_lossy().into_owned()
                        );
                        assert!(!cfg.onboarding_completed);
                        assert!(!path.exists());
                    }
                    "current" => {
                        assert_eq!(saved_value(&cfg), saved_value(&source_cfg));
                    }
                    "freshness" => {
                        let mut expected = source_cfg.clone();
                        expected.ctx_size = 16_384;
                        assert_eq!(saved_value(&cfg), saved_value(&expected));
                        assert_eq!(cfg.ctx_size, 16_384);
                    }
                    "onboarding-absent" => {
                        assert!(cfg.onboarding_completed);
                    }
                    "legacy" | "existing-backup" | "versionless" | "legacy-absent" => {
                        assert_eq!(cfg.ctx_size, 0);
                        assert!(!cfg.stop_existing_sessions_on_load);
                        if mode == "versionless" {
                            assert_eq!(cfg.spec_draft_n_max, 0);
                            assert_eq!(cfg.spec_draft_p_split, 0.0);
                            assert_eq!(cfg.reasoning_budget, 0);
                        }
                        if mode == "legacy-absent" {
                            assert_eq!(cfg.spec_draft_n_max, 3);
                            assert_eq!(cfg.spec_draft_p_split, 0.1);
                            assert_eq!(cfg.reasoning_budget, -1);
                            assert_eq!(cfg.flash_attn, "auto");
                            assert_eq!(cfg.iters, 5);
                        }
                        assert_eq!(
                            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
                            saved_value(&cfg)
                        );
                        let expected_backup = if mode == "existing-backup" {
                            b"first owned recovery point\n".as_slice()
                        } else {
                            original.as_ref().unwrap().as_slice()
                        };
                        assert_eq!(fs::read(&backup).unwrap(), expected_backup);
                    }
                    "typed-present" | "typed-absent" => {
                        assert_eq!(
                            cfg.ctx_size,
                            if mode == "typed-present" { 8192 } else { 2048 }
                        );
                        assert_eq!(cfg.sleep_idle_seconds, -1);
                        assert_eq!(cfg.server_args, vec!["--verbose"]);
                    }
                    _ => unreachable!(),
                }
                if mode != "missing" && !old_case {
                    assert_eq!(
                        fs::read(&path).unwrap(),
                        *original.as_ref().unwrap(),
                        "current schema must not rewrite"
                    );
                    assert!(!backup.exists());
                }
                let mut configuration = saved_value(&cfg);
                if mode == "missing" {
                    // Above assertion verifies the exact runtime-resolved path;
                    // normalize only that known owned path for cross-run facts.
                    configuration["models_dir"] = json!("<owned-home>/models");
                }
                fact["configuration"] = configuration;
            }
        }
        let mut files = fs::read_dir(&root)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let bytes = fs::read(entry.path()).unwrap();
                json!({"name":entry.file_name().to_string_lossy(),"bytes":bytes.len(),
            "sha256":digest(&bytes),"utf8":String::from_utf8(bytes).unwrap()})
            })
            .collect::<Vec<_>>();
        files.sort_by_key(|file| file["name"].as_str().unwrap().to_owned());
        let actual_names = files
            .iter()
            .map(|file| file["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        let mut expected_names = vec!["owned-fixture.marker".to_owned()];
        if mode != "missing" {
            expected_names.push("config.json".to_owned());
        }
        if old_case {
            expected_names.push(backup.file_name().unwrap().to_string_lossy().into_owned());
        }
        expected_names.sort();
        assert_eq!(
            actual_names,
            expected_names
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        fact["files"] = json!(files);
        println!("CONFIG_LOAD_FACT {}", fact);
        println!("CONFIG_CHILD_DONE");
    }
}
