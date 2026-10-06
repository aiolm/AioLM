// Hugging Face Discover/search/download support.
mod snapshots;
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub use snapshots::{download_snapshot, installed_snapshots};
pub(crate) use snapshots::{read_snapshot_manifest, snapshot_path};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncWriteExt, BufWriter};
use uuid::Uuid;

const HF_API: &str = "https://huggingface.co/api";
const MAX_QUERY_LENGTH: usize = 200;
const MAX_API_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 50_000;
const MAX_MODEL_BYTES: u64 = 512 * 1024 * 1024 * 1024;
const DOWNLOAD_BUFFER_BYTES: usize = 1024 * 1024;
const DOWNLOAD_UPDATE_INTERVAL: Duration = Duration::from_millis(100);
const DOWNLOAD_CANCELLED: &str = "model download cancelled";

/// Sort orders the Hugging Face model API accepts. The API answers HTTP 400
/// for anything else, so the set is closed here rather than forwarded blindly.
pub const SORT_KEYS: [&str; 4] = ["downloads", "likes", "lastModified", "trendingScore"];
pub const DEFAULT_SORT: &str = "downloads";

/// Properties the listing has to ask for by name. `expand` replaces the
/// default field set rather than adding to it, so every field `HfModel`
/// carries is listed here — and `gated`, which the default set omits
/// entirely, is finally reported instead of silently reading as "not gated".
const EXPAND_FIELDS: [&str; 7] = [
    "author",
    "gated",
    "downloads",
    "likes",
    "lastModified",
    "pipeline_tag",
    "tags",
];

#[derive(Serialize, Clone, Debug)]
pub struct HfModel {
    pub id: String,
    pub author: String,
    pub downloads: u64,
    pub likes: u64,
    pub last_modified: String,
    pub pipeline_tag: Option<String>,
    pub tags: Vec<String>,
    pub gated: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct HfFile {
    pub path: String,
    pub size_bytes: u64,
    pub oid: Option<String>,
    pub is_mmproj: bool,
    pub download_url: String,
    pub companions_available: bool,
}

/// A repository file that is already present at its download destination.
#[derive(Serialize, Clone, Debug)]
pub struct InstalledHfFile {
    /// Repository-relative path, matching `HfFile::path`.
    pub path: String,
    /// Where the file sits under the configured models directory.
    pub local_path: String,
    pub size_bytes: u64,
    /// Parts of this file's multi-part GGUF that are still absent. Empty for a
    /// single-file model and for a complete set, so a caller can tell "this
    /// file is here" from "this model is ready to run".
    pub missing_shards: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DownloadedModel {
    pub repo_id: String,
    pub file_path: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Deserialize, Debug)]
struct ApiModel {
    id: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "pipeline_tag")]
    pipeline_tag: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_gated")]
    gated: bool,
}

/// The Hub reports access control as `false` or as the string naming how
/// approval works (`"auto"`, `"manual"`). Reading it as a plain bool made a
/// single gated repository fail the whole listing, so both spellings are
/// accepted and anything other than "not gated" counts as gated.
fn deserialize_gated<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Bool(value) => value,
        serde_json::Value::String(value) => !matches!(
            value.to_ascii_lowercase().as_str(),
            "false" | "none" | "no" | ""
        ),
        _ => false,
    })
}

#[derive(Deserialize, Debug)]
struct ApiLfs {
    #[serde(default)]
    oid: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ApiTreeEntry {
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    oid: Option<String>,
    #[serde(default)]
    lfs: Option<ApiLfs>,
    #[serde(rename = "type")]
    entry_type: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("aiolm/0.1")
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Hugging Face client setup failed: {error}"))
}

/// `reqwest`'s `timeout` covers the response body too, so the API client's 45s
/// budget would abort every multi-gigabyte model transfer mid-stream. Downloads
/// get no overall deadline and rely on the per-read timeout to catch a stall.
fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("aiolm/0.1")
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Hugging Face client setup failed: {error}"))
}

fn trusted_hf_host(host: &str) -> bool {
    host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host == "hf.co"
        || host.ends_with(".hf.co")
}

fn validate_response_url(response: &reqwest::Response) -> Result<(), String> {
    if response.url().scheme() != "https" {
        return Err("Hugging Face response must use HTTPS".into());
    }
    let host = response.url().host_str().unwrap_or_default();
    if trusted_hf_host(host) {
        Ok(())
    } else {
        Err(format!(
            "Hugging Face redirected to an untrusted host: {host}"
        ))
    }
}

