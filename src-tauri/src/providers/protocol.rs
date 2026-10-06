//! OpenAI-compatible request adaptation per provider.
//!
//! The public API advertises one alias per loaded model. Before a request
//! reaches an engine it is adapted here: the alias is replaced by the id the
//! engine serves, request defaults from the provider's saved options fill
//! fields the client left out, fields that would let a client reach outside the
//! loaded model are removed, and input parts the loaded model cannot accept
//! are refused with an actionable error instead of being dropped.
//!
//! llama.cpp retains its model and sampling fields while sharing media
//! validation with the other providers.
use super::artifacts::Modalities;
use super::ProviderId;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{Map, Value};

/// What a running engine session accepts. Stored with the session when it
/// becomes ready.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EngineInfo {
    pub provider: ProviderId,
    pub runtime_id: String,
    pub runtime_variant: String,
    pub speech_model_type: Option<String>,
    /// The id the engine serves the model under.
    pub upstream_model: String,
    /// Inputs usable with the loaded model on this provider.
    pub modalities: Modalities,
    pub tasks: Vec<String>,
    /// Validated request fields from the provider's saved options.
    pub request_fields: Map<String, Value>,
    /// vLLM: adapter name requests are routed to, when one is selected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_lora: Option<String>,
    pub embedding_model: Option<String>,
    pub embedding_namespace: Option<String>,
    /// `tool_choice` "auto" (or tools without a choice) can be served.
    pub tools_auto: bool,
    /// `tool_choice` "required" or a named function can be served.
    pub tool_parser: bool,
}

