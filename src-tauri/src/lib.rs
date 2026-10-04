//! Backend modules, public client APIs and desktop application startup.
pub mod app_update;
pub mod backends;
mod benchmark;
pub mod branding;
mod commands;
pub mod config;
mod conversations;
mod discover;
mod gateway;
pub mod gguf;
pub mod gpu;
pub mod hardware;
mod hardware_memory;
pub mod home;
mod inference_args;
mod mcp;
pub mod models;
pub mod performance_bench;
pub mod performance_memory;
mod personalization;
mod process_output;
mod procutil;
mod resource_estimate;
pub mod runtime;
pub mod server;
pub mod session;
#[cfg(windows)]
mod startup;
mod state;
mod tray;
pub mod tuning_defaults;
pub mod verify;

pub use commands::launch::validate_launch_config;
pub use commands::models::deletable_model_path;
pub use config::AppConfig;
pub use server::ErrBuf;

use state::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent, WindowEvent};

/// Stop every managed child process and cancel background work, synchronously.
///
/// This is the same cleanup the exit handler runs, minus the `exiting` flag,
/// which each caller sets itself: the exit handler marks a genuine exit while
/// the update installer path gates `exiting` just before calling this, so no
/// new server or job can start between the cleanup and the installer spawn.
/// The update installer replaces files this process holds open and its
/// "application is running" check can force-kill this process, so the llama
/// servers, gateway, benchmark, build and discovery jobs must already be down
/// before the installer starts. It runs after the installer has been verified
/// and just before it is spawned, so a failed download or hash leaves running
/// sessions untouched; if the spawn itself fails the app stays open and usable
/// (servers already stopped) with an error.
pub(crate) fn shutdown_managed_processes(state: &AppState) {
    state.bench_cancel.store(true, Ordering::Release);
    state.runtime_cancel.store(true, Ordering::Release);
    state.discover_cancel.store(true, Ordering::Release);
    state.verify_cancel.store(true, Ordering::Release);
    state.sessions.cancel_all_pending_starts();
    // A window close can end the async build future before it observes
    // runtime_cancel. Kill the tracked CMake process trees while the app is
    // still alive so Ninja/compilers do not remain behind.
    procutil::terminate_transient_processes();
    // Withdraw MCP approval prompts too, so none outlives an update shutdown.
    mcp::cancel_all_tool_calls();
    commands::gateway::abort_gateway_now(state);
    // Bench/model children are already covered by the process-owner registry.
    // Recover poisoned state locks so credentials/readers are still released.
    {
        let mut server = state.server.lock().unwrap_or_else(|e| e.into_inner());
        server.cancel_launch();
        server::kill(&mut server.child, Some(state.err.clone()));
        server.lifecycle = server::Lifecycle::Stopped;
        server.api_key.clear();
        server.redaction_secret.clear();
    }
    // Every additional session started alongside the default one is its own
    // untracked-by-the-OS process tree; nothing else in the app kills these
    // once the window is gone.
    for entry in state.sessions.entries() {
        {
            let mut server = entry.state.lock().unwrap_or_else(|e| e.into_inner());
            server.cancel_launch();
            server::kill(&mut server.child, Some(entry.err.clone()));
            server.lifecycle = server::Lifecycle::Stopped;
            server.api_key.clear();
            server.redaction_secret.clear();
        }
    }
}

