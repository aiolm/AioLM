//! Registry of active Hugging Face download/update transfers.
//!
//! Concurrent transfers to distinct destinations share one `operation` gate
//! ownership claim so server starts and model deletions still wait for every
//! download to finish, while separate model downloads proceed in parallel and
//! cancel or clean up independently.
use crate::discover::{shard_group, validate_repo_id, validate_repo_path, PendingDownload};
use crate::error::AppError;
use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

const MAX_CANCEL_TOMBSTONES: usize = 128;

struct JobEntry {
    cancel: Arc<AtomicBool>,
    targets: Vec<String>,
}

#[derive(Default)]
struct DownloadJobsInner {
    jobs: HashMap<String, JobEntry>,
    discard_claims: Vec<(u64, Vec<String>)>,
    next_discard_id: u64,
    cancelled_before_start: VecDeque<String>,
    operation_guard: Option<OwnedMutexGuard<()>>,
}

/// Shared coordinator for concurrent model downloads and snapshot updates.
#[derive(Default)]
pub(crate) struct DownloadJobs {
    inner: Mutex<DownloadJobsInner>,
}

/// Active transfer lease. Dropping it unregisters the job and clears the
/// shared operation gate / `model_download` flag once the last transfer ends.
pub(crate) struct DownloadLease {
    jobs: Arc<DownloadJobs>,
    model_download: Arc<AtomicBool>,
    id: String,
    cancel: Arc<AtomicBool>,
}

impl DownloadLease {
    pub(crate) fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

impl Drop for DownloadLease {
    fn drop(&mut self) {
        let released_operation = {
            let mut inner = self
                .jobs
                .inner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            inner.jobs.remove(&self.id);
            let still_active = !inner.jobs.is_empty();
            self.model_download.store(still_active, Ordering::Release);
            if still_active {
                None
            } else {
                inner.operation_guard.take()
            }
        };
        drop(released_operation);
    }
}

/// Prevents a new download from starting on targets whose staged bytes are
/// currently being removed by `hf_discard_download`.
pub(crate) struct DiscardLease {
    jobs: Arc<DownloadJobs>,
    claim_id: u64,
}

impl Drop for DiscardLease {
    fn drop(&mut self) {
        let mut inner = self
            .jobs
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        inner
            .discard_claims
            .retain(|(claim_id, _)| *claim_id != self.claim_id);
    }
}

impl DownloadJobs {
    /// Register one transfer for `targets`, acquiring `operation` if this is
    /// the first active transfer or sharing the existing group claim.
    pub(crate) fn begin(
        self: &Arc<Self>,
        id: &str,
        targets: Vec<String>,
        operation: &Arc<AsyncMutex<()>>,
        model_download: &Arc<AtomicBool>,
    ) -> Result<DownloadLease, AppError> {
        let id = id.trim();
        if id.is_empty() || id.len() > 128 {
            return Err(AppError::validation("download identifier is invalid"));
        }
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(pos) = inner
            .cancelled_before_start
            .iter()
            .position(|cancelled| cancelled == id)
        {
            inner.cancelled_before_start.remove(pos);
            return Err(AppError::cancelled("model download cancelled"));
        }
        if inner.jobs.contains_key(id) {
            return Err(AppError::busy("download is already in progress"));
        }
        if inner
            .jobs
            .values()
            .any(|entry| target_lists_conflict(&entry.targets, &targets))
            || inner
                .discard_claims
                .iter()
                .any(|(_, claim)| target_lists_conflict(claim, &targets))
        {
            return Err(AppError::busy(
                "a download for this model destination is already in progress",
            ));
        }
        if inner.operation_guard.is_none() {
            let guard = operation
                .clone()
                .try_lock_owned()
                .map_err(|_| AppError::busy("another model operation is in progress"))?;
            inner.operation_guard = Some(guard);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inner.jobs.insert(
            id.to_owned(),
            JobEntry {
                cancel: cancel.clone(),
                targets,
            },
        );
        model_download.store(true, Ordering::Release);
        Ok(DownloadLease {
            jobs: self.clone(),
            model_download: model_download.clone(),
            id: id.to_owned(),
            cancel,
        })
    }

    /// Cancel either one specific active/pending-start download or all active
    /// transfers when `id` is omitted.
    pub(crate) fn cancel(&self, id: Option<&str>) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(id) = id.map(str::trim).filter(|value| !value.is_empty()) {
            if let Some(entry) = inner.jobs.get(id) {
                entry.cancel.store(true, Ordering::Release);
            } else {
                if !inner.cancelled_before_start.iter().any(|item| item == id) {
                    if inner.cancelled_before_start.len() >= MAX_CANCEL_TOMBSTONES {
                        inner.cancelled_before_start.pop_front();
                    }
                    inner.cancelled_before_start.push_back(id.to_owned());
                }
            }
            return;
        }
        for entry in inner.jobs.values() {
            entry.cancel.store(true, Ordering::Release);
        }
    }

