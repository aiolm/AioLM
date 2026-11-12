//! Portable Python runtime bundles for Linux vLLM, vllm-metal and mlx-vlm.
//!
//! A CPython virtual environment embeds absolute paths in its scripts and
//! configuration, so it can never be copied to another machine and relocated.
//! A portable bundle is instead a bounded, versioned, reproducible recipe:
//! exact package identities with checksummed wheels and the platform, CPU
//! architecture and Python ABI they were built for, with no personal paths or
//! credentials. Import recreates a new app-owned isolated environment from the
//! vendored wheels only (`pip install --no-index --only-binary=:all:`), probes
//! readiness with the same rules as a fresh install, publishes the manifest
//! atomically, and removes its staging directory on failure or cancellation.
//!
//! Guarantees, enforced by the validators below and covered by synthetic tests:
//! - Export never mutates an external interpreter: it only reads the probe and
//!   runs `pip download` into a staging directory.
//! - Import never replaces another runtime and never installs into a user
//!   interpreter: it always allocates a fresh unique `portable-*` directory
//!   under the app-owned providers root.
//! - Incompatible platform/ABI, altered hashes, path escapes, archive
//!   collisions, unsupported install sources and unknown distributions are
//!   rejected explicitly before anything is executed or published.
//! - No sdists are ever accepted or built, so imported install hooks and
//!   `setup.py` builds cannot run.
//! - Metal core/plugin/MLX ABI and the exact mlx-lm source revision travel in
//!   the manifest and are re-verified against the post-install probe.
//! - Verified wheels stay in private staging under AioLM's home until the
//!   operation finishes; Unix staging directories are created with mode 0700.
//! - Public identities stay provider-scoped (`provider`, `runtime_id`); the
//!   native llama `(backend, build)` vocabulary never appears in this format.
#[cfg(test)]
use super::python_env::MAX_OUTPUT_LINE;
use super::python_env::{
    run_logged, venv_python, LoggedOperation, StagingCleanup, MANIFEST as RUNTIME_MANIFEST_FILE,
    MANIFEST_FORMAT as RUNTIME_MANIFEST_FORMAT,
};
use super::{metal_env, python_env, ProviderId};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Bundle schema version. Readers reject anything else explicitly.
pub const PORTABLE_FORMAT: u32 = 1;
/// Stable bundle discriminator, distinct from llama bundle manifests.
pub const PORTABLE_KIND: &str = "aiolm-python-runtime-portable";
/// Manifest file name at the archive root.
pub const PORTABLE_MANIFEST_NAME: &str = "portable-manifest.json";
/// Directory inside the archive that holds every wheel.
pub const PORTABLE_WHEELS_DIR: &str = "wheels";

/// Largest accepted portable archive: vendored torch/CUDA wheels are big, but
/// the bundle stays bounded so a malicious archive cannot exhaust the disk.
pub const MAX_PORTABLE_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Largest total of manifest plus wheel bytes after verification.
pub const MAX_PORTABLE_EXTRACTED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
/// Largest single wheel: CUDA torch wheels approach a gigabyte.
pub const MAX_PORTABLE_WHEEL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Largest manifest JSON: identities only, never embedded wheels.
pub const MAX_PORTABLE_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Largest entry count: one manifest plus a closed dependency set.
pub const MAX_PORTABLE_ENTRIES: usize = 1024;

/// Host platform the bundle was captured on, and the interpreter ABI its
/// wheels were built for. Recorded at export, re-checked at import.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PortablePlatform {
    pub os: String,
    pub arch: String,
    pub python_version: String,
    pub python_implementation: String,
    pub python_abi: String,
    pub macos_version: String,
}

/// One vendored wheel: exact distribution identity plus integrity evidence.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PortableWheel {
    /// Normalized distribution name (`scikit-learn`, never `scikit_learn`).
    pub name: String,
    pub version: String,
    /// Archive file name under `wheels/`, e.g. `torch-2.4.0-...whl`.
    pub filename: String,
    /// Lowercase hex SHA-256 of the wheel bytes.
    pub sha256: String,
    pub size: u64,
}

/// Versioned bundle recipe. Carries identities and hashes only: no absolute
/// paths, no home directories, no URLs with credentials, no tokens.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PortableManifest {
    pub format: u32,
    pub kind: String,
    pub provider: ProviderId,
    /// `standard` or `vllm-metal`.
    pub variant: String,
    /// Engine version, e.g. `0.31.0`, `0.30.0`, `0.7.6`.
    pub version: String,
    #[serde(default)]
    pub plugin_version: String,
    #[serde(default)]
    pub mlx_version: String,
    /// Exact 40-hex mlx-lm source revision for Metal bundles, else empty.
    #[serde(default)]
    pub mlx_lm_commit: String,
    pub platform: PortablePlatform,
    /// Exact normalized distribution name to exact version: the complete
    /// installed freeze minus the venv bootstrap (`pip`, `setuptools`,
    /// `wheel`), so the target reinstalls the same closure, not the latest
    /// resolvable one.
    pub packages: BTreeMap<String, String>,
    /// Where each vendored wheel came from: `pypi` for index downloads,
    /// `release-url` for the pinned Metal release assets. Only personal-data
    /// free source kinds are representable here; anything else (local paths,
    /// editables, VCS checkouts, unknown hosts) fails the export explicitly
    /// instead of being recorded.
    pub sources: BTreeMap<String, String>,
    pub wheels: Vec<PortableWheel>,
    /// Pinned constraint text for Metal bundles, else empty.
    #[serde(default)]
    pub constraints: String,
}

/// What an export publishes: where the archive is and what it holds. Uses
/// provider-scoped identities only, never llama `(backend, build)`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PortableExportInfo {
    pub path: String,
    pub provider: ProviderId,
    pub runtime_id: String,
    pub variant: String,
    pub version: String,
    pub archive_sha256: String,
    pub bytes: u64,
    pub wheels: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct PortableProgress {
    pub provider: ProviderId,
    pub id: String,
    pub phase: &'static str,
    pub line: String,
}

fn fail(message: impl Into<String>) -> AppError {
    AppError::validation(message)
}

fn check_version_pair(name: &str, promised: &str, actual: Option<&str>) -> Result<(), AppError> {
    if actual != Some(promised) {
        return Err(fail(format!(
            "{name} version in the dependency closure ({}) does not match the declared version {promised}",
            actual.unwrap_or("<missing>"),
        )));
    }
    Ok(())
}

/// Distribution names compare case-insensitively with `-`, `_`, `.` equal.
pub fn normalize_dist(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut dash = false;
    for value in name.chars() {
        if value == '-' || value == '_' || value == '.' {
            if !out.is_empty() && !dash {
                out.push('-');
                dash = true;
            }
        } else {
            dash = false;
            out.extend(value.to_lowercase());
        }
    }
    out.trim_matches('-').to_owned()
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || "._-+!".contains(value))
}

fn valid_distribution(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && normalize_dist(name) == name
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.as_bytes()[name.len() - 1].is_ascii_alphanumeric()
}

/// Wheel source kinds recorded in [`PortableManifest::sources`].
pub const SOURCE_PYPI: &str = "pypi";
pub const SOURCE_RELEASE_URL: &str = "release-url";

/// The single pinned source capture is tested independently from index wheels.
#[cfg(test)]
const MLX_LM_UPSTREAM: &str = "github.com/ml-explore/mlx-lm";

/// One installed distribution in the source interpreter: exact version plus
/// the installer provenance `pip` recorded, if any.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrozenDist {
    pub version: String,
    /// Raw `direct_url.json` text when the installer left one, else `None`
    /// (a plain index install).
    pub direct_url: Option<String>,
    pub portable_commit: String,
}

/// Complete installed inventory of the source interpreter, keyed by
/// normalized distribution name.
pub type FreezeMap = BTreeMap<String, FrozenDist>;

/// Read-only inventory of every distribution installed in one interpreter.
/// Runs with `-I` and imports `importlib.metadata` only: nothing is
/// installed, upgraded, or imported beyond the metadata reader itself, so an
/// external environment is never mutated.
pub fn read_freeze(provider: ProviderId, python: &Path) -> Result<FreezeMap, AppError> {
    read_freeze_cancellable(provider, python, None)
}

