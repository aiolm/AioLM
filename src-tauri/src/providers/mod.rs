//! Inference engine providers.
//!
//! Every execution path selects, in this order, a runtime (engine, server
//! provider, version, accelerator and installation), a profile that belongs to
//! that provider, a model the runtime can load, and the options that provider
//! supports. This module owns the contracts for those selections and is the
//! authority the UI, CLI, gateway and benchmark consult; nothing outside it
//! decides that a model, option or input modality works with an engine.
//!
//! Responsibilities stay separated:
//! - `python_env`: installation and discovery of Python-based engines.
//! - `launch`: process command lines and readiness endpoints.
//! - `options`: option schemas, validation and command import.
//! - `compat`: model artifact inspection and load compatibility.
//! - `protocol`: OpenAI-compatible request/response adaptation.
//!
//! llama.cpp keeps its established implementation in `runtime`, `server` and
//! `config`; the llama adapter here only describes it in the shared contracts.
use serde::{Deserialize, Serialize};

pub mod adapter;
pub mod adapter_setup;
pub mod artifacts;
pub mod catalog_data;
pub mod compat;
pub mod execution;
pub mod execution_context;
pub mod launch;
pub mod launch_resources;
pub mod metal_env;
pub mod metal_media;
pub mod options;
pub mod portable;
pub mod protocol;
pub mod python_env;
pub mod registry;
pub mod runtime_command;
pub mod runtime_help;
pub mod runtime_help_parse;
pub mod runtime_help_store;
pub mod runtime_metadata;
pub mod runtime_options;
pub mod runtime_ordered;
pub mod runtime_positional;
pub mod runtime_schema;
pub use resolve_python_runtime as selected_python_runtime;

/// The serving implementation behind a runtime. The wire spelling is stable
/// and persisted in configuration, profiles and benchmark records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProviderId {
    Llama,
    Vllm,
    MlxVlm,
    Custom(ExternalEngineId),
}

/// Bounded opaque identifiers keep selection inexpensive to copy. Only the
/// three established wire IDs are reserved; external IDs use `custom.*`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ExternalEngineId([u8; 64]);

impl Serialize for ProviderId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ProviderId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom("invalid inference engine ID"))
    }
}

pub const LLAMA_PROVIDER: &str = "llama.cpp";

impl ProviderId {
    pub const ALL: [ProviderId; 3] = [ProviderId::Llama, ProviderId::Vllm, ProviderId::MlxVlm];

    pub fn as_str(&self) -> &str {
        match self {
            Self::Llama => LLAMA_PROVIDER,
            Self::Vllm => "vllm",
            Self::MlxVlm => "mlx-vlm",
            Self::Custom(id) => {
                let end =
                    id.0.iter()
                        .position(|byte| *byte == 0)
                        .unwrap_or(id.0.len());
                std::str::from_utf8(&id.0[..end]).expect("external engine IDs are ASCII")
            }
        }
    }

    /// Configuration written before providers existed has no provider; it
    /// always described llama.cpp.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "" | LLAMA_PROVIDER => Some(Self::Llama),
            "vllm" => Some(Self::Vllm),
            "mlx-vlm" => Some(Self::MlxVlm),
            id if id.starts_with("custom.")
                && id.len() > 7
                && id.len() <= 64
                && id.as_bytes()[7].is_ascii_alphanumeric()
                && id.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                }) =>
            {
                let mut bytes = [0; 64];
                bytes[..id.len()].copy_from_slice(id.as_bytes());
                Some(Self::Custom(ExternalEngineId(bytes)))
            }
            _ => None,
        }
    }

    pub fn engine(self) -> &'static str {
        match self {
            Self::Llama => "llama.cpp",
            Self::Vllm => "vllm",
            Self::MlxVlm => "mlx",
            Self::Custom(_) => "external",
        }
    }

    pub fn server(self) -> &'static str {
        match self {
            Self::Llama => "llama-server",
            Self::Vllm => "vllm",
            Self::MlxVlm => "mlx-vlm",
            Self::Custom(_) => "external engine",
        }
    }

    pub fn is_python(self) -> bool {
        matches!(self, Self::Vllm | Self::MlxVlm)
    }

    pub fn is_custom(self) -> bool {
        matches!(self, Self::Custom(_))
    }

    pub fn availability(self) -> Availability {
        availability_for_with_macos(
            self,
            std::env::consts::OS,
            std::env::consts::ARCH,
            &host_macos_version(),
        )
    }
}

