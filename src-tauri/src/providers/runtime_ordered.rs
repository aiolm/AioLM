//! Ordered option plans preserve interleaved command-line order.
//!
//! Stored profiles group occurrences by key (`Overrides`), which is canonical
//! and deterministic but silently reorders interleaved input such as
//! `--a 1 --b 2 --a 3` into `--a 1 --a 3 --b 2`. Plans keep every occurrence
//! in input order so CLI import preview round-trips faithfully. Within one
//! scope depth argv follows plan order; scope segments themselves stay
//! ordered (global before subcommand before positional tail), and positional
//! slots still refuse gaps. All value semantics stay with
//! `runtime_options`: unknown arity still blocks argv, managed bindings stay
//! rejected, and explicit false/zero/empty remain distinct from absent.
use super::runtime_options::{
    OptionDefinition, OptionIssue, OptionSchema, Override, Overrides, ResolvedOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// One planned occurrence in input order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedOccurrence {
    pub key: String,
    #[serde(default)]
    pub spelling: Option<String>,
    pub values: Vec<Value>,
}

/// Occurrences in the order they were given.
pub type OrderedPlan = Vec<PlannedOccurrence>;

/// A pasted command split into an ordered plan plus review buckets.
/// Managed and unrecognized words are never silently emitted; they stay
/// visible until the user maps or drops them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportedPlan {
    pub plan: OrderedPlan,
    /// Words owned by the app (model, host, port, auth, lifecycle).
    pub managed: Vec<String>,
    /// Words no schema option describes, kept verbatim for review.
    pub unrecognized: Vec<String>,
}

/// Canonical expansion of grouped overrides (key order). Use for stored
/// profiles; use `import_plan_text` for input order.
pub fn plan_from_overrides(overrides: &Overrides) -> OrderedPlan {
    let mut plan = Vec::new();
    for (key, value) in overrides {
        for row in &value.occurrences {
            plan.push(PlannedOccurrence {
                key: key.clone(),
                spelling: value.spelling.clone(),
                values: row.clone(),
            });
        }
    }
    plan
}

/// Group an ordered plan back into stored overrides. Order across different
/// keys is normalized to key order; order within one key is preserved.
pub fn overrides_from_plan(plan: &OrderedPlan) -> Overrides {
    let mut out: Overrides = BTreeMap::new();
    for occurrence in plan {
        out.entry(occurrence.key.clone())
            .and_modify(|existing: &mut Override| {
                if existing.spelling.is_none() {
                    existing.spelling = occurrence.spelling.clone();
                }
                existing.occurrences.push(occurrence.values.clone());
            })
            .or_insert(Override {
                spelling: occurrence.spelling.clone(),
                occurrences: vec![occurrence.values.clone()],
            });
    }
    out
}

fn scope_of<'a>(schema: &'a OptionSchema, key: &str) -> Option<&'a OptionDefinition> {
    schema.options.iter().find(|o| o.key == key)
}

