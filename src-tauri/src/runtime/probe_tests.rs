use super::*;

#[test]
fn probe_flags_ignores_dash_only_help_separators() {
    let flags = probe_flags("----- --help --ctx-size");
    assert_eq!(flags, vec!["--help", "--ctx-size"]);
}

#[test]
fn preflight_requires_every_server_check() {
    assert_eq!(classify_preflight(true, true, true), "available");
    for failed in 0..3 {
        let [version, help, devices] = std::array::from_fn(|index| index != failed);
        assert_eq!(
            classify_preflight(version, help, devices),
            "failed preflight"
        );
    }
}

#[test]
fn failed_probe_output_is_diagnostic_and_never_a_reported_capability() {
    let reports = [
        "version: 0.1.0 (build 123, commit abcdef)",
        "--model FILE --spec-type {none,draft-dflash}",
        "Vulkan0: Synthetic GPU",
        "llama-bench --help",
    ];
    for failed in 0..4 {
        let probes = std::array::from_fn(|index| ProbeCommand {
            success: index != failed,
            text: reports[index].into(),
            diagnostic: (index == failed).then(|| "synthetic loader failure".into()),
        });
        let capabilities = capabilities_from_probes(
            "cpu".into(),
            "b123".into(),
            Path::new("synthetic-runtime"),
            None,
            probes,
        );
        // A failed optional llama-bench check never gates serving readiness.
        let expected_state = if failed == 3 {
            "available"
        } else {
            "failed preflight"
        };
        assert_eq!(capabilities.state, expected_state);
        assert_eq!(capabilities.version.is_empty(), failed == 0);
        assert_eq!(capabilities.flags.is_empty(), failed == 1);
        assert_eq!(capabilities.server_help.is_empty(), failed == 1);
        assert_eq!(capabilities.supports_dflash, failed != 1);
        assert_eq!(capabilities.devices.is_empty(), failed == 2);
        assert_eq!(capabilities.bench_available, failed != 3);
        let expected_diagnostic = if failed == 3 {
            "optional llama-bench check failed: synthetic loader failure"
        } else {
            "synthetic loader failure"
        };
        assert_eq!(capabilities.diagnostics, [expected_diagnostic]);
    }
}

#[test]
fn an_absent_optional_helper_is_unavailable_without_a_diagnostic() {
    let ok = |text: &str| ProbeCommand {
        success: true,
        text: text.into(),
        diagnostic: None,
    };
    let absent = ProbeCommand {
        success: false,
        text: String::new(),
        diagnostic: None,
    };
    let capabilities = capabilities_from_probes(
        "cpu".into(),
        "b123".into(),
        Path::new("synthetic-runtime"),
        None,
        [
            ok("version: 0.1.0 (build 123, commit abcdef)"),
            ok("--model FILE"),
            ok("CPU: synthetic"),
            absent,
        ],
    );
    assert_eq!(capabilities.state, "available");
    assert!(!capabilities.bench_available);
    assert!(capabilities.diagnostics.is_empty());
    // A missing vendor dependency still blocks, with or without the helper.
    let blocked = capabilities_from_probes(
        "cuda".into(),
        "b123".into(),
        Path::new("synthetic-runtime"),
        Some("missing vendor libraries".into()),
        [
            ok("v"),
            ok("--model FILE"),
            ok("CUDA0: synthetic"),
            ok("llama-bench"),
        ],
    );
    assert_eq!(blocked.state, "failed preflight");
}

