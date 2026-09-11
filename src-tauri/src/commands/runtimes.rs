//! Managed runtime installation, selection, diagnostics and transfer IPC.
use crate::{backends, config, hardware, runtime, state::AppState};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, State};

struct RuntimeBusyGuard {
    busy: Arc<AtomicBool>,
}

impl RuntimeBusyGuard {
    fn acquire(busy: &Arc<AtomicBool>) -> Result<Self, String> {
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self { busy: busy.clone() })
            .map_err(|_| "another runtime operation is already in progress".to_string())
    }
}

impl Drop for RuntimeBusyGuard {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::Release);
    }
}

#[derive(serde::Serialize)]
pub(crate) struct DeviceReport {
    profile: hardware::DeviceProfile,
    backends: Vec<backends::BackendSuitability>,
}

/// Local hardware plus the backend verdicts derived from it. Detection is a
/// handful of registry reads, so it is recomputed per call rather than cached
/// into staleness when a GPU or driver changes.
#[tauri::command]
pub(crate) fn device_profile() -> DeviceReport {
    let profile = hardware::detect();
    let backends = backends::recommend(&profile);
    DeviceReport { profile, backends }
}

#[tauri::command]
pub(crate) async fn rt_list() -> Result<Vec<runtime::InstalledRuntime>, String> {
    tokio::task::spawn_blocking(runtime::list_installed)
        .await
        .map_err(|error| format!("runtime list task failed: {error}"))
}

#[tauri::command]
pub(crate) async fn rt_latest(
    backend: String,
    refresh: bool,
) -> Result<runtime::LatestInfo, String> {
    if refresh {
        runtime::clear_api_cache();
    }
    runtime::latest_for(&backend).await
}

#[tauri::command]
pub(crate) async fn rt_install(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    backend: String,
    build: String,
) -> Result<runtime::InstalledRuntime, String> {
    let _runtime_busy = RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?
            .lifecycle
            .blocks_resource_change()
        {
            return Err("stop the server before changing runtimes".into());
        }
    }
    runtime::validate_runtime_identifiers(&backend, &build)?;
    state.runtime_cancel.store(false, Ordering::Release);
    runtime::install(app, &backend, &build, state.runtime_cancel.clone()).await
}

/// Resolve a pull request for the confirmation dialog. Read-only: it touches
/// the GitHub API and nothing else, so it needs no operation lock.
#[tauri::command]
pub(crate) async fn rt_pr_preview(
    backend: String,
    source: String,
) -> Result<runtime::PullRequestPreview, String> {
    runtime::validate_source_build_backend(&backend)?;
    let preview = runtime::pull_request_preview(&backend, &source).await?;
    // A published artifact is already compiled and can be installed on a
    // machine with no CMake/compiler/SDK. If there is no matching artifact,
    // retain the local source-build preflight so the confirmation dialog never
    // promises an install that cannot start.
    if preview.artifact.is_none() {
        runtime::source_build_preflight(&backend).await.map_err(|error| {
            if let Some(artifact_error) = preview.artifact_error.as_deref() {
                format!(
                    "prebuilt PR artifact lookup failed: {artifact_error}; local source build is unavailable: {error}"
                )
            } else {
                format!(
                    "no compatible prebuilt PR artifact is published for this PC, and local source build is unavailable: {error}"
                )
            }
        })?;
    }
    Ok(preview)
}

