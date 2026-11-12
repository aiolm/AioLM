use super::*;

#[test]
fn runtime_redirect_hosts_cover_release_and_verification_downloads() {
    for host in [
        "github.com",
        "codeload.github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "huggingface.co",
        "cdn-lfs.huggingface.co",
        "cas-bridge.xethub.hf.co",
    ] {
        assert!(trusted_download_host(host), "{host}");
    }
    assert!(trusted_github_host("api.github.com"));
    for host in [
        "github.com.example.com",
        "evilgithubusercontent.com",
        "localhost",
        "127.0.0.1",
    ] {
        assert!(!trusted_download_host(host), "{host}");
        assert!(!trusted_github_host(host), "{host}");
    }
    assert!(!trusted_github_host("huggingface.co"));
    assert!(!trusted_model_host("github.com"));
}

#[test]
fn parses_release_object_assets() {
    let body = r#"{
        "tag_name": "b10603",
        "assets": [{
            "name": "llama-b10603-bin-win-vulkan-x64.zip",
            "browser_download_url": "https://example.invalid/vulkan.zip"
        }]
    }"#;
    let assets = parse_release_assets(body).expect("release object should decode");
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].name, "llama-b10603-bin-win-vulkan-x64.zip");
}

#[test]
fn github_rate_limit_error_is_actionable() {
    let error = api_error(
        reqwest::StatusCode::FORBIDDEN,
        r#"{"message":"API rate limit exceeded"}"#,
    );
    assert_eq!(error.kind, crate::error::ErrorKind::Unavailable);
    assert!(error.message.contains("GitHub API 403"));
    assert!(error.message.contains("rate limit"));
}

#[test]
fn pull_request_inputs_normalize_to_a_safe_build_id() {
    assert_eq!(pull_request_build_id("27342").unwrap(), "pr27342");
    assert_eq!(pull_request_build_id("#27342").unwrap(), "pr27342");
    assert_eq!(
        pull_request_build_id("https://github.com/ggml-org/llama.cpp/pull/27342/files").unwrap(),
        "pr27342"
    );
    for input in [
        "",
        "https://github.com/other/llama.cpp/pull/27342",
        "http://github.com/ggml-org/llama.cpp/pull/27342",
        "https://github.com/ggml-org/llama.cpp/issues/27342",
        "https://example.com/ggml-org/llama.cpp/pull/27342",
        "https://github.com/ggml-org/llama.cpp/pull/not-a-number",
    ] {
        assert_eq!(
            pull_request_build_id(input).unwrap_err().kind,
            crate::error::ErrorKind::Validation,
            "{input}"
        );
    }
}

#[test]
fn source_archive_is_pinned_to_the_pr_head_commit() {
    let source = RuntimeSource {
        pull_request: 27342,
        repository: "ggml-org/llama.cpp".into(),
        commit: "0123456789abcdef0123456789abcdef01234567".into(),
        url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
        ..RuntimeSource::default()
    };
    assert_eq!(
        source_archive_url(&source).unwrap(),
        "https://codeload.github.com/ggml-org/llama.cpp/zip/0123456789abcdef0123456789abcdef01234567"
    );
}

#[test]
fn release_asset_digest_is_preserved() {
    let body = r#"{
        "assets": [{
            "name": "llama-b10603-bin-win-vulkan-x64.zip",
            "browser_download_url": "https://example.invalid/vulkan.zip",
            "digest": "sha256:0123456789abcdef"
        }]
    }"#;
    let assets = parse_release_assets(body).expect("release object should decode");
    assert_eq!(assets[0].digest.as_deref(), Some("sha256:0123456789abcdef"));
}

#[test]
fn cuda_assets_pull_in_the_matching_cudart_sidecar() {
    assert_eq!(
        companion_asset_name("b10636", "llama-b10636-bin-win-cuda-12.4-x64.zip").as_deref(),
        Some("cudart-llama-bin-win-cuda-12.4-x64.zip")
    );
    assert_eq!(
        companion_asset_name("b10636", "llama-b10636-bin-win-cuda-13.3-x64.zip").as_deref(),
        Some("cudart-llama-bin-win-cuda-13.3-x64.zip")
    );
}

