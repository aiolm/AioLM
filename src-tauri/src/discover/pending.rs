//! Model downloads that stopped before finishing - paused, failed, or cut off
//! by quitting the app - so Discover can continue them with one click.
//!
//! An entry is written once a download's plan is known and removed when that
//! download completes. It holds what the download command needs to start the
//! same transfer again and where its files go. The bytes themselves stay
//! staged beside their destinations (see `resume`); how much of each file is
//! already there is measured from disk whenever the list is read, so the list
//! never claims progress that was lost.
use super::{io_error, resume};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Interrupted downloads kept; the oldest beyond this are forgotten.
const MAX_ENTRIES: usize = 32;
/// The list is a few dozen short records; anything larger is not one.
const MAX_STORE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PendingFile {
    /// Local destination of one planned file.
    pub path: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PendingDownload {
    pub id: String,
    pub repo_id: String,
    /// The GGUF file, or the selected Safetensors weight, that was requested.
    /// A whole-repository snapshot has none.
    pub file_path: Option<String>,
    /// The immutable commit used for both planning and fetching these files.
    #[serde(default)]
    pub revision: Option<String>,
    /// Whether this is a Safetensors snapshot rather than a GGUF download.
    pub snapshot: bool,
    pub models_dir: String,
    pub include_companions: bool,
    /// What the download is called on screen.
    pub label: String,
    pub total: u64,
    /// Bytes already on disk for this download, measured when listed.
    #[serde(default)]
    pub received: u64,
    /// Unix seconds when the download last started.
    pub updated_at: u64,
    pub files: Vec<PendingFile>,
}

impl PendingDownload {
    pub(super) fn new(
        (repo_id, revision): (&str, &str),
        file_path: Option<&str>,
        snapshot: bool,
        models_dir: &str,
        include_companions: bool,
        label: &str,
        files: Vec<PendingFile>,
    ) -> Self {
        let mut hash = Sha256::new();
        for part in [
            if snapshot { "snapshot" } else { "gguf" },
            repo_id,
            file_path.unwrap_or_default(),
            models_dir,
            revision,
            if include_companions { "companions" } else { "" },
        ] {
            hash.update(part.as_bytes());
            hash.update(b"\0");
        }
        Self {
            id: format!("{:x}", hash.finalize())[..16].to_owned(),
            repo_id: repo_id.to_owned(),
            file_path: file_path.map(str::to_owned),
            revision: Some(revision.to_owned()),
            snapshot,
            models_dir: models_dir.to_owned(),
            include_companions,
            label: label.to_owned(),
            total: files.iter().map(|file| file.size).sum(),
            received: 0,
            updated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs()),
            files,
        }
    }
}

fn default_store() -> Result<PathBuf, AppError> {
    crate::home::resolve_aiolm_home()
        .map(|home| home.join("pending-downloads.json"))
        .map_err(AppError::unavailable)
}

