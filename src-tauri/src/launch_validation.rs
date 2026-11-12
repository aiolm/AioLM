//! Launch configuration and runtime capability validation shared by desktop and CLI.
use crate::error::AppError;
use crate::{config, gpu, hardware, runtime, tuning_defaults};
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(crate) fn validate_start_config(cfg: &mut config::AppConfig) -> Result<(), AppError> {
    cfg.normalize();
    cfg.validate().map_err(AppError::validation)?;
    if crate::providers::provider_of(cfg) != crate::providers::ProviderId::Llama {
        return crate::providers::execution::validate(cfg).map_err(AppError::validation);
    }
    if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
        return Err(AppError::validation(
            "select a runtime installed in AioLM before starting the server; system runtimes outside AioLM are not used",
        ));
    }
    if cfg.active_model.trim().is_empty() {
        return Err(AppError::validation(
            "select a GGUF model before starting the server",
        ));
    }
    validate_adapter_file(&cfg.active_model, "model", &["gguf"])?;
    validate_llama_model_role(&cfg.active_model, "model", false)?;
    if !cfg.mmproj.trim().is_empty() {
        validate_adapter_file(&cfg.mmproj, "projector", &["gguf", "mmproj"])?;
        validate_llama_model_role(&cfg.mmproj, "projector", true)?;
    }
    for adapter in cfg.lora_adapters.iter().filter(|adapter| adapter.enabled) {
        validate_adapter_file(&adapter.path, "LoRA adapter", &["gguf"])?;
    }
    if tuning_defaults::speculative_enabled(cfg) && !cfg.spec_draft_model.trim().is_empty() {
        validate_adapter_file(&cfg.spec_draft_model, "draft model", &["gguf"])?;
        validate_llama_model_role(&cfg.spec_draft_model, "draft model", false)?;
        let draft_name = Path::new(&cfg.spec_draft_model)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if draft_name.contains("dflash") && cfg.spec_type != "draft-dflash" {
            return Err(AppError::validation(
                "a DFlash draft model requires speculative type 'draft-dflash' and a runtime supporting DFlash",
            ));
        }
    }
    if tuning_defaults::speculative_enabled(cfg)
        && cfg.spec_type == "draft-dflash"
        && cfg.spec_draft_model.trim().is_empty()
    {
        return Err(AppError::validation(
            "DFlash2 requires a draft model. Set the draft model GGUF path in Tuning before starting the server.",
        ));
    }
    runtime::validate_runtime_identifiers(&cfg.active_backend, &cfg.active_build)
        .map_err(AppError::validation)?;
    Ok(())
}

pub async fn validate_launch_config(
    cfg: &mut config::AppConfig,
) -> Result<gpu::ResolvedGpu, AppError> {
    validate_launch_config_with_cancel(cfg, None).await
}

pub(crate) async fn validate_launch_config_with_cancel(
    cfg: &mut config::AppConfig,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<gpu::ResolvedGpu, AppError> {
    validate_launch(cfg, cancel, true).await
}

pub(crate) async fn validate_launch(
    cfg: &mut config::AppConfig,
    cancel: Option<&Arc<AtomicBool>>,
    repair: bool,
) -> Result<gpu::ResolvedGpu, AppError> {
    cfg.normalize();
    cfg.validate().map_err(AppError::validation)?;
    crate::providers::adapter::prepare_launch(cfg, cancel.cloned()).await?;
    validate_start_config(cfg)?;
    if crate::providers::provider_of(cfg) != crate::providers::ProviderId::Llama {
        if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(AppError::cancelled("server start cancelled"));
        }
        // A stored deep failure for this exact engine, model and settings
        // blocks the launch, as it does for llama.cpp placements.
        if let Some(refusal) = crate::verify::engine::launch_refusal(cfg) {
            return Err(refusal);
        }
        return Ok(gpu::ResolvedGpu::default());
    }
    if repair {
        let repair_cancel = cancel
            .cloned()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        runtime::repair_runtime_dependencies(&cfg.active_backend, &cfg.active_build, repair_cancel)
            .await?;
    }
    let capabilities = match cancel {
        Some(cancel) => {
            runtime::probe_cancellable(&cfg.active_backend, &cfg.active_build, cancel).await?
        }
        None => runtime::probe(&cfg.active_backend, &cfg.active_build).await?,
    };
    validate_runtime_adapter_capabilities(cfg, &capabilities)?;
    gpu::validate_safe_auto_placement(&cfg.gpu, &cfg.active_backend, &capabilities.devices)
        .map_err(AppError::validation)?;
    let profile = hardware::detect();
    let resolved = gpu::resolve_with_runtime_devices(
        &cfg.gpu,
        &cfg.active_backend,
        &profile,
        &capabilities.devices,
    )
    .map_err(AppError::validation)?;
    // Nothing above this point has checked that the runtime computes correct
    // results here; it has only checked that it can start. Do that last, once
    // the exact device placement is known.
    crate::verify::ensure_verified(
        cfg,
        &resolved,
        &profile.fingerprint,
        &capabilities.devices,
        cancel,
    )
    .await?;
    Ok(resolved)
}