#[test]
fn non_cuda_assets_have_no_sidecar() {
    for name in [
        "llama-b10636-bin-win-vulkan-x64.zip",
        "llama-b10636-bin-win-cpu-x64.zip",
        "llama-b10636-bin-win-rocm-7.14-x64.zip",
        "llama-b10636-bin-win-sycl-x64.zip",
        "llama-b10636-bin-win-openvino-2026.3-x64.zip",
    ] {
        assert_eq!(companion_asset_name("b10636", name), None, "{name}");
    }
    // A mismatched build prefix must not silently produce a sidecar name.
    assert_eq!(
        companion_asset_name("b10600", "llama-b10636-bin-win-cuda-12.4-x64.zip"),
        None
    );
}

#[test]
fn companion_sidecar_names_pass_the_asset_filename_guard() {
    let name = companion_asset_name("b10636", "llama-b10636-bin-win-cuda-12.4-x64.zip")
        .expect("cuda asset should map to a sidecar");
    assert!(validate_asset_file_name(&name).is_ok());
}

#[test]
fn a_pull_request_resolves_to_the_provenance_the_user_is_shown() {
    let resolved = parse_pull_request_source(
        27342,
        pull_request_json(27342, "open", false, Some("contributor/llama.cpp")),
    )
    .expect("an open PR from a fork resolves");
    assert_eq!(resolved.source.author, "contributor");
    assert_eq!(resolved.source.head_ref, "feature-branch");
    assert_eq!(resolved.source.repository, "contributor/llama.cpp");
    assert!(resolved.source.fork);
    assert_eq!(resolved.source.state, "open");
    assert_eq!(resolved.title, "server: add a thing");
    assert!(resolved.draft);
    // The sha is normalised, because everything downstream compares it.
    assert_eq!(
        resolved.source.commit,
        "0123456789abcdef0123456789abcdef01234567"
    );

    let upstream = parse_pull_request_source(
        1,
        pull_request_json(1, "open", false, Some(LLAMA_REPOSITORY)),
    )
    .expect("an upstream branch resolves");
    assert!(!upstream.source.fork);
}

#[test]
fn a_merged_pull_request_is_not_reported_as_merely_closed() {
    let merged = parse_pull_request_source(
        7,
        pull_request_json(7, "closed", true, Some(LLAMA_REPOSITORY)),
    )
    .expect("a merged PR resolves");
    assert_eq!(merged.source.state, "merged");
    let closed = parse_pull_request_source(
        8,
        pull_request_json(8, "closed", false, Some(LLAMA_REPOSITORY)),
    )
    .expect("a closed PR resolves");
    assert_eq!(closed.source.state, "closed");
}

#[test]
fn a_pull_request_with_no_head_repository_cannot_be_built() {
    // The fork was deleted: there is no tree left to download, and no
    // amount of retrying changes that.
    let error = parse_pull_request_source(9, pull_request_json(9, "closed", false, None))
        .expect_err("a deleted fork must be refused");
    assert_eq!(error.kind, crate::error::ErrorKind::NotFound);
    assert!(error.message.contains("no longer available"), "{error}");
    // A response for a different PR is never accepted as this one.
    assert!(parse_pull_request_source(
        10,
        pull_request_json(11, "open", false, Some(LLAMA_REPOSITORY))
    )
    .is_err());
}

#[test]
fn a_force_pushed_head_invalidates_the_users_confirmation() {
    let resolved = parse_pull_request_source(
        27342,
        pull_request_json(27342, "open", false, Some("contributor/llama.cpp")),
    )
    .expect("resolves")
    .source;
    // The exact commit the dialog showed.
    assert!(confirm_pull_request_head(&resolved.commit, &resolved).is_ok());
    // Case and whitespace are cosmetic, not a different approval.
    assert!(
        confirm_pull_request_head("  0123456789ABCDEF0123456789ABCDEF01234567 ", &resolved).is_ok()
    );

    // The branch moved after the dialog was shown: refuse, and say so.
    let stale = confirm_pull_request_head("ffffffffffffffffffffffffffffffffffffffff", &resolved)
        .expect_err("a moved head must be refused");
    assert_eq!(stale.kind, crate::error::ErrorKind::Validation);
    assert!(
        stale.message.contains("moved after you confirmed it"),
        "{stale}"
    );
    assert!(stale.message.contains(&resolved.commit), "{stale}");

    // No confirmation at all is not an implicit yes.
    for empty in ["", "   ", "not-a-sha", "0123456789abcdef"] {
        let error = confirm_pull_request_head(empty, &resolved)
            .expect_err("an unconfirmed build must be refused");
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert!(error.message.contains("confirm"), "{error}");
    }
}

