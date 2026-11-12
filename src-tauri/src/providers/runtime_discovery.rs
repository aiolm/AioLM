//! Read-only, name-independent discovery of local connection candidates.
//!
//! A listener or executable is evidence of an entry point, never evidence of
//! an inference protocol, model compatibility or safe lifecycle ownership.
//! Discovery does not execute candidates, import libraries or collect environments.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::collections::BTreeMap;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Seek, SeekFrom},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_CANDIDATES: usize = 256;
const MAX_ENTRIES: usize = 8192;
const MAX_DEPTH: usize = 4;
const MAX_COMMAND_BYTES: usize = 128 * 1024;
#[cfg(any(target_os = "linux", target_os = "macos", test))]
const MAX_ARGUMENTS: usize = 256;
/// Leading bytes read from every selected-folder file to recognize its format.
const HEADER_PREFIX_BYTES: u64 = 512;
/// Upper bound for any later header table read (PE header, ELF program
/// headers, Mach-O slice header). Larger tables are left unproven.
const MAX_IMAGE_TABLE_BYTES: usize = 256 * 1024;
/// Fat Mach-O files list one slice per CPU type, far fewer than this. Java
/// class files share the fat magic, but their version word is at least 45.
const MAX_FAT_ARCHES: u32 = 30;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoverySource {
    LocalProcess,
    SelectedFolder,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntrypointKind {
    Native,
    Interpreter,
    Container,
    Attached,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryState {
    NeedsConfiguration,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgvSource {
    OsArguments,
    WindowsCommandLine,
    ExecutableFile,
    Shebang,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedCommand {
    pub program: String,
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    pub argv_source: ArgvSource,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalEndpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeCandidate {
    pub id: String,
    pub source: DiscoverySource,
    pub display_name: String,
    pub entrypoint_path: Option<String>,
    /// Discovery stamp only, not a publisher signature or full artifact hash.
    pub entrypoint_fingerprint: Option<String>,
    pub command: Option<ObservedCommand>,
    pub endpoints: Vec<LocalEndpoint>,
    pub entrypoint_kind: EntrypointKind,
    pub state: DiscoveryState,
    pub pid: Option<u32>,
    /// OS creation identity, when available. PID alone can be reused.
    pub process_identity: Option<String>,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryReport {
    pub candidates: Vec<RuntimeCandidate>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}

fn cancelled(cancel: &AtomicBool) -> Result<(), crate::error::AppError> {
    if cancel.load(Ordering::Acquire) {
        Err(crate::error::AppError::cancelled(
            "runtime discovery cancelled",
        ))
    } else {
        Ok(())
    }
}

fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>, crate::error::AppError> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| crate::error::AppError::from_io(&e))?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| crate::error::AppError::from_io(&e))?;
    if bytes.len() > limit {
        return Err(crate::error::AppError::validation(
            "discovery metadata exceeds its size limit",
        ));
    }
    Ok(bytes)
}

fn text_path(path: &Path) -> Option<String> {
    path.to_str().map(str::to_owned)
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn valid_arguments(args: &[String]) -> bool {
    args.len() <= MAX_ARGUMENTS
        && args.iter().all(|s| s.len() <= 32768 && !s.contains('\0'))
        && args.iter().map(String::len).sum::<usize>() <= MAX_COMMAND_BYTES
}

fn candidate(
    source: DiscoverySource,
    entrypoint_path: Option<String>,
    command: Option<ObservedCommand>,
    endpoints: Vec<LocalEndpoint>,
    entrypoint_kind: EntrypointKind,
    process: Option<(u32, String)>,
    reasons: Vec<String>,
) -> RuntimeCandidate {
    let entrypoint_fingerprint = if source == DiscoverySource::SelectedFolder {
        entrypoint_path
            .as_deref()
            .and_then(|path| file_fingerprint(Path::new(path)).ok())
    } else {
        None
    };
    let display_name = entrypoint_path
        .as_deref()
        .map(Path::new)
        .map(display_name)
        .unwrap_or_else(|| "Local listener".into());
    let (pid, process_identity) = process
        .map(|(pid, identity)| (Some(pid), Some(identity)))
        .unwrap_or_default();
    let process_identity = process_identity.filter(|identity| !identity.is_empty());
    let identity = serde_json::json!([
        source,
        entrypoint_path,
        entrypoint_fingerprint,
        command,
        endpoints,
        pid,
        process_identity
    ]);
    RuntimeCandidate {
        id: format!("{:x}", Sha256::digest(identity.to_string().as_bytes())),
        source,
        display_name,
        entrypoint_path,
        entrypoint_fingerprint,
        command,
        endpoints,
        entrypoint_kind,
        state: DiscoveryState::NeedsConfiguration,
        pid,
        process_identity,
        reasons,
    }
}

fn file_fingerprint(path: &Path) -> Result<String, crate::error::AppError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        crate::error::AppError::new(
            crate::error::AppError::io_kind(&error),
            "The entry point is no longer available.",
        )
    })?;
    if !path.is_absolute() || !metadata.is_file() {
        return Err(crate::error::AppError::validation(
            "The selected entry point is no longer a regular local file.",
        ));
    }
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    digest.update(metadata.len().to_le_bytes());
    digest.update(
        format!(
            "{:?}",
            metadata
                .modified()
                .map_err(|_| "The entry point identity is unavailable.")?
        )
        .as_bytes(),
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(metadata.dev().to_le_bytes());
        digest.update(metadata.ino().to_le_bytes());
        digest.update(metadata.mode().to_le_bytes());
    }
    let mut prefix = Vec::new();
    fs::File::open(path)
        .map_err(|error| {
            crate::error::AppError::new(
                crate::error::AppError::io_kind(&error),
                "The entry point is no longer readable.",
            )
        })?
        .take(512)
        .read_to_end(&mut prefix)
        .map_err(|_| {
            crate::error::AppError::unavailable("The entry point identity is unavailable.")
        })?;
    digest.update(prefix);
    Ok(format!("{:x}", digest.finalize()))
}

/// Re-snapshot OS ownership immediately before using cached discovery data.
/// This grants no right to terminate an existing process.
pub fn revalidate(candidate: &RuntimeCandidate) -> Result<(), crate::error::AppError> {
    revalidate_with_cancel(candidate, &AtomicBool::new(false))
}

pub fn revalidate_with_cancel(
    candidate: &RuntimeCandidate,
    cancel: &AtomicBool,
) -> Result<(), crate::error::AppError> {
    cancelled(cancel)?;
    match candidate.source {
        DiscoverySource::LocalProcess => {
            if candidate.pid.is_none()
                || candidate
                    .process_identity
                    .as_ref()
                    .is_none_or(String::is_empty)
            {
                return Err(crate::error::AppError::unavailable("The process creation identity is unavailable; discover the local server again."));
            }
            let mut current = DiscoveryReport::default();
            discover_processes(&mut current, cancel)?;
            if current.candidates.iter().any(|observed| {
                observed.id == candidate.id
                    && observed.pid == candidate.pid
                    && observed.process_identity == candidate.process_identity
                    && observed.endpoints == candidate.endpoints
            }) {
                Ok(())
            } else {
                Err(crate::error::AppError::not_found(
                    "The process or its listener changed; discover the local server again.",
                ))
            }
        }
        DiscoverySource::SelectedFolder => {
            let path = candidate.entrypoint_path.as_deref().ok_or_else(|| {
                crate::error::AppError::not_found("The selected entry-point path is unavailable.")
            })?;
            let expected = candidate.entrypoint_fingerprint.as_ref().ok_or_else(|| {
                crate::error::AppError::unavailable(
                    "The selected entry-point identity is unavailable.",
                )
            })?;
            if &file_fingerprint(Path::new(path))? != expected {
                return Err(crate::error::AppError::validation(
                    "The selected entry point changed; discover the installation again.",
                ));
            }
            Ok(())
        }
    }
}

fn push(report: &mut DiscoveryReport, value: RuntimeCandidate) {
    if report.candidates.iter().any(|old| old.id == value.id) {
        return;
    }
    if report.candidates.len() == MAX_CANDIDATES {
        report.truncated = true;
    } else {
        report.candidates.push(value);
    }
}

/// Explicit user action only. Selected folders are bounded and links are not
/// traversed. Running candidates belong to the current user, but are not owned
/// by AioLM and must never be stopped or adopted by discovery.
pub fn discover(
    folder: Option<&Path>,
    cancel: &AtomicBool,
) -> Result<DiscoveryReport, crate::error::AppError> {
    cancelled(cancel)?;
    let mut report = DiscoveryReport::default();
    discover_processes(&mut report, cancel)?;
    report
        .candidates
        .sort_by(|a, b| a.display_name.cmp(&b.display_name).then(a.id.cmp(&b.id)));
    if let Some(folder) = folder {
        // A chosen folder is the user's explicit target: its ranked entries
        // come first, and running servers follow within the same bound.
        let processes = std::mem::take(&mut report.candidates);
        discover_folder(folder, &mut report, cancel)?;
        for process in processes {
            push(&mut report, process);
        }
    }
    Ok(report)
}

fn local_endpoint(address: IpAddr, port: u16) -> Option<LocalEndpoint> {
    if port == 0 || !(address.is_loopback() || address.is_unspecified()) {
        return None;
    }
    let host = match address {
        IpAddr::V4(value) if value.is_unspecified() => Ipv4Addr::LOCALHOST.into(),
        IpAddr::V6(value) if value.is_unspecified() => Ipv6Addr::LOCALHOST.into(),
        value => value,
    };
    Some(LocalEndpoint {
        host: host.to_string(),
        port,
    })
}

fn display_name(program: &Path) -> String {
    program
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Local program")
        .chars()
        .take(256)
        .collect()
}

#[cfg(target_os = "linux")]
fn proc_listener(line: &str, ipv6: bool) -> Option<(u64, LocalEndpoint)> {
    let columns = line.split_whitespace().collect::<Vec<_>>();
    if columns.get(3)? != &"0A" {
        return None;
    }
    let (address, port) = columns.get(1)?.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let address = if ipv6 {
        if address.len() != 32 {
            return None;
        }
        let mut bytes = [0; 16];
        for (index, chunk) in address.as_bytes().as_chunks::<8>().0.iter().enumerate() {
            let value = u32::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
            bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_ne_bytes());
        }
        IpAddr::V6(Ipv6Addr::from(bytes))
    } else {
        let value = u32::from_str_radix(address, 16).ok()?;
        IpAddr::V4(Ipv4Addr::from(value.to_ne_bytes()))
    };
    Some((
        columns.get(9)?.parse().ok()?,
        local_endpoint(address, port)?,
    ))
}

