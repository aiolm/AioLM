//! Shared application state and its initial values.
use crate::{gateway, models, server, session};
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use uuid::Uuid;

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
    pub(crate) bench_cancel: Arc<AtomicBool>,
    pub(crate) bench_pid: Arc<Mutex<Option<u32>>>,
    pub(crate) runtime_cancel: Arc<AtomicBool>,
    pub(crate) discover_cancel: Arc<AtomicBool>,
    pub(crate) verify_cancel: Arc<AtomicBool>,
    pub(crate) model_scans: Arc<models::ScanRegistry>,
    /// The external API listener. It is independent of every model process:
    /// starting, stopping or replacing models never touches it, and stopping
    /// it never unloads a model.
    pub(crate) gateway: Arc<Mutex<Option<gateway::GatewayHandle>>>,
    /// Serialises API listener start and stop only. It is deliberately not the
    /// global `operation` mutex, so the API stays controllable while a model
    /// is loading.
    pub(crate) api_control: tokio::sync::Mutex<()>,
    /// The key external API clients present. It exists once per application
    /// run, so it survives model replacement and API stop/start, and is never
    /// persisted or logged.
    pub(crate) api_key: Arc<str>,
    pub(crate) selected_image: Mutex<Option<PathBuf>>,
    pub(crate) selected_document: Mutex<Option<PathBuf>>,
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
            bench_cancel: Arc::new(AtomicBool::new(false)),
            bench_pid: Arc::new(Mutex::new(None)),
            runtime_cancel: Arc::new(AtomicBool::new(false)),
            discover_cancel: Arc::new(AtomicBool::new(false)),
            verify_cancel: Arc::new(AtomicBool::new(false)),
            model_scans: Arc::new(models::ScanRegistry::default()),
            gateway: Arc::new(Mutex::new(None)),
            api_control: tokio::sync::Mutex::new(()),
            api_key: new_api_key(),
            selected_image: Mutex::new(None),
            selected_document: Mutex::new(None),
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

impl AppState {
    /// What the API listener routes to: the default session plus every named one.
    pub(crate) fn model_source(&self) -> gateway::ModelSource {
        gateway::ModelSource::new(self.server.clone(), self.err.clone(), self.sessions.clone())
    }

    pub(crate) fn begin_normal_exit(&self) {
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
        assert_ne!(first.api_key, second.api_key);
        assert!(first.api_key.starts_with("sk-aiolm-"));
        assert!(first.api_key.len() >= 64, "key must carry real entropy");
    }
}
