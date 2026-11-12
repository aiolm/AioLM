use super::*;
use serde_json::json;

/// What the catalog emitted before it was mapped onto the common schema.
fn legacy_arguments(spec: &OptionSpec, value: &Value) -> Vec<String> {
    let flag = spec.flag.unwrap().to_owned();
    match spec.kind {
        OptionKind::Flag => {
            if value.as_bool() == Some(true) {
                vec![flag]
            } else {
                vec![]
            }
        }
        OptionKind::Toggle => {
            if value.as_bool() == Some(true) {
                vec![flag]
            } else {
                vec![format!("--no-{}", &flag[2..])]
            }
        }
        OptionKind::Json => vec![flag, value.to_string()],
        _ => vec![
            flag,
            match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            },
        ],
    }
}

fn samples(spec: &OptionSpec) -> Vec<Value> {
    match spec.kind {
        OptionKind::Integer {
            choices: Some(choices),
            ..
        } => choices.iter().copied().map(Value::from).collect(),
        OptionKind::Integer {
            min,
            max,
            sentinel_values,
            ..
        } => {
            let mut values = vec![json!(min), json!(max)];
            values.extend(
                sentinel_values
                    .into_iter()
                    .flatten()
                    .copied()
                    .map(Value::from),
            );
            values
        }
        OptionKind::Number {
            min,
            max,
            min_exclusive,
            max_exclusive,
        } => {
            let mut values = vec![json!((min + max) / 2.0)];
            if !min_exclusive {
                values.push(json!(min));
            }
            if !max_exclusive {
                values.push(json!(max));
            }
            values
        }
        OptionKind::Flag | OptionKind::Toggle => vec![json!(true), json!(false)],
        OptionKind::Choice { choices } => choices.iter().map(|c| json!(c)).collect(),
        OptionKind::Text { .. } => vec![json!("synthetic text"), json!("한글 값")],
        OptionKind::Path => vec![json!("/synthetic path/file")],
        OptionKind::Json => vec![json!({"synthetic": {"nested": [1, 2.5]}})],
    }
}

#[test]
fn builtin_catalogs_produce_identical_arguments_through_the_common_resolver() {
    let mut checked = 0;
    for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
        for spec in options::schema(provider)
            .iter()
            .filter(|spec| spec.target == OptionTarget::Launch)
        {
            for value in samples(spec) {
                assert_eq!(
                    spec_arguments(spec, &value),
                    legacy_arguments(spec, &value),
                    "{} {value}",
                    spec.key
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 50, "{checked}");
}

#[test]
fn catalog_and_manifest_options_keep_their_facts_as_adapter_metadata() {
    let source = adapter_source("custom.example", "manifest-v1");
    let toggle = from_external(
        &serde_json::from_value(
            json!({"key":"cache","flag":"--cache","target":"launch","kind":{"type":"toggle"}}),
        )
        .unwrap(),
        &source,
    )
    .unwrap();
    assert_eq!(toggle.spellings.len(), 2);
    assert_eq!(toggle.spellings[1].flag, "--no-cache");
    assert_eq!(toggle.spellings[1].polarity, Some(false));
    let request = from_external(
        &serde_json::from_value(json!({"key":"temperature","target":"request","kind":{"type":"number","min":0,"max":2}}))
            .unwrap(),
        &source,
    )
    .unwrap();
    assert_eq!(request.target, Target::Request);
    assert_eq!(
        request.request_field.supported().map(String::as_str),
        Some("temperature")
    );
    assert!(request.spellings.is_empty());
    // A manifest kind this app does not know is not converted at all.
    assert!(from_external(
        &serde_json::from_value(
            json!({"key":"x","flag":"--x","target":"launch","kind":{"type":"future"}})
        )
        .unwrap(),
        &source
    )
    .is_none());
}
