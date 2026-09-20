//! Content identification is explicit, runs while idle, and never reads a model
//! during a measured trial. The cache is invalidated by file metadata changes.
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
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: Option<u128>,
    created: Option<u128>,
}

#[derive(Deserialize, Serialize)]
struct CachedIdentity {
    stamp: Stamp,
    identity: ModelIdentity,
}

fn stamp(path: &Path) -> Result<Stamp, String> {
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

pub(crate) fn cached(root: &Path, path: &Path) -> ModelIdentity {
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
        .map(|value| value.identity)
        .unwrap_or(fallback)
}

pub(crate) fn identify(root: &Path, path: &Path) -> Result<ModelIdentity, String> {
    let fallback = unidentified(path);
    if fallback.status == "multipart" {
        return Err("multipart models require a complete shard manifest; a first-shard digest cannot identify the model".into());
    }
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let before = stamp(&path)?;
    let mut file = File::open(&path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if before != stamp(&path)? {
        return Err(
            "model changed while computing its content identity; retry after file writes finish"
                .into(),
        );
    }
    let identity = ModelIdentity {
        status: "sha256".into(),
        sha256: Some(format!("{:x}", hash.finalize())),
        size_bytes: Some(before.size),
    };
    let encoded = serde_json::to_vec(&CachedIdentity {
        stamp: before,
        identity: identity.clone(),
    })
    .map_err(|error| error.to_string())?;
    crate::config::atomic_write(&cache_path(root, &path), &encoded)?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_digest_is_reused_until_model_changes() {
        let root = std::env::temp_dir().join(format!("aiolm-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let model = root.join("synthetic.gguf");
        fs::write(&model, b"synthetic model").unwrap();
        assert_eq!(cached(&root, &model).status, "unidentified");
        let identity = identify(&root, &model).unwrap();
        assert_eq!(
            identity.sha256,
            Some(format!("{:x}", Sha256::digest(b"synthetic model")))
        );
        assert_eq!(cached(&root, &model), identity);
        fs::write(&model, b"changed synthetic model").unwrap();
        assert_eq!(cached(&root, &model).status, "unidentified");
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
