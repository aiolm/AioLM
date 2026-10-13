//! Versioned external process adapters. Registrations own only their metadata;
//! executables, working directories, environments and models remain external.
use super::{
    artifacts::Modalities,
    launch::{EngineCommand, Readiness},
    protocol::EngineInfo,
    ProviderId,
};
use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

pub const VERSION: u32 = 1;
const LIMIT: u64 = 262_144;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Platform {
    pub os: String,
    pub arch: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSpec {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub working_directory: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExternalOption {
    pub key: String,
    #[serde(default)]
    pub flag: Option<String>,
    pub kind: Value,
    pub target: String,
    #[serde(default = "options_group")]
    pub group: String,
    #[serde(default)]
    pub runtime_default: Option<String>,
}
fn options_group() -> String {
    "runtime".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelBinding {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub adapter_version: u32,
    pub engine_id: ProviderId,
    pub runtime_id: String,
    pub display_name: String,
    pub platforms: Vec<Platform>,
    /// Both direct engines and out-of-process bridges expose canonical HTTP.
    /// A bridge can translate its engine's own wire format behind this boundary.
    pub protocol: String,
    pub probe: ProcessSpec,
    pub launch: ProcessSpec,
    #[serde(default)]
    pub options: Vec<ExternalOption>,
    pub model_formats: Vec<String>,
    #[serde(default)]
    pub models: Vec<ModelBinding>,
    #[serde(default)]
    pub artifacts: Vec<String>,
    pub health_path: String,
    #[serde(default)]
    pub health_authenticated: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub tasks: Vec<String>,
    pub modalities: Modalities,
    pub chat: bool,
    #[serde(default)]
    pub tools: bool,
}

/// The probe must resolve the exact selected model, rather than promote the
/// manifest's format declarations to model support.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProbeResult {
    pub schema_version: u32,
    pub engine_id: ProviderId,
    pub runtime_id: String,
    pub version: String,
    pub accelerator: String,
    pub model: String,
    pub model_supported: bool,
    pub served_model: String,
    pub capabilities: Capabilities,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct Registration {
    manifest: RuntimeManifest,
    executable_sha256: String,
    probe_sha256: String,
    #[serde(default)]
    artifacts_sha256: BTreeMap<String, String>,
    #[serde(default)]
    probe: Option<ProbeResult>,
    #[serde(default)]
    model_fingerprint: String,
    #[serde(default)]
    launch_fingerprint: String,
    #[serde(default)]
    error: Option<String>,
}

// Model probes are independently keyed. A slow response for another model
// cannot invalidate the current editor or a concurrent session's readiness.
#[derive(Clone)]
struct CachedModelProbe {
    registration: PathBuf,
    fingerprint: String,
    result: Result<ProbeResult, String>,
}
static MODEL_PROBES: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, CachedModelProbe>>> =
    std::sync::OnceLock::new();
fn model_key(registration: &Registration, cfg: &AppConfig) -> String {
    let identity = serde_json::json!({"root":root(),"manifest":registration.manifest,"program":registration.executable_sha256,"probe":registration.probe_sha256,"artifacts":registration.artifacts_sha256,"model":cfg.active_model,"launch":launch_fingerprint(&registration.manifest,cfg)});
    format!("{:x}", Sha256::digest(identity.to_string().as_bytes()))
}
fn cached_probe(
    registration: &Registration,
    cfg: &AppConfig,
) -> Result<Option<CachedModelProbe>, String> {
    let map = MODEL_PROBES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "adapter model probe cache lock was poisoned")?;
    Ok(map.get(&model_key(registration, cfg)).cloned())
}
fn store_model_probe(
    registration: &Registration,
    cfg: &AppConfig,
    result: Result<ProbeResult, String>,
) -> Result<(), String> {
    let mut map = MODEL_PROBES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "adapter model probe cache lock was poisoned")?;
    if map.len() >= 128 {
        if let Some(key) = map.keys().next().cloned() {
            map.remove(&key);
        }
    }
    map.insert(
        model_key(registration, cfg),
        CachedModelProbe {
            registration: path(
                registration.manifest.engine_id,
                &registration.manifest.runtime_id,
            )?,
            fingerprint: fingerprint(&cfg.active_model),
            result,
        },
    );
    Ok(())
}

pub fn root() -> PathBuf {
    crate::runtime::runtimes_root().join("adapters")
}
fn path(engine: ProviderId, runtime: &str) -> Result<PathBuf, String> {
    if !engine.is_custom() {
        return Err("external registrations require a custom.* engine ID".into());
    }
    super::python_env::validate_id(runtime)?;
    let target = root()
        .join(engine.as_str())
        .join(runtime)
        .join("registration.json");
    for component in [
        root(),
        root().join(engine.as_str()),
        root().join(engine.as_str()).join(runtime),
        target.clone(),
    ] {
        if fs::symlink_metadata(&component).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("runtime registration paths must not be symbolic links".into());
        }
    }
    Ok(target)
}
fn bounded_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file =
        fs::File::open(path).map_err(|e| format!("cannot read runtime registration: {e}"))?;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("runtime registration exceeds 256 KiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid runtime registration: {e}"))
}
fn digest(path: &Path) -> Result<String, String> {
    digest_cancellable(path, None)
}
fn digest_cancellable(path: &Path, cancel: Option<&AtomicBool>) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("runtime executable is unreadable: {e}"))?;
    let mut sha = Sha256::new();
    let mut buffer = [0; 32768];
    loop {
        if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
            return Err("runtime probe cancelled".into());
        }
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        sha.update(&buffer[..n]);
    }
    Ok(format!("{:x}", sha.finalize()))
}
fn read_registration(engine: ProviderId, runtime: &str) -> Result<Registration, String> {
    let registered: Registration = bounded_json(&path(engine, runtime)?)?;
    validate_manifest(&registered.manifest)?;
    if registered.manifest.engine_id != engine || registered.manifest.runtime_id != runtime {
        return Err("runtime registration identity mismatch".into());
    }
    Ok(registered)
}
pub fn manifest(engine: ProviderId, runtime: &str) -> Result<RuntimeManifest, String> {
    Ok(read_registration(engine, runtime)?.manifest)
}
fn save(registered: &Registration) -> Result<(), String> {
    let target = path(
        registered.manifest.engine_id,
        &registered.manifest.runtime_id,
    )?;
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::config::atomic_write(
        &target,
        &serde_json::to_vec_pretty(registered).map_err(|e| e.to_string())?,
    )
}
fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.contains('\0')
}
fn validate_process(process: &ProcessSpec) -> Result<(), String> {
    if !valid_text(&process.program, 32768) || !Path::new(&process.program).is_absolute() {
        return Err("adapter executables must use an absolute user-selected path".into());
    }
    if process.args.len() > 128
        || process
            .args
            .iter()
            .any(|s| s.len() > 32768 || s.contains('\0'))
        || process.env.len() > 64
    {
        return Err("adapter arguments or environment exceed their limits".into());
    }
    if process
        .working_directory
        .as_ref()
        .is_some_and(|p| !valid_text(p, 32768) || !Path::new(p).is_absolute())
    {
        return Err("adapter working directory must be absolute".into());
    }
    for (key, value) in &process.env {
        if !valid_text(key, 128)
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || value.len() > 32768
            || value.contains('\0')
        {
            return Err("invalid adapter environment entry".into());
        }
        if key.starts_with("AIOLM_") || key.starts_with("LLAMA_BOARD_") {
            return Err("adapter environment cannot override application-owned settings".into());
        }
    }
    Ok(())
}
pub fn validate_manifest(m: &RuntimeManifest) -> Result<(), String> {
    if m.schema_version != VERSION || m.adapter_version != VERSION {
        return Err("unsupported runtime manifest or adapter version".into());
    }
    path(m.engine_id, &m.runtime_id)?;
    if !valid_text(&m.display_name, 128) || m.protocol != "openai-v1" {
        return Err("adapter requires a display name and openai-v1 protocol".into());
    }
    if m.platforms.is_empty()
        || m.platforms.len() > 16
        || m.platforms.iter().any(|p| {
            !["macos", "linux", "windows"].contains(&p.os.as_str())
                || !["aarch64", "x86_64"].contains(&p.arch.as_str())
        })
    {
        return Err("adapter must declare explicit supported OS/architecture pairs".into());
    }
    if m.model_formats.is_empty()
        || m.model_formats
            .iter()
            .any(|f| !["gguf", "hf-safetensors", "mlx", "unknown"].contains(&f.as_str()))
    {
        return Err("invalid adapter model formats".into());
    }
    if !m.health_path.starts_with('/')
        || m.health_path.starts_with("//")
        || m.health_path.len() > 128
        || m.health_path.contains(['?', '#', '\\'])
        || m.health_path.chars().any(char::is_control)
    {
        return Err("health path must be a local HTTP path".into());
    }
    if m.models.len() > 128
        || m.models.iter().any(|model| {
            !valid_text(&model.path, 32768)
                || !Path::new(&model.path).is_absolute()
                || !valid_text(&model.name, 256)
        })
    {
        return Err("model bindings require an absolute path and a bounded display name".into());
    }
    validate_process(&m.launch)?;
    validate_process(&m.probe)?;
    if m.artifacts.len() > 64
        || m.artifacts
            .iter()
            .any(|path| !valid_text(path, 32768) || !Path::new(path).is_absolute())
    {
        return Err("adapter artifacts must be bounded absolute paths".into());
    }
    for template in m
        .launch
        .args
        .iter()
        .chain(m.launch.env.values())
        .chain(m.probe.args.iter())
        .chain(m.probe.env.values())
    {
        expand(template, &AppConfig::default(), 1, "", "model")?;
    }
    if !m
        .probe
        .args
        .iter()
        .chain(m.probe.env.values())
        .any(|s| s.contains("{model}"))
    {
        return Err("adapter probe must resolve the selected {model}".into());
    }
    if !m
        .launch
        .args
        .iter()
        .chain(m.launch.env.values())
        .any(|s| s.contains("{model}"))
    {
        return Err("adapter launch must consume the selected {model}".into());
    }
    if !m
        .launch
        .args
        .iter()
        .chain(m.launch.env.values())
        .any(|s| s.contains("{port}"))
    {
        return Err("adapter launch must bind the app-assigned {port}".into());
    }
    if m.launch.args.iter().any(|s| s.contains("{api_key}")) {
        return Err("credentials must travel through the adapter environment, not argv".into());
    }
    if m.options.len() > 128 {
        return Err("too many adapter options".into());
    }
    let mut keys = std::collections::BTreeSet::new();
    for option in &m.options {
        if !valid_text(&option.key, 128)
            || !option
                .key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || !keys.insert(&option.key)
            || !["launch", "request"].contains(&option.target.as_str())
        {
            return Err("invalid or duplicate adapter option".into());
        }
        if option.target == "launch"
            && option
                .flag
                .as_ref()
                .is_some_and(|f| !f.starts_with("--") || f.contains(['=', ' ', '\0']))
        {
            return Err("adapter option flag must be a single --flag".into());
        }
        if [
            "model",
            "host",
            "port",
            "api_key",
            "served_model_name",
            "model_alias",
            "messages",
            "prompt",
            "input",
            "stream",
            "stream_options",
            "tools",
            "tool_choice",
            "model_dir",
            "model_path",
            "adapter_path",
            "config",
            "trust_remote_code",
        ]
        .contains(&option.key.as_str())
        {
            return Err("adapter options cannot replace app-owned bindings".into());
        }
        if option.target == "launch" && option.flag.is_none() {
            return Err("launch options require an explicit flag".into());
        }
        if option.flag.as_ref().is_some_and(|flag| {
            super::options::app_managed_flags(m.engine_id).contains(&flag.as_str())
        }) {
            return Err("adapter option flag overrides an app-owned binding".into());
        }
        if option.target == "request" && (option.flag.is_some() || option.kind["type"] == "path") {
            return Err("request options cannot expose launch flags or local file bindings".into());
        }
        validate_kind(&option.kind)?;
        if option.target == "launch"
            && !m
                .probe
                .args
                .iter()
                .chain(m.probe.env.values())
                .any(|s| s.contains("{options_json}"))
        {
            return Err("launch options require {options_json} in the model probe".into());
        }
    }
    Ok(())
}
fn validate_kind(kind: &Value) -> Result<(), String> {
    let t = kind.get("type").and_then(Value::as_str).unwrap_or("");
    match t {
        "integer" | "number"
            if kind["min"]
                .as_f64()
                .zip(kind["max"].as_f64())
                .is_some_and(|(a, b)| a.is_finite() && b.is_finite() && a <= b) =>
        {
            Ok(())
        }
        "flag" | "toggle" | "path" | "json" => Ok(()),
        "text" if kind["max_len"].as_u64().is_some_and(|n| n <= 32768) => Ok(()),
        "choice"
            if kind["choices"].as_array().is_some_and(|v| {
                !v.is_empty()
                    && v.len() <= 128
                    && v.iter()
                        .all(|x| x.as_str().is_some_and(|s| valid_text(s, 1024)))
            }) =>
        {
            Ok(())
        }
        _ => Err("invalid adapter option schema".into()),
    }
}
pub fn option_issues(
    m: &RuntimeManifest,
    values: &Map<String, Value>,
) -> Vec<super::options::OptionIssue> {
    values
        .iter()
        .filter_map(|(key, value)| {
            let spec = m.options.iter().find(|s| s.key == *key);
            let valid = spec.is_some_and(|s| match s.kind["type"].as_str().unwrap_or("") {
                "integer" => value.as_i64().is_some_and(|n| {
                    n as f64 >= s.kind["min"].as_f64().unwrap()
                        && n as f64 <= s.kind["max"].as_f64().unwrap()
                }),
                "number" => value.as_f64().is_some_and(|n| {
                    n.is_finite()
                        && n >= s.kind["min"].as_f64().unwrap()
                        && n <= s.kind["max"].as_f64().unwrap()
                }),
                "flag" | "toggle" => value.is_boolean(),
                "choice" => s.kind["choices"].as_array().unwrap().contains(value),
                "text" => value.as_str().is_some_and(|s2| {
                    s2.len() <= s.kind["max_len"].as_u64().unwrap() as usize && !s2.contains('\0')
                }),
                "path" => value.as_str().is_some_and(|s| valid_text(s, 32768)),
                "json" => value.is_object() && value.to_string().len() <= 65536,
                _ => false,
            });
            (!valid).then(|| super::options::OptionIssue {
                key: key.clone(),
                code: if spec.is_some() { "type" } else { "unknown" },
                message: format!("unsupported or invalid adapter option: {key}"),
            })
        })
        .collect()
}
fn options(cfg: &AppConfig) -> Map<String, Value> {
    cfg.provider_options
        .get(&cfg.active_provider)
        .cloned()
        .unwrap_or_default()
}
fn expand(
    text: &str,
    cfg: &AppConfig,
    port: u16,
    key: &str,
    model_alias: &str,
) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let end = rest[start..].find('}').ok_or("unclosed adapter binding")? + start;
        let name = &rest[start + 1..end];
        let value = match name {
            "host" => "127.0.0.1".into(),
            "port" => port.to_string(),
            "model" => cfg.active_model.clone(),
            "model_alias" => model_alias.into(),
            "api_key" => key.into(),
            "options_json" => serde_json::to_string(&options(cfg)).map_err(|e| e.to_string())?,
            "ctx_size" => cfg.ctx_size.to_string(),
            "parallel" => cfg.parallel.max(1).to_string(),
            _ => return Err(format!("unknown adapter binding: {name}")),
        };
        out.push_str(&value);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}
