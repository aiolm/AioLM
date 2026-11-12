//! Client-observed OpenAI chat serving measurements on an isolated adapter launch.
//!
//! New runs use the fixed-output method `openai-chat-serving@2`: every request
//! carries the runtime's declared force control (`ignore_eos` or `min_tokens`)
//! next to `max_tokens`, and every launch slot must report exactly the selected
//! completion token count before its batch can become a row. Historical `@1`
//! records stay readable as cap measurements, but are never executed again.
//!
//! Budgets scale with the target in 1024-token units (`ceil(target / 1024)`):
//! each request may take 5 minutes per unit and stream 8 MiB plus 1 KiB per
//! target token; a run may take 30 minutes per unit. The 204800-token preset
//! therefore allows 1000 minutes per request, 6000 minutes per run and
//! 208 MiB per response. Cancellation always ends a run immediately. Output is
//! counted while streaming and never retained or preallocated.
mod corpus;
mod protocol;

use crate::benchmark::provenance::{ServingBenchmarkProvenance, ServingInput, ServingWorkload};
use crate::providers::protocol::{
    EngineInfo, FixedOutputControl, RequestDefaultsPolicy, ServingMemoryScope,
};
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

/// Run budget per started 1024 target tokens.
const RUN_TIMEOUT_PER_UNIT: Duration = Duration::from_secs(30 * 60);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Historical cap-only method; readable, never executed.
pub const CAP_METHOD_VERSION: u32 = 1;
/// Exact fixed-output method used by every new execution.
pub const FIXED_OUTPUT_METHOD_VERSION: u32 = 2;
/// The only targets a fixed-output run may request (1k = 1024 tokens).
pub const FIXED_OUTPUT_TOKENS: [u32; 8] = [1024, 4096, 8192, 16384, 32768, 65536, 131072, 204800];
pub const MAX_SERVING_OUTPUT_TOKENS: u32 = crate::providers::protocol::MAX_FIXED_OUTPUT_TOKENS;
/// Historical cap records accepted request limits up to this value.
pub(crate) const CAP_METHOD_MAX_OUTPUT_TOKENS: u32 = 65_536;

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
            version: FIXED_OUTPUT_METHOD_VERSION,
        }
    }
}

/// Number of started 1024-token units; the scale for every bounded budget.
pub(crate) fn budget_units(target: u32) -> u32 {
    target.div_ceil(1024).max(1)
}

