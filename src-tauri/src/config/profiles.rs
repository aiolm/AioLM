//! Reusable execution settings and independently saved application snapshots.
use super::{execution, AppConfig};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};

const MAX_PROFILES: usize = 1_024;
const MAX_APPLICATIONS: usize = 4_096;
const MAX_LIBRARY_BYTES: usize = 16 * 1_024 * 1_024;
const MAX_PROMPT_BYTES: usize = 262_144;

/// A profile owns provider options, never the selected runtime installation.
/// Mirrors `GLOBAL_PROFILE_KEYS`.
const GLOBAL_FIELDS: &[&str] = &[
    "runtime_defaults",
    "provider_options",
    "ctx_size",
    "batch_size",
    "ubatch_size",
    "keep",
    "cache_type_k",
    "cache_type_v",
    "flash_attn",
    "threads",
    "parallel",
    "request_timeout_seconds",
    "sleep_idle_seconds",
    "temperature",
    "top_p",
    "top_k",
    "chat_options",
    "reasoning",
    "reasoning_format",
    "reasoning_effort",
    "reasoning_budget",
    "reasoning_budget_message",
    "reasoning_preserve",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SettingsProfileLibrary {
    pub version: u32,
    pub revision: u64,
    pub entries: Vec<SettingsProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile_id: Option<String>,
    #[serde(default)]
    pub provider_defaults: BTreeMap<String, String>,
    #[serde(default)]
    pub provider_recent: BTreeMap<String, String>,
    pub applied: BTreeMap<String, ProfileApplication>,
    pub legacy_imported: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProfileScope {
    Model,
    Global,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSourceScope {
    Preset,
    Global,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SettingsProfile {
    #[serde(default = "llama_provider")]
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_runtime: Option<Map<String, Value>>,
    pub id: String,
    pub name: String,
    pub scope: ProfileScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_scope: Option<ProfileSourceScope>,
    pub revision: u64,
    pub settings: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProfileApplication {
    #[serde(default = "llama_provider")]
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_revision: Option<u64>,
    pub settings: Map<String, Value>,
    pub system_prompt: String,
}

/// The initial Default profile owns every global field plus the tuning fields
/// that are otherwise model-scoped, so a new installation inherits the runtime
/// default for each one instead of leaving it on a captured value. Owning
/// fields outside `GLOBAL_FIELDS` is the legacy coverage form.
fn llama_provider() -> String {
    crate::providers::ProviderId::Llama.as_str().into()
}

fn default_profile() -> SettingsProfile {
    let mut defaults = crate::tuning_defaults::keys()
        .filter(|key| model_field(key))
        .collect::<Vec<_>>();
    defaults.sort_unstable();
    let mut coverage = GLOBAL_FIELDS
        .iter()
        .copied()
        .chain(defaults.iter().copied())
        .filter(|key| model_field(key))
        .collect::<Vec<_>>();
    coverage.sort_unstable();
    coverage.dedup();
    SettingsProfile {
        provider: llama_provider(),
        legacy_runtime: None,
        id: "profile-default".into(),
        name: "Default".into(),
        scope: ProfileScope::Global,
        model_key: None,
        source_id: None,
        source_scope: None,
        revision: 1,
        settings: serde_json::from_value(serde_json::json!({
            "runtime_defaults": defaults,
            "chat_options": {}
        }))
        .expect("default settings are an object"),
        system_prompt: Some(String::new()),
        legacy: Some(true),
        coverage: Some(coverage.iter().map(|key| (*key).to_owned()).collect()),
    }
}

fn provider_default(provider: crate::providers::ProviderId) -> SettingsProfile {
    let mut profile = default_profile();
    if provider != crate::providers::ProviderId::Llama {
        profile.provider = provider.as_str().into();
        profile.id = format!("profile-default-{}", provider.as_str());
        profile.settings = Map::from_iter([(
            "provider_options".into(),
            serde_json::json!({provider.as_str(): {}}),
        )]);
        profile.legacy = None;
        profile.coverage = None;
    }
    profile
}

impl Default for SettingsProfileLibrary {
    fn default() -> Self {
        let profile = default_profile();
        let application = ProfileApplication {
            provider: llama_provider(),
            model: String::new(),
            profile_id: Some(profile.id.clone()),
            profile_name: Some(profile.name.clone()),
            profile_revision: Some(profile.revision),
            settings: profile.settings.clone(),
            system_prompt: String::new(),
        };
        let entries = crate::providers::ProviderId::ALL
            .into_iter()
            .map(provider_default)
            .collect::<Vec<_>>();
        let provider_defaults = entries
            .iter()
            .map(|entry| (entry.provider.clone(), entry.id.clone()))
            .collect();
        Self {
            version: 1,
            revision: 0,
            default_profile_id: Some(profile.id.clone()),
            provider_defaults,
            provider_recent: BTreeMap::new(),
            entries,
            applied: BTreeMap::from([("model:".into(), application)]),
            legacy_imported: false,
        }
    }
}

fn model_key(path: &str) -> String {
    let path = path.trim();
    // Scanned POSIX paths are absolute. Keep their case and literal backslashes;
    // Windows and legacy relative paths retain their existing saved identities.
    if path.starts_with('/') && !path.starts_with("//") {
        return format!("model:{path}");
    }
    let lower = path.to_lowercase();
    let display = if lower.starts_with("\\\\?\\unc\\") {
        format!("\\\\{}", &path[8..])
    } else if lower.starts_with("\\\\?\\") {
        path[4..].to_owned()
    } else {
        path.to_owned()
    };
    format!("model:{}", display.replace('\\', "/").to_lowercase())
}

pub fn application_key(model: &str, session: &str, provider: &str) -> String {
    if session != "default" {
        return format!("session:{session}");
    }
    let model = model_key(model);
    if provider == crate::providers::LLAMA_PROVIDER {
        model
    } else {
        format!("provider:{provider}:{model}")
    }
}

/// Original spelling survives in applications even when earlier keys were folded.
fn migrate_model_path_keys(library: &mut SettingsProfileLibrary) -> Result<(), String> {
    let mut applied = BTreeMap::new();
    let mut profile_keys: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    for (key, application) in &library.applied {
        let model = model_key(&application.model);
        let legacy = format!(
            "model:{}",
            application.model.trim().replace('\\', "/").to_lowercase()
        );
        let owned = application_key(&application.model, "default", &application.provider);
        let target = if key == &legacy || key == &model {
            &owned
        } else {
            key
        };
        if applied
            .get(target)
            .is_some_and(|previous| previous != application)
        {
            return Err("conflicting saved settings for the same model path".into());
        }
        applied.insert(target.clone(), application.clone());
        if let Some(id) = &application.profile_id {
            profile_keys.entry(id.clone()).or_default().insert(model);
        }
    }
    for profile in &mut library.entries {
        let Some(keys) = profile_keys.get(&profile.id).filter(|keys| keys.len() == 1) else {
            continue;
        };
        let key = keys.iter().next().unwrap();
        if profile.scope == ProfileScope::Model
            && profile.model_key.as_deref() == Some(key.replace('\\', "/").to_lowercase().as_str())
        {
            profile.model_key = Some(key.clone());
        }
    }
    library.applied = applied;
    Ok(())
}

fn compatible(profile: &SettingsProfile, model: &str) -> bool {
    profile.scope == ProfileScope::Global
        || profile.model_key.as_deref() == Some(model_key(model).as_str())
}

/// Do not duplicate authentication values into reusable execution settings.
fn profile_snapshot(cfg: &AppConfig) -> Map<String, Value> {
    let mut cfg = cfg.clone();
    let arguments = std::mem::take(&mut cfg.server_args);
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        let name = argument.trim().split('=').next().unwrap_or_default();
        if authentication_argument(argument) || super::APP_MANAGED_SERVER_ARGS.contains(&name) {
            if !argument.contains('=') {
                let count = if name == "--lora-scaled" { 2 } else { 1 };
                for _ in 0..count {
                    if arguments.get(index + 1).is_some_and(|value| {
                        !value
                            .trim_start_matches('-')
                            .starts_with(char::is_alphabetic)
                            || !value.starts_with('-')
                    }) {
                        index += 1;
                    }
                }
            }
        } else {
            cfg.server_args.push(argument.clone());
        }
        index += 1;
    }
    let mut settings = execution::snapshot(&cfg);
    settings.remove("active_model");
    settings.retain(|key, _| !runtime_field(key));
    if crate::providers::provider_of(&cfg) == crate::providers::ProviderId::Llama {
        let options =
            crate::providers::launch::provider_options(&cfg, crate::providers::ProviderId::Llama);
        if options.is_empty() {
            settings.remove("provider_options");
        } else {
            settings.insert(
                "provider_options".into(),
                serde_json::json!({"llama.cpp": options}),
            );
        }
    } else {
        let options =
            crate::providers::launch::provider_options(&cfg, crate::providers::provider_of(&cfg));
        settings.retain(|key, _| {
            matches!(
                key.as_str(),
                "provider_options" | "request_timeout_seconds" | "sleep_idle_seconds"
            )
        });
        settings.insert(
            "provider_options".into(),
            serde_json::json!({cfg.active_provider.clone(): options}),
        );
    }
    settings
}

fn expanded_snapshot(application: &ProfileApplication) -> Result<Map<String, Value>, String> {
    let mut cfg = settings_config(&application.settings)?;
    cfg.active_provider = application.provider.clone();
    if !application.settings.contains_key("runtime_defaults") {
        cfg.runtime_defaults = execution::EXECUTION_FIELDS
            .iter()
            .filter(|key| {
                crate::tuning_defaults::is_known(key) && !application.settings.contains_key(**key)
            })
            .map(|key| (*key).to_owned())
            .collect();
        cfg.runtime_defaults.sort_unstable();
    }
    Ok(profile_snapshot(&cfg))
}

fn recovered_profile(
    library: &SettingsProfileLibrary,
    target: &str,
    application: &ProfileApplication,
) -> Result<SettingsProfile, String> {
    let settings = expanded_snapshot(application)?;
    let hash = target
        .encode_utf16()
        .fold(2_166_136_261_u32, |value, unit| {
            (value ^ u32::from(unit)).wrapping_mul(16_777_619)
        });
    let base_id = format!("profile-recovered-{hash:x}");
    let mut id = base_id.clone();
    let mut suffix = 2;
    while library.entries.iter().any(|entry| entry.id == id) {
        id = format!("{base_id}-{suffix}");
        suffix += 1;
    }
    let scope = ProfileScope::Global;
    let key = None;
    let mut name = "Recovered profile".to_owned();
    let mut suffix = 2;
    while library
        .entries
        .iter()
        .any(|entry| entry.provider == application.provider && entry.name == name)
    {
        name = format!("Recovered profile ({suffix})");
        suffix += 1;
    }
    let legacy = (scope == ProfileScope::Global).then_some(true);
    let mut settings = settings;
    settings.retain(|key, _| !runtime_field(key));
    let coverage = legacy.map(|_| settings.keys().cloned().collect());
    Ok(SettingsProfile {
        provider: application.provider.clone(),
        legacy_runtime: None,
        id,
        name,
        scope,
        model_key: key,
        source_id: None,
        source_scope: None,
        revision: 1,
        settings,
        system_prompt: Some(application.system_prompt.clone()),
        legacy,
        coverage,
    })
}

fn text_setting(settings: &Map<String, Value>, key: &str) -> String {
    settings
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// The runtime a profile names, when it names a complete one.
fn runtime_pair(settings: &Map<String, Value>) -> Option<(String, String)> {
    let backend = text_setting(settings, "active_backend");
    let build = text_setting(settings, "active_build");
    (!backend.is_empty() && !build.is_empty()).then_some((backend, build))
}

/// Give every saved profile an explicit runtime.
///
/// Before the runtime pair became a field every profile owns, a profile that
/// did not cover it left `active_backend`/`active_build` at whatever the
/// configuration already held, so a model launched on the last runtime picked
/// anywhere rather than on the one its profile names. Applying such a profile
/// now clears the pair instead, which would refuse every launch after an
/// upgrade. Each profile is therefore seeded with the runtime it was last
/// applied with, falling back to the configuration's own selection.
///
/// This runs once, on the schema upgrade, so a runtime later cleared on
/// purpose — by uninstalling its build, say — stays cleared.
fn adopt_profile_runtimes(library: &mut SettingsProfileLibrary, backend: &str, build: &str) {
    let configured =
        (!backend.is_empty() && !build.is_empty()).then(|| (backend.to_owned(), build.to_owned()));
    for profile in &mut library.entries {
        if profile.provider != crate::providers::LLAMA_PROVIDER {
            continue;
        }
        let selected = runtime_pair(&profile.settings)
            .or_else(|| {
                library
                    .applied
                    .values()
                    .filter(|application| {
                        application.profile_id.as_deref() == Some(profile.id.as_str())
                    })
                    .find_map(|application| runtime_pair(&application.settings))
            })
            .or_else(|| configured.clone());
        let mut legacy = profile.legacy_runtime.take().unwrap_or_default();
        for key in ["active_backend", "active_build"] {
            if let Some(value) = profile.settings.remove(key) {
                legacy.insert(key.into(), value);
            }
        }
        if let Some((backend, build)) = selected {
            legacy.insert("active_backend".into(), Value::String(backend));
            legacy.insert("active_build".into(), Value::String(build));
        }
        profile.legacy_runtime = (!legacy.is_empty()).then_some(legacy);
    }
    separate_profile_runtimes(library);
}

fn separate_profile_runtimes(library: &mut SettingsProfileLibrary) {
    for profile in &mut library.entries {
        let mut legacy = profile.legacy_runtime.take().unwrap_or_default();
        for key in [
            "active_backend",
            "active_build",
            "active_provider",
            "active_runtime",
        ] {
            if let Some(value) = profile.settings.remove(key) {
                legacy.insert(key.into(), value);
            }
        }
        profile.legacy_runtime = (!legacy.is_empty()).then_some(legacy);
        if let Some(coverage) = &mut profile.coverage {
            coverage.retain(|key| !runtime_field(key));
        }
    }
    for application in library.applied.values_mut() {
        application.settings.retain(|key, _| !runtime_field(key));
    }
}

fn share_profiles(library: &mut SettingsProfileLibrary) {
    // Retain each legacy profile and application identity while sharing its
    // original field coverage with every model of the same engine.
    for profile in &mut library.entries {
        if profile.scope == ProfileScope::Model {
            if profile.legacy != Some(true) {
                profile.coverage = Some(
                    execution::EXECUTION_FIELDS
                        .iter()
                        .filter(|key| model_field(key))
                        .map(|key| (*key).to_owned())
                        .collect(),
                );
            }
            profile.legacy = Some(true);
            profile.scope = ProfileScope::Global;
        }
        profile.model_key = None;
        profile.source_id = None;
        profile.source_scope = None;
    }
}

/// Disk migration preserves saved values while giving every target a named owner.
pub(super) fn initialize_profiles(
    cfg: &mut AppConfig,
    had_saved_library: bool,
    adopt_runtimes: bool,
    separate_runtimes: bool,
) -> Result<(), String> {
    let mut library = cfg.settings_profiles.take().unwrap_or_default();
    migrate_model_path_keys(&mut library)?;
    share_profiles(&mut library);
    if library.entries.is_empty() {
        library.entries.push(default_profile());
    }
    let default_index = library
        .entries
        .iter()
        .position(|entry| Some(&entry.id) == library.default_profile_id.as_ref())
        .or_else(|| {
            library
                .entries
                .iter()
                .position(|entry| entry.id == "profile-default")
        })
        .or_else(|| {
            library
                .entries
                .iter()
                .position(|entry| entry.scope == ProfileScope::Global)
        })
        .unwrap_or(0);
    let default = &mut library.entries[default_index];
    if default.scope == ProfileScope::Model {
        let coverage = if default.legacy == Some(true) {
            default.coverage.clone().unwrap_or_else(|| {
                let mut fields = default.settings.keys().cloned().collect::<HashSet<_>>();
                if let Some(values) = default
                    .settings
                    .get("runtime_defaults")
                    .and_then(Value::as_array)
                {
                    fields.extend(values.iter().filter_map(Value::as_str).map(str::to_owned));
                }
                let mut fields = fields.into_iter().collect::<Vec<_>>();
                fields.sort_unstable();
                fields
            })
        } else {
            execution::EXECUTION_FIELDS
                .iter()
                .filter(|key| **key != "active_model")
                .map(|key| (*key).to_owned())
                .collect()
        };
        default.scope = ProfileScope::Global;
        default.model_key = None;
        default.legacy = Some(true);
        default.coverage = Some(coverage);
    }
    default.source_id = None;
    default.source_scope = None;
    library.default_profile_id = Some(default.id.clone());
    if !cfg.active_model.is_empty() {
        library.applied.remove("model:");
    }
    let mut targets = vec![(
        application_key(&cfg.active_model, "default", &cfg.active_provider),
        cfg.clone(),
    )];
    for definition in &cfg.sessions {
        if !definition.models.primary_model.is_empty() && definition.id != "default" {
            targets.push((
                format!("session:{}", definition.id),
                execution::session_config(cfg, definition)?,
            ));
        }
    }
    for (target, execution) in targets {
        if !library.applied.contains_key(&target) || !had_saved_library {
            library.applied.insert(
                target,
                ProfileApplication {
                    provider: execution.active_provider.clone(),
                    model: execution.active_model.clone(),
                    profile_id: None,
                    profile_name: None,
                    profile_revision: None,
                    settings: profile_snapshot(&execution),
                    system_prompt: String::new(),
                },
            );
        }
    }
    let applications = std::mem::take(&mut library.applied);
    for (target, mut application) in applications {
        let selected = library.entries.iter().find(|profile| {
            application.profile_id.as_deref() == Some(profile.id.as_str())
                && profile.provider == application.provider
                && compatible(profile, &application.model)
        });
        if let Some(profile) = selected {
            if application
                .profile_name
                .as_ref()
                .is_none_or(|name| name.trim().is_empty())
            {
                application.profile_name = Some(profile.name.clone());
            }
            if application
                .profile_revision
                .is_none_or(|revision| revision == 0)
            {
                application.profile_revision = Some(profile.revision);
            }
        } else {
            let expanded = expanded_snapshot(&application)?;
            let matching = library.entries.iter().find(|profile| {
                compatible(profile, &application.model)
                    && profile.provider == application.provider
                    && profile.system_prompt.as_deref().unwrap_or_default()
                        == application.system_prompt
                    && (profile.settings == application.settings || profile.settings == expanded)
            });
            let profile = match matching {
                Some(profile) => profile.clone(),
                None => {
                    let profile = recovered_profile(&library, &target, &application)?;
                    library.entries.push(profile.clone());
                    profile
                }
            };
            application.profile_id = Some(profile.id);
            application.profile_name = Some(profile.name);
            application.profile_revision = Some(profile.revision);
        }
        library.applied.insert(target, application);
    }
    if adopt_runtimes {
        adopt_profile_runtimes(&mut library, &cfg.active_backend, &cfg.active_build);
    }
    if separate_runtimes {
        separate_profile_runtimes(&mut library);
    }
    for application in library.applied.values_mut() {
        application.settings.retain(|key, _| !runtime_field(key));
    }
    library.provider_defaults.insert(
        llama_provider(),
        library.default_profile_id.clone().unwrap_or_default(),
    );
    let mut providers = vec![
        crate::providers::ProviderId::Vllm,
        crate::providers::ProviderId::MlxVlm,
    ];
    providers.extend(
        library
            .entries
            .iter()
            .filter_map(|entry| crate::providers::ProviderId::parse(&entry.provider))
            .filter(|id| id.is_custom()),
    );
    let selected = crate::providers::provider_of(cfg);
    if selected.is_custom() {
        providers.push(selected);
    }
    providers.sort();
    providers.dedup();
    for provider in providers {
        if library.entries.iter().any(|entry| {
            Some(&entry.id) == library.provider_defaults.get(provider.as_str())
                && entry.provider == provider.as_str()
                && entry.scope == ProfileScope::Global
        }) {
            continue;
        }
        let mut id = format!("profile-default-{}", provider.as_str());
        let mut suffix = 2;
        while library.entries.iter().any(|entry| {
            entry.id == id
                && (entry.provider != provider.as_str() || entry.scope != ProfileScope::Global)
        }) {
            id = format!("profile-default-{}-{suffix}", provider.as_str());
            suffix += 1;
        }
        if !library.entries.iter().any(|entry| entry.id == id) {
            let mut profile = provider_default(provider);
            profile.id = id.clone();
            library.entries.push(profile);
        }
        library
            .provider_defaults
            .insert(provider.as_str().into(), id);
    }
    library.provider_recent.retain(|provider, id| {
        library
            .entries
            .iter()
            .any(|entry| &entry.id == id && &entry.provider == provider)
    });
    cfg.settings_profiles = Some(library);
    Ok(())
}

fn text_valid(value: &str, field: &str, max: usize, required: bool) -> Result<(), String> {
    if value.len() > max || value.contains('\0') || (required && value.trim().is_empty()) {
        return Err(format!("invalid settings profile {field}"));
    }
    Ok(())
}

fn model_field(key: &str) -> bool {
    key != "active_model" && !runtime_field(key) && execution::EXECUTION_FIELDS.contains(&key)
}

fn runtime_field(key: &str) -> bool {
    matches!(
        key,
        "active_provider" | "active_runtime" | "active_backend" | "active_build"
    )
}

fn authentication_argument(argument: &str) -> bool {
    let name = argument.trim().split('=').next().unwrap_or_default();
    let name = name
        .trim_start_matches('-')
        .chars()
        .filter(|ch| !matches!(ch, '-' | '_'))
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "apikey"
            | "apikeyfile"
            | "authorization"
            | "auth"
            | "credential"
            | "password"
            | "privatekey"
            | "secret"
            | "token"
    )
}

fn settings_config(settings: &Map<String, Value>) -> Result<AppConfig, String> {
    // Deserialize into the established execution types, with no inherited user
    // configuration or nested profile library involved in validation.
    let base = AppConfig {
        models_dir: String::new(),
        settings_profiles: None,
        ..Default::default()
    };
    let mut value = serde_json::to_value(base).map_err(|error| error.to_string())?;
    value
        .as_object_mut()
        .expect("configuration is an object")
        .extend(settings.clone());
    serde_json::from_value(value)
        .map_err(|error| format!("invalid settings profile values: {error}"))
}

fn validate_settings(
    settings: &Map<String, Value>,
    global: bool,
    preserve_uncovered_runtime: bool,
) -> Result<(), String> {
    for (key, value) in settings {
        if !model_field(key) || (global && !GLOBAL_FIELDS.contains(&key.as_str())) {
            return Err(format!("unsupported settings profile field: {key}"));
        }
        if let Some(value) = value.as_str() {
            text_valid(value, key, 32_768, false)?;
        }
    }
    let mut cfg = settings_config(settings)?;
    if preserve_uncovered_runtime && cfg.active_backend.is_empty() != cfg.active_build.is_empty() {
        // Incomplete legacy runtime identities remain recoverable in the source
        // snapshot, but cannot become an applicable runtime selection.
        cfg.active_backend.clear();
        cfg.active_build.clear();
    }
    cfg.validate()
        .map_err(|error| format!("invalid settings profile values: {error}"))?;

    let mut seen = HashSet::new();
    for key in &cfg.runtime_defaults {
        if !model_field(key)
            || (global && !GLOBAL_FIELDS.contains(&key.as_str()))
            || !seen.insert(key)
        {
            return Err(format!("invalid settings profile default field: {key}"));
        }
    }
    if cfg.lora_adapters.len() > 32 {
        return Err("too many settings profile LoRA adapters".into());
    }
    for argument in &cfg.server_args {
        if argument.contains('\0') || authentication_argument(argument) {
            return Err("settings profiles cannot include authentication arguments".into());
        }
    }
    Ok(())
}

impl SettingsProfileLibrary {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!(
                "unsupported settings profile library version: {}",
                self.version
            ));
        }
        if self.entries.is_empty() {
            return Err("at least one settings profile is required".into());
        }
        let default_id = self
            .default_profile_id
            .as_deref()
            .ok_or("a default settings profile is required")?;
        text_valid(default_id, "default profile id", 128, true)?;
        let default = self
            .entries
            .iter()
            .find(|entry| entry.id == default_id)
            .ok_or("the default settings profile cannot be deleted")?;
        if default.scope != ProfileScope::Global {
            return Err("the default settings profile must apply to every model".into());
        }
        for (provider, id) in &self.provider_defaults {
            if crate::providers::ProviderId::parse(provider).is_none()
                || !self.entries.iter().any(|entry| {
                    &entry.id == id
                        && &entry.provider == provider
                        && entry.scope == ProfileScope::Global
                })
            {
                return Err("invalid provider default profile".into());
            }
        }
        for (provider, id) in &self.provider_recent {
            if !self
                .entries
                .iter()
                .any(|entry| &entry.id == id && &entry.provider == provider)
            {
                return Err("invalid recent provider profile".into());
            }
        }
        if self.entries.len() > MAX_PROFILES || self.applied.len() > MAX_APPLICATIONS {
            return Err("too many saved settings profiles or applications".into());
        }
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_LIBRARY_BYTES {
            return Err("settings profile library is too large".into());
        }
        let mut ids = HashSet::new();
        for profile in &self.entries {
            let provider = crate::providers::ProviderId::parse(&profile.provider)
                .ok_or("unknown profile provider")?;
            if profile.settings.keys().any(|key| runtime_field(key)) {
                return Err("profiles cannot select or change the runtime".into());
            }
            if provider != crate::providers::ProviderId::Llama
                && profile.settings.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "provider_options" | "request_timeout_seconds" | "sleep_idle_seconds"
                    )
                })
            {
                return Err("profile contains options belonging to llama.cpp".into());
            }
            if let Some(options) = profile
                .settings
                .get("provider_options")
                .and_then(Value::as_object)
            {
                if options.keys().any(|key| key != provider.as_str()) {
                    return Err("profile contains another provider's options".into());
                }
            }
            text_valid(&profile.id, "id", 128, true)?;
            text_valid(&profile.name, "name", 256, true)?;
            if !ids.insert(&profile.id) {
                return Err(format!("duplicate settings profile id: {}", profile.id));
            }
            if profile.revision == 0 {
                return Err("settings profile revision must be positive".into());
            }
            match (&profile.scope, &profile.model_key) {
                (ProfileScope::Model, Some(model)) => {
                    text_valid(model, "model key", 32_768, true)?;
                }
                (ProfileScope::Global, None) => {}
                _ => return Err("settings profile scope and model key do not match".into()),
            }
            match (&profile.source_id, &profile.source_scope) {
                (None, None) => {}
                (Some(source), Some(_)) if profile.scope == ProfileScope::Model => {
                    text_valid(source, "source id", 128, true)?;
                    if source == &profile.id {
                        return Err("settings profile cannot be its own source".into());
                    }
                }
                _ => return Err("invalid settings profile source".into()),
            }
            let global = profile.scope == ProfileScope::Global && profile.legacy != Some(true);
            let preserve_uncovered_runtime = profile.legacy == Some(true)
                && profile.coverage.as_ref().is_some_and(|fields| {
                    !fields
                        .iter()
                        .any(|field| matches!(field.as_str(), "active_backend" | "active_build"))
                });
            validate_settings(&profile.settings, global, preserve_uncovered_runtime)?;
            if let Some(prompt) = &profile.system_prompt {
                text_valid(prompt, "system prompt", MAX_PROMPT_BYTES, false)?;
            }
            if let Some(coverage) = &profile.coverage {
                let mut seen = HashSet::new();
                if coverage.len() > execution::EXECUTION_FIELDS.len()
                    || coverage.iter().any(|key| {
                        !model_field(key)
                            || (global && !GLOBAL_FIELDS.contains(&key.as_str()))
                            || !seen.insert(key)
                    })
                {
                    return Err("invalid settings profile coverage".into());
                }
            }
        }
        for (target, application) in &self.applied {
            text_valid(target, "application target", 32_768, true)?;
            text_valid(
                &application.model,
                "application model",
                32_768,
                target != &application_key("", "default", &application.provider),
            )?;
            let id = application
                .profile_id
                .as_deref()
                .ok_or("an applied settings profile is required")?;
            text_valid(id, "application profile id", 128, true)?;
            let profile = self
                .entries
                .iter()
                .find(|entry| entry.id == id)
                .ok_or("the applied settings profile no longer exists")?;
            if profile.provider != application.provider
                || !compatible(profile, &application.model)
                || application.model.is_empty() && profile.scope != ProfileScope::Global
            {
                return Err("the applied settings profile belongs to a different model".into());
            }
            let name = application
                .profile_name
                .as_deref()
                .ok_or("an applied settings profile name is required")?;
            text_valid(name, "application profile name", 256, true)?;
            if application
                .profile_revision
                .is_none_or(|revision| revision == 0 || revision > profile.revision)
            {
                return Err("invalid applied settings profile revision".into());
            }
            text_valid(
                &application.system_prompt,
                "application system prompt",
                MAX_PROMPT_BYTES,
                false,
            )?;
            validate_settings(&application.settings, false, false)?;
        }
        Ok(())
    }
}

