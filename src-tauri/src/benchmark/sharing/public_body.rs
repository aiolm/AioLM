//! Privacy checks for the exact reviewed publication bytes. Schema completeness
//! remains the service's responsibility; native signing never rewrites a body.

use super::errors::SharingError;
use serde_json::Value;
use std::sync::LazyLock;

// Duplicate keys would let one parser hide a private field that is still present
// in the exact bytes sent to the service. Reject them throughout the JSON tree.
pub(crate) fn parse(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    struct UniqueValue(Value);
    impl<'de> serde::Deserialize<'de> for UniqueValue {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = UniqueValue;
                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("JSON without duplicate object keys")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Self::Value, A::Error> {
                    let mut fields = serde_json::Map::new();
                    while let Some(key) = map.next_key::<String>()? {
                        if fields.contains_key(&key) {
                            return Err(serde::de::Error::custom("duplicate publication field"));
                        }
                        fields.insert(key, map.next_value::<UniqueValue>()?.0);
                    }
                    Ok(UniqueValue(Value::Object(fields)))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut seq: A,
                ) -> Result<Self::Value, A::Error> {
                    let mut values = Vec::new();
                    while let Some(value) = seq.next_element::<UniqueValue>()? {
                        values.push(value.0);
                    }
                    Ok(UniqueValue(Value::Array(values)))
                }
                fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                    Ok(UniqueValue(Value::String(value.to_owned())))
                }
                fn visit_string<E: serde::de::Error>(
                    self,
                    value: String,
                ) -> Result<Self::Value, E> {
                    Ok(UniqueValue(Value::String(value)))
                }
                fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                    Ok(UniqueValue(Value::Bool(value)))
                }
                fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                    Ok(UniqueValue(Value::Number(value.into())))
                }
                fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                    Ok(UniqueValue(Value::Number(value.into())))
                }
                fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                    serde_json::Number::from_f64(value)
                        .map(|value| UniqueValue(Value::Number(value)))
                        .ok_or_else(|| E::custom("invalid publication number"))
                }
                fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                    Ok(UniqueValue(Value::Null))
                }
            }
            deserializer.deserialize_any(Visitor)
        }
    }
    serde_json::from_slice::<UniqueValue>(bytes).map(|value| value.0)
}

fn safe_label(text: &str, limit: usize) -> bool {
    !text.is_empty()
        && text.encode_utf16().count() <= limit
        && !text.chars().any(|c| {
            matches!(
                c,
                '\\' | '/' | ':' | '@' | '\u{0000}'..='\u{001f}' | '\u{007f}'
            )
        })
}

fn repository(text: &str) -> bool {
    let mut parts = text.split('/');
    let component = |part: &str| {
        !part.is_empty()
            && part.len() <= 128
            && part.as_bytes()[0].is_ascii_alphanumeric()
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    };
    !text.contains("..")
        && parts.next().is_some_and(component)
        && parts.next().is_some_and(component)
        && parts.next().is_none()
}

fn artifact(text: &str) -> bool {
    let (directories, filename) = text.rsplit_once('/').unwrap_or(("", text));
    let component = |part: &str| {
        !part.is_empty()
            && part.as_bytes()[0].is_ascii_alphanumeric()
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b' '))
    };
    text.encode_utf16().count() <= 512
        && (directories.is_empty() && !text.starts_with('/')
            || directories
                .split('/')
                .all(|part| part.len() <= 128 && component(part)))
        && component(filename)
        && filename.len() > 5
        && filename[filename.len() - 5..].eq_ignore_ascii_case(".gguf")
}

fn type_matches(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        _ => false,
    }
}

