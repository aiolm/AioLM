//! Cancellation ownership across preflight, queued admission and serving.
use crate::error::AppError;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
struct Jobs {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled: HashSet<String>,
    order: VecDeque<String>,
    serving: HashMap<String, Arc<AtomicBool>>,
    cancelled_serving: HashSet<String>,
    cancelled_serving_order: VecDeque<String>,
}

#[derive(Default)]
pub(crate) struct LaunchJobs(Mutex<Jobs>);

pub(crate) struct PreflightJob {
    jobs: Arc<LaunchJobs>,
    id: String,
    pub cancel: Arc<AtomicBool>,
}

pub(crate) struct ServingLaunch {
    jobs: Arc<LaunchJobs>,
    id: String,
}

fn validate(id: &str) -> Result<(), AppError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err(AppError::validation("invalid launch operation identifier"));
    }
    Ok(())
}

impl LaunchJobs {
    pub(crate) fn begin(self: &Arc<Self>, id: String) -> Result<PreflightJob, AppError> {
        validate(&id)?;
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "launch preflight lock was poisoned")?;
        if jobs.active.contains_key(&id) || jobs.active.len() >= 64 {
            return Err(AppError::busy(
                "launch preflight is already active or too many preflights are running",
            ));
        }
        let cancel = Arc::new(AtomicBool::new(jobs.cancelled.remove(&id)));
        jobs.order.retain(|entry| entry != &id);
        jobs.active.insert(id.clone(), cancel.clone());
        Ok(PreflightJob {
            jobs: self.clone(),
            id,
            cancel,
        })
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), AppError> {
        validate(id)?;
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "launch preflight lock was poisoned")?;
        if let Some(cancel) = jobs.active.get(id) {
            cancel.store(true, Ordering::Release);
        } else if jobs.cancelled.insert(id.to_owned()) {
            // Cancellation IPC may arrive before the queued preflight command.
            jobs.order.push_back(id.to_owned());
            while jobs.order.len() > 256 {
                if let Some(old) = jobs.order.pop_front() {
                    jobs.cancelled.remove(&old);
                }
            }
        }
        Ok(())
    }

    /// Shares the session stop token before waiting for global launch admission.
    pub(crate) fn begin_launch(
        self: &Arc<Self>,
        id: String,
        cancel: Arc<AtomicBool>,
    ) -> Result<ServingLaunch, AppError> {
        validate(&id)?;
        let mut jobs = self.0.lock().map_err(|_| "launch jobs lock was poisoned")?;
        if jobs.serving.contains_key(&id) || jobs.serving.len() >= 64 {
            return Err(AppError::busy(
                "launch is already active or too many launches are running",
            ));
        }
        if jobs.cancelled_serving.remove(&id) {
            cancel.store(true, Ordering::Release);
        }
        jobs.cancelled_serving_order.retain(|entry| entry != &id);
        jobs.serving.insert(id.clone(), cancel);
        Ok(ServingLaunch {
            jobs: self.clone(),
            id,
        })
    }

    /// Release this registry lock before looking up or locking any session.
    pub(crate) fn cancel_operation(&self, id: &str) -> Result<(), AppError> {
        self.cancel(id)?;
        let mut jobs = self.0.lock().map_err(|_| "launch jobs lock was poisoned")?;
        if let Some(cancel) = jobs.serving.get(id) {
            cancel.store(true, Ordering::Release);
            return Ok(());
        }
        if jobs.cancelled_serving.insert(id.to_owned()) {
            jobs.cancelled_serving_order.push_back(id.to_owned());
            while jobs.cancelled_serving_order.len() > 256 {
                if let Some(old) = jobs.cancelled_serving_order.pop_front() {
                    jobs.cancelled_serving.remove(&old);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn cancel_all(&self) {
        if let Ok(jobs) = self.0.lock() {
            for cancel in jobs.active.values() {
                cancel.store(true, Ordering::Release);
            }
            for cancel in jobs.serving.values() {
                cancel.store(true, Ordering::Release);
            }
        }
    }
}

impl Drop for PreflightJob {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Ok(mut jobs) = self.jobs.0.lock() {
            jobs.active.remove(&self.id);
        }
    }
}

impl ServingLaunch {
    pub(crate) fn operation_id(&self) -> &str {
        &self.id
    }
}

impl Drop for ServingLaunch {
    fn drop(&mut self) {
        let mut jobs = self
            .jobs
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        jobs.serving.remove(&self.id);
        // A ready target owns its operation identity until its next generation.
        // Completing this guard must not mark that process cancelled.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_launch_identifiers_are_validation_errors() {
        let error = LaunchJobs::default().cancel("../launch").unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert_eq!(error.message, "invalid launch operation identifier");
    }

    #[test]
    fn queued_and_active_cancellation_preserve_other_launch_targets() {
        let jobs = Arc::new(LaunchJobs::default());
        jobs.cancel("queued").unwrap();
        let queued = jobs.begin("queued".into()).unwrap();
        let other = jobs.begin("other".into()).unwrap();
        assert!(queued.cancel.load(Ordering::Acquire));
        assert!(!other.cancel.load(Ordering::Acquire));
        assert_eq!(
            jobs.begin("other".into()).err().unwrap().kind,
            crate::error::ErrorKind::Busy
        );
        drop(queued);
        let retried = jobs.begin("queued".into()).unwrap();
        assert!(!retried.cancel.load(Ordering::Acquire));
        jobs.cancel("queued").unwrap();
        assert!(retried.cancel.load(Ordering::Acquire));
        assert!(!other.cancel.load(Ordering::Acquire));
        jobs.cancel_all();
        assert!(other.cancel.load(Ordering::Acquire));
        for index in 0..512 {
            jobs.cancel(&format!("past-{index}")).unwrap();
        }
        assert_eq!(jobs.0.lock().unwrap().cancelled.len(), 256);
    }

    #[test]
    fn scoped_handoff_cancel_survives_preflight_drop_and_retry() {
        let jobs = Arc::new(LaunchJobs::default());
        let preflight = jobs.begin("handoff".into()).unwrap();
        jobs.cancel_operation("handoff").unwrap();
        assert!(preflight.cancel.load(Ordering::Acquire));
        drop(preflight);
        let retry = jobs.begin("handoff".into()).unwrap();
        assert!(!retry.cancel.load(Ordering::Acquire));
        drop(retry);
        let cancel = Arc::new(AtomicBool::new(false));
        let serving = jobs.begin_launch("handoff".into(), cancel.clone()).unwrap();
        assert!(cancel.load(Ordering::Acquire));
        drop(serving);
    }

    #[test]
    fn scoped_pre_admission_tombstones_are_bounded() {
        let jobs = Arc::new(LaunchJobs::default());
        for index in 0..512 {
            jobs.cancel_operation(&format!("queued-{index}")).unwrap();
        }
        let state = jobs.0.lock().unwrap();
        assert_eq!(state.cancelled_serving.len(), 256);
        assert!(state.serving.is_empty());
    }
}
