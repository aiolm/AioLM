//! Installation, registration and probing of Python-based engine runtimes.
//!
//! A runtime is either *managed* - an isolated virtual environment AioLM
//! created and owns under its runtimes folder - or *external* - an existing
//! interpreter the user explicitly selected. Nothing here ever runs `pip`
//! against an interpreter AioLM does not own, and a removal of an external
//! runtime forgets the registration without touching the environment.
//!
//! The package versions offered for managed installs are the ones whose
//! command line and HTTP protocol were checked against upstream source:
//! Linux vLLM v0.31.0, macOS vllm-metal v0.30.0 with matching vLLM core,
//! and mlx-vlm v0.7.6. Standard engines accept other installed versions once
//! probed; Metal additionally enforces the checked plugin/core and native ABI.
use super::{metal_env, ProviderId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub(crate) const MANIFEST: &str = "aiolm-provider-runtime.json";
pub(crate) const MANIFEST_FORMAT: u32 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(180);
const PROBE_OUTPUT_CAP: usize = 1024 * 1024;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(3 * 60 * 60);
const MAX_ID_LEN: usize = 64;

pub const VLLM_PINNED_VERSION: &str = "0.31.0";
pub const MLX_VLM_PINNED_VERSION: &str = "0.7.6";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallationKind {
    Managed,
    External,
}

impl InstallationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::External => "external",
        }
    }
}

/// What a probe of the installed package reported. Every list comes from the
/// installed version itself; none of it is inferred from the package name.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct ProbeRecord {
    pub version: String,
    /// Empty in pre-variant manifests; equivalent to `standard`.
    pub variant: String,
    pub metal_version: String,
    pub python_version: String,
    pub python_arch: String,
    pub python_implementation: String,
    pub python_abi: String,
    pub platform_system: String,
    pub macos_version: String,
    pub platform_class: String,
    pub imported_version: String,
    pub imported_metal_version: String,
    pub mlx_version: String,
    pub metal_available: bool,
    pub metal_native_importable: bool,
    pub package_versions: BTreeMap<String, String>,
    pub metal_model_types: Vec<String>,
    pub metal_embedding_model_types: Vec<String>,
    pub metal_multimodal_model_types: Vec<String>,
    pub metal_transcription_model_types: Vec<String>,
    pub metal_translation_model_types: Vec<String>,
    pub metal_transcription_scan: u32,
    pub metal_stt_extras: bool,
    pub metal_ffmpeg: bool,
    /// Installed loader scan; 0 means no Metal capability evidence.
    pub metal_registry_scan: u32,
    pub metal_gguf: bool,
    /// `cuda`, `rocm`, `cpu`, `xpu`, `metal`, ... as the engine reports it.
    pub accelerator: String,
    /// vLLM: `ModelRegistry.get_supported_archs()`.
    pub architectures: Vec<String>,
    pub generation_architectures: Vec<String>,
    pub embedding_architectures: Vec<String>,
    pub multimodal_architectures: Vec<String>,
    pub transcription_architectures: Vec<String>,
    pub transcription_only_architectures: Vec<String>,
    pub translation_architectures: Vec<String>,
    pub transcription_scan: u32,
    /// mlx-vlm: `mlx_vlm.models` package names.
    pub model_types: Vec<String>,
    /// mlx-vlm: `mlx_vlm.utils.MODEL_REMAPPING`.
    pub model_type_aliases: BTreeMap<String, String>,
    pub embedding_model_type_aliases: BTreeMap<String, String>,
    /// mlx-vlm: packages whose `config.py` declares an audio configuration.
    pub audio_model_types: Vec<String>,
    /// mlx-vlm: packages whose sources use `pooling.EmbeddingOutput`.
    pub embedding_model_types: Vec<String>,
    /// mlx-vlm: packages that set `is_image_generation_model = True`.
    pub image_generation_model_types: Vec<String>,
    /// Version of the source scan that filled the three lists above; 0 when
    /// the record predates it, in which case those lists say nothing. Saved
    /// with the manifest so the lists keep their meaning after a reload.
    pub package_scan: u32,
    pub server_flags: Vec<String>,
    pub errors: Vec<String>,
    pub probed_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PythonRuntimeManifest {
    pub format: u32,
    pub provider: ProviderId,
    pub id: String,
    pub kind: InstallationKind,
    /// Interpreter that runs the engine. Managed: the venv interpreter.
    pub python: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<ProbeRecord>,
}

impl PythonRuntimeManifest {
    /// Reasons this runtime cannot be launched as it stands. Missing files and
    /// failed probes are readiness problems, never compatibility verdicts.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if !Path::new(&self.python).is_file() {
            problems.push(format!("Python interpreter is missing: {}", self.python));
        }
        match &self.probe {
            None => problems.push("the runtime has not been probed yet".into()),
            Some(probe) if probe.version.is_empty() => problems.push(format!(
                "{} is not importable from this interpreter{}",
                package_name(self.provider),
                probe
                    .errors
                    .first()
                    .map(|error| format!(": {error}"))
                    .unwrap_or_default()
            )),
            Some(probe) => {
                problems.extend(probe.errors.iter().cloned());
                if self.provider == ProviderId::Vllm {
                    problems.extend(metal_env::probe_problems(probe));
                    if probe.variant == metal_env::VARIANT
                        && !metal_env::eligible(
                            std::env::consts::OS,
                            std::env::consts::ARCH,
                            &super::host_macos_version(),
                        )
                    {
                        problems.push(metal_env::REQUIREMENTS.into());
                    }
                    if cfg!(target_os = "macos") && probe.variant != metal_env::VARIANT {
                        problems.push("macOS vLLM requires a probed vllm-metal runtime".into());
                    }
                }
            }
        }
        problems
    }
}

pub fn package_name(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Vllm => "vllm",
        ProviderId::MlxVlm => "mlx-vlm",
        ProviderId::Llama => "llama.cpp",
    }
}

