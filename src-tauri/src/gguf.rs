//! Reading the few GGUF header facts the app needs from a model file.
//!
//! Only the metadata block is read, and only until the wanted key is found —
//! `<architecture>.context_length` sits near the front, well before the
//! tokenizer arrays that make up most of a header. Nothing here interprets
//! tensors: this exists so the editor can bound a model's context at what the
//! model was actually trained for instead of an arbitrary constant.

use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// A header cannot be trusted to be well formed; these stop a malformed or
/// hostile file from turning into an unbounded read.
const MAX_KEYS: u64 = 4_096;
const MAX_KEY_BYTES: u64 = 1_024;
const MAX_ARRAY_LEN: u64 = 1 << 24;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ModelMetadata {
    /// Context the model was trained for, when the header states it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// The architecture the header names, for display alongside it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
}

struct Reader<R> {
    inner: R,
}

impl<R: Read + Seek> Reader<R> {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
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
        self.inner
            .seek(SeekFrom::Current(count as i64))
            .map_err(|error| format!("unreadable GGUF header: {error}"))?;
        Ok(())
    }

    fn string(&mut self) -> Result<String, String> {
        let length = self.u64()?;
        if length > MAX_KEY_BYTES {
            self.skip(length)?;
            return Ok(String::new());
        }
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
                return reader.skip(width.saturating_mul(count));
            }
            if element != 8 {
                return Err(format!("unsupported GGUF array element type {element}"));
            }
            // Strings are individually sized, so the only way past them is
            // through them.
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

pub fn read_metadata(path: &Path) -> Result<ModelMetadata, String> {
    let file = File::open(path).map_err(|error| format!("cannot open the model: {error}"))?;
    let mut reader = Reader {
        inner: BufReader::new(file),
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

    fn read(bytes: &[u8]) -> Result<ModelMetadata, String> {
        let directory = std::env::temp_dir().join(format!("aiolm-gguf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("model.gguf");
        File::create(&path).unwrap().write_all(bytes).unwrap();
        let result = read_metadata(&path);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        result
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
    fn a_truncated_value_is_an_error_not_a_silent_zero() {
        let mut cursor = Reader {
            inner: Cursor::new(vec![0u8; 2]),
        };
        assert!(cursor.u32().is_err());
    }
}
