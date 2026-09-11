//! Local model selection, scanning and verified deletion IPC.
#[cfg(not(windows))]
use super::files::open_verified_file;
use crate::{config, models, server, state::AppState};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub(crate) async fn list_models(models_dir: String) -> Result<models::ModelScan, String> {
    tokio::task::spawn_blocking(move || {
        let dir = if models_dir.trim().is_empty() {
            config::load_result()?.models_dir
        } else {
            models_dir
        };
        models::scan(&dir)
    })
    .await
    .map_err(|error| format!("model scan task failed: {error}"))?
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

fn session_uses_model_file(server: &server::ServerState, candidate: &Path) -> bool {
    server.lifecycle.blocks_resource_change()
        && [&server.model, &server.mmproj, &server.draft_model]
            .into_iter()
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
        for path in [&primary, &projector, &draft] {
            fs::write(path, b"model").expect("write model fixture");
        }
        let mut server = crate::server::ServerState::default();
        server.lifecycle = crate::server::Lifecycle::Ready;
        server.model = primary.to_string_lossy().into_owned();
        server.mmproj = projector.to_string_lossy().into_owned();
        server.draft_model = draft.to_string_lossy().into_owned();

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
}
