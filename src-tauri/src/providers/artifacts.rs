//! Model artifact inspection.
//!
//! A model is identified by what its files say, not by its file extension: a
//! GGUF header, or a snapshot directory's `config.json`, weight index,
//! tokenizer and processor files. Missing or partially downloaded files are
//! reported as readiness problems of the artifact; whether an engine can load
//! it is decided separately in `compat`.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

/// Manifest written next to a snapshot AioLM downloaded. Its presence is what
/// makes a directory app-owned; its `complete` flag is what makes it whole.
pub const SNAPSHOT_MANIFEST: &str = ".aiolm-snapshot.json";
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
// Vocabulary/tokenizer payloads routinely exceed config sizes. Validate their
// syntax without materializing the JSON tree, but still bound disk work.
const MAX_LOADING_ASSET_BYTES: u64 = 128 * 1024 * 1024;

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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
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
    /// Original repository path when a selected model is normalized locally.
    /// Permitted only in format 2; format 1 uses `path` unchanged remotely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_path: Option<String>,
    pub size: u64,
    /// Hugging Face LFS sha256 or git blob id, as the hub reported it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oid: Option<String>,
}

impl SnapshotFile {
    pub fn repository_path(&self) -> &str {
        self.remote_path.as_deref().unwrap_or(&self.path)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SnapshotManifest {
    /// Format 1 is a whole-repository snapshot without selection or mappings.
    /// Format 2 is a selected snapshot with validated local-to-remote bindings.
    pub format: u32,
    pub repository: String,
    /// Commit the files were resolved at; never a moving branch name.
    pub revision: String,
    /// Original repository-relative selected weight entrypoint, if scoped.
    /// Required in format 2 and forbidden in format 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_file: Option<String>,
    pub files: Vec<SnapshotFile>,
    pub complete: bool,
}

impl SnapshotManifest {
    pub fn weight_members(&self) -> impl Iterator<Item = &SnapshotFile> {
        self.files
            .iter()
            .filter(|file| file.repository_path().ends_with(".safetensors"))
    }

    /// Canonical original entrypoint, including planned but absent members.
    pub fn selected_entrypoint(&self) -> Option<&str> {
        if self.format != 2 || self.selected_file.is_none() {
            return None;
        }
        self.weight_members()
            .map(SnapshotFile::repository_path)
            .min()
    }
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
    /// Canonical original selected entrypoint from a validated app-owned manifest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_file: Option<String>,
    /// Sorted original weight members of this selected bundle, even if incomplete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_weight_files: Option<Vec<String>>,
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

/// Validate loading assets without allocating their potentially large vocabularies.
/// Configs and indexes retain their separate, tighter inspection limits.
fn validate_loading_json(path: &Path, name: &str) -> Result<(), String> {
    use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};

    // IgnoredAny skips some checks (including surrogate validity and numeric
    // overflow). Visit every token normally, discarding values immediately
    // rather than retaining the vocabulary tree or copying parsed strings.
    struct JsonValue;
    struct JsonKey;

    impl<'de> DeserializeSeed<'de> for JsonValue {
        type Value = ();

        fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
            deserializer.deserialize_any(self)
        }
    }

    impl<'de> DeserializeSeed<'de> for JsonKey {
        type Value = ();

        fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
            deserializer.deserialize_str(JsonValue)
        }
    }

    impl<'de> Visitor<'de> for JsonValue {
        type Value = ();

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a valid JSON value")
        }

        fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
            Ok(())
        }

        fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<(), E> {
            Ok(())
        }

        fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<(), E> {
            Ok(())
        }

        fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<(), E> {
            Ok(())
        }

        fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<(), E> {
            if value.is_finite() {
                Ok(())
            } else {
                Err(E::custom("JSON number is not finite"))
            }
        }

        fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<(), E> {
            Ok(())
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
            while sequence.next_element_seed(JsonValue)?.is_some() {}
            Ok(())
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
            while map.next_key_seed(JsonKey)?.is_some() {
                map.next_value_seed(JsonValue)?;
            }
            Ok(())
        }
    }

    let limit = if name.ends_with(".safetensors.index.json") {
        MAX_INDEX_BYTES
    } else if name == "config.json"
        || (name.ends_with("_config.json") && name != "tokenizer_config.json")
    {
        MAX_CONFIG_BYTES
    } else {
        MAX_LOADING_ASSET_BYTES
    };
    let invalid = |error| format!("{} is not valid loading JSON: {error}", path.display());
    let file = fs::File::open(path).map_err(|error| invalid(error.to_string()))?;
    let size = file
        .metadata()
        .map_err(|error| invalid(error.to_string()))?
        .len();
    if size > limit {
        return Err(format!("{} is too large to inspect", path.display()));
    }
    // One extra byte detects a growing file even when the bounded prefix is
    // itself valid JSON. end() rejects trailing garbage and truncated input.
    let mut reader = BufReader::new(file.take(limit + 1));
    {
        let mut deserializer = serde_json::Deserializer::from_reader(&mut reader);
        if matches!(name, "config.json" | "tokenizer.json") || name.ends_with("_config.json") {
            serde::Deserializer::deserialize_map(&mut deserializer, JsonValue)
                .map_err(|error| invalid(error.to_string()))?;
        } else {
            JsonValue
                .deserialize(&mut deserializer)
                .map_err(|error| invalid(error.to_string()))?;
        }
        deserializer
            .end()
            .map_err(|error| invalid(error.to_string()))?;
    }
    if reader.get_ref().limit() == 0 {
        return Err(format!("{} is too large to inspect", path.display()));
    }
    Ok(())
}

/// A download manifest identifies a snapshot even before its configuration
/// arrives. Unmarked directories need a configuration and weights or an index.
pub fn is_snapshot_dir(dir: &Path) -> bool {
    if dir.join(SNAPSHOT_MANIFEST).is_file() {
        return true;
    }
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
    })
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
        let (facts, tensor_types) = crate::gguf::read_model_facts_and_tensor_types(path)?;
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
        let tensors = tensor_types?;
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

/// Inspect only Safetensors metadata, never tensor payloads or whole-file
/// digests. Download/update paths verify digests before publishing readiness.
fn inspect_safetensors_header(
    path: &Path,
    required_tensors: Option<&BTreeSet<String>>,
) -> Result<bool, String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let mut prefix = [0; 8];
    file.read_exact(&mut prefix)
        .map_err(|error| error.to_string())?;
    let length = safetensors_header_length(prefix, size)?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    inspect_safetensors_metadata(&bytes, size, required_tensors)
}

pub(crate) fn safetensors_header_length(prefix: [u8; 8], size: u64) -> Result<usize, String> {
    let length = u64::from_le_bytes(prefix);
    if length == 0 || length > MAX_INDEX_BYTES || length > size.saturating_sub(8) {
        return Err("invalid or excessive Safetensors header length".into());
    }
    Ok(length as usize)
}

