//! Repeatable cold-prompt serving benchmarks on an isolated llama-server.
//! The application configuration and its managed server are never replaced.
mod corpus;
mod protocol;

use crate::{config::AppConfig, gpu::ResolvedGpu, performance_memory::PeakMemorySampler, server};
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

const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PerformanceBenchRequest {
    pub run_id: String,
    pub prompt_lengths: Vec<u32>,
    pub generation_length: u32,
    #[serde(default)]
    pub batch_sizes: Vec<u32>,
    pub repetitions: u32,
    pub context_profile: String,
    pub warmup: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PerformanceBenchRow {
    pub id: String,
    pub prompt_tokens: u32,
    pub generation_length: u32,
    pub concurrency: u32,
    pub repetition: u32,
    pub completion_tokens: u32,
    pub cached_tokens: u32,
    pub ttft_ms: Option<f64>,
    pub tpot_ms: Option<f64>,
    pub pp_tps: Option<f64>,
    pub tg_tps: Option<f64>,
    pub e2e_ms: f64,
    pub total_tps: Option<f64>,
    pub peak_memory_bytes: Option<u64>,
    pub timing_source: &'static str,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PerformanceBenchResult {
    pub run_id: String,
    pub rows: Vec<PerformanceBenchRow>,
    pub status: &'static str,
    pub message: Option<String>,
    pub args: Vec<String>,
    pub runtime_version: String,
    pub context_size: u32,
    pub parallel: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provenance: Option<crate::benchmark::provenance::BenchmarkProvenance>,
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
    if request.prompt_lengths.is_empty()
        || request.prompt_lengths.len() > 16
        || request
            .prompt_lengths
            .iter()
            .any(|n| !(1..=200_000).contains(n))
    {
        return Err("select 1 to 16 prompt lengths between 1 and 200000 tokens".into());
    }
    if !(1..=4096).contains(&request.generation_length) || !(1..=10).contains(&request.repetitions)
    {
        return Err("generation length must be 1 to 4096 and repetitions 1 to 10".into());
    }
    if request.batch_sizes.len() > 3 || request.batch_sizes.iter().any(|n| ![2, 4, 8].contains(n)) {
        return Err("batch sizes must be selected from 2, 4 and 8".into());
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
    request.prompt_lengths.sort_unstable();
    request.prompt_lengths.dedup();
    request.batch_sizes.sort_unstable();
    request.batch_sizes.dedup();
    Ok(())
}

pub fn failed(
    request: &PerformanceBenchRequest,
    cfg: &AppConfig,
    message: String,
) -> PerformanceBenchResult {
    PerformanceBenchResult {
        run_id: request.run_id.clone(),
        rows: vec![],
        status: "failed",
        message: Some(message),
        args: vec![],
        runtime_version: "unknown".into(),
        context_size: cfg.ctx_size,
        parallel: cfg.parallel,
        provenance: None,
    }
}

/// Workload controls apply only to this clone. Explicit values also have to
/// leave runtime_defaults, otherwise the shared launcher drops the override.
fn isolated_config(
    cfg: &AppConfig,
    request: &PerformanceBenchRequest,
    port: u16,
    cache_ram_supported: bool,
) -> AppConfig {
    let mut isolated = cfg.clone();
    isolated.port = port;
    isolated.parallel = request.batch_sizes.iter().copied().max().unwrap_or(1);
    let per_slot = (request.prompt_lengths.iter().copied().max().unwrap_or(1)
        + request.generation_length
        + 32)
        .div_ceil(256)
        * 256;
    isolated.ctx_size = per_slot * isolated.parallel;
    isolated.keep = 0;
    isolated.sleep_idle_seconds = -1;
    isolated.request_timeout_seconds = REQUEST_TIMEOUT.as_secs() as u32;
    isolated.runtime_defaults.retain(|name| {
        ![
            "ctx_size",
            "parallel",
            "keep",
            "sleep_idle_seconds",
            "request_timeout_seconds",
        ]
        .contains(&name.as_str())
    });
    let value_options = [
        "--ctx-size",
        "-c",
        "--parallel",
        "-np",
        "--host",
        "--port",
        "--cache-ram",
        "-cram",
        "--cache-reuse",
        "--kv-unified-per-slot",
        "--slots-max",
        "--slot-save-path",
    ];
    let switches = [
        "--cont-batching",
        "-cb",
        "--no-cont-batching",
        "-nocb",
        "--warmup",
        "--no-warmup",
        "--context-shift",
        "--no-context-shift",
        "--cache-idle-slots",
        "--no-cache-idle-slots",
        "--webui",
        "--ui",
        "--no-webui",
        "--no-ui",
    ];
    let mut filtered = Vec::new();
    let mut args = isolated.server_args.iter().peekable();
    while let Some(arg) = args.next() {
        let name = arg.split('=').next().unwrap_or(arg);
        if value_options.contains(&name) {
            if !arg.contains('=')
                && args
                    .peek()
                    .is_some_and(|value| !value.starts_with('-') || value.parse::<f64>().is_ok())
            {
                args.next();
            }
        } else if !switches.contains(&name) {
            filtered.push(arg.clone());
        }
    }
    filtered.extend(["--no-warmup".into(), "--no-context-shift".into()]);
    if cache_ram_supported {
        filtered.extend(["--cache-ram".into(), "0".into()]);
    }
    isolated.server_args = filtered;
    isolated
}

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
    active_pid: Arc<Mutex<Option<u32>>>,
}

impl Drop for IsolatedServer {
    fn drop(&mut self) {
        // Drop runs on normal completion, cancellation, timeout and unwind.
        // Clear the externally cancellable PID before reaping it to avoid a
        // late cancel ever targeting a recycled process identifier.
        if let Ok(mut pid) = self.active_pid.lock() {
            *pid = None;
        }
        if let Ok(mut state) = self.state.lock() {
            server::kill(&mut state.child, None);
        }
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
        total: request.prompt_lengths.len()
            * (1 + request.batch_sizes.len())
            * request.repetitions as usize,
        row,
        message,
    });
}

