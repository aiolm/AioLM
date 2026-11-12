use super::*;

#[test]
fn native_profiles_keep_reviewed_options_without_importing_other_engine_settings() {
    let mut cfg = AppConfig::default();
    assert!(!profile_snapshot(&cfg).contains_key("provider_options"));
    cfg.provider_options.insert(
        "llama.cpp".into(),
        serde_json::from_value(serde_json::json!({"fresh": "한글 value"})).unwrap(),
    );
    cfg.provider_options.insert(
        "vllm".into(),
        serde_json::from_value(serde_json::json!({"max_model_len": 8192})).unwrap(),
    );
    let settings = profile_snapshot(&cfg);
    assert_eq!(
        settings["provider_options"],
        serde_json::json!({"llama.cpp": {"fresh": "한글 value"}})
    );
}
use serde_json::json;

#[test]
fn uninstalling_a_runtime_clears_it_from_every_profile_that_named_it() {
    // Which build a model runs on lives in its profile. Left behind, it looks
    // settled in the editor and fails at launch against a deleted directory.
    let mut cfg = AppConfig {
        active_backend: "vulkan".into(),
        active_build: "b11035".into(),
        ..AppConfig::default()
    };
    let mut library = library();
    for key in ["active_backend", "active_build"] {
        let value = if key == "active_backend" {
            "vulkan"
        } else {
            "b11035"
        };
        library.entries[0].settings.insert(key.into(), json!(value));
        library
            .applied
            .get_mut("model:models/sample.gguf")
            .unwrap()
            .settings
            .insert(key.into(), json!(value));
    }
    let kept = library.entries[1].settings.clone();
    let revision = library.revision;
    cfg.settings_profiles = Some(library);

    assert!(forget_runtime(&mut cfg, "vulkan", "b11035"));

    assert_eq!(cfg.active_backend, "");
    assert_eq!(cfg.active_build, "");
    let library = cfg.settings_profiles.as_ref().unwrap();
    assert_eq!(library.entries[0].settings["active_backend"], json!(""));
    assert_eq!(library.entries[0].settings["active_build"], json!(""));
    assert_eq!(
        library.applied["model:models/sample.gguf"].settings["active_backend"],
        json!("")
    );
    // A profile that named a different build is left exactly as it was.
    assert_eq!(library.entries[1].settings, kept);
    assert!(library.revision > revision);
}

#[test]
fn removing_an_unused_runtime_leaves_the_configuration_untouched() {
    let mut cfg = AppConfig {
        active_backend: "rocm".into(),
        active_build: "b11029".into(),
        settings_profiles: Some(library()),
        ..AppConfig::default()
    };
    let before = cfg.clone();

    assert!(!forget_runtime(&mut cfg, "vulkan", "b11035"));

    assert_eq!(cfg.active_backend, before.active_backend);
    assert_eq!(cfg.settings_profiles, before.settings_profiles);
}

#[test]
fn legacy_runtime_pairs_move_to_metadata_without_changing_profile_values_or_revisions() {
    let mut library = library();
    library
        .applied
        .get_mut("model:models/sample.gguf")
        .unwrap()
        .settings
        .extend(Map::from_iter([
            ("active_backend".into(), json!("cuda")),
            ("active_build".into(), json!("b6215")),
        ]));
    let before = library.entries.clone();
    adopt_profile_runtimes(&mut library, "vulkan", "b11035");
    assert_eq!(
        library.entries[0].legacy_runtime.as_ref().unwrap()["active_backend"],
        json!("cuda")
    );
    assert_eq!(
        library.entries[0].legacy_runtime.as_ref().unwrap()["active_build"],
        json!("b6215")
    );
    assert_eq!(
        library.entries[1].legacy_runtime.as_ref().unwrap()["active_backend"],
        json!("vulkan")
    );
    for (profile, previous) in library.entries.iter().zip(before) {
        assert_eq!(profile.settings, previous.settings);
        assert_eq!(profile.revision, previous.revision);
        assert!(!profile
            .coverage
            .as_ref()
            .is_some_and(|fields| fields.iter().any(|field| runtime_field(field))));
    }
    assert!(library
        .applied
        .values()
        .all(|value| !value.settings.keys().any(|field| runtime_field(field))));
    library.validate().unwrap();
}

#[test]
fn deliberately_cleared_and_partial_runtime_values_are_preserved_only_as_metadata() {
    for (backend, build) in [("rocm", "b11029"), ("rocm", ""), ("", "")] {
        let mut library = library();
        library.entries[0].settings.extend(Map::from_iter([
            ("active_backend".into(), json!(backend)),
            ("active_build".into(), json!(build)),
        ]));
        adopt_profile_runtimes(&mut library, "", "");
        assert_eq!(
            library.entries[0].legacy_runtime.as_ref().unwrap()["active_backend"],
            json!(backend)
        );
        assert_eq!(
            library.entries[0].legacy_runtime.as_ref().unwrap()["active_build"],
            json!(build)
        );
        assert!(!library.entries[0].settings.contains_key("active_backend"));
        library.validate().unwrap();
    }
}

fn library() -> SettingsProfileLibrary {
    let mut library: SettingsProfileLibrary = serde_json::from_value(json!({
        "version": 1, "revision": 1, "legacy_imported": false,
        "default_profile_id": "profile-default",
        "entries": [{"id":"profile-1", "name":"Quiet", "scope":"model",
            "model_key":"model:models/sample.gguf", "revision":1,
            "settings":{"temperature":0.2,"runtime_defaults":["threads"]},
            "system_prompt":"Keep answers brief."}],
        "applied":{"model:models/sample.gguf":{"model":"models/sample.gguf",
            "profile_id":"profile-1", "profile_name":"Quiet", "profile_revision":1,
            "settings":{"temperature":0.2}, "system_prompt":"Keep answers brief."}}
    }))
    .unwrap();
    library.entries.push(default_profile());
    for provider in [
        crate::providers::ProviderId::Vllm,
        crate::providers::ProviderId::MlxVlm,
    ] {
        let profile = provider_default(provider);
        library
            .provider_defaults
            .insert(profile.provider.clone(), profile.id.clone());
        library.entries.push(profile);
    }
    library
        .provider_defaults
        .insert(llama_provider(), "profile-default".into());
    library
}

