//! Immutable app-owned media. References survive history reload without base64 JSON.
pub(crate) mod jobs;
pub(crate) mod preprocessing;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024;
pub const EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "wav", "mp3", "flac", "mp4", "webm",
];

pub fn mime(path: &Path) -> Option<(&'static str, &'static str)> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "webp" => Some(("image", "image/webp")),
        "wav" => Some(("audio", "audio/wav")),
        "mp3" => Some(("audio", "audio/mpeg")),
        "flac" => Some(("audio", "audio/flac")),
        "mp4" => Some(("video", "video/mp4")),
        "webm" => Some(("video", "video/webm")),
        _ => None,
    }
}
fn root() -> Result<PathBuf, String> {
    Ok(crate::home::resolve_aiolm_home()?.join("media"))
}
fn reference_path(root: &Path, reference: &str) -> Result<PathBuf, String> {
    let Some((hash, extension)) = reference.split_once('.') else {
        return Err("invalid media reference".into());
    };
    if hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !EXTENSIONS.contains(&extension)
    {
        return Err("invalid media reference".into());
    }
    Ok(root.join(reference))
}

/// Resolve only immutable references inside the application's media store.
/// Preprocessors use this same ownership check as ordinary chat attachments.
pub(crate) fn owned_path(reference: &str) -> Result<PathBuf, String> {
    let directory = root()?
        .canonicalize()
        .map_err(|error| format!("attachment storage is unavailable: {error}"))?;
    let path = reference_path(&directory, reference)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| format!("attachment is missing: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("owned media was replaced by a link".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_MEDIA_BYTES {
        return Err("stored media must be nonempty and at most 64 MiB".into());
    }
    if path.canonicalize().map_err(|error| error.to_string())? != path {
        return Err("owned media was replaced by a link".into());
    }
    Ok(path)
}

pub(crate) struct OwnedAudio {
    pub filename: String,
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

pub(crate) fn read_owned_audio(reference: &str) -> Result<OwnedAudio, String> {
    let path = owned_path(reference)?;
    let (kind, mime) = mime(&path).ok_or("unsupported stored media")?;
    if kind != "audio" {
        return Err("select an audio attachment for transcription".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_MEDIA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err("stored media must be nonempty and at most 64 MiB".into());
    }
    if !reference.starts_with(&format!("{:x}.", Sha256::digest(&bytes))) {
        return Err("stored audio no longer matches its immutable reference".into());
    }
    Ok(OwnedAudio {
        filename: reference.to_owned(),
        mime,
        bytes,
    })
}

/// Size of `path` when it names a file in the media store itself: a regular,
/// unlinked file whose name is a valid reference, directly inside the store.
/// mlx-vlm reads video by path, and this is the only local path a request may
/// carry to it.
pub fn owned_file_size(path: &str) -> Option<u64> {
    owned_file_size_in(&root().ok()?, path)
}

fn owned_file_size_in(root: &Path, path: &str) -> Option<u64> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return None;
    }
    let metadata = fs::symlink_metadata(candidate).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_MEDIA_BYTES
    {
        return None;
    }
    let directory = root.canonicalize().ok()?;
    let canonical = candidate.canonicalize().ok()?;
    let reference = canonical.file_name()?.to_str()?;
    (canonical.parent()? == directory && reference_path(&directory, reference).ok()? == canonical)
        .then_some(metadata.len())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub kind: &'static str,
    pub mime: &'static str,
    pub data_url: String,
    pub size_bytes: u64,
}
pub fn import_selected(path: &Path, mut file: fs::File) -> Result<Attachment, String> {
    import_to(&root()?, path, &mut file)
}

/// Store a sampled frame without constructing an unused attachment preview.
fn import_selected_reference(path: &Path, mut file: fs::File) -> Result<String, String> {
    import_reference_to(&root()?, path, &mut file)
}

fn import_reference_to(root: &Path, path: &Path, file: &mut fs::File) -> Result<String, String> {
    store_to(root, path, file).map(|stored| stored.reference)
}

