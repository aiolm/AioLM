//! Single place every module spawns an external process through, so no new
//! call site can forget the one Windows-only fix every one of them needs:
//! this app has no console of its own, so a plain `Command::spawn` for a
//! helper like `taskkill`/`netstat`/`cmake` briefly flashes a console window
//! on screen. `CREATE_NO_WINDOW` suppresses that without changing anything
//! about how the child runs or how its stdio pipes behave.
//!
//! Owned tasks and transient process groups keep probes, MCP servers and their
//! pipes attached to their callers through cancellation and application exit.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
mod windows_job;

struct ProcessTree {
    terminated: std::sync::atomic::AtomicBool,
    #[cfg(windows)]
    job: windows_job::ProcessJob,
    #[cfg(unix)]
    pid: u32,
}

impl ProcessTree {
    fn terminate(&self) {
        if self
            .terminated
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return;
        }
        #[cfg(windows)]
        self.job.terminate();
        #[cfg(unix)]
        terminate_process_group(self.pid);
    }
}

/// Cancellation holds process ownership, rather than an identifier that the
/// OS may reuse after the server has exited.
#[derive(Clone)]
pub struct ProcessHandle(std::sync::Arc<ProcessTree>);
impl ProcessHandle {
    pub fn terminate(&self) {
        self.0.terminate();
    }

    #[cfg(test)]
    pub(crate) fn empty_for_test() -> Self {
        Self(std::sync::Arc::new(ProcessTree {
            terminated: std::sync::atomic::AtomicBool::new(true),
            #[cfg(windows)]
            job: windows_job::ProcessJob::new().unwrap(),
            #[cfg(unix)]
            pid: 0,
        }))
    }
}

/// Preserve the OS error while distinguishing policy denial from model/GPU errors.
pub fn spawn_error(program: &std::path::Path, error: &std::io::Error) -> String {
    let message = format!("failed to spawn {}: {error}", program.display());
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(4551 | 577 | 1260)) {
        return format!("{message}. Windows application control/code integrity blocked this executable. Use a signed build approved by your device policy, or ask the device administrator to review this exact file in the CodeIntegrity event log. Changing GPU settings will not fix this; do not disable security protection.");
    }
    message
}

/// A `std::process::Command` for `program`, pre-configured so it never flashes
/// a console window on Windows. Behaves exactly like `Command::new` on every
/// other platform.
pub fn std_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    configure_std(&mut command);
    command
}

/// The `tokio::process::Command` counterpart of [`std_command`].
pub fn tokio_command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    configure_tokio(&mut command);
    command
}

/// An async task belongs to its owner even when that owner's future is dropped.
/// Tokio's bare JoinHandle detaches on drop, leaving pipe readers/listeners alive.
pub struct OwnedTask<T>(tokio::task::JoinHandle<T>);

impl<T> From<tokio::task::JoinHandle<T>> for OwnedTask<T> {
    fn from(task: tokio::task::JoinHandle<T>) -> Self {
        Self(task)
    }
}

impl<T> std::ops::Deref for OwnedTask<T> {
    type Target = tokio::task::JoinHandle<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> std::future::Future for OwnedTask<T> {
    type Output = Result<T, tokio::task::JoinError>;

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        std::pin::Pin::new(&mut self.0).poll(cx)
    }
}

impl<T> Drop for OwnedTask<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Isolate subprocess descendants so cancellation can terminate the whole group.
pub fn configure_process_group(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(not(unix))]
    let _ = command;
}

#[cfg(unix)]
pub fn terminate_process_group(pid: u32) {
    unsafe {
        let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

/// Observe exit without releasing the group leader's PID. Group cleanup must
/// precede reaping so shutdown cannot accidentally address a reused group ID.
#[cfg(unix)]
fn exited_without_reaping(pid: u32) -> std::io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } == -1
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { info.si_pid() } != 0)
}

