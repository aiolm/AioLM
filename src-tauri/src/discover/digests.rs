//! Published SHA256 content identities and Git blob SHA1 identities.
use super::io_error;
use super::{
    hash_existing_file, AtomicBool, Ordering, Path, DOWNLOAD_BUFFER_BYTES, DOWNLOAD_CANCELLED,
    DOWNLOAD_UPDATE_INTERVAL,
};
use crate::error::AppError;
use crate::providers::artifacts::SnapshotFile;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

#[derive(Clone, Copy, PartialEq)]
enum Algorithm {
    Sha256,
    GitBlob,
}

fn identity(oid: &str) -> Option<(Algorithm, &str)> {
    let (prefix, hex) = oid
        .split_once(':')
        .map_or((None, oid), |(prefix, hex)| (Some(prefix), hex));
    let algorithm = match hex.len() {
        64 if prefix.is_none_or(|prefix| prefix.eq_ignore_ascii_case("sha256")) => {
            Algorithm::Sha256
        }
        40 if prefix.is_none_or(|prefix| prefix.eq_ignore_ascii_case("sha1")) => Algorithm::GitBlob,
        _ => return None,
    };
    hex.bytes()
        .all(|byte| byte.is_ascii_hexdigit())
        .then_some((algorithm, hex))
}

pub(super) fn valid_oid(oid: Option<&str>) -> bool {
    oid.and_then(identity).is_some()
}

pub(super) fn identities_equal(a: Option<&str>, b: Option<&str>) -> bool {
    match (a.and_then(identity), b.and_then(identity)) {
        (Some((left_algorithm, left)), Some((right_algorithm, right))) => {
            left_algorithm == right_algorithm && left.eq_ignore_ascii_case(right)
        }
        _ => false,
    }
}

enum Hasher {
    Sha256(Sha256),
    GitBlob(Sha1),
}

fn matches_hex(actual: &[u8], expected: &str) -> bool {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    actual.len() * 2 == expected.len()
        && actual
            .iter()
            .zip(expected.as_bytes().as_chunks::<2>().0)
            .all(|(byte, hex)| {
                HEX[(byte >> 4) as usize] == hex[0].to_ascii_lowercase()
                    && HEX[(byte & 15) as usize] == hex[1].to_ascii_lowercase()
            })
}

/// The streaming downloader uses the same identity rules as local verification.
pub(super) struct FileDigest<'a> {
    expected: &'a str,
    hasher: Hasher,
}

impl<'a> FileDigest<'a> {
    pub(super) fn new(oid: &'a str, size: u64) -> Result<Self, AppError> {
        let (algorithm, expected) = identity(oid)
            .ok_or_else(|| AppError::validation("snapshot file has an invalid digest"))?;
        let hasher = match algorithm {
            Algorithm::Sha256 => Hasher::Sha256(Sha256::new()),
            Algorithm::GitBlob => {
                let mut hasher = Sha1::new();
                // Git hashes the decimal length and NUL-terminated blob header,
                // not just the bytes. A u64 needs at most 20 decimal digits.
                let mut digits = [0u8; 20];
                let mut start = digits.len();
                let mut length = size;
                loop {
                    start -= 1;
                    digits[start] = b'0' + (length % 10) as u8;
                    length /= 10;
                    if length == 0 {
                        break;
                    }
                }
                hasher.update(b"blob ");
                hasher.update(&digits[start..]);
                hasher.update(b"\0");
                Hasher::GitBlob(hasher)
            }
        };
        Ok(Self { expected, hasher })
    }

    pub(super) fn update(&mut self, bytes: &[u8]) {
        match &mut self.hasher {
            Hasher::Sha256(hasher) => hasher.update(bytes),
            Hasher::GitBlob(hasher) => hasher.update(bytes),
        }
    }

    pub(super) fn matches(self) -> bool {
        match self.hasher {
            Hasher::Sha256(hasher) => matches_hex(&hasher.finalize(), self.expected),
            Hasher::GitBlob(hasher) => matches_hex(&hasher.finalize(), self.expected),
        }
    }
}

