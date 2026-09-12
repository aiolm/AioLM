//! Boundaries between saved application preferences and one execution target.
use super::{AppConfig, SessionDefinition};
use serde_json::{Map, Value};

pub type ExecutionSettings = Map<String, Value>;

pub const EXECUTION_FIELDS: &[&str] = &[
    "runtime_defaults",
    "ngl",
    "ctx_size",
    "batch_size",
    "ubatch_size",
    "keep",
    "cache_type_k",
    "cache_type_v",
    "flash_attn",
    "n_cpu_moe",
    "threads",
    "temperature",
    "top_p",
    "top_k",
    "spec_type",
    "spec_draft_n_max",
    "spec_draft_n_min",
    "spec_draft_p_min",
    "spec_draft_p_split",
    "spec_draft_ngl",
    "spec_draft_device",
    "spec_draft_model",
    "reasoning",
    "reasoning_format",
    "reasoning_effort",
    "reasoning_budget",
    "reasoning_budget_message",
    "reasoning_preserve",
    "server_args",
    "chat_options",
    "mmproj",
    "active_model",
    "active_backend",
    "active_build",
    "parallel",
    "request_timeout_seconds",
    "sleep_idle_seconds",
    "lora_adapters",
    "gpu",
];

const SESSION_BINDINGS: &[&str] = &["active_model", "mmproj", "spec_draft_model", "gpu"];
pub const REQUEST_FIELDS: &[&str] = &[
    "temperature",
    "top_p",
    "top_k",
    "reasoning_effort",
    "chat_options",
];

/// Apply explicitly selected request settings without changing server launch fields.
pub fn apply_request_settings(live: &AppConfig, edited: &AppConfig) -> Result<AppConfig, String> {
    if live.active_model != edited.active_model {
        return Err("request settings target does not match the running model".into());
    }
    let mut request = snapshot(edited);
    request.retain(|key, _| REQUEST_FIELDS.contains(&key.as_str()));
    let mut next = merge_fields(live, &request)?;
    next.runtime_defaults
        .retain(|key| !REQUEST_FIELDS.contains(&key.as_str()));
    next.runtime_defaults.extend(
        edited
            .runtime_defaults
            .iter()
            .filter(|key| REQUEST_FIELDS.contains(&key.as_str()))
            .cloned(),
    );
    next.normalize();
    next.validate()?;
    Ok(next)
}

pub fn snapshot(cfg: &AppConfig) -> ExecutionSettings {
    let Value::Object(mut fields) = serde_json::to_value(cfg).expect("serializable configuration")
    else {
        unreachable!("configuration is an object")
    };
    fields.retain(|key, _| EXECUTION_FIELDS.contains(&key.as_str()));
    fields
}

fn merge_fields(base: &AppConfig, patch: &ExecutionSettings) -> Result<AppConfig, String> {
    let mut value = serde_json::to_value(base).map_err(|error| error.to_string())?;
    let fields = value.as_object_mut().expect("configuration is an object");
    for (key, value) in patch {
        if !EXECUTION_FIELDS.contains(&key.as_str()) {
            return Err(format!("unsupported execution setting: {key}"));
        }
        fields.insert(key.clone(), value.clone());
    }
    serde_json::from_value(value).map_err(|error| format!("invalid execution settings: {error}"))
}

/// Merge launch fields into the latest saved configuration without replacing
/// ports, folders, load policy, or session definitions from an older draft.
pub fn merge_launch(base: &AppConfig, launch: &AppConfig) -> Result<AppConfig, String> {
    merge_fields(base, &snapshot(launch))
}

pub fn session_config(
    base: &AppConfig,
    definition: &SessionDefinition,
) -> Result<AppConfig, String> {
    let mut cfg = base.clone();
    cfg.sessions.clear();
    if let Some(patch) = &definition.execution {
        for key in patch.keys() {
            if SESSION_BINDINGS.contains(&key.as_str()) {
                return Err(format!(
                    "session execution setting {key} must use its dedicated binding"
                ));
            }
        }
        cfg = merge_fields(&cfg, patch)?;
    }
    cfg.active_model = definition.models.primary_model.clone();
    cfg.mmproj = definition.models.mmproj.clone();
    cfg.spec_draft_model = definition.models.draft_model.clone();
    cfg.gpu = definition.gpu.clone();
    Ok(cfg)
}