/// Validate bounded metadata against the declared file size, without reading
/// payloads. Native Mistral/Llama tensor names require a real conversion:
/// mlx-lm 9e6acca's llama sanitizer does not remap them, and the HF Mistral
/// converter also permutes q/k tensors for its RoPE layout.
pub(crate) fn inspect_safetensors_metadata(
    bytes: &[u8],
    size: u64,
    required_tensors: Option<&BTreeSet<String>>,
) -> Result<bool, String> {
    safetensors_header_length((bytes.len() as u64).to_le_bytes(), size)?;
    let header: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let tensors = header
        .as_object()
        .ok_or("Safetensors header is not an object")?;
    let payload = size - 8 - bytes.len() as u64;
    let mut spans = Vec::with_capacity(tensors.len());
    for (name, tensor) in tensors {
        if name == "__metadata__" {
            if !tensor
                .as_object()
                .is_some_and(|values| values.values().all(Value::is_string))
            {
                return Err("invalid Safetensors metadata".into());
            }
            continue;
        }
        let bits: u64 = match tensor.get("dtype").and_then(Value::as_str) {
            Some(
                "BOOL" | "U8" | "I8" | "F8_E4M3" | "F8_E5M2" | "F8_E8M0" | "F8_E4M3FNUZ"
                | "F8_E5M2FNUZ",
            ) => 8,
            Some("U16" | "I16" | "F16" | "BF16") => 16,
            Some("U32" | "I32" | "F32") => 32,
            Some("U64" | "I64" | "F64") => 64,
            Some("F4") => 4,
            _ => return Err("invalid Safetensors tensor dtype".into()),
        };
        let elements = tensor
            .get("shape")
            .and_then(Value::as_array)
            .and_then(|shape| {
                shape
                    .iter()
                    .try_fold(1u64, |count, dim| count.checked_mul(dim.as_u64()?))
            })
            .ok_or("invalid Safetensors tensor shape")?;
        let expected = elements
            .checked_mul(bits)
            .filter(|bits| bits % 8 == 0)
            .map(|bits| bits / 8)
            .ok_or("invalid Safetensors tensor size")?;
        let offsets = tensor
            .get("data_offsets")
            .and_then(Value::as_array)
            .filter(|offsets| offsets.len() == 2)
            .ok_or("invalid Safetensors tensor offsets")?;
        let start = offsets[0]
            .as_u64()
            .ok_or("invalid Safetensors tensor offset")?;
        let end = offsets[1]
            .as_u64()
            .ok_or("invalid Safetensors tensor offset")?;
        if end > payload || end.checked_sub(start) != Some(expected) {
            return Err("Safetensors tensor data is truncated or malformed".into());
        }
        spans.push((start, end));
    }
    if spans.is_empty() {
        return Err("Safetensors header contains no tensors".into());
    }
    if required_tensors.is_some_and(|required| {
        required.len() != spans.len() || required.iter().any(|name| !tensors.contains_key(name))
    }) {
        return Err("Safetensors shard tensors do not match the weight index".into());
    }
    spans.sort_unstable();
    let mut end = 0;
    for (start, next) in spans {
        if start != end {
            return Err("Safetensors tensor offsets overlap or contain gaps".into());
        }
        end = next;
    }
    if end != payload {
        return Err("Safetensors tensor payload length is invalid".into());
    }
    Ok(tensors.keys().any(|name| {
        name == "tok_embeddings.weight"
            || name.strip_prefix("layers.").is_some_and(|rest| {
                rest.split_once('.').is_some_and(|(layer, parameter)| {
                    !layer.is_empty()
                        && layer.bytes().all(|byte| byte.is_ascii_digit())
                        && matches!(
                            parameter,
                            "attention.wq.weight"
                                | "attention.wk.weight"
                                | "attention.wv.weight"
                                | "attention.wo.weight"
                                | "attention_norm.weight"
                                | "ffn_norm.weight"
                                | "feed_forward.w1.weight"
                                | "feed_forward.w2.weight"
                                | "feed_forward.w3.weight"
                        )
                })
            })
    }))
}

fn missing_split_parts(present: &[String], missing: &mut Vec<String>) {
    let mut checked = BTreeSet::new();
    for name in present {
        let Some((prefix, total)) = name
            .strip_suffix(".safetensors")
            .and_then(|stem| stem.rsplit_once("-of-"))
        else {
            continue;
        };
        let Some((base, part)) = prefix.rsplit_once('-') else {
            continue;
        };
        if part.len() != 5
            || total.len() != 5
            || !part
                .bytes()
                .chain(total.bytes())
                .all(|byte| byte.is_ascii_digit())
        {
            continue;
        }
        let part = part.parse::<usize>().unwrap_or(0);
        let total = total.parse::<usize>().unwrap_or(0);
        if part == 0 || part > total || total > 50_000 {
            missing.push(format!("{name} (invalid split weight group)"));
            continue;
        }
        if checked.insert((base, total)) {
            for part in 1..=total {
                let required = format!("{base}-{part:05}-of-{total:05}.safetensors");
                if present.binary_search(&required).is_err() {
                    missing.push(required);
                }
            }
        }
    }
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

/// A card title is a display label only. It never grants repository provenance,
/// ownership, revision, loader support or readiness to a local snapshot.
fn declared_snapshot_name(dir: &Path) -> Option<String> {
    use std::io::Read;
    const LIMIT: u64 = 64 * 1024;
    let file = fs::File::open(dir.join("README.md")).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > LIMIT {
        return None;
    }
    let text = std::str::from_utf8(&bytes)
        .ok()?
        .trim_start_matches('\u{feff}');
    let mut frontmatter = false;
    let mut fence: Option<(u8, usize)> = None;
    for (index, line) in text.lines().enumerate() {
        // Indented code examples cannot declare the model card's heading.
        if line.starts_with("    ") || line.starts_with('\t') {
            continue;
        }
        let line = line.trim();
        if index == 0 && line == "---" {
            frontmatter = true;
            continue;
        }
        if frontmatter {
            if line == "---" || line == "..." {
                frontmatter = false;
            }
            continue;
        }
        let delimiter = line
            .as_bytes()
            .first()
            .copied()
            .filter(|byte| matches!(byte, b'`' | b'~'));
        let count = delimiter.map_or(0, |byte| {
            line.bytes().take_while(|next| *next == byte).count()
        });
        if let Some((byte, length)) = fence {
            if delimiter == Some(byte) && count >= length && line[count..].trim().is_empty() {
                fence = None;
            }
            continue;
        }
        if count >= 3 {
            fence = Some((delimiter?, count));
            continue;
        }
        let Some(title) = line.strip_prefix("# ") else {
            continue;
        };
        let (publisher, model) = title.trim().split_once('/')?;
        let component = |part: &str| {
            !part.is_empty()
                && part.len() <= 128
                && part.starts_with(|first: char| first.is_ascii_alphanumeric())
                && !part.contains("..")
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch))
        };
        return (component(publisher) && component(model)).then(|| model.to_owned());
    }
    None
}

