//! The system-tray presence behind the close-to-tray setting.
//!
//! The tray icon exists exactly while `AppConfig::close_to_tray` is on (the
//! default), so a user who turns the setting off loses a tray icon they no
//! longer need, and a user who keeps it on always has somewhere to click to
//! get the window back. Everything here is keyed by a fixed id and looked up
//! through the app handle, so turning the setting on and off does not need a
//! handle parked in shared state.

use std::sync::{Mutex, OnceLock};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

const TRAY_ID: &str = "aiolm-tray";
const STATUS_ITEM: &str = "aiolm-tray-status";
const SHOW_ITEM: &str = "aiolm-tray-show";
const STOP_ITEM: &str = "aiolm-tray-stop";
const QUIT_ITEM: &str = "aiolm-tray-quit";

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayPresentation {
    locale: String,
    model_state: String,
    model_name: Option<String>,
}

impl Default for TrayPresentation {
    fn default() -> Self {
        Self {
            locale: "en".to_owned(),
            model_state: "stopped".to_owned(),
            model_name: None,
        }
    }
}

static TRAY_STATE: OnceLock<Mutex<TrayPresentation>> = OnceLock::new();

fn tray_state() -> &'static Mutex<TrayPresentation> {
    TRAY_STATE.get_or_init(|| Mutex::new(TrayPresentation::default()))
}

struct TrayStrings {
    show: &'static str,
    quit: &'static str,
    stop_model: &'static str,
    status_idle: &'static str,
    status_starting: &'static str,
    status_stopping: &'static str,
    status_running_prefix: &'static str,
}

fn tray_strings(locale: &str) -> TrayStrings {
    match locale {
        "ko" => TrayStrings {
            show: "AioLM 열기",
            quit: "AioLM 종료",
            stop_model: "모델 중지",
            status_idle: "실행 중인 모델 없음",
            status_starting: "모델 시작 중…",
            status_stopping: "모델 중지 중…",
            status_running_prefix: "실행 중",
        },
        "ja" => TrayStrings {
            show: "AioLM を表示",
            quit: "AioLM を終了",
            stop_model: "モデルを停止",
            status_idle: "実行中のモデルなし",
            status_starting: "モデルを起動中…",
            status_stopping: "モデルを停止中…",
            status_running_prefix: "実行中",
        },
        "zh" => TrayStrings {
            show: "显示 AioLM",
            quit: "退出 AioLM",
            stop_model: "停止模型",
            status_idle: "无运行中的模型",
            status_starting: "正在启动模型…",
            status_stopping: "正在停止模型…",
            status_running_prefix: "运行中",
        },
        _ => TrayStrings {
            show: "Show AioLM",
            quit: "Quit AioLM",
            stop_model: "Stop model",
            status_idle: "No model running",
            status_starting: "Starting model…",
            status_stopping: "Stopping model…",
            status_running_prefix: "Running",
        },
    }
}

fn compact_model_label(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= 48 {
        trimmed.to_owned()
    } else {
        let prefix: String = trimmed.chars().take(47).collect();
        format!("{prefix}…")
    }
}

fn format_status_line(state: &TrayPresentation) -> (String, String, bool) {
    let strings = tray_strings(&state.locale);
    match state.model_state.as_str() {
        "running" => {
            let status = match state.model_name.as_deref().map(compact_model_label) {
                Some(name) if !name.is_empty() => format!("{}: {name}", strings.status_running_prefix),
                _ => strings.status_running_prefix.to_owned(),
            };
            let tooltip = format!("AioLM — {status}");
            (status, tooltip, true)
        }
        "starting" => (
            strings.status_starting.to_owned(),
            format!("AioLM — {}", strings.status_starting),
            true,
        ),
        "stopping" => (
            strings.status_stopping.to_owned(),
            format!("AioLM — {}", strings.status_stopping),
            false,
        ),
        _ => (strings.status_idle.to_owned(), "AioLM".to_owned(), false),
    }
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayPresentation,
) -> Result<(Menu<R>, String), String> {
    let strings = tray_strings(&state.locale);
    let (status_label, tooltip, can_stop) = format_status_line(state);
    let status = MenuItem::with_id(app, STATUS_ITEM, status_label, false, None::<&str>)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let sep1 = PredefinedMenuItem::separator(app)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let show = MenuItem::with_id(app, SHOW_ITEM, strings.show, true, None::<&str>)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let stop = MenuItem::with_id(app, STOP_ITEM, strings.stop_model, can_stop, None::<&str>)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let sep2 = PredefinedMenuItem::separator(app)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let quit = MenuItem::with_id(app, QUIT_ITEM, strings.quit, true, None::<&str>)
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    let menu = Menu::with_items(app, &[&status, &sep1, &show, &stop, &sep2, &quit])
        .map_err(|error| format!("failed to build the tray menu: {error}"))?;
    Ok((menu, tooltip))
}

