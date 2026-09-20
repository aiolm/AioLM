//! Default server IPC, shared session lifecycle operations and idle tracking.
use super::gateway::abort_gateway_now;
use super::launch::validate_launch_config_with_cancel;
use crate::{config, gateway, gpu, server, session, state::AppState, tuning_defaults};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Manager, State};
use uuid::Uuid;

pub(super) struct PreparedLaunch {
    pub cfg: config::AppConfig,
    gpu: gpu::ResolvedGpu,
}

/// Complete validation and optional persistence before stopping any session.
pub(super) async fn prepare_launch(
    state: &AppState,
    mut cfg: config::AppConfig,
    persist: bool,
    launch_cancel: &Arc<AtomicBool>,
) -> Result<PreparedLaunch, String> {
    ensure_launch_allowed(state, launch_cancel)?;
    let gpu = validate_launch_config_with_cancel(&mut cfg, Some(launch_cancel)).await?;
    ensure_launch_allowed(state, launch_cancel)?;
    if persist {
        let _config_write = state.config_write.lock().await;
        ensure_launch_allowed(state, launch_cancel)?;
        let latest = config::load_result()?;
        cfg = config::save(&config::execution::merge_launch(&latest, &cfg)?)?;
    }
    Ok(PreparedLaunch { cfg, gpu })
}

fn ensure_launch_allowed(state: &AppState, launch_cancel: &AtomicBool) -> Result<(), String> {
    if state.runtime_busy.load(Ordering::Acquire) {
        return Err(
            "a runtime operation is in progress; wait for it to finish before starting the server"
                .into(),
        );
    }
    if state.exiting.load(Ordering::Acquire) {
        return Err("application is exiting".into());
    }
    if launch_cancel.load(Ordering::Acquire) {
        return Err("server start cancelled".into());
    }
    Ok(())
}

/// Starting can replace the selected target and, under the load policy,
/// every other session. Active responses must finish before that transition.
pub(super) fn ensure_no_active_requests(
    state: &AppState,
    target_id: &str,
    stop_existing: bool,
) -> Result<(), String> {
    let mut targets = Vec::new();
    if target_id == session::DEFAULT_SESSION_ID || stop_existing {
        targets.push((
            session::DEFAULT_SESSION_ID.to_string(),
            state.server.clone(),
        ));
    }
    targets.extend(
        state
            .sessions
            .entries()
            .into_iter()
            .filter(|entry| stop_existing || entry.id == target_id)
            .map(|entry| (entry.id.clone(), entry.state.clone())),
    );
    for (id, target) in targets {
        let server = target
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if server.lifecycle.blocks_resource_change() && server.active_requests > 0 {
            return Err(format!(
                "finish or stop the active response in session '{id}' before loading a model"
            ));
        }
    }
    Ok(())
}

