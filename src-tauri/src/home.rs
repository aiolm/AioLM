//! The one folder that holds AioLM's data, and the startup move into it.
//!
//! Everything the application stores lives under `AIOLM_HOME` when it is set,
//! otherwise under `.aiolm` in the user's home folder. Earlier releases spread
//! the same data over the operating system's application folders;
//! `prepare_home` brings it together once, before anything reads it.
use crate::branding;
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const MCP_FILE: &str = "mcp-servers.json";
/// Tauri identifier whose application folders earlier releases used.
const APP_IDENTIFIER: &str = "com.aiolm.desktop";
/// Tauri identifier of the application AioLM replaced.
const REPLACED_APP_IDENTIFIER: &str = "com.llamaboard.desktop";

/// The data folder, or why there is no usable one. Startup checks this before
/// any data is read or written (`prepare_home`), so a relative `AIOLM_HOME` or a
/// missing home folder stops the application instead of scattering files into
/// whatever directory it was started from.
pub fn resolve_aiolm_home() -> Result<PathBuf, String> {
    resolve(std::env::var_os("AIOLM_HOME"), std::env::home_dir())
}

fn resolve(configured: Option<OsString>, home: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(configured) = configured.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(configured);
        return if path.is_absolute() {
            Ok(path)
        } else {
            Err(format!(
                "AIOLM_HOME must be an absolute path, not {}.",
                path.display()
            ))
        };
    }
    home.filter(|home| home.is_absolute())
        .map(|home| home.join(".aiolm"))
        .ok_or_else(|| {
            "The home folder could not be determined. Set AIOLM_HOME to an absolute path."
                .to_string()
        })
}

/// The folder that holds everything AioLM stores.
pub fn aiolm_home() -> PathBuf {
    // The application never reaches the fallback: startup has already refused
    // to continue when the folder cannot be resolved.
    resolve_aiolm_home().unwrap_or_else(|_| PathBuf::from(".aiolm"))
}

/// Folders earlier releases kept this data in. They are only read to import
/// it: by `prepare_home`, and by the import of the replaced application's data
/// (`branding::managed_paths`), which still lands in them first.
pub(crate) struct PreviousLayout {
    /// `config.json`: `%APPDATA%\aiolm` on Windows.
    pub(crate) config: PathBuf,
    /// Runtimes and verification records: `%APPDATA%\aiolm` on Windows.
    pub(crate) data: PathBuf,
    /// CLI state: `%LOCALAPPDATA%\aiolm`, on Windows only.
    pub(crate) local: Option<PathBuf>,
    /// Tauri's configuration folder, which held the MCP servers.
    app_config: PathBuf,
    /// Tauri's data folder, which held the benchmark records.
    app_data: PathBuf,
    /// Tauri's configuration folder of the replaced application.
    replaced_app_config: PathBuf,
}

