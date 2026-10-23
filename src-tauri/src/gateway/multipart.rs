//! Bounded audio form parsing. Binary uploads stay intact while public model
//! aliases and validated text fields are adapted for the selected session.
use serde_json::{Map, Value};
use std::borrow::Cow;
use std::collections::BTreeSet;

const MAX_PARTS: usize = 32;
const MAX_PART_HEADERS: usize = 8192;
const MAX_TEXT_BYTES: usize = 64 * 1024;

pub(super) struct AudioForm {
    boundary: String,
    file_headers: Vec<u8>,
    file: Vec<u8>,
    pub fields: Map<String, Value>,
}

fn find(bytes: &[u8], needle: &[u8]) -> Option<usize> {
    bytes
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parameters(value: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in value.bytes().enumerate() {
        if escaped {
            escaped = false;
        } else if quoted && byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            quoted = !quoted;
        } else if byte == b';' && !quoted {
            result.push(value[start..index].trim().to_owned());
            start = index + 1;
        }
    }
    if quoted || escaped {
        return Err("malformed multipart parameter".into());
    }
    result.push(value[start..].trim().to_owned());
    Ok(result)
}

fn parameter(parts: &[String], key: &str) -> Result<Option<String>, String> {
    let mut result = None;
    for part in parts.iter().skip(1) {
        let Some((name, value)) = part.split_once('=') else {
            return Err("malformed multipart parameter".into());
        };
        if !name.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        if result.is_some() {
            return Err(format!("duplicate multipart {key}"));
        }
        let value = value.trim();
        result = Some(if let Some(inner) = value.strip_prefix('"') {
            let inner = inner
                .strip_suffix('"')
                .ok_or("malformed quoted parameter")?;
            let mut unescaped = String::new();
            let mut chars = inner.chars();
            while let Some(ch) = chars.next() {
                unescaped.push(if ch == '\\' {
                    chars.next().ok_or("malformed parameter escape")?
                } else {
                    ch
                });
            }
            unescaped
        } else {
            value.to_owned()
        });
    }
    Ok(result)
}

impl AudioForm {
    pub(super) fn from_audio(audio: crate::media::OwnedAudio) -> Self {
        Self {
            boundary: format!("aiolm{}", uuid::Uuid::new_v4().simple()),
            file_headers: format!("Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {}", audio.filename, audio.mime).into_bytes(),
            file: audio.bytes,
            fields: Map::new(),
        }
    }