pub fn pinned_version(provider: ProviderId) -> Option<&'static str> {
    match provider {
        ProviderId::Vllm if managed_metal(provider) => Some(metal_env::VERSION),
        ProviderId::Vllm => Some(VLLM_PINNED_VERSION),
        ProviderId::MlxVlm => Some(MLX_VLM_PINNED_VERSION),
        ProviderId::Llama => None,
    }
}

fn managed_metal(provider: ProviderId) -> bool {
    provider == ProviderId::Vllm && cfg!(target_os = "macos")
}

pub fn providers_root() -> PathBuf {
    crate::runtime::runtimes_root().join("providers")
}

fn provider_root(provider: ProviderId) -> PathBuf {
    providers_root().join(provider.as_str())
}

pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_ID_LEN
        || !id
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-')
        || id.starts_with('-')
    {
        return Err(format!("invalid runtime id: {id}"));
    }
    Ok(())
}

fn runtime_dir(provider: ProviderId, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(provider_root(provider).join(id))
}

pub fn managed_id(version: &str) -> String {
    let slug = version
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() {
                value.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let mut id = format!("managed-{}", slug.trim_matches('-'));
    id.truncate(MAX_ID_LEN);
    id
}

pub fn managed_variant_id(version: &str, variant: &str) -> String {
    if variant == metal_env::VARIANT {
        format!("managed-vllm-metal-{}", version.replace('.', "-"))
    } else {
        managed_id(version)
    }
}

/// External ids are derived from the interpreter path so registering the same
/// interpreter twice updates one entry instead of duplicating it.
pub fn external_id(python: &Path) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(python.to_string_lossy().as_bytes());
    format!("external-{:x}", hash)[..57].to_owned()
}

pub fn read(provider: ProviderId, id: &str) -> Result<PythonRuntimeManifest, String> {
    let path = runtime_dir(provider, id)?.join(MANIFEST);
    let raw = fs::read_to_string(&path).map_err(|error| {
        format!(
            "{} runtime '{id}' is not installed ({error})",
            provider.server()
        )
    })?;
    let manifest: PythonRuntimeManifest = serde_json::from_str(&raw)
        .map_err(|error| format!("runtime manifest {} is invalid: {error}", path.display()))?;
    if manifest.provider != provider || manifest.id != id || manifest.format != MANIFEST_FORMAT {
        return Err(format!(
            "runtime manifest {} does not describe {} runtime '{id}'",
            path.display(),
            provider.server()
        ));
    }
    Ok(manifest)
}

fn write(manifest: &PythonRuntimeManifest, dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    crate::config::atomic_write(&dir.join(MANIFEST), &bytes)
}

pub fn list(provider: ProviderId) -> Vec<PythonRuntimeManifest> {
    let Ok(entries) = fs::read_dir(provider_root(provider)) else {
        return Vec::new();
    };
    let mut out = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            validate_id(&id).ok()?;
            read(provider, &id).ok()
        })
        .collect::<Vec<_>>();
    out.sort_by(|left, right| left.id.cmp(&right.id));
    out
}

fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// The environment a Python engine process receives: the same cleared base as
/// llama.cpp runtimes, never the user's whole shell environment.
pub fn engine_environment() -> Vec<(OsString, OsString)> {
    engine_environment_from(crate::runtime::child_environment())
}

fn engine_environment_from(
    mut environment: Vec<(OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    // Keep plugin selection and Metal execution defaults under app control.
    // Prefix filtering also protects this contract if the base allowlist grows.
    environment.retain(|(key, _)| {
        let key = key.to_string_lossy().to_ascii_uppercase();
        !key.starts_with("VLLM_") && !key.starts_with("MLX_")
    });
    for name in [
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PIP_REQUIRE_VIRTUALENV",
    ] {
        environment.retain(|(key, _)| key != name);
    }
    // Hugging Face downloads by an engine would bypass the app's own model
    // management; models are always given as local directories instead.
    environment.push(("HF_HUB_OFFLINE".into(), "1".into()));
    environment.push(("TRANSFORMERS_OFFLINE".into(), "1".into()));
    environment.push(("PYTHONUNBUFFERED".into(), "1".into()));
    environment
}

fn interpreter_flags(kind: InstallationKind) -> &'static [&'static str] {
    // A managed venv is fully isolated. An external interpreter keeps its own
    // site configuration, which is how the user installed the engine into it.
    match kind {
        InstallationKind::Managed => &["-I"],
        InstallationKind::External => &[],
    }
}

const VLLM_PROBE: &str = include_str!("vllm_probe.py");

const MLX_VLM_PROBE: &str = r#"
import json, sys, pkgutil, platform, sysconfig, importlib.metadata as m
out = {"python_version": "%d.%d.%d" % sys.version_info[:3], "errors": [],
       "python_arch": platform.machine(), "python_implementation": platform.python_implementation(),
       "python_abi": sysconfig.get_config_var("SOABI") or "", "package_versions": {},
       "platform_system": platform.system(), "macos_version": platform.mac_ver()[0]}
for name in ("mlx-vlm", "mlx", "mlx-lm", "transformers", "tokenizers", "safetensors"):
    try:
        out["package_versions"][name] = m.version(name)
    except m.PackageNotFoundError:
        pass
try:
    out["version"] = m.version("mlx-vlm")
except Exception as e:
    out["errors"].append("mlx-vlm: %s" % e)
