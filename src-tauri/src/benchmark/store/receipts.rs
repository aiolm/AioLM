//! Server acceptance is durable independently of the disposable recent cache.
//! Candidate markers bound normal pruning to the recent cache, while permanent
//! receipts prevent legacy imports from resurrecting an evicted local journal.
use super::{
    files, replay_run, sync_parent, JournalOrigin, RunLock, StoreLock, ACTIVE_RUNS,
    MAX_JOURNAL_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const RECENT_CACHE_LIMIT: usize = 100;
const MAX_RECEIPT_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct UploadReceipt {
    pub submission_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub destination: String,
}

impl UploadReceipt {
    fn validate(&self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.submission_id).is_err()
            || self.id.is_empty()
            || self.id.len() > 200
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err("upload receipt does not identify a valid submission".into());
        }
        let destination = service_url(&self.destination)?;
        if destination.query().is_some() || destination.fragment().is_some() {
            return Err("upload destination cannot contain a query or fragment".into());
        }
        if let Some(value) = &self.url {
            let url = service_url(value)?;
            if url.origin() != destination.origin() {
                return Err("upload receipt URL belongs to a different service".into());
            }
        }
        Ok(())
    }
}

fn service_url(value: &str) -> Result<reqwest::Url, String> {
    if value.len() > 2048 {
        return Err("upload receipt URL exceeds the size limit".into());
    }
    let url = reqwest::Url::parse(value)
        .map_err(|_| "upload receipt requires an absolute service URL")?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("upload receipt requires HTTPS without embedded credentials".into());
    }
    Ok(url)
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CacheCandidate {
    journal_file: String,
    journal_bytes: u64,
    journal_sha256: String,
    created_at: u64,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AcceptedUpload {
    schema_version: u32,
    run_id: String,
    receipt: UploadReceipt,
    acknowledged_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    candidate: Option<CacheCandidate>,
}

#[derive(Serialize)]
pub(crate) struct Acknowledgement {
    pub acknowledged: bool,
    pub pruned: usize,
    pub warnings: Vec<String>,
}

fn receipt_name(run_id: &str) -> String {
    format!("{:x}.json", Sha256::digest(run_id.as_bytes()))
}
fn receipt_path(root: &Path, run_id: &str) -> PathBuf {
    root.join("receipts").join(receipt_name(run_id))
}
fn candidate_path(root: &Path, run_id: &str) -> PathBuf {
    root.join("recent-cache").join(receipt_name(run_id))
}

pub(super) fn has_tombstone(root: &Path, run_id: &str) -> Result<bool, String> {
    match fs::symlink_metadata(receipt_path(root, run_id)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "cannot check an accepted benchmark receipt: {error}"
        )),
    }
}

fn read_accepted(path: &Path) -> Result<Option<AcceptedUpload>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "cannot read an accepted benchmark receipt: {error}"
            ))
        }
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err("accepted benchmark receipt exceeds the size limit".into());
    }
    let accepted: AcceptedUpload = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid accepted benchmark receipt: {error}"))?;
    accepted.receipt.validate()?;
    if accepted.schema_version != 1
        || accepted.run_id.is_empty()
        || accepted.run_id.len() > 128
        || accepted.acknowledged_at > 8_640_000_000_000_000
        || path.file_name().and_then(|name| name.to_str()) != Some(&receipt_name(&accepted.run_id))
    {
        return Err("accepted benchmark receipt identity does not match its file".into());
    }
    if let Some(candidate) = &accepted.candidate {
        let suffix = format!("{:x}.jsonl", Sha256::digest(accepted.run_id.as_bytes()));
        if candidate.journal_file != format!("{:016}-{suffix}", candidate.created_at)
            || candidate.journal_bytes > MAX_JOURNAL_BYTES
            || candidate.journal_sha256.len() != 64
            || !candidate
                .journal_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("accepted benchmark cache metadata is invalid".into());
        }
    }
    Ok(Some(accepted))
}

