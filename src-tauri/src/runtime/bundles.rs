use super::*;

fn bundle_zip_error(error: zip::result::ZipError) -> AppError {
    match error {
        zip::result::ZipError::Io(error) => AppError::from_io(&error),
        error => AppError::internal(error.to_string()),
    }
}

pub(super) fn bundle_architecture() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

pub(super) fn bundle_relative_path(root: &Path, path: &Path) -> Result<String, AppError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::validation("runtime bundle file escaped its runtime directory"))?;
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(AppError::validation(
                "runtime bundle contains an invalid relative path",
            ));
        };
        let component = component
            .to_str()
            .ok_or_else(|| AppError::validation("runtime bundle contains a non-UTF-8 filename"))?;
        if component.is_empty() || component.contains(['/', '\\']) {
            return Err(AppError::validation(
                "runtime bundle contains an invalid filename",
            ));
        }
        components.push(component);
    }
    if components.is_empty() {
        return Err(AppError::validation(
            "runtime bundle contains an empty relative path",
        ));
    }
    Ok(components.join("/"))
}

pub(super) fn validate_bundle_manifest_path(value: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > 1024 || value.contains(['\\', '\0', ':']) {
        return Err(AppError::validation(
            "runtime bundle manifest contains an invalid relative path",
        ));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(AppError::validation(
            "runtime bundle manifest contains an absolute path",
        ));
    }
    let mut components = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(AppError::validation(
                "runtime bundle manifest contains an invalid relative path",
            ));
        };
        let component = component.to_str().ok_or_else(|| {
            AppError::validation("runtime bundle manifest contains a non-UTF-8 path")
        })?;
        if component.is_empty() {
            return Err(AppError::validation(
                "runtime bundle manifest contains an empty path component",
            ));
        }
        components.push(component);
    }
    if components.is_empty() || components.join("/") != value {
        return Err(AppError::validation(
            "runtime bundle manifest path must use normalized POSIX separators",
        ));
    }
    Ok(())
}

fn collect_runtime_files_recursive(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf, u64)>,
    depth: u32,
) -> Result<(), AppError> {
    if depth > 64 {
        return Err(AppError::validation(
            "runtime bundle directory nesting is too deep",
        ));
    }
    let entries = fs::read_dir(directory).map_err(|error| AppError::from_io(&error))?;
    for entry in entries {
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| AppError::from_io(&error))?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::validation(format!(
                "runtime bundle cannot contain a symbolic link: {}",
                path.display()
            )));
        }
        if metadata.is_dir() {
            collect_runtime_files_recursive(root, &path, files, depth + 1)?;
        } else if metadata.is_file() {
            let relative = bundle_relative_path(root, &path)?;
            if relative == RUNTIME_BUNDLE_MANIFEST || relative == "llama-board-runtime-bundle.json"
            {
                continue;
            }
            files.push((relative, path, metadata.len()));
        } else {
            return Err(AppError::validation(format!(
                "runtime bundle contains an unsupported filesystem entry: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub(super) fn collect_runtime_files(root: &Path) -> Result<Vec<(String, PathBuf, u64)>, AppError> {
    let mut files = Vec::new();
    collect_runtime_files_recursive(root, root, &mut files, 0)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

pub(super) fn validate_bundle_manifest(manifest: &RuntimeBundleManifest) -> Result<(), AppError> {
    if manifest.format != RUNTIME_BUNDLE_FORMAT {
        return Err(AppError::validation(format!(
            "unsupported runtime bundle format: {}",
            manifest.format
        )));
    }
    validate_runtime_identifiers(&manifest.backend, &manifest.build)?;
    if manifest.platform != release_platform() {
        return Err(AppError::validation(format!(
            "runtime bundle targets {}, but this app runs on {}",
            manifest.platform,
            release_platform()
        )));
    }
    if manifest.architecture != bundle_architecture() {
        return Err(AppError::validation(format!(
            "runtime bundle targets {}, but this app runs on {}",
            manifest.architecture,
            bundle_architecture()
        )));
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::validation(
            "runtime bundle has an invalid file list",
        ));
    }
    let mut previous = None;
    for file in &manifest.files {
        validate_bundle_manifest_path(&file.path)?;
        normalize_digest(&file.sha256)?;
        if previous.is_some_and(|value: &str| value >= file.path.as_str()) {
            return Err(AppError::validation(
                "runtime bundle manifest file list is not sorted",
            ));
        }
        previous = Some(file.path.as_str());
    }
    if manifest.build.starts_with("pr") {
        let source = manifest.source.as_ref().ok_or_else(|| {
            AppError::validation("PR runtime bundle has no source provenance manifest")
        })?;
        let expected = manifest.build[2..].parse::<u64>().map_err(|_| {
            AppError::validation("PR runtime bundle has an invalid pull request build id")
        })?;
        if source.pull_request != expected {
            return Err(AppError::validation(
                "PR runtime bundle provenance does not match its build id",
            ));
        }
        validate_commit_sha(&source.commit)?;
    }
    Ok(())
}

pub(super) fn read_bundle_manifest(root: &Path) -> Result<RuntimeBundleManifest, AppError> {
    let path = compatible_manifest(root, RUNTIME_BUNDLE_MANIFEST);
    let metadata = fs::metadata(&path).map_err(|error| {
        AppError::new(
            AppError::io_kind(&error),
            "runtime bundle is missing aiolm-runtime-bundle.json",
        )
    })?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err(AppError::validation("runtime bundle manifest is too large"));
    }
    let bytes = fs::read(&path).map_err(|error| AppError::from_io(&error))?;
    let manifest: RuntimeBundleManifest = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::validation(format!("runtime bundle manifest is invalid JSON: {error}"))
    })?;
    validate_bundle_manifest(&manifest)?;
    Ok(manifest)
}

