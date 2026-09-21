//! Local device detection.
//!
//! Two consumers, deliberately separated:
//!   * `DeviceProfile` — *what this machine is*. Pure description, no policy.
//!   * `backends::recommend` — *what to do about it*. Pure policy, no I/O.
//!
//! The profile is serde-serializable and carries a `schema_version` plus a
//! privacy-preserving `fingerprint` so a future benchmark-sharing service can
//! group results by device class without the payload ever carrying a hostname,
//! serial number or user name.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DEVICE_PROFILE_SCHEMA: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Unknown,
}

impl GpuVendor {
    /// PCI SIG vendor IDs.
    pub fn from_pci(vendor_id: u16) -> Self {
        match vendor_id {
            0x10de | 0x12d2 => Self::Nvidia,
            0x1002 | 0x1022 => Self::Amd,
            0x8086 | 0x8087 => Self::Intel,
            0x106b => Self::Apple,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nvidia => "nvidia",
            Self::Amd => "amd",
            Self::Intel => "intel",
            Self::Apple => "apple",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct GpuDevice {
    pub vendor: GpuVendor,
    pub name: String,
    pub vram_mb: Option<u64>,
    pub driver: Option<String>,
    /// Lower-case `vendor:device`, e.g. `1002:7551`. Identifies the *chipset*,
    /// not the physical card: two identical cards installed side by side
    /// share the same `pci_id`.
    pub pci_id: Option<String>,
    /// Integrated parts share system memory and are a poor fit for the
    /// vendor-specific compute runtimes even when the vendor matches.
    pub integrated: bool,
    /// Identifies this specific physical device, stable across app restarts
    /// (and, on the platforms above, across reboots), so a config that pins a
    /// GPU by id keeps pointing at the same card even when a second, chipset-
    /// identical card is also installed. Never derived from this process's
    /// own enumeration order — see each `detect_gpus` for how it is built.
    #[serde(default)]
    pub stable_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CpuInfo {
    pub name: String,
    /// OS-total logical processors, matching the scope of `physical_cores`.
    /// This describes the machine, not the current process: it ignores
    /// affinity, cgroup, and job-object limits that shrink
    /// `available_parallelism`. On an ordinary machine with no such
    /// restriction the two agree, so existing fingerprints do not move. A
    /// runtime thread default that needs the schedulable count should query
    /// `available_parallelism` separately instead of reusing this field.
    pub logical_cores: u32,
    /// Physical cores, which on a processor with simultaneous multithreading is
    /// fewer than `logical_cores`. Optional in both directions: a platform that
    /// will not report the count records `None` rather than a division of the
    /// thread count, and a record written before this was collected carries no
    /// field at all and still reads back.
    #[serde(default)]
    pub physical_cores: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DeviceProfile {
    pub schema_version: u32,
    pub os: String,
    pub arch: String,
    pub cpu: CpuInfo,
    pub gpus: Vec<GpuDevice>,
    /// How the GPU list was obtained, so a bug report can tell "no GPU" from
    /// "could not look".
    pub detection: String,
    pub fingerprint: String,
}

impl DeviceProfile {
    /// The best discrete GPU, falling back to an integrated one.
    pub fn primary_gpu(&self) -> Option<&GpuDevice> {
        self.gpus
            .iter()
            .filter(|gpu| !gpu.integrated)
            .max_by_key(|gpu| gpu.vram_mb.unwrap_or(0))
            .or_else(|| self.gpus.first())
    }

    pub fn has_vendor(&self, vendor: GpuVendor) -> bool {
        self.gpus.iter().any(|gpu| gpu.vendor == vendor)
    }

    pub fn has_discrete(&self, vendor: GpuVendor) -> bool {
        self.gpus
            .iter()
            .any(|gpu| gpu.vendor == vendor && !gpu.integrated)
    }
}

/// Stable across runs on the same hardware, identical across machines with the
/// same parts, and reveals nothing that identifies the owner.
///
/// Deliberately built from the CPU name and OS-total thread count only.
/// Mixing the physical core count in would give every machine a different key
/// than the one it published under, splitting one device class into a before
/// and an after. Because the thread count is the OS total, it equals
/// `available_parallelism` on an ordinary machine with no affinity or group
/// restriction, so existing keys do not move.
pub fn fingerprint(os: &str, arch: &str, cpu: &CpuInfo, gpus: &[GpuDevice]) -> String {
    let mut parts = vec![
        os.to_string(),
        arch.to_string(),
        normalize(&cpu.name),
        cpu.logical_cores.to_string(),
    ];
    let mut gpu_parts: Vec<String> = gpus
        .iter()
        .map(|gpu| {
            format!(
                "{}|{}|{}",
                gpu.vendor.as_str(),
                normalize(&gpu.name),
                // Bucket VRAM so a 100 MB reporting difference does not split
                // otherwise-identical devices into separate classes.
                gpu.vram_mb.map(|mb| mb / 1024).unwrap_or(0)
            )
        })
        .collect();
    gpu_parts.sort();
    parts.extend(gpu_parts);
    let mut hasher = Sha256::new();
    hasher.update(parts.join("\n").as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

// Count `cpuN` directory names; anything else (`cpuidle`, `cpufreq`, ...)
// is not a logical processor. Returns `None` when no logical processor is
// listed so the caller falls back instead of reporting a fabricated zero.
#[cfg(any(test, target_os = "linux"))]
fn count_linux_logical_processors(dir_names: &[&str]) -> Option<u32> {
    let count = dir_names
        .iter()
        .filter(|name| {
            name.strip_prefix("cpu").is_some_and(|index| {
                !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
        .count() as u32;
    (count > 0).then_some(count)
}

// Distinct (package, core) pairs are physical cores; hyper-threaded siblings
// share a pair and collapse to one. Every id must parse as a nonnegative
// integer: the kernel reports `-1` when it does not know, and counting that
// sentinel would fabricate exactly one core. Any unparsable id makes the
// whole result untrustworthy, so return `None` rather than a count over a
// partial subset. Empty input likewise yields `None`.
#[cfg(any(test, target_os = "linux"))]
fn count_distinct_cores(pairs: &[(&str, &str)]) -> Option<u32> {
    if pairs.is_empty() {
        return None;
    }
    let mut cores = std::collections::BTreeSet::new();
    for (package, core) in pairs {
        let package: u32 = package.trim().parse().ok()?;
        let core: u32 = core.trim().parse().ok()?;
        cores.insert((package, core));
    }
    Some(cores.len() as u32)
}

// OS-total thread count, matching the scope of `physical_cores` below.
//
// `available_parallelism` reports what this process may use, which shrinks
// under affinity, cgroup, job-object, or multi-group limits, while
// `physical_cores` always describes the whole machine. Reporting the process
// limit here would mix scopes (machine cores vs. process threads) and could
// even claim fewer threads than cores. Each platform therefore queries its
// OS total first and only falls back to `available_parallelism` when the OS
// will not say; on an ordinary machine the two agree, so the fingerprint
// built from this field does not move.
#[cfg(windows)]
fn logical_cores() -> u32 {
    use windows_sys::Win32::System::Threading::{GetActiveProcessorCount, ALL_PROCESSOR_GROUPS};
    let total = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
    if total > 0 {
        return total;
    }
    std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn logical_cores() -> u32 {
    // Same `/sys/devices/system/cpu` universe that `physical_cores` reads, so
    // the two stay in the same scope even inside a container with a masked
    // sysfs; when sysfs is unavailable there is no physical count to stay
    // consistent with, so fall back to what this process may use.
    if let Ok(entries) = std::fs::read_dir("/sys/devices/system/cpu") {
        let names: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        if let Some(total) = count_linux_logical_processors(&refs) {
            return total;
        }
    }
    std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(0)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn logical_cores() -> u32 {
    std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(0)
}

/// Physical cores as the operating system counts them, or `None` when it will
/// not say. Never derived from the thread count: halving it would be wrong on
/// every processor without simultaneous multithreading, and a benchmark must
/// not publish a number nothing actually reported.
/// On Windows this enumerates core relationships across all processor groups,
/// matching the `GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)` scope used
/// for `logical_cores` above.
#[cfg(windows)]
fn physical_cores() -> Option<u32> {
    use windows_sys::Win32::System::SystemInformation::{
        GetLogicalProcessorInformationEx, RelationProcessorCore,
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
    };

    // The first call reports how many bytes the records need; it is expected to
    // fail with an insufficient-buffer status, so only the size is read back.
    let mut bytes: u32 = 0;
    unsafe {
        GetLogicalProcessorInformationEx(RelationProcessorCore, std::ptr::null_mut(), &mut bytes)
    };
    if bytes == 0 || bytes > 1024 * 1024 {
        return None;
    }
    // Records are variable-length and start with a pointer-aligned field, so
    // allocate in 64-bit words rather than bytes.
    let mut buffer = vec![0u64; (bytes as usize).div_ceil(8)];
    let filled = unsafe {
        GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            buffer
                .as_mut_ptr()
                .cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(),
            &mut bytes,
        )
    };
    if filled == 0 {
        return None;
    }
    // The query asked for core relationships only, so every record describes one
    // physical core. Each carries its own length because the group-affinity
    // array at its end is sized by how many processor groups the core spans;
    // only that 8-byte header is read here.
    let base = buffer.as_ptr().cast::<u8>();
    let limit = (bytes as usize).min(buffer.len() * 8);
    let mut offset = 0usize;
    let mut cores = 0u32;
    while offset + 8 <= limit {
        let size = unsafe { std::ptr::read_unaligned(base.add(offset + 4).cast::<u32>()) } as usize;
        if size < 8 || offset + size > limit {
            break;
        }
        cores += 1;
        offset += size;
    }
    (cores > 0).then_some(cores)
}

#[cfg(target_os = "linux")]
fn physical_cores() -> Option<u32> {
    // Each logical CPU names the package it sits in and the core inside that
    // package, so hyper-threaded siblings collapse onto the pair they share
    // and the number of distinct pairs is the physical core count. Any cpuN
    // without readable ids makes the whole result untrustworthy: reporting a
    // count over the remaining subset would present partial data as the
    // machine total, so return `None` instead.
    let mut pairs = Vec::new();
    for entry in std::fs::read_dir("/sys/devices/system/cpu").ok()?.flatten() {
        let name = entry.file_name();
        let Some(index) = name.to_str().and_then(|name| name.strip_prefix("cpu")) else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let topology = entry.path().join("topology");
        let read = |file: &str| {
            std::fs::read_to_string(topology.join(file))
                .ok()
                .map(|value| value.trim().to_string())
        };
        let (Some(package), Some(core)) = (read("physical_package_id"), read("core_id")) else {
            return None;
        };
        pairs.push((package, core));
    }
    if pairs.is_empty() {
        return None;
    }
    let refs: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(package, core)| (package.as_str(), core.as_str()))
        .collect();
    count_distinct_cores(&refs)
}

#[cfg(target_os = "macos")]
fn physical_cores() -> Option<u32> {
    let mut value: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    let read = unsafe {
        libc::sysctlbyname(
            c"hw.physicalcpu".as_ptr(),
            std::ptr::addr_of_mut!(value).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (read == 0 && value > 0).then_some(value as u32)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn physical_cores() -> Option<u32> {
    None
}

pub fn detect() -> DeviceProfile {
    let (gpus, detection) = detect_gpus();
    let cpu = CpuInfo {
        name: detect_cpu_name(),
        logical_cores: logical_cores(),
        physical_cores: physical_cores(),
    };
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let fingerprint = fingerprint(&os, &arch, &cpu, &gpus);
    DeviceProfile {
        schema_version: DEVICE_PROFILE_SCHEMA,
        os,
        arch,
        cpu,
        gpus,
        detection,
        fingerprint,
    }
}

#[cfg(windows)]
mod windows_detect {
    use super::{GpuDevice, GpuVendor};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_DWORD, REG_QWORD, REG_SZ,
    };

    /// The display adapter setup class.
    const DISPLAY_CLASS: &str =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    fn wide(value: &str) -> Vec<u16> {
        OsString::from(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn open(parent: HKEY, path: &str) -> Option<Key> {
        let mut handle: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                parent,
                wide(path).as_ptr(),
                0,
                KEY_READ,
                &mut handle as *mut HKEY,
            )
        };
        (status == ERROR_SUCCESS && !handle.is_null()).then_some(Key(handle))
    }

    fn read_raw(key: &Key, name: &str) -> Option<(u32, Vec<u8>)> {
        let name = wide(name);
        let mut kind: u32 = 0;
        let mut size: u32 = 0;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS || size == 0 || size > 64 * 1024 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then(|| {
            buffer.truncate(size as usize);
            (kind, buffer)
        })
    }

    fn read_string(key: &Key, name: &str) -> Option<String> {
        let (kind, bytes) = read_raw(key, name)?;
        if kind != REG_SZ {
            return None;
        }
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .take_while(|unit| *unit != 0)
            .collect();
        let value = OsString::from_wide(&units).to_string_lossy().into_owned();
        (!value.trim().is_empty()).then_some(value)
    }

    fn read_u64(key: &Key, name: &str) -> Option<u64> {
        let (kind, bytes) = read_raw(key, name)?;
        match kind {
            REG_QWORD if bytes.len() >= 8 => Some(u64::from_le_bytes(bytes[..8].try_into().ok()?)),
            REG_DWORD if bytes.len() >= 4 => {
                Some(u32::from_le_bytes(bytes[..4].try_into().ok()?) as u64)
            }
            _ => None,
        }
    }

    /// `PCI\VEN_1002&DEV_7551&...` -> (0x1002, "1002:7551")
    fn parse_pci(matching_id: &str) -> Option<(u16, String)> {
        let lower = matching_id.to_lowercase();
        let vendor_hex = lower.split("ven_").nth(1)?.get(..4)?.to_string();
        let vendor = u16::from_str_radix(&vendor_hex, 16).ok()?;
        let device_hex = lower
            .split("dev_")
            .nth(1)
            .and_then(|rest| rest.get(..4))
            .unwrap_or("0000")
            .to_string();
        Some((vendor, format!("{vendor_hex}:{device_hex}")))
    }

    pub fn gpus() -> Option<Vec<GpuDevice>> {
        let class = open(HKEY_LOCAL_MACHINE, DISPLAY_CLASS)?;
        let mut found = Vec::new();
        for index in 0..64u32 {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    class.0,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            let subkey = String::from_utf16_lossy(&name[..length as usize]);
            // Adapter instances are the four-digit subkeys; skip Configuration etc.
            if subkey.len() != 4 || !subkey.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Some(adapter) = open(class.0, &subkey) else {
                continue;
            };
            let Some(description) = read_string(&adapter, "DriverDesc") else {
                continue;
            };
            let matching = read_string(&adapter, "MatchingDeviceId").unwrap_or_default();
            let (vendor_id, pci_id) = match parse_pci(&matching) {
                Some((vendor, pci)) => (vendor, Some(pci)),
                None => (0, None),
            };
            let vram_mb = read_u64(&adapter, "HardwareInformation.qwMemorySize")
                .filter(|bytes| *bytes > 0)
                .map(|bytes| bytes / (1024 * 1024));
            found.push(GpuDevice {
                vendor: GpuVendor::from_pci(vendor_id),
                integrated: super::looks_integrated(&description, vram_mb),
                name: description,
                vram_mb,
                driver: read_string(&adapter, "DriverVersion"),
                // `subkey` is the display class's own persistent per-adapter
                // instance key (e.g. "0000", "0001"), assigned by Windows
                // when the driver is installed and read back unchanged on
                // every later boot — unlike this loop's `index`, it is not
                // recomputed by our own enumeration, so it survives across
                // detection calls and distinguishes two installed cards that
                // share a chipset (and therefore a `pci_id`).
                stable_id: format!("{}#{subkey}", pci_id.as_deref().unwrap_or("unknown")),
                pci_id,
            });
        }
        Some(found)
    }

    pub fn cpu_name() -> Option<String> {
        let key = open(
            HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        )?;
        read_string(&key, "ProcessorNameString").map(|value| value.trim().to_string())
    }
}

/// Integrated parts either say so in the name or expose a token carve-out of
/// shared memory rather than real VRAM.
fn looks_integrated(name: &str, vram_mb: Option<u64>) -> bool {
    let lower = name.to_lowercase();
    if lower.contains("integrated")
        || lower.contains("igpu")
        || lower.contains(" uhd ")
        || lower.ends_with(" uhd graphics")
        || lower.contains("iris")
        || lower.contains("vega ") && lower.contains("mobile")
    {
        return true;
    }
    // A discrete accelerator worth targeting has its own multi-gigabyte pool.
    matches!(vram_mb, Some(mb) if mb < 1024)
}

#[cfg(target_os = "linux")]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return (Vec::new(), "unavailable".into());
    };
    let mut gpus = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let device = entry.path().join("device");
        let read = |file: &str| {
            std::fs::read_to_string(device.join(file))
                .ok()
                .map(|value| value.trim().to_string())
        };
        let Some(vendor_raw) = read("vendor") else {
            continue;
        };
        let vendor_id = u16::from_str_radix(vendor_raw.trim_start_matches("0x"), 16).unwrap_or(0);
        let device_hex = read("device")
            .unwrap_or_default()
            .trim_start_matches("0x")
            .to_string();
        let vram_mb = read("mem_info_vram_total")
            .and_then(|value| value.parse::<u64>().ok())
            .map(|bytes| bytes / (1024 * 1024));
        let label = read("product_name").unwrap_or_else(|| format!("PCI {vendor_raw}"));
        // `device` is a symlink into /sys/bus/pci/devices/<bus-address>; the
        // link target's file name is the card's real PCI bus/slot/function
        // address (e.g. "0000:03:00.0"), which is unique per physical card
        // even when two installed cards share a chipset and therefore a
        // `pci_id`. Fall back to the sysfs card slot name (still stable
        // across detection calls, just not tied to the physical slot) when
        // the symlink cannot be read.
        let bus_address = std::fs::read_link(&device).ok().and_then(|target| {
            target
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
        });
        let stable_id = bus_address.unwrap_or_else(|| name.clone());
        gpus.push(GpuDevice {
            vendor: GpuVendor::from_pci(vendor_id),
            integrated: looks_integrated(&label, vram_mb),
            name: label,
            vram_mb,
            driver: None,
            stable_id,
            pci_id: Some(format!("{:04x}:{device_hex}", vendor_id)),
        });
    }
    (gpus, "linux-sysfs".into())
}

#[cfg(target_os = "macos")]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    // Apple silicon always exposes a Metal GPU sharing system memory; Intel
    // Macs are not a llama.cpp GPU catalog target.
    if std::env::consts::ARCH == "aarch64" {
        (
            vec![GpuDevice {
                vendor: GpuVendor::Apple,
                name: "Apple GPU".into(),
                vram_mb: None,
                driver: None,
                pci_id: None,
                integrated: true,
                // Apple silicon exposes exactly one system GPU; there is
                // never a second card to disambiguate from.
                stable_id: "apple-gpu-0".into(),
            }],
            "macos-arch".into(),
        )
    } else {
        (Vec::new(), "macos-arch".into())
    }
}

#[cfg(windows)]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    match windows_detect::gpus() {
        Some(gpus) => (gpus, "windows-registry".into()),
        None => (Vec::new(), "unavailable".into()),
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    (Vec::new(), "unsupported-platform".into())
}

fn detect_cpu_name() -> String {
    #[cfg(windows)]
    if let Some(name) = windows_detect::cpu_name() {
        return name;
    }
    #[cfg(target_os = "linux")]
    if let Ok(info) = std::fs::read_to_string("/proc/cpuinfo") {
        if let Some(line) = info.lines().find(|line| line.starts_with("model name")) {
            if let Some(value) = line.split(':').nth(1) {
                return value.trim().to_string();
            }
        }
    }
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(vendor: GpuVendor, name: &str, vram_mb: Option<u64>, integrated: bool) -> GpuDevice {
        GpuDevice {
            vendor,
            name: name.into(),
            vram_mb,
            driver: None,
            pci_id: None,
            integrated,
            stable_id: format!("test-{name}"),
        }
    }

    #[test]
    fn pci_ids_map_to_known_vendors() {
        assert_eq!(GpuVendor::from_pci(0x10de), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_pci(0x1002), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_pci(0x8086), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_pci(0x1234), GpuVendor::Unknown);
    }

    #[test]
    fn small_memory_pools_and_named_parts_read_as_integrated() {
        assert!(looks_integrated("AMD Radeon(TM) Graphics", Some(512)));
        assert!(looks_integrated("Intel(R) Iris(R) Xe Graphics", Some(2048)));
        assert!(!looks_integrated("AMD Radeon AI PRO R9700", Some(32623)));
        assert!(!looks_integrated("NVIDIA GeForce RTX 4090", Some(24564)));
    }

    #[test]
    fn primary_gpu_prefers_the_largest_discrete_card() {
        let profile = DeviceProfile {
            schema_version: DEVICE_PROFILE_SCHEMA,
            os: "windows".into(),
            arch: "x86_64".into(),
            cpu: CpuInfo {
                name: "CPU".into(),
                logical_cores: 8,
                physical_cores: Some(4),
            },
            gpus: vec![
                gpu(GpuVendor::Amd, "Radeon Graphics", Some(512), true),
                gpu(GpuVendor::Amd, "Radeon AI PRO R9700", Some(32623), false),
            ],
            detection: "test".into(),
            fingerprint: String::new(),
        };
        assert_eq!(
            profile.primary_gpu().map(|gpu| gpu.name.as_str()),
            Some("Radeon AI PRO R9700")
        );
        assert!(profile.has_discrete(GpuVendor::Amd));
        assert!(!profile.has_vendor(GpuVendor::Nvidia));
    }

    #[test]
    fn fingerprint_is_stable_order_independent_and_hardware_sensitive() {
        let cpu = CpuInfo {
            name: "AMD EPYC 4585PX 16-Core Processor".into(),
            logical_cores: 32,
            physical_cores: None,
        };
        let a = gpu(GpuVendor::Amd, "Radeon AI PRO R9700", Some(32623), false);
        let b = gpu(GpuVendor::Amd, "Radeon Graphics", Some(512), true);

        let one = fingerprint("windows", "x86_64", &cpu, &[a.clone(), b.clone()]);
        let two = fingerprint("windows", "x86_64", &cpu, &[b.clone(), a.clone()]);
        assert_eq!(one, two, "enumeration order must not change the class");
        assert_eq!(one.len(), 16);

        // Whitespace and case differences describe the same part.
        let noisy = gpu(
            GpuVendor::Amd,
            "  Radeon   AI PRO  r9700 ",
            Some(32623),
            false,
        );
        assert_eq!(
            one,
            fingerprint("windows", "x86_64", &cpu, &[noisy, b.clone()])
        );

        // Different hardware must land in a different class.
        let other = gpu(GpuVendor::Nvidia, "GeForce RTX 4090", Some(24564), false);
        assert_ne!(one, fingerprint("windows", "x86_64", &cpu, &[other, b]));
        assert_ne!(one, fingerprint("linux", "x86_64", &cpu, &[a]));
    }

    #[test]
    fn the_device_key_does_not_move_when_the_physical_core_count_is_added() {
        let card = gpu(GpuVendor::Nvidia, "GeForce RTX 4090", Some(24564), false);
        let threads_only = CpuInfo {
            name: "AMD EPYC 4585PX 16-Core Processor".into(),
            logical_cores: 32,
            physical_cores: None,
        };
        let with_cores = CpuInfo {
            physical_cores: Some(16),
            ..threads_only.clone()
        };
        // Results published before the count was collected have to keep landing
        // in the same device class as results published after it.
        assert_eq!(
            fingerprint(
                "windows",
                "x86_64",
                &threads_only,
                std::slice::from_ref(&card)
            ),
            fingerprint("windows", "x86_64", &with_cores, &[card])
        );
    }

    #[test]
    fn a_cpu_written_before_physical_cores_existed_reads_back_as_unknown() {
        let legacy: CpuInfo =
            serde_json::from_value(serde_json::json!({"name": "Test CPU", "logical_cores": 8}))
                .unwrap();
        assert_eq!(legacy.logical_cores, 8);
        assert!(legacy.physical_cores.is_none());
        // A count that is collected always travels, including as null.
        let encoded = serde_json::to_value(CpuInfo {
            name: "Test CPU".into(),
            logical_cores: 8,
            physical_cores: Some(4),
        })
        .unwrap();
        assert_eq!(encoded["physical_cores"], serde_json::json!(4));
        assert!(serde_json::to_value(legacy).unwrap()["physical_cores"].is_null());
    }

    #[test]
    fn linux_topology_collapses_smt_siblings_into_one_core() {
        // Two threads sharing package 0 / core 0 plus two sharing package 0 /
        // core 1 describe a 2-core, 4-thread machine.
        let pairs = [("0", "0"), ("0", "0"), ("0", "1"), ("0", "1")];
        assert_eq!(count_distinct_cores(&pairs), Some(2));
        // The same core id on different packages is a different core.
        assert_eq!(count_distinct_cores(&[("0", "0"), ("1", "0")]), Some(2));
    }

    #[test]
    fn linux_topology_treats_unknown_minus_one_ids_as_untrustworthy() {
        // The kernel reports -1 when it does not know; counting that sentinel
        // would fabricate exactly one core.
        assert_eq!(count_distinct_cores(&[("-1", "-1"), ("-1", "-1")]), None);
        assert_eq!(count_distinct_cores(&[("0", "-1")]), None);
        assert_eq!(count_distinct_cores(&[("-1", "0")]), None);
        // Non-numeric or empty ids are equally untrustworthy.
        assert_eq!(count_distinct_cores(&[("0", "")]), None);
        assert_eq!(count_distinct_cores(&[("x", "0")]), None);
    }

    #[test]
    fn linux_topology_returns_none_for_partial_or_empty_data() {
        // One bad entry poisons the whole result rather than reporting a
        // subset as the machine total.
        assert_eq!(count_distinct_cores(&[("0", "0"), ("0", "bad")]), None);
        assert_eq!(count_distinct_cores(&[] as &[(&str, &str)]), None);
        // Whitespace around valid ids is tolerated (sysfs trails a newline).
        assert_eq!(count_distinct_cores(&[("0\n", " 0 ")]), Some(1));
        // A distinct count can never exceed the thread entries it collapsed.
        let pairs = [("0", "0"), ("0", "0"), ("0", "1")];
        let cores = count_distinct_cores(&pairs).unwrap();
        assert!((1..=pairs.len() as u32).contains(&cores));
    }

    #[test]
    fn linux_logical_count_uses_cpu_entries_only() {
        assert_eq!(
            count_linux_logical_processors(&["cpu0", "cpu1", "cpuidle", "cpufreq", "cpu"]),
            Some(2)
        );
        assert_eq!(count_linux_logical_processors(&["cpuidle"]), None);
        assert_eq!(count_linux_logical_processors(&[]), None);
    }

    #[test]
    fn fingerprint_carries_no_identifying_material() {
        let cpu = CpuInfo {
            name: "AMD EPYC 4585PX".into(),
            logical_cores: 32,
            physical_cores: None,
        };
        let value = fingerprint("windows", "x86_64", &cpu, &[]);
        assert!(value.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// Two installed cards with an identical chipset share a `name`/`pci_id`
    /// (they are, after all, the same product), so anything keying off those
    /// fields alone cannot tell them apart. `stable_id` must still let a
    /// config pin one specific card.
    #[test]
    fn duplicate_chipset_gpus_are_distinguished_by_stable_id_not_pci_id_or_index() {
        let first = GpuDevice {
            vendor: GpuVendor::Nvidia,
            name: "NVIDIA GeForce RTX 4090".into(),
            vram_mb: Some(24564),
            driver: Some("floor-driver".into()),
            pci_id: Some("10de:2684".into()),
            integrated: false,
            stable_id: "10de:2684#0000".into(),
        };
        let second = GpuDevice {
            stable_id: "10de:2684#0001".into(),
            ..first.clone()
        };
        assert_eq!(first.pci_id, second.pci_id, "same chipset, by construction");
        assert_eq!(first.name, second.name, "same chipset, by construction");
        assert_ne!(
            first.stable_id, second.stable_id,
            "duplicate chipset cards must still resolve to distinct stable ids"
        );

        let profile = DeviceProfile {
            schema_version: DEVICE_PROFILE_SCHEMA,
            os: "windows".into(),
            arch: "x86_64".into(),
            cpu: CpuInfo {
                name: "CPU".into(),
                logical_cores: 16,
                physical_cores: Some(8),
            },
            gpus: vec![first.clone(), second.clone()],
            detection: "test".into(),
            fingerprint: String::new(),
        };
        // Looking a card up by its stable id must return that exact card,
        // never merely "a card with this pci_id" (there are two).
        let find = |id: &str| profile.gpus.iter().find(|gpu| gpu.stable_id == id);
        assert_eq!(find("10de:2684#0000"), Some(&first));
        assert_eq!(find("10de:2684#0001"), Some(&second));
        assert_eq!(find("10de:2684#missing"), None);
    }
}