async fn bounded_response_bytes(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!(
            "Hugging Face response exceeds the {limit} byte limit"
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Hugging Face response could not be read: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!(
                "Hugging Face response exceeds the {limit} byte limit"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn decode_json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    let bytes = bounded_response_bytes(response, MAX_API_RESPONSE_BYTES).await?;
    let body = String::from_utf8(bytes)
        .map_err(|error| format!("Hugging Face response was not UTF-8: {error}"))?;
    if !status.is_success() {
        let detail = body.lines().next().unwrap_or("request failed");
        return Err(format!(
            "Hugging Face API {status}: {}",
            detail.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str(&body)
        .map_err(|error| format!("Hugging Face response was invalid JSON: {error}"))
}

pub fn validate_repo_id(repo_id: &str) -> Result<(), String> {
    let value = repo_id.trim();
    let parts: Vec<&str> = value.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 128
                || !part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
                || part.starts_with('.')
        })
    {
        return Err("Hugging Face repo must use the form author/model with safe names".into());
    }
    Ok(())
}

pub fn validate_repo_path(file_path: &str) -> Result<(), String> {
    let value = file_path.trim();
    if value.is_empty() || value.starts_with('/') || value.contains('\\') {
        return Err("model file path is not a safe relative path".into());
    }
    for part in value.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > 255
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(|character| {
                character.is_control() || ['<', '>', ':', '"', '|', '?', '*'].contains(&character)
            })
        {
            return Err("model file path contains an unsafe component".into());
        }
    }
    if !value.to_ascii_lowercase().ends_with(".gguf") {
        return Err("Discover only downloads GGUF files".into());
    }
    Ok(())
}

fn is_mmproj(file_path: &str) -> bool {
    file_path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .starts_with("mmproj")
}

fn download_url_at(repo_id: &str, file_path: &str, revision: &str) -> String {
    let mut url = reqwest::Url::parse("https://huggingface.co").expect("static hub URL");
    url.path_segments_mut()
        .expect("hub URL supports path segments")
        .extend(repo_id.split('/'))
        .extend(["resolve", revision])
        .extend(file_path.split('/'));
    url.query_pairs_mut().append_pair("download", "true");
    url.into()
}

fn repo_directory(repo_id: &str) -> PathBuf {
    repo_id.split('/').fold(PathBuf::new(), |mut path, part| {
        path.push(part);
        path
    })
}

fn relative_path(file_path: &str) -> PathBuf {
    file_path.split('/').fold(PathBuf::new(), |mut path, part| {
        path.push(part);
        path
    })
}

fn models_root(models_dir: &str) -> Result<PathBuf, String> {
    let input = models_dir.trim();
    if input.is_empty() {
        return Err("models directory is empty".into());
    }
    fs::create_dir_all(input)
        .map_err(|error| format!("cannot create models directory: {error}"))?;
    let root = Path::new(input)
        .canonicalize()
        .map_err(|error| format!("cannot open models directory: {error}"))?;
    if !root.is_dir() {
        return Err("models path is not a directory".into());
    }
    Ok(root)
}

fn target_path(models_dir: &str, repo_id: &str, file_path: &str) -> Result<PathBuf, String> {
    validate_repo_id(repo_id)?;
    validate_repo_path(file_path)?;
    let root = models_root(models_dir)?;
    let target = root
        .join("hf")
        .join(repo_directory(repo_id))
        .join(relative_path(file_path));
    let parent = target
        .parent()
        .ok_or_else(|| "download destination has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create download directory: {error}"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("cannot resolve download directory: {error}"))?;
    if !canonical_parent.starts_with(&root) {
        return Err("download destination escapes the models directory".into());
    }
    Ok(canonical_parent.join(
        target
            .file_name()
            .ok_or_else(|| "download filename is empty".to_string())?,
    ))
}

fn temporary_download_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "download destination has no parent".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "download filename is invalid".to_string())?;
    Ok(parent.join(format!(".{name}.{}.part", Uuid::new_v4().simple())))
}

fn same_path_identity(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &Path| {
            let value = path.to_string_lossy();
            let value = value.strip_prefix(r"\\?\").unwrap_or(value.as_ref());
            value.to_ascii_lowercase()
        };
        normalize(left) == normalize(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

async fn ensure_download_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "download destination has no parent".to_string())?;
    let metadata = tokio::fs::symlink_metadata(parent)
        .await
        .map_err(|error| format!("cannot inspect download directory: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("download directory must be a real directory".into());
    }
    let resolved = tokio::fs::canonicalize(parent)
        .await
        .map_err(|error| format!("cannot resolve download directory: {error}"))?;
    if !same_path_identity(&resolved, parent) {
        return Err("download directory must not be a reparse point".into());
    }
    Ok(())
}

async fn create_staging_file(path: &Path) -> Result<tokio::fs::File, String> {
    ensure_download_parent(path).await?;
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => return Err("download staging path already exists".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("cannot inspect download staging path: {error}")),
    }
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| format!("cannot stage model download: {error}"))
}

async fn activate_download(part: &Path, target: &Path) -> Result<(), String> {
    ensure_download_parent(target).await?;
    match tokio::fs::symlink_metadata(target).await {
        Ok(_) => return Err("a different model appeared at the download destination".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot inspect model destination before activation: {error}"
            ));
        }
    }
    tokio::fs::hard_link(part, target)
        .await
        .map_err(|error| format!("cannot activate downloaded model without overwrite: {error}"))?;
    tokio::fs::remove_file(part)
        .await
        .map_err(|error| format!("cannot clean up staged model download: {error}"))
}

/// List GGUF or safetensors repositories in the requested order.
///
/// An empty query is not an error: Discover opens on the catalog itself, and
/// the `search` parameter is then left off so the API returns its ranked list
/// rather than the result of matching an empty term.
pub async fn search_format(
    query: &str,
    limit: u32,
    sort: &str,
    format: &str,
) -> Result<Vec<HfModel>, String> {
    if !["gguf", "safetensors", "mlx"].contains(&format) {
        return Err("unsupported model format".into());
    }
    let query = query.trim();
    if query.len() > MAX_QUERY_LENGTH || query.chars().any(char::is_control) {
        return Err("model search query is invalid or too long".into());
    }
    if !SORT_KEYS.contains(&sort) {
        return Err("model sort order is not supported".into());
    }
    let limit = limit.clamp(1, 50).to_string();
    let mut params = vec![
        (
            "filter",
            if format == "mlx" {
                "safetensors"
            } else {
                format
            },
        ),
        ("sort", sort),
        ("direction", "-1"),
        ("limit", limit.as_str()),
    ];
    if format == "mlx" {
        params.push(("filter", "mlx"));
    }
    for field in EXPAND_FIELDS {
        params.push(("expand[]", field));
    }
    if !query.is_empty() {
        params.push(("search", query));
    }
    let response = client()?
        .get(format!("{HF_API}/models"))
        .query(&params)
        .send()
        .await
        .map_err(|error| format!("Hugging Face model search failed: {error}"))?;
    validate_response_url(&response)?;
    let items: Vec<ApiModel> = decode_json(response).await?;
    Ok(items
        .into_iter()
        .map(|item| HfModel {
            id: item.id,
            author: item.author,
            downloads: item.downloads,
            likes: item.likes,
            last_modified: item.last_modified.unwrap_or_default(),
            pipeline_tag: item.pipeline_tag,
            tags: item.tags,
            gated: item.gated,
        })
        .collect())
}

pub async fn files(repo_id: &str) -> Result<Vec<HfFile>, String> {
    files_at(repo_id, "main", &AtomicBool::new(false)).await
}

async fn immutable_revision(repo: &str, cancel: &AtomicBool) -> Result<String, String> {
    let response = tokio::select! {
        _ = snapshots::wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
        response = client()?.get(format!("{HF_API}/models/{repo}/revision/main")).send() => response.map_err(|error| error.to_string())?
    };
    validate_response_url(&response)?;
    let metadata: serde_json::Value = tokio::select! {
        _ = snapshots::wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
        metadata = decode_json(response) => metadata?
    };
    let revision = metadata
        .get("sha")
        .and_then(serde_json::Value::as_str)
        .ok_or("repository did not return an immutable revision")?;
    if revision.len() != 40 || !revision.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("invalid repository revision".into());
    }
    Ok(revision.into())
}