/// Authoritative resolution following plan order within each scope depth.
pub fn resolve_plan(
    schema: &OptionSchema,
    selected_scope: &[String],
    plan: &OrderedPlan,
) -> Result<ResolvedOptions, Vec<OptionIssue>> {
    if let Err(message) = schema.validate() {
        return Err(vec![OptionIssue {
            key: String::new(),
            message,
        }]);
    }
    if plan.len() > 512 {
        return Err(vec![OptionIssue {
            key: String::new(),
            message: "too many planned option occurrences".into(),
        }]);
    }
    // Canonical validation first for full parity with grouped profiles:
    // unknown keys, subcommand scope, managed bindings, constraints,
    // positional gaps, dash boundaries and size limits all apply equally.
    let grouped = overrides_from_plan(plan);
    let canonical = schema.resolve(selected_scope, &grouped)?;
    // Re-emit flags in plan order within each scope depth. Positionals keep
    // slot order (never plan order) so reordered input cannot rebind a later
    // saved value into an earlier slot. Dash delimiters mirror the grouped
    // path, which already proved support.
    let mut flags_by_depth: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let mut positionals_by_depth: BTreeMap<usize, Vec<(u16, Vec<String>)>> = BTreeMap::new();
    for occurrence in plan {
        let Some(option) = scope_of(schema, &occurrence.key) else {
            continue;
        };
        if option.target == super::runtime_options::Target::Request {
            continue;
        }
        let args = option
            .resolve_one(&occurrence.spelling, &occurrence.values)
            .map_err(|message| {
                vec![OptionIssue {
                    key: occurrence.key.clone(),
                    message,
                }]
            })?;
        let depth = option.scope.len();
        if let Some(position) = option.position {
            positionals_by_depth
                .entry(depth)
                .or_default()
                .push((position, args));
        } else {
            flags_by_depth.entry(depth).or_default().extend(args);
        }
    }
    let mut argv = Vec::new();
    for depth in 0..=selected_scope.len() {
        if depth > 0 {
            argv.push(selected_scope[depth - 1].clone());
        }
        if let Some(flags) = flags_by_depth.remove(&depth) {
            argv.extend(flags);
        }
        if let Some(mut positionals) = positionals_by_depth.remove(&depth) {
            positionals.sort_by_key(|(position, _)| *position);
            if positionals
                .iter()
                .any(|(_, args)| args.iter().any(|s| s.starts_with('-')))
            {
                argv.push("--".into());
            }
            for (_, args) in positionals {
                argv.extend(args);
            }
        }
    }
    Ok(ResolvedOptions {
        argv,
        request: canonical.request,
    })
}

