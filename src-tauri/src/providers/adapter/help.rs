//! Adapter-owned help entry points and option facts. Common schema, UI and
//! process consumers receive descriptors; they do not select engine-specific
//! commands or catalogs. Registered engines use their manifest data.
use super::super::{
    options, registry,
    runtime_help::{Encoding, HelpCommand, MAX_STREAM_BYTES},
    runtime_help_store,
    runtime_metadata::{MetadataOption, OptionMetadata, Provenance, METADATA_VERSION},
    runtime_options::{ManagedBinding, OptionDefinition},
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
    // Built-in lists name app-owned flags without saying which binding each
    // one carries; Discovery marks them managed without guessing.
    let mut managed_flags: BTreeMap<String, ManagedBinding> =
        options::app_managed_flags(key.provider)
            .iter()
            .map(|flag| ((*flag).to_owned(), ManagedBinding::Discovery))
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
        ProviderId::Llama => Vec::new(),
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

pub(crate) fn builtin_metadata(provider: ProviderId) -> Option<OptionMetadata> {
    match provider {
        // llama.cpp (source 14310190) common/arg.cpp defines `-hft, --hf-token
        // TOKEN` as the Hugging Face access token, also read from HF_TOKEN.
        // Benchmark logs already redact the same flag.
        ProviderId::Llama => Some(OptionMetadata {
            version: METADATA_VERSION,
            engine_id: ProviderId::Llama,
            adapter: Provenance {
                id: "llama.cpp".into(),
                revision: "aiolm-builtin-1".into(),
            },
            options: vec![MetadataOption {
                flag: "--hf-token".into(),
                sensitive: Some(true),
                ..Default::default()
            }],
            constraints: Vec::new(),
        }),
        _ => None,
    }
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
    fn provided_python_help_and_catalog_contracts_survive_adapter_selection() {
        // Command/schema equivalence only; these engines are not executed
        // or declared Windows-native supported by this test.
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
                let target = help_target(&cfg, &selected, None).unwrap();
                let mut expected: Vec<String> = if kind == InstallationKind::Managed {
                    vec!["-I".into()]
                } else {
                    vec![]
                };
                let expected_scope = match provider {
                    ProviderId::Vllm => {
                        expected.extend(
                            ["-m", "vllm.entrypoints.cli.main", "serve", "--help=all"]
                                .map(String::from),
                        );
                        vec!["serve".to_owned()]
                    }
                    _ => {
                        expected.extend(["-m", "mlx_vlm.server", "--help"].map(String::from));
                        vec![]
                    }
                };
                assert_eq!(target.program, python);
                assert_eq!(target.request.args, expected);
                assert_eq!(target.request.scope, expected_scope);
                assert!(target.fixed);
                assert_eq!(target.request.encoding, None);
                assert_eq!(target.request.locale, None);
                let command = help_command(&cfg, &selected, &target.request).unwrap();
                assert_eq!(command.program, PathBuf::from(&python));
                assert_eq!(command.args, expected);
                assert_eq!(command.scope, expected_scope);
                assert_eq!(
                    command.environment,
                    unicode_environment(super::super::super::python_env::engine_environment())
                        .unwrap()
                );
                assert_eq!(command.runtime_version, "synthetic-1");
                let legacy = super::super::super::launch::option_schema(&runtime);
                let expected_options: Vec<_> = legacy
                    .iter()
                    .map(|spec| from_spec(spec, &adapter_source(provider.as_str(), "catalog-v1")))
                    .collect();
                let effective =
                    runtime_schema::effective_for(&root, &cfg, &selected, false).unwrap();
                assert_eq!(effective.schema.options, expected_options);
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
        assert!(facts.options.is_empty());
        assert!(facts.entry.is_none());
        let (metadata, shipped) = facts.metadata.unwrap();
        assert!(shipped);
        assert_eq!(metadata.engine_id, ProviderId::Llama);
        assert_eq!(metadata.options.len(), 1);
        assert_eq!(metadata.options[0].flag, "--hf-token");
        assert_eq!(metadata.options[0].sensitive, Some(true));
    }
}