fn read_freeze_cancellable(
    provider: ProviderId,
    python: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<FreezeMap, AppError> {
    let script = format!(
        "{}\n{}",
        include_str!("portable_source_probe.py"),
        include_str!("portable_inventory.py")
    );
    let mut command = crate::procutil::std_command(python);
    command
        .env_clear()
        .envs(python_env::engine_environment())
        .args(["-I", "-c", &script, python_env::package_name(provider)]);
    let output = crate::procutil::capture_stdout_cancellable(
        &mut command,
        Duration::from_secs(60),
        4 * 1024 * 1024,
        cancel,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::Interrupted
            && cancel.is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            AppError::cancelled("portable runtime operation cancelled")
        } else {
            AppError::new(
                AppError::from_io(&error).kind,
                format!("runtime inventory check failed: {error}"),
            )
        }
    })?;
    if !output.status.success() {
        return Err(AppError::unavailable("runtime inventory check failed"));
    }
    parse_freeze_output(&String::from_utf8_lossy(&output.stdout))
}

/// Parse the `AIOLM_FREEZE=` inventory line. Engine warnings on stdout are
/// ignored: only the marked line is trusted.
pub fn parse_freeze_output(stdout: &str) -> Result<FreezeMap, AppError> {
    let line = stdout
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("AIOLM_FREEZE="))
        .ok_or_else(|| fail("the interpreter did not report an inventory"))?;
    let entries: Vec<FreezeEntry> = serde_json::from_str(line)
        .map_err(|error| AppError::validation(format!("invalid inventory: {error}")))?;
    let mut freeze = FreezeMap::new();
    for entry in entries {
        let name = normalize_dist(&entry.name);
        if !valid_distribution(&name) || !valid_version(&entry.version) {
            return Err(fail(format!(
                "invalid installed distribution: {}",
                entry.name
            )));
        }
        freeze.insert(
            name,
            FrozenDist {
                version: entry.version,
                direct_url: entry.direct_url,
                portable_commit: entry.portable_commit,
            },
        );
    }
    Ok(freeze)
}

#[derive(Deserialize)]
struct FreezeEntry {
    name: String,
    version: String,
    #[serde(default)]
    direct_url: Option<String>,
    #[serde(default)]
    portable_commit: String,
}

/// Minimal `direct_url.json` view: PEP 610 installer provenance.
#[derive(Deserialize, Default)]
struct DirectUrl {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    vcs_info: Option<VcsInfo>,
    #[serde(default)]
    archive_info: Option<serde_json::Value>,
    #[serde(default)]
    dir_info: Option<DirInfo>,
}

#[derive(Deserialize, Default)]
struct VcsInfo {
    #[serde(default)]
    vcs: Option<String>,
    #[serde(default)]
    commit_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct DirInfo {
    #[serde(default)]
    editable: Option<bool>,
}

/// How one frozen distribution can be vendored reproducibly.
enum WheelSource {
    /// `name==version` from the package index.
    Pypi,
    /// The pinned Metal release asset pip verifies by its `#sha256` fragment.
    ReleaseUrl,
    PinnedGit,
    /// Fails the export with the carried reason; never recorded silently.
    Unsupported(String),
}

/// Classify one installed distribution. Index installs and the two pinned
/// Metal release assets vendor reproducibly; local directories, editables,
/// VCS checkouts and unknown hosts are unsupported sources and are named
/// explicitly so the user knows exactly which distribution blocks the export.
fn classify_source(
    provider: ProviderId,
    variant: &str,
    name: &str,
    frozen: &FrozenDist,
) -> WheelSource {
    if provider == ProviderId::Vllm
        && variant == metal_env::VARIANT
        && name == "mlx-lm"
        && frozen.portable_commit == metal_env::MLX_LM_COMMIT
    {
        return WheelSource::PinnedGit;
    }
    let direct: Option<DirectUrl> = match frozen.direct_url.as_deref() {
        Some(text) => match serde_json::from_str(text) {
            Ok(value) => Some(value),
            Err(_) => {
                return WheelSource::Unsupported(format!(
                    "{name} has unreadable installer provenance"
                ))
            }
        },
        None => None,
    };
    match direct {
        None => WheelSource::Pypi,
        Some(direct) => {
            if let Some(vcs) = direct.vcs_info {
                let commit = vcs.commit_id.unwrap_or_default();
                if provider == ProviderId::Vllm
                    && variant == metal_env::VARIANT
                    && name == "mlx-lm"
                    && commit == metal_env::MLX_LM_COMMIT
                    && vcs.vcs.as_deref() == Some("git")
                    && matches!(
                        direct.url.as_deref(),
                        Some("https://github.com/ml-explore/mlx-lm")
                            | Some("https://github.com/ml-explore/mlx-lm.git")
                    )
                {
                    return WheelSource::PinnedGit;
                }
                // A wheel reinstall drops `vcs_info`, which the Metal probe
                // requires for mlx-lm and which no probe records for anything
                // else: shipping the commit would fabricate unverifiable
                // provenance, so VCS sources fail explicitly instead.
                return WheelSource::Unsupported(format!(
                    "{name}=={} is installed from git commit {commit}; portable bundles cannot preserve VCS provenance verified by the runtime probe (only index and pinned release wheels round-trip)",
                    frozen.version,
                ));
            }
            if direct
                .dir_info
                .is_some_and(|info| info.editable.unwrap_or(false))
            {
                return WheelSource::Unsupported(format!(
                    "{name}=={} is an editable install; portable bundles only vendor reproducible wheels",
                    frozen.version
                ));
            }
            if direct.archive_info.is_some() {
                if variant == metal_env::VARIANT {
                    for (dist, version, wheel) in [
                        ("vllm", metal_env::CORE_VERSION, metal_env::CORE_WHEEL),
                        ("vllm-metal", metal_env::VERSION, metal_env::PLUGIN_WHEEL),
                    ] {
                        if name == dist
                            && frozen.version == version
                            && direct
                                .url
                                .as_deref()
                                .is_some_and(|url| same_release_asset(url, wheel))
                        {
                            let _ = provider;
                            return WheelSource::ReleaseUrl;
                        }
                    }
                }
                // An index wheel reinstall keeps no local state: re-fetching
                // the same pinned version from the index reproduces it.
                if direct.url.as_deref().is_some_and(is_index_url) {
                    return WheelSource::Pypi;
                }
                return WheelSource::Unsupported(format!(
                    "{name}=={} comes from an unsupported archive URL; portable bundles only vendor index and pinned release wheels",
                    frozen.version
                ));
            }
            if let Some(url) = direct.url.as_deref() {
                return WheelSource::Unsupported(format!(
                    "{name}=={} comes from an unsupported source ({url}); portable bundles only vendor index and pinned release wheels",
                    frozen.version
                ));
            }
            WheelSource::Unsupported(format!(
                "{name}=={} has unreadable installer provenance; portable bundles only vendor index and pinned release wheels",
                frozen.version
            ))
        }
    }
}

/// Same release asset with or without its `#sha256` fragment.
fn same_release_asset(installed: &str, pinned: &str) -> bool {
    installed.split('#').next() == pinned.split('#').next()
}

/// The public index hosts; anything else is not a reproducible source.
fn is_index_url(url: &str) -> bool {
    url.starts_with("https://files.pythonhosted.org/") || url.starts_with("https://pypi.org/")
}

/// Exact dependency closure for one runtime: the complete installed freeze
/// (minus venv bootstrap), every member classified to a reproducible wheel
/// source. Probe identities and the freeze must agree on the engine, or the
/// environment changed between probing and export and the recipe refuses to
/// guess which one is authoritative.
pub fn export_freeze(
    provider: ProviderId,
    probe: &python_env::ProbeRecord,
    freeze: &FreezeMap,
) -> Result<BTreeMap<String, &'static str>, AppError> {
    let variant = if probe.variant.is_empty() {
        "standard"
    } else {
        probe.variant.as_str()
    };
    if probe.version.is_empty() {
        return Err(fail(format!(
            "{} is not importable from this interpreter",
            python_env::package_name(provider)
        )));
    }
    let engine = normalize_dist(python_env::package_name(provider));
    let frozen_engine = freeze.get(&engine).ok_or_else(|| {
        fail(format!(
            "cannot export a portable bundle without an exact installed version for {engine}"
        ))
    })?;
    // The probe and the freeze are two reads of one environment; a version
    // skew between them means the environment changed mid-export.
    let expected_engine = probe.version.clone();
    if frozen_engine.version != expected_engine {
        return Err(fail(format!(
            "the runtime changed between probing ({expected_engine}) and export ({}); probe it again",
            frozen_engine.version
        )));
    }
    if variant == metal_env::VARIANT {
        if probe.metal_version.is_empty() {
            return Err(fail("vllm-metal bundle has no plugin version"));
        }
        let plugin = freeze.get("vllm-metal").ok_or_else(|| {
            fail(
                "cannot export a portable bundle without an exact installed version for vllm-metal",
            )
        })?;
        if plugin.version != probe.metal_version {
            return Err(fail(format!(
                "the runtime changed between probing ({}) and export ({}); probe it again",
                probe.metal_version, plugin.version
            )));
        }
    }
    for required in required_packages(provider, variant) {
        if !freeze.contains_key(*required) {
            return Err(fail(format!(
                "cannot export a portable bundle without an exact installed version for {required}"
            )));
        }
    }
    let mut sources: BTreeMap<String, &'static str> = BTreeMap::new();
    for (name, frozen) in freeze {
        // Inventory already contains only active dependencies. If setuptools,
        // wheel or pip is a runtime dependency, its exact wheel must travel too.
        if !valid_version(&frozen.version) {
            return Err(fail(format!("invalid installed version for {name}")));
        }
        match classify_source(provider, variant, name, frozen) {
            WheelSource::Pypi => {
                sources.insert(name.clone(), SOURCE_PYPI);
            }
            WheelSource::ReleaseUrl => {
                sources.insert(name.clone(), SOURCE_RELEASE_URL);
            }
            WheelSource::Unsupported(reason) => return Err(fail(reason)),
            WheelSource::PinnedGit => {
                sources.insert(name.clone(), "pinned-git");
            }
        }
    }
    if !probe.mlx_version.is_empty()
        && (provider == ProviderId::MlxVlm
            || (provider == ProviderId::Vllm && variant == metal_env::VARIANT))
    {
        check_version_pair(
            "mlx",
            &probe.mlx_version,
            freeze.get("mlx").map(|frozen| frozen.version.as_str()),
        )?;
    }
    Ok(sources)
}

