//! User-selected history deletion. A durable tombstone is committed before the
//! journal is removed. Upload receipts, recent-cache markers and sharing
//! ownership records are never touched.
use super::{files, sync_parent, RunLock, StoreLock, ACTIVE_RUNS};
use crate::error::AppError;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

fn digest(run_id: &str) -> String {
    format!("{:x}", Sha256::digest(run_id.as_bytes()))
}

// Only the id digest reaches the filesystem, so no run id can escape the store.
fn tombstone_path(root: &Path, run_id: &str) -> PathBuf {
    root.join("deletions")
        .join(format!("{}.deleted", digest(run_id)))
}

pub(super) fn has_tombstone(root: &Path, run_id: &str) -> Result<bool, AppError> {
    match fs::symlink_metadata(tombstone_path(root, run_id)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::io(
            "cannot check a deleted benchmark record",
            &error,
        )),
    }
}

/// Digests of deleted runs, used to hide a journal whose removal was
/// interrupted after its tombstone became durable.
pub(super) fn deleted_digests(root: &Path) -> Result<HashSet<String>, AppError> {
    let entries = match fs::read_dir(root.join("deletions")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => {
            return Err(AppError::io(
                "cannot read deleted benchmark records",
                &error,
            ))
        }
    };
    let mut digests = HashSet::new();
    for entry in entries {
        let path = entry.map_err(|error| AppError::from_io(&error))?.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "deleted")
        {
            if let Some(stem) = path.file_stem().and_then(|name| name.to_str()) {
                digests.insert(stem.to_owned());
            }
        }
    }
    Ok(digests)
}

fn write_tombstone(root: &Path, run_id: &str) -> Result<(), AppError> {
    let path = tombstone_path(root, run_id);
    crate::config::atomic_write(
        &path,
        &serde_json::to_vec(&json!({ "schema_version": 1, "run_id": run_id }))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| {
        AppError::new(
            error.kind,
            format!("cannot save the benchmark deletion: {error}"),
        )
    })?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .and_then(|file| file.sync_all())
        .map_err(|error| AppError::io("cannot durably save the benchmark deletion", &error))?;
    sync_parent(&path)?;
    sync_parent(path.parent().ok_or("benchmark deletion has no directory")?)
}

