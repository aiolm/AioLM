//! Per-measurement sampling of the benchmark server's resident RAM.
//!
//! This records the largest observed *current* working set, not the process's
//! lifetime peak (which includes model loading), and does not measure GPU VRAM.
//! Peaks shorter than the sampling interval can be missed. Unsupported platforms
//! and unavailable process counters produce `None` rather than an estimate.

/// Owns one sampling thread; finishing or dropping it always stops and joins it.
pub(crate) struct PeakMemorySampler {
    #[cfg(windows)]
    stop: Option<std::sync::mpsc::Sender<()>>,
    #[cfg(windows)]
    worker: Option<std::thread::JoinHandle<Option<u64>>>,
}

impl PeakMemorySampler {
    /// Start immediately before a measurement, after model loading and warmup.
    pub(crate) fn start(pid: u32) -> Self {
        #[cfg(windows)]
        {
            let (stop, receiver) = std::sync::mpsc::channel();
            let (ready, started) = std::sync::mpsc::sync_channel(0);
            let worker = std::thread::Builder::new()
                .name("benchmark-memory".into())
                .spawn(move || windows::sample(pid, receiver, ready))
                .ok();
            // Wait for the initial sample so even a short measurement starts
            // with a baseline. A failed spawn/open/read drops the sender.
            let _ = started.recv();
            Self {
                stop: Some(stop),
                worker,
            }
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            Self {}
        }
    }

    /// Take a final sample, stop sampling, and return the observed peak in bytes.
    pub(crate) fn finish(mut self) -> Option<u64> {
        self.stop_and_join()
    }

    fn stop_and_join(&mut self) -> Option<u64> {
        #[cfg(windows)]
        {
            if let Some(stop) = self.stop.take() {
                // recv_timeout wakes immediately; no polling sleep to wait out.
                let _ = stop.send(());
            }
            self.worker.take()?.join().ok().flatten()
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

impl Drop for PeakMemorySampler {
    fn drop(&mut self) {
        let _ = self.stop_and_join();
    }
}

#[cfg(windows)]
mod windows {
    use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    const SAMPLE_INTERVAL: Duration = Duration::from_millis(150);

    // Layout from psapi.h. SIZE_T follows the target pointer width. Declaring
    // this small binding avoids adding another windows-sys feature to the app.
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    // Available from Kernel32 on Windows 7+.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn K32GetProcessMemoryInfo(
            process: HANDLE,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    struct ProcessMemoryReader(HANDLE);

    impl ProcessMemoryReader {
        fn open(pid: u32) -> Option<Self> {
            // SAFETY: Read-only access, a scalar PID, and no inherited handle.
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            (!handle.is_null()).then(|| Self(handle))
        }

        fn current(&self) -> Option<u64> {
            let mut counters = ProcessMemoryCounters {
                cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
                ..Default::default()
            };
            let size = counters.cb;
            // SAFETY: The handle stays owned by this reader, and counters is a
            // writable repr(C) buffer whose exact size is passed to the API.
            let success = unsafe { K32GetProcessMemoryInfo(self.0, &mut counters, size) };
            (success != 0).then_some(counters.working_set_size as u64)
        }
    }

    impl Drop for ProcessMemoryReader {
        fn drop(&mut self) {
            // SAFETY: This reader exclusively owns the successful OpenProcess
            // handle and closes it once, on the same sampling thread.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub(super) fn sample(pid: u32, stop: Receiver<()>, ready: SyncSender<()>) -> Option<u64> {
        // Holding this handle throughout the interval prevents PID reuse from
        // redirecting a later sample to a different process.
        let process = ProcessMemoryReader::open(pid)?;
        let mut peak = process.current()?;
        let _ = ready.send(());
        loop {
            let finished = match stop.recv_timeout(SAMPLE_INTERVAL) {
                Err(RecvTimeoutError::Timeout) => false,
                Ok(()) | Err(RecvTimeoutError::Disconnected) => true,
            };
            match process.current() {
                Some(bytes) => peak = peak.max(bytes),
                // If the child exited, retain the valid samples already taken.
                None => break,
            }
            if finished {
                break;
            }
        }
        Some(peak)
    }
}

#[cfg(test)]
mod tests {
    use super::PeakMemorySampler;

    #[cfg(windows)]
    #[test]
    fn samples_current_process_even_when_finished_immediately() {
        let sampler = PeakMemorySampler::start(std::process::id());
        assert!(sampler.finish().is_some_and(|bytes| bytes > 0));
    }

    #[cfg(windows)]
    #[test]
    fn unavailable_process_has_no_memory_measurement() {
        // PID 0 is the system idle process and cannot be opened with OpenProcess.
        assert_eq!(PeakMemorySampler::start(0).finish(), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_platform_has_no_memory_measurement() {
        assert_eq!(PeakMemorySampler::start(std::process::id()).finish(), None);
    }
}
