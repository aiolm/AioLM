use aiolm_lib::{
    backends, config, deletable_model_path, delete_owned_snapshot, hardware, runtime, server,
    validate_launch_config,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
const HEADLESS_CREATION_FLAGS: u32 = 0x0000_0008 | 0x0000_0200 | 0x0800_0000;
const MAX_HEADLESS_LOG_BYTES: usize = 1024 * 1024;
const MAX_HEADLESS_LOG_LINE_BYTES: usize = 64 * 1024;
const INTERNAL_LOG_COLLECTOR: &str = "--internal-headless-log";
const MAX_HEADLESS_STATE_BYTES: u64 = 64 * 1024;
const STALE_LOCK_SECONDS: u64 = 15 * 60;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct HeadlessState {
    pid: u32,
    url: String,
    model: String,
    started_at: u64,
    #[serde(default)]
    executable: String,
    #[serde(default)]
    log_path: String,
    #[serde(default)]
    log_collector: Option<LogCollectorIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LogCollectorIdentity {
    pid: u32,
    executable: String,
}

// Until startup succeeds, failure must also stop the log collector. Once the
// server owns the pipe writers, EOF ends the collector even after this CLI exits.
struct PendingLogCollector(Option<std::process::Child>);

impl Drop for PendingLogCollector {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct CommandLock {
    path: PathBuf,
}

impl Drop for CommandLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn state_path() -> PathBuf {
    aiolm_lib::home::aiolm_home()
        .join("cli")
        .join("headless-state.json")
}

/// The current location, followed by where releases before the `.aiolm` data
/// folder kept the state. A server such a release started keeps running
/// across the upgrade and must still be found, reported and stopped.
fn state_paths() -> Vec<PathBuf> {
    let previous = env::var_os("LOCALAPPDATA").map(|root| {
        PathBuf::from(root)
            .join("aiolm")
            .join("headless-state.json")
    });
    std::iter::once(state_path()).chain(previous).collect()
}

fn read_state() -> Result<Option<HeadlessState>, String> {
    read_first_state(&state_paths())
}

fn read_first_state(paths: &[PathBuf]) -> Result<Option<HeadlessState>, String> {
    for path in paths {
        if let Some(state) = read_state_at(path)? {
            return Ok(Some(state));
        }
    }
    Ok(None)
}

fn read_state_at(path: &Path) -> Result<Option<HeadlessState>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "cannot inspect headless state {}: {error}",
                path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "headless state is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_HEADLESS_STATE_BYTES {
        return Err(format!(
            "headless state exceeds {MAX_HEADLESS_STATE_BYTES} bytes"
        ));
    }
    let file = fs::File::open(path)
        .map_err(|error| format!("cannot read headless state {}: {error}", path.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_HEADLESS_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read headless state {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_HEADLESS_STATE_BYTES {
        return Err(format!(
            "headless state exceeds {MAX_HEADLESS_STATE_BYTES} bytes"
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|error| format!("headless state is not UTF-8: {error}"))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("invalid headless state {}: {error}", path.display()))
}

fn write_state(state: &HeadlessState) -> Result<(), String> {
    let path = state_path();
    let parent = path
        .parent()
        .ok_or_else(|| "headless state has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    let tmp = path.with_file_name(format!(
        ".headless-state.{}.{}.part",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|error| format!("cannot create {}: {error}", tmp.display()))?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("cannot write {}: {error}", tmp.display()))?;
    drop(file);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "refusing to replace symlinked state {}",
                path.display()
            ));
        }
    }
    fs::rename(&tmp, &path).map_err(|error| format!("cannot activate {}: {error}", path.display()))
}

fn remove_state() {
    for path in state_paths() {
        let _ = fs::remove_file(path);
    }
}

fn log_path() -> PathBuf {
    state_path().with_file_name("headless-server.log")
}

fn acquire_command_lock() -> Result<CommandLock, String> {
    let path = state_path().with_extension("lock");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create lock directory: {error}"))?;
    }
    let create = || {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
    };
    match create() {
        Ok(mut file) => {
            let _ = writeln!(file, "{}", std::process::id());
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let stale = fs::read_to_string(&path)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
                .map(|pid| !process_is_alive(pid))
                .unwrap_or_else(|| {
                    fs::metadata(&path)
                        .ok()
                        .and_then(|metadata| metadata.modified().ok())
                        .and_then(|modified| modified.elapsed().ok())
                        .map(|age| age.as_secs() > STALE_LOCK_SECONDS)
                        .unwrap_or(false)
                });
            if !stale {
                return Err(format!(
                    "another headless command is already running: {error}"
                ));
            }
            fs::remove_file(&path).map_err(|remove_error| {
                format!("cannot recover stale headless lock: {remove_error}")
            })?;
            let mut file = create().map_err(|retry_error| {
                format!("another headless command is already running: {retry_error}")
            })?;
            let _ = writeln!(file, "{}", std::process::id());
        }
        Err(error) => return Err(format!("cannot create headless lock: {error}")),
    }
    Ok(CommandLock { path })
}

fn configured_server_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

fn validate_loopback_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| "headless state URL is invalid".to_string())?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || parsed.path() != "/v1"
    {
        return Err("headless state URL must be an http loopback /v1 endpoint".into());
    }
    Ok(())
}

fn validate_state_url(url: &str, port: u16) -> Result<(), String> {
    validate_loopback_url(url)?;
    if url == configured_server_url(port) {
        Ok(())
    } else {
        Err("headless state URL is not the configured loopback endpoint".into())
    }
}

fn sensitive_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase().replace(['-', ' '], "_");
    [
        "api_key",
        "authorization",
        "connection_string",
        "credential",
        "password",
        "private_key",
        "secret",
        "token",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn sensitive_flag(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    [
        "--api-key",
        "--authorization",
        "--password",
        "--private-key",
        "--secret",
        "--token",
    ]
    .iter()
    .any(|needle| normalized == *needle || normalized.starts_with(&format!("{needle}=")))
}

fn redact_json(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            for (key, value) in &mut object {
                if sensitive_name(key) {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    *value = redact_json(std::mem::take(value));
                }
            }
            Value::Object(object)
        }
        Value::Array(mut items) => {
            let mut redact_next = false;
            for item in &mut items {
                if redact_next {
                    *item = Value::String("[REDACTED]".into());
                    redact_next = false;
                    continue;
                }
                if let Value::String(text) = item {
                    if sensitive_flag(text) && text.contains('=') {
                        let flag_end = text.find('=').unwrap_or(text.len());
                        *item = Value::String(format!("{}=[REDACTED]", &text[..flag_end]));
                        redact_next = false;
                    } else {
                        redact_next = sensitive_flag(text);
                    }
                } else {
                    *item = redact_json(std::mem::take(item));
                }
            }
            Value::Array(items)
        }
        other => other,
    }
}

fn bounded_log_bytes(existing: &[u8], incoming: &[u8]) -> Vec<u8> {
    let mut combined = Vec::with_capacity(existing.len().saturating_add(incoming.len()));
    combined.extend_from_slice(existing);
    combined.extend_from_slice(incoming);
    if combined.len() > MAX_HEADLESS_LOG_BYTES {
        combined.split_off(combined.len() - MAX_HEADLESS_LOG_BYTES)
    } else {
        combined
    }
}

fn read_bounded_log(path: &Path) -> std::io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "headless log is not a regular file",
        ));
    }
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    if length > MAX_HEADLESS_LOG_BYTES as u64 {
        file.seek(SeekFrom::End(-(MAX_HEADLESS_LOG_BYTES as i64)))?;
    }
    let mut content = Vec::with_capacity(length.min(MAX_HEADLESS_LOG_BYTES as u64) as usize);
    file.take(MAX_HEADLESS_LOG_BYTES as u64)
        .read_to_end(&mut content)?;
    Ok(content)
}

fn redact_log_text(text: &str) -> String {
    let mut output = text.to_string();
    for marker in [
        "--api-key ",
        "--authorization ",
        "--password ",
        "--secret ",
        "--token ",
        "--api-key=",
        "--authorization=",
        "--password=",
        "--secret=",
        "--token=",
        "api_key=",
        "authorization=",
        "password=",
        "secret=",
        "token=",
    ] {
        let mut cursor = 0;
        while let Some(relative) = output[cursor..].find(marker) {
            let start = cursor + relative + marker.len();
            let end = output[start..]
                .find(char::is_whitespace)
                .map(|offset| start + offset)
                .unwrap_or(output.len());
            output.replace_range(start..end, "[REDACTED]");
            cursor = start + "[REDACTED]".len();
        }
    }
    output
}