/// `pip download` arguments for a classified closure, sorted for
/// determinism: `name==version` pins for index wheels, `name @ url` for the
/// pinned release assets pip verifies by fragment hash. The VCS case never
/// reaches pip: it fails at classification with an explicit contract.
pub fn download_args(
    freeze: &FreezeMap,
    sources: &BTreeMap<String, String>,
    variant: &str,
) -> Vec<String> {
    let mut args: Vec<String> = sources
        .iter()
        .filter_map(|(name, source)| {
            let frozen = freeze.get(name)?;
            match source.as_str() {
                "pinned-git" => None,
                SOURCE_RELEASE_URL if variant == metal_env::VARIANT => {
                    let wheel = if name == "vllm" {
                        metal_env::CORE_WHEEL
                    } else {
                        metal_env::PLUGIN_WHEEL
                    };
                    Some(format!("{name} @ {wheel}"))
                }
                _ => Some(format!("{name}=={}", frozen.version)),
            }
        })
        .collect();
    args.sort();
    args
}

/// Minimum exact identities an export must carry so the target machine
/// reinstalls the same dependency closure, not the latest resolvable one.
fn required_packages(provider: ProviderId, variant: &str) -> &'static [&'static str] {
    match (provider, variant) {
        (ProviderId::Vllm, "vllm-metal") => &["vllm", "vllm-metal", "mlx"],
        (ProviderId::Vllm, _) => &["vllm", "torch", "transformers", "tokenizers", "safetensors"],
        (ProviderId::MlxVlm, _) => &[
            "mlx-vlm",
            "mlx",
            "transformers",
            "tokenizers",
            "safetensors",
        ],
        _ => &[],
    }
}

/// Split `name-version-...whl` into its normalized distribution and version.
/// Only binary wheels are portable: sdists (`.tar.gz`), plain `.zip` files and
/// `setup.py` sources are rejected as unsupported install sources.
pub fn parse_wheel_filename(filename: &str) -> Result<(String, String), AppError> {
    if !filename.ends_with(".whl") || filename.contains('/') || filename.contains('\\') {
        return Err(fail(format!("unsupported distribution file: {filename}")));
    }
    let stem = filename.strip_suffix(".whl").unwrap_or(filename);
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() < 5 {
        return Err(fail(format!("unsupported distribution file: {filename}")));
    }
    // Wheel layout: {distribution}-{version}(-{build})?-{python}-{abi}-{platform}.
    // The identity is always the first two components.
    let (name, version) = (parts[0], parts[1]);
    let name = normalize_dist(name);
    if !valid_distribution(&name) || !valid_version(version) {
        return Err(fail(format!("unsupported distribution file: {filename}")));
    }
    Ok((name, version.to_owned()))
}

fn current_os() -> &'static str {
    std::env::consts::OS
}

fn current_arch() -> &'static str {
    std::env::consts::ARCH
}

fn normalize_arch(arch: &str) -> &str {
    match arch {
        "arm64" => "aarch64",
        "aarch64" => "aarch64",
        other => other,
    }
}

/// Platform captured from a live probe. Personal paths never enter the probe,
/// so copying its version/architecture fields cannot leak user data.
pub fn platform_of_probe(probe: &python_env::ProbeRecord) -> PortablePlatform {
    let os = match probe.platform_system.as_str() {
        "Darwin" => "macos",
        "Linux" => "linux",
        "Windows" => "windows",
        other => other,
    }
    .to_owned();
    PortablePlatform {
        os,
        arch: probe.python_arch.clone(),
        python_version: probe.python_version.clone(),
        python_implementation: probe.python_implementation.clone(),
        python_abi: probe.python_abi.clone(),
        macos_version: probe.macos_version.clone(),
    }
}

/// Assemble the export recipe from a healthy manifest and a fresh inventory of
/// the same interpreter. Rejects unprobed or unhealthy runtimes, Metal
/// provenance gaps, unsupported install sources, and anything that would embed
/// personal paths: the manifest carries versions, source kinds and hashes only.
pub fn build_export_manifest(
    manifest: &python_env::PythonRuntimeManifest,
    freeze: &FreezeMap,
) -> Result<PortableManifest, AppError> {
    if !manifest.provider.is_python() {
        return Err(fail("only Python runtimes have portable bundles"));
    }
    let problems = manifest.problems();
    if !problems.is_empty() {
        return Err(AppError::unavailable(format!(
            "cannot export a runtime that is not ready: {}",
            problems.join("; ")
        )));
    }
    let probe = manifest
        .probe
        .as_ref()
        .ok_or_else(|| fail("the runtime has not been probed yet"))?;
    if !probe.errors.is_empty() {
        return Err(AppError::unavailable(format!(
            "cannot export a runtime with probe errors: {}",
            probe.errors.join("; ")
        )));
    }
    let variant = if probe.variant.is_empty() {
        "standard".to_owned()
    } else {
        probe.variant.clone()
    };
    if variant != "standard" && variant != metal_env::VARIANT {
        return Err(fail(format!("unknown vLLM runtime variant: {variant}")));
    }
    let sources = export_freeze(manifest.provider, probe, freeze)?;
    let packages: BTreeMap<String, String> = sources
        .keys()
        .map(|name| {
            freeze
                .get(name)
                .map(|frozen| (name.clone(), frozen.version.clone()))
        })
        .collect::<Option<BTreeMap<_, _>>>()
        .ok_or_else(|| fail("the runtime inventory changed during export"))?;
    let mlx_lm_commit = probe
        .package_versions
        .get("mlx-lm-commit")
        .cloned()
        .unwrap_or_default();
    if variant == metal_env::VARIANT {
        if mlx_lm_commit.len() != 40 || !mlx_lm_commit.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(fail(
                "vllm-metal export requires the exact pinned mlx-lm source revision",
            ));
        }
        if probe.mlx_version != metal_env::MLX_VERSION {
            return Err(fail(format!(
                "vllm-metal export requires mlx=={}",
                metal_env::MLX_VERSION
            )));
        }
    }
    Ok(PortableManifest {
        format: PORTABLE_FORMAT,
        kind: PORTABLE_KIND.into(),
        provider: manifest.provider,
        variant,
        version: probe.version.clone(),
        plugin_version: probe.metal_version.clone(),
        mlx_version: probe.mlx_version.clone(),
        mlx_lm_commit: mlx_lm_commit.to_lowercase(),
        platform: platform_of_probe(probe),
        packages,
        sources: sources
            .into_iter()
            .map(|(name, source)| (name, source.to_owned()))
            .collect(),
        wheels: Vec::new(),
        constraints: if manifest.provider == ProviderId::Vllm && probe.variant == metal_env::VARIANT
        {
            super::metal_env::CONSTRAINTS.to_owned()
        } else {
            String::new()
        },
    })
}

