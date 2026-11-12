//! Managed runtime identity and the public API for installation, probing, and portable bundles.
//! Implementation lives in focused child modules; callers keep using this facade.
use crate::error::AppError;
use crate::process_output::{
    drain_stream, drain_stream_into, read_log, shared_log, Retain, SharedLog,
};
use crate::procutil::{OwnedTask, TransientChild};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

mod build;
mod bundles;
mod cleanup;
mod dependencies;
mod download;
mod environment;
mod github;
mod install;
mod manifests;
mod probe;
mod toolchain;

use build::*;
use bundles::*;
use cleanup::*;
use dependencies::*;
use download::*;
use environment::*;
use github::*;
use install::*;
use manifests::*;
use probe::*;
use toolchain::*;

pub use build::SOURCE_BUILD_TARGETS;
pub use bundles::export_bundle;
pub use bundles::import_bundle;
pub use cleanup::sweep_orphaned_work;
pub use dependencies::repair_runtime_dependencies;
pub use download::download_verified;
pub use download::file_sha256;
pub use environment::child_environment;
pub use environment::child_environment_for_runtime;
pub use github::catalog_supports;
pub use github::clear_api_cache;
pub use github::companion_asset_name;
pub use github::latest_build;
pub use github::latest_for;
#[cfg(feature = "test-fixtures")]
pub use github::preload_pull_request;
#[cfg(feature = "test-fixtures")]
pub use github::preload_release_catalog;
pub use github::pull_request_build_id;
pub use github::pull_request_preview;
pub use install::install;
pub use install::install_pr;
pub use install::install_pr_with;
pub use install::install_with;
pub use probe::probe;
pub use probe::probe_cancellable;
pub use probe::run_runtime_tool;
pub use toolchain::source_build_preflight;
pub use toolchain::validate_source_build_backend;
pub use toolchain::SOURCE_BUILD_BACKENDS;

const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

const MAX_ARCHIVE_ENTRIES: usize = 100_000;

const MAX_EXTRACTED_BYTES: u64 = 16 * 1024 * 1024 * 1024;

const MAX_PROBE_OUTPUT: usize = 256 * 1024;

/// A CMake configure or build easily emits megabytes of text. Keep only the
/// end of it: the diagnostic that explains a failure is always the last thing
/// the toolchain printed, never the banner it started with.
const MAX_BUILD_LOG_TAIL: usize = 256 * 1024;

const MAX_BUILD_DETAIL_CHARS: usize = 4096;

// macOS CPU archives also contain Metal. Metal caches its initialization per
// executable path, so the first probe after activation (which renames the
// staged runtime) starts cold. That took about 20 seconds on hosted Apple
// silicon and 32-35 seconds on hosted Intel, then 0.2 seconds once cached.
// Keep interactive probes bounded while allowing that initialization to finish.
#[cfg(target_os = "macos")]
const PROBE_TIMEOUT: Duration = Duration::from_secs(90);

#[cfg(not(target_os = "macos"))]
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// The staged preflight is the very first execution of a just-extracted
/// runtime, so Windows still has to page in and virus-scan 100-250 MB of fresh
/// binaries before `main` runs. That routinely blows past the interactive probe
/// budget; subsequent launches are instant once the scanner has cached them.
const STAGED_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(180);

const PROBE_READER_TIMEOUT: Duration = Duration::from_secs(1);

/// A child that has exited already closed both pipes, so the drain tasks end
/// at once; this budget only covers grandchildren (ninja, cl.exe) that
/// inherited the handles and briefly outlive the CMake driver.
const BUILD_READER_TIMEOUT: Duration = Duration::from_secs(30);

/// After a cancel the process tree is already killed, so waiting for trailing
/// bytes would only delay the error the user asked for.
const CANCEL_READER_TIMEOUT: Duration = Duration::from_secs(2);