fn append_log_chunk(path: &Path, chunk: &[u8]) -> std::io::Result<()> {
    let existing = match read_bounded_log(path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error),
    };
    let redacted = redact_log_text(&String::from_utf8_lossy(chunk));
    let retained = bounded_log_bytes(&existing, redacted.as_bytes());
    fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?
        .write_all(&retained)
}

fn collect_headless_log(mut reader: impl Read, path: &Path) -> std::io::Result<()> {
    let mut buffer = [0_u8; 8192];
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let size = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        let mut completed = Vec::new();
        for &byte in &buffer[..size] {
            if byte == b'\n' {
                if oversized {
                    completed.extend_from_slice(b"[oversized headless log line omitted]\n");
                } else {
                    completed.extend_from_slice(&line);
                    completed.push(b'\n');
                }
                line.clear();
                oversized = false;
            } else if !oversized {
                if line.len() == MAX_HEADLESS_LOG_LINE_BYTES {
                    line.clear();
                    oversized = true;
                } else {
                    line.push(byte);
                }
            }
        }
        if size == 0 {
            if oversized {
                completed.extend_from_slice(b"[oversized headless log line omitted]\n");
            } else {
                completed.extend_from_slice(&line);
            }
        }
        // Redact complete logical lines so a secret split across pipe reads
        // cannot escape filtering. Oversized lines never accumulate unboundedly.
        if !completed.is_empty() {
            // A full disk or temporarily unavailable log must not close the
            // server's pipe. Keep draining and retry on subsequent output.
            let _ = append_log_chunk(path, &completed);
        }
        if size == 0 {
            return Ok(());
        }
    }
}

fn spawn_log_collector() -> Result<(PendingLogCollector, LogCollectorIdentity, Stdio, Stdio), String>
{
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let (reader, writer) = std::io::pipe().map_err(|error| error.to_string())?;
    let stderr = writer.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(&executable);
    command
        .arg(INTERNAL_LOG_COLLECTOR)
        .env_clear()
        .envs(runtime::child_environment())
        .env("AIOLM_HOME", aiolm_lib::home::resolve_aiolm_home()?)
        .stdin(reader)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(HEADLESS_CREATION_FLAGS);
    let child = command
        .spawn()
        .map_err(|error| format!("failed to start headless log collector: {error}"))?;
    let identity = LogCollectorIdentity {
        pid: child.id(),
        executable: executable.to_string_lossy().into_owned(),
    };
    Ok((
        PendingLogCollector(Some(child)),
        identity,
        writer.into(),
        stderr.into(),
    ))
}

fn process_is_llama_server(pid: u32) -> bool {
    process_image_path(pid)
        .and_then(|path| path.file_name().map(|name| name.to_owned()))
        .is_some_and(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .contains("llama-server")
        })
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) }; // SYNCHRONIZE
        if handle.is_null() {
            return false;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == 258 } // WAIT_TIMEOUT
    }
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        if pid <= 0 {
            return false;
        }
        // Signal 0 checks existence without signaling the process. EPERM also
        // means a process exists, but the caller has no right to signal it.
        (unsafe { libc::kill(pid, 0) == 0 })
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(windows)]
fn process_image_path(pid: u32) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // WMI process queries are not available under every restricted Windows token.
    // QueryFullProcessImageNameW only needs the limited process information right.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        let success = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length);
        let _ = CloseHandle(handle);
        if success == 0 || length == 0 {
            return None;
        }
        Some(PathBuf::from(OsString::from_wide(
            &buffer[..length as usize],
        )))
    }
}

#[cfg(target_os = "linux")]
fn process_image_path(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn process_image_path(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;

    let pid = libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0)?;
    let mut buffer = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: proc_pidpath receives a writable buffer of the documented maximum
    // size. The returned path is preserved as OS bytes, including non-UTF8 names.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 || length as usize >= buffer.len() {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(std::ffi::OsString::from_vec(buffer)))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn process_image_path(_pid: u32) -> Option<PathBuf> {
    None
}

fn process_matches_executable(pid: u32, executable: &Path) -> bool {
    let expected = executable
        .canonicalize()
        .unwrap_or_else(|_| executable.to_path_buf());
    #[cfg(windows)]
    {
        let Some(actual) = process_image_path(pid) else {
            return false;
        };
        let actual = actual.canonicalize().unwrap_or(actual);
        actual
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        process_image_path(pid)
            .and_then(|path| path.canonicalize().ok())
            .map(|path| path == expected)
            .unwrap_or(false)
    }
}

fn state_process_is_managed(state: &HeadlessState) -> bool {
    !state.executable.trim().is_empty()
        && process_matches_executable(state.pid, Path::new(&state.executable))
}

