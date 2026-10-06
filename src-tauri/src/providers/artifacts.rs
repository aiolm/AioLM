//! Model artifact inspection.
//!
//! A model is identified by what its files say, not by its file extension: a
//! GGUF header, or a snapshot directory's `config.json`, weight index,
//! tokenizer and processor files. Missing or partially downloaded files are
//! reported as readiness problems of the artifact; whether an engine can load
//! it is decided separately in `compat`.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Manifest written next to a snapshot AioLM downloaded. Its presence is what
/// makes a directory app-owned; its `complete` flag is what makes it whole.
pub const SNAPSHOT_MANIFEST: &str = ".aiolm-snapshot.json";
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

/// A cache namespace changes when local weights or tokenizer/config files
/// change, including edits to a previously downloaded immutable revision.
pub fn local_fingerprint(dir: &Path, revision: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(revision.unwrap_or("local").as_bytes());
    let mut pending = vec![(dir.to_path_buf(), 0)];
    let mut files = Vec::new();
    while let Some((path, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(path) else {
            continue;
        };
        for entry in entries
            .flatten()
            .take(100_000usize.saturating_sub(files.len()))
        {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() && depth < 8 {
                pending.push((entry.path(), depth + 1));
            } else if kind.is_file() || (kind.is_symlink() && entry.path().is_file()) {
                files.push(entry.path());
            }
        }
        if files.len() >= 100_000 {
            break;
        }
    }
    files.sort();
    for path in files {
        digest.update(
            path.strip_prefix(dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .as_bytes(),
        );
        if let Ok(metadata) = fs::metadata(&path) {
            digest.update(metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified().and_then(|time| {
                time.duration_since(std::time::UNIX_EPOCH)
                    .map_err(std::io::Error::other)
            }) {
                digest.update(modified.as_nanos().to_le_bytes());
            }
            if path.extension().is_some_and(|value| value == "json")
                && metadata.len() <= MAX_CONFIG_BYTES
            {
                if let Ok(bytes) = fs::read(&path) {
                    digest.update(bytes);
                }
            }
        }
    }
    format!("{:x}", digest.finalize())
}
const MAX_INDEX_BYTES: u64 = 32 * 1024 * 1024;
const PARTIAL_SUFFIXES: &[&str] = &[".part", ".incomplete", ".aiolm-part", ".tmp"];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactFormat {
    Gguf,
    /// Hugging Face Transformers layout with safetensors weights.
    HfSafetensors,
    /// An MLX conversion (mlx-community layout, `quantization` in config.json).
    Mlx,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactRole {
    Model,
    /// A llama.cpp multimodal projector (`mmproj`).
    Projector,
    Embedding,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modalities {
    pub text: bool,
    pub image: bool,
    pub audio: bool,
    pub video: bool,
}

impl Modalities {
    pub fn text_only() -> Self {
        Self {
            text: true,
            ..Self::default()
        }
    }

    pub fn intersect(self, other: Self) -> Self {
        Self {
            text: self.text && other.text,
            image: self.image && other.image,
            audio: self.audio && other.audio,
            video: self.video && other.video,
        }
    }

    pub fn names(self) -> Vec<&'static str> {
        [
            ("text", self.text),
            ("image", self.image),
            ("audio", self.audio),
            ("video", self.video),
        ]
        .into_iter()
        .filter_map(|(name, present)| present.then_some(name))
        .collect()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SnapshotFile {
    pub path: String,
    pub size: u64,
    /// Hugging Face LFS sha256 or git blob id, as the hub reported it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oid: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SnapshotManifest {
    pub format: u32,
    pub repository: String,
    /// Commit the files were resolved at; never a moving branch name.
    pub revision: String,
    pub files: Vec<SnapshotFile>,
    pub complete: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ModelArtifact {
    /// Stable identity: the canonical path of the GGUF file (first shard) or
    /// snapshot directory. Profiles and sessions refer to this path.
    pub path: String,
    pub name: String,
    pub format: ArtifactFormat,
    pub role: ArtifactRole,
    pub size_bytes: u64,
    pub file_count: usize,
    pub architectures: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    pub has_tokenizer: bool,
    pub has_processor: bool,
    pub has_chat_template: bool,
    /// What the model itself accepts, inferred from its configuration. The
    /// usable set is the intersection with the runtime (see `compat`).
    pub modalities: Modalities,
    /// Required files that are absent, relative to the artifact.
    pub missing: Vec<String>,
    /// A download did not finish: partial files or an incomplete manifest.
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// `app` (downloaded and owned by AioLM), `hf-cache` (files are links into
    /// a shared Hugging Face cache) or `external`.
    pub ownership: &'static str,
    /// Things the inspection could not read; never silently dropped.
    pub notes: Vec<String>,
}

impl ModelArtifact {
    pub fn ready_files(&self) -> bool {
        self.missing.is_empty() && !self.incomplete
    }
}

fn read_json(path: &Path, limit: u64) -> Option<Result<Value, String>> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    if metadata.len() > limit {
        return Some(Err(format!("{} is too large to inspect", path.display())));
    }
    Some(
        fs::read(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))
            .and_then(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
            }),
    )
}

/// A directory is a snapshot candidate when it has a model configuration and
/// either safetensors weights or a weight index.
pub fn is_snapshot_dir(dir: &Path) -> bool {
    if !dir.join("config.json").is_file() {
        return false;
    }
    if dir.join("model.safetensors.index.json").is_file() {
        return true;
    }
    fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            name.ends_with(".safetensors")
                || PARTIAL_SUFFIXES
                    .iter()
                    .any(|suffix| name.ends_with(&format!(".safetensors{suffix}")))
        })
    }) || dir.join(SNAPSHOT_MANIFEST).is_file()
}

