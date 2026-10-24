//! Application self-update: checking this project's published GitHub releases
//! for a newer stable version and opening the verified installer that matches
//! how this copy was installed. macOS DMG and Linux DEB handoffs require the
//! user to finish installation in the system interface.
//!
//! The trust model is the one `install.ps1` already applies to a first-time
//! install. Release metadata and installer assets are fetched over HTTPS from
//! this project's own repository and GitHub's asset delivery hosts only, every
//! redirect is checked against the same host list, and an installer runs only
//! after its SHA-256 matches the digest GitHub publishes for that asset or the
//! entry for it in the release's `checksums.txt`. Nothing the renderer sends
//! is trusted beyond a plain `MAJOR.MINOR.PATCH` version string: the release,
//! its asset, its download URL and its digest are all resolved here again
//! before anything is executed.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// The repository `install.ps1` and the release workflow publish installers
/// from. Updates are never fetched from anywhere else.
const RELEASE_REPOSITORY: &str = "aiolm/AioLM";
/// The release page offered to builds that cannot install an update
/// themselves. It is fixed here rather than taken from the renderer or from
/// release metadata, so the only page this app ever opens is the official one.
pub const RELEASE_PAGE_URL: &str = "https://github.com/aiolm/AioLM/releases/latest";
const PRODUCT_NAME: &str = "AioLM";
const CHECKSUMS_ASSET: &str = "checksums.txt";
const USER_AGENT: &str = concat!("aiolm/", env!("CARGO_PKG_VERSION"));

/// Release metadata is a single JSON document; nothing this app reads from the
/// API comes close to this, so a larger body is a sign the response is not the
/// one that was asked for.
const MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
/// `checksums.txt` holds one line per release asset.
const MAX_CHECKSUMS_BYTES: usize = 64 * 1024;
/// Backstop for an installer whose release metadata declares no size.
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
/// The longest written bytes go unreported while a download waits for its
/// next read. Changes to the percentage shown are reported as they are
/// written, so this only bounds how stale the count gets on a slow or stalled
/// transfer or one of unknown size, at no more than two extra events a second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// Only one install may download and launch at a time, whatever the renderer
/// sends: two installers running over the same files is worse than a refusal.
static INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);

/// What the startup notification and the settings panel are told about the
/// published releases. Serialised in `snake_case`, matching the IPC contract.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct UpdateStatus {
    pub current_version: String,
    /// The newest stable published version, reported even when it is the one
    /// already running so settings can say "up to date"; `null` when the
    /// latest release is a draft, a pre-release or not a stable version.
    pub latest_version: Option<String>,
    /// `latest_version` is strictly newer than `current_version`.
    pub available: bool,
    /// This build can install that update itself: a supported platform, a
    /// recognised installation, and a matching installer asset in the release
    /// with a SHA-256 digest, or a trusted `checksums.txt`, to verify it against.
    pub can_install: bool,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
}

/// Where install progress goes. Keeping this behind a callback lets the
/// download path run under `cargo test` without a Tauri window.
pub type ProgressSink<'a> = &'a (dyn Fn(&str, u64, Option<u64>) + Send + Sync);

/// The installer matching this copy's platform and installation method.
/// Windows flavours stay distinct to avoid two registered installations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    Nsis,
    Msi,
    #[cfg(any(target_os = "macos", target_os = "linux", test))]
    Dmg(InstallerArch),
    #[cfg(any(target_os = "macos", target_os = "linux", test))]
    Deb(InstallerArch),
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallerArch {
    X64,
    Arm64,
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn unix_install_kind(os: &str, arch: &str) -> Option<InstallKind> {
    let arch = match arch {
        "x86_64" => InstallerArch::X64,
        "aarch64" => InstallerArch::Arm64,
        _ => return None,
    };
    match os {
        "macos" => Some(InstallKind::Dmg(arch)),
        "linux" => Some(InstallKind::Deb(arch)),
        _ => None,
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize, Clone, Debug)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    /// `sha256:<hex>`, published by GitHub for assets uploaded through the
    /// release API.
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

impl std::fmt::Display for Version {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The latest published release, reduced to what the renderer is told.
struct LatestRelease {
    version: String,
    newer: bool,
    release_url: Option<String>,
    published_at: Option<String>,
    notes: Option<String>,
}

/// Parse a stable `MAJOR.MINOR.PATCH` version numerically rather than by text,
/// so 0.1.10 is newer than 0.1.9. Pre-release and build metadata (`1.2.3-rc.1`,
/// `1.2.3+build`) are deliberately unparseable: this updater only ever offers
/// the stable releases the release workflow publishes.
fn parse_version(value: &str) -> Result<Version, String> {
    let text = value.strip_prefix('v').unwrap_or(value);
    let invalid = || format!("{value} is not a stable MAJOR.MINOR.PATCH release version");
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let mut numbers = [0_u64; 3];
    for (slot, part) in numbers.iter_mut().zip(parts) {
        // Nine digits keep every component inside u64 while still allowing any
        // version this project could plausibly publish.
        if part.is_empty() || part.len() > 9 || !part.chars().all(|value| value.is_ascii_digit()) {
            return Err(invalid());
        }
        *slot = part.parse::<u64>().map_err(|_| invalid())?;
    }
    Ok(Version {
        major: numbers[0],
        minor: numbers[1],
        patch: numbers[2],
    })
}

/// The version the renderer asks to install becomes part of a GitHub tag URL,
/// so it is accepted only in the exact canonical form this app reports: plain
/// digits and dots, no `v` prefix, no padding, nothing else.
fn parse_requested_version(value: &str) -> Result<Version, String> {
    let version = parse_version(value)?;
    if version.to_string() != value {
        return Err(format!(
            "{value} is not a stable MAJOR.MINOR.PATCH release version"
        ));
    }
    Ok(version)
}

/// Exact Tauri bundle names; never substitute an asset for another architecture.
fn installer_asset_name(kind: InstallKind, version: &str) -> String {
    match kind {
        InstallKind::Nsis => format!("{PRODUCT_NAME}_{version}_x64-setup.exe"),
        InstallKind::Msi => format!("{PRODUCT_NAME}_{version}_x64_en-US.msi"),
        #[cfg(any(target_os = "macos", target_os = "linux", test))]
        InstallKind::Dmg(arch) => format!(
            "{PRODUCT_NAME}_{version}_{}.dmg",
            match arch {
                InstallerArch::X64 => "x64",
                InstallerArch::Arm64 => "aarch64",
            }
        ),
        #[cfg(any(target_os = "macos", target_os = "linux", test))]
        InstallKind::Deb(arch) => format!(
            "{PRODUCT_NAME}_{version}_{}.deb",
            match arch {
                InstallerArch::X64 => "amd64",
                InstallerArch::Arm64 => "arm64",
            }
        ),
    }
}

fn find_asset<'a>(assets: &'a [ReleaseAsset], name: &str) -> Result<&'a ReleaseAsset, String> {
    assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("release does not publish the installer asset {name}"))
}

/// Whether `install` could actually run for this release: a platform with a
/// published installer, an installation this app recognises, an asset for
/// that installer with a download URL this app is willing to fetch, and a
/// digest source `expected_digest` would not refuse before any request: the
/// asset's own digest when it carries one, otherwise the release's first
/// `checksums.txt` asset on a trusted URL. That file's entry, and the
/// installer's hash, can only be checked when `install` downloads them.
fn installable(kind: Option<InstallKind>, assets: &[ReleaseAsset], version: &str) -> bool {
    kind.is_some_and(|kind| {
        find_asset(assets, &installer_asset_name(kind, version)).is_ok_and(|asset| {
            validate_asset_url(&asset.browser_download_url).is_ok()
                && match asset.digest.as_deref() {
                    Some(digest) => normalize_digest(digest).is_ok(),
                    None => find_asset(assets, CHECKSUMS_ASSET).is_ok_and(|checksums| {
                        validate_asset_url(&checksums.browser_download_url).is_ok()
                    }),
                }
        })
    })
}

/// Reduce a release document to what the UI is told, without offering drafts,
/// pre-releases or tags that are not stable versions.
fn stable_release(current: Version, release: &Release) -> Option<LatestRelease> {
    if release.draft || release.prerelease {
        return None;
    }
    let version = parse_version(&release.tag_name).ok()?;
    Some(LatestRelease {
        newer: version > current,
        version: version.to_string(),
        release_url: release
            .html_url
            .as_deref()
            .filter(|url| validate_release_page_url(url).is_ok())
            .map(str::to_owned),
        published_at: release.published_at.clone(),
        notes: release
            .body
            .as_deref()
            .map(str::trim)
            .filter(|notes| !notes.is_empty())
            .map(str::to_owned),
    })
}

/// Hosts GitHub serves this project's release metadata and assets from. Used
/// for every redirect hop as well as the URLs the API hands back.
fn trusted_host(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or_default();
    host == "api.github.com"
        || host == "github.com"
        || host == "objects.githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

/// Release assets are served from this repository's own download path or from
/// GitHub's asset delivery hosts; anything else ends the transfer.
fn validate_asset_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|error| format!("invalid release asset URL: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("release asset URL must use HTTPS".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    if host == "github.com" {
        let prefix = format!("/{RELEASE_REPOSITORY}/releases/download/");
        if !parsed.path().starts_with(&prefix) {
            return Err(format!(
                "release asset URL does not belong to {RELEASE_REPOSITORY}: {url}"
            ));
        }
        return Ok(());
    }
    if host == "objects.githubusercontent.com" || host.ends_with(".githubusercontent.com") {
        return Ok(());
    }
    Err(format!("release asset host is not trusted: {host}"))
}

/// The page the UI offers when this app cannot install the update itself. It
/// is handed to the renderer, so it is pinned to this repository's releases.
fn validate_release_page_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|error| format!("invalid release page URL: {error}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("release page URL must be an HTTPS github.com URL".into());
    }
    if !parsed
        .path()
        .starts_with(&format!("/{RELEASE_REPOSITORY}/releases"))
    {
        return Err(format!(
            "release page URL does not belong to {RELEASE_REPOSITORY}"
        ));
    }
    Ok(())
}

