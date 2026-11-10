//! Byte-level resume for model transfers.
//!
//! A transfer writes to a staging file named after its destination and the
//! identity it expects (`.<name>.<key>.part`), so stopping a download - a
//! pause, a dropped connection, or quitting the app - leaves the bytes received
//! so far where the next attempt for the same file finds them. That attempt
//! hashes the staged prefix once, asks the server for the rest with an HTTP
//! range, and keeps hashing as it appends, so the finished file is still checked
//! against the published digest end to end. Staged bytes are discarded when
//! they can no longer become the expected file - a digest mismatch, more bytes
//! than the repository declares, a reply that does not continue them - and for
//! a file with no published digest, which nothing could check them against.
use super::digests::{self, FileDigest};
use super::{
    download_client, ensure_download_parent, validate_response_url, AtomicBool, Ordering, Path,
    PathBuf, DOWNLOAD_BUFFER_BYTES, DOWNLOAD_CANCELLED, DOWNLOAD_UPDATE_INTERVAL, MAX_MODEL_BYTES,
};
use reqwest::{header, StatusCode};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};

const PART_SUFFIX: &str = ".part";
/// Hex digits of the identity key in a staging file name. Staging files from
/// before transfers were resumable used a 32-digit random id instead.
const KEY_DIGITS: usize = 16;
const LEGACY_KEY_DIGITS: usize = 32;

/// Where `target` is staged while it downloads. The key covers the declared
/// size and digest, so a file republished under the same name never appends
/// to bytes staged for its previous contents.
pub(super) fn part_path(target: &Path, size: u64, oid: Option<&str>) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "download destination has no parent".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "download filename is invalid".to_string())?;
    let mut hash = Sha256::new();
    hash.update(b"aiolm-resume\0");
    hash.update(size.to_le_bytes());
    hash.update(oid.unwrap_or_default().to_ascii_lowercase().as_bytes());
    let key = format!("{:x}", hash.finalize());
    Ok(parent.join(format!(".{name}.{}{PART_SUFFIX}", &key[..KEY_DIGITS])))
}

/// Whether `file_name` is a staging file this module (or an earlier,
/// non-resumable transfer) wrote for a destination called `name`.
fn is_part_of(file_name: &str, name: &str) -> bool {
    file_name
        .strip_prefix('.')
        .and_then(|rest| rest.strip_prefix(name))
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| rest.strip_suffix(PART_SUFFIX))
        .is_some_and(|key| {
            matches!(key.len(), KEY_DIGITS | LEGACY_KEY_DIGITS)
                && key.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

/// Staging files kept for `target`, in any identity.
pub(super) fn staged_parts(target: &Path) -> Vec<PathBuf> {
    let (Some(parent), Some(name)) = (
        target.parent(),
        target.file_name().and_then(|value| value.to_str()),
    ) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|file_name| is_part_of(file_name, name))
        })
        .map(|entry| entry.path())
        .collect()
}

async fn remove_part(part: &Path) -> Result<(), String> {
    match tokio::fs::remove_file(part).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot discard staged download: {error}")),
    }
}

/// How much of `part` can be continued, with the digest of those bytes.
/// Staged bytes that cannot be part of the file are removed first.
async fn staged_prefix<'a, F>(
    part: &Path,
    total: u64,
    oid: Option<&'a str>,
    cancel: &AtomicBool,
    progress: &mut F,
) -> Result<(u64, Option<FileDigest<'a>>), String>
where
    F: FnMut(&'static str, u64, u64),
{
    let mut digest = oid.map(|oid| FileDigest::new(oid, total)).transpose()?;
    let metadata = match tokio::fs::symlink_metadata(part).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, digest)),
        Err(error) => return Err(format!("cannot inspect staged download: {error}")),
    };
    if !metadata.is_file() {
        return Err("download staging path is not a regular file".into());
    }
    let length = metadata.len();
    // Without a published digest nothing would ever check bytes staged
    // earlier, so such a file always starts over.
    if length == 0 || length > total || digest.is_none() {
        remove_part(part).await?;
        return Ok((0, digest));
    }
    if let Some(digest) = &mut digest {
        let mut input = tokio::fs::File::open(part)
            .await
            .map_err(|error| format!("cannot read staged download: {error}"))?;
        let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_BYTES];
        let mut read = 0_u64;
        let mut last_progress = std::time::Instant::now();
        progress("verifying", 0, total);
        // Only the length measured above is continued, even if the file grows.
        while read < length {
            if cancel.load(Ordering::Acquire) {
                return Err(DOWNLOAD_CANCELLED.into());
            }
            let want = usize::try_from(length - read)
                .unwrap_or(usize::MAX)
                .min(buffer.len());
            let count = input
                .read(&mut buffer[..want])
                .await
                .map_err(|error| format!("cannot read staged download: {error}"))?;
            if count == 0 {
                return Err("staged download shrank while it was read".into());
            }
            digest.update(&buffer[..count]);
            read += count as u64;
            if last_progress.elapsed() >= DOWNLOAD_UPDATE_INTERVAL {
                progress("verifying", read, total);
                last_progress = std::time::Instant::now();
            }
        }
    }
    Ok((length, digest))
}