/// Archive entry policy: exactly one manifest at the root plus wheels.
/// Everything else, including sdists, hook scripts and nested archives, is an
/// unsupported source and is rejected before anything runs.
fn safe_archive_path(value: &str) -> Result<PathBuf, AppError> {
    // Policy runs on the raw entry string: `PathBuf` renders separators
    // platform-natively (`\` on Windows), which would break the stable
    // `wheels/<name>.whl` layout below.
    if value.len() > 4096 || value.starts_with('/') || value.contains(['\\', ':', '\0']) {
        return Err(fail("portable bundle contains an unsafe path"));
    }
    let mut components: Vec<&str> = Vec::new();
    for component in value.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err(fail("portable bundle contains an unsafe path")),
            _ => components.push(component),
        }
    }
    if components.is_empty() {
        return Err(fail("portable bundle contains an empty file path"));
    }
    if components.len() == 1 && components[0] == PORTABLE_MANIFEST_NAME {
        return Ok(PathBuf::from(value));
    }
    if components.len() == 2 && components[0] == PORTABLE_WHEELS_DIR {
        parse_wheel_filename(components[1])?;
        return Ok(PathBuf::from(value));
    }
    Err(fail(format!("unexpected file in portable bundle: {value}")))
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// Manifest self-checks: schema version, provider-scoped identity, exact
/// versions, wheel inventory with hashes, Metal provenance, and a scan for
/// personal paths or credentials that must never be exported.
pub fn validate_manifest(manifest: &PortableManifest) -> Result<(), AppError> {
    if manifest.format != PORTABLE_FORMAT {
        return Err(fail(format!(
            "unsupported portable bundle format: {}",
            manifest.format
        )));
    }
    if manifest.kind != PORTABLE_KIND {
        return Err(fail(format!(
            "not an AioLM Python runtime bundle: {}",
            manifest.kind
        )));
    }
    if !manifest.provider.is_python() {
        return Err(fail("portable bundles only describe Python runtimes"));
    }
    if manifest.variant != "standard" && manifest.variant != metal_env::VARIANT {
        return Err(fail(format!(
            "unknown vLLM runtime variant: {}",
            manifest.variant
        )));
    }
    if manifest.provider == ProviderId::MlxVlm && manifest.variant == metal_env::VARIANT {
        return Err(fail("mlx-vlm bundles never use the vllm-metal variant"));
    }
    if !valid_version(&manifest.version) {
        return Err(fail(format!(
            "invalid engine version: {}",
            manifest.version
        )));
    }
    if manifest.wheels.is_empty() || manifest.wheels.len() > MAX_PORTABLE_ENTRIES {
        return Err(fail("portable bundle has no wheels"));
    }
    let mut seen = HashSet::new();
    for wheel in &manifest.wheels {
        if !seen.insert(wheel.filename.clone()) {
            return Err(fail(format!(
                "portable bundle repeats a file path: {}",
                wheel.filename
            )));
        }
        let (name, version) = parse_wheel_filename(&wheel.filename)?;
        if name != wheel.name {
            return Err(fail(format!(
                "wheel filename does not match its recorded distribution: {}",
                wheel.filename
            )));
        }
        if version != wheel.version {
            return Err(fail(format!(
                "wheel filename does not match its recorded version: {}",
                wheel.filename
            )));
        }
        // The closure is engine-specific and cannot be allowlisted statically
        // (torch alone vendors a dozen `nvidia-*` wheels): membership in the
        // recorded closure plus the engine-minimum below is the gate, and the
        // post-install probe must still report the promised engine identity.
        if manifest
            .packages
            .get(&wheel.name)
            .is_none_or(|v| *v != wheel.version)
        {
            return Err(fail(format!(
                "wheel {} is not part of the recorded dependency closure",
                wheel.filename
            )));
        }
        if !is_hex_sha256(&wheel.sha256) {
            return Err(fail(format!(
                "wheel {} has no valid SHA-256 digest",
                wheel.filename
            )));
        }
        if wheel.size == 0 || wheel.size > MAX_PORTABLE_WHEEL_BYTES {
            return Err(fail(format!(
                "wheel {} has an invalid size",
                wheel.filename
            )));
        }
        if !valid_version(&wheel.version) {
            return Err(fail(format!("invalid version for {}", wheel.name)));
        }
        if !valid_distribution(&wheel.name) {
            return Err(fail(format!(
                "wheel {} has an invalid distribution name",
                wheel.filename
            )));
        }
    }
    for (name, version) in &manifest.packages {
        if !valid_distribution(name) {
            return Err(fail(format!("invalid distribution name: {name}")));
        }
        if !valid_version(version) {
            return Err(fail(format!("invalid version for {name}")));
        }
        if manifest.sources.get(name).is_none_or(|s| {
            *s != SOURCE_PYPI
                && *s != SOURCE_RELEASE_URL
                && !(s == "pinned-git"
                    && name == "mlx-lm"
                    && manifest.variant == metal_env::VARIANT)
        }) {
            return Err(fail(format!(
                "dependency {name} has no reproducible wheel source"
            )));
        }
        if !manifest.wheels.iter().any(|w| &w.name == name) {
            return Err(fail(format!(
                "dependency {name}=={version} has no vendored wheel"
            )));
        }
    }
    if manifest.sources.len() != manifest.packages.len()
        || manifest
            .sources
            .keys()
            .any(|name| !manifest.packages.contains_key(name))
    {
        return Err(fail(
            "portable bundle wheel sources do not match its dependency closure",
        ));
    }
    for required in required_packages(manifest.provider, &manifest.variant) {
        if !manifest.packages.contains_key(*required) {
            return Err(fail(format!(
                "portable bundle is missing the required dependency {required}"
            )));
        }
    }
    if manifest.variant == metal_env::VARIANT {
        if manifest.plugin_version != metal_env::VERSION
            || !matches!(
                manifest.version.as_str(),
                m if m == metal_env::VERSION || m == metal_env::CORE_VERSION
            )
        {
            return Err(fail(
                "portable vllm-metal bundle requires the pinned matched 0.30.0 core and plugin",
            ));
        }
        if manifest.mlx_version != metal_env::MLX_VERSION {
            return Err(fail(format!(
                "portable vllm-metal bundle requires mlx=={}",
                metal_env::MLX_VERSION
            )));
        }
        if manifest.mlx_lm_commit != metal_env::MLX_LM_COMMIT {
            return Err(fail(
                "portable vllm-metal bundle is missing the exact mlx-lm source revision",
            ));
        }
    }
    let encoded = serde_json::to_vec(manifest).map_err(|e| e.to_string())?;
    if encoded.len() as u64 > MAX_PORTABLE_MANIFEST_BYTES {
        return Err(fail("portable bundle manifest exceeds the size limit"));
    }
    // Personal paths and credentials must never cross machines in a bundle.
    let text = String::from_utf8_lossy(&encoded);
    let folded_text = text.to_lowercase();
    for marker in [
        "/home/",
        "/users/",
        "c:\\users",
        "c:/users",
        "\\\\",
        "api_key",
        "apikey",
        "auth_token",
        "hf_token",
        "password",
        "secret",
    ] {
        if folded_text.contains(marker) {
            return Err(fail(
                "portable bundle manifest must not contain personal paths or credentials",
            ));
        }
    }
    if text.contains("backend") || text.contains("build") {
        return Err(fail(
            "portable bundle manifest must keep provider identities separate from native build metadata",
        ));
    }
    let engine = python_env::package_name(manifest.provider);
    check_version_pair(
        engine,
        &manifest.version,
        manifest.packages.get(engine).map(String::as_str),
    )?;
    if manifest.variant == metal_env::VARIANT {
        check_version_pair(
            "vllm-metal",
            &manifest.plugin_version,
            manifest.packages.get("vllm-metal").map(String::as_str),
        )?;
    }
    if !manifest.mlx_version.is_empty()
        && (manifest.provider == ProviderId::MlxVlm || manifest.variant == metal_env::VARIANT)
    {
        check_version_pair(
            "mlx",
            &manifest.mlx_version,
            manifest.packages.get("mlx").map(String::as_str),
        )?;
    }
    Ok(())
}

