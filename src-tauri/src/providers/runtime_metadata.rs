//! Explicit, versioned option metadata from an engine's adapter.
//!
//! Help shows command syntax. It cannot establish that a value is a secret,
//! which unit a number counts, that a change needs a restart, or which values
//! a type admits. An adapter states those facts in this bounded document,
//! identified by its adapter id and revision. Facts attach by an observed
//! flag spelling, or by the key of an observed launch positional, to options
//! the effective schema already has; they never add options, request fields
//! or app-owned bindings. Observed help syntax, existing adapter facts and
//! app bindings always win: every declaration they contradict, or that names
//! no option, is reported instead of applied.
use super::{
    runtime_options::{
        explicit_operand, identifier, Arity, Certainty, Fact, ManagedBinding, NumericRange,
        OptionDefinition, OptionSchema, Predicate, Relation, RuntimeDefault, Source, Target,
        ValueKind,
    },
    ProviderId,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const METADATA_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 256;
/// One declared value (choice, default or operand) is a single argv token at
/// most, which the resolver limits to 32 KiB.
const MAX_LITERAL_BYTES: usize = 32 * 1024;
/// The whole document stays well inside the 256 KiB registration record that
/// must be read back after publication.
const MAX_METADATA_BYTES: usize = 128 * 1024;

fn literal_size(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn literal_error(what: &str, value: &Value) -> String {
    format!(
        "a declared {what} is {} KiB; one value is limited to {} KiB",
        literal_size(value).div_ceil(1024),
        MAX_LITERAL_BYTES / 1024
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub id: String,
    pub revision: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionMetadata {
    pub version: u32,
    /// The engine the adapter describes; metadata copied from another engine
    /// is refused rather than matched by coincidental flag names.
    pub engine_id: ProviderId,
    pub adapter: Provenance,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<MetadataOption>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<MetadataRelation>,
}

/// Facts for the one option an entry names: by an observed flag spelling, or
/// by the effective key of an observed launch positional (help positionals
/// have no spelling). Exactly one of the two is set. Absent fields stay
/// whatever help or the adapter catalog already established (or unknown).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetadataOption {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    /// Omitted for flag entries, so their documents keep their exact bytes
    /// and digest. An app without this field refuses such a document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positional: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ValueKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arity: Option<Arity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeatable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<NumericRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_default: Option<RuntimeDefault>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<bool>,
    /// Why the app owns this option (model lifecycle, tool servers). The
    /// option is locked and saved values are refused with this reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FlagPredicate {
    pub flag: String,
    #[serde(
        default,
        deserialize_with = "explicit_operand",
        skip_serializing_if = "Option::is_none"
    )]
    pub equals: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MetadataRelation {
    Requires {
        when: FlagPredicate,
        other: FlagPredicate,
    },
    Excludes {
        when: FlagPredicate,
        other: FlagPredicate,
    },
}

/// Which side of a difference the effective schema uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Applies {
    /// The reviewed help observation (or app binding) stays in effect.
    Observed,
    /// The adapter declaration stays in effect (legacy catalog mapping).
    Declared,
}

/// A declared fact that differs from what the reviewed help shows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactConflict {
    /// The effective option key; empty when no option has the flag.
    pub key: String,
    /// Empty when the declaration names a positional.
    pub flag: String,
    /// The positional key a declaration names, even when no such observed
    /// positional exists; omitted for flag declarations and constraints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positional: Option<String>,
    pub field: String,
    /// What reviewed help shows; null when it shows nothing for this.
    pub observed: Value,
    pub declared: Value,
    /// Adapter id and revision of the declaration.
    pub declared_by: String,
    pub applies: Applies,
    /// A saved value would be serialized against the observed syntax.
    pub blocking: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetadataView {
    pub adapter: String,
    pub revision: String,
    /// Shipped with the app for a built-in engine, not registered metadata.
    pub builtin: bool,
    /// Keys at least one declared fact was established for.
    pub applied: Vec<String>,
    pub conflicts: Vec<FactConflict>,
    /// Set when the combined schema was invalid; nothing was applied.
    pub error: Option<String>,
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn valid_flag(flag: &str) -> bool {
    let body = flag.trim_start_matches(['-', '/']);
    flag.starts_with(['-', '/'])
        && flag.len() <= 128
        && !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.?".contains(&b))
}

/// An option key that can never be read as a flag spelling.
fn valid_positional(key: &str) -> bool {
    identifier(key) && !key.starts_with(['-', '/'])
}

/// The one option an entry names.
enum Selector<'a> {
    Flag(&'a str),
    Positional(&'a str),
}

pub(crate) fn typed(kind: ValueKind, value: &Value) -> bool {
    match kind {
        ValueKind::Boolean => value.is_boolean(),
        ValueKind::Integer => value.as_i64().is_some(),
        ValueKind::Number => value.as_f64().is_some_and(f64::is_finite),
        ValueKind::Text | ValueKind::Tokens => value.is_string(),
        ValueKind::Json => true,
    }
}

fn in_range(range: &NumericRange, value: &Value) -> bool {
    value.as_f64().is_some_and(|n| {
        range.min.is_none_or(|min| n >= min) && range.max.is_none_or(|max| n <= max)
    })
}

impl MetadataOption {
    fn check(&self) -> Result<(), String> {
        if self.kind.is_none()
            && self.arity.is_none()
            && self.repeatable.is_none()
            && self.choices.is_none()
            && self.range.is_none()
            && self.unit.is_none()
            && self.runtime_default.is_none()
            && self.restart_required.is_none()
            && self.sensitive.is_none()
            && self.local_path.is_none()
            && self.reserved.is_none()
        {
            return Err("the entry declares no fact".into());
        }
        if self
            .reserved
            .as_ref()
            .is_some_and(|reason| !bounded(reason, 256))
        {
            return Err("a reservation states its reason in short, non-empty text".into());
        }
        if self
            .arity
            .is_some_and(|a| a.min > 256 || a.max.is_some_and(|n| n < a.min || n > 256))
        {
            return Err("invalid value count".into());
        }
        if self.unit.as_ref().is_some_and(|unit| !bounded(unit, 64)) {
            return Err("a unit is short, non-empty text".into());
        }
        if let Some(choice) = self
            .choices
            .iter()
            .flatten()
            .find(|choice| literal_size(choice) > MAX_LITERAL_BYTES)
        {
            return Err(literal_error("choice", choice));
        }
        if let Some(default) = self
            .runtime_default
            .as_ref()
            .filter(|default| literal_size(&default.literal) > MAX_LITERAL_BYTES)
        {
            return Err(literal_error("runtime default", &default.literal));
        }
        if let Some(choices) = &self.choices {
            if choices.is_empty()
                || choices.len() > 256
                || choices
                    .iter()
                    .any(|v| v.is_null() || v.is_array() || v.is_object())
                || self
                    .kind
                    .is_some_and(|kind| choices.iter().any(|v| !typed(kind, v)))
            {
                return Err("choices must be scalar values of the declared type".into());
            }
        }
        if let Some(range) = &self.range {
            if !matches!(self.kind, Some(ValueKind::Integer | ValueKind::Number))
                || range.min.is_some_and(|n| !n.is_finite())
                || range.max.is_some_and(|n| !n.is_finite())
                || matches!((range.min, range.max), (Some(a), Some(b)) if a > b)
            {
                return Err(
                    "a numeric range needs a declared integer or number type and finite bounds"
                        .into(),
                );
            }
        }
        if let Some(default) = &self.runtime_default {
            let literal = &default.literal;
            if self.kind.is_some_and(|kind| !typed(kind, literal))
                || self
                    .choices
                    .as_ref()
                    .is_some_and(|choices| !choices.contains(literal))
                || self
                    .range
                    .as_ref()
                    .is_some_and(|range| !in_range(range, literal))
            {
                return Err(
                    "the runtime default does not match the declared type, choices or range".into(),
                );
            }
        }
        Ok(())
    }

    /// The declared facts, for display next to what help shows.
    fn declared(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(object) = value.as_object_mut() {
            object.remove("flag");
            object.remove("positional");
        }
        value
    }

    fn selector(&self) -> Option<Selector<'_>> {
        match (&self.flag, &self.positional) {
            (Some(flag), None) => Some(Selector::Flag(flag)),
            (None, Some(key)) => Some(Selector::Positional(key)),
            _ => None,
        }
    }

    /// The schema index of the launch option this entry names: one with the
    /// observed spelling, or the observed positional slot with the key.
    /// Never a flag option that happens to share a positional's key.
    fn target(&self, schema: &OptionSchema) -> Option<usize> {
        let selector = self.selector()?;
        schema.options.iter().position(|o| {
            o.target == Target::Launch
                && match selector {
                    Selector::Flag(flag) => o.spellings.iter().any(|s| s.flag == flag),
                    Selector::Positional(key) => {
                        o.position.is_some() && o.spellings.is_empty() && o.key == key
                    }
                }
        })
    }

    /// The app binding that owns the option. A positional whose role is
    /// still open (`Discovery`, confirmed later from the reviewed help) is
    /// owned by nothing yet; declared facts never change its ownership.
    fn owner(&self, option: &OptionDefinition) -> Option<ManagedBinding> {
        match option.managed {
            Some(ManagedBinding::Discovery) if self.positional.is_some() => None,
            managed => managed,
        }
    }
}

impl MetadataRelation {
    fn sides(&self) -> (&FlagPredicate, &FlagPredicate) {
        match self {
            Self::Requires { when, other } | Self::Excludes { when, other } => (when, other),
        }
    }
}

impl OptionMetadata {
    /// Version, identity and provenance first, then every entry's own
    /// consistency. Options the help may or may not show are checked when
    /// the metadata is applied to an actual schema.
    pub fn validate(&self, engine: ProviderId) -> Result<(), String> {
        if self.version != METADATA_VERSION {
            return Err(format!(
                "unsupported option metadata version {}; this app supports {METADATA_VERSION}",
                self.version
            ));
        }
        if self.engine_id != engine {
            return Err(format!(
                "option metadata describes another engine ({}), not {}",
                self.engine_id.as_str(),
                engine.as_str()
            ));
        }
        if !identifier(&self.adapter.id) || !bounded(&self.adapter.revision, 256) {
            return Err("option metadata needs adapter provenance: an id and a revision".into());
        }
        if self.options.len() > MAX_ENTRIES || self.constraints.len() > MAX_ENTRIES {
            return Err("option metadata exceeds 256 options or constraints".into());
        }
        if self.options.is_empty() && self.constraints.is_empty() {
            return Err("option metadata declares no option or constraint".into());
        }
        let mut flags = BTreeSet::new();
        let mut positionals = BTreeSet::new();
        for option in &self.options {
            let name = match option.selector() {
                Some(Selector::Flag(name)) => {
                    if !valid_flag(name) || !flags.insert(name) {
                        return Err(format!(
                            "{name}: each metadata entry names one distinct flag spelling"
                        ));
                    }
                    name
                }
                Some(Selector::Positional(key)) => {
                    if !valid_positional(key) || !positionals.insert(key) {
                        return Err(format!(
                            "{key}: each positional entry names one distinct observed positional key"
                        ));
                    }
                    if option.reserved.is_some() {
                        return Err(format!(
                            "{key}: a positional entry cannot be reserved; its role is confirmed from the reviewed help"
                        ));
                    }
                    key
                }
                None => {
                    return Err("each metadata entry names exactly one target: a flag spelling or an observed positional key".into())
                }
            };
            option.check().map_err(|error| format!("{name}: {error}"))?;
        }
        for relation in &self.constraints {
            let (when, other) = relation.sides();
            for predicate in [when, other] {
                if !valid_flag(&predicate.flag) {
                    return Err(format!(
                        "{}: a constraint must name a flag spelling",
                        predicate.flag
                    ));
                }
                if let Some(value) = predicate
                    .equals
                    .as_ref()
                    .filter(|value| literal_size(value) > MAX_LITERAL_BYTES)
                {
                    return Err(format!(
                        "{}: {}",
                        predicate.flag,
                        literal_error("constraint operand", value)
                    ));
                }
            }
        }
        let size = serde_json::to_vec(self).map_err(|e| e.to_string())?.len();
        if size > MAX_METADATA_BYTES {
            return Err(format!(
                "option metadata is {} KiB; it is limited to {} KiB",
                size.div_ceil(1024),
                MAX_METADATA_BYTES / 1024
            ));
        }
        Ok(())
    }

    /// Identity of the exact declarations, for help and launch identities.
    pub fn digest(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("metadata serializes");
        format!("{:x}", Sha256::digest(bytes))
    }

    fn label(&self) -> String {
        format!("{} {}", self.adapter.id, self.adapter.revision)
    }
}

/// Facts the app's built-in adapters take from their engines' own option
/// definitions, never from option names or help prose.
pub fn builtin(provider: ProviderId) -> Option<OptionMetadata> {
    super::adapter::help::builtin_metadata(provider)
}

enum Merge {
    Applied,
    Same,
    Differs(Value),
}

fn merge<T: Clone + PartialEq + Serialize>(
    fact: &mut Fact<T>,
    declared: &T,
    source: &Source,
) -> Merge {
    match fact.supported() {
        None => {
            *fact = Fact {
                value: Some(declared.clone()),
                certainty: Certainty::Documented,
                source: Some(source.clone()),
            };
            Merge::Applied
        }
        Some(current) if current == declared => Merge::Same,
        Some(current) => Merge::Differs(serde_json::to_value(current).unwrap_or(Value::Null)),
    }
}

fn launch_option<'a>(schema: &'a OptionSchema, flag: &str) -> Option<&'a OptionDefinition> {
    schema
        .options
        .iter()
        .find(|o| o.target == Target::Launch && o.spellings.iter().any(|s| s.flag == flag))
}