/// Split a pasted command into an ordered plan preserving input order.
///
/// The first word (program) and explicit scope subcommands are skipped when
/// they match; everything else is matched against schema spellings exactly.
/// Unknown flags, managed bindings and positional overflows land in review
/// buckets instead of being guessed.
pub fn import_plan_text(
    schema: &OptionSchema,
    selected_scope: &[String],
    text: &str,
) -> Result<ImportedPlan, String> {
    schema.validate()?;
    let words = super::options::split_command(text)?;
    let mut plan: OrderedPlan = Vec::new();
    let mut managed = Vec::new();
    let mut unrecognized: Vec<String> = Vec::new();
    let mut positional_slots: Vec<&OptionDefinition> = schema
        .options
        .iter()
        .filter(|o| {
            o.position.is_some()
                && o.scope.len() <= selected_scope.len()
                && selected_scope.starts_with(&o.scope)
        })
        .collect();
    positional_slots.sort_by_key(|o| o.position.unwrap_or(u16::MAX));
    let mut positional_index = 0usize;
    let mut index = 0usize;
    // Skip a leading program word only when it looks like a path or file name
    // (bare positional values must never be eaten). Scope subcommands are
    // skipped by the scope cursor below, so pasted full lines import cleanly.
    let first_is_scope = selected_scope
        .first()
        .is_some_and(|s| Some(s.as_str()) == words.first().map(|w| w.as_str()));
    let looks_like_program = !words.is_empty()
        && !words[0].starts_with('-')
        && !first_is_scope
        && (words[0].contains('/') || words[0].contains('\\') || words[0].contains('.'));
    if looks_like_program {
        index = 1;
    }
    let mut scope_cursor = 0usize;
    while index < words.len()
        && scope_cursor < selected_scope.len()
        && words[index] == selected_scope[scope_cursor]
    {
        scope_cursor += 1;
        index += 1;
    }
    while index < words.len() {
        let word = words[index].clone();
        index += 1;
        if word == "--" {
            return Err("a bare -- would turn every later argument into a positional value".into());
        }
        if word.starts_with("--")
            || (word.starts_with('-')
                && word.len() > 1
                && !word.parse::<f64>().is_ok_and(f64::is_finite))
        {
            let (name, inline) = match word.split_once('=') {
                Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
                None => (word.clone(), None),
            };
            // Managed spellings can never be imported as generic options, even
            // by alias: they have dedicated binding controls.
            let managed_hit = schema
                .options
                .iter()
                .find(|o| o.managed.is_some() && o.spellings.iter().any(|s| s.flag == name));
            if managed_hit.is_some() {
                managed.push(word.clone());
                if inline.is_none() {
                    if let Some(next) = words.get(index).filter(|n| !n.starts_with('-')) {
                        managed.push(next.clone());
                        index += 1;
                    }
                }
                continue;
            }
            let negated = name.strip_prefix("--no-").map(|rest| format!("--{rest}"));
            let found = schema.options.iter().find(|o| {
                o.spellings.iter().any(|s| s.flag == name)
                    || (negated
                        .as_deref()
                        .is_some_and(|n| o.spellings.iter().any(|s| s.flag == n)))
            });
            let Some(option) = found else {
                unrecognized.push(word.clone());
                if inline.is_none() {
                    if let Some(next) = words.get(index).filter(|n| !n.starts_with("--")) {
                        unrecognized.push(next.clone());
                        index += 1;
                    }
                }
                continue;
            };
            if !selected_scope.starts_with(&option.scope) {
                unrecognized.push(word.clone());
                continue;
            }
            // Negative `--no-foo` maps to explicit false on the base key.
            let is_negative = negated.is_some_and(|n| {
                option.spellings.iter().any(|s| s.flag == n)
                    && !option.spellings.iter().any(|s| s.flag == name)
            }) || (name.starts_with("--no-")
                && option
                    .spellings
                    .iter()
                    .any(|s| s.flag == name && s.polarity == Some(false)));
            if option.kind.supported() == Some(&super::runtime_options::ValueKind::Boolean)
                && option.arity.supported().is_some_and(|a| a.max == Some(0))
            {
                if inline.is_some() {
                    unrecognized.push(word.clone());
                    continue;
                }
                let enabled = !is_negative;
                // An explicit spelling without confirmed polarity cannot set
                // the opposite value.
                if is_negative && !option.spellings.iter().any(|s| s.flag == name) {
                    unrecognized.push(word.clone());
                    continue;
                }
                plan.push(PlannedOccurrence {
                    key: option.key.clone(),
                    spelling: Some(name.clone()),
                    values: vec![Value::Bool(enabled)],
                });
                continue;
            }
            let arity = option.arity.supported().copied();
            let Some(arity) = arity else {
                // Arity unknown: keep one tentative value in order; resolution
                // still blocks argv until explicit metadata arrives.
                if let Some(inline) = inline {
                    plan.push(PlannedOccurrence {
                        key: option.key.clone(),
                        spelling: Some(name.clone()),
                        values: vec![Value::String(inline)],
                    });
                } else if let Some(next) = words.get(index).filter(|n| !n.starts_with('-')) {
                    plan.push(PlannedOccurrence {
                        key: option.key.clone(),
                        spelling: Some(name.clone()),
                        values: vec![Value::String((*next).clone())],
                    });
                    index += 1;
                } else {
                    unrecognized.push(word.clone());
                }
                continue;
            };
            let max = arity.max.unwrap_or(8).min(8) as usize;
            let mut values: Vec<Value> = Vec::new();
            if let Some(inline) = inline {
                values.push(Value::String(inline));
            } else {
                while values.len() < max && index < words.len() && !words[index].starts_with("--") {
                    // A flag-like text value needs a confirmed equals spelling.
                    if words[index].starts_with('-')
                        && !words[index].parse::<f64>().is_ok_and(f64::is_finite)
                    {
                        break;
                    }
                    values.push(Value::String(words[index].clone()));
                    index += 1;
                    if arity.max == Some(1) {
                        break;
                    }
                    if values.len() >= arity.min as usize
                        && words.get(index).is_some_and(|n| n.starts_with("--"))
                    {
                        break;
                    }
                }
            }
            if values.len() < arity.min as usize
                || arity.max.is_some_and(|n| values.len() > n as usize)
            {
                unrecognized.push(word.clone());
                unrecognized.extend(values.into_iter().map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string())
                }));
                continue;
            }
            plan.push(PlannedOccurrence {
                key: option.key.clone(),
                spelling: Some(name.clone()),
                values,
            });
            continue;
        }
        if word.starts_with('-') {
            unrecognized.push(word.clone());
            continue;
        }
        // Bare words fill positional slots in order.
        if positional_index < positional_slots.len() {
            let slot = positional_slots[positional_index];
            positional_index += 1;
            plan.push(PlannedOccurrence {
                key: slot.key.clone(),
                spelling: None,
                values: vec![Value::String(word)],
            });
        } else {
            unrecognized.push(word);
        }
    }
    if plan.len() > 512 {
        return Err("too many planned option occurrences".into());
    }
    Ok(ImportedPlan {
        plan,
        managed,
        unrecognized,
    })
}

