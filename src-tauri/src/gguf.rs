//! Reading the few GGUF header facts the app needs from a model file.
//!
//! Only the bounded metadata block is read. Unused values, including tokenizer
//! arrays, are skipped; tensors are never read. Metadata order is not assumed,
//! so display tags after context_length remain available to model information UI.
//!
//! [`read_descriptor`] reads the `general.*` block the same bounded way, for
//! describing how a model was packaged. Key names and their meanings follow the
//! GGUF specification (`ggml/docs/gguf.md`).
//!
//! [`read_model_facts`] additionally walks the tensor info table that follows
//! the metadata, for sizing a launch before it happens. Only names, shapes and
//! data offsets are read; tensor data is still never touched.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

/// A header cannot be trusted to be well formed; these stop a malformed or
/// hostile file from turning into an unbounded read.
const MAX_KEYS: u64 = 4_096;
const MAX_KEY_BYTES: u64 = 1_024;
const MAX_ARRAY_LEN: u64 = 1 << 24;
/// Bound optional metadata inspection, including potentially large vocabularies.
const MAX_HEADER_SPAN: u64 = 128 * 1024 * 1024;
/// Cumulative string payload held across one scan. Keys and the short
/// `general.*` values this reader keeps are tiny; the tokenizer vocabulary
/// behind them is stepped over, not held.
const MAX_STRING_BUDGET: u64 = 2_000_000;
const MAX_STRING_ENTRIES: u64 = 2_000_000;
/// A header may name any number of base models; keep the read bounded and let
/// the caller decide how many of them are worth reporting.
const MAX_BASE_MODELS: usize = 64;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ModelMetadata {
    /// Added by the IPC layer only when an unchanged file has a download receipt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_repository: Option<String>,
    /// Repository inferred from the imported library's publisher/model folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantized_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    /// Context the model was trained for, when the header states it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// The architecture the header names, for display alongside it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finetune: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expert_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expert_used_count: Option<u64>,
}

/// The `general.*` block as the header states it, with no interpretation. A
/// header is written by whoever packaged the file, so bounding, normalising and
/// deciding what may leave the machine happen where a descriptor is consumed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelDescriptor {
    pub name: Option<String>,
    pub architecture: Option<String>,
    pub size_label: Option<String>,
    /// `general.file_type`, kept as the number the header carries.
    pub file_type: Option<u64>,
    pub quantized_by: Option<String>,
    pub repo_url: Option<String>,
    /// `general.base_model.{id}.repo_url`, ordered by the id the header gave.
    pub base_model_repo_urls: Vec<String>,
}

impl ModelDescriptor {
    /// Whether the header said anything at all about how it was packaged.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

struct Reader<R> {
    inner: R,
    /// Bytes consumed from the file so far, reads and skips alike. A hostile
    /// length must not turn the scan into a walk into tensor data.
    consumed: u64,
    /// String payload allocated so far. Many small keys are legitimate; one
    /// unbounded accumulation is not.
    strings: u64,
    string_entries: u64,
}

impl<R: Read + Seek> Reader<R> {
    fn account_strings(&mut self, count: u64) -> Result<(), String> {
        self.string_entries = self
            .string_entries
            .checked_add(count)
            .filter(|count| *count <= MAX_STRING_ENTRIES)
            .ok_or_else(|| "GGUF header exceeds its string entry budget".to_string())?;
        Ok(())
    }

    fn account(&mut self, bytes: u64) -> Result<(), String> {
        self.consumed = self
            .consumed
            .checked_add(bytes)
            .ok_or_else(|| "GGUF header exceeds its bounded metadata span".to_string())?;
        if self.consumed > MAX_HEADER_SPAN {
            return Err("GGUF header exceeds its bounded metadata span".into());
        }
        Ok(())
    }

    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
        self.account(N as u64)?;
        let mut buffer = [0u8; N];
        self.inner
            .read_exact(&mut buffer)
            .map_err(|error| format!("unreadable GGUF header: {error}"))?;
        Ok(buffer)
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes::<4>()?))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.bytes::<8>()?))
    }

    fn skip(&mut self, count: u64) -> Result<(), String> {
        // A cast would wrap a hostile length backwards into the header;
        // refuse it and stay inside the bounded metadata span instead.
        // `seek_relative` steps a buffered reader without re-seeking per
        // token the way an absolute seek would.
        let offset = i64::try_from(count)
            .map_err(|_| "GGUF header declares an implausible field length".to_string())?;
        self.account(count)?;
        self.inner
            .seek_relative(offset)
            .map_err(|error| format!("unreadable GGUF header: {error}"))?;
        Ok(())
    }

    fn string(&mut self) -> Result<String, String> {
        self.account_strings(1)?;
        let length = self.u64()?;
        if length > MAX_KEY_BYTES {
            self.skip(length)?;
            return Ok(String::new());
        }
        self.strings = self
            .strings
            .checked_add(length)
            .ok_or_else(|| "GGUF header declares implausible string data".to_string())?;
        if self.strings > MAX_STRING_BUDGET {
            return Err("GGUF header declares implausible string data".into());
        }
        self.account(length)?;
        let mut buffer = vec![0u8; length as usize];
        self.inner
            .read_exact(&mut buffer)
            .map_err(|error| format!("unreadable GGUF header: {error}"))?;
        Ok(String::from_utf8_lossy(&buffer).into_owned())
    }
}

/// Fixed width of a scalar value type, or `None` for the variable-length ones.
fn scalar_width(kind: u32) -> Option<u64> {
    match kind {
        0 | 1 | 7 => Some(1), // uint8, int8, bool
        2 | 3 => Some(2),     // uint16, int16
        4..=6 => Some(4),     // uint32, int32, float32
        10..=12 => Some(8),   // uint64, int64, float64
        _ => None,
    }
}

fn skip_value<R: Read + Seek>(reader: &mut Reader<R>, kind: u32) -> Result<(), String> {
    if let Some(width) = scalar_width(kind) {
        return reader.skip(width);
    }
    match kind {
        8 => {
            let length = reader.u64()?;
            reader.skip(length)
        }
        9 => {
            let element = reader.u32()?;
            let count = reader.u64()?;
            skip_array_body(reader, element, count)
        }
        _ => Err(format!("unsupported GGUF value type {kind}")),
    }
}

/// Steps over the elements of an array whose element type and count were
/// already read.
fn skip_array_body<R: Read + Seek>(
    reader: &mut Reader<R>,
    element: u32,
    count: u64,
) -> Result<(), String> {
    if count > MAX_ARRAY_LEN {
        return Err("GGUF header declares an implausible array".into());
    }
    if let Some(width) = scalar_width(element) {
        let bytes = width
            .checked_mul(count)
            .ok_or_else(|| "GGUF header declares an implausible array".to_string())?;
        return reader.skip(bytes);
    }
    if element != 8 {
        return Err(format!("unsupported GGUF array element type {element}"));
    }
    // Strings are individually sized, so the only way past them is
    // through them.
    reader.account_strings(count)?;
    for _ in 0..count {
        let length = reader.u64()?;
        reader.skip(length)?;
    }
    Ok(())
}

