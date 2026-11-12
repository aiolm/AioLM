use super::*;

const API_CACHE_TTL: Duration = Duration::from_secs(600);

const MAX_ASSET_CACHE_ENTRIES: usize = 128;

const MAX_GITHUB_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

const MAX_PR_INPUT_BYTES: usize = 512;

type AssetCache = HashMap<String, (Instant, Vec<Asset>)>;

// Cache the category with the message so retrying a failed lookup preserves
// the same command-visible error as the original request.
type ErrorCache = HashMap<String, (Instant, AppError)>;

pub(super) const LLAMA_REPOSITORY: &str = "ggml-org/llama.cpp";

/// GitHub releases produced by the PR runtime workflow. The release is
/// deliberately separate from upstream llama.cpp: it contains binaries built
/// from a reviewed PR commit, not source archives.
const PR_ARTIFACT_REPOSITORY: &str = match option_env!("AIOLM_PR_ARTIFACT_REPOSITORY") {
    Some(repository) => repository,
    None => match option_env!("LLAMA_BOARD_PR_ARTIFACT_REPOSITORY") {
        Some(repository) => repository,
        None => "aiolm/AioLM",
    },
};

pub(super) fn pull_request_advisories(resolved: &ResolvedPullRequest) -> Vec<String> {
    let mut advisories = Vec::new();
    if resolved.draft {
        advisories.push(PR_ADVISORY_DRAFT.to_string());
    }
    match resolved.source.state.as_str() {
        "merged" => advisories.push(PR_ADVISORY_MERGED.to_string()),
        "closed" => advisories.push(PR_ADVISORY_CLOSED.to_string()),
        _ => {}
    }
    if resolved.source.fork {
        advisories.push(PR_ADVISORY_FORK.to_string());
    }
    // A head with no branch name is a pull request whose branch was deleted
    // after it closed; the commit still exists, but nothing tracks it any more.
    if resolved.source.head_ref.trim().is_empty() {
        advisories.push(PR_ADVISORY_STALE_BRANCH.to_string());
    }
    advisories
}

#[derive(Deserialize, Clone, Debug, Default)]
pub(super) struct Rel {
    pub(super) tag_name: String,
    /// The release listing already carries every published asset, so choosing a
    /// build that actually has one costs no extra request.
    #[serde(default)]
    pub(super) assets: Vec<Asset>,
}

#[derive(Deserialize, Clone, Debug)]
pub(super) struct Asset {
    pub(super) name: String,
    pub(super) browser_download_url: String,
    #[serde(default)]
    pub(super) digest: Option<String>,
    #[serde(default)]
    pub(super) size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PullRequestRef {
    number: u64,
}

#[derive(Deserialize, Clone, Debug)]
struct PullRequestRepository {
    full_name: String,
}

#[derive(Deserialize, Clone, Debug)]
pub(super) struct PullRequestHead {
    sha: String,
    #[serde(default, rename = "ref")]
    pub(super) reference: String,
    repo: Option<PullRequestRepository>,
}

#[derive(Deserialize, Clone, Debug)]
struct PullRequestUser {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize, Clone, Debug)]
pub(super) struct PullRequestDetail {
    number: u64,
    pub(super) head: PullRequestHead,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    pub(super) draft: bool,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    user: Option<PullRequestUser>,
}

/// Prime live acceptance with public release metadata fetched by the CI job.
/// Its short-lived GitHub token stays outside the app and runtime processes.
/// Archive allowlists, digests and staged preflight still use the normal path.
#[cfg(feature = "test-fixtures")]
pub fn preload_release_catalog(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() > MAX_GITHUB_RESPONSE_BYTES {
        return Err(AppError::validation(
            "GitHub API response exceeds the 2 MiB limit",
        ));
    }
    let releases: Vec<Rel> = serde_json::from_slice(bytes).map_err(|error| {
        AppError::validation(format!("invalid GitHub release response: {error}"))
    })?;
    cache_latest(&releases);
    Ok(())
}

pub fn clear_api_cache() {
    if let Some(cache) = LATEST_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            *value = None;
        }
    }
    if let Some(cache) = LATEST_ERROR_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            *value = None;
        }
    }
    if let Some(cache) = ASSET_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            value.clear();
        }
    }
    if let Some(cache) = ASSET_ERROR_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            value.clear();
        }
    }
}

