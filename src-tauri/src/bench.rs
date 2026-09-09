// src-tauri/src/bench.rs
use crate::config::{AppConfig, APP_MANAGED_SERVER_ARGS};
use crate::runtime;
use serde::Serialize;
use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

const MAX_BENCH_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct BenchRow {
    pub test: String,
    pub size: String,
    pub batch: String,
    pub tps: f64,
}

/// Whether a benchmark ran to completion or was cut short. `rows` always
/// holds whatever was parsed from the process's output up to that point —
/// cancelling a run, or the process exiting non-zero or timing out partway
/// through, never discards rows that already printed.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BenchStatus {
    Complete,
    Partial,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
pub struct BenchResult {
    pub rows: Vec<BenchRow>,
    pub args: Vec<String>,
    pub status: BenchStatus,
    /// Why the run is `Partial`/`Cancelled`; absent when `Complete`.
    pub message: Option<String>,
}

/// Callback invoked on the benchmark's worker thread each time a new row is
/// parsed from the process's live output, so a caller can stream progress to
/// the frontend before the run finishes.
pub type BenchProgress = Arc<dyn Fn(&BenchRow) + Send + Sync>;

pub fn bench_bin(cfg: &AppConfig) -> Result<String, String> {
    if !cfg.active_backend.is_empty() || !cfg.active_build.is_empty() {
        if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
            return Err("runtime backend and build must be selected together".into());
        }
        let path = runtime::bench_bin_for(&cfg.active_backend, &cfg.active_build)?;
        if path.is_file() {
            return Ok(path.to_string_lossy().into_owned());
        }
        return Err(format!(
            "managed runtime is missing llama-bench: {}",
            path.display()
        ));
    }
    if let Ok(path) = which::which(runtime::bench_executable_name()) {
        return Ok(path.to_string_lossy().into_owned());
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let fallback =
        runtime::system_server_fallback(&local).with_file_name(runtime::bench_executable_name());
    if fallback.is_file() {
        return Ok(fallback.to_string_lossy().into_owned());
    }
    Err("llama-bench was not found on PATH or in the WinGet package directory".into())
}

fn parse(text: &str) -> Vec<BenchRow> {
    if text
        .lines()
        .next()
        .is_some_and(|line| line.split(',').any(|field| field.trim() == "build_commit"))
    {
        return parse_llama_csv(text);
    }
    parse_legacy(text)
}

fn parse_llama_csv(text: &str) -> Vec<BenchRow> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(text.as_bytes());
    let Ok(headers) = reader.headers().cloned() else {
        return Vec::new();
    };
    let index = |name: &str| headers.iter().position(|header| header == name);
    let Some(batch_index) = index("n_batch") else {
        return Vec::new();
    };
    let Some(prompt_index) = index("n_prompt") else {
        return Vec::new();
    };
    let Some(generation_index) = index("n_gen") else {
        return Vec::new();
    };
    let Some(tps_index) = index("avg_ts") else {
        return Vec::new();
    };

    let mut rows = Vec::new();
    for record in reader.records().flatten() {
        let batch = record
            .get(batch_index)
            .and_then(|value| value.parse::<u32>().ok());
        let prompt = record
            .get(prompt_index)
            .and_then(|value| value.parse::<u32>().ok());
        let generation = record
            .get(generation_index)
            .and_then(|value| value.parse::<u32>().ok());
        let tps = record
            .get(tps_index)
            .and_then(|value| value.parse::<f64>().ok());
        let (Some(batch), Some(prompt), Some(generation), Some(tps)) =
            (batch, prompt, generation, tps)
        else {
            continue;
        };
        if prompt == 0 && generation == 0 || !tps.is_finite() {
            continue;
        }
        let (test, size) = match (prompt > 0, generation > 0) {
            (true, true) => ("prompt+generation", format!("{prompt}+{generation}")),
            (true, false) => ("prompt", prompt.to_string()),
            (false, true) => ("generation", generation.to_string()),
            (false, false) => continue,
        };
        rows.push(BenchRow {
            test: test.into(),
            size,
            batch: batch.to_string(),
            tps,
        });
    }
    rows
}

