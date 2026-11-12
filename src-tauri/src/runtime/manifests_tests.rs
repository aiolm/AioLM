use super::*;

#[test]
fn bundles_need_only_the_server_and_still_verify_an_included_optional_helper() {
    let root = test_directory("bundle-optional-helper");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(server_executable_name()), b"server").unwrap();
    write_source_manifest(&root, &test_source()).unwrap();
    let server_only = test_bundle_manifest(&root);
    verify_bundle_files(&root, &server_only).expect("a server-only bundle is complete");

    fs::write(root.join(bench_executable_name()), b"bench").unwrap();
    assert!(
        verify_bundle_files(&root, &server_only).is_err(),
        "an undeclared extra file is still refused"
    );
    let with_helper = test_bundle_manifest(&root);
    verify_bundle_files(&root, &with_helper).expect("the declared helper verifies");
    fs::write(root.join(bench_executable_name()), b"bencX").unwrap();
    let error = verify_bundle_files(&root, &with_helper).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(error.message.contains("digest mismatch"));

    fs::remove_file(root.join(server_executable_name())).unwrap();
    let without_server = test_bundle_manifest(&root);
    let error = verify_bundle_files(&root, &without_server).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::NotFound);
    assert!(error.message.contains(server_executable_name()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_source_manifest_round_trips_and_reads_older_installs() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-manifest-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&root).expect("create runtime dir");
    let source = RuntimeSource {
        pull_request: 27342,
        repository: "contributor/llama.cpp".into(),
        head_ref: "feature-branch".into(),
        author: "contributor".into(),
        state: "open".into(),
        fork: true,
        commit: "0123456789abcdef0123456789abcdef01234567".into(),
        archive_sha256: "a".repeat(64),
        commit_check: COMMIT_CHECK_MATCHED.into(),
        url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
    };
    write_source_manifest(&root, &source).expect("write source manifest");
    assert_eq!(read_source_manifest(&root), Some(source));

    // A runtime installed before provenance was recorded still loads; the
    // new fields are simply empty rather than invented.
    fs::write(
        root.join(SOURCE_MANIFEST),
        r#"{"pull_request":1,"repository":"ggml-org/llama.cpp","commit":"0123456789abcdef0123456789abcdef01234567","archive_sha256":"","url":"https://example.invalid"}"#,
    )
    .expect("write a legacy manifest");
    let legacy = read_source_manifest(&root).expect("a legacy manifest still reads");
    assert_eq!(legacy.pull_request, 1);
    assert!(legacy.author.is_empty());
    assert!(legacy.commit_check.is_empty());
    assert!(!legacy.fork);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_listed_runtime_carries_its_recorded_provenance() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-listing-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let dir = root.join("pr27342-cuda");
    fs::create_dir_all(&dir).expect("create runtime dir");
    let source = RuntimeSource {
        pull_request: 27342,
        repository: "contributor/llama.cpp".into(),
        head_ref: "feature".into(),
        author: "contributor".into(),
        state: "open".into(),
        fork: true,
        commit: "0123456789abcdef0123456789abcdef01234567".into(),
        archive_sha256: "b".repeat(64),
        commit_check: COMMIT_CHECK_MATCHED.into(),
        url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
    };
    write_source_manifest(&dir, &source).expect("write source manifest");
    let version = RuntimeVersion {
        semver: "0.3.0-dev".into(),
        build: 10638,
        commit: "bf9421646".into(),
    };
    write_version_manifest(&dir, &version);

    let read_back = read_source_manifest(&dir).expect("manifest round-trips");
    assert_eq!(read_back, source);
    assert_eq!(read_version_manifest(&dir), Some(version));
    // A runtime that was never a PR build simply has no source manifest.
    let release = root.join("b10638-cuda");
    fs::create_dir_all(&release).expect("create release dir");
    assert_eq!(read_source_manifest(&release), None);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_manifest_that_is_not_valid_json_is_ignored_rather_than_fatal() {
    let root = std::env::temp_dir().join(format!(
        "aiolm-bad-manifest-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&root).expect("create dir");
    fs::write(root.join(SOURCE_MANIFEST), b"{ this is not json").expect("write");
    fs::write(root.join(VERSION_MANIFEST), b"").expect("write");
    assert_eq!(read_source_manifest(&root), None);
    assert_eq!(read_version_manifest(&root), None);
    let _ = fs::remove_dir_all(root);
}
