//! Default server IPC, shared session lifecycle operations and idle tracking.
use super::gateway::abort_gateway_now;
use super::launch::validate_launch_config_with_cancel;
use crate::{config, gateway, server, session, state::AppState, tuning_defaults};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Manager, State};
use uuid::Uuid;

/// Launch one session's llama-server process onto `target`/`err` and wait for
/// it to become ready. Shared by the legacy `start_server` command (the
/// default session: `persist = true` writes the config file, `abort_gateway
/// = true` tears down the Anthropic gateway that proxies it) and
/// `session_start` (an extra session: never persisted, no gateway to abort).
/// Every lock scope and exit-mid-start check below is copied verbatim from
/// `start_server`'s original single-session body, just parameterized over
/// which `ServerState`/`ErrBuf` to drive.
pub(super) async fn start_on_target(
    state: &AppState,
    target: &Arc<Mutex<server::ServerState>>,
    err: &Arc<server::ErrBuf>,
    cfg: config::AppConfig,
    persist: bool,
    abort_gateway: bool,
    launch_cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
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
    let launch_generation = {
        let mut server = target
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
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

    let mut next = cfg;
    let resolved_gpu =
        match validate_launch_config_with_cancel(&mut next, Some(launch_cancel)).await {
            Ok(resolved) => resolved,
            Err(error) => {
                let mut server = target
                    .lock()
                    .map_err(|_| "server state lock was poisoned".to_string())?;
                if !server.is_current_launch(launch_generation) {
                    return Err("server start cancelled".into());
                }
                server.lifecycle = server::Lifecycle::Failed;
                server.last_error = Some(error.clone());
                return Err(error);
            }
        };
    {
        let server = target
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if !server.is_current_launch(launch_generation) {
            return Err("server start cancelled".into());
        }
    }
    let saved = if persist {
        let _config_write = state.config_write.lock().await;
        match config::save(&next) {
            Ok(saved) => saved,
            Err(error) => {
                let mut server = target
                    .lock()
                    .map_err(|_| "server state lock was poisoned".to_string())?;
                if !server.is_current_launch(launch_generation) {
                    return Err("server start cancelled".into());
                }
                server.lifecycle = server::Lifecycle::Failed;
                server.last_error = Some(error.clone());
                return Err(error);
            }
        }
    } else {
        next
    };
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
    if cfg.stop_existing_sessions_on_load {
        let ids = state.sessions.ids();
        for id in session::ids_to_stop_for_policy(&ids, session::DEFAULT_SESSION_ID) {
            stop_session_by_id(&state, &id).await?;
        }
    }
    let target = state.server.clone();
    let err = state.err.clone();
    start_on_target(&state, &target, &err, cfg, true, true, &launch_cancel).await
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
) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let mut server = state
        .server
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

async fn unload_idle_server(state: &AppState) -> bool {
    let _operation = state.operation.lock().await;
    let Some(cfg) = config::load_result().ok() else {
        return false;
    };
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
            || !server.auto_unload_due(tuning_defaults::app_idle_timeout(&cfg))
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
    if let Ok(cfg) = config::load_result() {
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
