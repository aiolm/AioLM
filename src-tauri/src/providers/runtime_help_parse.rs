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

impl PendingOption {
    fn append_help(&mut self, text: &str, line: u32) {
        if !self.help.is_empty() {
            self.help.push(' ');
        }
        self.help.push_str(text);
        self.end_line = line;
        truncate_text(&mut self.help, 32_768);
    }
}

fn parse_choices(metavar: &str) -> Option<Vec<serde_json::Value>> {
    let trimmed = metavar.trim();
    // Explicit `{a,b,c}` or `[a|b]` in the flag spec only; prose after two
    // spaces never becomes a constraint.
    if let Some(inner) = trimmed
        .strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .filter(|inner| !inner.contains(['{', '}']))
    {
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
    let bracketed = text.starts_with('[') && text.ends_with(']');
    let inner = if bracketed {
        text[1..text.len().saturating_sub(1)].trim()
    } else {
        text
    };
    // A complete choice set is one value, including choices containing spaces.
    // A custom metavar may continue with prose or an open set of extension
    // names; its words do not establish a tuple or a closed choice set.
    if text.starts_with("[{") && !bracketed {
        return None;
    }
    if inner.starts_with('{') {
        parse_choices(inner)?;
        return Some(Arity {
            min: if bracketed { 0 } else { 1 },
            max: Some(1),
        });
    }
    let has_ellipsis = text.contains("...");
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

/// clap prints `--name <ID> Description` with a single space when the spec is
/// wider than its help column. An angle- or square-bracketed value name that
/// is followed by one space and an alphanumeric word ends the spec there. Only
/// text before the first wide gap is considered, so wrapped prose that merely
/// mentions `<tags>` never moves a split chosen by the column gap.
fn single_space_spec_end(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let wide = line
        .find("  ")
        .into_iter()
        .chain(line.find('\t'))
        .min()
        .unwrap_or(line.len());
    let mut depth = 0_i32;
    let mut bracketed = false;
    for (index, &byte) in bytes[..wide].iter().enumerate() {
        match byte {
            b'<' => {
                depth += 1;
                bracketed = true;
            }
            b'[' | b'{' => depth += 1,
            b'>' | b']' | b'}' => depth -= 1,
            b' ' if depth == 0
                && bracketed
                && index > 0
                && matches!(bytes[index - 1], b'>' | b']')
                && bytes.get(index + 1).is_some_and(u8::is_ascii_alphanumeric) =>
            {
                return Some(index);
            }
            _ => {}
        }
    }
    None
}

fn split_spec_help(
    line: &str,
    group: &str,
    start_line: u32,
) -> (String, String, Option<PendingOption>) {
    if let Some(end) = single_space_spec_end(line) {
        let left = line[..end].trim_end();
        if left.len() <= 1024 {
            if let Some(parsed) = parse_option_spec(left, group, start_line) {
                return (left.into(), line[end..].trim().into(), Some(parsed));
            }
        }
    }
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
        // Only '=' attached to the flag selects the equals spelling. A
        // separate metavar such as KEY=VALUE stays one separate argv value.
        if let Some((flag, value)) = alias
            .split_once('=')
            .filter(|(flag, _)| !flag.chars().any(char::is_whitespace))
        {
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
    let wrapped = spec.strip_suffix("...").unwrap_or(&spec).trim();
    if (wrapped.starts_with('[') && !wrapped.ends_with(']'))
        || (wrapped.starts_with('<') && !wrapped.ends_with('>'))
    {
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
    if !super::runtime_options::identifier(&name) {
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

/// The complete help text and the stream it came from. Failed, truncated or
/// lossy reports never parse, so callers cannot treat partial help as facts.
fn complete_help_text(report: &HelpReport) -> Result<(&'static str, &str), crate::error::AppError> {
    if report.stdout.decoding_loss || report.stderr.decoding_loss {
        return Err(report.incomplete_error("help output is incomplete because decoding lost bytes; choose the engine's help encoding and discover again"));
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
        return Err(report
            .incomplete_error("help output is incomplete; rediscover before building options"));
    }
    if report.identity.parser_version != PARSER_VERSION {
        return Err(crate::error::AppError::validation(
            "help report uses an unsupported parser version",
        ));
    }
    let stdout_text = report.stdout.clean_text.as_str();
    let stderr_text = report.stderr.clean_text.as_str();
    // Complete help may live on either stream: some CLIs print `--help` to
    // stderr with an empty stdout. An empty stream never shadows a documented
    // one. Truncated/lossy/failed reports were rejected above, so the chosen
    // text is exact and every span below names its real source stream.
    let (document, text) = if stdout_text.trim().is_empty() && !stderr_text.trim().is_empty() {
        ("stderr", stderr_text)
    } else {
        ("stdout", stdout_text)
    };
    if text.len() > 2 * 1024 * 1024 {
        return Err(crate::error::AppError::validation(
            "help output exceeds its schema limit",
        ));
    }
    Ok((document, text))
}

/// One command row from a help section that lists commands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelpSubcommand {
    pub name: String,
    pub summary: String,
}

const MAX_SUBCOMMANDS: usize = 64;

fn subcommand_name(token: &str) -> bool {
    (1..=64).contains(&token.len())
        && token
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}

/// Commands a program documents under a header that names commands
/// (`Commands:`, `Available Commands:`, `Subcommands:`). A row is its first
/// word, then the summary after it; deeper lines wrap that summary. Options,
/// usage lines and prose outside such a section are never command names.
pub fn parse_subcommands(
    report: &HelpReport,
) -> Result<Vec<HelpSubcommand>, crate::error::AppError> {
    let (_, text) = complete_help_text(report)?;
    let mut commands: Vec<HelpSubcommand> = Vec::new();
    let mut header_indent: Option<usize> = None;
    let mut row_indent: Option<usize> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if is_section_header(trimmed) {
            let group = normalize_group(trimmed);
            let lists_commands = group
                .split_whitespace()
                .any(|word| matches!(word, "commands" | "subcommands" | "sub-commands"));
            header_indent = lists_commands.then_some(indent);
            row_indent = None;
            continue;
        }
        let Some(header) = header_indent else {
            continue;
        };
        if indent <= header {
            header_indent = None;
            continue;
        }
        let row = *row_indent.get_or_insert(indent);
        if indent > row {
            if let Some(last) = commands.last_mut() {
                if last.summary.len() + trimmed.len() < 1024 {
                    if !last.summary.is_empty() {
                        last.summary.push(' ');
                    }
                    last.summary.push_str(trimmed);
                }
            }
            continue;
        }
        if indent < row {
            header_indent = None;
            continue;
        }
        let mut words = trimmed.splitn(2, char::is_whitespace);
        let name = words.next().unwrap_or_default();
        if !subcommand_name(name) || commands.iter().any(|command| command.name == name) {
            continue;
        }
        if commands.len() == MAX_SUBCOMMANDS {
            break;
        }
        commands.push(HelpSubcommand {
            name: name.into(),
            summary: words
                .next()
                .unwrap_or_default()
                .trim()
                .chars()
                .take(512)
                .collect(),
        });
    }
    Ok(commands)
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
) -> Result<OptionSchema, crate::error::AppError> {
    let (document, text) = complete_help_text(report)?;
    if binding.fingerprint != report.identity.fingerprint {
        return Err(crate::error::AppError::validation(
            "schema binding must match the discovered help fingerprint",
        ));
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
    let mut last_option_indent = 0;
    // Where the long spelling starts on a `-m, --model` row. clap aligns
    // long-only rows (`    --mmproj`) under it, deeper than the short row.
    let mut last_option_long_column: Option<usize> = None;
    let mut end_of_options = Fact::default();

    for (index, line) in text.lines().enumerate() {
        let line_no = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            in_usage_wrap = false;
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        // A wrapped description may itself contain headers, bracketed links,
        // JSON, flag examples or `--`. Its deeper indent keeps that prose on
        // the option instead of inventing another option or positional slot.
        if let Some(idx) = last_option.filter(|_| indent > last_option_indent) {
            let aligned_option = last_option_long_column == Some(indent)
                && trimmed.starts_with("--")
                && split_spec_help(trimmed, &current_group, line_no)
                    .2
                    .is_some();
            if !aligned_option {
                options[idx].append_help(trimmed, line_no);
                continue;
            }
        }
        // A bare `--` line documents an explicitly supported delimiter.
        if trimmed == "--" {
            end_of_options = verified(true, document, line_no, line_no);
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
                    options[idx].append_help(trimmed, line_no);
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
                    last_option_indent = indent;
                    last_option_long_column = (!trimmed.starts_with("--"))
                        .then(|| spec.find(", --").map(|at| indent + at + 2))
                        .flatten();
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
                    last_option_indent = indent;
                    last_option_long_column = None;
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
            benchmark_public: Fact::default(),
            benchmark_name: Fact::default(),
            benchmark_role: Fact::default(),
            managed,
            raw_spans: vec![help_source(document, pending.start_line, pending.end_line)],
        });
    }

    // An empty schema verifies nothing: help with no explicit option syntax
    // cannot count as a supported engine, so callers rediscover instead of
    // caching an unverified absence of options.
    if definitions.is_empty() {
        return Err(crate::error::AppError::validation(
            "help contains no explicit option syntax; nothing verified",
        ));
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
    schema.validate().map_err(|e| {
        crate::error::AppError::validation(format!("parsed help schema is invalid: {e}"))
    })?;
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
) -> Result<AppliedOverlay, crate::error::AppError> {
    overlay
        .validate()
        .map_err(crate::error::AppError::validation)?;
    base.validate()
        .map_err(crate::error::AppError::validation)?;
    if overlay.binding.engine != base.binding.engine
        || overlay.binding.runtime != base.binding.runtime
    {
        return Err(crate::error::AppError::validation(
            "metadata overlay targets another runtime",
        ));
    }
    if overlay.binding.fingerprint != base.binding.fingerprint {
        return Err(crate::error::AppError::validation(
            "metadata overlay fingerprint must match the discovered help",
        ));
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
    base.validate().map_err(|e| {
        crate::error::AppError::validation(format!("overlay result is invalid: {e}"))
    })?;
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
#[path = "runtime_help_parse_tests.rs"]
mod tests;
