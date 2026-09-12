//! Named session IPC and port selection.
use super::server::{
    ensure_no_active_requests, prepare_launch, start_on_target, stop_session_by_id,
};
use crate::{config, server, session, state::AppState};
use std::path::Path;
use std::sync::atomic::Ordering;
use tauri::State;
use uuid::Uuid;

fn session_ports_excluding(state: &AppState, exclude_id: &str) -> Vec<u16> {
    let mut ports = state.sessions.claimed_ports_excluding(exclude_id);
    if exclude_id != session::DEFAULT_SESSION_ID {
        if let Ok(server) = state.server.lock() {
            if server.lifecycle != server::Lifecycle::Stopped {
                if let Some(port) = server::port_from_url(&server.url) {
                    ports.push(port);
                }
            }
        }
    }
    ports
}

/// Load one session's model bundle, honoring the "stop existing sessions on
/// load" policy (`stop_existing` overrides the persisted default for this
/// call only). `session_id` may be `"default"`/empty to (re)start the
/// legacy single session, an existing tracked id to restart it in place, or
/// a new id (typically a UUID the frontend generates) to start an
/// additional session alongside whatever is already running.
#[tauri::command]
pub(crate) async fn session_start(
    state: State<'_, AppState>,
    session_id: String,
    cfg: config::AppConfig,
    stop_existing: Option<bool>,
) -> Result<session::SessionStatus, String> {
    let id = {
        let trimmed = session_id.trim();
        if trimmed.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            trimmed.to_string()
        }
    };
    let pending = state.sessions.begin_pending_start(&id)?;
    let launch_cancel = pending.cancel_flag();
    let _operation = state.operation.lock().await;
    if launch_cancel.load(Ordering::Acquire) {
        return Err("server start cancelled".into());
    }
    let policy = match stop_existing {
        Some(explicit) => explicit,
        None => config::load_result()?.stop_existing_sessions_on_load,
    };
    ensure_no_active_requests(&state, &id, policy)?;
    let name = Path::new(cfg.active_model.trim())
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| id.clone());

    let mut prepared = prepare_launch(
        &state,
        cfg,
        id == session::DEFAULT_SESSION_ID,
        &launch_cancel,
    )
    .await?;
    if id != session::DEFAULT_SESSION_ID {
        prepared.cfg.port =
            session::effective_port(prepared.cfg.port, &session_ports_excluding(&state, &id))?;
    }

    ensure_no_active_requests(&state, &id, policy)?;
    if policy {
        let mut all_ids = state.sessions.ids();
        all_ids.push(session::DEFAULT_SESSION_ID.to_string());
        for other in session::ids_to_stop_for_policy(&all_ids, &id) {
            ensure_no_active_requests(&state, &id, true)?;
            stop_session_by_id(&state, &other).await?;
        }
    }
    if launch_cancel.load(Ordering::Acquire) {
        return Err("server start cancelled".into());
    }

    if id == session::DEFAULT_SESSION_ID {
        let target = state.server.clone();
        let err = state.err.clone();
        start_on_target(&state, &target, &err, prepared, true, &launch_cancel).await?;
        let mut server = target
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        return Ok(session::build_status(
            session::DEFAULT_SESSION_ID,
            "default",
            &mut server,
            &err,
        ));
    }

    let entry = state.sessions.get_or_create(&id, &name)?;
    *entry
        .name
        .lock()
        .map_err(|_| "session name lock was poisoned".to_string())? = name.clone();
    start_on_target(
        &state,
        &entry.state,
        &entry.err,
        prepared,
        false,
        &launch_cancel,
    )
    .await?;
    let mut server = entry
        .state
        .lock()
        .map_err(|_| "server state lock was poisoned".to_string())?;
    Ok(session::build_status(&id, &name, &mut server, &entry.err))
}

#[tauri::command]
pub(crate) async fn session_stop(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let id = session_id.trim();
    let id = if id.is_empty() {
        session::DEFAULT_SESSION_ID
    } else {
        id
    };
    state.sessions.cancel_pending_start(id);
    stop_session_by_id(&state, id).await
}

/// Like `session_stop`, but also forgets a non-default session's tracking
/// entry entirely, freeing its id and port. The default session has no
/// separate "forgotten" state — it always exists as the one legacy slot.
#[tauri::command]
pub(crate) async fn session_unload(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let id = session_id.trim();
    let id = if id.is_empty() {
        session::DEFAULT_SESSION_ID
    } else {
        id
    };
    state.sessions.cancel_pending_start(id);
    stop_session_by_id(&state, id).await?;
    if id != session::DEFAULT_SESSION_ID {
        state.sessions.forget(id);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn session_list(
    state: State<'_, AppState>,
) -> Result<Vec<session::SessionStatus>, String> {
    let mut out = Vec::new();
    {
        let mut server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        out.push(session::build_status(
            session::DEFAULT_SESSION_ID,
            "default",
            &mut server,
            &state.err,
        ));
    }
    for entry in state.sessions.entries() {
        let name = entry.display_name();
        let mut server = entry
            .state
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        out.push(session::build_status(
            &entry.id,
            &name,
            &mut server,
            &entry.err,
        ));
    }
    Ok(out)
}