pub(super) fn trusted_github_host(host: &str) -> bool {
    host == "api.github.com" || trusted_runtime_host(host)
}

pub(super) fn trusted_runtime_host(host: &str) -> bool {
    host == "github.com"
        || host == "codeload.github.com"
        || host == "objects.githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

pub(super) fn trusted_model_host(host: &str) -> bool {
    host == "huggingface.co" || host.ends_with(".hf.co") || host.ends_with(".huggingface.co")
}

pub(super) fn trusted_download_host(host: &str) -> bool {
    trusted_runtime_host(host) || trusted_model_host(host)
}

fn validate_github_response_url(response: &reqwest::Response) -> Result<(), AppError> {
    let url = response.url();
    if url.scheme() == "https" && url.host_str().is_some_and(trusted_github_host) {
        Ok(())
    } else {
        Err(AppError::validation(
            "GitHub response URL is not on a trusted HTTPS host",
        ))
    }
}

pub(super) fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("aiolm/0.2")
        .timeout(Duration::from_secs(30))
        .redirect(crate::http_policy::https_redirect_policy(
            trusted_github_host,
        ))
        .build()
        .expect("static HTTP client configuration must be valid")
}

/// Runtime archives run from 17 MB to 373 MB, so the 30s whole-request budget
/// used for the GitHub API would abort every large transfer mid-stream. A
/// stalled connection is caught by the per-read timeout instead.
pub(super) fn download_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("aiolm/0.2")
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .redirect(crate::http_policy::https_redirect_policy(
            trusted_download_host,
        ))
        .build()
        .expect("static HTTP client configuration must be valid")
}

fn github_request_error(context: &str, error: reqwest::Error) -> AppError {
    let message = format!("{context}: {error}");
    if error.is_timeout() {
        AppError::timeout(message)
    } else {
        AppError::unavailable(message)
    }
}

async fn bounded_github_bytes(response: reqwest::Response) -> Result<Vec<u8>, AppError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_GITHUB_RESPONSE_BYTES as u64)
    {
        return Err(AppError::validation(
            "GitHub API response exceeds the 2 MiB limit",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| github_request_error("GitHub API response failed", error))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_GITHUB_RESPONSE_BYTES {
            return Err(AppError::validation(
                "GitHub API response exceeds the 2 MiB limit",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn bounded_github_text(response: reqwest::Response) -> Result<String, AppError> {
    let bytes = bounded_github_bytes(response).await?;
    String::from_utf8(bytes).map_err(|error| {
        AppError::validation(format!("GitHub API response was not UTF-8: {error}"))
    })
}

fn parse_pull_request_ref(input: &str) -> Result<PullRequestRef, AppError> {
    let input = input.trim();
    if input.is_empty() || input.len() > MAX_PR_INPUT_BYTES {
        return Err(AppError::validation(
            "enter a llama.cpp pull request number or GitHub URL",
        ));
    }

    let number_text = input.strip_prefix('#').unwrap_or(input);
    let number = if !number_text.is_empty()
        && number_text
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        number_text
            .parse::<u64>()
            .map_err(|_| AppError::validation("pull request number is too large"))?
    } else {
        let parsed = reqwest::Url::parse(input)
            .map_err(|_| AppError::validation("enter a PR number or a GitHub llama.cpp PR URL"))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
            return Err(AppError::validation(
                "PR URL must use https://github.com/ggml-org/llama.cpp/pull/<number>",
            ));
        }
        let segments: Vec<&str> = parsed
            .path_segments()
            .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
            .unwrap_or_default();
        if segments.len() < 4
            || segments[0] != "ggml-org"
            || segments[1] != "llama.cpp"
            || segments[2] != "pull"
        {
            return Err(AppError::validation(
                "PR URL must point to ggml-org/llama.cpp",
            ));
        }
        segments[3].parse::<u64>().map_err(|_| {
            AppError::validation("the GitHub URL does not contain a valid pull request number")
        })?
    };

    if number == 0 || format!("pr{number}").len() > 20 {
        return Err(AppError::validation(
            "pull request number is outside the supported range",
        ));
    }
    Ok(PullRequestRef { number })
}

pub fn pull_request_build_id(input: &str) -> Result<String, AppError> {
    let request = parse_pull_request_ref(input)?;
    Ok(format!("pr{}", request.number))
}

pub(super) fn validate_source_repository(repository: &str) -> Result<(&str, &str), AppError> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || owner == "."
        || owner == ".."
        || name == "."
        || name == ".."
        || parts.next().is_some()
        || !owner
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err(AppError::validation(format!(
            "pull request head repository is invalid: {repository}"
        )));
    }
    Ok((owner, name))
}

pub(super) fn validate_commit_sha(commit: &str) -> Result<(), AppError> {
    if commit.len() != 40
        || !commit
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(AppError::validation(
            "GitHub returned an invalid pull request commit",
        ));
    }
    Ok(())
}

