//! Provider-neutral discovery and installation IPC.
use crate::{
    config,
    providers::{self, artifacts::ModelArtifact, compat::ModelCompatibility, ProviderId},
    state::AppState,
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};
use tauri::{Emitter, State};

fn provider(value: &str) -> Result<ProviderId, String> {
    ProviderId::parse(value).ok_or_else(|| format!("unknown runtime provider: {value}"))
}

#[tauri::command]
pub(crate) fn provider_catalog() -> serde_json::Value {
    serde_json::json!(ProviderId::ALL.iter().map(|id| serde_json::json!({
        "id": id, "engine": id.engine(), "server": id.server(), "availability": id.availability(),
        "managed_version": providers::python_env::pinned_version(*id), "options": providers::options::schema(*id),
        "managed_variant": if *id == ProviderId::Vllm && cfg!(all(target_os = "macos", target_arch = "aarch64")) { Some("vllm-metal") } else { None }
    })).collect::<Vec<_>>())
}

#[tauri::command]
pub(crate) async fn provider_runtimes() -> Result<Vec<providers::RuntimeInstance>, String> {
    tokio::task::spawn_blocking(providers::list_runtime_instances)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn provider_runtime_options(
    provider_id: String,
    runtime_id: String,
) -> Result<Vec<providers::options::OptionSpec>, String> {
    let provider = provider(&provider_id)?;
    if provider == ProviderId::Llama || runtime_id.is_empty() {
        return Ok(providers::options::schema(provider).to_vec());
    }
    let runtime = providers::python_env::read(provider, &runtime_id)?;
    Ok(providers::launch::option_schema(&runtime))
}

#[tauri::command]
pub(crate) async fn provider_register(
    state: State<'_, AppState>,
    provider_id: String,
    python: String,
) -> Result<providers::python_env::PythonRuntimeManifest, String> {
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    let _operation = state.operation.lock().await;
    if super::runtimes::runtime_resources_in_use(&state)? {
        return Err("stop model sessions before changing runtimes".into());
    }
    providers::python_env::register_external(provider(&provider_id)?, Path::new(&python)).await
}

#[tauri::command]
pub(crate) async fn provider_install(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    provider_id: String,
    python: Option<String>,
) -> Result<providers::python_env::PythonRuntimeManifest, String> {
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if super::runtimes::runtime_resources_in_use(&state)? {
            return Err("stop model sessions before changing runtimes".into());
        }
    }
    state.runtime_cancel.store(false, Ordering::Release);
    providers::python_env::install_managed(
        provider(&provider_id)?,
        python.map(PathBuf::from),
        None,
        state.runtime_cancel.clone(),
        move |progress| {
            let _ = app.emit("provider-install-progress", progress);
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn provider_remove(
    state: State<'_, AppState>,
    provider_id: String,
    runtime_id: String,
) -> Result<(), String> {
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    let _operation = state.operation.lock().await;
    if super::runtimes::runtime_resources_in_use(&state)? {
        return Err("stop model sessions before removing runtimes".into());
    }
    providers::python_env::remove(provider(&provider_id)?, &runtime_id)
}

/// Export one probed Python runtime as a portable bundle.
///
/// The bundle is a versioned recipe with vendored wheels, never a relocated
/// venv: CPython environments embed absolute paths. Wheels are gathered with
/// `pip download --only-binary=:all:` into staging, which reads the source
/// interpreter but never installs into it, so exporting an external
/// registration cannot mutate that environment. The archive is sealed
/// atomically; failure or cancellation leaves no partial bundle behind.
#[tauri::command]
pub(crate) async fn provider_portable_export(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    provider_id: String,
    runtime_id: String,
) -> Result<providers::portable::PortableExportInfo, String> {
    let provider = provider(&provider_id)?;
    if !provider.is_python() {
        return Err("only Python runtimes have portable bundles".into());
    }
    providers::python_env::validate_id(&runtime_id)?;
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if super::runtimes::runtime_resources_in_use(&state)? {
            return Err("stop model sessions before exporting a runtime".into());
        }
    }
    // The full health, freeze and provenance checks run inside
    // `export_bundle` after the destination is picked, so one code path owns
    // validation, wheel gathering, sealing and staging cleanup.
    let suggested = format!("aiolm-{}-{}-portable.zip", provider.as_str(), runtime_id,);
    let output = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Export portable Python runtime bundle")
            .set_file_name(&suggested)
            .add_filter("portable runtime bundle", &["zip"])
            .save_file()
    })
    .await
    .map_err(|error| format!("portable export picker failed: {error}"))?
    .ok_or_else(|| "portable runtime export cancelled".to_string())?;
    state.runtime_cancel.store(false, Ordering::Release);
    let cancel = state.runtime_cancel.clone();
    let progress_app = app.clone();
    let info = providers::portable::export_bundle(
        provider,
        &runtime_id,
        &output,
        cancel,
        move |progress| {
            let _ = progress_app.emit("provider-install-progress", progress);
        },
    )
    .await?;
    let _ = app.emit(
        "provider-install-progress",
        serde_json::json!({
            "provider": provider,
            "id": info.runtime_id,
            "phase": "complete",
            "line": "",
        }),
    );
    Ok(info)
}

