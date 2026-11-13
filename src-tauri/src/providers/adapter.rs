//! Runtime dispatch belongs here, rather than in Chat, sessions or gateway.
//! Every adapter produces the same owned process plan and canonical EngineInfo.
mod configuration;
pub(crate) mod help;
pub use configuration::parse_option_maps;

use super::{
    launch::{EngineCommand, Readiness},
    protocol::EngineInfo,
    ProviderId,
};
use crate::{config::AppConfig, gpu::ResolvedGpu};
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeKind {
    Native,
    Python,
    ExternalProcess,
}

pub trait InferenceRuntimeAdapter: Send + Sync {
    fn runtime_id(&self, cfg: &AppConfig) -> String {
        cfg.active_runtime.clone()
    }
    fn launch_resources(
        &self,
        _cfg: &AppConfig,
    ) -> Result<Option<super::launch_resources::Request>, String> {
        Ok(None)
    }
    fn kind(&self) -> RuntimeKind;
    fn executable(&self, cfg: &AppConfig) -> Result<String, crate::error::AppError>;
    fn launch(
        &self,
        cfg: &AppConfig,
        port: u16,
        key: &str,
        gpu: &ResolvedGpu,
    ) -> Result<EngineCommand, crate::error::AppError>;
    fn engine_info(&self, cfg: &AppConfig) -> Result<EngineInfo, String>;
}

struct BuiltinAdapter(ProviderId);
struct ProcessAdapter;

/// Native engine selectors and presets can replace the selected model (and
/// some presets also the owned port). Keep them out of legacy typed-argument
/// migration: retain old settings for review and refuse them at launch.
pub(super) const NATIVE_MODEL_SOURCE_FLAGS: &[&str] = &[
    "-hf",
    "-hfr",
    "--hf-repo",
    "-hff",
    "--hf-file",
    "-mu",
    "--model-url",
    "-dr",
    "--docker-repo",
    "--spec-draft-hf",
    "-hfd",
    "-hfrd",
    "--hf-repo-draft",
    "--embd-gemma-default",
    "--fim-qwen-1.5b-default",
    "--fim-qwen-3b-default",
    "--fim-qwen-7b-default",
    "--fim-qwen-7b-spec",
    "--fim-qwen-14b-spec",
    "--fim-qwen-30b-default",
    "--gpt-oss-20b-default",
    "--gpt-oss-120b-default",
    "--vision-gemma-4b-default",
    "--vision-gemma-12b-default",
];

/// Native typed settings and reviewed runtime options share the actual argv.
/// Existing profiles without generic options retain their exact launch plan.
pub(super) fn native_arguments(
    cfg: &AppConfig,
    key: &str,
    gpu: &ResolvedGpu,
) -> Result<Vec<String>, String> {
    for argument in &cfg.server_args {
        let name = argument.trim().split('=').next().unwrap_or_default().trim();
        if NATIVE_MODEL_SOURCE_FLAGS.contains(&name) {
            return Err(format!("native model source argument {name} is app-managed; select the model in its execution setup"));
        }
    }
    let mut args = crate::server::build_args_with_gpu(cfg, key, gpu);
    let values = super::launch::provider_options(cfg, ProviderId::Llama);
    if !values.is_empty() {
        args.extend(super::runtime_schema::launch_arguments(
            &super::registry::root(),
            cfg,
            &values,
        )?);
    }
    Ok(args)
}

