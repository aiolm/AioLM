use super::*;

#[test]
fn install_cleanup_removes_partial_archive_and_staging_directory() {
    let root = std::env::temp_dir().join(format!("aiolm-cleanup-{}", Uuid::new_v4()));
    let archive = root.join("download.zip");
    let staging = root.join("staging");
    fs::create_dir_all(&staging).expect("create staging");
    fs::write(&archive, b"partial").expect("create archive");
    let cleanup = InstallCleanup::new(archive.clone(), staging.clone());
    drop(cleanup);
    assert!(!archive.exists());
    assert!(!staging.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn orphan_sweep_removes_only_old_exactly_named_work() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-orphan-sweep-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let downloads = root.join("downloads");
    let runtimes = root.join("runtimes");
    fs::create_dir_all(&downloads).expect("create downloads");
    fs::create_dir_all(&runtimes).expect("create runtimes");
    let old_archive = downloads.join(".0123456789ab-llama-b10603-bin-win-cpu-x64.zip");
    fs::write(&old_archive, b"partial archive").expect("create stale archive");
    let old_workspace = downloads.join(".0123456789ab-pr27342-cuda");
    let old_staging = runtimes.join(".pr27342-cuda.staging-0123456789ab");
    let old_backup = runtimes.join(".pr27342-cuda.backup-0123456789abcdef0123456789abcdef");
    for path in [&old_workspace, &old_staging, &old_backup] {
        fs::create_dir_all(path).expect("create stale work");
    }
    // Simulate a timestamp well past the conservative age threshold without
    // requiring a platform-specific file-time dependency.
    let old_now = SystemTime::now() + ORPHAN_SWEEP_MAX_AGE + Duration::from_secs(1);
    sweep_orphaned_work_in(&downloads, &runtimes, old_now);
    assert!(!old_archive.exists());
    assert!(!old_workspace.exists());
    assert!(!old_staging.exists());
    assert!(!old_backup.exists());

    let fresh_workspace = downloads.join(".0123456789ab-pr27342-cuda");
    let user_workspace = downloads.join(".my-project-pr27342-cuda");
    let user_archive = downloads.join(".not-a-download.zip");
    let malformed = runtimes.join(".pr27342-cuda.staging-not-a-nonce");
    let managed = runtimes.join("pr27342-cuda");
    fs::write(&user_archive, b"user file").expect("create user archive");
    for path in [&fresh_workspace, &user_workspace, &malformed, &managed] {
        fs::create_dir_all(path).expect("create preserved work");
    }
    sweep_orphaned_work_in(&downloads, &runtimes, SystemTime::now());
    for path in [&fresh_workspace, &user_workspace, &malformed, &managed] {
        assert!(path.exists(), "{path:?} must be preserved");
    }
    assert!(user_archive.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn orphan_sweep_name_allowlist_does_not_match_user_paths() {
    assert!(is_pr_download_workspace_name(".0123456789ab-pr27342-cuda"));
    assert!(is_runtime_staging_or_backup_name(
        ".pr27342-cuda.staging-0123456789ab"
    ));
    assert!(is_runtime_staging_or_backup_name(
        ".pr27342-cuda.backup-0123456789abcdef0123456789abcdef"
    ));
    assert!(is_runtime_download_file_name(
        ".0123456789ab-llama-b10603-bin-win-cpu-x64.zip"
    ));
    for name in [
        ".project-pr27342-cuda",
        ".0123456789ab-b10638-cuda",
        ".0123456789ab-pr27342-future",
        ".pr27342-cuda.staging-not-hex",
        ".pr27342-cuda.backup-0123",
        ".pr27342-future.staging-0123456789ab",
        "pr27342-cuda",
    ] {
        assert!(
            !is_pr_download_workspace_name(name) && !is_runtime_staging_or_backup_name(name),
            "{name} must not be sweepable"
        );
    }
    assert!(!is_runtime_download_file_name(".not-a-download.zip"));
    assert!(!is_runtime_download_file_name("llama-b10603.zip"));
}

#[test]
fn orphan_sweep_ignores_a_locked_directory_removal_failure() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-orphan-locked-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let downloads = root.join("downloads");
    let runtimes = root.join("runtimes");
    fs::create_dir_all(&downloads).expect("create downloads");
    fs::create_dir_all(&runtimes).expect("create runtimes");
    let stale = downloads.join(".0123456789ab-pr27342-cuda");
    fs::create_dir_all(&stale).expect("create stale workspace");

    let now = SystemTime::now() + ORPHAN_SWEEP_MAX_AGE + Duration::from_secs(1);
    // A locked directory on Windows (or a transient filesystem error on
    // Unix) is expected to remain for a later sweep, not abort startup.
    sweep_orphaned_work_in_with(&downloads, &runtimes, now, |_| {
        Err("simulated locked directory".into())
    });
    assert!(
        stale.exists(),
        "failed cleanup must leave the directory alone"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_cleanup_plan_is_handed_off_instead_of_running_on_the_runtime() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-cleanup-async-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let workspace = root.join("workspace");
    let staging = root.join("staging");
    let archive = root.join("source.zip");
    fs::create_dir_all(workspace.join("build").join("deep")).expect("create build tree");
    fs::create_dir_all(&staging).expect("create staging");
    fs::write(&archive, b"partial").expect("create archive");
    fs::write(workspace.join("build").join("deep").join("a.obj"), b"o").expect("object");

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build a runtime");
    runtime.block_on(async {
        let mut cleanup = InstallCleanup::new(archive.clone(), staging.clone());
        cleanup.track_directory(workspace.clone());
        cleanup.finish().await;
    });

    assert!(!archive.exists());
    assert!(!workspace.exists());
    assert!(!staging.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_committed_install_keeps_its_runtime_and_still_clears_the_workspace() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-cleanup-commit-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let workspace = root.join("workspace");
    let staging = root.join("staging");
    let archive = root.join("source.zip");
    fs::create_dir_all(&workspace).expect("create workspace");
    fs::create_dir_all(&staging).expect("create staging");
    fs::write(&archive, b"partial").expect("create archive");

    let mut cleanup = InstallCleanup::new(archive.clone(), staging.clone());
    cleanup.track_directory(workspace.clone());
    cleanup.commit();
    let plan = cleanup.plan();
    plan.run();

    assert!(!archive.exists());
    assert!(!workspace.exists());
    // Committed: the staged runtime has already been moved into place by
    // `replace_runtime`, so cleanup must not touch it.
    assert!(staging.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_bounded_removal_gives_up_instead_of_retrying_for_ever() {
    let missing = std::env::temp_dir().join(format!(
        "aiolm-absent-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    // A directory that is already gone is a success, not an error to retry.
    assert!(remove_tree_bounded(&missing).is_ok());
    // A retry budget worth having, but not one that turns a genuinely
    // locked file into a thread that never finishes.
    const { assert!(CLEANUP_ATTEMPTS >= 2 && CLEANUP_ATTEMPTS <= 8) };
}