if out.get("version"):
    try:
        import mlx_vlm.models as models
        out["model_types"] = sorted(n for _, n, p in pkgutil.iter_modules(models.__path__) if p)
        # Package sources are read as text, never imported: a model package
        # is only executed when mlx-vlm loads that model.
        import os, re
        root = models.__path__[0]
        def sources(name):
            base = os.path.join(root, name)
            for directory, _, files in os.walk(base):
                for file in sorted(files):
                    if file.endswith(".py"):
                        path = os.path.join(directory, file)
                        try:
                            with open(path, encoding="utf-8", errors="replace") as f:
                                yield os.path.relpath(path, base).replace(os.sep, "/"), f.read(4194304)
                        except OSError:
                            pass
        image_generation = re.compile(r"is_image_generation_model\s*(?::\s*ClassVar\[bool\]\s*)?=\s*True")
        out["audio_model_types"], out["embedding_model_types"], out["image_generation_model_types"] = [], [], []
        for n in out["model_types"]:
            texts = list(sources(n))
            if any(f == "config.py" and ("AudioConfig" in t or "audio_config" in t) for f, t in texts):
                out["audio_model_types"].append(n)
            if any("EmbeddingOutput" in t for _, t in texts):
                out["embedding_model_types"].append(n)
            if any(image_generation.search(t) for _, t in texts):
                out["image_generation_model_types"].append(n)
        out["package_scan"] = 1
    except Exception as e:
        out["errors"].append("models: %s" % e)
    try:
        from mlx_vlm.utils import MODEL_REMAPPING
        out["model_type_aliases"] = {str(k): str(v) for k, v in MODEL_REMAPPING.items()}
        from mlx_vlm.embedding_loader import EMBEDDING_MODEL_REMAPPING
        out["embedding_model_type_aliases"] = {str(k): str(v) for k, v in EMBEDDING_MODEL_REMAPPING.items()}
    except Exception as e:
        out["errors"].append("remapping: %s" % e)
    try:
        import mlx.core as mx
        out["mlx_version"] = m.version("mlx")
        out["accelerator"] = "metal" if mx.metal.is_available() else str(mx.default_device())
    except Exception as e:
        out["errors"].append("mlx: %s" % e)
print("AIOLM_PROBE=" + json.dumps(out))
"#;

fn probe_script(provider: ProviderId) -> String {
    match provider {
        ProviderId::Vllm => format!(
            "{}\n{VLLM_PROBE}\n{}\n{}\nprint('AIOLM_PROBE=' + json.dumps(out))\n",
            include_str!("portable_source_probe.py"),
            include_str!("vllm_speech_capabilities.py"),
            include_str!("metal_capabilities.py")
        ),
        _ => MLX_VLM_PROBE.into(),
    }
}

/// Extract the probe record from interpreter output. Engines may print
/// warnings to stdout while importing; only the marked line is trusted.
pub fn parse_probe_output(stdout: &str) -> Result<ProbeRecord, String> {
    let line = stdout
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("AIOLM_PROBE="))
        .ok_or("the interpreter did not report a probe result")?;
    let mut record: ProbeRecord =
        serde_json::from_str(line).map_err(|error| format!("invalid probe result: {error}"))?;
    record.errors.truncate(16);
    for error in &mut record.errors {
        *error = error.chars().take(500).collect();
    }
    record.probed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    Ok(record)
}

pub async fn probe_interpreter(
    provider: ProviderId,
    python: &Path,
    kind: InstallationKind,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<ProbeRecord, String> {
    let python = python.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut command = crate::procutil::std_command(&python);
        command
            .env_clear()
            .envs(engine_environment())
            .args(interpreter_flags(kind))
            .arg("-B")
            .arg("-c")
            .arg(probe_script(provider));
        let output = crate::procutil::capture_stdout_cancellable(
            &mut command,
            PROBE_TIMEOUT,
            PROBE_OUTPUT_CAP,
            cancel.as_deref(),
        )
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::TimedOut => "runtime probe timed out".to_string(),
            std::io::ErrorKind::Interrupted => "runtime probe cancelled".to_string(),
            _ => crate::procutil::spawn_error(&python, &error),
        })?;
        let mut record = parse_probe_output(&String::from_utf8_lossy(&output.stdout))?;
        if !output.status.success() {
            record
                .errors
                .push("the interpreter probe exited unsuccessfully".into());
        }
        if provider == ProviderId::Vllm {
            let problems = metal_env::probe_problems(&record);
            record.errors.extend(problems);
        }
        if !record.version.is_empty() && record.errors.is_empty() {
            let mut help = crate::procutil::std_command(&python);
            help.env_clear()
                .envs(engine_environment())
                .args(interpreter_flags(kind));
            match provider {
                ProviderId::Vllm => {
                    help.args(["-m", "vllm.entrypoints.cli.main", "serve", "--help=all"]);
                }
                ProviderId::MlxVlm => {
                    help.args(["-m", "mlx_vlm.server", "--help"]);
                }
                ProviderId::Llama => return Err("llama.cpp uses its native runtime probe".into()),
            }
            let output = crate::procutil::capture_stdout_cancellable(
                &mut help,
                PROBE_TIMEOUT,
                PROBE_OUTPUT_CAP,
                cancel.as_deref(),
            )
            .map_err(|error| format!("server option probe failed: {error}"))?;
            if !output.status.success() {
                record.errors.push(
                    "the installed engine server could not report its supported options".into(),
                );
            }
            let text = String::from_utf8_lossy(&output.stdout);
            record.server_flags = text
                .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-')
                .filter(|word| word.starts_with("--") && word.len() > 2)
                .map(str::to_owned)
                .collect();
            record.server_flags.sort();
            record.server_flags.dedup();
            if record.server_flags.is_empty() {
                record
                    .errors
                    .push("the installed server did not report any supported options".into());
            }
        }
        Ok(record)
    })
    .await
    .map_err(|error| format!("runtime probe failed: {error}"))?
}

/// Re-probe a registered runtime and store what it reports now.
pub async fn reprobe(provider: ProviderId, id: &str) -> Result<PythonRuntimeManifest, String> {
    reprobe_cancellable(provider, id, None).await
}

