//! Provider-neutral discovery and installation IPC.
use crate::{
    config,
    providers::{self, artifacts::ModelArtifact, compat::ModelCompatibility, ProviderId},
    state::AppState,
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};
use tauri::{Emitter, State};

fn provider(value: &str) -> Result<ProviderId, String> {
    ProviderId::parse(value).ok_or_else(|| format!("unknown runtime provider: {value}"))
}

#[tauri::command]
pub(crate) fn provider_catalog() -> serde_json::Value {
    let mut catalog = ProviderId::ALL.iter().map(|id| serde_json::json!({
        "id": id, "engine": id.engine(), "server": id.server(), "availability": id.availability(),
        "managed_version": providers::python_env::pinned_version(*id), "options": providers::options::schema(*id),
        "managed_variant": if *id == ProviderId::Vllm && cfg!(all(target_os = "macos", target_arch = "aarch64")) { Some("vllm-metal") } else { None }
    })).collect::<Vec<_>>();
    catalog.extend(providers::registry::catalog());
    serde_json::json!(catalog)
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
) -> Result<Vec<serde_json::Value>, String> {
    let provider = provider(&provider_id)?;
    if provider.is_custom() {
        let manifest = providers::registry::manifest(provider, &runtime_id)?;
        return manifest
            .options
            .iter()
            .map(|option| serde_json::to_value(option).map_err(|e| e.to_string()))
            .collect();
    }
    if provider == ProviderId::Llama || runtime_id.is_empty() {
        return providers::options::schema(provider)
            .iter()
            .map(|option| serde_json::to_value(option).map_err(|e| e.to_string()))
            .collect();
    }
    let runtime = providers::python_env::read(provider, &runtime_id)?;
    providers::launch::option_schema(&runtime)
        .iter()
        .map(|option| serde_json::to_value(option).map_err(|e| e.to_string()))
        .collect()
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
    let selected = provider(&provider_id)?;
    if selected.is_custom() {
        return providers::registry::remove(selected, &runtime_id);
    }
    providers::python_env::remove(selected, &runtime_id)
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
    tokio::task::spawn_blocking(move || {
        if let Some(artifact) = providers::registry::registered_models()
            .into_iter()
            .find(|model| model.path == path)
        {
            return Ok(artifact);
        }
        providers::execution::inspect(Path::new(&path))
    })
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<ModelCatalogSelection>,
}

#[derive(serde::Serialize)]
pub struct ModelCatalogSelection {
    pub provider: ProviderId,
    pub runtime: String,
    pub source: &'static str,
    pub binding_paths: Vec<String>,
}

pub fn inspect_catalog(
    root: &str,
    cancel: &std::sync::atomic::AtomicBool,
    selection: Option<(ProviderId, String)>,
) -> Result<ModelCatalog, String> {
    inspect_catalog_view(root, cancel, selection, true)
}

fn catalog_indexes<'scan, 'bindings>(
    scan: &'scan crate::models::ModelScan,
    binding_paths: &'bindings [String],
) -> (
    HashMap<&'scan str, &'scan crate::models::GgufModel>,
    HashSet<&'bindings str>,
) {
    let mut scan_by_path = HashMap::with_capacity(scan.models.len());
    for model in &scan.models {
        scan_by_path.entry(model.path.as_str()).or_insert(model);
    }
    let binding_path_set = binding_paths.iter().map(String::as_str).collect();
    (scan_by_path, binding_path_set)
}