fn terminate_pid(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        // taskkill writes success messages to stdout. Suppress them so stop and
        // restart retain the CLI's single JSON response contract.
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("taskkill failed: {error}"))?;
        if !status.success() {
            return Err(format!("taskkill returned {status}"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // New headless servers own a process group; legacy servers may not.
        // Never signal the CLI's inherited group for an older saved record.
        let target = if unsafe { libc::getpgid(pid as libc::pid_t) } == pid as libc::pid_t {
            format!("-{pid}")
        } else {
            pid.to_string()
        };
        let status = Command::new("kill")
            .args(["-TERM", "--", &target])
            .status()
            .map_err(|error| format!("kill failed: {error}"))?;
        if !status.success() {
            return Err(format!("kill returned {status}"));
        }
        Ok(())
    }
}

async fn wait_for_process_exit(
    pid: u32,
    executable: &Path,
    limit: std::time::Duration,
) -> Result<(), String> {
    tokio::time::timeout(limit, async {
        while process_is_alive(pid) && process_matches_executable(pid, executable) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| {
        format!(
            "headless process {pid} did not exit within {} seconds; its state was retained",
            limit.as_secs_f64()
        )
    })
}

fn log_collector_is_alive(state: &HeadlessState) -> bool {
    state.log_collector.as_ref().is_some_and(|collector| {
        process_is_alive(collector.pid)
            && process_matches_executable(collector.pid, Path::new(&collector.executable))
    })
}

async fn wait_for_log_collector(state: &HeadlessState) -> Result<(), String> {
    if let Some(collector) = &state.log_collector {
        wait_for_process_exit(
            collector.pid,
            Path::new(&collector.executable),
            std::time::Duration::from_secs(10),
        )
        .await?;
    }
    Ok(())
}

fn health_url(url: &str) -> String {
    format!(
        "{}/health",
        url.trim_end_matches("/v1").trim_end_matches('/')
    )
}

async fn server_status() -> Result<Value, String> {
    let Some(state) = read_state()? else {
        return Ok(json!({"state":"stopped","managed":false}));
    };
    let cfg = config::load_result()?;
    if validate_state_url(&state.url, cfg.port).is_err() {
        if !log_collector_is_alive(&state) {
            remove_state();
        }
        return Ok(
            json!({"state":"crashed","managed":false,"error":"invalid headless state endpoint"}),
        );
    }
    let alive = state_process_is_managed(&state);
    let health = if alive {
        reqwest::Client::new()
            .get(health_url(&configured_server_url(cfg.port)))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    } else {
        false
    };
    if !alive && !log_collector_is_alive(&state) {
        remove_state();
    }
    Ok(json!({
        "state": if health { "running" } else if alive { "starting_or_unhealthy" } else { "crashed" },
        "managed": true,
        "pid": state.pid,
        "url": configured_server_url(cfg.port),
        "model": state.model,
        "engine": state.engine,
        "health": health,
        "started_at": state.started_at,
        "log_path": log_path(),
        "auth": "disabled in explicit headless mode",
    }))
}

async fn server_start_unlocked() -> Result<Value, String> {
    if let Some(existing) = read_state()? {
        if state_process_is_managed(&existing) {
            return Err(format!(
                "headless server is already running with pid {}",
                existing.pid
            ));
        }
        if process_is_alive(existing.pid) && process_is_llama_server(existing.pid) {
            return Err("an unmanaged llama-server process matches the headless state PID; refusing to replace it".into());
        }
        wait_for_log_collector(&existing).await?;
        remove_state();
    }
    let mut cfg = config::load_result()?;
    cfg.normalize();
    let resolved_gpu = validate_launch_config(&mut cfg).await?;
    if cfg.active_model.trim().is_empty() {
        return Err(
            "active_model is empty; select a compatible model file or snapshot first".into(),
        );
    }
    if !Path::new(&cfg.active_model).exists() {
        return Err(format!("active model does not exist: {}", cfg.active_model));
    }
    let bin = server::server_bin(&cfg)?;
    let provider = aiolm_lib::providers::provider_of(&cfg);
    let (args, environment) = if provider == aiolm_lib::providers::ProviderId::Llama {
        (
            server::build_args_with_gpu(&cfg, "", &resolved_gpu),
            runtime::child_environment_for_runtime(&cfg.active_backend, &cfg.active_build)?,
        )
    } else {
        let selected = aiolm_lib::providers::selected_python_runtime(&cfg)?;
        let engine = aiolm_lib::providers::launch::engine_command(&cfg, &selected, cfg.port, "")?;
        let mut environment = aiolm_lib::providers::python_env::engine_environment();
        environment.extend(engine.env);
        (engine.args, environment)
    };
    let engine_info = aiolm_lib::providers::execution::probed_info(&cfg).await?;
    let log_file_path = log_path();
    if let Some(parent) = log_file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create headless log directory: {error}"))?;
    }
    if fs::symlink_metadata(&log_file_path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err("headless log is not a regular file".into());
    }
    let log_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&log_file_path)
        .map_err(|error| {
            format!(
                "cannot open headless log {}: {error}",
                log_file_path.display()
            )
        })?;
    drop(log_file);
    let (mut collector, collector_identity, stdout, stderr) = spawn_log_collector()?;
    let child = {
        let mut command = Command::new(&bin);
        command.env_clear().envs(environment);
        #[cfg(windows)]
        command.creation_flags(HEADLESS_CREATION_FLAGS);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|error| format!("failed to spawn {}: {error}", provider.server()))?
        // Drop Command's copies of the pipe writers before waiting on the
        // server; only the server should keep the collector's input open.
    };
    let pid = child.id();
    let url = configured_server_url(cfg.port);
    let shared = Arc::new(Mutex::new(server::ServerState::new()));
    if let Ok(mut state) = shared.lock() {
        state.child = Some(child.into());
        state.url = url.clone();
        state.model = cfg.active_model.clone();
        state.lifecycle = server::Lifecycle::Starting;
        state.engine = Some(engine_info.clone());
    }
    let err = Arc::new(server::ErrBuf::default());
    if let Err(error) = server::wait_ready(
        Arc::clone(&shared),
        &url,
        "",
        server::SERVER_START_TIMEOUT_SECS,
        &err,
    )
    .await
    {
        if let Ok(mut state) = shared.lock() {
            server::kill(&mut state.child, Some(Arc::clone(&err)));
        }
        return Err(error);
    }
    if collector
        .0
        .as_mut()
        .expect("pending log collector")
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("headless log collector exited during server startup".into());
    }
    let state = HeadlessState {
        pid,
        url: url.clone(),
        model: cfg.active_model.clone(),
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
        executable: bin.clone(),
        log_path: log_file_path.to_string_lossy().into_owned(),
        log_collector: Some(collector_identity),
        engine: Some(serde_json::to_value(engine_info).map_err(|error| error.to_string())?),
    };
    if let Err(error) = write_state(&state) {
        let _ = terminate_pid(pid);
        return Err(error);
    }
    // Headless mode deliberately transfers ownership to its persisted state;
    // desktop and benchmark children retain their automatic teardown owner.
    if let Some(child) = shared
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .child
        .take()
    {
        drop(child.release());
    }
    // The server now owns the log pipe. EOF terminates this independent
    // collector, and persisted identity lets stop/restart wait for its drain.
    collector.0.take();
    Ok(json!({
        "state":"running",
        "pid":pid,
        "url":url,
        "model":cfg.active_model,
        "auth":"disabled in explicit headless mode",
        "state_file":state_path(),
        "log_path":log_file_path,
    }))
}

async fn server_start() -> Result<Value, String> {
    let _command_lock = acquire_command_lock()?;
    server_start_unlocked().await
}

async fn server_stop_unlocked() -> Result<Value, String> {
    let Some(state) = read_state()? else {
        return Ok(json!({"state":"stopped","managed":false}));
    };
    let cfg = config::load_result()?;
    validate_state_url(&state.url, cfg.port)?;
    if process_is_alive(state.pid) && !state_process_is_managed(&state) {
        return Err(
            "headless state does not identify the current process; refusing to stop it".into(),
        );
    }
    if state_process_is_managed(&state) {
        terminate_pid(state.pid)?;
        // Sending SIGTERM only requests shutdown. Keep the state and command
        // lock until the server exits so restart cannot race its bound port.
        wait_for_process_exit(
            state.pid,
            Path::new(&state.executable),
            std::time::Duration::from_secs(10),
        )
        .await?;
    }
    wait_for_log_collector(&state).await?;
    remove_state();
    Ok(json!({"state":"stopped","pid":state.pid,"model":state.model}))
}

async fn server_stop() -> Result<Value, String> {
    let _command_lock = acquire_command_lock()?;
    server_stop_unlocked().await
}

fn parse_value<T>(key: &str, value: &str) -> Result<T, String>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    value
        .parse::<T>()
        .map_err(|error| format!("invalid value for {key}: {error}"))
}

fn apply_config_override(
    cfg: &mut config::AppConfig,
    key: &str,
    value: &str,
) -> Result<(), String> {
    if matches!(
        key.to_ascii_lowercase().as_str(),
        "api_key" | "token" | "password" | "secret" | "credential" | "connection_string"
    ) {
        return Err(format!(
            "config field {key} is credential-like and cannot be set by the CLI"
        ));
    }
    match key {
        "models_dir" => cfg.models_dir = value.into(),
        "active_model" => cfg.active_model = value.into(),
        "active_backend" => cfg.active_backend = value.into(),
        "active_build" => cfg.active_build = value.into(),
        "mmproj" => cfg.mmproj = value.into(),
        "flash_attn" => cfg.flash_attn = value.into(),
        "spec_type" => cfg.spec_type = value.into(),
        "spec_draft_ngl" => cfg.spec_draft_ngl = value.into(),
        "spec_draft_device" => cfg.spec_draft_device = value.into(),
        "spec_draft_model" => cfg.spec_draft_model = value.into(),
        "reasoning" => cfg.reasoning = value.into(),
        "reasoning_format" => cfg.reasoning_format = value.into(),
        "reasoning_effort" => cfg.reasoning_effort = value.into(),
        "reasoning_budget_message" => cfg.reasoning_budget_message = value.into(),
        "reasoning_preserve" => cfg.reasoning_preserve = value.into(),
        "port" => cfg.port = parse_value(key, value)?,
        "ngl" => cfg.ngl = parse_value(key, value)?,
        "ctx_size" => cfg.ctx_size = parse_value(key, value)?,
        "batch_size" => cfg.batch_size = parse_value(key, value)?,
        "ubatch_size" => cfg.ubatch_size = parse_value(key, value)?,
        "keep" => cfg.keep = parse_value(key, value)?,
        "cache_type_k" => cfg.cache_type_k = value.into(),
        "cache_type_v" => cfg.cache_type_v = value.into(),
        "n_cpu_moe" => cfg.n_cpu_moe = parse_value(key, value)?,
        "threads" => cfg.threads = parse_value(key, value)?,
        "top_k" => cfg.top_k = parse_value(key, value)?,
        "spec_draft_n_max" => cfg.spec_draft_n_max = parse_value(key, value)?,
        "spec_draft_n_min" => cfg.spec_draft_n_min = parse_value(key, value)?,
        "iters" => cfg.iters = parse_value(key, value)?,
        "parallel" => cfg.parallel = parse_value(key, value)?,
        "request_timeout_seconds" => cfg.request_timeout_seconds = parse_value(key, value)?,
        "temperature" => cfg.temperature = parse_value(key, value)?,
        "top_p" => cfg.top_p = parse_value(key, value)?,
        "spec_draft_p_min" => cfg.spec_draft_p_min = parse_value(key, value)?,
        "spec_draft_p_split" => cfg.spec_draft_p_split = parse_value(key, value)?,
        "reasoning_budget" => cfg.reasoning_budget = parse_value(key, value)?,
        "sleep_idle_seconds" => cfg.sleep_idle_seconds = parse_value(key, value)?,
        "server_args" => {
            cfg.server_args = serde_json::from_str(value)
                .map_err(|error| format!("server_args must be a JSON string array: {error}"))?;
        }
        "chat_options" => {
            cfg.chat_options = serde_json::from_str(value)
                .map_err(|error| format!("chat_options must be a JSON object: {error}"))?;
        }
        "lora_adapters" => {
            cfg.lora_adapters = serde_json::from_str(value)
                .map_err(|error| format!("lora_adapters must be a JSON array: {error}"))?;
        }
        "provider_options" => cfg.provider_options = parse_provider_options(value)?,
        _ => return Err(format!("unsupported config field: {key}")),
    }
    cfg.runtime_defaults.retain(|field| field != key);
    cfg.normalize();
    cfg.validate()
}

