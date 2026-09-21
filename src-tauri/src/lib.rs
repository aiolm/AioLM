//! Backend modules, public client APIs and desktop application startup.
pub mod app_update;
pub mod backends;
mod benchmark;
pub mod branding;
mod commands;
pub mod config;
mod discover;
mod gateway;
pub mod gguf;
pub mod gpu;
pub mod hardware;
mod mcp;
pub mod models;
pub mod performance_bench;
pub mod performance_memory;
mod process_output;
mod procutil;
pub mod runtime;
pub mod server;
pub mod session;
mod state;
pub mod tuning_defaults;
pub mod verify;

pub use commands::launch::validate_launch_config;
pub use commands::models::deletable_model_path;
pub use config::AppConfig;
pub use server::ErrBuf;

use state::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent};

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
    state.sessions.cancel_all_pending_starts();
    // A window close can end the async build future before it observes
    // runtime_cancel. Kill the tracked CMake process trees while the app is
    // still alive so Ninja/compilers do not remain behind.
    runtime::terminate_active_builds();
    if let Ok(mut gateway) = state.gateway.lock() {
        if let Some(handle) = gateway.take() {
            handle.stop.store(true, Ordering::Release);
            handle.task.abort();
        }
    }
    if let Ok(pid) = state.bench_pid.lock() {
        if let Some(pid) = *pid {
            procutil::terminate_pid(pid);
        }
    }
    if let Ok(mut server) = state.server.lock() {
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
        if let Ok(mut server) = entry.state.lock() {
            server.cancel_launch();
            server::kill(&mut server.child, Some(entry.err.clone()));
            server.lifecycle = server::Lifecycle::Stopped;
            server.api_key.clear();
            server.redaction_secret.clear();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_update::check_app_update,
            commands::app_update::install_app_update,
            commands::app_update::open_app_update_release,
            commands::config::migration_paths,
            commands::config::get_config,
            commands::config::save_config,
            commands::models::list_models,
            commands::models::model_metadata,
            commands::models::cancel_model_scan,
            commands::models::delete_model,
            commands::models::pick_models_dir,
            commands::models::pick_lora_adapter,
            commands::discover::hf_search_models,
            commands::discover::hf_model_files,
            commands::discover::hf_download_model,
            commands::discover::hf_cancel_download,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_save_server,
            commands::mcp::mcp_remove_server,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
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
            commands::benchmark::benchmark_identify_model,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // A force-closed PR build can leave its archive, source tree, CMake tree,
    // staging directory, or activation backup behind. Sweep only exact,
    // age-qualified names, and keep the potentially slow removals off the
    // async runtime so the window can finish starting even if a directory is
    // locked by a compiler or virus scanner.
    tauri::async_runtime::spawn_blocking(runtime::sweep_orphaned_work);
    tauri::async_runtime::spawn(commands::server::idle_watchdog(app.handle().clone()));

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.begin_normal_exit();
                shutdown_managed_processes(&state);
            }
        }
    });
}