#[cfg(test)]
mod tests {
    use super::super::runtime_options::{
        Arity, Certainty, Fact, OptionDefinition, SchemaBinding, ValueKind, SCHEMA_VERSION,
    };
    use super::*;
    use serde_json::json;

    fn known<T>(value: T) -> Fact<T> {
        Fact {
            value: Some(value),
            certainty: Certainty::Verified,
            source: Some(super::super::runtime_options::Source::Adapter {
                id: "test.adapter".into(),
                revision: "r1".into(),
            }),
        }
    }

    fn option(key: &str, flag: &str, min: u16, max: Option<u16>) -> OptionDefinition {
        serde_json::from_value(json!({
            "key": key, "spellings": [{"flag": flag}],
            "kind": known(ValueKind::Text), "arity": known(Arity {min, max}), "target": "launch"
        }))
        .unwrap()
    }

    fn schema(options: Vec<OptionDefinition>) -> OptionSchema {
        OptionSchema {
            schema_version: SCHEMA_VERSION,
            binding: SchemaBinding {
                engine: "custom.example".into(),
                runtime: "build-a".into(),
                fingerprint: "a".repeat(64),
            },
            options,
            constraints: vec![],
            raw_help: vec![],
            end_of_options: Fact::default(),
        }
    }

    #[test]
    fn interleaved_input_order_survives_import_and_plan_resolution() {
        let schema = schema(vec![
            option("alpha", "--alpha", 1, Some(1)),
            option("beta", "--beta", 1, Some(1)),
        ]);
        let imported = import_plan_text(&schema, &[], "--alpha 1 --beta 2 --alpha 3").unwrap();
        assert_eq!(
            imported
                .plan
                .iter()
                .map(|o| o.key.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta", "alpha"]
        );
        assert!(imported.managed.is_empty());
        // Grouped overrides normalize cross-key order; plans do not.
        let grouped = overrides_from_plan(&imported.plan);
        assert_eq!(grouped["alpha"].occurrences.len(), 2);
        // Single-occurrence keys resolve; repetition needs metadata.
        let single = import_plan_text(&schema, &[], "--alpha 1 --beta 2").unwrap();
        let resolved = resolve_plan(&schema, &[], &single.plan).unwrap();
        assert_eq!(resolved.argv, vec!["--alpha", "1", "--beta", "2"]);
        assert!(resolve_plan(&schema, &[], &imported.plan).is_err());
    }

    #[test]
    fn aliases_negative_multi_repeat_and_explicit_scalars_round_trip() {
        let mut enabled: OptionDefinition = serde_json::from_value(json!({
            "key": "cache", "spellings": [{"flag": "--cache", "polarity": true}, {"flag": "--no-cache", "polarity": false}],
            "kind": known(ValueKind::Boolean), "arity": known(Arity {min: 0, max: Some(0)}), "target": "launch"
        }))
        .unwrap();
        let _ = &mut enabled;
        let mut pair = option("pair", "--pair", 2, Some(2));
        pair.repeatable = known(true);
        let schema = schema(vec![enabled, pair, option("count", "--count", 1, Some(1))]);
        let imported =
            import_plan_text(&schema, &[], "--no-cache --pair 1 2 --pair 3 4 --count 0").unwrap();
        assert_eq!(imported.plan[0].values, vec![json!(false)]);
        let resolved = resolve_plan(&schema, &[], &imported.plan).unwrap();
        assert_eq!(
            resolved.argv,
            vec![
                "--no-cache",
                "--pair",
                "1",
                "2",
                "--pair",
                "3",
                "4",
                "--count",
                "0"
            ]
        );
        // Explicit false/zero/empty stay distinct from absent.
        let grouped = overrides_from_plan(&imported.plan);
        let back = plan_from_overrides(&grouped);
        assert_eq!(back.len(), imported.plan.len());
    }

    #[test]
    fn managed_bindings_and_unknown_flags_stay_in_review_buckets() {
        let mut port = option("port", "--port", 1, Some(1));
        port.managed = Some(super::super::runtime_options::ManagedBinding::Port);
        let schema = schema(vec![port, option("threads", "--threads", 1, Some(1))]);
        let imported =
            import_plan_text(&schema, &[], "--port 8080 --threads 4 --mystery 1").unwrap();
        assert!(imported.managed.iter().any(|w| w.contains("--port")));
        assert!(imported
            .unrecognized
            .iter()
            .any(|w| w.contains("--mystery")));
        assert_eq!(imported.plan.len(), 1);
        assert_eq!(imported.plan[0].key, "threads");
    }

    #[test]
    fn positional_slots_fill_in_order_and_refuse_gaps() {
        let mut first = option("first", "--first", 1, Some(1));
        first.spellings.clear();
        first.position = Some(0);
        let mut second = option("second", "--second", 1, Some(1));
        second.spellings.clear();
        second.position = Some(1);
        let schema = schema(vec![first, second]);
        let imported = import_plan_text(&schema, &[], "one two").unwrap();
        assert_eq!(imported.plan[0].key, "first");
        assert_eq!(imported.plan[1].key, "second");
        let overflow = import_plan_text(&schema, &[], "one two three").unwrap();
        assert!(overflow.unrecognized.contains(&"three".to_string()));
    }

    #[test]
    fn null_constraint_values_are_reviewed_not_silently_reinterpreted() {
        // JSON null arrives as None (occurrence test); an explicit null value
        // constraint cannot round-trip through Option<Value>.
        let predicate: super::super::runtime_options::Predicate =
            serde_json::from_value(json!({"key": "threads", "equals": null})).unwrap();
        assert_eq!(predicate.equals, None);
        // Value null is not a supported constraint operand in v1.
        let schema = schema(vec![option("threads", "--threads", 1, Some(1))]);
        let mut with_null = schema.clone();
        with_null
            .constraints
            .push(known(super::super::runtime_options::Relation::Requires {
                when: super::super::runtime_options::Predicate {
                    key: "threads".into(),
                    equals: Some(Value::Null),
                },
                other: super::super::runtime_options::Predicate {
                    key: "threads".into(),
                    equals: None,
                },
            }));
        assert!(with_null.validate().is_err());
    }

    #[test]
    fn unknown_arity_keeps_order_but_blocks_argv() {
        let mut new_flag = option("new_flag", "--new-flag", 1, Some(1));
        new_flag.arity = Fact::default();
        let schema = schema(vec![new_flag]);
        let imported = import_plan_text(&schema, &[], "--new-flag retained").unwrap();
        assert_eq!(imported.plan[0].key, "new_flag");
        assert!(resolve_plan(&schema, &[], &imported.plan).is_err());
    }
}