/// Display-only identity for a selected group. Source paths, not normalized
/// local filenames, keep alternatives and variant folders distinguishable.
fn selected_display_name(manifest: &SnapshotManifest) -> Option<String> {
    let selected = manifest.selected_entrypoint()?;
    let group = manifest
        .files
        .iter()
        .find(|file| file.repository_path().ends_with(".safetensors.index.json"))
        .map(|file| file.repository_path().strip_suffix(".index.json").unwrap())
        .unwrap_or(selected);
    let identity = group
        .strip_suffix(".safetensors")
        .and_then(|stem| stem.rsplit_once("-of-"))
        .and_then(|(prefix, count)| {
            let (base, part) = prefix.rsplit_once('-')?;
            (part.len() == 5
                && count.len() == 5
                && part
                    .bytes()
                    .chain(count.bytes())
                    .all(|byte| byte.is_ascii_digit()))
            .then(|| format!("{base}.safetensors"))
        })
        .unwrap_or_else(|| group.to_owned());
    let base = manifest.repository.rsplit('/').next()?;
    Some(format!("{base} · {identity}"))
}

fn has_opaque_snapshot_name(dir: &Path) -> bool {
    dir.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.len() == 40 && name.bytes().all(|byte| byte.is_ascii_hexdigit()))
        && dir
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|part| part == "snapshots")
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SnapshotDisplayName {
    pub name: String,
    pub selected: bool,
}

/// Resolve display metadata only. This path deliberately never opens weights;
/// session/topbar labels must not trigger tensor validation or digest work.
pub fn snapshot_display_name(dir: &Path) -> Option<SnapshotDisplayName> {
    if let Ok(Some(manifest)) =
        crate::discover::read_snapshot_manifest_for_inspection(&dir.join(SNAPSHOT_MANIFEST))
    {
        if let Some(name) = selected_display_name(&manifest) {
            return Some(SnapshotDisplayName {
                name,
                selected: true,
            });
        }
        return manifest
            .repository
            .rsplit('/')
            .next()
            .map(|name| SnapshotDisplayName {
                name: name.to_owned(),
                selected: false,
            });
    }
    if let Some((_, repository)) = hf_cache_revision(dir) {
        return repository
            .rsplit('/')
            .next()
            .map(|name| SnapshotDisplayName {
                name: name.to_owned(),
                selected: false,
            });
    }
    has_opaque_snapshot_name(dir)
        .then(|| declared_snapshot_name(dir))
        .flatten()
        .map(|name| SnapshotDisplayName {
            name,
            selected: false,
        })
}