fn read_store(store: &Path) -> Vec<PendingDownload> {
    let Ok(metadata) = std::fs::metadata(store) else {
        return Vec::new();
    };
    if metadata.len() > MAX_STORE_BYTES {
        return Vec::new();
    }
    let mut entries: Vec<PendingDownload> = std::fs::read(store)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    // Older snapshot records can recover their original commit from the
    // ownership manifest written before their first transfer. Never guess main.
    for entry in &mut entries {
        if entry.revision.is_none() && entry.snapshot {
            if let Some(file) = entry.files.first() {
                if let Ok(path) = owned_destination(entry, file) {
                    let snapshot_root =
                        Path::new(&entry.models_dir)
                            .canonicalize()
                            .ok()
                            .map(|root| {
                                root.join("hf")
                                    .join(super::repo_directory(&entry.repo_id))
                                    .join("snapshots")
                            });
                    for directory in path.ancestors().skip(1).take_while(|directory| {
                        snapshot_root.as_ref().is_some_and(|root| {
                            directory.starts_with(root) && *directory != root.as_path()
                        })
                    }) {
                        let manifest_path =
                            directory.join(crate::providers::artifacts::SNAPSHOT_MANIFEST);
                        if let Ok(Some(manifest)) =
                            super::snapshots::read_snapshot_manifest(&manifest_path)
                        {
                            if manifest.repository == entry.repo_id {
                                entry.revision = Some(manifest.revision);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
    entries
}

fn write_store(store: &Path, entries: &[PendingDownload]) -> Result<(), AppError> {
    if entries.is_empty() {
        return match std::fs::remove_file(store) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(
                &error,
                format!("cannot update interrupted downloads: {error}"),
            )),
        };
    }
    let bytes = serde_json::to_vec_pretty(entries)
        .map_err(|error| AppError::internal(error.to_string()))?;
    crate::config::atomic_write(store, &bytes)
}

/// Bytes of `file` already on disk: the whole file once it is in place,
/// otherwise what is staged for it.
fn bytes_on_disk(file: &PendingFile) -> u64 {
    let path = Path::new(&file.path);
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return file.size;
    }
    resume::staged_parts(path)
        .iter()
        .filter_map(|part| std::fs::metadata(part).ok())
        .map(|metadata| metadata.len().min(file.size))
        .max()
        .unwrap_or(0)
}

fn list_in(store: &Path) -> Vec<PendingDownload> {
    let mut entries = read_store(store);
    for entry in &mut entries {
        entry.received = entry.files.iter().map(bytes_on_disk).sum();
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    entries
}

fn remember_in(store: &Path, entry: PendingDownload) -> Result<(), AppError> {
    let mut entries = read_store(store);
    entries.retain(|existing| {
        existing.id != entry.id
            && !(existing.repo_id == entry.repo_id
                && existing.file_path == entry.file_path
                && existing.snapshot == entry.snapshot
                && existing.models_dir == entry.models_dir
                && existing.include_companions == entry.include_companions
                && existing.revision == entry.revision)
    });
    entries.insert(0, entry);
    entries.truncate(MAX_ENTRIES);
    write_store(store, &entries)
}

fn forget_in(store: &Path, id: &str) -> Result<(), AppError> {
    let mut entries = read_store(store);
    let before = entries.len();
    entries.retain(|entry| entry.id != id);
    if entries.len() == before {
        return Ok(());
    }
    write_store(store, &entries)
}

fn owned_destination(entry: &PendingDownload, file: &PendingFile) -> Result<PathBuf, AppError> {
    super::validate_repo_id(&entry.repo_id)?;
    let root = Path::new(&entry.models_dir)
        .canonicalize()
        .map_err(|error| AppError::from_io(&error))?;
    let path = Path::new(&file.path);
    let repository = root.join("hf").join(super::repo_directory(&entry.repo_id));
    path.strip_prefix(&repository)
        .map_err(|_| AppError::validation("pending download escapes its repository"))?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| AppError::validation("pending download escapes its library"))?
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or_else(|| AppError::validation("invalid pending download path"))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    super::snapshots::checked_destination(&root, &relative, false)
}

fn discard_in(store: &Path, id: &str) -> Result<(), AppError> {
    if let Some(entry) = read_store(store).into_iter().find(|entry| entry.id == id) {
        // Validate the whole plan before deleting anything, without following
        // linked parents or trusting paths outside this repository's library.
        let destinations = entry
            .files
            .iter()
            .map(|file| owned_destination(&entry, file))
            .collect::<Result<Vec<_>, _>>()?;
        for path in destinations {
            for part in resume::staged_parts(&path) {
                std::fs::remove_file(&part).map_err(|error| {
                    io_error(&error, format!("cannot remove a staged download: {error}"))
                })?;
            }
        }
    }
    forget_in(store, id)
}

/// Interrupted downloads, most recent first, with what is already on disk.
pub fn list() -> Vec<PendingDownload> {
    default_store()
        .map(|store| list_in(&store))
        .unwrap_or_default()
}

/// Record a download that is starting, replacing an earlier entry for it. A
/// list that cannot be written only costs the one-click resume.
pub(super) fn remember(entry: PendingDownload) {
    if let Ok(store) = default_store() {
        let _ = remember_in(&store, entry);
    }
}

/// Drop the entry of a download that completed.
pub(super) fn forget(id: &str) {
    if let Ok(store) = default_store() {
        let _ = forget_in(&store, id);
    }
}

/// Remove an interrupted download's staged bytes and its entry. Files that
/// already finished stay where they are, like any other downloaded model.
pub fn discard(id: &str) -> Result<(), AppError> {
    discard_in(&default_store()?, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn legacy_snapshot_recovers_its_commit_without_guessing_missing_gguf_revisions() {
        let root =
            std::env::temp_dir().join(format!("aiolm-legacy-pending-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = root.join("pending-downloads.json");
        let original = "a".repeat(40);
        let directory = root.join("hf/owner/model/snapshots").join(&original);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join(crate::providers::artifacts::SNAPSHOT_MANIFEST),
            serde_json::to_vec(&serde_json::json!({
                "format": 1, "repository": "owner/model", "revision": original,
                "complete": false, "files": [{"path": "model.safetensors", "size": 8}]
            }))
            .unwrap(),
        )
        .unwrap();
        let entry = PendingDownload::new(
            ("owner/model", &original),
            None,
            true,
            root.to_str().unwrap(),
            false,
            "model",
            vec![PendingFile {
                path: directory
                    .join("model.safetensors")
                    .to_string_lossy()
                    .into_owned(),
                size: 8,
            }],
        );
        let mut legacy = serde_json::to_value(&entry).unwrap();
        legacy.as_object_mut().unwrap().remove("revision");
        std::fs::write(&store, serde_json::to_vec(&vec![legacy]).unwrap()).unwrap();
        let recovered = list_in(&store);
        assert_eq!(recovered[0].revision.as_deref(), Some(original.as_str()));
        let latest = "b".repeat(40);
        assert_eq!(
            super::super::download_revision(
                recovered[0].revision.as_deref(),
                std::future::ready(Ok(latest.clone()))
            )
            .await
            .unwrap(),
            original
        );
        assert!(
            super::super::download_revision(Some(""), std::future::ready(Ok(latest)))
                .await
                .unwrap_err()
                .message
                .contains("staged bytes were retained")
        );
        assert_eq!(list_in(&store).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discard_rejects_destinations_outside_the_recorded_repository() {
        let root =
            std::env::temp_dir().join(format!("aiolm-pending-boundary-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = root.join("pending-downloads.json");
        let user_file = root.join("personal.json");
        let user_part = resume::part_path(&user_file, 8, None).unwrap();
        std::fs::write(&user_part, b"user").unwrap();
        let entry = PendingDownload::new(
            ("owner/model", &"a".repeat(40)),
            Some("model.gguf"),
            false,
            root.to_str().unwrap(),
            true,
            "model",
            vec![PendingFile {
                path: user_file.to_string_lossy().into_owned(),
                size: 8,
            }],
        );
        remember_in(&store, entry.clone()).unwrap();
        assert!(discard_in(&store, &entry.id)
            .unwrap_err()
            .message
            .contains("escapes its repository"));
        assert_eq!(std::fs::read(user_part).unwrap(), b"user");
        assert_eq!(list_in(&store).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discard_cleans_flattened_companion_parts_but_preserves_completed_and_user_files() {
        let root =
            std::env::temp_dir().join(format!("aiolm-companion-pending-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = root.join("pending-downloads.json");
        let directory = root.join("hf/owner/model/Q4");
        std::fs::create_dir_all(&directory).unwrap();
        let entries = ["model.gguf", "config.json", "tokenizer.json"]
            .iter()
            .map(|path| {
                serde_json::from_value(serde_json::json!({
                    "path": path, "size": 8, "type": "file"
                }))
                .unwrap()
            })
            .collect::<Vec<super::super::ApiTreeEntry>>();
        // Root assets are flattened into the quantization's folder.
        let companions =
            super::super::snapshots::gguf_companion_plan(&entries, "Q4/model.gguf").unwrap();
        let mut files =
            super::super::snapshots::pending_gguf_companions(&directory, &companions).unwrap();
        files.push(PendingFile {
            path: directory.join("model.gguf").to_string_lossy().into_owned(),
            size: 8,
        });
        let entry = PendingDownload::new(
            ("owner/model", &"a".repeat(40)),
            Some("Q4/model.gguf"),
            false,
            root.to_str().unwrap(),
            true,
            "model.gguf",
            files,
        );
        let model_part = resume::part_path(&directory.join("model.gguf"), 8, None).unwrap();
        let tokenizer_part = resume::part_path(&directory.join("tokenizer.json"), 8, None).unwrap();
        std::fs::write(&model_part, b"weights").unwrap();
        std::fs::write(&tokenizer_part, b"token").unwrap();
        std::fs::write(directory.join("config.json"), b"complete").unwrap();
        std::fs::write(directory.join("tokenizer.json.notes"), b"user notes").unwrap();
        let unrelated = directory.join(".other.json.0123456789abcdef.part");
        std::fs::write(&unrelated, b"user transfer").unwrap();
        remember_in(&store, entry.clone()).unwrap();
        assert_eq!(list_in(&store)[0].received, 20);
        discard_in(&store, &entry.id).unwrap();
        assert!(!model_part.exists());
        assert!(!tokenizer_part.exists());
        assert_eq!(
            std::fs::read(directory.join("config.json")).unwrap(),
            b"complete"
        );
        assert_eq!(
            std::fs::read(directory.join("tokenizer.json.notes")).unwrap(),
            b"user notes"
        );
        assert_eq!(std::fs::read(unrelated).unwrap(), b"user transfer");
        assert!(list_in(&store).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn newer_download_does_not_replace_the_original_recovery_plan_or_received_bytes() {
        let root =
            std::env::temp_dir().join(format!("aiolm-pinned-pending-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = root.join("pending-downloads.json");
        let original = "a".repeat(40);
        let latest = "b".repeat(40);
        let target = root
            .join("hf/owner/model/snapshots")
            .join(&original)
            .join("model.safetensors");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let part = resume::part_path(&target, 8, Some(&"c".repeat(64))).unwrap();
        std::fs::write(&part, b"received").unwrap();
        let first = PendingDownload::new(
            ("owner/model", &original),
            None,
            true,
            root.to_str().unwrap(),
            false,
            "model",
            vec![PendingFile {
                path: target.to_string_lossy().into_owned(),
                size: 8,
            }],
        );
        remember_in(&store, first.clone()).unwrap();
        let newer_target = root
            .join("hf/owner/model/snapshots")
            .join(&latest)
            .join("model.safetensors");
        let newer = PendingDownload::new(
            ("owner/model", &latest),
            None,
            true,
            root.to_str().unwrap(),
            false,
            "model",
            vec![PendingFile {
                path: newer_target.to_string_lossy().into_owned(),
                size: 8,
            }],
        );
        remember_in(&store, newer).unwrap();
        let listed = list_in(&store);
        assert_eq!(listed.len(), 2);
        let resumed = listed.iter().find(|entry| entry.id == first.id).unwrap();
        assert_eq!(resumed.received, 8);
        assert_eq!(resumed.revision.as_deref(), Some(original.as_str()));
        assert_eq!(std::fs::read(&part).unwrap(), b"received");
        discard_in(&store, &first.id).unwrap();
        assert!(!part.exists());
        assert_eq!(list_in(&store).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_downloads_report_bytes_on_disk_and_are_forgotten_or_discarded() {
        let root = std::env::temp_dir().join(format!("aiolm-pending-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = root.join("pending-downloads.json");
        let directory = root.join("hf/owner/model");
        std::fs::create_dir_all(&directory).unwrap();
        let done = directory.join("model-00001-of-00002.gguf");
        let staged = directory.join("model-00002-of-00002.gguf");
        std::fs::write(&done, b"1234").unwrap();
        let part = resume::part_path(&staged, 4, Some(&"a".repeat(64))).unwrap();
        std::fs::write(&part, b"12").unwrap();
        let entry = PendingDownload::new(
            ("owner/model", &"a".repeat(40)),
            Some("model-00001-of-00002.gguf"),
            false,
            root.to_str().unwrap(),
            false,
            "model.gguf",
            vec![
                PendingFile {
                    path: done.to_string_lossy().into_owned(),
                    size: 4,
                },
                PendingFile {
                    path: staged.to_string_lossy().into_owned(),
                    size: 4,
                },
            ],
        );
        let id = entry.id.clone();
        remember_in(&store, entry.clone()).unwrap();
        // Starting the same download again replaces its entry.
        remember_in(&store, entry).unwrap();
        let listed = list_in(&store);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].received, listed[0].total), (6, 8));

        forget_in(&store, &id).unwrap();
        assert!(list_in(&store).is_empty());
        assert!(
            part.exists(),
            "forgetting a finished download touches no files"
        );

        remember_in(&store, listed[0].clone()).unwrap();
        discard_in(&store, &id).unwrap();
        assert!(list_in(&store).is_empty());
        assert!(!part.exists());
        assert!(done.exists(), "finished files stay");
        std::fs::remove_dir_all(root).unwrap();
    }
}
