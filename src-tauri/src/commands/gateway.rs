//! External API listener lifecycle IPC.
//!
//! The listener belongs to the app, not to any model process. These commands
//! never take the global model `operation` mutex, so the API stays
//! controllable while a model is loading, and stopping the API never unloads a
//! model. The legacy Anthropic gateway commands remain as aliases of the same
//! listener.
use crate::{config, gateway, state::AppState};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::State;

#[derive(Serialize, Clone, PartialEq)]
pub(crate) struct ApiServerStatus {
    pub running: bool,
    /// OpenAI-style base URL, ending in `/v1`. Present only while running.
    pub url: Option<String>,
    /// The application-lifetime key clients must present. Present only while
    /// running; never persisted.
    pub api_key: Option<String>,
    /// The bound port while running, otherwise the port the next start uses.
    pub port: u16,
}

impl std::fmt::Debug for ApiServerStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ApiServerStatus")
            .field("running", &self.running)
            .field("url", &self.url)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("port", &self.port)
            .finish()
    }
}

fn api_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

/// The port saved in the settings, or the product default when the settings
/// cannot be read.
fn configured_port() -> u16 {
    config::load_result()
        .map(|cfg| cfg.port)
        .unwrap_or_else(|_| config::AppConfig::default().port)
}

fn status_of(
    state: &AppState,
    configured_port: impl FnOnce() -> u16,
) -> Result<ApiServerStatus, String> {
    let gateway = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?;
    Ok(
        match gateway.as_ref().filter(|handle| handle.is_running()) {
            Some(handle) => ApiServerStatus {
                running: true,
                url: Some(api_url(handle.port)),
                api_key: Some(state.api_key.to_string()),
                port: handle.port,
            },
            None => ApiServerStatus {
                running: false,
                url: None,
                api_key: None,
                port: configured_port(),
            },
        },
    )
}

/// Start the listener on `port` unless it is already running, in which case
/// the running listener is reported unchanged.
async fn start_api(state: &AppState, port: u16) -> Result<ApiServerStatus, String> {
    let _control = state.api_control.lock().await;
    if state.exiting.load(Ordering::Acquire) {
        return Err("application is exiting".into());
    }
    let running = state
        .gateway
        .lock()
        .map_err(|_| "gateway state lock was poisoned".to_string())?
        .as_ref()
        .is_some_and(|handle| handle.is_running());
    if !running {
        let handle = gateway::start(state.model_source(), state.api_key.clone(), port).await?;
        publish(state, handle).await?;
    }
    status_of(state, || port)
}

/// Make a freshly started listener the running one, unless the application
/// began exiting in the meantime. Shutdown raises `exiting` before it takes the
/// listener under the same lock, so checking under that lock means shutdown
/// either sees this listener and stops it, or this refuses and stops it here.
async fn publish(state: &AppState, handle: gateway::GatewayHandle) -> Result<(), String> {
    let refused = {
        // A poisoned lock still holds a usable slot; refusing to publish would
        // leave a running listener that nothing can stop.
        let mut slot = state
            .gateway
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.exiting.load(Ordering::Acquire) {
            Some(handle)
        } else {
            slot.replace(handle);
            None
        }
    };
    match refused {
        Some(handle) => {
            gateway::stop(handle).await;
            Err("application is exiting".into())
        }
        None => Ok(()),
    }
}

/// Stop the listener and its open connections. Model processes are untouched.
async fn stop_api(state: &AppState) -> Result<(), String> {
    let _control = state.api_control.lock().await;
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
pub(crate) async fn start_api_server(
    state: State<'_, AppState>,
) -> Result<ApiServerStatus, String> {
    start_api(&state, config::load_result()?.port).await
}

#[tauri::command]
pub(crate) async fn stop_api_server(state: State<'_, AppState>) -> Result<(), String> {
    stop_api(&state).await
}

#[tauri::command]
pub(crate) fn api_server_status(state: State<'_, AppState>) -> Result<ApiServerStatus, String> {
    status_of(&state, configured_port)
}

/// Legacy alias: the Anthropic endpoint of the unified listener.
fn legacy_messages_url(status: &ApiServerStatus) -> Option<String> {
    status.url.as_ref().map(|url| format!("{url}/messages"))
}

#[tauri::command]
pub(crate) async fn start_anthropic_gateway(state: State<'_, AppState>) -> Result<String, String> {
    let status = start_api(&state, config::load_result()?.port).await?;
    legacy_messages_url(&status).ok_or_else(|| "the API listener did not start".to_string())
}

#[tauri::command]
pub(crate) async fn stop_anthropic_gateway(state: State<'_, AppState>) -> Result<(), String> {
    stop_api(&state).await
}

#[tauri::command]
pub(crate) fn anthropic_gateway_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let status = status_of(&state, configured_port)?;
    Ok(serde_json::json!({
        "running": status.running,
        "url": legacy_messages_url(&status),
    }))
}

