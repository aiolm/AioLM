use super::*;

pub async fn install(
    app: AppHandle,
    backend: &str,
    build: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, AppError> {
    install_with(
        &|phase, received, total| emit(&app, backend, build, phase, received, total),
        backend,
        build,
        cancel,
    )
    .await
}

pub async fn install_with(
    progress: ProgressSink<'_>,
    backend: &str,
    build: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, AppError> {
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("runtime install cancelled"));
    }
    validate_runtime_identifiers(backend, build)?;
    let info = latest_for(backend).await?;
    if info.build != build {
        return Err(AppError::validation(format!(
            "requested {build} but latest is {}",
            info.build
        )));
    }
    validate_asset_file_name(&info.file_name)?;
    let expected = normalize_digest(info.digest.as_deref().ok_or_else(|| {
        AppError::validation("release asset has no SHA-256 digest; refusing unverified install")
    })?)?;
    validate_download_url(&info.url)?;
    let companions = companion_assets(build, &info.file_name).await?;

    let root = runtimes_root();
    let download_root = crate::home::aiolm_home().join("downloads");
    tokio::task::spawn_blocking({
        let root = root.clone();
        let download_root = download_root.clone();
        move || {
            fs::create_dir_all(root).map_err(|error| AppError::from_io(&error))?;
            fs::create_dir_all(download_root).map_err(|error| AppError::from_io(&error))
        }
    })
    .await
    .map_err(|error| format!("runtime directory task failed: {error}"))??;
    let nonce = short_nonce();
    let archive_path = download_root.join(format!(".{nonce}-{}", info.file_name));
    let staging = root.join(format!(".{build}-{backend}.staging-{nonce}"));
    let mut cleanup = InstallCleanup::new(archive_path.clone(), staging.clone());

    let result = async {
        progress("downloading", 0.0, 0.0);
        download_to_file(progress, "downloading", &info.url, &archive_path, &cancel).await?;
        let hash_path = archive_path.clone();
        let actual = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
            .await
            .map_err(|error| format!("runtime hash task failed: {error}"))??;
        if actual != expected {
            return Err(AppError::validation(format!(
                "runtime archive digest mismatch: expected {expected}, got {actual}"
            )));
        }
        progress("verified", 1.0, 1.0);

        progress("extracting", 0.0, 0.0);
        let extract_archive = archive_path.clone();
        let extract_staging = staging.clone();
        let extract_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            if extract_staging.exists() {
                fs::remove_dir_all(&extract_staging).map_err(|error| AppError::from_io(&error))?;
            }
            archive::extract_release(&extract_archive, &extract_staging, &extract_cancel)?;
            verify_runtime_files(&extract_staging)
        })
        .await
        .map_err(|error| format!("runtime extraction task failed: {error}"))??;

        // Vendor sidecars (currently only the CUDA runtime) land in the same
        // staging directory so the preflight below sees a complete runtime.
        for companion in companions {
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::cancelled("runtime install cancelled"));
            }
            validate_asset_file_name(&companion.name)?;
            let expected = normalize_digest(companion.digest.as_deref().ok_or_else(|| {
                AppError::validation(format!(
                    "{} has no SHA-256 digest; refusing unverified install",
                    companion.name
                ))
            })?)?;
            validate_download_url(&companion.browser_download_url)?;
            let companion_path = download_root.join(format!(".{nonce}-{}", companion.name));
            cleanup.track_archive(companion_path.clone());
            progress("downloading", 0.0, 0.0);
            download_to_file(
                progress,
                "downloading",
                &companion.browser_download_url,
                &companion_path,
                &cancel,
            )
            .await?;
            let hash_path = companion_path.clone();
            let actual = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
                .await
                .map_err(|error| format!("runtime hash task failed: {error}"))??;
            if actual != expected {
                return Err(AppError::validation(format!(
                    "{} digest mismatch: expected {expected}, got {actual}",
                    companion.name
                )));
            }
            let extract_companion = companion_path.clone();
            let extract_staging = staging.clone();
            let extract_cancel = cancel.clone();
            tokio::task::spawn_blocking(move || {
                archive::extract_release(&extract_companion, &extract_staging, &extract_cancel)
            })
            .await
            .map_err(|error| format!("runtime extraction task failed: {error}"))??;
        }

        // Upstream Windows ROCm archives can omit redistributable BLAS DLLs
        // and architecture kernel data. Package them from the detected local
        // SDK before the isolated preflight, just as source-built runtimes do.
        let dependency_backend = backend.to_string();
        let dependency_staging = staging.clone();
        let dependency_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            copy_backend_runtime_dependencies(
                &dependency_backend,
                &dependency_staging,
                &dependency_cancel,
            )
        })
        .await
        .map_err(|error| format!("runtime dependency packaging task failed: {error}"))??;

        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        let size_staging = staging.clone();
        let size_mb = tokio::task::spawn_blocking(move || dir_size(&size_staging))
            .await
            .map_err(|error| format!("runtime size task failed: {error}"))?;
        let version = preflight_staged_runtime(&staging, backend, progress, &cancel).await?;
        if let Some(version) = version.as_ref() {
            let manifest_staging = staging.clone();
            let version = version.clone();
            tokio::task::spawn_blocking(move || {
                write_version_manifest(&manifest_staging, &version)
            })
            .await
            .map_err(|error| format!("runtime manifest task failed: {error}"))?;
        }
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        let destination = runtime_dir(backend, build)?;
        let replace_staging = staging.clone();
        tokio::task::spawn_blocking(move || replace_runtime(&replace_staging, &destination))
            .await
            .map_err(|error| format!("runtime activation task failed: {error}"))??;
        progress("installed", 1.0, 1.0);
        let dest = runtime_dir(backend, build)?;
        let installed = InstalledRuntime {
            build: build.into(),
            backend: backend.into(),
            dir: dest.to_string_lossy().into_owned(),
            size_mb,
            version,
            source: None,
            replaced: None,
        };
        cleanup.commit();
        Ok(installed)
    }
    .await;
    cleanup.finish().await;
    result
}