#[cfg(target_os = "linux")]
fn process_creation(path: &Path) -> Option<String> {
    let bytes = bounded_read(&path.join("stat"), 32768).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    // comm can contain spaces and parentheses. Field 22 is starttime; the
    // suffix after the final ')' starts with field 3 (state).
    Some(text.rsplit_once(')')?.1.split_whitespace().nth(19)?.into())
}

#[cfg(target_os = "linux")]
fn discover_processes(
    report: &mut DiscoveryReport,
    cancel: &AtomicBool,
) -> Result<(), crate::error::AppError> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::geteuid() };
    let mut listeners = BTreeMap::new();
    for (name, ipv6) in [("tcp", false), ("tcp6", true)] {
        let path = Path::new("/proc/net").join(name);
        let Ok(bytes) = bounded_read(&path, 4 * 1024 * 1024) else {
            report
                .warnings
                .push("Some local listener metadata was unavailable.".into());
            continue;
        };
        for line in String::from_utf8_lossy(&bytes).lines().take(MAX_ENTRIES) {
            if let Some((inode, endpoint)) = proc_listener(line, ipv6) {
                listeners.insert(inode, endpoint);
            }
        }
    }
    let entries = match fs::read_dir("/proc") {
        Ok(entries) => entries,
        Err(_) => {
            report
                .warnings
                .push("Local process discovery is unavailable.".into());
            return Ok(());
        }
    };
    for (index, entry) in entries.flatten().enumerate() {
        cancelled(cancel)?;
        if index >= MAX_ENTRIES {
            report.truncated = true;
            break;
        }
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let path = entry.path();
        if !fs::metadata(&path).is_ok_and(|m| m.uid() == uid) {
            continue;
        }
        let Some(created) = process_creation(&path) else {
            continue;
        };
        let mut endpoints = BTreeSet::new();
        if let Ok(descriptors) = fs::read_dir(path.join("fd")) {
            for descriptor in descriptors.flatten().take(MAX_ENTRIES) {
                cancelled(cancel)?;
                let Ok(target) = fs::read_link(descriptor.path()) else {
                    continue;
                };
                let Some(inode) = target
                    .to_str()
                    .and_then(|s| s.strip_prefix("socket:["))
                    .and_then(|s| s.strip_suffix(']'))
                    .and_then(|s| s.parse::<u64>().ok())
                else {
                    continue;
                };
                if let Some(endpoint) = listeners.get(&inode) {
                    endpoints.insert(endpoint.clone());
                }
            }
        }
        if endpoints.is_empty() {
            continue;
        }
        let program = fs::read_link(path.join("exe")).ok();
        let command = (|| {
            let program = text_path(program.as_ref()?)?;
            let bytes = bounded_read(&path.join("cmdline"), MAX_COMMAND_BYTES).ok()?;
            let command_bytes = bytes.strip_suffix(&[0]).unwrap_or(&bytes);
            let mut args = command_bytes
                .split(|byte| *byte == 0)
                .map(|part| String::from_utf8(part.to_vec()))
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            if args.is_empty() {
                return None;
            }
            args.remove(0);
            if !valid_arguments(&args) {
                return None;
            }
            Some(ObservedCommand {
                program,
                args,
                working_directory: fs::read_link(path.join("cwd"))
                    .ok()
                    .as_deref()
                    .and_then(text_path),
                argv_source: ArgvSource::OsArguments,
            })
        })();
        if process_creation(&path).as_ref() != Some(&created)
            || !fs::metadata(&path).is_ok_and(|m| m.uid() == uid)
        {
            continue;
        }
        push(report, candidate(
            DiscoverySource::LocalProcess,
            program.as_deref().and_then(text_path),
            command,
            endpoints.into_iter().collect(),
            EntrypointKind::Attached,
            Some((pid, created)),
            vec!["Protocol and model support have not been verified; this existing process is not owned by AioLM.".into()],
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn system_inventory(
    program: &Path,
    args: &[&str],
    cancel: &AtomicBool,
) -> Result<Vec<u8>, crate::error::AppError> {
    let mut command = crate::procutil::std_command(program);
    command
        .env_clear()
        .envs(crate::runtime::child_environment())
        .args(args);
    crate::procutil::capture_stdout_cancellable(
        &mut command,
        std::time::Duration::from_secs(15),
        4 * 1024 * 1024,
        Some(cancel),
    )
    .map_err(|_| {
        crate::error::AppError::unavailable(
            "Local process inventory was unavailable or incomplete.",
        )
    })
    .and_then(|output| {
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(crate::error::AppError::unavailable(
                "Local process inventory was unavailable or incomplete.",
            ))
        }
    })
}

#[cfg(target_os = "macos")]
fn mac_creation(pid: u32) -> Option<String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int
        || info.pbi_pid != pid
        || info.pbi_uid != unsafe { libc::geteuid() }
    {
        return None;
    }
    Some(format!(
        "{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}

#[cfg(target_os = "macos")]
fn mac_arguments(pid: u32) -> Option<(PathBuf, Vec<String>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut size: libc::size_t = 0;
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || !(5..=MAX_COMMAND_BYTES).contains(&size)
    {
        return None;
    }
    let mut bytes = vec![0u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    bytes.truncate(size);
    let argc = i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?);
    if !(1..=MAX_ARGUMENTS as i32 + 1).contains(&argc) {
        return None;
    }
    let mut offset = 4;
    let end = bytes[offset..].iter().position(|b| *b == 0)? + offset;
    let program = PathBuf::from(std::str::from_utf8(&bytes[offset..end]).ok()?);
    offset = end;
    while bytes.get(offset) == Some(&0) {
        offset += 1;
    }
    let mut args = Vec::new();
    for _ in 0..argc {
        let end = bytes.get(offset..)?.iter().position(|b| *b == 0)? + offset;
        args.push(std::str::from_utf8(&bytes[offset..end]).ok()?.to_owned());
        offset = end + 1;
    }
    args.remove(0);
    valid_arguments(&args).then_some((program, args))
}

#[cfg(target_os = "macos")]
fn discover_processes(
    report: &mut DiscoveryReport,
    cancel: &AtomicBool,
) -> Result<(), crate::error::AppError> {
    let uid = unsafe { libc::geteuid() }.to_string();
    let bytes = match system_inventory(
        Path::new("/usr/sbin/lsof"),
        &["-nP", "-a", "-u", &uid, "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
        cancel,
    ) {
        Ok(bytes) => bytes,
        Err(message) => {
            cancelled(cancel)?;
            report.warnings.push(message.message);
            return Ok(());
        }
    };
    let mut found: BTreeMap<u32, BTreeSet<LocalEndpoint>> = BTreeMap::new();
    let mut pid = None;
    for line in String::from_utf8_lossy(&bytes).lines().take(MAX_ENTRIES) {
        cancelled(cancel)?;
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
        }
        if let (Some(pid), Some(value)) = (pid, line.strip_prefix('n')) {
            let value = value.trim_end_matches(" (LISTEN)");
            if let Some((host, port)) = value.rsplit_once(':') {
                let host = host.trim_matches(['[', ']']);
                let address = if host == "*" {
                    Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
                } else {
                    host.parse().ok()
                };
                if let Some(endpoint) =
                    address.and_then(|address| local_endpoint(address, port.parse().ok()?))
                {
                    found.entry(pid).or_default().insert(endpoint);
                }
            }
        }
    }
    for (pid, endpoints) in found {
        cancelled(cancel)?;
        let Some(created) = mac_creation(pid) else {
            continue;
        };
        let observed = mac_arguments(pid);
        let command = observed.as_ref().and_then(|(program, args)| {
            Some(ObservedCommand {
                program: text_path(program)?,
                args: args.clone(),
                working_directory: None,
                argv_source: ArgvSource::OsArguments,
            })
        });
        if mac_creation(pid).as_ref() != Some(&created) {
            continue;
        }
        push(report, candidate(DiscoverySource::LocalProcess, observed.as_ref().and_then(|(program, _)| text_path(program)), command, endpoints.into_iter().collect(), EntrypointKind::Attached, Some((pid, created)), vec!["Recheck listener ownership before connecting. Working directory, protocol, model and lifecycle ownership are unverified.".into()]));
    }
    Ok(())
}

#[cfg(windows)]
#[path = "runtime_discovery_windows.rs"]
mod windows_inventory;

#[cfg(windows)]
fn discover_processes(
    report: &mut DiscoveryReport,
    cancel: &AtomicBool,
) -> Result<(), crate::error::AppError> {
    windows_inventory::discover(report, cancel)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn discover_processes(
    report: &mut DiscoveryReport,
    _: &AtomicBool,
) -> Result<(), crate::error::AppError> {
    report
        .warnings
        .push("Local process discovery is unavailable on this platform.".into());
    Ok(())
}

/// Header evidence about a native file found in a selected folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeImage {
    /// The header declares a process image: a console PE program, a Mach-O
    /// executable, or an ELF executable or PIE with a program interpreter.
    Program,
    /// It may still start, but the header does not prove it: a GUI or other
    /// non-console PE subsystem, an ELF shared object without an interpreter
    /// (a static PIE looks like this), or a header that could not be read.
    Unproven,
}

fn u16_at(bytes: &[u8], offset: usize, big: bool) -> Option<u16> {
    let raw = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(if big {
        u16::from_be_bytes(raw)
    } else {
        u16::from_le_bytes(raw)
    })
}

fn u32_at(bytes: &[u8], offset: usize, big: bool) -> Option<u32> {
    let raw = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(if big {
        u32::from_be_bytes(raw)
    } else {
        u32::from_le_bytes(raw)
    })
}

fn u64_at(bytes: &[u8], offset: usize, big: bool) -> Option<u64> {
    let raw = bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?;
    Some(if big {
        u64::from_be_bytes(raw)
    } else {
        u64::from_le_bytes(raw)
    })
}

fn read_table(file: &mut fs::File, offset: u64, size: usize) -> Option<Vec<u8>> {
    if size > MAX_IMAGE_TABLE_BYTES {
        return None;
    }
    let mut bytes = vec![0; size];
    file.seek(SeekFrom::Start(offset)).ok()?;
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// Classifies a file by its executable-format header, never by its name.
/// `None` means the header proves the file cannot be started as a process
/// (a DLL, shared library, object file, core dump, GPU code object or Java
/// class) or that it is not a native image at all. Uncertain headers stay
/// listed as unproven.
fn native_image(file: &mut fs::File, prefix: &[u8]) -> Option<NativeImage> {
    if prefix.starts_with(b"MZ") {
        pe_image(file, prefix)
    } else if prefix.starts_with(b"\x7fELF") {
        elf_image(file, prefix)
    } else if prefix.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
        || prefix.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
    {
        macho_image(macho_filetype(prefix))
    } else if prefix.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        fat_macho_image(file, prefix)
    } else {
        None
    }
}

fn pe_image(file: &mut fs::File, prefix: &[u8]) -> Option<NativeImage> {
    const IMAGE_FILE_DLL: u16 = 0x2000;
    const IMAGE_SUBSYSTEM_WINDOWS_CUI: u16 = 3;
    // Signature (4) + COFF header (20) + optional header through Subsystem (70).
    let header = u32_at(prefix, 0x3c, false)
        .and_then(|offset| read_table(file, offset.into(), 4 + 20 + 70))
        .filter(|header| header.starts_with(b"PE\0\0"));
    let Some(header) = header else {
        return Some(NativeImage::Unproven);
    };
    if u16_at(&header, 22, false).is_some_and(|flags| flags & IMAGE_FILE_DLL != 0) {
        return None;
    }
    let optional = matches!(u16_at(&header, 24, false), Some(0x10b | 0x20b));
    if optional && u16_at(&header, 24 + 68, false) == Some(IMAGE_SUBSYSTEM_WINDOWS_CUI) {
        Some(NativeImage::Program)
    } else {
        Some(NativeImage::Unproven)
    }
}

fn elf_image(file: &mut fs::File, prefix: &[u8]) -> Option<NativeImage> {
    const ET_REL: u16 = 1;
    const ET_EXEC: u16 = 2;
    const ET_DYN: u16 = 3;
    const ET_CORE: u16 = 4;
    // Accelerator code objects (GPU kernels loaded by a host runtime) share
    // the ELF container but are never host processes.
    const EM_CUDA: u16 = 190;
    const EM_AMDGPU: u16 = 224;
    let (wide, big) = match (prefix.get(4), prefix.get(5)) {
        (Some(1), Some(1)) => (false, false),
        (Some(1), Some(2)) => (false, true),
        (Some(2), Some(1)) => (true, false),
        (Some(2), Some(2)) => (true, true),
        _ => return Some(NativeImage::Unproven),
    };
    if matches!(u16_at(prefix, 18, big), Some(EM_CUDA | EM_AMDGPU)) {
        return None;
    }
    match u16_at(prefix, 16, big) {
        Some(ET_REL | ET_CORE) => None,
        Some(ET_EXEC) => Some(NativeImage::Program),
        // Shared libraries and PIE programs are both ET_DYN. Only a program
        // interpreter proves a program; a static PIE has none, so it stays.
        Some(ET_DYN) if elf_has_interpreter(file, prefix, wide, big) => Some(NativeImage::Program),
        _ => Some(NativeImage::Unproven),
    }
}

fn elf_has_interpreter(file: &mut fs::File, prefix: &[u8], wide: bool, big: bool) -> bool {
    const PT_INTERP: u32 = 3;
    let (table, entry_size, count, minimum) = if wide {
        (
            u64_at(prefix, 32, big),
            u16_at(prefix, 54, big),
            u16_at(prefix, 56, big),
            56,
        )
    } else {
        (
            u32_at(prefix, 28, big).map(u64::from),
            u16_at(prefix, 42, big),
            u16_at(prefix, 44, big),
            32,
        )
    };
    let (Some(table), Some(entry_size), Some(count)) = (table, entry_size, count) else {
        return false;
    };
    let entry_size = usize::from(entry_size);
    // PN_XNUM (0xffff) moves the real count elsewhere; leave that unproven.
    if entry_size < minimum || count == 0 || count == u16::MAX {
        return false;
    }
    read_table(file, table, entry_size * usize::from(count)).is_some_and(|headers| {
        headers
            .chunks_exact(entry_size)
            .any(|entry| u32_at(entry, 0, big) == Some(PT_INTERP))
    })
}

fn macho_filetype(header: &[u8]) -> Option<u32> {
    let big = match header.get(..4)? {
        [0xfe, 0xed, 0xfa, 0xce | 0xcf] => true,
        [0xce | 0xcf, 0xfa, 0xed, 0xfe] => false,
        _ => return None,
    };
    u32_at(header, 12, big)
}

fn macho_image(filetype: Option<u32>) -> Option<NativeImage> {
    const MH_EXECUTE: u32 = 2;
    match filetype {
        Some(MH_EXECUTE) => Some(NativeImage::Program),
        Some(_) => None,
        None => Some(NativeImage::Unproven),
    }
}

fn fat_macho_image(file: &mut fs::File, prefix: &[u8]) -> Option<NativeImage> {
    match u32_at(prefix, 4, true) {
        Some(1..=MAX_FAT_ARCHES) => {}
        Some(_) => return None,
        None => return Some(NativeImage::Unproven),
    }
    // Every slice of a universal binary has the same file type; the first
    // slice header (offset field of the first fat_arch) decides.
    let slice = u32_at(prefix, 16, true).and_then(|offset| read_table(file, offset.into(), 16));
    macho_image(slice.as_deref().and_then(macho_filetype))
}

fn discover_folder(
    folder: &Path,
    report: &mut DiscoveryReport,
    cancel: &AtomicBool,
) -> Result<(), crate::error::AppError> {
    let root = folder.canonicalize().map_err(|error| {
        crate::error::AppError::new(
            crate::error::AppError::io_kind(&error),
            "The selected folder is unavailable.",
        )
    })?;
    if !root.is_dir() {
        return Err(crate::error::AppError::validation(
            "Select an existing installation folder.",
        ));
    }
    // Every entry is ranked before publication so the bound keeps the most
    // useful ones: (launch tier, folder depth, path). Tier 0 is a launchable
    // proven program or executable script, tier 1 a launchable unproven image,
    // tier 2 an entry that cannot be launched from here as it stands.
    let mut found: Vec<(u8, usize, RuntimeCandidate)> = Vec::new();
    let mut pending = vec![(root.clone(), 0usize)];
    let mut count = 0;
    'scan: while let Some((directory, depth)) = pending.pop() {
        cancelled(cancel)?;
        let Ok(entries) = fs::read_dir(&directory) else {
            report
                .warnings
                .push("Some selected-folder entries could not be read.".into());
            continue;
        };
        for entry in entries.flatten() {
            cancelled(cancel)?;
            count += 1;
            if count > MAX_ENTRIES {
                report.truncated = true;
                break 'scan;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    pending.push((entry.path(), depth + 1));
                } else {
                    report.truncated = true;
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let path = entry.path();
            let mut prefix = Vec::new();
            let Ok(mut file) = fs::File::open(&path) else {
                continue;
            };
            if (&mut file)
                .take(HEADER_PREFIX_BYTES)
                .read_to_end(&mut prefix)
                .is_err()
            {
                continue;
            }
            let image = native_image(&mut file, &prefix);
            let script = prefix.starts_with(b"#!");
            if image.is_some() || script {
                let Some(program) = text_path(&path) else {
                    continue;
                };
                let executable = {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        entry
                            .metadata()
                            .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
                    }
                    // Windows starts only PE images; ELF and Mach-O files
                    // found here belong to another host.
                    #[cfg(not(unix))]
                    {
                        image.is_some() && prefix.starts_with(b"MZ")
                    }
                };
                let command = executable.then_some(ObservedCommand {
                    program,
                    args: vec![],
                    working_directory: text_path(&directory),
                    argv_source: if script {
                        ArgvSource::Shebang
                    } else {
                        ArgvSource::ExecutableFile
                    },
                });
                let tier = match (&command, image) {
                    (None, _) => 2,
                    (Some(_), Some(NativeImage::Unproven)) => 1,
                    (Some(_), _) => 0,
                };
                found.push((tier, depth, candidate(DiscoverySource::SelectedFolder, text_path(&path), command, vec![], if script { EntrypointKind::Interpreter } else { EntrypointKind::Native }, None, vec!["Entry-point file only: arguments, host compatibility, protocol, model and lifecycle must be verified before launch.".into()])));
            } else if entry.file_name() == "config.json" {
                // OCI is a public runtime contract, independent of any engine,
                // implementation language or chosen container manager.
                let Ok(bytes) = bounded_read(&path, MAX_COMMAND_BYTES) else {
                    continue;
                };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    continue;
                };
                if value["ociVersion"].is_string()
                    && value
                        .pointer("/process/args")
                        .is_some_and(serde_json::Value::is_array)
                {
                    found.push((2, depth, candidate(DiscoverySource::SelectedFolder, text_path(&path), None, vec![], EntrypointKind::Container, None, vec!["OCI bundle found. A container manager and verified container lifecycle are required; container paths are not host executables.".into()])));
                }
            }
        }
    }
    found.sort_by(|(tier, depth, a), (other_tier, other_depth, b)| {
        (tier, depth, &a.entrypoint_path, &a.id).cmp(&(
            other_tier,
            other_depth,
            &b.entrypoint_path,
            &b.id,
        ))
    });
    for (_, _, value) in found {
        push(report, value);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("aiolm-discovery-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn local_addresses_never_expand_discovery_to_remote_hosts() {
        assert_eq!(
            local_endpoint("0.0.0.0".parse().unwrap(), 1234)
                .unwrap()
                .host,
            "127.0.0.1"
        );
        assert_eq!(
            local_endpoint("::".parse().unwrap(), 1234).unwrap().host,
            "::1"
        );
        assert!(local_endpoint("192.0.2.1".parse().unwrap(), 1234).is_none());
        assert!(local_endpoint("127.0.0.1".parse().unwrap(), 0).is_none());
    }

    #[test]
    fn folder_scan_reads_entry_points_without_executing_them_or_following_links() {
        let folder = Folder::new();
        let outside = Folder::new();
        fs::write(
            folder.0.join("unlisted-program"),
            b"\x7fELFsynthetic binary",
        )
        .unwrap();
        fs::write(
            folder.0.join("unlisted-script"),
            b"#!/unavailable/interpreter\ncreate-marker-never-run\n",
        )
        .unwrap();
        fs::write(folder.0.join("ordinary-data.model"), b"not an executable").unwrap();
        fs::write(
            outside.0.join("outside-program"),
            b"\x7fELFsynthetic binary",
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside.0, folder.0.join("outside-link")).unwrap();
        let mut report = DiscoveryReport::default();
        discover_folder(&folder.0, &mut report, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.candidates.len(), 2);
        assert!(report
            .candidates
            .iter()
            .all(|c| c.state == DiscoveryState::NeedsConfiguration
                && c.endpoints.is_empty()
                && c.pid.is_none()));
        assert!(!folder.0.join("marker").exists());
        assert!(report
            .candidates
            .iter()
            .any(|c| c.entrypoint_kind == EntrypointKind::Interpreter));
    }

    #[test]
    fn oci_metadata_is_not_promoted_to_a_host_command_or_owned_process() {
        let folder = Folder::new();
        fs::write(
            folder.0.join("config.json"),
            br#"{"ociVersion":"1.1.0","process":{"args":["/container-only/server","--serve"]}}"#,
        )
        .unwrap();
        let mut report = DiscoveryReport::default();
        discover_folder(&folder.0, &mut report, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.candidates.len(), 1);
        let found = &report.candidates[0];
        assert_eq!(found.entrypoint_kind, EntrypointKind::Container);
        assert!(found.command.is_none() && found.pid.is_none() && found.endpoints.is_empty());
    }

    #[test]
    fn selected_entry_revalidation_refuses_changed_files_and_preserves_other_candidates() {
        let folder = Folder::new();
        let first = folder.0.join("first-entry");
        let second = folder.0.join("second-entry");
        fs::write(&first, b"\x7fELFfirst-entry").unwrap();
        fs::write(&second, b"\x7fELFsecond-entry").unwrap();
        // Discovery resolves the selected root. macOS temporary directories
        // and Windows verbatim prefixes need the same filesystem identity.
        let first = first.canonicalize().unwrap();
        let second = second.canonicalize().unwrap();
        let mut report = DiscoveryReport::default();
        discover_folder(&folder.0, &mut report, &AtomicBool::new(false)).unwrap();
        let a = report
            .candidates
            .iter()
            .find(|c| c.entrypoint_path.as_deref() == first.to_str())
            .unwrap();
        let b = report
            .candidates
            .iter()
            .find(|c| c.entrypoint_path.as_deref() == second.to_str())
            .unwrap();
        assert_ne!(a.id, b.id);
        revalidate(a).unwrap();
        fs::write(&first, b"\x7fELFchanged-entry").unwrap();
        assert!(revalidate(a).unwrap_err().message.contains("changed"));
        revalidate(b).unwrap();
    }

    #[test]
    fn cancellation_and_bounds_do_not_publish_silent_success() {
        let error = discover(None, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
        assert_eq!(error.message, "runtime discovery cancelled");
        assert!(!valid_arguments(&vec!["a".into(); MAX_ARGUMENTS + 1]));
        let folder = Folder::new();
        for index in 0..=MAX_CANDIDATES {
            fs::write(folder.0.join(format!("entry-{index}")), b"\x7fELFsynthetic").unwrap();
        }
        let mut report = DiscoveryReport::default();
        discover_folder(&folder.0, &mut report, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.candidates.len(), MAX_CANDIDATES);
        assert!(report.truncated);
    }

    fn pe(characteristics: u16, subsystem: u16) -> Vec<u8> {
        let mut bytes = vec![0; 0x200];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x80 + 22..0x80 + 24].copy_from_slice(&characteristics.to_le_bytes());
        bytes[0x80 + 24..0x80 + 26].copy_from_slice(&0x20bu16.to_le_bytes());
        bytes[0x80 + 92..0x80 + 94].copy_from_slice(&subsystem.to_le_bytes());
        bytes
    }

    fn elf(kind: u16, interpreter: bool) -> Vec<u8> {
        let mut bytes = vec![0; 64 + 56];
        bytes[..6].copy_from_slice(b"\x7fELF\x02\x01");
        bytes[16..18].copy_from_slice(&kind.to_le_bytes());
        bytes[32..40].copy_from_slice(&64u64.to_le_bytes());
        bytes[54..56].copy_from_slice(&56u16.to_le_bytes());
        bytes[56..58].copy_from_slice(&1u16.to_le_bytes());
        let segment: u32 = if interpreter { 3 } else { 1 };
        bytes[64..68].copy_from_slice(&segment.to_le_bytes());
        bytes
    }

    fn macho(filetype: u32) -> Vec<u8> {
        let mut bytes = vec![0; 32];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[12..16].copy_from_slice(&filetype.to_le_bytes());
        bytes
    }

    fn fat(filetype: u32) -> Vec<u8> {
        let mut bytes = vec![0; 64];
        bytes[..4].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbe]);
        bytes[4..8].copy_from_slice(&1u32.to_be_bytes());
        bytes[16..20].copy_from_slice(&64u32.to_be_bytes());
        bytes.extend(macho(filetype));
        bytes
    }

    fn found_names(report: &DiscoveryReport) -> Vec<String> {
        report
            .candidates
            .iter()
            .map(|c| c.display_name.clone())
            .collect()
    }

    #[test]
    fn folder_scan_drops_only_files_whose_headers_prove_they_are_not_programs() {
        let folder = Folder::new();
        let mut gpu_kernel = elf(3, true);
        gpu_kernel[18..20].copy_from_slice(&224u16.to_le_bytes());
        // Names deliberately contradict the headers: only the header decides.
        for (name, bytes) in [
            ("server.exe", pe(0x2022, 3)),
            ("helper.dll", pe(0x0022, 3)),
            ("window", pe(0x0022, 2)),
            ("truncated-pe", b"MZ".to_vec()),
            ("object", elf(1, false)),
            ("core", elf(4, false)),
            ("plain", elf(2, false)),
            ("pie", elf(3, true)),
            ("static-pie.so", elf(3, false)),
            ("library", macho(6)),
            ("tool.dylib", macho(2)),
            ("universal-library", fat(6)),
            ("universal", fat(2)),
            ("Main.class", vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]),
            ("kernel-launcher", gpu_kernel),
        ] {
            fs::write(folder.0.join(name), bytes).unwrap();
        }
        let mut report = DiscoveryReport::default();
        discover_folder(&folder.0, &mut report, &AtomicBool::new(false)).unwrap();
        let mut names = found_names(&report);
        names.sort();
        // GUI PE, unreadable PE and interpreter-less ELF stay listed: their
        // headers do not prove they cannot start.
        assert_eq!(
            names,
            [
                "helper.dll",
                "pie",
                "plain",
                "static-pie.so",
                "tool.dylib",
                "truncated-pe",
                "universal",
                "window"
            ]
        );
    }

    #[test]
    fn folder_entries_are_ranked_by_launchability_then_depth_then_path() {
        let folder = Folder::new();
        fs::create_dir(folder.0.join("nested")).unwrap();
        for (name, bytes) in [
            ("a-window", pe(0x0022, 2)),
            ("nested/console", pe(0x0022, 3)),
            ("z-console", pe(0x0022, 3)),
        ] {
            let path = folder.0.join(name);
            fs::write(&path, bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        fs::write(
            folder.0.join("config.json"),
            br#"{"ociVersion":"1.1.0","process":{"args":["/container-only/server"]}}"#,
        )
        .unwrap();
        let mut report = DiscoveryReport::default();
        discover_folder(&folder.0, &mut report, &AtomicBool::new(false)).unwrap();
        // Proven programs first (shallower before deeper), then unproven
        // launchable images, then entries that need other tooling to start.
        assert_eq!(
            found_names(&report),
            ["z-console", "console", "a-window", "config.json"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_socket_parsing_rejects_nonlisteners_and_nonlocal_addresses() {
        let row =
            "0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345";
        assert_eq!(
            proc_listener(row, false),
            Some((
                12345,
                LocalEndpoint {
                    host: "127.0.0.1".into(),
                    port: 8080
                }
            ))
        );
        assert!(proc_listener(&row.replace(" 0A ", " 01 "), false).is_none());
        assert!(proc_listener(&row.replace("0100007F", "010200C0"), false).is_none());
        let ipv6 = row.replace("0100007F", "00000000000000000000000001000000");
        assert_eq!(proc_listener(&ipv6, true).unwrap().1.host, "::1");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn running_discovery_observes_a_real_listener_without_owning_or_stopping_it() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let report = discover(None, &AtomicBool::new(false)).unwrap();
        let found = report
            .candidates
            .iter()
            .find(|c| {
                c.pid == Some(std::process::id())
                    && c.endpoints.iter().any(|endpoint| endpoint.port == port)
            })
            .unwrap();
        assert_eq!(found.entrypoint_kind, EntrypointKind::Attached);
        assert!(
            found.command.is_some()
                && found
                    .process_identity
                    .as_ref()
                    .is_some_and(|id| !id.is_empty())
        );
        let mut reused_identity = found.clone();
        reused_identity.process_identity = Some("synthetic-reused-pid".into());
        assert!(revalidate(&reused_identity).is_err());
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
        let stale = found.clone();
        drop(listener);
        assert!(revalidate(&stale).is_err());
    }
}
