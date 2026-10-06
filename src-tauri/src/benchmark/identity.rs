//! The app does not hash models. This module only reads digests that an earlier
//! build cached, and never reads a model. The cache is invalidated by file
//! metadata changes. A Hugging Face or MLX snapshot directory is identified by
//! its format, its immutable upstream revision when one is known, and AioLM's
//! local fingerprint of the files as they are now; none of those is a content
//! digest, so a snapshot is never reported with a `sha256`.
use crate::providers::artifacts::{self, ArtifactFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct ModelIdentity {
    pub status: String,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
    /// Weight format. Absent in records written before formats were recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ArtifactFormat>,
    /// Upstream commit of a snapshot, from its Hugging Face cache directory or
    /// download manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// `artifacts::local_fingerprint` of a snapshot: relative paths, sizes,
    /// modification times and small JSON files. It detects local changes; it
    /// is not a digest of the weights.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_fingerprint: Option<String>,
    /// How the model was packaged, when that could be established without
    /// guessing. Absent in records written before this was collected, and
    /// absent from the identity cache: it is gathered per run, not digested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<super::model_metadata::BenchmarkModelMetadata>,
}

/// What a file looked like when a claim about it was made. Any change to it
/// invalidates the claim, whether that claim is a digest or a download receipt.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Stamp {
    size: u64,
    modified: Option<u128>,
    created: Option<u128>,
}

#[derive(Deserialize, Serialize)]
struct CachedIdentity {
    stamp: Stamp,
    identity: ModelIdentity,
}

pub(crate) fn stamp(path: &Path) -> Result<Stamp, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("model identity requires a regular file".into());
    }
    Ok(Stamp {
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_nanos()),
        created: metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_nanos()),
    })
}

fn cache_path(root: &Path, path: &Path) -> PathBuf {
    root.join("model-identities").join(format!(
        "{:x}.json",
        Sha256::digest(path.as_os_str().as_encoded_bytes())
    ))
}

fn unidentified(path: &Path) -> ModelIdentity {
    // A digest of only the first GGUF shard is not the model's digest. Keep
    // multipart identity explicitly unknown until a shard-manifest is supported.
    let multipart = path
        .file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.rsplit_once("-of-").is_some_and(|(prefix, total)| {
                total.len() == 5
                    && total.parse::<u32>().is_ok_and(|total| total > 1)
                    && prefix
                        .rsplit_once('-')
                        .is_some_and(|(_, index)| index.len() == 5 && index.parse::<u32>().is_ok())
            })
        });
    ModelIdentity {
        status: if multipart {
            "multipart"
        } else {
            "unidentified"
        }
        .into(),
        sha256: None,
        metadata: None,
        format: gguf_format(path),
        revision: None,
        local_fingerprint: None,
        size_bytes: if multipart {
            None
        } else {
            fs::metadata(path)
                .ok()
                .filter(|meta| meta.is_file())
                .map(|meta| meta.len())
        },
    }
}