/// Public pull request metadata fetched by a live acceptance job, keyed by
/// number. Only the GitHub lookup is replaced; validation is unchanged.
#[cfg(feature = "test-fixtures")]
static PRELOADED_PULL_REQUESTS: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();

/// Prime live source-build acceptance with a pull request document fetched by
/// the CI job, whose short-lived token stays outside the app. The source
/// archive, its commit check, the build and staged preflight use the normal path.
#[cfg(feature = "test-fixtures")]
pub fn preload_pull_request(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() > MAX_GITHUB_RESPONSE_BYTES {
        return Err(AppError::validation(
            "GitHub API response exceeds the 2 MiB limit",
        ));
    }
    let raw = String::from_utf8(bytes.to_vec()).map_err(|error| {
        AppError::validation(format!("invalid GitHub pull request response: {error}"))
    })?;
    let detail: PullRequestDetail = serde_json::from_str(&raw).map_err(|error| {
        AppError::validation(format!("invalid GitHub pull request response: {error}"))
    })?;
    PRELOADED_PULL_REQUESTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| AppError::internal("pull request preload lock was poisoned"))?
        .insert(detail.number, raw);
    Ok(())
}

pub(super) async fn resolve_pull_request(input: &str) -> Result<ResolvedPullRequest, AppError> {
    let request = parse_pull_request_ref(input)?;
    #[cfg(feature = "test-fixtures")]
    if let Some(raw) = PRELOADED_PULL_REQUESTS
        .get()
        .and_then(|preloaded| preloaded.lock().ok()?.get(&request.number).cloned())
    {
        let detail: PullRequestDetail = serde_json::from_str(&raw).map_err(|error| {
            AppError::validation(format!("invalid GitHub pull request response: {error}"))
        })?;
        return parse_pull_request_source(request.number, detail);
    }
    let response = http()
        .get(format!(
            "https://api.github.com/repos/{LLAMA_REPOSITORY}/pulls/{}",
            request.number
        ))
        .send()
        .await
        .map_err(|error| github_request_error("GitHub pull request lookup failed", error))?;
    validate_github_response_url(&response)?;
    let status = response.status();
    let raw = bounded_github_text(response).await?;
    if !status.is_success() {
        return Err(pull_request_lookup_error(request.number, status, &raw));
    }
    let detail: PullRequestDetail = serde_json::from_str(&raw).map_err(|error| {
        AppError::validation(format!("invalid GitHub pull request response: {error}"))
    })?;
    parse_pull_request_source(request.number, detail)
}

/// Say what actually went wrong looking a pull request up.
///
/// `GitHub API 404: Not Found` tells a user nothing they can act on. Each of
/// these is a different situation with a different fix, and they are the three
/// that a person typing a PR number actually hits.
pub(super) fn pull_request_lookup_error(
    number: u64,
    status: reqwest::StatusCode,
    body: &str,
) -> AppError {
    let detail = api_error(status, body);
    let message = match status.as_u16() {
        404 => format!(
            "pull request #{number} was not found in {LLAMA_REPOSITORY}. Check the number, and note that aiolm only builds pull requests from that repository - an issue number, or a PR in a fork's own repository, will not resolve. ({detail})"
        ),
        403 | 429 => {
            if body.to_ascii_lowercase().contains("rate limit") {
                format!(
                    "GitHub is rate-limiting this machine, so pull request #{number} could not be looked up. Unauthenticated requests are limited per IP; wait for the limit to reset and try again. ({detail})"
                )
            } else {
                format!(
                    "GitHub refused the lookup for pull request #{number}. This is usually a network appliance or proxy blocking api.github.com. ({detail})"
                )
            }
        }
        451 => format!(
            "pull request #{number} is not available for legal reasons. ({detail})"
        ),
        500..=599 => format!(
            "GitHub had a server error looking up pull request #{number}; this is not something aiolm can fix, so try again shortly. ({detail})"
        ),
        _ => return detail,
    };
    AppError::new(detail.kind, message)
}