fn mean(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, count) = values
        .filter(|n| n.is_finite())
        .fold((0.0, 0), |(sum, count), value| (sum + value, count + 1));
    (count > 0).then(|| sum / f64::from(count))
}

fn rate(tokens: u32, seconds: f64) -> Option<f64> {
    (tokens > 0 && seconds > 0.0)
        .then(|| f64::from(tokens) / seconds)
        .filter(|value| value.is_finite())
}

fn aggregate(
    request: &PerformanceBenchRequest,
    prompt: u32,
    concurrency: u32,
    repetition: u32,
    elapsed: std::ops::Range<Instant>,
    measurements: &[protocol::Measurement],
    peak_memory_bytes: Option<u64>,
) -> PerformanceBenchRow {
    let started = elapsed.start;
    let ended = elapsed.end;
    let first = measurements.iter().filter_map(|m| m.first_token).min();
    let last_first = measurements.iter().filter_map(|m| m.first_token).max();
    let last = measurements.iter().filter_map(|m| m.last_token).max();
    let completion_tokens = measurements.iter().map(|m| m.completion_tokens).sum();
    let prompt_tokens = measurements.iter().map(|m| m.prompt_tokens).sum();
    let decoded = measurements
        .iter()
        .map(|m| m.completion_tokens.saturating_sub(1))
        .sum();
    let errors = measurements
        .iter()
        .filter_map(|m| m.error.as_deref())
        .collect::<Vec<_>>();
    let e2e = ended.duration_since(started).as_secs_f64();
    let all_first = measurements.len() == concurrency as usize
        && measurements.iter().all(|m| m.ttft_ms().is_some());
    let all_decode = measurements.len() == concurrency as usize
        && measurements.iter().all(|m| m.tpot_ms().is_some());
    PerformanceBenchRow {
        id: format!(
            "{}-p{prompt}-g{}-c{concurrency}-r{repetition}",
            request.run_id, request.generation_length
        ),
        prompt_tokens: prompt,
        generation_length: request.generation_length,
        concurrency,
        repetition,
        completion_tokens,
        cached_tokens: measurements.iter().map(|m| m.cached_tokens).sum(),
        ttft_ms: all_first
            .then(|| mean(measurements.iter().filter_map(|m| m.ttft_ms())))
            .flatten(),
        tpot_ms: all_decode
            .then(|| mean(measurements.iter().filter_map(|m| m.tpot_ms())))
            .flatten(),
        pp_tps: all_first
            .then(|| {
                last_first.and_then(|last| {
                    rate(prompt_tokens, last.duration_since(started).as_secs_f64())
                })
            })
            .flatten(),
        tg_tps: all_decode
            .then(|| {
                first.zip(last).and_then(|(first, last)| {
                    rate(decoded, last.duration_since(first).as_secs_f64())
                })
            })
            .flatten(),
        e2e_ms: e2e * 1000.0,
        total_tps: rate(completion_tokens, e2e),
        peak_memory_bytes,
        timing_source: "client",
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

async fn batch(
    endpoint: &protocol::Endpoint,
    tokens: Arc<Vec<u32>>,
    generation: u32,
    concurrency: u32,
    cancel: &Arc<AtomicBool>,
    timeout: Duration,
) -> Vec<protocol::Measurement> {
    let mut requests = FuturesUnordered::new();
    for slot in 0..concurrency {
        requests.push(protocol::measure(
            endpoint.clone(),
            tokens.clone(),
            generation,
            slot,
            cancel.clone(),
            timeout,
        ));
    }
    let mut results = Vec::new();
    while let Some(measured) = requests.next().await {
        results.push(measured);
    }
    results
}

pub struct RuntimeInfo {
    pub version: String,
    pub cache_ram_supported: bool,
    pub(crate) provenance: Option<crate::benchmark::provenance::BenchmarkProvenance>,
    pub(crate) checkpoint: Option<Checkpoint>,
}

impl RuntimeInfo {
    /// Runtime capabilities for a standalone benchmark. Desktop persistence and
    /// launch provenance remain internal to the application's command adapter.
    pub fn new(version: impl Into<String>, cache_ram_supported: bool) -> Self {
        Self {
            version: version.into(),
            cache_ram_supported,
            provenance: None,
            checkpoint: None,
        }
    }
}

/// Called after metadata preparation and after each trial's timer and memory
/// sampler stop. The journal writes only newly completed rows.
pub(crate) type Checkpoint =
    Arc<dyn Fn(&PerformanceBenchResult) -> Result<(), String> + Send + Sync>;

pub(crate) fn corpus_identity(profile: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(corpus::text(profile, 4096).as_bytes())
    )
}

pub async fn run(
    cfg: AppConfig,
    mut request: PerformanceBenchRequest,
    gpu: ResolvedGpu,
    cancel: Arc<AtomicBool>,
    active_pid: Arc<Mutex<Option<u32>>>,
    progress: Progress,
    runtime: RuntimeInfo,
) -> PerformanceBenchResult {
    let mut result = failed(&request, &cfg, String::new());
    if let Err(error) = validate_request(&mut request) {
        result.message = Some(error);
        return result;
    }
    result.runtime_version = runtime.version;
    result.provenance = runtime.provenance;
    result.message = None;
    let mut managed: Option<IsolatedServer> = None;
    let deadline = Instant::now() + RUN_TIMEOUT;
    emit(&progress, &request, "loading", 0, None, None);
    let outcome: Result<(), String> = tokio::time::timeout(RUN_TIMEOUT, async {
        if cancel.load(Ordering::Acquire) { return Err("benchmark cancelled".into()); }
        // Reserve an OS-assigned loopback port until immediately before spawn.
        // Shared wait_ready additionally verifies listener ownership by PID.
        let reservation = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("cannot reserve benchmark port: {error}"))?;
        let port = reservation.local_addr().map_err(|error| error.to_string())?.port();
        let isolated = isolated_config(&cfg, &request, port, runtime.cache_ram_supported);
        result.context_size = isolated.ctx_size;
        result.parallel = isolated.parallel;
        result.args = redacted_args(server::build_args_with_gpu(&isolated, "", &gpu));
        if let Some(provenance) = &mut result.provenance {
            provenance.execution_config = crate::benchmark::provenance::ExecutionConfig::from_args(&result.args);
        }
        let key = format!("bench-{}", uuid::Uuid::new_v4().simple());
        let ring = Arc::new(server::ErrBuf::default());
        drop(reservation);
        let (child, url, key_file) = server::spawn(&isolated, &key, &ring, &gpu)?;
        if key_file.is_some() { result.args.extend(["--api-key-file".into(), "[redacted]".into()]); }
        let pid = child.id();
        let mut dedicated_state = server::ServerState::default();
        dedicated_state.child = Some(child);
        let shared = Arc::new(Mutex::new(dedicated_state));
        managed = Some(IsolatedServer { state: shared.clone(), key_file, active_pid: active_pid.clone() });
        if let Ok(mut active) = active_pid.lock() { *active = Some(pid); }
        tokio::select! {
            biased;
            _ = protocol::cancelled(&cancel) => return Err("benchmark cancelled".into()),
            ready = server::wait_ready(shared, &url, &key, 600, &ring) => ready?,
        }
        let base = url.trim_end_matches("/v1");
        let client = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5))
            .timeout(REQUEST_TIMEOUT).build().map_err(|error| error.to_string())?;
        let props = tokio::select! {
            biased;
            _ = protocol::cancelled(&cancel) => return Err("benchmark cancelled".into()),
            props = async {
                let response = client.get(format!("{base}/props")).bearer_auth(&key).send().await.map_err(|error| format!("cannot verify benchmark server settings: {error}"))?;
                protocol::bounded_json(response).await
            } => props?,
        };
        let slots = props.get("total_slots").and_then(serde_json::Value::as_u64).ok_or("runtime did not report its slot count")?;
        let per_slot = props.pointer("/default_generation_settings/n_ctx").and_then(serde_json::Value::as_u64).ok_or("runtime did not report its per-slot context size")?;
        let required = u64::from(request.prompt_lengths.iter().copied().max().unwrap_or(1) + request.generation_length);
        if slots != u64::from(isolated.parallel) || per_slot < required {
            return Err(format!("runtime context/slot mismatch: need {} slots of at least {required} tokens; got {slots} slots of {per_slot} tokens", isolated.parallel));
        }
        result.context_size = u32::try_from(per_slot * slots).map_err(|_| "runtime reported an invalid context size")?;
        if let Some(version) = props.get("build_info").and_then(serde_json::Value::as_str).filter(|v| !v.is_empty()) { result.runtime_version = version.to_owned(); }
        let max_prompt = request.prompt_lengths.iter().copied().max().unwrap_or(1) as usize;
        let mut target_bytes = (max_prompt * 8).max(4096);
        let all_tokens = loop {
            let text = corpus::text(&request.context_profile, target_bytes);
            let tokens = tokio::select! {
                biased;
                _ = protocol::cancelled(&cancel) => return Err("benchmark cancelled".into()),
                tokens = protocol::tokenize(&client, base, &key, &text) => tokens?,
            };
            if tokens.len() >= max_prompt {
                if let Some(provenance) = &mut result.provenance {
                    provenance.corpus.sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
                }
                break tokens;
            }
            target_bytes *= 2;
            if target_bytes > 4 * 1024 * 1024 { return Err("could not construct enough corpus tokens within the text size limit".into()); }
        };
        let endpoint = protocol::Endpoint { client: client.clone(), base: base.to_owned(), key: key.clone() };
        if let Some(checkpoint) = &runtime.checkpoint { checkpoint(&result)?; }
        if request.warmup {
            emit(&progress, &request, "warmup", 0, None, None);
            let tokens = Arc::new(all_tokens[..all_tokens.len().min(128)].to_vec());
            let warmup = batch(&endpoint, tokens, 16, isolated.parallel, &cancel, REQUEST_TIMEOUT).await;
            if let Some(error) = warmup.iter().find_map(|m| m.error.as_ref()) { return Err(format!("warmup failed: {error}")); }
        }
        // Concurrency is the outer sweep so every input length finishes at one level before the next: 1x runs for all lengths, then 2x, and so on.
        for concurrency in std::iter::once(1).chain(request.batch_sizes.iter().copied()) {
            for &prompt in &request.prompt_lengths {
                let tokens = Arc::new(all_tokens[..prompt as usize].to_vec());
                for repetition in 1..=request.repetitions {
                    if cancel.load(Ordering::Acquire) { return Err("benchmark cancelled".into()); }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() { return Err("benchmark exceeded its 30 minute timeout".into()); }
                    let phase = if concurrency == 1 { "single" } else { "batch" };
                    emit(&progress, &request, phase, result.rows.len(), None, Some(format!("{prompt} input / {} output, {concurrency} request(s), repetition {repetition}", request.generation_length)));
                    let memory = PeakMemorySampler::start(pid);
                    let started = Instant::now();
                    let measured = batch(&endpoint, tokens.clone(), request.generation_length, concurrency, &cancel, REQUEST_TIMEOUT.min(remaining)).await;
                    let ended = Instant::now();
                    let row = aggregate(&request, prompt, concurrency, repetition, started..ended, &measured, memory.finish());
                    result.rows.push(row.clone());
                    if let Some(checkpoint) = &runtime.checkpoint { checkpoint(&result)?; }
                    emit(&progress, &request, phase, result.rows.len(), Some(row), None);
                    if cancel.load(Ordering::Acquire) { return Err("benchmark cancelled".into()); }
                    if measured.iter().any(|m| m.error.as_ref().is_some_and(|error| error.contains("timed out"))) {
                        return Err("benchmark request timed out; completed measurements were preserved".into());
                    }
                    if let Some(managed) = &managed {
                        let mut state = managed.state.lock().map_err(|_| "benchmark process lock was poisoned")?;
                        if state.child.as_mut().and_then(|child| child.try_wait().ok()).flatten().is_some() {
                            return Err(format!("benchmark server exited: {}", ring.tail()));
                        }
                    }
                }
            }
        }
        Ok(())
    }).await.unwrap_or_else(|_| Err("benchmark exceeded its 30 minute timeout".into()));
    emit(
        &progress,
        &request,
        "cleanup",
        result.rows.len(),
        None,
        None,
    );
    drop(managed);
    let any_success = result.rows.iter().any(|row| row.error.is_none());
    result.status = if cancel.load(Ordering::Acquire) {
        "cancelled"
    } else if outcome.is_ok() && result.rows.iter().all(|row| row.error.is_none()) {
        "complete"
    } else if any_success {
        "partial"
    } else {
        "failed"
    };
    result.message = outcome
        .err()
        .or_else(|| result.rows.iter().find_map(|row| row.error.clone()));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> PerformanceBenchRequest {
        PerformanceBenchRequest {
            run_id: "test".into(),
            prompt_lengths: vec![512, 1024],
            generation_length: 128,
            batch_sizes: vec![2, 4],
            repetitions: 2,
            context_profile: "novel_ko".into(),
            warmup: true,
        }
    }

    #[test]
    fn isolated_settings_override_inheritance_and_conflicting_flags_without_mutating_original() {
        let cfg = AppConfig {
            ctx_size: 4096,
            parallel: 0,
            runtime_defaults: vec!["ctx_size".into(), "parallel".into()],
            server_args: vec![
                "--parallel=9".into(),
                "--ctx-size".into(),
                "99999".into(),
                "--no-cont-batching".into(),
                "--cache-ram".into(),
                "-1".into(),
                "--no-mmap".into(),
            ],
            ..Default::default()
        };
        let isolated = isolated_config(&cfg, &request(), 41327, true);
        let args = server::build_args(&isolated, "");
        assert_eq!(isolated.parallel, 4);
        assert_eq!(isolated.ctx_size, 5120);
        assert!(args.windows(2).any(|pair| pair == ["--ctx-size", "5120"]));
        assert!(args.windows(2).any(|pair| pair == ["--parallel", "4"]));
        assert!(args.windows(2).any(|pair| pair == ["--cache-ram", "0"]));
        assert!(args.iter().any(|arg| arg == "--cont-batching"));
        assert!(!args
            .iter()
            .any(|arg| arg == "--no-cont-batching" || arg == "99999"));
        assert!(args.iter().any(|arg| arg == "--no-mmap"));
        assert_eq!(cfg.parallel, 0);
        assert_eq!(cfg.ctx_size, 4096);
    }

    #[test]
    fn batch_rates_use_wall_time_and_actual_token_accounting() {
        let start = Instant::now();
        let measurements = vec![
            protocol::Measurement {
                prompt_tokens: 100,
                completion_tokens: 11,
                started: Some(start),
                first_token: Some(start + Duration::from_secs(1)),
                last_token: Some(start + Duration::from_secs(3)),
                ..Default::default()
            },
            protocol::Measurement {
                prompt_tokens: 100,
                completion_tokens: 11,
                started: Some(start),
                first_token: Some(start + Duration::from_secs(2)),
                last_token: Some(start + Duration::from_secs(4)),
                ..Default::default()
            },
        ];
        let row = aggregate(
            &request(),
            100,
            2,
            1,
            start..start + Duration::from_secs(5),
            &measurements,
            Some(1234),
        );
        assert_eq!(row.pp_tps, Some(100.0));
        assert!((row.tg_tps.unwrap() - 20.0 / 3.0).abs() < 0.0001);
        assert_eq!(row.ttft_ms, Some(1500.0));
        assert_eq!(row.tpot_ms, Some(200.0));
        assert_eq!(row.total_tps, Some(4.4));
        assert_eq!(row.completion_tokens, 22);
    }

    #[test]
    fn request_validation_limits_work_and_rejects_unknown_profiles() {
        let mut req = request();
        req.context_profile = "downloaded_file".into();
        assert!(validate_request(&mut req).is_err());
        req.context_profile = "code_python".into();
        req.batch_sizes = vec![1, 16];
        assert!(validate_request(&mut req).is_err());
    }

    #[test]
    fn missing_batch_timestamps_do_not_turn_into_partial_averages_or_fake_decode_speed() {
        let start = Instant::now();
        let observed = protocol::Measurement {
            prompt_tokens: 100,
            completion_tokens: 3,
            started: Some(start),
            first_token: Some(start + Duration::from_secs(1)),
            last_token: Some(start + Duration::from_secs(2)),
            ..Default::default()
        };
        let burst = protocol::Measurement {
            first_token: Some(start + Duration::from_secs(3)),
            last_token: Some(start + Duration::from_secs(3)),
            ..observed.clone()
        };
        let row = aggregate(
            &request(),
            100,
            2,
            1,
            start..start + Duration::from_secs(4),
            &[observed.clone(), burst],
            None,
        );
        assert!(row.tg_tps.is_none());
        assert!(row.tpot_ms.is_none());
        assert!(row.ttft_ms.is_some());
        let row = aggregate(
            &request(),
            100,
            2,
            1,
            start..start + Duration::from_secs(4),
            &[observed, protocol::Measurement::default()],
            None,
        );
        assert!(row.ttft_ms.is_none());
        assert!(row.pp_tps.is_none());
        assert!(row.tg_tps.is_none());
    }

    #[tokio::test]
    #[ignore = "loads an explicitly selected local GGUF; set AIOLM_BENCH_SMOKE_MODEL and run manually"]
    async fn local_model_performance_smoke() {
        let model = std::env::var("AIOLM_BENCH_SMOKE_MODEL")
            .expect("AIOLM_BENCH_SMOKE_MODEL must explicitly name a local GGUF");
        let cfg = AppConfig {
            active_model: model,
            gpu: crate::config::GpuPlacement {
                gpu_ids: std::env::var("AIOLM_BENCH_SMOKE_GPU")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| vec![value.trim().to_owned()])
                    .unwrap_or_default(),
                ..Default::default()
            },
            active_backend: std::env::var("AIOLM_BENCH_SMOKE_BACKEND")
                .unwrap_or_else(|_| "vulkan".into()),
            active_build: std::env::var("AIOLM_BENCH_SMOKE_BUILD")
                .unwrap_or_else(|_| "b10840".into()),
            ..Default::default()
        };
        let mut resolved_cfg = cfg.clone();
        let gpu = crate::validate_launch_config(&mut resolved_cfg)
            .await
            .expect("selected runtime must pass launch validation");
        let request = PerformanceBenchRequest {
            run_id: "local-smoke".into(),
            prompt_lengths: vec![1024],
            generation_length: 8,
            batch_sizes: vec![2],
            repetitions: 1,
            context_profile: "novel_ko".into(),
            warmup: true,
        };
        let active_pid = Arc::new(Mutex::new(None));
        let result = run(
            resolved_cfg,
            request,
            gpu,
            Arc::new(AtomicBool::new(false)),
            active_pid.clone(),
            Arc::new(|event| {
                eprintln!(
                    "{} {}/{} {:?}",
                    event.phase, event.completed, event.total, event.message
                );
            }),
            RuntimeInfo::new("unknown", true),
        )
        .await;
        eprintln!("{}", serde_json::to_string_pretty(&result).unwrap());
        assert!(
            active_pid.lock().unwrap().is_none(),
            "benchmark process must be cleaned up"
        );
        assert_eq!(result.status, "complete", "{:?}", result.message);
        assert_eq!(result.rows.len(), 2);
        for row in &result.rows {
            assert_eq!(row.prompt_tokens, 1024);
            assert_eq!(row.completion_tokens, row.concurrency * 8);
            assert_eq!(row.cached_tokens, 0);
            assert!(row.error.is_none());
        }
        assert_eq!(cfg.ctx_size, AppConfig::default().ctx_size);
    }
}