fn parse_legacy(text: &str) -> Vec<BenchRow> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line
                .split([',', '\t'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect();
            if fields.len() < 4 {
                return None;
            }
            let tps = fields[3].parse::<f64>().ok()?;
            tps.is_finite().then(|| BenchRow {
                test: fields[0].into(),
                size: fields[1].into(),
                batch: fields[2].into(),
                tps,
            })
        })
        .collect()
}

pub fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        let pid = pid.to_string();
        let _ = crate::procutil::std_command("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = crate::procutil::std_command("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn terminate(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let killed_tree = crate::procutil::std_command("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !killed_tree {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn join_pipe(
    handle: &mut Option<thread::JoinHandle<std::io::Result<Vec<u8>>>>,
) -> Result<Vec<u8>, String> {
    handle
        .take()
        .ok_or_else(|| "benchmark output reader was already joined".to_string())?
        .join()
        .map_err(|_| "benchmark output reader panicked".to_string())?
        .map_err(|error| format!("failed to read benchmark output: {error}"))
}

fn bounded_output<R: std::io::Read>(reader: R) -> std::io::Result<Vec<u8>> {
    let mut limited = reader.take(MAX_BENCH_OUTPUT_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes)?;
    bytes.truncate(MAX_BENCH_OUTPUT_BYTES);
    Ok(bytes)
}

/// Drain stdout line by line as it arrives (rather than blocking until EOF
/// like `bounded_output`) so a caller can see rows as soon as llama-bench
/// prints them, not only once the whole run finishes or is killed. Every
/// complete line is appended to the same bounded buffer `bounded_output`
/// would have produced; after each one, `parse` is re-run against everything
/// seen so far and any row past what was already reported is handed to
/// `progress`. Re-parsing on every line is O(lines^2), which is irrelevant
/// here: a benchmark run prints at most a few dozen rows.
fn stream_stdout<R: std::io::Read>(
    reader: R,
    progress: Option<BenchProgress>,
) -> std::io::Result<Vec<u8>> {
    let mut reader = std::io::BufReader::new(reader);
    let mut buffer: Vec<u8> = Vec::new();
    let mut known_rows = 0usize;
    loop {
        let mut line = Vec::new();
        if std::io::BufRead::read_until(&mut reader, b'\n', &mut line)? == 0 {
            break;
        }
        if buffer.len() < MAX_BENCH_OUTPUT_BYTES {
            let remaining = MAX_BENCH_OUTPUT_BYTES - buffer.len();
            let take = remaining.min(line.len());
            buffer.extend_from_slice(&line[..take]);
        }
        if let Some(progress) = &progress {
            let rows = parse(&String::from_utf8_lossy(&buffer));
            if rows.len() > known_rows {
                for row in &rows[known_rows..] {
                    progress(row);
                }
                known_rows = rows.len();
            }
        }
    }
    Ok(buffer)
}

/// How a benchmark process's run ended. Distinct from `BenchStatus`: this is
/// what actually happened to the process; `run` turns it into the row-aware
/// status the frontend sees, deciding along the way whether "no full exit"
/// still counts as usable (some rows captured) or as a hard failure (none).
enum ProcessOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
}

fn run_process(
    bin: &str,
    args: &[String],
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    active_pid: Option<Arc<Mutex<Option<u32>>>>,
    progress: Option<BenchProgress>,
) -> Result<(ProcessOutcome, Vec<u8>, Vec<u8>), String> {
    let mut command = crate::procutil::std_command(bin);
    command
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)));
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run {bin}: {error}"))?;
    if let Some(active_pid) = &active_pid {
        if let Ok(mut pid) = active_pid.lock() {
            *pid = Some(child.id());
        }
    }
    let _pid_guard = ActivePidGuard::new(active_pid.clone());
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate(&mut child);
            clear_active_pid(&active_pid);
            return Err("benchmark stdout pipe was not available".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate(&mut child);
            clear_active_pid(&active_pid);
            return Err("benchmark stderr pipe was not available".into());
        }
    };
    let mut stdout_reader = Some(thread::spawn(move || stream_stdout(stdout, progress)));
    let mut stderr_reader = Some(thread::spawn(move || bounded_output(stderr)));

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        if cancel.load(Ordering::Acquire) {
            terminate(&mut child);
            break ProcessOutcome::Cancelled;
        }
        match child.try_wait() {
            Ok(Some(status)) => break ProcessOutcome::Exited(status),
            Ok(None) => {}
            Err(error) => {
                terminate(&mut child);
                let _ = join_pipe(&mut stdout_reader);
                let _ = join_pipe(&mut stderr_reader);
                clear_active_pid(&active_pid);
                return Err(format!("failed to inspect benchmark process: {error}"));
            }
        }
        if Instant::now() >= deadline {
            terminate(&mut child);
            break ProcessOutcome::TimedOut;
        }
        thread::sleep(Duration::from_millis(100));
    };

    let stdout = join_pipe(&mut stdout_reader)?;
    let stderr = join_pipe(&mut stderr_reader)?;
    clear_active_pid(&active_pid);
    Ok((outcome, stdout, stderr))
}

