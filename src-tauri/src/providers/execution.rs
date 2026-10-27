//! One validated selection shared by the desktop, CLI and API gateway.
use super::{artifacts, compat, launch, protocol::EngineInfo, python_env, ProviderId};
use crate::config::AppConfig;
use std::path::Path;

mod readiness;
pub use readiness::confirm_ready;

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
    if super::provider_of(cfg).is_custom() {
        return super::registry::compatibility(cfg);
    }
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
    if info.provider != ProviderId::Llama {
        return Ok(info);
    }
    let args = super::adapter::native_arguments(cfg, "", &crate::gpu::ResolvedGpu::default())?;
    let mode = llama_mode(&args, None)?;
    if info.modalities.image || mode.is_none() {
        let probe = crate::runtime::probe(&cfg.active_backend, &cfg.active_build).await?;
        if info.modalities.image {
            info.modalities.video = probe.flags.iter().any(|flag| flag == "--video-fps");
        }
        if mode.is_none() {
            let mode = llama_mode(&args, Some(&probe.server_help))?.ok_or(
                "the installed llama-server help could not be read to verify its launch mode",
            )?;
            set_llama_mode(&mut info, mode, &cfg.active_model)?;
        }
    }
    Ok(info)
}

pub fn validate(cfg: &AppConfig) -> Result<(), String> {
    let provider = super::provider_of(cfg);
    if provider.is_custom() {
        super::registry::command(cfg, cfg.port, "")?;
        return Ok(());
    }
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
    } else {
        super::adapter::native_arguments(cfg, "", &crate::gpu::ResolvedGpu::default())?;
    }
    Ok(())
}

pub fn info(cfg: &AppConfig) -> Result<EngineInfo, String> {
    super::adapter::resolve(cfg).engine_info(cfg)
}

/// Request settings never change launch arguments, so a running session keeps
/// the inputs and tasks its launch verified instead of a provisional rebuild.
pub fn keep_launch_capabilities(engine: &mut EngineInfo, launched: &EngineInfo) {
    engine.modalities = launched.modalities;
    engine.tasks = launched.tasks.clone();
    engine.chat_supported = launched.chat_supported;
    engine.embedding_model = launched.embedding_model.clone();
    engine.tools_auto = launched.tools_auto;
    engine.tool_parser = launched.tool_parser;
}