impl PreviousLayout {
    pub(crate) fn current() -> Option<Self> {
        let env = |key: &str| {
            std::env::var_os(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        #[cfg(windows)]
        let (config, data) = {
            let roaming = env("APPDATA")?;
            (roaming.clone(), roaming)
        };
        #[cfg(target_os = "macos")]
        let (config, data) = {
            let support = env("HOME")?.join("Library").join("Application Support");
            (support.clone(), support)
        };
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let (config, data) = {
            let home = env("HOME");
            (
                env("XDG_CONFIG_HOME")
                    .or_else(|| home.as_ref().map(|home| home.join(".config")))?,
                env("XDG_DATA_HOME")
                    .or_else(|| home.map(|home| home.join(".local").join("share")))?,
            )
        };
        #[cfg(windows)]
        let local = env("LOCALAPPDATA");
        #[cfg(not(windows))]
        let local = None;
        Some(Self::under(&config, &data, local))
    }

    pub(crate) fn under(config: &Path, data: &Path, local: Option<PathBuf>) -> Self {
        Self {
            config: config.join("aiolm"),
            data: data.join("aiolm"),
            local: local.map(|local| local.join("aiolm")),
            app_config: config.join(APP_IDENTIFIER),
            app_data: data.join(APP_IDENTIFIER),
            replaced_app_config: config.join(REPLACED_APP_IDENTIFIER),
        }
    }
}

enum Transfer {
    Copy,
    Move,
}

/// Bring the data earlier releases kept in the operating system's application
/// folders into `aiolm_home`.
///
/// Each item is complete once its destination exists, and a destination that
/// already exists wins: it is never merged or replaced. Configuration, MCP
/// servers, verification records and benchmarks are copied, leaving the
/// originals for an older release. Runtimes can take gigabytes, so they are
/// moved: a rename keeps every file's modification time, which verification
/// records are keyed by. Models are never moved, not even a model folder that
/// sits inside an earlier data folder.
pub fn prepare_home() -> Result<(), String> {
    let home = resolve_aiolm_home()?;
    create_home(&home)?;
    match PreviousLayout::current() {
        Some(previous) => migrate(&home, &previous),
        None => Ok(()),
    }
}

fn create_home(home: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    // Everything AioLM stores lives here; on a shared Unix machine it stays
    // private to the user.
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(home)
        .map_err(|error| format!("cannot create {}: {error}", home.display()))
}

fn migrate(home: &Path, previous: &PreviousLayout) -> Result<(), String> {
    let config = previous.config.join("config.json");
    if !home.join("config.json").exists() && !config.exists() {
        // A release that saved through backups could leave only a backup behind.
        crate::config::recover_legacy_backup(&config)?;
    }
    // The import of the replaced application copied its data folders but not
    // its Tauri folder, so its MCP servers are brought over from there.
    let mcp = [
        previous.app_config.join(MCP_FILE),
        previous.replaced_app_config.join(MCP_FILE),
    ]
    .into_iter()
    .find(|path| path.exists())
    .unwrap_or_else(|| previous.app_config.join(MCP_FILE));
    let items = [
        (config, home.join("config.json"), Transfer::Copy),
        (mcp, home.join(MCP_FILE), Transfer::Copy),
        (
            previous.data.join("verification.json"),
            home.join("verification.json"),
            Transfer::Copy,
        ),
        (
            previous.data.join("verification"),
            home.join("verification"),
            Transfer::Copy,
        ),
        (
            previous.app_data.join("benchmarks"),
            home.join("benchmarks"),
            Transfer::Copy,
        ),
        (
            previous.data.join("runtimes"),
            home.join("runtimes"),
            Transfer::Move,
        ),
    ];
    let mut any_pending = false;
    for (source, target, _) in &items {
        any_pending |= pending(source, target)?;
    }
    if !any_pending {
        return Ok(());
    }
    // The desktop app and the CLI can both start first after an upgrade.
    let _lock = branding::lock_file(&home.join(".migration.lock"))?;
    for (source, target, transfer) in &items {
        if !pending(source, target)? {
            continue;
        }
        match transfer {
            Transfer::Copy => copy(source, target)?,
            Transfer::Move => move_dir(source, target)?,
        }
    }
    Ok(())
}

fn pending(source: &Path, target: &Path) -> Result<bool, String> {
    let exists = |path: &Path| {
        path.try_exists()
            .map_err(|error| format!("{}: {error}", path.display()))
    };
    Ok(exists(source)? && !exists(target)?)
}

/// Copy through a sibling staging name, so a destination that exists is
/// always complete. Links are refused, as in the first import, and copied
/// files keep their modification times.
fn copy(source: &Path, target: &Path) -> Result<(), String> {
    let stage = stage_for(target)?;
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("{}: {error}", source.display()))?;
    if metadata.is_dir() {
        branding::copy_tree(source, &stage)?;
    } else if branding::is_link(&metadata) {
        return Err(format!(
            "Cannot migrate a linked path: {}",
            source.display()
        ));
    } else {
        fs::copy(source, &stage).map_err(|error| format!("{}: {error}", source.display()))?;
    }
    fs::rename(&stage, target).map_err(|error| format!("{}: {error}", target.display()))
}

fn stage_for(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or("Missing migration destination parent")?;
    let name = target
        .file_name()
        .ok_or("Missing migration destination name")?;
    let stage = parent.join(format!(".{}.migration-v1", name.to_string_lossy()));
    // An interrupted attempt is rebuilt from the original.
    match fs::symlink_metadata(&stage) {
        Ok(metadata) => {
            branding::check_tree_links(&stage)?;
            if metadata.is_dir() {
                fs::remove_dir_all(&stage)
            } else {
                fs::remove_file(&stage)
            }
            .map_err(|error| format!("{}: {error}", stage.display()))?;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("{}: {error}", stage.display())),
    }
    Ok(stage)
}

fn move_dir(source: &Path, target: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("{}: {error}", source.display()))?;
    if branding::is_link(&metadata) {
        return Err(format!(
            "Cannot migrate a linked path: {}",
            source.display()
        ));
    }
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        // A folder on another volume cannot be renamed into place. The copy
        // keeps modification times, so verification records still apply.
        Err(error) if error.kind() == ErrorKind::CrossesDevices => {
            copy(source, target)?;
            // The copy is committed; removing the original is what the rename
            // would have done, and a failure only leaves disk space behind.
            let _ = fs::remove_dir_all(source);
            Ok(())
        }
        Err(error) => Err(format!(
            "Cannot move {} to {}: {error}. Stop AioLM servers started from it, \
             including one started with `aiolm-cli server start`, and retry.",
            source.display(),
            target.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("aiolm-home-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn layout(root: &Path) -> PreviousLayout {
        PreviousLayout::under(
            &root.join("Roaming"),
            &root.join("Roaming"),
            Some(root.join("Local")),
        )
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn modified(path: &Path) -> SystemTime {
        fs::metadata(path).unwrap().modified().unwrap()
    }

    #[test]
    fn the_home_is_aiolm_home_when_set_and_otherwise_inside_the_user_home() {
        let home = std::env::temp_dir().join("user");
        let configured = std::env::temp_dir().join("elsewhere");
        assert_eq!(
            resolve(None, Some(home.clone())).unwrap(),
            home.join(".aiolm")
        );
        assert_eq!(
            resolve(Some(OsString::new()), Some(home.clone())).unwrap(),
            home.join(".aiolm")
        );
        assert_eq!(
            resolve(Some(configured.clone().into_os_string()), Some(home)).unwrap(),
            configured
        );
    }

    #[test]
    fn an_unusable_home_is_an_error_instead_of_the_working_directory() {
        let home = std::env::temp_dir().join("user");
        assert!(resolve(Some(OsString::from("relative")), Some(home)).is_err());
        assert!(resolve(None, None).is_err());
        assert!(resolve(None, Some(PathBuf::from("relative"))).is_err());
    }

    #[test]
    fn previous_folders_are_the_ones_earlier_releases_used() {
        let root = std::env::temp_dir();
        let previous = layout(&root);
        assert_eq!(previous.config, root.join("Roaming").join("aiolm"));
        assert_eq!(previous.data, root.join("Roaming").join("aiolm"));
        assert_eq!(previous.local, Some(root.join("Local").join("aiolm")));
        assert_eq!(
            previous.app_config,
            root.join("Roaming").join("com.aiolm.desktop")
        );
        assert_eq!(
            previous.replaced_app_config,
            root.join("Roaming").join("com.llamaboard.desktop")
        );
    }

    #[test]
    fn earlier_data_is_brought_together_and_runtimes_are_moved() {
        let root = fixture();
        let previous = layout(&root);
        let home = root.join("home").join(".aiolm");
        write(&previous.config.join("config.json"), "{\"port\":8080}");
        write(&previous.app_config.join(MCP_FILE), "[]");
        write(&previous.data.join("verification.json"), "{}");
        write(
            &previous.data.join("verification").join("probe.txt"),
            "probe",
        );
        write(
            &previous.app_data.join("benchmarks").join("run.jsonl"),
            "{}",
        );
        let runtime = previous.data.join("runtimes").join("b1-cpu");
        write(&runtime.join("llama-server.exe"), "binary");
        write(&previous.data.join("models").join("model.gguf"), "weights");
        let before = modified(&runtime.join("llama-server.exe"));

        create_home(&home).unwrap();
        migrate(&home, &previous).unwrap();

        assert_eq!(
            fs::read_to_string(home.join("config.json")).unwrap(),
            "{\"port\":8080}"
        );
        assert!(home.join(MCP_FILE).is_file());
        assert!(home.join("verification.json").is_file());
        assert!(home.join("verification").join("probe.txt").is_file());
        assert!(home.join("benchmarks").join("run.jsonl").is_file());
        let moved = home
            .join("runtimes")
            .join("b1-cpu")
            .join("llama-server.exe");
        assert_eq!(fs::read_to_string(&moved).unwrap(), "binary");
        // Verification records are keyed by runtime file modification times.
        assert_eq!(modified(&moved), before);
        assert!(!previous.data.join("runtimes").exists());
        // Copies keep their originals for an older release; models stay put.
        assert!(previous.config.join("config.json").is_file());
        assert!(previous.app_data.join("benchmarks").is_dir());
        assert!(previous.data.join("models").join("model.gguf").is_file());
        assert!(!home.join("models").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_data_wins_and_repeated_startup_changes_nothing() {
        let root = fixture();
        let previous = layout(&root);
        let home = root.join(".aiolm");
        write(&previous.config.join("config.json"), "old");
        write(
            &previous
                .data
                .join("runtimes")
                .join("b1-cpu")
                .join("llama-server.exe"),
            "old",
        );
        write(&home.join("config.json"), "new");
        write(
            &home
                .join("runtimes")
                .join("b2-cpu")
                .join("llama-server.exe"),
            "new",
        );

        migrate(&home, &previous).unwrap();
        migrate(&home, &previous).unwrap();

        assert_eq!(fs::read_to_string(home.join("config.json")).unwrap(), "new");
        assert!(!home.join("runtimes").join("b1-cpu").exists());
        assert!(previous.data.join("runtimes").join("b1-cpu").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_fresh_installation_leaves_no_migration_files() {
        let root = fixture();
        let home = root.join(".aiolm");
        create_home(&home).unwrap();
        migrate(&home, &layout(&root)).unwrap();
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mcp_servers_of_the_replaced_application_are_used_only_when_aiolm_has_none() {
        let root = fixture();
        let previous = layout(&root);
        write(&previous.replaced_app_config.join(MCP_FILE), "replaced");

        let first = root.join("first");
        migrate(&first, &previous).unwrap();
        assert_eq!(
            fs::read_to_string(first.join(MCP_FILE)).unwrap(),
            "replaced"
        );

        write(&previous.app_config.join(MCP_FILE), "aiolm");
        let second = root.join("second");
        migrate(&second, &previous).unwrap();
        assert_eq!(fs::read_to_string(second.join(MCP_FILE)).unwrap(), "aiolm");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_configuration_left_only_as_a_backup_is_recovered_first() {
        let root = fixture();
        let previous = layout(&root);
        let home = root.join(".aiolm");
        write(
            &previous.config.join(".config.json.backup-1"),
            "{\"port\":9000}",
        );
        migrate(&home, &previous).unwrap();
        assert_eq!(
            fs::read_to_string(home.join("config.json")).unwrap(),
            "{\"port\":9000}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_copied_runtime_keeps_modification_times() {
        // The fallback when runtimes cannot be renamed onto another volume.
        let root = fixture();
        let source = root.join("runtimes");
        let file = source.join("b1-rocm").join("rocblas").join("library.dat");
        write(&file, "kernels");
        let past = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(past)
            .unwrap();
        let target = root.join("home").join("runtimes");
        fs::create_dir_all(target.parent().unwrap()).unwrap();

        copy(&source, &target).unwrap();

        let copied = target.join("b1-rocm").join("rocblas").join("library.dat");
        assert_eq!(fs::read_to_string(&copied).unwrap(), "kernels");
        assert_eq!(modified(&copied), past);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_interrupted_copy_is_rebuilt_before_commit() {
        let root = fixture();
        let previous = layout(&root);
        let home = root.join(".aiolm");
        write(
            &previous.app_data.join("benchmarks").join("run"),
            "complete",
        );
        write(
            &home.join(".benchmarks.migration-v1").join("run"),
            "partial",
        );
        migrate(&home, &previous).unwrap();
        assert_eq!(
            fs::read_to_string(home.join("benchmarks").join("run")).unwrap(),
            "complete"
        );
        assert!(!home.join(".benchmarks.migration-v1").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