fn has_any(dir: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| dir.join(name).is_file())
}

/// vllm-metal v0.30.0 quant/awq_config.py: affine 4-bit GEMM AWQ only.
pub fn metal_awq_problem(dir: &Path) -> Option<String> {
    let config = match read_json(&dir.join("config.json"), MAX_CONFIG_BYTES) {
        Some(Ok(config)) => config,
        _ => return Some("cannot establish the local AWQ quantization configuration".into()),
    };
    let Some(quant) = config.get("quantization_config") else {
        return Some("AWQ checkpoint is missing quantization_config".into());
    };
    let bits = quant
        .get("bits")
        .or_else(|| quant.get("w_bit"))
        .and_then(Value::as_u64);
    let group = quant
        .get("group_size")
        .or_else(|| quant.get("q_group_size"))
        .and_then(Value::as_u64);
    let version = quant
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("gemm");
    (bits != Some(4)
        || group != Some(128)
        || quant
            .get("zero_point")
            .is_some_and(|value| value != &Value::Bool(true))
        || !version.eq_ignore_ascii_case("gemm"))
    .then(|| {
        "vllm-metal AWQ requires bits=4, group_size=128, zero_point=true and version=gemm".into()
    })
}

/// The exact pinned mlx-lm loader repacks NVFP4 compressed tensors.
pub fn metal_compressed_tensors_problem(dir: &Path) -> Option<String> {
    match read_json(&dir.join("config.json"), MAX_CONFIG_BYTES) {
        Some(Ok(config)) if config.get("quantization_config")
            .and_then(|q| q.get("format")).and_then(Value::as_str) == Some("nvfp4-pack-quantized") => None,
        _ => Some("Metal compressed-tensors loading requires an evidenced nvfp4-pack-quantized configuration".into()),
    }
}

