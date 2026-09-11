//! AioLM identity and a non-destructive, restartable first-run migration.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn env_var(key: &str) -> Result<String, std::env::VarError> {
    match std::env::var(key) {
        Err(std::env::VarError::NotPresent) if key.starts_with("AIOLM_") => {
            std::env::var(key.replacen("AIOLM_", "LLAMA_BOARD_", 1))
        }
        result => result,
    }
}

#[derive(Clone, serde::Serialize)]
pub struct MigratedPath {
    pub from: String,
    pub to: String,
}

pub fn managed_paths() -> Vec<MigratedPath> {
    let mut roots = vec![crate::config::config_path().parent().unwrap().to_path_buf()];
    let runtime = crate::runtime::runtimes_root()
        .parent()
        .unwrap()
        .to_path_buf();
    if !roots.contains(&runtime) {
        roots.push(runtime);
    }
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("aiolm"));
    }
    roots
        .into_iter()
        .map(|to| MigratedPath {
            from: to
                .with_file_name("llama-board")
                .to_string_lossy()
                .into_owned(),
            to: to.to_string_lossy().into_owned(),
        })
        .collect()
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn skip(name: &str) -> bool {
    matches!(
        name,
        "LOCK"
            | "SingletonLock"
            | "SingletonCookie"
            | "SingletonSocket"
            | "headless-state.json"
            | "headless-command.lock"
            | "downloads"
            | "Cache"
            | "Code Cache"
            | "GPUCache"
            | "Crashpad"
    ) || name.ends_with(".lock")
        || name.ends_with(".pid")
        || name.ends_with(".part")
        || name.starts_with(".staging")
        || name.starts_with(".backup")
}

// The OS releases this lock on termination. A leftover file is harmless, so a
// crashed GUI/CLI never requires deleting a lock by guessing whether its PID lives.
fn migration_lock(target: &Path) -> Result<File, String> {
    let parent = target
        .parent()
        .ok_or("Missing migration destination parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let path = parent.join(format!(
        ".{}.migration.lock",
        target.file_name().unwrap().to_string_lossy()
    ));
    if path.exists() && is_link(&fs::symlink_metadata(&path).map_err(|e| e.to_string())?) {
        return Err("Migration lock path is a link".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.try_lock().map_err(|e| {
        format!("Another AioLM migration is running. Close that instance and retry: {e}")
    })?;
    Ok(file)
}

fn check_tree_links(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if is_link(&metadata) {
        return Err(format!(
            "Migration staging path is a link: {}",
            root.display()
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
            check_tree_links(&entry.map_err(|e| e.to_string())?.path())?;
        }
    }
    Ok(())
}

// Hold LevelDB lock files throughout the copy. Skipping their bytes alone would
// allow the old WebView to modify a database while its files were being copied.
fn lock_profile(root: &Path, locks: &mut Vec<File>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if is_link(&metadata) {
            return Err(format!("Linked profile path: {}", entry.path().display()));
        }
        if metadata.is_dir() {
            lock_profile(&entry.path(), locks)?;
        } else if entry.file_name() == "LOCK" {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(0);
            }
            locks.push(options.open(entry.path()).map_err(|e| {
                format!("Close the previous application and retry. Profile is locked: {e}")
            })?);
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|e| format!("{}: {e}", source.display()))?;
    if is_link(&metadata) {
        return Err(format!(
            "Cannot migrate a linked path: {}",
            source.display()
        ));
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if skip(&name.to_string_lossy()) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if is_link(&metadata) {
            return Err(format!(
                "Cannot migrate a linked path: {}",
                entry.path().display()
            ));
        }
        let destination = target.join(&name);
        if metadata.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if metadata.is_file() {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(0);
            }
            let mut input = options.open(entry.path()).map_err(|e| {
                format!(
                    "Close the previous application and retry. {}: {e}",
                    entry.path().display()
                )
            })?;
            let mut output = File::create(&destination).map_err(|e| e.to_string())?;
            let bytes = std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            if bytes != metadata.len() {
                return Err(format!(
                    "Source changed while copying: {}",
                    entry.path().display()
                ));
            }
        }
    }
    Ok(())
}

