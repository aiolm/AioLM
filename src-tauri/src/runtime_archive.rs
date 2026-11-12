//! Bounded extraction of runtime and source archives. Tar library aliases are
//! materialized as files so installed bundles need no symlink privileges and
//! cannot retain links out of their private staging directory.

use crate::error::AppError;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::{MAX_ARCHIVE_ENTRIES, MAX_EXTRACTED_BYTES};

// GNU/PAX metadata is consumed internally by tar before an entry is returned.
// Bound that work independently from streaming file contents so compressed
// long-name or sparse-header payloads cannot exhaust memory during next().
const MAX_TAR_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES: usize = 4096;

struct TarReader<'a, R> {
    inner: R,
    remaining: Rc<Cell<u64>>,
    cancel: &'a AtomicBool,
}

impl<R: Read> Read for TarReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.cancel.load(Ordering::Acquire) {
            return Err(std::io::Error::other("runtime install cancelled"));
        }
        let remaining = self.remaining.get();
        if remaining == 0 {
            return Err(std::io::Error::other(
                "runtime tar metadata exceeds the configured size limit",
            ));
        }
        let limit = remaining.min(buffer.len() as u64) as usize;
        let bytes = self.inner.read(&mut buffer[..limit])?;
        self.remaining.set(remaining - bytes as u64);
        Ok(bytes)
    }
}

fn archive_read_error(error: std::io::Error, cancel: &AtomicBool) -> AppError {
    if cancel.load(Ordering::Acquire) {
        AppError::cancelled(error.to_string())
    } else {
        AppError::validation(error.to_string())
    }
}

fn cancelled(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Acquire) {
        Err(AppError::cancelled("runtime install cancelled"))
    } else {
        Ok(())
    }
}

fn safe_path(value: &str) -> Result<PathBuf, AppError> {
    if value.len() > MAX_ARCHIVE_PATH_BYTES
        || value.starts_with('/')
        || value.contains(['\\', ':', '\0'])
    {
        return Err(AppError::validation(
            "runtime archive contains an unsafe path",
        ));
    }
    let mut path = PathBuf::new();
    for component in value.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                return Err(AppError::validation(
                    "runtime archive contains an unsafe path",
                ))
            }
            _ => path.push(component),
        }
    }
    Ok(path)
}

fn link_target(path: &Path, value: &str, hard_link: bool) -> Result<PathBuf, AppError> {
    if value.len() > MAX_ARCHIVE_PATH_BYTES
        || value.starts_with('/')
        || value.contains(['\\', ':', '\0'])
    {
        return Err(AppError::validation(
            "runtime archive link has an unsafe target",
        ));
    }
    let mut target = if hard_link {
        PathBuf::new()
    } else {
        path.parent().unwrap_or(Path::new("")).to_path_buf()
    };
    for component in value.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                if !target.pop() {
                    return Err(AppError::validation(
                        "runtime archive link escapes staging directory",
                    ));
                }
            }
            _ => target.push(component),
        }
    }
    if target.as_os_str().is_empty() {
        return Err(AppError::validation(
            "runtime archive link has an empty target",
        ));
    }
    Ok(target)
}

fn prepare_root(root: &Path) -> Result<(), AppError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root).map_err(|error| AppError::from_io(&error))?;
            fs::symlink_metadata(root).map_err(|error| AppError::from_io(&error))?
        }
        Err(error) => return Err(AppError::from_io(&error)),
    };
    // Only the private extraction root must be plain. A selected data
    // directory above it may legitimately be reached through an alias.
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AppError::validation(
            "Cannot extract runtime files into a linked folder or an existing file.",
        ));
    }
    Ok(())
}

fn prepare_parent(root: &Path, relative: &Path) -> Result<PathBuf, AppError> {
    let mut current = root.to_path_buf();
    for component in relative.parent().unwrap_or(Path::new("")).components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(AppError::validation(
                    "runtime archive parent is not a regular directory",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| AppError::from_io(&error))?
            }
            Err(error) => return Err(AppError::from_io(&error)),
        }
    }
    Ok(root.join(relative))
}

fn add_size(total: &mut u64, bytes: u64) -> Result<(), AppError> {
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| AppError::validation("runtime archive expanded size overflow"))?;
    if *total > MAX_EXTRACTED_BYTES {
        return Err(AppError::validation(
            "runtime archive expands beyond the configured size limit",
        ));
    }
    Ok(())
}

