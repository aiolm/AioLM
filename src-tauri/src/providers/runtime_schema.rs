//! One effective option schema per selected runtime.
//!
//! Built-in option catalogs and manifest options are adapter-sourced facts.
//! Help that a user discovered and accepted for the exact runtime adds the
//! options those catalogs do not describe. The settings UI renders this one
//! schema, saved values are validated against it and launch arguments come
//! from the same resolver, for built-in and registered engines alike.
//!
//! Which help applies is pinned: acceptance records the fingerprint of the
//! exact help command (executable and declared artifact hashes, argv, full
//! environment, runtime version, scope and parser). Launch recomputes that
//! identity and refuses saved help options when anything changed, keeping the
//! values for review instead of reusing another script's or build's options.
//!
//! App-owned bindings come from the adapter, not from option names: built-in
//! managed flags, and for registered engines every flag or positional slot its
//! launch template fills from `{model}`, `{port}`, `{host}` and friends.
use super::{
    options::{self, OptionKind, OptionSpec, OptionTarget},
    registry::{self, ExternalOption},
    runtime_help::{Encoding, HelpCommand, MAX_STREAM_BYTES},
    runtime_help_store::{self, HelpSnapshot},
    runtime_options::{
        Arity, Certainty, Fact, ManagedBinding, NumericRange, OptionDefinition, OptionIssue,
        OptionSchema, RuntimeDefault, Source, Spelling, Target, ValueKind, ValueStyle,
        SCHEMA_VERSION,
    },
    runtime_ordered::{self, ORDER_KEY},
    ProviderId,
};
use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub const ACCEPTED_VERSION: u32 = 1;
const ACCEPTED_FILE: &str = "accepted.json";
const ACCEPTED_LIMIT: u64 = 65_536;
const HELP_TIMEOUT_MS: u64 = 60_000;

/// Saved provider values with dedicated controls; never generic options.
const RESERVED_KEYS: &[&str] = &[
    options::EXTRA_ARGS_KEY,
    options::TRUST_REMOTE_CODE_KEY,
    super::launch::LORA_ADAPTERS_KEY,
    super::launch::REQUEST_LORA_KEY,
    super::launch::DRAFT_MODEL_KEY,
    ORDER_KEY,
];

/// The help command a user chose, minus everything the adapter decides
/// (environment, working directory, artifacts, limits).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HelpRequest {
    /// Registered engines default to their launch program; a bridge's engine
    /// executable may be asked when it is a declared, hash-checked artifact.
    #[serde(default)]
    pub program: Option<String>,
    pub args: Vec<String>,
    #[serde(default)]
    pub scope: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcceptedHelp {
    pub version: u32,
    pub fingerprint: String,
    pub request: HelpRequest,
}

/// What the settings UI may ask: the program and prefix are adapter-owned.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HelpTarget {
    pub engine: String,
    pub runtime: String,
    pub program: String,
    /// Built-in engines always ask their own entry point.
    pub fixed: bool,
    /// Arguments every help request for the launch program starts with.
    pub prefix: Vec<String>,
    pub request: HelpRequest,
    pub accepted: Option<AcceptedHelp>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HelpState {
    /// No help was accepted; only catalog/manifest options apply.
    None,
    /// The accepted help still describes the runtime exactly.
    Current,
    /// The runtime, its artifacts or its help command changed since review.
    Stale,
    /// Accepted, but the identity was not recomputed for this view.
    Unchecked,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EffectiveSchema {
    pub schema: OptionSchema,
    /// Subcommand scope the accepted help describes.
    pub scope: Vec<String>,
    pub help_state: HelpState,
    pub help_detail: String,
    pub accepted_fingerprint: Option<String>,
    /// Keys from the built-in catalog or manifest (compatibility mapping).
    pub compat_keys: Vec<String>,
    /// Keys only accepted help describes.
    pub help_keys: Vec<String>,
    /// Help options hidden because a catalog option already covers them.
    pub shadowed: Vec<String>,
    /// Value counts and repetition the user confirmed for help options whose
    /// help left them unknown, shown apart from help and adapter facts.
    pub supplement: Option<SupplementView>,
    /// A saved confirmation file this app refuses to read (malformed, newer,
    /// oversized); nothing from it applies and help options needing it block.
    pub supplement_error: Option<String>,
}

pub const SUPPLEMENT_VERSION: u32 = 1;
const SUPPLEMENT_FILE: &str = "supplement.json";
const SUPPLEMENT_LIMIT: u64 = 262_144;

/// Syntax a user confirmed for one help option. Only facts the help left
/// unknown can be confirmed; this never describes protocol abilities, types,
/// ranges, defaults, constraints or app-owned bindings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConfirmedSyntax {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arity: Option<Arity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeatable: Option<bool>,
}

/// Confirmations pinned to the accepted help they were made for. Another
/// help fingerprint (a rebuilt runtime or a newer review) never inherits them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Supplement {
    pub version: u32,
    pub fingerprint: String,
    pub options: BTreeMap<String, ConfirmedSyntax>,
}

/// A confirmation the current help contradicts or no longer covers.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SupplementConflict {
    pub key: String,
    /// `option` (absent or app-owned now), `arity` or `repeatable`.
    pub field: String,
    pub confirmed: Value,
    /// What the current help documents; null when it has no such option.
    pub help: Value,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SupplementView {
    pub fingerprint: String,
    pub options: BTreeMap<String, ConfirmedSyntax>,
    /// The confirmations describe the accepted help and are in effect.
    pub current: bool,
    /// Keys whose unknown facts the confirmations established.
    pub applied: Vec<String>,
    pub conflicts: Vec<SupplementConflict>,
}

pub struct RuntimeKey {
    pub provider: ProviderId,
    pub engine: String,
    pub runtime: String,
}

pub fn runtime_key(cfg: &AppConfig) -> Result<RuntimeKey, String> {
    let provider = super::provider_of(cfg);
    let runtime = if provider == ProviderId::Llama {
        if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
            return Err("select an installed llama.cpp runtime first".into());
        }
        format!("{}-{}", cfg.active_backend, cfg.active_build)
    } else {
        if cfg.active_runtime.is_empty() {
            return Err("select an installed runtime first".into());
        }
        cfg.active_runtime.clone()
    };
    let engine = provider.as_str().to_owned();
    if !runtime_help_store::valid_segment(&engine) || !runtime_help_store::valid_segment(&runtime) {
        return Err("this runtime's identity cannot hold a help snapshot".into());
    }
    Ok(RuntimeKey {
        provider,
        engine,
        runtime,
    })
}

/// The selected runtime as its adapter sees it. A caller that already
/// resolved a Python runtime (launch, validation) passes it explicitly.
pub struct Selected {
    pub key: RuntimeKey,
    python: Option<super::python_env::PythonRuntimeManifest>,
}

impl Selected {
    pub fn from_config(cfg: &AppConfig) -> Result<Self, String> {
        let key = runtime_key(cfg)?;
        let python = if key.provider.is_python() {
            Some(super::selected_python_runtime(cfg)?)
        } else {
            None
        };
        Ok(Self { key, python })
    }

    pub fn python(runtime: &super::python_env::PythonRuntimeManifest) -> Result<Self, String> {
        let engine = runtime.provider.as_str().to_owned();
        if !runtime_help_store::valid_segment(&engine)
            || !runtime_help_store::valid_segment(&runtime.id)
        {
            return Err("this runtime's identity cannot hold a help snapshot".into());
        }
        Ok(Self {
            key: RuntimeKey {
                provider: runtime.provider,
                engine,
                runtime: runtime.id.clone(),
            },
            python: Some(runtime.clone()),
        })
    }

