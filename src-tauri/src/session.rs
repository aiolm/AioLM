//! Multi-session registry on top of `server::ServerState`.
//!
//! A "session" is one llama-server process bundle: a primary model plus an
//! optional vision projector and an optional speculative draft model, each
//! with its own port, child process, API key, and lifecycle. The legacy
//! single-server `start_server`/`stop_server`/`server_status`/`unload_model`
//! commands in `commands/server.rs` keep operating on exactly one session —
//! `DEFAULT_SESSION_ID` — completely unchanged, so existing frontend code and
//! tests see no behavior change. This module tracks any *additional*
//! sessions started alongside it, keyed by a caller-chosen (typically UUID)
//! string id.

use crate::server::{self, ErrBuf, Lifecycle, ServerState};
use serde::Serialize;
use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

pub const DEFAULT_SESSION_ID: &str = "default";

pub struct SessionEntry {
    pub id: String,
    pub name: Mutex<String>,
    pub state: Arc<Mutex<ServerState>>,
    pub err: Arc<ErrBuf>,
}

impl SessionEntry {
    fn new(id: String, name: String) -> Arc<Self> {
        Arc::new(Self {
            id,
            name: Mutex::new(name),
            state: Arc::new(Mutex::new(ServerState::new())),
            err: Arc::new(ErrBuf::default()),
        })
    }