/// Establish declared facts on the schema's options. `report_absent` names
/// declarations for flags or positionals no option has; built-in metadata
/// stays silent because a given build need not have every option.
pub fn apply(
    schema: &mut OptionSchema,
    metadata: &OptionMetadata,
    builtin: bool,
    report_absent: bool,
) -> MetadataView {
    let source = Source::Adapter {
        id: metadata.adapter.id.clone(),
        revision: metadata.adapter.revision.clone(),
    };
    let declared_by = metadata.label();
    let mut view = MetadataView {
        adapter: metadata.adapter.id.clone(),
        revision: metadata.adapter.revision.clone(),
        builtin,
        applied: Vec::new(),
        conflicts: Vec::new(),
        error: None,
    };
    let before = (schema.options.clone(), schema.constraints.clone());
    let conflict =
        |key: &str, flag: &str, field: &str, observed: Value, declared: Value| FactConflict {
            key: key.into(),
            flag: flag.into(),
            positional: None,
            field: field.into(),
            observed,
            declared,
            declared_by: declared_by.clone(),
            applies: Applies::Observed,
            blocking: false,
        };
    // A difference about one entry names the entry's own selector.
    let reported = |entry: &MetadataOption, key: &str, field: &str, observed, declared| {
        let mut found = conflict(
            key,
            entry.flag.as_deref().unwrap_or_default(),
            field,
            observed,
            declared,
        );
        found.positional = entry.positional.clone();
        found
    };
    let mut claimed = BTreeSet::new();
    for entry in &metadata.options {
        let Some(index) = entry.target(schema) else {
            if report_absent {
                view.conflicts
                    .push(reported(entry, "", "option", Value::Null, entry.declared()));
            }
            continue;
        };
        let option = &mut schema.options[index];
        if !claimed.insert(index) {
            // Two entries name aliases of one option; the first one applies.
            view.conflicts.push(reported(
                entry,
                &option.key,
                "duplicate",
                Value::Null,
                entry.declared(),
            ));
            continue;
        }
        if let Some(binding) = entry.owner(option) {
            view.conflicts.push(reported(
                entry,
                &option.key,
                "binding",
                serde_json::to_value(binding).unwrap_or(Value::Null),
                entry.declared(),
            ));
            continue;
        }
        // A reservation only ever locks an option; it never unlocks one.
        if let Some(reason) = &entry.reserved {
            option.managed = Some(ManagedBinding::Reserved);
            let mut found = reported(
                entry,
                &option.key,
                "reserved",
                Value::Null,
                Value::from(reason.clone()),
            );
            found.applies = Applies::Declared;
            found.blocking = true;
            view.conflicts.push(found);
            view.applied.push(option.key.clone());
            continue;
        }
        let mut applied = false;
        let key = option.key.clone();
        let mut differs = |field: &str, observed: Value, declared: Value| {
            view.conflicts
                .push(reported(entry, &key, field, observed, declared));
        };
        macro_rules! field {
            ($fact:ident, $name:literal) => {
                if let Some(declared) = &entry.$fact {
                    match merge(&mut option.$fact, declared, &source) {
                        Merge::Applied => applied = true,
                        Merge::Same => {}
                        Merge::Differs(observed) => differs(
                            $name,
                            observed,
                            serde_json::to_value(declared).unwrap_or(Value::Null),
                        ),
                    }
                }
            };
        }
        field!(kind, "kind");
        if let Some(arity) = entry.arity {
            let equals = option
                .spellings
                .iter()
                .any(|s| s.style == super::runtime_options::ValueStyle::Equals);
            if equals && arity.max != Some(1) {
                differs("arity", json!("--flag=value"), json!(arity));
            } else {
                field!(arity, "arity");
            }
        }
        field!(repeatable, "repeatable");
        let kind = option.kind.supported().copied();
        if let Some(choices) = &entry.choices {
            if choices
                .iter()
                .all(|v| typed(kind.unwrap_or(ValueKind::Text), v))
            {
                field!(choices, "choices");
            } else {
                differs("choices", json!(kind), json!(choices));
            }
        }
        if let Some(range) = &entry.range {
            if matches!(kind, Some(ValueKind::Integer | ValueKind::Number)) {
                field!(range, "range");
            } else {
                differs("range", json!(kind), json!(range));
            }
        }
        field!(unit, "unit");
        if let Some(default) = &entry.runtime_default {
            if option.scalar(&default.literal).is_ok() {
                field!(runtime_default, "runtime_default");
            } else {
                differs("runtime_default", Value::Null, json!(default));
            }
        }
        field!(restart_required, "restart_required");
        field!(sensitive, "sensitive");
        field!(local_path, "local_path");
        if applied {
            view.applied.push(option.key.clone());
        }
    }
    for relation in &metadata.constraints {
        let (when, other) = relation.sides();
        let side = |predicate: &FlagPredicate| {
            launch_option(schema, &predicate.flag)
                .filter(|option| option.managed.is_none())
                .filter(|option| {
                    predicate
                        .equals
                        .as_ref()
                        .is_none_or(|value| option.scalar(value).is_ok())
                })
                .map(|option| Predicate {
                    key: option.key.clone(),
                    equals: predicate.equals.clone(),
                })
        };
        match (side(when), side(other)) {
            (Some(when), Some(other)) if when.key != other.key => {
                schema.constraints.push(Fact {
                    value: Some(match relation {
                        MetadataRelation::Requires { .. } => Relation::Requires { when, other },
                        MetadataRelation::Excludes { .. } => Relation::Excludes { when, other },
                    }),
                    certainty: Certainty::Documented,
                    source: Some(source.clone()),
                });
            }
            _ => {
                // The adapter's relation cannot be checked against this help.
                // Values of the option it governs are refused, not launched
                // as if the relation did not exist.
                let mut found = conflict(
                    "",
                    &when.flag,
                    "constraint",
                    Value::Null,
                    serde_json::to_value(relation).unwrap_or(Value::Null),
                );
                if let Some(option) =
                    launch_option(schema, &when.flag).filter(|option| option.managed.is_none())
                {
                    found.key = option.key.clone();
                    found.blocking = true;
                }
                view.conflicts.push(found);
            }
        }
    }
    if let Err(error) = schema.validate() {
        (schema.options, schema.constraints) = before;
        view.applied.clear();
        view.error = Some(format!("option metadata was not applied: {error}"));
        // Nothing partial applies, but declared secrecy is never lost (it
        // only hides values), and the options the metadata describes refuse
        // saved values until it is corrected.
        for entry in &metadata.options {
            let Some(index) = entry
                .target(schema)
                .filter(|index| entry.owner(&schema.options[*index]).is_none())
            else {
                continue;
            };
            let option = &mut schema.options[index];
            if entry.sensitive == Some(true) && option.sensitive.supported().is_none() {
                option.sensitive = Fact {
                    value: Some(true),
                    certainty: Certainty::Documented,
                    source: Some(source.clone()),
                };
            }
            let mut found = reported(
                entry,
                &option.key,
                "metadata",
                Value::from(error.clone()),
                entry.declared(),
            );
            found.blocking = true;
            view.conflicts.push(found);
        }
    }
    // Differences about a secret option never carry its value literals
    // (defaults, choices), whether help or the entry itself says it is secret.
    let secret = |found: &FactConflict| {
        let named = |entry: &MetadataOption| {
            entry.flag.as_deref().unwrap_or_default() == found.flag
                && entry.positional == found.positional
        };
        let option = match &found.positional {
            Some(key) => schema
                .options
                .iter()
                .find(|o| o.target == Target::Launch && o.position.is_some() && o.key == *key),
            None => launch_option(schema, &found.flag),
        };
        metadata
            .options
            .iter()
            .any(|entry| entry.sensitive == Some(true) && named(entry))
            || option.is_some_and(|option| option.sensitive.supported() == Some(&true))
    };
    for found in &mut view.conflicts {
        let secret = secret(found);
        if secret && !VALUE_FREE.contains(&found.field.as_str()) {
            found.observed = redacted(&found.observed);
            found.declared = redacted(&found.declared);
        }
    }
    view
}

