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
    io::Read,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_CANDIDATES: usize = 256;
const MAX_ENTRIES: usize = 8192;
const MAX_DEPTH: usize = 4;
const MAX_COMMAND_BYTES: usize = 128 * 1024;
const MAX_ARGUMENTS: usize = 256;

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

fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("runtime discovery cancelled".into())
    } else {
        Ok(())
    }
}

fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("discovery metadata exceeds its size limit".into());
    }
    Ok(bytes)
}

fn text_path(path: &Path) -> Option<String> {
    path.to_str().map(str::to_owned)
}

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

fn file_fingerprint(path: &Path) -> Result<String, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "The entry point is no longer available.")?;
    if !path.is_absolute() || !metadata.is_file() {
        return Err("The selected entry point is no longer a regular local file.".into());
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
        .map_err(|_| "The entry point is no longer readable.")?
        .take(512)
        .read_to_end(&mut prefix)
        .map_err(|_| "The entry point identity is unavailable.")?;
    digest.update(prefix);
    Ok(format!("{:x}", digest.finalize()))
}

/// Re-snapshot OS ownership immediately before using cached discovery data.
/// This grants no right to terminate an existing process.
pub fn revalidate(candidate: &RuntimeCandidate) -> Result<(), String> {
    revalidate_with_cancel(candidate, &AtomicBool::new(false))
}

pub fn revalidate_with_cancel(
    candidate: &RuntimeCandidate,
    cancel: &AtomicBool,
) -> Result<(), String> {
    cancelled(cancel)?;
    match candidate.source {
        DiscoverySource::LocalProcess => {
            if candidate.pid.is_none()
                || candidate
                    .process_identity
                    .as_ref()
                    .is_none_or(String::is_empty)
            {
                return Err("The process creation identity is unavailable; discover the local server again.".into());
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
                Err("The process or its listener changed; discover the local server again.".into())
            }
        }
        DiscoverySource::SelectedFolder => {
            let path = candidate
                .entrypoint_path
                .as_deref()
                .ok_or("The selected entry-point path is unavailable.")?;
            let expected = candidate
                .entrypoint_fingerprint
                .as_ref()
                .ok_or("The selected entry-point identity is unavailable.")?;
            if &file_fingerprint(Path::new(path))? != expected {
                return Err(
                    "The selected entry point changed; discover the installation again.".into(),
                );
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
pub fn discover(folder: Option<&Path>, cancel: &AtomicBool) -> Result<DiscoveryReport, String> {
    cancelled(cancel)?;
    let mut report = DiscoveryReport::default();
    discover_processes(&mut report, cancel)?;
    if let Some(folder) = folder {
        discover_folder(folder, &mut report, cancel)?;
    }
    report
        .candidates
        .sort_by(|a, b| a.display_name.cmp(&b.display_name).then(a.id.cmp(&b.id)));
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
fn discover_processes(report: &mut DiscoveryReport, cancel: &AtomicBool) -> Result<(), String> {
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

#[cfg(not(target_os = "linux"))]
fn system_inventory(program: &Path, args: &[&str], cancel: &AtomicBool) -> Result<Vec<u8>, String> {
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
    .map_err(|_| "Local process inventory was unavailable or incomplete.".into())
    .and_then(|output| {
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err("Local process inventory was unavailable or incomplete.".into())
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
fn discover_processes(report: &mut DiscoveryReport, cancel: &AtomicBool) -> Result<(), String> {
    let uid = unsafe { libc::geteuid() }.to_string();
    let bytes = match system_inventory(
        Path::new("/usr/sbin/lsof"),
        &["-nP", "-a", "-u", &uid, "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
        cancel,
    ) {
        Ok(bytes) => bytes,
        Err(message) => {
            cancelled(cancel)?;
            report.warnings.push(message);
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
fn discover_processes(report: &mut DiscoveryReport, cancel: &AtomicBool) -> Result<(), String> {
    windows_inventory::discover(report, cancel)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn discover_processes(report: &mut DiscoveryReport, _: &AtomicBool) -> Result<(), String> {
    report
        .warnings
        .push("Local process discovery is unavailable on this platform.".into());
    Ok(())
}

fn discover_folder(
    folder: &Path,
    report: &mut DiscoveryReport,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let root = folder
        .canonicalize()
        .map_err(|_| "The selected folder is unavailable.")?;
    if !root.is_dir() {
        return Err("Select an existing installation folder.".into());
    }
    let mut pending = vec![(root.clone(), 0usize)];
    let mut count = 0;
    while let Some((directory, depth)) = pending.pop() {
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
                return Ok(());
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
            let mut prefix = vec![0; 512];
            let Ok(mut file) = fs::File::open(&path) else {
                continue;
            };
            let Ok(length) = file.read(&mut prefix) else {
                continue;
            };
            prefix.truncate(length);
            let native = prefix.starts_with(b"\x7fELF")
                || prefix.starts_with(b"MZ")
                || prefix.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
                || prefix.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
                || prefix.starts_with(&[0xca, 0xfe, 0xba, 0xbe]);
            let script = prefix.starts_with(b"#!");
            if native || script {
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
                    #[cfg(not(unix))]
                    {
                        native
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
                push(report, candidate(DiscoverySource::SelectedFolder, text_path(&path), command, vec![], if script { EntrypointKind::Interpreter } else { EntrypointKind::Native }, None, vec!["Entry-point file only: arguments, host compatibility, protocol, model and lifecycle must be verified before launch.".into()]));
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
                    push(report, candidate(DiscoverySource::SelectedFolder, text_path(&path), None, vec![], EntrypointKind::Container, None, vec!["OCI bundle found. A container manager and verified container lifecycle are required; container paths are not host executables.".into()]));
                }
            }
        }
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
        assert!(revalidate(a).unwrap_err().contains("changed"));
        revalidate(b).unwrap();
    }

    #[test]
    fn cancellation_and_bounds_do_not_publish_silent_success() {
        assert_eq!(
            discover(None, &AtomicBool::new(true)).unwrap_err(),
            "runtime discovery cancelled"
        );
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