    pub fn display_name(&self) -> String {
        self.name
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

/// Tracks every non-default session. The default session's `ServerState`
/// lives directly on `AppState` in `state.rs`, exactly as it did before
/// multi-session support existed; this registry only holds the extra ones.
#[derive(Default)]
pub struct SessionManager {
    extra: Mutex<HashMap<String, Arc<SessionEntry>>>,
    pending_starts: Mutex<HashMap<String, Vec<Arc<AtomicBool>>>>,
}

pub struct PendingStartGuard {
    manager: Arc<SessionManager>,
    id: String,
    cancel: Arc<AtomicBool>,
}

impl PendingStartGuard {
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

impl Drop for PendingStartGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.manager.pending_starts.lock() {
            if let Some(tokens) = pending.get_mut(&self.id) {
                tokens.retain(|current| !Arc::ptr_eq(current, &self.cancel));
                if tokens.is_empty() {
                    pending.remove(&self.id);
                }
            }
        }
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every tracked non-default session, in no particular order.
    pub fn entries(&self) -> Vec<Arc<SessionEntry>> {
        self.extra
            .lock()
            .map(|guard| guard.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn ids(&self) -> Vec<String> {
        self.extra
            .lock()
            .map(|guard| guard.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<Arc<SessionEntry>> {
        self.extra.lock().ok()?.get(id).cloned()
    }

    pub fn begin_pending_start(self: &Arc<Self>, id: &str) -> Result<PendingStartGuard, String> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.pending_starts
            .lock()
            .map_err(|_| "pending session registry lock was poisoned".to_string())?
            .entry(id.to_string())
            .or_default()
            .push(cancel.clone());
        Ok(PendingStartGuard {
            manager: self.clone(),
            id: id.to_string(),
            cancel,
        })
    }

    pub fn cancel_pending_start(&self, id: &str) {
        if let Ok(pending) = self.pending_starts.lock() {
            if let Some(tokens) = pending.get(id) {
                for cancel in tokens {
                    cancel.store(true, Ordering::Release);
                }
            }
        }
    }

    pub fn cancel_all_pending_starts(&self) {
        if let Ok(pending) = self.pending_starts.lock() {
            for tokens in pending.values() {
                for cancel in tokens {
                    cancel.store(true, Ordering::Release);
                }
            }
        }
    }

    /// Fetch the tracked entry for `id`, creating one named `name` if this is
    /// the first time this id has been seen.
    pub fn get_or_create(&self, id: &str, name: &str) -> Result<Arc<SessionEntry>, String> {
        let mut guard = self
            .extra
            .lock()
            .map_err(|_| "session registry lock was poisoned".to_string())?;
        if let Some(existing) = guard.get(id) {
            return Ok(existing.clone());
        }
        let entry = SessionEntry::new(id.to_string(), name.to_string());
        guard.insert(id.to_string(), entry.clone());
        Ok(entry)
    }

    /// Drop a session's tracking entry entirely. Callers must stop its
    /// process first (see `server::kill`); this only forgets it existed.
    pub fn forget(&self, id: &str) -> Option<Arc<SessionEntry>> {
        self.extra.lock().ok()?.remove(id)
    }

    /// Ports currently claimed by a live (non-`Stopped`) tracked session.
    pub fn claimed_ports(&self) -> Vec<u16> {
        self.claimed_ports_excluding("")
    }

    /// Same as [`Self::claimed_ports`], but ignores `exclude_id`'s own
    /// entry — used when relaunching a session in place, so its own
    /// about-to-be-replaced port is never mistaken for a collision with
    /// itself.
    pub fn claimed_ports_excluding(&self, exclude_id: &str) -> Vec<u16> {
        self.entries()
            .iter()
            .filter(|entry| entry.id != exclude_id)
            .filter_map(|entry| {
                let state = entry.state.lock().ok()?;
                (state.lifecycle != Lifecycle::Stopped)
                    .then(|| server::port_from_url(&state.url))
                    .flatten()
            })
            .collect()
    }
}

/// Every id a "stop existing sessions before loading" policy must terminate
/// before `starting_id` comes up: every currently tracked id except itself.
/// Pure and side-effect-free so the policy decision is unit-testable without
/// spawning any process.
pub fn ids_to_stop_for_policy(all_ids: &[String], starting_id: &str) -> Vec<String> {
    all_ids
        .iter()
        .filter(|id| id.as_str() != starting_id)
        .cloned()
        .collect()
}

/// Reserve an ephemeral loopback port, then release it immediately so
/// llama-server can bind it in turn. There is an inherent, small race between
/// the release and the child's own bind; a losing race surfaces as an
/// ordinary, retryable "failed to start" error rather than corrupting any
/// state, which is why this loops a bounded number of times against the
/// caller's excluded-port list rather than trying to close the race window.
pub fn pick_port(excluded: &[u16]) -> Result<u16, String> {
    for _ in 0..16 {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("failed to reserve a session port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("failed to read reserved session port: {error}"))?
            .port();
        drop(listener);
        if !excluded.contains(&port) {
            return Ok(port);
        }
    }
    Err("could not find a free port for this session after multiple attempts".into())
}

/// Resolve the port a session should launch on: the caller's explicit choice
/// when it is set and free, otherwise a freshly picked one. `0` (and any
/// port already claimed by another tracked session) always triggers a fresh
/// pick, so a config saved before multi-session support existed — whose
/// `port` may collide with whatever else happens to be running — still gets
/// its own port instead of failing to bind.
pub fn effective_port(requested: u16, excluded: &[u16]) -> Result<u16, String> {
    if requested != 0 && !excluded.contains(&requested) {
        return Ok(requested);
    }
    pick_port(excluded)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SessionStatus {
    pub id: String,
    pub name: String,
    pub state: String,
    pub url: Option<String>,
    pub model: Option<String>,
    pub mmproj: Option<String>,
    pub draft_model: Option<String>,
    pub api_key: Option<String>,
    pub pid: Option<u32>,
    pub active_requests: u32,
    pub idle_seconds: u64,
    pub log_tail: Option<String>,
    pub error: Option<String>,
    pub execution: Option<crate::config::execution::ExecutionSettings>,
}

/// Reap a crashed child (see `server::reap_if_exited`) and snapshot the
/// resulting state. Shared by the default session's status view and every
/// entry in the registry so both report crashes identically.
pub fn build_status(
    id: &str,
    name: &str,
    state: &mut ServerState,
    err: &Arc<ErrBuf>,
) -> SessionStatus {
    server::reap_if_exited(state, err);
    let log_tail = err.tail();
    SessionStatus {
        id: id.to_string(),
        name: name.to_string(),
        state: state.lifecycle.as_str().to_string(),
        url: (!state.url.is_empty()).then(|| state.url.clone()),
        model: (!state.model.is_empty()).then(|| state.model.clone()),
        mmproj: (!state.mmproj.is_empty()).then(|| state.mmproj.clone()),
        draft_model: (!state.draft_model.is_empty()).then(|| state.draft_model.clone()),
        api_key: (state.lifecycle == Lifecycle::Ready && !state.api_key.is_empty())
            .then(|| state.api_key.clone()),
        pid: state.child.as_ref().map(std::process::Child::id),
        active_requests: state.active_requests,
        idle_seconds: state.idle_seconds(),
        log_tail: (!log_tail.trim().is_empty()).then_some(log_tail),
        error: state
            .last_error
            .as_ref()
            .map(|error| server::redact_text(error, &state.redaction_secret)),
        execution: state
            .execution
            .as_ref()
            .map(crate::config::execution::snapshot),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn registry_creates_reuses_and_forgets_entries_independently() {
        let manager = SessionManager::new();
        assert!(manager.get("s1").is_none());
        let first = manager.get_or_create("s1", "Session One").unwrap();
        let again = manager.get_or_create("s1", "ignored on reuse").unwrap();
        assert!(
            Arc::ptr_eq(&first, &again),
            "reuse must return the same entry"
        );
        assert_eq!(first.display_name(), "Session One");

        manager.get_or_create("s2", "Session Two").unwrap();
        assert_eq!(manager.ids().len(), 2);

        let forgotten = manager.forget("s1").expect("s1 was tracked");
        assert_eq!(forgotten.id, "s1");
        assert!(manager.get("s1").is_none());
        assert_eq!(manager.ids(), vec!["s2".to_string()]);
    }

    #[test]
    fn a_stop_request_cancels_a_start_waiting_for_the_operation_lock() {
        let manager = Arc::new(SessionManager::new());
        let pending = manager.begin_pending_start("queued").unwrap();
        let cancel = pending.cancel_flag();
        let second_pending = manager.begin_pending_start("queued").unwrap();
        let second_cancel = second_pending.cancel_flag();
        assert!(!cancel.load(Ordering::Acquire));
        assert!(!second_cancel.load(Ordering::Acquire));

        manager.cancel_pending_start("queued");

        assert!(cancel.load(Ordering::Acquire));
        assert!(second_cancel.load(Ordering::Acquire));
        drop(pending);
        drop(second_pending);
        let replacement = manager.begin_pending_start("queued").unwrap();
        assert!(!replacement.cancel_flag().load(Ordering::Acquire));
    }

    #[test]
    fn stop_existing_policy_targets_every_other_tracked_session() {
        let all = vec!["default".to_string(), "s1".to_string(), "s2".to_string()];
        let mut to_stop = ids_to_stop_for_policy(&all, "s1");
        to_stop.sort();
        assert_eq!(to_stop, vec!["default".to_string(), "s2".to_string()]);

        // Starting a brand-new id (not yet tracked) still spares nothing that
        // already exists.
        let mut to_stop = ids_to_stop_for_policy(&all, "s3-not-yet-created");
        to_stop.sort();
        assert_eq!(to_stop, all);

        let mut to_stop = ids_to_stop_for_policy(&all, DEFAULT_SESSION_ID);
        to_stop.sort();
        assert_eq!(to_stop, vec!["s1".to_string(), "s2".to_string()]);
    }

    #[test]
    fn effective_port_reassigns_zero_or_colliding_requests() {
        let claimed = vec![8080];
        let picked = effective_port(0, &claimed).expect("port 0 always reassigns");
        assert_ne!(picked, 0);

        let picked = effective_port(8080, &claimed).expect("colliding port reassigns");
        assert_ne!(picked, 8080);

        let picked = effective_port(59123, &claimed).expect("free explicit port is kept");
        assert_eq!(picked, 59123);
    }

    #[test]
    fn claimed_ports_ignores_stopped_sessions() {
        let manager = SessionManager::new();
        let entry = manager.get_or_create("s1", "Session One").unwrap();
        {
            let mut state = entry.state.lock().unwrap();
            state.url = "http://127.0.0.1:59120/v1".into();
            state.lifecycle = Lifecycle::Ready;
        }
        assert_eq!(manager.claimed_ports(), vec![59120]);

        entry.state.lock().unwrap().lifecycle = Lifecycle::Stopped;
        assert!(manager.claimed_ports().is_empty());
    }

    /// Exercises the same Stopped -> Starting -> Ready -> Crashed transition
    /// a real session goes through, and confirms `build_status` reflects
    /// each state — including reaping a process that exited on its own,
    /// mirroring `server::reap_if_exited`'s own coverage but through the
    /// session-level entry point every registry consumer actually calls.
    #[test]
    fn session_status_tracks_lifecycle_through_a_crash() {
        let entry = SessionEntry::new("s1".into(), "Session One".into());
        assert_eq!(entry.state.lock().unwrap().lifecycle, Lifecycle::Stopped);

        let child = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", "exit", "0"])
                .spawn()
                .unwrap()
        } else {
            Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap()
        };
        {
            let mut state = entry.state.lock().unwrap();
            state.attach_starting(
                child,
                "http://127.0.0.1:59121/v1".into(),
                "token".into(),
                "model.gguf".into(),
                String::new(),
                String::new(),
            );
            state.lifecycle = Lifecycle::Ready;
        }

        // Give the short-lived child a moment to actually exit before the
        // status build reaps it; try_wait would otherwise still see it as
        // running on a slow CI runner.
        std::thread::sleep(std::time::Duration::from_millis(200));

        let mut state = entry.state.lock().unwrap();
        let status = build_status(&entry.id, &entry.display_name(), &mut state, &entry.err);
        assert_eq!(status.state, "crashed");
        assert!(
            status.api_key.is_none(),
            "crashed sessions must not expose the api key"
        );
        assert!(status.error.is_some());
    }
}