#[test]
fn posix_model_identity_preserves_case_and_literal_backslashes() {
    assert_ne!(model_key("/models/A.gguf"), model_key("/models/a.gguf"));
    assert_ne!(
        model_key(r"/models/a\b.gguf"),
        model_key("/models/a/b.gguf")
    );
    assert_eq!(
        model_key(r"C:\Models\A.gguf"),
        model_key("c:/models/a.gguf")
    );
    assert_eq!(
        model_key(r"\\?\UNC\Server\Models\A.gguf"),
        model_key("//server/models/a.gguf")
    );
}

#[test]
fn disk_migration_recovers_posix_spelling_and_keeps_saved_profile_values() {
    let mut saved = library();
    let mut application = saved.applied.pop_first().unwrap().1;
    application.model = "/models/Example.gguf".into();
    saved.entries[0].model_key = Some("model:/models/example.gguf".into());
    saved
        .applied
        .insert("model:/models/example.gguf".into(), application.clone());
    saved
        .applied
        .insert("session:kept".into(), application.clone());
    let raw = json!({
        "active_model": application.model,
        "settings_profiles": saved,
        "temperature": 0.8,
        "config_version": super::super::CURRENT_CONFIG_VERSION,
    });
    let migrated = super::super::migrate_value(raw).unwrap();
    let profiles = migrated.settings_profiles.as_ref().unwrap();
    assert_eq!(profiles.revision, saved.revision);
    assert_eq!(profiles.applied["model:/models/Example.gguf"], application);
    assert_eq!(profiles.applied["session:kept"], application);
    assert!(!profiles.applied.contains_key("model:/models/example.gguf"));
    assert_eq!(profiles.entries[0].scope, ProfileScope::Global);
    assert_eq!(profiles.entries[0].model_key, None);
    profiles.validate().unwrap();
    let restored = super::super::migrate_value(serde_json::to_value(&migrated).unwrap()).unwrap();
    assert_eq!(restored.settings_profiles, migrated.settings_profiles);
}

#[test]
fn posix_key_migration_preserves_case_distinct_applications_and_rejects_conflicts() {
    let mut saved = library();
    let mut upper = saved.applied.pop_first().unwrap().1;
    upper.model = "/models/Example.gguf".into();
    let mut lower = upper.clone();
    lower.model = "/models/example.gguf".into();
    lower.system_prompt = "Lowercase model".into();
    saved.applied.insert(model_key(&upper.model), upper.clone());
    saved.applied.insert(model_key(&lower.model), lower.clone());
    migrate_model_path_keys(&mut saved).unwrap();
    assert_eq!(saved.applied[&model_key(&upper.model)], upper);
    assert_eq!(saved.applied[&model_key(&lower.model)], lower);

    let mut conflict = upper.clone();
    conflict.system_prompt = "Different saved prompt".into();
    saved.applied.insert(model_key(&lower.model), conflict);
    let original = saved.clone();
    assert!(migrate_model_path_keys(&mut saved).is_err());
    assert_eq!(saved, original);
}

#[test]
fn models_folder_save_accepts_javascript_number_round_trip() {
    let directory =
        std::env::temp_dir().join(format!("aiolm-profile-ipc-{}", uuid::Uuid::new_v4()));
    let path = directory.join("config.json");
    let mut cfg = AppConfig {
        models_dir: "models".into(),
        active_model: "models/sample.gguf".into(),
        settings_profiles: Some(library()),
        ..Default::default()
    };
    let profiles = cfg.settings_profiles.as_mut().unwrap();
    profiles.entries[0]
        .settings
        .insert("temperature".into(), json!(1.0));
    profiles
        .applied
        .values_mut()
        .next()
        .unwrap()
        .settings
        .insert("temperature".into(), json!(1.0));
    super::super::save_to_path(&cfg, &path).unwrap();
    let current = super::super::load_from_path(&path).unwrap();
    // JSON.stringify(JSON.parse(...)) emits integral JS Numbers as integers.
    let wire = serde_json::to_string(&current)
        .unwrap()
        .replace("\"temperature\":1.0", "\"temperature\":1");
    let mut incoming: AppConfig = serde_json::from_str(&wire).unwrap();
    incoming.models_dir = "new-models".into();
    assert_ne!(incoming.settings_profiles, current.settings_profiles);
    let result = (|| -> Result<(), String> {
        for folder in ["new-models", "other-models"] {
            incoming.models_dir = folder.into();
            let latest = super::super::load_from_path(&path)?;
            let prepared = prepare_config_update(&latest, &incoming)?;
            assert_eq!(prepared.models_dir, folder);
            assert_eq!(prepared.settings_profiles, current.settings_profiles);
            let saved = super::super::save_to_path(&prepared, &path)?;
            let restored = super::super::load_from_path(&path)?;
            assert_eq!(saved.settings_profiles, restored.settings_profiles);
            assert_eq!(restored.models_dir, folder);
        }
        Ok(())
    })();
    // Clean up even when the regression fails.
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(&directory).unwrap();
    result.expect("a folder-only edit must survive the JavaScript IPC round trip");
}

#[test]
fn profile_number_comparison_preserves_revision_conflict_detection() {
    for (disk, wire, accepted) in [
        (
            json!({"nested": [1.0, -1.0, 0.0, 0.25]}),
            json!({"nested": [1, -1, 0, 0.25]}),
            true,
        ),
        (json!(-0.0), json!(0), true),
        (json!(1), json!(1.0), true),
        (
            json!(9_007_199_254_740_991_u64),
            json!(9_007_199_254_740_991.0),
            true,
        ),
        (json!(1.0), json!(1.0000000000000002), false),
        (
            json!(9_007_199_254_740_993_u64),
            json!(9_007_199_254_740_992.0),
            false,
        ),
        (
            json!(-9_007_199_254_740_993_i64),
            json!(-9_007_199_254_740_992.0),
            false,
        ),
        (json!(u64::MAX), json!(u64::MAX - 1), false),
        (json!([1, 2]), json!([2, 1]), false),
        (json!({"value": null}), json!({}), false),
        (json!(1), json!("1"), false),
    ] {
        let mut current = library();
        current.entries[0]
            .settings
            .insert("chat_options".into(), json!({"custom": disk}));
        let mut incoming = current.clone();
        incoming.entries[0]
            .settings
            .insert("chat_options".into(), json!({"custom": wire}));
        assert_eq!(
            validate_update(Some(&current), Some(&incoming)).is_ok(),
            accepted,
            "disk={disk}, wire={wire}"
        );
        incoming.revision = current.revision - 1;
        assert!(validate_update(Some(&current), Some(&incoming)).is_err());
        incoming.revision = current.revision + 1;
        assert!(validate_update(Some(&current), Some(&incoming)).is_ok());
    }
}

