//! Request-time model resolution for the external API.
//!
//! The listener never caches an upstream: every request re-reads the live
//! session registry, so loading, unloading or replacing a model needs no
//! coordination with the listener beyond the per-session request lease.
use super::http::ApiError;
use crate::server::{self, ErrBuf, Lifecycle, ServerState};
use crate::session::{SessionManager, DEFAULT_SESSION_ID};
use std::sync::{Arc, Mutex, MutexGuard};

/// Read access to every model session the API can route to.
#[derive(Clone)]
pub struct ModelSource {
    default: Arc<Mutex<ServerState>>,
    default_err: Arc<ErrBuf>,
    sessions: Arc<SessionManager>,
}

impl ModelSource {
    pub fn new(
        default: Arc<Mutex<ServerState>>,
        default_err: Arc<ErrBuf>,
        sessions: Arc<SessionManager>,
    ) -> Self {
        Self {
            default,
            default_err,
            sessions,
        }
    }

    /// Snapshot every session that can serve a request right now.
    pub(super) fn snapshot(&self) -> Catalog {
        let mut targets = vec![(
            DEFAULT_SESSION_ID.to_string(),
            self.default.clone(),
            self.default_err.clone(),
        )];
        targets.extend(
            self.sessions
                .entries()
                .into_iter()
                .map(|entry| (entry.id.clone(), entry.state.clone(), entry.err.clone())),
        );
        let mut ready = Vec::new();
        let mut loading = 0;
        for (session_id, target, err) in targets {
            let mut state = lock(&target);
            // A crashed worker must stop being advertised as soon as it is
            // noticed, not only when the desktop UI next polls its status. A
            // session with no tracked process is left alone: requests to it
            // fail as upstream errors instead of being second-guessed here.
            if state.child.is_some() {
                server::reap_if_exited(&mut state, &err);
            }
            match state.lifecycle {
                Lifecycle::Ready if !state.url.is_empty() && !state.api_key.is_empty() => {
                    let model_id = file_name(&state.model)
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&session_id)
                        .to_string();
                    ready.push(Candidate {
                        url: state.url.clone(),
                        key: state.api_key.clone(),
                        advertised: model_id.clone(),
                        model_id,
                        session_id,
                        target: target.clone(),
                    });
                }
                Lifecycle::Starting => loading += 1,
                _ => {}
            }
        }
        ready.sort_by(|a, b| (&a.model_id, &a.session_id).cmp(&(&b.model_id, &b.session_id)));
        // Two sessions serving the same file must stay individually
        // addressable, so each is advertised with its session id appended.
        for index in 0..ready.len() {
            let shared = ready
                .iter()
                .filter(|other| other.model_id == ready[index].model_id)
                .count();
            if shared > 1 {
                ready[index].advertised =
                    format!("{}@{}", ready[index].model_id, ready[index].session_id);
            }
        }
        Catalog { ready, loading }
    }

    /// Resolve `requested` against the sessions ready right now and lease the
    /// winner for the lifetime of the returned guard.
    pub(super) fn acquire(&self, requested: Option<&str>) -> Result<Lease, RouteError> {
        // A session can be stopped or replaced between the snapshot and the
        // lease. The lease then refuses, and a fresh snapshot decides again.
        for _ in 0..4 {
            let catalog = self.snapshot();
            let candidate = catalog.select(requested)?;
            if let Some(lease) = Lease::begin(candidate) {
                return Ok(lease);
            }
        }
        Err(RouteError::Changed)
    }

    /// Attachment preprocessing chooses a session explicitly, so an unloaded
    /// target never falls back to a different model with the same file name.
    pub(super) fn acquire_session(&self, session_id: &str) -> Result<Lease, ApiError> {
        for _ in 0..4 {
            let catalog = self.snapshot();
            let target = catalog
                .ready
                .iter()
                .find(|candidate| candidate.session_id == session_id)
                .ok_or_else(|| {
                    ApiError::new(
                        400,
                        "transcription_session_unavailable",
                        "the selected transcription session is not running",
                    )
                })?;
            if let Some(lease) = Lease::begin(target) {
                return Ok(lease);
            }
        }
        Err(ApiError::new(
            503,
            "model_changed",
            "the transcription session changed; retry",
        ))
    }
}

fn lock(target: &Mutex<ServerState>) -> MutexGuard<'_, ServerState> {
    target.lock().unwrap_or_else(|error| error.into_inner())
}

fn file_name(path: &str) -> Option<&str> {
    path.rsplit(['/', '\\']).next()
}

pub(super) struct Candidate {
    pub session_id: String,
    /// File name of the loaded model.
    pub model_id: String,
    /// The id `GET /v1/models` lists; unique among ready sessions.
    pub advertised: String,
    target: Arc<Mutex<ServerState>>,
    url: String,
    key: String,
}