fn read_cached(path: &Path) -> Option<CachedIdentity> {
    const LIMIT: u64 = 16 * 1024;
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > LIMIT {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn gguf_format(path: &Path) -> Option<ArtifactFormat> {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
        .then_some(ArtifactFormat::Gguf)
}

fn snapshot(path: &Path) -> ModelIdentity {
    let artifact = artifacts::inspect_snapshot(path);
    ModelIdentity {
        status: "unidentified".into(),
        sha256: None,
        // A partial download's byte count is not the model's size.
        size_bytes: (!artifact.incomplete && artifact.size_bytes > 0)
            .then_some(artifact.size_bytes),
        format: Some(artifact.format),
        local_fingerprint: Some(artifacts::local_fingerprint(
            path,
            artifact.revision.as_deref(),
        )),
        revision: artifact.revision,
        metadata: None,
    }
}

pub(crate) fn cached(root: &Path, path: &Path) -> ModelIdentity {
    if path.is_dir() {
        return snapshot(path);
    }
    let fallback = unidentified(path);
    if fallback.status == "multipart" {
        return fallback;
    }
    let Ok(path) = path.canonicalize() else {
        return fallback;
    };
    let Ok(current) = stamp(&path) else {
        return fallback;
    };
    let cached = read_cached(&cache_path(root, &path));
    cached
        .filter(|value| {
            value.stamp == current
                && current.modified.is_some()
                && value.identity.status == "sha256"
                && value.identity.size_bytes == Some(current.size)
                && value.identity.sha256.as_ref().is_some_and(|hash| {
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        })
        .map(|value| ModelIdentity {
            format: gguf_format(&path),
            ..value.identity
        })
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes the cache entry an earlier build stored after hashing `model`.
    /// The app no longer hashes models, so tests seed that legacy shape directly.
    fn seed_legacy_cache(root: &Path, model: &Path, contents: &[u8]) -> ModelIdentity {
        let resolved = model.canonicalize().unwrap();
        let identity = ModelIdentity {
            status: "sha256".into(),
            sha256: Some(format!("{:x}", Sha256::digest(contents))),
            size_bytes: Some(contents.len() as u64),
            format: Some(ArtifactFormat::Gguf),
            revision: None,
            local_fingerprint: None,
            metadata: None,
        };
        let entry = serde_json::json!({
            "stamp": stamp(&resolved).unwrap(),
            "identity": { "status": identity.status, "sha256": identity.sha256, "size_bytes": identity.size_bytes },
        });
        crate::config::atomic_write(
            &cache_path(root, &resolved),
            serde_json::to_string(&entry).unwrap().as_bytes(),
        )
        .unwrap();
        identity
    }

    #[test]
    fn legacy_digest_is_reused_until_model_changes() {
        let root = std::env::temp_dir().join(format!("aiolm-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let model = root.join("synthetic.gguf");
        fs::write(&model, b"synthetic model").unwrap();
        assert_eq!(cached(&root, &model).status, "unidentified");
        let identity = seed_legacy_cache(&root, &model, b"synthetic model");
        assert_eq!(cached(&root, &model), identity);
        fs::write(&model, b"changed synthetic model").unwrap();
        assert_eq!(cached(&root, &model).status, "unidentified");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_digest_cache_predates_model_metadata() {
        let root = std::env::temp_dir().join(format!("aiolm-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let model = root.join("synthetic.gguf");
        fs::write(&model, b"synthetic model").unwrap();

        // A cache an earlier build wrote has no metadata field at all and is
        // still read rather than discarded.
        seed_legacy_cache(&root, &model, b"synthetic model");
        let stored = fs::read_to_string(cache_path(&root, &model.canonicalize().unwrap())).unwrap();
        assert!(!stored.contains("metadata"));
        let reused = cached(&root, &model);
        assert_eq!(reused.status, "sha256");
        assert!(reused.metadata.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_snapshot_keeps_format_and_revision_without_claiming_a_digest() {
        let root = std::env::temp_dir().join(format!("aiolm-identity-{}", uuid::Uuid::new_v4()));
        let revision = "0123456789abcdef0123456789abcdef01234567";
        let snapshot = root
            .join("models--org--name")
            .join("snapshots")
            .join(revision);
        fs::create_dir_all(&snapshot).unwrap();
        fs::write(
            snapshot.join("config.json"),
            br#"{"model_type":"llama","architectures":["LlamaForCausalLM"]}"#,
        )
        .unwrap();
        fs::write(snapshot.join("model.safetensors"), b"synthetic weights").unwrap();
        fs::write(snapshot.join("tokenizer.json"), b"{}").unwrap();

        let identity = cached(&root, &snapshot);
        assert_eq!(identity.status, "unidentified");
        assert_eq!(identity.sha256, None);
        assert_eq!(identity.format, Some(ArtifactFormat::HfSafetensors));
        assert_eq!(identity.revision.as_deref(), Some(revision));
        let fingerprint = identity.local_fingerprint.clone().unwrap();
        assert!(
            fingerprint.len() == 64 && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        );

        // A local edit changes the fingerprint; the upstream revision stays.
        fs::write(
            snapshot.join("config.json"),
            br#"{"model_type":"llama","architectures":["LlamaForCausalLM"],"edited":true}"#,
        )
        .unwrap();
        let edited = cached(&root, &snapshot);
        assert_eq!(edited.revision.as_deref(), Some(revision));
        assert_ne!(edited.local_fingerprint, Some(fingerprint));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_shard_is_never_claimed_as_complete_model_identity() {
        let identity = unidentified(Path::new("synthetic-00001-of-00002.gguf"));
        assert_eq!(identity.status, "multipart");
        assert!(identity.sha256.is_none());
        assert!(identity.size_bytes.is_none());
    }
}