/// Facts that describe syntax or handling, never a value an option holds.
const VALUE_FREE: [&str; 10] = [
    "reserved",
    "arity",
    "kind",
    "key",
    "target",
    "repeatable",
    "unit",
    "restart_required",
    "sensitive",
    "local_path",
];

/// A display copy of a declared value with literals an option may hold
/// replaced; an entry's other facts stay readable.
fn redacted(value: &Value) -> Value {
    const HIDDEN: &str = "[REDACTED]";
    match value {
        Value::Null => Value::Null,
        Value::Object(object) if object.contains_key("literal") => json!({"literal": HIDDEN}),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, item)| {
                    let item = match key.as_str() {
                        "runtime_default" | "choices" | "equals" => Value::from(HIDDEN),
                        _ => redacted_nested(item),
                    };
                    (key.clone(), item)
                })
                .collect(),
        ),
        _ => Value::from(HIDDEN),
    }
}

fn redacted_nested(value: &Value) -> Value {
    match value {
        Value::Object(_) => redacted(value),
        other => other.clone(),
    }
}

/// What applying `metadata` to a just-discovered help schema would establish
/// and which declarations it contradicts, before that help is accepted.
pub fn review(schema: &OptionSchema, metadata: &OptionMetadata, builtin: bool) -> MetadataView {
    let mut preview = schema.clone();
    apply(&mut preview, metadata, builtin, !builtin)
}

