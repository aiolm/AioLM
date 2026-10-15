//! A declared bridge may need a writable configuration copy. Its directory
//! belongs to the launch owner, never to the selected model or engine folder.
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, fs, path::PathBuf};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub directory_env: String,
}

impl Request {
    pub fn validate(&self) -> Result<(), String> {
        let name = self.directory_env.as_bytes();
        if self.version != 1
            || name.is_empty()
            || name.len() > 128
            || self
                .directory_env
                .to_ascii_uppercase()
                .starts_with("AIOLM_")
            || self
                .directory_env
                .to_ascii_uppercase()
                .starts_with("LLAMA_BOARD_")
            || !(name[0].is_ascii_alphabetic() || name[0] == b'_')
            || !name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
        {
            return Err("invalid launch resource version or directory environment name".into());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    version: u32,
    id: String,
    pid: Option<u32>,
}

fn root() -> PathBuf {
    crate::runtime::runtimes_root().join("launch-staging")
}

fn path(id: &str) -> Result<PathBuf, String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "invalid launch resource identity")?;
    if parsed.to_string() != id {
        return Err("invalid launch resource identity".into());
    }
    let parent = root();
    if fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir()) {
        return Err("launch resource root must be an owned directory, not a link".into());
    }
    Ok(parent.join(id))
}

/// Removing persisted headless resources requires both the generated UUID
/// and the process identity recorded when that directory was created.
pub fn cleanup(id: &str, pid: u32) -> Result<(), String> {
    let path = path(id)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("launch resource directory is not owned".into());
    }
    let marker_path = path.join(".aiolm-launch.json");
    let metadata = fs::symlink_metadata(&marker_path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("invalid launch resource ownership marker".into());
    }
    let bytes = fs::read(marker_path).map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("invalid launch resource ownership marker".into());
    }
    let marker: Marker = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if marker.version != 1 || marker.id != id || marker.pid.unwrap_or_default() != pid {
        return Err("launch resource ownership does not match the stopped process".into());
    }
    fs::remove_dir_all(path).map_err(|e| e.to_string())
}

pub struct Directory {
    id: String,
    pid: u32,
    keep: bool,
}

impl Directory {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn bind(&mut self, pid: u32) -> Result<(), String> {
        let marker = Marker {
            version: 1,
            id: self.id.clone(),
            pid: Some(pid),
        };
        crate::config::atomic_write(
            &path(&self.id)?.join(".aiolm-launch.json"),
            &serde_json::to_vec(&marker).map_err(|e| e.to_string())?,
        )?;
        self.pid = pid;
        Ok(())
    }

    /// Headless ownership has been recorded in its state before release.
    pub fn release(mut self) {
        self.keep = true;
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        if !self.keep {
            let _ = cleanup(&self.id, self.pid);
        }
    }
}

pub fn prepare(
    request: Option<Request>,
    env: &mut Vec<(OsString, OsString)>,
) -> Result<Option<Directory>, String> {
    let Some(request) = request else {
        return Ok(None);
    };
    request.validate()?;
    if env.iter().any(|(name, _)| {
        name.to_string_lossy()
            .eq_ignore_ascii_case(&request.directory_env)
    }) {
        return Err("launch resource variable conflicts with an existing environment entry".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let directory = path(&id)?;
    fs::create_dir_all(directory.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let marker = Marker {
        version: 1,
        id: id.clone(),
        pid: None,
    };
    if let Err(error) = crate::config::atomic_write(
        &directory.join(".aiolm-launch.json"),
        &serde_json::to_vec(&marker).map_err(|e| e.to_string())?,
    ) {
        // This exact UUID directory was just created here and has not been
        // handed to a child. A failed marker write must not leave staging.
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    let guard = Directory {
        id,
        pid: 0,
        keep: false,
    };
    env.push((request.directory_env.into(), directory.into_os_string()));
    Ok(Some(guard))
}