/// Whether a provider can run on this host at all. Independent of whether a
/// runtime is installed; that is readiness, reported separately.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Availability {
    pub supported: bool,
    /// Stable reason code the UI localizes; absent when supported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub detail: String,
}

/// A versionless macOS check cannot establish Metal eligibility. Production
/// callers use the host OS version; tests can supply it without executing tools.
pub fn availability_for(provider: ProviderId, os: &str, arch: &str) -> Availability {
    availability_for_with_macos(provider, os, arch, "")
}

pub fn availability_for_with_macos(
    provider: ProviderId,
    os: &str,
    arch: &str,
    macos_version: &str,
) -> Availability {
    match provider {
        ProviderId::Custom(_) => registry::availability(provider, os, arch),
        ProviderId::Llama => Availability {
            supported: true,
            reason: None,
            detail: String::new(),
        },
        ProviderId::Vllm if os == "linux" => Availability {
            supported: true,
            reason: None,
            detail: String::new(),
        },
        ProviderId::Vllm if metal_env::eligible(os, arch, macos_version) => Availability {
            supported: true,
            reason: None,
            detail: metal_env::REQUIREMENTS.into(),
        },
        ProviderId::Vllm if os == "macos" => Availability {
            supported: false,
            reason: Some("vllm-metal-requirements"),
            detail: format!("{} This host is {os}/{arch}, macOS {macos_version}.", metal_env::REQUIREMENTS),
        },
        ProviderId::Vllm => Availability {
            supported: false,
            reason: Some("vllm-linux-only"),
            detail: format!(
                "vLLM runtimes require Linux or Apple Silicon macOS 15 or later with vllm-metal; this host is {os}/{arch}. Windows-native vLLM and WSL2 are not managed by AioLM."
            ),
        },
        ProviderId::MlxVlm if os == "macos" && arch == "aarch64" => Availability {
            supported: true,
            reason: None,
            detail: String::new(),
        },
        ProviderId::MlxVlm => Availability {
            supported: false,
            reason: Some("mlx-apple-silicon-only"),
            detail: format!(
                "MLX runtimes (mlx-vlm) are supported on Apple Silicon macOS only; this host is {os}/{arch}."
            ),
        },
    }
}

/// Product version, rather than Darwin's kernel version. The command is fixed,
/// bounded and read-only; an unreadable version conservatively disables Metal.
pub fn host_macos_version() -> String {
    #[cfg(target_os = "macos")]
    {
        static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        VERSION
            .get_or_init(|| {
                let mut command = crate::procutil::std_command("/usr/bin/sw_vers");
                command.arg("-productVersion");
                crate::procutil::capture_stdout_cancellable(
                    &mut command,
                    std::time::Duration::from_secs(5),
                    256,
                    None,
                )
                .ok()
                .filter(|out| out.status.success())
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
                .unwrap_or_default()
            })
            .clone()
    }
    #[cfg(not(target_os = "macos"))]
    String::new()
}

/// One installed or registered runtime, described identically for every
/// provider. llama.cpp runtimes keep their `(backend, build)` identity.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeInstance {
    pub provider: ProviderId,
    /// Stable id within the provider. llama.cpp: `<build>-<backend>`.
    pub id: String,
    pub engine: &'static str,
    pub server: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_version: Option<String>,
    /// Compute backend, e.g. `cuda`, `vulkan`, `rocm`, `cpu`, `metal`; empty
    /// when it has not been probed.
    pub accelerator: String,
    /// `managed` (installed and owned by AioLM) or `external` (an existing
    /// installation the user selected).
    pub installation: &'static str,
    pub location: String,
    pub available: bool,
    pub problems: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    /// Server flags the installed engine reported when it was probed; absent
    /// when unknown. Options whose flags are missing here cannot launch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_flags: Option<Vec<String>>,
}

/// The selection every execution entrypoint resolves before anything else.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ExecutionSelection {
    pub provider: ProviderId,
    /// Runtime id within the provider; empty when none is selected.
    pub runtime_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