// ---- L3: pull request states ----

#[test]
fn every_pull_request_state_worth_a_second_look_is_reported() {
    let advisories = |state: &str, merged: bool, draft: bool, repo: &str| {
        let mut detail = pull_request_json(1, state, merged, Some(repo));
        detail.draft = draft;
        pull_request_advisories(&parse_pull_request_source(1, detail).expect("resolves"))
    };
    assert_eq!(
        advisories("open", false, false, LLAMA_REPOSITORY),
        Vec::<String>::new(),
        "an ordinary open upstream PR needs no warning"
    );
    assert!(
        advisories("open", false, true, LLAMA_REPOSITORY).contains(&PR_ADVISORY_DRAFT.to_string())
    );
    assert!(advisories("closed", false, false, LLAMA_REPOSITORY)
        .contains(&PR_ADVISORY_CLOSED.to_string()));
    let merged = advisories("closed", true, false, LLAMA_REPOSITORY);
    assert!(merged.contains(&PR_ADVISORY_MERGED.to_string()));
    assert!(!merged.contains(&PR_ADVISORY_CLOSED.to_string()));
    assert!(advisories("open", false, false, "contributor/llama.cpp")
        .contains(&PR_ADVISORY_FORK.to_string()));
}

#[test]
fn a_pull_request_whose_branch_was_deleted_is_flagged() {
    let mut detail = pull_request_json(1, "closed", false, Some(LLAMA_REPOSITORY));
    detail.head.reference = String::new();
    let advisories =
        pull_request_advisories(&parse_pull_request_source(1, detail).expect("resolves"));
    assert!(advisories.contains(&PR_ADVISORY_STALE_BRANCH.to_string()));
}

