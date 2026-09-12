//! Benchmark execution, progress events and cancellation IPC.
use crate::{config, performance_bench, procutil, runtime, state::AppState};
use std::sync::{atomic::Ordering, Arc};
use tauri::{Emitter, State};

#[tauri::command]
pub(crate) fn bench_cancel(state: State<'_, AppState>) {
    state.bench_cancel.store(true, Ordering::Release);
    if let Ok(pid) = state.bench_pid.lock() {
        if let Some(pid) = *pid {
            procutil::terminate_pid(pid);
        }
    }
}

/// Run a cold-prompt workload on a private server without touching the
/// application's selected server state or saving the temporary configuration.
#[tauri::command]
pub(crate) async fn run_performance_bench(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut cfg: config::AppConfig,
    mut request: performance_bench::PerformanceBenchRequest,
) -> Result<performance_bench::PerformanceBenchResult, String> {
    // Reject overlapping launches instead of queuing a run whose cancel
    // request could otherwise be consumed by the currently active benchmark.
    let Ok(_operation) = state.operation.try_lock() else {
        return Ok(performance_bench::failed(
            &request,
            &cfg,
            "another server or benchmark operation is in progress".into(),
        ));
    };
    let validation = performance_bench::validate_request(&mut request).and_then(|()| {
        cfg.normalize();
        cfg.validate()?;
        if state.runtime_busy.load(Ordering::Acquire) || state.exiting.load(Ordering::Acquire) {
            return Err("wait for the runtime operation to finish before benchmarking".into());
        }
        if state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned")?
            .lifecycle
            .blocks_resource_change()
        {
            return Err("stop the server before running a benchmark".into());
        }
        for session in state.sessions.entries() {
            if session
                .state
                .lock()
                .map_err(|_| "session state lock was poisoned")?
                .lifecycle
                .blocks_resource_change()
            {
                return Err("stop all model sessions before running a benchmark".into());
            }
        }
        Ok(())
    });
    if let Err(error) = validation {
        return Ok(performance_bench::failed(&request, &cfg, error));
    }
    state.bench_cancel.store(false, Ordering::Release);
    let cancel = state.bench_cancel.clone();
    let loading = performance_bench::PerformanceBenchProgress {
        run_id: request.run_id.clone(),
        phase: "loading",
        completed: 0,
        total: request.prompt_lengths.len()
            * (1 + request.batch_sizes.len())
            * request.repetitions as usize,
        row: None,
        message: None,
    };
    let _ = app.emit("performance-bench-progress", loading);
    let gpu = match super::launch::validate_launch_config_with_cancel(&mut cfg, Some(&cancel)).await
    {
        Ok(gpu) => gpu,
        Err(error) => {
            let mut result = performance_bench::failed(&request, &cfg, error);
            if cancel.load(Ordering::Acquire) {
                result.status = "cancelled";
            }
            return Ok(result);
        }
    };
    let capability = if !cfg.active_backend.is_empty() {
        runtime::probe_cancellable(&cfg.active_backend, &cfg.active_build, &cancel)
            .await
            .ok()
    } else {
        None
    };
    let version = capability
        .as_ref()
        .map(|value| value.version.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".into());
    let cache_ram_supported = capability.as_ref().is_some_and(|value| {
        value
            .flags
            .iter()
            .any(|flag| flag == "--cache-ram" || flag == "-cram")
    });
    let progress: performance_bench::Progress = Arc::new(move |progress| {
        let _ = app.emit("performance-bench-progress", progress);
    });
    let result = performance_bench::run(
        cfg,
        request,
        gpu,
        cancel,
        state.bench_pid.clone(),
        progress,
        version,
        cache_ram_supported,
    )
    .await;
    state.bench_cancel.store(false, Ordering::Release);
    Ok(result)
}