/// Config validation rejects invalid IDs. A missing external registration is
/// still an external selection, never an implicit switch to llama.cpp.
pub fn provider_of(cfg: &crate::config::AppConfig) -> ProviderId {
    ProviderId::parse(&cfg.active_provider).unwrap_or(ProviderId::Llama)
}

/// The command line the selected runtime would launch with, for display.
/// The app key is never included, and values the runtime's schema marks
/// secret are replaced; the launch itself uses them unchanged.
pub fn command_preview(cfg: &crate::config::AppConfig) -> Result<Vec<String>, String> {
    let plan =
        adapter::resolve(cfg).launch(cfg, cfg.port, "", &crate::gpu::ResolvedGpu::default())?;
    let argv = launch::preview(&plan);
    Ok(runtime_schema::mask_argv(
        &registry::root(),
        cfg,
        argv,
        runtime_schema::REDACTED,
    ))
}

/// The runtime id a configuration selects for its provider.
pub fn runtime_id_of(cfg: &crate::config::AppConfig) -> String {
    adapter::resolve(cfg).runtime_id(cfg)
}

pub fn selection_of(cfg: &crate::config::AppConfig) -> ExecutionSelection {
    ExecutionSelection {
        provider: provider_of(cfg),
        runtime_id: runtime_id_of(cfg),
        model: cfg.active_model.clone(),
        profile_id: None,
    }
}

fn llama_runtime_instances(
    runtimes: Vec<crate::runtime::InstalledRuntimeMetadata>,
) -> Vec<RuntimeInstance> {
    runtimes
        .into_iter()
        .map(|runtime| RuntimeInstance {
            provider: ProviderId::Llama,
            id: format!("{}-{}", runtime.build, runtime.backend),
            engine: ProviderId::Llama.engine(),
            server: ProviderId::Llama.server(),
            version: runtime
                .version
                .as_ref()
                .map(|version| format!("b{} ({})", version.build, version.commit)),
            accelerator: runtime.backend.clone(),
            variant: None,
            plugin_version: None,
            installation: "managed",
            location: runtime.dir,
            available: true,
            problems: Vec::new(),
            backend: Some(runtime.backend),
            build: Some(runtime.build),
            server_flags: None,
        })
        .collect()
}

/// Every runtime the app can offer, llama.cpp first, in a stable order.
pub fn list_runtime_instances() -> Vec<RuntimeInstance> {
    let mut instances = llama_runtime_instances(crate::runtime::list_installed_metadata());
    for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
        instances.extend(python_env::list(provider).into_iter().map(|manifest| {
            let availability = provider.availability();
            let mut problems = manifest.problems();
            if !availability.supported {
                problems.insert(0, availability.detail.clone());
            }
            RuntimeInstance {
                provider,
                id: manifest.id.clone(),
                engine: provider.engine(),
                server: provider.server(),
                version: manifest.probe.as_ref().map(|probe| probe.version.clone()),
                variant: manifest
                    .probe
                    .as_ref()
                    .filter(|probe| !probe.variant.is_empty())
                    .map(|probe| probe.variant.clone()),
                plugin_version: manifest
                    .probe
                    .as_ref()
                    .filter(|probe| !probe.metal_version.is_empty())
                    .map(|probe| probe.metal_version.clone()),
                accelerator: manifest
                    .probe
                    .as_ref()
                    .map(|probe| probe.accelerator.clone())
                    .unwrap_or_default(),
                installation: manifest.kind.as_str(),
                location: manifest.python.clone(),
                available: problems.is_empty(),
                problems,
                backend: None,
                build: None,
                server_flags: manifest
                    .probe
                    .as_ref()
                    .map(|probe| probe.server_flags.clone())
                    .filter(|flags| !flags.is_empty()),
            }
        }));
    }
    instances.extend(registry::runtime_instances());
    instances
}

/// Resolve the selected runtime for a non-llama provider. llama.cpp keeps its
/// `(backend, build)` resolution in `server::server_bin`.
/// This reads the last probe; launch and measurement entry points refresh it
/// once before using compatibility, option schemas or verification keys.
pub fn resolve_python_runtime(
    cfg: &crate::config::AppConfig,
) -> Result<python_env::PythonRuntimeManifest, String> {
    let provider = provider_of(cfg);
    if !provider.is_python() {
        return Err("the selected provider does not use a Python runtime".into());
    }
    let availability = provider.availability();
    if !availability.supported {
        return Err(availability.detail);
    }
    if cfg.active_runtime.trim().is_empty() {
        return Err(format!(
            "select a {} runtime before starting the server",
            provider.server()
        ));
    }
    let manifest = python_env::read(provider, &cfg.active_runtime)?;
    let problems = manifest.problems();
    if !problems.is_empty() {
        return Err(format!(
            "the selected {} runtime is not ready: {}",
            provider.server(),
            problems.join("; ")
        ));
    }
    Ok(manifest)
}

