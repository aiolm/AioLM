//! Assign suspended helpers to a job before they can create descendants.
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use windows_sys::Win32::Foundation::{
    ERROR_MORE_DATA, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, ResumeThread, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, THREAD_SUSPEND_RESUME,
};

pub(super) struct ProcessJob {
    handle: OwnedHandle,
    members: std::sync::Mutex<Vec<(u32, OwnedHandle)>>,
    capture_failed: std::sync::atomic::AtomicBool,
}

impl ProcessJob {
    pub(super) fn new() -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self {
            handle: unsafe { OwnedHandle::from_raw_handle(handle) },
            members: std::sync::Mutex::new(Vec::new()),
            capture_failed: std::sync::atomic::AtomicBool::new(false),
        };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn handle(&self) -> HANDLE {
        self.handle.as_raw_handle()
    }

    pub(super) fn assign(&self, process: RawHandle) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Clear KILL_ON_JOB_CLOSE so closing this handle no longer terminates the
    /// members. Microsoft documents that a job without that limit is destroyed
    /// only after its last handle closes and all its processes have exited.
    pub(super) fn persist(&self) -> io::Result<()> {
        let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            SetInformationJobObject(
                self.handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn terminate(&self) {
        if self.capture_members(None).is_err() {
            self.capture_failed
                .store(true, std::sync::atomic::Ordering::Release);
        }
        unsafe { TerminateJobObject(self.handle(), 1) };
    }

    fn member_ids(&self, deadline: Option<std::time::Instant>) -> io::Result<Vec<u32>> {
        let mut capacity = 1_usize;
        for _ in 0..2 {
            if deadline.is_some_and(|limit| std::time::Instant::now() >= limit) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "job member discovery deadline expired",
                ));
            }
            let mut buffer = vec![0_usize; capacity + 1];
            let mut returned = 0_u32;
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr() as *mut _,
                    std::mem::size_of_val(buffer.as_slice()) as u32,
                    &mut returned,
                )
            };
            let query_error = (queried == 0).then(io::Error::last_os_error);
            if deadline.is_some_and(|limit| std::time::Instant::now() >= limit) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "job member discovery deadline expired",
                ));
            }
            if let Some(error) = query_error {
                if error.raw_os_error() != Some(ERROR_MORE_DATA as i32) {
                    return Err(error);
                }
                let required = returned as usize;
                let required_capacity = required
                    .saturating_sub(2 * std::mem::size_of::<u32>())
                    .saturating_add(std::mem::size_of::<usize>() - 1)
                    / std::mem::size_of::<usize>();
                capacity = required_capacity.max(capacity.saturating_mul(2)).max(1);
                continue;
            }
            let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
            let assigned = list.NumberOfAssignedProcesses as usize;
            let count = list.NumberOfProcessIdsInList as usize;
            if count < assigned || count > capacity {
                capacity = assigned.max(count).max(capacity.saturating_mul(2));
                continue;
            }
            let ids = unsafe {
                std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), count)
                    .iter()
                    .map(|pid| *pid as u32)
                    .collect()
            };
            return Ok(ids);
        }
        Err(io::Error::other(
            "job member snapshot changed during bounded query",
        ))
    }

    /// Retain synchronization handles for every member visible in the job.
    /// Holding them prevents PID reuse from confusing a later membership pass.
    pub(super) fn capture_members(&self, deadline: Option<std::time::Instant>) -> io::Result<()> {
        let ids = self.member_ids(deadline)?;
        let known = self
            .members
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(pid, _)| *pid)
            .collect::<Vec<_>>();
        let mut captured = Vec::new();
        for pid in ids {
            if deadline.is_some_and(|limit| std::time::Instant::now() >= limit) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "job member discovery deadline expired",
                ));
            }
            if known.contains(&pid) {
                continue;
            }
            let process = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if process.is_null() {
                return Err(io::Error::new(
                    io::Error::last_os_error().kind(),
                    "could not retain an active job member",
                ));
            }
            let process = unsafe { OwnedHandle::from_raw_handle(process) };
            let mut member = 0;
            let queried =
                unsafe { IsProcessInJob(process.as_raw_handle(), self.handle(), &mut member) };
            if queried == 0 || member == 0 {
                return Err(io::Error::other("could not retain an active job member"));
            }
            captured.push((pid, process));
        }
        let mut members = self.members.lock().unwrap_or_else(|e| e.into_inner());
        for (pid, process) in captured {
            if !members.iter().any(|(known, _)| *known == pid) {
                members.push((pid, process));
            }
        }
        Ok(())
    }

    fn wait_members(&self, deadline: std::time::Instant) -> bool {
        // Members are only appended, never removed, and ProcessJob outlives this
        // borrowed call, so copied raw handles remain open throughout the wait.
        let handles = self
            .members
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(_, process)| process.as_raw_handle())
            .collect::<Vec<_>>();
        for process in handles {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let timeout = remaining.as_millis().min(u128::from(u32::MAX - 1)) as u32;
            if unsafe { WaitForSingleObject(process, timeout) } != WAIT_OBJECT_0 {
                return false;
            }
        }
        true
    }

    fn members_cover_and_are_signaled(&self, ids: &[u32]) -> bool {
        // This short lock keeps a published handle from being missed by the
        // final zero-time observations; no blocking wait is held under it.
        let members = self.members.lock().unwrap_or_else(|e| e.into_inner());
        ids.iter()
            .all(|pid| members.iter().any(|(known, _)| known == pid))
            && members.iter().all(|(_, process)| unsafe {
                WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_OBJECT_0
            })
    }

    /// After termination, wait on retained process handles rather than the
    /// job's undocumented explicit-termination signal state.
    pub(super) fn wait_empty(&self, limit: std::time::Duration) -> bool {
        if self
            .capture_failed
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return false;
        }
        let deadline = std::time::Instant::now() + limit;
        let mut discovery_deadline = (!limit.is_zero()).then_some(deadline);
        loop {
            if self.capture_members(discovery_deadline).is_err() {
                return false;
            }
            if !self.wait_members(deadline) {
                return false;
            }
            let ids = match self.member_ids(discovery_deadline) {
                Ok(ids) => ids,
                Err(_) => return false,
            };
            if self.members_cover_and_are_signaled(&ids) {
                return true;
            }
            discovery_deadline = Some(deadline);
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::yield_now();
        }
    }

    /// Whether `pid` runs in this job. Descendants join their parent's job,
    /// so this covers launchers that re-spawn the real server.
    pub(super) fn contains(&self, pid: u32) -> bool {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return false;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        let mut member = 0;
        let queried =
            unsafe { IsProcessInJob(process.as_raw_handle(), self.handle(), &mut member) };
        queried != 0 && member != 0
    }
}

/// Stable Rust does not expose Child's primary thread handle. Resume its
/// snapshot of threads, including the initial thread if a debugger or security
/// tool has already injected another thread. Running threads stay running.
pub(super) fn resume(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut present = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    let mut resumed = false;
    while present != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed = true;
        }
        present = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    if resumed {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "suspended process thread was not found",
    ))
}