fn tree_next_page(
    headers: &reqwest::header::HeaderMap,
    repo: &str,
    revision: &str,
) -> Result<Option<String>, String> {
    let next = headers
        .get("link")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').find(|link| link.contains("rel=\"next\"")))
        .and_then(|link| link.trim().strip_prefix('<')?.split('>').next())
        .map(str::to_owned);
    if let Some(url) = &next {
        let parsed = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("huggingface.co")
            || parsed.path() != format!("/api/models/{repo}/tree/{revision}")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("unsafe repository pagination link".into());
        }
    }
    Ok(next)
}

async fn repository_tree(
    repo: &str,
    revision: &str,
    cancel: &AtomicBool,
) -> Result<Vec<ApiTreeEntry>, String> {
    let mut entries = Vec::new();
    let mut next = Some(format!(
        "{HF_API}/models/{repo}/tree/{revision}?recursive=true&expand=false"
    ));
    let mut visited = std::collections::HashSet::new();
    while let Some(url) = next.take() {
        if !visited.insert(url.clone()) || visited.len() > 100 {
            return Err("repository pagination exceeded its limit".into());
        }
        let response = tokio::select! {
            _ = snapshots::wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
            response = client()?.get(&url).send() => response.map_err(|error| error.to_string())?
        };
        validate_response_url(&response)?;
        next = tree_next_page(response.headers(), repo, revision)?;
        let page: Vec<ApiTreeEntry> = tokio::select! {
            _ = snapshots::wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
            page = decode_json(response) => page?
        };
        entries.extend(page);
        if entries.len() > MAX_TREE_ENTRIES {
            return Err("repository contains too many files".into());
        }
    }
    Ok(entries)
}

async fn files_at(
    repo_id: &str,
    revision: &str,
    cancel: &AtomicBool,
) -> Result<Vec<HfFile>, String> {
    validate_repo_id(repo_id)?;
    let entries = repository_tree(repo_id, revision, cancel).await?;
    // Index companion names once. A repository may list thousands of GGUF
    // variants; searching its whole tree again per row would be quadratic.
    let mut loading: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    for entry in &entries {
        if entry.entry_type != "file" {
            continue;
        }
        let (directory, name) = entry.path.rsplit_once('/').unwrap_or(("", &entry.path));
        loading
            .entry(directory.into())
            .or_default()
            .insert(name.into());
    }
    entries
        .into_iter()
        .filter(|entry| {
            entry.entry_type == "file" && entry.path.to_ascii_lowercase().ends_with(".gguf")
        })
        .map(|entry| {
            validate_repo_path(&entry.path)?;
            let directory = entry
                .path
                .rsplit_once('/')
                .map(|(directory, _)| directory)
                .unwrap_or("");
            let local = loading
                .get(directory)
                .filter(|names| names.contains("config.json"))
                .or_else(|| loading.get(""));
            let companions_available = !is_mmproj(&entry.path)
                && shard_group(entry.path.rsplit('/').next().unwrap_or_default()).is_none()
                && local.is_some_and(|names| {
                    names.contains("config.json")
                        && (["tokenizer.json", "tokenizer.model", "spiece.model"]
                            .iter()
                            .any(|name| names.contains(*name))
                            || (names.contains("vocab.json") && names.contains("merges.txt")))
                });
            // HF stores large files in Git LFS: `oid` is the 40-char git blob
            // SHA while the real file SHA-256 lives in `lfs.oid`.
            let oid = entry
                .lfs
                .as_ref()
                .and_then(|lfs| lfs.oid.clone())
                .or(entry.oid);
            Ok(HfFile {
                path: entry.path.clone(),
                size_bytes: entry.size,
                oid,
                is_mmproj: is_mmproj(&entry.path),
                download_url: download_url_at(repo_id, &entry.path, revision),
                companions_available,
            })
        })
        .collect()
}

/// GGUF's standard multi-part suffix is `-00001-of-00033.gguf`. Returns every
/// file name in the group, in order, when `name` is one part of such a set.
fn shard_group(name: &str) -> Option<Vec<String>> {
    let (stem, extension) = name.rsplit_once('.')?;
    if !extension.eq_ignore_ascii_case("gguf") {
        return None;
    }
    let (prefix, total) = stem.rsplit_once("-of-")?;
    let (base, index) = prefix.rsplit_once('-')?;
    if base.is_empty()
        || index.len() != 5
        || total.len() != 5
        || !index.bytes().all(|byte| byte.is_ascii_digit())
        || !total.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let index: usize = index.parse().ok()?;
    let total: usize = total.parse().ok()?;
    if total <= 1 || index == 0 || index > total {
        return None;
    }
    Some(
        (1..=total)
            .map(|part| format!("{base}-{part:05}-of-{total:05}.{extension}"))
            .collect(),
    )
}

/// Which parts of `target`'s multi-part set are not on disk beside it.
fn missing_shards(target: &Path) -> Vec<String> {
    let Some(name) = target.file_name().and_then(|value| value.to_str()) else {
        return Vec::new();
    };
    let Some(group) = shard_group(name) else {
        return Vec::new();
    };
    let parent = target.parent().unwrap_or(Path::new(""));
    group
        .into_iter()
        .filter(|part| !parent.join(part).is_file())
        .collect()
}

/// Which of `files` this machine already holds for `repo_id`.
///
/// Reports only the destination a Discover download actually writes to —
/// `<models_dir>/hf/<author>/<model>/<path>` — so a model of the same name
/// stored elsewhere in the library is never mistaken for this repository's
/// copy, and so the answer follows the configured directory rather than any
/// fixed location. Purely a read: unlike the download path it creates nothing.
pub fn installed_files(
    models_dir: &str,
    repo_id: &str,
    files: &[String],
) -> Result<Vec<InstalledHfFile>, String> {
    validate_repo_id(repo_id)?;
    let root = models_dir.trim();
    if root.is_empty() {
        return Err("models directory is empty".into());
    }
    if files.len() > MAX_TREE_ENTRIES {
        return Err("too many repository files to inspect safely".into());
    }
    let base = Path::new(root).join("hf").join(repo_directory(repo_id));
    let mut installed = Vec::new();
    for file in files {
        if validate_repo_path(file).is_err() {
            continue;
        }
        let target = base.join(relative_path(file));
        let Ok(metadata) = fs::metadata(&target) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        installed.push(InstalledHfFile {
            path: file.clone(),
            local_path: target.to_string_lossy().into_owned(),
            size_bytes: metadata.len(),
            missing_shards: missing_shards(&target),
        });
    }
    Ok(installed)
}