// Reuse the public contract's property tree rather than keeping a second list
// of fields that may cross the native privacy boundary. Required fields and
// measurement semantics are still validated by the service.
fn public_value(value: &Value, shape: &Value, schema: &Value) -> bool {
    if let Some(reference) = shape.get("$ref").and_then(Value::as_str) {
        return reference
            .strip_prefix('#')
            .and_then(|path| schema.pointer(path))
            .is_some_and(|shape| public_value(value, shape, schema));
    }
    if let Some(choices) = shape.get("oneOf").and_then(Value::as_array) {
        return choices
            .iter()
            .any(|shape| public_value(value, shape, schema));
    }
    if let Some(kind) = shape.get("type") {
        let matches = match kind {
            Value::String(kind) => type_matches(value, kind),
            Value::Array(kinds) => kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| type_matches(value, kind)),
            _ => false,
        };
        if !matches {
            return false;
        }
    }
    if let Some(allowed) = shape.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return false;
        }
    }
    if let Some(expected) = shape.get("const") {
        if expected != value {
            return false;
        }
    }
    match value {
        Value::Object(fields) => {
            let Some(properties) = shape.get("properties").and_then(Value::as_object) else {
                return false;
            };
            fields.iter().all(|(key, value)| {
                properties
                    .get(key)
                    .is_some_and(|shape| public_value(value, shape, schema))
            })
        }
        Value::Array(values) => {
            shape
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_none_or(|limit| values.len() as u64 <= limit)
                && shape.get("items").is_some_and(|items| {
                    values
                        .iter()
                        .all(|value| public_value(value, items, schema))
                })
        }
        Value::String(text) => {
            let limit = shape
                .get("maxLength")
                .and_then(Value::as_u64)
                .unwrap_or(256) as usize;
            if text.encode_utf16().count() > limit {
                return false;
            }
            match shape.get("pattern").and_then(Value::as_str) {
                Some(pattern) if pattern.contains("(?!.*\\.\\.)") => repository(text),
                Some(pattern) if pattern.ends_with("[gG][gG][uU][fF]$") => artifact(text),
                Some("^[a-f0-9]{32}$") => {
                    text.len() == 32
                        && text
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                }
                Some("^[a-f0-9]{40}$") => {
                    text.len() == 40
                        && text
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                }
                Some("^[a-f0-9]{64}$") => {
                    text.len() == 64
                        && text
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                }
                Some("^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$") => {
                    !text.is_empty()
                        && text.len() <= 64
                        && text.as_bytes()[0].is_ascii_alphanumeric()
                        && text
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
                }
                Some(pattern) if pattern.starts_with("^(?!-)") => {
                    !text.starts_with('-') && safe_label(text, limit)
                }
                _ => safe_label(text, limit),
            }
        }
        _ => true,
    }
}

