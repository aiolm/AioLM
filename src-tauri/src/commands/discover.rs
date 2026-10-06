//! Hugging Face model discovery and download IPC.
use crate::{config, discover, state::AppState};
use std::sync::atomic::Ordering;
use tauri::State;

/// Reject contention instead of queueing a second transfer that would reset
/// the first transfer's cancellation flag after the lock becomes available.
fn begin_download(state: &AppState) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
    let operation = state
        .operation
        .try_lock()
        .map_err(|_| "another model operation is in progress")?;
    if state.exiting.load(Ordering::Acquire) {
        return Err("application is exiting".into());
    }
    if state.runtime_busy.load(Ordering::Acquire) {
        return Err("another runtime operation is in progress".into());
    }
    if super::runtimes::runtime_resources_in_use(state)? {
        return Err("stop model sessions before downloading".into());
    }
    state.discover_cancel.store(false, Ordering::Release);
    Ok(operation)
}

#[tauri::command]
pub(crate) async fn hf_installed_snapshots(
    repo_id: String,
    models_dir: String,
) -> Result<Vec<crate::providers::artifacts::ModelArtifact>, String> {
    tokio::task::spawn_blocking(move || {
        let root = if models_dir.trim().is_empty() {
            config::load_result()?.models_dir
        } else {
            models_dir
        };
        discover::installed_snapshots(&root, &repo_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn hf_download_snapshot(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    models_dir: String,
) -> Result<crate::providers::artifacts::ModelArtifact, String> {
    let _operation = begin_download(&state)?;
    let root = if models_dir.trim().is_empty() {
        config::load_result()?.models_dir
    } else {
        models_dir
    };
    discover::download_snapshot(app, &repo_id, &root, &state.discover_cancel).await
}

/// Open only validated Hugging Face repositories in the system browser.
#[tauri::command]
pub(crate) async fn hf_open_model_card(repo_id: String) -> Result<(), String> {
    discover::validate_repo_id(&repo_id)?;
    open::that(format!("https://huggingface.co/{}", repo_id.trim()))
        .map_err(|error| format!("The model card could not be opened: {error}"))
}

/// Discover's listing. `query` may be empty — the panel opens on the catalog
/// before anything is typed — and `sort` picks the order the API ranks it in.
#[tauri::command]
pub(crate) async fn hf_search_models(
    query: String,
    limit: u32,
    sort: Option<String>,
    format: Option<String>,
) -> Result<Vec<discover::HfModel>, String> {
    discover::search_format(
        &query,
        limit,
        sort.as_deref().unwrap_or(discover::DEFAULT_SORT),
        format.as_deref().unwrap_or("gguf"),
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
    include_companions: Option<bool>,
) -> Result<discover::DownloadedModel, String> {
    let _operation = begin_download(&state)?;
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
        include_companions.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub(crate) fn hf_cancel_download(state: State<'_, AppState>) {
    state.discover_cancel.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_contention_does_not_reset_cancellation_or_queue_a_transfer() {
        let state = AppState::default();
        let first = begin_download(&state).unwrap();
        state.discover_cancel.store(true, Ordering::Release);
        assert!(begin_download(&state).is_err());
        assert!(state.discover_cancel.load(Ordering::Acquire));
        drop(first);
        assert!(begin_download(&state).is_ok());
        assert!(!state.discover_cancel.load(Ordering::Acquire));
    }

    #[test]
    fn active_model_blocks_both_download_entrypoints() {
        let state = AppState::default();
        state.server.lock().unwrap().lifecycle = crate::server::Lifecycle::Ready;
        assert!(begin_download(&state).is_err());
    }

    #[test]
    fn named_model_sessions_exit_and_runtime_operations_block_downloads() {
        let state = AppState::default();
        let named = state
            .sessions
            .get_or_create("synthetic-session", "Synthetic session")
            .unwrap();
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Ready;
        assert!(begin_download(&state).is_err());
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Stopped;
        state.exiting.store(true, Ordering::Release);
        assert!(begin_download(&state).is_err());
        state.exiting.store(false, Ordering::Release);
        state.runtime_busy.store(true, Ordering::Release);
        assert!(begin_download(&state).is_err());
        state.runtime_busy.store(false, Ordering::Release);
        assert!(begin_download(&state).is_ok());
    }
}