fn expected_sha256(oid: Option<&str>) -> Option<String> {
    let value = oid?
        .strip_prefix("sha256:")
        .unwrap_or(oid?)
        .to_ascii_lowercase();
    (value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit()))
        .then_some(value)
}

/// Hash a file that is already at a download destination. Reads are bounded by
/// the size the repository declares and checked for cancellation between
/// chunks, so verifying a resumed multi-GiB file can be stopped like a transfer.
async fn hash_existing_file<F>(
    path: &Path,
    size: u64,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<String, String>
where
    F: FnMut(u64),
{
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("cannot verify downloaded file: {error}"))?;
    let length = file
        .metadata()
        .await
        .map_err(|error| format!("cannot verify downloaded file: {error}"))?
        .len();
    if length != size {
        return Err(format!("existing file is {length} bytes; expected {size}"));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_BYTES];
    let mut read = 0_u64;
    let mut last_progress = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(DOWNLOAD_CANCELLED.into());
        }
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("cannot hash downloaded file: {error}"))?;
        if count == 0 {
            break;
        }
        read = read.saturating_add(count as u64);
        if read > size {
            return Err("existing file grew while it was verified".into());
        }
        hasher.update(&buffer[..count]);
        if last_progress.elapsed() >= DOWNLOAD_UPDATE_INTERVAL {
            progress(read);
            last_progress = std::time::Instant::now();
        }
    }
    if read != size {
        return Err("existing file shrank while it was verified".into());
    }
    progress(read);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Records which repository served the bytes now at `target`, so a later
/// measurement can name the model's actual distributor.
///
/// Only ever called with proof: either this application just transferred the
/// file, or the file already there matched the digest the repository publishes.
/// A receipt that cannot be written costs provenance on a later run and nothing
/// else, so it never turns a finished download into a failure.
fn note_download(target: &Path, repo_id: &str, file_path: &str) {
    if let Ok(root) = crate::benchmark::data_root() {
        let _ = crate::benchmark::download_receipt::record(&root, target, repo_id, file_path);
    }
}

fn emit_progress(
    app: &AppHandle,
    repo_id: &str,
    file_path: &str,
    phase: &str,
    received: u64,
    total: u64,
) {
    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "repo_id": repo_id,
            "file_path": file_path,
            "phase": phase,
            "received": received,
            "total": total,
        }),
    );
}

/// Hash each chunk as it is written, avoiding a second read of a multi-GiB
/// model. Buffer small network chunks and bound UI updates independently of
/// throughput; the timer also notices cancellation while the server is silent.
async fn receive_download<F>(
    mut response: reqwest::Response,
    part: &Path,
    total: u64,
    expected: Option<&str>,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<u64, String>
where
    F: FnMut(&'static str, u64, u64),
{
    let output = create_staging_file(part).await?;
    let mut received = 0_u64;
    let result = async {
        // Keep the writer inside this scope so errors close it before the
        // staging file is removed, including on Windows.
        let mut output = BufWriter::with_capacity(DOWNLOAD_BUFFER_BYTES, output);
        let mut hasher = Sha256::new();
        let mut updates = tokio::time::interval(DOWNLOAD_UPDATE_INTERVAL);
        updates.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut reported = 0_u64;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(DOWNLOAD_CANCELLED.to_string());
            }
            let chunk = tokio::select! {
                biased;
                _ = updates.tick() => {
                    if received != reported {
                        progress("downloading", received, total);
                        reported = received;
                    }
                    continue;
                }
                chunk = response.chunk() => chunk
                    .map_err(|error| format!("model download stream failed: {error}"))?,
            };
            let Some(chunk) = chunk else {
                break;
            };
            received = received.saturating_add(chunk.len() as u64);
            if received > MAX_MODEL_BYTES || received > total {
                return Err("model download reported an unsafe size".into());
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|error| format!("cannot write model download: {error}"))?;
            hasher.update(&chunk);
        }
        output
            .flush()
            .await
            .map_err(|error| format!("cannot flush model download: {error}"))?;
        if received != total {
            return Err(format!(
                "model download ended at {received} bytes; expected {total}"
            ));
        }
        if let Some(expected) = expected {
            if format!("{:x}", hasher.finalize()) != expected {
                return Err(
                    "downloaded model checksum does not match Hugging Face metadata".into(),
                );
            }
        }
        if cancel.load(Ordering::Acquire) {
            return Err(DOWNLOAD_CANCELLED.to_string());
        }
        if received != reported {
            progress("downloading", received, total);
        }
        Ok(received)
    }
    .await;
    if let Err(error) = &result {
        let _ = tokio::fs::remove_file(part).await;
        if error == DOWNLOAD_CANCELLED {
            progress("cancelled", received, total);
        }
    }
    result
}

/// Resolve every shard from one immutable tree before downloading any bytes.
/// A request for any part selects the same complete model and first entrypoint.
fn model_download_plan(files: &[HfFile], file_path: &str) -> Result<Vec<HfFile>, String> {
    let (directory, name) = file_path.rsplit_once('/').unwrap_or(("", file_path));
    let paths = shard_group(name).unwrap_or_else(|| vec![name.to_owned()]);
    let indexed: std::collections::HashMap<_, _> = files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    paths
        .into_iter()
        .map(|name| {
            let path = if directory.is_empty() {
                name
            } else {
                format!("{directory}/{name}")
            };
            indexed
                .get(path.as_str())
                .map(|file| (*file).clone())
                .ok_or_else(|| {
                    format!("GGUF model file was not found in the repository tree: {path}")
                })
        })
        .collect()
}

