//! Operation cancellation must never become an unconditional session stop.
use super::*;

async fn start_for_target(state: &AppState, id: &str, operation: &str) -> Result<(), AppError> {
    let cfg = config::AppConfig {
        stop_existing_sessions_on_load: true,
        ..Default::default()
    };
    if id == "start-server" {
        run_start_server(state, cfg, Some(false), Some(operation.into())).await?;
    } else {
        crate::commands::sessions::run_session_start(
            state,
            id.into(),
            cfg,
            Some(true),
            Some(false),
            Some(operation.into()),
        )
        .await?;
    }
    Ok(())
}

fn target_for(state: &AppState, id: &str) -> Arc<Mutex<server::ServerState>> {
    if id == "default" {
        state.server.clone()
    } else {
        state
            .sessions
            .get_or_create(id, "Synthetic")
            .unwrap()
            .state
            .clone()
    }
}

fn cancel_for_target(state: &AppState, operation: &str, id: &str) -> Result<(), AppError> {
    cancel_launch_operation(
        state,
        operation,
        Some(if id == "start-server" { "default" } else { id }),
    )
}

#[tokio::test]
async fn scoped_cancel_before_admission_never_validates_or_spawns() {
    for id in ["start-server", "default", "named"] {
        let state = AppState::default();
        cancel_for_target(&state, "before-admission", id).unwrap();
        // Empty model is invalid: cancellation must win before validation.
        let error = start_for_target(&state, id, "before-admission")
            .await
            .unwrap_err();
        assert_eq!(error.message, "server start cancelled");
        assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
        assert!(state.server.lock().unwrap().child.is_none());
        assert!(state.sessions.get("named").is_none());
    }
}

#[tokio::test]
async fn scoped_queued_cancel_preserves_current_models_and_other_pending_starts() {
    for id in ["start-server", "default", "named"] {
        let state = AppState::default();
        let named = target_for(&state, "named");
        for target in [&state.server, &named] {
            let mut model = target.lock().unwrap();
            model.begin_launch();
            model.lifecycle = server::Lifecycle::Ready;
            model.model = "current.gguf".into();
        }
        let unrelated = state.sessions.begin_pending_start("named").unwrap();
        let gate = state.operation.lock().await;
        let start = start_for_target(&state, id, "queued");
        tokio::pin!(start);
        tokio::select! {
            biased;
            result = &mut start => panic!("queued launch finished: {result:?}"),
            _ = std::future::ready(()) => {}
        }
        cancel_for_target(&state, "queued", id).unwrap();
        assert!(!unrelated.cancel_flag().load(Ordering::Acquire));
        drop(gate);
        let error = start.await.unwrap_err();
        assert_eq!(error.message, "server start cancelled");
        assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
        for target in [&state.server, &named] {
            let model = target.lock().unwrap();
            assert_eq!(model.lifecycle, server::Lifecycle::Ready);
            assert_eq!(model.model, "current.gguf");
        }
    }
}

struct OwnedTarget {
    target: Arc<Mutex<server::ServerState>>,
    generation: u64,
}

fn bind_owned_launch(
    state: &AppState,
    id: &str,
    operation: &str,
) -> (ServingLaunch, Arc<AtomicBool>, OwnedTarget) {
    let cancel = Arc::new(AtomicBool::new(false));
    let owner = state
        .launch_jobs
        .begin_launch(operation.into(), cancel.clone())
        .unwrap();
    let target = target_for(state, id);
    let generation = {
        let mut model = target.lock().unwrap();
        let generation = model.begin_launch();
        model.bind_launch_operation(owner.operation_id(), generation);
        generation
    };
    (owner, cancel, OwnedTarget { target, generation })
}

#[test]
fn scoped_ready_cancel_stops_original_generation_after_response() {
    for id in ["default", "named"] {
        let state = AppState::default();
        let (owner, cancel, bound) = bind_owned_launch(&state, id, "original");
        bound.target.lock().unwrap().lifecycle = server::Lifecycle::Ready;
        drop(owner);
        assert!(!cancel.load(Ordering::Acquire));
        cancel_for_target(&state, "original", id).unwrap();
        let model = bound.target.lock().unwrap();
        assert_eq!(model.lifecycle, server::Lifecycle::Stopped);
        assert!(!model.is_current_launch(bound.generation));
        assert!(!model.owns_launch_operation("original"));
    }
}

