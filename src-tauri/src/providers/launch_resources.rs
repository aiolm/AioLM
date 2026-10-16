//! A declared bridge may need a writable configuration copy. Its directory
//! belongs to the launch owner, never to the selected model or engine folder.
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

/// Held locked by the launch owner for the directory's whole unreleased life.
/// The OS releases the lock when that process ends, however it ends.
const OWNER_LOCK: &str = ".aiolm-launch.lock";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub directory_env: String,
}

impl Request {
    pub fn validate(&self) -> Result<(), String> {
        let name = self.directory_env.as_bytes();
        if self.version != 1
            || name.is_empty()
            || name.len() > 128
            || self
                .directory_env
                .to_ascii_uppercase()
                .starts_with("AIOLM_")
            || self
                .directory_env
                .to_ascii_uppercase()
                .starts_with("LLAMA_BOARD_")
            || !(name[0].is_ascii_alphabetic() || name[0] == b'_')
            || !name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
        {
            return Err("invalid launch resource version or directory environment name".into());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    version: u32,
    id: String,
    pid: Option<u32>,
}

fn root() -> PathBuf {
    crate::runtime::runtimes_root().join("launch-staging")
}

fn path(id: &str) -> Result<PathBuf, String> {
    path_in(&root(), id)
}

fn path_in(parent: &Path, id: &str) -> Result<PathBuf, String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "invalid launch resource identity")?;
    if parsed.to_string() != id {
        return Err("invalid launch resource identity".into());
    }
    if fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir()) {
        return Err("launch resource root must be an owned directory, not a link".into());
    }
    Ok(parent.join(id))
}

/// Removing persisted headless resources requires both the generated UUID
/// and the process identity recorded when that directory was created.
pub fn cleanup(id: &str, pid: u32) -> Result<(), String> {
    let Some(path) = owned_path_in(&root(), id, pid)? else {
        return Ok(());
    };
    remove_owned(&path).map_err(|e| e.to_string())
}

fn owned_path_in(parent: &Path, id: &str, pid: u32) -> Result<Option<PathBuf>, String> {
    let path = path_in(parent, id)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("launch resource directory is not owned".into());
    }
    let marker = read_marker(&path)?;
    if marker.version != 1 || marker.id != id || marker.pid.unwrap_or_default() != pid {
        return Err("launch resource ownership does not match the stopped process".into());
    }
    Ok(Some(path))
}

/// A stopped Windows process tree can still be releasing a native log handle.
/// Share the caller's existing shutdown deadline, and retry only the OS sharing
/// errors. Every attempt rechecks ownership; other failures retain the state.
pub async fn cleanup_stopped_until(
    id: &str,
    pid: u32,
    deadline: std::time::Instant,
) -> Result<(), String> {
    cleanup_stopped_in(&root(), id, pid, deadline).await
}

async fn cleanup_stopped_in(
    parent: &Path,
    id: &str,
    pid: u32,
    deadline: std::time::Instant,
) -> Result<(), String> {
    loop {
        let Some(path) = owned_path_in(parent, id, pid)? else {
            return Ok(());
        };
        match remove_owned(&path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                #[cfg(windows)]
                let sharing = matches!(error.raw_os_error(), Some(32 | 33));
                #[cfg(not(windows))]
                let sharing = false;
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if !sharing || remaining.is_zero() {
                    return Err(error.to_string());
                }
                tokio::time::sleep(remaining.min(std::time::Duration::from_millis(10))).await;
            }
        }
    }
}

fn read_marker(directory: &Path) -> Result<Marker, String> {
    let marker_path = directory.join(".aiolm-launch.json");
    let metadata = fs::symlink_metadata(&marker_path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("invalid launch resource ownership marker".into());
    }
    let bytes = fs::read(marker_path).map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("invalid launch resource ownership marker".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Remove an owned directory with its owner lock and record last. A file a
/// still-exiting process holds (an engine log) can fail the removal; the
/// directory then keeps the evidence a later cleanup or recovery requires.
fn remove_owned(directory: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".aiolm-launch.json" || name == OWNER_LOCK {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            // A link is removed itself, never its target.
            match fs::remove_file(&path) {
                Err(error) if entry.file_type()?.is_symlink() => {
                    // Windows directory links require RemoveDirectory. A
                    // regular file's sharing error must not be overwritten.
                    fs::remove_dir(&path).map_err(|_| error)?;
                }
                result => result?,
            }
        }
    }
    match fs::remove_file(directory.join(OWNER_LOCK)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    fs::remove_file(directory.join(".aiolm-launch.json"))?;
    fs::remove_dir(directory)
}

/// Neither a link nor (on Windows) any other reparse point such as a junction.
fn plain(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false; // FILE_ATTRIBUTE_REPARSE_POINT
        }
    }
    !metadata.file_type().is_symlink()
}

