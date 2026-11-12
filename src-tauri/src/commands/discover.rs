//! Hugging Face model discovery and download IPC.
//! Failures preserve source error kinds, including cancellation through transfers.
use crate::{config, discover, error::AppError, state::AppState};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

/// The global operation lock held for one model transfer, marked as a
/// download so runtime changes can proceed beside it (see
/// `runtimes::runtime_change_gate`). The mark clears before the lock is
/// released.
struct DownloadGuard<'a> {
    _operation: tokio::sync::MutexGuard<'a, ()>,
    active: &'a AtomicBool,
}

impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

/// Reject contention instead of queueing a second transfer that would reset
/// the first transfer's cancellation flag after the lock becomes available.
/// A runtime install or removal in progress does not block a download: the
/// two touch different files, and server starts stay excluded by both.
fn begin_download(state: &AppState) -> Result<DownloadGuard<'_>, AppError> {
    let operation = state
        .operation
        .try_lock()
        .map_err(|_| AppError::busy("another model operation is in progress"))?;
    if state.exiting.load(Ordering::Acquire) {
        return Err(AppError::busy("application is exiting"));
    }
    if super::runtimes::runtime_resources_in_use(state)? {
        return Err(AppError::busy("stop model sessions before downloading"));
    }
    state.discover_cancel.store(false, Ordering::Release);
    state.model_download.store(true, Ordering::Release);
    Ok(DownloadGuard {
        _operation: operation,
        active: &state.model_download,
    })
}

#[tauri::command]
pub(crate) async fn hf_installed_snapshots(
    repo_id: String,
    models_dir: String,
) -> Result<Vec<crate::providers::artifacts::ModelArtifact>, AppError> {
    tokio::task::spawn_blocking(move || {
        let root = if models_dir.trim().is_empty() {
            config::load_result()?.models_dir
        } else {
            models_dir
        };
        discover::installed_snapshots(&root, &repo_id)
    })
    .await
    .map_err(AppError::from)?
}

#[tauri::command]
pub(crate) async fn hf_download_snapshot(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    models_dir: String,
    file_path: Option<String>,
    revision: Option<String>,
) -> Result<crate::providers::artifacts::ModelArtifact, AppError> {
    let _operation = begin_download(&state)?;
    let root = if models_dir.trim().is_empty() {
        config::load_result()?.models_dir
    } else {
        models_dir
    };
    discover::download_snapshot(
        app,
        &repo_id,
        &root,
        file_path.as_deref(),
        revision.as_deref(),
        &state.discover_cancel,
    )
    .await
}

#[tauri::command]
pub(crate) async fn hf_check_model_updates(
    paths: Vec<String>,
    models_dir: String,
) -> Result<Vec<discover::ModelUpdateStatus>, AppError> {
    let root = if models_dir.trim().is_empty() {
        config::load_result()?.models_dir
    } else {
        models_dir
    };
    // A read-only check must never reset or share an active transfer's cancel flag.
    let cancel = std::sync::atomic::AtomicBool::new(false);
    discover::check_model_updates(&paths, &root, &cancel).await
}

#[tauri::command]
pub(crate) async fn hf_update_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    models_dir: String,
    expected_revision: String,
) -> Result<discover::ModelUpdateResult, AppError> {
    let _operation = begin_download(&state)?;
    let root = if models_dir.trim().is_empty() {
        config::load_result()?.models_dir
    } else {
        models_dir
    };
    discover::update_model(
        app,
        &path,
        &root,
        &expected_revision,
        &state.discover_cancel,
    )
    .await
}

/// Open only validated Hugging Face repositories in the system browser.
#[tauri::command]
pub(crate) async fn hf_open_model_card(repo_id: String) -> Result<(), AppError> {
    discover::validate_repo_id(&repo_id)?;
    let url = format!("https://huggingface.co/{}", repo_id.trim());
    tokio::task::spawn_blocking(move || open::that(url))
        .await
        .map_err(|_| AppError::internal("The model card could not be opened."))?
        .map_err(|error| {
            AppError::unavailable(format!("The model card could not be opened: {error}"))
        })
}

/// Discover's listing. `query` may be empty — the panel opens on the catalog
/// before anything is typed — and `sort` picks the order the API ranks it in.
/// Without a `format` the listing covers every model repository.
#[tauri::command]
pub(crate) async fn hf_search_models(
    query: String,
    limit: u32,
    sort: Option<String>,
    format: Option<String>,
) -> Result<Vec<discover::HfModel>, AppError> {
    discover::search_format(
        &query,
        limit,
        sort.as_deref().unwrap_or(discover::DEFAULT_SORT),
        format.as_deref().unwrap_or(discover::DEFAULT_SEARCH_FORMAT),
    )
    .await
}

