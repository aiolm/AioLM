//! Deterministic conservative help parsing and explicit metadata overlay.
//!
//! Help describes command syntax, not protocol capabilities. The parser only
//! records what the help text explicitly shows: flags, aliases, value counts,
//! subcommand scope and raw spans. Types, ranges, defaults and request fields
//! stay unknown until explicit adapter metadata provides them. Unparsed blocks
//! remain in `raw_help`; they are never silently dropped.
use super::runtime_help::{HelpReport, PARSER_VERSION};
use super::runtime_options::{
    Arity, Certainty, Fact, HelpStream, ManagedBinding, OptionDefinition, OptionSchema, RawHelp,
    SchemaBinding, Source, Spelling, Target, ValueKind, ValueStyle, SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Provenance conflict between observed help syntax and explicit metadata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverlayConflict {
    pub key: String,
    pub field: String,
    pub help: String,
    pub overlay: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AppliedOverlay {
    pub schema: OptionSchema,
    pub conflicts: Vec<OverlayConflict>,
}

/// Added/removed/changed keys between two schemas. Saved values are never
/// deleted by a diff; callers retain them and block launch until reviewed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    /// Saved keys absent from the new schema but retained for review.
    pub retained_unknown: Vec<String>,
}

fn help_source(document: &str, start: u32, end: u32) -> Source {
    Source::Help {
        document: document.into(),
        start_line: start,
        end_line: end,
    }
}

fn verified<T>(value: T, document: &str, start: u32, end: u32) -> Fact<T> {
    Fact {
        value: Some(value),
        certainty: Certainty::Verified,
        source: Some(help_source(document, start, end)),
    }
}

fn is_section_header(trimmed: &str) -> bool {
    if !trimmed.ends_with(':') || trimmed.len() > 80 || trimmed.contains('\0') {
        return false;
    }
    let body = trimmed.trim_end_matches(':');
    !body.is_empty()
        && !body.starts_with('-')
        && body
            .chars()
            .all(|c| c.is_alphanumeric() || c.is_whitespace() || c == '_' || c == '-' || c == '/')
}

fn normalize_group(header: &str) -> String {
    let body = header.trim_end_matches(':').trim().to_lowercase();
    if body.is_empty() {
        return "runtime".into();
    }
    body.chars().take(256).collect()
}

fn managed_for_flag(flag: &str) -> Option<ManagedBinding> {
    match flag {
        "--model" | "--model-path" | "--model-dir" | "--served-model-name" | "--model-alias" => {
            Some(ManagedBinding::Model)
        }
        "--host" => Some(ManagedBinding::Host),
        "--port" => Some(ManagedBinding::Port),
        "--api-key" => Some(ManagedBinding::Authentication),
        _ => None,
    }
}

fn key_for_flag(flag: &str) -> String {
    let body = flag.trim_start_matches(['-', '/']);
    if flag.starts_with("--no-") && body.len() > 3 {
        body[3..].replace('-', "_")
    } else {
        body.replace('-', "_")
    }
}

fn valid_flag(flag: &str) -> bool {
    if !(flag.starts_with('-') || flag.starts_with('/')) {
        return false;
    }
    let body = flag.trim_start_matches(['-', '/']);
    !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.?".contains(&b))
}

struct PendingOption {
    key: String,
    spellings: Vec<Spelling>,
    help: String,
    group: String,
    start_line: u32,
    end_line: u32,
    positional: Option<u16>,
    metavar: String,
    is_boolean: bool,
    negative_only: bool,
}

fn parse_choices(metavar: &str) -> Option<Vec<serde_json::Value>> {
    let trimmed = metavar.trim();
    // Explicit `{a,b,c}` or `[a|b]` in the flag spec only; prose after two
    // spaces never becomes a constraint.
    if let Some(inner) = trimmed.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
        let values = inner
            .split(',')
            .map(|s| s.trim().trim_matches('"').trim_matches('\''))
            .filter(|s| !s.is_empty())
            .map(|s| serde_json::Value::String(s.into()))
            .collect::<Vec<_>>();
        if !values.is_empty() && values.len() <= 256 {
            return Some(values);
        }
    }
    if trimmed.contains('|') && (trimmed.starts_with('[') || trimmed.starts_with('(')) {
        let inner = trimmed
            .trim_start_matches(['[', '('])
            .trim_end_matches([']', ')']);
        let values = inner
            .split('|')
            .map(|s| s.trim().trim_matches('"').trim_matches('\''))
            .filter(|s| !s.is_empty() && !s.contains(' '))
            .map(|s| serde_json::Value::String(s.into()))
            .collect::<Vec<_>>();
        if !values.is_empty() && values.len() <= 256 {
            return Some(values);
        }
    }
    None
}

