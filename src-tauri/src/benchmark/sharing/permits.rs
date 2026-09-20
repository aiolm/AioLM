//! In-memory upload permits, sharing generations and request abortion.
//!
//! Permits returned by session polling are kept only here, never in the
//! registry, the vault or the WebView. Every sharing command snapshots the
//! global epoch plus its submission generation before work; cancellation or
//! any measurement start bumps them and aborts tracked in-flight HTTP, so
//! stale completions can never finish privileged work. A fresh attempt after
//! a cancel simply starts a new generation: nothing sticky blocks retries.

use futures_util::future::AbortHandle;
use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Server permits expire within 5 minutes; the client additionally caps
/// lifetime from receipt so a stale permit is never attached.
const PERMIT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PERMIT_LEN: usize = 4096;
/// Bounded request tracking: per-submission and global caps keep the table
/// small; overflow aborts the oldest tracked request (fail safe).
const MAX_TRACKED_PER_SUBMISSION: usize = 8;
const MAX_TRACKED_SUBMISSIONS: usize = 128;

struct StoredPermit {
    permit: String,
    session_id: String,
    received_at: Instant,
}

struct TrackedRequest {
    id: u64,
    abort: AbortHandle,
}

struct Ephemeral {
    permits: HashMap<String, StoredPermit>,
    generations: HashMap<String, u64>,
    requests: HashMap<String, Vec<TrackedRequest>>,
    order: VecDeque<(String, u64)>,
    next_request_id: u64,
    epoch: u64,
}

static EPHEMERAL: LazyLock<Mutex<Ephemeral>> = LazyLock::new(|| {
    Mutex::new(Ephemeral {
        permits: HashMap::new(),
        generations: HashMap::new(),
        requests: HashMap::new(),
        order: VecDeque::new(),
        next_request_id: 1,
        epoch: 0,
    })
});

fn lock() -> std::sync::MutexGuard<'static, Ephemeral> {
    EPHEMERAL.lock().expect("sharing permit lock was poisoned")
}

/// Serializes unit tests that share the process-global ephemeral store.
/// Poison-tolerant: a panicking test must not cascade into unrelated tests.
#[cfg(test)]
pub(crate) fn test_serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Global sharing generation, bumped by every measurement start.
pub(crate) fn epoch() -> u64 {
    lock().epoch
}

/// Per-submission generation, bumped by cancel. Fresh attempts after a
/// cancel start clean: no sticky flag blocks submit or replay.
pub(crate) fn generation(submission_id: &str) -> u64 {
    lock().generations.get(submission_id).copied().unwrap_or(0)
}

/// Abort every tracked sharing request and forget every permit. Called the
/// moment any benchmark measurement starts so no sharing network work
/// continues into actual timed work.
pub(crate) fn note_measurement_start() {
    let mut state = lock();
    state.epoch = state.epoch.wrapping_add(1);
    state.permits.clear();
    for (_, tracked) in state.requests.drain() {
        for request in tracked {
            request.abort.abort();
        }
    }
    state.order.clear();
}

/// Remember a permit for one submission. Overwrites any previous permit for
/// the same submission; permits are single-session scoped.
pub(crate) fn store_permit(submission_id: &str, session_id: &str, permit: &str) {
    if permit.is_empty() || permit.len() > MAX_PERMIT_LEN {
        return;
    }
    let mut state = lock();
    state.permits.insert(
        submission_id.into(),
        StoredPermit {
            permit: permit.into(),
            session_id: session_id.into(),
            received_at: Instant::now(),
        },
    );
}

/// Clone the live permit for a submission, if any. Expired permits are
/// dropped and reported as absent so submit falls back to the replay path.
pub(crate) fn live_permit(submission_id: &str) -> Option<(String, String)> {
    let mut state = lock();
    let expired = state
        .permits
        .get(submission_id)
        .is_some_and(|stored| stored.received_at.elapsed() > PERMIT_TTL);
    if expired {
        state.permits.remove(submission_id);
        return None;
    }
    state
        .permits
        .get(submission_id)
        .map(|stored| (stored.permit.clone(), stored.session_id.clone()))
}

/// Forget one submission's permit without touching its generation.
pub(crate) fn clear_permit(submission_id: &str) {
    lock().permits.remove(submission_id);
}