fn trusted_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("release request followed too many redirects")
        } else if trusted_host(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("release request was redirected to an untrusted host")
        }
    })
}

fn metadata_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .redirect(trusted_redirects())
        .build()
        .expect("static HTTP client configuration must be valid")
}

/// Installers run to tens of megabytes, so the API client's whole-request
/// budget would abort a slow but healthy transfer. A stalled connection is
/// caught by the per-read timeout instead.
fn download_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .redirect(trusted_redirects())
        .build()
        .expect("static HTTP client configuration must be valid")
}

async fn bounded_text(
    response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!("{label} response exceeds its size limit"));
    }
    let mut bytes = Vec::new();
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|error| format!("{label} response failed: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!("{label} response exceeds its size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|error| format!("{label} response was not UTF-8: {error}"))
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|message| message.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.lines().next().unwrap_or("request failed").to_owned());
    format!("GitHub API {status}: {message}")
}

/// Turn one release API response into a document, into "no such release", or
/// into an error.
///
/// GitHub answers 404 both for a repository that has never published a release
/// and for a tag that does not exist, so the two callers decide what that
/// means: a missing "latest" release is simply nothing to offer, while a
/// missing tag for a version the renderer asked to install is a failure.
fn release_from_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<Option<Release>, String> {
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(api_error(status, body));
    }
    serde_json::from_str(body)
        .map(Some)
        .map_err(|error| format!("invalid GitHub release response: {error}"))
}

async fn fetch_release(path: &str) -> Result<Option<Release>, String> {
    let url = format!("https://api.github.com/repos/{RELEASE_REPOSITORY}/{path}");
    let response = metadata_http()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("release lookup failed: {error}"))?;
    let status = response.status();
    let body = bounded_text(response, MAX_METADATA_BYTES, "release metadata").await?;
    release_from_response(status, &body)
}

fn normalize_digest(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix("sha256:").unwrap_or(trimmed);
    if hex.len() != 64 || !hex.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err("release asset digest is not a SHA-256 value".into());
    }
    Ok(hex.to_ascii_lowercase())
}

/// Read one `<sha256>  <asset name>` line out of a release's `checksums.txt`.
fn digest_from_checksums(text: &str, asset_name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let hash = fields.next()?;
        let name = fields.next()?;
        if fields.next().is_some() || name != asset_name {
            return None;
        }
        normalize_digest(hash).ok()
    })
}

/// The digest an installer must match before it is allowed to run: GitHub's
/// own asset digest when the release carries one, otherwise the release's
/// `checksums.txt` entry for exactly that asset.
async fn expected_digest(asset: &ReleaseAsset, assets: &[ReleaseAsset]) -> Result<String, String> {
    if let Some(digest) = asset.digest.as_deref() {
        return normalize_digest(digest);
    }
    let checksums = find_asset(assets, CHECKSUMS_ASSET).map_err(|_| {
        format!(
            "release publishes no SHA-256 digest for {} and no {CHECKSUMS_ASSET}; refusing an unverified installer",
            asset.name
        )
    })?;
    validate_asset_url(&checksums.browser_download_url)?;
    let response = download_http()
        .get(&checksums.browser_download_url)
        .send()
        .await
        .map_err(|error| format!("{CHECKSUMS_ASSET} download failed: {error}"))?;
    validate_asset_url(response.url().as_str())?;
    if !response.status().is_success() {
        return Err(format!(
            "{CHECKSUMS_ASSET} download returned HTTP {}",
            response.status()
        ));
    }
    let text = bounded_text(response, MAX_CHECKSUMS_BYTES, CHECKSUMS_ASSET).await?;
    digest_from_checksums(&text, &asset.name).ok_or_else(|| {
        format!(
            "{CHECKSUMS_ASSET} has no SHA-256 entry for {}; refusing an unverified installer",
            asset.name
        )
    })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    std::io::copy(&mut reader, &mut hasher).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
}

async fn download_installer(
    progress: ProgressSink<'_>,
    url: &str,
    path: &Path,
    limit: u64,
) -> Result<u64, String> {
    let response = download_http()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("installer download failed: {error}"))?;
    validate_asset_url(response.url().as_str())?;
    if !response.status().is_success() {
        return Err(format!(
            "installer download returned HTTP {}",
            response.status()
        ));
    }
    let total = response.content_length();
    if total.is_some_and(|length| length > limit) {
        return Err("installer download is larger than the release declares".into());
    }
    let file = tokio::fs::File::create(path)
        .await
        .map_err(|error| format!("could not write the downloaded installer: {error}"))?;
    write_installer(progress, response, file, total, limit, PROGRESS_INTERVAL).await
}

/// Stream an already validated installer response into `file`.
///
/// Every chunk is still checked against `limit` before it is written, but a
/// body can arrive in many chunks and each report becomes one event to the
/// renderer, which shows only a whole percentage of a known `total` and an
/// indeterminate bar otherwise. So a report is made for the first bytes, for
/// each write that changes the percentage the renderer shows, and otherwise
/// once `interval` has passed since the last one. The interval is checked as
/// each chunk is written and, by a timer, while the next read is pending; a
/// write or flush that is itself slow delays a report by its own duration.
/// A report only ever counts bytes `write_all` has confirmed, never a chunk
/// that was refused, and whatever is still unreported when the body ends or
/// fails is reported once before returning. The last report is therefore the
/// confirmed byte count: a failed write may have left more in the file, and on
/// a failure the report says only how far the download got. The timer belongs
/// to this future, so nothing is reported once it returns or is dropped.
async fn write_installer<W: tokio::io::AsyncWrite + Unpin>(
    progress: ProgressSink<'_>,
    mut response: reqwest::Response,
    mut file: W,
    total: Option<u64>,
    limit: u64,
    interval: Duration,
) -> Result<u64, String> {
    // The percentage the settings panel shows, computed the same way in
    // floating point: `Math.min(100, Math.floor(downloaded / total * 100))`.
    let percent = |bytes: u64| {
        total
            .filter(|&total| total > 0)
            .map(|total| (bytes as f64 / total as f64 * 100.0).floor().min(100.0) as u64)
    };
    let mut received = 0_u64;
    let mut reported = 0_u64;
    let mut reported_at = tokio::time::Instant::now();
    let streamed = loop {
        let next = response.chunk();
        tokio::pin!(next);
        // A timer that fires keeps polling the same read: the client's
        // per-read timeout lives in the body and restarts only on a frame.
        let chunk = loop {
            if received == reported {
                break next.await;
            }
            tokio::select! {
                biased;
                chunk = &mut next => break chunk,
                () = tokio::time::sleep_until(reported_at + interval) => {
                    progress("downloading", received, total);
                    reported = received;
                    reported_at = tokio::time::Instant::now();
                }
            }
        };
        let chunk = match chunk {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break Ok(()),
            Err(error) => break Err(format!("installer download failed: {error}")),
        };
        let written = received.saturating_add(chunk.len() as u64);
        if written > limit {
            break Err("installer download is larger than the release declares".to_string());
        }
        if let Err(error) = file.write_all(&chunk).await {
            break Err(format!("could not write the downloaded installer: {error}"));
        }
        received = written;
        let now = tokio::time::Instant::now();
        if received != reported
            && (reported == 0
                || percent(received) != percent(reported)
                || now >= reported_at + interval)
        {
            progress("downloading", received, total);
            reported = received;
            reported_at = now;
        }
    };
    if received != reported {
        progress("downloading", received, total);
    }
    streamed?;
    file.flush()
        .await
        .map_err(|error| format!("could not write the downloaded installer: {error}"))?;
    Ok(received)
}

/// A fresh directory under the operating system's temporary location. The
/// installer keeps running after this process exits, so the directory is
/// removed only when the update fails before the installer is launched.
fn update_directory() -> Result<PathBuf, String> {
    let directory =
        std::env::temp_dir().join(format!("aiolm-update-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the update download directory: {error}"))?;
    Ok(directory)
}

struct InstallGuard {
    release_on_drop: bool,
}

impl InstallGuard {
    fn acquire() -> Result<Self, String> {
        INSTALL_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self {
                release_on_drop: true,
            })
            .map_err(|_| "an application update is already being installed".to_string())
    }

    /// Keep the latch closed for the rest of this process's life.
    ///
    /// Once an installer is running the app is on its way out, but the window
    /// is still up until the deferred shutdown completes. Releasing the latch
    /// when `install` returns would let a second invoke from that window start
    /// a second installer over the same files, so a launched installer keeps
    /// it: only a failure before the launch hands it back.
    fn hold_until_exit(mut self) {
        self.release_on_drop = false;
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if self.release_on_drop {
            INSTALL_RUNNING.store(false, Ordering::Release);
        }
    }
}

#[cfg(windows)]
pub fn detect_install_kind() -> Result<InstallKind, String> {
    windows_install::detect()
}

#[cfg(target_os = "macos")]
pub fn detect_install_kind() -> Result<InstallKind, String> {
    let executable = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|error| format!("could not locate the running executable: {error}"))?;
    let home = std::env::home_dir().and_then(|path| path.canonicalize().ok());
    if !mac_install_location(&executable, home.as_deref()) {
        return Err("this copy is not installed in an Applications folder; install the macOS update from the release page instead".into());
    }
    unix_install_kind("macos", std::env::consts::ARCH)
        .ok_or_else(|| "this macOS architecture has no supported update installer".into())
}

#[cfg(any(target_os = "macos", test))]
fn mac_install_location(executable: &Path, home: Option<&Path>) -> bool {
    let relative = Path::new("AioLM.app")
        .join("Contents")
        .join("MacOS")
        .join("aiolm");
    // Requiring an installed location excludes mounted DMGs, App Translocation
    // and development bundles, which must use the release-page fallback.
    executable == Path::new("/Applications").join(&relative)
        || home.is_some_and(|home| executable == home.join("Applications").join(&relative))
}