fn validate_adapter_file(path: &str, label: &str, extensions: &[&str]) -> Result<(), AppError> {
    let metadata = fs::metadata(path).map_err(|error| {
        AppError::new(
            AppError::io_kind(&error),
            format!("{label} file does not exist or is unreadable: {path} ({error})"),
        )
    })?;
    if !metadata.is_file() {
        return Err(AppError::validation(format!(
            "{label} path is not a regular file: {path}"
        )));
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if !extension
        .as_deref()
        .is_some_and(|value| extensions.contains(&value))
    {
        return Err(AppError::validation(format!(
            "{label} must use one of [{}]: {path}",
            extensions.join(", ")
        )));
    }
    crate::models::validate_model_shards(Path::new(path))?;
    Ok(())
}

/// llama.cpp b10840 loads CLIP projectors through mtmd/clip.cpp, separately
/// from primary and draft language models. Only an inspected architecture is
/// used here; filenames cannot establish a matching projector/model pair.
fn validate_llama_model_role(path: &str, label: &str, projector: bool) -> Result<(), AppError> {
    let architecture = crate::gguf::read_metadata(Path::new(path))
        .ok()
        .and_then(|metadata| metadata.architecture);
    if let Some(architecture) = architecture {
        if (architecture == "clip") != projector {
            return Err(AppError::validation(if projector {
                format!(
                    "{label} must be a multimodal projector, not a {architecture} language model"
                )
            } else {
                format!("{label} cannot be a multimodal projector; attach it through mmproj")
            }));
        }
    }
    Ok(())
}

fn runtime_has_flag(capabilities: &runtime::RuntimeCapabilities, aliases: &[&str]) -> bool {
    aliases.iter().any(|alias| {
        capabilities.flags.iter().any(|flag| {
            flag == alias || flag.split_once('=').is_some_and(|(name, _)| name == *alias)
        })
    })
}

fn validate_runtime_adapter_capabilities(
    cfg: &config::AppConfig,
    capabilities: &runtime::RuntimeCapabilities,
) -> Result<(), AppError> {
    if capabilities.state != "available" {
        let details = capabilities.diagnostics.join("; ");
        return Err(AppError::new(
            if capabilities.state == "not installed" {
                crate::error::ErrorKind::NotFound
            } else {
                crate::error::ErrorKind::Unavailable
            },
            format!(
                "selected runtime failed preflight ({}): {}",
                capabilities.state,
                if details.is_empty() {
                    "no diagnostics"
                } else {
                    &details
                }
            ),
        ));
    }
    if tuning_defaults::speculative_enabled(cfg)
        && cfg.spec_type == "draft-dflash"
        && !capabilities.supports_dflash
    {
        return Err(AppError::validation("the selected runtime does not advertise draft-dflash support. Select a current DFlash-capable release, compatibility build, or PR #27342 runtime."));
    }
    if !cfg.mmproj.trim().is_empty() && !runtime_has_flag(capabilities, &["--mmproj", "-mm"]) {
        return Err(AppError::validation(
            "selected runtime does not expose an mmproj/projector flag",
        ));
    }
    if cfg.lora_adapters.iter().any(|adapter| adapter.enabled)
        && !runtime_has_flag(capabilities, &["--lora"])
    {
        return Err(AppError::validation(
            "selected runtime does not expose the --lora flag",
        ));
    }
    if cfg
        .lora_adapters
        .iter()
        .any(|adapter| adapter.enabled && (adapter.scale - 1.0).abs() >= f32::EPSILON)
        && !runtime_has_flag(capabilities, &["--lora-scaled"])
    {
        return Err(AppError::validation(
            "a scaled LoRA adapter requires the runtime --lora-scaled flag",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_projector_and_draft_bindings_follow_inspected_gguf_roles() {
        use crate::gguf::fixture::{file, Value};
        let root = std::env::temp_dir().join(format!("aiolm-model-roles-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let primary = root.join("language.gguf");
        let projector = root.join("vision.gguf");
        for (path, architecture) in [(&primary, "llama"), (&projector, "clip")] {
            fs::write(
                path,
                file(
                    &[("general.architecture".into(), Value::Str(architecture))],
                    &[],
                ),
            )
            .unwrap();
        }
        let mut cfg = config::AppConfig {
            active_model: primary.to_string_lossy().into_owned(),
            active_backend: "cpu".into(),
            active_build: "b123".into(),
            mmproj: projector.to_string_lossy().into_owned(),
            ..Default::default()
        };
        validate_start_config(&mut cfg)
            .expect("a language model and projector pass role validation");
        cfg.active_model = projector.to_string_lossy().into_owned();
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("model cannot be a multimodal projector"));
        cfg.active_model = primary.to_string_lossy().into_owned();
        cfg.mmproj = primary.to_string_lossy().into_owned();
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("projector must be a multimodal projector"));
        cfg.mmproj.clear();
        cfg.spec_type = "draft".into();
        cfg.spec_draft_model = projector.to_string_lossy().into_owned();
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("draft model cannot be a multimodal projector"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn start_validation_rejects_incomplete_model_shards() {
        let root =
            std::env::temp_dir().join(format!("aiolm-shard-preflight-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("model-00001-of-00002.gguf");
        let second = root.join("model-00002-of-00002.gguf");
        fs::write(&first, b"synthetic shard").unwrap();
        let mut cfg = config::AppConfig {
            active_model: first.to_string_lossy().into_owned(),
            active_backend: "cpu".into(),
            active_build: "b123".into(),
            ..Default::default()
        };
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("shard is missing"));
        fs::write(&second, b"synthetic shard").unwrap();
        assert!(validate_start_config(&mut cfg).is_ok());
        cfg.active_model = second.to_string_lossy().into_owned();
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("first GGUF shard"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn start_validation_rejects_missing_projector_and_enabled_adapter() {
        let root = std::env::temp_dir().join(format!("aiolm-adapter-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create adapter test directory");
        let model = root.join("model.gguf");
        fs::write(&model, b"model").expect("write model fixture");
        let invalid_model = root.join("model.bin");
        fs::write(&invalid_model, b"model").expect("write invalid model fixture");
        let mut invalid_cfg = config::AppConfig {
            active_model: invalid_model.to_string_lossy().into_owned(),
            active_backend: "cpu".into(),
            active_build: "b123".into(),
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut invalid_cfg)
            .unwrap_err()
            .message
            .contains("model must use"));
        let mut cfg = config::AppConfig {
            active_model: model.to_string_lossy().into_owned(),
            active_backend: "cpu".into(),
            active_build: "b123".into(),
            mmproj: root
                .join("missing-mmproj.gguf")
                .to_string_lossy()
                .into_owned(),
            ..config::AppConfig::default()
        };
        let error = validate_start_config(&mut cfg).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::NotFound);
        assert!(error.message.contains("projector"));
        cfg.mmproj.clear();
        cfg.lora_adapters.push(config::LoraAdapterConfig {
            path: root
                .join("missing-lora.gguf")
                .to_string_lossy()
                .into_owned(),
            scale: 1.0,
            enabled: true,
        });
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("LoRA"));
        let mut dflash_cfg = config::AppConfig {
            active_model: model.to_string_lossy().into_owned(),
            active_backend: "cpu".into(),
            active_build: "b123".into(),
            spec_type: "draft-dflash".into(),
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut dflash_cfg)
            .unwrap_err()
            .message
            .contains("draft model"));
        dflash_cfg.active_backend = "cpu".into();
        dflash_cfg.active_build = "pr27342".into();
        assert!(validate_start_config(&mut dflash_cfg)
            .unwrap_err()
            .message
            .contains("draft model"));
        let draft = root.join("draft.gguf");
        fs::write(&draft, b"draft model fixture").expect("write draft model fixture");
        dflash_cfg.spec_draft_model = draft.to_string_lossy().into_owned();
        assert!(validate_start_config(&mut dflash_cfg).is_ok());

        let mut mismatched_cfg = config::AppConfig {
            active_model: model.to_string_lossy().into_owned(),
            active_backend: "cpu".into(),
            active_build: "b123".into(),
            spec_type: "draft-mtp".into(),
            spec_draft_model: root
                .join("Qwen3.8-27B-DFlash2-Q4_K_M.gguf")
                .to_string_lossy()
                .into_owned(),
            ..config::AppConfig::default()
        };
        fs::write(&mismatched_cfg.spec_draft_model, b"draft model fixture")
            .expect("write mismatched draft fixture");
        let error = validate_start_config(&mut mismatched_cfg)
            .expect_err("DFlash model cannot be launched as MTP");
        assert!(error.message.contains("draft-dflash"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn start_validation_requires_a_managed_runtime() {
        let mut cfg = config::AppConfig {
            active_model: "model.gguf".into(),
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("installed in AioLM"));
        cfg.active_backend = "cpu".into();
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("must be selected together"));
        cfg.active_build = "b123".into();
        // A complete runtime pair moves past the gate to the model check.
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .message
            .contains("model file does not exist"));
    }

    #[test]
    fn runtime_capability_gating_requires_adapter_flags() {
        let cfg = config::AppConfig {
            mmproj: "projector.gguf".into(),
            lora_adapters: vec![config::LoraAdapterConfig {
                path: "adapter.gguf".into(),
                scale: 0.5,
                enabled: true,
            }],
            ..config::AppConfig::default()
        };
        let mut capabilities = runtime::RuntimeCapabilities {
            server_help: String::new(),
            backend: "vulkan".into(),
            build: "test".into(),
            executable: "llama-server".into(),
            state: "available".into(),
            version: "test".into(),
            flags: vec!["--mmproj".into(), "--lora".into()],
            supports_dflash: false,
            devices: vec![],
            diagnostics: vec![],
            bench_available: true,
        };
        assert!(validate_runtime_adapter_capabilities(&cfg, &capabilities)
            .unwrap_err()
            .message
            .contains("lora-scaled"));
        capabilities.flags.push("--lora-scaled=PATH SCALE".into());
        assert!(validate_runtime_adapter_capabilities(&cfg, &capabilities).is_ok());
        let mut dflash_cfg = config::AppConfig {
            spec_type: "draft-dflash".into(),
            ..Default::default()
        };
        assert!(
            validate_runtime_adapter_capabilities(&dflash_cfg, &capabilities)
                .unwrap_err()
                .message
                .contains("draft-dflash")
        );
        capabilities.supports_dflash = true;
        dflash_cfg.active_build = "local_b10840_nop2p".into();
        assert!(validate_runtime_adapter_capabilities(&dflash_cfg, &capabilities).is_ok());
    }
}
