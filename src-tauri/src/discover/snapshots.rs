//! Hugging Face snapshots with stable local identities and verified manifests.
use super::digests::{verify_file_digest_with_progress, FileDigest};
use super::*;
use crate::providers::artifacts::{SnapshotFile, SnapshotManifest, SNAPSHOT_MANIFEST};
mod selected;
pub(super) use selected::selected_snapshot_plan;

/// A manifest this downloader writes lists at most `MAX_TREE_ENTRIES` paths.
/// Anything larger is not read into memory.
pub(crate) const MAX_SNAPSHOT_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;

/// Windows resolves these names to devices in every folder and with any
/// extension, so a repository file with one of them is never written.
fn reserved_device_name(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
}
pub(super) fn safe_file(path: &str) -> Result<(), AppError> {
    if path.ends_with(['/', '.', ' ']) || path.split('/').any(reserved_device_name) {
        return Err(AppError::validation("unsafe snapshot path"));
    }
    validate_repo_path(&format!("{path}.gguf"))
}

/// Upstream data must never overlap the app's ownership and update metadata.
pub(super) fn safe_data_file(path: &str) -> Result<(), AppError> {
    safe_file(path)?;
    if path.split('/').any(|part| {
        part.eq_ignore_ascii_case(SNAPSHOT_MANIFEST)
            || part
                .get(..".aiolm-".len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(".aiolm-"))
            || part
                .get(part.len().saturating_sub(".aiolm-update.json".len())..)
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".aiolm-update.json"))
    }) {
        return Err(AppError::validation(
            "repository file conflicts with AioLM metadata",
        ));
    }
    Ok(())
}

fn accepted(path: &str) -> bool {
    path.ends_with(".safetensors")
        || path.ends_with(".json")
        || path.ends_with(".tiktoken")
        || matches!(
            path.rsplit('/').next().unwrap_or_default(),
            "tokenizer.model"
                | "tiktoken.model"
                | "spiece.model"
                | "sentencepiece.bpe.model"
                | "vocab.txt"
                | "merges.txt"
                | "chat_template.jinja"
        )
}

/// Companions come from the selected file's folder, or the same repository's
/// root when the quantization files live in subfolders. Never follow base-model
/// references into another repository or include executable model code.
pub(super) fn gguf_companion_plan(
    entries: &[ApiTreeEntry],
    gguf: &str,
) -> Result<Vec<SnapshotFile>, AppError> {
    validate_repo_path(gguf)?;
    if is_mmproj(gguf) {
        return Err(AppError::validation(
            "GGUF companions require model weights, not a projector",
        ));
    }
    let parent = gguf
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/"))
        .unwrap_or_default();
    let prefix = if entries
        .iter()
        .any(|entry| entry.entry_type == "file" && entry.path == format!("{parent}config.json"))
    {
        parent
    } else {
        String::new()
    };
    let mut files = Vec::new();
    let mut unique = std::collections::HashSet::new();
    for entry in entries {
        let Some(name) = entry.path.strip_prefix(&prefix) else {
            continue;
        };
        if entry.entry_type != "file"
            || name.contains('/')
            || !accepted(name)
            || name.ends_with(".safetensors")
            || name.ends_with(".index.json")
        {
            continue;
        }
        safe_data_file(&entry.path)?;
        if entry.size > 512 * 1024 * 1024
            || (name == "config.json" && entry.size > MAX_API_RESPONSE_BYTES as u64)
        {
            return Err(AppError::validation(
                "GGUF loading asset exceeds its size limit",
            ));
        }
        if !unique.insert(name.to_ascii_lowercase()) {
            return Err(AppError::validation(
                "GGUF loading assets have colliding paths",
            ));
        }
        files.push(SnapshotFile {
            remote_path: None,
            path: entry.path.clone(),
            size: entry.size,
            oid: entry
                .lfs
                .as_ref()
                .and_then(|value| value.oid.clone())
                .or_else(|| entry.oid.clone()),
        });
    }
    let has = |name: &str| {
        files
            .iter()
            .any(|file| file.path == format!("{prefix}{name}"))
    };
    if !has("config.json")
        || (!["tokenizer.json", "tokenizer.model", "spiece.model"]
            .iter()
            .any(|name| has(name))
            && !(has("vocab.json") && has("merges.txt")))
    {
        return Err(AppError::not_found(
            "repository has no complete local GGUF config and tokenizer companions",
        ));
    }
    Ok(files)
}

pub(super) fn pending_gguf_companions(
    directory: &Path,
    files: &[SnapshotFile],
) -> Result<Vec<pending::PendingFile>, AppError> {
    files
        .iter()
        .map(|file| {
            let name = file
                .path
                .rsplit('/')
                .next()
                .ok_or_else(|| AppError::validation("empty companion path"))?;
            let target = checked_destination(directory, name, false)?;
            Ok(pending::PendingFile {
                path: target.to_string_lossy().into_owned(),
                size: file.size,
            })
        })
        .collect()
}

pub(super) async fn download_gguf_companions(
    app: &AppHandle,
    repo: &str,
    revision: &str,
    directory: &Path,
    files: &[SnapshotFile],
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let total: u64 = files.iter().map(|file| file.size).sum();
    let receipts = crate::benchmark::data_root().ok();
    let mut completed = 0;
    for file in files {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled(DOWNLOAD_CANCELLED));
        }
        let name = file
            .path
            .rsplit('/')
            .next()
            .ok_or_else(|| AppError::validation("empty companion path"))?;
        let target = destination(directory, name)?;
        let oid = file
            .oid
            .as_deref()
            .filter(|oid| digests::valid_oid(Some(oid)));
        if verify_existing(&target, file, receipts.as_deref(), cancel, |read| {
            emit_progress(app, repo, &file.path, "verifying", completed + read, total)
        })
        .await?
        {
            if oid.is_some() {
                note_download(&target, repo, &file.path, oid);
            }
            completed += file.size;
            continue;
        }
        let part = resume::fetch(
            &download_url_at(repo, &file.path, revision),
            &target,
            file.size,
            oid,
            cancel,
            |phase, received, _| {
                emit_progress(app, repo, &file.path, phase, completed + received, total)
            },
        )
        .await?;
        if let Err(error) = activate_download(&part, &target).await {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(error);
        }
        note_download(&target, repo, &file.path, oid);
        completed += file.size;
    }
    Ok(())
}

