use super::*;

#[test]
fn source_build_options_select_exactly_the_requested_backend() {
    let source = Path::new("source");
    let build = Path::new("build");
    let cuda = source_build_configure_args("cuda", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
    assert!(cuda.iter().any(|arg| arg == "-DGGML_CUDA=ON"));
    assert!(!cuda.iter().any(|arg| arg == "-DGGML_VULKAN=ON"));
    let cpu = source_build_configure_args("cpu", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
    assert!(cpu.iter().any(|arg| arg == "-DGGML_CPU=ON"));
    assert!(
        source_build_configure_args("unknown", source, build, TEST_CUDA_ARCHITECTURES).is_err()
    );
}

#[test]
fn cmake_parallel_environment_is_not_overridden_by_a_bare_parallel_flag() {
    let root = Path::new("build");
    let default_args = source_build_args_with_parallelism(root, None);
    assert_eq!(
        default_args
            .iter()
            .filter(|arg| *arg == "--parallel")
            .count(),
        1
    );
    assert!(!default_args.iter().any(|arg| arg == "4"));

    let capped = source_build_args_with_parallelism(root, Some(" 4 "));
    let parallel = capped.iter().position(|arg| arg == "--parallel").unwrap();
    assert_eq!(capped.get(parallel + 1).map(String::as_str), Some("4"));

    // An invalid environment value must not accidentally turn into the
    // full-core default through a bare --parallel flag.
    let invalid = source_build_args_with_parallelism(root, Some("all-cores"));
    assert!(!invalid.iter().any(|arg| arg == "--parallel"));
    assert!(valid_parallelism("1"));
    assert!(!valid_parallelism("0"));
    assert!(!valid_parallelism("4 cores"));
}

#[test]
fn build_failures_report_the_end_of_the_log() {
    let mut log = "noise\n".repeat(20_000);
    log.push_str("fatal error C1083: cannot open include file");
    let detail = build_failure_detail(log.as_bytes(), b"   \n");
    assert!(detail.ends_with("fatal error C1083: cannot open include file"));
    assert!(detail.chars().count() <= MAX_BUILD_DETAIL_CHARS);
    assert!(detail.chars().count() > 100);

    let combined = build_failure_detail(b"configure output", b"ninja: build stopped");
    assert!(combined.contains("configure output"));
    assert!(combined.ends_with("ninja: build stopped"));
    assert!(build_failure_detail(b"", b"  ").is_empty());
}

#[test]
fn unsupported_backends_never_reach_a_cmake_configure() {
    let source = Path::new("source");
    let build = Path::new("build");
    for backend in ["sycl", "openvino", "unknown"] {
        assert!(
            source_build_configure_args(backend, source, build, TEST_CUDA_ARCHITECTURES).is_err(),
            "{backend}"
        );
    }
    let vulkan =
        source_build_configure_args("vulkan", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
    assert!(vulkan.iter().any(|arg| arg == "-DGGML_VULKAN=ON"));
    assert!(!vulkan.iter().any(|arg| arg.contains("GGML_HIP")
        || arg.contains("GGML_SYCL")
        || arg.contains("GGML_OPENVINO")));
    let rocm = source_build_configure_args("rocm", source, build, TEST_CUDA_ARCHITECTURES)
        .expect("ROCm is a supported local source backend");
    assert!(rocm.iter().any(|arg| arg == "-DGGML_HIP=ON"));
}

#[cfg(windows)]
#[test]
fn windows_rocm_build_uses_the_upstream_clang_ninja_recipe() {
    let args = source_build_configure_args(
        "rocm",
        Path::new("source"),
        Path::new("build"),
        TEST_CUDA_ARCHITECTURES,
    )
    .expect("ROCm is a supported local source backend");
    assert!(args
        .windows(2)
        .any(|pair| pair[0] == "-G" && pair[1] == "Ninja"));
    assert!(args.iter().any(|arg| arg == "-DCMAKE_C_COMPILER=clang"));
    assert!(args.iter().any(|arg| arg == "-DCMAKE_CXX_COMPILER=clang++"));
    assert!(!args
        .iter()
        .any(|arg| arg.starts_with("-DGGML_CUDA_NO_PEER_COPY=")));
}

#[test]
fn a_pr_configure_stays_inside_the_downloaded_archive() {
    let args = source_build_configure_args(
        "cpu",
        Path::new("source"),
        Path::new("build"),
        TEST_CUDA_ARCHITECTURES,
    )
    .expect("cpu configures");
    // BoringSSL is a FetchContent Git clone that also needs Go; curl and
    // OpenSSL power a download path aiolm never uses. All three are
    // network dependencies outside the pinned source archive.
    for option in SOURCE_BUILD_OFFLINE_OPTIONS {
        assert!(args.iter().any(|arg| arg == option), "{option}");
    }
    assert!(!args.iter().any(|arg| arg.ends_with("BORINGSSL=ON")));
    assert!(!args.iter().any(|arg| arg == "-DLLAMA_CURL=ON"));
}

#[test]
fn build_failures_name_the_thing_the_user_has_to_fix() {
    let hint = |log: &str| build_failure_hint(log).unwrap_or_default();
    assert!(hint(
        "CMake Error at cmake/FetchContent.cmake:1 (message): Failed to clone repository"
    )
    .contains("Git"));
    assert!(hint(
        "fatal: unable to access 'https://boringssl.googlesource.com/': Could not resolve proxy"
    )
    .contains("proxy"));
    assert!(hint("No CMAKE_CXX_COMPILER could be found.").contains("compiler"));
    assert!(hint("fatal error C1083: No space left on device").contains("disk"));
    assert!(
        hint("nvcc fatal   : Unsupported gpu architecture 'compute_120'").contains("CUDA Toolkit")
    );
    assert!(hint("glslc: error: cannot compile shader").contains("Vulkan"));
    // An unrecognised failure gets no invented advice.
    assert_eq!(build_failure_hint("undefined reference to `foo'"), None);
}

#[test]
fn the_extracted_tree_has_to_carry_the_commit_that_was_requested() {
    let commit = "0123456789abcdef0123456789abcdef01234567";
    assert_eq!(
        archive_commit_check(Path::new(&format!("/tmp/llama.cpp-{commit}")), commit),
        ArchiveCommitCheck::Matches
    );
    // GitHub names the directory from the ref in the URL, so a different
    // sha there means a different tree than the one that was approved.
    let other = "ffffffffffffffffffffffffffffffffffffffff";
    assert_eq!(
        archive_commit_check(Path::new(&format!("/tmp/llama.cpp-{other}")), commit),
        ArchiveCommitCheck::Mismatch(other.to_string())
    );
    // A layout with no commit in it proves nothing either way, and must
    // not be reported as a pass.
    for name in ["llama.cpp", "llama.cpp-b10638", "llama.cpp-main"] {
        assert_eq!(
            archive_commit_check(Path::new("/tmp").join(name).as_path(), commit),
            ArchiveCommitCheck::Unknown,
            "{name}"
        );
    }
    assert_ne!(COMMIT_CHECK_MATCHED, COMMIT_CHECK_UNKNOWN);
}

#[test]
fn a_pr_build_produces_the_server_and_verification_tool_and_nothing_else() {
    let args = source_build_args(Path::new("build"));
    for target in SOURCE_BUILD_TARGETS {
        assert!(args.iter().any(|arg| arg == target), "{target}");
    }
    // GPU verification refuses a runtime without it before the server starts.
    assert!(SOURCE_BUILD_TARGETS.contains(&perplexity_executable_name().trim_end_matches(".exe")));
    assert!(args.iter().any(|arg| arg == "--target"));
    assert!(args.iter().any(|arg| arg == "Release"));
    assert!(args.iter().any(|arg| arg == "--parallel"));

    let configure = source_build_configure_args(
        "cpu",
        Path::new("source"),
        Path::new("build"),
        TEST_CUDA_ARCHITECTURES,
    )
    .expect("cpu configures");
    assert!(configure.iter().any(|arg| arg == "-DLLAMA_BUILD_SERVER=ON"));
    assert!(configure.iter().any(|arg| arg == "-DLLAMA_BUILD_TESTS=OFF"));
    assert!(configure
        .iter()
        .any(|arg| arg == "-DLLAMA_BUILD_EXAMPLES=OFF"));
    // The server web UI is disabled; nothing here may ask for a Node
    // toolchain or a fetched asset.
    assert!(configure.iter().any(|arg| arg == "-DLLAMA_BUILD_UI=OFF"));
    assert!(configure
        .iter()
        .any(|arg| arg == "-DLLAMA_USE_PREBUILT_UI=OFF"));
}

#[test]
fn cuda_architectures_fall_back_to_a_portable_list_when_nothing_is_detected() {
    assert_eq!(cuda_architectures(None, &[]), CUDA_ARCHITECTURES_PORTABLE);
    // Junk from nvidia-smi is not a detection.
    assert_eq!(
        cuda_architectures(None, &["".into(), "N/A".into()]),
        CUDA_ARCHITECTURES_PORTABLE
    );
    // The fallback keeps PTX, so it stays portable to newer hardware.
    assert!(CUDA_ARCHITECTURES_PORTABLE.contains("-virtual"));
}

#[test]
fn a_user_supplied_cuda_architecture_list_wins_but_is_still_validated() {
    assert_eq!(
        cuda_architectures(Some("90-real"), &["8.9".to_string()]),
        "90-real"
    );
    assert_eq!(cuda_architectures(Some(" all "), &[]), "all");
    assert_eq!(
        cuda_architectures(Some("75-real;80-virtual"), &[]),
        "75-real;80-virtual"
    );
    // Anything that is not an architecture list is ignored rather than
    // pasted onto the configure command line.
    for hostile in [
        "89-real;-DCMAKE_CXX_FLAGS=-w",
        "89 && calc.exe",
        "$(whoami)",
        "",
        "   ",
    ] {
        assert_eq!(
            cuda_architectures(Some(hostile), &["8.9".to_string()]),
            "89-real;89-virtual",
            "{hostile:?} must not reach the configure"
        );
    }
}

#[test]
fn only_a_cuda_build_pins_an_architecture_list() {
    let configure = |backend: &str| {
        source_build_configure_args(backend, Path::new("source"), Path::new("build"), "89-real")
            .expect("configures")
    };
    assert!(configure("cuda")
        .iter()
        .any(|arg| arg == "-DCMAKE_CUDA_ARCHITECTURES=89-real"));
    for backend in ["cpu", "vulkan"] {
        assert!(
            !configure(backend)
                .iter()
                .any(|arg| arg.contains("CUDA_ARCHITECTURES")),
            "{backend}"
        );
    }
}

// ---- previously identified test gaps ----

#[test]
fn command_line_paths_survive_spaces_and_are_passed_as_single_arguments() {
    let source = Path::new("C:/Users/a b/source");
    let build = Path::new("C:/Users/a b/build");
    let args = source_build_configure_args("cpu", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
    // -S and -B carry the path as one argv entry; no quoting, no splitting.
    let position = args.iter().position(|arg| arg == "-S").expect("-S present");
    assert_eq!(args[position + 1], source.to_string_lossy());
    let position = args.iter().position(|arg| arg == "-B").expect("-B present");
    assert_eq!(args[position + 1], build.to_string_lossy());
    assert!(args.iter().all(|arg| !arg.contains('"')));
}

#[test]
fn the_source_root_is_the_single_directory_that_holds_a_cmakelists() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-source-root-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let nested = root.join("llama.cpp-0123456");
    fs::create_dir_all(&nested).expect("create nested source");
    // Nothing to find yet.
    assert!(find_source_root(&root).is_err());

    fs::write(nested.join("CMakeLists.txt"), b"project(x)").expect("write CMakeLists");
    assert_eq!(find_source_root(&root).expect("one root"), nested);

    // A tree whose own top level is the source root is used directly.
    fs::write(root.join("CMakeLists.txt"), b"project(x)").expect("write CMakeLists");
    assert_eq!(find_source_root(&root).expect("top level"), root);

    // Two candidates is ambiguous, and guessing would build the wrong one.
    fs::remove_file(root.join("CMakeLists.txt")).expect("remove top level");
    let second = root.join("llama.cpp-89abcdef");
    fs::create_dir_all(&second).expect("create second");
    fs::write(second.join("CMakeLists.txt"), b"project(x)").expect("write CMakeLists");
    assert!(find_source_root(&root).is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn the_built_runtime_directory_is_the_one_holding_the_server() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-built-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let release = root.join("bin").join("Release");
    fs::create_dir_all(&release).expect("create bin/Release");
    // Only the optional helper: a build without the server is not accepted.
    fs::write(release.join(bench_executable_name()), b"exe").expect("bench");
    let missing = find_built_runtime_dir(&root).unwrap_err();
    assert_eq!(missing.kind, crate::error::ErrorKind::NotFound);
    assert!(missing.message.contains(server_executable_name()));

    // The server alone is a complete result; llama-bench is not required.
    fs::remove_file(release.join(bench_executable_name())).expect("remove bench");
    fs::write(release.join(server_executable_name()), b"exe").expect("server");
    assert_eq!(find_built_runtime_dir(&root).expect("found"), release);
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn source_build_packaging_materializes_internal_library_aliases() {
    let root = test_directory("library-alias");
    let source = root.join("bin");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("libllama.so.0"), b"library").unwrap();
    std::os::unix::fs::symlink("libllama.so.0", source.join("libllama.so")).unwrap();
    let dest = root.join("staging");
    copy_runtime_tree(&source, &dest, &Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(fs::read(dest.join("libllama.so")).unwrap(), b"library");
    assert!(!fs::symlink_metadata(dest.join("libllama.so"))
        .unwrap()
        .file_type()
        .is_symlink());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn a_symlink_in_the_build_output_is_refused_rather_than_followed() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-symlink-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let source = root.join("out");
    let destination = root.join("staged");
    let secret = root.join("secret.txt");
    fs::create_dir_all(&source).expect("create out");
    fs::write(&secret, b"not yours").expect("write secret");
    std::os::unix::fs::symlink(&secret, source.join("link.txt")).expect("symlink");

    let cancel = Arc::new(AtomicBool::new(false));
    let error = copy_runtime_tree(&source, &destination, &cancel)
        .expect_err("a symlink must not be packaged");
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(error.message.contains("link escapes"), "{error}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_cancelled_copy_stops_instead_of_packaging_the_rest() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-copy-cancel-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let source = root.join("out");
    fs::create_dir_all(&source).expect("create out");
    for index in 0..4 {
        fs::write(source.join(format!("file{index}.bin")), b"data").expect("write");
    }
    let cancel = Arc::new(AtomicBool::new(true));
    let error = copy_runtime_tree(&source, &root.join("staged"), &cancel)
        .expect_err("a cancelled copy must not report success");
    assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
    assert!(error.message.contains("cancelled"), "{error}");
    let _ = fs::remove_dir_all(root);
}

/// CMake generators routinely leave a compiler wrapper or shell grandchild
/// behind. This must stay Unix-only: Windows has a separate taskkill-tree
/// implementation and this test relies on POSIX process-group semantics.
#[cfg(unix)]
#[tokio::test]
async fn cancelling_a_build_kills_a_grandchild_in_the_process_group() {
    let grandchild = spawn_marker_grandchild().await;
    let cancel = Arc::new(AtomicBool::new(true));
    let progress: ProgressSink = &|_, _, _| {};
    let error = supervise_build_child(
        grandchild.child,
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

    assert_grandchild_stopped_and_cleanup(
        grandchild.marker,
        grandchild.pid_file,
        grandchild.root,
        "cancellation",
    )
    .await;
}

/// The timeout path must kill the whole process group exactly like
/// cancellation does, not just the direct child: this is the deadline
/// counterpart to `cancelling_a_build_kills_a_grandchild_in_the_process_group`
/// above, sharing its marker-grandchild setup so the two tests differ
/// only in which stop path they drive.
#[cfg(unix)]
#[tokio::test]
async fn a_build_timeout_kills_a_grandchild_in_the_process_group() {
    let grandchild = spawn_marker_grandchild().await;
    let cancel = Arc::new(AtomicBool::new(false));
    let progress: ProgressSink = &|_, _, _| {};
    let error = supervise_build_child(
        grandchild.child,
        progress,
        "building",
        "test build",
        &cancel,
        Duration::from_millis(200),
    )
    .await
    .expect_err("a build past its deadline must not report success");
    assert_eq!(error.kind, crate::error::ErrorKind::Timeout);
    assert!(error.message.contains("timeout"), "{error}");

    assert_grandchild_stopped_and_cleanup(
        grandchild.marker,
        grandchild.pid_file,
        grandchild.root,
        "the deadline killed the tree",
    )
    .await;
}

#[test]
fn every_supported_backend_maps_to_exactly_one_ggml_option() {
    let option_for = |backend: &str| {
        source_build_configure_args(
            backend,
            Path::new("source"),
            Path::new("build"),
            TEST_CUDA_ARCHITECTURES,
        )
        .expect("configures")
        .into_iter()
        .filter(|arg| arg.starts_with("-DGGML_") && arg.ends_with("=ON"))
        .collect::<Vec<_>>()
    };
    // GGML_BACKEND_DL and GGML_CPU_ALL_VARIANTS are on for every build; the
    // backend-selecting option is the one that must differ.
    assert!(option_for("cuda").contains(&"-DGGML_CUDA=ON".to_string()));
    assert!(option_for("vulkan").contains(&"-DGGML_VULKAN=ON".to_string()));
    assert!(option_for("rocm").contains(&"-DGGML_HIP=ON".to_string()));
    assert!(option_for("cpu").contains(&"-DGGML_CPU=ON".to_string()));
    assert!(option_for("metal").contains(&"-DGGML_METAL=ON".to_string()));
    assert!(!option_for("cpu").contains(&"-DGGML_METAL=ON".to_string()));
    assert!(!option_for("cuda").contains(&"-DGGML_VULKAN=ON".to_string()));
    assert!(!option_for("vulkan").contains(&"-DGGML_CUDA=ON".to_string()));
    assert!(!option_for("rocm").contains(&"-DGGML_CUDA=ON".to_string()));
    assert!(!option_for("cpu").contains(&"-DGGML_CUDA=ON".to_string()));
}

#[test]
fn source_builds_request_a_runtime_path_relative_to_the_installed_binary() {
    for backend in SOURCE_BUILD_BACKENDS {
        let args = source_build_configure_args(
            backend,
            Path::new("source"),
            Path::new("build"),
            TEST_CUDA_ARCHITECTURES,
        )
        .expect("configures");
        match portable_runtime_rpath() {
            Some(rpath) => {
                assert!(
                    args.iter()
                        .any(|arg| arg == &format!("-DCMAKE_BUILD_RPATH={rpath}")),
                    "{backend}"
                );
                assert!(args
                    .iter()
                    .any(|arg| arg == "-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON"));
                assert!(
                    args.iter()
                        .any(|arg| arg == &format!("-DCMAKE_INSTALL_RPATH={rpath}")),
                    "{backend}"
                );
            }
            None => assert!(!args.iter().any(|arg| arg.contains("CMAKE_BUILD_RPATH"))),
        }
    }
}

#[test]
fn a_build_log_tail_is_capped_in_characters_not_bytes() {
    // A tail cut at a byte boundary would split a multi-byte character and
    // produce mojibake in the one message the user has to read.
    let log = "λ".repeat(MAX_BUILD_DETAIL_CHARS * 2);
    let detail = build_failure_detail(log.as_bytes(), b"");
    assert!(detail.chars().count() <= MAX_BUILD_DETAIL_CHARS);
    assert!(detail.chars().all(|character| character == 'λ'));
}

#[cfg(windows)]
#[tokio::test]
async fn dropping_a_build_future_terminates_the_child_and_unregisters_it() {
    for _ in 0..3 {
        let mut command = crate::procutil::tokio_command("cmd");
        command
            .args(["/c", "ping -n 60 127.0.0.1 > nul"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let child = TransientChild::spawn(&mut command).unwrap();
        let pid = child.id().unwrap();
        let exit = crate::procutil::ProcessExitProbe::open(pid).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress: ProgressSink = &|_, _, _| {};
        let future = supervise_build_child(
            child,
            progress,
            "building",
            "fixture",
            &cancel,
            Duration::from_secs(60),
        );
        assert!(timeout(Duration::from_millis(100), future).await.is_err());
        timeout(Duration::from_secs(5), async {
            while !exit.exited() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("abandoned build must exit");
    }
}
