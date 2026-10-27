//! Cancellation belongs to one media preparation, including a queued command.
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
pub(crate) struct MediaJobs(Mutex<Jobs>);

pub(crate) struct MediaJob {
    jobs: Arc<MediaJobs>,
    id: String,
    pub cancel: Arc<AtomicBool>,
}

fn validate(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err("invalid media operation identifier".into());
    }
    Ok(())
}

impl MediaJobs {
    pub(crate) fn begin(self: &Arc<Self>, id: String) -> Result<MediaJob, String> {
        validate(&id)?;
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "media operation lock was poisoned")?;
        if jobs.active.contains_key(&id) || jobs.active.len() >= 8 {
            return Err(
                "media operation is already active or too many preparations are running".into(),
            );
        }
        let cancel = Arc::new(AtomicBool::new(jobs.cancelled.remove(&id)));
        jobs.order.retain(|entry| entry != &id);
        jobs.active.insert(id.clone(), cancel.clone());
        Ok(MediaJob {
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
            .map_err(|_| "media operation lock was poisoned")?;
        if let Some(cancel) = jobs.active.get(id) {
            cancel.store(true, Ordering::Release);
        } else if jobs.cancelled.insert(id.to_owned()) {
            jobs.order.push_back(id.to_owned());
            while jobs.order.len() > 128 {
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

impl Drop for MediaJob {
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
    fn stopping_a_queued_preparation_does_not_cancel_another_attachment() {
        let jobs = Arc::new(MediaJobs::default());
        jobs.cancel("queued").unwrap();
        let queued = jobs.begin("queued".into()).unwrap();
        let other = jobs.begin("other".into()).unwrap();
        assert!(queued.cancel.load(Ordering::Acquire));
        assert!(!other.cancel.load(Ordering::Acquire));
        assert!(jobs.begin("other".into()).is_err());
        drop(queued);
        assert!(!jobs
            .begin("queued".into())
            .unwrap()
            .cancel
            .load(Ordering::Acquire));
        jobs.cancel_all();
        assert!(other.cancel.load(Ordering::Acquire));
        for index in 0..256 {
            jobs.cancel(&format!("past-{index}")).unwrap();
        }
        assert_eq!(jobs.0.lock().unwrap().cancelled.len(), 128);
    }
}