fn config_value() -> Result<Value, String> {
    let cfg = config::load_result()?;
    serde_json::to_value(cfg)
        .map(redact_json)
        .map_err(|error| format!("cannot serialize config: {error}"))
}

/// `provider_options` replaces the whole provider-keyed map. Each provider's
/// options must pass the shared schema and binding validation before anything
/// is saved. That validation reads no engine or file, so options for an engine
/// this host cannot run stay editable.
fn parse_provider_options(
    value: &str,
) -> Result<std::collections::BTreeMap<String, serde_json::Map<String, Value>>, String> {
    use aiolm_lib::providers::ProviderId;
    let options: std::collections::BTreeMap<String, serde_json::Map<String, Value>> =
        serde_json::from_str(value).map_err(|error| {
            format!("provider_options must be a JSON object of provider option objects: {error}")
        })?;
    for (key, values) in &options {
        let provider = ProviderId::parse(key)
            .filter(|provider| provider.is_python() && provider.as_str() == key)
            .ok_or_else(|| format!("provider options cannot be saved for '{key}'"))?;
        let issues = aiolm_lib::providers::launch::option_issues(provider, values);
        if !issues.is_empty() {
            let messages = issues
                .iter()
                .map(|issue| issue.message.as_str())
                .collect::<Vec<_>>();
            return Err(format!("invalid {key} options: {}", messages.join("; ")));
        }
    }
    Ok(options)
}

fn config_set_value(key: &str, value: &str) -> Result<Value, String> {
    let _command_lock = acquire_command_lock()?;
    let mut cfg = config::load_result()?;
    apply_config_override(&mut cfg, key, value).map_err(|error| {
        if matches!(key, "active_backend" | "active_build") {
            format!("{error}; use runtime select <backend> <build> to change the pair together")
        } else {
            error
        }
    })?;
    let saved = config::save(&cfg)?;
    Ok(json!({
        "ok": true,
        "changed": key,
        "config": redact_json(serde_json::to_value(saved).map_err(|error| error.to_string())?),
    }))
}

fn runtime_select_value(backend: &str, build: &str) -> Result<Value, String> {
    let provider =
        aiolm_lib::providers::ProviderId::parse(backend).filter(|provider| provider.is_python());
    if provider.is_none() {
        runtime::validate_runtime_identifiers(backend, build)?;
    }
    let _command_lock = acquire_command_lock()?;
    let mut cfg = config::load_result()?;
    // First-time selection must validate and save both fields as one change.
    if let Some(provider) = provider {
        cfg.active_provider = provider.as_str().into();
        cfg.active_runtime = build.into();
        aiolm_lib::providers::selected_python_runtime(&cfg)?;
    } else {
        cfg.active_provider = "llama.cpp".into();
        cfg.active_runtime.clear();
        cfg.active_backend = backend.into();
        cfg.active_build = build.into();
    }
    cfg.normalize();
    cfg.validate()?;
    let saved = config::save(&cfg)?;
    Ok(json!({
        "ok": true,
        "config": redact_json(serde_json::to_value(saved).map_err(|error| error.to_string())?),
    }))
}

fn delete_model_value(path: &str) -> Result<Value, String> {
    let _command_lock = acquire_command_lock()?;
    let cfg = config::load_result()?;
    let root = Path::new(&cfg.models_dir);
    let requested = Path::new(path);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    if candidate.is_dir() {
        // The running server's draft, embedding and LoRA bindings were fixed
        // when it started and may differ from the saved configuration now.
        if read_state()?.is_some_and(|state| state_process_is_managed(&state)) {
            return Err("stop the headless server before deleting a snapshot".into());
        }
        let deleted = delete_owned_snapshot(&cfg, &candidate)?;
        let preserved = deleted.exists();
        return Ok(
            json!({"ok":true,"deleted":deleted,"kind":"snapshot","unlisted_files_preserved":preserved,"models_dir":root}),
        );
    }
    if read_state()?.is_some_and(|state| {
        state_process_is_managed(&state)
            && fs::canonicalize(&state.model)
                .ok()
                .zip(fs::canonicalize(&candidate).ok())
                .is_some_and(|(model, candidate)| model == candidate)
    }) {
        return Err("stop the headless server before deleting the model it is using".into());
    }
    let safe = deletable_model_path(
        root,
        &candidate,
        &cfg.active_model,
        &cfg.mmproj,
        &cfg.spec_draft_model,
    )?;
    if cfg.lora_adapters.iter().any(|adapter| {
        adapter.enabled
            && fs::canonicalize(&adapter.path)
                .ok()
                .is_some_and(|adapter_path| adapter_path == safe)
    }) {
        return Err("select another configuration before deleting an enabled LoRA adapter".into());
    }
    fs::remove_file(&safe).map_err(|error| format!("cannot delete {}: {error}", safe.display()))?;
    Ok(json!({"ok":true,"deleted":safe,"models_dir":root}))
}

async fn runtime_probe_value(backend: &str, build: &str) -> Result<Value, String> {
    if let Some(provider) =
        aiolm_lib::providers::ProviderId::parse(backend).filter(|provider| provider.is_python())
    {
        return serde_json::to_value(
            aiolm_lib::providers::python_env::reprobe(provider, build).await?,
        )
        .map_err(|error| error.to_string());
    }
    let capabilities = runtime::probe(backend, build).await?;
    serde_json::to_value(capabilities)
        .map_err(|error| format!("cannot serialize runtime probe: {error}"))
}

fn server_logs_value(lines: usize) -> Result<Value, String> {
    let path = log_path();
    let content = match read_bounded_log(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "cannot read headless log {}: {error}",
                path.display()
            ))
        }
    };
    let mut selected = content
        .lines()
        .rev()
        .take(lines)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    selected.reverse();
    let count = selected.len();
    Ok(json!({"log_path":path,"lines":selected,"count":count}))
}

fn models_value() -> Result<Value, String> {
    let cfg = config::load_result()?;
    let catalog = aiolm_lib::scan_model_catalog(
        &cfg.models_dir,
        &std::sync::atomic::AtomicBool::new(false),
        Some((
            aiolm_lib::providers::provider_of(&cfg),
            aiolm_lib::providers::runtime_id_of(&cfg),
        )),
    )?;
    Ok(
        json!({ "models": catalog.models.into_iter().map(|model| json!({ "name":model.artifact.name, "path":model.artifact.path, "size_mb":model.artifact.size_bytes as f64 / 1048576.0,
        "is_vision":model.artifact.role == aiolm_lib::providers::artifacts::ArtifactRole::Projector, "artifact":model.artifact, "compatibility":model.compatibility, "shards":model.shards })).collect::<Vec<_>>(), "truncated":catalog.truncated }),
    )
}

fn device_value() -> Result<Value, String> {
    let profile = hardware::detect();
    let recommended = backends::recommend(&profile);
    serde_json::to_value(serde_json::json!({ "profile": profile, "backends": recommended }))
        .map_err(|error| format!("cannot serialize device profile: {error}"))
}

fn runtimes_value() -> Result<Value, String> {
    serde_json::to_value(aiolm_lib::providers::list_runtime_instances())
        .map_err(|error| format!("cannot serialize runtime list: {error}"))
}

