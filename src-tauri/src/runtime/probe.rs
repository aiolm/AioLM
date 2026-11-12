use super::*;

/// Run one of a managed runtime's own tools and return its combined output.
///
/// The correctness gate needs the same isolation the capability probe already
/// applies — cleared environment plus only the runtime's own library paths —
/// so it shares that path instead of spawning the tool directly.
/// Callers currently run llama-perplexity, using llama.cpp's common argument
/// parser. This wrapper applies inference placement flags for CPU execution;
/// do not use it for capability probes or llama-bench's separate argument parser.
pub async fn run_runtime_tool(
    binary: &Path,
    backend: &str,
    build: &str,
    args: &[&str],
    limit: Duration,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<String, AppError> {
    if !binary.is_file() {
        return Err(AppError::not_found(format!(
            "runtime tool is missing: {}",
            binary.display()
        )));
    }
    let environment = child_environment_for_runtime(backend, build)?;
    let mut effective_args = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    if backend == "cpu" {
        crate::inference_args::force_cpu(&mut effective_args);
    }
    let args = effective_args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let outcome =
        run_probe_with_cancel_and_environment(binary, &args, limit, cancel, &environment).await;
    if let Some(diagnostic) = outcome.diagnostic {
        return Err(diagnostic);
    }
    if !outcome.success {
        return Err(AppError::internal(format!(
            "{} exited without success: {}",
            binary.display(),
            tail_lines(&outcome.text, 4)
        )));
    }
    Ok(outcome.text)
}

/// Keep a failure message readable without losing the operative last lines.
fn tail_lines(text: &str, count: usize) -> String {
    let mut lines = text
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(count)
        .collect::<Vec<_>>();
    lines.reverse();
    lines.join(" | ")
}

pub(super) struct ProbeCommand {
    pub(super) success: bool,
    pub(super) text: String,
    pub(super) diagnostic: Option<AppError>,
}

pub(super) async fn read_probe_output<R>(reader: R) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    drain_stream(reader, MAX_PROBE_OUTPUT, Retain::Head).await
}

async fn finish_reader(mut task: OwnedTask<Vec<u8>>, limit: Duration) -> Vec<u8> {
    match timeout(limit, &mut task).await {
        Ok(Ok(output)) => output,
        _ => {
            task.abort();
            let _ = task.await;
            Vec::new()
        }
    }
}

async fn finish_probe_reader(task: OwnedTask<Vec<u8>>) -> Vec<u8> {
    finish_reader(task, PROBE_READER_TIMEOUT).await
}

