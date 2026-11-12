use super::*;

pub(crate) fn additional_launch_args(root: &Path, cfg: &AppConfig) -> Result<Vec<String>, String> {
    let selected = Selected::from_config(cfg)?;
    let values = crate::providers::launch::provider_options(cfg, selected.key.provider);
    if !matches!(selected.key.provider, ProviderId::Custom(_)) {
        return Ok(Vec::new());
    }
    let effective = effective_for(root, cfg, &selected, true)?;
    if !effective.supports_launch_args {
        return if values.contains_key("extra_args") {
            Err("attached services do not accept launch arguments".into())
        } else {
            Ok(Vec::new())
        };
    }
    crate::providers::runtime_raw_args::validated(
        &effective.schema,
        &effective.additional_arg_flags,
        &values,
    )
}

/// A slot key and the one template token a confirmed role places there.
type SlotToken = (String, String);

/// Slots the confirmed positional layout gives to template tokens, with the
/// token each holds: an entry literal, or a binding's placeholder (expanded
/// by the caller that knows the launch values).
fn template_slot_tokens(effective: &EffectiveSchema) -> Vec<SlotToken> {
    let Some(entry) = &effective.entry else {
        return Vec::new();
    };
    entry
        .positional_roles
        .iter()
        .filter_map(|(key, role)| match role {
            PositionalRole::User => None,
            PositionalRole::Binding { name } => Some((key.clone(), format!("{{{name}}}"))),
            PositionalRole::Static { index } => entry
                .prefix
                .get(*index)
                .map(|token| (key.clone(), token.clone())),
        })
        .collect()
}

/// Template indices the confirmed positional layout lifts out of the launch
/// template, and each slot's actual token from the expanded template. A
/// binding is found by its exact placeholder token after the entry prefix,
/// never by searching argument values.
fn lifted_template_slots(
    effective: &EffectiveSchema,
    manifest: &registry::RuntimeManifest,
    expanded: &[String],
) -> Result<(Vec<usize>, Vec<SlotToken>), String> {
    let mut lift = Vec::new();
    let mut tokens = Vec::new();
    let Some(entry) = &effective.entry else {
        return Ok((lift, tokens));
    };
    let prefix_len = entry.prefix.len();
    for (key, role) in &entry.positional_roles {
        let index = match role {
            PositionalRole::User => continue,
            PositionalRole::Static { index } => *index,
            PositionalRole::Binding { name } => {
                let placeholder = format!("{{{name}}}");
                manifest
                    .launch
                    .args
                    .iter()
                    .enumerate()
                    .skip(prefix_len)
                    .find(|(_, arg)| **arg == placeholder)
                    .map(|(index, _)| index)
                    .ok_or_else(|| {
                        format!("{key}: the launch template has no positional {name} binding; review its positional roles")
                    })?
            }
        };
        let token = expanded
            .get(index)
            .ok_or("the launch template changed; review its positional roles")?;
        lift.push(index);
        tokens.push((key.clone(), token.clone()));
    }
    Ok((lift, tokens))
}

/// The schema and values one resolution sees when template tokens fill
/// slots: each such slot holds exactly its one token, so user slots before,
/// between and after it resolve in declared slot order. A value the user
/// saved for such a slot is not replaced; it stays refused as app-owned.
pub(super) fn with_template_slots(
    schema: &OptionSchema,
    mut values: Map<String, Value>,
    tokens: &[SlotToken],
) -> (OptionSchema, Map<String, Value>) {
    if tokens.is_empty() {
        return (schema.clone(), values);
    }
    let mut schema = schema.clone();
    for (key, token) in tokens {
        if values.contains_key(key) {
            continue;
        }
        let Some(option) = schema.options.iter_mut().find(|o| o.key == *key) else {
            continue;
        };
        option.managed = None;
        // The confirmed role places exactly one template token here. A value
        // count help documents stays authoritative (a mismatch is refused).
        if option.arity.supported().is_none() {
            option.arity = Fact {
                value: Some(Arity {
                    min: 1,
                    max: Some(1),
                }),
                certainty: Certainty::UserConfirmed,
                source: Some(Source::User {
                    note: "one launch template token, by its confirmed positional role".into(),
                }),
            };
        }
        values.insert(key.clone(), Value::String(token.clone()));
    }
    (schema, values)
}

/// The binding a launch template placeholder carries.
pub(crate) fn binding_for(placeholder: &str) -> ManagedBinding {
    match placeholder {
        "model" | "model_alias" => ManagedBinding::Model,
        "host" => ManagedBinding::Host,
        "port" => ManagedBinding::Port,
        "api_key" => ManagedBinding::Authentication,
        _ => ManagedBinding::Discovery,
    }
}

/// Saved entries a generic option may hold (dedicated bindings excluded).
pub(super) fn generic_entries(
    values: &Map<String, Value>,
) -> impl Iterator<Item = (&String, &Value)> + '_ {
    values
        .iter()
        .filter(|(key, _)| !RESERVED_KEYS.contains(&key.as_str()))
}