fn read_unsigned<R: Read + Seek>(reader: &mut Reader<R>, kind: u32) -> Result<Option<u64>, String> {
    Ok(match kind {
        4 => Some(u64::from(reader.u32()?)),
        10 => Some(reader.u64()?),
        5 => {
            let value = i32::from_le_bytes(reader.bytes::<4>()?);
            u64::try_from(value).ok()
        }
        11 => {
            let value = i64::from_le_bytes(reader.bytes::<8>()?);
            u64::try_from(value).ok()
        }
        _ => {
            skip_value(reader, kind)?;
            None
        }
    })
}

/// Opens a model, checks it is a GGUF header this build understands, and
/// returns the reader positioned at the first key with the key count.
#[allow(clippy::type_complexity)]
fn open_header(path: &Path) -> Result<(Reader<BufReader<File>>, u64), String> {
    let (reader, _tensors, keys) = open_header_with_tensors(path)?;
    Ok((reader, keys))
}

/// [`open_header`], also returning how many tensor infos follow the keys.
#[allow(clippy::type_complexity)]
fn open_header_with_tensors(path: &Path) -> Result<(Reader<BufReader<File>>, u64, u64), String> {
    let file = File::open(path).map_err(|error| format!("cannot open the model: {error}"))?;
    let mut reader = Reader {
        inner: BufReader::new(file),
        consumed: 0,
        strings: 0,
        string_entries: 0,
    };
    if &reader.bytes::<4>()? != b"GGUF" {
        return Err("not a GGUF file".into());
    }
    let version = reader.u32()?;
    if !(2..=3).contains(&version) {
        return Err(format!("unsupported GGUF version {version}"));
    }
    let tensors = reader.u64()?;
    let keys = reader.u64()?;
    if keys > MAX_KEYS {
        return Err("GGUF header declares an implausible key count".into());
    }
    Ok((reader, tensors, keys))
}

pub fn read_metadata(path: &Path) -> Result<ModelMetadata, String> {
    let (mut reader, keys) = open_header(path)?;
    let mut metadata = ModelMetadata::default();
    let mut architecture_values = std::collections::HashMap::new();
    for _ in 0..keys {
        let key = reader.string()?;
        let kind = reader.u32()?;
        if matches!(
            key.as_str(),
            "general.architecture"
                | "general.size_label"
                | "general.type"
                | "general.finetune"
                | "general.license"
                | "general.author"
                | "general.organization"
                | "general.quantized_by"
                | "general.repo_url"
        ) {
            if kind == 8 {
                let value = Some(reader.string()?);
                match key.as_str() {
                    "general.architecture" => metadata.architecture = value,
                    "general.size_label" => metadata.size_label = value,
                    "general.type" => metadata.model_type = value,
                    "general.finetune" => metadata.finetune = value,
                    "general.license" => metadata.license = value,
                    "general.author" => metadata.author = value,
                    "general.organization" => metadata.organization = value,
                    "general.quantized_by" => metadata.quantized_by = value,
                    "general.repo_url" => metadata.repo_url = value,
                    _ => unreachable!(),
                }
            } else {
                skip_value(&mut reader, kind)?;
            }
            continue;
        }
        if key == "general.file_type" {
            metadata.quantization = read_unsigned(&mut reader, kind)?
                .and_then(|value| u32::try_from(value).ok())
                .and_then(file_type_label)
                .map(str::to_owned);
            continue;
        }
        if key == "general.tags" || key == "general.languages" {
            let values = read_string_array(&mut reader, kind)?;
            if key == "general.tags" {
                metadata.tags = values;
            } else {
                metadata.languages = values;
            }
            continue;
        }
        if key.ends_with(".context_length")
            || key.ends_with(".expert_count")
            || key.ends_with(".expert_used_count")
        {
            if let Some(value) = read_unsigned(&mut reader, kind)? {
                architecture_values.insert(key, value);
            }
            continue;
        }
        skip_value(&mut reader, kind)?;
    }
    if let Some(architecture) = &metadata.architecture {
        metadata.context_length = architecture_values
            .get(&format!("{architecture}.context_length"))
            .copied()
            .filter(|value| *value > 0);
        metadata.expert_count = architecture_values
            .get(&format!("{architecture}.expert_count"))
            .copied();
        metadata.expert_used_count = architecture_values
            .get(&format!("{architecture}.expert_used_count"))
            .copied();
    }
    Ok(metadata)
}

fn read_string_array<R: Read + Seek>(
    reader: &mut Reader<R>,
    kind: u32,
) -> Result<Vec<String>, String> {
    if kind != 9 {
        skip_value(reader, kind)?;
        return Ok(Vec::new());
    }
    let element = reader.u32()?;
    let count = reader.u64()?;
    if count > MAX_ARRAY_LEN {
        return Err("GGUF header declares an implausible array".into());
    }
    if let Some(width) = scalar_width(element) {
        reader.skip(count.checked_mul(width).ok_or("GGUF array size overflow")?)?;
        return Ok(Vec::new());
    }
    if element == 9 {
        return Err("unsupported GGUF nested array".into());
    }
    let mut values = Vec::new();
    for _ in 0..count {
        if element == 8 {
            let value = reader.string()?;
            if !value.trim().is_empty() {
                values.push(value);
            }
        } else {
            skip_value(reader, element)?;
        }
    }
    Ok(values)
}

/// The label llama.cpp's `llama_ftype` gives `general.file_type`, without the
/// `MOSTLY_` prefix that only says 1d tensors are excluded. Source of truth is
/// the `llama_ftype` enum in llama.cpp's `include/llama.h`, verified against
/// the current upstream (38 is `MXFP4_MOE`, 39 `NVFP4`, 40 `Q1_0`, 41 `Q2_0`,
/// `GUESSED` is 1024). The `GGML_TYPE` tensor-type numbering is a different
/// enum and is never used here.
///
/// A value the enum does not define — one whose support was removed, one a
/// newer llama.cpp added, or `LLAMA_FTYPE_GUESSED`, which states the type was
/// not recorded — has no label here. The number is reported as the header gave
/// it and the quantisation stays unknown rather than being guessed.
pub fn file_type_label(value: u32) -> Option<&'static str> {
    Some(match value {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        7 => "Q8_0",
        8 => "Q5_0",
        9 => "Q5_1",
        10 => "Q2_K",
        11 => "Q3_K_S",
        12 => "Q3_K_M",
        13 => "Q3_K_L",
        14 => "Q4_K_S",
        15 => "Q4_K_M",
        16 => "Q5_K_S",
        17 => "Q5_K_M",
        18 => "Q6_K",
        19 => "IQ2_XXS",
        20 => "IQ2_XS",
        21 => "Q2_K_S",
        22 => "IQ3_XS",
        23 => "IQ3_XXS",
        24 => "IQ1_S",
        25 => "IQ4_NL",
        26 => "IQ3_S",
        27 => "IQ3_M",
        28 => "IQ2_S",
        29 => "IQ2_M",
        30 => "IQ4_XS",
        31 => "IQ1_M",
        32 => "BF16",
        36 => "TQ1_0",
        37 => "TQ2_0",
        38 => "MXFP4_MOE",
        39 => "NVFP4",
        40 => "Q1_0",
        41 => "Q2_0",
        _ => return None,
    })
}

