use super::*;

#[test]
fn packaged_blas_paths_preserve_architecture_selection_and_relocate_kpack() {
    let root = test_directory("rocm-environment");
    fs::create_dir_all(root.join("hipblaslt/library/gfx1201")).unwrap();
    fs::create_dir_all(root.join("rocblas/library")).unwrap();
    fs::create_dir_all(root.join(".kpack")).unwrap();
    fs::write(
        root.join("hipblaslt/library/gfx1201/TensileLibrary.dat"),
        b"modern",
    )
    .unwrap();
    fs::write(
        root.join("hipblaslt/library/README"),
        b"not a legacy layout",
    )
    .unwrap();
    fs::write(root.join("rocblas/library/TensileLibrary.dat"), b"legacy").unwrap();
    let archive = root.join(".kpack/blas_gfx1201.kpack");
    fs::write(&archive, b"kernels").unwrap();
    let environment = staged_runtime_environment_from(
        vec![
            ("HIPBLASLT_TENSILE_LIBPATH".into(), "host/library".into()),
            ("ROCM_KPACK_PATH".into(), "host.kpack".into()),
            ("ROCM_KPACK_PATH_PREFIX".into(), "host-prefix.kpack".into()),
        ],
        &root,
    );
    let value = |name: &str| {
        environment
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(value("HIPBLASLT_TENSILE_LIBPATH"), None);
    assert_eq!(value("ROCM_KPACK_PATH_PREFIX"), None);
    assert_eq!(
        value("ROCBLAS_TENSILE_LIBPATH"),
        Some(root.join("rocblas").join("library").into_os_string())
    );
    assert_eq!(
        std::env::split_paths(&value("ROCM_KPACK_PATH").unwrap()).collect::<Vec<_>>(),
        vec![archive]
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn build_environment_puts_the_selected_tool_directory_first() {
    let tool = Path::new("test-toolchain").join("bin").join("cmake");
    let environment = build_environment_with_tool(&tool);
    let path = environment
        .iter()
        .find(|(key, _)| key == OsStr::new("PATH"))
        .map(|(_, value)| value.clone())
        .expect("build environment should include PATH");
    assert_eq!(
        std::env::split_paths(&path).next(),
        tool.parent().map(Path::to_path_buf)
    );
}

#[test]
fn rocm_build_environment_prefers_the_cxx_driver_for_hip() {
    if locate_tool("hipcc").is_none() {
        return;
    }
    let environment = build_environment_for_backend(Path::new("cmake"), "rocm", None);
    let hipcxx = environment
        .iter()
        .find(|(name, _)| name == OsStr::new("HIPCXX"))
        .map(|(_, value)| value.clone())
        .expect("a complete ROCm SDK should provide clang++ for HIP");
    assert!(
        hipcxx
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("clang++"),
        "HIPCXX must be a C++ compiler: {hipcxx:?}"
    );
}

#[test]
fn no_allowlist_can_hand_a_child_a_credential() {
    for name in every_allowlisted_name() {
        assert!(
            !is_credential_name(name),
            "{name} would leak a credential to a child process"
        );
    }
    // The guard itself has to actually catch things, or the check above is
    // worth nothing.
    for name in [
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "MY_API_KEY",
        "db_password",
        "SERVICE_SECRET",
        "SSH_AUTH_SOCK",
    ] {
        assert!(is_credential_name(name), "{name}");
    }
    assert!(!is_credential_name("PATH"));
    assert!(!is_credential_name("CUDA_PATH"));
}

#[test]
fn a_child_environment_only_contains_names_that_are_set() {
    let names = |environment: Vec<(OsString, OsString)>| {
        environment
            .into_iter()
            .filter_map(|(name, _)| name.into_string().ok())
            .collect::<Vec<_>>()
    };
    let overrides = build_environment_overrides()
        .into_iter()
        .filter_map(|(name, _)| name.into_string().ok())
        .collect::<Vec<_>>();
    let allowed = every_allowlisted_name();
    for name in names(child_environment()) {
        assert!(
            allowed.contains(&name.as_str()),
            "{name} is not allowlisted"
        );
        assert!(std::env::var_os(&name).is_some(), "{name} is not set");
    }
    for name in names(build_environment()) {
        assert!(
            allowed.contains(&name.as_str()) || overrides.contains(&name),
            "{name} is neither allowlisted nor an override"
        );
    }
}

#[test]
fn a_child_environment_never_repeats_a_name() {
    // Several categories legitimately name CUDA_PATH; handing a child the
    // same variable twice is at best confusing and at worst platform
    // dependent.
    for environment in [child_environment(), build_environment()] {
        let mut seen = std::collections::HashSet::new();
        for (name, _) in environment {
            assert!(seen.insert(name.clone()), "{name:?} appears twice");
        }
    }
}

#[test]
fn staged_runtime_preflight_cannot_fall_back_to_the_build_host_sdk() {
    let staged = staged_runtime_environment_from(
        vec![
            (OsString::from("PATH"), OsString::from("host/bin")),
            (OsString::from("CUDA_PATH"), OsString::from("host/cuda")),
            (OsString::from("HIP_PATH"), OsString::from("host/rocm")),
            (
                OsString::from("LD_LIBRARY_PATH"),
                OsString::from("host/lib"),
            ),
            (OsString::from("CUDA_VISIBLE_DEVICES"), OsString::from("1")),
            (OsString::from("HOME"), OsString::from("user")),
        ],
        Path::new("staged/runtime"),
    );
    let value = |name: &str| {
        staged
            .iter()
            .find(|(key, _)| key.to_string_lossy() == name)
            .map(|(_, value)| value.to_string_lossy().into_owned())
    };

    assert_eq!(value("PATH").as_deref(), Some("staged/runtime"));
    assert_eq!(value("CUDA_PATH"), None);
    assert_eq!(value("HIP_PATH"), None);
    assert_eq!(value("CUDA_VISIBLE_DEVICES").as_deref(), Some("1"));
    assert_eq!(value("HOME").as_deref(), Some("user"));
    assert_eq!(
        staged
            .iter()
            .filter(|(key, _)| key.to_string_lossy() == "PATH")
            .count(),
        1
    );
    #[cfg(target_os = "macos")]
    assert_eq!(
        value("DYLD_LIBRARY_PATH").as_deref(),
        Some("staged/runtime")
    );
    #[cfg(all(unix, not(target_os = "macos")))]
    assert_eq!(value("LD_LIBRARY_PATH").as_deref(), Some("staged/runtime"));
    #[cfg(not(unix))]
    assert_eq!(value("LD_LIBRARY_PATH"), None);
}

#[test]
fn a_build_child_can_never_stop_to_ask_for_a_password() {
    // A credential prompt behind a pipe nobody reads is an infinite build.
    let overrides = build_environment_overrides();
    let value = |wanted: &str| {
        overrides
            .iter()
            .find(|(name, _)| name == OsStr::new(wanted))
            .map(|(_, value)| value.clone())
    };
    assert_eq!(value("GIT_TERMINAL_PROMPT"), Some(OsString::from("0")));
    assert_eq!(value("GCM_INTERACTIVE"), Some(OsString::from("Never")));
    assert_eq!(value("CMAKE_TLS_VERIFY"), Some(OsString::from("1")));
    // The overrides must win over anything inherited.
    let environment = build_environment();
    let last = environment
        .iter()
        .rev()
        .find(|(name, _)| name == OsStr::new("GIT_TERMINAL_PROMPT"))
        .map(|(_, value)| value.clone());
    assert_eq!(last, Some(OsString::from("0")));
}

#[test]
fn nested_source_build_cannot_read_an_enclosing_repository_commit() {
    // Mirrors a PR workspace under an AioLM home that sits inside another
    // checkout: <repo>/home/downloads/.<nonce>/source/<repo>-<sha>.
    let root = std::env::temp_dir().join(format!("aiolm-nested-git-{}", Uuid::new_v4()));
    let workspace = root.join("home").join("downloads").join(".n-pr1-cpu");
    let source = workspace.join("source").join("llama.cpp-0123abc");
    let build = workspace.join("build");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&build).unwrap();
    assert!(git_in(&root, None, &["init", "-q"]).status.success());
    assert!(git_in(
        &root,
        None,
        &["commit", "-q", "--allow-empty", "-m", "enclosing"]
    )
    .status
    .success());
    let enclosing = git_in(&root, None, &["rev-parse", "--short", "HEAD"]);
    assert!(enclosing.status.success());
    // Without a ceiling the build-info commands report the enclosing
    // repository, which is exactly the contamination being prevented.
    let base = child_environment();
    let leaked = git_in(&source, Some(&base), &["rev-parse", "--short", "HEAD"]);
    assert!(leaked.status.success());
    assert_eq!(leaked.stdout, enclosing.stdout);
    // The build child's environment stops discovery at the workspace for
    // both the source tree and the separate build tree.
    let bounded = with_git_ceiling(base, &workspace).unwrap();
    for dir in [&source, &build] {
        let head = git_in(dir, Some(&bounded), &["rev-parse", "--short", "HEAD"]);
        assert!(
            !head.status.success(),
            "{}",
            String::from_utf8_lossy(&head.stdout)
        );
        let count = git_in(dir, Some(&bounded), &["rev-list", "--count", "HEAD"]);
        assert!(!count.status.success());
    }
    let _ = remove_tree_bounded(&root);
}

#[test]
fn pr_runtime_version_must_not_name_a_foreign_commit() {
    let version = |commit: &str| RuntimeVersion {
        semver: "0.0.0-synthetic".into(),
        build: 1,
        commit: commit.into(),
    };
    let reviewed = "18dc7ef9d7424b387c672a7a94bc86ceab7fdede";
    assert!(reported_commit_matches_source(&version("18dc7ef"), reviewed).is_ok());
    assert!(reported_commit_matches_source(&version("unknown"), reviewed).is_ok());
    assert!(reported_commit_matches_source(&version(""), reviewed).is_ok());
    assert!(reported_commit_matches_source(&version(reviewed), reviewed).is_ok());
    for foreign in ["ec0d5f6", "1", "18dc7e", "18dc7ef-dirty", "18DC7EFX"] {
        let error = reported_commit_matches_source(&version(foreign), reviewed).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert!(
            error.message.contains("foreign Git metadata"),
            "{foreign}: {error}"
        );
    }
    assert_eq!(
        reviewed_commit_define(reviewed).unwrap(),
        format!("-DLLAMA_BUILD_COMMIT={reviewed}")
    );
    assert!(reviewed_commit_define("18dc7ef").is_err());
    assert!(reviewed_commit_define("x").is_err());
}