/// A resolved pull request: the provenance that is recorded into the runtime,
/// plus the display-only fields that only the confirmation dialog needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ResolvedPullRequest {
    pub(super) source: RuntimeSource,
    pub(super) title: String,
    pub(super) draft: bool,
    updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PullRequestArtifact {
    pub(super) name: String,
    pub(super) url: String,
    pub(super) sha256: String,
    pub(super) bytes: u64,
}

fn pull_request_artifact_name(pull_request: u64, backend: &str) -> String {
    format!(
        "aiolm-pr{pull_request}-{backend}-{}-{}.zip",
        release_platform(),
        bundle_architecture()
    )
}

fn pull_request_artifact_tag(pull_request: u64) -> String {
    format!("pr-runtime-{pull_request}")
}

/// Look up the exact prebuilt artifact for this app's platform and
/// architecture. A missing or temporarily unavailable artifact is not a
/// security failure: the caller can still offer the local source-build path.
pub(super) async fn find_pull_request_artifact(
    source: &RuntimeSource,
    backend: &str,
) -> Result<Option<PullRequestArtifact>, AppError> {
    validate_source_build_backend(backend)?;
    let build = format!("pr{}", source.pull_request);
    validate_runtime_identifiers(backend, &build)?;
    validate_commit_sha(&source.commit)?;
    let tag = pull_request_artifact_tag(source.pull_request);
    let response = http()
        .get(format!(
            "https://api.github.com/repos/{PR_ARTIFACT_REPOSITORY}/releases/tags/{tag}"
        ))
        .send()
        .await
        .map_err(|error| github_request_error("prebuilt PR artifact lookup failed", error))?;
    validate_github_response_url(&response)?;
    let status = response.status();
    let raw = bounded_github_text(response).await?;
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        let error = api_error(status, &raw);
        return Err(AppError::new(
            error.kind,
            format!(
                "prebuilt PR artifact lookup returned HTTP {}: {}",
                status, error
            ),
        ));
    }
    let release: ReleaseDetail = serde_json::from_str(&raw).map_err(|error| {
        AppError::validation(format!("invalid prebuilt PR artifact response: {error}"))
    })?;
    if release.tag_name != tag {
        return Err(AppError::validation(
            "prebuilt PR artifact release tag did not match the request",
        ));
    }
    let expected_name = pull_request_artifact_name(source.pull_request, backend);
    let legacy_name = expected_name.replacen("aiolm-", "llama-board-", 1);
    let mut assets = release.assets;
    let selected = assets
        .iter()
        .position(|asset| asset.name == expected_name)
        .or_else(|| assets.iter().position(|asset| asset.name == legacy_name));
    let Some(asset) = selected.map(|index| assets.swap_remove(index)) else {
        return Ok(None);
    };
    validate_asset_file_name(&asset.name)?;
    validate_download_url(&asset.browser_download_url)?;
    let digest = normalize_digest(asset.digest.as_deref().ok_or_else(|| {
        AppError::validation(
            "prebuilt PR artifact has no SHA-256 digest; refusing an unverified artifact",
        )
    })?)?;
    if asset.size > MAX_ARCHIVE_BYTES {
        return Err(AppError::validation(
            "prebuilt PR artifact exceeds the configured archive size limit",
        ));
    }
    Ok(Some(PullRequestArtifact {
        name: asset.name,
        url: asset.browser_download_url,
        sha256: digest,
        bytes: asset.size,
    }))
}

