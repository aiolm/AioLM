//! IPC for the common automatic connection journey.
//! Busy gates and provider failures use typed `AppError` kinds without
//! changing the messages shown by the connection journey.
use crate::{
    providers::{runtime_auto as auto, runtime_discovery},
    state::AppState,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

static BUSY: AtomicBool = AtomicBool::new(false);
struct Operation;
impl Operation {
    fn acquire() -> Result<Self, crate::error::AppError> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| crate::error::AppError::busy("automatic connection is already running"))?;
        auto::cancellation().store(false, Ordering::Release);
        Ok(Self)
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub(crate) async fn runtime_auto_discover(
    folder: Option<String>,
) -> Result<runtime_discovery::DiscoveryReport, crate::error::AppError> {
    let _operation = Operation::acquire()?;
    auto::discover(folder.as_deref().map(std::path::Path::new)).await
}

#[tauri::command]
pub(crate) async fn runtime_auto_inspect(
    candidate: runtime_discovery::RuntimeCandidate,
    command: Option<Vec<String>>,
) -> Result<auto::PreparedConnection, crate::error::AppError> {
    let _operation = Operation::acquire()?;
    let local_models = if candidate.endpoints.is_empty() {
        let cancel = auto::cancellation();
        tokio::task::spawn_blocking(move || {
            let cfg = crate::config::load_result()?;
            let catalog = super::providers::inspect_catalog(&cfg.models_dir, &cancel, None)?;
            Ok::<_, crate::error::AppError>(
                catalog
                    .models
                    .into_iter()
                    .filter(|m| m.artifact.role == crate::providers::artifacts::ArtifactRole::Model)
                    .map(|m| auto::ModelChoice {
                        id: m.artifact.path,
                        name: m.artifact.name,
                    })
                    .collect(),
            )
        })
        .await
        .map_err(crate::error::AppError::from)??
    } else {
        vec![]
    };
    auto::inspect(&candidate, local_models, command).await
}

#[tauri::command]
pub(crate) async fn runtime_auto_connect(
    state: State<'_, AppState>,
    prepared: auto::PreparedConnection,
    model_id: String,
) -> Result<auto::ConnectedRuntime, crate::error::AppError> {
    let _operation = Operation::acquire()?;
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    let _mutation = super::runtimes::runtime_change_gate(&state).await;
    if super::runtimes::runtime_resources_in_use(&state)? {
        return Err(crate::error::AppError::busy(
            "stop model sessions before connecting another runtime",
        ));
    }
    auto::connect(&prepared, &model_id, auto::cancellation()).await
}

#[tauri::command]
pub(crate) fn runtime_auto_cancel() -> bool {
    auto::cancel();
    true
}
