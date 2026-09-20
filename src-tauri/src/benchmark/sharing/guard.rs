//! Measurement isolation for sharing work.
//!
//! Sharing must never overlap a benchmark measurement: OS vault prompts and
//! HTTP round trips could perturb timing, and a privileged upload must not
//! bypass the measurement guard. This check peeks with non-blocking locks
//! only and fails closed, so sharing can never make a measurement wait.
//! Measurements that start while sharing work is in flight abort it through
//! the [`super::permits`] generation tracking, driven from the benchmark IPC
//! the moment a measurement owns the operation lock.
//!
//! Normal serving operation (a Ready app server or model session) is not a
//! measurement and does not block sharing. Only genuine measurement and
//! process signals gate sharing: the operation lock held for the whole
//! benchmark run, a tracked bench process, runtime mutations and shutdown.

use crate::state::AppState;
use std::sync::atomic::Ordering;

/// True while genuine benchmark measurement activity is running: the
/// operation lock held across the whole run, a tracked bench process, a
/// runtime mutation, or application shutdown. A normally serving Ready
/// server or session explicitly does not count.
pub(crate) fn measurement_active(state: &AppState) -> bool {
    if state.exiting.load(Ordering::Acquire) {
        return true;
    }
    if state.runtime_busy.load(Ordering::Acquire) {
        return true;
    }
    // The benchmark runner holds this for the whole measurement; any other
    // holder (runtime install, model scan, server/session launch) also gates
    // sharing while it runs.
    if state.operation.try_lock().is_err() {
        return true;
    }
    match state.bench_pid.try_lock() {
        Ok(running) => {
            if running.is_some() {
                return true;
            }
        }
        Err(_) => return true,
    }
    false
}

/// Fail-closed gate used by sharing commands before vault, registry or
/// network work.
pub(crate) fn ensure_idle(state: &AppState) -> Result<(), super::errors::SharingError> {
    if measurement_active(state) {
        return Err(super::errors::SharingError::measurement_active());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Lifecycle;

    #[test]
    fn idle_by_default_and_blocked_by_genuine_measurement_signals() {
        let state = AppState::default();
        assert!(!measurement_active(&state));
        // A held operation lock (benchmark owns it for the whole run).
        let operation = state.operation.try_lock().unwrap();
        assert!(measurement_active(&state));
        drop(operation);
        assert!(!measurement_active(&state));
        // A tracked bench process.
        *state.bench_pid.lock().unwrap() = Some(1234);
        assert!(measurement_active(&state));
        *state.bench_pid.lock().unwrap() = None;
        assert!(!measurement_active(&state));
        // Runtime mutation and shutdown also gate sharing.
        state.runtime_busy.store(true, Ordering::Release);
        assert!(measurement_active(&state));
        state.runtime_busy.store(false, Ordering::Release);
        assert!(ensure_idle(&state).is_ok());
        state.exiting.store(true, Ordering::Release);
        assert!(measurement_active(&state));
        state.exiting.store(false, Ordering::Release);
    }

    #[test]
    fn normal_serving_does_not_block_sharing() {
        let state = AppState::default();
        // A Ready app server doing normal serving work is not a measurement.
        state.server.lock().unwrap().lifecycle = Lifecycle::Ready;
        assert!(!measurement_active(&state));
        assert!(ensure_idle(&state).is_ok());
        state.server.lock().unwrap().lifecycle = Lifecycle::Stopped;
    }
}