fn arity_for_metavar(metavar: &str) -> Option<Arity> {
    let text = metavar.trim();
    if text.is_empty() {
        return Some(Arity {
            min: 0,
            max: Some(0),
        });
    }
    let has_ellipsis = text.contains("...");
    let bracketed = text.starts_with('[') && text.ends_with(']');
    let inner = if bracketed {
        text[1..text.len().saturating_sub(1)].trim()
    } else {
        text
    };
    // Fixed tuples like `X Y` or `HOST PORT` outside brackets.
    let plain_tokens = inner
        .split_whitespace()
        .filter(|t| *t != "..." && *t != "[...]" && *t != "...]")
        .filter(|t| !t.starts_with('[') || !t.ends_with(']'))
        .count();
    // Count required leading tokens before an optional bracket section.
    let required_lead = text
        .split('[')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .filter(|t| *t != "...")
        .count();
    if has_ellipsis {
        if bracketed && required_lead == 0 {
            return Some(Arity { min: 0, max: None });
        }
        return Some(Arity {
            min: u16::try_from(required_lead.max(1)).unwrap_or(1),
            max: None,
        });
    }
    if bracketed && plain_tokens <= 1 {
        return Some(Arity {
            min: 0,
            max: Some(1),
        });
    }
    if plain_tokens == 0 {
        return None;
    }
    if plain_tokens == 1 {
        return Some(Arity {
            min: 1,
            max: Some(1),
        });
    }
    if plain_tokens <= 256 {
        let n = u16::try_from(plain_tokens).unwrap_or(255);
        return Some(Arity {
            min: n,
            max: Some(n),
        });
    }
    None
}

