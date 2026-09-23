//! Serialize Windows single-instance plugin initialization across processes.

use std::io;
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

/// The plugin creates its instance mutex before registering its IPC window.
/// Another process must not enter that gap: it could otherwise find the mutex
/// without a window to notify and continue as a second application instance.
/// Release this guard after `Builder::build`, before entering the event loop.
pub(crate) struct InstanceStartupLock(HANDLE);

impl InstanceStartupLock {
    pub(crate) fn acquire(identifier: &str) -> io::Result<Self> {
        Self::acquire_with_timeout(identifier, 30_000)
    }

    fn acquire_with_timeout(identifier: &str, timeout_ms: u32) -> io::Result<Self> {
        let name: Vec<u16> = format!("{identifier}-startup")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // The default security descriptor and session-local namespace match
        // the single-instance plugin. No user paths or persistent files are used.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        match unsafe { WaitForSingleObject(handle, timeout_ms) } {
            // A secondary process exits inside the plugin while holding this
            // guard. Windows releases its ownership; the next launch can proceed.
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            status => {
                let error = if status == WAIT_TIMEOUT {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "another AioLM launch has not finished initializing",
                    )
                } else {
                    io::Error::last_os_error()
                };
                unsafe { CloseHandle(handle) };
                Err(error)
            }
        }
    }
}

impl Drop for InstanceStartupLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_startup_waits_until_plugin_initialization_finishes() {
        let identifier = format!("aiolm-startup-test-{}", uuid::Uuid::new_v4());
        let guard = InstanceStartupLock::acquire(&identifier).unwrap();
        let competing_identifier = identifier.clone();
        let error = std::thread::spawn(move || {
            InstanceStartupLock::acquire_with_timeout(&competing_identifier, 50)
                .err()
                .map(|error| error.kind())
        })
        .join()
        .unwrap();
        assert_eq!(error, Some(io::ErrorKind::TimedOut));
        drop(guard);
        let acquired =
            std::thread::spawn(move || InstanceStartupLock::acquire(&identifier).is_ok())
                .join()
                .unwrap();
        assert!(acquired);
    }

    #[test]
    fn different_app_identifiers_do_not_block_each_other() {
        let identifier = format!("aiolm-startup-test-{}", uuid::Uuid::new_v4());
        let _guard = InstanceStartupLock::acquire(&identifier).unwrap();
        let other = format!("{identifier}-other");
        let acquired = std::thread::spawn(move || {
            InstanceStartupLock::acquire_with_timeout(&other, 50).is_ok()
        })
        .join()
        .unwrap();
        assert!(acquired);
    }

    #[test]
    fn an_exited_initializer_does_not_block_the_next_launch() {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};

        let identifier = format!("aiolm-startup-test-{}", uuid::Uuid::new_v4());
        let exiting_identifier = identifier.clone();
        let handle = std::thread::spawn(move || {
            let guard = InstanceStartupLock::acquire(&exiting_identifier).unwrap();
            let handle = guard.0 as usize;
            // Simulate the plugin exiting without running the guard's Drop.
            std::mem::forget(guard);
            handle
        })
        .join()
        .unwrap();
        let _abandoned_handle = unsafe { OwnedHandle::from_raw_handle(handle as _) };
        let _next = InstanceStartupLock::acquire_with_timeout(&identifier, 50).unwrap();
    }
}
