//! Shared application state and its initial values.
use crate::{error::AppError, gateway, models, server, session};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use uuid::Uuid;

const API_KEY_FILE: &str = "api-key";

pub(crate) struct AppState {
    pub(crate) server: Arc<Mutex<server::ServerState>>,
    pub(crate) err: Arc<server::ErrBuf>,
    /// Serialises only short config-file writes. It deliberately does not
    /// cover a source download or compile, so read-only calls and settings
    /// saves remain responsive during a PR build.
    pub(crate) config_write: Arc<tokio::sync::Mutex<()>>,
    pub(crate) operation: Arc<tokio::sync::Mutex<()>>,
    /// Runtime mutations (install, uninstall, select, activation) are
    /// mutually exclusive without holding the global operation mutex for the
    /// duration of a multi-minute build.
    pub(crate) runtime_busy: Arc<AtomicBool>,
    /// Set while a model download holds `operation`. Runtime changes check it
    /// so they run beside a long transfer instead of queueing behind it.
    pub(crate) model_download: Arc<AtomicBool>,
    pub(crate) bench_cancel: Arc<AtomicBool>,
    pub(crate) bench_process: Arc<Mutex<Option<crate::procutil::ProcessHandle>>>,
    pub(crate) runtime_cancel: Arc<AtomicBool>,
    pub(crate) verify_cancel: Arc<AtomicBool>,
    pub(crate) model_scans: Arc<models::ScanRegistry>,
    pub(crate) media_jobs: Arc<crate::media::jobs::MediaJobs>,
    pub(crate) launch_jobs: Arc<crate::launch_jobs::LaunchJobs>,
    pub(crate) download_jobs: Arc<crate::download_jobs::DownloadJobs>,
    /// The external API listener. It is independent of every model process:
    /// starting, stopping or replacing models never touches it, and stopping
    /// it never unloads a model.
    pub(crate) gateway: Arc<Mutex<Option<gateway::GatewayHandle>>>,
    /// Serialises API listener start and stop only. It is deliberately not the
    /// global `operation` mutex, so the API stays controllable while a model
    /// is loading.
    pub(crate) api_control: tokio::sync::Mutex<()>,
    /// The key external API clients present. It survives model replacement,
    /// API stop/start, and application restarts until the user resets it, and is
    /// stored in its own private `api-key` file rather than `config.json`.
    pub(crate) api_key: gateway::ApiKey,
    api_key_path: Mutex<Option<PathBuf>>,
    pub(crate) selected_image: Mutex<Option<PathBuf>>,
    pub(crate) selected_document: Mutex<Option<PathBuf>>,
    pub(crate) attachment_drops: Mutex<crate::attachment_drop::AttachmentDrops>,
    pub(crate) exiting: Arc<AtomicBool>,
    /// Set once the normal `RunEvent::Exit` path begins. The update installer
    /// path also sets `exiting` to block new starts before its pre-launch
    /// cleanup, so a failed installer spawn checks this before restoring
    /// `exiting`: clearing a genuine exit would re-allow starts mid-shutdown.
    /// The mutex serializes marking a real exit with releasing an update's
    /// temporary exit gate, so rollback cannot overwrite a concurrent exit.
    pub(crate) normal_exit: Mutex<bool>,
    /// Every session besides the default one above. See `session.rs`.
    pub(crate) sessions: Arc<session::SessionManager>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            server: Arc::new(Mutex::new(server::ServerState::default())),
            err: Arc::new(server::ErrBuf::default()),
            config_write: Arc::new(tokio::sync::Mutex::new(())),
            operation: Arc::new(tokio::sync::Mutex::new(())),
            runtime_busy: Arc::new(AtomicBool::new(false)),
            model_download: Arc::new(AtomicBool::new(false)),
            bench_cancel: Arc::new(AtomicBool::new(false)),
            bench_process: Arc::new(Mutex::new(None)),
            runtime_cancel: Arc::new(AtomicBool::new(false)),
            verify_cancel: Arc::new(AtomicBool::new(false)),
            model_scans: Arc::new(models::ScanRegistry::default()),
            media_jobs: Arc::new(crate::media::jobs::MediaJobs::default()),
            launch_jobs: Arc::new(crate::launch_jobs::LaunchJobs::default()),
            download_jobs: Arc::new(crate::download_jobs::DownloadJobs::default()),
            gateway: Arc::new(Mutex::new(None)),
            api_control: tokio::sync::Mutex::new(()),
            api_key: gateway::ApiKey::new(new_api_key()),
            api_key_path: Mutex::new(None),
            selected_image: Mutex::new(None),
            selected_document: Mutex::new(None),
            attachment_drops: Mutex::new(crate::attachment_drop::AttachmentDrops::default()),
            exiting: Arc::new(AtomicBool::new(false)),
            normal_exit: Mutex::new(false),
            sessions: Arc::new(session::SessionManager::new()),
        }
    }
}