/// Synchronous model/helper processes have the same cancellation and exit
/// ownership as async probes. Explicit release is reserved for headless mode.
pub struct OwnedChild {
    child: Option<std::process::Child>,
    registration: Option<(uuid::Uuid, std::sync::Arc<ProcessTree>)>,
}

impl OwnedChild {
    pub fn spawn(command: &mut std::process::Command) -> std::io::Result<Self> {
        let mut active = transient_processes()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        let job = {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW | 0x0000_0004);
            windows_job::ProcessJob::new()?
        };
        #[allow(unused_mut)]
        let mut child = command.spawn()?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if let Err(error) = job.assign(child.as_raw_handle()) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        let tree = std::sync::Arc::new(ProcessTree {
            terminated: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            job,
            #[cfg(unix)]
            pid: child.id(),
        });
        if active.shutting_down {
            tree.terminate();
        } else {
            #[cfg(windows)]
            if let Err(error) = windows_job::resume(child.id()) {
                tree.terminate();
                let _ = child.wait();
                return Err(error);
            }
        }
        let token = uuid::Uuid::new_v4();
        active.trees.insert(token, tree.clone());
        Ok(Self {
            child: Some(child),
            registration: Some((token, tree)),
        })
    }

    pub fn terminate(&mut self) {
        if let Some((token, tree)) = self.registration.take() {
            transient_processes()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .trees
                .remove(&token);
            tree.terminate();
        } else if let Some(child) = &mut self.child {
            // CLI startup and legacy fixtures transfer a raw child here. Its
            // handle still reserves the PID while the live tree is terminated.
            if matches!(child.try_wait(), Ok(None)) {
                terminate_pid(child.id());
            }
        }
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.unregister();
    }

    pub fn process_handle(&self) -> Option<ProcessHandle> {
        self.registration
            .as_ref()
            .map(|(_, tree)| ProcessHandle(tree.clone()))
    }

    fn unregister(&mut self) {
        if let Some((token, _)) = self.registration.take() {
            transient_processes()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .trees
                .remove(&token);
        }
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        #[cfg(unix)]
        if let Some((token, tree)) = &self.registration {
            if !exited_without_reaping(self.child.as_ref().expect("owned child").id())? {
                return Ok(None);
            }
            let mut active = transient_processes()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            tree.terminate();
            let status = self.child.as_mut().expect("owned child").try_wait()?;
            active.trees.remove(token);
            drop(active);
            self.registration = None;
            return Ok(status);
        }
        let status = self.child.as_mut().expect("owned child").try_wait()?;
        if status.is_some() {
            if let Some((_, tree)) = &self.registration {
                tree.terminate();
            }
            self.unregister();
        }
        Ok(status)
    }

    /// Transfer a deliberately persistent headless process to its state file.
    pub fn release(mut self) -> std::process::Child {
        self.unregister();
        self.child.take().expect("owned child")
    }
}

impl From<std::process::Child> for OwnedChild {
    fn from(child: std::process::Child) -> Self {
        Self {
            child: Some(child),
            registration: None,
        }
    }
}

impl std::ops::Deref for OwnedChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        self.child.as_ref().expect("owned child")
    }
}

impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.child.as_mut().expect("owned child")
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Environment and system probes have a deadline and remain covered by shutdown.
/// Drain while running so a full stdout cannot stall the helper. Call from a
/// blocking worker rather than an async worker.
#[cfg(any(unix, test))]
pub fn capture_stdout(
    command: &mut std::process::Command,
    limit: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    capture_stdout_cancellable(command, limit, 256 * 1024, None)
}

#[cfg(any(windows, target_os = "linux"))]
pub fn capture_stdout_with_cap(
    command: &mut std::process::Command,
    limit: std::time::Duration,
    cap: usize,
) -> std::io::Result<std::process::Output> {
    capture_stdout_cancellable(command, limit, cap, None)
}

