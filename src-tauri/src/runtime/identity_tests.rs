use super::*;

#[test]
fn full_runtime_listing_keeps_json_order_and_fresh_nested_sizes() {
    use super::listing_fixture::{assert_json, Fixture};
    use serde_json::json;
    let mut fixture = Fixture::new();
    for name in ["b10-cpu", "b9-cuda", "b9-cpu"] {
        fixture.write(&format!("{name}/{}", server_executable_name()), b"server");
        fixture.write(&format!("{name}/{}", bench_executable_name()), b"bench");
    }
    let version = br#"{"semver":"synthetic","build":9,"commit":"abc"}"#;
    let source = br#"{"pull_request":7,"repository":"synthetic/runtime","commit":"abc","archive_sha256":"fixture","url":"synthetic"}"#;
    fixture.write("b9-cpu/aiolm-runtime.json", version);
    fixture.write("b9-cpu/aiolm-runtime-source.json", source);
    fixture.write("b9-cuda/llama-board-runtime.json", version);
    fixture.write("b9-cpu/nested/payload", b"12345");
    let mb = |bytes: usize| bytes as f64 / 1_048_576.0;
    let mut expected = json!([
        {"build":"b9","backend":"cpu","dir":fixture.root.join("b9-cpu").to_str().unwrap(),"size_mb":mb(11+version.len()+source.len()+5),
         "version":{"semver":"synthetic","build":9,"commit":"abc"},
         "source":{"pull_request":7,"repository":"synthetic/runtime","commit":"abc","archive_sha256":"fixture","url":"synthetic","head_ref":"","author":"","state":"","fork":false,"commit_check":""}},
        {"build":"b9","backend":"cuda","dir":fixture.root.join("b9-cuda").to_str().unwrap(),"size_mb":mb(11+version.len()),"version":{"semver":"synthetic","build":9,"commit":"abc"}},
        {"build":"b10","backend":"cpu","dir":fixture.root.join("b10-cpu").to_str().unwrap(),"size_mb":mb(11)}
    ]);
    assert_json(
        "full initial",
        serde_json::to_value(list_installed_in(&fixture.root)).unwrap(),
        expected.clone(),
    );
    fixture.write("b9-cpu/nested/payload", b"12345678901234567");
    expected[0]["size_mb"] = json!(mb(11 + version.len() + source.len() + 17));
    assert_json(
        "full grown child",
        serde_json::to_value(list_installed_in(&fixture.root)).unwrap(),
        expected.clone(),
    );
    fixture.remove_file("b9-cpu/nested/payload");
    expected[0]["size_mb"] = json!(mb(11 + version.len() + source.len()));
    assert_json(
        "full removed child",
        serde_json::to_value(list_installed_in(&fixture.root)).unwrap(),
        expected,
    );
    fixture.finish();
}

#[test]
fn full_runtime_listing_keeps_the_depth_boundary() {
    use super::listing_fixture::{assert_json, Fixture};
    use serde_json::json;
    let mut fixture = Fixture::new();
    fixture.write(&format!("b1-cpu/{}", server_executable_name()), b"s");
    fixture.write(&format!("b1-cpu/{}", bench_executable_name()), b"b");
    let mut relative = String::from("b1-cpu");
    for depth in 1..=33 {
        relative.push_str("/d");
        fixture.directory(&relative);
        if depth == 32 {
            fixture.write(&format!("{relative}/included"), b"12345");
        }
        if depth == 33 {
            fixture.write(&format!("{relative}/excluded"), b"1234567890123");
        }
    }
    let expected = json!([{"build":"b1","backend":"cpu","dir":fixture.root.join("b1-cpu").to_str().unwrap(),"size_mb":7.0/1_048_576.0}]);
    assert_json(
        "full depth boundary",
        serde_json::to_value(list_installed_in(&fixture.root)).unwrap(),
        expected,
    );
    fixture.finish();
}