pub(super) fn attach_state(root: &Path, record: &mut Value) -> Result<(), String> {
    let id = record["id"]
        .as_str()
        .ok_or("benchmark record is missing its id")?
        .to_owned();
    let object = record
        .as_object_mut()
        .ok_or("benchmark record must be an object")?;
    object.insert("localState".into(), json!("recovery"));
    object.remove("remoteReceipt");
    object.remove("acknowledgedAt");
    if let Some(accepted) = read_accepted(&receipt_path(root, &id))? {
        object.insert("localState".into(), json!("cached"));
        object.insert("remoteReceipt".into(), json!(accepted.receipt));
        object.insert("acknowledgedAt".into(), json!(accepted.acknowledged_at));
    }
    Ok(())
}

fn journal_fingerprint(path: &Path) -> Result<(u64, String), String> {
    if !fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_file()
    {
        return Err("benchmark cache journal must remain a regular file".into());
    }
    let mut reader = File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_JOURNAL_BYTES + 1);
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_JOURNAL_BYTES {
            return Err("benchmark journal exceeds the size limit".into());
        }
        hash.update(&buffer[..count]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

fn ensure_durable_receipt(path: &Path) -> Result<(), String> {
    // A previous rename may have become visible even though directory syncing
    // failed. Revalidate durability without rewriting immutable receipt bytes.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("cannot durably save accepted benchmark receipt: {error}"))?;
    // Persist directory entries through the existing filesystem root, including
    // a newly created application data directory on the first acknowledgement.
    let mut entry = path;
    while let Some(parent) = entry.parent() {
        if parent.as_os_str().is_empty() {
            break;
        }
        sync_parent(entry)?;
        entry = parent;
    }
    Ok(())
}

fn durable_receipt(
    path: &Path,
    accepted: &AcceptedUpload,
    ensure_durable: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    crate::config::atomic_write(
        path,
        &serde_json::to_vec(accepted).map_err(|error| error.to_string())?,
    )?;
    ensure_durable(path)
}

pub(crate) fn acknowledge(
    root: &Path,
    run_id: &str,
    receipt: UploadReceipt,
) -> Result<Acknowledgement, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    acknowledge_at(root, run_id, receipt, now)
}

fn acknowledge_at(
    root: &Path,
    run_id: &str,
    receipt: UploadReceipt,
    now: u64,
) -> Result<Acknowledgement, String> {
    acknowledge_at_with_durability(root, run_id, receipt, now, &ensure_durable_receipt)
}

