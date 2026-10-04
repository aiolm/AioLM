//! The system-tray presence behind the close-to-tray setting.
//!
//! The tray icon exists exactly while `AppConfig::close_to_tray` is on, so a
//! user who leaves the setting off never gains a tray icon they did not ask
//! for, and a user who turns it on always has somewhere to click to get the
//! window back. Everything here is keyed by a fixed id and looked up through
//! the app handle, so turning the setting on and off does not need a handle
//! parked in shared state.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

const TRAY_ID: &str = "aiolm-tray";
const SHOW_ITEM: &str = "aiolm-tray-show";
const QUIT_ITEM: &str = "aiolm-tray-quit";
/// The tray menu is drawn by the operating system before any window exists to
/// report the chosen language, so its two entries are written in the same
/// language as the application's other native dialogs.
const SHOW_LABEL: &str = "Show AioLM";
const QUIT_LABEL: &str = "Quit AioLM";

/// Bring the window back from the tray, or when the application is opened
/// again while it is already running. Restoring covers all three states a
/// hidden window can be in: hidden, minimized, and merely behind other windows.
pub(crate) fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Whether the tray icon this module manages is on screen right now.
pub(crate) fn is_present<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY_ID).is_some() && host_available()
}

#[cfg(target_os = "linux")]
fn host_available() -> bool {
    use gio::glib::variant::ToVariant;
    // AppIndicator creation can succeed without a desktop hosting its icon.
    // Check the host again on close, including after a desktop shell restart.
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) else {
        return false;
    };
    bus.call_sync(
        Some("org.kde.StatusNotifierWatcher"),
        "/StatusNotifierWatcher",
        "org.freedesktop.DBus.Properties",
        "Get",
        Some(
            &(
                "org.kde.StatusNotifierWatcher",
                "IsStatusNotifierHostRegistered",
            )
                .to_variant(),
        ),
        None,
        gio::DBusCallFlags::NO_AUTO_START,
        500,
        None::<&gio::Cancellable>,
    )
    .ok()
    .and_then(|reply| reply.get::<(gio::glib::Variant,)>())
    .and_then(|(value,)| value.get::<bool>())
    .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn host_available() -> bool {
    true
}

/// Add or remove the tray icon so that it is present exactly while closing the
/// window hides the application. Idempotent: applying the setting it already
/// has leaves the existing icon (and its menu) alone rather than rebuilding it.
pub(crate) fn apply<R: Runtime>(app: &AppHandle<R>, close_to_tray: bool) -> Result<(), String> {
    if !close_to_tray {
        // The icon belongs to the thread that created it - the main thread -
        // and the window behind it can only be destroyed there, so removing it
        // straight from the IPC thread that saves the setting would leave the
        // icon on screen. `run_on_main_thread` runs the closure inline when it
        // is already the main thread, so startup does not wait on itself, and
        // waiting for the reply keeps `is_present` truthful for the caller that
        // may have to put the icon back.
        let (done, wait) = std::sync::mpsc::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            handle.remove_tray_by_id(TRAY_ID);
            let _ = done.send(());
        })
        .map_err(|error| format!("failed to remove the tray icon: {error}"))?;
        wait.recv()
            .map_err(|_| "failed to remove the tray icon".to_string())?;
        return Ok(());
    }
    if !host_available() {
        return Err("the desktop has no available system tray host".into());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, SHOW_ITEM, SHOW_LABEL, true, None::<&str>)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let quit = MenuItem::with_id(app, QUIT_ITEM, QUIT_LABEL, true, None::<&str>)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let menu = Menu::with_items(app, &[&show, &quit])
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("AioLM")
        .menu(&menu)
        // Windows convention: the left button brings the window back and the
        // right button opens the menu. Without this the left button would open
        // the menu instead and there would be no one-click way back.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            SHOW_ITEM => restore_main_window(app),
            // The only way out of the application once its window lives in the
            // tray. It goes through the normal exit, so `RunEvent::Exit` still
            // stops every managed llama-server, the gateway and the background
            // jobs before the process ends.
            QUIT_ITEM => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });
    // The window icon is embedded at build time; a build without one still gets
    // a working tray entry rather than no way back to the window.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .build(app)
        .map(|_| ())
        .map_err(|error| format!("failed to create the tray icon: {error}"))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    #[ignore = "requires an isolated session bus; set AIOLM_TRAY_SMOKE=available or unavailable"]
    fn real_tray_host_presence() {
        let expected = match std::env::var("AIOLM_TRAY_SMOKE").as_deref() {
            Ok("available") => true,
            Ok("unavailable") => false,
            _ => panic!("set AIOLM_TRAY_SMOKE=available or unavailable"),
        };
        assert_eq!(super::host_available(), expected);
    }
}