fn inspect_catalog_view(
    root: &str,
    cancel: &std::sync::atomic::AtomicBool,
    selection: Option<(ProviderId, String)>,
    include_library: bool,
) -> Result<ModelCatalog, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("model scan cancelled".into());
    }
    let selected_bindings = selection
        .as_ref()
        .filter(|(id, _)| id.is_custom())
        .map(|(id, runtime)| providers::registry::registered_models_for(*id, runtime));
    let binding_paths = selected_bindings
        .as_ref()
        .map(|bindings| {
            bindings
                .iter()
                .map(|model| model.path.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // This is a discovery view, not an exhaustive allowlist. Unlisted models
    // remain available through explicit library exploration and manual paths.
    let bindings_only = !include_library && !binding_paths.is_empty();
    let probe = selection
        .as_ref()
        .and_then(|(provider, id)| providers::python_env::read(*provider, id).ok())
        .and_then(|runtime| runtime.probe);
    let scan = if bindings_only {
        crate::models::ModelScan {
            models: vec![],
            truncated: false,
        }
    } else {
        crate::models::scan_cancellable(root, cancel)?
    };
    let (scan_by_path, binding_path_set) = catalog_indexes(&scan, &binding_paths);
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
    let mut pending = if bindings_only {
        vec![]
    } else {
        vec![(PathBuf::from(root), 0)]
    };
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
    let mut seen = artifacts
        .iter()
        .map(|artifact| artifact.path.clone())
        .collect::<HashSet<_>>();
    artifacts.extend(
        selected_bindings
            .unwrap_or_else(providers::registry::registered_models)
            .into_iter()
            .filter(|artifact| seen.insert(artifact.path.clone())),
    );
    artifacts.sort_by_key(|artifact| !binding_path_set.contains(artifact.path.as_str()));
    // Discovery does not need each runtime's binary-integrity/availability
    // check, especially not once per model. Launch/probe still enforce it.
    let mut ids = ProviderId::ALL.to_vec();
    ids.extend(providers::registry::registered_provider_ids());
    ids.sort();
    ids.dedup();
    let models = artifacts
        .into_iter()
        .map(|artifact| {
            let compatibility = ids
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
            let shards = scan_by_path
                .get(artifact.path.as_str())
                .and_then(|model| model.shards.clone());
            CatalogModel {
                artifact,
                compatibility,
                shards,
            }
        })
        .collect();
    let selection = selection
        .filter(|(id, _)| id.is_custom())
        .map(|(provider, runtime)| ModelCatalogSelection {
            provider,
            runtime,
            source: if bindings_only {
                "runtime-bindings"
            } else {
                "library"
            },
            binding_paths,
        });
    Ok(ModelCatalog {
        models,
        truncated,
        selection,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{GgufModel, ModelScan, ModelShards};

    fn model(path: &str, shards: Option<&str>) -> GgufModel {
        GgufModel {
            name: path.rsplit('/').next().unwrap_or(path).into(),
            path: path.into(),
            size_mb: 1.0,
            is_vision: false,
            shards: shards.map(|marker| ModelShards {
                files: vec![format!("{marker}.gguf")],
                total: 2,
                missing: vec![],
            }),
        }
    }

    #[test]
    fn catalog_indexes_preserve_first_shards_and_stable_binding_priority() {
        let scan = ModelScan {
            models: vec![
                model("/models/none-first.gguf", None),
                model("/models/none-first.gguf", Some("later-some")),
                model("/models/some-first.gguf", Some("first-some")),
                model("/models/some-first.gguf", None),
                model("/models/unbound.gguf", None),
            ],
            truncated: false,
        };
        let binding_paths = vec![
            "/models/some-first.gguf".into(),
            "/models/some-first.gguf".into(),
            "/models/absent.gguf".into(),
            "/models/./unbound.gguf".into(),
        ];
        let (scan_by_path, binding_path_set) = catalog_indexes(&scan, &binding_paths);

        assert!(scan_by_path["/models/none-first.gguf"].shards.is_none());
        assert_eq!(
            scan_by_path["/models/some-first.gguf"]
                .shards
                .as_ref()
                .and_then(|shards| shards.files.first())
                .map(String::as_str),
            Some("first-some.gguf")
        );
        assert!(binding_path_set.contains("/models/some-first.gguf"));
        assert!(binding_path_set.contains("/models/absent.gguf"));
        assert!(!binding_path_set.contains("/models/unbound.gguf"));
        assert!(binding_path_set.contains("/models/./unbound.gguf"));

        let mut paths = vec![
            "/models/unbound.gguf".to_owned(),
            "/models/some-first.gguf".to_owned(),
            "/models/none-first.gguf".to_owned(),
            "/models/./unbound.gguf".to_owned(),
        ];
        paths.sort_by_key(|path| !binding_path_set.contains(path.as_str()));
        assert_eq!(
            paths,
            vec![
                "/models/some-first.gguf",
                "/models/./unbound.gguf",
                "/models/unbound.gguf",
                "/models/none-first.gguf",
            ]
        );
        assert!(!paths.iter().any(|path| path == "/models/absent.gguf"));
    }

    #[test]
    fn catalog_indexes_accept_empty_scan_and_bindings() {
        let scan = ModelScan {
            models: vec![],
            truncated: false,
        };
        let (scan_by_path, binding_path_set) = catalog_indexes(&scan, &[]);
        assert!(scan_by_path.is_empty());
        assert!(binding_path_set.is_empty());
    }
}

#[tauri::command]
pub(crate) async fn list_model_artifacts(
    state: State<'_, AppState>,
    models_dir: String,
    scan_id: Option<String>,
    provider_id: Option<String>,
    runtime_id: Option<String>,
    include_library: Option<bool>,
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
            Some(job) if include_library == Some(false) => {
                inspect_catalog_view(&root, &job.cancel, selection, false)
            }
            Some(job) => inspect_catalog(&root, &job.cancel, selection),
            None if include_library == Some(false) => inspect_catalog_view(
                &root,
                &std::sync::atomic::AtomicBool::new(false),
                selection,
                false,
            ),
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
    cfg.validate()?;
    if providers::provider_of(&cfg).is_custom() {
        providers::registry::refresh(&cfg, None).await?;
    }
    tokio::task::spawn_blocking(move || providers::execution::compatibility(&cfg))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn provider_import_command(
    provider_id: String,
    command: String,
    syntax: Option<providers::options::CommandSyntax>,
) -> Result<providers::options::ImportedCommand, String> {
    providers::options::import_command_with_syntax(
        provider(&provider_id)?,
        &command,
        syntax.unwrap_or_default(),
    )
}

#[tauri::command]
pub(crate) fn provider_command_preview(cfg: config::AppConfig) -> Result<Vec<String>, String> {
    providers::command_preview(&cfg)
}

#[tauri::command]
pub(crate) fn provider_option_issues(
    cfg: config::AppConfig,
) -> Result<Vec<providers::options::OptionIssue>, String> {
    let selected = providers::provider_of(&cfg);
    let options = providers::launch::provider_options(&cfg, selected);
    if selected == ProviderId::Llama {
        return Ok(providers::runtime_schema::saved_issues(
            &providers::registry::root(),
            &cfg,
            &options,
            &Default::default(),
        ));
    }
    if selected.is_custom() {
        return Ok(providers::registry::saved_option_issues(
            &cfg,
            &providers::registry::manifest(selected, &cfg.active_runtime)?,
            &options,
        ));
    }
    if cfg.active_runtime.is_empty() {
        return Ok(providers::launch::option_issues(selected, &options));
    }
    let runtime = providers::selected_python_runtime(&cfg)?;
    Ok(providers::launch::saved_option_issues(
        &cfg, &runtime, &options,
    ))
}

/// Register a user-selected process adapter without installing or deleting its
/// executable/environment. The existing operation lock protects live sessions.
#[tauri::command]
pub(crate) async fn runtime_adapter_register(
    state: State<'_, AppState>,
    manifest_path: String,
) -> Result<providers::registry::RuntimeManifest, String> {
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    let _operation = state.operation.lock().await;
    if super::runtimes::runtime_resources_in_use(&state)? {
        return Err("stop model sessions before registering a runtime".into());
    }
    state.runtime_cancel.store(false, Ordering::Release);
    providers::registry::register(
        Path::new(&manifest_path),
        Some(state.runtime_cancel.clone()),
    )
    .await
}

/// Register an executable/entry point from explicit choices: launch prefix,
/// model/host/port/credential bindings, serving protocol (or bridge), probe
/// command and health endpoint. When the draft carries reviewed help, it must
/// describe exactly this engine and document every binding flag; it is then
/// accepted for the new registration. A fresh model probe still decides Ready.
#[tauri::command]
pub(crate) async fn runtime_entrypoint_register(
    state: State<'_, AppState>,
    draft: providers::registry::EntrypointDraft,
) -> Result<providers::registry::RuntimeManifest, String> {
    let _busy = super::runtimes::RuntimeBusyGuard::acquire(&state.runtime_busy)?;
    let _operation = state.operation.lock().await;
    if super::runtimes::runtime_resources_in_use(&state)? {
        return Err("stop model sessions before registering a runtime".into());
    }
    state.runtime_cancel.store(false, Ordering::Release);
    providers::runtime_schema::register_entrypoint(
        &providers::registry::root(),
        &draft,
        Some(state.runtime_cancel.clone()),
    )
    .await
}

/// Pick an executable, script or file (`file`) or a working directory
/// (`folder`) with the native dialog. Nothing is read or run here.
#[tauri::command]
pub(crate) async fn pick_runtime_path(kind: String) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new();
    let picked = match kind.as_str() {
        "file" => dialog.pick_file().await,
        "folder" => dialog.pick_folder().await,
        _ => return Err("unknown picker kind".into()),
    };
    Ok(picked.map(|item| item.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn pick_runtime_adapter() -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("Runtime manifest", &["json"])
        .pick_file()
        .await;
    Ok(file.map(|file| file.path().to_string_lossy().into_owned()))
}