async fn doctor_value() -> Value {
    use aiolm_lib::providers::{provider_of, runtime_id_of, ProviderId};
    let cfg = config::load_result().ok();
    let provider = cfg.as_ref().map(provider_of);
    let runtime = match &cfg {
        Some(cfg) if provider_of(cfg).is_python() => Some(
            match aiolm_lib::providers::refresh_selected_python_runtime(cfg, None).await {
                Ok(_) => server::server_bin(cfg),
                Err(error) => Err(error),
            },
        ),
        Some(cfg) => Some(server::server_bin(cfg)),
        None => None,
    };
    let runtimes = aiolm_lib::providers::list_runtime_instances();
    let counts = ProviderId::ALL
        .into_iter()
        .map(|provider| {
            let count = runtimes
                .iter()
                .filter(|runtime| runtime.provider == provider)
                .count();
            (provider.as_str().to_owned(), json!(count))
        })
        .collect::<serde_json::Map<_, _>>();
    json!({
        "config_loaded": cfg.is_some(),
        "provider": provider,
        "server": provider.map(ProviderId::server),
        "runtime": cfg.as_ref().map(runtime_id_of),
        "server_executable": runtime.as_ref().and_then(|value| value.as_ref().ok()),
        "runtime_ready": runtime.as_ref().is_some_and(Result::is_ok),
        "readiness_source": if provider.is_some_and(ProviderId::is_python) { "live-python-probe" } else { "executable-presence" },
        "runtime_problem": runtime.and_then(Result::err),
        "runtime_count": runtimes.len(),
        "runtime_counts": counts,
        "state_file": state_path(),
        "credentials": "not persisted or emitted by this CLI",
    })
}

fn help_value() -> Value {
    json!({
        "usage":"aiolm-cli <config|models|runtime|server|doctor> [subcommand]",
        "commands":{
            "config get":"print persisted configuration",
            "config set <field> <value>":"change a non-secret typed configuration field",
            "config set provider_options <json>":"replace the vllm/mlx-vlm option map; every value must pass the engine option schema",
            "models list":"scan model files and snapshots with engine compatibility",
            "models delete <path>":"delete a non-active GGUF/mmproj file, or an app-downloaded snapshot folder (only the files its manifest lists; other files stay)",
            "runtime list":"list native and Python engine installations",
            "runtime select <vllm|mlx-vlm> <id>":"select an installed Python engine runtime",
            "runtime register <vllm|mlx-vlm> <python>":"probe and register an existing engine environment",
            "runtime install <vllm|mlx-vlm> [python]":"install the pinned engine in an isolated environment; Ctrl-C cancels and removes the partial environment",
            "runtime remove <vllm|mlx-vlm> <id>":"remove an environment; external Python files are preserved",
            "runtime export <vllm|mlx-vlm> <id> <zip>":"export exact package wheels for offline import on a compatible OS, architecture and Python ABI; destination must be new",
            "runtime import <zip>":"verify a portable Python runtime bundle and recreate a new isolated environment offline; Ctrl-C cancels and cleans up",
            "runtime device":"detect local GPUs and recommended backends",
            "runtime probe <backend> <build>":"run version/help/device/bench preflight",
            "runtime probe <vllm|mlx-vlm> <id>":"re-probe a registered Python engine environment",
            "runtime select <backend> <build>":"save the configured runtime backend and build together",
            "server start":"start the selected provider's server with the active model, without API-key persistence",
            "server status":"read managed process and /health state",
            "server stop|unload":"stop the managed server process tree",
            "server restart":"stop and start the managed server",
            "server logs [lines]":"read the bounded headless server log tail",
            "doctor":"print machine-readable diagnostics for the selected provider and runtime"
        },
        "safety":"headless start intentionally disables API-key auth; use only on a trusted machine/local bind",
    })
}

#[derive(Debug, PartialEq, Eq)]
enum CliCommand {
    Help,
    ConfigGet,
    ConfigSet {
        key: String,
        value: String,
    },
    ModelsList,
    ModelsDelete {
        path: String,
    },
    RuntimesList,
    DeviceProfile,
    RuntimeProbe {
        backend: String,
        build: String,
    },
    RuntimeSelect {
        backend: String,
        build: String,
    },
    RuntimeRegister {
        provider: String,
        python: String,
    },
    RuntimeInstall {
        provider: String,
        python: Option<String>,
    },
    RuntimeRemove {
        provider: String,
        runtime: String,
    },
    RuntimeExport {
        provider: String,
        runtime: String,
        path: String,
    },
    RuntimeImport {
        path: String,
    },
    Doctor,
    ServerStart,
    ServerStatus,
    ServerStop,
    ServerRestart,
    ServerLogs {
        lines: usize,
    },
}

fn parse_command(args: &[String]) -> Result<CliCommand, String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Ok(CliCommand::Help);
    };
    if matches!(command, "--help" | "-h") {
        return Ok(CliCommand::Help);
    }
    match command {
        "config" => match args.get(1).map(String::as_str) {
            Some("get") if args.len() == 2 => Ok(CliCommand::ConfigGet),
            Some("set") if args.len() >= 4 => Ok(CliCommand::ConfigSet {
                key: args[2].clone(),
                value: args[3..].join(" "),
            }),
            Some("set") => Err("usage: config set <field> <value>".into()),
            _ => Err("usage: config get|set <field> <value>".into()),
        },
        "models" => match args.get(1).map(String::as_str) {
            Some("list") if args.len() == 2 => Ok(CliCommand::ModelsList),
            Some("delete") if args.len() == 3 => Ok(CliCommand::ModelsDelete {
                path: args[2].clone(),
            }),
            Some("delete") => Err("usage: models delete <path>".into()),
            _ => Err("usage: models list|delete <path>".into()),
        },
        "runtime" | "runtimes" => match args.get(1).map(String::as_str) {
            Some("list") if args.len() == 2 => Ok(CliCommand::RuntimesList),
            Some("register") if args.len() == 4 => Ok(CliCommand::RuntimeRegister { provider: args[2].clone(), python: args[3].clone() }),
            Some("install") if (3..=4).contains(&args.len()) => Ok(CliCommand::RuntimeInstall { provider: args[2].clone(), python: args.get(3).cloned() }),
            Some("remove") if args.len() == 4 => Ok(CliCommand::RuntimeRemove { provider: args[2].clone(), runtime: args[3].clone() }),
            Some("export") if args.len() == 5 => Ok(CliCommand::RuntimeExport { provider: args[2].clone(), runtime: args[3].clone(), path: args[4].clone() }),
            Some("import") if args.len() == 3 => Ok(CliCommand::RuntimeImport { path: args[2].clone() }),
            Some("export") => Err("usage: runtime export <vllm|mlx-vlm> <id> <zip>".into()),
            Some("import") => Err("usage: runtime import <zip>".into()),
            Some("probe") if args.len() == 4 => Ok(CliCommand::RuntimeProbe {
                backend: args[2].clone(),
                build: args[3].clone(),
            }),
            Some("probe") => Err("usage: runtime probe <backend> <build>".into()),
            Some("select") if args.len() == 4 => Ok(CliCommand::RuntimeSelect {
                backend: args[2].clone(),
                build: args[3].clone(),
            }),
            Some("select") => Err("usage: runtime select <backend> <build>".into()),
            Some("device") => Ok(CliCommand::DeviceProfile),
            Some("register" | "install" | "remove") => Err("usage: runtime register <vllm|mlx-vlm> <python> | install <vllm|mlx-vlm> [python] | remove <vllm|mlx-vlm> <id>".into()),
            _ => Err("usage: runtime list|probe|select <backend> <build>|register|install|remove|export|import|device".into()),
        },
        "doctor" if args.len() == 1 => Ok(CliCommand::Doctor),
        "server" => match args.get(1).map(String::as_str) {
            Some("start") if args.len() == 2 => Ok(CliCommand::ServerStart),
            Some("status") if args.len() == 2 => Ok(CliCommand::ServerStatus),
            Some("stop" | "unload") if args.len() == 2 => Ok(CliCommand::ServerStop),
            Some("restart") if args.len() == 2 => Ok(CliCommand::ServerRestart),
            Some("logs") if args.len() == 2 => Ok(CliCommand::ServerLogs { lines: 100 }),
            Some("logs") if args.len() == 3 => Ok(CliCommand::ServerLogs {
                lines: args[2]
                    .parse::<usize>()
                    .map_err(|error| format!("invalid log line count: {error}"))?
                    .clamp(1, 1_000),
            }),
            Some("logs") => Err("usage: server logs [lines]".into()),
            _ => Err("usage: server start|status|stop|unload|restart|logs [lines]".into()),
        },
        _ => Err(format!("unknown command: {command}")),
    }
}

