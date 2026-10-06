//! Local model selection, scanning and verified deletion IPC.
#[cfg(not(windows))]
use super::files::open_verified_file;
use crate::{config, gguf, models, server, state::AppState};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

/// What a model file's own header says about it.
///
/// Read on demand for selected or visible models, separately from folder scans,
/// so opening a large library does not require reading every file's header.
#[tauri::command]
pub(crate) async fn model_metadata(path: String) -> Result<gguf::ModelMetadata, String> {
    let receipt_root = crate::benchmark::data_root().ok();
    tokio::task::spawn_blocking(move || {
        let models_root = config::load_result()
            .ok()
            .map(|cfg| PathBuf::from(cfg.models_dir));
        read_model_metadata(
            Path::new(&path),
            receipt_root.as_deref(),
            models_root.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("model metadata task failed: {error}"))?
}

/// Pre-load VRAM and RAM/SSD offload plan for the configuration being edited.
///
/// Only file metadata and bounded GGUF headers are read, off the async
/// runtime; no model is loaded and no runtime is started.
#[tauri::command]
pub(crate) async fn estimate_model_resources(
    config: config::AppConfig,
    runtime_devices: Option<Vec<String>>,
) -> Result<crate::resource_estimate::ResourceEstimate, String> {
    tokio::task::spawn_blocking(move || {
        let devices = runtime_devices.unwrap_or_default();
        let environment = crate::resource_estimate::Environment::detect(&config, &devices);
        crate::resource_estimate::estimate(&config, &environment)
    })
    .await
    .map_err(|error| format!("resource estimate task failed: {error}"))
}

fn read_model_metadata(
    path: &Path,
    receipt_root: Option<&Path>,
    models_root: Option<&Path>,
) -> Result<gguf::ModelMetadata, String> {
    let mut metadata = gguf::read_metadata(path)?;
    metadata.download_repository = receipt_root
        .and_then(|root| crate::benchmark::download_receipt::read(root, path))
        .map(|receipt| receipt.repository);
    metadata.directory_repository = models_root.and_then(|root| directory_repository(root, path));
    Ok(metadata)
}

/// Import libraries preserve repository identity as root/publisher/model/file.
/// Resolve both paths before interpreting only components inside the library.
fn directory_repository(root: &Path, path: &Path) -> Option<String> {
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    let relative = path.strip_prefix(root).ok()?;
    let parts: Vec<_> = relative
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<_>>()?;
    let repo = match parts.as_slice() {
        ["hf", owner, model, ..] if parts.len() >= 4 => format!("{owner}/{model}"),
        [owner, model, _file] => format!("{owner}/{model}"),
        _ => return None,
    };
    crate::discover::validate_repo_id(&repo).ok()?;
    Some(repo)
}

#[tauri::command]
pub(crate) async fn list_models(
    state: State<'_, AppState>,
    models_dir: String,
    scan_id: Option<String>,
) -> Result<models::ModelScan, String> {
    let job = scan_id.map(|id| state.model_scans.begin(id)).transpose()?;
    tokio::task::spawn_blocking(move || {
        let dir = if models_dir.trim().is_empty() {
            let cfg = config::load_result()?;
            // The folder the application owns is created on demand, so the first
            // scan after an installation lists an empty folder instead of
            // failing on a path that was never made. Whatever stops it from
            // being created is reported here, where the user is looking for it.
            config::ensure_default_models_dir(&cfg)?;
            cfg.models_dir
        } else {
            models_dir
        };
        match job {
            Some(job) => models::scan_cancellable(&dir, &job.cancel),
            None => models::scan(&dir),
        }
    })
    .await
    .map_err(|error| format!("model scan task failed: {error}"))?
}

#[tauri::command]
pub(crate) fn cancel_model_scan(state: State<'_, AppState>, scan_id: String) -> Result<(), String> {
    state.model_scans.cancel(&scan_id)
}

#[cfg(windows)]
fn remove_verified_file(path: &Path, expected: &Path) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let resolved_before = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve model before deletion: {error}"))?;
    if resolved_before != expected {
        return Err("model path changed before deletion".into());
    }
    let wide_path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "cannot open model for deletion: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result = (|| {
        let mut file_info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(handle, &mut file_info) } == 0 {
            return Err(format!(
                "cannot inspect model before deletion: {}",
                std::io::Error::last_os_error()
            ));
        }
        if file_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("model path must not be a reparse point".into());
        }
        let resolved_after = path
            .canonicalize()
            .map_err(|error| format!("cannot resolve model before deletion: {error}"))?;
        if resolved_after != expected {
            return Err("model path changed while it was being opened".into());
        }
        let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                handle,
                FileDispositionInfo,
                (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(format!(
                "cannot delete model file: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    })();
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(not(windows))]
fn remove_verified_file(path: &Path, expected: &Path) -> Result<(), String> {
    let _file = open_verified_file(path, expected, "model")?;
    fs::remove_file(path).map_err(|error| format!("cannot delete model file: {error}"))
}

#[tauri::command]
pub(crate) async fn delete_model(
    state: State<'_, AppState>,
    path: String,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    if state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?
        .lifecycle
        .blocks_resource_change()
    {
        return Err("stop the server before deleting a model".into());
    }
    let cfg = config::load_result()?;
    if Path::new(&path).is_dir() {
        let candidate = ensure_deletable_snapshot(&cfg, Path::new(&path))?;
        for entry in state.sessions.entries() {
            let live = entry
                .state
                .lock()
                .map_err(|_| "server state lock was poisoned")?;
            if session_uses_snapshot(&live, &candidate) {
                return Err(format!(
                    "stop session '{}' before deleting a snapshot it is using",
                    entry.display_name()
                ));
            }
        }
        return delete_snapshot(&candidate);
    }
    let requested = paths.unwrap_or_else(|| vec![path.clone()]);
    if requested.is_empty() || requested.len() > 10_000 || !requested.contains(&path) {
        return Err("invalid model file selection".into());
    }
    let mut candidates = Vec::new();
    // Validate the entire selection before removing any shard. This preserves
    // configured models and running sessions even when they reference a later part.
    for requested_path in requested {
        let candidate = ensure_deletable_model_path(
            Path::new(&cfg.models_dir),
            Path::new(&requested_path),
            &cfg.active_model,
            &cfg.mmproj,
            &cfg.spec_draft_model,
        )?;
        for entry in state.sessions.entries() {
            let server = entry
                .state
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            if session_uses_model_file(&server, &candidate) {
                return Err(format!(
                    "stop session '{}' before deleting a model it is using",
                    entry.display_name()
                ));
            }
        }
        if cfg.lora_adapters.iter().any(|adapter| {
            adapter.enabled
                && fs::canonicalize(&adapter.path)
                    .ok()
                    .is_some_and(|adapter_path| adapter_path == candidate)
        }) {
            return Err(
                "select another configuration before deleting an enabled LoRA adapter".into(),
            );
        }
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    for candidate in candidates {
        remove_verified_file(&candidate, &candidate)?;
    }
    Ok(())
}

/// A configured path that is the snapshot or a file inside it.
fn binds_into(path: &str, candidate: &Path) -> bool {
    !path.trim().is_empty()
        && fs::canonicalize(path).is_ok_and(|bound| bound.starts_with(candidate))
}

/// Provider bindings (draft, embedding and LoRA snapshots) are path strings in
/// option maps. Every provider's map counts: switching back would use them.
fn provider_options_bind(cfg: &config::AppConfig, candidate: &Path) -> bool {
    fn contains(value: &serde_json::Value, candidate: &Path) -> bool {
        match value {
            serde_json::Value::String(path) => binds_into(path, candidate),
            serde_json::Value::Object(values) => {
                values.values().any(|value| contains(value, candidate))
            }
            serde_json::Value::Array(values) => {
                values.iter().any(|value| contains(value, candidate))
            }
            _ => false,
        }
    }
    cfg.provider_options
        .values()
        .any(|options| options.values().any(|value| contains(value, candidate)))
}

fn session_uses_snapshot(server: &server::ServerState, candidate: &Path) -> bool {
    server.lifecycle.blocks_resource_change()
        && ([&server.model, &server.mmproj, &server.draft_model]
            .iter()
            .any(|path| binds_into(path, candidate))
            || server
                .execution
                .as_ref()
                .is_some_and(|cfg| config_binding_problem(cfg, candidate).is_some()))
}

fn config_binding_problem(cfg: &config::AppConfig, candidate: &Path) -> Option<&'static str> {
    if [&cfg.active_model, &cfg.mmproj, &cfg.spec_draft_model]
        .iter()
        .any(|path| binds_into(path, candidate))
    {
        return Some("select another model/projector/draft before deleting this snapshot");
    }
    if cfg
        .lora_adapters
        .iter()
        .any(|adapter| adapter.enabled && binds_into(&adapter.path, candidate))
    {
        return Some("select another configuration before deleting an enabled LoRA adapter");
    }
    provider_options_bind(cfg, candidate)
        .then_some("remove draft, embedding or LoRA bindings before deleting this snapshot")
}

/// Resolve a snapshot folder inside the library that no saved selection uses.
fn ensure_deletable_snapshot(cfg: &config::AppConfig, path: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(&cfg.models_dir)
        .map_err(|error| format!("cannot resolve models root: {error}"))?;
    let candidate =
        fs::canonicalize(path).map_err(|error| format!("cannot resolve snapshot path: {error}"))?;
    if !candidate.starts_with(&root) || candidate == root || !candidate.is_dir() {
        return Err("snapshot must be a folder inside the configured models directory".into());
    }
    if let Some(problem) = config_binding_problem(cfg, &candidate) {
        return Err(problem.into());
    }
    Ok(candidate)
}

/// `.{name}.{uuid}.part` (download staging) and `.{name}.tmp-{uuid}` (manifest
/// replacement) are left only by an interrupted write of the listed `name`.
fn staged_name(file_name: &str) -> Option<&str> {
    let rest = file_name.strip_prefix('.')?;
    let (name, id) = match rest.strip_suffix(".part") {
        Some(value) => value.rsplit_once('.')?,
        None => rest.rsplit_once(".tmp-")?,
    };
    (id.len() == 32 && id.bytes().all(|value| value.is_ascii_hexdigit())).then_some(name)
}

/// Everything deleting an app-owned snapshot removes, validated before any
/// removal: regular files its manifest lists, staging files this app left for
/// them, then the manifest. Unlisted user files are never included. Folders
/// are returned deepest first and are only ever removed when empty.
fn snapshot_deletion_plan(directory: &Path) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    use crate::providers::artifacts::SNAPSHOT_MANIFEST;
    let manifest_path = directory.join(SNAPSHOT_MANIFEST);
    let manifest = crate::discover::read_snapshot_manifest(&manifest_path)?
        .ok_or("only app-owned snapshots can be deleted; external folders and shared Hugging Face caches must be managed by their owner")?;
    let mut listed: std::collections::BTreeMap<PathBuf, std::collections::HashSet<String>> =
        Default::default();
    listed
        .entry(directory.to_path_buf())
        .or_default()
        .insert(SNAPSHOT_MANIFEST.into());
    let mut files = Vec::new();
    for file in &manifest.files {
        let candidate = crate::discover::snapshot_path(directory, &file.path);
        let (Some(parent), Some(name)) = (
            candidate.parent(),
            candidate.file_name().and_then(|name| name.to_str()),
        ) else {
            return Err("invalid snapshot ownership manifest".into());
        };
        listed
            .entry(parent.to_path_buf())
            .or_default()
            .insert(name.to_owned());
        match fs::symlink_metadata(&candidate) {
            Ok(metadata)
                if metadata.is_file()
                    && fs::canonicalize(&candidate).is_ok_and(|resolved| resolved == candidate) =>
            {
                files.push(candidate)
            }
            Ok(_) => {
                return Err(format!(
                    "snapshot entry is a link or not a regular file: {}",
                    file.path
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "cannot inspect snapshot file {}: {error}",
                    file.path
                ))
            }
        }
    }
    for (folder, names) in &listed {
        let Ok(entries) = fs::read_dir(folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            if file_name
                .to_str()
                .and_then(staged_name)
                .is_some_and(|name| names.contains(name))
                && entry.file_type().is_ok_and(|kind| kind.is_file())
            {
                files.push(entry.path());
            }
        }
    }
    files.push(manifest_path);
    let mut folders = listed
        .into_keys()
        .flat_map(|folder| {
            folder
                .ancestors()
                .take_while(|path| *path != directory && path.starts_with(directory))
                .map(Path::to_path_buf)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    folders.sort_by(|left, right| {
        right
            .components()
            .count()
            .cmp(&left.components().count())
            .then_with(|| left.cmp(right))
    });
    folders.dedup();
    Ok((files, folders))
}

fn delete_snapshot(directory: &Path) -> Result<(), String> {
    let (files, folders) = snapshot_deletion_plan(directory)?;
    // The manifest is removed last, so an interrupted deletion can be retried.
    for file in &files {
        remove_verified_file(file, file)?;
    }
    for folder in folders.iter().map(PathBuf::as_path).chain([directory]) {
        let _ = fs::remove_dir(folder);
    }
    Ok(())
}

/// Delete an app-owned snapshot for non-GUI clients after the same saved
/// binding checks as the desktop. Callers check their own running servers.
/// The folder remains when it still holds files the manifest does not list.
pub fn delete_owned_snapshot(cfg: &config::AppConfig, path: &Path) -> Result<PathBuf, String> {
    let candidate = ensure_deletable_snapshot(cfg, path)?;
    delete_snapshot(&candidate)?;
    Ok(candidate)
}

fn session_uses_model_file(server: &server::ServerState, candidate: &Path) -> bool {
    server.lifecycle.blocks_resource_change()
        && [&server.model, &server.mmproj, &server.draft_model]
            .into_iter()
            .chain(server.execution.iter().flat_map(|cfg| {
                cfg.lora_adapters
                    .iter()
                    .filter(|adapter| adapter.enabled)
                    .map(|adapter| &adapter.path)
            }))
            .filter(|path| !path.trim().is_empty())
            .filter_map(|path| fs::canonicalize(path).ok())
            .any(|path| path == candidate)
}

#[tauri::command]
pub(crate) fn pick_models_dir() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a GGUF models directory")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn pick_lora_adapter() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a LoRA adapter GGUF")
        .add_filter("GGUF adapter", &["gguf"])
        .pick_file()
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("gguf"))
        })
        .map(|path| path.to_string_lossy().into_owned())
}

