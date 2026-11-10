//! File-level updates of proven app downloads. Never writes external Hub caches.
use super::*;
use crate::providers::artifacts::{SnapshotFile, SnapshotManifest, SNAPSHOT_MANIFEST};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize)]
pub struct ModelUpdateStatus {
    pub path: String,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_revision: Option<String>,
    pub update_available: bool,
    pub changed_files: usize,
    pub removed_files: usize,
    pub download_bytes: u64,
    pub reused_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelUpdateResult {
    pub path: String,
    pub revision: String,
    pub downloaded_bytes: u64,
    pub reused_bytes: u64,
    pub updated_files: usize,
    pub removed_files: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TrackedFile {
    remote: String,
    local: String,
    size: u64,
    oid: Option<String>,
}
impl TrackedFile {
    fn snapshot_file(&self) -> SnapshotFile {
        SnapshotFile {
            path: self.local.clone(),
            remote_path: (self.remote != self.local).then(|| self.remote.clone()),
            size: self.size,
            oid: self.oid.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct GgufManifest {
    format: u32,
    repository: String,
    revision: String,
    entrypoint: String,
    companions: bool,
    files: Vec<TrackedFile>,
}

struct Installed {
    path: String,
    root: PathBuf,
    metadata: PathBuf,
    repository: String,
    revision: Option<String>,
    selected_file: Option<String>,
    files: Vec<TrackedFile>,
    gguf: Option<(String, bool)>,
    // Metadata is compared again immediately before commit, including absence.
    previous_metadata: Option<Vec<u8>>,
}
struct Remote {
    revision: String,
    entries: Vec<ApiTreeEntry>,
}
struct Plan {
    installed: Installed,
    revision: String,
    files: Vec<TrackedFile>,
    changed: Vec<usize>,
    removed: Vec<usize>,
    download_bytes: u64,
    reused_bytes: u64,
    metadata: Vec<u8>,
    adopted_companions: bool,
}

enum PlanMode {
    Check,
    Apply,
}

fn valid_revision(revision: &str) -> bool {
    revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn gguf_metadata(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid GGUF filename")?;
    Ok(path.with_file_name(format!(".{name}.aiolm-update.json")))
}

// Check every existing component, not just the final canonical target. This
// refuses links even when they point back inside the selected library.
fn safe_destination(root: &Path, relative: &str) -> Result<PathBuf, String> {
    snapshots::safe_file(relative)?;
    let metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || !same_path_identity(
            &root.canonicalize().map_err(|error| error.to_string())?,
            root,
        )
    {
        return Err("model update root must be a real, unchanged directory".into());
    }
    let mut target = root.to_path_buf();
    for component in relative.split('/') {
        target.push(component);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("model update path contains a symbolic link".into())
            }
            Ok(_) => {
                let resolved = target.canonicalize().map_err(|error| error.to_string())?;
                if !same_path_identity(&resolved, &target) {
                    return Err("model update path contains a reparse point".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(target)
}
fn bounded_metadata(path: &Path) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.len() > snapshots::MAX_SNAPSHOT_MANIFEST_BYTES {
        return Err("update metadata must be a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| {
            file.take(snapshots::MAX_SNAPSHOT_MANIFEST_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > snapshots::MAX_SNAPSHOT_MANIFEST_BYTES {
        return Err("update metadata is too large".into());
    }
    Ok(Some(bytes))
}
fn validate_files(files: &[TrackedFile]) -> Result<(), String> {
    if files.is_empty() || files.len() > MAX_TREE_ENTRIES {
        return Err("invalid update file count".into());
    }
    let mut local = HashSet::new();
    let mut remote = HashSet::new();
    for file in files {
        snapshots::safe_file(&file.remote)?;
        snapshots::safe_file(&file.local)?;
        if file
            .local
            .split('/')
            .chain(file.remote.split('/'))
            .any(|part| {
                let part = part.to_ascii_lowercase();
                part == SNAPSHOT_MANIFEST
                    || part.starts_with(".aiolm-")
                    || part.ends_with(".aiolm-update.json")
            })
            || file.size > MAX_MODEL_BYTES
            || !local.insert(file.local.to_ascii_lowercase())
            || !remote.insert(file.remote.to_ascii_lowercase())
        {
            return Err("update metadata has unsafe or colliding file paths".into());
        }
    }
    // Reject file/directory collisions before a staging tree is created.
    for name in &local {
        for (index, _) in name.match_indices('/') {
            if local.contains(&name[..index]) {
                return Err("update files have a path collision".into());
            }
        }
    }
    Ok(())
}

fn load_installed(
    path: &str,
    models_dir: &str,
    receipt_root: Option<&Path>,
) -> Result<Installed, String> {
    let library = Path::new(models_dir)
        .canonicalize()
        .map_err(|error| format!("cannot open models library: {error}"))?;
    let supplied = Path::new(path);
    if !supplied.is_absolute() {
        return Err("model update requires an absolute local path".into());
    }
    let relative = supplied
        .strip_prefix(&library)
        .map_err(|_| "only models inside the selected library can be updated")?;
    let relative = relative
        .to_str()
        .ok_or("invalid model path")?
        .replace(std::path::MAIN_SEPARATOR, "/");
    let target = safe_destination(&library, &relative)?;
    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        let mut manifest = read_snapshot_manifest(&target.join(SNAPSHOT_MANIFEST))?
            .ok_or("model folder has no app snapshot ownership manifest")?;
        if !manifest.complete {
            return Err("incomplete snapshots must be resumed, not updated".into());
        }
        let expected_parent = library
            .join("hf")
            .join(repo_directory(&manifest.repository))
            .join("snapshots");
        if target.parent() != Some(expected_parent.as_path())
            || !target
                .file_name()
                .and_then(|v| v.to_str())
                .is_some_and(valid_revision)
        {
            return Err("snapshot is not in the app-owned library tree".into());
        }
        // Older selected manifests may name another member of the same index.
        // Normalize metadata only; the stable installed root remains untouched.
        if let Some(canonical) = manifest.selected_entrypoint() {
            if manifest.selected_file.as_deref() != Some(canonical) {
                manifest.selected_file = Some(canonical.to_owned());
            }
        }
        let files = manifest
            .files
            .into_iter()
            .map(|file| TrackedFile {
                remote: file.remote_path.unwrap_or_else(|| file.path.clone()),
                local: file.path,
                size: file.size,
                oid: file.oid,
            })
            .collect::<Vec<_>>();
        validate_files(&files)?;
        let metadata = target.join(SNAPSHOT_MANIFEST);
        let previous_metadata = bounded_metadata(&metadata)?;
        return Ok(Installed {
            path: path.into(),
            root: target,
            metadata,
            repository: manifest.repository,
            revision: Some(manifest.revision),
            selected_file: manifest.selected_file,
            files,
            gguf: None,
            previous_metadata,
        });
    }
    if !metadata.is_file() {
        return Err("model is not a regular file or snapshot directory".into());
    }
    let root = target.parent().ok_or("model has no parent")?.to_path_buf();
    let metadata = gguf_metadata(&target)?;
    let previous_metadata = bounded_metadata(&metadata)?;
    if let Some(bytes) = &previous_metadata {
        let manifest: GgufManifest = serde_json::from_slice(bytes)
            .map_err(|error| format!("invalid GGUF update metadata: {error}"))?;
        validate_repo_id(&manifest.repository)?;
        validate_repo_path(&manifest.entrypoint)?;
        let expected = library
            .join("hf")
            .join(repo_directory(&manifest.repository))
            .join(relative_path(&manifest.entrypoint));
        if !same_path_identity(&target, &expected) {
            return Err("download is not in its app-owned repository location".into());
        }
        if manifest.format != 1 || !valid_revision(&manifest.revision) {
            return Err("GGUF update metadata differs from its proven source".into());
        }
        validate_files(&manifest.files)?;
        let parent = manifest
            .entrypoint
            .rsplit_once('/')
            .map(|(parent, _)| format!("{parent}/"))
            .unwrap_or_default();
        for file in &manifest.files {
            let expected_local = if file.remote.to_ascii_lowercase().ends_with(".gguf") {
                file.remote
                    .strip_prefix(&parent)
                    .ok_or("GGUF ownership leaves its model folder")?
            } else {
                file.remote
                    .rsplit('/')
                    .next()
                    .ok_or("invalid companion path")?
            };
            if expected_local != file.local || file.local.contains('/') {
                return Err("GGUF ownership has an invalid local mapping".into());
            }
        }
        if !manifest
            .files
            .iter()
            .any(|file| file.remote == manifest.entrypoint)
        {
            return Err("GGUF manifest is missing its entrypoint".into());
        }
        return Ok(Installed {
            path: path.into(),
            root,
            metadata,
            repository: manifest.repository,
            revision: Some(manifest.revision),
            selected_file: None,
            files: manifest.files,
            gguf: Some((manifest.entrypoint, manifest.companions)),
            previous_metadata,
        });
    }
    // Legacy receipts prove individual files, never coincidentally named neighbors.
    let receipt = receipt_root
        .and_then(|root| crate::benchmark::download_receipt::read(root, &target))
        .ok_or("model has no valid app download provenance")?;
    let expected = library
        .join("hf")
        .join(repo_directory(&receipt.repository))
        .join(relative_path(&receipt.artifact));
    if !same_path_identity(&target, &expected) {
        return Err("download is not in its app-owned repository location".into());
    }
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid GGUF name")?;
    let names = shard_group(name)
        .map(|names| names.collect::<Vec<_>>())
        .unwrap_or_else(|| vec![name.to_owned()]);
    let prefix = receipt
        .artifact
        .strip_suffix(name)
        .ok_or("invalid receipt artifact")?;
    let mut files = Vec::new();
    for name in names {
        let local = safe_destination(&root, &name)?;
        let origin = receipt_root
            .and_then(|root| crate::benchmark::download_receipt::read(root, &local))
            .ok_or("a legacy GGUF shard has no valid download provenance")?;
        if origin.repository != receipt.repository || origin.artifact != format!("{prefix}{name}") {
            return Err("legacy GGUF shards have different sources".into());
        }
        let size = fs::metadata(&local)
            .map_err(|error| error.to_string())?
            .len();
        files.push(TrackedFile {
            remote: origin.artifact,
            local: name,
            size,
            oid: None,
        });
    }
    validate_files(&files)?;
    Ok(Installed {
        path: path.into(),
        root,
        metadata,
        repository: receipt.repository,
        revision: None,
        selected_file: None,
        files,
        gguf: Some((receipt.artifact, false)),
        previous_metadata,
    })
}

async fn selected_files(
    installed: &Installed,
    remote: &Remote,
    cancel: &AtomicBool,
) -> Result<(Option<String>, Vec<TrackedFile>), String> {
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    let mut selected_file = None;
    let files = if let Some((entrypoint, companions)) = &installed.gguf {
        let listed = listed_gguf_files(&installed.repository, &remote.revision, &remote.entries)?;
        // An upstream rename cannot safely be inferred from another quantization.
        let plan = model_download_plan(&listed, entrypoint).map_err(|_| "the original GGUF path/shard set was removed or renamed; automatic replacement is ambiguous")?;
        let mut files = plan
            .into_iter()
            .map(|file| TrackedFile {
                local: file.path.rsplit('/').next().unwrap_or_default().into(),
                remote: file.path,
                size: file.size_bytes,
                oid: file.oid,
            })
            .collect::<Vec<_>>();
        if *companions {
            files.extend(
                snapshots::gguf_companion_plan(&remote.entries, entrypoint)?
                    .into_iter()
                    .map(|file| TrackedFile {
                        local: file.path.rsplit('/').next().unwrap_or_default().into(),
                        remote: file.remote_path.unwrap_or(file.path),
                        size: file.size,
                        oid: file.oid,
                    }),
            );
        }
        files
    } else {
        let snapshot_files = if let Some(selected) = &installed.selected_file {
            let (canonical, files) = snapshots::selected_snapshot_plan(
                &installed.repository,
                &remote.revision,
                &remote.entries,
                selected,
                cancel,
            )
            .await?;
            selected_file = Some(canonical);
            files
        } else {
            // Whole snapshots retain the original complete snapshot policy.
            snapshots::plan_snapshot(remote.entries.clone())?
        };
        snapshot_files
            .into_iter()
            .map(|file| TrackedFile {
                remote: file.remote_path.unwrap_or_else(|| file.path.clone()),
                local: file.path,
                size: file.size,
                oid: file.oid,
            })
            .collect()
    };
    validate_files(&files)?;
    if files
        .iter()
        .any(|file| !digests::valid_oid(file.oid.as_deref()))
    {
        return Err("repository files lack a supported content digest".into());
    }
    Ok((selected_file, files))
}
async fn plan_update(
    mut installed: Installed,
    remote: &Remote,
    cancel: &AtomicBool,
    mode: PlanMode,
) -> Result<Plan, String> {
    let (selected_file, files) = selected_files(&installed, remote, cancel).await?;
    installed.selected_file = selected_file;
    let shared_companions = installed
        .gguf
        .as_ref()
        .is_some_and(|(_, companions)| *companions);
    let mut adopted_companions = false;
    for file in &mut installed.files {
        let path = safe_destination(&installed.root, &file.local)?;
        let companion = if shared_companions
            && !Path::new(&file.remote)
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("gguf"))
        {
            files
                .iter()
                .find(|desired| desired.local == file.local && desired.remote == file.remote)
        } else {
            None
        };
        // Availability checks compare recorded identities without reading every
        // weight. Applying an update still verifies all old bytes before transfer.
        if matches!(mode, PlanMode::Check) && digests::valid_oid(file.oid.as_deref()) {
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file()
                || (metadata.len() != file.size
                    && companion.is_none_or(|desired| metadata.len() != desired.size))
            {
                return Err(format!(
                    "local file differs from download metadata: {}",
                    file.local
                ));
            }
            continue;
        }
        if file.oid.is_none() && installed.revision.is_none() {
            // A still-valid legacy receipt proves ownership; capture its actual
            // bytes, not the latest remote metadata, as the rollback baseline.
            file.oid = Some(hash_existing_file(&path, file.size, cancel, |_| {}).await?);
        } else {
            if let Err(error) =
                digests::verify_file_digest(&path, &file.snapshot_file(), cancel).await
            {
                if error == DOWNLOAD_CANCELLED {
                    return Err(error);
                }
                // Quantizations can share companions. Adopt only bytes that
                // already match this exact upstream update, never arbitrary edits.
                if let Some(desired) = companion.filter(|_| digests::valid_oid(file.oid.as_deref()))
                {
                    match digests::verify_file_digest(&path, &desired.snapshot_file(), cancel).await
                    {
                        Ok(()) => {
                            file.size = desired.size;
                            file.oid.clone_from(&desired.oid);
                            adopted_companions = true;
                            continue;
                        }
                        Err(error) if error == DOWNLOAD_CANCELLED => return Err(error),
                        Err(_) => {}
                    }
                }
                return Err(format!("local modification in {}: {error}", file.local));
            }
        }
    }
    let old: HashMap<_, _> = installed
        .files
        .iter()
        .enumerate()
        .map(|(index, file)| (file.local.as_str(), (index, file)))
        .collect();
    let mut changed = Vec::new();
    let mut download_bytes = 0u64;
    let mut reused_bytes = 0u64;
    for (index, file) in files.iter().enumerate() {
        let previous = old.get(file.local.as_str());
        let mut reusable = previous.is_some_and(|(_, previous)| {
            previous.remote == file.remote
                && previous.size == file.size
                && digests::identities_equal(previous.oid.as_deref(), file.oid.as_deref())
        });
        let identity_algorithm_changed = previous.is_some_and(|(_, previous)| {
            expected_sha256(previous.oid.as_deref()).is_some()
                != expected_sha256(file.oid.as_deref()).is_some()
        });
        if !reusable
            && (installed.revision.is_none() || identity_algorithm_changed)
            && previous.is_some_and(|(_, previous)| {
                previous.remote == file.remote && previous.size == file.size
            })
        {
            // Moving an unchanged file between Git and LFS must not transfer its
            // body again. Its old identity was already verified above.
            match digests::verify_file_digest(
                &safe_destination(&installed.root, &file.local)?,
                &file.snapshot_file(),
                cancel,
            )
            .await
            {
                Ok(()) => reusable = true,
                Err(error) if error == DOWNLOAD_CANCELLED => return Err(error),
                Err(_) => {}
            }
        }
        if reusable {
            reused_bytes = reused_bytes
                .checked_add(file.size)
                .ok_or("update size overflow")?;
        } else {
            let target = safe_destination(&installed.root, &file.local)?;
            if previous.is_none() && fs::symlink_metadata(&target).is_ok() {
                return Err(format!(
                    "untracked local file collides with update: {}",
                    file.local
                ));
            }
            changed.push(index);
            download_bytes = download_bytes
                .checked_add(file.size)
                .ok_or("update size overflow")?;
        }
    }
    let names: HashSet<_> = files.iter().map(|file| file.local.as_str()).collect();
    let removed = installed
        .files
        .iter()
        .enumerate()
        .filter_map(|(index, file)| (!names.contains(file.local.as_str())).then_some(index))
        .collect();
    let metadata = if let Some((entrypoint, companions)) = &installed.gguf {
        serde_json::to_vec_pretty(&GgufManifest {
            format: 1,
            repository: installed.repository.clone(),
            revision: remote.revision.clone(),
            entrypoint: entrypoint.clone(),
            companions: *companions,
            files: files.clone(),
        })
    } else {
        serde_json::to_vec_pretty(&SnapshotManifest {
            format: if installed.selected_file.is_some() {
                2
            } else {
                1
            },
            repository: installed.repository.clone(),
            revision: remote.revision.clone(),
            selected_file: installed.selected_file.clone(),
            complete: true,
            files: files.iter().map(TrackedFile::snapshot_file).collect(),
        })
    }
    .map_err(|error| error.to_string())?;
    Ok(Plan {
        installed,
        revision: remote.revision.clone(),
        files,
        changed,
        removed,
        download_bytes,
        reused_bytes,
        metadata,
        adopted_companions,
    })
}

pub async fn check_model_updates(
    paths: &[String],
    models_dir: &str,
    cancel: &AtomicBool,
) -> Result<Vec<ModelUpdateStatus>, String> {
    let receipt_root = crate::benchmark::data_root().ok();
    let mut repositories: HashMap<String, Result<Remote, String>> = HashMap::new();
    let mut statuses = Vec::with_capacity(paths.len());
    for path in paths {
        if cancel.load(Ordering::Acquire) {
            return Err(DOWNLOAD_CANCELLED.into());
        }
        let mut status = ModelUpdateStatus {
            path: path.clone(),
            supported: false,
            repository: None,
            current_revision: None,
            latest_revision: None,
            update_available: false,
            changed_files: 0,
            removed_files: 0,
            download_bytes: 0,
            reused_bytes: 0,
            error: None,
        };
        let result = async {
            let installed = load_installed(path, models_dir, receipt_root.as_deref())?;
            status.supported = true;
            status.repository = Some(installed.repository.clone());
            status.current_revision = installed.revision.clone();
            if !repositories.contains_key(&installed.repository) {
                let result = async {
                    let revision = immutable_revision(&installed.repository, cancel).await?;
                    let entries = repository_tree(&installed.repository, &revision, cancel).await?;
                    Ok(Remote { revision, entries })
                }
                .await;
                repositories.insert(installed.repository.clone(), result);
            }
            let remote = repositories
                .get(&installed.repository)
                .ok_or("repository metadata missing")?
                .as_ref()
                .map_err(Clone::clone)?;
            status.latest_revision = Some(remote.revision.clone());
            let plan = plan_update(installed, remote, cancel, PlanMode::Check).await?;
            status.changed_files = plan.changed.len();
            status.removed_files = plan.removed.len();
            status.download_bytes = plan.download_bytes;
            status.reused_bytes = plan.reused_bytes;
            status.update_available = !plan.changed.is_empty() || !plan.removed.is_empty();
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            status.error = Some(error);
        }
        statuses.push(status);
    }
    Ok(statuses)
}

/// Stamp durable update identity only after every initial-download file is
/// proven against this exact immutable revision. Size-only reuse gains no claim.
pub(super) async fn record_gguf_manifest(
    target: &Path,
    repo: &str,
    revision: &str,
    plan: &[HfFile],
    companions: Option<&[SnapshotFile]>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let entrypoint = plan.first().ok_or("empty GGUF download")?.path.clone();
    let mut files = plan
        .iter()
        .map(|file| TrackedFile {
            local: file.path.rsplit('/').next().unwrap_or_default().into(),
            remote: file.path.clone(),
            size: file.size_bytes,
            oid: file.oid.clone(),
        })
        .collect::<Vec<_>>();
    if let Some(companions) = companions {
        files.extend(companions.iter().map(|file| {
            TrackedFile {
                local: file.path.rsplit('/').next().unwrap_or_default().into(),
                remote: file
                    .remote_path
                    .clone()
                    .unwrap_or_else(|| file.path.clone()),
                size: file.size,
                oid: file.oid.clone(),
            }
        }));
    }
    validate_files(&files)?;
    let root = target.parent().ok_or("GGUF has no parent")?;
    for file in &files {
        digests::verify_file_digest(
            &safe_destination(root, &file.local)?,
            &file.snapshot_file(),
            cancel,
        )
        .await?;
    }
    let manifest = GgufManifest {
        format: 1,
        repository: repo.into(),
        revision: revision.into(),
        entrypoint,
        companions: companions.is_some(),
        files,
    };
    let metadata = gguf_metadata(target)?;
    if let Some(bytes) = bounded_metadata(&metadata)? {
        let previous: GgufManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("existing GGUF ownership metadata is invalid: {error}"))?;
        validate_files(&previous.files)?;
        let previous_files: HashMap<_, _> = previous
            .files
            .iter()
            .map(|file| (file.local.as_str(), file))
            .collect();
        let matching = manifest
            .files
            .iter()
            .filter(|file| {
                previous_files.get(file.local.as_str()).is_some_and(|old| {
                    old.remote == file.remote
                        && old.size == file.size
                        && digests::identities_equal(old.oid.as_deref(), file.oid.as_deref())
                })
            })
            .count();
        let requested_is_owned = matching == manifest.files.len();
        let adding_companions =
            !previous.companions && manifest.companions && matching == previous.files.len();
        if previous.format != 1
            || previous.repository != manifest.repository
            || previous.entrypoint != manifest.entrypoint
            || !valid_revision(&previous.revision)
            || !(requested_is_owned || adding_companions)
        {
            return Err(
                "existing GGUF ownership metadata differs; use the model update operation".into(),
            );
        }
        // A plain retry never drops companions or rewrites ready ownership.
        // Only newly verified companions can extend an existing download here.
        if requested_is_owned {
            return Ok(());
        }
    }
    crate::config::atomic_write(
        &metadata,
        &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
}

enum TransferSource {
    Hub,
    #[cfg(test)]
    Loopback(String),
}
impl TransferSource {
    fn url(&self, repo: &str, file: &str, revision: &str) -> String {
        match self {
            Self::Hub => download_url_at(repo, file, revision),
            #[cfg(test)]
            Self::Loopback(base) => format!("{}/{}", base.trim_end_matches('/'), file),
        }
    }
    fn validate(&self, response: &reqwest::Response) -> Result<(), String> {
        match self {
            Self::Hub => validate_response_url(response),
            #[cfg(test)]
            Self::Loopback(base) => {
                let base = reqwest::Url::parse(base).map_err(|error| error.to_string())?;
                if base.host_str() != Some("127.0.0.1") || response.url().origin() != base.origin()
                {
                    return Err("unsafe loopback test redirect".into());
                }
                Ok(())
            }
        }
    }
}
struct Staging {
    path: PathBuf,
    preserve: bool,
}
impl Drop for Staging {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

async fn verify_baseline(plan: &Plan, cancel: &AtomicBool) -> Result<(), String> {
    if bounded_metadata(&plan.installed.metadata)? != plan.installed.previous_metadata {
        return Err("model ownership metadata changed while updating".into());
    }
    for file in &plan.installed.files {
        digests::verify_file_digest(
            &safe_destination(&plan.installed.root, &file.local)?,
            &file.snapshot_file(),
            cancel,
        )
        .await
        .map_err(|error| {
            if error == DOWNLOAD_CANCELLED {
                error
            } else {
                format!("local modification in {}: {error}", file.local)
            }
        })?;
    }
    let old: HashSet<_> = plan
        .installed
        .files
        .iter()
        .map(|file| file.local.as_str())
        .collect();
    for file in &plan.files {
        let target = safe_destination(&plan.installed.root, &file.local)?;
        if !old.contains(file.local.as_str()) && fs::symlink_metadata(target).is_ok() {
            return Err(format!(
                "untracked local file collides with update: {}",
                file.local
            ));
        }
    }
    Ok(())
}

// Validate model loading metadata against a hard-linked view. This reads no
// network bytes and copies no unchanged weights. The view is never published.
fn validate_staged_model(plan: &Plan, stage: &Path) -> Result<(), String> {
    let view = stage.join("view");
    fs::create_dir(&view).map_err(|error| error.to_string())?;
    let changed: HashSet<_> = plan.changed.iter().copied().collect();
    for (index, file) in plan.files.iter().enumerate() {
        let source = if changed.contains(&index) {
            stage.join("data").join(index.to_string())
        } else {
            safe_destination(&plan.installed.root, &file.local)?
        };
        let destination = snapshot_path(&view, &file.local);
        fs::create_dir_all(destination.parent().ok_or("invalid validation path")?)
            .map_err(|error| error.to_string())?;
        fs::hard_link(source, destination)
            .map_err(|error| format!("cannot link model validation view: {error}"))?;
    }
    if let Some((entrypoint, companions)) = &plan.installed.gguf {
        if *companions {
            snapshots::validate_gguf_companions(
                &view.join(entrypoint.rsplit('/').next().ok_or("invalid GGUF path")?),
            )?;
        }
    } else {
        fs::write(view.join(SNAPSHOT_MANIFEST), &plan.metadata)
            .map_err(|error| error.to_string())?;
        let artifact = crate::providers::artifacts::inspect_snapshot(&view);
        if !artifact.missing.is_empty()
            || (plan.installed.selected_file.is_none()
                && artifact.format == crate::providers::artifacts::ArtifactFormat::Unknown)
        {
            return Err(format!(
                "updated snapshot loading files are invalid: {}",
                artifact.missing.join(", ")
            ));
        }
    }
    Ok(())
}

struct CommitEntry {
    target: PathBuf,
    backup: Option<PathBuf>,
    activated: bool,
    activated_stamp: Option<crate::benchmark::identity::Stamp>,
}
fn rollback(entries: &mut [CommitEntry]) -> Result<(), String> {
    let mut failures = Vec::new();
    for entry in entries.iter_mut().rev() {
        if entry.activated {
            let regular =
                fs::symlink_metadata(&entry.target).is_ok_and(|metadata| metadata.is_file());
            let current = crate::benchmark::identity::stamp(&entry.target).ok();
            if !regular || current.is_none() || current != entry.activated_stamp {
                failures.push(format!(
                    "activated file changed before rollback: {}",
                    entry.target.display()
                ));
                continue;
            }
            if let Err(error) = fs::remove_file(&entry.target) {
                failures.push(format!("cannot remove {}: {error}", entry.target.display()));
                continue;
            }
            entry.activated = false;
        }
        if let Some(backup) = &entry.backup {
            // Never overwrite an unexpected file while restoring an old one.
            if fs::symlink_metadata(&entry.target).is_ok() {
                failures.push(format!(
                    "restore destination exists: {}",
                    entry.target.display()
                ));
            } else if let Err(error) = fs::rename(backup, &entry.target) {
                failures.push(format!(
                    "cannot restore {}: {error}",
                    entry.target.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
fn commit_file(
    target: PathBuf,
    source: Option<&Path>,
    expected_exists: bool,
    backup_directory: &Path,
    entries: &mut Vec<CommitEntry>,
) -> Result<(), String> {
    let backup = match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() => {
            Some(backup_directory.join(entries.len().to_string()))
        }
        Ok(_) => return Err("update commit destination is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if backup.is_some() != expected_exists {
        return Err("model file appeared or disappeared during commit".into());
    }
    if let Some(backup) = &backup {
        fs::rename(&target, backup)
            .map_err(|error| format!("cannot back up model file: {error}"))?;
    }
    entries.push(CommitEntry {
        target: target.clone(),
        backup,
        activated: false,
        activated_stamp: None,
    });
    if let Some(source) = source {
        // Hard-link activation is exclusive: no racing user file is overwritten.
        fs::hard_link(source, &target)
            .map_err(|error| format!("cannot activate updated file: {error}"))?;
        entries
            .last_mut()
            .ok_or("missing commit journal entry")?
            .activated = true;
        entries
            .last_mut()
            .ok_or("missing commit journal entry")?
            .activated_stamp = Some(crate::benchmark::identity::stamp(&target)?);
    }
    Ok(())
}

async fn apply_plan<F: FnMut(&str, u64, u64)>(
    plan: Plan,
    cancel: &AtomicBool,
    mut progress: F,
    source: &TransferSource,
) -> Result<ModelUpdateResult, String> {
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    if plan.changed.is_empty() && plan.removed.is_empty() && !plan.adopted_companions {
        verify_baseline(&plan, cancel).await?;
        progress("complete", 0, 0);
        return Ok(ModelUpdateResult {
            path: plan.installed.path,
            revision: plan.revision,
            downloaded_bytes: 0,
            reused_bytes: plan.reused_bytes,
            updated_files: 0,
            removed_files: 0,
        });
    }
    ensure_download_parent(&plan.installed.root.join("update-staging")).await?;
    let stage_path = plan
        .installed
        .root
        .join(format!(".aiolm-update-{}", Uuid::new_v4().simple()));
    fs::create_dir(&stage_path).map_err(|error| format!("cannot stage model update: {error}"))?;
    let mut stage = Staging {
        path: stage_path,
        preserve: false,
    };
    fs::create_dir(stage.path.join("data")).map_err(|error| error.to_string())?;
    fs::create_dir(stage.path.join("backup")).map_err(|error| error.to_string())?;
    progress("starting", 0, plan.download_bytes);
    let mut completed = 0u64;
    for &index in &plan.changed {
        let file = &plan.files[index];
        let response = tokio::select! {
            _ = snapshots::wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
            response = download_client()?.get(source.url(&plan.installed.repository, &file.remote, &plan.revision)).send() => response.map_err(|error| format!("model update download failed: {error}"))?
        };
        source.validate(&response)?;
        if !response.status().is_success() {
            return Err(format!("model update HTTP status: {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length != file.size)
        {
            return Err("model update length differs from repository metadata".into());
        }
        let staged = stage.path.join("data").join(index.to_string());
        receive_download(
            response,
            &staged,
            file.size,
            file.oid.as_deref(),
            cancel,
            |phase, received, _| {
                progress(
                    phase,
                    completed.saturating_add(received),
                    plan.download_bytes,
                )
            },
        )
        .await?;
        tokio::fs::OpenOptions::new()
            .write(true)
            .open(&staged)
            .await
            .map_err(|error| error.to_string())?
            .sync_all()
            .await
            .map_err(|error| error.to_string())?;
        completed = completed
            .checked_add(file.size)
            .ok_or("update size overflow")?;
    }
    validate_staged_model(&plan, &stage.path)?;
    let staged_metadata = stage.path.join("metadata.json");
    fs::write(&staged_metadata, &plan.metadata).map_err(|error| error.to_string())?;
    fs::OpenOptions::new()
        .write(true)
        .open(&staged_metadata)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    // Recheck ALL old digests and metadata after downloading, not just changed
    // files. An external editor must not be silently incorporated into ownership.
    verify_baseline(&plan, cancel).await?;
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    let mut journal = Vec::new();
    let commit = (|| {
        for &index in &plan.removed {
            let file = &plan.installed.files[index];
            commit_file(
                safe_destination(&plan.installed.root, &file.local)?,
                None,
                true,
                &stage.path.join("backup"),
                &mut journal,
            )?;
        }
        for &index in &plan.changed {
            let file = &plan.files[index];
            let target = snapshots::checked_destination(&plan.installed.root, &file.local, true)?;
            // No asynchronous cancellation once the transactional commit starts.
            let expected_exists = plan
                .installed
                .files
                .iter()
                .any(|previous| previous.local == file.local);
            commit_file(
                target,
                Some(&stage.path.join("data").join(index.to_string())),
                expected_exists,
                &stage.path.join("backup"),
                &mut journal,
            )?;
        }
        commit_file(
            plan.installed.metadata.clone(),
            Some(&staged_metadata),
            plan.installed.previous_metadata.is_some(),
            &stage.path.join("backup"),
            &mut journal,
        )?;
        Ok::<(), String>(())
    })();
    if let Err(error) = commit {
        if let Err(rollback_error) = rollback(&mut journal) {
            stage.preserve = true;
            return Err(format!(
                "{error}; rollback failed: {rollback_error}; original backups retained at {}",
                stage.path.display()
            ));
        }
        return Err(error);
    }
    if plan.installed.gguf.is_some() && matches!(source, TransferSource::Hub) {
        for file in &plan.files {
            if file.remote.to_ascii_lowercase().ends_with(".gguf") {
                note_download(
                    &snapshot_path(&plan.installed.root, &file.local),
                    &plan.installed.repository,
                    &file.remote,
                    None,
                );
            }
        }
    }
    progress("complete", completed, plan.download_bytes);
    Ok(ModelUpdateResult {
        path: plan.installed.path,
        revision: plan.revision,
        downloaded_bytes: completed,
        reused_bytes: plan.reused_bytes,
        updated_files: plan.changed.len(),
        removed_files: plan.removed.len(),
    })
}

pub async fn update_model(
    app: AppHandle,
    path: &str,
    models_dir: &str,
    expected_revision: &str,
    cancel: &AtomicBool,
) -> Result<ModelUpdateResult, String> {
    if !valid_revision(expected_revision) {
        return Err("invalid expected model revision".into());
    }
    let receipt_root = crate::benchmark::data_root().ok();
    let installed = load_installed(path, models_dir, receipt_root.as_deref())?;
    let repository = installed.repository.clone();
    let entries = repository_tree(&repository, expected_revision, cancel).await?;
    let plan = plan_update(
        installed,
        &Remote {
            revision: expected_revision.into(),
            entries,
        },
        cancel,
        PlanMode::Apply,
    )
    .await?;
    let download_bytes = plan.download_bytes;
    let result = apply_plan(
        plan,
        cancel,
        |phase, received, total| emit_progress(&app, &repository, path, phase, received, total),
        &TransferSource::Hub,
    )
    .await;
    if result
        .as_ref()
        .is_err_and(|error| error == DOWNLOAD_CANCELLED)
    {
        emit_progress(&app, &repository, path, "cancelled", 0, download_bytes);
    }
    result
}

#[cfg(test)]
mod tests;