#[test]
fn profile_import_validation_preserves_keep_all_and_disabled_top_k() {
    let mut profiles = library();
    for settings in profiles
        .entries
        .iter_mut()
        .filter(|profile| profile.provider == crate::providers::ProviderId::Llama.as_str())
        .map(|profile| &mut profile.settings)
        .chain(
            profiles
                .applied
                .values_mut()
                .filter(|application| {
                    application.provider == crate::providers::ProviderId::Llama.as_str()
                })
                .map(|application| &mut application.settings),
        )
    {
        settings.insert("keep".into(), json!(-1));
        settings.insert("top_k".into(), json!(0));
        settings.insert("temperature".into(), json!(1.5));
    }
    let imported: SettingsProfileLibrary =
        serde_json::from_slice(&serde_json::to_vec(&profiles).unwrap()).unwrap();
    imported.validate().unwrap();
    assert_eq!(imported, profiles);
    for settings in imported
        .entries
        .iter()
        .filter(|profile| profile.provider == crate::providers::ProviderId::Llama.as_str())
        .map(|profile| &profile.settings)
        .chain(
            imported
                .applied
                .values()
                .filter(|application| {
                    application.provider == crate::providers::ProviderId::Llama.as_str()
                })
                .map(|application| &application.settings),
        )
    {
        assert_eq!(settings["keep"], json!(-1));
        assert_eq!(settings["top_k"], json!(0));
        assert_eq!(settings["temperature"], json!(1.5));
    }
}

#[test]
fn profile_updates_require_the_latest_revision_and_at_least_one_entry() {
    let current = library();
    assert!(validate_update(None, Some(&current)).is_ok());
    assert!(validate_update(Some(&current), Some(&current)).is_ok());
    assert!(validate_update(Some(&current), None).is_err());
    let mut edited = current.clone();
    edited.entries[0].name = "Changed".into();
    assert!(validate_update(Some(&current), Some(&edited)).is_err());
    edited.revision += 1;
    assert!(validate_update(Some(&current), Some(&edited)).is_ok());
    // A stale revision is a concurrent-writer conflict the UI reloads and
    // retries; a malformed library is a validation failure it must not retry.
    assert_eq!(
        validate_update(Some(&edited), Some(&current))
            .unwrap_err()
            .kind,
        crate::error::ErrorKind::Busy
    );
    let mut empty = edited.clone();
    empty.entries.clear();
    empty.applied.clear();
    empty.revision += 1;
    assert!(validate_update(Some(&edited), Some(&empty)).is_err());
    assert_eq!(
        validate_update(Some(&empty), Some(&empty))
            .unwrap_err()
            .kind,
        crate::error::ErrorKind::Validation
    );
    empty.revision = 1;
    assert!(validate_update(None, Some(&empty)).is_err());
    assert!(empty.validate().is_err());
    assert!(validate_update(Some(&empty), None).is_err());
    let mut overflow = empty.clone();
    overflow.revision = u64::MAX;
    assert!(validate_update(Some(&overflow), Some(&current)).is_err());
}

#[test]
fn changed_application_and_import_marker_also_require_a_new_revision() {
    let current = library();
    let mut edited = current.clone();
    edited.applied.values_mut().next().unwrap().system_prompt = "Changed prompt".into();
    assert!(validate_update(Some(&current), Some(&edited)).is_err());
    edited.revision += 1;
    assert!(validate_update(Some(&current), Some(&edited)).is_ok());
    let mut imported = current.clone();
    imported.legacy_imported = true;
    assert!(validate_update(Some(&current), Some(&imported)).is_err());
}

#[test]
fn model_copies_preserve_typed_source_metadata_independently_of_the_source() {
    let mut saved = library();
    let profile = &mut saved.entries[0];
    profile.source_id = Some("template-brief".into());
    profile.source_scope = Some(ProfileSourceScope::Global);
    assert!(saved.validate().is_ok());
    let value = serde_json::to_value(&saved).unwrap();
    assert_eq!(value["entries"][0]["source_scope"], json!("global"));
    let restored: SettingsProfileLibrary = serde_json::from_value(value).unwrap();
    assert_eq!(restored, saved);
    saved.entries[0].source_scope = Some(ProfileSourceScope::Preset);
    assert!(saved.validate().is_ok());
}

#[test]
fn source_metadata_requires_a_model_copy_with_a_valid_distinct_source() {
    let saved = library();
    let mut invalid = saved.clone();
    invalid.entries[0].source_id = Some("template-brief".into());
    assert!(invalid.validate().is_err());
    invalid.entries[0].source_scope = Some(ProfileSourceScope::Global);
    invalid.entries[0].scope = ProfileScope::Global;
    invalid.entries[0].model_key = None;
    assert!(invalid.validate().is_err());
    let mut invalid = saved.clone();
    invalid.entries[0].source_scope = Some(ProfileSourceScope::Preset);
    assert!(invalid.validate().is_err());
    invalid.entries[0].source_id = Some(invalid.entries[0].id.clone());
    assert!(invalid.validate().is_err());
    for source in [String::new(), "x".repeat(129), "invalid\0source".into()] {
        invalid.entries[0].source_id = Some(source);
        assert!(invalid.validate().is_err());
    }
    let mut invalid = serde_json::to_value(saved).unwrap();
    invalid["entries"][0]["source_id"] = json!("source");
    invalid["entries"][0]["source_scope"] = json!("model");
    assert!(serde_json::from_value::<SettingsProfileLibrary>(invalid).is_err());
}