/// Join a build drain task, and if it will not end - a grandchild is still
/// holding the inherited pipe - abandon it but keep whatever it already read.
pub(super) async fn finish_build_reader(
    task: impl Into<OwnedTask<()>>,
    log: &SharedLog,
    limit: Duration,
) -> Vec<u8> {
    let mut task = task.into();
    if timeout(limit, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
    read_log(log)
}

async fn terminate_probe(child: &mut TransientChild) {
    child.terminate();
    let _ = child.wait().await;
}

/// Put every CMake configure/build child in a private process group on Unix.
/// A CMake generator starts a compiler process (and often another wrapper)
/// beneath it; killing only the direct child leaves that grandchild compiling
/// against a tree that cleanup is about to remove.
pub(super) fn configure_build_process_group(command: &mut Command) {
    crate::procutil::configure_process_group(command);
}

/// Build commands share the same tree owner and shutdown gate as probes/MCP.
pub(super) async fn terminate_build_child(child: &mut TransientChild) {
    child.terminate();
    let _ = child.wait().await;
}

pub(super) async fn run_probe(binary: &Path, args: &[&str]) -> ProbeCommand {
    run_probe_with(binary, args, PROBE_TIMEOUT).await
}

enum ProbeWaitOutcome {
    Exited(Result<std::process::ExitStatus, String>),
    Cancelled,
    TimedOut,
}

async fn wait_probe_child(
    child: &mut TransientChild,
    limit: Duration,
    cancel: Option<&Arc<AtomicBool>>,
) -> ProbeWaitOutcome {
    match cancel {
        None => match timeout(limit, child.wait()).await {
            Ok(Ok(status)) => ProbeWaitOutcome::Exited(Ok(status)),
            Ok(Err(error)) => ProbeWaitOutcome::Exited(Err(error.to_string())),
            Err(_) => ProbeWaitOutcome::TimedOut,
        },
        Some(cancel) => {
            let wait = async {
                loop {
                    tokio::select! {
                        result = child.wait() => {
                            return ProbeWaitOutcome::Exited(result.map_err(|error| error.to_string()));
                        }
                        _ = sleep(Duration::from_millis(100)) => {
                            if cancel.load(Ordering::Acquire) {
                                return ProbeWaitOutcome::Cancelled;
                            }
                        }
                    }
                }
            };
            match timeout(limit, wait).await {
                Ok(outcome) => outcome,
                Err(_) => ProbeWaitOutcome::TimedOut,
            }
        }
    }
}

pub(super) async fn run_probe_with(binary: &Path, args: &[&str], limit: Duration) -> ProbeCommand {
    run_probe_with_cancel(binary, args, limit, None).await
}

async fn run_probe_with_cancel(
    binary: &Path,
    args: &[&str],
    limit: Duration,
    cancel: Option<&Arc<AtomicBool>>,
) -> ProbeCommand {
    let environment = child_environment();
    run_probe_with_cancel_and_environment(binary, args, limit, cancel, &environment).await
}

pub(super) async fn run_probe_with_cancel_and_environment(
    binary: &Path,
    args: &[&str],
    limit: Duration,
    cancel: Option<&Arc<AtomicBool>>,
    environment: &[(OsString, OsString)],
) -> ProbeCommand {
    let mut command = crate::procutil::tokio_command(binary);
    crate::procutil::configure_process_group(&mut command);
    command
        .kill_on_drop(true)
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)));
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match TransientChild::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            return ProbeCommand {
                success: false,
                text: String::new(),
                diagnostic: Some(AppError::io(
                    &format!("cannot run {}", args.join(" ")),
                    &error,
                )),
            };
        }
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_probe(&mut child).await;
        return ProbeCommand {
            success: false,
            text: String::new(),
            diagnostic: Some("runtime probe stdout was not captured".into()),
        };
    };
    let stdout_task: OwnedTask<_> = tokio::spawn(read_probe_output(stdout)).into();
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| OwnedTask::from(tokio::spawn(read_probe_output(stderr))));
    let status = match wait_probe_child(&mut child, limit, cancel).await {
        ProbeWaitOutcome::Exited(Ok(status)) => status,
        ProbeWaitOutcome::Exited(Err(error)) => {
            terminate_probe(&mut child).await;
            let _ = finish_probe_reader(stdout_task).await;
            if let Some(task) = stderr_task {
                let _ = finish_probe_reader(task).await;
            }
            return ProbeCommand {
                success: false,
                text: String::new(),
                diagnostic: Some(AppError::internal(format!(
                    "runtime probe wait failed: {error}"
                ))),
            };
        }
        ProbeWaitOutcome::Cancelled => {
            terminate_probe(&mut child).await;
            let _ = finish_probe_reader(stdout_task).await;
            if let Some(task) = stderr_task {
                let _ = finish_probe_reader(task).await;
            }
            return ProbeCommand {
                success: false,
                text: String::new(),
                diagnostic: Some(AppError::cancelled("runtime install cancelled")),
            };
        }
        ProbeWaitOutcome::TimedOut => {
            terminate_probe(&mut child).await;
            let stdout = finish_probe_reader(stdout_task).await;
            let stderr = match stderr_task {
                Some(task) => finish_probe_reader(task).await,
                None => Vec::new(),
            };
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            );
            let detail = tail_chars(&text, MAX_BUILD_DETAIL_CHARS);
            return ProbeCommand {
                success: false,
                text,
                diagnostic: Some(AppError::timeout(format!(
                    "runtime probe timed out after {}s: {}\n{}",
                    limit.as_secs(),
                    args.join(" "),
                    detail.trim(),
                ))),
            };
        }
    };
    let stdout = finish_probe_reader(stdout_task).await;
    let stderr = match stderr_task {
        Some(task) => finish_probe_reader(task).await,
        None => Vec::new(),
    };
    let mut combined = String::from_utf8_lossy(&stdout).into_owned();
    let stderr_text = String::from_utf8_lossy(&stderr);
    if !stderr_text.trim().is_empty() {
        combined.push('\n');
        combined.push_str(stderr_text.trim());
    }
    let diagnostic = (!status.success()).then(|| {
        let mut diagnostic = format!("runtime probe exited with {status}: {}", args.join(" "));
        let detail = tail_chars(combined.trim(), MAX_BUILD_DETAIL_CHARS);
        if !detail.is_empty() {
            diagnostic.push('\n');
            diagnostic.push_str(&detail);
        }
        AppError::internal(diagnostic)
    });
    ProbeCommand {
        success: status.success(),
        text: combined,
        diagnostic,
    }
}