fn new_api_key() -> Arc<str> {
    format!(
        "sk-aiolm-{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
    .into()
}

fn is_valid_api_key(value: &str) -> bool {
    value.starts_with("sk-aiolm-")
        && (64..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn check_private_key_target(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if crate::branding::is_link(&metadata) || !metadata.is_file() {
                return Err(AppError::validation(
                    "API key path must be a regular private file, not a link or directory",
                ));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::io("failed to inspect API key file", &error)),
    }
}

fn write_private_api_key(path: &Path, key: &str) -> Result<(), AppError> {
    check_private_key_target(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::validation("API key path has no parent directory"))?;
    fs::create_dir_all(parent).map_err(|error| AppError::from_io(&error))?;
    let temp = parent.join(format!(".{API_KEY_FILE}.tmp-{}", Uuid::new_v4().simple()));

    let write_result = (|| -> Result<(), AppError> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|error| AppError::from_io(&error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| AppError::from_io(&error))?;
        }
        file.write_all(key.as_bytes())
            .map_err(|error| AppError::from_io(&error))?;
        file.sync_all().map_err(|error| AppError::from_io(&error))?;
        drop(file);
        crate::config::replace_atomically(&temp, path)?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|error| AppError::from_io(&error))?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

fn load_or_create_api_key(path: &Path) -> Result<Arc<str>, AppError> {
    if check_private_key_target(path)? {
        let raw = fs::read_to_string(path)
            .map_err(|error| AppError::io("failed to read API key file", &error))?;
        let trimmed = raw.trim();
        if is_valid_api_key(trimmed) {
            return Ok(Arc::from(trimmed));
        }
    }
    let key = new_api_key();
    write_private_api_key(path, &key)?;
    Ok(key)
}

impl AppState {
    pub(crate) fn current_api_key(&self) -> Arc<str> {
        self.api_key.current()
    }

    pub(crate) fn init_api_key_in(&self, home: &Path) -> Result<Arc<str>, AppError> {
        let path = home.join(API_KEY_FILE);
        *self
            .api_key_path
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(path.clone());
        let key = load_or_create_api_key(&path)?;
        self.api_key.replace(key.clone());
        Ok(key)
    }

    pub(crate) fn init_persistent_api_key(&self) -> Result<Arc<str>, AppError> {
        self.init_api_key_in(&crate::home::aiolm_home())
    }

    pub(crate) fn reset_api_key(&self) -> Result<Arc<str>, AppError> {
        let next = new_api_key();
        let path = self
            .api_key_path
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(path) = path {
            write_private_api_key(&path, &next)?;
        }
        self.api_key.replace(next.clone());
        Ok(next)
    }

    /// What the API listener routes to: the default session plus every named one.
    pub(crate) fn model_source(&self) -> gateway::ModelSource {
        gateway::ModelSource::new(self.server.clone(), self.err.clone(), self.sessions.clone())
    }

    pub(crate) fn begin_normal_exit(&self) {
        self.media_jobs.cancel_all();
        self.launch_jobs.cancel_all();
        self.download_jobs.cancel_all();
        let mut normal_exit = self
            .normal_exit
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *normal_exit = true;
        self.exiting
            .store(true, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_application_run_gets_its_own_unguessable_api_key() {
        let first = AppState::default();
        let second = AppState::default();
        let first_key = first.current_api_key();
        let second_key = second.current_api_key();
        assert_ne!(first_key, second_key);
        assert!(first_key.starts_with("sk-aiolm-"));
        assert!(first_key.len() >= 64, "key must carry real entropy");
    }

    #[test]
    fn persistent_api_key_survives_restarts_until_reset_or_recovery() {
        let dir = std::env::temp_dir().join(format!("aiolm-api-key-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        let first = AppState::default();
        let initial = first.init_api_key_in(&dir).unwrap();
        assert!(is_valid_api_key(&initial));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.join(API_KEY_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let second = AppState::default();
        let reloaded = second.init_api_key_in(&dir).unwrap();
        assert_eq!(reloaded, initial);

        let reset = second.reset_api_key().unwrap();
        assert_ne!(reset, initial);
        assert_eq!(second.current_api_key(), reset);

        let third = AppState::default();
        assert_eq!(third.init_api_key_in(&dir).unwrap(), reset);

        // Corrupted or empty file is recovered with a new valid persisted key.
        fs::write(dir.join(API_KEY_FILE), b"corrupt-key\n").unwrap();
        let recovered = AppState::default().init_api_key_in(&dir).unwrap();
        assert!(is_valid_api_key(&recovered));
        assert_ne!(recovered, reset);
        assert_eq!(
            AppState::default().init_api_key_in(&dir).unwrap(),
            recovered
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn api_key_storage_refuses_non_regular_targets_without_mutating_live_key() {
        let dir = std::env::temp_dir().join(format!("aiolm-api-key-dir-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join(API_KEY_FILE)).unwrap();

        let state = AppState::default();
        let before = state.current_api_key();
        assert!(state.init_api_key_in(&dir).is_err());
        assert!(state.reset_api_key().is_err());
        assert_eq!(state.current_api_key(), before);

        #[cfg(unix)]
        {
            let link_dir =
                std::env::temp_dir().join(format!("aiolm-api-key-link-{}", Uuid::new_v4()));
            fs::create_dir_all(&link_dir).unwrap();
            let target = link_dir.join("target.txt");
            fs::write(&target, b"sk-aiolm-0000").unwrap();
            std::os::unix::fs::symlink(&target, link_dir.join(API_KEY_FILE)).unwrap();
            let link_state = AppState::default();
            let original = link_state.current_api_key();
            assert!(link_state.init_api_key_in(&link_dir).is_err());
            assert!(link_state.reset_api_key().is_err());
            assert_eq!(link_state.current_api_key(), original);
            let _ = fs::remove_dir_all(&link_dir);
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
