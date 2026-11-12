use super::*;

#[cfg(windows)]
#[test]
fn windows_clang_environment_contains_sdk_linker_inputs() {
    let Some(cl) = locate_tool("cl") else {
        // Linux/macOS CI and Windows machines without the optional source
        // build toolchain do not exercise this integration check.
        return;
    };
    let mut environment = build_environment();
    merge_visual_studio_environment(&mut environment, &cl, None);
    let include = environment_value(&environment, "INCLUDE")
        .expect("Visual Studio should provide INCLUDE for clang on Windows");
    assert!(
        std::env::split_paths(&include).any(|path| path.is_dir()),
        "INCLUDE should contain an existing directory"
    );
    let libraries = environment_value(&environment, "LIB")
        .expect("Visual Studio should provide LIB for clang on Windows");
    assert!(
        std::env::split_paths(&libraries).any(|path| path.join("kernel32.lib").is_file()),
        "LIB should contain the Windows SDK import libraries: {:?}",
        std::env::split_paths(&libraries).collect::<Vec<_>>()
    );
}

#[cfg(windows)]
#[test]
fn windows_child_paths_do_not_use_cmd_incompatible_verbatim_prefixes() {
    assert_eq!(
        strip_windows_verbatim_prefix(PathBuf::from(r"\\?\C:\ROCm\bin")),
        PathBuf::from(r"C:\ROCm\bin")
    );
    assert_eq!(
        strip_windows_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\bin")),
        PathBuf::from(r"\\server\share\bin")
    );
    let ordinary = PathBuf::from(r"C:\ROCm\bin");
    assert_eq!(strip_windows_verbatim_prefix(ordinary.clone()), ordinary);
}

#[test]
fn pull_request_builds_are_limited_to_backends_with_detectable_toolchains() {
    for backend in SOURCE_BUILD_BACKENDS {
        assert!(validate_source_build_backend(backend).is_ok(), "{backend}");
        assert!(CATALOG_BACKENDS.contains(backend), "{backend}");
    }
    for backend in ["sycl", "openvino"] {
        let error = validate_source_build_backend(backend)
            .expect_err("a vendor-toolchain backend must be refused");
        assert_eq!(error.kind, crate::error::ErrorKind::Unavailable);
        assert!(error.message.contains(backend), "{error}");
        assert!(error.message.contains("not supported"), "{error}");
        assert!(error.message.contains("cpu, vulkan, cuda, rocm"), "{error}");
    }
    assert_eq!(
        validate_source_build_backend("unknown").unwrap_err().kind,
        crate::error::ErrorKind::Validation
    );
}

#[test]
fn source_build_preflight_names_the_missing_sdk() {
    let absent = |_: &str| false;
    let present = |_: &str| true;
    let compiler_present = |name: &str| {
        if cfg!(windows) {
            name == "cl"
        } else {
            matches!(name, "cc" | "gcc" | "clang" | "c++" | "g++" | "clang++")
        }
    };
    let bare = ToolchainView {
        executable: &|name| compiler_present(name),
        directory_variable: &absent,
    };
    let cuda = missing_source_build_toolchain("cuda", &bare)
        .expect("cuda without a toolkit must be refused");
    assert_eq!(cuda.kind, crate::error::ErrorKind::Unavailable);
    assert!(cuda.message.contains("nvcc"), "{cuda}");
    assert!(cuda.message.contains("CUDACXX"), "{cuda}");
    let vulkan = missing_source_build_toolchain("vulkan", &bare)
        .expect("vulkan without an SDK must be refused");
    assert_eq!(vulkan.kind, crate::error::ErrorKind::Unavailable);
    assert!(vulkan.message.contains("glslc"), "{vulkan}");
    assert!(vulkan.message.contains("VULKAN_SDK"), "{vulkan}");
    let rocm = missing_source_build_toolchain("rocm", &bare)
        .expect("ROCm without hipcc and an SDK must be refused");
    assert_eq!(rocm.kind, crate::error::ErrorKind::Unavailable);
    assert!(rocm.message.contains("hipcc"), "{rocm}");
    assert!(
        rocm.message.contains("HIP_PATH") && rocm.message.contains("ROCM_PATH"),
        "{rocm}"
    );
    assert!(missing_source_build_toolchain("cpu", &bare).is_none());

    let on_path = ToolchainView {
        executable: &present,
        directory_variable: &absent,
    };
    assert!(missing_source_build_toolchain("cuda", &on_path).is_none());
    assert!(missing_source_build_toolchain("vulkan", &on_path).is_none());

    let via_environment = ToolchainView {
        executable: &present,
        directory_variable: &present,
    };
    assert!(missing_source_build_toolchain("cuda", &via_environment).is_none());
    assert!(missing_source_build_toolchain("vulkan", &via_environment).is_none());

    let missing_compiler = ToolchainView {
        executable: &absent,
        directory_variable: &present,
    };
    let error = missing_source_build_toolchain("cpu", &missing_compiler)
        .expect("every backend needs a host compiler");
    assert_eq!(error.kind, crate::error::ErrorKind::NotFound);
    assert!(error.message.contains("compiler"), "{error}");
}

