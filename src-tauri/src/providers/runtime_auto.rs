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
/// Loading a large local model can take minutes. Readiness plus verification
/// fits the 600 s that session start waits for the helper it launches.
const MANAGED_READY_SECS: u64 = 420;
/// The app-owned probe launches the engine, waits for it and verifies it.
pub(crate) const OWNED_PROBE_TIMEOUT: Duration =
    Duration::from_secs(MANAGED_READY_SECS + probe::VERIFY_SECS + 60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelChoice {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedConnection {
    pub kind: String,
    pub models: Vec<ModelChoice>,
    pub candidate: discovery::RuntimeCandidate,
    pub detail: String,
    pub base_url: Option<String>,
    /// Opaque application-owned preparation token, never executable metadata.
    pub plan: String,
    /// Documented command path of a managed launch (`serve llm`); empty for
    /// the entry point itself and for attached servers.
    #[serde(default)]
    pub command: Vec<String>,
    /// With kind `choose_command`, the documented commands that can serve a
    /// model. The user selects one and inspects again.
    #[serde(default)]
    pub commands: Vec<super::runtime_auto_plan::LaunchCommand>,
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

impl ConnectionSpec {
    fn compute_ownership(&self) -> super::protocol::ComputeOwnership {
        match self.target {
            Target::Attached { .. } => super::protocol::ComputeOwnership::Attached,
            // The owned helper is a proxy; the compute it launches is below it.
            Target::Managed { .. } => super::protocol::ComputeOwnership::Descendant,
        }
    }
}
#[derive(Default)]
struct Inventory {
    candidates: BTreeMap<String, discovery::RuntimeCandidate>,
    preparations: BTreeMap<String, (Instant, PreparedConnection, Target)>,
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
fn check_cancel() -> Result<(), crate::error::AppError> {
    if cancellation().load(Ordering::Acquire) {
        Err(crate::error::AppError::cancelled(
            "automatic connection cancelled",
        ))
    } else {
        Ok(())
    }
}

pub async fn discover(
    folder: Option<&Path>,
) -> Result<discovery::DiscoveryReport, crate::error::AppError> {
    let cancel = cancellation();
    let folder = folder.map(Path::to_path_buf);
    let worker_cancel = cancel.clone();
    let mut report =
        tokio::task::spawn_blocking(move || discovery::discover(folder.as_deref(), &worker_cancel))
            .await
            .map_err(crate::error::AppError::from)??;
    // A general TCP listener is not a model server. Only an actual standard
    // model-list response is offered as a running connection candidate.
    use futures_util::{stream, StreamExt};
    let candidates = std::mem::take(&mut report.candidates);
    let inspector = candidates
        .iter()
        .any(|candidate| {
            candidate.pid != Some(std::process::id()) && !candidate.endpoints.is_empty()
        })
        .then(probe::EndpointInspector::new)
        .and_then(Result::ok);
    let inspector = inspector.as_ref();
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
                let Some(inspector) = inspector else {
                    continue;
                };
                if inspector
                    .inspect(&format!("http://{host}:{}/v1", endpoint.port), None)
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
        .map_err(|_| crate::error::AppError::internal("automatic discovery lock poisoned"))?;
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
) -> Result<discovery::RuntimeCandidate, crate::error::AppError> {
    let state = inventory()
        .lock()
        .map_err(|_| crate::error::AppError::internal("automatic discovery lock poisoned"))?;
    let known = state.candidates.get(&candidate.id).ok_or_else(|| {
        crate::error::AppError::not_found("find the installation again before connecting")
    })?;
    // The renderer cannot replace captured argv, PID, endpoint or file evidence.
    if known != candidate {
        return Err(crate::error::AppError::validation(
            "discovered installation changed; find it again",
        ));
    }
    Ok(known.clone())
}

pub async fn inspect(
    candidate: &discovery::RuntimeCandidate,
    local_models: Vec<ModelChoice>,
    command: Option<Vec<String>>,
) -> Result<PreparedConnection, crate::error::AppError> {
    let candidate = known_candidate(candidate)?;
    discovery::revalidate_with_cancel(&candidate, &cancellation())?;
    let mut found = Vec::new();
    let inspector = (!candidate.endpoints.is_empty())
        .then(probe::EndpointInspector::new)
        .and_then(Result::ok);
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
        let Some(inspector) = inspector.as_ref() else {
            continue;
        };
        if let Ok(info) = inspector.inspect(&base, None).await {
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
        return Err(crate::error::AppError::validation(
            "more than one model API belongs to this process; select a single server installation",
        ));
    }
    let (kind, models, detail, base_url, target, command) = if let Some(endpoint) = found.pop() {
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
            vec![],
        )
    } else {
        match super::runtime_auto_plan::plan_with_cancel(
            &candidate,
            &cancellation(),
            command.as_deref(),
        )? {
            super::runtime_auto_plan::PlanOutcome::Choose(commands) => {
                return Ok(PreparedConnection {
                    kind: "choose_command".into(),
                    models: vec![],
                    candidate,
                    detail: "This program documents several commands that can serve a model. Choose the one to launch.".into(),
                    base_url: None,
                    plan: String::new(),
                    command: vec![],
                    commands,
                });
            }
            super::runtime_auto_plan::PlanOutcome::Ready { plan, command } => {
                let launch = plan.launch()?;
                ("managed",local_models,"AioLM will test this installation with the selected model, then manage its own serving process.",None,Target::Managed {launch,artifacts:plan.artifacts.clone()},command.path)
            }
        }
    };
    let prepared = PreparedConnection {
        kind: kind.into(),
        models,
        candidate,
        detail: detail.into(),
        base_url,
        plan: uuid::Uuid::new_v4().to_string(),
        command,
        commands: vec![],
    };
    let mut state = inventory()
        .lock()
        .map_err(|_| crate::error::AppError::internal("automatic discovery lock poisoned"))?;
    if state.preparations.len() >= 128 {
        if let Some(oldest) = state
            .preparations
            .iter()
            .min_by_key(|(_, (inserted, _, _))| *inserted)
            .map(|(token, _)| token.clone())
        {
            state.preparations.remove(&oldest);
        }
    }
    state.preparations.insert(
        prepared.plan.clone(),
        (Instant::now(), prepared.clone(), target),
    );
    Ok(prepared)
}

fn read_spec(path: &Path) -> Result<ConnectionSpec, crate::error::AppError> {
    let file = fs::File::open(path).map_err(|e| {
        crate::error::AppError::new(
            crate::error::AppError::io_kind(&e),
            format!("cannot read automatic connection: {e}"),
        )
    })?;
    let mut bytes = Vec::new();
    file.take(SPEC_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| crate::error::AppError::from_io(&e))?;
    if bytes.len() as u64 > SPEC_LIMIT {
        return Err(crate::error::AppError::validation(
            "automatic connection exceeds its limit",
        ));
    }
    let spec: ConnectionSpec = serde_json::from_slice(&bytes)
        .map_err(|e| crate::error::AppError::validation(e.to_string()))?;
    if spec.version != 1 || !spec.engine_id.is_custom() || spec.model_path.is_empty() {
        return Err(crate::error::AppError::validation(
            "invalid automatic connection",
        ));
    }
    Ok(spec)
}

fn encoded_spec_path(path: &Path) -> Result<String, crate::error::AppError> {
    let text = path.to_str().ok_or_else(|| {
        crate::error::AppError::validation("automatic connection path must be Unicode")
    })?;
    if !path.is_absolute() || text.is_empty() || text.len() > 32768 || text.contains('\0') {
        return Err(crate::error::AppError::validation(
            "invalid automatic connection path",
        ));
    }
    // Registry argv templates reserve braces. Encode the literal metadata path
    // so Unicode, braces and equals signs are never interpreted as bindings.
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text.as_bytes()))
}

fn decoded_spec_path(encoded: &str) -> Result<PathBuf, crate::error::AppError> {
    if encoded.len() > 43_691 {
        return Err(crate::error::AppError::validation(
            "automatic connection address exceeds its limit",
        ));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| crate::error::AppError::validation("invalid automatic connection address"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| crate::error::AppError::validation("invalid automatic connection path"))?;
    let path = PathBuf::from(text);
    encoded_spec_path(&path)?;
    Ok(path)
}

/// Recognize only the complete app-generated helper contract. This also lets
/// a later trusted app/CLI build revalidate its own helper without changing
/// the external installation or its captured file hashes.
fn owned_spec(manifest: &registry::RuntimeManifest) -> Option<ConnectionSpec> {
    let suffix = manifest.engine_id.as_str().strip_prefix("custom.auto-")?;
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
        return None;
    }
    let directory = registry::root()
        .join(manifest.engine_id.as_str())
        .join(&manifest.runtime_id);
    let expected = directory
        .join("connection.json")
        .to_string_lossy()
        .into_owned();
    let Ok(address) = encoded_spec_path(Path::new(&expected)) else {
        return None;
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
        return None;
    }
    let Ok(spec) = read_spec(Path::new(&expected)) else {
        return None;
    };
    if spec.engine_id != manifest.engine_id
        || spec.runtime_id != manifest.runtime_id
        || spec.model_path != manifest.models[0].path
    {
        return None;
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
                return None;
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
                return None;
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
    if actual_artifacts.len() != manifest.artifacts.len() || actual_artifacts != expected_artifacts
    {
        return None;
    }
    Some(spec)
}

pub(crate) fn is_owned_manifest(manifest: &registry::RuntimeManifest) -> bool {
    owned_spec(manifest).is_some()
}

/// Inspect the underlying command only after the complete helper contract has
/// been checked. This derived view never replaces the stored helper manifest.
pub(crate) fn option_manifest(
    manifest: &registry::RuntimeManifest,
) -> Result<Option<registry::RuntimeManifest>, crate::error::AppError> {
    let Some(spec) = owned_spec(manifest) else {
        return Ok(None);
    };
    let Target::Managed { launch, .. } = spec.target else {
        return Ok(None);
    };
    let mut engine = manifest.clone();
    engine.launch = launch;
    let first = engine
        .launch
        .args
        .iter()
        .position(|token| binding_token(token))
        .ok_or_else(|| {
            crate::error::AppError::validation("automatic launch has no registered bindings")
        })?;
    let prefix_len = if engine.launch.args[first].starts_with('-') {
        first
    } else if first > 0 && engine.launch.args[first - 1].starts_with('-') {
        first - 1
    } else {
        first
    };
    let bindings = engine
        .launch
        .args
        .iter()
        .enumerate()
        .filter_map(|(index, token)| {
            if !binding_token(token) {
                return None;
            }
            let (flag, placeholder, equals) = match token.split_once('=') {
                Some((flag, placeholder)) if flag.starts_with('-') => {
                    (flag.to_owned(), placeholder, true)
                }
                _ => (
                    engine.launch.args.get(index.checked_sub(1)?)?.clone(),
                    token.as_str(),
                    false,
                ),
            };
            Some(registry::BoundArgument {
                name: placeholder.trim_matches(['{', '}']).into(),
                argument: registry::ArgBinding::Flag { flag, equals },
            })
        })
        .collect();
    engine.launch_bindings = Some(registry::LaunchBindings {
        version: 1,
        prefix_len,
        bindings,
        options_separator: None,
    });
    let prefix = registry::launch_prefix(&engine);
    // The planner only emits an optional absolute interpreter script followed
    // by documented command words. Deriving these roles also supports v1 specs.
    let subcommands = prefix
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (!Path::new(token).is_absolute()).then_some(index))
        .collect();
    let layout = super::runtime_command::CommandLayout {
        version: 1,
        subcommands,
        options: vec![],
    };
    layout
        .validate(&prefix)
        .map_err(crate::error::AppError::validation)?;
    engine.command_layout = Some(layout);
    Ok(Some(engine))
}

pub(crate) fn supports_launch_args(manifest: &registry::RuntimeManifest) -> bool {
    !owned_spec(manifest).is_some_and(|spec| matches!(spec.target, Target::Attached { .. }))
}

pub(crate) fn connection_presentation(
    manifest: &registry::RuntimeManifest,
) -> Option<(String, String)> {
    let spec = owned_spec(manifest)?;
    match spec.target {
        Target::Attached { base_url } => Some((base_url.clone(), base_url)),
        Target::Managed { launch, .. } => {
            let engine = option_manifest(manifest).ok()??;
            let prefix = registry::launch_prefix(&engine);
            let scope = engine.command_layout.as_ref()?.scope(&prefix).ok()?;
            Some((scope.join(" "), launch.program))
        }
    }
}

const ARGV_HEADER: &str = "aiolm-auto-argv-v1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionTransport {
    version: u32,
    argv: Vec<String>,
    /// Only these registered template slots may expand. Saved strings that
    /// happen to contain `{model}` or `{port}` always remain literal.
    bindings: BTreeMap<usize, String>,
}