pub(super) async fn verify_file_digest(
    path: &Path,
    file: &SnapshotFile,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    verify_file_digest_with_progress(path, file, cancel, |_| {}).await
}

pub(super) async fn verify_file_digest_with_progress<F: FnMut(u64)>(
    path: &Path,
    file: &SnapshotFile,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<(), AppError> {
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled(DOWNLOAD_CANCELLED));
    }
    let oid = file
        .oid
        .as_deref()
        .ok_or_else(|| AppError::validation("snapshot file has no digest"))?;
    let (algorithm, expected) =
        identity(oid).ok_or_else(|| AppError::validation("snapshot file has an invalid digest"))?;
    let metadata = tokio::fs::symlink_metadata(path).await.map_err(|error| {
        io_error(
            &error,
            format!("cannot inspect snapshot file {}: {error}", file.path),
        )
    })?;
    if !metadata.is_file() || metadata.len() != file.size {
        return Err(AppError::validation(format!(
            "snapshot file failed verification: {}",
            file.path
        )));
    }
    let matches = match algorithm {
        Algorithm::Sha256 => hash_existing_file(path, file.size, cancel, progress)
            .await?
            .eq_ignore_ascii_case(expected),
        Algorithm::GitBlob => {
            let mut input = tokio::fs::File::open(path).await.map_err(|error| {
                io_error(&error, format!("cannot verify snapshot file: {error}"))
            })?;
            let metadata = input
                .metadata()
                .await
                .map_err(|error| AppError::from_io(&error))?;
            if !metadata.is_file() || metadata.len() != file.size {
                return Err(AppError::validation(format!(
                    "snapshot file failed verification: {}",
                    file.path
                )));
            }
            let mut hash = FileDigest::new(oid, file.size)?;
            let mut buffer = vec![0; DOWNLOAD_BUFFER_BYTES];
            let mut read = 0u64;
            let mut last_progress = std::time::Instant::now();
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(AppError::cancelled(DOWNLOAD_CANCELLED));
                }
                let count = input.read(&mut buffer).await.map_err(|error| {
                    io_error(&error, format!("cannot hash snapshot file: {error}"))
                })?;
                if count == 0 {
                    break;
                }
                read = read.saturating_add(count as u64);
                if read > file.size {
                    return Err(AppError::validation(
                        "snapshot file grew while it was verified",
                    ));
                }
                hash.update(&buffer[..count]);
                if last_progress.elapsed() >= DOWNLOAD_UPDATE_INTERVAL {
                    progress(read);
                    last_progress = std::time::Instant::now();
                }
            }
            if read != file.size {
                return Err(AppError::validation(
                    "snapshot file shrank while it was verified",
                ));
            }
            progress(read);
            hash.matches()
        }
    };
    if !matches {
        return Err(AppError::validation(format!(
            "snapshot file failed verification: {}",
            file.path
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELLO_SHA256: &str = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
    const HELLO_GIT: &str = "ce013625030ba8dba906f756967f9e9ca394464a";

    fn fixture() -> (std::path::PathBuf, SnapshotFile) {
        let root = std::env::temp_dir().join(format!("aiolm-digests-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("config.json"), b"hello\n").unwrap();
        let file = SnapshotFile {
            remote_path: None,
            path: "config.json".into(),
            size: 6,
            oid: Some(HELLO_GIT.into()),
        };
        (root, file)
    }

    #[test]
    fn published_identities_normalize_algorithm_prefix_and_hex_case() {
        for (raw, prefix) in [(HELLO_SHA256, "SHA256"), (HELLO_GIT, "SHA1")] {
            let prefixed = format!("{prefix}:{}", raw.to_ascii_uppercase());
            assert!(valid_oid(Some(raw)));
            assert!(valid_oid(Some(&prefixed)));
            assert!(identities_equal(Some(raw), Some(&prefixed)));
        }
        for invalid in [
            None,
            Some(""),
            Some("sha256:abc"),
            Some("sha1:abc"),
            Some("md5:abc"),
        ] {
            assert!(!valid_oid(invalid));
            assert!(!identities_equal(invalid, invalid));
        }
        assert!(!identities_equal(Some(HELLO_GIT), Some(HELLO_SHA256)));
        assert!(!valid_oid(Some(&"g".repeat(40))));
        assert!(!valid_oid(Some(&format!("sha256:{HELLO_GIT}"))));
        assert!(!valid_oid(Some(&format!("sha1:{HELLO_SHA256}"))));
    }

    #[test]
    fn streamed_digests_accept_arbitrary_chunk_boundaries_and_include_blob_size() {
        for oid in [HELLO_SHA256, HELLO_GIT] {
            let mut digest = FileDigest::new(oid, 6).unwrap();
            for chunk in [b"h".as_slice(), b"ell", b"o\n"] {
                digest.update(chunk);
            }
            assert!(digest.matches());
        }
        let mut wrong_header = FileDigest::new(HELLO_GIT, 5).unwrap();
        wrong_header.update(b"hello\n");
        assert!(!wrong_header.matches());
    }

    #[tokio::test]
    async fn verifies_sha256_and_git_blob_against_known_published_ids() {
        let (root, mut file) = fixture();
        let path = root.join(&file.path);
        let cancel = AtomicBool::new(false);
        for oid in [
            HELLO_SHA256.to_owned(),
            format!("sha256:{}", HELLO_SHA256.to_ascii_uppercase()),
            HELLO_GIT.to_owned(),
            format!("sha1:{}", HELLO_GIT.to_ascii_uppercase()),
        ] {
            file.oid = Some(oid);
            verify_file_digest(&path, &file, &cancel).await.unwrap();
        }
        // SHA1(body) is not the Git blob identity: the header is essential.
        file.oid = Some("f572d396fae9206628714fb2ce00f72e94f2258f".into());
        assert!(verify_file_digest(&path, &file, &cancel).await.is_err());
        file.oid = Some(HELLO_GIT.into());
        std::fs::write(&path, b"world\n").unwrap();
        assert!(verify_file_digest(&path, &file, &cancel).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"world\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rejects_missing_identity_wrong_size_nonfiles_and_cancellation() {
        let (root, mut file) = fixture();
        let path = root.join(&file.path);
        let idle = AtomicBool::new(false);
        for oid in [None, Some("invalid".into())] {
            file.oid = oid;
            assert_eq!(
                verify_file_digest(&path, &file, &idle)
                    .await
                    .unwrap_err()
                    .kind,
                crate::error::ErrorKind::Validation,
            );
        }
        file.oid = Some(HELLO_GIT.into());
        assert_eq!(
            verify_file_digest(&path, &file, &AtomicBool::new(true))
                .await
                .unwrap_err(),
            AppError::cancelled(DOWNLOAD_CANCELLED)
        );
        file.size = 5;
        assert!(verify_file_digest(&path, &file, &idle).await.is_err());
        file.size = 6;
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            verify_file_digest(&path, &file, &idle)
                .await
                .unwrap_err()
                .kind,
            crate::error::ErrorKind::NotFound,
        );
        std::fs::create_dir(&path).unwrap();
        assert!(verify_file_digest(&path, &file, &idle).await.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn empty_git_blob_uses_the_zero_length_header() {
        let (root, mut file) = fixture();
        let path = root.join(&file.path);
        std::fs::write(&path, b"").unwrap();
        file.size = 0;
        file.oid = Some("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391".into());
        verify_file_digest(&path, &file, &AtomicBool::new(false))
            .await
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_symbolic_links_even_when_the_target_digest_matches() {
        let (root, mut file) = fixture();
        std::os::unix::fs::symlink(root.join(&file.path), root.join("linked.json")).unwrap();
        file.path = "linked.json".into();
        assert!(
            verify_file_digest(&root.join(&file.path), &file, &AtomicBool::new(false))
                .await
                .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
