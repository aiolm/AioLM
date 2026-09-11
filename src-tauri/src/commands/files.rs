//! Shared file identity checks for native selections and model deletion.
use std::fs;
use std::path::Path;

pub(super) fn open_verified_file(
    path: &Path,
    expected: &Path,
    label: &str,
) -> Result<fs::File, String> {
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
    let file = options
        .open(path)
        .map_err(|error| format!("cannot open {label}: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot inspect {label}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("{label} must not be a reparse point"));
        }
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve {label}: {error}"))?;
    if resolved != expected {
        return Err(format!("{label} changed while it was being opened"));
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
        assert!(super::open_verified_file(&file_path, &root, "document").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