    /// Mark every active transfer for shutdown cancellation.
    pub(crate) fn cancel_all(&self) {
        self.cancel(None);
    }

    /// Return whether an active transfer touches the same target as `pending`.
    pub(crate) fn is_pending_active(&self, pending: &PendingDownload) -> bool {
        let targets = pending_target_keys(pending);
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        inner
            .jobs
            .values()
            .any(|entry| target_lists_conflict(&entry.targets, &targets))
    }

    /// Reserve exclusive cleanup access for `pending` unless an active download
    /// or another cleanup owns overlapping targets.
    pub(crate) fn try_discard_pending(
        self: &Arc<Self>,
        pending: &PendingDownload,
    ) -> Result<DiscardLease, AppError> {
        let targets = pending_target_keys(pending);
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if inner
            .jobs
            .values()
            .any(|entry| target_lists_conflict(&entry.targets, &targets))
        {
            return Err(AppError::busy(
                "stop the active download before discarding it",
            ));
        }
        if inner
            .discard_claims
            .iter()
            .any(|(_, claim)| target_lists_conflict(claim, &targets))
        {
            return Err(AppError::busy(
                "this pending download is already being discarded",
            ));
        }
        inner.next_discard_id = inner.next_discard_id.wrapping_add(1);
        let claim_id = inner.next_discard_id;
        inner.discard_claims.push((claim_id, targets));
        Ok(DiscardLease {
            jobs: self.clone(),
            claim_id,
        })
    }
}

fn target_lists_conflict(left: &[String], right: &[String]) -> bool {
    left.iter()
        .any(|a| right.iter().any(|b| keys_conflict(a, b)))
}

fn keys_conflict(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    match (left.strip_prefix("tree:"), right.strip_prefix("file:")) {
        (Some(tree), Some(file)) => path_within(file, tree),
        _ => match (right.strip_prefix("tree:"), left.strip_prefix("file:")) {
            (Some(tree), Some(file)) => path_within(file, tree),
            _ => match (
                left.strip_prefix("companion-dir:"),
                right.strip_prefix("file:"),
            ) {
                (Some(dir), Some(file)) => companion_file_in_dir(file, dir),
                _ => match (
                    right.strip_prefix("companion-dir:"),
                    left.strip_prefix("file:"),
                ) {
                    (Some(dir), Some(file)) => companion_file_in_dir(file, dir),
                    _ => false,
                },
            },
        },
    }
}

fn path_within(path: &str, dir: &str) -> bool {
    path == dir
        || path
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn companion_file_in_dir(file: &str, dir: &str) -> bool {
    file.strip_prefix(dir)
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|name| !name.contains('/') && !name.ends_with(".gguf"))
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn canonical_or_ancestor(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return resolved;
    }
    let mut suffix = Vec::new();
    let mut current = path;
    while let Some(name) = current.file_name() {
        suffix.push(name.to_os_string());
        let Some(parent) = current.parent() else {
            break;
        };
        if let Ok(resolved) = parent.canonicalize() {
            let mut out = resolved;
            for part in suffix.into_iter().rev() {
                out.push(part);
            }
            return lexical_normalize(&out);
        }
        current = parent;
    }
    lexical_normalize(path)
}

pub(crate) fn normalize_path_key(path: &Path) -> String {
    let resolved = canonical_or_ancestor(path);
    let raw = resolved.to_string_lossy();
    #[cfg(windows)]
    let trimmed = raw.strip_prefix(r"\\?\").unwrap_or(raw.as_ref());
    #[cfg(not(windows))]
    let trimmed = raw.as_ref();
    let slashed = trimmed.replace('\\', "/");
    #[cfg(windows)]
    {
        slashed.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        slashed
    }
}

pub(crate) fn gguf_target_keys(
    repo_id: &str,
    file_path: &str,
    models_dir: &str,
    include_companions: bool,
) -> Result<Vec<String>, AppError> {
    validate_repo_id(repo_id)?;
    validate_repo_path(file_path)?;
    let trimmed_root = models_dir.trim();
    if trimmed_root.is_empty() {
        return Err(AppError::validation("models directory is empty"));
    }
    let mut target = PathBuf::from(trimmed_root).join("hf");
    for part in repo_id.trim().split('/') {
        target.push(part);
    }
    let trimmed_file = file_path.trim();
    for part in trimmed_file.split('/') {
        target.push(part);
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::validation("download destination has no parent"))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::validation("download filename is empty"))?;
    let mut keys: Vec<String> = if let Some(shards) = shard_group(name) {
        shards
            .map(|shard| format!("file:{}", normalize_path_key(&parent.join(shard))))
            .collect()
    } else {
        vec![format!("file:{}", normalize_path_key(&target))]
    };
    if include_companions {
        keys.push(format!("companion-dir:{}", normalize_path_key(parent)));
    }
    Ok(keys)
}

pub(crate) fn snapshot_target_keys(
    repo_id: &str,
    models_dir: &str,
    file_path: Option<&str>,
) -> Result<Vec<String>, AppError> {
    validate_repo_id(repo_id)?;
    let trimmed_root = models_dir.trim();
    if trimmed_root.is_empty() {
        return Err(AppError::validation("models directory is empty"));
    }
    let selected = file_path.map(str::trim).filter(|value| !value.is_empty());
    let root_key = normalize_path_key(Path::new(trimmed_root));
    Ok(vec![format!(
        "snapshot:{root_key}|{}|{}",
        repo_id.trim(),
        selected.unwrap_or_default()
    )])
}

pub(crate) fn update_target_keys(path: &str, models_dir: &str) -> Result<Vec<String>, AppError> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() || models_dir.trim().is_empty() {
        return Err(AppError::validation("model path or directory is empty"));
    }
    let local = Path::new(trimmed_path);
    let key = normalize_path_key(local);
    let mut keys = vec![format!("file:{key}"), format!("tree:{key}")];
    if let (Some(parent), Some(name)) = (
        local.parent(),
        local.file_name().and_then(|value| value.to_str()),
    ) {
        if let Some(shards) = shard_group(name) {
            for shard in shards {
                keys.push(format!("file:{}", normalize_path_key(&parent.join(shard))));
            }
        }
    }
    Ok(keys)
}

