//! One validated selection shared by the desktop, CLI and API gateway.
use super::{artifacts, compat, launch, protocol::EngineInfo, python_env, ProviderId};
use crate::config::AppConfig;
use std::path::Path;

fn vllm_chat_support(
    model: &Path,
    options: &serde_json::Map<String, serde_json::Value>,
    metal: bool,
    harmony: bool,
) -> Option<bool> {
    if harmony
        || options
            .get("chat_template")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Some(true);
    }
    let tokenizer = if model.is_dir() {
        model
    } else if metal {
        // The Metal GGUF launch uses its adjacent tokenizer, rather than
        // the tokenizer/chat metadata embedded in the GGUF weights.
        model.parent()?
    } else {
        return None;
    };
    if ![
        "tokenizer_config.json",
        "chat_template.json",
        "chat_template.jinja",
    ]
    .iter()
    .any(|name| tokenizer.join(name).is_file())
    {
        return None;
    }
    Some(artifacts::inspect_snapshot(tokenizer).has_chat_template)
}

pub fn inspect(path: &Path) -> Result<artifacts::ModelArtifact, String> {
    if path.is_dir() {
        return Ok(artifacts::inspect_snapshot(path));
    }
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("model is unreadable: {error}"))?;
    if !metadata.is_file() {
        return Err("select a model file or snapshot directory".into());
    }
    crate::models::validate_model_shards(path)?;
    Ok(artifacts::inspect_gguf(path, metadata.len(), &[]))
}

pub fn compatibility(cfg: &AppConfig) -> Result<compat::ModelCompatibility, String> {
    let artifact = inspect(Path::new(&cfg.active_model))?;
    let provider = super::provider_of(cfg);
    let runtime = if provider == ProviderId::Llama {
        None
    } else {
        Some(super::selected_python_runtime(cfg)?)
    };
    let mut result = compat::assess(
        &artifact,
        provider,
        runtime.as_ref().and_then(|value| value.probe.as_ref()),
    );
    if provider == ProviderId::Llama && !cfg.mmproj.is_empty() {
        let projector = inspect(Path::new(&cfg.mmproj))?;
        if projector.role != artifacts::ArtifactRole::Projector {
            return Err("select a multimodal projector for this model".into());
        }
        result.modalities.image = projector.modalities.image;
        result.modalities.audio = projector.modalities.audio;
        // Video decoding was added to llama-server independently of image input.
        // Enable it only when the installed runtime reports the video flags.
        result.modalities.video = false;
        result.readiness.extend(projector.missing.iter().cloned());
    }
    Ok(result)
}

pub async fn probed_info(cfg: &AppConfig) -> Result<EngineInfo, String> {
    let mut info = info(cfg)?;
    if info.provider == ProviderId::Llama && info.modalities.image {
        let probe = crate::runtime::probe(&cfg.active_backend, &cfg.active_build).await?;
        info.modalities.video = probe.flags.iter().any(|flag| flag == "--video-fps");
    }
    Ok(info)
}

pub fn validate(cfg: &AppConfig) -> Result<(), String> {
    let provider = super::provider_of(cfg);
    let availability = provider.availability();
    if !availability.supported {
        return Err(availability.detail);
    }
    let result = compatibility(cfg)?;
    if !result.loadable() {
        return Err(result
            .reasons
            .iter()
            .map(|value| value.detail.as_str())
            .collect::<Vec<_>>()
            .join("; "));
    }
    if !result.readiness.is_empty() {
        return Err(result.readiness.join("; "));
    }
    if provider != ProviderId::Llama {
        let runtime = super::selected_python_runtime(cfg)?;
        launch::engine_command(cfg, &runtime, cfg.port, "")?;
    }
    Ok(())
}