pub(super) fn normalize_session(base: &AppConfig, definition: &mut SessionDefinition) {
    if definition.execution.is_none() {
        return;
    }
    if let Ok(mut effective) = session_config(base, definition) {
        effective.normalize();
        let fields = snapshot(&effective);
        if let Some(patch) = &mut definition.execution {
            for (key, value) in patch {
                if let Some(normalized) = fields.get(key) {
                    *value = normalized.clone();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GpuPlacement, SessionModels};

    #[test]
    fn request_application_preserves_live_server_settings_and_default_modes() {
        let live = AppConfig {
            active_model: "running.gguf".into(),
            ctx_size: 8192,
            mmproj: "running-mmproj.gguf".into(),
            temperature: 0.8,
            runtime_defaults: vec!["threads".into(), "temperature".into()],
            ..Default::default()
        };
        let mut edited = AppConfig {
            active_model: "running.gguf".into(),
            ctx_size: 32768,
            mmproj: "next-mmproj.gguf".into(),
            temperature: 0.3,
            runtime_defaults: vec!["ctx_size".into(), "top_p".into()],
            ..Default::default()
        };
        let next = apply_request_settings(&live, &edited).unwrap();
        assert_eq!(next.ctx_size, 8192);
        assert_eq!(next.mmproj, "running-mmproj.gguf");
        assert_eq!(next.temperature, 0.3);
        assert_eq!(next.runtime_defaults, vec!["threads", "top_p"]);
        edited.active_model = "different.gguf".into();
        assert!(apply_request_settings(&live, &edited).is_err());
    }

    #[test]
    fn launch_merge_preserves_current_application_preferences() {
        let latest = AppConfig {
            models_dir: "current-models".into(),
            port: 9123,
            iters: 7,
            stop_existing_sessions_on_load: false,
            sessions: vec![SessionDefinition {
                id: "saved-session".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let launch = AppConfig {
            active_model: "selected.gguf".into(),
            ctx_size: 16384,
            ..Default::default()
        };
        let merged = merge_launch(&latest, &launch).unwrap();
        assert_eq!(merged.models_dir, "current-models");
        assert_eq!(merged.port, 9123);
        assert_eq!(merged.iters, 7);
        assert!(!merged.stop_existing_sessions_on_load);
        assert_eq!(merged.sessions, latest.sessions);
        assert_eq!(merged.active_model, "selected.gguf");
        assert_eq!(merged.ctx_size, 16384);
        let snapshot = snapshot(&merged);
        for forbidden in [
            "models_dir",
            "port",
            "iters",
            "sessions",
            "config_version",
            "stop_existing_sessions_on_load",
            "api_key",
        ] {
            assert!(!snapshot.contains_key(forbidden));
        }
    }

    #[test]
    fn legacy_sessions_inherit_tuning_and_overrides_keep_explicit_bindings() {
        let base = AppConfig {
            temperature: 0.6,
            ctx_size: 8192,
            ..Default::default()
        };
        let mut session = SessionDefinition {
            id: "isolated".into(),
            models: SessionModels {
                primary_model: "session.gguf".into(),
                ..Default::default()
            },
            gpu: GpuPlacement::default(),
            ..Default::default()
        };
        assert_eq!(session_config(&base, &session).unwrap().temperature, 0.6);
        session.execution = Some(
            serde_json::from_value(serde_json::json!({"temperature":0.2,"ctx_size":32768}))
                .unwrap(),
        );
        let effective = session_config(&base, &session).unwrap();
        assert_eq!(effective.temperature, 0.2);
        assert_eq!(effective.ctx_size, 32768);
        assert_eq!(effective.active_model, "session.gguf");
        assert_eq!(base.temperature, 0.6);
        for forbidden in [
            "active_model",
            "mmproj",
            "spec_draft_model",
            "gpu",
            "port",
            "sessions",
            "unknown",
        ] {
            session.execution = Some([(forbidden.into(), Value::Null)].into_iter().collect());
            assert!(session_config(&base, &session).is_err(), "{forbidden}");
        }
    }
}
