//! User-selected history deletion. A durable tombstone is committed before the
//! journal is removed, so legacy localStorage originals kept for migration
//! recovery can never re-import a deleted run. Upload receipts, recent-cache
//! markers and sharing ownership records are never touched.
use super::{files, sync_parent, RunLock, StoreLock, ACTIVE_RUNS};
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

pub(super) fn has_tombstone(root: &Path, run_id: &str) -> Result<bool, String> {
    match fs::symlink_metadata(tombstone_path(root, run_id)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("cannot check a deleted benchmark record: {error}")),
    }
}

/// Digests of deleted runs, used to hide a journal whose removal was
/// interrupted after its tombstone became durable.
pub(super) fn deleted_digests(root: &Path) -> Result<HashSet<String>, String> {
    let entries = match fs::read_dir(root.join("deletions")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => return Err(format!("cannot read deleted benchmark records: {error}")),
    };
    let mut digests = HashSet::new();
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
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

fn write_tombstone(root: &Path, run_id: &str) -> Result<(), String> {
    let path = tombstone_path(root, run_id);
    crate::config::atomic_write(
        &path,
        &serde_json::to_vec(&json!({ "schema_version": 1, "run_id": run_id }))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("cannot save the benchmark deletion: {error}"))?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("cannot durably save the benchmark deletion: {error}"))?;
    sync_parent(&path)?;
    sync_parent(path.parent().ok_or("benchmark deletion has no directory")?)
}

/// Delete one local history record. Repeating the deletion, or deleting a run
/// with no local journal, succeeds and still suppresses a later re-import.
pub(crate) fn delete(root: &Path, run_id: &str) -> Result<(), String> {
    if run_id.is_empty() || run_id.len() > 128 {
        return Err("invalid benchmark run id".into());
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
            return Err("wait for the benchmark to finish before deleting it".into());
        }
    }
    // The store lock keeps a new run from starting; the run lock proves no
    // other application instance is still measuring or acknowledging it.
    let _run_lock = RunLock::acquire(root, run_id)?.ok_or(
        "wait for the benchmark in the other application instance to finish before deleting it",
    )?;
    if !has_tombstone(root, run_id)? {
        write_tombstone(root, run_id)?;
    }
    for path in journals {
        match fs::remove_file(&path) {
            Ok(()) => sync_parent(&path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "the benchmark was removed from history, but its local file could not be deleted; retry to finish: {error}"
                ))
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests as fixtures;
    use super::super::{acknowledge, import, list, RunJournal, UploadReceipt};
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
        let initial = fixtures::record(id, created);
        let request = serde_json::from_value(initial["request"].clone()).unwrap();
        let journal = RunJournal::begin(root, initial).unwrap();
        let mut result = crate::performance_bench::failed(
            &request,
            &crate::config::AppConfig::default(),
            "pending".into(),
        );
        result.rows.push(fixtures::row());
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
    fn deleting_one_record_keeps_others_and_legacy_reimport_cannot_resurrect_it() {
        let root = fixtures::root();
        let legacy: Vec<_> = ["first", "selected", "third"]
            .iter()
            .enumerate()
            .map(|(index, id)| fixtures::record(id, index as u64))
            .collect();
        assert_eq!(import(&root, legacy.clone()).unwrap(), 3);
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
        // Startup migration re-reads the retained localStorage originals.
        assert_eq!(import(&root, legacy).unwrap(), 0);
        assert_eq!(list(&root, 0, 100).unwrap().total, 2);
        assert!(RunJournal::begin(&root, fixtures::record("selected", 9)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_runs_cannot_be_deleted_in_this_or_another_instance() {
        let root = fixtures::root();
        let journal = RunJournal::begin(&root, fixtures::record("running", 1)).unwrap();
        assert!(delete(&root, "running").is_err());
        assert!(journal.path.is_file());
        assert!(!has_tombstone(&root, "running").unwrap());
        let path = journal.path.clone();
        drop(journal);
        // A second handle on the OS run lock stands in for another instance.
        let other = RunLock::acquire(&root, "running").unwrap().unwrap();
        assert!(delete(&root, "running").is_err());
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
        import(&root, vec![fixtures::record("twice", 1)]).unwrap();
        delete(&root, "twice").unwrap();
        let tombstone = fs::read(tombstone_path(&root, "twice")).unwrap();
        delete(&root, "twice").unwrap();
        assert_eq!(fs::read(tombstone_path(&root, "twice")).unwrap(), tombstone);
        // A record still only in localStorage is suppressed before migration.
        delete(&root, "never-imported").unwrap();
        assert_eq!(
            import(&root, vec![fixtures::record("never-imported", 2)]).unwrap(),
            0
        );
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        assert!(delete(&root, "").is_err());
        assert!(delete(&root, &"x".repeat(129)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn traversal_ids_only_touch_their_own_digest() {
        let root = fixtures::root();
        let outside = root.join("outside.jsonl");
        fs::write(&outside, b"synthetic").unwrap();
        import(&root, vec![fixtures::record("../outside", 1)]).unwrap();
        import(&root, vec![fixtures::record("neighbour", 2)]).unwrap();
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
        import(&root, vec![fixtures::record("interrupted", 1)]).unwrap();
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
}