/// Refresh the selected interpreter's installed packages before an operation
/// uses their capabilities or identity. Failed readiness is persisted too, so
/// a formerly healthy registration cannot remain healthy after a package change.
pub async fn refresh_selected_python_runtime(
    cfg: &crate::config::AppConfig,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<python_env::PythonRuntimeManifest, String> {
    let provider = provider_of(cfg);
    if !provider.is_python() {
        return Err("the selected provider does not use a Python runtime".into());
    }
    let availability = provider.availability();
    if !availability.supported {
        return Err(availability.detail);
    }
    if cfg.active_runtime.trim().is_empty() {
        return Err(format!(
            "select a {} runtime before starting the server",
            provider.server()
        ));
    }
    python_env::reprobe_cancellable(provider, &cfg.active_runtime, cancel).await?;
    resolve_python_runtime(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_runtime_projection_preserves_filters_manifest_precedence_and_fresh_edits() {
        use crate::runtime::{
            bench_executable_name, list_installed_metadata_in,
            listing_fixture::{assert_json, Fixture},
            server_executable_name,
        };
        use serde_json::json;
        let mut fixture = Fixture::new();
        for name in [
            "b10-cpu",
            "b9-future-backend",
            "b9-cuda",
            "b9-cpu",
            "b11-cpu",
            "invalid-cpu",
            "nohyphen",
        ] {
            fixture.write(&format!("{name}/{}", server_executable_name()), b"s");
            fixture.write(&format!("{name}/{}", bench_executable_name()), b"b");
        }
        fixture.write(&format!("b3-cpu/{}", server_executable_name()), b"s");
        fixture.write(&format!("b2-cpu/{}", bench_executable_name()), b"b");
        fixture.write("b1-cpu", b"not a directory");
        let current = br#"{"semver":"current","build":9,"commit":"current"}"#;
        let legacy = br#"{"semver":"legacy","build":2,"commit":"legacy"}"#;
        fixture.write("b9-cpu/aiolm-runtime.json", current);
        fixture.write("b9-cpu/llama-board-runtime.json", legacy);
        fixture.write("b9-cuda/llama-board-runtime.json", legacy);
        fixture.write("b10-cpu/aiolm-runtime.json", b"{bad");
        fixture.write("b10-cpu/llama-board-runtime.json", legacy);
        fixture.directory("b11-cpu/aiolm-runtime.json");
        fixture.write("b11-cpu/llama-board-runtime.json", legacy);
        fixture.write("b9-cpu/aiolm-runtime-source.json", br#"{"pull_request":7,"repository":"synthetic/runtime","commit":"abc","archive_sha256":"fixture","url":"synthetic"}"#);
        fixture.write("b9-cuda/llama-board-runtime-source.json", b"{bad");
        let expected_entry = |id: &str, build: &str, backend: &str, version: Option<&str>| {
            let mut entry = json!({"provider":"llama.cpp","id":id,"engine":"llama.cpp","server":"llama-server","accelerator":backend,"installation":"managed","location":fixture.root.join(id).to_str().unwrap(),"available":true,"problems":[],"backend":backend,"build":build});
            if let Some(version) = version {
                entry["version"] = json!(version);
            }
            entry
        };
        let mut expected = json!([
            expected_entry("b9-cpu", "b9", "cpu", Some("b9 (current)")),
            expected_entry("b9-cuda", "b9", "cuda", Some("b2 (legacy)")),
            expected_entry("b9-future-backend", "b9", "future-backend", None),
            expected_entry("b11-cpu", "b11", "cpu", None),
            expected_entry("b10-cpu", "b10", "cpu", None)
        ]);
        let read = |root: &std::path::Path| {
            serde_json::to_value(llama_runtime_instances(list_installed_metadata_in(root))).unwrap()
        };
        assert_json(
            "managed initial filters and precedence",
            read(&fixture.root),
            expected.clone(),
        );
        assert_json(
            "managed missing root",
            read(&fixture.root.join("absent")),
            json!([]),
        );
        fixture.write(
            "b9-cpu/aiolm-runtime.json",
            br#"{"semver":"edited","build":12,"commit":"fresh"}"#,
        );
        expected[0]["version"] = json!("b12 (fresh)");
        fixture.remove_file("b10-cpu/aiolm-runtime.json");
        expected[4]["version"] = json!("b2 (legacy)");
        fixture.remove_file(&format!("b9-future-backend/{}", bench_executable_name()));
        expected.as_array_mut().unwrap().remove(2);
        assert_json(
            "managed fresh manifest and executable edits",
            read(&fixture.root),
            expected,
        );
        fixture.finish();
    }

    #[test]
    fn provider_spellings_round_trip_and_legacy_empty_means_llama() {
        for provider in ProviderId::ALL {
            assert_eq!(ProviderId::parse(provider.as_str()), Some(provider));
            let json = serde_json::to_string(&provider).unwrap();
            assert_eq!(json, format!("\"{}\"", provider.as_str()));
            assert_eq!(serde_json::from_str::<ProviderId>(&json).unwrap(), provider);
        }
        assert_eq!(ProviderId::parse(""), Some(ProviderId::Llama));
        assert_eq!(ProviderId::parse("mlx-lm"), None);
        assert_eq!(ProviderId::parse("vllm-metal"), None);
    }

    #[test]
    fn availability_follows_first_supported_deployments() {
        for (os, arch) in [
            ("windows", "x86_64"),
            ("linux", "x86_64"),
            ("macos", "aarch64"),
            ("macos", "x86_64"),
        ] {
            assert!(availability_for(ProviderId::Llama, os, arch).supported);
        }
        assert!(availability_for(ProviderId::Vllm, "linux", "x86_64").supported);
        assert!(availability_for(ProviderId::Vllm, "linux", "aarch64").supported);
        let windows = availability_for(ProviderId::Vllm, "windows", "x86_64");
        assert!(!windows.supported);
        assert_eq!(windows.reason, Some("vllm-linux-only"));
        assert!(!availability_for(ProviderId::Vllm, "macos", "aarch64").supported);
        assert!(availability_for(ProviderId::MlxVlm, "macos", "aarch64").supported);
        let intel = availability_for(ProviderId::MlxVlm, "macos", "x86_64");
        assert_eq!(intel.reason, Some("mlx-apple-silicon-only"));
        assert!(!availability_for(ProviderId::MlxVlm, "linux", "x86_64").supported);
    }

    #[test]
    fn selection_uses_the_llama_runtime_pair_or_the_provider_runtime_id() {
        let mut cfg = crate::config::AppConfig {
            active_backend: "cuda".into(),
            active_build: "b5000".into(),
            active_model: "model.gguf".into(),
            ..Default::default()
        };
        let selection = selection_of(&cfg);
        assert_eq!(selection.provider, ProviderId::Llama);
        assert_eq!(selection.runtime_id, "b5000-cuda");
        cfg.active_provider = "vllm".into();
        cfg.active_runtime = "managed-0-31-0".into();
        let selection = selection_of(&cfg);
        assert_eq!(selection.provider, ProviderId::Vllm);
        assert_eq!(selection.runtime_id, "managed-0-31-0");
    }

    #[test]
    fn vllm_macos_availability_reports_metal_requirements_without_a_fourth_provider() {
        let eligible = availability_for_with_macos(ProviderId::Vllm, "macos", "aarch64", "15.0");
        assert!(eligible.supported);
        assert!(eligible.detail.contains("CPython 3.12"));
        assert!(eligible.detail.contains("0.30.0"));
        for (os, arch, version) in [
            ("macos", "aarch64", "14.9"),
            ("macos", "x86_64", "15.0"),
            ("windows", "aarch64", "15.0"),
            ("windows", "x86_64", "15.0"),
        ] {
            assert!(!availability_for_with_macos(ProviderId::Vllm, os, arch, version).supported);
        }
        assert!(availability_for_with_macos(ProviderId::Vllm, "linux", "aarch64", "").supported);
        assert_eq!(ProviderId::ALL.len(), 3);
        assert_eq!(ProviderId::parse("vllm-metal"), None);
    }
}