/// Delete one local history record. Repeating the deletion, or deleting a run
/// with no local journal, succeeds and reserves the run id.
pub(crate) fn delete(root: &Path, run_id: &str) -> Result<(), AppError> {
    if run_id.is_empty() || run_id.len() > 128 {
        return Err(AppError::validation("invalid benchmark run id"));
    }
    let _lock = StoreLock::acquire(root)?;
    let suffix = format!("-{}.jsonl", digest(run_id));
    let journals: Vec<_> = files(root)?
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&suffix))
        })
        .collect();
    {
        let active = ACTIVE_RUNS
            .lock()
            .map_err(|_| "active benchmark store lock was poisoned")?;
        if journals.iter().any(|path| active.contains(path)) {
            return Err(AppError::busy(
                "wait for the benchmark to finish before deleting it",
            ));
        }
    }
    // The store lock keeps a new run from starting; the run lock proves no
    // other application instance is still measuring or acknowledging it.
    let _run_lock = RunLock::acquire(root, run_id)?.ok_or_else(|| {
        AppError::busy(
            "wait for the benchmark in the other application instance to finish before deleting it",
        )
    })?;
    for path in &journals {
        super::require_supported_journal(path)?;
    }
    if !has_tombstone(root, run_id)? {
        write_tombstone(root, run_id)?;
    }
    for path in journals {
        match fs::remove_file(&path) {
            Ok(()) => sync_parent(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AppError::io(
                    "the benchmark was removed from history, but its local file could not be deleted; retry to finish",
                    &error,
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests as fixtures;
    use super::super::{acknowledge, list, RunJournal, UploadReceipt};
    use super::*;

    fn ids(root: &Path) -> Vec<String> {
        list(root, 0, 100)
            .unwrap()
            .records
            .iter()
            .map(|record| record["id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn native(root: &Path, id: &str, created: u64) -> PathBuf {
        let initial = fixtures::serving_record(id, created);
        let journal = RunJournal::begin(root, initial).unwrap();
        let mut result = fixtures::serving_result(id);
        result.rows.push(fixtures::serving_row());
        journal.checkpoint(&result).unwrap();
        result.status = "complete";
        result.message = None;
        journal.finish(&result).unwrap();
        journal.path.clone()
    }

    fn receipt() -> UploadReceipt {
        UploadReceipt {
            submission_id: "00000000-0000-4000-8000-000000000001".into(),
            id: "accepted-1".into(),
            url: Some("https://benchmarks.example.test/runs/accepted-1".into()),
            destination: "https://benchmarks.example.test/v1/benchmark-runs".into(),
        }
    }

    fn receipt_file(root: &Path, id: &str) -> PathBuf {
        root.join("receipts").join(format!("{}.json", digest(id)))
    }

    #[test]
    fn deleting_one_record_keeps_others_and_reserves_its_run_id() {
        let root = fixtures::root();
        for (index, id) in ["first", "selected", "third"].iter().enumerate() {
            native(&root, id, index as u64);
        }
        let kept = files(&root).unwrap();
        let untouched: Vec<_> = kept
            .iter()
            .filter(|path| !path.to_string_lossy().contains(&digest("selected")))
            .map(|path| (path.clone(), fs::read(path).unwrap()))
            .collect();
        delete(&root, "selected").unwrap();
        assert_eq!(ids(&root), vec!["third", "first"]);
        for (path, bytes) in &untouched {
            assert_eq!(&fs::read(path).unwrap(), bytes);
        }
        assert_eq!(list(&root, 0, 100).unwrap().total, 2);
        assert!(RunJournal::begin(&root, fixtures::serving_record("selected", 9)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_runs_cannot_be_deleted_in_this_or_another_instance() {
        let root = fixtures::root();
        let journal = RunJournal::begin(&root, fixtures::serving_record("running", 1)).unwrap();
        assert_eq!(
            delete(&root, "running").unwrap_err().kind,
            crate::error::ErrorKind::Busy
        );
        assert!(journal.path.is_file());
        assert!(!has_tombstone(&root, "running").unwrap());
        let path = journal.path.clone();
        drop(journal);
        // A second handle on the OS run lock stands in for another instance.
        let other = RunLock::acquire(&root, "running").unwrap().unwrap();
        assert_eq!(
            delete(&root, "running").unwrap_err().kind,
            crate::error::ErrorKind::Busy
        );
        assert!(path.is_file());
        assert!(!has_tombstone(&root, "running").unwrap());
        drop(other);
        delete(&root, "running").unwrap();
        assert!(!path.exists());
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repeated_and_missing_deletions_are_idempotent() {
        let root = fixtures::root();
        native(&root, "twice", 1);
        delete(&root, "twice").unwrap();
        let tombstone = fs::read(tombstone_path(&root, "twice")).unwrap();
        delete(&root, "twice").unwrap();
        assert_eq!(fs::read(tombstone_path(&root, "twice")).unwrap(), tombstone);
        delete(&root, "never-created").unwrap();
        assert!(RunJournal::begin(&root, fixtures::serving_record("never-created", 2)).is_err());
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        assert_eq!(
            delete(&root, "").unwrap_err(),
            AppError::validation("invalid benchmark run id")
        );
        assert_eq!(
            delete(&root, &"x".repeat(129)).unwrap_err().kind,
            crate::error::ErrorKind::Validation
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn traversal_ids_only_touch_their_own_digest() {
        let root = fixtures::root();
        let outside = root.join("outside.jsonl");
        fs::write(&outside, b"synthetic").unwrap();
        native(&root, "../outside", 1);
        native(&root, "neighbour", 2);
        delete(&root, "../outside").unwrap();
        delete(&root, "..\\..\\runs").unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"synthetic");
        assert_eq!(ids(&root), vec!["neighbour"]);
        for entry in fs::read_dir(root.join("deletions")).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            assert!(name.len() == 72 && name.ends_with(".deleted"), "{name}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_journal_removal_stays_hidden_and_retry_finishes_it() {
        let root = fixtures::root();
        native(&root, "interrupted", 1);
        let journal = files(&root).unwrap().remove(0);
        write_tombstone(&root, "interrupted").unwrap();
        assert!(journal.is_file());
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        delete(&root, "interrupted").unwrap();
        assert!(!journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_preserves_receipts_cache_markers_and_sharing_ownership() {
        let root = fixtures::root();
        native(&root, "uploaded", 1);
        acknowledge(&root, "uploaded", receipt()).unwrap();
        let owner = root.join("sharing").join("owners").join("synthetic.json");
        fs::create_dir_all(owner.parent().unwrap()).unwrap();
        fs::write(&owner, b"synthetic ownership").unwrap();
        let receipt_bytes = fs::read(receipt_file(&root, "uploaded")).unwrap();
        let marker = root
            .join("recent-cache")
            .join(format!("{}.json", digest("uploaded")));
        assert!(marker.is_file());
        delete(&root, "uploaded").unwrap();
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        assert_eq!(
            fs::read(receipt_file(&root, "uploaded")).unwrap(),
            receipt_bytes
        );
        assert!(marker.is_file());
        assert_eq!(fs::read(&owner).unwrap(), b"synthetic ownership");
        // A retried acknowledgement stays successful without the local copy.
        assert!(
            acknowledge(&root, "uploaded", receipt())
                .unwrap()
                .acknowledged
        );
        assert_eq!(
            fs::read(receipt_file(&root, "uploaded")).unwrap(),
            receipt_bytes
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upload_accepted_after_local_deletion_still_records_its_receipt() {
        let root = fixtures::root();
        native(&root, "in-flight", 1);
        delete(&root, "in-flight").unwrap();
        assert!(
            acknowledge(&root, "in-flight", receipt())
                .unwrap()
                .acknowledged
        );
        assert!(receipt_file(&root, "in-flight").is_file());
        assert!(!root
            .join("recent-cache")
            .join(format!("{}.json", digest("in-flight")))
            .exists());
        assert!(acknowledge(&root, "never-seen", receipt()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsupported_journal_deletion_fails_without_tombstone_or_disk_changes() {
        let root = fixtures::root();
        for version in [1, 2] {
            let id = format!("unsupported-delete-{version}");
            let mut record = fixtures::serving_record(&id, version);
            record["schemaVersion"] = json!(version);
            let path = root.join("runs").join(format!("{version:016}-{}.jsonl", digest(&id)));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut bytes = serde_json::to_vec(&json!({
                "kind":"start","origin":"legacy","record":record
            })).unwrap();
            bytes.extend_from_slice(b"\nunsupported tail\n");
            fs::write(&path, &bytes).unwrap();
            assert_eq!(delete(&root, &id).unwrap_err(),
                AppError::validation("unsupported benchmark record"));
            assert!(!has_tombstone(&root, &id).unwrap());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        let page = list(&root, 0, 20).unwrap();
        assert_eq!(page.total, 0);
        assert!(page.records.is_empty());
        assert!(page.warnings.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