/// Turn a GitHub pull request response into provenance, refusing anything that
/// does not identify a single concrete tree.
pub(super) fn parse_pull_request_source(
    requested: u64,
    detail: PullRequestDetail,
) -> Result<ResolvedPullRequest, AppError> {
    if detail.number != requested {
        return Err(AppError::validation(
            "GitHub returned a different pull request number",
        ));
    }
    let repository = detail
        .head
        .repo
        .ok_or_else(|| {
            AppError::not_found("the pull request head repository is no longer available, so its source cannot be downloaded")
        })?
        .full_name;
    validate_source_repository(&repository)?;
    let commit = detail.head.sha.trim().to_ascii_lowercase();
    validate_commit_sha(&commit)?;
    // A merged PR reports state "closed"; the distinction matters to someone
    // deciding whether to run this code, so surface it separately.
    let state = if detail.merged_at.is_some() {
        "merged".to_string()
    } else if detail.state.is_empty() {
        "unknown".to_string()
    } else {
        detail.state.clone()
    };
    Ok(ResolvedPullRequest {
        source: RuntimeSource {
            pull_request: requested,
            fork: !repository.eq_ignore_ascii_case(LLAMA_REPOSITORY),
            repository,
            head_ref: detail.head.reference.clone(),
            author: detail
                .user
                .as_ref()
                .map(|user| user.login.clone())
                .unwrap_or_default(),
            state,
            commit,
            archive_sha256: String::new(),
            commit_check: String::new(),
            url: format!("https://github.com/{LLAMA_REPOSITORY}/pull/{requested}"),
        },
        title: detail.title,
        draft: detail.draft,
        updated_at: detail.updated_at,
    })
}

/// Resolve a pull request for display only. Nothing is downloaded or built:
/// this is what the confirmation dialog shows before the user agrees to
/// compile someone else's branch on their own machine.
pub async fn pull_request_preview(
    backend: &str,
    source: &str,
) -> Result<PullRequestPreview, AppError> {
    validate_source_build_backend(backend)?;
    let resolved = resolve_pull_request(source).await?;
    let archive_url = source_archive_url(&resolved.source)?;
    let (artifact, artifact_error) =
        match find_pull_request_artifact(&resolved.source, backend).await {
            Ok(artifact) => (
                artifact.map(|artifact| PullRequestArtifactPreview {
                    name: artifact.name,
                    sha256: artifact.sha256,
                    bytes: artifact.bytes,
                }),
                None,
            ),
            // Artifact lookup is advisory here; the confirmation preview
            // displays its text rather than failing the PR lookup.
            Err(error) => (None, Some(error.message)),
        };
    Ok(preview_of(resolved, archive_url, artifact, artifact_error))
}

fn preview_of(
    resolved: ResolvedPullRequest,
    archive_url: String,
    artifact: Option<PullRequestArtifactPreview>,
    artifact_error: Option<String>,
) -> PullRequestPreview {
    let advisories = pull_request_advisories(&resolved);
    let ResolvedPullRequest {
        source,
        title,
        draft,
        updated_at,
    } = resolved;
    PullRequestPreview {
        pull_request: source.pull_request,
        title,
        state: source.state,
        draft,
        author: source.author,
        repository: source.repository,
        head_ref: source.head_ref,
        commit: source.commit,
        fork: source.fork,
        url: source.url,
        archive_url,
        updated_at,
        advisories,
        artifact,
        artifact_error,
    }
}

pub(super) fn source_archive_url(source: &RuntimeSource) -> Result<String, AppError> {
    let (owner, repository) = validate_source_repository(&source.repository)?;
    validate_commit_sha(&source.commit)?;
    Ok(format!(
        "https://codeload.github.com/{owner}/{repository}/zip/{}",
        source.commit
    ))
}

pub(super) fn is_build_tag(tag: &str) -> bool {
    tag.starts_with('b')
        && tag.len() > 1
        && tag.len() <= 16
        && tag[1..].chars().all(|value| value.is_ascii_digit())
}