/// JavaScript sends 1.0 back as 1, while serde_json distinguishes their number
/// representations. Compare those exactly within the JS safe integer range;
/// never round large integers or use a tolerance for changed settings.
fn same_json_value(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            left == right
                || (left.is_f64() != right.is_f64()
                    && left
                        .as_f64()
                        .zip(right.as_f64())
                        .is_some_and(|(a, b)| a == b && a.abs() <= 9_007_199_254_740_991.0))
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| same_json_value(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|other| same_json_value(value, other))
                })
        }
        _ => left == right,
    }
}

fn same_library(
    current: &SettingsProfileLibrary,
    incoming: &SettingsProfileLibrary,
) -> Result<bool, String> {
    if current == incoming {
        return Ok(true);
    }
    if current.revision != incoming.revision {
        return Ok(false);
    }
    let current = serde_json::to_value(current).map_err(|error| error.to_string())?;
    let incoming = serde_json::to_value(incoming).map_err(|error| error.to_string())?;
    Ok(same_json_value(&current, &incoming))
}

/// Call while holding the configuration write lock, using the latest disk value.
pub fn validate_update(
    current: Option<&SettingsProfileLibrary>,
    incoming: Option<&SettingsProfileLibrary>,
) -> Result<(), crate::error::AppError> {
    use crate::error::AppError;
    if let Some(incoming) = incoming {
        incoming.validate().map_err(AppError::validation)?;
        if let Some(current) = current {
            for (target, application) in &current.applied {
                if let Some(id) = &application.profile_id {
                    if !incoming.entries.iter().any(|entry| &entry.id == id) {
                        let replacement = incoming.applied.get(target).ok_or_else(|| {
                            AppError::validation(
                                "deleted profile targets must be assigned to the default profile",
                            )
                        })?;
                        let fallback = incoming
                            .provider_defaults
                            .get(&application.provider)
                            .or(incoming.default_profile_id.as_ref());
                        if replacement.profile_id.as_ref() != fallback
                            || replacement.model != application.model
                            || replacement.provider != application.provider
                        {
                            return Err(AppError::validation(
                                "deleted profile targets must be assigned to the default profile",
                            ));
                        }
                    }
                }
            }
        }
    }
    match (current, incoming) {
        (None, None) => Ok(()),
        (Some(current), Some(incoming))
            if same_library(current, incoming).map_err(AppError::validation)? =>
        {
            Ok(())
        }
        (current, Some(incoming))
            if current.map_or(Some(1), |library| library.revision.checked_add(1))
                == Some(incoming.revision) =>
        {
            Ok(())
        }
        // Another writer saved a newer library: the caller reloads and retries.
        _ => Err(AppError::busy(
            "settings profiles changed since this configuration was opened; reload before saving",
        )),
    }
}

