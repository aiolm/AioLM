//! Application configuration and migration IPC.
use crate::{branding, config, state::AppState};
use tauri::State;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub(crate) fn get_config() -> Result<config::AppConfig, String> {
    let cfg = config::load_result()?;
    // The frontend reads the configuration before it scans or downloads
    // anything, so this is the last point at which the default model folder can
    // be put in place ahead of both. Best effort only: a folder that cannot be
    // created must not stop the application from loading, and `list_models`
    // reports the same failure where the user is looking for the folder.
    let _ = config::ensure_default_models_dir(&cfg);
    Ok(cfg)
}

#[tauri::command]
pub(crate) async fn save_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    cfg: config::AppConfig,
) -> Result<config::AppConfig, String> {
    let _config_write = state.config_write.lock().await;
    let latest = config::load_result()?;
    let mut cfg = cfg;
    crate::commands::runtimes::realign_saved_gpu_placement(&latest, &mut cfg).await;
    let prepared = config::profiles::prepare_config_update(&latest, &cfg)?;
    if prepared.close_to_tray && !latest.close_to_tray && !crate::tray::host_available() {
        return Err("the desktop has no available system tray host".into());
    }
    // The tray icon has to follow the close-to-tray setting immediately, so the
    // next close already has somewhere to hide the window. It is applied before
    // the file is written: a tray that cannot be created reports the failure and
    // leaves the saved setting as it was, rather than persisting a setting with
    // nothing behind it.
    let had_tray = crate::tray::is_present(&app);
    crate::tray::apply(&app, prepared.close_to_tray)?;
    config::save(&prepared).inspect_err(|_| {
        // Nothing was written, so the tray must go back to matching the setting
        // that is still saved rather than the one that failed to save.
        let _ = crate::tray::apply(&app, had_tray);
    })
}

#[tauri::command]
pub(crate) fn migration_paths() -> Vec<branding::MigratedPath> {
    branding::managed_paths()
}

/// Whether AioLM starts when the user signs in. The operating system's own
/// startup registration is the source of truth rather than a saved setting,
/// so turning the entry off in the OS startup list is reflected here.
#[tauri::command]
pub(crate) fn launch_at_login(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("failed to read the startup registration: {error}"))
}

/// Add or remove AioLM's startup registration and report the state that took
/// effect.
#[tauri::command]
pub(crate) fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    }
    .map_err(|error| format!("failed to update the startup registration: {error}"))?;
    launcher
        .is_enabled()
        .map_err(|error| format!("failed to read the startup registration: {error}"))
}
