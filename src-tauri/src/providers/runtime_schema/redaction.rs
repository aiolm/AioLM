use super::*;

/// Written over a secret in display and record copies of argv or settings.
pub const REDACTED: &str = "[REDACTED]";

fn secret_keys_of(schema: &OptionSchema, keys: &mut BTreeSet<String>) {
    keys.extend(
        schema
            .options
            .iter()
            .filter(|option| option.sensitive.supported() == Some(&true))
            .map(|option| option.key.clone()),
    );
}

/// Keys of the selected runtime's options its schema marks secret (adapter
/// metadata, built-in facts). A stale accepted help still counts, and so
/// does an accepted snapshot an earlier parser wrote, so stored secrets stay
/// hidden while the user rediscovers. Names alone never make a key secret.
pub fn sensitive_keys(root: &Path, cfg: &AppConfig) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let Ok(selected) = Selected::from_config(cfg) else {
        return keys;
    };
    if let Ok(effective) = effective_for(root, cfg, &selected, false) {
        secret_keys_of(&effective.schema, &mut keys);
    }
    let key = &selected.key;
    if let Ok(Some(accepted)) = load_accepted(root, &key.engine, &key.runtime) {
        if let Some(mut schema) = runtime_help_store::stored_schema(
            root,
            &key.engine,
            &key.runtime,
            &accepted.fingerprint,
        ) {
            if let Some((metadata, builtin)) = compat(&selected).ok().and_then(|c| c.metadata) {
                runtime_metadata::apply(&mut schema, &metadata, builtin, false);
            }
            secret_keys_of(&schema, &mut keys);
        }
    }
    keys
}

/// Literal entry prefix tokens a known-sensitive positional slot holds
/// through an explicit static role in the saved supplement, current or
/// stale. Display-only: a stale role never configures launch (see
/// `build_effective`), but it still identifies an already-known secret.
/// Unknown certainty, non-positional slots, slots outside the reviewed help
/// and out-of-range indices contribute nothing; the program is not a prefix
/// index.
pub(super) fn sensitive_entry_tokens(effective: &EffectiveSchema) -> BTreeSet<String> {
    let (Some(supplement), Some(entry)) = (&effective.supplement, &effective.entry) else {
        return BTreeSet::new();
    };
    sensitive_static_tokens(
        effective
            .schema
            .options
            .iter()
            .filter(|option| effective.help_keys.contains(&option.key)),
        supplement,
        entry,
    )
}

fn sensitive_static_tokens<'a>(
    options: impl Iterator<Item = &'a OptionDefinition>,
    supplement: &SupplementView,
    entry: &CommandEntry,
) -> BTreeSet<String> {
    let mut tokens = BTreeSet::new();
    for option in options {
        if option.position.is_none() || option.target != Target::Launch {
            continue;
        }
        if option.sensitive.supported() != Some(&true) {
            continue;
        }
        let role = supplement
            .options
            .get(&option.key)
            .and_then(|syntax| syntax.positional.as_ref());
        if let Some(PositionalRole::Static { index }) = role {
            if let Some(token) = entry.prefix.get(*index) {
                if !token.is_empty() {
                    tokens.insert(token.clone());
                }
            }
        }
    }
    tokens
}

/// Historical help can prove secrecy without becoming current launch help.
/// Only roles pinned to that accepted schema can identify its prefix tokens.
fn historical_sensitive_entry_tokens(
    root: &Path,
    selected: &Selected,
    effective: &EffectiveSchema,
) -> BTreeSet<String> {
    let (Some(fingerprint), Some(supplement), Some(entry)) = (
        &effective.accepted_fingerprint,
        &effective.supplement,
        &effective.entry,
    ) else {
        return BTreeSet::new();
    };
    if effective.help_state != HelpState::Stale
        || !effective.help_keys.is_empty()
        || supplement.fingerprint != *fingerprint
    {
        return BTreeSet::new();
    }
    let key = &selected.key;
    let Some(mut schema) =
        runtime_help_store::stored_schema(root, &key.engine, &key.runtime, fingerprint)
    else {
        return BTreeSet::new();
    };
    if schema.binding.fingerprint != *fingerprint || schema.validate().is_err() {
        return BTreeSet::new();
    }
    if let Some((metadata, builtin)) = compat(selected).ok().and_then(|c| c.metadata) {
        runtime_metadata::apply(&mut schema, &metadata, builtin, false);
    }
    sensitive_static_tokens(schema.options.iter(), supplement, entry)
}

