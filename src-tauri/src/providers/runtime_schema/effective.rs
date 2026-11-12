use super::*;

/// The one schema the settings UI renders and launch resolves for `cfg`.
/// `verify` recomputes the accepted help identity (hashing the executable and
/// artifacts); views that only display may skip it.
pub fn effective(
    root: &Path,
    cfg: &AppConfig,
    verify: bool,
) -> Result<EffectiveSchema, crate::error::AppError> {
    effective_for(root, cfg, &Selected::from_config(cfg)?, verify)
}

pub fn effective_for(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    verify: bool,
) -> Result<EffectiveSchema, crate::error::AppError> {
    build_effective(root, cfg, selected, verify, true)
}

pub(super) fn build_effective(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    verify: bool,
    with_supplement: bool,
) -> Result<EffectiveSchema, crate::error::AppError> {
    let key = &selected.key;
    let supports_launch_args = match key.provider {
        ProviderId::Custom(_) => {
            let manifest = registry::manifest(key.provider, &key.runtime)?;
            let supports = crate::providers::runtime_auto::supports_launch_args(&manifest);
            if verify {
                ensure_automatic_help(root, cfg, &manifest, &AtomicBool::new(false))?;
            }
            supports
        }
        _ => true,
    };
    let mut compat = compat(selected)?;
    let accepted = if supports_launch_args {
        load_accepted(root, &key.engine, &key.runtime)?
    } else {
        None
    };
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
        (Some(accepted), Some(_)) if verify => {
            match current_identity(root, cfg, selected, accepted) {
                Ok(()) => (HelpState::Current, String::new()),
                Err(error) => (HelpState::Stale, error.message),
            }
        }
        (Some(_), Some(_)) => (HelpState::Unchecked, String::new()),
    };
    protect_binding_aliases(
        &mut compat,
        snapshot
            .as_ref()
            .map_or(&[], |snapshot| snapshot.schema.options.as_slice()),
    );
    let compat_keys: Vec<String> = compat.options.iter().map(|o| o.key.clone()).collect();
    let mut compat_flags: BTreeSet<String> = BTreeSet::new();
    for option in &compat.options {
        for spelling in &option.spellings {
            compat_flags.insert(spelling.flag.clone());
        }
    }
    let compat_metadata = compat.metadata.take();
    let entry = compat.entry.take();
    let compat_len = compat.options.len();
    let mut options = compat.options;
    let mut help_keys = Vec::new();
    let mut shadowed = Vec::new();
    let mut conflicts = Vec::new();
    let mut schema_extras = None;
    let mut scope = Vec::new();
    if let Some(snapshot) = &snapshot {
        scope = snapshot.report.scope.clone();
        // Catalog/manifest options apply to the same launch subcommand the
        // help describes, so one resolution orders and validates them all.
        for option in &mut options {
            option.scope = compat
                .explicit_scopes
                .get(&option.key)
                .cloned()
                .unwrap_or_else(|| scope.clone());
        }
        for help in &snapshot.schema.options {
            let covered = help
                .spellings
                .iter()
                .any(|spelling| compat_flags.contains(&spelling.flag));
            if covered || compat_keys.contains(&help.key) {
                for declared in options[..compat_len].iter().filter(|declared| {
                    declared.key == help.key
                        || declared
                            .spellings
                            .iter()
                            .any(|s| help.spellings.iter().any(|h| h.flag == s.flag))
                }) {
                    conflicts.extend(declared_differences(declared, help));
                }
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
                    crate::providers::runtime_options::Relation::Requires { when, other }
                    | crate::providers::runtime_options::Relation::Excludes { when, other },
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
        binding: crate::providers::runtime_options::SchemaBinding {
            engine: key.engine.clone(),
            runtime: key.runtime.clone(),
            fingerprint,
        },
        options,
        constraints,
        raw_help,
        end_of_options,
    };
    // Adapter facts fill what help and catalogs leave unknown before user
    // confirmations do; declarations for absent options are only reported
    // once reviewed help says which options exist.
    let metadata = compat_metadata.map(|(metadata, builtin)| {
        runtime_metadata::apply(
            &mut schema,
            &metadata,
            builtin,
            !builtin && snapshot.is_some(),
        )
    });
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
                Some(apply_supplement(
                    &mut schema,
                    &help_keys,
                    entry.as_ref(),
                    saved,
                    current,
                )),
                None,
            )
        }
        Err(error) => (None, Some(error.message)),
    };
    let mut entry = entry;
    if let (Some(entry), Some(view)) = (entry.as_mut(), supplement.as_ref()) {
        if view.current && !view.conflicts.iter().any(|c| c.field == "positional") {
            entry.positional_roles = view
                .options
                .iter()
                .filter(|(key, _)| view.applied.contains(key))
                .filter_map(|(key, syntax)| syntax.positional.clone().map(|r| (key.clone(), r)))
                .collect();
        }
    }
    lock_private_benchmark_options(&mut schema);
    let benchmark_names = benchmark_names(&schema);
    schema
        .validate()
        .map_err(crate::error::AppError::validation)?;
    let mut additional_arg_flags: BTreeMap<_, _> = compat
        .managed_flags
        .into_iter()
        .map(|(flag, binding)| (flag, Some(binding)))
        .collect();
    if let Some(snapshot) = &snapshot {
        for option in &snapshot.schema.options {
            if shadowed.contains(&option.key) {
                for spelling in &option.spellings {
                    if !compat_flags.contains(&spelling.flag) {
                        additional_arg_flags
                            .entry(spelling.flag.clone())
                            .or_insert(option.managed);
                    }
                }
            }
        }
    }
    Ok(EffectiveSchema {
        supports_launch_args,
        schema,
        additional_arg_flags,
        benchmark_names,
        scope,
        help_state,
        help_detail,
        accepted_fingerprint: accepted.map(|accepted| accepted.fingerprint),
        compat_keys,
        help_keys,
        shadowed,
        conflicts,
        metadata,
        supplement,
        supplement_error,
        entry,
    })
}

