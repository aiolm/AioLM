//! Shared application state and its initial values.
use crate::{gateway, models, server, session};
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc, Mutex};

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
    pub(crate) gateway: Arc<Mutex<Option<gateway::GatewayHandle>>>,
    pub(crate) selected_image: Mutex<Option<PathBuf>>,
    pub(crate) selected_document: Mutex<Option<PathBuf>>,
    pub(crate) exiting: Arc<AtomicBool>,
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
            selected_image: Mutex::new(None),
            selected_document: Mutex::new(None),
            exiting: Arc::new(AtomicBool::new(false)),
            sessions: Arc::new(session::SessionManager::new()),
        }
    }
}