/// An adjacent config/tokenizer is the only GGUF companion binding the app
/// offers on Metal. Embedded GGUF tokens alone do not satisfy its MLX loader.
pub fn metal_gguf_problem(artifact: &ModelArtifact) -> Option<String> {
    let path = Path::new(&artifact.path);
    let check = || -> Result<(), String> {
        if path.extension().is_none_or(|extension| extension != "gguf") {
            return Err("vllm-metal requires a local file with the .gguf extension".into());
        }
        if crate::models::shard_name(&artifact.name).is_some() {
            return Err(
                "vllm-metal does not load sharded GGUF files; merge the shards first".into(),
            );
        }
        let facts = crate::gguf::read_model_facts(path)?;
        if facts.split_count.is_some_and(|count| count > 1) {
            return Err("vllm-metal does not load sharded GGUF files".into());
        }
        let arch = artifact
            .architectures
            .first()
            .map(String::as_str)
            .unwrap_or("");
        if !["qwen2", "qwen3", "llama"].contains(&arch) {
            return Err(format!("vllm-metal GGUF supports only dense qwen2/qwen3/llama architectures, found '{arch}'"));
        }
        let dir = path.parent().ok_or("GGUF has no companion directory")?;
        let config = read_json(&dir.join("config.json"), MAX_CONFIG_BYTES)
            .ok_or("Metal GGUF requires matching config.json beside the weights")??;
        let model_type = config
            .get("model_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        let companion_arch = if model_type == "mistral" {
            "llama"
        } else {
            model_type
        };
        if companion_arch != arch
            || object_has(
                &config,
                &[
                    "vision_config",
                    "audio_config",
                    "num_local_experts",
                    "num_experts",
                ],
            )
        {
            return Err("Metal GGUF companion config must match the dense weights architecture and contain no vision/audio/MoE model".into());
        }
        if !has_any(dir, &["tokenizer.json", "tokenizer.model", "spiece.model"])
            && !(dir.join("vocab.json").is_file() && dir.join("merges.txt").is_file())
        {
            return Err("Metal GGUF requires a matching local tokenizer beside the weights".into());
        }
        let tensors = crate::gguf::read_tensor_types(path)?;
        let mut names = BTreeSet::new();
        for (name, kind) in &tensors {
            if !names.insert(name.as_str()) {
                return Err(format!("duplicate GGUF tensor '{name}'"));
            }
            if [
                "attn_qkv",
                "ssm_",
                "_exps",
                "ffn_gate_inp",
                "mmproj",
                "mm.",
                "v.blk",
                "v.patch",
            ]
            .iter()
            .any(|marker| name.contains(marker))
            {
                return Err(format!(
                    "Metal GGUF rejects fused-QKV/SSM/MoE/vision tensor '{name}'"
                ));
            }
            // GGML tensor types, not the unrelated general.file_type enum.
            if ![0, 1, 2, 3, 8, 30].contains(kind)
                || (name.ends_with(".bias") && ![0, 1, 30].contains(kind))
            {
                return Err(format!("Metal GGUF rejects tensor type {kind} on '{name}'; supported: F32/F16/BF16/Q4_0/Q4_1/Q8_0"));
            }
        }
        if !names.contains("token_embd.weight")
            || !names.contains("output_norm.weight")
            || !names.iter().any(|name| name.starts_with("blk."))
        {
            return Err("Metal GGUF requires a complete dense decoder tensor table".into());
        }
        Ok(())
    };
    check().err()
}

fn object_has(config: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| config.get(*key).is_some_and(|value| !value.is_null()))
}

/// The modalities a Transformers-style configuration declares. Multimodal
/// configurations carry a sub-configuration or a placeholder token for each
/// input they encode; text-only configurations carry neither.
pub fn modalities_from_config(config: &Value, dir: Option<&Path>) -> Modalities {
    let text_config = config.get("text_config").unwrap_or(&Value::Null);
    let image = object_has(
        config,
        &[
            "vision_config",
            "vision_tower",
            "mm_vision_tower",
            "image_token_id",
            "image_token_index",
            "vision_feature_layer",
        ],
    ) || object_has(text_config, &["image_token_id", "image_token_index"]);
    // Omni models nest their encoders under `thinker_config`.
    let thinker = config.get("thinker_config").unwrap_or(&Value::Null);
    let audio = object_has(
        config,
        &[
            "audio_config",
            "audio_token_id",
            "audio_token_index",
            "audio_tower",
        ],
    ) || object_has(thinker, &["audio_config", "audio_token_index"]);
    let image = image || object_has(thinker, &["vision_config", "image_token_index"]);
    let video = object_has(config, &["video_token_id", "video_token_index"])
        || dir.is_some_and(|dir| dir.join("video_preprocessor_config.json").is_file());
    Modalities {
        text: true,
        image,
        audio,
        video,
    }
}

fn quantization_label(config: &Value) -> (ArtifactFormat, Option<String>) {
    if let Some(mlx) = config.get("quantization").filter(|value| value.is_object()) {
        let bits = mlx.get("bits").and_then(Value::as_u64);
        let group = mlx.get("group_size").and_then(Value::as_u64);
        let mode = mlx.get("mode").and_then(Value::as_str);
        let mut label = String::from("mlx");
        if let Some(bits) = bits {
            label.push_str(&format!(" {bits}-bit"));
        }
        if let Some(group) = group {
            label.push_str(&format!(" g{group}"));
        }
        if let Some(mode) = mode {
            label.push_str(&format!(" {mode}"));
        }
        return (ArtifactFormat::Mlx, Some(label));
    }
    let method = config
        .get("quantization_config")
        .and_then(|value| value.get("quant_method"))
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);
    (ArtifactFormat::HfSafetensors, method)
}