fn clear_active_pid(active_pid: &Option<Arc<Mutex<Option<u32>>>>) {
    if let Some(active_pid) = active_pid {
        if let Ok(mut pid) = active_pid.lock() {
            *pid = None;
        }
    }
}

struct ActivePidGuard {
    active_pid: Option<Arc<Mutex<Option<u32>>>>,
}

impl ActivePidGuard {
    fn new(active_pid: Option<Arc<Mutex<Option<u32>>>>) -> Self {
        Self { active_pid }
    }
}

impl Drop for ActivePidGuard {
    fn drop(&mut self) {
        clear_active_pid(&self.active_pid);
    }
}

fn option_name(value: &str) -> &str {
    value.split_once('=').map_or(value, |(name, _)| name).trim()
}

fn supports_bench_option(value: &str) -> bool {
    matches!(
        option_name(value),
        "--batch-size"
            | "--ubatch-size"
            | "--threads"
            | "-t"
            | "--n-cpu-moe"
            | "--flash-attn"
            | "--device"
            | "--split-mode"
            | "--main-gpu"
            | "--tensor-split"
            | "--no-kv-offload"
            | "--no-op-offload"
            | "--no-host"
            | "--numa"
            | "--mmap"
            | "--no-mmap"
            | "--direct-io"
            | "--no-warmup"
            | "--progress"
            | "--cache-type-k"
            | "--cache-type-v"
            | "--mlock"
    )
}

pub fn build_args(cfg: &AppConfig) -> Vec<String> {
    let mut args = vec![
        "--model".into(),
        cfg.active_model.clone(),
        "--n-gpu-layers".into(),
        cfg.ngl.to_string(),
        "--batch-size".into(),
        cfg.batch_size.to_string(),
        "--ubatch-size".into(),
        cfg.ubatch_size.to_string(),
        "--cache-type-k".into(),
        cfg.cache_type_k.clone(),
        "--cache-type-v".into(),
        cfg.cache_type_v.clone(),
        "--repetitions".into(),
        cfg.iters.max(1).to_string(),
        "--output".into(),
        "csv".into(),
    ];
    if cfg.threads > 0 {
        args.extend(["--threads".into(), cfg.threads.to_string()]);
    }
    if cfg.n_cpu_moe > 0 {
        args.extend(["--n-cpu-moe".into(), cfg.n_cpu_moe.to_string()]);
    }
    if cfg.flash_attn != "auto" {
        args.extend(["--flash-attn".into(), cfg.flash_attn.clone()]);
    }
    let mut seen = std::collections::HashSet::new();
    for token in [
        "--model",
        "--n-gpu-layers",
        "--batch-size",
        "--ubatch-size",
        "--cache-type-k",
        "--cache-type-v",
        "--repetitions",
        "--output",
        "--threads",
        "--n-cpu-moe",
        "--flash-attn",
    ] {
        seen.insert(token);
    }
    let mut index = 0;
    while index < cfg.server_args.len() {
        let token = &cfg.server_args[index];
        let name = option_name(token);
        if APP_MANAGED_SERVER_ARGS.contains(&name) {
            if app_managed_option_consumes_next(&cfg.server_args, index) {
                index += 1;
            }
            index += 1;
            continue;
        }
        if !supports_bench_option(token) || seen.contains(name) {
            index += 1;
            continue;
        }
        args.push(token.clone());
        seen.insert(name);
        if !token.contains('=')
            && cfg
                .server_args
                .get(index + 1)
                .is_some_and(|value| !value.starts_with('-'))
        {
            args.push(cfg.server_args[index + 1].clone());
            index += 1;
        }
        index += 1;
    }
    crate::tuning_defaults::filter_args(cfg, args)
}

