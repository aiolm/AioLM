//! Anthropic gateway lifecycle IPC for the default server.
use crate::{gateway, server, state::AppState};
use std::sync::atomic::Ordering;
use tauri::State;

#[tauri::command]
pub(crate) async fn start_anthropic_gateway(state: State<'_, AppState>) -> Result<String, String> {
    let _operation = state.operation.lock().await;
    let old = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .take();
    if let Some(handle) = old {
        gateway::stop(handle).await;
    }
    let (upstream, upstream_key) = {
        let server = state
            .server
            .lock()
            .map_err(|_| "server state lock was poisoned".to_string())?;
        if server.lifecycle != server::Lifecycle::Ready
            || server.url.is_empty()
            || server.api_key.is_empty()
        {
            return Err("start llama-server before enabling the Anthropic gateway".into());
        }
        (server.url.clone(), server.api_key.clone())
    };
    let handle = gateway::start(upstream, upstream_key).await?;
    let url = format!("http://127.0.0.1:{}/v1/messages", handle.port);
    state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .replace(handle);
    Ok(url)
}

#[tauri::command]
pub(crate) async fn stop_anthropic_gateway(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let handle = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .take();
    if let Some(handle) = handle {
        gateway::stop(handle).await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn anthropic_gateway_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let gateway = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?;
    Ok(serde_json::json!({
        "running": gateway.is_some(),
        "url": gateway.as_ref().map(|handle| format!("http://127.0.0.1:{}/v1/messages", handle.port)),
    }))
}

pub(super) fn abort_gateway_now(state: &AppState) {
    if let Ok(mut gateway) = state.gateway.lock() {
        if let Some(handle) = gateway.take() {
            handle.stop.store(true, Ordering::Release);
            handle.task.abort();
        }
    }
}
