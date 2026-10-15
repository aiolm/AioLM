//! Runtime dispatch belongs here, rather than in Chat, sessions or gateway.
//! Every adapter produces the same owned process plan and canonical EngineInfo.
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
    fn launch_resources(
        &self,
        _cfg: &AppConfig,
    ) -> Result<Option<super::launch_resources::Request>, String> {
        Ok(None)
    }
    fn kind(&self) -> RuntimeKind;
    fn executable(&self, cfg: &AppConfig) -> Result<String, String>;
    fn launch(
        &self,
        cfg: &AppConfig,
        port: u16,
        key: &str,
        gpu: &ResolvedGpu,
    ) -> Result<EngineCommand, String>;
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

impl InferenceRuntimeAdapter for BuiltinAdapter {
    fn kind(&self) -> RuntimeKind {
        if self.0.is_python() {
            RuntimeKind::Python
        } else {
            RuntimeKind::Native
        }
    }
    fn executable(&self, cfg: &AppConfig) -> Result<String, String> {
        if self.kind() == RuntimeKind::Python {
            return Ok(super::selected_python_runtime(cfg)?.python);
        }
        if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
            return Err("select a runtime installed in AioLM before starting the server; system runtimes outside AioLM are not used".into());
        }
        let path = crate::runtime::server_bin_for(&cfg.active_backend, &cfg.active_build)?;
        if !path.is_file() {
            return Err(format!(
                "managed runtime is missing llama-server: {}",
                path.display()
            ));
        }
        Ok(path.to_string_lossy().into_owned())
    }
    fn launch(
        &self,
        cfg: &AppConfig,
        port: u16,
        key: &str,
        gpu: &ResolvedGpu,
    ) -> Result<EngineCommand, String> {
        if self.kind() == RuntimeKind::Python {
            let mut plan = super::launch::engine_command(
                cfg,
                &super::selected_python_runtime(cfg)?,
                port,
                key,
            )?;
            let mut environment = super::python_env::engine_environment();
            environment.extend(plan.env);
            plan.env = environment;
            return Ok(plan);
        }
        let mut cfg = cfg.clone();
        cfg.port = port;
        Ok(EngineCommand {
            program: PathBuf::from(self.executable(&cfg)?),
            args: native_arguments(&cfg, key, gpu)?,
            env: crate::runtime::child_environment_for_runtime(
                &cfg.active_backend,
                &cfg.active_build,
            )?,
            working_directory: super::execution_context::directory(&cfg, None)?,
            upstream_model: cfg.active_model.clone(),
            readiness: Readiness {
                health_path: "/health".into(),
                health_authenticated: true,
                expected_model: cfg.active_model,
            },
        })
    }
    fn engine_info(&self, cfg: &AppConfig) -> Result<EngineInfo, String> {
        super::execution::builtin_info(cfg)
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
    fn executable(&self, cfg: &AppConfig) -> Result<String, String> {
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
    ) -> Result<EngineCommand, String> {
        let mut plan = super::registry::command(cfg, port, key)?;
        let mut environment = super::python_env::engine_environment();
        environment.extend(plan.env);
        plan.env = environment;
        Ok(plan)
    }
    fn engine_info(&self, cfg: &AppConfig) -> Result<EngineInfo, String> {
        super::registry::info(cfg)
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
pub async fn refresh(cfg: &AppConfig, cancel: Option<Arc<AtomicBool>>) -> Result<(), String> {
    match resolve(cfg).kind() {
        RuntimeKind::ExternalProcess => super::registry::refresh(cfg, cancel).await,
        RuntimeKind::Python => super::refresh_selected_python_runtime(cfg, cancel)
            .await
            .map(|_| ()),
        RuntimeKind::Native => Ok(()),
    }
}

#[derive(Clone, Copy)]
pub enum RuntimeFeature {
    ExactBenchmark,
    DeepVerification,
    Portable,
}
pub fn require_feature(cfg: &AppConfig, feature: RuntimeFeature) -> Result<(), String> {
    let adapter = resolve(cfg);
    match (adapter.kind(), feature) {
        (RuntimeKind::ExternalProcess, RuntimeFeature::ExactBenchmark) => Err("unsupported: this adapter provides no exact tokenizer and cold-cache benchmark procedures".into()),
        (RuntimeKind::ExternalProcess, RuntimeFeature::DeepVerification) => Err("unsupported: this adapter provides no device/reference comparison for deep verification".into()),
        (RuntimeKind::ExternalProcess, RuntimeFeature::Portable) => Err("unsupported: this external process adapter provides no portable dependency/ABI bundle".into()),
        _ => Ok(()),
    }
}
