//! System RAM capacity sampled before a benchmark, separate from process peak use.

const MAX_PUBLIC_BYTES: u64 = 9_007_199_254_740_991;

fn capacity(bytes: u64) -> Option<u64> {
    (bytes > 0 && bytes <= MAX_PUBLIC_BYTES).then_some(bytes)
}

#[cfg(windows)]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{
        GetPhysicallyInstalledSystemMemory, GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };
    let mut kib = 0;
    if unsafe { GetPhysicallyInstalledSystemMemory(&mut kib) } != 0 {
        if let Some(bytes) = kib.checked_mul(1024).and_then(capacity) {
            return Some(bytes);
        }
    }
    // The API requires dwLength and writes every other member on success.
    let mut memory: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
        return None;
    }
    capacity(memory.ullTotalPhys)
}

#[cfg(any(target_os = "linux", test))]
fn linux_memory_bytes(meminfo: &str) -> Option<u64> {
    let line = meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?;
    let mut fields = line.split_whitespace();
    let kib = fields.next()?.parse::<u64>().ok()?;
    if fields.next()? != "kB" || fields.next().is_some() {
        return None;
    }
    capacity(kib.checked_mul(1024)?)
}

#[cfg(target_os = "linux")]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    linux_memory_bytes(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

#[cfg(target_os = "macos")]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    let mut bytes: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    let result = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut bytes as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || size != std::mem::size_of::<u64>() {
        return None;
    }
    capacity(bytes)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn system_memory_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_uses_total_memory_not_current_free_memory() {
        assert_eq!(
            linux_memory_bytes("MemTotal: 16777216 kB\nMemFree: 10 kB\n"),
            Some(16 * 1024 * 1024 * 1024)
        );
    }

    #[test]
    fn missing_invalid_or_overflowing_capacity_is_unreported() {
        for input in [
            "MemFree: 20 kB",
            "MemTotal: 0 kB",
            "MemTotal: 20 MB",
            "MemTotal: -1 kB",
            "MemTotal: 18446744073709551615 kB",
        ] {
            assert_eq!(linux_memory_bytes(input), None);
        }
        assert_eq!(capacity(MAX_PUBLIC_BYTES + 1), None);
    }
}