/// CMake configure can briefly detect a GPU toolchain or fetch a dependency,
/// which the codebase has already seen take about ten minutes; this is a
/// conservative ceiling for a stuck network probe or antivirus scan, not a
/// target duration.
const CMAKE_CONFIGURE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A from-source build compiles every requested GGML backend variant, which
/// can run long on a slow machine. This bounds a hung compiler or linker
/// without cutting off a legitimate long build.
const CMAKE_BUILD_TIMEOUT: Duration = Duration::from_secs(3 * 60 * 60);

/// Backends the release catalog can install. Single source of truth for both
/// the downloader and the recommendation policy.
pub const CATALOG_BACKENDS: &[&str] =
    &["rocm", "vulkan", "cuda", "sycl", "openvino", "cpu", "metal"];

#[path = "runtime_archive.rs"]
mod archive;

#[cfg(target_os = "linux")]
#[path = "runtime_elf.rs"]
mod elf;

/// Sidecar file recording what `llama-server --version` reported, so the UI can
/// show a real version instead of only the `bNNNN` CI build tag. GitHub's
/// release metadata carries the build tag alone, so this is the only source.
const VERSION_MANIFEST: &str = "aiolm-runtime.json";

const SOURCE_MANIFEST: &str = "aiolm-runtime-source.json";

const RUNTIME_BUNDLE_MANIFEST: &str = "aiolm-runtime-bundle.json";

const RUNTIME_BUNDLE_FORMAT: u32 = 1;

pub const DFLASH2_PR_BUILD: &str = "pr27342";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeVersion {
    /// e.g. "0.3.0-dev"
    pub semver: String,
    /// e.g. 10638
    pub build: u64,
    /// e.g. "bf9421646"
    pub commit: String,
}

/// Extra provenance for a runtime built from an upstream pull request.
/// Release archives do not carry this field.
///
/// Every field is recorded as it was at the moment the build started, so a
/// runtime that is still installed months later can still be traced back to
/// the exact tree it came from even after the PR is merged, closed, renamed,
/// force-pushed, or its fork deleted.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct RuntimeSource {
    pub pull_request: u64,
    /// Head repository, e.g. `ggml-org/llama.cpp` or a contributor's fork.
    pub repository: String,
    /// Head branch name at build time. A branch can be force-pushed or
    /// deleted, so this is a label, not an identity - `commit` is the identity.
    #[serde(default)]
    pub head_ref: String,
    /// Login of the account that opened the pull request.
    #[serde(default)]
    pub author: String,
    /// `open`, `closed` or `merged`, as of the build.
    #[serde(default)]
    pub state: String,
    /// True when the head repository is not `ggml-org/llama.cpp`.
    #[serde(default)]
    pub fork: bool,
    /// The full 40-character head commit. This is the only field that
    /// identifies the source tree; everything else can change under it.
    pub commit: String,
    /// SHA-256 of the archive as *this machine downloaded it*, computed here.
    ///
    /// GitHub publishes no digest for a source archive, so this is a record of
    /// what was built - useful for comparing two installs and for audit - and
    /// is explicitly not an independent verification of the download. The
    /// HTTPS request is pinned to `commit`, and `commit_check` records
    /// whether the tree GitHub returned carried it. The local hash is an audit
    /// record, not an independent authenticity proof.
    pub archive_sha256: String,
    /// How the downloaded tree was tied back to `commit`. See
    /// `ArchiveCommitCheck`.
    #[serde(default)]
    pub commit_check: String,
    pub url: String,
}