async fn run(args: &[String]) -> Result<Value, String> {
    match parse_command(args)? {
        CliCommand::Help => Ok(help_value()),
        CliCommand::ConfigGet => config_value(),
        CliCommand::ConfigSet { key, value } => config_set_value(&key, &value),
        CliCommand::ModelsList => models_value(),
        CliCommand::ModelsDelete { path } => delete_model_value(&path),
        CliCommand::RuntimesList => runtimes_value(),
        CliCommand::DeviceProfile => device_value(),
        CliCommand::RuntimeProbe { backend, build } => runtime_probe_value(&backend, &build).await,
        CliCommand::RuntimeSelect { backend, build } => runtime_select_value(&backend, &build),
        CliCommand::RuntimeRegister { provider, python } => {
            let provider = aiolm_lib::providers::ProviderId::parse(&provider)
                .filter(|provider| provider.is_python())
                .ok_or("select vllm or mlx-vlm")?;
            let _lock = acquire_command_lock()?;
            serde_json::to_value(
                aiolm_lib::providers::python_env::register_external(provider, Path::new(&python))
                    .await?,
            )
            .map_err(|error| error.to_string())
        }
        CliCommand::RuntimeInstall { provider, python } => {
            let provider = aiolm_lib::providers::ProviderId::parse(&provider)
                .filter(|provider| provider.is_python())
                .ok_or("select vllm or mlx-vlm")?;
            let _lock = acquire_command_lock()?;
            let cancel = Arc::new(AtomicBool::new(false));
            let install = aiolm_lib::providers::python_env::install_managed(
                provider,
                python.map(PathBuf::from),
                None,
                cancel.clone(),
                |progress| eprintln!("{}", progress.line),
            );
            serde_json::to_value(
                run_interruptible(install, tokio::signal::ctrl_c(), &cancel).await?,
            )
            .map_err(|error| error.to_string())
        }
        CliCommand::RuntimeRemove { provider, runtime } => {
            let provider = aiolm_lib::providers::ProviderId::parse(&provider)
                .filter(|provider| provider.is_python())
                .ok_or("select vllm or mlx-vlm")?;
            let _lock = acquire_command_lock()?;
            let cfg = config::load_result()?;
            if aiolm_lib::providers::provider_of(&cfg) == provider && cfg.active_runtime == runtime
            {
                return Err("select another runtime before removing this environment".into());
            }
            if read_state()?.is_some_and(|state| {
                state_process_is_managed(&state) && process_is_alive(state.pid)
            }) {
                return Err("stop the headless server before removing a runtime".into());
            }
            aiolm_lib::providers::python_env::remove(provider, &runtime)?;
            Ok(json!({"ok":true,"provider":provider,"runtime":runtime}))
        }
        CliCommand::RuntimeExport {
            provider,
            runtime,
            path,
        } => {
            let provider = aiolm_lib::providers::ProviderId::parse(&provider)
                .filter(|provider| provider.is_python())
                .ok_or("select vllm or mlx-vlm")?;
            let _lock = acquire_command_lock()?;
            ensure_portable_server_stopped()?;
            let destination = PathBuf::from(path);
            if destination.exists() {
                return Err("portable export destination already exists; choose a new file".into());
            }
            let cancel = Arc::new(AtomicBool::new(false));
            let export = aiolm_lib::providers::portable::export_bundle(
                provider,
                &runtime,
                &destination,
                cancel.clone(),
                |progress| eprintln!("{}", progress.line),
            );
            serde_json::to_value(run_interruptible(export, tokio::signal::ctrl_c(), &cancel).await?)
                .map_err(|error| error.to_string())
        }
        CliCommand::RuntimeImport { path } => {
            let _lock = acquire_command_lock()?;
            ensure_portable_server_stopped()?;
            let archive = PathBuf::from(path);
            let cancel = Arc::new(AtomicBool::new(false));
            let import = aiolm_lib::providers::portable::import_bundle(
                &archive,
                cancel.clone(),
                |progress| eprintln!("{}", progress.line),
            );
            serde_json::to_value(run_interruptible(import, tokio::signal::ctrl_c(), &cancel).await?)
                .map_err(|error| error.to_string())
        }
        CliCommand::Doctor => Ok(doctor_value().await),
        CliCommand::ServerStart => server_start().await,
        CliCommand::ServerStatus => server_status().await,
        CliCommand::ServerStop => server_stop().await,
        CliCommand::ServerRestart => {
            let _command_lock = acquire_command_lock()?;
            let _ = server_stop_unlocked().await?;
            server_start_unlocked().await
        }
        CliCommand::ServerLogs { lines } => server_logs_value(lines),
    }
}

fn ensure_portable_server_stopped() -> Result<(), String> {
    if read_state()?
        .is_some_and(|state| state_process_is_managed(&state) && process_is_alive(state.pid))
    {
        return Err("stop the headless server before importing or exporting a runtime".into());
    }
    Ok(())
}

/// Run `work` to completion. When `interrupt` (Ctrl-C) fires first, raise
/// `cancel` and keep waiting, so the work can stop its child processes and
/// remove what it staged before the CLI exits.
async fn run_interruptible<T>(
    work: impl std::future::Future<Output = Result<T, String>>,
    interrupt: impl std::future::Future<Output = std::io::Result<()>>,
    cancel: &AtomicBool,
) -> Result<T, String> {
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        Ok(()) = interrupt => {
            cancel.store(true, Ordering::Release);
            eprintln!("cancelling; waiting for the installer to stop and remove its staging folder");
            // Work that finished as the interrupt arrived is kept and reported.
            work.await.map_err(|error| format!("runtime installation cancelled: {error}"))
        }
    }
}