fn rewrite_value(value: &mut serde_json::Value, paths: &[MigratedPath]) {
    match value {
        serde_json::Value::String(text) => {
            for mapping in paths {
                let old = mapping.from.replace('\\', "/");
                let normalized = text.replace('\\', "/");
                if normalized.eq_ignore_ascii_case(&old)
                    || normalized
                        .to_lowercase()
                        .starts_with(&(old.to_lowercase() + "/"))
                {
                    *text = mapping.to.replace('\\', "/") + &normalized[old.len()..];
                    break;
                }
            }
        }
        serde_json::Value::Array(values) => values.iter_mut().for_each(|v| rewrite_value(v, paths)),
        serde_json::Value::Object(values) => {
            values.values_mut().for_each(|v| rewrite_value(v, paths))
        }
        _ => (),
    }
}

fn rewrite_managed_json(root: &Path, paths: &[MigratedPath]) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            rewrite_managed_json(&entry.path(), paths)?;
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // App-owned JSON only. Model metadata and third-party runtime files are opaque.
        if !matches!(
            name.as_str(),
            "config.json"
                | "mcp-servers.json"
                | "llama-board-runtime.json"
                | "llama-board-runtime-source.json"
                | "llama-board-runtime-bundle.json"
        ) {
            continue;
        }
        let mut raw = String::new();
        File::open(entry.path())
            .map_err(|e| e.to_string())?
            .read_to_string(&mut raw)
            .map_err(|e| e.to_string())?;
        let mut value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid previous data {}: {e}", entry.path().display()))?;
        rewrite_value(&mut value, paths);
        let destination = root.join(name.replace("llama-board-runtime", "aiolm-runtime"));
        File::create(&destination)
            .and_then(|mut f| {
                f.write_all(serde_json::to_string_pretty(&value).unwrap().as_bytes())?;
                f.sync_all()
            })
            .map_err(|e| e.to_string())?;
        if destination != entry.path() {
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copy into a sibling staging directory; destination existence is the commit record.
/// Original files are never renamed, deleted or used as writable fallbacks.
pub fn copy_root(
    source: &Path,
    target: &Path,
    paths: &[MigratedPath],
    managed: bool,
) -> Result<(), String> {
    if target.try_exists().map_err(|e| e.to_string())?
        || !source.try_exists().map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let _lock = migration_lock(target)?;
    if target.exists() {
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or("Missing migration destination parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stage = parent.join(format!(
        ".{}.migration-v1",
        target.file_name().unwrap().to_string_lossy()
    ));
    if stage.exists() {
        check_tree_links(&stage)?;
        fs::remove_dir_all(&stage).map_err(|e| e.to_string())?;
    }
    let mut profile_locks = Vec::new();
    if !managed {
        lock_profile(source, &mut profile_locks)?;
    }
    copy_tree(source, &stage)?;
    if managed {
        rewrite_managed_json(&stage, paths)?;
    }
    fs::rename(stage, target).map_err(|e| e.to_string())
}

pub fn prepare_managed_data() -> Result<(), String> {
    let paths = managed_paths();
    for mapping in &paths {
        copy_root(
            Path::new(&mapping.from),
            Path::new(&mapping.to),
            &paths,
            true,
        )?;
    }
    Ok(())
}

pub fn prepare_desktop() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
        let local = PathBuf::from(local);
        let source = local.join("com.llamaboard.desktop").join("EBWebView");
        let target = local.join("com.aiolm.desktop").join("EBWebView");
        let pending = (source.exists() && !target.exists())
            || managed_paths()
                .iter()
                .any(|p| Path::new(&p.from).exists() && !Path::new(&p.to).exists());
        if pending {
            let output = std::process::Command::new("tasklist.exe")
                .args(["/FI", "IMAGENAME eq llama-board.exe", "/FO", "CSV", "/NH"])
                .creation_flags(0x08000000)
                .output()
                .map_err(|e| e.to_string())?;
            if String::from_utf8_lossy(&output.stdout)
                .to_lowercase()
                .contains("\"llama-board.exe\"")
            {
                return Err(
                    "Close the previous application before importing its data into AioLM.".into(),
                );
            }
        }
        copy_root(&source, &target, &[], false)?;
    }
    prepare_managed_data()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!("aiolm-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn copy_preserves_original_rewrites_owned_paths_and_omits_live_state() {
        let root = fixture();
        let old = root.join("llama-board");
        let new = root.join("aiolm");
        fs::create_dir_all(&old).unwrap();
        let raw =
            serde_json::json!({"models_dir":old.join("models"),"external":"C:/models/custom.gguf"})
                .to_string();
        fs::write(old.join("config.json"), &raw).unwrap();
        fs::write(old.join("headless-state.json"), "pid").unwrap();
        let mapping = vec![MigratedPath {
            from: old.to_string_lossy().into_owned(),
            to: new.to_string_lossy().into_owned(),
        }];
        copy_root(&old, &new, &mapping, true).unwrap();
        assert_eq!(fs::read_to_string(old.join("config.json")).unwrap(), raw);
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(new.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved["external"], "C:/models/custom.gguf");
        assert!(saved["models_dir"]
            .as_str()
            .unwrap()
            .contains("aiolm/models"));
        assert!(!new.join("headless-state.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn existing_data_wins_and_repeated_startup_is_idempotent() {
        let root = fixture();
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("value"), "old").unwrap();
        copy_root(&old, &new, &[], false).unwrap();
        fs::write(new.join("value"), "new").unwrap();
        copy_root(&old, &new, &[], false).unwrap();
        assert_eq!(fs::read_to_string(new.join("value")).unwrap(), "new");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_json_does_not_commit_and_can_retry() {
        let root = fixture();
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("config.json"), "invalid").unwrap();
        assert!(copy_root(&old, &new, &[], true).is_err());
        assert!(!new.exists());
        fs::write(old.join("config.json"), "{}").unwrap();
        copy_root(&old, &new, &[], true).unwrap();
        assert!(new.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn new_install_does_not_create_default_data_during_migration() {
        let root = fixture();
        copy_root(&root.join("old"), &root.join("new"), &[], true).unwrap();
        assert!(!root.join("new").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_migration_waits_and_resumes_after_lock_owner_exits() {
        let root = fixture();
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("file"), "data").unwrap();
        let lock = migration_lock(&new).unwrap();
        assert!(copy_root(&old, &new, &[], true).is_err());
        assert!(!new.exists());
        drop(lock);
        copy_root(&old, &new, &[], true).unwrap();
        assert_eq!(fs::read(new.join("file")).unwrap(), b"data");
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_profile_is_preserved_and_can_be_retried() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = fixture();
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("LOCK"), "").unwrap();
        fs::write(old.join("data"), "conversation").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(old.join("LOCK"))
            .unwrap();
        assert!(copy_root(&old, &new, &[], false).is_err());
        assert!(!new.exists());
        assert!(old.join("data").exists());
        drop(lock);
        copy_root(&old, &new, &[], false).unwrap();
        assert!(!new.join("LOCK").exists());
        assert_eq!(fs::read(new.join("data")).unwrap(), b"conversation");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_staging_is_rebuilt_before_commit() {
        let root = fixture();
        let old = root.join("old");
        let new = root.join("new");
        let stage = root.join(".new.migration-v1");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("data"), "complete").unwrap();
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("data"), "partial").unwrap();
        copy_root(&old, &new, &[], false).unwrap();
        assert_eq!(fs::read(new.join("data")).unwrap(), b"complete");
        assert!(!stage.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn environment_alias_prefers_new_even_when_empty() {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let new = format!("AIOLM_TEST_{suffix}");
        let old = format!("LLAMA_BOARD_TEST_{suffix}");
        std::env::set_var(&old, "legacy");
        assert_eq!(env_var(&new).unwrap(), "legacy");
        std::env::set_var(&new, "");
        assert_eq!(env_var(&new).unwrap(), "");
        std::env::remove_var(new);
        std::env::remove_var(old);
    }
}