/// Which repository files this machine already holds, so Discover can mark
/// them installed instead of offering a download that would refuse to
/// overwrite. Resolving and checking local paths runs off the UI thread.
#[tauri::command]
pub(crate) async fn hf_installed_files(
    repo_id: String,
    files: Vec<String>,
    models_dir: String,
) -> Result<Vec<discover::InstalledHfFile>, AppError> {
    tokio::task::spawn_blocking(move || {
        let root = if models_dir.trim().is_empty() {
            config::load_result()?.models_dir
        } else {
            models_dir
        };
        discover::installed_files(&root, &repo_id, &files)
    })
    .await
    .map_err(AppError::from)?
}

/// One read of the selected repository's file tree: its GGUF files and whether
/// it has root safetensors weights a snapshot download could plan from.
#[tauri::command]
pub(crate) async fn hf_model_files(
    repo_id: String,
) -> Result<discover::HfRepositoryInspection, AppError> {
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
    revision: Option<String>,
) -> Result<discover::DownloadedModel, AppError> {
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
        revision.as_deref(),
    )
    .await
}

#[tauri::command]
pub(crate) fn hf_cancel_download(state: State<'_, AppState>) {
    state.discover_cancel.store(true, Ordering::Release);
}

/// Downloads that stopped before finishing, with the bytes already on disk.
#[tauri::command]
pub(crate) async fn hf_pending_downloads() -> Result<Vec<discover::PendingDownload>, AppError> {
    tokio::task::spawn_blocking(discover::pending_downloads)
        .await
        .map_err(AppError::from)
}

/// Forget an interrupted download and delete its staged bytes. Refused while
/// a download runs, since it could be the one writing them.
#[tauri::command]
pub(crate) async fn hf_discard_download(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| AppError::busy("wait for the current model operation to finish"))?;
    tokio::task::spawn_blocking(move || discover::discard_pending_download(&id))
        .await
        .map_err(AppError::from)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_contention_does_not_reset_cancellation_or_queue_a_transfer() {
        let state = AppState::default();
        let first = begin_download(&state).unwrap();
        state.discover_cancel.store(true, Ordering::Release);
        assert_eq!(
            begin_download(&state)
                .err()
                .expect("download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );
        assert!(state.discover_cancel.load(Ordering::Acquire));
        drop(first);
        assert!(begin_download(&state).is_ok());
        assert!(!state.discover_cancel.load(Ordering::Acquire));
    }

    #[test]
    fn active_model_blocks_both_download_entrypoints() {
        let state = AppState::default();
        state.server.lock().unwrap().lifecycle = crate::server::Lifecycle::Ready;
        assert_eq!(
            begin_download(&state)
                .err()
                .expect("download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );
    }

    #[test]
    fn named_model_sessions_and_exit_block_downloads_but_runtime_changes_do_not() {
        let state = AppState::default();
        let named = state
            .sessions
            .get_or_create("synthetic-session", "Synthetic session")
            .unwrap();
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Ready;
        assert_eq!(
            begin_download(&state)
                .err()
                .expect("download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Stopped;
        state.exiting.store(true, Ordering::Release);
        assert_eq!(
            begin_download(&state)
                .err()
                .expect("download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );
        state.exiting.store(false, Ordering::Release);
        state.runtime_busy.store(true, Ordering::Release);
        let download = begin_download(&state).unwrap();
        assert!(state.model_download.load(Ordering::Acquire));
        drop(download);
        assert!(!state.model_download.load(Ordering::Acquire));
        assert!(state.operation.try_lock().is_ok());
    }

    #[tokio::test]
    async fn runtime_changes_proceed_beside_a_download_but_wait_for_other_operations() {
        use std::time::Duration;
        let state = AppState::default();
        let download = begin_download(&state).unwrap();
        let gate = tokio::time::timeout(
            Duration::from_secs(5),
            super::super::runtimes::runtime_change_gate(&state),
        )
        .await
        .expect("a runtime change must not queue behind a model download");
        assert!(gate.is_none());
        drop(download);

        // A server start or other model operation still has to finish first.
        let operation = state.operation.lock().await;
        assert!(tokio::time::timeout(
            Duration::from_millis(200),
            super::super::runtimes::runtime_change_gate(&state),
        )
        .await
        .is_err());
        drop(operation);
        assert!(super::super::runtimes::runtime_change_gate(&state)
            .await
            .is_some());
    }
}