fn main() {
    #[cfg(windows)]
    if let Err(error) = isolate_standard_handles() {
        eprintln!("cannot isolate CLI standard streams: {error}");
        std::process::exit(1);
    }
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() == 1 && args[0] == INTERNAL_LOG_COLLECTOR {
        // The collector needs no GUI, keyring, migration or async runtime.
        // Its parent has already created the log directory/file.
        let result = aiolm_lib::home::resolve_aiolm_home()
            .map_err(std::io::Error::other)
            .and_then(|home| {
                collect_headless_log(
                    std::io::stdin().lock(),
                    &home.join("cli").join("headless-server.log"),
                )
            });
        if let Err(error) = result {
            eprintln!("headless log collector failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    tokio::runtime::Runtime::new()
        .expect("initialize CLI runtime")
        .block_on(run_cli(args));
}

#[cfg(windows)]
fn isolate_standard_handles() -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_DISK, FILE_TYPE_PIPE};

    // Rust Command redirects the child's standard streams, but Windows also
    // inherits every other inheritable handle. A detached server must not keep
    // this CLI's JSON output pipe open after the CLI itself has exited. Explicit
    // Stdio::inherit still works: Command makes its own inheritable duplicate.
    for handle in [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ] {
        let kind = unsafe { GetFileType(handle) };
        if matches!(kind, FILE_TYPE_DISK | FILE_TYPE_PIPE)
            && unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

async fn run_cli(args: Vec<String>) {
    if !args.is_empty() && args[0] != "--help" && args[0] != "-h" {
        if let Err(error) = aiolm_lib::branding::prepare_managed_data() {
            println!("{}", json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
    match run(&args).await {
        Ok(value) => println!(
            "{}",
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into())
        ),
        Err(error) => {
            println!("{}", json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn detached_child_does_not_retain_cli_output() {
        let path = env::temp_dir().join(format!("aiolm-stdio-{}.pid", uuid::Uuid::new_v4()));
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "tests::detached_stdio_fixture"])
            .env("AIOLM_STDIO_FIXTURE_PID", &path);
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let _ = send.send(command.output());
        });
        let result = receive.recv_timeout(std::time::Duration::from_secs(3));
        if let Ok(pid) = fs::read_to_string(&path) {
            let _ = terminate_pid(pid.trim().parse().unwrap());
        }
        let _ = fs::remove_file(path);
        reader.join().unwrap();
        assert!(result
            .expect("detached child retained CLI output")
            .unwrap()
            .status
            .success());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess fixture for detached CLI output"]
    fn detached_stdio_fixture() {
        let Some(path) = env::var_os("AIOLM_STDIO_FIXTURE_PID") else {
            return;
        };
        isolate_standard_handles().unwrap();
        let child = Command::new("cmd")
            .args(["/D", "/C", "ping -n 11 127.0.0.1 > nul"])
            .creation_flags(HEADLESS_CREATION_FLAGS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        fs::write(path, child.id().to_string()).unwrap();
        drop(child);
    }

    #[test]
    fn provider_options_round_trip_typed_vllm_and_mlx_maps() {
        // Paths need not exist and no engine is probed: settings for an engine
        // this host cannot run remain editable.
        let options = json!({
            "vllm": {
                "runner": "generate", "max_model_len": 32768, "gpu_memory_utilization": 0.85,
                "enable_prefix_caching": false, "limit_mm_per_prompt": {"image": 2},
                "enable_auto_tool_choice": true, "tool_call_parser": "hermes", "temperature": 0.7,
                "lora_adapters": [{"name": "style", "path": "/synthetic/adapters/style"}],
                "request_lora": "style", "max_lora_rank": 32,
                "extra_args": ["--disable-log-requests"], "trust_remote_code": false
            },
            "mlx-vlm": {
                "embedding_model": "/synthetic/models/embedder", "kv_bits": 4, "kv_quant_scheme": "uniform",
                "draft_model": "/synthetic/models/draft", "draft_kind": "mtp", "enable_thinking": true,
                "lora_adapters": [{"name": "solo", "path": "/synthetic/adapters/solo"}]
            }
        });
        let mut cfg = config::AppConfig::default();
        apply_config_override(&mut cfg, "provider_options", &options.to_string())
            .expect("schema-valid options should be accepted");
        let saved = serde_json::to_value(&cfg).unwrap();
        assert_eq!(saved["provider_options"], options);
        let reloaded: config::AppConfig = serde_json::from_value(saved).unwrap();
        assert_eq!(
            serde_json::to_value(&reloaded.provider_options).unwrap(),
            options
        );

        // An empty map clears every provider's options.
        apply_config_override(&mut cfg, "provider_options", "{}").unwrap();
        assert!(cfg.provider_options.is_empty());
    }

    #[test]
    fn provider_options_reject_invalid_maps_without_partial_changes() {
        let mut cfg = config::AppConfig::default();
        apply_config_override(
            &mut cfg,
            "provider_options",
            r#"{"vllm":{"max_num_seqs":8}}"#,
        )
        .unwrap();
        let before = serde_json::to_value(&cfg).unwrap();
        for (value, expected) in [
            ("{not json", "JSON object"),
            (r#"["vllm"]"#, "JSON object"),
            (r#"{"vllm":[1]}"#, "JSON object"),
            (r#"{"sglang":{}}"#, "cannot be saved for 'sglang'"),
            (
                r#"{"llama.cpp":{"ctx_size":4096}}"#,
                "cannot be saved for 'llama.cpp'",
            ),
            (r#"{" vllm":{}}"#, "cannot be saved for ' vllm'"),
            (
                r#"{"vllm":{"max_num_seqs":16},"mlx-vlm":{"no_such_option":1}}"#,
                "invalid mlx-vlm options",
            ),
            (r#"{"vllm":{"max_model_len":"long"}}"#, "integer"),
            (r#"{"vllm":{"gpu_memory_utilization":2}}"#, "between"),
            (r#"{"vllm":{"runner":"train"}}"#, "does not accept"),
            (
                r#"{"vllm":{"trust_remote_code":true}}"#,
                "trust_remote_code",
            ),
            (r#"{"vllm":{"extra_args":["--port=9000"]}}"#, "--port"),
            (
                r#"{"vllm":{"extra_args":["--max-model-len=4"]}}"#,
                "--max-model-len",
            ),
            (
                r#"{"vllm":{"draft_model":"/synthetic/draft"}}"#,
                "speculative_config",
            ),
            (
                r#"{"vllm":{"request_lora":"missing"}}"#,
                "configured adapter",
            ),
            (
                r#"{"vllm":{"enable_auto_tool_choice":true}}"#,
                "tool_call_parser",
            ),
            (
                r#"{"mlx-vlm":{"lora_adapters":[{"name":"a","path":"/x"},{"name":"b","path":"/y"}]}}"#,
                "one adapter",
            ),
            (
                r#"{"mlx-vlm":{"lora_adapters":[{"name":"bad name","path":"/x"}]}}"#,
                "adapter name",
            ),
        ] {
            let error = apply_config_override(&mut cfg, "provider_options", value).unwrap_err();
            assert!(error.contains(expected), "{value}: {error}");
            assert_eq!(
                serde_json::to_value(&cfg).unwrap(),
                before,
                "{value} changed the configuration"
            );
        }
    }

    #[test]
    fn config_set_accepts_safe_typed_fields() {
        let mut cfg = config::AppConfig::default();
        apply_config_override(&mut cfg, "ctx_size", "8192").expect("context should parse");
        apply_config_override(&mut cfg, "batch_size", "1024").expect("batch should parse");
        apply_config_override(&mut cfg, "ubatch_size", "256").expect("micro batch should parse");
        apply_config_override(&mut cfg, "keep", "64").expect("keep should parse");
        apply_config_override(&mut cfg, "cache_type_k", "q8_0")
            .expect("key cache type should parse");
        apply_config_override(&mut cfg, "cache_type_v", "q8_0")
            .expect("value cache type should parse");
        apply_config_override(&mut cfg, "active_model", "C:/models/model.gguf")
            .expect("model path should parse");
        apply_config_override(&mut cfg, "chat_options", r#"{"min_p":0.1}"#)
            .expect("chat JSON should parse");
        assert_eq!(cfg.ctx_size, 8192);
        assert_eq!(cfg.batch_size, 1024);
        assert_eq!(cfg.ubatch_size, 256);
        assert_eq!(cfg.keep, 64);
        assert_eq!(cfg.cache_type_k, "q8_0");
        assert_eq!(cfg.cache_type_v, "q8_0");
        assert_eq!(cfg.active_model, "C:/models/model.gguf");
        assert_eq!(
            cfg.chat_options.get("min_p").and_then(Value::as_f64),
            Some(0.1)
        );
    }

    #[test]
    fn config_set_rejects_credentials_and_invalid_values() {
        let mut cfg = config::AppConfig::default();
        assert!(apply_config_override(&mut cfg, "api_key", "secret").is_err());
        assert!(apply_config_override(&mut cfg, "ctx_size", "not-a-number").is_err());
        assert!(apply_config_override(&mut cfg, "unknown", "value").is_err());
    }

    #[test]
    fn parser_recognizes_mutating_and_diagnostic_commands() {
        let config = parse_command(
            &vec!["config", "set", "ctx_size", "8192"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        )
        .expect("config set should parse");
        assert_eq!(
            config,
            CliCommand::ConfigSet {
                key: "ctx_size".into(),
                value: "8192".into()
            }
        );
        assert_eq!(
            parse_command(
                &["server", "restart"]
                    .iter()
                    .map(|value| (*value).into())
                    .collect::<Vec<_>>()
            ),
            Ok(CliCommand::ServerRestart)
        );
        assert_eq!(
            parse_command(
                &["server", "logs", "20"]
                    .iter()
                    .map(|value| (*value).into())
                    .collect::<Vec<_>>()
            ),
            Ok(CliCommand::ServerLogs { lines: 20 })
        );
        assert!(parse_command(
            &["runtime", "probe", "vulkan"]
                .iter()
                .map(|value| (*value).into())
                .collect::<Vec<_>>()
        )
        .is_err());
    }

    #[test]
    fn parser_keeps_runtime_syntax_and_adds_python_engine_lifecycle() {
        let parse = |args: &[&str]| {
            parse_command(
                &args
                    .iter()
                    .map(|value| (*value).into())
                    .collect::<Vec<String>>(),
            )
        };
        assert_eq!(
            parse(&["runtime", "select", "cpu", "b1234"]),
            Ok(CliCommand::RuntimeSelect {
                backend: "cpu".into(),
                build: "b1234".into()
            })
        );
        assert_eq!(parse(&["runtimes", "list"]), Ok(CliCommand::RuntimesList));
        assert_eq!(
            parse(&[
                "runtime",
                "export",
                "vllm",
                "portable-1",
                "bundle with spaces.zip"
            ]),
            Ok(CliCommand::RuntimeExport {
                provider: "vllm".into(),
                runtime: "portable-1".into(),
                path: "bundle with spaces.zip".into()
            })
        );
        assert_eq!(
            parse(&["runtime", "import", "bundle with spaces.zip"]),
            Ok(CliCommand::RuntimeImport {
                path: "bundle with spaces.zip".into()
            })
        );
        assert!(parse(&["runtime", "export", "vllm", "portable-1"]).is_err());
        assert!(parse(&["runtime", "import"]).is_err());
        assert_eq!(
            parse(&["runtime", "install", "vllm"]),
            Ok(CliCommand::RuntimeInstall {
                provider: "vllm".into(),
                python: None
            })
        );
        assert_eq!(
            parse(&["runtime", "install", "mlx-vlm", "python3"]),
            Ok(CliCommand::RuntimeInstall {
                provider: "mlx-vlm".into(),
                python: Some("python3".into())
            })
        );
        assert_eq!(
            parse(&["runtime", "remove", "vllm", "managed-1"]),
            Ok(CliCommand::RuntimeRemove {
                provider: "vllm".into(),
                runtime: "managed-1".into()
            })
        );
        assert_eq!(
            parse(&["models", "delete", "hf/example/model"]),
            Ok(CliCommand::ModelsDelete {
                path: "hf/example/model".into()
            })
        );
        assert!(parse(&["runtime", "remove", "vllm"])
            .unwrap_err()
            .contains("remove <vllm|mlx-vlm> <id>"));
        assert!(parse(&["runtime", "install"]).is_err());
        let help = help_value();
        assert!(help["commands"]["models delete <path>"]
            .as_str()
            .unwrap()
            .contains("snapshot"));
        assert!(help["commands"]["runtime install <vllm|mlx-vlm> [python]"]
            .as_str()
            .unwrap()
            .contains("Ctrl-C"));
    }

    #[tokio::test]
    async fn interrupt_cancels_work_and_waits_for_its_cleanup() {
        let cancel = AtomicBool::new(false);
        let cleaned = AtomicBool::new(false);
        let work = async {
            while !cancel.load(Ordering::Acquire) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            cleaned.store(true, Ordering::Release);
            Err::<(), String>("staged environment removed".into())
        };
        let error = run_interruptible(work, async { Ok(()) }, &cancel)
            .await
            .unwrap_err();
        assert!(error.contains("cancelled") && error.contains("staged environment removed"));
        assert!(
            cleaned.load(Ordering::Acquire),
            "the CLI returns only after cleanup finished"
        );

        // Work that completed as the interrupt arrived is not reported as cancelled.
        let cancel = AtomicBool::new(false);
        let finished = async {
            while !cancel.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
            Ok::<_, String>(7)
        };
        assert_eq!(
            run_interruptible(finished, async { Ok(()) }, &cancel).await,
            Ok(7)
        );

        // A handler that cannot be installed does not cancel anything.
        let cancel = AtomicBool::new(false);
        let unavailable = async { Err(std::io::Error::other("no console")) };
        let slow = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok::<_, String>(1)
        };
        assert_eq!(run_interruptible(slow, unavailable, &cancel).await, Ok(1));
        assert!(!cancel.load(Ordering::Acquire));
    }

    #[test]
    fn headless_state_accepts_only_the_configured_loopback_url() {
        assert!(validate_state_url("http://127.0.0.1:8080/v1", 8080).is_ok());
        assert!(validate_state_url("http://localhost:8080/v1", 8080).is_err());
        assert!(validate_state_url("http://192.168.1.20:8080/v1", 8080).is_err());
        assert!(validate_state_url("http://127.0.0.1:8081/v1", 8080).is_err());
    }

    #[test]
    fn native_process_identity_matches_current_executable() {
        let executable = env::current_exe().expect("test executable should be discoverable");
        assert!(process_matches_executable(std::process::id(), &executable));
        assert!(process_is_alive(std::process::id()));
        assert!(!process_matches_executable(
            std::process::id(),
            &executable.with_file_name("different-synthetic-program")
        ));
    }

    #[test]
    fn invalid_process_ids_are_not_treated_as_headless_servers() {
        for pid in [0, u32::MAX] {
            assert!(!process_is_alive(pid));
            assert!(!process_is_llama_server(pid));
            assert!(process_image_path(pid).is_none());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_waits_for_sigterm_cleanup_before_reporting_exit() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        use tokio::time::{timeout, Duration};

        // The shell acknowledges SIGTERM but keeps its process alive until
        // stdin releases cleanup, just as a server can retain its socket.
        let mut child = tokio::process::Command::new("sh")
            .args([
                "-c",
                "trap 'read release; exit 0' TERM; printf 'ready\\n'; while :; do read input; done",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        timeout(Duration::from_secs(5), stdout.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready, "ready\n");
        let executable = process_image_path(pid).unwrap();

        terminate_pid(pid).unwrap();
        let error = wait_for_process_exit(pid, &executable, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(error.contains("state was retained"), "{error}");
        assert!(child.try_wait().unwrap().is_none());

        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"release\n")
            .await
            .unwrap();
        let (exited, reaped) = tokio::join!(
            wait_for_process_exit(pid, &executable, Duration::from_secs(5)),
            timeout(Duration::from_secs(5), child.wait()),
        );
        exited.unwrap();
        assert!(reaped.unwrap().unwrap().success());
    }

    #[test]
    fn config_json_redaction_covers_nested_values_and_sensitive_argv_pairs() {
        let value = json!({
            "chat_options": {"authorization": "secret-value", "temperature": 0.2},
            "server_args": ["--api-key", "secret-value", "--api-key=inline-secret", "--jinja"],
            "safe": "visible"
        });
        let redacted = redact_json(value);
        assert_eq!(redacted["chat_options"]["authorization"], "[REDACTED]");
        assert_eq!(redacted["server_args"][1], "[REDACTED]");
        assert_eq!(redacted["server_args"][2], "--api-key=[REDACTED]");
        assert_eq!(redacted["safe"], "visible");
    }

    #[test]
    fn config_set_rejects_nested_credentials_in_advanced_fields() {
        let mut cfg = config::AppConfig::default();
        assert!(
            apply_config_override(&mut cfg, "server_args", r#"["--api-key", "secret-value"]"#)
                .is_err()
        );
        assert!(apply_config_override(
            &mut cfg,
            "chat_options",
            r#"{"headers":{"authorization":"secret-value"}}"#
        )
        .is_err());
    }

    #[test]
    fn headless_log_retention_is_bounded_to_the_last_bytes() {
        let retained = bounded_log_bytes(b"old", &[b'x'; MAX_HEADLESS_LOG_BYTES + 3]);
        assert_eq!(retained.len(), MAX_HEADLESS_LOG_BYTES);
        assert!(retained.iter().all(|byte| *byte == b'x'));
    }

    #[test]
    fn a_server_started_before_the_data_folder_moved_is_still_found() {
        let root = env::temp_dir().join(format!("aiolm-cli-state-{}", uuid::Uuid::new_v4()));
        let current = root.join("home").join("cli").join("headless-state.json");
        let previous = root.join("Local").join("aiolm").join("headless-state.json");
        let state = |pid| HeadlessState {
            pid,
            url: "http://127.0.0.1:8080/v1".into(),
            model: "model.gguf".into(),
            started_at: 1,
            executable: String::new(),
            log_path: String::new(),
            log_collector: None,
            engine: None,
        };
        let paths = [current.clone(), previous.clone()];
        assert!(read_first_state(&paths).unwrap().is_none());

        fs::create_dir_all(previous.parent().unwrap()).unwrap();
        fs::write(&previous, serde_json::to_vec(&state(7)).unwrap()).unwrap();
        assert_eq!(read_first_state(&paths).unwrap().unwrap().pid, 7);

        fs::create_dir_all(current.parent().unwrap()).unwrap();
        fs::write(&current, serde_json::to_vec(&state(9)).unwrap()).unwrap();
        assert_eq!(read_first_state(&paths).unwrap().unwrap().pid, 9);
        fs::remove_dir_all(root).unwrap();
    }
}