pub(crate) fn validate(value: &Value) -> Result<(), SharingError> {
    static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/benchmark-contracts/schema/public-benchmark.schema.json"
        ))
        .expect("the bundled public benchmark schema is valid JSON")
    });
    let schema = &*SCHEMA;
    let accepted = if let Some(benchmark) = value.get("benchmark") {
        value.as_object().is_some_and(|root| {
            root.keys()
                .all(|key| matches!(key.as_str(), "benchmark" | "description_md"))
        }) && value.get("description_md").is_some_and(Value::is_string)
            && public_value(benchmark, schema, schema)
    } else {
        false
    };
    if accepted {
        Ok(())
    } else {
        Err(SharingError::binding_conflict_msg("The publication body contains private or unsupported public fields. Review a new public snapshot before publishing."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn duplicate_keys_cannot_hide_private_bytes() {
        for body in [
            br#"{"local_fingerprint":"synthetic","local_fingerprint":null}"#.as_slice(),
            br#"{"model":{"recorded_model_label":"synthetic"},"model":{}}"#.as_slice(),
            br#"{"execution":{"effective_args":["--api-key","synthetic"],"effective_args":[]}}"#
                .as_slice(),
        ] {
            assert!(parse(body).is_err());
        }
        assert!(parse(
            br#"{"submission_id":"synthetic","execution":{"effective_args":["--threads","8"]}}"#
        )
        .is_ok());
    }

    #[test]
    fn reviewed_public_body_and_repository_artifact_are_accepted() {
        assert!(validate(&json!({"benchmark": {
            "submission_id": "123e4567-e89b-42d3-a456-000000000001",
            "model": {"metadata": {"repository": "example/model", "artifact": "weights/model.gguf", "base_models": ["example/base"]}},
            "execution": {"settings": [{"target":"launch","scope":[],"name":"threads","value":8,"unit":"threads","role":null}]}
        }, "description_md": "Reviewed [source](https://example.invalid)."})).is_ok());
    }

    #[test]
    fn private_fields_are_rejected_at_every_depth() {
        for private in [
            json!({"local_fingerprint": "synthetic"}),
            json!({"model": {"recorded_model_label": "synthetic"}}),
            json!({"measurements": {"rows": [{"error": "private diagnostics"}]}}),
            json!({"environment": {"cpu": {"serial": "synthetic"}}}),
            json!({"execution": {"effective_args": ["--threads", "8"]}}),
        ] {
            assert!(
                validate(&json!({"benchmark": private, "description_md": ""})).is_err(),
                "{private}"
            );
        }
        assert!(validate(&json!({"benchmark": {}, "local_fingerprint": "synthetic"})).is_err());
    }

    #[test]
    fn reviewed_cold_prompt_body_round_trip_preserves_nonce_and_dispatched_hashes() {
        let body = json!({"benchmark": {
            "schema_version": 4,
            "method": {"id": "openai-chat-serving", "version": 5},
            "workload": {
                "corpus": "novel_en", "corpus_version": 2,
                "inputs": [{"bytes": 256, "sha256": "a".repeat(64)}],
                "max_output_tokens": 128, "concurrencies": [2], "repetitions": 1,
                "warmup": false, "request_usage": false, "cache_policy": "cold_prompt",
                "prompt_nonce": "0123456789abcdef0123456789abcdef"
            },
            "execution": {"topology": "attached", "memory_scope": "unavailable",
                "settings": crate::benchmark::provenance::common_request_settings(128, false)},
            "measurements": {"status": "complete", "rows": [{
                "input_bytes": 256, "max_output_tokens": 128, "concurrency": 2,
                "repetition": 1, "input_sha256_by_request": ["a".repeat(64), "b".repeat(64)],
                "prefill_tokens_per_second": null, "decode_tokens_per_second": null, "tpot_ms": null
            }]}
        }, "description_md": "Reviewed benchmark."});
        let encoded = serde_json::to_vec(&body).unwrap();
        let reviewed = parse(&encoded).unwrap();
        validate(&reviewed).unwrap();
        assert_eq!(reviewed, body);
        assert_eq!(serde_json::to_vec(&reviewed).unwrap(), encoded);
        for nonce in [
            "a".repeat(31),
            "a".repeat(33),
            "A".repeat(32),
            "g".repeat(32),
        ] {
            let mut invalid = body.clone();
            invalid["benchmark"]["workload"]["prompt_nonce"] = json!(nonce);
            assert!(validate(&invalid).is_err());
        }
        for hashes in [
            json!(["a".repeat(63)]),
            json!(["A".repeat(64)]),
            json!(["C:\\private"]),
            json!(vec!["a".repeat(64); 65]),
        ] {
            let mut invalid = body.clone();
            invalid["benchmark"]["measurements"]["rows"][0]["input_sha256_by_request"] = hashes;
            assert!(validate(&invalid).is_err());
        }
        let mut private = body;
        private["benchmark"]["workload"]["inputs"][0]["text"] = json!("private prompt");
        assert!(validate(&private).is_err());
    }

    #[test]
    fn private_labels_and_repository_paths_are_rejected() {
        for private in [
            json!({"app_version": "/synthetic/private"}),
            json!({"runtime": {"version": "version\nprivate diagnostics"}}),
            json!({"model": {"metadata": {"repository": "../private"}}}),
            json!({"model": {"metadata": {"artifact": "/synthetic/model.gguf"}}}),
            json!({"model": {"source": {"repository": "C:\\synthetic"}}}),
        ] {
            assert!(
                validate(&json!({"benchmark": private, "description_md": ""})).is_err(),
                "{private}"
            );
        }
    }
}