pub(super) fn validate_gguf_companions(path: &Path) -> Result<(), AppError> {
    let directory = path
        .parent()
        .ok_or_else(|| AppError::validation("GGUF has no companion directory"))?;
    let metadata =
        fs::metadata(directory.join("config.json")).map_err(|error| AppError::from_io(&error))?;
    if metadata.len() > MAX_API_RESPONSE_BYTES as u64 {
        return Err(AppError::validation("GGUF config exceeds its size limit"));
    }
    let config: serde_json::Value = serde_json::from_slice(
        &fs::read(directory.join("config.json")).map_err(|error| AppError::from_io(&error))?,
    )
    .map_err(|error| AppError::validation(error.to_string()))?;
    let model_type = config
        .get("model_type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AppError::validation("GGUF companion config has no model_type"))?;
    let expected_arch = if model_type == "mistral" {
        "llama"
    } else {
        model_type
    };
    let weights = crate::gguf::read_metadata(path).map_err(AppError::validation)?;
    if weights.architecture.as_deref() != Some(expected_arch) {
        return Err(AppError::validation(
            "GGUF companion config does not match the weights architecture",
        ));
    }
    // Architecture agreement is a loading prerequisite. Engine-specific
    // tensor types, dense-model support and platform checks remain in compat.
    Ok(())
}

/// The production download plan rejects snapshots that cannot become a local
/// root model, before creating an ownership manifest or downloading weights.
pub(super) fn plan_snapshot(entries: Vec<ApiTreeEntry>) -> Result<Vec<SnapshotFile>, AppError> {
    let mut paths = std::collections::HashSet::new();
    let files: Vec<SnapshotFile> = entries
        .into_iter()
        .filter(|entry| entry.entry_type == "file" && accepted(&entry.path))
        .map(|entry| {
            safe_data_file(&entry.path)?;
            if !paths.insert(entry.path.to_ascii_lowercase()) {
                return Err(AppError::validation("snapshot has colliding file paths"));
            }
            if entry.size > MAX_MODEL_BYTES {
                return Err(AppError::validation(
                    "snapshot file exceeds the model size limit",
                ));
            }
            Ok(SnapshotFile {
                remote_path: None,
                path: entry.path,
                size: entry.size,
                oid: entry.lfs.and_then(|value| value.oid).or(entry.oid),
            })
        })
        .collect::<Result<_, AppError>>()?;
    validate_loading_files(&files)?;
    Ok(files)
}

fn validate_loading_files(files: &[SnapshotFile]) -> Result<(), AppError> {
    let names: std::collections::HashSet<&str> =
        files.iter().map(|file| file.path.as_str()).collect();
    let has = |name: &str| names.contains(name);
    if !has("config.json")
        || !files
            .iter()
            .any(|file| !file.path.contains('/') && file.path.ends_with(".safetensors"))
    {
        return Err(AppError::not_found(
            "repository has no supported root safetensors snapshot",
        ));
    }
    if ![
        "tokenizer.json",
        "tokenizer.model",
        "tiktoken.model",
        "spiece.model",
        "sentencepiece.bpe.model",
        "vocab.txt",
    ]
    .iter()
    .any(|name| has(name))
        && !(has("vocab.json") && has("merges.txt"))
    {
        return Err(AppError::not_found(
            "snapshot is missing local tokenizer assets",
        ));
    }
    let mut checked_groups = std::collections::HashSet::new();
    for file in files {
        if let Some(stem) = file.path.strip_suffix(".safetensors") {
            if let Some((prefix, count)) = stem.rsplit_once("-of-") {
                if let Some((base, index)) = prefix.rsplit_once('-') {
                    if index.len() == 5
                        && count.len() == 5
                        && index
                            .bytes()
                            .chain(count.bytes())
                            .all(|byte| byte.is_ascii_digit())
                    {
                        let index: usize = index
                            .parse()
                            .map_err(|_| AppError::validation("invalid weight shard"))?;
                        let count: usize = count
                            .parse()
                            .map_err(|_| AppError::validation("invalid weight shard count"))?;
                        if index == 0 || index > count || count > MAX_TREE_ENTRIES {
                            return Err(AppError::validation("invalid weight shard count"));
                        }
                        if !checked_groups.insert(format!("{base}-of-{count:05}")) {
                            continue;
                        }
                        for part in 1..=count {
                            let path = format!("{base}-{part:05}-of-{count:05}.safetensors");
                            if !has(&path) {
                                return Err(AppError::not_found(format!(
                                    "snapshot is missing weight shard: {path}"
                                )));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Only bounded, app-owned manifests inside this repository's snapshot tree
/// count as installed. Reading this list never creates the library.
pub fn installed_snapshots(
    models_dir: &str,
    repo: &str,
) -> Result<Vec<crate::providers::artifacts::ModelArtifact>, AppError> {
    validate_repo_id(repo)?;
    if models_dir.trim().is_empty() {
        return Err(AppError::validation("models directory is empty"));
    }
    let Ok(library) = Path::new(models_dir).canonicalize() else {
        return Ok(Vec::new());
    };
    let directory = library
        .join("hf")
        .join(repo_directory(repo))
        .join("snapshots");
    let Ok(canonical) = directory.canonicalize() else {
        return Ok(Vec::new());
    };
    if !same_path_identity(&canonical, &directory) {
        return Err(AppError::validation("snapshot directory contains a link"));
    }
    let mut artifacts = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| AppError::from_io(&error))?
        .take(1000)
    {
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        let revision = entry.file_name().to_string_lossy().into_owned();
        if revision.len() != 40
            || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let Some(manifest) = read_snapshot_manifest(&entry.path().join(SNAPSHOT_MANIFEST))? else {
            continue;
        };
        // The directory is a stable local identity; an in-place update changes
        // the resolved revision in its manifest without moving the directory.
        if manifest.repository == repo {
            artifacts.push(crate::providers::artifacts::inspect_snapshot(&entry.path()));
        }
    }
    artifacts.sort_by(|left, right| right.revision.cmp(&left.revision));
    Ok(artifacts)
}
fn destination(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    checked_destination(root, relative, true)
}

/// Re-verification must not create directories before the ready manifest has
/// been invalidated. Existing parents still receive the same link checks.
pub(super) fn checked_destination(
    root: &Path,
    relative: &str,
    create_missing: bool,
) -> Result<PathBuf, AppError> {
    safe_file(relative)?;
    let parts: Vec<_> = relative.split('/').collect();
    let mut parent = root.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        if !parent.exists() {
            if !create_missing {
                continue;
            }
            fs::create_dir(&parent).map_err(|error| AppError::from_io(&error))?;
        }
        let canonical = parent
            .canonicalize()
            .map_err(|error| AppError::from_io(&error))?;
        if !same_path_identity(&canonical, &parent) {
            return Err(AppError::validation("snapshot destination contains a link"));
        }
    }
    Ok(parent.join(
        parts
            .last()
            .ok_or_else(|| AppError::validation("empty snapshot path"))?,
    ))
}

/// Join a manifest path with platform separators, so canonical comparisons of
/// the result are exact on Windows as well.
pub(crate) fn snapshot_path(directory: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(directory.to_path_buf(), |path, part| path.join(part))
}

/// Read a snapshot ownership manifest without following a link or reading an
/// unbounded file. `None` means there is no manifest at `path`.
pub(crate) fn read_snapshot_manifest(path: &Path) -> Result<Option<SnapshotManifest>, AppError> {
    read_snapshot_manifest_with_policy(path, false)
}

/// Readiness validates the whole JSON document, including unknown values;
/// repository lookup keeps its forward-compatible typed metadata behavior.
pub(crate) fn read_snapshot_manifest_for_inspection(
    path: &Path,
) -> Result<Option<SnapshotManifest>, AppError> {
    read_snapshot_manifest_with_policy(path, true)
}

fn read_snapshot_manifest_with_policy(
    path: &Path,
    strict_json: bool,
) -> Result<Option<SnapshotManifest>, AppError> {
    use std::io::Read;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(io_error(
                &error,
                format!("cannot inspect snapshot manifest: {error}"),
            ))
        }
    };
    if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT_MANIFEST_BYTES {
        return Err(AppError::validation(
            "snapshot manifest is not a bounded regular file",
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| {
            file.take(MAX_SNAPSHOT_MANIFEST_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| io_error(&error, format!("cannot read snapshot manifest: {error}")))?;
    if bytes.len() as u64 > MAX_SNAPSHOT_MANIFEST_BYTES {
        return Err(AppError::validation(
            "snapshot manifest is not a bounded regular file",
        ));
    }
    let manifest: SnapshotManifest = if strict_json {
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .and_then(serde_json::from_value::<SnapshotManifest>)
    } else {
        serde_json::from_slice(&bytes)
    }
    .map_err(|error| AppError::validation(format!("snapshot manifest is invalid: {error}")))?;
    if !matches!(manifest.format, 1 | 2) || manifest.files.len() > MAX_TREE_ENTRIES {
        return Err(AppError::validation("unsupported snapshot manifest"));
    }
    match (manifest.format, manifest.selected_file.is_some()) {
        (1, false) if manifest.files.iter().all(|file| file.remote_path.is_none()) => {}
        (2, true) => {}
        _ => {
            return Err(AppError::validation(
                "snapshot manifest format does not support its selection or path mappings",
            ))
        }
    }
    validate_repo_id(&manifest.repository)?;
    if manifest.revision.len() != 40
        || !manifest
            .revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::validation(
            "snapshot manifest has an invalid revision",
        ));
    }
    let mut unique = std::collections::HashSet::new();
    if manifest
        .files
        .iter()
        .any(|file| file.size > MAX_MODEL_BYTES || !unique.insert(file.path.to_ascii_lowercase()))
    {
        return Err(AppError::validation(
            "snapshot manifest lists duplicate paths or excessive file sizes",
        ));
    }
    if manifest
        .files
        .iter()
        .any(|file| safe_file(&file.path).is_err() || file.path == SNAPSHOT_MANIFEST)
    {
        return Err(AppError::validation(
            "snapshot manifest lists an unsafe path",
        ));
    }
    selected::validate_selection(&manifest)?;
    Ok(Some(manifest))
}

/// Accept a file already at a snapshot destination only when it is a regular
/// file of the declared size and, when published, of the SHA256 or Git blob digest.
/// Anything else is reported, never replaced. `Ok(false)` means it is absent.
async fn verify_existing<F: FnMut(u64)>(
    target: &Path,
    file: &SnapshotFile,
    receipts: Option<&Path>,
    cancel: &AtomicBool,
    progress: F,
) -> Result<bool, AppError> {
    let metadata = match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(io_error(
                &error,
                format!("cannot inspect snapshot file {}: {error}", file.path),
            ))
        }
    };
    if !metadata.is_file() || metadata.len() != file.size {
        return Err(AppError::validation(format!(
            "existing snapshot file failed verification: {}",
            file.path
        )));
    }
    // A file this application already proved against the same digest, and
    // that has not changed since, is not hashed again.
    if file
        .oid
        .as_deref()
        .is_some_and(|oid| !verified_before(receipts, target, oid))
    {
        verify_file_digest_with_progress(target, file, cancel, progress)
            .await
            .map_err(|error| {
                if error.kind == ErrorKind::Cancelled {
                    error
                } else {
                    AppError::new(
                        error.kind,
                        format!(
                            "existing snapshot file failed verification: {}: {error}",
                            file.path
                        ),
                    )
                }
            })?;
    }
    Ok(true)
}

/// Note under `receipts` that `target` holds `file` from `repository`, checked
/// against its published digest `oid`, so a later resume need not hash it.
fn record(
    receipts: Option<&Path>,
    target: &Path,
    repository: &str,
    file: &SnapshotFile,
    oid: &str,
) {
    if let Some(root) = receipts.filter(|_| digests::valid_oid(Some(oid))) {
        let _ = crate::benchmark::download_receipt::record_verified(
            root,
            target,
            repository,
            file.remote_path.as_deref().unwrap_or(&file.path),
            Some(oid),
        );
    }
}

/// Prefer a ready install at this revision, even when its stable folder names
/// the revision it was originally installed from before an in-place update.
fn snapshot_directory(
    library: &Path,
    repo: &str,
    revision: &str,
    selected: Option<&str>,
) -> Result<PathBuf, AppError> {
    let mut incomplete_selection = None;
    for artifact in installed_snapshots(&library.to_string_lossy(), repo)? {
        if artifact.ownership == "app"
            && artifact.repository.as_deref() == Some(repo)
            && artifact.revision.as_deref() == Some(revision)
            && artifact.selected_file.as_deref() == selected
        {
            if artifact.ready_files()
                && artifact.format != crate::providers::artifacts::ArtifactFormat::Unknown
            {
                return Ok(PathBuf::from(artifact.path));
            }
            // An updated selected model keeps its original directory even
            // after a missing/corrupt file invalidates completion on retry.
            if selected.is_some() && incomplete_selection.is_none() {
                incomplete_selection = Some(PathBuf::from(artifact.path));
            }
        }
    }
    if let Some(directory) = incomplete_selection {
        return Ok(directory);
    }
    // A selected install is a separate stable 160-bit namespace. Keeping a
    // 40-hex identity preserves catalog/update ownership guards and old paths.
    let identity = selected.map_or_else(
        || revision.to_owned(),
        |selected| {
            let mut hash = Sha256::new();
            hash.update(b"aiolm-selected-snapshot\0");
            hash.update(revision.as_bytes());
            hash.update(b"\0");
            hash.update(selected.as_bytes());
            format!("{:x}", hash.finalize())[..40].to_owned()
        },
    );
    Ok(destination(
        library,
        &format!("hf/{repo}/snapshots/{identity}/{SNAPSHOT_MANIFEST}"),
    )?
    .parent()
    .ok_or_else(|| AppError::validation("invalid snapshot directory"))?
    .to_path_buf())
}

pub async fn download_snapshot(
    app: AppHandle,
    repo: &str,
    models_dir: &str,
    file_path: Option<&str>,
    revision: Option<&str>,
    cancel: &AtomicBool,
) -> Result<crate::providers::artifacts::ModelArtifact, AppError> {
    validate_repo_id(repo)?;
    let revision = download_revision(revision, immutable_revision(repo, cancel)).await?;
    let entries = repository_tree(repo, &revision, cancel).await?;
    let (selected_file, files) = if let Some(selected) = file_path {
        let (canonical, files) =
            selected_snapshot_plan(repo, &revision, &entries, selected, cancel).await?;
        (Some(canonical), files)
    } else {
        (None, plan_snapshot(entries)?)
    };
    let library = models_root(models_dir)?;
    let snapshot = snapshot_directory(&library, repo, &revision, selected_file.as_deref())?;
    let mut manifest = SnapshotManifest {
        format: if selected_file.is_some() { 2 } else { 1 },
        repository: repo.into(),
        revision: revision.clone(),
        selected_file,
        files,
        complete: false,
    };
    // Remembered until it completes, so a pause or restart can continue it.
    let pending = pending::PendingDownload::new(
        (repo, &revision),
        file_path,
        true,
        models_dir,
        false,
        file_path.unwrap_or(repo),
        manifest
            .files
            .iter()
            .map(|file| pending::PendingFile {
                path: file
                    .path
                    .split('/')
                    .fold(snapshot.clone(), |path, part| path.join(part))
                    .to_string_lossy()
                    .into_owned(),
                size: file.size,
            })
            .collect(),
    );
    let pending_id = pending.id.clone();
    pending::remember(pending);
    let artifact = download_snapshot_files(
        &snapshot,
        &mut manifest,
        crate::benchmark::data_root().ok().as_deref(),
        cancel,
        |file, phase, received, total| emit_progress(&app, repo, file, phase, received, total),
    )
    .await?;
    pending::forget(&pending_id);
    Ok(artifact)
}

/// Keep metadata resolution and the app event adapter outside the install loop,
/// so local re-verification exercises the same path without a model or network.
async fn download_snapshot_files<F>(
    snapshot: &Path,
    manifest: &mut SnapshotManifest,
    receipts: Option<&Path>,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<crate::providers::artifacts::ModelArtifact, AppError>
where
    F: FnMut(&str, &str, u64, u64),
{
    let total = manifest
        .files
        .iter()
        .try_fold(0u64, |size, file| size.checked_add(file.size))
        .ok_or_else(|| AppError::validation("snapshot size overflow"))?;
    let mut completed = 0u64;
    progress(SNAPSHOT_MANIFEST, "downloading", 0, total);
    let manifest_path = snapshot.join(SNAPSHOT_MANIFEST);
    let mut previously_complete = false;
    if let Some(previous) = read_snapshot_manifest(&manifest_path)? {
        if previous.repository != manifest.repository
            || previous.revision != manifest.revision
            || previous.selected_entrypoint() != manifest.selected_entrypoint()
            || previous.files != manifest.files
        {
            return Err(AppError::validation(
                "existing snapshot manifest differs from the repository",
            ));
        }
        previously_complete = previous.complete;
    }
    if !previously_complete {
        crate::config::atomic_write(
            &manifest_path,
            &serde_json::to_vec_pretty(&manifest)
                .map_err(|error| AppError::internal(error.to_string()))?,
        )?;
    }
    let mut invalidate = || -> Result<(), AppError> {
        if previously_complete {
            crate::config::atomic_write(
                &manifest_path,
                &serde_json::to_vec_pretty(&manifest)
                    .map_err(|error| AppError::internal(error.to_string()))?,
            )?;
            previously_complete = false;
        }
        Ok(())
    };
    for file in &manifest.files {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled(DOWNLOAD_CANCELLED));
        }
        let target = match checked_destination(snapshot, &file.path, false) {
            Ok(target) => target,
            Err(error) => {
                invalidate()?;
                return Err(error);
            }
        };
        // A resumed download re-verifies without changing a ready manifest.
        match verify_existing(&target, file, receipts, cancel, |read| {
            progress(&file.path, "verifying", completed + read, total)
        })
        .await
        {
            Ok(true) => {
                if let Some(oid) = file.oid.as_deref() {
                    record(receipts, &target, &manifest.repository, file, oid);
                }
                completed += file.size;
                progress(&file.path, "downloading", completed, total);
                continue;
            }
            Ok(false) => invalidate()?,
            Err(error) => {
                // Cancellation is not evidence that existing data is bad.
                if error.kind != ErrorKind::Cancelled {
                    invalidate()?;
                }
                return Err(error);
            }
        }
        // Persist incomplete state before creating parents or staging data.
        let target = destination(snapshot, &file.path)?;
        let mut url = reqwest::Url::parse("https://huggingface.co")
            .map_err(|error| AppError::validation(error.to_string()))?;
        url.path_segments_mut()
            .map_err(|_| AppError::validation("invalid hub URL"))?
            .extend(manifest.repository.split('/'))
            .extend(["resolve", manifest.revision.as_str()])
            .extend(file.remote_path.as_deref().unwrap_or(&file.path).split('/'));
        let part = resume::fetch(
            url.as_str(),
            &target,
            file.size,
            file.oid.as_deref(),
            cancel,
            |phase, received, _| progress(&file.path, phase, completed + received, total),
        )
        .await?;
        // Activation never replaces a file that appeared at the destination.
        if let Err(error) = activate_download(&part, &target).await {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(error);
        }
        if let Some(oid) = file.oid.as_deref() {
            record(receipts, &target, &manifest.repository, file, oid);
        }
        completed += file.size;
        progress(&file.path, "downloading", completed, total);
    }
    // An index can reference a shard absent from the repository listing. Do
    // not publish completion until the downloaded loading metadata agrees.
    let artifact = crate::providers::artifacts::inspect_snapshot(snapshot);
    if !artifact.missing.is_empty()
        || (manifest.selected_file.is_none()
            && artifact.format == crate::providers::artifacts::ArtifactFormat::Unknown)
    {
        invalidate()?;
        let mut details = artifact.missing.join("; ");
        for note in &artifact.notes {
            if !details.is_empty() {
                details.push_str("; ");
            }
            details.push_str(note);
        }
        return Err(AppError::validation(format!(
            "snapshot loading files are incomplete or invalid: {details}"
        )));
    }
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled(DOWNLOAD_CANCELLED));
    }
    manifest.complete = true;
    crate::config::atomic_write(
        &manifest_path,
        &serde_json::to_vec_pretty(&manifest)
            .map_err(|error| AppError::internal(error.to_string()))?,
    )?;
    progress(SNAPSHOT_MANIFEST, "complete", completed, total);
    Ok(crate::providers::artifacts::inspect_snapshot(snapshot))
}
pub(super) async fn wait_cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(paths: &[&str]) -> Vec<ApiTreeEntry> {
        paths
            .iter()
            .map(|path| {
                serde_json::from_value(serde_json::json!({"path":path,"size":2,"type":"file"}))
                    .unwrap()
            })
            .collect()
    }

    fn manifest_with_unknown(
        repository: &str,
        revision: &str,
        root_value: Option<&str>,
        file_value: Option<&str>,
    ) -> Vec<u8> {
        let root_field =
            root_value.map_or(String::new(), |value| format!(r#","metadata":{value}"#));
        let file_field =
            file_value.map_or(String::new(), |value| format!(r#","metadata":{value}"#));
        format!(
            r#"{{"format":1,"repository":"{repository}","revision":"{revision}","files":[{{"path":"config.json","size":59{file_field}}},{{"path":"model.safetensors","size":1}},{{"path":"tokenizer.json","size":2}}],"complete":true{root_field}}}"#
        )
        .into_bytes()
    }

    fn noncanonical_manifest_with_unknown_file(repository: &str, revision: &str) -> Vec<u8> {
        format!(
            r#"{{  "complete" : true, "files" : [ {{ "size" : 59, "path" : "config.json", "metadata" : [ 1, 2, 3 ] }}, {{ "path" : "model.safetensors", "size" : 1 }}, {{ "size" : 2, "path" : "tokenizer.json" }} ], "revision" : "{revision}", "repository" : "{repository}", "format" : 1 }}"#
        )
        .into_bytes()
    }

    fn write_manifest_snapshot(root: &Path, revision: &str, manifest: &[u8]) -> PathBuf {
        let directory = root
            .join("hf")
            .join("owner")
            .join("model")
            .join("snapshots")
            .join(revision);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("config.json"),
            br#"{"model_type":"llama","architectures":["LlamaForCausalLM"]}"#,
        )
        .unwrap();
        fs::write(directory.join("model.safetensors"), b"x").unwrap();
        fs::write(directory.join("tokenizer.json"), b"{}").unwrap();
        fs::write(directory.join(SNAPSHOT_MANIFEST), manifest).unwrap();
        directory
    }

    fn repeat_snapshot_fixture(root: &Path) -> (PathBuf, SnapshotManifest) {
        let revision = "a".repeat(40);
        let snapshot = write_manifest_snapshot(
            root,
            &revision,
            &manifest_with_unknown("owner/model", &revision, None, None),
        );
        let mut manifest = read_snapshot_manifest(&snapshot.join(SNAPSHOT_MANIFEST))
            .unwrap()
            .unwrap();
        for file in &mut manifest.files {
            let bytes = fs::read(snapshot.join(&file.path)).unwrap();
            file.size = bytes.len() as u64;
            if file.path == "model.safetensors" {
                file.oid = Some(format!("{:x}", Sha256::digest(&bytes)));
            }
        }
        fs::write(
            snapshot.join(SNAPSHOT_MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        // The repository plan starts incomplete; the persisted install is ready.
        manifest.complete = false;
        (snapshot, manifest)
    }

    #[tokio::test]
    async fn recovery_after_main_moves_activates_original_staged_weights_and_empty_assets() {
        for selected in [None, Some("model.safetensors")] {
            let root = temporary("pinned-recovery").canonicalize().unwrap();
            let (snapshot, mut manifest) = repeat_snapshot_fixture(&root);
            manifest.selected_file = selected.map(str::to_owned);
            manifest.format = if selected.is_some() { 2 } else { 1 };
            manifest.files.push(SnapshotFile {
                remote_path: None,
                path: "merges.txt".into(),
                size: 0,
                oid: Some("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391".into()),
            });
            let mut header = serde_json::to_vec(&serde_json::json!({
                "weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}
            }))
            .unwrap();
            header.resize(header.len().div_ceil(8) * 8, b' ');
            let mut weight_bytes = (header.len() as u64).to_le_bytes().to_vec();
            weight_bytes.extend_from_slice(&header);
            weight_bytes.extend_from_slice(&1f32.to_le_bytes());
            fs::write(snapshot.join("model.safetensors"), &weight_bytes).unwrap();
            let weights = manifest
                .files
                .iter_mut()
                .find(|file| file.path == "model.safetensors")
                .unwrap();
            weights.size = weight_bytes.len() as u64;
            weights.oid = Some(format!("{:x}", Sha256::digest(&weight_bytes)));
            let weights = manifest
                .files
                .iter()
                .find(|file| file.path == "model.safetensors")
                .unwrap();
            let target = snapshot.join("model.safetensors");
            let part = resume::part_path(&target, weights.size, weights.oid.as_deref()).unwrap();
            fs::rename(&target, &part).unwrap();
            fs::write(
                snapshot.join(SNAPSHOT_MANIFEST),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            let pending = pending::PendingDownload::new(
                ("owner/model", &manifest.revision),
                selected,
                true,
                root.to_str().unwrap(),
                false,
                "model",
                vec![pending::PendingFile {
                    path: target.to_string_lossy().into_owned(),
                    size: weights.size,
                }],
            );
            let saved = serde_json::to_vec(&pending).unwrap();
            let pending: pending::PendingDownload = serde_json::from_slice(&saved).unwrap();
            let upstream_main = "b".repeat(40);
            let revision = download_revision(
                pending.revision.as_deref(),
                std::future::ready(Ok(upstream_main.clone())),
            )
            .await
            .unwrap();
            let destination =
                snapshot_directory(&root, "owner/model", &revision, selected).unwrap();
            assert_eq!(destination, snapshot);
            let mut verifying_weights = false;
            let artifact = download_snapshot_files(
                &destination,
                &mut manifest,
                None,
                &AtomicBool::new(false),
                |file, phase, _, _| {
                    if file == "model.safetensors" && phase == "verifying" {
                        verifying_weights = true;
                    }
                },
            )
            .await
            .unwrap();
            assert!(artifact.ready_files());
            assert_eq!(
                artifact.revision.as_deref(),
                Some(manifest.revision.as_str())
            );
            assert!(
                verifying_weights,
                "the saved weight bytes are verified before activation"
            );
            assert_eq!(fs::read(target).unwrap(), weight_bytes);
            assert_eq!(fs::read(snapshot.join("merges.txt")).unwrap(), b"");
            assert!(!part.exists());
            assert!(!snapshot.parent().unwrap().join(&upstream_main).exists());
            assert_eq!(
                download_revision(None, std::future::ready(Ok(upstream_main.clone())))
                    .await
                    .unwrap(),
                upstream_main,
                "a new download still resolves the latest main"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn updated_snapshot_keeps_its_folder_and_repeat_download_reuses_it() {
        let root = temporary("stable-revision").canonicalize().unwrap();
        let (snapshot, mut manifest) = repeat_snapshot_fixture(&root);
        let original_revision = manifest.revision.clone();
        let latest = "b".repeat(40);
        manifest.revision = latest.clone();
        manifest.complete = true;
        fs::write(
            snapshot.join(SNAPSHOT_MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let installed = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].path, snapshot.to_string_lossy());
        assert_eq!(installed[0].revision.as_deref(), Some(latest.as_str()));
        assert!(installed[0].ready_files());
        assert_eq!(
            snapshot.file_name().unwrap().to_string_lossy(),
            original_revision
        );

        let selected = snapshot_directory(&root, "owner/model", &latest, None).unwrap();
        assert_eq!(selected, snapshot);
        manifest.complete = false;
        let artifact = download_snapshot_files(
            &selected,
            &mut manifest,
            None,
            &AtomicBool::new(false),
            |_, _, _, _| {},
        )
        .await
        .unwrap();
        assert_eq!(artifact.path, installed[0].path);
        assert_eq!(artifact.revision.as_deref(), Some(latest.as_str()));
        assert!(artifact.ready_files());
        assert!(!snapshot.parent().unwrap().join(latest).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repeat_download_does_not_reuse_or_mutate_unrelated_snapshot_directories() {
        let root = temporary("snapshot-selection").canonicalize().unwrap();
        let latest = "b".repeat(40);
        let mut original_manifests = Vec::new();
        for (folder, repository, complete) in [
            ("a".repeat(40), "another/model", true),
            ("c".repeat(40), "owner/model", false),
            ("not-a-hex-folder".into(), "owner/model", true),
        ] {
            let mut value: serde_json::Value =
                serde_json::from_slice(&manifest_with_unknown(repository, &latest, None, None))
                    .unwrap();
            value["complete"] = complete.into();
            let bytes = serde_json::to_vec(&value).unwrap();
            let directory = write_manifest_snapshot(&root, &folder, &bytes);
            original_manifests.push((directory, bytes));
        }
        let installed = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
        assert_eq!(installed.len(), 1);
        assert!(installed[0].incomplete);
        let selected = snapshot_directory(&root, "owner/model", &latest, None).unwrap();
        assert_eq!(
            selected,
            root.join("hf/owner/model/snapshots").join(&latest)
        );
        for (directory, bytes) in original_manifests {
            assert_eq!(fs::read(directory.join(SNAPSHOT_MANIFEST)).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn resumed_git_blob_is_verified_but_missing_legacy_oid_stays_size_only() {
        let root = temporary("git-blob");
        let target = root.join("config.json");
        fs::write(&target, b"hello\n").unwrap();
        let mut file = SnapshotFile {
            remote_path: None,
            path: "config.json".into(),
            size: 6,
            oid: Some("ce013625030ba8dba906f756967f9e9ca394464a".into()),
        };
        let cancel = AtomicBool::new(false);
        assert!(verify_existing(&target, &file, None, &cancel, |_| {})
            .await
            .unwrap());
        fs::write(&target, b"world\n").unwrap();
        assert!(verify_existing(&target, &file, None, &cancel, |_| {})
            .await
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"world\n");
        file.oid = None;
        assert!(verify_existing(&target, &file, None, &cancel, |_| {})
            .await
            .unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn repeat_download_cancellation_preserves_ready_manifest() {
        for cancellation_file in [SNAPSHOT_MANIFEST, "model.safetensors", "tokenizer.json"] {
            let root = temporary("repeat-cancel");
            let (snapshot, mut manifest) = repeat_snapshot_fixture(&root);
            let manifest_path = snapshot.join(SNAPSHOT_MANIFEST);
            let original = fs::read(&manifest_path).unwrap();
            let cancel = AtomicBool::new(false);
            assert_eq!(
                download_snapshot_files(
                    &snapshot,
                    &mut manifest,
                    None,
                    &cancel,
                    |file, _, _, _| {
                        if file == cancellation_file {
                            cancel.store(true, Ordering::Release);
                        }
                    }
                )
                .await
                .unwrap_err(),
                AppError::cancelled(DOWNLOAD_CANCELLED)
            );
            assert_eq!(fs::read(&manifest_path).unwrap(), original);
            let installed = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
            assert_eq!(installed.len(), 1);
            assert!(
                installed[0].ready_files(),
                "{cancellation_file}: {installed:?}"
            );
            assert_eq!(fs::read(snapshot.join("model.safetensors")).unwrap(), b"x");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn corrupt_repeat_download_is_incomplete_even_when_cancelled_after_hashing() {
        let root = temporary("repeat-corrupt-cancel");
        let (snapshot, mut manifest) = repeat_snapshot_fixture(&root);
        fs::write(snapshot.join("model.safetensors"), b"z").unwrap();
        let cancel = AtomicBool::new(false);
        let error =
            download_snapshot_files(&snapshot, &mut manifest, None, &cancel, |file, _, _, _| {
                if file == "model.safetensors" {
                    cancel.store(true, Ordering::Release);
                }
            })
            .await
            .unwrap_err();
        assert!(cancel.load(Ordering::Acquire));
        assert!(error.message.contains("failed verification"), "{error}");
        assert!(
            !read_snapshot_manifest(&snapshot.join(SNAPSHOT_MANIFEST))
                .unwrap()
                .unwrap()
                .complete
        );
        let installed = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
        assert_eq!(installed.len(), 1);
        assert!(installed[0].incomplete);
        assert!(!installed[0].ready_files());
        assert_eq!(fs::read(snapshot.join("model.safetensors")).unwrap(), b"z");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn new_and_incomplete_downloads_stay_incomplete_on_cancellation() {
        for existing_manifest in [false, true] {
            let root = temporary("repeat-incomplete-cancel");
            let (snapshot, mut manifest) = repeat_snapshot_fixture(&root);
            let manifest_path = snapshot.join(SNAPSHOT_MANIFEST);
            if existing_manifest {
                fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            } else {
                fs::remove_file(&manifest_path).unwrap();
            }
            assert_eq!(
                download_snapshot_files(
                    &snapshot,
                    &mut manifest,
                    None,
                    &AtomicBool::new(true),
                    |_, _, _, _| {},
                )
                .await
                .unwrap_err(),
                AppError::cancelled(DOWNLOAD_CANCELLED)
            );
            let installed = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
            assert_eq!(installed.len(), 1);
            assert!(installed[0].incomplete);
            assert!(!installed[0].ready_files());
            fs::remove_dir_all(root).unwrap();
        }
    }

    fn deep_unknown_value(depth: usize) -> String {
        let mut value = String::from("null");
        for _ in 0..depth {
            value = format!(r#"{{"nested":{value}}}"#);
        }
        value
    }

    #[test]
    fn production_plan_keeps_loading_assets_and_optional_processors() {
        for tokenizer in [
            "tokenizer.json",
            "tokenizer.model",
            "tiktoken.model",
            "spiece.model",
            "sentencepiece.bpe.model",
            "vocab.txt",
        ] {
            let plan = plan_snapshot(tree(&[
                "config.json",
                "model.safetensors",
                tokenizer,
                "chat_template.jinja",
                "preprocessor_config.json",
                "modeling.py",
            ]))
            .unwrap();
            assert!(plan.iter().any(|file| file.path == tokenizer));
            assert!(plan.iter().any(|file| file.path == "chat_template.jinja"));
            assert!(plan
                .iter()
                .any(|file| file.path == "preprocessor_config.json"));
            assert!(!plan.iter().any(|file| file.path == "modeling.py"));
            assert!(
                plan_snapshot(tree(&["config.json", "model.safetensors", tokenizer])).is_ok(),
                "processor is optional"
            );
        }
        assert!(plan_snapshot(tree(&[
            "config.json",
            "model.safetensors",
            "vocab.json",
            "merges.txt"
        ]))
        .is_ok());
    }

    #[test]
    fn gguf_companions_plan_uses_only_selected_repository_loading_assets() {
        let entries = tree(&[
            "Q4/model.gguf",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "chat_template.jinja",
            "modeling.py",
            "other/config.json",
            "other/tokenizer.json",
            "model.safetensors",
        ]);
        let plan = gguf_companion_plan(&entries, "Q4/model.gguf").unwrap();
        assert_eq!(
            plan.iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "config.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "chat_template.jinja"
            ]
        );
        assert!(
            gguf_companion_plan(&tree(&["Q4/model.gguf", "config.json"]), "Q4/model.gguf").is_err()
        );
        let local = gguf_companion_plan(
            &tree(&[
                "Q4/model.gguf",
                "config.json",
                "tokenizer.json",
                "Q4/config.json",
                "Q4/vocab.json",
                "Q4/merges.txt",
            ]),
            "Q4/model.gguf",
        )
        .unwrap();
        assert!(local.iter().all(|file| file.path.starts_with("Q4/")));
        assert!(gguf_companion_plan(&entries, "model-00001-of-00002.gguf").is_ok());
        let sharded = gguf_companion_plan(
            &tree(&[
                "Q4/model-00001-of-00002.gguf",
                "Q4/model-00002-of-00002.gguf",
                "Q4/config.json",
                "Q4/tokenizer.json",
                "elsewhere/config.json",
            ]),
            "Q4/model-00001-of-00002.gguf",
        )
        .unwrap();
        assert_eq!(
            sharded
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["Q4/config.json", "Q4/tokenizer.json"]
        );
    }

    #[test]
    fn gguf_companion_configuration_must_match_the_downloaded_architecture() {
        use crate::gguf::fixture::{file, Value};
        let root = temporary("gguf-companions");
        let model = root.join("model.gguf");
        fs::write(
            &model,
            file(&[("general.architecture".into(), Value::Str("llama"))], &[]),
        )
        .unwrap();
        fs::write(root.join("config.json"), br#"{"model_type":"qwen2"}"#).unwrap();
        assert!(validate_gguf_companions(&model)
            .unwrap_err()
            .message
            .contains("does not match"));
        fs::write(root.join("config.json"), br#"{"model_type":"llama"}"#).unwrap();
        assert!(validate_gguf_companions(&model).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn production_plan_rejects_incomplete_models_and_path_collisions() {
        for paths in [
            vec!["model.safetensors", "tokenizer.json"],
            vec!["config.json", "sub/model.safetensors", "tokenizer.json"],
            vec!["config.json", "model.safetensors"],
            vec!["config.json", "model.safetensors", "vocab.json"],
            vec![
                "config.json",
                "model-00001-of-00002.safetensors",
                "tokenizer.json",
            ],
            vec![
                "config.json",
                "model.safetensors",
                "tokenizer.json",
                "CONFIG.json",
            ],
        ] {
            assert!(plan_snapshot(tree(&paths)).is_err(), "{paths:?}");
        }
        assert!(plan_snapshot(tree(&[
            "config.json",
            "model-00001-of-00002.safetensors",
            "model-00002-of-00002.safetensors",
            "model.safetensors.index.json",
            "tokenizer.json"
        ]))
        .is_ok());
    }

    #[test]
    fn repository_plans_reject_reserved_metadata_without_restricting_local_destinations() {
        for path in [
            SNAPSHOT_MANIFEST,
            ".AIOLM-staging.json",
            "weights.AIOLM-UPDATE.json",
            ".aiolm-staging/config.json",
            "sub/weights.aiolm-update.json",
        ] {
            assert!(
                plan_snapshot(tree(&[
                    "config.json",
                    "model.safetensors",
                    "tokenizer.json",
                    path
                ]))
                .is_err(),
                "{path}"
            );
            // Companion plans only select files in the same directory.
            if !path.contains('/') {
                assert!(
                    gguf_companion_plan(
                        &tree(&["config.json", "tokenizer.json", path]),
                        "model.gguf"
                    )
                    .is_err(),
                    "{path}"
                );
            }
        }
        assert!(gguf_companion_plan(
            &tree(&[
                ".aiolm-staging/config.json",
                ".aiolm-staging/tokenizer.json"
            ]),
            ".aiolm-staging/model.gguf",
        )
        .is_err());
        assert!(safe_file(SNAPSHOT_MANIFEST).is_ok());
    }

    #[test]
    fn installed_snapshots_distinguish_complete_hf_mlx_and_interrupted_downloads() {
        let root = temporary("installed");
        for (revision, config, complete) in [
            (
                "a".repeat(40),
                br#"{"model_type":"llama","architectures":["LlamaForCausalLM"]}"#.as_slice(),
                true,
            ),
            (
                "b".repeat(40),
                br#"{"model_type":"llama","quantization":{"bits":4,"group_size":64}}"#.as_slice(),
                true,
            ),
            (
                "c".repeat(40),
                br#"{"model_type":"llama"}"#.as_slice(),
                false,
            ),
        ] {
            let dir = root.join("hf/owner/model/snapshots").join(&revision);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("config.json"), config).unwrap();
            fs::write(dir.join("tokenizer.json"), b"{}").unwrap();
            if complete {
                fs::write(dir.join("model.safetensors"), b"xx").unwrap();
            }
            let files = plan_snapshot(tree(&[
                "config.json",
                "model.safetensors",
                "tokenizer.json",
            ]))
            .unwrap()
            .into_iter()
            .map(|mut file| {
                if file.path == "config.json" {
                    file.size = config.len() as u64;
                }
                file
            })
            .collect();
            let manifest = SnapshotManifest {
                selected_file: None,
                format: 1,
                repository: "owner/model".into(),
                revision,
                files,
                complete,
            };
            fs::write(
                dir.join(SNAPSHOT_MANIFEST),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
        }
        let artifacts = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
        assert_eq!(artifacts.len(), 3);
        assert_eq!(
            artifacts
                .iter()
                .map(|artifact| artifact.revision.clone())
                .collect::<Vec<_>>(),
            vec![
                Some("c".repeat(40)),
                Some("b".repeat(40)),
                Some("a".repeat(40))
            ]
        );
        assert!(artifacts.iter().any(|artifact| artifact.format
            == crate::providers::artifacts::ArtifactFormat::Mlx
            && artifact.ready_files()));
        assert!(artifacts.iter().any(|artifact| artifact.format
            == crate::providers::artifacts::ArtifactFormat::HfSafetensors
            && artifact.ready_files()));
        assert!(artifacts
            .iter()
            .any(|artifact| artifact.incomplete && !artifact.ready_files()));
        assert!(installed_snapshots(root.to_str().unwrap(), "other/model")
            .unwrap()
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_snapshots_match_ordinary_inspection_for_manifest_unknown_values() {
        let root = temporary("manifest-unknown-values");
        let invalid_values = [
            ("numeric", String::from("1e999")),
            ("surrogate", String::from(r#""\uD800""#)),
            ("deep", deep_unknown_value(130)),
        ];
        let mut invalid_results = Vec::new();
        for (value_name, value) in invalid_values {
            for (location, root_value, file_value) in [
                ("root", Some(value.as_str()), None),
                ("file", None, Some(value.as_str())),
            ] {
                let label = format!("{location}-{value_name}");
                let case_root = root.join(&label);
                let revision = "a".repeat(40);
                let manifest =
                    manifest_with_unknown("owner/model", &revision, root_value, file_value);
                let directory = write_manifest_snapshot(&case_root, &revision, &manifest);
                let installed =
                    installed_snapshots(case_root.to_str().unwrap(), "owner/model").unwrap();
                let ordinary_directory = directory.canonicalize().unwrap();
                let ordinary = crate::providers::artifacts::inspect_snapshot(&ordinary_directory);
                invalid_results.push((label, installed, ordinary));
            }
        }
        let mut mismatches = Vec::new();
        for (label, installed, ordinary) in invalid_results {
            if installed.len() != 1 {
                mismatches.push(format!(
                    "{label}: expected one listed artifact, installed={installed:?}"
                ));
            }
            if !ordinary.incomplete || ordinary.ownership != "external" || ordinary.notes.is_empty()
            {
                mismatches.push(format!(
                    "{label}: ordinary inspection did not preserve invalid-manifest behavior: {ordinary:?}"
                ));
            }
            if installed.first() != Some(&ordinary) {
                mismatches.push(format!(
                    "{label}: installed={installed:?}; ordinary={ordinary:?}"
                ));
            }
        }

        let valid_cases = [
            (
                "root-valid",
                manifest_with_unknown(
                    "owner/model",
                    &"b".repeat(40),
                    Some(r#"{"source":"fixture"}"#),
                    None,
                ),
            ),
            (
                "file-valid",
                manifest_with_unknown(
                    "owner/model",
                    &"c".repeat(40),
                    None,
                    Some(r#"{"source":"fixture","count":1}"#),
                ),
            ),
            (
                "file-noncanonical",
                noncanonical_manifest_with_unknown_file("owner/model", &"d".repeat(40)),
            ),
        ];
        let mut valid_results = Vec::new();
        for (label, manifest) in valid_cases {
            let case_root = root.join(label);
            let revision = match label {
                "root-valid" => "b".repeat(40),
                "file-valid" => "c".repeat(40),
                "file-noncanonical" => "d".repeat(40),
                _ => unreachable!(),
            };
            let directory = write_manifest_snapshot(&case_root, &revision, &manifest);
            let installed =
                installed_snapshots(case_root.to_str().unwrap(), "owner/model").unwrap();
            let ordinary_directory = directory.canonicalize().unwrap();
            let ordinary = crate::providers::artifacts::inspect_snapshot(&ordinary_directory);
            valid_results.push((label, installed, ordinary));
        }
        for (label, installed, ordinary) in valid_results {
            if installed.len() != 1 {
                mismatches.push(format!(
                    "{label}: expected one listed artifact, installed={installed:?}"
                ));
            }
            if !ordinary.ready_files() || ordinary.ownership != "app" || !ordinary.notes.is_empty()
            {
                mismatches.push(format!(
                    "{label}: ordinary inspection did not preserve valid-manifest behavior: {ordinary:?}"
                ));
            }
            if installed.first() != Some(&ordinary) {
                mismatches.push(format!(
                    "{label}: installed={installed:?}; ordinary={ordinary:?}"
                ));
            }
        }

        let nonmatching_repo_root = root.join("nonmatching-repository");
        let revision = "e".repeat(40);
        write_manifest_snapshot(
            &nonmatching_repo_root,
            &revision,
            &manifest_with_unknown("other/model", &revision, Some("1e999"), None),
        );
        let nonmatching_revision_root = root.join("nonmatching-revision");
        let directory_revision = "f".repeat(40);
        let stable_directory = write_manifest_snapshot(
            &nonmatching_revision_root,
            &directory_revision,
            &manifest_with_unknown("owner/model", &"0".repeat(40), Some("1e999"), None),
        );
        let nonmatching_repo =
            installed_snapshots(nonmatching_repo_root.to_str().unwrap(), "owner/model").unwrap();
        if !nonmatching_repo.is_empty() {
            mismatches.push(format!(
                "nonmatching-repository: expected skip, installed={nonmatching_repo:?}"
            ));
        }
        let nonmatching_revision =
            installed_snapshots(nonmatching_revision_root.to_str().unwrap(), "owner/model")
                .unwrap();
        let ordinary = crate::providers::artifacts::inspect_snapshot(
            &stable_directory.canonicalize().unwrap(),
        );
        if nonmatching_revision.as_slice() != [ordinary] {
            mismatches.push(format!(
                "stable-directory-revision: expected ordinary inspection, installed={nonmatching_revision:?}"
            ));
        }
        fs::remove_dir_all(root).unwrap();
        assert!(
            mismatches.is_empty(),
            "snapshot manifest behavior mismatches:\n{}",
            mismatches.join("\n")
        );
    }

    fn temporary(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("aiolm-snapshot-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn snapshot_paths_are_confined_and_executable_files_are_excluded() {
        assert!(accepted("config.json"));
        assert!(accepted("model-00001-of-00002.safetensors"));
        assert!(!accepted("modeling.py"));
        assert!(!accepted("pytorch_model.bin"));
        for path in [
            "../config.json",
            "/model.safetensors",
            "a\\config.json",
            "folder/../config.json",
            "nul.json",
            "sub/CON.safetensors",
            "com1.json",
            "lpt9.tokenizer.json",
        ] {
            assert!(safe_file(path).is_err(), "{path}");
        }
        for path in [
            "config.json",
            "console.json",
            "sub/con_config.json",
            "tokenizer.json",
        ] {
            assert!(safe_file(path).is_ok(), "{path}");
        }
        assert_eq!(
            snapshot_path(Path::new("root"), "a/b.json"),
            Path::new("root").join("a").join("b.json")
        );
    }

    #[test]
    fn manifests_are_read_bounded_and_validated() {
        let root = temporary("manifest");
        let path = root.join(SNAPSHOT_MANIFEST);
        assert!(read_snapshot_manifest(&path).unwrap().is_none());
        let manifest = SnapshotManifest {
            selected_file: None,
            format: 1,
            repository: "example/model".into(),
            revision: "0".repeat(40),
            files: vec![SnapshotFile {
                remote_path: None,
                path: "config.json".into(),
                size: 2,
                oid: None,
            }],
            complete: true,
        };
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            read_snapshot_manifest(&path).unwrap(),
            Some(manifest.clone())
        );
        for files in [
            vec![SnapshotFile {
                remote_path: None,
                path: "../outside.json".into(),
                size: 1,
                oid: None,
            }],
            vec![SnapshotFile {
                remote_path: None,
                path: SNAPSHOT_MANIFEST.into(),
                size: 1,
                oid: None,
            }],
            vec![
                SnapshotFile {
                    remote_path: None,
                    path: "config.json".into(),
                    size: 1,
                    oid: None,
                },
                SnapshotFile {
                    remote_path: None,
                    path: "CONFIG.json".into(),
                    size: 1,
                    oid: None,
                },
            ],
        ] {
            fs::write(
                &path,
                serde_json::to_vec(&SnapshotManifest {
                    files,
                    ..manifest.clone()
                })
                .unwrap(),
            )
            .unwrap();
            assert!(read_snapshot_manifest(&path).is_err());
        }
        fs::write(&path, b"{broken").unwrap();
        let error = read_snapshot_manifest(&path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Validation);
        assert!(error.message.contains("invalid"));
        fs::write(
            &path,
            serde_json::to_vec(&SnapshotManifest {
                format: 2,
                ..manifest.clone()
            })
            .unwrap(),
        )
        .unwrap();
        assert!(read_snapshot_manifest(&path).is_err());
        let oversized = fs::File::create(&path).unwrap();
        oversized.set_len(MAX_SNAPSHOT_MANIFEST_BYTES + 1).unwrap();
        drop(oversized);
        assert!(read_snapshot_manifest(&path)
            .unwrap_err()
            .message
            .contains("bounded"));
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(read_snapshot_manifest(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn resumed_files_are_verified_without_replacement_and_cancellably() {
        let root = temporary("verify");
        let target = root.join("model.safetensors");
        let bytes = b"synthetic weights".to_vec();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let file = SnapshotFile {
            remote_path: None,
            path: "model.safetensors".into(),
            size: bytes.len() as u64,
            oid: Some(digest.clone()),
        };
        let idle = AtomicBool::new(false);
        assert!(!verify_existing(&target, &file, None, &idle, |_| {})
            .await
            .unwrap());
        fs::write(&target, &bytes).unwrap();
        let mut reported = 0;
        assert!(
            verify_existing(&target, &file, None, &idle, |read| reported = read)
                .await
                .unwrap()
        );
        assert_eq!(reported, bytes.len() as u64);
        let prefixed = SnapshotFile {
            oid: Some(format!("sha256:{digest}")),
            ..file.clone()
        };
        assert!(verify_existing(&target, &prefixed, None, &idle, |_| {})
            .await
            .unwrap());
        assert_eq!(
            verify_existing(&target, &file, None, &AtomicBool::new(true), |_| {})
                .await
                .unwrap_err(),
            AppError::cancelled(DOWNLOAD_CANCELLED)
        );
        let different = b"synthetic weightz".to_vec();
        fs::write(&target, &different).unwrap();
        assert!(verify_existing(&target, &file, None, &idle, |_| {})
            .await
            .is_err());
        assert_eq!(
            fs::read(&target).unwrap(),
            different,
            "a mismatching file is reported, not replaced"
        );
        fs::write(&target, b"short").unwrap();
        assert!(verify_existing(&target, &file, None, &idle, |_| {})
            .await
            .is_err());
        let unverifiable = SnapshotFile {
            remote_path: None,
            path: "config.json".into(),
            size: 5,
            oid: None,
        };
        assert!(verify_existing(&target, &unverifiable, None, &idle, |_| {})
            .await
            .unwrap());
        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(verify_existing(&target, &file, None, &idle, |_| {})
            .await
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn destinations_refuse_linked_directories() {
        // Production resolves the library root before joining destinations.
        // macOS temporary directories can have a symlinked ancestor.
        let root = temporary("links").canonicalize().unwrap();
        let outside = temporary("outside");
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        assert!(destination(&root, "linked/config.json").is_err());
        assert!(destination(&root, "nested/config.json").is_ok());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
