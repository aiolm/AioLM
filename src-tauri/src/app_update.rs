//! Application self-update: checking this project's published GitHub releases
//! for a newer stable version, and installing it with the Windows installer
//! that matches how this copy was installed.
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
    /// recognised installation, and a matching installer asset in the release.
    pub can_install: bool,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
}

/// Where install progress goes. Keeping this behind a callback lets the
/// download path run under `cargo test` without a Tauri window.
pub type ProgressSink<'a> = &'a (dyn Fn(&str, u64, Option<u64>) + Send + Sync);

/// The Windows installer flavour a copy of the app was installed with.
/// Updating with the other one would leave two registered installations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    Nsis,
    Msi,
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

/// The installer file names the release workflow publishes for Windows x64.
fn installer_asset_name(kind: InstallKind, version: &str) -> String {
    match kind {
        InstallKind::Nsis => format!("{PRODUCT_NAME}_{version}_x64-setup.exe"),
        InstallKind::Msi => format!("{PRODUCT_NAME}_{version}_x64_en-US.msi"),
    }
}

fn find_asset<'a>(assets: &'a [ReleaseAsset], name: &str) -> Result<&'a ReleaseAsset, String> {
    assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("release does not publish the installer asset {name}"))
}

/// Whether `install` could actually run for this release: a platform with a
/// published installer, an installation this app recognises, and an asset for
/// that installer with a download URL this app is willing to fetch.
fn installable(kind: Option<InstallKind>, assets: &[ReleaseAsset], version: &str) -> bool {
    kind.is_some_and(|kind| {
        find_asset(assets, &installer_asset_name(kind, version))
            .is_ok_and(|asset| validate_asset_url(&asset.browser_download_url).is_ok())
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
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|error| format!("could not write the downloaded installer: {error}"))?;
    let mut received = 0_u64;
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|error| format!("installer download failed: {error}"))?
    {
        received = received.saturating_add(chunk.len() as u64);
        if received > limit {
            return Err("installer download is larger than the release declares".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("could not write the downloaded installer: {error}"))?;
        progress("downloading", received, total);
    }
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

#[cfg(not(windows))]
pub fn detect_install_kind() -> Result<InstallKind, String> {
    Err("in-app updates are published for Windows x64 only".into())
}

#[cfg(windows)]
fn launch_installer(kind: InstallKind, path: &Path) -> Result<(), String> {
    windows_install::launch(kind, path)
}

#[cfg(not(windows))]
fn launch_installer(_kind: InstallKind, _path: &Path) -> Result<(), String> {
    Err("in-app updates are published for Windows x64 only".into())
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
    let can_install =
        latest.newer && installable(detect_install_kind().ok(), &release.assets, &latest.version);
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
    let kind = detect_install_kind()?;
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
        launch_installer(kind, &installer)
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
    fn platforms_without_a_published_installer_report_no_install_kind() {
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
        assert!(error.contains("Windows"), "{error}");
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
}
