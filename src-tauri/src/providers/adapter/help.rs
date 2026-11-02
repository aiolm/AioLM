//! Adapter-owned help entry points and option facts. Common schema, UI and
//! process consumers receive descriptors; they do not select engine-specific
//! commands or catalogs. Registered engines use their manifest data.
use super::super::{
    options, registry,
    runtime_help::{Encoding, HelpCommand, MAX_STREAM_BYTES},
    runtime_help_store,
    runtime_metadata::{MetadataOption, OptionMetadata, Provenance, METADATA_VERSION},
    runtime_options::{
        Arity, BenchmarkRole, ManagedBinding, OptionDefinition, Spelling, Target, ValueKind,
        ValueStyle,
    },
    runtime_positional::CommandEntry,
    runtime_schema::{
        self, adapter_source, binding_for, from_external, from_spec, unicode_environment,
        AcceptedHelp, HelpRequest, HelpTarget,
    },
    ProviderId,
};
use crate::config::AppConfig;
use std::{collections::BTreeMap, path::PathBuf};
pub(crate) const HELP_TIMEOUT_MS: u64 = 60_000;

pub struct RuntimeKey {
    pub provider: ProviderId,
    pub engine: String,
    pub runtime: String,
}

pub fn runtime_key(cfg: &AppConfig) -> Result<RuntimeKey, String> {
    let provider = super::super::provider_of(cfg);
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

/// The selected runtime as its adapter sees it. Launch can pass an already
/// resolved Python runtime rather than reselecting an installation.
pub struct Selected {
    pub key: RuntimeKey,
    python: Option<super::super::python_env::PythonRuntimeManifest>,
}

impl Selected {
    pub fn from_config(cfg: &AppConfig) -> Result<Self, String> {
        let key = runtime_key(cfg)?;
        let python = if key.provider.is_python() {
            Some(super::super::selected_python_runtime(cfg)?)
        } else {
            None
        };
        Ok(Self { key, python })
    }

    pub fn python(
        runtime: &super::super::python_env::PythonRuntimeManifest,
    ) -> Result<Self, String> {
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

    fn python_runtime(&self) -> Result<&super::super::python_env::PythonRuntimeManifest, String> {
        self.python
            .as_ref()
            .ok_or_else(|| "this runtime has no Python entry point".into())
    }
}

pub(crate) fn help_target(
    cfg: &AppConfig,
    selected: &Selected,
    accepted: Option<AcceptedHelp>,
) -> Result<HelpTarget, String> {
    let key = &selected.key;
    let (program, fixed, prefix, default) = match key.provider {
        ProviderId::Custom(_) => {
            let manifest = registry::manifest(key.provider, &key.runtime)?;
            let prefix = registry::launch_prefix(&manifest);
            let scope =
                super::super::runtime_command::scope(manifest.command_layout.as_ref(), &prefix)?;
            let mut args = prefix.clone();
            args.push("--help".into());
            let request = HelpRequest {
                encoding: None,
                locale: None,
                working_directory: None,
                program: None,
                args,
                scope,
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
                encoding: None,
                locale: None,
                working_directory: None,
                program: None,
                args: vec!["--help".into()],
                scope: Vec::new(),
            },
        ),
        _ => {
            let runtime = selected.python_runtime()?;
            let (args, scope) = super::super::launch::help_entry(runtime)?;
            (
                runtime.python.clone(),
                true,
                Vec::new(),
                HelpRequest {
                    encoding: None,
                    locale: None,
                    working_directory: None,
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

pub(crate) fn help_command(
    cfg: &AppConfig,
    selected: &Selected,
    request: &HelpRequest,
) -> Result<HelpCommand, String> {
    let key = &selected.key;
    let command = match key.provider {
        ProviderId::Custom(_) => runtime_schema::manifest_help_command(
            &registry::manifest(key.provider, &key.runtime)?,
            request,
        )?,
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
                working_directory: super::super::execution_context::requested(
                    None,
                    request.working_directory.as_deref(),
                )?,
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
            let (args, scope) = super::super::launch::help_entry(runtime)?;
            if request.args != args || request.program.is_some() || request.scope != scope {
                return Err("built-in runtimes use their own help command".into());
            }
            HelpCommand {
                program: PathBuf::from(&runtime.python),
                args,
                environment: unicode_environment(super::super::python_env::engine_environment())?,
                working_directory: super::super::execution_context::requested(
                    None,
                    request.working_directory.as_deref(),
                )?,
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
    Ok(command)
}

pub(crate) struct Compat {
    pub(crate) explicit_scopes: BTreeMap<String, Vec<String>>,
    pub(crate) options: Vec<OptionDefinition>,
    /// Flag spelling to the app-owned binding it carries.
    pub(crate) managed_flags: BTreeMap<String, ManagedBinding>,
    /// Explicit option metadata and whether the app ships it (built-in).
    pub(crate) metadata: Option<(OptionMetadata, bool)>,
    /// A registered runtime's command head; built-in runtimes have none.
    pub(crate) entry: Option<CommandEntry>,
}

pub(crate) fn option_descriptor(selected: &Selected) -> Result<Compat, String> {
    let key = &selected.key;
    // Dedicated tuning remains adapter-owned; lifecycle bindings additionally
    // carry the private identity that benchmark metadata cannot unlock.
    let mut managed_flags: BTreeMap<String, ManagedBinding> =
        options::app_managed_flags(key.provider)
            .iter()
            .map(|flag| {
                (
                    (*flag).to_owned(),
                    if key.provider == ProviderId::Llama {
                        native_binding(flag)
                    } else {
                        ManagedBinding::Discovery
                    },
                )
            })
            .collect();
    let mut explicit_scopes = BTreeMap::new();
    let mut metadata = builtin_metadata(key.provider).map(|metadata| (metadata, true));
    let mut entry = None;
    let options = match key.provider {
        ProviderId::Custom(_) => {
            let manifest = registry::manifest(key.provider, &key.runtime)?;
            entry = Some(CommandEntry::from_manifest(&manifest));
            metadata = manifest
                .option_metadata
                .clone()
                .map(|metadata| (metadata, false));
            let source = adapter_source(
                &key.engine,
                &format!("manifest-v{}", manifest.adapter_version),
            );
            let (bound, _) = registry::bound_launch_flags(&manifest);
            for (flag, binding) in bound {
                managed_flags.insert(flag, binding_for(&binding));
            }
            for option in &manifest.options {
                if let Some(scope) = &option.scope {
                    explicit_scopes.insert(option.key.clone(), scope.clone());
                }
            }
            // Every option the fixed entry prefix spells (`--engine strata`,
            // `--flag=value`) is part of what was registered and probed.
            let prefix = registry::launch_prefix(&manifest);
            let fixed = match &manifest.command_layout {
                Some(layout) => layout.fixed_flags(&prefix)?,
                None => prefix,
            };
            for token in fixed {
                let flag = token
                    .split_once('=')
                    .map_or(token.as_str(), |(flag, _)| flag);
                if flag.starts_with('-') && !flag.trim_start_matches('-').is_empty() {
                    managed_flags
                        .entry(flag.to_owned())
                        .or_insert(ManagedBinding::EntryPoint);
                }
            }
            manifest
                .options
                .iter()
                .filter_map(|option| from_external(option, &source))
                .collect()
        }
        ProviderId::Llama => native_catalog(),
        _ => {
            let runtime = selected.python_runtime()?;
            let source = adapter_source(&key.engine, "catalog-v1");
            super::super::launch::option_schema(runtime)
                .iter()
                .map(|spec| from_spec(spec, &source))
                .collect()
        }
    };
    Ok(Compat {
        explicit_scopes,
        options,
        managed_flags,
        metadata,
        entry,
    })
}

type BenchmarkDeclaration = (&'static str, Option<&'static str>, Option<BenchmarkRole>);

/// Portable safety belongs to each adapter catalog, never to the runner.
pub(crate) fn builtin_metadata(provider: ProviderId) -> Option<OptionMetadata> {
    use BenchmarkRole::*;
    let (id, declarations): (&str, &[BenchmarkDeclaration]) = match provider {
        ProviderId::Llama => (
            "llama.cpp",
            &[
                ("--ctx-size", Some("tokens"), Some(ContextTotalTokens)),
                ("--parallel", Some("count"), Some(ConcurrencyCapacity)),
                ("--n-gpu-layers", Some("layers"), None),
                ("--threads", Some("threads"), None),
                ("--threads-batch", Some("threads"), None),
                ("--batch-size", Some("tokens"), None),
                ("--ubatch-size", Some("tokens"), None),
                ("--flash-attn", None, None),
                ("--cache-type-k", None, None),
                ("--cache-type-v", None, None),
                ("--split-mode", None, None),
                ("--tensor-split", Some("ratio"), None),
            ],
        ),
        ProviderId::Vllm => (
            "vllm",
            &[
                (
                    "--max-model-len",
                    Some("tokens"),
                    Some(ContextPerSequenceTokens),
                ),
                ("--max-num-seqs", Some("count"), Some(ConcurrencyCapacity)),
                ("--dtype", None, None),
                ("--quantization", None, None),
                ("--kv-cache-dtype", None, None),
                ("--gpu-memory-utilization", Some("ratio"), None),
                ("--tensor-parallel-size", Some("count"), None),
                ("--pipeline-parallel-size", Some("count"), None),
                ("--max-num-batched-tokens", Some("tokens"), None),
                ("--enable-prefix-caching", None, None),
                ("--enable-chunked-prefill", None, None),
                ("--enforce-eager", None, None),
            ],
        ),
        ProviderId::MlxVlm => (
            "mlx-vlm",
            &[
                (
                    "--max-kv-size",
                    Some("tokens"),
                    Some(ContextPerRequestKvTokens),
                ),
                ("--max-num-seqs", Some("count"), Some(ConcurrencyCapacity)),
                ("--kv-bits", Some("bits"), None),
                ("--kv-quant-scheme", None, None),
                ("--kv-group-size", Some("count"), None),
                ("--quantized-kv-start", Some("tokens"), None),
                ("--prefill-step-size", Some("tokens"), None),
                ("--enable-thinking", None, None),
                ("--thinking-budget", Some("tokens"), None),
            ],
        ),
        _ => return None,
    };
    let mut entries =
        Vec::with_capacity(declarations.len() + usize::from(provider == ProviderId::Llama));
    entries.extend(
        declarations
            .iter()
            .copied()
            .map(|(flag, unit, role)| MetadataOption {
                flag: Some(flag.into()),
                benchmark_public: Some(true),
                benchmark_role: role,
                unit: unit.map(str::to_owned),
                repeatable: Some(false),
                ..Default::default()
            }),
    );
    if provider == ProviderId::Llama {
        entries.push(MetadataOption {
            flag: Some("--hf-token".into()),
            sensitive: Some(true),
            ..Default::default()
        });
    }
    Some(OptionMetadata {
        version: METADATA_VERSION,
        engine_id: provider,
        adapter: Provenance {
            id: id.into(),
            revision: "aiolm-builtin-2".into(),
        },
        options: entries,
        constraints: Vec::new(),
    })
}

fn native_binding(flag: &str) -> ManagedBinding {
    if super::NATIVE_MODEL_SOURCE_FLAGS.contains(&flag) {
        return ManagedBinding::Model;
    }
    match flag {
        "--model" | "-m" | "--mmproj" | "-mm" | "--mmproj-url" | "-mmu" | "--mmproj-auto"
        | "--no-mmproj" | "--no-mmproj-auto" | "--lora" | "--lora-scaled"
        | "--spec-draft-model" | "-md" | "--model-draft" => ManagedBinding::Model,
        "--host" => ManagedBinding::Host,
        "--port" | "-p" => ManagedBinding::Port,
        "--api-key" | "--api-key-file" | "--no-api-key" => ManagedBinding::Authentication,
        _ => ManagedBinding::Discovery,
    }
}

/// Seed dedicated native controls from the same catalogs their editors use.
/// No reset/app/runtime default is promoted into an observed launch setting.
fn native_catalog() -> Vec<OptionDefinition> {
    use runtime_schema::{blank, documented};
    let source = adapter_source("llama.cpp", "catalog-v1");
    let managed_flags = options::app_managed_flags(ProviderId::Llama);
    let tuning: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../src/shared/config/tuningDefaultsCatalog.json"
    ))
    .expect("checked-in native tuning catalog");
    let server: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../src/shared/config/serverOptionsCatalog.json"
    ))
    .expect("checked-in native server catalog");
    let controls = [
        ("ctx_size", "--ctx-size", ValueKind::Integer),
        ("parallel", "--parallel", ValueKind::Integer),
        ("ngl", "--n-gpu-layers", ValueKind::Integer),
        ("threads", "--threads", ValueKind::Integer),
        ("threads_batch", "--threads-batch", ValueKind::Integer),
        ("batch_size", "--batch-size", ValueKind::Integer),
        ("ubatch_size", "--ubatch-size", ValueKind::Integer),
        ("flash_attn", "--flash-attn", ValueKind::Text),
        ("cache_type_k", "--cache-type-k", ValueKind::Text),
        ("cache_type_v", "--cache-type-v", ValueKind::Text),
        ("split_mode", "--split-mode", ValueKind::Text),
        ("tensor_split", "--tensor-split", ValueKind::Json),
        ("hf_token", "--hf-token", ValueKind::Text),
        ("model", "--model", ValueKind::Text),
        ("host", "--host", ValueKind::Text),
        ("port", "--port", ValueKind::Integer),
        ("api_key", "--api-key", ValueKind::Text),
        ("api_key_file", "--api-key-file", ValueKind::Text),
        ("mmproj", "--mmproj", ValueKind::Text),
        ("lora", "--lora", ValueKind::Text),
        ("spec_draft_model", "--spec-draft-model", ValueKind::Text),
    ];
    let mut definitions: Vec<_> = controls
        .into_iter()
        .map(|(key, flag, kind)| {
            let mut option = blank(key, "native", Target::Launch);
            let row = server["options"].as_array().and_then(|rows| {
                rows.iter().find(|row| {
                    row["signature"].as_str().is_some_and(|signature| {
                        signature
                            .split(|c: char| c == ',' || c.is_whitespace())
                            .any(|word| word == flag)
                    })
                })
            });
            let mut aliases = vec![flag.to_owned()];
            if let Some(args) = tuning
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["key"].as_str() == Some(key)))
                .and_then(|row| row["args"].as_array())
            {
                aliases.extend(
                    args.iter()
                        .filter_map(|value| value.as_str().map(str::to_owned)),
                );
            }
            if let Some(signature) = row.and_then(|row| row["signature"].as_str()) {
                aliases.extend(
                    signature
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .filter(|word| word.starts_with('-'))
                        .map(str::to_owned),
                );
            }
            let mut seen = std::collections::BTreeSet::new();
            aliases.retain(|flag| seen.insert(flag.clone()));
            option.spellings = aliases
                .into_iter()
                .map(|flag| Spelling {
                    flag,
                    style: ValueStyle::Separate,
                    polarity: None,
                })
                .collect();
            option.kind = documented(kind, &source);
            option.arity = documented(
                Arity {
                    min: 1,
                    max: Some(1),
                },
                &source,
            );
            option.repeatable = documented(false, &source);
            // Capture annotations never change the existing launch ownership.
            option.managed = managed_flags.contains(&flag).then(|| native_binding(flag));
            option.help = row
                .and_then(|row| row["description"].as_str())
                .unwrap_or("")
                .into();
            option
        })
        .collect();
    // Keep every existing dedicated tuning row represented, including those
    // with no public-safety annotation. Unknown types remain unknown.
    for row in tuning.as_array().expect("native tuning rows") {
        let key = row["key"].as_str().expect("native tuning key");
        if definitions.iter().any(|option| option.key == key) {
            continue;
        }
        let mut option = blank(key, "native", Target::Launch);
        let is_switch = row["switch"].as_bool() == Some(true);
        option.spellings = row["args"]
            .as_array()
            .expect("native tuning aliases")
            .iter()
            .filter_map(|value| value.as_str())
            .map(|flag| Spelling {
                flag: flag.into(),
                style: ValueStyle::Separate,
                polarity: is_switch.then_some(!flag.starts_with("--no-")),
            })
            .collect();
        option.arity = documented(
            if is_switch {
                Arity {
                    min: 0,
                    max: Some(0),
                }
            } else {
                Arity {
                    min: 1,
                    max: Some(1),
                }
            },
            &source,
        );
        if is_switch {
            option.kind = documented(ValueKind::Boolean, &source);
        }
        option.repeatable = documented(false, &source);
        option.managed = option.spellings.iter().find_map(|spelling| {
            managed_flags
                .contains(&spelling.flag.as_str())
                .then(|| native_binding(&spelling.flag))
        });
        definitions.push(option);
    }
    definitions
}

pub(crate) fn stored_option_facts(
    provider: ProviderId,
    runtime: &str,
) -> (Vec<OptionDefinition>, Option<OptionMetadata>) {
    let engine = provider.as_str();
    let (declared, metadata) = match provider {
        ProviderId::Custom(_) => match registry::manifest(provider, runtime) {
            Ok(manifest) => {
                let source =
                    adapter_source(engine, &format!("manifest-v{}", manifest.adapter_version));
                (
                    manifest
                        .options
                        .iter()
                        .filter_map(|option| from_external(option, &source))
                        .collect::<Vec<_>>(),
                    manifest.option_metadata,
                )
            }
            Err(_) => (Vec::new(), None),
        },
        _ => (Vec::new(), builtin_metadata(provider)),
    };
    (declared, metadata)
}

#[cfg(test)]
mod tests {
    use super::super::super::python_env::{InstallationKind, ProbeRecord, PythonRuntimeManifest};
    use super::*;

    #[test]
    fn python_catalog_capture_preserves_context_units_and_roles_for_each_installation() {
        for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
            for kind in [InstallationKind::Managed, InstallationKind::External] {
                let root =
                    std::env::temp_dir().join(format!("aiolm-boundary-{}", uuid::Uuid::new_v4()));
                let python = root.join("synthetic python").to_string_lossy().into_owned();
                let runtime = PythonRuntimeManifest {
                    format: 1,
                    provider,
                    id: "synthetic-build".into(),
                    kind,
                    python: python.clone(),
                    requested_version: None,
                    probe: Some(ProbeRecord {
                        version: "synthetic-1".into(),
                        ..Default::default()
                    }),
                };
                let selected = Selected::python(&runtime).unwrap();
                let cfg = AppConfig {
                    active_provider: provider.as_str().into(),
                    active_runtime: runtime.id.clone(),
                    ..Default::default()
                };
                let effective =
                    runtime_schema::effective_for(&root, &cfg, &selected, false).unwrap();
                let (flag, name, unit, role) = if provider == ProviderId::Vllm {
                    (
                        "--max-model-len",
                        "max-model-len",
                        "tokens",
                        "context.per_sequence_tokens",
                    )
                } else {
                    (
                        "--max-kv-size",
                        "max-kv-size",
                        "tokens",
                        "context.per_request_kv_tokens",
                    )
                };
                let argv = [python.clone(), flag.into(), "8192".into()];
                let captured =
                    runtime_schema::capture_benchmark_settings(&effective, &argv, &argv, 3)
                        .unwrap();
                assert_eq!(captured.settings.len(), 1);
                assert_eq!(captured.settings[0].name, name);
                assert_eq!(captured.settings[0].value, serde_json::json!(8192));
                assert_eq!(captured.settings[0].unit.as_deref(), Some(unit));
                assert_eq!(captured.settings[0].role.as_deref(), Some(role));
                assert_eq!(effective.schema.binding.engine, provider.as_str());
                assert_eq!(effective.schema.binding.runtime, runtime.id);
            }
        }
    }

    #[test]
    fn native_help_metadata_and_legacy_public_identity_are_preserved() {
        let build = format!("local_{}", uuid::Uuid::new_v4().simple());
        let cfg = AppConfig {
            active_backend: "cpu".into(),
            active_build: build.clone(),
            ..Default::default()
        };
        let selected = Selected::from_config(&cfg).unwrap();
        assert_eq!(selected.key.runtime, format!("cpu-{build}"));
        assert_eq!(
            super::super::resolve(&cfg).runtime_id(&cfg),
            format!("{build}-cpu")
        );
        let target = help_target(&cfg, &selected, None).unwrap();
        assert_eq!(target.request.args, vec!["--help"]);
        assert!(target.request.scope.is_empty());
        let command = help_command(&cfg, &selected, &target.request).unwrap();
        assert_eq!(
            command.program,
            crate::runtime::runtime_dir("cpu", &build)
                .unwrap()
                .join(crate::runtime::server_executable_name())
        );
        assert_eq!(command.args, vec!["--help"]);
        assert_eq!(command.runtime_version, format!("cpu/{build}"));
        assert_eq!(command.encoding, Encoding::Auto);
        assert_eq!(command.timeout_ms, 60_000);
        assert_eq!(command.output_limit, MAX_STREAM_BYTES);
        let facts = option_descriptor(&selected).unwrap();
        assert!(facts.options.iter().any(|option| option.key == "ctx_size"));
        assert!(facts.entry.is_none());
        let (metadata, shipped) = facts.metadata.unwrap();
        assert!(shipped);
        assert_eq!(metadata.engine_id, ProviderId::Llama);
        let token = metadata
            .options
            .iter()
            .find(|entry| entry.flag.as_deref() == Some("--hf-token"))
            .unwrap();
        assert_eq!(token.sensitive, Some(true));
        let root =
            std::env::temp_dir().join(format!("aiolm-native-capture-{}", uuid::Uuid::new_v4()));
        let effective = runtime_schema::effective_for(&root, &cfg, &selected, false).unwrap();
        let argv = [
            "server",
            "-c",
            "8192",
            "-t",
            "4",
            "--threads",
            "8",
            "--parallel",
            "2",
            "--tensor-split",
            "0.6,0.4",
            "--hf-token",
            "private",
        ];
        let raw = argv.map(str::to_owned);
        let mut sanitized = raw.clone();
        sanitized[6] = "[REDACTED]".into();
        sanitized[12] = "[REDACTED]".into();
        let captured =
            runtime_schema::capture_benchmark_settings(&effective, &raw, &sanitized, 3).unwrap();
        let value = |name: &str| {
            &captured
                .settings
                .iter()
                .find(|setting| setting.name == name)
                .unwrap()
                .value
        };
        assert_eq!(value("ctx-size"), &serde_json::json!(8192));
        assert_eq!(value("parallel"), &serde_json::json!(2));
        assert_eq!(value("threads"), &serde_json::Value::Null);
        assert_eq!(value("tensor-split"), &serde_json::json!([0.6, 0.4]));
        assert!(!captured
            .settings
            .iter()
            .any(|setting| setting.name == "hf-token"));
        let threads = effective
            .schema
            .options
            .iter()
            .find(|option| option.key == "threads")
            .unwrap();
        assert!(
            threads.managed.is_some(),
            "capture must not unlock dedicated controls"
        );
        assert!(effective
            .schema
            .resolve(
                &effective.scope,
                &std::collections::BTreeMap::from([(
                    "threads".into(),
                    super::super::super::runtime_options::Override {
                        spelling: None,
                        occurrences: vec![vec![serde_json::json!(16)]],
                    }
                )])
            )
            .is_err());
    }
}