fn copy_entry(
    reader: impl Read,
    size: u64,
    path: &Path,
    mode: Option<u32>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::validation(error.to_string())
            } else {
                AppError::from_io(&error)
            }
        })?;
    let mut reader = reader.take(size.saturating_add(1));
    let mut buffer = [0_u8; 64 * 1024];
    let mut copied = 0_u64;
    loop {
        cancelled(cancel)?;
        let bytes = reader
            .read(&mut buffer)
            .map_err(|error| archive_read_error(error, cancel))?;
        if bytes == 0 {
            break;
        }
        copied += bytes as u64;
        if copied > size {
            return Err(AppError::validation(
                "runtime archive entry size changed while extracting",
            ));
        }
        std::io::Write::write_all(&mut output, &buffer[..bytes])
            .map_err(|error| AppError::from_io(&error))?;
    }
    if copied != size {
        return Err(AppError::validation(
            "runtime archive entry size changed while extracting",
        ));
    }
    set_file_mode(path, mode)?;
    Ok(())
}

fn set_file_mode(path: &Path, mode: Option<u32>) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Preserve execution, strip special bits and group/world write access.
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(mode.unwrap_or(0o644) & 0o755 | 0o600),
        )
        .map_err(|error| AppError::from_io(&error))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

pub(super) fn extract(path: &Path, dest: &Path, cancel: &Arc<AtomicBool>) -> Result<(), AppError> {
    prepare_root(dest)?;
    let mut file = fs::File::open(path).map_err(|error| AppError::from_io(&error))?;
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic)
        .map_err(|error| AppError::validation(error.to_string()))?;
    drop(file);
    let file = fs::File::open(path).map_err(|error| AppError::from_io(&error))?;
    if magic == [0x1f, 0x8b] {
        extract_tar(
            flate2::read::GzDecoder::new(BufReader::new(file)),
            dest,
            cancel,
        )
    } else {
        extract_zip(file, dest, cancel)
    }
}

fn extract_zip(file: fs::File, dest: &Path, cancel: &AtomicBool) -> Result<(), AppError> {
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| AppError::validation(error.to_string()))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::validation(
            "runtime archive contains too many entries",
        ));
    }
    let mut total = 0;
    for index in 0..archive.len() {
        cancelled(cancel)?;
        let entry = archive
            .by_index(index)
            .map_err(|error| AppError::validation(error.to_string()))?;
        let mode = entry.unix_mode();
        if mode.is_some_and(|mode| (mode & 0o170000) == 0o120000) {
            return Err(AppError::validation(
                "runtime archive contains a symbolic link",
            ));
        }
        let name = entry
            .name()
            .map_err(|error| AppError::validation(error.to_string()))?;
        let relative = safe_path(&name)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = prepare_parent(dest, &relative)?;
        if entry.is_dir() {
            prepare_parent(dest, &relative.join(".child"))?;
            continue;
        }
        let size = entry.size();
        add_size(&mut total, size)?;
        copy_entry(entry, size, &output, mode, cancel)?;
    }
    Ok(())
}