/// Bring the window back from the tray, or when the application is opened
/// again while it is already running. Restoring covers all three states a
/// hidden window can be in: hidden, minimized, and merely behind other windows.
pub(crate) fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "linux")]
        {
            // GTK handles showing, deiconifying and activating as one request.
            // Separate queued requests can discard focus while the window's
            // minimized state is still being updated by the window manager.
            let restore = window.clone();
            let _ = window.run_on_main_thread(move || {
                use gtk::prelude::GtkWindowExt;
                if let Ok(native) = restore.gtk_window() {
                    native.present_with_time(gtk::current_event_time());
                }
            });
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

/// Carry out a choice from the tray menu. It is registered once on the
/// application builder rather than with each tray icon: Tauri keeps a tray
/// icon's menu handler in an application-wide list that removing the icon does
/// not shorten, so each time the setting was turned back on another copy would
/// run for every click.
pub(crate) fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id.as_ref() {
        SHOW_ITEM => restore_main_window(app),
        STOP_ITEM => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = handle.try_state::<crate::state::AppState>() {
                    let _ = crate::commands::server::stop_default_session(&state).await;
                }
            });
        }
        // The only way out of the application once its window lives in the
        // tray. It goes through the normal exit, so `RunEvent::Exit` still
        // stops every managed llama-server, the gateway and the background
        // jobs before the process ends.
        QUIT_ITEM => app.exit(0),
        _ => {}
    }
}

/// Whether the tray icon this module manages is on screen right now.
pub(crate) fn is_present<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY_ID).is_some() && host_available()
}

#[cfg(target_os = "linux")]
pub(crate) fn host_available() -> bool {
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
pub(crate) fn host_available() -> bool {
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
        // Keep an existing preference portable to a desktop without a tray.
        // The close handler will exit normally; other settings can still save.
        return Ok(());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let snapshot = tray_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let (menu, tooltip) = build_menu(app, &snapshot)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip)
        .menu(&menu)
        // Windows convention: the left button brings the window back and the
        // right button opens the menu. Without this the left button would open
        // the menu instead and there would be no one-click way back.
        .show_menu_on_left_click(false)
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

pub(crate) fn update_presentation<R: Runtime>(
    app: &AppHandle<R>,
    locale: &str,
    model_state: &str,
    model_name: Option<&str>,
) -> Result<(), String> {
    let next = TrayPresentation {
        locale: match locale {
            "ko" | "ja" | "zh" => locale.to_owned(),
            _ => "en".to_owned(),
        },
        model_state: model_state.to_owned(),
        model_name: model_name
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
    };
    {
        let mut guard = tray_state()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *guard == next {
            return Ok(());
        }
        *guard = next.clone();
    }
    if app.tray_by_id(TRAY_ID).is_none() {
        return Ok(());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            if let Ok((menu, tooltip)) = build_menu(&handle, &next) {
                let _ = tray.set_menu(Some(menu));
                let _ = tray.set_tooltip(Some(tooltip));
            }
        }
    })
    .map_err(|error| format!("failed to update the tray icon: {error}"))
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn tray_strings_cover_four_locales_with_english_fallback() {
        assert_eq!(tray_strings("en").show, "Show AioLM");
        assert_eq!(tray_strings("ko").show, "AioLM 열기");
        assert_eq!(tray_strings("ja").show, "AioLM を表示");
        assert_eq!(tray_strings("zh").show, "显示 AioLM");
        assert_eq!(tray_strings("fr").quit, "Quit AioLM");
    }

    #[test]
    fn tray_status_line_formats_states_and_bounds_long_names() {
        let idle = TrayPresentation::default();
        assert_eq!(
            format_status_line(&idle),
            ("No model running".to_owned(), "AioLM".to_owned(), false)
        );
        let long_name = "x".repeat(80);
        let running = TrayPresentation {
            locale: "ko".to_owned(),
            model_state: "running".to_owned(),
            model_name: Some(long_name),
        };
        let (status, tooltip, can_stop) = format_status_line(&running);
        assert!(status.starts_with("실행 중: "));
        assert!(status.ends_with('…'));
        assert!(tooltip.starts_with("AioLM — 실행 중: "));
        assert!(can_stop);
    }
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