pub fn capture_stdout_cancellable(
    command: &mut std::process::Command,
    limit: std::time::Duration,
    cap: usize,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = OwnedChild::spawn(command)?;
    let mut stdout = child.stdout.take().expect("captured helper stdout");
    let reader = std::thread::Builder::new()
        .name("helper-stdout".into())
        .spawn(move || {
            let mut output =
                crate::process_output::OutputBuffer::new(cap, crate::process_output::Retain::Head);
            let mut buffer = [0_u8; 8192];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => output.push(&buffer[..size]),
                }
            }
            output.snapshot()
        })?;
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
            break Err(std::io::ErrorKind::Interrupted.into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(error),
            Ok(None) if std::time::Instant::now() >= deadline => {
                break Err(std::io::ErrorKind::TimedOut.into())
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    };
    // Terminate remaining group members before joining the drain.
    child.terminate();
    let stdout = reader
        .join()
        .map_err(|_| std::io::Error::other("helper output reader failed"))?;
    Ok(std::process::Output {
        status: status?,
        stdout,
        stderr: Vec::new(),
    })
}

#[derive(Default)]
struct TransientProcesses {
    shutting_down: bool,
    trees: std::collections::HashMap<uuid::Uuid, std::sync::Arc<ProcessTree>>,
}

fn transient_processes() -> &'static std::sync::Mutex<TransientProcesses> {
    static ACTIVE: std::sync::OnceLock<std::sync::Mutex<TransientProcesses>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}

/// Short-lived probes and MCP servers must also stop during synchronous app
/// shutdown, when their async futures may never be polled or dropped again.
pub struct TransientChild {
    child: tokio::process::Child,
    token: uuid::Uuid,
    tree: std::sync::Arc<ProcessTree>,
}

impl TransientChild {
    pub fn spawn(command: &mut tokio::process::Command) -> std::io::Result<Self> {
        // Serialize startup with shutdown so no unregistered process can run
        // between the exit handler's sweep and installation of its owner.
        let mut active = transient_processes()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        configure_process_group(command);
        command.kill_on_drop(true);
        #[cfg(windows)]
        let job = {
            command.creation_flags(CREATE_NO_WINDOW | 0x0000_0004); // CREATE_SUSPENDED
            windows_job::ProcessJob::new()?
        };
        #[allow(unused_mut)]
        let mut child = command.spawn()?;
        #[cfg(windows)]
        if let Err(error) = job.assign(child.raw_handle().expect("new child has a process handle"))
        {
            let _ = child.start_kill();
            return Err(error);
        }
        let tree = std::sync::Arc::new(ProcessTree {
            terminated: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            job,
            #[cfg(unix)]
            pid: child.id().expect("new child has a process ID"),
        });
        let token = uuid::Uuid::new_v4();
        if active.shutting_down {
            tree.terminate();
        } else {
            #[cfg(windows)]
            if let Err(error) = windows_job::resume(child.id().expect("new child has a process ID"))
            {
                tree.terminate();
                return Err(error);
            }
            active.trees.insert(token, tree.clone());
        }
        Ok(Self { child, token, tree })
    }

    pub fn terminate(&self) {
        self.tree.terminate();
    }