#[test]
fn visual_studio_installs_are_ordered_newest_release_first() {
    // read_dir hands these back in filesystem order, which differs between
    // machines and after an update - so the same PC could silently switch
    // build tools. Sorting makes the choice a decision, not an accident.
    let mut installs = vec![
        vs_install(2019, "Community"),
        vs_install(2022, "BuildTools"),
        vs_install(2022, "Enterprise"),
        vs_install(2026, "Community"),
        vs_install(2022, "Professional"),
    ];
    sort_visual_studio_installs(&mut installs);
    let order: Vec<(u32, &str)> = installs
        .iter()
        .map(|install| (install.year, install.edition.as_str()))
        .collect();
    assert_eq!(
        order,
        vec![
            (2026, "Community"),
            (2022, "Enterprise"),
            (2022, "Professional"),
            (2022, "BuildTools"),
            (2019, "Community"),
        ]
    );
}

#[test]
fn toolchain_ordering_does_not_depend_on_the_order_it_was_discovered_in() {
    let forward = vec![
        vs_install(2022, "Community"),
        vs_install(2022, "Enterprise"),
        vs_install(2026, "Preview"),
    ];
    let mut reversed = forward.clone();
    reversed.reverse();
    let mut first = forward;
    let mut second = reversed;
    sort_visual_studio_installs(&mut first);
    sort_visual_studio_installs(&mut second);
    assert_eq!(first, second);
    // An edition nobody listed still sorts, after the known ones.
    assert_eq!(first[0].year, 2026);
    assert_eq!(first[0].edition, "Preview");
}

#[cfg(windows)]
#[test]
fn a_standalone_cmake_is_preferred_over_the_one_visual_studio_bundles() {
    let candidates = windows_cmake_candidates();
    let standalone = candidates
        .iter()
        .position(|path| !path.to_string_lossy().contains("Microsoft Visual Studio"));
    let bundled = candidates
        .iter()
        .position(|path| path.to_string_lossy().contains("Microsoft Visual Studio"));
    if let (Some(standalone), Some(bundled)) = (standalone, bundled) {
        assert!(standalone < bundled, "{candidates:?}");
    }
    // Whatever this machine has, asking twice gives the same answer.
    assert_eq!(candidates, windows_cmake_candidates());
}

// ---- L2: toolchain version preflight ----

#[test]
fn cmake_version_banners_are_parsed() {
    assert_eq!(
        parse_cmake_version("cmake version 3.29.2\n\nCMake suite maintained..."),
        Some((3, 29, 2))
    );
    assert_eq!(
        parse_cmake_version("cmake version 3.31.0-rc1"),
        Some((3, 31, 0))
    );
    assert_eq!(parse_cmake_version("cmake version 4.0"), Some((4, 0, 0)));
    for text in ["", "not cmake", "cmake version", "cmake version x.y"] {
        assert_eq!(parse_cmake_version(text), None, "{text:?}");
    }
}

#[test]
fn a_cmake_older_than_the_command_lines_here_is_refused_with_a_way_out() {
    let path = Path::new("/tools/cmake");
    // 3.18 is the floor because CUDA PR builds use CMAKE_CUDA_ARCHITECTURES.
    let old = cmake_version_error(path, (3, 10, 2)).expect("an old CMake must be refused");
    assert_eq!(old.kind, crate::error::ErrorKind::Unavailable);
    assert!(old.message.contains("3.10.2"), "{old}");
    assert!(old.message.contains("3.18"), "{old}");
    assert!(
        old.message.contains("Kitware.CMake") || old.message.contains("cmake.org"),
        "{old}"
    );
    assert!(cmake_version_error(path, (3, 17, 9)).is_some());
    assert_eq!(cmake_version_error(path, (3, 18, 0)), None);
    assert_eq!(cmake_version_error(path, (4, 1, 0)), None);
}

// ---- L7: disk space ----

#[test]
fn a_disk_with_no_room_is_reported_before_anything_is_downloaded() {
    let path = Path::new("/data/downloads");
    let required = required_build_bytes("cuda");
    let error = free_space_error("PR source build", path, required, Some(2 * GIB))
        .expect("2 GB free must be refused for a CUDA build");
    assert!(error.contains("2.0 GB"), "{error}");
    assert!(error.contains("Free some space"), "{error}");
    // Enough room says nothing at all.
    assert_eq!(
        free_space_error("PR source build", path, required, Some(required)),
        None
    );
    // A platform that will not answer must never block the build.
    assert_eq!(
        free_space_error("PR source build", path, required, None),
        None
    );
    // CUDA compiles every architecture separately, so it needs more.
    assert!(required_build_bytes("cuda") > required_build_bytes("cpu"));
}

