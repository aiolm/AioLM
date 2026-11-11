//! Launch preflight ownership and explicit model verification commands.
use crate::launch_validation::{validate_launch, validate_start_config};
use crate::{config, gpu, hardware, runtime, state::AppState};
use std::sync::atomic::Ordering;
use tauri::State;

#[tauri::command]
pub(crate) async fn preflight_launch(
    state: State<'_, AppState>,
    cfg: config::AppConfig,
    operation_id: Option<String>,
) -> Result<config::AppConfig, String> {
    run_launch_preflight(&state, cfg, operation_id).await
}

async fn run_launch_preflight(
    state: &AppState,
    mut cfg: config::AppConfig,
    operation_id: Option<String>,
) -> Result<config::AppConfig, String> {
    let job = state
        .launch_jobs
        .begin(operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))?;
    if state.exiting.load(Ordering::Acquire) || job.cancel.load(Ordering::Acquire) {
        return Err("server start cancelled".into());
    }
    let result = validate_launch(&mut cfg, Some(&job.cancel), false).await;
    // A cancellation racing a successful probe must not publish settings for
    // the caller to save or use to replace a running model.
    if state.exiting.load(Ordering::Acquire) || job.cancel.load(Ordering::Acquire) {
        return Err("server start cancelled".into());
    }
    result?;
    Ok(cfg)
}

#[tauri::command]
pub(crate) fn preflight_launch_cancel(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<(), String> {
    state.launch_jobs.cancel(&operation_id)
}

/// Cancel only this operation's preflight and native launch generation.
#[tauri::command]
pub(crate) fn launch_cancel(
    state: State<'_, AppState>,
    operation_id: String,
    session_id: Option<String>,
) -> Result<(), String> {
    super::server::cancel_launch_operation(&state, &operation_id, session_id.as_deref())
}

/// Accept a blocked GPU placement and let it start anyway.
///
/// The refusal prints the key for the exact combination it measured; nothing
/// else unlocks, so agreeing to run one known-bad setup cannot quietly cover a
/// different runtime, GPU selection, or machine.
#[tauri::command]
pub(crate) async fn allow_verification_override(key: String) -> Result<(), String> {
    crate::verify::allow_override(&key)
}

/// Score the selected model's own weights on the selected devices against the
/// host, and store the verdict.
///
/// Opt-in on purpose. The launch gate uses a tiny canary because it has to be
/// cheap enough to run before every unverified start; that canary cannot reach
/// an architecture-specific kernel, and it is not the user's quantization. This
/// closes that gap for one model at the cost of streaming it twice, which takes
/// minutes rather than seconds, so nothing calls it automatically.
#[tauri::command]
pub(crate) async fn verify_model_deeply(
    state: State<'_, AppState>,
    mut cfg: config::AppConfig,
) -> Result<crate::verify::Record, String> {
    crate::providers::adapter::require_feature(
        &cfg,
        crate::providers::adapter::RuntimeFeature::DeepVerification,
    )?;
    let _operation = begin_deep_verification(&state)?;
    cfg.normalize();
    cfg.validate()?;
    if crate::providers::provider_of(&cfg) != crate::providers::ProviderId::Llama {
        return crate::verify::engine::run_deep(&cfg, state.verify_cancel.clone()).await;
    }
    validate_start_config(&mut cfg)?;
    let capabilities = runtime::probe(&cfg.active_backend, &cfg.active_build).await?;
    let profile = hardware::detect();
    let resolved = gpu::resolve_with_runtime_devices(
        &cfg.gpu,
        &cfg.active_backend,
        &profile,
        &capabilities.devices,
    )?;
    crate::verify::run_deep(
        &cfg,
        &resolved,
        &profile.fingerprint,
        &capabilities.devices,
        Some(&state.verify_cancel),
    )
    .await
}

/// Ask a deep verification in flight to stop. It reads the flag between passes
/// and between chunks, so a cancel is honoured without killing the process.
#[tauri::command]
pub(crate) fn verify_cancel(state: State<'_, AppState>) {
    state.verify_cancel.store(true, Ordering::Release);
}

fn begin_deep_verification(state: &AppState) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
    let operation = state
        .operation
        .try_lock()
        .map_err(|_| "another model operation is in progress".to_string())?;
    if state.exiting.load(Ordering::Acquire) {
        return Err("application is exiting".into());
    }
    if state.runtime_busy.load(Ordering::Acquire) {
        return Err("wait for the runtime operation to finish before deep verification".into());
    }
    if super::runtimes::runtime_resources_in_use(state)? {
        return Err("stop all model sessions before deep verification".into());
    }
    // Only the run that owns the operation may clear a previous cancellation.
    state.verify_cancel.store(false, Ordering::Release);
    Ok(operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_queued_preflight_cancel_stops_before_validation_and_releases_its_owner() {
        let state = AppState::default();
        state.launch_jobs.cancel("queued-launch").unwrap();
        let result = run_launch_preflight(
            &state,
            config::AppConfig::default(),
            Some("queued-launch".into()),
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("server start cancelled"));
        let retry = state.launch_jobs.begin("queued-launch".into()).unwrap();
        assert!(!retry.cancel.load(Ordering::Acquire));
        // Existing cfg-only clients still enter the ordinary validation gate.
        let legacy = run_launch_preflight(&state, config::AppConfig::default(), None).await;
        assert!(legacy.is_err());
        assert_ne!(legacy.err().as_deref(), Some("server start cancelled"));
    }

    #[tokio::test]
    async fn an_exiting_app_refuses_a_preflight_before_executing_the_runtime() {
        let state = AppState::default();
        state.begin_normal_exit();
        let result = run_launch_preflight(
            &state,
            config::AppConfig::default(),
            Some("exit-launch".into()),
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("server start cancelled"));
    }

    #[test]
    fn deep_verification_excludes_active_sessions_and_preserves_an_existing_run_cancellation() {
        let state = AppState::default();
        let first = begin_deep_verification(&state).unwrap();
        state.verify_cancel.store(true, Ordering::Release);
        assert!(begin_deep_verification(&state).is_err());
        assert!(state.verify_cancel.load(Ordering::Acquire));
        drop(first);
        let named = state
            .sessions
            .get_or_create("synthetic", "Synthetic")
            .unwrap();
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Ready;
        assert!(begin_deep_verification(&state)
            .err()
            .unwrap()
            .contains("all model sessions"));
        assert!(state.verify_cancel.load(Ordering::Acquire));
        named.state.lock().unwrap().lifecycle = crate::server::Lifecycle::Stopped;
        state.runtime_busy.store(true, Ordering::Release);
        assert!(begin_deep_verification(&state).is_err());
        state.runtime_busy.store(false, Ordering::Release);
        state.exiting.store(true, Ordering::Release);
        assert!(begin_deep_verification(&state).is_err());
        state.exiting.store(false, Ordering::Release);
        let recovered = begin_deep_verification(&state).unwrap();
        assert!(!state.verify_cancel.load(Ordering::Acquire));
        drop(recovered);
    }
}
