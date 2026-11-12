use super::*;

/// How many times a directory removal is retried before it is given up on.
///
/// On Windows a just-exited compiler, Explorer, or the on-access virus scanner
/// can still hold a handle to a file in the build tree for a moment after the
/// process that created it exited. A couple of spaced retries turn that into a
/// success; an unbounded retry loop would turn a genuinely locked file into a
/// background thread that never ends.
pub(super) const CLEANUP_ATTEMPTS: u32 = 3;

const CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(250);

/// A crashed process can leave a multi-gigabyte PR workspace behind. Seven
/// days is deliberately conservative: a long-running compile and a user
/// directory that happens to resemble our names both remain untouched for a
/// useful amount of time before startup cleanup considers them stale.
pub(super) const ORPHAN_SWEEP_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

const PR_WORKSPACE_NONCE_LEN: usize = 12;

const RUNTIME_BACKUP_NONCE_LEN: usize = 32;

const RUNTIME_IMPORT_NONCE_LEN: usize = 12;

/// Remove a directory tree, retrying a bounded number of times.
///
/// Blocking and potentially very slow: a llama.cpp build tree is several GB
/// across hundreds of thousands of objects. It must only ever run on a
/// blocking thread, never on a Tokio runtime worker.
pub(super) fn remove_tree_bounded(directory: &Path) -> Result<(), String> {
    for attempt in 0..CLEANUP_ATTEMPTS {
        match fs::remove_dir_all(directory) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                if attempt + 1 == CLEANUP_ATTEMPTS {
                    return Err(format!("{}: {error}", directory.display()));
                }
                std::thread::sleep(CLEANUP_RETRY_DELAY);
            }
        }
    }
    Ok(())
}

/// The removals a finished or abandoned install leaves behind.
///
/// Separated from `InstallCleanup` so the work can be moved onto a blocking
/// thread and outlive the async task that scheduled it: a cancelled install
/// still has to delete its several-GB build tree.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub(super) struct CleanupPlan {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
}

impl CleanupPlan {
    fn is_empty(&self) -> bool {
        self.files.is_empty() && self.directories.is_empty()
    }

    /// Blocking. Best-effort: a file that cannot be removed is left for the
    /// next install of the same runtime to overwrite, never retried forever.
    pub(super) fn run(&self) {
        for file in &self.files {
            let _ = fs::remove_file(file);
        }
        for directory in &self.directories {
            let _ = remove_tree_bounded(directory);
        }
    }

    /// Run the plan without ever blocking a Tokio worker.
    ///
    /// Inside a runtime the work is handed to the blocking pool, which is what
    /// makes it safe from `Drop`: the returned handle is dropped immediately
    /// but the task keeps running, so a cancelled install still cleans up.
    fn spawn(self) {
        if self.is_empty() {
            return;
        }
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn_blocking(move || self.run());
            }
            // No runtime (tests, shutdown): nothing to protect, so do it here.
            Err(_) => self.run(),
        }
    }
}

pub(super) struct InstallCleanup {
    pub(super) archives: Vec<PathBuf>,
    pub(super) directories: Vec<PathBuf>,
    pub(super) staging: PathBuf,
    pub(super) committed: bool,
    /// Set once the plan has been handed off, so `Drop` does not repeat it.
    pub(super) settled: bool,
}

impl InstallCleanup {
    pub(super) fn new(archive: PathBuf, staging: PathBuf) -> Self {
        Self {
            archives: vec![archive],
            directories: Vec::new(),
            staging,
            committed: false,
            settled: false,
        }
    }

    /// Track an extra downloaded archive (e.g. the CUDA runtime sidecar) so it
    /// is removed on both the success and the failure path.
    pub(super) fn track_archive(&mut self, archive: PathBuf) {
        self.archives.push(archive);
    }

    pub(super) fn track_directory(&mut self, directory: PathBuf) {
        self.directories.push(directory);
    }

    pub(super) fn commit(&mut self) {
        self.committed = true;
    }

    pub(super) fn plan(&self) -> CleanupPlan {
        let mut directories = self.directories.clone();
        if !self.committed {
            directories.push(self.staging.clone());
        }
        CleanupPlan {
            files: self.archives.clone(),
            directories,
        }
    }

    /// Run the cleanup on a blocking thread and wait for it.
    ///
    /// The normal exit path: the caller is still on the install task, so it
    /// can afford to wait, and waiting means the next install of the same
    /// runtime does not race this one's removals.
    pub(super) async fn finish(mut self) {
        let plan = self.plan();
        self.settled = true;
        if plan.is_empty() {
            return;
        }
        let _ = tokio::task::spawn_blocking(move || plan.run()).await;
    }
}

impl Drop for InstallCleanup {
    /// The abandoned path - the install future was cancelled or unwound - so
    /// hand the work to the blocking pool and return immediately. Doing it
    /// inline here would stall a runtime worker for as long as it takes to
    /// delete a multi-GB build tree.
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.plan().spawn();
    }
}