#[cfg(target_os = "linux")]
pub fn detect_install_kind() -> Result<InstallKind, String> {
    linux_install::detect()
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn detect_install_kind() -> Result<InstallKind, String> {
    Err("this platform has no supported update installer; use the release page instead".into())
}

async fn installed_kind() -> Result<InstallKind, String> {
    tokio::task::spawn_blocking(detect_install_kind)
        .await
        .map_err(|error| format!("installation detection failed: {error}"))?
}

#[cfg(windows)]
fn launch_installer(kind: InstallKind, path: &Path) -> Result<(), String> {
    windows_install::launch(kind, path)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn launch_installer(kind: InstallKind, path: &Path) -> Result<(), String> {
    let program = match (std::env::consts::OS, kind) {
        ("macos", InstallKind::Dmg(_)) => "/usr/bin/open",
        ("linux", InstallKind::Deb(_)) => "/usr/bin/xdg-open",
        _ => return Err("installer does not match the running platform".into()),
    };
    use std::os::unix::process::CommandExt;
    let mut command = crate::procutil::std_command(program);
    command
        .arg(path)
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // The app's managed-process shutdown already ran. The system installer
    // must outlive it, so it is deliberately not an OwnedChild/transient task.
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not open the verified installer: {error}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("the system could not open the installer ({status}); install the update from the release page")),
            Err(error) => return Err(format!("could not check the installer launcher: {error}")),
            Ok(None) if std::time::Instant::now() >= deadline => return Ok(()),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn launch_installer(_kind: InstallKind, _path: &Path) -> Result<(), String> {
    Err("this platform has no supported update installer".into())
}

// Tauri derives the Debian control Package from the product's kebab-case name.
#[cfg(any(target_os = "linux", test))]
const DEB_PACKAGE_NAME: &str = "aio-lm";

#[cfg(any(target_os = "linux", test))]
fn deb_architecture(arch: InstallerArch) -> &'static str {
    match arch {
        InstallerArch::X64 => "amd64",
        InstallerArch::Arm64 => "arm64",
    }
}

#[cfg(any(target_os = "linux", test))]
fn deb_package_owner(output: &str, executable: &Path, arch: InstallerArch) -> Option<String> {
    let qualified = format!("{DEB_PACKAGE_NAME}:{}", deb_architecture(arch));
    let mut owners = output.lines().filter_map(|line| {
        let (package, path) = line.split_once(": ")?;
        (Path::new(path) == executable && (package == DEB_PACKAGE_NAME || package == qualified))
            .then(|| package.to_owned())
    });
    let owner = owners.next()?;
    owners.next().is_none().then_some(owner)
}

#[cfg(any(target_os = "linux", test))]
fn deb_status_matches(output: &str, arch: InstallerArch) -> bool {
    let fields = output.trim().split('\t').collect::<Vec<_>>();
    fields == [DEB_PACKAGE_NAME, "installed", deb_architecture(arch)]
}

#[cfg(target_os = "linux")]
mod linux_install {
    use super::*;

    fn query(arguments: &[&std::ffi::OsStr]) -> Result<String, String> {
        let mut command = crate::procutil::std_command("/usr/bin/dpkg-query");
        command
            .arg("--admindir=/var/lib/dpkg")
            .args(arguments)
            .env("LC_ALL", "C")
            .env("DPKG_COLORS", "never");
        let output = crate::procutil::capture_stdout_with_cap(
            &mut command,
            Duration::from_secs(3),
            64 * 1024,
        )
        .map_err(|error| format!("could not identify the installed Debian package: {error}"))?;
        if !output.status.success() {
            return Err("the executable is not owned by an installed Debian package".into());
        }
        String::from_utf8(output.stdout)
            .map_err(|_| "Debian package information is not UTF-8".into())
    }

    pub(super) fn detect() -> Result<InstallKind, String> {
        let unsupported = || {
            "this copy is not a supported installed Debian package; use the release page for AppImage or manual updates".to_string()
        };
        let Some(kind @ InstallKind::Deb(arch)) =
            unix_install_kind("linux", std::env::consts::ARCH)
        else {
            return Err(unsupported());
        };
        let executable = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|error| format!("could not locate the running executable: {error}"))?;
        if executable.file_name() != Some(std::ffi::OsStr::new("aiolm")) {
            return Err(unsupported());
        }
        let owner = query(&["--search".as_ref(), "--".as_ref(), executable.as_os_str()])
            .ok()
            .and_then(|text| deb_package_owner(&text, &executable, arch))
            .ok_or_else(unsupported)?;
        let status = query(&[
            "--show".as_ref(),
            "--showformat=${Package}\t${db:Status-Status}\t${Architecture}\n".as_ref(),
            "--".as_ref(),
            owner.as_ref(),
        ])?;
        if !deb_status_matches(&status, arch) {
            return Err(unsupported());
        }
        if !Path::new("/usr/bin/xdg-open").is_file() {
            return Err(
                "no desktop installer launcher is available; use the release page instead".into(),
            );
        }
        Ok(kind)
    }
}

/// What the startup notification and the settings panel call. It never
/// downloads or installs anything: an install always starts from an explicit
/// request carrying the version to install.
pub async fn check(current_version: &str) -> Result<UpdateStatus, String> {
    let current = parse_version(current_version)?;
    // GitHub's "latest" release is already the newest non-draft,
    // non-pre-release one; `stable_release` re-checks both flags rather than
    // relying on that.
    // A repository with no published release answers 404 here, which is not a
    // failure: there is simply nothing to offer yet.
    let Some(release) = fetch_release("releases/latest").await? else {
        return Ok(UpdateStatus {
            current_version: current.to_string(),
            latest_version: None,
            available: false,
            can_install: false,
            release_url: None,
            published_at: None,
            notes: None,
        });
    };
    let Some(latest) = stable_release(current, &release) else {
        return Ok(UpdateStatus {
            current_version: current.to_string(),
            latest_version: None,
            available: false,
            can_install: false,
            release_url: None,
            published_at: None,
            notes: None,
        });
    };
    let can_install = latest.newer
        && installable(
            installed_kind().await.ok(),
            &release.assets,
            &latest.version,
        );
    Ok(UpdateStatus {
        current_version: current.to_string(),
        latest_version: Some(latest.version),
        available: latest.newer,
        can_install,
        release_url: latest.release_url,
        published_at: latest.published_at,
        notes: latest.notes,
    })
}

/// Download and start the installer for `requested_version`.
///
/// Only the version string crosses from the renderer. The release is looked up
/// again here, its draft and pre-release flags and its tag are re-checked, the
/// asset is chosen by the name the release workflow publishes for this
/// installation's flavour, and the file is hashed against the release's digest
/// before the installer is allowed to start. Returns once the installer has
/// been launched; the caller shuts the app down so the installer can replace
/// the files this process holds open. A launched installer keeps the
/// single-install latch closed until this process is gone.
///
/// `before_launch` runs after the installer hash matches and before the
/// installer spawns, so the caller can stop its managed servers and jobs
/// deterministically before the installer's "application is running" check can
/// force-kill this process. Failures before that point (a download, a hash, a
/// missing release) return without calling it, leaving running sessions
/// untouched; if the spawn itself fails the app stays open with an error.
pub async fn install(
    progress: ProgressSink<'_>,
    requested_version: &str,
    current_version: &str,
    before_launch: Option<&(dyn Fn() + Send + Sync)>,
) -> Result<(), String> {
    let guard = InstallGuard::acquire()?;
    let current = parse_version(current_version)?;
    let requested = parse_requested_version(requested_version)?;
    if requested <= current {
        return Err(format!(
            "{PRODUCT_NAME} {requested} is not newer than the installed {current}"
        ));
    }
    let kind = installed_kind().await?;
    // Unlike the "latest" lookup, a missing tag here is a failure: the
    // renderer asked to install a version that this repository does not
    // publish.
    let release = fetch_release(&format!("releases/tags/v{requested}"))
        .await?
        .ok_or_else(|| format!("release v{requested} is not published by {RELEASE_REPOSITORY}"))?;
    if release.draft || release.prerelease {
        return Err(format!(
            "release v{requested} is a draft or pre-release and is not offered as an update"
        ));
    }
    if parse_version(&release.tag_name).ok() != Some(requested) {
        return Err(format!(
            "release v{requested} is published under the unexpected tag {}",
            release.tag_name
        ));
    }
    let name = installer_asset_name(kind, &requested.to_string());
    let asset = find_asset(&release.assets, &name)?;
    validate_asset_url(&asset.browser_download_url)?;
    let expected = expected_digest(asset, &release.assets).await?;
    let limit = if asset.size == 0 {
        MAX_INSTALLER_BYTES
    } else {
        asset.size.min(MAX_INSTALLER_BYTES)
    };

    let directory = update_directory()?;
    let installer = directory.join(&name);
    let result = async {
        progress("downloading", 0, (asset.size > 0).then_some(asset.size));
        let received =
            download_installer(progress, &asset.browser_download_url, &installer, limit).await?;
        if asset.size > 0 && received != asset.size {
            return Err(format!(
                "downloaded installer is {received} bytes, but the release declares {}",
                asset.size
            ));
        }
        progress("verifying", received, Some(received));
        let hash_path = installer.clone();
        let actual = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
            .await
            .map_err(|error| format!("installer hash task failed: {error}"))??;
        if actual != expected {
            return Err(format!(
                "installer SHA-256 mismatch: expected {expected}, got {actual}"
            ));
        }
        progress("installing", received, Some(received));
        if let Some(before_launch) = before_launch {
            before_launch();
        }
        let installer = installer.clone();
        tokio::task::spawn_blocking(move || launch_installer(kind, &installer))
            .await
            .map_err(|error| format!("installer launch task failed: {error}"))?
    }
    .await;
    match result {
        // The installer owns the download directory from here on, and the
        // latch stays closed behind it.
        Ok(()) => {
            guard.hold_until_exit();
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&directory);
            drop(guard);
            Err(error)
        }
    }
}

