//! What this application itself knows about where a model file came from.
//!
//! A receipt is written only when this application fetched the bytes at a path
//! from a Hugging Face repository, or found bytes already there that match that
//! repository's published checksum. Matching size alone proves nothing and
//! writes nothing, so a file that merely happens to be the same length as a
//! repository's artifact never inherits that repository's name.
//!
//! A receipt records the file stamp, so replacing or rewriting the file
//! invalidates the claim, and holds only the public repository id and the
//! repo-relative artifact path. The local path is never stored: it only names
//! the receipt file, through a digest, exactly as the identity cache does.

use super::identity::{stamp, Stamp};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

/// A receipt holds two short public strings; anything larger is not one.
const MAX_RECEIPT_BYTES: u64 = 4 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct DownloadReceipt {
    /// The Hugging Face `namespace/repo` the bytes were served from.
    pub repository: String,
    /// The artifact's path inside that repository.
    pub artifact: String,
}

#[derive(Deserialize, Serialize)]
struct StampedReceipt {
    stamp: Stamp,
    receipt: DownloadReceipt,
}

fn receipt_path(root: &Path, path: &Path) -> PathBuf {
    root.join("model-downloads").join(format!(
        "{:x}.json",
        Sha256::digest(path.as_os_str().as_encoded_bytes())
    ))
}

/// Records that `path` holds `artifact` as served by `repository`.
///
/// Both values are checked against the same rules the downloader applies to a
/// repository id and a repository path, so a malformed claim is refused here
/// rather than stored and filtered later.
pub(crate) fn record(
    root: &Path,
    path: &Path,
    repository: &str,
    artifact: &str,
) -> Result<(), String> {
    crate::discover::validate_repo_id(repository)?;
    crate::discover::validate_repo_path(artifact)?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve the downloaded model: {error}"))?;
    let encoded = serde_json::to_vec(&StampedReceipt {
        stamp: stamp(&path)?,
        receipt: DownloadReceipt {
            repository: repository.trim().to_owned(),
            artifact: artifact.trim().to_owned(),
        },
    })
    .map_err(|error| error.to_string())?;
    crate::config::atomic_write(&receipt_path(root, &path), &encoded)
}

/// The recorded origin of `path`, or `None` when there is none, the file has
/// changed since, or the receipt cannot be read as one.
pub(crate) fn read(root: &Path, path: &Path) -> Option<DownloadReceipt> {
    let path = path.canonicalize().ok()?;
    let current = stamp(&path).ok()?;
    let mut bytes = Vec::new();
    File::open(receipt_path(root, &path))
        .ok()?
        .take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return None;
    }
    let stamped: StampedReceipt = serde_json::from_slice(&bytes).ok()?;
    (stamped.stamp == current).then_some(stamped.receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        root: PathBuf,
        model: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("aiolm-receipt-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let model = root.join("synthetic.gguf");
            fs::write(&model, b"synthetic weights").unwrap();
            Self { root, model }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_recorded_download_names_its_repository_until_the_file_changes() {
        let fixture = Fixture::new();
        assert!(read(&fixture.root, &fixture.model).is_none());
        record(
            &fixture.root,
            &fixture.model,
            "synthetic-org/synthetic-model",
            "quantized/synthetic.gguf",
        )
        .unwrap();
        assert_eq!(
            read(&fixture.root, &fixture.model),
            Some(DownloadReceipt {
                repository: "synthetic-org/synthetic-model".into(),
                artifact: "quantized/synthetic.gguf".into(),
            })
        );
        fs::write(&fixture.model, b"different synthetic weights").unwrap();
        assert!(read(&fixture.root, &fixture.model).is_none());
    }

    #[test]
    fn an_unreadable_receipt_claims_nothing() {
        let fixture = Fixture::new();
        record(
            &fixture.root,
            &fixture.model,
            "synthetic-org/synthetic-model",
            "quantized/synthetic.gguf",
        )
        .unwrap();
        assert!(read(&fixture.root, &fixture.model).is_some());
        // A torn write or foreign bytes at the receipt path must not become
        // provenance: the origin is unknown, not the recorded one.
        let stored = receipt_path(&fixture.root, &fixture.model.canonicalize().unwrap());
        fs::write(&stored, b"{not a receipt").unwrap();
        assert!(read(&fixture.root, &fixture.model).is_none());
    }

    #[test]
    fn a_receipt_holds_no_local_path_and_refuses_an_unsafe_claim() {
        let fixture = Fixture::new();
        record(
            &fixture.root,
            &fixture.model,
            "synthetic-org/synthetic-model",
            "published/artifact.gguf",
        )
        .unwrap();
        let stored = fs::read_to_string(receipt_path(
            &fixture.root,
            &fixture.model.canonicalize().unwrap(),
        ))
        .unwrap();
        assert!(stored.contains("synthetic-org/synthetic-model"));
        assert!(stored.contains("published/artifact.gguf"));
        // Neither the directory the model sits in nor its local file name.
        let directory = fixture.root.to_string_lossy().to_lowercase();
        assert!(!stored
            .to_lowercase()
            .contains(directory.trim_start_matches("\\?\\")));
        assert!(!stored.contains("synthetic.gguf"));
        assert!(record(&fixture.root, &fixture.model, "../escape", "artifact.gguf").is_err());
        assert!(record(
            &fixture.root,
            &fixture.model,
            "synthetic-org/synthetic-model",
            "../artifact.gguf"
        )
        .is_err());
    }
}