fn extract_tar(reader: impl Read, dest: &Path, cancel: &AtomicBool) -> Result<(), AppError> {
    let remaining = Rc::new(Cell::new(MAX_TAR_METADATA_BYTES));
    let mut archive = tar::Archive::new(TarReader {
        inner: reader,
        remaining: remaining.clone(),
        cancel,
    });
    let mut total = 0;
    let mut files = HashSet::new();
    let mut links = HashMap::new();
    let mut entries = archive
        .entries()
        .map_err(|error| archive_read_error(error, cancel))?;
    let mut count = 0;
    loop {
        cancelled(cancel)?;
        remaining.set(MAX_TAR_METADATA_BYTES);
        let Some(entry) = entries.next() else {
            break;
        };
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(AppError::validation(
                "runtime archive contains too many entries",
            ));
        }
        let entry = entry.map_err(|error| archive_read_error(error, cancel))?;
        let relative = safe_path(
            &String::from_utf8(entry.path_bytes().into_owned())
                .map_err(|_| AppError::validation("runtime archive path is not UTF-8"))?,
        )?;
        let kind = entry.header().entry_type();
        if relative.as_os_str().is_empty() {
            if kind.is_dir() {
                continue;
            }
            return Err(AppError::validation(
                "runtime archive contains an empty file path",
            ));
        }
        let output = prepare_parent(dest, &relative)?;
        if kind.is_dir() {
            prepare_parent(dest, &relative.join(".child"))?;
            continue;
        }
        if files.contains(&relative) || links.contains_key(&relative) {
            return Err(AppError::validation("runtime archive repeats a file path"));
        }
        if kind.is_symlink() || kind.is_hard_link() {
            let target = entry
                .link_name_bytes()
                .ok_or_else(|| AppError::validation("runtime archive link has no target"))?;
            let target = std::str::from_utf8(&target)
                .map_err(|_| AppError::validation("runtime archive link target is not UTF-8"))?;
            links.insert(
                relative.clone(),
                link_target(&relative, target, kind.is_hard_link())?,
            );
        } else if kind.is_file() {
            let size = entry.size();
            let mode = entry
                .header()
                .mode()
                .map_err(|error| AppError::validation(error.to_string()))?;
            add_size(&mut total, size)?;
            remaining.set(size.saturating_add(1));
            copy_entry(entry, size, &output, Some(mode), cancel)?;
            files.insert(relative);
        } else {
            return Err(AppError::validation(
                "runtime archive contains an unsupported special file",
            ));
        }
    }
    // Resolve only against regular archive files. Never create a filesystem
    // symlink, and count every materialized alias toward the expansion limit.
    for (relative, initial) in &links {
        cancelled(cancel)?;
        let mut target = initial;
        let mut visited = HashSet::new();
        while let Some(next) = links.get(target) {
            if visited.len() >= 64 || !visited.insert(target) {
                return Err(AppError::validation(
                    "runtime archive contains cyclic or overly deep links",
                ));
            }
            target = next;
        }
        if !files.contains(target) {
            return Err(AppError::validation(
                "runtime archive link does not target a regular archive file",
            ));
        }
        let source = dest.join(target);
        let metadata = fs::metadata(&source).map_err(|error| AppError::from_io(&error))?;
        add_size(&mut total, metadata.len())?;
        let output = prepare_parent(dest, relative)?;
        let file = fs::File::open(source).map_err(|error| AppError::from_io(&error))?;
        copy_entry(file, metadata.len(), &output, None, cancel)?;
        fs::set_permissions(&output, metadata.permissions())
            .map_err(|error| AppError::from_io(&error))?;
    }
    Ok(())
}