/// Build a pull request locally with the user's installed CMake/toolchain and
/// place the resulting server, with any optional tools the build produced, in
/// the same managed-runtime layout as release archives.
pub async fn install_pr(
    app: AppHandle,
    backend: &str,
    source: &str,
    confirmed_commit: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, AppError> {
    let build = pull_request_build_id(source)?;
    install_pr_with(
        &|phase, received, total| emit(&app, backend, &build, phase, received, total),
        backend,
        source,
        confirmed_commit,
        cancel,
    )
    .await
}

async fn install_pr_artifact_with(
    progress: ProgressSink<'_>,
    backend: &str,
    source: &RuntimeSource,
    artifact: PullRequestArtifact,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, AppError> {
    let root = runtimes_root();
    let download_root = crate::home::aiolm_home().join("downloads");
    let required_bytes = artifact.bytes.saturating_add(INSTALLED_RUNTIME_BYTES);
    let download_root = tokio::task::spawn_blocking(move || {
        fs::create_dir_all(root).map_err(|error| AppError::from_io(&error))?;
        fs::create_dir_all(&download_root).map_err(|error| AppError::from_io(&error))?;
        if let Some(error) = free_space_error(
            "prebuilt PR runtime",
            &download_root,
            required_bytes,
            available_bytes(&download_root),
        ) {
            return Err(error.into());
        }
        Ok::<_, AppError>(download_root)
    })
    .await
    .map_err(|error| format!("runtime directory task failed: {error}"))??;
    let archive_path = download_root.join(format!(".{}-{}", short_nonce(), artifact.name));
    let cleanup_path = archive_path.clone();
    let result = async {
        progress("resolving", 1.0, 1.0);
        progress("downloading", 0.0, artifact.bytes as f64);
        download_to_file(
            progress,
            "downloading",
            &artifact.url,
            &archive_path,
            &cancel,
        )
        .await?;
        import_bundle_with_digest(
            &archive_path,
            Some(&artifact.sha256),
            Some(backend),
            Some(source),
            progress,
            cancel,
        )
        .await
    }
    .await;
    let _ = tokio::task::spawn_blocking(move || fs::remove_file(cleanup_path)).await;
    result
}

/// Refuse a build whose head no longer matches what the user was shown.
///
/// The preview the user confirmed named one commit. Between that dialog and
/// this call the branch can be force-pushed, or a new commit pushed onto it -
/// which is exactly how an approved-looking PR turns into unreviewed code. The
/// confirmation is therefore for a *commit*, not for a PR number, and this is
/// where that is enforced. The frontend cannot skip it: the check runs here,
/// on data re-fetched from GitHub, not on anything the caller supplied.
pub(super) fn confirm_pull_request_head(
    confirmed: &str,
    resolved: &RuntimeSource,
) -> Result<(), AppError> {
    let confirmed = confirmed.trim().to_ascii_lowercase();
    validate_commit_sha(&confirmed).map_err(|_| {
        AppError::validation("this build was not confirmed against a head commit; review the pull request details and confirm again")
    })?;
    if confirmed != resolved.commit {
        return Err(AppError::validation(format!(
            "pull request #{} moved after you confirmed it: you approved commit {}, but its head is now {}. Review the new changes and confirm again before building them.",
            resolved.pull_request, confirmed, resolved.commit
        )));
    }
    Ok(())
}

pub async fn install_pr_with(
    progress: ProgressSink<'_>,
    backend: &str,
    source: &str,
    confirmed_commit: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, AppError> {
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("runtime install cancelled"));
    }
    let mut origin = resolve_pull_request(source).await?.source;
    // Re-fetched from GitHub a moment ago, then matched against what the user
    // actually approved. Everything after this point is pinned to that commit.
    confirm_pull_request_head(confirmed_commit, &origin)?;
    let build = format!("pr{}", origin.pull_request);
    validate_runtime_identifiers(backend, &build)?;
    // Prefer a repository-produced artifact for this exact PR/backend when it
    // exists. This is the path used on normal end-user PCs: no CMake,
    // compiler, SDK, or source checkout is needed. The embedded manifest is
    // still checked against the freshly resolved commit before activation.
    let artifact_lookup_error = match find_pull_request_artifact(&origin, backend).await {
        Ok(Some(artifact)) => {
            return install_pr_artifact_with(progress, backend, &origin, artifact, cancel).await;
        }
        Ok(None) => None,
        Err(error) => Some(error),
    };
    // No artifact is available, so this is the developer/source-build path.
    // Refuse a missing local toolchain before downloading a multi-hundred-MB
    // source archive.
    let cmake = source_build_preflight(backend).await.map_err(|build_error| {
        let message = if let Some(artifact_error) = artifact_lookup_error {
            format!(
                "prebuilt PR artifact lookup failed: {artifact_error}; local source build is unavailable: {build_error}"
            )
        } else {
            format!(
                "no compatible prebuilt PR artifact is published for this PC, and local source build is unavailable: {build_error}"
            )
        };
        AppError::new(build_error.kind, message)
    })?;

    // Short on purpose: nested Windows build paths still encounter MAX_PATH.
    let nonce = short_nonce();
    let root = runtimes_root();
    let download_root = crate::home::aiolm_home().join("downloads");
    let workspace = download_root.join(format!(".{nonce}-{build}-{backend}"));
    let required_bytes = required_build_bytes(backend);
    let (root, workspace) = tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&root).map_err(|error| AppError::from_io(&error))?;
        fs::create_dir_all(&download_root).map_err(|error| AppError::from_io(&error))?;
        // Check before downloading, and include the separate runtime volume:
        // activation needs space for the staged runtime and outgoing backup.
        if let Some(error) = free_space_error(
            "PR source build",
            &download_root,
            required_bytes,
            available_bytes(&download_root),
        ) {
            return Err(error.into());
        }
        if let Some(error) = free_space_error(
            "installed runtime",
            &root,
            INSTALLED_RUNTIME_BYTES,
            available_bytes(&root),
        ) {
            return Err(error.into());
        }
        fs::create_dir(&workspace).map_err(|error| AppError::from_io(&error))?;
        Ok::<_, AppError>((root, workspace))
    })
    .await
    .map_err(|error| format!("runtime workspace task failed: {error}"))??;
    let archive_path = workspace.join("source.zip");
    let source_extract = workspace.join("source");
    let build_root = workspace.join("build");
    let staging = root.join(format!(".{build}-{backend}.staging-{nonce}"));
    let mut cleanup = InstallCleanup::new(archive_path.clone(), staging.clone());
    cleanup.track_directory(workspace.clone());

    let result = async {
        let archive_url = source_archive_url(&origin)?;
        progress("resolving", 1.0, 1.0);
        progress("downloading source", 0.0, 0.0);
        download_to_file(
            progress,
            "downloading source",
            &archive_url,
            &archive_path,
            &cancel,
        )
        .await?;
        let hash_path = archive_path.clone();
        // GitHub publishes no digest for a source archive, so this hash is
        // computed here from the bytes we received. It records what was built;
        // it cannot confirm that those bytes were the right ones. The real
        // check is the commit id carried by the extracted tree, below.
        origin.archive_sha256 = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
            .await
            .map_err(|error| format!("runtime source hash task failed: {error}"))??;
        progress("recorded source digest", 1.0, 1.0);

        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        progress("extracting source", 0.0, 0.0);
        let extract_archive = archive_path.clone();
        let extract_destination = source_extract.clone();
        let extract_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            extract(&extract_archive, &extract_destination, &extract_cancel)
        })
        .await
        .map_err(|error| format!("runtime source extraction task failed: {error}"))??;
        let extracted_root = source_extract.clone();
        let source_root = tokio::task::spawn_blocking(move || find_source_root(&extracted_root))
            .await
            .map_err(|error| format!("runtime source inspection task failed: {error}"))??;
        // The one genuine integrity check available here: GitHub names a
        // source archive's top-level directory after the ref it was asked for,
        // and we asked by commit id. A tree that carries a different commit is
        // not the one the user approved, so it is refused rather than built.
        origin.commit_check = match archive_commit_check(&source_root, &origin.commit) {
            ArchiveCommitCheck::Matches => COMMIT_CHECK_MATCHED.to_string(),
            ArchiveCommitCheck::Unknown => {
                return Err(AppError::validation(format!(
                    "{COMMIT_CHECK_UNKNOWN}: the downloaded source does not expose a recognised commit directory, so aiolm refused to build it. Retry the pull request or inspect the archive manually; no runtime was activated."
                )));
            }
            ArchiveCommitCheck::Mismatch(found) => {
                return Err(AppError::validation(format!(
                    "the downloaded source is not the commit you confirmed: the archive contains {found}, not {}. The download was not used.",
                    origin.commit
                )));
            }
        };

        // Only asked for a CUDA build, and only after the source is on disk,
        // so a machine with no NVIDIA driver never pays for the probe.
        let architectures = if backend == "cuda" {
            cuda_architectures(
                crate::branding::env_var(CUDA_ARCHITECTURES_OVERRIDE).ok().as_deref(),
                &detected_cuda_capabilities().await,
            )
        } else {
            String::new()
        };
        let mut configure_args =
            source_build_configure_args(backend, &source_root, &build_root, &architectures)?;
        configure_args.push(reviewed_commit_define(&origin.commit)?);
        progress("configuring", 0.0, 0.0);
        run_cmake_command(
            &cmake,
            backend,
            progress,
            "configuring",
            &configure_args,
            &workspace,
            &cancel,
        )
        .await?;

        let build_args = source_build_args(&build_root);
        progress("building", 0.0, 0.0);
        run_cmake_command(
            &cmake,
            backend,
            progress,
            "building",
            &build_args,
            &workspace,
            &cancel,
        )
        .await?;

        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        progress("packaging", 0.0, 0.0);
        let build_root_for_find = build_root.clone();
        let binary_root =
            tokio::task::spawn_blocking(move || find_built_runtime_dir(&build_root_for_find))
                .await
                .map_err(|error| format!("runtime output inspection task failed: {error}"))??;
        let copy_source = binary_root.clone();
        let copy_destination = staging.clone();
        let copy_cancel = cancel.clone();
        let copy_backend = backend.to_string();
        tokio::task::spawn_blocking(move || {
            copy_runtime_tree(&copy_source, &copy_destination, &copy_cancel)?;
            copy_backend_runtime_dependencies(&copy_backend, &copy_destination, &copy_cancel)?;
            copy_msvc_runtime_dependencies(&copy_destination, &copy_cancel)?;
            verify_runtime_files(&copy_destination)
        })
        .await
        .map_err(|error| format!("runtime packaging task failed: {error}"))??;

        let size_staging = staging.clone();
        let size_mb = tokio::task::spawn_blocking(move || dir_size(&size_staging))
            .await
            .map_err(|error| format!("runtime size task failed: {error}"))?;
        let version = preflight_staged_runtime(&staging, backend, progress, &cancel).await?;
        if let Some(version) = version.as_ref() {
            reported_commit_matches_source(version, &origin.commit)?;
        }
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        let destination = runtime_dir(backend, &build)?;
        let replace_staging = staging.clone();
        let manifest_version = version.clone();
        let manifest_source = origin.clone();
        let replaced = tokio::task::spawn_blocking(move || {
            if let Some(version) = manifest_version.as_ref() {
                write_version_manifest(&replace_staging, version);
            }
            // Provenance must be recorded before the staged bytes activate.
            write_source_manifest(&replace_staging, &manifest_source)?;
            // Read before the swap, while the outgoing manifest still exists.
            let replaced = runtime_replacement(
                read_source_manifest(&destination).as_ref(),
                &manifest_source,
            );
            replace_runtime(&replace_staging, &destination)?;
            Ok::<_, AppError>(replaced)
        })
        .await
        .map_err(|error| format!("runtime activation task failed: {error}"))??;
        progress("installed", 1.0, 1.0);
        let dest = runtime_dir(backend, &build)?;
        let installed = InstalledRuntime {
            build: build.clone(),
            backend: backend.into(),
            dir: dest.to_string_lossy().into_owned(),
            size_mb,
            version,
            source: Some(origin.clone()),
            replaced,
        };
        cleanup.commit();
        Ok(installed)
    }
    .await;
    // A PR build leaves the largest mess in the app: the extracted source and
    // the CMake build tree together run to several GB. Awaiting the blocking
    // handoff keeps the removal off the runtime and off the next install.
    progress("cleaning up", 0.0, 0.0);
    cleanup.finish().await;
    result
}

