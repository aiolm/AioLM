//! Launch configuration and runtime capability validation shared with the CLI.
use crate::{config, gpu, hardware, runtime, tuning_defaults};
use std::fs;
use std::path::Path;
use std::sync::{atomic::AtomicBool, Arc};

fn validate_start_config(cfg: &mut config::AppConfig) -> Result<(), String> {
    cfg.normalize();
    cfg.validate()?;
    if cfg.active_model.trim().is_empty() {
        return Err("select a GGUF model before starting the server".into());
    }
    validate_adapter_file(&cfg.active_model, "model", &["gguf"])?;
    if !cfg.mmproj.trim().is_empty() {
        validate_adapter_file(&cfg.mmproj, "projector", &["gguf", "mmproj"])?;
    }
    for adapter in cfg.lora_adapters.iter().filter(|adapter| adapter.enabled) {
        validate_adapter_file(&adapter.path, "LoRA adapter", &["gguf"])?;
    }
    if tuning_defaults::speculative_enabled(cfg) && !cfg.spec_draft_model.trim().is_empty() {
        validate_adapter_file(&cfg.spec_draft_model, "draft model", &["gguf"])?;
        let draft_name = Path::new(&cfg.spec_draft_model)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if draft_name.contains("dflash") && cfg.spec_type != "draft-dflash" {
            return Err(
                "a DFlash draft model requires speculative type 'draft-dflash' and a runtime supporting DFlash"
                    .into(),
            );
        }
    }
    if tuning_defaults::speculative_enabled(cfg)
        && cfg.spec_type == "draft-dflash"
        && cfg.spec_draft_model.trim().is_empty()
    {
        return Err(
            "DFlash2 requires a draft model. Set the draft model GGUF path in Tuning before starting the server.".into(),
        );
    }
    if !cfg.active_backend.is_empty() {
        runtime::validate_runtime_identifiers(&cfg.active_backend, &cfg.active_build)?;
    }
    Ok(())
}

pub async fn validate_launch_config(
    cfg: &mut config::AppConfig,
) -> Result<gpu::ResolvedGpu, String> {
    validate_launch_config_with_cancel(cfg, None).await
}

pub(super) async fn validate_launch_config_with_cancel(
    cfg: &mut config::AppConfig,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<gpu::ResolvedGpu, String> {
    validate_start_config(cfg)?;
    if !cfg.active_backend.is_empty() {
        let repair_cancel = cancel
            .cloned()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        runtime::repair_runtime_dependencies(&cfg.active_backend, &cfg.active_build, repair_cancel)
            .await?;
        let capabilities = match cancel {
            Some(cancel) => {
                runtime::probe_cancellable(&cfg.active_backend, &cfg.active_build, cancel).await?
            }
            None => runtime::probe(&cfg.active_backend, &cfg.active_build).await?,
        };
        validate_runtime_adapter_capabilities(cfg, &capabilities)?;
        gpu::validate_safe_auto_placement(&cfg.gpu, &cfg.active_backend, &capabilities.devices)?;
        let resolved = gpu::resolve_with_runtime_devices(
            &cfg.gpu,
            &cfg.active_backend,
            &hardware::detect(),
            &capabilities.devices,
        )?;
        gpu::validate_known_rocm_peer_issue(cfg, &resolved, &capabilities.devices)?;
        return Ok(resolved);
    }
    gpu::resolve(&cfg.gpu, &cfg.active_backend, &hardware::detect())
}

fn validate_adapter_file(path: &str, label: &str, extensions: &[&str]) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!("{label} file does not exist or is unreadable: {path} ({error})")
    })?;
    if !metadata.is_file() {
        return Err(format!("{label} path is not a regular file: {path}"));
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if !extension
        .as_deref()
        .is_some_and(|value| extensions.contains(&value))
    {
        return Err(format!(
            "{label} must use one of [{}]: {path}",
            extensions.join(", ")
        ));
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
) -> Result<(), String> {
    if capabilities.state != "available" {
        let details = capabilities.diagnostics.join("; ");
        return Err(format!(
            "selected runtime failed preflight ({}): {}",
            capabilities.state,
            if details.is_empty() {
                "no diagnostics"
            } else {
                &details
            }
        ));
    }
    if tuning_defaults::speculative_enabled(cfg)
        && cfg.spec_type == "draft-dflash"
        && !capabilities.supports_dflash
    {
        return Err("the selected runtime does not advertise draft-dflash support. Select a current DFlash-capable release, compatibility build, or PR #27342 runtime.".into());
    }
    if !cfg.mmproj.trim().is_empty() && !runtime_has_flag(capabilities, &["--mmproj", "-mm"]) {
        return Err("selected runtime does not expose an mmproj/projector flag".into());
    }
    if cfg.lora_adapters.iter().any(|adapter| adapter.enabled)
        && !runtime_has_flag(capabilities, &["--lora"])
    {
        return Err("selected runtime does not expose the --lora flag".into());
    }
    if cfg
        .lora_adapters
        .iter()
        .any(|adapter| adapter.enabled && (adapter.scale - 1.0).abs() >= f32::EPSILON)
        && !runtime_has_flag(capabilities, &["--lora-scaled"])
    {
        return Err("a scaled LoRA adapter requires the runtime --lora-scaled flag".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut invalid_cfg)
            .unwrap_err()
            .contains("model must use"));
        let mut cfg = config::AppConfig {
            active_model: model.to_string_lossy().into_owned(),
            mmproj: root
                .join("missing-mmproj.gguf")
                .to_string_lossy()
                .into_owned(),
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut cfg)
            .unwrap_err()
            .contains("projector"));
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
            .contains("LoRA"));
        let mut dflash_cfg = config::AppConfig {
            active_model: model.to_string_lossy().into_owned(),
            spec_type: "draft-dflash".into(),
            ..config::AppConfig::default()
        };
        assert!(validate_start_config(&mut dflash_cfg)
            .unwrap_err()
            .contains("draft model"));
        dflash_cfg.active_backend = "cpu".into();
        dflash_cfg.active_build = "pr27342".into();
        assert!(validate_start_config(&mut dflash_cfg)
            .unwrap_err()
            .contains("draft model"));
        let draft = root.join("draft.gguf");
        fs::write(&draft, b"draft model fixture").expect("write draft model fixture");
        dflash_cfg.spec_draft_model = draft.to_string_lossy().into_owned();
        assert!(validate_start_config(&mut dflash_cfg).is_ok());

        let mut mismatched_cfg = config::AppConfig {
            active_model: model.to_string_lossy().into_owned(),
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
        assert!(error.contains("draft-dflash"));
        let _ = fs::remove_dir_all(root);
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
                .contains("draft-dflash")
        );
        capabilities.supports_dflash = true;
        dflash_cfg.active_build = "local_b10840_nop2p".into();
        assert!(validate_runtime_adapter_capabilities(&dflash_cfg, &capabilities).is_ok());
    }
}