/// Import one portable bundle into a new app-owned isolated environment.
///
/// The archive is verified (bounds, paths, hashes, platform/ABI, dependency
/// closure, Metal provenance) before anything is installed. Installation uses
/// only the vendored wheels, offline, and the manifest is published only after
/// the fresh probe passes the unchanged readiness rules. Import allocates a
/// new `portable-*` identity: it never replaces another runtime and never
/// installs into a user interpreter.
#[tauri::command]
pub(crate) async fn provider_portable_import(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<providers::python_env::PythonRuntimeManifest, String> {
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    {
        let _operation = state.operation.lock().await;
        if super::runtimes::runtime_resources_in_use(&state)? {
            return Err("stop model sessions before importing a runtime".into());
        }
    }
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Import portable Python runtime bundle")
            .add_filter("portable runtime bundle", &["zip"])
            .pick_file()
    })
    .await
    .map_err(|error| format!("portable import picker failed: {error}"))?
    .ok_or_else(|| "portable runtime import cancelled".to_string())?;
    state.runtime_cancel.store(false, Ordering::Release);
    let cancel = state.runtime_cancel.clone();
    providers::portable::import_bundle(&path, cancel, move |progress| {
        let _ = app.emit("provider-install-progress", progress);
    })
    .await
}

#[tauri::command]
pub(crate) async fn model_artifact(path: String) -> Result<ModelArtifact, String> {
    tokio::task::spawn_blocking(move || providers::execution::inspect(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(serde::Serialize)]
pub struct CatalogModel {
    pub artifact: ModelArtifact,
    pub compatibility: Vec<ModelCompatibility>,
    pub shards: Option<crate::models::ModelShards>,
}
#[derive(serde::Serialize)]
pub struct ModelCatalog {
    pub models: Vec<CatalogModel>,
    pub truncated: bool,
}

pub fn inspect_catalog(
    root: &str,
    cancel: &std::sync::atomic::AtomicBool,
    selection: Option<(ProviderId, String)>,
) -> Result<ModelCatalog, String> {
    let probe = selection
        .as_ref()
        .and_then(|(provider, id)| providers::python_env::read(*provider, id).ok())
        .and_then(|runtime| runtime.probe);
    let scan = crate::models::scan_cancellable(root, cancel)?;
    let mut artifacts: Vec<ModelArtifact> = scan
        .models
        .iter()
        .map(|model| {
            providers::artifacts::inspect_gguf(
                Path::new(&model.path),
                (model.size_mb * 1024.0 * 1024.0) as u64,
                model
                    .shards
                    .as_ref()
                    .map_or(&[], |value| value.missing.as_slice()),
            )
        })
        .collect();
    let mut pending = vec![(PathBuf::from(root), 0)];
    let mut entries_seen = 0usize;
    let mut truncated = scan.truncated;
    while let Some((dir, depth)) = pending.pop() {
        if cancel.load(Ordering::Acquire) {
            return Err("model scan cancelled".into());
        }
        if providers::artifacts::is_snapshot_dir(&dir) {
            artifacts.push(providers::artifacts::inspect_snapshot(&dir));
            continue;
        }
        if depth >= 8 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            entries_seen += 1;
            if entries_seen >= 100_000 || artifacts.len() >= 10_000 {
                truncated = true;
                pending.clear();
                break;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    let models = artifacts
        .into_iter()
        .map(|artifact| {
            let compatibility = ProviderId::ALL
                .iter()
                .map(|id| {
                    providers::compat::assess(
                        &artifact,
                        *id,
                        if selection
                            .as_ref()
                            .is_some_and(|(provider, _)| provider == id)
                        {
                            probe.as_ref()
                        } else {
                            None
                        },
                    )
                })
                .collect();
            let shards = scan
                .models
                .iter()
                .find(|model| model.path == artifact.path)
                .and_then(|model| model.shards.clone());
            CatalogModel {
                artifact,
                compatibility,
                shards,
            }
        })
        .collect();
    Ok(ModelCatalog { models, truncated })
}

#[tauri::command]
pub(crate) async fn list_model_artifacts(
    state: State<'_, AppState>,
    models_dir: String,
    scan_id: Option<String>,
    provider_id: Option<String>,
    runtime_id: Option<String>,
) -> Result<ModelCatalog, String> {
    let selection = provider_id
        .map(|value| provider(&value))
        .transpose()?
        .zip(runtime_id);
    let job = scan_id.map(|id| state.model_scans.begin(id)).transpose()?;
    tokio::task::spawn_blocking(move || {
        let cfg = config::load_result()?;
        let root = if models_dir.trim().is_empty() {
            config::ensure_default_models_dir(&cfg)?;
            cfg.models_dir
        } else {
            models_dir
        };
        match job {
            Some(job) => inspect_catalog(&root, &job.cancel, selection),
            None => inspect_catalog(&root, &std::sync::atomic::AtomicBool::new(false), selection),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn model_compatibility(
    cfg: config::AppConfig,
) -> Result<ModelCompatibility, String> {
    tokio::task::spawn_blocking(move || providers::execution::compatibility(&cfg))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn provider_import_command(
    provider_id: String,
    command: String,
) -> Result<providers::options::ImportedCommand, String> {
    providers::options::import_command(provider(&provider_id)?, &command)
}

#[tauri::command]
pub(crate) fn provider_command_preview(cfg: config::AppConfig) -> Result<Vec<String>, String> {
    let runtime = providers::selected_python_runtime(&cfg)?;
    Ok(providers::launch::preview(
        &providers::launch::engine_command(&cfg, &runtime, cfg.port, "")?,
    ))
}

#[tauri::command]
pub(crate) fn provider_option_issues(
    cfg: config::AppConfig,
) -> Result<Vec<providers::options::OptionIssue>, String> {
    let selected = providers::provider_of(&cfg);
    let options = providers::launch::provider_options(&cfg, selected);
    if cfg.active_runtime.is_empty() {
        return Ok(providers::launch::option_issues(selected, &options));
    }
    let runtime = providers::selected_python_runtime(&cfg)?;
    Ok(providers::launch::runtime_option_issues(&runtime, &options))
}