fn check_files(r: &Registration) -> Result<(), String> {
    if digest(Path::new(&r.manifest.launch.program))? != r.executable_sha256
        || digest(Path::new(&r.manifest.probe.program))? != r.probe_sha256
    {
        return Err("adapter executable changed; register the updated build explicitly".into());
    }
    for (path, expected) in &r.artifacts_sha256 {
        if digest(Path::new(path))? != *expected {
            return Err("adapter artifact changed; register the updated build explicitly".into());
        }
    }
    Ok(())
}
fn fingerprint(model: &str) -> String {
    if model.is_empty() {
        return String::new();
    }
    let path = Path::new(model);
    if path.is_file() {
        // Loader/cache identity uses a file stamp and bounded header/config
        // content. Full weight SHA-256 belongs to download/acceptance evidence;
        // repeatedly hashing a 70 GB model would make UI validation unresponsive.
        let mut digest = Sha256::new();
        if let Ok(meta) = fs::metadata(path) {
            digest.update(meta.len().to_le_bytes());
            if let Ok(modified) = meta.modified().and_then(|time| {
                time.duration_since(std::time::UNIX_EPOCH)
                    .map_err(std::io::Error::other)
            }) {
                digest.update(modified.as_nanos().to_le_bytes());
            }
        }
        if let Ok(file) = fs::File::open(path) {
            let mut bytes = Vec::new();
            if file.take(LIMIT).read_to_end(&mut bytes).is_ok() {
                digest.update(bytes);
            }
        }
        return format!("{:x}", digest.finalize());
    }
    super::artifacts::local_fingerprint(path, None)
}

