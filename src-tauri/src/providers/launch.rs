//! Server command lines and readiness checks for Python-based engines.
//!
//! The command line is built only from the selected runtime, the selected
//! model, application-owned bindings and validated schema options. Credentials
//! are passed through the environment variables each engine reads
//! (`VLLM_API_KEY`, `MLX_VLM_SERVER_API_KEY`), never on the command line where
//! other local processes could read them.
use super::artifacts::{self, ArtifactFormat};
use super::catalog_data as data;
use super::compat;
use super::options::{self, OptionIssue};
use super::python_env::{InstallationKind, PythonRuntimeManifest};
use super::ProviderId;
use crate::config::AppConfig;
use serde::Serialize;
use serde_json::{Map, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Options that bind files to the launch; they have dedicated controls and
/// validation instead of free-form schema entries.
pub const LORA_ADAPTERS_KEY: &str = "lora_adapters";
pub const REQUEST_LORA_KEY: &str = "request_lora";
pub const DRAFT_MODEL_KEY: &str = "draft_model";
pub const BINDING_KEYS: &[&str] = &[LORA_ADAPTERS_KEY, REQUEST_LORA_KEY, DRAFT_MODEL_KEY];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ProviderLora {
    pub name: String,
    pub path: String,
}

/// Saved options for one provider, without another provider's values.
pub fn provider_options(cfg: &AppConfig, provider: ProviderId) -> Map<String, Value> {
    cfg.provider_options
        .get(provider.as_str())
        .cloned()
        .unwrap_or_default()
}

fn schema_view(options: &Map<String, Value>) -> Map<String, Value> {
    options
        .iter()
        .filter(|(key, _)| !BINDING_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn valid_adapter_name(name: &str) -> bool {
    name.len() <= 64
        && name.starts_with(|value: char| value.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || "-_.".contains(value))
}

/// Paths are passed as separate argv words; argparse would read one that
/// starts with `-` as an option rather than as the value.
fn argument_path(label: &str, path: &str) -> Result<(), String> {
    if path.trim_start().starts_with('-') {
        return Err(format!("{label} path must not start with '-': {path}"));
    }
    Ok(())
}

const MAX_ADAPTER_CONFIG_BYTES: u64 = 1024 * 1024;
/// vLLM v0.31.0 `config/lora.py` `MaxLoRARanks`.
const VLLM_LORA_RANKS: &[i64] = &[1, 8, 16, 32, 64, 128, 256, 320, 512];
const VLLM_DEFAULT_MAX_LORA_RANK: i64 = 16;

fn nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

/// Adapters are directories holding the configuration and weights each engine
/// reads. A GGUF LoRA file is a llama.cpp format and is not accepted here.
///
/// vLLM v0.31.0 (`lora/peft_helper.py`, `lora/lora_model.py`): PEFT
/// `adapter_config.json` with a positive `r`, `lora_alpha` and
/// `target_modules`, no bias, no DoRA, `modules_to_save` limited to
/// classifier heads, `r` within `--max-lora-rank`, and weights in
/// `adapter_model.safetensors`. vLLM falls back to `adapter_model.bin`/`.pt`
/// through `torch.load(weights_only=True)`, a restricted unpickler whose
/// safety depends on the torch build of the runtime (external runtimes are not
/// pinned); AioLM loads model data only from safetensors, so those are refused.
/// mlx-vlm v0.7.6 (`trainer/utils.py` `apply_lora_layers`):
/// `adapter_config.json` with `rank` or `lora_parameters`, and
/// `adapters.safetensors`.
fn adapter_problem(provider: ProviderId, path: &Path, max_rank: Option<i64>) -> Option<String> {
    if !path.is_dir() {
        return Some(format!(
            "adapter directory does not exist: {}",
            path.display()
        ));
    }
    let config_path = path.join("adapter_config.json");
    let config = match std::fs::metadata(&config_path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_ADAPTER_CONFIG_BYTES => {
            match std::fs::read(&config_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            {
                Some(Value::Object(config)) => config,
                _ => {
                    return Some(format!(
                        "{} is not a valid JSON object",
                        config_path.display()
                    ))
                }
            }
        }
        Ok(metadata) if metadata.is_file() => {
            return Some(format!(
                "{} is too large to be an adapter configuration",
                config_path.display()
            ))
        }
        _ => {
            return Some(format!(
                "{} is not a PEFT/MLX adapter (adapter_config.json is missing)",
                path.display()
            ))
        }
    };
    let name = path.display();
    match provider {
        ProviderId::Vllm => {
            let rank = match config.get("r").and_then(Value::as_i64) {
                Some(rank) if rank > 0 => rank,
                _ => {
                    return Some(format!(
                        "{name}: adapter_config.json needs a positive integer `r` (PEFT LoRA rank)"
                    ))
                }
            };
            if !config.get("lora_alpha").is_some_and(Value::is_number) {
                return Some(format!(
                    "{name}: adapter_config.json needs a numeric `lora_alpha`"
                ));
            }
            if !config
                .get("target_modules")
                .is_some_and(|value| value.is_string() || value.is_array())
            {
                return Some(format!(
                    "{name}: adapter_config.json needs `target_modules`"
                ));
            }
            if config.get("bias").is_some_and(|bias| bias != "none") {
                return Some(format!("{name}: vLLM does not support adapter bias"));
            }
            if config.get("use_dora") == Some(&Value::Bool(true)) {
                return Some(format!("{name}: vLLM does not support DoRA adapters"));
            }
            match config.get("modules_to_save") {
                None | Some(Value::Null) => {}
                Some(Value::Array(modules))
                    if modules
                        .iter()
                        .all(|module| matches!(module.as_str(), Some("classifier" | "score"))) => {}
                Some(_) => {
                    return Some(format!(
                        "{name}: vLLM only accepts modules_to_save of classifier or score heads"
                    ))
                }
            }
            let limit = max_rank.unwrap_or(VLLM_DEFAULT_MAX_LORA_RANK);
            if rank > limit {
                return Some(format!(
                    "{name}: LoRA rank {rank} exceeds max_lora_rank {limit}"
                ));
            }
            if !nonempty_file(&path.join("adapter_model.safetensors")) {
                if let Some(pickle) = ["adapter_model.bin", "adapter_model.pt"]
                    .into_iter()
                    .find(|file| path.join(file).is_file())
                {
                    return Some(format!(
                        "{name}: {pickle} is a pickle checkpoint; AioLM loads adapters only from adapter_model.safetensors. \
                         Re-save the adapter with safetensors (PEFT save_pretrained(..., safe_serialization=True))"
                    ));
                }
                return Some(format!("{name}: adapter_model.safetensors is missing"));
            }
        }
        ProviderId::MlxVlm => {
            if !config.contains_key("rank") && !config.contains_key("lora_parameters") {
                return Some(format!(
                    "{name}: adapter_config.json has no `rank` or `lora_parameters`"
                ));
            }
            if !nonempty_file(&path.join("adapters.safetensors")) {
                return Some(format!("{name}: adapters.safetensors is missing"));
            }
        }
        ProviderId::Llama => {
            return Some("llama.cpp adapters are configured in its own settings".into())
        }
    }
    None
}

/// mlx-vlm `--draft-model`: a complete local snapshot. Drafters often have no
/// tokenizer of their own, so only configuration and weights are required. A
/// `draft_kind` that contradicts the drafter's `model_type` is refused the way
/// mlx-vlm v0.7.6 `speculative/drafters` would refuse it after loading.
fn draft_problem(path: &Path, kind: Option<&str>) -> Option<String> {
    if !path.is_dir() {
        return Some(format!(
            "draft model directory does not exist: {}",
            path.display()
        ));
    }
    let artifact = artifacts::inspect_snapshot(path);
    if artifact.format == ArtifactFormat::Gguf || artifact.format == ArtifactFormat::Unknown {
        return Some(format!(
            "{} is not a safetensors model snapshot",
            path.display()
        ));
    }
    if artifact.incomplete {
        return Some(format!(
            "the draft model download did not complete: {}",
            path.display()
        ));
    }
    if let Some(file) = artifact
        .missing
        .iter()
        .find(|file| file.as_str() != "tokenizer.json")
    {
        return Some(format!("the draft model is missing {file}"));
    }
    let model_type = artifact.model_type.as_deref().map(str::to_ascii_lowercase);
    let expected = model_type.as_deref().and_then(|model_type| {
        data::MLX_VLM_DRAFTER_KIND_BY_MODEL_TYPE
            .iter()
            .find(|(known, _)| *known == model_type)
            .map(|(_, kind)| *kind)
            .or_else(|| model_type.contains("mtp").then_some("mtp"))
    });
    match (kind, expected) {
        (Some(kind), Some(expected)) if kind != expected => Some(format!(
            "the draft model is a '{expected}' drafter but draft_kind is '{kind}'"
        )),
        _ => None,
    }
}

/// Whether the selected model is served for embeddings only, decided by the
/// same compatibility verdict the UI and gateway use.
fn embedding_only(model: &Path, runtime: &PythonRuntimeManifest) -> bool {
    let Ok(artifact) = super::execution::inspect(model) else {
        return false;
    };
    let verdict = compat::assess(&artifact, runtime.provider, runtime.probe.as_ref());
    verdict.tasks.contains(&"embed") && !verdict.tasks.contains(&"generate")
}

pub fn lora_adapters(options: &Map<String, Value>) -> Result<Vec<ProviderLora>, String> {
    let Some(value) = options.get(LORA_ADAPTERS_KEY) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or("LoRA adapters must be a list of {name, path}")?;
    if items.len() > 32 {
        return Err("too many LoRA adapters (max 32)".into());
    }
    let mut adapters = Vec::new();
    for item in items {
        let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
        let path = item.get("path").and_then(Value::as_str).unwrap_or_default();
        if !valid_adapter_name(name) {
            return Err(format!("invalid LoRA adapter name: '{name}'"));
        }
        if path.trim().is_empty() || path.contains('\0') || path.len() > 32_768 {
            return Err(format!("LoRA adapter '{name}' has an invalid path"));
        }
        if adapters
            .iter()
            .any(|adapter: &ProviderLora| adapter.name == name)
        {
            return Err(format!("duplicate LoRA adapter name: {name}"));
        }
        adapters.push(ProviderLora {
            name: name.to_owned(),
            path: path.to_owned(),
        });
    }
    Ok(adapters)
}

/// Schema issues plus binding issues, for display and to refuse a launch.
pub fn option_issues(provider: ProviderId, options: &Map<String, Value>) -> Vec<OptionIssue> {
    let mut issues = options::validate(provider, &schema_view(options));
    let mut binding = |key: &str, message: String| {
        issues.push(OptionIssue {
            key: key.to_owned(),
            code: "binding",
            message,
        })
    };
    match lora_adapters(options) {
        Ok(adapters) => {
            if provider == ProviderId::MlxVlm && adapters.len() > 1 {
                binding(
                    LORA_ADAPTERS_KEY,
                    "mlx-vlm loads one adapter per server (--adapter-path)".into(),
                );
            }
            if let Some(selected) = options.get(REQUEST_LORA_KEY) {
                match selected.as_str() {
                    Some(name) if adapters.iter().any(|adapter| adapter.name == name) => {}
                    _ => binding(
                        REQUEST_LORA_KEY,
                        "the request adapter must name a configured adapter".into(),
                    ),
                }
                if provider != ProviderId::Vllm {
                    binding(
                        REQUEST_LORA_KEY,
                        "only vLLM selects adapters per request".into(),
                    );
                }
            }
        }
        Err(error) => binding(LORA_ADAPTERS_KEY, error),
    }
    if let Some(value) = options.get(DRAFT_MODEL_KEY) {
        if provider != ProviderId::MlxVlm {
            binding(
                DRAFT_MODEL_KEY,
                "vLLM configures draft models through speculative_config".into(),
            );
        } else if value
            .as_str()
            .is_none_or(|path| path.trim().is_empty() || path.contains('\0'))
        {
            binding(
                DRAFT_MODEL_KEY,
                "the draft model must be a local model directory".into(),
            );
        }
    }
    if provider == ProviderId::Vllm {
        if let Some(rank) = options.get("max_lora_rank").and_then(Value::as_i64) {
            if !VLLM_LORA_RANKS.contains(&rank) {
                issues.push(OptionIssue {
                    key: "max_lora_rank".into(),
                    code: "choice",
                    message: format!("max_lora_rank must be one of {VLLM_LORA_RANKS:?}"),
                });
            }
        }
        // vLLM v0.31.0 `cli_args.validate_parsed_serve_args` exits when auto
        // tool choice has no parser.
        if options.get("enable_auto_tool_choice") == Some(&Value::Bool(true))
            && !options.contains_key("tool_call_parser")
        {
            issues.push(OptionIssue {
                key: "enable_auto_tool_choice".into(),
                code: "binding",
                message: "enable_auto_tool_choice requires tool_call_parser".into(),
            });
        }
    }
    issues
}

/// Server flags a saved option makes the command line carry, including the
/// dedicated bindings, so a probed runtime can say which it lacks.
fn option_flags(provider: ProviderId, key: &str, value: &Value) -> Vec<String> {
    match (provider, key) {
        (ProviderId::Vllm, LORA_ADAPTERS_KEY)
            if value.as_array().is_some_and(|items| !items.is_empty()) =>
        {
            vec!["--enable-lora".into(), "--lora-modules".into()]
        }
        (ProviderId::MlxVlm, LORA_ADAPTERS_KEY)
            if value.as_array().is_some_and(|items| !items.is_empty()) =>
        {
            vec!["--adapter-path".into()]
        }
        (ProviderId::MlxVlm, DRAFT_MODEL_KEY) => vec!["--draft-model".into()],
        _ => {
            let Some(spec) = options::schema(provider)
                .iter()
                .find(|spec| spec.key == key)
            else {
                return Vec::new();
            };
            match (spec.flag, spec.kind) {
                (Some(flag), options::OptionKind::Toggle) if value == &Value::Bool(false) => {
                    vec![format!("--no-{}", &flag[2..])]
                }
                (Some(_), options::OptionKind::Flag) if value != &Value::Bool(true) => Vec::new(),
                (Some(flag), _) => vec![flag.to_owned()],
                (None, _) => Vec::new(),
            }
        }
    }
}

/// Flags the probed server reports, when the probe recorded them.
fn probed_flags(runtime: &PythonRuntimeManifest) -> Option<&[String]> {
    runtime
        .probe
        .as_ref()
        .map(|probe| probe.server_flags.as_slice())
        .filter(|flags| !flags.is_empty())
}

const METAL_UNSUPPORTED_KEYS: &[&str] = &[
    "cpu_offload_gb",
    "tensor_parallel_size",
    "pipeline_parallel_size",
    "min_tokens",
    "logit_bias",
];
const METAL_KV_DTYPES: &[&str] = &["auto", "float16", "bfloat16"];
const METAL_QUANTIZATIONS: &[&str] = &[
    "awq",
    "auto_awq",
    "gguf",
    "fp8",
    "mxfp4",
    "compressed-tensors",
];
// Raw flags are deliberately limited to observability and synchronous
// scheduling. Loader/backend/config overrides could bypass model evidence or
// change app-owned companions; they need a typed, validated setting first.
const METAL_RAW_FLAGS: &[&str] = &[
    "--disable-log-stats",
    "--enable-log-requests",
    "--disable-log-requests",
    "--no-async-scheduling",
];

/// The runtime-scoped schema keeps saved rejected values available to the UI
/// separately, while showing only flags this runtime can actually honor.
pub fn option_schema(runtime: &PythonRuntimeManifest) -> Vec<options::OptionSpec> {
    let metal = runtime.provider == ProviderId::Vllm && compat::is_metal(runtime.probe.as_ref());
    options::schema(runtime.provider)
        .iter()
        .filter_map(|spec| {
            if metal && METAL_UNSUPPORTED_KEYS.contains(&spec.key) {
                return None;
            }
            if let (Some(flag), Some(flags)) = (spec.flag, probed_flags(runtime)) {
                if !flags
                    .iter()
                    .any(|known| known == flag || known == &format!("--no-{}", &flag[2..]))
                {
                    return None;
                }
            }
            let mut spec = *spec;
            if metal && spec.key == "kv_cache_dtype" {
                spec.kind = options::OptionKind::Choice {
                    choices: METAL_KV_DTYPES,
                };
            }
            if metal && spec.key == "quantization" {
                spec.kind = options::OptionKind::Choice {
                    choices: METAL_QUANTIZATIONS,
                };
            }
            Some(spec)
        })
        .collect()
}

fn metal_option_issues(options: &Map<String, Value>) -> Vec<OptionIssue> {
    let mut issues = Vec::new();
    let mut reject = |key: &str, message: &str| {
        issues.push(OptionIssue {
            key: key.into(),
            code: "variant",
            message: message.into(),
        })
    };
    for key in METAL_UNSUPPORTED_KEYS {
        if options.contains_key(*key) {
            reject(key, "this setting is unavailable in the app's single-device Metal launch; clear the saved value");
        }
    }
    if options
        .get("kv_cache_dtype")
        .and_then(Value::as_str)
        .is_some_and(|dtype| !METAL_KV_DTYPES.contains(&dtype))
    {
        reject("kv_cache_dtype", "Metal KV cache uses model dtype; quantized KV dtypes are unsupported (TurboQuant uses a separate plugin configuration)");
    }
    if let Some(kv) = options
        .get("kv_cache_dtype")
        .and_then(Value::as_str)
        .filter(|v| *v != "auto")
    {
        let dtype = options
            .get("dtype")
            .and_then(Value::as_str)
            .unwrap_or("auto");
        let normalized = match dtype {
            "half" => "float16",
            other => other,
        };
        if normalized != kv {
            reject("kv_cache_dtype", "an explicit Metal KV dtype requires the same explicit model dtype; use auto otherwise");
        }
    }
    if options
        .get("quantization")
        .and_then(Value::as_str)
        .is_some_and(|q| !METAL_QUANTIZATIONS.contains(&q))
    {
        reject(
            "quantization",
            "the selected quantization method is not supported by the Metal MLX loader",
        );
    }
    if let Some(limits) = options
        .get("limit_mm_per_prompt")
        .and_then(Value::as_object)
    {
        if limits
            .iter()
            .any(|(name, value)| name != "image" && value.as_u64() != Some(0))
        {
            reject(
                "limit_mm_per_prompt",
                "Metal chat accepts only image media; audio/video limits must be zero",
            );
        }
    }
    if let Some(extra) = options
        .get(options::EXTRA_ARGS_KEY)
        .and_then(Value::as_array)
    {
        for arg in extra.iter().filter_map(Value::as_str) {
            let flag = options::canonical_flag(ProviderId::Vllm, arg);
            if !METAL_RAW_FLAGS.contains(&flag.as_str()) || arg.contains('=') {
                reject(options::EXTRA_ARGS_KEY, "Metal extra_args accepts only standalone logging flags and --no-async-scheduling; loader, config, companion and backend overrides require validated app controls");
            }
        }
    }
    if let Some(spec) = options.get("speculative_config").and_then(Value::as_object) {
        const SPEC_KEYS: &[&str] = &[
            "method",
            "model",
            "num_speculative_tokens",
            "num_speculative_tokens_per_decode_step",
            "prompt_lookup_min",
            "prompt_lookup_max",
            "use_heterogeneous_vocab",
        ];
        if spec.keys().any(|key| !SPEC_KEYS.contains(&key.as_str())) {
            reject("speculative_config", "Metal speculative_config contains an unvalidated setting; use only documented method, model, token count and ngram lookup controls");
        }
        if options.get("enable_lora") == Some(&Value::Bool(true))
            || options
                .get(LORA_ADAPTERS_KEY)
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
        {
            reject(
                "speculative_config",
                "Metal does not combine LoRA with speculative decoding",
            );
        }
        if !matches!(
            spec.get("method").and_then(Value::as_str),
            Some("mtp" | "draft_model" | "ngram")
        ) {
            reject(
                "speculative_config",
                "Metal supports only mtp, draft_model and ngram speculative methods",
            );
        }
        if spec
            .get("num_speculative_tokens")
            .and_then(Value::as_u64)
            .is_none_or(|n| n == 0 || n > 64)
        {
            reject(
                "speculative_config",
                "speculative decoding requires num_speculative_tokens between 1 and 64",
            );
        }
        if spec.get("use_heterogeneous_vocab") == Some(&Value::Bool(true)) {
            reject(
                "speculative_config",
                "Metal speculative decoding requires identical target and draft vocabularies",
            );
        }
        if spec
            .get("use_heterogeneous_vocab")
            .is_some_and(|v| !v.is_boolean())
        {
            reject(
                "speculative_config",
                "use_heterogeneous_vocab must be a boolean",
            );
        }
        for key in ["prompt_lookup_min", "prompt_lookup_max"] {
            if spec
                .get(key)
                .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0 || n > 1024))
            {
                reject(
                    "speculative_config",
                    "ngram lookup bounds must be integers between 1 and 1024",
                );
            }
        }
        if let Some(steps) = spec.get("num_speculative_tokens_per_decode_step") {
            let max = spec
                .get("num_speculative_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if steps.as_array().is_none_or(|items| {
                items.is_empty()
                    || items.len() > 1024
                    || items.iter().any(|v| v.as_u64().is_none_or(|n| n > max))
            }) {
                reject("speculative_config", "dynamic speculative token counts must be a nonempty list bounded by num_speculative_tokens");
            }
        }
        if spec.contains_key("long_prefill_token_threshold") {
            reject("speculative_config", "long_prefill_token_threshold is a scheduler setting, not a Metal speculative setting");
        }
    }
    issues
}

fn local_model_config(path: &Path) -> Result<Value, String> {
    let file = path.join("config.json");
    let metadata = std::fs::metadata(&file)
        .map_err(|_| format!("missing local configuration: {}", file.display()))?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err("model configuration is not a bounded local JSON file".into());
    }
    serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
        .map_err(|e| format!("model configuration is invalid: {e}"))
}