fn valid_hex_nonce(value: &str, length: usize) -> bool {
    value.len() == length && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn valid_runtime_directory_stem(stem: &str) -> bool {
    let Some((build, backend)) = stem.split_once('-') else {
        return false;
    };
    validate_runtime_identifiers(backend, build).is_ok()
}

/// Exact allowlist for the source-build workspace names created by this file:
/// `.<12 hex>-pr<digits>-<backend>`. No glob or prefix-only deletion is used
/// here, so a user directory such as `.project-pr27342-cuda` is preserved.
pub(super) fn is_pr_download_workspace_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix('.') else {
        return false;
    };
    let Some((nonce, stem)) = name.split_once('-') else {
        return false;
    };
    if !valid_hex_nonce(nonce, PR_WORKSPACE_NONCE_LEN) {
        return false;
    }
    let Some((build, backend)) = stem.split_once('-') else {
        return false;
    };
    build.starts_with("pr")
        && SOURCE_BUILD_BACKENDS.contains(&backend)
        && valid_runtime_directory_stem(stem)
}

/// Exact allowlist for runtime staging and backup directories. The nonce for a
/// staging path is short; replacement backups retain the full UUID nonce.
pub(super) fn is_runtime_staging_or_backup_name(name: &str) -> bool {
    if let Some(nonce) = name.strip_prefix(".runtime-import-") {
        return valid_hex_nonce(nonce, RUNTIME_IMPORT_NONCE_LEN);
    }
    if let Some(nonce) = name.strip_prefix(".runtime-export-") {
        return valid_hex_nonce(nonce, RUNTIME_IMPORT_NONCE_LEN);
    }
    let Some(name) = name.strip_prefix('.') else {
        return false;
    };
    for (marker, nonce_len) in [
        (".staging-", PR_WORKSPACE_NONCE_LEN),
        (".backup-", RUNTIME_BACKUP_NONCE_LEN),
    ] {
        if let Some((stem, nonce)) = name.split_once(marker) {
            let backend = stem.split_once('-').map(|(_, backend)| backend);
            return valid_hex_nonce(nonce, nonce_len)
                && backend.is_some_and(|backend| CATALOG_BACKENDS.contains(&backend))
                && valid_runtime_directory_stem(stem);
        }
    }
    false
}

/// Exact allowlist for downloaded ZIPs. The asset basename was validated
/// before the download, so only a fresh 12-hex nonce and a safe ZIP basename
/// are needed here. User files in the downloads directory do not match.
pub(super) fn is_runtime_download_file_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix('.') else {
        return false;
    };
    let Some((nonce, asset)) = name.split_once('-') else {
        return false;
    };
    valid_hex_nonce(nonce, PR_WORKSPACE_NONCE_LEN) && validate_asset_file_name(asset).is_ok()
}

fn is_stale_directory(path: &Path, now: SystemTime) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|metadata| metadata.modified()) else {
        return false;
    };
    now.duration_since(modified)
        .map(|age| age >= ORPHAN_SWEEP_MAX_AGE)
        .unwrap_or(false)
}

pub(super) fn sweep_orphaned_work_in_with(
    download_root: &Path,
    runtime_root: &Path,
    now: SystemTime,
    remove_tree: fn(&Path) -> Result<(), String>,
) {
    let sweep = |root: &Path, matches: fn(&str) -> bool| {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            // Never follow or remove a symlink, even if its name matches.
            if !metadata.is_dir() || metadata.file_type().is_symlink() || !matches(&name) {
                continue;
            }
            if is_stale_directory(&path, now) {
                // Locked directories are expected on Windows (or when an old
                // compiler is still alive). Removal is best effort and must
                // never turn startup into a failure.
                let _ = remove_tree(&path);
            }
        }
    };
    let sweep_files = |root: &Path, matches: fn(&str) -> bool| {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() || !matches(&name) {
                continue;
            }
            if is_stale_directory(&path, now) {
                let _ = fs::remove_file(&path);
            }
        }
    };
    sweep_files(download_root, is_runtime_download_file_name);
    sweep(download_root, is_pr_download_workspace_name);
    sweep(runtime_root, is_runtime_staging_or_backup_name);
}

pub(super) fn sweep_orphaned_work_in(download_root: &Path, runtime_root: &Path, now: SystemTime) {
    sweep_orphaned_work_in_with(download_root, runtime_root, now, remove_tree_bounded);
}

/// Best-effort startup cleanup for work left by a crashed or force-closed
/// source build. All filesystem work runs on the blocking pool and failures
/// are intentionally ignored; managed runtimes and user directories are not
/// touched by the exact-name allowlists above.
pub fn sweep_orphaned_work() {
    let download_root = crate::home::aiolm_home().join("downloads");
    let runtime_root = runtimes_root();
    sweep_orphaned_work_in(&download_root, &runtime_root, SystemTime::now());
}
