use super::*;

/// Preserve the exact adapter environment without lossy name conversion.
pub(crate) fn unicode_environment(
    pairs: Vec<(OsString, OsString)>,
) -> Result<BTreeMap<String, String>, crate::error::AppError> {
    pairs
        .into_iter()
        .map(|(key, value)| {
            Ok((
                key.into_string().map_err(|_| {
                    crate::error::AppError::validation("a runtime environment name is not Unicode")
                })?,
                value.into_string().map_err(|_| {
                    crate::error::AppError::validation("a runtime environment value is not Unicode")
                })?,
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
pub fn help_target(root: &Path, cfg: &AppConfig) -> Result<HelpTarget, crate::error::AppError> {
    let selected = Selected::from_config(cfg)?;
    help_target_for(root, cfg, &selected)
}

fn help_target_for(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
) -> Result<HelpTarget, crate::error::AppError> {
    let accepted = load_accepted(root, &selected.key.engine, &selected.key.runtime)?;
    crate::providers::adapter::help::help_target(cfg, selected, accepted)
}

/// The exact shell-free help command for the selected runtime. The adapter
/// decides the environment, working directory and artifacts so the help
/// describes the same process launch would start.
pub fn help_command(
    cfg: &AppConfig,
    request: &HelpRequest,
) -> Result<HelpCommand, crate::error::AppError> {
    help_command_for(cfg, &Selected::from_config(cfg)?, request)
}

fn help_command_for(
    cfg: &AppConfig,
    selected: &Selected,
    request: &HelpRequest,
) -> Result<HelpCommand, crate::error::AppError> {
    let mut command = crate::providers::adapter::help::help_command(cfg, selected, request)?;
    apply_help_text_settings(&mut command, request)?;
    command.working_directory =
        crate::providers::execution_context::directory(cfg, command.working_directory)
            .map_err(crate::error::AppError::validation)?;
    Ok(command)
}

/// The help command for a registered (or about to be registered) engine's
/// manifest: its launch program or a declared artifact, the exact entry
/// prefix, literal adapter environment, working directory and artifacts.
pub fn manifest_help_command(
    manifest: &registry::RuntimeManifest,
    request: &HelpRequest,
) -> Result<HelpCommand, crate::error::AppError> {
    let underlying = crate::providers::runtime_auto::option_manifest(manifest)?;
    let manifest = underlying.as_ref().unwrap_or(manifest);
    let program = request
        .program
        .clone()
        .unwrap_or_else(|| manifest.launch.program.clone());
    let launch_program = same_program(&program, &manifest.launch.program);
    if !launch_program && !manifest.artifacts.iter().any(|a| same_program(a, &program)) {
        return Err(crate::error::AppError::validation(
            "help must run the registered launch program or one of its declared artifacts",
        ));
    }
    let prefix = registry::launch_prefix(manifest);
    if launch_program && !request.args.starts_with(&prefix) {
        // Literal entry arguments may contain credentials. The caller can
        // display its structured, masked command separately from this error.
        return Err(crate::error::AppError::validation(
            "help arguments must start with the registered entry point",
        ));
    }
    if launch_program
        && request.scope
            != crate::providers::runtime_command::scope(manifest.command_layout.as_ref(), &prefix)
                .map_err(crate::error::AppError::validation)?
    {
        return Err(crate::error::AppError::validation("the help scope does not match the entry point; explicitly map its subcommand tokens and discover again"));
    }
    let mut environment = unicode_environment(crate::providers::python_env::engine_environment())?;
    // Literal adapter environment applies; templated values (model,
    // port, credentials) only exist for an actual launch.
    for (name, value) in &manifest.launch.env {
        if !value.contains('{') {
            environment.insert(name.clone(), value.clone());
        }
    }
    if let Some((name, value)) =
        registry::bridge_environment(manifest).map_err(crate::error::AppError::validation)?
    {
        environment.insert(name, value);
    }
    let mut command = HelpCommand {
        program: PathBuf::from(program),
        args: request.args.clone(),
        environment,
        working_directory: crate::providers::execution_context::requested(
            manifest.launch.working_directory.clone().map(PathBuf::from),
            request.working_directory.as_deref(),
        )
        .map_err(crate::error::AppError::validation)?,
        artifacts: manifest.artifacts.iter().map(PathBuf::from).collect(),
        // Hashes identify the build; this names the registration so a
        // discovery before registration matches the one after it. Declared
        // option facts are part of what a review accepts, so changed
        // metadata makes an earlier acceptance stale.
        runtime_version: match &manifest.option_metadata {
            None => format!(
                "registered:{}/{}",
                manifest.engine_id.as_str(),
                manifest.runtime_id
            ),
            Some(metadata) => format!(
                "registered:{}/{};option-metadata:{}",
                manifest.engine_id.as_str(),
                manifest.runtime_id,
                metadata.digest()
            ),
        },
        scope: request.scope.clone(),
        encoding: Encoding::Auto,
        timeout_ms: HELP_TIMEOUT_MS,
        output_limit: MAX_STREAM_BYTES,
    };
    if let Some(digest) = registry::option_scope_digest(manifest) {
        command
            .runtime_version
            .push_str(&format!(";option-scopes:{digest}"));
    }
    if let Some(layout) = &manifest.command_layout {
        command.runtime_version.push_str(&format!(
            ";command-layout:{:x}",
            Sha256::digest(serde_json::to_vec(layout).map_err(|error| error.to_string())?)
        ));
    }
    apply_help_text_settings(&mut command, request)?;
    Ok(command)
}

/// Apply after adapter environment resolution so the explicitly chosen
/// locale cannot be replaced by the old deterministic default. Neither
/// setting changes inference HTTP/SSE decoding or the global environment.
fn apply_help_text_settings(
    command: &mut HelpCommand,
    request: &HelpRequest,
) -> Result<(), crate::error::AppError> {
    let locale = request.locale.as_deref().unwrap_or("C");
    if locale.is_empty()
        || locale.len() > 64
        || !locale
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-@".contains(&byte))
    {
        return Err(crate::error::AppError::validation("help locale must be 1..64 ASCII letters, digits, _, ., - or @; choose a locale the engine supports"));
    }
    command.encoding = request.encoding.unwrap_or_default();
    command.environment.insert("LC_ALL".into(), locale.into());
    Ok(())
}

fn require_launch_help(
    command: HelpCommand,
    launch_program: &str,
) -> Result<HelpCommand, crate::error::AppError> {
    if !same_program(&command.program.to_string_lossy(), launch_program) {
        return Err(crate::error::AppError::validation("artifact help is inspection only; discover the HTTP launch entry point's help to configure its options"));
    }
    Ok(command)
}

pub(super) fn option_help_command_for(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    request: &HelpRequest,
) -> Result<HelpCommand, crate::error::AppError> {
    let target = help_target_for(root, cfg, selected)?;
    require_launch_help(help_command_for(cfg, selected, request)?, &target.program)
}

/// Check a draft's help evidence before registration: the discovery must
/// describe exactly the engine the draft registers (same command identity)
/// and document every binding flag. Returns the acceptance to record once
/// the registration is published.
pub fn draft_acceptance(
    root: &Path,
    draft: &registry::EntrypointDraft,
    manifest: &registry::RuntimeManifest,
) -> Result<Option<AcceptedHelp>, crate::error::AppError> {
    let Some(help) = &draft.help else {
        return Ok(None);
    };
    if help.request.working_directory.is_some() && draft.working_directory.is_none() {
        return Err(crate::error::AppError::validation(
            "make the reviewed working directory part of the entry point before registration",
        ));
    }
    let command = require_launch_help(
        manifest_help_command(manifest, &help.request)?,
        &manifest.launch.program,
    )?;
    let snapshot = runtime_help_store::load_snapshot(
        root,
        manifest.engine_id.as_str(),
        &manifest.runtime_id,
        &help.fingerprint,
    )?
    .ok_or_else(|| {
        crate::error::AppError::not_found(
            "discover the entry point's help again; the reviewed discovery is missing",
        )
    })?;
    registry::check_draft_against_help(draft, &snapshot.schema)
        .map_err(crate::error::AppError::validation)?;
    let identity = command.identity(&AtomicBool::new(false))?;
    if identity.fingerprint != help.fingerprint {
        return Err(crate::error::AppError::validation(
            "the entry point changed since its help was discovered; discover its help again",
        ));
    }
    Ok(Some(AcceptedHelp {
        version: ACCEPTED_VERSION,
        working_directory: Some(
            crate::providers::execution_context::observed(command.working_directory)
                .map_err(crate::error::AppError::validation)?,
        ),
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
) -> Result<registry::RuntimeManifest, crate::error::AppError> {
    match register_entrypoint_outcome(root, draft, cancel).await? {
        EntrypointRegistration::Complete(manifest) => Ok(manifest),
        EntrypointRegistration::HelpPending { cause, .. } => Err(cause),
    }
}

#[derive(Debug)]
pub(crate) enum EntrypointRegistration {
    Complete(registry::RuntimeManifest),
    HelpPending {
        manifest: registry::RuntimeManifest,
        fingerprint: String,
        cause: crate::error::AppError,
    },
}

pub(crate) async fn register_entrypoint_outcome(
    root: &Path,
    draft: &registry::EntrypointDraft,
    cancel: Option<std::sync::Arc<AtomicBool>>,
) -> Result<EntrypointRegistration, crate::error::AppError> {
    let manifest =
        registry::manifest_from_draft(draft).map_err(crate::error::AppError::validation)?;
    let check = (root.to_path_buf(), draft.clone(), manifest.clone());
    let accepted =
        tokio::task::spawn_blocking(move || draft_acceptance(&check.0, &check.1, &check.2))
            .await
            .map_err(crate::error::AppError::from)??;
    let registered = registry::register_manifest(manifest, cancel).await?;
    if let Some(accepted) = accepted {
        let fingerprint = accepted.fingerprint.clone();
        let target = (
            root.to_path_buf(),
            registered.engine_id,
            registered.runtime_id.clone(),
        );
        let saved = tokio::task::spawn_blocking(move || {
            write_accepted(&target.0, target.1.as_str(), &target.2, &accepted)
        })
        .await
        .map_err(crate::error::AppError::from)?;
        if let Err(cause) = saved {
            return Ok(EntrypointRegistration::HelpPending {
                manifest: registered,
                fingerprint,
                cause,
            });
        }
    }
    Ok(EntrypointRegistration::Complete(registered))
}

/// Complete only the reviewed-help write for this exact, still-valid
/// registration. Callers serialize this with runtime lifecycle operations.
pub(crate) fn resume_entrypoint_help(
    root: &Path,
    draft: &registry::EntrypointDraft,
) -> Result<registry::RuntimeManifest, crate::error::AppError> {
    let expected =
        registry::manifest_from_draft(draft).map_err(crate::error::AppError::validation)?;
    let registered = registry::manifest_for_help_resume(&expected)?;
    let accepted = draft_acceptance(root, draft, &registered)?.ok_or_else(|| {
        crate::error::AppError::not_found("this entry point has no reviewed help to finish saving")
    })?;
    write_accepted(
        root,
        registered.engine_id.as_str(),
        &registered.runtime_id,
        &accepted,
    )?;
    Ok(registered)
}

pub(super) fn current_identity(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    accepted: &AcceptedHelp,
) -> Result<(), crate::error::AppError> {
    let identity = option_help_command_for(root, cfg, selected, &accepted.request)?
        .identity(&AtomicBool::new(false))?;
    if identity.fingerprint == accepted.fingerprint {
        Ok(())
    } else {
        Err(crate::error::AppError::validation("the runtime, its declared artifacts or its help command changed since its options were reviewed; discover its help again and review the changes"))
    }
}

/// Carry a review to a new runtime identity when the help it reviewed is
/// unchanged. Only a real engine start calls this, after its launch was
/// refused, and it acts only while the reviewed help is stale.
///
/// An engine update, a rebuilt binary or a fingerprint computed by an earlier
/// app version changes the identity without changing what was reviewed, and
/// used to block every launch until the user rediscovered identical help.
/// The start the user requested runs this registered program anyway, so it
/// runs the reviewed help request once more: identical parsed help moves the
/// review to the new identity (`Ok(true)`); different help, or confirmations
/// pinned to the old review, keep the runtime stale for an explicit review
/// (`Ok(false)`). A help run that cannot complete is returned as the error
/// that explains why; anything that fails before help runs (no runtime, an
/// unreadable record) is `Ok(false)` so the start keeps its own error.
/// Previews and validation never reach it.
pub(crate) fn reconfirm_stale_help_for_start(
    root: &Path,
    cfg: &AppConfig,
    cancel: &AtomicBool,
) -> Result<bool, crate::error::AppError> {
    let Some((selected, accepted, reviewed, command)) = (|| {
        let selected = Selected::from_config(cfg).ok()?;
        if effective_for(root, cfg, &selected, true).ok()?.help_state != HelpState::Stale {
            return None;
        }
        let key = &selected.key;
        let accepted = load_accepted(root, &key.engine, &key.runtime).ok()??;
        let reviewed = reconfirmable_review(root, &key.engine, &key.runtime, &accepted).ok()??;
        let command = option_help_command_for(root, cfg, &selected, &accepted.request).ok()?;
        Some((selected, accepted, reviewed, command))
    })() else {
        return Ok(false);
    };
    let key = &selected.key;
    let report = crate::providers::runtime_help::discover(&command, cancel)?;
    if cancel.load(std::sync::atomic::Ordering::Acquire) {
        return Err(crate::error::AppError::cancelled("server start cancelled"));
    }
    let working_directory =
        crate::providers::execution_context::observed(command.working_directory)
            .map_err(crate::error::AppError::validation)?;
    adopt_unchanged_help(
        root,
        &key.engine,
        &key.runtime,
        accepted,
        reviewed,
        report,
        working_directory,
    )
}

/// The reviewed snapshot a new identity may inherit: present, and without
/// confirmations pinned to it (they describe the reviewed build and are
/// never inherited).
pub(super) fn reconfirmable_review(
    root: &Path,
    engine: &str,
    runtime: &str,
    accepted: &AcceptedHelp,
) -> Result<Option<HelpSnapshot>, crate::error::AppError> {
    if load_supplement(root, engine, runtime)
        .ok()
        .flatten()
        .is_some_and(|saved| saved.fingerprint == accepted.fingerprint && !saved.options.is_empty())
    {
        return Ok(None);
    }
    runtime_help_store::load_snapshot(root, engine, runtime, &accepted.fingerprint)
}

/// Record `report` as the reviewed help when it parses to exactly the
/// reviewed schema; otherwise leave the review untouched.
pub(super) fn adopt_unchanged_help(
    root: &Path,
    engine: &str,
    runtime: &str,
    accepted: AcceptedHelp,
    reviewed: HelpSnapshot,
    report: crate::providers::runtime_help::HelpReport,
    working_directory: PathBuf,
) -> Result<bool, crate::error::AppError> {
    if !report.complete() {
        return Err(crate::error::AppError::unavailable(help_failure(&report)));
    }
    let schema = crate::providers::runtime_help_parse::parse_help_report(
        &report,
        crate::providers::runtime_options::SchemaBinding {
            engine: engine.into(),
            runtime: runtime.into(),
            fingerprint: report.identity.fingerprint.clone(),
        },
    )?;
    let mut previous = reviewed.schema;
    previous.binding = schema.binding.clone();
    if previous != schema {
        return Ok(false);
    }
    let fingerprint = report.identity.fingerprint.clone();
    runtime_help_store::save_snapshot(root, engine, runtime, &HelpSnapshot { report, schema })?;
    write_accepted(
        root,
        engine,
        runtime,
        &AcceptedHelp {
            version: ACCEPTED_VERSION,
            working_directory: Some(working_directory),
            fingerprint,
            request: accepted.request,
        },
    )?;
    Ok(true)
}

/// Why a help run produced no usable help, in the engine's own terms.
fn help_failure(report: &crate::providers::runtime_help::HelpReport) -> String {
    if report.timed_out {
        return "its help command did not finish in time".into();
    }
    if let Some(error) = &report.error {
        return error.clone();
    }
    match report.exit_code {
        Some(code) if !report.success => {
            let status = crate::procutil::exit_code_label(code);
            match crate::procutil::loader_failure(code) {
                Some(cause) => format!("its help command exited with status {status}: {cause}"),
                None => format!("its help command exited with status {status}"),
            }
        }
        _ => "its help output could not be read completely".into(),
    }
}

/// New automatic connections and legacy specs without accepted help use one
/// explicit, shell-free help run of their validated underlying launch entry.
/// Existing acceptance (including stale evidence) is never silently replaced.
pub(crate) fn ensure_automatic_help(
    root: &Path,
    cfg: &AppConfig,
    manifest: &registry::RuntimeManifest,
    cancel: &AtomicBool,
) -> Result<(), crate::error::AppError> {
    let Some(engine) = crate::providers::runtime_auto::option_manifest(manifest)? else {
        return Ok(());
    };
    if load_accepted(root, manifest.engine_id.as_str(), &manifest.runtime_id)?.is_some() {
        return Ok(());
    }
    let prefix = registry::launch_prefix(&engine);
    registry::check_automatic_help_files(manifest)?;
    let mut args = prefix.clone();
    args.push("--help".into());
    let request = HelpRequest {
        program: None,
        args,
        scope: crate::providers::runtime_command::scope(engine.command_layout.as_ref(), &prefix)
            .map_err(crate::error::AppError::validation)?,
        encoding: None,
        locale: None,
        working_directory: None,
    };
    let command = manifest_help_command(manifest, &request)?;
    let report = crate::providers::runtime_help::discover(&command, cancel)?;
    let schema = crate::providers::runtime_help_parse::parse_help_report(
        &report,
        crate::providers::runtime_options::SchemaBinding {
            engine: manifest.engine_id.as_str().into(),
            runtime: manifest.runtime_id.clone(),
            fingerprint: report.identity.fingerprint.clone(),
        },
    )?;
    if cancel.load(std::sync::atomic::Ordering::Acquire) {
        return Err(crate::error::AppError::cancelled(
            "help discovery cancelled",
        ));
    }
    let snapshot = HelpSnapshot { report, schema };
    runtime_help_store::save_snapshot(
        root,
        manifest.engine_id.as_str(),
        &manifest.runtime_id,
        &snapshot,
    )?;
    accept(root, cfg, &snapshot.report.identity.fingerprint, &request)?;
    Ok(())
}