#[test]
fn global_profiles_restrict_model_fields_but_preserve_partial_legacy_values() {
    let mut saved = library();
    saved.entries[0].scope = ProfileScope::Global;
    saved.entries[0].model_key = None;
    assert!(saved.validate().is_ok());
    for field in [
        "ngl",
        "n_cpu_moe",
        "gpu",
        "active_backend",
        "spec_type",
        "mmproj",
        "lora_adapters",
        "server_args",
    ] {
        let mut invalid = saved.clone();
        invalid.entries[0].settings.insert(field.into(), json!(0));
        assert!(invalid.validate().is_err(), "{field}");
    }
    saved.entries[0].settings.insert("ngl".into(), json!(8));
    saved.entries[0].legacy = Some(true);
    saved.entries[0].coverage = Some(vec!["ngl".into(), "temperature".into()]);
    assert!(saved.validate().is_ok());
    assert_eq!(saved.entries[0].settings["ngl"], json!(8));
}

#[test]
fn runtime_fields_are_rejected_in_profiles_even_outside_legacy_coverage() {
    for field in [
        "active_backend",
        "active_build",
        "active_provider",
        "active_runtime",
    ] {
        let mut saved = library();
        saved.entries[0].legacy = Some(true);
        saved.entries[0].coverage = Some(vec!["temperature".into()]);
        saved.entries[0]
            .settings
            .insert(field.into(), json!("saved-value"));
        assert!(saved.validate().is_err());
        separate_profile_runtimes(&mut saved);
        assert_eq!(
            saved.entries[0].legacy_runtime.as_ref().unwrap()[field],
            json!("saved-value")
        );
        saved.validate().unwrap();
    }
}

#[test]
fn profile_validation_rejects_unowned_fields_invalid_types_and_default_markers() {
    let valid = library();
    for (field, value) in [
        ("active_model", json!("other.gguf")),
        ("port", json!(9123)),
        ("api_key", json!("synthetic-key")),
        ("sessions", json!([])),
        ("temperature", json!("warm")),
        ("runtime_defaults", json!(["port"])),
        ("runtime_defaults", json!(["threads", "threads"])),
        ("server_args", json!(["--api-key=synthetic-key"])),
        ("server_args", json!(["--ctx-size", "4096"])),
        ("server_args", json!(["--authorization", "synthetic-value"])),
    ] {
        let mut invalid = valid.clone();
        invalid.entries[0]
            .settings
            .insert(field.into(), value.clone());
        assert!(invalid.validate().is_err(), "{field}: {value}");
        let mut invalid = valid.clone();
        invalid
            .applied
            .values_mut()
            .next()
            .unwrap()
            .settings
            .insert(field.into(), value.clone());
        assert!(invalid.validate().is_err(), "application {field}: {value}");
    }
    let mut invalid = valid.clone();
    invalid.entries[0].scope = ProfileScope::Global;
    invalid.entries[0].model_key = None;
    invalid.entries[0]
        .settings
        .insert("runtime_defaults".into(), json!(["ngl"]));
    assert!(invalid.validate().is_err());
}

#[test]
fn profile_validation_rejects_bad_identity_version_and_oversized_values() {
    let valid = library();
    let mut invalid = valid.clone();
    invalid.version = 2;
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.entries.push(invalid.entries[0].clone());
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.entries[0].model_key = None;
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.entries[0].name = "x".repeat(257);
    assert!(invalid.validate().is_err());
    let mut invalid = valid.clone();
    invalid.entries[0].system_prompt = Some("x".repeat(MAX_PROMPT_BYTES + 1));
    assert!(invalid.validate().is_err());
    let mut invalid = serde_json::to_value(valid).unwrap();
    invalid["entries"][0]["scope"] = json!("other");
    assert!(serde_json::from_value::<SettingsProfileLibrary>(invalid).is_err());
}

#[test]
fn launch_merges_preserve_library_even_when_the_launch_draft_has_none() {
    let current = AppConfig {
        models_dir: "models".into(),
        settings_profiles: Some(library()),
        ..Default::default()
    };
    let draft = AppConfig {
        models_dir: "models".into(),
        active_model: "models/next.gguf".into(),
        settings_profiles: None,
        ..Default::default()
    };
    let merged = execution::merge_launch(&current, &draft).unwrap();
    assert_eq!(merged.settings_profiles, current.settings_profiles);
    assert_eq!(merged.active_model, draft.active_model);
}