pub(super) fn find_bundle_runtime_root(extracted: &Path) -> Result<PathBuf, AppError> {
    let entries = fs::read_dir(extracted).map_err(|error| AppError::from_io(&error))?;
    let mut roots = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|error| AppError::from_io(&error))?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::validation(
                "runtime bundle contains a symbolic link",
            ));
        }
        if !metadata.is_dir() {
            return Err(AppError::validation(
                "runtime bundle must contain one runtime directory",
            ));
        }
        roots.push(entry.path());
    }
    match roots.as_slice() {
        [root] => Ok(root.clone()),
        [] => Err(AppError::validation(
            "runtime bundle has no runtime directory",
        )),
        _ => Err(AppError::validation(
            "runtime bundle has multiple top-level directories",
        )),
    }
}

pub(super) fn verify_bundle_files(
    root: &Path,
    manifest: &RuntimeBundleManifest,
) -> Result<(), AppError> {
    let actual = collect_runtime_files(root)?;
    if actual.len() != manifest.files.len() {
        return Err(AppError::validation(format!(
            "runtime bundle file list mismatch: manifest has {}, archive has {}",
            manifest.files.len(),
            actual.len()
        )));
    }
    for ((actual_path, path, actual_bytes), declared) in actual.iter().zip(&manifest.files) {
        if actual_path != &declared.path || actual_bytes != &declared.bytes {
            return Err(AppError::validation(format!(
                "runtime bundle file metadata mismatch for {}",
                declared.path
            )));
        }
        let actual_hash = sha256_file(path)?;
        if actual_hash != declared.sha256 {
            return Err(AppError::validation(format!(
                "runtime bundle file digest mismatch for {}",
                declared.path
            )));
        }
    }
    if read_source_manifest(root) != manifest.source {
        return Err(AppError::validation(
            "runtime bundle source provenance does not match its manifest",
        ));
    }
    if read_version_manifest(root) != manifest.version {
        return Err(AppError::validation(
            "runtime bundle version manifest does not match its manifest",
        ));
    }
    verify_runtime_files(root)
}

fn bundle_sidecar_path(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("runtime.zip");
    output.with_file_name(format!("{name}.sha256"))
}

fn verify_optional_bundle_sidecar(archive: &Path) -> Result<(), AppError> {
    let sidecar = bundle_sidecar_path(archive);
    let metadata = match fs::metadata(&sidecar) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(AppError::new(
                AppError::io_kind(&error),
                format!(
                    "cannot inspect runtime bundle checksum {}: {error}",
                    sidecar.display()
                ),
            ));
        }
    };
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(AppError::validation(
            "runtime bundle checksum sidecar is invalid",
        ));
    }
    let text = fs::read_to_string(&sidecar).map_err(|error| {
        AppError::new(
            AppError::io_kind(&error),
            format!("cannot read runtime bundle checksum: {error}"),
        )
    })?;
    let mut fields = text.split_whitespace();
    let expected = normalize_digest(
        fields
            .next()
            .ok_or_else(|| AppError::validation("runtime bundle checksum is empty"))?,
    )?;
    let expected_name = fields
        .next()
        .ok_or_else(|| AppError::validation("runtime bundle checksum has no filename"))?
        .trim_start_matches('*');
    let actual_name = archive
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::validation("runtime bundle archive has no valid filename"))?;
    if expected_name != actual_name || fields.next().is_some() {
        return Err(AppError::validation(
            "runtime bundle checksum filename does not match the archive",
        ));
    }
    let actual = sha256_file(archive)?;
    if actual != expected {
        return Err(AppError::validation(format!(
            "runtime bundle checksum mismatch: expected {expected}, got {actual}"
        )));
    }
    Ok(())
}

