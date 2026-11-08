//! Benchmark execution, progress events and cancellation IPC.
use crate::{benchmark, config, performance_bench, state::AppState};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, State};

#[tauri::command]
pub(crate) async fn benchmark_history_list(
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<benchmark::store::HistoryPage, String> {
    let root = benchmark::data_root()?;
    tokio::task::spawn_blocking(move || {
        benchmark::store::list(&root, offset.unwrap_or(0), limit.unwrap_or(20))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn benchmark_history_import(records: Vec<Value>) -> Result<usize, String> {
    let root = benchmark::data_root()?;
    tokio::task::spawn_blocking(move || benchmark::store::import(&root, records))
        .await
        .map_err(|error| error.to_string())?
}

/// Delete one local history record. Active runs are rejected by the store's
/// OS locks; public submissions and upload receipts are left untouched.
#[tauri::command]
pub(crate) async fn benchmark_history_delete(run_id: String) -> Result<(), String> {
    let root = benchmark::data_root()?;
    tokio::task::spawn_blocking(move || benchmark::store::delete(&root, &run_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn benchmark_acknowledge_upload(
    state: State<'_, AppState>,
    run_id: String,
    receipt: benchmark::store::UploadReceipt,
) -> Result<benchmark::store::Acknowledgement, String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "wait for the current operation before acknowledging a benchmark upload")?;
    let root = benchmark::data_root()?;
    tokio::task::spawn_blocking(move || benchmark::store::acknowledge(&root, &run_id, receipt))
        .await
        .map_err(|error| error.to_string())?
}

/// Save benchmark CSV text through a native save dialog. Returns `false` when
/// the user cancels; the destination is only ever chosen in that dialog.
/// `file_name` only pre-fills the dialog and falls back to the default when it
/// is missing or not a plain `.csv` base name.
#[tauri::command]
pub(crate) async fn benchmark_export_csv(
    contents: String,
    file_name: Option<String>,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let file_name = benchmark::csv_export::suggested_file_name(file_name.as_deref());
        benchmark::csv_export::save(&contents, || {
            rfd::FileDialog::new()
                .set_file_name(file_name)
                .add_filter("CSV", &["csv"])
                .save_file()
        })
    })
    .await
    .map_err(|error| format!("The benchmark CSV export task failed: {error}"))?
}

/// Save a finished benchmark XLSX workbook through a native save dialog. The
/// bytes are written exactly as received. Returns `false` when the user
/// cancels; the destination is only ever chosen in that dialog. `file_name`
/// only pre-fills the dialog and falls back to the default when it is missing
/// or not a plain `.xlsx` base name.
#[tauri::command]
pub(crate) async fn benchmark_export_xlsx(
    contents: Vec<u8>,
    file_name: Option<String>,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let file_name = benchmark::csv_export::suggested_xlsx_file_name(file_name.as_deref());
        benchmark::csv_export::save_xlsx(&contents, || {
            rfd::FileDialog::new()
                .set_file_name(file_name)
                .add_filter("Excel workbook", &["xlsx"])
                .save_file()
        })
    })
    .await
    .map_err(|error| format!("The benchmark XLSX export task failed: {error}"))?
}

#[tauri::command]
pub(crate) fn bench_cancel(state: State<'_, AppState>) {
    state.bench_cancel.store(true, Ordering::Release);
    if let Some(process) = state
        .bench_process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        process.terminate();
    }
}

/// Inspect only existing target metadata; ordinary launch preflight still runs
/// under the execution lock when the user starts a measurement.
#[tauri::command]
pub(crate) async fn performance_bench_admission(
    cfg: config::AppConfig,
    request: performance_bench::PerformanceBenchRequest,
) -> performance_bench::BenchmarkAdmission {
    performance_bench::admission(cfg, request).await
}

/// Run the common chat workload on a private launch without touching the
/// application's selected server state or saving the temporary configuration.
#[tauri::command]
pub(crate) async fn run_performance_bench(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    cfg: config::AppConfig,
    request: performance_bench::PerformanceBenchRequest,
) -> Result<performance_bench::PerformanceBenchResult, String> {
    let progress: performance_bench::Progress = Arc::new(move |progress| {
        let _ = app.emit("performance-bench-progress", progress);
    });
    run_performance_bench_with_progress(&state, cfg, request, progress).await
}

pub(crate) async fn run_performance_bench_with_progress(
    state: &AppState,
    mut cfg: config::AppConfig,
    mut request: performance_bench::PerformanceBenchRequest,
    progress: performance_bench::Progress,
) -> Result<performance_bench::PerformanceBenchResult, String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "another server or benchmark operation is in progress".to_string())?;
    let validation = performance_bench::validate_execution_request(&mut request).and_then(|()| {
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
    validation?;
    // Admission may probe the target but is not a measurement: rejection must
    // neither invalidate sharing permits nor create an empty failed journal.
    state.bench_cancel.store(false, Ordering::Release);
    let cancel = state.bench_cancel.clone();
    progress(performance_bench::PerformanceBenchProgress {
        run_id: request.run_id.clone(),
        phase: "loading",
        completed: 0,
        total: request.prompt_bytes.len()
            * request.concurrencies.len()
            * request.repetitions as usize,
        row: None,
        message: None,
    });
    let admitted = async {
        let gpu =
            crate::launch_validation::validate_launch_config_with_cancel(&mut cfg, Some(&cancel))
                .await?;
        let runtime = performance_bench::RuntimeInfo::prepare(&cfg, &request).await?;
        Ok::<_, String>((gpu, runtime))
    }
    .await;
    let (gpu, mut runtime) = match admitted {
        Ok(admitted) if !cancel.load(Ordering::Acquire) => admitted,
        Ok(_) => {
            state.bench_cancel.store(false, Ordering::Release);
            return Err("benchmark cancelled before measurement".into());
        }
        Err(error) => {
            state.bench_cancel.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let root = benchmark::data_root()?;
    let mut initial =
        performance_bench::failed(&request, &cfg, "benchmark has not completed".into());
    initial.provenance = Some(runtime.provenance.clone());
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let journal = Arc::new(benchmark::store::RunJournal::begin(
        &root,
        json!({
            "schemaVersion": 2, "id": request.run_id, "createdAt": created,
            "model": cfg.active_model,
            "request": request, "result": initial,
        }),
    )?);
    crate::benchmark::sharing::permits::note_measurement_start();
    let trial_journal = journal.clone();
    runtime.checkpoint = Some(Arc::new(move |result| trial_journal.checkpoint(result)));
    let result = performance_bench::run(
        cfg,
        request,
        gpu,
        cancel,
        state.bench_process.clone(),
        progress,
        runtime,
    )
    .await;
    state.bench_cancel.store(false, Ordering::Release);
    journal.finish(&result)?;
    Ok(result)
}
