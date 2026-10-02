//! Per-measurement sampling of the benchmark server's resident RAM.
//!
//! This records the largest observed *current* working set, not the process's
//! lifetime peak (which includes model loading), and does not measure GPU VRAM.
//! Peaks shorter than the sampling interval can be missed. Unsupported platforms
//! and unavailable process counters produce `None` rather than an estimate.
//! Linux uses the kernel's lightweight RSS counter, whose asynchronous accounting
//! can lag actual residency; walking all model pages would perturb the benchmark.

#[cfg(target_os = "linux")]
use linux::ProcessMemoryReader;
#[cfg(target_os = "macos")]
use macos::ProcessMemoryReader;
#[cfg(windows)]
use windows::ProcessMemoryReader;

/// Owns one sampling thread; finishing or dropping it always stops and joins it.
pub(crate) struct PeakMemorySampler {
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    stop: Option<std::sync::mpsc::Sender<()>>,
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    worker: Option<std::thread::JoinHandle<Option<u64>>>,
}

impl PeakMemorySampler {
    /// Start immediately before a measurement, after model loading and warmup.
    pub(crate) fn start(pid: u32) -> Self {
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        {
            let (stop, receiver) = std::sync::mpsc::channel();
            let (ready, started) = std::sync::mpsc::sync_channel(0);
            let worker = std::thread::Builder::new()
                .name("benchmark-memory".into())
                .spawn(move || {
                    let mut process = ProcessMemoryReader::open(pid)?;
                    sample(|| process.current(), receiver, ready)
                })
                .ok();
            // Wait for the initial sample so even a short measurement starts
            // with a baseline. A failed spawn/open/read drops the sender.
            let _ = started.recv();
            Self {
                stop: Some(stop),
                worker,
            }
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
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
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        {
            if let Some(stop) = self.stop.take() {
                // recv_timeout wakes immediately; no polling sleep to wait out.
                let _ = stop.send(());
            }
            self.worker.take()?.join().ok().flatten()
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
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

#[cfg(any(windows, target_os = "linux", target_os = "macos", test))]
fn sample(
    mut current: impl FnMut() -> Option<u64>,
    stop: std::sync::mpsc::Receiver<()>,
    ready: std::sync::mpsc::SyncSender<()>,
) -> Option<u64> {
    use std::sync::mpsc::RecvTimeoutError;
    let mut peak = current()?;
    let _ = ready.send(());
    loop {
        let finished = match stop.recv_timeout(std::time::Duration::from_millis(150)) {
            Err(RecvTimeoutError::Timeout) => false,
            Ok(()) | Err(RecvTimeoutError::Disconnected) => true,
        };
        match current() {
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

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

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

    pub(super) struct ProcessMemoryReader(HANDLE);

    impl ProcessMemoryReader {
        pub(super) fn open(pid: u32) -> Option<Self> {
            // SAFETY: Read-only access, a scalar PID, and no inherited handle.
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            (!handle.is_null()).then(|| Self(handle))
        }

        pub(super) fn current(&mut self) -> Option<u64> {
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
}

#[cfg(any(target_os = "linux", test))]
fn resident_bytes_from_statm(contents: &str, page_size: u64) -> Option<u64> {
    if page_size == 0 {
        return None;
    }
    let pages = contents.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    pages.checked_mul(page_size)
}

#[cfg(target_os = "linux")]
mod linux {
    use std::io::{Read, Seek};

    pub(super) struct ProcessMemoryReader {
        statm: std::fs::File,
        page_size: u64,
    }

    impl ProcessMemoryReader {
        pub(super) fn open(pid: u32) -> Option<Self> {
            // Keep the procfs descriptor open: it never redirects to a new
            // process after PID reuse, unlike reopening the path each sample.
            let statm = std::fs::File::open(format!("/proc/{pid}/statm")).ok()?;
            // SAFETY: sysconf takes only a supported scalar selector.
            let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
            (page_size > 0).then_some(Self {
                statm,
                page_size: page_size as u64,
            })
        }

        pub(super) fn current(&mut self) -> Option<u64> {
            self.statm.rewind().ok()?;
            let mut contents = String::new();
            self.statm.read_to_string(&mut contents).ok()?;
            super::resident_bytes_from_statm(&contents, self.page_size)
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    pub(super) struct ProcessMemoryReader {
        pid: libc::pid_t,
        started: (u64, u64),
    }

    fn task_info(pid: libc::pid_t) -> Option<libc::proc_taskallinfo> {
        let mut info = std::mem::MaybeUninit::<libc::proc_taskallinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_taskallinfo>() as libc::c_int;
        // SAFETY: proc_pidinfo receives a correctly sized/aligned output buffer.
        // Only a complete successful write is exposed as an initialized value.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTASKALLINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        (written == size).then(|| unsafe { info.assume_init() })
    }

    impl ProcessMemoryReader {
        pub(super) fn open(pid: u32) -> Option<Self> {
            let pid = libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0)?;
            let info = task_info(pid)?;
            Some(Self {
                pid,
                started: (info.pbsd.pbi_start_tvsec, info.pbsd.pbi_start_tvusec),
            })
        }

        pub(super) fn current(&mut self) -> Option<u64> {
            let info = task_info(self.pid)?;
            // Identity and RSS come from one query, preventing a recycled PID
            // from supplying a different process's resident memory.
            let started = (info.pbsd.pbi_start_tvsec, info.pbsd.pbi_start_tvusec);
            (started == self.started).then_some(info.ptinfo.pti_resident_size)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PeakMemorySampler;

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    #[test]
    fn samples_current_process_even_when_finished_immediately() {
        let sampler = PeakMemorySampler::start(std::process::id());
        assert!(sampler.finish().is_some_and(|bytes| bytes > 0));
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    #[test]
    fn unavailable_process_has_no_memory_measurement() {
        // PID 0 cannot represent the benchmark server on any supported OS.
        assert_eq!(PeakMemorySampler::start(0).finish(), None);
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    #[test]
    fn unsupported_platform_has_no_memory_measurement() {
        assert_eq!(PeakMemorySampler::start(std::process::id()).finish(), None);
    }

    #[test]
    fn linux_resident_counter_uses_the_runtime_page_size() {
        let statm = "800000 12345 10 20 0 30 0\n";
        assert_eq!(
            super::resident_bytes_from_statm(statm, 4096),
            Some(50_565_120)
        );
        assert_eq!(
            super::resident_bytes_from_statm(statm, 65536),
            Some(809_041_920)
        );
        assert_eq!(
            super::resident_bytes_from_statm("50 0 0 0 0 0 0", 4096),
            Some(0)
        );
    }

    #[test]
    fn invalid_linux_counters_are_unavailable_instead_of_wrapping() {
        for statm in ["", "1", "1 -1", "1 invalid", "1 18446744073709551615"] {
            assert_eq!(super::resident_bytes_from_statm(statm, 4096), None);
        }
        assert_eq!(super::resident_bytes_from_statm("1 1", 0), None);
    }

    #[test]
    fn final_sample_is_included_and_an_exited_process_preserves_the_peak() {
        for (samples, expected) in [
            (vec![Some(10), Some(40)], Some(40)),
            (vec![Some(40), Some(10)], Some(40)),
            (vec![Some(40), None], Some(40)),
            (vec![None], None),
        ] {
            let (stop, receiver) = std::sync::mpsc::channel();
            let (ready, _started) = std::sync::mpsc::sync_channel(1);
            stop.send(()).unwrap();
            let mut samples = samples.into_iter();
            assert_eq!(
                super::sample(|| samples.next().unwrap(), receiver, ready),
                expected
            );
        }
    }
}