#[test]
fn scoped_old_cancel_spares_replacement_even_with_identical_execution() {
    for id in ["default", "named"] {
        for replacement_model in ["original.gguf", "replacement.gguf"] {
            let state = AppState::default();
            let (owner, _, bound) = bind_owned_launch(&state, id, "old");
            {
                let mut model = bound.target.lock().unwrap();
                model.lifecycle = server::Lifecycle::Ready;
                model.model = "original.gguf".into();
                model.execution = Some(config::AppConfig {
                    active_model: "original.gguf".into(),
                    ..Default::default()
                });
            }
            drop(owner);
            let replacement_generation = {
                let mut model = bound.target.lock().unwrap();
                let generation = model.begin_launch();
                model.bind_launch_operation("replacement", generation);
                model.lifecycle = server::Lifecycle::Ready;
                model.model = replacement_model.into();
                model.execution = Some(config::AppConfig {
                    active_model: replacement_model.into(),
                    ..Default::default()
                });
                generation
            };
            cancel_for_target(&state, "old", id).unwrap();
            let model = bound.target.lock().unwrap();
            assert!(model.is_current_launch(replacement_generation));
            assert!(model.owns_launch_operation("replacement"));
            assert_eq!(model.lifecycle, server::Lifecycle::Ready);
            assert_eq!(model.model, replacement_model);
        }
    }
}

#[test]
fn scoped_cancel_respects_active_response_guard() {
    for id in ["default", "named"] {
        let state = AppState::default();
        let (owner, _, bound) = bind_owned_launch(&state, id, "responding");
        {
            let mut model = bound.target.lock().unwrap();
            model.lifecycle = server::Lifecycle::Ready;
            model.begin_request();
        }
        drop(owner);
        let error = cancel_for_target(&state, "responding", id).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Busy);
        assert!(error.message.contains("active response"));
        {
            let mut model = bound.target.lock().unwrap();
            assert!(model.is_current_launch(bound.generation));
            assert_eq!(model.lifecycle, server::Lifecycle::Ready);
            model.end_request();
        }
        cancel_for_target(&state, "responding", id).unwrap();
        assert_eq!(
            bound.target.lock().unwrap().lifecycle,
            server::Lifecycle::Stopped
        );
    }
}

#[test]
fn scoped_starting_cancel_invalidates_only_owned_generation() {
    let state = AppState::default();
    let (serving, cancel, bound) = bind_owned_launch(&state, "default", "starting");
    let launch_owner = LaunchGuard {
        target: bound.target.clone(),
        generation: bound.generation,
    };
    cancel_launch_operation(&state, "starting", None).unwrap();
    assert!(cancel.load(Ordering::Acquire));
    assert_eq!(
        bound.target.lock().unwrap().lifecycle,
        server::Lifecycle::Stopped
    );
    let replacement = bound.target.lock().unwrap().begin_launch();
    drop(launch_owner);
    drop(serving);
    assert!(bound.target.lock().unwrap().is_current_launch(replacement));
    assert_eq!(
        bound.target.lock().unwrap().lifecycle,
        server::Lifecycle::Starting
    );
}

#[test]
fn scoped_old_cancel_spares_recreated_named_target_with_same_generation() {
    let state = AppState::default();
    let (owner, _, bound) = bind_owned_launch(&state, "named", "forgotten");
    bound.target.lock().unwrap().lifecycle = server::Lifecycle::Ready;
    drop(owner);
    state.sessions.forget("named").unwrap();
    let replacement = target_for(&state, "named");
    let generation = {
        let mut model = replacement.lock().unwrap();
        let generation = model.begin_launch();
        model.bind_launch_operation("replacement", generation);
        model.lifecycle = server::Lifecycle::Ready;
        model.model = "original.gguf".into();
        generation
    };
    assert_eq!(generation, bound.generation);
    cancel_for_target(&state, "forgotten", "named").unwrap();
    let model = replacement.lock().unwrap();
    assert_eq!(model.lifecycle, server::Lifecycle::Ready);
    assert!(model.is_current_launch(generation));
}

#[test]
fn scoped_ready_owner_survives_more_than_256_unrelated_completed_launches() {
    for id in ["default", "named"] {
        let state = AppState::default();
        let other = if id == "default" { "named" } else { "default" };
        let (owner, _, bound) = bind_owned_launch(&state, id, "original");
        bound.target.lock().unwrap().lifecycle = server::Lifecycle::Ready;
        drop(owner);
        for index in 0..512 {
            let (owner, _, unrelated) = bind_owned_launch(&state, other, &format!("other-{index}"));
            unrelated.target.lock().unwrap().lifecycle = server::Lifecycle::Ready;
            drop(owner);
        }
        cancel_for_target(&state, "original", other).unwrap();
        assert_eq!(
            bound.target.lock().unwrap().lifecycle,
            server::Lifecycle::Ready
        );
        cancel_for_target(&state, "original", id).unwrap();
        assert_eq!(
            bound.target.lock().unwrap().lifecycle,
            server::Lifecycle::Stopped
        );
        assert_eq!(
            target_for(&state, other).lock().unwrap().lifecycle,
            server::Lifecycle::Ready
        );
    }
}

#[test]
fn scoped_completed_launch_does_not_retain_forgotten_target() {
    let state = AppState::default();
    let (owner, _, bound) = bind_owned_launch(&state, "named", "forgotten");
    bound.target.lock().unwrap().lifecycle = server::Lifecycle::Ready;
    let weak = Arc::downgrade(&bound.target);
    drop(owner);
    drop(bound);
    state.sessions.forget("named").unwrap();
    assert!(weak.upgrade().is_none());
}
