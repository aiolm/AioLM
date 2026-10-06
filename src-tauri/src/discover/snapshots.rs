//! Immutable Hugging Face snapshots with complete manifests and LFS checksums.
use super::*;
use crate::providers::artifacts::{SnapshotFile, SnapshotManifest, SNAPSHOT_MANIFEST};

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
fn safe_file(path: &str) -> Result<(), String> {
    if path.ends_with(['/', '.', ' ']) || path.split('/').any(reserved_device_name) {
        return Err("unsafe snapshot path".into());
    }
    validate_repo_path(&format!("{path}.gguf"))
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
) -> Result<Vec<SnapshotFile>, String> {
    validate_repo_path(gguf)?;
    if is_mmproj(gguf) || shard_group(gguf.rsplit('/').next().unwrap_or(gguf)).is_some() {
        return Err("GGUF companions require a single model file".into());
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
        safe_file(&entry.path)?;
        if entry.size > 512 * 1024 * 1024
            || (name == "config.json" && entry.size > MAX_API_RESPONSE_BYTES as u64)
        {
            return Err("GGUF loading asset exceeds its size limit".into());
        }
        if !unique.insert(name.to_ascii_lowercase()) {
            return Err("GGUF loading assets have colliding paths".into());
        }
        files.push(SnapshotFile {
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
        return Err("repository has no complete local GGUF config and tokenizer companions".into());
    }
    Ok(files)
}

pub(super) async fn download_gguf_companions(
    app: &AppHandle,
    repo: &str,
    revision: &str,
    directory: &Path,
    files: &[SnapshotFile],
    cancel: &AtomicBool,
) -> Result<(), String> {
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut completed = 0;
    for file in files {
        if cancel.load(Ordering::Acquire) {
            return Err(DOWNLOAD_CANCELLED.into());
        }
        let name = file.path.rsplit('/').next().ok_or("empty companion path")?;
        let target = destination(directory, name)?;
        if verify_existing(&target, file, cancel, |read| {
            emit_progress(
                app,
                repo,
                &file.path,
                "downloading",
                completed + read,
                total,
            )
        })
        .await?
        {
            completed += file.size;
            continue;
        }
        let response = tokio::select! {
            _ = wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
            response = download_client()?.get(download_url_at(repo, &file.path, revision)).send() => response.map_err(|error| error.to_string())?
        };
        validate_response_url(&response)?;
        if !response.status().is_success() {
            return Err(format!(
                "GGUF companion {}: HTTP {}",
                file.path,
                response.status()
            ));
        }
        let temporary = temporary_download_path(&target)?;
        let received = receive_download(
            response,
            &temporary,
            file.size,
            expected_sha256(file.oid.as_deref()).as_deref(),
            cancel,
            |phase, received, _| {
                emit_progress(app, repo, &file.path, phase, completed + received, total)
            },
        )
        .await?;
        if let Err(error) = activate_download(&temporary, &target).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        completed += received;
    }
    Ok(())
}

pub(super) fn validate_gguf_companions(path: &Path) -> Result<(), String> {
    let directory = path.parent().ok_or("GGUF has no companion directory")?;
    let metadata =
        fs::metadata(directory.join("config.json")).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_API_RESPONSE_BYTES as u64 {
        return Err("GGUF config exceeds its size limit".into());
    }
    let config: serde_json::Value = serde_json::from_slice(
        &fs::read(directory.join("config.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let model_type = config
        .get("model_type")
        .and_then(serde_json::Value::as_str)
        .ok_or("GGUF companion config has no model_type")?;
    let expected_arch = if model_type == "mistral" {
        "llama"
    } else {
        model_type
    };
    let weights = crate::gguf::read_metadata(path)?;
    if weights.architecture.as_deref() != Some(expected_arch) {
        return Err("GGUF companion config does not match the weights architecture".into());
    }
    // Architecture agreement is a loading prerequisite. Engine-specific
    // tensor types, dense-model support and platform checks remain in compat.
    Ok(())
}

/// The production download plan rejects snapshots that cannot become a local
/// root model, before creating an ownership manifest or downloading weights.
fn plan_snapshot(entries: Vec<ApiTreeEntry>) -> Result<Vec<SnapshotFile>, String> {
    let mut paths = std::collections::HashSet::new();
    let files: Vec<SnapshotFile> = entries
        .into_iter()
        .filter(|entry| entry.entry_type == "file" && accepted(&entry.path))
        .map(|entry| {
            safe_file(&entry.path)?;
            if !paths.insert(entry.path.to_ascii_lowercase()) {
                return Err("snapshot has colliding file paths".into());
            }
            if entry.size > MAX_MODEL_BYTES {
                return Err("snapshot file exceeds the model size limit".into());
            }
            Ok(SnapshotFile {
                path: entry.path,
                size: entry.size,
                oid: entry.lfs.and_then(|value| value.oid).or(entry.oid),
            })
        })
        .collect::<Result<_, String>>()?;
    let names: std::collections::HashSet<&str> =
        files.iter().map(|file| file.path.as_str()).collect();
    let has = |name: &str| names.contains(name);
    if !has("config.json")
        || !files
            .iter()
            .any(|file| !file.path.contains('/') && file.path.ends_with(".safetensors"))
    {
        return Err("repository has no supported root safetensors snapshot".into());
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
        return Err("snapshot is missing local tokenizer assets".into());
    }
    let mut checked_groups = std::collections::HashSet::new();
    for file in &files {
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
                        let index: usize = index.parse().map_err(|_| "invalid weight shard")?;
                        let count: usize =
                            count.parse().map_err(|_| "invalid weight shard count")?;
                        if index == 0 || index > count || count > MAX_TREE_ENTRIES {
                            return Err("invalid weight shard count".into());
                        }
                        if !checked_groups.insert(format!("{base}-of-{count:05}")) {
                            continue;
                        }
                        for part in 1..=count {
                            let path = format!("{base}-{part:05}-of-{count:05}.safetensors");
                            if !has(&path) {
                                return Err(format!("snapshot is missing weight shard: {path}"));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(files)
}

/// Only bounded, app-owned manifests inside this repository's snapshot tree
/// count as installed. Reading this list never creates the library.
pub fn installed_snapshots(
    models_dir: &str,
    repo: &str,
) -> Result<Vec<crate::providers::artifacts::ModelArtifact>, String> {
    validate_repo_id(repo)?;
    if models_dir.trim().is_empty() {
        return Err("models directory is empty".into());
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
        return Err("snapshot directory contains a link".into());
    }
    let mut artifacts = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .take(1000)
    {
        let entry = entry.map_err(|error| error.to_string())?;
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
        if manifest.repository == repo && manifest.revision == revision {
            artifacts.push(crate::providers::artifacts::inspect_snapshot(&entry.path()));
        }
    }
    artifacts.sort_by(|left, right| right.revision.cmp(&left.revision));
    Ok(artifacts)
}
fn destination(root: &Path, relative: &str) -> Result<PathBuf, String> {
    safe_file(relative)?;
    let parts: Vec<_> = relative.split('/').collect();
    let mut parent = root.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        if !parent.exists() {
            fs::create_dir(&parent).map_err(|error| error.to_string())?;
        }
        let canonical = parent.canonicalize().map_err(|error| error.to_string())?;
        if !same_path_identity(&canonical, &parent) {
            return Err("snapshot destination contains a link".into());
        }
    }
    Ok(parent.join(parts.last().ok_or("empty snapshot path")?))
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
pub(crate) fn read_snapshot_manifest(path: &Path) -> Result<Option<SnapshotManifest>, String> {
    use std::io::Read;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot inspect snapshot manifest: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT_MANIFEST_BYTES {
        return Err("snapshot manifest is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| {
            file.take(MAX_SNAPSHOT_MANIFEST_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("cannot read snapshot manifest: {error}"))?;
    if bytes.len() as u64 > MAX_SNAPSHOT_MANIFEST_BYTES {
        return Err("snapshot manifest is not a bounded regular file".into());
    }
    let manifest: SnapshotManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("snapshot manifest is invalid: {error}"))?;
    if manifest.format != 1 || manifest.files.len() > MAX_TREE_ENTRIES {
        return Err("unsupported snapshot manifest".into());
    }
    validate_repo_id(&manifest.repository)?;
    if manifest.revision.len() != 40
        || !manifest
            .revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("snapshot manifest has an invalid revision".into());
    }
    let mut unique = std::collections::HashSet::new();
    if manifest
        .files
        .iter()
        .any(|file| file.size > MAX_MODEL_BYTES || !unique.insert(file.path.to_ascii_lowercase()))
    {
        return Err("snapshot manifest lists duplicate paths or excessive file sizes".into());
    }
    if manifest
        .files
        .iter()
        .any(|file| safe_file(&file.path).is_err() || file.path == SNAPSHOT_MANIFEST)
    {
        return Err("snapshot manifest lists an unsafe path".into());
    }
    Ok(Some(manifest))
}

/// Accept a file already at a snapshot destination only when it is a regular
/// file of the declared size and, for LFS files, of the published digest.
/// Anything else is reported, never replaced. `Ok(false)` means it is absent.
async fn verify_existing<F: FnMut(u64)>(
    target: &Path,
    file: &SnapshotFile,
    cancel: &AtomicBool,
    progress: F,
) -> Result<bool, String> {
    let metadata = match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "cannot inspect snapshot file {}: {error}",
                file.path
            ))
        }
    };
    if !metadata.is_file() || metadata.len() != file.size {
        return Err(format!(
            "existing snapshot file failed verification: {}",
            file.path
        ));
    }
    let Some(expected) = expected_sha256(file.oid.as_deref()) else {
        return Ok(true);
    };
    if hash_existing_file(target, file.size, cancel, progress).await? != expected {
        return Err(format!(
            "existing snapshot file failed verification: {}",
            file.path
        ));
    }
    Ok(true)
}

pub async fn download_snapshot(
    app: AppHandle,
    repo: &str,
    models_dir: &str,
    cancel: &AtomicBool,
) -> Result<crate::providers::artifacts::ModelArtifact, String> {
    validate_repo_id(repo)?;
    let revision = immutable_revision(repo, cancel).await?;
    let entries = repository_tree(repo, &revision, cancel).await?;
    let files = plan_snapshot(entries)?;
    let library = models_root(models_dir)?;
    let snapshot = destination(
        &library,
        &format!("hf/{repo}/snapshots/{revision}/{SNAPSHOT_MANIFEST}"),
    )?
    .parent()
    .ok_or("invalid snapshot directory")?
    .to_path_buf();
    let mut manifest = SnapshotManifest {
        format: 1,
        repository: repo.into(),
        revision: revision.clone(),
        files,
        complete: false,
    };
    let total = manifest
        .files
        .iter()
        .try_fold(0u64, |size, file| size.checked_add(file.size))
        .ok_or("snapshot size overflow")?;
    let mut completed = 0u64;
    emit_progress(&app, repo, SNAPSHOT_MANIFEST, "downloading", 0, total);
    let manifest_path = snapshot.join(SNAPSHOT_MANIFEST);
    if let Some(previous) = read_snapshot_manifest(&manifest_path)? {
        if previous.repository != repo
            || previous.revision != revision
            || previous.files != manifest.files
        {
            return Err("existing snapshot manifest differs from the repository".into());
        }
    }
    crate::config::atomic_write(
        &manifest_path,
        &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;
    for file in &manifest.files {
        if cancel.load(Ordering::Acquire) {
            return Err(DOWNLOAD_CANCELLED.into());
        }
        let target = destination(&snapshot, &file.path)?;
        // A resumed download re-verifies what an earlier attempt finished.
        if verify_existing(&target, file, cancel, |read| {
            emit_progress(
                &app,
                repo,
                &file.path,
                "downloading",
                completed + read,
                total,
            )
        })
        .await?
        {
            completed += file.size;
            emit_progress(&app, repo, &file.path, "downloading", completed, total);
            continue;
        }
        let mut url =
            reqwest::Url::parse("https://huggingface.co").map_err(|error| error.to_string())?;
        url.path_segments_mut()
            .map_err(|_| "invalid hub URL")?
            .extend(repo.split('/'))
            .extend(["resolve", revision.as_str()])
            .extend(file.path.split('/'));
        let response = tokio::select! { _ = wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()), response = download_client()?.get(url).send() => response.map_err(|error| error.to_string())? };
        validate_response_url(&response)?;
        if !response.status().is_success() {
            return Err(format!(
                "snapshot file {}: HTTP {}",
                file.path,
                response.status()
            ));
        }
        let temporary = temporary_download_path(&target)?;
        let mut output = create_staging_file(&temporary).await?;
        let mut stream = response.bytes_stream();
        let mut received = 0u64;
        let mut hash = Sha256::new();
        let mut last_progress = std::time::Instant::now();
        let result = async {
            loop {
                let chunk = tokio::select! { _ = wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_owned()), chunk = stream.next() => chunk };
                let Some(chunk) = chunk else { break; };
                let chunk = chunk.map_err(|error| error.to_string())?;
                received = received.saturating_add(chunk.len() as u64);
                if received > file.size { return Err(format!("snapshot file exceeds declared size: {}", file.path)); }
                hash.update(&chunk); output.write_all(&chunk).await.map_err(|error| error.to_string())?;
                if last_progress.elapsed() >= DOWNLOAD_UPDATE_INTERVAL { emit_progress(&app, repo, &file.path, "downloading", completed + received, total); last_progress = std::time::Instant::now(); }
            }
            if received != file.size { return Err(format!("snapshot file is truncated: {}", file.path)); }
            if expected_sha256(file.oid.as_deref()).is_some_and(|expected| format!("{:x}", hash.finalize()) != expected) { return Err(format!("snapshot checksum mismatch: {}", file.path)); }
            output.sync_all().await.map_err(|error| error.to_string())?;
            Ok::<(), String>(())
        }.await;
        drop(output);
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        // Activation never replaces a file that appeared at the destination.
        if let Err(error) = activate_download(&temporary, &target).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        completed += received;
        emit_progress(&app, repo, &file.path, "downloading", completed, total);
    }
    // An index can reference a shard absent from the repository listing. Do
    // not publish completion until the downloaded loading metadata agrees.
    let artifact = crate::providers::artifacts::inspect_snapshot(&snapshot);
    if !artifact.missing.is_empty()
        || artifact.format == crate::providers::artifacts::ArtifactFormat::Unknown
    {
        return Err(format!(
            "snapshot loading files are incomplete or invalid: {}",
            artifact.missing.join(", ")
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    manifest.complete = true;
    crate::config::atomic_write(
        &manifest_path,
        &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;
    emit_progress(&app, repo, SNAPSHOT_MANIFEST, "complete", completed, total);
    Ok(crate::providers::artifacts::inspect_snapshot(&snapshot))
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
        assert!(gguf_companion_plan(&entries, "model-00001-of-00002.gguf").is_err());
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
            format: 1,
            repository: "example/model".into(),
            revision: "0".repeat(40),
            files: vec![SnapshotFile {
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
                path: "../outside.json".into(),
                size: 1,
                oid: None,
            }],
            vec![SnapshotFile {
                path: SNAPSHOT_MANIFEST.into(),
                size: 1,
                oid: None,
            }],
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
            path: "model.safetensors".into(),
            size: bytes.len() as u64,
            oid: Some(digest.clone()),
        };
        let idle = AtomicBool::new(false);
        assert!(!verify_existing(&target, &file, &idle, |_| {})
            .await
            .unwrap());
        fs::write(&target, &bytes).unwrap();
        let mut reported = 0;
        assert!(
            verify_existing(&target, &file, &idle, |read| reported = read)
                .await
                .unwrap()
        );
        assert_eq!(reported, bytes.len() as u64);
        let prefixed = SnapshotFile {
            oid: Some(format!("sha256:{digest}")),
            ..file.clone()
        };
        assert!(verify_existing(&target, &prefixed, &idle, |_| {})
            .await
            .unwrap());
        assert_eq!(
            verify_existing(&target, &file, &AtomicBool::new(true), |_| {})
                .await
                .unwrap_err(),
            DOWNLOAD_CANCELLED
        );
        let different = b"synthetic weightz".to_vec();
        fs::write(&target, &different).unwrap();
        assert!(verify_existing(&target, &file, &idle, |_| {})
            .await
            .is_err());
        assert_eq!(
            fs::read(&target).unwrap(),
            different,
            "a mismatching file is reported, not replaced"
        );
        fs::write(&target, b"short").unwrap();
        assert!(verify_existing(&target, &file, &idle, |_| {})
            .await
            .is_err());
        let unverifiable = SnapshotFile {
            path: "config.json".into(),
            size: 5,
            oid: Some("a".repeat(40)),
        };
        assert!(verify_existing(&target, &unverifiable, &idle, |_| {})
            .await
            .unwrap());
        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(verify_existing(&target, &file, &idle, |_| {})
            .await
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn destinations_refuse_linked_directories() {
        let root = temporary("links");
        let outside = temporary("outside");
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        assert!(destination(&root, "linked/config.json").is_err());
        assert!(destination(&root, "nested/config.json").is_ok());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