fn binding_token(value: &str) -> bool {
    ["{model}", "{port}", "{host}", "{model_alias}"]
        .iter()
        .any(|token| has_binding(value, token))
}

/// Shared by registry probe and serve; append this tail to the helper header,
/// never pass it through template expansion or the ordinary helper resolver.
pub(crate) fn resolved_option_transport(
    root: &Path,
    cfg: &crate::config::AppConfig,
    manifest: &registry::RuntimeManifest,
) -> Result<Option<Vec<String>>, crate::error::AppError> {
    if cfg.active_model.is_empty() {
        return Ok(None);
    }
    let Some(engine) = option_manifest(manifest)? else {
        if !supports_launch_args(manifest)
            && !super::launch::provider_options(cfg, manifest.engine_id).is_empty()
        {
            return Err(crate::error::AppError::validation(
                "attached services do not accept launch arguments",
            ));
        }
        return Ok(None);
    };
    let selected = super::runtime_schema::Selected::from_config(cfg)?;
    let effective = super::runtime_schema::effective_for(root, cfg, &selected, false)?;
    let values = super::launch::provider_options(cfg, manifest.engine_id);
    let raw = super::runtime_raw_args::validated(
        &effective.schema,
        &effective.additional_arg_flags,
        &values,
    )
    .map_err(crate::error::AppError::validation)?;
    let saved = serde_json::to_string(&values)
        .map_err(|error| crate::error::AppError::internal(error.to_string()))?;
    let nonce = loop {
        let candidate = format!("aiolm-binding-{}", uuid::Uuid::new_v4());
        if !saved.contains(&candidate)
            && !engine
                .launch
                .args
                .iter()
                .any(|arg| arg.contains(&candidate))
        {
            break candidate;
        }
    };
    let mut template = engine.launch.args.clone();
    let mut markers = BTreeMap::new();
    for (index, token) in template.iter_mut().enumerate() {
        if binding_token(token) {
            let marker = format!("{nonce}-{index}");
            markers.insert(marker.clone(), token.clone());
            *token = marker;
        }
    }
    let mut argv =
        super::runtime_schema::assemble_registered_arguments(root, cfg, &engine, &template)
            .map_err(crate::error::AppError::validation)?;
    argv.extend(raw);
    let mut bindings = BTreeMap::new();
    for (index, token) in argv.iter_mut().enumerate() {
        if let Some(original) = markers.get(token) {
            *token = original.clone();
            bindings.insert(index, original.clone());
        }
    }
    let transport = OptionTransport {
        version: 1,
        argv,
        bindings,
    };
    Ok(Some(vec![
        "--".into(),
        ARGV_HEADER.into(),
        serde_json::to_string(&transport).map_err(|error| error.to_string())?,
    ]))
}