/// `general.base_model.{id}.repo_url`, or `None` for any other key.
fn base_model_index(key: &str) -> Option<u32> {
    key.strip_prefix("general.base_model.")?
        .strip_suffix(".repo_url")?
        .parse()
        .ok()
}

/// Reads the `general.*` block, stepping over everything else exactly as the
/// context reader does.
///
/// Unlike that reader this one cannot stop early: the specification fixes no
/// order, so a key could sit behind the tokenizer arrays. The cost is therefore
/// one pass over the key table, bounded by [`MAX_KEYS`] and by the per-value
/// limits above. No tensor data is touched, no digest is computed and nothing
/// is inferred from the file's name.
pub fn read_descriptor(path: &Path) -> Result<ModelDescriptor, String> {
    let (mut reader, keys) = open_header(path)?;
    let mut descriptor = ModelDescriptor::default();
    let mut base_models: Vec<(u32, String)> = Vec::new();
    let mut declared_base_models: Option<u64> = None;
    for _ in 0..keys {
        let key = reader.string()?;
        let kind = reader.u32()?;
        let text = |reader: &mut Reader<BufReader<File>>| -> Result<Option<String>, String> {
            if kind == 8 {
                return Ok(Some(reader.string()?));
            }
            skip_value(reader, kind)?;
            Ok(None)
        };
        match key.as_str() {
            "general.name" => descriptor.name = text(&mut reader)?,
            "general.architecture" => descriptor.architecture = text(&mut reader)?,
            "general.size_label" => descriptor.size_label = text(&mut reader)?,
            "general.quantized_by" => descriptor.quantized_by = text(&mut reader)?,
            "general.repo_url" => descriptor.repo_url = text(&mut reader)?,
            "general.file_type" => descriptor.file_type = read_unsigned(&mut reader, kind)?,
            "general.base_model.count" => {
                declared_base_models = read_unsigned(&mut reader, kind)?;
            }
            _ => match base_model_index(&key) {
                Some(index) if base_models.len() < MAX_BASE_MODELS => {
                    if let Some(url) = text(&mut reader)? {
                        base_models.push((index, url));
                    }
                }
                _ => skip_value(&mut reader, kind)?,
            },
        }
    }
    // `general.base_model.count` declares how many entries the header lists,
    // and each entry is only valid when its own index falls inside that
    // count. Truncating the vector would keep a stale `index 99` when the
    // count says `1`; filtering by index refuses it instead.
    base_models.sort_by_key(|(index, _)| *index);
    if let Some(count) = declared_base_models {
        base_models.retain(|(index, _)| (*index as u64) < count);
        base_models.truncate(MAX_BASE_MODELS);
    }
    descriptor.base_model_repo_urls = base_models.into_iter().map(|(_, url)| url).collect();
    Ok(descriptor)
}

/// Tensor infos one header may declare. Real models stay far below this, and
/// the metadata span bound limits the walk as well.
const MAX_TENSORS: u64 = 1 << 20;
/// `GGML_MAX_NAME` is 64 bytes; some slack is left for forks, but a longer
/// name cannot belong to a tensor llama.cpp loads.
const MAX_TENSOR_NAME_BYTES: u64 = 256;
/// `GGML_MAX_DIMS`.
const MAX_TENSOR_DIMS: u32 = 4;
/// Layer indices and per-layer arrays beyond this are not a real model
/// (`LLAMA_MAX_LAYERS` is 512 upstream).
pub const MAX_MODEL_LAYERS: usize = 4_096;
/// `GGUF_DEFAULT_ALIGNMENT`, used when `general.alignment` is absent.
const DEFAULT_ALIGNMENT: u64 = 32;

/// Keys, after the `{arch}.` prefix, whose values size a launch. Names follow
/// `LLM_KV_NAMES` in llama.cpp's `src/llama-arch.cpp`.
const FACT_SUFFIXES: &[&str] = &[
    "block_count",
    "nextn_predict_layers",
    "context_length",
    "embedding_length",
    "vocab_size",
    "feed_forward_length",
    "expert_feed_forward_length",
    "expert_shared_feed_forward_length",
    "expert_used_count",
    "attention.head_count",
    "attention.head_count_kv",
    "attention.key_length",
    "attention.value_length",
    "attention.sliding_window",
    "attention.kv_lora_rank",
    "attention.recurrent_layers",
    "full_attention_interval",
    "ssm.conv_kernel",
    "ssm.inner_size",
    "ssm.state_size",
    "ssm.group_count",
    "attention.indexer.key_length",
    "hyper_connection.count",
    "ple.layers",
    "ple.conv_kernel",
    "ple.ngram_size",
];

/// Key families only recurrent state carries: `ssm.*` (Mamba-style layers),
/// `wkv.*` and the time-mix sizes (RWKV), `shortconv.*` (LFM2).
const RECURRENT_KEYS: &[&str] = &[
    "ssm.",
    "wkv.",
    "shortconv.",
    "time_mix_extra_dim",
    "time_decay_extra_dim",
];

/// A hyperparameter llama.cpp reads with `get_key_or_arr`: one value shared by
/// every layer, or one value per layer.
#[derive(Clone, Debug, PartialEq)]
pub enum PerLayer {
    Uniform(u64),
    Layers(Vec<u64>),
}

impl PerLayer {
    /// The value for layer `il`, or `None` past the end of a short array.
    pub fn at(&self, il: usize) -> Option<u64> {
        match self {
            Self::Uniform(value) => Some(*value),
            Self::Layers(values) => values.get(il).copied(),
        }
    }

    pub fn max(&self) -> u64 {
        match self {
            Self::Uniform(value) => *value,
            Self::Layers(values) => values.iter().copied().max().unwrap_or(0),
        }
    }
}

/// Weight bytes of one repeating layer (`blk.N.*`), split the way llama.cpp's
/// CPU override flags split it (`common/common.h`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayerBytes {
    /// `LLM_FFN_EXPS_REGEX`, `\.ffn_(up|down|gate|gate_up)_(ch|)exps`, which
    /// `--cpu-moe` and `--n-cpu-moe` keep on the CPU.
    pub experts: u64,
    /// `LLM_FFN_DENSE_REGEX`, `\.ffn_(up|down|gate)\.`, which `--n-cpu-ffn`
    /// keeps on the CPU.
    pub dense_ffn: u64,
    pub other: u64,
}

