//! Fixed-origin bounded native HTTP for the publishing handshake.
//!
//! All requests derive from the configured service origin; only two fixed
//! paths are ever requested (`/v1/upload-sessions[/<id>]` and
//! `/v1/benchmark-runs`). One restricted client is shared across polls and
//! submits for connection/TLS pooling; only successful initialization is
//! cached, failures retry on the next call. The client follows no redirects,
//! keeps no cookies, applies a bound timeout and enforces response/URL size
//! limits. Owner and permit secrets travel only in request headers set here;
//! responses are validated before use and permits never leave native code.
//!
//! Handshake failures map to structured errors preserving the HTTP status,
//! the bounded server error code and Retry-After. Server bodies are parsed
//! for the machine-readable `{error:{code,message}}` shape only; raw bodies
//! are never copied into errors, so tokens cannot leak through this boundary.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::StreamExt;
use reqwest::{redirect::Policy, Url};
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;

use super::config;
use super::errors::SharingError;
use super::recovery::OWNER_SECRET_LEN;

pub(crate) const REQUEST_TIMEOUT_SECS: u64 = 30;
pub(crate) const MAX_SESSION_RESPONSE_BYTES: usize = 16 * 1024;
pub(crate) const MAX_SUBMIT_RESPONSE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETRY_AFTER_LEN: usize = 128;

fn build_restricted_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("cannot build publishing HTTP client: {error}"))
}

/// Fresh restricted client (tests and one-off use).
#[cfg(test)]
pub(crate) fn http_client() -> Result<reqwest::Client, SharingError> {
    build_restricted_client().map_err(|_| SharingError::network_error())
}

static SHARED_CLIENT: Mutex<Option<reqwest::Client>> = Mutex::new(None);

/// Shared restricted client for connection/TLS pooling. Only successful
/// initialization is cached (the client clones cheaply over an Arc); a build
/// failure stores nothing and retries on the next call.
pub(crate) fn shared_client() -> Result<reqwest::Client, SharingError> {
    let mut slot = SHARED_CLIENT
        .lock()
        .map_err(|_| SharingError::network_error())?;
    if let Some(client) = slot.clone() {
        return Ok(client);
    }
    let client = build_restricted_client().map_err(|_| SharingError::network_error())?;
    *slot = Some(client.clone());
    Ok(client)
}

fn bearer_header(secret: &[u8; OWNER_SECRET_LEN]) -> String {
    format!("Bearer {}", URL_SAFE_NO_PAD.encode(secret))
}

async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
) -> Result<(u16, Option<String>, Vec<u8>), SharingError> {
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_RETRY_AFTER_LEN
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii() && !byte.is_ascii_control())
        })
        .map(str::to_owned);
    if let Some(length) = response.content_length() {
        if length > limit as u64 {
            return Err(SharingError::invalid_response());
        }
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| SharingError::network_error())?;
        if bytes.len() + chunk.len() > limit {
            return Err(SharingError::invalid_response());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, retry_after, bytes))
}

#[derive(Deserialize)]
struct ServiceErrorEnvelope {
    error: ServiceErrorBody,
}

#[derive(Deserialize)]
struct ServiceErrorBody {
    code: String,
    #[allow(dead_code)]
    message: Option<String>,
}

/// Map a non-2xx handshake response to a structured error. Known recoverable
/// handshake codes keep their identity with status/Retry-After preserved;
/// anything else becomes a bounded network error with the status attached.
/// The raw body is never copied into the error.
fn handshake_error(status: u16, retry_after: Option<String>, body: &[u8]) -> SharingError {
    let service_code = serde_json::from_slice::<ServiceErrorEnvelope>(body)
        .ok()
        .map(|envelope| envelope.error.code)
        .unwrap_or_default();
    let mut error = match service_code.as_str() {
        "verification_required" => SharingError::verification_required(),
        "ownership_missing" => SharingError::ownership_missing(),
        _ => SharingError::network_error(),
    };
    error = error.with_status(status);
    if !service_code.is_empty() {
        error = error.with_service_code(&service_code);
    }
    if let Some(retry_after) = retry_after {
        error = error.with_retry_after(&retry_after);
    }
    error
}

#[derive(Deserialize)]
struct SessionCreated {
    session_id: String,
    verification_url: String,
    expires_at: String,
}