/// A runtime requires llama-server. Optional tools such as llama-bench may be
/// absent; when an archive includes them, its manifest/hash checks still cover
/// those files like every other entry.
pub(super) fn verify_runtime_files(staging: &Path) -> Result<(), AppError> {
    if !staging.join(server_executable_name()).is_file() {
        return Err(AppError::not_found(format!(
            "runtime archive is missing {}",
            server_executable_name()
        )));
    }
    Ok(())
}

pub(super) async fn preflight_staged_runtime(
    staging: &Path,
    backend: &str,
    progress: ProgressSink<'_>,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<RuntimeVersion>, AppError> {
    // Only llama-server gates activation. The optional llama-bench helper is
    // probed later as a diagnostic and never blocks an otherwise valid runtime.
    let checks: [(&str, &[&str], &str); 3] = [
        (
            server_executable_name(),
            &["--version"],
            "llama-server --version",
        ),
        (server_executable_name(), &["--help"], "llama-server --help"),
        (
            server_executable_name(),
            &["--list-devices"],
            "llama-server --list-devices",
        ),
    ];
    let total = checks.len() as f64;
    let mut version = None;
    // Do not let a build host's CUDA/ROCm/Vulkan SDK or PATH hide a missing
    // sidecar. This makes the preflight answer the question that matters:
    // would the activated runtime work on a fresh PC with only its host GPU
    // driver installed?
    let environment = staged_runtime_environment(staging);
    for (index, (name, args, label)) in checks.into_iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        progress("preflight", index as f64, total);
        let executable = staging.join(name);
        let result = run_probe_with_cancel_and_environment(
            &executable,
            args,
            STAGED_PREFLIGHT_TIMEOUT,
            Some(cancel),
            &environment,
        )
        .await;
        if !result.success {
            let diagnostic = result
                .diagnostic
                .unwrap_or_else(|| "probe returned a non-success status".into());
            return Err(AppError::new(
                diagnostic.kind,
                format!("staged runtime preflight failed for {label}: {diagnostic}"),
            ));
        }
        let no_devices = if matches!(backend, "cuda" | "rocm" | "vulkan" | "sycl" | "metal") {
            crate::gpu::select_all_runtime_devices(backend, &probe_devices(&result.text)).is_empty()
        } else {
            result
                .text
                .lines()
                .map(str::trim)
                .all(|line| line.is_empty() || line == "Available devices:" || line == "(none)")
        };
        if backend != "cpu" && args == ["--list-devices"] && no_devices {
            return Err(AppError::unavailable(format!(
                "staged runtime preflight failed for {label}: runtime reported no accelerator devices"
            )));
        }
        if args == ["--version"] {
            version = parse_runtime_version(&result.text);
        }
    }
    progress("preflight", total, total);
    Ok(version)
}