/// `Content-Range: bytes <offset>-<total - 1>/<total>` for a continued reply.
fn continues_at(range: Option<&str>, offset: u64, total: u64) -> bool {
    let Some((span, size)) = range
        .map(str::trim)
        .and_then(|range| range.strip_prefix("bytes "))
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let Some((start, end)) = span.split_once('-') else {
        return false;
    };
    start.parse::<u64>().ok() == Some(offset)
        && end.parse::<u64>().ok() == total.checked_sub(1)
        && size.parse::<u64>().ok() == Some(total)
}

/// Bring `target`'s staging file to `total` verified bytes, continuing what an
/// earlier attempt left, and return its path for activation. On cancellation
/// or a transfer error the staged bytes stay for the next attempt.
pub(super) async fn fetch<F>(
    url: &str,
    target: &Path,
    total: u64,
    oid: Option<&str>,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(&'static str, u64, u64),
{
    if total > MAX_MODEL_BYTES {
        return Err("model file exceeds the 512 GiB safety limit".into());
    }
    let oid = oid.filter(|oid| digests::valid_oid(Some(oid)));
    let part = part_path(target, total, oid)?;
    ensure_download_parent(&part).await?;
    for stale in staged_parts(target) {
        if stale != part {
            remove_part(&stale).await?;
        }
    }
    if total == 0 {
        // No response body is needed, but activation still needs a real file
        // and an empty asset must satisfy the same published digest as any other.
        if cancel.load(Ordering::Acquire) {
            return Err(DOWNLOAD_CANCELLED.into());
        }
        if oid
            .map(|oid| FileDigest::new(oid, 0))
            .transpose()?
            .is_some_and(|digest| !digest.matches())
        {
            remove_part(&part).await?;
            return Err("downloaded model checksum does not match Hugging Face metadata".into());
        }
        match tokio::fs::symlink_metadata(&part).await {
            Ok(metadata) if !metadata.is_file() => {
                return Err("download staging path is not a regular file".into());
            }
            Ok(_) => remove_part(&part).await?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot inspect staged download: {error}")),
        }
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .await
            .map_err(|error| format!("cannot stage model download: {error}"))?
            .sync_all()
            .await
            .map_err(|error| format!("cannot flush model download: {error}"))?;
        progress("downloading", 0, 0);
        return Ok(part);
    }
    let mut restarted = false;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(DOWNLOAD_CANCELLED.into());
        }
        let (offset, digest) = staged_prefix(&part, total, oid, cancel, &mut progress).await?;
        if offset == total {
            if digest.is_none_or(FileDigest::matches) {
                progress("downloading", total, total);
                return Ok(part);
            }
            remove_part(&part).await?;
            continue;
        }
        progress("starting", offset, total);
        let mut request = download_client()?
            .get(url)
            .header(header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(header::RANGE, format!("bytes={offset}-"));
        }
        let response = tokio::select! {
            _ = super::snapshots::wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
            response = request.send() => response.map_err(|error| format!("model download failed: {error}"))?
        };
        validate_response_url(&response)?;
        let status = response.status();
        let start = match status {
            StatusCode::PARTIAL_CONTENT
                if offset > 0
                    && continues_at(
                        response
                            .headers()
                            .get(header::CONTENT_RANGE)
                            .and_then(|value| value.to_str().ok()),
                        offset,
                        total,
                    ) =>
            {
                offset
            }
            StatusCode::RANGE_NOT_SATISFIABLE if offset > 0 && !restarted => {
                restarted = true;
                remove_part(&part).await?;
                continue;
            }
            // A full reply: the server ignored the range or none was sent.
            StatusCode::OK => 0,
            _ if status.is_success() => {
                return Err(format!(
                    "model download could not continue from byte {offset}: HTTP {status}"
                ));
            }
            _ => return Err(format!("model download HTTP status: {status}")),
        };
        let expected = total - start;
        if response
            .content_length()
            .is_some_and(|length| length != expected)
        {
            return Err(format!(
                "model download length {} does not match repository metadata {expected}",
                response.content_length().unwrap_or_default()
            ));
        }
        let digest = if start == 0 {
            oid.map(|oid| FileDigest::new(oid, total)).transpose()?
        } else {
            digest
        };
        receive(response, &part, start, total, digest, cancel, &mut progress).await?;
        return Ok(part);
    }
}

