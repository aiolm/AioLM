//! Facts captured at launch; installed adapters are never assumed to be used.
use super::identity::ModelIdentity;
use crate::{
    config::AppConfig,
    hardware::{DeviceProfile, GpuDevice},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_memory_bytes: Option<u64>,
    pub installed_gpus: Vec<BenchmarkGpu>,
    pub execution: Execution,
    pub detection: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Method {
    pub id: String,
    pub version: u32,
}

/// New runs freeze the common HTTP workload independently of engine tokenizers.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServingInput {
    pub bytes: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServingWorkload {
    pub corpus: String,
    pub corpus_version: u32,
    pub inputs: Vec<ServingInput>,
    pub max_output_tokens: u32,
    pub concurrencies: Vec<u32>,
    pub repetitions: u32,
    pub warmup: bool,
    pub request_usage: bool,
    pub cache_policy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_nonce: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecordedSetting {
    pub target: String,
    pub scope: Vec<String>,
    pub name: String,
    pub value: serde_json::Value,
    pub unit: Option<String>,
    pub role: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServingExecution {
    pub topology: crate::providers::protocol::ServingTopology,
    pub memory_scope: crate::providers::protocol::ServingMemoryScope,
    pub settings: Vec<RecordedSetting>,
}

/// Host resources are observations of AioLM's host, not upstream allocation.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ServingEnvironment {
    pub scope: String,
    #[serde(flatten)]
    pub host: Environment,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ServingBenchmarkProvenance {
    pub schema_version: u32,
    pub app_version: String,
    pub method: Method,
    pub workload: ServingWorkload,
    pub runtime: crate::providers::protocol::PublicEngine,
    pub model: ModelIdentity,
    pub environment: ServingEnvironment,
    pub execution: ServingExecution,
    /// Private display label, frozen before launch; never a public identity.
    pub recorded_model_label: String,
}

/// New captures freeze Cold Prompt without force or usage-probe controls.
pub(crate) fn capture_serving(
    _cfg: &AppConfig,
    profile: &DeviceProfile,
    mut model: ModelIdentity,
    workload: ServingWorkload,
    metadata: Option<&crate::providers::protocol::ServingMetadata>,
    recorded_model_label: String,
) -> ServingBenchmarkProvenance {
    use crate::providers::{
        artifacts::ArtifactFormat,
        protocol::{ServingMemoryScope, ServingTopology},
    };
    let format = if model
        .format
        .is_none_or(|format| format == ArtifactFormat::Unknown)
    {
        ArtifactFormat::Unknown
    } else {
        metadata.map_or(ArtifactFormat::Unknown, |value| value.model_format)
    };
    // A reference file is not evidence of a weights artifact or its size/hash.
    if format == ArtifactFormat::Unknown {
        model.status = "unidentified".into();
        model.sha256 = None;
        model.size_bytes = None;
        model.metadata = None;
        model.local_fingerprint = None;
        model.revision = None;
        model.repository = None;
    } else if format != ArtifactFormat::Gguf {
        model.metadata = None;
    }
    model.format = Some(format);
    let settings = common_request_settings(workload.max_output_tokens, workload.request_usage);
    ServingBenchmarkProvenance {
        schema_version: 3,
        app_version: env!("CARGO_PKG_VERSION").into(),
        method: Method {
            id: "openai-chat-serving".into(),
            version: crate::performance_bench::METHOD_VERSION,
        },
        workload,
        runtime: metadata
            .map(|value| value.runtime.clone())
            .unwrap_or_default(),
        model,
        environment: ServingEnvironment {
            scope: "aiolm_host".into(),
            host: Environment {
                os: profile.os.clone(),
                arch: profile.arch.clone(),
                cpu: profile.cpu.clone(),
                system_memory_bytes: crate::hardware_memory::system_memory_bytes(),
                installed_gpus: profile.gpus.iter().map(BenchmarkGpu::from).collect(),
                // Preferences are not evidence that any launched engine used them.
                execution: unknown_gpu_execution(),
                detection: profile.detection.clone(),
            },
        },
        execution: ServingExecution {
            topology: metadata.map_or(ServingTopology::Unknown, |value| value.topology),
            memory_scope: metadata
                .map_or(ServingMemoryScope::Unavailable, |value| value.memory_scope),
            settings,
        },
        recorded_model_label,
    }
}

fn unknown_gpu_execution() -> Execution {
    Execution {
        mode: "unknown".into(),
        selected_gpus: vec![],
        devices: vec![],
        selection_complete: false,
    }
}

/// Only the native adapter applies ResolvedGpu. Confirm its placement against
/// the final spawned argv, never the saved profile or installed inventory alone.
pub(crate) fn capture_serving_gpu_execution(
    cfg: &AppConfig,
    profile: &DeviceProfile,
    resolved: &crate::gpu::ResolvedGpu,
    args: &[String],
) -> Execution {
    use crate::providers::adapter::{resolve, RuntimeKind};
    let unknown = unknown_gpu_execution;
    if resolve(cfg).kind() != RuntimeKind::Native {
        return unknown();
    }
    // Duplicate aliases and arbitrary tensor/device overrides make the resolved
    // mapping insufficient evidence, even when an earlier flag still matches.
    let mut device = None;
    let mut layers = None;
    let mut main_gpu = None;
    let mut split_mode = None;
    let mut tensor_split = None;
    let mut no_kv = false;
    let mut no_op = false;
    let mut no_mmproj = false;
    for (index, argument) in args.iter().enumerate() {
        let (name, inline) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(name, value)| {
                (name, Some(value))
            });
        let slot = match name {
            "--device" | "-dev" => Some(&mut device),
            "--n-gpu-layers" | "--gpu-layers" | "-ngl" => Some(&mut layers),
            "--main-gpu" | "-mg" => Some(&mut main_gpu),
            "--split-mode" | "-sm" => Some(&mut split_mode),
            "--tensor-split" | "-ts" => Some(&mut tensor_split),
            "--override-tensor"
            | "-ot"
            | "--spec-draft-override-tensor"
            | "--override-tensor-draft"
            | "-otd"
            | "--mmproj-device"
            | "-mmdev" => return unknown(),
            "--spec-draft-device" | "--device-draft" | "-devd" => {
                // Auxiliary placement may name a GPU outside the resolved set.
                if inline.or_else(|| args.get(index + 1).map(String::as_str)) != Some("none") {
                    return unknown();
                }
                None
            }
            "--spec-draft-ngl" | "--n-gpu-layers-draft" | "--gpu-layers-draft" | "-ngld" => {
                if inline.or_else(|| args.get(index + 1).map(String::as_str)) != Some("0") {
                    return unknown();
                }
                None
            }
            "--spec-type" => {
                if inline.or_else(|| args.get(index + 1).map(String::as_str)) != Some("none") {
                    return unknown();
                }
                None
            }
            "--kv-offload" | "-kvo" | "--op-offload" | "--mmproj-offload" => return unknown(),
            "--no-kv-offload" | "-nkvo" => {
                no_kv = true;
                None
            }
            "--no-op-offload" => {
                no_op = true;
                None
            }
            "--no-mmproj-offload" => {
                no_mmproj = true;
                None
            }
            _ => None,
        };
        if let Some(slot) = slot {
            let Some(value) = inline.or_else(|| args.get(index + 1).map(String::as_str)) else {
                return unknown();
            };
            if slot.replace(value).is_some() {
                return unknown();
            }
        }
    }
    // Zero layers alone does not disable KV, operation or projector offload.
    if device == Some("none") && layers == Some("0") && no_kv && no_op && no_mmproj {
        return Execution {
            mode: "cpu".into(),
            selected_gpus: vec![],
            devices: vec![],
            selection_complete: true,
        };
    }
    if layers
        .and_then(|value| value.parse::<i64>().ok())
        .is_none_or(|value| value == 0)
    {
        return unknown();
    }
    let Some(expected_devices) = resolved.device_flag.as_deref() else {
        return unknown();
    };
    if device != Some(expected_devices)
        || cfg.gpu.gpu_ids.is_empty()
        || expected_devices.split(',').count() != cfg.gpu.gpu_ids.len()
        || expected_devices
            .split(',')
            .any(|value| value.is_empty() || value == "none")
        || main_gpu.and_then(|value| value.parse::<usize>().ok()) != resolved.main_gpu_index
        || (main_gpu.is_some() && resolved.main_gpu_index.is_none())
        || split_mode != resolved.split_mode
        || split_mode == Some("none")
    {
        return unknown();
    }
    match tensor_split {
        Some(value) => {
            let mut values = value.split(',');
            for expected in &resolved.tensor_split {
                if values.next().and_then(|value| value.parse::<f32>().ok()) != Some(*expected)
                    || !expected.is_finite()
                    || *expected <= 0.0
                {
                    return unknown();
                }
            }
            if values.next().is_some() || resolved.tensor_split.len() != cfg.gpu.gpu_ids.len() {
                return unknown();
            }
        }
        None if !resolved.tensor_split.is_empty() => return unknown(),
        None => {}
    }
    let mut selected_gpus = Vec::with_capacity(cfg.gpu.gpu_ids.len());
    for (index, id) in cfg.gpu.gpu_ids.iter().enumerate() {
        // Runtime-index-only IDs do not establish a physical host GPU match.
        let Some(gpu) = profile.gpus.iter().find(|gpu| gpu.stable_id == *id) else {
            return unknown();
        };
        if cfg.gpu.gpu_ids[..index].contains(id) {
            return unknown();
        }
        selected_gpus.push(BenchmarkGpu::from(gpu));
    }
    Execution {
        mode: "selected".into(),
        selected_gpus,
        devices: vec![],
        selection_complete: true,
    }
}

/// The exact common request in the persisted ASCII order of names.
pub(crate) fn common_request_settings(cap: u32, request_usage: bool) -> Vec<RecordedSetting> {
    use serde_json::json;
    let mut entries = vec![
        ("max_tokens", json!(cap), Some("tokens".to_owned())),
        ("stream", json!(true), None),
    ];
    if request_usage {
        entries.push(("stream_options.include_usage", json!(true), None));
    }
    entries.push(("temperature", json!(0), None));
    entries.sort_by(|left, right| left.0.cmp(right.0));
    entries
        .into_iter()
        .map(|(name, value, unit)| RecordedSetting {
            target: "request".into(),
            scope: vec![],
            name: name.into(),
            value,
            unit,
            role: None,
        })
        .collect()
}

impl ServingWorkload {
    pub(crate) fn validate(&self, method_version: u32) -> Result<(), String> {
        let ordered = |values: &[u32]| values.windows(2).all(|pair| pair[0] < pair[1]);
        if ![
            "code_python",
            "code_mixed",
            "novel_ko",
            "novel_en",
            "novel_ja",
        ]
        .contains(&self.corpus.as_str())
            || method_version != crate::performance_bench::METHOD_VERSION
            || self.corpus_version != 2
            || self.cache_policy != "cold_prompt"
            || self.warmup
            || !self.prompt_nonce.as_deref().is_some_and(|nonce| {
                nonce.len() == 32
                    && nonce
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            || self.inputs.is_empty()
            || self.inputs.len() > 64
            || self.concurrencies.is_empty()
            || self.concurrencies.len() > 64
            || self.inputs.len() * self.concurrencies.len() > 64
            || !(1..=crate::performance_bench::MAX_SERVING_OUTPUT_TOKENS)
                .contains(&self.max_output_tokens)
            || !(1..=100).contains(&self.repetitions)
            || !ordered(&self.concurrencies)
            || self
                .concurrencies
                .iter()
                .any(|value| !(1..=64).contains(value))
            || self
                .inputs
                .windows(2)
                .any(|pair| pair[0].bytes >= pair[1].bytes)
            || self.inputs.iter().any(|input| {
                !(256..=1048576).contains(&input.bytes)
                    || input.sha256.len() != 64
                    || !input
                        .sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err("invalid serving workload".into());
        }
        Ok(())
    }
}

impl ServingBenchmarkProvenance {
    pub(crate) fn validate(&self, profile: &str) -> Result<(), String> {
        use crate::providers::{
            artifacts::ArtifactFormat,
            protocol::{ServingMemoryScope, ServingTopology},
        };
        self.workload.validate(self.method.version)?;
        self.runtime.validate()?;
        let model = &self.model;
        let model_valid = match model.status.as_str() {
            "sha256" => model.sha256.as_ref().is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }),
            "unidentified" | "multipart" => model.sha256.is_none(),
            _ => false,
        };
        if self.schema_version != 3
            || self.method.id != "openai-chat-serving"
            || self.method.version != crate::performance_bench::METHOD_VERSION
            || self.workload.corpus != profile
            || self.environment.scope != "aiolm_host"
            || !model_valid
            || model.format.is_none()
            || model
                .size_bytes
                .is_some_and(|size| size > 9_007_199_254_740_991)
            || (model.format != Some(ArtifactFormat::Gguf) && model.metadata.is_some())
            || model
                .metadata
                .as_ref()
                .is_some_and(|value| !value.is_valid())
            || (matches!(
                model.format,
                Some(ArtifactFormat::HfSafetensors | ArtifactFormat::Mlx)
            ) && (model.status != "unidentified" || model.sha256.is_some()))
            || model.repository.as_deref().is_some_and(|repository| {
                !super::model_metadata::valid_repository(repository)
                    || !model
                        .revision
                        .as_deref()
                        .is_some_and(super::identity::valid_source_revision)
            })
            || self.execution.settings.len() > 128
            || (self.execution.topology != ServingTopology::Owned
                && self.execution.memory_scope != ServingMemoryScope::Unavailable)
        {
            return Err("invalid serving provenance".into());
        }
        let identifier = |text: &str| {
            !text.is_empty()
                && text.len() <= 64
                && text.as_bytes()[0].is_ascii_alphanumeric()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        };
        for setting in &self.execution.settings {
            let safe_value = match &setting.value {
                serde_json::Value::Null | serde_json::Value::Bool(_) => true,
                serde_json::Value::Number(value) => value.as_f64().is_some_and(f64::is_finite),
                serde_json::Value::String(value) => {
                    value.chars().count() <= 128
                        && !value.is_empty()
                        && !value.starts_with('-')
                        && !value.chars().any(|c| c.is_control() || "\\/:@".contains(c))
                }
                serde_json::Value::Array(values) => {
                    values.len() <= 64
                        && values
                            .iter()
                            .all(|value| value.as_f64().is_some_and(f64::is_finite))
                }
                _ => false,
            };
            if !["launch", "request"].contains(&setting.target.as_str())
                || setting.scope.len() > 8
                || !setting.scope.iter().all(|value| identifier(value))
                || !identifier(&setting.name)
                || !safe_value
                || setting.unit.as_deref().is_some_and(|value| {
                    ![
                        "tokens", "bytes", "MiB", "GiB", "threads", "layers", "count", "ratio",
                        "bits", "percent",
                    ]
                    .contains(&value)
                })
                || setting.role.as_deref().is_some_and(|value| {
                    ![
                        "context.total_tokens",
                        "context.per_sequence_tokens",
                        "context.per_request_kv_tokens",
                        "concurrency.capacity",
                    ]
                    .contains(&value)
                })
            {
                return Err("invalid recorded serving setting".into());
            }
        }
        if self.execution.settings.windows(2).any(|pair| {
            (&pair[0].target, &pair[0].scope, &pair[0].name)
                >= (&pair[1].target, &pair[1].scope, &pair[1].name)
        }) {
            return Err("serving settings must have unique sorted identities".into());
        }
        let requests: Vec<_> = self
            .execution
            .settings
            .iter()
            .filter(|setting| setting.target == "request")
            .cloned()
            .collect();
        if requests
            != common_request_settings(self.workload.max_output_tokens, self.workload.request_usage)
        {
            return Err("serving settings do not describe the common request".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn profile() -> DeviceProfile {
        DeviceProfile {
            schema_version: 1,
            os: "synthetic".into(),
            arch: "test".into(),
            cpu: crate::hardware::CpuInfo {
                name: "Test CPU".into(),
                logical_cores: 8,
                physical_cores: Some(4),
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
    fn model() -> ModelIdentity {
        serde_json::from_value(json!({
            "status":"unidentified","sha256":null,"size_bytes":null
        }))
        .unwrap()
    }

    fn serving_fixture(request_usage: bool) -> ServingBenchmarkProvenance {
        let workload = serde_json::from_value(json!({
            "corpus":"novel_en", "corpus_version":2,
            "inputs":[{"bytes":256,"sha256":"a".repeat(64)}],
            "max_output_tokens":128,"concurrencies":[1],"repetitions":1,
            "warmup":false,"request_usage":request_usage,"cache_policy":"cold_prompt",
            "prompt_nonce":"0123456789abcdef0123456789abcdef"
        }))
        .unwrap();
        capture_serving(
            &AppConfig::default(),
            &profile(),
            model(),
            workload,
            None,
            "Recorded model".into(),
        )
    }

    #[test]
    fn unapplied_gpu_preferences_do_not_claim_selected_hardware() {
        let profile = profile();
        let mut cfg = AppConfig::default();
        cfg.gpu.gpu_ids = profile
            .gpus
            .iter()
            .map(|gpu| gpu.stable_id.clone())
            .collect();
        let workload = serving_fixture(false).workload;
        let provenance = capture_serving(
            &cfg,
            &profile,
            model(),
            workload,
            None,
            "Recorded model".into(),
        );
        assert_eq!(provenance.environment.host.execution.mode, "unknown");
        assert!(provenance
            .environment
            .host
            .execution
            .selected_gpus
            .is_empty());
        assert!(!provenance.environment.host.execution.selection_complete);
        assert_eq!(provenance.environment.host.installed_gpus.len(), 1);
    }

    #[test]
    fn selected_gpu_requires_resolved_mapping_applied_to_final_native_launch() {
        let mut profile = profile();
        let mut unused = profile.gpus[0].clone();
        unused.name = "Another installed GPU".into();
        unused.stable_id = "other-private-id".into();
        profile.gpus.push(unused);
        let mut cfg = AppConfig {
            active_backend: "vulkan".into(),
            ngl: 16,
            runtime_defaults: vec![],
            ..AppConfig::default()
        };
        cfg.gpu.gpu_ids = vec!["private-id".into()];
        let resolved = crate::gpu::resolve_with_runtime_devices(
            &cfg.gpu,
            "vulkan",
            &profile,
            &["Vulkan3: Unused GPU (1024 MiB, 800 MiB free)".into()],
        )
        .unwrap();
        let args = crate::server::build_args_with_gpu(&cfg, "", &resolved);
        let execution = capture_serving_gpu_execution(&cfg, &profile, &resolved, &args);
        assert_eq!(execution.mode, "selected");
        assert!(execution.selection_complete);
        assert_eq!(
            execution.selected_gpus,
            vec![BenchmarkGpu::from(&profile.gpus[0])]
        );
        assert!(
            execution.devices.is_empty(),
            "private IDs stay out of the snapshot"
        );

        // The same saved IDs are not applied by Python or attached/custom adapters.
        for provider in ["vllm", "mlx-vlm", "custom.auto-test"] {
            cfg.active_provider = provider.into();
            let execution = capture_serving_gpu_execution(
                &cfg,
                &profile,
                &crate::gpu::ResolvedGpu::default(),
                &args,
            );
            assert_eq!(execution.mode, "unknown", "{provider}");
            assert!(execution.selected_gpus.is_empty(), "{provider}");
            assert!(!execution.selection_complete, "{provider}");
        }
    }

    #[test]
    fn final_cpu_placement_overrides_saved_gpu_but_zero_layers_alone_proves_no_gpu_set() {
        let profile = profile();
        let mut cfg = AppConfig {
            active_backend: "vulkan".into(),
            ngl: 0,
            runtime_defaults: vec![],
            ..AppConfig::default()
        };
        cfg.gpu.gpu_ids = vec!["private-id".into()];
        let resolved = crate::gpu::resolve(&cfg.gpu, "vulkan", &profile).unwrap();
        let args = crate::server::build_args_with_gpu(&cfg, "", &resolved);
        let execution = capture_serving_gpu_execution(&cfg, &profile, &resolved, &args);
        assert_eq!(execution.mode, "unknown");
        assert!(execution.selected_gpus.is_empty());
        assert!(!execution.selection_complete);

        cfg.active_backend = "cpu".into();
        cfg.ngl = 16;
        let args = crate::server::build_args_with_gpu(&cfg, "", &resolved);
        let execution = capture_serving_gpu_execution(&cfg, &profile, &resolved, &args);
        assert_eq!(execution.mode, "cpu");
        assert!(execution.selected_gpus.is_empty());
        assert!(execution.selection_complete);
    }

    #[test]
    fn automatic_unmatched_and_overridden_placement_stay_unknown() {
        let profile = profile();
        let mut cfg = AppConfig {
            active_backend: "vulkan".into(),
            ngl: 16,
            runtime_defaults: vec![],
            ..AppConfig::default()
        };
        let automatic = crate::gpu::ResolvedGpu::default();
        let args = crate::server::build_args_with_gpu(&cfg, "", &automatic);
        let execution = capture_serving_gpu_execution(&cfg, &profile, &automatic, &args);
        assert_eq!(execution.mode, "unknown");
        assert!(execution.selected_gpus.is_empty());
        assert!(!execution.selection_complete);

        cfg.gpu.gpu_ids = vec!["private-id".into()];
        let resolved = crate::gpu::resolve(&cfg.gpu, "vulkan", &profile).unwrap();
        for raw in [
            vec!["--device=Vulkan99"],
            vec!["-dev", "Vulkan99"],
            vec!["-ngl", "0"],
            vec!["--split-mode", "none"],
            vec!["--tensor-split", "0"],
            vec!["--override-tensor", "blk.*=Vulkan99"],
        ] {
            let mut args = crate::server::build_args_with_gpu(&cfg, "", &resolved);
            args.extend(raw.iter().map(|value| (*value).to_owned()));
            let execution = capture_serving_gpu_execution(&cfg, &profile, &resolved, &args);
            assert_eq!(execution.mode, "unknown", "{raw:?}");
            assert!(execution.selected_gpus.is_empty(), "{raw:?}");
            assert!(!execution.selection_complete, "{raw:?}");
        }
        cfg.gpu.gpu_ids = vec!["runtime:vulkan:Vulkan0".into()];
        let args = crate::server::build_args_with_gpu(&cfg, "", &resolved);
        let execution = capture_serving_gpu_execution(&cfg, &profile, &resolved, &args);
        assert_eq!(execution.mode, "unknown");
        assert!(execution.selected_gpus.is_empty());
        assert!(!execution.selection_complete);
    }

    #[test]
    fn common_request_descriptors_are_exact_and_usage_is_optional() {
        for request_usage in [false, true] {
            let provenance = serving_fixture(request_usage);
            provenance.validate("novel_en").unwrap();
            let names: Vec<_> = provenance
                .execution
                .settings
                .iter()
                .map(|setting| setting.name.as_str())
                .collect();
            let expected = if request_usage {
                vec![
                    "max_tokens",
                    "stream",
                    "stream_options.include_usage",
                    "temperature",
                ]
            } else {
                vec!["max_tokens", "stream", "temperature"]
            };
            assert_eq!(names, expected);
            let restored: ServingBenchmarkProvenance =
                serde_json::from_value(serde_json::to_value(&provenance).unwrap()).unwrap();
            restored.validate("novel_en").unwrap();
        }
        let standard = serving_fixture(false);
        for (index, value, unit, scope, role) in [
            (0, json!(127), Some("tokens".to_owned()), vec![], None),
            (0, json!(128), None, vec![], None),
            (1, json!(false), None, vec![], None),
            (2, json!(0.5), None, vec![], None),
            (2, json!(0), None, vec!["sampling".to_owned()], None),
            (2, json!(0), None, vec![], Some("path".to_owned())),
        ] {
            let mut invalid = standard.clone();
            let setting = &mut invalid.execution.settings[index];
            setting.value = value;
            setting.unit = unit;
            setting.scope = scope;
            setting.role = role;
            assert!(invalid.validate("novel_en").is_err());
        }
        let mut extra_usage = standard;
        extra_usage.execution.settings = common_request_settings(128, true);
        assert!(extra_usage.validate("novel_en").is_err());
    }

    #[test]
    fn provenance_requires_current_method_nonce_and_cold_workload() {
        use crate::providers::protocol::{ServingMemoryScope, ServingTopology};
        let mut provenance = serving_fixture(false);
        assert_eq!(provenance.schema_version, 3);
        assert_eq!(provenance.method.version, 5);
        for cap in [1, 128] {
            provenance.workload.max_output_tokens = cap;
            provenance.execution.settings = common_request_settings(cap, false);
            provenance.validate("novel_en").unwrap();
        }
        for topology in [
            ServingTopology::Owned,
            ServingTopology::Attached,
            ServingTopology::Unknown,
        ] {
            provenance.execution.topology = topology;
            provenance.execution.memory_scope = ServingMemoryScope::Unavailable;
            provenance.validate("novel_en").unwrap();
        }
        for (pointer, value) in [
            ("/schema_version", json!(2)),
            ("/method/version", json!(4)),
            ("/workload/prompt_nonce", Value::Null),
            ("/workload/prompt_nonce", json!("a".repeat(31))),
            ("/workload/prompt_nonce", json!("a".repeat(33))),
            ("/workload/prompt_nonce", json!("A".repeat(32))),
            ("/workload/prompt_nonce", json!("g".repeat(32))),
            ("/workload/corpus_version", json!(1)),
            ("/workload/cache_policy", json!("as_configured")),
            ("/workload/warmup", json!(true)),
            ("/workload/max_output_tokens", json!(129)),
        ] {
            let mut invalid = serde_json::to_value(&provenance).unwrap();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(
                serde_json::from_value::<ServingBenchmarkProvenance>(invalid)
                    .unwrap()
                    .validate("novel_en")
                    .is_err(),
                "{pointer}"
            );
        }
        assert!(provenance.validate("code_python").is_err());
    }

    #[test]
    fn serving_model_identity_and_metadata_are_validated() {
        use crate::providers::artifacts::ArtifactFormat;
        let provenance = serving_fixture(false);
        let mut identified = provenance.clone();
        identified.model.format = Some(ArtifactFormat::Gguf);
        identified.model.status = "sha256".into();
        identified.model.sha256 = Some("a".repeat(64));
        identified.model.size_bytes = Some(4096);
        identified.validate("novel_en").unwrap();
        let mut invalid = identified.clone();
        invalid.model.sha256 = Some("A".repeat(64));
        assert!(invalid.validate("novel_en").is_err());
        for format in [ArtifactFormat::HfSafetensors, ArtifactFormat::Mlx] {
            let mut snapshot = provenance.clone();
            snapshot.model.format = Some(format);
            snapshot.validate("novel_en").unwrap();
            snapshot.model.status = "sha256".into();
            snapshot.model.sha256 = Some("a".repeat(64));
            assert!(snapshot.validate("novel_en").is_err());
        }
        let mut invalid = serde_json::to_value(identified).unwrap();
        invalid["model"]["metadata"] = json!({
            "format":"GGUF","source":"gguf","base_models":[],
            "artifact":"quantized/model.gguf"
        });
        assert!(
            serde_json::from_value::<ServingBenchmarkProvenance>(invalid)
                .unwrap()
                .validate("novel_en")
                .is_err()
        );
    }
}