/// The help scope's positional slots: (key, help position).
pub(super) fn help_slots(schema: &OptionSchema, help_keys: &[String]) -> Vec<(String, u16)> {
    schema
        .options
        .iter()
        .filter(|o| o.target == Target::Launch && help_keys.contains(&o.key))
        .filter_map(|o| o.position.map(|position| (o.key.clone(), position)))
        .collect()
}

/// The ownership a confirmed role gives its slot: none for a user value.
fn role_binding(role: &PositionalRole) -> Option<ManagedBinding> {
    match role {
        PositionalRole::User => None,
        PositionalRole::Binding { name } => Some(binding_for(name)),
        PositionalRole::Static { .. } => Some(ManagedBinding::EntryPoint),
    }
}

/// Establish confirmed facts on help options whose help left them unknown.
/// Help observations, adapter facts and app-owned bindings always win; a
/// confirmation they contradict is reported, not applied.
pub(super) fn apply_supplement(
    schema: &mut OptionSchema,
    help_keys: &[String],
    entry: Option<&CommandEntry>,
    saved: Supplement,
    current: bool,
) -> SupplementView {
    let mut applied = Vec::new();
    let mut conflicts = Vec::new();
    // Positional roles are one layout: all of them apply, or none does.
    let roles: BTreeMap<String, PositionalRole> = saved
        .options
        .iter()
        .filter_map(|(key, syntax)| syntax.positional.clone().map(|role| (key.clone(), role)))
        .collect();
    let layout = if current {
        runtime_positional::validate_roles(entry, &help_slots(schema, help_keys), &roles)
    } else {
        Ok(())
    };
    if let Err(message) = &layout {
        for (key, role) in &roles {
            conflicts.push(SupplementConflict {
                key: key.clone(),
                field: "positional".into(),
                confirmed: serde_json::to_value(role).unwrap_or(Value::Null),
                help: Value::from(message.clone()),
            });
        }
    }
    let source = Source::User {
        note: format!(
            "confirmed in AioLM for reviewed help {}",
            &saved.fingerprint[..12]
        ),
    };
    for (key, syntax) in &saved.options {
        let mut placed = false;
        if let Some(role) = &syntax.positional {
            let slot = schema.options.iter_mut().find(|o| {
                o.key == *key
                    && help_keys.contains(key)
                    && o.position.is_some()
                    && o.target == Target::Launch
                    && o.managed == Some(ManagedBinding::Discovery)
            });
            let Some(slot) = slot else {
                conflicts.push(SupplementConflict {
                    key: key.clone(),
                    field: "option".into(),
                    confirmed: serde_json::to_value(syntax).unwrap_or(Value::Null),
                    help: Value::Null,
                });
                continue;
            };
            if current && layout.is_ok() {
                slot.managed = role_binding(role);
                placed = true;
            }
            if syntax.arity.is_none() && syntax.repeatable.is_none() {
                if placed {
                    applied.push(key.clone());
                }
                continue;
            }
        }
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
        let mut established = placed;
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