/// Make a disposable export snapshot when the platform needs extra files. A
/// runtime built by an older aiolm may contain the GPU DLLs but not the
/// SDK's data files, and a normal Windows target may not contain the MSVC CRT.
/// Keeping the snapshot outside the installed directory means export never
/// mutates or silently upgrades the runtime the user is currently using.
fn prepare_export_root(
    root: &Path,
    backend: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<PathBuf>, AppError> {
    if !cfg!(windows) && !matches!(backend, "cuda" | "rocm") {
        return Ok(None);
    }
    let snapshot = runtimes_root().join(format!(".runtime-export-{}", short_nonce()));
    let result = (|| -> Result<(), AppError> {
        fs::create_dir_all(&snapshot).map_err(|error| AppError::from_io(&error))?;
        copy_runtime_tree(root, &snapshot, cancel)?;
        copy_backend_runtime_dependencies(backend, &snapshot, cancel)?;
        copy_msvc_runtime_dependencies(&snapshot, cancel)?;
        verify_runtime_files(&snapshot)
    })();
    match result {
        Ok(()) => Ok(Some(snapshot)),
        Err(error) => {
            let _ = remove_tree_bounded(&snapshot);
            Err(error)
        }
    }
}

struct ExportSnapshot(Option<PathBuf>);

impl ExportSnapshot {
    pub(super) fn root<'a>(&'a self, installed: &'a Path) -> &'a Path {
        self.0.as_deref().unwrap_or(installed)
    }
}

impl Drop for ExportSnapshot {
    fn drop(&mut self) {
        if let Some(snapshot) = self.0.take() {
            let _ = remove_tree_bounded(&snapshot);
        }
    }
}

/// Write an installed runtime as a self-contained archive that can be moved to
/// a PC with no build tools. The caller runs this blocking function on the
/// Tokio blocking pool because vendor runtime bundles can be several GB.
pub fn export_bundle(
    output: &Path,
    backend: &str,
    build: &str,
    progress: ProgressSink<'_>,
    cancel: &Arc<AtomicBool>,
) -> Result<RuntimeBundleInfo, AppError> {
    validate_runtime_identifiers(backend, build)?;
    let root = runtime_dir(backend, build)?;
    if !root.is_dir() {
        return Err(AppError::not_found("the selected runtime is not installed"));
    }
    let output = output.to_path_buf();
    let canonical_root = root.canonicalize().map_err(|error| {
        AppError::new(
            AppError::io_kind(&error),
            format!("cannot resolve runtime directory: {error}"),
        )
    })?;
    let output_parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(output_parent).map_err(|error| AppError::from_io(&error))?;
    let canonical_parent = output_parent.canonicalize().map_err(|error| {
        AppError::new(
            AppError::io_kind(&error),
            format!("cannot resolve export directory: {error}"),
        )
    })?;
    if canonical_parent.starts_with(&canonical_root) {
        return Err(AppError::validation(
            "choose an export location outside the installed runtime directory",
        ));
    }
    let runtime_bytes = dir_size_bytes(&root);
    let export_required = runtime_bytes
        .saturating_mul(2)
        .saturating_add(512 * 1024 * 1024);
    if let Some(error) = free_space_error(
        "runtime export",
        &canonical_parent,
        export_required,
        available_bytes(&canonical_parent),
    ) {
        return Err(AppError::unavailable(error));
    }
    let snapshot_parent = runtimes_root();
    if let Some(error) = free_space_error(
        "runtime export snapshot",
        &snapshot_parent,
        export_required,
        available_bytes(&snapshot_parent),
    ) {
        return Err(AppError::unavailable(error));
    }
    let snapshot = ExportSnapshot(prepare_export_root(&root, backend, cancel)?);
    let export_root = snapshot.root(&root);
    let files = collect_runtime_files(export_root)?;
    if files.is_empty() {
        return Err(AppError::validation("cannot export an empty runtime"));
    }
    let total_bytes = files.iter().map(|(_, _, bytes)| *bytes).sum::<u64>();
    if total_bytes > MAX_EXTRACTED_BYTES {
        return Err(AppError::validation(
            "runtime is too large to fit the configured portable bundle limit",
        ));
    }
    verify_runtime_files(export_root)?;
    let file_manifest = files
        .iter()
        .map(|(path, file, bytes)| {
            Ok(RuntimeBundleFile {
                path: path.clone(),
                bytes: *bytes,
                sha256: sha256_file(file)?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let manifest = RuntimeBundleManifest {
        format: RUNTIME_BUNDLE_FORMAT,
        backend: backend.into(),
        build: build.into(),
        platform: release_platform().into(),
        architecture: bundle_architecture().into(),
        version: read_version_manifest(export_root),
        source: read_source_manifest(export_root),
        files: file_manifest,
    };
    validate_bundle_manifest(&manifest)?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        AppError::internal(format!("failed to encode runtime bundle manifest: {error}"))
    })?;
    let root_name = format!("{build}-{backend}");
    let output_name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::validation("export path has no valid filename"))?;
    if !output_name.to_ascii_lowercase().ends_with(".zip") {
        return Err(AppError::validation(
            "runtime export must use a .zip filename",
        ));
    }
    let temp = output_parent.join(format!(".{output_name}.part-{}", short_nonce()));
    let result = (|| -> Result<RuntimeBundleInfo, AppError> {
        let file = fs::File::create(&temp).map_err(|error| AppError::from_io(&error))?;
        let mut archive = zip::ZipWriter::new(file);
        let mut copied_bytes = 0_u64;
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        archive
            .add_directory(format!("{root_name}/"), options)
            .map_err(bundle_zip_error)?;
        for (relative, path, declared_bytes) in &files {
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::cancelled("runtime install cancelled"));
            }
            #[cfg(unix)]
            let options = {
                use std::os::unix::fs::PermissionsExt;
                options.unix_permissions(
                    fs::metadata(path)
                        .map_err(|error| AppError::from_io(&error))?
                        .permissions()
                        .mode()
                        & 0o777,
                )
            };
            archive
                .start_file(format!("{root_name}/{relative}"), options)
                .map_err(bundle_zip_error)?;
            let mut source = fs::File::open(path).map_err(|error| AppError::from_io(&error))?;
            let mut buffer = [0_u8; 1024 * 1024];
            let mut file_bytes = 0_u64;
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(AppError::cancelled("runtime install cancelled"));
                }
                let read = std::io::Read::read(&mut source, &mut buffer)
                    .map_err(|error| AppError::from_io(&error))?;
                if read == 0 {
                    break;
                }
                std::io::Write::write_all(&mut archive, &buffer[..read])
                    .map_err(|error| AppError::from_io(&error))?;
                file_bytes = file_bytes.saturating_add(read as u64);
                copied_bytes = copied_bytes.saturating_add(read as u64);
                progress("packaging", copied_bytes as f64, total_bytes as f64);
            }
            if file_bytes != *declared_bytes {
                return Err(AppError::validation(format!(
                    "runtime file changed while exporting: {relative}"
                )));
            }
        }
        archive
            .start_file(format!("{root_name}/{RUNTIME_BUNDLE_MANIFEST}"), options)
            .map_err(bundle_zip_error)?;
        std::io::Write::write_all(&mut archive, &manifest_bytes)
            .map_err(|error| AppError::from_io(&error))?;
        archive.finish().map_err(bundle_zip_error)?;
        let bytes = fs::metadata(&temp)
            .map_err(|error| AppError::from_io(&error))?
            .len();
        if bytes > MAX_ARCHIVE_BYTES {
            return Err(AppError::validation(
                "exported runtime bundle exceeds the configured archive size limit",
            ));
        }
        let archive_sha256 = sha256_file(&temp)?;
        if output.is_dir() {
            return Err(AppError::validation(format!(
                "export path is a directory: {}",
                output.display()
            )));
        }
        let backup = if output.exists() {
            let backup = output_parent.join(format!(".{output_name}.backup-{}", short_nonce()));
            fs::rename(&output, &backup).map_err(|error| {
                AppError::new(
                    AppError::io_kind(&error),
                    format!("failed to replace existing export: {error}"),
                )
            })?;
            Some(backup)
        } else {
            None
        };
        if let Err(error) = fs::rename(&temp, &output) {
            if let Some(backup) = backup.as_ref() {
                let _ = fs::rename(backup, &output);
            }
            return Err(AppError::from_io(&error));
        }
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
        let sidecar = bundle_sidecar_path(&output);
        fs::write(&sidecar, format!("{archive_sha256}  {output_name}\n")).map_err(|error| {
            AppError::new(
                AppError::io_kind(&error),
                format!("failed to write export checksum: {error}"),
            )
        })?;
        progress("installed", bytes as f64, bytes as f64);
        Ok(RuntimeBundleInfo {
            path: output.to_string_lossy().into_owned(),
            backend: backend.into(),
            build: build.into(),
            archive_sha256,
            bytes,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

async fn remove_import_staging(staging: &Path) {
    let staging = staging.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || remove_tree_bounded(&staging)).await;
}

/// Import a bundle produced by export_bundle. The input archive is never
/// deleted or modified; only the private staging directory is cleaned up on
/// failure. No local compiler, CMake, or vendor SDK is consulted here.
pub async fn import_bundle(
    archive: &Path,
    progress: ProgressSink<'_>,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, AppError> {
    import_bundle_with_digest(archive, None, None, None, progress, cancel).await
}

pub(super) async fn import_bundle_with_digest(
    archive: &Path,
    expected_archive_sha256: Option<&str>,
    expected_backend: Option<&str>,
    expected_source: Option<&RuntimeSource>,
    progress: ProgressSink<'_>,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, AppError> {
    let archive = archive.to_path_buf();
    let expected_archive_sha256 = expected_archive_sha256.map(normalize_digest).transpose()?;
    let metadata = tokio::task::spawn_blocking({
        let archive = archive.clone();
        move || fs::metadata(&archive).map_err(|error| AppError::from_io(&error))
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                crate::error::ErrorKind::Cancelled
            } else {
                crate::error::ErrorKind::Internal
            },
            format!("runtime bundle metadata task failed: {error}"),
        )
    })??;
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(AppError::validation(
            "runtime bundle exceeds the configured archive size limit",
        ));
    }
    if !metadata.is_file() {
        return Err(AppError::validation("runtime bundle path is not a file"));
    }
    let sidecar_path = archive.clone();
    tokio::task::spawn_blocking(move || verify_optional_bundle_sidecar(&sidecar_path))
        .await
        .map_err(|error| {
            AppError::new(
                if error.is_cancelled() {
                    crate::error::ErrorKind::Cancelled
                } else {
                    crate::error::ErrorKind::Internal
                },
                format!("runtime bundle checksum task failed: {error}"),
            )
        })??;
    if let Some(expected) = expected_archive_sha256 {
        let hash_path = archive.clone();
        let actual = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
            .await
            .map_err(|error| {
                AppError::new(
                    if error.is_cancelled() {
                        crate::error::ErrorKind::Cancelled
                    } else {
                        crate::error::ErrorKind::Internal
                    },
                    format!("runtime bundle hash task failed: {error}"),
                )
            })??;
        if actual != expected {
            return Err(AppError::validation(format!(
                "prebuilt PR artifact digest mismatch: expected {expected}, got {actual}"
            )));
        }
    }
    let root = runtimes_root();
    tokio::task::spawn_blocking({
        let root = root.clone();
        move || fs::create_dir_all(root).map_err(|error| AppError::from_io(&error))
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                crate::error::ErrorKind::Cancelled
            } else {
                crate::error::ErrorKind::Internal
            },
            format!("runtime bundle directory task failed: {error}"),
        )
    })??;
    let staging = root.join(format!(".runtime-import-{}", short_nonce()));
    progress("extracting", 0.0, metadata.len() as f64);
    let extracted = staging.clone();
    let extract_archive = archive.clone();
    let extract_cancel = cancel.clone();
    let expected_backend = expected_backend.map(str::to_owned);
    let expected_source = expected_source.cloned();
    let verified = match tokio::task::spawn_blocking(move || {
        extract(&extract_archive, &extracted, &extract_cancel)?;
        let runtime_root = find_bundle_runtime_root(&extracted)?;
        let manifest = read_bundle_manifest(&runtime_root)?;
        let expected_name = format!("{}-{}", manifest.build, manifest.backend);
        if runtime_root.file_name().and_then(|value| value.to_str()) != Some(&expected_name) {
            return Err(AppError::validation(
                "runtime bundle directory does not match its manifest",
            ));
        }
        verify_bundle_files(&runtime_root, &manifest)?;
        if let Some(expected) = expected_backend {
            if manifest.backend != expected {
                return Err(AppError::validation(format!(
                    "prebuilt PR artifact targets backend {}, not {}",
                    manifest.backend, expected
                )));
            }
        }
        if let Some(expected) = expected_source.as_ref() {
            let actual = manifest.source.as_ref().ok_or_else(|| {
                AppError::validation("prebuilt PR artifact has no source provenance manifest")
            })?;
            if actual.pull_request != expected.pull_request {
                return Err(AppError::validation(format!(
                    "prebuilt PR artifact is for pull request #{}, not #{}",
                    actual.pull_request, expected.pull_request
                )));
            }
            if !actual.repository.eq_ignore_ascii_case(&expected.repository) {
                return Err(AppError::validation(format!(
                    "prebuilt PR artifact is for source repository {}, not {}",
                    actual.repository, expected.repository
                )));
            }
            if !actual.commit.eq_ignore_ascii_case(&expected.commit) {
                return Err(AppError::validation(format!(
                    "prebuilt PR artifact is for source commit {}, not {}",
                    actual.commit, expected.commit
                )));
            }
        }
        Ok::<(PathBuf, RuntimeBundleManifest), AppError>((runtime_root, manifest))
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            remove_import_staging(&staging).await;
            return Err(AppError::new(
                if error.is_cancelled() {
                    crate::error::ErrorKind::Cancelled
                } else {
                    crate::error::ErrorKind::Internal
                },
                format!("runtime bundle verification task failed: {error}"),
            ));
        }
    };
    let (runtime_root, manifest) = match verified {
        Ok(value) => value,
        Err(error) => {
            remove_import_staging(&staging).await;
            return Err(error);
        }
    };
    progress("verified", metadata.len() as f64, metadata.len() as f64);
    let size_root = runtime_root.clone();
    let size_mb = match tokio::task::spawn_blocking(move || dir_size(&size_root)).await {
        Ok(size_mb) => size_mb,
        Err(error) => {
            remove_import_staging(&staging).await;
            return Err(AppError::new(
                if error.is_cancelled() {
                    crate::error::ErrorKind::Cancelled
                } else {
                    crate::error::ErrorKind::Internal
                },
                format!("runtime bundle size task failed: {error}"),
            ));
        }
    };
    let version =
        match preflight_staged_runtime(&runtime_root, &manifest.backend, progress, &cancel).await {
            Ok(version) => version,
            Err(error) => {
                remove_import_staging(&staging).await;
                return Err(error);
            }
        };
    if cancel.load(Ordering::Acquire) {
        remove_import_staging(&staging).await;
        return Err(AppError::cancelled("runtime install cancelled"));
    }
    if let Some(version) = version.as_ref() {
        write_version_manifest(&runtime_root, version);
    }
    let destination = runtime_dir(&manifest.backend, &manifest.build)?;
    let existing = read_source_manifest(&destination);
    let replace_root = runtime_root.clone();
    if let Err(error) =
        tokio::task::spawn_blocking(move || replace_runtime(&replace_root, &destination))
            .await
            .map_err(|error| {
                AppError::new(
                    if error.is_cancelled() {
                        crate::error::ErrorKind::Cancelled
                    } else {
                        crate::error::ErrorKind::Internal
                    },
                    format!("runtime bundle activation task failed: {error}"),
                )
            })?
    {
        remove_import_staging(&staging).await;
        return Err(error);
    }
    let cleanup_staging = staging.clone();
    let _ = tokio::task::spawn_blocking(move || remove_tree_bounded(&cleanup_staging)).await;
    progress("installed", 1.0, 1.0);
    let replaced = match (&existing, &manifest.source) {
        (Some(previous), Some(incoming)) => runtime_replacement(Some(previous), incoming),
        _ => None,
    };
    let destination = runtime_dir(&manifest.backend, &manifest.build)?;
    Ok(InstalledRuntime {
        build: manifest.build,
        backend: manifest.backend,
        dir: destination.to_string_lossy().into_owned(),
        size_mb,
        version: version.or(manifest.version),
        source: manifest.source,
        replaced,
    })
}