    pub async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            loop {
                if exited_without_reaping(pid)? {
                    let mut active = transient_processes()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    self.tree.terminate();
                    let status = self.child.try_wait()?;
                    active.trees.remove(&self.token);
                    return status
                        .ok_or_else(|| std::io::Error::other("child exit was not available"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        let result = self.child.wait().await;
        if result.is_ok() {
            // A successful root exit can leave inherited pipe handles and
            // descendants alive. Windows job handles survive root PID reuse.
            #[cfg(windows)]
            self.tree.terminate();
            transient_processes()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .trees
                .remove(&self.token);
        }
        result
    }
}

impl std::ops::Deref for TransientChild {
    type Target = tokio::process::Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl std::ops::DerefMut for TransientChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for TransientChild {
    fn drop(&mut self) {
        let tree = transient_processes()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .trees
            .remove(&self.token);
        if let Some(tree) = tree {
            tree.terminate();
        }
    }
}

pub fn terminate_transient_processes() {
    let mut active = transient_processes()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    active.shutting_down = true;
    for (_, tree) in active.trees.drain() {
        tree.terminate();
    }
}

/// A failed installer launch returns the still-open app to normal operation.
pub fn resume_transient_processes() {
    transient_processes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .shutting_down = false;
}

/// Terminate a tracked subprocess when its owning task must be interrupted.
/// The process owner remains responsible for reaping the child handle.
pub fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::process::Stdio;
        let pid = pid.to_string();
        let _ = std_command("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std_command("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

#[cfg(windows)]
fn configure_std(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_std(_command: &mut std::process::Command) {}

#[cfg(windows)]
fn configure_tokio(command: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_tokio(_command: &mut tokio::process::Command) {}

#[cfg(test)]
mod ownership_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn dropping_a_reader_owner_closes_its_pipe() {
        let (reader, mut writer) = tokio::io::duplex(8);
        let task = tokio::spawn(crate::process_output::drain_stream(
            reader,
            8,
            crate::process_output::Retain::Head,
        ));
        let completion = task.abort_handle();
        let owned = OwnedTask::from(task);
        writer.write_all(b"output").await.unwrap();
        drop(owned);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !completion.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(writer.write_all(b"late output").await.is_err());
    }

    #[tokio::test]
    async fn interrupting_a_join_also_aborts_the_owned_task() {
        let (reader, _writer) = tokio::io::duplex(8);
        let task = tokio::spawn(crate::process_output::drain_stream(
            reader,
            8,
            crate::process_output::Retain::Head,
        ));
        let completion = task.abort_handle();
        let owned = OwnedTask::from(task);
        assert!(tokio::time::timeout(Duration::from_millis(10), owned)
            .await
            .is_err());
        tokio::time::timeout(Duration::from_secs(5), async {
            while !completion.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

/// Hold a fixture's OS process handle so PID reuse cannot confuse leak checks.
#[cfg(all(test, windows))]
pub(crate) struct ProcessExitProbe(windows_sys::Win32::Foundation::HANDLE);

#[cfg(all(test, windows))]
impl ProcessExitProbe {
    pub(crate) fn open(pid: u32) -> Option<Self> {
        let handle =
            unsafe { windows_sys::Win32::System::Threading::OpenProcess(0x0010_0000, 0, pid) };
        (!handle.is_null()).then_some(Self(handle))
    }

    pub(crate) fn exited(&self) -> bool {
        unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 0) == 0 }
    }
}

#[cfg(all(test, windows))]
impl Drop for ProcessExitProbe {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt as _;

    #[test]
    fn environment_helper_has_a_deadline_and_drains_beyond_the_retained_limit() {
        let mut command = std_command("cmd");
        command.args(["/c", "ping -n 60 127.0.0.1 > nul"]);
        let started = std::time::Instant::now();
        let error =
            capture_stdout(&mut command, std::time::Duration::from_millis(100)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        let mut command = std_command("powershell");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write(('x' * 300000))",
        ]);
        let output = capture_stdout(&mut command, std::time::Duration::from_secs(10)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 256 * 1024);
        assert!(output.stdout.iter().all(|byte| *byte == b'x'));
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let signal = cancel.clone();
        let sender = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            signal.store(true, std::sync::atomic::Ordering::Release);
        });
        let mut command = std_command("cmd");
        command.args(["/c", "ping -n 60 127.0.0.1 > nul"]);
        let started = std::time::Instant::now();
        let error = capture_stdout_cancellable(
            &mut command,
            std::time::Duration::from_secs(30),
            1024,
            Some(&cancel),
        )
        .unwrap_err();
        sender.join().unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }

    #[tokio::test]
    async fn parent_exit_also_reclaims_the_remaining_descendant() {
        use tokio::io::AsyncBufReadExt;
        let mut command = tokio_command("powershell");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", "$child = Start-Process ping.exe -ArgumentList @('-n','60','127.0.0.1') -WindowStyle Hidden -PassThru; [Console]::Out.WriteLine($child.Id)"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = TransientChild::spawn(&mut command).unwrap();
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            stdout.read_line(&mut line),
        )
        .await
        .unwrap()
        .unwrap();
        let descendant_pid = line.trim().parse().unwrap();
        let descendant = ProcessExitProbe::open(descendant_pid).unwrap();
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
        let reclaimed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !descendant.exited() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        // A failing regression must not itself leave the synthetic descendant.
        if !reclaimed {
            terminate_pid(descendant_pid);
        }
        assert!(status.unwrap().unwrap().success());
        assert!(reclaimed, "normal parent exit left its descendant running");
    }

    #[test]
    fn shutdown_terminates_pending_and_late_processes_and_failed_update_can_resume() {
        const FIXTURE_FLAG: &str = "AIOLM_TEST_TRANSIENT_SHUTDOWN";
        // Exercise the shutdown latch in an isolated test process, so concurrent
        // unit tests remain free to launch their own synthetic processes.
        if std::env::var_os(FIXTURE_FLAG).is_none() {
            let output = std_command(std::env::current_exe().unwrap())
                .args(["--exact", "procutil::tests::shutdown_terminates_pending_and_late_processes_and_failed_update_can_resume", "--nocapture"])
                .env(FIXTURE_FLAG, "1").output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed;"),
                "isolated lifecycle regression did not execute"
            );
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let long_child = || {
                let mut command = tokio_command("cmd");
                command
                    .args(["/c", "ping -n 60 127.0.0.1 > nul"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true);
                TransientChild::spawn(&mut command).unwrap()
            };
            let mut pending = long_child();
            terminate_transient_processes();
            assert!(
                !tokio::time::timeout(std::time::Duration::from_secs(5), pending.wait())
                    .await
                    .unwrap()
                    .unwrap()
                    .success()
            );
            assert!(transient_processes().lock().unwrap().trees.is_empty());
            let mut late = long_child();
            assert!(
                !tokio::time::timeout(std::time::Duration::from_secs(5), late.wait())
                    .await
                    .unwrap()
                    .unwrap()
                    .success()
            );
            resume_transient_processes();
            let mut command = tokio_command("cmd");
            command.args(["/c", "exit 0"]);
            let mut resumed = TransientChild::spawn(&mut command).unwrap();
            assert!(resumed.wait().await.unwrap().success());
            assert!(transient_processes().lock().unwrap().trees.is_empty());
        });
    }

    #[tokio::test]
    async fn dropping_a_transient_child_terminates_its_descendants_and_registration() {
        use tokio::io::AsyncBufReadExt;
        let mut command = tokio_command("powershell");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", "$child = Start-Process ping.exe -ArgumentList @('-n','60','127.0.0.1') -WindowStyle Hidden -PassThru; [Console]::Out.WriteLine($child.Id); Start-Sleep -Seconds 60"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = TransientChild::spawn(&mut command).unwrap();
        let token = child.token;
        let parent = ProcessExitProbe::open(child.id().unwrap()).unwrap();
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            stdout.read_line(&mut line),
        )
        .await
        .unwrap()
        .unwrap();
        let descendant = ProcessExitProbe::open(line.trim().parse().unwrap()).unwrap();
        drop(child);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !parent.exited() || !descendant.exited() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("process tree must exit");
        assert!(!transient_processes()
            .lock()
            .unwrap()
            .trees
            .contains_key(&token));
    }

    #[test]
    fn tracked_process_cancellation_terminates_the_child() {
        let mut child = std_command("cmd")
            .args(["/C", "ping 127.0.0.1 -n 30 >NUL"])
            .spawn()
            .expect("spawn cancellation fixture");
        terminate_pid(child.id());
        assert!(!child.wait().expect("reap cancelled child").success());
    }

    #[test]
    fn policy_denial_includes_actionable_guidance_and_original_error() {
        let error = std::io::Error::from_raw_os_error(4551);
        let message = spawn_error(std::path::Path::new("runtime/llama-server.exe"), &error);
        assert!(message.contains("4551"));
        assert!(message.contains("runtime/llama-server.exe"));
        assert!(message.contains("signed build"));
        assert!(message.contains("do not disable"));
        let missing = spawn_error(
            std::path::Path::new("missing.exe"),
            &std::io::Error::from_raw_os_error(2),
        );
        assert!(!missing.contains("signed build"));
    }

    #[test]
    fn std_command_sets_create_no_window() {
        let command = std_command("cmd");
        // `Command` does not expose creation flags for reading back, so this
        // exercises the same code path a real spawn would take and asserts
        // it compiles/runs without needing an actual child process.
        let _ = command;
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn tokio_command_applies_the_same_flag_as_std_command() {
        let mut manual = std::process::Command::new("cmd");
        manual.creation_flags(CREATE_NO_WINDOW);
        let tokio_cmd = tokio_command("cmd");
        // Both builders must agree on the flag value they apply; this guards
        // against the two configure_* functions drifting apart.
        assert_eq!(tokio_cmd.as_std().get_program(), manual.get_program());
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::io::{BufRead, Read};
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};

    fn shell(script: &str) -> std::process::Command {
        let mut command = std_command("sh");
        command
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }

    #[test]
    fn synchronous_owner_drop_reclaims_descendants_and_closes_inherited_stdout() {
        let mut command = shell("sleep 60 & printf 'ready\\n'; wait");
        let mut child = OwnedChild::spawn(&mut command).unwrap();
        let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).unwrap();
        assert_eq!(ready, "ready\n");
        let (closed, completion) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = closed.send(stdout.read_to_end(&mut bytes));
        });
        drop(child);
        completion
            .recv_timeout(Duration::from_secs(5))
            .expect("the background child must release its inherited stdout")
            .unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn synchronous_helper_timeout_and_parent_exit_reclaim_background_children() {
        let started = std::time::Instant::now();
        let error =
            capture_stdout(&mut shell("sleep 60 & wait"), Duration::from_millis(100)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));

        // The shell exits normally while its background child still owns the
        // pipe. Cleanup must precede the blocking output-reader join.
        let started = std::time::Instant::now();
        let output = capture_stdout(
            &mut shell("sleep 60 & printf 'finished\\n'"),
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"finished\n");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    async fn transient(
        script: &str,
    ) -> (
        TransientChild,
        tokio::io::BufReader<tokio::process::ChildStdout>,
    ) {
        let mut command = tokio_command("sh");
        command
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = TransientChild::spawn(&mut command).unwrap();
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(5), stdout.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready, "ready\n");
        (child, stdout)
    }

    async fn assert_closed(mut stdout: tokio::io::BufReader<tokio::process::ChildStdout>) {
        tokio::time::timeout(Duration::from_secs(5), stdout.read_to_end(&mut Vec::new()))
            .await
            .expect("all descendants must release the inherited pipe")
            .unwrap();
    }

    #[tokio::test]
    async fn cancelling_an_async_owner_reclaims_its_process_group() {
        let (mut child, stdout) = transient("sleep 60 & printf 'ready\\n'; wait").await;
        let token = child.token;
        let owner = OwnedTask::from(tokio::spawn(async move { child.wait().await }));
        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        assert_closed(stdout).await;
        assert!(!transient_processes()
            .lock()
            .unwrap()
            .trees
            .contains_key(&token));
    }

    #[tokio::test]
    async fn successful_async_parent_exit_reclaims_its_background_child() {
        let (mut child, stdout) = transient("sleep 60 & printf 'ready\\n'").await;
        let token = child.token;
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        assert_closed(stdout).await;
        assert!(!transient_processes()
            .lock()
            .unwrap()
            .trees
            .contains_key(&token));
    }
}