pub(super) fn replace_runtime(staging: &Path, destination: &Path) -> Result<(), AppError> {
    replace_runtime_with(staging, destination, remove_tree_bounded)
}

pub(super) fn replace_runtime_with<F>(
    staging: &Path,
    destination: &Path,
    cleanup_backup: F,
) -> Result<(), AppError>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let parent = destination
        .parent()
        .ok_or_else(|| "runtime destination has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| AppError::from_io(&error))?;
    let backup = parent.join(format!(
        ".{}.backup-{}",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        Uuid::new_v4().simple()
    ));
    let had_old = destination.exists();
    if had_old {
        fs::rename(destination, &backup)
            .map_err(|error| AppError::io("failed to stage old runtime", &error))?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        if had_old {
            if let Err(rollback) = fs::rename(&backup, destination) {
                return Err(AppError::new(
                    AppError::io_kind(&error),
                    format!(
                        "failed to activate runtime: {error}; rollback also failed: {rollback}"
                    ),
                ));
            }
        }
        return Err(AppError::io("failed to activate runtime", &error));
    }
    if had_old {
        let _ = cleanup_backup(&backup);
    }
    Ok(())
}

pub(super) fn extract(path: &Path, dest: &Path, cancel: &Arc<AtomicBool>) -> Result<(), AppError> {
    archive::extract(path, dest, cancel)
}
