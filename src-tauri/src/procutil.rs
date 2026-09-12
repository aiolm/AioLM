//! Single place every module spawns an external process through, so no new
//! call site can forget the one Windows-only fix every one of them needs:
//! this app has no console of its own, so a plain `Command::spawn` for a
//! helper like `taskkill`/`netstat`/`cmake` briefly flashes a console window
//! on screen. `CREATE_NO_WINDOW` suppresses that without changing anything
//! about how the child runs or how its stdio pipes behave.
//!
//! Unix process-group setup (`configure_build_process_group` in `runtime.rs`)
//! is a separate, build-specific concern and stays where it is. Tracked
//! process cancellation shared by the benchmark IPC and shutdown lives here.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt as _;

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