/// Upstream uses Ubuntu tarballs on Linux and one combined CPU/Metal archive
/// on Apple Silicon. Intel macOS archives explicitly disable Metal.
pub fn catalog_supports(backend: &str, os: &str, arch: &str) -> bool {
    match (os, arch) {
        ("windows", "x86_64") | ("linux", "x86_64") => {
            CATALOG_BACKENDS.contains(&backend) && backend != "metal"
        }
        ("windows", "aarch64") => matches!(backend, "cpu" | "cuda"),
        ("linux", "aarch64") => matches!(backend, "cpu" | "vulkan" | "cuda"),
        ("macos", "aarch64") => matches!(backend, "cpu" | "metal"),
        ("macos", "x86_64") => backend == "cpu",
        _ => false,
    }
}

pub(super) fn backend_asset_for<'a>(
    release: &'a Rel,
    backend: &str,
    os: &str,
    arch: &str,
) -> Option<&'a Asset> {
    if !catalog_supports(backend, os, arch) {
        return None;
    }
    let architecture = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    let platform = match os {
        "windows" => "win",
        "linux" => "ubuntu",
        "macos" => "macos",
        _ => return None,
    };
    let base = format!("llama-{}-bin-{platform}", release.tag_name);
    let extension = if os == "windows" { "zip" } else { "tar.gz" };
    let suffix = format!("-{architecture}.{extension}");
    let prefix = if os == "macos" || (os == "linux" && backend == "cpu") {
        base
    } else {
        format!("{base}-{backend}")
    };
    // Match exact unversioned assets first. Versioned backend suffixes must
    // start at a hyphen boundary, never a similarly named unrelated backend.
    release
        .assets
        .iter()
        .find(|asset| asset.name == format!("{prefix}{suffix}"))
        .or_else(|| {
            if os == "macos" || backend == "cpu" {
                return None;
            }
            release.assets.iter().find(|asset| {
                asset.name.starts_with(&format!("{prefix}-")) && asset.name.ends_with(&suffix)
            })
        })
}

/// The newest release that actually published this backend's archive.
///
/// A release tag appears as soon as the build starts, so the newest one
/// routinely has no assets yet, or only the few its matrix has finished: on the
/// day this was written b11030 had 2 assets and neither was ROCm, while b11028
/// and b11027 had none at all and b11029 had all 33. Treating the newest tag as
/// the newest download therefore fails for whichever backend happens to be
/// mid-upload, so walk back to the newest release that has the archive.
fn newest_with_asset<'a>(releases: &'a [Rel], backend: &str) -> Option<(&'a Rel, &'a Asset)> {
    newest_with_asset_for(
        releases,
        backend,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

pub(super) fn newest_with_asset_for<'a>(
    releases: &'a [Rel],
    backend: &str,
    os: &str,
    arch: &str,
) -> Option<(&'a Rel, &'a Asset)> {
    releases
        .iter()
        .filter(|release| is_build_tag(&release.tag_name))
        .find_map(|release| {
            backend_asset_for(release, backend, os, arch).map(|asset| (release, asset))
        })
}

/// Recent llama.cpp releases with their published assets, cached briefly.
async fn recent_releases() -> Result<Vec<Rel>, AppError> {
    if let Some(releases) = cached_latest() {
        return Ok(releases);
    }
    if let Some(error) = cached_latest_error() {
        return Err(error);
    }
    let request_lock = LATEST_REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _request = request_lock.lock().await;
    if let Some(releases) = cached_latest() {
        return Ok(releases);
    }
    if let Some(error) = cached_latest_error() {
        return Err(error);
    }
    // Each release carries its whole asset list, so keep the page small enough
    // that the response stays well inside the bounded reader's limit while
    // still spanning several completed builds.
    let response = http()
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10")
        .send()
        .await
        .map_err(|error| {
            let message = github_request_error("GitHub release lookup failed", error);
            cache_latest_error(&message);
            message
        })?;
    validate_github_response_url(&response).inspect_err(|error| {
        cache_latest_error(error);
    })?;
    let status = response.status();
    let raw = bounded_github_text(response).await.inspect_err(|error| {
        cache_latest_error(error);
    })?;
    if !status.is_success() {
        let error = api_error(status, &raw);
        cache_latest_error(&error);
        return Err(error);
    }
    let releases: Vec<Rel> = serde_json::from_str(&raw).map_err(|error| {
        let message = AppError::validation(format!("invalid GitHub release response: {error}"));
        cache_latest_error(&message);
        message
    })?;
    cache_latest(&releases);
    Ok(releases)
}

/// Newest real build tag (skips release tags that are not b##### builds).
pub async fn latest_build() -> Result<String, AppError> {
    recent_releases()
        .await?
        .into_iter()
        .find(|release| is_build_tag(&release.tag_name))
        .map(|release| release.tag_name)
        .ok_or_else(|| AppError::not_found("no b##### llama.cpp release found"))
}

#[derive(Deserialize, Clone, Debug)]
struct ReleaseDetail {
    #[serde(default)]
    tag_name: String,
    assets: Vec<Asset>,
}

type ReleaseCache = Mutex<Option<(Instant, Vec<Rel>)>>;

static LATEST_CACHE: OnceLock<ReleaseCache> = OnceLock::new();

static LATEST_ERROR_CACHE: OnceLock<Mutex<Option<(Instant, AppError)>>> = OnceLock::new();

static ASSET_CACHE: OnceLock<Mutex<AssetCache>> = OnceLock::new();

static ASSET_ERROR_CACHE: OnceLock<Mutex<ErrorCache>> = OnceLock::new();

static LATEST_REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

static ASSET_REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

pub(super) fn api_error(status: reqwest::StatusCode, body: &str) -> AppError {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|message| message.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.lines().next().unwrap_or("request failed").to_owned());
    let message = format!("GitHub API {status}: {message}");
    match status.as_u16() {
        404 | 410 => AppError::not_found(message),
        401 | 403 | 451 => AppError::unavailable(message),
        408 | 504 => AppError::timeout(message),
        429 | 500..=599 => AppError::unavailable(message),
        400 | 405 | 406 | 409 | 411..=417 | 422 => AppError::validation(message),
        _ => AppError::internal(message),
    }
}