/// Launch a previously validated configuration on one session target.
pub(super) async fn start_on_target(
    state: &AppState,
    target: &Arc<Mutex<server::ServerState>>,
    err: &Arc<server::ErrBuf>,
    prepared: PreparedLaunch,
    abort_gateway: bool,
    launch_cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    ensure_launch_allowed(state, launch_cancel)?;
    let PreparedLaunch {
        cfg: saved,
        gpu: resolved_gpu,
    } = prepared;
    let launch_generation = {
        let mut server = target
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if server.lifecycle.blocks_resource_change() && server.active_requests > 0 {
            return Err("finish or stop the active response before replacing this model".into());
        }
        let generation = server.begin_launch();
        server.last_error = None;
        server.url.clear();
        server.api_key.clear();
        server.redaction_secret.clear();
        server.model.clear();
        server.mmproj.clear();
        server.draft_model.clear();
        server::kill(&mut server.child, Some(err.clone()));
        generation
    };
    err.clear();

    {
        let server = target
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if !server.is_current_launch(launch_generation) {
            return Err("server start cancelled".into());
        }
    }
    if abort_gateway {
        abort_gateway_now(state);
    }

    let api_key = format!("lb-{}", Uuid::new_v4().simple());
    let (child, url, api_key_file) = match server::spawn(&saved, &api_key, err, &resolved_gpu) {
        Ok(value) => value,
        Err(error) => {
            let mut server = target
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            if !server.is_current_launch(launch_generation) {
                return Err("server start cancelled".into());
            }
            server.lifecycle = if state.exiting.load(Ordering::Acquire) {
                server::Lifecycle::Stopped
            } else {
                server::Lifecycle::Failed
            };
            server.last_error = Some(error.clone());
            return Err(error);
        }
    };

    {
        let mut server = target
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if !server.is_current_launch(launch_generation) || state.exiting.load(Ordering::Acquire) {
            let mut orphan = Some(child);
            server::kill(&mut orphan, Some(err.clone()));
            server::cleanup_api_key_file(api_key_file.as_deref());
            server.lifecycle = server::Lifecycle::Stopped;
            server.url.clear();
            server.api_key.clear();
            server.redaction_secret.clear();
            server.model.clear();
            server.mmproj.clear();
            server.draft_model.clear();
            return Err(if state.exiting.load(Ordering::Acquire) {
                "application is exiting".into()
            } else {
                "server start cancelled".into()
            });
        }
        server.attach_starting(
            child,
            url.clone(),
            api_key.clone(),
            saved.active_model.clone(),
            saved.mmproj.clone(),
            if tuning_defaults::speculative_enabled(&saved) {
                saved.spec_draft_model.clone()
            } else {
                String::new()
            },
        );
    }

    match server::wait_ready(target.clone(), &url, &api_key, 120, err).await {
        Ok(()) => {
            let mut server = target
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            if !server.is_current_launch(launch_generation) || state.exiting.load(Ordering::Acquire)
            {
                server::kill(&mut server.child, Some(err.clone()));
                server::cleanup_api_key_file(api_key_file.as_deref());
                server.url.clear();
                server.api_key.clear();
                server.redaction_secret.clear();
                server.mmproj.clear();
                server.draft_model.clear();
                server.lifecycle = server::Lifecycle::Stopped;
                return Err(if state.exiting.load(Ordering::Acquire) {
                    "application is exiting".into()
                } else {
                    "server start cancelled".into()
                });
            }
            server.lifecycle = server::Lifecycle::Ready;
            server.execution = Some(saved.clone());
            server.last_error = None;
            server.touch_activity();
            server::cleanup_api_key_file(api_key_file.as_deref());
            Ok(url)
        }
        Err(error) => {
            let mut server = target
                .lock()
                .map_err(|_| "server state lock was poisoned".to_string())?;
            if !server.is_current_launch(launch_generation) {
                server::cleanup_api_key_file(api_key_file.as_deref());
                return Err("server start cancelled".into());
            }
            server::kill(&mut server.child, None);
            server::cleanup_api_key_file(api_key_file.as_deref());
            server.url = url;
            server.api_key.clear();
            server.mmproj.clear();
            server.draft_model.clear();
            server.lifecycle = if state.exiting.load(Ordering::Acquire) {
                server.url.clear();
                server::Lifecycle::Stopped
            } else {
                server::Lifecycle::Failed
            };
            server.last_error = Some(error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn start_server(
    state: State<'_, AppState>,
    cfg: config::AppConfig,
) -> Result<String, String> {
    let pending = state
        .sessions
        .begin_pending_start(session::DEFAULT_SESSION_ID)?;
    let launch_cancel = pending.cancel_flag();
    let _operation = state.operation.lock().await;
    if launch_cancel.load(Ordering::Acquire) {
        return Err("server start cancelled".into());
    }
    ensure_no_active_requests(
        &state,
        session::DEFAULT_SESSION_ID,
        cfg.stop_existing_sessions_on_load,
    )?;
    let prepared = prepare_launch(&state, cfg, true, &launch_cancel).await?;
    ensure_no_active_requests(
        &state,
        session::DEFAULT_SESSION_ID,
        prepared.cfg.stop_existing_sessions_on_load,
    )?;
    if prepared.cfg.stop_existing_sessions_on_load {
        let ids = state.sessions.ids();
        for id in session::ids_to_stop_for_policy(&ids, session::DEFAULT_SESSION_ID) {
            ensure_no_active_requests(&state, session::DEFAULT_SESSION_ID, true)?;
            stop_session_by_id(&state, &id).await?;
        }
    }
    let target = state.server.clone();
    let err = state.err.clone();
    start_on_target(&state, &target, &err, prepared, true, &launch_cancel).await
}

/// Tear down one session's process and reset it to `Stopped`. Shared by the
/// legacy `stop_server` command (the default session, which also owns the
/// Anthropic gateway proxying it) and `session_stop`/`session_unload` (an
/// extra session, which never has a gateway of its own).
fn stop_target(server: &mut server::ServerState, err: &Arc<server::ErrBuf>) {
    server.lifecycle = server::Lifecycle::Stopping;
    server::kill(&mut server.child, Some(err.clone()));
    server.cancel_launch();
    server.url.clear();
    server.api_key.clear();
    server.redaction_secret.clear();
    server.model.clear();
    server.mmproj.clear();
    server.draft_model.clear();
    server.last_error = None;
    server.active_requests = 0;
    server.touch_activity();
}

/// Stop the default session or one tracked extra session by id. Stopping an
/// id nothing is tracked under is a no-op success: it is already stopped as
/// far as any caller can observe.
pub(super) async fn stop_session_by_id(state: &AppState, id: &str) -> Result<(), String> {
    // A policy-driven stop must also invalidate starts queued behind the
    // operation lock, otherwise they could launch after the replacement.
    state.sessions.cancel_pending_start(id);
    if id == session::DEFAULT_SESSION_ID {
        let gateway = state
            .gateway
            .lock()
            .map_err(|_| "gateway state lock was poisoned".to_string())?
            .take();
        if let Some(gateway) = gateway {
            gateway::stop(gateway).await;
        }
        let mut server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        stop_target(&mut server, &state.err);
        return Ok(());
    }
    let Some(entry) = state.sessions.get(id) else {
        return Ok(());
    };
    let mut server = entry
        .state
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    stop_target(&mut server, &entry.err);
    Ok(())
}

#[tauri::command]
pub(crate) async fn stop_server(state: State<'_, AppState>) -> Result<(), String> {
    state
        .sessions
        .cancel_pending_start(session::DEFAULT_SESSION_ID);
    stop_session_by_id(&state, session::DEFAULT_SESSION_ID).await
}

#[tauri::command]
pub(crate) async fn unload_model(state: State<'_, AppState>) -> Result<(), String> {
    // llama-server is configured as a single-model process in this app. A
    // safe unload tears down the process instead of claiming the model remains resident.
    stop_server(state).await
}

#[tauri::command]
pub(crate) async fn server_activity(
    state: State<'_, AppState>,
    phase: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let target = activity_target(&state, session_id.as_deref())?;
    let mut server = target
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    if server.lifecycle != server::Lifecycle::Ready {
        return Err("server is not ready for activity tracking".into());
    }
    match phase.as_str() {
        "start" => server.begin_request(),
        "end" => server.end_request(),
        "touch" => server.touch_activity(),
        _ => return Err("server activity phase must be start, end, or touch".into()),
    }
    Ok(())
}

fn activity_target(
    state: &AppState,
    session_id: Option<&str>,
) -> Result<Arc<Mutex<server::ServerState>>, String> {
    match session_id.map(str::trim).filter(|id| !id.is_empty()) {
        None | Some(session::DEFAULT_SESSION_ID) => Ok(state.server.clone()),
        Some(id) => state
            .sessions
            .get(id)
            .map(|entry| entry.state.clone())
            .ok_or_else(|| format!("session is not running: {id}")),
    }
}

#[tauri::command]
pub(crate) async fn apply_request_settings(
    state: State<'_, AppState>,
    cfg: config::AppConfig,
    session_id: Option<String>,
) -> Result<config::execution::ExecutionSettings, String> {
    let _operation = state.operation.lock().await;
    let target = activity_target(&state, session_id.as_deref())?;
    let mut server = target
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    if server.lifecycle != server::Lifecycle::Ready {
        return Err("server is not ready for request settings".into());
    }
    let live = server
        .execution
        .as_ref()
        .ok_or_else(|| "running execution settings are unavailable".to_string())?;
    let next = config::execution::apply_request_settings(live, &cfg)?;
    let snapshot = config::execution::snapshot(&next);
    server.execution = Some(next);
    Ok(snapshot)
}

async fn unload_idle_server(state: &AppState) -> bool {
    let _operation = state.operation.lock().await;
    let (gateway_running, gateway_active) = {
        let gateway = state.gateway.lock().ok();
        (
            gateway.as_ref().is_some_and(|value| value.is_some()),
            gateway
                .as_ref()
                .and_then(|value| {
                    value
                        .as_ref()
                        .map(|handle| handle.active_requests.load(Ordering::Acquire))
                })
                .unwrap_or(0),
        )
    };
    let should_unload = {
        let Ok(mut server) = state.server.lock() else {
            return false;
        };
        if server.lifecycle != server::Lifecycle::Ready
            || gateway_running
            || gateway_active > 0
            || !server
                .execution
                .as_ref()
                .is_some_and(|cfg| server.auto_unload_due(tuning_defaults::app_idle_timeout(cfg)))
        {
            return false;
        }
        server.lifecycle = server::Lifecycle::Stopping;
        server::kill(&mut server.child, Some(state.err.clone()));
        server.url.clear();
        server.api_key.clear();
        server.redaction_secret.clear();
        server.model.clear();
        server.mmproj.clear();
        server.draft_model.clear();
        server.execution = None;
        server.active_requests = 0;
        server.touch_activity();
        server.last_error = None;
        server.lifecycle = server::Lifecycle::Stopped;
        true
    };
    if !should_unload {
        return false;
    }
    let gateway = state
        .gateway
        .lock()
        .ok()
        .and_then(|mut gateway| gateway.take());
    state.err.clear();
    if let Some(gateway) = gateway {
        gateway::stop(gateway).await;
    }
    true
}

async fn unload_idle_named_sessions(state: &AppState) {
    let _operation = state.operation.lock().await;
    for entry in state.sessions.entries() {
        let Ok(mut server) = entry.state.lock() else {
            continue;
        };
        if server.lifecycle == server::Lifecycle::Ready
            && server
                .execution
                .as_ref()
                .is_some_and(|cfg| server.auto_unload_due(tuning_defaults::app_idle_timeout(cfg)))
        {
            stop_target(&mut server, &entry.err);
            entry.err.clear();
        }
    }
}

pub(crate) async fn idle_watchdog(app: tauri::AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(state) = app.try_state::<AppState>() else {
            break;
        };
        if state.exiting.load(Ordering::Acquire) {
            break;
        }
        let _ = unload_idle_server(&state).await;
        unload_idle_named_sessions(&state).await;
    }
}

#[tauri::command]
pub(crate) fn server_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut server = state
        .server
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    server::reap_if_exited(&mut server, &state.err);

    let mut response = serde_json::Map::new();
    response.insert("state".into(), server.lifecycle.as_str().into());
    response.insert("active_requests".into(), server.active_requests.into());
    response.insert("idle_seconds".into(), server.idle_seconds().into());
    if let Some(execution) = &server.execution {
        response.insert(
            "execution".into(),
            config::execution::snapshot(execution).into(),
        );
    }
    if !server.url.is_empty() {
        response.insert("url".into(), server.url.clone().into());
    }
    if !server.model.is_empty() {
        response.insert("model".into(), server.model.clone().into());
    }
    if server.lifecycle == server::Lifecycle::Ready && !server.api_key.is_empty() {
        response.insert("api_key".into(), server.api_key.clone().into());
        if !server.mmproj.is_empty() {
            response.insert("mmproj".into(), server.mmproj.clone().into());
        }
    }
    if let Some(child) = server.child.as_ref() {
        response.insert("pid".into(), child.id().into());
    }
    let log_tail = state.err.tail();
    if !log_tail.trim().is_empty() {
        response.insert("log_tail".into(), log_tail.into());
    }
    if let Some(error) = &server.last_error {
        response.insert(
            "error".into(),
            server::redact_text(error, &server.redaction_secret).into(),
        );
    }
    if let Some(cfg) = server
        .execution
        .clone()
        .or_else(|| config::load_result().ok())
    {
        response.insert(
            "memory".into(),
            if tuning_defaults::inherited(&cfg, "ctx_size")
                || tuning_defaults::inherited(&cfg, "parallel")
            {
                serde_json::Value::Null
            } else {
                serde_json::to_value(server::estimate_status_memory(&cfg, &server))
                    .unwrap_or(serde_json::Value::Null)
            },
        );
        response.insert(
            "lifecycle".into(),
            serde_json::json!({
                "sleep_idle_seconds": tuning_defaults::app_idle_timeout(&cfg),
                "request_timeout_seconds": cfg.request_timeout_seconds,
                "parallel": if tuning_defaults::inherited(&cfg, "parallel") { 0 } else { cfg.parallel },
                "active_requests": server.active_requests,
                "idle_seconds": server.idle_seconds(),
                "auto_unload_due": server.auto_unload_due(tuning_defaults::app_idle_timeout(&cfg)),
                "effective_model": if server.model.is_empty() { serde_json::Value::Null } else { server.model.clone().into() },
                "effective_backend": if cfg.active_backend.is_empty() { serde_json::Value::Null } else { cfg.active_backend.into() },
            }),
        );
    }
    if server.lifecycle == server::Lifecycle::Crashed {
        abort_gateway_now(&state);
    }
    Ok(response.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_activity_guard_respects_target_and_stop_existing_policy() {
        let state = AppState::default();
        let work = state.sessions.get_or_create("work", "Work").unwrap();
        {
            let mut server = work.state.lock().unwrap();
            server.lifecycle = server::Lifecycle::Ready;
            server.active_requests = 1;
        }
        assert!(ensure_no_active_requests(&state, "default", true).is_err());
        assert!(ensure_no_active_requests(&state, "work", false).is_err());
        assert!(ensure_no_active_requests(&state, "other", true).is_err());
        assert!(ensure_no_active_requests(&state, "default", false).is_ok());
        assert!(ensure_no_active_requests(&state, "other", false).is_ok());
        assert_eq!(work.state.lock().unwrap().active_requests, 1);
        assert_eq!(
            work.state.lock().unwrap().lifecycle,
            server::Lifecycle::Ready
        );

        work.state.lock().unwrap().active_requests = 0;
        assert!(ensure_no_active_requests(&state, "default", true).is_ok());
        {
            let mut default = state.server.lock().unwrap();
            default.lifecycle = server::Lifecycle::Ready;
            default.begin_request();
        }
        assert!(ensure_no_active_requests(&state, "default", false).is_err());
        assert!(ensure_no_active_requests(&state, "work", true).is_err());
        assert!(ensure_no_active_requests(&state, "work", false).is_ok());
    }

    #[tokio::test]
    async fn prepared_launch_rechecks_activity_before_replacing_its_target() {
        let state = AppState::default();
        assert!(ensure_no_active_requests(&state, "default", false).is_ok());
        {
            let mut current = state.server.lock().unwrap();
            current.lifecycle = server::Lifecycle::Ready;
            current.model = "current.gguf".into();
            current.begin_request();
        }
        let prepared = PreparedLaunch {
            cfg: config::AppConfig::default(),
            gpu: gpu::ResolvedGpu::default(),
        };
        let result = start_on_target(
            &state,
            &state.server,
            &state.err,
            prepared,
            false,
            &Arc::new(AtomicBool::new(false)),
        )
        .await;
        assert!(result.unwrap_err().contains("active response"));
        let current = state.server.lock().unwrap();
        assert_eq!(current.lifecycle, server::Lifecycle::Ready);
        assert_eq!(current.model, "current.gguf");
        assert_eq!(current.active_requests, 1);
    }

    #[tokio::test]
    async fn invalid_replacement_keeps_current_and_other_sessions_untouched() {
        let state = AppState::default();
        {
            let mut current = state.server.lock().unwrap();
            current.lifecycle = server::Lifecycle::Ready;
            current.model = "current.gguf".into();
            current.execution = Some(config::AppConfig {
                active_model: "current.gguf".into(),
                ..Default::default()
            });
        }
        let other = state.sessions.get_or_create("other", "Other").unwrap();
        other.state.lock().unwrap().lifecycle = server::Lifecycle::Ready;
        let replacement = config::AppConfig {
            active_backend: "cpu".into(),
            active_build: "b123".into(),
            ..config::AppConfig::default()
        };
        let result =
            prepare_launch(&state, replacement, true, &Arc::new(AtomicBool::new(false))).await;
        assert!(result.err().unwrap().contains("select a GGUF model"));
        let current = state.server.lock().unwrap();
        assert_eq!(current.lifecycle, server::Lifecycle::Ready);
        assert_eq!(current.model, "current.gguf");
        assert_eq!(
            current.execution.as_ref().unwrap().active_model,
            "current.gguf"
        );
        assert_eq!(
            other.state.lock().unwrap().lifecycle,
            server::Lifecycle::Ready
        );
    }

    #[test]
    fn activity_targets_never_fall_back_from_an_unknown_named_session() {
        let state = AppState::default();
        let named = state.sessions.get_or_create("named", "Named").unwrap();
        assert!(Arc::ptr_eq(
            &activity_target(&state, None).unwrap(),
            &state.server
        ));
        assert!(Arc::ptr_eq(
            &activity_target(&state, Some("default")).unwrap(),
            &state.server
        ));
        assert!(Arc::ptr_eq(
            &activity_target(&state, Some("named")).unwrap(),
            &named.state
        ));
        assert!(activity_target(&state, Some("missing")).is_err());
    }

    #[tokio::test]
    async fn named_idle_policy_uses_live_settings_and_spares_active_requests() {
        let state = AppState::default();
        let idle = state.sessions.get_or_create("idle", "Idle").unwrap();
        let busy = state.sessions.get_or_create("busy", "Busy").unwrap();
        for entry in [&idle, &busy] {
            let mut server = entry.state.lock().unwrap();
            server.lifecycle = server::Lifecycle::Ready;
            server.execution = Some(config::AppConfig {
                sleep_idle_seconds: 1,
                ..Default::default()
            });
            server.last_activity_at = std::time::Instant::now() - Duration::from_secs(10);
        }
        busy.state.lock().unwrap().active_requests = 1;
        unload_idle_named_sessions(&state).await;
        assert_eq!(
            idle.state.lock().unwrap().lifecycle,
            server::Lifecycle::Stopped
        );
        assert!(idle.state.lock().unwrap().execution.is_none());
        assert_eq!(
            busy.state.lock().unwrap().lifecycle,
            server::Lifecycle::Ready
        );
    }
}