struct StoredMedia {
    reference: String,
    kind: &'static str,
    mime: &'static str,
    bytes: Vec<u8>,
    size: u64,
}

fn import_to(root: &Path, path: &Path, file: &mut fs::File) -> Result<Attachment, String> {
    let StoredMedia {
        reference,
        kind,
        mime,
        bytes,
        size,
    } = store_to(root, path, file)?;
    Ok(Attachment {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        reference,
        kind,
        mime,
        data_url: if kind == "image" {
            format!("data:{mime};base64,{}", STANDARD.encode(bytes))
        } else {
            String::new()
        },
        size_bytes: size,
    })
}

fn store_to(root: &Path, path: &Path, file: &mut fs::File) -> Result<StoredMedia, String> {
    let (kind, mime) = mime(path).ok_or("unsupported media format")?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if size == 0 || size > MAX_MEDIA_BYTES {
        return Err("media must be nonempty and at most 64 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_MEDIA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err("media exceeds 64 MiB".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let reference = format!("{:x}.{extension}", Sha256::digest(&bytes));
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let target = reference_path(root, &reference)?;
    if !target.exists() {
        crate::config::atomic_write(&target, &bytes)?;
    }
    Ok(StoredMedia {
        reference,
        kind,
        mime,
        bytes,
        size,
    })
}

pub fn resolve(
    reference: &str,
    provider: crate::providers::ProviderId,
) -> Result<serde_json::Value, String> {
    let directory = root()?
        .canonicalize()
        .map_err(|error| format!("attachment storage is unavailable: {error}"))?;
    let path = reference_path(&directory, reference)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| format!("attachment is missing: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("owned media was replaced by a link".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_MEDIA_BYTES {
        return Err("stored media must be nonempty and at most 64 MiB".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("attachment is missing: {error}"))?;
    if canonical != path {
        return Err("owned media was replaced by a link".into());
    }
    let (kind, mime) = mime(&path).ok_or("unsupported stored media")?;
    if kind == "video" && provider == crate::providers::ProviderId::MlxVlm {
        return Ok(
            serde_json::json!({"type":"video_url", "video_url":{"url":path.to_string_lossy()}}),
        );
    }
    let mut file = fs::File::open(&path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_MEDIA_BYTES {
        return Err("stored media exceeds 64 MiB".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_MEDIA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err("stored media exceeds 64 MiB".into());
    }
    let data = STANDARD.encode(bytes);
    Ok(match kind {
        "image" => {
            serde_json::json!({"type":"image_url","image_url":{"url":format!("data:{mime};base64,{data}")}})
        }
        "audio" => {
            serde_json::json!({"type":"input_audio","input_audio":{"data":if provider == crate::providers::ProviderId::MlxVlm { format!("data:{mime};base64,{data}") } else { data },"format":path.extension().unwrap_or_default().to_string_lossy()}})
        }
        _ if provider == crate::providers::ProviderId::Llama => {
            serde_json::json!({"type":"input_video","input_video":{"data":data}})
        }
        _ => {
            serde_json::json!({"type":"video_url","video_url":{"url":format!("data:{mime};base64,{data}")}})
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn references_cannot_escape_owned_storage() {
        for value in [
            "../a.wav",
            "/tmp/a.mp4",
            "x.png",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.exe",
        ] {
            assert!(reference_path(Path::new("media"), value).is_err());
        }
    }
    #[test]
    fn owned_import_keeps_bytes_and_has_a_content_identity() {
        use std::io::{Seek, SeekFrom};

        let root = std::env::temp_dir().join(format!("aiolm-media-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let owned = root.join("owned");
        let original = root.join("source.wav");
        fs::write(&original, b"RIFF fixture").unwrap();
        let media = import_to(&owned, &original, &mut fs::File::open(&original).unwrap()).unwrap();
        assert_eq!(media.name, "source.wav");
        assert_eq!(media.kind, "audio");
        assert_eq!(media.mime, "audio/wav");
        assert_eq!(media.size_bytes, 12);
        assert!(media.data_url.is_empty());
        assert_eq!(
            media.reference,
            format!("{:x}.wav", Sha256::digest(b"RIFF fixture"))
        );
        assert_eq!(
            fs::read(owned.join(&media.reference)).unwrap(),
            b"RIFF fixture"
        );

        let image = root.join("source.JPG");
        let image_bytes = [0, 255, 128, 42];
        fs::write(&image, image_bytes).unwrap();
        let imported = import_to(&owned, &image, &mut fs::File::open(&image).unwrap()).unwrap();
        assert_eq!(imported.name, "source.JPG");
        assert_eq!(imported.kind, "image");
        assert_eq!(imported.mime, "image/jpeg");
        assert_eq!(imported.size_bytes, 4);
        assert_eq!(imported.data_url, "data:image/jpeg;base64,AP+AKg==");
        assert_eq!(
            imported.reference,
            format!("{:x}.jpg", Sha256::digest(image_bytes))
        );
        let target = owned.join(&imported.reference);
        assert_eq!(fs::read(&target).unwrap(), image_bytes);
        // Existing target bytes stay untouched; the preview still comes from
        // the selected source, as it does for the original import path.
        fs::write(&target, b"existing target bytes").unwrap();
        let duplicate = import_to(&owned, &image, &mut fs::File::open(&image).unwrap()).unwrap();
        assert_eq!(duplicate.reference, imported.reference);
        assert_eq!(duplicate.name, imported.name);
        assert_eq!(duplicate.kind, imported.kind);
        assert_eq!(duplicate.mime, imported.mime);
        assert_eq!(duplicate.size_bytes, imported.size_bytes);
        assert_eq!(duplicate.data_url, imported.data_url);
        assert_eq!(fs::read(&target).unwrap(), b"existing target bytes");

        let video = root.join("source.webm");
        fs::write(&video, b"video").unwrap();
        let video = import_to(&owned, &video, &mut fs::File::open(&video).unwrap()).unwrap();
        assert_eq!(video.name, "source.webm");
        assert_eq!(video.kind, "video");
        assert_eq!(video.mime, "video/webm");
        assert_eq!(video.size_bytes, 5);
        assert!(video.data_url.is_empty());
        assert_eq!(
            video.reference,
            format!("{:x}.webm", Sha256::digest(b"video"))
        );
        assert_eq!(fs::read(owned.join(&video.reference)).unwrap(), b"video");

        // Import reads from the caller's current offset while reporting the
        // full source metadata size; do not turn this change into a rewind.
        let mut offset = fs::File::open(&image).unwrap();
        offset.seek(SeekFrom::Start(1)).unwrap();
        let suffix = import_to(&owned, &image, &mut offset).unwrap();
        assert_eq!(suffix.size_bytes, 4);
        assert_eq!(suffix.data_url, "data:image/jpeg;base64,/4Aq");
        assert_eq!(
            suffix.reference,
            format!("{:x}.jpg", Sha256::digest([255, 128, 42]))
        );
        assert_eq!(
            fs::read(owned.join(&suffix.reference)).unwrap(),
            [255, 128, 42]
        );
        offset.seek(SeekFrom::End(0)).unwrap();
        let at_end = import_to(&owned, &image, &mut offset).unwrap();
        assert_eq!(at_end.size_bytes, 4);
        assert_eq!(at_end.reference, format!("{:x}.jpg", Sha256::digest([])));
        assert_eq!(at_end.data_url, "data:image/jpeg;base64,");
        assert!(fs::read(owned.join(&at_end.reference)).unwrap().is_empty());

        let empty = root.join("empty.jpg");
        fs::write(&empty, b"").unwrap();
        let oversized = root.join("oversized.jpg");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_MEDIA_BYTES + 1)
            .unwrap();
        // MIME rejection precedes the empty-file metadata check.
        let unsupported = root.join("unsupported.txt");
        fs::write(&unsupported, b"").unwrap();
        let rejected_root = root.join("rejected");
        for (path, expected) in [
            (&empty, "media must be nonempty and at most 64 MiB"),
            (&oversized, "media must be nonempty and at most 64 MiB"),
            (&unsupported, "unsupported media format"),
        ] {
            let error = import_to(&rejected_root, path, &mut fs::File::open(path).unwrap())
                .err()
                .unwrap();
            assert_eq!(error, expected);
        }
        assert!(!rejected_root.exists());
        // Reference-only imports preserve image identity, bytes and import
        // errors without building a preview.
        let reference_owned = root.join("reference-owned");
        let reference = import_reference_to(
            &reference_owned,
            &image,
            &mut fs::File::open(&image).unwrap(),
        )
        .unwrap();
        assert_eq!(reference, imported.reference);
        let reference_target = reference_owned.join(&reference);
        assert_eq!(fs::read(&reference_target).unwrap(), image_bytes);
        fs::write(&reference_target, b"existing reference target bytes").unwrap();
        assert_eq!(
            import_reference_to(
                &reference_owned,
                &image,
                &mut fs::File::open(&image).unwrap(),
            )
            .unwrap(),
            reference
        );
        assert_eq!(
            fs::read(&reference_target).unwrap(),
            b"existing reference target bytes"
        );

        let mut reference_offset = fs::File::open(&image).unwrap();
        reference_offset.seek(SeekFrom::Start(1)).unwrap();
        let reference_suffix =
            import_reference_to(&reference_owned, &image, &mut reference_offset).unwrap();
        assert_eq!(reference_suffix, suffix.reference);
        assert_eq!(
            fs::read(reference_owned.join(&reference_suffix)).unwrap(),
            [255, 128, 42]
        );
        reference_offset.seek(SeekFrom::End(0)).unwrap();
        let reference_at_end =
            import_reference_to(&reference_owned, &image, &mut reference_offset).unwrap();
        assert_eq!(reference_at_end, at_end.reference);
        assert!(fs::read(reference_owned.join(&reference_at_end))
            .unwrap()
            .is_empty());

        let reference_rejected = root.join("reference-rejected");
        for (path, expected) in [
            (&empty, "media must be nonempty and at most 64 MiB"),
            (&oversized, "media must be nonempty and at most 64 MiB"),
            (&unsupported, "unsupported media format"),
        ] {
            let error = import_reference_to(
                &reference_rejected,
                path,
                &mut fs::File::open(path).unwrap(),
            )
            .err()
            .unwrap();
            assert_eq!(error, expected);
        }
        assert!(!reference_rejected.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_files_directly_in_the_store_count_as_owned_paths() {
        let root = std::env::temp_dir().join(format!("aiolm-owned-{}", uuid::Uuid::new_v4()));
        let store = root.join("media");
        fs::create_dir_all(&store).unwrap();
        let name = format!("{}.mp4", "a".repeat(64));
        fs::write(store.join(&name), b"video").unwrap();
        fs::write(root.join(&name), b"video").unwrap();
        fs::write(store.join("clip.mp4"), b"video").unwrap();
        fs::create_dir_all(store.join("nested")).unwrap();
        fs::write(store.join("nested").join(&name), b"video").unwrap();
        let owned = store.join(&name);
        assert_eq!(
            owned_file_size_in(&store, &owned.to_string_lossy()),
            Some(5)
        );
        assert_eq!(
            owned_file_size_in(
                &store,
                &store
                    .join("nested")
                    .join("..")
                    .join(&name)
                    .to_string_lossy()
            ),
            Some(5)
        );
        for candidate in [
            root.join(&name),
            store.join("clip.mp4"),
            store.join("nested").join(&name),
            store.clone(),
        ] {
            assert_eq!(
                owned_file_size_in(&store, &candidate.to_string_lossy()),
                None,
                "{}",
                candidate.display()
            );
        }
        assert_eq!(
            owned_file_size_in(&store, &name),
            None,
            "relative paths are never owned"
        );
        fs::write(store.join(&name), b"").unwrap();
        assert_eq!(
            owned_file_size_in(&store, &owned.to_string_lossy()),
            None,
            "empty files are not media"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