fn validate_metal_model_options(
    model: &Path,
    runtime: &PythonRuntimeManifest,
    options: &Map<String, Value>,
) -> Result<(), String> {
    let artifact = super::execution::inspect(model)?;
    let verdict = compat::assess(&artifact, ProviderId::Vllm, runtime.probe.as_ref());
    if !verdict.loadable() || !verdict.readiness.is_empty() {
        return Err(verdict
            .reasons
            .iter()
            .map(|r| r.detail.clone())
            .chain(verdict.readiness)
            .collect::<Vec<_>>()
            .join("; "));
    }
    let pooling = options.get("runner").and_then(Value::as_str) == Some("pooling")
        || verdict.tasks == ["embed"];
    let lora = options.get("enable_lora") == Some(&Value::Bool(true))
        || !lora_adapters(options)?.is_empty();
    if verdict.tasks.contains(&"transcription") {
        if options
            .get("runner")
            .and_then(Value::as_str)
            .is_some_and(|runner| runner != "auto")
        {
            return Err("Metal transcription selects its speech runner automatically; leave runner unset or auto".into());
        }
        if lora
            || options.contains_key("speculative_config")
            || options.contains_key("quantization")
        {
            return Err("Metal transcription has no verified LoRA, speculative decoding or quantization override binding".into());
        }
    }
    if pooling && !verdict.tasks.contains(&"embed") {
        return Err("this Metal model has no app-supported embedding pooling path".into());
    }
    if pooling && options.contains_key("speculative_config") {
        return Err("Metal pooling does not use speculative decoding".into());
    }
    if lora && (pooling || verdict.modalities.image || artifact.format == ArtifactFormat::Gguf) {
        return Err("AioLM offers Metal LoRA only for text safetensors generation; pooling, native image and GGUF adapter combinations have no validated app binding".into());
    }
    if options.get("quantization").and_then(Value::as_str) == Some("gguf")
        && artifact.format != ArtifactFormat::Gguf
    {
        return Err("quantization=gguf requires local GGUF weights".into());
    }
    if let Some(selected) = options
        .get("quantization")
        .and_then(Value::as_str)
        .filter(|q| *q != "gguf")
    {
        let declared = artifact.quantization.as_deref().unwrap_or("");
        if artifact.format == ArtifactFormat::Mlx
            || (selected != declared && !(selected == "auto_awq" && declared == "awq"))
        {
            return Err("Metal quantization must match the checkpoint's declared loader method; leave it unset for native MLX weights".into());
        }
    }
    if artifact.format == ArtifactFormat::Gguf
        && options
            .get("quantization")
            .and_then(Value::as_str)
            .is_some_and(|q| q != "gguf")
    {
        return Err("GGUF weights require automatic or gguf quantization".into());
    }
    if let Some(spec) = options.get("speculative_config").and_then(Value::as_object) {
        let target_config_dir = if model.is_file() {
            model.parent().unwrap_or(model)
        } else {
            model
        };
        let target_config = local_model_config(target_config_dir)?;
        let model_type = target_config
            .get("model_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        if verdict.modalities.image
            || [
                "qwen3_5",
                "qwen3_5_moe",
                "qwen3_next",
                "lfm2",
                "nemotron_h",
                "granitemoehybrid",
            ]
            .contains(&model_type)
        {
            return Err(
                "Metal speculative decoding requires a text-only non-hybrid paged-attention target"
                    .into(),
            );
        }
        let method = spec.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "ngram" {
            if spec.contains_key("model") {
                return Err("ngram speculation does not load a draft model".into());
            }
            let min = spec
                .get("prompt_lookup_min")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            let max = spec
                .get("prompt_lookup_max")
                .and_then(Value::as_u64)
                .unwrap_or(5);
            if min == 0 || min > max {
                return Err(
                    "ngram prompt lookup requires 1 <= prompt_lookup_min <= prompt_lookup_max"
                        .into(),
                );
            }
        } else {
            let draft = spec
                .get("model")
                .and_then(Value::as_str)
                .ok_or("Metal speculative decoding requires a complete local draft model")?;
            argument_path("draft model", draft)?;
            let draft_path = Path::new(draft);
            if let Some(problem) = draft_problem(draft_path, None) {
                return Err(problem);
            }
            let draft_config = local_model_config(draft_path)?;
            if method == "mtp" {
                if !["gemma4", "gemma4_text"].contains(&model_type)
                    || draft_config.get("model_type").and_then(Value::as_str)
                        != Some("gemma4_assistant")
                {
                    return Err("Metal mtp requires a Gemma4 target and matching Gemma4 assistant checkpoint".into());
                }
            } else {
                let draft_artifact = artifacts::inspect_snapshot(draft_path);
                let draft_verdict =
                    compat::assess(&draft_artifact, ProviderId::Vllm, runtime.probe.as_ref());
                if !draft_verdict.loadable()
                    || !draft_verdict.tasks.contains(&"generate")
                    || draft_artifact.modalities.image
                    || draft_artifact.modalities.audio
                    || draft_artifact.modalities.video
                    || draft_config
                        .get("sliding_window")
                        .is_some_and(|v| !v.is_null() && v.as_u64() != Some(0))
                    || draft_config
                        .get("layer_types")
                        .and_then(Value::as_array)
                        .is_some_and(|types| {
                            types.iter().any(|t| t.as_str() != Some("full_attention"))
                        })
                    || [
                        "qwen3_5",
                        "qwen3_5_moe",
                        "qwen3_next",
                        "lfm2",
                        "nemotron_h",
                        "granitemoehybrid",
                    ]
                    .contains(&draft_artifact.model_type.as_deref().unwrap_or(""))
                {
                    return Err("Metal draft_model must be a supported full-attention, non-hybrid text model".into());
                }
            }
            let target_vocab = target_config
                .get("text_config")
                .unwrap_or(&target_config)
                .get("vocab_size")
                .and_then(Value::as_u64);
            let draft_vocab = draft_config
                .get("text_config")
                .unwrap_or(&draft_config)
                .get("vocab_size")
                .and_then(Value::as_u64);
            if target_vocab.is_none() || target_vocab != draft_vocab {
                return Err("Metal draft and target must declare the same vocab_size; heterogeneous vocabularies are unsupported".into());
            }
        }
    }
    if matches!(
        artifact.model_type.as_deref(),
        Some("nemotron_h" | "granitemoehybrid")
    ) && options.get("enable_prefix_caching") == Some(&Value::Bool(true))
    {
        return Err("Metal disables prefix caching for this hybrid model; clear enable_prefix_caching or set it to false".into());
    }
    Ok(())
}

pub fn runtime_option_issues(
    runtime: &PythonRuntimeManifest,
    options: &Map<String, Value>,
) -> Vec<OptionIssue> {
    let mut issues = option_issues(runtime.provider, options);
    if runtime.provider == ProviderId::Vllm && compat::is_metal(runtime.probe.as_ref()) {
        issues.extend(metal_option_issues(options));
    }
    let (Some(flags), Some(probe)) = (probed_flags(runtime), runtime.probe.as_ref()) else {
        return issues;
    };
    let server = runtime.provider.server();
    for (key, value) in options {
        for flag in option_flags(runtime.provider, key, value) {
            if !flags.contains(&flag) {
                issues.push(OptionIssue {
                    key: key.clone(),
                    code: "version",
                    message: format!(
                        "{server} {} does not support {flag}; clear the saved option",
                        probe.version
                    ),
                });
            }
        }
    }
    if let Some(extra) = options
        .get(options::EXTRA_ARGS_KEY)
        .and_then(Value::as_array)
    {
        for argument in extra
            .iter()
            .filter_map(Value::as_str)
            .filter(|value| value.starts_with("--"))
        {
            let flag = options::canonical_flag(runtime.provider, argument);
            if !flags.contains(&flag) {
                issues.push(OptionIssue {
                    key: options::EXTRA_ARGS_KEY.into(),
                    code: "version",
                    message: format!("{server} {} does not support {flag}", probe.version),
                });
            }
        }
    }
    issues
}

/// Name the engine serves the model under. vLLM rejects names containing `/`
/// for some clients, so the name is derived from the directory name.
pub fn served_model_name(model: &str) -> String {
    let base = Path::new(model.trim_end_matches(['/', '\\']))
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model".into());
    let mut name = base
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || "-_.".contains(value) {
                value
            } else {
                '-'
            }
        })
        .collect::<String>();
    name.truncate(96);
    // A leading `-` would make the value parse as an option.
    let name = name.trim_start_matches(['-', '.']);
    if name.trim_matches('-').is_empty() {
        "model".into()
    } else {
        name.to_owned()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EngineCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Environment entries added to the engine's cleared base environment.
    pub env: Vec<(OsString, OsString)>,
    /// The id requests must carry in `model`.
    pub upstream_model: String,
    pub readiness: Readiness,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Readiness {
    /// Path relative to the server root polled until it answers 200.
    pub health_path: &'static str,
    /// Whether the health endpoint requires the bearer key.
    pub health_authenticated: bool,
    /// The model id that must appear in `/v1/models`.
    pub expected_model: String,
}

fn interpreter_flags(kind: InstallationKind) -> Vec<String> {
    match kind {
        InstallationKind::Managed => vec!["-I".into()],
        InstallationKind::External => Vec::new(),
    }
}

/// Build the command for a validated configuration. Refuses any option issue
/// rather than dropping the offending value.
pub fn engine_command(
    cfg: &AppConfig,
    runtime: &PythonRuntimeManifest,
    port: u16,
    api_key: &str,
) -> Result<EngineCommand, String> {
    let provider = runtime.provider;
    let options = provider_options(cfg, provider);
    let issues = runtime_option_issues(runtime, &options);
    if !issues.is_empty() {
        return Err(format!(
            "{} settings need attention before starting: {}",
            provider.server(),
            issues
                .iter()
                .map(|issue| issue.message.clone())
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    let model = cfg.active_model.trim();
    if model.is_empty() {
        return Err("select a model before starting the server".into());
    }
    argument_path("model", model)?;
    let metal = provider == ProviderId::Vllm && compat::is_metal(runtime.probe.as_ref());
    if metal {
        validate_metal_model_options(Path::new(model), runtime, &options)?;
    }
    let primary_embedding = embedding_only(Path::new(model), runtime);
    let adapters = lora_adapters(&options)?;
    let max_rank = options.get("max_lora_rank").and_then(Value::as_i64);
    for adapter in &adapters {
        argument_path("adapter", &adapter.path)?;
        if let Some(problem) = adapter_problem(provider, Path::new(&adapter.path), max_rank) {
            return Err(problem);
        }
    }
    if let Some(embedding) = options.get("embedding_model").and_then(Value::as_str) {
        let path = Path::new(embedding);
        let artifact = artifacts::inspect_snapshot(path);
        let verdict = compat::assess(&artifact, provider, runtime.probe.as_ref());
        if !path.is_dir()
            || !artifact.ready_files()
            || !verdict.loadable()
            || verdict.tasks != ["embed"]
        {
            return Err(format!(
                "embedding_model must be a complete local snapshot of an embedding model {} can serve",
                provider.server()
            ));
        }
    }
    let mut args = interpreter_flags(runtime.kind);
    let mut env = Vec::new();
    let (upstream_model, readiness) = match provider {
        ProviderId::Vllm => {
            let served = served_model_name(model);
            args.extend([
                "-m".into(),
                "vllm.entrypoints.cli.main".into(),
                "serve".into(),
                model.to_owned(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                port.to_string(),
                "--served-model-name".into(),
                served.clone(),
            ]);
            if !adapters.is_empty() {
                if options.get("enable_lora").and_then(Value::as_bool) != Some(true) {
                    args.push("--enable-lora".into());
                }
                args.push("--lora-modules".into());
                args.extend(
                    adapters
                        .iter()
                        .map(|adapter| format!("{}={}", adapter.name, adapter.path)),
                );
            }
            let mut launch_options = schema_view(&options);
            if metal {
                env.extend([
                    // vLLM applies this allowlist to platform plugins too;
                    // omitting `metal` would select the CPU core at launch.
                    ("VLLM_PLUGINS".into(), "metal,gguf_metal".into()),
                    ("VLLM_MLX_DEVICE".into(), "gpu".into()),
                    ("VLLM_METAL_MULTIMODAL_MODE".into(), "auto".into()),
                    ("VLLM_USE_V2_MODEL_RUNNER".into(), "0".into()),
                    ("HF_HUB_OFFLINE".into(), "1".into()),
                    ("TRANSFORMERS_OFFLINE".into(), "1".into()),
                ]);
                if Path::new(model).is_file() {
                    let companion = Path::new(model)
                        .parent()
                        .ok_or("GGUF requires a local companion directory")?
                        .to_string_lossy()
                        .into_owned();
                    args.extend([
                        "--tokenizer".into(),
                        companion.clone(),
                        "--hf-config-path".into(),
                        companion,
                    ]);
                }
                if launch_options.contains_key("speculative_config") {
                    args.push("--no-async-scheduling".into());
                }
            }
            // vLLM picks the runner from the architecture when it is `auto`;
            // an embedding-only model is named explicitly so the launched
            // runner always matches the task the session advertises.
            let runner = launch_options
                .get("runner")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if primary_embedding && runner.as_deref() != Some("pooling") {
                if runner.as_deref() == Some("generate") {
                    return Err(
                        "this model is served for embeddings only and requires the pooling runner"
                            .into(),
                    );
                }
                launch_options.remove("runner");
                args.extend(["--runner".into(), "pooling".into()]);
            }
            args.extend(options::launch_args(provider, &launch_options));
            if !api_key.is_empty() {
                env.push(("VLLM_API_KEY".into(), api_key.into()));
            }
            (
                served.clone(),
                Readiness {
                    health_path: "/health",
                    health_authenticated: false,
                    expected_model: served,
                },
            )
        }
        ProviderId::MlxVlm => {
            args.extend([
                "-m".into(),
                "mlx_vlm.server".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                port.to_string(),
                if primary_embedding {
                    "--embedding-model".into()
                } else {
                    "--model".into()
                },
                model.to_owned(),
            ]);
            // mlx-vlm v0.7.6 `server/cli.py` applies `--adapter-path` only
            // to the `--model` it preloads.
            if let Some(adapter) = adapters.first() {
                if primary_embedding {
                    return Err("mlx-vlm embedding sessions do not accept LoRA adapters".into());
                }
                args.push("--adapter-path".into());
                args.push(adapter.path.clone());
            }
            if let Some(draft) = options.get(DRAFT_MODEL_KEY).and_then(Value::as_str) {
                if primary_embedding {
                    return Err("mlx-vlm embedding sessions do not use a draft model".into());
                }
                argument_path("draft model", draft)?;
                if let Some(problem) = draft_problem(
                    Path::new(draft),
                    options.get("draft_kind").and_then(Value::as_str),
                ) {
                    return Err(problem);
                }
                args.push("--draft-model".into());
                args.push(draft.to_owned());
            }
            if primary_embedding && options.contains_key("embedding_model") {
                return Err(
                    "select the embedding model as the primary model or companion, not both".into(),
                );
            }
            args.extend(options::launch_args(provider, &schema_view(&options)));
            if !api_key.is_empty() {
                env.push(("MLX_VLM_SERVER_API_KEY".into(), api_key.into()));
            }
            // mlx-vlm loads whatever `model` a request names, so requests must
            // carry this exact preloaded path.
            (
                model.to_owned(),
                Readiness {
                    health_path: "/health",
                    health_authenticated: true,
                    expected_model: model.to_owned(),
                },
            )
        }
        ProviderId::Llama => return Err("llama.cpp is launched through server::spawn".into()),
    };
    // Every flag the command carries, dedicated bindings included, must be one
    // the installed server reported; an older or newer engine would otherwise
    // exit at startup with an argument error.
    if let (Some(flags), Some(probe)) = (probed_flags(runtime), runtime.probe.as_ref()) {
        let mut missing = args
            .iter()
            .filter(|arg| arg.starts_with("--"))
            .map(|arg| options::canonical_flag(provider, arg))
            .filter(|flag| !flags.iter().any(|supported| supported == flag))
            .collect::<Vec<_>>();
        missing.dedup();
        if !missing.is_empty() {
            return Err(format!(
                "{} {} does not support {}; update the runtime or change the settings that need them",
                provider.server(),
                probe.version,
                missing.join(", ")
            ));
        }
    }
    Ok(EngineCommand {
        program: PathBuf::from(&runtime.python),
        args,
        env,
        upstream_model,
        readiness,
    })
}

/// The command a user would type, with the credential left out. Used for the
/// command preview and benchmark provenance.
pub fn preview(command: &EngineCommand) -> Vec<String> {
    std::iter::once(command.program.to_string_lossy().into_owned())
        .chain(command.args.iter().cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::python_env::ProbeRecord;
    use serde_json::json;

    fn metal_runtime() -> PythonRuntimeManifest {
        let mut runtime = runtime(ProviderId::Vllm);
        let probe = runtime.probe.as_mut().unwrap();
        probe.variant = "vllm-metal".into();
        probe.metal_version = "0.30.0".into();
        probe.version = "0.30.0+cpu".into();
        probe.metal_gguf = true;
        runtime
    }

    fn metal_snapshot(dir: &Path, model_type: &str, architecture: &str, extra: Value) {
        let mut config =
            json!({"model_type":model_type,"architectures":[architecture],"vocab_size":32});
        for (key, value) in extra.as_object().unwrap() {
            config[key] = value.clone();
        }
        write(dir, "config.json", config.to_string().as_bytes());
        write(dir, "model.safetensors", b"synthetic");
        write(dir, "tokenizer.json", b"{}");
        write(
            dir,
            "tokenizer_config.json",
            br#"{"chat_template":"synthetic"}"#,
        );
    }

    #[test]
    fn metal_schema_filters_semantically_unsupported_flags_and_preserves_linux() {
        let mut runtime = metal_runtime();
        let schema = option_schema(&runtime);
        assert!(!schema
            .iter()
            .any(|s| METAL_UNSUPPORTED_KEYS.contains(&s.key)));
        let kv = schema.iter().find(|s| s.key == "kv_cache_dtype").unwrap();
        assert_eq!(
            kv.kind,
            options::OptionKind::Choice {
                choices: METAL_KV_DTYPES
            }
        );
        let saved = json!({"cpu_offload_gb":1,"tensor_parallel_size":2,"kv_cache_dtype":"fp8"});
        let issues = runtime_option_issues(&runtime, saved.as_object().unwrap());
        for key in ["cpu_offload_gb", "tensor_parallel_size", "kv_cache_dtype"] {
            assert!(issues
                .iter()
                .any(|issue| issue.key == key && issue.code == "variant"));
        }
        runtime.probe.as_mut().unwrap().server_flags = vec!["--max-model-len".into()];
        let schema = option_schema(&runtime);
        assert!(schema.iter().any(|s| s.key == "max_model_len"));
        assert!(!schema.iter().any(|s| s.key == "dtype"));
        let linux = self::runtime(ProviderId::Vllm);
        assert!(option_schema(&linux)
            .iter()
            .any(|s| s.key == "cpu_offload_gb"));
    }

    #[test]
    fn metal_raw_options_cannot_select_a_loader_backend_or_companion() {
        let runtime = metal_runtime();
        for args in [
            json!(["--device", "cuda"]),
            json!(["--model-impl", "transformers"]),
            json!(["--tokenizer", "remote/model"]),
            json!(["--hf-config-path=x"]),
            json!(["--additional-config", "{}"]),
            json!(["--distributed-executor-backend=ray"]),
            json!(["--pooler-config", "{\"task\":\"classify\"}"]),
            json!(["--disable-log-stats=true"]),
            json!(["--worker-cls", "x"]),
        ] {
            let options = json!({"extra_args":args});
            assert!(
                runtime_option_issues(&runtime, options.as_object().unwrap())
                    .iter()
                    .any(|issue| issue.code == "variant")
            );
        }
        let options = json!({"extra_args":["--disable_log_stats","--no-async-scheduling"]});
        assert!(runtime_option_issues(&runtime, options.as_object().unwrap()).is_empty());
        for saved in [
            json!({"kv_cache_dtype":"bfloat16","dtype":"half"}),
            json!({"limit_mm_per_prompt":{"audio":1}}),
            json!({"speculative_config":{"method":"eagle","num_speculative_tokens":3}}),
        ] {
            assert!(!runtime_option_issues(&runtime, saved.as_object().unwrap()).is_empty());
        }
    }

    #[test]
    fn metal_launch_accepts_complete_hf_and_mlx_text_with_app_owned_environment() {
        let dir = temp_dir("metal-text");
        let runtime = metal_runtime();
        for extra in [
            json!({}),
            json!({"quantization":{"bits":4,"group_size":64}}),
        ] {
            metal_snapshot(&dir, "qwen3", "Qwen3ForCausalLM", extra);
            let mut cfg = config(ProviderId::Vllm, json!({"max_model_len":128}));
            cfg.active_model = dir.to_string_lossy().into_owned();
            let command = engine_command(&cfg, &runtime, 2, "secret").unwrap();
            let plugin_names = command
                .env
                .iter()
                .find(|(key, _)| key == "VLLM_PLUGINS")
                .expect("Metal needs an explicit plugin allowlist")
                .1
                .to_str()
                .expect("plugin entry-point names are UTF-8")
                .split(',')
                .collect::<Vec<_>>();
            // Platform discovery and general model loaders use the same
            // allowlist; the isolated launch must permit both entry points.
            assert!(plugin_names.contains(&"metal"));
            assert!(plugin_names.contains(&"gguf_metal"));
            assert!(command.env.contains(&("HF_HUB_OFFLINE".into(), "1".into())));
            assert!(command
                .env
                .contains(&("VLLM_METAL_MULTIMODAL_MODE".into(), "auto".into())));
            assert!(!command.args.iter().any(|arg| arg.contains("secret")));
        }
        std::fs::remove_file(dir.join("model.safetensors")).unwrap();
        let mut cfg = config(ProviderId::Vllm, json!({}));
        cfg.active_model = dir.to_string_lossy().into_owned();
        assert!(engine_command(&cfg, &runtime, 2, "").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn metal_pooling_and_lora_bindings_are_checked_before_launch() {
        let dir = temp_dir("metal-bindings");
        let adapter = dir.join("adapter");
        std::fs::create_dir(&adapter).unwrap();
        write(
            &adapter,
            "adapter_config.json",
            br#"{"r":8,"lora_alpha":16,"target_modules":["q_proj"],"bias":"none"}"#,
        );
        write(&adapter, "adapter_model.safetensors", b"synthetic");
        metal_snapshot(&dir, "qwen3", "Qwen3ForCausalLM", json!({}));
        let runtime = metal_runtime();
        let lora = json!({"lora_adapters":[{"name":"style","path":adapter.to_string_lossy()}],"request_lora":"style"});
        let mut cfg = config(ProviderId::Vllm, lora.clone());
        cfg.active_model = dir.to_string_lossy().into_owned();
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap()
            .args
            .contains(&"--enable-lora".into()));
        cfg.provider_options
            .get_mut("vllm")
            .unwrap()
            .insert("runner".into(), json!("pooling"));
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap_err()
            .contains("LoRA"));
        cfg.provider_options.insert(
            "vllm".into(),
            json!({"runner":"pooling"}).as_object().unwrap().clone(),
        );
        assert!(engine_command(&cfg, &runtime, 2, "").is_ok());
        metal_snapshot(&dir, "llama", "LlamaForCausalLM", json!({}));
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap_err()
            .contains("pooling"));
        cfg.provider_options
            .insert("vllm".into(), lora.as_object().unwrap().clone());
        cfg.provider_options.get_mut("vllm").unwrap().insert(
            "speculative_config".into(),
            json!({"method":"ngram","num_speculative_tokens":3}),
        );
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap_err()
            .contains("LoRA"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn metal_speculation_requires_local_matching_vocab_and_full_attention_draft() {
        let dir = temp_dir("metal-spec");
        let draft = dir.join("draft");
        std::fs::create_dir(&draft).unwrap();
        metal_snapshot(&dir, "qwen3", "Qwen3ForCausalLM", json!({}));
        metal_snapshot(&draft, "qwen3", "Qwen3ForCausalLM", json!({}));
        let runtime = metal_runtime();
        let mut cfg = config(
            ProviderId::Vllm,
            json!({"speculative_config":{"method":"draft_model","model":draft.to_string_lossy(),"num_speculative_tokens":3}}),
        );
        cfg.active_model = dir.to_string_lossy().into_owned();
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap()
            .args
            .contains(&"--no-async-scheduling".into()));
        metal_snapshot(
            &draft,
            "qwen3",
            "Qwen3ForCausalLM",
            json!({"vocab_size":64}),
        );
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap_err()
            .contains("vocab_size"));
        metal_snapshot(
            &draft,
            "qwen3",
            "Qwen3ForCausalLM",
            json!({"sliding_window":128}),
        );
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap_err()
            .contains("full-attention"));
        cfg.provider_options.insert(
            "vllm".into(),
            json!({"speculative_config":{"method":"ngram","num_speculative_tokens":3}})
                .as_object()
                .unwrap()
                .clone(),
        );
        assert!(engine_command(&cfg, &runtime, 2, "").is_ok());
        metal_snapshot(&dir, "qwen3_next", "Qwen3NextForCausalLM", json!({}));
        assert!(engine_command(&cfg, &runtime, 2, "")
            .unwrap_err()
            .contains("non-hybrid"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn metal_local_gguf_launch_owns_matching_companion_arguments() {
        use crate::gguf::fixture::{file, Value as GgufValue};
        let dir = temp_dir("metal-gguf-command");
        let path = dir.join("weights.gguf");
        write(
            &dir,
            "config.json",
            br#"{"model_type":"qwen3","architectures":["Qwen3ForCausalLM"]}"#,
        );
        write(&dir, "tokenizer.json", b"{}");
        let bytes = file(
            &[("general.architecture".into(), GgufValue::Str("qwen3"))],
            &[
                ("token_embd.weight".into(), vec![32, 32], 4096),
                ("output_norm.weight".into(), vec![32], 128),
                ("blk.0.attn_q.weight".into(), vec![32, 32], 4096),
            ],
        );
        write(&dir, "weights.gguf", &bytes);
        let mut cfg = config(ProviderId::Vllm, json!({}));
        cfg.active_model = path.to_string_lossy().into_owned();
        let runtime = metal_runtime();
        let command = engine_command(&cfg, &runtime, 2, "").unwrap();
        for flag in ["--tokenizer", "--hf-config-path"] {
            let index = command.args.iter().position(|arg| arg == flag).unwrap();
            assert_eq!(command.args[index + 1], dir.to_string_lossy());
        }
        let mut missing_extra = runtime.clone();
        missing_extra.probe.as_mut().unwrap().metal_gguf = false;
        assert!(engine_command(&cfg, &missing_extra, 2, "")
            .unwrap_err()
            .contains("gguf>=0.17.0"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn runtime(provider: ProviderId) -> PythonRuntimeManifest {
        PythonRuntimeManifest {
            format: 1,
            provider,
            id: "managed-x".into(),
            kind: InstallationKind::Managed,
            python: "/opt/aiolm/venv/bin/python".into(),
            requested_version: None,
            probe: Some(ProbeRecord {
                version: "1".into(),
                ..Default::default()
            }),
        }
    }

    fn config(provider: ProviderId, options: Value) -> AppConfig {
        let mut cfg = AppConfig {
            active_provider: provider.as_str().into(),
            active_runtime: "managed-x".into(),
            active_model: "/models/Qwen2.5-VL-7B".into(),
            ..Default::default()
        };
        cfg.provider_options.insert(
            provider.as_str().into(),
            options.as_object().unwrap().clone(),
        );
        cfg
    }

    #[test]
    fn vllm_command_owns_identity_network_and_credentials() {
        let cfg = config(
            ProviderId::Vllm,
            json!({"max_model_len": 8192, "enable_prefix_caching": false, "temperature": 0.3}),
        );
        let command = engine_command(&cfg, &runtime(ProviderId::Vllm), 41000, "secret").unwrap();
        assert_eq!(
            command.args,
            vec![
                "-I",
                "-m",
                "vllm.entrypoints.cli.main",
                "serve",
                "/models/Qwen2.5-VL-7B",
                "--host",
                "127.0.0.1",
                "--port",
                "41000",
                "--served-model-name",
                "Qwen2.5-VL-7B",
                "--max-model-len",
                "8192",
                "--no-enable-prefix-caching",
            ]
        );
        assert!(!command.args.iter().any(|arg| arg.contains("secret")));
        assert_eq!(command.env, vec![("VLLM_API_KEY".into(), "secret".into())]);
        assert_eq!(command.upstream_model, "Qwen2.5-VL-7B");
        assert!(!command.readiness.health_authenticated);
    }

    #[test]
    fn mlx_command_preloads_the_exact_model_path_and_reads_the_key_from_env() {
        let cfg = config(
            ProviderId::MlxVlm,
            json!({"kv_bits": 4, "enable_thinking": true}),
        );
        let command = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 41001, "k").unwrap();
        assert_eq!(
            &command.args[..9],
            &[
                "-I",
                "-m",
                "mlx_vlm.server",
                "--host",
                "127.0.0.1",
                "--port",
                "41001",
                "--model",
                "/models/Qwen2.5-VL-7B",
            ]
        );
        assert!(command.args.ends_with(&[
            "--kv-bits".into(),
            "4".into(),
            "--enable-thinking".into()
        ]));
        assert_eq!(
            command.env,
            vec![("MLX_VLM_SERVER_API_KEY".into(), "k".into())]
        );
        assert_eq!(command.upstream_model, "/models/Qwen2.5-VL-7B");
        assert!(command.readiness.health_authenticated);
    }

    #[test]
    fn invalid_or_foreign_options_block_the_launch() {
        let cfg = config(ProviderId::Vllm, json!({"ctx_size": 4096}));
        let error = engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "").unwrap_err();
        assert!(error.contains("ctx_size"));
        let cfg = config(
            ProviderId::MlxVlm,
            json!({"lora_adapters": [{"name":"a","path":"/x"},{"name":"b","path":"/y"}]}),
        );
        let issues = option_issues(
            ProviderId::MlxVlm,
            &provider_options(&cfg, ProviderId::MlxVlm),
        );
        assert!(issues.iter().any(|issue| issue.code == "binding"));
        let cfg = config(
            ProviderId::Vllm,
            json!({"draft_model": "/d", "request_lora": "missing"}),
        );
        let issues = option_issues(ProviderId::Vllm, &provider_options(&cfg, ProviderId::Vllm));
        assert_eq!(issues.len(), 2);
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aiolm-launch-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, contents: &[u8]) {
        std::fs::write(dir.join(name), contents).unwrap();
    }

    /// A complete synthetic snapshot: configuration, one weight file and,
    /// unless it is a drafter, a tokenizer.
    fn snapshot(label: &str, config: Value, tokenizer: bool) -> PathBuf {
        let dir = temp_dir(label);
        write(&dir, "config.json", config.to_string().as_bytes());
        write(&dir, "model.safetensors", b"weights");
        if tokenizer {
            write(&dir, "tokenizer.json", b"{}");
        }
        dir
    }

    fn with_flags(provider: ProviderId, flags: &[&str]) -> PythonRuntimeManifest {
        let mut runtime = runtime(provider);
        runtime.probe.as_mut().unwrap().server_flags =
            flags.iter().map(|flag| flag.to_string()).collect();
        runtime
    }

    #[test]
    fn llama_lora_files_are_not_accepted_as_engine_adapters() {
        let dir = temp_dir("lora");
        let gguf = dir.join("adapter.gguf");
        std::fs::write(&gguf, b"GGUF").unwrap();
        assert!(adapter_problem(ProviderId::Vllm, &gguf, None).is_some());
        assert!(adapter_problem(ProviderId::Vllm, &dir, None)
            .unwrap()
            .contains("adapter_config.json"));
        write(
            &dir,
            "adapter_config.json",
            br#"{"r":8,"lora_alpha":16,"target_modules":["q_proj"]}"#,
        );
        assert!(adapter_problem(ProviderId::Vllm, &dir, None)
            .unwrap()
            .contains("adapter_model.safetensors"));
        write(&dir, "adapter_model.safetensors", b"tensors");
        assert!(adapter_problem(ProviderId::Vllm, &dir, None).is_none());
        let cfg = config(
            ProviderId::Vllm,
            json!({"lora_adapters": [{"name":"style","path": dir.to_string_lossy()}], "request_lora": "style"}),
        );
        let command = engine_command(&cfg, &runtime(ProviderId::Vllm), 2, "").unwrap();
        let position = command
            .args
            .iter()
            .position(|arg| arg == "--lora-modules")
            .unwrap();
        assert_eq!(command.args[position - 1], "--enable-lora");
        assert_eq!(
            command.args[position + 1],
            format!("style={}", dir.to_string_lossy())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn adapters_are_checked_against_what_each_pinned_engine_loads() {
        let dir = temp_dir("peft");
        write(&dir, "adapter_model.safetensors", b"tensors");
        for (config, expected) in [
            (
                r#"{"lora_alpha":16,"target_modules":"all-linear"}"#,
                "positive integer `r`",
            ),
            (
                r#"{"r":0,"lora_alpha":16,"target_modules":["q"]}"#,
                "positive integer `r`",
            ),
            (r#"{"r":8,"target_modules":["q"]}"#, "lora_alpha"),
            (r#"{"r":8,"lora_alpha":16}"#, "target_modules"),
            (
                r#"{"r":8,"lora_alpha":16,"target_modules":["q"],"bias":"all"}"#,
                "bias",
            ),
            (
                r#"{"r":8,"lora_alpha":16,"target_modules":["q"],"use_dora":true}"#,
                "DoRA",
            ),
            (
                r#"{"r":8,"lora_alpha":16,"target_modules":["q"],"modules_to_save":["lm_head"]}"#,
                "modules_to_save",
            ),
            (
                r#"{"r":32,"lora_alpha":16,"target_modules":["q"]}"#,
                "exceeds max_lora_rank 16",
            ),
            ("[1]", "valid JSON object"),
        ] {
            write(&dir, "adapter_config.json", config.as_bytes());
            let problem = adapter_problem(ProviderId::Vllm, &dir, None).unwrap_or_default();
            assert!(problem.contains(expected), "{config}: {problem}");
        }
        write(
            &dir,
            "adapter_config.json",
            br#"{"r":32,"lora_alpha":16,"target_modules":["q"],"modules_to_save":["score"]}"#,
        );
        assert!(adapter_problem(ProviderId::Vllm, &dir, Some(64)).is_none());
        // A PEFT adapter is not an mlx-vlm adapter, and the reverse.
        assert!(adapter_problem(ProviderId::MlxVlm, &dir, None)
            .unwrap()
            .contains("`rank`"));
        write(&dir, "adapter_config.json", br#"{"rank":8,"alpha":16}"#);
        assert!(adapter_problem(ProviderId::MlxVlm, &dir, None)
            .unwrap()
            .contains("adapters.safetensors"));
        write(&dir, "adapters.safetensors", b"tensors");
        assert!(adapter_problem(ProviderId::MlxVlm, &dir, None).is_none());
        write(
            &dir,
            "adapter_config.json",
            br#"{"lora_parameters":{"rank":8}}"#,
        );
        assert!(adapter_problem(ProviderId::MlxVlm, &dir, None).is_none());
        let cfg = config(
            ProviderId::Vllm,
            json!({"lora_adapters": [{"name":"a","path": dir.to_string_lossy()}]}),
        );
        assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap_err()
            .contains("positive integer `r`"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn vllm_embedding_only_models_launch_the_pooling_runner_whatever_their_role() {
        // BertModel without sentence-transformers files is a plain `Model`
        // artifact, but vLLM registers it for pooling only.
        let model = snapshot(
            "bert",
            json!({"architectures":["BertModel"],"model_type":"bert"}),
            true,
        );
        assert_eq!(
            artifacts::inspect_snapshot(&model).role,
            artifacts::ArtifactRole::Model
        );
        let mut cfg = config(ProviderId::Vllm, json!({}));
        cfg.active_model = model.to_string_lossy().into_owned();
        let args = engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap()
            .args;
        let runner = args.iter().position(|arg| arg == "--runner").unwrap();
        assert_eq!(args[runner + 1], "pooling");
        cfg.provider_options.insert(
            "vllm".into(),
            json!({"runner":"auto"}).as_object().unwrap().clone(),
        );
        let args = engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap()
            .args;
        assert_eq!(args.iter().filter(|arg| *arg == "--runner").count(), 1);
        assert!(args.windows(2).any(|pair| pair == ["--runner", "pooling"]));
        cfg.provider_options.insert(
            "vllm".into(),
            json!({"runner":"generate"}).as_object().unwrap().clone(),
        );
        assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap_err()
            .contains("pooling runner"));
        // A model vLLM registers for generation keeps the engine's own choice.
        let chat = snapshot(
            "qwen2",
            json!({"architectures":["Qwen2ForCausalLM"],"model_type":"qwen2"}),
            true,
        );
        cfg.active_model = chat.to_string_lossy().into_owned();
        cfg.provider_options.insert("vllm".into(), Map::new());
        assert!(!engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap()
            .args
            .contains(&"--runner".to_string()));
        std::fs::remove_dir_all(model).unwrap();
        std::fs::remove_dir_all(chat).unwrap();
    }

    #[test]
    fn mlx_embedding_models_and_companions_follow_the_compatibility_verdict() {
        let bert = snapshot(
            "mlx-bert",
            json!({"architectures":["BertModel"],"model_type":"bert"}),
            true,
        );
        let mut cfg = config(ProviderId::MlxVlm, json!({}));
        cfg.active_model = bert.to_string_lossy().into_owned();
        let args = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
            .unwrap()
            .args;
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--embedding-model" && pair[1] == cfg.active_model));
        assert!(!args.contains(&"--model".to_string()));
        // A chat model is not an embedding companion.
        let chat = snapshot(
            "mlx-llama",
            json!({"architectures":["LlamaForCausalLM"],"model_type":"llama"}),
            true,
        );
        cfg.active_model = chat.to_string_lossy().into_owned();
        cfg.provider_options.insert(
            "mlx-vlm".into(),
            json!({"embedding_model": chat.to_string_lossy()})
                .as_object()
                .unwrap()
                .clone(),
        );
        assert!(engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
            .unwrap_err()
            .contains("embedding_model"));
        cfg.provider_options.insert(
            "mlx-vlm".into(),
            json!({"embedding_model": bert.to_string_lossy()})
                .as_object()
                .unwrap()
                .clone(),
        );
        let args = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
            .unwrap()
            .args;
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == cfg.active_model));
        assert!(args.windows(2).any(|pair| pair[0] == "--embedding-model"));
        std::fs::remove_dir_all(bert).unwrap();
        std::fs::remove_dir_all(chat).unwrap();
    }

    #[test]
    fn mlx_draft_models_must_be_complete_snapshots_of_the_selected_kind() {
        assert!(
            draft_problem(Path::new("/definitely/missing/drafter"), None)
                .unwrap()
                .contains("does not exist")
        );
        let drafter = snapshot(
            "drafter",
            json!({"architectures":["Gemma4AssistantModel"],"model_type":"gemma4_assistant"}),
            false,
        );
        assert!(
            draft_problem(&drafter, None).is_none(),
            "drafters need no tokenizer"
        );
        assert!(draft_problem(&drafter, Some("mtp")).is_none());
        assert!(draft_problem(&drafter, Some("dflash"))
            .unwrap()
            .contains("'mtp' drafter"));
        write(&drafter, "model-00002.safetensors.aiolm-part", b"x");
        assert!(draft_problem(&drafter, None)
            .unwrap()
            .contains("did not complete"));
        let mut cfg = config(
            ProviderId::MlxVlm,
            json!({"draft_model": drafter.to_string_lossy(), "draft_kind": "mtp"}),
        );
        cfg.active_model = "/models/target".into();
        assert!(engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
            .unwrap_err()
            .contains("did not complete"));
        std::fs::remove_file(drafter.join("model-00002.safetensors.aiolm-part")).unwrap();
        let args = engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
            .unwrap()
            .args;
        assert!(args.windows(2).any(|pair| pair[0] == "--draft-model"));
        std::fs::remove_dir_all(drafter).unwrap();
    }

    #[test]
    fn probed_server_flags_govern_bindings_as_well_as_options() {
        let adapter = temp_dir("flags");
        write(
            &adapter,
            "adapter_config.json",
            br#"{"r":8,"lora_alpha":16,"target_modules":["q"]}"#,
        );
        write(&adapter, "adapter_model.safetensors", b"tensors");
        let options = json!({
            "lora_adapters": [{"name":"a","path": adapter.to_string_lossy()}],
            "enable_prefix_caching": false,
            "max_model_len": 4096
        });
        let cfg = config(ProviderId::Vllm, options.clone());
        let base = ["--host", "--port", "--served-model-name", "--max-model-len"];
        // The runtime lacks LoRA serving and the negated prefix-caching flag.
        let runtime = with_flags(ProviderId::Vllm, &base);
        let issues = runtime_option_issues(&runtime, options.as_object().unwrap());
        let flagged = issues
            .iter()
            .map(|issue| (issue.key.as_str(), issue.message.clone()))
            .collect::<Vec<_>>();
        assert!(flagged
            .iter()
            .any(|(key, message)| *key == "lora_adapters" && message.contains("--lora-modules")));
        assert!(flagged
            .iter()
            .any(|(key, message)| *key == "enable_prefix_caching"
                && message.contains("--no-enable-prefix-caching")));
        assert!(!flagged.iter().any(|(key, _)| *key == "max_model_len"));
        assert!(engine_command(&cfg, &runtime, 1, "")
            .unwrap_err()
            .contains("does not support"));
        let full = with_flags(
            ProviderId::Vllm,
            &[
                &base[..],
                &[
                    "--enable-lora",
                    "--lora-modules",
                    "--no-enable-prefix-caching",
                    "--enable-prefix-caching",
                ],
            ]
            .concat(),
        );
        assert!(runtime_option_issues(&full, options.as_object().unwrap()).is_empty());
        engine_command(&cfg, &full, 1, "").unwrap();
        // The pooling runner is a binding too: a runtime without `--runner`
        // cannot serve an embedding-only model.
        let model = snapshot(
            "flags-bert",
            json!({"architectures":["BertModel"],"model_type":"bert"}),
            true,
        );
        let mut cfg = config(ProviderId::Vllm, json!({}));
        cfg.active_model = model.to_string_lossy().into_owned();
        assert!(
            engine_command(&cfg, &with_flags(ProviderId::Vllm, &base), 1, "")
                .unwrap_err()
                .contains("--runner")
        );
        std::fs::remove_dir_all(adapter).unwrap();
        std::fs::remove_dir_all(model).unwrap();
    }

    #[test]
    fn vllm_rank_and_tool_settings_match_what_the_server_accepts() {
        let issues = option_issues(
            ProviderId::Vllm,
            json!({"max_lora_rank": 24}).as_object().unwrap(),
        );
        assert_eq!(
            issues.iter().map(|issue| issue.code).collect::<Vec<_>>(),
            vec!["choice"]
        );
        assert!(option_issues(
            ProviderId::Vllm,
            json!({"max_lora_rank": 320}).as_object().unwrap()
        )
        .is_empty());
        let issues = option_issues(
            ProviderId::Vllm,
            json!({"enable_auto_tool_choice": true})
                .as_object()
                .unwrap(),
        );
        assert_eq!(issues[0].key, "enable_auto_tool_choice");
        assert!(option_issues(
            ProviderId::Vllm,
            json!({"enable_auto_tool_choice": true, "tool_call_parser": "hermes"})
                .as_object()
                .unwrap()
        )
        .is_empty());
        let issues = option_issues(
            ProviderId::Vllm,
            json!({"trust_remote_code": true}).as_object().unwrap(),
        );
        assert_eq!(issues[0].code, "managed");
        assert!(option_issues(
            ProviderId::MlxVlm,
            json!({"trust_remote_code": false}).as_object().unwrap()
        )
        .is_empty());
    }

    #[test]
    fn served_names_are_safe_for_clients() {
        assert_eq!(served_model_name("/m/org/My Model:v1/"), "My-Model-v1");
        assert_eq!(
            served_model_name("C:\\models\\qwen"),
            if cfg!(windows) {
                "qwen"
            } else {
                "C--models-qwen"
            }
        );
        assert_eq!(served_model_name("/"), "model");
    }

    #[test]
    fn vllm_adapters_load_only_from_safetensors() {
        let dir = temp_dir("pickle");
        write(
            &dir,
            "adapter_config.json",
            br#"{"r":8,"lora_alpha":16,"target_modules":["q"]}"#,
        );
        for pickle in ["adapter_model.bin", "adapter_model.pt"] {
            write(&dir, pickle, b"pickle");
            let problem = adapter_problem(ProviderId::Vllm, &dir, None).unwrap();
            assert!(
                problem.contains(pickle) && problem.contains("safetensors"),
                "{problem}"
            );
            let cfg = config(
                ProviderId::Vllm,
                json!({"lora_adapters": [{"name":"a","path": dir.to_string_lossy()}]}),
            );
            assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
                .unwrap_err()
                .contains("pickle checkpoint"));
            std::fs::remove_file(dir.join(pickle)).unwrap();
        }
        // vLLM reads adapter_model.safetensors first, so a leftover pickle
        // beside it is never loaded.
        write(&dir, "adapter_model.bin", b"pickle");
        write(&dir, "adapter_model.safetensors", b"tensors");
        assert!(adapter_problem(ProviderId::Vllm, &dir, None).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn values_that_argparse_would_read_as_options_are_refused() {
        assert!(!valid_adapter_name("-x"));
        assert!(valid_adapter_name("style-1"));
        let mut cfg = config(ProviderId::Vllm, json!({}));
        cfg.active_model = "--port".into();
        assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap_err()
            .contains("must not start with '-'"));
        let cfg = config(
            ProviderId::Vllm,
            json!({"lora_adapters": [{"name":"a","path":"--host"}]}),
        );
        assert!(engine_command(&cfg, &runtime(ProviderId::Vllm), 1, "")
            .unwrap_err()
            .contains("must not start with '-'"));
        let cfg = config(ProviderId::MlxVlm, json!({"draft_model": "-d"}));
        assert!(engine_command(&cfg, &runtime(ProviderId::MlxVlm), 1, "")
            .unwrap_err()
            .contains("must not start with '-'"));
        assert_eq!(served_model_name("/m/--evil"), "evil");
        assert_eq!(served_model_name("/m/---"), "model");
    }

    #[test]
    fn raw_arguments_are_compared_to_probed_flags_in_the_spelling_vllm_parses() {
        let runtime = with_flags(
            ProviderId::Vllm,
            &["--disable-log-stats", "--max-model-len"],
        );
        let options = json!({"extra_args": ["--disable_log_stats"]});
        assert!(runtime_option_issues(&runtime, options.as_object().unwrap()).is_empty());
        let options = json!({"extra_args": ["--disable_log_request"]});
        let issues = runtime_option_issues(&runtime, options.as_object().unwrap());
        assert!(issues
            .iter()
            .any(|issue| issue.message.contains("--disable-log-request")));
    }
}
