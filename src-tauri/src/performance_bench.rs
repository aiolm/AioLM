//! Client-observed OpenAI chat serving measurements on an isolated adapter launch.
//!
//! Cold Prompt `openai-chat-serving@5` uses one normal isolated launch, then
//! distinct run/point/slot user prompts without workload warmup. Early completion
//! and missing token usage are valid observations.
//! Requests use a five-minute, 8 MiB budget and runs have a 30-minute limit.
//! Output is counted while streaming and never retained or preallocated.
mod corpus;
mod protocol;

use crate::benchmark::provenance::{ServingBenchmarkProvenance, ServingInput, ServingWorkload};
use crate::providers::protocol::{EngineInfo, RequestDefaultsPolicy, ServingMemoryScope};
use crate::{
    config::AppConfig, error::AppError, gpu::ResolvedGpu, performance_memory::PeakMemorySampler,
    server,
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

/// Wall-clock budget for an entire run, including launch.
const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Fresh user-prompt inputs without measured-workload warmup.
pub const METHOD_VERSION: u32 = 5;
pub const MAX_SERVING_OUTPUT_TOKENS: u32 = 128;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServingMethod {
    pub id: String,
    pub version: u32,
}

/// The method every new execution uses.
impl Default for ServingMethod {
    fn default() -> Self {
        Self {
            id: "openai-chat-serving".into(),
            version: METHOD_VERSION,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceBenchRequest {
    pub run_id: String,
    pub method: ServingMethod,
    pub context_profile: String,
    pub prompt_bytes: Vec<u32>,
    pub max_output_tokens: u32,
    pub concurrencies: Vec<u32>,
    pub repetitions: u32,
    pub warmup: bool,
    pub request_usage: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceBenchRow {
    pub id: String,
    pub input_bytes: u32,
    pub max_output_tokens: u32,
    pub concurrency: u32,
    pub repetition: u32,
    pub first_output_ms: Option<f64>,
    /// Digests of the actual user prompts, in launch-slot order.
    pub input_sha256_by_request: Vec<String>,
    pub e2e_ms: f64,
    pub output_bytes: u64,
    pub reported_prompt_tokens: Option<u64>,
    pub reported_completion_tokens: Option<u64>,
    pub prefill_tokens_per_second: Option<f64>,
    pub decode_tokens_per_second: Option<f64>,
    pub tpot_ms: Option<f64>,
    pub usage_status: String,
    pub finish_reasons: Vec<String>,
    pub peak_memory_bytes: Option<u64>,
    pub timing_source: String,
    pub failed: bool,
    pub error: Option<String>,
}

impl PerformanceBenchRow {
    pub(crate) fn validate(&self) -> bool {
        let time = |value: f64| value.is_finite() && value >= 0.0;
        let positive = |value: f64| value.is_finite() && value > 0.0;
        let counter = |value: Option<u64>| value.is_none_or(|n| n <= MAX_SAFE_INTEGER);
        let known = [self.reported_prompt_tokens, self.reported_completion_tokens];
        !self.id.is_empty()
            && self.id.len() <= 256
            && (256..=1048576).contains(&self.input_bytes)
            && (1..=MAX_SERVING_OUTPUT_TOKENS).contains(&self.max_output_tokens)
            && (1..=64).contains(&self.concurrency)
            && (1..=100).contains(&self.repetition)
            && time(self.e2e_ms)
            && self.first_output_ms.is_none_or(time)
            && self.prefill_tokens_per_second.is_none_or(time)
            && self.decode_tokens_per_second.is_none_or(positive)
            && self.tpot_ms.is_none_or(positive)
            && (self.first_output_ms.is_some()
                || [
                    self.prefill_tokens_per_second,
                    self.decode_tokens_per_second,
                    self.tpot_ms,
                ]
                .iter()
                .all(Option::is_none))
            && (self.reported_prompt_tokens.is_some() || self.prefill_tokens_per_second.is_none())
            && (self.reported_completion_tokens.is_some()
                || (self.decode_tokens_per_second.is_none() && self.tpot_ms.is_none()))
            && self.output_bytes <= MAX_SAFE_INTEGER
            && (self.output_bytes != 0 || self.first_output_ms.is_none())
            && counter(self.reported_prompt_tokens)
            && counter(self.reported_completion_tokens)
            && self.input_sha256_by_request.len() == self.concurrency as usize
            && self
                .input_sha256_by_request
                .iter()
                .enumerate()
                .all(|(index, hash)| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        && !self.input_sha256_by_request[..index].contains(hash)
                })
            && match self.usage_status.as_str() {
                "complete" => known.iter().all(Option::is_some),
                "partial" => known.iter().any(Option::is_none),
                "missing" | "invalid" => known.iter().all(Option::is_none),
                _ => false,
            }
            && self.finish_reasons.len() == self.concurrency as usize
            && self.finish_reasons.iter().all(|v| {
                [
                    "stop",
                    "length",
                    "content_filter",
                    "tool_calls",
                    "other",
                    "not_reported",
                ]
                .contains(&v.as_str())
            })
            && counter(self.peak_memory_bytes)
            && self.timing_source == "client"
            && !self.failed
            && self.error.is_none()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PerformanceBenchResult {
    pub run_id: String,
    pub rows: Vec<PerformanceBenchRow>,
    pub status: &'static str,
    pub message: Option<String>,
    /// Private sanitized final program and argv, never public settings.
    pub args: Vec<String>,
    /// Private sanitized inference engine command when AioLM launches the
    /// engine through its automatic helper; never included in public snapshots.
    /// The helper chooses the engine's port itself, so a port binding is
    /// recorded as `{port}` rather than as a port the engine never used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_args: Option<Vec<String>>,
    /// Why a helper run's engine command could not be recorded. The
    /// measurement continues without it; records made before engine commands
    /// were recorded have neither field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_args_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provenance: Option<ServingBenchmarkProvenance>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PerformanceBenchProgress {
    pub run_id: String,
    pub phase: &'static str,
    pub completed: usize,
    pub total: usize,
    pub row: Option<PerformanceBenchRow>,
    pub message: Option<String>,
}
pub type Progress = Arc<dyn Fn(PerformanceBenchProgress) + Send + Sync>;

pub fn validate_request(request: &mut PerformanceBenchRequest) -> Result<(), String> {
    if request.run_id.is_empty() || request.run_id.len() > 128 {
        return Err("benchmark run_id must contain 1 to 128 bytes".into());
    }
    if request.method.id != "openai-chat-serving" || request.method.version != METHOD_VERSION {
        return Err("unsupported benchmark method".into());
    }
    if ![
        "code_python",
        "code_mixed",
        "novel_ko",
        "novel_en",
        "novel_ja",
    ]
    .contains(&request.context_profile.as_str())
    {
        return Err("unknown benchmark context profile".into());
    }
    if request.prompt_bytes.is_empty()
        || request.prompt_bytes.len() > 64
        || request
            .prompt_bytes
            .iter()
            .any(|n| !(256..=1048576).contains(n))
    {
        return Err("select 1 to 64 input sizes between 256 and 1048576 UTF-8 bytes".into());
    }
    if request.concurrencies.is_empty()
        || request.concurrencies.len() > 64
        || request.concurrencies.iter().any(|n| !(1..=64).contains(n))
    {
        return Err("select 1 to 64 concurrencies between 1 and 64".into());
    }
    if !(1..=100).contains(&request.repetitions) {
        return Err("repetitions must be 1 to 100".into());
    }
    if !(1..=MAX_SERVING_OUTPUT_TOKENS).contains(&request.max_output_tokens) {
        return Err("maximum output tokens must be 1 to 128".into());
    }
    if request.warmup {
        return Err("Cold Prompt benchmarks do not warm up measured prompts".into());
    }
    // Reject duplicate points rather than silently changing the requested workload.
    request.prompt_bytes.sort_unstable();
    request.concurrencies.sort_unstable();
    if request.prompt_bytes.windows(2).any(|p| p[0] == p[1])
        || request.concurrencies.windows(2).any(|p| p[0] == p[1])
        || request.prompt_bytes.len() * request.concurrencies.len() > 64
    {
        return Err("select at most 64 unique input/concurrency operating points".into());
    }
    Ok(())
}

/// Admission and execution share the single benchmark request contract.
pub fn validate_execution_request(request: &mut PerformanceBenchRequest) -> Result<(), String> {
    validate_request(request)
}

/// Desktop product policy for runs started from the app: one sample per
/// input/concurrency point at a 128-token output cap, with at most 8 concurrent
/// requests. Recorded history and the engine-level runner keep the wider
/// protocol bounds of the shared contract.
pub const DESKTOP_OUTPUT_TOKENS: u32 = 128;
pub const DESKTOP_MAX_CONCURRENCY: u32 = 8;

pub fn validate_desktop_request(request: &mut PerformanceBenchRequest) -> Result<(), String> {
    validate_execution_request(request)?;
    if request.max_output_tokens != DESKTOP_OUTPUT_TOKENS {
        return Err("desktop benchmarks use a 128-token output cap".into());
    }
    if request.repetitions != 1 {
        return Err("desktop benchmarks measure each input/concurrency point once".into());
    }
    if request
        .concurrencies
        .iter()
        .any(|n| *n > DESKTOP_MAX_CONCURRENCY)
    {
        return Err("desktop benchmarks allow at most 8 concurrent requests".into());
    }
    Ok(())
}

/// Read-only admission from the selected model/runtime's existing probe metadata.
/// This never refreshes an adapter, loads a model, or captures benchmark identity.
#[derive(Debug, Serialize)]
pub struct BenchmarkAdmission {
    pub status: &'static str,
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub async fn admission(
    mut cfg: AppConfig,
    mut request: PerformanceBenchRequest,
) -> BenchmarkAdmission {
    let unknown = |detail| BenchmarkAdmission {
        status: "unknown",
        reason: "configuration",
        detail: Some(detail),
    };
    if let Err(error) = validate_desktop_request(&mut request) {
        return unknown(error);
    }
    if let Err(error) = crate::launch_validation::validate_start_config(&mut cfg) {
        return unknown(error.into());
    }
    let engine = match crate::providers::execution::probed_info(&cfg).await {
        Ok(engine) => engine,
        Err(error) => return unknown(error),
    };
    engine_admission(&engine, &effective_request(&engine, &request))
}

/// Standard OpenAI streamed usage is requested unless the runtime explicitly
/// declares that it rejects `stream_options`; unknown support is attempted.
fn effective_request(
    engine: &EngineInfo,
    request: &PerformanceBenchRequest,
) -> PerformanceBenchRequest {
    let mut effective = request.clone();
    effective.request_usage = request.request_usage && engine.stream_usage_supported != Some(false);
    effective
}

fn engine_admission(engine: &EngineInfo, request: &PerformanceBenchRequest) -> BenchmarkAdmission {
    let unsupported = |reason, detail| BenchmarkAdmission {
        status: "unsupported",
        reason,
        detail: Some(detail),
    };
    match point_body(engine, String::new(), request) {
        Ok(_) => BenchmarkAdmission {
            status: "supported",
            reason: "ready",
            detail: None,
        },
        Err(error) => unsupported("request", error),
    }
}

pub fn failed(
    request: &PerformanceBenchRequest,
    _cfg: &AppConfig,
    message: String,
) -> PerformanceBenchResult {
    PerformanceBenchResult {
        run_id: request.run_id.clone(),
        rows: vec![],
        status: "failed",
        message: Some(message),
        args: vec![],
        engine_args: None,
        engine_args_error: None,
        provenance: None,
    }
}

fn isolated_config(cfg: &AppConfig, port: u16) -> AppConfig {
    let mut isolated = cfg.clone();
    isolated.port = port;
    isolated
}

// Preserve argv length and positions so typed occurrence capture can align raw
// option identities with sanitized values without ever retaining raw values.
fn redacted_args(args: Vec<String>) -> Vec<String> {
    let mut hide_next = false;
    args.into_iter()
        .map(|argument| {
            if hide_next {
                hide_next = false;
                return "[redacted]".into();
            }
            let name = argument.split('=').next().unwrap_or(&argument);
            if ["--api-key", "--api-key-file", "--hf-token", "-hft"].contains(&name) {
                if argument.contains('=') {
                    return format!("{name}=[redacted]");
                }
                hide_next = true;
            }
            argument
        })
        .collect()
}

/// Strip recognized Windows verbatim path prefixes (`\\?\`, `\\?\UNC\`) before
/// applying launch-option redaction. Preserves 1:1 token correspondence between
/// `raw` and `masked` so benchmark settings capture remains aligned.
fn sanitize_captured_argv(
    registry_root: &std::path::Path,
    isolated: &AppConfig,
    program: &std::path::Path,
    args: &[String],
) -> (Vec<String>, Vec<String>) {
    let argv: Vec<String> = std::iter::once(
        crate::verbatim_path::strip_windows_verbatim_prefix_str(program.to_string_lossy().as_ref())
            .into_owned(),
    )
    .chain(
        args.iter()
            .map(|arg| crate::verbatim_path::strip_windows_verbatim_prefix_arg(arg).into_owned()),
    )
    .collect();
    let masked = crate::providers::runtime_schema::mask_argv(
        registry_root,
        isolated,
        redacted_args(argv.clone()),
        "[redacted]",
    );
    (argv, masked)
}

/// `Ok(None)` when AioLM runs the engine's own command (no helper). An error
/// is a helper run whose engine command could not be rebuilt; the caller
/// records the reason and the measurement continues.
fn capture_engine_args_for_manifest(
    registry_root: &std::path::Path,
    isolated: &AppConfig,
    manifest: &crate::providers::registry::RuntimeManifest,
) -> Result<Option<Vec<String>>, AppError> {
    let Some(engine_argv) =
        crate::providers::runtime_auto::engine_command_record(registry_root, isolated, manifest)?
    else {
        return Ok(None);
    };
    Ok(Some(crate::providers::runtime_schema::mask_argv(
        registry_root,
        isolated,
        redacted_args(engine_argv),
        "[redacted]",
    )))
}

fn capture_engine_args(
    registry_root: &std::path::Path,
    isolated: &AppConfig,
) -> Result<Option<Vec<String>>, AppError> {
    let provider = crate::providers::provider_of(isolated);
    if !provider.is_custom() {
        return Ok(None);
    }
    let manifest = crate::providers::registry::manifest(provider, &isolated.active_runtime)?;
    capture_engine_args_for_manifest(registry_root, isolated, &manifest)
}

/// Stores the captured engine command, or the reason it is missing, on the
/// result; the returned warning follows the launch-settings warning path.
fn record_engine_args(
    result: &mut PerformanceBenchResult,
    captured: Result<Option<Vec<String>>, AppError>,
) -> Option<String> {
    match captured {
        Ok(engine_args) => {
            result.engine_args = engine_args;
            result.engine_args_error = None;
            None
        }
        Err(error) => {
            result.engine_args = None;
            result.engine_args_error = Some(error.message.clone());
            Some(format!(
                "The inference engine command was not recorded; serving measurement continues: {}",
                error.message
            ))
        }
    }
}

struct IsolatedServer {
    state: Arc<Mutex<server::ServerState>>,
    key_file: Option<PathBuf>,
    active_process: Arc<Mutex<Option<crate::procutil::ProcessHandle>>>,
}
impl Drop for IsolatedServer {
    fn drop(&mut self) {
        *self
            .active_process
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        server::kill(&mut state.child, None);
        server::cleanup_api_key_file(self.key_file.as_deref());
    }
}

fn emit(
    progress: &Progress,
    request: &PerformanceBenchRequest,
    phase: &'static str,
    completed: usize,
    row: Option<PerformanceBenchRow>,
    message: Option<String>,
) {
    progress(PerformanceBenchProgress {
        run_id: request.run_id.clone(),
        phase,
        completed,
        total: request.prompt_bytes.len()
            * request.concurrencies.len()
            * request.repetitions as usize,
        row,
        message,
    });
}

/// Every request must have emitted the channel for its mean latency to be known.
fn channel_mean(
    measurements: &[protocol::Measurement],
    field: impl Fn(&protocol::Measurement) -> Option<f64>,
) -> Option<f64> {
    let sum = measurements
        .iter()
        .try_fold(0.0, |sum, m| field(m).map(|value| sum + value))?;
    (!measurements.is_empty())
        .then(|| sum / measurements.len() as f64)
        .filter(|n| n.is_finite())
}

fn aggregate(
    request: &PerformanceBenchRequest,
    (input_bytes, concurrency, repetition): (u32, u32, u32),
    started: Instant,
    measurements: &[protocol::Measurement],
    peak_memory_bytes: Option<u64>,
) -> PerformanceBenchRow {
    let sum = |field: fn(&protocol::Measurement) -> Option<u64>| -> Result<Option<u64>, ()> {
        // Check even the known subset: a missing request must not hide overflow.
        let mut total = 0u64;
        let mut known = true;
        for measurement in measurements {
            match field(measurement) {
                Some(value) => {
                    total = total
                        .checked_add(value)
                        .filter(|n| *n <= MAX_SAFE_INTEGER)
                        .ok_or(())?;
                }
                None => known = false,
            }
        }
        Ok(known.then_some(total))
    };
    let prompt = sum(|m| m.reported_prompt_tokens);
    let completion = sum(|m| m.reported_completion_tokens);
    let invalid = measurements.iter().any(|m| m.usage_status == "invalid")
        || prompt.is_err()
        || completion.is_err();
    let (reported_prompt_tokens, reported_completion_tokens) = if invalid {
        (None, None)
    } else {
        (prompt.unwrap(), completion.unwrap())
    };
    let usage_status = if invalid {
        "invalid"
    } else if measurements.iter().all(|m| m.usage_status == "complete") {
        "complete"
    } else if measurements.iter().all(|m| m.usage_status == "missing") {
        "missing"
    } else {
        "partial"
    };
    let (prefill_tokens_per_second, decode_tokens_per_second, tpot_ms) = if invalid {
        (None, None, None)
    } else {
        let mut prefill_total = Some(0.0);
        let mut decode_total = Some(0.0);
        let mut tpot_total = Some(0.0);
        for measurement in measurements {
            let first = measurement.first_output_ms;
            let prefill = measurement
                .reported_prompt_tokens
                .filter(|tokens| *tokens > 0)
                .zip(first.filter(|ms| *ms > 0.0))
                .map(|(tokens, ms)| 1000.0 * tokens as f64 / ms);
            let tpot = measurement
                .reported_completion_tokens
                .filter(|tokens| *tokens >= 2)
                .zip(first)
                .filter(|(_, ms)| measurement.e2e_ms > *ms)
                .map(|(tokens, ms)| (measurement.e2e_ms - ms) / (tokens - 1) as f64)
                .filter(|value| value.is_finite() && *value > 0.0);
            prefill_total = prefill_total.zip(prefill).map(|(sum, value)| sum + value);
            decode_total = decode_total
                .zip(tpot)
                .map(|(sum, value)| sum + 1000.0 / value);
            tpot_total = tpot_total.zip(tpot).map(|(sum, value)| sum + value);
        }
        let mean = |total: Option<f64>| {
            total
                .filter(|_| !measurements.is_empty())
                .map(|sum| sum / measurements.len() as f64)
                .filter(|value| value.is_finite())
        };
        (mean(prefill_total), mean(decode_total), mean(tpot_total))
    };
    let finished = measurements
        .iter()
        .map(|m| m.finished)
        .max()
        .unwrap_or(started);
    PerformanceBenchRow {
        id: format!(
            "{}-b{input_bytes}-o{}-c{concurrency}-r{repetition}",
            request.run_id, request.max_output_tokens
        ),
        input_bytes,
        max_output_tokens: request.max_output_tokens,
        concurrency,
        repetition,
        input_sha256_by_request: Vec::new(),
        first_output_ms: channel_mean(measurements, |m| m.first_output_ms),
        e2e_ms: finished.duration_since(started).as_secs_f64() * 1000.0,
        output_bytes: measurements.iter().map(|m| m.output_bytes).sum(),
        reported_prompt_tokens,
        reported_completion_tokens,
        prefill_tokens_per_second,
        decode_tokens_per_second,
        tpot_ms,
        usage_status: usage_status.into(),
        finish_reasons: measurements
            .iter()
            .map(|m| m.finish_reason.clone())
            .collect(),
        peak_memory_bytes: peak_memory_bytes.filter(|n| *n <= MAX_SAFE_INTEGER),
        timing_source: "client".into(),
        failed: false,
        error: None,
    }
}

enum BatchOutcome {
    Complete(Instant, Vec<protocol::Measurement>),
    UsageRejected(u16),
}

async fn batch(
    client: &reqwest::Client,
    requests: &[reqwest::Request],
    cancel: &AtomicBool,
    budget: protocol::Budget,
    negotiate_usage: bool,
) -> Result<BatchOutcome, AppError> {
    let started = Instant::now();
    let mut pending = FuturesUnordered::new();
    let mut rejection = None;
    let mut measurements: Vec<Option<protocol::Measurement>> =
        (0..requests.len()).map(|_| None).collect();
    for (slot, request) in requests.iter().enumerate() {
        pending.push(async move {
            (
                slot,
                protocol::request_outcome(client, request, cancel, budget, negotiate_usage).await,
            )
        });
    }
    while let Some((slot, result)) = pending.next().await {
        match result? {
            protocol::RequestOutcome::Complete(measurement) => {
                measurements[slot] = Some(measurement)
            }
            protocol::RequestOutcome::UsageRejected(status) => rejection = Some(status),
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("benchmark cancelled"));
    }
    if let Some(status) = rejection {
        if measurements.iter().any(Option::is_some) {
            return Err(AppError::unavailable(
                "the first usage batch mixed accepted streams with HTTP 400/422 rejections; it cannot be replayed",
            ));
        }
        return Ok(BatchOutcome::UsageRejected(status));
    }
    Ok(BatchOutcome::Complete(
        started,
        measurements
            .into_iter()
            .map(|m| m.expect("all launch slots completed"))
            .collect(),
    ))
}

/// Serialize a slot once, sharing its buffered body only for an all-rejected usage retry.
fn point_request(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    engine: &EngineInfo,
    text: String,
    request: &PerformanceBenchRequest,
) -> Result<reqwest::Request, String> {
    let body = point_body(engine, text, request)?;
    client
        .post(format!("{}/chat/completions", url.trim_end_matches('/')))
        .bearer_auth(key)
        .json(&body)
        .build()
        .map_err(|e| e.to_string())
}

/// Admission and execution pass through exactly the same request adapter.
fn point_body(
    engine: &EngineInfo,
    text: String,
    request: &PerformanceBenchRequest,
) -> Result<serde_json::Value, String> {
    let model = engine
        .request_lora
        .as_deref()
        .unwrap_or(&engine.upstream_model);
    let target = request.max_output_tokens;
    let mut body = serde_json::json!({"model": model, "messages": [{"role":"user"}], "temperature":0, "max_tokens":target, "stream":true});
    if request.request_usage {
        body["stream_options"] = serde_json::json!({"include_usage": true});
    }
    body["messages"][0]["content"] = serde_json::Value::String(text);
    crate::providers::protocol::adapt_request(
        engine,
        "chat/completions",
        &mut body,
        RequestDefaultsPolicy::Omit,
    )
    .map_err(|error| error.message)?;
    // The adapter must preserve the standard request without injecting defaults.
    let allowed: &[&str] = if request.request_usage {
        &[
            "model",
            "messages",
            "temperature",
            "max_tokens",
            "stream",
            "stream_options",
        ]
    } else {
        &["model", "messages", "temperature", "max_tokens", "stream"]
    };
    if !body.as_object().is_some_and(|fields| {
        fields.len() == allowed.len() && fields.keys().all(|key| allowed.contains(&key.as_str()))
    }) || body.get("max_tokens") != Some(&serde_json::json!(target))
        || body.get("temperature") != Some(&serde_json::json!(0))
        || body.get("stream") != Some(&serde_json::json!(true))
        || (request.request_usage
            && body.get("stream_options") != Some(&serde_json::json!({"include_usage": true})))
    {
        return Err("the runtime adapter did not send the standard-cap request unchanged".into());
    }
    Ok(body)
}

pub struct RuntimeInfo {
    pub(crate) engine: EngineInfo,
    pub(crate) provenance: ServingBenchmarkProvenance,
    pub(crate) input_texts: Vec<String>,
    pub(crate) checkpoint: Option<Checkpoint>,
    gpu_profile: crate::hardware::DeviceProfile,
}
impl RuntimeInfo {
    /// Preflight freezes input texts/hashes and observed runtime/model/host facts.
    /// The caller first runs the normal launch validator, exactly as for chat.
    pub async fn prepare(
        cfg: &AppConfig,
        request: &PerformanceBenchRequest,
    ) -> Result<Self, AppError> {
        let mut request = request.clone();
        validate_execution_request(&mut request).map_err(AppError::validation)?;
        let engine = crate::providers::execution::probed_info(cfg).await?;
        // The journaled request keeps the caller's intent; provenance freezes
        // what this runtime is asked to send.
        let effective = effective_request(&engine, &request);
        let admission = engine_admission(&engine, &effective);
        if admission.status != "supported" {
            return Err(AppError::unavailable(
                admission
                    .detail
                    .unwrap_or_else(|| "benchmark admission failed".into()),
            ));
        }
        let (workload, input_texts) = prepare_inputs(&effective);
        let model_path = PathBuf::from(&cfg.active_model);
        let active_model = cfg.active_model.clone();
        let root = crate::benchmark::data_root()?;
        // The frozen label is the model's display name: no directory, revision
        // hash or split-part suffix.
        let (label, model) = tokio::task::spawn_blocking(move || {
            let label = crate::model_names::resolve_display_name(&active_model);
            let mut identity = crate::benchmark::identity::capture(&root, &model_path);
            identity.metadata = crate::benchmark::model_metadata::collect(&root, &model_path);
            (label, identity)
        })
        .await
        .map_err(AppError::from)?;
        let gpu_profile = crate::hardware::detect();
        let provenance = crate::benchmark::provenance::capture_serving(
            cfg,
            &gpu_profile,
            model,
            workload,
            engine.serving_metadata.as_ref(),
            label,
        );
        provenance
            .validate(&request.context_profile)
            .map_err(AppError::validation)?;
        Ok(Self {
            engine,
            provenance,
            input_texts,
            checkpoint: None,
            gpu_profile,
        })
    }
}

pub(crate) fn prepare_inputs(request: &PerformanceBenchRequest) -> (ServingWorkload, Vec<String>) {
    let prompt_nonce = uuid::Uuid::new_v4().simple().to_string();
    let first_concurrency = request
        .concurrencies
        .iter()
        .copied()
        .min()
        .expect("validated grid");
    // Freeze one shared suffix per size, not a complete grid of per-slot payloads.
    let input_texts: Vec<_> = request
        .prompt_bytes
        .iter()
        .map(|bytes| {
            let suffix_bytes = *bytes as usize - corpus::COLD_PREFIX_BYTES;
            corpus::text(&request.context_profile, suffix_bytes)
        })
        .collect();
    let inputs = request
        .prompt_bytes
        .iter()
        .copied()
        .zip(&input_texts)
        .map(|(bytes, text)| {
            let mut hash = Sha256::new();
            hash.update(
                corpus::cold_prefix(&prompt_nonce, (bytes, first_concurrency, 1), 0).as_bytes(),
            );
            hash.update(text.as_bytes());
            ServingInput {
                bytes,
                sha256: format!("{:x}", hash.finalize()),
            }
        })
        .collect();
    (
        ServingWorkload {
            corpus: request.context_profile.clone(),
            corpus_version: 2,
            inputs,
            max_output_tokens: request.max_output_tokens,
            concurrencies: request.concurrencies.clone(),
            repetitions: request.repetitions,
            warmup: request.warmup,
            request_usage: request.request_usage,
            cache_policy: "cold_prompt".into(),
            prompt_nonce: Some(prompt_nonce),
        },
        input_texts,
    )
}

pub(crate) type Checkpoint =
    Arc<dyn Fn(&PerformanceBenchResult) -> Result<(), AppError> + Send + Sync>;

/// Only the current point's distinct slot payloads are buffered. The first
/// actual batch decides usage support for the rest of the run.
struct BufferedWorkload {
    request: PerformanceBenchRequest,
    slots: Vec<reqwest::Request>,
    input_hashes: Option<Vec<String>>,
    usage_undecided: bool,
}

impl BufferedWorkload {
    #[allow(clippy::too_many_arguments)]
    async fn measure(
        &mut self,
        client: &reqwest::Client,
        pid: u32,
        tree: Option<&crate::procutil::ProcessHandle>,
        memory_scope: ServingMemoryScope,
        cancel: &AtomicBool,
        result: &mut PerformanceBenchResult,
        checkpoint: Option<&Checkpoint>,
        progress: &Progress,
    ) -> Result<(Instant, Vec<protocol::Measurement>, Option<u64>), AppError> {
        loop {
            // Each accepted attempt owns its timer and sampler; rejected
            // negotiation latency/memory never enters the measured row.
            let sampler = match memory_scope {
                ServingMemoryScope::OwnedProcessTree if tree.is_some() => {
                    Some(PeakMemorySampler::start(pid, tree.cloned()))
                }
                ServingMemoryScope::OwnedRootProcess => Some(PeakMemorySampler::start(pid, None)),
                _ => None,
            };
            let measured = batch(
                client,
                &self.slots,
                cancel,
                protocol::Budget::default(),
                self.usage_undecided,
            )
            .await;
            let peak = sampler.and_then(PeakMemorySampler::finish);
            match measured? {
                BatchOutcome::Complete(started, measurements) => {
                    self.usage_undecided = false;
                    return Ok((started, measurements, peak));
                }
                BatchOutcome::UsageRejected(status) => {
                    self.usage_undecided = false;
                    self.request.request_usage = false;
                    let provenance = result.provenance.as_mut().expect("frozen provenance");
                    provenance.workload.request_usage = false;
                    provenance.execution.settings.retain(|setting| {
                        !(setting.target == "request"
                            && setting.name == "stream_options.include_usage")
                    });
                    // Persist the actual request policy before any resend.
                    if let Some(checkpoint) = checkpoint {
                        checkpoint(result)?;
                    }
                    emit(progress, &self.request, "loading", result.rows.len(), None, Some(format!(
                        "The runtime rejected stream_options.include_usage (HTTP {status}); token usage is not requested for this run."
                    )));
                    for buffered in &mut self.slots {
                        let bytes = buffered
                            .body()
                            .and_then(reqwest::Body::as_bytes)
                            .ok_or("benchmark request body is not buffered")?;
                        let mut body: serde_json::Value =
                            serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
                        body.as_object_mut()
                            .ok_or("benchmark request body is not an object")?
                            .remove("stream_options");
                        *buffered.body_mut() = Some(
                            serde_json::to_vec(&body)
                                .map_err(|error| error.to_string())?
                                .into(),
                        );
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn trial(
    workload: &mut BufferedWorkload,
    client: &reqwest::Client,
    point: (u32, u32, u32),
    pid: u32,
    tree: Option<&crate::procutil::ProcessHandle>,
    memory_scope: ServingMemoryScope,
    cancel: &AtomicBool,
    result: &mut PerformanceBenchResult,
    checkpoint: Option<&Checkpoint>,
    progress: &Progress,
) -> Result<(), AppError> {
    let (input_bytes, concurrency, repetition) = point;
    if workload.slots.len() != concurrency as usize
        || workload
            .input_hashes
            .as_ref()
            .is_none_or(|hashes| hashes.len() != concurrency as usize)
    {
        return Err(AppError::validation(
            "buffered slot inputs do not match the measured point",
        ));
    }
    let request = &workload.request;
    let target = request.max_output_tokens;
    let phase = if concurrency == 1 { "single" } else { "batch" };
    emit(progress,request,phase,result.rows.len(),None,Some(format!("{input_bytes} UTF-8 bytes / {target} output tokens, {concurrency} request(s), repetition {repetition}")));
    let measured = workload
        .measure(
            client,
            pid,
            tree,
            memory_scope,
            cancel,
            result,
            checkpoint,
            progress,
        )
        .await;
    let failure = |e: AppError| {
        AppError::new(
            e.kind,
            format!("point b{input_bytes}/c{concurrency}/o{target}, repetition {repetition}: {e}"),
        )
    };
    let (started, measurements, peak) = measured.map_err(failure)?;
    if cancel.load(Ordering::Acquire) {
        return Err(failure(AppError::cancelled("benchmark cancelled")));
    }
    let request = &workload.request;
    let mut row = aggregate(request, point, started, &measurements, peak);
    row.input_sha256_by_request = workload.input_hashes.take().unwrap_or_default();
    if !row.validate() {
        return Err(failure(AppError::unavailable(
            "serving observations could not be recorded",
        )));
    }
    result.rows.push(row.clone());
    if let Some(checkpoint) = checkpoint {
        checkpoint(result)?;
    }
    emit(progress, request, phase, result.rows.len(), Some(row), None);
    Ok(())
}

pub async fn run(
    cfg: AppConfig,
    mut request: PerformanceBenchRequest,
    gpu: ResolvedGpu,
    cancel: Arc<AtomicBool>,
    active_process: Arc<Mutex<Option<crate::procutil::ProcessHandle>>>,
    progress: Progress,
    runtime: RuntimeInfo,
) -> PerformanceBenchResult {
    let mut result = failed(&request, &cfg, String::new());
    if let Err(error) = validate_execution_request(&mut request) {
        result.message = Some(error);
        return result;
    }
    let RuntimeInfo {
        engine,
        provenance,
        input_texts,
        checkpoint,
        gpu_profile,
    } = runtime;
    result.provenance = Some(provenance);
    result.message = None;
    let mut managed = None;
    let mut active_point = None;
    emit(&progress, &request, "loading", 0, None, None);
    let target = request.max_output_tokens;
    let timeout_minutes = RUN_TIMEOUT.as_secs() / 60;
    let request_budget = protocol::Budget::default();
    let outcome: Result<(),AppError> = tokio::time::timeout(RUN_TIMEOUT, async {
        if cancel.load(Ordering::Acquire) { return Err(AppError::cancelled("benchmark cancelled")); }
        let provenance = result.provenance.as_ref().expect("frozen provenance");
        provenance.validate(&request.context_profile).map_err(AppError::validation)?;
        if provenance.method.id != request.method.id || provenance.method.version != request.method.version {
            return Err(AppError::validation("prepared serving method does not match the request"));
        }
        if input_texts.len() != request.prompt_bytes.len() || provenance.workload.inputs.len() != input_texts.len()
            || input_texts.iter().zip(&request.prompt_bytes).any(|(text,bytes)| text.len() + corpus::COLD_PREFIX_BYTES != *bytes as usize)
            || provenance.workload.inputs.iter().zip(&request.prompt_bytes).any(|(input,bytes)| input.bytes != *bytes)
            || provenance.workload.max_output_tokens != request.max_output_tokens || provenance.workload.concurrencies != request.concurrencies
            || provenance.workload.repetitions != request.repetitions || provenance.workload.warmup != request.warmup
            // Usage may be frozen off when the runtime declares or proves it unsupported.
            || (provenance.workload.request_usage && !request.request_usage) {
            return Err(AppError::validation("prepared serving workload does not match the request"));
        }
        let reservation = TcpListener::bind(("127.0.0.1",0)).map_err(|e| AppError::unavailable(format!("cannot reserve benchmark port: {e}")))?;
        let port = reservation.local_addr().map_err(|e| e.to_string())?.port();
        let isolated = isolated_config(&cfg,port);
        let key = format!("bench-{}",uuid::Uuid::new_v4().simple());
        let ring = Arc::new(server::ErrBuf::default());
        let mut settings_warning = None;
        let mut engine_warning = None;
        let mut capture = |program: &std::path::Path, args: &[String]| {
            let registry_root = crate::providers::registry::root();
            let (argv, masked) = sanitize_captured_argv(&registry_root, &isolated, program, args);
            result.args = masked;
            engine_warning = record_engine_args(&mut result, capture_engine_args(&registry_root, &isolated));
            let provenance = result.provenance.as_mut().expect("frozen provenance");
            provenance.environment.host.execution =
                crate::benchmark::provenance::capture_serving_gpu_execution(
                    &isolated, &gpu_profile, &gpu, args,
                );
            let request_slots = provenance.execution.settings.len();
            let captured = crate::providers::runtime_schema::effective(&registry_root, &isolated, false)
                .and_then(|effective| Ok(crate::providers::runtime_schema::capture_benchmark_settings(&effective, &argv, &result.args, request_slots)?));
            match captured {
                Ok(captured) => {
                    provenance.execution.settings.extend(captured.settings);
                    provenance.execution.settings.sort_by(|a, b| {
                        (&a.target, &a.scope, &a.name).cmp(&(&b.target, &b.scope, &b.name))
                    });
                    if captured.omitted {
                        settings_warning = Some("Some launch settings were omitted from the public snapshot.".to_owned());
                    }
                }
                Err(_) => {
                    settings_warning = Some("Launch settings are unavailable; serving measurement continues.".to_owned());
                }
            }
        };
        drop(reservation);
        let server::SpawnedServer { child,url,key_file,readiness } = server::spawn(&isolated,&key,&ring,&gpu,Some(&mut capture))?;
        let pid = child.id();
        let process_handle = child.process_handle();
        let shared = Arc::new(Mutex::new(server::ServerState::default()));
        { let mut state = shared.lock().map_err(|_| "benchmark process lock was poisoned")?; state.child = Some(child); state.engine = Some(engine); }
        managed = Some(IsolatedServer { state: shared.clone(),key_file,active_process: active_process.clone() });
        *active_process.lock().unwrap_or_else(|e| e.into_inner()) = process_handle.clone();
        for warning in [settings_warning, engine_warning].into_iter().flatten() {
            emit(&progress, &request, "loading", 0, None, Some(warning));
        }
        tokio::select! { biased;
            _ = crate::cancellation::wait_cancelled(&cancel) => return Err(AppError::cancelled("benchmark cancelled")),
            ready = server::wait_ready(shared.clone(),&url,&key,server::SERVER_START_TIMEOUT_SECS,&ring,readiness) => ready?,
        }
        let ready_engine = shared.lock().map_err(|_| "benchmark process lock was poisoned")?.engine.clone().ok_or("ready server has no engine information")?;
        let memory_scope = result.provenance.as_ref().unwrap().execution.memory_scope;
        let client = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).timeout(request_budget.timeout).build().map_err(|e| e.to_string())?;
        let mut effective = request.clone();
        effective.request_usage = result.provenance.as_ref().unwrap().workload.request_usage;
        let usage_undecided = effective.request_usage;
        if let Some(checkpoint) = &checkpoint { checkpoint(&result)?; }
        let nonce = result.provenance.as_ref().unwrap().workload.prompt_nonce.as_deref()
            .ok_or("Cold Prompt provenance has no prompt nonce")?;
        let nonce = nonce.to_owned();
        let mut workload = BufferedWorkload {
            request: effective, slots: Vec::new(), input_hashes: None, usage_undecided,
        };
        for concurrency_index in 0..workload.request.concurrencies.len() {
            let concurrency = workload.request.concurrencies[concurrency_index];
            for (input, base) in input_texts.iter().enumerate() {
                let input_bytes = workload.request.prompt_bytes[input];
                for repetition in 1..=workload.request.repetitions {
                    let point = (input_bytes, concurrency, repetition);
                    active_point = Some(point);
                    workload.slots.clear();
                    let mut hashes = Vec::with_capacity(concurrency as usize);
                    for slot in 0..concurrency as usize {
                        let text = corpus::cold_text(base, &nonce, point, slot);
                        hashes.push(format!("{:x}", Sha256::digest(text.as_bytes())));
                        workload.slots.push(point_request(
                            &client, &url, &key, &ready_engine, text, &workload.request,
                        )?);
                    }
                    workload.input_hashes = Some(hashes);
                    trial(&mut workload,&client,point,pid,process_handle.as_ref(),
                        memory_scope,&cancel,&mut result,checkpoint.as_ref(),&progress).await?;
                }
            }
        }
        Ok(())
    }).await.unwrap_or_else(|_| Err(AppError::timeout(match active_point {
        Some((input,concurrency,repetition)) => format!("point b{input}/c{concurrency}/o{target}, repetition {repetition}: benchmark exceeded its {timeout_minutes} minute timeout"),
        None => format!("benchmark exceeded its {timeout_minutes} minute timeout during launch"),
    })));
    emit(
        &progress,
        &request,
        "cleanup",
        result.rows.len(),
        None,
        None,
    );
    drop(managed);
    result.status = if cancel.load(Ordering::Acquire)
        || outcome
            .as_ref()
            .is_err_and(|error| error.kind == crate::error::ErrorKind::Cancelled)
    {
        "cancelled"
    } else if outcome.is_ok() {
        "complete"
    } else if result.rows.is_empty() {
        "failed"
    } else {
        "partial"
    };
    result.message = outcome.err().map(|error| error.message);
    result
}

#[cfg(test)]
mod tests;
