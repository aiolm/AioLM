//! Benchmark execution, progress events and cancellation IPC.
use crate::{benchmark, config, performance_bench, procutil, runtime, state::AppState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, Arc};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, State};

#[tauri::command]
pub(crate) async fn benchmark_history_list(
    app: tauri::AppHandle,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<benchmark::store::HistoryPage, String> {
    let root = benchmark::data_root(&app)?;
    tokio::task::spawn_blocking(move || {
        benchmark::store::list(&root, offset.unwrap_or(0), limit.unwrap_or(20))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn benchmark_history_import(
    app: tauri::AppHandle,
    records: Vec<Value>,
) -> Result<usize, String> {
    let root = benchmark::data_root(&app)?;
    tokio::task::spawn_blocking(move || benchmark::store::import(&root, records))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn benchmark_acknowledge_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    receipt: benchmark::store::UploadReceipt,
) -> Result<benchmark::store::Acknowledgement, String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "wait for the current operation before acknowledging a benchmark upload")?;
    let root = benchmark::data_root(&app)?;
    tokio::task::spawn_blocking(move || benchmark::store::acknowledge(&root, &run_id, receipt))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn benchmark_identify_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<benchmark::identity::ModelIdentity, String> {
    // Share the launch lock so multi-GB reads cannot start during measurements
    // or overlap a server/session launch. The lock stays held until hashing ends.
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "wait for the current operation before identifying a model")?;
    if state.runtime_busy.load(Ordering::Acquire) || state.exiting.load(Ordering::Acquire) {
        return Err("wait for the runtime operation before identifying a model".into());
    }
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned")?
        .lifecycle
        .blocks_resource_change()
        || state.sessions.entries().iter().any(|session| {
            session
                .state
                .lock()
                .map(|state| state.lifecycle.blocks_resource_change())
                .unwrap_or(true)
        })
    {
        return Err("stop all model sessions before identifying a model".into());
    }
    let root = benchmark::data_root(&app)?;
    tokio::task::spawn_blocking(move || benchmark::identity::identify(&root, Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

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
    let root = benchmark::data_root(&app)?;
    // Revoke ephemeral sharing permits the moment a measurement owns the
    // operation lock, so publishing work overlapping this start is discarded.
    crate::benchmark::sharing::permits::note_measurement_start();
    let initial = performance_bench::failed(&request, &cfg, "benchmark has not completed".into());
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let journal = Arc::new(benchmark::store::RunJournal::begin(
        &root,
        json!({
            "schemaVersion": 1, "id": request.run_id, "createdAt": created,
            "model": cfg.active_model, "backend": cfg.active_backend, "build": cfg.active_build,
            "request": request, "result": initial,
        }),
    )?);
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
            journal.finish(&result)?;
            state.bench_cancel.store(false, Ordering::Release);
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
    // The probe keeps the whole `--version` output, which is a banner plus
    // compiler lines. A benchmark records the version it was measured on, so
    // take the one line that states it and leave the diagnostics behind.
    let version = capability
        .as_ref()
        .and_then(|value| runtime::version_label(&value.version))
        .unwrap_or_else(|| performance_bench::UNKNOWN_RUNTIME_VERSION.to_string());
    let cache_ram_supported = capability.as_ref().is_some_and(|value| {
        value
            .flags
            .iter()
            .any(|flag| flag == "--cache-ram" || flag == "-cram")
    });
    // Reading the identity cache and the model header both touch the disk, so
    // they happen off the async runtime and before the first trial is set up;
    // no tensor is read, nothing is hashed and no request leaves the machine.
    let model_path = PathBuf::from(&cfg.active_model);
    let model_root = root.clone();
    let model = tokio::task::spawn_blocking(move || {
        let mut identity = benchmark::identity::cached(&model_root, &model_path);
        identity.metadata = benchmark::model_metadata::collect(&model_root, &model_path);
        identity
    })
    .await
    .map_err(|error| error.to_string())?;
    let mut provenance = benchmark::provenance::capture(
        &cfg,
        &gpu,
        crate::hardware::detect(),
        model,
        &request.context_profile,
        performance_bench::corpus_identity(&request.context_profile),
    );
    if let Some(capability) = &capability {
        benchmark::provenance::describe_runtime_selection(
            &mut provenance.environment,
            &cfg,
            &capability.devices,
        );
    }
    let trial_journal = journal.clone();
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
        performance_bench::RuntimeInfo {
            version,
            cache_ram_supported,
            provenance: Some(provenance),
            checkpoint: Some(Arc::new(move |result| trial_journal.checkpoint(result))),
        },
    )
    .await;
    state.bench_cancel.store(false, Ordering::Release);
    journal.finish(&result)?;
    Ok(result)
}
