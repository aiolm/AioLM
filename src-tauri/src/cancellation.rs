//! Async cancellation waits for jobs controlled by an atomic flag.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Atomic flags do not notify async tasks, so poll without blocking the executor.
pub(crate) async fn wait_cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