pub(super) struct Catalog {
    pub ready: Vec<Candidate>,
    loading: usize,
}

pub(super) enum RouteError {
    NoModel {
        loading: bool,
    },
    Required {
        available: Vec<String>,
    },
    NotFound {
        requested: String,
        available: Vec<String>,
    },
    Ambiguous {
        requested: String,
        candidates: Vec<String>,
    },
    Changed,
}

impl RouteError {
    pub(super) fn into_api_error(self) -> ApiError {
        match self {
            Self::NoModel { loading: true } => ApiError::new(
                503,
                "model_loading",
                "a model is still loading; retry when it is ready",
            ),
            Self::NoModel { loading: false } => ApiError::new(
                503,
                "model_not_loaded",
                "no model is loaded; load a model in AioLM and retry",
            ),
            Self::Required { available } => ApiError::new(
                400,
                "model_required",
                format!(
                    "several models are loaded, so `model` is required; available: {}",
                    available.join(", ")
                ),
            )
            .with_param("model"),
            Self::NotFound {
                requested,
                available,
            } => ApiError::new(
                404,
                "model_not_found",
                format!(
                    "the model `{requested}` is not loaded; available: {}",
                    available.join(", ")
                ),
            )
            .with_param("model"),
            Self::Ambiguous {
                requested,
                candidates,
            } => ApiError::new(
                400,
                "ambiguous_model",
                format!(
                    "the model `{requested}` matches several loaded sessions; use one of: {}",
                    candidates.join(", ")
                ),
            )
            .with_param("model"),
            Self::Changed => ApiError::new(
                503,
                "model_changed",
                "the model changed while the request was being routed; retry",
            ),
        }
    }
}

impl Catalog {
    fn advertised(&self) -> Vec<String> {
        self.ready
            .iter()
            .map(|candidate| candidate.advertised.clone())
            .collect()
    }

    /// Pick the session for `requested`. A name that matches several sessions
    /// is an error rather than a guess; a request without a model goes to the
    /// default session, or to the only loaded one.
    pub(super) fn select(&self, requested: Option<&str>) -> Result<&Candidate, RouteError> {
        if self.ready.is_empty() {
            return Err(RouteError::NoModel {
                loading: self.loading > 0,
            });
        }
        let Some(name) = requested.map(str::trim).filter(|name| !name.is_empty()) else {
            if let Some(default) = self
                .ready
                .iter()
                .find(|candidate| candidate.session_id == DEFAULT_SESSION_ID)
            {
                return Ok(default);
            }
            return match self.ready.as_slice() {
                [only] => Ok(only),
                _ => Err(RouteError::Required {
                    available: self.advertised(),
                }),
            };
        };
        let exact: Vec<&Candidate> = self
            .ready
            .iter()
            .filter(|candidate| candidate.advertised == name)
            .collect();
        if let [only] = exact.as_slice() {
            return Ok(only);
        }
        // A bare file name that several sessions share is advertised only in
        // its disambiguated form, so it matches nothing exactly.
        let candidates = if exact.is_empty() {
            self.ready
                .iter()
                .filter(|candidate| candidate.model_id == name)
                .collect()
        } else {
            exact
        };
        if candidates.len() > 1 {
            return Err(RouteError::Ambiguous {
                requested: name.to_string(),
                candidates: candidates
                    .iter()
                    .map(|candidate| candidate.advertised.clone())
                    .collect(),
            });
        }
        Err(RouteError::NotFound {
            requested: name.to_string(),
            available: self.advertised(),
        })
    }
}

/// One in-flight external request against one model process.
///
/// Holding a lease counts as an active request on the session, which is what
/// keeps auto-unload and model replacement away until the response (or the
/// whole stream) is finished. Dropping it - including when the connection
/// task is aborted because the API stopped - releases the count.
pub(super) struct Lease {
    target: Arc<Mutex<ServerState>>,
    upstream: String,
    key: String,
    engine: Option<crate::providers::protocol::EngineInfo>,
}

impl Lease {
    /// Count the request only if the session is still the launch the snapshot
    /// saw. The check and the increment share one lock, so a concurrent
    /// replacement either sees the request or makes this refuse.
    fn begin(candidate: &Candidate) -> Option<Self> {
        let mut state = lock(&candidate.target);
        if state.lifecycle != Lifecycle::Ready || state.api_key != candidate.key {
            return None;
        }
        state.begin_request();
        Some(Self {
            target: candidate.target.clone(),
            upstream: candidate.url.clone(),
            key: candidate.key.clone(),
            engine: state.engine.clone(),
        })
    }

    /// Base URL of the model process, ending in `/v1`.
    pub(super) fn upstream(&self) -> &str {
        &self.upstream
    }

