//! Hugging Face model discovery and download IPC.
use crate::{config, discover, state::AppState};
use std::sync::atomic::Ordering;
use tauri::State;

#[tauri::command]
pub(crate) async fn hf_search_models(
    query: String,
    limit: u32,
) -> Result<Vec<discover::HfModel>, String> {
    discover::search(&query, limit).await
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