#[tauri::command]
pub(crate) async fn rt_install_pr(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    backend: String,
    source: String,
    confirmed_commit: String,
) -> Result<runtime::InstalledRuntime, String> {
    let _runtime_busy = RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?
            .lifecycle
            .blocks_resource_change()
        {
            return Err("stop the server before changing runtimes".into());
        }
    }
    // Re-validated here rather than trusted from the caller: the frontend's
    // checks are for the user's benefit, these are the ones that bind.
    runtime::validate_source_build_backend(&backend)?;
    runtime::pull_request_build_id(&source)?;
    state.runtime_cancel.store(false, Ordering::Release);
    runtime::install_pr(
        app,
        &backend,
        &source,
        &confirmed_commit,
        state.runtime_cancel.clone(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn rt_export(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    backend: String,
    build: String,
) -> Result<runtime::RuntimeBundleInfo, String> {
    let _runtime_busy = RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?
            .lifecycle
            .blocks_resource_change()
        {
            return Err("stop the server before exporting a runtime".into());
        }
    }
    runtime::validate_runtime_identifiers(&backend, &build)?;
    let suggested_name = format!("aiolm-runtime-{backend}-{build}.zip");
    let path = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Export aiolm runtime bundle")
            .set_file_name(&suggested_name)
            .add_filter("aiolm runtime bundle", &["zip"])
            .save_file()
    })
    .await
    .map_err(|error| format!("runtime export picker failed: {error}"))?
    .ok_or_else(|| "runtime export cancelled".to_string())?;
    state.runtime_cancel.store(false, Ordering::Release);
    let cancel = state.runtime_cancel.clone();
    let progress_build = build.clone();
    tokio::task::spawn_blocking(move || {
        runtime::export_bundle(
            &path,
            &backend,
            &build,
            &|phase, received, total| {
                let _ = app.emit(
                    "runtime-download-progress",
                    serde_json::json!({
                    "backend": "export",
                    "build": progress_build,
                        "phase": phase,
                        "received": received,
                        "total": total
                    }),
                );
            },
            &cancel,
        )
    })
    .await
    .map_err(|error| format!("runtime export task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn rt_import(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<runtime::InstalledRuntime, String> {
    let _runtime_busy = RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?
            .lifecycle
            .blocks_resource_change()
        {
            return Err("stop the server before importing a runtime".into());
        }
    }
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Import aiolm runtime bundle")
            .add_filter("aiolm runtime bundle", &["zip"])
            .pick_file()
    })
    .await
    .map_err(|error| format!("runtime import picker failed: {error}"))?
    .ok_or_else(|| "runtime import cancelled".to_string())?;
    state.runtime_cancel.store(false, Ordering::Release);
    let cancel = state.runtime_cancel.clone();
    let progress_app = app.clone();
    runtime::import_bundle(
        &path,
        &|phase, received, total| {
            let _ = progress_app.emit(
                "runtime-download-progress",
                serde_json::json!({
                    "backend": "import",
                    "build": "bundle",
                    "phase": phase,
                    "received": received,
                    "total": total
                }),
            );
        },
        cancel,
    )
    .await
}

#[tauri::command]
pub(crate) fn rt_cancel(state: State<'_, AppState>) {
    state.runtime_cancel.store(true, Ordering::Release);
}

#[tauri::command]
pub(crate) async fn rt_uninstall(
    state: State<'_, AppState>,
    backend: String,
    build: String,
) -> Result<(), String> {
    let _runtime_busy = RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?
            .lifecycle
            .blocks_resource_change()
        {
            return Err("stop the server before changing runtimes".into());
        }
    }
    {
        let _config_write = state.config_write.lock().await;
        let cfg = config::load_result()?;
        if cfg.active_backend == backend && cfg.active_build == build {
            return Err("select another runtime before uninstalling the active runtime".into());
        }
    }
    tokio::task::spawn_blocking(move || runtime::uninstall(&backend, &build))
        .await
        .map_err(|error| format!("runtime uninstall task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn rt_select(
    state: State<'_, AppState>,
    backend: String,
    build: String,
) -> Result<config::AppConfig, String> {
    let _runtime_busy = RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?
            .lifecycle
            .blocks_resource_change()
        {
            return Err("stop the server before selecting a different runtime".into());
        }
    }
    runtime::validate_runtime_identifiers(&backend, &build)?;
    let server = runtime::server_bin_for(&backend, &build)?;
    let bench = runtime::bench_bin_for(&backend, &build)?;
    if !server.is_file() || !bench.is_file() {
        return Err("the selected runtime is not installed completely".into());
    }
    runtime::repair_runtime_dependencies(&backend, &build, Arc::new(AtomicBool::new(false)))
        .await?;
    let capabilities = runtime::probe(&backend, &build).await?;
    if capabilities.state != "available" {
        let details = capabilities.diagnostics.join("; ");
        return Err(format!(
            "the selected runtime failed preflight ({}): {}",
            capabilities.state,
            if details.is_empty() {
                "no diagnostics"
            } else {
                &details
            }
        ));
    }
    let _config_write = state.config_write.lock().await;
    let mut cfg = config::load_result()?;
    cfg.active_backend = backend;
    cfg.active_build = build;
    config::save(&cfg)
}

#[tauri::command]
pub(crate) async fn rt_probe(
    backend: String,
    build: String,
) -> Result<runtime::RuntimeCapabilities, String> {
    runtime::probe(&backend, &build).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_busy_guard_releases_on_every_exit_path() {
        let busy = Arc::new(AtomicBool::new(false));
        for _ in 0..3 {
            {
                let guard = super::RuntimeBusyGuard::acquire(&busy).expect("acquire runtime");
                assert!(super::RuntimeBusyGuard::acquire(&busy).is_err());
                // Dropping this guard models success, an error, and a
                // cancellation unwinding the async install future.
                drop(guard);
            }
            assert!(!busy.load(std::sync::atomic::Ordering::Acquire));
        }
    }
}