/// Explicit native aliases only; arity keeps alias-looking option values out.
/// b12001 accumulates comma aliases into a sorted set. Keep every authorized
/// alias for readiness rather than assuming all runtime versions advertise
/// that set in the same order.
fn native_model_aliases(args: &[String]) -> Vec<String> {
    if !args
        .iter()
        .any(|argument| matches!(argument.as_str(), "--alias" | "-a"))
    {
        return Vec::new();
    }
    static ARITY: std::sync::LazyLock<std::collections::HashMap<String, usize>> =
        std::sync::LazyLock::new(|| {
            let catalog: serde_json::Value = serde_json::from_str(include_str!(
                "../../../src/shared/config/serverOptionsCatalog.json"
            ))
            .expect("checked-in native server catalog");
            let help = catalog["options"]
                .as_array()
                .expect("native server catalog options")
                .iter()
                .filter_map(|option| option["signature"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            super::execution::llama_help_arity(&help)
        });
    let mut aliases = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        let name = if argument.starts_with("--") && argument.contains('_') {
            std::borrow::Cow::Owned(super::execution::llama_argument_name(argument))
        } else {
            std::borrow::Cow::Borrowed(argument.as_str())
        };
        if matches!(name.as_ref(), "--alias" | "-a") {
            if let Some(value) = args.get(index + 1) {
                for candidate in value
                    .split(',')
                    .map(|value| {
                        value.trim_matches(|character| {
                            matches!(character, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}')
                        })
                    })
                    .filter(|value| !value.is_empty())
                {
                    aliases.push(candidate);
                }
            }
            index += 2;
        } else {
            // Preserve raw options absent from the catalog. As in the legacy
            // native argument recognizer, their ordinary non-flag value is
            // consumed without treating it as an option.
            let count = ARITY.get(name.as_ref()).copied().unwrap_or_else(|| {
                usize::from(
                    args.get(index + 1)
                        .is_some_and(|value| !value.starts_with('-')),
                )
            });
            index += 1 + count;
        }
    }
    aliases.sort_unstable();
    aliases.dedup();
    aliases.into_iter().map(str::to_owned).collect()
}

impl InferenceRuntimeAdapter for BuiltinAdapter {
    fn runtime_id(&self, cfg: &AppConfig) -> String {
        if self.kind() == RuntimeKind::Native {
            if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
                String::new()
            } else {
                // Preserve the established public display identity; help's
                // on-disk key has its own legacy ordering.
                format!("{}-{}", cfg.active_build, cfg.active_backend)
            }
        } else {
            cfg.active_runtime.clone()
        }
    }
    fn kind(&self) -> RuntimeKind {
        if self.0.is_python() {
            RuntimeKind::Python
        } else {
            RuntimeKind::Native
        }
    }
    fn executable(&self, cfg: &AppConfig) -> Result<String, crate::error::AppError> {
        if self.kind() == RuntimeKind::Python {
            return Ok(super::selected_python_runtime(cfg)?.python);
        }
        if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
            return Err(crate::error::AppError::validation("select a runtime installed in AioLM before starting the server; system runtimes outside AioLM are not used"));
        }
        let path = crate::runtime::server_bin_for(&cfg.active_backend, &cfg.active_build)?;
        if !path.is_file() {
            return Err(crate::error::AppError::not_found(format!(
                "managed runtime is missing llama-server: {}",
                path.display()
            )));
        }
        Ok(path.to_string_lossy().into_owned())
    }
    fn launch(
        &self,
        cfg: &AppConfig,
        port: u16,
        key: &str,
        gpu: &ResolvedGpu,
    ) -> Result<EngineCommand, crate::error::AppError> {
        if self.kind() == RuntimeKind::Python {
            let mut plan = super::launch::engine_command(
                cfg,
                &super::selected_python_runtime(cfg)?,
                port,
                key,
            )
            .map_err(crate::error::AppError::validation)?;
            let mut environment = super::python_env::engine_environment();
            environment.extend(plan.env);
            plan.env = environment;
            return Ok(plan);
        }
        let mut cfg = cfg.clone();
        cfg.port = port;
        let args = native_arguments(&cfg, key, gpu).map_err(crate::error::AppError::validation)?;
        let aliases = native_model_aliases(&args);
        let upstream_model = aliases.first().unwrap_or(&cfg.active_model).clone();
        Ok(EngineCommand {
            program: PathBuf::from(self.executable(&cfg)?),
            args,
            env: crate::runtime::child_environment_for_runtime(
                &cfg.active_backend,
                &cfg.active_build,
            )?,
            working_directory: super::execution_context::directory(&cfg, None)?,
            upstream_model: upstream_model.clone(),
            readiness: Readiness {
                health_path: "/health".into(),
                health_authenticated: true,
                expected_model: upstream_model,
                expected_model_aliases: aliases,
            },
        })
    }
    fn engine_info(&self, cfg: &AppConfig) -> Result<EngineInfo, String> {
        let mut info = super::execution::builtin_info(cfg)?;
        if self.kind() == RuntimeKind::Native {
            let args = native_arguments(cfg, "", &ResolvedGpu::default())?;
            let aliases = native_model_aliases(&args);
            let model = aliases.first().unwrap_or(&cfg.active_model);
            info.upstream_model = model.to_owned();
            if info.embedding_model.is_some() {
                info.embedding_model = Some(model.to_owned());
            }
        }
        Ok(info)
    }
}
impl InferenceRuntimeAdapter for ProcessAdapter {
    fn launch_resources(
        &self,
        cfg: &AppConfig,
    ) -> Result<Option<super::launch_resources::Request>, String> {
        Ok(
            super::registry::manifest(super::provider_of(cfg), &cfg.active_runtime)?
                .launch_resources,
        )
    }
    fn kind(&self) -> RuntimeKind {
        RuntimeKind::ExternalProcess
    }
    fn executable(&self, cfg: &AppConfig) -> Result<String, crate::error::AppError> {
        Ok(
            super::registry::manifest(super::provider_of(cfg), &cfg.active_runtime)?
                .launch
                .program,
        )
    }
    fn launch(
        &self,
        cfg: &AppConfig,
        port: u16,
        key: &str,
        _gpu: &ResolvedGpu,
    ) -> Result<EngineCommand, crate::error::AppError> {
        let mut plan = super::registry::command(cfg, port, key)?;
        let mut environment = crate::runtime::child_environment();
        environment.extend(plan.env);
        plan.env = environment;
        Ok(plan)
    }
    fn engine_info(&self, cfg: &AppConfig) -> Result<EngineInfo, String> {
        super::registry::info(cfg).map_err(Into::into)
    }
}
pub fn resolve(cfg: &AppConfig) -> Box<dyn InferenceRuntimeAdapter> {
    let provider = super::provider_of(cfg);
    if provider.is_custom() {
        Box::new(ProcessAdapter)
    } else {
        Box::new(BuiltinAdapter(provider))
    }
}
pub async fn refresh(
    cfg: &AppConfig,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<(), crate::error::AppError> {
    match resolve(cfg).kind() {
        RuntimeKind::ExternalProcess => super::registry::refresh(cfg, cancel).await,
        RuntimeKind::Python => super::refresh_selected_python_runtime(cfg, cancel)
            .await
            .map(|_| ()),
        RuntimeKind::Native => Ok(()),
    }
}

pub(crate) async fn prepare_launch(
    cfg: &AppConfig,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<(), crate::error::AppError> {
    if super::registry::prepare_automatic_launch(cfg, cancel.as_deref())? {
        return Ok(());
    }
    refresh(cfg, cancel).await
}

#[derive(Clone, Copy)]
pub enum RuntimeFeature {
    DeepVerification,
    Portable,
}
pub fn require_feature(cfg: &AppConfig, feature: RuntimeFeature) -> Result<(), String> {
    let adapter = resolve(cfg);
    match (adapter.kind(), feature) {
        (RuntimeKind::ExternalProcess, RuntimeFeature::DeepVerification) => Err("unsupported: this adapter provides no device/reference comparison for deep verification".into()),
        (RuntimeKind::ExternalProcess, RuntimeFeature::Portable) => Err("unsupported: this external process adapter provides no portable dependency/ABI bundle".into()),
        _ => Ok(()),
    }
}