/// Inspect a snapshot directory. Never fails: unreadable parts become notes
/// and missing files, so an unknown artifact stays visible in the library.
pub fn inspect_snapshot(dir: &Path) -> ModelArtifact {
    let mut notes = Vec::new();
    let mut missing = Vec::new();
    let snapshot_manifest =
        crate::discover::read_snapshot_manifest_for_inspection(&dir.join(SNAPSHOT_MANIFEST));
    let selected = snapshot_manifest
        .as_ref()
        .ok()
        .and_then(|manifest| manifest.as_ref())
        .is_some_and(|manifest| manifest.selected_file.is_some());
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
    let mut indexed_weights = None;
    match read_json(&dir.join("model.safetensors.index.json"), MAX_INDEX_BYTES) {
        Some(Ok(index)) => {
            let required = index
                .get("weight_map")
                .and_then(Value::as_object)
                .map(|map| {
                    map.values()
                        .filter_map(Value::as_str)
                        .collect::<BTreeSet<&str>>()
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
            if selected {
                let mut weights: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
                if let Some(map) = index.get("weight_map").and_then(Value::as_object) {
                    for (tensor, file) in map {
                        if let Some(file) = file.as_str() {
                            weights
                                .entry(file.to_owned())
                                .or_default()
                                .insert(tensor.clone());
                        }
                    }
                }
                indexed_weights = Some(weights);
            }
            for file in required {
                if present
                    .binary_search_by(|name| name.as_str().cmp(file))
                    .is_err()
                {
                    missing.push(file.to_owned());
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
            .is_some_and(|value| {
                let Some(template) = value.get("chat_template") else {
                    return false;
                };
                match template {
                    Value::String(text) => !text.trim().is_empty(),
                    Value::Array(templates) => templates.iter().any(|item| {
                        item.get("template")
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.trim().is_empty())
                    }),
                    Value::Object(templates) => templates
                        .values()
                        .any(|item| item.as_str().is_some_and(|text| !text.trim().is_empty())),
                    _ => false,
                }
            });
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
    let mut selected_file = None;
    let mut selected_weight_files = None;
    let mut selected_name = None;
    let mut ownership = "external";
    if let Some((rev, repo)) = hf_cache_revision(dir) {
        revision = Some(rev);
        repository = Some(repo);
        ownership = "hf-cache";
    }
    match snapshot_manifest {
        Ok(Some(manifest)) => {
            ownership = "app";
            selected_name = selected_display_name(&manifest);
            incomplete |= !manifest.complete;
            let root = dir.canonicalize().ok();
            for file in &manifest.files {
                let path = dir.join(&file.path);
                let contained = root.as_ref().is_some_and(|root| {
                    path.canonicalize()
                        .is_ok_and(|resolved| resolved.starts_with(root))
                });
                match fs::symlink_metadata(&path) {
                    Ok(metadata)
                        if metadata.is_file() && contained && metadata.len() == file.size =>
                    {
                        if selected && file.path.ends_with(".safetensors") {
                            let tensors = indexed_weights
                                .as_ref()
                                .and_then(|weights| weights.get(&file.path));
                            match inspect_safetensors_header(&path, tensors) {
                                Ok(true) => {
                                    format = ArtifactFormat::Unknown;
                                    notes.push(format!("{} uses native Mistral/Llama tensors; convert the tensor names, q/k RoPE layout and configuration to Hugging Face/MLX before loading", file.repository_path()));
                                }
                                Ok(false) => {}
                                Err(error) => {
                                    incomplete = true;
                                    missing.push(format!(
                                        "{} (invalid Safetensors header)",
                                        file.path
                                    ));
                                    notes.push(format!("{}: {error}", file.path));
                                }
                            }
                        }
                        if selected && file.path.ends_with(".json") {
                            if let Err(error) = validate_loading_json(&path, &file.path) {
                                missing.push(format!("{} (invalid loading JSON)", file.path));
                                notes.push(error);
                            }
                        }
                    }
                    Ok(_) => {
                        incomplete = true;
                        missing.push(file.path.clone());
                        notes.push(format!(
                            "{} is not a contained regular file with the downloaded size",
                            file.path
                        ));
                    }
                    Err(_) => missing.push(file.path.clone()),
                }
            }
            if selected {
                missing_split_parts(&present, &mut missing);
                if let Some(required) = &indexed_weights {
                    let weights: BTreeSet<&str> = manifest
                        .files
                        .iter()
                        .filter(|file| file.path.ends_with(".safetensors"))
                        .map(|file| file.path.as_str())
                        .collect();
                    if required.len() != weights.len()
                        || !required.keys().all(|name| weights.contains(name.as_str()))
                    {
                        missing.push("model.safetensors.index.json (weight_map does not match selected weights)".into());
                    }
                }
            }
            selected_file = manifest.selected_entrypoint().map(str::to_owned);
            if selected {
                let mut members: Vec<String> = manifest
                    .weight_members()
                    .map(|file| file.repository_path().to_owned())
                    .collect();
                members.sort_unstable();
                selected_weight_files = Some(members);
            }
            revision = Some(manifest.revision);
            repository = Some(manifest.repository);
        }
        Err(error) => {
            incomplete = true;
            notes.push(error);
        }
        Ok(None) => {}
    }
    // Preserve user-chosen folder names and established repository naming. Only
    // an otherwise opaque revision label may use an explicitly declared title.
    let name = if let Some(selected_name) = selected_name {
        selected_name
    } else if repository.is_none() && has_opaque_snapshot_name(dir) {
        declared_snapshot_name(dir).unwrap_or(name)
    } else {
        name
    };
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
        selected_file,
        selected_weight_files,
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
    let identified = metadata.is_some();
    let architecture = metadata
        .as_ref()
        .and_then(|value| value.architecture.clone());
    let projector =
        architecture.as_deref() == Some("clip") || name.to_ascii_lowercase().contains("mmproj");
    let mut modalities = if identified {
        Modalities::text_only()
    } else {
        Modalities::default()
    };
    if identified && projector {
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
        format: if identified {
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
        has_tokenizer: identified,
        has_processor: identified && projector,
        has_chat_template: identified,
        modalities,
        missing: missing_shards
            .iter()
            .map(|index| format!("shard {index}"))
            .collect(),
        incomplete: false,
        revision: None,
        repository: None,
        selected_file: None,
        selected_weight_files: None,
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
    fn unreadable_gguf_does_not_claim_model_capabilities() {
        let dir = temp_dir("unreadable-gguf-facts");
        for name in ["unreadable.gguf", "mmproj-unreadable.gguf"] {
            let bytes = b"not a GGUF file";
            write(&dir, name, bytes);
            let artifact = inspect_gguf(&dir.join(name), bytes.len() as u64, &[]);
            assert_eq!(artifact.format, ArtifactFormat::Unknown);
            assert!(!artifact.notes.is_empty());
            assert_eq!(
                (
                    artifact.modalities,
                    artifact.has_tokenizer,
                    artifact.has_processor,
                    artifact.has_chat_template,
                ),
                (Modalities::default(), false, false, false),
                "{name}"
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn incomplete_gguf_metadata_cannot_publish_early_projector_facts() {
        let dir = temp_dir("incomplete-projector-facts");
        let path = dir.join("mmproj-truncated.gguf");
        let mut bytes = b"GGUF".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&3u64.to_le_bytes());
        for (key, value) in [
            ("clip.has_vision_encoder", 1u8),
            ("clip.has_audio_encoder", 0u8),
        ] {
            bytes.extend_from_slice(&(key.len() as u64).to_le_bytes());
            bytes.extend_from_slice(key.as_bytes());
            bytes.extend_from_slice(&7u32.to_le_bytes());
            bytes.push(value);
        }
        fs::write(&path, &bytes).unwrap();
        // The specialized reader finishes before the missing third field.
        assert!(crate::gguf::read_metadata(&path).is_err());
        assert_eq!(
            crate::gguf::read_projector_modalities(&path).unwrap(),
            crate::gguf::ProjectorModalities {
                vision: Some(true),
                audio: Some(false),
            }
        );
        let artifact = inspect_gguf(&path, bytes.len() as u64, &[]);
        assert_eq!(artifact.format, ArtifactFormat::Unknown);
        assert_eq!(artifact.modalities, Modalities::default());
        assert!(!artifact.has_tokenizer && !artifact.has_processor && !artifact.has_chat_template);
        assert!(!artifact.notes.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tokenizer_chat_templates_require_nonempty_template_contents() {
        let dir = temp_dir("chat-template");
        for (template, expected) in [
            (json!(null), false),
            (json!("  "), false),
            (json!([]), false),
            (json!({}), false),
            (json!("{{ messages }}"), true),
            (
                json!([{"name":"default", "template":"{{ messages }}"}]),
                true,
            ),
            (json!({"default":"{{ messages }}"}), true),
        ] {
            write(
                &dir,
                "tokenizer_config.json",
                json!({"chat_template":template}).to_string().as_bytes(),
            );
            assert_eq!(inspect_snapshot(&dir).has_chat_template, expected);
        }
        fs::remove_dir_all(dir).unwrap();
    }

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
        let mut truncated = bytes.clone();
        truncated.truncate(truncated.len() - 4_096);
        fs::write(&path, truncated).unwrap();
        write(&dir, "config.json", br#"{"model_type":"llama"}"#);
        assert!(metal_gguf_problem(&model).unwrap().contains("match"));
        fs::write(&path, &bytes).unwrap();
        write(&dir, "config.json", br#"{"model_type":"qwen3"}"#);
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

    fn selected_fixture(dir: &Path, selected: &str, weights: &[&str]) -> SnapshotManifest {
        write(dir, "config.json", br#"{"model_type":"llama"}"#);
        write(dir, "tokenizer.json", b"{}");
        for (index, weight) in weights.iter().enumerate() {
            let mut tensors = serde_json::Map::new();
            tensors.insert(
                format!("weight{index}"),
                json!({"dtype":"F32","shape":[1],"data_offsets":[0,4]}),
            );
            let mut header = serde_json::to_vec(&tensors).unwrap();
            header.resize(header.len().div_ceil(8) * 8, b' ');
            let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
            bytes.extend_from_slice(&header);
            bytes.extend_from_slice(&1f32.to_le_bytes());
            write(dir, weight, &bytes);
        }
        let files = ["config.json", "tokenizer.json"]
            .into_iter()
            .chain(weights.iter().copied())
            .map(|path| SnapshotFile {
                path: path.into(),
                remote_path: Some(if path == "model.safetensors" {
                    selected.into()
                } else {
                    format!("nested/{path}")
                }),
                size: fs::metadata(dir.join(path)).unwrap().len(),
                oid: None,
            })
            .collect();
        let manifest = SnapshotManifest {
            format: 2,
            repository: "org/model".into(),
            revision: "a".repeat(40),
            selected_file: Some(selected.into()),
            files,
            complete: true,
        };
        write(
            dir,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&manifest).unwrap(),
        );
        manifest
    }

    #[test]
    fn whole_snapshot_display_metadata_preserves_repository_and_card_precedence() {
        let root = temp_dir("whole-display-metadata");
        let external = root.join("snapshots").join("a".repeat(40));
        fs::create_dir_all(&external).unwrap();
        write(&external, "README.md", b"# example/declared-model\n");
        assert_eq!(
            snapshot_display_name(&external),
            Some(SnapshotDisplayName {
                name: "declared-model".into(),
                selected: false,
            })
        );
        let mut manifest = selected_fixture(
            &external,
            "nested/weights.safetensors",
            &["model.safetensors"],
        );
        manifest.format = 1;
        manifest.selected_file = None;
        for file in &mut manifest.files {
            file.remote_path = None;
        }
        write(
            &external,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&manifest).unwrap(),
        );
        fs::remove_file(external.join("model.safetensors")).unwrap();
        assert_eq!(
            snapshot_display_name(&external),
            Some(SnapshotDisplayName {
                name: "model".into(),
                selected: false,
            })
        );
        let cache = root
            .join("models--publisher--cache-model")
            .join("snapshots")
            .join("b".repeat(40));
        fs::create_dir_all(&cache).unwrap();
        write(&cache, "README.md", b"# example/different-card-title\n");
        assert_eq!(
            snapshot_display_name(&cache),
            Some(SnapshotDisplayName {
                name: "cache-model".into(),
                selected: false,
            })
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_display_names_distinguish_variants_without_opening_weights() {
        let dir = temp_dir("selected-display-names");
        for (selected, expected) in [
            ("nested/fp16.safetensors", "model · nested/fp16.safetensors"),
            ("nested/q4.safetensors", "model · nested/q4.safetensors"),
            (
                "nested/q4/model.safetensors",
                "model · nested/q4/model.safetensors",
            ),
        ] {
            selected_fixture(&dir, selected, &["model.safetensors"]);
            // Missing payloads cannot prevent display metadata resolution.
            fs::remove_file(dir.join("model.safetensors")).unwrap();
            let display = snapshot_display_name(&dir).unwrap();
            assert!(display.selected);
            assert_eq!(display.name, expected);
            assert_eq!(inspect_snapshot(&dir).name, expected);
        }
        let parts = [
            "model-00001-of-00002.safetensors",
            "model-00002-of-00002.safetensors",
        ];
        let mut manifest =
            selected_fixture(&dir, "nested/model-00001-of-00002.safetensors", &parts);
        for complete in [true, false] {
            manifest.complete = complete;
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&manifest).unwrap(),
            );
            let display = snapshot_display_name(&dir).unwrap();
            assert!(display.selected);
            assert_eq!(display.name, "model · nested/model.safetensors");
            assert_eq!(
                inspect_snapshot(&dir).name,
                "model · nested/model.safetensors"
            );
        }
        manifest.format = 1;
        manifest.selected_file = None;
        for file in &mut manifest.files {
            file.remote_path = None;
        }
        write(
            &dir,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&manifest).unwrap(),
        );
        assert_eq!(
            snapshot_display_name(&dir),
            Some(SnapshotDisplayName {
                name: "model".into(),
                selected: false
            })
        );
        assert_eq!(
            inspect_snapshot(&dir).name,
            dir.file_name().unwrap().to_string_lossy()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_native_tensors_do_not_become_hf_weights_when_renamed() {
        let dir = temp_dir("native-tensor-layout");
        for (tensor, native) in [
            ("tok_embeddings.weight", true),
            ("layers.0.attention.wq.weight", true),
            ("model.embed_tokens.weight", false),
            ("model.layers.0.self_attn.q_proj.weight", false),
            ("model.layers.0.self_attn.q_proj.scales", false),
        ] {
            let mut manifest =
                selected_fixture(&dir, "nested/arbitrary.safetensors", &["model.safetensors"]);
            let header = serde_json::to_vec(&json!({
                (tensor): {"dtype":"F32","shape":[1],"data_offsets":[0,4]}
            }))
            .unwrap();
            let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
            bytes.extend_from_slice(&header);
            bytes.extend_from_slice(&1f32.to_le_bytes());
            write(&dir, "model.safetensors", &bytes);
            manifest.files[2].size = bytes.len() as u64;
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&manifest).unwrap(),
            );
            let before = fs::read(dir.join(SNAPSHOT_MANIFEST)).unwrap();
            let artifact = inspect_snapshot(&dir);
            assert!(artifact.ready_files(), "{:?}", artifact.notes);
            assert_eq!(
                artifact.format == ArtifactFormat::Unknown,
                native,
                "{tensor}"
            );
            for provider in [
                super::super::ProviderId::MlxVlm,
                super::super::ProviderId::Vllm,
            ] {
                if native {
                    assert!(!super::super::compat::assess(&artifact, provider, None).loadable());
                }
            }
            assert_eq!(fs::read(dir.join("model.safetensors")).unwrap(), bytes);
            assert_eq!(fs::read(dir.join(SNAPSHOT_MANIFEST)).unwrap(), before);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_large_tokenizer_and_vocabulary_assets_are_ready_only_when_valid() {
        let dir = temp_dir("selected-large-loading-json");
        let mut manifest =
            selected_fixture(&dir, "nested/variant.safetensors", &["model.safetensors"]);
        let mut bytes = br#"{"model":{"vocab":{"#.to_vec();
        bytes.push(b'"');
        bytes.resize(5 * 1024 * 1024, b'a');
        bytes.extend_from_slice(br#"":0}}}"#);
        for name in ["tokenizer.json", "vocab.json", "tokenizer_config.json"] {
            write(&dir, name, &bytes);
            if let Some(file) = manifest.files.iter_mut().find(|file| file.path == name) {
                file.size = bytes.len() as u64;
            } else {
                manifest.files.push(SnapshotFile {
                    path: name.into(),
                    remote_path: Some(format!("nested/{name}")),
                    size: bytes.len() as u64,
                    oid: None,
                });
            }
        }
        write(
            &dir,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&manifest).unwrap(),
        );
        let artifact = inspect_snapshot(&dir);
        assert!(
            artifact.ready_files(),
            "{:?}: {:?}",
            artifact.missing,
            artifact.notes
        );
        let last = bytes.len() - 1;
        bytes[last] = b'x';
        write(&dir, "tokenizer.json", &bytes);
        let malformed = inspect_snapshot(&dir);
        assert!(!malformed.ready_files());
        assert!(malformed
            .missing
            .contains(&"tokenizer.json (invalid loading JSON)".into()));
        // A matching download size does not make malformed or trailing JSON valid.
        for contents in [b"{broken".as_slice(), b"{} {}".as_slice(), b"[]".as_slice()] {
            write(&dir, "tokenizer.json", contents);
            manifest
                .files
                .iter_mut()
                .find(|file| file.path == "tokenizer.json")
                .unwrap()
                .size = contents.len() as u64;
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&manifest).unwrap(),
            );
            let artifact = inspect_snapshot(&dir);
            assert!(!artifact.ready_files());
            assert!(artifact
                .missing
                .contains(&"tokenizer.json (invalid loading JSON)".into()));
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_loading_json_validates_nested_unicode_and_finite_numbers() {
        let dir = temp_dir("selected-strict-loading-json");
        for name in ["tokenizer.json", "vocab.json"] {
            let mut manifest =
                selected_fixture(&dir, "nested/variant.safetensors", &["model.safetensors"]);
            if !manifest.files.iter().any(|file| file.path == name) {
                manifest.files.push(SnapshotFile {
                    path: name.into(),
                    remote_path: Some(format!("nested/{name}")),
                    size: 0,
                    oid: None,
                });
            }
            for (json, ready) in [
                (r#"{"model":{"vocab":{"\uD800":0}}}"#, false),
                (r#"{"nested":["\uDC00"]}"#, false),
                (r#"{"nested":{"value":"\uD800"}}"#, false),
                (r#"{"nested":[1e999]}"#, false),
                (r#"{"nested":{"value":-1e999}}"#, false),
                (
                    r#"{"nested":[null,true,false,-9223372036854775808,18446744073709551615,1.5,"\uD83D\uDE00"]}"#,
                    true,
                ),
            ] {
                write(&dir, name, json.as_bytes());
                manifest
                    .files
                    .iter_mut()
                    .find(|file| file.path == name)
                    .unwrap()
                    .size = json.len() as u64;
                write(
                    &dir,
                    SNAPSHOT_MANIFEST,
                    &serde_json::to_vec(&manifest).unwrap(),
                );
                let artifact = inspect_snapshot(&dir);
                assert_eq!(
                    artifact.ready_files(),
                    ready,
                    "{name}: {json}: {:?}",
                    artifact.notes
                );
                if !ready {
                    assert!(artifact
                        .missing
                        .contains(&format!("{name} (invalid loading JSON)")));
                }
            }
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_loading_json_enforces_asset_config_and_index_size_boundaries() {
        use std::io::Write;

        let dir = temp_dir("selected-loading-json-limits");
        for (name, json, limit) in [
            ("tokenizer.json", "{}", MAX_LOADING_ASSET_BYTES),
            ("config.json", r#"{"model_type":"llama"}"#, MAX_CONFIG_BYTES),
            (
                "model.safetensors.index.json",
                r#"{"weight_map":{"weight0":"model.safetensors"}}"#,
                MAX_INDEX_BYTES,
            ),
        ] {
            let mut manifest =
                selected_fixture(&dir, "nested/model.safetensors", &["model.safetensors"]);
            let path = dir.join(name);
            let mut file = fs::File::create(&path).unwrap();
            file.write_all(json.as_bytes()).unwrap();
            let padding = [b' '; 64 * 1024];
            let mut remaining = limit - json.len() as u64;
            while remaining > 0 {
                let count = remaining.min(padding.len() as u64) as usize;
                file.write_all(&padding[..count]).unwrap();
                remaining -= count as u64;
            }
            drop(file);
            if let Some(file) = manifest.files.iter_mut().find(|file| file.path == name) {
                file.size = limit;
            } else {
                manifest.files.push(SnapshotFile {
                    path: name.into(),
                    remote_path: Some(format!("nested/{name}")),
                    size: limit,
                    oid: None,
                });
            }
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&manifest).unwrap(),
            );
            let at_limit = inspect_snapshot(&dir);
            assert!(
                at_limit.ready_files(),
                "{name}: {:?}: {:?}",
                at_limit.missing,
                at_limit.notes
            );
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(limit + 1)
                .unwrap();
            manifest
                .files
                .iter_mut()
                .find(|file| file.path == name)
                .unwrap()
                .size = limit + 1;
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&manifest).unwrap(),
            );
            let over_limit = inspect_snapshot(&dir);
            assert!(!over_limit.ready_files(), "{name}");
            assert!(
                over_limit
                    .notes
                    .iter()
                    .any(|note| note.contains("too large")),
                "{name}"
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_indexed_metadata_is_canonical_scoped_and_preserved_when_partial() {
        let dir = temp_dir("selected-indexed-metadata");
        let first = "model-a.safetensors";
        let second = "model-z.safetensors";
        // Old valid manifests may retain the originally requested later member.
        let mut manifest = selected_fixture(&dir, "nested/model-z.safetensors", &[second, first]);
        let index =
            br#"{"weight_map":{"weight0":"model-z.safetensors","weight1":"model-a.safetensors"}}"#;
        write(&dir, "model.safetensors.index.json", index);
        manifest.files.push(SnapshotFile {
            path: "model.safetensors.index.json".into(),
            remote_path: Some("nested/model.safetensors.index.json".into()),
            size: index.len() as u64,
            oid: None,
        });
        write(&dir, "unrelated.safetensors", b"unrelated external model");
        for complete in [true, false] {
            manifest.complete = complete;
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&manifest).unwrap(),
            );
            if !complete {
                fs::remove_file(dir.join(first)).unwrap();
            }
            let artifact = inspect_snapshot(&dir);
            assert_eq!(artifact.ready_files(), complete, "{:?}", artifact.notes);
            assert_eq!(artifact.name, "model · nested/model.safetensors");
            let display = snapshot_display_name(&dir).unwrap();
            assert!(display.selected);
            assert_eq!(display.name, artifact.name);
            assert_eq!(
                artifact.selected_file.as_deref(),
                Some("nested/model-a.safetensors")
            );
            assert_eq!(
                artifact.selected_weight_files,
                Some(vec![
                    "nested/model-a.safetensors".into(),
                    "nested/model-z.safetensors".into(),
                ])
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_identity_bindings_use_original_local_paths_without_remote_mappings() {
        let dir = temp_dir("selected-identity-bindings");
        let mut manifest =
            selected_fixture(&dir, "nested/variant.safetensors", &["model.safetensors"]);
        manifest.selected_file = Some("model.safetensors".into());
        for file in &mut manifest.files {
            file.remote_path = None;
        }
        write(
            &dir,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&manifest).unwrap(),
        );
        let artifact = inspect_snapshot(&dir);
        assert!(artifact.ready_files(), "{:?}", artifact.notes);
        assert_eq!(artifact.selected_file.as_deref(), Some("model.safetensors"));
        assert_eq!(
            artifact.selected_weight_files,
            Some(vec!["model.safetensors".into()])
        );
        fs::remove_file(dir.join(SNAPSHOT_MANIFEST)).unwrap();
        let external = inspect_snapshot(&dir);
        assert!(external.ready_files());
        assert_eq!(external.selected_file, None);
        assert_eq!(external.selected_weight_files, None);
        assert!(serde_json::to_value(&external)
            .unwrap()
            .get("selected_weight_files")
            .is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn snapshot_manifest_versions_preserve_only_supported_provenance_and_readiness() {
        let dir = temp_dir("selected-provenance");
        let selected = selected_fixture(&dir, "nested/variant.safetensors", &["model.safetensors"]);
        let artifact = inspect_snapshot(&dir);
        assert!(artifact.ready_files(), "{:?}", artifact.notes);
        assert_eq!(artifact.ownership, "app");
        assert_eq!(artifact.repository.as_deref(), Some("org/model"));
        assert_eq!(artifact.revision.as_deref(), Some("a".repeat(40).as_str()));
        assert_eq!(
            artifact.selected_file.as_deref(),
            Some("nested/variant.safetensors")
        );
        assert_eq!(
            artifact.selected_weight_files,
            Some(vec!["nested/variant.safetensors".into()])
        );
        // The old on-disk format has neither selection nor remote-path fields.
        let legacy = json!({
            "format": 1, "repository": "org/model", "revision": "a".repeat(40),
            "complete": true,
            "files": [{"path":"model.safetensors",
                "size":fs::metadata(dir.join("model.safetensors")).unwrap().len()}]
        });
        write(
            &dir,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&legacy).unwrap(),
        );
        let whole = inspect_snapshot(&dir);
        assert!(whole.ready_files());
        assert_eq!(whole.ownership, "app");
        assert_eq!(whole.selected_file, None);
        assert_eq!(whole.selected_weight_files, None);
        assert!(serde_json::to_value(&whole)
            .unwrap()
            .get("selected_weight_files")
            .is_none());
        assert_eq!(whole.repository.as_deref(), Some("org/model"));
        assert_eq!(whole.revision.as_deref(), Some("a".repeat(40).as_str()));

        let selected = serde_json::to_value(selected).unwrap();
        let mut legacy_selection = legacy.clone();
        legacy_selection["selected_file"] = json!("model.safetensors");
        let mut legacy_mapping = legacy.clone();
        legacy_mapping["files"][0]["remote_path"] = json!("nested/variant.safetensors");
        let mut legacy_selected_mapping = selected.clone();
        legacy_selected_mapping["format"] = json!(1);
        let mut unselected = legacy.clone();
        unselected["format"] = json!(2);
        let mut unselected_mapping = selected.clone();
        unselected_mapping
            .as_object_mut()
            .unwrap()
            .remove("selected_file");
        let mut invalid_manifests = vec![
            legacy_selection,
            legacy_mapping,
            legacy_selected_mapping,
            unselected,
            unselected_mapping,
        ];
        for format in [0, 3, u32::MAX] {
            for supported in [&legacy, &selected] {
                let mut unsupported = supported.clone();
                unsupported["format"] = json!(format);
                invalid_manifests.push(unsupported);
            }
        }
        for invalid in invalid_manifests {
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&invalid).unwrap(),
            );
            let artifact = inspect_snapshot(&dir);
            assert!(!artifact.ready_files(), "{invalid}");
            assert!(artifact.incomplete, "{invalid}");
            assert_eq!(artifact.ownership, "external", "{invalid}");
            assert_eq!(artifact.repository, None, "{invalid}");
            assert_eq!(artifact.revision, None, "{invalid}");
            assert_eq!(artifact.selected_file, None, "{invalid}");
            assert_eq!(artifact.selected_weight_files, None, "{invalid}");
            assert!(!artifact.notes.is_empty(), "{invalid}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_split_snapshot_requires_every_valid_shard_and_index_dependency() {
        let dir = temp_dir("selected-shards");
        let first = "model-00001-of-00002.safetensors";
        let second = "model-00002-of-00002.safetensors";
        let manifest = selected_fixture(
            &dir,
            "nested/model-00001-of-00002.safetensors",
            &[first, second],
        );
        assert!(inspect_snapshot(&dir).ready_files());
        let bytes = fs::read(dir.join(second)).unwrap();
        fs::remove_file(dir.join(second)).unwrap();
        let missing = inspect_snapshot(&dir);
        assert!(!missing.ready_files());
        assert!(missing.missing.contains(&second.to_string()));
        let mut malformed = bytes.clone();
        malformed[..8].copy_from_slice(&u64::MAX.to_le_bytes());
        write(&dir, second, &malformed);
        let malformed = inspect_snapshot(&dir);
        assert!(!malformed.ready_files());
        assert!(malformed.missing.iter().any(|name| name.contains(second)));
        write(&dir, second, &bytes);
        write(
            &dir,
            "model.safetensors.index.json",
            br#"{"weight_map":{"a":"model-00001-of-00002.safetensors","b":"missing.safetensors"}}"#,
        );
        assert!(!inspect_snapshot(&dir).ready_files());
        write(&dir, "model.safetensors.index.json", b"{broken");
        assert!(!inspect_snapshot(&dir).ready_files());
        fs::remove_file(dir.join("model.safetensors.index.json")).unwrap();
        // Even a forged complete manifest cannot hide an absent split part.
        let mut shortened = manifest;
        shortened.files.retain(|file| file.path != second);
        write(
            &dir,
            SNAPSHOT_MANIFEST,
            &serde_json::to_vec(&shortened).unwrap(),
        );
        fs::remove_file(dir.join(second)).unwrap();
        assert!(!inspect_snapshot(&dir).ready_files());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_loading_json_must_be_valid_even_when_downloaded_sizes_match() {
        let dir = temp_dir("selected-loading-json");
        selected_fixture(&dir, "nested/variant.safetensors", &["model.safetensors"]);
        for name in ["config.json", "tokenizer.json"] {
            let original = fs::read(dir.join(name)).unwrap();
            write(&dir, name, &vec![b' '; original.len()]);
            let artifact = inspect_snapshot(&dir);
            assert!(!artifact.ready_files(), "{name}");
            assert!(artifact.missing.iter().any(|file| file.contains(name)));
            write(&dir, name, &original);
        }
        write(&dir, "tokenizer.json", b"[]");
        assert!(!inspect_snapshot(&dir).ready_files());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_index_must_reference_exactly_the_owned_weight_set() {
        let dir = temp_dir("selected-index-set");
        let first = "model-00001-of-00002.safetensors";
        let second = "model-00002-of-00002.safetensors";
        let manifest = selected_fixture(
            &dir,
            "nested/model-00001-of-00002.safetensors",
            &[first, second],
        );
        for (index, ready) in [
            (
                json!({"weight_map":{"weight0":first,"weight1":second}}),
                true,
            ),
            (json!({"weight_map":{"weight0":first}}), false),
            (
                json!({"weight_map":{"weight0":second,"weight1":first}}),
                false,
            ),
        ] {
            let bytes = serde_json::to_vec(&index).unwrap();
            write(&dir, "model.safetensors.index.json", &bytes);
            let mut indexed = manifest.clone();
            indexed.files.push(SnapshotFile {
                path: "model.safetensors.index.json".into(),
                remote_path: Some("nested/model.safetensors.index.json".into()),
                size: bytes.len() as u64,
                oid: None,
            });
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&indexed).unwrap(),
            );
            let artifact = inspect_snapshot(&dir);
            assert_eq!(artifact.ready_files(), ready, "{:?}", artifact.notes);
            if !ready {
                assert!(artifact.missing.iter().any(|name| {
                    name.contains("weight_map") || name.contains("invalid Safetensors header")
                }));
            }
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_selected_mapping_metadata_never_grants_provenance_or_readiness() {
        let dir = temp_dir("selected-invalid-mapping");
        let manifest = selected_fixture(&dir, "nested/variant.safetensors", &["model.safetensors"]);
        let mut variants = Vec::new();
        let mut unsafe_remote = manifest.clone();
        unsafe_remote.files[0].remote_path = Some("../config.json".into());
        variants.push(unsafe_remote);
        let mut unbound = manifest.clone();
        unbound.selected_file = Some("nested/other.safetensors".into());
        variants.push(unbound);
        let mut duplicate_remote = manifest.clone();
        duplicate_remote.files[1].remote_path = duplicate_remote.files[0].remote_path.clone();
        variants.push(duplicate_remote);
        let mut unscoped = manifest;
        unscoped.selected_file = None;
        variants.push(unscoped);
        for invalid in variants {
            write(
                &dir,
                SNAPSHOT_MANIFEST,
                &serde_json::to_vec(&invalid).unwrap(),
            );
            let artifact = inspect_snapshot(&dir);
            assert!(!artifact.ready_files());
            assert_eq!(artifact.selected_file, None);
            assert_eq!(artifact.repository, None);
            assert_eq!(artifact.revision, None);
            assert_ne!(artifact.ownership, "app");
            assert!(!artifact.notes.is_empty());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn external_revision_uses_its_declared_card_name_without_repository_provenance() {
        let root = temp_dir("declared-card-name");
        let dir = root.join("snapshots").join("a".repeat(40));
        fs::create_dir_all(&dir).unwrap();
        write(&dir, "config.json", br#"{"model_type":"synthetic"}"#);
        write(&dir, "model.safetensors", b"synthetic");
        write(&dir, "tokenizer.json", b"{}");
        let before = inspect_snapshot(&dir);
        write(&dir, "README.md", b"---\nbase_model: original/base-model\n---\n\n# example/converted-model-4bit\n\nModel card.\n");
        let after = inspect_snapshot(&dir);
        assert_eq!(after.name, "converted-model-4bit");
        assert_eq!(after.path, before.path);
        assert_eq!(after.repository, None);
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.ownership, "external");
        assert_eq!(after.format, before.format);
        assert_eq!(after.modalities, before.modalities);
        assert_eq!(after.missing, before.missing);
        assert_eq!(after.incomplete, before.incomplete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn card_examples_and_invalid_titles_do_not_rename_local_snapshots() {
        let root = temp_dir("card-name-fallback");
        let dir = root.join("snapshots").join("b".repeat(40));
        fs::create_dir_all(&dir).unwrap();
        for text in [
            "---\nbase_model: original/base-model\n---\nNo declared title.",
            "```markdown\n# example/from-code\n```\nNo declared title.",
            "# Model card\n# example/a-later-section",
            "    # example/from-indented-code",
            "````markdown\n```\n# example/from-nested-fence\n```\n````",
            "---\n# example/unclosed-frontmatter",
            "# <script>example/model</script>",
            "# example/../other",
            "# example/model extra text",
        ] {
            write(&dir, "README.md", text.as_bytes());
            assert_eq!(inspect_snapshot(&dir).name, "b".repeat(40));
        }
        write(&dir, "README.md", &vec![b'x'; 64 * 1024 + 1]);
        assert_eq!(inspect_snapshot(&dir).name, "b".repeat(40));
        write(&dir, "README.md", b"# example/a-valid-title\n");
        let ordinary = root.join("user-selected-name");
        fs::rename(&dir, &ordinary).unwrap();
        assert_eq!(inspect_snapshot(&ordinary).name, "user-selected-name");
        fs::remove_dir_all(root).unwrap();
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
    fn indexed_snapshot_membership_preserves_exact_names_and_fresh_readiness() {
        let dir = temp_dir("indexed-membership");
        let config = br#"{"model_type":"llama"}"#;
        write(&dir, "config.json", config);
        write(&dir, "tokenizer.json", b"{}");
        for name in ["z.safetensors", "B.safetensors", "a.safetensors"] {
            write(&dir, name, b"x");
        }
        write(&dir, "zero.safetensors", b"");
        let cases: [(Value, &[&str], bool); 3] = [
            (
                json!({"weight_map":{"z":"z.safetensors","b":"B.safetensors",
                    "a":"a.safetensors","duplicate":"B.safetensors"}}),
                &[],
                false,
            ),
            (
                json!({"weight_map":{"present":"B.safetensors","case":"b.safetensors",
                    "zero":"zero.safetensors","duplicate":"b.safetensors",
                    "composed":"\u{e9}.safetensors","decomposed":"e\u{301}.safetensors"}}),
                &[
                    "b.safetensors",
                    "e\u{301}.safetensors",
                    "zero.safetensors",
                    "\u{e9}.safetensors",
                ],
                true,
            ),
            (
                json!({"weight_map":{"present":"B.safetensors","invalid":42,
                    "path":"../escape.safetensors","missing":"b.safetensors",
                    "duplicate":"b.safetensors"}}),
                &[
                    "../escape.safetensors",
                    "b.safetensors",
                    "model.safetensors.index.json (invalid weight_map)",
                ],
                false,
            ),
        ];
        for (index, expected_missing, partial) in cases {
            let bytes = serde_json::to_vec(&index).unwrap();
            write(&dir, "model.safetensors.index.json", &bytes);
            if partial {
                write(&dir, "pending.safetensors.aiolm-part", b"x");
            }
            let artifact = inspect_snapshot(&dir);
            assert_eq!(artifact.missing, expected_missing.to_vec());
            assert_eq!(artifact.incomplete, partial);
            assert_eq!(
                artifact.ready_files(),
                expected_missing.is_empty() && !partial
            );
            assert_eq!(artifact.format, ArtifactFormat::HfSafetensors);
            assert_eq!(artifact.model_type.as_deref(), Some("llama"));
            assert!(artifact.has_tokenizer && artifact.notes.is_empty());
            assert_eq!(artifact.ownership, "external");
            assert_eq!(artifact.selected_file, None);
            assert_eq!(artifact.selected_weight_files, None);
            assert_eq!(artifact.file_count, 7);
            assert_eq!(
                artifact.size_bytes,
                (config.len() + 2 + 3 + bytes.len()) as u64
            );
            if partial {
                fs::remove_file(dir.join("pending.safetensors.aiolm-part")).unwrap();
            }
        }
        write(
            &dir,
            "model.safetensors.index.json",
            br#"{"weight_map":{"one":"z.safetensors","two":"z.safetensors"}}"#,
        );
        assert!(inspect_snapshot(&dir).ready_files());
        write(&dir, "z.safetensors", b"");
        let truncated = inspect_snapshot(&dir);
        assert_eq!(truncated.missing, vec!["z.safetensors"]);
        assert!(!truncated.incomplete && !truncated.ready_files());
        write(&dir, "z.safetensors", b"x");
        assert!(inspect_snapshot(&dir).ready_files());
        for name in [
            "config.json",
            "tokenizer.json",
            "z.safetensors",
            "B.safetensors",
            "a.safetensors",
            "zero.safetensors",
            "model.safetensors.index.json",
        ] {
            fs::remove_file(dir.join(name)).unwrap();
        }
        fs::remove_dir(dir).unwrap();
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
            selected_file: None,
            files: vec![SnapshotFile {
                path: "model.safetensors".into(),
                remote_path: None,
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
        assert_eq!(artifact.selected_file, None);
        assert_eq!(artifact.selected_weight_files, None);
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
