use super::*;

const ACCEPTED_FILE: &str = "accepted.json";
const ACCEPTED_LIMIT: u64 = 65_536;
pub(super) const SUPPLEMENT_FILE: &str = "supplement.json";
pub(super) const SUPPLEMENT_LIMIT: u64 = 262_144;

pub(super) fn accepted_path(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<PathBuf, crate::error::AppError> {
    Ok(runtime_help_store::snapshot_root(root, engine, runtime)?.join(ACCEPTED_FILE))
}

pub fn load_accepted(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<Option<AcceptedHelp>, crate::error::AppError> {
    let path = accepted_path(root, engine, runtime)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(crate::error::AppError::from_io(&error)),
    };
    if !metadata.file_type().is_file() || metadata.len() > ACCEPTED_LIMIT {
        return Err(crate::error::AppError::validation(
            "accepted help record is not a bounded regular file",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| crate::error::AppError::from_io(&e))?;
    let accepted: AcceptedHelp = serde_json::from_slice(&bytes)
        .map_err(|e| crate::error::AppError::validation(format!("invalid accepted help: {e}")))?;
    if accepted.version != ACCEPTED_VERSION {
        return Err(crate::error::AppError::validation(format!(
            "accepted help version {} is not supported by this app",
            accepted.version
        )));
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
) -> Result<AcceptedHelp, crate::error::AppError> {
    let key = runtime_key(cfg)?;
    let selected = Selected::from_config(cfg)?;
    let command = option_help_command_for(root, cfg, &selected, request)?;
    let identity = command.identity(&AtomicBool::new(false))?;
    if identity.fingerprint != fingerprint {
        return Err(crate::error::AppError::validation(
            "the runtime or its help command changed since this discovery; discover again",
        ));
    }
    runtime_help_store::load_snapshot(root, &key.engine, &key.runtime, fingerprint)?.ok_or_else(
        || crate::error::AppError::not_found("discover this runtime's help before accepting it"),
    )?;
    let accepted = AcceptedHelp {
        version: ACCEPTED_VERSION,
        working_directory: Some(
            crate::providers::execution_context::observed(command.working_directory)
                .map_err(crate::error::AppError::validation)?,
        ),
        fingerprint: fingerprint.into(),
        request: request.clone(),
    };
    write_accepted(root, &key.engine, &key.runtime, &accepted)?;
    Ok(accepted)
}

pub(super) fn write_accepted(
    root: &Path,
    engine: &str,
    runtime: &str,
    accepted: &AcceptedHelp,
) -> Result<(), crate::error::AppError> {
    let path = accepted_path(root, engine, runtime)?;
    std::fs::create_dir_all(path.parent().expect("accepted record has a directory"))
        .map_err(|e| crate::error::AppError::from_io(&e))?;
    let bytes = serde_json::to_vec_pretty(accepted)
        .map_err(|e| crate::error::AppError::internal(e.to_string()))?;
    crate::config::atomic_write(&path, &bytes)
}

/// Re-registration compares against reviewed help, not a newer exploratory
/// discovery that has not been accepted. New registrations may use the latest
/// snapshot solely to show changes between their own discovery attempts.
pub fn entrypoint_baseline(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<runtime_help_store::Baseline, crate::error::AppError> {
    match load_accepted(root, engine, runtime)? {
        Some(accepted) => Ok(runtime_help_store::Baseline::Accepted(
            runtime_help_store::load_snapshot(root, engine, runtime, &accepted.fingerprint)?
                .map(Box::new),
        )),
        None => Ok(runtime_help_store::Baseline::Latest),
    }
}

pub(super) fn supplement_path(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<PathBuf, crate::error::AppError> {
    Ok(runtime_help_store::snapshot_root(root, engine, runtime)?.join(SUPPLEMENT_FILE))
}

fn valid_confirmation(syntax: &ConfirmedSyntax) -> bool {
    (syntax.arity.is_some() || syntax.repeatable.is_some() || syntax.positional.is_some())
        && match &syntax.positional {
            Some(PositionalRole::Binding { name }) => !name.is_empty() && name.len() <= 64,
            Some(PositionalRole::Static { index }) => *index < 128,
            _ => true,
        }
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
) -> Result<Option<Supplement>, crate::error::AppError> {
    let path = supplement_path(root, engine, runtime)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(crate::error::AppError::from_io(&error)),
    };
    if !metadata.file_type().is_file() || metadata.len() > SUPPLEMENT_LIMIT {
        return Err(crate::error::AppError::validation(
            "confirmed option syntax is not a bounded regular file",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| crate::error::AppError::from_io(&e))?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|e| {
        crate::error::AppError::validation(format!("confirmed option syntax is malformed: {e}"))
    })?;
    match raw.get("version").and_then(Value::as_u64) {
        Some(version)
            if version == u64::from(SUPPLEMENT_VERSION)
                || version == u64::from(SUPPLEMENT_POSITIONAL_VERSION) => {}
        Some(version) => {
            return Err(crate::error::AppError::validation(format!(
                "confirmed option syntax version {version} is not supported by this app"
            )))
        }
        None => {
            return Err(crate::error::AppError::validation(
                "confirmed option syntax has no valid version",
            ))
        }
    }
    let saved: Supplement = serde_json::from_value(raw).map_err(|e| {
        crate::error::AppError::validation(format!("confirmed option syntax is malformed: {e}"))
    })?;
    if saved.fingerprint.len() != 64
        || !saved.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        || saved.options.len() > 4096
        || saved
            .options
            .iter()
            .any(|(key, syntax)| key.is_empty() || key.len() > 128 || !valid_confirmation(syntax))
    {
        return Err(crate::error::AppError::validation(
            "confirmed option syntax is invalid",
        ));
    }
    if saved.version == SUPPLEMENT_VERSION
        && saved
            .options
            .values()
            .any(|syntax| syntax.positional.is_some())
    {
        return Err(crate::error::AppError::validation(
            "confirmed option syntax version 1 cannot hold positional roles",
        ));
    }
    Ok(Some(saved))
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
) -> Result<EffectiveSchema, crate::error::AppError> {
    let selected = Selected::from_config(cfg)?;
    let key = &selected.key;
    let path = supplement_path(root, &key.engine, &key.runtime)?;
    if options.is_empty() {
        return clear_supplement(root, cfg);
    }
    if options.len() > 4096 {
        return Err(crate::error::AppError::validation(
            "too many confirmed options",
        ));
    }
    let mut base = effective_for(root, cfg, &selected, true)?;
    if base.help_state != HelpState::Current
        || base.accepted_fingerprint.as_deref() != Some(fingerprint)
    {
        return Err(crate::error::AppError::validation("confirm option syntax for the runtime's current reviewed help; discover and accept its help again"));
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
            .ok_or_else(|| {
                crate::error::AppError::validation(format!(
                    "{name} is not an option of this runtime's reviewed help"
                ))
            })?;
        let unmapped_slot = option.position.is_some()
            && option.target == Target::Launch
            && option.managed == Some(ManagedBinding::Discovery);
        match &syntax.positional {
            Some(_) if !unmapped_slot => {
                return Err(crate::error::AppError::validation(format!(
                    "{name} is not a positional whose role the reviewed help leaves open"
                )))
            }
            Some(role)
                if *role != PositionalRole::User
                    && (syntax.arity.is_some() || syntax.repeatable.is_some()) =>
            {
                return Err(crate::error::AppError::validation(format!(
                    "{name}: confirm a value count only for a positional you supply"
                )))
            }
            Some(_) => {}
            None if option.managed.is_some() || option.target != Target::Launch => {
                return Err(crate::error::AppError::validation(format!(
                    "{name} is managed by the app and cannot be confirmed"
                )));
            }
            None => {}
        }
        if !valid_confirmation(syntax) {
            return Err(crate::error::AppError::validation(format!(
                "{name}: confirm a valid value count or repetition"
            )));
        }
        if (syntax.arity.is_some() && option.arity.supported().is_some())
            || (syntax.repeatable.is_some() && option.repeatable.supported().is_some())
        {
            return Err(crate::error::AppError::validation(format!(
                "{name}: the reviewed help already documents this; confirmations cannot replace it"
            )));
        }
    }
    let roles: BTreeMap<String, PositionalRole> = options
        .iter()
        .filter_map(|(key, syntax)| syntax.positional.clone().map(|role| (key.clone(), role)))
        .collect();
    runtime_positional::validate_roles(
        base.entry.as_ref(),
        &help_slots(&base.schema, &base.help_keys),
        &roles,
    )
    .map_err(crate::error::AppError::validation)?;
    let saved = Supplement {
        version: if roles.is_empty() {
            SUPPLEMENT_VERSION
        } else {
            SUPPLEMENT_POSITIONAL_VERSION
        },
        fingerprint: fingerprint.into(),
        options,
    };
    let bytes = serde_json::to_vec_pretty(&saved)
        .map_err(|e| crate::error::AppError::internal(e.to_string()))?;
    if bytes.len() as u64 > SUPPLEMENT_LIMIT {
        return Err(crate::error::AppError::validation(
            "confirmed option syntax exceeds 256 KiB",
        ));
    }
    std::fs::create_dir_all(path.parent().expect("supplement has a directory"))
        .map_err(|e| crate::error::AppError::from_io(&e))?;
    crate::config::atomic_write(&path, &bytes)?;
    effective_for(root, cfg, &selected, true)
}

/// Remove every confirmation for the selected runtime, including a file this
/// app refuses to read. Saved option values are untouched.
pub fn clear_supplement(
    root: &Path,
    cfg: &AppConfig,
) -> Result<EffectiveSchema, crate::error::AppError> {
    let selected = Selected::from_config(cfg)?;
    let path = supplement_path(root, &selected.key.engine, &selected.key.runtime)?;
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            return Err(crate::error::AppError::validation(
                "confirmed option syntax path is a directory",
            ))
        }
        Ok(_) => std::fs::remove_file(&path).map_err(|e| crate::error::AppError::from_io(&e))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(crate::error::AppError::from_io(&error)),
    }
    effective_for(root, cfg, &selected, true)
}