#[test]
fn the_disk_message_names_the_step_once() {
    let error = free_space_error(
        "PR source build",
        Path::new("/data"),
        20 * GIB,
        Some(2 * GIB),
    )
    .expect("refused");
    // The regression: an inline {label} plus a positional argument printed
    // "for the PR source build: PR source build needs about ...".
    assert_eq!(error.matches("PR source build").count(), 1, "{error}");
    assert!(error.contains("it needs about 20.0 GB"), "{error}");
}

#[test]
fn both_volumes_a_pr_build_writes_to_have_a_requirement() {
    // Downloads and runtimes are frequently on different drives, so the
    // installed runtime needs its own budget, not the build's.
    const { assert!(INSTALLED_RUNTIME_BYTES > 0) };
    assert!(INSTALLED_RUNTIME_BYTES < required_build_bytes("cpu"));
    let error = free_space_error(
        "installed runtime",
        Path::new("/runtimes"),
        INSTALLED_RUNTIME_BYTES,
        Some(0),
    )
    .expect("a full runtimes volume must be refused");
    assert!(error.contains("installed runtime"), "{error}");
}

#[test]
fn workspace_nonces_stay_short_enough_for_a_windows_path_budget() {
    let nonce = short_nonce();
    // A llama.cpp build tree nests object files far below this directory,
    // and Windows still enforces MAX_PATH for many toolchains.
    assert_eq!(nonce.len(), 12);
    assert!(nonce.chars().all(|character| character.is_ascii_hexdigit()));
    let mut seen = std::collections::HashSet::new();
    for _ in 0..1000 {
        assert!(seen.insert(short_nonce()), "nonces must not repeat");
    }
}

#[test]
fn a_missing_cmake_gives_advice_for_the_platform_it_is_running_on() {
    let error = cmake_not_found_error();
    assert_eq!(error.kind, crate::error::ErrorKind::NotFound);
    assert!(error.message.contains("CMake was not found"), "{error}");
    #[cfg(windows)]
    {
        assert!(error.message.contains("Kitware.CMake"), "{error}");
        assert!(error.message.contains("Visual Studio"), "{error}");
    }
    #[cfg(target_os = "macos")]
    assert!(error.message.contains("brew install cmake"), "{error}");
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        assert!(error.message.contains("apt install cmake"), "{error}");
        // Telling a Linux user about Visual Studio is not advice.
        assert!(!error.message.contains("Visual Studio"), "{error}");
    }
}

#[test]
fn free_space_is_measured_on_a_real_volume() {
    // The temp directory certainly exists; the point is that the platform
    // call returns something plausible rather than zero or an error.
    let available = available_bytes(&std::env::temp_dir());
    if let Some(available) = available {
        assert!(available > 0);
    }
    // A path whose leaf does not exist yet still resolves, via its parent.
    let missing = std::env::temp_dir().join(format!("aiolm-absent-{}", Uuid::new_v4()));
    assert_eq!(available_bytes(&missing).is_some(), available.is_some());
}

// ---- L5 / L6: what gets built ----

#[test]
fn metal_source_builds_target_apple_silicon_macs_only() {
    assert!(source_build_platform_error("metal", "macos", "aarch64").is_none());
    let error = source_build_platform_error("metal", "macos", "x86_64").unwrap();
    assert_eq!(error.kind, crate::error::ErrorKind::Unavailable);
    assert!(error.message.contains("Apple silicon"));
    assert!(source_build_platform_error("metal", "linux", "aarch64").is_some());
    assert!(source_build_platform_error("cpu", "macos", "x86_64").is_none());
    assert!(source_build_platform_error("rocm", "macos", "aarch64").is_some());
    assert!(source_build_platform_error("vulkan", "linux", "x86_64").is_none());
}

#[test]
fn every_configure_keeps_the_result_portable_across_cpus() {
    for backend in SOURCE_BUILD_BACKENDS {
        let args = source_build_configure_args(
            backend,
            Path::new("source"),
            Path::new("build"),
            TEST_CUDA_ARCHITECTURES,
        )
        .expect("configures");
        // GGML_NATIVE would bake this machine's instruction set into the
        // binary; the runtime has to keep working after a CPU change.
        assert!(
            args.iter().any(|arg| arg == "-DGGML_NATIVE=OFF"),
            "{backend}"
        );
        assert!(
            args.iter().any(|arg| arg == "-DGGML_CPU_ALL_VARIANTS=ON"),
            "{backend}"
        );
        assert!(
            args.iter().any(|arg| arg == "-DGGML_BACKEND_DL=ON"),
            "{backend}"
        );
    }
}
