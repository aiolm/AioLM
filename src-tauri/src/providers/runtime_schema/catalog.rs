use super::*;

pub(crate) fn adapter_source(engine: &str, revision: &str) -> Source {
    Source::Adapter {
        id: engine.into(),
        revision: revision.into(),
    }
}

pub(crate) fn documented<T>(value: T, source: &Source) -> Fact<T> {
    Fact {
        value: Some(value),
        certainty: Certainty::Documented,
        source: Some(source.clone()),
    }
}

pub(crate) fn blank(key: &str, group: &str, target: Target) -> OptionDefinition {
    OptionDefinition {
        key: key.into(),
        scope: Vec::new(),
        spellings: Vec::new(),
        position: None,
        kind: Fact::default(),
        arity: Fact::default(),
        repeatable: Fact::default(),
        choices: Fact::default(),
        range: Fact::default(),
        unit: Fact::default(),
        runtime_default: Fact::default(),
        group: group.into(),
        help: String::new(),
        target,
        request_field: Fact::default(),
        restart_required: Fact::default(),
        sensitive: Fact::default(),
        local_path: Fact::default(),
        benchmark_public: Fact::default(),
        benchmark_name: Fact::default(),
        benchmark_role: Fact::default(),
        managed: None,
        raw_spans: Vec::new(),
    }
}

/// Shared shape of catalog and manifest kinds.
enum CompatKind {
    Integer(f64, f64),
    Number(f64, f64),
    Flag,
    Toggle,
    Choice(Vec<String>),
    Text,
    Path,
    Json,
}

fn compat_definition(
    key: &str,
    group: &str,
    flag: Option<&str>,
    request: bool,
    kind: CompatKind,
    runtime_default: Option<&str>,
    source: &Source,
) -> OptionDefinition {
    let mut option = blank(
        key,
        group,
        if request {
            Target::Request
        } else {
            Target::Launch
        },
    );
    if request {
        option.request_field = documented(key.to_owned(), source);
    } else if let Some(flag) = flag {
        option.spellings.push(Spelling {
            flag: flag.into(),
            style: ValueStyle::Separate,
            polarity: None,
        });
    }
    let one = Arity {
        min: 1,
        max: Some(1),
    };
    let (value_kind, arity) = match &kind {
        CompatKind::Integer(..) => (ValueKind::Integer, one),
        CompatKind::Number(..) => (ValueKind::Number, one),
        CompatKind::Flag | CompatKind::Toggle => (
            ValueKind::Boolean,
            Arity {
                min: 0,
                max: Some(0),
            },
        ),
        CompatKind::Json => (ValueKind::Json, one),
        CompatKind::Choice(_) | CompatKind::Text | CompatKind::Path => (ValueKind::Text, one),
    };
    option.kind = documented(value_kind, source);
    option.arity = documented(arity, source);
    match kind {
        CompatKind::Integer(min, max) | CompatKind::Number(min, max) => {
            option.range = documented(
                NumericRange {
                    min: Some(min),
                    max: Some(max),
                    min_exclusive: false,
                    max_exclusive: false,
                    sentinel_values: Vec::new(),
                },
                source,
            );
        }
        // The catalog documents that a false flag emits nothing.
        CompatKind::Flag => {
            option.runtime_default = documented(
                RuntimeDefault {
                    literal: Value::Bool(false),
                },
                source,
            );
        }
        CompatKind::Toggle => {
            if let Some(flag) = flag.filter(|_| !request) {
                option.spellings = vec![
                    Spelling {
                        flag: flag.into(),
                        style: ValueStyle::Separate,
                        polarity: Some(true),
                    },
                    Spelling {
                        flag: format!("--no-{}", flag.trim_start_matches('-')),
                        style: ValueStyle::Separate,
                        polarity: Some(false),
                    },
                ];
            }
        }
        CompatKind::Choice(choices) => {
            option.choices = documented(choices.into_iter().map(Value::String).collect(), source);
        }
        CompatKind::Path => option.local_path = documented(true, source),
        CompatKind::Text | CompatKind::Json => {}
    }
    if let Some(text) = runtime_default.filter(|_| option.runtime_default.value.is_none()) {
        option.runtime_default = documented(
            RuntimeDefault {
                literal: Value::String(text.into()),
            },
            source,
        );
    }
    option
}

