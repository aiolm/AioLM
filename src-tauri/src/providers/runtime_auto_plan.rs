//! Propose managed launch bindings from complete observed help, never an
//! engine-name table. A plan remains unverified until an owned trial launch
//! confirms the selected model identity and actual HTTP/SSE behavior.
use super::{
    registry::{ArgBinding, ProcessSpec},
    runtime_discovery::{DiscoverySource, EntrypointKind, ObservedCommand, RuntimeCandidate},
    runtime_help::{self, Encoding, HelpCommand, HelpReport},
    runtime_help_parse::{parse_subcommands, HelpSubcommand},
    runtime_options::{Arity, OptionDefinition, OptionSchema, SchemaBinding, Target, ValueStyle},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

/// Commands nested deeper than this (`serve llm text`) are not inspected.
const MAX_COMMAND_DEPTH: usize = 3;
/// Upper bound on `--help` runs for one inspection, entry point included.
const MAX_HELP_RUNS: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedPlan {
    pub program: String,
    /// Fixed interpreter/script prefix and the documented subcommand path.
    /// Previous model, port, credential and other observed launch values are
    /// never replayed automatically.
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    pub artifacts: Vec<String>,
    pub model: ArgBinding,
    pub port: ArgBinding,
    pub host: Option<ArgBinding>,
    pub served_model: Option<ArgBinding>,
    pub health_path: String,
}

impl ManagedPlan {
    /// Templates are consumed by the app-owned trial runner. This constructs a
    /// command; it does not certify that its program uses any binding.
    pub fn launch(&self) -> Result<ProcessSpec, crate::error::AppError> {
        let mut args = self.args.clone();
        let mut append =
            |binding: &ArgBinding, value: &str| -> Result<(), crate::error::AppError> {
                let ArgBinding::Flag { flag, equals } = binding else {
                    return Err(crate::error::AppError::validation(
                        "Automatic launch requires documented single-value flags.",
                    ));
                };
                if !flag.starts_with("--")
                    || flag.len() <= 2
                    || flag.contains(['=', '\0'])
                    || flag.chars().any(char::is_whitespace)
                {
                    return Err(crate::error::AppError::validation(
                        "Invalid automatic launch binding.",
                    ));
                }
                if *equals {
                    args.push(format!("{flag}={value}"));
                } else {
                    args.extend([flag.clone(), value.into()]);
                }
                Ok(())
            };
        append(&self.model, "{model}")?;
        append(&self.port, "{port}")?;
        if let Some(host) = &self.host {
            append(host, "{host}")?;
        }
        if let Some(alias) = &self.served_model {
            append(alias, "{model_alias}")?;
        }
        Ok(ProcessSpec {
            program: self.program.clone(),
            args,
            env: Default::default(),
            working_directory: self.working_directory.clone(),
        })
    }
}

/// A command path the program documents for serving, such as `serve llm`.
/// The empty path is the entry point itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchCommand {
    pub path: Vec<String>,
    pub summary: String,
}

#[derive(Debug)]
pub enum PlanOutcome {
    Ready {
        plan: Box<ManagedPlan>,
        command: LaunchCommand,
    },
    /// Several documented commands can serve a model; the user chooses one.
    Choose(Vec<LaunchCommand>),
}