    pub(super) fn parse(content_type: &str, bytes: &[u8]) -> Result<Self, String> {
        let params = parameters(content_type)?;
        if !params[0].eq_ignore_ascii_case("multipart/form-data") {
            return Err("audio requests require multipart/form-data".into());
        }
        let boundary = parameter(&params, "boundary")?.ok_or("multipart boundary is missing")?;
        if boundary.is_empty()
            || boundary.len() > 70
            || !boundary
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"'()+_,-./:=?".contains(&byte))
        {
            return Err("invalid multipart boundary".into());
        }
        let first = format!("--{boundary}\r\n");
        if !bytes.starts_with(first.as_bytes()) {
            return Err("multipart opening boundary is missing".into());
        }
        let marker = format!("\r\n--{boundary}").into_bytes();
        let mut cursor = first.len();
        let mut fields = Map::new();
        let mut names = BTreeSet::new();
        let mut file = None;
        let mut file_headers = None;
        let mut ended = false;
        for _ in 0..MAX_PARTS {
            let header_end = find(&bytes[cursor..], b"\r\n\r\n")
                .filter(|length| *length <= MAX_PART_HEADERS)
                .ok_or("multipart part headers are missing or too large")?;
            let headers = &bytes[cursor..cursor + header_end];
            let head =
                std::str::from_utf8(headers).map_err(|_| "multipart headers are not UTF-8")?;
            let mut disposition = None;
            for line in head.split("\r\n") {
                let (key, value) = line
                    .split_once(':')
                    .ok_or("malformed multipart part header")?;
                if key.eq_ignore_ascii_case("content-disposition") {
                    if disposition.is_some() {
                        return Err("duplicate multipart disposition".into());
                    }
                    disposition = Some(parameters(value.trim())?);
                }
            }
            let disposition = disposition.ok_or("multipart disposition is missing")?;
            if !disposition[0].eq_ignore_ascii_case("form-data") {
                return Err("multipart disposition must be form-data".into());
            }
            let name = parameter(&disposition, "name")?.ok_or("multipart field name is missing")?;
            if name.is_empty()
                || name.len() > 128
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_[]".contains(&byte))
            {
                return Err("invalid multipart field name".into());
            }
            if !names.insert(name.clone()) && name != "timestamp_granularities[]" {
                return Err(format!("duplicate audio form field: {name}"));
            }
            let payload = cursor + header_end + 4;
            let mut scan = payload;
            let end = loop {
                let offset =
                    find(&bytes[scan..], &marker).ok_or("multipart closing boundary is missing")?;
                let end = scan + offset;
                let suffix = end + marker.len();
                if bytes[suffix..].starts_with(b"\r\n") || bytes[suffix..].starts_with(b"--") {
                    break end;
                }
                scan = suffix;
            };
            let value = &bytes[payload..end];
            if name == "file" {
                if parameter(&disposition, "filename")?.is_none() || value.is_empty() {
                    return Err("audio file must have a filename and nonempty content".into());
                }
                file = Some(value.to_vec());
                file_headers = Some(headers.to_vec());
            } else {
                if parameter(&disposition, "filename")?.is_some() || value.len() > MAX_TEXT_BYTES {
                    return Err("audio form text field is a file or exceeds its size limit".into());
                }
                let text =
                    std::str::from_utf8(value).map_err(|_| "audio form field is not UTF-8")?;
                if name == "timestamp_granularities[]" {
                    fields
                        .entry("timestamp_granularities")
                        .or_insert_with(|| Value::Array(Vec::new()))
                        .as_array_mut()
                        .expect("timestamp field is an array")
                        .push(Value::String(text.to_owned()));
                } else {
                    // Reserve the normalized repeated-field name to avoid a
                    // scalar colliding with the array accepted by the API.
                    if name == "timestamp_granularities" {
                        return Err("use timestamp_granularities[] for timestamp fields".into());
                    }
                    fields.insert(name, Value::String(text.to_owned()));
                }
            }
            cursor = end + marker.len();
            if bytes[cursor..].starts_with(b"--") {
                let tail = &bytes[cursor + 2..];
                if !tail.is_empty() && tail != b"\r\n" {
                    return Err("unexpected data after multipart closing boundary".into());
                }
                ended = true;
                break;
            }
            cursor += 2;
        }
        if !ended {
            return Err("audio form has too many parts".into());
        }
        Ok(Self {
            boundary,
            file: file.ok_or("audio form file is missing")?,
            file_headers: file_headers.ok_or("audio form file is missing")?,
            fields,
        })
    }

    pub(super) fn content_type(&self) -> String {
        format!("multipart/form-data; boundary={}", self.boundary)
    }

    pub(super) fn encode(&self) -> Result<Vec<u8>, String> {
        let boundary = self.boundary.as_bytes();
        let mut body = Vec::new();
        for (name, value) in &self.fields {
            let values = match value {
                Value::Array(values) if name == "timestamp_granularities" => values.as_slice(),
                Value::Array(_) | Value::Object(_) | Value::Null => {
                    return Err("audio form contains an invalid adapted field".into())
                }
                value => std::slice::from_ref(value),
            };
            let field = if name == "timestamp_granularities" {
                "timestamp_granularities[]"
            } else {
                name
            };
            for value in values {
                // Text fields are written from the form itself; only
                // non-string values are rendered as JSON text first.
                let value = value
                    .as_str()
                    .map_or_else(|| Cow::Owned(value.to_string()), Cow::Borrowed);
                if value
                    .as_bytes()
                    .windows(boundary.len())
                    .any(|window| window == boundary)
                {
                    return Err("audio text field contains its multipart boundary".into());
                }
                body.extend_from_slice(b"--");
                body.extend_from_slice(boundary);
                body.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"");
                body.extend_from_slice(field.as_bytes());
                body.extend_from_slice(b"\"\r\n\r\n");
                body.extend_from_slice(value.as_bytes());
                body.extend_from_slice(b"\r\n");
            }
        }
        // Reserve the whole remaining file section before copying the audio, so
        // appending it and the closing boundary needs no further growth.
        body.reserve(2 * boundary.len() + 16 + self.file_headers.len() + self.file.len());
        body.extend_from_slice(b"--");
        body.extend_from_slice(boundary);
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(&self.file_headers);
        body.extend_from_slice(b"\r\n\r\n");
        body.extend_from_slice(&self.file);
        body.extend_from_slice(b"\r\n--");
        body.extend_from_slice(boundary);
        body.extend_from_slice(b"--\r\n");
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(fields: &str, audio: &[u8]) -> Vec<u8> {
        let mut bytes = fields.as_bytes().to_vec();
        bytes.extend_from_slice(b"--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip; sample.wav\"\r\nContent-Type: audio/wav\r\n\r\n");
        bytes.extend_from_slice(audio);
        bytes.extend_from_slice(b"\r\n--test-boundary--\r\n");
        bytes
    }

    #[test]
    fn audio_alias_rewriting_preserves_binary_and_repeated_timestamp_fields() {
        let fields = "--test-boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\npublic@session\r\n--test-boundary\r\nContent-Disposition: form-data; name=\"timestamp_granularities[]\"\r\n\r\nword\r\n--test-boundary\r\nContent-Disposition: form-data; name=\"timestamp_granularities[]\"\r\n\r\nsegment\r\n";
        let audio = b"RIFF\0\xff\xfe\r\n--test-boundary-nearly\0";
        let mut parsed = AudioForm::parse(
            "multipart/form-data; boundary=\"test-boundary\"",
            &form(fields, audio),
        )
        .unwrap();
        assert_eq!(parsed.fields["model"], "public@session");
        parsed
            .fields
            .insert("model".into(), Value::String("private-alias".into()));
        let encoded = parsed.encode().unwrap();
        assert_eq!(
            encoded,
            form(&fields.replace("public@session", "private-alias"), audio)
        );
        let roundtrip = AudioForm::parse(&parsed.content_type(), &encoded).unwrap();
        assert_eq!(roundtrip.file, audio);
        assert_eq!(roundtrip.fields["model"], "private-alias");
        assert_eq!(
            roundtrip.fields["timestamp_granularities"],
            serde_json::json!(["word", "segment"])
        );
    }

    #[test]
    fn adapted_fields_encode_in_key_order_and_invalid_ones_are_refused() {
        let part = |name: &str, value: &str| {
            format!("--test-boundary\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
        };
        let audio = b"\0audio\xff\r\n--test-boundary-nearly";
        let mut adapted = AudioForm::parse(
            "multipart/form-data; boundary=test-boundary",
            &form("", audio),
        )
        .unwrap();
        let encode = |target: &mut AudioForm, fields: Value| {
            target.fields = fields.as_object().unwrap().clone();
            target.encode()
        };
        let stamps = "timestamp_granularities[]";
        let expected = [
            part("language", ""),
            part("prompt", "h\u{e9}llo\r\n--test-boundar"),
            part("seed", "-7"),
            part("stream", "false"),
            part("temperature", "0.25"),
            part(stamps, "word"),
            part(stamps, "1"),
            part(stamps, "null"),
            part(stamps, "[\"segment\"]"),
            part(stamps, "{\"k\":\"v\"}"),
        ]
        .concat();
        assert_eq!(
            encode(
                &mut adapted,
                serde_json::json!({
                    "temperature": 0.25,
                    "timestamp_granularities": ["word", 1, null, ["segment"], {"k": "v"}],
                    "stream": false,
                    "seed": -7,
                    "prompt": "h\u{e9}llo\r\n--test-boundar",
                    "language": "",
                })
            )
            .unwrap(),
            form(&expected, audio)
        );
        assert_eq!(
            encode(
                &mut adapted,
                serde_json::json!({"timestamp_granularities": []})
            )
            .unwrap(),
            form("", audio)
        );
        assert_eq!(
            encode(
                &mut adapted,
                serde_json::json!({"timestamp_granularities": "word"})
            )
            .unwrap(),
            form(&part(stamps, "word"), audio)
        );
        let invalid = "audio form contains an invalid adapted field";
        let contains = "audio text field contains its multipart boundary";
        for (fields, error) in [
            (serde_json::json!({"a": null}), invalid),
            (serde_json::json!({"a": {}}), invalid),
            (serde_json::json!({"a": []}), invalid),
            (serde_json::json!({"a": ["word"]}), invalid),
            (serde_json::json!({"a": "xtest-boundaryx"}), contains),
            (
                serde_json::json!({"a": "test-boundary", "b": null}),
                contains,
            ),
            (
                serde_json::json!({"a": null, "b": "test-boundary"}),
                invalid,
            ),
            (
                serde_json::json!({"timestamp_granularities": ["word", ["test-boundary"]]}),
                contains,
            ),
            (
                serde_json::json!({"a": 1, "timestamp_granularities": {"word": true}}),
                invalid,
            ),
        ] {
            assert_eq!(
                encode(&mut adapted, fields.clone()),
                Err(error.to_string()),
                "{fields}"
            );
        }
    }

    #[test]
    fn ambiguous_truncated_or_non_audio_forms_are_refused() {
        let field =
            "--test-boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nmodel\r\n";
        let duplicate = form(&field.repeat(2), b"audio");
        assert!(
            AudioForm::parse("multipart/form-data; boundary=test-boundary", &duplicate).is_err()
        );
        let valid = form(field, b"audio");
        assert!(AudioForm::parse(
            "multipart/form-data; boundary=test-boundary",
            &valid[..valid.len() - 5]
        )
        .is_err());
        assert!(AudioForm::parse("application/json", &valid).is_err());
        assert!(AudioForm::parse(
            "multipart/form-data; boundary=test-boundary; boundary=other",
            &valid
        )
        .is_err());
        assert!(AudioForm::parse(
            "multipart/form-data; boundary=test-boundary",
            &form("", b"")
        )
        .is_err());
    }
}