impl EngineInfo {
    pub fn llama(model: &str, modalities: Modalities) -> Self {
        Self {
            provider: ProviderId::Llama,
            runtime_id: String::new(),
            runtime_variant: String::new(),
            speech_model_type: None,
            upstream_model: model.to_owned(),
            modalities,
            tasks: vec!["generate".into(), "embed".into()],
            request_fields: Map::new(),
            request_lora: None,
            embedding_model: Some(model.to_owned()),
            embedding_namespace: None,
            tools_auto: true,
            tool_parser: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdaptError {
    pub code: &'static str,
    pub message: String,
}

/// Request fields an external client may not set on an engine because they
/// select files or models on this machine.
fn forbidden_fields(provider: ProviderId) -> &'static [&'static str] {
    match provider {
        // mlx-vlm v0.7.6 loads `adapter_path` per request and reads extra
        // model folders from `model_dir`.
        ProviderId::MlxVlm => &["adapter_path", "model_dir", "resize_shape"],
        ProviderId::Vllm => &[],
        ProviderId::Llama => &[],
    }
}

/// The input modality an OpenAI or engine-specific content part carries.
pub fn part_modality(part: &Value) -> Option<&'static str> {
    match part.get("type").and_then(Value::as_str)? {
        "text" | "input_text" => Some("text"),
        "image_url" | "input_image" | "image" => Some("image"),
        "input_audio" | "audio_url" | "audio" => Some("audio"),
        "video_url" | "input_video" | "video" => Some("video"),
        _ => None,
    }
}

fn supports(modalities: Modalities, modality: &str) -> bool {
    match modality {
        "text" => modalities.text,
        "image" => modalities.image,
        "audio" => modalities.audio,
        "video" => modalities.video,
        _ => false,
    }
}

fn adapt_error(code: &'static str, message: impl Into<String>) -> AdaptError {
    AdaptError {
        code,
        message: message.into(),
    }
}

fn remote(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// The reference a media part carries and whether a bare base64 payload is
/// meaningful there (`input_audio.data`, llama.cpp `input_video.data`).
fn url_of(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.get("url").and_then(Value::as_str))
}

fn media_reference(part: &Value) -> Option<(&str, bool)> {
    match part.get("type").and_then(Value::as_str)? {
        "image_url" | "input_image" => part
            .get("image_url")
            .and_then(url_of)
            .map(|url| (url, false)),
        "audio_url" => part
            .get("audio_url")
            .and_then(url_of)
            .map(|url| (url, false)),
        "input_audio" => part
            .pointer("/input_audio/data")
            .and_then(Value::as_str)
            .map(|data| (data, true)),
        "video_url" => part
            .get("video_url")
            .and_then(url_of)
            .map(|url| (url, false)),
        "input_video" => {
            let video = part
                .get("input_video")
                .or_else(|| part.get("video_url"))
                .or_else(|| part.get("video"))?;
            match video.get("data").and_then(Value::as_str) {
                Some(data) => Some((data, true)),
                None => url_of(video).map(|url| (url, false)),
            }
        }
        _ => None,
    }
}

fn decoded_len(data: &str) -> Result<usize, AdaptError> {
    if data.len() > (crate::media::MAX_MEDIA_BYTES as usize).div_ceil(3) * 4 {
        return Err(adapt_error(
            "media_limit",
            "Each media file must be at most 64 MiB.",
        ));
    }
    let decoded = STANDARD
        .decode(data)
        .map_err(|_| adapt_error("invalid_media", "Media contains invalid base64 data."))?;
    if decoded.is_empty() {
        return Err(adapt_error(
            "media_limit",
            "Each media file must be nonempty and at most 64 MiB.",
        ));
    }
    Ok(decoded.len())
}

/// Validate where a media part's bytes come from and return how many bytes it
/// carries inline. Accepted: base64 data URIs whose media type matches the
/// part, bare base64 where the format defines it, HTTP(S) URLs the engine
/// fetches itself, and, for mlx-vlm video only, files in AioLM's own media
/// store. Local paths and `file://` URLs are refused for every provider.
fn media_bytes(provider: ProviderId, modality: &str, part: &Value) -> Result<u64, AdaptError> {
    let Some((reference, bare_allowed)) = media_reference(part) else {
        return Err(adapt_error(
            "invalid_media",
            format!("The {modality} part has no media reference."),
        ));
    };
    let reference = reference.trim();
    if let Some(rest) = reference.strip_prefix("data:") {
        let (header, data) = rest
            .split_once(',')
            .ok_or_else(|| adapt_error("invalid_media", "Malformed media data URI."))?;
        if !header.ends_with(";base64") {
            return Err(adapt_error(
                "invalid_media",
                "Media data URIs must use base64 encoding.",
            ));
        }
        if !header.starts_with(&format!("{modality}/")) {
            return Err(adapt_error(
                "invalid_media",
                format!("A {modality} part needs a data:{modality}/... URI, not data:{header}."),
            ));
        }
        if provider == ProviderId::MlxVlm && modality == "video" {
            return Err(adapt_error(
                "unsupported_input",
                "mlx-vlm reads video from a file path or URL; base64 data URLs are not accepted",
            ));
        }
        return decoded_len(data).map(|len| len as u64);
    }
    if remote(reference) {
        return Ok(0);
    }
    if provider == ProviderId::MlxVlm && modality == "video" {
        if let Some(size) = crate::media::owned_file_size(reference) {
            return Ok(size);
        }
    }
    if bare_allowed {
        return decoded_len(reference).map(|len| len as u64);
    }
    Err(adapt_error(
        "untrusted_media_path",
        "External media inputs must use an HTTP URL or supported data URI; local file paths are not accepted.",
    ))
}

fn check_parts(info: &EngineInfo, messages: &[Value]) -> Result<(), AdaptError> {
    for message in messages {
        let Some(parts) = message.get("content").and_then(Value::as_array) else {
            continue;
        };
        let mut media_count = 0;
        let mut decoded_bytes = 0u64;
        for part in parts {
            let kind = part
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let Some(modality) =
                part_modality(part).filter(|_| !matches!(kind, "image" | "audio" | "video"))
            else {
                return Err(adapt_error(
                    "unsupported_content",
                    format!(
                        "content part type `{kind}` is not supported by {}; use text, image_url, input_audio, audio_url or video_url parts",
                        info.provider.server()
                    ),
                ));
            };
            if !supports(info.modalities, modality) {
                return Err(adapt_error(
                    "unsupported_input",
                    format!(
                        "the loaded model on {} does not accept {modality} input; remove the {modality} part or load a model that supports it",
                        info.provider.server()
                    ),
                ));
            }
            if modality != "text" {
                media_count += 1;
                decoded_bytes =
                    decoded_bytes.saturating_add(media_bytes(info.provider, modality, part)?);
                if media_count > 4 || decoded_bytes > 128 * 1024 * 1024 {
                    return Err(adapt_error(
                        "media_limit",
                        "Each message accepts up to four media files and 128 MiB of decoded media.",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn audio_format_of_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "audio/wav" | "audio/x-wav" | "audio/wave" => Some("wav"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/flac" | "audio/x-flac" => Some("flac"),
        _ => None,
    }
}

fn audio_mime_of_format(format: &str) -> Option<&'static str> {
    match format {
        "wav" => Some("audio/wav"),
        "mp3" => Some("audio/mpeg"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

/// llama-server decodes `input_audio.data` as bare base64 in every build that
/// has audio input; data URIs there are only understood by recent builds.
fn llama_audio(reference: &str) -> Result<Value, AdaptError> {
    match reference
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(','))
    {
        Some((header, data)) => {
            let mime = header.trim_end_matches(";base64");
            let format = audio_format_of_mime(mime).ok_or_else(|| {
                adapt_error(
                    "invalid_audio",
                    format!("llama.cpp reads wav, mp3 or flac audio, not {mime}."),
                )
            })?;
            Ok(
                serde_json::json!({"type":"input_audio","input_audio":{"data":data,"format":format}}),
            )
        }
        None => Ok(serde_json::json!({"type":"input_audio","input_audio":{"data":reference}})),
    }
}

/// Rewrite content parts into the spelling each server reads. Runs after
/// `check_parts`, so every reference here is already validated.
fn normalize_parts(provider: ProviderId, body: &mut Value) -> Result<(), AdaptError> {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for message in messages {
        let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in parts {
            let kind = part
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            match (provider, kind.as_str()) {
                (_, "input_audio") => {
                    let data = part
                        .pointer("/input_audio/data")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_owned();
                    let format = part
                        .pointer("/input_audio/format")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let bare = !data.starts_with("data:") && !remote(&data);
                    match provider {
                        // vLLM v0.31.0 `chat_utils.parse_input_audio` wraps
                        // `data` as `data:audio/{format};base64,{data}`, so a
                        // URI or URL must travel as `audio_url` instead.
                        ProviderId::Vllm if !bare => {
                            *part =
                                serde_json::json!({"type":"audio_url","audio_url":{"url":data}});
                        }
                        ProviderId::Vllm => {
                            if !format.as_deref().is_some_and(|format| {
                                !format.is_empty()
                                    && format.len() <= 16
                                    && format.bytes().all(|byte| byte.is_ascii_alphanumeric())
                            }) {
                                return Err(adapt_error("invalid_audio", "Specify input_audio.format (for example wav or mp3) for base64 audio."));
                            }
                        }
                        ProviderId::Llama if data.starts_with("data:") => {
                            *part = llama_audio(&data)?
                        }
                        // mlx-vlm v0.7.6 treats `data` that looks like a path
                        // or URL as a file reference, so bare base64 is always
                        // sent as a data URI.
                        ProviderId::MlxVlm if bare => {
                            let mime = audio_mime_of_format(format.as_deref().unwrap_or("wav"))
                                .ok_or_else(|| {
                                    adapt_error(
                                        "invalid_audio",
                                        "Specify wav, mp3 or flac for base64 audio.",
                                    )
                                })?;
                            part["input_audio"]["data"] =
                                Value::String(format!("data:{mime};base64,{data}"));
                        }
                        _ => {}
                    }
                }
                (ProviderId::Llama | ProviderId::MlxVlm, "audio_url") => {
                    let url = part
                        .get("audio_url")
                        .and_then(|value| {
                            value
                                .as_str()
                                .or_else(|| value.get("url").and_then(Value::as_str))
                        })
                        .unwrap_or("")
                        .trim()
                        .to_owned();
                    *part = if provider == ProviderId::Llama {
                        llama_audio(&url)?
                    } else {
                        serde_json::json!({"type":"input_audio","input_audio":{"data":url}})
                    };
                }
                (ProviderId::Llama, "video_url") => {
                    let url = part
                        .get("video_url")
                        .and_then(|value| {
                            value
                                .as_str()
                                .or_else(|| value.get("url").and_then(Value::as_str))
                        })
                        .unwrap_or("");
                    *part = if url.starts_with("data:video/") {
                        let data = url
                            .split_once(',')
                            .ok_or(adapt_error("invalid_video", "video data URI is malformed"))?
                            .1;
                        serde_json::json!({"type":"input_video","input_video":{"data":data}})
                    } else {
                        serde_json::json!({"type":"input_video","input_video":{"url":url}})
                    };
                }
                // llama-server reads only `text`, `image_url`, `input_audio`
                // and video parts; the Responses spellings are renamed.
                (ProviderId::Llama, "input_text") => {
                    let text = part
                        .get("text")
                        .cloned()
                        .unwrap_or(Value::String(String::new()));
                    *part = serde_json::json!({"type":"text","text":text});
                }
                (ProviderId::Llama, "input_image") => {
                    let url = part
                        .get("image_url")
                        .and_then(|value| {
                            value
                                .as_str()
                                .or_else(|| value.get("url").and_then(Value::as_str))
                        })
                        .unwrap_or("")
                        .to_owned();
                    *part = serde_json::json!({"type":"image_url","image_url":{"url":url}});
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// vLLM v0.31.0 refuses tool calls it cannot parse at request time; say which
/// runtime profile setting is missing before the request reaches it.
fn check_tools(info: &EngineInfo, body: &Map<String, Value>) -> Result<(), AdaptError> {
    if info.provider != ProviderId::Vllm
        || !body
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| !tools.is_empty())
    {
        return Ok(());
    }
    match body.get("tool_choice") {
        Some(Value::String(choice)) if choice == "none" => Ok(()),
        None | Some(Value::Null) if !info.tools_auto => Err(adapt_error(
            "tool_parser_required",
            "vLLM tools require enable_auto_tool_choice and the model's tool_call_parser in its runtime profile.",
        )),
        Some(Value::String(choice)) if choice == "auto" && !info.tools_auto => Err(adapt_error(
            "tool_parser_required",
            "vLLM tools require enable_auto_tool_choice and the model's tool_call_parser in its runtime profile.",
        )),
        Some(Value::String(choice)) if choice == "required" && !info.tool_parser => Err(adapt_error(
            "tool_parser_required",
            "vLLM tool_choice \"required\" requires the model's tool_call_parser in its runtime profile.",
        )),
        Some(Value::Object(_)) if !info.tool_parser => Err(adapt_error(
            "tool_parser_required",
            "vLLM named tool_choice requires the model's tool_call_parser in its runtime profile.",
        )),
        _ => Ok(()),
    }
}

/// Task-specific refusal so STT sessions are never described as embeddings.
/// `for_task` is `chat`, `embeddings`, `transcription` or `translation`.
fn task_refusal(info: &EngineInfo, for_task: &str) -> String {
    let serves_stt = info
        .tasks
        .iter()
        .any(|task| task == "transcription" || task == "translate");
    let serves_generate = info.tasks.iter().any(|task| task == "generate");
    let serves_embed = info.tasks.iter().any(|task| task == "embed");
    if for_task == "chat" && serves_stt && !serves_generate {
        return "This session serves speech-to-text. Select a generation session for chat.".into();
    }
    if (for_task == "transcription" || for_task == "translation")
        && !serves_stt
        && (serves_generate || serves_embed)
    {
        return format!(
                "This session serves {} and has no verified speech-to-text capability; select a transcription session for {for_task}.",
                if serves_generate && serves_embed {
                    "chat and embeddings"
                } else if serves_generate {
                    "chat"
                } else {
                    "embeddings"
                }
            );
    }
    if serves_stt && !serves_generate && !serves_embed {
        return format!(
            "This session serves speech-to-text. Select a transcription session for {for_task} only when it lists that task; chat and embeddings need their own sessions."
        );
    }
    if serves_embed && !serves_generate {
        return format!(
            "This session serves embeddings. Select a generation session for {for_task}."
        );
    }
    format!("This session does not serve {for_task}; select a session that lists that task.")
}

/// Native Metal speech-to-text adapter.
///
/// Pinned v0.30.0 evidence: `docs/stt.md` serves Whisper through
/// `/v1/audio/transcriptions` and `/v1/audio/translations`, Qwen3-ASR
/// through transcriptions only (translation unsupported; `language` and
/// `prompt` ignored). Parameters are the stt.md table plus the gateway's
/// `timestamp_granularities[]` array. `max_completion_tokens` caps the
/// transcript; `logit_bias` and `min_tokens` are rejected for every
/// vllm-metal request. The gateway preserves the binary `file` and rewrites
/// the public alias here, so no caller-provided URL or key is accepted.
fn adapt_audio_request(
    info: &EngineInfo,
    endpoint: &str,
    body: &mut Value,
) -> Result<(), AdaptError> {
    let required = if endpoint == "audio/translations" {
        "translate"
    } else {
        "transcription"
    };
    if !info.tasks.iter().any(|task| task == required) {
        let want = if required == "translate" {
            "translation"
        } else {
            "transcription"
        };
        return Err(adapt_error("unsupported_task", task_refusal(info, want)));
    }
    let object = body.as_object_mut().ok_or(adapt_error(
        "invalid_request",
        "request body must be a JSON object",
    ))?;
    // The binary audio travels outside this body; a text `file` here would
    // be a caller trying to smuggle a path or URL past the gateway.
    if object.contains_key("file") {
        return Err(adapt_error(
            "invalid_audio",
            "audio file travels as multipart binary, not as a text field",
        ));
    }
    // Qwen3-ASR ignores `language` and `prompt`; Whisper translations ignore
    // `language` (stt.md: same parameters except language). Reject `language`
    // on translations so callers do not believe it selected a language.
    if endpoint == "audio/translations" && object.contains_key("language") {
        return Err(adapt_error(
            "unsupported_field",
            "translation always targets English; remove the language field",
        ));
    }
    if info.runtime_variant == super::metal_env::VARIANT
        && info.speech_model_type.as_deref() == Some("qwen3_asr")
        && (object.contains_key("language") || object.contains_key("prompt"))
    {
        return Err(adapt_error("unsupported_field", "this Metal Qwen3-ASR implementation does not honor language or prompt; remove those fields"));
    }
    for forbidden in [
        "logit_bias",
        "min_tokens",
        "stream",
        "url",
        "key",
        "api_key",
    ] {
        if object.contains_key(forbidden) {
            return Err(adapt_error(
                "unsupported_field",
                format!("vllm-metal speech-to-text does not accept `{forbidden}`"),
            ));
        }
    }
    let text = |key: &str| object.get(key).and_then(Value::as_str).unwrap_or_default();
    if let Some(format) = object.get("response_format").and_then(Value::as_str) {
        if !["json", "text", "verbose_json"].contains(&format) {
            return Err(adapt_error(
                "invalid_audio",
                "response_format must be json, text or verbose_json",
            ));
        }
    } else if object.contains_key("response_format") {
        return Err(adapt_error(
            "invalid_audio",
            "response_format must be json, text or verbose_json",
        ));
    }
    for key in [
        "temperature",
        "top_p",
        "min_p",
        "repetition_penalty",
        "frequency_penalty",
        "presence_penalty",
    ] {
        let value = text(key);
        if object.contains_key(key) && !value.parse::<f64>().is_ok_and(f64::is_finite) {
            return Err(adapt_error(
                "invalid_audio",
                format!("`{key}` must be a number"),
            ));
        }
    }
    for key in ["top_k", "seed", "max_completion_tokens"] {
        let value = text(key);
        if object.contains_key(key) && value.parse::<i64>().is_err() {
            return Err(adapt_error(
                "invalid_audio",
                format!("`{key}` must be an integer"),
            ));
        }
    }
    if object.contains_key("language") {
        let language = text("language");
        if language.is_empty()
            || language.len() > 16
            || !language
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(adapt_error(
                "invalid_audio",
                "language must be an ISO 639-1 code such as en or zh",
            ));
        }
    }
    if let Some(stamps) = object.get("timestamp_granularities") {
        let valid = stamps.as_array().is_some_and(|values| {
            !values.is_empty()
                && values.iter().all(|value| {
                    value
                        .as_str()
                        .is_some_and(|text| ["word", "segment"].contains(&text))
                })
        });
        if !valid {
            return Err(adapt_error(
                "invalid_audio",
                "timestamp_granularities must be a nonempty array of strings",
            ));
        }
    }
    for (key, min, max) in [
        ("temperature", 0.0, 2.0),
        ("top_p", 0.0, 1.0),
        ("min_p", 0.0, 1.0),
        ("repetition_penalty", f64::MIN_POSITIVE, f64::MAX),
        ("frequency_penalty", -2.0, 2.0),
        ("presence_penalty", -2.0, 2.0),
    ] {
        if object.contains_key(key)
            && !text(key)
                .parse::<f64>()
                .is_ok_and(|value| value >= min && value <= max)
        {
            return Err(adapt_error(
                "invalid_audio",
                format!("`{key}` is outside its supported range"),
            ));
        }
    }
    if object.contains_key("max_completion_tokens")
        && !text("max_completion_tokens")
            .parse::<i64>()
            .is_ok_and(|value| value > 0)
    {
        return Err(adapt_error(
            "invalid_audio",
            "max_completion_tokens must be positive",
        ));
    }
    if info.runtime_variant == super::metal_env::VARIANT
        && object.contains_key("temperature")
        && text("temperature").parse::<f64>() != Ok(0.0)
    {
        return Err(adapt_error(
            "unsupported_field",
            "this Metal speech implementation requires greedy transcription (temperature=0)",
        ));
    }
    // Only the allowlisted transcription fields travel upstream; anything
    // else is a client trying to reach outside the loaded STT model.
    const ALLOWED: &[&str] = &[
        "model",
        "language",
        "prompt",
        "response_format",
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "seed",
        "repetition_penalty",
        "frequency_penalty",
        "presence_penalty",
        "max_completion_tokens",
        "timestamp_granularities",
    ];
    let mut unexpected = Vec::new();
    for key in object.keys() {
        if !ALLOWED.contains(&key.as_str()) {
            unexpected.push(key.clone());
        }
    }
    if !unexpected.is_empty() {
        unexpected.sort();
        return Err(adapt_error(
            "unsupported_field",
            format!("unsupported transcription field: {}", unexpected.join(", ")),
        ));
    }
    object.insert("model".into(), Value::String(info.upstream_model.clone()));
    Ok(())
}

/// Adapt a Chat Completions, Completions, Embeddings or audio transcription
/// body in place. Audio endpoints carry the gateway's multipart text fields
/// as JSON strings (plus a `timestamp_granularities` string array); the
/// binary `file` travels outside this body and is preserved by the gateway.
pub fn adapt_request(
    info: &EngineInfo,
    endpoint: &str,
    body: &mut Value,
) -> Result<(), AdaptError> {
    if endpoint == "audio/transcriptions" || endpoint == "audio/translations" {
        return adapt_audio_request(info, endpoint, body);
    }
    if endpoint != "embeddings" && !info.tasks.iter().any(|task| task == "generate") {
        return Err(adapt_error("unsupported_task", task_refusal(info, "chat")));
    }
    if endpoint == "embeddings" {
        if let Some(input) = body.get("input") {
            let parts: Vec<Value> = match input {
                Value::Object(_) => vec![input.clone()],
                Value::Array(items) => items
                    .iter()
                    .filter(|item| item.is_object())
                    .cloned()
                    .collect(),
                _ => Vec::new(),
            };
            if !parts.is_empty() {
                check_parts(info, &[serde_json::json!({"content": parts})])?;
            }
        }
    }
    if info.provider == ProviderId::Llama {
        if let Some(messages) = body.get("messages").and_then(Value::as_array) {
            check_parts(info, messages)?;
        }
        normalize_parts(info.provider, body)?;
        return Ok(());
    }
    let object = body.as_object_mut().ok_or(adapt_error(
        "invalid_request",
        "request body must be a JSON object",
    ))?;
    for field in forbidden_fields(info.provider) {
        object.remove(*field);
    }
    let model = if endpoint == "embeddings" {
        if !info.tasks.iter().any(|task| task == "embed") && info.embedding_model.is_none() {
            return Err(adapt_error(
                "unsupported_task",
                task_refusal(info, "embeddings"),
            ));
        }
        info.embedding_model.clone().ok_or_else(|| adapt_error("unsupported_task", "Configure an embedding model or route embeddings to a pooling session; the chat model is not an embedding target."))?
    } else {
        info.request_lora
            .clone()
            .unwrap_or_else(|| info.upstream_model.clone())
    };
    check_tools(info, object)?;
    object.insert("model".into(), Value::String(model));
    if endpoint != "embeddings" {
        for (key, value) in &info.request_fields {
            object.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        check_parts(info, messages)?;
    }
    normalize_parts(info.provider, body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(provider: ProviderId, modalities: Modalities) -> EngineInfo {
        EngineInfo {
            provider,
            runtime_id: "managed-x".into(),
            runtime_variant: String::new(),
            speech_model_type: None,
            upstream_model: "/models/qwen-vl".into(),
            modalities,
            tasks: vec!["generate".into()],
            request_fields: json!({"temperature": 0.3}).as_object().unwrap().clone(),
            request_lora: None,
            embedding_model: Some("/models/embedding".into()),
            embedding_namespace: None,
            tools_auto: true,
            tool_parser: true,
        }
    }

    #[test]
    fn llama_requests_are_forwarded_unchanged() {
        let mut body = json!({"model":"whatever.gguf","messages":[{"role":"user","content":"Hello"}],"id_slot":1});
        let before = body.clone();
        adapt_request(
            &EngineInfo::llama("m", Modalities::text_only()),
            "chat/completions",
            &mut body,
        )
        .unwrap();
        assert_eq!(body, before);
    }

    #[test]
    fn aliases_resolve_to_upstream_ids_and_defaults_fill_absent_fields() {
        let mut body = json!({"model":"qwen-vl","temperature":0.9,"messages":[]});
        let mut engine = info(ProviderId::Vllm, Modalities::text_only());
        engine.request_fields.insert("top_p".into(), json!(0.8));
        adapt_request(&engine, "chat/completions", &mut body).unwrap();
        assert_eq!(body["model"], "/models/qwen-vl");
        assert_eq!(body["temperature"], 0.9);
        assert_eq!(body["top_p"], 0.8);
        engine.request_lora = Some("style".into());
        adapt_request(&engine, "chat/completions", &mut body).unwrap();
        assert_eq!(body["model"], "style");
        let mut embedding = json!({"model":"qwen-vl","input":"x"});
        adapt_request(&engine, "embeddings", &mut embedding).unwrap();
        assert_eq!(embedding["model"], "/models/embedding");
        assert!(embedding.get("temperature").is_none());
    }

    #[test]
    fn clients_cannot_load_other_files_through_mlx_request_fields() {
        let mut body = json!({"model":"x","adapter_path":"/etc","model_dir":["/"],"messages":[]});
        adapt_request(
            &info(ProviderId::MlxVlm, Modalities::text_only()),
            "chat/completions",
            &mut body,
        )
        .unwrap();
        assert!(body.get("adapter_path").is_none());
        assert!(body.get("model_dir").is_none());
        assert_eq!(body["model"], "/models/qwen-vl");
    }

    #[test]
    fn unsupported_inputs_are_refused_not_dropped() {
        let image = json!({"messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]});
        let mut text_only = image.clone();
        let error = adapt_request(
            &info(ProviderId::Vllm, Modalities::text_only()),
            "chat/completions",
            &mut text_only,
        )
        .unwrap_err();
        assert_eq!(error.code, "unsupported_input");
        assert!(error.message.contains("image"));
        let vision = Modalities {
            text: true,
            image: true,
            audio: false,
            video: true,
        };
        let mut accepted = image.clone();
        adapt_request(
            &info(ProviderId::Vllm, vision),
            "chat/completions",
            &mut accepted,
        )
        .unwrap();
        let mut video = json!({"messages":[{"role":"user","content":[{"type":"video_url","video_url":{"url":"data:video/mp4;base64,AA=="}}]}]});
        let error = adapt_request(
            &info(ProviderId::MlxVlm, vision),
            "chat/completions",
            &mut video,
        )
        .unwrap_err();
        assert!(error.message.contains("data URLs"));
        let mut unknown =
            json!({"messages":[{"role":"user","content":[{"type":"file","file":{}}]}]});
        assert_eq!(
            adapt_request(
                &info(ProviderId::Vllm, vision),
                "chat/completions",
                &mut unknown
            )
            .unwrap_err()
            .code,
            "unsupported_content"
        );
    }

    fn chat(part: Value) -> Value {
        json!({"messages":[{"role":"user","content":[{"type":"text","text":"hi"}, part]}]})
    }

    fn all_inputs() -> Modalities {
        Modalities {
            text: true,
            image: true,
            audio: true,
            video: true,
        }
    }

    #[test]
    fn media_references_must_be_matching_data_uris_or_remote_urls() {
        let engine = info(ProviderId::Vllm, all_inputs());
        for (part, code) in [
            (
                json!({"type":"image_url","image_url":{"url":"data:video/mp4;base64,AA=="}}),
                "invalid_media",
            ),
            (
                json!({"type":"image_url","image_url":{"url":"data:image/png,AA=="}}),
                "invalid_media",
            ),
            (
                json!({"type":"image_url","image_url":{"url":"data:image/png;base64,***"}}),
                "invalid_media",
            ),
            (
                json!({"type":"image_url","image_url":{"url":"file:///etc/passwd"}}),
                "untrusted_media_path",
            ),
            (
                json!({"type":"image_url","image_url":{"url":"/home/user/secret.png"}}),
                "untrusted_media_path",
            ),
            (
                json!({"type":"video_url","video_url":{"url":"C:\\Users\\x\\clip.mp4"}}),
                "untrusted_media_path",
            ),
            (
                json!({"type":"audio_url","audio_url":{"url":"file:///tmp/a.wav"}}),
                "untrusted_media_path",
            ),
            (json!({"type":"image_url","image_url":{}}), "invalid_media"),
            (
                json!({"type":"image","image":"https://example.com/a.png"}),
                "unsupported_content",
            ),
            (
                json!({"type":"image_embeds","image_embeds":"AA=="}),
                "unsupported_content",
            ),
        ] {
            let mut body = chat(part.clone());
            assert_eq!(
                adapt_request(&engine, "chat/completions", &mut body)
                    .unwrap_err()
                    .code,
                code,
                "{part}"
            );
        }
        for part in [
            json!({"type":"image_url","image_url":{"url":"https://example.com/a.png"}}),
            json!({"type":"input_image","image_url":"data:image/png;base64,AA=="}),
            json!({"type":"video_url","video_url":{"url":"data:video/mp4;base64,AA=="}}),
        ] {
            let mut body = chat(part.clone());
            adapt_request(&engine, "chat/completions", &mut body)
                .unwrap_or_else(|error| panic!("{part}: {error:?}"));
        }
        let five = json!({"messages":[{"role":"user","content":(0..5).map(|_| json!({"type":"image_url","image_url":{"url":"https://example.com/a.png"}})).collect::<Vec<_>>()}]});
        assert_eq!(
            adapt_request(&engine, "chat/completions", &mut five.clone())
                .unwrap_err()
                .code,
            "media_limit"
        );
    }

    #[test]
    fn audio_parts_are_rewritten_into_each_servers_spelling() {
        let uri = "data:audio/wav;base64,AA==";
        // vLLM wraps input_audio.data itself, so a URI travels as audio_url.
        let mut body =
            chat(json!({"type":"input_audio","input_audio":{"data":uri,"format":"wav"}}));
        adapt_request(
            &info(ProviderId::Vllm, all_inputs()),
            "chat/completions",
            &mut body,
        )
        .unwrap();
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({"type":"audio_url","audio_url":{"url":uri}})
        );
        let mut bare = chat(json!({"type":"input_audio","input_audio":{"data":"AA=="}}));
        assert_eq!(
            adapt_request(
                &info(ProviderId::Vllm, all_inputs()),
                "chat/completions",
                &mut bare
            )
            .unwrap_err()
            .code,
            "invalid_audio"
        );
        let mut bare =
            chat(json!({"type":"input_audio","input_audio":{"data":"AA==","format":"mp3"}}));
        adapt_request(
            &info(ProviderId::Vllm, all_inputs()),
            "chat/completions",
            &mut bare,
        )
        .unwrap();
        assert_eq!(
            bare["messages"][0]["content"][1]["input_audio"]["data"],
            "AA=="
        );
        // llama.cpp reads bare base64 with a format.
        let mut body =
            chat(json!({"type":"audio_url","audio_url":{"url":"data:audio/mpeg;base64,AA=="}}));
        adapt_request(
            &EngineInfo::llama("m", all_inputs()),
            "chat/completions",
            &mut body,
        )
        .unwrap();
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({"type":"input_audio","input_audio":{"data":"AA==","format":"mp3"}})
        );
        // mlx-vlm would read bare text that looks like a path as a file.
        let mut body =
            chat(json!({"type":"input_audio","input_audio":{"data":"AA==","format":"flac"}}));
        adapt_request(
            &info(ProviderId::MlxVlm, all_inputs()),
            "chat/completions",
            &mut body,
        )
        .unwrap();
        assert_eq!(
            body["messages"][0]["content"][1]["input_audio"]["data"],
            "data:audio/flac;base64,AA=="
        );
        let mut path = chat(
            json!({"type":"input_audio","input_audio":{"data":"/etc/hosts.wav","format":"wav"}}),
        );
        assert_eq!(
            adapt_request(
                &info(ProviderId::MlxVlm, all_inputs()),
                "chat/completions",
                &mut path
            )
            .unwrap_err()
            .code,
            "invalid_media"
        );
    }

    #[test]
    fn llama_receives_only_the_part_types_it_parses() {
        let mut body = json!({"messages":[{"role":"user","content":[
            {"type":"input_text","text":"describe"},
            {"type":"input_image","image_url":"data:image/png;base64,AA=="}
        ]}]});
        adapt_request(
            &EngineInfo::llama("m", all_inputs()),
            "chat/completions",
            &mut body,
        )
        .unwrap();
        assert_eq!(
            body["messages"][0]["content"],
            json!([
                {"type":"text","text":"describe"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}
            ])
        );
    }

    #[test]
    fn capability_errors_name_the_provider_and_the_missing_input() {
        for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
            let mut body =
                chat(json!({"type":"input_audio","input_audio":{"data":"AA==","format":"wav"}}));
            let error = adapt_request(
                &info(provider, Modalities::text_only()),
                "chat/completions",
                &mut body,
            )
            .unwrap_err();
            assert_eq!(error.code, "unsupported_input");
            assert!(error.message.contains(provider.server()) && error.message.contains("audio"));
        }
        let mut body =
            chat(json!({"type":"video_url","video_url":{"url":"https://example.com/v.mp4"}}));
        let error = adapt_request(
            &EngineInfo::llama(
                "m",
                Modalities {
                    text: true,
                    image: true,
                    audio: false,
                    video: false,
                },
            ),
            "chat/completions",
            &mut body,
        )
        .unwrap_err();
        assert!(error.message.contains("llama-server") && error.message.contains("video"));
    }

    #[test]
    fn tasks_route_chat_and_embeddings_to_the_session_that_serves_them() {
        let mut pooling = info(ProviderId::Vllm, Modalities::text_only());
        pooling.tasks = vec!["embed".into()];
        pooling.embedding_model = Some("served".into());
        let mut body = json!({"messages":[{"role":"user","content":"hi"}]});
        assert_eq!(
            adapt_request(&pooling, "chat/completions", &mut body)
                .unwrap_err()
                .code,
            "unsupported_task"
        );
        let mut embedding = json!({"model":"alias","input":["a","b"]});
        adapt_request(&pooling, "embeddings", &mut embedding).unwrap();
        assert_eq!(embedding["model"], "served");
        let mut generation = info(ProviderId::Vllm, Modalities::text_only());
        generation.embedding_model = None;
        let mut embedding = json!({"model":"alias","input":"a"});
        assert_eq!(
            adapt_request(&generation, "embeddings", &mut embedding)
                .unwrap_err()
                .code,
            "unsupported_task"
        );
        let mut image =
            json!({"input":[{"type":"image_url","image_url":{"url":"https://example.com/a.png"}}]});
        assert_eq!(
            adapt_request(&pooling, "embeddings", &mut image)
                .unwrap_err()
                .code,
            "unsupported_input"
        );
    }

    #[test]
    fn vllm_tool_choices_need_the_parser_settings_vllm_requires() {
        let tools = json!([{"type":"function","function":{"name":"f","parameters":{}}}]);
        let mut engine = info(ProviderId::Vllm, Modalities::text_only());
        engine.tools_auto = false;
        engine.tool_parser = false;
        let request = |choice: Option<Value>| {
            let mut body = json!({"messages":[], "tools": tools.clone()});
            if let Some(choice) = choice {
                body["tool_choice"] = choice;
            }
            body
        };
        let named = json!({"type":"function","function":{"name":"f"}});
        assert!(adapt_request(
            &engine,
            "chat/completions",
            &mut request(Some(json!("none")))
        )
        .is_ok());
        for choice in [
            None,
            Some(json!("auto")),
            Some(json!("required")),
            Some(named.clone()),
        ] {
            assert_eq!(
                adapt_request(&engine, "chat/completions", &mut request(choice))
                    .unwrap_err()
                    .code,
                "tool_parser_required"
            );
        }
        engine.tool_parser = true;
        assert!(adapt_request(
            &engine,
            "chat/completions",
            &mut request(Some(json!("required")))
        )
        .is_ok());
        assert!(adapt_request(&engine, "chat/completions", &mut request(Some(named))).is_ok());
        assert!(adapt_request(&engine, "chat/completions", &mut request(None)).is_err());
        engine.tools_auto = true;
        assert!(adapt_request(&engine, "chat/completions", &mut request(None)).is_ok());
        // Other providers parse tools themselves.
        let mut mlx = info(ProviderId::MlxVlm, Modalities::text_only());
        mlx.tools_auto = false;
        assert!(adapt_request(&mlx, "chat/completions", &mut request(None)).is_ok());
    }

    fn stt_info(tasks: &[&str]) -> EngineInfo {
        let mut engine = info(ProviderId::Vllm, Modalities::default());
        engine.tasks = tasks.iter().map(|task| task.to_string()).collect();
        engine.embedding_model = None;
        engine
    }

    #[test]
    fn transcription_sessions_serve_audio_and_refuse_chat_as_speech_to_text() {
        // Whisper serves both transcription and translation.
        let whisper = stt_info(&["transcription", "translate"]);
        let mut body = json!({"model": "public", "language": "en", "response_format": "json", "temperature": "0.0"});
        adapt_request(&whisper, "audio/transcriptions", &mut body).unwrap();
        assert_eq!(body["model"], "/models/qwen-vl");
        let mut body = json!({"model": "public"});
        adapt_request(&whisper, "audio/translations", &mut body).unwrap();
        assert_eq!(body["model"], "/models/qwen-vl");
        // Qwen3-ASR serves transcriptions only.
        let asr = stt_info(&["transcription"]);
        let mut body = json!({"model": "public"});
        adapt_request(&asr, "audio/transcriptions", &mut body).unwrap();
        let error = adapt_request(&asr, "audio/translations", &mut body.clone()).unwrap_err();
        assert_eq!(error.code, "unsupported_task");
        assert!(
            error.message.contains("speech-to-text") || error.message.contains("transcription")
        );
        // Chat on an STT session is refused as speech-to-text, never as embeddings.
        let mut chat = json!({"messages": [{"role": "user", "content": "hi"}]});
        let error = adapt_request(&asr, "chat/completions", &mut chat).unwrap_err();
        assert_eq!(error.code, "unsupported_task");
        assert!(error.message.contains("speech-to-text"));
        assert!(!error.message.contains("embeddings"));
        // Embeddings on an STT session are refused as speech-to-text too.
        let mut embedding = json!({"model": "public", "input": "hi"});
        let error = adapt_request(&asr, "embeddings", &mut embedding).unwrap_err();
        assert_eq!(error.code, "unsupported_task");
        assert!(error.message.contains("speech-to-text"));
        // Generation sessions cannot transcribe.
        let mut body = json!({"model": "public"});
        let error = adapt_request(
            &info(ProviderId::Vllm, Modalities::text_only()),
            "audio/transcriptions",
            &mut body,
        )
        .unwrap_err();
        assert_eq!(error.code, "unsupported_task");
        assert!(
            error.message.contains("speech-to-text") || error.message.contains("transcription")
        );
    }

    #[test]
    fn transcription_fields_are_validated_and_aliases_rewritten() {
        let whisper = stt_info(&["transcription", "translate"]);
        // response_format allowlist.
        let mut body = json!({"model": "public", "response_format": "srt"});
        assert_eq!(
            adapt_request(&whisper, "audio/transcriptions", &mut body)
                .unwrap_err()
                .code,
            "invalid_audio"
        );
        // Numeric fields must parse.
        let mut body = json!({"model": "public", "temperature": "warm"});
        assert_eq!(
            adapt_request(&whisper, "audio/transcriptions", &mut body)
                .unwrap_err()
                .code,
            "invalid_audio"
        );
        let mut body = json!({"model": "public", "top_k": "many"});
        assert_eq!(
            adapt_request(&whisper, "audio/transcriptions", &mut body)
                .unwrap_err()
                .code,
            "invalid_audio"
        );
        // logit_bias/min_tokens are rejected for every Metal STT request.
        for forbidden in ["logit_bias", "min_tokens", "stream"] {
            let mut body = json!({"model": "public"});
            body[forbidden] = json!("0");
            assert_eq!(
                adapt_request(&whisper, "audio/transcriptions", &mut body)
                    .unwrap_err()
                    .code,
                "unsupported_field",
                "{forbidden}"
            );
        }
        // Unknown fields are rejected, not dropped.
        let mut body = json!({"model": "public", "audio_url": "https://example.com/a.wav"});
        assert_eq!(
            adapt_request(&whisper, "audio/transcriptions", &mut body)
                .unwrap_err()
                .code,
            "unsupported_field"
        );
        // Binary file must not travel as a text field.
        let mut body = json!({"model": "public", "file": "clip.wav"});
        assert_eq!(
            adapt_request(&whisper, "audio/transcriptions", &mut body)
                .unwrap_err()
                .code,
            "invalid_audio"
        );
        // Translations reject language; transcriptions accept it.
        let mut body = json!({"model": "public", "language": "en"});
        assert_eq!(
            adapt_request(&whisper, "audio/translations", &mut body)
                .unwrap_err()
                .code,
            "unsupported_field"
        );
        let mut body = json!({"model": "public", "language": "en"});
        adapt_request(&whisper, "audio/transcriptions", &mut body).unwrap();
        // Repeated timestamp fields travel as an array.
        let mut body = json!({"model": "public", "timestamp_granularities": ["word", "segment"]});
        adapt_request(&whisper, "audio/transcriptions", &mut body).unwrap();
        let mut body = json!({"model": "public", "timestamp_granularities": "word"});
        assert_eq!(
            adapt_request(&whisper, "audio/transcriptions", &mut body)
                .unwrap_err()
                .code,
            "invalid_audio"
        );
    }

    #[test]
    fn metal_speech_rejects_ignored_fields_and_invalid_numeric_ranges() {
        let mut metal = stt_info(&["transcription"]);
        metal.runtime_variant = "vllm-metal".into();
        metal.speech_model_type = Some("qwen3_asr".into());
        for field in [
            json!({"language":"en"}),
            json!({"prompt":"words"}),
            json!({"temperature":"0.5"}),
        ] {
            let mut body = field;
            assert_eq!(
                adapt_request(&metal, "audio/transcriptions", &mut body)
                    .unwrap_err()
                    .code,
                "unsupported_field"
            );
        }
        let standard = stt_info(&["transcription"]);
        for field in [
            json!({"temperature":""}),
            json!({"temperature":"NaN"}),
            json!({"top_p":"2"}),
            json!({"max_completion_tokens":"0"}),
            json!({"timestamp_granularities":["invented"]}),
        ] {
            let mut body = field;
            assert_eq!(
                adapt_request(&standard, "audio/transcriptions", &mut body)
                    .unwrap_err()
                    .code,
                "invalid_audio"
            );
        }
        adapt_request(
            &metal,
            "audio/transcriptions",
            &mut json!({"temperature":"0"}),
        )
        .unwrap();
    }
}