/// Called for one explicitly selected candidate, never for every discovered
/// binary. Help executes third-party code and is bounded/cancellable like
/// existing explicit help discovery. Without `selected`, the entry point's
/// help is read first; when it cannot launch a model by itself, the commands
/// it documents are read with `--help` only, never run otherwise.
pub fn plan_with_cancel(
    candidate: &RuntimeCandidate,
    cancel: &AtomicBool,
    selected: Option<&[String]>,
) -> Result<PlanOutcome, crate::error::AppError> {
    super::runtime_discovery::revalidate_with_cancel(candidate, cancel)?;
    let (command, artifacts) = selected_command(candidate)?;
    let environment = crate::runtime::child_environment()
        .into_iter()
        .map(|(name, value)| {
            Ok((
                name.into_string().map_err(|_| {
                    crate::error::AppError::validation("Non-Unicode execution environment.")
                })?,
                value.into_string().map_err(|_| {
                    crate::error::AppError::validation("Non-Unicode execution environment.")
                })?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, crate::error::AppError>>()?;
    let help = |path: &[String]| {
        let mut args = command.args.clone();
        args.extend(path.iter().cloned());
        args.push("--help".into());
        runtime_help::discover(
            &HelpCommand {
                program: command.program.clone().into(),
                args,
                environment: environment.clone(),
                working_directory: command.working_directory.as_ref().map(Into::into),
                artifacts: artifacts.iter().map(Into::into).collect(),
                runtime_version: format!("automatic-plan-v1:{}", candidate.id),
                scope: path.to_vec(),
                encoding: Encoding::Auto,
                timeout_ms: 10000,
                output_limit: 1024 * 1024,
            },
            cancel,
        )
    };
    let plan = |path: &[String], report: &HelpReport| {
        plan_from_help(candidate, &command, &artifacts, path, report)
    };
    resolve(selected, cancel, help, plan)
}

fn documented_children(path: &[String], report: &HelpReport) -> Vec<(Vec<String>, HelpSubcommand)> {
    parse_subcommands(report)
        .unwrap_or_default()
        .into_iter()
        // `help <command>` prints another command's help; it never serves.
        .filter(|command| command.name != "help")
        .map(|command| {
            let mut next = path.to_vec();
            next.push(command.name.clone());
            (next, command)
        })
        .collect()
}

fn resolve(
    selected: Option<&[String]>,
    cancel: &AtomicBool,
    mut help: impl FnMut(&[String]) -> Result<HelpReport, crate::error::AppError>,
    mut plan: impl FnMut(&[String], &HelpReport) -> Result<ManagedPlan, crate::error::AppError>,
) -> Result<PlanOutcome, crate::error::AppError> {
    if let Some(path) = selected {
        if path.len() > MAX_COMMAND_DEPTH {
            return Err(crate::error::AppError::validation(
                "The selected command is nested deeper than automatic connection inspects.",
            ));
        }
        // Every word must still be documented by its parent's current help.
        let mut summary = String::new();
        for depth in 0..path.len() {
            let report = help(&path[..depth])?;
            summary = documented_children(&path[..depth], &report)
                .into_iter()
                .find(|(child, _)| child[depth] == path[depth]).ok_or_else(|| crate::error::AppError::validation("The selected command is no longer documented by the program; inspect it again."))?
                .1
                .summary;
        }
        let report = help(path)?;
        let plan = plan(path, &report)?;
        return Ok(PlanOutcome::Ready {
            plan: Box::new(plan),
            command: LaunchCommand {
                path: path.to_vec(),
                summary,
            },
        });
    }
    let root = help(&[])?;
    let root_error = match plan(&[], &root) {
        Ok(plan) => {
            return Ok(PlanOutcome::Ready {
                plan: Box::new(plan),
                command: LaunchCommand {
                    path: vec![],
                    summary: String::new(),
                },
            })
        }
        Err(error) => error,
    };
    let mut pending = VecDeque::from(documented_children(&[], &root));
    let inspected_commands = !pending.is_empty();
    let mut found = Vec::new();
    let mut runs = 1;
    while let Some((path, entry)) = pending.pop_front() {
        if cancel.load(Ordering::Acquire) {
            return Err(crate::error::AppError::cancelled(
                "help discovery cancelled",
            ));
        }
        if runs == MAX_HELP_RUNS {
            break;
        }
        runs += 1;
        // A command whose help fails is not a launch choice; its siblings are.
        let Ok(report) = help(&path) else {
            continue;
        };
        match plan(&path, &report) {
            Ok(plan) => found.push((
                LaunchCommand {
                    path,
                    summary: entry.summary,
                },
                plan,
            )),
            Err(_) if path.len() < MAX_COMMAND_DEPTH => {
                pending.extend(documented_children(&path, &report));
            }
            Err(_) => {}
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err(crate::error::AppError::cancelled(
            "help discovery cancelled",
        ));
    }
    match found.len() {
        0 if inspected_commands => Err(crate::error::AppError::validation("Neither the entry point nor a command it documents shows one model path, listening port and host option.")),
        0 => Err(root_error),
        1 => {
            let (command, plan) = found.pop().unwrap();
            Ok(PlanOutcome::Ready {
                plan: Box::new(plan),
                command,
            })
        }
        _ => Ok(PlanOutcome::Choose(
            found.into_iter().map(|(command, _)| command).collect(),
        )),
    }
}

fn selected_command(
    candidate: &RuntimeCandidate,
) -> Result<(ObservedCommand, Vec<String>), crate::error::AppError> {
    if candidate.source != DiscoverySource::SelectedFolder
        || !matches!(
            candidate.entrypoint_kind,
            EntrypointKind::Native | EntrypointKind::Interpreter
        )
    {
        return Err(crate::error::AppError::validation("Automatic managed launch needs a selected local entry point. Existing listeners use the separate connection check."));
    }
    let mut command = candidate.command.clone().ok_or_else(|| {
        crate::error::AppError::validation(
            "This entry point needs its executable or interpreter configured.",
        )
    })?;
    if !command.args.is_empty() {
        return Err(crate::error::AppError::validation("The fixed interpreter/module/subcommand prefix is unverified; previous launch arguments will not be replayed."));
    }
    let path = Path::new(&command.program);
    if !path.is_absolute() || !path.is_file() {
        return Err(crate::error::AppError::validation(
            "Select an existing absolute entry-point file.",
        ));
    }
    if candidate.entrypoint_path.as_deref() != Some(command.program.as_str()) {
        return Err(crate::error::AppError::validation(
            "The selected entry point does not match its observed command.",
        ));
    }
    let mut artifacts = Vec::new();
    if candidate.entrypoint_kind == EntrypointKind::Interpreter {
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|e| crate::error::AppError::from_io(&e))?
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|e| crate::error::AppError::from_io(&e))?;
        let first = bytes.split(|byte| *byte == b'\n').next().ok_or_else(|| {
            crate::error::AppError::validation("The interpreter declaration is missing.")
        })?;
        let first = std::str::from_utf8(first).map_err(|_| {
            crate::error::AppError::validation("The interpreter declaration is not UTF-8.")
        })?;
        let interpreter = first
            .strip_prefix("#!")
            .ok_or_else(|| {
                crate::error::AppError::validation("The interpreter declaration is missing.")
            })?
            .trim();
        // Only a literal absolute interpreter can be reproduced generically.
        // env selectors, optional interpreter flags and launcher expressions
        // need structured command metadata rather than language-specific guesses.
        if interpreter.is_empty()
            || interpreter.chars().any(char::is_whitespace)
            || !Path::new(interpreter).is_absolute()
            || !Path::new(interpreter).is_file()
        {
            return Err(crate::error::AppError::validation(
                "The script needs an explicit verified interpreter and argument prefix.",
            ));
        }
        artifacts.push(command.program.clone());
        command.args.push(command.program.clone());
        command.program = interpreter.into();
    }
    Ok((command, artifacts))
}

fn alias_description(option: &OptionDefinition) -> bool {
    let description = option.help.to_ascii_lowercase();
    description.contains("model")
        && (description.contains("served")
            || description.contains("api")
            || description.contains("request"))
        && (description.contains("name")
            || description.contains("alias")
            || description.contains("identifier"))
}

fn binding(
    schema: &OptionSchema,
    scope: &[String],
    flags: &[&str],
    role: &str,
    required: bool,
    require_alias_description: bool,
) -> Result<Option<ArgBinding>, crate::error::AppError> {
    let matching = schema
        .options
        .iter()
        .filter_map(|option| {
            let spelling = option
                .spellings
                .iter()
                .find(|spelling| flags.contains(&spelling.flag.as_str()))?;
            Some((option, spelling))
        })
        .collect::<Vec<_>>();
    if matching.is_empty() && !required {
        return Ok(None);
    }
    if matching.len() != 1 {
        return Err(crate::error::AppError::validation(format!(
            "The help does not establish one unambiguous {role} option."
        )));
    }
    let (option, spelling) = matching[0];
    if option.target != Target::Launch
        || option.scope != scope
        || option.arity.supported()
            != Some(&Arity {
                min: 1,
                max: Some(1),
            })
        || spelling.polarity.is_some()
        || (require_alias_description && !alias_description(option))
    {
        return Err(crate::error::AppError::validation(format!(
            "The documented {role} option needs further configuration."
        )));
    }
    Ok(Some(ArgBinding::Flag {
        flag: spelling.flag.clone(),
        equals: spelling.style == ValueStyle::Equals,
    }))
}

fn plan_from_help(
    candidate: &RuntimeCandidate,
    command: &ObservedCommand,
    artifacts: &[String],
    path: &[String],
    report: &HelpReport,
) -> Result<ManagedPlan, crate::error::AppError> {
    if !report.complete() {
        return Err(report
            .incomplete_error("Help discovery did not complete; no automatic plan was created."));
    }
    let schema = super::runtime_help_parse::parse_help_report(
        report,
        SchemaBinding {
            engine: "custom.automatic".into(),
            runtime: candidate.id.clone(),
            fingerprint: report.identity.fingerprint.clone(),
        },
    )?;
    let model = binding(
        &schema,
        path,
        &["--model", "--model-path", "--model-dir"],
        "model path",
        true,
        false,
    )?
    .ok_or_else(|| crate::error::AppError::validation("The model path option is missing."))?;
    let port =
        binding(&schema, path, &["--port"], "listening port", true, false)?.ok_or_else(|| {
            crate::error::AppError::validation("The listening port option is missing.")
        })?;
    let host = binding(&schema, path, &["--host"], "listening host", true, false)?;
    let served_model = binding(
        &schema,
        path,
        &["--served-model-name", "--model-alias", "--alias"],
        "served model alias",
        false,
        true,
    )?;
    let mut args = command.args.clone();
    args.extend(path.iter().cloned());
    Ok(ManagedPlan {
        program: command.program.clone(),
        args,
        working_directory: command.working_directory.clone(),
        artifacts: artifacts.to_vec(),
        model,
        port,
        host,
        served_model,
        health_path: "/health".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::{
        runtime_discovery::{ArgvSource, DiscoveryState},
        runtime_help::{Identity, TextOutput, PARSER_VERSION},
    };
    use super::*;
    use std::collections::BTreeMap;

    fn candidate(id: &str) -> RuntimeCandidate {
        RuntimeCandidate {
            id: id.into(),
            source: DiscoverySource::SelectedFolder,
            display_name: "Independent entry point".into(),
            entrypoint_path: Some("/synthetic/native".into()),
            entrypoint_fingerprint: None,
            command: Some(ObservedCommand {
                program: "/synthetic/native".into(),
                args: vec![],
                working_directory: Some("/synthetic".into()),
                argv_source: ArgvSource::ExecutableFile,
            }),
            endpoints: vec![],
            entrypoint_kind: EntrypointKind::Native,
            state: DiscoveryState::NeedsConfiguration,
            pid: None,
            process_identity: None,
            reasons: vec![],
        }
    }
    fn report(help: &str) -> HelpReport {
        let output = |text: &str| TextOutput {
            text: text.into(),
            clean_text: text.into(),
            encoding: "utf-8".into(),
            decoding_loss: false,
            truncated: false,
            read_error: None,
            raw_bytes_base64: None,
        };
        HelpReport {
            identity: Identity {
                fingerprint: "a".repeat(64),
                executable_sha256: "b".repeat(64),
                artifacts_sha256: BTreeMap::new(),
                parser_version: PARSER_VERSION,
            },
            scope: vec![],
            stdout: output(help),
            stderr: output(""),
            exit_code: Some(0),
            success: true,
            cancelled: false,
            timed_out: false,
            error: None,
            elapsed_ms: 1,
        }
    }
    fn from_help(id: &str, help: &str) -> Result<ManagedPlan, crate::error::AppError> {
        let candidate = candidate(id);
        plan_from_help(
            &candidate,
            candidate.command.as_ref().unwrap(),
            &[],
            &[],
            &report(help),
        )
    }

    const ROOT: &str = "Usage: engine <COMMAND>\n\nCommands:\n  serve  Start a server\n  bench  Benchmark a model\n  help   Print help for a specific command\n\nOptions:\n  -h, --help  Print help\n";
    const SERVE: &str = "Commands:\n  text   Serve text endpoints\n  video  Serve video endpoints\n\nOptions:\n  -i, --host <IP>  Bind address\n  -p, --port <N>   Port\n";
    const LEAF: &str = "Options:\n  -m, --model <PATH>         Model file\n      --served-model-name <ID> Model identifier exposed by the API\n  -i, --host <IP>            Bind address\n  -p, --port <N>             Port\n";
    const BENCH: &str = "Options:\n  -m, --model <PATH>  Model file\n";

    /// Answers `--help` for documented paths only, scoped like real discovery,
    /// and records every path that was asked.
    fn resolve_with(
        pages: &[(&str, &str)],
        selected: Option<&[String]>,
    ) -> (Result<PlanOutcome, crate::error::AppError>, Vec<String>) {
        let candidate = candidate("opaque-entry");
        let command = candidate.command.clone().unwrap();
        let mut asked = Vec::new();
        let outcome = resolve(
            selected,
            &AtomicBool::new(false),
            |path: &[String]| {
                let key = path.join(" ");
                asked.push(key.clone());
                let text = pages
                    .iter()
                    .find(|(page, _)| *page == key)
                    .ok_or_else(|| crate::error::AppError::validation("no help"))?
                    .1;
                let mut help = report(text);
                help.scope = path.to_vec();
                Ok(help)
            },
            |path: &[String], help: &HelpReport| {
                plan_from_help(&candidate, &command, &[], path, help)
            },
        );
        (outcome, asked)
    }

    #[test]
    fn documented_serving_commands_are_offered_for_choice_and_a_choice_is_rechecked() {
        let pages = [
            ("", ROOT),
            ("serve", SERVE),
            ("serve text", LEAF),
            ("serve video", LEAF),
            ("bench", BENCH),
        ];
        let (outcome, asked) = resolve_with(&pages, None);
        let Ok(PlanOutcome::Choose(choices)) = outcome else {
            panic!("expected a command choice: {outcome:?}");
        };
        assert_eq!(
            choices,
            [
                LaunchCommand {
                    path: vec!["serve".into(), "text".into()],
                    summary: "Serve text endpoints".into()
                },
                LaunchCommand {
                    path: vec!["serve".into(), "video".into()],
                    summary: "Serve video endpoints".into()
                },
            ]
        );
        // `help` prints help for other commands; it is never inspected.
        assert!(!asked.iter().any(|path| path.starts_with("help")));

        let selected = ["serve".to_string(), "text".to_string()];
        let (outcome, _) = resolve_with(&pages, Some(&selected));
        let Ok(PlanOutcome::Ready { plan, command }) = outcome else {
            panic!("expected a launch plan: {outcome:?}");
        };
        assert_eq!(command.summary, "Serve text endpoints");
        assert_eq!(
            plan.launch().unwrap().args,
            [
                "serve",
                "text",
                "--model",
                "{model}",
                "--port",
                "{port}",
                "--host",
                "{host}",
                "--served-model-name",
                "{model_alias}"
            ]
        );

        for undocumented in [["serve", "audio"], ["bench", "text"]] {
            let path = undocumented.map(String::from);
            assert!(resolve_with(&pages, Some(&path)).0.is_err(), "{path:?}");
        }
    }

    #[test]
    fn one_serving_command_is_planned_and_an_entry_point_plan_is_not_walked() {
        let pages = [
            ("", ROOT),
            ("serve", SERVE),
            ("serve text", LEAF),
            ("bench", BENCH),
        ];
        let (outcome, _) = resolve_with(&pages, None);
        let Ok(PlanOutcome::Ready { plan, command }) = outcome else {
            panic!("expected a launch plan: {outcome:?}");
        };
        assert_eq!(command.path, ["serve", "text"]);
        assert_eq!(plan.args, ["serve", "text"]);

        let (outcome, asked) = resolve_with(&[("", LEAF)], None);
        assert!(
            matches!(outcome, Ok(PlanOutcome::Ready { ref command, .. }) if command.path.is_empty())
        );
        assert_eq!(asked, [""]);

        let (outcome, _) = resolve_with(&[("", ROOT), ("serve", SERVE), ("bench", BENCH)], None);
        assert!(outcome
            .unwrap_err()
            .message
            .contains("Neither the entry point nor a command"));
    }

    #[test]
    fn observed_common_flags_produce_the_same_bindings_for_unrelated_entry_identities() {
        let help = "Options:\n  --model-path FILE  Model directory or file\n  --port PORT  Listening port\n  --host HOST  Listening host\n  --served-model-name NAME  Model name served by the API\n";
        for id in ["opaque-first-entry", "unrelated-second-entry"] {
            let plan = from_help(id, help).unwrap();
            assert_eq!(
                plan.model,
                ArgBinding::Flag {
                    flag: "--model-path".into(),
                    equals: false
                }
            );
            assert_eq!(
                plan.port,
                ArgBinding::Flag {
                    flag: "--port".into(),
                    equals: false
                }
            );
            assert!(plan.host.is_some() && plan.served_model.is_some());
            assert!(plan.args.is_empty());
        }
    }

    #[test]
    fn ambiguous_optional_boolean_or_unrelated_alias_flags_never_become_launch_bindings() {
        for help in [
            "Options:\n  --model FILE  Model\n  --model-dir DIR  Another model\n  --port PORT  Listening port\n",
            "Options:\n  --model  Enable model feature\n  --port PORT  Listening port\n",
            "Options:\n  --model [FILE]  Optional model\n  --port PORT  Listening port\n",
            "Options:\n  --model FILE  Model\n  --port PORT  Listening port\n",
            "Options:\n  --model FILE  Model\n  --port PORT  Listening port\n  --alias VALUE  Account alias\n",
        ] { assert!(from_help("unlisted-entry", help).is_err(), "{help}"); }
    }

    #[test]
    fn absent_alias_stays_absent_and_equals_syntax_is_preserved() {
        let plan = from_help(
            "unlisted-entry",
            "Options:\n  --model=FILE  Model file\n  --port=PORT  Listening port\n  --host=HOST  Listening host\n",
        )
        .unwrap();
        assert_eq!(
            plan.model,
            ArgBinding::Flag {
                flag: "--model".into(),
                equals: true
            }
        );
        assert!(plan.host.is_some() && plan.served_model.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn explicitly_selected_script_help_preserves_its_interpreter_prefix_without_running_a_model() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("aiolm-auto-plan-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let script = root.join("unlisted entry point");
        fs::write(&script, b"#!/bin/sh\nif [ \"$#\" != 1 ] || [ \"$1\" != --help ]; then touch model-was-run; exit 1; fi\nprintf '%s\\n' 'Options:' '  --model FILE  Local model path' '  --port PORT  Listening port' '  --host HOST  Listening host' '  --served-model-name NAME  Model name served by the API'\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let discovery =
            super::super::runtime_discovery::discover(Some(&root), &AtomicBool::new(false))
                .unwrap();
        let selected = discovery
            .candidates
            .iter()
            .find(|candidate| candidate.entrypoint_path.as_deref() == script.to_str())
            .unwrap();
        let result = plan_with_cancel(selected, &AtomicBool::new(false), None).map(|outcome| {
            let PlanOutcome::Ready { plan, .. } = outcome else {
                panic!("a single entry point needs no command choice");
            };
            *plan
        });
        let never_ran = !root.join("model-was-run").exists();
        let _ = fs::remove_dir_all(&root);
        let plan = result.unwrap();
        assert!(never_ran);
        assert_eq!(plan.program, "/bin/sh");
        assert_eq!(plan.args, [script.to_string_lossy()]);
        assert_eq!(plan.artifacts, [script.to_string_lossy()]);
        let launch = plan.launch().unwrap();
        assert_eq!(launch.args[0], script.to_string_lossy());
        assert!(launch
            .args
            .windows(2)
            .any(|pair| pair == ["--served-model-name", "{model_alias}"]));
    }

    #[test]
    fn incomplete_help_and_observed_launch_arguments_cannot_sneak_into_an_automatic_plan() {
        let mut candidate = candidate("opaque-entry");
        candidate.command.as_mut().unwrap().args = vec![
            "--model".into(),
            "old-model".into(),
            "--api-key".into(),
            "synthetic-secret".into(),
        ];
        assert!(selected_command(&candidate)
            .unwrap_err()
            .message
            .contains("will not be replayed"));
        let mut help = report("Options:\n  --model FILE  Model\n  --port PORT  Listening port\n");
        help.stdout.truncated = true;
        assert!(plan_from_help(
            &candidate,
            candidate.command.as_ref().unwrap(),
            &[],
            &[],
            &help
        )
        .is_err());
    }
}
