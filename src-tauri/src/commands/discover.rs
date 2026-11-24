//! Hugging Face model discovery and download IPC.
//! Failures preserve source error kinds, including cancellation through transfers.
use crate::{config, discover, download_jobs, error::AppError, state::AppState};
use std::sync::atomic::Ordering;
use tauri::State;

/// Resolve empty library directory inputs against saved configuration before
/// computing target paths for concurrent download isolation.
fn resolve_models_dir(models_dir: String) -> Result<String, AppError> {
    if models_dir.trim().is_empty() {
        Ok(config::load_result()?.models_dir)
    } else {
        Ok(models_dir)
    }
}

/// Start one tracked transfer under `DownloadJobs`, sharing one `operation`
/// gate claim while allowing concurrent downloads to distinct targets.
fn begin_download(
    state: &AppState,
    download_id: Option<String>,
    targets: Vec<String>,
) -> Result<(String, download_jobs::DownloadLease), AppError> {
    if state.exiting.load(Ordering::Acquire) {
        return Err(AppError::busy("application is exiting"));
    }
    if super::runtimes::runtime_resources_in_use(state)? {
        return Err(AppError::busy("stop model sessions before downloading"));
    }
    let id = download_id
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let lease = state
        .download_jobs
        .begin(&id, targets, &state.operation, &state.model_download)?;
    Ok((id, lease))
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
    download_id: Option<String>,
) -> Result<crate::providers::artifacts::ModelArtifact, AppError> {
    let root = resolve_models_dir(models_dir)?;
    let targets = download_jobs::snapshot_target_keys(&repo_id, &root, file_path.as_deref())?;
    let (id, lease) = begin_download(&state, download_id, targets)?;
    discover::download_snapshot(
        app,
        &id,
        &repo_id,
        &root,
        file_path.as_deref(),
        revision.as_deref(),
        &lease.cancel_flag(),
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
    download_id: Option<String>,
) -> Result<discover::ModelUpdateResult, AppError> {
    let root = resolve_models_dir(models_dir)?;
    let targets = download_jobs::update_target_keys(&path, &root)?;
    let (id, lease) = begin_download(&state, download_id, targets)?;
    discover::update_model(
        app,
        &id,
        &path,
        &root,
        &expected_revision,
        &lease.cancel_flag(),
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
pub(crate) async fn hf_token_status() -> Result<discover::HfTokenStatus, AppError> {
    tokio::task::spawn_blocking(discover::token_status)
        .await
        .map_err(AppError::from)?
}

#[tauri::command]
pub(crate) async fn hf_set_token(token: String) -> Result<discover::HfTokenStatus, AppError> {
    tokio::task::spawn_blocking(move || discover::set_token(&token))
        .await
        .map_err(AppError::from)?
}

#[tauri::command]
pub(crate) async fn hf_clear_token() -> Result<discover::HfTokenStatus, AppError> {
    tokio::task::spawn_blocking(discover::clear_token)
        .await
        .map_err(AppError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn hf_download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    file_path: String,
    models_dir: String,
    include_companions: Option<bool>,
    revision: Option<String>,
    download_id: Option<String>,
) -> Result<discover::DownloadedModel, AppError> {
    let companions = include_companions.unwrap_or(false);
    let root = resolve_models_dir(models_dir)?;
    let targets = download_jobs::gguf_target_keys(&repo_id, &file_path, &root, companions)?;
    let (id, lease) = begin_download(&state, download_id, targets)?;
    discover::download(
        app,
        &id,
        &repo_id,
        &file_path,
        &root,
        lease.cancel_flag(),
        companions,
        revision.as_deref(),
    )
    .await
}

#[tauri::command]
pub(crate) fn hf_cancel_download(state: State<'_, AppState>, download_id: Option<String>) {
    state.download_jobs.cancel(download_id.as_deref());
}

/// Downloads that stopped before finishing (excluding transfers currently in
/// progress), with the bytes already on disk.
#[tauri::command]
pub(crate) async fn hf_pending_downloads(
    state: State<'_, AppState>,
) -> Result<Vec<discover::PendingDownload>, AppError> {
    let entries = tokio::task::spawn_blocking(discover::pending_downloads)
        .await
        .map_err(AppError::from)?;
    Ok(entries
        .into_iter()
        .filter(|entry| !state.download_jobs.is_pending_active(entry))
        .collect())
}

/// Forget an interrupted download and delete its staged bytes. Refused when an
/// active download transfers to the same target files.
#[tauri::command]
pub(crate) async fn hf_discard_download(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let lookup_id = id.clone();
    let pending = tokio::task::spawn_blocking(move || discover::find_pending_download(&lookup_id))
        .await
        .map_err(AppError::from)?;
    let _discard_guard = if let Some(entry) = pending.as_ref() {
        Some(state.download_jobs.try_discard_pending(entry)?)
    } else {
        None
    };
    tokio::task::spawn_blocking(move || discover::discard_pending_download(&id))
        .await
        .map_err(AppError::from)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_models_dir() -> String {
        std::env::temp_dir()
            .join(format!("aiolm-cmd-dl-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn concurrent_downloads_can_cancel_independently_while_duplicates_reject() {
        let state = AppState::default();
        let root = test_models_dir();
        let targets_a =
            download_jobs::gguf_target_keys("owner/alpha", "alpha.gguf", &root, false).unwrap();
        let targets_b =
            download_jobs::gguf_target_keys("owner/beta", "beta.gguf", &root, false).unwrap();

        let (id_a, lease_a) =
            begin_download(&state, Some("dl-a".into()), targets_a.clone()).unwrap();
        let (id_b, lease_b) = begin_download(&state, Some("dl-b".into()), targets_b).unwrap();
        assert_eq!(id_a, "dl-a");
        assert_eq!(id_b, "dl-b");

        assert_eq!(
            begin_download(&state, Some("dl-dup".into()), targets_a)
                .err()
                .expect("duplicate target download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );

        state.download_jobs.cancel(Some("dl-a"));
        assert!(lease_a.cancel_flag().load(Ordering::Acquire));
        assert!(!lease_b.cancel_flag().load(Ordering::Acquire));

        drop(lease_a);
        assert!(state.model_download.load(Ordering::Acquire));
        drop(lease_b);
        assert!(!state.model_download.load(Ordering::Acquire));
        assert!(state.operation.try_lock().is_ok());
    }

    #[test]
    fn active_model_blocks_both_download_entrypoints() {
        let state = AppState::default();
        let root = test_models_dir();
        let targets =
            download_jobs::gguf_target_keys("owner/alpha", "alpha.gguf", &root, false).unwrap();
        state.server.lock().unwrap().lifecycle = crate::server::Lifecycle::Ready;
        assert_eq!(
            begin_download(&state, None, targets)
                .err()
                .expect("download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );
    }

    #[test]
    fn named_model_sessions_and_exit_block_downloads_but_runtime_changes_do_not() {
        let state = AppState::default();
        let root = test_models_dir();
        let targets =
            download_jobs::gguf_target_keys("owner/alpha", "alpha.gguf", &root, false).unwrap();
        let named = state
            .sessions
            .get_or_create("synthetic-session", "Synthetic session")
            .unwrap();
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Ready;
        assert_eq!(
            begin_download(&state, None, targets.clone())
                .err()
                .expect("download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Stopped;
        state.exiting.store(true, Ordering::Release);
        assert_eq!(
            begin_download(&state, None, targets.clone())
                .err()
                .expect("download must be blocked")
                .kind,
            crate::error::ErrorKind::Busy,
        );
        state.exiting.store(false, Ordering::Release);
        state.runtime_busy.store(true, Ordering::Release);
        let (_id, download) = begin_download(&state, None, targets).unwrap();
        assert!(state.model_download.load(Ordering::Acquire));
        drop(download);
        assert!(!state.model_download.load(Ordering::Acquire));
        assert!(state.operation.try_lock().is_ok());
    }

    #[tokio::test]
    async fn runtime_changes_proceed_beside_a_download_but_wait_for_other_operations() {
        use std::time::Duration;
        let state = AppState::default();
        let root = test_models_dir();
        let targets =
            download_jobs::gguf_target_keys("owner/alpha", "alpha.gguf", &root, false).unwrap();
        let (_id, download) = begin_download(&state, None, targets).unwrap();
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