fn run_probe(
    r: &Registration,
    cfg: &AppConfig,
    cancel: Option<&AtomicBool>,
) -> Result<ProbeResult, String> {
    check_files(r)?;
    let m = &r.manifest;
    if !m
        .platforms
        .iter()
        .any(|p| p.os == std::env::consts::OS && p.arch == std::env::consts::ARCH)
    {
        return Err("adapter does not support this OS/architecture".into());
    }
    let mut command = crate::procutil::std_command(&m.probe.program);
    command
        .env_clear()
        .envs(super::python_env::engine_environment());
    for arg in &m.probe.args {
        command.arg(expand(
            arg,
            cfg,
            cfg.port,
            "",
            &super::launch::served_model_name(&cfg.active_model),
        )?);
    }
    for (name, value) in &m.probe.env {
        command.env(
            name,
            expand(
                value,
                cfg,
                cfg.port,
                "",
                &super::launch::served_model_name(&cfg.active_model),
            )?,
        );
    }
    if let Some(cwd) = &m.probe.working_directory {
        command.current_dir(cwd);
    }
    if !cfg.active_model.is_empty() && !Path::new(&cfg.active_model).exists() {
        return Err("selected model path is missing".into());
    }
    let before = fingerprint(&cfg.active_model);
    let output = crate::procutil::capture_output_cancellable(
        &mut command,
        Duration::from_secs(30),
        LIMIT as usize,
        cancel,
    )
    .map_err(|e| {
        if e.kind() == std::io::ErrorKind::Interrupted {
            "runtime probe cancelled".into()
        } else {
            format!("adapter probe failed: {e}")
        }
    })?;
    if !output.status.success() {
        return Err(format!(
            "adapter probe exited unsuccessfully ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2048)
                .collect::<String>()
                .trim()
        ));
    }
    let probe: ProbeResult = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid adapter probe JSON: {e}"))?;
    if probe.schema_version != VERSION
        || probe.engine_id != m.engine_id
        || probe.runtime_id != m.runtime_id
        || probe.model != cfg.active_model
        || !valid_text(&probe.version, 256)
        || !valid_text(&probe.accelerator, 128)
        || !valid_text(&probe.served_model, 256)
    {
        return Err("adapter probe identity, version or model mismatch".into());
    }
    if probe.capabilities.tasks.len() > 4
        || (probe.model_supported && probe.capabilities.tasks.is_empty())
        || probe
            .capabilities
            .tasks
            .iter()
            .any(|t| !["generate", "embed", "transcription", "translate"].contains(&t.as_str()))
    {
        return Err("adapter probe reports invalid tasks".into());
    }
    if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
        return Err("runtime probe cancelled".into());
    }
    check_files(r)?;
    if before != fingerprint(&cfg.active_model) {
        return Err("model changed during adapter probe".into());
    }
    Ok(probe)
}
pub async fn register(
    source: &Path,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<RuntimeManifest, String> {
    let manifest: RuntimeManifest = bounded_json(source)?;
    validate_manifest(&manifest)?;
    let target = path(manifest.engine_id, &manifest.runtime_id)?;
    if target.exists() {
        return Err(
            "runtime ID is already registered; remove its registration before replacing the build"
                .into(),
        );
    }
    let artifacts_sha256 = manifest
        .artifacts
        .iter()
        .map(|path| {
            Ok((
                path.clone(),
                digest_cancellable(Path::new(path), cancel.as_deref())?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let mut r = Registration {
        artifacts_sha256,
        executable_sha256: digest_cancellable(
            Path::new(&manifest.launch.program),
            cancel.as_deref(),
        )?,
        probe_sha256: digest_cancellable(Path::new(&manifest.probe.program), cancel.as_deref())?,
        manifest,
        probe: None,
        model_fingerprint: String::new(),
        launch_fingerprint: String::new(),
        error: None,
    };
    let cfg = AppConfig {
        active_provider: r.manifest.engine_id.as_str().into(),
        active_runtime: r.manifest.runtime_id.clone(),
        ..Default::default()
    };
    let copy = r.clone();
    let worker_cancel = cancel.clone();
    let probe =
        tokio::task::spawn_blocking(move || run_probe(&copy, &cfg, worker_cancel.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    if cancel
        .as_ref()
        .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
    {
        return Err("runtime probe cancelled".into());
    }
    // Claim publication atomically after probe, so concurrent registrars cannot
    // replace an already registered build. Failed publication owns no engines.
    fs::create_dir_all(target.parent().unwrap().parent().unwrap()).map_err(|e| e.to_string())?;
    fs::create_dir(target.parent().unwrap())
        .map_err(|e| format!("runtime registration collision: {e}"))?;
    r.probe = Some(probe);
    if let Err(error) = save(&r) {
        let _ = fs::remove_dir(target.parent().unwrap());
        return Err(error);
    }
    Ok(r.manifest)
}
pub async fn refresh(cfg: &AppConfig, cancel: Option<Arc<AtomicBool>>) -> Result<(), String> {
    let mut r = read_registration(super::provider_of(cfg), &cfg.active_runtime)?;
    let copy = r.clone();
    let cfg_copy = cfg.clone();
    let result =
        tokio::task::spawn_blocking(move || run_probe(&copy, &cfg_copy, cancel.as_deref()))
            .await
            .map_err(|e| e.to_string())?;
    store_model_probe(&r, cfg, result.clone())?;
    match result {
        Ok(probe) => {
            r.probe = Some(probe);
            r.model_fingerprint = fingerprint(&cfg.active_model);
            r.launch_fingerprint = launch_fingerprint(&r.manifest, cfg);
            r.error = None;
            save(&r)
        }
        Err(error) => {
            if cfg.active_model.is_empty() {
                r.probe = None;
                r.error = Some(error.clone());
            }
            r.model_fingerprint.clear();
            save(&r)?;
            Err(error)
        }
    }
}
pub fn remove(engine: ProviderId, runtime: &str) -> Result<(), String> {
    let target = path(engine, runtime)?;
    fs::remove_file(&target).map_err(|e| e.to_string())?;
    MODEL_PROBES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "adapter model probe cache lock was poisoned")?
        .retain(|_, entry| entry.registration != target);
    // Never recursively remove anything in an external engine's directory.
    match fs::remove_dir(target.parent().unwrap()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
fn registrations() -> Vec<Registration> {
    let mut result = Vec::new();
    for engine in fs::read_dir(root())
        .into_iter()
        .flatten()
        .flatten()
        .take(128)
    {
        if !engine.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(id) = engine
            .file_name()
            .to_str()
            .and_then(ProviderId::parse)
            .filter(|id| id.is_custom())
        else {
            continue;
        };
        for runtime in fs::read_dir(engine.path())
            .into_iter()
            .flatten()
            .flatten()
            .take(128)
        {
            if !runtime.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Some(name) = runtime.file_name().to_str() {
                if let Ok(r) = read_registration(id, name) {
                    result.push(r);
                }
            }
        }
    }
    result.sort_by(|a, b| {
        (a.manifest.engine_id, a.manifest.runtime_id.as_str())
            .cmp(&(b.manifest.engine_id, b.manifest.runtime_id.as_str()))
    });
    result
}

pub fn availability(engine: ProviderId, os: &str, arch: &str) -> super::Availability {
    let supported = registrations().iter().any(|r| {
        r.manifest.engine_id == engine
            && r.manifest
                .platforms
                .iter()
                .any(|p| p.os == os && p.arch == arch)
    });
    super::Availability {
        supported,
        reason: (!supported).then_some("external-runtime-unavailable"),
        detail: if supported {
            String::new()
        } else {
            "Register this external engine for the current OS/architecture before running it. Saved selections remain preserved.".into()
        },
    }
}
pub fn runtime_instances() -> Vec<super::RuntimeInstance> {
    registrations()
        .into_iter()
        .map(|r| {
            let mut problems = Vec::new();
            if let Err(e) = check_files(&r) {
                problems.push(e);
            }
            if let Some(e) = r.error {
                problems.push(e);
            }
            if !r
                .manifest
                .platforms
                .iter()
                .any(|p| p.os == std::env::consts::OS && p.arch == std::env::consts::ARCH)
            {
                problems.push("unsupported OS/architecture".into());
            }
            super::RuntimeInstance {
                provider: r.manifest.engine_id,
                id: r.manifest.runtime_id,
                engine: "external",
                server: "openai-v1",
                version: r.probe.as_ref().map(|p| p.version.clone()),
                variant: None,
                plugin_version: None,
                accelerator: r
                    .probe
                    .as_ref()
                    .map(|p| p.accelerator.clone())
                    .unwrap_or_default(),
                installation: "external",
                location: r.manifest.launch.program,
                available: problems.is_empty() && r.probe.is_some(),
                problems,
                backend: None,
                build: None,
                server_flags: None,
            }
        })
        .collect()
}
pub fn catalog() -> Vec<Value> {
    let mut seen = std::collections::BTreeSet::new();
    registrations().into_iter().filter(|r| seen.insert(r.manifest.engine_id)).map(|r| serde_json::json!({"id":r.manifest.engine_id,"engine":r.manifest.display_name,"server":"openai-v1","availability":r.manifest.engine_id.availability(),"options":r.manifest.options,"managed_version":null,"kind":"external-process","capabilities":{"benchmark":"unsupported","deep_verification":"unsupported","portable":"unsupported"}})).collect()
}
pub fn info(cfg: &AppConfig) -> Result<EngineInfo, String> {
    let r = read_registration(super::provider_of(cfg), &cfg.active_runtime)?;
    check_files(&r)?;
    let (p, model_fingerprint) = match cached_probe(&r, cfg)? {
        Some(cached) => (cached.result?, cached.fingerprint),
        None => {
            if let Some(error) = &r.error {
                return Err(error.clone());
            }
            if r.launch_fingerprint != launch_fingerprint(&r.manifest, cfg) {
                return Err("selected model requires a fresh adapter probe".into());
            }
            (
                r.probe
                    .clone()
                    .ok_or("probe this runtime before running it")?,
                r.model_fingerprint.clone(),
            )
        }
    };
    if !p.model_supported {
        return Err("The selected model is unsupported by this registered runtime.".into());
    }
    if p.model != cfg.active_model || model_fingerprint != fingerprint(&cfg.active_model) {
        return Err("selected model requires a successful adapter probe".into());
    }
    let values = options(cfg);
    let issues = option_issues(&r.manifest, &values);
    if !issues.is_empty() {
        return Err(issues
            .iter()
            .map(|i| i.message.as_str())
            .collect::<Vec<_>>()
            .join("; "));
    }
    let embedding = p.capabilities.tasks.iter().any(|t| t == "embed");
    let upstream = p.served_model.clone();
    Ok(EngineInfo {
        provider: p.engine_id,
        runtime_id: p.runtime_id.clone(),
        runtime_variant: "external-process".into(),
        speech_model_type: None,
        upstream_model: upstream.clone(),
        modalities: p.capabilities.modalities,
        tasks: p.capabilities.tasks,
        chat_supported: Some(p.capabilities.chat),
        request_option_keys: r
            .manifest
            .options
            .iter()
            .filter(|s| s.target == "request")
            .map(|s| s.key.clone())
            .collect(),
        request_fields: values
            .into_iter()
            .filter(|(key, _)| {
                r.manifest
                    .options
                    .iter()
                    .any(|s| s.key == *key && s.target == "request")
            })
            .collect(),
        request_lora: None,
        embedding_model: embedding.then_some(upstream),
        embedding_namespace: embedding.then(|| {
            format!(
                "{}:{}:{}:{}:{}:{}",
                p.engine_id.as_str(),
                p.runtime_id,
                p.version,
                r.executable_sha256,
                model_fingerprint,
                launch_fingerprint(&r.manifest, cfg)
            )
        }),
        tools_auto: p.capabilities.tools,
        tool_parser: p.capabilities.tools,
    })
}
pub fn command(cfg: &AppConfig, port: u16, key: &str) -> Result<EngineCommand, String> {
    let m = manifest(super::provider_of(cfg), &cfg.active_runtime)?;
    let info = info(cfg)?;
    let mut args = m
        .launch
        .args
        .iter()
        .map(|a| expand(a, cfg, port, key, &info.upstream_model))
        .collect::<Result<Vec<_>, _>>()?;
    for (name, value) in options(cfg) {
        let spec = m
            .options
            .iter()
            .find(|s| s.key == name)
            .ok_or("unknown adapter option")?;
        if spec.target != "launch" {
            continue;
        }
        let flag = spec
            .flag
            .as_ref()
            .ok_or("launch option requires an explicit flag")?;
        match spec.kind["type"].as_str() {
            Some("flag") => {
                if value == true {
                    args.push(flag.clone());
                }
            }
            Some("toggle") => {
                args.push(if value == true {
                    flag.clone()
                } else {
                    format!("--no-{}", flag.trim_start_matches("--"))
                });
            }
            _ => {
                args.push(flag.clone());
                args.push(
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                );
            }
        }
    }
    let env = m
        .launch
        .env
        .iter()
        .filter(|(_, value)| !(key.is_empty() && value.as_str() == "{api_key}"))
        .map(|(k, v)| {
            Ok((
                k.into(),
                expand(v, cfg, port, key, &info.upstream_model)?.into(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(EngineCommand {
        program: m.launch.program.into(),
        args,
        env,
        working_directory: m.launch.working_directory.map(PathBuf::from),
        upstream_model: info.upstream_model.clone(),
        readiness: Readiness {
            health_path: m.health_path,
            health_authenticated: m.health_authenticated,
            expected_model: info.upstream_model,
        },
    })
}

pub fn compatibility(cfg: &AppConfig) -> Result<super::compat::ModelCompatibility, String> {
    let registration = read_registration(super::provider_of(cfg), &cfg.active_runtime)?;
    let probe = cached_probe(&registration, cfg)?
        .map(|cached| cached.result)
        .transpose()?
        .or(registration.probe);
    if probe
        .as_ref()
        .is_some_and(|probe| probe.model == cfg.active_model && !probe.model_supported)
    {
        return Ok(super::compat::ModelCompatibility {
            provider: registration.manifest.engine_id,
            status: super::compat::CompatStatus::Unsupported,
            tasks: vec![],
            modalities: Modalities::default(),
            reasons: vec![super::compat::CompatReason {
                code: "adapter-model-unsupported",
                detail: "The installed adapter reports this model is unsupported.".into(),
            }],
            limitations: vec![],
            readiness: vec![],
            evidence: "adapter-model-probe",
        });
    }
    let info = info(cfg)?;
    let tasks = info
        .tasks
        .iter()
        .filter_map(|t| match t.as_str() {
            "generate" => Some("generate"),
            "embed" => Some("embed"),
            "transcription" => Some("transcription"),
            "translate" => Some("translate"),
            _ => None,
        })
        .collect();
    Ok(super::compat::ModelCompatibility {
        provider: info.provider,
        status: super::compat::CompatStatus::Supported,
        tasks,
        modalities: info.modalities,
        reasons: vec![],
        limitations: vec![],
        readiness: vec![],
        evidence: "adapter-model-probe",
    })
}
pub fn assess(
    artifact: &super::artifacts::ModelArtifact,
    engine: ProviderId,
) -> super::compat::ModelCompatibility {
    let compatible = registrations().into_iter().any(|r| {
        r.manifest.engine_id == engine
            && r.manifest.model_formats.contains(
                &serde_json::to_value(artifact.format)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default(),
            )
    });
    super::compat::ModelCompatibility { provider:engine, status:if compatible { super::compat::CompatStatus::Partial } else { super::compat::CompatStatus::Unknown }, tasks:vec![], modalities:Modalities::default(), reasons:vec![], limitations:vec!["Format declaration only: selecting this model requires a fresh model-specific adapter probe.".into()], readiness:artifact.missing.clone(), evidence:"adapter-manifest" }
}

fn launch_fingerprint(manifest: &RuntimeManifest, cfg: &AppConfig) -> String {
    let values = options(cfg)
        .into_iter()
        .filter(|(key, _)| {
            manifest
                .options
                .iter()
                .any(|option| option.key == *key && option.target == "launch")
        })
        .collect::<BTreeMap<_, _>>();
    let templates = manifest
        .launch
        .args
        .iter()
        .chain(manifest.launch.env.values())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    let binding = serde_json::json!({"options":values,"context":templates.contains("{ctx_size}").then_some(cfg.ctx_size),"parallel":templates.contains("{parallel}").then_some(cfg.parallel)});
    format!("{:x}", Sha256::digest(binding.to_string().as_bytes()))
}

pub fn registered_models() -> Vec<super::artifacts::ModelArtifact> {
    let mut models = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for registration in registrations() {
        for model in registration.manifest.models {
            if !seen.insert(model.path.clone()) {
                continue;
            }
            let path = Path::new(&model.path);
            if let Ok(mut artifact) = super::execution::inspect(path) {
                if artifact.format != super::artifacts::ArtifactFormat::Unknown {
                    artifact.name = model.name;
                    models.push(artifact);
                    continue;
                }
            }
            let metadata = fs::metadata(path).ok();
            models.push(super::artifacts::ModelArtifact { path:model.path, name:model.name, format:super::artifacts::ArtifactFormat::Unknown, role:super::artifacts::ArtifactRole::Model, size_bytes:0, file_count:usize::from(metadata.is_some()), architectures:vec![], model_type:None, quantization:None, has_tokenizer:false, has_processor:false, has_chat_template:false, modalities:Modalities::default(), missing:if metadata.is_some() { vec![] } else { vec!["registered model binding is missing".into()] }, incomplete:false, revision:None, repository:None, ownership:"external", notes:vec!["Opaque adapter model binding; weight size is unknown. Loader/tasks/inputs are checked by the model-specific probe.".into()] });
        }
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> RuntimeManifest {
        let root = std::env::temp_dir().join("aiolm-synthetic-adapter");
        let probe = root.join("probe");
        let server = root.join("server");
        serde_json::from_value(serde_json::json!({"schema_version":1,"adapter_version":1,"engine_id":"custom.example","runtime_id":"build-1","display_name":"Example engine","protocol":"openai-v1","platforms":[{"os":"linux","arch":"x86_64"}],"probe":{"program":probe,"args":["{model}","{options_json}"]},"launch":{"program":server,"args":["--model","{model}","--port","{port}","--alias","{model_alias}"],"env":{"ENGINE_KEY":"{api_key}"}},"model_formats":["unknown"],"health_path":"/health","options":[{"key":"workers","flag":"--workers","target":"launch","kind":{"type":"integer","min":1,"max":8}},{"key":"temperature","target":"request","kind":{"type":"number","min":0,"max":2}}]})).unwrap()
    }
    #[test]
    fn manifest_rejects_unsupported_versions_bindings_and_managed_overrides() {
        let good = example();
        validate_manifest(&good).unwrap();
        let mut bad = good.clone();
        bad.adapter_version = 2;
        assert!(validate_manifest(&bad).unwrap_err().contains("version"));
        let mut bad = good.clone();
        bad.launch.args.push("{future_binding}".into());
        assert!(validate_manifest(&bad).unwrap_err().contains("binding"));
        let mut bad = good.clone();
        bad.options[0].flag = Some("--port".into());
        assert!(validate_manifest(&bad).unwrap_err().contains("app-owned"));
        let mut bad = good.clone();
        bad.launch.args.push("{api_key}".into());
        assert!(validate_manifest(&bad).unwrap_err().contains("credentials"));
        let mut bad = good.clone();
        bad.probe.args.clear();
        assert!(validate_manifest(&bad).unwrap_err().contains("selected"));
        let mut bad = good;
        bad.health_path = "//external.example/health".into();
        assert!(validate_manifest(&bad).is_err());
    }
    #[test]
    fn external_ids_round_trip_without_promoting_unknown_engines_to_llama() {
        for name in ["custom.strata", "custom.my-engine", "custom.x"] {
            let id = ProviderId::parse(name).unwrap();
            assert!(id.is_custom());
            assert!(!id.is_python());
            assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{name}\""));
            assert_eq!(
                serde_json::from_str::<ProviderId>(&format!("\"{name}\"")).unwrap(),
                id
            );
            let cfg = AppConfig {
                active_provider: name.into(),
                active_runtime: "build-1".into(),
                ..Default::default()
            };
            assert_eq!(super::super::provider_of(&cfg), id);
        }
        for name in [
            "custom.",
            "custom...",
            "custom.X",
            "custom.a/../../",
            "unknown",
            "custom.한국어",
        ] {
            assert!(ProviderId::parse(name).is_none());
        }
    }
    #[test]
    fn options_validate_types_ranges_and_request_changes_keep_launch_identity() {
        let manifest = example();
        for value in [
            serde_json::json!(true),
            serde_json::json!(0),
            serde_json::json!(9),
            serde_json::json!("2"),
        ] {
            assert_eq!(
                option_issues(
                    &manifest,
                    &serde_json::json!({"workers":value})
                        .as_object()
                        .unwrap()
                        .clone()
                )
                .len(),
                1
            );
        }
        let cfg = AppConfig {
            active_provider: "custom.example".into(),
            provider_options: BTreeMap::from([(
                "custom.example".into(),
                serde_json::json!({"workers":2,"temperature":0.5})
                    .as_object()
                    .unwrap()
                    .clone(),
            )]),
            ..Default::default()
        };
        let mut request_changed = cfg.clone();
        request_changed
            .provider_options
            .get_mut("custom.example")
            .unwrap()
            .insert("temperature".into(), serde_json::json!(1.0));
        assert_eq!(
            launch_fingerprint(&manifest, &cfg),
            launch_fingerprint(&manifest, &request_changed)
        );
        request_changed
            .provider_options
            .get_mut("custom.example")
            .unwrap()
            .insert("workers".into(), serde_json::json!(3));
        assert_ne!(
            launch_fingerprint(&manifest, &cfg),
            launch_fingerprint(&manifest, &request_changed)
        );
        assert_eq!(
            expand(
                "--model={model}",
                &AppConfig {
                    active_model: "/synthetic/model with spaces".into(),
                    ..Default::default()
                },
                123,
                "private",
                "served"
            )
            .unwrap(),
            "--model=/synthetic/model with spaces"
        );
    }
}