/// The argv text of every saved value of the selected runtime's secret keys,
/// plus literal entry prefix tokens that known-sensitive static roles hold.
/// The launch argv itself is never changed.
fn secret_texts(root: &Path, cfg: &AppConfig) -> BTreeSet<String> {
    let keys = sensitive_keys(root, cfg);
    let values =
        crate::providers::launch::provider_options(cfg, crate::providers::provider_of(cfg));
    let secret = values
        .iter()
        .filter(|(key, _)| keys.contains(*key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let mut secrets: BTreeSet<String> = runtime_help_store::overrides_from_map(&secret)
        .values()
        .flat_map(|row| row.occurrences.iter().flatten())
        .map(argv_text)
        .filter(|text| !text.is_empty())
        .collect();
    // Entry prefix tokens are not saved option values, so the key lookup
    // above cannot see them; add the ones static roles provably hold.
    if let Ok(selected) = Selected::from_config(cfg) {
        if let Ok(effective) = effective_for(root, cfg, &selected, false) {
            secrets.extend(sensitive_entry_tokens(&effective));
            secrets.extend(historical_sensitive_entry_tokens(
                root, &selected, &effective,
            ));
        }
    }
    secrets
}

/// A display or record copy of argv with the selected runtime's secret
/// option values replaced, including `--flag=value` spellings. The launch
/// argv itself is never changed.
pub fn mask_argv(
    root: &Path,
    cfg: &AppConfig,
    argv: Vec<String>,
    placeholder: &str,
) -> Vec<String> {
    let secrets = secret_texts(root, cfg);
    if secrets.is_empty() {
        return argv;
    }
    argv.into_iter()
        .map(|token| {
            if secrets.contains(&token) {
                return placeholder.to_owned();
            }
            match token.split_once('=') {
                Some((flag, value)) if flag.starts_with('-') && secrets.contains(value) => {
                    format!("{flag}={placeholder}")
                }
                _ => token,
            }
        })
        .collect()
}

/// Secret keys one stored runtime declares, without selecting it: its
/// accepted help (whatever parser wrote it) and, for a registered engine,
/// its manifest options, with its option metadata or built-in facts applied.
/// Only for hiding values; never for launch.
fn stored_runtime_sensitive_keys(
    root: &Path,
    provider: ProviderId,
    runtime: &str,
) -> BTreeSet<String> {
    let engine = provider.as_str();
    let mut keys = BTreeSet::new();
    let (declared, metadata) =
        crate::providers::adapter::help::stored_option_facts(provider, runtime);
    let help = load_accepted(root, engine, runtime)
        .ok()
        .flatten()
        .and_then(|accepted| {
            runtime_help_store::stored_schema(root, engine, runtime, &accepted.fingerprint)
        });
    let manifest_schema = (!declared.is_empty()).then(|| OptionSchema {
        schema_version: SCHEMA_VERSION,
        binding: crate::providers::runtime_options::SchemaBinding {
            engine: engine.into(),
            runtime: runtime.into(),
            fingerprint: compat_fingerprint(engine, runtime, &declared),
        },
        options: declared,
        constraints: Vec::new(),
        raw_help: Vec::new(),
        end_of_options: Fact::default(),
    });
    for mut schema in help.into_iter().chain(manifest_schema) {
        if let Some(metadata) = &metadata {
            runtime_metadata::apply(&mut schema, metadata, false, false);
        }
        secret_keys_of(&schema, &mut keys);
    }
    keys
}

/// Secret keys per engine for every runtime this app has stored facts for
/// (registrations and reviewed help under `root`), plus the selected
/// runtime's effective schema. Runtimes of one engine that declare
/// different facts all count, so every saved copy of that engine's options
/// stays hidden whichever runtime or provider is selected. Every stored
/// engine and runtime directory is read: a partial scan would show a secret
/// as plain text.
pub fn stored_sensitive_keys(root: &Path, cfg: &AppConfig) -> BTreeMap<String, BTreeSet<String>> {
    let mut all: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    if let Ok(selected) = Selected::from_config(cfg) {
        all.entry(selected.key.engine.clone())
            .or_default()
            .extend(sensitive_keys(root, cfg));
    }
    for engine in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let Some(provider) = engine.file_name().to_str().and_then(ProviderId::parse) else {
            continue;
        };
        for runtime in std::fs::read_dir(engine.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            let Some(name) = runtime.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if runtime_help_store::valid_segment(&name) {
                all.entry(provider.as_str().to_owned())
                    .or_default()
                    .extend(stored_runtime_sensitive_keys(root, provider, &name));
            }
        }
    }
    all.retain(|_, keys| !keys.is_empty());
    all
}

/// Hide secret option values in a serialized configuration: every
/// `provider_options.<engine>.<key>`, including the copies saved profiles
/// and sessions keep, for every engine, not only the selected one. Stored
/// values stay.
pub fn mask_config(root: &Path, cfg: &AppConfig, projection: &mut Value, placeholder: &str) {
    fn walk(value: &mut Value, secrets: &BTreeMap<String, BTreeSet<String>>, placeholder: &str) {
        match value {
            Value::Object(object) => {
                for (name, child) in object.iter_mut() {
                    if name == "provider_options" {
                        if let Some(engines) = child.as_object_mut() {
                            for (engine, options) in engines.iter_mut() {
                                let (Some(keys), Some(options)) =
                                    (secrets.get(engine), options.as_object_mut())
                                else {
                                    continue;
                                };
                                for (key, value) in options.iter_mut() {
                                    if keys.contains(key) {
                                        *value = Value::from(placeholder);
                                    }
                                }
                            }
                        }
                    }
                    walk(child, secrets, placeholder);
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, secrets, placeholder);
                }
            }
            _ => {}
        }
    }
    let secrets = stored_sensitive_keys(root, cfg);
    if !secrets.is_empty() {
        walk(projection, &secrets, placeholder);
    }
}