fn acknowledge_at_with_durability(
    root: &Path,
    run_id: &str,
    receipt: UploadReceipt,
    now: u64,
    ensure_durable: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<Acknowledgement, String> {
    receipt.validate()?;
    if run_id.is_empty() || run_id.len() > 128 {
        return Err("invalid benchmark run id".into());
    }
    let _lock = StoreLock::acquire(root)?;
    let accepted_path = receipt_path(root, run_id);
    if let Some(existing) = read_accepted(&accepted_path)? {
        if existing.receipt != receipt {
            return Err("this benchmark already has a different accepted upload receipt".into());
        }
        // Existing mappings and acceptance timestamps are immutable. Retrying
        // a successful acknowledgement needs no receipt rewrite or network call.
        ensure_durable(&accepted_path)?;
        return Ok(prune_cache_with_durability(
            root,
            RECENT_CACHE_LIMIT,
            |path| fs::remove_file(path),
            ensure_durable,
        ));
    }
    let digest = format!("{:x}.jsonl", Sha256::digest(run_id.as_bytes()));
    let path = files(root)?
        .into_iter()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&digest))
        })
        .ok_or("the local benchmark recovery record was not found")?;
    if ACTIVE_RUNS
        .lock()
        .map_err(|_| "active benchmark store lock was poisoned")?
        .contains(&path)
    {
        return Err("wait for the benchmark to finish before acknowledging its upload".into());
    }
    let run_lock = RunLock::acquire(root, run_id)?.ok_or("wait for the benchmark in the other application instance to finish before acknowledging its upload")?;
    let run = replay_run(&path)?;
    if run.record["id"] != run_id {
        return Err("benchmark recovery record identity does not match".into());
    }
    let candidate = if run.origin == Some(JournalOrigin::Native)
        && run.finalized
        && matches!(
            run.record["result"]["status"].as_str(),
            Some("complete" | "partial")
        ) {
        let (journal_bytes, journal_sha256) = journal_fingerprint(&path)?;
        Some(CacheCandidate {
            journal_file: path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("invalid benchmark journal name")?
                .into(),
            journal_bytes,
            journal_sha256,
            created_at: run.record["createdAt"]
                .as_u64()
                .ok_or("invalid benchmark timestamp")?,
        })
    } else {
        None
    };
    let accepted = AcceptedUpload {
        schema_version: 1,
        run_id: run_id.into(),
        receipt,
        acknowledged_at: now,
        candidate,
    };
    // The candidate exists before acceptance becomes durable. A crash before
    // acceptance can never authorize deletion; a crash afterward leaves a
    // discoverable candidate without scanning the permanent receipt archive.
    if accepted.candidate.is_some() {
        durable_receipt(&candidate_path(root, run_id), &accepted, ensure_durable)?;
    }
    durable_receipt(&accepted_path, &accepted, ensure_durable)?;
    drop(run_lock);
    Ok(prune_cache_with_durability(
        root,
        RECENT_CACHE_LIMIT,
        |path| fs::remove_file(path),
        ensure_durable,
    ))
}

#[cfg(test)]
fn prune_cache(
    root: &Path,
    limit: usize,
    remove_journal: impl FnMut(&Path) -> std::io::Result<()>,
) -> Acknowledgement {
    prune_cache_with_durability(root, limit, remove_journal, &ensure_durable_receipt)
}

