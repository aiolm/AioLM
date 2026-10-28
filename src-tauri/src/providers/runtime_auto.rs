//! Application-owned automatic connection. Discovery is evidence, not readiness.
//! A running service is attached through an owned proxy; its process is never
//! adopted or stopped. All executable languages use the same process contract.
use super::{registry, runtime_auto_probe as probe, runtime_discovery as discovery, ProviderId};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

pub const INTERNAL: &str = "--internal-runtime-auto";
const KEY_ENV: &str = "AIO_CONNECT_KEY";
const SPEC_LIMIT: u64 = 262_144;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelChoice {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreparedConnection {
    pub kind: String,
    pub models: Vec<ModelChoice>,
    pub candidate: discovery::RuntimeCandidate,
    pub detail: String,
    pub base_url: Option<String>,
    /// Opaque application-owned preparation token, never executable metadata.
    pub plan: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectedRuntime {
    pub engine_id: ProviderId,
    pub runtime_id: String,
    pub display_name: String,
    pub model_path: String,
    pub mode: String,
    pub checks: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Target {
    Attached {
        base_url: String,
    },
    Managed {
        launch: registry::ProcessSpec,
        artifacts: Vec<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionSpec {
    version: u32,
    engine_id: ProviderId,
    runtime_id: String,
    target: Target,
    model_path: String,
    upstream_model: Option<String>,
}
#[derive(Default)]
struct Inventory {
    candidates: BTreeMap<String, discovery::RuntimeCandidate>,
    preparations: BTreeMap<String, (PreparedConnection, Target)>,
}
static INVENTORY: OnceLock<Mutex<Inventory>> = OnceLock::new();
static CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();
fn inventory() -> &'static Mutex<Inventory> {
    INVENTORY.get_or_init(Mutex::default)
}
pub fn cancellation() -> Arc<AtomicBool> {
    CANCEL
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone()
}
pub fn cancel() {
    cancellation().store(true, Ordering::Release);
}
fn check_cancel() -> Result<(), String> {
    if cancellation().load(Ordering::Acquire) {
        Err("automatic connection cancelled".into())
    } else {
        Ok(())
    }
}

pub async fn discover(folder: Option<&Path>) -> Result<discovery::DiscoveryReport, String> {
    let cancel = cancellation();
    let folder = folder.map(Path::to_path_buf);
    let worker_cancel = cancel.clone();
    let mut report =
        tokio::task::spawn_blocking(move || discovery::discover(folder.as_deref(), &worker_cancel))
            .await
            .map_err(|e| e.to_string())??;
    // A general TCP listener is not a model server. Only an actual standard
    // model-list response is offered as a running connection candidate.
    use futures_util::{stream, StreamExt};
    let candidates = std::mem::take(&mut report.candidates);
    report.candidates = stream::iter(candidates)
        .map(|candidate| async move {
            // The application's own API is already managed here; attaching it
            // as an external engine would create a circular connection.
            if candidate.pid == Some(std::process::id()) {
                return None;
            }
            if candidate.endpoints.is_empty() {
                return Some(candidate);
            }
            for endpoint in &candidate.endpoints {
                if cancellation().load(Ordering::Acquire) {
                    return None;
                }
                let host = if endpoint.host.contains(':') {
                    format!("[{}]", endpoint.host)
                } else {
                    endpoint.host.clone()
                };
                if probe::inspect_endpoint(&format!("http://{host}:{}/v1", endpoint.port), None)
                    .await
                    .is_ok()
                {
                    return Some(candidate);
                }
            }
            None
        })
        .buffered(8)
        .filter_map(|candidate| async move { candidate })
        .collect()
        .await;
    check_cancel()?;
    let mut state = inventory()
        .lock()
        .map_err(|_| "automatic discovery lock poisoned")?;
    state.candidates = report
        .candidates
        .iter()
        .cloned()
        .map(|candidate| (candidate.id.clone(), candidate))
        .collect();
    state.preparations.clear();
    Ok(report)
}

fn known_candidate(
    candidate: &discovery::RuntimeCandidate,
) -> Result<discovery::RuntimeCandidate, String> {
    let state = inventory()
        .lock()
        .map_err(|_| "automatic discovery lock poisoned")?;
    let known = state
        .candidates
        .get(&candidate.id)
        .ok_or("find the installation again before connecting")?;
    // The renderer cannot replace captured argv, PID, endpoint or file evidence.
    if serde_json::to_value(known).ok() != serde_json::to_value(candidate).ok() {
        return Err("discovered installation changed; find it again".into());
    }
    Ok(known.clone())
}

pub async fn inspect(
    candidate: &discovery::RuntimeCandidate,
    local_models: Vec<ModelChoice>,
) -> Result<PreparedConnection, String> {
    let candidate = known_candidate(candidate)?;
    discovery::revalidate(&candidate)?;
    let mut found = Vec::new();
    for endpoint in &candidate.endpoints {
        check_cancel()?;
        let base = format!(
            "http://{}:{}/v1",
            if endpoint.host.contains(':') {
                format!("[{}]", endpoint.host)
            } else {
                endpoint.host.clone()
            },
            endpoint.port
        );
        if let Ok(info) = probe::inspect_endpoint(&base, None).await {
            found.push(info);
        }
    }
    check_cancel()?;
    // A dual-stack listener can expose the same API on IPv4 and IPv6. Keep
    // distinct ports/identities separate, but do not reject this ordinary case.
    let mut seen = std::collections::BTreeSet::new();
    found.retain(|info| {
        let port = reqwest::Url::parse(&info.base_url)
            .ok()
            .and_then(|url| url.port_or_known_default());
        let models = info
            .models
            .iter()
            .map(|model| model.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        seen.insert((port, models))
    });
    if found.len() > 1 {
        return Err(
            "more than one model API belongs to this process; select a single server installation"
                .into(),
        );
    }
    let (kind, models, detail, base_url, target) = if let Some(endpoint) = found.pop() {
        let models = endpoint
            .models
            .into_iter()
            .map(|model| ModelChoice {
                name: model.id.clone(),
                id: model.id,
            })
            .collect();
        (
            "attached",
            models,
            "The running server stays under your control. AioLM disconnects without stopping it.",
            Some(endpoint.base_url.clone()),
            Target::Attached {
                base_url: endpoint.base_url,
            },
        )
    } else {
        let plan = super::runtime_auto_plan::plan_with_cancel(&candidate, &cancellation())?;
        let launch = plan.launch()?;
        ("managed",local_models,"AioLM will test this installation with the selected model, then manage its own serving process.",None,Target::Managed {launch,artifacts:plan.artifacts.clone()})
    };
    let prepared = PreparedConnection {
        kind: kind.into(),
        models,
        candidate,
        detail: detail.into(),
        base_url,
        plan: uuid::Uuid::new_v4().to_string(),
    };
    let mut state = inventory()
        .lock()
        .map_err(|_| "automatic discovery lock poisoned")?;
    if state.preparations.len() >= 128 {
        state.preparations.clear();
    }
    state
        .preparations
        .insert(prepared.plan.clone(), (prepared.clone(), target));
    Ok(prepared)
}

fn read_spec(path: &Path) -> Result<ConnectionSpec, String> {
    let file =
        fs::File::open(path).map_err(|e| format!("cannot read automatic connection: {e}"))?;
    let mut bytes = Vec::new();
    file.take(SPEC_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SPEC_LIMIT {
        return Err("automatic connection exceeds its limit".into());
    }
    let spec: ConnectionSpec = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if spec.version != 1 || !spec.engine_id.is_custom() || spec.model_path.is_empty() {
        return Err("invalid automatic connection".into());
    }
    Ok(spec)
}

fn encoded_spec_path(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or("automatic connection path must be Unicode")?;
    if !path.is_absolute() || text.is_empty() || text.len() > 32768 || text.contains('\0') {
        return Err("invalid automatic connection path".into());
    }
    // Registry argv templates reserve braces. Encode the literal metadata path
    // so Unicode, braces and equals signs are never interpreted as bindings.
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text.as_bytes()))
}

fn decoded_spec_path(encoded: &str) -> Result<PathBuf, String> {
    if encoded.len() > 43_691 {
        return Err("automatic connection address exceeds its limit".into());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid automatic connection address")?;
    let text = String::from_utf8(bytes).map_err(|_| "invalid automatic connection path")?;
    let path = PathBuf::from(text);
    encoded_spec_path(&path)?;
    Ok(path)
}

/// Recognize only the complete app-generated helper contract. This also lets
/// a later trusted app/CLI build revalidate its own helper without changing
/// the external installation or its captured file hashes.
pub(crate) fn is_owned_manifest(manifest: &registry::RuntimeManifest) -> bool {
    let Some(suffix) = manifest.engine_id.as_str().strip_prefix("custom.auto-") else {
        return false;
    };
    if suffix.len() != 16
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || manifest.runtime_id != format!("connection-{suffix}")
        || registry::validate_manifest(manifest).is_err()
        || manifest.schema_version != 1
        || manifest.adapter_version != 1
        || manifest.protocol != "openai-v1"
        || manifest.model_formats != ["unknown"]
        || manifest.health_path != "/health"
        || manifest.health_authenticated
        || manifest.platforms
            != [registry::Platform {
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
            }]
    {
        return false;
    }
    let directory = registry::root()
        .join(manifest.engine_id.as_str())
        .join(&manifest.runtime_id);
    let expected = directory
        .join("connection.json")
        .to_string_lossy()
        .into_owned();
    let Ok(address) = encoded_spec_path(Path::new(&expected)) else {
        return false;
    };
    let probe = vec![
        INTERNAL.to_owned(),
        "probe".into(),
        address.clone(),
        "{model}".into(),
    ];
    let launch = vec![
        INTERNAL.to_owned(),
        "serve".into(),
        address,
        "{model}".into(),
        "{port}".into(),
    ];
    if manifest.probe.args != probe
        || manifest.launch.args != launch
        || manifest.probe.program != manifest.launch.program
        || !manifest.probe.env.is_empty()
        || manifest.probe.working_directory.is_some()
        || manifest.launch.env != BTreeMap::from([(KEY_ENV.into(), "{api_key}".into())])
        || manifest.launch.working_directory.is_some()
        || manifest.models.len() != 1
        || !manifest.artifacts.contains(&expected)
        || !manifest.options.is_empty()
        || manifest.command_layout.is_some()
        || manifest.launch_bindings.is_some()
        || manifest.bridge_command.is_some()
        || manifest.launch_resources.is_some()
        || manifest.option_metadata.is_some()
    {
        return false;
    }
    let Ok(spec) = read_spec(Path::new(&expected)) else {
        return false;
    };
    if spec.engine_id != manifest.engine_id
        || spec.runtime_id != manifest.runtime_id
        || spec.model_path != manifest.models[0].path
    {
        return false;
    }
    let mut expected_artifacts = std::collections::BTreeSet::from([expected.as_str()]);
    match &spec.target {
        Target::Attached { base_url } => {
            if probe::normalize_base_url(base_url).as_ref() != Ok(base_url)
                || spec.model_path != directory.join("model-reference.json").to_string_lossy()
                || !spec.upstream_model.as_deref().is_some_and(|model| {
                    !model.trim().is_empty()
                        && model.len() <= 2048
                        && !model.chars().any(char::is_control)
                })
            {
                return false;
            }
        }
        Target::Managed { launch, artifacts } => {
            if spec.upstream_model.is_some()
                || !Path::new(&launch.program).is_absolute()
                || !launch.env.is_empty()
                || !launch.args.iter().any(|arg| has_binding(arg, "{model}"))
                || !launch.args.iter().any(|arg| has_binding(arg, "{port}"))
                || !launch.args.iter().any(|arg| has_binding(arg, "{host}"))
                || artifacts.len() > 256
                || artifacts.iter().any(|path| !Path::new(path).is_absolute())
            {
                return false;
            }
            expected_artifacts.insert(&launch.program);
            expected_artifacts.extend(artifacts.iter().map(String::as_str));
        }
    }
    let actual_artifacts = manifest
        .artifacts
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    // A missing source hash must never become trusted merely because a helper
    // was migrated. Additional or duplicate artifacts are not our contract.
    actual_artifacts.len() == manifest.artifacts.len() && actual_artifacts == expected_artifacts
}

pub async fn connect(
    prepared: &PreparedConnection,
    model_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<ConnectedRuntime, String> {
    let (known, target) = inventory()
        .lock()
        .map_err(|_| "automatic discovery lock poisoned")?
        .preparations
        .get(&prepared.plan)
        .cloned()
        .ok_or("find the installation again before connecting")?;
    if serde_json::to_value(&known).ok() != serde_json::to_value(prepared).ok()
        || !known.models.iter().any(|m| m.id == model_id)
    {
        return Err("connection or selected model changed; inspect it again".into());
    }
    check_cancel()?;
    discovery::revalidate(&known.candidate)?;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let engine = ProviderId::parse(&format!("custom.auto-{}", &suffix[..16]))
        .ok_or("cannot allocate connection identity")?;
    let runtime = format!("connection-{}", &suffix[..16]);
    let directory = registry::root().join(engine.as_str()).join(&runtime);
    fs::create_dir_all(directory.parent().unwrap()).map_err(|e| e.to_string())?;
    // Refuse collisions instead of opening or cleaning an older registration.
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let spec_path = directory.join("connection.json");
    let reference = directory.join("model-reference.json");
    let attached = matches!(target, Target::Attached { .. });
    let model_path = if attached {
        reference.to_string_lossy().into_owned()
    } else {
        model_id.into()
    };
    let spec = ConnectionSpec {
        version: 1,
        engine_id: engine,
        runtime_id: runtime.clone(),
        target,
        model_path: model_path.clone(),
        upstream_model: attached.then(|| model_id.into()),
    };
    let result = async {
        if attached {
            crate::config::atomic_write(
                &reference,
                &serde_json::to_vec(
                    &serde_json::json!({"kind":"external-model-reference","model":model_id}),
                )
                .map_err(|e| e.to_string())?,
            )?;
        }
        crate::config::atomic_write(
            &spec_path,
            &serde_json::to_vec(&spec).map_err(|e| e.to_string())?,
        )?;
        let helper = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        let base_args = vec![
            INTERNAL.into(),
            "probe".into(),
            encoded_spec_path(&spec_path)?,
            "{model}".into(),
        ];
        let mut artifacts = vec![spec_path.to_string_lossy().into_owned()];
        if let Target::Managed {
            launch,
            artifacts: source_artifacts,
        } = &spec.target
        {
            artifacts.push(launch.program.clone());
            artifacts.extend(source_artifacts.iter().cloned());
        }
        artifacts.sort();
        artifacts.dedup();
        let manifest = registry::RuntimeManifest {
            schema_version: 1,
            adapter_version: 1,
            engine_id: engine,
            runtime_id: runtime.clone(),
            display_name: known.candidate.display_name.clone(),
            platforms: vec![registry::Platform {
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
            }],
            protocol: "openai-v1".into(),
            probe: registry::ProcessSpec {
                program: helper.clone(),
                args: base_args,
                env: BTreeMap::new(),
                working_directory: None,
            },
            launch: registry::ProcessSpec {
                program: helper,
                args: vec![
                    INTERNAL.into(),
                    "serve".into(),
                    encoded_spec_path(&spec_path)?,
                    "{model}".into(),
                    "{port}".into(),
                ],
                env: BTreeMap::from([(KEY_ENV.into(), "{api_key}".into())]),
                working_directory: None,
            },
            command_layout: None,
            launch_bindings: None,
            bridge_command: None,
            launch_resources: None,
            option_metadata: None,
            options: vec![],
            model_formats: vec!["unknown".into()],
            models: vec![registry::ModelBinding {
                path: model_path.clone(),
                name: known
                    .models
                    .iter()
                    .find(|m| m.id == model_id)
                    .unwrap()
                    .name
                    .clone(),
            }],
            artifacts,
            health_path: "/health".into(),
            health_authenticated: false,
        };
        registry::register_manifest(manifest, Some(cancel.clone())).await?;
        let cfg = crate::config::AppConfig {
            active_provider: engine.as_str().into(),
            active_runtime: runtime.clone(),
            active_model: model_path.clone(),
            ..Default::default()
        };
        registry::refresh(&cfg, Some(cancel)).await?;
        check_cancel()?;
        Ok(ConnectedRuntime {
            engine_id: engine,
            runtime_id: runtime.clone(),
            display_name: known.candidate.display_name.clone(),
            model_path: model_path.clone(),
            mode: known.kind.clone(),
            checks: vec![
                "model-identity".into(),
                "chat-response".into(),
                "sse-stream".into(),
            ],
        })
    }
    .await;
    if result.is_err() {
        // Delete only this attempt's freshly allocated metadata, never engine files.
        let _ = registry::remove(engine, &runtime);
        let _ = fs::remove_file(&spec_path);
        if attached {
            let _ = fs::remove_file(&reference);
        }
        let _ = fs::remove_dir(&directory);
        let _ = fs::remove_dir(directory.parent().unwrap());
    }
    result
}

struct ChildGuard {
    #[cfg(unix)]
    child: std::process::Child,
    #[cfg(windows)]
    child: crate::procutil::OwnedChild,
}
impl ChildGuard {
    fn spawn(command: &mut std::process::Command) -> Result<Self, String> {
        #[cfg(unix)]
        let child = command.spawn();
        #[cfg(windows)]
        let child = crate::procutil::OwnedChild::spawn(command);
        child
            .map(|child| Self { child })
            .map_err(|e| format!("cannot start discovered entry point: {e}"))
    }
    fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, String> {
        self.child.try_wait().map_err(|e| e.to_string())
    }
    fn owns_listener(&self, port: u16) -> bool {
        #[cfg(unix)]
        {
            crate::server::listener_owned_by_child(std::process::id(), port, None)
        }
        #[cfg(windows)]
        {
            crate::server::listener_owned_by_child(
                self.child.id(),
                port,
                self.child.process_handle(),
            )
        }
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        #[cfg(windows)]
        self.child.terminate();
    }
}

fn has_binding(value: &str, token: &str) -> bool {
    value == token
        || value
            .split_once('=')
            .is_some_and(|(flag, binding)| flag.starts_with('-') && binding == token)
}

fn expand(value: &str, model: &str, port: u16, alias: &str) -> Result<String, String> {
    let binding = |token: &str| match token {
        "{model}" => Some(model.to_owned()),
        "{port}" => Some(port.to_string()),
        "{host}" => Some("127.0.0.1".into()),
        "{model_alias}" => Some(alias.into()),
        _ => None,
    };
    if let Some(expanded) = binding(value) {
        return Ok(expanded);
    }
    if let Some((flag, token)) = value.split_once('=') {
        if flag.starts_with('-') {
            if let Some(expanded) = binding(token) {
                return Ok(format!("{flag}={expanded}"));
            }
        }
    }
    Ok(value.into())
}
async fn upstream(
    spec: &ConnectionSpec,
    model: &str,
) -> Result<(String, String, Option<ChildGuard>), String> {
    if model != spec.model_path {
        return Err("selected model differs from automatic connection".into());
    }
    match &spec.target {
        Target::Attached { base_url } => Ok((
            base_url.clone(),
            spec.upstream_model
                .clone()
                .ok_or("missing upstream model")?,
            None,
        )),
        Target::Managed { launch, .. } => {
            let socket =
                std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
            let port = socket.local_addr().map_err(|e| e.to_string())?.port();
            drop(socket);
            let alias = format!("aiolm-{}", spec.runtime_id);
            let aliased = launch
                .args
                .iter()
                .chain(launch.env.values())
                .any(|arg| has_binding(arg, "{model_alias}"));
            let mut command = crate::procutil::std_command(&launch.program);
            command
                .args(
                    launch
                        .args
                        .iter()
                        .map(|arg| expand(arg, model, port, &alias))
                        .collect::<Result<Vec<_>, _>>()?,
                )
                .env_clear()
                .envs(crate::runtime::child_environment());
            for (name, value) in &launch.env {
                command.env(name, expand(value, model, port, &alias)?);
            }
            if let Some(cwd) = &launch.working_directory {
                command.current_dir(cwd);
            }
            command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::inherit());
            // Inherit the helper's owned process group/job. Creating a new group
            // here would let cancellation leave the engine behind.
            let mut child = ChildGuard::spawn(&mut command)?;
            let url = format!("http://127.0.0.1:{port}/v1");
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                if child.try_wait()?.is_some() {
                    return Err("discovered entry point exited before serving a model API; see the engine diagnostics".into());
                }
                if let Ok(info) = probe::inspect_endpoint(&url, None).await {
                    if !child.owns_listener(port) {
                        return Err(
                            "model API listener does not belong to the started process".into()
                        );
                    }
                    if info.models.len() != 1 {
                        return Err("automatic launch requires exactly one served model; its model identity is ambiguous".into());
                    }
                    let expected = if aliased { alias.as_str() } else { model };
                    if info.models[0].id != expected {
                        return Err("the model API did not confirm the selected launch identity; automatic connection remains unverified".into());
                    }
                    return Ok((url, info.models[0].id.clone(), Some(child)));
                }
                if Instant::now() >= deadline {
                    return Err(
                        "discovered entry point did not expose a verified model API in time".into(),
                    );
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

pub fn is_internal(args: &[String]) -> bool {
    args.first().is_some_and(|arg| arg == INTERNAL)
}
pub async fn run_internal(args: &[String]) -> Result<(), String> {
    if !is_internal(args) || !(args.len() == 4 || args.len() == 5) {
        return Err("invalid internal automatic connection command".into());
    }
    let spec = read_spec(&decoded_spec_path(&args[2])?)?;
    let model = &args[3];
    if args[1] == "probe" && model.is_empty() {
        let result = registry::ProbeResult {
            schema_version: 1,
            engine_id: spec.engine_id,
            runtime_id: spec.runtime_id,
            version: "OpenAI v1; binary version unknown".into(),
            accelerator: "unverified".into(),
            model: String::new(),
            model_supported: false,
            served_model: "unselected".into(),
            capabilities: registry::Capabilities {
                tasks: vec![],
                modalities: super::artifacts::Modalities::default(),
                chat: false,
                tools: false,
            },
        };
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if args[1] != "probe" && args[1] != "serve" {
        return Err("unknown internal connection operation".into());
    }
    let (url, upstream_model, mut child) = upstream(&spec, model).await?;
    probe::verify(probe::ProbeRequest {
        base_url: url.clone(),
        model: upstream_model.clone(),
        api_key: None,
    })
    .await?;
    if args[1] == "probe" {
        let result = registry::ProbeResult {
            schema_version: 1,
            engine_id: spec.engine_id,
            runtime_id: spec.runtime_id,
            version: "OpenAI v1; binary version unknown".into(),
            accelerator: "unverified".into(),
            model: model.clone(),
            model_supported: true,
            served_model: upstream_model,
            capabilities: registry::Capabilities {
                tasks: vec!["generate".into()],
                modalities: super::artifacts::Modalities {
                    text: true,
                    image: false,
                    audio: false,
                    video: false,
                },
                chat: true,
                tools: false,
            },
        };
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let port = args
        .get(4)
        .ok_or("missing assigned port")?
        .parse::<u16>()
        .map_err(|_| "invalid assigned port")?;
    // The existing headless CLI uses a private loopback listener without a
    // credential. GUI launches supply their nonempty app-owned key.
    let key = std::env::var(KEY_ENV).unwrap_or_default();
    let serving = super::runtime_auto_proxy::run(super::runtime_auto_proxy::ProxyConfig {
        upstream_base: url,
        model: upstream_model,
        port,
        api_key: key,
        upstream_api_key: None,
    });
    tokio::pin!(serving);
    loop {
        tokio::select! { result=&mut serving=>return result, _=tokio::time::sleep(Duration::from_millis(200))=>{
            if let Some(child)=child.as_mut() {if child.try_wait()?.is_some() {return Err("connected engine exited".into());}}
        }}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    struct Area(PathBuf);
    impl Area {
        fn new() -> Self {
            let path = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("aiolm-auto-contract-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            fs::write(
                path.join(".test-owner"),
                b"synthetic automatic connection fixture",
            )
            .unwrap();
            Self(path)
        }
    }
    impl Drop for Area {
        fn drop(&mut self) {
            if fs::read(self.0.join(".test-owner"))
                .is_ok_and(|bytes| bytes == b"synthetic automatic connection fixture")
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn model_paths_and_literal_braces_are_expanded_once_only() {
        let model = "/synthetic/{port}/모델 {model_alias}=weights.gguf";
        assert_eq!(
            expand("{model}", model, 3210, "selected-alias").unwrap(),
            model
        );
        assert_eq!(
            expand("--model={model}", model, 3210, "selected-alias").unwrap(),
            format!("--model={model}")
        );
        for literal in [
            "/synthetic/{model_alias}/entry",
            "prefix{model}",
            "--literal=prefix{port}",
            "name={host}",
        ] {
            assert_eq!(
                expand(literal, model, 3210, "selected-alias").unwrap(),
                literal
            );
            assert!(!has_binding(literal, "{model_alias}"));
        }
        assert_eq!(
            expand("{port}", model, 3210, "selected-alias").unwrap(),
            "3210"
        );
        assert_eq!(
            expand("--host={host}", model, 3210, "selected-alias").unwrap(),
            "--host=127.0.0.1"
        );
        assert!(has_binding("--alias={model_alias}", "{model_alias}"));
        assert!(has_binding("{model_alias}", "{model_alias}"));
    }

    #[test]
    fn metadata_addresses_preserve_unicode_braces_and_equals_without_templates() {
        let area = Area::new();
        let path = area
            .0
            .join("한글 {model} {api_key}=data")
            .join("connection.json");
        let encoded = encoded_spec_path(&path).unwrap();
        assert!(!encoded.contains(['{', '}', '=', '/', '\\']));
        assert_eq!(decoded_spec_path(&encoded).unwrap(), path);
        assert!(encoded.is_ascii());
    }

    #[test]
    fn malformed_or_unbounded_metadata_addresses_are_rejected() {
        for invalid in ["", "%%%", "YWJj=", "not/a/base64/address"] {
            assert!(decoded_spec_path(invalid).is_err());
        }
        let encode = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        assert!(decoded_spec_path(&encode(b"relative/connection.json")).is_err());
        assert!(decoded_spec_path(&encode(b"/synthetic/\0connection.json")).is_err());
        assert!(decoded_spec_path(&encode(&[0xff, 0xfe])).is_err());
        assert!(decoded_spec_path(&"a".repeat(43_692)).is_err());
        assert!(encoded_spec_path(Path::new("relative/connection.json")).is_err());
    }

    fn attached_spec(directory: &Path) -> ConnectionSpec {
        ConnectionSpec {
            version: 1,
            engine_id: ProviderId::parse("custom.auto-0123456789abcdef").unwrap(),
            runtime_id: "connection-0123456789abcdef".into(),
            target: Target::Attached {
                base_url: "http://127.0.0.1:43121/v1".into(),
            },
            model_path: directory
                .join("model-reference.json")
                .to_string_lossy()
                .into_owned(),
            upstream_model: Some("synthetic-model".into()),
        }
    }

    #[test]
    fn connection_metadata_is_bounded_versioned_and_strictly_parsed() {
        let area = Area::new();
        let path = area.0.join("connection.json");
        let spec = attached_spec(&area.0);
        fs::write(&path, serde_json::to_vec(&spec).unwrap()).unwrap();
        assert_eq!(read_spec(&path).unwrap().runtime_id, spec.runtime_id);
        let mut unknown = serde_json::to_value(&spec).unwrap();
        unknown["unrecognized"] = serde_json::json!(true);
        fs::write(&path, serde_json::to_vec(&unknown).unwrap()).unwrap();
        assert!(read_spec(&path).is_err());
        let mut invalid = spec.clone();
        invalid.version = 2;
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(read_spec(&path).is_err());
        invalid = spec.clone();
        invalid.engine_id = ProviderId::Llama;
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(read_spec(&path).is_err());
        invalid = spec;
        invalid.model_path.clear();
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(read_spec(&path).is_err());
        fs::write(&path, vec![b' '; SPEC_LIMIT as usize + 1]).unwrap();
        assert!(read_spec(&path).unwrap_err().contains("exceeds"));
    }

    fn manifest_for(spec: &ConnectionSpec, helper: &Path) -> registry::RuntimeManifest {
        let path = registry::root()
            .join(spec.engine_id.as_str())
            .join(&spec.runtime_id)
            .join("connection.json");
        let address = encoded_spec_path(&path).unwrap();
        registry::RuntimeManifest {
            schema_version: 1,
            adapter_version: 1,
            engine_id: spec.engine_id,
            runtime_id: spec.runtime_id.clone(),
            display_name: "Synthetic engine".into(),
            platforms: vec![registry::Platform {
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
            }],
            protocol: "openai-v1".into(),
            probe: registry::ProcessSpec {
                program: helper.to_string_lossy().into_owned(),
                args: vec![
                    INTERNAL.into(),
                    "probe".into(),
                    address.clone(),
                    "{model}".into(),
                ],
                env: BTreeMap::new(),
                working_directory: None,
            },
            launch: registry::ProcessSpec {
                program: helper.to_string_lossy().into_owned(),
                args: vec![
                    INTERNAL.into(),
                    "serve".into(),
                    address,
                    "{model}".into(),
                    "{port}".into(),
                ],
                env: BTreeMap::from([(KEY_ENV.into(), "{api_key}".into())]),
                working_directory: None,
            },
            command_layout: None,
            launch_bindings: None,
            bridge_command: None,
            launch_resources: None,
            option_metadata: None,
            options: vec![],
            model_formats: vec!["unknown".into()],
            models: vec![registry::ModelBinding {
                path: spec.model_path.clone(),
                name: "Synthetic model".into(),
            }],
            artifacts: vec![path.to_string_lossy().into_owned()],
            health_path: "/health".into(),
            health_authenticated: false,
        }
    }

    fn record_bytes(manifest: &registry::RuntimeManifest) -> Vec<u8> {
        let hash = |path: &str| format!("{:x}", Sha256::digest(fs::read(path).unwrap()));
        let artifacts = manifest
            .artifacts
            .iter()
            .map(|path| (path.clone(), hash(path)))
            .collect::<BTreeMap<_, _>>();
        serde_json::to_vec_pretty(&serde_json::json!({
            "manifest":manifest,"executable_sha256":hash(&manifest.launch.program),"probe_sha256":hash(&manifest.probe.program),"artifacts_sha256":artifacts,
            "probe":null,"model_fingerprint":"","launch_fingerprint":"","error":null
        })).unwrap()
    }

    #[test]
    fn owned_helper_migration_requires_the_complete_generated_contract_and_preserves_existing_data()
    {
        const CHILD: &str = "AIOLM_AUTO_CONTRACT_FIXTURE";
        const FILTER: &str = "providers::runtime_auto::tests::owned_helper_migration_requires_the_complete_generated_contract_and_preserves_existing_data";
        if std::env::var_os(CHILD).is_none() {
            let original = std::env::var_os("AIOLM_HOME");
            let area = Area::new();
            // Keep the process-global environment unchanged in the test runner.
            let mut command = crate::procutil::std_command(std::env::current_exe().unwrap());
            command
                .args(["--exact", FILTER, "--nocapture", "--test-threads=1"])
                .env(CHILD, &area.0)
                .env("AIOLM_HOME", area.0.join("한글 {model}=home"));
            let output = crate::procutil::capture_output_cancellable(
                &mut command,
                Duration::from_secs(45),
                256 * 1024,
                None,
            )
            .unwrap();
            assert_eq!(std::env::var_os("AIOLM_HOME"), original);
            assert!(
                output.status.success(),
                "isolated automatic contract fixture failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
            return;
        }
        let area = PathBuf::from(std::env::var_os(CHILD).unwrap());
        assert_eq!(
            fs::read(area.join(".test-owner")).unwrap(),
            b"synthetic automatic connection fixture"
        );
        assert_eq!(
            PathBuf::from(std::env::var_os("AIOLM_HOME").unwrap()),
            area.join("한글 {model}=home")
        );
        let directory = registry::root()
            .join("custom.auto-0123456789abcdef")
            .join("connection-0123456789abcdef");
        fs::create_dir_all(&directory).unwrap();
        let spec_path = directory.join("connection.json");
        let registration_path = directory.join("registration.json");
        let helper = area.join("previous-app-build");
        fs::write(&helper, b"synthetic previous helper identity").unwrap();
        let attached = attached_spec(&directory);
        fs::write(&attached.model_path, b"synthetic model reference").unwrap();
        fs::write(&spec_path, serde_json::to_vec(&attached).unwrap()).unwrap();
        let manifest = manifest_for(&attached, &helper);
        assert!(is_owned_manifest(&manifest));
        // Moving an old trusted helper does not make its generated contract a
        // third-party adapter; refresh still rechecks all external hashes.
        fs::remove_file(&helper).unwrap();
        assert!(is_owned_manifest(&manifest));
        fs::write(&helper, b"synthetic previous helper identity").unwrap();

        type Mutation = fn(&mut registry::RuntimeManifest);
        let mutations: &[Mutation] = &[
            |m| m.schema_version = 2,
            |m| m.adapter_version = 2,
            |m| m.protocol = "other".into(),
            |m| m.health_path = "/different".into(),
            |m| m.health_authenticated = true,
            |m| m.model_formats = vec!["gguf".into()],
            |m| m.platforms.clear(),
            |m| m.probe.args.push("extra".into()),
            |m| m.launch.args[1] = "other".into(),
            |m| {
                m.probe.env.insert("EXTRA".into(), "value".into());
            },
            |m| m.launch.env.clear(),
            |m| m.models.clear(),
            |m| m.artifacts.clear(),
            |m| m.artifacts.push(m.artifacts[0].clone()),
            |m| {
                m.launch.working_directory =
                    Some(std::env::temp_dir().to_string_lossy().into_owned())
            },
        ];
        for mutate in mutations {
            let mut changed = manifest.clone();
            mutate(&mut changed);
            assert!(!is_owned_manifest(&changed));
        }
        for base_url in [
            "http://example.invalid/v1",
            "http://127.0.0.1:43121/v1?credential=synthetic",
        ] {
            let mut changed = attached.clone();
            changed.target = Target::Attached {
                base_url: base_url.into(),
            };
            fs::write(&spec_path, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(!is_owned_manifest(&manifest));
        }
        let mut changed = attached.clone();
        changed.upstream_model = None;
        fs::write(&spec_path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(!is_owned_manifest(&manifest));
        fs::write(&spec_path, serde_json::to_vec(&attached).unwrap()).unwrap();

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let cfg = crate::config::AppConfig {
            active_provider: attached.engine_id.as_str().into(),
            active_runtime: attached.runtime_id.clone(),
            active_model: attached.model_path.clone(),
            ..Default::default()
        };
        let record = record_bytes(&manifest);
        fs::write(&registration_path, &record).unwrap();
        let mut changed = fs::read(&spec_path).unwrap();
        changed.push(b' ');
        fs::write(&spec_path, changed).unwrap();
        let error = runtime.block_on(registry::refresh(&cfg, None)).unwrap_err();
        assert!(error.contains("artifact changed"), "{error}");
        assert_eq!(fs::read(&registration_path).unwrap(), record);
        fs::write(&spec_path, serde_json::to_vec(&attached).unwrap()).unwrap();
        let mut incomplete: serde_json::Value = serde_json::from_slice(&record).unwrap();
        incomplete["artifacts_sha256"] = serde_json::json!({});
        let incomplete = serde_json::to_vec(&incomplete).unwrap();
        fs::write(&registration_path, &incomplete).unwrap();
        let error = runtime.block_on(registry::refresh(&cfg, None)).unwrap_err();
        assert!(error.contains("incomplete"), "{error}");
        assert_eq!(fs::read(&registration_path).unwrap(), incomplete);

        let engine = area.join("external-engine");
        let script = area.join("external-entry-script");
        let model = area.join("selected-model.gguf");
        fs::write(&engine, b"synthetic engine identity").unwrap();
        fs::write(&script, b"synthetic entry script identity").unwrap();
        fs::write(&model, b"synthetic model data").unwrap();
        let mut managed = attached.clone();
        managed.model_path = model.to_string_lossy().into_owned();
        managed.upstream_model = None;
        managed.target = Target::Managed {
            launch: registry::ProcessSpec {
                program: engine.to_string_lossy().into_owned(),
                args: vec![
                    script.to_string_lossy().into_owned(),
                    "--model".into(),
                    "{model}".into(),
                    "--port={port}".into(),
                    "--host={host}".into(),
                ],
                env: BTreeMap::new(),
                working_directory: Some(area.to_string_lossy().into_owned()),
            },
            artifacts: vec![script.to_string_lossy().into_owned()],
        };
        fs::write(&spec_path, serde_json::to_vec(&managed).unwrap()).unwrap();
        let mut managed_manifest = manifest_for(&managed, &helper);
        managed_manifest.artifacts.extend([
            engine.to_string_lossy().into_owned(),
            script.to_string_lossy().into_owned(),
        ]);
        assert!(is_owned_manifest(&managed_manifest));
        let mut public_bind = managed.clone();
        if let Target::Managed { launch, .. } = &mut public_bind.target {
            launch.args.retain(|arg| !has_binding(arg, "{host}"));
        }
        fs::write(&spec_path, serde_json::to_vec(&public_bind).unwrap()).unwrap();
        assert!(!is_owned_manifest(&managed_manifest));
        fs::write(&spec_path, serde_json::to_vec(&managed).unwrap()).unwrap();
        for missing in [&engine, &script] {
            let mut changed = managed_manifest.clone();
            changed.artifacts.retain(|path| Path::new(path) != missing);
            assert!(!is_owned_manifest(&changed));
        }
        let managed_record = record_bytes(&managed_manifest);
        fs::write(&registration_path, &managed_record).unwrap();
        fs::write(&script, b"updated external entry script").unwrap();
        let managed_cfg = crate::config::AppConfig {
            active_model: managed.model_path.clone(),
            ..cfg.clone()
        };
        let error = runtime
            .block_on(registry::refresh(&managed_cfg, None))
            .unwrap_err();
        assert!(error.contains("artifact changed"), "{error}");
        assert_eq!(fs::read(&registration_path).unwrap(), managed_record);
        assert_eq!(fs::read(&engine).unwrap(), b"synthetic engine identity");
        assert_eq!(fs::read(&model).unwrap(), b"synthetic model data");
        assert_eq!(
            fs::read(&attached.model_path).unwrap(),
            b"synthetic model reference"
        );
    }
}
