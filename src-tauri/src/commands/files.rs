//! Shared file identity checks for native selections and model deletion.
use crate::error::AppError;
use std::fs;
use std::path::Path;

pub(super) fn open_verified_file(
    path: &Path,
    expected: &Path,
    label: &str,
) -> Result<fs::File, AppError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidInput {
            return AppError::validation(format!("cannot open {label}: {error}"));
        }
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return AppError::validation(format!("cannot open {label}: {error}"));
        }
        AppError::io(&format!("cannot open {label}"), &error)
    })?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io(&format!("cannot inspect {label}"), &error))?;
    if !metadata.is_file() {
        return Err(AppError::validation(format!(
            "{label} is not a regular file"
        )));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::validation(format!(
                "{label} must not be a reparse point"
            )));
        }
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| AppError::io(&format!("cannot resolve {label}"), &error))?;
    if resolved != expected {
        return Err(AppError::validation(format!(
            "{label} changed while it was being opened"
        )));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_file_open_requires_a_regular_file_and_matching_identity() {
        let root =
            std::env::temp_dir().join(format!("aiolm-verified-file-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create verified file directory");
        let file_path = root.join("safe.txt");
        fs::write(&file_path, b"safe").expect("write verified file");
        let canonical = file_path
            .canonicalize()
            .expect("canonicalize verified file");
        assert!(super::open_verified_file(&canonical, &canonical, "document").is_ok());
        assert!(super::open_verified_file(&root, &root, "document").is_err());
        let error = super::open_verified_file(&file_path, &root, "document").unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert_eq!(error.message, "document changed while it was being opened");
        let missing = root.join("missing.txt");
        let error = super::open_verified_file(&missing, &missing, "document").unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::NotFound);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn verified_file_open_rejects_symbolic_links_as_invalid_selections() {
        let root =
            std::env::temp_dir().join(format!("aiolm-verified-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("target.txt");
        fs::write(&target, b"safe").unwrap();
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let expected = target.canonicalize().unwrap();
        let error = super::open_verified_file(&link, &expected, "document").unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert!(error.message.starts_with("cannot open document:"));
        fs::remove_dir_all(root).unwrap();
    }
}
