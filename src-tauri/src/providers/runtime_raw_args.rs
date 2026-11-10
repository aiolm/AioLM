//! Explicit, literal arguments for options not described by a custom runtime.
//! Described options use the schema editor/importer so aliases cannot duplicate
//! structured values or replace app-owned launch bindings.
use super::runtime_options::{ManagedBinding, OptionSchema};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn validated(
    schema: &OptionSchema,
    known_flags: &BTreeMap<String, Option<ManagedBinding>>,
    values: &Map<String, Value>,
) -> Result<Vec<String>, String> {
    let Some(raw) = values.get("extra_args") else {
        return Ok(Vec::new());
    };
    let raw = raw
        .as_array()
        .filter(|args| args.len() <= 128)
        .ok_or("additional arguments must be a list of at most 128 text tokens")?;
    let mut flags = BTreeSet::new();
    let mut result = Vec::with_capacity(raw.len());
    for value in raw {
        let token = value
            .as_str()
            .filter(|token| {
                !token.trim().is_empty() && token.len() <= 32_768 && !token.contains('\0')
            })
            .ok_or("additional arguments must contain non-empty text tokens")?;
        if token == "--" || result.is_empty() && !token.starts_with('-') {
            return Err("additional arguments must start with an option, not a command or positional argument".into());
        }
        // Negative numbers are values, not short option bundles.
        if token.starts_with('-') && token.parse::<f64>().is_err() {
            let flag = token.split_once('=').map_or(token, |(flag, _)| flag);
            let matches = |known: &str| {
                flag == known
                    || known.len() == 2
                        && known.starts_with('-')
                        && !known.starts_with("--")
                        && flag.starts_with(known)
            };
            if known_flags
                .iter()
                .any(|(known, binding)| binding.is_some() && matches(known))
                || schema.options.iter().any(|option| {
                    option.managed.is_some()
                        && option
                            .spellings
                            .iter()
                            .any(|spelling| matches(&spelling.flag))
                })
            {
                return Err(format!(
                    "{flag} is managed by AioLM; remove it from additional arguments"
                ));
            }
            if known_flags.keys().any(|known| matches(known))
                || schema.options.iter().any(|option| {
                    option
                        .spellings
                        .iter()
                        .any(|spelling| matches(&spelling.flag))
                })
            {
                return Err(format!("{flag} already has an option control; use that control or command import instead of additional arguments"));
            }
            if !flags.insert(flag) {
                return Err(format!("{flag} is duplicated in additional arguments"));
            }
        }
        result.push(token.to_owned());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::runtime_options::SchemaBinding;
    use serde_json::json;

    fn schema() -> OptionSchema {
        OptionSchema {
            schema_version: 1,
            binding: SchemaBinding {
                engine: "custom.synthetic".into(),
                runtime: "local".into(),
                fingerprint: "test".into(),
            },
            options: vec![],
            constraints: vec![],
            raw_help: vec![],
            end_of_options: Default::default(),
        }
    }

    #[test]
    fn literal_values_keep_spaces_and_binding_like_text() {
        let values = json!({"extra_args": ["--experimental-cache", "path with spaces/{model}", "--offset=-4"]});
        assert_eq!(
            validated(&schema(), &BTreeMap::new(), values.as_object().unwrap()).unwrap(),
            [
                "--experimental-cache",
                "path with spaces/{model}",
                "--offset=-4"
            ]
        );
    }

    #[test]
    fn refuses_owned_aliases_joined_short_flags_and_repeated_unknown_flags() {
        let managed = BTreeMap::from([
            ("--weights".into(), Some(ManagedBinding::Model)),
            ("-m".into(), Some(ManagedBinding::Model)),
        ]);
        for args in [
            json!(["--weights=other.gguf"]),
            json!(["-mother.gguf"]),
            json!(["--fresh", "1", "--fresh=2"]),
        ] {
            let values = json!({"extra_args":args});
            assert!(validated(&schema(), &managed, values.as_object().unwrap()).is_err());
        }
    }
}