    /// The private key of this model process. It never leaves the app.
    pub(super) fn upstream_key(&self) -> &str {
        &self.key
    }
    pub(super) fn adapt(
        &self,
        endpoint: &str,
        body: &mut serde_json::Value,
    ) -> Result<(), ApiError> {
        if let Some(engine) = &self.engine {
            crate::providers::protocol::adapt_request(engine, endpoint, body)
                .map_err(|error| ApiError::new(400, error.code, error.message))?;
        } else if endpoint.starts_with("audio/") {
            return Err(ApiError::new(
                400,
                "unsupported_task",
                "this session has no verified audio transcription capability",
            ));
        }
        Ok(())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = lock(&self.target);
        // Stopping or replacing a session clears its request count and
        // rotates the private key, so a key mismatch means this request was
        // already discarded and must not be subtracted from a newer launch.
        if state.api_key == self.key {
            state.end_request();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(target: &Arc<Mutex<ServerState>>, url: &str, key: &str, model: &str) {
        let mut state = target.lock().unwrap();
        state.lifecycle = Lifecycle::Ready;
        state.url = url.into();
        state.api_key = key.into();
        state.model = model.into();
    }

    fn source() -> (ModelSource, Arc<Mutex<ServerState>>, Arc<SessionManager>) {
        let default = Arc::new(Mutex::new(ServerState::new()));
        let sessions = Arc::new(SessionManager::new());
        let source = ModelSource::new(
            default.clone(),
            Arc::new(ErrBuf::default()),
            sessions.clone(),
        );
        (source, default, sessions)
    }

    fn add_named(sessions: &SessionManager, id: &str, model: &str) -> Arc<Mutex<ServerState>> {
        let entry = sessions.get_or_create(id, model).unwrap();
        ready(
            &entry.state,
            &format!("http://127.0.0.1:1/{id}/v1"),
            &format!("key-{id}"),
            model,
        );
        entry.state.clone()
    }

    fn active(target: &Arc<Mutex<ServerState>>) -> u32 {
        target.lock().unwrap().active_requests
    }

    fn resolved(source: &ModelSource, requested: Option<&str>) -> Result<String, String> {
        let catalog = source.snapshot();
        catalog
            .select(requested)
            .map(|candidate| candidate.session_id.clone())
            .map_err(|error| error.into_api_error().code.to_string())
    }

    #[test]
    fn model_ids_are_file_names_from_either_path_style() {
        assert_eq!(file_name("C:\\models\\qwen.gguf"), Some("qwen.gguf"));
        assert_eq!(file_name("/home/u/models/qwen.gguf"), Some("qwen.gguf"));
        assert_eq!(file_name("qwen.gguf"), Some("qwen.gguf"));
    }

    #[test]
    fn nothing_ready_is_no_model_and_a_starting_session_is_loading() {
        let (source, default, _) = source();
        assert_eq!(resolved(&source, None), Err("model_not_loaded".into()));
        default.lock().unwrap().lifecycle = Lifecycle::Starting;
        assert_eq!(resolved(&source, None), Err("model_loading".into()));
        assert_eq!(
            resolved(&source, Some("anything")),
            Err("model_loading".into())
        );
        default.lock().unwrap().lifecycle = Lifecycle::Failed;
        assert_eq!(resolved(&source, None), Err("model_not_loaded".into()));
    }

    #[test]
    fn requests_route_by_file_name_and_unknown_names_are_not_guessed() {
        let (source, default, sessions) = source();
        ready(
            &default,
            "http://127.0.0.1:1/v1",
            "key-d",
            "C:\\m\\alpha.gguf",
        );
        add_named(&sessions, "s1", "/m/beta.gguf");
        assert_eq!(resolved(&source, Some("alpha.gguf")), Ok("default".into()));
        assert_eq!(resolved(&source, Some("beta.gguf")), Ok("s1".into()));
        assert_eq!(
            resolved(&source, Some("gamma.gguf")),
            Err("model_not_found".into())
        );
        // Even with one candidate left, an unadvertised name is refused.
        default.lock().unwrap().lifecycle = Lifecycle::Stopped;
        assert_eq!(
            resolved(&source, Some("alpha.gguf")),
            Err("model_not_found".into())
        );
        assert_eq!(resolved(&source, Some("beta.gguf")), Ok("s1".into()));
    }

    #[test]
    fn a_missing_model_prefers_the_default_session_then_the_only_one() {
        let (source, default, sessions) = source();
        add_named(&sessions, "s1", "beta.gguf");
        assert_eq!(resolved(&source, None), Ok("s1".into()));
        add_named(&sessions, "s2", "gamma.gguf");
        assert_eq!(resolved(&source, None), Err("model_required".into()));
        ready(&default, "http://127.0.0.1:1/v1", "key-d", "alpha.gguf");
        assert_eq!(resolved(&source, Some("  ")), Ok("default".into()));
    }

    #[test]
    fn a_file_loaded_twice_is_ambiguous_until_addressed_by_session() {
        let (source, default, sessions) = source();
        ready(&default, "http://127.0.0.1:1/v1", "key-d", "/a/same.gguf");
        add_named(&sessions, "s1", "/b/same.gguf");
        add_named(&sessions, "s2", "other.gguf");
        let catalog = source.snapshot();
        let ids: Vec<&str> = catalog
            .ready
            .iter()
            .map(|c| c.advertised.as_str())
            .collect();
        assert_eq!(ids, ["other.gguf", "same.gguf@default", "same.gguf@s1"]);
        assert_eq!(
            resolved(&source, Some("same.gguf")),
            Err("ambiguous_model".into())
        );
        assert_eq!(resolved(&source, Some("same.gguf@s1")), Ok("s1".into()));
        assert_eq!(
            resolved(&source, Some("same.gguf@default")),
            Ok("default".into())
        );
        let message = catalog
            .select(Some("same.gguf"))
            .err()
            .unwrap()
            .into_api_error()
            .message;
        assert!(message.contains("same.gguf@default") && message.contains("same.gguf@s1"));
        // Once the duplicate goes away the plain name works again.
        sessions.get("s1").unwrap().state.lock().unwrap().lifecycle = Lifecycle::Stopped;
        assert_eq!(resolved(&source, Some("same.gguf")), Ok("default".into()));
    }

    #[test]
    fn a_lease_counts_as_an_active_request_until_dropped() {
        let (source, default, _) = source();
        ready(&default, "http://127.0.0.1:1/v1", "key-d", "alpha.gguf");
        let lease = source.acquire(Some("alpha.gguf")).ok().unwrap();
        assert_eq!(lease.upstream(), "http://127.0.0.1:1/v1");
        assert_eq!(lease.upstream_key(), "key-d");
        assert_eq!(active(&default), 1);
        let second = source.acquire(None).ok().unwrap();
        assert_eq!(active(&default), 2);
        drop(lease);
        assert_eq!(active(&default), 1);
        drop(second);
        assert_eq!(active(&default), 0);
    }

    #[test]
    fn a_stale_lease_never_subtracts_from_a_replacement_launch() {
        let (source, default, _) = source();
        ready(&default, "http://127.0.0.1:1/v1", "key-old", "alpha.gguf");
        let stale = source.acquire(None).ok().unwrap();
        // What stopping and relaunching the session does to its state.
        {
            let mut state = default.lock().unwrap();
            state.lifecycle = Lifecycle::Stopped;
            state.api_key.clear();
            state.active_requests = 0;
        }
        ready(&default, "http://127.0.0.1:2/v1", "key-new", "beta.gguf");
        let current = source.acquire(None).ok().unwrap();
        assert_eq!(current.upstream(), "http://127.0.0.1:2/v1");
        assert_eq!(active(&default), 1);
        drop(stale);
        assert_eq!(active(&default), 1, "the old request was already discarded");
        drop(current);
        assert_eq!(active(&default), 0);
    }

    #[test]
    fn a_worker_that_exited_is_no_longer_advertised() {
        let (source, default, _) = source();
        let child = if cfg!(windows) {
            std::process::Command::new("cmd")
                .args(["/C", "exit", "0"])
                .spawn()
                .unwrap()
        } else {
            std::process::Command::new("sh")
                .args(["-c", "exit 0"])
                .spawn()
                .unwrap()
        };
        {
            let mut state = default.lock().unwrap();
            state.attach_starting(
                child,
                "http://127.0.0.1:1/v1".into(),
                "key-d".into(),
                "alpha.gguf".into(),
                String::new(),
                String::new(),
            );
            state.lifecycle = Lifecycle::Ready;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !source.snapshot().ready.is_empty() {
            assert!(
                std::time::Instant::now() < deadline,
                "exit was never noticed"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(default.lock().unwrap().lifecycle, Lifecycle::Crashed);
        assert!(matches!(
            source.acquire(None),
            Err(RouteError::NoModel { .. })
        ));
    }

    #[test]
    fn a_session_that_stops_before_the_lease_is_never_leased() {
        let (source, default, _) = source();
        ready(&default, "http://127.0.0.1:1/v1", "key-d", "alpha.gguf");
        let catalog = source.snapshot();
        let candidate = catalog.select(None).ok().unwrap();
        default.lock().unwrap().lifecycle = Lifecycle::Stopping;
        assert!(Lease::begin(candidate).is_none());
        assert_eq!(active(&default), 0);
        assert!(matches!(
            source.acquire(None),
            Err(RouteError::NoModel { .. })
        ));
    }
}