fn cached_latest() -> Option<Vec<Rel>> {
    LATEST_CACHE
        .get()?
        .lock()
        .ok()?
        .as_ref()
        .and_then(|(at, releases)| (at.elapsed() < API_CACHE_TTL).then(|| releases.clone()))
}

fn cached_latest_error() -> Option<AppError> {
    LATEST_ERROR_CACHE
        .get()?
        .lock()
        .ok()?
        .as_ref()
        .and_then(|(at, error)| (at.elapsed() < API_CACHE_TTL).then(|| error.clone()))
}

fn cache_latest_error(error: &AppError) {
    let cache = LATEST_ERROR_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = cache.lock() {
        *value = Some((Instant::now(), error.to_owned()));
    }
}

fn cache_latest(releases: &[Rel]) {
    let cache = LATEST_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = cache.lock() {
        *value = Some((Instant::now(), releases.to_vec()));
    }
}

fn cached_assets(build: &str) -> Option<Vec<Asset>> {
    let cache = ASSET_CACHE.get()?.lock().ok()?;
    cache
        .get(build)
        .and_then(|(at, assets)| (at.elapsed() < API_CACHE_TTL).then(|| assets.clone()))
}

fn cached_asset_error(build: &str) -> Option<AppError> {
    let cache = ASSET_ERROR_CACHE.get()?.lock().ok()?;
    cache
        .get(build)
        .and_then(|(at, error)| (at.elapsed() < API_CACHE_TTL).then(|| error.clone()))
}

fn prune_asset_cache<T>(cache: &mut HashMap<String, (Instant, T)>) {
    cache.retain(|_, (at, _)| at.elapsed() < API_CACHE_TTL);
    while cache.len() > MAX_ASSET_CACHE_ENTRIES {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        cache.remove(&oldest);
    }
}

fn cache_asset_error(build: &str, error: &AppError) {
    let cache = ASSET_ERROR_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut value) = cache.lock() {
        value.insert(build.to_owned(), (Instant::now(), error.to_owned()));
        prune_asset_cache(&mut value);
    }
}

fn cache_assets(build: &str, assets: &[Asset]) {
    let cache = ASSET_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut value) = cache.lock() {
        value.insert(build.to_owned(), (Instant::now(), assets.to_owned()));
        prune_asset_cache(&mut value);
    }
}

