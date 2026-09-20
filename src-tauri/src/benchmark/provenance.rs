//! Facts captured at launch; installed adapters are never assumed to be used.
use super::identity::ModelIdentity;
use crate::{
    config::AppConfig,
    gpu::ResolvedGpu,
    hardware::{DeviceProfile, GpuDevice},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct BenchmarkGpu {
    pub name: String,
    pub vendor: String,
    pub vram_mb: Option<u64>,
    pub driver: Option<String>,
    pub integrated: bool,
}

impl From<&GpuDevice> for BenchmarkGpu {
    fn from(gpu: &GpuDevice) -> Self {
        Self {
            name: gpu.name.clone(),
            vendor: gpu.vendor.as_str().into(),
            vram_mb: gpu.vram_mb,
            driver: gpu.driver.clone(),
            integrated: gpu.integrated,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Execution {
    pub mode: String,
    pub selected_gpus: Vec<BenchmarkGpu>,
    pub devices: Vec<String>,
    pub selection_complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Environment {
    pub os: String,
    pub arch: String,
    pub cpu: crate::hardware::CpuInfo,
    pub installed_gpus: Vec<BenchmarkGpu>,
    pub execution: Execution,
    pub detection: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Method {
    pub id: String,
    pub version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Corpus {
    pub profile: String,
    pub version: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct ExecutionConfig {
    pub gpu_layers: Option<i64>,
    pub threads: Option<i64>,
    pub threads_batch: Option<i64>,
    pub flash_attention: Option<String>,
    pub cache_type_k: Option<String>,
    pub cache_type_v: Option<String>,
    pub split_mode: Option<String>,
    pub tensor_split: Option<Vec<f32>>,
}

impl ExecutionConfig {
    pub(crate) fn from_args(args: &[String]) -> Self {
        let value = |aliases: &[&str]| -> Option<String> {
            let mut found = None;
            for (index, arg) in args.iter().enumerate() {
                let (name, inline) = arg
                    .split_once('=')
                    .map(|(name, value)| (name, Some(value)))
                    .unwrap_or((arg.as_str(), None));
                if aliases.contains(&name) {
                    found = inline
                        .map(str::to_owned)
                        .or_else(|| args.get(index + 1).cloned());
                }
            }
            found
        };
        Self {
            gpu_layers: value(&["--n-gpu-layers", "--gpu-layers", "-ngl"])
                .and_then(|value| value.parse().ok()),
            threads: value(&["--threads", "-t"]).and_then(|value| value.parse().ok()),
            threads_batch: value(&["--threads-batch", "-tb"]).and_then(|value| value.parse().ok()),
            flash_attention: value(&["--flash-attn", "-fa"]),
            cache_type_k: value(&["--cache-type-k", "-ctk"]),
            cache_type_v: value(&["--cache-type-v", "-ctv"]),
            split_mode: value(&["--split-mode", "-sm"]),
            tensor_split: value(&["--tensor-split", "-ts"])
                .and_then(|value| {
                    value
                        .split(',')
                        .map(str::parse::<f32>)
                        .collect::<Result<Vec<_>, _>>()
                        .ok()
                })
                .filter(|values| {
                    values
                        .iter()
                        .all(|value| value.is_finite() && *value >= 0.0)
                }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct BenchmarkProvenance {
    pub schema_version: u32,
    pub app_version: String,
    pub method: Method,
    pub corpus: Corpus,
    pub model: ModelIdentity,
    pub environment: Environment,
    #[serde(default)]
    pub execution_config: ExecutionConfig,
}

impl BenchmarkProvenance {
    pub(crate) fn validate(&self, profile: &str) -> Result<(), String> {
        let digest =
            |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        let model_valid = match self.model.status.as_str() {
            "sha256" => {
                self.model.sha256.as_deref().is_some_and(digest) && self.model.size_bytes.is_some()
            }
            "unidentified" => self.model.sha256.is_none(),
            "multipart" => self.model.sha256.is_none() && self.model.size_bytes.is_none(),
            _ => false,
        };
        if self.schema_version != 1
            || self.method.id != "cold-prompt-serving"
            || self.method.version != 1
            || self.corpus.version != 1
            || self.corpus.profile != profile
            || !digest(&self.corpus.sha256)
            || !model_valid
            || !["cpu", "selected", "automatic", "unknown"]
                .contains(&self.environment.execution.mode.as_str())
            || self.environment.installed_gpus.len() > 64
            || self.environment.execution.selected_gpus.len() > 64
            || self
                .execution_config
                .gpu_layers
                .is_some_and(|value| value < -1)
            || self
                .execution_config
                .threads
                .is_some_and(|value| value < -1)
            || self
                .execution_config
                .threads_batch
                .is_some_and(|value| value < -1)
            || self
                .execution_config
                .tensor_split
                .as_ref()
                .is_some_and(|values| {
                    values.len() > 64
                        || values
                            .iter()
                            .any(|value| !value.is_finite() || *value < 0.0)
                })
        {
            return Err("invalid or unsupported benchmark provenance".into());
        }
        Ok(())
    }
}

pub(crate) fn capture(
    cfg: &AppConfig,
    gpu: &ResolvedGpu,
    profile: DeviceProfile,
    model: ModelIdentity,
    corpus_profile: &str,
    corpus_hash: String,
) -> BenchmarkProvenance {
    // Custom CLI overrides can change placement after structured configuration.
    // Do not certify GPU usage in that case, or equate runtime indexes with OS IDs.
    let overrides = cfg.server_args.iter().any(|arg| {
        matches!(
            arg.split('=').next().unwrap_or(arg),
            "--device"
                | "-dev"
                | "--n-gpu-layers"
                | "-ngl"
                | "--gpu-layers"
                | "--main-gpu"
                | "-mg"
                | "--spec-draft-device"
                | "--spec-draft-model"
                | "--mmproj"
                | "-mm"
        )
    });
    let auxiliary_model =
        !cfg.mmproj.trim().is_empty() || crate::tuning_defaults::speculative_enabled(cfg);
    let cpu_only = !overrides
        && (cfg.active_backend == "cpu"
            || (cfg.ngl == 0
                && !auxiliary_model
                && !cfg.runtime_defaults.iter().any(|value| value == "ngl")));
    let devices = gpu
        .device_flag
        .as_deref()
        .map(|value| value.split(',').map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_default();
    let selected_gpus: Vec<BenchmarkGpu> = if cpu_only || overrides {
        vec![]
    } else {
        cfg.gpu
            .gpu_ids
            .iter()
            .filter_map(|id| profile.gpus.iter().find(|gpu| gpu.stable_id == *id))
            .map(BenchmarkGpu::from)
            .collect()
    };
    let selection_complete = cpu_only
        || (!overrides
            && !auxiliary_model
            && !devices.is_empty()
            && selected_gpus.len() == devices.len());
    let mode = if overrides {
        "unknown"
    } else if cpu_only {
        "cpu"
    } else if !devices.is_empty() {
        "selected"
    } else {
        "automatic"
    };
    BenchmarkProvenance {
        schema_version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        method: Method {
            id: "cold-prompt-serving".into(),
            version: 1,
        },
        corpus: Corpus {
            profile: corpus_profile.into(),
            version: 1,
            sha256: corpus_hash,
        },
        model,
        execution_config: ExecutionConfig::default(),
        environment: Environment {
            os: profile.os,
            arch: profile.arch,
            cpu: profile.cpu,
            installed_gpus: profile.gpus.iter().map(BenchmarkGpu::from).collect(),
            execution: Execution {
                mode: mode.into(),
                selected_gpus,
                devices: if cpu_only || overrides {
                    vec![]
                } else {
                    devices
                },
                selection_complete,
            },
            detection: profile.detection,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> DeviceProfile {
        DeviceProfile {
            schema_version: 1,
            os: "synthetic".into(),
            arch: "test".into(),
            cpu: crate::hardware::CpuInfo {
                name: "Test CPU".into(),
                logical_cores: 8,
            },
            gpus: vec![GpuDevice {
                name: "Unused GPU".into(),
                vendor: crate::hardware::GpuVendor::Amd,
                vram_mb: Some(1024),
                driver: Some("test".into()),
                pci_id: None,
                integrated: false,
                stable_id: "private-id".into(),
            }],
            detection: "synthetic".into(),
            fingerprint: "private-fingerprint".into(),
        }
    }
    fn capture_for(cfg: &AppConfig, resolved: &ResolvedGpu) -> BenchmarkProvenance {
        capture(
            cfg,
            resolved,
            profile(),
            ModelIdentity {
                status: "unidentified".into(),
                sha256: None,
                size_bytes: None,
            },
            "novel_en",
            "synthetic".into(),
        )
    }
    #[test]
    fn cpu_and_automatic_runs_never_assume_the_first_installed_gpu_is_used() {
        let mut cfg = AppConfig {
            active_backend: "cpu".into(),
            ..Default::default()
        };
        let cpu = capture_for(&cfg, &ResolvedGpu::default());
        assert_eq!(cpu.environment.execution.mode, "cpu");
        assert!(cpu.environment.execution.selected_gpus.is_empty());
        cfg.active_backend = "vulkan".into();
        cfg.ngl = 99;
        let automatic = capture_for(&cfg, &ResolvedGpu::default());
        assert_eq!(automatic.environment.execution.mode, "automatic");
        assert!(!automatic.environment.execution.selection_complete);
        assert!(automatic.environment.execution.selected_gpus.is_empty());
        let encoded = serde_json::to_string(&automatic).unwrap();
        assert!(!encoded.contains("private-id"));
        assert!(!encoded.contains("private-fingerprint"));
    }
    #[test]
    fn runtime_index_selection_does_not_guess_an_os_adapter() {
        let mut cfg = AppConfig {
            active_backend: "vulkan".into(),
            ngl: 99,
            ..Default::default()
        };
        cfg.gpu.gpu_ids = vec!["runtime:vulkan:Vulkan0".into()];
        let selected = capture_for(
            &cfg,
            &ResolvedGpu {
                device_flag: Some("Vulkan0".into()),
                ..Default::default()
            },
        );
        assert_eq!(selected.environment.execution.mode, "selected");
        assert!(selected.environment.execution.selected_gpus.is_empty());
        assert!(!selected.environment.execution.selection_complete);
    }

    #[test]
    fn effective_options_follow_last_launch_argument_and_keep_defaults_unknown() {
        let parsed = ExecutionConfig::from_args(&[
            "--threads".into(),
            "8".into(),
            "-t=12".into(),
            "--tensor-split".into(),
            "1,2".into(),
        ]);
        assert_eq!(parsed.threads, Some(12));
        assert_eq!(parsed.tensor_split, Some(vec![1.0, 2.0]));
        assert!(parsed.gpu_layers.is_none());
        assert!(parsed.cache_type_k.is_none());
        let automatic = ExecutionConfig::from_args(&[
            "-ngl".into(),
            "-1".into(),
            "-t=-1".into(),
            "-tb=-1".into(),
        ]);
        assert_eq!(automatic.gpu_layers, Some(-1));
        assert_eq!(automatic.threads, Some(-1));
        assert_eq!(automatic.threads_batch, Some(-1));
    }

    #[test]
    fn provenance_validation_rejects_unknown_versions_and_inconsistent_identity() {
        let mut provenance = capture_for(&AppConfig::default(), &ResolvedGpu::default());
        provenance.corpus.sha256 = "a".repeat(64);
        assert!(provenance.validate("novel_en").is_ok());
        assert!(provenance.validate("code_python").is_err());
        provenance.schema_version = 2;
        assert!(provenance.validate("novel_en").is_err());
        provenance.schema_version = 1;
        provenance.model.status = "sha256".into();
        assert!(provenance.validate("novel_en").is_err());
        provenance.model.status = "unidentified".into();
        let mut value = serde_json::to_value(&provenance).unwrap();
        value.as_object_mut().unwrap().remove("execution_config");
        assert!(serde_json::from_value::<BenchmarkProvenance>(value)
            .unwrap()
            .validate("novel_en")
            .is_ok());
    }
}