    fn python_runtime(&self) -> Result<&super::python_env::PythonRuntimeManifest, String> {
        self.python
            .as_ref()
            .ok_or_else(|| "this runtime has no Python entry point".into())
    }
}

fn unicode_environment(
    pairs: Vec<(OsString, OsString)>,
) -> Result<BTreeMap<String, String>, String> {
    pairs
        .into_iter()
        .map(|(key, value)| {
            Ok((
                key.into_string()
                    .map_err(|_| "a runtime environment name is not Unicode".to_string())?,
                value
                    .into_string()
                    .map_err(|_| "a runtime environment value is not Unicode".to_string())?,
            ))
        })
        .collect()
}

fn same_program(left: &str, right: &str) -> bool {
    if Path::new(left) == Path::new(right) {
        return true;
    }
    match (
        Path::new(left).canonicalize(),
        Path::new(right).canonicalize(),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The adapter-owned parts of a help request for the selected runtime.
pub fn help_target(root: &Path, cfg: &AppConfig) -> Result<HelpTarget, String> {
    let selected = Selected::from_config(cfg)?;
    let key = &selected.key;
    let accepted = load_accepted(root, &key.engine, &key.runtime)?;
    let (program, fixed, prefix, default) = match key.provider {
        ProviderId::Custom(_) => {
            let manifest = registry::manifest(key.provider, &key.runtime)?;
            let prefix = registry::launch_prefix(&manifest);
            let mut args = prefix.clone();
            args.push("--help".into());
            let request = HelpRequest {
                program: None,
                args,
                scope: Vec::new(),
            };
            (manifest.launch.program, false, prefix, request)
        }
        ProviderId::Llama => (
            crate::runtime::server_bin_for(&cfg.active_backend, &cfg.active_build)?
                .to_string_lossy()
                .into_owned(),
            true,
            Vec::new(),
            HelpRequest {
                program: None,
                args: vec!["--help".into()],
                scope: Vec::new(),
            },
        ),
        _ => {
            let runtime = selected.python_runtime()?;
            let (args, scope) = super::launch::help_entry(runtime)?;
            (
                runtime.python.clone(),
                true,
                Vec::new(),
                HelpRequest {
                    program: None,
                    args,
                    scope,
                },
            )
        }
    };
    let request = accepted
        .as_ref()
        .map(|accepted| accepted.request.clone())
        .unwrap_or(default);
    Ok(HelpTarget {
        engine: key.engine.clone(),
        runtime: key.runtime.clone(),
        program,
        fixed,
        prefix,
        request,
        accepted,
    })
}

/// The exact shell-free help command for the selected runtime. The adapter
/// decides the environment, working directory and artifacts so the help
/// describes the same process launch would start.
pub fn help_command(cfg: &AppConfig, request: &HelpRequest) -> Result<HelpCommand, String> {
    help_command_for(cfg, &Selected::from_config(cfg)?, request)
}

fn help_command_for(
    cfg: &AppConfig,
    selected: &Selected,
    request: &HelpRequest,
) -> Result<HelpCommand, String> {
    let key = &selected.key;
    let mut command = match key.provider {
        ProviderId::Custom(_) => {
            manifest_help_command(&registry::manifest(key.provider, &key.runtime)?, request)?
        }
        ProviderId::Llama => {
            if request.args != ["--help"] || request.program.is_some() || !request.scope.is_empty()
            {
                return Err("built-in runtimes use their own help command".into());
            }
            HelpCommand {
                program: crate::runtime::server_bin_for(&cfg.active_backend, &cfg.active_build)?,
                args: request.args.clone(),
                environment: unicode_environment(crate::runtime::child_environment_for_runtime(
                    &cfg.active_backend,
                    &cfg.active_build,
                )?)?,
                working_directory: None,
                artifacts: Vec::new(),
                runtime_version: crate::runtime::installed_version_label(
                    &cfg.active_backend,
                    &cfg.active_build,
                )?,
                scope: Vec::new(),
                encoding: Encoding::Auto,
                timeout_ms: HELP_TIMEOUT_MS,
                output_limit: MAX_STREAM_BYTES,
            }
        }
        _ => {
            let runtime = selected.python_runtime()?;
            let (args, scope) = super::launch::help_entry(runtime)?;
            if request.args != args || request.program.is_some() || request.scope != scope {
                return Err("built-in runtimes use their own help command".into());
            }
            HelpCommand {
                program: PathBuf::from(&runtime.python),
                args,
                environment: unicode_environment(super::python_env::engine_environment())?,
                working_directory: None,
                artifacts: Vec::new(),
                runtime_version: runtime
                    .probe
                    .as_ref()
                    .map(|probe| probe.version.clone())
                    .unwrap_or_else(|| "unprobed".into()),
                scope,
                encoding: Encoding::Auto,
                timeout_ms: HELP_TIMEOUT_MS,
                output_limit: MAX_STREAM_BYTES,
            }
        }
    };
    // A fixed locale keeps help text comparable across sessions; it is part
    // of the fingerprint like every other environment value.
    command.environment.insert("LC_ALL".into(), "C".into());
    Ok(command)
}

/// The help command for a registered (or about to be registered) engine's
/// manifest: its launch program or a declared artifact, the exact entry
/// prefix, literal adapter environment, working directory and artifacts.
pub fn manifest_help_command(
    manifest: &registry::RuntimeManifest,
    request: &HelpRequest,
) -> Result<HelpCommand, String> {
    let program = request
        .program
        .clone()
        .unwrap_or_else(|| manifest.launch.program.clone());
    let launch_program = same_program(&program, &manifest.launch.program);
    if !launch_program && !manifest.artifacts.iter().any(|a| same_program(a, &program)) {
        return Err(
            "help must run the registered launch program or one of its declared artifacts".into(),
        );
    }
    let prefix = registry::launch_prefix(manifest);
    if launch_program && !request.args.starts_with(&prefix) {
        return Err(format!(
            "help arguments must start with the registered entry point: {}",
            prefix.join(" ")
        ));
    }
    let mut environment = unicode_environment(super::python_env::engine_environment())?;
    // Literal adapter environment applies; templated values (model,
    // port, credentials) only exist for an actual launch.
    for (name, value) in &manifest.launch.env {
        if !value.contains('{') {
            environment.insert(name.clone(), value.clone());
        }
    }
    let mut command = HelpCommand {
        program: PathBuf::from(program),
        args: request.args.clone(),
        environment,
        working_directory: manifest.launch.working_directory.clone().map(PathBuf::from),
        artifacts: manifest.artifacts.iter().map(PathBuf::from).collect(),
        // Hashes identify the build; this names the registration so a
        // discovery before registration matches the one after it.
        runtime_version: format!(
            "registered:{}/{}",
            manifest.engine_id.as_str(),
            manifest.runtime_id
        ),
        scope: request.scope.clone(),
        encoding: Encoding::Auto,
        timeout_ms: HELP_TIMEOUT_MS,
        output_limit: MAX_STREAM_BYTES,
    };
    command.environment.insert("LC_ALL".into(), "C".into());
    Ok(command)
}

/// Check a draft's help evidence before registration: the discovery must
/// describe exactly the engine the draft registers (same command identity)
/// and document every binding flag. Returns the acceptance to record once
/// the registration is published.
pub fn draft_acceptance(
    root: &Path,
    draft: &registry::EntrypointDraft,
    manifest: &registry::RuntimeManifest,
) -> Result<Option<AcceptedHelp>, String> {
    let Some(help) = &draft.help else {
        return Ok(None);
    };
    let snapshot = runtime_help_store::load_snapshot(
        root,
        manifest.engine_id.as_str(),
        &manifest.runtime_id,
        &help.fingerprint,
    )?
    .ok_or("discover the entry point's help again; the reviewed discovery is missing")?;
    registry::check_draft_against_help(draft, &snapshot.schema)?;
    let identity =
        manifest_help_command(manifest, &help.request)?.identity(&AtomicBool::new(false))?;
    if identity.fingerprint != help.fingerprint {
        return Err(
            "the entry point changed since its help was discovered; discover its help again".into(),
        );
    }
    Ok(Some(AcceptedHelp {
        version: ACCEPTED_VERSION,
        fingerprint: help.fingerprint.clone(),
        request: help.request.clone(),
    }))
}

/// Register an entry point from an explicit draft: build its manifest, check
/// any reviewed help against it, register (hash + probe + publish) and pin
/// that help for the new registration.
pub async fn register_entrypoint(
    root: &Path,
    draft: &registry::EntrypointDraft,
    cancel: Option<std::sync::Arc<AtomicBool>>,
) -> Result<registry::RuntimeManifest, String> {
    let manifest = registry::manifest_from_draft(draft)?;
    let check = (root.to_path_buf(), draft.clone(), manifest.clone());
    let accepted =
        tokio::task::spawn_blocking(move || draft_acceptance(&check.0, &check.1, &check.2))
            .await
            .map_err(|e| e.to_string())??;
    let registered = registry::register_manifest(manifest, cancel).await?;
    if let Some(accepted) = accepted {
        write_accepted(
            root,
            registered.engine_id.as_str(),
            &registered.runtime_id,
            &accepted,
        )?;
    }
    Ok(registered)
}

fn accepted_path(root: &Path, engine: &str, runtime: &str) -> Result<PathBuf, String> {
    Ok(runtime_help_store::snapshot_root(root, engine, runtime)?.join(ACCEPTED_FILE))
}

pub fn load_accepted(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<Option<AcceptedHelp>, String> {
    let path = accepted_path(root, engine, runtime)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() || metadata.len() > ACCEPTED_LIMIT {
        return Err("accepted help record is not a bounded regular file".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let accepted: AcceptedHelp =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid accepted help: {e}"))?;
    if accepted.version != ACCEPTED_VERSION {
        return Err(format!(
            "accepted help version {} is not supported by this app",
            accepted.version
        ));
    }
    Ok(Some(accepted))
}

/// Record that the user reviewed this exact discovery for launch. The current
/// command must still produce the discovered fingerprint, and its complete
/// snapshot must exist.
pub fn accept(
    root: &Path,
    cfg: &AppConfig,
    fingerprint: &str,
    request: &HelpRequest,
) -> Result<AcceptedHelp, String> {
    let key = runtime_key(cfg)?;
    let identity = help_command(cfg, request)?.identity(&AtomicBool::new(false))?;
    if identity.fingerprint != fingerprint {
        return Err(
            "the runtime or its help command changed since this discovery; discover again".into(),
        );
    }
    runtime_help_store::load_snapshot(root, &key.engine, &key.runtime, fingerprint)?
        .ok_or("discover this runtime's help before accepting it")?;
    let accepted = AcceptedHelp {
        version: ACCEPTED_VERSION,
        fingerprint: fingerprint.into(),
        request: request.clone(),
    };
    write_accepted(root, &key.engine, &key.runtime, &accepted)?;
    Ok(accepted)
}

fn write_accepted(
    root: &Path,
    engine: &str,
    runtime: &str,
    accepted: &AcceptedHelp,
) -> Result<(), String> {
    let path = accepted_path(root, engine, runtime)?;
    std::fs::create_dir_all(path.parent().expect("accepted record has a directory"))
        .map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(accepted).map_err(|e| e.to_string())?;
    crate::config::atomic_write(&path, &bytes)
}

fn adapter_source(engine: &str, revision: &str) -> Source {
    Source::Adapter {
        id: engine.into(),
        revision: revision.into(),
    }
}

fn documented<T>(value: T, source: &Source) -> Fact<T> {
    Fact {
        value: Some(value),
        certainty: Certainty::Documented,
        source: Some(source.clone()),
    }
}

fn blank(key: &str, group: &str, target: Target) -> OptionDefinition {
    OptionDefinition {
        key: key.into(),
        scope: Vec::new(),
        spellings: Vec::new(),
        position: None,
        kind: Fact::default(),
        arity: Fact::default(),
        repeatable: Fact::default(),
        choices: Fact::default(),
        range: Fact::default(),
        unit: Fact::default(),
        runtime_default: Fact::default(),
        group: group.into(),
        help: String::new(),
        target,
        request_field: Fact::default(),
        restart_required: Fact::default(),
        sensitive: Fact::default(),
        local_path: Fact::default(),
        managed: None,
        raw_spans: Vec::new(),
    }
}

/// Shared shape of catalog and manifest kinds.
enum CompatKind {
    Integer(f64, f64),
    Number(f64, f64),
    Flag,
    Toggle,
    Choice(Vec<String>),
    Text,
    Path,
    Json,
}

fn compat_definition(
    key: &str,
    group: &str,
    flag: Option<&str>,
    request: bool,
    kind: CompatKind,
    runtime_default: Option<&str>,
    source: &Source,
) -> OptionDefinition {
    let mut option = blank(
        key,
        group,
        if request {
            Target::Request
        } else {
            Target::Launch
        },
    );
    if request {
        option.request_field = documented(key.to_owned(), source);
    } else if let Some(flag) = flag {
        option.spellings.push(Spelling {
            flag: flag.into(),
            style: ValueStyle::Separate,
            polarity: None,
        });
    }
    let one = Arity {
        min: 1,
        max: Some(1),
    };
    let (value_kind, arity) = match &kind {
        CompatKind::Integer(..) => (ValueKind::Integer, one),
        CompatKind::Number(..) => (ValueKind::Number, one),
        CompatKind::Flag | CompatKind::Toggle => (
            ValueKind::Boolean,
            Arity {
                min: 0,
                max: Some(0),
            },
        ),
        CompatKind::Json => (ValueKind::Json, one),
        CompatKind::Choice(_) | CompatKind::Text | CompatKind::Path => (ValueKind::Text, one),
    };
    option.kind = documented(value_kind, source);
    option.arity = documented(arity, source);
    match kind {
        CompatKind::Integer(min, max) | CompatKind::Number(min, max) => {
            option.range = documented(
                NumericRange {
                    min: Some(min),
                    max: Some(max),
                },
                source,
            );
        }
        // The catalog documents that a false flag emits nothing.
        CompatKind::Flag => {
            option.runtime_default = documented(
                RuntimeDefault {
                    literal: Value::Bool(false),
                },
                source,
            );
        }
        CompatKind::Toggle => {
            if let Some(flag) = flag.filter(|_| !request) {
                option.spellings = vec![
                    Spelling {
                        flag: flag.into(),
                        style: ValueStyle::Separate,
                        polarity: Some(true),
                    },
                    Spelling {
                        flag: format!("--no-{}", flag.trim_start_matches('-')),
                        style: ValueStyle::Separate,
                        polarity: Some(false),
                    },
                ];
            }
        }
        CompatKind::Choice(choices) => {
            option.choices = documented(choices.into_iter().map(Value::String).collect(), source);
        }
        CompatKind::Path => option.local_path = documented(true, source),
        CompatKind::Text | CompatKind::Json => {}
    }
    if let Some(text) = runtime_default.filter(|_| option.runtime_default.value.is_none()) {
        option.runtime_default = documented(
            RuntimeDefault {
                literal: Value::String(text.into()),
            },
            source,
        );
    }
    option
}

/// A built-in catalog option as a common schema option.
pub fn from_spec(spec: &OptionSpec, source: &Source) -> OptionDefinition {
    let kind = match spec.kind {
        OptionKind::Integer { min, max } => CompatKind::Integer(min as f64, max as f64),
        OptionKind::Number { min, max } => CompatKind::Number(min, max),
        OptionKind::Flag => CompatKind::Flag,
        OptionKind::Toggle => CompatKind::Toggle,
        OptionKind::Choice { choices } => {
            CompatKind::Choice(choices.iter().map(|c| (*c).to_owned()).collect())
        }
        OptionKind::Text { .. } => CompatKind::Text,
        OptionKind::Path => CompatKind::Path,
        OptionKind::Json => CompatKind::Json,
    };
    compat_definition(
        spec.key,
        spec.group,
        spec.flag,
        spec.target == OptionTarget::Request,
        kind,
        spec.runtime_default,
        source,
    )
}

/// A manifest v1 option as a common schema option.
pub fn from_external(option: &ExternalOption, source: &Source) -> Option<OptionDefinition> {
    let number = |name: &str| option.kind[name].as_f64();
    let kind = match option.kind["type"].as_str()? {
        "integer" => CompatKind::Integer(number("min")?, number("max")?),
        "number" => CompatKind::Number(number("min")?, number("max")?),
        "flag" => CompatKind::Flag,
        "toggle" => CompatKind::Toggle,
        "choice" => CompatKind::Choice(
            option.kind["choices"]
                .as_array()?
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        "text" => CompatKind::Text,
        "path" => CompatKind::Path,
        "json" => CompatKind::Json,
        _ => return None,
    };
    Some(compat_definition(
        &option.key,
        &option.group,
        option.flag.as_deref(),
        option.target == "request",
        kind,
        option.runtime_default.as_deref(),
        source,
    ))
}

/// The argv a valid built-in catalog value produces, through the common
/// resolver. Invalid values produce nothing; callers validate first.
pub fn spec_arguments(spec: &OptionSpec, value: &Value) -> Vec<String> {
    let source = adapter_source("builtin.catalog", "1");
    from_spec(spec, &source)
        .resolve_one(&None, std::slice::from_ref(value))
        .unwrap_or_default()
}

struct Compat {
    options: Vec<OptionDefinition>,
    /// Flag spelling to the app-owned binding it carries.
    managed_flags: BTreeMap<String, ManagedBinding>,
}

fn compat(selected: &Selected) -> Result<Compat, String> {
    let key = &selected.key;
    // Built-in lists name app-owned flags without saying which binding each
    // one carries; Discovery marks them managed without guessing.
    let mut managed_flags: BTreeMap<String, ManagedBinding> =
        options::app_managed_flags(key.provider)
            .iter()
            .map(|flag| ((*flag).to_owned(), ManagedBinding::Discovery))
            .collect();
    let options = match key.provider {
        ProviderId::Custom(_) => {
            let manifest = registry::manifest(key.provider, &key.runtime)?;
            let source = adapter_source(
                &key.engine,
                &format!("manifest-v{}", manifest.adapter_version),
            );
            let (bound, _) = registry::bound_launch_flags(&manifest);
            for (flag, binding) in bound {
                managed_flags.insert(flag, binding_for(&binding));
            }
            manifest
                .options
                .iter()
                .filter_map(|option| from_external(option, &source))
                .collect()
        }
        ProviderId::Llama => Vec::new(),
        _ => {
            let runtime = selected.python_runtime()?;
            let source = adapter_source(&key.engine, "catalog-v1");
            super::launch::option_schema(runtime)
                .iter()
                .map(|spec| from_spec(spec, &source))
                .collect()
        }
    };
    Ok(Compat {
        options,
        managed_flags,
    })
}

fn compat_fingerprint(engine: &str, runtime: &str, options: &[OptionDefinition]) -> String {
    let identity = serde_json::json!({"engine": engine, "runtime": runtime, "options": options});
    format!("{:x}", Sha256::digest(identity.to_string().as_bytes()))
}

fn current_identity(
    cfg: &AppConfig,
    selected: &Selected,
    accepted: &AcceptedHelp,
) -> Result<(), String> {
    let identity =
        help_command_for(cfg, selected, &accepted.request)?.identity(&AtomicBool::new(false))?;
    if identity.fingerprint == accepted.fingerprint {
        Ok(())
    } else {
        Err("the runtime, its declared artifacts or its help command changed since its options were reviewed; discover its help again and review the changes".into())
    }
}

/// The one schema the settings UI renders and launch resolves for `cfg`.
/// `verify` recomputes the accepted help identity (hashing the executable and
/// artifacts); views that only display may skip it.
pub fn effective(root: &Path, cfg: &AppConfig, verify: bool) -> Result<EffectiveSchema, String> {
    effective_for(root, cfg, &Selected::from_config(cfg)?, verify)
}

pub fn effective_for(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    verify: bool,
) -> Result<EffectiveSchema, String> {
    build_effective(root, cfg, selected, verify, true)
}

fn build_effective(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    verify: bool,
    with_supplement: bool,
) -> Result<EffectiveSchema, String> {
    let key = &selected.key;
    let compat = compat(selected)?;
    let accepted = load_accepted(root, &key.engine, &key.runtime)?;
    let snapshot: Option<HelpSnapshot> = match &accepted {
        Some(accepted) => runtime_help_store::load_snapshot(
            root,
            &key.engine,
            &key.runtime,
            &accepted.fingerprint,
        )?,
        None => None,
    };
    let (help_state, help_detail) = match (&accepted, &snapshot) {
        (None, _) => (HelpState::None, String::new()),
        (Some(_), None) => (
            HelpState::Stale,
            "the accepted help snapshot is missing; discover this runtime's help again".into(),
        ),
        (Some(accepted), Some(_)) if verify => match current_identity(cfg, selected, accepted) {
            Ok(()) => (HelpState::Current, String::new()),
            Err(error) => (HelpState::Stale, error),
        },
        (Some(_), Some(_)) => (HelpState::Unchecked, String::new()),
    };
    let compat_keys: Vec<String> = compat.options.iter().map(|o| o.key.clone()).collect();
    let mut compat_flags: BTreeSet<String> = BTreeSet::new();
    for option in &compat.options {
        for spelling in &option.spellings {
            compat_flags.insert(spelling.flag.clone());
        }
    }
    let mut options = compat.options;
    let mut help_keys = Vec::new();
    let mut shadowed = Vec::new();
    let mut schema_extras = None;
    let mut scope = Vec::new();
    if let Some(snapshot) = &snapshot {
        scope = snapshot.report.scope.clone();
        // Catalog/manifest options apply to the same launch subcommand the
        // help describes, so one resolution orders and validates them all.
        for option in &mut options {
            option.scope = scope.clone();
        }
        for help in &snapshot.schema.options {
            let covered = help
                .spellings
                .iter()
                .any(|spelling| compat_flags.contains(&spelling.flag));
            if covered || compat_keys.contains(&help.key) {
                shadowed.push(help.key.clone());
                continue;
            }
            let mut help = help.clone();
            if help.managed.is_none() {
                if help.position.is_some() {
                    // Positional slots follow the adapter's launch template;
                    // their order relative to it cannot be proven from help.
                    help.managed = Some(ManagedBinding::Discovery);
                } else if let Some(binding) = help
                    .spellings
                    .iter()
                    .find_map(|spelling| compat.managed_flags.get(&spelling.flag))
                    .copied()
                {
                    help.managed = Some(binding);
                }
            }
            help_keys.push(help.key.clone());
            options.push(help);
        }
        let kept: BTreeSet<&str> = options.iter().map(|o| o.key.as_str()).collect();
        let constraints = snapshot
            .schema
            .constraints
            .iter()
            .filter(|constraint| match constraint.supported() {
                Some(
                    super::runtime_options::Relation::Requires { when, other }
                    | super::runtime_options::Relation::Excludes { when, other },
                ) => kept.contains(when.key.as_str()) && kept.contains(other.key.as_str()),
                None => false,
            })
            .cloned()
            .collect::<Vec<_>>();
        schema_extras = Some((
            constraints,
            snapshot.schema.raw_help.clone(),
            snapshot.schema.end_of_options.clone(),
        ));
    }
    let fingerprint = accepted
        .as_ref()
        .filter(|_| snapshot.is_some())
        .map(|accepted| accepted.fingerprint.clone())
        .unwrap_or_else(|| compat_fingerprint(&key.engine, &key.runtime, &options));
    let (constraints, raw_help, end_of_options) = schema_extras.unwrap_or_default();
    let mut schema = OptionSchema {
        schema_version: SCHEMA_VERSION,
        binding: super::runtime_options::SchemaBinding {
            engine: key.engine.clone(),
            runtime: key.runtime.clone(),
            fingerprint,
        },
        options,
        constraints,
        raw_help,
        end_of_options,
    };
    let saved = if with_supplement {
        load_supplement(root, &key.engine, &key.runtime)
    } else {
        Ok(None)
    };
    let (supplement, supplement_error) = match saved {
        Ok(None) => (None, None),
        Ok(Some(saved)) => {
            let current = snapshot.is_some()
                && accepted
                    .as_ref()
                    .is_some_and(|accepted| accepted.fingerprint == saved.fingerprint);
            (
                Some(apply_supplement(&mut schema, &help_keys, saved, current)),
                None,
            )
        }
        Err(error) => (None, Some(error)),
    };
    schema.validate()?;
    Ok(EffectiveSchema {
        schema,
        scope,
        help_state,
        help_detail,
        accepted_fingerprint: accepted.map(|accepted| accepted.fingerprint),
        compat_keys,
        help_keys,
        shadowed,
        supplement,
        supplement_error,
    })
}

fn supplement_path(root: &Path, engine: &str, runtime: &str) -> Result<PathBuf, String> {
    Ok(runtime_help_store::snapshot_root(root, engine, runtime)?.join(SUPPLEMENT_FILE))
}

fn valid_confirmation(syntax: &ConfirmedSyntax) -> bool {
    (syntax.arity.is_some() || syntax.repeatable.is_some())
        && syntax
            .arity
            .is_none_or(|a| a.min <= 256 && a.max.is_none_or(|max| max >= a.min && max <= 256))
}

/// The saved confirmations, refused (never repaired) when malformed, newer
/// than this app, oversized or not a regular file.
pub fn load_supplement(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<Option<Supplement>, String> {
    let path = supplement_path(root, engine, runtime)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() || metadata.len() > SUPPLEMENT_LIMIT {
        return Err("confirmed option syntax is not a bounded regular file".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("confirmed option syntax is malformed: {e}"))?;
    match raw.get("version").and_then(Value::as_u64) {
        Some(version) if version == u64::from(SUPPLEMENT_VERSION) => {}
        Some(version) => {
            return Err(format!(
                "confirmed option syntax version {version} is not supported by this app"
            ))
        }
        None => return Err("confirmed option syntax has no valid version".into()),
    }
    let saved: Supplement = serde_json::from_value(raw)
        .map_err(|e| format!("confirmed option syntax is malformed: {e}"))?;
    if saved.fingerprint.len() != 64
        || !saved.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        || saved.options.len() > 4096
        || saved
            .options
            .iter()
            .any(|(key, syntax)| key.is_empty() || key.len() > 128 || !valid_confirmation(syntax))
    {
        return Err("confirmed option syntax is invalid".into());
    }
    Ok(Some(saved))
}

/// Establish confirmed facts on help options whose help left them unknown.
/// Help observations, adapter facts and app-owned bindings always win; a
/// confirmation they contradict is reported, not applied.
fn apply_supplement(
    schema: &mut OptionSchema,
    help_keys: &[String],
    saved: Supplement,
    current: bool,
) -> SupplementView {
    let mut applied = Vec::new();
    let mut conflicts = Vec::new();
    let source = Source::User {
        note: format!(
            "confirmed in AioLM for reviewed help {}",
            &saved.fingerprint[..12]
        ),
    };
    for (key, syntax) in &saved.options {
        let option = schema
            .options
            .iter_mut()
            .find(|option| option.key == *key && help_keys.contains(key));
        let Some(option) = option.filter(|o| o.managed.is_none() && o.target == Target::Launch)
        else {
            conflicts.push(SupplementConflict {
                key: key.clone(),
                field: "option".into(),
                confirmed: serde_json::to_value(syntax).unwrap_or(Value::Null),
                help: Value::Null,
            });
            continue;
        };
        let mut established = false;
        if let Some(arity) = syntax.arity {
            match option.arity.supported() {
                None if current => {
                    option.arity = Fact {
                        value: Some(arity),
                        certainty: Certainty::UserConfirmed,
                        source: Some(source.clone()),
                    };
                    established = true;
                }
                Some(documented) if *documented != arity => conflicts.push(SupplementConflict {
                    key: key.clone(),
                    field: "arity".into(),
                    confirmed: serde_json::to_value(arity).unwrap_or(Value::Null),
                    help: serde_json::to_value(documented).unwrap_or(Value::Null),
                }),
                _ => {}
            }
        }
        if let Some(repeatable) = syntax.repeatable {
            match option.repeatable.supported() {
                None if current => {
                    option.repeatable = Fact {
                        value: Some(repeatable),
                        certainty: Certainty::UserConfirmed,
                        source: Some(source.clone()),
                    };
                    established = true;
                }
                Some(documented) if *documented != repeatable => {
                    conflicts.push(SupplementConflict {
                        key: key.clone(),
                        field: "repeatable".into(),
                        confirmed: Value::Bool(repeatable),
                        help: Value::Bool(*documented),
                    })
                }
                _ => {}
            }
        }
        if established {
            applied.push(key.clone());
        }
    }
    SupplementView {
        fingerprint: saved.fingerprint,
        options: saved.options,
        current,
        applied,
        conflicts,
    }
}

/// Save the user's confirmations for the accepted help of the selected
/// runtime, replacing earlier ones. Each must name a help option whose help
/// leaves that fact unknown; the runtime must still match its reviewed help.
/// An empty set removes the file.
pub fn save_supplement(
    root: &Path,
    cfg: &AppConfig,
    fingerprint: &str,
    options: BTreeMap<String, ConfirmedSyntax>,
) -> Result<EffectiveSchema, String> {
    let selected = Selected::from_config(cfg)?;
    let key = &selected.key;
    let path = supplement_path(root, &key.engine, &key.runtime)?;
    if options.is_empty() {
        return clear_supplement(root, cfg);
    }
    if options.len() > 4096 {
        return Err("too many confirmed options".into());
    }
    let mut base = effective_for(root, cfg, &selected, true)?;
    if base.help_state != HelpState::Current
        || base.accepted_fingerprint.as_deref() != Some(fingerprint)
    {
        return Err("confirm option syntax for the runtime's current reviewed help; discover and accept its help again".into());
    }
    // Confirmations are judged against the help itself, not earlier ones.
    if base.supplement.is_some() {
        base = build_effective(root, cfg, &selected, false, false)?;
    }
    for (name, syntax) in &options {
        let option = base
            .schema
            .options
            .iter()
            .find(|option| option.key == *name && base.help_keys.contains(name))
            .ok_or_else(|| format!("{name} is not an option of this runtime's reviewed help"))?;
        if option.managed.is_some() || option.target != Target::Launch {
            return Err(format!(
                "{name} is managed by the app and cannot be confirmed"
            ));
        }
        if !valid_confirmation(syntax) {
            return Err(format!("{name}: confirm a valid value count or repetition"));
        }
        if (syntax.arity.is_some() && option.arity.supported().is_some())
            || (syntax.repeatable.is_some() && option.repeatable.supported().is_some())
        {
            return Err(format!(
                "{name}: the reviewed help already documents this; confirmations cannot replace it"
            ));
        }
    }
    let saved = Supplement {
        version: SUPPLEMENT_VERSION,
        fingerprint: fingerprint.into(),
        options,
    };
    let bytes = serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SUPPLEMENT_LIMIT {
        return Err("confirmed option syntax exceeds 256 KiB".into());
    }
    std::fs::create_dir_all(path.parent().expect("supplement has a directory"))
        .map_err(|e| e.to_string())?;
    crate::config::atomic_write(&path, &bytes)?;
    effective_for(root, cfg, &selected, true)
}

/// Remove every confirmation for the selected runtime, including a file this
/// app refuses to read. Saved option values are untouched.
pub fn clear_supplement(root: &Path, cfg: &AppConfig) -> Result<EffectiveSchema, String> {
    let selected = Selected::from_config(cfg)?;
    let path = supplement_path(root, &selected.key.engine, &selected.key.runtime)?;
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            return Err("confirmed option syntax path is a directory".into())
        }
        Ok(_) => std::fs::remove_file(&path).map_err(|e| e.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    effective_for(root, cfg, &selected, true)
}

/// The binding a launch template placeholder carries.
fn binding_for(placeholder: &str) -> ManagedBinding {
    match placeholder {
        "model" | "model_alias" => ManagedBinding::Model,
        "host" => ManagedBinding::Host,
        "port" => ManagedBinding::Port,
        "api_key" => ManagedBinding::Authentication,
        _ => ManagedBinding::Discovery,
    }
}

/// Saved values a generic option may hold (dedicated bindings excluded).
fn generic_values(values: &Map<String, Value>) -> Map<String, Value> {
    values
        .iter()
        .filter(|(key, _)| !RESERVED_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// Saved values only accepted help can describe.
fn help_values(values: &Map<String, Value>, compat_keys: &[String]) -> Map<String, Value> {
    generic_values(values)
        .into_iter()
        .filter(|(key, _)| !compat_keys.iter().any(|k| k == key))
        .collect()
}

/// Problems with saved values, resolved together against the effective
/// schema so constraints spanning catalog and help options apply. Keys the
/// caller's catalog check already reported (`reported`) are not repeated;
/// keys no schema describes stay saved and are reported.
pub fn saved_issues(
    root: &Path,
    cfg: &AppConfig,
    values: &Map<String, Value>,
    reported: &BTreeSet<String>,
) -> Vec<options::OptionIssue> {
    saved_issues_for(root, cfg, Selected::from_config(cfg), values, reported)
}

pub fn saved_issues_for(
    root: &Path,
    cfg: &AppConfig,
    selected: Result<Selected, String>,
    values: &Map<String, Value>,
    reported: &BTreeSet<String>,
) -> Vec<options::OptionIssue> {
    let all = generic_values(values);
    let issue = |key: &str, code: &'static str, message: String| options::OptionIssue {
        key: key.into(),
        code,
        message,
    };
    if all.is_empty() {
        // A record ordering nothing still names values that do not exist.
        return match runtime_ordered::saved_order(values) {
            Err(message) => vec![issue(ORDER_KEY, "order", message)],
            Ok(_) => Vec::new(),
        };
    }
    let effective = match selected.and_then(|selected| effective_for(root, cfg, &selected, false)) {
        Ok(effective) => effective,
        Err(error) => {
            return all
                .keys()
                .filter(|key| !reported.contains(*key))
                .map(|key| {
                    issue(
                        key,
                        "unknown",
                        format!("{key}: runtime options unavailable: {error}"),
                    )
                })
                .collect()
        }
    };
    let mut issues = Vec::new();
    let mut describable = Map::new();
    for (key, value) in all {
        if reported.contains(&key) {
            continue;
        }
        if effective
            .schema
            .options
            .iter()
            .any(|option| option.key == key)
        {
            describable.insert(key, value);
        } else if effective.accepted_fingerprint.is_none() {
            issues.push(issue(
                &key,
                "unknown",
                format!("{key} is not an option this runtime describes; discover and accept its help, or remove the retained value"),
            ));
        } else {
            issues.push(issue(
                &key,
                "unknown",
                format!("{key} is absent from this runtime's reviewed help; its saved value was retained"),
            ));
        }
    }
    if let Some(error) = &effective.supplement_error {
        if describable
            .keys()
            .any(|key| effective.help_keys.contains(key))
        {
            issues.push(issue(
                "@confirmed_syntax",
                "help",
                format!("{error}; discard the confirmations and confirm again"),
            ));
        }
    }
    // The order record is checked against every saved value; it may only
    // order values this runtime describes and that passed earlier checks.
    let order = match runtime_ordered::saved_order(values) {
        Ok(order) => order,
        Err(message) => {
            issues.push(issue(ORDER_KEY, "order", message));
            None
        }
    };
    if let Some(order) = &order {
        let outside = order
            .keys()
            .into_iter()
            .filter(|key| !describable.contains_key(*key))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if outside.is_empty() {
            describable.insert(
                ORDER_KEY.into(),
                values.get(ORDER_KEY).cloned().expect("order present"),
            );
        } else {
            if outside.iter().any(|key| !reported.contains(key)) {
                issues.push(issue(
                    ORDER_KEY,
                    "order",
                    format!(
                        "the saved option order includes {} that this runtime does not describe; the order was retained",
                        outside.join(", ")
                    ),
                ));
            }
            // Values the order covers cannot be checked out of order.
            for key in order.keys() {
                describable.remove(key);
            }
        }
    }
    if let Err(found) =
        runtime_ordered::resolve_saved(&effective.schema, &effective.scope, &describable)
    {
        issues.extend(found.into_iter().map(|found: OptionIssue| {
            let code = if effective.compat_keys.contains(&found.key) {
                "type"
            } else {
                "help"
            };
            issue(&found.key, code, found.message)
        }));
    }
    issues
}

/// Resolve saved values for launch with the effective schema. Any value only
/// accepted help describes requires that help to still describe the runtime
/// exactly; a changed runtime blocks launch with the values retained.
fn resolve_launch(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    mut values: Map<String, Value>,
    order: Option<&Value>,
) -> Result<Vec<String>, String> {
    if values.is_empty() && order.is_none() {
        return Ok(Vec::new());
    }
    let mut effective = effective_for(root, cfg, selected, false)?;
    let help_keys = values
        .keys()
        .filter(|key| !effective.compat_keys.contains(key))
        .cloned()
        .collect::<Vec<_>>();
    if !help_keys.is_empty() {
        let keys = help_keys.join(", ");
        effective = effective_for(root, cfg, selected, true)?;
        match effective.help_state {
            HelpState::Current => {}
            HelpState::None => {
                return Err(format!(
                    "saved options {keys} need this runtime's reviewed help; discover and accept it first (values are retained)"
                ))
            }
            _ => {
                return Err(format!(
                    "{} Saved options {keys} were retained.",
                    effective.help_detail
                ))
            }
        }
        if let Some(error) = &effective.supplement_error {
            return Err(format!(
                "{error}; saved options {keys} were retained until the confirmations are discarded or saved again"
            ));
        }
    }
    if let Some(order) = order {
        values.insert(ORDER_KEY.into(), order.clone());
    }
    let resolved = runtime_ordered::resolve_saved(&effective.schema, &effective.scope, &values)
        .map_err(|issues| {
            issues
                .iter()
                .map(|issue| format!("{}: {}", issue.key, issue.message))
                .collect::<Vec<_>>()
                .join("; ")
        })?;
    if !resolved.request.is_empty() {
        return Err("request fields are sent with requests, not launch arguments".into());
    }
    strip_scope(resolved.argv, &effective.scope)
}

/// Launch arguments for every saved generic option of a registered engine:
/// manifest options and accepted help options through one resolver.
/// Request-target manifest options are left for requests.
pub fn launch_arguments(
    root: &Path,
    cfg: &AppConfig,
    values: &Map<String, Value>,
) -> Result<Vec<String>, String> {
    let selected = Selected::from_config(cfg)?;
    let effective = effective_for(root, cfg, &selected, false)?;
    let launch = generic_values(values)
        .into_iter()
        .filter(|(key, _)| {
            effective
                .schema
                .options
                .iter()
                .find(|option| option.key == *key)
                .is_none_or(|option| option.target == Target::Launch)
        })
        .collect();
    resolve_launch(root, cfg, &selected, launch, values.get(ORDER_KEY))
}

/// Launch arguments for saved values only accepted help describes, appended
/// after a built-in catalog's own arguments (which the catalog mapping
/// produces through the same resolver). Catalog values a saved order record
/// positions are resolved here in that order; the catalog skips them
/// (`runtime_ordered::recorded_keys`).
pub fn help_launch_args(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    values: &Map<String, Value>,
    compat_keys: &[String],
) -> Result<Vec<String>, String> {
    let mut launch = help_values(values, compat_keys);
    let generic = generic_values(values);
    for key in runtime_ordered::recorded_keys(values) {
        if let Some(value) = generic.get(&key) {
            launch.insert(key, value.clone());
        }
    }
    resolve_launch(root, cfg, selected, launch, values.get(ORDER_KEY))
}

/// The launch template already names the subcommand; drop the scope words
/// the resolver places before scoped options.
fn strip_scope(argv: Vec<String>, scope: &[String]) -> Result<Vec<String>, String> {
    if scope.is_empty() {
        return Ok(argv);
    }
    if argv.len() >= scope.len() && argv[..scope.len()] == *scope {
        return Ok(argv[scope.len()..].to_vec());
    }
    Err("saved options belong outside the launch subcommand and cannot be placed".into())
}

/// Identity of everything help-derived that changes the launched process.
pub fn launch_identity(root: &Path, cfg: &AppConfig, compat_keys: &[String]) -> Value {
    let saved = super::launch::provider_options(cfg, super::provider_of(cfg));
    let values = help_values(&saved, compat_keys);
    let accepted = runtime_key(cfg)
        .ok()
        .and_then(|key| {
            load_accepted(root, &key.engine, &key.runtime)
                .ok()
                .flatten()
        })
        .map(|accepted| accepted.fingerprint);
    let mut identity = serde_json::json!({"help": accepted, "values": values});
    // Profiles without the newer records keep their exact earlier identity.
    if let Some(order) = saved.get(ORDER_KEY) {
        identity["order"] = order.clone();
    }
    if let Ok(key) = runtime_key(cfg) {
        if let Ok(Some(supplement)) = load_supplement(root, &key.engine, &key.runtime) {
            identity["confirmed"] = serde_json::to_value(supplement).unwrap_or(Value::Null);
        }
    }
    identity
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// What the catalog emitted before it was mapped onto the common schema.
    fn legacy_arguments(spec: &OptionSpec, value: &Value) -> Vec<String> {
        let flag = spec.flag.unwrap().to_owned();
        match spec.kind {
            OptionKind::Flag => {
                if value.as_bool() == Some(true) {
                    vec![flag]
                } else {
                    vec![]
                }
            }
            OptionKind::Toggle => {
                if value.as_bool() == Some(true) {
                    vec![flag]
                } else {
                    vec![format!("--no-{}", &flag[2..])]
                }
            }
            OptionKind::Json => vec![flag, value.to_string()],
            _ => vec![
                flag,
                match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                },
            ],
        }
    }

    fn samples(spec: &OptionSpec) -> Vec<Value> {
        match spec.kind {
            OptionKind::Integer { min, max } => vec![json!(min), json!(max)],
            OptionKind::Number { min, max } => {
                vec![json!(min), json!(max), json!((min + max) / 2.0)]
            }
            OptionKind::Flag | OptionKind::Toggle => vec![json!(true), json!(false)],
            OptionKind::Choice { choices } => choices.iter().map(|c| json!(c)).collect(),
            OptionKind::Text { .. } => vec![json!("synthetic text"), json!("한글 값")],
            OptionKind::Path => vec![json!("/synthetic path/file")],
            OptionKind::Json => vec![json!({"synthetic": {"nested": [1, 2.5]}})],
        }
    }

    #[test]
    fn builtin_catalogs_produce_identical_arguments_through_the_common_resolver() {
        let mut checked = 0;
        for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
            for spec in options::schema(provider)
                .iter()
                .filter(|spec| spec.target == OptionTarget::Launch)
            {
                for value in samples(spec) {
                    assert_eq!(
                        spec_arguments(spec, &value),
                        legacy_arguments(spec, &value),
                        "{} {value}",
                        spec.key
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked > 50, "{checked}");
    }

    #[test]
    fn catalog_and_manifest_options_keep_their_facts_as_adapter_metadata() {
        let source = adapter_source("custom.example", "manifest-v1");
        let toggle = from_external(
            &serde_json::from_value(
                json!({"key":"cache","flag":"--cache","target":"launch","kind":{"type":"toggle"}}),
            )
            .unwrap(),
            &source,
        )
        .unwrap();
        assert_eq!(toggle.spellings.len(), 2);
        assert_eq!(toggle.spellings[1].flag, "--no-cache");
        assert_eq!(toggle.spellings[1].polarity, Some(false));
        let request = from_external(
            &serde_json::from_value(json!({"key":"temperature","target":"request","kind":{"type":"number","min":0,"max":2}}))
                .unwrap(),
            &source,
        )
        .unwrap();
        assert_eq!(request.target, Target::Request);
        assert_eq!(
            request.request_field.supported().map(String::as_str),
            Some("temperature")
        );
        assert!(request.spellings.is_empty());
        // A manifest kind this app does not know is not converted at all.
        assert!(from_external(
            &serde_json::from_value(
                json!({"key":"x","flag":"--x","target":"launch","kind":{"type":"future"}})
            )
            .unwrap(),
            &source
        )
        .is_none());
    }

    fn help_schema() -> OptionSchema {
        let help = Source::Help {
            document: "stdout".into(),
            start_line: 1,
            end_line: 1,
        };
        let mut pair = blank("fresh_pair", "", Target::Launch);
        pair.spellings.push(Spelling {
            flag: "--fresh-pair".into(),
            style: ValueStyle::Separate,
            polarity: None,
        });
        pair.arity = Fact {
            value: Some(Arity {
                min: 2,
                max: Some(2),
            }),
            certainty: Certainty::Verified,
            source: Some(help.clone()),
        };
        let mut items = blank("fresh_items", "", Target::Launch);
        items.spellings.push(Spelling {
            flag: "--fresh-items".into(),
            style: ValueStyle::Separate,
            polarity: None,
        });
        let mut port = items.clone();
        port.key = "port".into();
        port.spellings[0].flag = "--port".into();
        port.managed = Some(ManagedBinding::Port);
        OptionSchema {
            schema_version: SCHEMA_VERSION,
            binding: super::super::runtime_options::SchemaBinding {
                engine: "custom.example".into(),
                runtime: "build-1".into(),
                fingerprint: "a".repeat(64),
            },
            options: vec![pair, items, port],
            constraints: vec![],
            raw_help: vec![super::super::runtime_options::RawHelp {
                id: "stdout".into(),
                scope: vec![],
                stream: super::super::runtime_options::HelpStream::Stdout,
                text: "--fresh-pair A B\n".into(),
                truncated: false,
            }],
            end_of_options: Fact::default(),
        }
    }

    fn confirmations(entries: Value) -> BTreeMap<String, ConfirmedSyntax> {
        serde_json::from_value(entries).unwrap()
    }

    #[test]
    fn confirmed_syntax_fills_only_unknown_help_facts_and_stays_user_sourced() {
        let keys = vec![
            "fresh_pair".to_string(),
            "fresh_items".into(),
            "port".into(),
        ];
        let saved = Supplement {
            version: SUPPLEMENT_VERSION,
            fingerprint: "a".repeat(64),
            options: confirmations(json!({
                "fresh_pair": {"arity": {"min": 1, "max": 1}, "repeatable": true},
                "fresh_items": {"arity": {"min": 0, "max": null}},
                "port": {"repeatable": true},
                "removed": {"repeatable": true}
            })),
        };
        let mut schema = help_schema();
        let view = apply_supplement(&mut schema, &keys, saved.clone(), true);
        schema.validate().unwrap();
        let find = |schema: &OptionSchema, key: &str| {
            schema
                .options
                .iter()
                .find(|o| o.key == key)
                .unwrap()
                .clone()
        };
        // Repetition was unknown and is now user-confirmed, never verified.
        let pair = find(&schema, "fresh_pair");
        assert_eq!(pair.repeatable.certainty, Certainty::UserConfirmed);
        assert!(matches!(pair.repeatable.source, Some(Source::User { .. })));
        // The observed arity wins; the contradicting confirmation is shown.
        assert_eq!(pair.arity.certainty, Certainty::Verified);
        assert_eq!(pair.arity.value.unwrap().min, 2);
        assert!(view.conflicts.iter().any(|c| c.key == "fresh_pair"
            && c.field == "arity"
            && c.help == json!({"min": 2, "max": 2})));
        // A variadic count the help left unknown now generates argv.
        let items = find(&schema, "fresh_items");
        assert_eq!(items.arity.certainty, Certainty::UserConfirmed);
        let overrides = runtime_help_store::overrides_from_map(
            &serde_json::from_value(
                json!({"fresh_items": {"spelling": null, "occurrences": [["a", "b c"]]}}),
            )
            .unwrap(),
        );
        assert_eq!(
            schema.resolve(&[], &overrides).unwrap().argv,
            ["--fresh-items", "a", "b c"]
        );
        // App-owned bindings and vanished options are never supplemented.
        assert!(find(&schema, "port").repeatable.supported().is_none());
        for key in ["port", "removed"] {
            assert!(view
                .conflicts
                .iter()
                .any(|c| c.key == key && c.field == "option"));
        }
        assert_eq!(view.applied, ["fresh_items", "fresh_pair"]);

        // Confirmations for another help fingerprint never apply, but their
        // differences from the current help are still shown for review.
        let mut stale = help_schema();
        let view = apply_supplement(&mut stale, &keys, saved, false);
        assert!(!view.current && view.applied.is_empty());
        assert!(find(&stale, "fresh_items").arity.supported().is_none());
        assert!(view.conflicts.iter().any(|c| c.field == "arity"));
        let unknown = runtime_help_store::overrides_from_map(
            &serde_json::from_value(json!({"fresh_items": "kept"})).unwrap(),
        );
        assert!(stale.resolve(&[], &unknown).unwrap_err()[0]
            .message
            .contains("arity is unknown"));
    }

    #[test]
    fn saved_confirmations_refuse_future_malformed_and_oversized_files() {
        let root = std::env::temp_dir().join(format!("aiolm-supplement-{}", uuid::Uuid::new_v4()));
        let dir = runtime_help_store::snapshot_root(&root, "custom.example", "build-1").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SUPPLEMENT_FILE);
        let load = || load_supplement(&root, "custom.example", "build-1");
        assert_eq!(load().unwrap(), None);
        let good = json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"fresh_items": {"arity": {"min": 1, "max": null}}}});
        std::fs::write(&path, good.to_string()).unwrap();
        assert_eq!(load().unwrap().unwrap().options.len(), 1);
        for (bad, needle) in [
            (
                json!({"version": 2, "fingerprint": "a".repeat(64), "options": {}}),
                "version 2",
            ),
            (
                json!({"version": 1, "fingerprint": "a".repeat(64), "options": {}, "auto": true}),
                "malformed",
            ),
            (
                json!({"version": 1, "fingerprint": "short", "options": {}}),
                "invalid",
            ),
            (
                json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"x": {}}}),
                "invalid",
            ),
            (
                json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"x": {"arity": {"min": 3, "max": 2}}}}),
                "invalid",
            ),
            (
                json!({"version": 1, "fingerprint": "a".repeat(64), "options": {"x": {"kind": "integer"}}}),
                "malformed",
            ),
        ] {
            std::fs::write(&path, bad.to_string()).unwrap();
            let error = load().unwrap_err();
            assert!(error.contains(needle), "{error}");
        }
        std::fs::write(&path, vec![b' '; SUPPLEMENT_LIMIT as usize + 1]).unwrap();
        assert!(load().unwrap_err().contains("bounded"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scope_words_are_stripped_only_from_the_front() {
        let scope = vec!["serve".to_string()];
        assert_eq!(
            strip_scope(vec!["serve".into(), "--a".into(), "1".into()], &scope).unwrap(),
            vec!["--a".to_string(), "1".into()]
        );
        assert!(strip_scope(vec!["--a".into(), "serve".into()], &scope).is_err());
        assert_eq!(strip_scope(vec!["--a".into()], &[]).unwrap(), vec!["--a"]);
    }
}
