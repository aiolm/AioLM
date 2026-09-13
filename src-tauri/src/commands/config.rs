//! Application configuration and migration IPC.
use crate::{branding, config, state::AppState};
use tauri::State;

#[tauri::command]
pub(crate) fn get_config() -> Result<config::AppConfig, String> {
    config::load_result()
}

#[tauri::command]
pub(crate) async fn save_config(
    state: State<'_, AppState>,
    cfg: config::AppConfig,
) -> Result<config::AppConfig, String> {
    let _config_write = state.config_write.lock().await;
    let latest = config::load_result()?;
    let prepared = config::profiles::prepare_config_update(&latest, &cfg)?;
    config::save(&prepared)
}

#[tauri::command]
pub(crate) fn migration_paths() -> Vec<branding::MigratedPath> {
    branding::managed_paths()
}
