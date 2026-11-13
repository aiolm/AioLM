use super::*;

#[test]
fn archive_extraction_rejects_path_traversal() {
    let root = test_directory("bundle-traversal");
    let archive = root.join("input.zip");
    let destination = root.join("extracted");
    fs::create_dir_all(&root).expect("create archive test root");
    write_test_archive(&archive, "../outside.dll", b"unsafe");
    let cancel = Arc::new(AtomicBool::new(false));
    let error =
        extract(&archive, &destination, &cancel).expect_err("path traversal must be rejected");
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(error.message.contains("unsafe path") || error.message.contains("escapes"));
    assert!(!root.join("outside.dll").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_extraction_accepts_a_normalized_runtime_root() {
    let root = test_directory("bundle-extract");
    let archive = root.join("input.zip");
    let destination = root.join("extracted");
    fs::create_dir_all(&root).expect("create archive test root");
    write_test_archive(&archive, "pr27342-cpu/llama-server.exe", b"server");
    let cancel = Arc::new(AtomicBool::new(false));
    extract(&archive, &destination, &cancel).expect("safe archive should extract");
    assert_eq!(
        fs::read(destination.join("pr27342-cpu/llama-server.exe")).expect("read extracted"),
        b"server"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn replacement_succeeds_when_old_backup_cleanup_fails() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-replace-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let destination = root.join("runtime");
    let staging = root.join("staging");
    fs::create_dir_all(&destination).expect("create old runtime");
    fs::write(destination.join("version"), b"old").expect("write old runtime");
    fs::create_dir_all(&staging).expect("create new runtime");
    fs::write(staging.join("version"), b"new").expect("write new runtime");

    let result = replace_runtime_with(&staging, &destination, |_| {
        Err("simulated backup cleanup failure".into())
    });

    assert!(result.is_ok());
    assert_eq!(
        fs::read(destination.join("version")).expect("read active runtime"),
        b"new"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn staged_preflight_allows_more_time_than_an_interactive_probe() {
    // The first launch of a freshly extracted 100-250 MB runtime is
    // dominated by on-access virus scanning; the 8s interactive budget
    // aborts the install before llama-server reaches main().
    assert!(STAGED_PREFLIGHT_TIMEOUT > PROBE_TIMEOUT);
    assert!(STAGED_PREFLIGHT_TIMEOUT >= Duration::from_secs(180));
}

#[test]
fn cuda_architectures_prefer_the_gpus_this_pc_actually_has() {
    // One RTX 4090: compile 89 once, not five generations, and keep PTX so
    // a newer card dropped in later still runs the same install.
    assert_eq!(
        cuda_architectures(None, &["8.9".to_string()]),
        "89-real;89-virtual"
    );
    // Two different cards: real code for both, PTX for the newer one.
    assert_eq!(
        cuda_architectures(None, &["8.6".to_string(), "7.5".to_string()]),
        "75-real;86-real;86-virtual"
    );
    // Duplicates are one architecture, not two compiles.
    assert_eq!(
        cuda_architectures(None, &["8.9".to_string(), "8.9".to_string()]),
        "89-real;89-virtual"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn cpu_preflight_accepts_a_machine_without_accelerators() {
    use std::os::unix::fs::PermissionsExt;
    let root = test_directory("cpu-preflight");
    fs::create_dir_all(&root).expect("create staged CPU runtime");
    let server = root.join(server_executable_name());
    let devices_path = root.join("devices.txt");
    fs::write(&devices_path, b"Available devices:\n(none)\n").unwrap();
    fs::write(&server, b"#!/bin/sh\ncase \"$1\" in\n--version) echo 'version: 0.1.0 (123)';;\n--list-devices) /bin/cat \"${0%/*}/devices.txt\";;\n*) echo 'help';;\nesac\n").unwrap();
    fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();
    let progress: ProgressSink = &|_, _, _| {};
    let cancel = Arc::new(AtomicBool::new(false));
    // A server-only runtime passes; llama-bench is optional.
    assert!(preflight_staged_runtime(&root, "cpu", progress, &cancel)
        .await
        .is_ok());
    // A present but broken optional helper does not gate activation either.
    let bench = root.join(bench_executable_name());
    fs::write(&bench, b"#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&bench, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(preflight_staged_runtime(&root, "cpu", progress, &cancel)
        .await
        .is_ok());
    assert!(preflight_staged_runtime(&root, "vulkan", progress, &cancel)
        .await
        .unwrap_err()
        .message
        .contains("no accelerator"));
    // Keep the launched executable immutable while changing reported devices.
    for devices in [
        "warning: HIP backend could not be loaded\nAvailable devices:\n(none)\n",
        "Available devices:\nVulkan0: Synthetic GPU (8192 MiB, 8192 MiB free)\n",
    ] {
        fs::write(&devices_path, devices).unwrap();
        let error = preflight_staged_runtime(&root, "rocm", progress, &cancel)
            .await
            .unwrap_err();
        assert!(
            error.message.contains("no accelerator"),
            "ROCm preflight for {devices:?}: {error}"
        );
    }
    fs::write(
        &devices_path,
        b"Available devices:\nROCm0: Synthetic GPU (8192 MiB, 8192 MiB free)\n",
    )
    .unwrap();
    assert!(preflight_staged_runtime(&root, "rocm", progress, &cancel)
        .await
        .is_ok());
    let _ = fs::remove_dir_all(root);
}