pub async fn download(
    app: AppHandle,
    repo_id: &str,
    file_path: &str,
    models_dir: &str,
    cancel: Arc<AtomicBool>,
    include_companions: bool,
) -> Result<DownloadedModel, String> {
    validate_repo_id(repo_id)?;
    validate_repo_path(file_path)?;
    let revision = immutable_revision(repo_id, &cancel).await?;
    let files = files_at(repo_id, &revision, &cancel).await?;
    let plan = model_download_plan(&files, file_path)?;
    if plan.iter().any(|file| file.size_bytes > MAX_MODEL_BYTES) {
        return Err("model file exceeds the 512 GiB safety limit".into());
    }
    let total = plan.iter().try_fold(0_u64, |total, file| {
        total
            .checked_add(file.size_bytes)
            .ok_or("model download size overflow")
    })?;
    let entrypoint = plan
        .first()
        .ok_or("model download has no files")?
        .path
        .clone();
    let label = if plan.len() > 1 {
        let (stem, extension) = entrypoint.rsplit_once('.').ok_or("invalid GGUF path")?;
        let (prefix, _) = stem.rsplit_once("-of-").ok_or("invalid GGUF shard")?;
        format!(
            "{}.{extension}",
            prefix.rsplit_once('-').ok_or("invalid GGUF shard")?.0
        )
    } else {
        entrypoint.clone()
    };
    if include_companions {
        let entries = repository_tree(repo_id, &revision, &cancel).await?;
        let plan = snapshots::gguf_companion_plan(&entries, file_path)?;
        let target = target_path(models_dir, repo_id, file_path)?;
        snapshots::download_gguf_companions(
            &app,
            repo_id,
            &revision,
            target
                .parent()
                .ok_or("model has no destination directory")?,
            &plan,
            &cancel,
        )
        .await?;
    }
    let mut completed = 0_u64;
    let mut downloaded = None;
    for file in &plan {
        let part = download_file(repo_id, file, models_dir, &cancel, |phase, received, _| {
            emit_progress(
                &app,
                repo_id,
                &label,
                phase,
                completed.saturating_add(received),
                total,
            );
        })
        .await?;
        completed = completed.saturating_add(part.size_bytes);
        if downloaded.is_none() {
            downloaded = Some(part);
        }
    }
    let mut downloaded = downloaded.ok_or("model download has no files")?;
    downloaded.size_bytes = completed;
    if include_companions {
        snapshots::validate_gguf_companions(Path::new(&downloaded.path))?;
    }
    emit_progress(
        &app,
        repo_id,
        &label,
        "complete",
        downloaded.size_bytes,
        downloaded.size_bytes,
    );
    Ok(downloaded)
}

