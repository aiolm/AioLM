//! Reading the few GGUF header facts the app needs from a model file.
//!
//! Only the metadata block is read, and only until the wanted key is found —
//! `<architecture>.context_length` sits near the front, well before the
//! tokenizer arrays that make up most of a header. Nothing here interprets
//! tensors: this exists so the editor can bound a model's context at what the
//! model was actually trained for instead of an arbitrary constant.
//!
//! [`read_descriptor`] reads the `general.*` block the same bounded way, for
//! describing how a model was packaged. Key names and their meanings follow the
//! GGUF specification (`ggml/docs/gguf.md`).

use serde::Serialize;
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
    /// Context the model was trained for, when the header states it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// The architecture the header names, for display alongside it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
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
        _ => Err(format!("unsupported GGUF value type {kind}")),
    }
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
    let _tensors = reader.u64()?;
    let keys = reader.u64()?;
    if keys > MAX_KEYS {
        return Err("GGUF header declares an implausible key count".into());
    }
    Ok((reader, keys))
}

pub fn read_metadata(path: &Path) -> Result<ModelMetadata, String> {
    let (mut reader, keys) = open_header(path)?;
    let mut metadata = ModelMetadata::default();
    for _ in 0..keys {
        let key = reader.string()?;
        let kind = reader.u32()?;
        if key == "general.architecture" {
            if kind == 8 {
                metadata.architecture = Some(reader.string()?);
            } else {
                skip_value(&mut reader, kind)?;
            }
            continue;
        }
        if key.ends_with(".context_length") {
            metadata.context_length = read_unsigned(&mut reader, kind)?.filter(|value| *value > 0);
            // The architecture is written before it, so everything wanted is in
            // hand and the tokenizer arrays behind this can stay unread.
            if metadata.architecture.is_some() {
                break;
            }
            continue;
        }
        skip_value(&mut reader, kind)?;
    }
    Ok(metadata)
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
}