#[cfg(test)]
mod tests {
    use super::super::runtime_options::{
        HelpStream, ManagedBinding, RawHelp, SchemaBinding, ValueStyle, SCHEMA_VERSION,
    };
    use super::*;

    fn engine() -> ProviderId {
        ProviderId::parse("custom.example").unwrap()
    }

    fn observed<T>(value: T) -> Fact<T> {
        Fact {
            value: Some(value),
            certainty: Certainty::Verified,
            source: Some(Source::Help {
                document: "stdout".into(),
                start_line: 1,
                end_line: 1,
            }),
        }
    }

    fn option(key: &str, flags: &[&str], arity: Option<Arity>) -> OptionDefinition {
        let mut option: OptionDefinition = serde_json::from_value(json!({
            "key": key, "target": "launch",
            "spellings": flags.iter().map(|flag| json!({"flag": flag})).collect::<Vec<_>>()
        }))
        .unwrap();
        if let Some(arity) = arity {
            option.arity = observed(arity);
        }
        option
    }

    fn one() -> Option<Arity> {
        Some(Arity {
            min: 1,
            max: Some(1),
        })
    }

    /// Help-shaped schema: a valued option with an alias, a switch, a choice
    /// option, an option with unknown syntax and an app-owned binding.
    fn schema() -> OptionSchema {
        let mut mode = option("mode", &["--mode"], one());
        mode.choices = observed(vec![json!("fast"), json!("safe")]);
        let mut switch = option(
            "switch",
            &["--switch"],
            Some(Arity {
                min: 0,
                max: Some(0),
            }),
        );
        switch.kind = observed(ValueKind::Boolean);
        let mut port = option("port", &["--port", "-p"], one());
        port.managed = Some(ManagedBinding::Port);
        OptionSchema {
            schema_version: SCHEMA_VERSION,
            binding: SchemaBinding {
                engine: "custom.example".into(),
                runtime: "build-1".into(),
                fingerprint: "a".repeat(64),
            },
            options: vec![
                option("cache", &["--cache", "-c"], one()),
                switch,
                mode,
                option("loose", &["--loose"], None),
                port,
            ],
            constraints: vec![],
            raw_help: vec![RawHelp {
                id: "stdout".into(),
                scope: vec![],
                stream: HelpStream::Stdout,
                text: "--cache N\n".into(),
                truncated: false,
            }],
            end_of_options: Fact::default(),
        }
    }

