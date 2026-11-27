//! Application configuration and migration IPC.
//! Configuration parse/validation and persistence kinds cross IPC unchanged;
//! unavailable desktop integrations report `unavailable`.
use crate::{branding, config, error::AppError, state::AppState};
use tauri::State;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub(crate) fn get_config() -> Result<config::AppConfig, AppError> {
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
) -> Result<config::AppConfig, AppError> {
    let _config_write = state.config_write.lock().await;
    let latest = tokio::task::spawn_blocking(config::load_result)
        .await
        .map_err(|error| AppError::internal(format!("settings load task failed: {error}")))??;
    let mut cfg = cfg;
    crate::commands::runtimes::realign_saved_gpu_placement(&latest, &mut cfg).await;
    let prepared = config::profiles::prepare_config_update(&latest, &cfg)?;
    if prepared.close_to_tray && !latest.close_to_tray && !crate::tray::host_available() {
        return Err(AppError::unavailable(
            "the desktop has no available system tray host",
        ));
    }
    // The tray icon has to follow the close-to-tray setting immediately, so the
    // next close already has somewhere to hide the window. It is applied before
    // the file is written: a tray that cannot be created reports the failure and
    // leaves the saved setting as it was, rather than persisting a setting with
    // nothing behind it.
    let had_tray = crate::tray::is_present(&app);
    crate::tray::apply(&app, prepared.close_to_tray).map_err(AppError::unavailable)?;
    let saved = tokio::task::spawn_blocking(move || config::save(&prepared))
        .await
        .map_err(|error| AppError::internal(format!("settings save task failed: {error}")))
        .and_then(|result| result);
    saved.inspect_err(|_| {
        // Restore the tray to match the setting that remains on disk.
        let _ = crate::tray::apply(&app, had_tray);
    })
}

fn should_skip_migration_paths(identifier: &str, skip_legacy: bool) -> bool {
    !crate::home::is_production_identifier(identifier) || skip_legacy
}

fn isolated_launch_at_login_result(enabled: bool) -> Result<bool, AppError> {
    if enabled {
        Err(AppError::unavailable(
            "Launch at login is disabled in isolated development builds.",
        ))
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn migration_paths(
    app: tauri::AppHandle,
) -> Result<Vec<branding::MigratedPath>, AppError> {
    if should_skip_migration_paths(
        &app.config().identifier,
        crate::home::legacy_migration_disabled(),
    ) {
        return Ok(Vec::new());
    }
    Ok(branding::managed_paths())
}

/// Whether AioLM starts when the user signs in. The operating system's own
/// startup registration is the source of truth rather than a saved setting,
/// so turning the entry off in the OS startup list is reflected here.
#[tauri::command]
pub(crate) fn launch_at_login(app: tauri::AppHandle) -> Result<bool, AppError> {
    if !crate::home::is_production_identifier(&app.config().identifier) {
        return Ok(false);
    }
    app.autolaunch().is_enabled().map_err(|error| {
        AppError::unavailable(format!("failed to read the startup registration: {error}"))
    })
}

/// Add or remove AioLM's startup registration and report the state that took
/// effect.
#[tauri::command]
pub(crate) fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<bool, AppError> {
    if !crate::home::is_production_identifier(&app.config().identifier) {
        return isolated_launch_at_login_result(enabled);
    }
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    }
    .map_err(|error| {
        AppError::unavailable(format!(
            "failed to update the startup registration: {error}"
        ))
    })?;
    launcher.is_enabled().map_err(|error| {
        AppError::unavailable(format!("failed to read the startup registration: {error}"))
    })
}

#[tauri::command]
pub(crate) fn sync_tray_state(
    app: tauri::AppHandle,
    locale: String,
    model_state: String,
    model_name: Option<String>,
) -> Result<(), AppError> {
    crate::tray::update_presentation(&app, &locale, &model_state, model_name.as_deref())
        .map_err(AppError::unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    #[test]
    fn migration_paths_are_skipped_for_isolated_identifiers_or_disabled_env() {
        assert!(!should_skip_migration_paths("com.aiolm.desktop", false));
        assert!(should_skip_migration_paths("com.aiolm.desktop", true));
        assert!(should_skip_migration_paths("com.aiolm.desktop.dev", false));
        assert!(should_skip_migration_paths("com.aiolm.desktop.dev", true));
    }

    #[test]
    fn isolated_launch_at_login_rejects_enable_and_keeps_disable_off() {
        assert!(!isolated_launch_at_login_result(false).unwrap());
        let error = isolated_launch_at_login_result(true).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Unavailable);
        assert!(error.message.contains("isolated development builds"));
    }
}