/// Normalize applied values only as part of an accepted new library revision.
/// Reusable profile sources, including legacy partial records, remain unchanged.
pub fn prepare_config_update(
    current: &AppConfig,
    incoming: &AppConfig,
) -> Result<AppConfig, crate::error::AppError> {
    validate_update(
        current.settings_profiles.as_ref(),
        incoming.settings_profiles.as_ref(),
    )?;
    normalize_validated_update(current, incoming).map_err(crate::error::AppError::validation)
}

fn normalize_validated_update(
    current: &AppConfig,
    incoming: &AppConfig,
) -> Result<AppConfig, String> {
    let mut prepared = incoming.clone();
    let current_revision = current
        .settings_profiles
        .as_ref()
        .map(|library| library.revision);
    if prepared
        .settings_profiles
        .as_ref()
        .map(|library| library.revision)
        == current_revision
    {
        // Validation accepted unchanged content. Keep the disk representation
        // instead of rewriting profile snapshots on an unrelated folder save.
        prepared.settings_profiles = current.settings_profiles.clone();
    }
    if let Some(library) = &mut prepared.settings_profiles {
        if Some(library.revision) != current_revision {
            for application in library.applied.values_mut() {
                let mut cfg = settings_config(&application.settings)?;
                cfg.normalize();
                cfg.validate()?;
                let normalized = execution::snapshot(&cfg);
                for (key, value) in &mut application.settings {
                    if let Some(field) = normalized.get(key) {
                        *value = field.clone();
                    }
                }
            }
        }
    }
    if let (Some(previous), Some(library)) =
        (&current.settings_profiles, &prepared.settings_profiles)
    {
        let reassigned = previous
            .applied
            .iter()
            .filter_map(|(target, application)| {
                let removed = application
                    .profile_id
                    .as_ref()
                    .is_some_and(|id| !library.entries.iter().any(|entry| &entry.id == id));
                removed
                    .then(|| {
                        library
                            .applied
                            .get(target)
                            .map(|next| (target.clone(), next.clone()))
                    })
                    .flatten()
            })
            .collect::<Vec<_>>();
        for (target, application) in reassigned {
            let mut effective = settings_config(&application.settings)?;
            effective.active_model = application.model.clone();
            if target
                == application_key(&prepared.active_model, "default", &prepared.active_provider)
                && model_key(&application.model) == model_key(&prepared.active_model)
            {
                effective.active_provider = prepared.active_provider.clone();
                effective.active_runtime = prepared.active_runtime.clone();
                effective.active_backend = prepared.active_backend.clone();
                effective.active_build = prepared.active_build.clone();
                prepared = execution::merge_launch(&prepared, &effective)?;
            } else if let Some(id) = target.strip_prefix("session:") {
                let runtime = prepared
                    .sessions
                    .iter()
                    .find(|entry| entry.id == id)
                    .map(|definition| execution::session_config(&prepared, definition))
                    .transpose()?;
                if let Some(definition) = prepared.sessions.iter_mut().find(|entry| {
                    entry.id == id
                        && model_key(&entry.models.primary_model) == model_key(&application.model)
                }) {
                    if let Some(runtime) = runtime {
                        effective.active_provider = runtime.active_provider;
                        effective.active_runtime = runtime.active_runtime;
                        effective.active_backend = runtime.active_backend;
                        effective.active_build = runtime.active_build;
                    }
                    let mut settings = execution::snapshot(&effective);
                    for binding in ["active_model", "mmproj", "spec_draft_model", "gpu"] {
                        settings.remove(binding);
                    }
                    definition.execution = Some(settings);
                    definition.models.mmproj = effective.mmproj;
                    definition.models.draft_model = effective.spec_draft_model;
                    definition.gpu = effective.gpu;
                }
            }
        }
    }
    Ok(prepared)
}

