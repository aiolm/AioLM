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
    /// Aliases spell different value counts, so no single arity is observed.
    /// Arity and choices stay unknown until explicit metadata reconciles them.
    alias_conflict: bool,
}

/// Bound a string without panicking on a multibyte boundary. Korean/emoji
/// descriptions are truncated at the last whole character; raw evidence stays
/// intact in `raw_help`.
fn truncate_text(value: &mut String, max: usize) {
    if value.len() > max {
        value.truncate(value.floor_char_boundary(max));
    }
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

fn split_spec_help(
    line: &str,
    group: &str,
    start_line: u32,
) -> (String, String, Option<PendingOption>) {
    // Help separates the flag spec from prose with two or more spaces, but the
    // same gap also separates aliases (`-t,    --threads N`). The boundary is
    // the first gap whose left side is a complete explicit option spec: an
    // alias-list prefix (`-t,`) never qualifies, so the split cannot cut
    // inside the spec.
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b' ' || bytes[i] == b'\t' {
            let start = i;
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            if i - start >= 2 {
                let left = line[..start].trim_end();
                if !left.is_empty() && left.len() <= 1024 {
                    let parsed = parse_option_spec(left, group, start_line);
                    if parsed.is_some() {
                        return (left.into(), line[i..].trim().into(), parsed);
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    // No gap completes a spec: either a spec-only line whose description
    // lives on the next line (long argparse flags), or prose that no spec
    // candidate accepts. Callers treat an unparsable spec as unconfirmed.
    let spec = line.trim().to_owned();
    let parsed = (spec.len() <= 1024)
        .then(|| parse_option_spec(&spec, group, start_line))
        .flatten();
    (spec, String::new(), parsed)
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
    let mut alias_metavars: Vec<String> = Vec::new();
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
            alias_metavars.push(value.trim().into());
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
        alias_metavars.push(tokens.collect::<Vec<_>>().join(" "));
    }
    if spellings.is_empty() || spellings.len() > 8 {
        return None;
    }
    // Each alias independently observes the same value count (`-t VALUE,
    // --threads VALUE` is one value, not two). An alias that omits the
    // metavar (`-t, --threads N`) adopts the unanimous spelling; only aliases
    // that spell different counts keep arity unknown until metadata decides.
    let nonempty: Vec<&str> = alias_metavars
        .iter()
        .map(|m| m.trim())
        .filter(|m| !m.is_empty())
        .collect();
    let unanimous = nonempty
        .first()
        .is_some_and(|first| nonempty.iter().all(|m| **m == **first));
    let (metavar, alias_conflict) = match (nonempty.first(), unanimous) {
        (Some(value), true) => ((*value).to_string(), false),
        (None, _) => (String::new(), false),
        (Some(_), false) => (alias_metavars.join(" "), true),
    };
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
        alias_conflict,
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
    section_row: bool,
) -> Option<PendingOption> {
    // `<name>`, `[name]`, `MODEL`, `[FILE ...]` on its own line; inside a
    // positional section, also a lowercase name (argparse's default) on a row
    // at that section's own indent.
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.len() > 256 {
        return None;
    }
    let looks_positional = trimmed.starts_with('<')
        || trimmed.starts_with('[')
        || trimmed
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase())
        || (section_row
            && trimmed
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase())
            && trimmed
                .split(|c: char| c.is_whitespace())
                .next()
                .is_some_and(|name| {
                    name.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                }));
    if !looks_positional {
        return None;
    }
    // A positional row is its name (single-spaced `FILE ...` allowed), a
    // column gap of two or more spaces, then its description.
    let (spec, help) = match trimmed.find("  ").or_else(|| trimmed.find('\t')) {
        Some(gap) => (
            trimmed[..gap].trim_end().to_owned(),
            trimmed[gap..].trim().to_owned(),
        ),
        None => (trimmed.to_owned(), String::new()),
    };
    if spec.contains('\0') || help.contains('\0') {
        return None;
    }
    // Wrapped usage fragments (`[--port PORT] [--alias ALIAS]`) carry flags,
    // never a positional name; callers skip usage wraps before trying this.
    if spec.contains("--") {
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
        alias_conflict: false,
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
    if report.stdout.decoding_loss || report.stderr.decoding_loss {
        return Err("help output is incomplete because decoding lost bytes; choose the engine's help encoding and discover again".into());
    }
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
    let stdout_text = report.stdout.clean_text.as_str();
    let stderr_text = report.stderr.clean_text.as_str();
    // Complete help may live on either stream: some CLIs print `--help` to
    // stderr with an empty stdout. An empty stream never shadows a documented
    // one. Truncated/lossy/failed reports were rejected above, so the chosen
    // text is exact and every span below names its real source stream.
    let (document, text): (&str, &str) =
        if stdout_text.trim().is_empty() && !stderr_text.trim().is_empty() {
            ("stderr", stderr_text)
        } else {
            ("stdout", stdout_text)
        };
    if text.len() > 2 * 1024 * 1024 {
        return Err("help output exceeds its schema limit".into());
    }
    let mut options: Vec<PendingOption> = Vec::new();
    let mut current_group = "runtime".to_string();
    let mut positional_section = false;
    // The indent of the first row in the current section: argparse lists its
    // rows there and wraps descriptions or nests subcommands deeper.
    let mut section_indent: Option<usize> = None;
    let mut in_usage_wrap = false;
    let mut positional_slot: u16 = 0;
    let mut last_option: Option<usize> = None;
    let mut end_of_options = Fact::default();

    for (index, line) in text.lines().enumerate() {
        let line_no = u32::try_from(index + 1).unwrap_or(u32::MAX);
        // A bare `--` line documents an explicitly supported delimiter.
        if line.trim() == "--" {
            end_of_options = verified(true, document, line_no, line_no);
            last_option = None;
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            in_usage_wrap = false;
            last_option = None;
            continue;
        }
        // Usage lines name subcommands but never become options themselves.
        if trimmed
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("usage:"))
        {
            in_usage_wrap = true;
            last_option = None;
            continue;
        }
        if is_section_header(trimmed) {
            current_group = normalize_group(trimmed);
            positional_section = current_group.contains("positional")
                || current_group.contains("operand")
                || current_group == "arguments";
            section_indent = None;
            in_usage_wrap = false;
            last_option = None;
            continue;
        }
        // Wrapped usage fragments (`[--port PORT]`) are usage, not options.
        if in_usage_wrap {
            if trimmed.starts_with('[') || trimmed.starts_with('(') {
                continue;
            }
            in_usage_wrap = false;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let indent = line.len() - line.trim_start().len();
        let section_row = positional_section && *section_indent.get_or_insert(indent) == indent;
        // Continuation of the previous option's description. Only indented
        // lines continue: COLUMN0 prose ends the previous option so it stays
        // inspectable instead of being absorbed into help text.
        if indented {
            if let Some(idx) = last_option {
                let looks_new = trimmed.starts_with('-')
                    || trimmed.starts_with('/')
                    || trimmed.starts_with('<')
                    || section_row
                    || (trimmed
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_uppercase())
                        && split_spec_help(trimmed, &current_group, line_no).0.len() <= 64);
                if !looks_new {
                    let entry = &mut options[idx];
                    if !entry.help.is_empty() {
                        entry.help.push(' ');
                    }
                    entry.help.push_str(trimmed);
                    entry.end_line = line_no;
                    if entry.help.len() > 32_768 {
                        truncate_text(&mut entry.help, 32_768);
                    }
                    continue;
                }
            }
        }
        // Explicit option syntax parses at any indent: real help (llama.cpp)
        // spells flags at COLUMN0, so an indent requirement yields zero
        // options. Anything unparsable stays raw, never an option.
        if trimmed.starts_with('-') || trimmed.starts_with('/') {
            let (spec, help, parsed) = split_spec_help(trimmed, &current_group, line_no);
            if spec.is_empty() || spec.len() > 1024 {
                last_option = None;
                continue;
            }
            if let Some(mut pending) = parsed {
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
        // Positional facts need a positional section or explicit `<name>` /
        // `[name]` syntax. Bare uppercase prose and usage fragments stay raw.
        if positional_section || trimmed.starts_with('<') || trimmed.starts_with('[') {
            if let Some(pending) = parse_positional(
                trimmed,
                &current_group,
                line_no,
                positional_slot,
                section_row,
            ) {
                positional_slot = positional_slot.saturating_add(1);
                if options.len() < 4096 {
                    options.push(pending);
                    last_option = Some(options.len() - 1);
                } else {
                    last_option = None;
                }
                continue;
            }
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
    // A lone `--no-foo` is the false spelling of `foo` only while nothing
    // else is named `foo`. Beside a valued `--foo VALUE` (llama.cpp's
    // `--no-host` buffer switch and `--host HOST` address) it is an
    // independent switch whose own spelling means true, so neither option is
    // dropped as a duplicate and neither takes the other's meaning.
    let taken: Option<BTreeSet<String>> = if merged.iter().any(|pending| pending.negative_only) {
        Some(
            merged
                .iter()
                .filter(|pending| !pending.negative_only)
                .map(|pending| pending.key.clone())
                .collect(),
        )
    } else {
        None
    };
    for pending in &mut merged {
        if !pending.negative_only
            || !taken
                .as_ref()
                .is_some_and(|taken| taken.contains(&pending.key))
        {
            continue;
        }
        let Some(own) = pending
            .spellings
            .iter()
            .find(|s| s.flag.starts_with("--no-"))
            .map(|s| s.flag.trim_start_matches('-').replace('-', "_"))
        else {
            continue;
        };
        pending.key = own;
        pending.negative_only = false;
        for spelling in &mut pending.spellings {
            spelling.polarity = None;
        }
    }

    let mut definitions: Vec<OptionDefinition> = Vec::new();
    let mut seen_keys: BTreeSet<String> = BTreeSet::new();
    let mut seen_flags: BTreeSet<(Vec<String>, String)> = BTreeSet::new();
    let mut seen_positions: BTreeSet<(Vec<String>, u16)> = BTreeSet::new();
    let scope = report.scope.clone();
    for mut pending in merged {
        truncate_text(&mut pending.help, 32_768);
        // Same flag text in the same scope must not define two options.
        let mut duplicate = false;
        for spelling in &pending.spellings {
            if !seen_flags.insert((scope.clone(), spelling.flag.clone())) {
                duplicate = true;
            }
        }
        let mut key = pending.key;
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
        let parsed_arity = arity_for_metavar(&pending.metavar);
        let (kind, arity) = if pending.positional.is_some() {
            (
                Fact::default(),
                parsed_arity
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
        } else if pending.alias_conflict {
            // Aliases disagree on the value count: no single arity was
            // observed, so argv waits for explicit metadata.
            (Fact::default(), Fact::default())
        } else {
            (
                Fact::default(),
                parsed_arity
                    .map(|a| verified(a, document, pending.start_line, pending.end_line))
                    .unwrap_or_default(),
            )
        };
        // Choices only from explicit `{a,b}` / `[a|b]` in an agreed spec.
        let choices =
            if pending.positional.is_none() && !pending.is_boolean && !pending.alias_conflict {
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
            if spelling.style == ValueStyle::Equals && parsed_arity.is_none_or(|a| a.max != Some(1))
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

    // An empty schema verifies nothing: help with no explicit option syntax
    // cannot count as a supported engine, so callers rediscover instead of
    // caching an unverified absence of options.
    if definitions.is_empty() {
        return Err("help contains no explicit option syntax; nothing verified".into());
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

/// Adapter metadata carries adapter sources; help observations and bare
/// overlays do not. App-owned bindings are only claimed with explicit adapter
/// intent, never from prose-level overlay values.
fn has_adapter_provenance(option: &OptionDefinition) -> bool {
    macro_rules! adapter_sourced {
        ($fact:expr) => {
            $fact.certainty != Certainty::Unknown
                && matches!($fact.source, Some(Source::Adapter { .. }))
        };
    }
    adapter_sourced!(option.kind)
        || adapter_sourced!(option.arity)
        || adapter_sourced!(option.repeatable)
        || adapter_sourced!(option.choices)
        || adapter_sourced!(option.range)
        || adapter_sourced!(option.unit)
        || adapter_sourced!(option.runtime_default)
        || adapter_sourced!(option.request_field)
        || adapter_sourced!(option.restart_required)
        || adapter_sourced!(option.sensitive)
        || adapter_sourced!(option.local_path)
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
    let mut known: Option<BTreeSet<&str>> = None;
    for incoming in overlay.options {
        let Some(&index) = by_key.get(&incoming.key) else {
            // New flags are not a fixed allowlist: unknown help flags stay
            // editable through the conservative schema, they are not blocked
            // because metadata is missing.
            continue;
        };
        if !incoming.raw_spans.is_empty() && known.is_none() {
            known = Some(base.raw_help.iter().map(|h| h.id.as_str()).collect());
        }
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
            } else if current.managed.is_none() && incoming.managed.is_some() {
                // Only explicit adapter metadata may claim app-owned bindings.
                if has_adapter_provenance(&incoming) {
                    current.managed = incoming.managed;
                } else {
                    conflicts.push(OverlayConflict {
                        key: current.key.clone(),
                        field: "managed".into(),
                        help: "none".into(),
                        overlay: format!("{:?}", incoming.managed),
                    });
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
            // Observed spans must name a document this schema actually holds;
            // foreign documents are not silently stitched into validation.
            for span in &incoming.raw_spans {
                let observed = match span {
                    Source::Help { document, .. } => known
                        .as_ref()
                        .is_some_and(|known| known.contains(document.as_str())),
                    _ => true,
                };
                if observed && !current.raw_spans.contains(span) {
                    current.raw_spans.push(span.clone());
                }
            }
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
    // Constraints supplement; they never weaken observed arity. Like request
    // fields and managed bindings, constraints require adapter provenance;
    // help alone never provides them.
    for constraint in overlay.constraints {
        if constraint.certainty != Certainty::Unknown
            && matches!(constraint.source, Some(Source::Adapter { .. }))
        {
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
    retained_unknown.dedup();
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
                raw_bytes_base64: None,
            },
            stderr: TextOutput {
                text: String::new(),
                clean_text: String::new(),
                encoding: "utf-8".into(),
                decoding_loss: false,
                truncated: false,
                read_error: None,
                raw_bytes_base64: None,
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

    /// The two lines of the private llama.cpp build's help that lost `--host`:
    /// `--no-host` is an independent host-buffer switch, not the negation of
    /// the HTTP address option.
    const NO_HOST: &str = "--no-host                               bypass host buffer allowing extra buffers to be used\n";
    const HOST: &str = "--host HOST                             IP addresses to listen on, comma-separated, or UNIX socket paths\n";

    #[test]
    fn an_independent_negative_switch_never_hides_a_value_option_of_the_same_name() {
        for text in [format!("{NO_HOST}{HOST}"), format!("{HOST}{NO_HOST}")] {
            let schema = parse(&text);
            let by_flag = |flag: &str| {
                schema
                    .options
                    .iter()
                    .find(|o| o.spellings.iter().any(|s| s.flag == flag))
                    .unwrap_or_else(|| panic!("{flag} missing in {text:?}"))
            };
            let host = by_flag("--host");
            assert_eq!(host.key, "host");
            assert_eq!(host.spellings.len(), 1);
            assert_eq!(
                host.arity.supported(),
                Some(&Arity {
                    min: 1,
                    max: Some(1)
                })
            );
            assert_eq!(host.managed, Some(ManagedBinding::Host));
            // The switch keeps its own name and says true by being spelled.
            let switch = by_flag("--no-host");
            assert_eq!(switch.key, "no_host");
            assert_eq!(switch.spellings.len(), 1);
            assert_eq!(switch.spellings[0].polarity, None);
            assert_eq!(switch.kind.supported(), Some(&ValueKind::Boolean));
            assert!(switch.managed.is_none());
            let overrides = BTreeMap::from([(
                "no_host".to_string(),
                serde_json::from_value(json!({"occurrences": [[true]]})).unwrap(),
            )]);
            assert_eq!(schema.resolve(&[], &overrides).unwrap().argv, ["--no-host"]);
            // Its raw span is its own line, not the address option's.
            let line = text
                .lines()
                .position(|l| l.starts_with("--no-host"))
                .unwrap() as u32
                + 1;
            assert_eq!(
                switch.raw_spans,
                [Source::Help {
                    document: "stdout".into(),
                    start_line: line,
                    end_line: line
                }]
            );
        }
    }

    #[test]
    fn documented_boolean_pairs_still_merge_in_either_order() {
        for text in [
            "--cache               enable cache\n--no-cache            disable cache\n",
            "--no-cache            disable cache\n--cache               enable cache\n",
            "-c, --cache, --no-cache   toggle cache\n",
        ] {
            let schema = parse(text);
            assert_eq!(schema.options.len(), 1, "{text:?}");
            let cache = &schema.options[0];
            assert_eq!(cache.key, "cache");
            assert!(cache
                .spellings
                .iter()
                .any(|s| s.flag == "--cache" && s.polarity == Some(true)));
            assert!(cache
                .spellings
                .iter()
                .any(|s| s.flag == "--no-cache" && s.polarity == Some(false)));
        }
        // A solo negative with no same-named option keeps its earlier key and
        // false meaning, so saved values do not change meaning.
        let solo = parse("--no-mmap   do not memory-map model\n--threads N   threads\n");
        let mmap = solo.options.iter().find(|o| o.key == "mmap").unwrap();
        assert_eq!(mmap.spellings[0].polarity, Some(false));
    }

    #[test]
    fn a_saved_value_under_the_old_switch_key_is_reported_not_moved() {
        // Under the earlier parser `host: false` meant `--no-host`. The key now
        // names the app-owned address binding: the value is refused and kept,
        // never silently re-sent as `--no-host` or as an address.
        let schema = parse(&format!("{NO_HOST}{HOST}"));
        let overrides = BTreeMap::from([(
            "host".to_string(),
            serde_json::from_value(json!({"occurrences": [[false]]})).unwrap(),
        )]);
        let issues = schema.resolve(&[], &overrides).unwrap_err();
        assert_eq!(issues[0].key, "host");
        assert!(issues[0].message.contains("managed by the app"));
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
    fn argparse_lowercase_positionals_are_rows_at_the_section_indent_only() {
        // Verbatim Python 3.12 argparse layout: a subcommand choice list,
        // its deeper-indented commands, a wrapped description.
        let schema = parse("usage: engine [-h] [--port PORT] {serve,bench} ... input model_path\n\npositional arguments:\n  {serve,bench}\n    serve        start the server\n    bench        run a benchmark\n  input          input file to read, with a long description that argparse\n                 wraps onto a second line of help text\n  model_path     model path\n\noptions:\n  -h, --help     show this help message and exit\n  --port PORT\n");
        let positionals: Vec<(&str, Option<u16>)> = schema
            .options
            .iter()
            .filter(|o| o.position.is_some())
            .map(|o| (o.key.as_str(), o.position))
            .collect();
        assert_eq!(
            positionals,
            vec![("input", Some(0)), ("model_path", Some(1))]
        );
        let input = schema.options.iter().find(|o| o.key == "input").unwrap();
        assert!(
            input.help.ends_with("second line of help text"),
            "{}",
            input.help
        );
        assert_eq!(
            input.arity.value,
            Some(Arity {
                min: 1,
                max: Some(1)
            })
        );
        assert!(schema.options.iter().any(|o| o.key == "port"));
        // Outside a positional section lowercase prose never becomes one.
        let prose =
            parse("Options:\n  --port PORT   port\n\nnotes:\n  model files are read lazily\n");
        assert!(prose.options.iter().all(|o| o.position.is_none()));
    }

    #[test]
    fn a_positional_row_description_is_not_part_of_its_value_count() {
        let schema = parse("positional arguments:\n  TARGET                entry to serve\nOptions:\n  --flag                switch\n");
        let arity = |key: &str| {
            schema
                .options
                .iter()
                .find(|o| o.key == key)
                .unwrap()
                .arity
                .value
        };
        assert_eq!(
            arity("target"),
            Some(Arity {
                min: 1,
                max: Some(1)
            })
        );
        assert_eq!(
            schema
                .options
                .iter()
                .find(|o| o.key == "target")
                .unwrap()
                .help,
            "entry to serve"
        );
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

    /// External raw acceptance against root-owned help captures. Opt-in only:
    /// set `AIOLM_REAL_HELP_DIR` to a directory holding `llama-b11617.stdout`,
    /// `argparse-v1.stdout` and `argparse-v2-1000.stdout`. Never commits those
    /// files (they carry local paths) and never logs their text; only counts,
    /// keys and arities are asserted. Run with
    /// `AIOLM_REAL_HELP_DIR=<dir> cargo test --locked --lib -- --ignored
    /// real_help_acceptance_opt_in`.
    #[test]
    #[ignore]
    fn real_help_acceptance_opt_in() {
        let dir = std::env::var("AIOLM_REAL_HELP_DIR")
            .expect("AIOLM_REAL_HELP_DIR must point at the real capture dir");
        let load = |name: &str| {
            let text = std::fs::read_to_string(std::path::Path::new(&dir).join(name))
                .unwrap_or_else(|e| panic!("cannot read {name}: {e}"));
            let fingerprint = format!("{:064x}", text.len() * 31 + 7);
            let mut full = report(&text);
            full.identity.fingerprint = fingerprint.clone();
            parse_help_report(&full, binding(&fingerprint))
                .unwrap_or_else(|e| panic!("{name} ({} bytes) failed to parse: {e}", text.len()))
        };
        // Pinned llama help: COLUMN0 with multi-space alias gaps.
        let llama = load("llama-b11617.stdout");
        assert!(
            llama.options.len() >= 200,
            "llama options: {}",
            llama.options.len()
        );
        for key in ["help", "version", "threads", "ctx_size"] {
            assert!(llama.options.iter().any(|o| o.key == key), "missing {key}");
        }
        let threads = llama.options.iter().find(|o| o.key == "threads").unwrap();
        assert_eq!(
            threads.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        // Argparse v1: exact small shapes incl. paired toggle, fixed pair,
        // variadic items, optional value and explicit choices.
        let v1 = load("argparse-v1.stdout");
        for key in ["probe", "model", "host", "port", "alias", "trace"] {
            assert!(v1.options.iter().any(|o| o.key == key), "v1 missing {key}");
        }
        let by_suffix = |suffix: &str| {
            v1.options
                .iter()
                .find(|o| o.key.ends_with(suffix))
                .unwrap_or_else(|| panic!("v1 missing *{suffix}"))
        };
        assert_eq!(
            by_suffix("_count").arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        assert_eq!(
            by_suffix("_pair").arity.supported(),
            Some(&Arity {
                min: 2,
                max: Some(2)
            })
        );
        assert_eq!(
            by_suffix("_items").arity.supported(),
            Some(&Arity { min: 1, max: None })
        );
        assert_eq!(
            by_suffix("_optional").arity.supported(),
            Some(&Arity {
                min: 0,
                max: Some(1)
            })
        );
        let toggle = by_suffix("_toggle");
        assert!(toggle.spellings.iter().any(|s| s.polarity == Some(true)));
        assert!(toggle.spellings.iter().any(|s| s.polarity == Some(false)));
        // Argparse v2: 1000 bulk flags plus an arity widening on count.
        let v2 = load("argparse-v2-1000.stdout");
        assert!(v2.options.len() >= 1000, "v2 options: {}", v2.options.len());
        assert_eq!(
            by_suffix_v2(&v2, "_count").arity.supported(),
            Some(&Arity {
                min: 2,
                max: Some(2)
            })
        );
    }

    fn by_suffix_v2<'a>(schema: &'a OptionSchema, suffix: &str) -> &'a OptionDefinition {
        schema
            .options
            .iter()
            .find(|o| o.key.ends_with(suffix))
            .unwrap_or_else(|| panic!("v2 missing *{suffix}"))
    }

    #[test]
    fn column0_llama_syntax_with_alias_gaps_parses_without_indent() {
        // Exact upstream shapes from real captures: COLUMN0, multi-space
        // alias gaps, a three-alias boolean and a bare long boolean.
        let schema = parse(
            "-h,    --help, --usage                  print usage and exit\n-t,    --threads N                      number of CPU threads\n--version                               show version and build info\n",
        );
        assert!(
            schema.options.len() >= 3,
            "got {:?}",
            schema
                .options
                .iter()
                .map(|o| o.key.clone())
                .collect::<Vec<_>>()
        );
        let help = schema.options.iter().find(|o| o.key == "help").unwrap();
        assert_eq!(help.spellings.len(), 3);
        assert_eq!(help.kind.supported(), Some(&ValueKind::Boolean));
        let threads = schema.options.iter().find(|o| o.key == "threads").unwrap();
        assert_eq!(
            threads.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        let version = schema.options.iter().find(|o| o.key == "version").unwrap();
        assert_eq!(version.kind.supported(), Some(&ValueKind::Boolean));
    }

    #[test]
    fn independent_alias_metavars_reconcile_instead_of_summing() {
        // Indented so the only defect under test is arity: each alias spells
        // one value, so the option takes exactly one value, not two.
        let schema =
            parse("Options:\n  -t VALUE, --threads VALUE              spelled on both aliases\n");
        let threads = schema.options.iter().find(|o| o.key == "threads").unwrap();
        assert_eq!(
            threads.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        // Aliases that disagree on the value count keep arity unknown so argv
        // waits for explicit metadata instead of emitting summed values.
        let conflicted =
            parse("Options:\n  -x A, --ex A B              aliases disagree on value count\n");
        let ex = conflicted.options.iter().find(|o| o.key == "ex").unwrap();
        assert_eq!(ex.arity.certainty, Certainty::Unknown);
    }

    #[test]
    fn complete_stderr_help_parses_with_stderr_provenance() {
        let mut stderr_report = report("");
        stderr_report.stdout.clean_text = String::new();
        stderr_report.stdout.text = String::new();
        let help = "Options:\n  --from-stderr VALUE   documented on stderr\n";
        stderr_report.stderr.clean_text = help.into();
        stderr_report.stderr.text = help.into();
        let schema =
            parse_help_report(&stderr_report, binding(&stderr_report.identity.fingerprint))
                .unwrap();
        let option = schema
            .options
            .iter()
            .find(|o| o.key == "from_stderr")
            .expect("stderr option is parsed");
        assert_eq!(
            option.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        for span in &option.raw_spans {
            match span {
                Source::Help { document, .. } => assert_eq!(document, "stderr"),
                other => panic!("stderr option keeps an unexpected source {other:?}"),
            }
        }
    }

    #[test]
    fn long_korean_help_truncates_at_a_char_boundary_without_panicking() {
        // "가" is 3 bytes in UTF-8; 11_000 of them (33_000 bytes) straddle the
        // 32_768 truncation bound at a non-boundary offset.
        let description = "가".repeat(11_000);
        let schema = parse(&format!(
            "Options:\n  --big WORD            {description}\n"
        ));
        let big = schema.options.iter().find(|o| o.key == "big").unwrap();
        assert!(big.help.len() <= 32_768);
        assert!(big.help.is_char_boundary(big.help.len()));
    }

    #[test]
    fn uppercase_prose_and_wrapped_usage_never_become_positionals() {
        let schema = parse(
            "usage: engine [--port PORT]\n  [--port PORT] [--alias ALIAS]\n\nOptions:\n  --port PORT           listen port\n  SOMEPROSE             stray uppercase line\n",
        );
        assert!(schema.options.iter().any(|o| o.key == "port"));
        assert!(
            schema.options.iter().all(|o| o.position.is_none()),
            "got {:?}",
            schema
                .options
                .iter()
                .map(|o| (o.key.clone(), o.position))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn four_alias_boolean_keeps_observed_polarity_only() {
        let schema =
            parse("-kvo, --kv-offload, -nkvo, --no-kv-offload            offload control\n");
        let kv = schema
            .options
            .iter()
            .find(|o| o.key == "kv_offload")
            .unwrap();
        assert_eq!(kv.spellings.len(), 4);
        assert_eq!(kv.kind.supported(), Some(&ValueKind::Boolean));
        // Polarity records observed spellings; request semantics stay unknown.
        assert_eq!(kv.request_field.certainty, Certainty::Unknown);
    }

    #[test]
    fn empty_help_is_not_a_supported_schema() {
        let prose = report("Prose without flags stays raw.\n");
        assert!(parse_help_report(&prose, binding(&prose.identity.fingerprint)).is_err());
    }

    #[test]
    fn next_line_argparse_description_does_not_become_metavar() {
        let schema = parse("options:\n  --trace PATH\n          synthetic log path\n");
        let trace = schema.options.iter().find(|o| o.key == "trace").unwrap();
        assert_eq!(
            trace.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        assert!(trace.help.contains("synthetic log path"));
    }

    #[test]
    fn overlay_managed_bindings_need_adapter_provenance() {
        let base = parse("Options:\n  --threads N           thread count\n");
        let fingerprint = base.binding.fingerprint.clone();
        let mut overlay = base.clone();
        overlay.options.clear();
        let mut threads = base
            .options
            .iter()
            .find(|o| o.key == "threads")
            .unwrap()
            .clone();
        threads.managed = Some(ManagedBinding::Port);
        // No adapter-sourced fact: help text alone must not claim app ownership.
        overlay.options.push(threads);
        overlay.binding = binding(&fingerprint);
        let applied = apply_overlay(base.clone(), overlay).unwrap();
        let kept = applied
            .schema
            .options
            .iter()
            .find(|o| o.key == "threads")
            .unwrap();
        assert_eq!(kept.managed, None);
        assert!(applied
            .conflicts
            .iter()
            .any(|c| c.key == "threads" && c.field == "managed"));
    }

    #[test]
    fn overlay_constraints_need_adapter_provenance() {
        use super::super::runtime_options::{Predicate, Relation};
        let base = parse("Options:\n  --threads N           x\n  --mode VALUE          y\n");
        let mut overlay = base.clone();
        overlay.constraints.push(Fact {
            value: Some(Relation::Requires {
                when: Predicate {
                    key: "threads".into(),
                    equals: None,
                },
                other: Predicate {
                    key: "mode".into(),
                    equals: None,
                },
            }),
            certainty: Certainty::Verified,
            source: Some(Source::Help {
                document: "stdout".into(),
                start_line: 1,
                end_line: 1,
            }),
        });
        let applied = apply_overlay(base, overlay).unwrap();
        assert!(applied.schema.constraints.is_empty());
    }
}