/// Safetensors files present, total bytes, file count and whether any partial
/// download file is present.
fn weight_files(dir: &Path) -> (Vec<String>, u64, usize, bool) {
    let mut present = Vec::new();
    let mut partial = false;
    let mut size = 0;
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if PARTIAL_SUFFIXES
                .iter()
                .any(|suffix| lower.ends_with(suffix))
            {
                partial = true;
                continue;
            }
            // Follow links: a Hugging Face cache snapshot is links into blobs.
            let Ok(metadata) = fs::metadata(entry.path()) else {
                continue;
            };
            if metadata.is_file() {
                count += 1;
                size += metadata.len();
                if lower.ends_with(".safetensors") && metadata.len() > 0 {
                    present.push(name);
                }
            }
        }
    }
    present.sort();
    (present, size, count, partial)
}

fn hf_cache_revision(dir: &Path) -> Option<(String, String)> {
    let revision = dir.file_name()?.to_str()?;
    if revision.len() != 40 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let snapshots = dir.parent()?;
    if snapshots.file_name()? != "snapshots" {
        return None;
    }
    let repo = snapshots.parent()?.file_name()?.to_str()?;
    let repository = repo.strip_prefix("models--")?.replacen("--", "/", 1);
    Some((revision.to_owned(), repository))
}