pub async fn reprobe_cancellable(
    provider: ProviderId,
    id: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<PythonRuntimeManifest, String> {
    if let Some(cancel) = &cancel {
        ensure_not_cancelled(cancel)?;
    }
    let mut manifest = read(provider, id)?;
    let record = probe_interpreter(
        provider,
        Path::new(&manifest.python),
        manifest.kind,
        cancel.clone(),
    )
    .await?;
    if let Some(cancel) = &cancel {
        ensure_not_cancelled(cancel)?;
    }
    manifest.probe = Some(record);
    write(&manifest, &runtime_dir(provider, id)?)?;
    Ok(manifest)
}

/// Register an existing interpreter that already has the engine installed.
pub async fn register_external(
    provider: ProviderId,
    python: &Path,
) -> Result<PythonRuntimeManifest, String> {
    let availability = provider.availability();
    if !availability.supported {
        return Err(availability.detail);
    }
    // Resolving a venv's symlink changes sys.prefix to the base interpreter.
    // Keep the selected executable path for execution and registration.
    let python = std::path::absolute(python)
        .map_err(|error| format!("cannot open {}: {error}", python.display()))?;
    if !python.is_file() {
        return Err(format!("{} is not an interpreter file", python.display()));
    }
    let record = probe_interpreter(provider, &python, InstallationKind::External, None).await?;
    if provider == ProviderId::Vllm
        && (managed_metal(provider) || record.variant == metal_env::VARIANT)
    {
        let mut problems = record.errors.clone();
        problems.extend(metal_env::probe_problems(&record));
        if !problems.is_empty() {
            return Err(format!(
                "vllm-metal interpreter is not compatible: {}",
                problems.join("; ")
            ));
        }
    }
    if record.version.is_empty() {
        return Err(format!(
            "{} is not installed for {}{}",
            package_name(provider),
            python.display(),
            record
                .errors
                .first()
                .map(|error| format!(" ({error})"))
                .unwrap_or_default()
        ));
    }
    let id = if record.variant == metal_env::VARIANT {
        external_id(&python).replacen("external-", "external-metal-", 1)
    } else {
        external_id(&python)
    };
    let manifest = PythonRuntimeManifest {
        format: MANIFEST_FORMAT,
        provider,
        id: id.clone(),
        kind: InstallationKind::External,
        python: python.to_string_lossy().into_owned(),
        requested_version: None,
        probe: Some(record),
    };
    write(&manifest, &runtime_dir(provider, &id)?)?;
    Ok(manifest)
}

/// Remove a runtime. A managed runtime's directory is deleted; an external
/// runtime only loses its registration.
pub fn remove(provider: ProviderId, id: &str) -> Result<(), String> {
    let manifest = read(provider, id)?;
    let dir = runtime_dir(provider, id)?;
    remove_registration_at(&manifest, &dir)
}

fn remove_registration_at(manifest: &PythonRuntimeManifest, dir: &Path) -> Result<(), String> {
    match manifest.kind {
        InstallationKind::Managed => fs::remove_dir_all(dir)
            .map_err(|error| format!("failed to remove {}: {error}", dir.display())),
        InstallationKind::External => fs::remove_file(dir.join(MANIFEST))
            .and_then(|_| fs::remove_dir(dir))
            .map_err(|error| format!("failed to forget runtime {}: {error}", manifest.id)),
    }
}

/// General package Python ranges. Managed Metal's narrower cp312 wheel ABI is
/// additionally checked by `interpreter_provenance` before creating its venv.
pub fn python_supported(provider: ProviderId, major: u32, minor: u32) -> bool {
    match provider {
        // vLLM v0.31.0: ">=3.10,<3.15"
        ProviderId::Vllm => major == 3 && (10..15).contains(&minor),
        // mlx-vlm v0.7.6: ">=3.10"
        ProviderId::MlxVlm => major == 3 && minor >= 10,
        ProviderId::Llama => false,
    }
}

pub fn parse_python_version(text: &str) -> Option<(u32, u32)> {
    let version = text.trim().strip_prefix("Python ").unwrap_or(text.trim());
    let mut parts = version.split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next()?.trim().parse().ok()?;
    Some((major, minor))
}

fn python_version_of(python: &Path, cancel: Option<&AtomicBool>) -> Option<(u32, u32)> {
    let mut command = crate::procutil::std_command(python);
    command.env_clear().envs(engine_environment()).args([
        "-I",
        "-c",
        "import sys;print('%d.%d' % sys.version_info[:2])",
    ]);
    let output = crate::procutil::capture_stdout_cancellable(
        &mut command,
        Duration::from_secs(20),
        4096,
        cancel,
    )
    .ok()?;
    output
        .status
        .success()
        .then(|| parse_python_version(&String::from_utf8_lossy(&output.stdout)))
        .flatten()
}

fn interpreter_provenance(
    python: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<ProbeRecord, String> {
    let mut command = crate::procutil::std_command(python);
    command.env_clear().envs(engine_environment()).args([
        "-I", "-c",
        "import json,sys,sysconfig,platform;print('AIOLM_PROBE='+json.dumps(dict(python_version='.'.join(map(str,sys.version_info[:3])),python_arch=platform.machine(),python_implementation=platform.python_implementation(),python_abi=sysconfig.get_config_var('SOABI') or '',platform_system=platform.system(),macos_version=platform.mac_ver()[0])))",
    ]);
    let output = crate::procutil::capture_stdout_cancellable(
        &mut command,
        Duration::from_secs(20),
        4096,
        cancel,
    )
    .map_err(|error| format!("interpreter provenance check failed: {error}"))?;
    if !output.status.success() {
        return Err("interpreter provenance check failed".into());
    }
    parse_probe_output(&String::from_utf8_lossy(&output.stdout))
}

/// Base interpreters that can create a managed environment, best first.
pub fn discover_base_interpreters(provider: ProviderId) -> Vec<PathBuf> {
    discover_base_interpreters_with_cancel(provider, None)
}

fn discover_base_interpreters_with_cancel(
    provider: ProviderId,
    cancel: Option<&AtomicBool>,
) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for name in [
        "python3.13",
        "python3.12",
        "python3.11",
        "python3.10",
        "python3",
        "python",
    ] {
        if cancel.is_some_and(|cancel| cancel.load(Ordering::Acquire)) {
            break;
        }
        if let Ok(path) = which::which(name) {
            let path = path.canonicalize().unwrap_or(path);
            if found.contains(&path) {
                continue;
            }
            if managed_metal(provider) {
                if interpreter_provenance(&path, cancel)
                    .is_ok_and(|record| metal_env::interpreter_problems(&record).is_empty())
                {
                    found.push(path);
                }
                continue;
            }
            if python_version_of(&path, cancel)
                .is_some_and(|(major, minor)| python_supported(provider, major, minor))
            {
                found.push(path);
            }
        }
    }
    found
}

#[derive(Serialize, Clone, Debug)]
pub struct InstallProgress {
    pub provider: ProviderId,
    pub id: String,
    pub phase: &'static str,
    pub line: String,
}

/// Longest installer output line kept, in bytes; pip progress bars and
/// compiler output can emit very long lines without a newline.
const MAX_OUTPUT_LINE: usize = 4096;

/// Splits a byte stream into lines across read boundaries. A line longer than
/// `MAX_OUTPUT_LINE` is cut there and the rest of it is dropped, so memory
/// stays bounded however a child writes; `\r` progress redraws end a line.
#[derive(Default)]
struct LineSplitter {
    pending: Vec<u8>,
    truncated: bool,
}

impl LineSplitter {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for &byte in bytes {
            if byte == b'\n' || byte == b'\r' {
                if !self.pending.is_empty() || self.truncated {
                    lines.push(self.take());
                }
            } else if self.pending.len() < MAX_OUTPUT_LINE {
                self.pending.push(byte);
            } else {
                self.truncated = true;
            }
        }
        lines
    }

    fn finish(&mut self) -> Option<String> {
        (!self.pending.is_empty() || self.truncated).then(|| self.take())
    }

    fn take(&mut self) -> String {
        let mut line = String::from_utf8_lossy(&self.pending).into_owned();
        if std::mem::take(&mut self.truncated) {
            line.push_str(" [truncated]");
        }
        self.pending.clear();
        line
    }
}

