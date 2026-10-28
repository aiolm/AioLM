//! Propose managed launch bindings from complete observed help, never an
//! engine-name table. A plan remains unverified until an owned trial launch
//! confirms the selected model identity and actual HTTP/SSE behavior.
use super::{
    registry::{ArgBinding, ProcessSpec},
    runtime_discovery::{DiscoverySource, EntrypointKind, ObservedCommand, RuntimeCandidate},
    runtime_help::{self, Encoding, HelpCommand, HelpReport},
    runtime_options::{Arity, OptionDefinition, OptionSchema, SchemaBinding, Target, ValueStyle},
};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path, sync::atomic::AtomicBool};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedPlan {
    pub program: String,
    /// Fixed interpreter/script prefix only. Previous model, port, credential
    /// and other observed launch values are never replayed automatically.
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
    pub fn launch(&self) -> Result<ProcessSpec, String> {
        let mut args = self.args.clone();
        let mut append = |binding: &ArgBinding, value: &str| -> Result<(), String> {
            let ArgBinding::Flag { flag, equals } = binding else {
                return Err("Automatic launch requires documented single-value flags.".into());
            };
            if !flag.starts_with("--")
                || flag.len() <= 2
                || flag.contains(['=', '\0'])
                || flag.chars().any(char::is_whitespace)
            {
                return Err("Invalid automatic launch binding.".into());
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

/// Called for one explicitly selected candidate, never for every discovered
/// binary. Help executes third-party code and is bounded/cancellable like
/// existing explicit help discovery.
pub fn plan(candidate: &RuntimeCandidate) -> Result<ManagedPlan, String> {
    plan_with_cancel(candidate, &AtomicBool::new(false))
}

pub fn plan_with_cancel(
    candidate: &RuntimeCandidate,
    cancel: &AtomicBool,
) -> Result<ManagedPlan, String> {
    super::runtime_discovery::revalidate_with_cancel(candidate, cancel)?;
    let (command, artifacts) = selected_command(candidate)?;
    let mut args = command.args.clone();
    args.push("--help".into());
    let help = HelpCommand {
        program: command.program.clone().into(),
        args,
        environment: crate::runtime::child_environment()
            .into_iter()
            .map(|(name, value)| {
                Ok((
                    name.into_string()
                        .map_err(|_| "Non-Unicode execution environment.")?,
                    value
                        .into_string()
                        .map_err(|_| "Non-Unicode execution environment.")?,
                ))
            })
            .collect::<Result<_, String>>()?,
        working_directory: command.working_directory.as_ref().map(Into::into),
        artifacts: artifacts.iter().map(Into::into).collect(),
        runtime_version: format!("automatic-plan-v1:{}", candidate.id),
        scope: vec![],
        encoding: Encoding::Auto,
        timeout_ms: 10000,
        output_limit: 1024 * 1024,
    };
    let report = runtime_help::discover(&help, cancel)?;
    plan_from_help(candidate, command, artifacts, &report)
}

fn selected_command(
    candidate: &RuntimeCandidate,
) -> Result<(ObservedCommand, Vec<String>), String> {
    if candidate.source != DiscoverySource::SelectedFolder
        || !matches!(
            candidate.entrypoint_kind,
            EntrypointKind::Native | EntrypointKind::Interpreter
        )
    {
        return Err("Automatic managed launch needs a selected local entry point. Existing listeners use the separate connection check.".into());
    }
    let mut command = candidate
        .command
        .clone()
        .ok_or("This entry point needs its executable or interpreter configured.")?;
    if !command.args.is_empty() {
        return Err("The fixed interpreter/module/subcommand prefix is unverified; previous launch arguments will not be replayed.".into());
    }
    let path = Path::new(&command.program);
    if !path.is_absolute() || !path.is_file() {
        return Err("Select an existing absolute entry-point file.".into());
    }
    if candidate.entrypoint_path.as_deref() != Some(command.program.as_str()) {
        return Err("The selected entry point does not match its observed command.".into());
    }
    let mut artifacts = Vec::new();
    if candidate.entrypoint_kind == EntrypointKind::Interpreter {
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let first = bytes
            .split(|byte| *byte == b'\n')
            .next()
            .ok_or("The interpreter declaration is missing.")?;
        let first =
            std::str::from_utf8(first).map_err(|_| "The interpreter declaration is not UTF-8.")?;
        let interpreter = first
            .strip_prefix("#!")
            .ok_or("The interpreter declaration is missing.")?
            .trim();
        // Only a literal absolute interpreter can be reproduced generically.
        // env selectors, optional interpreter flags and launcher expressions
        // need structured command metadata rather than language-specific guesses.
        if interpreter.is_empty()
            || interpreter.chars().any(char::is_whitespace)
            || !Path::new(interpreter).is_absolute()
            || !Path::new(interpreter).is_file()
        {
            return Err(
                "The script needs an explicit verified interpreter and argument prefix.".into(),
            );
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
        && (description.contains("name") || description.contains("alias"))
}

fn binding(
    schema: &OptionSchema,
    flags: &[&str],
    role: &str,
    required: bool,
    require_alias_description: bool,
) -> Result<Option<ArgBinding>, String> {
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
        return Err(format!(
            "The help does not establish one unambiguous {role} option."
        ));
    }
    let (option, spelling) = matching[0];
    if option.target != Target::Launch
        || !option.scope.is_empty()
        || option.arity.supported()
            != Some(&Arity {
                min: 1,
                max: Some(1),
            })
        || spelling.polarity.is_some()
        || (require_alias_description && !alias_description(option))
    {
        return Err(format!(
            "The documented {role} option needs further configuration."
        ));
    }
    Ok(Some(ArgBinding::Flag {
        flag: spelling.flag.clone(),
        equals: spelling.style == ValueStyle::Equals,
    }))
}

fn plan_from_help(
    candidate: &RuntimeCandidate,
    command: ObservedCommand,
    artifacts: Vec<String>,
    report: &HelpReport,
) -> Result<ManagedPlan, String> {
    if !report.complete() {
        return Err("Help discovery did not complete; no automatic plan was created.".into());
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
        &["--model", "--model-path", "--model-dir"],
        "model path",
        true,
        false,
    )?
    .ok_or("The model path option is missing.")?;
    let port = binding(&schema, &["--port"], "listening port", true, false)?
        .ok_or("The listening port option is missing.")?;
    let host = binding(&schema, &["--host"], "listening host", true, false)?;
    let served_model = binding(
        &schema,
        &["--served-model-name", "--model-alias", "--alias"],
        "served model alias",
        false,
        true,
    )?;
    Ok(ManagedPlan {
        program: command.program,
        args: command.args,
        working_directory: command.working_directory,
        artifacts,
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
    fn from_help(id: &str, help: &str) -> Result<ManagedPlan, String> {
        let candidate = candidate(id);
        plan_from_help(
            &candidate,
            candidate.command.clone().unwrap(),
            vec![],
            &report(help),
        )
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
        let result = plan(selected);
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
            .contains("will not be replayed"));
        let mut help = report("Options:\n  --model FILE  Model\n  --port PORT  Listening port\n");
        help.stdout.truncated = true;
        assert!(plan_from_help(
            &candidate,
            candidate.command.clone().unwrap(),
            vec![],
            &help
        )
        .is_err());
    }
}
