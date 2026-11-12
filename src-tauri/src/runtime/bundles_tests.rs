use super::*;

#[test]
fn bundle_manifest_paths_are_normalized_and_safe() {
    for valid in ["llama-server.exe", "rocblas/library/kernel.bin"] {
        assert!(validate_bundle_manifest_path(valid).is_ok(), "{valid}");
    }
    for invalid in [
        "",
        "../outside.dll",
        "nested/../../outside.dll",
        "nested\\outside.dll",
        "C:/outside.dll",
        "/outside.dll",
    ] {
        let error = validate_bundle_manifest_path(invalid).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation, "{invalid}");
    }
}

#[test]
fn bundle_file_manifest_round_trips_with_source_provenance() {
    let root = test_directory("bundle-roundtrip");
    fs::create_dir_all(&root).expect("create test runtime");
    fs::write(root.join(server_executable_name()), b"server").expect("write server");
    fs::write(root.join(bench_executable_name()), b"bench").expect("write bench");
    let source = test_source();
    write_source_manifest(&root, &source).expect("write source manifest");
    let manifest = test_bundle_manifest(&root);
    validate_bundle_manifest(&manifest).expect("validate test manifest");
    verify_bundle_files(&root, &manifest).expect("verify test bundle");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_bundle_names_remain_verified_and_readable() {
    let root = test_directory("legacy-bundle");
    let runtime = root.join("pr27342-cpu");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(runtime.join(server_executable_name()), b"server").unwrap();
    fs::write(runtime.join(bench_executable_name()), b"bench").unwrap();
    write_source_manifest(&runtime, &test_source()).unwrap();
    fs::rename(
        runtime.join(SOURCE_MANIFEST),
        runtime.join("llama-board-runtime-source.json"),
    )
    .unwrap();
    let manifest = test_bundle_manifest(&runtime);
    fs::write(
        runtime.join("llama-board-runtime-bundle.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let archive = root.join("legacy.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for entry in fs::read_dir(&runtime).unwrap() {
        let entry = entry.unwrap();
        zip.start_file(
            format!("pr27342-cpu/{}", entry.file_name().to_string_lossy()),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        std::io::copy(&mut fs::File::open(entry.path()).unwrap(), &mut zip).unwrap();
    }
    zip.finish().unwrap();
    let extracted = root.join("extracted");
    extract(&archive, &extracted, &Arc::new(AtomicBool::new(false))).unwrap();
    let imported = find_bundle_runtime_root(&extracted).unwrap();
    let manifest = read_bundle_manifest(&imported).unwrap();
    verify_bundle_files(&imported, &manifest).unwrap();
    assert_eq!(read_source_manifest(&imported), Some(test_source()));
    fs::write(imported.join(server_executable_name()), b"tampered").unwrap();
    let error = verify_bundle_files(&imported, &manifest).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bundle_file_verification_rejects_missing_source_manifest() {
    let root = test_directory("bundle-missing-source");
    fs::create_dir_all(&root).expect("create test runtime");
    fs::write(root.join(server_executable_name()), b"server").expect("write server");
    fs::write(root.join(bench_executable_name()), b"bench").expect("write bench");
    let error = verify_bundle_files(&root, &test_bundle_manifest(&root))
        .expect_err("missing source manifest must be rejected");
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(error.message.contains("source provenance"));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn bundle_import_keeps_missing_archive_errors() {
    let archive = test_directory("missing-bundle").join("missing.zip");
    let error = import_bundle(&archive, &|_, _, _| {}, Arc::new(AtomicBool::new(false)))
        .await
        .unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::NotFound);
}

/// This is intentionally opt-in and ignored: it copies the locally
/// installed multi-GB ROCm PR runtime into an isolated data folder, then
/// exercises the same export/import path a second PC uses.
#[cfg(windows)]
#[tokio::test]
#[ignore]
async fn live_pr27342_rocm_bundle_round_trips_without_host_sdk() {
    if crate::branding::env_var("AIOLM_LIVE_BUNDLE_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }
    let installed = runtimes_root().join("pr27342-rocm");
    if !installed.is_dir() {
        return;
    }
    let original_home = std::env::var_os("AIOLM_HOME");
    let isolated_home = test_directory("live-bundle-home");
    let isolated_runtime = isolated_home.join("runtimes").join("pr27342-rocm");
    fs::create_dir_all(isolated_runtime.parent().expect("runtime parent"))
        .expect("create isolated runtime parent");
    let cancel = Arc::new(AtomicBool::new(false));
    copy_runtime_tree(&installed, &isolated_runtime, &cancel).expect("copy live runtime");
    std::env::set_var("AIOLM_HOME", &isolated_home);
    let progress: ProgressSink = &|_, _, _| {};
    let archive = isolated_home.join("pr27342-rocm-portable.zip");
    let _result = async {
        let exported = export_bundle(&archive, "rocm", "pr27342", progress, &cancel)
            .expect("export live ROCm runtime");
        assert!(Path::new(&exported.path).is_file());
        assert!(Path::new(&(exported.path.clone() + ".sha256")).is_file());
        let imported = import_bundle(&archive, progress, cancel.clone())
            .await
            .expect("import live ROCm runtime");
        assert_eq!(imported.backend, "rocm");
        assert_eq!(imported.build, "pr27342");
        assert!(isolated_runtime.join("rocblas/library").is_dir());
        assert!(isolated_runtime.join("hipblaslt/library").is_dir());
        assert!(isolated_runtime.join("vcomp140.dll").is_file());
    }
    .await;
    match original_home {
        Some(home) => std::env::set_var("AIOLM_HOME", home),
        None => std::env::remove_var("AIOLM_HOME"),
    }
    let _ = fs::remove_dir_all(isolated_home);
}

/// Explicit real-environment check: the caller supplies an empty data
/// folder, an engine directory, an SDK and the pinned canary weights.
/// The resulting portable bundle is kept there for inspection/import.
#[cfg(windows)]
#[tokio::test]
#[ignore = "requires a ROCm SDK, two GPUs and an isolated AIOLM_HOME directory"]
async fn live_rocm_sdk_bundle_passes_dual_gpu_verification() {
    let input = |name: &str| PathBuf::from(std::env::var_os(name).expect(name));
    let engine = input("AIOLM_LIVE_ROCM_ENGINE");
    let sdk = input("AIOLM_LIVE_ROCM_SDK");
    let canary = input("AIOLM_LIVE_ROCM_CANARY");
    let isolated = input("AIOLM_LIVE_ROCM_HOME");
    assert_eq!(
        std::env::var_os("AIOLM_HOME"),
        Some(isolated.clone().into_os_string())
    );
    assert!(
        fs::read_dir(&isolated).map_or(true, |mut entries| entries.next().is_none()),
        "use an empty test AIOLM_HOME"
    );
    let build = "local_rocm_verified";
    let destination = runtime_dir("rocm", build).unwrap();
    fs::create_dir_all(&destination).unwrap();
    for entry in fs::read_dir(&engine).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if entry.file_type().unwrap().is_file()
            && (name.starts_with("ggml")
                || name.starts_with("llama")
                || matches!(name.as_str(), "mtmd.dll" | "libomp.dll")
                || name.starts_with("license"))
        {
            fs::copy(entry.path(), destination.join(entry.file_name())).unwrap();
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    copy_backend_runtime_dependencies_from_roots("rocm", &destination, &cancel, &[sdk]).unwrap();
    copy_msvc_runtime_dependencies(&destination, &cancel).unwrap();
    assert_eq!(
        sha256_file(&engine.join("ggml-hip.dll")).unwrap(),
        sha256_file(&destination.join("ggml-hip.dll")).unwrap()
    );
    let progress: ProgressSink = &|_, _, _| {};
    println!("ROCm bundle: packaged SDK dependencies; running preflight");
    let version = preflight_staged_runtime(&destination, "rocm", progress, &cancel)
        .await
        .unwrap()
        .expect("engine version");
    write_version_manifest(&destination, &version);
    let verification = isolated.join("verification");
    fs::create_dir_all(&verification).unwrap();
    fs::copy(canary, verification.join("stories15M-q4_0.gguf")).unwrap();
    let cfg = crate::config::AppConfig {
        active_backend: "rocm".into(),
        active_build: build.into(),
        ngl: 99,
        ..Default::default()
    };
    let placement = crate::gpu::ResolvedGpu {
        device_flag: Some("ROCm0,ROCm1".into()),
        split_mode: Some("layer"),
        tensor_split: vec![1.0, 1.0],
        ..Default::default()
    };
    let devices = probe("rocm", build).await.unwrap().devices;
    crate::verify::ensure_verified(
        &cfg,
        &placement,
        "explicit-live-test",
        &devices,
        Some(&cancel),
    )
    .await
    .unwrap();
    let archive = isolated.join("rocm-verified.zip");
    println!("ROCm bundle: dual GPU gate passed; exporting");
    let exported = export_bundle(&archive, "rocm", build, progress, &cancel).unwrap();
    println!("ROCm bundle: exported; importing and verifying again");
    let imported = import_bundle(&archive, progress, cancel.clone())
        .await
        .unwrap();
    assert_eq!(imported.build, build);
    assert_eq!(imported.backend, "rocm");
    crate::verify::ensure_verified(
        &cfg,
        &placement,
        "explicit-live-test",
        &devices,
        Some(&cancel),
    )
    .await
    .unwrap();
    println!("Verified ROCm bundle SHA-256: {}", exported.archive_sha256);
}