// llama.cpp b11617 `common/arg.cpp`: `--embedding`/`--embeddings` set
// `params.embedding`, restricting llama-server to the embedding use case, and
// `--rerank`/`--reranking` set it with rank pooling. `/v1/embeddings` answers
// only in embedding mode; chat then fails inside the engine.
const LLAMA_EMBEDDING_FLAGS: &[&str] = &["--embedding", "--embeddings"];
const LLAMA_RERANK_FLAGS: &[&str] = &["--rerank", "--reranking"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LlamaMode {
    Generate,
    Embed,
    Rerank,
}

/// b11617 looks `--` arguments up with `_` read as `-`.
fn llama_argument_name(argument: &str) -> String {
    if argument.starts_with("--") {
        argument.replace('_', "-")
    } else {
        argument.to_owned()
    }
}

/// The leading `--?[A-Za-z][\w.-]*` option name of a help signature part.
fn help_flag(text: &str) -> Option<&str> {
    let body = text.strip_prefix("--").or_else(|| text.strip_prefix('-'))?;
    if !body.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let end = body
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
        .unwrap_or(body.len());
    Some(&text[..text.len() - body.len() + end])
}

/// Option names and value counts from the installed llama-server `--help`,
/// read the way `parseRuntimeHelp`/`describeServerOption` in
/// `src/shared/config/serverOptions.ts` read it: b11617 prints each option's
/// names joined by `, ` and then its value hints, and aligns the description
/// after two or more spaces.
fn llama_help_arity(help: &str) -> std::collections::HashMap<String, usize> {
    let mut arity = std::collections::HashMap::new();
    let lines = help
        .lines()
        .map(|line| {
            let mut plain = String::with_capacity(line.len());
            let mut chars = line.chars();
            while let Some(c) = chars.next() {
                if c == '\u{1b}' {
                    for end in chars.by_ref() {
                        if end == 'm' {
                            break;
                        }
                    }
                } else {
                    plain.push(c);
                }
            }
            plain
        })
        .collect::<Vec<_>>();
    let Some(indent) = lines
        .iter()
        .filter(|line| help_flag(line.trim_start()).is_some())
        .map(|line| line.len() - line.trim_start().len())
        .min()
    else {
        return arity;
    };
    for line in &lines {
        let text = line.trim();
        if line.len() - line.trim_start().len() != indent || help_flag(text).is_none() {
            continue;
        }
        let mut parts = Vec::new();
        let mut rest = text;
        loop {
            let name_break = rest.match_indices(',').find_map(|(index, _)| {
                let after = &rest[index + 1..];
                let next = after.trim_start();
                (next.len() < after.len() && next.starts_with('-'))
                    .then_some((index, after.len() - next.len()))
            });
            let description = rest
                .char_indices()
                .zip(rest.chars().skip(1))
                .find(|((_, a), b)| a.is_whitespace() && b.is_whitespace())
                .map(|((index, _), _)| index);
            match (name_break, description) {
                (Some((index, gap)), end) if end.is_none_or(|end| index < end) => {
                    parts.push(&rest[..index]);
                    rest = &rest[index + 1 + gap..];
                }
                (_, end) => {
                    parts.push(&rest[..end.unwrap_or(rest.len())]);
                    break;
                }
            }
        }
        let last = parts.last().copied().unwrap_or_default();
        let argument = last[help_flag(last).map_or(0, str::len)..]
            .trim()
            .trim_start_matches('=');
        let count = match argument {
            "" => 0,
            "START END" | "FNAME SCALE" => 2,
            _ => 1,
        };
        for part in parts {
            if let Some(flag) = help_flag(part) {
                arity.insert(flag.to_owned(), count);
            }
        }
    }
    arity
}

/// What a llama-server launch serves. Without any mode token the default
/// generation mode is certain; otherwise every token must be walked with the
/// installed runtime's own value counts, because a value-taking option
/// consumes the next argument even when it starts with `-`. `Ok(None)` means
/// a mode token is present and no help was supplied to decide it.
fn llama_mode(args: &[String], help: Option<&str>) -> Result<Option<LlamaMode>, String> {
    let is_mode =
        |name: &str| LLAMA_EMBEDDING_FLAGS.contains(&name) || LLAMA_RERANK_FLAGS.contains(&name);
    if !args
        .iter()
        .any(|argument| is_mode(&llama_argument_name(argument)))
    {
        return Ok(Some(LlamaMode::Generate));
    }
    let Some(help) = help else {
        return Ok(None);
    };
    let arity = llama_help_arity(help);
    if arity.is_empty() {
        return Ok(None);
    }
    let (mut embedding, mut rerank) = (false, false);
    let mut index = 0;
    while index < args.len() {
        let name = llama_argument_name(&args[index]);
        let count = *arity.get(&name).ok_or_else(|| {
            format!("the installed llama-server help does not list argument {name}, so its launch mode cannot be verified")
        })?;
        if count == 0 {
            embedding |= LLAMA_EMBEDDING_FLAGS.contains(&name.as_str());
            rerank |= LLAMA_RERANK_FLAGS.contains(&name.as_str());
        }
        index += 1 + count;
    }
    Ok(Some(if rerank {
        LlamaMode::Rerank
    } else if embedding {
        LlamaMode::Embed
    } else {
        LlamaMode::Generate
    }))
}

fn set_llama_mode(info: &mut EngineInfo, mode: LlamaMode, model: &str) -> Result<(), String> {
    match mode {
        LlamaMode::Generate => {
            info.tasks = vec!["generate".into()];
            info.embedding_model = None;
        }
        LlamaMode::Embed => {
            info.tasks = vec!["embed".into()];
            info.embedding_model = Some(model.to_owned());
            info.chat_supported = Some(false);
            info.tools_auto = false;
            info.tool_parser = false;
        }
        LlamaMode::Rerank => {
            return Err("llama-server --rerank serves only its rerank endpoint, which AioLM does not route; remove it to serve chat, or use --embedding for embeddings".into());
        }
    }
    Ok(())
}

fn llama_info(cfg: &AppConfig, modalities: artifacts::Modalities) -> Result<EngineInfo, String> {
    let mut info = EngineInfo::llama(&cfg.active_model, modalities);
    info.runtime_id = super::runtime_id_of(cfg);
    match llama_mode(
        &super::adapter::native_arguments(cfg, "", &crate::gpu::ResolvedGpu::default())?,
        None,
    )? {
        Some(mode) => set_llama_mode(&mut info, mode, &cfg.active_model)?,
        // Provisional until `probed_info` reads the installed help at launch:
        // claim no task, so this value cannot route a request if it escapes.
        // A running session keeps its launch-verified mode across request
        // setting updates.
        None => {
            info.tasks = Vec::new();
            info.embedding_model = None;
            info.chat_supported = Some(false);
            info.tools_auto = false;
            info.tool_parser = false;
        }
    }
    Ok(info)
}

pub(super) fn builtin_info(cfg: &AppConfig) -> Result<EngineInfo, String> {
    let provider = super::provider_of(cfg);
    let compatible = compatibility(cfg)?;
    let modalities = compatible.modalities;
    if provider == ProviderId::Llama {
        return llama_info(cfg, modalities);
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
        request_option_keys: Vec::new(),
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

    /// Signatures copied from llama.cpp b11617 `tools/server/README.md`,
    /// laid out the way `common_arg::to_string` prints `--help`.
    const B11617_HELP: &str = "----- common params -----

-h,    --help, --usage                  print usage and exit
-m,    --model FNAME                    model path to load
                                        (env: LLAMA_ARG_MODEL)
-c,    --ctx-size N                     size of the prompt context (default: 0, 0 = loaded from model)
-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, -1 = all
--control-vector-layer-range START END
                                        layer range to apply the control vector(s) to, start and end
                                        inclusive
-cb,   --cont-batching, -nocb, --no-cont-batching
                                        whether to enable continuous batching
-a,    --alias STRING                   set model name aliases, comma-separated (to be used by API)
--jinja, --no-jinja                     whether to use jinja template engine for chat (default: enabled)
--chat-template JINJA_TEMPLATE          set custom jinja chat template, -1 = model metadata
--embedding, --embeddings               restrict to only support embedding use case; use only with
                                        dedicated embedding models (default: disabled)
--rerank, --reranking                   enable reranking endpoint on server (default: disabled)
";

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn adapt(info: &EngineInfo, endpoint: &str, mut body: serde_json::Value) -> Result<(), String> {
        super::super::protocol::adapt_request(info, endpoint, &mut body)
            .map_err(|error| format!("{}: {}", error.code, error.message))
    }

    #[test]
    fn llama_help_arity_reads_installed_value_hints() {
        let arity = llama_help_arity(&format!("\u{1b}[1m{B11617_HELP}\u{1b}[0m"));
        for (flag, count) in [
            ("-h", 0),
            ("--usage", 0),
            ("-m", 1),
            ("--model", 1),
            ("--ctx-size", 1),
            ("-ngl", 1),
            ("--n-gpu-layers", 1),
            ("--control-vector-layer-range", 2),
            ("-nocb", 0),
            ("--no-cont-batching", 0),
            ("--alias", 1),
            ("--no-jinja", 0),
            ("--chat-template", 1),
            ("--embedding", 0),
            ("--embeddings", 0),
            ("--reranking", 0),
        ] {
            assert_eq!(arity.get(flag), Some(&count), "{flag}");
        }
        // Prose and continuation lines are not options.
        assert!(!arity.contains_key("-1") && !arity.contains_key("--1"));
        assert_eq!(arity.len(), 24);
    }

    #[test]
    fn llama_mode_decides_mode_tokens_with_installed_value_counts() {
        let help = Some(B11617_HELP);
        let mode = |values: &[&str], help| llama_mode(&args(values), help);
        // Without a mode token no option value can enable embedding mode.
        assert_eq!(
            mode(&["-m", "x.gguf", "--jinja"], None),
            Ok(Some(LlamaMode::Generate))
        );
        // A token alone cannot say whether it is a flag or a consumed value.
        assert_eq!(mode(&["--embedding"], None), Ok(None));
        assert_eq!(mode(&["--embedding"], Some("")), Ok(None));
        for flag in ["--embedding", "--embeddings"] {
            assert_eq!(
                mode(&["-m", "x.gguf", flag], help),
                Ok(Some(LlamaMode::Embed))
            );
        }
        // b11617 reads `--ctx_size` as `--ctx-size`.
        assert_eq!(
            mode(&["--ctx_size", "512", "--embedding"], help),
            Ok(Some(LlamaMode::Embed))
        );
        // A value-taking option consumes the next argument even when it
        // starts with `-`, so these are a chat template, an alias and a
        // control-vector range end, not mode flags.
        for values in [
            &["--chat-template", "--embedding"][..],
            &["-a", "--embeddings", "--jinja"],
            &["--control-vector-layer-range", "0", "--embedding"],
            &["--chat-template", "--rerank"],
        ] {
            assert_eq!(
                mode(values, help),
                Ok(Some(LlamaMode::Generate)),
                "{values:?}"
            );
        }
        assert_eq!(mode(&["--reranking"], help), Ok(Some(LlamaMode::Rerank)));
        assert_eq!(
            mode(&["--embedding", "--rerank"], help),
            Ok(Some(LlamaMode::Rerank))
        );
        let unlisted = mode(&["--embedding", "--unlisted-build-option", "1"], help).unwrap_err();
        assert!(unlisted.contains("--unlisted-build-option"), "{unlisted}");
    }

    #[test]
    fn llama_embedding_mode_serves_embeddings_and_advertises_no_chat_or_tools() {
        let inputs = artifacts::Modalities {
            text: true,
            image: true,
            audio: false,
            video: false,
        };
        let mut info = EngineInfo::llama("synthetic-embedder.gguf", inputs);
        set_llama_mode(&mut info, LlamaMode::Embed, "synthetic-embedder.gguf").unwrap();
        assert_eq!(info.tasks, ["embed"]);
        assert_eq!(info.chat_supported, Some(false));
        assert!(!info.tools_auto && !info.tool_parser);
        assert_eq!(
            info.embedding_model.as_deref(),
            Some("synthetic-embedder.gguf")
        );
        // b11617 embeds OpenAI content parts through the projector, so the
        // verified input modalities stay.
        assert_eq!(info.modalities, inputs);
        for (endpoint, body) in [
            (
                "chat/completions",
                json!({"messages":[{"role":"user","content":"hi"}]}),
            ),
            ("completions", json!({"prompt":"hi"})),
            (
                "chat/completions",
                json!({
                    "messages":[{"role":"user","content":"hi"}],
                    "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],
                    "tool_choice":"auto"
                }),
            ),
        ] {
            let error = adapt(&info, endpoint, body).unwrap_err();
            assert!(
                error.starts_with("unsupported_task: This session serves embeddings"),
                "{endpoint}: {error}"
            );
        }
        adapt(
            &info,
            "embeddings",
            json!({"model":"alias","input":["a","b"]}),
        )
        .unwrap();
    }

    #[test]
    fn llama_default_mode_serves_generation_without_claiming_embeddings() {
        let cfg = AppConfig {
            active_model: "synthetic-generator.gguf".into(),
            server_args: vec!["--jinja".into()],
            ..AppConfig::default()
        };
        let info = llama_info(&cfg, artifacts::Modalities::text_only()).unwrap();
        assert_eq!(info.tasks, ["generate"]);
        assert_eq!(info.embedding_model, None);
        assert_eq!(info.chat_supported, None);
        assert!(info.tools_auto && info.tool_parser);
        adapt(
            &info,
            "chat/completions",
            json!({
                "messages":[{"role":"user","content":"hi"}],
                "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]
            }),
        )
        .unwrap();
        adapt(&info, "completions", json!({"prompt":"hi"})).unwrap();
        let error = adapt(&info, "embeddings", json!({"input":"a"})).unwrap_err();
        assert!(error.starts_with("unsupported_task:"), "{error}");
    }

    #[test]
    fn unverified_llama_mode_routes_nothing_and_request_updates_keep_the_launch_mode() {
        let cfg = AppConfig {
            active_model: "synthetic.gguf".into(),
            server_args: args(&["--chat-template", "--embedding"]),
            ..AppConfig::default()
        };
        let provisional = llama_info(&cfg, artifacts::Modalities::text_only()).unwrap();
        assert!(provisional.tasks.is_empty());
        assert_eq!(provisional.embedding_model, None);
        for endpoint in ["chat/completions", "embeddings"] {
            let body = json!({"messages":[{"role":"user","content":"hi"}],"input":"a"});
            let error = adapt(&provisional, endpoint, body).unwrap_err();
            assert!(
                error.starts_with("unsupported_task:"),
                "{endpoint}: {error}"
            );
        }
        for mode in [LlamaMode::Generate, LlamaMode::Embed] {
            let mut launched =
                EngineInfo::llama("synthetic.gguf", artifacts::Modalities::text_only());
            set_llama_mode(&mut launched, mode, "synthetic.gguf").unwrap();
            let mut updated = provisional.clone();
            keep_launch_capabilities(&mut updated, &launched);
            assert_eq!(updated, launched, "{mode:?}");
        }
        let mut rerank = EngineInfo::llama("synthetic.gguf", artifacts::Modalities::text_only());
        let error = set_llama_mode(&mut rerank, LlamaMode::Rerank, "synthetic.gguf").unwrap_err();
        assert!(error.contains("--rerank"), "{error}");
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