/// A failure, and whether the staged bytes can still be continued.
struct Failure {
    message: String,
    keep: bool,
}

impl Failure {
    fn keep(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            keep: true,
        }
    }

    fn discard(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            keep: false,
        }
    }
}

/// Append the reply to `part` from byte `start`, hashing as it is written.
async fn receive<F>(
    mut response: reqwest::Response,
    part: &Path,
    start: u64,
    total: u64,
    mut digest: Option<FileDigest<'_>>,
    cancel: &AtomicBool,
    progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(&'static str, u64, u64),
{
    let output = if start == 0 {
        remove_part(part).await?;
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(part)
            .await
    } else {
        tokio::fs::OpenOptions::new().append(true).open(part).await
    }
    .map_err(|error| format!("cannot stage model download: {error}"))?;
    let mut received = start;
    let result = async {
        // Keep the writer inside this scope so every path closes it before
        // the staging file is removed, including on Windows.
        let mut output = BufWriter::with_capacity(DOWNLOAD_BUFFER_BYTES, output);
        let mut updates = tokio::time::interval(DOWNLOAD_UPDATE_INTERVAL);
        updates.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut reported = received;
        let streamed = async {
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(Failure::keep(DOWNLOAD_CANCELLED));
                }
                let chunk = tokio::select! {
                    biased;
                    _ = updates.tick() => {
                        if received != reported {
                            progress("downloading", received, total);
                            reported = received;
                        }
                        continue;
                    }
                    chunk = response.chunk() => chunk.map_err(|error| {
                        Failure::keep(format!("model download stream failed: {error}"))
                    })?,
                };
                let Some(chunk) = chunk else {
                    return Ok(());
                };
                received = received.saturating_add(chunk.len() as u64);
                if received > total {
                    return Err(Failure::discard("model download reported an unsafe size"));
                }
                output.write_all(&chunk).await.map_err(|error| {
                    Failure::keep(format!("cannot write model download: {error}"))
                })?;
                if let Some(digest) = &mut digest {
                    digest.update(&chunk);
                }
            }
        }
        .await;
        // Whatever arrived is flushed, so a stopped transfer keeps it.
        let flushed = output.flush().await;
        streamed?;
        flushed.map_err(|error| Failure::keep(format!("cannot flush model download: {error}")))?;
        output
            .into_inner()
            .sync_all()
            .await
            .map_err(|error| Failure::keep(format!("cannot flush model download: {error}")))?;
        if received != total {
            return Err(Failure::keep(format!(
                "model download ended at {received} bytes; expected {total}"
            )));
        }
        if digest.is_some_and(|digest| !digest.matches()) {
            return Err(Failure::discard(
                "downloaded model checksum does not match Hugging Face metadata",
            ));
        }
        progress("downloading", received, total);
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(failure) => {
            if !failure.keep {
                let _ = remove_part(part).await;
            }
            if failure.message == DOWNLOAD_CANCELLED {
                progress("cancelled", received, total);
            }
            Err(failure.message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_assets_activate_only_when_the_published_digest_matches() {
        let root = std::env::temp_dir().join(format!("aiolm-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let target = root.join("merges.txt");
        let cancel = AtomicBool::new(false);
        // Git's published identity of an empty blob.
        let empty_oid = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
        let part = fetch(
            "https://huggingface.co/unused",
            &target,
            0,
            Some(empty_oid),
            &cancel,
            |_, _, _| {},
        )
        .await
        .unwrap();
        super::super::activate_download(&part, &target)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"");
        assert!(!part.exists());
        let wrong = root.join("wrong.txt");
        assert!(fetch(
            "https://huggingface.co/unused",
            &wrong,
            0,
            Some("ce013625030ba8dba906f756967f9e9ca394464a"),
            &cancel,
            |_, _, _| {}
        )
        .await
        .unwrap_err()
        .contains("checksum"));
        assert!(!wrong.exists());
        assert!(staged_parts(&wrong).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staging_names_follow_the_expected_identity_and_recognize_older_transfers() {
        let target = Path::new("models").join("model.gguf");
        let first = part_path(&target, 10, Some("a".repeat(64).as_str())).unwrap();
        let same = part_path(&target, 10, Some("A".repeat(64).as_str())).unwrap();
        let republished = part_path(&target, 10, Some("b".repeat(64).as_str())).unwrap();
        assert_eq!(first, same);
        assert_ne!(first, republished);
        let name = first.file_name().unwrap().to_str().unwrap();
        assert!(is_part_of(name, "model.gguf"));
        assert!(is_part_of(
            ".model.gguf.0123456789abcdef0123456789abcdef.part",
            "model.gguf"
        ));
        // Another destination whose name extends this one is not touched.
        assert!(!is_part_of(
            ".model.gguf.json.0123456789abcdef.part",
            "model.gguf"
        ));
        assert!(!is_part_of(".model.gguf.part", "model.gguf"));
        assert!(!is_part_of("model.gguf", "model.gguf"));
    }

    #[test]
    fn a_continued_reply_must_start_at_the_staged_length_and_end_at_the_file_end() {
        assert!(continues_at(Some("bytes 4-9/10"), 4, 10));
        assert!(!continues_at(Some("bytes 0-9/10"), 4, 10));
        assert!(!continues_at(Some("bytes 4-8/10"), 4, 10));
        assert!(!continues_at(Some("bytes 4-9/11"), 4, 10));
        assert!(!continues_at(Some("bytes */10"), 4, 10));
        assert!(!continues_at(None, 4, 10));
    }

    #[tokio::test]
    async fn staged_bytes_resume_with_their_digest_and_impossible_ones_are_dropped() {
        let root = std::env::temp_dir().join(format!("aiolm-resume-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let part = root.join(".model.gguf.0123456789abcdef.part");
        // Git blob identity of "hello\n".
        let oid = "ce013625030ba8dba906f756967f9e9ca394464a";
        let idle = AtomicBool::new(false);
        let verifying = std::cell::Cell::new(false);
        let mut progress = |phase: &'static str, _: u64, _: u64| {
            if phase == "verifying" {
                verifying.set(true);
            }
        };

        assert_eq!(
            staged_prefix(&part, 6, Some(oid), &idle, &mut progress)
                .await
                .unwrap()
                .0,
            0
        );
        std::fs::write(&part, b"hel").unwrap();
        let (offset, digest) = staged_prefix(&part, 6, Some(oid), &idle, &mut progress)
            .await
            .unwrap();
        assert_eq!(offset, 3);
        let mut digest = digest.unwrap();
        digest.update(b"lo\n");
        assert!(digest.matches(), "the staged prefix seeds the digest");
        assert!(verifying.get());

        // More bytes than the repository declares can never become the file.
        std::fs::write(&part, b"hello, world\n").unwrap();
        assert_eq!(
            staged_prefix(&part, 6, Some(oid), &idle, &mut progress)
                .await
                .unwrap()
                .0,
            0
        );
        assert!(!part.exists());

        std::fs::write(&part, b"hel").unwrap();
        assert_eq!(
            staged_prefix(&part, 6, Some(oid), &AtomicBool::new(true), &mut progress)
                .await
                .err()
                .as_deref(),
            Some(DOWNLOAD_CANCELLED)
        );
        // Cancelling while reading keeps the staged bytes.
        assert_eq!(std::fs::read(&part).unwrap(), b"hel");
        std::fs::remove_dir_all(root).unwrap();
    }
}
