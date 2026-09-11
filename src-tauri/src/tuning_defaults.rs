//! Omit an override instead of freezing a default from one llama.cpp version.
use crate::config::AppConfig;
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Deserialize)]
struct Field {
    key: String,
    args: Vec<String>,
    #[serde(default, rename = "switch")]
    is_switch: bool,
    #[serde(default, rename = "appDefault")]
    app_default: bool,
    #[serde(default, rename = "resetValue")]
    reset_value: serde_json::Value,
}

static FIELDS: LazyLock<Vec<Field>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../src/shared/config/tuningDefaultsCatalog.json"
    ))
    .expect("checked-in tuning default catalog must be valid")
});

pub fn is_known(key: &str) -> bool {
    FIELDS.iter().any(|field| field.key == key)
}

pub fn app_default_u32(key: &str) -> u32 {
    FIELDS
        .iter()
        .find(|field| field.key == key && field.app_default)
        .and_then(|field| field.reset_value.as_u64())
        .expect("app default must be numeric") as u32
}

pub fn inherited(cfg: &AppConfig, key: &str) -> bool {
    cfg.runtime_defaults.iter().any(|value| value == key)
}

pub fn speculative_enabled(cfg: &AppConfig) -> bool {
    !inherited(cfg, "spec_type") && !cfg.spec_type.trim().is_empty() && cfg.spec_type != "none"
}

pub fn app_idle_timeout(cfg: &AppConfig) -> i64 {
    // An old manually selected timeout must not make the app kill a default-mode server.
    if inherited(cfg, "sleep_idle_seconds") {
        -1
    } else {
        cfg.sleep_idle_seconds
    }
}

pub fn filter_args(cfg: &AppConfig, args: Vec<String>) -> Vec<String> {
    let mut result = Vec::with_capacity(args.len());
    let mut tokens = args.into_iter();
    while let Some(token) = tokens.next() {
        let name = token.split('=').next().unwrap_or(&token);
        let field = FIELDS.iter().find(|field| {
            inherited(cfg, &field.key) && field.args.iter().any(|alias| alias == name)
        });
        if let Some(field) = field {
            if !field.is_switch && !token.contains('=') {
                tokens.next();
            }
            if field.app_default {
                result.push(name.to_owned());
                result.push(
                    field
                        .reset_value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| field.reset_value.to_string()),
                );
            }
        } else {
            result.push(token);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_idle_timeout_never_reuses_a_saved_manual_deadline() {
        let mut cfg = AppConfig {
            sleep_idle_seconds: 1,
            ..AppConfig::default()
        };
        assert_eq!(app_idle_timeout(&cfg), 1);
        cfg.runtime_defaults.push("sleep_idle_seconds".into());
        assert_eq!(app_idle_timeout(&cfg), -1);
    }

    #[test]
    fn full_reset_applies_app_defaults_and_omits_other_runtime_defaults() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            mmproj: "vision.gguf".into(),
            spec_type: "draft-dflash".into(),
            spec_draft_model: "draft.gguf".into(),
            reasoning: "off".into(),
            reasoning_preserve: "off".into(),
            threads: 8,
            runtime_defaults: FIELDS.iter().map(|field| field.key.clone()).collect(),
            ..AppConfig::default()
        };
        let gpu = crate::gpu::ResolvedGpu {
            device_flag: Some("Vulkan1".into()),
            ..Default::default()
        };
        let args = crate::server::build_args_with_gpu(&cfg, "secret", &gpu);
        for field in FIELDS.iter() {
            if field.app_default {
                continue;
            }
            for alias in &field.args {
                assert!(!args.contains(alias), "retained {alias}");
            }
        }
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--model", "model.gguf"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--mmproj", "vision.gguf"]));
        assert!(args.windows(2).any(|pair| pair == ["--device", "Vulkan1"]));
        assert!(!args.contains(&"--spec-draft-model".into()));
        assert!(args.windows(2).any(|pair| pair == ["--host", "127.0.0.1"]));
        let bench = crate::bench::build_args(&cfg);
        assert!(args.windows(2).any(|pair| pair == ["--n-gpu-layers", "99"]));
        assert!(args.windows(2).any(|pair| pair == ["--ctx-size", "4096"]));
        assert!(bench
            .windows(2)
            .any(|pair| pair == ["--n-gpu-layers", "99"]));
        assert!(!bench.contains(&"--threads".into()));
        assert!(bench.contains(&"--repetitions".into()));
    }

    #[test]
    fn single_reset_and_boolean_switch_do_not_remove_unrelated_values() {
        let cfg = AppConfig {
            runtime_defaults: vec!["ctx_size".into(), "reasoning_preserve".into()],
            ..AppConfig::default()
        };
        let args = [
            "--ctx-size",
            "8192",
            "--no-reasoning-preserve",
            "--keep",
            "64",
            "--ctx-size=4096",
        ];
        assert_eq!(
            filter_args(&cfg, args.map(String::from).to_vec()),
            vec!["--ctx-size", "4096", "--keep", "64", "--ctx-size", "4096"]
        );
        let args = crate::server::build_args(&cfg, "secret");
        assert!(args.windows(2).any(|pair| pair == ["--ctx-size", "4096"]));
        assert!(args.contains(&"--n-gpu-layers".into()));
    }

    #[test]
    fn default_markers_round_trip_and_unknown_keys_are_rejected() {
        let mut cfg = AppConfig {
            runtime_defaults: vec!["ngl".into(), "temperature".into()],
            ..AppConfig::default()
        };
        cfg.normalize();
        cfg.validate().unwrap();
        let loaded: AppConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(loaded.runtime_defaults, cfg.runtime_defaults);
        assert!(serde_json::from_str::<AppConfig>("{}")
            .unwrap()
            .runtime_defaults
            .is_empty());
        cfg.runtime_defaults.push("--model".into());
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn old_manual_gpu_count_cannot_override_app_default_and_context_zero_survives() {
        let mut cfg = AppConfig {
            ngl: 12,
            ctx_size: 0,
            runtime_defaults: vec!["ngl".into()],
            ..AppConfig::default()
        };
        cfg.normalize();
        cfg.validate().unwrap();
        assert_eq!(cfg.ctx_size, 0);
        assert_eq!(AppConfig::default().ngl, 99);
        let args = crate::server::build_args(&cfg, "secret");
        assert!(args.windows(2).any(|pair| pair == ["--n-gpu-layers", "99"]));
        let manual = AppConfig {
            runtime_defaults: vec![],
            ..cfg
        };
        assert!(crate::server::build_args(&manual, "secret")
            .windows(2)
            .any(|pair| pair == ["--n-gpu-layers", "12"]));
    }
}
