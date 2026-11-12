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
//!
//! Saved profiles keep their grouped values as the authority for values, so
//! every existing reader keeps working. When grouped values cannot express
//! the command line (interleaved options, a different alias per occurrence),
//! the profile also holds a versioned order record under `ORDER_KEY`. That
//! record is the authority for occurrence order and per-occurrence spelling
//! only: its n-th entry for a key is that key's n-th saved occurrence. A
//! record that names missing values, disagrees with an occurrence count or
//! with the grouped spelling, or comes from a newer app is refused, never
//! repaired, and the saved values stay untouched.
//!
//! Actual-spawn capture shares the import token recognizer, but keeps only
//! local identities and token positions from raw argv. Values are interpreted
//! from the position-preserving sanitized copy, including redacted occurrences
//! that must supersede earlier aliases. Managed tuning remains import review
//! while being observable at the final launch boundary.
use super::runtime_help_store::overrides_from_map;
use super::runtime_options::{
    Occurrence, OptionDefinition, OptionIssue, OptionSchema, Override, Overrides, ResolvedOptions,
    Target,
};
use super::runtime_positional::CommandEntry;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Saved key of the order record. `@` never starts an option key, so the
/// record cannot collide with an option a runtime describes.
pub const ORDER_KEY: &str = "@option_order";
pub const ORDER_VERSION: u32 = 1;
const MAX_ORDER_BYTES: usize = 65_536;
const MAX_PLAN: usize = 512;

/// One saved occurrence position. `spelling: None` means the option's
/// default spelling, exactly as in grouped values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderEntry {
    pub key: String,
    #[serde(default)]
    pub spelling: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedOrder {
    pub version: u32,
    pub occurrences: Vec<OrderEntry>,
}

impl SavedOrder {
    pub fn keys(&self) -> BTreeSet<&str> {
        self.occurrences.iter().map(|e| e.key.as_str()).collect()
    }
}

fn order_key_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
}

/// The saved order record, checked against the grouped values it orders.
/// `Ok(None)` means the profile has no record and resolves canonically.
pub fn saved_order(values: &Map<String, Value>) -> Result<Option<SavedOrder>, String> {
    checked_saved_order(values).map(|checked| checked.map(|(order, _)| order))
}