#[cfg(windows)]
mod windows_install {
    //! Which installer registered this copy of the app, read from the Windows
    //! uninstall entries. Updating an NSIS installation with the MSI, or the
    //! other way round, would leave two registered copies behind, so an
    //! installation this app cannot identify is reported as not updatable
    //! rather than guessed at.
    use super::{InstallKind, PRODUCT_NAME};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_DWORD, REG_EXPAND_SZ,
        REG_SZ,
    };

    const UNINSTALL_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    /// Where an installed copy can have registered itself.
    ///
    /// `HKEY_CURRENT_USER\Software` is not redirected, so the per-user NSIS
    /// bundle this project ships by default lands in the plain view. The
    /// 64-bit machine view holds the per-machine MSI (`ARPINSTALLLOCATION`)
    /// and a per-machine NSIS install: the template sets the 64-bit view for
    /// x64 builds through `SetContext`/`SetRegView 64`, so its `HKLM\Software`
    /// writes are not redirected. The 32-bit view is still checked for
    /// 32-bit-view writes (x86 or older/custom installs).
    const UNINSTALL_ROOTS: [(HKEY, u32); 3] = [
        (HKEY_CURRENT_USER, 0),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
    ];

    fn wide(value: &str) -> Vec<u16> {
        OsString::from(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    /// `view` selects the 64-bit or 32-bit registry view, or 0 for the
    /// caller's own view. It is repeated on every open because a subkey is
    /// read through the same view as the key it was found in.
    fn open(parent: HKEY, path: &str, view: u32) -> Option<Key> {
        let mut handle: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                parent,
                wide(path).as_ptr(),
                0,
                KEY_READ | view,
                &mut handle as *mut HKEY,
            )
        };
        (status == ERROR_SUCCESS && !handle.is_null()).then_some(Key(handle))
    }

    fn read_raw(key: &Key, name: &str) -> Option<(u32, Vec<u8>)> {
        let name = wide(name);
        let mut kind: u32 = 0;
        let mut size: u32 = 0;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS || size == 0 || size > 64 * 1024 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then(|| {
            buffer.truncate(size as usize);
            (kind, buffer)
        })
    }

    fn read_string(key: &Key, name: &str) -> Option<String> {
        let (kind, bytes) = read_raw(key, name)?;
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            return None;
        }
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .take_while(|unit| *unit != 0)
            .collect();
        let value = OsString::from_wide(&units).to_string_lossy().into_owned();
        (!value.trim().is_empty()).then_some(value)
    }

    fn read_u32(key: &Key, name: &str) -> Option<u32> {
        let (kind, bytes) = read_raw(key, name)?;
        if kind != REG_DWORD || bytes.len() < 4 {
            return None;
        }
        Some(u32::from_le_bytes(bytes[..4].try_into().ok()?))
    }

    fn subkeys(key: &Key) -> Vec<String> {
        let mut names = Vec::new();
        for index in 0..4096_u32 {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    key.0,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&name[..length as usize]));
        }
        names
    }

    /// Compare two spellings of the same installation directory as text.
    ///
    /// The NSIS template writes `InstallLocation` quoted (`"$INSTDIR"`), WiX
    /// writes `[INSTALLDIR]` with a trailing separator, `current_exe` can come
    /// back in the extended `\\?\C:\…` form, and Windows paths compare
    /// case-insensitively.
    fn comparable_path(value: &str) -> String {
        let value = value.trim().trim_matches('"').trim().replace('/', "\\");
        let value = match value.strip_prefix(r"\\?\UNC\") {
            Some(rest) => format!(r"\\{rest}"),
            None => value
                .strip_prefix(r"\\?\")
                .unwrap_or(value.as_str())
                .to_string(),
        };
        value.trim_end_matches('\\').to_lowercase()
    }

    /// Whether a registered `InstallLocation` names the directory this
    /// executable runs from. The paths are canonicalised when both still
    /// exist, which settles short (`PROGRA~1`) and extended spellings and
    /// links; otherwise they are compared as normalised text.
    fn same_install_location(registered: &str, directory: &Path) -> bool {
        let trimmed = registered.trim().trim_matches('"').trim();
        if trimmed.is_empty() {
            return false;
        }
        if let (Ok(registered), Ok(running)) = (
            std::fs::canonicalize(trimmed),
            std::fs::canonicalize(directory),
        ) {
            return registered == running;
        }
        comparable_path(trimmed) == comparable_path(&directory.to_string_lossy())
    }

    /// The uninstall entry registered for the directory this executable runs
    /// from, in one hive and registry view.
    fn registered_kind(root: HKEY, view: u32, directory: &Path) -> Option<InstallKind> {
        let uninstall = open(root, UNINSTALL_PATH, view)?;
        for subkey in subkeys(&uninstall) {
            let Some(entry) = open(uninstall.0, &subkey, view) else {
                continue;
            };
            if read_string(&entry, "DisplayName").as_deref() != Some(PRODUCT_NAME) {
                continue;
            }
            let Some(location) = read_string(&entry, "InstallLocation") else {
                continue;
            };
            if !same_install_location(&location, directory) {
                continue;
            }
            // Windows Installer marks its own entries; an NSIS entry is a
            // plain uninstall registration written by the installer itself.
            return Some(if read_u32(&entry, "WindowsInstaller") == Some(1) {
                InstallKind::Msi
            } else {
                InstallKind::Nsis
            });
        }
        None
    }

    pub(super) fn detect() -> Result<InstallKind, String> {
        if !cfg!(target_arch = "x86_64") {
            return Err("in-app updates are published for Windows x64 only".into());
        }
        let executable = std::env::current_exe()
            .map_err(|error| format!("could not locate the running executable: {error}"))?;
        let directory = executable
            .parent()
            .ok_or_else(|| "the running executable has no directory".to_string())?;
        for (root, view) in UNINSTALL_ROOTS {
            if let Some(kind) = registered_kind(root, view, directory) {
                return Ok(kind);
            }
        }
        Err(format!(
            "this copy of {PRODUCT_NAME} is not registered as an installed Windows application, so it cannot replace itself; install the update from the release page instead"
        ))
    }

    /// Start the installer with its own interface, so the user confirms the
    /// installation and sees its progress and any elevation prompt.
    pub(super) fn launch(kind: InstallKind, path: &Path) -> Result<(), String> {
        let mut command = match kind {
            InstallKind::Nsis => crate::procutil::std_command(path),
            InstallKind::Msi => {
                // Resolved from the Windows directory rather than PATH.
                let root = std::env::var("SystemRoot")
                    .map_err(|_| "SystemRoot is not set; cannot locate msiexec".to_string())?;
                let msiexec = Path::new(&root).join("System32").join("msiexec.exe");
                let mut command = crate::procutil::std_command(&msiexec);
                command.arg("/i").arg(path);
                command
            }
            #[cfg(test)]
            InstallKind::Dmg(_) | InstallKind::Deb(_) => {
                return Err("installer does not match Windows".into());
            }
        };
        command
            .spawn()
            .map_err(|error| crate::procutil::spawn_error(path, &error))?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn an_install_location_matches_the_forms_the_installers_and_windows_write() {
            // A directory that does not exist, so this exercises the text
            // comparison the canonicalising path falls back to.
            let directory = Path::new(r"C:\Program Files\AioLM");
            // NSIS quotes `$INSTDIR`, WiX ends `[INSTALLDIR]` with a
            // separator, and Windows compares paths case-insensitively.
            assert!(same_install_location(
                "\"C:\\Program Files\\AioLM\"",
                directory
            ));
            assert!(same_install_location(r"C:\Program Files\AioLM\", directory));
            assert!(same_install_location(r"c:\program files\aiolm", directory));
            assert!(same_install_location(" C:/Program Files/AioLM ", directory));
            // `current_exe` can hand back the extended form.
            assert!(same_install_location(
                r"C:\Program Files\AioLM",
                Path::new(r"\\?\C:\Program Files\AioLM")
            ));
            assert!(same_install_location(
                r"\\?\C:\Program Files\AioLM\",
                directory
            ));
            assert!(same_install_location(
                r"\\server\share\AioLM",
                Path::new(r"\\?\UNC\server\share\AioLM")
            ));
            assert!(!same_install_location(
                r"C:\Program Files\AioLM Nightly",
                directory
            ));
            assert!(!same_install_location("", directory));
            assert!(!same_install_location("   ", directory));
        }

        /// The directory an installed copy actually runs from exists, so this
        /// covers the canonicalising branch, including the short-name and
        /// extended spellings `current_exe` and the registry can disagree on.
        #[test]
        fn an_existing_install_location_matches_through_its_canonical_path() {
            let root = std::env::temp_dir().join(format!(
                "aiolm-update-location-{}",
                uuid::Uuid::new_v4().simple()
            ));
            let directory = root.join("AioLM");
            std::fs::create_dir_all(&directory).expect("create the test install directory");
            assert!(same_install_location(
                &format!("\"{}\"", directory.display()),
                &directory
            ));
            assert!(same_install_location(
                &format!("{}\\", directory.display()),
                &directory
            ));
            assert!(same_install_location(
                &directory.to_string_lossy().to_uppercase(),
                &directory
            ));
            assert!(!same_install_location(&root.to_string_lossy(), &directory));
            std::fs::remove_dir_all(&root).expect("remove the test install directory");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, digest: Option<&str>) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            browser_download_url: format!(
                "https://github.com/{RELEASE_REPOSITORY}/releases/download/v0.1.12/{name}"
            ),
            digest: digest.map(str::to_owned),
            size: 1024,
        }
    }

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.to_string(),
            html_url: Some(format!(
                "https://github.com/{RELEASE_REPOSITORY}/releases/tag/{tag}"
            )),
            published_at: Some("2026-09-20T12:00:00Z".to_string()),
            body: Some("  Fixes.  ".to_string()),
            assets: vec![
                asset("AioLM_0.1.12_x64-setup.exe", Some(&"a".repeat(64))),
                asset("AioLM_0.1.12_x64_en-US.msi", Some(&"b".repeat(64))),
            ],
            ..Release::default()
        }
    }

    #[test]
    fn versions_compare_numerically_rather_than_as_text() {
        assert!(parse_version("0.1.10").unwrap() > parse_version("0.1.9").unwrap());
        assert!(parse_version("0.10.0").unwrap() > parse_version("0.2.99").unwrap());
        assert!(parse_version("v1.0.0").unwrap() > parse_version("0.99.99").unwrap());
        assert_eq!(
            parse_version("0.1.11").unwrap(),
            parse_version("v0.1.11").unwrap()
        );
    }

    #[test]
    fn only_plain_three_part_release_versions_parse() {
        for rejected in [
            "1.2.3-rc.1",
            "1.2.3+build",
            "1.2",
            "1.2.3.4",
            "latest",
            "",
            "1.2.x",
            "9999999999.0.0",
            " 1.2.3",
        ] {
            assert!(
                parse_version(rejected).is_err(),
                "{rejected} must not parse as a stable release version"
            );
        }
    }

    #[test]
    fn an_equal_or_older_latest_release_is_reported_without_offering_an_update() {
        let current = parse_version("0.1.11").unwrap();
        let same = stable_release(current, &release("v0.1.11")).expect("stable release");
        assert_eq!(same.version, "0.1.11");
        assert!(!same.newer);
        let older = stable_release(current, &release("v0.1.10")).expect("stable release");
        assert!(!older.newer);
        let newer = stable_release(current, &release("v0.1.12")).expect("stable release");
        assert!(newer.newer);
        assert_eq!(newer.notes.as_deref(), Some("Fixes."));
        assert_eq!(
            newer.release_url.as_deref(),
            Some("https://github.com/aiolm/AioLM/releases/tag/v0.1.12")
        );
        assert_eq!(newer.published_at.as_deref(), Some("2026-09-20T12:00:00Z"));
    }

    #[test]
    fn drafts_pre_releases_and_non_release_tags_are_never_offered() {
        let current = parse_version("0.1.11").unwrap();
        let draft = Release {
            draft: true,
            ..release("v0.1.12")
        };
        assert!(stable_release(current, &draft).is_none());
        let prerelease = Release {
            prerelease: true,
            ..release("v0.1.12")
        };
        assert!(stable_release(current, &prerelease).is_none());
        assert!(stable_release(current, &release("v0.1.12-rc.1")).is_none());
        assert!(stable_release(current, &release("nightly")).is_none());
    }

    #[test]
    fn a_release_page_url_from_another_repository_is_not_passed_to_the_renderer() {
        let current = parse_version("0.1.11").unwrap();
        let spoofed = Release {
            html_url: Some("https://github.com/attacker/AioLM/releases/tag/v0.1.12".to_string()),
            ..release("v0.1.12")
        };
        let update = stable_release(current, &spoofed).expect("stable release");
        assert!(update.newer);
        assert!(update.release_url.is_none());
    }

    #[test]
    fn asset_download_urls_are_limited_to_this_repository_and_github_delivery_hosts() {
        assert!(validate_asset_url(
            "https://github.com/aiolm/AioLM/releases/download/v0.1.12/AioLM_0.1.12_x64-setup.exe"
        )
        .is_ok());
        assert!(validate_asset_url(
            "https://objects.githubusercontent.com/github-production-release-asset/1/2"
        )
        .is_ok());
        for rejected in [
            "http://github.com/aiolm/AioLM/releases/download/v0.1.12/AioLM_0.1.12_x64-setup.exe",
            "https://github.com/attacker/AioLM/releases/download/v0.1.12/AioLM_0.1.12_setup.exe",
            "https://github.com.attacker.example/aiolm/AioLM/releases/download/v0.1.12/setup.exe",
            "https://githubusercontent.com.attacker.example/asset",
            "file:///C:/Windows/System32/cmd.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "https://github.com/aiolm/AioLM/archive/refs/heads/main.zip",
            "not a url",
        ] {
            assert!(
                validate_asset_url(rejected).is_err(),
                "{rejected} must not be accepted as a release asset URL"
            );
        }
    }

    #[test]
    fn only_a_canonical_version_string_from_the_renderer_reaches_a_tag_lookup() {
        assert_eq!(
            parse_requested_version("0.1.12").unwrap(),
            parse_version("0.1.12").unwrap()
        );
        for rejected in [
            "v0.1.12",
            "0.1.12/../../../releases/latest",
            "..%2F..%2Flatest",
            "01.1.12",
            "0.1.12 ",
            "latest",
            "0.1.12?full=1",
            "0.1.12#fragment",
        ] {
            assert!(
                parse_requested_version(rejected).is_err(),
                "{rejected} must not be accepted as an install target"
            );
        }
    }

    #[test]
    fn installer_asset_names_match_the_release_workflow_assets() {
        assert_eq!(
            installer_asset_name(InstallKind::Nsis, "0.1.12"),
            "AioLM_0.1.12_x64-setup.exe"
        );
        assert_eq!(
            installer_asset_name(InstallKind::Msi, "0.1.12"),
            "AioLM_0.1.12_x64_en-US.msi"
        );
        for (os, arch, expected) in [
            ("macos", "x86_64", "AioLM_0.1.12_x64.dmg"),
            ("macos", "aarch64", "AioLM_0.1.12_aarch64.dmg"),
            ("linux", "x86_64", "AioLM_0.1.12_amd64.deb"),
            ("linux", "aarch64", "AioLM_0.1.12_arm64.deb"),
        ] {
            let kind = unix_install_kind(os, arch).unwrap();
            assert_eq!(installer_asset_name(kind, "0.1.12"), expected);
            assert!(installable(
                Some(kind),
                &[asset(expected, Some(&"c".repeat(64)))],
                "0.1.12"
            ));
            assert!(!installable(
                Some(kind),
                &release("v0.1.12").assets,
                "0.1.12"
            ));
        }
        assert!(unix_install_kind("linux", "riscv64").is_none());
        assert!(unix_install_kind("macos", "x86").is_none());
        assert!(unix_install_kind("freebsd", "x86_64").is_none());
    }

    #[test]
    fn mac_updates_require_the_app_installed_in_an_applications_folder() {
        let home = Path::new("/Users/synthetic");
        assert!(mac_install_location(
            Path::new("/Applications/AioLM.app/Contents/MacOS/aiolm"),
            Some(home)
        ));
        assert!(mac_install_location(
            &home.join("Applications/AioLM.app/Contents/MacOS/aiolm"),
            Some(home)
        ));
        for path in [
            "/Volumes/AioLM/AioLM.app/Contents/MacOS/aiolm",
            "/private/var/folders/test/AppTranslocation/id/d/AioLM.app/Contents/MacOS/aiolm",
            "/tmp/build/AioLM.app/Contents/MacOS/aiolm",
            "/Applications/Other.app/Contents/MacOS/aiolm",
            "/Applications/AioLM.app/Contents/MacOS/aiolm-cli",
        ] {
            assert!(!mac_install_location(Path::new(path), Some(home)), "{path}");
        }
    }

    #[test]
    fn deb_updates_require_exact_file_ownership_and_installed_architecture() {
        let executable = Path::new("/usr/bin/aiolm");
        assert_eq!(
            deb_package_owner("aio-lm: /usr/bin/aiolm\n", executable, InstallerArch::X64),
            Some("aio-lm".into())
        );
        assert_eq!(
            deb_package_owner(
                "aio-lm:arm64: /usr/bin/aiolm\n",
                executable,
                InstallerArch::Arm64
            ),
            Some("aio-lm:arm64".into())
        );
        for output in [
            "other: /usr/bin/aiolm",
            "aio-lm: /usr/bin/aiolm-cli",
            "aio-lm:arm64: /usr/bin/aiolm",
            "aio-lm, other: /usr/bin/aiolm",
            "local diversion from: /usr/bin/aiolm",
            "aio-lm: /tmp/.mount_app/usr/bin/aiolm",
        ] {
            assert!(
                deb_package_owner(output, executable, InstallerArch::X64).is_none(),
                "{output}"
            );
        }
        assert!(deb_status_matches(
            "aio-lm\tinstalled\tamd64\n",
            InstallerArch::X64
        ));
        for output in [
            "aio-lm\tinstalled\tarm64",
            "aio-lm\tconfig-files\tamd64",
            "other\tinstalled\tamd64",
            "aio-lm\tinstalled\tamd64\nextra",
        ] {
            assert!(!deb_status_matches(output, InstallerArch::X64), "{output}");
        }
    }

    #[test]
    fn an_unrecognised_installation_or_a_missing_asset_cannot_be_installed() {
        let assets = release("v0.1.12").assets;
        assert!(installable(Some(InstallKind::Nsis), &assets, "0.1.12"));
        assert!(installable(Some(InstallKind::Msi), &assets, "0.1.12"));
        // An unsupported platform, or an installation this app cannot
        // identify, reports no install kind at all.
        assert!(!installable(None, &assets, "0.1.12"));
        // The release carries no asset for a version it does not publish.
        assert!(!installable(Some(InstallKind::Nsis), &assets, "0.1.13"));
        let untrusted = vec![ReleaseAsset {
            browser_download_url: "https://cdn.attacker.example/AioLM_0.1.12_x64-setup.exe"
                .to_string(),
            ..asset("AioLM_0.1.12_x64-setup.exe", Some(&"a".repeat(64)))
        }];
        assert!(!installable(Some(InstallKind::Nsis), &untrusted, "0.1.12"));
    }

    #[cfg(not(windows))]
    #[test]
    fn an_uninstalled_test_binary_reports_no_install_kind() {
        assert!(detect_install_kind().is_err());
    }

    #[test]
    fn digests_are_accepted_only_as_a_sha256_value() {
        assert_eq!(
            normalize_digest(&format!("sha256:{}", "A".repeat(64))).unwrap(),
            "a".repeat(64)
        );
        assert_eq!(normalize_digest(&"f".repeat(64)).unwrap(), "f".repeat(64));
        for rejected in [
            "sha256:".to_string(),
            "sha512:0123".to_string(),
            "a".repeat(63),
            "a".repeat(65),
            "z".repeat(64),
            String::new(),
        ] {
            assert!(
                normalize_digest(&rejected).is_err(),
                "{rejected} must not be accepted as a digest"
            );
        }
    }

    #[test]
    fn a_checksums_entry_is_used_only_for_an_exact_asset_name_match() {
        let checksums = format!(
            "{}  AioLM_0.1.12_x64-setup.exe\n{}  AioLM_0.1.12_x64_en-US.msi\n",
            "a".repeat(64),
            "b".repeat(64)
        );
        assert_eq!(
            digest_from_checksums(&checksums, "AioLM_0.1.12_x64-setup.exe"),
            Some("a".repeat(64))
        );
        assert_eq!(
            digest_from_checksums(&checksums, "AioLM_0.1.12_x64_en-US.msi"),
            Some("b".repeat(64))
        );
        // An asset the release never published, a truncated hash, and a line
        // whose name merely contains the asset name all fail closed.
        assert_eq!(
            digest_from_checksums(&checksums, "AioLM_0.1.13_x64-setup.exe"),
            None
        );
        assert_eq!(
            digest_from_checksums(
                "abc  AioLM_0.1.12_x64-setup.exe",
                "AioLM_0.1.12_x64-setup.exe"
            ),
            None
        );
        assert_eq!(
            digest_from_checksums(
                &format!("{}  prefix-AioLM_0.1.12_x64-setup.exe", "a".repeat(64)),
                "AioLM_0.1.12_x64-setup.exe"
            ),
            None
        );
        assert_eq!(
            digest_from_checksums("", "AioLM_0.1.12_x64-setup.exe"),
            None
        );
    }

    #[tokio::test]
    async fn a_release_without_a_digest_or_checksums_refuses_to_install() {
        let assets = vec![asset("AioLM_0.1.12_x64-setup.exe", None)];
        let error = expected_digest(&assets[0], &assets)
            .await
            .expect_err("an unverified installer must be refused");
        assert!(
            error.contains("refusing an unverified installer"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_malformed_published_digest_is_refused_rather_than_worked_around() {
        let assets = vec![asset("AioLM_0.1.12_x64-setup.exe", Some("sha256:nope"))];
        assert!(expected_digest(&assets[0], &assets).await.is_err());
    }

    /// `can_install` must not offer an install that `install` refuses before
    /// downloading anything. A published digest is the only source when there
    /// is one, so a malformed one is never replaced by `checksums.txt`; without
    /// one, only a trusted `checksums.txt` can supply it, and its contents are
    /// fetched and matched at install time rather than here.
    #[tokio::test]
    async fn an_install_is_offered_only_when_its_installer_has_a_digest_to_match() {
        let valid = "c".repeat(64);
        let padded = format!("  sha256:{}  ", "C".repeat(64));
        let checksums = asset(CHECKSUMS_ASSET, None);
        let untrusted_checksums = ReleaseAsset {
            browser_download_url: format!("https://cdn.attacker.example/{CHECKSUMS_ASSET}"),
            ..asset(CHECKSUMS_ASSET, None)
        };
        let not_sha256: Result<String, String> =
            Err("release asset digest is not a SHA-256 value".to_string());
        let untrusted: Result<String, String> =
            Err("release asset host is not trusted: cdn.attacker.example".to_string());
        let mut failures = Vec::new();
        for kind in [
            InstallKind::Nsis,
            InstallKind::Msi,
            InstallKind::Dmg(InstallerArch::X64),
            InstallKind::Dmg(InstallerArch::Arm64),
            InstallKind::Deb(InstallerArch::X64),
            InstallKind::Deb(InstallerArch::Arm64),
        ] {
            let name = installer_asset_name(kind, "0.1.12");
            let installer = |digest: Option<&str>| asset(&name, digest);
            let unverified: Result<String, String> = Err(format!(
                "release publishes no SHA-256 digest for {name} and no {CHECKSUMS_ASSET}; refusing an unverified installer"
            ));
            // (case, assets with the installer first, offered, what
            // `expected_digest` decides without a request; `None` where it
            // would have to download `checksums.txt`)
            let cases = [
                (
                    "no digest or checksums",
                    vec![installer(None)],
                    false,
                    Some(unverified.clone()),
                ),
                (
                    "malformed digest",
                    vec![installer(Some("sha256:nope"))],
                    false,
                    Some(not_sha256.clone()),
                ),
                (
                    "malformed digest beside trusted checksums",
                    vec![installer(Some("sha256:nope")), checksums.clone()],
                    false,
                    Some(not_sha256.clone()),
                ),
                (
                    "blank digest beside trusted checksums",
                    vec![installer(Some("  ")), checksums.clone()],
                    false,
                    Some(not_sha256.clone()),
                ),
                (
                    "bare digest",
                    vec![installer(Some(&valid))],
                    true,
                    Some(Ok(valid.clone())),
                ),
                (
                    "prefixed upper-case padded digest",
                    vec![installer(Some(&padded))],
                    true,
                    Some(Ok(valid.clone())),
                ),
                (
                    "digest beside untrusted checksums",
                    vec![installer(Some(&valid)), untrusted_checksums.clone()],
                    true,
                    Some(Ok(valid.clone())),
                ),
                (
                    "digest on an untrusted installer URL",
                    vec![ReleaseAsset {
                        browser_download_url: format!("https://cdn.attacker.example/{name}"),
                        ..installer(Some(&valid))
                    }],
                    false,
                    Some(Ok(valid.clone())),
                ),
                (
                    "no digest, trusted checksums",
                    vec![installer(None), checksums.clone()],
                    true,
                    None,
                ),
                (
                    "no digest, untrusted checksums",
                    vec![installer(None), untrusted_checksums.clone()],
                    false,
                    Some(untrusted.clone()),
                ),
                (
                    "no digest, checksums under another name",
                    vec![installer(None), asset("Checksums.txt", None)],
                    false,
                    Some(unverified.clone()),
                ),
                (
                    "no digest, untrusted checksums listed first",
                    vec![
                        installer(None),
                        untrusted_checksums.clone(),
                        checksums.clone(),
                    ],
                    false,
                    Some(untrusted.clone()),
                ),
                (
                    "no digest, trusted checksums listed first",
                    vec![
                        installer(None),
                        checksums.clone(),
                        untrusted_checksums.clone(),
                    ],
                    true,
                    None,
                ),
            ];
            for (case, assets, offered, offline) in cases {
                if installable(Some(kind), &assets, "0.1.12") != offered {
                    failures.push(format!("{name}, {case}: offered should be {offered}"));
                }
                if let Some(decision) = offline {
                    let actual = expected_digest(&assets[0], &assets).await;
                    if actual != decision {
                        failures.push(format!("{name}, {case}: expected_digest gave {actual:?}"));
                    }
                }
            }
            // A digest never stands in for a recognised installation or the
            // requested version's asset.
            let verified = [installer(Some(&valid))];
            assert!(!installable(None, &verified, "0.1.12"), "{name}");
            assert!(!installable(Some(kind), &verified, "0.1.13"), "{name}");
        }
        assert!(failures.is_empty(), "{failures:#?}");
        // Nor for the installer of another architecture.
        for (kind, other) in [
            (
                InstallKind::Dmg(InstallerArch::Arm64),
                "AioLM_0.1.12_x64.dmg",
            ),
            (
                InstallKind::Deb(InstallerArch::Arm64),
                "AioLM_0.1.12_amd64.deb",
            ),
        ] {
            assert!(
                !installable(Some(kind), &[asset(other, Some(&valid))], "0.1.12"),
                "{other}"
            );
        }
    }

    /// `INSTALL_RUNNING` is process-wide, exactly as it is for the app, so the
    /// tests that take it run one at a time instead of failing each other.
    async fn install_serialiser() -> tokio::sync::MutexGuard<'static, ()> {
        static ORDER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        ORDER.lock().await
    }

    #[tokio::test]
    async fn only_one_installation_may_run_at_a_time() {
        let _order = install_serialiser().await;
        for _ in 0..3 {
            let guard = InstallGuard::acquire().expect("first install acquires the guard");
            assert!(InstallGuard::acquire().is_err());
            // Dropping models a finished install, a failed download and a
            // rejected digest alike: the next attempt must be able to start.
            drop(guard);
        }
        assert!(InstallGuard::acquire().is_ok());
    }

    #[tokio::test]
    async fn an_install_is_refused_before_any_download_when_it_is_not_newer() {
        let _order = install_serialiser().await;
        let progress = |_: &str, _: u64, _: Option<u64>| {
            panic!("a rejected install must not report progress");
        };
        // Rejections before the installer is verified must leave running
        // sessions alone, so the pre-launch shutdown hook must not run.
        let before_launch = || {
            panic!("a rejected install must not stop running sessions");
        };
        let error = install(&progress, "0.1.11", "0.1.11", Some(&before_launch))
            .await
            .expect_err("installing the running version must be refused");
        assert!(error.contains("is not newer"), "{error}");
        let error = install(&progress, "0.1.10", "0.1.11", Some(&before_launch))
            .await
            .expect_err("installing an older version must be refused");
        assert!(error.contains("is not newer"), "{error}");
        let error = install(&progress, "latest", "0.1.11", Some(&before_launch))
            .await
            .expect_err("a non-version install target must be refused");
        assert!(error.contains("stable MAJOR.MINOR.PATCH"), "{error}");
    }

    /// A test binary is never a registered installation, so this also keeps
    /// `cargo test` from reaching GitHub: the install kind is resolved before
    /// any release is fetched, and no installer is ever run.
    #[tokio::test]
    async fn an_installation_this_app_cannot_identify_is_refused_before_any_release_lookup() {
        let _order = install_serialiser().await;
        let progress = |_: &str, _: u64, _: Option<u64>| {
            panic!("a rejected install must not report progress");
        };
        let before_launch = || {
            panic!("a rejected install must not stop running sessions");
        };
        let error = install(&progress, "999.0.0", "0.1.11", Some(&before_launch))
            .await
            .expect_err("an unidentified installation must be refused");
        assert!(error.contains("release page"), "{error}");
    }

    #[test]
    fn the_status_the_renderer_receives_keeps_its_snake_case_contract() {
        let status = UpdateStatus {
            current_version: "0.1.11".to_string(),
            latest_version: Some("0.1.12".to_string()),
            available: true,
            can_install: true,
            release_url: Some("https://github.com/aiolm/AioLM/releases/tag/v0.1.12".to_string()),
            published_at: Some("2026-09-20T12:00:00Z".to_string()),
            notes: Some("Fixes.".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&status).expect("status serialises"),
            serde_json::json!({
                "current_version": "0.1.11",
                "latest_version": "0.1.12",
                "available": true,
                "can_install": true,
                "release_url": "https://github.com/aiolm/AioLM/releases/tag/v0.1.12",
                "published_at": "2026-09-20T12:00:00Z",
                "notes": "Fixes."
            })
        );
        let unknown = UpdateStatus {
            current_version: "0.1.11".to_string(),
            latest_version: None,
            available: false,
            can_install: false,
            release_url: None,
            published_at: None,
            notes: None,
        };
        let value = serde_json::to_value(&unknown).expect("status serialises");
        assert!(value["latest_version"].is_null());
        assert_eq!(value["available"], serde_json::json!(false));
        assert_eq!(value["can_install"], serde_json::json!(false));
    }

    #[test]
    fn a_missing_latest_release_reads_as_nothing_published_and_every_other_status_as_an_error() {
        let body = serde_json::json!({
            "tag_name": "v0.1.12",
            "assets": []
        })
        .to_string();
        let release = release_from_response(reqwest::StatusCode::OK, &body)
            .expect("a published release parses")
            .expect("a published release is returned");
        assert_eq!(release.tag_name, "v0.1.12");
        // A repository with no releases, and a tag that does not exist, both
        // answer 404; the callers decide what that means.
        assert!(release_from_response(
            reqwest::StatusCode::NOT_FOUND,
            "{\"message\":\"Not Found\"}"
        )
        .expect("a missing release is not a failure")
        .is_none());
        let error = release_from_response(
            reqwest::StatusCode::FORBIDDEN,
            "{\"message\":\"API rate limit exceeded\"}",
        )
        .expect_err("a refused lookup must stay an error");
        assert!(error.contains("403"), "{error}");
        assert!(error.contains("API rate limit exceeded"), "{error}");
        assert!(release_from_response(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "").is_err());
        assert!(release_from_response(reqwest::StatusCode::OK, "not json").is_err());
    }

    /// One HTTP response from a loopback listener, so the metadata reading
    /// path is exercised without reaching GitHub. `content_length` chooses
    /// between a declared length and a body that ends when the socket closes.
    async fn serve_once(status: u16, body: Vec<u8>, content_length: bool) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the loopback listener");
        let address = listener.local_addr().expect("the listener address");
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept the request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await;
            let head = if content_length {
                format!(
                    "HTTP/1.1 {status} STATUS\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                )
            } else {
                format!("HTTP/1.1 {status} STATUS\r\nConnection: close\r\n\r\n")
            };
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&body).await;
            let _ = stream.shutdown().await;
        });
        format!("http://{address}/repos/{RELEASE_REPOSITORY}/releases/latest")
    }

    async fn read_served(
        status: u16,
        body: Vec<u8>,
        content_length: bool,
        limit: usize,
    ) -> Result<(reqwest::StatusCode, String), String> {
        let url = serve_once(status, body, content_length).await;
        let response = reqwest::Client::new()
            .get(&url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let text = bounded_text(response, limit, "release metadata").await?;
        Ok((status, text))
    }

    #[tokio::test]
    async fn the_release_lookup_reads_a_served_response_through_to_its_outcome() {
        let published = serde_json::json!({
            "tag_name": "v0.1.12",
            "draft": false,
            "prerelease": false,
            "assets": []
        })
        .to_string();
        let (status, body) = read_served(200, published.into_bytes(), true, MAX_METADATA_BYTES)
            .await
            .expect("the served release is read");
        assert_eq!(
            release_from_response(status, &body)
                .expect("the served release parses")
                .expect("the served release is returned")
                .tag_name,
            "v0.1.12"
        );

        let (status, body) = read_served(
            404,
            b"{\"message\":\"Not Found\"}".to_vec(),
            true,
            MAX_METADATA_BYTES,
        )
        .await
        .expect("the served 404 is read");
        assert!(release_from_response(status, &body)
            .expect("a served 404 is not a failure")
            .is_none());
    }

    #[tokio::test]
    async fn a_metadata_response_is_refused_once_it_passes_its_limit() {
        // Declared up front…
        let error = read_served(200, vec![b'a'; 512], true, 128)
            .await
            .expect_err("an oversized response must be refused");
        assert!(error.contains("exceeds its size limit"), "{error}");
        // …and while streaming, when no length was declared at all.
        let error = read_served(200, vec![b'a'; 512], false, 128)
            .await
            .expect_err("an oversized streamed response must be refused");
        assert!(error.contains("exceeds its size limit"), "{error}");
        let (_, body) = read_served(200, vec![b'a'; 64], false, 128)
            .await
            .expect("a response inside the limit is read");
        assert_eq!(body.len(), 64);
    }

    #[tokio::test]
    async fn a_launched_installer_keeps_the_latch_closed_until_the_process_exits() {
        let _order = install_serialiser().await;
        // The app shuts down after the installer starts, but its window is
        // still up: a second invoke in that window must not start a second
        // installer, so the guard is not handed back.
        InstallGuard::acquire()
            .expect("the first install acquires the latch")
            .hold_until_exit();
        assert!(InstallGuard::acquire().is_err());
        // Only this test can reopen the latch, exactly because nothing in the
        // running app does.
        INSTALL_RUNNING.store(false, Ordering::Release);

        // A failure before the installer starts hands it straight back.
        let progress = |_: &str, _: u64, _: Option<u64>| {
            panic!("a rejected install must not report progress");
        };
        let before_launch = || {
            panic!("a rejected install must not stop running sessions");
        };
        assert!(install(&progress, "0.1.10", "0.1.11", Some(&before_launch))
            .await
            .is_err());
        assert!(InstallGuard::acquire().is_ok());
    }

    #[test]
    fn the_release_page_the_app_opens_is_the_official_one() {
        assert_eq!(
            RELEASE_PAGE_URL,
            "https://github.com/aiolm/AioLM/releases/latest"
        );
        assert!(validate_release_page_url(RELEASE_PAGE_URL).is_ok());
    }

    type BodyChunk = Result<Vec<u8>, std::io::Error>;
    type Accepted = std::sync::Arc<std::sync::Mutex<(Sha256, u64)>>;

    /// An installer response whose body is the given chunks, read through the
    /// same `reqwest::Response::chunk` the download uses. No socket is opened.
    fn streamed_response<S>(chunks: S) -> reqwest::Response
    where
        S: futures_util::Stream<Item = BodyChunk> + Send + 'static,
    {
        reqwest::Response::from(tauri::http::Response::new(reqwest::Body::wrap_stream(
            chunks,
        )))
    }

    /// A response the test feeds one chunk at a time; the body stays pending
    /// until the next chunk is sent and ends when the sender is dropped.
    fn scripted_response() -> (
        tokio::sync::mpsc::UnboundedSender<BodyChunk>,
        reqwest::Response,
    ) {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let response = streamed_response(futures_util::stream::poll_fn(move |cx| {
            receiver.poll_recv(cx)
        }));
        (sender, response)
    }

    /// Body bytes that depend on their offset, so a dropped, repeated or
    /// reordered chunk changes what the writer receives.
    fn body_bytes(offset: u64, len: usize) -> Vec<u8> {
        (0..len as u64)
            .map(|index| ((offset + index) % 251) as u8)
            .collect()
    }

    fn body_sha(len: u64) -> String {
        let mut hasher = Sha256::new();
        let mut offset = 0;
        while offset < len {
            let piece = (len - offset).min(65536);
            hasher.update(body_bytes(offset, piece as usize));
            offset += piece;
        }
        format!("{:x}", hasher.finalize())
    }

    /// Stands in for the installer file: hashes what it accepts, and can cap
    /// each write, fail or stay pending (never woken) once a byte count is
    /// reached, or fail its flush.
    struct TestWriter {
        accepted: Accepted,
        max_write: usize,
        fail_at: Option<u64>,
        pend_at: Option<u64>,
        fail_flush: bool,
    }

    impl TestWriter {
        fn new() -> (Self, Accepted) {
            let accepted = Accepted::default();
            let writer = TestWriter {
                accepted: accepted.clone(),
                max_write: usize::MAX,
                fail_at: None,
                pend_at: None,
                fail_flush: false,
            };
            (writer, accepted)
        }
    }

    impl tokio::io::AsyncWrite for TestWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            let mut accepted = self.accepted.lock().expect("writer state");
            let open = self.pend_at.map_or(u64::MAX, |at| at - accepted.1);
            if open == 0 {
                return std::task::Poll::Pending;
            }
            let room = self
                .fail_at
                .map_or(u64::MAX, |at| at - accepted.1)
                .min(open);
            if room == 0 {
                return std::task::Poll::Ready(Err(std::io::Error::other(
                    "synthetic write failure",
                )));
            }
            let len = buf
                .len()
                .min(self.max_write)
                .min(usize::try_from(room).unwrap_or(usize::MAX));
            accepted.0.update(&buf[..len]);
            accepted.1 += len as u64;
            std::task::Poll::Ready(Ok(len))
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(if self.fail_flush {
                Err(std::io::Error::other("synthetic flush failure"))
            } else {
                Ok(())
            })
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    fn accepted_bytes(accepted: &Accepted) -> (String, u64) {
        let accepted = accepted.lock().expect("writer state");
        (format!("{:x}", accepted.0.clone().finalize()), accepted.1)
    }

    /// Long enough that no report in a test is ever due to time alone.
    const UNHURRIED: Duration = Duration::from_secs(3600);

    /// Writes a body of `sizes` chunks, optionally ending in a read error,
    /// and returns the result, the byte count of every report, and what the
    /// writer accepted.
    async fn write_chunks(
        sizes: &[usize],
        stream_error: bool,
        total: Option<u64>,
        limit: u64,
        interval: Duration,
        (writer, accepted): (TestWriter, Accepted),
    ) -> (Result<u64, String>, Vec<u64>, (String, u64)) {
        let mut offset = 0_u64;
        let mut chunks: Vec<BodyChunk> = sizes
            .iter()
            .map(|&len| {
                let chunk = body_bytes(offset, len);
                offset += len as u64;
                Ok(chunk)
            })
            .collect();
        if stream_error {
            chunks.push(Err(std::io::Error::other("synthetic stream failure")));
        }
        let reports = std::sync::Mutex::new(Vec::new());
        let progress = |phase: &str, downloaded: u64, reported_total: Option<u64>| {
            assert_eq!((phase, reported_total), ("downloading", total));
            reports.lock().expect("reports").push(downloaded);
        };
        let response = streamed_response(futures_util::stream::iter(chunks));
        let result = write_installer(&progress, response, writer, total, limit, interval).await;
        (
            result,
            reports.into_inner().expect("reports"),
            accepted_bytes(&accepted),
        )
    }

    #[tokio::test]
    async fn a_download_reports_its_first_bytes_and_each_whole_percent_through_the_last_byte() {
        // An empty frame, then 4,000 chunks of 25 bytes: one report for the
        // first bytes, then one per percentage shown, the last of them the
        // full size. The panel's floating point still shows 29,000, 57,000
        // and 58,000 of 100,000 as the percentage below, so the chunk after
        // each of them is the one that shows the next.
        let mut sizes = vec![0];
        sizes.extend([25; 4000]);
        let (result, reports, written) = write_chunks(
            &sizes,
            false,
            Some(100_000),
            100_000,
            UNHURRIED,
            TestWriter::new(),
        )
        .await;
        assert_eq!(result, Ok(100_000));
        let mut expected: Vec<u64> = vec![25];
        expected.extend((1..=100).map(|percent| match percent {
            29 | 57 | 58 => percent * 1000 + 25,
            _ => percent * 1000,
        }));
        assert_eq!(reports, expected);
        assert_eq!(written, (body_sha(100_000), 100_000));

        // Chunks larger than a percent are each reported, as every chunk was.
        let (result, reports, _) = write_chunks(
            &[300, 300, 400],
            false,
            Some(1000),
            1000,
            UNHURRIED,
            TestWriter::new(),
        )
        .await;
        assert_eq!(result, Ok(1000));
        assert_eq!(reports, vec![300, 600, 1000]);

        // Short writes still put every byte in the file, in order.
        let (mut writer, accepted) = TestWriter::new();
        writer.max_write = 7;
        let (result, reports, written) = write_chunks(
            &[1000, 2000, 3000],
            false,
            Some(6000),
            6000,
            UNHURRIED,
            (writer, accepted),
        )
        .await;
        assert_eq!(result, Ok(6000));
        assert_eq!(reports, vec![1000, 3000, 6000]);
        assert_eq!(written, (body_sha(6000), 6000));
    }

    #[tokio::test]
    async fn a_download_reports_the_writes_that_change_the_percentage_the_settings_panel_shows() {
        // The panel shows `Math.min(100, Math.floor(downloaded / total * 100))`
        // in floating point, where 29,000 of 100,000 still shows 28%: the
        // write that first shows 29% is the one reaching 29,025.
        let (result, reports, written) = write_chunks(
            &[28_000, 1000, 25, 70_975],
            false,
            Some(100_000),
            100_000,
            UNHURRIED,
            TestWriter::new(),
        )
        .await;
        assert_eq!(result, Ok(100_000));
        assert_eq!(reports, vec![28_000, 29_025, 100_000]);
        assert_eq!(written, (body_sha(100_000), 100_000));
    }

    #[tokio::test]
    async fn a_download_of_unknown_size_is_reported_by_time_rather_than_by_every_chunk() {
        for total in [None, Some(0)] {
            let (result, reports, written) = write_chunks(
                &[50; 2000],
                false,
                total,
                100_000,
                UNHURRIED,
                TestWriter::new(),
            )
            .await;
            assert_eq!(result, Ok(100_000));
            // Nothing after the first bytes falls due within the hour, so
            // the rest is the one report made when the body ends.
            assert_eq!(reports, vec![50, 100_000]);
            assert_eq!(written, (body_sha(100_000), 100_000));
        }
        // Once the interval has passed, the next written chunk is reported;
        // an empty frame adds nothing to report.
        let (result, reports, _) = write_chunks(
            &[0, 50, 0, 50, 50],
            false,
            None,
            1000,
            Duration::ZERO,
            TestWriter::new(),
        )
        .await;
        assert_eq!(result, Ok(150));
        assert_eq!(reports, vec![50, 100, 150]);
    }

    #[tokio::test]
    async fn bytes_written_before_a_stalled_read_are_reported_once_while_it_waits_or_when_it_ends()
    {
        for (interval, while_waiting) in [
            (Duration::from_millis(20), vec![1_u64, 2]),
            (UNHURRIED, vec![1]),
        ] {
            let (sender, response) = scripted_response();
            let reports = std::sync::Mutex::new(Vec::new());
            let progress = |_: &str, downloaded: u64, _: Option<u64>| {
                reports.lock().expect("reports").push(downloaded);
            };
            let (writer, accepted) = TestWriter::new();
            let mut download = Box::pin(write_installer(
                &progress,
                response,
                writer,
                Some(1000),
                1000,
                interval,
            ));
            // Two bytes, then a read that stays pending: the second byte is
            // no new percent, so only the interval can report it.
            sender.send(Ok(body_bytes(0, 1))).expect("send a byte");
            sender.send(Ok(body_bytes(1, 1))).expect("send a byte");
            let waiting = async {
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut download => panic!("the body is still open"),
                        () = tokio::time::sleep(Duration::from_millis(10)) => {}
                    }
                    if accepted_bytes(&accepted).1 == 2
                        && *reports.lock().expect("reports") == while_waiting
                    {
                        break;
                    }
                }
            };
            tokio::time::timeout(Duration::from_secs(30), waiting)
                .await
                .expect("the pending read is reported as the interval allows");
            // The body ends without another chunk: whatever was unreported
            // is reported once, and nothing is reported twice.
            drop(sender);
            assert_eq!(download.await, Ok(2));
            assert_eq!(reports.into_inner().expect("reports"), vec![1, 2]);
        }
    }

    #[tokio::test]
    async fn a_failed_download_last_reports_only_bytes_that_were_written() {
        // The chunk past the limit is refused before it is written or counted.
        for total in [Some(1000), None] {
            let (result, reports, written) = write_chunks(
                &[500, 500, 1],
                false,
                total,
                1000,
                UNHURRIED,
                TestWriter::new(),
            )
            .await;
            assert_eq!(
                result,
                Err("installer download is larger than the release declares".to_string())
            );
            assert_eq!(reports, vec![500, 1000]);
            assert_eq!(written, (body_sha(1000), 1000));
        }
        // A body that fails after bytes that were not yet due a report.
        let (result, reports, written) = write_chunks(
            &[1; 5],
            true,
            Some(1000),
            1000,
            UNHURRIED,
            TestWriter::new(),
        )
        .await;
        assert_eq!(
            result,
            Err("installer download failed: error decoding response body".to_string())
        );
        assert_eq!(reports, vec![1, 5]);
        assert_eq!(written, (body_sha(5), 5));
        // A write that fails partway through the sixth chunk: those bytes may
        // be in the file, but they are never reported as downloaded.
        let (mut writer, accepted) = TestWriter::new();
        writer.fail_at = Some(2750);
        let (result, reports, written) =
            write_chunks(&[500; 10], false, None, 5000, UNHURRIED, (writer, accepted)).await;
        assert_eq!(
            result,
            Err("could not write the downloaded installer: synthetic write failure".to_string())
        );
        assert_eq!(reports, vec![500, 2500]);
        assert_eq!(written, (body_sha(2750), 2750));
        // Every byte is reported before the flush fails.
        let (mut writer, accepted) = TestWriter::new();
        writer.fail_flush = true;
        let (result, reports, written) =
            write_chunks(&[1; 50], false, None, 1000, UNHURRIED, (writer, accepted)).await;
        assert_eq!(
            result,
            Err("could not write the downloaded installer: synthetic flush failure".to_string())
        );
        assert_eq!(reports, vec![1, 50]);
        assert_eq!(written, (body_sha(50), 50));
    }

    #[tokio::test]
    async fn a_dropped_download_releases_its_body_and_file_and_reports_nothing_more() {
        // Dropped while the read for a third chunk is pending, and while the
        // write of a third chunk is pending after one of its bytes.
        for (pending, sizes, pend_at) in [
            ("read", vec![1, 1], None),
            ("write", vec![1, 1, 2], Some(3)),
        ] {
            let (sender, response) = scripted_response();
            let reports = std::sync::Mutex::new(Vec::new());
            let progress = |_: &str, downloaded: u64, _: Option<u64>| {
                reports.lock().expect("reports").push(downloaded);
            };
            let (mut writer, accepted) = TestWriter::new();
            writer.pend_at = pend_at;
            let interval = Duration::from_millis(200);
            let mut download = Box::pin(write_installer(
                &progress,
                response,
                writer,
                Some(1000),
                1000,
                interval,
            ));
            let mut offset = 0_u64;
            for len in sizes {
                sender.send(Ok(body_bytes(offset, len))).expect("send");
                offset += len as u64;
            }
            // The first byte is reported at once; the second, written in the
            // same poll, is no new percentage and not yet due.
            let reached = pend_at.unwrap_or(offset);
            let written = async {
                while accepted_bytes(&accepted).1 < reached {
                    tokio::select! {
                        biased;
                        _ = &mut download => panic!("the {pending} is still pending"),
                        () = tokio::task::yield_now() => {}
                    }
                }
            };
            tokio::time::timeout(Duration::from_secs(30), written)
                .await
                .expect("the bytes before the pending step are written");
            drop(download);
            assert!(
                sender.is_closed(),
                "the body goes with the download ({pending})"
            );
            assert_eq!(
                std::sync::Arc::strong_count(&accepted),
                1,
                "the file goes with the download ({pending})"
            );
            assert_eq!(*reports.lock().expect("reports"), vec![1], "{pending}");
            // Well past the interval, nothing that could report the second
            // byte has outlived the download.
            tokio::time::sleep(interval * 5).await;
            assert_eq!(*reports.lock().expect("reports"), vec![1], "{pending}");
        }
    }
}