fn ensure_deletable_model_path(
    models_root: &Path,
    path: &Path,
    active_model: &str,
    active_mmproj: &str,
    active_draft: &str,
) -> Result<PathBuf, String> {
    let root = fs::canonicalize(models_root)
        .map_err(|error| format!("cannot resolve models root: {error}"))?;
    let candidate =
        fs::canonicalize(path).map_err(|error| format!("cannot resolve model path: {error}"))?;
    if !candidate.starts_with(&root) {
        return Err("model path must stay inside the configured models directory".into());
    }
    if !candidate.is_file() {
        return Err("model path is not a regular file".into());
    }
    if !matches!(
        candidate
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("gguf") | Some("mmproj")
    ) {
        return Err("only GGUF and mmproj files can be deleted".into());
    }
    for active in [active_model, active_mmproj, active_draft] {
        if active.is_empty() {
            continue;
        }
        if let Ok(active_path) = fs::canonicalize(active) {
            if active_path == candidate {
                return Err(
                    "select another model/projector/draft before deleting the active file".into(),
                );
            }
        }
    }
    Ok(candidate)
}

/// Validate a model/projector deletion request for non-GUI clients.
pub fn deletable_model_path(
    models_root: &Path,
    path: &Path,
    active_model: &str,
    active_mmproj: &str,
    active_draft: &str,
) -> Result<PathBuf, String> {
    ensure_deletable_model_path(models_root, path, active_model, active_mmproj, active_draft)
}