/// A built-in catalog option as a common schema option.
pub fn from_spec(spec: &OptionSpec, source: &Source) -> OptionDefinition {
    let kind = match spec.kind {
        OptionKind::Integer { min, max, .. } => CompatKind::Integer(min as f64, max as f64),
        OptionKind::Number { min, max, .. } => CompatKind::Number(min, max),
        OptionKind::Flag => CompatKind::Flag,
        OptionKind::Toggle => CompatKind::Toggle,
        OptionKind::Choice { choices } => {
            CompatKind::Choice(choices.iter().map(|c| (*c).to_owned()).collect())
        }
        OptionKind::Text { .. } => CompatKind::Text,
        OptionKind::Path => CompatKind::Path,
        OptionKind::Json => CompatKind::Json,
    };
    let mut definition = compat_definition(
        spec.key,
        spec.group,
        spec.flag,
        spec.target == OptionTarget::Request,
        kind,
        spec.runtime_default,
        source,
    );
    if let OptionKind::Number {
        min_exclusive,
        max_exclusive,
        ..
    } = spec.kind
    {
        if let Some(range) = &mut definition.range.value {
            range.min_exclusive = min_exclusive;
            range.max_exclusive = max_exclusive;
        }
    }
    if let OptionKind::Integer {
        choices: Some(choices),
        ..
    } = spec.kind
    {
        definition.choices = documented(
            choices.iter().map(|value| Value::from(*value)).collect(),
            source,
        );
    }
    if let OptionKind::Integer {
        sentinel_values: Some(values),
        ..
    } = spec.kind
    {
        if let Some(range) = &mut definition.range.value {
            range.sentinel_values = values.iter().map(|value| *value as f64).collect();
        }
    }
    definition.help = spec.help.unwrap_or_default().into();
    definition
}

