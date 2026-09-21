//! Hugging Face model discovery and download IPC.
use crate::{config, discover, state::AppState};
use std::sync::atomic::Ordering;
use tauri::State;

/// Discover's listing. `query` may be empty — the panel opens on the catalog
/// before anything is typed — and `sort` picks the order the API ranks it in.
#[tauri::command]
pub(crate) async fn hf_search_models(
    query: String,
    limit: u32,
    sort: Option<String>,
) -> Result<Vec<discover::HfModel>, String> {
    discover::search(
        &query,
        limit,
        sort.as_deref().unwrap_or(discover::DEFAULT_SORT),
    )
    .await
}

/// Which repository files this machine already holds, so Discover can mark
/// them installed instead of offering a download that would refuse to
/// overwrite. Runs off the UI thread: it stats one path per listed file.
#[tauri::command]
pub(crate) async fn hf_installed_files(
    repo_id: String,
    files: Vec<String>,
    models_dir: String,
) -> Result<Vec<discover::InstalledHfFile>, String> {
    tokio::task::spawn_blocking(move || {
        let root = if models_dir.trim().is_empty() {
            config::load_result()?.models_dir
        } else {
            models_dir
        };
        discover::installed_files(&root, &repo_id, &files)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn hf_model_files(repo_id: String) -> Result<Vec<discover::HfFile>, String> {
    discover::files(&repo_id).await
}

#[tauri::command]
pub(crate) async fn hf_download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    file_path: String,
    models_dir: String,
) -> Result<discover::DownloadedModel, String> {
    let _operation = state.operation.lock().await;
    state.discover_cancel.store(false, Ordering::Release);
    let root = if models_dir.trim().is_empty() {
        config::load_result()?.models_dir
    } else {
        models_dir
    };
    discover::download(
        app,
        &repo_id,
        &file_path,
        &root,
        state.discover_cancel.clone(),
    )
    .await
}

#[tauri::command]
pub(crate) fn hf_cancel_download(state: State<'_, AppState>) {
    state.discover_cancel.store(true, Ordering::Release);
}
