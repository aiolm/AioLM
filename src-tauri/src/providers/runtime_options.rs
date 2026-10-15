//! Versioned option descriptions shared by discovery, editors and execution.
//!
//! Help describes command syntax, not a protocol. Unknown facts stay unknown;
//! only supported, sourced facts constrain values or generate arguments. This
//! module never starts a shell, emits inherited defaults, or edits saved values.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_SCHEMA_BYTES: usize = 3 * 1024 * 1024;
const MAX_HELP_BYTES: usize = 2 * 1024 * 1024;
const MAX_OPTIONS: usize = 4096;
const MAX_ARGUMENTS: usize = 512;
const MAX_ARGUMENT_BYTES: usize = 32_768;
const MAX_VALUES_BYTES: usize = 131_072;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Certainty {
    #[default]
    Unknown,
    Documented,
    Verified,
    UserConfirmed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    Help {
        document: String,
        start_line: u32,
        end_line: u32,
    },
    Adapter {
        id: String,
        revision: String,
    },
    User {
        note: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fact<T> {
    pub value: Option<T>,
    pub certainty: Certainty,
    pub source: Option<Source>,
}

impl<T> Default for Fact<T> {
    fn default() -> Self {
        Self {
            value: None,
            certainty: Certainty::Unknown,
            source: None,
        }
    }
}

impl<T> Fact<T> {
    /// An unconfirmed interpretation may be retained for display, but cannot
    /// become a validation rule, runtime default or launch instruction.
    pub fn supported(&self) -> Option<&T> {
        (self.certainty != Certainty::Unknown)
            .then_some(self.value.as_ref())
            .flatten()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaBinding {
    pub engine: String,
    pub runtime: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawHelp {
    pub id: String,
    pub scope: Vec<String>,
    pub stream: HelpStream,
    pub text: String,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelpStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueKind {
    Boolean,
    Integer,
    Number,
    Text,
    Tokens,
    Json,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Arity {
    pub min: u16,
    /// None means a documented variable number of values, not unknown arity.
    pub max: Option<u16>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueStyle {
    #[default]
    Separate,
    Equals,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spelling {
    pub flag: String,
    #[serde(default)]
    pub style: ValueStyle,
    /// Explicit paired boolean semantics, never guessed from an option name.
    #[serde(default)]
    pub polarity: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Launch,
    Request,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedBinding {
    Model,
    Host,
    Port,
    Authentication,
    Discovery,
    /// Spelled by the registered entry point's fixed prefix (for example a
    /// serving layer's `--engine strata`); re-setting it would launch
    /// something other than what was registered and probed.
    EntryPoint,
    /// Reserved by the engine's adapter metadata because the app owns that
    /// behavior (model lifecycle, tool servers).
    Reserved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NumericRange {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// A wrapper keeps a documented JSON null distinct from an unknown default.
/// `Option<Value>` alone would deserialize both as None.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDefault {
    pub literal: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionDefinition {
    /// Unique within the schema; the same flag in another subcommand gets a
    /// different key, so profiles never conflate their values.
    pub key: String,
    #[serde(default)]
    pub scope: Vec<String>,
    #[serde(default)]
    pub spellings: Vec<Spelling>,
    #[serde(default)]
    pub position: Option<u16>,
    #[serde(default)]
    pub kind: Fact<ValueKind>,
    #[serde(default)]
    pub arity: Fact<Arity>,
    #[serde(default)]
    pub repeatable: Fact<bool>,
    #[serde(default)]
    pub choices: Fact<Vec<Value>>,
    #[serde(default)]
    pub range: Fact<NumericRange>,
    #[serde(default)]
    pub unit: Fact<String>,
    #[serde(default)]
    pub runtime_default: Fact<RuntimeDefault>,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub help: String,
    pub target: Target,
    /// A request field requires protocol/adapter metadata, never help alone.
    #[serde(default)]
    pub request_field: Fact<String>,
    #[serde(default)]
    pub restart_required: Fact<bool>,
    #[serde(default)]
    pub sensitive: Fact<bool>,
    #[serde(default)]
    pub local_path: Fact<bool>,
    #[serde(default)]
    pub managed: Option<ManagedBinding>,
    #[serde(default)]
    pub raw_spans: Vec<Source>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Predicate {
    pub key: String,
    /// None tests an explicit occurrence. A value tests a single-value
    /// occurrence, so a dependency can apply to true without applying to false.
    /// An absent field means None; an explicit JSON `null` is refused while
    /// parsing instead of silently becoming an occurrence test.
    #[serde(
        default,
        deserialize_with = "explicit_operand",
        skip_serializing_if = "Option::is_none"
    )]
    pub equals: Option<Value>,
}

pub(crate) fn explicit_operand<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::Null => Err(serde::de::Error::custom(
            "a null constraint operand is not supported; omit `equals` to test an occurrence",
        )),
        value => Ok(Some(value)),
    }
}

/// Operands compare by the option's documented type, so `1` and `1.0` are the
/// same number while `"true"` never equals `true`.
fn same_operand(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Relation {
    Requires { when: Predicate, other: Predicate },
    Excludes { when: Predicate, other: Predicate },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionSchema {
    pub schema_version: u32,
    pub binding: SchemaBinding,
    pub options: Vec<OptionDefinition>,
    #[serde(default)]
    pub constraints: Vec<Fact<Relation>>,
    #[serde(default)]
    pub raw_help: Vec<RawHelp>,
    #[serde(default)]
    pub end_of_options: Fact<bool>,
}

/// Occurrence boundaries are retained even for repeated tuples. Missing map
/// entries inherit; [[false]], [[0]], [[""]] and [[]] remain distinct.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Override {
    #[serde(default)]
    pub spelling: Option<String>,
    pub occurrences: Vec<Vec<Value>>,
}

pub type Overrides = BTreeMap<String, Override>;

/// One occurrence with the alias it is spelled with (None: the default).
/// Ordered plans validate each occurrence with its own alias; grouped
/// overrides give every occurrence the shared one.
pub(crate) type Occurrence = (Option<String>, Vec<Value>);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OptionIssue {
    pub key: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedOptions {
    /// Internal emission boundaries; never inferred by searching token text.
    #[serde(skip)]
    pub(crate) scope_boundaries: Vec<usize>,
    pub argv: Vec<String>,
    pub request: Map<String, Value>,
}

impl ResolvedOptions {
    pub(crate) fn sections(&self, scope: &[String]) -> Result<Vec<Vec<String>>, String> {
        if self.scope_boundaries.len() != scope.len() {
            return Err("resolved scope boundaries do not match the command layout".into());
        }
        let mut start = 0;
        let mut sections = Vec::new();
        for (depth, index) in self.scope_boundaries.iter().copied().enumerate() {
            if index < start || self.argv.get(index) != Some(&scope[depth]) {
                return Err("resolved scope boundary is invalid".into());
            }
            sections.push(self.argv[start..index].to_vec());
            start = index + 1;
        }
        sections.push(self.argv[start..].to_vec());
        Ok(sections)
    }
}

fn bounded_text(value: &str, max: usize) -> bool {
    value.len() <= max && !value.contains('\0')
}

pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
}

pub(crate) fn valid_scope(scope: &[String]) -> bool {
    scope.len() <= 8
        && scope
            .iter()
            .all(|s| identifier(s) && !s.starts_with(['-', '/']) && !s.contains('/'))
}

impl OptionSchema {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_SCHEMA_BYTES {
            return Err("runtime option schema exceeds 3 MiB".into());
        }
        let schema: Self = serde_json::from_slice(bytes)
            .map_err(|e| format!("invalid runtime option schema: {e}"))?;
        schema.validate()?;
        Ok(schema)
    }

    fn source(&self, source: &Source) -> Result<(), String> {
        let valid = match source {
            Source::Help {
                document,
                start_line,
                end_line,
            } => self.raw_help.iter().any(|help| {
                help.id == *document
                    && *start_line > 0
                    && end_line >= start_line
                    && *end_line as usize <= help.text.lines().count()
            }),
            Source::Adapter { id, revision } => {
                identifier(id) && !revision.is_empty() && bounded_text(revision, 256)
            }
            Source::User { note } => !note.is_empty() && bounded_text(note, 1024),
        };
        valid
            .then_some(())
            .ok_or_else(|| "option fact has an invalid source or raw-help span".into())
    }

    fn fact<T>(&self, fact: &Fact<T>) -> Result<(), String> {
        if fact.certainty != Certainty::Unknown && (fact.value.is_none() || fact.source.is_none()) {
            return Err("supported option facts need a value and source".into());
        }
        if let Some(source) = &fact.source {
            self.source(source)?;
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "unsupported runtime option schema version {}; this app supports {SCHEMA_VERSION}",
                self.schema_version
            ));
        }
        if !identifier(&self.binding.engine)
            || !identifier(&self.binding.runtime)
            || self.binding.fingerprint.len() != 64
            || !self
                .binding
                .fingerprint
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err("option schema needs an engine, runtime and SHA-256 fingerprint".into());
        }
        if self.options.len() > MAX_OPTIONS || self.constraints.len() > MAX_OPTIONS {
            return Err("runtime option schema exceeds its option/constraint limit".into());
        }
        if self.raw_help.iter().map(|h| h.text.len()).sum::<usize>() > MAX_HELP_BYTES {
            return Err("runtime option schema raw help exceeds 2 MiB".into());
        }
        let mut documents = BTreeSet::new();
        for help in &self.raw_help {
            if !identifier(&help.id) || !valid_scope(&help.scope) || !documents.insert(&help.id) {
                return Err("invalid or duplicate raw-help document".into());
            }
        }
        self.fact(&self.end_of_options)?;
        let mut keys = BTreeSet::new();
        let mut flags = BTreeSet::new();
        let mut positions = BTreeSet::new();
        let mut request_fields = BTreeSet::new();
        for option in &self.options {
            if !identifier(&option.key)
                || !valid_scope(&option.scope)
                || !keys.insert(&option.key)
                || !bounded_text(&option.help, 32_768)
                || !bounded_text(&option.group, 256)
            {
                return Err("invalid or duplicate runtime option identity".into());
            }
            self.fact(&option.kind)?;
            self.fact(&option.arity)?;
            self.fact(&option.repeatable)?;
            self.fact(&option.choices)?;
            self.fact(&option.range)?;
            self.fact(&option.unit)?;
            self.fact(&option.runtime_default)?;
            self.fact(&option.request_field)?;
            self.fact(&option.restart_required)?;
            self.fact(&option.sensitive)?;
            self.fact(&option.local_path)?;
            for span in &option.raw_spans {
                self.source(span)?;
            }
            if let Some(arity) = option.arity.supported() {
                if arity.min > 256 || arity.max.is_some_and(|n| n < arity.min || n > 256) {
                    return Err(format!("{}: invalid arity", option.key));
                }
            }
            if let Some(choices) = option.choices.supported() {
                if choices.len() > 256
                    || choices
                        .iter()
                        .any(|v| v.is_array() || v.is_object() || v.is_null())
                {
                    return Err(format!("{}: invalid documented choices", option.key));
                }
            }
            if let Some(range) = option.range.supported() {
                if !matches!(
                    option.kind.supported(),
                    Some(ValueKind::Integer | ValueKind::Number)
                ) || range.min.is_some_and(|n| !n.is_finite())
                    || range.max.is_some_and(|n| !n.is_finite())
                    || matches!((range.min, range.max), (Some(a), Some(b)) if a > b)
                {
                    return Err(format!("{}: invalid numeric range", option.key));
                }
            }
            match option.target {
                Target::Request => {
                    let field = option.request_field.supported().ok_or_else(|| {
                        format!(
                            "{}: request fields need explicit protocol metadata",
                            option.key
                        )
                    })?;
                    if !identifier(field)
                        || !matches!(option.request_field.source, Some(Source::Adapter { .. }))
                        || !request_fields.insert(field)
                        || !option.spellings.is_empty()
                        || option.position.is_some()
                    {
                        return Err(format!("{}: invalid request mapping", option.key));
                    }
                }
                Target::Launch => {
                    if option.request_field.value.is_some()
                        || (option.position.is_some() == !option.spellings.is_empty())
                    {
                        return Err(format!("{}: choose flags or a positional slot", option.key));
                    }
                    if let Some(position) = option.position {
                        if !positions.insert((&option.scope, position)) {
                            return Err("duplicate scoped positional slot".into());
                        }
                    }
                    for spelling in &option.spellings {
                        let body = spelling.flag.trim_start_matches(['-', '/']);
                        if !spelling.flag.starts_with(['-', '/'])
                            || body.is_empty()
                            || !body
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_-.?".contains(&b))
                            || !flags.insert((&option.scope, &spelling.flag))
                            || (spelling.style == ValueStyle::Equals
                                && !option.arity.supported().is_some_and(|a| a.max == Some(1)))
                            || (spelling.polarity.is_some()
                                && !(option.kind.supported() == Some(&ValueKind::Boolean)
                                    && option.arity.supported().is_some_and(|a| a.max == Some(0))))
                        {
                            return Err(format!(
                                "{}: invalid or conflicting flag spelling",
                                option.key
                            ));
                        }
                    }
                }
            }
        }
        for constraint in &self.constraints {
            self.fact(constraint)?;
            if let Some(relation) = constraint.supported() {
                let (Relation::Requires { when, other } | Relation::Excludes { when, other }) =
                    relation;
                if !keys.contains(&when.key) || !keys.contains(&other.key) {
                    return Err("constraint refers to an unknown option".into());
                }
                // Parsing already refuses `"equals": null`; a constructed
                // Some(Null) is refused here for the same reason. An operand
                // must be a value the option could actually hold, otherwise
                // the constraint could never fire and would mean nothing.
                for predicate in [when, other] {
                    let Some(expected) = &predicate.equals else {
                        continue;
                    };
                    let option = self
                        .options
                        .iter()
                        .find(|o| o.key == predicate.key)
                        .expect("constraint keys were checked");
                    if expected.is_null() || option.scalar(expected).is_err() {
                        return Err(format!(
                            "{}: constraint operand does not match the option's documented values",
                            predicate.key
                        ));
                    }
                }
            }
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > MAX_SCHEMA_BYTES {
            return Err("runtime option schema exceeds 3 MiB".into());
        }
        Ok(())
    }

    pub fn resolve(
        &self,
        selected_scope: &[String],
        overrides: &Overrides,
    ) -> Result<ResolvedOptions, Vec<OptionIssue>> {
        let occurrences = overrides
            .iter()
            .map(|(key, value)| (key.clone(), value.rows()))
            .collect();
        self.resolve_occurrences(selected_scope, &occurrences)
    }

    /// Grouped resolution where each occurrence keeps its own alias. Order
    /// across options follows the schema; `runtime_ordered` re-emits plans.
    pub(crate) fn resolve_occurrences(
        &self,
        selected_scope: &[String],
        overrides: &BTreeMap<String, Vec<Occurrence>>,
    ) -> Result<ResolvedOptions, Vec<OptionIssue>> {
        if let Err(message) = self.validate() {
            return Err(vec![OptionIssue {
                key: String::new(),
                message,
            }]);
        }
        if overrides.len() > MAX_OPTIONS {
            return Err(vec![OptionIssue {
                key: String::new(),
                message: "too many saved runtime options".into(),
            }]);
        }
        if !valid_scope(selected_scope) {
            return Err(vec![OptionIssue {
                key: String::new(),
                message: "invalid selected subcommand".into(),
            }]);
        }
        let mut issues = Vec::new();
        let mut emitted = BTreeMap::new();
        let mut request = Map::new();
        for (key, value) in overrides {
            let issue = |message| OptionIssue {
                key: key.clone(),
                message,
            };
            let Some(option) = self.options.iter().find(|o| o.key == *key) else {
                issues.push(issue(
                    "saved option is absent from this schema; review the runtime change".into(),
                ));
                continue;
            };
            if !selected_scope.starts_with(&option.scope) {
                issues.push(issue(
                    "option belongs to another subcommand; its saved value was retained".into(),
                ));
                continue;
            }
            if let Some(binding) = option.managed {
                issues.push(issue(match binding {
                    ManagedBinding::EntryPoint => "this option is fixed by the registered entry point; its saved value was retained. Register another entry point to change it".into(),
                    ManagedBinding::Reserved => "the engine's adapter reserves this option for the app; its saved value was retained".into(),
                    ManagedBinding::Discovery if option.position.is_some() => "this positional's place in the launch command is not mapped; confirm its role in the reviewed help first. Its saved value was retained".into(),
                    _ => "this option is managed by the app; use its binding control".into(),
                }));
                continue;
            }
            match option.resolve_rows(value) {
                Ok(arguments) => {
                    if option.target == Target::Request {
                        let field = option.request_field.supported().expect("schema validated");
                        if value.len() != 1 || value[0].1.len() != 1 {
                            issues.push(issue(
                                "request mapping needs exactly one explicit value".into(),
                            ));
                        } else {
                            request.insert(field.clone(), value[0].1[0].clone());
                        }
                    } else {
                        emitted.insert(key, arguments);
                    }
                }
                Err(message) => issues.push(issue(message)),
            }
        }
        let matches = |predicate: &Predicate| {
            overrides.get(&predicate.key).is_some_and(|rows| {
                !rows.is_empty()
                    && predicate.equals.as_ref().is_none_or(|expected| {
                        rows.iter()
                            .any(|(_, row)| row.len() == 1 && same_operand(&row[0], expected))
                    })
            })
        };
        for constraint in &self.constraints {
            match constraint.supported() {
                Some(Relation::Requires { when, other }) if matches(when) && !matches(other) => {
                    issues.push(OptionIssue {
                        key: when.key.clone(),
                        message: format!("requires the documented value of {}", other.key),
                    });
                }
                Some(Relation::Excludes { when, other }) if matches(when) && matches(other) => {
                    issues.push(OptionIssue {
                        key: when.key.clone(),
                        message: format!("cannot be combined with {}", other.key),
                    });
                }
                _ => {}
            }
        }
        let mut argv = Vec::new();
        let mut scope_boundaries = Vec::new();
        for depth in 0..=selected_scope.len() {
            if depth > 0 {
                scope_boundaries.push(argv.len());
                argv.push(selected_scope[depth - 1].clone());
            }
            let mut positional = Vec::new();
            for option in &self.options {
                if option.scope != selected_scope[..depth] {
                    continue;
                }
                let Some(arguments) = emitted.remove(&option.key) else {
                    continue;
                };
                if let Some(position) = option.position {
                    positional.push((position, &option.key, arguments));
                } else {
                    argv.extend(arguments);
                }
            }
            positional.sort_by_key(|(position, _, _)| *position);
            // Omitting an earlier positional would silently bind a later saved
            // value to the wrong slot. Defaults do not prove that argv may skip it.
            // A slot whose confirmed role gives it to the launch template (a
            // binding or an entry token) is filled before user values.
            if let Some((last, _, _)) = positional.last() {
                for earlier in self.options.iter().filter(|o| {
                    o.scope == selected_scope[..depth]
                        && o.position.is_some_and(|p| p < *last)
                        && o.managed.is_none_or(|m| m == ManagedBinding::Discovery)
                }) {
                    if !positional
                        .iter()
                        .any(|(_, key, args)| **key == earlier.key && !args.is_empty())
                    {
                        issues.push(OptionIssue {
                            key: earlier.key.clone(),
                            message:
                                "an earlier positional value must be supplied before this slot"
                                    .into(),
                        });
                    }
                }
            }
            // Only the last supplied positional may take a varying number of
            // values; otherwise the parser could not tell where it ends.
            let varying = |key: &str| {
                self.options.iter().any(|o| {
                    o.key == key
                        && (o.repeatable.supported() == Some(&true)
                            || o.arity.supported().is_none_or(|a| a.max != Some(a.min)))
                })
            };
            if let Some((_, earlier)) = positional.split_last() {
                if let Some((_, key, _)) = earlier.iter().find(|(_, key, _)| varying(key)) {
                    issues.push(OptionIssue {
                        key: (*key).clone(),
                        message: "a positional with a varying value count must be the last positional supplied".into(),
                    });
                }
            }
            if positional
                .iter()
                .any(|(_, _, args)| args.iter().any(|s| s.starts_with('-')))
            {
                if depth != selected_scope.len() || self.end_of_options.supported() != Some(&true) {
                    issues.push(OptionIssue { key: positional[0].1.clone(), message: "leading-dash positional values need an explicitly supported end-of-options delimiter".into() });
                } else {
                    argv.push("--".into());
                }
            }
            for (_, _, arguments) in positional {
                argv.extend(arguments);
            }
        }
        if argv.len() > MAX_ARGUMENTS
            || argv.iter().map(String::len).sum::<usize>() > MAX_VALUES_BYTES
        {
            issues.push(OptionIssue {
                key: String::new(),
                message: "runtime option arguments exceed their size limit".into(),
            });
        }
        if issues.is_empty() {
            Ok(ResolvedOptions {
                argv,
                request,
                scope_boundaries,
            })
        } else {
            Err(issues)
        }
    }
}

impl OptionDefinition {
    pub(crate) fn scalar(&self, value: &Value) -> Result<String, String> {
        let valid = match self.kind.supported() {
            Some(ValueKind::Boolean) => value.is_boolean(),
            Some(ValueKind::Integer) => value.as_i64().is_some(),
            Some(ValueKind::Number) => value.as_f64().is_some_and(f64::is_finite),
            Some(ValueKind::Json) => true,
            Some(ValueKind::Text | ValueKind::Tokens) | None => value.is_string(),
        };
        if !valid {
            return Err(
                "value does not match the documented type; unknown types accept text tokens only"
                    .into(),
            );
        }
        if self
            .choices
            .supported()
            .is_some_and(|choices| !choices.contains(value))
        {
            return Err("value is outside the documented choices".into());
        }
        if let Some(range) = self.range.supported() {
            let number = value.as_f64().ok_or("numeric range requires a number")?;
            if range.min.is_some_and(|n| number < n) || range.max.is_some_and(|n| number > n) {
                return Err("value is outside the documented numeric range".into());
            }
        }
        let text = if self.kind.supported() == Some(&ValueKind::Json) {
            serde_json::to_string(value).map_err(|e| e.to_string())?
        } else if let Some(text) = value.as_str() {
            text.to_owned()
        } else {
            value.to_string()
        };
        if !bounded_text(&text, MAX_ARGUMENT_BYTES) {
            return Err("option value contains NUL or exceeds its size limit".into());
        }
        Ok(text)
    }

    /// Validate and serialize occurrences in the given order, each with its
    /// own alias.
    fn resolve_rows(&self, rows: &[Occurrence]) -> Result<Vec<String>, String> {
        if rows.len() > 128 || (rows.len() > 1 && self.repeatable.supported() != Some(&true)) {
            return Err("repetition needs explicit supported metadata".into());
        }
        let arity = if self.target == Target::Request {
            Arity {
                min: 1,
                max: Some(1),
            }
        } else {
            *self.arity.supported().ok_or("arity is unknown; confirm the value count or provide adapter metadata before generating argv")?
        };
        let mut args = Vec::new();
        for (saved_spelling, row) in rows {
            let chosen = match saved_spelling {
                Some(flag) => Some(
                    self.spellings
                        .iter()
                        .find(|s| s.flag == *flag)
                        .ok_or("saved alias is absent from this schema")?,
                ),
                None => self.spellings.first(),
            };
            if row.len() > 256 {
                return Err("too many option values".into());
            }
            if self.kind.supported() == Some(&ValueKind::Boolean) && arity.max == Some(0) {
                if row.len() != 1 {
                    return Err("a boolean switch needs an explicit true or false".into());
                }
                self.scalar(&row[0])?;
                let enabled = row[0].as_bool().expect("boolean validated");
                let spelling = if saved_spelling.is_some() {
                    chosen.filter(|s| s.polarity.unwrap_or(true) == enabled)
                } else {
                    self.spellings
                        .iter()
                        .find(|s| s.polarity.unwrap_or(true) == enabled)
                };
                if let Some(spelling) = spelling {
                    args.push(spelling.flag.clone());
                } else if !enabled
                    && self
                        .runtime_default
                        .supported()
                        .is_some_and(|v| v.literal == Value::Bool(false))
                    && saved_spelling.is_none()
                {
                    // Only a sourced false default proves omission is an opt-out.
                } else {
                    return Err(
                        "this runtime has no confirmed spelling for the explicit boolean value"
                            .into(),
                    );
                }
                continue;
            }
            if row.len() < usize::from(arity.min)
                || arity.max.is_some_and(|n| row.len() > usize::from(n))
            {
                return Err("value count does not match the documented arity".into());
            }
            let values = row
                .iter()
                .map(|v| self.scalar(v))
                .collect::<Result<Vec<_>, _>>()?;
            if self.target == Target::Request {
                continue;
            }
            if let Some(spelling) = chosen {
                if spelling.style == ValueStyle::Equals && !values.is_empty() {
                    args.push(format!("{}={}", spelling.flag, values[0]));
                } else {
                    if row
                        .iter()
                        .zip(&values)
                        .any(|(v, text)| v.is_string() && text.starts_with('-'))
                    {
                        return Err("a flag-like text value needs a confirmed equals spelling to keep its boundary unambiguous".into());
                    }
                    args.push(spelling.flag.clone());
                    args.extend(values);
                }
            } else {
                args.extend(values);
            }
        }
        Ok(args)
    }

    /// Validate and serialize one planned occurrence in input order.
    /// Stored profiles group rows by key; plans keep input order.
    pub(crate) fn resolve_one(
        &self,
        spelling: &Option<String>,
        values: &[Value],
    ) -> Result<Vec<String>, String> {
        self.resolve_rows(&[(spelling.clone(), values.to_vec())])
    }
}

impl Override {
    pub(crate) fn rows(&self) -> Vec<Occurrence> {
        self.occurrences
            .iter()
            .map(|row| (self.spelling.clone(), row.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn known<T>(value: T) -> Fact<T> {
        Fact {
            value: Some(value),
            certainty: Certainty::Verified,
            source: Some(Source::Adapter {
                id: "test.adapter".into(),
                revision: "r1".into(),
            }),
        }
    }

    fn option(key: &str, kind: ValueKind, min: u16, max: Option<u16>) -> OptionDefinition {
        serde_json::from_value(json!({
            "key": key, "spellings": [{"flag":format!("--{key}")}],
            "kind": known(kind), "arity": known(Arity {min, max}), "target":"launch"
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

    fn selected(rows: &[(&str, Vec<Vec<Value>>)]) -> Overrides {
        rows.iter()
            .map(|(key, occurrences)| {
                (
                    key.to_string(),
                    Override {
                        spelling: None,
                        occurrences: occurrences.clone(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn versioned_schema_round_trip_refuses_future_and_unknown_contract_fields() {
        let schema = schema(vec![option("count", ValueKind::Integer, 1, Some(1))]);
        let bytes = serde_json::to_vec(&schema).unwrap();
        assert_eq!(OptionSchema::parse(&bytes).unwrap(), schema);
        let mut future = serde_json::to_value(schema).unwrap();
        future["schema_version"] = json!(SCHEMA_VERSION + 1);
        assert!(OptionSchema::parse(&serde_json::to_vec(&future).unwrap())
            .unwrap_err()
            .contains("version"));
        future["schema_version"] = json!(SCHEMA_VERSION);
        future["silently_apply_new_behavior"] = json!(true);
        assert!(OptionSchema::parse(&serde_json::to_vec(&future).unwrap()).is_err());
    }

    #[test]
    fn runtime_defaults_are_display_data_not_implicit_overrides() {
        let mut count = option("count", ValueKind::Integer, 1, Some(1));
        count.runtime_default = known(RuntimeDefault { literal: json!(8) });
        let schema = schema(vec![count]);
        assert_eq!(
            schema.resolve(&[], &Overrides::new()).unwrap().argv,
            Vec::<String>::new()
        );
        assert_eq!(
            schema
                .resolve(&[], &selected(&[("count", vec![vec![json!(0)]])]))
                .unwrap()
                .argv,
            ["--count", "0"]
        );
    }

    #[test]
    fn documented_json_null_default_round_trips_separately_from_unknown() {
        let mut request = option("payload", ValueKind::Json, 1, Some(1));
        request.runtime_default = known(RuntimeDefault {
            literal: Value::Null,
        });
        let schema = schema(vec![request]);
        let restored = OptionSchema::parse(&serde_json::to_vec(&schema).unwrap()).unwrap();
        assert_eq!(restored, schema);
        assert_eq!(
            restored.options[0]
                .runtime_default
                .supported()
                .unwrap()
                .literal,
            Value::Null
        );
        assert_ne!(restored.options[0].runtime_default, Fact::default());
        assert!(restored
            .resolve(&[], &Overrides::new())
            .unwrap()
            .argv
            .is_empty());
    }

    #[test]
    fn false_zero_empty_and_absent_remain_distinct_in_saved_overrides() {
        let mut enabled = option("enabled", ValueKind::Boolean, 0, Some(0));
        enabled.spellings.push(Spelling {
            flag: "--no-enabled".into(),
            style: ValueStyle::Separate,
            polarity: Some(false),
        });
        let schema = schema(vec![
            enabled,
            option("count", ValueKind::Integer, 1, Some(1)),
            option("label", ValueKind::Text, 1, Some(1)),
        ]);
        let values = selected(&[
            ("enabled", vec![vec![json!(false)]]),
            ("count", vec![vec![json!(0)]]),
            ("label", vec![vec![json!("")]]),
        ]);
        let restored: Overrides =
            serde_json::from_slice(&serde_json::to_vec(&values).unwrap()).unwrap();
        assert_eq!(restored, values);
        assert_eq!(
            schema.resolve(&[], &restored).unwrap().argv,
            ["--no-enabled", "--count", "0", "--label", ""]
        );
        assert!(schema
            .resolve(&[], &Overrides::new())
            .unwrap()
            .argv
            .is_empty());
    }

    #[test]
    fn explicit_alias_and_negative_switch_are_not_normalized_away() {
        let mut enabled = option("enabled", ValueKind::Boolean, 0, Some(0));
        enabled.spellings.push(Spelling {
            flag: "-E".into(),
            style: ValueStyle::Separate,
            polarity: Some(false),
        });
        let mut values = selected(&[("enabled", vec![vec![json!(false)]])]);
        values.get_mut("enabled").unwrap().spelling = Some("-E".into());
        let schema = schema(vec![enabled]);
        assert_eq!(schema.resolve(&[], &values).unwrap().argv, ["-E"]);
        values.get_mut("enabled").unwrap().spelling = Some("--enabled".into());
        assert!(schema.resolve(&[], &values).is_err());
        values.get_mut("enabled").unwrap().spelling = Some("--deleted-alias".into());
        assert!(schema.resolve(&[], &values).unwrap_err()[0]
            .message
            .contains("alias"));
    }

    #[test]
    fn false_needs_negative_spelling_or_a_sourced_false_default() {
        let mut enabled = option("enabled", ValueKind::Boolean, 0, Some(0));
        let values = selected(&[("enabled", vec![vec![json!(false)]])]);
        assert!(schema(vec![enabled.clone()]).resolve(&[], &values).is_err());
        enabled.runtime_default = known(RuntimeDefault {
            literal: json!(false),
        });
        assert!(schema(vec![enabled])
            .resolve(&[], &values)
            .unwrap()
            .argv
            .is_empty());
    }

    #[test]
    fn repeated_fixed_tuples_keep_occurrence_boundaries() {
        let mut pair = option("pair", ValueKind::Integer, 2, Some(2));
        pair.repeatable = known(true);
        let values = selected(&[(
            "pair",
            vec![vec![json!(1), json!(2)], vec![json!(3), json!(4)]],
        )]);
        assert_eq!(
            schema(vec![pair.clone()])
                .resolve(&[], &values)
                .unwrap()
                .argv,
            ["--pair", "1", "2", "--pair", "3", "4"]
        );
        pair.repeatable = Fact::default();
        assert!(schema(vec![pair]).resolve(&[], &values).unwrap_err()[0]
            .message
            .contains("repetition"));
        assert!(schema(vec![option("pair", ValueKind::Integer, 2, Some(2))])
            .resolve(&[], &selected(&[("pair", vec![vec![json!(1)]])]))
            .is_err());
    }

    #[test]
    fn optional_and_variadic_arity_do_not_invent_values() {
        let schema = schema(vec![
            option("optional", ValueKind::Text, 0, Some(1)),
            option("files", ValueKind::Tokens, 1, None),
        ]);
        let values = selected(&[
            ("optional", vec![vec![]]),
            (
                "files",
                vec![vec![json!("one"), json!("two words"), json!("한글")]],
            ),
        ]);
        assert_eq!(
            schema.resolve(&[], &values).unwrap().argv,
            ["--optional", "--files", "one", "two words", "한글"]
        );
        assert!(schema
            .resolve(&[], &selected(&[("files", vec![vec![]])]))
            .is_err());
    }

    #[test]
    fn unknown_arity_retains_value_but_refuses_to_guess_argv() {
        let mut unknown = option("new-flag", ValueKind::Text, 1, Some(1));
        unknown.arity = Fact {
            value: Some(Arity {
                min: 1,
                max: Some(1),
            }),
            ..Fact::default()
        };
        let values = selected(&[("new-flag", vec![vec![json!("retained")]])]);
        let before = values.clone();
        assert!(schema(vec![unknown]).resolve(&[], &values).unwrap_err()[0]
            .message
            .contains("arity is unknown"));
        assert_eq!(values, before);
    }

    #[test]
    fn unknown_kind_is_text_only_and_unknown_range_is_not_a_constraint() {
        let mut unknown = option("new-flag", ValueKind::Integer, 1, Some(1));
        unknown.kind = Fact::default();
        unknown.range = Fact {
            value: Some(NumericRange {
                min: Some(1.0),
                max: Some(2.0),
            }),
            ..Fact::default()
        };
        let schema = schema(vec![unknown]);
        assert_eq!(
            schema
                .resolve(&[], &selected(&[("new-flag", vec![vec![json!("999")]])]))
                .unwrap()
                .argv,
            ["--new-flag", "999"]
        );
        assert!(schema
            .resolve(&[], &selected(&[("new-flag", vec![vec![json!(999)]])]))
            .is_err());
    }

    #[test]
    fn subcommand_scopes_and_positional_slots_define_launch_order() {
        let global = option("global", ValueKind::Text, 1, Some(1));
        let mut local = option("local", ValueKind::Text, 1, Some(1));
        local.scope = vec!["serve".into()];
        let mut positional = option("model-file", ValueKind::Text, 1, Some(1));
        positional.spellings.clear();
        positional.position = Some(0);
        positional.scope = local.scope.clone();
        let schema = schema(vec![positional, local, global]);
        let values = selected(&[
            ("model-file", vec![vec![json!("models/한글 model.gguf")]]),
            ("global", vec![vec![json!("g")]]),
            ("local", vec![vec![json!("l")]]),
        ]);
        assert_eq!(
            schema.resolve(&["serve".into()], &values).unwrap().argv,
            [
                "--global",
                "g",
                "serve",
                "--local",
                "l",
                "models/한글 model.gguf"
            ]
        );
        assert!(schema
            .resolve(&["other".into()], &values)
            .unwrap_err()
            .iter()
            .any(|e| e.message.contains("another subcommand")));
    }

    #[test]
    fn missing_earlier_positional_is_refused_instead_of_shifting_values() {
        let mut first = option("first", ValueKind::Text, 1, Some(1));
        first.spellings.clear();
        first.position = Some(0);
        let mut second = first.clone();
        second.key = "second".into();
        second.position = Some(1);
        assert!(schema(vec![first, second])
            .resolve(
                &[],
                &selected(&[("second", vec![vec![json!("must-not-bind-first")]])])
            )
            .unwrap_err()[0]
            .message
            .contains("earlier positional"));
    }

    #[test]
    fn template_filled_slots_precede_user_positionals_and_unmapped_ones_do_not() {
        let mut model = option("model", ValueKind::Text, 1, Some(1));
        model.spellings.clear();
        model.position = Some(0);
        let mut output = model.clone();
        output.key = "output".into();
        output.position = Some(1);
        let mut extras = model.clone();
        extras.key = "extras".into();
        extras.position = Some(2);
        extras.arity.value = Some(Arity { min: 0, max: None });
        let values = selected(&[
            ("output", vec![vec![json!("out.txt")]]),
            ("extras", vec![vec![json!("x1"), json!("x2")]]),
        ]);
        // Unmapped (help-discovered) slot: still a gap, with a mapping hint.
        model.managed = Some(ManagedBinding::Discovery);
        let refused = schema(vec![model.clone(), output.clone(), extras.clone()])
            .resolve(&[], &values)
            .unwrap_err();
        assert!(refused
            .iter()
            .any(|i| i.message.contains("earlier positional")));
        let mut own = values.clone();
        own.insert(
            "model".into(),
            serde_json::from_value(json!({"occurrences":[["x"]]})).unwrap(),
        );
        assert!(schema(vec![model.clone(), output.clone(), extras.clone()])
            .resolve(&[], &own)
            .unwrap_err()
            .iter()
            .any(|i| i.key == "model" && i.message.contains("not mapped")));
        // A slot the launch template's model binding fills is occupied.
        model.managed = Some(ManagedBinding::Model);
        let resolved = schema(vec![model.clone(), output.clone(), extras.clone()])
            .resolve(&[], &values)
            .unwrap();
        assert_eq!(resolved.argv, ["out.txt", "x1", "x2"]);
        // Only the last supplied positional may take a varying value count.
        let mut first = extras.clone();
        first.position = Some(1);
        let mut last = output.clone();
        last.position = Some(2);
        let varying = selected(&[
            ("extras", vec![vec![json!("x1")]]),
            ("output", vec![vec![json!("out.txt")]]),
        ]);
        assert!(schema(vec![model, first, last])
            .resolve(&[], &varying)
            .unwrap_err()
            .iter()
            .any(|i| i.key == "extras" && i.message.contains("last positional")));
    }

    #[test]
    fn leading_dash_text_uses_confirmed_equals_or_end_of_options() {
        let mut text = option("label", ValueKind::Text, 1, Some(1));
        let values = selected(&[("label", vec![vec![json!("--not-another-option")]])]);
        assert!(schema(vec![text.clone()]).resolve(&[], &values).is_err());
        text.spellings[0].style = ValueStyle::Equals;
        assert_eq!(
            schema(vec![text.clone()])
                .resolve(&[], &values)
                .unwrap()
                .argv,
            ["--label=--not-another-option"]
        );
        text.spellings.clear();
        text.position = Some(0);
        let mut schema = schema(vec![text]);
        assert!(schema.resolve(&[], &values).is_err());
        schema.end_of_options = known(true);
        assert_eq!(
            schema.resolve(&[], &values).unwrap().argv,
            ["--", "--not-another-option"]
        );
    }

    #[test]
    fn arguments_remain_literal_unicode_and_shell_metacharacters() {
        let text = "C:\\合成 folder\\x\" & $(echo private); %NAME% `";
        let schema = schema(vec![
            option("label", ValueKind::Text, 1, Some(1)),
            option("count", ValueKind::Integer, 1, Some(1)),
        ]);
        assert_eq!(
            schema
                .resolve(
                    &[],
                    &selected(&[
                        ("label", vec![vec![json!(text)]]),
                        ("count", vec![vec![json!(-2)]])
                    ])
                )
                .unwrap()
                .argv,
            ["--label", text, "--count", "-2"]
        );
        assert!(schema
            .resolve(
                &[],
                &selected(&[("label", vec![vec![json!("bad\u{0000}value")]])])
            )
            .is_err());
    }

    #[test]
    fn managed_model_port_auth_and_discovery_never_accept_generic_overrides() {
        for managed in [
            ManagedBinding::Model,
            ManagedBinding::Host,
            ManagedBinding::Port,
            ManagedBinding::Authentication,
            ManagedBinding::Discovery,
            ManagedBinding::EntryPoint,
            ManagedBinding::Reserved,
        ] {
            let mut option = option("binding", ValueKind::Text, 1, Some(1));
            option.managed = Some(managed);
            let message = schema(vec![option])
                .resolve(
                    &[],
                    &selected(&[("binding", vec![vec![json!("replacement")]])]),
                )
                .unwrap_err()[0]
                .message
                .clone();
            // Each ownership says why; none accepts the replacement.
            let reason = match managed {
                ManagedBinding::EntryPoint => "fixed by the registered entry point",
                ManagedBinding::Reserved => "reserves this option for the app",
                _ => "managed by the app",
            };
            assert!(message.contains(reason), "{managed:?}: {message}");
        }
    }

    #[test]
    fn request_fields_require_protocol_metadata_and_do_not_become_cli_flags() {
        let mut request = option("temperature", ValueKind::Number, 1, Some(1));
        request.target = Target::Request;
        request.spellings.clear();
        request.request_field = known("temperature".into());
        let schema = schema(vec![
            request.clone(),
            option("threads", ValueKind::Integer, 1, Some(1)),
        ]);
        let resolved = schema
            .resolve(
                &[],
                &selected(&[
                    ("temperature", vec![vec![json!(0.25)]]),
                    ("threads", vec![vec![json!(4)]]),
                ]),
            )
            .unwrap();
        assert_eq!(resolved.argv, ["--threads", "4"]);
        assert_eq!(resolved.request["temperature"], json!(0.25));
        request.request_field.source = Some(Source::User {
            note: "inferred from help".into(),
        });
        assert!(super::tests::schema(vec![request]).validate().is_err());
    }

    #[test]
    fn sourced_constraints_and_ranges_apply_only_to_explicit_values() {
        let mut fast = option("fast", ValueKind::Boolean, 0, Some(0));
        fast.runtime_default = known(RuntimeDefault {
            literal: json!(false),
        });
        let mut count = option("count", ValueKind::Integer, 1, Some(1));
        count.range = known(NumericRange {
            min: Some(0.0),
            max: Some(16.0),
        });
        let mut schema = schema(vec![
            fast,
            count,
            option("mode", ValueKind::Text, 1, Some(1)),
        ]);
        schema.constraints.push(known(Relation::Requires {
            when: Predicate {
                key: "fast".into(),
                equals: Some(json!(true)),
            },
            other: Predicate {
                key: "count".into(),
                equals: None,
            },
        }));
        assert!(schema
            .resolve(&[], &selected(&[("fast", vec![vec![json!(false)]])]))
            .is_ok());
        assert!(schema
            .resolve(&[], &selected(&[("fast", vec![vec![json!(true)]])]))
            .unwrap_err()[0]
            .message
            .contains("requires"));
        assert!(schema
            .resolve(&[], &selected(&[("count", vec![vec![json!(17)]])]))
            .is_err());
        assert!(schema
            .resolve(
                &[],
                &selected(&[
                    ("fast", vec![vec![json!(true)]]),
                    ("count", vec![vec![json!(0)]])
                ])
            )
            .is_ok());
        schema.constraints.push(known(Relation::Excludes {
            when: Predicate {
                key: "fast".into(),
                equals: Some(json!(true)),
            },
            other: Predicate {
                key: "mode".into(),
                equals: None,
            },
        }));
        assert!(schema
            .resolve(
                &[],
                &selected(&[
                    ("fast", vec![vec![json!(true)]]),
                    ("count", vec![vec![json!(0)]]),
                    ("mode", vec![vec![json!("slow")]])
                ])
            )
            .unwrap_err()
            .iter()
            .any(|e| e.message.contains("cannot be combined")));
    }

    #[test]
    fn constraint_operands_round_trip_and_null_never_becomes_an_occurrence_test() {
        let mut fast = option("fast", ValueKind::Boolean, 0, Some(0));
        fast.runtime_default = known(RuntimeDefault {
            literal: json!(false),
        });
        let ratio = option("ratio", ValueKind::Number, 1, Some(1));
        let mut base = schema(vec![fast, ratio]);
        base.constraints.push(known(Relation::Requires {
            when: Predicate {
                key: "fast".into(),
                equals: Some(json!(true)),
            },
            other: Predicate {
                key: "ratio".into(),
                equals: None,
            },
        }));
        // Serialization omits an absent operand, so the schema round-trips.
        let bytes = serde_json::to_vec(&base).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("\"equals\":null"));
        assert_eq!(OptionSchema::parse(&bytes).unwrap(), base);
        // An explicit JSON null in a stored or adapter-provided schema is
        // refused instead of turning "requires fast == null" into "requires
        // fast to be present".
        let mut value = serde_json::to_value(&base).unwrap();
        value["constraints"][0]["value"]["when"]["equals"] = Value::Null;
        let error = OptionSchema::parse(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert!(error.contains("null constraint operand"), "{error}");
        // Operands must be values the option can hold: a string "true" never
        // equals a boolean, so it cannot silently disable the constraint.
        let mut value = serde_json::to_value(&base).unwrap();
        value["constraints"][0]["value"]["when"]["equals"] = json!("true");
        assert!(OptionSchema::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        // Numbers compare by value: a saved 1 matches a documented 1.0.
        let mut numeric = base.clone();
        numeric.constraints = vec![known(Relation::Excludes {
            when: Predicate {
                key: "ratio".into(),
                equals: Some(json!(1.0)),
            },
            other: Predicate {
                key: "fast".into(),
                equals: Some(json!(true)),
            },
        })];
        let issues = numeric
            .resolve(
                &[],
                &selected(&[
                    ("ratio", vec![vec![json!(1)]]),
                    ("fast", vec![vec![json!(true)]]),
                ]),
            )
            .unwrap_err();
        assert!(issues
            .iter()
            .any(|i| i.message.contains("cannot be combined")));
    }

    #[test]
    fn raw_help_spans_and_scoped_aliases_are_validated_without_dropping_raw_text() {
        let mut first = option("global", ValueKind::Text, 1, Some(1));
        first.arity.source = Some(Source::Help {
            document: "stdout".into(),
            start_line: 2,
            end_line: 2,
        });
        let mut local = first.clone();
        local.key = "local".into();
        local.scope = vec!["serve".into()];
        let mut schema = schema(vec![first.clone(), local]);
        schema.raw_help.push(RawHelp {
            id: "stdout".into(),
            scope: vec![],
            stream: HelpStream::Stdout,
            text: "OPTIONS:\n --global VALUE   description\n unparsed unusual syntax\n".into(),
            truncated: false,
        });
        assert!(schema.validate().is_ok());
        assert!(OptionSchema::parse(&serde_json::to_vec(&schema).unwrap())
            .unwrap()
            .raw_help[0]
            .text
            .contains("unparsed"));
        schema.options.push(first);
        assert!(schema.validate().is_err());
        schema.options.pop();
        schema.options[0].arity.source = Some(Source::Help {
            document: "stdout".into(),
            start_line: 2,
            end_line: 99,
        });
        assert!(schema.validate().is_err());
    }

    #[test]
    fn schema_refuses_conflicts_unsourced_facts_and_invalid_numeric_constraints() {
        let a = option("a", ValueKind::Text, 1, Some(1));
        let mut b = a.clone();
        b.key = "b".into();
        assert!(schema(vec![a.clone(), b]).validate().is_err());
        let mut unsourced = a.clone();
        unsourced.arity.source = None;
        assert!(schema(vec![unsourced]).validate().is_err());
        let mut invalid = a;
        invalid.range = known(NumericRange {
            min: Some(0.0),
            max: Some(1.0),
        });
        assert!(schema(vec![invalid]).validate().is_err());
    }

    #[test]
    fn missing_saved_options_are_retained_and_block_launch_until_reviewed() {
        let values = selected(&[("removed", vec![vec![json!("original")]])]);
        let before = values.clone();
        assert!(schema(vec![]).resolve(&[], &values).unwrap_err()[0]
            .message
            .contains("absent from this schema"));
        assert_eq!(values, before);
    }

    #[test]
    fn bounded_schema_and_values_refuse_oversized_inputs() {
        assert!(OptionSchema::parse(&vec![b' '; MAX_SCHEMA_BYTES + 1]).is_err());
        let schema = schema(vec![option("label", ValueKind::Text, 1, Some(1))]);
        assert!(schema
            .resolve(
                &[],
                &selected(&[(
                    "label",
                    vec![vec![json!("x".repeat(MAX_ARGUMENT_BYTES + 1))]]
                )])
            )
            .is_err());
    }
}
