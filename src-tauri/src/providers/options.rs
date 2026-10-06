//! Provider option schemas.
//!
//! A schema is the single description of what an engine accepts: the UI
//! renders it, saved values are validated against it, launch arguments and
//! request fields are generated from it, and a pasted command line is imported
//! through it. An option that is absent inherits the engine's own documented
//! default, so nothing here injects a value the engine would not choose itself.
//!
//! Flags and request fields were checked against upstream source:
//! vLLM v0.31.0 (`vllm/engine/arg_utils.py`, `vllm/entrypoints/launchers/cli_args.py`,
//! `vllm/config/{cache,model,scheduler}.py`) and mlx-vlm v0.7.6
//! (`mlx_vlm/server/cli.py`, `mlx_vlm/server/schemas.py`). llama.cpp keeps its
//! typed configuration fields and server-help driven catalog, so it has no
//! entries here; options never cross from one provider to another.
use super::ProviderId;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OptionKind {
    Integer {
        min: i64,
        max: i64,
    },
    Number {
        min: f64,
        max: f64,
    },
    /// A store-true style flag; `false` is the same as absent.
    Flag,
    /// A `--name/--no-name` boolean, where both values are meaningful.
    Toggle,
    Choice {
        choices: &'static [&'static str],
    },
    Text {
        max_len: usize,
    },
    /// A local file or directory chosen by the user.
    Path,
    /// A JSON object passed as one argument.
    Json,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OptionTarget {
    /// Part of the server command line; applies on the next start.
    Launch,
    /// Sent with each request; applies without a restart.
    Request,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct OptionSpec {
    pub key: &'static str,
    /// Command-line flag for launch options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<&'static str>,
    pub kind: OptionKind,
    pub target: OptionTarget,
    pub group: &'static str,
    /// The engine's documented default, shown as provenance; `None` when the
    /// default is derived from the model or hardware at load time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_default: Option<&'static str>,
}

const fn launch(
    key: &'static str,
    flag: &'static str,
    kind: OptionKind,
    group: &'static str,
    runtime_default: Option<&'static str>,
) -> OptionSpec {
    OptionSpec {
        key,
        flag: Some(flag),
        kind,
        target: OptionTarget::Launch,
        group,
        runtime_default,
    }
}

const fn request(
    key: &'static str,
    kind: OptionKind,
    group: &'static str,
    runtime_default: Option<&'static str>,
) -> OptionSpec {
    OptionSpec {
        key,
        flag: None,
        kind,
        target: OptionTarget::Request,
        group,
        runtime_default,
    }
}

const I32: i64 = i32::MAX as i64;

const VLLM_DTYPES: &[&str] = &["auto", "half", "float16", "bfloat16", "float", "float32"];
const VLLM_KV_CACHE_DTYPES: &[&str] = &[
    "auto",
    "float16",
    "bfloat16",
    "fp8",
    "fp8_e4m3",
    "fp8_e5m2",
    "fp8_inc",
    "fp8_ds_mla",
    "nvfp4_ds_mla",
    "turboquant_k8v4",
    "turboquant_4bit_nc",
    "turboquant_k3v4_nc",
    "turboquant_3bit_nc",
    "int4_per_token_head",
    "int8_per_token_head",
    "fp8_per_token_head",
    "nvfp4",
    "nvfp4_4over6",
];

pub const VLLM_OPTIONS: &[OptionSpec] = &[
    launch(
        "runner",
        "--runner",
        OptionKind::Choice {
            choices: &["auto", "generate", "pooling"],
        },
        "model",
        Some("auto"),
    ),
    launch(
        "max_model_len",
        "--max-model-len",
        OptionKind::Integer { min: 1, max: I32 },
        "context",
        None,
    ),
    launch(
        "gpu_memory_utilization",
        "--gpu-memory-utilization",
        OptionKind::Number {
            min: 0.01,
            max: 1.0,
        },
        "memory",
        Some("0.92"),
    ),
    launch(
        "kv_cache_dtype",
        "--kv-cache-dtype",
        OptionKind::Choice {
            choices: VLLM_KV_CACHE_DTYPES,
        },
        "memory",
        Some("auto"),
    ),
    launch(
        "cpu_offload_gb",
        "--cpu-offload-gb",
        OptionKind::Number {
            min: 0.0,
            max: 4096.0,
        },
        "memory",
        Some("0"),
    ),
    launch(
        "dtype",
        "--dtype",
        OptionKind::Choice {
            choices: VLLM_DTYPES,
        },
        "model",
        Some("auto"),
    ),
    launch(
        "quantization",
        "--quantization",
        OptionKind::Text { max_len: 64 },
        "model",
        None,
    ),
    launch(
        "enforce_eager",
        "--enforce-eager",
        OptionKind::Flag,
        "model",
        Some("false"),
    ),
    launch(
        "generation_config",
        "--generation-config",
        OptionKind::Text { max_len: 4096 },
        "model",
        Some("auto"),
    ),
    launch(
        "seed",
        "--seed",
        OptionKind::Integer { min: 0, max: I32 },
        "model",
        Some("0"),
    ),
    launch(
        "tensor_parallel_size",
        "--tensor-parallel-size",
        OptionKind::Integer { min: 1, max: 64 },
        "parallel",
        Some("1"),
    ),
    launch(
        "pipeline_parallel_size",
        "--pipeline-parallel-size",
        OptionKind::Integer { min: 1, max: 64 },
        "parallel",
        Some("1"),
    ),
    launch(
        "max_num_seqs",
        "--max-num-seqs",
        OptionKind::Integer {
            min: 1,
            max: 65_536,
        },
        "parallel",
        Some("128"),
    ),
    launch(
        "max_num_batched_tokens",
        "--max-num-batched-tokens",
        OptionKind::Integer { min: 1, max: I32 },
        "parallel",
        None,
    ),
    launch(
        "enable_prefix_caching",
        "--enable-prefix-caching",
        OptionKind::Toggle,
        "parallel",
        None,
    ),
    launch(
        "enable_chunked_prefill",
        "--enable-chunked-prefill",
        OptionKind::Toggle,
        "parallel",
        None,
    ),
    launch(
        "limit_mm_per_prompt",
        "--limit-mm-per-prompt",
        OptionKind::Json,
        "multimodal",
        None,
    ),
    launch(
        "enable_lora",
        "--enable-lora",
        OptionKind::Flag,
        "lora",
        Some("false"),
    ),
    launch(
        "max_loras",
        "--max-loras",
        OptionKind::Integer { min: 1, max: 1024 },
        "lora",
        Some("1"),
    ),
    launch(
        "max_lora_rank",
        "--max-lora-rank",
        OptionKind::Integer { min: 1, max: 4096 },
        "lora",
        Some("16"),
    ),
    launch(
        "speculative_config",
        "--speculative-config",
        OptionKind::Json,
        "speculative",
        None,
    ),
    launch(
        "reasoning_parser",
        "--reasoning-parser",
        OptionKind::Text { max_len: 128 },
        "reasoning",
        None,
    ),
    launch(
        "enable_auto_tool_choice",
        "--enable-auto-tool-choice",
        OptionKind::Flag,
        "tools",
        Some("false"),
    ),
    launch(
        "tool_call_parser",
        "--tool-call-parser",
        OptionKind::Text { max_len: 128 },
        "tools",
        None,
    ),
    launch(
        "chat_template",
        "--chat-template",
        OptionKind::Path,
        "tools",
        None,
    ),
    launch(
        "enable_prompt_tokens_details",
        "--enable-prompt-tokens-details",
        OptionKind::Flag,
        "metrics",
        Some("false"),
    ),
    launch(
        "enable_per_request_metrics",
        "--enable-per-request-metrics",
        OptionKind::Flag,
        "metrics",
        Some("false"),
    ),
    request(
        "temperature",
        OptionKind::Number {
            min: 0.0,
            max: 100.0,
        },
        "sampling",
        None,
    ),
    request(
        "top_p",
        OptionKind::Number { min: 0.0, max: 1.0 },
        "sampling",
        None,
    ),
    request(
        "top_k",
        OptionKind::Integer { min: -1, max: I32 },
        "sampling",
        None,
    ),
    request(
        "min_p",
        OptionKind::Number { min: 0.0, max: 1.0 },
        "sampling",
        None,
    ),
    request(
        "repetition_penalty",
        OptionKind::Number {
            min: 0.0,
            max: 100.0,
        },
        "sampling",
        None,
    ),
    request(
        "presence_penalty",
        OptionKind::Number {
            min: -2.0,
            max: 2.0,
        },
        "sampling",
        None,
    ),
    request(
        "frequency_penalty",
        OptionKind::Number {
            min: -2.0,
            max: 2.0,
        },
        "sampling",
        None,
    ),
    request(
        "max_tokens",
        OptionKind::Integer { min: 1, max: I32 },
        "sampling",
        None,
    ),
];

const MLX_KV_SCHEMES: &[&str] = &["uniform", "turboquant"];
const MLX_DRAFT_KINDS: &[&str] = &["dflash", "eagle3", "mtp"];

pub const MLX_VLM_OPTIONS: &[OptionSpec] = &[
    launch(
        "embedding_model",
        "--embedding-model",
        OptionKind::Path,
        "model",
        None,
    ),
    launch(
        "max_tokens",
        "--max-tokens",
        OptionKind::Integer { min: 1, max: I32 },
        "context",
        None,
    ),
    launch(
        "max_kv_size",
        "--max-kv-size",
        OptionKind::Integer { min: 1, max: I32 },
        "context",
        None,
    ),
    launch(
        "prefill_step_size",
        "--prefill-step-size",
        OptionKind::Integer {
            min: 1,
            max: 1_048_576,
        },
        "memory",
        None,
    ),
    launch(
        "kv_bits",
        "--kv-bits",
        OptionKind::Number {
            min: 1.0,
            max: 16.0,
        },
        "memory",
        None,
    ),
    launch(
        "kv_quant_scheme",
        "--kv-quant-scheme",
        OptionKind::Choice {
            choices: MLX_KV_SCHEMES,
        },
        "memory",
        None,
    ),
    launch(
        "kv_group_size",
        "--kv-group-size",
        OptionKind::Integer { min: 1, max: 4096 },
        "memory",
        None,
    ),
    launch(
        "quantized_kv_start",
        "--quantized-kv-start",
        OptionKind::Integer { min: 0, max: I32 },
        "memory",
        None,
    ),
    launch(
        "vision_cache_size",
        "--vision-cache-size",
        OptionKind::Integer {
            min: 0,
            max: 10_000,
        },
        "multimodal",
        Some("20"),
    ),
    launch(
        "max_num_seqs",
        "--max-num-seqs",
        OptionKind::Integer {
            min: 1,
            max: 65_536,
        },
        "parallel",
        None,
    ),
    launch(
        "enable_thinking",
        "--enable-thinking",
        OptionKind::Flag,
        "reasoning",
        None,
    ),
    launch(
        "thinking_budget",
        "--thinking-budget",
        OptionKind::Integer { min: 0, max: I32 },
        "reasoning",
        None,
    ),
    launch(
        "draft_kind",
        "--draft-kind",
        OptionKind::Choice {
            choices: MLX_DRAFT_KINDS,
        },
        "speculative",
        None,
    ),
    launch(
        "draft_block_size",
        "--draft-block-size",
        OptionKind::Integer { min: 1, max: 4096 },
        "speculative",
        None,
    ),
    request(
        "temperature",
        OptionKind::Number {
            min: 0.0,
            max: 100.0,
        },
        "sampling",
        None,
    ),
    request(
        "top_p",
        OptionKind::Number { min: 0.0, max: 1.0 },
        "sampling",
        None,
    ),
    request(
        "top_k",
        OptionKind::Integer { min: 0, max: I32 },
        "sampling",
        Some("0"),
    ),
    request(
        "min_p",
        OptionKind::Number { min: 0.0, max: 1.0 },
        "sampling",
        Some("0"),
    ),
    request(
        "repetition_penalty",
        OptionKind::Number {
            min: 0.0,
            max: 100.0,
        },
        "sampling",
        None,
    ),
    request(
        "presence_penalty",
        OptionKind::Number {
            min: -2.0,
            max: 2.0,
        },
        "sampling",
        None,
    ),
    request(
        "frequency_penalty",
        OptionKind::Number {
            min: -2.0,
            max: 2.0,
        },
        "sampling",
        None,
    ),
    request(
        "seed",
        OptionKind::Integer { min: 0, max: I32 },
        "sampling",
        None,
    ),
];

/// Raw additional arguments, validated against `app_managed_flags`.
pub const EXTRA_ARGS_KEY: &str = "extra_args";
/// Saved by earlier versions. AioLM never executes code shipped inside a
/// model repository, so only an explicit `false` is accepted.
pub const TRUST_REMOTE_CODE_KEY: &str = "trust_remote_code";
const MAX_EXTRA_ARGS: usize = 128;
const MAX_JSON_BYTES: usize = 65_536;

pub fn schema(provider: ProviderId) -> &'static [OptionSpec] {
    match provider {
        ProviderId::Llama => &[],
        ProviderId::Vllm => VLLM_OPTIONS,
        ProviderId::MlxVlm => MLX_VLM_OPTIONS,
    }
}