async fn run_logged(
    program: &Path,
    args: &[&str],
    cancel: &Arc<AtomicBool>,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    ensure_not_cancelled(cancel)?;
    let mut command = crate::procutil::tokio_command(program);
    let mut environment = engine_environment();
    environment.retain(|(key, _)| key != "HF_HUB_OFFLINE" && key != "TRANSFORMERS_OFFLINE");
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            environment.push((name.into(), value));
        }
    }
    command
        .env_clear()
        .envs(environment)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = crate::procutil::TransientChild::spawn(&mut command)
        .map_err(|error| crate::procutil::spawn_error(program, &error))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<String>(32);
    for stream in [
        stdout.map(|value| Box::new(value) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        stderr.map(|value| Box::new(value) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let sender = sender.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut stream = stream;
            let mut buffer = [0u8; 8192];
            let mut lines = LineSplitter::default();
            while let Ok(count) = stream.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                for line in lines.push(&buffer[..count]) {
                    if sender.send(line).await.is_err() {
                        return;
                    }
                }
            }
            if let Some(line) = lines.finish() {
                let _ = sender.send(line).await;
            }
        });
    }
    drop(sender);
    let mut tail = std::collections::VecDeque::new();
    let remember = |line: String, tail: &mut std::collections::VecDeque<String>| {
        if tail.len() >= 40 {
            tail.pop_front();
        }
        tail.push_back(line);
    };
    let deadline = tokio::time::Instant::now() + INSTALL_TIMEOUT;
    let mut output_open = true;
    let status = loop {
        tokio::select! {
            // A closed channel answers immediately; stop polling it so the
            // loop waits on the child instead of spinning.
            line = receiver.recv(), if output_open => match line {
                Some(line) => {
                    remember(line.clone(), &mut tail);
                    progress(line);
                }
                None => output_open = false,
            },
            status = child.wait() => break status.map_err(|error| error.to_string())?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if cancel.load(Ordering::Acquire) {
                    child.terminate();
                    return Err("runtime installation cancelled".into());
                }
                if tokio::time::Instant::now() >= deadline {
                    child.terminate();
                    return Err("runtime installation timed out".into());
                }
            }
        }
    };
    // The process tree is gone once `wait` returns, so the readers reach end
    // of stream promptly; the bound only guards against a stuck pipe.
    let drain_until = tokio::time::Instant::now() + Duration::from_secs(2);
    while let Ok(Some(line)) = tokio::time::timeout_at(drain_until, receiver.recv()).await {
        remember(line, &mut tail);
    }
    if !status.success() {
        return Err(format!(
            "{} failed ({}): {}",
            program.display(),
            status
                .code()
                .map_or("signal".into(), |code| code.to_string()),
            tail.into_iter().collect::<Vec<_>>().join("\n")
        ));
    }
    ensure_not_cancelled(cancel)?;
    Ok(())
}

fn ensure_not_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("runtime installation cancelled".into())
    } else {
        Ok(())
    }
}

/// A direct matched-wheel plan, never a resolver lookup of vllm-metal on PyPI.
fn install_arguments(
    provider: ProviderId,
    version: &str,
    metal: bool,
    constraints: &Path,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "-I",
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if metal {
        if provider != ProviderId::Vllm || version != metal_env::VERSION {
            return Err(
                "managed vllm-metal installs require the pinned matched 0.30.0 release".into(),
            );
        }
        args.extend([
            "--constraint".into(),
            constraints.to_string_lossy().into_owned(),
            metal_env::CORE_WHEEL.into(),
            format!("vllm-metal[gguf,stt] @ {}", metal_env::PLUGIN_WHEEL),
        ]);
    } else {
        args.push(format!("{}=={version}", package_name(provider)));
    }
    Ok(args)
}

fn validate_installed_probe(
    provider: ProviderId,
    record: &ProbeRecord,
    metal: bool,
) -> Result<(), String> {
    let mut problems = record.errors.clone();
    if record.version.is_empty() {
        problems.push(format!(
            "{} did not import after installation",
            package_name(provider)
        ));
    }
    if metal {
        problems.extend(metal_env::probe_problems(record));
        if record.version != metal_env::CORE_VERSION {
            problems.push("managed vllm-metal requires the pinned CPU core wheel".into());
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "managed {} probe did not establish readiness: {}",
            package_name(provider),
            problems.join("; ")
        ))
    }
}