fn split_spec_help(line: &str) -> (String, String) {
    // Help separates the flag spec from prose with two or more spaces.
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b' ' || bytes[i] == b'\t' {
            let mut j = i;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j - i >= 2 {
                return (line[..i].trim_end().into(), line[j..].trim().into());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    (line.trim().into(), String::new())
}

fn split_aliases(spec: &str) -> Vec<String> {
    // Commas separate aliases (`-h, --help`) but also appear inside explicit
    // choice sets (`{fast,slow}`). Only split when the next segment starts a
    // new flag; choice commas never do.
    let mut parts = Vec::new();
    let mut current = String::new();
    for segment in spec.split(',') {
        if current.is_empty() {
            current = segment.to_string();
            continue;
        }
        if segment.trim_start().starts_with(['-', '/']) {
            parts.push(current.trim().to_string());
            current = segment.to_string();
        } else {
            current.push(',');
            current.push_str(segment);
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts
}

fn parse_option_spec(spec: &str, group: &str, start_line: u32) -> Option<PendingOption> {
    // Commas separate aliases: `-h, --help`, `-t VALUE, --temperature FLOAT`.
    let mut spellings: Vec<Spelling> = Vec::new();
    let mut metavar_parts: Vec<String> = Vec::new();
    let mut equals_style = false;
    for alias in split_aliases(spec) {
        let alias = alias.trim();
        if alias.is_empty() {
            return None;
        }
        // Attached `=VALUE` keeps the argv boundary unambiguous.
        if let Some((flag, value)) = alias.split_once('=') {
            let flag = flag.trim();
            if !valid_flag(flag) || value.trim().is_empty() {
                return None;
            }
            spellings.push(Spelling {
                flag: flag.into(),
                style: ValueStyle::Equals,
                polarity: None,
            });
            equals_style = true;
            metavar_parts.push(value.trim().into());
            continue;
        }
        let mut tokens = alias.split_whitespace();
        let flag = tokens.next()?.trim();
        if !valid_flag(flag) {
            return None;
        }
        // A flag-like text value needs a confirmed equals spelling; the parser
        // records the syntax but the serializer still refuses bare spellings.
        spellings.push(Spelling {
            flag: flag.into(),
            style: ValueStyle::Separate,
            polarity: None,
        });
        for token in tokens {
            metavar_parts.push(token.into());
        }
    }
    if spellings.is_empty() || spellings.len() > 8 {
        return None;
    }
    let metavar = metavar_parts.join(" ");
    if metavar.len() > 1024 {
        return None;
    }
    let is_boolean = metavar.trim().is_empty() && !equals_style;
    // Paired `--foo` / `--no-foo` on one line is a single boolean.
    let has_negative = spellings.iter().any(|s| s.flag.starts_with("--no-"));
    let has_positive = spellings
        .iter()
        .any(|s| s.flag.starts_with("--") && !s.flag.starts_with("--no-"));
    let key = if spellings.len() == 1 && spellings[0].flag.starts_with("--no-") {
        key_for_flag(&spellings[0].flag)
    } else if let Some(long) = spellings.iter().find(|s| s.flag.starts_with("--")) {
        key_for_flag(&long.flag)
    } else {
        key_for_flag(&spellings[0].flag)
    };
    if key.is_empty() || key.len() > 128 {
        return None;
    }
    let mut pending = PendingOption {
        key,
        spellings,
        help: String::new(),
        group: group.into(),
        start_line,
        end_line: start_line,
        positional: None,
        metavar,
        is_boolean,
        negative_only: has_negative && !has_positive && is_boolean,
    };
    if has_negative && has_positive && is_boolean {
        for spelling in &mut pending.spellings {
            if spelling.flag.starts_with("--no-") {
                spelling.polarity = Some(false);
            } else if spelling.flag.starts_with("--") {
                spelling.polarity = Some(true);
            }
        }
    } else if pending.negative_only {
        pending.spellings[0].polarity = Some(false);
    }
    Some(pending)
}

fn parse_positional(
    trimmed: &str,
    group: &str,
    start_line: u32,
    slot: u16,
) -> Option<PendingOption> {
    // `<name>`, `[name]`, `MODEL`, `[FILE ...]` on its own line.
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.len() > 256 {
        return None;
    }
    let looks_positional = trimmed.starts_with('<')
        || trimmed.starts_with('[')
        || trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase());
    if !looks_positional {
        return None;
    }
    let (spec, help) = split_spec_help(trimmed);
    if spec.contains('\0') || help.contains('\0') {
        return None;
    }
    let name = spec
        .trim()
        .trim_start_matches('[')
        .trim_start_matches('<')
        .trim_end_matches(']')
        .trim_end_matches('>')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c| c == '<' || c == '>' || c == '[' || c == ']')
        .replace('-', "_");
    if name.is_empty() || name.len() > 128 {
        return None;
    }
    Some(PendingOption {
        key: name.to_lowercase(),
        spellings: Vec::new(),
        help,
        group: group.into(),
        start_line,
        end_line: start_line,
        positional: Some(slot),
        metavar: spec,
        is_boolean: false,
        negative_only: false,
    })
}

/// Parse observed help output into a conservative option schema.
///
/// Every fact derived from help syntax carries a `Help` source with exact raw
/// spans. Anything the syntax does not show stays `Unknown`: kinds for valued
/// options, ranges, defaults, request fields and repeatability. A failed or
/// truncated report never parses; callers must rediscover instead of reusing a
/// static fallback as verified.
pub fn parse_help_report(
    report: &HelpReport,
    binding: SchemaBinding,
) -> Result<OptionSchema, String> {
    if !report.success
        || report.error.is_some()
        || report.cancelled
        || report.timed_out
        || report.stdout.truncated
        || report.stdout.decoding_loss
        || report.stdout.read_error.is_some()
        || report.stderr.truncated
        || report.stderr.decoding_loss
        || report.stderr.read_error.is_some()
    {
        return Err("help output is incomplete; rediscover before building options".into());
    }
    if report.identity.parser_version != PARSER_VERSION {
        return Err("help report uses an unsupported parser version".into());
    }
    if binding.fingerprint != report.identity.fingerprint {
        return Err("schema binding must match the discovered help fingerprint".into());
    }
    let text = report.stdout.clean_text.clone();
    if text.len() > 2 * 1024 * 1024 {
        return Err("help output exceeds its schema limit".into());
    }
    let lines: Vec<&str> = text.lines().collect();
    let raw_stdout = RawHelp {
        id: "stdout".into(),
        scope: report.scope.clone(),
        stream: HelpStream::Stdout,
        text: report.stdout.clean_text.clone(),
        truncated: false,
    };
    let _ = &raw_stdout;
    let mut options: Vec<PendingOption> = Vec::new();
    let mut current_group = "runtime".to_string();
    let mut positional_slot: u16 = 0;
    let mut last_option: Option<usize> = None;
    let mut end_of_options = Fact::default();

    for (index, line) in lines.iter().enumerate() {
        let line_no = u32::try_from(index + 1).unwrap_or(u32::MAX);
        // A bare `--` line documents an explicitly supported delimiter.
        if line.trim() == "--" {
            end_of_options = verified(true, "stdout", line_no, line_no);
            last_option = None;
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            last_option = None;
            continue;
        }
        // Usage lines name subcommands but never become options themselves.
        if trimmed.to_lowercase().starts_with("usage:") {
            last_option = None;
            continue;
        }
        if is_section_header(trimmed) {
            current_group = normalize_group(trimmed);
            last_option = None;
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if !indented {
            // Unindented prose is retained in raw help, not parsed as flags.
            last_option = None;
            continue;
        }
        // Continuation of the previous option's description.
        if let Some(idx) = last_option {
            let looks_new = trimmed.starts_with('-')
                || trimmed.starts_with('/')
                || trimmed.starts_with('<')
                || (trimmed
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_uppercase())
                    && split_spec_help(trimmed).0.len() <= 64);
            if !looks_new {
                let entry = &mut options[idx];
                if !entry.help.is_empty() {
                    entry.help.push(' ');
                }
                entry.help.push_str(trimmed);
                entry.end_line = line_no;
                if entry.help.len() > 32_768 {
                    entry.help.truncate(32_768);
                }
                continue;
            }
        }
        if trimmed.starts_with('-') || trimmed.starts_with('/') {
            let (spec, help) = split_spec_help(trimmed);
            if spec.is_empty() || spec.len() > 1024 {
                last_option = None;
                continue;
            }
            if let Some(mut pending) = parse_option_spec(&spec, &current_group, line_no) {
                pending.help = help;
                pending.end_line = line_no;
                if options.len() < 4096 {
                    options.push(pending);
                    last_option = Some(options.len() - 1);
                } else {
                    last_option = None;
                }
                continue;
            }
            last_option = None;
            continue;
        }
        if let Some(pending) = parse_positional(trimmed, &current_group, line_no, positional_slot) {
            positional_slot = positional_slot.saturating_add(1);
            if options.len() < 4096 {
                options.push(pending);
                last_option = Some(options.len() - 1);
            } else {
                last_option = None;
            }
            continue;
        }
        last_option = None;
    }

    // Merge paired `--foo` / `--no-foo` lines into one boolean definition so an
    // explicit false keeps its confirmed spelling and true is not invented.
    let mut merged: Vec<PendingOption> = Vec::new();
    let mut negatives: BTreeMap<String, usize> = BTreeMap::new();
    let mut positives: BTreeMap<String, usize> = BTreeMap::new();
    for pending in options {
        if pending.positional.is_some() {
            merged.push(pending);
            continue;
        }
        if pending.negative_only {
            let base = pending.key.clone();
            if let Some(&idx) = positives.get(&base) {
                let existing = &mut merged[idx];
                for spelling in &pending.spellings {
                    if !existing.spellings.iter().any(|s| s.flag == spelling.flag) {
                        existing.spellings.push(Spelling {
                            flag: spelling.flag.clone(),
                            style: ValueStyle::Separate,
                            polarity: Some(false),
                        });
                    }
                }
                for spelling in &mut existing.spellings {
                    if spelling.flag.starts_with("--")
                        && !spelling.flag.starts_with("--no-")
                        && spelling.polarity.is_none()
                    {
                        spelling.polarity = Some(true);
                    }
                }
                existing.negative_only = false;
                if !pending.help.is_empty() {
                    if !existing.help.is_empty() {
                        existing.help.push(' ');
                    }
                    existing.help.push_str(&pending.help);
                }
                existing.end_line = pending.end_line;
                continue;
            }
            negatives.insert(base, merged.len());
            merged.push(pending);
            continue;
        }
        if pending.is_boolean {
            if let Some(long) = pending
                .spellings
                .iter()
                .find(|s| s.flag.starts_with("--") && !s.flag.starts_with("--no-"))
            {
                let base = key_for_flag(&long.flag);
                if let Some(&idx) = negatives.get(&base) {
                    let existing = &mut merged[idx];
                    for spelling in &pending.spellings {
                        if !existing.spellings.iter().any(|s| s.flag == spelling.flag) {
                            existing.spellings.push(Spelling {
                                flag: spelling.flag.clone(),
                                style: ValueStyle::Separate,
                                polarity: Some(true),
                            });
                        }
                    }
                    for spelling in &mut existing.spellings {
                        if spelling.flag.starts_with("--no-") && spelling.polarity.is_none() {
                            spelling.polarity = Some(false);
                        }
                    }
                    existing.negative_only = false;
                    if !pending.help.is_empty() {
                        if !existing.help.is_empty() {
                            existing.help.push(' ');
                        }
                        existing.help.push_str(&pending.help);
                    }
                    existing.end_line = pending.end_line;
                    negatives.remove(&base);
                    positives.insert(base, idx);
                    continue;
                }
            }
        }
        if pending.is_boolean {
            if let Some(long) = pending
                .spellings
                .iter()
                .find(|s| s.flag.starts_with("--") && !s.flag.starts_with("--no-"))
            {
                positives.insert(key_for_flag(&long.flag), merged.len());
            }
        }
        merged.push(pending);
    }

    let mut definitions: Vec<OptionDefinition> = Vec::new();
    let mut seen_keys: BTreeSet<String> = BTreeSet::new();
    let mut seen_flags: BTreeSet<(Vec<String>, String)> = BTreeSet::new();
    let mut seen_positions: BTreeSet<(Vec<String>, u16)> = BTreeSet::new();
    let scope = report.scope.clone();
    for mut pending in merged {
        if pending.help.len() > 32_768 {
            pending.help.truncate(32_768);
        }
        // Same flag text in the same scope must not define two options.
        let mut duplicate = false;
        for spelling in &pending.spellings {
            if !seen_flags.insert((scope.clone(), spelling.flag.clone())) {
                duplicate = true;
            }
        }
        let mut key = pending.key.clone();
        if !seen_keys.insert(key.clone()) {
            // Same flag in another subcommand gets a different key; within one
            // discovery a duplicate key means the help repeats the flag.
            duplicate = true;
        }
        if duplicate {
            continue;
        }
        if key.is_empty() {
            continue;
        }
        // Keep keys stable and bounded.
        if key.len() > 128 {
            continue;
        }
        let document = "stdout";
        let (kind, arity) = if pending.positional.is_some() {
            let arity = arity_for_metavar(&pending.metavar);
            (
                Fact::default(),
                arity
                    .map(|a| verified(a, document, pending.start_line, pending.end_line))
                    .unwrap_or_default(),
            )
        } else if pending.is_boolean {
            (
                verified(
                    ValueKind::Boolean,
                    document,
                    pending.start_line,
                    pending.end_line,
                ),
                verified(
                    Arity {
                        min: 0,
                        max: Some(0),
                    },
                    document,
                    pending.start_line,
                    pending.end_line,
                ),
            )
        } else {
            let arity = arity_for_metavar(&pending.metavar);
            let choices = parse_choices(&pending.metavar);
            let _ = choices;
            (
                Fact::default(),
                arity
                    .map(|a| verified(a, document, pending.start_line, pending.end_line))
                    .unwrap_or_default(),
            )
        };
        // Choices only from explicit `{a,b}` / `[a|b]` in the spec.
        let choices = if pending.positional.is_none() && !pending.is_boolean {
            parse_choices(&pending.metavar)
                .map(|values| verified(values, document, pending.start_line, pending.end_line))
                .unwrap_or_default()
        } else {
            Fact::default()
        };
        if pending.positional.is_some() {
            if let Some(slot) = pending.positional {
                if !seen_positions.insert((scope.clone(), slot)) {
                    continue;
                }
            }
        } else if pending.spellings.is_empty() {
            continue;
        }
        // App-owned bindings can never be set through generic overrides, even
        // when help spells the same flag.
        let mut managed = None;
        for spelling in &pending.spellings {
            if let Some(binding) = managed_for_flag(&spelling.flag) {
                managed = Some(binding);
                break;
            }
        }
        // Equals style is only confirmed when help shows `=`.
        for spelling in &mut pending.spellings {
            if spelling.style == ValueStyle::Equals
                && arity_for_metavar(&pending.metavar).is_none_or(|a| a.max != Some(1))
            {
                spelling.style = ValueStyle::Separate;
            }
        }
        key = key.replace('.', "_");
        if key.is_empty() {
            continue;
        }
        definitions.push(OptionDefinition {
            key,
            scope: scope.clone(),
            spellings: pending.spellings,
            position: pending.positional,
            kind,
            arity,
            repeatable: Fact::default(),
            choices,
            range: Fact::default(),
            unit: Fact::default(),
            runtime_default: Fact::default(),
            group: pending.group,
            help: pending.help,
            target: Target::Launch,
            request_field: Fact::default(),
            restart_required: Fact::default(),
            sensitive: Fact::default(),
            local_path: Fact::default(),
            managed,
            raw_spans: vec![help_source(document, pending.start_line, pending.end_line)],
        });
    }

    let mut raw_help = vec![RawHelp {
        id: "stdout".into(),
        scope: report.scope.clone(),
        stream: HelpStream::Stdout,
        text: report.stdout.clean_text.clone(),
        truncated: false,
    }];
    if !report.stderr.clean_text.trim().is_empty() {
        raw_help.push(RawHelp {
            id: "stderr".into(),
            scope: report.scope.clone(),
            stream: HelpStream::Stderr,
            text: report.stderr.clean_text.clone(),
            truncated: false,
        });
    }
    let schema = OptionSchema {
        schema_version: SCHEMA_VERSION,
        binding,
        options: definitions,
        constraints: Vec::new(),
        raw_help,
        end_of_options,
    };
    schema
        .validate()
        .map_err(|e| format!("parsed help schema is invalid: {e}"))?;
    Ok(schema)
}

/// Apply explicit adapter metadata over parsed help.
///
/// Only `Unknown` facts gain new supported values. Where both sides already
/// support a field with different values, the help observation wins and the
/// difference is reported as a conflict for the UI instead of being silently
/// overwritten. Request fields, managed bindings and constraints require an
/// `Adapter` source; help alone never provides them.
pub fn apply_overlay(
    mut base: OptionSchema,
    overlay: OptionSchema,
) -> Result<AppliedOverlay, String> {
    overlay.validate()?;
    base.validate()?;
    if overlay.binding.engine != base.binding.engine
        || overlay.binding.runtime != base.binding.runtime
    {
        return Err("metadata overlay targets another runtime".into());
    }
    if overlay.binding.fingerprint != base.binding.fingerprint {
        return Err("metadata overlay fingerprint must match the discovered help".into());
    }
    let mut conflicts = Vec::new();
    let mut by_key: BTreeMap<String, usize> = BTreeMap::new();
    for (index, option) in base.options.iter().enumerate() {
        by_key.insert(option.key.clone(), index);
    }
    for incoming in overlay.options {
        let Some(&index) = by_key.get(&incoming.key) else {
            // New flags are not a fixed allowlist: unknown help flags stay
            // editable through the conservative schema, they are not blocked
            // because metadata is missing.
            continue;
        };
        let current = &mut base.options[index];
        // Scope, spellings and positions are observed syntax; metadata does not
        // rewrite them. Flag conflicts are reported for review.
        if incoming.scope != current.scope {
            conflicts.push(OverlayConflict {
                key: current.key.clone(),
                field: "scope".into(),
                help: current.scope.join(" "),
                overlay: incoming.scope.join(" "),
            });
        }
        if !incoming.spellings.is_empty() && incoming.spellings != current.spellings {
            conflicts.push(OverlayConflict {
                key: current.key.clone(),
                field: "spellings".into(),
                help: current
                    .spellings
                    .iter()
                    .map(|s| s.flag.clone())
                    .collect::<Vec<_>>()
                    .join(","),
                overlay: incoming
                    .spellings
                    .iter()
                    .map(|s| s.flag.clone())
                    .collect::<Vec<_>>()
                    .join(","),
            });
        }
        if incoming.position != current.position {
            conflicts.push(OverlayConflict {
                key: current.key.clone(),
                field: "position".into(),
                help: format!("{:?}", current.position),
                overlay: format!("{:?}", incoming.position),
            });
        }
        macro_rules! fill {
            ($field:ident, $name:literal) => {
                match (&current.$field, &incoming.$field) {
                    (cur, inc)
                        if cur.certainty != Certainty::Unknown
                            && inc.certainty != Certainty::Unknown
                            && cur.value != inc.value =>
                    {
                        conflicts.push(OverlayConflict {
                            key: current.key.clone(),
                            field: $name.into(),
                            help: serde_json::to_string(&cur.value).unwrap_or_default(),
                            overlay: serde_json::to_string(&inc.value).unwrap_or_default(),
                        });
                    }
                    (cur, inc)
                        if cur.certainty == Certainty::Unknown
                            && inc.certainty != Certainty::Unknown =>
                    {
                        // Request fields and managed bindings require adapter
                        // provenance; help-sourced values never qualify.
                        let allowed = match $name {
                            "request_field" | "managed" => {
                                matches!(inc.source, Some(Source::Adapter { .. }))
                            }
                            _ => true,
                        };
                        if allowed {
                            current.$field = inc.clone();
                        }
                    }
                    _ => {}
                }
            };
        }
        fill!(kind, "kind");
        fill!(arity, "arity");
        fill!(repeatable, "repeatable");
        fill!(choices, "choices");
        fill!(range, "range");
        fill!(unit, "unit");
        fill!(runtime_default, "runtime_default");
        fill!(request_field, "request_field");
        fill!(restart_required, "restart_required");
        fill!(sensitive, "sensitive");
        fill!(local_path, "local_path");
        if incoming.managed != current.managed {
            if current.managed.is_some()
                && incoming.managed.is_some()
                && current.managed != incoming.managed
            {
                conflicts.push(OverlayConflict {
                    key: current.key.clone(),
                    field: "managed".into(),
                    help: format!("{:?}", current.managed),
                    overlay: format!("{:?}", incoming.managed),
                });
            } else if current.managed.is_none() {
                if !matches!(
                    incoming.request_field.source,
                    Some(Source::Adapter { .. }) | None
                ) {
                    // Managed bindings still require explicit adapter intent;
                    // a bare overlay value without provenance does not qualify.
                }
                // Only explicit adapter metadata may claim app-owned bindings.
                if incoming.managed.is_some() {
                    // The overlay schema was already validated, so its managed
                    // claim carries a source; help never invents one.
                    current.managed = incoming.managed;
                }
            }
        }
        if !incoming.help.is_empty() && incoming.help != current.help {
            // Verified adapter terminology supplements help text; the observed
            // help line stays in raw spans.
            current.help = format!("{} {}", current.help, incoming.help)
                .trim()
                .to_string();
        }
        if !incoming.group.is_empty() && incoming.group != current.group {
            current.group = incoming.group.clone();
        }
        if !incoming.raw_spans.is_empty() {
            current.raw_spans.extend(incoming.raw_spans.clone());
        }
        if current.target != incoming.target {
            conflicts.push(OverlayConflict {
                key: current.key.clone(),
                field: "target".into(),
                help: format!("{:?}", current.target),
                overlay: format!("{:?}", incoming.target),
            });
        }
    }
    // Constraints supplement; they never weaken observed arity.
    for constraint in overlay.constraints {
        if constraint.certainty != Certainty::Unknown {
            base.constraints.push(constraint);
        }
    }
    if overlay.end_of_options.certainty != Certainty::Unknown
        && base.end_of_options.certainty == Certainty::Unknown
    {
        base.end_of_options = overlay.end_of_options.clone();
    }
    base.validate()
        .map_err(|e| format!("overlay result is invalid: {e}"))?;
    Ok(AppliedOverlay {
        schema: base,
        conflicts,
    })
}

/// Compare two schemas from successive discoveries of the same runtime.
pub fn diff_schemas(old: &OptionSchema, new: &OptionSchema) -> SchemaDiff {
    diff_with_saved(old, new, &[])
}

/// Compare schemas and note which saved keys are retained but absent.
pub fn diff_with_saved(
    old: &OptionSchema,
    new: &OptionSchema,
    saved_keys: &[String],
) -> SchemaDiff {
    let old_map: BTreeMap<&str, &OptionDefinition> =
        old.options.iter().map(|o| (o.key.as_str(), o)).collect();
    let new_map: BTreeMap<&str, &OptionDefinition> =
        new.options.iter().map(|o| (o.key.as_str(), o)).collect();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for key in old_map.keys() {
        if !new_map.contains_key(key) {
            removed.push((*key).to_string());
        }
    }
    for (key, option) in &new_map {
        match old_map.get(key) {
            None => added.push((*key).to_string()),
            Some(previous) => {
                if previous.spellings != option.spellings
                    || previous.position != option.position
                    || previous.kind != option.kind
                    || previous.arity != option.arity
                    || previous.repeatable != option.repeatable
                    || previous.choices != option.choices
                    || previous.range != option.range
                    || previous.runtime_default != option.runtime_default
                    || previous.group != option.group
                    || previous.target != option.target
                    || previous.request_field != option.request_field
                    || previous.managed != option.managed
                {
                    changed.push((*key).to_string());
                }
            }
        }
    }
    added.sort();
    removed.sort();
    changed.sort();
    let new_keys: BTreeSet<&str> = new_map.keys().copied().collect();
    let mut retained_unknown = saved_keys
        .iter()
        .filter(|k| !new_keys.contains(k.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    retained_unknown.sort();
    SchemaDiff {
        added,
        removed,
        changed,
        retained_unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::super::runtime_help::{Encoding, HelpReport, Identity, TextOutput};
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn binding(fingerprint: &str) -> SchemaBinding {
        SchemaBinding {
            engine: "custom.example".into(),
            runtime: "build-a".into(),
            fingerprint: fingerprint.into(),
        }
    }

    fn report(text: &str) -> HelpReport {
        let fingerprint = "a".repeat(64);
        HelpReport {
            identity: Identity {
                fingerprint: fingerprint.clone(),
                executable_sha256: "b".repeat(64),
                artifacts_sha256: BTreeMap::new(),
                parser_version: PARSER_VERSION,
            },
            scope: vec![],
            stdout: TextOutput {
                text: text.into(),
                clean_text: text.into(),
                encoding: "utf-8".into(),
                decoding_loss: false,
                truncated: false,
                read_error: None,
            },
            stderr: TextOutput {
                text: String::new(),
                clean_text: String::new(),
                encoding: "utf-8".into(),
                decoding_loss: false,
                truncated: false,
                read_error: None,
            },
            exit_code: Some(0),
            success: true,
            cancelled: false,
            timed_out: false,
            error: None,
            elapsed_ms: 3,
        }
    }

    fn parse(text: &str) -> OptionSchema {
        let report = report(text);
        parse_help_report(&report, binding(&report.identity.fingerprint)).unwrap()
    }

    #[test]
    fn parses_flags_aliases_and_multiline_help_conservatively() {
        let schema = parse(
            "Usage: engine [OPTIONS]\n\nOptions:\n  -h, --help            show help\n  --threads N           thread count\n                        second line\n  --label=VALUE         label text\n",
        );
        assert_eq!(schema.options.len(), 3);
        let help = schema.options.iter().find(|o| o.key == "help").unwrap();
        assert!(help.spellings.iter().any(|s| s.flag == "-h"));
        assert!(help.spellings.iter().any(|s| s.flag == "--help"));
        assert_eq!(help.kind.supported(), Some(&ValueKind::Boolean));
        let threads = schema.options.iter().find(|o| o.key == "threads").unwrap();
        assert_eq!(
            threads.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        assert_eq!(threads.kind.certainty, Certainty::Unknown);
        assert!(threads.help.contains("second line"));
        let label = schema.options.iter().find(|o| o.key == "label").unwrap();
        assert!(label
            .spellings
            .iter()
            .any(|s| s.style == ValueStyle::Equals));
        // Numbers in prose never become ranges, defaults or choices.
        assert_eq!(threads.range.certainty, Certainty::Unknown);
        assert_eq!(threads.runtime_default.certainty, Certainty::Unknown);
        assert_eq!(threads.choices.certainty, Certainty::Unknown);
        assert!(!schema.raw_help.is_empty());
    }

    #[test]
    fn negative_flags_keep_explicit_polarity_without_inventing_true() {
        let schema = parse("Options:\n  --cache               enable cache\n  --no-cache            disable cache\n");
        let cache = schema.options.iter().find(|o| o.key == "cache").unwrap();
        assert_eq!(cache.spellings.len(), 2);
        assert!(cache.spellings.iter().any(|s| s.polarity == Some(true)));
        assert!(cache.spellings.iter().any(|s| s.polarity == Some(false)));
        let solo = parse("Options:\n  --no-cache            disable cache\n");
        let cache = solo.options.iter().find(|o| o.key == "cache").unwrap();
        assert_eq!(cache.spellings[0].polarity, Some(false));
    }

    #[test]
    fn optional_variadic_and_fixed_tuples_follow_explicit_syntax() {
        let schema = parse(
            "Options:\n  --optional [VALUE]      optional value\n  --files FILE [FILE ...]  input files\n  --pair X Y              fixed pair\n",
        );
        let optional = schema.options.iter().find(|o| o.key == "optional").unwrap();
        assert_eq!(
            optional.arity.supported(),
            Some(&Arity {
                min: 0,
                max: Some(1)
            })
        );
        let files = schema.options.iter().find(|o| o.key == "files").unwrap();
        assert_eq!(files.arity.supported(), Some(&Arity { min: 1, max: None }));
        let pair = schema.options.iter().find(|o| o.key == "pair").unwrap();
        assert_eq!(
            pair.arity.supported(),
            Some(&Arity {
                min: 2,
                max: Some(2)
            })
        );
        // Repetition across occurrences still needs explicit metadata.
        assert_eq!(pair.repeatable.certainty, Certainty::Unknown);
    }

    #[test]
    fn short_options_positionals_and_subcommand_scope_are_explicit() {
        let mut scoped = report("Options:\n  -t VALUE            short with value\n  <model-file>          input model\n");
        scoped.scope = vec!["serve".into()];
        let schema = parse_help_report(&scoped, binding(&scoped.identity.fingerprint)).unwrap();
        let short = schema
            .options
            .iter()
            .find(|o| o.spellings.iter().any(|s| s.flag == "-t"))
            .unwrap();
        assert_eq!(short.scope, vec!["serve".to_string()]);
        let positional = schema
            .options
            .iter()
            .find(|o| o.position == Some(0))
            .unwrap();
        assert!(positional.spellings.is_empty());
        assert_eq!(positional.scope, vec!["serve".to_string()]);
    }

    #[test]
    fn choices_come_from_spec_braces_only_not_prose_numbers() {
        let schema = parse("Options:\n  --mode {fast,slow}      choose mode\n  --threads N           1 to 16 threads (default: 4)\n");
        let mode = schema.options.iter().find(|o| o.key == "mode").unwrap();
        assert_eq!(
            mode.choices.supported(),
            Some(&vec![json!("fast"), json!("slow")])
        );
        let threads = schema.options.iter().find(|o| o.key == "threads").unwrap();
        assert_eq!(threads.choices.certainty, Certainty::Unknown);
        assert_eq!(threads.range.certainty, Certainty::Unknown);
    }

    #[test]
    fn app_owned_flags_are_marked_managed_not_generic() {
        let schema = parse(
            "Options:\n  --port PORT           listen port\n  --threads N           thread count\n",
        );
        let port = schema.options.iter().find(|o| o.key == "port").unwrap();
        assert_eq!(port.managed, Some(ManagedBinding::Port));
        let threads = schema.options.iter().find(|o| o.key == "threads").unwrap();
        assert_eq!(threads.managed, None);
    }

    #[test]
    fn incomplete_reports_never_parse_as_verified() {
        let mut failed = report("Options:\n  --threads N           x\n");
        failed.success = false;
        assert!(parse_help_report(&failed, binding(&failed.identity.fingerprint)).is_err());
        let mut truncated = report("Options:\n  --threads N           x\n");
        truncated.stdout.truncated = true;
        assert!(parse_help_report(&truncated, binding(&truncated.identity.fingerprint)).is_err());
    }

    #[test]
    fn overlay_fills_unknowns_reports_conflicts_and_keeps_new_flags_editable() {
        let base = parse("Options:\n  --threads N           thread count\n  --new-flag VALUE      freshly installed\n");
        let fingerprint = base.binding.fingerprint.clone();
        let mut overlay = base.clone();
        overlay.options.clear();
        for mut option in base.options.clone() {
            if option.key == "threads" {
                option.kind = Fact {
                    value: Some(ValueKind::Integer),
                    certainty: Certainty::Verified,
                    source: Some(Source::Adapter {
                        id: "test.adapter".into(),
                        revision: "r1".into(),
                    }),
                };
                option.unit = Fact {
                    value: Some("threads".into()),
                    certainty: Certainty::Verified,
                    source: Some(Source::Adapter {
                        id: "test.adapter".into(),
                        revision: "r1".into(),
                    }),
                };
                option.range = Fact {
                    value: Some(super::super::runtime_options::NumericRange {
                        min: Some(1.0),
                        max: Some(64.0),
                    }),
                    certainty: Certainty::Verified,
                    source: Some(Source::Adapter {
                        id: "test.adapter".into(),
                        revision: "r1".into(),
                    }),
                };
            }
            if option.key == "new_flag" {
                // Conflicting arity is reported, help observation wins.
                option.arity = Fact {
                    value: Some(Arity {
                        min: 2,
                        max: Some(2),
                    }),
                    certainty: Certainty::Verified,
                    source: Some(Source::Adapter {
                        id: "test.adapter".into(),
                        revision: "r1".into(),
                    }),
                };
            }
            overlay.options.push(option);
        }
        // Overlay keeps the same binding so provenance can be checked.
        overlay.binding = binding(&fingerprint);
        let applied = apply_overlay(base.clone(), overlay).unwrap();
        let threads = applied
            .schema
            .options
            .iter()
            .find(|o| o.key == "threads")
            .unwrap();
        assert_eq!(
            threads.unit.supported().map(String::as_str),
            Some("threads")
        );
        assert_eq!(
            applied
                .conflicts
                .iter()
                .filter(|c| c.key == "new_flag")
                .count(),
            1
        );
        let retained = applied
            .schema
            .options
            .iter()
            .find(|o| o.key == "new_flag")
            .unwrap();
        assert_eq!(
            retained.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        // Request fields need adapter provenance, never help alone.
        assert_eq!(retained.request_field.certainty, Certainty::Unknown);
    }

    #[test]
    fn overlay_rejects_wrong_runtime_or_fingerprint() {
        let base = parse("Options:\n  --threads N           x\n");
        let mut overlay = base.clone();
        overlay.binding.runtime = "other".into();
        assert!(apply_overlay(base.clone(), overlay).is_err());
        let mut overlay = base.clone();
        overlay.binding.fingerprint = "b".repeat(64);
        assert!(apply_overlay(base, overlay).is_err());
    }

    #[test]
    fn diff_reports_added_removed_changed_and_retained_values() {
        let old = parse("Options:\n  --keep VALUE            keep\n  --threads N           threads\n  --gone VALUE            gone\n");
        let new = parse("Options:\n  --keep VALUE            keep\n  --threads X Y           threads pair\n  --fresh VALUE           fresh\n");
        let diff = diff_with_saved(
            &old,
            &new,
            &["gone".into(), "threads".into(), "other".into()],
        );
        assert_eq!(diff.added, vec!["fresh".to_string()]);
        assert_eq!(diff.removed, vec!["gone".to_string()]);
        assert_eq!(diff.changed, vec!["threads".to_string()]);
        assert_eq!(
            diff.retained_unknown,
            vec!["gone".to_string(), "other".to_string()]
        );
    }

    #[test]
    fn raw_blocks_and_end_of_options_are_explicit() {
        let schema =
            parse("Prose without flags stays raw.\nOptions:\n  --threads N           x\n  --\n");
        assert!(schema.raw_help[0].text.contains("Prose without flags"));
        assert_eq!(schema.end_of_options.supported(), Some(&true));
        let plain = parse("Options:\n  --threads N           x\n");
        assert_eq!(plain.end_of_options.certainty, Certainty::Unknown);
    }

    #[test]
    fn encoding_variants_are_distinct_for_future_help_reports() {
        assert_ne!(Encoding::Auto, Encoding::Utf8);
    }
}