impl LayerBytes {
    pub fn total(&self) -> u64 {
        self.experts
            .saturating_add(self.dense_ffn)
            .saturating_add(self.other)
    }
}

/// Tensor data bytes grouped by the layer llama.cpp assigns them to
/// (`LLM_TENSOR_INFOS` in `src/llama-arch.cpp`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TensorBytes {
    /// Input-layer tensors other than `token_embd.weight`; kept on the CPU.
    pub input: u64,
    /// Subset of `input` eligible for on-demand disk reads in PLE models.
    pub per_layer_token_embd: u64,
    /// `token_embd.weight`, also an input-layer tensor. A model without
    /// `output.weight` loads it a second time as its output
    /// (`TENSOR_DUPLICATED`).
    pub token_embd: u64,
    /// Output-layer tensors, plus the few tiny non-repeating ones (rope
    /// factors, embedding norms) that are placed with them here.
    pub output: u64,
    pub layers: Vec<LayerBytes>,
    pub has_output_weight: bool,
    /// Rows of `token_embd.weight` or `output.weight`: the vocabulary size.
    pub vocab: Option<u64>,
}

impl TensorBytes {
    pub fn total(&self) -> u64 {
        self.layers
            .iter()
            .fold(self.input.saturating_add(self.token_embd), |sum, layer| {
                sum.saturating_add(layer.total())
            })
            .saturating_add(self.output)
    }

    /// Adds the tensors of another shard of the same model.
    pub fn absorb(&mut self, other: &TensorBytes) {
        self.input = self.input.saturating_add(other.input);
        self.per_layer_token_embd = self
            .per_layer_token_embd
            .saturating_add(other.per_layer_token_embd);
        self.token_embd = self.token_embd.saturating_add(other.token_embd);
        self.output = self.output.saturating_add(other.output);
        if self.layers.len() < other.layers.len() {
            self.layers
                .resize(other.layers.len(), LayerBytes::default());
        }
        for (mine, theirs) in self.layers.iter_mut().zip(&other.layers) {
            mine.experts = mine.experts.saturating_add(theirs.experts);
            mine.dense_ffn = mine.dense_ffn.saturating_add(theirs.dense_ffn);
            mine.other = mine.other.saturating_add(theirs.other);
        }
        self.has_output_weight |= other.has_output_weight;
        self.vocab = self.vocab.or(other.vocab);
    }
}

/// What one GGUF header says about the memory a model needs once loaded.
/// Every value is exactly as the header states it; which of them a runtime
/// honours is decided where the facts are consumed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelFacts {
    pub architecture: Option<String>,
    pub block_count: Option<u64>,
    pub nextn_layers: Option<u64>,
    pub context_length: Option<u64>,
    pub embedding_length: Option<u64>,
    pub vocab_size: Option<u64>,
    pub feed_forward_length: Option<PerLayer>,
    pub expert_feed_forward_length: Option<PerLayer>,
    pub expert_shared_feed_forward_length: Option<u64>,
    pub expert_used_count: Option<PerLayer>,
    pub head_count: Option<PerLayer>,
    pub head_count_kv: Option<PerLayer>,
    pub key_length: Option<u64>,
    pub value_length: Option<u64>,
    /// Present on models with sliding-window attention layers.
    pub sliding_window: Option<u64>,
    /// Present on multi-head latent attention (MLA) models.
    pub kv_lora_rank: Option<u64>,
    /// The header carries keys only recurrent layers use.
    pub recurrent_state: bool,
    pub recurrent_layers: Option<PerLayer>,
    pub full_attention_interval: Option<u64>,
    pub ssm_conv_kernel: Option<u64>,
    pub ssm_inner_size: Option<u64>,
    pub ssm_state_size: Option<u64>,
    pub ssm_group_count: Option<u64>,
    pub indexer_key_length: Option<u64>,
    pub hyper_connections: Option<u64>,
    pub ple_layers: Vec<u64>,
    pub ple_conv_kernel: Option<u64>,
    pub ple_ngram_size: Option<u64>,
    /// `split.count`: how many files a sharded model spans.
    pub split_count: Option<u64>,
    /// `None` when the tensor table does not describe the file consistently.
    pub tensors: Option<TensorBytes>,
}

enum RawValue {
    Int(u64),
    Ints(Vec<u64>),
}

/// Reads any integer or boolean scalar. Other types, and negative values,
/// are stepped over and reported as absent.
fn read_integer<R: Read + Seek>(reader: &mut Reader<R>, kind: u32) -> Result<Option<u64>, String> {
    Ok(match kind {
        0 => Some(u64::from(reader.bytes::<1>()?[0])),
        1 => u64::try_from(i8::from_le_bytes(reader.bytes::<1>()?)).ok(),
        2 => Some(u64::from(u16::from_le_bytes(reader.bytes::<2>()?))),
        3 => u64::try_from(i16::from_le_bytes(reader.bytes::<2>()?)).ok(),
        4 => Some(u64::from(reader.u32()?)),
        5 => u64::try_from(i32::from_le_bytes(reader.bytes::<4>()?)).ok(),
        7 => Some(u64::from(reader.bytes::<1>()?[0] != 0)),
        10 => Some(reader.u64()?),
        11 => u64::try_from(i64::from_le_bytes(reader.bytes::<8>()?)).ok(),
        _ => {
            skip_value(reader, kind)?;
            None
        }
    })
}

fn read_raw<R: Read + Seek>(reader: &mut Reader<R>, kind: u32) -> Result<Option<RawValue>, String> {
    if kind != 9 {
        return Ok(read_integer(reader, kind)?.map(RawValue::Int));
    }
    let element = reader.u32()?;
    let count = reader.u64()?;
    let integer = matches!(element, 0..=5 | 7 | 10 | 11);
    if !integer || count > MAX_MODEL_LAYERS as u64 {
        skip_array_body(reader, element, count)?;
        return Ok(None);
    }
    let mut values = Vec::with_capacity(count as usize);
    for _ in 0..count {
        values.push(read_integer(reader, element)?);
    }
    // A negative entry has no meaning as a size; drop the whole array rather
    // than shift the layers after it.
    let Some(values) = values.into_iter().collect::<Option<Vec<_>>>() else {
        return Ok(None);
    };
    Ok(Some(RawValue::Ints(values)))
}

enum LayerPart {
    Experts,
    DenseFfn,
    Other,
}

enum TensorClass {
    Input,
    TokenEmbd,
    Output,
    Layer(usize, LayerPart),
}