/// Does this settings snapshot name the runtime that is being removed?
fn names_runtime(settings: &Map<String, Value>, backend: &str, build: &str) -> bool {
    settings.get("active_backend").and_then(Value::as_str) == Some(backend)
        && settings.get("active_build").and_then(Value::as_str) == Some(build)
}

fn clear_runtime(settings: &mut Map<String, Value>) {
    settings.insert("active_backend".into(), Value::String(String::new()));
    settings.insert("active_build".into(), Value::String(String::new()));
}

/// Forget a runtime that is no longer installed.
///
/// Which runtime a model launches with is carried by its profile, so removing a
/// build has to reach the profiles that name it: one left pointing at a deleted
/// directory looks complete in settings and fails at launch. The runtime is
/// cleared rather than repointed at a surviving build, because which one should
/// replace it is a choice, and guessing it would quietly change how a saved
/// model runs.
///
/// Returns whether anything referred to the runtime.
pub fn forget_runtime(cfg: &mut AppConfig, backend: &str, build: &str) -> bool {
    let mut changed = false;
    if cfg.active_backend == backend && cfg.active_build == build {
        cfg.active_backend.clear();
        cfg.active_build.clear();
        changed = true;
    }
    for definition in &mut cfg.sessions {
        if let Some(settings) = definition.execution.as_mut() {
            if names_runtime(settings, backend, build) {
                clear_runtime(settings);
                changed = true;
            }
        }
    }
    if let Some(library) = cfg.settings_profiles.as_mut() {
        let mut library_changed = false;
        for entry in &mut library.entries {
            if names_runtime(&entry.settings, backend, build) {
                clear_runtime(&mut entry.settings);
                entry.revision = entry.revision.saturating_add(1);
                library_changed = true;
            }
        }
        for application in library.applied.values_mut() {
            if names_runtime(&application.settings, backend, build) {
                clear_runtime(&mut application.settings);
                library_changed = true;
            }
        }
        if library_changed {
            library.revision = library.revision.saturating_add(1);
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
#[path = "profiles_tests.rs"]
mod tests;
