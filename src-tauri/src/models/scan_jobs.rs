use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

const MAX_ACTIVE_SCANS: usize = 64;
const MAX_EARLY_CANCELLATIONS: usize = 256;

#[derive(Default)]
struct ScanJobs {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled: HashSet<String>,
    cancellation_order: VecDeque<String>,
}

#[derive(Default)]
pub struct ScanRegistry(Mutex<ScanJobs>);

pub struct ScanGuard {
    registry: Arc<ScanRegistry>,
    id: String,
    pub cancel: Arc<AtomicBool>,
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b"-_".contains(&value))
    {
        return Err("invalid model scan identifier".into());
    }
    Ok(())
}

impl ScanRegistry {
    pub fn begin(self: &Arc<Self>, id: String) -> Result<ScanGuard, String> {
        validate_id(&id)?;
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "model scan registry lock was poisoned")?;
        if jobs.active.contains_key(&id) {
            return Err("model scan identifier is already active".into());
        }
        if jobs.active.len() >= MAX_ACTIVE_SCANS {
            return Err("too many active model scans".into());
        }
        let cancelled = jobs.cancelled.remove(&id);
        jobs.cancellation_order.retain(|entry| entry != &id);
        let cancel = Arc::new(AtomicBool::new(cancelled));
        jobs.active.insert(id.clone(), cancel.clone());
        Ok(ScanGuard {
            registry: self.clone(),
            id,
            cancel,
        })
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let mut jobs = self
            .0
            .lock()
            .map_err(|_| "model scan registry lock was poisoned")?;
        if let Some(cancel) = jobs.active.get(id) {
            cancel.store(true, Ordering::Relaxed);
        } else if jobs.cancelled.insert(id.to_string()) {
            // Cancellation IPC can run before a queued scan command starts.
            // Bound these tombstones when a window cancels already-finished work.
            jobs.cancellation_order.push_back(id.to_string());
            while jobs.cancellation_order.len() > MAX_EARLY_CANCELLATIONS {
                if let Some(oldest) = jobs.cancellation_order.pop_front() {
                    jobs.cancelled.remove(&oldest);
                }
            }
        }
        Ok(())
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.registry.0.lock() {
            jobs.active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_scoped_to_one_request_and_survives_queued_start() {
        let registry = Arc::new(ScanRegistry::default());
        let first = registry.begin("first".into()).unwrap();
        let second = registry.begin("second".into()).unwrap();
        registry.cancel("first").unwrap();
        assert!(first.cancel.load(Ordering::Relaxed));
        assert!(!second.cancel.load(Ordering::Relaxed));
        registry.cancel("queued").unwrap();
        let queued = registry.begin("queued".into()).unwrap();
        assert!(queued.cancel.load(Ordering::Relaxed));
        drop(first);
        assert!(!registry.0.lock().unwrap().active.contains_key("first"));
        assert!(registry.begin("second".into()).is_err());
    }

    #[test]
    fn unused_cancellation_records_are_bounded() {
        let registry = ScanRegistry::default();
        for index in 0..MAX_EARLY_CANCELLATIONS * 2 {
            registry.cancel(&format!("scan-{index}")).unwrap();
        }
        let jobs = registry.0.lock().unwrap();
        assert_eq!(jobs.cancelled.len(), MAX_EARLY_CANCELLATIONS);
        assert_eq!(jobs.cancellation_order.len(), MAX_EARLY_CANCELLATIONS);
    }
}
