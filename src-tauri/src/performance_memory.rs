//! Per-measurement sampling of the benchmark server's resident RAM.
//!
//! This records the largest observed *current* working set, not the process's
//! lifetime peak (which includes model loading), and does not measure GPU VRAM.
//! Peaks shorter than the sampling interval can be missed. Unsupported platforms
//! and unavailable process counters produce `None` rather than an estimate.
//! Linux uses the kernel's lightweight RSS counter, whose asynchronous accounting
//! can lag actual residency; walking all model pages would perturb the benchmark.
//!
//! Python engines do their work in child processes (vLLM's engine core and
//! workers), so on Linux and macOS each sample adds the resident memory of every
//! other member of the server's own process group, which the launcher creates
//! with the server as its leader. Pages shared between members are counted once
//! per member. A member that leaves the group, and any process on Windows other
//! than the server itself, is not counted.
//!
//! Metal's unified memory does not turn RSS into a full GPU allocation counter.
//! MLX active/cache/peak counters are local to the worker holding its allocator;
//! querying MLX in a separate helper would measure that helper. Until the serving
//! engine exposes those counters with ownership and timing, this field remains
//! sampled process-group RSS and must not be labelled unified GPU memory.

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

/// The process group in `/proc/<pid>/stat`. The command name is parenthesized
/// and may itself contain spaces and `)`, so fields are read after the last `)`.
#[cfg(any(target_os = "linux", test))]
fn process_group_from_stat(stat: &str) -> Option<u32> {
    // After the name: state, ppid, pgrp, ...
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(2)?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
mod linux {
    use std::io::{Read, Seek};

    pub(super) struct ProcessMemoryReader {
        statm: std::fs::File,
        page_size: u64,
        pid: u32,
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
                pid,
            })
        }

        pub(super) fn current(&mut self) -> Option<u64> {
            self.statm.rewind().ok()?;
            let mut contents = String::new();
            self.statm.read_to_string(&mut contents).ok()?;
            let mut bytes = super::resident_bytes_from_statm(&contents, self.page_size)?;
            if bytes == 0 {
                return None;
            }
            // Members are counted only while the leader's own procfs descriptor
            // is live, so a recycled leader PID cannot adopt another group.
            for pid in group_members(self.pid) {
                if let Ok(statm) = std::fs::read_to_string(format!("/proc/{pid}/statm")) {
                    bytes = bytes.saturating_add(
                        super::resident_bytes_from_statm(&statm, self.page_size).unwrap_or(0),
                    );
                }
            }
            Some(bytes)
        }
    }

    /// Processes other than `leader` in the process group `leader` leads.
    pub(super) fn group_members(leader: u32) -> Vec<u32> {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| *pid != leader)
            .filter(|pid| {
                std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .ok()
                    .and_then(|stat| super::process_group_from_stat(&stat))
                    == Some(leader)
            })
            .collect()
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
            if started != self.started {
                return None;
            }
            let members = group_members(self.pid as u32)
                .into_iter()
                .filter_map(|pid| resident_size(pid as libc::pid_t))
                .fold(0u64, u64::saturating_add);
            Some(info.ptinfo.pti_resident_size.saturating_add(members))
        }
    }

    /// `PROC_PGRP_ONLY` from `<sys/proc_info.h>`; the libc crate does not export it.
    const PROC_PGRP_ONLY: u32 = 2;

    /// Processes other than `leader` in the process group `leader` leads.
    pub(super) fn group_members(leader: u32) -> Vec<u32> {
        let mut pids = vec![0 as libc::pid_t; 4096];
        let capacity = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        // SAFETY: the buffer is writable for `capacity` bytes; the call returns
        // the number of bytes it filled, or 0 on failure.
        let filled = unsafe {
            libc::proc_listpids(PROC_PGRP_ONLY, leader, pids.as_mut_ptr().cast(), capacity)
        };
        let count = usize::try_from(filled).unwrap_or(0) / std::mem::size_of::<libc::pid_t>();
        pids.truncate(count.min(pids.len()));
        pids.into_iter()
            .filter_map(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0 && *pid != leader)
            .collect()
    }

    fn resident_size(pid: libc::pid_t) -> Option<u64> {
        let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        // SAFETY: as in task_info, with the smaller task-only record.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTASKINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        (written == size).then(|| unsafe { info.assume_init() }.pti_resident_size)
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
    fn process_group_is_read_after_a_command_name_with_spaces_and_parentheses() {
        let stat = "4242 (python3 (vllm) worker) S 4100 4100 4100 0 -1 4194560 0 0";
        assert_eq!(super::process_group_from_stat(stat), Some(4100));
        assert_eq!(
            super::process_group_from_stat("4242 (python) S 1 777 777"),
            Some(777)
        );
        assert_eq!(super::process_group_from_stat("4242 (python) S"), None);
        assert_eq!(super::process_group_from_stat("truncated"), None);
    }

    /// A child the server spawns into its own process group is a measured member.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_child_in_the_server_process_group_is_a_measured_member() {
        #[cfg(target_os = "linux")]
        use super::linux::group_members;
        #[cfg(target_os = "macos")]
        use super::macos::group_members;
        use std::os::unix::process::CommandExt;
        let mut leader = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = leader.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut members = group_members(pid);
        while members.is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
            members = group_members(pid);
        }
        let sampled = PeakMemorySampler::start(pid).finish();
        // SAFETY: signals only the process group this test created.
        unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGTERM) };
        let _ = leader.wait();
        assert!(
            !members.is_empty(),
            "the backgrounded sleep is in the leader's group"
        );
        assert!(!members.contains(&pid));
        assert!(sampled.is_some_and(|bytes| bytes > 0));
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
