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

const PRIVATE_OPTIONS: &[&str] = &[
    "-m",
    "--model",
    "-mu",
    "--model-url",
    "-md",
    "--model-draft",
    "--spec-draft-model",
    "-mm",
    "--mmproj",
    "-mmu",
    "--mmproj-url",
    "-hf",
    "-hfr",
    "--hf-repo",
    "-hff",
    "--hf-file",
    "-hft",
    "--hf-token",
    "--lora",
    "--lora-scaled",
    "--control-vector",
    "--control-vector-scaled",
    "--grammar-file",
    "-jf",
    "--json-schema-file",
    "--chat-template-file",
    "-lcs",
    "--lookup-cache-static",
    "-lcd",
    "--lookup-cache-dynamic",
    "--log-file",
    "--log-prompts-dir",
    "--slot-save-path",
    "--media-path",
    "--models-dir",
    "--models-preset",
    "--video-ffmpeg-dir",
    "--ui-config-file",
    "--webui-config-file",
    "--mcp-servers-config",
    "--api-key",
    "--api-key-file",
    "--ssl-key-file",
    "--ssl-cert-file",
    "--host",
    "--port",
    "--path",
    "--api-prefix",
    "-a",
    "--alias",
    "--served-model-name",
    "--embedding-model",
    "--draft-model",
    "--adapter-path",
    "--lora-modules",
    "--speculative-config",
    "--download-dir",
    "--tokenizer",
    "--chat-template",
    "--model-loader-extra-config",
    "-r",
    "--reverse-prompt",
];

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

fn strip_ascii_suffix<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let start = text.len().checked_sub(suffix.len())?;
    text.get(start..)?
        .eq_ignore_ascii_case(suffix)
        .then(|| &text[..start])
}

fn secret_option(name: &str) -> bool {
    let name = name
        .strip_prefix("--")
        .or_else(|| name.strip_prefix('-'))
        .unwrap_or(name);
    let stem = strip_ascii_suffix(name, "-file")
        .or_else(|| strip_ascii_suffix(name, "_file"))
        .unwrap_or(name);
    [
        "api-key",
        "api_key",
        "apikey",
        "key",
        "token",
        "secret",
        "password",
        "passphrase",
        "credential",
        "authorization",
        "auth",
    ]
    .iter()
    .any(|suffix| {
        strip_ascii_suffix(stem, suffix)
            .is_some_and(|prefix| prefix.is_empty() || prefix.ends_with(['-', '_']))
    })
}

fn public_argument(token: &Value) -> bool {
    token.as_str().is_some_and(|token| {
        let name = token.split('=').next().unwrap_or(token);
        safe_label(token, 128) && !PRIVATE_OPTIONS.contains(&name) && !secret_option(name)
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
                properties.get(key).is_some_and(|shape| {
                    if key == "effective_args"
                        && !value.is_null()
                        && !value.as_array().is_some_and(|args| {
                            args.len() <= 256 && args.iter().all(public_argument)
                        })
                    {
                        return false;
                    }
                    public_value(value, shape, schema)
                })
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
        }) && value.get("description_md").is_none_or(Value::is_string)
            && public_value(benchmark, schema, schema)
    } else {
        public_value(value, schema, schema)
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
            "execution": {"effective_args": ["--threads", "8", "--flash-attn=on"]}
        }, "description_md": "Reviewed [source](https://example.invalid)."})).is_ok());
    }

    #[test]
    fn private_fields_are_rejected_at_every_depth() {
        for private in [
            json!({"local_fingerprint": "synthetic"}),
            json!({"model": {"recorded_model_label": "synthetic"}}),
            json!({"measurements": {"rows": [{"error": "private diagnostics"}]}}),
            json!({"environment": {"cpu": {"serial": "synthetic"}}}),
        ] {
            assert!(validate(&private).is_err(), "{private}");
        }
        assert!(validate(&json!({"benchmark": {}, "local_fingerprint": "synthetic"})).is_err());
    }

    #[test]
    fn every_private_runtime_option_is_rejected() {
        for option in PRIVATE_OPTIONS {
            for args in [
                json!([option, "synthetic"]),
                json!([format!("{option}=synthetic")]),
            ] {
                assert!(
                    validate(&json!({"execution": {"effective_args": args}})).is_err(),
                    "{option}"
                );
            }
        }
    }

    #[test]
    fn secret_option_shapes_and_unsafe_argument_tokens_are_rejected() {
        for token in [
            "--custom-api-key",
            "--provider_token=synthetic",
            "--db-password-file",
            "--auth",
            "--key",
            "--secret",
            "--passphrase",
            "--credential",
            "--authorization",
            "/synthetic/model",
            "C:\\synthetic\\model",
            "https://example.invalid",
            "user@example.invalid",
            "line\nbreak",
            "",
        ] {
            assert!(
                validate(&json!({"execution": {"effective_args": [token]}})).is_err(),
                "{token}"
            );
        }
        assert!(validate(&json!({"execution": {"effective_args": vec!["x"; 257]}})).is_err());
        assert!(validate(&json!({"execution": {"effective_args": ["x".repeat(129)]}})).is_err());
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
            assert!(validate(&private).is_err(), "{private}");
        }
    }
}