    fn metadata(options: Value, constraints: Value) -> OptionMetadata {
        serde_json::from_value(json!({
            "version": 1, "engine_id": "custom.example",
            "adapter": {"id": "synthetic.adapter", "revision": "r1"},
            "options": options, "constraints": constraints
        }))
        .unwrap()
    }

    fn find<'a>(schema: &'a OptionSchema, key: &str) -> &'a OptionDefinition {
        schema.options.iter().find(|o| o.key == key).unwrap()
    }

    #[test]
    fn declared_facts_fill_only_unknown_facts_and_observed_syntax_wins() {
        let declared = metadata(
            json!([
                {"flag": "-c", "kind": "integer", "range": {"min": 0, "max": 64}, "unit": "MiB",
                 "restart_required": true, "runtime_default": {"literal": 8}, "arity": {"min": 2, "max": 2}},
                {"flag": "--switch", "kind": "integer", "sensitive": true},
                {"flag": "--mode", "choices": ["fast", "exact"], "runtime_default": {"literal": "exact"}},
                {"flag": "--loose", "choices": [1, 2], "kind": "text"},
                {"flag": "-p", "sensitive": true},
                {"flag": "--cache", "sensitive": true},
                {"flag": "--missing", "unit": "s"}
            ]),
            json!([
                {"kind": "requires", "when": {"flag": "--switch"}, "other": {"flag": "--cache"}},
                {"kind": "excludes", "when": {"flag": "--mode", "equals": "slow"}, "other": {"flag": "--cache"}},
                {"kind": "requires", "when": {"flag": "--switch"}, "other": {"flag": "--port"}},
                {"kind": "requires", "when": {"flag": "--switch"}, "other": {"flag": "--nowhere"}}
            ]),
        );
        // Choices of another type are refused when the entry declares a type.
        assert!(declared.validate(engine()).unwrap_err().contains("choices"));
        let mut declared = declared;
        declared.options[3].kind = None;
        declared.validate(engine()).unwrap();
        let mut schema = schema();
        let view = apply(&mut schema, &declared, false, true);
        assert_eq!(view.error, None);
        // Matched through an alias; unknown facts became adapter-documented.
        let cache = find(&schema, "cache");
        assert_eq!(cache.kind.supported(), Some(&ValueKind::Integer));
        assert_eq!(cache.unit.supported().map(String::as_str), Some("MiB"));
        assert_eq!(cache.restart_required.supported(), Some(&true));
        assert_eq!(cache.runtime_default.certainty, Certainty::Documented);
        assert!(
            matches!(&cache.unit.source, Some(Source::Adapter { id, revision }) if id == "synthetic.adapter" && revision == "r1")
        );
        // The observed value count stays; the declaration is reported.
        assert_eq!(cache.arity.supported().unwrap().min, 1);
        assert_eq!(cache.arity.certainty, Certainty::Verified);
        let switch = find(&schema, "switch");
        assert_eq!(switch.kind.supported(), Some(&ValueKind::Boolean));
        assert_eq!(switch.sensitive.supported(), Some(&true));
        let mode = find(&schema, "mode");
        assert_eq!(mode.choices.supported().unwrap().len(), 2);
        assert!(
            mode.runtime_default.supported().is_none(),
            "no default outside the observed choices"
        );
        // Numeric choices do not fit an option help leaves untyped.
        assert!(find(&schema, "loose").choices.supported().is_none());
        // App-owned bindings never take declared facts.
        assert!(find(&schema, "port").sensitive.supported().is_none());
        let fields = view
            .conflicts
            .iter()
            .map(|c| (c.flag.as_str(), c.field.as_str()))
            .collect::<BTreeSet<_>>();
        for expected in [
            ("-c", "arity"),
            ("--switch", "kind"),
            ("--mode", "choices"),
            ("--mode", "runtime_default"),
            ("--loose", "choices"),
            ("-p", "binding"),
            ("--cache", "duplicate"),
            ("--missing", "option"),
            ("--switch", "constraint"),
        ] {
            assert!(fields.contains(&expected), "{expected:?} in {fields:?}");
        }
        // Help wins every fact difference; a relation that cannot be applied
        // instead refuses values of the option it governs.
        assert!(view.conflicts.iter().all(|c| c.applies == Applies::Observed
            && c.blocking == (c.field == "constraint" && !c.key.is_empty())));
        let unapplied = view
            .conflicts
            .iter()
            .filter(|c| c.field == "constraint")
            .map(|c| (c.flag.as_str(), c.key.as_str(), c.blocking))
            .collect::<Vec<_>>();
        assert_eq!(
            unapplied,
            [
                ("--mode", "mode", true),
                ("--switch", "switch", true),
                ("--switch", "switch", true)
            ]
        );
        assert_eq!(view.applied, ["cache", "switch"]);
        // Only constraints between user options with valid operands apply.
        assert_eq!(schema.constraints.len(), 1);
        schema.validate().unwrap();
    }

    #[test]
    fn built_in_metadata_names_only_the_documented_llama_access_token() {
        let builtin = builtin(ProviderId::Llama).unwrap();
        builtin.validate(ProviderId::Llama).unwrap();
        assert_eq!(builtin.options.len(), 1);
        assert_eq!(builtin.options[0].flag.as_deref(), Some("--hf-token"));
        assert_eq!(builtin.options[0].sensitive, Some(true));
        assert!(super::builtin(ProviderId::Vllm).is_none());
        // A build without the option is not a difference worth reporting.
        let mut schema = schema();
        let view = apply(&mut schema, &builtin, true, false);
        assert!(view.conflicts.is_empty() && view.applied.is_empty() && view.builtin);
    }

    #[test]
    fn metadata_refuses_foreign_unknown_and_inconsistent_documents() {
        let good = metadata(json!([{"flag": "--cache", "unit": "MiB"}]), json!([]));
        good.validate(engine()).unwrap();
        assert!(good
            .validate(ProviderId::parse("custom.other").unwrap())
            .unwrap_err()
            .contains("another engine"));
        let mut newer = good.clone();
        newer.version = 2;
        assert!(newer.validate(engine()).unwrap_err().contains("version 2"));
        for (options, constraints, needle) in [
            (json!([]), json!([]), "declares no option"),
            (json!([{"flag": "--cache", "unit": ""}]), json!([]), "unit"),
            (
                json!([{"flag": "--cache", "unit": "a\nb"}]),
                json!([]),
                "unit",
            ),
            (
                json!([{"flag": "--cache", "arity": {"min": 3, "max": 2}}]),
                json!([]),
                "value count",
            ),
            (
                json!([{"flag": "--cache", "choices": []}]),
                json!([]),
                "choices",
            ),
            (
                json!([{"flag": "--cache", "kind": "number", "range": {"min": 2, "max": 1}}]),
                json!([]),
                "range",
            ),
            (
                json!([{"flag": "--cache", "unit": "s"}, {"flag": "--cache", "unit": "m"}]),
                json!([]),
                "distinct",
            ),
            (
                json!([{"flag": "--cache", "unit": "s"}]),
                json!([{"kind": "requires", "when": {"flag": "cache"}, "other": {"flag": "--x"}}]),
                "constraint",
            ),
        ] {
            let error = metadata(options, constraints)
                .validate(engine())
                .unwrap_err();
            assert!(error.contains(needle), "{needle}: {error}");
        }
        // Each declared literal is one argv token at most; the document as a
        // whole stays inside a readable registration.
        let wide = "x".repeat(33 * 1024 - 2); // 33 KiB as a JSON string
        for (options, constraints) in [
            (json!([{"flag": "--cache", "choices": [wide]}]), json!([])),
            (
                json!([{"flag": "--cache", "runtime_default": {"literal": wide}}]),
                json!([]),
            ),
            (
                json!([{"flag": "--cache", "unit": "s"}]),
                json!([{"kind": "requires", "when": {"flag": "--cache", "equals": wide}, "other": {"flag": "--x"}}]),
            ),
        ] {
            let error = metadata(options, constraints)
                .validate(engine())
                .unwrap_err();
            assert!(
                error.contains("33 KiB") && error.contains("32 KiB"),
                "{error}"
            );
        }
        let large = (0..8)
            .map(|i| json!({"flag": format!("--o{i}"), "choices": (0..20).map(|j| format!("{j}{}", "y".repeat(1000))).collect::<Vec<_>>()}))
            .collect::<Vec<_>>();
        assert!(metadata(json!(large), json!([]))
            .validate(engine())
            .unwrap_err()
            .contains("limited to 128 KiB"));
        let too_many = (0..257)
            .map(|i| json!({"flag": format!("--o{i}"), "unit": "s"}))
            .collect::<Vec<_>>();
        assert!(metadata(json!(too_many), json!([]))
            .validate(engine())
            .unwrap_err()
            .contains("256"));
        // Request mappings, bindings, unknown fields and null operands never
        // parse.
        for extra in [
            json!({"options": [{"flag": "--cache", "request_field": "cache"}]}),
            json!({"options": [{"flag": "--cache", "managed": "port"}]}),
            json!({"auto": true}),
            json!({"constraints": [{"kind": "requires", "when": {"flag": "--a", "equals": null}, "other": {"flag": "--b"}}]}),
        ] {
            let mut raw = serde_json::to_value(&good).unwrap();
            for (key, value) in extra.as_object().unwrap() {
                raw[key] = value.clone();
            }
            assert!(
                serde_json::from_value::<OptionMetadata>(raw).is_err(),
                "{extra}"
            );
        }
        // Equal documents have equal digests; any change changes it.
        let mut changed = good.clone();
        changed.adapter.revision = "r2".into();
        assert_eq!(good.digest(), good.clone().digest());
        assert_ne!(good.digest(), changed.digest());
    }

    #[test]
    fn an_unappliable_combination_keeps_secrecy_and_refuses_described_values() {
        // A schema this metadata cannot be combined with into a valid one
        // (here: an equals spelling with no confirmed single value).
        let mut schema = schema();
        schema.options[3].spellings[0].style = ValueStyle::Equals;
        let declared = metadata(
            json!([
                {"flag": "--loose", "sensitive": true, "unit": "s"},
                {"flag": "--cache", "restart_required": true}
            ]),
            json!([]),
        );
        let view = apply(&mut schema, &declared, false, true);
        assert!(view.error.as_deref().unwrap().contains("not applied"));
        assert!(view.applied.is_empty());
        let loose = find(&schema, "loose");
        assert_eq!(loose.sensitive.supported(), Some(&true));
        assert!(loose.unit.supported().is_none());
        assert!(find(&schema, "cache")
            .restart_required
            .supported()
            .is_none());
        for key in ["loose", "cache"] {
            assert!(
                view.conflicts
                    .iter()
                    .any(|c| c.key == key && c.field == "metadata" && c.blocking),
                "{key}: {:?}",
                view.conflicts
            );
        }
    }

    #[test]
    fn differences_of_a_secret_entry_never_carry_its_literals() {
        let declared = metadata(
            json!([
                {"flag": "--mode", "sensitive": true, "runtime_default": {"literal": "hidden-default-synthetic"}},
                {"flag": "--missing", "sensitive": true, "choices": ["hidden-choice-synthetic"]}
            ]),
            json!([]),
        );
        let view = review(&schema(), &declared, false);
        let text = serde_json::to_string(&view.conflicts).unwrap();
        assert!(view.conflicts.iter().any(|c| c.field == "runtime_default"));
        assert!(view.conflicts.iter().any(|c| c.field == "option"));
        for literal in ["hidden-default-synthetic", "hidden-choice-synthetic"] {
            assert!(!text.contains(literal), "{text}");
        }
    }

    #[test]
    fn review_previews_without_changing_the_discovered_schema() {
        let declared = metadata(json!([{"flag": "--cache", "sensitive": true}]), json!([]));
        let discovered = schema();
        let view = review(&discovered, &declared, false);
        assert_eq!(view.applied, ["cache"]);
        assert!(find(&discovered, "cache").sensitive.supported().is_none());
    }

    /// `schema()` plus help positionals: a slot whose role the user has not
    /// confirmed yet, an unmanaged slot and a slot an app binding owns.
    fn positional_schema() -> OptionSchema {
        let slot = |key: &str, position: u16, managed: Option<ManagedBinding>| {
            let mut option: OptionDefinition = serde_json::from_value(json!({
                "key": key, "target": "launch", "position": position
            }))
            .unwrap();
            option.arity = observed(Arity {
                min: 1,
                max: Some(1),
            });
            option.managed = managed;
            option
        };
        let mut schema = schema();
        schema.options.extend([
            slot("marker", 0, Some(ManagedBinding::Discovery)),
            slot("plain", 1, None),
            slot("model_path", 2, Some(ManagedBinding::Model)),
        ]);
        schema.validate().unwrap();
        schema
    }

    fn selectors(view: &MetadataView) -> BTreeSet<(String, String, String)> {
        view.conflicts
            .iter()
            .map(|c| {
                let wire = serde_json::to_value(c).unwrap();
                (
                    c.flag.clone(),
                    wire["positional"].as_str().unwrap_or("").to_owned(),
                    c.field.clone(),
                )
            })
            .collect()
    }

    #[test]
    fn a_positional_declaration_attaches_only_to_the_observed_slot_it_names() {
        let declared = metadata(
            json!([
                {"positional": "marker", "sensitive": true},
                {"positional": "plain", "unit": "files", "arity": {"min": 2, "max": 2}},
                {"positional": "model_path", "sensitive": true},
                {"positional": "cache", "sensitive": true},
                {"positional": "absent", "sensitive": true},
                {"flag": "--switch", "sensitive": true}
            ]),
            json!([]),
        );
        declared.validate(engine()).unwrap();
        let mut schema = positional_schema();
        let view = apply(&mut schema, &declared, false, true);
        assert_eq!(view.error, None);
        // Documented by the adapter on exactly the named slot; its role
        // stays for the user to confirm and it gains no spelling.
        let marker = find(&schema, "marker");
        assert_eq!(marker.sensitive.supported(), Some(&true));
        assert_eq!(marker.sensitive.certainty, Certainty::Documented);
        assert!(
            matches!(&marker.sensitive.source, Some(Source::Adapter { id, revision }) if id == "synthetic.adapter" && revision == "r1")
        );
        assert_eq!(marker.managed, Some(ManagedBinding::Discovery));
        assert!(marker.spellings.is_empty());
        // The neighbouring slot takes only its own declaration; observed
        // syntax wins over a contradictory value count.
        let plain = find(&schema, "plain");
        assert!(plain.sensitive.supported().is_none());
        assert_eq!(plain.unit.supported().map(String::as_str), Some("files"));
        assert_eq!(plain.arity.supported().unwrap().max, Some(1));
        assert_eq!(plain.arity.certainty, Certainty::Verified);
        // An app binding, a flag option with the same key and an absent
        // key take nothing.
        assert!(find(&schema, "model_path").sensitive.supported().is_none());
        assert!(find(&schema, "cache").sensitive.supported().is_none());
        assert!(find(&schema, "cache").position.is_none());
        assert_eq!(find(&schema, "switch").sensitive.supported(), Some(&true));
        let found = selectors(&view);
        for expected in [
            ("", "plain", "arity"),
            ("", "model_path", "binding"),
            ("", "cache", "option"),
            ("", "absent", "option"),
        ] {
            let expected = (
                expected.0.to_owned(),
                expected.1.to_owned(),
                expected.2.to_owned(),
            );
            assert!(found.contains(&expected), "{expected:?} in {found:?}");
        }
        assert_eq!(found.len(), 4, "{found:?}");
        assert!(view
            .conflicts
            .iter()
            .all(|c| c.applies == Applies::Observed && !c.blocking));
        assert_eq!(view.applied, ["marker", "plain", "switch"]);
        // Built-in metadata stays silent about absent positionals too.
        let mut quiet = positional_schema();
        let view = apply(&mut quiet, &declared, true, false);
        assert!(!selectors(&view)
            .iter()
            .any(|(_, _, field)| field == "option"));
    }

    #[test]
    fn a_positional_declaration_without_sensitivity_leaves_it_unknown() {
        let declared = metadata(
            json!([{"positional": "marker", "unit": "entries"}]),
            json!([]),
        );
        declared.validate(engine()).unwrap();
        let mut schema = positional_schema();
        let view = apply(&mut schema, &declared, false, true);
        assert_eq!(view.applied, ["marker"]);
        let marker = find(&schema, "marker");
        assert!(marker.sensitive.supported().is_none());
        assert_eq!(marker.sensitive.certainty, Certainty::Unknown);
    }

    #[test]
    fn an_unappliable_combination_keeps_a_declared_positional_secret() {
        let mut schema = positional_schema();
        schema.options[3].spellings[0].style = ValueStyle::Equals;
        let declared = metadata(
            json!([
                {"positional": "marker", "sensitive": true, "unit": "s"},
                {"flag": "--loose", "unit": "s"}
            ]),
            json!([]),
        );
        let view = apply(&mut schema, &declared, false, true);
        assert!(view.error.is_some());
        let marker = find(&schema, "marker");
        assert_eq!(marker.sensitive.supported(), Some(&true));
        assert!(marker.unit.supported().is_none());
        assert!(selectors(&view).contains(&("".into(), "marker".into(), "metadata".into())));
    }

    #[test]
    fn differences_of_a_secret_positional_never_carry_its_literals() {
        let declared = metadata(
            json!([
                {"positional": "plain", "sensitive": true, "kind": "text",
                 "runtime_default": {"literal": "hidden-positional-default"}, "arity": {"min": 3, "max": 3}},
                {"positional": "absent", "sensitive": true, "choices": ["hidden-positional-choice"]}
            ]),
            json!([]),
        );
        declared.validate(engine()).unwrap();
        let view = review(&positional_schema(), &declared, false);
        let text = serde_json::to_string(&view.conflicts).unwrap();
        assert!(view.conflicts.iter().any(|c| c.field == "option"));
        for literal in ["hidden-positional-default", "hidden-positional-choice"] {
            assert!(!text.contains(literal), "{text}");
        }
    }

    #[test]
    fn each_entry_names_exactly_one_valid_distinct_target() {
        let refused = |options: Value| {
            serde_json::from_value::<OptionMetadata>(json!({
                "version": 1, "engine_id": "custom.example",
                "adapter": {"id": "synthetic.adapter", "revision": "r1"},
                "options": options
            }))
            .map_err(|error| error.to_string())
            .and_then(|metadata| metadata.validate(engine()))
            .unwrap_err()
        };
        for (options, needle) in [
            (
                json!([{"flag": "--cache", "positional": "cache", "sensitive": true}]),
                "exactly one",
            ),
            (json!([{"sensitive": true}]), "exactly one"),
            (
                json!([{"positional": "-marker", "sensitive": true}]),
                "positional",
            ),
            (
                json!([{"positional": "/marker", "sensitive": true}]),
                "positional",
            ),
            (json!([{"positional": "", "sensitive": true}]), "positional"),
            (
                json!([{"positional": "two words", "sensitive": true}]),
                "positional",
            ),
            (
                json!([{"positional": "x".repeat(129), "sensitive": true}]),
                "positional",
            ),
            (
                json!([{"positional": "marker", "sensitive": true}, {"positional": "marker", "unit": "s"}]),
                "distinct",
            ),
            (
                json!([{"positional": "marker", "reserved": "the app owns it"}]),
                "reserved",
            ),
            (json!([{"positional": "marker"}]), "no fact"),
        ] {
            let error = refused(options.clone());
            assert!(error.contains(needle), "{options}: {error}");
        }
        // A flag spelling and a positional key are separate namespaces.
        metadata(
            json!([{"flag": "--marker", "unit": "s"}, {"positional": "marker", "sensitive": true}]),
            json!([]),
        )
        .validate(engine())
        .unwrap();
        // Constraints still name flag spellings only.
        assert!(serde_json::from_value::<OptionMetadata>(json!({
            "version": 1, "engine_id": "custom.example",
            "adapter": {"id": "synthetic.adapter", "revision": "r1"},
            "constraints": [{"kind": "requires", "when": {"positional": "marker"}, "other": {"flag": "--cache"}}]
        }))
        .is_err());
    }

    #[test]
    fn flag_only_documents_keep_their_exact_bytes_digest_and_differences() {
        let text = r#"{"version":1,"engine_id":"custom.example","adapter":{"id":"synthetic.adapter","revision":"r1"},"options":[{"flag":"--cache","kind":"integer","unit":"MiB"},{"flag":"--switch","sensitive":true}],"constraints":[{"kind":"requires","when":{"flag":"--switch"},"other":{"flag":"--cache"}}]}"#;
        let parsed: OptionMetadata = serde_json::from_str(text).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), text);
        assert_eq!(parsed.digest(), FLAG_ONLY_DIGEST);
        let llama = builtin(ProviderId::Llama).unwrap();
        assert_eq!(
            serde_json::to_string(&llama).unwrap(),
            r#"{"version":1,"engine_id":"llama.cpp","adapter":{"id":"llama.cpp","revision":"aiolm-builtin-1"},"options":[{"flag":"--hf-token","sensitive":true}]}"#
        );
        assert_eq!(llama.digest(), LLAMA_BUILTIN_DIGEST);
        // A flag declaration's difference keeps its earlier wire shape.
        let view = review(
            &schema(),
            &metadata(json!([{"flag": "--missing", "unit": "s"}]), json!([])),
            false,
        );
        assert_eq!(
            serde_json::to_value(&view.conflicts).unwrap(),
            json!([{"key": "", "flag": "--missing", "field": "option", "observed": null,
                    "declared": {"unit": "s"}, "declared_by": "synthetic.adapter r1",
                    "applies": "observed", "blocking": false}])
        );
    }

    /// Digests of flag-only documents before positional declarations existed.
    const FLAG_ONLY_DIGEST: &str =
        "9ed3724b1747c95b8ef7fa80f75a92012020529bb56a8bdfbd6f61910c600c7a";
    const LLAMA_BUILTIN_DIGEST: &str =
        "a9c26ab5bf24a9346323773cccd30e2b2029d8cc0cee3c00e9f71a4d39d50d3c";

    #[test]
    fn an_equals_spelling_keeps_its_single_value() {
        let mut schema = schema();
        schema.options[0].spellings[0].style = ValueStyle::Equals;
        let declared = metadata(
            json!([{"flag": "--cache", "arity": {"min": 1, "max": 2}}]),
            json!([]),
        );
        let view = apply(&mut schema, &declared, false, true);
        assert!(view.conflicts.iter().any(|c| c.field == "arity"));
        assert_eq!(
            find(&schema, "cache").arity.supported().unwrap().max,
            Some(1)
        );
    }
}