fn app_managed_option_consumes_next(args: &[String], index: usize) -> bool {
    let Some(argument) = args.get(index) else {
        return false;
    };
    if argument.contains('=') {
        return false;
    }
    if matches!(
        option_name(argument),
        "--no-api-key"
            | "--mmproj-auto"
            | "--no-mmproj"
            | "--no-mmproj-auto"
            | "--no-reasoning-preserve"
    ) {
        return false;
    }
    args.get(index + 1)
        .is_some_and(|value| !value.starts_with('-') || value.parse::<f64>().is_ok())
}

pub fn run(
    cfg: &AppConfig,
    cancel: Arc<AtomicBool>,
    active_pid: Option<Arc<Mutex<Option<u32>>>>,
) -> Result<BenchResult, String> {
    run_with_progress(cfg, cancel, active_pid, None)
}

/// Same as [`run`], but invokes `progress` on the worker thread for every row
/// parsed from llama-bench's output as it streams in, before the run itself
/// finishes. `run` is kept as a separate, simpler entry point so every
/// existing caller and test that has no frontend event loop to feed stays
/// unchanged.
pub fn run_with_progress(
    cfg: &AppConfig,
    cancel: Arc<AtomicBool>,
    active_pid: Option<Arc<Mutex<Option<u32>>>>,
    progress: Option<BenchProgress>,
) -> Result<BenchResult, String> {
    let bin = bench_bin(cfg)?;
    let args = build_args(cfg);
    let environment = if cfg.active_backend.is_empty() && cfg.active_build.is_empty() {
        runtime::child_environment()
    } else {
        runtime::child_environment_for_runtime(&cfg.active_backend, &cfg.active_build)?
    };
    let timeout = Duration::from_secs(30 * 60);
    let (outcome, stdout, stderr) = run_process(
        &bin,
        &args,
        &environment,
        cancel,
        timeout,
        active_pid,
        progress,
    )?;
    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = String::from_utf8_lossy(&stderr);
    let rows = parse(&stdout);
    classify_outcome(outcome, args, rows, stderr.trim(), timeout)
}