pub fn info(cfg: &AppConfig) -> Result<EngineInfo, String> {
    let provider = super::provider_of(cfg);
    let compatible = compatibility(cfg)?;
    let modalities = compatible.modalities;
    if provider == ProviderId::Llama {
        let mut info = EngineInfo::llama(&cfg.active_model, modalities);
        info.runtime_id = super::runtime_id_of(cfg);
        return Ok(info);
    }
    let runtime = super::selected_python_runtime(cfg)?;
    let options = launch::provider_options(cfg, provider);
    let primary_embedding =
        !compatible.tasks.contains(&"generate") && compatible.tasks.contains(&"embed");
    let pooling = provider == ProviderId::Vllm
        && (primary_embedding
            || options.get("runner").and_then(serde_json::Value::as_str) == Some("pooling"));
    let embedding_model = if provider == ProviderId::MlxVlm {
        if primary_embedding {
            Some(cfg.active_model.clone())
        } else {
            options
                .get("embedding_model")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        }
    } else if pooling {
        Some(launch::served_model_name(&cfg.active_model))
    } else {
        None
    };
    let embedding_namespace = embedding_model.as_ref().map(|model| {
        let path = if provider == ProviderId::Vllm {
            cfg.active_model.as_str()
        } else {
            model
        };
        let artifact = inspect(Path::new(path))
            .unwrap_or_else(|_| artifacts::inspect_snapshot(Path::new(path)));
        format!(
            "{}:{}:{}",
            provider.as_str(),
            path,
            artifacts::local_fingerprint(Path::new(path), artifact.revision.as_deref())
        )
    });
    // vLLM v0.31.0 `renderers/online_renderer.py`: `tool_choice` "auto" needs
    // --enable-auto-tool-choice and --tool-call-parser, "required" or a named
    // function needs the parser, and gpt-oss (Harmony) parses tools itself.
    let auto_tools = options
        .get("enable_auto_tool_choice")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let tool_parser = options
        .get("tool_call_parser")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let harmony = provider == ProviderId::Vllm
        && artifacts::inspect_snapshot(Path::new(&cfg.active_model))
            .model_type
            .as_deref()
            == Some("gpt_oss");
    let schema_options = options
        .iter()
        .filter(|(key, _)| !launch::BINDING_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Ok(EngineInfo {
        provider,
        runtime_id: runtime.id.clone(),
        runtime_variant: runtime
            .probe
            .as_ref()
            .map(|probe| probe.variant.clone())
            .unwrap_or_default(),
        speech_model_type: compatible
            .tasks
            .contains(&"transcription")
            .then(|| {
                inspect(Path::new(&cfg.active_model))
                    .ok()
                    .and_then(|artifact| artifact.model_type)
            })
            .flatten(),
        upstream_model: launch::engine_command(cfg, &runtime, cfg.port, "")?.upstream_model,
        modalities,
        tasks: if compatible.tasks.contains(&"transcription") {
            compatible
                .tasks
                .iter()
                .map(|task| (*task).to_owned())
                .collect()
        } else if pooling || primary_embedding {
            vec!["embed".into()]
        } else if embedding_model.is_some() {
            vec!["generate".into(), "embed".into()]
        } else {
            vec!["generate".into()]
        },
        request_fields: super::options::request_fields(provider, &schema_options),
        chat_supported: if provider == ProviderId::Vllm
            && compatible.tasks.contains(&"generate")
            && !pooling
        {
            vllm_chat_support(
                Path::new(&cfg.active_model),
                &options,
                compat::is_metal(runtime.probe.as_ref()),
                harmony,
            )
        } else {
            None
        },
        request_lora: options
            .get(launch::REQUEST_LORA_KEY)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        embedding_model,
        embedding_namespace,
        tools_auto: provider != ProviderId::Vllm || harmony || (auto_tools && tool_parser),
        tool_parser: provider != ProviderId::Vllm || harmony || tool_parser,
    })
}

pub fn probe_for(provider: ProviderId, id: Option<&str>) -> Option<python_env::ProbeRecord> {
    id.and_then(|id| python_env::read(provider, id).ok())
        .and_then(|runtime| runtime.probe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vllm_chat_checks_the_selected_tokenizer_and_preserves_unknown_renderers() {
        let dir =
            std::env::temp_dir().join(format!("aiolm-chat-template-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let options = serde_json::Map::new();
        assert_eq!(vllm_chat_support(&dir, &options, true, false), None);
        std::fs::write(
            dir.join("tokenizer_config.json"),
            br#"{"eos_token":"synthetic"}"#,
        )
        .unwrap();
        assert_eq!(vllm_chat_support(&dir, &options, true, false), Some(false));
        let gguf = dir.join("weights.gguf");
        assert_eq!(vllm_chat_support(&gguf, &options, true, false), Some(false));
        assert_eq!(vllm_chat_support(&gguf, &options, false, false), None);
        std::fs::write(
            dir.join("tokenizer_config.json"),
            br#"{"chat_template":"{{ messages }}"}"#,
        )
        .unwrap();
        assert_eq!(vllm_chat_support(&gguf, &options, true, false), Some(true));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn vllm_explicit_templates_and_harmony_do_not_require_tokenizer_templates() {
        let absent =
            std::env::temp_dir().join(format!("aiolm-absent-template-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            vllm_chat_support(&absent, &serde_json::Map::new(), true, true),
            Some(true)
        );
        let options = json!({"chat_template":"synthetic.jinja"});
        assert_eq!(
            vllm_chat_support(&absent, options.as_object().unwrap(), true, false),
            Some(true)
        );
    }
}