/// Inspect a snapshot directory. Never fails: unreadable parts become notes
/// and missing files, so an unknown artifact stays visible in the library.
pub fn inspect_snapshot(dir: &Path) -> ModelArtifact {
    let mut notes = Vec::new();
    let mut missing = Vec::new();
    let name = dir
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let config = match read_json(&dir.join("config.json"), MAX_CONFIG_BYTES) {
        Some(Ok(value)) if value.is_object() => value,
        Some(Ok(_)) => {
            missing.push("config.json (expected a JSON object)".into());
            Value::Null
        }
        Some(Err(error)) => {
            notes.push(error);
            missing.push("config.json (invalid JSON)".into());
            Value::Null
        }
        None => {
            missing.push("config.json".into());
            Value::Null
        }
    };
    let (mut format, quantization) = if config.is_null() {
        (ArtifactFormat::Unknown, None)
    } else {
        quantization_label(&config)
    };
    let architectures: Vec<String> = config
        .get("architectures")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let model_type = config
        .get("model_type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (present, size, file_count, partial) = weight_files(dir);
    let mut incomplete = partial;
    match read_json(&dir.join("model.safetensors.index.json"), MAX_INDEX_BYTES) {
        Some(Ok(index)) => {
            let required = index
                .get("weight_map")
                .and_then(Value::as_object)
                .map(|map| {
                    map.values()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default();
            let valid = index
                .get("weight_map")
                .and_then(Value::as_object)
                .is_some_and(|map| {
                    !map.is_empty()
                        && map.values().all(|value| {
                            value.as_str().is_some_and(|name| {
                                !name.is_empty()
                                    && name.ends_with(".safetensors")
                                    && !name.contains(['/', '\\', '\0', ':'])
                                    && name != "."
                                    && name != ".."
                            })
                        })
                });
            if !valid {
                missing.push("model.safetensors.index.json (invalid weight_map)".into());
            }
            for file in required {
                if !present.contains(&file) {
                    missing.push(file);
                }
            }
        }
        Some(Err(error)) => {
            notes.push(error);
            missing.push("model.safetensors.index.json (invalid JSON)".into());
        }
        None if present.is_empty() => missing.push("*.safetensors".into()),
        None => {}
    }
    let has_tokenizer = has_any(
        dir,
        &[
            "tokenizer.json",
            "tokenizer.model",
            "tiktoken.model",
            "spiece.model",
            "sentencepiece.bpe.model",
            "vocab.txt",
        ],
    ) || (dir.join("vocab.json").is_file() && dir.join("merges.txt").is_file());
    if !has_tokenizer && !config.is_null() {
        missing.push("tokenizer.json".into());
    }
    let has_processor = has_any(
        dir,
        &[
            "preprocessor_config.json",
            "processor_config.json",
            "video_preprocessor_config.json",
        ],
    );
    let has_chat_template = has_any(dir, &["chat_template.json", "chat_template.jinja"])
        || read_json(&dir.join("tokenizer_config.json"), MAX_CONFIG_BYTES)
            .and_then(Result::ok)
            .is_some_and(|value| value.get("chat_template").is_some());
    let mut modalities = if config.is_null() {
        Modalities::default()
    } else {
        modalities_from_config(&config, Some(dir))
    };
    if (modalities.image || modalities.video || modalities.audio) && !has_processor {
        notes.push(
            "the configuration declares non-text inputs but no processor configuration is present"
                .into(),
        );
    }
    let embedding = has_any(dir, &["sentence_bert_config.json", "modules.json"])
        || model_type
            .as_deref()
            .is_some_and(|kind| kind.contains("embedding"))
        || architectures
            .iter()
            .any(|architecture| architecture.to_lowercase().contains("embedding"));
    if embedding {
        modalities = Modalities::text_only();
    }
    let mut revision = None;
    let mut repository = None;
    let mut ownership = "external";
    if let Some((rev, repo)) = hf_cache_revision(dir) {
        revision = Some(rev);
        repository = Some(repo);
        ownership = "hf-cache";
    }
    match read_json(&dir.join(SNAPSHOT_MANIFEST), MAX_INDEX_BYTES) {
        Some(Ok(value)) => match serde_json::from_value::<SnapshotManifest>(value) {
            Ok(manifest) => {
                ownership = "app";
                if !manifest.complete {
                    incomplete = true;
                }
                for file in &manifest.files {
                    if file.path.is_empty()
                        || Path::new(&file.path).is_absolute()
                        || file.path.contains('\\')
                        || Path::new(&file.path)
                            .components()
                            .any(|part| !matches!(part, std::path::Component::Normal(_)))
                    {
                        incomplete = true;
                        notes.push(
                            "snapshot manifest contains an invalid relative file path".into(),
                        );
                        continue;
                    }
                    let path = dir.join(&file.path);
                    match fs::metadata(&path) {
                        Ok(metadata) if metadata.len() == file.size => {}
                        Ok(_) => {
                            incomplete = true;
                            notes.push(format!("{} does not have the downloaded size", file.path));
                        }
                        Err(_) => missing.push(file.path.clone()),
                    }
                }
                revision = Some(manifest.revision);
                repository = Some(manifest.repository);
            }
            Err(error) => {
                incomplete = true;
                notes.push(format!("snapshot manifest is invalid: {error}"));
            }
        },
        Some(Err(error)) => {
            incomplete = true;
            notes.push(error);
        }
        None => {}
    }
    missing.sort();
    missing.dedup();
    if format == ArtifactFormat::HfSafetensors && architectures.is_empty() && model_type.is_none() {
        format = ArtifactFormat::Unknown;
    }
    ModelArtifact {
        path: dir.to_string_lossy().into_owned(),
        name,
        format,
        role: if embedding {
            ArtifactRole::Embedding
        } else {
            ArtifactRole::Model
        },
        size_bytes: size,
        file_count,
        architectures,
        model_type,
        quantization,
        has_tokenizer,
        has_processor,
        has_chat_template,
        modalities,
        missing,
        incomplete,
        revision,
        repository,
        ownership,
        notes,
    }
}

/// Inspect a GGUF file. Projector files describe the modalities they encode.
pub fn inspect_gguf(path: &Path, size_bytes: u64, missing_shards: &[usize]) -> ModelArtifact {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut notes = Vec::new();
    let metadata = crate::gguf::read_metadata(path)
        .map_err(|error| notes.push(error))
        .ok();
    let architecture = metadata
        .as_ref()
        .and_then(|value| value.architecture.clone());
    let projector =
        architecture.as_deref() == Some("clip") || name.to_ascii_lowercase().contains("mmproj");
    let mut modalities = Modalities::text_only();
    if projector {
        modalities = match crate::gguf::read_projector_modalities(path) {
            Ok(found) => Modalities {
                text: false,
                image: found.vision.unwrap_or(found.audio.is_none()),
                audio: found.audio.unwrap_or(false),
                video: false,
            },
            Err(error) => {
                notes.push(error);
                Modalities::default()
            }
        };
    }
    ModelArtifact {
        path: path.to_string_lossy().into_owned(),
        name,
        format: if metadata.is_some() {
            ArtifactFormat::Gguf
        } else {
            ArtifactFormat::Unknown
        },
        role: if projector {
            ArtifactRole::Projector
        } else {
            ArtifactRole::Model
        },
        size_bytes,
        file_count: 1,
        architectures: architecture.into_iter().collect(),
        model_type: metadata.as_ref().and_then(|value| value.model_type.clone()),
        quantization: metadata.and_then(|value| value.quantization),
        has_tokenizer: true,
        has_processor: projector,
        has_chat_template: true,
        modalities,
        missing: missing_shards
            .iter()
            .map(|index| format!("shard {index}"))
            .collect(),
        incomplete: false,
        revision: None,
        repository: None,
        ownership: "external",
        notes,
    }
}

/// Every file a snapshot directory owns, for deletion. Links into a shared
/// cache are listed as links; their targets are never included.
pub fn snapshot_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn metal_gguf_requires_dense_tensor_evidence_and_matching_local_companions() {
        use crate::gguf::fixture::{file, Value as GgufValue};
        let dir = temp_dir("metal-gguf");
        let path = dir.join("weights.gguf");
        let tensors = vec![
            ("token_embd.weight".into(), vec![32, 32], 4096),
            ("output_norm.weight".into(), vec![32], 128),
            ("blk.0.attn_q.weight".into(), vec![32, 32], 4096),
        ];
        let bytes = file(
            &[("general.architecture".into(), GgufValue::Str("qwen3"))],
            &tensors,
        );
        fs::write(&path, &bytes).unwrap();
        let model = inspect_gguf(&path, bytes.len() as u64, &[]);
        assert!(metal_gguf_problem(&model).unwrap().contains("config.json"));
        write(&dir, "config.json", br#"{"model_type":"qwen3"}"#);
        assert!(metal_gguf_problem(&model).unwrap().contains("tokenizer"));
        write(&dir, "tokenizer.json", b"{}");
        assert!(metal_gguf_problem(&model).is_none());
        assert!(super::super::compat::assess_for_platform(
            &model,
            super::super::ProviderId::Vllm,
            None,
            "macos"
        )
        .loadable());
        for kind in [2u32, 3, 8, 30] {
            let mut changed = bytes.clone();
            let name = b"blk.0.attn_q.weight";
            let start = changed
                .windows(name.len())
                .position(|window| window == name)
                .unwrap();
            let type_start = start + name.len() + 4 + 2 * 8;
            changed[type_start..type_start + 4].copy_from_slice(&kind.to_le_bytes());
            fs::write(&path, changed).unwrap();
            assert!(metal_gguf_problem(&model).is_none());
        }
        let mut k_quant = bytes.clone();
        let name = b"blk.0.attn_q.weight";
        let start = k_quant
            .windows(name.len())
            .position(|window| window == name)
            .unwrap();
        let type_start = start + name.len() + 4 + 2 * 8;
        k_quant[type_start..type_start + 4].copy_from_slice(&12u32.to_le_bytes());
        fs::write(&path, k_quant).unwrap();
        assert!(metal_gguf_problem(&model)
            .unwrap()
            .contains("tensor type 12"));
        fs::write(&path, &bytes).unwrap();
        write(&dir, "config.json", br#"{"model_type":"llama"}"#);
        assert!(metal_gguf_problem(&model).unwrap().contains("match"));
        let mut shard = model.clone();
        shard.name = "weights-00001-of-00002.gguf".into();
        assert!(metal_gguf_problem(&shard).unwrap().contains("sharded"));
        let moe = file(
            &[("general.architecture".into(), GgufValue::Str("qwen3"))],
            &[("blk.0.ffn_up_exps.weight".into(), vec![32, 32], 4096)],
        );
        write(&dir, "config.json", br#"{"model_type":"qwen3"}"#);
        fs::write(&path, moe).unwrap();
        assert!(metal_gguf_problem(&model).unwrap().contains("MoE"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn metal_awq_accepts_only_the_pinned_repack_layout() {
        let dir = temp_dir("metal-awq");
        write(&dir, "config.json", br#"{"quantization_config":{"quant_method":"awq","w_bit":4,"q_group_size":128,"version":"GEMM"}}"#);
        assert!(metal_awq_problem(&dir).is_none());
        write(&dir, "config.json", br#"{"quantization_config":{"quant_method":"awq","bits":4,"group_size":128,"version":"gemv"}}"#);
        assert!(metal_awq_problem(&dir).is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aiolm-artifact-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, contents: &[u8]) {
        fs::write(dir.join(name), contents).unwrap();
    }

    #[test]
    fn tokenizer_alternatives_match_complete_snapshot_downloads() {
        let dir = temp_dir("tokenizers");
        write(
            &dir,
            "config.json",
            br#"{"model_type":"bert","architectures":["BertModel"]}"#,
        );
        write(&dir, "model.safetensors", b"synthetic");
        for name in [
            "tokenizer.json",
            "tokenizer.model",
            "tiktoken.model",
            "spiece.model",
            "sentencepiece.bpe.model",
            "vocab.txt",
        ] {
            write(&dir, name, b"synthetic");
            assert!(inspect_snapshot(&dir).ready_files(), "{name}");
            fs::remove_file(dir.join(name)).unwrap();
        }
        write(&dir, "vocab.json", b"{}");
        assert!(
            !inspect_snapshot(&dir).ready_files(),
            "BPE needs merges alongside vocabulary"
        );
        write(&dir, "merges.txt", b"synthetic");
        write(&dir, "chat_template.jinja", b"{{messages}}");
        let artifact = inspect_snapshot(&dir);
        assert!(artifact.ready_files() && artifact.has_chat_template);
        assert!(
            !artifact.has_processor,
            "processors stay optional for text snapshots"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_weight_indexes_and_empty_weights_cannot_be_ready() {
        let dir = temp_dir("invalid-index");
        write(&dir, "config.json", br#"{"model_type":"llama"}"#);
        write(&dir, "tokenizer.json", b"{}");
        write(&dir, "model.safetensors", b"synthetic");
        for index in [
            "{broken",
            "{}",
            r#"{"weight_map":{}}"#,
            r#"{"weight_map":{"weight":42}}"#,
            r#"{"weight_map":{"weight":"../model.safetensors"}}"#,
            r#"{"weight_map":{"weight":"C:\\model.safetensors"}}"#,
            r#"{"weight_map":{"weight":"model.bin"}}"#,
        ] {
            write(&dir, "model.safetensors.index.json", index.as_bytes());
            let artifact = inspect_snapshot(&dir);
            assert!(!artifact.ready_files(), "{index}");
            assert!(artifact
                .missing
                .iter()
                .any(|name| name.contains("model.safetensors.index.json")));
        }
        write(
            &dir,
            "model.safetensors.index.json",
            br#"{"weight_map":{"weight":"model.safetensors"}}"#,
        );
        assert!(inspect_snapshot(&dir).ready_files());
        write(&dir, "model.safetensors", b"");
        assert!(!inspect_snapshot(&dir).ready_files());
        fs::remove_file(dir.join("model.safetensors.index.json")).unwrap();
        assert!(!inspect_snapshot(&dir).ready_files());
        write(&dir, "model.safetensors", b"synthetic");
        for config in ["{broken", "[]", "null"] {
            write(&dir, "config.json", config.as_bytes());
            let artifact = inspect_snapshot(&dir);
            assert!(!artifact.ready_files());
            assert_eq!(artifact.format, ArtifactFormat::Unknown);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hf_snapshot_with_sharded_weights_reports_missing_shards_and_vision() {
        let dir = temp_dir("hf");
        write(
            &dir,
            "config.json",
            json!({"architectures":["Qwen2_5_VLForConditionalGeneration"],"model_type":"qwen2_5_vl","vision_config":{},"video_token_id":5})
                .to_string()
                .as_bytes(),
        );
        write(
            &dir,
            "model.safetensors.index.json",
            json!({"weight_map":{"a":"model-00001-of-00002.safetensors","b":"model-00002-of-00002.safetensors"}})
                .to_string()
                .as_bytes(),
        );
        write(&dir, "model-00001-of-00002.safetensors", b"x");
        write(&dir, "tokenizer.json", b"{}");
        write(&dir, "preprocessor_config.json", b"{}");
        assert!(is_snapshot_dir(&dir));
        let artifact = inspect_snapshot(&dir);
        assert_eq!(artifact.format, ArtifactFormat::HfSafetensors);
        assert_eq!(artifact.missing, vec!["model-00002-of-00002.safetensors"]);
        assert!(!artifact.ready_files());
        assert!(
            artifact.modalities.image && artifact.modalities.video && !artifact.modalities.audio
        );
        assert_eq!(
            artifact.architectures,
            vec!["Qwen2_5_VLForConditionalGeneration"]
        );
        write(&dir, "model-00002-of-00002.safetensors", b"x");
        assert!(inspect_snapshot(&dir).ready_files());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mlx_conversions_are_recognised_by_their_quantization_block() {
        let dir = temp_dir("mlx");
        write(
            &dir,
            "config.json",
            json!({"model_type":"llama","architectures":["LlamaForCausalLM"],"quantization":{"group_size":64,"bits":4}})
                .to_string()
                .as_bytes(),
        );
        write(&dir, "model.safetensors", b"x");
        write(&dir, "tokenizer.json", b"{}");
        let artifact = inspect_snapshot(&dir);
        assert_eq!(artifact.format, ArtifactFormat::Mlx);
        assert_eq!(artifact.quantization.as_deref(), Some("mlx 4-bit g64"));
        assert_eq!(artifact.modalities, Modalities::text_only());
        assert!(artifact.ready_files());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_downloads_and_missing_tokenizers_are_readiness_problems() {
        let dir = temp_dir("partial");
        write(
            &dir,
            "config.json",
            json!({"model_type":"llama","architectures":["LlamaForCausalLM"]})
                .to_string()
                .as_bytes(),
        );
        write(&dir, "model.safetensors.aiolm-part", b"x");
        let artifact = inspect_snapshot(&dir);
        assert!(artifact.incomplete);
        assert!(artifact.missing.contains(&"*.safetensors".to_string()));
        assert!(artifact.missing.contains(&"tokenizer.json".to_string()));
        let manifest = SnapshotManifest {
            format: 1,
            repository: "org/model".into(),
            revision: "a".repeat(40),
            files: vec![SnapshotFile {
                path: "model.safetensors".into(),
                size: 2,
                oid: None,
            }],
            complete: false,
        };
        write(
            &dir,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&manifest).unwrap(),
        );
        let artifact = inspect_snapshot(&dir);
        assert_eq!(artifact.ownership, "app");
        assert_eq!(artifact.repository.as_deref(), Some("org/model"));
        assert!(artifact.incomplete);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_configuration_keeps_the_artifact_visible_as_unknown() {
        let dir = temp_dir("broken");
        write(&dir, "config.json", b"{not json");
        write(&dir, "model.safetensors", b"x");
        let artifact = inspect_snapshot(&dir);
        assert_eq!(artifact.format, ArtifactFormat::Unknown);
        assert!(!artifact.notes.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hf_cache_snapshots_are_identified_by_their_revision_directory() {
        let root = temp_dir("cache");
        let dir = root
            .join("models--org--name")
            .join("snapshots")
            .join("0123456789abcdef0123456789abcdef01234567");
        fs::create_dir_all(&dir).unwrap();
        write(
            &dir,
            "config.json",
            json!({"model_type":"llama","architectures":["LlamaForCausalLM"]})
                .to_string()
                .as_bytes(),
        );
        write(&dir, "model.safetensors", b"x");
        write(&dir, "tokenizer.json", b"{}");
        let artifact = inspect_snapshot(&dir);
        assert_eq!(artifact.ownership, "hf-cache");
        assert_eq!(artifact.repository.as_deref(), Some("org/name"));
        assert_eq!(
            artifact.revision.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn embedding_snapshots_are_text_only_embedding_artifacts() {
        let dir = temp_dir("embed");
        write(
            &dir,
            "config.json",
            json!({"model_type":"bert","architectures":["BertModel"]})
                .to_string()
                .as_bytes(),
        );
        write(&dir, "model.safetensors", b"x");
        write(&dir, "tokenizer.json", b"{}");
        write(&dir, "modules.json", b"[]");
        let artifact = inspect_snapshot(&dir);
        assert_eq!(artifact.role, ArtifactRole::Embedding);
        fs::remove_dir_all(dir).unwrap();
    }
}