pub(super) fn probe_flags(help: &str) -> Vec<String> {
    let mut flags = Vec::new();
    for token in help.split_whitespace() {
        let flag = token
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '-');
        if !flag.starts_with("--")
            || flag.len() < 3
            || !flag[2..]
                .chars()
                .any(|character| character.is_ascii_alphanumeric())
            || flags.iter().any(|item| item == flag)
        {
            continue;
        }
        flags.push(flag.to_string());
        if flags.len() >= 500 {
            break;
        }
    }
    flags
}

pub(super) fn probe_devices(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(100)
        .map(str::to_string)
        .collect()
}

/// Serving readiness depends only on llama-server's own probes. llama-bench is
/// an optional diagnostic helper: its result is reported separately and never
/// decides availability.
pub(super) fn classify_preflight(version: bool, help: bool, devices: bool) -> &'static str {
    if version && help && devices {
        "available"
    } else {
        "failed preflight"
    }
}

pub async fn probe(backend: &str, build: &str) -> Result<RuntimeCapabilities, AppError> {
    probe_with_cancel(backend, build, None).await
}

pub async fn probe_cancellable(
    backend: &str,
    build: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<RuntimeCapabilities, AppError> {
    probe_with_cancel(backend, build, Some(cancel)).await
}

async fn probe_with_cancel(
    backend: &str,
    build: &str,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<RuntimeCapabilities, AppError> {
    let cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::Acquire));
    if cancelled() {
        return Err(AppError::cancelled("server start cancelled"));
    }
    let (resolved_backend, resolved_build, binary) = if backend.is_empty() && build.is_empty() {
        let binary = which::which(server_executable_name()).map_err(|_| {
            AppError::not_found("No llama.cpp runtime is selected, and llama-server could not be found on PATH. Open Inference engines, choose llama.cpp, and install or import a runtime. Then return to model settings and select that runtime.")
        })?;
        ("system".to_string(), "system".to_string(), binary)
    } else {
        validate_runtime_identifiers(backend, build)?;
        let binary = server_bin_for(backend, build)?;
        (backend.to_string(), build.to_string(), binary)
    };
    if !binary.is_file() {
        return Ok(RuntimeCapabilities {
            backend: resolved_backend,
            build: resolved_build,
            executable: binary.to_string_lossy().into_owned(),
            state: "not installed".into(),
            version: String::new(),
            flags: Vec::new(),
            server_help: String::new(),
            supports_dflash: false,
            devices: Vec::new(),
            diagnostics: vec!["llama-server executable is missing".into()],
            bench_available: false,
        });
    }
    let environment = if backend.is_empty() && build.is_empty() {
        child_environment()
    } else {
        child_environment_for_runtime(backend, build)?
    };
    let dependency_error = if !backend.is_empty()
        && matches!(backend, "cuda" | "rocm")
        && binary
            .parent()
            .is_some_and(|directory| !backend_runtime_dependencies_complete(backend, directory))
    {
        Some(format!(
            "the installed {backend} runtime is missing its bundled vendor libraries or kernel data. Reinstall or import this runtime so it does not depend on a host SDK."
        ))
    } else {
        None
    };
    let version = run_probe_with_cancel_and_environment(
        &binary,
        &["--version"],
        PROBE_TIMEOUT,
        cancel,
        &environment,
    )
    .await;
    if cancelled() {
        return Err(AppError::cancelled("server start cancelled"));
    }
    // Backfill the manifest for runtimes installed before it existed, so the
    // list stops showing a bare build tag once the user probes them.
    if version.success && !backend.is_empty() && !build.is_empty() {
        if let (Some(parsed), Some(dir)) = (parse_runtime_version(&version.text), binary.parent()) {
            if read_version_manifest(dir).as_ref() != Some(&parsed) {
                write_version_manifest(dir, &parsed);
            }
        }
    }
    let help = run_probe_with_cancel_and_environment(
        &binary,
        &["--help"],
        PROBE_TIMEOUT,
        cancel,
        &environment,
    )
    .await;
    if cancelled() {
        return Err(AppError::cancelled("server start cancelled"));
    }
    let devices = run_probe_with_cancel_and_environment(
        &binary,
        &["--list-devices"],
        PROBE_TIMEOUT,
        cancel,
        &environment,
    )
    .await;
    if cancelled() {
        return Err(AppError::cancelled("server start cancelled"));
    }
    // llama-bench is optional. An absent helper is not a problem and adds no
    // diagnostic; a present helper is still executed, and only a successful
    // `--help` run reports it as available. File existence alone never does.
    let bench_binary = if backend.is_empty() && build.is_empty() {
        which::which(bench_executable_name()).ok().or_else(|| {
            binary
                .parent()
                .map(|parent| parent.join(bench_executable_name()))
        })
    } else {
        Some(bench_bin_for(backend, build)?)
    };
    let bench = match bench_binary {
        Some(path) if path.is_file() => {
            run_probe_with_cancel_and_environment(
                &path,
                &["--help"],
                PROBE_TIMEOUT,
                cancel,
                &environment,
            )
            .await
        }
        _ => ProbeCommand {
            success: false,
            text: String::new(),
            diagnostic: None,
        },
    };
    if cancelled() {
        return Err(AppError::cancelled("server start cancelled"));
    }
    Ok(capabilities_from_probes(
        resolved_backend,
        resolved_build,
        &binary,
        dependency_error,
        [version, help, devices, bench],
    ))
}