pub(super) fn parse_release_assets(body: &str) -> Result<Vec<Asset>, AppError> {
    serde_json::from_str::<ReleaseDetail>(body)
        .map(|release| release.assets)
        .map_err(|error| AppError::validation(error.to_string()))
}

pub(super) fn release_platform() -> &'static str {
    if cfg!(windows) {
        "win"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Fetch the release's assets; selection validates the host OS and architecture.
async fn assets_for_build(build: &str) -> Result<Vec<Asset>, AppError> {
    if let Some(error) = cached_asset_error(build) {
        return Err(error);
    }
    if let Some(assets) = cached_assets(build) {
        return Ok(assets);
    }
    let request_lock = ASSET_REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _request = request_lock.lock().await;
    if let Some(assets) = cached_assets(build) {
        return Ok(assets);
    }
    if let Some(error) = cached_asset_error(build) {
        return Err(error);
    }
    let response = http()
        .get(format!(
            "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{build}"
        ))
        .send()
        .await
        .map_err(|error| {
            let message = github_request_error("GitHub asset lookup failed", error);
            cache_asset_error(build, &message);
            message
        })?;
    validate_github_response_url(&response).inspect_err(|error| {
        cache_asset_error(build, error);
    })?;
    let status = response.status();
    let raw = bounded_github_text(response).await.inspect_err(|error| {
        cache_asset_error(build, error);
    })?;
    if !status.is_success() {
        let error = api_error(status, &raw);
        cache_asset_error(build, &error);
        return Err(error);
    }
    let assets = match parse_release_assets(&raw) {
        Ok(assets) => assets,
        Err(error) => {
            cache_asset_error(build, &error);
            return Err(error);
        }
    };
    cache_assets(build, &assets);
    Ok(assets)
}

/// llama.cpp ships the CUDA runtime DLLs (cudart/cublas) in a separate
/// `cudart-llama-bin-...` asset. Without them the staged `llama-server.exe`
/// cannot start on a machine that has no CUDA Toolkit on PATH, so the install
/// has to fetch that sidecar alongside the backend archive.
pub fn companion_asset_name(build: &str, main_file_name: &str) -> Option<String> {
    let suffix = main_file_name.strip_prefix(&format!("llama-{build}-bin-"))?;
    if !suffix.contains("-cuda-") {
        return None;
    }
    if suffix.starts_with("ubuntu-") {
        Some(format!("cudart-llama-{build}-bin-{suffix}"))
    } else {
        Some(format!("cudart-llama-bin-{suffix}"))
    }
}

pub(super) async fn companion_assets(
    build: &str,
    main_file_name: &str,
) -> Result<Vec<Asset>, AppError> {
    let Some(name) = companion_asset_name(build, main_file_name) else {
        return Ok(Vec::new());
    };
    let asset = assets_for_build(build)
        .await?
        .into_iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| {
            AppError::not_found(format!(
                "release {build} is missing the CUDA runtime asset {name}"
            ))
        })?;
    Ok(vec![asset])
}

pub async fn latest_for(backend: &str) -> Result<LatestInfo, AppError> {
    if !CATALOG_BACKENDS.contains(&backend) {
        return Err(AppError::validation(format!(
            "no downloadable catalog asset is defined for backend: {backend}"
        )));
    }
    if !catalog_supports(backend, std::env::consts::OS, std::env::consts::ARCH) {
        return Err(AppError::unavailable(format!(
            "no downloadable {backend} runtime is provided for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )));
    }
    let releases = recent_releases().await?;
    let (release, asset) = newest_with_asset(&releases, backend).ok_or_else(|| {
        let newest = releases
            .iter()
            .find(|release| is_build_tag(&release.tag_name))
            .map(|release| release.tag_name.as_str())
            .unwrap_or("none");
        AppError::not_found(format!(
            "no {backend} {} {} build has been published in the {} most recent llama.cpp releases (newest is {newest}); a release appears before its archives finish uploading, so try again shortly",
            std::env::consts::OS, std::env::consts::ARCH, releases.len()
        ))
    })?;
    Ok(LatestInfo {
        build: release.tag_name.clone(),
        file_name: asset.name.clone(),
        url: asset.browser_download_url.clone(),
        digest: asset.digest.clone(),
    })
}