/// Groups a tensor by name the way llama.cpp's tensor table and CPU override
/// patterns do. Repeating tensors are `blk.{il}.*`; the input layer is the
/// set `LLM_TENSOR_INFOS` marks `LLM_TENSOR_LAYER_INPUT`.
fn classify_tensor(name: &str) -> TensorClass {
    if let Some(rest) = name.strip_prefix("blk.") {
        let digits = rest.split('.').next().unwrap_or_default();
        if let Some(il) = digits
            .parse::<usize>()
            .ok()
            .filter(|il| *il < MAX_MODEL_LAYERS)
        {
            let tail = &rest[digits.len()..];
            const EXPERTS: [&str; 8] = [
                ".ffn_up_exps",
                ".ffn_down_exps",
                ".ffn_gate_exps",
                ".ffn_gate_up_exps",
                ".ffn_up_chexps",
                ".ffn_down_chexps",
                ".ffn_gate_chexps",
                ".ffn_gate_up_chexps",
            ];
            const DENSE: [&str; 3] = [".ffn_up.", ".ffn_down.", ".ffn_gate."];
            let part = if EXPERTS.iter().any(|part| tail.starts_with(part)) {
                LayerPart::Experts
            } else if DENSE.iter().any(|part| tail.starts_with(part)) {
                LayerPart::DenseFfn
            } else {
                LayerPart::Other
            };
            return TensorClass::Layer(il, part);
        }
    }
    if name == "token_embd.weight" {
        return TensorClass::TokenEmbd;
    }
    let base = name.split('.').next().unwrap_or_default();
    if matches!(
        base,
        "token_embd"
            | "position_embd"
            | "token_types"
            | "per_layer_token_embd"
            | "masked_embd_centroids"
            | "masked_embd_ordering"
    ) || name.starts_with("hrm.z_l_init")
    {
        TensorClass::Input
    } else {
        TensorClass::Output
    }
}

/// Walks the tensor info table and sizes every tensor from the gap to the
/// next data offset (the last one runs to the end of the file). Sizes include
/// alignment padding, at most `alignment - 1` bytes each, which keeps the
/// result independent of the quantisation types a build knows about.
fn read_tensor_bytes<R: Read + Seek>(
    reader: &mut Reader<R>,
    count: u64,
    alignment: u64,
    file_len: u64,
) -> Result<Option<TensorBytes>, String> {
    let mut summary = TensorBytes::default();
    let mut entries = Vec::new();
    let mut name = Vec::new();
    for _ in 0..count {
        let length = reader.u64()?;
        if length > MAX_TENSOR_NAME_BYTES {
            return Err("GGUF tensor name is implausibly long".into());
        }
        reader.account(length)?;
        name.resize(length as usize, 0);
        reader
            .inner
            .read_exact(&mut name)
            .map_err(|error| format!("unreadable GGUF header: {error}"))?;
        let dims = reader.u32()?;
        if dims > MAX_TENSOR_DIMS {
            return Err("GGUF tensor declares too many dimensions".into());
        }
        let mut shape = [1u64; MAX_TENSOR_DIMS as usize];
        for dim in shape.iter_mut().take(dims as usize) {
            *dim = reader.u64()?;
        }
        let _type = reader.u32()?;
        let offset = reader.u64()?;
        let name = String::from_utf8_lossy(&name);
        if name == "output.weight" {
            summary.has_output_weight = true;
        }
        if (name == "token_embd.weight" || name == "output.weight") && dims >= 2 {
            summary.vocab.get_or_insert(shape[1]);
        }
        entries.push((
            offset,
            classify_tensor(&name),
            name == "per_layer_token_embd.weight",
        ));
    }
    let data_start = reader
        .consumed
        .div_ceil(alignment)
        .checked_mul(alignment)
        .ok_or_else(|| "GGUF header declares an implausible data offset".to_string())?;
    let Some(data_len) = file_len.checked_sub(data_start) else {
        return Ok(None);
    };
    entries.sort_by_key(|(offset, _, _)| *offset);
    for index in 0..entries.len() {
        let offset = entries[index].0;
        let end = entries
            .get(index + 1)
            .map_or(data_len, |(next, _, _)| *next);
        if offset >= data_len || end <= offset {
            return Ok(None);
        }
        let bytes = end - offset;
        if entries[index].2 {
            summary.per_layer_token_embd = summary.per_layer_token_embd.saturating_add(bytes);
        }
        match &entries[index].1 {
            TensorClass::Input => summary.input = summary.input.saturating_add(bytes),
            TensorClass::TokenEmbd => summary.token_embd = summary.token_embd.saturating_add(bytes),
            TensorClass::Output => summary.output = summary.output.saturating_add(bytes),
            TensorClass::Layer(il, part) => {
                if summary.layers.len() <= *il {
                    summary.layers.resize(il + 1, LayerBytes::default());
                }
                let layer = &mut summary.layers[*il];
                let slot = match part {
                    LayerPart::Experts => &mut layer.experts,
                    LayerPart::DenseFfn => &mut layer.dense_ffn,
                    LayerPart::Other => &mut layer.other,
                };
                *slot = slot.saturating_add(bytes);
            }
        }
    }
    Ok(Some(summary))
}

