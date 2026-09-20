//! OS locks coordinate separate application processes. Lock files are permanent
//! names; closing a handle (including process exit) releases ownership.
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

static LOCAL_STORE_LOCK: Mutex<()> = Mutex::new(());

pub(super) struct StoreLock {
    _file: File,
    _local: MutexGuard<'static, ()>,
}

fn open_lock(path: &Path) -> Result<File, String> {
    fs::create_dir_all(path.parent().ok_or("benchmark lock has no directory")?)
        .map_err(|error| error.to_string())?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| format!("cannot open benchmark coordination lock: {error}"))
}

impl StoreLock {
    pub(super) fn acquire(root: &Path) -> Result<Self, String> {
        let local = LOCAL_STORE_LOCK
            .lock()
            .map_err(|_| "benchmark store lock was poisoned")?;
        let file = open_lock(&root.join(".store.lock"))?;
        file.lock()
            .map_err(|error| format!("cannot lock benchmark storage: {error}"))?;
        Ok(Self {
            _file: file,
            _local: local,
        })
    }
}

pub(super) struct RunLock {
    _file: File,
}

fn run_lock_path(root: &Path, run_id: &str) -> PathBuf {
    root.join("run-locks")
        .join(format!("{:x}.lock", Sha256::digest(run_id.as_bytes())))
}