/// Whether this close should hide the window instead of ending the session.
///
/// The setting is read from the saved configuration at close time rather than
/// cached, so turning it off in Settings takes effect on the very next close.
/// A configuration that cannot be read closes the way the application always
/// has, and so does a build whose tray icon never appeared.
fn closes_to_tray(app: &tauri::AppHandle) -> bool {
    config::load_result().is_ok_and(|cfg| cfg.close_to_tray) && tray::is_present(app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(windows)]
    let instance_startup = startup::InstanceStartupLock::acquire(&context.config().identifier)
        .expect("error coordinating application startup");

    let builder = tauri::Builder::default()
        // Opening AioLM while it is already running - most visibly while its
        // window is hidden in the tray - brings that window back instead of
        // starting a second copy with a tray icon of its own. The new process
        // exits while the application is built, before `run` creates its window
        // and before the tray icon below exists, so it leaves neither behind.
        // It stays the first plugin so that no other plugin sets anything up in
        // a process that is about to exit.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::restore_main_window(app);
        }))
        // Completion alerts use the official plugin's native path on every
        // desktop OS. The frontend awaits its `notify` command directly: on
        // desktop that call only confirms the toast was prepared and handed to
        // the OS, never that the OS displayed it.
        .plugin(tauri_plugin_notification::init());
    // Native WKWebView acceptance needs an embedded driver on macOS. It is
    // explicitly opted into by CI and can never open an automation endpoint in
    // a release build, even if a caller enables every Cargo feature.
    #[cfg(all(debug_assertions, target_os = "macos", feature = "macos-ui-smoke"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let app = builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::benchmark_explorer::open_aiolm_website,
            commands::benchmark_explorer::open_benchmark_explorer,
            commands::benchmark_explorer::read_public_benchmark,
            commands::app_update::check_app_update,
            commands::app_update::install_app_update,
            commands::app_update::open_app_update_release,
            commands::config::migration_paths,
            commands::config::get_config,
            commands::config::save_config,
            commands::conversations::conversations_load,
            commands::conversations::conversation_save,
            commands::conversations::conversation_delete,
            commands::conversations::conversations_import,
            commands::conversations::conversations_clear,
            commands::personalization::chat_personalization,
            commands::personalization::personalization_read_skill,
            commands::personalization::personalization_read_agents,
            commands::personalization::personalization_save_agents,
            commands::models::list_models,
            commands::models::model_metadata,
            commands::models::estimate_model_resources,
            commands::models::cancel_model_scan,
            commands::models::delete_model,
            commands::models::pick_models_dir,
            commands::models::pick_lora_adapter,
            commands::discover::hf_search_models,
            commands::discover::hf_model_files,
            commands::discover::hf_open_model_card,
            commands::discover::hf_download_model,
            commands::discover::hf_cancel_download,
            commands::discover::hf_installed_files,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_save_server,
            commands::mcp::mcp_remove_server,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_cancel_tool_call,
            commands::documents::pick_attachment,
            commands::documents::pick_document,
            commands::documents::read_document_text,
            commands::documents::read_document_binding,
            commands::documents::pick_image,
            commands::documents::read_image_data,
            commands::server::start_server,
            commands::launch::preflight_launch,
            commands::launch::verify_model_deeply,
            commands::launch::verify_cancel,
            commands::launch::allow_verification_override,
            commands::server::stop_server,
            commands::server::unload_model,
            commands::sessions::session_list,
            commands::sessions::session_summary_list,
            commands::sessions::session_start,
            commands::sessions::session_stop,
            commands::sessions::session_unload,
            commands::gateway::start_api_server,
            commands::gateway::stop_api_server,
            commands::gateway::api_server_status,
            commands::gateway::start_anthropic_gateway,
            commands::gateway::stop_anthropic_gateway,
            commands::gateway::anthropic_gateway_status,
            commands::server::server_activity,
            commands::server::apply_request_settings,
            commands::server::server_status,
            commands::benchmark::run_performance_bench,
            commands::benchmark::bench_cancel,
            commands::benchmark::benchmark_history_list,
            commands::benchmark::benchmark_history_import,
            commands::benchmark::benchmark_history_delete,
            commands::benchmark::benchmark_export_csv,
            commands::benchmark::benchmark_export_xlsx,
            commands::benchmark::benchmark_acknowledge_upload,
            commands::benchmark_sharing::benchmark_sharing_configuration,
            commands::benchmark_sharing::benchmark_sharing_prepare,
            commands::benchmark_sharing::benchmark_sharing_begin_verification,
            commands::benchmark_sharing::benchmark_sharing_poll_verification,
            commands::benchmark_sharing::benchmark_sharing_submit,
            commands::benchmark_sharing::benchmark_sharing_cancel,
            commands::benchmark_sharing::benchmark_sharing_owned_list,
            commands::benchmark_sharing::benchmark_sharing_recovery_export,
            commands::benchmark_sharing::benchmark_sharing_recovery_import,
            commands::benchmark_sharing::benchmark_sharing_recovery_copy,
            commands::benchmark_sharing::benchmark_sharing_open_management,
            commands::runtimes::rt_list,
            commands::runtimes::rt_latest,
            commands::runtimes::rt_install,
            commands::runtimes::rt_install_pr,
            commands::runtimes::rt_pr_preview,
            commands::runtimes::rt_export,
            commands::runtimes::rt_import,
            commands::runtimes::rt_cancel,
            commands::runtimes::rt_uninstall,
            commands::runtimes::device_profile,
            commands::runtimes::rt_probe
        ])
        // The main window is created hidden (`visible: false` in the
        // configuration) and only shown here, after its webview exists.
        // WebView2 cannot attach to a window that gets minimized while the
        // webview is still being created; the runtime then drops the window but
        // keeps the process, which would leave AioLM running with no window and
        // hand every later launch to that process.
        //
        // On Windows and Linux the app draws its own title bar, so the native
        // frame is removed here, while the window is still hidden, rather than
        // after it appears. The OS keeps resizing from the edges, the Windows
        // drop shadow and rounded corners (`shadow` defaults on), and closing
        // still goes through `CloseRequested`, so the tray setting below keeps
        // working. macOS keeps its native frame and traffic lights. The
        // frontend asks `isDecorated()` instead of guessing the platform, so a
        // frame that could not be removed simply keeps the native title bar.
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(any(windows, target_os = "linux"))]
                if let Err(error) = window.set_decorations(false) {
                    eprintln!("could not remove the native title bar: {error}");
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application");

    #[cfg(windows)]
    drop(instance_startup);

    // The plugin has now rejected secondary launches. Only the primary may
    // prepare user data; otherwise another launch could stop at a migration
    // error instead of restoring it. Tauri creates the webview in `run`, so
    // this still completes before WebView2 can open the profile being copied.
    while let Err(error) = branding::prepare_desktop() {
        let retry = rfd::MessageDialog::new()
            .set_title("AioLM — Data migration")
            .set_description(format!("{error}\n\nYour original data has been preserved. Resolve the problem and select OK to retry, or Cancel to exit."))
            .set_buttons(rfd::MessageButtons::OkCancel)
            .set_level(rfd::MessageLevel::Error)
            .show();
        if retry != rfd::MessageDialogResult::Ok {
            return;
        }
    }
    // A fresh installation has no model folder yet. Create the one the default
    // configuration points at before the window exists, so the first scan the
    // frontend runs already finds a real (empty) folder rather than a path that
    // does not exist. A folder the user chose themselves is left untouched (see
    // `config::ensure_default_models_dir`), and a folder that cannot be created
    // is not fatal: `list_models` reports why when the models screen asks for
    // it, and the user can still choose another folder. A configuration that
    // cannot be read at all prepares nothing - the frontend's own `get_config`
    // reports that failure rather than this startup quietly standing in for it.
    let startup_config = match config::load_result() {
        Ok(cfg) => {
            if let Err(error) = config::ensure_default_models_dir(&cfg) {
                eprintln!("{error}");
            }
            Some(cfg)
        }
        Err(error) => {
            eprintln!("{error}");
            None
        }
    };

    // Only a configuration that asks to close to the tray gets a tray icon, so
    // nobody who leaves the setting off gains one they never asked for.
    if let Err(error) = tray::apply(
        app.handle(),
        startup_config.is_some_and(|cfg| cfg.close_to_tray),
    ) {
        eprintln!("{error}");
    }

    // A force-closed PR build can leave its archive, source tree, CMake tree,
    // staging directory, or activation backup behind. Sweep only exact,
    // age-qualified names, and keep the potentially slow removals off the
    // async runtime so the window can finish starting even if a directory is
    // locked by a compiler or virus scanner.
    tauri::async_runtime::spawn_blocking(runtime::sweep_orphaned_work);
    tauri::async_runtime::spawn(commands::server::idle_watchdog(app.handle().clone()));

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => tray::restore_main_window(app_handle),
        // Closing the main window hides it to the tray only while the setting
        // says so, and only while there is a tray icon to get it back from: a
        // tray that failed to appear must not swallow the window with no way to
        // restore it. Any other window closes as it always has, and so does the
        // main window whenever the setting is off - the app exits and stops
        // everything it started.
        RunEvent::WindowEvent {
            ref label,
            event: WindowEvent::CloseRequested { ref api, .. },
            ..
        } if label == "main" && closes_to_tray(app_handle) => {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        RunEvent::WindowEvent {
            ref label,
            event: WindowEvent::Destroyed,
            ..
        } if label == "main" => {
            // A public explorer window must not keep an otherwise closed app alive.
            app_handle.exit(0);
        }
        RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.begin_normal_exit();
                shutdown_managed_processes(&state);
            }
        }
        _ => {}
    });
}
