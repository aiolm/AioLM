//! Benchmark execution, progress events and cancellation IPC.
use crate::{bench, config, state::AppState};
use std::path::Path;
use std::sync::{atomic::Ordering, Arc};
use tauri::{Emitter, State};

#[tauri::command]
pub(crate) async fn run_bench(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut cfg: config::AppConfig,
) -> Result<bench::BenchResult, String> {
    let _operation = state.operation.lock().await;
    cfg.normalize();
    cfg.validate()?;
    if cfg.active_model.trim().is_empty() || !Path::new(&cfg.active_model).is_file() {
        return Err("select an existing GGUF model before benchmarking".into());
    }
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?
        .lifecycle
        .blocks_resource_change()
    {
        return Err("stop the server before running a benchmark".into());
    }
    state.bench_cancel.store(false, Ordering::Release);
    let cancel = state.bench_cancel.clone();
    let active_pid = state.bench_pid.clone();
    let progress_app = app.clone();
    let progress: bench::BenchProgress = Arc::new(move |row: &bench::BenchRow| {
        let _ = progress_app.emit("bench-progress", row.clone());
    });
    let result = tokio::task::spawn_blocking(move || {
        bench::run_with_progress(&cfg, cancel, Some(active_pid), Some(progress))
    })
    .await
    .map_err(|error| format!("benchmark task failed: {error}"))?;
    state.bench_cancel.store(false, Ordering::Release);
    result
}

#[tauri::command]
pub(crate) fn bench_cancel(state: State<'_, AppState>) {
    state.bench_cancel.store(true, Ordering::Release);
    if let Ok(pid) = state.bench_pid.lock() {
        if let Some(pid) = *pid {
            bench::terminate_pid(pid);
        }
    }
}
