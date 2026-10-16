//! A launch preflight owns its cancellation, before any server is replaced.
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
}

#[derive(Default)]
pub(crate) struct PreflightJobs(Mutex<Jobs>);

pub(crate) struct PreflightJob {
    jobs: Arc<PreflightJobs>,
    id: String,
    pub cancel: Arc<AtomicBool>,
}

fn validate(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err("invalid launch preflight identifier".into());
    }
    Ok(())
}

impl PreflightJobs {
    pub(crate) fn begin(self: &Arc<Self>, id: String) -> Result<PreflightJob, String> {
        validate(&id)?;
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "launch preflight lock was poisoned")?;
        if jobs.active.contains_key(&id) || jobs.active.len() >= 64 {
            return Err(
                "launch preflight is already active or too many preflights are running".into(),
            );
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

    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
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

    pub(crate) fn cancel_all(&self) {
        if let Ok(jobs) = self.0.lock() {
            for cancel in jobs.active.values() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_and_active_cancellation_preserve_other_launch_targets() {
        let jobs = Arc::new(PreflightJobs::default());
        jobs.cancel("queued").unwrap();
        let queued = jobs.begin("queued".into()).unwrap();
        let other = jobs.begin("other".into()).unwrap();
        assert!(queued.cancel.load(Ordering::Acquire));
        assert!(!other.cancel.load(Ordering::Acquire));
        assert!(jobs.begin("other".into()).is_err());
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
}