#[cfg(test)]
mod tests {
    #[test]
    fn imported_model_publisher_comes_from_repository_folders_inside_library() {
        let root = std::env::temp_dir().join(format!("aiolm-import-{}", uuid::Uuid::new_v4()));
        let mut header = b"GGUF".to_vec();
        header.extend_from_slice(&3u32.to_le_bytes());
        header.extend_from_slice(&0u64.to_le_bytes());
        header.extend_from_slice(&0u64.to_le_bytes());
        for (relative, expected) in [
            (
                "community-publisher/example-GGUF/model.gguf",
                Some("community-publisher/example-GGUF"),
            ),
            (
                "ExamplePublisher/example-GGUF/mmproj.gguf",
                Some("ExamplePublisher/example-GGUF"),
            ),
            ("hf/example/model/quant/model.gguf", Some("example/model")),
            ("model.gguf", None),
            ("quant/model.gguf", None),
            ("arbitrary/nested/folders/model.gguf", None),
            ("invalid owner/model/file.gguf", None),
        ] {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &header).unwrap();
            let metadata = super::read_model_metadata(&path, None, Some(&root)).unwrap();
            assert_eq!(
                metadata.directory_repository.as_deref(),
                expected,
                "{relative}"
            );
            assert!(metadata.download_repository.is_none());
        }
        let narrower_root = root.join("community-publisher");
        assert!(super::directory_repository(
            &narrower_root,
            &root.join("ExamplePublisher/example-GGUF/mmproj.gguf")
        )
        .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_publisher_uses_only_a_receipt_for_the_current_file() {
        let root = std::env::temp_dir().join(format!("aiolm-publisher-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("example.gguf");
        let mut header = b"GGUF".to_vec();
        header.extend_from_slice(&3u32.to_le_bytes());
        header.extend_from_slice(&0u64.to_le_bytes());
        header.extend_from_slice(&0u64.to_le_bytes());
        std::fs::write(&path, &header).unwrap();
        assert!(super::read_model_metadata(&path, Some(&root), None)
            .unwrap()
            .download_repository
            .is_none());
        crate::benchmark::download_receipt::record(
            &root,
            &path,
            "example-publisher/example-model",
            "example.gguf",
        )
        .unwrap();
        assert_eq!(
            super::read_model_metadata(&path, Some(&root), None)
                .unwrap()
                .download_repository
                .as_deref(),
            Some("example-publisher/example-model")
        );
        header.extend_from_slice(b"replacement");
        std::fs::write(&path, &header).unwrap();
        assert!(super::read_model_metadata(&path, Some(&root), None)
            .unwrap()
            .download_repository
            .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    use super::*;

    #[test]
    fn model_delete_requires_root_containment_and_inactive_path() {
        let root = std::env::temp_dir().join(format!("aiolm-delete-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create model root");
        let model = root.join("nested").join("model.gguf");
        fs::create_dir_all(model.parent().unwrap()).expect("create nested model root");
        fs::write(&model, b"model").expect("write model");
        let canonical = model.canonicalize().expect("canonicalize model");
        assert!(ensure_deletable_model_path(&root, &model, "", "", "").is_ok());
        assert!(
            ensure_deletable_model_path(&root, &model, &canonical.to_string_lossy(), "", "")
                .is_err()
        );
        assert!(
            ensure_deletable_model_path(&root, &model, "", "", &canonical.to_string_lossy())
                .is_err()
        );
        assert!(
            super::deletable_model_path(&root, &model, "", "", &canonical.to_string_lossy())
                .is_err()
        );
        assert!(ensure_deletable_model_path(&root, Path::new("outside.gguf"), "", "", "").is_err());
        assert!(
            ensure_deletable_model_path(&root, Path::new("nested/model.txt"), "", "", "").is_err()
        );
        assert!(super::remove_verified_file(&canonical, &canonical).is_ok());
        assert!(!model.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn every_model_role_in_a_running_session_blocks_file_deletion() {
        let root =
            std::env::temp_dir().join(format!("aiolm-session-delete-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create model root");
        let primary = root.join("primary.gguf");
        let projector = root.join("mmproj.gguf");
        let draft = root.join("draft.gguf");
        let adapter = root.join("adapter.gguf");
        for path in [&primary, &projector, &draft, &adapter] {
            fs::write(path, b"model").expect("write model fixture");
        }
        let mut server = crate::server::ServerState::default();
        server.lifecycle = crate::server::Lifecycle::Ready;
        server.model = primary.to_string_lossy().into_owned();
        server.mmproj = projector.to_string_lossy().into_owned();
        server.draft_model = draft.to_string_lossy().into_owned();
        server.execution = Some(config::AppConfig {
            lora_adapters: vec![config::LoraAdapterConfig {
                path: adapter.to_string_lossy().into_owned(),
                scale: 1.0,
                enabled: true,
            }],
            ..Default::default()
        });
        assert!(super::session_uses_model_file(
            &server,
            &adapter.canonicalize().unwrap()
        ));

        assert!(super::session_uses_model_file(
            &server,
            &primary.canonicalize().unwrap()
        ));
        assert!(super::session_uses_model_file(
            &server,
            &projector.canonicalize().unwrap()
        ));
        assert!(super::session_uses_model_file(
            &server,
            &draft.canonicalize().unwrap()
        ));

        server.lifecycle = crate::server::Lifecycle::Stopped;
        assert!(!super::session_uses_model_file(
            &server,
            &primary.canonicalize().unwrap()
        ));
        let _ = fs::remove_dir_all(root);
    }

    fn snapshot_fixture(label: &str) -> (PathBuf, PathBuf) {
        use crate::providers::artifacts::{SnapshotFile, SnapshotManifest, SNAPSHOT_MANIFEST};
        let root =
            std::env::temp_dir().join(format!("aiolm-snapshot-{label}-{}", uuid::Uuid::new_v4()));
        let snapshot = root
            .join("hf")
            .join("example")
            .join("model")
            .join("snapshots")
            .join("0".repeat(40));
        fs::create_dir_all(snapshot.join("nested").join("deeper")).unwrap();
        let files = [
            "config.json",
            "model.safetensors",
            "nested/deeper/tokenizer.json",
            "missing.safetensors",
        ];
        for file in &files[..3] {
            fs::write(
                crate::discover::snapshot_path(&snapshot, file),
                b"synthetic",
            )
            .unwrap();
        }
        let manifest = SnapshotManifest {
            format: 1,
            repository: "example/model".into(),
            revision: "0".repeat(40),
            files: files
                .iter()
                .map(|path| SnapshotFile {
                    path: (*path).into(),
                    size: 9,
                    oid: None,
                })
                .collect(),
            complete: false,
        };
        fs::write(
            snapshot.join(SNAPSHOT_MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        (
            root.canonicalize().unwrap(),
            snapshot.canonicalize().unwrap(),
        )
    }

    #[test]
    fn snapshot_deletion_removes_only_manifest_owned_files_and_staging() {
        let (root, snapshot) = snapshot_fixture("owned");
        let part = format!(
            ".missing.safetensors.{}.part",
            uuid::Uuid::new_v4().simple()
        );
        let manifest_temporary = format!(
            ".{}.tmp-{}",
            crate::providers::artifacts::SNAPSHOT_MANIFEST,
            uuid::Uuid::new_v4().simple()
        );
        for name in [&part, &manifest_temporary] {
            fs::write(snapshot.join(name), b"staged").unwrap();
        }
        // Unlisted files, including look-alike staging names, belong to the user.
        for name in [
            "notes.txt",
            ".notes.txt.0123456789abcdef0123456789abcdef.part",
            ".model.safetensors.not-a-uuid.part",
        ] {
            fs::write(snapshot.join(name), b"user").unwrap();
        }
        fs::write(snapshot.join("nested").join("user.json"), b"user").unwrap();
        delete_snapshot(&snapshot).unwrap();
        let mut remaining = fs::read_dir(&snapshot)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        remaining.sort();
        assert_eq!(
            remaining,
            [
                ".model.safetensors.not-a-uuid.part",
                ".notes.txt.0123456789abcdef0123456789abcdef.part",
                "nested",
                "notes.txt"
            ]
        );
        assert!(
            !snapshot.join("nested").join("deeper").exists(),
            "emptied folders are removed"
        );
        assert!(snapshot.join("nested").join("user.json").exists());

        let (_, clean) = snapshot_fixture("clean");
        assert!(
            delete_owned_snapshot(
                &config::AppConfig {
                    models_dir: root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                &clean
            )
            .is_err(),
            "outside its own library"
        );
        delete_snapshot(&clean).unwrap();
        assert!(!clean.exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(clean.ancestors().nth(5).unwrap());
    }

    #[test]
    fn snapshot_deletion_validates_everything_before_removing_anything() {
        let (root, snapshot) = snapshot_fixture("invalid");
        fs::remove_file(snapshot.join("model.safetensors")).unwrap();
        fs::create_dir(snapshot.join("model.safetensors")).unwrap();
        assert!(delete_snapshot(&snapshot).is_err());
        assert!(
            snapshot.join("config.json").exists()
                && snapshot
                    .join(crate::providers::artifacts::SNAPSHOT_MANIFEST)
                    .exists()
        );
        fs::remove_file(snapshot.join(crate::providers::artifacts::SNAPSHOT_MANIFEST)).unwrap();
        assert!(delete_snapshot(&snapshot)
            .unwrap_err()
            .contains("app-owned"));
        assert!(snapshot.join("config.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saved_and_running_bindings_block_snapshot_deletion() {
        let (root, snapshot) = snapshot_fixture("bindings");
        let inside = snapshot.join("config.json").to_string_lossy().into_owned();
        let base = config::AppConfig {
            models_dir: root.to_string_lossy().into_owned(),
            ..Default::default()
        };
        assert_eq!(
            ensure_deletable_snapshot(&base, &snapshot).unwrap(),
            snapshot
        );
        assert!(
            ensure_deletable_snapshot(&base, &root).is_err(),
            "the library root is not a snapshot"
        );
        assert!(
            ensure_deletable_snapshot(&base, &snapshot.join("config.json")).is_err(),
            "files use the GGUF path"
        );
        let mut options = serde_json::Map::new();
        options.insert(
            "embedding_model".into(),
            serde_json::json!(snapshot.to_string_lossy()),
        );
        let mut lora = serde_json::Map::new();
        lora.insert(
            "lora_adapters".into(),
            serde_json::json!([{ "name": "adapter", "path": inside }]),
        );
        for cfg in [
            config::AppConfig {
                active_model: snapshot.to_string_lossy().into_owned(),
                ..base.clone()
            },
            config::AppConfig {
                mmproj: inside.clone(),
                ..base.clone()
            },
            config::AppConfig {
                spec_draft_model: inside.clone(),
                ..base.clone()
            },
            config::AppConfig {
                lora_adapters: vec![config::LoraAdapterConfig {
                    path: inside.clone(),
                    scale: 1.0,
                    enabled: true,
                }],
                ..base.clone()
            },
            // Bindings of a provider that is not selected now still count.
            config::AppConfig {
                provider_options: [("mlx-vlm".to_owned(), options)].into(),
                ..base.clone()
            },
            config::AppConfig {
                provider_options: [("vllm".to_owned(), lora)].into(),
                ..base.clone()
            },
        ] {
            assert!(ensure_deletable_snapshot(&cfg, &snapshot).is_err());
            assert!(delete_owned_snapshot(&cfg, &snapshot).is_err());
        }
        let mut server = crate::server::ServerState::default();
        server.lifecycle = crate::server::Lifecycle::Ready;
        server.draft_model = inside.clone();
        assert!(session_uses_snapshot(&server, &snapshot));
        server.draft_model.clear();
        server.execution = Some(config::AppConfig {
            spec_draft_model: inside,
            ..Default::default()
        });
        assert!(session_uses_snapshot(&server, &snapshot));
        server.lifecycle = crate::server::Lifecycle::Stopped;
        assert!(!session_uses_snapshot(&server, &snapshot));
        assert!(snapshot.join("config.json").exists());
        assert_eq!(delete_owned_snapshot(&base, &snapshot).unwrap(), snapshot);
        assert!(!snapshot.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn only_staging_names_with_an_app_identifier_are_recognized() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        assert_eq!(
            staged_name(&format!(".model.safetensors.{id}.part")),
            Some("model.safetensors")
        );
        assert_eq!(
            staged_name(&format!(".config.json.tmp-{id}")),
            Some("config.json")
        );
        for name in [
            "model.safetensors.part",
            ".model.safetensors.part",
            &format!("model.{id}.part"),
            ".model.short.part",
            &format!(".model.{}.part", "g".repeat(32)),
        ] {
            assert_eq!(staged_name(name), None, "{name}");
        }
    }
}