async fn download_file<F>(
    repo_id: &str,
    file: &HfFile,
    models_dir: &str,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<DownloadedModel, String>
where
    F: FnMut(&'static str, u64, u64),
{
    if cancel.load(Ordering::Acquire) {
        return Err("model download cancelled".into());
    }
    let file_path = file.path.as_str();
    let target = target_path(models_dir, repo_id, file_path)?;
    let part = temporary_download_path(&target)?;
    let total = file.size_bytes;
    if total > MAX_MODEL_BYTES {
        return Err("model file exceeds the 512 GiB safety limit".into());
    }
    let expected = expected_sha256(file.oid.as_deref());
    match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("model destination must not be a symbolic link".into());
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err("model destination is not a regular file".into());
        }
        Ok(metadata) => {
            if let Some(expected) = expected.as_deref() {
                if metadata.len() != total {
                    return Err(
                        "a different model already exists at the download destination".into(),
                    );
                }
                let actual = hash_existing_file(&target, total, cancel, |read| {
                    progress("downloading", read, total);
                })
                .await?;
                if actual == expected {
                    note_download(&target, repo_id, file_path);
                    return Ok(DownloadedModel {
                        repo_id: repo_id.to_owned(),
                        file_path: file_path.to_owned(),
                        path: target.to_string_lossy().into_owned(),
                        size_bytes: total,
                    });
                }
                return Err("a different model already exists at the download destination".into());
            }
            if metadata.len() == total {
                // The repository published no digest, so a file of the same
                // length is only plausibly the same file. Reuse it rather than
                // transfer it again, but record no provenance for it: nothing
                // here shows these bytes came from this repository.
                return Ok(DownloadedModel {
                    repo_id: repo_id.to_owned(),
                    file_path: file_path.to_owned(),
                    path: target.to_string_lossy().into_owned(),
                    size_bytes: total,
                });
            }
            return Err("a different model already exists at the download destination".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot inspect existing model destination: {error}"
            ));
        }
    }
    progress("starting", 0, total);
    let response = tokio::select! {
        _ = snapshots::wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
        response = download_client()?.get(&file.download_url).send() => response.map_err(|error| format!("model download failed: {error}"))?
    };
    validate_response_url(&response)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("model download HTTP status: {status}"));
    }
    let response_total = response.content_length().unwrap_or(total);
    if response
        .content_length()
        .is_some_and(|length| length != total)
    {
        return Err(format!(
            "model download length {response_total} does not match repository metadata {total}"
        ));
    }
    if response_total > MAX_MODEL_BYTES {
        return Err("model download exceeds the 512 GiB safety limit".into());
    }
    let received = receive_download(
        response,
        &part,
        response_total,
        expected.as_deref(),
        cancel,
        &mut progress,
    )
    .await?;
    if cancel.load(Ordering::Acquire) {
        let _ = tokio::fs::remove_file(&part).await;
        progress("cancelled", received, response_total);
        return Err("model download cancelled".into());
    }
    if let Err(error) = activate_download(&part, &target).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(error);
    }
    note_download(&target, repo_id, file_path);
    Ok(DownloadedModel {
        repo_id: repo_id.to_owned(),
        file_path: file_path.to_owned(),
        path: target.to_string_lossy().into_owned(),
        size_bytes: received,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_file(path: &str, size_bytes: u64) -> HfFile {
        HfFile {
            path: path.into(),
            size_bytes,
            oid: None,
            is_mmproj: false,
            download_url: "https://example.invalid/unused".into(),
            companions_available: false,
        }
    }

    #[test]
    fn split_model_download_resolves_every_part_in_order_in_the_selected_directory() {
        let files: Vec<_> = (1..=33)
            .rev()
            .map(|part| model_file(&format!("Q4/model-{part:05}-of-00033.gguf"), part))
            .chain([model_file("Q8/model-00001-of-00033.gguf", 999)])
            .collect();
        let plan = model_download_plan(&files, "Q4/model-00017-of-00033.gguf").unwrap();
        assert_eq!(plan.len(), 33);
        assert_eq!(plan[0].path, "Q4/model-00001-of-00033.gguf");
        assert_eq!(plan[32].path, "Q4/model-00033-of-00033.gguf");
        assert_eq!(plan.iter().map(|file| file.size_bytes).sum::<u64>(), 561);
    }

    #[test]
    fn incomplete_repository_shard_sets_are_rejected_before_a_transfer_starts() {
        let files = [
            model_file("Q4/model-00001-of-00002.gguf", 10),
            model_file("Q8/model-00002-of-00002.gguf", 10),
            model_file("mmproj.gguf", 20),
        ];
        assert!(model_download_plan(&files, "Q4/model-00001-of-00002.gguf")
            .unwrap_err()
            .contains("Q4/model-00002-of-00002.gguf"));
        assert_eq!(model_download_plan(&files, "mmproj.gguf").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn completed_shards_are_reused_and_cancellation_is_preserved_between_parts() {
        let root = installed_fixture();
        let first = model_file("model-00001-of-00002.gguf", 3);
        let second = model_file("model-00002-of-00002.gguf", 3);
        write_repo_file(&root, &first.path, b"one");
        let cancel = AtomicBool::new(false);
        let done = download_file(
            "owner/model",
            &first,
            root.to_str().unwrap(),
            &cancel,
            |_, _, _| panic!("size-matched existing file needs no network stream"),
        )
        .await
        .unwrap();
        assert_eq!(done.size_bytes, 3);
        assert!(done.path.ends_with(&first.path));
        cancel.store(true, Ordering::Release);
        let error = download_file(
            "owner/model",
            &second,
            root.to_str().unwrap(),
            &cancel,
            |_, _, _| panic!("cancelled shard must not start a stream"),
        )
        .await
        .unwrap_err();
        assert_eq!(error, DOWNLOAD_CANCELLED);
        assert!(cancel.load(Ordering::Acquire));
        assert_eq!(fs::read(done.path).unwrap(), b"one");
        assert!(
            !target_path(root.to_str().unwrap(), "owner/model", &second.path)
                .unwrap()
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn download_urls_encode_filenames_and_pin_the_verified_revision() {
        let revision = "a".repeat(40);
        let url = download_url_at("owner/model", "Q4/a #?.gguf", &revision);
        assert!(url.contains(&format!("/resolve/{revision}/Q4/a%20%23%3F.gguf")));
        assert!(!url.contains("/resolve/main/"));
    }

    #[test]
    fn pagination_stays_in_the_exact_repository_and_revision() {
        let headers = |url: &str| {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("link", format!("<{url}>; rel=\"next\"").parse().unwrap());
            headers
        };
        assert!(tree_next_page(
            &headers("https://huggingface.co/api/models/owner/model/tree/main?cursor=next"),
            "owner/model",
            "main"
        )
        .unwrap()
        .is_some());
        for url in [
            "https://other.example/api/models/owner/model/tree/main",
            "https://huggingface.co/api/models/owner/model/tree/main-evil",
            "https://huggingface.co/api/models/other/model/tree/main",
            "https://huggingface.co/api/models/owner/model/tree/another",
            "http://huggingface.co/api/models/owner/model/tree/main",
        ] {
            assert!(
                tree_next_page(&headers(url), "owner/model", "main").is_err(),
                "{url}"
            );
        }
    }
    use tokio::io::AsyncReadExt;

    async fn download_response(
        body: Vec<u8>,
        content_length: usize,
        stall_after_body: bool,
    ) -> (reqwest::Response, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind download fixture");
        let address = listener.local_addr().expect("download fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept download request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).await.expect("read request");
                assert!(read > 0, "request ended before its headers");
                request.extend_from_slice(&buffer[..read]);
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("write download headers");
            for chunk in body.chunks(4093) {
                socket.write_all(chunk).await.expect("write download body");
                tokio::task::yield_now().await;
            }
            if stall_after_body {
                std::future::pending::<()>().await;
            }
        });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("download test client")
            .get(format!("http://{address}/model.gguf"))
            .send()
            .await
            .expect("request test download");
        (response, server)
    }

    fn download_staging_fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("aiolm-stream-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create download fixture directory");
        let root = root.canonicalize().expect("resolve download fixture");
        let part = root.join("model.part");
        (root, part)
    }

    #[tokio::test]
    async fn download_stream_preserves_bytes_and_flushes_the_final_buffer() {
        let body: Vec<u8> = (0..DOWNLOAD_BUFFER_BYTES * 2 + 17)
            .map(|index| (index % 251) as u8)
            .collect();
        let total = body.len() as u64;
        let expected = format!("{:x}", Sha256::digest(&body));
        let (response, server) = download_response(body.clone(), body.len(), false).await;
        let (root, part) = download_staging_fixture();
        let mut updates = Vec::new();
        let started = std::time::Instant::now();
        let received = receive_download(
            response,
            &part,
            total,
            Some(expected.as_str()),
            &AtomicBool::new(false),
            |phase, received, total| updates.push((phase, received, total)),
        )
        .await
        .expect("download verified stream");
        assert_eq!(received, total);
        assert_eq!(fs::read(&part).expect("read complete download"), body);
        assert_eq!(updates.last(), Some(&("downloading", total, total)));
        let max_updates = started.elapsed().as_millis() / DOWNLOAD_UPDATE_INTERVAL.as_millis() + 2;
        assert!(updates.len() as u128 <= max_updates);
        server.await.expect("download server finished");
        fs::remove_dir_all(root).expect("remove download fixture");
    }

    #[tokio::test]
    async fn checksum_mismatch_removes_the_staged_download() {
        let body = b"corrupted model".to_vec();
        let total = body.len() as u64;
        let expected = format!("{:x}", Sha256::digest(b"expected model"));
        let (response, server) = download_response(body, total as usize, false).await;
        let (root, part) = download_staging_fixture();
        let error = receive_download(
            response,
            &part,
            total,
            Some(expected.as_str()),
            &AtomicBool::new(false),
            |_, _, _| {},
        )
        .await
        .expect_err("reject a checksum mismatch");
        assert!(error.contains("checksum does not match"), "{error}");
        assert!(!part.exists(), "corrupt staging file must be removed");
        server.await.expect("download server finished");
        fs::remove_dir_all(root).expect("remove download fixture");
    }

    #[tokio::test]
    async fn interrupted_response_removes_the_staged_download() {
        let (response, server) = download_response(b"partial".to_vec(), 100, false).await;
        let (root, part) = download_staging_fixture();
        let error = receive_download(
            response,
            &part,
            100,
            Some("unused digest"),
            &AtomicBool::new(false),
            |_, _, _| {},
        )
        .await
        .expect_err("reject an interrupted response");
        assert!(error.contains("model download stream failed"), "{error}");
        assert!(!part.exists(), "partial staging file must be removed");
        server.await.expect("download server finished");
        fs::remove_dir_all(root).expect("remove download fixture");
    }

    #[tokio::test]
    async fn stalled_download_cancels_promptly_and_removes_the_staging_file() {
        let (response, server) = download_response(b"partial".to_vec(), 100, true).await;
        let (root, part) = download_staging_fixture();
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_after_stall = cancel.clone();
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancel_after_stall.store(true, Ordering::Release);
        });
        let mut updates = Vec::new();
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            receive_download(
                response,
                &part,
                100,
                Some("unused digest"),
                &cancel,
                |phase, received, total| updates.push((phase, received, total)),
            ),
        )
        .await
        .expect("cancellation must not wait for another response chunk")
        .expect_err("cancel stalled transfer");
        assert_eq!(error, DOWNLOAD_CANCELLED);
        assert_eq!(updates.last(), Some(&("cancelled", 7, 100)));
        assert!(!part.exists(), "cancelled staging file must be removed");
        cancel_task.await.expect("cancel task finished");
        server.abort();
        fs::remove_dir_all(root).expect("remove download fixture");
    }

    #[test]
    fn rejects_repo_and_file_traversal() {
        assert!(validate_repo_id("org/model").is_ok());
        assert!(validate_repo_id("https://huggingface.co/org/model").is_err());
        assert!(validate_repo_id("org/../model").is_err());
        assert!(validate_repo_path("Q4/model.gguf").is_ok());
        assert!(validate_repo_path("../model.gguf").is_err());
        assert!(validate_repo_path("Q4\\model.gguf").is_err());
        assert!(validate_repo_path("README.md").is_err());
    }

    #[test]
    fn target_is_nested_under_the_selected_models_root() {
        let root = std::env::temp_dir().join(format!("aiolm-discover-{}", uuid::Uuid::new_v4()));
        let path = target_path(&root.to_string_lossy(), "org/model", "Q4/model.gguf")
            .expect("safe target");
        let canonical_root = root.canonicalize().expect("canonical root");
        assert!(path.starts_with(canonical_root.join("hf").join("org").join("model")));
        assert!(path.ends_with(Path::new("Q4").join("model.gguf")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn temporary_download_paths_are_unique_and_not_predictable_target_part_files() {
        let target = Path::new("C:/models/model.gguf");
        let first = temporary_download_path(target).expect("temporary path");
        let second = temporary_download_path(target).expect("temporary path");
        assert_ne!(first, second);
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".model.gguf."));
        assert!(first
            .extension()
            .is_some_and(|extension| extension == "part"));
    }

    #[test]
    fn repository_names_that_share_a_slug_get_distinct_directories() {
        let root = std::env::temp_dir().join(format!("aiolm-discover-{}", uuid::Uuid::new_v4()));
        let first = target_path(&root.to_string_lossy(), "a--b/c", "model.gguf").unwrap();
        let second = target_path(&root.to_string_lossy(), "a/b--c", "model.gguf").unwrap();
        assert_ne!(first, second);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn activation_is_no_replace_and_cleans_the_staging_file() {
        let root = std::env::temp_dir().join(format!("aiolm-activation-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create activation directory");
        let root = root
            .canonicalize()
            .expect("canonicalize activation directory");
        let part = root.join("model.part");
        let target = root.join("model.gguf");
        fs::write(&part, b"downloaded").expect("write staged model");
        activate_download(&part, &target)
            .await
            .expect("activate staged model");
        assert_eq!(
            fs::read(&target).expect("read activated model"),
            b"downloaded"
        );
        assert!(!part.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn activation_rejects_an_existing_destination_without_overwrite() {
        let root = std::env::temp_dir().join(format!("aiolm-activation-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create activation directory");
        let root = root
            .canonicalize()
            .expect("canonicalize activation directory");
        let part = root.join("model.part");
        let target = root.join("model.gguf");
        fs::write(&part, b"downloaded").expect("write staged model");
        fs::write(&target, b"existing").expect("write existing model");
        assert!(activate_download(&part, &target).await.is_err());
        assert_eq!(fs::read(&target).expect("read existing model"), b"existing");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_only_sha256_oids_for_verification() {
        assert_eq!(
            expected_sha256(Some(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into())
        );
        assert_eq!(expected_sha256(Some("git-oid")), None);
    }

    #[test]
    fn prefers_lfs_oid_over_git_blob_oid() {
        // HF tree entries carry the 40-char git blob SHA in `oid` and the
        // real file SHA-256 in `lfs.oid`.
        let entry: ApiTreeEntry = serde_json::from_value(serde_json::json!({
            "path": "model.Q4_K_M.gguf",
            "size": 123,
            "oid": "d283a4ea95d085fc82b6d743a816830c66ab050a",
            "lfs": { "oid": "849856e1e7eff8ea7425a2a4cee50f3d547165194f50ea3112c9fc07cb08daad" },
            "type": "file",
        }))
        .expect("parse LFS tree entry");
        let oid = entry
            .lfs
            .as_ref()
            .and_then(|lfs| lfs.oid.clone())
            .or(entry.oid);
        assert_eq!(
            expected_sha256(oid.as_deref()),
            Some("849856e1e7eff8ea7425a2a4cee50f3d547165194f50ea3112c9fc07cb08daad".to_string())
        );
    }

    fn installed_fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("aiolm-installed-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("hf").join("owner").join("model"))
            .expect("create installed fixture directory");
        root
    }

    fn write_repo_file(root: &Path, name: &str, bytes: &[u8]) {
        fs::write(
            root.join("hf").join("owner").join("model").join(name),
            bytes,
        )
        .expect("write installed fixture file");
    }

    #[test]
    fn search_rejects_a_sort_order_the_api_does_not_accept() {
        let rejected = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build test runtime")
            .block_on(search_format("qwen", 5, "popularity", "gguf"));
        assert_eq!(
            rejected.err(),
            Some("model sort order is not supported".to_string())
        );
    }

    #[test]
    fn a_gated_repository_is_read_from_either_spelling_the_hub_uses() {
        let parse = |value: serde_json::Value| {
            serde_json::from_value::<ApiModel>(
                serde_json::json!({ "id": "owner/model", "gated": value }),
            )
            .expect("parse listing entry")
            .gated
        };
        assert!(parse(serde_json::json!("manual")));
        assert!(parse(serde_json::json!("auto")));
        assert!(!parse(serde_json::json!(false)));
        assert!(parse(serde_json::json!(true)));
        assert!(!parse(serde_json::json!("false")));
        // A listing that omits the property must still parse.
        assert!(
            !serde_json::from_value::<ApiModel>(serde_json::json!({ "id": "owner/model" }))
                .expect("parse listing entry without access control")
                .gated
        );
    }

    #[test]
    fn the_listing_asks_for_every_property_it_reports() {
        for field in [
            "author",
            "gated",
            "downloads",
            "likes",
            "lastModified",
            "pipeline_tag",
            "tags",
        ] {
            assert!(EXPAND_FIELDS.contains(&field), "{field}");
        }
    }

    #[test]
    fn every_offered_sort_order_is_one_the_api_documents() {
        assert!(SORT_KEYS.contains(&DEFAULT_SORT));
        assert_eq!(
            SORT_KEYS,
            ["downloads", "likes", "lastModified", "trendingScore"]
        );
    }

    #[test]
    fn only_files_present_under_the_configured_destination_count_as_installed() {
        let root = installed_fixture();
        write_repo_file(&root, "model.Q4_K_M.gguf", b"present");
        // Same file name directly in the library, not under this repository's
        // destination: a different copy, and not this repository's download.
        fs::write(root.join("model.Q8_0.gguf"), b"elsewhere").expect("write library file");
        let installed = installed_files(
            root.to_str().expect("fixture path"),
            "owner/model",
            &[
                "model.Q4_K_M.gguf".to_string(),
                "model.Q8_0.gguf".to_string(),
            ],
        )
        .expect("inspect installed files");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].path, "model.Q4_K_M.gguf");
        assert_eq!(installed[0].size_bytes, 7);
        assert!(installed[0].missing_shards.is_empty());
        fs::remove_dir_all(root).expect("remove installed fixture");
    }

    #[test]
    fn an_incomplete_split_model_reports_the_parts_that_are_still_missing() {
        let root = installed_fixture();
        write_repo_file(&root, "big-00001-of-00003.gguf", b"one");
        write_repo_file(&root, "big-00003-of-00003.gguf", b"three");
        let installed = installed_files(
            root.to_str().expect("fixture path"),
            "owner/model",
            &[
                "big-00001-of-00003.gguf".to_string(),
                "big-00002-of-00003.gguf".to_string(),
                "big-00003-of-00003.gguf".to_string(),
            ],
        )
        .expect("inspect split model");
        assert_eq!(installed.len(), 2);
        for entry in &installed {
            assert_eq!(entry.missing_shards, vec!["big-00002-of-00003.gguf"]);
        }
        write_repo_file(&root, "big-00002-of-00003.gguf", b"two");
        let complete = installed_files(
            root.to_str().expect("fixture path"),
            "owner/model",
            &["big-00002-of-00003.gguf".to_string()],
        )
        .expect("inspect completed split model");
        assert!(complete[0].missing_shards.is_empty());
        fs::remove_dir_all(root).expect("remove installed fixture");
    }

    #[test]
    fn inspecting_installed_files_never_creates_the_models_directory() {
        let root = std::env::temp_dir().join(format!("aiolm-absent-{}", Uuid::new_v4()));
        let installed = installed_files(
            root.to_str().expect("fixture path"),
            "owner/model",
            &["model.gguf".to_string()],
        )
        .expect("inspect an absent library");
        assert!(installed.is_empty());
        assert!(!root.exists());
    }

    #[test]
    fn installed_lookup_refuses_unsafe_repositories_and_skips_unsafe_paths() {
        let root = installed_fixture();
        assert!(installed_files(root.to_str().expect("fixture path"), "owner", &[]).is_err());
        assert!(installed_files("   ", "owner/model", &[]).is_err());
        let skipped = installed_files(
            root.to_str().expect("fixture path"),
            "owner/model",
            &["../escape.gguf".to_string()],
        )
        .expect("skip an unsafe path rather than failing the lookup");
        assert!(skipped.is_empty());
        fs::remove_dir_all(root).expect("remove installed fixture");
    }

    #[test]
    fn only_standard_shard_suffixes_form_a_group() {
        assert_eq!(
            shard_group("big-00002-of-00003.gguf"),
            Some(vec![
                "big-00001-of-00003.gguf".to_string(),
                "big-00002-of-00003.gguf".to_string(),
                "big-00003-of-00003.gguf".to_string(),
            ])
        );
        for name in [
            "model.gguf",
            "big-1-of-3.gguf",
            "big-00000-of-00003.gguf",
            "big-00004-of-00003.gguf",
            "big-00001-of-00001.gguf",
            "big-00001-of-00002.bin",
        ] {
            assert!(shard_group(name).is_none(), "{name}");
        }
    }

    #[tokio::test]
    async fn download_without_checksum_still_verifies_size() {
        let body = b"tiny model".to_vec();
        let total = body.len() as u64;
        let (response, server) = download_response(body.clone(), body.len(), false).await;
        let (root, part) = download_staging_fixture();
        let received = receive_download(
            response,
            &part,
            total,
            None,
            &AtomicBool::new(false),
            |_, _, _| {},
        )
        .await
        .expect("size-checked download succeeds without LFS digest");
        assert_eq!(received, total);
        assert_eq!(fs::read(&part).expect("read size-checked download"), body);
        server.await.expect("download server finished");
        fs::remove_dir_all(root).expect("remove download fixture");
    }
}
