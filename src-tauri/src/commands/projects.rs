//! Project JSON transfer through the desktop's native file dialogs.
use std::{io::Read, path::PathBuf};

const MAX_PROJECT_BYTES: usize = 4 * 1024 * 1024;

fn save_project_json(
    contents: &str,
    file_name: Option<&str>,
    choose_path: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<bool, String> {
    if contents.len() > MAX_PROJECT_BYTES {
        return Err("project export exceeds the 4 MiB limit".into());
    }
    serde_json::from_str::<serde_json::Value>(contents)
        .map_err(|error| format!("project export is not valid JSON: {error}"))?;
    let name = file_name
        .filter(|name| {
            !name.is_empty()
                && !name
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
                && name.to_ascii_lowercase().ends_with(".json")
        })
        .unwrap_or("aiolm-project.json");
    let Some(path) = choose_path(name) else {
        return Ok(false);
    };
    crate::config::atomic_write(&path, contents.as_bytes())
        .map_err(|error| format!("cannot save project JSON: {error}"))?;
    Ok(true)
}

fn read_project_json(
    choose_path: impl FnOnce() -> Option<PathBuf>,
) -> Result<Option<String>, String> {
    let Some(path) = choose_path() else {
        return Ok(None);
    };
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return Err("choose a project JSON file".into());
    }
    let file = super::files::open_verified_file(&path, &path, "project")?;
    let mut bytes = Vec::new();
    file.take(MAX_PROJECT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read project JSON: {error}"))?;
    if bytes.len() > MAX_PROJECT_BYTES {
        return Err("project import exceeds the 4 MiB limit".into());
    }
    let contents = String::from_utf8(bytes).map_err(|_| "project JSON is not UTF-8".to_string())?;
    let contents = contents.trim_start_matches('\u{feff}').to_owned();
    serde_json::from_str::<serde_json::Value>(&contents)
        .map_err(|error| format!("project import is not valid JSON: {error}"))?;
    Ok(Some(contents))
}

#[tauri::command]
pub(crate) async fn project_import_json() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        read_project_json(|| {
            rfd::FileDialog::new()
                .add_filter("Project JSON", &["json"])
                .pick_file()
        })
    })
    .await
    .map_err(|error| format!("project import task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn project_export_json(
    contents: String,
    file_name: Option<String>,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        save_project_json(&contents, file_name.as_deref(), |name| {
            rfd::FileDialog::new()
                .set_file_name(name)
                .add_filter("Project JSON", &["json"])
                .save_file()
        })
    })
    .await
    .map_err(|error| format!("project export task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{read_project_json, save_project_json, MAX_PROJECT_BYTES};

    #[test]
    fn cancellation_and_invalid_json_never_write_a_project() {
        assert!(!save_project_json("{}", Some("project.json"), |_| None).unwrap());
        assert!(save_project_json("invalid", None, |_| panic!(
            "invalid JSON opened the picker"
        ))
        .is_err());
        assert!(
            save_project_json(&" ".repeat(4 * 1024 * 1024 + 1), None, |_| {
                panic!("oversized export opened the picker")
            })
            .is_err()
        );
        for name in [
            "../project.json",
            "C:\\project.json",
            "project.txt",
            "bad\n.json",
        ] {
            save_project_json("{}", Some(name), |suggested| {
                assert_eq!(suggested, "aiolm-project.json");
                None
            })
            .unwrap();
        }
    }

    #[test]
    fn selected_destination_preserves_json_bytes_and_reports_write_errors() {
        let root =
            std::env::temp_dir().join(format!("aiolm-project-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("project.json");
        let contents = "{\n  \"name\": \"한글 workspace\"\n}\n";
        assert!(save_project_json(contents, Some("project.json"), |name| {
            assert_eq!(name, "project.json");
            Some(path.clone())
        })
        .unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), contents.as_bytes());
        assert!(save_project_json(contents, None, |_| Some(root.clone())).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_reads_only_the_selected_bounded_json_and_handles_cancel_or_invalid_files() {
        assert_eq!(read_project_json(|| None).unwrap(), None);
        let root =
            std::env::temp_dir().join(format!("aiolm-project-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("project.json");
        std::fs::write(&path, "\u{feff}{\"name\":\"Synthetic workspace\"}").unwrap();
        assert_eq!(
            read_project_json(|| Some(path.clone())).unwrap(),
            Some("{\"name\":\"Synthetic workspace\"}".into())
        );
        for invalid in [
            b"invalid".as_slice(),
            &[0xff],
            &vec![b' '; MAX_PROJECT_BYTES + 1],
        ] {
            std::fs::write(&path, invalid).unwrap();
            assert!(read_project_json(|| Some(path.clone())).is_err());
        }
        assert!(read_project_json(|| Some(root.clone())).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