#[test]
fn atomic_save_keeps_configuration_and_profile_data_together() {
    let directory =
        std::env::temp_dir().join(format!("aiolm-profile-test-{}", uuid::Uuid::new_v4()));
    let path = directory.join("config.json");
    let mut cfg = AppConfig {
        models_dir: "models".into(),
        active_model: "models/sample.gguf".into(),
        ctx_size: 8192,
        settings_profiles: Some(library()),
        ..Default::default()
    };
    super::super::save_to_path(&cfg, &path).unwrap();
    let original = std::fs::read(&path).unwrap();
    let saved: AppConfig = serde_json::from_slice(&original).unwrap();
    assert_eq!(saved.ctx_size, cfg.ctx_size);
    assert_eq!(saved.settings_profiles, cfg.settings_profiles);

    cfg.ctx_size = 16384;
    cfg.settings_profiles.as_mut().unwrap().entries.clear();
    assert!(super::super::save_to_path(&cfg, &path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    cfg.settings_profiles = Some(library());
    cfg.settings_profiles.as_mut().unwrap().version = 2;
    assert!(super::super::save_to_path(&cfg, &path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn new_library_revision_saves_normalized_targets_without_changing_profile_sources() {
    let directory = std::env::temp_dir().join(format!(
        "aiolm-profile-normalize-test-{}",
        uuid::Uuid::new_v4()
    ));
    let path = directory.join("config.json");
    let mut current = AppConfig {
        models_dir: "models".into(),
        settings_profiles: Some(library()),
        ..Default::default()
    };
    current.settings_profiles.as_mut().unwrap().revision = 0;
    let mut cfg = AppConfig {
        models_dir: "models".into(),
        active_model: "models/sample.gguf".into(),
        ctx_size: 256,
        settings_profiles: Some(library()),
        sessions: vec![super::super::SessionDefinition {
            id: "work".into(),
            models: super::super::SessionModels {
                primary_model: "models/work.gguf".into(),
                ..Default::default()
            },
            execution: Some(serde_json::from_value(json!({"ctx_size":256})).unwrap()),
            ..Default::default()
        }],
        ..Default::default()
    };
    let profiles = cfg.settings_profiles.as_mut().unwrap();
    profiles.entries[0]
        .settings
        .insert("ctx_size".into(), json!(256));
    for application in profiles.applied.values_mut() {
        application.settings.insert("ctx_size".into(), json!(256));
    }
    let mut session = profiles.applied.values().next().unwrap().clone();
    session.model = "models/work.gguf".into();
    session.profile_id = Some("profile-work".into());
    let mut session_profile = profiles.entries[0].clone();
    session_profile.id = "profile-work".into();
    session_profile.model_key = Some("model:models/work.gguf".into());
    profiles.entries.push(session_profile);
    profiles.applied.insert("session:work".into(), session);
    let sources = profiles.entries.clone();

    let prepared = prepare_config_update(&current, &cfg).unwrap();
    let saved = super::super::save_to_path(&prepared, &path).unwrap();
    let from_disk: AppConfig = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(from_disk.ctx_size, 512);
    assert_eq!(
        from_disk.sessions[0].execution.as_ref().unwrap()["ctx_size"],
        json!(512)
    );
    let profiles = from_disk.settings_profiles.unwrap();
    assert_eq!(profiles.revision, 1);
    assert_eq!(profiles.entries, sources);
    for application in profiles.applied.values() {
        assert_eq!(application.settings["ctx_size"], json!(512));
        assert_eq!(application.settings["temperature"], json!(0.2));
    }
    assert_eq!(saved.settings_profiles.unwrap(), profiles);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn normalization_cannot_change_a_library_without_an_accepted_revision() {
    let mut current = AppConfig {
        models_dir: "models".into(),
        settings_profiles: Some(library()),
        ..Default::default()
    };
    current
        .settings_profiles
        .as_mut()
        .unwrap()
        .applied
        .values_mut()
        .next()
        .unwrap()
        .settings
        .insert("ctx_size".into(), json!(256));
    let mut incoming = current.clone();
    incoming.port = 9123;
    let prepared = prepare_config_update(&current, &incoming).unwrap();
    assert_eq!(prepared.settings_profiles, current.settings_profiles);
    incoming
        .settings_profiles
        .as_mut()
        .unwrap()
        .applied
        .values_mut()
        .next()
        .unwrap()
        .settings
        .insert("ctx_size".into(), json!(512));
    assert!(prepare_config_update(&current, &incoming).is_err());
    incoming.settings_profiles.as_mut().unwrap().revision += 1;
    let prepared = prepare_config_update(&current, &incoming).unwrap();
    assert_eq!(
        prepared
            .settings_profiles
            .unwrap()
            .applied
            .values()
            .next()
            .unwrap()
            .settings["ctx_size"],
        json!(512)
    );
}

#[test]
fn configurations_without_a_library_preserve_custom_values_in_a_named_profile() {
    let old = json!({
        "config_version":10,"models_dir":"models", "temperature":0.2,
        "active_model":"models/custom.gguf", "ctx_size":16384
    });
    let migrated = super::super::migrate_value(old).unwrap();
    let profiles = migrated.settings_profiles.as_ref().unwrap();
    assert_eq!(profiles.entries.len(), 4);
    assert_eq!(profiles.entries[0].id, "profile-default");
    assert_eq!(profiles.entries[0].name, "Default");
    assert_eq!(profiles.entries[0].scope, ProfileScope::Global);
    assert_eq!(profiles.entries[0].settings.len(), 2);
    assert_eq!(profiles.entries[0].settings["chat_options"], json!({}));
    let markers = profiles.entries[0].settings["runtime_defaults"]
        .as_array()
        .unwrap();
    assert!(markers.contains(&json!("ctx_size")));
    assert!(markers.contains(&json!("temperature")));
    // The seeded profile covers the model-scoped tuning fields as well, so
    // a new library inherits the runtime default for every tuning field.
    assert!(markers.contains(&json!("ngl")));
    assert!(markers
        .iter()
        .all(|value| crate::tuning_defaults::is_known(value.as_str().unwrap())));
    let coverage = profiles.entries[0].coverage.as_ref().unwrap();
    assert!(markers
        .iter()
        .all(|value| coverage.contains(&value.as_str().unwrap().to_owned())));
    assert!(GLOBAL_FIELDS
        .iter()
        .all(|field| coverage.contains(&(*field).to_owned())));
    assert_eq!(migrated.temperature, 0.2);
    assert_eq!(migrated.ctx_size, 16384);
    assert_eq!(migrated.active_model, "models/custom.gguf");
    let application = &profiles.applied["model:models/custom.gguf"];
    let recovered = profiles
        .entries
        .iter()
        .find(|entry| Some(&entry.id) == application.profile_id.as_ref())
        .unwrap();
    assert_eq!(recovered.name, "Recovered profile");
    assert_eq!(recovered.settings["ctx_size"], json!(16384));
    assert_eq!(recovered.settings["temperature"], json!(0.2));
    assert_eq!(recovered.settings, application.settings);
    assert!(!profiles.applied.contains_key("model:"));
    let mut with_profiles = serde_json::to_value(migrated).unwrap();
    with_profiles["settings_profiles"] = serde_json::to_value(library()).unwrap();
    with_profiles["active_model"] = json!("models/sample.gguf");
    let migrated = super::super::migrate_value(with_profiles).unwrap();
    let mut expected = library();
    share_profiles(&mut expected);
    assert_eq!(migrated.settings_profiles, Some(expected));
}

#[test]
fn legacy_model_profiles_become_shared_without_changing_engine_values_or_applications() {
    let mut saved = SettingsProfileLibrary {
        revision: 12,
        ..SettingsProfileLibrary::default()
    };
    for provider in crate::providers::ProviderId::ALL {
        let mut profile = provider_default(provider);
        profile.id = format!("saved-{}", provider.as_str());
        profile.name = "Same name in each engine".into();
        profile.scope = ProfileScope::Model;
        profile.model_key = Some("model:models/old-model".into());
        profile.source_id = Some(format!("source-{}", provider.as_str()));
        profile.source_scope = Some(ProfileSourceScope::Global);
        profile.revision = 8;
        profile.system_prompt = Some("Preserved prompt".into());
        let application = ProfileApplication {
            provider: profile.provider.clone(),
            model: "models/old-model".into(),
            profile_id: Some(profile.id.clone()),
            profile_name: Some(profile.name.clone()),
            profile_revision: Some(7),
            settings: profile.settings.clone(),
            system_prompt: "Saved prompt".into(),
        };
        saved.applied.insert(
            application_key(&application.model, "default", &application.provider),
            application,
        );
        saved.entries.push(profile);
    }
    let restored = super::super::migrate_value(json!({
        "config_version": super::super::CURRENT_CONFIG_VERSION,
        "settings_profiles": saved,
    }))
    .unwrap();
    let profiles = restored.settings_profiles.as_ref().unwrap();
    assert_eq!(profiles.revision, saved.revision);
    assert_eq!(profiles.applied, saved.applied);
    for original in saved
        .entries
        .iter()
        .filter(|entry| entry.scope == ProfileScope::Model)
    {
        let profile = profiles
            .entries
            .iter()
            .find(|entry| entry.id == original.id)
            .unwrap();
        assert_eq!(profile.scope, ProfileScope::Global);
        assert_eq!(profile.provider, original.provider);
        assert_eq!(profile.revision, original.revision);
        assert_eq!(profile.name, original.name);
        assert_eq!(profile.settings, original.settings);
        assert_eq!(profile.system_prompt, original.system_prompt);
        assert!(
            profile.model_key.is_none()
                && profile.source_id.is_none()
                && profile.source_scope.is_none()
        );
    }
    profiles.validate().unwrap();
    let again = super::super::migrate_value(serde_json::to_value(&restored).unwrap()).unwrap();
    assert_eq!(again.settings_profiles, restored.settings_profiles);
}

#[test]
fn the_initial_default_profile_launches_a_model_on_llama_cpp_defaults() {
    let profile = default_profile();
    let mut cfg = AppConfig {
        active_model: "model.gguf".into(),
        ..AppConfig::default()
    };
    cfg.runtime_defaults = profile.settings["runtime_defaults"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    // Every tuning flag is omitted so the runtime applies its own default.
    // GPU layers and context size keep the documented app defaults, and the
    // remaining flags are app-managed rather than tuning values.
    assert_eq!(
        crate::server::build_args(&cfg, "secret"),
        [
            "--model",
            "model.gguf",
            "--host",
            "127.0.0.1",
            "--port",
            "8080",
            "--n-gpu-layers",
            "99",
            "--ctx-size",
            "4096",
            "--cont-batching",
            "--no-webui",
        ]
        .map(String::from)
    );
}

#[test]
fn empty_saved_libraries_recover_profiles_and_keep_saved_application_values() {
    let mut empty = library();
    empty.entries.clear();
    empty.revision = 9;
    empty.legacy_imported = true;
    let migrated = super::super::migrate_value(json!({
        "models_dir": "models", "settings_profiles": empty
    }))
    .unwrap();
    let restored = migrated.settings_profiles.unwrap();
    assert_eq!(restored.entries[0], default_profile());
    assert_eq!(restored.revision, empty.revision);
    assert_eq!(restored.legacy_imported, empty.legacy_imported);
    let application = &restored.applied["model:models/sample.gguf"];
    let original = &empty.applied["model:models/sample.gguf"];
    assert_eq!(application.settings, original.settings);
    assert_eq!(application.system_prompt, original.system_prompt);
    let recovered = restored
        .entries
        .iter()
        .find(|entry| Some(&entry.id) == application.profile_id.as_ref())
        .unwrap();
    assert_eq!(recovered.settings["temperature"], json!(0.2));
    assert_eq!(
        recovered.system_prompt.as_deref(),
        Some(original.system_prompt.as_str())
    );
    assert!(restored.validate().is_ok());
}

#[test]
fn applied_profile_identity_is_required_and_must_reference_a_compatible_revision() {
    let original = library();
    for value in [Value::Null, json!(""), json!("missing-profile")] {
        let mut raw = serde_json::to_value(&original).unwrap();
        raw["applied"]["model:models/sample.gguf"]["profile_id"] = value;
        let invalid: SettingsProfileLibrary = serde_json::from_value(raw).unwrap();
        assert!(invalid.validate().is_err());
        assert!(validate_update(Some(&invalid), Some(&invalid)).is_err());
    }
    for (key, value) in [
        ("profile_name", Value::Null),
        ("profile_name", json!(" ")),
        ("profile_revision", Value::Null),
        ("profile_revision", json!(0)),
        ("profile_revision", json!(2)),
    ] {
        let mut raw = serde_json::to_value(&original).unwrap();
        raw["applied"]["model:models/sample.gguf"][key] = value;
        assert!(serde_json::from_value::<SettingsProfileLibrary>(raw)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut older = original;
    older.entries[0].revision = 3;
    assert!(older.validate().is_ok());
    older.applied.values_mut().next().unwrap().model = "models/different.gguf".into();
    assert!(older.validate().is_err());
    let mut blank = SettingsProfileLibrary::default();
    assert!(blank.validate().is_ok());
    let application = blank.applied.remove("model:").unwrap();
    blank.applied.insert("session:blank".into(), application);
    assert!(blank.validate().is_err());
}

#[test]
fn deleting_an_applied_profile_reassigns_its_targets_to_the_default_in_one_revision() {
    let current = library();
    let mut deleted = current.clone();
    deleted.revision += 1;
    deleted.entries.remove(0);
    deleted.applied.clear();
    assert!(validate_update(Some(&current), Some(&deleted)).is_err());

    deleted.applied = current.applied.clone();
    assert!(validate_update(Some(&current), Some(&deleted)).is_err());
    let application = deleted.applied.values_mut().next().unwrap();
    application.profile_id = Some("profile-default".into());
    application.profile_name = Some("Default".into());
    assert!(validate_update(Some(&current), Some(&deleted)).is_ok());
    let mut stale = deleted.clone();
    stale.revision = current.revision;
    assert!(validate_update(Some(&current), Some(&stale)).is_err());

    let mut deleted_default = current.clone();
    deleted_default
        .entries
        .retain(|entry| entry.id != "profile-default");
    deleted_default.revision += 1;
    assert!(validate_update(Some(&current), Some(&deleted_default)).is_err());

    let promoted = &mut deleted_default.entries[0];
    promoted.scope = ProfileScope::Global;
    promoted.model_key = None;
    deleted_default.default_profile_id = Some(promoted.id.clone());
    deleted_default
        .provider_defaults
        .insert(llama_provider(), promoted.id.clone());
    assert!(validate_update(Some(&current), Some(&deleted_default)).is_ok());
}

#[test]
fn disk_recovery_is_deterministic_and_preserves_orphans_and_isolated_sessions() {
    let mut raw = json!({
        "config_version": 11, "models_dir": "models", "active_model": "models/sample.gguf",
        "temperature": 0.9, "mmproj": "models/private-sidecar.gguf",
        "settings_profiles": library(),
        "sessions": [{"id": "work", "models": {"primary_model": "models/work.gguf"},
            "execution": {"temperature": 0.4, "ctx_size": 8192}}]
    });
    raw["settings_profiles"]["legacy_imported"] = json!(true);
    raw["settings_profiles"]["applied"]["model:models/sample.gguf"]["profile_id"] = Value::Null;
    let first = super::super::migrate_value(raw.clone()).unwrap();
    let second = super::super::migrate_value(raw).unwrap();
    assert_eq!(first.settings_profiles, second.settings_profiles);
    let profiles = first.settings_profiles.as_ref().unwrap();
    let saved = &profiles.applied["model:models/sample.gguf"];
    assert_eq!(
        saved.settings,
        library().applied.values().next().unwrap().settings
    );
    assert_eq!(saved.system_prompt, "Keep answers brief.");
    let recovered = profiles
        .entries
        .iter()
        .find(|entry| Some(&entry.id) == saved.profile_id.as_ref())
        .unwrap();
    assert_eq!(recovered.settings["temperature"], json!(0.2));
    assert_eq!(recovered.settings["mmproj"], json!(""));
    let defaults = recovered.settings["runtime_defaults"].as_array().unwrap();
    assert!(!defaults.contains(&json!("temperature")));
    assert!(defaults.contains(&json!("ctx_size")));
    let session = &profiles.applied["session:work"];
    assert_eq!(session.settings["temperature"], json!(0.4));
    assert_eq!(session.settings["ctx_size"], json!(8192));
    assert_eq!(session.settings["mmproj"], json!(""));
    let restored = super::super::migrate_value(serde_json::to_value(&first).unwrap()).unwrap();
    assert_eq!(restored.settings_profiles, first.settings_profiles);
}

#[test]
fn matching_profiles_are_reused_and_older_application_snapshots_remain_unchanged() {
    let mut profiles = library();
    profiles.entries[0].settings = profiles.applied.values().next().unwrap().settings.clone();
    profiles.applied.values_mut().next().unwrap().profile_id = None;
    let migrated = super::super::migrate_value(json!({
        "models_dir": "models", "active_model": "models/sample.gguf", "settings_profiles": profiles
    }))
    .unwrap();
    let mut profiles = migrated.settings_profiles.unwrap();
    assert_eq!(profiles.entries.len(), 4);
    assert_eq!(
        profiles
            .applied
            .values()
            .next()
            .unwrap()
            .profile_id
            .as_deref(),
        Some("profile-1")
    );
    profiles.entries[0].revision = 4;
    profiles.entries[0]
        .settings
        .insert("temperature".into(), json!(0.6));
    let unchanged = super::super::migrate_value(json!({
        "models_dir": "models", "active_model": "models/sample.gguf", "settings_profiles": profiles
    }))
    .unwrap();
    assert_eq!(unchanged.settings_profiles.as_ref(), Some(&profiles));
}

#[test]
fn default_profile_identity_is_required_and_must_be_portable() {
    let original = library();
    for default_id in [
        None,
        Some(String::new()),
        Some("missing".into()),
        Some("profile-1".into()),
    ] {
        let mut invalid = original.clone();
        invalid.default_profile_id = default_id;
        assert!(invalid.validate().is_err());
    }
    let mut other = default_profile();
    other.id = "preferred".into();
    other.name = "Preferred".into();
    let mut selected = original;
    selected.entries.push(other);
    selected.default_profile_id = Some("preferred".into());
    selected
        .provider_defaults
        .insert(llama_provider(), "preferred".into());
    assert!(selected.validate().is_ok());
    let restored = super::super::migrate_value(json!({
        "models_dir": "models", "active_model": "models/sample.gguf", "settings_profiles": selected
    }))
    .unwrap();
    share_profiles(&mut selected);
    assert_eq!(restored.settings_profiles.as_ref(), Some(&selected));

    let mut same_name = library();
    same_name.entries[0].name = "Default".into();
    same_name.entries[0].scope = ProfileScope::Global;
    same_name.entries[0].model_key = None;
    same_name.default_profile_id = Some("profile-1".into());
    assert!(same_name.validate().is_ok());
}

#[test]
fn legacy_default_selection_repairs_missing_ids_and_promotes_a_model_without_losing_values() {
    for default_id in [Value::Null, json!("missing"), json!("")] {
        let mut raw = serde_json::to_value(library()).unwrap();
        raw["default_profile_id"] = default_id;
        let restored = super::super::migrate_value(json!({
            "models_dir": "models", "active_model": "models/sample.gguf", "settings_profiles": raw
        }))
        .unwrap();
        let mut expected = library();
        share_profiles(&mut expected);
        assert_eq!(restored.settings_profiles.unwrap(), expected);
    }
    let mut only_model = library();
    only_model.entries.retain(|entry| entry.id == "profile-1");
    only_model.default_profile_id = None;
    only_model.entries[0]
        .settings
        .insert("ngl".into(), json!(18));
    only_model.entries[0].source_id = Some("old-source".into());
    only_model.entries[0].source_scope = Some(ProfileSourceScope::Global);
    let original_settings = only_model.entries[0].settings.clone();
    let original_applied = only_model.applied.clone();
    let restored = super::super::migrate_value(json!({
        "models_dir": "models", "active_model": "models/sample.gguf", "settings_profiles": only_model
    })).unwrap().settings_profiles.unwrap();
    assert_eq!(restored.default_profile_id.as_deref(), Some("profile-1"));
    assert_eq!(restored.entries.len(), 3);
    let promoted = &restored.entries[0];
    assert_eq!(promoted.scope, ProfileScope::Global);
    assert_eq!(promoted.settings, original_settings);
    assert_eq!(promoted.name, "Quiet");
    assert_eq!(
        promoted.system_prompt.as_deref(),
        Some("Keep answers brief.")
    );
    assert!(promoted.model_key.is_none());
    assert!(promoted.source_id.is_none());
    assert!(promoted.source_scope.is_none());
    assert_eq!(promoted.legacy, Some(true));
    assert!(promoted.coverage.as_ref().unwrap().contains(&"ngl".into()));
    assert_eq!(restored.applied, original_applied);
}

#[test]
fn every_provider_can_save_and_reload_before_selecting_a_model() {
    let directory =
        std::env::temp_dir().join(format!("aiolm-profile-no-model-{}", uuid::Uuid::new_v4()));
    let path = directory.join("config.json");
    for provider in crate::providers::ProviderId::ALL {
        let cfg = super::super::migrate_value(json!({
            "config_version": super::super::CURRENT_CONFIG_VERSION,
            "models_dir": "models", "active_provider": provider.as_str(),
            "active_model": "", "active_runtime": ""
        }))
        .unwrap();
        cfg.validate().unwrap();
        let key = application_key("", "default", provider.as_str());
        let profiles = cfg.settings_profiles.as_ref().unwrap();
        assert!(profiles.applied[&key].model.is_empty());
        super::super::save_to_path(&cfg, &path).unwrap();
        let loaded = super::super::load_from_path(&path).unwrap();
        assert_eq!(loaded.active_provider, provider.as_str());
        assert!(loaded.active_model.is_empty());
        assert_eq!(loaded.settings_profiles, cfg.settings_profiles);

        let mut invalid = profiles.clone();
        let empty = invalid.applied.remove(&key).unwrap();
        invalid
            .applied
            .insert("session:missing-model".into(), empty.clone());
        assert!(invalid.validate().is_err());
        invalid.applied.remove("session:missing-model");
        invalid.applied.insert("model:missing-model".into(), empty);
        assert!(invalid.validate().is_err());
    }
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn deleting_a_profile_atomically_updates_active_and_session_values_from_the_fallback() {
    let mut profiles = library();
    profiles.entries[0].scope = ProfileScope::Global;
    profiles.entries[0].model_key = None;
    let mut session = profiles.applied.values().next().unwrap().clone();
    session.model = "models/work.gguf".into();
    profiles.applied.insert("session:work".into(), session);
    let current = AppConfig {
        models_dir: "models".into(),
        active_model: "models/sample.gguf".into(),
        port: 9123,
        ctx_size: 16384,
        temperature: 0.2,
        settings_profiles: Some(profiles),
        sessions: vec![super::super::SessionDefinition {
            id: "work".into(),
            name: "Writing".into(),
            enabled: false,
            models: super::super::SessionModels {
                primary_model: "models/work.gguf".into(),
                mmproj: "models/old-sidecar.gguf".into(),
                draft_model: "models/old-draft.gguf".into(),
            },
            execution: Some(
                serde_json::from_value(json!({"ctx_size": 12288, "temperature": 0.1})).unwrap(),
            ),
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut incoming = current.clone();
    let profiles = incoming.settings_profiles.as_mut().unwrap();
    profiles.revision += 1;
    profiles.entries.remove(0);
    for application in profiles.applied.values_mut() {
        application.profile_id = Some("profile-default".into());
        application.profile_name = Some("Default".into());
        application.settings = serde_json::from_value(json!({"ctx_size": 8192, "temperature": 0.8, "mmproj":"models/fallback-sidecar.gguf", "spec_draft_model":"", "runtime_defaults":["threads"]})).unwrap();
        application.system_prompt = String::new();
    }
    let prepared = prepare_config_update(&current, &incoming).unwrap();
    assert_eq!(prepared.port, 9123);
    assert_eq!(prepared.active_model, current.active_model);
    assert_eq!(prepared.ctx_size, 8192);
    assert_eq!(prepared.temperature, 0.8);
    assert_eq!(prepared.mmproj, "models/fallback-sidecar.gguf");
    let definition = &prepared.sessions[0];
    assert_eq!(definition.name, "Writing");
    assert!(!definition.enabled);
    assert_eq!(definition.models.primary_model, "models/work.gguf");
    assert_eq!(definition.models.mmproj, "models/fallback-sidecar.gguf");
    assert!(definition.models.draft_model.is_empty());
    let execution = definition.execution.as_ref().unwrap();
    assert_eq!(execution["ctx_size"], json!(8192));
    assert_eq!(execution["temperature"], json!(0.8));
    for binding in ["active_model", "mmproj", "spec_draft_model", "gpu"] {
        assert!(!execution.contains_key(binding));
    }
    assert!(prepared.validate().is_ok());
    let directory = std::env::temp_dir().join(format!(
        "aiolm-profile-fallback-test-{}",
        uuid::Uuid::new_v4()
    ));
    let path = directory.join("config.json");
    super::super::save_to_path(&prepared, &path).unwrap();
    let persisted: AppConfig = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted.ctx_size, 8192);
    assert_eq!(persisted.sessions, prepared.sessions);
    assert_eq!(persisted.settings_profiles, prepared.settings_profiles);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}