pub(crate) fn pending_target_keys(pending: &PendingDownload) -> Vec<String> {
    let mut keys = Vec::new();
    if pending.snapshot {
        if let Ok(extra) = snapshot_target_keys(
            &pending.repo_id,
            &pending.models_dir,
            pending.file_path.as_deref(),
        ) {
            keys.extend(extra);
        }
    } else if let Some(file_path) = pending.file_path.as_deref() {
        if let Ok(extra) = gguf_target_keys(
            &pending.repo_id,
            file_path,
            &pending.models_dir,
            pending.include_companions,
        ) {
            keys.extend(extra);
        }
    }
    for file in &pending.files {
        keys.push(format!(
            "file:{}",
            normalize_path_key(Path::new(&file.path))
        ));
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discover::PendingFile;

    #[test]
    fn concurrent_distinct_downloads_share_operation_gate_and_clear_on_last_drop() {
        let jobs = Arc::new(DownloadJobs::default());
        let operation = Arc::new(AsyncMutex::new(()));
        let flag = Arc::new(AtomicBool::new(false));
        let root = std::env::temp_dir()
            .join(format!("aiolm-jobs-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();

        let keys_a = gguf_target_keys("owner/alpha", "alpha.gguf", &root, false).unwrap();
        let keys_b = gguf_target_keys("owner/beta", "beta.gguf", &root, true).unwrap();

        let lease_a = jobs.begin("dl-a", keys_a, &operation, &flag).unwrap();
        let lease_b = jobs.begin("dl-b", keys_b, &operation, &flag).unwrap();
        assert!(flag.load(Ordering::Acquire));
        assert!(operation.try_lock().is_err());

        drop(lease_a);
        assert!(flag.load(Ordering::Acquire));
        assert!(operation.try_lock().is_err());

        drop(lease_b);
        assert!(!flag.load(Ordering::Acquire));
        assert!(operation.try_lock().is_ok());
    }

    #[test]
    fn duplicate_target_or_split_shard_is_rejected_while_disjoint_companions_run() {
        let jobs = Arc::new(DownloadJobs::default());
        let operation = Arc::new(AsyncMutex::new(()));
        let flag = Arc::new(AtomicBool::new(false));
        let root = std::env::temp_dir()
            .join(format!("aiolm-shards-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();

        let shard_1 =
            gguf_target_keys("owner/split", "Q4/model-00001-of-00002.gguf", &root, true).unwrap();
        let shard_2 =
            gguf_target_keys("owner/split", "Q4/model-00002-of-00002.gguf", &root, true).unwrap();
        let separate_quant =
            gguf_target_keys("owner/split", "Q8/model-00001-of-00002.gguf", &root, true).unwrap();

        let _lease_1 = jobs.begin("dl-1", shard_1, &operation, &flag).unwrap();
        let dup = jobs.begin("dl-2", shard_2, &operation, &flag);
        assert_eq!(
            dup.err().expect("sibling shard must conflict").kind,
            crate::error::ErrorKind::Busy
        );
        let _lease_q8 = jobs
            .begin("dl-q8", separate_quant, &operation, &flag)
            .unwrap();
    }

    #[test]
    fn targeted_cancel_stops_only_the_requested_download() {
        let jobs = Arc::new(DownloadJobs::default());
        let operation = Arc::new(AsyncMutex::new(()));
        let flag = Arc::new(AtomicBool::new(false));
        let root = std::env::temp_dir()
            .join(format!("aiolm-cancel-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();

        let lease_a = jobs
            .begin(
                "dl-a",
                gguf_target_keys("owner/a", "a.gguf", &root, false).unwrap(),
                &operation,
                &flag,
            )
            .unwrap();
        let lease_b = jobs
            .begin(
                "dl-b",
                gguf_target_keys("owner/b", "b.gguf", &root, false).unwrap(),
                &operation,
                &flag,
            )
            .unwrap();

        jobs.cancel(Some("dl-a"));
        assert!(lease_a.cancel_flag().load(Ordering::Acquire));
        assert!(!lease_b.cancel_flag().load(Ordering::Acquire));

        jobs.cancel(None);
        assert!(lease_b.cancel_flag().load(Ordering::Acquire));
    }

    #[test]
    fn discard_allowed_for_paused_model_while_another_model_downloads() {
        let jobs = Arc::new(DownloadJobs::default());
        let operation = Arc::new(AsyncMutex::new(()));
        let flag = Arc::new(AtomicBool::new(false));
        let root = std::env::temp_dir()
            .join(format!("aiolm-discard-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();

        let _lease_a = jobs
            .begin(
                "dl-a",
                gguf_target_keys("owner/a", "a.gguf", &root, false).unwrap(),
                &operation,
                &flag,
            )
            .unwrap();

        let paused_b = PendingDownload {
            id: "pending-b".into(),
            repo_id: "owner/b".into(),
            file_path: Some("b.gguf".into()),
            revision: Some("r1".into()),
            snapshot: false,
            models_dir: root.clone(),
            include_companions: false,
            label: "b.gguf".into(),
            total: 10,
            received: 5,
            updated_at: 1,
            files: vec![PendingFile {
                path: Path::new(&root)
                    .join("hf/owner/b/b.gguf")
                    .to_string_lossy()
                    .into_owned(),
                size: 10,
            }],
        };
        let active_a_pending = PendingDownload {
            id: "pending-a".into(),
            repo_id: "owner/a".into(),
            file_path: Some("a.gguf".into()),
            revision: Some("r1".into()),
            snapshot: false,
            models_dir: root.clone(),
            include_companions: false,
            label: "a.gguf".into(),
            total: 10,
            received: 5,
            updated_at: 1,
            files: vec![PendingFile {
                path: Path::new(&root)
                    .join("hf/owner/a/a.gguf")
                    .to_string_lossy()
                    .into_owned(),
                size: 10,
            }],
        };

        assert!(!jobs.is_pending_active(&paused_b));
        assert!(jobs.is_pending_active(&active_a_pending));
        let _discard_b = jobs.try_discard_pending(&paused_b).unwrap();
        let discard_a = jobs.try_discard_pending(&active_a_pending);
        assert_eq!(
            discard_a
                .err()
                .expect("active download discard must fail")
                .kind,
            crate::error::ErrorKind::Busy
        );
    }
}
