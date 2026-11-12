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
fn equals_in_separate_metavars_never_hides_the_option_or_changes_its_spelling() {
    let schema = parse(
        "Options:\n  --header KEY=VALUE                  header value\n  -D KEY=VALUE, --define KEY=VALUE    definition\n  --attached=KEY=VALUE               attached value\n  --mode {fast=1,slow=2}              explicit choices\n",
    );
    assert_eq!(schema.options.len(), 4);
    for key in ["header", "define", "attached", "mode"] {
        let option = schema
            .options
            .iter()
            .find(|option| option.key == key)
            .unwrap();
        assert_eq!(
            option.arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            })
        );
        let style = if key == "attached" {
            ValueStyle::Equals
        } else {
            ValueStyle::Separate
        };
        assert!(option
            .spellings
            .iter()
            .all(|spelling| spelling.style == style));
    }
    let mode = schema
        .options
        .iter()
        .find(|option| option.key == "mode")
        .unwrap();
    assert_eq!(
        mode.choices.supported(),
        Some(&vec![
            serde_json::json!("fast=1"),
            serde_json::json!("slow=2")
        ])
    );
}

#[test]
fn negative_flags_keep_explicit_polarity_without_inventing_true() {
    let schema = parse(
        "Options:\n  --cache               enable cache\n  --no-cache            disable cache\n",
    );
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
fn a_choice_metavar_with_a_prose_tail_does_not_verify_a_tuple_or_closed_choices() {
    for spec in [
        "{one,two} or name registered in --plugin",
        "{one,two} or a custom name",
        "{one,two} or {a plugin name}",
        "[{one,two}] or a custom name",
    ] {
        let text = format!("Options:\n  --parser {spec}\n  --plugin PATH         extension path\n");
        let schema = parse(&text);
        let parser = schema
            .options
            .iter()
            .find(|option| option.key == "parser")
            .unwrap();
        assert_eq!(parser.arity.certainty, Certainty::Unknown, "{spec}");
        assert_eq!(parser.choices.certainty, Certainty::Unknown, "{spec}");
        assert_eq!(schema.raw_help[0].text, text);
    }
}

#[test]
fn a_whole_choice_metavar_consumes_one_value_even_when_choice_names_contain_spaces() {
    let schema = parse("Options:\n  --color {red green,deep blue}\n  --other={red green,deep blue}\n  --optional [{red green,deep blue}]\n  --pair HOST PORT       coordinates\n  --header KEY=VALUE     header\n");
    for (key, min) in [("color", 1), ("other", 1), ("optional", 0)] {
        let option = schema
            .options
            .iter()
            .find(|option| option.key == key)
            .unwrap();
        assert_eq!(
            option.arity.supported(),
            Some(&Arity { min, max: Some(1) }),
            "{key}"
        );
    }
    assert_eq!(
        schema.options[0].choices.supported(),
        Some(&vec![json!("red green"), json!("deep blue")])
    );
    assert_eq!(schema.options[0].spellings[0].style, ValueStyle::Separate);
    assert_eq!(schema.options[1].spellings[0].style, ValueStyle::Equals);
    assert_eq!(
        schema.options[3].arity.supported(),
        Some(&Arity {
            min: 2,
            max: Some(2)
        })
    );
    assert_eq!(
        schema.options[4].arity.supported(),
        Some(&Arity {
            min: 1,
            max: Some(1)
        })
    );
    assert_eq!(schema.options[4].spellings[0].style, ValueStyle::Separate);
}

#[test]
fn short_options_positionals_and_subcommand_scope_are_explicit() {
    let mut scoped = report(
        "Options:\n  -t VALUE            short with value\n  <model-file>          input model\n",
    );
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
    let prose = parse("Options:\n  --port PORT   port\n\nnotes:\n  model files are read lazily\n");
    assert!(prose.options.iter().all(|o| o.position.is_none()));
}

#[test]
fn wrapped_option_prose_keeps_links_code_and_examples_out_of_positional_slots() {
    let text = "positional arguments:\n  model_tag             model to serve\n\noptions:\n  --config VALUE        configuration\n                        [synthetic.module][]. Documentation link.\n                        [reader](https://example.invalid/reader)\n                        Note:\n                        <Mode.FLAGGED: 'example'>,\n                        [\"first\", \"second\"]). Module list.\n\n                        Examples:\n                        --example-only VALUE\n                        --\n  <other-file>          another input\n  --next VALUE          next setting\n";
    for stderr in [false, true] {
        let mut report = report(text);
        if stderr {
            report.stderr = report.stdout.clone();
            report.stdout.text.clear();
            report.stdout.clean_text.clear();
        }
        let schema = parse_help_report(&report, binding(&report.identity.fingerprint)).unwrap();
        assert_eq!(
            schema
                .options
                .iter()
                .filter(|option| option.position.is_some())
                .map(|option| (option.key.as_str(), option.position))
                .collect::<Vec<_>>(),
            vec![("model_tag", Some(0)), ("other_file", Some(1))]
        );
        assert_eq!(schema.options.len(), 4);
        let config = schema
            .options
            .iter()
            .find(|option| option.key == "config")
            .unwrap();
        for prose in [
            "[synthetic.module][]",
            "[reader](https://example.invalid/reader)",
            "<Mode.FLAGGED: 'example'>",
            "[\"first\", \"second\"]",
            "--example-only VALUE",
        ] {
            assert!(config.help.contains(prose), "missing description {prose}");
        }
        assert_eq!(config.group, "options");
        assert_eq!(
            config.raw_spans,
            vec![help_source(if stderr { "stderr" } else { "stdout" }, 5, 14)]
        );
        assert_eq!(schema.end_of_options.certainty, Certainty::Unknown);
        assert!(schema.raw_help.iter().any(|help| help.text == text));
    }
}

#[test]
fn unrecognized_bracketed_prose_stays_raw_without_invalidating_documented_options() {
    let text = "Options:\n  --threads N           workers\n\nNotes:\n  [reader](https://example.invalid/reader)\n  [synthetic.module][]. Documentation link.\n  <Mode.FLAGGED: 'example'>,\n  [unclosed\n  <mismatched]\n";
    let schema = parse(text);
    assert_eq!(schema.options.len(), 1);
    assert_eq!(schema.options[0].key, "threads");
    assert_eq!(schema.raw_help[0].text, text);
}

#[test]
fn real_section_headers_reset_continuation_indent_and_standalone_delimiters_still_parse() {
    let text = "Options:\n--first VALUE  first option\n    --prose-example VALUE\n\nAdditional:\n  --second VALUE  second option\n\n--\n";
    let schema = parse(text);
    assert_eq!(
        schema
            .options
            .iter()
            .map(|option| option.key.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    assert_eq!(schema.options[0].group, "options");
    assert!(schema.options[0].help.contains("--prose-example VALUE"));
    assert_eq!(schema.options[1].group, "additional");
    assert_eq!(schema.end_of_options.supported(), Some(&true));
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
                    min_exclusive: false,
                    max_exclusive: false,
                    sentinel_values: Vec::new(),
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
        parse_help_report(&stderr_report, binding(&stderr_report.identity.fingerprint)).unwrap();
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
    let schema = parse("-kvo, --kv-offload, -nkvo, --no-kv-offload            offload control\n");
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

/// Verbatim clap long-help layout: long-only rows align under the long
/// spelling of `-m, --model` rows, and wide specs use one space.
const CLAP_SERVE_HELP: &str = "Usage: engine serve text [OPTIONS]\n\nModel:\n  -m, --model <PATH>         Path to model file (required)\n      --sidecar <PATH>       Optional sidecar file\n      --served-model-name <ID> Model identifier exposed by the OpenAI API (repeatable; the first is primary)\n  -c, --context <N>          Context tokens per session\n\nServer:\n  -i, --host <IP>            Bind address\n  -p, --port <N>             Port to listen on\n  -j, --sessions <N>         Preallocated request sessions\n      --max-connections <N>  Maximum simultaneous HTTP connections\n      --reasoning-budget <N> Reasoning tokens before </think> is forced: -1 unlimited\n";

#[test]
fn clap_long_only_rows_and_single_space_specs_are_separate_one_value_options() {
    let schema = parse(CLAP_SERVE_HELP);
    let option = |flag: &str| {
        schema
            .options
            .iter()
            .find(|o| o.spellings.iter().any(|s| s.flag == flag))
            .unwrap_or_else(|| panic!("{flag} was not parsed as its own option"))
    };
    for flag in [
        "--model",
        "--sidecar",
        "--served-model-name",
        "--context",
        "--host",
        "--port",
        "--sessions",
        "--max-connections",
        "--reasoning-budget",
    ] {
        assert_eq!(
            option(flag).arity.supported(),
            Some(&Arity {
                min: 1,
                max: Some(1)
            }),
            "{flag}"
        );
    }
    assert_eq!(option("--model").help, "Path to model file (required)");
    assert_eq!(
        option("--served-model-name").help,
        "Model identifier exposed by the OpenAI API (repeatable; the first is primary)"
    );
    assert!(option("--reasoning-budget")
        .help
        .contains("</think> is forced"));
}

#[test]
fn subcommands_come_only_from_command_sections() {
    let top = report("Usage: engine <COMMAND> [OPTIONS]\n\nCommands:\n  serve          Start the server\n  bench          Benchmark prompt processing and token\n                 generation\n  embedding Serve embeddings with a long name\n  help           Print help for a specific command\n\nRun 'engine help <COMMAND>' for details\n\nOptions:\n  -h, --help     Print help\n  --run-anything VALUE  not a command\n");
    assert_eq!(
        parse_subcommands(&top).unwrap(),
        vec![
            HelpSubcommand {
                name: "serve".into(),
                summary: "Start the server".into()
            },
            HelpSubcommand {
                name: "bench".into(),
                summary: "Benchmark prompt processing and token generation".into()
            },
            HelpSubcommand {
                name: "embedding".into(),
                summary: "Serve embeddings with a long name".into()
            },
            HelpSubcommand {
                name: "help".into(),
                summary: "Print help for a specific command".into()
            },
        ]
    );
    let cobra = report("Available Commands:\n  completion  Generate completion script\n  run         Run a model\n\nFlags:\n  -h, --help   help\n");
    assert_eq!(
        parse_subcommands(&cobra)
            .unwrap()
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["completion", "run"]
    );
    // Options, positional choice lists and prose never name commands.
    for text in [
        "Options:\n  --serve        start\n",
        "positional arguments:\n  {serve,bench}\n    serve        start the server\n",
        "serve   Start the server\n",
        CLAP_SERVE_HELP,
    ] {
        assert!(
            parse_subcommands(&report(text)).unwrap().is_empty(),
            "{text}"
        );
    }
    let mut failed = report("Commands:\n  serve  Start\n");
    failed.success = false;
    assert!(parse_subcommands(&failed).is_err());
}