#[tokio::test]
async fn a_build_that_outruns_the_log_cap_still_runs_to_completion() {
    let mut command = noisy_command();
    configure_build_process_group(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = TransientChild::spawn(&mut command).expect("spawn the noisy child");
    let cancel = Arc::new(AtomicBool::new(false));
    let progress: ProgressSink = &|_, _, _| {};
    let output = supervise_build_child(
        child,
        progress,
        "building",
        "test build",
        &cancel,
        Duration::from_secs(30),
    )
    .await
    .expect("a noisy child must still be waited on successfully");
    assert!(output.status.success(), "{:?}", output.status);
    // More output than the cap was written, and only the tail was kept.
    assert_eq!(output.stdout.len(), MAX_BUILD_LOG_TAIL);
}

#[tokio::test]
async fn an_abandoned_reader_still_hands_back_what_it_read() {
    // A grandchild that inherited the pipe can keep it open past the join
    // deadline. Aborting the task must not throw away the log: that is
    // exactly the case where the user needs the diagnostic.
    let log = shared_log(4096, Retain::Tail);
    let (reader, mut writer) = tokio::io::duplex(1024);
    let task = tokio::spawn(drain_stream_into(reader, log.clone()));
    writer
        .write_all(b"fatal error C1083: cannot open include file")
        .await
        .expect("write the diagnostic that matters");
    // The writer is deliberately never dropped, so the drain never ends.
    let output = finish_build_reader(task, &log, Duration::from_millis(200)).await;
    assert_eq!(output, b"fatal error C1083: cannot open include file");
    drop(writer);
}

#[tokio::test]
async fn a_finished_reader_is_joined_without_waiting_out_the_budget() {
    let log = shared_log(4096, Retain::Tail);
    let task = tokio::spawn(drain_stream_into(
        b"configure output".as_slice(),
        log.clone(),
    ));
    let started = Instant::now();
    let output = finish_build_reader(task, &log, Duration::from_secs(30)).await;
    assert_eq!(output, b"configure output");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn dflash_support_is_probed_from_exact_help_tokens_not_a_build_name() {
    assert!(help_supports_dflash(
        "--spec-type [none,draft-simple,draft-dflash]"
    ));
    assert!(!help_supports_dflash("--spec-type [none,draft-simple]"));
    assert!(!help_supports_dflash("--draft-dflash-option"));
}

#[tokio::test]
async fn a_cancelled_runtime_probe_returns_before_resolving_the_runtime() {
    let cancel = Arc::new(AtomicBool::new(true));
    let error = probe_cancellable("invalid backend", "invalid build", &cancel)
        .await
        .expect_err("a cancelled start must not launch another probe process");
    assert_eq!(error.message, "server start cancelled");
    assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
}

#[tokio::test]
async fn a_cancelled_build_kills_the_child_and_reports_the_cancel() {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/c", "ping -n 60 127.0.0.1 > nul"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 60"]);
        command
    };
    configure_build_process_group(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = TransientChild::spawn(&mut command).expect("spawn a long child");
    // Already cancelled: the supervisor must not wait out the sleep.
    let cancel = Arc::new(AtomicBool::new(true));
    let progress: ProgressSink = &|_, _, _| {};
    let started = Instant::now();
    let error = supervise_build_child(
        child,
        progress,
        "building",
        "test build",
        &cancel,
        Duration::from_secs(30),
    )
    .await
    .expect_err("a cancelled build must not report success");
    assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
    assert!(error.message.contains("cancelled"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(30));
}

/// The deterministic timeout seam: a fake child that never exits on its
/// own must still be killed and reported within a short, injected
/// deadline, without waiting for its full runtime. The child also writes
/// a fixed diagnostic to stderr before it would otherwise be killed, so
/// this also proves the timeout error carries the phase, how long it
/// ran, and the tail of whatever diagnostic the child managed to emit —
/// not just the fact that a timeout occurred.
#[tokio::test]
async fn a_build_that_outlives_its_deadline_is_killed_and_reported() {
    const DIAGNOSTIC_MARKER: &str = "TIMEOUT_DIAGNOSTIC_MARKER_9F3A";
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args([
            "/c",
            &format!("echo {DIAGNOSTIC_MARKER} 1>&2 && ping -n 60 127.0.0.1 > nul"),
        ]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("sh");
        command.args(["-c", &format!("echo {DIAGNOSTIC_MARKER} 1>&2; sleep 60")]);
        command
    };
    configure_build_process_group(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = TransientChild::spawn(&mut command).expect("spawn a long child");
    let cancel = Arc::new(AtomicBool::new(false));
    let progress: ProgressSink = &|_, _, _| {};
    let deadline = Duration::from_millis(200);
    let started = Instant::now();
    let error = supervise_build_child(child, progress, "building", "test build", &cancel, deadline)
        .await
        .expect_err("a build past its deadline must not report success");
    assert_eq!(error.kind, crate::error::ErrorKind::Timeout);
    assert!(error.message.contains("timeout"), "{error}");
    assert!(error.message.contains("test build"), "{error}");
    assert!(
        error.message.contains(DIAGNOSTIC_MARKER),
        "error must include the child's last diagnostic output: {error}"
    );
    // The deadline must be enforced, not merely observed after the fact:
    // this must return in well under the child's 60-second sleep.
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "deadline enforcement took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn probe_output_is_capped_from_the_front() {
    // Version banners and --help are read from the start, so the cap keeps
    // the head - the opposite of a build log.
    let payload = vec![b'x'; MAX_PROBE_OUTPUT + 4096];
    let output = read_probe_output(payload.as_slice()).await;
    assert_eq!(output.len(), MAX_PROBE_OUTPUT);
    assert!(output.iter().all(|byte| *byte == b'x'));
}

#[tokio::test]
async fn a_timed_out_probe_retains_its_initialization_diagnostic() {
    let binary = which::which("node").expect("Node test fixture");
    let result = run_probe_with(
        &binary,
        &["-e", "process.stderr.write('synthetic backend initialization\\n'); setInterval(() => {}, 1000);"],
        Duration::from_secs(3),
    ).await;
    assert!(!result.success);
    assert!(result.text.contains("synthetic backend initialization"));
    let diagnostic = result.diagnostic.unwrap();
    assert_eq!(diagnostic.kind, crate::error::ErrorKind::Timeout);
    assert!(diagnostic
        .message
        .contains("synthetic backend initialization"));
}

#[tokio::test]
async fn a_failed_probe_retains_a_bounded_initialization_diagnostic() {
    let binary = which::which("node").expect("Node test fixture");
    let script = format!(
        "process.stdout.write('λ'.repeat({})); process.stderr.write('missing synthetic libbackend.so\\n'); process.exitCode = 127;",
        MAX_BUILD_DETAIL_CHARS * 2,
    );
    let result = run_probe_with(&binary, &["-e", &script], Duration::from_secs(3)).await;
    assert!(!result.success);
    assert!(result.text.contains("missing synthetic libbackend.so"));
    let diagnostic = result.diagnostic.expect("failed probe diagnostic");
    let (status, detail) = diagnostic
        .message
        .split_once('\n')
        .expect("probe output detail");
    assert!(status.starts_with("runtime probe exited with "));
    assert!(detail.ends_with("missing synthetic libbackend.so"));
    assert!(detail.contains('λ'));
    assert!(!detail.contains('�'));
    assert!(detail.chars().count() <= MAX_BUILD_DETAIL_CHARS);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_cold_device_probe_can_finish_after_eight_seconds() {
    use std::os::unix::fs::PermissionsExt;
    let root = test_directory("cold-device-probe");
    fs::create_dir_all(&root).unwrap();
    let binary = root.join("synthetic-runtime");
    fs::write(
        &binary,
        "#!/bin/sh\n/bin/sleep 9\nprintf 'Available devices:\\n(none)\\n'\n",
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    let result = run_probe(&binary, &["--list-devices"]).await;
    let _ = fs::remove_dir_all(root);
    assert!(result.success, "{:?}", result.diagnostic);
    assert!(result.text.contains("Available devices:"));
}
