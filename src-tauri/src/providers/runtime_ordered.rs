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
    schema.validate()?;
    if let Some(entry) = entry {
        entry.validate()?;
        if super::runtime_command::scope(entry.layout.as_ref(), &entry.prefix)? != selected_scope {
            return Err(
                "the selected scope does not match the registered entry's subcommands".into(),
            );
        }
    }
    let words = super::options::split_command_with_syntax(text, syntax)?;
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
    let segments = entry.map(entry_segments);
    if let Some(entry) = entry {
        index = entry_start(entry, &words)?;
    } else {
        // Skip a leading program word only when it looks like a path or file
        // name (bare positional values must never be eaten). Scope subcommands
        // are skipped by the scope cursor below, so pasted full lines import.
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
    }
    let mut separator = entry.and_then(|entry| entry.separator.as_deref());
    // After a declared subcommand, the entry's literal tokens that follow it
    // are skipped when they appear exactly there.
    let skip_segment = |cursor: usize, index: usize| -> usize {
        segments
            .as_ref()
            .and_then(|segments| segments.get(cursor))
            .filter(|segment| words[index..].starts_with(segment))
            .map_or(0, |segment| segment.len())
    };
    let mut scope_cursor = 0usize;
    while index < words.len()
        && scope_cursor < selected_scope.len()
        && words[index] == selected_scope[scope_cursor]
    {
        scope_cursor += 1;
        index += 1;
        index += skip_segment(scope_cursor, index);
    }
    while index < words.len() {
        // Only a token reached outside an option's consumed values may be
        // the next scope boundary. Equal-looking values stay values.
        if scope_cursor < selected_scope.len() && words[index] == selected_scope[scope_cursor] {
            scope_cursor += 1;
            index += 1;
            index += skip_segment(scope_cursor, index);
            continue;
        }
        let word_start = index;
        let word = words[index].clone();
        index += 1;
        if word == "--" && separator.take().is_some() {
            // The registered entry's own boundary after its bindings.
            continue;
        }
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
            if let Some(option) = managed_hit {
                managed.push(word.clone());
                if inline.is_none() {
                    let count = option.arity.supported().filter(|arity| arity.max == Some(arity.min)).map(|arity| usize::from(arity.min))
                        .ok_or_else(|| format!("{name}: confirm its exact value count before importing a command; its saved values were retained"))?;
                    if words.len().saturating_sub(index) < count {
                        return Err(format!(
                            "{name}: the pasted command is missing a managed option value"
                        ));
                    }
                    managed.extend_from_slice(&words[index..index + count]);
                    index += count;
                }
                continue;
            }
            let negated = name.strip_prefix("--no-").map(|rest| format!("--{rest}"));
            // Preserve the out-of-scope review path when no eligible option
            // matches, while allowing the selected scope's spelling to win.
            let mut first_match = None;
            let eligible = schema.options.iter().find(|o| {
                let matches = o.spellings.iter().any(|s| s.flag == name)
                    || (negated
                        .as_deref()
                        .is_some_and(|n| o.spellings.iter().any(|s| s.flag == n)));
                if matches && first_match.is_none() {
                    first_match = Some(*o);
                }
                matches && selected_scope.starts_with(&o.scope)
            });
            let Some(option) = eligible.or(first_match) else {
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
            // Explicit negative spellings use their documented polarity.
            let is_negative = negated.is_some_and(|n| {
                option.spellings.iter().any(|s| s.flag == n)
                    && !option.spellings.iter().any(|s| s.flag == name)
            }) || option
                .spellings
                .iter()
                .any(|s| s.flag == name && s.polarity == Some(false));
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
            let Some(values) = imported_values(option, values) else {
                unrecognized.extend_from_slice(&words[word_start..index]);
                continue;
            };
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
        if let Some(entry) = entry {
            // A slot an entry literal fills takes exactly that literal; when
            // the pasted command does not repeat it there, the slot is the
            // entry's and the word belongs to the next slot.
            let mut entry_token = false;
            while let Some(slot) = positional_slots.get(positional_index) {
                let Some(super::runtime_positional::PositionalRole::Static { index: token }) =
                    entry.positional_roles.get(&slot.key)
                else {
                    break;
                };
                positional_index += 1;
                if entry.prefix.get(*token) == Some(&word) {
                    entry_token = true;
                    break;
                }
            }
            if entry_token {
                continue;
            }
            let Some(slot) = positional_slots.get(positional_index).copied() else {
                unrecognized.push(word);
                continue;
            };
            positional_index += 1;
            if slot.managed.is_some() {
                // A template binding's value, or a slot whose role is unmapped.
                managed.push(word);
                continue;
            }
            let (min, max) = slot
                .arity
                .supported()
                .map_or((1, Some(1)), |a| (a.min.max(1), a.max));
            let mut values = vec![Value::String(word)];
            while max.is_none_or(|max| values.len() < usize::from(max))
                && values.len() < 256
                && words.get(index).is_some_and(|next| {
                    !next.starts_with('-')
                        && !(scope_cursor < selected_scope.len()
                            && *next == selected_scope[scope_cursor])
                })
            {
                values.push(Value::String(words[index].clone()));
                index += 1;
            }
            if values.len() < usize::from(min) {
                unrecognized.extend(
                    values
                        .into_iter()
                        .map(|v| v.as_str().unwrap_or_default().to_owned()),
                );
                continue;
            }
            let Some(values) = imported_values(slot, values) else {
                unrecognized.extend_from_slice(&words[word_start..index]);
                continue;
            };
            plan.push(PlannedOccurrence {
                key: slot.key.clone(),
                spelling: None,
                values,
            });
        } else if positional_index < positional_slots.len() {
            let slot = positional_slots[positional_index];
            positional_index += 1;
            if let Some(values) = imported_values(slot, vec![Value::String(word)]) {
                plan.push(PlannedOccurrence {
                    key: slot.key.clone(),
                    spelling: None,
                    values,
                });
            } else {
                unrecognized.extend_from_slice(&words[word_start..index]);
            }
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
    fn command_import_preserves_windows_path_backslashes() {
        let schema = schema(vec![option("template", "--template", 1, Some(1))]);
        let text = r"--template C:\tpl\x.jinja";
        let imported = import_plan_text_with_syntax(
            &schema,
            &[],
            text,
            super::super::options::CommandSyntax::Windows,
        )
        .unwrap();
        assert_eq!(imported.plan[0].values, vec![json!(r"C:\tpl\x.jinja")]);
        let legacy = import_plan_text(&schema, &[], text).unwrap();
        assert_eq!(legacy.plan[0].values, vec![json!("C:tplx.jinja")]);
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
        // An explicit JSON null is refused while parsing; it never becomes an
        // occurrence test. An absent operand is the occurrence test.
        let error = serde_json::from_value::<super::super::runtime_options::Predicate>(
            json!({"key": "threads", "equals": null}),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("null constraint operand"),
            "{error}"
        );
        let absent: super::super::runtime_options::Predicate =
            serde_json::from_value(json!({"key": "threads"})).unwrap();
        assert_eq!(absent.equals, None);
        // A constructed null operand is refused by validation as well.
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

    fn saved(value: Value) -> Map<String, Value> {
        let Value::Object(map) = value else {
            unreachable!()
        };
        map
    }

    fn interleaving_schema() -> OptionSchema {
        let mut alpha: OptionDefinition = serde_json::from_value(json!({
            "key": "alpha", "spellings": [{"flag": "--alpha"}, {"flag": "-a"}],
            "kind": known(ValueKind::Text), "arity": known(Arity {min: 1, max: Some(1)}), "target": "launch"
        }))
        .unwrap();
        alpha.repeatable = known(true);
        let mut cache: OptionDefinition = serde_json::from_value(json!({
            "key": "cache", "spellings": [{"flag": "--cache", "polarity": true}, {"flag": "--no-cache", "polarity": false}],
            "kind": known(ValueKind::Boolean), "arity": known(Arity {min: 0, max: Some(0)}), "target": "launch"
        }))
        .unwrap();
        cache.repeatable = known(true);
        let mut empty = option("label", "--label", 1, Some(1));
        empty.spellings[0].style = super::super::runtime_options::ValueStyle::Equals;
        schema(vec![
            alpha,
            option("beta", "--beta", 1, Some(1)),
            cache,
            empty,
        ])
    }

    #[test]
    fn saved_order_keeps_interleaving_and_per_occurrence_aliases() {
        let schema = interleaving_schema();
        // A1 B2 A3 with a different equivalent alias per occurrence, a
        // negative then positive switch, and an explicit empty value.
        let values = saved(json!({
            "alpha": {"spelling": null, "occurrences": [["1"], ["3"]]},
            "beta": "2",
            "cache": {"spelling": "--no-cache", "occurrences": [[false], [true]]},
            "label": "",
            ORDER_KEY: {"version": 1, "occurrences": [
                {"key": "cache", "spelling": "--no-cache"},
                {"key": "alpha"}, {"key": "beta"}, {"key": "alpha", "spelling": "-a"},
                {"key": "cache", "spelling": "--cache"}
            ]}
        }));
        let resolved = resolve_saved(&schema, &[], &values).unwrap();
        assert_eq!(
            resolved.argv,
            [
                "--label=",
                "--no-cache",
                "--alpha",
                "1",
                "--beta",
                "2",
                "-a",
                "3",
                "--cache"
            ]
        );
        // The grouped values alone still resolve canonically for old readers.
        let mut grouped = values.clone();
        grouped.remove(ORDER_KEY);
        grouped.insert(
            "cache".into(),
            json!({"spelling": null, "occurrences": [[false], [true]]}),
        );
        assert_eq!(
            resolve_saved(&schema, &[], &grouped).unwrap().argv,
            [
                "--alpha",
                "1",
                "--alpha",
                "3",
                "--beta",
                "2",
                "--no-cache",
                "--cache",
                "--label="
            ]
        );
        // Without a record the result is exactly the grouped resolution.
        assert_eq!(
            resolve_saved(&schema, &[], &grouped).unwrap(),
            schema.resolve(&[], &overrides_from_map(&grouped)).unwrap()
        );
    }

    #[test]
    fn saved_order_refuses_future_malformed_divergent_and_oversized_records() {
        let schema = interleaving_schema();
        let base = json!({
            "alpha": {"spelling": null, "occurrences": [["1"], ["3"]]},
            "beta": "2",
        });
        let with = |order: Value| {
            let mut values = saved(base.clone());
            values.insert(ORDER_KEY.into(), order);
            values
        };
        let refused = |order: Value, expected: &str| {
            let values = with(order);
            let before = values.clone();
            let issues = resolve_saved(&schema, &[], &values).unwrap_err();
            assert_eq!(issues[0].key, ORDER_KEY);
            assert_eq!(issues[0].message, expected);
            // Refusal never edits the saved values.
            assert_eq!(values, before);
        };
        let entries = json!([{"key": "alpha"}, {"key": "beta"}, {"key": "alpha"}]);
        refused(
            json!({"version": 2, "occurrences": entries}),
            "the saved option order uses version 2, which this app does not support; the saved values were retained",
        );
        refused(
            json!({"occurrences": entries}),
            "the saved option order has no valid version",
        );
        refused(
            json!({"version": 1}),
            "the saved option order is malformed: missing field `occurrences`",
        );
        refused(
            json!({"version": 1, "occurrences": null}),
            "the saved option order is malformed: invalid type: null, expected a sequence",
        );
        refused(
            json!({"version": 1, "occurrences": "not-a-sequence"}),
            "the saved option order is malformed: invalid type: string \"not-a-sequence\", expected a sequence",
        );
        refused(
            json!({"version": 1, "occurrences": ["alpha"]}),
            "the saved option order is malformed: invalid type: string \"alpha\", expected struct OrderEntry",
        );
        refused(
            json!({"version": 1, "occurrences": [{"key": 3}]}),
            "the saved option order is malformed: invalid type: integer `3`, expected a string",
        );
        refused(
            json!({"version": 1, "occurrences": [{"key": "alpha", "spelling": 3}]}),
            "the saved option order is malformed: invalid type: integer `3`, expected a string",
        );
        refused(
            json!({"version": 1, "occurrences": entries, "later": true}),
            "the saved option order is malformed: unknown field `later`, expected `version` or `occurrences`",
        );
        refused(
            json!({"version": 1, "occurrences": [{"key": "alpha"}, {"key": "beta"}]}),
            "the saved option order lists 1 occurrence(s) of alpha, but 2 are saved",
        );
        refused(
            json!({"version": 1, "occurrences": [{"key": "alpha"}, {"key": "alpha"}, {"key": "gamma"}]}),
            "the saved option order names gamma, which has no saved value",
        );
        refused(
            json!({"version": 1, "occurrences": [{"key": "alpha", "spelling": "-a"}, {"key": "beta"}, {"key": "alpha"}]}),
            "the saved option order spells alpha differently from its saved value",
        );
        refused(
            json!({"version": 1, "occurrences": [{"key": "alpha", "spelling": ""}]}),
            "the saved option order has an invalid entry",
        );
        refused(
            json!({"version": 1, "occurrences": vec![json!({"key": "x".repeat(120)}); 600]}),
            "the saved option order exceeds 64 KiB; the saved values were retained",
        );
        // An alias the schema does not have is refused at resolution.
        let mut values = with(
            json!({"version": 1, "occurrences": [{"key": "alpha"}, {"key": "beta"}, {"key": "alpha", "spelling": "--gone"}]}),
        );
        assert!(resolve_saved(&schema, &[], &values).unwrap_err()[0]
            .message
            .contains("alias"));
        // A request field has no command-line position.
        let mut request = option("temperature", "--temperature", 1, Some(1));
        request.target = Target::Request;
        request.spellings.clear();
        request.request_field = known("temperature".into());
        let mut with_request = schema.clone();
        with_request.options.push(request);
        values.insert("temperature".into(), json!("0.5"));
        values.insert(
            ORDER_KEY.into(),
            json!({"version": 1, "occurrences": [{"key": "temperature"}]}),
        );
        assert!(resolve_saved(&with_request, &[], &values).unwrap_err()[0]
            .message
            .contains("requests"));
    }

    #[test]
    fn unordered_values_keep_canonical_order_before_the_saved_sequence() {
        let schema = interleaving_schema();
        let values = saved(json!({
            "alpha": {"spelling": null, "occurrences": [["1"], ["3"]]},
            "beta": "2",
            "label": "x",
            ORDER_KEY: {"version": 1, "occurrences": [{"key": "beta"}, {"key": "alpha"}, {"key": "alpha"}]}
        }));
        assert_eq!(
            resolve_saved(&schema, &[], &values).unwrap().argv,
            ["--label=x", "--beta", "2", "--alpha", "1", "--alpha", "3"]
        );
        assert_eq!(
            recorded_keys(&values),
            BTreeSet::from(["alpha".to_string(), "beta".into()])
        );
    }

    #[test]
    fn saved_order_does_not_bypass_managed_bindings_or_unknown_arity() {
        let mut port = option("port", "--port", 1, Some(1));
        port.managed = Some(super::super::runtime_options::ManagedBinding::Port);
        let mut fresh = option("fresh", "--fresh", 1, Some(1));
        fresh.arity = Fact::default();
        let schema = schema(vec![port, fresh]);
        let managed = saved(json!({
            "port": {"spelling": "--port", "occurrences": [["9"]]},
            ORDER_KEY: {"version": 1, "occurrences": [{"key": "port", "spelling": "--port"}]}
        }));
        assert!(resolve_saved(&schema, &[], &managed).unwrap_err()[0]
            .message
            .contains("managed"));
        let unknown = saved(json!({
            "fresh": "kept",
            ORDER_KEY: {"version": 1, "occurrences": [{"key": "fresh"}]}
        }));
        assert!(resolve_saved(&schema, &[], &unknown).unwrap_err()[0]
            .message
            .contains("arity is unknown"));
    }

    #[test]
    fn saved_order_size_is_measured_in_utf8_bytes_like_the_settings_window() {
        // Same record, overhead and boundary as optionOrder.test.ts.
        let at = |bytes: usize| {
            let filler = "한".repeat((bytes - 59) / 3) + &"x".repeat((bytes - 59) % 3);
            saved(json!({
                "alpha": "x",
                ORDER_KEY: {"version": 1, "occurrences": [{"key": "alpha", "spelling": filler}]}
            }))
        };
        let length =
            |values: &Map<String, Value>| serde_json::to_vec(&values[ORDER_KEY]).unwrap().len();
        assert_eq!(length(&at(65_536)), 65_536);
        assert!(saved_order(&at(65_536))
            .unwrap_err()
            .contains("invalid entry"));
        assert!(saved_order(&at(65_537)).unwrap_err().contains("64 KiB"));
        // 43 three-byte characters exceed the 128-byte spelling bound; 42
        // plus two ASCII characters fit it.
        let spelled = |spelling: String| {
            saved(json!({
                "alpha": {"spelling": spelling, "occurrences": [["1"]]},
                ORDER_KEY: {"version": 1, "occurrences": [{"key": "alpha", "spelling": spelling}]}
            }))
        };
        assert!(saved_order(&spelled("한".repeat(43))).is_err());
        assert!(saved_order(&spelled("한".repeat(42) + "xy"))
            .unwrap()
            .is_some());
        // Explicit null and an absent spelling both mean the default.
        for entry in [
            json!({"key": "alpha", "spelling": null}),
            json!({"key": "alpha"}),
        ] {
            let order = saved_order(&saved(
                json!({"alpha": "x", ORDER_KEY: {"version": 1, "occurrences": [entry]}}),
            ))
            .unwrap()
            .unwrap();
            assert_eq!(order.occurrences[0].spelling, None);
        }
    }

    fn label_with_equals_alias() -> OptionDefinition {
        let mut label: OptionDefinition = serde_json::from_value(json!({
            "key": "label", "spellings": [{"flag": "--label"}, {"flag": "-L", "style": "equals"}],
            "kind": known(ValueKind::Text), "arity": known(Arity {min: 1, max: Some(1)}), "target": "launch"
        }))
        .unwrap();
        label.repeatable = known(true);
        label
    }

    #[test]
    fn each_occurrence_is_validated_with_its_own_documented_alias() {
        let schema = schema(vec![
            label_with_equals_alias(),
            option("beta", "--beta", 1, Some(1)),
        ]);
        // A dash-leading value is unambiguous only through the equals alias;
        // the shared check must judge it by that alias, not the first one.
        let plan = vec![
            PlannedOccurrence {
                key: "label".into(),
                spelling: Some("--label".into()),
                values: vec![json!("plain")],
            },
            PlannedOccurrence {
                key: "beta".into(),
                spelling: None,
                values: vec![json!("2")],
            },
            PlannedOccurrence {
                key: "label".into(),
                spelling: Some("-L".into()),
                values: vec![json!("-dash value")],
            },
        ];
        assert_eq!(
            resolve_plan(&schema, &[], &plan).unwrap().argv,
            ["--label", "plain", "--beta", "2", "-L=-dash value"]
        );
        let values = saved(json!({
            "label": {"spelling": null, "occurrences": [["plain"], ["-dash value"]]},
            "beta": "2",
            ORDER_KEY: {"version": 1, "occurrences": [{"key": "label"}, {"key": "beta"}, {"key": "label", "spelling": "-L"}]}
        }));
        assert_eq!(
            resolve_saved(&schema, &[], &values).unwrap().argv,
            ["--label", "plain", "--beta", "2", "-L=-dash value"]
        );
        // The same value through the separate alias stays refused, and an
        // alias the schema does not document is refused, not normalized.
        let mut separate = plan.clone();
        separate[2].spelling = Some("--label".into());
        assert!(resolve_plan(&schema, &[], &separate).unwrap_err()[0]
            .message
            .contains("equals spelling"));
        let mut unknown = plan.clone();
        unknown[2].spelling = Some("--labels".into());
        assert!(resolve_plan(&schema, &[], &unknown).unwrap_err()[0]
            .message
            .contains("alias"));
        // Per-occurrence aliases never unlock app-owned bindings, undocumented
        // repetition or unknown arity.
        let mut managed = label_with_equals_alias();
        managed.managed = Some(super::super::runtime_options::ManagedBinding::Model);
        assert!(resolve_plan(
            &super::tests::schema(vec![managed]),
            &[],
            &plan[2..].to_vec()
        )
        .unwrap_err()[0]
            .message
            .contains("managed"));
        let mut once = label_with_equals_alias();
        once.repeatable = Fact::default();
        let once = super::tests::schema(vec![once, option("beta", "--beta", 1, Some(1))]);
        assert!(resolve_plan(&once, &[], &plan).unwrap_err()[0]
            .message
            .contains("repetition"));
        let mut unknown_arity = label_with_equals_alias();
        unknown_arity.arity = Fact::default();
        unknown_arity.spellings[1].style = super::super::runtime_options::ValueStyle::Separate;
        assert!(resolve_plan(
            &super::tests::schema(vec![unknown_arity]),
            &[],
            &plan[2..].to_vec()
        )
        .unwrap_err()[0]
            .message
            .contains("arity is unknown"));
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
    #[test]
    fn global_options_before_nested_subcommands_keep_equal_values_and_scope_boundaries() {
        let mut worker = option("worker", "--worker", 1, Some(1));
        worker.scope = vec!["serve".into()];
        let mut pair = option("pair", "--pair", 2, Some(2));
        pair.scope = vec!["serve".into(), "api".into()];
        pair.repeatable = known(true);
        let schema = schema(vec![option("root", "--root", 1, Some(1)), worker, pair]);
        let scope = vec!["serve".into(), "api".into()];
        let imported = import_plan_text(
            &schema,
            &scope,
            "--root serve serve --worker api api --pair 1 2 --pair 3 4",
        )
        .unwrap();
        assert!(
            imported.unrecognized.is_empty(),
            "{:?}",
            imported.unrecognized
        );
        let resolved = resolve_plan(&schema, &scope, &imported.plan).unwrap();
        assert_eq!(
            resolved.sections(&scope).unwrap(),
            vec![
                vec!["--root", "serve"],
                vec!["--worker", "api"],
                vec!["--pair", "1", "2", "--pair", "3", "4"]
            ]
        );
        let prefix = ["-I", "engine.py", "--label", "serve", "serve", "api"]
            .map(String::from)
            .to_vec();
        let layout = super::super::runtime_command::CommandLayout {
            version: 1,
            subcommands: vec![4, 5],
            options: vec![
                super::super::runtime_command::PrefixOption {
                    index: 0,
                    values: 0,
                },
                super::super::runtime_command::PrefixOption {
                    index: 2,
                    values: 1,
                },
            ],
        };
        let mut template = prefix.clone();
        template.extend(["--model", "synthetic.bin", "--port", "8080"].map(String::from));
        assert_eq!(
            layout
                .assemble(&prefix, &template, &resolved.sections(&scope).unwrap(), &[])
                .unwrap(),
            vec![
                "-I",
                "engine.py",
                "--label",
                "serve",
                "--root",
                "serve",
                "serve",
                "--worker",
                "api",
                "api",
                "--model",
                "synthetic.bin",
                "--port",
                "8080",
                "--pair",
                "1",
                "2",
                "--pair",
                "3",
                "4"
            ]
        );
        assert!(serde_json::to_value(&resolved)
            .unwrap()
            .get("scope_boundaries")
            .is_none());
    }
    #[test]
    fn managed_boolean_does_not_consume_the_next_subcommand_as_a_value() {
        let mut server = option("server", "--server", 0, Some(0));
        server.kind = known(ValueKind::Boolean);
        server.managed = Some(super::super::runtime_options::ManagedBinding::EntryPoint);
        let mut local = option("local", "--local", 1, Some(1));
        local.scope = vec!["serve".into(), "api".into()];
        let schema = schema(vec![server, local]);
        let imported = import_plan_text(
            &schema,
            &["serve".into(), "api".into()],
            "--server serve api --local 7",
        )
        .unwrap();
        assert_eq!(imported.managed, vec!["--server"]);
        assert!(
            imported.unrecognized.is_empty(),
            "{:?}",
            imported.unrecognized
        );
        assert_eq!(imported.plan.len(), 1);
        assert_eq!(imported.plan[0].values, vec![json!("7")]);
    }

    #[test]
    fn managed_value_boundaries_are_declared_and_never_guessed_from_a_dash() {
        let mut model = option("model", "--model", 1, Some(1));
        model.managed = Some(super::super::runtime_options::ManagedBinding::Model);
        let schema = schema(vec![
            model.clone(),
            option("engine", "--engine", 1, Some(1)),
        ]);
        let imported = import_plan_text(&schema, &[], "--model --engine --engine mock").unwrap();
        assert_eq!(imported.managed, vec!["--model", "--engine"]);
        assert_eq!(imported.plan.len(), 1);
        assert_eq!(imported.plan[0].values, vec![json!("mock")]);
        assert!(import_plan_text(&schema, &[], "--model").is_err());
        model.arity = Fact::default();
        let unknown = super::tests::schema(vec![model.clone()]);
        assert!(import_plan_text(&unknown, &[], "--model serve")
            .unwrap_err()
            .contains("confirm"));
        model.arity = known(Arity {
            min: 0,
            max: Some(1),
        });
        let optional = super::tests::schema(vec![model]);
        assert!(import_plan_text(&optional, &[], "--model serve")
            .unwrap_err()
            .contains("confirm"));
    }

    fn positional(key: &str, position: u16, min: u16, max: Option<u16>) -> OptionDefinition {
        let mut slot = option(key, "--unused", min, max);
        slot.spellings.clear();
        slot.position = Some(position);
        slot.scope = vec!["serve".into(), "api".into()];
        slot
    }

    /// An interpreter entry with a fixed global option, nested subcommands,
    /// a model positional binding, a static `--port` flag binding, a user
    /// positional and a variadic user positional.
    fn interpreter_entry() -> (OptionSchema, CommandEntry, Vec<String>) {
        let prefix = ["-I", "engine.py", "--label", "serve", "serve", "api"]
            .map(String::from)
            .to_vec();
        let entry = CommandEntry {
            version: 1,
            program: r"C:\Tools\Python 3\python.exe".into(),
            prefix,
            layout: Some(super::super::runtime_command::CommandLayout {
                version: 1,
                subcommands: vec![4, 5],
                options: vec![
                    super::super::runtime_command::PrefixOption {
                        index: 0,
                        values: 0,
                    },
                    super::super::runtime_command::PrefixOption {
                        index: 2,
                        values: 1,
                    },
                ],
            }),
            separator: None,
            positional_bindings: Some(vec!["model".into()]),
            positional_roles: [
                (
                    "model",
                    super::super::runtime_positional::PositionalRole::Binding {
                        name: "model".into(),
                    },
                ),
                (
                    "output",
                    super::super::runtime_positional::PositionalRole::User,
                ),
                (
                    "extras",
                    super::super::runtime_positional::PositionalRole::User,
                ),
            ]
            .into_iter()
            .map(|(key, role)| (key.to_owned(), role))
            .collect(),
        };
        let mut label = option("label", "--label", 1, Some(1));
        label.managed = Some(super::super::runtime_options::ManagedBinding::EntryPoint);
        let mut worker = option("worker", "--worker", 1, Some(1));
        worker.scope = vec!["serve".into()];
        let mut pair = option("pair", "--pair", 2, Some(2));
        pair.scope = vec!["serve".into(), "api".into()];
        pair.repeatable = known(true);
        let mut port = option("port", "--port", 1, Some(1));
        port.scope = pair.scope.clone();
        port.managed = Some(super::super::runtime_options::ManagedBinding::Port);
        let mut model = positional("model", 0, 1, Some(1));
        model.managed = Some(super::super::runtime_options::ManagedBinding::Model);
        let output = positional("output", 1, 1, Some(1));
        let extras = positional("extras", 2, 0, None);
        let schema = schema(vec![
            label,
            option("global", "--global", 1, Some(1)),
            worker,
            pair,
            port,
            model,
            output,
            extras,
        ]);
        (schema, entry, vec!["serve".into(), "api".into()])
    }

    #[test]
    fn a_full_interpreter_command_skips_exactly_the_registered_entry() {
        let (schema, entry, scope) = interpreter_entry();
        let text = r#""C:\Tools\Python 3\python.exe" -I engine.py --label serve --global serve serve --worker api api C:\m\model.bin --port 9 --pair a b out.txt x1 x2"#;
        let imported = import_plan_for_entry(
            &schema,
            &scope,
            Some(&entry),
            text,
            super::super::options::CommandSyntax::Windows,
        )
        .unwrap();
        assert!(
            imported.unrecognized.is_empty(),
            "{:?}",
            imported.unrecognized
        );
        assert_eq!(imported.managed, vec![r"C:\m\model.bin", "--port", "9"]);
        let plan: Vec<(&str, Vec<Value>)> = imported
            .plan
            .iter()
            .map(|row| (row.key.as_str(), row.values.clone()))
            .collect();
        assert_eq!(
            plan,
            vec![
                ("global", vec![json!("serve")]),
                ("worker", vec![json!("api")]),
                ("pair", vec![json!("a"), json!("b")]),
                ("output", vec![json!("out.txt")]),
                ("extras", vec![json!("x1"), json!("x2")]),
            ]
        );
        // The same line through the legacy path reviews interpreter tokens.
        let legacy = import_plan_text_with_syntax(
            &schema,
            &scope,
            text,
            super::super::options::CommandSyntax::Windows,
        )
        .unwrap();
        assert!(
            legacy.unrecognized.contains(&"-I".to_string()),
            "{legacy:?}"
        );
        // Options alone (no entry) still import, positionals by role.
        let tail = import_plan_for_entry(
            &schema,
            &scope,
            Some(&entry),
            "--global x serve api C:/m.bin out.txt",
            super::super::options::CommandSyntax::Posix,
        )
        .unwrap();
        assert_eq!(tail.managed, vec!["C:/m.bin"]);
        assert_eq!(tail.plan.last().unwrap().key, "output");
    }

    #[test]
    fn a_different_entry_or_scope_is_refused_instead_of_guessed() {
        let (schema, entry, scope) = interpreter_entry();
        // Same interpreter, another script: never import its words as options.
        let error = import_plan_for_entry(
            &schema,
            &scope,
            Some(&entry),
            "python -I other.py --label serve serve api",
            super::super::options::CommandSyntax::Posix,
        )
        .unwrap_err();
        assert!(error.contains("argument 3"), "{error}");
        let mut forged = scope.clone();
        forged.pop();
        assert!(import_plan_for_entry(
            &schema,
            &forged,
            Some(&entry),
            "--global x",
            super::super::options::CommandSyntax::Posix
        )
        .is_err());
        let mut future = entry.clone();
        future.version = 2;
        assert!(import_plan_for_entry(
            &schema,
            &scope,
            Some(&future),
            "--global x",
            super::super::options::CommandSyntax::Posix
        )
        .unwrap_err()
        .contains("version"));
        // A bare -- is accepted only as the entry's own declared boundary.
        assert!(import_plan_for_entry(
            &schema,
            &scope,
            Some(&entry),
            "serve api -- out.txt",
            super::super::options::CommandSyntax::Posix
        )
        .is_err());
        let mut bridged = entry.clone();
        bridged.separator = Some("--".into());
        let separated = import_plan_for_entry(
            &schema,
            &scope,
            Some(&bridged),
            "serve api C:/m.bin -- --pair a b",
            super::super::options::CommandSyntax::Posix,
        )
        .unwrap();
        assert_eq!(separated.plan[0].key, "pair");
    }

    #[test]
    fn an_entry_literal_between_user_slots_is_matched_at_its_own_slot() {
        // [user input, fixed marker, user output] after `serve`.
        let mut input = positional("input", 0, 1, Some(1));
        input.scope = vec!["serve".into()];
        let mut marker = positional("marker", 1, 1, Some(1));
        marker.scope = input.scope.clone();
        marker.managed = Some(super::super::runtime_options::ManagedBinding::EntryPoint);
        let mut output = positional("output", 2, 1, Some(1));
        output.scope = input.scope.clone();
        let schema = schema(vec![input, marker, output]);
        let entry = CommandEntry {
            version: 1,
            program: "engine".into(),
            prefix: ["serve", "MARKER"].map(String::from).to_vec(),
            layout: Some(super::super::runtime_command::CommandLayout {
                version: 1,
                subcommands: vec![0],
                options: vec![],
            }),
            separator: None,
            positional_bindings: Some(vec![]),
            positional_roles: [
                (
                    "input",
                    super::super::runtime_positional::PositionalRole::User,
                ),
                (
                    "marker",
                    super::super::runtime_positional::PositionalRole::Static { index: 1 },
                ),
                (
                    "output",
                    super::super::runtime_positional::PositionalRole::User,
                ),
            ]
            .into_iter()
            .map(|(key, role)| (key.to_owned(), role))
            .collect(),
        };
        let scope = vec!["serve".to_string()];
        for text in ["engine serve in.txt MARKER out.txt", "in.txt out.txt"] {
            let imported = import_plan_for_entry(
                &schema,
                &scope,
                Some(&entry),
                text,
                super::super::options::CommandSyntax::Posix,
            )
            .unwrap();
            let plan: Vec<(&str, Vec<Value>)> = imported
                .plan
                .iter()
                .map(|row| (row.key.as_str(), row.values.clone()))
                .collect();
            assert_eq!(
                plan,
                vec![
                    ("input", vec![json!("in.txt")]),
                    ("output", vec![json!("out.txt")])
                ],
                "{text}"
            );
            assert!(imported.managed.is_empty() && imported.unrecognized.is_empty());
        }
    }

    #[test]
    fn selected_scope_import_is_not_shadowed_by_an_unrelated_scope() {
        let scope = vec!["serve".to_string()];
        let entry = CommandEntry {
            version: 1,
            program: "synthetic-engine".into(),
            prefix: scope.clone(),
            layout: Some(super::super::runtime_command::CommandLayout {
                version: 1,
                subcommands: vec![0],
                options: vec![],
            }),
            separator: None,
            positional_bindings: Some(vec![]),
            positional_roles: BTreeMap::new(),
        };
        let entry_before = entry.clone();
        for unrelated_first in [true, false] {
            let mut unrelated = option("other.value", "--value", 1, Some(1));
            unrelated.scope = vec!["other".into()];
            let mut selected = option("serve.value", "--value", 1, Some(1));
            selected.scope = scope.clone();
            let definitions = if unrelated_first {
                vec![unrelated, selected]
            } else {
                vec![selected, unrelated]
            };
            let schema = schema(definitions);
            schema.validate().unwrap();
            let schema_before = schema.clone();
            for registered in [false, true] {
                let imported = if registered {
                    import_plan_for_entry(
                        &schema,
                        &scope,
                        Some(&entry),
                        "synthetic-engine serve --value payload",
                        super::super::options::CommandSyntax::Posix,
                    )
                } else {
                    import_plan_text(&schema, &scope, "serve --value payload")
                }
                .unwrap();
                assert!(imported.managed.is_empty());
                assert!(imported.unrecognized.is_empty(), "{imported:?}");
                let expected_plan = json!([{
                    "key": "serve.value",
                    "spelling": "--value",
                    "values": ["payload"]
                }]);
                assert_eq!(serde_json::to_value(&imported.plan).unwrap(), expected_plan);
                let resolved = resolve_plan(&schema, &scope, &imported.plan).unwrap();
                assert_eq!(resolved.argv, ["serve", "--value", "payload"]);
                assert!(resolved.request.is_empty());
                assert_eq!(serde_json::to_value(&imported.plan).unwrap(), expected_plan);

                let grouped = overrides_from_plan(&imported.plan);
                assert_eq!(
                    serde_json::to_value(&grouped).unwrap(),
                    json!({"serve.value": {
                        "spelling": "--value", "occurrences": [["payload"]]
                    }})
                );
                let stored = super::super::runtime_help_store::map_from_overrides(&grouped);
                let stored_before = stored.clone();
                let restored = resolve_saved(&schema, &scope, &stored).unwrap();
                assert_eq!(restored.argv, ["serve", "--value", "payload"]);
                assert!(restored.request.is_empty());
                assert_eq!(stored, stored_before);
                assert_eq!(schema, schema_before);
                assert_eq!(entry, entry_before);
            }
        }
    }

    #[test]
    fn arbitrary_false_aliases_round_trip_through_import_and_saved_order() {
        let mut cache = option("cache", "--cache", 0, Some(0));
        cache.kind = known(ValueKind::Boolean);
        cache.repeatable = known(true);
        cache.spellings = vec![
            super::super::runtime_options::Spelling {
                flag: "--cache".into(),
                style: super::super::runtime_options::ValueStyle::Separate,
                polarity: Some(true),
            },
            super::super::runtime_options::Spelling {
                flag: "-E".into(),
                style: super::super::runtime_options::ValueStyle::Separate,
                polarity: Some(false),
            },
            super::super::runtime_options::Spelling {
                flag: "--disable-cache".into(),
                style: super::super::runtime_options::ValueStyle::Separate,
                polarity: Some(false),
            },
            super::super::runtime_options::Spelling {
                flag: "--enable-cache".into(),
                style: super::super::runtime_options::ValueStyle::Separate,
                polarity: None,
            },
        ];
        let schema = schema(vec![cache]);
        schema.validate().unwrap();
        let schema_before = schema.clone();
        let imported =
            import_plan_text(&schema, &[], "-E --cache --disable-cache --enable-cache -E").unwrap();
        assert!(imported.managed.is_empty() && imported.unrecognized.is_empty());
        let expected_plan = json!([
            {"key":"cache","spelling":"-E","values":[false]},
            {"key":"cache","spelling":"--cache","values":[true]},
            {"key":"cache","spelling":"--disable-cache","values":[false]},
            {"key":"cache","spelling":"--enable-cache","values":[true]},
            {"key":"cache","spelling":"-E","values":[false]}
        ]);
        assert_eq!(serde_json::to_value(&imported.plan).unwrap(), expected_plan);
        let expected_argv = ["-E", "--cache", "--disable-cache", "--enable-cache", "-E"];
        let resolved = resolve_plan(&schema, &[], &imported.plan).unwrap();
        assert_eq!(resolved.argv, expected_argv);
        assert!(resolved.request.is_empty());

        let grouped = overrides_from_plan(&imported.plan);
        assert_eq!(
            serde_json::to_value(&grouped).unwrap(),
            json!({"cache": {
                "spelling": "-E", "occurrences": [[false],[true],[false],[true],[false]]
            }})
        );
        let mut stored = super::super::runtime_help_store::map_from_overrides(&grouped);
        let order = SavedOrder {
            version: ORDER_VERSION,
            occurrences: imported
                .plan
                .iter()
                .map(|item| OrderEntry {
                    key: item.key.clone(),
                    spelling: item.spelling.clone(),
                })
                .collect(),
        };
        stored.insert(ORDER_KEY.into(), serde_json::to_value(order).unwrap());
        let stored_before = stored.clone();
        let restored = resolve_saved(&schema, &[], &stored).unwrap();
        assert_eq!(restored.argv, expected_argv);
        assert!(restored.request.is_empty());
        assert_eq!(stored, stored_before);
        assert_eq!(schema, schema_before);
        assert_eq!(serde_json::to_value(&imported.plan).unwrap(), expected_plan);
    }

    #[test]
    fn import_honors_positive_and_default_polarity_even_for_negative_looking_aliases() {
        for alias in ["-E", "--disable-cache", "--no-cache"] {
            for polarity in [Some(true), None] {
                let mut cache = option("cache", alias, 0, Some(0));
                cache.kind = known(ValueKind::Boolean);
                cache.spellings[0].polarity = polarity;
                let schema = schema(vec![cache]);
                schema.validate().unwrap();
                let schema_before = schema.clone();
                let imported = import_plan_text(&schema, &[], alias).unwrap();
                assert!(imported.managed.is_empty() && imported.unrecognized.is_empty());
                let expected_plan = json!([{
                    "key": "cache", "spelling": alias, "values": [true]
                }]);
                assert_eq!(serde_json::to_value(&imported.plan).unwrap(), expected_plan);
                let resolved = resolve_plan(&schema, &[], &imported.plan).unwrap();
                assert_eq!(resolved.argv, [alias]);
                assert!(resolved.request.is_empty());
                let grouped = overrides_from_plan(&imported.plan);
                assert_eq!(
                    serde_json::to_value(&grouped).unwrap(),
                    json!({"cache": {"spelling": alias, "occurrences": [[true]]}})
                );
                assert_eq!(schema.resolve(&[], &grouped).unwrap().argv, [alias]);
                assert_eq!(schema, schema_before);
            }
        }
    }

    #[test]
    fn import_does_not_invent_an_undocumented_negative_alias() {
        let mut cache = option("cache", "--cache", 0, Some(0));
        cache.kind = known(ValueKind::Boolean);
        cache.spellings[0].polarity = Some(true);
        let schema = schema(vec![cache]);
        schema.validate().unwrap();
        let schema_before = schema.clone();
        let imported = import_plan_text(&schema, &[], "--no-cache").unwrap();
        assert!(imported.plan.is_empty());
        assert!(imported.managed.is_empty());
        assert_eq!(imported.unrecognized, ["--no-cache"]);
        assert!(resolve_plan(&schema, &[], &imported.plan)
            .unwrap()
            .argv
            .is_empty());
        assert_eq!(schema, schema_before);
    }

    #[test]
    fn public_integer_import_round_trips_types_order_and_saved_values() {
        let mut count = option("count", "--count", 1, Some(1));
        count.kind = known(ValueKind::Integer);
        count.repeatable = known(true);
        let label = option("label", "--label", 1, Some(1));
        let mut unknown = option("unknown", "--unknown", 1, Some(1));
        unknown.kind = Fact::default();
        let mut switch = option("switch", "--switch", 0, Some(0));
        switch.kind = known(ValueKind::Boolean);
        let original = schema(vec![count, label, unknown, switch]);
        let schema = OptionSchema::parse(&serde_json::to_vec(&original).unwrap()).unwrap();
        let text = "--count 4 --label 0004 --count 7 --unknown 0004 --switch";
        let imports = [
            ("text", import_plan_text(&schema, &[], text).unwrap()),
            (
                "entry-api-options-only",
                import_plan_for_entry(
                    &schema,
                    &[],
                    None,
                    text,
                    super::super::options::CommandSyntax::Posix,
                )
                .unwrap(),
            ),
        ];
        for (api, imported) in imports {
            eprintln!(
                "INTEGER_IMPORT {api} imported={}",
                serde_json::to_string(&imported).unwrap()
            );
            assert!(imported.managed.is_empty());
            assert!(imported.unrecognized.is_empty());
            let resolved = resolve_plan(&schema, &[], &imported.plan).unwrap_or_else(|issues| {
                panic!("{api}: valid Integer import cannot resolve: {issues:?}")
            });
            assert_eq!(
                serde_json::to_value(&imported).unwrap(),
                json!({
                    "plan": [
                        {"key":"count","spelling":"--count","values":[4]},
                        {"key":"label","spelling":"--label","values":["0004"]},
                        {"key":"count","spelling":"--count","values":[7]},
                        {"key":"unknown","spelling":"--unknown","values":["0004"]},
                        {"key":"switch","spelling":"--switch","values":[true]}
                    ],
                    "managed":[],"unrecognized":[]
                })
            );
            let expected_argv = vec![
                "--count",
                "4",
                "--label",
                "0004",
                "--count",
                "7",
                "--unknown",
                "0004",
                "--switch",
            ];
            assert_eq!(resolved.argv, expected_argv);
            assert!(resolved.request.is_empty());

            let grouped = overrides_from_plan(&imported.plan);
            assert_eq!(
                grouped["count"].occurrences,
                vec![vec![json!(4)], vec![json!(7)]]
            );
            let mut stored = super::super::runtime_help_store::map_from_overrides(&grouped);
            let order = SavedOrder {
                version: ORDER_VERSION,
                occurrences: imported
                    .plan
                    .iter()
                    .map(|item| OrderEntry {
                        key: item.key.clone(),
                        spelling: item.spelling.clone(),
                    })
                    .collect(),
            };
            stored.insert(ORDER_KEY.into(), serde_json::to_value(&order).unwrap());
            let stored_before = stored.clone();
            assert_eq!(saved_order(&stored).unwrap(), Some(order));
            let saved = resolve_saved(&schema, &[], &stored).unwrap();
            assert_eq!(saved.argv, expected_argv);
            assert!(saved.request.is_empty());
            assert_eq!(stored, stored_before);
        }
    }

    #[test]
    fn public_text_and_unknown_import_control_preserves_literal_tokens() {
        let mut count = option("count", "--count", 1, Some(1));
        count.repeatable = known(true);
        let label = option("label", "--label", 1, Some(1));
        let mut unknown = option("unknown", "--unknown", 1, Some(1));
        unknown.kind = Fact::default();
        let mut switch = option("switch", "--switch", 0, Some(0));
        switch.kind = known(ValueKind::Boolean);
        let schema = schema(vec![count, label, unknown, switch]);
        let imported = import_plan_text(
            &schema,
            &[],
            "--count 4 --label 0004 --count 7 --unknown 0004 --switch",
        )
        .unwrap();
        assert!(imported.managed.is_empty());
        assert!(imported.unrecognized.is_empty());
        assert_eq!(imported.plan[0].values, vec![json!("4")]);
        assert_eq!(imported.plan[1].values, vec![json!("0004")]);
        assert_eq!(imported.plan[3].values, vec![json!("0004")]);
        assert_eq!(imported.plan[4].values, vec![json!(true)]);
        let resolved = resolve_plan(&schema, &[], &imported.plan).unwrap();
        assert_eq!(
            resolved.argv,
            vec![
                "--count",
                "4",
                "--label",
                "0004",
                "--count",
                "7",
                "--unknown",
                "0004",
                "--switch"
            ]
        );
        assert!(resolved.request.is_empty());
    }

    fn assert_public_import_round_trip(
        schema: &OptionSchema,
        imported: &ImportedPlan,
        expected_argv: &[String],
    ) {
        assert!(imported.managed.is_empty());
        assert!(imported.unrecognized.is_empty());
        let resolved = resolve_plan(schema, &[], &imported.plan).unwrap();
        assert_eq!(resolved.argv, expected_argv);
        assert!(resolved.request.is_empty());
        let mut stored = super::super::runtime_help_store::map_from_overrides(
            &overrides_from_plan(&imported.plan),
        );
        let order = SavedOrder {
            version: ORDER_VERSION,
            occurrences: imported
                .plan
                .iter()
                .map(|item| OrderEntry {
                    key: item.key.clone(),
                    spelling: item.spelling.clone(),
                })
                .collect(),
        };
        stored.insert(ORDER_KEY.into(), serde_json::to_value(order).unwrap());
        let before = stored.clone();
        let saved = resolve_saved(schema, &[], &stored).unwrap();
        assert_eq!(saved.argv, expected_argv);
        assert!(saved.request.is_empty());
        assert_eq!(stored, before);
    }

    #[test]
    fn public_scalar_import_preserves_types_aliases_and_user_positionals() {
        let mut count = option("count", "--count", 1, Some(1));
        count.kind = known(ValueKind::Integer);
        count
            .spellings
            .push(super::super::runtime_options::Spelling {
                flag: "-c".into(),
                style: super::super::runtime_options::ValueStyle::Equals,
                polarity: None,
            });
        let mut ratio = option("ratio", "--ratio", 1, Some(1));
        ratio.kind = known(ValueKind::Number);
        let mut truth = option("truth", "--truth", 1, Some(1));
        truth.kind = known(ValueKind::Boolean);
        let mut payload = option("payload", "--payload", 1, Some(1));
        payload.kind = known(ValueKind::Json);
        let mut tokens = option("tokens", "--tokens", 1, Some(1));
        tokens.kind = known(ValueKind::Tokens);
        let mut unknown = option("unknown", "--unknown", 1, Some(1));
        unknown.kind = Fact::default();
        let mut switch = option("switch", "--switch", 0, Some(0));
        switch.kind = known(ValueKind::Boolean);
        let mut tail = positional("tail", 0, 1, Some(1));
        tail.scope.clear();
        tail.kind = known(ValueKind::Integer);
        let schema = schema(vec![
            count,
            ratio,
            truth,
            payload,
            option("label", "--label", 1, Some(1)),
            tokens,
            unknown,
            switch,
            tail,
        ]);
        let options = r#"-c=-4 --ratio -0.5 --truth false --payload '{"x":1}' --label 0004 --tokens 0004 --unknown true --switch 6"#;
        let entry = CommandEntry {
            version: 1,
            program: "/synthetic/engine".into(),
            prefix: vec![],
            layout: None,
            separator: None,
            positional_bindings: Some(vec![]),
            positional_roles: BTreeMap::from([(
                "tail".into(),
                super::super::runtime_positional::PositionalRole::User,
            )]),
        };
        let expected_values = vec![
            json!(-4),
            json!(-0.5),
            json!(false),
            json!({"x":1}),
            json!("0004"),
            json!("0004"),
            json!("true"),
            json!(true),
            json!(6),
        ];
        let expected_argv: Vec<String> = [
            "-c=-4",
            "--ratio",
            "-0.5",
            "--truth",
            "false",
            "--payload",
            "{\"x\":1}",
            "--label",
            "0004",
            "--tokens",
            "0004",
            "--unknown",
            "true",
            "--switch",
            "6",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        for imported in [
            import_plan_text(&schema, &[], options).unwrap(),
            import_plan_for_entry(
                &schema,
                &[],
                Some(&entry),
                &format!("{} {options}", entry.program),
                super::super::options::CommandSyntax::Posix,
            )
            .unwrap(),
        ] {
            assert_eq!(
                imported
                    .plan
                    .iter()
                    .map(|row| row.values[0].clone())
                    .collect::<Vec<_>>(),
                expected_values
            );
            assert_public_import_round_trip(&schema, &imported, &expected_argv);
        }
    }

    #[test]
    fn public_json_import_preserves_native_literal_shapes() {
        let mut payload = option("payload", "--payload", 1, Some(1));
        payload.kind = known(ValueKind::Json);
        let schema = schema(vec![payload]);
        for (literal, expected) in [
            (r#"{"x":1}"#, json!({"x":1})),
            ("[1,true,null]", json!([1, true, null])),
            (r#""literal""#, json!("literal")),
            (r#""""#, json!("")),
            ("null", Value::Null),
            ("true", json!(true)),
            ("false", json!(false)),
            ("0", json!(0)),
            ("0.5", json!(0.5)),
            ("9007199254740991", json!(9_007_199_254_740_991_i64)),
            ("-9007199254740991", json!(-9_007_199_254_740_991_i64)),
            (
                r#"{"count":[9007199254740991,-9007199254740991]}"#,
                json!({"count":[9_007_199_254_740_991_i64,-9_007_199_254_740_991_i64]}),
            ),
            (r#""9223372036854775807""#, json!("9223372036854775807")),
            ("9007199254740992.0", json!(9_007_199_254_740_992.0)),
        ] {
            for text in [
                format!("--payload '{literal}'"),
                format!("--payload='{literal}'"),
            ] {
                let imported = import_plan_text(&schema, &[], &text).unwrap();
                assert_eq!(imported.plan[0].values, vec![expected.clone()]);
                let native_json = serde_json::to_vec(&imported).unwrap();
                assert_eq!(
                    serde_json::from_slice::<ImportedPlan>(&native_json).unwrap(),
                    imported
                );
                assert_public_import_round_trip(
                    &schema,
                    &imported,
                    &[
                        "--payload".into(),
                        serde_json::to_string(&expected).unwrap(),
                    ],
                );
            }
        }
    }

    #[test]
    fn public_integer_import_preserves_native_i64_limits() {
        let mut count = option("count", "--count", 1, Some(1));
        count.kind = known(ValueKind::Integer);
        count
            .spellings
            .push(super::super::runtime_options::Spelling {
                flag: "-c".into(),
                style: super::super::runtime_options::ValueStyle::Equals,
                polarity: None,
            });
        let schema = schema(vec![count]);
        for integer in [
            i64::MIN,
            i64::MIN + 1,
            9_007_199_254_740_993,
            i64::MAX - 1,
            i64::MAX,
        ] {
            for syntax in [
                super::super::options::CommandSyntax::Posix,
                super::super::options::CommandSyntax::Windows,
            ] {
                for (text, argv) in [
                    (
                        format!("--count {integer}"),
                        vec!["--count".into(), integer.to_string()],
                    ),
                    (format!("-c={integer}"), vec![format!("-c={integer}")]),
                ] {
                    let imported =
                        import_plan_text_with_syntax(&schema, &[], &text, syntax).unwrap();
                    assert_eq!(imported.plan[0].values[0].as_i64(), Some(integer));
                    let native_json = serde_json::to_vec(&imported).unwrap();
                    assert_eq!(
                        serde_json::from_slice::<ImportedPlan>(&native_json).unwrap(),
                        imported
                    );
                    assert_public_import_round_trip(&schema, &imported, &argv);
                }
            }
        }
    }

    #[test]
    fn public_malformed_scalar_import_keeps_raw_review_and_validation() {
        for (kind, literal) in [
            (ValueKind::Integer, "9223372036854775808"),
            (ValueKind::Integer, "1.5"),
            (ValueKind::Number, "NaN"),
            (ValueKind::Number, "1e309"),
            (ValueKind::Boolean, "False"),
            (ValueKind::Boolean, "1"),
            (ValueKind::Json, "not-json"),
            (ValueKind::Json, "{\"x\":"),
        ] {
            let mut value = option("value", "--value", 1, Some(1));
            value.kind = known(kind);
            let mut port = option("port", "--port", 1, Some(1));
            port.kind = known(ValueKind::Integer);
            port.managed = Some(super::super::runtime_options::ManagedBinding::Port);
            let schema = schema(vec![value, option("label", "--label", 1, Some(1)), port]);
            for inline in [false, true] {
                let value_tokens = if inline {
                    format!("--value='{literal}'")
                } else {
                    format!("--value '{literal}'")
                };
                let imported = import_plan_text(
                    &schema,
                    &[],
                    &format!("{value_tokens} --label retained --port 004"),
                )
                .unwrap();
                assert_eq!(imported.managed, ["--port", "004"]);
                let expected_review = if inline {
                    vec![format!("--value={literal}")]
                } else {
                    vec!["--value".into(), literal.into()]
                };
                assert_eq!(imported.unrecognized, expected_review);
                assert_eq!(imported.plan.len(), 1);
                assert_eq!(imported.plan[0].key, "label");
                let resolved = resolve_plan(&schema, &[], &imported.plan).unwrap();
                assert_eq!(resolved.argv, ["--label", "retained"]);
                assert!(resolved.request.is_empty());
            }
        }
        let mut pair = option("pair", "--pair", 2, Some(2));
        pair.kind = known(ValueKind::Integer);
        let pair_schema = schema(vec![pair, option("label", "--label", 1, Some(1))]);
        let missing = import_plan_text(&pair_schema, &[], "--pair 004 --label retained").unwrap();
        assert_eq!(missing.unrecognized, ["--pair", "004"]);
        assert_eq!(
            resolve_plan(&pair_schema, &[], &missing.plan).unwrap().argv,
            ["--label", "retained"]
        );
        let complete =
            import_plan_text(&pair_schema, &[], "--pair 004 -2 --label retained").unwrap();
        assert_eq!(complete.plan[0].values, vec![json!(4), json!(-2)]);
        assert_public_import_round_trip(
            &pair_schema,
            &complete,
            &[
                "--pair".into(),
                "4".into(),
                "-2".into(),
                "--label".into(),
                "retained".into(),
            ],
        );
        let mut unknown_arity = option("payload", "--payload", 1, Some(1));
        unknown_arity.kind = known(ValueKind::Json);
        unknown_arity.arity = Fact::default();
        let unknown_schema = schema(vec![unknown_arity]);
        let tentative = import_plan_text(&unknown_schema, &[], "--payload '{broken'").unwrap();
        assert_eq!(tentative.plan[0].values, vec![json!("{broken")]);
        assert!(
            resolve_plan(&unknown_schema, &[], &tentative.plan).unwrap_err()[0]
                .message
                .contains("arity is unknown")
        );
        let mut ranged = option("count", "--count", 1, Some(1));
        ranged.kind = known(ValueKind::Integer);
        ranged.range = known(super::super::runtime_options::NumericRange {
            min: Some(0.0),
            max: Some(8.0),
        });
        let ranged_schema = schema(vec![ranged]);
        let outside = import_plan_text(&ranged_schema, &[], "--count 9").unwrap();
        assert_eq!(outside.plan[0].values, vec![json!(9)]);
        assert_eq!(
            resolve_plan(&ranged_schema, &[], &outside.plan).unwrap_err()[0].message,
            "value is outside the documented numeric range"
        );
    }

    #[test]
    fn public_scalar_positionals_follow_documented_types() {
        for (kind, literal, expected, argument) in [
            (ValueKind::Integer, "6", json!(6), "6"),
            (ValueKind::Number, "0.5", json!(0.5), "0.5"),
            (ValueKind::Boolean, "true", json!(true), "true"),
            (ValueKind::Boolean, "false", json!(false), "false"),
            (ValueKind::Json, "{\"x\":1}", json!({"x":1}), "{\"x\":1}"),
        ] {
            let mut slot = positional("value", 0, 1, Some(1));
            slot.scope.clear();
            slot.kind = known(kind);
            let mut marker = option("marker", "--marker", 0, Some(0));
            marker.kind = known(ValueKind::Boolean);
            let schema = schema(vec![marker, slot]);
            let entry = CommandEntry {
                version: 1,
                program: "/synthetic/engine".into(),
                prefix: vec![],
                layout: None,
                separator: None,
                positional_bindings: Some(vec![]),
                positional_roles: BTreeMap::from([(
                    "value".into(),
                    super::super::runtime_positional::PositionalRole::User,
                )]),
            };
            for entry in [None, Some(&entry)] {
                let text = format!(
                    "{}--marker '{literal}'",
                    entry.map_or(String::new(), |entry| format!("{} ", entry.program))
                );
                let imported = import_plan_for_entry(
                    &schema,
                    &[],
                    entry,
                    &text,
                    super::super::options::CommandSyntax::Posix,
                )
                .unwrap();
                assert_eq!(imported.plan[1].values, vec![expected.clone()]);
                assert_public_import_round_trip(
                    &schema,
                    &imported,
                    &["--marker".into(), argument.to_owned()],
                );
            }
        }
        let mut slot = positional("value", 0, 1, Some(1));
        slot.scope.clear();
        slot.kind = known(ValueKind::Json);
        let schema = schema(vec![slot]);
        let malformed = import_plan_text(&schema, &[], "not-json").unwrap();
        assert!(malformed.plan.is_empty());
        assert_eq!(malformed.unrecognized, ["not-json"]);
    }

    #[test]
    fn public_json_import_keeps_unsafe_integer_literals_in_original_review() {
        for literal in [
            "9007199254740992",
            "-9007199254740992",
            "9223372036854775807",
            "-9223372036854775808",
            "18446744073709551615",
            r#"{ "x": [ 0, 9007199254740993 ] }"#,
            r#"[0,{"x":-9007199254740993}]"#,
            r#"{"x":[true,18446744073709551615]}"#,
        ] {
            let mut payload = option("payload", "--payload", 1, Some(1));
            payload.kind = known(ValueKind::Json);
            payload.sensitive = known(true);
            let flag_schema = schema(vec![payload, option("label", "--label", 1, Some(1))]);
            for inline in [false, true] {
                let words = if inline {
                    format!("--payload='{literal}'")
                } else {
                    format!("--payload '{literal}'")
                };
                let imported =
                    import_plan_text(&flag_schema, &[], &format!("{words} --label kept")).unwrap();
                let expected_review = if inline {
                    vec![format!("--payload={literal}")]
                } else {
                    vec!["--payload".into(), literal.into()]
                };
                assert_eq!(imported.unrecognized, expected_review);
                assert!(imported.managed.is_empty());
                assert_eq!(imported.plan.len(), 1);
                assert_eq!(imported.plan[0].key, "label");
                let resolved = resolve_plan(&flag_schema, &[], &imported.plan).unwrap();
                assert_eq!(resolved.argv, ["--label", "kept"]);
                assert!(resolved.request.is_empty());
            }
            let mut slot = positional("payload", 0, 1, Some(1));
            slot.scope.clear();
            slot.kind = known(ValueKind::Json);
            let mut marker = option("marker", "--marker", 0, Some(0));
            marker.kind = known(ValueKind::Boolean);
            let positional_schema =
                schema(vec![marker, slot, option("label", "--label", 1, Some(1))]);
            let entry = CommandEntry {
                version: 1,
                program: "/synthetic/engine".into(),
                prefix: vec![],
                layout: None,
                separator: None,
                positional_bindings: Some(vec![]),
                positional_roles: BTreeMap::from([(
                    "payload".into(),
                    super::super::runtime_positional::PositionalRole::User,
                )]),
            };
            for entry in [None, Some(&entry)] {
                let text = format!(
                    "{}--marker '{literal}' --label kept",
                    entry.map_or(String::new(), |entry| format!("{} ", entry.program))
                );
                let imported = import_plan_for_entry(
                    &positional_schema,
                    &[],
                    entry,
                    &text,
                    super::super::options::CommandSyntax::Posix,
                )
                .unwrap();
                assert_eq!(imported.unrecognized, [literal]);
                assert!(imported.plan.iter().all(|row| row.key != "payload"));
                let resolved = resolve_plan(&positional_schema, &[], &imported.plan).unwrap();
                assert_eq!(resolved.argv, ["--marker", "--label", "kept"]);
                assert!(resolved.request.is_empty());
            }
        }
    }

    #[test]
    fn ordered_resolution_keeps_schema_before_plan_scope_and_value_errors() {
        let mut count = option("count", "--count", 1, Some(1));
        count.kind = known(ValueKind::Integer);
        let mut schema = schema(vec![count]);
        let invalid_scope = vec!["--invalid".into()];
        let invalid_value = vec![PlannedOccurrence {
            key: "count".into(),
            spelling: None,
            values: vec![json!("not an integer")],
        }];
        let oversized_plan = vec![invalid_value[0].clone(); MAX_PLAN + 1];
        schema.schema_version += 1;
        let schema_error = schema.validate().unwrap_err();
        for plan in [&invalid_value, &oversized_plan] {
            let issues = resolve_plan(&schema, &invalid_scope, plan).unwrap_err();
            assert_eq!(issues.len(), 1);
            assert_eq!(issues[0].key, "");
            assert_eq!(issues[0].message, schema_error);
        }
        schema.schema_version = SCHEMA_VERSION;
        assert_eq!(
            resolve_plan(&schema, &invalid_scope, &oversized_plan).unwrap_err()[0].message,
            "too many planned option occurrences"
        );
        assert_eq!(
            resolve_plan(&schema, &invalid_scope, &invalid_value).unwrap_err()[0].message,
            "invalid selected subcommand"
        );
        let issues = resolve_plan(&schema, &[], &invalid_value).unwrap_err();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].key, "count");

        // This reaches the final serialized-size check, after all option facts
        // and identities pass. It must still win over the plan/scope errors.
        schema.options = (0..100)
            .map(|index| {
                let mut option = option(
                    &format!("item{index}"),
                    &format!("--item{index}"),
                    1,
                    Some(1),
                );
                option.help = "x".repeat(32_768);
                option
            })
            .collect();
        assert_eq!(
            schema.validate().unwrap_err(),
            "runtime option schema exceeds 3 MiB"
        );
        assert_eq!(
            resolve_plan(&schema, &invalid_scope, &oversized_plan).unwrap_err()[0].message,
            "runtime option schema exceeds 3 MiB"
        );
    }

    #[test]
    fn ordered_and_direct_calls_revalidate_repaired_schema_and_own_their_results() {
        let mut schema = schema(vec![option("label", "--label", 1, Some(1))]);
        let scope = vec!["serve".into()];
        schema.options[0].scope = scope.clone();
        let plan = vec![PlannedOccurrence {
            key: "label".into(),
            spelling: None,
            values: vec![json!("literal ; $HOME λ")],
        }];
        let grouped = overrides_from_plan(&plan);
        let schema_before = serde_json::to_vec(&schema).unwrap();
        let plan_before = serde_json::to_vec(&plan).unwrap();
        let grouped_before = serde_json::to_vec(&grouped).unwrap();
        let expected = resolve_plan(&schema, &scope, &plan).unwrap();
        assert_eq!(expected.scope_boundaries, vec![0]);
        assert_eq!(schema.resolve(&scope, &grouped).unwrap(), expected);

        schema.binding.fingerprint = "invalid".into();
        for issues in [
            resolve_plan(&schema, &scope, &plan).unwrap_err(),
            schema.resolve(&scope, &grouped).unwrap_err(),
        ] {
            assert_eq!(issues.len(), 1);
            assert_eq!(issues[0].key, "");
            assert_eq!(
                issues[0].message,
                "option schema needs an engine, runtime and SHA-256 fingerprint"
            );
        }
        schema.binding.fingerprint = "a".repeat(64);
        assert_eq!(resolve_plan(&schema, &scope, &plan).unwrap(), expected);
        assert_eq!(schema.resolve(&scope, &grouped).unwrap(), expected);
        let mut owned = resolve_plan(&schema, &scope, &plan).unwrap();
        owned.argv[2].push_str(" changed");
        owned.request.insert("new".into(), json!(false));
        owned.scope_boundaries.clear();
        assert_eq!(serde_json::to_vec(&schema).unwrap(), schema_before);
        assert_eq!(serde_json::to_vec(&plan).unwrap(), plan_before);
        assert_eq!(serde_json::to_vec(&grouped).unwrap(), grouped_before);
        assert_eq!(resolve_plan(&schema, &scope, &plan).unwrap(), expected);
    }

    #[test]
    fn saved_calls_rebuild_after_map_changes_and_return_independent_owned_values() {
        let mut schema = interleaving_schema();
        let mut values = saved(json!({
            "alpha": {"occurrences": [["one"], ["three"]]}, "beta": "two",
            ORDER_KEY: {"version": 1, "occurrences": [{"key":"alpha"}, {"key":"beta"}, {"key":"alpha","spelling":"-a"}]}
        }));
        let before = serde_json::to_vec(&values).unwrap();
        let order = saved_order(&values).unwrap().unwrap();
        let mut plan = saved_plan(&schema, &values, &order);
        let expected = resolve_saved(&schema, &[], &values).unwrap();
        let mut result = expected.clone();
        plan[0].values[0] = json!("edited owned row");
        result.argv.clear();
        result.request.insert("owned".into(), json!(false));
        result.scope_boundaries.push(42);
        assert_eq!(serde_json::to_vec(&values).unwrap(), before);
        assert_eq!(
            saved_plan(&schema, &values, &order)[0].values,
            [json!("one")]
        );
        assert_eq!(resolve_saved(&schema, &[], &values).unwrap(), expected);

        values.insert("beta".into(), json!("fresh"));
        assert_eq!(
            saved_plan(&schema, &values, &order)[1].values,
            [json!("fresh")]
        );
        assert_eq!(
            resolve_saved(&schema, &[], &values).unwrap().argv,
            ["--alpha", "one", "--beta", "fresh", "-a", "three"]
        );
        values.insert("alpha".into(), json!({"occurrences": [["one"]]}));
        assert!(saved_order(&values)
            .unwrap_err()
            .contains("but 1 are saved"));
        assert!(recorded_keys(&values).is_empty());
        assert_eq!(
            resolve_saved(&schema, &[], &values).unwrap_err()[0].key,
            ORDER_KEY
        );
        values.insert("alpha".into(), json!({"occurrences": [["one"], ["three"]]}));
        schema.schema_version += 1;
        assert_eq!(resolve_saved(&schema, &[], &values).unwrap_err()[0].key, "");
        schema.schema_version = SCHEMA_VERSION;
        assert!(resolve_saved(&schema, &[], &values).is_ok());
    }

    #[test]
    fn saved_order_and_request_errors_keep_priority_over_invalid_schema() {
        let mut request = option("temperature", "--temperature", 1, Some(1));
        request.target = Target::Request;
        request.spellings.clear();
        request.request_field = known("temperature".into());
        let mut schema = schema(vec![request]);
        schema.schema_version += 1;
        let mut values = saved(json!({"temperature": "0.5", ORDER_KEY: {
            "version": 1, "occurrences": [{"key":"temperature"}]
        }}));
        let issue = &resolve_saved(&schema, &[], &values).unwrap_err()[0];
        assert_eq!(issue.key, ORDER_KEY);
        assert_eq!(issue.message, "temperature is sent with requests and has no command-line position; remove it from the saved order");
        values.insert(ORDER_KEY.into(), json!({"version":2,"occurrences":[]}));
        assert_eq!(resolve_saved(&schema, &[], &values).unwrap_err()[0].message,
            "the saved option order uses version 2, which this app does not support; the saved values were retained");
        values.insert(ORDER_KEY.into(), json!({"version":1,"occurrences":[]}));
        assert_eq!(resolve_saved(&schema, &[], &values).unwrap_err()[0].key, "");
    }
}