#[test]
fn a_failed_lookup_says_what_to_do_about_it() {
    let status = reqwest::StatusCode::from_u16;
    let missing =
        pull_request_lookup_error(99999, status(404).unwrap(), r#"{"message":"Not Found"}"#);
    assert_eq!(missing.kind, crate::error::ErrorKind::NotFound);
    assert!(missing.message.contains("was not found"), "{missing}");
    assert!(missing.message.contains("issue number"), "{missing}");

    let limited = pull_request_lookup_error(
        1,
        status(403).unwrap(),
        r#"{"message":"API rate limit exceeded for 1.2.3.4"}"#,
    );
    assert_eq!(limited.kind, crate::error::ErrorKind::Unavailable);
    assert!(limited.message.contains("rate-limiting"), "{limited}");

    let blocked = pull_request_lookup_error(1, status(403).unwrap(), r#"{"message":"Forbidden"}"#);
    assert_eq!(blocked.kind, crate::error::ErrorKind::Unavailable);
    assert!(blocked.message.contains("proxy"), "{blocked}");

    let broken = pull_request_lookup_error(1, status(503).unwrap(), r#"{"message":"unavailable"}"#);
    assert_eq!(broken.kind, crate::error::ErrorKind::Unavailable);
    assert!(broken.message.contains("server error"), "{broken}");
    assert_eq!(
        pull_request_lookup_error(1, status(429).unwrap(), "").kind,
        crate::error::ErrorKind::Unavailable
    );
    assert_eq!(
        pull_request_lookup_error(1, status(504).unwrap(), "").kind,
        crate::error::ErrorKind::Timeout
    );
    assert_eq!(
        pull_request_lookup_error(1, status(451).unwrap(), "").kind,
        crate::error::ErrorKind::Unavailable
    );
}

// ---- L4: commit-aware runtime identity ----

#[test]
fn rebuilding_a_pull_request_reports_the_commit_it_displaced() {
    let source = |commit: &str| RuntimeSource {
        pull_request: 27342,
        repository: LLAMA_REPOSITORY.into(),
        commit: commit.into(),
        ..RuntimeSource::default()
    };
    let old = source(&"a".repeat(40));
    let new = source(&"b".repeat(40));

    let replaced = runtime_replacement(Some(&old), &new).expect("a new commit is news");
    assert_eq!(replaced.previous_commit, old.commit);
    assert_eq!(replaced.previous_pull_request, 27342);

    // Nothing there before, or the very same commit rebuilt: not news, and
    // reporting it would teach the user to ignore the message.
    assert_eq!(runtime_replacement(None, &new), None);
    assert_eq!(runtime_replacement(Some(&new), &new), None);
    // A pre-provenance runtime records no commit, so nothing can be said.
    assert_eq!(runtime_replacement(Some(&source("")), &new), None);
}

#[test]
fn head_repositories_outside_a_plain_owner_slash_name_are_refused() {
    assert!(validate_source_repository("ggml-org/llama.cpp").is_ok());
    assert!(validate_source_repository("a_b-c.d/e_f-g.h").is_ok());
    for hostile in [
        "",
        "owner",
        "owner/",
        "/name",
        "owner/name/extra",
        "../etc",
        "owner/..",
        "../../owner/name",
        "owner/na me",
        "owner/na\\me",
        "owner/na:me",
        "own$er/name",
    ] {
        assert_eq!(
            validate_source_repository(hostile).unwrap_err().kind,
            crate::error::ErrorKind::Validation,
            "{hostile:?}"
        );
    }
}

#[test]
fn only_a_full_hexadecimal_commit_is_accepted() {
    assert!(validate_commit_sha(&"a".repeat(40)).is_ok());
    assert!(validate_commit_sha("0123456789abcdef0123456789abcdef01234567").is_ok());
    for hostile in [
        "",
        &"a".repeat(39),
        &"a".repeat(41),
        "0123456789abcdef0123456789abcdef0123456g",
        "0123456789abcdef0123456789abcdef0123 567",
        "../../../etc/passwd",
    ] {
        assert_eq!(
            validate_commit_sha(hostile).unwrap_err().kind,
            crate::error::ErrorKind::Validation,
            "{hostile:?}"
        );
    }
}

#[test]
fn a_pull_request_response_missing_optional_fields_still_resolves() {
    // GitHub omits fields for some PRs, and a deserialise error here would
    // read to the user as "invalid response" for a perfectly good PR.
    let detail: PullRequestDetail = serde_json::from_str(
        r#"{"number":5,"head":{"sha":"0123456789abcdef0123456789abcdef01234567","repo":{"full_name":"ggml-org/llama.cpp"}}}"#,
    )
    .expect("a minimal response should decode");
    let resolved = parse_pull_request_source(5, detail).expect("resolves");
    assert!(resolved.source.author.is_empty());
    assert!(resolved.source.head_ref.is_empty());
    assert_eq!(resolved.source.state, "unknown");
    assert!(resolved.title.is_empty());
}

#[test]
fn a_pull_request_response_with_a_bad_commit_is_refused() {
    for sha in ["", "not-a-sha", "0123456789abcdef"] {
        let detail: PullRequestDetail = serde_json::from_str(&format!(
            r#"{{"number":5,"head":{{"sha":"{sha}","repo":{{"full_name":"ggml-org/llama.cpp"}}}}}}"#
        ))
        .expect("decodes");
        assert_eq!(
            parse_pull_request_source(5, detail).unwrap_err().kind,
            crate::error::ErrorKind::Validation,
            "{sha:?}"
        );
    }
    // A head repository that is not a plain owner/name is refused too.
    let detail: PullRequestDetail = serde_json::from_str(
        r#"{"number":5,"head":{"sha":"0123456789abcdef0123456789abcdef01234567","repo":{"full_name":"../evil"}}}"#,
    )
    .expect("decodes");
    assert!(parse_pull_request_source(5, detail).is_err());
}

#[test]
fn release_selection_uses_the_platform_architecture_and_published_backend_layout() {
    let names = [
        "llama-b123-bin-win-cpu-x64.zip",
        "llama-b123-bin-win-cpu-arm64.zip",
        "llama-b123-bin-ubuntu-x64.tar.gz",
        "llama-b123-bin-ubuntu-arm64.tar.gz",
        "llama-b123-bin-ubuntu-vulkan-x64.tar.gz",
        "llama-b123-bin-ubuntu-vulkan-arm64.tar.gz",
        "llama-b123-bin-ubuntu-rocm-10.0-x64.tar.gz",
        "llama-b123-bin-ubuntu-cuda-13.4-x64.tar.gz",
        "llama-b123-bin-macos-arm64.tar.gz",
        "llama-b123-bin-macos-x64.tar.gz",
    ];
    let release = Rel {
        tag_name: "b123".into(),
        assets: names
            .iter()
            .map(|name| Asset {
                name: (*name).into(),
                browser_download_url: format!("https://example.invalid/{name}"),
                digest: None,
                size: 0,
            })
            .collect(),
    };
    for (backend, os, arch, expected) in [
        ("cpu", "windows", "x86_64", 0),
        ("cpu", "windows", "aarch64", 1),
        ("cpu", "linux", "x86_64", 2),
        ("cpu", "linux", "aarch64", 3),
        ("vulkan", "linux", "x86_64", 4),
        ("vulkan", "linux", "aarch64", 5),
        ("rocm", "linux", "x86_64", 6),
        ("cuda", "linux", "x86_64", 7),
        ("metal", "macos", "aarch64", 8),
        ("cpu", "macos", "x86_64", 9),
    ] {
        assert_eq!(
            backend_asset_for(&release, backend, os, arch).unwrap().name,
            names[expected]
        );
    }
    for (backend, os, arch) in [
        ("metal", "macos", "x86_64"),
        ("rocm", "macos", "aarch64"),
        ("rocm", "linux", "aarch64"),
        ("cpu", "linux", "riscv64"),
    ] {
        assert!(backend_asset_for(&release, backend, os, arch).is_none());
    }
    assert_eq!(
        companion_asset_name("b123", names[7]).as_deref(),
        Some("cudart-llama-b123-bin-ubuntu-cuda-13.4-x64.tar.gz")
    );
}

#[test]
fn the_newest_published_backend_archive_wins_over_the_newest_tag() {
    // The shape that broke runtime management: a release tag exists before
    // its build matrix finishes, so the newest tags carried partial asset
    // lists or none at all while an older one was complete.
    fn release(tag: &str, names: &[&str]) -> Rel {
        Rel {
            tag_name: tag.to_string(),
            assets: names
                .iter()
                .map(|name| Asset {
                    name: (*name).to_string(),
                    browser_download_url: format!("https://example.invalid/{name}"),
                    digest: None,
                    size: 0,
                })
                .collect(),
        }
    }
    let platform = "win";
    let releases = vec![
        release(
            "b11030",
            &[&format!("llama-b11030-bin-{platform}-cpu-x64.zip")],
        ),
        release("b11029", &[]),
        release("b11028", &[]),
        release(
            "b11026",
            &[
                &format!("llama-b11026-bin-{platform}-rocm-10.0-x64.zip"),
                &format!("llama-b11026-bin-{platform}-vulkan-x64.zip"),
            ],
        ),
    ];

    // The tag is still the newest one, which is what the tag lookup means.
    assert!(is_build_tag("b11030"));
    assert!(!is_build_tag("b"));
    assert!(!is_build_tag("master-abc"));

    // But the download has to come from the newest release that has it.
    let (release, asset) = newest_with_asset_for(&releases, "rocm", "windows", "x86_64")
        .expect("an older release published rocm");
    assert_eq!(release.tag_name, "b11026");
    assert_eq!(
        asset.name,
        format!("llama-b11026-bin-{platform}-rocm-10.0-x64.zip")
    );
    // A backend whose archive is the newest one still gets the newest.
    assert_eq!(
        newest_with_asset_for(&releases, "cpu", "windows", "x86_64")
            .expect("cpu published")
            .0
            .tag_name,
        "b11030"
    );
    // And a backend nobody published is reported rather than mis-served.
    assert!(newest_with_asset_for(&releases, "sycl", "windows", "x86_64").is_none());
    assert!(newest_with_asset_for(&[], "rocm", "windows", "x86_64").is_none());
}