/// Cancel pending sharing work for one submission: abort its tracked
/// requests, forget its permit and bump its generation. Later attempts start
/// a new generation and are never blocked by this cancel.
pub(crate) fn cancel_submission(submission_id: &str) {
    let mut state = lock();
    state.permits.remove(submission_id);
    if let Some(tracked) = state.requests.remove(submission_id) {
        for request in tracked {
            request.abort.abort();
        }
    }
    state
        .generations
        .entry(submission_id.into())
        .and_modify(|generation| *generation = generation.wrapping_add(1))
        .or_insert(1);
}

/// Atomically check the expected epoch+generation under the permit mutex and
/// register the request only when still live. Callers must not poll the HTTP
/// future when this returns None: a cancel or measurement start already
/// happened, and polling would send a request no abort can stop in time.
pub(crate) fn track_request_if_live(
    submission_id: &str,
    epoch: u64,
    generation: u64,
    abort: AbortHandle,
) -> Option<u64> {
    let mut state = lock();
    if state.epoch != epoch
        || state.generations.get(submission_id).copied().unwrap_or(0) != generation
    {
        return None;
    }
    let id = state.next_request_id;
    state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
    {
        let tracked = state.requests.entry(submission_id.into()).or_default();
        tracked.push(TrackedRequest { id, abort });
        while tracked.len() > MAX_TRACKED_PER_SUBMISSION {
            tracked.remove(0).abort.abort();
        }
    }
    state.order.push_back((submission_id.into(), id));
    while state.order.len() > MAX_TRACKED_SUBMISSIONS * MAX_TRACKED_PER_SUBMISSION {
        if let Some((submission, old_id)) = state.order.pop_front() {
            if let Some(tracked) = state.requests.get_mut(&submission) {
                if let Some(position) = tracked.iter().position(|request| request.id == old_id) {
                    tracked.remove(position).abort.abort();
                }
            }
        }
    }
    Some(id)
}

/// Forget a completed request token. Aborted tokens are removed by the same
/// path; unknown tokens are ignored.
pub(crate) fn untrack_request(submission_id: &str, id: u64) {
    let mut state = lock();
    if let Some(tracked) = state.requests.get_mut(submission_id) {
        tracked.retain(|request| request.id != id);
        if tracked.is_empty() {
            state.requests.remove(submission_id);
        }
    }
}

#[cfg(test)]
pub(crate) fn tracked_count() -> usize {
    lock().requests.values().map(Vec::len).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_cancel_and_revoke_on_measurement() {
        let _serial = super::test_serial();
        let submission = "permit-submission";
        let before = epoch();
        store_permit(submission, "session-1", "permit-1");
        assert_eq!(
            live_permit(submission),
            Some(("permit-1".into(), "session-1".into()))
        );
        // Cancel drops the permit and bumps only this submission's generation.
        let generation_before = generation(submission);
        cancel_submission(submission);
        assert!(generation(submission) != generation_before);
        assert_eq!(generation("untouched-submission"), 0);
        assert_eq!(live_permit(submission), None);
        // A fresh attempt works immediately: nothing sticky blocks retries.
        store_permit(submission, "session-2", "permit-2");
        assert!(live_permit(submission).is_some());
        note_measurement_start();
        assert!(epoch() != before);
        assert_eq!(live_permit(submission), None);
    }

    #[test]
    fn oversized_permits_are_never_stored() {
        let _serial = super::test_serial();
        store_permit("oversized", "session", &"p".repeat(MAX_PERMIT_LEN + 1));
        assert_eq!(live_permit("oversized"), None);
    }

    #[tokio::test]
    // Test-only serialization across awaits: lock order is always
    // test_serial -> permit store, never reversed, so no deadlock.
    #[allow(clippy::await_holding_lock)]
    async fn abort_handles_cancel_tracked_requests() {
        use futures_util::future::Abortable;

        let _serial = super::test_serial();
        let submission = "abort-submission";
        let (handle, registration) = AbortHandle::new_pair();
        let token = track_request_if_live(submission, epoch(), generation(submission), handle)
            .expect("fresh generation must be live");
        assert_eq!(tracked_count(), 1);
        let pending = Abortable::new(
            async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                "finished"
            },
            registration,
        );
        cancel_submission(submission);
        assert!(pending.await.is_err());
        untrack_request(submission, token);
        assert_eq!(tracked_count(), 0);
    }
}