/// Same-platform gate: a bundle installs only on the OS, architecture and
/// Python ABI family it was captured for. Metal additionally requires macOS
/// 15+ on Apple Silicon with the cp312 ABI.
pub fn check_compatible(
    manifest: &PortableManifest,
    current_os: &str,
    current_arch: &str,
) -> Result<(), AppError> {
    if manifest.platform.os != current_os {
        return Err(AppError::unavailable(format!(
            "portable bundle was built for {} but this host is {}",
            manifest.platform.os, current_os
        )));
    }
    if normalize_arch(&manifest.platform.arch) != normalize_arch(current_arch) {
        return Err(AppError::unavailable(format!(
            "portable bundle was built for {} but this host is {}",
            manifest.platform.arch, current_arch
        )));
    }
    let (major, minor) = python_env::parse_python_version(&manifest.platform.python_version)
        .ok_or_else(|| fail("portable bundle has no usable Python version"))?;
    if !python_env::python_supported(manifest.provider, major, minor) {
        return Err(fail(format!(
            "portable bundle needs Python {major}.{minor}, which {} does not support",
            python_env::package_name(manifest.provider)
        )));
    }
    if manifest.variant == metal_env::VARIANT {
        if manifest.platform.python_implementation != "CPython"
            || manifest.platform.python_abi != "cpython-312-darwin"
        {
            return Err(fail(
                "portable vllm-metal bundle requires the native CPython 3.12 (cp312) ABI",
            ));
        }
        let major_macos = manifest
            .platform
            .macos_version
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        if manifest.platform.os != "macos" || major_macos < 15 {
            return Err(fail(
                "portable vllm-metal bundle requires Apple Silicon macOS 15 or later",
            ));
        }
    }
    Ok(())
}

/// Base interpreter at import time must satisfy the same ABI the wheels were
/// captured for; otherwise pip would resolve an incompatible closure.
pub fn check_base_interpreter(
    manifest: &PortableManifest,
    base: &PortablePlatform,
) -> Result<(), AppError> {
    if normalize_arch(&base.arch) != normalize_arch(&manifest.platform.arch) {
        return Err(fail(
            "the selected base interpreter has an incompatible architecture",
        ));
    }
    if manifest.variant == metal_env::VARIANT {
        if base.python_implementation != "CPython" || base.python_abi != "cpython-312-darwin" {
            return Err(fail(
                "vllm-metal release wheels require native CPython 3.12 (cp312 ABI)",
            ));
        }
    } else {
        let bundle_tag = abi_python_tag(&manifest.platform.python_abi);
        let base_tag = abi_python_tag(&base.python_abi);
        if bundle_tag.is_some() && base_tag.is_some() && bundle_tag != base_tag {
            return Err(fail(
                "the selected base interpreter ABI does not match the portable bundle",
            ));
        }
        let (major, minor) = python_env::parse_python_version(&base.python_version)
            .ok_or_else(|| fail("the selected base interpreter has no usable Python version"))?;
        if !python_env::python_supported(manifest.provider, major, minor) {
            return Err(fail(format!(
                "{} requires a different Python version than {major}.{minor}",
                python_env::package_name(manifest.provider)
            )));
        }
    }
    Ok(())
}

fn abi_python_tag(abi: &str) -> Option<String> {
    // `cpython-312-x86_64-linux-gnu` -> `cp312`; `cp312` passes through.
    let lower = abi.to_lowercase();
    if let Some(rest) = lower.strip_prefix("cpython-") {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 2 {
            return Some(format!("cp{digits}"));
        }
    }
    if lower.starts_with("cp") && lower[2..].chars().take(3).all(|c| c.is_ascii_digit()) {
        return Some(lower.chars().take(5).collect());
    }
    None
}