fn validate_token_field(value: &str, max: usize) -> Result<(), SharingError> {
    if value.is_empty() || value.len() > max || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(SharingError::invalid_response());
    }
    Ok(())
}

/// Publication body presented for binding or submission: non-empty UTF-8
/// within the 4 MiB whole-request budget. Returns the exact bytes.
pub(crate) fn submission_bytes(body: &str) -> Result<Vec<u8>, SharingError> {
    let bytes = body.as_bytes();
    if bytes.is_empty() {
        return Err(SharingError::binding_conflict_msg(
            "The publication body is empty.",
        ));
    }
    if bytes.len() > MAX_BODY_BYTES {
        return Err(SharingError::binding_conflict_msg(
            "The publication body exceeds the size limit.",
        ));
    }
    Ok(bytes.to_vec())
}

pub(crate) fn body_sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// Result of `POST <origin>/v1/upload-sessions`.
#[derive(Debug)]
pub(crate) struct CreatedSession {
    pub session_id: String,
    pub verification_url: String,
    pub expires_at: String,
}

pub(crate) async fn create_upload_session(
    client: &reqwest::Client,
    base: &Url,
    secret: &[u8; OWNER_SECRET_LEN],
    submission_id: &str,
    body_sha256: &str,
) -> Result<CreatedSession, SharingError> {
    let origin = config::origin_of(base);
    let url = config::session_collection(base);
    let response = client
        .post(url)
        .header("Authorization", bearer_header(secret))
        .header("Idempotency-Key", submission_id)
        .json(&serde_json::json!({
            "submission_id": submission_id,
            "body_sha256": body_sha256,
        }))
        .send()
        .await
        .map_err(|_| SharingError::network_error())?;
    let (status, retry_after, body) = read_bounded(response, MAX_SESSION_RESPONSE_BYTES).await?;
    if !(200..300).contains(&status) {
        return Err(handshake_error(status, retry_after, &body));
    }
    let created: SessionCreated =
        serde_json::from_slice(&body).map_err(|_| SharingError::invalid_response())?;
    config::validate_session_id(&created.session_id)
        .map_err(|_| SharingError::invalid_response())?;
    validate_token_field(&created.expires_at, 64)?;
    // The browser URL must equal the configured verification URL exactly.
    let verification_url =
        config::validate_verification_url(&origin, &created.session_id, &created.verification_url)
            .map_err(|_| SharingError::invalid_response())?;
    Ok(CreatedSession {
        session_id: created.session_id,
        verification_url,
        expires_at: created.expires_at,
    })
}

#[derive(Deserialize)]
struct SessionPolled {
    status: String,
    expires_at: String,
    #[serde(default)]
    permit: Option<String>,
}

/// Result of `GET <origin>/v1/upload-sessions/<id>`: status, expiry and an
/// optional permit that stays in native memory.
#[derive(Debug)]
pub(crate) struct PollOutcome {
    pub status: String,
    pub expires_at: String,
    pub permit: Option<String>,
}

pub(crate) async fn poll_upload_session(
    client: &reqwest::Client,
    base: &Url,
    secret: &[u8; OWNER_SECRET_LEN],
    session_id: &str,
) -> Result<PollOutcome, SharingError> {
    let url = config::session_resource(base, session_id)
        .map_err(|_| SharingError::binding_conflict_msg("The verification session is invalid."))?;
    let response = client
        .get(url)
        .header("Authorization", bearer_header(secret))
        .send()
        .await
        .map_err(|_| SharingError::network_error())?;
    let (status, retry_after, body) = read_bounded(response, MAX_SESSION_RESPONSE_BYTES).await?;
    if !(200..300).contains(&status) {
        return Err(handshake_error(status, retry_after, &body));
    }
    let polled: SessionPolled =
        serde_json::from_slice(&body).map_err(|_| SharingError::invalid_response())?;
    if !["pending", "verified", "expired"].contains(&polled.status.as_str()) {
        return Err(SharingError::invalid_response());
    }
    validate_token_field(&polled.expires_at, 64)?;
    if let Some(permit) = &polled.permit {
        validate_token_field(permit, 4096)?;
    }
    let outcome = PollOutcome {
        status: polled.status,
        expires_at: polled.expires_at,
        permit: polled.permit,
    };
    // Retry-After on a successful poll is informational only and
    // intentionally not surfaced; errors already returned above.
    let _ = retry_after;
    Ok(outcome)
}