/// A manifest v1 option as a common schema option.
pub fn from_external(option: &ExternalOption, source: &Source) -> Option<OptionDefinition> {
    registry::validate_kind(&option.kind).ok()?;
    let number = |name: &str| option.kind[name].as_f64();
    let kind = match option.kind["type"].as_str()? {
        "integer" => CompatKind::Integer(number("min")?, number("max")?),
        "number" => CompatKind::Number(number("min")?, number("max")?),
        "flag" => CompatKind::Flag,
        "toggle" => CompatKind::Toggle,
        "choice" => CompatKind::Choice(
            option.kind["choices"]
                .as_array()?
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        "text" => CompatKind::Text,
        "path" => CompatKind::Path,
        "json" => CompatKind::Json,
        _ => return None,
    };
    let mut definition = compat_definition(
        &option.key,
        &option.group,
        option.flag.as_deref(),
        option.target == "request",
        kind,
        option.runtime_default.as_deref(),
        source,
    );
    if matches!(option.kind["type"].as_str(), Some("integer" | "number")) {
        definition.range = documented(registry::numeric_range(&option.kind)?, source);
        if let Some(choices) = option.kind.get("choices") {
            definition.choices = documented(choices.as_array()?.clone(), source);
        }
    }
    if let Some(scope) = &option.scope {
        definition.scope = scope.clone();
    }
    Some(definition)
}

/// The argv a valid built-in catalog value produces, through the common
/// resolver. Invalid values produce nothing; callers validate first.
pub fn spec_arguments(spec: &OptionSpec, value: &Value) -> Vec<String> {
    let source = adapter_source("builtin.catalog", "1");
    from_spec(spec, &source)
        .resolve_one(&None, std::slice::from_ref(value))
        .unwrap_or_default()
}

/// The selected runtime's explicit option metadata, as its effective schema
/// applies it, for reviewing a discovery before it is accepted.
pub fn selected_metadata(
    cfg: &AppConfig,
) -> Result<Option<(OptionMetadata, bool)>, crate::error::AppError> {
    Ok(compat(&Selected::from_config(cfg)?)?.metadata)
}

fn adapter_label(option: &OptionDefinition) -> String {
    [
        &option.kind.source,
        &option.arity.source,
        &option.request_field.source,
    ]
    .into_iter()
    .flatten()
    .find_map(|source| match source {
        Source::Adapter { id, revision } => Some(format!("{id} {revision}")),
        _ => None,
    })
    .unwrap_or_default()
}

/// Differences between a catalog/manifest option and the accepted help row
/// it shadows (matched by a shared spelling or key). The declaration stays
/// in effect for its legacy key; only a value count it would serialize
/// outside the observed one blocks a saved value.
pub(super) fn declared_differences(
    declared: &OptionDefinition,
    observed: &OptionDefinition,
) -> Vec<FactConflict> {
    let flag = declared
        .spellings
        .iter()
        .find(|s| observed.spellings.iter().any(|o| o.flag == s.flag))
        .or(observed.spellings.first())
        .map(|s| s.flag.clone())
        .unwrap_or_default();
    let conflict = |field: &str, seen: Value, said: Value, blocking: bool| FactConflict {
        key: declared.key.clone(),
        flag: flag.clone(),
        positional: None,
        field: field.into(),
        observed: seen,
        declared: said,
        declared_by: adapter_label(declared),
        applies: Applies::Declared,
        blocking,
    };
    let mut found = Vec::new();
    if declared.key != observed.key {
        found.push(conflict(
            "key",
            Value::from(observed.key.clone()),
            Value::from(declared.key.clone()),
            false,
        ));
    }
    if declared.target != observed.target {
        found.push(conflict(
            "target",
            serde_json::json!(observed.target),
            serde_json::json!(declared.target),
            false,
        ));
        return found;
    }
    if let (Some(seen), Some(said)) = (observed.arity.supported(), declared.arity.supported()) {
        if seen != said {
            let outside =
                said.min < seen.min || seen.max.is_some_and(|max| said.max.is_none_or(|n| n > max));
            found.push(conflict(
                "arity",
                serde_json::json!(seen),
                serde_json::json!(said),
                outside,
            ));
        }
    }
    // A type, choice list or range the help observes also limits which saved
    // values the runtime accepts: those differences refuse a saved value
    // outside the observed facts. Repetition and defaults stay informational.
    macro_rules! compare {
        ($field:ident, $name:literal, $values:literal) => {
            if let (Some(seen), Some(said)) =
                (observed.$field.supported(), declared.$field.supported())
            {
                if seen != said {
                    found.push(conflict(
                        $name,
                        serde_json::json!(seen),
                        serde_json::json!(said),
                        $values,
                    ));
                }
            }
        };
    }
    compare!(kind, "kind", true);
    compare!(range, "range", true);
    compare!(repeatable, "repeatable", false);
    compare!(runtime_default, "runtime_default", false);
    if let (Some(seen), Some(said)) = (observed.choices.supported(), declared.choices.supported()) {
        if seen.len() != said.len() || seen.iter().any(|value| !said.contains(value)) {
            found.push(conflict(
                "choices",
                Value::from(seen.clone()),
                Value::from(said.clone()),
                true,
            ));
        }
    }
    found
}

/// The argv text of a saved scalar, as observed choices spell it.
pub(super) fn argv_text(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

/// Whether one saved scalar is outside the facts the help observed.
fn outside_observed(conflict: &FactConflict, value: &Value) -> bool {
    match conflict.field.as_str() {
        "choices" => conflict.observed.as_array().is_some_and(|choices| {
            !choices
                .iter()
                .any(|choice| choice == value || choice.as_str() == Some(&argv_text(value)))
        }),
        "kind" => serde_json::from_value::<ValueKind>(conflict.observed.clone())
            .is_ok_and(|kind| !runtime_metadata::typed(kind, value)),
        "range" => value.as_f64().is_none_or(|number| {
            conflict.observed["min"]
                .as_f64()
                .is_some_and(|min| number < min)
                || conflict.observed["max"]
                    .as_f64()
                    .is_some_and(|max| number > max)
        }),
        _ => true,
    }
}

/// The reason a blocking difference refuses this saved value, if it does.
pub(super) fn blocking_issue(
    conflict: &FactConflict,
    saved: &Value,
    sensitive: bool,
) -> Option<String> {
    let recovery = "remove the saved value, or correct that declaration and register the runtime again (or select a runtime whose help matches it)";
    match conflict.field.as_str() {
        "arity" => Some(format!(
            "{}: the reviewed help shows {} value(s) for this option but {} declares {}; the saved value was retained because launching it would misplace arguments. Remove the saved value, or correct that option declaration and register the runtime again (or select a runtime whose help matches it)",
            conflict.flag,
            value_count(&conflict.observed),
            conflict.declared_by,
            value_count(&conflict.declared)
        )),
        "choices" | "kind" | "range" => {
            let rows = runtime_help_store::overrides_from_map(&Map::from_iter([(
                conflict.key.clone(),
                saved.clone(),
            )]));
            let outside = rows
                .get(&conflict.key)
                .into_iter()
                .flat_map(|row| row.occurrences.iter().flatten())
                .find(|value| outside_observed(conflict, value))?;
            let observed = match conflict.observed.as_array() {
                Some(choices) => choices.iter().map(argv_text).collect::<Vec<_>>().join(", "),
                None => argv_text(&conflict.observed),
            };
            // A secret value, and the declared list it came from, are never
            // repeated in a diagnostic; the reason and recovery suffice.
            Some(if sensitive {
                format!(
                    "{}: the reviewed help accepts {} {observed} but the saved (hidden) value is outside it, although {} declares it; the saved value was retained. Choose a value the help documents, {recovery}",
                    conflict.flag, conflict.field, conflict.declared_by,
                )
            } else {
                format!(
                    "{}: the reviewed help accepts {} {observed} but the saved value {} is outside it, although {} declares {}; the saved value was retained. Choose a value the help documents, {recovery}",
                    conflict.flag,
                    conflict.field,
                    argv_text(outside),
                    conflict.declared_by,
                    argv_text(&conflict.declared),
                )
            })
        }
        "reserved" => Some(format!(
            "{}: {} reserves this option because {}; the saved value was retained. Remove it — the app provides this behavior",
            conflict.flag,
            conflict.declared_by,
            argv_text(&conflict.declared)
        )),
        "constraint" => Some(format!(
            "{}: {} declares a constraint the reviewed help cannot honor ({}); the saved value was retained instead of launching without it. Correct the option metadata and register the runtime again, or remove the saved value",
            conflict.flag,
            conflict.declared_by,
            argv_text(&conflict.declared)
        )),
        _ => Some(format!(
            "{}: {} declares facts for this option that could not be applied ({}); the saved value was retained instead of launching without them. Correct the option metadata and register the runtime again, or remove the saved value",
            conflict.flag,
            conflict.declared_by,
            argv_text(&conflict.observed)
        )),
    }
}

fn value_count(arity: &Value) -> String {
    let min = arity["min"].as_u64().unwrap_or_default();
    match arity["max"].as_u64() {
        Some(max) if max == min => min.to_string(),
        Some(max) => format!("{min} to {max}"),
        None => format!("{min} or more"),
    }
}

/// Saved keys for help review. Kept separate from discovery so catalog and
/// dedicated settings can be compared against the effective option contract.
pub fn discovery_saved_keys(
    cfg: &AppConfig,
    selected: &Selected,
) -> Result<Vec<String>, crate::error::AppError> {
    let empty = Map::new();
    let values = cfg
        .provider_options
        .get(selected.key.provider.as_str())
        .unwrap_or(&empty);
    let catalog = compat(selected)?;
    let known = catalog
        .options
        .iter()
        .map(|option| option.key.as_str())
        .collect::<BTreeSet<_>>();
    Ok(generic_entries(values)
        .filter(|(key, _)| !known.contains(key.as_str()))
        .map(|(key, _)| key.clone())
        .collect())
}

/// A new entry point has no manifest option catalog. Its saved provider values
/// must be reviewed against its new help, even before any help was accepted.
pub fn entrypoint_saved_keys(cfg: &AppConfig, provider: ProviderId) -> Vec<String> {
    let empty = Map::new();
    let values = cfg
        .provider_options
        .get(provider.as_str())
        .unwrap_or(&empty);
    generic_entries(values)
        .map(|(key, _)| key.clone())
        .collect()
}

/// A documented alias of an app binding remains app-owned even when a
/// manifest/catalog option shadows that help row in the effective schema.
pub(super) fn protect_binding_aliases(compat: &mut Compat, help: &[OptionDefinition]) {
    for option in help {
        let binding = option.managed.or_else(|| {
            option
                .spellings
                .iter()
                .find_map(|spelling| compat.managed_flags.get(&spelling.flag))
                .copied()
        });
        if let Some(binding) = binding {
            for spelling in &option.spellings {
                compat
                    .managed_flags
                    .entry(spelling.flag.clone())
                    .or_insert(binding);
            }
        }
    }
    for option in &mut compat.options {
        if option.target == Target::Launch {
            option.managed = option.managed.or_else(|| {
                option
                    .spellings
                    .iter()
                    .find_map(|spelling| compat.managed_flags.get(&spelling.flag))
                    .copied()
            });
        }
    }
}

pub(super) fn compat(selected: &Selected) -> Result<Compat, crate::error::AppError> {
    crate::providers::adapter::help::option_descriptor(selected)
}

pub(super) fn compat_fingerprint(
    engine: &str,
    runtime: &str,
    options: &[OptionDefinition],
) -> String {
    let identity = serde_json::json!({"engine": engine, "runtime": runtime, "options": options});
    format!("{:x}", Sha256::digest(identity.to_string().as_bytes()))
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
