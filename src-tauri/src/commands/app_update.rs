//! Application update IPC: the check behind the startup notification and the
//! settings panel, and the install the user confirms there.
use crate::app_update;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

#[tauri::command]
pub(crate) async fn check_app_update() -> Result<app_update::UpdateStatus, String> {
    app_update::check(env!("CARGO_PKG_VERSION")).await
}

/// Block new managed starts before the pre-launch cleanup. Managed server and
/// job starts already refuse to run while `exiting` is set, so without this a
/// queued or manual start could create a new process in the window between the
/// cleanup and the installer spawn. Returns the previous flag so a failed
/// spawn can restore it. No lock is held across the synchronous cleanup.
fn gate_update_exiting(state: &AppState) -> bool {
    state.exiting.swap(true, Ordering::AcqRel)
}

/// Restore the update gate after a failed installer spawn. Keeps the gate
/// when the app was already exiting beforehand or a genuine exit began while
/// the installer was being fetched; only then must new starts stay blocked.
fn release_update_gate(state: &AppState, was_exiting: bool) {
    let normal_exit = state
        .normal_exit
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !was_exiting && !*normal_exit {
        state.exiting.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub(crate) async fn install_app_update(
    app: tauri::AppHandle,
    version: String,
) -> Result<(), String> {
    let progress = app.clone();
    let shutdown = app.clone();
    // After the installer is verified and before it spawns, gate new starts
    // and stop the managed servers and jobs deterministically: the
    // installer's running-app check can force-kill this process as soon as it
    // spawns, which may be before the exit handler runs. A failed download or
    // hash returns before this hook, leaving sessions untouched; a failed
    // spawn restores the gate (unless a genuine exit began) and leaves the
    // app open with an error.
    let was_exiting = AtomicBool::new(false);
    let hook_ran = AtomicBool::new(false);
    let before_launch = || {
        if let Some(state) = shutdown.try_state::<AppState>() {
            was_exiting.store(gate_update_exiting(&state), Ordering::Release);
            hook_ran.store(true, Ordering::Release);
            crate::shutdown_managed_processes(&state);
        }
    };
    let result = app_update::install(
        &move |phase, downloaded, total| {
            let _ = progress.emit(
                "app-update-progress",
                serde_json::json!({
                    "phase": phase,
                    "downloaded": downloaded,
                    "total": total
                }),
            );
        },
        &version,
        env!("CARGO_PKG_VERSION"),
        Some(&before_launch),
    )
    .await;
    if let Err(error) = result {
        // The hook runs only after verification, immediately before the
        // spawn, so a failure with the hook run is a failed spawn: hand the
        // gate back unless the app is genuinely exiting.
        if hook_ran.load(Ordering::Acquire) {
            if let Some(state) = app.try_state::<AppState>() {
                release_update_gate(&state, was_exiting.load(Ordering::Acquire));
            }
        }
        return Err(error);
    }
    // The installer replaces files this process holds open, so exit through
    // the normal exit path, which repeats the same managed cleanup
    // idempotently. The gate above already blocks new starts, and the UI tells
    // the user the app closes, so exit as soon as the reply is queued rather
    // than waiting out a fixed delay while the installer can force-kill us.
    let exiting = app.clone();
    tauri::async_runtime::spawn(async move {
        exiting.exit(0);
    });
    Ok(())
}

/// Open this project's release page for the builds that cannot install an
/// update themselves: an unsupported platform, or a copy that is not a
/// registered Windows installation. It takes no argument, so the renderer
/// cannot steer where the browser goes.
#[tauri::command]
pub(crate) async fn open_app_update_release() -> Result<(), String> {
    open::that(app_update::RELEASE_PAGE_URL)
        .map_err(|error| format!("the release page could not be opened: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_update_gate_stays_closed_once_the_installer_has_spawned() {
        let state = AppState::default();
        assert!(!state.exiting.load(Ordering::Acquire));
        let was_exiting = gate_update_exiting(&state);
        assert!(!was_exiting);
        // The success path restores nothing: the app is on its way out and
        // new starts must stay blocked until the process is gone.
        assert!(state.exiting.load(Ordering::Acquire));
    }

    #[test]
    fn a_failed_spawn_hands_the_gate_back_to_a_running_app() {
        let state = AppState::default();
        let was_exiting = gate_update_exiting(&state);
        release_update_gate(&state, was_exiting);
        assert!(!state.exiting.load(Ordering::Acquire));
    }

    #[test]
    fn a_failed_spawn_never_clears_a_genuine_exit() {
        // The app was already exiting before the update gate ran.
        let state = AppState::default();
        state.exiting.store(true, Ordering::Release);
        let was_exiting = gate_update_exiting(&state);
        assert!(was_exiting);
        release_update_gate(&state, was_exiting);
        assert!(state.exiting.load(Ordering::Acquire));

        // A genuine exit began while the installer was being fetched: the
        // exit handler marks it, so restoring must keep new starts blocked.
        let state = AppState::default();
        let was_exiting = gate_update_exiting(&state);
        state.begin_normal_exit();
        release_update_gate(&state, was_exiting);
        assert!(state.exiting.load(Ordering::Acquire));
    }
}