fn transported_arguments(
    launch: &registry::ProcessSpec,
    transport: Option<&OptionTransport>,
    model: &str,
    port: u16,
    alias: &str,
) -> Result<Vec<String>, crate::error::AppError> {
    let Some(transport) = transport else {
        return launch
            .args
            .iter()
            .map(|arg| expand(arg, model, port, alias))
            .collect();
    };
    let expected: Vec<&String> = launch
        .args
        .iter()
        .filter(|arg| binding_token(arg))
        .collect();
    if transport.version != 1
        || transport.bindings.values().collect::<Vec<_>>() != expected
        || transport
            .bindings
            .iter()
            .any(|(index, token)| transport.argv.get(*index) != Some(token))
        || transport.argv.iter().any(|arg| arg.contains('\0'))
    {
        return Err(crate::error::AppError::validation(
            "invalid automatic option binding transport",
        ));
    }
    transport
        .argv
        .iter()
        .enumerate()
        .map(|(index, arg)| {
            if transport.bindings.contains_key(&index) {
                expand(arg, model, port, alias)
            } else {
                Ok(arg.clone())
            }
        })
        .collect()
}

pub async fn connect(
    prepared: &PreparedConnection,
    model_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<ConnectedRuntime, crate::error::AppError> {
    let (_, known, target) = inventory()
        .lock()
        .map_err(|_| crate::error::AppError::internal("automatic discovery lock poisoned"))?
        .preparations
        .get(&prepared.plan)
        .cloned()
        .ok_or_else(|| {
            crate::error::AppError::not_found("find the installation again before connecting")
        })?;
    if known != *prepared || !known.models.iter().any(|m| m.id == model_id) {
        return Err(crate::error::AppError::validation(
            "connection or selected model changed; inspect it again",
        ));
    }
    check_cancel()?;
    discovery::revalidate_with_cancel(&known.candidate, &cancel)?;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let engine = ProviderId::parse(&format!("custom.auto-{}", &suffix[..16]))
        .ok_or_else(|| crate::error::AppError::internal("cannot allocate connection identity"))?;
    let runtime = format!("connection-{}", &suffix[..16]);
    let directory = registry::root().join(engine.as_str()).join(&runtime);
    fs::create_dir_all(directory.parent().unwrap())
        .map_err(|e| crate::error::AppError::from_io(&e))?;
    // Refuse collisions instead of opening or cleaning an older registration.
    fs::create_dir(&directory).map_err(|e| crate::error::AppError::from_io(&e))?;
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
                .map_err(|e| crate::error::AppError::internal(e.to_string()))?,
            )?;
        }
        crate::config::atomic_write(
            &spec_path,
            &serde_json::to_vec(&spec)
                .map_err(|e| crate::error::AppError::internal(e.to_string()))?,
        )?;
        let helper = std::env::current_exe()
            .map_err(|e| crate::error::AppError::from_io(&e))?
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
            public_engine: None,
            compute_ownership: Some(spec.compute_ownership()),
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
        registry::register_manifest(manifest.clone(), Some(cancel.clone())).await?;
        let cfg = crate::config::AppConfig {
            active_provider: engine.as_str().into(),
            active_runtime: runtime.clone(),
            active_model: model_path.clone(),
            ..Default::default()
        };
        super::runtime_schema::ensure_automatic_help(&registry::root(), &cfg, &manifest, &cancel)?;
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
    child: crate::procutil::OwnedChild,
}
impl ChildGuard {
    fn spawn(command: &mut std::process::Command) -> Result<Self, crate::error::AppError> {
        #[cfg(unix)]
        let child = crate::procutil::OwnedChild::spawn_inherited_process_group(command);
        #[cfg(not(unix))]
        let child = crate::procutil::OwnedChild::spawn(command);
        child.map(|child| Self { child }).map_err(|e| {
            crate::error::AppError::new(
                crate::error::AppError::io_kind(&e),
                format!("cannot start discovered entry point: {e}"),
            )
        })
    }
    fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, crate::error::AppError> {
        self.child
            .try_wait()
            .map_err(|e| crate::error::AppError::from_io(&e))
    }
    fn owns_listener(&self, port: u16) -> bool {
        crate::server::listener_owned_by_child(self.child.id(), port, self.child.process_handle())
    }
}