/// Reads the hyperparameters and tensor sizes that decide a model's memory,
/// through the same bounded reader as [`read_metadata`].
pub fn read_model_facts(path: &Path) -> Result<ModelFacts, String> {
    let file_len = std::fs::metadata(path)
        .map_err(|error| format!("cannot open the model: {error}"))?
        .len();
    let (mut reader, tensors, keys) = open_header_with_tensors(path)?;
    if tensors > MAX_TENSORS {
        return Err("GGUF header declares an implausible tensor count".into());
    }
    let mut facts = ModelFacts::default();
    let mut alignment = DEFAULT_ALIGNMENT;
    let mut values = HashMap::new();
    let mut recurrent_prefixes = HashSet::new();
    for _ in 0..keys {
        let key = reader.string()?;
        let kind = reader.u32()?;
        match key.as_str() {
            "general.architecture" if kind == 8 => facts.architecture = Some(reader.string()?),
            "general.alignment" => {
                if let Some(value) = read_integer(&mut reader, kind)? {
                    alignment = value;
                }
            }
            "split.count" => facts.split_count = read_integer(&mut reader, kind)?,
            _ => {
                let (prefix, rest) = key.split_once('.').unwrap_or((key.as_str(), ""));
                if RECURRENT_KEYS.iter().any(|marker| rest.starts_with(marker)) {
                    recurrent_prefixes.insert(prefix.to_owned());
                }
                if FACT_SUFFIXES.contains(&rest) {
                    if let Some(value) = read_raw(&mut reader, kind)? {
                        values.insert(key.clone(), value);
                    }
                    continue;
                }
                skip_value(&mut reader, kind)?;
            }
        }
    }
    // gguf.cpp refuses an alignment that is zero or not a power of two.
    if alignment == 0 || !alignment.is_power_of_two() {
        return Err("GGUF header declares an invalid alignment".into());
    }
    facts.tensors = read_tensor_bytes(&mut reader, tensors, alignment, file_len)?;

    let Some(architecture) = facts.architecture.clone() else {
        return Ok(facts);
    };
    facts.recurrent_state = recurrent_prefixes.contains(&architecture);
    let value = |suffix: &str| values.get(&format!("{architecture}.{suffix}"));
    let int = |suffix: &str| match value(suffix) {
        Some(RawValue::Int(value)) => Some(*value),
        _ => None,
    };
    let per_layer = |suffix: &str| match value(suffix) {
        Some(RawValue::Int(value)) => Some(PerLayer::Uniform(*value)),
        Some(RawValue::Ints(values)) => Some(PerLayer::Layers(values.clone())),
        _ => None,
    };
    facts.block_count = int("block_count");
    facts.nextn_layers = int("nextn_predict_layers");
    facts.context_length = int("context_length");
    facts.embedding_length = int("embedding_length");
    facts.vocab_size = int("vocab_size");
    facts.feed_forward_length = per_layer("feed_forward_length");
    facts.expert_feed_forward_length = per_layer("expert_feed_forward_length");
    facts.expert_shared_feed_forward_length = int("expert_shared_feed_forward_length");
    facts.expert_used_count = per_layer("expert_used_count");
    facts.head_count = per_layer("attention.head_count");
    facts.head_count_kv = per_layer("attention.head_count_kv");
    facts.key_length = int("attention.key_length");
    facts.value_length = int("attention.value_length");
    facts.sliding_window = int("attention.sliding_window");
    facts.kv_lora_rank = int("attention.kv_lora_rank");
    facts.recurrent_layers = per_layer("attention.recurrent_layers");
    facts.full_attention_interval = int("full_attention_interval");
    facts.ssm_conv_kernel = int("ssm.conv_kernel");
    facts.ssm_inner_size = int("ssm.inner_size");
    facts.ssm_state_size = int("ssm.state_size");
    facts.ssm_group_count = int("ssm.group_count");
    facts.indexer_key_length = int("attention.indexer.key_length");
    facts.hyper_connections = int("hyper_connection.count");
    if let Some(RawValue::Ints(layers)) = value("ple.layers") {
        facts.ple_layers = layers.clone();
    }
    facts.ple_conv_kernel = int("ple.conv_kernel");
    facts.ple_ngram_size = int("ple.ngram_size");
    Ok(facts)
}

/// Synthetic GGUF files for tests: metadata plus a tensor table whose data
/// is zero-filled, so every tensor's size is exactly what the test declares.
#[cfg(test)]
pub(crate) mod fixture {
    pub(crate) enum Value {
        U32(u32),
        Str(&'static str),
        U32s(Vec<u32>),
    }

    fn string(out: &mut Vec<u8>, value: &str) {
        out.extend_from_slice(&(value.len() as u64).to_le_bytes());
        out.extend_from_slice(value.as_bytes());
    }