#[test]
fn public_backend_requires_manifest_version_and_exact_server_bytes() {
    let root = test_directory("observed-bundle-backend");
    fs::create_dir_all(&root).unwrap();
    let binary = root.join(server_executable_name());
    fs::write(&binary, b"synthetic server").unwrap();
    let version = RuntimeVersion {
        semver: "0.8.0-dev".into(),
        build: 12345,
        commit: "abcdef123".into(),
    };
    assert_eq!(reported_bundle_backend(&root, &binary, &version), None);
    let mut manifest = test_bundle_manifest(&root);
    manifest.backend = "metal".into();
    manifest.version = Some(version.clone());
    fs::write(
        root.join(RUNTIME_BUNDLE_MANIFEST),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert_eq!(
        reported_bundle_backend(&root, &binary, &version).as_deref(),
        Some("metal")
    );
    let mut other_version = version.clone();
    other_version.build += 1;
    assert_eq!(
        reported_bundle_backend(&root, &binary, &other_version),
        None
    );
    // Same-length replacements must not inherit the old bundle's backend.
    fs::write(&binary, b"replacement data").unwrap();
    assert_eq!(reported_bundle_backend(&root, &binary, &version), None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_identifiers_reject_traversal_and_invalid_values() {
    assert!(validate_runtime_identifiers("../outside", "b10603").is_err());
    assert!(validate_runtime_identifiers("vulkan", "../../outside").is_err());
    assert!(validate_runtime_identifiers("future-backend", "b10603").is_ok());
    assert!(validate_runtime_identifiers("vulkan", "b10603").is_ok());
    assert!(validate_runtime_identifiers("cuda", "pr27342").is_ok());
    assert!(validate_runtime_identifiers("cuda", "pr0").is_err());
    assert!(validate_runtime_identifiers("cuda", "pr").is_err());
}

#[test]
fn verification_identity_changes_when_vendor_code_or_kernel_data_changes() {
    let root = test_directory("runtime-identity");
    fs::create_dir_all(root.join(".kpack")).unwrap();
    fs::write(root.join("llama-server.exe"), b"same engine").unwrap();
    fs::write(root.join("amdhip64_7.dll"), b"old HIP").unwrap();
    let before = runtime_file_identity(&root);
    assert_eq!(before, runtime_file_identity(&root));
    fs::write(root.join("amdhip64_7.dll"), b"fixed HIP runtime").unwrap();
    let fixed = runtime_file_identity(&root);
    assert_ne!(before, fixed);
    fs::write(root.join("diagnostic.log"), b"irrelevant").unwrap();
    assert_eq!(fixed, runtime_file_identity(&root));
    fs::write(root.join(".kpack/blas.kpack"), b"new kernels").unwrap();
    let kernels = runtime_file_identity(&root);
    assert_ne!(fixed, kernels);
    fs::remove_file(root.join("amdhip64_7.dll")).unwrap();
    assert_ne!(kernels, runtime_file_identity(&root));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_version_is_parsed_from_the_llama_server_banner() {
    let parsed = parse_runtime_version(
        "version: 0.3.0-dev (build 10638, commit bf9421646)\nbuilt with Clang 20.1.8",
    )
    .expect("banner should parse");
    assert_eq!(parsed.semver, "0.3.0-dev");
    assert_eq!(parsed.build, 10638);
    assert_eq!(parsed.commit, "bf9421646");

    let released = parse_runtime_version("version: 0.2.0 (build 10603, commit c060ca974)")
        .expect("banner should parse");
    assert_eq!(released.semver, "0.2.0");
    assert_eq!(released.build, 10603);
}

#[test]
fn the_recorded_runtime_version_leads_with_the_release_the_runtime_named() {
    assert_eq!(
        version_label(
            "version: 0.3.0-dev (build 10638, commit bf9421646)\nbuilt with Clang 20.1.8"
        )
        .as_deref(),
        Some("0.3.0-dev (build 10638, commit bf9421646)")
    );
    // A banner without a commit still names the release and the build.
    assert_eq!(
        version_label("version: 0.2.0 (build 10603)").as_deref(),
        Some("0.2.0 (build 10603)")
    );
    // Nothing is assembled from a banner this build cannot read, so no
    // record ever carries a version the runtime did not state.
    assert!(version_label("llama-server\nbuilt with Clang 20.1.8").is_none());
    assert!(version_label("").is_none());
}

#[test]
fn unparseable_version_banners_are_rejected() {
    for text in [
        "",
        "llama-server",
        "version: (build 10638)",
        "version: 0.3.0-dev (commit bf9421646)",
        "version: 0.3.0-dev build 10638",
    ] {
        assert!(parse_runtime_version(text).is_none(), "{text:?}");
    }
}

#[tokio::test]
async fn a_drained_stream_never_closes_the_pipe_early() {
    // The regression: capping with a take() adapter returned as soon as
    // the limit was hit, dropping the pipe under a still-running child. A
    // real CMake build then died on a broken pipe (or blocked on a full
    // one) long before it produced a binary.
    let cap = 4 * 1024;
    let (reader, mut writer) = tokio::io::duplex(1024);
    let drained = tokio::spawn(drain_stream(reader, cap, Retain::Head));
    let mut written = Vec::new();
    for index in 0..64_u8 {
        let chunk = vec![b'a' + index % 26; 1024];
        writer
            .write_all(&chunk)
            .await
            .expect("a live child must never see a closed pipe");
        written.extend_from_slice(&chunk);
    }
    drop(writer);
    let output = drained.await.expect("drain task should finish");
    assert_eq!(written.len(), 64 * 1024);
    assert_eq!(output, written[..cap]);
}

#[tokio::test]
async fn a_drained_stream_keeps_the_tail_of_a_long_log() {
    let cap = 4 * 1024;
    let (reader, mut writer) = tokio::io::duplex(1024);
    let drained = tokio::spawn(drain_stream(reader, cap, Retain::Tail));
    let mut written = Vec::new();
    for index in 0..64_u8 {
        let chunk = vec![b'a' + index % 26; 1024];
        writer.write_all(&chunk).await.expect("write chunk");
        written.extend_from_slice(&chunk);
    }
    writer
        .write_all(b"fatal error C1083")
        .await
        .expect("write the diagnostic that matters");
    written.extend_from_slice(b"fatal error C1083");
    drop(writer);
    let output = drained.await.expect("drain task should finish");
    assert_eq!(output.len(), cap);
    assert_eq!(output, written[written.len() - cap..]);
}

#[tokio::test]
async fn a_single_oversized_chunk_is_reduced_to_its_tail() {
    let cap = 64;
    let payload = (0..4096_u32)
        .map(|value| (value % 251) as u8)
        .collect::<Vec<_>>();
    let output = drain_stream(payload.as_slice(), cap, Retain::Tail).await;
    assert_eq!(output, payload[payload.len() - cap..]);
}

#[test]
fn local_builds_are_distinct_and_cannot_escape_the_runtime_directory() {
    assert!(validate_runtime_identifiers("rocm", "local_b10840_nop2p").is_ok());
    for build in ["local_", "local_../b10840", "local_x-y", "local_x\\y"] {
        assert!(
            validate_runtime_identifiers("rocm", build).is_err(),
            "{build}"
        );
    }
    let local = runtime_dir("rocm", "local_b10840_nop2p").unwrap();
    assert_eq!(local.file_name().unwrap(), "local_b10840_nop2p-rocm");
    assert_ne!(local, runtime_dir("rocm", "b10840").unwrap());
}

#[test]
fn a_build_gets_what_cmake_and_its_generator_need_on_every_platform() {
    let allowed = every_allowlisted_name();
    // Compiler and generator selection.
    for name in ["CC", "CXX", "CMAKE_GENERATOR", "CMAKE_BUILD_PARALLEL_LEVEL"] {
        assert!(allowed.contains(&name), "{name}");
    }
    // SDK discovery for every backend a PR build supports.
    for name in ["CUDA_PATH", "CUDA_HOME", "VULKAN_SDK", "VK_SDK_PATH"] {
        assert!(allowed.contains(&name), "{name}");
    }
    // Keep the user's explicit GPU selection intact after the runtime
    // child environment is cleared.
    for name in [
        "CUDA_VISIBLE_DEVICES",
        "HIP_VISIBLE_DEVICES",
        "ROCR_VISIBLE_DEVICES",
        "ONEAPI_DEVICE_SELECTOR",
        "ZE_AFFINITY_MASK",
    ] {
        assert!(allowed.contains(&name), "{name}");
    }
    // Proxy, corporate CA trust, and Git - the three that decide whether a
    // build works on someone else's PC rather than only on a developer's.
    for name in [
        "HTTPS_PROXY",
        "https_proxy",
        "SSL_CERT_FILE",
        "GIT_EXEC_PATH",
    ] {
        assert!(allowed.contains(&name), "{name}");
    }
    // Enough OS to start a process at all, per platform.
    #[cfg(windows)]
    for name in [
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
        "ProgramFiles",
        "APPDATA",
    ] {
        assert!(allowed.contains(&name), "{name}");
    }
    #[cfg(target_os = "macos")]
    for name in ["DEVELOPER_DIR", "SDKROOT", "HOME"] {
        assert!(allowed.contains(&name), "{name}");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    for name in ["LD_LIBRARY_PATH", "HOME", "XDG_CACHE_HOME"] {
        assert!(allowed.contains(&name), "{name}");
    }
}

#[test]
fn a_short_commit_is_what_git_would_abbreviate_to() {
    assert_eq!(
        short_commit("0123456789abcdef0123456789abcdef01234567"),
        "0123456"
    );
    assert_eq!(short_commit("abc"), "abc");
    assert_eq!(short_commit(""), "");
}