fn has_binding(value: &str, token: &str) -> bool {
    value == token
        || value
            .split_once('=')
            .is_some_and(|(flag, binding)| flag.starts_with('-') && binding == token)
}

fn expand(
    value: &str,
    model: &str,
    port: u16,
    alias: &str,
) -> Result<String, crate::error::AppError> {
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
    transport: Option<&OptionTransport>,
) -> Result<(String, String, Option<ChildGuard>), crate::error::AppError> {
    if model != spec.model_path {
        return Err(crate::error::AppError::validation(
            "selected model differs from automatic connection",
        ));
    }
    match &spec.target {
        Target::Attached { base_url } => Ok((
            base_url.clone(),
            spec.upstream_model
                .clone()
                .ok_or_else(|| crate::error::AppError::validation("missing upstream model"))?,
            None,
        )),
        Target::Managed { launch, .. } => {
            let socket = std::net::TcpListener::bind(("127.0.0.1", 0))
                .map_err(|e| crate::error::AppError::from_io(&e))?;
            let port = socket
                .local_addr()
                .map_err(|e| crate::error::AppError::from_io(&e))?
                .port();
            drop(socket);
            let alias = format!("aiolm-{}", spec.runtime_id);
            let aliased = launch
                .args
                .iter()
                .chain(launch.env.values())
                .any(|arg| has_binding(arg, "{model_alias}"));
            let mut command = crate::procutil::std_command(&launch.program);
            command
                .args(transported_arguments(
                    launch, transport, model, port, &alias,
                )?)
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
            // Keep the engine in the helper's group for outer-owner SIGKILL.
            // Normal guard drop walks only the engine's own descendant tree.
            let mut child = ChildGuard::spawn(&mut command)?;
            let url = format!("http://127.0.0.1:{port}/v1");
            let deadline = Instant::now() + Duration::from_secs(MANAGED_READY_SECS);
            loop {
                if let Some(status) = child.try_wait()? {
                    return Err(crate::error::AppError::unavailable(engine_exit_message(
                        status.code(),
                    )));
                }
                if let Ok(info) = probe::inspect_endpoint(&url, None).await {
                    if !child.owns_listener(port) {
                        return Err(crate::error::AppError::validation(
                            "model API listener does not belong to the started process",
                        ));
                    }
                    if info.models.len() != 1 {
                        return Err(crate::error::AppError::validation("automatic launch requires exactly one served model; its model identity is ambiguous"));
                    }
                    let expected = if aliased { alias.as_str() } else { model };
                    if info.models[0].id != expected {
                        return Err(crate::error::AppError::validation("the model API did not confirm the selected launch identity; automatic connection remains unverified"));
                    }
                    return Ok((url, info.models[0].id.clone(), Some(child)));
                }
                if Instant::now() >= deadline {
                    return Err(crate::error::AppError::timeout(
                        "discovered entry point did not expose a verified model API in time",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// Why the managed engine ended before serving. A Windows loader failure ends
/// the process before it writes anything, so its status is the only evidence.
fn engine_exit_message(code: Option<i32>) -> String {
    let status = match code {
        // NTSTATUS values are negative as i32; Windows tools print them in hex.
        Some(code) if code < 0 => format!("status {:#010X}", code as u32),
        Some(code) => format!("status {code}"),
        None => "a signal".into(),
    };
    let cause = match code.map(|code| code as u32) {
        Some(0xC000_0135) => Some("a DLL the engine needs was not found; check that its folder is complete and that security software did not quarantine one of its files"),
        Some(0xC000_0139) => Some("a DLL the engine loaded lacks a required entry point; its DLLs do not match each other"),
        Some(0xC000_007B) => Some("the engine or one of its DLLs is damaged or built for another architecture"),
        Some(0xC000_0142) => Some("a DLL the engine needs failed to initialize"),
        _ => None,
    };
    match cause {
        Some(cause) => format!("discovered entry point exited with {status} before serving a model API: {cause}"),
        None => format!("discovered entry point exited with {status} before serving a model API; see the engine diagnostics"),
    }
}

pub fn is_internal(args: &[String]) -> bool {
    args.first().is_some_and(|arg| arg == INTERNAL)
}
pub async fn run_internal(args: &[String]) -> Result<(), crate::error::AppError> {
    if !is_internal(args) || args.len() < 4 {
        return Err(crate::error::AppError::validation(
            "invalid internal automatic connection command",
        ));
    }
    let header = match args[1].as_str() {
        "probe" => 4,
        "serve" => 5,
        _ => {
            return Err(crate::error::AppError::validation(
                "unknown internal connection operation",
            ))
        }
    };
    if args.len() < header {
        return Err(crate::error::AppError::validation(
            "invalid internal automatic connection header",
        ));
    }
    let assigned_port = if header == 5 {
        Some(
            args[4]
                .parse::<u16>()
                .map_err(|_| crate::error::AppError::validation("invalid assigned port"))?,
        )
    } else {
        None
    };
    let transport = match &args[header..] {
        [] => None,
        [separator, tag, payload] if separator == "--" && tag == ARGV_HEADER => Some(
            serde_json::from_str::<OptionTransport>(payload).map_err(|_| {
                crate::error::AppError::validation("invalid automatic option transport")
            })?,
        ),
        _ => {
            return Err(crate::error::AppError::validation(
                "invalid automatic option transport header",
            ))
        }
    };
    if transport
        .as_ref()
        .is_some_and(|transport| transport.version != 1)
    {
        return Err(crate::error::AppError::validation(
            "unsupported automatic option transport version",
        ));
    }
    let spec = read_spec(&decoded_spec_path(&args[2])?)?;
    if matches!(spec.target, Target::Attached { .. }) && transport.is_some() {
        return Err(crate::error::AppError::validation(
            "attached services do not accept launch arguments",
        ));
    }
    let model = &args[3];
    if args[1] == "probe" && model.is_empty() {
        let result = registry::ProbeResult {
            public_engine: None,
            compute_ownership: Some(spec.compute_ownership()),
            model_format: Some(super::artifacts::ArtifactFormat::Unknown),
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
                stream_usage_supported: None,
                fixed_output: None,
            },
        };
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let (url, upstream_model, mut child) = upstream(&spec, model, transport.as_ref()).await?;
    probe::verify(probe::ProbeRequest {
        base_url: url.clone(),
        model: upstream_model.clone(),
        api_key: None,
    })
    .await?;
    if args[1] == "probe" {
        let result = registry::ProbeResult {
            public_engine: None,
            compute_ownership: Some(spec.compute_ownership()),
            model_format: Some(super::artifacts::ArtifactFormat::Unknown),
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
                // Core API verification proves no request control.
                stream_usage_supported: None,
                fixed_output: None,
            },
        };
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let port =
        assigned_port.ok_or_else(|| crate::error::AppError::validation("missing assigned port"))?;
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
        tokio::select! { result=&mut serving=>return result.map_err(Into::into), _=tokio::time::sleep(Duration::from_millis(200))=>{
            if let Some(child)=child.as_mut() {if child.try_wait()?.is_some() {return Err(crate::error::AppError::unavailable("connected engine exited"));}}
        }}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn engine_exit_names_windows_loader_failures_and_keeps_other_statuses() {
        let missing_dll = engine_exit_message(Some(0xC000_0135_u32 as i32));
        assert!(missing_dll.contains("status 0xC0000135"), "{missing_dll}");
        assert!(
            missing_dll.contains("DLL the engine needs was not found"),
            "{missing_dll}"
        );
        assert_eq!(
            engine_exit_message(Some(3)),
            "discovered entry point exited with status 3 before serving a model API; see the engine diagnostics"
        );
        assert!(engine_exit_message(None).contains("with a signal"));
    }

    #[tokio::test]
    async fn cancelled_inspection_does_not_revalidate_a_stale_process() {
        let candidate = discovery::RuntimeCandidate {
            id: "synthetic-cancelled-process".into(),
            source: discovery::DiscoverySource::LocalProcess,
            display_name: "Synthetic stopped service".into(),
            entrypoint_path: None,
            entrypoint_fingerprint: None,
            command: None,
            endpoints: vec![],
            entrypoint_kind: discovery::EntrypointKind::Attached,
            state: discovery::DiscoveryState::NeedsConfiguration,
            pid: None,
            process_identity: None,
            reasons: vec![],
        };
        inventory()
            .lock()
            .unwrap()
            .candidates
            .insert(candidate.id.clone(), candidate.clone());
        cancellation().store(true, Ordering::Release);
        let result = inspect(&candidate, vec![], None).await;
        cancellation().store(false, Ordering::Release);
        inventory().lock().unwrap().candidates.remove(&candidate.id);
        let error = result.unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
        assert_eq!(error.message, "runtime discovery cancelled");

        let prepared = PreparedConnection {
            kind: "attached".into(),
            models: vec![ModelChoice {
                id: "synthetic-model".into(),
                name: "Synthetic model".into(),
            }],
            candidate,
            detail: String::new(),
            base_url: Some("http://127.0.0.1:43121/v1".into()),
            plan: "synthetic-cancelled-plan".into(),
            command: vec![],
            commands: vec![],
        };
        inventory().lock().unwrap().preparations.insert(
            prepared.plan.clone(),
            (
                Instant::now(),
                prepared.clone(),
                Target::Attached {
                    base_url: prepared.base_url.clone().unwrap(),
                },
            ),
        );
        let result = connect(
            &prepared,
            "synthetic-model",
            Arc::new(AtomicBool::new(true)),
        )
        .await;
        inventory()
            .lock()
            .unwrap()
            .preparations
            .remove(&prepared.plan);
        let error = result.unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
        assert_eq!(error.message, "runtime discovery cancelled");
    }

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

    #[tokio::test]
    async fn captured_candidate_and_preparation_reject_changed_renderer_fields() {
        let candidate = discovery::RuntimeCandidate {
            id: "synthetic-immutable-candidate".into(),
            source: discovery::DiscoverySource::LocalProcess,
            display_name: "Synthetic service".into(),
            entrypoint_path: Some("/synthetic/entry".into()),
            entrypoint_fingerprint: Some("captured-stamp".into()),
            command: Some(discovery::ObservedCommand {
                program: "/synthetic/entry".into(),
                args: vec!["first".into(), "second".into()],
                working_directory: Some("/synthetic".into()),
                argv_source: discovery::ArgvSource::OsArguments,
            }),
            endpoints: vec![discovery::LocalEndpoint {
                host: "127.0.0.1".into(),
                port: 43121,
            }],
            entrypoint_kind: discovery::EntrypointKind::Attached,
            state: discovery::DiscoveryState::NeedsConfiguration,
            pid: Some(12345),
            process_identity: Some("captured-creation".into()),
            reasons: vec!["captured-evidence".into()],
        };
        inventory()
            .lock()
            .unwrap()
            .candidates
            .insert(candidate.id.clone(), candidate.clone());
        assert!(known_candidate(&candidate).is_ok());
        let changes: Vec<fn(&mut discovery::RuntimeCandidate)> = vec![
            |c| c.source = discovery::DiscoverySource::SelectedFolder,
            |c| c.display_name.push('!'),
            |c| c.entrypoint_path = None,
            |c| c.entrypoint_fingerprint = None,
            |c| c.command.as_mut().unwrap().program.push('!'),
            |c| c.command.as_mut().unwrap().args.reverse(),
            |c| c.command.as_mut().unwrap().working_directory = None,
            |c| c.command.as_mut().unwrap().argv_source = discovery::ArgvSource::Shebang,
            |c| c.endpoints[0].host = "::1".into(),
            |c| c.endpoints[0].port += 1,
            |c| c.entrypoint_kind = discovery::EntrypointKind::Unknown,
            |c| c.pid = None,
            |c| c.process_identity = None,
            |c| c.reasons.clear(),
        ];
        for change in changes {
            let mut changed = candidate.clone();
            change(&mut changed);
            assert_eq!(
                known_candidate(&changed).unwrap_err().message,
                "discovered installation changed; find it again"
            );
        }
        inventory().lock().unwrap().candidates.remove(&candidate.id);
        let prepared = PreparedConnection {
            kind: "attached".into(),
            models: vec![
                ModelChoice {
                    id: "model-a".into(),
                    name: "Model A".into(),
                },
                ModelChoice {
                    id: "model-b".into(),
                    name: "Model B".into(),
                },
            ],
            candidate,
            detail: "Captured detail".into(),
            base_url: Some("http://127.0.0.1:43121/v1".into()),
            plan: "synthetic-immutable-plan".into(),
            command: vec![],
            commands: vec![],
        };
        inventory().lock().unwrap().preparations.insert(
            prepared.plan.clone(),
            (
                Instant::now(),
                prepared.clone(),
                Target::Attached {
                    base_url: prepared.base_url.clone().unwrap(),
                },
            ),
        );
        let changes: Vec<fn(&mut PreparedConnection)> = vec![
            |p| p.kind = "managed".into(),
            |p| p.models[0].id.push('!'),
            |p| p.models[0].name.push('!'),
            |p| p.models.reverse(),
            |p| p.candidate.command.as_mut().unwrap().args.reverse(),
            |p| p.detail.clear(),
            |p| p.base_url = None,
        ];
        for change in changes {
            let mut changed = prepared.clone();
            change(&mut changed);
            assert_eq!(
                connect(&changed, "model-a", Arc::new(AtomicBool::new(true)))
                    .await
                    .unwrap_err()
                    .message,
                "connection or selected model changed; inspect it again"
            );
        }
        assert_eq!(
            connect(&prepared, "missing-model", Arc::new(AtomicBool::new(true)))
                .await
                .unwrap_err()
                .message,
            "connection or selected model changed; inspect it again"
        );
        inventory()
            .lock()
            .unwrap()
            .preparations
            .remove(&prepared.plan);
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
    fn automatic_helpers_attribute_compute_without_exposing_connection_identity() {
        use super::super::{
            artifacts::ArtifactFormat,
            protocol::{PublicEngine, ServingMemoryScope, ServingMetadata, ServingTopology},
        };
        let mut spec = attached_spec(Path::new("/synthetic"));
        assert_eq!(
            spec.compute_ownership(),
            super::super::protocol::ComputeOwnership::Attached
        );
        for windows in [false, true] {
            let attached = ServingMetadata::for_platform(
                PublicEngine::default(),
                ArtifactFormat::Unknown,
                spec.compute_ownership(),
                windows,
            );
            assert_eq!(attached.topology, ServingTopology::Attached);
            assert_eq!(attached.memory_scope, ServingMemoryScope::Unavailable);
            assert_eq!(attached.model_format, ArtifactFormat::Unknown);
            let public = serde_json::to_string(&attached).unwrap();
            assert!(
                !public.contains("auto-")
                    && !public.contains("connection-")
                    && !public.contains("43121")
            );
        }
        spec.target = Target::Managed {
            launch: registry::ProcessSpec {
                program: "/synthetic/engine".into(),
                args: vec![],
                env: BTreeMap::new(),
                working_directory: None,
            },
            artifacts: vec![],
        };
        assert_eq!(
            spec.compute_ownership(),
            super::super::protocol::ComputeOwnership::Descendant
        );
        let unix = ServingMetadata::for_platform(
            PublicEngine::default(),
            ArtifactFormat::Unknown,
            spec.compute_ownership(),
            false,
        );
        let windows = ServingMetadata::for_platform(
            PublicEngine::default(),
            ArtifactFormat::Unknown,
            spec.compute_ownership(),
            true,
        );
        assert_eq!(unix.memory_scope, ServingMemoryScope::OwnedProcessTree);
        assert_eq!(windows.memory_scope, ServingMemoryScope::Unavailable);
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
        assert!(read_spec(&path).unwrap_err().message.contains("exceeds"));
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
            public_engine: None,
            compute_ownership: Some(spec.compute_ownership()),
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
        assert!(error.message.contains("artifact changed"), "{error}");
        assert_eq!(fs::read(&registration_path).unwrap(), record);
        fs::write(&spec_path, serde_json::to_vec(&attached).unwrap()).unwrap();
        let mut incomplete: serde_json::Value = serde_json::from_slice(&record).unwrap();
        incomplete["artifacts_sha256"] = serde_json::json!({});
        let incomplete = serde_json::to_vec(&incomplete).unwrap();
        fs::write(&registration_path, &incomplete).unwrap();
        let error = runtime.block_on(registry::refresh(&cfg, None)).unwrap_err();
        assert!(error.message.contains("incomplete"), "{error}");
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
                    "serve".into(),
                    "llm".into(),
                    "--model".into(),
                    "{model}".into(),
                    "--port={port}".into(),
                    "--host={host}".into(),
                    "--alias".into(),
                    "{model_alias}".into(),
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
        // A legacy spec (launch/artifacts only) derives the real scoped help
        // head, never the AioLM proxy's internal command.
        let mut options_cfg = crate::config::AppConfig {
            active_model: managed.model_path.clone(),
            ..cfg.clone()
        };
        let root = registry::root();
        let target = super::super::runtime_schema::help_target(&root, &options_cfg).unwrap();
        assert_eq!(target.program, engine.to_string_lossy());
        assert_eq!(
            target.prefix,
            [
                script.to_string_lossy().into_owned(),
                "serve".into(),
                "llm".into()
            ]
        );
        assert_eq!(target.request.scope, ["serve", "llm"]);
        assert_eq!(
            connection_presentation(&managed_manifest),
            Some(("serve llm".into(), engine.to_string_lossy().into_owned()))
        );
        let help =
            super::super::runtime_schema::manifest_help_command(&managed_manifest, &target.request)
                .unwrap();
        let identity = help.identity(&AtomicBool::new(false)).unwrap();
        let output = |text: &str| super::super::runtime_help::TextOutput {
            text: text.into(),
            clean_text: text.into(),
            encoding: "utf-8".into(),
            decoding_loss: false,
            truncated: false,
            read_error: None,
            raw_bytes_base64: None,
        };
        let report = super::super::runtime_help::HelpReport {
            identity, scope: vec!["serve".into(), "llm".into()],
            stdout: output("Options:\n  -m, --model PATH  model path\n  -p, --port PORT  listening port\n  --host HOST  bind address\n  -a, --alias NAME  served model name\n  --fresh-label TEXT  literal label\n  --fresh-count N  worker count\n"),
            stderr: output(""), exit_code: Some(0), success: true,
            cancelled: false, timed_out: false, error: None, elapsed_ms: 1,
        };
        let schema = super::super::runtime_help_parse::parse_help_report(
            &report,
            super::super::runtime_options::SchemaBinding {
                engine: managed.engine_id.as_str().into(),
                runtime: managed.runtime_id.clone(),
                fingerprint: report.identity.fingerprint.clone(),
            },
        )
        .unwrap();
        super::super::runtime_help_store::save_snapshot(
            &root,
            managed.engine_id.as_str(),
            &managed.runtime_id,
            &super::super::runtime_help_store::HelpSnapshot {
                report: report.clone(),
                schema,
            },
        )
        .unwrap();
        super::super::runtime_schema::accept(
            &root,
            &options_cfg,
            &report.identity.fingerprint,
            &target.request,
        )
        .unwrap();
        let effective = super::super::runtime_schema::effective(&root, &options_cfg, true).unwrap();
        assert!(effective.supports_launch_args);
        let label_key = effective
            .schema
            .options
            .iter()
            .find(|option| option.spellings.iter().any(|s| s.flag == "--fresh-label"))
            .unwrap()
            .key
            .clone();
        let alias = effective
            .schema
            .options
            .iter()
            .find(|option| option.spellings.iter().any(|s| s.flag == "-a"))
            .unwrap();
        assert_eq!(
            alias.managed,
            Some(super::super::runtime_options::ManagedBinding::Model)
        );
        options_cfg.provider_options.insert(
            managed.engine_id.as_str().into(),
            serde_json::json!({label_key: "{port}", "extra_args": ["--unlisted", "{model}"]})
                .as_object()
                .unwrap()
                .clone(),
        );
        let tail = resolved_option_transport(&root, &options_cfg, &managed_manifest)
            .unwrap()
            .unwrap();
        assert_eq!(&tail[..2], ["--", ARGV_HEADER]);
        let transport: OptionTransport = serde_json::from_str(&tail[2]).unwrap();
        let Target::Managed { launch, .. } = &managed.target else {
            unreachable!()
        };
        let actual = transported_arguments(
            launch,
            Some(&transport),
            &managed.model_path,
            43123,
            "owned-alias",
        )
        .unwrap();
        assert_eq!(
            actual,
            [
                script.to_string_lossy().into_owned(),
                "serve".into(),
                "llm".into(),
                "--model".into(),
                managed.model_path.clone(),
                "--port=43123".into(),
                "--host=127.0.0.1".into(),
                "--alias".into(),
                "owned-alias".into(),
                "--fresh-label".into(),
                "{port}".into(),
                "--unlisted".into(),
                "{model}".into(),
            ]
        );
        let mut invalid: OptionTransport = serde_json::from_str(&tail[2]).unwrap();
        invalid.bindings.clear();
        assert!(transported_arguments(
            launch,
            Some(&invalid),
            &managed.model_path,
            43123,
            "owned-alias"
        )
        .is_err());
        options_cfg
            .provider_options
            .get_mut(managed.engine_id.as_str())
            .unwrap()
            .insert(alias.key.clone(), serde_json::json!("not-owned"));
        assert!(resolved_option_transport(&root, &options_cfg, &managed_manifest).is_err());
        options_cfg.provider_options.insert(
            managed.engine_id.as_str().into(),
            serde_json::json!({"extra_args":["-anot-owned"]})
                .as_object()
                .unwrap()
                .clone(),
        );
        let values = &options_cfg.provider_options[managed.engine_id.as_str()];
        let issues = super::super::runtime_schema::saved_issues(
            &root,
            &options_cfg,
            values,
            &std::collections::BTreeSet::new(),
        );
        assert!(issues.iter().any(|issue| issue.key == "extra_args"));
        assert!(super::super::runtime_schema::additional_launch_args(&root, &options_cfg).is_err());
        // An app update replaces the helper (AioLM itself). The inventory keeps
        // offering the connection; the next probe adopts the running build.
        // Changed engine-side files still make it unusable.
        fs::write(&helper, b"synthetic updated app build").unwrap();
        let reports = |problem: &str| {
            registry::runtime_instances().iter().any(|instance| {
                instance.id == managed.runtime_id
                    && instance.problems.iter().any(|text| text.contains(problem))
            })
        };
        assert!(!reports("changed"));
        fs::write(&script, b"updated external entry script").unwrap();
        assert!(reports("artifact changed"));
        let managed_cfg = crate::config::AppConfig {
            active_model: managed.model_path.clone(),
            ..cfg.clone()
        };
        let error = runtime
            .block_on(registry::refresh(&managed_cfg, None))
            .unwrap_err();
        assert!(error.message.contains("artifact changed"), "{error}");
        assert_eq!(fs::read(&registration_path).unwrap(), managed_record);
        assert_eq!(fs::read(&engine).unwrap(), b"synthetic engine identity");
        assert_eq!(fs::read(&model).unwrap(), b"synthetic model data");
        assert_eq!(
            fs::read(&attached.model_path).unwrap(),
            b"synthetic model reference"
        );
    }

    #[tokio::test]
    async fn automatic_helper_rejects_malformed_transport_before_opening_metadata() {
        for (args, error) in [
            (
                vec![INTERNAL, "probe", "not-an-address", "model", "extra"],
                "invalid automatic option transport header",
            ),
            (
                vec![INTERNAL, "serve", "not-an-address", "model"],
                "invalid internal automatic connection header",
            ),
            (
                vec![INTERNAL, "serve", "not-an-address", "model", "not-a-port"],
                "invalid assigned port",
            ),
            (
                vec![
                    INTERNAL,
                    "probe",
                    "not-an-address",
                    "model",
                    "--",
                    ARGV_HEADER,
                    "{}",
                ],
                "invalid automatic option transport",
            ),
            (
                vec![
                    INTERNAL,
                    "probe",
                    "not-an-address",
                    "model",
                    "--",
                    ARGV_HEADER,
                    r#"{"version":2,"argv":[],"bindings":{}}"#,
                ],
                "unsupported automatic option transport version",
            ),
        ] {
            let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert_eq!(run_internal(&args).await.unwrap_err().message, error);
        }
    }
}