/// Whether `pid` may still name a running process. Only an OS answer that no
/// such process exists counts as absent; a reused PID merely keeps staging.
fn process_present(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
        }
        let exited = unsafe { WaitForSingleObject(handle, 0) } == 0;
        unsafe { CloseHandle(handle) };
        !exited
    }
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return true;
        };
        (unsafe { libc::kill(pid, 0) } == 0)
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(not(any(windows, unix)))]
    true
}

/// Remove staging that an interrupted owner left behind: for example a CLI
/// terminated before readiness, whose destructors never ran. Every launch
/// preparation (desktop or headless, any engine) runs this first, so that
/// launch is the recovery boundary. A directory is removed only when all of
/// these hold: its name is a canonical UUID; it and its owner lock are plain
/// entries, not links or reparse points; its owner record names that UUID;
/// the owner lock can be acquired, so the creating process no longer holds
/// it; and the recorded launched process, if any, is absent. Live or
/// released launches, other tools' data and anything unverifiable remain.
fn recover() {
    recover_in(&root());
}

fn recover_in(root: &Path) {
    if !fs::symlink_metadata(root).is_ok_and(|metadata| plain(&metadata) && metadata.is_dir()) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        reclaim(&entry.path());
    }
}

fn reclaim(directory: &Path) -> Option<()> {
    let id = directory.file_name()?.to_str()?;
    if uuid::Uuid::parse_str(id).ok()?.to_string() != id {
        return None;
    }
    let metadata = fs::symlink_metadata(directory).ok()?;
    if !plain(&metadata) || !metadata.is_dir() {
        return None;
    }
    let marker = read_marker(directory).ok()?;
    if marker.version != 1 || marker.id != id {
        return None;
    }
    let lock_path = directory.join(OWNER_LOCK);
    let metadata = fs::symlink_metadata(&lock_path).ok()?;
    if !plain(&metadata) || !metadata.is_file() {
        return None;
    }
    let lock = fs::OpenOptions::new().write(true).open(&lock_path).ok()?;
    lock.try_lock().ok()?;
    if marker.pid.is_some_and(process_present) {
        return None;
    }
    // No owner can return: a new launch never reuses an existing UUID.
    drop(lock);
    remove_owned(directory).ok()
}

pub struct Directory {
    id: String,
    pid: u32,
    keep: bool,
    lock: Option<fs::File>,
}

impl Directory {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn bind(&mut self, pid: u32) -> Result<(), String> {
        let marker = Marker {
            version: 1,
            id: self.id.clone(),
            pid: Some(pid),
        };
        crate::config::atomic_write(
            &path(&self.id)?.join(".aiolm-launch.json"),
            &serde_json::to_vec(&marker).map_err(|e| e.to_string())?,
        )?;
        self.pid = pid;
        Ok(())
    }

    /// Headless ownership has been recorded in its state before release.
    /// Without its owner lock, recovery never treats it as interrupted; the
    /// state file's stop removes it.
    pub fn release(mut self) {
        self.keep = true;
        if let Ok(directory) = path(&self.id) {
            let _ = fs::remove_file(directory.join(OWNER_LOCK));
        }
        self.lock.take();
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        self.lock.take();
        if !self.keep {
            let _ = cleanup(&self.id, self.pid);
        }
    }
}

