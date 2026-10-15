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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Vec<String>>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_layout: Option<super::runtime_command::CommandLayout>,
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
    /// Optional explicit entry-point choices. Legacy manifests without this
    /// field retain their previous template interpretation and serialization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_bindings: Option<LaunchBindings>,
    /// Explicit bridge linkage, passed as literal JSON argv after template
    /// expansion. The bridge, not help parsing, defines how it drives this command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge_command: Option<BridgeCommand>,
    /// A bridge may create model/config copies only in this owned launch directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_resources: Option<super::launch_resources::Request>,
    /// Optional explicit option facts from the adapter (secrecy, unit,
    /// restart, types, constraints) for options its help shows. Manifests
    /// without it keep their exact serialization, help identity and launch
    /// fingerprint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_metadata: Option<super::runtime_metadata::OptionMetadata>,
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
pub struct BridgeCommand {
    pub version: u32,
    pub environment_variable: String,
    pub argv: Vec<String>,
}

/// Literal data: never expand engine paths or tokens as launch templates.
pub fn bridge_environment(m: &RuntimeManifest) -> Result<Option<(String, String)>, String> {
    let Some(link) = &m.bridge_command else {
        return Ok(None);
    };
    let name = &link.environment_variable;
    let canonical_name = name.to_ascii_uppercase();
    if link.version != 1
        || !valid_text(name, 128)
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        || canonical_name.starts_with("AIOLM_")
        || canonical_name.starts_with("LLAMA_BOARD_")
        || m.launch.env.len() >= 64
        || m.probe.env.len() >= 64
        || m.launch
            .env
            .keys()
            .chain(m.probe.env.keys())
            .any(|key| key.eq_ignore_ascii_case(name))
        || link.argv.is_empty()
        || link.argv.len() > 129
        || link
            .argv
            .iter()
            .any(|arg| arg.len() > 32768 || arg.contains('\0'))
        || !Path::new(&link.argv[0]).is_absolute()
        || !m.artifacts.contains(&link.argv[0])
    {
        return Err("invalid or conflicting bridge engine argv contract".into());
    }
    let json = serde_json::to_string(&link.argv).map_err(|e| e.to_string())?;
    if json.len() > 32768 {
        return Err("bridge engine argv exceeds environment limits".into());
    }
    Ok(Some((name.clone(), json)))
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
fn read_registration_record(engine: ProviderId, runtime: &str) -> Result<Registration, String> {
    let registered: Registration = bounded_json(&path(engine, runtime)?)?;
    if registered.manifest.engine_id != engine || registered.manifest.runtime_id != runtime {
        return Err("runtime registration identity mismatch".into());
    }
    Ok(registered)
}
fn read_registration(engine: ProviderId, runtime: &str) -> Result<Registration, String> {
    let registered = read_registration_record(engine, runtime)?;
    validate_manifest(&registered.manifest)?;
    Ok(registered)
}

/// An older option contract can become invalid without making its stored
/// registration disappear. Expose a non-runnable inventory entry for review
/// or removal; executable/probe/launch reads still require the strict check.
fn registration_for_inventory(mut registered: Registration) -> Result<Registration, String> {
    if let Err(error) = validate_manifest(&registered.manifest) {
        let mut base = registered.manifest.clone();
        base.options.clear();
        base.option_metadata = None;
        validate_manifest(&base)?;
        registered.manifest = base;
        registered.error = Some(format!("runtime options need review: {error}"));
    }
    Ok(registered)
}
pub fn manifest(engine: ProviderId, runtime: &str) -> Result<RuntimeManifest, String> {
    Ok(read_registration(engine, runtime)?.manifest)
}
/// The exact bytes a registration is stored as, refused when the reader
/// (`bounded_json`) could not read them back. Nothing is written then.
fn record_bytes(registered: &Registration) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec_pretty(registered).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err(format!(
            "the runtime registration record would be {} KiB; registrations are limited to {} KiB. Shorten the manifest's options or option metadata",
            bytes.len().div_ceil(1024),
            LIMIT / 1024
        ));
    }
    Ok(bytes)
}
fn save(registered: &Registration) -> Result<(), String> {
    let target = path(
        registered.manifest.engine_id,
        &registered.manifest.runtime_id,
    )?;
    let bytes = record_bytes(registered)?;
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::config::atomic_write(&target, &bytes)
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
    if let Some(resources) = &m.launch_resources {
        resources.validate()?;
        if m.launch
            .env
            .keys()
            .any(|name| name.eq_ignore_ascii_case(&resources.directory_env))
            || m.bridge_command.as_ref().is_some_and(|bridge| {
                bridge
                    .environment_variable
                    .eq_ignore_ascii_case(&resources.directory_env)
            })
        {
            return Err("launch resource variable conflicts with adapter environment".into());
        }
    }
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
    bridge_environment(m)?;
    if let Some(bindings) = &m.launch_bindings {
        validate_launch_bindings(bindings, &m.launch.args)?;
    }
    if let Some(layout) = &m.command_layout {
        layout.validate(&launch_prefix(m))?;
    }
    if let Some(metadata) = &m.option_metadata {
        metadata.validate(m.engine_id)?;
    }
    let size = serde_json::to_vec(m).map_err(|e| e.to_string())?.len() as u64;
    if size > LIMIT {
        return Err(format!(
            "the runtime manifest is {} KiB; registrations are limited to {} KiB",
            size.div_ceil(1024),
            LIMIT / 1024
        ));
    }
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
    let (bound_flags, _) = bound_launch_flags(m);
    let mut keys = std::collections::BTreeSet::new();
    for option in &m.options {
        if let Some(scope) = &option.scope {
            let actual =
                super::runtime_command::scope(m.command_layout.as_ref(), &launch_prefix(m))?;
            if !super::runtime_options::valid_scope(scope) || !actual.starts_with(scope) {
                return Err("adapter option scope is outside its declared command layout".into());
            }
        }
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
                || bound_flags.iter().any(|(bound, _)| bound == flag)
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
fn manifest_keys(manifest: &RuntimeManifest) -> Vec<String> {
    manifest
        .options
        .iter()
        .map(|option| option.key.clone())
        .collect()
}

/// Every problem with saved options: manifest options by their declared kind,
/// everything else against the runtime's accepted help. Values are reported,
/// never removed.
pub fn saved_option_issues(
    cfg: &AppConfig,
    m: &RuntimeManifest,
    values: &Map<String, Value>,
) -> Vec<super::options::OptionIssue> {
    let keys = manifest_keys(m);
    let declared: Map<String, Value> = values
        .iter()
        .filter(|(key, _)| keys.contains(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    // Common GUI/import values carry occurrence and spelling records. The
    // scalar-only legacy validator must not reject that storage envelope;
    // the effective schema below validates its type, arity, order and facts.
    let structured_launch = |key: &str, value: &Value| {
        serde_json::from_value::<super::runtime_options::Override>(value.clone()).is_ok()
            && m.options.iter().any(|option| {
                // JSON values are already objects in the legacy contract;
                // retain its whole-record 64 KiB check for both shapes.
                option.key == key && option.target == "launch" && option.kind["type"] != "json"
            })
    };
    let scalar = declared
        .iter()
        .filter(|(key, value)| !structured_launch(key, value))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let mut issues = option_issues(m, &scalar);
    // max_len is an existing manifest text limit beyond the common schema's
    // bounded text policy. Keep applying it to every explicit occurrence.
    for option in m
        .options
        .iter()
        .filter(|option| option.target == "launch" && option.kind["type"] == "text")
    {
        let Some(value) = declared
            .get(&option.key)
            .filter(|value| structured_launch(&option.key, value))
        else {
            continue;
        };
        if let Ok(value) = serde_json::from_value::<super::runtime_options::Override>(value.clone())
        {
            let max = option.kind["max_len"].as_u64().unwrap_or(0) as usize;
            if value
                .occurrences
                .iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|text| text.len() > max)
            {
                issues.push(super::options::OptionIssue {
                    key: option.key.clone(),
                    code: "type",
                    message: format!("{} exceeds its declared text length limit", option.key),
                });
            }
        }
    }
    let reported = issues.iter().map(|issue| issue.key.clone()).collect();
    issues.extend(super::runtime_schema::saved_issues(
        &root(),
        cfg,
        values,
        &reported,
    ));
    issues
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
    if let Some((name, value)) = bridge_environment(m)? {
        command.env(name, value);
    }
    if let Some(cwd) = &m.probe.working_directory {
        command.current_dir(cwd);
    } else if let Some(cwd) = &m.launch.working_directory {
        command.current_dir(cwd);
    } else if path(m.engine_id, &m.runtime_id)?.is_file() {
        if let Some(cwd) = super::execution_context::directory(cfg, None)? {
            command.current_dir(cwd);
        }
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
    register_manifest(manifest, cancel).await
}

/// Register a validated manifest: hash its program, probe and artifacts, run
/// the model-independent probe and publish atomically.
pub async fn register_manifest(
    manifest: RuntimeManifest,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<RuntimeManifest, String> {
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
    // A record that cannot be read back is refused before the probe runs;
    // `save` checks the final record again with the probe result.
    record_bytes(&r)?;
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
    // replace an already registered build. The runtime directory may already
    // hold this runtime's reviewed help from an earlier registration, which a
    // re-registration keeps (and re-validates against the new build).
    let directory = target.parent().unwrap().to_path_buf();
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let claim = directory.join(".registering");
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&claim)
        .map_err(|e| format!("runtime registration collision: {e}"))?;
    let published = if target.exists() {
        Err(
            "runtime ID is already registered; remove its registration before replacing the build"
                .into(),
        )
    } else {
        r.probe = Some(probe);
        save(&r)
    };
    let _ = fs::remove_file(&claim);
    if let Err(error) = published {
        // Removes the directory only when nothing else lives there.
        let _ = fs::remove_dir(&directory);
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
                if let Ok(r) =
                    read_registration_record(id, name).and_then(registration_for_inventory)
                {
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
    let issues = saved_option_issues(cfg, &r.manifest, &values);
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
    // Manifest options and options only the runtime's accepted help
    // describes resolve together through the common schema; unknown keys block
    // launch with their values retained.
    if m.command_layout.is_some() {
        args = super::runtime_schema::assemble_registered_arguments(&root(), cfg, &m, &args)?;
    } else {
        args = super::runtime_schema::registered_arguments(&root(), cfg, &m, &args)?;
    }
    let mut env = m
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
    if let Some((name, value)) = bridge_environment(&m)? {
        env.push((name.into(), value.into()));
    }
    Ok(EngineCommand {
        program: m.launch.program.into(),
        args,
        env,
        working_directory: super::execution_context::directory(
            cfg,
            m.launch.working_directory.map(PathBuf::from),
        )?,
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

/// Explicit option scopes alter command placement. Omitted legacy scopes
/// add nothing to existing help and model-probe identities.
pub fn option_scope_digest(manifest: &RuntimeManifest) -> Option<String> {
    let scoped = manifest
        .options
        .iter()
        .filter(|option| option.scope.is_some())
        .collect::<Vec<_>>();
    (!scoped.is_empty()).then(|| {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&scoped).expect("serializable option scopes"))
        )
    })
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
    let help = super::runtime_schema::launch_identity(&root(), cfg, &manifest_keys(manifest));
    let mut binding = serde_json::json!({"options":values,"help":help,"context":templates.contains("{ctx_size}").then_some(cfg.ctx_size),"parallel":templates.contains("{parallel}").then_some(cfg.parallel)});
    if let Some(launch_bindings) = &manifest.launch_bindings {
        binding["launch_bindings"] =
            serde_json::to_value(launch_bindings).expect("serializable bindings");
    }
    if let Some(digest) = option_scope_digest(manifest) {
        binding["option_scopes"] = digest.into();
    }
    if let Some(layout) = &manifest.command_layout {
        binding["command_layout"] = serde_json::to_value(layout).expect("serializable layout");
    }
    if let Some(bridge) = &manifest.bridge_command {
        binding["bridge_command"] = serde_json::to_value(bridge).expect("serializable bridge");
    }
    if let Some(resources) = &manifest.launch_resources {
        binding["launch_resources"] =
            serde_json::to_value(resources).expect("serializable resources");
    }
    // Declared option facts change what saved values mean; a model probe
    // made under other metadata is not reused.
    if let Some(metadata) = &manifest.option_metadata {
        binding["option_metadata"] = metadata.digest().into();
    }
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

/// The exact launch tokens before the first app-owned binding: interpreter
/// flags (`-I`, `-u`), a script or `-m module`, a subcommand and any static
/// options, kept verbatim. The boundary is the first binding placeholder (or
/// the flag that introduces it), never a guess at the first dash. Help for
/// the launch program must be asked through this same prefix.
pub fn launch_prefix(manifest: &RuntimeManifest) -> Vec<String> {
    if let Some(bindings) = &manifest.launch_bindings {
        return manifest
            .launch
            .args
            .iter()
            .take(bindings.prefix_len)
            .cloned()
            .collect();
    }
    let args = &manifest.launch.args;
    let Some(binding) = args.iter().position(|arg| arg.contains('{')) else {
        return args.clone();
    };
    let boundary = match binding.checked_sub(1) {
        Some(flag)
            if !args[binding].starts_with('-')
                && args[flag].starts_with('-')
                && !args[flag].contains('{') =>
        {
            flag
        }
        _ => binding,
    };
    args[..boundary].to_vec()
}

/// Flags and positional slots the launch template fills from app-owned
/// bindings (`{model}`, `{port}`, ...). Generic options must never set them,
/// whatever spelling help documents for them.
/// Returns (flag, binding name) pairs and whether any binding is positional.
pub fn bound_launch_flags(manifest: &RuntimeManifest) -> (Vec<(String, String)>, bool) {
    if let Some(bindings) = &manifest.launch_bindings {
        let flags = bindings
            .bindings
            .iter()
            .filter_map(|bound| match &bound.argument {
                ArgBinding::Flag { flag, .. } => Some((flag.clone(), bound.name.clone())),
                ArgBinding::Positional => None,
            })
            .collect();
        return (
            flags,
            bindings
                .bindings
                .iter()
                .any(|bound| matches!(bound.argument, ArgBinding::Positional)),
        );
    }
    let args = &manifest.launch.args;
    let mut flags = Vec::new();
    let mut positional = false;
    for (index, arg) in args.iter().enumerate() {
        let Some(binding) = arg
            .split_once('{')
            .and_then(|(_, rest)| rest.split_once('}'))
            .map(|(name, _)| name.to_owned())
        else {
            continue;
        };
        if arg.starts_with('-') {
            if let Some((flag, _)) = arg.split_once('=') {
                flags.push((flag.to_owned(), binding));
                continue;
            }
        }
        match index.checked_sub(1).map(|i| &args[i]) {
            Some(previous) if previous.starts_with('-') && !previous.contains('{') => {
                flags.push((previous.clone(), binding));
            }
            _ => positional = true,
        }
    }
    (flags, positional)
}

/// How a launch argument receives an app-owned value. Every binding is an
/// explicit user choice confirmed against the engine's help; none is guessed.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArgBinding {
    /// `--flag value`, or `--flag=value` when `equals` is set.
    Flag {
        flag: String,
        #[serde(default)]
        equals: bool,
    },
    /// A positional argument directly after the entry prefix.
    Positional,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchBindings {
    pub version: u32,
    /// An explicit wrapper boundary after all app-owned bindings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_separator: Option<String>,
    /// Boundary in launch.args; the chosen prefix tokens are stored once.
    pub prefix_len: usize,
    pub bindings: Vec<BoundArgument>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoundArgument {
    pub name: String,
    pub argument: ArgBinding,
}

fn validate_launch_bindings(bindings: &LaunchBindings, args: &[String]) -> Result<(), String> {
    if bindings.version != 1
        || bindings.prefix_len > args.len()
        || bindings.prefix_len > 128
        || bindings.bindings.is_empty()
        || bindings.bindings.len() > 4
    {
        return Err("invalid entry-point binding metadata version or bounds".into());
    }
    let prefix = &args[..bindings.prefix_len];
    if prefix
        .iter()
        .any(|token| token.len() > 32768 || token.contains(['\0', '{']))
    {
        return Err("entry-point binding prefix must contain bounded literal arguments".into());
    }
    let mut expected = prefix.to_vec();
    let mut names = std::collections::BTreeSet::new();
    let mut flags = std::collections::BTreeSet::new();
    for bound in &bindings.bindings {
        if !["model", "host", "port", "model_alias"].contains(&bound.name.as_str())
            || !names.insert(&bound.name)
        {
            return Err("invalid or duplicate entry-point binding name".into());
        }
        if let ArgBinding::Flag { flag, .. } = &bound.argument {
            if !flags.insert(flag) {
                return Err("entry-point bindings cannot share a flag".into());
            }
        }
        expected.extend(binding_tokens(
            &bound.argument,
            &format!("{{{}}}", bound.name),
        )?);
    }
    if let Some(separator) = &bindings.options_separator {
        if separator != "--" {
            return Err("entry-point option separator must be --".into());
        }
        expected.push(separator.clone());
    }
    if expected != args {
        return Err("entry-point binding metadata does not match the launch template".into());
    }
    Ok(())
}

/// Where the app's per-session credential goes. Credentials never travel
/// in argv.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthBinding {
    /// The engine accepts no credential; the app gateway still authenticates.
    None,
    /// The engine reads its key from this environment variable.
    Env { name: String },
}

/// The engine itself serves the OpenAI-compatible HTTP API, or a separate
/// bridge program the user selected does and drives the engine.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServingProtocol {
    OpenaiHttp,
    Bridge {
        program: String,
        #[serde(default)]
        prefix: Vec<String>,
        /// Name consumed by this bridge for a JSON array [engine, ...prefix].
        /// Legacy bridge drafts with no prefix may omit this explicit link.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        engine_argv_env: Option<String>,
    },
}

/// Everything an entry-point registration needs, chosen explicitly by the
/// user. Turned into a manifest v1 without adding any value of its own.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntrypointDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_layout: Option<super::runtime_command::CommandLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_separator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_resources: Option<super::launch_resources::Request>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelBinding>,
    pub engine_id: ProviderId,
    pub runtime_id: String,
    pub display_name: String,
    /// The user-selected executable or interpreter.
    pub program: String,
    /// Exact tokens before the bindings: interpreter flags, script or
    /// module, subcommand and static options, verbatim.
    #[serde(default)]
    pub prefix: Vec<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    /// Files whose bytes define this engine (scripts, adapter code). Their
    /// hashes are checked before every probe and launch.
    #[serde(default)]
    pub artifacts: Vec<String>,
    /// Literal, non-secret environment values.
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    pub model: ArgBinding,
    pub port: ArgBinding,
    #[serde(default)]
    pub host: Option<ArgBinding>,
    #[serde(default)]
    pub served_model: Option<ArgBinding>,
    pub auth: AuthBinding,
    pub protocol: ServingProtocol,
    /// The separate model probe that prints the probe JSON contract.
    pub probe: ProcessSpec,
    pub health_path: String,
    #[serde(default)]
    pub health_authenticated: bool,
    pub model_formats: Vec<String>,
    /// The help discovery the bindings were checked against, if any. Help is
    /// not required to register; when given, every binding flag must be one
    /// the help documents.
    #[serde(default)]
    pub help: Option<DraftHelp>,
    /// Explicit adapter option facts, part of the help identity like the
    /// entry itself; omitted from earlier drafts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_metadata: Option<super::runtime_metadata::OptionMetadata>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftHelp {
    pub fingerprint: String,
    pub request: super::runtime_schema::HelpRequest,
}

fn binding_tokens(binding: &ArgBinding, placeholder: &str) -> Result<Vec<String>, String> {
    match binding {
        ArgBinding::Positional => Ok(vec![placeholder.into()]),
        ArgBinding::Flag { flag, equals } => {
            let body = flag.trim_start_matches('-');
            if !flag.starts_with('-')
                || body.is_empty()
                || flag.len() > 128
                || !body
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            {
                return Err(format!("binding flag {flag:?} is not a single option name"));
            }
            Ok(if *equals {
                vec![format!("{flag}={placeholder}")]
            } else {
                vec![flag.clone(), placeholder.into()]
            })
        }
    }
}

/// Launch program, prefix and declared artifacts of an entry point. A bridge
/// serves HTTP and drives the engine, which stays a hash-checked artifact.
struct EntryLaunch {
    program: String,
    prefix: Vec<String>,
    artifacts: Vec<String>,
    bridge_command: Option<BridgeCommand>,
}

fn entry_launch(
    program: &str,
    prefix: &[String],
    artifacts: &[String],
    environment: &BTreeMap<String, String>,
    protocol: &ServingProtocol,
) -> Result<EntryLaunch, String> {
    if prefix
        .iter()
        .chain(environment.values())
        .any(|token| token.contains('{'))
    {
        return Err("entry prefix and literal environment cannot contain {bindings}".into());
    }
    let mut artifacts = artifacts.to_vec();
    let (launch_program, launch_prefix, bridge_command) = match protocol {
        ServingProtocol::OpenaiHttp => (program.to_owned(), prefix.to_vec(), None),
        ServingProtocol::Bridge {
            program: bridge,
            prefix: bridge_prefix,
            engine_argv_env,
        } => {
            if bridge_prefix.iter().any(|token| token.contains('{')) {
                return Err("bridge prefix cannot contain {bindings}".into());
            }
            artifacts.push(program.to_owned());
            if engine_argv_env.is_none() && !prefix.is_empty() {
                return Err("bridge must explicitly receive the engine entry point through a JSON argv environment variable".into());
            }
            let link = engine_argv_env.as_ref().map(|name| BridgeCommand {
                version: 1,
                environment_variable: name.clone(),
                argv: std::iter::once(program.to_owned())
                    .chain(prefix.iter().cloned())
                    .collect(),
            });
            (bridge.clone(), bridge_prefix.clone(), link)
        }
    };
    artifacts.sort();
    artifacts.dedup();
    Ok(EntryLaunch {
        program: launch_program,
        prefix: launch_prefix,
        artifacts,
        bridge_command,
    })
}

/// The part of an entry point help discovery depends on, before any binding
/// is chosen.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntrypointHelp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_layout: Option<super::runtime_command::CommandLayout>,
    pub engine_id: ProviderId,
    pub runtime_id: String,
    pub program: String,
    #[serde(default)]
    pub prefix: Vec<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    pub protocol: ServingProtocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_metadata: Option<super::runtime_metadata::OptionMetadata>,
}

/// A manifest-shaped description of an entry point before registration, used
/// only to derive the same help command the registered engine will have.
pub fn provisional_manifest(entry: &EntrypointHelp) -> Result<RuntimeManifest, String> {
    if !entry.engine_id.is_custom() {
        return Err("entry-point registration requires a custom.* engine ID".into());
    }
    path(entry.engine_id, &entry.runtime_id)?;
    if let Some(metadata) = &entry.option_metadata {
        metadata.validate(entry.engine_id)?;
    }
    let EntryLaunch {
        program,
        prefix: mut args,
        artifacts,
        bridge_command,
    } = entry_launch(
        &entry.program,
        &entry.prefix,
        &entry.artifacts,
        &entry.environment,
        &entry.protocol,
    )?;
    if let Some(layout) = &entry.command_layout {
        layout.validate(&args)?;
    }
    // Bindings follow the prefix in the registered manifest as well, so the
    // entry prefix derived from both is identical.
    let launch_bindings = LaunchBindings {
        version: 1,
        options_separator: None,
        prefix_len: args.len(),
        bindings: vec![BoundArgument {
            name: "model".into(),
            argument: ArgBinding::Positional,
        }],
    };
    args.push("{model}".into());
    let process = ProcessSpec {
        program,
        args,
        env: entry.environment.clone(),
        working_directory: entry.working_directory.clone(),
    };
    validate_process(&process)?;
    Ok(RuntimeManifest {
        command_layout: entry.command_layout.clone(),
        schema_version: VERSION,
        adapter_version: VERSION,
        engine_id: entry.engine_id,
        runtime_id: entry.runtime_id.clone(),
        display_name: entry.runtime_id.clone(),
        platforms: Vec::new(),
        protocol: "openai-v1".into(),
        probe: process.clone(),
        launch: process,
        launch_bindings: Some(launch_bindings),
        bridge_command,
        option_metadata: entry.option_metadata.clone(),
        launch_resources: None,
        options: Vec::new(),
        model_formats: Vec::new(),
        models: Vec::new(),
        artifacts,
        health_path: "/".into(),
        health_authenticated: false,
    })
}

/// Build the manifest an entry-point draft describes, exactly: launch is
/// program + prefix + the chosen bindings; the credential goes to the chosen
/// environment variable; the probe is the user's explicit probe command.
pub fn manifest_from_draft(draft: &EntrypointDraft) -> Result<RuntimeManifest, String> {
    if !draft.engine_id.is_custom() {
        return Err("entry-point registration requires a custom.* engine ID".into());
    }
    let EntryLaunch {
        program,
        prefix: mut args,
        artifacts,
        bridge_command,
    } = entry_launch(
        &draft.program,
        &draft.prefix,
        &draft.artifacts,
        &draft.environment,
        &draft.protocol,
    )?;
    let mut launch_bindings = LaunchBindings {
        version: 1,
        options_separator: draft.options_separator.clone(),
        prefix_len: args.len(),
        bindings: vec![BoundArgument {
            name: "model".into(),
            argument: draft.model.clone(),
        }],
    };
    args.extend(binding_tokens(&draft.model, "{model}")?);
    if let Some(host) = &draft.host {
        launch_bindings.bindings.push(BoundArgument {
            name: "host".into(),
            argument: host.clone(),
        });
        args.extend(binding_tokens(host, "{host}")?);
    }
    launch_bindings.bindings.push(BoundArgument {
        name: "port".into(),
        argument: draft.port.clone(),
    });
    args.extend(binding_tokens(&draft.port, "{port}")?);
    if let Some(alias) = &draft.served_model {
        launch_bindings.bindings.push(BoundArgument {
            name: "model_alias".into(),
            argument: alias.clone(),
        });
        args.extend(binding_tokens(alias, "{model_alias}")?);
    }
    if let Some(separator) = &draft.options_separator {
        args.push(separator.clone());
    }
    let mut env = draft.environment.clone();
    if let AuthBinding::Env { name } = &draft.auth {
        if env.insert(name.clone(), "{api_key}".into()).is_some() {
            return Err(format!("{name} is both a literal value and the credential"));
        }
    }
    let manifest = RuntimeManifest {
        command_layout: draft.command_layout.clone(),
        schema_version: VERSION,
        adapter_version: VERSION,
        engine_id: draft.engine_id,
        runtime_id: draft.runtime_id.clone(),
        display_name: draft.display_name.clone(),
        // Registration happens on, and declares, this machine only.
        platforms: vec![Platform {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
        }],
        protocol: "openai-v1".into(),
        probe: draft.probe.clone(),
        launch: ProcessSpec {
            program,
            args,
            env,
            working_directory: draft.working_directory.clone(),
        },
        options: Vec::new(),
        model_formats: draft.model_formats.clone(),
        launch_bindings: Some(launch_bindings),
        bridge_command,
        option_metadata: draft.option_metadata.clone(),
        launch_resources: draft.launch_resources.clone(),
        models: draft.models.clone(),
        artifacts,
        health_path: draft.health_path.clone(),
        health_authenticated: draft.health_authenticated,
    };
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Every binding flag must be an option the discovered help documents, so a
/// typo or a guessed spelling cannot become the model/port/host binding.
pub fn check_draft_against_help(
    draft: &EntrypointDraft,
    schema: &super::runtime_options::OptionSchema,
) -> Result<(), String> {
    let documented = |flag: &str| {
        schema
            .options
            .iter()
            .any(|option| option.spellings.iter().any(|s| s.flag == flag))
    };
    for (name, binding) in [
        ("model", Some(&draft.model)),
        ("port", Some(&draft.port)),
        ("host", draft.host.as_ref()),
        ("served model", draft.served_model.as_ref()),
    ] {
        match binding {
            Some(ArgBinding::Flag { flag, .. }) if !documented(flag) => {
                return Err(format!(
                    "the {name} binding {flag} is not an option the discovered help documents"
                ))
            }
            Some(ArgBinding::Positional)
                if !schema.options.iter().any(|option| option.position.is_some()) =>
            {
                return Err(format!(
                    "the {name} binding is positional but the discovered help documents no positional argument"
                ))
            }
            _ => {}
        }
    }
    Ok(())
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
        assert!(serde_json::to_value(&good)
            .unwrap()
            .get("launch_bindings")
            .is_none());
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
    fn manifest_options_cannot_replace_arbitrarily_named_template_bindings() {
        for args in [
            vec!["--weights", "{model}", "--listen", "{port}"],
            vec!["--weights={model}", "--listen={port}"],
        ] {
            for flag in ["--weights", "--listen"] {
                let mut manifest = example();
                manifest.launch.args = args.iter().map(|arg| (*arg).into()).collect();
                manifest.options[0].flag = Some(flag.into());
                let error = validate_manifest(&manifest)
                    .expect_err("generic options must not replace the selected model or app port");
                assert!(error.contains("app-owned"), "{error}");
            }
        }
        // The binding names do not prevent unrelated options in the same engine.
        let mut manifest = example();
        manifest.launch.args = vec!["--weights={model}".into(), "--listen={port}".into()];
        validate_manifest(&manifest).unwrap();
    }
    #[test]
    fn invalid_old_option_contracts_remain_visible_for_inventory_recovery() {
        let mut manifest = example();
        manifest.launch.args = vec!["--weights={model}".into(), "--listen={port}".into()];
        manifest.options[0].flag = Some("--weights".into());
        assert!(validate_manifest(&manifest).is_err());
        let record: Registration = serde_json::from_value(serde_json::json!({
            "manifest":manifest,"executable_sha256":"a".repeat(64),"probe_sha256":"b".repeat(64)
        }))
        .unwrap();
        let view = registration_for_inventory(record).unwrap();
        assert_eq!(view.manifest.engine_id, manifest.engine_id);
        assert_eq!(view.manifest.runtime_id, manifest.runtime_id);
        assert!(view.manifest.options.is_empty());
        assert!(view.error.as_ref().unwrap().contains("app-owned"));
        // A malformed launch contract is still rejected, not downgraded to
        // a runnable or supported registration by the inventory fallback.
        let mut invalid = view;
        invalid.manifest.launch.args.clear();
        assert!(registration_for_inventory(invalid).is_err());
    }
    fn positional_draft() -> EntrypointDraft {
        let base = example();
        serde_json::from_value(serde_json::json!({
            "engine_id":base.engine_id,"runtime_id":"positional-1","display_name":"Positional engine",
            "program":base.launch.program,"prefix":["--server"],
            "model":{"kind":"positional"},"port":{"kind":"flag","flag":"--listen"},
            "auth":{"kind":"none"},"protocol":{"kind":"openai_http"},
            "probe":base.probe,"health_path":"/health","model_formats":["unknown"]
        }))
        .unwrap()
    }

    #[test]
    fn explicit_positional_model_keeps_the_static_boolean_entry_prefix() {
        let draft = positional_draft();
        let manifest = manifest_from_draft(&draft).unwrap();
        for manifest in [
            manifest.clone(),
            serde_json::from_value(serde_json::to_value(&manifest).unwrap()).unwrap(),
        ] {
            assert_eq!(launch_prefix(&manifest), ["--server"]);
            let (flags, positional) = bound_launch_flags(&manifest);
            assert!(positional);
            assert_eq!(flags, [("--listen".into(), "port".into())]);
        }
    }

    #[test]
    fn bridge_keeps_engine_argv_literal_and_requires_an_explicit_link() {
        let mut draft = positional_draft();
        let engine = draft.program.clone();
        draft.prefix = vec![
            "-m".into(),
            "synthetic.engine".into(),
            "한글 path ; &".into(),
            "".into(),
        ];
        let bridge = example().probe.program;
        draft.protocol = ServingProtocol::Bridge {
            program: bridge.clone(),
            prefix: vec!["--http".into()],
            engine_argv_env: None,
        };
        assert!(manifest_from_draft(&draft)
            .unwrap_err()
            .contains("explicitly receive"));
        draft.protocol = ServingProtocol::Bridge {
            program: bridge.clone(),
            prefix: vec!["--http".into()],
            engine_argv_env: Some("BRIDGE_ENGINE_ARGV".into()),
        };
        let manifest = manifest_from_draft(&draft).unwrap();
        assert_eq!(manifest.launch.program, bridge);
        assert_eq!(launch_prefix(&manifest), ["--http"]);
        let (name, json) = bridge_environment(&manifest).unwrap().unwrap();
        assert_eq!(name, "BRIDGE_ENGINE_ARGV");
        let expected = std::iter::once(engine)
            .chain(draft.prefix.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&json).unwrap(),
            expected
        );
        let request = super::super::runtime_schema::HelpRequest {
            working_directory: None,
            program: None,
            args: vec!["--http".into(), "--help".into()],
            scope: vec![],
        };
        let help =
            super::super::runtime_schema::manifest_help_command(&manifest, &request).unwrap();
        assert_eq!(help.environment.get(&name), Some(&json));
        assert_eq!(help.args, request.args);
        assert!(manifest.artifacts.contains(&draft.program));

        let mut changed = manifest.clone();
        changed
            .bridge_command
            .as_mut()
            .unwrap()
            .argv
            .push("changed".into());
        assert_ne!(
            launch_fingerprint(&manifest, &AppConfig::default()),
            launch_fingerprint(&changed, &AppConfig::default())
        );
        for invalid in [
            "AIOLM_HOME",
            "aiolm_home",
            "LLAMA_BOARD_HOME",
            "llama_board_home",
            "bad-name",
            "",
        ] {
            let mut changed = manifest.clone();
            changed
                .bridge_command
                .as_mut()
                .unwrap()
                .environment_variable = invalid.into();
            assert!(validate_manifest(&changed).is_err());
        }
        for probe in [true, false] {
            let mut changed = manifest.clone();
            let env = if probe {
                &mut changed.probe.env
            } else {
                &mut changed.launch.env
            };
            env.insert("bridge_engine_argv".into(), "collision".into());
            assert!(validate_manifest(&changed).is_err());
        }
        let mut changed = manifest.clone();
        changed.bridge_command.as_mut().unwrap().version = 2;
        assert!(validate_manifest(&changed).is_err());
        let mut changed = manifest.clone();
        changed.bridge_command.as_mut().unwrap().argv[0] = "undeclared".into();
        assert!(validate_manifest(&changed).is_err());
        let mut changed = manifest;
        changed.bridge_command.as_mut().unwrap().argv[1] = "\0".into();
        assert!(validate_manifest(&changed).is_err());
        // Legacy direct manifests keep their old JSON contract.
        assert!(serde_json::to_value(example())
            .unwrap()
            .get("bridge_command")
            .is_none());
    }

    #[test]
    fn explicit_binding_metadata_must_match_the_template_and_reprobes_on_changed_choices() {
        let manifest = manifest_from_draft(&positional_draft()).unwrap();
        let mut changed = manifest.clone();
        changed.launch_bindings.as_mut().unwrap().prefix_len = 0;
        assert!(validate_manifest(&changed)
            .unwrap_err()
            .contains("launch template"));
        let mut future = manifest.clone();
        future.launch_bindings.as_mut().unwrap().version = 2;
        assert!(validate_manifest(&future)
            .unwrap_err()
            .contains("metadata version"));
        let mut renamed = manifest.clone();
        renamed.launch_bindings.as_mut().unwrap().bindings[0].name = "guessed_model".into();
        assert!(validate_manifest(&renamed)
            .unwrap_err()
            .contains("binding name"));
        // The same argv can have two explicitly different meanings: static
        // boolean + positional, or a flag binding. Changing the choice must
        // invalidate readiness even though the executable/argv bytes match.
        let mut other_choice = manifest.clone();
        let bindings = other_choice.launch_bindings.as_mut().unwrap();
        bindings.prefix_len = 0;
        bindings.bindings[0].argument = ArgBinding::Flag {
            flag: "--server".into(),
            equals: false,
        };
        validate_manifest(&other_choice).unwrap();
        assert_eq!(manifest.launch.args, other_choice.launch.args);
        let mut duplicate = other_choice.clone();
        duplicate.launch_bindings.as_mut().unwrap().bindings[1].argument = ArgBinding::Flag {
            flag: "--server".into(),
            equals: false,
        };
        duplicate.launch.args[2] = "--server".into();
        assert!(validate_manifest(&duplicate)
            .unwrap_err()
            .contains("share a flag"));
        let mut oversized = manifest.clone();
        oversized.launch_bindings.as_mut().unwrap().prefix_len = 129;
        assert!(validate_manifest(&oversized)
            .unwrap_err()
            .contains("bounds"));
        let mut duplicate_name = manifest.clone();
        duplicate_name.launch_bindings.as_mut().unwrap().bindings[1].name = "model".into();
        assert!(validate_manifest(&duplicate_name)
            .unwrap_err()
            .contains("duplicate"));
        let cfg = AppConfig {
            active_provider: manifest.engine_id.as_str().into(),
            active_runtime: manifest.runtime_id.clone(),
            ..Default::default()
        };
        assert_ne!(
            launch_fingerprint(&manifest, &cfg),
            launch_fingerprint(&other_choice, &cfg)
        );
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
    #[test]
    fn launch_template_defines_entry_prefix_and_app_owned_bindings() {
        let mut manifest = example();
        manifest.launch.args = vec![
            "C:/synthetic/server script.py".into(),
            "serve".into(),
            "--model".into(),
            "{model}".into(),
            "--listen={host}".into(),
            "-p".into(),
            "{port}".into(),
            "{model_alias}".into(),
        ];
        assert_eq!(
            launch_prefix(&manifest),
            vec!["C:/synthetic/server script.py".to_string(), "serve".into()]
        );
        let (flags, positional) = bound_launch_flags(&manifest);
        assert_eq!(
            flags,
            vec![
                ("--model".to_string(), "model".to_string()),
                ("--listen".into(), "host".into()),
                ("-p".into(), "port".into())
            ]
        );
        assert!(positional);
        // Interpreter flags, a module or script and static options before the
        // first binding stay part of the exact entry prefix.
        manifest.launch.args = vec![
            "-I".into(),
            "-u".into(),
            "C:/synthetic/한글 dir/serve.py".into(),
            "--static".into(),
            "--model".into(),
            "{model}".into(),
        ];
        assert_eq!(
            launch_prefix(&manifest),
            ["-I", "-u", "C:/synthetic/한글 dir/serve.py", "--static"]
        );
        manifest.launch.args = vec!["-m".into(), "synthetic.server".into(), "{model}".into()];
        assert_eq!(launch_prefix(&manifest), ["-m", "synthetic.server"]);
        manifest.launch.args = vec!["--model={model}".into()];
        assert!(launch_prefix(&manifest).is_empty());
    }
}