fn try_lock(path: &Path) -> Result<Option<RunLock>, String> {
    let file = open_lock(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(RunLock { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(format!("cannot lock benchmark run: {error}")),
    }
}

impl RunLock {
    pub(super) fn acquire(root: &Path, run_id: &str) -> Result<Option<Self>, String> {
        try_lock(&run_lock_path(root, run_id))
    }

    pub(super) fn for_journal(root: &Path, journal: &Path) -> Result<Option<Self>, String> {
        let digest = Self::journal_digest(journal)?;
        try_lock(&root.join("run-locks").join(format!("{digest}.lock")))
    }

    pub(super) fn journal_digest(journal: &Path) -> Result<&str, String> {
        let stem = journal
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or("invalid benchmark journal name")?;
        let (_, digest) = stem
            .split_once('-')
            .ok_or("invalid benchmark journal name")?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("invalid benchmark journal identity".into());
        }
        Ok(digest)
    }
}

pub(super) fn mark_active(root: &Path, run_id: &str) -> Result<PathBuf, String> {
    let path = root
        .join("active-runs")
        .join(format!("{:x}.active", Sha256::digest(run_id.as_bytes())));
    // This marker is only a discoverability hint. The permanent OS lock remains
    // authoritative, and is already held before the marker becomes visible.
    open_lock(&path)?;
    Ok(path)
}

pub(super) fn active_digests(root: &Path) -> Result<(HashSet<String>, Vec<String>), String> {
    let mut active = HashSet::new();
    let mut warnings = Vec::new();
    let entries = match fs::read_dir(root.join("active-runs")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((active, warnings))
        }
        Err(error) => return Err(format!("cannot inspect active benchmark runs: {error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let Some(digest) = path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit()))
        else {
            warnings.push("an invalid benchmark activity marker was preserved".into());
            continue;
        };
        if path
            .extension()
            .is_none_or(|extension| extension != "active")
        {
            continue;
        }
        match try_lock(&root.join("run-locks").join(format!("{digest}.lock"))) {
            Ok(None) => {
                active.insert(digest.to_owned());
            }
            Ok(Some(_lock)) => {
                // StoreLock prevents a new owner from starting while the OS run
                // lock proves the prior process no longer owns this marker.
                if let Err(error) = fs::remove_file(&path) {
                    warnings.push(format!(
                        "a stale benchmark activity marker was preserved: {error}"
                    ));
                }
            }
            Err(error) => {
                active.insert(digest.to_owned());
                warnings.push(error);
            }
        }
    }
    Ok((active, warnings))
}

#[cfg(test)]
mod tests {
    use super::super::tests as fixtures;
    use super::super::{list, RunJournal};
    use super::*;

    fn child(root: &Path, mode: &str) -> std::process::Child {
        crate::procutil::std_command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "benchmark::store::locks::tests::cross_process_lock_fixture",
                "--nocapture",
            ])
            .env("AIOLM_BENCH_LOCK_FIXTURE_ROOT", root)
            .env("AIOLM_BENCH_LOCK_FIXTURE_MODE", mode)
            .spawn()
            .unwrap()
    }

    #[test]
    fn cross_process_lock_fixture() {
        let Some(root) = std::env::var_os("AIOLM_BENCH_LOCK_FIXTURE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        match std::env::var("AIOLM_BENCH_LOCK_FIXTURE_MODE")
            .unwrap()
            .as_str()
        {
            "store-locked" => {
                let file = open_lock(&root.join(".store.lock")).unwrap();
                assert!(matches!(file.try_lock(), Err(TryLockError::WouldBlock)));
            }
            "run-active" => {
                assert!(RunLock::acquire(&root, "cross-process").unwrap().is_none());
                assert_eq!(list(&root, 0, 20).unwrap().total, 0);
            }
            "release-on-exit" => {
                let _lock = RunLock::acquire(&root, "exit-fixture").unwrap().unwrap();
                mark_active(&root, "exit-fixture").unwrap();
                std::process::exit(0);
            }
            _ => panic!("unknown benchmark lock fixture"),
        }
    }

    #[test]
    fn store_lock_is_exclusive_across_application_processes() {
        let root = fixtures::root();
        let lock = StoreLock::acquire(&root).unwrap();
        assert!(child(&root, "store-locked").wait().unwrap().success());
        drop(lock);
        assert!(root.join(".store.lock").is_file());
        let _lock = StoreLock::acquire(&root).unwrap();
        drop(_lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_journal_is_hidden_from_other_processes_and_process_exit_releases_run_lock() {
        let root = fixtures::root();
        let journal = RunJournal::begin(&root, fixtures::record("cross-process", 1)).unwrap();
        let activity_marker = journal.activity_marker.clone();
        assert!(child(&root, "run-active").wait().unwrap().success());
        drop(journal);
        assert!(!activity_marker.exists());
        assert_eq!(list(&root, 0, 20).unwrap().total, 1);
        assert!(child(&root, "release-on-exit").wait().unwrap().success());
        let marker = root
            .join("active-runs")
            .join(format!("{:x}.active", Sha256::digest(b"exit-fixture")));
        assert!(marker.exists());
        list(&root, 0, 20).unwrap();
        assert!(!marker.exists());
        let lock = RunLock::acquire(&root, "exit-fixture").unwrap().unwrap();
        drop(lock);
        assert!(run_lock_path(&root, "exit-fixture").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_only_opens_run_locks_for_the_requested_page() {
        let root = fixtures::root();
        let records: Vec<_> = (0..150)
            .map(|index| fixtures::record(&format!("legacy-{index}"), index))
            .collect();
        for page in records.chunks(100) {
            super::super::import(&root, page.to_vec()).unwrap();
        }
        assert!(!root.join("run-locks").exists());
        let page = list(&root, 50, 5).unwrap();
        assert_eq!(page.records.len(), 5);
        assert_eq!(page.total, 150);
        assert_eq!(fs::read_dir(root.join("run-locks")).unwrap().count(), 5);
        list(&root, 100, 10).unwrap();
        assert_eq!(fs::read_dir(root.join("run-locks")).unwrap().count(), 15);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_preserves_and_skips_a_record_when_its_os_lock_cannot_be_opened() {
        let root = fixtures::root();
        super::super::import(&root, vec![fixtures::record("lock-unavailable", 1)]).unwrap();
        fs::create_dir_all(run_lock_path(&root, "lock-unavailable")).unwrap();
        let page = list(&root, 0, 20).unwrap();
        assert_eq!(page.total, 1);
        assert!(page.records.is_empty());
        assert_eq!(page.warnings.len(), 1);
        assert_eq!(super::super::files(&root).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