pub fn prepare(
    request: Option<Request>,
    env: &mut Vec<(OsString, OsString)>,
) -> Result<Option<Directory>, String> {
    recover();
    let Some(request) = request else {
        return Ok(None);
    };
    request.validate()?;
    if env.iter().any(|(name, _)| {
        name.to_string_lossy()
            .eq_ignore_ascii_case(&request.directory_env)
    }) {
        return Err("launch resource variable conflicts with an existing environment entry".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let directory = path(&id)?;
    fs::create_dir_all(directory.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    // Lock before the owner record exists, so recovery never sees a record
    // whose owner has not yet locked it.
    let lock = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(OWNER_LOCK))
        .and_then(|lock| lock.try_lock().map(|()| lock).map_err(std::io::Error::from))
    {
        Ok(lock) => lock,
        Err(error) => {
            let _ = fs::remove_dir_all(&directory);
            return Err(error.to_string());
        }
    };
    let marker = Marker {
        version: 1,
        id: id.clone(),
        pid: None,
    };
    if let Err(error) = crate::config::atomic_write(
        &directory.join(".aiolm-launch.json"),
        &serde_json::to_vec(&marker).map_err(|e| e.to_string())?,
    ) {
        // This exact UUID directory was just created here and has not been
        // handed to a child. A failed marker write must not leave staging.
        drop(lock);
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    let guard = Directory {
        id,
        pid: 0,
        keep: false,
        lock: Some(lock),
    };
    env.push((request.directory_env.into(), directory.into_os_string()));
    Ok(Some(guard))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A staging entry as `prepare` lays it out, with its lock held or not.
    fn staged(root: &Path, pid: Option<u32>, held: bool) -> (PathBuf, Option<fs::File>) {
        let id = uuid::Uuid::new_v4().to_string();
        let directory = root.join(&id);
        fs::create_dir(&directory).unwrap();
        let lock = fs::File::create(directory.join(OWNER_LOCK)).unwrap();
        let marker = Marker {
            version: 1,
            id,
            pid,
        };
        fs::write(
            directory.join(".aiolm-launch.json"),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        fs::write(directory.join("effective-config.json"), b"synthetic").unwrap();
        let lock = held.then(|| {
            lock.try_lock().unwrap();
            lock
        });
        (directory, lock)
    }

    #[test]
    fn recovery_reclaims_only_staging_whose_owner_and_process_are_gone() {
        let root = std::env::temp_dir().join(format!("aiolm-staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let (live, live_lock) = staged(&root, None, true);
        let (unbound, _) = staged(&root, None, false);
        // The recorded launched process is this test, so it is present.
        let (running, _) = staged(&root, Some(std::process::id()), false);
        let (released, _) = staged(&root, None, false);
        fs::remove_file(released.join(OWNER_LOCK)).unwrap();
        let (renamed, _) = staged(&root, None, false);
        let other = root.join(uuid::Uuid::new_v4().to_string());
        fs::rename(&renamed, &other).unwrap(); // record names another UUID
        let named = root.join("not-a-launch");
        fs::create_dir(&named).unwrap();
        fs::write(named.join(OWNER_LOCK), b"").unwrap();

        recover_in(&root);
        assert!(!unbound.exists(), "an unlocked unbound directory remains");
        for kept in [&live, &running, &released, &other, &named] {
            assert!(kept.is_dir(), "{} was removed", kept.display());
        }

        // The same live directory is reclaimed once its owner lets go.
        drop(live_lock);
        recover_in(&root);
        assert!(!live.exists());
        assert!(running.is_dir());
        fs::remove_dir_all(&root).unwrap();
    }

    /// A file another process still holds (a dying engine's log) can fail a
    /// removal. The owner record and lock must outlast every other entry so
    /// a later recovery can still prove ownership and finish the removal.
    #[cfg(windows)]
    #[test]
    fn a_failed_removal_keeps_the_owner_record_for_a_later_recovery() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!("aiolm-staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let (directory, _) = staged(&root, None, false);
        let held = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .share_mode(0x1) // FILE_SHARE_READ: deletion is refused
            .open(directory.join("engine.log"))
            .unwrap();
        recover_in(&root);
        for name in [".aiolm-launch.json", OWNER_LOCK, "engine.log"] {
            assert!(directory.join(name).is_file(), "{name} was removed");
        }
        drop(held);
        recover_in(&root);
        assert!(!directory.exists());
        fs::remove_dir_all(&root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_log_reports_the_original_sharing_error_and_keeps_ownership() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!("aiolm-staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let (directory, _) = staged(&root, None, false);
        let held = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .share_mode(0x1) // FILE_SHARE_READ, without FILE_SHARE_DELETE
            .open(directory.join("engine.log"))
            .unwrap();
        let error = remove_owned(&directory).unwrap_err();
        let ownership_retained = directory.join(".aiolm-launch.json").is_file();
        drop(held);
        remove_owned(&directory).unwrap();
        fs::remove_dir(&root).unwrap();
        assert!(ownership_retained);
        assert_eq!(error.raw_os_error(), Some(32), "retain ERROR_SHARING_VIOLATION instead of trying to remove a regular file as a directory");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stopped_cleanup_waits_for_a_closing_log_and_rechecks_ownership() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::time::{Duration, Instant};
        let root = std::env::temp_dir().join(format!("aiolm-staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let (directory, _) = staged(&root, Some(17), false);
        let id = directory.file_name().unwrap().to_str().unwrap();
        let held = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .share_mode(0x1)
            .open(directory.join("engine.log"))
            .unwrap();
        let wrong_owner =
            cleanup_stopped_in(&root, id, 18, Instant::now() + Duration::from_secs(1))
                .await
                .unwrap_err();
        assert!(wrong_owner.contains("ownership"));
        let blocked = cleanup_stopped_in(&root, id, 17, Instant::now())
            .await
            .unwrap_err();
        assert!(blocked.contains("32"));
        assert!(directory.join(".aiolm-launch.json").is_file());
        let closing = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            drop(held);
        });
        let result =
            cleanup_stopped_in(&root, id, 17, Instant::now() + Duration::from_secs(1)).await;
        closing.join().unwrap();
        let removed = !directory.exists();
        if directory.exists() {
            remove_owned(&directory).unwrap();
        }
        fs::remove_dir(&root).unwrap();
        result.unwrap();
        assert!(removed);
    }
}