/// Passthrough result of `POST <origin>/v1/benchmark-runs`. HTTP statuses,
/// machine-readable bodies and Retry-After are preserved, never discarded.
#[derive(Debug)]
pub(crate) struct SubmitOutcome {
    pub status: u16,
    pub body: String,
    pub retry_after: Option<String>,
}

pub(crate) async fn submit_benchmark_run(
    client: &reqwest::Client,
    base: &Url,
    secret: &[u8; OWNER_SECRET_LEN],
    permit: Option<&str>,
    submission_id: &str,
    body: &[u8],
) -> Result<SubmitOutcome, SharingError> {
    let mut request = client
        .post(config::submit_endpoint(base))
        .header("Authorization", bearer_header(secret))
        .header("Idempotency-Key", submission_id)
        .header("Content-Type", "application/json")
        .body(body.to_vec());
    if let Some(permit) = permit {
        request = request.header("X-Upload-Permit", permit);
    }
    let response = request
        .send()
        .await
        .map_err(|_| SharingError::network_error())?;
    let (status, retry_after, bytes) = read_bounded(response, MAX_SUBMIT_RESPONSE_BYTES).await?;
    let body = String::from_utf8(bytes).map_err(|_| SharingError::invalid_response())?;
    Ok(SubmitOutcome {
        status,
        body,
        retry_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Minimal single-purpose mock HTTP server. `handler` receives the raw
    /// request head plus body and returns (status, headers, body). Serves
    /// exactly `requests` connections, then stops.
    type MockHandler =
        dyn Fn(String, Vec<u8>) -> (u16, Vec<(&'static str, String)>, Vec<u8>) + Send + Sync;

    async fn mock_server(
        requests: usize,
        handler: impl Fn(String, Vec<u8>) -> (u16, Vec<(&'static str, String)>, Vec<u8>)
            + Send
            + Sync
            + 'static,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use std::sync::Arc;
        let handler: Arc<MockHandler> = Arc::new(handler);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = tokio::spawn(async move {
            for _ in 0..requests {
                let (mut socket, _) = listener.accept().await.unwrap();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if socket.read_exact(&mut byte).await.is_err() || head.len() > 64 * 1024 {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    let head_text = String::from_utf8_lossy(&head).into_owned();
                    let length = head_text
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("Content-Length:")
                                .or_else(|| line.strip_prefix("content-length:"))
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0)
                        .min(MAX_BODY_BYTES + 1);
                    let mut body = vec![0u8; length];
                    if length > 0 && socket.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    let (status, headers, response_body) = handler(head_text, body);
                    let reason = match status {
                        200 => "OK",
                        201 => "Created",
                        409 => "Conflict",
                        429 => "Too Many Requests",
                        _ => "Error",
                    };
                    let mut response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
                        response_body.len()
                    );
                    for (name, value) in headers {
                        response.push_str(&format!("{name}: {value}\r\n"));
                    }
                    response.push_str("\r\n");
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.write_all(&response_body).await;
                })
                .await
                .unwrap();
            }
        });
        (base, handle)
    }

    /// Mock server that accepts one connection and never responds, modelling
    /// an unresolved request for cancellation tests.
    async fn hanging_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 64 * 1024];
            let _ = socket.read(&mut buffer).await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
        });
        (base, handle)
    }

    fn test_secret() -> [u8; OWNER_SECRET_LEN] {
        [9u8; OWNER_SECRET_LEN]
    }

    fn test_base(url: &str) -> Url {
        config::validate_base_url(url).expect("test base URL")
    }

    #[tokio::test]
    async fn submit_binds_exact_body_and_headers() {
        let expected_body = br#"{"benchmark":{"submission_id":"123e4567-e89b-42d3-a456-426614174000"},"description_md":"hi"}"#.to_vec();
        let expected_bearer = format!("Bearer {}", URL_SAFE_NO_PAD.encode(test_secret()));
        let (base_url, server) = mock_server(1, move |head, body| {
            assert!(head.starts_with("POST /v1/benchmark-runs HTTP/1.1"));
            // Header names arrive lowercased on the wire; values are exact.
            let lower = head.to_lowercase();
            let auth = head
                .lines()
                .find(|line| line.to_lowercase().starts_with("authorization:"))
                .and_then(|line| line.split_once(':'))
                .map(|(_, value)| value.trim())
                .unwrap_or("");
            // The bearer value is base64url of the vault secret: the mock
            // recomputes it independently, so any key leak or truncation
            // fails the test.
            assert_eq!(auth, expected_bearer);
            assert!(lower.contains("idempotency-key: 123e4567-e89b-42d3-a456-426614174000"));
            assert!(lower.contains("x-upload-permit: permit-abc"));
            assert_eq!(body, expected_body);
            (
                201,
                vec![],
                br#"{"submission_id":"123e4567-e89b-42d3-a456-426614174000","id":"pub-1"}"#
                    .to_vec(),
            )
        })
        .await;
        let base = test_base(&base_url);
        let client = http_client().unwrap();
        let outcome = submit_benchmark_run(
            &client,
            &base,
            &test_secret(),
            Some("permit-abc"),
            "123e4567-e89b-42d3-a456-426614174000",
            br#"{"benchmark":{"submission_id":"123e4567-e89b-42d3-a456-426614174000"},"description_md":"hi"}"#,
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, 201);
        assert!(outcome.body.contains("pub-1"));
        assert_eq!(outcome.retry_after, None);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn submit_preserves_errors_retry_after_and_limits() {
        let (base_url, server) = mock_server(2, |head, _| {
            if head.contains("X-Upload-Permit") {
                panic!("replay without a permit must not attach the header");
            }
            (
                429,
                vec![("Retry-After", "120".into())],
                br#"{"error":{"code":"rate_limited","message":"slow down"}}"#.to_vec(),
            )
        })
        .await;
        let base = test_base(&base_url);
        let client = http_client().unwrap();
        // Accepted-replay path: no live permit, owner proof only. The
        // machine-readable body and Retry-After survive in the response.
        let outcome = submit_benchmark_run(
            &client,
            &base,
            &test_secret(),
            None,
            "123e4567-e89b-42d3-a456-426614174000",
            b"{}",
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, 429);
        assert!(outcome.body.contains("rate_limited"));
        assert_eq!(outcome.retry_after.as_deref(), Some("120"));
        // Oversized responses are rejected instead of buffered unboundedly.
        let outcome = submit_benchmark_run(
            &client,
            &base,
            &test_secret(),
            None,
            "123e4567-e89b-42d3-a456-426614174000",
            b"{}",
        )
        .await;
        drop(outcome);
        server.await.unwrap();
        let (big_url, big) = mock_server(1, |_, _| {
            (200, vec![], vec![b'x'; MAX_SUBMIT_RESPONSE_BYTES + 1])
        })
        .await;
        let big_base = test_base(&big_url);
        let oversized = submit_benchmark_run(
            &client,
            &big_base,
            &test_secret(),
            None,
            "123e4567-e89b-42d3-a456-426614174000",
            b"{}",
        )
        .await;
        assert!(oversized.is_err());
        big.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_failures_keep_code_status_and_retry_after() {
        let (base_url, server) = mock_server(2, |head, _| {
            if head.starts_with("POST /v1/upload-sessions ") {
                return (
                    401,
                    vec![("Retry-After", "7".into())],
                    br#"{"error":{"code":"verification_required","message":"verify first"}}"#
                        .to_vec(),
                );
            }
            (
                410,
                vec![],
                br#"{"error":{"code":"submission_deleted","message":"gone forever"}}"#.to_vec(),
            )
        })
        .await;
        let base = test_base(&base_url);
        let client = http_client().unwrap();
        // Known recoverable handshake codes keep their identity; the raw
        // server message never reaches the error.
        let error = create_upload_session(
            &client,
            &base,
            &test_secret(),
            "123e4567-e89b-42d3-a456-426614174000",
            &"f".repeat(64),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "verification_required");
        assert_eq!(error.status, Some(401));
        assert_eq!(error.retry_after.as_deref(), Some("7"));
        assert_eq!(error.service_code.as_deref(), Some("verification_required"));
        assert!(!error.message.contains("verify first"));
        // Allowlisted terminal codes map to a network error that still
        // preserves status and the allowlisted server code.
        let error = poll_upload_session(&client, &base, &test_secret(), "sess-9")
            .await
            .unwrap_err();
        assert_eq!(error.code, "network_error");
        assert_eq!(error.status, Some(410));
        assert_eq!(error.service_code.as_deref(), Some("submission_deleted"));
        assert!(!error.message.contains("gone forever"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_preserves_allowlist_but_drops_token_material() {
        let client = http_client().unwrap();
        // Allowlisted but non-recoverable codes keep network_error identity
        // while preserving status, Retry-After and the allowlisted code; the
        // raw server message never reaches the error.
        let (base_url, server) = mock_server(1, |_, _| {
            (
                429,
                vec![("Retry-After", "3".into())],
                br#"{"error":{"code":"rate_limited","message":"slow down"}}"#.to_vec(),
            )
        })
        .await;
        let error = create_upload_session(
            &client,
            &test_base(&base_url),
            &test_secret(),
            "123e4567-e89b-42d3-a456-426614174000",
            &"f".repeat(64),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "network_error");
        assert_eq!(error.status, Some(429));
        assert_eq!(error.retry_after.as_deref(), Some("3"));
        assert_eq!(error.service_code.as_deref(), Some("rate_limited"));
        assert!(!error.message.contains("slow down"));
        server.await.unwrap();

        // Token-looking 43-character server codes are dropped entirely so
        // token material cannot enter WebView error metadata.
        let token_like = "A".repeat(43);
        let token_body =
            format!(r#"{{"error":{{"code":"{token_like}","message":"leaked"}}}}"#).into_bytes();
        let (base_url, server) = mock_server(1, move |_, _| {
            (429, vec![("Retry-After", "3".into())], token_body.clone())
        })
        .await;
        let error = create_upload_session(
            &client,
            &test_base(&base_url),
            &test_secret(),
            "123e4567-e89b-42d3-a456-426614174000",
            &"f".repeat(64),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "network_error");
        assert_eq!(error.status, Some(429));
        assert_eq!(error.retry_after.as_deref(), Some("3"));
        assert!(error.service_code.is_none());
        let serialized = serde_json::to_value(&error).unwrap();
        assert!(serialized.get("service_code").is_none());
        assert!(!serialized.to_string().contains(&token_like));
        assert!(!error.message.contains("leaked"));
        server.await.unwrap();

        // Valid-code prefixes with suffixes and overlong values are unknown
        // and dropped, never truncated into an accepted code.
        for rejected in [
            "verification_required_extra".to_string(),
            format!("verification_required{}", "x".repeat(64)),
        ] {
            let body =
                format!(r#"{{"error":{{"code":"{rejected}","message":"nope"}}}}"#).into_bytes();
            let (base_url, server) = mock_server(1, move |_, _| (503, vec![], body.clone())).await;
            let error =
                poll_upload_session(&client, &test_base(&base_url), &test_secret(), "sess-9")
                    .await
                    .unwrap_err();
            assert_eq!(error.code, "network_error");
            assert_eq!(error.status, Some(503));
            assert!(
                error.service_code.is_none(),
                "prefixed/overlong code must be dropped: {rejected:?}"
            );
            let serialized = serde_json::to_value(&error).unwrap();
            assert!(serialized.get("service_code").is_none());
            assert!(!serialized.to_string().contains(&rejected));
            assert!(!error.message.contains("nope"));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn session_create_and_poll_validate_responses() {
        // Concrete verification URL on the same origin as the mock server.
        // The handler derives it from the request Host header, so the test
        // never hardcodes the ephemeral port.
        let (base_url, server) = mock_server(2, move |head, body| {
            if head.starts_with("POST /v1/upload-sessions ") {
                let text = String::from_utf8(body).unwrap();
                assert!(text.contains("123e4567-e89b-42d3-a456-426614174000"));
                let host = head
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("Host:")
                            .or_else(|| line.strip_prefix("host:"))
                            .map(str::trim)
                    })
                    .unwrap_or("127.0.0.1:0");
                let response = format!(
                    "{{\"session_id\":\"sess-1\",\"verification_url\":\"http://{host}/verify/sess-1\",\"expires_at\":\"2030-01-01T00:00:00Z\"}}"
                );
                (200, vec![], response.into_bytes())
            } else {
                assert!(head.starts_with("GET /v1/upload-sessions/sess-1 HTTP/1.1"));
                (
                    200,
                    vec![],
                    br#"{"status":"verified","expires_at":"2030-01-01T00:05:00Z","permit":"permit-xyz"}"#.to_vec(),
                )
            }
        })
        .await;
        let base = test_base(&base_url);
        let client = http_client().unwrap();
        let created = create_upload_session(
            &client,
            &base,
            &test_secret(),
            "123e4567-e89b-42d3-a456-426614174000",
            &"f".repeat(64),
        )
        .await
        .unwrap();
        assert_eq!(created.session_id, "sess-1");
        assert!(created.verification_url.contains("/verify/sess-1"));
        let polled = poll_upload_session(&client, &base, &test_secret(), "sess-1")
            .await
            .unwrap();
        assert_eq!(polled.status, "verified");
        assert_eq!(polled.permit.as_deref(), Some("permit-xyz"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn off_shape_verification_urls_are_rejected() {
        for verification_url in [
            "https://evil.example.test/verify/sess-9".to_string(),
            "http://127.0.0.1:0/verify/other".to_string(),
        ] {
            let (base_url, server) = mock_server(1, move |_, _| {
                let response = format!(
                    "{{\"session_id\":\"sess-9\",\"verification_url\":\"{verification_url}\",\"expires_at\":\"2030-01-01T00:00:00Z\"}}"
                );
                (200, vec![], response.into_bytes())
            })
            .await;
            let base = test_base(&base_url);
            let client = http_client().unwrap();
            let outcome = create_upload_session(
                &client,
                &base,
                &test_secret(),
                "123e4567-e89b-42d3-a456-426614174000",
                &"f".repeat(64),
            )
            .await;
            assert!(outcome.is_err());
            server.await.unwrap();
        }
        // Same origin but query strings or a mismatched session are rejected.
        let (base_url, server) = mock_server(1, |head, _| {
            let host = head
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Host:")
                        .or_else(|| line.strip_prefix("host:"))
                        .map(str::trim)
                })
                .unwrap_or("127.0.0.1:0");
            let response = format!(
                "{{\"session_id\":\"sess-9\",\"verification_url\":\"http://{host}/verify/sess-9?x=1\",\"expires_at\":\"2030-01-01T00:00:00Z\"}}"
            );
            (200, vec![], response.into_bytes())
        })
        .await;
        let base = test_base(&base_url);
        let client = http_client().unwrap();
        assert!(create_upload_session(
            &client,
            &base,
            &test_secret(),
            "123e4567-e89b-42d3-a456-426614174000",
            &"f".repeat(64),
        )
        .await
        .is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unresolved_requests_can_be_aborted() {
        use futures_util::future::{AbortHandle, Abortable};

        let (base_url, server) = hanging_server().await;
        let base = test_base(&base_url);
        let client = http_client().unwrap();
        let secret = test_secret();
        let (abort, registration) = AbortHandle::new_pair();
        let pending = Abortable::new(
            submit_benchmark_run(
                &client,
                &base,
                &secret,
                None,
                "123e4567-e89b-42d3-a456-426614174000",
                b"{}",
            ),
            registration,
        );
        abort.abort();
        assert!(pending.await.is_err());
        server.abort();
    }

    #[test]
    fn body_limits_are_enforced_before_network() {
        assert!(submission_bytes("").is_err());
        assert!(submission_bytes(&"x".repeat(MAX_BODY_BYTES + 1)).is_err());
        let bytes = submission_bytes(r#"{"a":1}"#).unwrap();
        assert_eq!(body_sha256_hex(&bytes).len(), 64);
    }

    #[tokio::test]
    async fn shared_client_never_follows_redirects() {
        let (base_url, server) = mock_server(1, |_, _| {
            (
                302,
                vec![("Location", "https://evil.example.test/".into())],
                Vec::new(),
            )
        })
        .await;
        let base = test_base(&base_url);
        let client = shared_client().unwrap();
        // A second call reuses the cached pool handle successfully.
        let _cached = shared_client().unwrap();
        let response = client
            .get(format!("{base_url}/v1/upload-sessions/sess-9"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 302);
        let _ = base;
        server.await.unwrap();
    }
}
