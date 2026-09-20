//! Anonymous benchmark publishing IPC: owner keys, verification and recovery.
//!
//! Parameter envelopes follow existing Tauri conventions: camelCase JS input
//! maps to the snake_case arguments below, responses use snake_case JSON
//! keys. Failures reject with structured `{code,message,status?,retry_after?}`
//! objects using only the shared spec codes. Owner secrets and upload
//! permits never cross this boundary: the vault, the recovery strings and
//! the permit store stay in native code.
//!
//! Every command that reaches the vault, the network, the clipboard or the
//! browser snapshots the sharing generation first and re-checks it before
//! each subsequent side effect, so work overlapping a user cancel or a
//! measurement start is abandoned instead of completed.

use crate::benchmark::sharing::{
    config,
    errors::{self, SharingError},
    guard, permits,
    recovery::{self, OWNER_SECRET_LEN},
    registry, transport,
    vault::{self, Vault},
};
use crate::state::AppState;
use serde::Serialize;
use std::future::Future;
use std::path::PathBuf;
use tauri::{Manager, State};

use futures_util::future::{AbortHandle, Abortable};

fn benchmarks_root(app: &tauri::AppHandle) -> Result<PathBuf, SharingError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("benchmarks"))
        .map_err(|_| {
            SharingError::vault_unavailable_msg("The local benchmark storage is unavailable.")
        })
}

/// Configured service origin, failing closed with a structured error.
fn service_origin() -> Result<(reqwest::Url, String), SharingError> {
    let base = config::service_base_url().ok_or_else(SharingError::configuration_missing)?;
    let origin = config::origin_of(&base);
    Ok((base, origin))
}

fn valid_submission_id(submission_id: &str) -> Result<(), SharingError> {
    recovery::validate_submission_id(submission_id).map_err(|_| {
        SharingError::binding_conflict_msg("The submission id is not a valid identifier.")
    })
}

/// Generation snapshot: global epoch plus per-submission generation.
struct LiveGuard {
    epoch: u64,
    generation: u64,
}

fn snapshot_live(submission_id: &str) -> LiveGuard {
    LiveGuard {
        epoch: permits::epoch(),
        generation: permits::generation(submission_id),
    }
}

/// Re-check before every subsequent side effect. A bumped generation means
/// user cancel; a bumped epoch or active measurement means benchmark work
/// started. Stale completions must not start new work.
fn ensure_live(
    state: &State<'_, AppState>,
    submission_id: &str,
    guard: &LiveGuard,
) -> Result<(), SharingError> {
    if permits::epoch() != guard.epoch || permits::generation(submission_id) != guard.generation {
        permits::clear_permit(submission_id);
        return Err(SharingError::cancelled());
    }
    if guard::measurement_active(state) {
        permits::clear_permit(submission_id);
        return Err(SharingError::measurement_active());
    }
    Ok(())
}

/// Run an HTTP future under the submission's abort handle so user cancel or
/// measurement start drops the pending request instead of waiting out the
/// full timeout for a result that would then be discarded. Registration
/// checks the generation atomically: when already stale the future is never
/// polled, so no request reaches the wire after a cancel or measurement
/// start.
async fn abortable_request<T>(
    submission_id: &str,
    guard: &LiveGuard,
    future: impl Future<Output = Result<T, SharingError>>,
) -> Result<T, SharingError> {
    let (abort, registration) = AbortHandle::new_pair();
    let Some(token) =
        permits::track_request_if_live(submission_id, guard.epoch, guard.generation, abort)
    else {
        permits::clear_permit(submission_id);
        return Err(SharingError::cancelled());
    };
    let result = Abortable::new(future, registration).await;
    permits::untrack_request(submission_id, token);
    match result {
        Ok(outcome) => outcome,
        Err(_) => {
            permits::clear_permit(submission_id);
            Err(SharingError::cancelled())
        }
    }
}

fn join_error() -> SharingError {
    SharingError::vault_unavailable_msg("A local sharing task failed.")
}