/// Flags whose value the application owns: model identity, network binding,
/// credentials and bindings that have dedicated controls. Accepting them as
/// raw arguments would let a saved option silently override the selection.
pub fn app_managed_flags(provider: ProviderId) -> &'static [&'static str] {
    match provider {
        ProviderId::Llama => crate::config::APP_MANAGED_SERVER_ARGS,
        ProviderId::Vllm => &[
            "--model",
            "--host",
            "--port",
            "--uds",
            "--api-key",
            "--served-model-name",
            "--lora-modules",
            "--allowed-local-media-path",
            "--ssl-keyfile",
            "--ssl-certfile",
            "--root-path",
            "--headless",
            "--convert",
            "--trust-remote-code",
            // Reads further arguments, managed ones included, from a file.
            "--config",
        ],
        ProviderId::MlxVlm => &[
            "--model",
            "--host",
            "--port",
            "--api-key",
            "--adapter-path",
            "--draft-model",
            "--model-dir",
            "--image-model",
            "--tts-model",
            "--stt-model",
            "--decision-model",
            "--reranker-model",
            "--reload",
            "--trust-remote-code",
        ],
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct OptionIssue {
    pub key: String,
    /// `unknown`, `type`, `range`, `choice`, `managed`, `too_large`.
    pub code: &'static str,
    pub message: String,
}

fn issue(key: &str, code: &'static str, message: String) -> OptionIssue {
    OptionIssue {
        key: key.to_owned(),
        code,
        message,
    }
}

fn check_value(spec: &OptionSpec, value: &Value) -> Option<OptionIssue> {
    let key = spec.key;
    match spec.kind {
        OptionKind::Integer { min, max } => match value.as_i64() {
            Some(number) if (min..=max).contains(&number) => None,
            Some(_) => Some(issue(
                key,
                "range",
                format!("{key} must be between {min} and {max}"),
            )),
            None => Some(issue(key, "type", format!("{key} must be an integer"))),
        },
        OptionKind::Number { min, max } => match value.as_f64() {
            Some(number) if number.is_finite() && number >= min && number <= max => None,
            Some(_) => Some(issue(
                key,
                "range",
                format!("{key} must be between {min} and {max}"),
            )),
            None => Some(issue(key, "type", format!("{key} must be a number"))),
        },
        OptionKind::Flag | OptionKind::Toggle => (!value.is_boolean())
            .then(|| issue(key, "type", format!("{key} must be true or false"))),
        OptionKind::Choice { choices } => match value.as_str() {
            Some(text) if choices.contains(&text) => None,
            Some(text) => Some(issue(
                key,
                "choice",
                format!("{key} does not accept '{text}'"),
            )),
            None => Some(issue(
                key,
                "type",
                format!("{key} must be one of the listed values"),
            )),
        },
        // A value that starts with `-` would be parsed by argparse as the
        // next option instead of this option's value.
        OptionKind::Text { .. } | OptionKind::Path
            if value
                .as_str()
                .is_some_and(|text| text.trim_start().starts_with('-')) =>
        {
            Some(issue(
                key,
                "range",
                format!("{key} must not start with '-'"),
            ))
        }
        OptionKind::Text { max_len } => match value.as_str() {
            Some(text)
                if !text.trim().is_empty() && text.len() <= max_len && !text.contains('\0') =>
            {
                None
            }
            Some(_) => Some(issue(key, "range", format!("{key} is empty or too long"))),
            None => Some(issue(key, "type", format!("{key} must be text"))),
        },
        OptionKind::Path => match value.as_str() {
            Some(text)
                if !text.trim().is_empty() && text.len() <= 32_768 && !text.contains('\0') =>
            {
                None
            }
            _ => Some(issue(key, "type", format!("{key} must be a file path"))),
        },
        OptionKind::Json => match value {
            Value::Object(_)
                if serde_json::to_vec(value).map_or(0, |bytes| bytes.len()) <= MAX_JSON_BYTES =>
            {
                None
            }
            Value::Object(_) => Some(issue(key, "too_large", format!("{key} is too large"))),
            _ => Some(issue(key, "type", format!("{key} must be a JSON object"))),
        },
    }
}

fn flag_name(argument: &str) -> &str {
    argument
        .split_once('=')
        .map_or(argument, |(name, _)| name)
        .trim()
}

/// The option a `--flag` argument sets, spelled the way the schema and the
/// probed help spell it. vLLM v0.31.0 `FlexibleArgumentParser.parse_args`
/// turns `_` into `-` in names and folds `--name.key value` into the JSON
/// option `--name`; mlx-vlm v0.7.6 uses a plain `argparse.ArgumentParser`.
pub fn canonical_flag(provider: ProviderId, argument: &str) -> String {
    let name = flag_name(argument);
    match (provider, name.strip_prefix("--")) {
        (ProviderId::Vllm, Some(rest)) if !rest.is_empty() => {
            let key = rest.split('.').next().unwrap_or(rest).trim_end_matches('+');
            format!("--{}", key.replace('_', "-"))
        }
        _ => name.to_owned(),
    }
}

fn negative_number(argument: &str) -> bool {
    argument
        .strip_prefix('-')
        .is_some_and(|rest| rest.parse::<f64>().is_ok_and(f64::is_finite))
}

/// Why argparse would apply a raw argument to something other than a new,
/// unmanaged option, if it would.
fn raw_argument_problem(
    provider: ProviderId,
    specs: &[OptionSpec],
    argument: &str,
) -> Option<(&'static str, String)> {
    let managed = app_managed_flags(provider);
    let dedicated =
        |name: &str| managed.contains(&name) || specs.iter().any(|spec| spec.flag == Some(name));
    if argument == "--" {
        return Some((
            "type",
            "a bare -- would turn every later argument into a positional value".into(),
        ));
    }
    if argument.starts_with("--") {
        let name = canonical_flag(provider, argument);
        if dedicated(&name) {
            return Some((
                "managed",
                format!("{name} has a dedicated setting and cannot be passed as a raw argument"),
            ));
        }
        // argparse accepts any unambiguous prefix of a long option
        // (`allow_abbrev` defaults to true in both servers).
        let abbreviated = managed
            .iter()
            .copied()
            .chain(specs.iter().filter_map(|spec| spec.flag))
            .find(|flag| flag.starts_with(name.as_str()));
        if let Some(full) = abbreviated {
            return Some(("managed", format!("{name} abbreviates {full}, which has a dedicated setting; spell out the full flag")));
        }
        return None;
    }
    if argument.starts_with('-') && !negative_number(argument) {
        return Some((
            "short",
            format!("short option {argument} is not accepted; use the long --flag spelling so it can be checked"),
        ));
    }
    None
}

/// Every problem with saved options. Problems are reported, never repaired:
/// an unsupported saved value stays visible until the user corrects or resets
/// it, and a launch with any issue is refused.
pub fn validate(provider: ProviderId, options: &Map<String, Value>) -> Vec<OptionIssue> {
    let specs = schema(provider);
    let mut issues = Vec::new();
    for (key, value) in options {
        if key == EXTRA_ARGS_KEY {
            match value.as_array() {
                Some(arguments) if arguments.len() <= MAX_EXTRA_ARGS => {
                    for argument in arguments {
                        match argument.as_str() {
                            Some(text)
                                if !text.trim().is_empty()
                                    && text.len() <= 32_768
                                    && !text.contains('\0') =>
                            {
                                if let Some((code, message)) =
                                    raw_argument_problem(provider, specs, text.trim())
                                {
                                    issues.push(issue(key, code, message));
                                }
                            }
                            _ => issues.push(issue(
                                key,
                                "type",
                                "raw arguments must be non-empty text".into(),
                            )),
                        }
                    }
                }
                _ => issues.push(issue(
                    key,
                    "type",
                    format!("{key} must be a list of at most {MAX_EXTRA_ARGS} arguments"),
                )),
            }
            continue;
        }
        if key == TRUST_REMOTE_CODE_KEY {
            if value != &Value::Bool(false) {
                issues.push(issue(
                    key,
                    "managed",
                    "AioLM does not run code from model repositories; clear trust_remote_code"
                        .into(),
                ));
            }
            continue;
        }
        match specs.iter().find(|spec| spec.key == key) {
            None => issues.push(issue(
                key,
                "unknown",
                format!("{key} is not an option of {}", provider.server()),
            )),
            Some(spec) => issues.extend(check_value(spec, value)),
        }
    }
    issues
}

fn json_number_text(value: &Value) -> String {
    match value {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Launch arguments for valid options, in schema order so the command line is
/// deterministic. Callers validate first; invalid values are not emitted.
pub fn launch_args(provider: ProviderId, options: &Map<String, Value>) -> Vec<String> {
    let mut args = Vec::new();
    for spec in schema(provider)
        .iter()
        .filter(|spec| spec.target == OptionTarget::Launch)
    {
        let (Some(flag), Some(value)) = (spec.flag, options.get(spec.key)) else {
            continue;
        };
        if check_value(spec, value).is_some() {
            continue;
        }
        match spec.kind {
            OptionKind::Flag => {
                if value.as_bool() == Some(true) {
                    args.push(flag.to_owned());
                }
            }
            OptionKind::Toggle => {
                if value.as_bool() == Some(true) {
                    args.push(flag.to_owned());
                } else {
                    args.push(format!("--no-{}", &flag[2..]));
                }
            }
            OptionKind::Json => {
                args.push(flag.to_owned());
                args.push(value.to_string());
            }
            _ => {
                args.push(flag.to_owned());
                args.push(json_number_text(value));
            }
        }
    }
    if let Some(extra) = options.get(EXTRA_ARGS_KEY).and_then(Value::as_array) {
        args.extend(extra.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    args
}

/// Request fields to merge into each generation request.
pub fn request_fields(provider: ProviderId, options: &Map<String, Value>) -> Map<String, Value> {
    schema(provider)
        .iter()
        .filter(|spec| spec.target == OptionTarget::Request)
        .filter_map(|spec| {
            let value = options.get(spec.key)?;
            check_value(spec, value)
                .is_none()
                .then(|| (spec.key.to_owned(), value.clone()))
        })
        .collect()
}

/// Split a pasted command line the way a POSIX shell would for simple input:
/// whitespace separates words, quotes group them, a backslash escapes the next
/// character and a trailing backslash continues the line.
pub fn split_command(text: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut has_word = false;
    let mut chars = text.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => match chars.next() {
                Some(next @ ('"' | '\\' | '$' | '`')) => current.push(next),
                Some('\n') => {}
                Some(next) => {
                    current.push('\\');
                    current.push(next);
                }
                None => return Err("unterminated escape".into()),
            },
            (Some(_), c) => current.push(c),
            (None, '\'' | '"') => {
                quote = Some(ch);
                has_word = true;
            }
            (None, '\\') => match chars.next() {
                Some('\n') | Some('\r') => {}
                Some(next) => {
                    current.push(next);
                    has_word = true;
                }
                None => {}
            },
            (None, c) if c.is_whitespace() => {
                if has_word {
                    words.push(std::mem::take(&mut current));
                    has_word = false;
                }
            }
            (None, c) => {
                current.push(c);
                has_word = true;
            }
        }
    }
    if quote.is_some() {
        return Err("unterminated quote".into());
    }
    if has_word {
        words.push(current);
    }
    Ok(words)
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ImportedCommand {
    pub options: Map<String, Value>,
    /// The model the command named, reported for confirmation; importing never
    /// selects a model or runtime by itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Arguments that were recognised but are owned by the application.
    pub managed: Vec<String>,
    /// Arguments this provider's schema does not describe, kept verbatim for
    /// review rather than guessed.
    pub unrecognized: Vec<String>,
}

fn parse_spec_value(spec: &OptionSpec, text: &str) -> Option<Value> {
    let value = match spec.kind {
        OptionKind::Integer { .. } => Value::from(text.parse::<i64>().ok()?),
        OptionKind::Number { .. } => {
            let number = text.parse::<f64>().ok()?;
            serde_json::Number::from_f64(number).map(Value::Number)?
        }
        OptionKind::Json => serde_json::from_str::<Value>(text).ok()?,
        OptionKind::Flag | OptionKind::Toggle => return None,
        _ => Value::String(text.to_owned()),
    };
    check_value(spec, &value).is_none().then_some(value)
}

/// Import a command line for one provider. Only that provider's flags are
/// recognised; a llama.cpp flag in a vLLM command is reported, not translated.
pub fn import_command(provider: ProviderId, text: &str) -> Result<ImportedCommand, String> {
    let words = split_command(text)?;
    let mut result = ImportedCommand::default();
    let specs = schema(provider);
    let mut index = 0;
    // Skip the launcher: `vllm serve`, `python -m vllm.entrypoints.cli.main serve`,
    // `python -m mlx_vlm.server`, or an environment prefix.
    while index < words.len() {
        let word = words[index].as_str();
        let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
        if word.contains('=') && !word.starts_with('-') {
            index += 1;
            continue;
        }
        if base.starts_with("python")
            || base == "vllm"
            || base == "serve"
            || base == "-m"
            || word == "vllm.entrypoints.cli.main"
            || word == "mlx_vlm.server"
            || word == "mlx_vlm.server.cli"
        {
            index += 1;
            continue;
        }
        break;
    }
    if provider == ProviderId::Vllm {
        if let Some(word) = words.get(index).filter(|word| !word.starts_with('-')) {
            result.model = Some(word.clone());
            index += 1;
        }
    }
    let mut extra = Vec::new();
    while index < words.len() {
        let word = &words[index];
        index += 1;
        if !word.starts_with("--") {
            result.unrecognized.push(word.clone());
            continue;
        }
        let (name, inline) = match word.split_once('=') {
            Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
            None => (word.clone(), None),
        };
        // `--max_model_len` is `--max-model-len` to vLLM; dotted JSON keys
        // stay raw arguments so they are reviewed rather than merged.
        let name = if name.contains('.') {
            name
        } else {
            canonical_flag(provider, &name)
        };
        let take_value = |index: &mut usize| -> Option<String> {
            if let Some(value) = &inline {
                return Some(value.clone());
            }
            let next = words.get(*index)?;
            if next.starts_with("--") {
                return None;
            }
            *index += 1;
            Some(next.clone())
        };
        if name == "--model" {
            result.model = take_value(&mut index);
            continue;
        }
        if app_managed_flags(provider).contains(&name.as_str()) {
            let value = take_value(&mut index);
            result.managed.push(match value {
                Some(value) if name != "--api-key" => format!("{name} {value}"),
                _ => name.clone(),
            });
            continue;
        }
        let negated = name.strip_prefix("--no-").map(|rest| format!("--{rest}"));
        let spec = specs.iter().find(|spec| {
            spec.flag == Some(name.as_str())
                || (spec.kind == OptionKind::Toggle && negated.as_deref() == spec.flag)
        });
        match spec {
            Some(spec) if matches!(spec.kind, OptionKind::Flag | OptionKind::Toggle) => {
                let enabled = negated.as_deref() != spec.flag;
                if spec.kind == OptionKind::Flag && !enabled {
                    result.unrecognized.push(word.clone());
                } else {
                    result
                        .options
                        .insert(spec.key.to_owned(), Value::Bool(enabled));
                }
            }
            Some(spec) => match take_value(&mut index) {
                Some(value) => match parse_spec_value(spec, &value) {
                    Some(parsed) => {
                        result.options.insert(spec.key.to_owned(), parsed);
                    }
                    None => result.unrecognized.push(format!("{name} {value}")),
                },
                None => result.unrecognized.push(word.clone()),
            },
            None => {
                // Keep unknown engine flags as raw arguments the user can
                // review; their value is the next word unless it is a flag.
                extra.push(word.clone());
                if inline.is_none() {
                    if let Some(next) = words.get(index).filter(|next| !next.starts_with("--")) {
                        extra.push(next.clone());
                        index += 1;
                    }
                }
            }
        }
    }
    if !extra.is_empty() {
        result.unrecognized.extend(extra.iter().cloned());
        result.options.insert(
            EXTRA_ARGS_KEY.into(),
            Value::Array(extra.into_iter().map(Value::String).collect()),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn llama_has_no_schema_entries_and_engines_do_not_share_flags_by_name() {
        assert!(schema(ProviderId::Llama).is_empty());
        for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
            let mut keys = std::collections::HashSet::new();
            for spec in schema(provider) {
                assert!(keys.insert(spec.key), "{} duplicated", spec.key);
                if let Some(flag) = spec.flag {
                    assert!(flag.starts_with("--"));
                    assert!(!app_managed_flags(provider).contains(&flag), "{flag}");
                }
                assert_eq!(spec.target == OptionTarget::Launch, spec.flag.is_some());
            }
        }
        // llama.cpp spellings are not vLLM options.
        let issues = validate(ProviderId::Vllm, &map(json!({"ctx_size": 4096, "ngl": 99})));
        assert_eq!(issues.len(), 2);
        assert!(issues.iter().all(|issue| issue.code == "unknown"));
    }

    #[test]
    fn validation_reports_every_problem_without_repairing_it() {
        let options = map(json!({
            "gpu_memory_utilization": 1.5,
            "dtype": "fp4",
            "max_model_len": "big",
            "enable_prefix_caching": false,
            "limit_mm_per_prompt": {"image": 2},
            "extra_args": ["--port", "9000", "--disable-log-stats"]
        }));
        let issues = validate(ProviderId::Vllm, &options);
        let codes = issues
            .iter()
            .map(|issue| (issue.key.as_str(), issue.code))
            .collect::<Vec<_>>();
        assert!(codes.contains(&("gpu_memory_utilization", "range")));
        assert!(codes.contains(&("dtype", "choice")));
        assert!(codes.contains(&("max_model_len", "type")));
        assert!(codes.contains(&("extra_args", "managed")));
        assert_eq!(issues.len(), 4);
        assert_eq!(options.len(), 6, "validation never removes values");
    }

    #[test]
    fn launch_arguments_are_deterministic_and_omit_inherited_defaults() {
        let options = map(json!({
            "enable_prefix_caching": false,
            "max_model_len": 8192,
            "gpu_memory_utilization": 0.85,
            "enforce_eager": true,
            "trust_remote_code": false,
            "limit_mm_per_prompt": {"image": 2, "video": 0},
            "temperature": 0.2,
            "extra_args": ["--disable-log-stats"]
        }));
        assert!(validate(ProviderId::Vllm, &options).is_empty());
        let args = launch_args(ProviderId::Vllm, &options);
        assert_eq!(
            args,
            vec![
                "--max-model-len",
                "8192",
                "--gpu-memory-utilization",
                "0.85",
                "--enforce-eager",
                "--no-enable-prefix-caching",
                "--limit-mm-per-prompt",
                "{\"image\":2,\"video\":0}",
                "--disable-log-stats",
            ]
        );
        assert!(launch_args(ProviderId::Vllm, &Map::new()).is_empty());
        let request = request_fields(ProviderId::Vllm, &options);
        assert_eq!(request.len(), 1);
        assert_eq!(request["temperature"], json!(0.2));
    }

    #[test]
    fn pasted_commands_import_only_the_providers_own_flags() {
        let imported = import_command(
            ProviderId::Vllm,
            "VLLM_LOGGING_LEVEL=INFO vllm serve /models/qwen --host 0.0.0.0 --port 8000 \\\n --max-model-len=32768 --no-enable-prefix-caching --api-key secret --ctx-size 4096 --disable-log-stats",
        )
        .unwrap();
        assert_eq!(imported.model.as_deref(), Some("/models/qwen"));
        assert_eq!(imported.options["max_model_len"], json!(32768));
        assert_eq!(imported.options["enable_prefix_caching"], json!(false));
        assert_eq!(
            imported.managed,
            vec!["--host 0.0.0.0", "--port 8000", "--api-key"]
        );
        assert!(imported.unrecognized.contains(&"--ctx-size".to_string()));
        assert_eq!(
            imported.options[EXTRA_ARGS_KEY],
            json!(["--ctx-size", "4096", "--disable-log-stats"])
        );
        let mlx = import_command(
            ProviderId::MlxVlm,
            "python -m mlx_vlm.server --model mlx-community/x --kv-bits 3.5 --kv-quant-scheme turboquant --enable-thinking",
        )
        .unwrap();
        assert_eq!(mlx.model.as_deref(), Some("mlx-community/x"));
        assert_eq!(mlx.options["kv_bits"], json!(3.5));
        assert_eq!(mlx.options["kv_quant_scheme"], json!("turboquant"));
        assert_eq!(mlx.options["enable_thinking"], json!(true));
        assert!(validate(ProviderId::MlxVlm, &mlx.options).is_empty());
    }

    #[test]
    fn shell_splitting_handles_quotes_escapes_and_continuations() {
        assert_eq!(
            split_command("a 'b c' \"d \\\"e\\\"\" f\\ g \\\n h").unwrap(),
            vec!["a", "b c", "d \"e\"", "f g", "h"]
        );
        assert_eq!(
            split_command("--x '{\"a\": 1}'").unwrap(),
            vec!["--x", "{\"a\": 1}"]
        );
        assert!(split_command("'open").is_err());
        assert_eq!(split_command("''").unwrap(), vec![""]);
    }

    #[test]
    fn remote_code_is_never_enabled_through_options_or_imports() {
        for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
            assert!(!schema(provider)
                .iter()
                .any(|spec| spec.key == TRUST_REMOTE_CODE_KEY));
            let issues = validate(provider, &map(json!({"trust_remote_code": true})));
            assert_eq!(issues[0].code, "managed");
            assert!(validate(provider, &map(json!({"trust_remote_code": false}))).is_empty());
            let issues = validate(
                provider,
                &map(json!({"extra_args": ["--trust-remote-code"]})),
            );
            assert_eq!(issues[0].code, "managed");
            assert!(launch_args(provider, &map(json!({"trust_remote_code": true}))).is_empty());
        }
        let imported = import_command(
            ProviderId::Vllm,
            "vllm serve /m --trust-remote-code --max-model-len 4",
        )
        .unwrap();
        assert!(imported
            .managed
            .contains(&"--trust-remote-code".to_string()));
        assert!(!imported.options.contains_key(TRUST_REMOTE_CODE_KEY));
        assert_eq!(imported.options["max_model_len"], json!(4));
    }

    #[test]
    fn raw_arguments_cannot_reach_dedicated_settings_by_another_spelling() {
        let codes = |provider: ProviderId, arguments: Value| {
            validate(provider, &map(json!({"extra_args": arguments})))
                .into_iter()
                .map(|issue| issue.code)
                .collect::<Vec<_>>()
        };
        // vLLM v0.31.0: `_` spelling, dotted JSON keys and `--config` files.
        assert_eq!(
            codes(ProviderId::Vllm, json!(["--max_model_len", "8"])),
            vec!["managed"]
        );
        assert_eq!(
            codes(ProviderId::Vllm, json!(["--served_model_name=x"])),
            vec!["managed"]
        );
        assert_eq!(
            codes(
                ProviderId::Vllm,
                json!(["--speculative-config.method", "ngram"])
            ),
            vec!["managed"]
        );
        assert_eq!(
            codes(
                ProviderId::Vllm,
                json!(["--limit-mm-per-prompt.image+", "1"])
            ),
            vec!["managed"]
        );
        assert_eq!(
            codes(ProviderId::Vllm, json!(["--config", "serve.yaml"])),
            vec!["managed"]
        );
        // argparse abbreviations (`allow_abbrev`) in both servers.
        assert_eq!(
            codes(ProviderId::Vllm, json!(["--hos", "0.0.0.0"])),
            vec!["managed"]
        );
        assert_eq!(
            codes(ProviderId::MlxVlm, json!(["--trust"])),
            vec!["managed"]
        );
        assert_eq!(
            codes(ProviderId::MlxVlm, json!(["--adapter", "/a"])),
            vec!["managed"]
        );
        // Short aliases such as -tp, -sc and -O3 hide which option they set.
        assert_eq!(codes(ProviderId::Vllm, json!(["-tp", "2"])), vec!["short"]);
        assert_eq!(codes(ProviderId::Vllm, json!(["-O3"])), vec!["short"]);
        assert_eq!(codes(ProviderId::Vllm, json!(["--"])), vec!["type"]);
        // Unmanaged flags and their values, negative numbers included, pass.
        assert!(codes(
            ProviderId::Vllm,
            json!(["--disable-log-stats", "--swap-space", "4", "--x", "-1.5"])
        )
        .is_empty());
        // mlx-vlm does not rewrite `_`, so the dedicated check is exact there.
        assert!(codes(ProviderId::MlxVlm, json!(["--log_level", "DEBUG"])).is_empty());
    }

    #[test]
    fn option_values_starting_with_a_dash_are_not_passed_to_argparse() {
        let issues = validate(
            ProviderId::Vllm,
            &map(
                json!({"tool_call_parser": "--port", "chat_template": "-x.jinja", "quantization": "fp8"}),
            ),
        );
        let keys = issues
            .iter()
            .map(|issue| (issue.key.as_str(), issue.code))
            .collect::<Vec<_>>();
        assert_eq!(keys.len(), 2);
        assert!(
            keys.contains(&("tool_call_parser", "range"))
                && keys.contains(&("chat_template", "range"))
        );
        assert!(launch_args(
            ProviderId::Vllm,
            &map(json!({"tool_call_parser": "--port"}))
        )
        .is_empty());
        let imported = import_command(
            ProviderId::Vllm,
            "vllm serve /m --max_model_len 8 --tool-call-parser -x --no-enable_prefix_caching",
        )
        .unwrap();
        assert_eq!(imported.options["max_model_len"], json!(8));
        assert_eq!(imported.options["enable_prefix_caching"], json!(false));
        assert!(!imported.options.contains_key("tool_call_parser"));
        assert!(imported
            .unrecognized
            .contains(&"--tool-call-parser -x".to_string()));
    }
}