/// A self-describing runtime bundle. The manifest is deliberately inside the
/// archive so a runtime can be moved to a second PC without requiring that PC
/// to have CMake, a compiler, or the vendor SDK that produced it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBundleManifest {
    pub format: u32,
    pub backend: String,
    pub build: String,
    pub platform: String,
    pub architecture: String,
    #[serde(default)]
    pub version: Option<RuntimeVersion>,
    #[serde(default)]
    pub source: Option<RuntimeSource>,
    pub files: Vec<RuntimeBundleFile>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBundleFile {
    /// POSIX separators make the manifest stable when a Windows bundle is
    /// inspected or imported by another platform.
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBundleInfo {
    pub path: String,
    pub backend: String,
    pub build: String,
    pub archive_sha256: String,
    pub bytes: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PullRequestArtifactPreview {
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Everything the user is shown before a PR build is allowed to start.
///
/// Building a pull request runs code from whoever opened it on the user's own
/// machine, so this is presented and confirmed first, and the confirmed
/// `commit` is passed back to the installer and re-checked there.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PullRequestPreview {
    pub pull_request: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub repository: String,
    pub head_ref: String,
    pub commit: String,
    pub fork: bool,
    pub url: String,
    pub archive_url: String,
    /// When GitHub last saw the pull request change, so a preview that has
    /// been sitting on screen is visibly old.
    pub updated_at: String,
    /// Machine-readable reasons this pull request deserves a second look,
    /// resolved to text by the frontend so they can be translated.
    pub advisories: Vec<String>,
    /// A repository-produced binary for this exact platform/backend, when
    /// available. Its ZIP and embedded manifest are verified again at install.
    #[serde(default)]
    pub artifact: Option<PullRequestArtifactPreview>,
    /// A non-fatal lookup failure is retained so the UI can distinguish
    /// "there is no artifact" from a temporary GitHub/API problem.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_error: Option<String>,
}

/// Reasons to look twice before building a pull request.
///
/// None of these refuses the build - each one is a legitimate thing to compile,
/// and the user may know exactly why they want it. They exist so a state that
/// changes what the code *is* cannot pass by unmentioned.
pub const PR_ADVISORY_DRAFT: &str = "draft";

pub const PR_ADVISORY_CLOSED: &str = "closed";

pub const PR_ADVISORY_MERGED: &str = "merged";

pub const PR_ADVISORY_FORK: &str = "fork";

pub const PR_ADVISORY_STALE_BRANCH: &str = "no-head-ref";

/// Parses `version: 0.3.0-dev (build 10638, commit bf9421646)`.
pub fn parse_runtime_version(text: &str) -> Option<RuntimeVersion> {
    let line = text.lines().find(|line| line.contains("version:"))?;
    let after = line.split("version:").nth(1)?.trim();
    let (semver, rest) = after.split_once('(')?;
    let semver = semver.trim();
    if semver.is_empty() {
        return None;
    }
    let inside = rest.split_once(')')?.0;
    let mut build = None;
    let mut commit = String::new();
    for field in inside.split(',') {
        let field = field.trim();
        if let Some(value) = field.strip_prefix("build ") {
            build = value.trim().parse::<u64>().ok();
        } else if let Some(value) = field.strip_prefix("commit ") {
            commit = value.trim().to_string();
        }
    }
    Some(RuntimeVersion {
        semver: semver.to_string(),
        build: build?,
        commit,
    })
}

/// The runtime's version as one comparable line: `0.3.0-dev (build 10638,
/// commit bf9421646)`.
///
/// The release name leads, because that is what a reader recognizes and what
/// two results are compared by; the build number and commit follow, because
/// they are what pins the exact upstream tree. A banner that cannot be parsed
/// gives `None` rather than a line assembled out of whatever could be read, so
/// a published version is only ever one the runtime itself reported.
pub fn version_label(banner: &str) -> Option<String> {
    let version = parse_runtime_version(banner)?;
    Some(if version.commit.is_empty() {
        format!("{} (build {})", version.semver, version.build)
    } else {
        format!(
            "{} (build {}, commit {})",
            version.semver, version.build, version.commit
        )
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct InstalledRuntime {
    pub build: String,
    pub backend: String,
    pub dir: String,
    pub size_mb: f64,
    /// Absent for runtimes installed before the manifest existed; probing the
    /// runtime backfills it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<RuntimeVersion>,
    /// Present when this runtime was built from an upstream pull request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeSource>,
    /// What this install replaced, when it replaced a PR build of a different
    /// commit. Set only by a fresh install, never by listing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced: Option<RuntimeReplacement>,
}

/// A PR runtime keeps one directory per pull request - `pr27342-cuda` - so a
/// rebuild of the same PR replaces the previous build rather than filling the
/// disk with a copy per commit.
///
/// That is the right default, but it means the bytes behind a runtime can
/// change without its name changing. This records the swap so the UI can say
/// which commit went away instead of silently showing the same row.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeReplacement {
    pub previous_commit: String,
    pub previous_pull_request: u64,
}

/// First seven characters of a commit - what Git itself abbreviates to, and
/// enough to recognise in a row label.
pub fn short_commit(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/// Decide what a new PR build is doing to whatever is already installed.
///
/// `None` when nothing is being displaced or when the same commit is being
/// rebuilt: neither is news, and reporting them would train the user to ignore
/// the message that matters.
fn runtime_replacement(
    existing: Option<&RuntimeSource>,
    incoming: &RuntimeSource,
) -> Option<RuntimeReplacement> {
    let existing = existing?;
    if existing.commit.is_empty() || existing.commit == incoming.commit {
        return None;
    }
    Some(RuntimeReplacement {
        previous_commit: existing.commit.clone(),
        previous_pull_request: existing.pull_request,
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct LatestInfo {
    pub build: String,
    pub file_name: String,
    pub url: String,
    pub digest: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RuntimeCapabilities {
    pub backend: String,
    pub build: String,
    pub executable: String,
    pub state: String,
    pub version: String,
    pub flags: Vec<String>,
    pub server_help: String,
    pub supports_dflash: bool,
    pub devices: Vec<String>,
    pub diagnostics: Vec<String>,
    #[serde(default)]
    pub bench_available: bool,
}

pub fn runtimes_root() -> PathBuf {
    crate::home::aiolm_home().join("runtimes")
}

pub fn validate_runtime_identifiers(backend: &str, build: &str) -> Result<(), AppError> {
    if backend.is_empty()
        || backend.len() > 64
        || !backend
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || ".-_".contains(value))
    {
        return Err(AppError::validation(format!(
            "invalid runtime backend identifier: {backend}"
        )));
    }
    let valid_release_build = build.starts_with('b')
        && build.len() >= 2
        && build.len() <= 16
        && build[1..].chars().all(|value| value.is_ascii_digit());
    let valid_pull_request_build = build.starts_with("pr")
        && build.len() >= 3
        && build.len() <= 20
        && build[2..].chars().all(|value| value.is_ascii_digit())
        && build[2..]
            .parse::<u64>()
            .map(|number| number > 0)
            .unwrap_or(false);
    // Local compatibility builds must not masquerade as an official release
    // or overwrite it. No hyphens: the directory's first '-' separates backend.
    let valid_local_build = build.strip_prefix("local_").is_some_and(|name| {
        !name.is_empty()
            && name.len() <= 48
            && name
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || value == '_')
    });
    if !valid_release_build && !valid_pull_request_build && !valid_local_build {
        return Err(AppError::validation(format!(
            "invalid runtime build identifier: {build}"
        )));
    }
    if backend.contains(['/', '\\']) || build.contains(['/', '\\']) {
        return Err(AppError::validation(
            "runtime identifiers must not contain path separators",
        ));
    }
    Ok(())
}

/// Structured binary-reported identity only; no directory-name fallback.
pub fn installed_reported_version(
    backend: &str,
    build: &str,
) -> Result<Option<RuntimeVersion>, AppError> {
    Ok(read_version_manifest(&runtime_dir(backend, build)?))
}

/// Bundle-declared backend tied to the exact installed server bytes, not its
/// installation directory. This describes the runtime build, not GPU use.
pub(crate) fn installed_reported_backend(backend: &str, build: &str) -> Option<String> {
    let binary = server_bin_for(backend, build).ok()?;
    let directory = binary.parent()?;
    let version = read_version_manifest(directory)?;
    reported_bundle_backend(directory, &binary, &version)
}

fn reported_bundle_backend(
    directory: &Path,
    binary: &Path,
    version: &RuntimeVersion,
) -> Option<String> {
    let manifest = read_bundle_manifest(directory).ok()?;
    if manifest.version.as_ref() != Some(version) {
        return None;
    }
    let relative = bundle_relative_path(directory, binary).ok()?;
    let declared = manifest.files.iter().find(|file| file.path == relative)?;
    let before = fs::metadata(binary).ok()?;
    // Identity collection must not scan an arbitrarily large replacement file.
    if !before.is_file() || before.len() != declared.bytes || before.len() > 512 * 1024 * 1024 {
        return None;
    }
    let modified = before.modified().ok()?;
    if sha256_file(binary).ok()? != declared.sha256 {
        return None;
    }
    let after = fs::metadata(binary).ok()?;
    if !after.is_file() || after.len() != before.len() || after.modified().ok()? != modified {
        return None;
    }
    Some(manifest.backend)
}

/// The installed runtime's identity for help caching: what its own
/// `--version` reported at install time, or the build directory when the
/// runtime predates the version sidecar. The executable hash is separate.
pub fn installed_version_label(backend: &str, build: &str) -> Result<String, AppError> {
    let dir = runtime_dir(backend, build)?;
    Ok(match read_version_manifest(&dir) {
        Some(version) => format!(
            "{backend}/{build}: {} (build {}, commit {})",
            version.semver, version.build, version.commit
        ),
        None => format!("{backend}/{build}"),
    })
}

pub fn runtime_dir(backend: &str, build: &str) -> Result<PathBuf, AppError> {
    validate_runtime_identifiers(backend, build)?;
    Ok(runtimes_root().join(format!("{build}-{backend}")))
}

pub fn server_executable_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

pub fn bench_executable_name() -> &'static str {
    if cfg!(windows) {
        "llama-bench.exe"
    } else {
        "llama-bench"
    }
}

pub fn server_bin_for(backend: &str, build: &str) -> Result<PathBuf, AppError> {
    Ok(runtime_dir(backend, build)?.join(server_executable_name()))
}

pub fn bench_bin_for(backend: &str, build: &str) -> Result<PathBuf, AppError> {
    Ok(runtime_dir(backend, build)?.join(bench_executable_name()))
}

pub fn perplexity_executable_name() -> &'static str {
    if cfg!(windows) {
        "llama-perplexity.exe"
    } else {
        "llama-perplexity"
    }
}

pub fn perplexity_bin_for(backend: &str, build: &str) -> Result<PathBuf, AppError> {
    Ok(runtime_dir(backend, build)?.join(perplexity_executable_name()))
}

/// Metadata consumed by provider discovery, without a filesystem size total.
pub(crate) struct InstalledRuntimeMetadata {
    pub build: String,
    pub backend: String,
    pub dir: String,
    pub version: Option<RuntimeVersion>,
}

// Project each directory before inspecting the next entry. In particular, full
// listing must measure size before reading that entry's manifests.
fn installed_directories_in(root: &Path) -> impl Iterator<Item = (String, String, PathBuf)> {
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let (build, backend) = name.split_once('-')?;
            if validate_runtime_identifiers(backend, build).is_err() {
                return None;
            }
            let dir = entry.path();
            // llama-bench is optional; only the serving executable is required.
            if !dir.join(server_executable_name()).is_file() {
                return None;
            }
            Some((build.into(), backend.into(), dir))
        })
}

pub fn list_installed() -> Vec<InstalledRuntime> {
    list_installed_in(&runtimes_root())
}

pub(crate) fn list_installed_in(root: &Path) -> Vec<InstalledRuntime> {
    let mut out = installed_directories_in(root)
        .map(|(build, backend, dir)| InstalledRuntime {
            build,
            backend,
            dir: dir.to_string_lossy().to_string(),
            size_mb: dir_size(&dir),
            version: read_version_manifest(&dir),
            source: read_source_manifest(&dir),
            replaced: None,
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.build.cmp(&a.build).then(a.backend.cmp(&b.backend)));
    out
}

pub(crate) fn list_installed_metadata() -> Vec<InstalledRuntimeMetadata> {
    list_installed_metadata_in(&runtimes_root())
}

pub(crate) fn list_installed_metadata_in(root: &Path) -> Vec<InstalledRuntimeMetadata> {
    let mut out = installed_directories_in(root)
        .map(|(build, backend, dir)| InstalledRuntimeMetadata {
            build,
            backend,
            dir: dir.to_string_lossy().to_string(),
            version: read_version_manifest(&dir),
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.build.cmp(&a.build).then(a.backend.cmp(&b.backend)));
    out
}

fn dir_size(dir: &Path) -> f64 {
    dir_size_bytes(dir) as f64 / 1_048_576.0
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0_u64;
    walk_size(dir, &mut total, 0);
    total
}

fn walk_size(dir: &Path, total: &mut u64, depth: u32) {
    if depth > 32 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            walk_size(&path, total, depth + 1);
        } else {
            *total = total.saturating_add(metadata.len());
        }
    }
}

pub fn uninstall(backend: &str, build: &str) -> Result<(), AppError> {
    let dir = runtime_dir(backend, build)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|error| AppError::io("failed to remove runtime", &error))?;
    }
    Ok(())
}

/// Where install progress goes. Keeping this behind a callback lets the whole
/// install path run under `cargo test` without a Tauri window.
pub type ProgressSink<'a> = &'a (dyn Fn(&str, f64, f64) + Send + Sync);

/// Track local runtime replacement even when the llama.cpp build tag stays the
/// same. File metadata keeps launch-time work bounded for multi-GB GPU bundles;
/// archive integrity is checked separately when importing/installing a bundle.
pub fn verification_identity(backend: &str, build: &str) -> String {
    runtime_dir(backend, build)
        .map(|root| runtime_file_identity(&root))
        .unwrap_or_default()
}

fn runtime_file_identity(root: &Path) -> String {
    fn collect(root: &Path, directory: &Path, nested: bool, entries: &mut Vec<String>) {
        let Ok(children) = fs::read_dir(directory) else {
            entries.push(format!(
                "unavailable:{}",
                directory.strip_prefix(root).unwrap_or(directory).display()
            ));
            return;
        };
        for entry in children.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if metadata.is_dir() {
                if nested || matches!(name.as_str(), "rocblas" | "hipblaslt" | ".kpack") {
                    collect(root, &path, true, entries);
                }
            } else if nested
                || name.ends_with(".dll")
                || name.ends_with(".exe")
                || name.ends_with(".dylib")
                || name.contains(".so")
                || name.starts_with("llama-")
                || name == VERSION_MANIFEST
                || name == SOURCE_MANIFEST
                || name == RUNTIME_BUNDLE_MANIFEST
            {
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|time| time.as_nanos())
                    .unwrap_or_default();
                entries.push(format!(
                    "{}|{}|{modified}",
                    path.strip_prefix(root).unwrap_or(&path).display(),
                    metadata.len()
                ));
            }
        }
    }
    let mut entries = Vec::new();
    collect(root, root, false, &mut entries);
    entries.sort();
    let mut hasher = Sha256::new();
    for entry in entries {
        hasher.update(entry.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

pub fn validate_catalog_backend(backend: &str) -> Result<(), AppError> {
    if CATALOG_BACKENDS.contains(&backend) {
        Ok(())
    } else {
        Err(AppError::validation(format!(
            "unknown llama.cpp backend: {backend}"
        )))
    }
}

#[cfg(test)]
#[path = "runtime/listing_fixture.rs"]
pub(crate) mod listing_fixture;

#[cfg(test)]
#[path = "runtime/runtime_tests.rs"]
mod tests;