pub(crate) fn run_timeout(target: u32) -> Duration {
    RUN_TIMEOUT_PER_UNIT * budget_units(target)
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
    pub first_content_ms: Option<f64>,
    pub first_reasoning_ms: Option<f64>,
    pub e2e_ms: f64,
    pub content_bytes: u64,
    pub reasoning_bytes: u64,
    pub output_bytes: u64,
    pub reported_prompt_tokens: Option<u64>,
    pub reported_completion_tokens: Option<u64>,
    /// Fixed-output evidence: one reported completion count per launch slot,
    /// in slot order. Absent on historical cap rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_completion_tokens_by_request: Option<Vec<u64>>,
    pub reported_cached_tokens: Option<u64>,
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
        let counter = |value: Option<u64>| value.is_none_or(|n| n <= MAX_SAFE_INTEGER);
        !self.id.is_empty()
            && self.id.len() <= 256
            && (256..=1048576).contains(&self.input_bytes)
            && (1..=MAX_SERVING_OUTPUT_TOKENS).contains(&self.max_output_tokens)
            && (1..=64).contains(&self.concurrency)
            && (1..=100).contains(&self.repetition)
            && time(self.e2e_ms)
            && [
                self.first_output_ms,
                self.first_content_ms,
                self.first_reasoning_ms,
            ]
            .into_iter()
            .all(|v| v.is_none_or(time))
            && self.content_bytes <= MAX_SAFE_INTEGER
            && self.reasoning_bytes <= MAX_SAFE_INTEGER
            && self.content_bytes.checked_add(self.reasoning_bytes) == Some(self.output_bytes)
            && self.output_bytes <= MAX_SAFE_INTEGER
            && (self.content_bytes != 0 || self.first_content_ms.is_none())
            && (self.reasoning_bytes != 0 || self.first_reasoning_ms.is_none())
            && (self.output_bytes != 0 || self.first_output_ms.is_none())
            && counter(self.reported_prompt_tokens)
            && counter(self.reported_completion_tokens)
            && counter(self.reported_cached_tokens)
            && self
                .reported_completion_tokens_by_request
                .as_ref()
                .is_none_or(|counts| {
                    counts.len() == self.concurrency as usize
                        && counts
                            .iter()
                            .try_fold(0u64, |sum, n| {
                                sum.checked_add(*n).filter(|sum| *sum <= MAX_SAFE_INTEGER)
                            })
                            .is_some_and(|sum| Some(sum) == self.reported_completion_tokens)
                })
            && self
                .reported_cached_tokens
                .zip(self.reported_prompt_tokens)
                .is_none_or(|(cached, prompt)| cached <= prompt)
            && match self.usage_status.as_str() {
                "complete" => [
                    self.reported_prompt_tokens,
                    self.reported_completion_tokens,
                    self.reported_cached_tokens,
                ]
                .iter()
                .all(Option::is_some),
                "partial" => [
                    self.reported_prompt_tokens,
                    self.reported_completion_tokens,
                    self.reported_cached_tokens,
                ]
                .iter()
                .any(Option::is_none),
                "missing" | "invalid" => [
                    self.reported_prompt_tokens,
                    self.reported_completion_tokens,
                    self.reported_cached_tokens,
                ]
                .iter()
                .all(Option::is_none),
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

    /// A fixed-output row proves every launch slot produced exactly `target`
    /// reported completion tokens; an aggregate that merely sums correctly
    /// is not evidence.
    pub(crate) fn validate_fixed_output(&self, target: u32) -> bool {
        let target = u64::from(target);
        self.validate()
            && self.max_output_tokens as u64 == target
            && self
                .reported_completion_tokens_by_request
                .as_ref()
                .is_some_and(|counts| {
                    counts.len() == self.concurrency as usize
                        && counts.iter().all(|count| *count == target)
                })
            && self.reported_completion_tokens == Some(target * u64::from(self.concurrency))
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
    if request.method.id != "openai-chat-serving"
        || ![CAP_METHOD_VERSION, FIXED_OUTPUT_METHOD_VERSION].contains(&request.method.version)
    {
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
    if request.method.version == FIXED_OUTPUT_METHOD_VERSION {
        if !FIXED_OUTPUT_TOKENS.contains(&request.max_output_tokens) {
            return Err(
                "fixed output tokens must be 1024, 4096, 8192, 16384, 32768, 65536, 131072 or 204800"
                    .into(),
            );
        }
        if !request.request_usage {
            return Err("fixed-output benchmarks require reported token usage".into());
        }
    } else if !(1..=CAP_METHOD_MAX_OUTPUT_TOKENS).contains(&request.max_output_tokens) {
        return Err("maximum output tokens must be 1 to 65536".into());
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

/// Generic validation plus the execution rule: only the fixed-output method runs.
pub fn validate_execution_request(request: &mut PerformanceBenchRequest) -> Result<(), String> {
    validate_request(request)?;
    if request.method.version != FIXED_OUTPUT_METHOD_VERSION {
        return Err(
            "only the fixed-output method openai-chat-serving@2 can be run; @1 cap records remain readable history"
                .into(),
        );
    }
    Ok(())
}

/// The runtime must declare both a real force control and streamed usage;
/// neither is assumed from an engine name, and there is no cap-mode fallback.
pub(crate) fn fixed_output_control(engine: &EngineInfo) -> Result<FixedOutputControl, String> {
    let control = engine.fixed_output.ok_or(
        "the selected runtime does not declare a fixed-output control (ignore_eos or min_tokens), so it cannot run a fixed-output benchmark",
    )?;
    if engine.stream_usage_supported != Some(true) {
        return Err(
            "the selected runtime does not declare streamed token usage, so exact output counts cannot be verified"
                .into(),
        );
    }
    Ok(control)
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
    if let Err(error) = validate_execution_request(&mut request) {
        return unknown(error);
    }
    if let Err(error) = crate::launch_validation::validate_start_config(&mut cfg) {
        return unknown(error.into());
    }
    let engine = match crate::providers::execution::probed_info(&cfg).await {
        Ok(engine) => engine,
        Err(error) => return unknown(error),
    };
    engine_admission(&engine, &request)
}

fn engine_admission(engine: &EngineInfo, request: &PerformanceBenchRequest) -> BenchmarkAdmission {
    let unsupported = |reason, detail| BenchmarkAdmission {
        status: "unsupported",
        reason,
        detail: Some(detail),
    };
    let Some(control) = engine.fixed_output else {
        return unsupported("fixed_output", fixed_output_control(engine).unwrap_err());
    };
    if let Err(error) = fixed_output_control(engine) {
        return unsupported("stream_usage", error);
    }
    match point_body(engine, String::new(), request, control) {
        Ok(_) => BenchmarkAdmission {
            status: "supported",
            reason: "ready",
            detail: None,
        },
        Err(error) => unsupported("request", error),
    }
}

/// Each launch slot must report exactly `target` completion tokens. A batch
/// with early EOS, overrun, or a missing/invalid counter is not a measurement.
fn fixed_output_counts(
    target: u32,
    measurements: &[protocol::Measurement],
) -> Result<Vec<u64>, String> {
    let target = u64::from(target);
    measurements
        .iter()
        .enumerate()
        .map(
            |(slot, measurement)| match measurement.reported_completion_tokens {
                Some(count) if count == target => Ok(count),
                Some(count) if count < target => Err(format!(
                    "request {} stopped after {count} of {target} output tokens",
                    slot + 1
                )),
                Some(count) => Err(format!(
                    "request {} reported {count} output tokens instead of exactly {target}",
                    slot + 1
                )),
                None => Err(format!(
                    "request {} did not report a valid completion token count",
                    slot + 1
                )),
            },
        )
        .collect()
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
    let cached = sum(|m| m.reported_cached_tokens);
    let invalid = measurements.iter().any(|m| m.usage_status == "invalid")
        || prompt.is_err()
        || completion.is_err()
        || cached.is_err();
    let (reported_prompt_tokens, reported_completion_tokens, reported_cached_tokens) = if invalid {
        (None, None, None)
    } else {
        (prompt.unwrap(), completion.unwrap(), cached.unwrap())
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
    let content_bytes = measurements.iter().map(|m| m.content_bytes).sum();
    let reasoning_bytes = measurements.iter().map(|m| m.reasoning_bytes).sum();
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
        first_output_ms: channel_mean(measurements, |m| m.first_output_ms),
        first_content_ms: channel_mean(measurements, |m| m.first_content_ms),
        first_reasoning_ms: channel_mean(measurements, |m| m.first_reasoning_ms),
        e2e_ms: finished.duration_since(started).as_secs_f64() * 1000.0,
        content_bytes,
        reasoning_bytes,
        output_bytes: content_bytes + reasoning_bytes,
        reported_prompt_tokens,
        reported_completion_tokens,
        reported_completion_tokens_by_request: None,
        reported_cached_tokens,
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

async fn batch(
    client: &reqwest::Client,
    request: &reqwest::Request,
    concurrency: u32,
    cancel: &AtomicBool,
    budget: protocol::Budget,
) -> Result<(Instant, Vec<protocol::Measurement>), AppError> {
    let started = Instant::now();
    let mut pending = FuturesUnordered::new();
    let mut measurements: Vec<Option<protocol::Measurement>> =
        (0..concurrency).map(|_| None).collect();
    for slot in 0..concurrency as usize {
        pending.push(async move {
            (
                slot,
                protocol::request(client, request, cancel, budget).await,
            )
        });
    }
    while let Some((slot, result)) = pending.next().await {
        measurements[slot] = Some(result?);
    }
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("benchmark cancelled"));
    }
    Ok((
        started,
        measurements
            .into_iter()
            .map(|m| m.expect("all launch slots completed"))
            .collect(),
    ))
}

/// Serialize once per input, then cheaply reuse the buffer across slots and concurrencies.
fn point_request(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    engine: &EngineInfo,
    text: String,
    request: &PerformanceBenchRequest,
    control: FixedOutputControl,
) -> Result<reqwest::Request, String> {
    let body = point_body(engine, text, request, control)?;
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
    control: FixedOutputControl,
) -> Result<serde_json::Value, String> {
    let model = engine
        .request_lora
        .as_deref()
        .unwrap_or(&engine.upstream_model);
    let target = request.max_output_tokens;
    let mut body = serde_json::json!({"model": model, "messages": [{"role":"user"}], "temperature":0, "max_tokens":target, "stream":true});
    body["messages"][0]["content"] = serde_json::Value::String(text);
    if request.request_usage {
        body["stream_options"] = serde_json::json!({"include_usage":true});
    }
    body[control.field_name()] = control.value(target);
    crate::providers::protocol::adapt_request(
        engine,
        "chat/completions",
        &mut body,
        RequestDefaultsPolicy::Omit,
    )
    .map_err(|error| error.message)?;
    // The frozen descriptors are only true if the adapter sent them unchanged.
    if body.get(control.field_name()) != Some(&control.value(target))
        || body.get("max_tokens") != Some(&serde_json::json!(target))
        || (request.request_usage
            && body.pointer("/stream_options/include_usage") != Some(&serde_json::json!(true)))
    {
        return Err("the runtime adapter did not send the fixed-output request unchanged".into());
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
        let control = fixed_output_control(&engine).map_err(AppError::unavailable)?;
        let admission = engine_admission(&engine, &request);
        if admission.status != "supported" {
            return Err(AppError::unavailable(
                admission
                    .detail
                    .unwrap_or_else(|| "benchmark admission failed".into()),
            ));
        }
        let (workload, input_texts) = prepare_inputs(&request);
        let model_path = PathBuf::from(&cfg.active_model);
        let label = model_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let root = crate::benchmark::data_root()?;
        let model = tokio::task::spawn_blocking(move || {
            let mut identity = crate::benchmark::identity::capture(&root, &model_path);
            identity.metadata = crate::benchmark::model_metadata::collect(&root, &model_path);
            identity
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
            control,
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
    let input_texts: Vec<_> = request
        .prompt_bytes
        .iter()
        .map(|bytes| corpus::text(&request.context_profile, *bytes as usize))
        .collect();
    let inputs = input_texts
        .iter()
        .map(|text| ServingInput {
            bytes: text.len() as u32,
            sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
        })
        .collect();
    (
        ServingWorkload {
            corpus: request.context_profile.clone(),
            corpus_version: 1,
            inputs,
            max_output_tokens: request.max_output_tokens,
            concurrencies: request.concurrencies.clone(),
            repetitions: request.repetitions,
            warmup: request.warmup,
            request_usage: request.request_usage,
            cache_policy: "as_configured".into(),
        },
        input_texts,
    )
}

pub(crate) type Checkpoint =
    Arc<dyn Fn(&PerformanceBenchResult) -> Result<(), AppError> + Send + Sync>;

#[allow(clippy::too_many_arguments)]
async fn trial(
    request: &PerformanceBenchRequest,
    client: &reqwest::Client,
    buffered: &reqwest::Request,
    point: (u32, u32, u32),
    pid: u32,
    memory_scope: ServingMemoryScope,
    cancel: &AtomicBool,
    result: &mut PerformanceBenchResult,
    checkpoint: Option<&Checkpoint>,
    progress: &Progress,
) -> Result<(), AppError> {
    let (input_bytes, concurrency, repetition) = point;
    let target = request.max_output_tokens;
    let phase = if concurrency == 1 { "single" } else { "batch" };
    emit(progress,request,phase,result.rows.len(),None,Some(format!("{input_bytes} UTF-8 bytes / {target} output tokens, {concurrency} request(s), repetition {repetition}")));
    let sampler =
        (memory_scope != ServingMemoryScope::Unavailable).then(|| PeakMemorySampler::start(pid));
    let measured = batch(
        client,
        buffered,
        concurrency,
        cancel,
        protocol::Budget::fixed_output(target),
    )
    .await;
    let peak = sampler.and_then(PeakMemorySampler::finish);
    let failure = |e: AppError| {
        AppError::new(
            e.kind,
            format!("point b{input_bytes}/c{concurrency}/o{target}, repetition {repetition}: {e}"),
        )
    };
    let (started, measurements) = measured.map_err(failure)?;
    if cancel.load(Ordering::Acquire) {
        return Err(failure(AppError::cancelled("benchmark cancelled")));
    }
    // Per-request evidence is checked before any aggregate or checkpoint.
    let counts = fixed_output_counts(target, &measurements)
        .map_err(AppError::unavailable)
        .map_err(failure)?;
    let mut row = aggregate(request, point, started, &measurements, peak);
    row.reported_completion_tokens_by_request = Some(counts);
    if !row.validate_fixed_output(target) {
        return Err(failure(AppError::unavailable(
            "reported usage could not be recorded as fixed-output evidence",
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
    let timeout = run_timeout(target);
    let timeout_minutes = timeout.as_secs() / 60;
    let request_budget = protocol::Budget::fixed_output(target);
    let outcome: Result<(),AppError> = tokio::time::timeout(timeout, async {
        if cancel.load(Ordering::Acquire) { return Err(AppError::cancelled("benchmark cancelled")); }
        let provenance = result.provenance.as_ref().expect("frozen provenance");
        provenance.validate(&request.context_profile).map_err(AppError::validation)?;
        let frozen_control = provenance.fixed_output_control()
            .filter(|_| provenance.method.version == request.method.version)
            .ok_or_else(|| AppError::validation("prepared serving provenance does not describe a fixed-output run"))?;
        if input_texts.len() != request.prompt_bytes.len() || provenance.workload.inputs.len() != input_texts.len()
            || input_texts.iter().zip(&request.prompt_bytes).any(|(text,bytes)| text.len() != *bytes as usize)
            || provenance.workload.inputs.iter().zip(&request.prompt_bytes).any(|(input,bytes)| input.bytes != *bytes)
            || provenance.workload.max_output_tokens != request.max_output_tokens || provenance.workload.concurrencies != request.concurrencies
            || provenance.workload.repetitions != request.repetitions || provenance.workload.warmup != request.warmup || provenance.workload.request_usage != request.request_usage {
            return Err(AppError::validation("prepared serving workload does not match the request"));
        }
        let reservation = TcpListener::bind(("127.0.0.1",0)).map_err(|e| AppError::unavailable(format!("cannot reserve benchmark port: {e}")))?;
        let port = reservation.local_addr().map_err(|e| e.to_string())?.port();
        let isolated = isolated_config(&cfg,port);
        let key = format!("bench-{}",uuid::Uuid::new_v4().simple());
        let ring = Arc::new(server::ErrBuf::default());
        let mut settings_warning = None;
        let mut capture = |program: &std::path::Path, args: &[String]| {
            let argv: Vec<String> = std::iter::once(program.to_string_lossy().into_owned()).chain(args.iter().cloned()).collect();
            result.args = crate::providers::runtime_schema::mask_argv(&crate::providers::registry::root(),&isolated,redacted_args(argv.clone()),"[redacted]");
            let provenance = result.provenance.as_mut().expect("frozen provenance");
            provenance.environment.host.execution =
                crate::benchmark::provenance::capture_serving_gpu_execution(
                    &isolated, &gpu_profile, &gpu, args,
                );
            let request_slots = provenance.execution.settings.len();
            let captured = crate::providers::runtime_schema::effective(&crate::providers::registry::root(), &isolated, false)
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
        *active_process.lock().unwrap_or_else(|e| e.into_inner()) = process_handle;
        if let Some(warning) = settings_warning {
            emit(&progress, &request, "loading", 0, None, Some(warning));
        }
        tokio::select! { biased;
            _ = protocol::cancelled(&cancel) => return Err(AppError::cancelled("benchmark cancelled")),
            ready = server::wait_ready(shared.clone(),&url,&key,server::SERVER_START_TIMEOUT_SECS,&ring,readiness) => ready?,
        }
        let ready_engine = shared.lock().map_err(|_| "benchmark process lock was poisoned")?.engine.clone().ok_or("ready server has no engine information")?;
        // The launched runtime must still declare the control frozen in provenance.
        if fixed_output_control(&ready_engine).map_err(AppError::unavailable)? != frozen_control {
            return Err(AppError::unavailable("the launched runtime changed its fixed-output control after preflight"));
        }
        let memory_scope = result.provenance.as_ref().unwrap().execution.memory_scope;
        let client = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).timeout(request_budget.timeout).build().map_err(|e| e.to_string())?;
        if let Some(checkpoint) = &checkpoint { checkpoint(&result)?; }
        let buffered_inputs = request.prompt_bytes.iter().copied().zip(input_texts)
            .map(|(bytes, text)| point_request(&client, &url, &key, &ready_engine, text, &request, frozen_control)
                .map(|buffered| (bytes, buffered)))
            .collect::<Result<Vec<_>, String>>()?;
        for &concurrency in &request.concurrencies {
            for (input_bytes, buffered) in &buffered_inputs {
                let input_bytes = *input_bytes;
                if request.warmup {
                    active_point = Some((input_bytes,concurrency,0));
                    emit(&progress,&request,"warmup",result.rows.len(),None,Some(format!("{input_bytes} UTF-8 bytes, {concurrency} requests")));
                    let warmup = |e: AppError| AppError::new(e.kind, format!("warmup b{input_bytes}/c{concurrency}/o{target}: {e}"));
                    let (_, measurements) = batch(&client,buffered,concurrency,&cancel,request_budget).await.map_err(warmup)?;
                    fixed_output_counts(target,&measurements).map_err(AppError::unavailable).map_err(warmup)?;
                }
                for repetition in 1..=request.repetitions {
                    active_point = Some((input_bytes,concurrency,repetition));
                    trial(&request,&client,buffered,(input_bytes,concurrency,repetition),pid,
                        memory_scope,&cancel,&mut result,checkpoint.as_ref(),&progress).await?;
                }
            }
        }
        Ok(())
    }).await.unwrap_or_else(|_| Err(AppError::timeout(match active_point {
        Some((input,concurrency,0)) => format!("warmup b{input}/c{concurrency}/o{target}: benchmark exceeded its {timeout_minutes} minute timeout"),
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