    /// Tensors are `(name, shape, bytes)`; sizes that are multiples of the
    /// default 32-byte alignment come back exactly.
    pub(crate) fn file(values: &[(String, Value)], tensors: &[(String, Vec<u64>, u64)]) -> Vec<u8> {
        let mut out = b"GGUF".to_vec();
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&(tensors.len() as u64).to_le_bytes());
        out.extend_from_slice(&(values.len() as u64).to_le_bytes());
        for (key, value) in values {
            string(&mut out, key);
            match value {
                Value::U32(value) => {
                    out.extend_from_slice(&4u32.to_le_bytes());
                    out.extend_from_slice(&value.to_le_bytes());
                }
                Value::Str(value) => {
                    out.extend_from_slice(&8u32.to_le_bytes());
                    string(&mut out, value);
                }
                Value::U32s(values) => {
                    out.extend_from_slice(&9u32.to_le_bytes());
                    out.extend_from_slice(&4u32.to_le_bytes());
                    out.extend_from_slice(&(values.len() as u64).to_le_bytes());
                    for value in values {
                        out.extend_from_slice(&value.to_le_bytes());
                    }
                }
            }
        }
        let mut offset = 0u64;
        for (name, shape, bytes) in tensors {
            string(&mut out, name);
            out.extend_from_slice(&(shape.len() as u32).to_le_bytes());
            for dim in shape {
                out.extend_from_slice(&dim.to_le_bytes());
            }
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&offset.to_le_bytes());
            offset += bytes.div_ceil(32) * 32;
        }
        out.resize(out.len().div_ceil(32) * 32, 0);
        out.resize(out.len() + offset as usize, 0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn string(value: &str) -> Vec<u8> {
        let mut out = (value.len() as u64).to_le_bytes().to_vec();
        out.extend_from_slice(value.as_bytes());
        out
    }

    fn header(entries: &[(&str, u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = b"GGUF".to_vec();
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u64).to_le_bytes());
        for (key, kind, value) in entries {
            out.extend_from_slice(&string(key));
            out.extend_from_slice(&kind.to_le_bytes());
            out.extend_from_slice(value);
        }
        out
    }

    fn in_temporary_file<T>(bytes: &[u8], read: impl Fn(&Path) -> T) -> T {
        let directory = std::env::temp_dir().join(format!("aiolm-gguf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("model.gguf");
        File::create(&path).unwrap().write_all(bytes).unwrap();
        let result = read(&path);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        result
    }

    fn read(bytes: &[u8]) -> Result<ModelMetadata, String> {
        in_temporary_file(bytes, read_metadata)
    }

    fn descriptor(bytes: &[u8]) -> Result<ModelDescriptor, String> {
        in_temporary_file(bytes, read_descriptor)
    }

    #[test]
    fn reads_the_trained_context_past_entries_it_does_not_understand() {
        // Real headers put unrelated scalars, strings and arrays in front of the
        // value wanted here; stepping over them is most of the job.
        let metadata = read(&header(&[
            ("general.architecture", 8, string("qwen3moe")),
            ("general.name", 8, string("Qwen3")),
            ("qwen3moe.block_count", 4, 48u32.to_le_bytes().to_vec()),
            (
                "qwen3moe.context_length",
                4,
                262_144u32.to_le_bytes().to_vec(),
            ),
        ]))
        .unwrap();
        assert_eq!(metadata.context_length, Some(262_144));
        assert_eq!(metadata.architecture.as_deref(), Some("qwen3moe"));
    }

    #[test]
    fn steps_over_arrays_including_the_string_arrays_that_carry_a_vocabulary() {
        let mut floats = 4u32.to_le_bytes().to_vec();
        floats.extend_from_slice(&0u64.to_le_bytes());
        let mut vocabulary = 8u32.to_le_bytes().to_vec();
        vocabulary.extend_from_slice(&2u64.to_le_bytes());
        vocabulary.extend_from_slice(&string("hello"));
        vocabulary.extend_from_slice(&string("world"));
        let metadata = read(&header(&[
            ("tokenizer.ggml.tokens", 9, vocabulary),
            ("tokenizer.ggml.scores", 9, floats),
            ("general.architecture", 8, string("llama")),
            ("llama.context_length", 10, 8_192u64.to_le_bytes().to_vec()),
        ]))
        .unwrap();
        assert_eq!(metadata.context_length, Some(8_192));
    }

    #[test]
    fn reports_a_header_that_is_not_gguf_rather_than_guessing() {
        assert!(read(b"NOPE").is_err());
        assert!(read_metadata(Path::new("does-not-exist.gguf")).is_err());
    }

    #[test]
    fn leaves_the_context_unknown_when_the_header_does_not_state_one() {
        let metadata = read(&header(&[("general.architecture", 8, string("llama"))])).unwrap();
        assert_eq!(metadata.context_length, None);
    }

    #[test]
    fn exposes_declared_architecture_and_tags_after_context_without_name_inference() {
        let mut tags = 8u32.to_le_bytes().to_vec();
        tags.extend_from_slice(&3u64.to_le_bytes());
        for value in ["reasoning", "custom-model-tag", "text-generation"] {
            tags.extend_from_slice(&string(value));
        }
        let mut languages = 8u32.to_le_bytes().to_vec();
        languages.extend_from_slice(&2u64.to_le_bytes());
        languages.extend_from_slice(&string("en"));
        languages.extend_from_slice(&string("ko"));
        let metadata = read(&header(&[
            (
                "qwen4exp.context_length",
                4,
                262_144u32.to_le_bytes().to_vec(),
            ),
            ("general.name", 8, string("Example Flash Next")),
            ("general.architecture", 8, string("qwen4exp")),
            ("unrelated.context_length", 4, 128u32.to_le_bytes().to_vec()),
            ("general.tags", 9, tags),
            ("general.languages", 9, languages),
            ("general.size_label", 8, string("30B-A3B")),
            ("general.file_type", 4, 15u32.to_le_bytes().to_vec()),
            ("general.type", 8, string("model")),
            ("general.finetune", 8, string("Instruct")),
            ("general.license", 8, string("apache-2.0")),
            ("general.author", 8, string("Example Authors")),
            ("general.organization", 8, string("Example Research")),
            ("general.quantized_by", 8, string("Example Quantizer")),
            (
                "general.repo_url",
                8,
                string("https://huggingface.co/example-publisher/example-model"),
            ),
            ("qwen4exp.expert_count", 4, 128u32.to_le_bytes().to_vec()),
            ("qwen4exp.expert_used_count", 4, 8u32.to_le_bytes().to_vec()),
        ]))
        .unwrap();
        assert_eq!(metadata.architecture.as_deref(), Some("qwen4exp"));
        assert_eq!(metadata.context_length, Some(262_144));
        assert_eq!(metadata.size_label.as_deref(), Some("30B-A3B"));
        assert_eq!(metadata.quantization.as_deref(), Some("Q4_K_M"));
        assert_eq!(
            metadata.tags,
            ["reasoning", "custom-model-tag", "text-generation"]
        );
        assert_eq!(metadata.languages, ["en", "ko"]);
        assert_eq!(metadata.model_type.as_deref(), Some("model"));
        assert_eq!(metadata.finetune.as_deref(), Some("Instruct"));
        assert_eq!(metadata.license.as_deref(), Some("apache-2.0"));
        assert_eq!(metadata.author.as_deref(), Some("Example Authors"));
        assert_eq!(metadata.organization.as_deref(), Some("Example Research"));
        assert_eq!(metadata.quantized_by.as_deref(), Some("Example Quantizer"));
        assert_eq!(
            metadata.repo_url.as_deref(),
            Some("https://huggingface.co/example-publisher/example-model")
        );
        assert_eq!(metadata.expert_count, Some(128));
        assert_eq!(metadata.expert_used_count, Some(8));
    }

    #[test]
    fn skips_wrong_tag_types_and_rejects_unbounded_tag_arrays() {
        let wrong = read(&header(&[("general.tags", 4, 2u32.to_le_bytes().to_vec())])).unwrap();
        assert!(wrong.tags.is_empty());
        let mut oversized = 8u32.to_le_bytes().to_vec();
        oversized.extend_from_slice(&u64::MAX.to_le_bytes());
        assert!(read(&header(&[("general.tags", 9, oversized)])).is_err());
    }

    #[test]
    fn refuses_a_header_that_declares_more_than_a_header_can_hold() {
        let mut bytes = b"GGUF".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&u64::MAX.to_le_bytes());
        assert!(read(&bytes).is_err());
    }

    #[test]
    fn describes_how_a_model_was_packaged_from_the_general_block() {
        let described = descriptor(&header(&[
            ("general.architecture", 8, string("llama")),
            ("general.name", 8, string("Synthetic 7B")),
            ("general.size_label", 8, string("7B")),
            ("general.file_type", 4, 15u32.to_le_bytes().to_vec()),
            ("general.quantized_by", 8, string("synthetic-quantizer")),
            (
                "general.repo_url",
                8,
                string("https://huggingface.co/synthetic-org/synthetic-model"),
            ),
            ("general.base_model.count", 4, 2u32.to_le_bytes().to_vec()),
            // Written out of order, and with a third entry the count excludes.
            (
                "general.base_model.1.repo_url",
                8,
                string("https://huggingface.co/synthetic-base/second"),
            ),
            (
                "general.base_model.0.repo_url",
                8,
                string("https://huggingface.co/synthetic-base/first"),
            ),
            (
                "general.base_model.2.repo_url",
                8,
                string("https://huggingface.co/synthetic-base/stale"),
            ),
        ]))
        .unwrap();
        assert_eq!(described.name.as_deref(), Some("Synthetic 7B"));
        assert_eq!(described.architecture.as_deref(), Some("llama"));
        assert_eq!(described.size_label.as_deref(), Some("7B"));
        assert_eq!(described.file_type, Some(15));
        assert_eq!(
            described.quantized_by.as_deref(),
            Some("synthetic-quantizer")
        );
        assert_eq!(
            described.base_model_repo_urls,
            vec![
                "https://huggingface.co/synthetic-base/first".to_string(),
                "https://huggingface.co/synthetic-base/second".to_string(),
            ]
        );
    }

    #[test]
    fn a_general_key_behind_the_tokenizer_is_still_read() {
        // Nothing in the format fixes the order of keys, so the scan cannot
        // stop at the first key it does not recognise.
        let mut vocabulary = 8u32.to_le_bytes().to_vec();
        vocabulary.extend_from_slice(&2u64.to_le_bytes());
        vocabulary.extend_from_slice(&string("hello"));
        vocabulary.extend_from_slice(&string("world"));
        let described = descriptor(&header(&[
            ("general.architecture", 8, string("llama")),
            ("tokenizer.ggml.tokens", 9, vocabulary),
            ("general.size_label", 8, string("7B")),
        ]))
        .unwrap();
        assert_eq!(described.size_label.as_deref(), Some("7B"));
        assert!(!described.is_empty());
        assert!(descriptor(&header(&[(
            "llama.block_count",
            4,
            32u32.to_le_bytes().to_vec()
        )]))
        .unwrap()
        .is_empty());
    }

    #[test]
    fn only_a_file_type_the_runtime_enum_defines_names_a_quantisation() {
        assert_eq!(file_type_label(0), Some("F32"));
        assert_eq!(file_type_label(15), Some("Q4_K_M"));
        assert_eq!(file_type_label(38), Some("MXFP4_MOE"));
        // Values the enum leaves out: withdrawn types, a gap, the placeholder
        // for a type that was never recorded, and anything newer than this
        // build knows about.
        for unknown in [4, 5, 6, 33, 34, 35, 42, 1024] {
            assert_eq!(file_type_label(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn a_truncated_value_is_an_error_not_a_silent_zero() {
        let mut cursor = Reader {
            inner: Cursor::new(vec![0u8; 2]),
            consumed: 0,
            strings: 0,
            string_entries: 0,
        };
        assert!(cursor.u32().is_err());
    }

    #[test]
    fn a_hostile_length_cannot_seek_backwards_into_the_header() {
        // `count as i64` would wrap this past the start of the file; the
        // bounded reader refuses it instead.
        let mut cursor = Reader {
            inner: Cursor::new(vec![0u8; 16]),
            consumed: 0,
            strings: 0,
            string_entries: 0,
        };
        assert!(cursor.skip(u64::MAX).is_err());
        assert!(cursor.skip(128 * 1024 * 1024 + 1).is_err());
    }

    #[test]
    fn a_declared_base_model_outside_its_own_count_is_not_reported() {
        // Index 99 with count 1 is stale data left by an earlier edit, not a
        // first base model. Truncating the vector would have kept it.
        let described = descriptor(&header(&[
            ("general.architecture", 8, string("llama")),
            ("general.base_model.count", 4, 1u32.to_le_bytes().to_vec()),
            (
                "general.base_model.99.repo_url",
                8,
                string("https://huggingface.co/synthetic-base/stale"),
            ),
        ]))
        .unwrap();
        assert!(described.base_model_repo_urls.is_empty());
    }

    #[test]
    fn skipped_string_arrays_share_one_operation_budget() {
        let mut bytes = 8u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&2u64.to_le_bytes());
        let mut reader = Reader {
            inner: Cursor::new(bytes),
            consumed: 0,
            strings: 0,
            string_entries: MAX_STRING_ENTRIES - 1,
        };
        // Reject before attempting even the first string length in the array.
        assert!(skip_value(&mut reader, 9)
            .unwrap_err()
            .contains("string entry budget"));
        assert_eq!(reader.consumed, 12);
    }

    fn tensor(name: &str, shape: &[u64], bytes: u64) -> (String, Vec<u64>, u64) {
        (name.into(), shape.to_vec(), bytes)
    }

    #[test]
    fn model_facts_size_tensors_by_the_layer_llama_cpp_places_them_on() {
        use fixture::Value;
        let values = vec![
            ("general.architecture".to_string(), Value::Str("qwen3moe")),
            ("qwen3moe.block_count".to_string(), Value::U32(2)),
            ("qwen3moe.context_length".to_string(), Value::U32(32_768)),
            ("qwen3moe.attention.head_count".to_string(), Value::U32(8)),
            (
                "qwen3moe.attention.head_count_kv".to_string(),
                Value::U32s(vec![2, 4]),
            ),
            ("qwen3moe.attention.key_length".to_string(), Value::U32(128)),
            ("qwen3moe.expert_used_count".to_string(), Value::U32(8)),
        ];
        let tensors = vec![
            tensor("token_embd.weight", &[256, 1_000], 4_096),
            tensor("blk.0.attn_q.weight", &[256, 256], 1_024),
            tensor("blk.0.ffn_up_exps.weight", &[256, 64, 8], 8_192),
            tensor("blk.0.ffn_gate_up_exps.weight", &[256, 128, 8], 2_048),
            tensor("blk.0.ffn_up_shexp.weight", &[256, 64], 512),
            tensor("blk.1.ffn_up.weight", &[256, 512], 2_048),
            tensor("blk.1.ffn_down.bias", &[256], 32),
            tensor("output_norm.weight", &[256], 32),
            tensor("position_embd.weight", &[256, 64], 64),
            tensor("token_embd_norm.weight", &[256], 32),
        ];
        let facts = in_temporary_file(&fixture::file(&values, &tensors), read_model_facts).unwrap();
        assert_eq!(facts.block_count, Some(2));
        assert_eq!(facts.context_length, Some(32_768));
        assert_eq!(facts.head_count_kv, Some(PerLayer::Layers(vec![2, 4])));
        assert_eq!(facts.key_length, Some(128));
        assert_eq!(facts.expert_used_count, Some(PerLayer::Uniform(8)));
        assert!(!facts.recurrent_state);
        let bytes = facts.tensors.unwrap();
        assert_eq!(bytes.token_embd, 4_096);
        assert_eq!(bytes.input, 64);
        // The norm tensors are tiny and ride with the output layer.
        assert_eq!(bytes.output, 64);
        assert!(!bytes.has_output_weight);
        assert_eq!(bytes.vocab, Some(1_000));
        assert_eq!(
            bytes.layers,
            vec![
                LayerBytes {
                    experts: 10_240,
                    dense_ffn: 0,
                    other: 1_536,
                },
                LayerBytes {
                    experts: 0,
                    dense_ffn: 2_080,
                    other: 0,
                },
            ]
        );
        assert_eq!(bytes.total(), 18_080);
    }

    #[test]
    fn model_facts_mark_recurrent_keys_and_refuse_an_implausible_tensor_table() {
        use fixture::Value;
        let recurrent = fixture::file(
            &[
                ("general.architecture".to_string(), Value::Str("newhybrid")),
                ("newhybrid.ssm.state_size".to_string(), Value::U32(16)),
            ],
            &[],
        );
        assert!(
            in_temporary_file(&recurrent, read_model_facts)
                .unwrap()
                .recurrent_state
        );
        let long_name = "x".repeat(300);
        let refused = fixture::file(&[], &[tensor(&long_name, &[1], 32)]);
        assert!(in_temporary_file(&refused, read_model_facts).is_err());
        // Data that stops short of a declared tensor leaves sizes unknown
        // instead of guessing them.
        let mut truncated = fixture::file(&[], &[tensor("blk.0.attn_q.weight", &[8], 64)]);
        truncated.truncate(truncated.len() - 64);
        assert_eq!(
            in_temporary_file(&truncated, read_model_facts)
                .unwrap()
                .tensors,
            None
        );
    }
}
