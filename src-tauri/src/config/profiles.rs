//! Reusable execution settings and independently saved application snapshots.
use super::{execution, AppConfig};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};

const MAX_PROFILES: usize = 1_024;
const MAX_APPLICATIONS: usize = 4_096;
const MAX_LIBRARY_BYTES: usize = 16 * 1_024 * 1_024;
const MAX_PROMPT_BYTES: usize = 262_144;

const GLOBAL_FIELDS: &[&str] = &[
    "runtime_defaults",
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

fn default_profile() -> SettingsProfile {
    let mut defaults = GLOBAL_FIELDS
        .iter()
        .filter(|key| crate::tuning_defaults::is_known(key))
        .copied()
        .collect::<Vec<_>>();
    defaults.sort_unstable();
    SettingsProfile {
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
        legacy: None,
        coverage: None,
    }
}

impl Default for SettingsProfileLibrary {
    fn default() -> Self {
        let profile = default_profile();
        let application = ProfileApplication {
            model: String::new(),
            profile_id: Some(profile.id.clone()),
            profile_name: Some(profile.name.clone()),
            profile_revision: Some(profile.revision),
            settings: profile.settings.clone(),
            system_prompt: String::new(),
        };
        Self {
            version: 1,
            revision: 0,
            default_profile_id: Some(profile.id.clone()),
            entries: vec![profile],
            applied: BTreeMap::from([("model:".into(), application)]),
            legacy_imported: false,
        }
    }
}

fn model_key(path: &str) -> String {
    let path = path.trim();
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
    settings
}

fn expanded_snapshot(application: &ProfileApplication) -> Result<Map<String, Value>, String> {
    let mut cfg = settings_config(&application.settings)?;
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
    let scope = if application.model.is_empty() {
        ProfileScope::Global
    } else {
        ProfileScope::Model
    };
    let key = (scope == ProfileScope::Model).then(|| model_key(&application.model));
    let mut name = "Recovered profile".to_owned();
    let mut suffix = 2;
    while library
        .entries
        .iter()
        .any(|entry| entry.name == name && entry.scope == scope && entry.model_key == key)
    {
        name = format!("Recovered profile ({suffix})");
        suffix += 1;
    }
    let legacy = (scope == ProfileScope::Global).then_some(true);
    let coverage = legacy.map(|_| settings.keys().cloned().collect());
    Ok(SettingsProfile {
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

/// Disk migration preserves saved values while giving every target a named owner.
pub(super) fn initialize_profiles(
    cfg: &mut AppConfig,
    had_saved_library: bool,
) -> Result<(), String> {
    let mut library = cfg.settings_profiles.take().unwrap_or_default();
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
    let mut targets = vec![(model_key(&cfg.active_model), cfg.clone())];
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
    key != "active_model" && execution::EXECUTION_FIELDS.contains(&key)
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
        if self.entries.len() > MAX_PROFILES || self.applied.len() > MAX_APPLICATIONS {
            return Err("too many saved settings profiles or applications".into());
        }
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_LIBRARY_BYTES {
            return Err("settings profile library is too large".into());
        }
        let mut ids = HashSet::new();
        for profile in &self.entries {
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
                target != "model:",
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
            if !compatible(profile, &application.model)
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
) -> Result<(), String> {
    if let Some(incoming) = incoming {
        incoming.validate()?;
        if let Some(current) = current {
            for (target, application) in &current.applied {
                if let Some(id) = &application.profile_id {
                    if !incoming.entries.iter().any(|entry| &entry.id == id) {
                        let replacement = incoming.applied.get(target).ok_or(
                            "deleted profile targets must be assigned to the default profile",
                        )?;
                        if replacement.profile_id != incoming.default_profile_id
                            || replacement.model != application.model
                        {
                            return Err(
                                "deleted profile targets must be assigned to the default profile"
                                    .into(),
                            );
                        }
                    }
                }
            }
        }
    }
    match (current, incoming) {
        (None, None) => Ok(()),
        (Some(current), Some(incoming)) if same_library(current, incoming)? => Ok(()),
        (current, Some(incoming))
            if current.map_or(Some(1), |library| library.revision.checked_add(1))
                == Some(incoming.revision) =>
        {
            incoming.validate()
        }
        _ => Err(
            "settings profiles changed since this configuration was opened; reload before saving"
                .into(),
        ),
    }
}

/// Normalize applied values only as part of an accepted new library revision.
/// Reusable profile sources, including legacy partial records, remain unchanged.
pub fn prepare_config_update(
    current: &AppConfig,
    incoming: &AppConfig,
) -> Result<AppConfig, String> {
    validate_update(
        current.settings_profiles.as_ref(),
        incoming.settings_profiles.as_ref(),
    )?;
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
            if target == model_key(&prepared.active_model)
                && model_key(&application.model) == model_key(&prepared.active_model)
            {
                prepared = execution::merge_launch(&prepared, &effective)?;
            } else if let Some(id) = target.strip_prefix("session:") {
                if let Some(definition) = prepared.sessions.iter_mut().find(|entry| {
                    entry.id == id
                        && model_key(&entry.models.primary_model) == model_key(&application.model)
                }) {
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
mod tests {
    use super::*;
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
        library
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
        assert!(validate_update(Some(&edited), Some(&current)).is_err());
        let mut empty = edited.clone();
        empty.entries.clear();
        empty.applied.clear();
        empty.revision += 1;
        assert!(validate_update(Some(&edited), Some(&empty)).is_err());
        assert!(validate_update(Some(&empty), Some(&empty)).is_err());
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
    fn incomplete_legacy_runtime_values_survive_only_outside_apply_coverage() {
        for field in ["active_backend", "active_build"] {
            let mut saved = library();
            let profile = &mut saved.entries[0];
            profile.legacy = Some(true);
            profile.coverage = Some(vec!["temperature".into()]);
            profile.settings.insert(field.into(), json!("saved-value"));
            assert!(saved.validate().is_ok(), "{field}");
            assert_eq!(saved.entries[0].settings[field], json!("saved-value"));

            let mut invalid = saved.clone();
            invalid.entries[0].legacy = None;
            assert!(invalid.validate().is_err());
            let mut invalid = saved.clone();
            invalid.entries[0]
                .coverage
                .as_mut()
                .unwrap()
                .push(field.into());
            assert!(invalid.validate().is_err());
            let mut invalid = saved.clone();
            invalid.entries[0].coverage = None;
            assert!(invalid.validate().is_err());
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
        assert_eq!(profiles.entries.len(), 2);
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
        assert!(markers
            .iter()
            .all(|value| GLOBAL_FIELDS.contains(&value.as_str().unwrap())));
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
        assert_eq!(migrated.settings_profiles, Some(library()));
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
        })).unwrap();
        let mut profiles = migrated.settings_profiles.unwrap();
        assert_eq!(profiles.entries.len(), 2);
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
        })).unwrap();
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
        assert!(selected.validate().is_ok());
        let restored = super::super::migrate_value(json!({
            "models_dir": "models", "active_model": "models/sample.gguf", "settings_profiles": selected
        })).unwrap();
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
            })).unwrap();
            assert_eq!(restored.settings_profiles.unwrap(), library());
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
        assert_eq!(restored.entries.len(), 1);
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
}