fn prune_cache_with_durability(
    root: &Path,
    limit: usize,
    mut remove_journal: impl FnMut(&Path) -> std::io::Result<()>,
    ensure_durable: &dyn Fn(&Path) -> Result<(), String>,
) -> Acknowledgement {
    let mut result = Acknowledgement {
        acknowledged: true,
        pruned: 0,
        warnings: vec![],
    };
    let entries = match fs::read_dir(root.join("recent-cache")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return result,
        Err(error) => {
            result.warnings.push(format!(
                "accepted benchmark cache maintenance could not run: {error}"
            ));
            return result;
        }
    };
    let mut candidates = Vec::new();
    for entry in entries {
        let inspect = (|| -> Result<Option<(AcceptedUpload, PathBuf)>, String> {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                || entry
                    .path()
                    .extension()
                    .is_none_or(|extension| extension != "json")
            {
                return Ok(None);
            }
            let Some(candidate) = read_accepted(&entry.path())? else {
                return Ok(None);
            };
            let Some(metadata) = &candidate.candidate else {
                return Ok(None);
            };
            let Some(receipt) = read_accepted(&receipt_path(root, &candidate.run_id))? else {
                return Ok(None);
            };
            if candidate != receipt {
                return Err("accepted benchmark cache metadata disagrees with its permanent receipt; journal was preserved".into());
            }
            let journal = root.join("runs").join(&metadata.journal_file);
            if ACTIVE_RUNS
                .lock()
                .map_err(|_| "active benchmark store lock was poisoned")?
                .contains(&journal)
            {
                return Ok(None);
            }
            let Some(_run_lock) = RunLock::acquire(root, &candidate.run_id)? else {
                return Ok(None);
            };
            match fs::symlink_metadata(&journal) {
                Ok(_) => Ok(Some((candidate, entry.path()))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Recovery after eviction succeeded but marker removal was
                    // interrupted. The permanent receipt is never removed.
                    fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
                    sync_parent(&entry.path())?;
                    Ok(None)
                }
                Err(error) => Err(error.to_string()),
            }
        })();
        match inspect {
            Ok(Some(candidate)) => candidates.push(candidate),
            Ok(None) => {}
            Err(error) => result.warnings.push(error),
        }
    }
    candidates.sort_unstable_by(|(left, _), (right, _)| {
        right
            .acknowledged_at
            .cmp(&left.acknowledged_at)
            .then_with(|| {
                right
                    .candidate
                    .as_ref()
                    .map(|value| value.created_at)
                    .cmp(&left.candidate.as_ref().map(|value| value.created_at))
            })
            .then_with(|| right.run_id.cmp(&left.run_id))
    });
    for (accepted, marker) in candidates.into_iter().skip(limit) {
        let prune = (|| -> Result<(), String> {
            let candidate = accepted
                .candidate
                .as_ref()
                .ok_or("missing accepted cache metadata")?;
            let path = root.join("runs").join(&candidate.journal_file);
            let Some(_run_lock) = RunLock::acquire(root, &accepted.run_id)? else {
                return Ok(());
            };
            let (bytes, hash) = journal_fingerprint(&path)?;
            if bytes != candidate.journal_bytes || hash != candidate.journal_sha256 {
                return Err(
                    "an accepted benchmark journal changed after upload and was preserved".into(),
                );
            }
            let run = replay_run(&path)?;
            if run.origin != Some(JournalOrigin::Native)
                || !run.finalized
                || run.record["id"] != accepted.run_id
                || !matches!(
                    run.record["result"]["status"].as_str(),
                    Some("complete" | "partial")
                )
            {
                return Err("a benchmark recovery record was preserved because it is not eligible for cache eviction".into());
            }
            // A different acknowledgement must not turn an earlier failed
            // receipt sync into permission to discard its recovery journal.
            ensure_durable(&receipt_path(root, &accepted.run_id))?;
            remove_journal(&path).map_err(|error| format!("accepted benchmark cache eviction failed; receipt and recovery record were preserved: {error}"))?;
            sync_parent(&path)?;
            result.pruned += 1;
            fs::remove_file(&marker).map_err(|error| {
                format!("accepted benchmark cache marker cleanup failed: {error}")
            })?;
            sync_parent(&marker)
        })();
        if let Err(error) = prune {
            result.warnings.push(error);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::tests as fixtures;
    use super::super::{encoded, import, list, record_digest, Entry, RunJournal};
    use super::*;
    use crate::performance_bench;

    fn receipt(index: usize) -> UploadReceipt {
        UploadReceipt {
            submission_id: format!("00000000-0000-4000-8000-{index:012}"),
            id: format!("accepted-{index}"),
            url: Some(format!(
                "https://benchmarks.example.test/runs/accepted-{index}"
            )),
            destination: "https://benchmarks.example.test/v1/benchmark-runs".into(),
        }
    }

    fn native(root: &Path, id: &str, created: u64, status: &'static str) -> PathBuf {
        let initial = fixtures::record(id, created);
        let request = serde_json::from_value(initial["request"].clone()).unwrap();
        let journal = RunJournal::begin(root, initial).unwrap();
        let mut result = performance_bench::failed(
            &request,
            &crate::config::AppConfig::default(),
            "pending".into(),
        );
        result.rows.push(fixtures::row());
        journal.checkpoint(&result).unwrap();
        if status != "interrupted" {
            result.status = status;
            result.message = None;
            journal.finish(&result).unwrap();
        }
        let path = journal.path.clone();
        drop(journal);
        path
    }

    #[test]
    fn acceptance_is_immutable_idempotent_and_separate_from_public_result() {
        let root = fixtures::root();
        let journal = native(&root, "accepted", 1, "complete");
        let original = fs::read(&journal).unwrap();
        let accepted = acknowledge_at(&root, "accepted", receipt(1), 50).unwrap();
        assert_eq!(accepted.pruned, 0);
        assert!(accepted.warnings.is_empty());
        let persisted = fs::read(receipt_path(&root, "accepted")).unwrap();
        let modified = fs::metadata(receipt_path(&root, "accepted"))
            .unwrap()
            .modified()
            .unwrap();
        acknowledge_at(&root, "accepted", receipt(1), 500).unwrap();
        assert_eq!(
            fs::read(receipt_path(&root, "accepted")).unwrap(),
            persisted
        );
        assert_eq!(
            fs::metadata(receipt_path(&root, "accepted"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        assert_eq!(fs::read(&journal).unwrap(), original);
        let page = list(&root, 0, 20).unwrap();
        assert_eq!(page.records[0]["localState"], "cached");
        assert_eq!(page.records[0]["acknowledgedAt"], 50);
        assert_eq!(page.records[0]["remoteReceipt"]["id"], "accepted-1");
        assert!(page.records[0]["result"].get("remoteReceipt").is_none());
        assert!(acknowledge_at(&root, "accepted", receipt(2), 1000).is_err());
        assert_eq!(
            fs::read(receipt_path(&root, "accepted")).unwrap(),
            persisted
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_new_acknowledged_native_records_are_pruned_to_the_recent_hundred() {
        let root = fixtures::root();
        let unuploaded = native(&root, "unuploaded", 0, "complete");
        let interrupted = native(&root, "interrupted", 1, "interrupted");
        let failed = native(&root, "failed", 2, "failed");
        import(&root, vec![fixtures::record("legacy", 3)]).unwrap();
        let old = fixtures::record("existing", 4);
        let existing = root
            .join("runs")
            .join(format!("{:016}-{}", 4, record_digest(&old)));
        let mut bytes = encoded(&Entry::Start {
            record: old.clone(),
            origin: None,
        })
        .unwrap();
        bytes.extend(
            encoded(&Entry::Finish {
                result: old["result"].clone(),
            })
            .unwrap(),
        );
        fs::write(&existing, bytes).unwrap();
        for (index, id) in ["interrupted", "failed", "legacy", "existing"]
            .iter()
            .enumerate()
        {
            acknowledge_at(&root, id, receipt(index + 500), 10 + index as u64).unwrap();
        }
        let mut journal_paths = Vec::new();
        for index in 0..102 {
            let id = format!("cache-{index}");
            journal_paths.push(native(&root, &id, 100 + index as u64, "complete"));
            acknowledge_at(&root, &id, receipt(index), 100 + index as u64).unwrap();
        }
        assert!(!journal_paths[0].exists());
        assert!(!journal_paths[1].exists());
        assert!(journal_paths[2..].iter().all(|path| path.exists()));
        assert!(unuploaded.exists());
        assert!(interrupted.exists());
        assert!(failed.exists());
        assert!(existing.exists());
        let page = list(&root, 100, 100).unwrap();
        assert_eq!(page.total, 105);
        assert!(page.records.iter().any(|record| record["id"] == "legacy"));
        assert!(has_tombstone(&root, "cache-0").unwrap());
        assert_eq!(
            import(&root, vec![fixtures::record("cache-0", 100)]).unwrap(),
            0
        );
        assert!(RunJournal::begin(&root, fixtures::record("cache-0", 999)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_runs_and_invalid_receipts_cannot_be_acknowledged() {
        let root = fixtures::root();
        let journal = RunJournal::begin(&root, fixtures::record("active", 1)).unwrap();
        assert!(acknowledge_at(&root, "active", receipt(1), 10).is_err());
        assert!(!has_tombstone(&root, "active").unwrap());
        drop(journal);
        let mut invalid = receipt(1);
        invalid.destination = "http://external.example.test/v1/benchmark-runs".into();
        assert!(acknowledge_at(&root, "active", invalid, 10).is_err());
        let mut invalid = receipt(1);
        invalid.url = Some("https://other.example.test/runs/1".into());
        assert!(acknowledge_at(&root, "active", invalid, 10).is_err());
        assert_eq!(
            list(&root, 0, 20).unwrap().records[0]["localState"],
            "recovery"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_receipt_save_never_authorizes_cache_eviction() {
        let root = fixtures::root();
        let journal = native(&root, "recovery", 1, "complete");
        let original = fs::read(&journal).unwrap();
        fs::write(root.join("receipts"), b"synthetic directory obstruction").unwrap();
        assert!(acknowledge_at(&root, "recovery", receipt(1), 10).is_err());
        let maintenance = prune_cache(&root, 0, |path| fs::remove_file(path));
        assert_eq!(maintenance.pruned, 0);
        assert_eq!(fs::read(&journal).unwrap(), original);
        fs::remove_file(root.join("receipts")).unwrap();
        assert_eq!(
            list(&root, 0, 20).unwrap().records[0]["localState"],
            "recovery"
        );
        acknowledge_at(&root, "recovery", receipt(1), 20).unwrap();
        assert_eq!(
            list(&root, 0, 20).unwrap().records[0]["localState"],
            "cached"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn eviction_failure_and_changed_journal_keep_recovery_and_receipts() {
        let root = fixtures::root();
        let journal = native(&root, "preserved", 1, "complete");
        acknowledge_at(&root, "preserved", receipt(1), 10).unwrap();
        let maintenance = prune_cache(&root, 0, |_| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });
        assert_eq!(maintenance.pruned, 0);
        assert_eq!(maintenance.warnings.len(), 1);
        assert!(journal.exists());
        assert!(has_tombstone(&root, "preserved").unwrap());
        let mut contents = fs::read(&journal).unwrap();
        contents.extend_from_slice(b"changed after acceptance");
        fs::write(&journal, &contents).unwrap();
        let maintenance = prune_cache(&root, 0, |path| fs::remove_file(path));
        assert_eq!(maintenance.pruned, 0);
        assert_eq!(maintenance.warnings.len(), 1);
        assert_eq!(fs::read(&journal).unwrap(), contents);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_after_eviction_cleans_only_candidate_marker_and_keeps_tombstone() {
        let root = fixtures::root();
        let journal = native(&root, "evicted", 1, "complete");
        acknowledge_at(&root, "evicted", receipt(1), 10).unwrap();
        let receipt_bytes = fs::read(receipt_path(&root, "evicted")).unwrap();
        fs::remove_file(&journal).unwrap();
        assert!(candidate_path(&root, "evicted").exists());
        acknowledge_at(&root, "evicted", receipt(1), 500).unwrap();
        assert!(!candidate_path(&root, "evicted").exists());
        assert_eq!(
            fs::read(receipt_path(&root, "evicted")).unwrap(),
            receipt_bytes
        );
        assert_eq!(
            import(&root, vec![fixtures::record("evicted", 1)]).unwrap(),
            0
        );
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn visible_receipt_after_failed_sync_cannot_bypass_durability_on_retry_or_eviction() {
        let root = fixtures::root();
        let journal = native(&root, "durability", 1, "complete");
        let receipt_file = receipt_path(&root, "durability");
        let fail_receipt_sync = |path: &Path| {
            if path == receipt_file {
                Err("synthetic receipt directory sync failure".into())
            } else {
                ensure_durable_receipt(path)
            }
        };
        assert!(acknowledge_at_with_durability(
            &root,
            "durability",
            receipt(1),
            10,
            &fail_receipt_sync
        )
        .is_err());
        assert!(receipt_file.is_file());
        let visible = fs::read(&receipt_file).unwrap();
        assert!(acknowledge_at_with_durability(
            &root,
            "durability",
            receipt(1),
            20,
            &fail_receipt_sync
        )
        .is_err());
        let maintenance =
            prune_cache_with_durability(&root, 0, |path| fs::remove_file(path), &fail_receipt_sync);
        assert_eq!(maintenance.pruned, 0);
        assert_eq!(maintenance.warnings.len(), 1);
        assert!(journal.is_file());
        assert_eq!(fs::read(&receipt_file).unwrap(), visible);
        acknowledge_at(&root, "durability", receipt(1), 30).unwrap();
        let maintenance = prune_cache(&root, 0, |path| fs::remove_file(path));
        assert_eq!(maintenance.pruned, 1);
        assert!(!journal.exists());
        assert_eq!(fs::read(&receipt_file).unwrap(), visible);
        fs::remove_dir_all(root).unwrap();
    }

    fn receipt_child(root: &Path, mode: &str, index: usize) -> std::process::Child {
        crate::procutil::std_command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "benchmark::store::receipts::tests::cross_process_receipt_fixture",
                "--nocapture",
            ])
            .env("AIOLM_BENCH_RECEIPT_FIXTURE_ROOT", root)
            .env("AIOLM_BENCH_RECEIPT_FIXTURE_MODE", mode)
            .env("AIOLM_BENCH_RECEIPT_FIXTURE_INDEX", index.to_string())
            .spawn()
            .unwrap()
    }

    #[test]
    fn cross_process_receipt_fixture() {
        let Some(root) = std::env::var_os("AIOLM_BENCH_RECEIPT_FIXTURE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let index: usize = std::env::var("AIOLM_BENCH_RECEIPT_FIXTURE_INDEX")
            .unwrap()
            .parse()
            .unwrap();
        match std::env::var("AIOLM_BENCH_RECEIPT_FIXTURE_MODE")
            .unwrap()
            .as_str()
        {
            "accept" => {
                let outcome = acknowledge_at(&root, "shared", receipt(index), index as u64);
                let text = match outcome {
                    Ok(_) => "accepted",
                    Err(error) => {
                        assert!(
                            error.contains("different accepted upload receipt"),
                            "{error}"
                        );
                        "conflict"
                    }
                };
                fs::write(root.join(format!("outcome-{index}")), text).unwrap();
            }
            "active" => {
                assert!(acknowledge_at(&root, "shared-active", receipt(1), 1).is_err());
                let _store = StoreLock::acquire(&root).unwrap();
                assert_eq!(
                    prune_cache(&root, 0, |path| fs::remove_file(path)).pruned,
                    0
                );
            }
            _ => panic!("unknown receipt fixture"),
        }
    }

    #[test]
    fn competing_processes_cannot_replace_the_first_accepted_mapping() {
        let root = fixtures::root();
        let journal = native(&root, "shared", 1, "complete");
        let mut first = receipt_child(&root, "accept", 1);
        let mut second = receipt_child(&root, "accept", 2);
        assert!(first.wait().unwrap().success());
        assert!(second.wait().unwrap().success());
        let mut outcomes = vec![
            fs::read_to_string(root.join("outcome-1")).unwrap(),
            fs::read_to_string(root.join("outcome-2")).unwrap(),
        ];
        outcomes.sort();
        assert_eq!(outcomes, vec!["accepted", "conflict"]);
        let permanent = read_accepted(&receipt_path(&root, "shared"))
            .unwrap()
            .unwrap();
        let candidate = read_accepted(&candidate_path(&root, "shared"))
            .unwrap()
            .unwrap();
        assert!(permanent == candidate);
        assert!(journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn another_process_cannot_acknowledge_or_prune_a_locked_run() {
        let root = fixtures::root();
        let recovery = native(&root, "shared-active", 1, "complete");
        let cached = native(&root, "shared-cached", 2, "complete");
        acknowledge_at(&root, "shared-cached", receipt(2), 2).unwrap();
        let recovery_lock = RunLock::acquire(&root, "shared-active").unwrap().unwrap();
        let cache_lock = RunLock::acquire(&root, "shared-cached").unwrap().unwrap();
        assert!(receipt_child(&root, "active", 1).wait().unwrap().success());
        assert!(recovery.exists());
        assert!(cached.exists());
        assert!(!has_tombstone(&root, "shared-active").unwrap());
        drop(recovery_lock);
        drop(cache_lock);
        fs::remove_dir_all(root).unwrap();
    }
}