// Keep the grouped values checked by the record for this resolution only.
fn checked_saved_order(
    values: &Map<String, Value>,
) -> Result<Option<(SavedOrder, Overrides)>, String> {
    let Some(raw) = values.get(ORDER_KEY) else {
        return Ok(None);
    };
    if serde_json::to_vec(raw).map_err(|e| e.to_string())?.len() > MAX_ORDER_BYTES {
        return Err("the saved option order exceeds 64 KiB; the saved values were retained".into());
    }
    // A newer record may carry meaning this app cannot honor; refuse it
    // before reading anything else.
    match raw.get("version").and_then(Value::as_u64) {
        Some(version) if version == u64::from(ORDER_VERSION) => {}
        Some(version) => {
            return Err(format!(
                "the saved option order uses version {version}, which this app does not support; the saved values were retained"
            ))
        }
        None => return Err("the saved option order has no valid version".into()),
    }
    let order: SavedOrder = SavedOrder::deserialize(raw)
        .map_err(|e| format!("the saved option order is malformed: {e}"))?;
    if order.occurrences.len() > MAX_PLAN {
        return Err("the saved option order has too many occurrences".into());
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for entry in &order.occurrences {
        if !order_key_valid(&entry.key)
            || entry
                .spelling
                .as_deref()
                .is_some_and(|s| s.is_empty() || s.len() > 128 || s.contains('\0'))
        {
            return Err("the saved option order has an invalid entry".into());
        }
        *counts.entry(&entry.key).or_default() += 1;
    }
    let grouped = overrides_from_map(values);
    for (key, count) in counts {
        let Some(value) = grouped.get(key) else {
            return Err(format!(
                "the saved option order names {key}, which has no saved value"
            ));
        };
        if value.occurrences.len() != count {
            return Err(format!(
                "the saved option order lists {count} occurrence(s) of {key}, but {} are saved",
                value.occurrences.len()
            ));
        }
        let first = order
            .occurrences
            .iter()
            .find(|e| e.key == key)
            .expect("counted key");
        if first.spelling != value.spelling {
            return Err(format!(
                "the saved option order spells {key} differently from its saved value"
            ));
        }
    }
    Ok(Some((order, grouped)))
}

/// Keys whose position the saved order decides. Empty without a valid record.
pub fn recorded_keys(values: &Map<String, Value>) -> BTreeSet<String> {
    saved_order(values)
        .ok()
        .flatten()
        .map(|order| order.keys().into_iter().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Every saved occurrence as one plan: values the record does not order keep
/// their canonical schema order and come first, then the recorded
/// occurrences in saved order with their own spelling.
#[cfg(test)]
pub fn saved_plan(
    schema: &OptionSchema,
    values: &Map<String, Value>,
    order: &SavedOrder,
) -> OrderedPlan {
    saved_plan_from_grouped(schema, &overrides_from_map(values), order)
}

fn saved_plan_from_grouped(
    schema: &OptionSchema,
    grouped: &Overrides,
    order: &SavedOrder,
) -> OrderedPlan {
    let recorded = order.keys();
    let mut plan = Vec::new();
    let mut push_all = |key: &str, value: &Override| {
        for row in &value.occurrences {
            plan.push(PlannedOccurrence {
                key: key.to_owned(),
                spelling: value.spelling.clone(),
                values: row.clone(),
            });
        }
    };
    for option in &schema.options {
        if let Some(value) = grouped.get(&option.key) {
            if !recorded.contains(option.key.as_str()) {
                push_all(&option.key, value);
            }
        }
    }
    for (key, value) in grouped {
        if !recorded.contains(key.as_str()) && !schema.options.iter().any(|o| o.key == *key) {
            push_all(key, value);
        }
    }
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    for entry in &order.occurrences {
        let index = seen.entry(&entry.key).or_default();
        plan.push(PlannedOccurrence {
            key: entry.key.clone(),
            spelling: entry.spelling.clone(),
            values: grouped[&entry.key].occurrences[*index].clone(),
        });
        *index += 1;
    }
    plan
}

/// Authoritative resolution of saved values, honoring a saved order record.
/// Without a record this is exactly the grouped resolution.
pub fn resolve_saved(
    schema: &OptionSchema,
    selected_scope: &[String],
    values: &Map<String, Value>,
) -> Result<ResolvedOptions, Vec<OptionIssue>> {
    let issue = |message: String| {
        vec![OptionIssue {
            key: ORDER_KEY.into(),
            message,
        }]
    };
    let Some((order, grouped)) = checked_saved_order(values).map_err(issue)? else {
        return schema.resolve(selected_scope, &overrides_from_map(values));
    };
    for key in order.keys() {
        if schema
            .options
            .iter()
            .any(|o| o.key == key && o.target == Target::Request)
        {
            return Err(issue(format!(
                "{key} is sent with requests and has no command-line position; remove it from the saved order"
            )));
        }
    }
    let plan = saved_plan_from_grouped(schema, &grouped, &order);
    drop(grouped);
    resolve_plan(schema, selected_scope, &plan)
}

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

/// Authoritative resolution following plan order within each scope depth.
pub fn resolve_plan(
    schema: &OptionSchema,
    selected_scope: &[String],
    plan: &OrderedPlan,
) -> Result<ResolvedOptions, Vec<OptionIssue>> {
    let validated = schema.validated().map_err(|message| {
        vec![OptionIssue {
            key: String::new(),
            message,
        }]
    })?;
    if plan.len() > MAX_PLAN {
        return Err(vec![OptionIssue {
            key: String::new(),
            message: "too many planned option occurrences".into(),
        }]);
    }
    // Canonical validation first for full parity with grouped profiles:
    // unknown keys, subcommand scope, managed bindings, constraints,
    // positional gaps, dash boundaries and size limits all apply equally.
    // Every occurrence is checked with its own alias, so a documented
    // equals alias keeps a dash-leading value and an unknown alias is refused.
    let mut grouped: BTreeMap<String, Vec<Occurrence>> = BTreeMap::new();
    for occurrence in plan {
        grouped
            .entry(occurrence.key.clone())
            .or_default()
            .push((occurrence.spelling.clone(), occurrence.values.clone()));
    }
    let request = validated
        .resolve_occurrences(selected_scope, &grouped)?
        .request;
    // Re-emit flags in plan order within each scope depth. Positionals keep
    // slot order (never plan order) so reordered input cannot rebind a later
    // saved value into an earlier slot. Dash delimiters mirror the grouped
    // path, which already proved support.
    let mut flags_by_depth: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let mut positionals_by_depth: BTreeMap<usize, Vec<(u16, Vec<String>)>> = BTreeMap::new();
    for occurrence in plan {
        let Some(option) = validated.option(&occurrence.key) else {
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
    let mut scope_boundaries = Vec::new();
    for depth in 0..=selected_scope.len() {
        if depth > 0 {
            scope_boundaries.push(argv.len());
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
        scope_boundaries,
        argv,
        request,
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
    import_plan_text_with_syntax(
        schema,
        selected_scope,
        text,
        super::options::CommandSyntax::Posix,
    )
}

pub fn import_plan_text_with_syntax(
    schema: &OptionSchema,
    selected_scope: &[String],
    text: &str,
    syntax: super::options::CommandSyntax,
) -> Result<ImportedPlan, String> {
    import_plan_for_entry(schema, selected_scope, None, text, syntax)
}

/// Whether a pasted program word names the registered program: the exact
/// text, or the same file name (on Windows, case-insensitively and with or
/// without `.exe`). The literal entry prefix that must follow is checked
/// separately; nothing else about the word is guessed.
fn same_program(word: &str, program: &str) -> bool {
    let name = |text: &str| {
        let base = text.rsplit(['/', '\\']).next().unwrap_or(text).to_owned();
        if cfg!(windows) {
            let lower = base.to_ascii_lowercase();
            lower
                .strip_suffix(".exe")
                .map(str::to_owned)
                .unwrap_or(lower)
        } else {
            base
        }
    };
    word == program || (!word.is_empty() && name(word) == name(program))
}

/// The registered entry's literal tokens, split at its declared subcommands:
/// the head before the first one, then the tokens after each.
fn entry_segments(entry: &CommandEntry) -> Vec<&[String]> {
    let subcommands = entry
        .layout
        .as_ref()
        .map_or(&[][..], |layout| layout.subcommands.as_slice());
    let mut bounds = vec![0];
    for index in subcommands {
        bounds.push(*index);
        bounds.push(index + 1);
    }
    bounds.push(entry.prefix.len());
    bounds
        .chunks(2)
        .map(|pair| &entry.prefix[pair[0]..pair[1]])
        .collect()
}

/// Where the options start in a pasted command for this entry. A command
/// starting with the registered program must continue with the exact entry
/// head; one starting with the head alone skips it; anything else is taken
/// as options only.
fn entry_start(entry: &CommandEntry, words: &[String]) -> Result<usize, String> {
    let head = entry_segments(entry)[0];
    let program = words
        .first()
        .is_some_and(|word| same_program(word, &entry.program));
    let after = usize::from(program);
    if words[after..].starts_with(head) {
        return Ok(after + head.len());
    }
    if program {
        let differs = head
            .iter()
            .zip(&words[after..])
            .position(|(expected, word)| expected != word)
            .unwrap_or(words.len() - after);
        return Err(format!(
            "the pasted command runs this runtime's program with other entry arguments (argument {} differs from the registered entry); paste only the options after the entry, or register that entry point",
            after + differs + 1
        ));
    }
    Ok(0)
}

/// Imported plans cross JSON IPC into the editor's JavaScript value store.
/// Keep exact integer literals outside its safe domain in raw review, including
/// nested literals. Some outside values are representable, but not all are.
fn json_import_has_safe_integers(value: &Value) -> bool {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    match value {
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                integer.unsigned_abs() <= MAX_SAFE_INTEGER
            } else if let Some(integer) = number.as_u64() {
                integer <= MAX_SAFE_INTEGER
            } else {
                true
            }
        }
        Value::Array(values) => values.iter().all(json_import_has_safe_integers),
        Value::Object(values) => values.values().all(json_import_has_safe_integers),
        _ => true,
    }
}

/// Interpret completed occurrences only after their raw token boundaries and
/// arity are known. Unknown facts retain literal values for later review.
fn imported_values(option: &OptionDefinition, values: Vec<Value>) -> Option<Vec<Value>> {
    use super::runtime_options::ValueKind;
    let kind = option.kind.supported();
    if option.arity.supported().is_none()
        || matches!(kind, None | Some(ValueKind::Text | ValueKind::Tokens))
    {
        return Some(values);
    }
    values
        .into_iter()
        .map(|value| {
            let text = value.as_str()?;
            match kind? {
                ValueKind::Integer => text.parse::<i64>().ok().map(Value::from),
                ValueKind::Number => text
                    .parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number),
                ValueKind::Boolean => text.parse::<bool>().ok().map(Value::from),
                ValueKind::Json => serde_json::from_str(text)
                    .ok()
                    .filter(json_import_has_safe_integers),
                ValueKind::Text | ValueKind::Tokens => unreachable!("literal kinds returned above"),
            }
        })
        .collect()
}

/// Import a pasted command. With the selected runtime's registered entry,
/// its program and literal prefix tokens are skipped exactly (never guessed),
/// declared subcommands delimit scopes, the entry's own option separator is
/// accepted, and positional words follow the slots' confirmed roles: entry
/// tokens are skipped, app-owned and unmapped slots go to review, and user
/// slots take their documented value count.
pub fn import_plan_for_entry(
    schema: &OptionSchema,
    selected_scope: &[String],
    entry: Option<&CommandEntry>,
    text: &str,
    syntax: super::options::CommandSyntax,
) -> Result<ImportedPlan, String> {
    let words = super::options::split_command_with_syntax(text, syntax)?;
    import_plan_tokens_for_entry(schema, selected_scope, entry, &words)
}

/// Import already split command words through the same recognizer used by
/// actual-spawn capture. Review remains literal and never changes saved values.
pub fn import_plan_tokens_for_entry(
    schema: &OptionSchema,
    selected_scope: &[String],
    entry: Option<&CommandEntry>,
    words: &[String],
) -> Result<ImportedPlan, String> {
    let lexed = recognize_tokens(schema, selected_scope, entry, words, false)?;
    let mut plan = Vec::new();
    let mut unrecognized = Vec::new();
    for occurrence in lexed.occurrences {
        let values = if occurrence.valid {
            match occurrence.boolean {
                Some(value) => Some(vec![Value::Bool(value)]),
                None => imported_values(occurrence.option, occurrence.values(words)),
            }
        } else {
            None
        };
        if let Some(values) = values {
            plan.push(PlannedOccurrence {
                key: occurrence.option.key.clone(),
                spelling: occurrence.spelling.map(str::to_owned),
                values,
            });
        } else {
            unrecognized.push(occurrence.span);
        }
    }
    unrecognized.extend(lexed.unrecognized);
    unrecognized.sort_by_key(|span| span.start);
    if plan.len() > MAX_PLAN {
        return Err("too many planned option occurrences".into());
    }
    Ok(ImportedPlan {
        plan,
        managed: lexed
            .managed
            .into_iter()
            .flat_map(|span| words[span].iter().cloned())
            .collect(),
        unrecognized: unrecognized
            .into_iter()
            .flat_map(|span| words[span].iter().cloned())
            .collect(),
    })
}

/// A capture retains local schema identity and order, never raw argument values.
#[derive(Clone, Debug, PartialEq)]
pub struct CapturedOccurrence {
    pub key: String,
    pub spelling: Option<String>,
    pub order: usize,
    pub state: CapturedValue,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CapturedValue {
    Known(Vec<Value>),
    Redacted,
    Invalid,
}

/// Recognize identities and value positions in raw argv, then interpret only
/// their position-aligned sanitized counterparts. A changed flag or value is
/// an occurrence in its own right, so last-occurrence selection cannot revive
/// an earlier unmasked value. Managed tuning is observable, not overridable.
pub fn capture_plan_for_entry(
    schema: &OptionSchema,
    selected_scope: &[String],
    entry: Option<&CommandEntry>,
    raw: &[String],
    sanitized: &[String],
) -> Result<Vec<CapturedOccurrence>, String> {
    if raw.len() != sanitized.len() {
        return Err("capture requires position-aligned sanitized command words".into());
    }
    let lexed = recognize_tokens(schema, selected_scope, entry, raw, true)?;
    Ok(lexed
        .occurrences
        .into_iter()
        .enumerate()
        .map(|(order, occurrence)| {
            let state = if raw[occurrence.span.clone()] != sanitized[occurrence.span.clone()] {
                CapturedValue::Redacted
            } else if !occurrence.valid
                || occurrence.option.arity.supported().is_none()
                || occurrence.option.kind.supported().is_none()
            {
                CapturedValue::Invalid
            } else {
                let values = match occurrence.boolean {
                    Some(value) => Some(vec![Value::Bool(value)]),
                    None => captured_values(occurrence.option, occurrence.values(sanitized)),
                };
                values.map_or(CapturedValue::Invalid, CapturedValue::Known)
            };
            CapturedOccurrence {
                key: occurrence.option.key.clone(),
                spelling: occurrence.spelling.map(str::to_owned),
                order,
                state,
            }
        })
        .collect())
}

// Some launch adapters encode a numeric vector as comma-separated argv rather
// than JSON. This interpretation is capture-only: pasted invalid JSON must
// continue to stay in the import review bucket.
fn captured_values(option: &OptionDefinition, values: Vec<Value>) -> Option<Vec<Value>> {
    if option.kind.supported() != Some(&super::runtime_options::ValueKind::Json) {
        return imported_values(option, values);
    }
    values
        .into_iter()
        .map(|value| {
            let text = value.as_str()?;
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                return json_import_has_safe_integers(&value).then_some(value);
            }
            if !text.contains(',') {
                return None;
            }
            let numbers: Vec<Value> = text
                .split(',')
                .take(65)
                .map(|part| {
                    serde_json::from_str::<Value>(part).ok().filter(|value| {
                        value.is_number()
                            && value.as_f64().is_some_and(f64::is_finite)
                            && json_import_has_safe_integers(value)
                    })
                })
                .collect::<Option<_>>()?;
            (numbers.len() <= 64).then_some(Value::Array(numbers))
        })
        .collect()
}

struct TokenOccurrence<'a> {
    option: &'a OptionDefinition,
    spelling: Option<&'a str>,
    span: std::ops::Range<usize>,
    // An inline value starts after '=' in the first word; all remaining
    // values occupy whole words. No raw value is copied into the recognizer.
    inline: Option<usize>,
    value_start: usize,
    boolean: Option<bool>,
    valid: bool,
}

impl TokenOccurrence<'_> {
    fn values(&self, words: &[String]) -> Vec<Value> {
        if let Some(offset) = self.inline {
            vec![Value::String(words[self.span.start][offset..].to_owned())]
        } else {
            words[self.value_start..self.span.end]
                .iter()
                .cloned()
                .map(Value::String)
                .collect()
        }
    }
}

#[derive(Default)]
struct RecognizedTokens<'a> {
    occurrences: Vec<TokenOccurrence<'a>>,
    managed: Vec<std::ops::Range<usize>>,
    unrecognized: Vec<std::ops::Range<usize>>,
}

// Capture needs only the lexical shape of a negative number to distinguish a
// value from a flag. In particular it never parses an unredacted number.
fn numeric_word(word: &str, capture: bool) -> bool {
    if !capture {
        return word.parse::<f64>().is_ok_and(f64::is_finite);
    }
    let bytes = word.as_bytes();
    let mut i = usize::from(bytes.first().is_some_and(|b| matches!(b, b'+' | b'-')));
    let start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    let mut digits = i - start;
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        digits += i - start;
    }
    if digits == 0 {
        return false;
    }
    if bytes.get(i).is_some_and(|b| matches!(b, b'e' | b'E')) {
        i += 1;
        if bytes.get(i).is_some_and(|b| matches!(b, b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

fn recognize_tokens<'a>(
    schema: &'a OptionSchema,
    selected_scope: &[String],
    entry: Option<&CommandEntry>,
    words: &'a [String],
    capture: bool,
) -> Result<RecognizedTokens<'a>, String> {
    schema.validate()?;
    if let Some(entry) = entry {
        entry.validate()?;
        if super::runtime_command::scope(entry.layout.as_ref(), &entry.prefix)? != selected_scope {
            return Err(
                "the selected scope does not match the registered entry's subcommands".into(),
            );
        }
    }
    let mut out = RecognizedTokens::default();
    let mut positional_slots: Vec<&OptionDefinition> = schema
        .options
        .iter()
        .filter(|o| o.position.is_some() && selected_scope.starts_with(&o.scope))
        .collect();
    positional_slots.sort_by_key(|o| o.position.unwrap_or(u16::MAX));
    let mut positional_index = 0usize;
    let mut index = 0usize;
    let segments = entry.map(entry_segments);
    if let Some(entry) = entry {
        index = entry_start(entry, words)?;
    } else {
        let first_is_scope = selected_scope
            .first()
            .is_some_and(|s| Some(s) == words.first());
        let looks_like_program = !words.is_empty()
            && !words[0].starts_with('-')
            && !first_is_scope
            && (words[0].contains('/') || words[0].contains('\\') || words[0].contains('.'));
        if looks_like_program {
            index = 1;
        }
    }
    let mut separator = entry.and_then(|entry| entry.separator.as_deref());
    let skip_segment = |cursor: usize, index: usize| -> usize {
        segments
            .as_ref()
            .and_then(|segments| segments.get(cursor))
            .filter(|segment| words[index..].starts_with(segment))
            .map_or(0, |segment| segment.len())
    };
    let mut scope_cursor = 0usize;
    while index < words.len() {
        if scope_cursor < selected_scope.len() && words[index] == selected_scope[scope_cursor] {
            scope_cursor += 1;
            index += 1;
            index += skip_segment(scope_cursor, index);
            continue;
        }
        let start = index;
        let word = &words[index];
        index += 1;
        if word == "--" && separator.take().is_some() {
            continue;
        }
        if word == "--" {
            return Err("a bare -- would turn every later argument into a positional value".into());
        }
        if word.starts_with("--")
            || (word.starts_with('-') && word.len() > 1 && !numeric_word(word, capture))
        {
            let (name, inline) = word
                .split_once('=')
                .map_or((word.as_str(), None), |(name, _)| {
                    (name, Some(name.len() + 1))
                });
            let managed = schema
                .options
                .iter()
                .find(|o| o.managed.is_some() && o.spellings.iter().any(|s| s.flag == name));
            if !capture {
                if let Some(option) = managed {
                    if inline.is_none() {
                        let count = option.arity.supported()
                            .filter(|arity| arity.max == Some(arity.min))
                            .map(|arity| usize::from(arity.min))
                            .ok_or_else(|| format!("{name}: confirm its exact value count before importing a command; its saved values were retained"))?;
                        if words.len().saturating_sub(index) < count {
                            return Err(format!(
                                "{name}: the pasted command is missing a managed option value"
                            ));
                        }
                        index += count;
                    }
                    out.managed.push(start..index);
                    continue;
                }
            }
            let negated = name.strip_prefix("--no-");
            let mut first_match = None;
            let eligible = schema.options.iter().find(|o| {
                let matches = o.spellings.iter().any(|s| {
                    s.flag == name
                        || negated.is_some_and(|rest| s.flag.strip_prefix("--") == Some(rest))
                });
                if matches && first_match.is_none() {
                    first_match = Some(*o);
                }
                matches && selected_scope.starts_with(&o.scope)
            });
            let Some(option) = eligible.or(first_match) else {
                if inline.is_none() && words.get(index).is_some_and(|n| !n.starts_with("--")) {
                    index += 1;
                }
                out.unrecognized.push(start..index);
                continue;
            };
            if !selected_scope.starts_with(&option.scope) {
                out.unrecognized.push(start..index);
                continue;
            }
            let spelling = option.spellings.iter().find(|s| s.flag == name);
            let is_negative = (negated.is_some_and(|rest| {
                option
                    .spellings
                    .iter()
                    .any(|s| s.flag.strip_prefix("--") == Some(rest))
            }) && spelling.is_none())
                || spelling.is_some_and(|s| s.polarity == Some(false));
            let mut occurrence = TokenOccurrence {
                option,
                spelling: Some(name),
                span: start..index,
                inline,
                value_start: index,
                boolean: None,
                valid: true,
            };
            if option.kind.supported() == Some(&super::runtime_options::ValueKind::Boolean)
                && option.arity.supported().is_some_and(|a| a.max == Some(0))
            {
                occurrence.boolean = Some(!is_negative);
                occurrence.valid = inline.is_none() && !(is_negative && spelling.is_none());
            } else if let Some(arity) = option.arity.supported() {
                let max = arity.max.unwrap_or(8).min(8) as usize;
                let mut count = usize::from(inline.is_some());
                if inline.is_none() {
                    while count < max && index < words.len() && !words[index].starts_with("--") {
                        if words[index].starts_with('-') && !numeric_word(&words[index], capture) {
                            break;
                        }
                        count += 1;
                        index += 1;
                        if arity.max == Some(1) {
                            break;
                        }
                        if count >= usize::from(arity.min)
                            && words.get(index).is_some_and(|n| n.starts_with("--"))
                        {
                            break;
                        }
                    }
                }
                occurrence.valid = count >= usize::from(arity.min)
                    && arity.max.is_none_or(|max| count <= usize::from(max));
            } else if inline.is_none() {
                if words.get(index).is_some_and(|n| !n.starts_with('-')) {
                    index += 1;
                } else {
                    occurrence.valid = false;
                }
            }
            occurrence.span.end = index;
            out.occurrences.push(occurrence);
            continue;
        }
        if word.starts_with('-') {
            out.unrecognized.push(start..index);
            continue;
        }
        if let Some(entry) = entry {
            let mut entry_token = false;
            while let Some(slot) = positional_slots.get(positional_index) {
                let Some(super::runtime_positional::PositionalRole::Static { index: token }) =
                    entry.positional_roles.get(&slot.key)
                else {
                    break;
                };
                positional_index += 1;
                if entry.prefix.get(*token) == Some(word) {
                    entry_token = true;
                    break;
                }
            }
            if entry_token {
                continue;
            }
        }
        let Some(slot) = positional_slots.get(positional_index).copied() else {
            out.unrecognized.push(start..index);
            continue;
        };
        positional_index += 1;
        if entry.is_some() && slot.managed.is_some() && !capture {
            out.managed.push(start..index);
            continue;
        }
        let mut valid = true;
        if entry.is_some() {
            let (min, max) = slot
                .arity
                .supported()
                .map_or((1, Some(1)), |a| (a.min.max(1), a.max));
            while max.is_none_or(|max| index - start < usize::from(max))
                && index - start < 256
                && words.get(index).is_some_and(|next| {
                    !next.starts_with('-')
                        && !(scope_cursor < selected_scope.len()
                            && *next == selected_scope[scope_cursor])
                })
            {
                index += 1;
            }
            valid = index - start >= usize::from(min);
        }
        out.occurrences.push(TokenOccurrence {
            option: slot,
            spelling: None,
            span: start..index,
            inline: None,
            value_start: start,
            boolean: None,
            valid,
        });
    }
    if capture && out.occurrences.len() > MAX_PLAN {
        return Err("too many planned option occurrences".into());
    }
    Ok(out)
}

#[cfg(test)]
#[path = "runtime_ordered_tests.rs"]
mod tests;