/// Tear the listener down without waiting, for the process-exit path. Model
/// processes are stopped separately.
pub(crate) fn abort_gateway_now(state: &AppState) {
    if let Ok(mut gateway) = state.gateway.lock() {
        if let Some(handle) = gateway.take() {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Lifecycle;
    use std::time::Duration;

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    async fn models_status(client: &reqwest::Client, status: &ApiServerStatus) -> u16 {
        client
            .get(format!("{}/models", status.url.as_ref().unwrap()))
            .bearer_auth(status.api_key.as_ref().unwrap())
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    fn mark_ready(state: &AppState, url: &str, key: &str, model: &str) {
        let mut server = state.server.lock().unwrap();
        server.lifecycle = Lifecycle::Ready;
        server.url = url.into();
        server.api_key = key.into();
        server.model = model.into();
    }

    #[tokio::test]
    async fn a_stopped_api_reports_no_url_or_key_and_the_configured_port() {
        let state = AppState::default();
        let status = status_of(&state, || 8080).unwrap();
        assert_eq!(
            status,
            ApiServerStatus {
                running: false,
                url: None,
                api_key: None,
                port: 8080,
            }
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"running":false,"url":null,"api_key":null,"port":8080})
        );
    }

    #[tokio::test]
    async fn the_api_starts_with_zero_models_and_start_is_idempotent() {
        let state = AppState::default();
        let started = start_api(&state, 0).await.unwrap();
        assert!(started.running);
        assert_ne!(started.port, 0);
        assert_eq!(
            started.url.as_deref(),
            Some(format!("http://127.0.0.1:{}/v1", started.port).as_str())
        );
        assert_eq!(started.api_key.as_deref(), Some(&*state.api_key));
        let again = start_api(&state, 0).await.unwrap();
        assert_eq!(again, started, "a second start must not rebind");
        assert_eq!(status_of(&state, || 0).unwrap(), started);
        let models = client()
            .get(format!("{}/models", started.url.as_ref().unwrap()))
            .bearer_auth(&*state.api_key)
            .send()
            .await
            .unwrap();
        assert_eq!(models.status(), 200);
        let body: serde_json::Value = models.json().await.unwrap();
        assert_eq!(body, serde_json::json!({"object":"list","data":[]}));
        stop_api(&state).await.unwrap();
    }

    #[tokio::test]
    async fn stopping_the_api_frees_the_port_and_leaves_models_loaded() {
        let state = AppState::default();
        mark_ready(&state, "http://127.0.0.1:9/v1", "worker-key", "m.gguf");
        let started = start_api(&state, 0).await.unwrap();
        stop_api(&state).await.unwrap();
        stop_api(&state).await.unwrap();
        let stopped = status_of(&state, || 4321).unwrap();
        assert!(!stopped.running && stopped.url.is_none() && stopped.api_key.is_none());
        assert_eq!(stopped.port, 4321);
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", started.port))
                .await
                .is_err(),
            "the public port must be released"
        );
        {
            let server = state.server.lock().unwrap();
            assert_eq!(server.lifecycle, Lifecycle::Ready);
            assert_eq!(server.model, "m.gguf");
            assert_eq!(server.api_key, "worker-key");
        }
        // The same port can be taken again right away.
        let restarted = start_api(&state, started.port).await.unwrap();
        assert_eq!(restarted.port, started.port);
        stop_api(&state).await.unwrap();
    }

    #[tokio::test]
    async fn the_external_key_survives_model_replacement_and_api_restart() {
        let state = AppState::default();
        let first = start_api(&state, 0).await.unwrap();
        let client = client();
        assert_eq!(models_status(&client, &first).await, 200);

        mark_ready(&state, "http://127.0.0.1:9/v1", "worker-key-1", "a.gguf");
        assert_eq!(models_status(&client, &first).await, 200);
        // Replacing the model rotates the private worker key only.
        mark_ready(&state, "http://127.0.0.1:10/v1", "worker-key-2", "b.gguf");
        assert_eq!(models_status(&client, &first).await, 200);

        stop_api(&state).await.unwrap();
        let second = start_api(&state, 0).await.unwrap();
        assert_eq!(second.api_key, first.api_key);
        assert_eq!(models_status(&client, &second).await, 200);

        let private = client
            .get(format!("{}/models", second.url.as_ref().unwrap()))
            .bearer_auth("worker-key-2")
            .send()
            .await
            .unwrap();
        assert_eq!(private.status(), 401, "a worker key must not open the API");
        stop_api(&state).await.unwrap();
    }

    #[tokio::test]
    async fn a_port_that_is_taken_is_reported_and_leaves_the_api_stopped() {
        let state = AppState::default();
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let error = start_api(&state, port).await.unwrap_err();
        assert!(error.contains(&format!("127.0.0.1:{port}")), "{error}");
        assert!(!status_of(&state, || port).unwrap().running);
        drop(occupied);
        assert!(start_api(&state, port).await.unwrap().running);
        stop_api(&state).await.unwrap();
    }

    #[tokio::test]
    async fn the_api_stays_controllable_while_a_model_operation_holds_the_global_lock() {
        let state = AppState::default();
        let _model_operation = state.operation.lock().await;
        let started = tokio::time::timeout(Duration::from_secs(5), start_api(&state, 0))
            .await
            .expect("start must not wait for the model operation")
            .unwrap();
        assert!(started.running);
        tokio::time::timeout(Duration::from_secs(5), stop_api(&state))
            .await
            .expect("stop must not wait for the model operation")
            .unwrap();
    }

    #[tokio::test]
    async fn a_listener_that_finishes_starting_after_exit_began_is_stopped_not_kept() {
        let state = AppState::default();
        let handle = gateway::start(state.model_source(), state.api_key.clone(), 0)
            .await
            .unwrap();
        let port = handle.port;
        // Exit begins between "listener started" and "listener published".
        state.begin_normal_exit();
        assert!(publish(&state, handle).await.is_err());
        assert!(state.gateway.lock().unwrap().is_none());
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "the refused listener must not keep its port"
        );
    }

    #[tokio::test]
    async fn a_start_after_exit_began_is_refused() {
        let state = AppState::default();
        state.begin_normal_exit();
        assert!(start_api(&state, 0).await.is_err());
        assert!(!status_of(&state, || 0).unwrap().running);
    }

    #[tokio::test]
    async fn the_exit_path_drops_the_listener_without_waiting() {
        let state = AppState::default();
        let started = start_api(&state, 0).await.unwrap();
        abort_gateway_now(&state);
        assert!(!status_of(&state, || 0).unwrap().running);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while tokio::net::TcpStream::connect(("127.0.0.1", started.port))
            .await
            .is_ok()
        {
            assert!(std::time::Instant::now() < deadline, "listener lingered");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn the_legacy_gateway_url_is_the_messages_route_of_the_unified_listener() {
        let running = ApiServerStatus {
            running: true,
            url: Some("http://127.0.0.1:8080/v1".into()),
            api_key: Some("k".into()),
            port: 8080,
        };
        assert_eq!(
            legacy_messages_url(&running).as_deref(),
            Some("http://127.0.0.1:8080/v1/messages")
        );
        let stopped = ApiServerStatus {
            running: false,
            url: None,
            api_key: None,
            port: 8080,
        };
        assert_eq!(legacy_messages_url(&stopped), None);
    }

    #[test]
    fn debug_output_never_contains_the_api_key() {
        let status = ApiServerStatus {
            running: true,
            url: Some("http://127.0.0.1:8080/v1".into()),
            api_key: Some("sk-secret-value".into()),
            port: 8080,
        };
        let rendered = format!("{status:?}");
        assert!(!rendered.contains("sk-secret-value"));
        assert!(rendered.contains("[REDACTED]"));
    }
}