#[derive(Debug, Serialize)]
pub(crate) struct SharingConfiguration {
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PrepareResponse {
    pub credential_ref: String,
    pub body_sha256: String,
    pub destination: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct BeginResponse {
    pub session_id: String,
    pub verification_url: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct PollResponse {
    pub status: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SubmitResponse {
    pub status: u16,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImportResponse {
    pub submission_id: String,
    pub credential_ref: String,
    pub destination: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct OwnedListResponse {
    pub items: Vec<registry::OwnedItem>,
    pub next_cursor: Option<String>,
}

/// Service origin for the WebView to display; read natively, never from JS
/// env. Canonical root origin without trailing slash, or null when
/// unconfigured.
#[tauri::command]
pub(crate) async fn benchmark_sharing_configuration() -> Result<SharingConfiguration, SharingError>
{
    Ok(SharingConfiguration {
        base_url: config::service_base_url().map(|url| config::origin_of(&url)),
    })
}

#[derive(Debug, PartialEq, Eq)]
struct Prepared {
    credential_ref: String,
    body_sha256: String,
    destination: String,
}

/// Bounded structural probe: the body must be a JSON object shaped either as
/// the wrapper (`benchmark.submission_id`) or the legacy bare submission
/// (`submission_id`), naming exactly the requested UUID. Full public-schema
/// validation stays server-side; the exact original bytes still define the
/// hash. Anything else cannot be bound.
fn probe_body_submission(bytes: &[u8], submission_id: &str) -> Result<(), SharingError> {
    const NOT_A_REQUEST: &str = "The publication body is not a valid publication request.";
    const MISMATCH: &str = "The publication body does not match the requested submission.";
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| SharingError::binding_conflict_msg(NOT_A_REQUEST))?;
    let root = value
        .as_object()
        .ok_or_else(|| SharingError::binding_conflict_msg(NOT_A_REQUEST))?;
    let bound = if let Some(benchmark) = root.get("benchmark") {
        benchmark
            .get("submission_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| SharingError::binding_conflict_msg(MISMATCH))?
    } else {
        root.get("submission_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| SharingError::binding_conflict_msg(MISMATCH))?
    };
    if bound != submission_id {
        return Err(SharingError::binding_conflict_msg(MISMATCH));
    }
    Ok(())
}

/// Complete the binding once a record exists: adopt recovery-restored
/// placeholders or verify the frozen body, then prove vault ownership.
/// Callers hold the per-submission lock.
fn complete_bound(
    vault: &dyn Vault,
    benchmarks: &std::path::Path,
    submission_id: &str,
    body_sha256: &str,
    destination: &str,
) -> Result<Prepared, SharingError> {
    let binding = registry::read_binding(benchmarks, submission_id)?.ok_or_else(|| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    if binding.body_sha256 == registry::UNKNOWN_BODY {
        // The owner key arrived via a recovery import; the first prepare
        // with the frozen body adopts the binding. The key can only exist
        // after a validated import or a completed intent, so adoption is safe.
        vault
            .get_secret(submission_id)
            .map_err(|error| errors::from_vault(&error))?;
        let adopted = registry::adopt_body_hash(benchmarks, submission_id, body_sha256)?;
        Ok(Prepared {
            credential_ref: adopted.credential_ref,
            body_sha256: body_sha256.into(),
            destination: destination.into(),
        })
    } else {
        if binding.body_sha256 != body_sha256 || binding.destination != destination {
            return Err(SharingError::binding_conflict_msg(
                "This submission is already bound to different data.",
            ));
        }
        vault
            .get_secret(submission_id)
            .map_err(|error| errors::from_vault(&error))?;
        Ok(Prepared {
            credential_ref: binding.credential_ref,
            body_sha256: body_sha256.into(),
            destination: destination.into(),
        })
    }
}

/// Ensure a record exists for a first-time submission, completing a staged
/// crash intent instead of minting a second key. Never replaces a lost key
/// for an already bound submission, and never adopts a foreign vault key:
/// a key without any intent must be re-imported explicitly. Callers hold the
/// per-submission lock across the vault read/generation/set and the commit.
fn ensure_record(
    vault: &dyn Vault,
    benchmarks: &std::path::Path,
    origin: &str,
    submission_id: &str,
    body_sha256: &str,
    destination: &str,
) -> Result<(), SharingError> {
    if registry::read_binding(benchmarks, submission_id)?.is_some() {
        return Ok(());
    }
    let pending = registry::read_pending(benchmarks, submission_id)?;
    match vault.get_secret(submission_id) {
        Ok(_) if pending.is_none() => Err(SharingError::binding_conflict_msg(
            "An owner key already exists without saved ownership.",
        )),
        Ok(_) => {
            // A staged intent plus its key: finish the interrupted commit
            // with the intent's own values, never a replacement key.
            let intent = pending.expect("pending intent observed");
            if intent.origin() != origin {
                return Err(SharingError::binding_conflict_msg(
                    "This submission is bound to a different service.",
                ));
            }
            registry::commit_pending(benchmarks, submission_id)?;
            Ok(())
        }
        Err(vault::VaultError::Missing) => {
            let intent = registry::Record::stage(
                submission_id,
                body_sha256,
                destination,
                origin,
                registry::now_ms()?,
            );
            registry::write_pending(benchmarks, &intent, submission_id)?;
            let secret = vault::random_owner_secret().map_err(|_| {
                SharingError::vault_unavailable_msg("The owner key could not be generated.")
            })?;
            if let Err(error) = vault.set_secret(submission_id, &secret) {
                // The intent survives: the next attempt completes the commit
                // with this same pending authority instead of orphaning a key.
                return Err(errors::from_vault(&error));
            }
            registry::commit_pending(benchmarks, submission_id)?;
            Ok(())
        }
        Err(other) => Err(errors::from_vault(&other)),
    }
}

/// Bind (or reaffirm) the owner key for one exact publication body.
/// Idempotent for the same binding; never mints a replacement key when a
/// binding already exists but its vault key is gone.
fn prepare_inner(
    vault: &dyn Vault,
    benchmarks: &std::path::Path,
    origin: &str,
    submission_id: &str,
    body: &str,
) -> Result<Prepared, SharingError> {
    valid_submission_id(submission_id)?;
    let bytes = transport::submission_bytes(body)?;
    probe_body_submission(&bytes, submission_id)?;
    let body_sha256 = transport::body_sha256_hex(&bytes);
    let destination = config::submit_endpoint_for_origin(origin);
    let _lock = registry::submission_lock(benchmarks, submission_id)?;
    ensure_record(
        vault,
        benchmarks,
        origin,
        submission_id,
        &body_sha256,
        &destination,
    )?;
    complete_bound(vault, benchmarks, submission_id, &body_sha256, &destination)
}

#[tauri::command]
pub(crate) async fn benchmark_sharing_prepare(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    submission_id: String,
    body: String,
) -> Result<PrepareResponse, SharingError> {
    guard::ensure_idle(&state).map_err(|_| SharingError::measurement_active())?;
    let (_, origin) = service_origin()?;
    let benchmarks = benchmarks_root(&app)?;
    tokio::task::spawn_blocking(move || {
        prepare_inner(&vault::OsVault, &benchmarks, &origin, &submission_id, &body).map(
            |prepared| PrepareResponse {
                credential_ref: prepared.credential_ref,
                body_sha256: prepared.body_sha256,
                destination: prepared.destination,
            },
        )
    })
    .await
    .map_err(|_| join_error())?
}

fn load_bound_secret(
    vault: &dyn Vault,
    benchmarks: &std::path::Path,
    origin: &str,
    submission_id: &str,
    body: Option<&str>,
) -> Result<([u8; OWNER_SECRET_LEN], registry::OwnerBinding), SharingError> {
    valid_submission_id(submission_id)?;
    let binding = registry::read_binding(benchmarks, submission_id)?.ok_or_else(|| {
        SharingError::binding_conflict_msg("This submission has no saved ownership.")
    })?;
    if binding.origin != origin {
        return Err(SharingError::binding_conflict_msg(
            "This submission is bound to a different service.",
        ));
    }
    if let Some(body) = body {
        let bytes = transport::submission_bytes(body)?;
        if binding.body_sha256 == registry::UNKNOWN_BODY {
            return Err(SharingError::binding_conflict_msg(
                "This submission was restored from a backup.",
            ));
        }
        if transport::body_sha256_hex(&bytes) != binding.body_sha256 {
            return Err(SharingError::binding_conflict_msg(
                "This submission is already bound to different data.",
            ));
        }
    }
    let secret = vault
        .get_secret(submission_id)
        .map_err(|error| errors::from_vault(&error))?;
    Ok((secret, binding))
}

fn open_browser(url: &str) -> Result<(), SharingError> {
    open::that(url)
        .map_err(|_| SharingError::vault_unavailable_msg("The system browser could not be opened."))
}

#[tauri::command]
pub(crate) async fn benchmark_sharing_begin_verification(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    submission_id: String,
) -> Result<BeginResponse, SharingError> {
    guard::ensure_idle(&state).map_err(|_| SharingError::measurement_active())?;
    let live = snapshot_live(&submission_id);
    let (base, origin) = service_origin()?;
    let benchmarks = benchmarks_root(&app)?;
    let (secret, binding) = tokio::task::spawn_blocking({
        let origin = origin.clone();
        let submission_id = submission_id.clone();
        move || load_bound_secret(&vault::OsVault, &benchmarks, &origin, &submission_id, None)
    })
    .await
    .map_err(|_| join_error())??;
    if binding.body_sha256 == registry::UNKNOWN_BODY {
        return Err(SharingError::binding_conflict_msg(
            "This submission was restored from a backup.",
        ));
    }
    ensure_live(&state, &submission_id, &live)?;
    let client = transport::shared_client()?;
    let created = abortable_request(
        &submission_id,
        &live,
        transport::create_upload_session(
            &client,
            &base,
            &secret,
            &submission_id,
            &binding.body_sha256,
        ),
    )
    .await?;
    ensure_live(&state, &submission_id, &live)?;
    let response = BeginResponse {
        session_id: created.session_id.clone(),
        verification_url: created.verification_url.clone(),
        expires_at: created.expires_at,
    };
    // The challenge page completes the Turnstile check; only the exact
    // configured verification URL is ever opened.
    ensure_live(&state, &submission_id, &live)?;
    open_browser(&created.verification_url)?;
    Ok(response)
}

#[tauri::command]
pub(crate) async fn benchmark_sharing_poll_verification(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    submission_id: String,
    session_id: String,
) -> Result<PollResponse, SharingError> {
    guard::ensure_idle(&state).map_err(|_| SharingError::measurement_active())?;
    let live = snapshot_live(&submission_id);
    let (base, origin) = service_origin()?;
    let benchmarks = benchmarks_root(&app)?;
    let (secret, _) = tokio::task::spawn_blocking({
        let origin = origin.clone();
        let submission_id = submission_id.clone();
        move || load_bound_secret(&vault::OsVault, &benchmarks, &origin, &submission_id, None)
    })
    .await
    .map_err(|_| join_error())??;
    ensure_live(&state, &submission_id, &live)?;
    let client = transport::shared_client()?;
    let outcome = abortable_request(
        &submission_id,
        &live,
        transport::poll_upload_session(&client, &base, &secret, &session_id),
    )
    .await?;
    ensure_live(&state, &submission_id, &live)?;
    if outcome.status == "expired" {
        permits::clear_permit(&submission_id);
    }
    if outcome.status == "verified" {
        if let Some(permit) = outcome.permit {
            permits::store_permit(&submission_id, &session_id, &permit);
        }
    }
    Ok(PollResponse {
        status: outcome.status,
        expires_at: outcome.expires_at,
    })
}

#[tauri::command]
pub(crate) async fn benchmark_sharing_submit(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    submission_id: String,
    body: String,
) -> Result<SubmitResponse, SharingError> {
    guard::ensure_idle(&state).map_err(|_| SharingError::measurement_active())?;
    let live = snapshot_live(&submission_id);
    let (base, origin) = service_origin()?;
    let benchmarks = benchmarks_root(&app)?;
    let submission = submission_id.clone();
    let request_body = body.clone();
    let (secret, _) = tokio::task::spawn_blocking({
        let origin = origin.clone();
        move || {
            load_bound_secret(
                &vault::OsVault,
                &benchmarks,
                &origin,
                &submission,
                Some(&request_body),
            )
        }
    })
    .await
    .map_err(|_| join_error())??;
    ensure_live(&state, &submission_id, &live)?;
    // Accepted replays may submit without a live permit; the server returns
    // the existing receipt. A missing permit is never an error here.
    let permit = permits::live_permit(&submission_id).map(|(permit, _)| permit);
    let bytes = transport::submission_bytes(&body)?;
    let client = transport::shared_client()?;
    let outcome = abortable_request(
        &submission_id,
        &live,
        transport::submit_benchmark_run(
            &client,
            &base,
            &secret,
            permit.as_deref(),
            &submission_id,
            &bytes,
        ),
    )
    .await?;
    ensure_live(&state, &submission_id, &live)?;
    Ok(SubmitResponse {
        status: outcome.status,
        body: outcome.body,
        retry_after: outcome.retry_after,
    })
}

/// Cancel pending sharing work for one submission: abort its tracked
/// requests and forget its permit. Later attempts start clean and are never
/// blocked by this cancel. Works while a measurement is active.
#[tauri::command]
pub(crate) async fn benchmark_sharing_cancel(submission_id: String) -> Result<(), SharingError> {
    valid_submission_id(&submission_id)?;
    permits::cancel_submission(&submission_id);
    Ok(())
}

/// Paginated nonsecret ownership records without opening the OS vault,
/// independent of queue/history cache. Reads never mutate storage.
#[tauri::command]
pub(crate) async fn benchmark_sharing_owned_list(
    app: tauri::AppHandle,
    after: Option<String>,
    limit: Option<i64>,
) -> Result<OwnedListResponse, SharingError> {
    let limit = match limit {
        None => registry::DEFAULT_LIST_LIMIT,
        Some(value) => value.clamp(1, 100) as usize,
    };
    let benchmarks = benchmarks_root(&app)?;
    let (items, next_cursor) = tokio::task::spawn_blocking(move || {
        registry::list_owned(&benchmarks, after.as_deref(), limit)
    })
    .await
    .map_err(|_| join_error())??;
    Ok(OwnedListResponse { items, next_cursor })
}

fn export_bytes(
    vault: &dyn Vault,
    benchmarks: &std::path::Path,
    origin: &str,
    submission_id: &str,
) -> Result<String, SharingError> {
    let (secret, _) = load_bound_secret(vault, benchmarks, origin, submission_id, None)?;
    Ok(recovery::encode_recovery(origin, submission_id, &secret))
}

fn write_recovery_file(path: &std::path::Path, contents: &str) -> Result<(), SharingError> {
    // Atomic temp-plus-rename write so a crash cannot leave a half-written
    // backup; restrictive permissions on unix (Windows relies on the
    // per-user profile directory ACL).
    crate::config::atomic_write(path, contents.as_bytes()).map_err(|_| {
        SharingError::vault_unavailable_msg("The recovery file could not be written.")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn default_recovery_name(submission_id: &str) -> String {
    format!("aiolm-recovery-{submission_id}.txt")
}

#[tauri::command]
pub(crate) async fn benchmark_sharing_recovery_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    submission_id: String,
) -> Result<bool, SharingError> {
    guard::ensure_idle(&state).map_err(|_| SharingError::measurement_active())?;
    let live = snapshot_live(&submission_id);
    let (_, origin) = service_origin()?;
    let benchmarks = benchmarks_root(&app)?;
    let contents = tokio::task::spawn_blocking({
        let origin = origin.clone();
        let submission_id = submission_id.clone();
        move || export_bytes(&vault::OsVault, &benchmarks, &origin, &submission_id)
    })
    .await
    .map_err(|_| join_error())??;
    ensure_live(&state, &submission_id, &live)?;
    let path = tokio::task::spawn_blocking({
        let submission_id = submission_id.clone();
        move || {
            rfd::FileDialog::new()
                .set_file_name(default_recovery_name(&submission_id))
                .add_filter("Text", &["txt"])
                .save_file()
        }
    })
    .await
    .map_err(|_| join_error())?;
    let Some(path) = path else { return Ok(false) };
    // The dialog may have outlived a cancel or measurement start: never
    // write a stale backup.
    ensure_live(&state, &submission_id, &live)?;
    tokio::task::spawn_blocking(move || write_recovery_file(&path, &contents))
        .await
        .map_err(|_| join_error())??;
    Ok(true)
}

/// Validate and apply a recovery file at an explicit path (dialogs stay in
/// the command). Restores a lost vault key; never overwrites a different
/// existing credential. On a fresh device the binding is recorded with an
/// unknown body that the first prepare adopts; the vault key is authoritative.
/// Callers hold the per-submission lock across vault and record work.
fn import_path_inner(
    vault: &dyn Vault,
    benchmarks: &std::path::Path,
    origin: &str,
    path: &std::path::Path,
) -> Result<ImportResponse, SharingError> {
    let bytes = std::fs::read(path)
        .map_err(|_| SharingError::vault_unavailable_msg("The recovery file could not be read."))?;
    let owner = recovery::decode_recovery_file(&bytes)
        .map_err(|_| SharingError::binding_conflict_msg("The recovery file is invalid."))?;
    if owner.origin != origin {
        return Err(SharingError::binding_conflict_msg(
            "The recovery file belongs to a different service.",
        ));
    }
    let _lock = registry::submission_lock(benchmarks, &owner.submission_id)?;
    match vault.get_secret(&owner.submission_id) {
        Ok(existing) => {
            if existing != owner.secret {
                return Err(SharingError::binding_conflict_msg(
                    "The vault already holds a different owner key.",
                ));
            }
        }
        Err(vault::VaultError::Missing) => {
            vault
                .set_secret(&owner.submission_id, &owner.secret)
                .map_err(|error| errors::from_vault(&error))?;
        }
        Err(other) => return Err(errors::from_vault(&other)),
    }
    match registry::read_binding(benchmarks, &owner.submission_id)? {
        Some(binding) => {
            if binding.origin != owner.origin {
                return Err(SharingError::binding_conflict_msg(
                    "The recovery file belongs to a different service.",
                ));
            }
            // A staged intent left beside a committed record is stale crash
            // debris; the record is authoritative.
            let _ = registry::clear_pending(benchmarks, &owner.submission_id);
            Ok(ImportResponse {
                submission_id: owner.submission_id,
                credential_ref: binding.credential_ref,
                destination: binding.destination,
            })
        }
        None => {
            // The import carries its own authority: supersede any staged
            // intent that never minted a key, then record the binding.
            let _ = registry::clear_pending(benchmarks, &owner.submission_id);
            let destination = config::submit_endpoint_for_origin(&owner.origin);
            match registry::insert_binding(
                benchmarks,
                &owner.submission_id,
                registry::UNKNOWN_BODY,
                &destination,
                &owner.origin,
                registry::now_ms()?,
            ) {
                Ok(_) => {}
                Err(error) => {
                    // A concurrent prepare/import won the race; defer to it
                    // when the vault key agrees (checked above).
                    let _ = error;
                    registry::read_binding(benchmarks, &owner.submission_id)?.ok_or_else(|| {
                        SharingError::vault_unavailable_msg(
                            "The ownership registry is unavailable.",
                        )
                    })?;
                }
            }
            let binding =
                registry::read_binding(benchmarks, &owner.submission_id)?.ok_or_else(|| {
                    SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
                })?;
            if binding.origin != owner.origin {
                return Err(SharingError::binding_conflict_msg(
                    "The recovery file belongs to a different service.",
                ));
            }
            Ok(ImportResponse {
                submission_id: owner.submission_id,
                credential_ref: binding.credential_ref,
                destination: binding.destination,
            })
        }
    }
}

#[tauri::command]
pub(crate) async fn benchmark_sharing_recovery_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ImportResponse>, SharingError> {
    guard::ensure_idle(&state).map_err(|_| SharingError::measurement_active())?;
    let (_, origin) = service_origin()?;
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Text", &["txt"])
            .add_filter("All files", &["*"])
            .pick_file()
    })
    .await
    .map_err(|_| join_error())?;
    let Some(path) = path else { return Ok(None) };
    let benchmarks = benchmarks_root(&app)?;
    // Vault and registry writes are privileged: re-check liveness after the
    // dialog before touching them.
    if guard::measurement_active(&state) {
        return Err(SharingError::measurement_active());
    }
    tokio::task::spawn_blocking(move || {
        import_path_inner(&vault::OsVault, &benchmarks, &origin, &path).map(Some)
    })
    .await
    .map_err(|_| join_error())?
}

/// Copy the recovery string to the OS clipboard without handing the key to JS.
#[tauri::command]
pub(crate) async fn benchmark_sharing_recovery_copy(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    submission_id: String,
) -> Result<bool, SharingError> {
    guard::ensure_idle(&state).map_err(|_| SharingError::measurement_active())?;
    let live = snapshot_live(&submission_id);
    let (_, origin) = service_origin()?;
    let benchmarks = benchmarks_root(&app)?;
    let contents = tokio::task::spawn_blocking({
        let origin = origin.clone();
        let submission_id = submission_id.clone();
        move || export_bytes(&vault::OsVault, &benchmarks, &origin, &submission_id)
    })
    .await
    .map_err(|_| join_error())??;
    ensure_live(&state, &submission_id, &live)?;
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|_| {
            SharingError::vault_unavailable_msg("The system clipboard is unavailable.")
        })?;
        clipboard.set_text(contents).map_err(|_| {
            SharingError::vault_unavailable_msg("The system clipboard is unavailable.")
        })?;
        Ok::<_, SharingError>(true)
    })
    .await
    .map_err(|_| join_error())?
}

/// Open the fixed service management page. Carries no secret parameters.
#[tauri::command]
pub(crate) async fn benchmark_sharing_open_management(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    submission_id: String,
) -> Result<(), SharingError> {
    let live = snapshot_live(&submission_id);
    let (_, origin) = service_origin()?;
    let benchmarks = benchmarks_root(&app)?;
    tokio::task::spawn_blocking({
        let origin = origin.clone();
        let submission_id = submission_id.clone();
        move || {
            valid_submission_id(&submission_id)?;
            let binding =
                registry::read_binding(&benchmarks, &submission_id)?.ok_or_else(|| {
                    SharingError::binding_conflict_msg("This submission has no saved ownership.")
                })?;
            if binding.origin != origin {
                return Err(SharingError::binding_conflict_msg(
                    "This submission is bound to a different service.",
                ));
            }
            Ok::<_, SharingError>(())
        }
    })
    .await
    .map_err(|_| join_error())??;
    let url = config::management_url_for_origin(&origin);
    ensure_live(&state, &submission_id, &live)?;
    open_browser(&url)
        .map_err(|_| SharingError::vault_unavailable_msg("The system browser could not be opened."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::benchmark::sharing::errors::code;
    use crate::benchmark::sharing::vault::MockVault;

    const ORIGIN: &str = "http://127.0.0.1:4317";

    fn benchmarks() -> PathBuf {
        let root = std::env::temp_dir().join(format!("aiolm-sharing-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn submission(tag: u128) -> String {
        format!("123e4567-e89b-42d3-a456-{tag:012}")
    }

    fn wrapper_body(id: &str) -> String {
        format!(r#"{{"benchmark":{{"submission_id":"{id}"}},"description_md":"hello"}}"#)
    }

    fn legacy_body(id: &str) -> String {
        format!(r#"{{"submission_id":"{id}","rows":[]}}"#)
    }

    fn prepare(vault: &dyn Vault, root: &std::path::Path, id: &str, body: &str) -> Prepared {
        prepare_inner(vault, root, ORIGIN, id, body).unwrap()
    }

    #[test]
    fn first_prepare_restart_locked_and_lost_key() {
        let vault = MockVault::open();
        let root = benchmarks();
        let id = submission(1);
        let body = wrapper_body(&id);
        // First create binds key + registry before any network attempt.
        let first = prepare(&vault, &root, &id, &body);
        assert_eq!(first.credential_ref, registry::credential_ref(&id));
        assert_eq!(first.body_sha256.len(), 64);
        assert!(first.destination.starts_with(ORIGIN));
        let key = vault.get_secret(&id).unwrap();
        // Restart (same vault + registry dir) reaffirms the same binding.
        let second = prepare(&vault, &root, &id, &body);
        assert_eq!(second, first);
        assert_eq!(vault.get_secret(&id).unwrap(), key);
        // A locked vault blocks with a structured code and no fallback.
        vault.set_locked(true);
        let error = prepare_inner(&vault, &root, ORIGIN, &id, &body).unwrap_err();
        assert_eq!(error.code, code::VAULT_LOCKED);
        vault.set_locked(false);
        assert_eq!(vault.get_secret(&id).unwrap(), key);
        // Unlocking retries fine with no restart: the same call succeeds.
        assert_eq!(prepare(&vault, &root, &id, &body), first);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lost_key_is_never_replaced_with_a_new_one() {
        let root = benchmarks();
        let id = submission(2);
        let vault = MockVault::open();
        let body = wrapper_body(&id);
        prepare(&vault, &root, &id, &body);
        // Simulate key loss: registry binding survives, vault key is gone.
        let wiped = MockVault::open();
        let error = prepare_inner(&wiped, &root, ORIGIN, &id, &body).unwrap_err();
        assert_eq!(error.code, code::OWNERSHIP_MISSING);
        // No replacement key was minted behind the binding.
        assert!(matches!(
            wiped.get_secret(&id),
            Err(vault::VaultError::Missing)
        ));
        // The exact body still binds; a different body drifts.
        assert!(prepare_inner(&vault, &root, ORIGIN, &id, &body).is_ok());
        let other = wrapper_body("123e4567-e89b-42d3-a456-000000000999");
        let error = prepare_inner(&vault, &root, ORIGIN, &id, &other).unwrap_err();
        assert_eq!(error.code, code::BINDING_CONFLICT);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn body_probe_requires_matching_submission_id() {
        let root = benchmarks();
        let id = submission(3);
        let vault = MockVault::open();
        // Legacy bare bodies bind when the id matches.
        prepare(&vault, &root, &id, &legacy_body(&id));
        // Mismatched ids, non-objects, missing ids and non-JSON are refused
        // before any key or binding is created.
        let fresh = MockVault::open();
        let decoy = submission(999);
        for (tag, body) in [
            (30, wrapper_body(&decoy)),
            (31, legacy_body(&decoy)),
            (32, r#"{"description_md":"no ids"}"#.to_string()),
            (33, r#"[1,2,3]"#.to_string()),
            (34, "not json at all".to_string()),
            (35, r#"{"benchmark":{}}"#.to_string()),
        ] {
            let other = submission(tag);
            let error = prepare_inner(&fresh, &root, ORIGIN, &other, &body).unwrap_err();
            assert_eq!(error.code, code::BINDING_CONFLICT, "{body}");
            assert!(fresh.get_secret(&other).is_err());
            assert!(registry::read_binding(&root, &other).unwrap().is_none());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_prepares_agree_on_one_key() {
        let root = benchmarks();
        let id = submission(4);
        let body = wrapper_body(&id);
        let vault = MockVault::open();
        std::thread::scope(|scope| {
            let mut handles = Vec::new();
            for _ in 0..8 {
                handles.push(scope.spawn(|| prepare_inner(&vault, &root, ORIGIN, &id, &body)));
            }
            let mut first: Option<Prepared> = None;
            for handle in handles {
                let prepared = handle.join().expect("prepare thread").expect("prepare ok");
                if let Some(expected) = &first {
                    assert_eq!(&prepared, expected);
                } else {
                    first = Some(prepared);
                }
            }
        });
        // Exactly one vault write won; every thread observed the same binding.
        assert_eq!(vault.successful_sets(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fault_injected_vault_write_recovers_without_orphans() {
        let root = benchmarks();
        let id = submission(5);
        let body = wrapper_body(&id);
        let vault = MockVault::open();
        // The vault write fails after the intent is staged.
        vault.inject_set_failure();
        let error = prepare_inner(&vault, &root, ORIGIN, &id, &body).unwrap_err();
        assert_eq!(error.code, code::VAULT_LOCKED);
        assert_eq!(vault.successful_sets(), 0);
        // Retry completes the same intent: exactly one key ever minted.
        let prepared = prepare(&vault, &root, &id, &body);
        assert_eq!(vault.successful_sets(), 1);
        assert_eq!(prepared.body_sha256.len(), 64);
        assert_eq!(prepare(&vault, &root, &id, &body), prepared);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn crash_between_vault_write_and_commit_is_completed() {
        let root = benchmarks();
        let id = submission(6);
        let body = wrapper_body(&id);
        let vault = MockVault::open();
        // Simulate the crash window manually: staged intent plus vault key,
        // no committed record.
        let hash = transport::body_sha256_hex(body.as_bytes());
        let destination = config::submit_endpoint_for_origin(ORIGIN);
        let _lock = registry::submission_lock(&root, &id).unwrap();
        let intent = registry::Record::stage(&id, &hash, &destination, ORIGIN, 4242);
        registry::write_pending(&root, &intent, &id).unwrap();
        let crashed_key = [42u8; OWNER_SECRET_LEN];
        vault.set_secret(&id, &crashed_key).unwrap();
        drop(_lock);
        // The next prepare commits the intent with the original key instead
        // of minting a replacement.
        let prepared = prepare(&vault, &root, &id, &body);
        assert_eq!(vault.get_secret(&id).unwrap(), crashed_key);
        assert_eq!(vault.successful_sets(), 1);
        assert_eq!(prepared.body_sha256, hash);
        let binding = registry::read_binding(&root, &id).unwrap().unwrap();
        assert_eq!(binding.created_at_ms, 4242);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_key_without_intent_is_never_adopted() {
        let root = benchmarks();
        let id = submission(7);
        let body = wrapper_body(&id);
        let vault = MockVault::open();
        // A foreign key with no staged intent and no record stays untouched.
        vault.set_secret(&id, &[7u8; OWNER_SECRET_LEN]).unwrap();
        let error = prepare_inner(&vault, &root, ORIGIN, &id, &body).unwrap_err();
        assert_eq!(error.code, code::BINDING_CONFLICT);
        assert_eq!(vault.get_secret(&id).unwrap(), [7u8; OWNER_SECRET_LEN]);
        assert!(registry::read_binding(&root, &id).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_file_restores_lost_keys_and_rebinds_fresh_devices() {
        let root = benchmarks();
        let id = submission(8);
        let vault = MockVault::open();
        let body = wrapper_body(&id);
        prepare(&vault, &root, &id, &body);
        let contents = export_bytes(&vault, &root, ORIGIN, &id).unwrap();
        // Secret isolation: the file is one prefixed line decoding to exactly
        // the original secret; no destination, permit or extra metadata.
        assert!(contents.starts_with(recovery::RECOVERY_PREFIX));
        assert!(!contents.contains("destination"));
        assert!(!contents.contains("permit"));
        assert!(!contents.contains('\n'));
        let path = root.join("backup.txt");
        std::fs::write(&path, &contents).unwrap();
        // Lost vault key with surviving registry: import restores the key.
        let wiped = MockVault::open();
        let imported = import_path_inner(&wiped, &root, ORIGIN, &path).unwrap();
        assert_eq!(imported.submission_id, id);
        assert_eq!(
            wiped.get_secret(&id).unwrap(),
            vault.get_secret(&id).unwrap()
        );
        assert!(prepare_inner(&wiped, &root, ORIGIN, &id, &body).is_ok());
        // Fresh device (empty registry): import records the binding with an
        // unknown body, then the first prepare adopts the frozen body.
        let fresh_root = benchmarks();
        let fresh_vault = MockVault::open();
        let imported = import_path_inner(&fresh_vault, &fresh_root, ORIGIN, &path).unwrap();
        assert_eq!(imported.submission_id, id);
        let binding = registry::read_binding(&fresh_root, &id).unwrap().unwrap();
        assert_eq!(binding.body_sha256, registry::UNKNOWN_BODY);
        let adopted = prepare_inner(&fresh_vault, &fresh_root, ORIGIN, &id, &body).unwrap();
        assert_eq!(adopted.body_sha256.len(), 64);
        assert_eq!(
            fresh_vault.get_secret(&id).unwrap(),
            vault.get_secret(&id).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(fresh_root).unwrap();
    }

    #[test]
    fn recovery_import_rejects_wrong_origin_and_never_overwrites() {
        let root = benchmarks();
        let id = submission(9);
        let vault = MockVault::open();
        let body = wrapper_body(&id);
        prepare(&vault, &root, &id, &body);
        let contents = export_bytes(&vault, &root, ORIGIN, &id).unwrap();
        let path = root.join("backup.txt");
        std::fs::write(&path, &contents).unwrap();
        // A different configured service rejects the file; vault untouched.
        let other = config::origin_of(&config::validate_base_url("http://127.0.0.1:9999").unwrap());
        let fresh = MockVault::open();
        let scratch = benchmarks();
        let error = import_path_inner(&fresh, &scratch, &other, &path).unwrap_err();
        assert_eq!(error.code, code::BINDING_CONFLICT);
        assert!(matches!(
            fresh.get_secret(&id),
            Err(vault::VaultError::Missing)
        ));
        // A different existing vault key is never overwritten.
        let rival = MockVault::open();
        rival.set_secret(&id, &[5u8; OWNER_SECRET_LEN]).unwrap();
        let error = import_path_inner(&rival, &root, ORIGIN, &path).unwrap_err();
        assert_eq!(error.code, code::BINDING_CONFLICT);
        assert_eq!(rival.get_secret(&id).unwrap(), [5u8; OWNER_SECRET_LEN]);
        // Oversized and corrupt files are rejected with structured codes.
        std::fs::write(&path, vec![b'z'; recovery::MAX_RECOVERY_FILE_BYTES + 1]).unwrap();
        let error = import_path_inner(&MockVault::open(), &root, ORIGIN, &path).unwrap_err();
        assert_eq!(error.code, code::BINDING_CONFLICT);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn owned_list_pages_without_vault_or_mutation() {
        let root = benchmarks();
        let vault = MockVault::open();
        let mut ids = Vec::new();
        for index in 0..30u32 {
            let id = submission(100 + index as u128);
            prepare(&vault, &root, &id, &wrapper_body(&id));
            ids.push(id);
        }
        // Listing needs no vault: a locked vault still lists.
        vault.set_locked(true);
        let (first, next) = registry::list_owned(&root, None, 25).unwrap();
        assert_eq!(first.len(), 25);
        let cursor = next.expect("second page expected");
        for item in &first {
            assert!(ids.contains(&item.submission_id));
            assert_eq!(item.destination, config::submit_endpoint_for_origin(ORIGIN));
        }
        let (second, next) = registry::list_owned(&root, Some(&cursor), 25).unwrap();
        assert_eq!(second.len(), 5);
        assert_eq!(next, None);
        // Invalid cursors are structured errors, not panics or full scans.
        assert_eq!(
            registry::list_owned(&root, Some("bogus"), 25)
                .unwrap_err()
                .code,
            code::BINDING_CONFLICT
        );
        vault.set_locked(false);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    // Test-only serialization across awaits (see permits.rs): unique
    // submissions per test plus abort assertions keep these meaningful.
    #[allow(clippy::await_holding_lock)]
    async fn cancel_aborts_unresolved_submit_and_retry_succeeds() {
        let _serial = permits::test_serial();
        let root = benchmarks();
        let id = submission(200);
        let vault = MockVault::open();
        let body = wrapper_body(&id);
        prepare(&vault, &root, &id, &body);
        let secret = vault.get_secret(&id).unwrap();
        let _base = config::validate_base_url(ORIGIN).unwrap();
        // An unresolved request is dropped promptly by cancel, not after the
        // 30 s timeout, and the permit is forgotten.
        let hanging = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hanging_base = format!("http://127.0.0.1:{}", hanging.local_addr().unwrap().port());
        let hanging_url = config::validate_base_url(&hanging_base).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = hanging.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            use tokio::io::AsyncReadExt;
            let _ = socket.read(&mut buffer).await;
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        });
        let client = transport::http_client().unwrap();
        let body_bytes = body.clone().into_bytes();
        let live = snapshot_live(&id);
        let canceller = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            permits::cancel_submission(&canceller);
        });
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            abortable_request(
                &id,
                &live,
                transport::submit_benchmark_run(
                    &client,
                    &hanging_url,
                    &secret,
                    None,
                    &id,
                    &body_bytes,
                ),
            ),
        )
        .await
        .expect("cancel must abort the pending request promptly");
        assert_eq!(outcome.unwrap_err().code, code::CANCELLED);
        server.abort();
        // A new explicit attempt after the cancel succeeds (replay path).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live_base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let live_url = config::validate_base_url(&live_base).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if socket.read_exact(&mut byte).await.is_err() {
                    return;
                }
                head.push(byte[0]);
            }
            // Consume the request body before responding; closing early
            // would reset the client's upload.
            let head_text = String::from_utf8_lossy(&head).into_owned();
            let length = head_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut body = vec![0u8; length.min(8 * 1024 * 1024)];
            if !body.is_empty() && socket.read_exact(&mut body).await.is_err() {
                return;
            }
            let response = b"HTTP/1.1 201 Created\r\nContent-Length: 34\r\nConnection: close\r\n\r\n{\"id\":\"pub-1\",\"submission_id\":\"x\"}";
            let _ = socket.write_all(response).await;
        });
        let outcome = abortable_request(
            &id,
            &snapshot_live(&id),
            transport::submit_benchmark_run(&client, &live_url, &secret, None, &id, &body_bytes),
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, 201);
        assert!(outcome.body.contains("pub-1"));
        server.await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn measurement_start_aborts_unresolved_submit() {
        let _serial = permits::test_serial();
        let id = submission(201);
        permits::store_permit(&id, "session", "permit");
        let hanging = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hanging_base = format!("http://127.0.0.1:{}", hanging.local_addr().unwrap().port());
        let hanging_url = config::validate_base_url(&hanging_base).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = hanging.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            use tokio::io::AsyncReadExt;
            let _ = socket.read(&mut buffer).await;
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        });
        let client = transport::http_client().unwrap();
        let live = snapshot_live(&id);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            // The benchmark-start hook drops in-flight sharing network work
            // and forgets permits so nothing continues into timed work.
            permits::note_measurement_start();
        });
        let secret = [1u8; OWNER_SECRET_LEN];
        let empty: &[u8] = b"{}";
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            abortable_request(
                &id,
                &live,
                transport::submit_benchmark_run(
                    &client,
                    &hanging_url,
                    &secret,
                    Some("permit"),
                    &id,
                    empty,
                ),
            ),
        )
        .await
        .expect("measurement start must abort the pending request promptly");
        assert_eq!(outcome.unwrap_err().code, code::CANCELLED);
        assert_eq!(permits::live_permit(&id), None);
        server.abort();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn stale_registration_never_reaches_the_wire() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        let _serial = permits::test_serial();
        let id = submission(202);
        // Snapshot, then cancel before any request: registration must refuse
        // atomically and the HTTP future must never be polled.
        let live = snapshot_live(&id);
        permits::cancel_submission(&id);
        let polled = Arc::new(AtomicBool::new(false));
        let probe = {
            let polled = polled.clone();
            async move {
                polled.store(true, Ordering::SeqCst);
                Ok::<_, SharingError>(())
            }
        };
        let outcome = abortable_request(&id, &live, probe).await;
        assert_eq!(outcome.unwrap_err().code, code::CANCELLED);
        assert!(!polled.load(Ordering::SeqCst));
        // A fresh snapshot after the cancel works immediately.
        let polled = Arc::new(AtomicBool::new(false));
        let probe = {
            let polled = polled.clone();
            async move {
                polled.store(true, Ordering::SeqCst);
                Ok::<_, SharingError>(())
            }
        };
        let fresh = snapshot_live(&id);
        assert!(abortable_request(&id, &fresh, probe).await.is_ok());
        assert!(polled.load(Ordering::SeqCst));
    }

    #[test]
    fn fresh_import_is_listable_and_usable_without_prepare() {
        // Fresh device: only a recovery file, no history, no prepared body.
        // The imported ownership must still appear for management.
        let root = benchmarks();
        let id = submission(203);
        let secret = [11u8; OWNER_SECRET_LEN];
        let contents = recovery::encode_recovery(ORIGIN, &id, &secret);
        let path = root.join("backup.txt");
        std::fs::write(&path, &contents).unwrap();
        let vault = MockVault::open();
        let imported = import_path_inner(&vault, &root, ORIGIN, &path).unwrap();
        assert_eq!(imported.submission_id, id);
        let (items, next) = registry::list_owned(&root, None, 25).unwrap();
        assert_eq!(next, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].submission_id, id);
        assert_eq!(items[0].credential_ref, registry::credential_ref(&id));
        // Copy/export/manage paths work off the binding without a body.
        let exported = export_bytes(&vault, &root, ORIGIN, &id).unwrap();
        let owner = recovery::decode_recovery(&exported).unwrap();
        assert_eq!(owner.secret, secret);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sharing_gate_blocks_measurements_but_allows_serving() {
        use crate::server::Lifecycle;
        let state = AppState::default();
        assert!(guard::ensure_idle(&state).is_ok());
        // Normal serving operation still allows sharing.
        state.server.lock().unwrap().lifecycle = Lifecycle::Ready;
        assert!(guard::ensure_idle(&state).is_ok());
        state.server.lock().unwrap().lifecycle = Lifecycle::Stopped;
        // Genuine benchmark entry points block it: the operation lock the
        // benchmark runner holds for the whole run, and tracked processes.
        let _held = state.operation.try_lock().unwrap();
        assert_eq!(
            guard::ensure_idle(&state).unwrap_err().code,
            code::MEASUREMENT_ACTIVE
        );
        drop(_held);
        *state.bench_pid.lock().unwrap() = Some(7);
        assert_eq!(
            guard::ensure_idle(&state).unwrap_err().code,
            code::MEASUREMENT_ACTIVE
        );
        *state.bench_pid.lock().unwrap() = None;
        assert!(guard::ensure_idle(&state).is_ok());
    }
}
