//! Durable local benchmark records and explicit measurement provenance.
pub(crate) mod download_receipt;
pub(crate) mod identity;
pub(crate) mod model_metadata;
pub(crate) mod provenance;
pub(crate) mod sharing;
pub(crate) mod store;

use std::path::PathBuf;
use tauri::Manager;

/// Where run journals, model identities and download receipts live. They share
/// a root so that everything derived from a model file is invalidated, cleared
/// and reasoned about in one place.
pub(crate) fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("benchmarks"))
        .map_err(|error| format!("cannot resolve benchmark data directory: {error}"))
}