/// Releases wrap Unix binaries and CUDA sidecars in one top-level directory.
/// Source archives and exported bundles retain their root through `extract`.
pub(super) fn extract_release(
    path: &Path,
    dest: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    prepare_root(dest)?;
    let unpacked = dest.join(format!(".unpack-{}", uuid::Uuid::new_v4().simple()));
    extract(path, &unpacked, cancel)?;
    let entries = fs::read_dir(&unpacked)
        .map_err(|error| AppError::from_io(&error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::from_io(&error))?;
    let root = if entries.len() == 1
        && entries[0]
            .file_type()
            .map_err(|error| AppError::from_io(&error))?
            .is_dir()
    {
        entries[0].path()
    } else {
        unpacked.clone()
    };
    for entry in fs::read_dir(&root).map_err(|error| AppError::from_io(&error))? {
        cancelled(cancel)?;
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        let output = dest.join(entry.file_name());
        if output.exists() {
            if output.is_file()
                && entry.path().is_file()
                && super::sha256_file(&output)? == super::sha256_file(&entry.path())?
            {
                continue;
            }
            return Err(AppError::validation(
                "runtime release archives contain conflicting files",
            ));
        }
        fs::rename(entry.path(), output).map_err(|error| AppError::from_io(&error))?;
    }
    fs::remove_dir_all(&unpacked).map_err(|error| AppError::from_io(&error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "aiolm-archive-test-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tar_file(path: &Path, entries: &[(&str, &[u8], Option<&str>)]) {
        let encoder = flate2::write::GzEncoder::new(
            fs::File::create(path).unwrap(),
            flate2::Compression::default(),
        );
        let mut archive = tar::Builder::new(encoder);
        for (name, contents, link) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_path(name).unwrap();
            header.set_mode(0o755);
            if let Some(target) = link {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_link_name(target).unwrap();
                header.set_size(0);
            } else {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(contents.len() as u64);
            }
            header.set_cksum();
            archive.append(&header, *contents).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
    }

    #[cfg(any(unix, windows))]
    fn link_directory(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let output = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(any(unix, windows))]
    fn unlink_directory(link: &Path) {
        // A Unix symlink is a file entry while a Windows junction is a
        // directory entry; either removal leaves the link target intact.
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
    }

    fn zip_file(path: &Path) {
        let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
        archive
            .start_file(
                "runtime/llama-server",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        std::io::Write::write_all(&mut archive, b"server").unwrap();
        archive.finish().unwrap();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn extraction_refuses_linked_staging_roots_before_writing_archive_contents() {
        let mut observations = Vec::new();
        for tar in [false, true] {
            for release in [false, true] {
                let fixture = Fixture::new();
                let path = fixture
                    .0
                    .join(if tar { "runtime.tar.gz" } else { "runtime.zip" });
                if tar {
                    tar_file(&path, &[("runtime/llama-server", b"server", None)]);
                } else {
                    zip_file(&path);
                }
                let outside = fixture.0.join("outside staging");
                fs::create_dir(&outside).unwrap();
                fs::write(outside.join("existing.txt"), b"preserved").unwrap();
                let dest = fixture.0.join("linked staging");
                link_directory(&outside, &dest);
                let cancel = Arc::new(AtomicBool::new(false));
                let result = if release {
                    extract_release(&path, &dest, &cancel)
                } else {
                    extract(&path, &dest, &cancel)
                };
                unlink_directory(&dest);
                assert_eq!(
                    fs::read(outside.join("existing.txt")).unwrap(),
                    b"preserved"
                );
                observations.push((
                    tar,
                    release,
                    result.err(),
                    fs::read_dir(&outside).unwrap().count(),
                ));
            }
        }
        assert!(
            observations
                .iter()
                .all(|(_, _, error, entries)| error.is_some() && *entries == 1),
            "{observations:?}"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn extraction_keeps_regular_staging_under_a_selected_parent_alias() {
        let fixture = Fixture::new();
        let path = fixture.0.join("runtime.tar.gz");
        tar_file(&path, &[("runtime/llama-server", b"server", None)]);
        let selected = fixture.0.join("selected data");
        fs::create_dir(&selected).unwrap();
        let alias = fixture.0.join("selected alias");
        link_directory(&selected, &alias);
        let dest = alias.join("private staging");
        let cancel = Arc::new(AtomicBool::new(false));
        let result = extract_release(&path, &dest, &cancel);
        unlink_directory(&alias);
        result.unwrap();
        assert_eq!(
            fs::read(selected.join("private staging").join("llama-server")).unwrap(),
            b"server"
        );
        assert_eq!(
            fs::read_dir(selected.join("private staging"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn extraction_merges_companions_into_an_existing_regular_staging_directory() {
        let fixture = Fixture::new();
        let path = fixture.0.join("runtime.tar.gz");
        tar_file(&path, &[("runtime/llama-server", b"server", None)]);
        let dest = fixture.0.join("private staging");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("companion.dll"), b"companion").unwrap();
        extract_release(&path, &dest, &Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(fs::read(dest.join("llama-server")).unwrap(), b"server");
        assert_eq!(fs::read(dest.join("companion.dll")).unwrap(), b"companion");
        assert_eq!(fs::read_dir(dest).unwrap().count(), 2);
    }

    fn long_name_tar(metadata: &[u8]) -> Vec<u8> {
        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_path("././@LongLink").unwrap();
        header.set_entry_type(tar::EntryType::GNULongName);
        header.set_size(metadata.len() as u64);
        header.set_cksum();
        archive.append(&header, metadata).unwrap();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_path("placeholder").unwrap();
        header.set_mode(0o644);
        header.set_size(7);
        header.set_cksum();
        archive.append(&header, &b"payload"[..]).unwrap();
        archive.into_inner().unwrap()
    }

    #[test]
    fn compressed_extended_metadata_is_bounded_before_tar_allocates_it() {
        let fixture = Fixture::new();
        let malicious = long_name_tar(&vec![b'x'; MAX_TAR_METADATA_BYTES as usize + 1024]);
        let path = fixture.0.join("metadata.tar.gz");
        let mut encoder = flate2::write::GzEncoder::new(
            fs::File::create(&path).unwrap(),
            flate2::Compression::best(),
        );
        std::io::Write::write_all(&mut encoder, &malicious).unwrap();
        encoder.finish().unwrap();
        assert!(fs::metadata(&path).unwrap().len() < 16 * 1024);
        let error = extract(
            &path,
            &fixture.0.join("out"),
            &Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert!(error.message.contains("metadata exceeds"), "{error}");
    }

    #[test]
    fn valid_extended_names_still_extract() {
        let fixture = Fixture::new();
        let name = format!("root/{}", "a".repeat(150));
        let archive = long_name_tar(format!("{name}\0").as_bytes());
        extract_tar(archive.as_slice(), &fixture.0, &AtomicBool::new(false)).unwrap();
        assert_eq!(fs::read(fixture.0.join(name)).unwrap(), b"payload");
    }

    #[test]
    fn cancellation_interrupts_tars_internal_metadata_parser() {
        struct CancellingReader<'a> {
            bytes: std::io::Cursor<Vec<u8>>,
            cancel: &'a AtomicBool,
        }
        impl Read for CancellingReader<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let bytes = self.bytes.read(buffer)?;
                self.cancel.store(true, Ordering::Release);
                Ok(bytes)
            }
        }
        let fixture = Fixture::new();
        let cancel = AtomicBool::new(false);
        let reader = CancellingReader {
            bytes: std::io::Cursor::new(long_name_tar(b"root/file\0")),
            cancel: &cancel,
        };
        let error = extract_tar(reader, &fixture.0, &cancel).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
        assert!(error.message.contains("cancelled"), "{error}");
        assert!(!fixture.0.join("root/file").exists());
    }

    #[test]
    fn release_tarballs_flatten_the_wrapper_and_materialize_soname_aliases() {
        let fixture = Fixture::new();
        let path = fixture.0.join("runtime.tar.gz");
        tar_file(
            &path,
            &[
                ("llama-b123/libllama.so", b"", Some("libllama.so.0")),
                ("llama-b123/libllama.so.0", b"", Some("libllama.so.0.1")),
                ("llama-b123/libllama.so.0.1", b"library", None),
                ("llama-b123/llama-server", b"executable", None),
            ],
        );
        let dest = fixture.0.join("staging");
        extract_release(&path, &dest, &Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(fs::read(dest.join("libllama.so")).unwrap(), b"library");
        assert!(!fs::symlink_metadata(dest.join("libllama.so"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!dest.join("llama-b123").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dest.join("llama-server"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0o111
            );
        }
    }

    #[test]
    fn tar_links_cannot_escape_form_cycles_or_redirect_later_files() {
        for entries in [
            vec![("root/lib.so", &b""[..], Some("../../outside"))],
            vec![
                ("root/a", &b""[..], Some("b")),
                ("root/b", &b""[..], Some("a")),
            ],
            vec![
                ("root/sub", &b""[..], Some("../elsewhere")),
                ("root/sub/file", &b"secret"[..], None),
            ],
        ] {
            let fixture = Fixture::new();
            let path = fixture.0.join("bad.tar.gz");
            tar_file(&path, &entries);
            assert!(extract(
                &path,
                &fixture.0.join("out"),
                &Arc::new(AtomicBool::new(false))
            )
            .is_err());
            assert!(!fixture.0.join("outside").exists());
        }
    }

    #[test]
    fn tar_path_policy_is_the_same_on_windows_and_unix() {
        for value in [
            "../escape",
            "root/../../escape",
            "/absolute",
            "C:/absolute",
            "root\\escape",
        ] {
            let error = safe_path(value).unwrap_err();
            assert_eq!(error.kind, crate::error::ErrorKind::Validation, "{value}");
        }
        assert_eq!(
            safe_path("./root/llama-server").unwrap(),
            PathBuf::from("root/llama-server")
        );
    }

    #[cfg(unix)]
    #[test]
    fn exported_zip_executable_modes_survive_import() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let path = fixture.0.join("runtime.zip");
        let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        archive
            .start_file(
                "runtime/llama-server",
                zip::write::SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        std::io::Write::write_all(&mut archive, b"server").unwrap();
        archive.finish().unwrap();
        let dest = fixture.0.join("out");
        extract(&path, &dest, &Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(
            fs::metadata(dest.join("runtime/llama-server"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0o111
        );
    }

    #[test]
    fn tar_cancellation_does_not_activate_a_runtime() {
        let fixture = Fixture::new();
        let path = fixture.0.join("runtime.tar.gz");
        tar_file(&path, &[("root/llama-server", b"server", None)]);
        let dest = fixture.0.join("out");
        assert!(
            extract_release(&path, &dest, &Arc::new(AtomicBool::new(true)))
                .unwrap_err()
                .message
                .contains("cancelled")
        );
        assert!(!dest.join("llama-server").exists());
    }
}