/// Create an isolated environment and install the pinned engine version into
/// it. Build at the permanent location: venv scripts embed absolute paths.
/// Publish the manifest only after a successful probe; every install gets a
/// unique identity so an existing environment is never replaced in use.
pub async fn install_managed(
    provider: ProviderId,
    base_python: Option<PathBuf>,
    version: Option<String>,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(InstallProgress) + Send,
) -> Result<PythonRuntimeManifest, String> {
    ensure_not_cancelled(&cancel)?;
    let availability = provider.availability();
    if !availability.supported {
        return Err(availability.detail);
    }
    let version = version
        .filter(|value| !value.trim().is_empty())
        .or_else(|| pinned_version(provider).map(str::to_owned))
        .ok_or("this provider has no managed installation")?;
    if !version
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || ".-+".contains(value))
        || version.len() > 32
    {
        return Err(format!("invalid package version: {version}"));
    }
    let metal = managed_metal(provider);
    if metal && version != metal_env::VERSION {
        return Err("managed vllm-metal installs require the pinned matched 0.30.0 release".into());
    }
    let base = match base_python {
        Some(path) => path,
        None => {
            let found = tokio::task::spawn_blocking({
                let cancel = cancel.clone();
                move || discover_base_interpreters_with_cancel(provider, Some(&cancel))
            })
            .await
            .map_err(|error| error.to_string())?;
            ensure_not_cancelled(&cancel)?;
            found
                .into_iter()
                .next()
                .ok_or("no supported Python 3 interpreter was found; select one explicitly")?
        }
    };
    let version_result = tokio::task::spawn_blocking({
        let base = base.clone();
        let cancel = cancel.clone();
        move || python_version_of(&base, Some(&cancel))
    })
    .await;
    ensure_not_cancelled(&cancel)?;
    let (major, minor) = version_result
        .ok()
        .flatten()
        .ok_or_else(|| format!("{} is not a usable Python interpreter", base.display()))?;
    if !python_supported(provider, major, minor) {
        return Err(format!(
            "{} requires a different Python version than {major}.{minor}",
            package_name(provider)
        ));
    }
    if metal {
        let provenance = tokio::task::spawn_blocking({
            let base = base.clone();
            let cancel = cancel.clone();
            move || interpreter_provenance(&base, Some(&cancel))
        })
        .await
        .map_err(|error| error.to_string())??;
        let problems = metal_env::interpreter_problems(&provenance);
        if !problems.is_empty() {
            return Err(problems.join("; "));
        }
    }
    ensure_not_cancelled(&cancel)?;
    let id = format!(
        "{}-{}",
        managed_variant_id(
            &version,
            if metal {
                metal_env::VARIANT
            } else {
                "standard"
            }
        ),
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let root = provider_root(provider);
    fs::create_dir_all(&root)
        .map_err(|error| format!("failed to create {}: {error}", root.display()))?;
    let target = root.join(&id);
    // Acquire ownership before arming cleanup; an existing directory is never
    // removed if identity allocation unexpectedly collides.
    fs::create_dir(&target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    let cleanup = StagingCleanup(target.clone());
    let venv = target.join("venv");
    let mut emit = |phase: &'static str, line: String| {
        progress(InstallProgress {
            provider,
            id: id.clone(),
            phase,
            line,
        })
    };
    emit(
        "environment",
        format!("creating environment with {}", base.display()),
    );
    let venv_arg = venv.to_string_lossy().into_owned();
    run_logged(&base, &["-I", "-m", "venv", &venv_arg], &cancel, |line| {
        emit("environment", line)
    })
    .await?;
    let python = venv_python(&venv);
    let constraints = target.join("metal-constraints.txt");
    if metal {
        fs::write(&constraints, metal_env::CONSTRAINTS).map_err(|error| error.to_string())?;
    }
    let install_args = install_arguments(provider, &version, metal, &constraints)?;
    emit(
        "packages",
        if metal {
            metal_env::REQUIREMENTS.into()
        } else {
            format!("installing {}=={version}", package_name(provider))
        },
    );
    let install_refs = install_args.iter().map(String::as_str).collect::<Vec<_>>();
    run_logged(&python, &install_refs, &cancel, |line| {
        emit("packages", line)
    })
    .await?;
    emit("probe", String::new());
    let record = probe_interpreter(
        provider,
        &python,
        InstallationKind::Managed,
        Some(cancel.clone()),
    )
    .await?;
    validate_installed_probe(provider, &record, metal)?;
    let manifest = PythonRuntimeManifest {
        format: MANIFEST_FORMAT,
        provider,
        id: id.clone(),
        kind: InstallationKind::Managed,
        python: venv_python(&target.join("venv"))
            .to_string_lossy()
            .into_owned(),
        requested_version: Some(version),
        probe: Some(record),
    };
    ensure_not_cancelled(&cancel)?;
    write(&manifest, &target)?;
    std::mem::forget(cleanup);
    emit("complete", String::new());
    Ok(manifest)
}

struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_installs_require_a_healthy_platform_and_server_option_probe() {
        for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
            let mut record = ProbeRecord {
                version: "synthetic".into(),
                ..Default::default()
            };
            assert!(validate_installed_probe(provider, &record, false).is_ok());
            record
                .errors
                .push("the installed server did not report any supported options".into());
            assert!(validate_installed_probe(provider, &record, false)
                .unwrap_err()
                .contains("supported options"));
            record.errors.clear();
            record.version.clear();
            assert!(validate_installed_probe(provider, &record, false).is_err());
        }
    }

    #[tokio::test]
    async fn cancelled_reprobe_never_reads_a_registration_or_starts_an_interpreter() {
        let cancel = Arc::new(AtomicBool::new(true));
        let error = reprobe_cancellable(
            ProviderId::Vllm,
            "synthetic-absent-registration",
            Some(cancel),
        )
        .await
        .unwrap_err();
        assert!(error.contains("cancelled"));
    }

    #[test]
    fn probe_output_is_read_from_the_marked_line_only() {
        let stdout = "INFO import warning\nAIOLM_PROBE={\"version\":\"0.31.0\",\"python_version\":\"3.12.4\",\"accelerator\":\"cuda\",\"architectures\":[\"LlamaForCausalLM\"],\"errors\":[]}\n";
        let record = parse_probe_output(stdout).unwrap();
        assert_eq!(record.version, "0.31.0");
        assert_eq!(record.accelerator, "cuda");
        assert_eq!(record.architectures, vec!["LlamaForCausalLM"]);
        assert!(record.probed_at > 0);
        assert!(parse_probe_output("no marker").is_err());
        assert!(parse_probe_output("AIOLM_PROBE={not json").is_err());
    }

    #[test]
    fn ids_are_stable_and_path_safe() {
        assert_eq!(managed_id("0.31.0"), "managed-0-31-0");
        assert_eq!(managed_id("0.7.6+metal"), "managed-0-7-6-metal");
        assert!(validate_id("managed-0-31-0").is_ok());
        for bad in ["", "../x", "A", "-x", "x/y", &"a".repeat(65)] {
            assert!(validate_id(bad).is_err(), "{bad}");
        }
        let id = external_id(Path::new("/opt/env/bin/python"));
        assert!(validate_id(&id).is_ok());
        assert_eq!(id, external_id(Path::new("/opt/env/bin/python")));
        assert_ne!(id, external_id(Path::new("/opt/other/bin/python")));
    }

    #[test]
    fn python_requirements_match_package_metadata() {
        assert!(python_supported(ProviderId::Vllm, 3, 10));
        assert!(python_supported(ProviderId::Vllm, 3, 14));
        assert!(!python_supported(ProviderId::Vllm, 3, 15));
        assert!(!python_supported(ProviderId::Vllm, 3, 9));
        assert!(python_supported(ProviderId::MlxVlm, 3, 13));
        assert!(!python_supported(ProviderId::MlxVlm, 2, 7));
        assert_eq!(parse_python_version("Python 3.12.1"), Some((3, 12)));
        assert_eq!(parse_python_version("3.11"), Some((3, 11)));
    }

    #[test]
    fn readiness_problems_separate_missing_files_from_unprobed_packages() {
        let manifest = PythonRuntimeManifest {
            format: MANIFEST_FORMAT,
            provider: ProviderId::Vllm,
            id: "external-00000000".into(),
            kind: InstallationKind::External,
            python: std::env::temp_dir()
                .join(format!("aiolm-missing-python-{}", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
            requested_version: None,
            probe: None,
        };
        let problems = manifest.problems();
        assert_eq!(problems.len(), 2);
        assert!(problems[0].contains("interpreter is missing"));
        assert!(problems[1].contains("not been probed"));
    }

    #[test]
    fn engine_environment_never_lets_an_engine_download_models() {
        let environment = engine_environment();
        assert!(environment
            .iter()
            .any(|(key, value)| key == "HF_HUB_OFFLINE" && value == "1"));
        assert!(!environment.iter().any(|(key, _)| key == "PYTHONPATH"));
    }

    #[test]
    fn parent_plugin_controls_cannot_override_the_selected_runtime() {
        let environment = engine_environment_from(vec![
            ("VLLM_PLUGINS".into(), "foreign".into()),
            ("VLLM_MLX_DEVICE".into(), "cpu".into()),
            ("MLX_METAL_PATH".into(), "synthetic-library".into()),
            ("PYTHONPATH".into(), "synthetic-module".into()),
            ("CUDA_VISIBLE_DEVICES".into(), "0".into()),
        ]);
        assert!(!environment.iter().any(|(key, _)| {
            let key = key.to_string_lossy();
            key.starts_with("VLLM_") || key.starts_with("MLX_") || key == "PYTHONPATH"
        }));
        assert!(environment
            .iter()
            .any(|(key, value)| key == "CUDA_VISIBLE_DEVICES" && value == "0"));
    }

    #[test]
    fn installer_output_is_split_across_reads_and_bounded_per_line() {
        let mut lines = LineSplitter::default();
        assert!(lines.push(b"Collecting vl").is_empty());
        assert_eq!(
            lines.push(b"lm\r\nDownloading 10%\r20%\rdone\n"),
            vec!["Collecting vllm", "Downloading 10%", "20%", "done"]
        );
        let long = vec![b'x'; MAX_OUTPUT_LINE * 3];
        assert!(lines.push(&long).is_empty());
        assert_eq!(lines.pending.len(), MAX_OUTPUT_LINE, "memory stays bounded");
        let cut = lines.push(b"\n");
        assert_eq!(cut.len(), 1);
        assert!(
            cut[0].ends_with(" [truncated]")
                && cut[0].len() == MAX_OUTPUT_LINE + " [truncated]".len()
        );
        assert!(lines.push(b"tail without newline").is_empty());
        assert_eq!(lines.finish().as_deref(), Some("tail without newline"));
        assert_eq!(lines.finish(), None);
    }

    #[test]
    fn probe_records_keep_task_and_modality_lists_and_accept_older_records() {
        let stdout = "AIOLM_PROBE={\"version\":\"0.7.6\",\"model_types\":[\"gemma3n\",\"bert\",\"qwen_image\"],\"audio_model_types\":[\"gemma3n\"],\"embedding_model_types\":[\"bert\"],\"image_generation_model_types\":[\"qwen_image\"],\"package_scan\":1,\"errors\":[]}";
        let record = parse_probe_output(stdout).unwrap();
        assert_eq!(record.audio_model_types, vec!["gemma3n"]);
        assert_eq!(record.embedding_model_types, vec!["bert"]);
        assert_eq!(record.image_generation_model_types, vec!["qwen_image"]);
        assert_eq!(record.package_scan, 1);
        let older =
            parse_probe_output("AIOLM_PROBE={\"version\":\"0.7.6\",\"errors\":[]}").unwrap();
        assert!(older.audio_model_types.is_empty() && older.embedding_model_types.is_empty());
        assert_eq!(older.package_scan, 0);
    }

    #[test]
    fn the_mlx_probe_reads_package_sources_without_importing_them() {
        // The scan must not import model packages: only `mlx_vlm.models`
        // itself is imported, and each package is opened as text.
        let start = MLX_VLM_PROBE
            .find("# Package sources are read as text")
            .unwrap();
        let scan = &MLX_VLM_PROBE[start..];
        for forbidden in ["import_module", "__import__", "exec(", "eval(", "importlib"] {
            assert!(!scan.contains(forbidden), "{forbidden}");
        }
        assert!(scan.contains("out[\"package_scan\"] = 1"));
    }

    #[test]
    fn managed_metal_plan_never_resolves_a_pypi_plugin_or_collides_with_linux() {
        let args = install_arguments(
            ProviderId::Vllm,
            "0.30.0",
            true,
            Path::new("synthetic-constraints.txt"),
        )
        .unwrap();
        assert!(args.contains(&metal_env::CORE_WHEEL.into()));
        assert!(args.contains(&format!(
            "vllm-metal[gguf,stt] @ {}",
            metal_env::PLUGIN_WHEEL
        )));
        assert!(!args
            .iter()
            .any(|arg| arg == "vllm-metal==0.30.0" || arg.contains("latest")));
        assert!(install_arguments(
            ProviderId::Vllm,
            "0.31.0",
            true,
            Path::new("constraints.txt")
        )
        .is_err());
        let metal = managed_variant_id("0.30.0", metal_env::VARIANT);
        assert_ne!(metal, managed_id("0.30.0"));
        validate_id(&format!("{metal}-0123456789ab")).unwrap();
        let linux =
            install_arguments(ProviderId::Vllm, "0.31.0", false, Path::new("unused")).unwrap();
        assert_eq!(linux.last().unwrap(), "vllm==0.31.0");
        let mlx =
            install_arguments(ProviderId::MlxVlm, "0.7.6", false, Path::new("unused")).unwrap();
        assert_eq!(mlx.last().unwrap(), "mlx-vlm==0.7.6");
    }

    #[test]
    fn old_manifest_probe_provenance_defaults_survive_round_trip() {
        let manifest: PythonRuntimeManifest = serde_json::from_str(r#"{"format":1,"provider":"vllm","id":"external-old","kind":"external","python":"synthetic-python","probe":{"version":"0.31.0","accelerator":"cuda"}}"#).unwrap();
        let probe = manifest.probe.as_ref().unwrap();
        assert_eq!(probe.variant, "");
        assert_eq!(probe.metal_registry_scan, 0);
        assert!(!probe.metal_native_importable);
        let round_trip: PythonRuntimeManifest =
            serde_json::from_slice(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(round_trip, manifest);
    }

    #[tokio::test]
    async fn cancelled_installer_never_starts_a_child() {
        let cancel = Arc::new(AtomicBool::new(true));
        let error = run_logged(
            Path::new("synthetic-nonexistent-installer"),
            &[],
            &cancel,
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error, "runtime installation cancelled");
    }

    #[test]
    #[ignore = "subprocess fixture invoked by the cancellation test"]
    fn synthetic_installer_waits_for_cancellation() {
        println!("AIOLM_SYNTHETIC_INSTALLER_STARTED");
        std::thread::sleep(Duration::from_secs(30));
    }

    #[tokio::test]
    async fn cancelled_running_installer_cleans_owned_staging_without_publication() {
        let root =
            std::env::temp_dir().join(format!("aiolm-metal-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("venv")).unwrap();
        fs::write(root.join("venv").join("synthetic-package"), "partial").unwrap();
        let cleanup = StagingCleanup(root.clone());
        let cancel = Arc::new(AtomicBool::new(false));
        let runner = std::env::current_exe().unwrap();
        let result = run_logged(
            &runner,
            &[
                "--exact",
                "providers::python_env::tests::synthetic_installer_waits_for_cancellation",
                "--ignored",
                "--nocapture",
            ],
            &cancel,
            |line| {
                if line.contains("AIOLM_SYNTHETIC_INSTALLER_STARTED") {
                    cancel.store(true, Ordering::Release);
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err(), "runtime installation cancelled");
        assert!(!root.join(MANIFEST).exists());
        drop(cleanup);
        assert!(!root.exists());
    }

    #[test]
    fn failed_staging_cleanup_preserves_separate_external_environment() {
        let root =
            std::env::temp_dir().join(format!("aiolm-metal-cleanup-{}", uuid::Uuid::new_v4()));
        let staging = root.join("owned");
        let external = root.join("external");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("python"), "synthetic external interpreter").unwrap();
        {
            let _cleanup = StagingCleanup(staging.clone());
        }
        assert!(!staging.exists());
        assert!(external.join("python").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn forgetting_external_metal_registration_preserves_selected_environment() {
        let root =
            std::env::temp_dir().join(format!("aiolm-metal-external-{}", uuid::Uuid::new_v4()));
        let registration = root.join("registration");
        let external = root.join("user-environment");
        fs::create_dir_all(&external).unwrap();
        let python = external.join("python");
        fs::write(&python, "synthetic interpreter").unwrap();
        let manifest = PythonRuntimeManifest {
            format: MANIFEST_FORMAT,
            provider: ProviderId::Vllm,
            id: "external-metal-synthetic".into(),
            kind: InstallationKind::External,
            python: python.to_string_lossy().into_owned(),
            requested_version: None,
            probe: Some(ProbeRecord {
                variant: metal_env::VARIANT.into(),
                ..Default::default()
            }),
        };
        write(&manifest, &registration).unwrap();
        remove_registration_at(&manifest, &registration).unwrap();
        assert!(!registration.exists());
        assert_eq!(
            fs::read_to_string(&python).unwrap(),
            "synthetic interpreter"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