pub(super) fn capabilities_from_probes(
    backend: String,
    build: String,
    binary: &Path,
    dependency_error: Option<String>,
    [version, help, devices, bench]: [ProbeCommand; 4],
) -> RuntimeCapabilities {
    let mut diagnostics = Vec::new();
    if let Some(error) = dependency_error.as_ref() {
        diagnostics.push(error.clone());
    }
    for result in [&version, &help, &devices] {
        if let Some(diagnostic) = &result.diagnostic {
            diagnostics.push(diagnostic.message.clone());
        }
    }
    // Name the optional helper so its failure is not read as a server failure.
    if let Some(diagnostic) = &bench.diagnostic {
        diagnostics.push(format!("optional llama-bench check failed: {diagnostic}"));
    }
    let state = if dependency_error.is_some() {
        "failed preflight"
    } else {
        classify_preflight(version.success, help.success, devices.success)
    };
    // Failed commands can print plausible flags or device names while reporting
    // initialization errors. Keep that output in diagnostics, not capabilities.
    let help_text = if help.success { &help.text } else { "" };
    RuntimeCapabilities {
        backend,
        build,
        executable: binary.to_string_lossy().into_owned(),
        state: state.into(),
        version: if version.success {
            version.text.chars().take(4096).collect()
        } else {
            String::new()
        },
        flags: probe_flags(help_text),
        server_help: help_text.to_owned(),
        supports_dflash: help_supports_dflash(help_text),
        devices: if devices.success {
            probe_devices(&devices.text)
        } else {
            Vec::new()
        },
        diagnostics,
        bench_available: bench.success,
    }
}

pub(super) fn help_supports_dflash(help: &str) -> bool {
    help.split(|character: char| !(character.is_ascii_alphanumeric() || character == '-'))
        .any(|token| token == "draft-dflash")
}