#[cfg(test)]
fn sha256_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file_cancellable(path: &Path, cancel: &AtomicBool) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(|e| AppError::from_io(&e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        ensure_not_cancelled(cancel)?;
        let read = file.read(&mut buffer).map_err(|e| AppError::from_io(&e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Fresh portable identity. Import never reuses an existing id, so it can
/// never replace another runtime.
pub fn portable_id(version: &str) -> String {
    let slug: String = version
        .chars()
        .map(|v| {
            if v.is_ascii_alphanumeric() {
                v.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let rand = &uuid::Uuid::new_v4().simple().to_string()[..12];
    let slug = &slug[..slug.len().min(64 - "portable-".len() - 1 - rand.len())];
    format!("portable-{slug}-{rand}")
}

#[cfg(test)]
fn provider_root(provider: ProviderId) -> PathBuf {
    python_env::providers_root().join(provider.as_str())
}

fn ensure_not_cancelled(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Acquire) {
        Err(AppError::cancelled("portable runtime operation cancelled"))
    } else {
        Ok(())
    }
}

/// Write one bundle archive from a validated manifest and a directory of
/// wheel files. The archive is built at a temp path and renamed once, so a
/// failed or cancelled export never leaves a partial bundle behind.
pub fn write_archive(
    manifest: &PortableManifest,
    wheels_dir: &Path,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<PortableExportInfo, AppError> {
    validate_manifest(manifest)?;
    let output_name = output
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| fail("export path has no valid filename"))?;
    if !output_name.to_ascii_lowercase().ends_with(".zip") {
        return Err(fail("portable export must use a .zip filename"));
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| AppError::from_io(&e))?;
    let mut total: u64 = 0;
    for wheel in &manifest.wheels {
        ensure_not_cancelled(cancel)?;
        let path = wheels_dir.join(&wheel.filename);
        let metadata = fs::symlink_metadata(&path).map_err(|e| AppError::from_io(&e))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != wheel.size
        {
            return Err(fail(format!(
                "wheel changed while exporting: {}",
                wheel.filename
            )));
        }
        if sha256_file_cancellable(&path, cancel)? != wheel.sha256.to_lowercase() {
            return Err(fail(format!(
                "wheel hash mismatch while exporting: {}",
                wheel.filename
            )));
        }
        total = total
            .checked_add(wheel.size)
            .ok_or_else(|| fail("portable bundle exceeds the size limit"))?;
        if total > MAX_PORTABLE_EXTRACTED_BYTES {
            return Err(fail("portable bundle exceeds the size limit"));
        }
    }
    let manifest_bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    if manifest_bytes.len() as u64 > MAX_PORTABLE_MANIFEST_BYTES {
        return Err(fail("portable bundle manifest exceeds the size limit"));
    }
    let temp = parent.join(format!(".{output_name}.part-{}", short_nonce()));
    let result = (|| -> Result<PortableExportInfo, AppError> {
        let file = fs::File::create(&temp).map_err(|e| AppError::from_io(&e))?;
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        archive
            .start_file(PORTABLE_MANIFEST_NAME, options)
            .map_err(|e| e.to_string())?;
        archive
            .write_all(&manifest_bytes)
            .map_err(|e| AppError::from_io(&e))?;
        for wheel in &manifest.wheels {
            ensure_not_cancelled(cancel)?;
            archive
                .start_file(format!("{PORTABLE_WHEELS_DIR}/{}", wheel.filename), options)
                .map_err(|e| e.to_string())?;
            let mut input = fs::File::open(wheels_dir.join(&wheel.filename))
                .map_err(|e| AppError::from_io(&e))?;
            let (size, digest) = copy_hashed(&mut input, &mut archive, wheel.size, cancel)?;
            if size != wheel.size || digest != wheel.sha256.to_lowercase() {
                return Err(fail(format!(
                    "wheel changed while exporting: {}",
                    wheel.filename
                )));
            }
        }
        archive.finish().map_err(|e| e.to_string())?;
        let bytes = fs::metadata(&temp)
            .map_err(|e| AppError::from_io(&e))?
            .len();
        if bytes > MAX_PORTABLE_ARCHIVE_BYTES {
            return Err(fail(
                "exported portable bundle exceeds the archive size limit",
            ));
        }
        let digest = sha256_file_cancellable(&temp, cancel)?;
        if output.is_dir() {
            return Err(fail(format!(
                "export path is a directory: {}",
                output.display()
            )));
        }
        if output.exists() {
            return Err(fail("export path already exists; choose a new .zip file"));
        }
        fs::rename(&temp, output).map_err(|e| AppError::from_io(&e))?;
        Ok(PortableExportInfo {
            path: output.to_string_lossy().into_owned(),
            provider: manifest.provider,
            runtime_id: String::new(),
            variant: manifest.variant.clone(),
            version: manifest.version.clone(),
            archive_sha256: digest,
            bytes,
            wheels: manifest.wheels.len(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn short_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_owned()
}

/// Copy large wheels with fixed memory, checking cancellation every chunk.
fn copy_hashed(
    input: &mut impl Read,
    output: &mut impl Write,
    max: u64,
    cancel: &AtomicBool,
) -> Result<(u64, String), AppError> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        ensure_not_cancelled(cancel)?;
        let count = input.read(&mut buffer).map_err(|e| AppError::from_io(&e))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| fail("wheel exceeds its declared size"))?;
        if total > max {
            return Err(fail("wheel exceeds its declared size"));
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| AppError::from_io(&e))?;
        hasher.update(&buffer[..count]);
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn create_staging(home: &Path, purpose: &str) -> Result<StagingCleanup, AppError> {
    let mut home_builder = fs::DirBuilder::new();
    home_builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut home_builder, 0o700);
    home_builder
        .create(home)
        .map_err(|error| AppError::from_io(&error))?;
    let path = home.join(format!(
        "portable-{purpose}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(&path)
        .map_err(|error| AppError::from_io(&error))?;
    Ok(StagingCleanup(path))
}

/// Read and fully verify one bundle archive: bounds, entry policy (no path
/// escapes, no symlinks, no collisions, wheels only), manifest schema,
/// wheel hashes and sizes. Pure filesystem work: nothing is executed.
fn read_archive_files(
    archive: &Path,
    cancel: &AtomicBool,
    home: &Path,
) -> Result<(PortableManifest, StagingCleanup), AppError> {
    let metadata = fs::metadata(archive).map_err(|e| AppError::from_io(&e))?;
    if !metadata.is_file() {
        return Err(fail("portable bundle path is not a file"));
    }
    if metadata.len() > MAX_PORTABLE_ARCHIVE_BYTES {
        return Err(fail("portable bundle exceeds the archive size limit"));
    }
    let file = fs::File::open(archive).map_err(|e| AppError::from_io(&e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| AppError::validation(e.to_string()))?;
    if zip.len() > MAX_PORTABLE_ENTRIES {
        return Err(fail("portable bundle contains too many entries"));
    }
    let mut seen = HashSet::new();
    let mut manifest_bytes: Option<Vec<u8>> = None;
    let staging = create_staging(home, "import")?;
    let mut wheels: BTreeMap<String, (u64, String)> = BTreeMap::new();
    let mut total: u64 = 0;
    for index in 0..zip.len() {
        ensure_not_cancelled(cancel)?;
        let mut entry = zip
            .by_index(index)
            .map_err(|e| AppError::validation(e.to_string()))?;
        let mode = entry.unix_mode();
        if mode.is_some_and(|m| (m & 0o170000) == 0o120000) {
            return Err(fail("portable bundle contains a symbolic link"));
        }
        let name = entry
            .name()
            .map_err(|e| AppError::validation(e.to_string()))?
            .into_owned();
        let relative = safe_archive_path(&name)?;
        if !seen.insert(relative.clone()) {
            return Err(fail(format!("portable bundle repeats a file path: {name}")));
        }
        if entry.is_dir() {
            return Err(fail(format!(
                "unexpected directory in portable bundle: {name}"
            )));
        }
        let size = entry.size();
        if size > MAX_PORTABLE_WHEEL_BYTES && name != PORTABLE_MANIFEST_NAME {
            return Err(fail(format!("portable bundle entry is too large: {name}")));
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| fail("portable bundle exceeds the size limit"))?;
        if total > MAX_PORTABLE_EXTRACTED_BYTES {
            return Err(fail("portable bundle exceeds the size limit"));
        }
        if name == PORTABLE_MANIFEST_NAME {
            if size > MAX_PORTABLE_MANIFEST_BYTES {
                return Err(fail("portable bundle manifest exceeds the size limit"));
            }
            let mut bytes = Vec::new();
            entry
                .take(size.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 != size {
                return Err(fail("invalid manifest size"));
            }
            manifest_bytes = Some(bytes);
        } else {
            let filename = relative.file_name().unwrap().to_string_lossy().into_owned();
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.0.join(&filename))
                .map_err(|e| e.to_string())?;
            let verified = copy_hashed(&mut entry, &mut output, size, cancel)?;
            if verified.0 != size {
                return Err(fail("invalid wheel size"));
            }
            wheels.insert(filename, verified);
        }
    }
    let manifest_bytes = manifest_bytes.ok_or_else(|| fail("portable bundle has no manifest"))?;
    let manifest: PortableManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::validation(format!("invalid portable bundle manifest: {e}")))?;
    validate_manifest(&manifest)?;
    if wheels.len() != manifest.wheels.len() {
        return Err(fail(
            "portable bundle wheel count does not match its manifest",
        ));
    }
    for wheel in &manifest.wheels {
        ensure_not_cancelled(cancel)?;
        let (size, digest) = wheels.get(&wheel.filename).ok_or_else(|| {
            fail(format!(
                "portable bundle is missing wheel {}",
                wheel.filename
            ))
        })?;
        if *size != wheel.size {
            return Err(fail(format!(
                "wheel {} has an unexpected size",
                wheel.filename
            )));
        }
        if *digest != wheel.sha256.to_lowercase() {
            return Err(fail(format!(
                "wheel {} failed its SHA-256 check",
                wheel.filename
            )));
        }
    }
    Ok((manifest, staging))
}

/// Small synthetic fixtures use the same streamed verifier as production.
#[cfg(test)]
type VerifiedFixtureBundle = (PortableManifest, Vec<(String, Vec<u8>)>);

#[cfg(test)]
fn read_archive(archive: &Path, cancel: &AtomicBool) -> Result<VerifiedFixtureBundle, AppError> {
    let (manifest, staging) = read_archive_files(archive, cancel, archive.parent().unwrap())?;
    let wheels = manifest
        .wheels
        .iter()
        .map(|wheel| {
            fs::read(staging.0.join(&wheel.filename))
                .map(|bytes| (wheel.filename.clone(), bytes))
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((manifest, wheels))
}

/// Post-install gate: the fresh probe must report the same engine identity
/// the bundle promised, pass the unchanged readiness rules, and preserve the
/// Metal core/plugin/MLX ABI with the exact mlx-lm source revision.
pub fn check_imported_probe(
    manifest: &PortableManifest,
    probe: &python_env::ProbeRecord,
) -> Result<(), AppError> {
    if !probe.errors.is_empty() {
        return Err(AppError::unavailable(format!(
            "imported runtime probe did not establish readiness: {}",
            probe.errors.join("; ")
        )));
    }
    if probe.version.is_empty() {
        return Err(AppError::unavailable(
            "imported engine did not import after installation",
        ));
    }
    let imported_core = if probe.version == metal_env::CORE_VERSION
        && probe.imported_version == metal_env::VERSION
    {
        // The pinned CPU core reports its public version without the local
        // build suffix once imported; the distribution metadata keeps it.
        metal_env::CORE_VERSION
    } else {
        probe.imported_version.as_str()
    };
    if imported_core != manifest.version
        && !(manifest.version == metal_env::CORE_VERSION
            && probe.imported_version == metal_env::VERSION)
        && probe.version != manifest.version
    {
        return Err(fail(format!(
            "imported engine version {} does not match the bundle {}",
            probe.version, manifest.version
        )));
    }
    if manifest.variant == metal_env::VARIANT {
        if probe.variant != metal_env::VARIANT {
            return Err(fail(
                "imported runtime did not report the vllm-metal variant",
            ));
        }
        if probe.metal_version != manifest.plugin_version {
            return Err(fail(
                "imported vllm-metal plugin version differs from the bundle",
            ));
        }
        if probe.mlx_version != manifest.mlx_version {
            return Err(fail("imported MLX version differs from the bundle"));
        }
        let commit = probe
            .package_versions
            .get("mlx-lm-commit")
            .cloned()
            .unwrap_or_default()
            .to_lowercase();
        if commit != manifest.mlx_lm_commit.to_lowercase() {
            return Err(fail(
                "imported mlx-lm source revision differs from the portable bundle",
            ));
        }
        let problems = metal_env::probe_problems(probe);
        if !problems.is_empty() {
            return Err(fail(format!(
                "imported vllm-metal runtime is not ready: {}",
                problems.join("; ")
            )));
        }
    }
    Ok(())
}

/// Minimal interpreter provenance for a candidate base interpreter. Reads
/// version/architecture/ABI only; never imports engine packages.
pub fn base_platform_of(python: &Path) -> Result<PortablePlatform, AppError> {
    let record = python_env::interpreter_provenance(python, None)?;
    Ok(PortablePlatform {
        os: match record.platform_system.as_str() {
            "Darwin" => "macos",
            "Linux" => "linux",
            "Windows" => "windows",
            other => other,
        }
        .to_owned(),
        arch: record.python_arch,
        python_version: record.python_version,
        python_implementation: record.python_implementation,
        python_abi: record.python_abi,
        macos_version: record.macos_version,
    })
}

/// Full export: validate the registration, inventory the exact installed
/// closure once, gather its wheels with `pip download --only-binary=:all:`
/// into private staging (read-only against the source interpreter, so external
/// environments are never mutated), seal the archive atomically, and clean
/// staging on every exit path. Shared by the desktop IPC command and the
/// headless CLI.
pub async fn export_bundle(
    provider: ProviderId,
    id: &str,
    output: &Path,
    cancel: Arc<AtomicBool>,
    progress: impl FnMut(PortableProgress) + Send,
) -> Result<PortableExportInfo, AppError> {
    ensure_not_cancelled(cancel.as_ref())?;
    let mut manifest = tokio::task::spawn_blocking({
        let id = id.to_owned();
        move || python_env::read(provider, &id)
    })
    .await
    .map_err(AppError::from)??;
    manifest.probe = Some(
        python_env::probe_interpreter(
            provider,
            Path::new(&manifest.python),
            manifest.kind,
            Some(cancel.clone()),
        )
        .await?,
    );
    // One inventory read feeds the recipe, the download pins and the wheel
    // inventory alike, so the environment cannot skew between them.
    let source_python = PathBuf::from(&manifest.python);
    let inventory_cancel = cancel.clone();
    let freeze = tokio::task::spawn_blocking(move || {
        read_freeze_cancellable(provider, &source_python, Some(inventory_cancel.as_ref()))
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                crate::error::ErrorKind::Cancelled
            } else {
                crate::error::ErrorKind::Internal
            },
            format!("portable export task failed: {error}"),
        )
    })??;
    let (manifest, freeze, recipe, external_before, staging_guard) =
        tokio::task::spawn_blocking(move || {
            let recipe = build_export_manifest(&manifest, &freeze)?;
            let external_before = (manifest.kind == python_env::InstallationKind::External)
                .then(|| fingerprint_dir(Path::new(&manifest.python).parent()));
            let staging = create_staging(&crate::home::resolve_aiolm_home()?, "export")?;
            Ok::<_, AppError>((manifest, freeze, recipe, external_before, staging))
        })
        .await
        .map_err(AppError::from)??;
    let wheels = staging_guard.0.join("wheels");
    download_wheels(
        Path::new(&manifest.python),
        &manifest.id,
        &recipe,
        &freeze,
        &wheels,
        cancel.clone(),
        progress,
    )
    .await?;
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("portable runtime operation cancelled"));
    }
    let output_owned = output.to_path_buf();
    let recipe_owned = recipe.clone();
    let id_owned = manifest.id.clone();
    let info = tokio::task::spawn_blocking(move || {
        let _staging_guard = staging_guard;
        export_with_wheels(
            provider,
            &id_owned,
            &recipe_owned,
            &wheels,
            &output_owned,
            cancel.as_ref(),
        )
        .map(|mut info| {
            info.runtime_id = id_owned.clone();
            info
        })
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                crate::error::ErrorKind::Cancelled
            } else {
                crate::error::ErrorKind::Internal
            },
            format!("portable export task failed: {error}"),
        )
    })??;
    if let Some(before) = external_before {
        let after = tokio::task::spawn_blocking(move || {
            fingerprint_dir(Path::new(&manifest.python).parent())
        })
        .await
        .map_err(AppError::from)?;
        if before != after {
            return Err(fail(
                "portable export must never mutate an external environment",
            ));
        }
    }
    Ok(info)
}

/// Seal one classified recipe with already-staged wheels. Every staged wheel
/// must belong to the closure and every closure member needs exactly one
/// wheel: extras mean `pip download` resolved undeclared dependencies and the
/// offline import would be incomplete, so they fail instead of being dropped.
pub fn export_with_wheels(
    provider: ProviderId,
    id: &str,
    recipe: &PortableManifest,
    wheels_dir: &Path,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<PortableExportInfo, AppError> {
    ensure_not_cancelled(cancel)?;
    if recipe.provider != provider {
        return Err(fail("portable recipe describes a different provider"));
    }
    let manifest = python_env::read(provider, id)?;
    if manifest.id != id {
        return Err(fail("portable recipe describes a different runtime"));
    }
    let mut full = recipe.clone();
    full.wheels = inventory_wheels_cancellable(recipe, wheels_dir, cancel)?;
    validate_manifest(&full)?;
    let mut info = write_archive(&full, wheels_dir, output, cancel)?;
    info.runtime_id = manifest.id.clone();
    Ok(info)
}

/// Inventory the staged wheels against the recipe: every closure member needs
/// exactly one wheel whose name, version, size and hash match, and no staged
/// file may fall outside the closure.
#[cfg(test)]
fn inventory_wheels(
    recipe: &PortableManifest,
    wheels_dir: &Path,
) -> Result<Vec<PortableWheel>, AppError> {
    inventory_wheels_cancellable(recipe, wheels_dir, &AtomicBool::new(false))
}

fn inventory_wheels_cancellable(
    recipe: &PortableManifest,
    wheels_dir: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<PortableWheel>, AppError> {
    let entries = fs::read_dir(wheels_dir).map_err(|e| {
        AppError::new(
            AppError::from_io(&e).kind,
            format!("missing staged wheels: {e}"),
        )
    })?;
    let mut staged: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let filename = entry.file_name().to_string_lossy().into_owned();
        if !filename.ends_with(".whl") {
            return Err(fail(format!("unsupported distribution file: {filename}")));
        }
        // Every staged file must parse as a wheel before anything else.
        parse_wheel_filename(&filename)?;
        staged.push(filename);
    }
    staged.sort();
    let mut wheels = Vec::new();
    for (name, version) in &recipe.packages {
        ensure_not_cancelled(cancel)?;
        let matches: Vec<&String> = staged
            .iter()
            .filter(|filename| {
                parse_wheel_filename(filename)
                    .is_ok_and(|(dist, ver)| &dist == name && &ver == version)
            })
            .collect();
        if matches.len() != 1 {
            return Err(fail(format!(
                "dependency {name}=={version} needs exactly one vendored wheel"
            )));
        }
        let filename = matches[0].clone();
        let path = wheels_dir.join(&filename);
        let metadata = fs::symlink_metadata(&path).map_err(|e| AppError::from_io(&e))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_PORTABLE_WHEEL_BYTES
        {
            return Err(fail(format!("wheel {filename} exceeds the size limit")));
        }
        wheels.push(PortableWheel {
            name: name.clone(),
            version: version.clone(),
            filename: filename.clone(),
            sha256: sha256_file_cancellable(&path, cancel)?,
            size: metadata.len(),
        });
    }
    // Anything staged but not in the closure is an undeclared dependency the
    // offline import could not verify: fail instead of silently dropping it.
    for filename in &staged {
        if !wheels.iter().any(|w| &w.filename == filename) {
            return Err(fail(format!(
                "staged wheel {filename} is not part of the recorded dependency closure"
            )));
        }
    }
    wheels.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(wheels)
}

fn fingerprint_dir(dir: Option<&Path>) -> String {
    let Some(dir) = dir else {
        return String::new();
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return String::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names.join("\0")
}

/// Gather exact wheels for an export without touching the source environment:
/// `pip download --only-binary=:all:` writes into staging only and never
/// installs, upgrades or builds anything in the runtime. Pins come from the
/// single classified freeze behind `recipe`, so no undeclared latest
/// dependency can slip in.
pub async fn download_wheels(
    python: &Path,
    id: &str,
    recipe: &PortableManifest,
    freeze: &FreezeMap,
    dest: &Path,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(PortableProgress) + Send,
) -> Result<(), AppError> {
    tokio::fs::create_dir_all(dest)
        .await
        .map_err(|e| AppError::from_io(&e))?;
    if recipe
        .sources
        .get("mlx-lm")
        .is_some_and(|source| source == "pinned-git")
    {
        let capture = format!(
            "{}\n{}",
            include_str!("portable_source_probe.py"),
            include_str!("portable_git_wheel.py")
        );
        run_logged(
            python,
            &[
                "-I",
                "-c",
                &capture,
                metal_env::MLX_LM_COMMIT,
                &dest.to_string_lossy(),
            ],
            &cancel,
            |_| {},
            LoggedOperation::Portable,
        )
        .await?;
    }
    let pins = download_args(freeze, &recipe.sources, &recipe.variant);
    let dest_arg = dest.to_string_lossy().into_owned();
    let mut args = vec![
        "-I",
        "-m",
        "pip",
        "download",
        "--no-cache-dir",
        "--no-deps",
        "--only-binary=:all:",
        "--no-input",
        "--disable-pip-version-check",
        "--dest",
        dest_arg.as_str(),
    ];
    let owned: Vec<String> = pins;
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    args.extend(refs);
    let id_owned = id.to_owned();
    let provider = recipe.provider;
    run_logged(
        python,
        &args,
        &cancel,
        |line| {
            progress(PortableProgress {
                provider,
                id: id_owned.clone(),
                phase: "packages",
                line,
            })
        },
        LoggedOperation::Portable,
    )
    .await
}

/// Import one bundle into a new app-owned isolated environment. Every stage is
/// cancellable; failure or cancellation removes the new directory and never
/// publishes a manifest, replaces another runtime, or touches user
/// interpreters. Installation uses only the vendored wheels, offline.
pub async fn import_bundle(
    archive: &Path,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(PortableProgress) + Send,
) -> Result<python_env::PythonRuntimeManifest, AppError> {
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("portable runtime operation cancelled"));
    }
    // The live token travels into the blocking reader: snapshotting its
    // boolean here would let a mid-read cancellation go unnoticed.
    let read_cancel = cancel.clone();
    let (manifest, wheels) = tokio::task::spawn_blocking({
        let archive = archive.to_path_buf();
        move || {
            read_archive_files(
                &archive,
                read_cancel.as_ref(),
                &crate::home::resolve_aiolm_home()?,
            )
        }
    })
    .await
    .map_err(AppError::from)??;
    check_compatible(&manifest, current_os(), current_arch())?;
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("portable runtime operation cancelled"));
    }
    // Allocate the new identity before doing any work: the directory is
    // created empty and owned by us, and an existing runtime is never reused.
    let id = portable_id(&manifest.version);
    python_env::validate_id(&id)?;
    let cleanup = tokio::task::spawn_blocking({
        let provider = manifest.provider;
        let id = id.clone();
        move || python_env::create_managed_target(provider, &id)
    })
    .await
    .map_err(AppError::from)??;
    let target = cleanup.0.clone();
    let mut emit = |phase: &'static str, line: String| {
        progress(PortableProgress {
            provider: manifest.provider,
            id: id.clone(),
            phase,
            line,
        })
    };
    let result = import_into(&manifest, &wheels.0, &target, &id, &cancel, &mut emit).await;
    match result {
        Ok(record) => {
            let stored = python_env::PythonRuntimeManifest {
                format: RUNTIME_MANIFEST_FORMAT,
                provider: manifest.provider,
                id: id.clone(),
                kind: python_env::InstallationKind::Managed,
                python: venv_python(&target.join("venv"))
                    .to_string_lossy()
                    .into_owned(),
                requested_version: Some(manifest.version.clone()),
                probe: Some(record),
            };
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::cancelled("portable runtime operation cancelled"));
            }
            let published = tokio::task::spawn_blocking(move || {
                let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
                crate::config::atomic_write(&target.join(RUNTIME_MANIFEST_FILE), &bytes)?;
                // Re-read through the public loader before publishing.
                let published = python_env::read(stored.provider, &stored.id)?;
                cleanup.persist();
                Ok::<_, AppError>(published)
            })
            .await
            .map_err(AppError::from)??;
            emit("complete", String::new());
            Ok(published)
        }
        Err(error) => Err(error),
    }
}

async fn import_into(
    manifest: &PortableManifest,
    links: &Path,
    target: &Path,
    id: &str,
    cancel: &Arc<AtomicBool>,
    emit: &mut (impl FnMut(&'static str, String) + Send),
) -> Result<python_env::ProbeRecord, AppError> {
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("portable runtime operation cancelled"));
    }
    // Choose a base interpreter whose ABI matches the bundle before creating
    // anything executable.
    let bases = tokio::task::spawn_blocking({
        let provider = manifest.provider;
        let cancel = cancel.clone();
        move || {
            let found = python_env::discover_base_interpreters(provider);
            if cancel.load(Ordering::Acquire) {
                return Vec::new();
            }
            found
        }
    })
    .await
    .map_err(AppError::from)?;
    let mut base: Option<(PathBuf, PortablePlatform)> = None;
    for candidate in bases {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("portable runtime operation cancelled"));
        }
        let platform = tokio::task::spawn_blocking({
            let candidate = candidate.clone();
            move || base_platform_of(&candidate)
        })
        .await
        .map_err(AppError::from)?
        .ok();
        if let Some(platform) = platform {
            if check_base_interpreter(manifest, &platform).is_ok() {
                // Metal additionally requires the host to be eligible now, not
                // just the bundle to have been captured on one.
                if manifest.variant == metal_env::VARIANT {
                    let probe_like = python_env::ProbeRecord {
                        variant: metal_env::VARIANT.into(),
                        python_version: platform.python_version.clone(),
                        python_arch: platform.arch.clone(),
                        python_implementation: platform.python_implementation.clone(),
                        python_abi: platform.python_abi.clone(),
                        platform_system: match platform.os.as_str() {
                            "macos" => "Darwin".to_owned(),
                            "linux" => "Linux".to_owned(),
                            "windows" => "Windows".to_owned(),
                            _ => platform.os.clone(),
                        },
                        macos_version: platform.macos_version.clone(),
                        ..Default::default()
                    };
                    if !metal_env::interpreter_problems(&probe_like).is_empty() {
                        continue;
                    }
                }
                base = Some((candidate, platform));
                break;
            }
        }
    }
    let (base, _) = base.ok_or_else(|| {
        AppError::unavailable(
            "no base Python interpreter on this machine matches the portable bundle ABI",
        )
    })?;
    emit(
        "environment",
        format!("creating environment with {}", base.display()),
    );
    let venv = target.join("venv");
    run_logged(
        &base,
        &["-I", "-m", "venv", &venv.to_string_lossy()],
        cancel,
        |line| emit("environment", line),
        LoggedOperation::Portable,
    )
    .await?;
    // The verifier owns a private wheel directory until installation finishes.
    // The venv is created at its permanent path because venvs cannot be moved.
    // Install in manifest order so the engine and its pinned closure resolve
    // from local files only.
    let mut pins: Vec<String> = manifest
        .packages
        .iter()
        .map(|(name, version)| format!("{name}=={version}"))
        .collect();
    pins.sort();
    let links_arg = links.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec![
        "-I",
        "-m",
        "pip",
        "install",
        "--no-index",
        "--no-deps",
        "--only-binary=:all:",
        "--no-input",
        "--disable-pip-version-check",
        "--find-links",
        links_arg.as_str(),
    ];
    let owned = pins;
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    args.extend(refs);
    emit(
        "packages",
        format!("installing {} offline from bundle wheels", manifest.version),
    );
    let python = venv_python(&venv);
    run_logged(
        &python,
        &args,
        cancel,
        |line| emit("packages", line),
        LoggedOperation::Portable,
    )
    .await?;
    run_logged(
        &python,
        &["-I", "-m", "pip", "check"],
        cancel,
        |line| emit("packages", line),
        LoggedOperation::Portable,
    )
    .await?;
    emit("probe", String::new());
    let record = python_env::probe_interpreter(
        manifest.provider,
        &python,
        python_env::InstallationKind::Managed,
        Some(cancel.clone()),
    )
    .await?;
    check_imported_probe(manifest, &record)?;
    // The shared readiness rules still apply on top: an import that probes
    // unhealthy is removed, never published.
    let check = python_env::PythonRuntimeManifest {
        format: RUNTIME_MANIFEST_FORMAT,
        provider: manifest.provider,
        id: id.to_owned(),
        kind: python_env::InstallationKind::Managed,
        python: python.to_string_lossy().into_owned(),
        requested_version: Some(manifest.version.clone()),
        probe: Some(record.clone()),
    };
    let problems = tokio::task::spawn_blocking(move || check.problems())
        .await
        .map_err(AppError::from)?;
    if !problems.is_empty() {
        return Err(AppError::unavailable(format!(
            "imported runtime is not ready: {}",
            problems.join("; ")
        )));
    }
    Ok(record)
}

#[cfg(test)]
#[path = "portable_tests.rs"]
mod tests;