/// Turn a finished process's outcome plus whatever rows were parsed from its
/// output into the `BenchResult`/error contract the frontend sees. Pulled out
/// of `run_with_progress` so it can be unit-tested against a real
/// `ProcessOutcome` (built from an actual short-lived child's exit status)
/// without needing a real llama-bench binary to drive the whole pipeline.
fn classify_outcome(
    outcome: ProcessOutcome,
    args: Vec<String>,
    rows: Vec<BenchRow>,
    stderr: &str,
    timeout: Duration,
) -> Result<BenchResult, String> {
    let incomplete_reason = match &outcome {
        ProcessOutcome::Exited(status) if status.success() => None,
        ProcessOutcome::Exited(status) => {
            Some(format!("llama-bench exited with {status}: {stderr}"))
        }
        ProcessOutcome::TimedOut => Some(format!(
            "benchmark timed out after {} seconds",
            timeout.as_secs()
        )),
        ProcessOutcome::Cancelled => Some("benchmark cancelled".to_string()),
    };

    match incomplete_reason {
        None => {
            if rows.is_empty() {
                return Err(format!("no benchmark rows parsed. stderr: {stderr}"));
            }
            Ok(BenchResult {
                rows,
                args,
                status: BenchStatus::Complete,
                message: None,
            })
        }
        Some(reason) => {
            if rows.is_empty() {
                // Nothing usable was ever produced; preserve the original
                // plain-error contract for what used to be indistinguishable
                // failure modes (bad args, missing model, immediate crash).
                return Err(reason);
            }
            let status = if matches!(outcome, ProcessOutcome::Cancelled) {
                BenchStatus::Cancelled
            } else {
                BenchStatus::Partial
            };
            Ok(BenchResult {
                rows,
                args,
                status,
                message: Some(reason),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_llama_bench_csv_uses_header_names() {
        let header = "n_prompt,build_commit,avg_ts,n_gen,n_batch";
        let text = format!("{header}\n512,abc,664.56,0,2048\n");
        let rows = parse(&text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].test, "prompt");
        assert_eq!(rows[0].size, "512");
        assert_eq!(rows[0].batch, "2048");
        assert!((rows[0].tps - 664.56).abs() < 0.001);
    }

    #[test]
    fn malformed_benchmark_rows_are_skipped() {
        let text = "test,size,batch,tps\nfoo,1,2,not-a-number\nbar,4,8,3.5\n";
        let rows = parse(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].test, "bar");
    }

    #[test]
    fn active_pid_guard_clears_the_slot_on_drop() {
        let active_pid = Arc::new(Mutex::new(Some(1234)));
        {
            let _guard = ActivePidGuard::new(Some(active_pid.clone()));
        }
        assert_eq!(*active_pid.lock().unwrap(), None);
    }

    #[test]
    fn benchmark_args_reflect_chat_runtime_and_skip_server_only_flags() {
        let cfg = AppConfig {
            active_model: "model.gguf".into(),
            ngl: 42,
            batch_size: 1024,
            ubatch_size: 256,
            cache_type_k: "q8_0".into(),
            cache_type_v: "q8_0".into(),
            flash_attn: "on".into(),
            threads: 8,
            server_args: vec!["--parallel".into(), "1".into(), "--jinja".into()],
            ..AppConfig::default()
        };
        let args = build_args(&cfg);
        assert!(args.windows(2).any(|pair| pair == ["--n-gpu-layers", "42"]));
        assert!(args.windows(2).any(|pair| pair == ["--threads", "8"]));
        assert!(args.windows(2).any(|pair| pair == ["--flash-attn", "on"]));
        assert!(args.windows(2).any(|pair| pair == ["--batch-size", "1024"]));
        assert!(args.windows(2).any(|pair| pair == ["--ubatch-size", "256"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--cache-type-k", "q8_0"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--cache-type-v", "q8_0"]));
        assert!(!args
            .iter()
            .any(|arg| arg == "--parallel" || arg == "--jinja"));
    }

    #[test]
    fn process_drains_large_stdout_without_deadlocking() {
        let (bin, args) = if cfg!(windows) {
            (
                "cmd",
                vec![
                    "/C".to_string(),
                    "for /L %i in (1,1,50000) do @echo benchmark-%i".to_string(),
                ],
            )
        } else {
            (
                "sh",
                vec![
                    "-c".to_string(),
                    "yes benchmark | head -c 200000".to_string(),
                ],
            )
        };
        let (outcome, stdout, _stderr) = run_process(
            bin,
            &args,
            &runtime::child_environment(),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(10),
            None,
            None,
        )
        .expect("flooding child should complete");
        assert!(matches!(outcome, ProcessOutcome::Exited(status) if status.success()));
        assert!(stdout.len() > 100_000);
    }

    #[test]
    fn process_cancel_terminates_sleeping_child_and_reports_cancelled_not_an_error() {
        let (bin, args) = if cfg!(windows) {
            (
                "cmd",
                vec!["/C".to_string(), "ping 127.0.0.1 -n 6 >NUL".to_string()],
            )
        } else {
            ("sh", vec!["-c".to_string(), "sleep 5".to_string()])
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let child_cancel = cancel.clone();
        let environment = runtime::child_environment();
        let handle = std::thread::spawn(move || {
            run_process(
                bin,
                &args,
                &environment,
                child_cancel,
                Duration::from_secs(10),
                None,
                None,
            )
        });
        std::thread::sleep(Duration::from_millis(200));
        cancel.store(true, Ordering::Release);
        let (outcome, _stdout, _stderr) = handle
            .join()
            .expect("benchmark worker should join")
            .expect("cancellation is a normal outcome, not a spawn/pipe failure");
        assert!(matches!(outcome, ProcessOutcome::Cancelled));
    }

    #[test]
    fn benchmark_pipe_reader_caps_untrusted_output() {
        let input = vec![b'x'; MAX_BENCH_OUTPUT_BYTES + 128];
        let output = bounded_output(std::io::Cursor::new(input)).expect("reader should succeed");
        assert_eq!(output.len(), MAX_BENCH_OUTPUT_BYTES);
    }

    fn row(tps: f64) -> BenchRow {
        BenchRow {
            test: "prompt".into(),
            size: "512".into(),
            batch: "2048".into(),
            tps,
        }
    }

    fn exit_status(code: i32) -> std::process::ExitStatus {
        if cfg!(windows) {
            std::process::Command::new("cmd")
                .args(["/C", "exit", &code.to_string()])
                .status()
        } else {
            std::process::Command::new("sh")
                .args(["-c", &format!("exit {code}")])
                .status()
        }
        .expect("spawn a trivial child to obtain a real ExitStatus")
    }

    #[test]
    fn classify_outcome_reports_complete_only_on_a_successful_exit_with_rows() {
        let result = classify_outcome(
            ProcessOutcome::Exited(exit_status(0)),
            vec!["--model".into()],
            vec![row(100.0)],
            "",
            Duration::from_secs(60),
        )
        .expect("a successful exit with rows must not error");
        assert_eq!(result.status, BenchStatus::Complete);
        assert!(result.message.is_none());
        assert_eq!(result.rows.len(), 1);
    }

    #[test]
    fn classify_outcome_keeps_the_legacy_plain_error_when_nothing_was_ever_parsed() {
        let error = classify_outcome(
            ProcessOutcome::Exited(exit_status(0)),
            vec![],
            vec![],
            "unexpected argument",
            Duration::from_secs(60),
        )
        .unwrap_err();
        assert!(error.contains("no benchmark rows parsed"));

        let error = classify_outcome(
            ProcessOutcome::Exited(exit_status(1)),
            vec![],
            vec![],
            "fatal error",
            Duration::from_secs(60),
        )
        .unwrap_err();
        assert!(error.contains("llama-bench exited with"));

        let error = classify_outcome(
            ProcessOutcome::Cancelled,
            vec![],
            vec![],
            "",
            Duration::from_secs(60),
        )
        .unwrap_err();
        assert!(error.contains("cancelled"));
    }

    #[test]
    fn classify_outcome_returns_partial_rows_and_status_on_nonzero_exit() {
        let result = classify_outcome(
            ProcessOutcome::Exited(exit_status(1)),
            vec!["--model".into()],
            vec![row(50.0), row(60.0)],
            "crashed mid-run",
            Duration::from_secs(60),
        )
        .expect("rows captured before a crash must still come back as Ok");
        assert_eq!(result.status, BenchStatus::Partial);
        assert_eq!(result.rows.len(), 2);
        assert!(result.message.unwrap().contains("crashed mid-run"));
    }

    #[test]
    fn classify_outcome_returns_cancelled_rows_and_status_on_cancellation() {
        let result = classify_outcome(
            ProcessOutcome::Cancelled,
            vec!["--model".into()],
            vec![row(75.0)],
            "",
            Duration::from_secs(60),
        )
        .expect("a cancelled run with rows must still come back as Ok");
        assert_eq!(result.status, BenchStatus::Cancelled);
        assert_eq!(result.rows.len(), 1);
        assert!(result.message.is_some());
    }

    #[test]
    fn classify_outcome_returns_partial_on_timeout_with_rows() {
        let result = classify_outcome(
            ProcessOutcome::TimedOut,
            vec![],
            vec![row(10.0)],
            "",
            Duration::from_secs(1800),
        )
        .expect("rows captured before a timeout must still come back as Ok");
        assert_eq!(result.status, BenchStatus::Partial);
        assert!(result.message.unwrap().contains("1800"));
    }

    #[test]
    fn stream_stdout_reports_each_new_row_as_it_arrives_and_still_returns_full_bytes() {
        let text = "n_prompt,build_commit,avg_ts,n_gen,n_batch\n\
                     512,abc,100.0,0,2048\n\
                     0,abc,50.0,128,2048\n";
        let seen: Arc<Mutex<Vec<BenchRow>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let progress: BenchProgress = Arc::new(move |row: &BenchRow| {
            sink.lock().unwrap().push(row.clone());
        });
        let bytes = stream_stdout(std::io::Cursor::new(text.as_bytes()), Some(progress))
            .expect("reading from an in-memory cursor cannot fail");
        assert_eq!(bytes, text.as_bytes());
        let reported = seen.lock().unwrap();
        assert_eq!(reported.len(), 2);
        assert!((reported[0].tps - 100.0).abs() < 0.001);
        assert!((reported[1].tps - 50.0).abs() < 0.001);
    }
}