fn generic_values(values: &Map<String, Value>) -> Map<String, Value> {
    generic_entries(values)
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// Saved values only accepted help can describe.
fn help_values(values: &Map<String, Value>, compat_keys: &[String]) -> Map<String, Value> {
    generic_entries(values)
        .filter(|(key, _)| {
            !compat_keys
                .iter()
                .any(|compat| compat.as_str() == key.as_str())
        })
        .map(|(key, value)| (key.clone(), value.clone()))
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
    selected: Result<Selected, crate::error::AppError>,
    values: &Map<String, Value>,
    reported: &BTreeSet<String>,
) -> Vec<options::OptionIssue> {
    let raw = values.contains_key("extra_args")
        && matches!(
            selected
                .as_ref()
                .map(|selected| selected.key.provider)
                .unwrap_or_else(|_| crate::providers::provider_of(cfg)),
            ProviderId::Custom(_),
        );
    let has_generic = generic_entries(values).next().is_some() || raw;
    let issue = |key: &str, code: &'static str, message: String| options::OptionIssue {
        key: key.into(),
        code,
        message,
    };
    if !has_generic {
        // A record ordering nothing still names values that do not exist.
        return match runtime_ordered::saved_order(values) {
            Err(message) => vec![issue(ORDER_KEY, "order", message)],
            Ok(_) => Vec::new(),
        };
    }
    let effective = match selected.and_then(|selected| effective_for(root, cfg, &selected, false)) {
        Ok(effective) => effective,
        Err(error) => {
            return generic_entries(values)
                .chain(
                    values
                        .iter()
                        .filter(|(key, _)| raw && key.as_str() == "extra_args"),
                )
                .filter(|(key, _)| !reported.contains(key.as_str()))
                .map(|(key, _)| {
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
    if raw {
        let validation = if !effective.supports_launch_args {
            Err("attached services do not accept launch arguments".into())
        } else {
            crate::providers::runtime_raw_args::validated(
                &effective.schema,
                &effective.additional_arg_flags,
                values,
            )
        };
        if let Err(message) = validation {
            issues.push(issue("extra_args", "type", message));
        }
    }
    let mut describable = Map::new();
    let mut blocked = BTreeSet::new();
    for (key, value) in generic_entries(values) {
        if reported.contains(key.as_str()) {
            continue;
        }
        let sensitive = effective.schema.options.iter().any(|option| {
            option.key.as_str() == key.as_str() && option.sensitive.supported() == Some(&true)
        });
        let refusal = effective
            .conflicts
            .iter()
            .chain(effective.metadata.iter().flat_map(|view| &view.conflicts))
            .filter(|conflict| conflict.blocking && conflict.key.as_str() == key.as_str())
            .find_map(|conflict| blocking_issue(conflict, value, sensitive));
        if let Some(message) = refusal {
            issues.push(issue(key, "conflict", message));
            blocked.insert(key.clone());
            continue;
        }
        if effective
            .schema
            .options
            .iter()
            .any(|option| option.key.as_str() == key.as_str())
        {
            describable.insert(key.clone(), value.clone());
        } else if effective.accepted_fingerprint.is_none() {
            issues.push(issue(
                key,
                "unknown",
                format!("{key} is not an option this runtime describes; discover and accept its help, or remove the retained value"),
            ));
        } else {
            issues.push(issue(
                key,
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
            // A value refused for its own reason already says why; the order
            // that includes it is not described as unknown as well.
            if outside
                .iter()
                .any(|key| !reported.contains(key) && !blocked.contains(key))
            {
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
    let (schema, describable) = with_template_slots(
        &effective.schema,
        describable,
        &template_slot_tokens(&effective),
    );
    if let Err(found) = runtime_ordered::resolve_saved(&schema, &effective.scope, &describable) {
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
pub(super) fn resolve_launch_plan(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    mut values: Map<String, Value>,
    order: Option<&Value>,
    slot_tokens: &[SlotToken],
) -> Result<(ResolvedOptions, Vec<String>), String> {
    if values.is_empty() && order.is_none() && slot_tokens.is_empty() {
        return Ok((
            ResolvedOptions {
                argv: Vec::new(),
                request: Map::new(),
                scope_boundaries: Vec::new(),
            },
            Vec::new(),
        ));
    }
    let mut effective = effective_for(root, cfg, selected, false)?;
    // Template tokens a confirmed positional role relocates are judged by
    // the same reviewed help as saved values: it must still be current.
    let help_keys = values
        .keys()
        .chain(slot_tokens.iter().map(|(key, _)| key))
        .filter(|key| !effective.compat_keys.contains(key))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
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
    let (schema, values) = with_template_slots(&effective.schema, values, slot_tokens);
    let resolved =
        runtime_ordered::resolve_saved(&schema, &effective.scope, &values).map_err(|issues| {
            issues
                .iter()
                .map(|issue| format!("{}: {}", issue.key, issue.message))
                .collect::<Vec<_>>()
                .join("; ")
        })?;
    if !resolved.request.is_empty() {
        return Err("request fields are sent with requests, not launch arguments".into());
    }
    Ok((resolved, effective.scope))
}

fn resolve_launch(
    root: &Path,
    cfg: &AppConfig,
    selected: &Selected,
    values: Map<String, Value>,
    order: Option<&Value>,
) -> Result<Vec<String>, String> {
    let (resolved, scope) = resolve_launch_plan(root, cfg, selected, values, order, &[])?;
    strip_scope(resolved.argv, &scope)
}

/// The full argv of a registered entry without a command layout: the
/// expanded template, minus binding tokens a confirmed positional layout
/// moves into slot order, then every saved option through one resolver.
pub fn registered_arguments(
    root: &Path,
    cfg: &AppConfig,
    manifest: &registry::RuntimeManifest,
    template: &[String],
) -> Result<Vec<String>, String> {
    let selected = Selected::from_config(cfg)?;
    let effective = effective_for(root, cfg, &selected, false)?;
    let (lift, tokens) = lifted_template_slots(&effective, manifest, template)?;
    let all = crate::providers::launch::provider_options(cfg, selected.key.provider);
    let values: Map<String, Value> = generic_values(&all)
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
    let (resolved, scope) =
        resolve_launch_plan(root, cfg, &selected, values, all.get(ORDER_KEY), &tokens)?;
    let mut argv: Vec<String> = template
        .iter()
        .enumerate()
        .filter(|(index, _)| !lift.contains(index))
        .map(|(_, token)| token.clone())
        .collect();
    argv.extend(strip_scope(resolved.argv, &scope)?);
    Ok(argv)
}

/// A registered layout assembles the exact same resolver output used by
/// validation and preview, without finding subcommands by their spelling.
pub fn assemble_registered_arguments(
    root: &Path,
    cfg: &AppConfig,
    manifest: &registry::RuntimeManifest,
    template: &[String],
) -> Result<Vec<String>, String> {
    let layout = manifest
        .command_layout
        .as_ref()
        .ok_or("the entry has no command layout")?;
    let selected = Selected::from_config(cfg)?;
    let effective = effective_for(root, cfg, &selected, false)?;
    let all = crate::providers::launch::provider_options(cfg, selected.key.provider);
    let values: Map<String, Value> = generic_values(&all)
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
    let (lift, tokens) = lifted_template_slots(&effective, manifest, template)?;
    if values.is_empty() && !all.contains_key(ORDER_KEY) && tokens.is_empty() {
        return Ok(template.to_vec());
    }
    let (resolved, scope) =
        resolve_launch_plan(root, cfg, &selected, values, all.get(ORDER_KEY), &tokens)?;
    let prefix = registry::launch_prefix(manifest);
    if layout.scope(&prefix)? != scope {
        return Err("review help for the declared subcommands before using scoped options; saved values were retained".into());
    }
    layout.assemble(&prefix, template, &resolved.sections(&scope)?, &lift)
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
    for key in runtime_ordered::recorded_keys(values) {
        if RESERVED_KEYS.contains(&key.as_str()) {
            continue;
        }
        if let Some(value) = values.get(&key) {
            launch.insert(key, value.clone());
        }
    }
    resolve_launch(root, cfg, selected, launch, values.get(ORDER_KEY))
}

/// The launch template already names the subcommand; drop the scope words
/// the resolver places before scoped options.
pub(super) fn strip_scope(argv: Vec<String>, scope: &[String]) -> Result<Vec<String>, String> {
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
    let empty = Map::new();
    let saved = cfg
        .provider_options
        .get(crate::providers::provider_of(cfg).as_str())
        .unwrap_or(&empty);
    let values = help_values(saved, compat_keys);
    let accepted = runtime_key(cfg)
        .ok()
        .and_then(|key| {
            load_accepted(root, &key.engine, &key.runtime)
                .ok()
                .flatten()
        })
        .map(|accepted| accepted.fingerprint);
    let mut identity = Map::new();
    identity.insert(
        "help".into(),
        accepted.map(Value::String).unwrap_or(Value::Null),
    );
    identity.insert("values".into(), Value::Object(values));
    // Profiles without the newer records keep their exact earlier identity.
    if let Some(order) = saved.get(ORDER_KEY) {
        identity.insert("order".into(), order.clone());
    }
    if let Ok(key) = runtime_key(cfg) {
        if let Ok(Some(supplement)) = load_supplement(root, &key.engine, &key.runtime) {
            identity.insert(
                "confirmed".into(),
                serde_json::to_value(supplement).unwrap_or(Value::Null),
            );
        }
    }
    Value::Object(identity)
}
