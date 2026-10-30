//! A headless CLI start of an interpreter/bridge launcher, whose HTTP listener
//! is a descendant (as with a venv `python.exe` redirector), must pass the
//! listener ownership check, return, and leave the server running after the
//! CLI exits; status, restart and stop then manage that exact tree and its
//! launch directory. An unrelated process answering on the configured port is
//! never accepted, and terminating the CLI before readiness reclaims the whole
//! launched tree. A launcher whose server fails before readiness leaves no
//! process, state or launch directory. Synthetic processes only; no inference.
//! Setting `AIOLM_TEST_VENV_PYTHON` to a venv's `python.exe` also runs the
//! start/stop journey through that actual redirector and a synthetic script.
#![cfg(windows)]

#[path = "support/launch_resource_binding.rs"]
mod launch_resource_binding;
#[path = "support/windows_listener.rs"]
mod windows_listener;

use aiolm_lib::providers::{
    self,
    launch_resources::{self, Request},
    registry::{ArgBinding, AuthBinding, EntrypointDraft, ProcessSpec, ServingProtocol},
    runtime_schema,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

const ENGINE: &str = "custom.launcherfixture";
/// Bounds on this test's own waits. The synthetic server listens at once, so a
/// start that has not returned by then is stuck, not slow.
const START_BOUND: Duration = Duration::from_secs(60);
const EXIT_BOUND: Duration = Duration::from_secs(10);

struct TestHome {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl TestHome {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "aiolm-headless-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        for profile in ["roaming", "local", "config", "data", "cache"] {
            fs::create_dir_all(path.join("profile").join(profile)).unwrap();
        }
        let previous = std::env::var_os("AIOLM_HOME");
        // Only the full lifecycle test reads configuration; the listener-table
        // regressions never read or modify this process environment.
        std::env::set_var("AIOLM_HOME", &path);
        Self { path, previous }
    }
}
impl Drop for TestHome {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("AIOLM_HOME", value),
            None => std::env::remove_var("AIOLM_HOME"),
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// An owned handle, held from the moment the fixture reports its PID, so a
/// reused PID cannot stand in for the synthetic process in any check.
struct Process(HANDLE);
impl Process {
    fn open(pid: u32, image: Option<&Path>) -> Self {
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        assert!(!handle.is_null(), "synthetic process {pid} is not running");
        let process = Self(handle);
        if let Some(image) = image {
            assert!(process.is(image), "PID {pid} is not the synthetic fixture");
        }
        process
    }
    /// After a failed start: the PID is gone, names another image, or names
    /// this fixture's exited process. (Without the terminate right, drop
    /// cannot affect an unrelated process.)
    fn gone(pid: u32, image: &Path) -> bool {
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return true;
        }
        let process = Self(handle);
        !process.is(image) || process.exits_within(Duration::ZERO)
    }
    fn is(&self, image: &Path) -> bool {
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.0, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
            return false;
        }
        let actual = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
        fs::canonicalize(actual).ok() == fs::canonicalize(image).ok()
    }
    fn exits_within(&self, limit: Duration) -> bool {
        unsafe { WaitForSingleObject(self.0, limit.as_millis() as u32) == 0 }
    }
    fn running(&self) -> bool {
        !self.exits_within(Duration::ZERO)
    }
    fn terminate(&self) {
        unsafe { TerminateProcess(self.0, 1) };
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        // A failing assertion must not leave the synthetic tree behind.
        self.terminate();
        unsafe { CloseHandle(self.0) };
    }
}

struct Tree {
    launcher: Process,
    server: Process,
}
impl Tree {
    fn read(record: &Path, image: Option<&Path>) -> Option<Self> {
        let value: Value = serde_json::from_slice(&fs::read(record).ok()?).ok()?;
        let pid = |key: &str| value[key].as_u64().map(|pid| pid as u32);
        let (launcher, server) = (pid("launcher")?, pid("server")?);
        assert_ne!(launcher, server);
        Some(Self {
            launcher: Process::open(launcher, image),
            server: Process::open(server, image),
        })
    }
    fn wait(record: &Path, image: Option<&Path>) -> Self {
        let deadline = Instant::now() + START_BOUND;
        loop {
            if let Some(tree) = Self::read(record, image) {
                return tree;
            }
            assert!(
                Instant::now() < deadline,
                "launcher did not report its tree"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    fn running(&self) -> bool {
        self.launcher.running() && self.server.running()
    }
    fn exits_within(&self, limit: Duration) -> bool {
        self.launcher.exits_within(limit) && self.server.exits_within(limit)
    }
}

/// Open a file the way a slow-exiting engine holds its log: deletion refused.
fn hold(path: &Path) -> fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .share_mode(0x1) // FILE_SHARE_READ
        .open(path)
        .unwrap()
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn get(port: u16, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

/// The command a user runs, with app data and every OS profile folder that
/// legacy imports or the earlier CLI state location read kept in this home.
fn cli(home: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_aiolm-cli"));
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("AIOLM_") || name.starts_with("LLAMA_BOARD_") {
            command.env_remove(key);
        }
    }
    let profile = home.join("profile");
    command
        .args(args)
        .env("AIOLM_HOME", home)
        .env("HOME", &profile)
        .env("USERPROFILE", &profile)
        .env("APPDATA", profile.join("roaming"))
        .env("LOCALAPPDATA", profile.join("local"))
        .env("XDG_CONFIG_HOME", profile.join("config"))
        .env("XDG_DATA_HOME", profile.join("data"))
        .env("XDG_CACHE_HOME", profile.join("cache"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn json(output: &std::process::Output) -> Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("CLI output is not JSON: {output:?}"))
}

struct Running {
    child: Child,
    stdout: Option<std::thread::JoinHandle<Vec<u8>>>,
}
impl Running {
    fn spawn(mut command: Command) -> Self {
        let mut child = command.spawn().unwrap();
        let mut pipe = child.stdout.take().unwrap();
        let stdout = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        });
        Self {
            child,
            stdout: Some(stdout),
        }
    }
    /// The CLI's own exit, or `None` once `limit` passes with it still running.
    fn finish_within(&mut self, limit: Duration) -> Option<(bool, Value)> {
        let deadline = Instant::now() + limit;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let bytes = self.stdout.take().unwrap().join().unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("CLI output is not JSON: {bytes:?}"));
        Some((status.success(), value))
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// An unrelated process (this test) answering readiness exactly as the
/// launched engine would, counting how often readiness reached model checks.
struct ForeignServer {
    port: u16,
    model_checks: Arc<AtomicUsize>,
    all_requests: Arc<AtomicUsize>,
    finished: std::sync::mpsc::Receiver<()>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    stop_evidence: Option<Value>,
}
impl ForeignServer {
    fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (model_checks, stop) = (
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        );
        let (checks, stopped) = (model_checks.clone(), stop.clone());
        let all_requests = Arc::new(AtomicUsize::new(0));
        let requests = all_requests.clone();
        let (done, finished) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                };
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                requests.fetch_add(1, Ordering::AcqRel);
                let head = String::from_utf8_lossy(&head);
                let path = head.split_whitespace().nth(1).unwrap_or_default();
                let body = match path {
                    "/health" => r#"{"status":"ok"}"#,
                    "/v1/models" => {
                        checks.fetch_add(1, Ordering::AcqRel);
                        r#"{"data":[{"id":"fake-model","object":"model"}]}"#
                    }
                    _ => "{}",
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
            let _ = done.send(());
        });
        Self {
            port,
            all_requests,
            finished,
            model_checks,
            stop,
            thread: Some(thread),
            stop_evidence: None,
        }
    }
}
impl ForeignServer {
    fn stop_checked(&mut self) -> Result<(), String> {
        let stop_started = Instant::now();
        let deadline = stop_started + EXIT_BOUND;
        self.stop.store(true, Ordering::Release);
        if self.thread.is_some() {
            self.finished
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|e| format!("foreign stop: {e}"))?;
            if let Some(thread) = self.thread.take() {
                thread
                    .join()
                    .map_err(|_| "foreign thread panicked".to_string())?;
            }
        }
        // Joining proves the fixture thread dropped its listener. Confirm
        // absence in both kernel LISTEN tables, including another process
        // rebinding the port, without Windows' refused-connect backoff.
        let query_started = Instant::now();
        let proof = windows_listener::wait_loopback_listener_closed(
            self.port,
            deadline.saturating_duration_since(Instant::now()),
        );
        let query_elapsed = query_started.elapsed();
        self.stop_evidence = Some(serde_json::json!({
            "owned_port":self.port,"method":"kernel_ipv4_ipv6_listen_tables",
            "query_elapsed_ms":query_elapsed.as_millis(),"query_elapsed_us":query_elapsed.as_micros(),
            "total_stop_ms":stop_started.elapsed().as_millis(),"bound_ms":EXIT_BOUND.as_millis(),
            "proof":proof.as_ref().map(|proof|serde_json::json!({"listener_absent":true,"snapshots":proof.snapshots,
                "api_queries":proof.api_queries,"elapsed_us":proof.elapsed.as_micros()})).map_err(String::as_str)
        }));
        proof.map(|_| ())
    }
}
impl Drop for ForeignServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Unrecognized or unverifiable staging entries recovery must keep.
struct ForeignStaging {
    entries: Vec<PathBuf>,
    target: PathBuf,
}
fn foreign_staging(staging: &Path, home: &Path) -> ForeignStaging {
    let id = || uuid::Uuid::new_v4().to_string();
    let marker = |id: &str| format!(r#"{{"version":1,"id":"{id}","pid":null}}"#);
    let named = staging.join("not-a-launch");
    fs::create_dir(&named).unwrap();
    fs::write(named.join("keep.txt"), b"user").unwrap();
    let empty = staging.join(id());
    fs::create_dir(&empty).unwrap();
    let (unlocked_id, file, junction_id) = (id(), staging.join(id()), id());
    let unlocked = staging.join(&unlocked_id);
    fs::create_dir(&unlocked).unwrap();
    fs::write(unlocked.join(".aiolm-launch.json"), marker(&unlocked_id)).unwrap();
    fs::write(&file, b"user").unwrap();
    let target = home.join("outside staging target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join(".aiolm-launch.json"), marker(&junction_id)).unwrap();
    fs::write(target.join(".aiolm-launch.lock"), b"").unwrap();
    fs::write(target.join("keep.txt"), b"user").unwrap();
    let junction = staging.join(&junction_id);
    let linked = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(linked.success());
    ForeignStaging {
        entries: vec![named.join("keep.txt"), empty, unlocked, file, junction],
        target,
    }
}
impl ForeignStaging {
    fn assert_preserved(&self) {
        for entry in &self.entries {
            assert!(fs::symlink_metadata(entry).is_ok(), "{}", entry.display());
        }
        for name in [".aiolm-launch.json", ".aiolm-launch.lock", "keep.txt"] {
            assert!(self.target.join(name).is_file(), "junction target {name}");
        }
    }
}

/// `engine` is the synthetic fixture, which also answers the probe.
fn draft(
    engine: &str,
    program: &str,
    runtime: &str,
    prefix: Vec<String>,
    environment: BTreeMap<String, String>,
    resources: bool,
) -> EntrypointDraft {
    EntrypointDraft {
        command_layout: None,
        options_separator: None,
        launch_resources: resources.then(|| Request {
            version: 1,
            directory_env: "SYNTHETIC_LAUNCH_DIRECTORY".into(),
        }),
        models: vec![],
        engine_id: providers::ProviderId::parse(ENGINE).unwrap(),
        runtime_id: runtime.into(),
        display_name: format!("Synthetic launcher {runtime}"),
        program: program.into(),
        prefix,
        working_directory: None,
        artifacts: vec![],
        environment,
        model: ArgBinding::Flag {
            flag: "--model".into(),
            equals: false,
        },
        port: ArgBinding::Flag {
            flag: "--port".into(),
            equals: false,
        },
        host: None,
        served_model: None,
        auth: AuthBinding::None,
        protocol: ServingProtocol::OpenaiHttp,
        probe: ProcessSpec {
            program: engine.into(),
            args: vec![
                "--adapter-probe".into(),
                ENGINE.into(),
                runtime.into(),
                "{model}".into(),
            ],
            env: BTreeMap::new(),
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: None,
        option_metadata: None,
    }
}

fn select(model: &Path, runtime: &str, port: u16) -> aiolm_lib::AppConfig {
    let mut cfg = aiolm_lib::AppConfig {
        active_provider: ENGINE.into(),
        active_runtime: runtime.into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    aiolm_lib::config::save(&cfg).unwrap()
}

// Public CLI regressions run sequentially before the original global-home journey.
// These files are finite external-probe inputs, not native inference models.
type PublicResult<T> = Result<T, String>;

fn public_io<T>(result: std::io::Result<T>) -> PublicResult<T> {
    result.map_err(|error| error.to_string())
}

fn public_require(ok: bool, message: &str) -> PublicResult<()> {
    if ok {
        Ok(())
    } else {
        Err(format!("setup: {message}"))
    }
}

fn public_bytes(bytes: &[u8]) -> Value {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    serde_json::json!({"bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes)),
        "base64": base64::engine::general_purpose::STANDARD.encode(bytes)})
}

fn public_executable_digest(path: &Path) -> PublicResult<Value> {
    use sha2::{Digest, Sha256};
    let mut file = public_io(fs::File::open(path))?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let length = public_io(file.read(&mut chunk))?;
        if length == 0 {
            break;
        }
        digest.update(&chunk[..length]);
        bytes += length as u64;
    }
    // Executable evidence has always retained only size/hash. Avoid encoding a
    // full executable as Base64 merely to discard that field immediately.
    Ok(serde_json::json!({"bytes":bytes,"sha256":format!("{:x}",digest.finalize())}))
}

/// This integration binary has a single active parent test. CLI children have
/// explicit environments; the temporary override only directs synchronous
/// config migration/saving to this case's already isolated home.
struct FixtureConfigHome(Option<std::ffi::OsString>);
impl FixtureConfigHome {
    fn enter(home: &Path) -> Self {
        let previous = std::env::var_os("AIOLM_HOME");
        std::env::set_var("AIOLM_HOME", home);
        Self(previous)
    }
}
impl Drop for FixtureConfigHome {
    fn drop(&mut self) {
        match &self.0 {
            Some(previous) => std::env::set_var("AIOLM_HOME", previous),
            None => std::env::remove_var("AIOLM_HOME"),
        }
    }
}

fn fixture_public_projection(cfg: &aiolm_lib::AppConfig, home: &Path) -> PublicResult<Value> {
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
    fn redact(value: Value) -> Value {
        match value {
            Value::Object(mut object) => {
                for (name, value) in &mut object {
                    *value = if sensitive_name(name) {
                        Value::from("[REDACTED]")
                    } else {
                        redact(std::mem::take(value))
                    };
                }
                Value::Object(object)
            }
            Value::Array(mut values) => {
                let mut redact_next = false;
                for value in &mut values {
                    if redact_next {
                        *value = Value::from("[REDACTED]");
                        redact_next = false;
                    } else if let Value::String(text) = value {
                        if sensitive_flag(text) && text.contains('=') {
                            let end = text.find('=').unwrap_or(text.len());
                            *value = Value::from(format!("{}=[REDACTED]", &text[..end]));
                        } else {
                            redact_next = sensitive_flag(text);
                        }
                    } else {
                        *value = redact(std::mem::take(value));
                    }
                }
                Value::Array(values)
            }
            other => other,
        }
    }
    let mut projection = redact(serde_json::to_value(cfg).map_err(|e| e.to_string())?);
    let _home = FixtureConfigHome::enter(home);
    runtime_schema::mask_config(
        &providers::registry::root(),
        cfg,
        &mut projection,
        "[REDACTED]",
    );
    Ok(projection)
}

struct PublicReader {
    done: std::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>,
    thread: Option<std::thread::JoinHandle<()>>,
    result: Option<PublicResult<Vec<u8>>>,
}
impl PublicReader {
    fn spawn(mut pipe: impl Read + Send + 'static) -> PublicResult<Self> {
        let (send, done) = std::sync::mpsc::channel();
        let thread = public_io(std::thread::Builder::new().spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
            let _ = send.send(result);
        }))?;
        Ok(Self {
            done,
            thread: Some(thread),
            result: None,
        })
    }
    fn finish(&mut self) -> PublicResult<Vec<u8>> {
        if let Some(result) = &self.result {
            return result.clone();
        }
        let result = self
            .done
            .recv_timeout(EXIT_BOUND)
            .map_err(|e| format!("pipe EOF: {e}"))?;
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "pipe reader panicked".to_string())?;
        }
        let result = public_io(result);
        self.result = Some(result.clone());
        result
    }
}

struct PublicCommand {
    owner: aiolm_lib::server::Child,
    stdout: Option<PublicReader>,
    stderr: Option<PublicReader>,
    streams_done: bool,
    root_exit: Option<i32>,
}
impl PublicCommand {
    fn spawn(mut command: Command) -> PublicResult<Self> {
        let owner = public_io(aiolm_lib::server::Child::spawn_with_creation_flags(
            &mut command,
            0,
        ))?;
        // Nothing fallible occurs between spawning and transferring this owner
        // to PublicCase. Pipe and reader setup happens only after that transfer.
        Ok(Self {
            owner,
            stdout: None,
            stderr: None,
            streams_done: false,
            root_exit: None,
        })
    }
    fn init_readers(&mut self) -> PublicResult<()> {
        if self.stdout.is_none() {
            self.stdout = Some(PublicReader::spawn(
                self.owner.stdout.take().ok_or("stdout pipe missing")?,
            )?);
        }
        if self.stderr.is_none() {
            self.stderr = Some(PublicReader::spawn(
                self.owner.stderr.take().ok_or("stderr pipe missing")?,
            )?);
        }
        Ok(())
    }
    fn output(&mut self) -> PublicResult<std::process::Output> {
        let deadline = Instant::now() + START_BOUND;
        let status = loop {
            // OwnedChild::try_wait terminates its job when the root exits.
            // The outer job must retain the deliberately persistent descendants.
            if let Some(status) = public_io(std::process::Child::try_wait(&mut self.owner))? {
                break status;
            }
            if Instant::now() >= deadline {
                return Err("CLI root exceeded START_BOUND".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let stdout = self
            .stdout
            .as_mut()
            .ok_or("stdout reader missing")?
            .finish()?;
        let stderr = self
            .stderr
            .as_mut()
            .ok_or("stderr reader missing")?
            .finish()?;
        self.streams_done = true;
        self.root_exit = status.code();
        Ok(std::process::Output {
            status,
            stdout,
            stderr,
        })
    }
    fn finish_checked(&mut self) -> PublicResult<()> {
        let tree = self.owner.process_handle().ok_or("outer job missing")?;
        tree.terminate();
        public_require(
            tree.wait_exited(EXIT_BOUND),
            "outer job did not become empty",
        )?;
        let status = public_io(std::process::Child::try_wait(&mut self.owner))?
            .ok_or("root remains after empty job")?;
        self.root_exit = status.code();
        if !self.streams_done {
            // A failed reader setup may already have closed one pipe. Finish
            // every reader that did start, even if the other cannot start.
            let mut errors = Vec::new();
            if self.stdout.is_none() {
                if let Some(pipe) = self.owner.stdout.take() {
                    match PublicReader::spawn(pipe) {
                        Ok(reader) => self.stdout = Some(reader),
                        Err(error) => errors.push(error),
                    }
                }
            }
            if self.stderr.is_none() {
                if let Some(pipe) = self.owner.stderr.take() {
                    match PublicReader::spawn(pipe) {
                        Ok(reader) => self.stderr = Some(reader),
                        Err(error) => errors.push(error),
                    }
                }
            }
            if let Some(reader) = self.stdout.as_mut() {
                if let Err(error) = reader.finish() {
                    errors.push(error);
                }
            }
            if let Some(reader) = self.stderr.as_mut() {
                if let Err(error) = reader.finish() {
                    errors.push(error);
                }
            }
            self.streams_done = errors.is_empty();
            if !errors.is_empty() {
                return Err(errors.join("; "));
            }
        }
        Ok(())
    }
}

/// Query-only handles also cover the ForeignServer in this test process.
/// They cannot signal any process, including on an error or unwind.
struct PublicProcess {
    handle: HANDLE,
    pid: u32,
}
impl PublicProcess {
    fn open(pid: u32, image: &Path) -> PublicResult<Self> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(format!(
                "cannot retain PID {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
        let process = Self { handle, pid };
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        public_require(
            unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } != 0,
            "cannot query image",
        )?;
        let actual = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
        public_require(
            public_io(fs::canonicalize(actual))? == public_io(fs::canonicalize(image))?,
            "PID image mismatch",
        )?;
        Ok(process)
    }
    fn running(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle, 0) != 0 }
    }
    fn exited(&self, deadline: Instant) -> bool {
        unsafe {
            WaitForSingleObject(
                self.handle,
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u32,
            ) == 0
        }
    }
}
impl Drop for PublicProcess {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}

struct PublicLaunch {
    processes: Vec<PublicProcess>,
    directory: PathBuf,
    port: u16,
}

struct PublicCase {
    home: PathBuf,
    image: PathBuf,
    commands: Vec<PublicCommand>,
    launches: Vec<PublicLaunch>,
    foreign: Option<ForeignServer>,
    foreign_process: Option<PublicProcess>,
    aliases: Vec<PathBuf>,
    evidence: Vec<Value>,
    expectations: Vec<(String, bool)>,
    finished: bool,
    owns_home: bool,
    recover_interrupted_start: bool,
    config_through_cli: bool,
    started: Instant,
    phase_started: Instant,
    phase: &'static str,
    phase_ms: BTreeMap<&'static str, u128>,
}
impl PublicCase {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("aiolm-public-cli-{}", uuid::Uuid::new_v4()));
        let started = Instant::now();
        Self {
            image: home.join("synthetic launcher.exe"),
            home,
            commands: vec![],
            launches: vec![],
            foreign: None,
            foreign_process: None,
            aliases: vec![],
            evidence: vec![],
            expectations: vec![],
            finished: false,
            owns_home: false,
            recover_interrupted_start: false,
            config_through_cli: false,
            started,
            phase_started: started,
            phase: "setup",
            phase_ms: BTreeMap::new(),
        }
    }
    fn phase(&mut self, phase: &'static str) {
        *self.phase_ms.entry(self.phase).or_default() += self.phase_started.elapsed().as_millis();
        self.phase = phase;
        self.phase_started = Instant::now();
    }
    fn timings(&self) -> Value {
        let mut phases = self.phase_ms.clone();
        *phases.entry(self.phase).or_default() += self.phase_started.elapsed().as_millis();
        let commands = self
            .evidence
            .iter()
            .filter(|entry| entry.get("argv").is_some())
            .count();
        serde_json::json!({"elapsed_ms":self.started.elapsed().as_millis(),"phases_ms":phases,
            "timed_cli_commands":commands,"registered_children":self.commands.len(),
            "fixture_saves":self.evidence.iter().filter(|entry|entry["fixture_config"]["through_public_cli"] == false).count(),
            "reference_config_saves":self.evidence.iter().filter_map(|entry|entry["fixture_config"]["reference_saves"].as_u64()).sum::<u64>(),
            "public_config_set_commands":self.evidence.iter().filter(|entry|entry["argv"][0] == "config" && entry["argv"][1] == "set").count()})
    }
    fn file(&self, relative: &str) -> PathBuf {
        self.home.join(relative)
    }
    fn state(&self) -> PathBuf {
        self.file("cli/headless-state.json")
    }
    fn expect(&mut self, label: &str, value: bool) {
        self.expectations.push((label.into(), value));
    }
    fn record_file(&mut self, label: &str, path: &Path) -> PublicResult<Vec<u8>> {
        let bytes = public_io(fs::read(path))?;
        self.evidence
            .push(serde_json::json!({"file": label, "path":path, "raw":public_bytes(&bytes)}));
        Ok(bytes)
    }
    fn isolated_cli(&self, args: &[&str]) -> Command {
        let mut command = cli(&self.home, args);
        command
            .env("TMP", self.file("profile/temp"))
            .env("TEMP", self.file("profile/temp"));
        for name in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            command.env_remove(name);
        }
        command
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");
        command
    }
    fn command(&mut self, args: &[&str]) -> PublicResult<(bool, Value)> {
        let command = self.isolated_cli(args);
        let start = Instant::now();
        self.commands.push(PublicCommand::spawn(command)?);
        let owned = self.commands.last_mut().ok_or("command missing")?;
        let result = owned.init_readers().and_then(|()| owned.output());
        match result {
            Ok(output) => {
                let value =
                    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string());
                self.evidence.push(serde_json::json!({"argv":args,"phase":self.phase,"cwd":std::env::current_dir().ok(),"elapsed_ms":start.elapsed().as_millis(),
                    "exit":output.status.code(),"stdout":public_bytes(&output.stdout),"stderr":public_bytes(&output.stderr),"json":value}));
                Ok((output.status.success(), value?))
            }
            Err(error) => {
                self.evidence.push(serde_json::json!({"argv":args,"phase":self.phase,"error":error,"elapsed_ms":start.elapsed().as_millis()}));
                Err(error)
            }
        }
    }
    fn success(&mut self, args: &[&str]) -> PublicResult<Value> {
        let (ok, value) = self.command(args)?;
        public_require(ok, &format!("CLI {args:?}: {value}"))?;
        Ok(value)
    }
    fn set(&mut self, key: &str, value: &str) -> PublicResult<()> {
        self.success(&["config", "set", key, value]).map(|_| ())
    }
    fn configure_fixture(&mut self, fields: &[(&str, Value)]) -> PublicResult<Value> {
        let started = Instant::now();
        let expected = {
            let _home = FixtureConfigHome::enter(&self.home);
            // Start with the configuration written by real runtime selection,
            // retaining registry/profile/default initialization and migration.
            let mut cfg = aiolm_lib::config::load_result()?;
            for (key, field) in fields {
                let mut value = serde_json::to_value(&cfg).map_err(|e| e.to_string())?;
                let object = value
                    .as_object_mut()
                    .ok_or("fixture config is not an object")?;
                public_require(object.contains_key(*key), "unknown fixture config field")?;
                object.insert((*key).into(), field.clone());
                cfg = serde_json::from_value(value).map_err(|e| e.to_string())?;
                cfg.runtime_defaults.retain(|changed| changed != key);
                cfg.normalize();
                cfg.validate()?;
                if matches!(
                    *key,
                    "active_model"
                        | "active_provider"
                        | "active_runtime"
                        | "active_backend"
                        | "active_build"
                ) {
                    // config get initializes an application snapshot when the
                    // active model/runtime changes. Model that read boundary
                    // before later fields, just as sequential config set does.
                    cfg = self.canonical_fixture_config(&cfg)?;
                }
            }
            cfg = self.canonical_fixture_config(&cfg)?;
            if !self.config_through_cli {
                cfg = aiolm_lib::config::save(&cfg)?;
            }
            serde_json::to_value(cfg).map_err(|e| e.to_string())?
        };
        if self.config_through_cli {
            // Representative public journeys still exercise every setting
            // command. Other ownership cases need the same state, not dozens
            // of repeated process starts and durable writes to prepare it.
            for (key, value) in fields {
                let argument = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                self.set(key, &argument)?;
            }
        }
        self.evidence.push(serde_json::json!({"fixture_config":{"fields":fields.iter().map(|(key,_)|*key).collect::<Vec<_>>(),
            "through_public_cli":self.config_through_cli,"elapsed_ms":started.elapsed().as_millis(),
            "reference_saves":1+fields.iter().filter(|(key,_)|matches!(*key,"active_model"|"active_provider"|"active_runtime"|"active_backend"|"active_build")).count()}}));
        Ok(expected)
    }
    fn canonical_fixture_config(
        &self,
        cfg: &aiolm_lib::AppConfig,
    ) -> PublicResult<aiolm_lib::AppConfig> {
        let reference = self.file(&format!(
            "profile/config-reference-{}",
            uuid::Uuid::new_v4()
        ));
        public_io(fs::create_dir(&reference))?;
        let canonical = {
            let _home = FixtureConfigHome::enter(&reference);
            // The reference has its own file, never the actual configuration
            // being checked. Exercise the exact saved-value migration used by
            // the public CLI, including profile presence and model identity.
            aiolm_lib::config::save(cfg)?;
            aiolm_lib::config::load_result()?
        };
        public_io(fs::remove_file(reference.join("config.json")))?;
        public_io(fs::remove_dir(reference))?;
        Ok(canonical)
    }
    fn fixture_readback(&mut self, expected: &Value) -> PublicResult<Value> {
        let expected_cfg: aiolm_lib::AppConfig =
            serde_json::from_value(expected.clone()).map_err(|e| e.to_string())?;
        let stored_cfg: aiolm_lib::AppConfig =
            serde_json::from_slice(&public_io(fs::read(self.file("config.json")))?)
                .map_err(|e| e.to_string())?;
        let stored = serde_json::to_value(stored_cfg).map_err(|e| e.to_string())?;
        let public = fixture_public_projection(&expected_cfg, &self.home)?;
        let observed = self.success(&["config", "get"])?;
        self.evidence.push(serde_json::json!({"fixture_config_comparison":{
            "expected_saved":expected,"actual_saved":stored,"expected_public":public,"actual_public":observed
        }}));
        public_require(
            &stored == expected,
            "fixture and saved configuration differ",
        )?;
        public_require(
            observed == public,
            "fixture and public CLI configuration differ",
        )?;
        self.evidence
            .push(serde_json::json!({"public_fixture_readback_equal":true}));
        Ok(observed)
    }
    fn setup(&mut self) -> PublicResult<u16> {
        self.setup_with_status_route(false)
    }
    fn setup_with_status_route(&mut self, status_route: bool) -> PublicResult<u16> {
        public_io(fs::create_dir(&self.home))?;
        self.owns_home = true;
        for dir in [
            "models",
            "profile/temp",
            "profile/roaming",
            "profile/local",
            "profile/config",
            "profile/data",
            "profile/cache",
        ] {
            public_io(fs::create_dir_all(self.file(dir)))?;
        }
        public_io(fs::copy(
            env!("CARGO_BIN_EXE_fake-llama-server"),
            &self.image,
        ))?;
        for (name, bytes) in [
            (
                "running-00001-of-00002.gguf",
                &b"synthetic primary shard one\n"[..],
            ),
            (
                "running-00002-of-00002.gguf",
                &b"synthetic primary shard two\n"[..],
            ),
            ("replacement.gguf", &b"synthetic replacement\n"[..]),
            ("unrelated.gguf", &b"synthetic unrelated\n"[..]),
            (
                "projector.mmproj",
                &b"synthetic saved projector control\n"[..],
            ),
            ("draft.gguf", &b"synthetic saved draft control\n"[..]),
            ("adapter.gguf", &b"synthetic saved adapter control\n"[..]),
        ] {
            public_io(fs::write(self.file(&format!("models/{name}")), bytes))?;
        }
        let engine = self.image.to_string_lossy().into_owned();
        let environment = BTreeMap::from([
            (
                "FAKE_LAUNCHER_RECORD".into(),
                self.file("launcher-1.json").to_string_lossy().into_owned(),
            ),
            (
                "FAKE_RESOURCE_RECORD".into(),
                self.file("launcher-1-directory.txt")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "FAKE_ENGINE_ARGV_FILE".into(),
                self.file("launch-argv.json").to_string_lossy().into_owned(),
            ),
        ]);
        let mut registration = draft(
            &engine,
            &engine,
            "launcher-1",
            vec![
                "--adapter-launcher-fixture".into(),
                "--adapter-resource-fixture".into(),
                "--adapter-engine".into(),
                "--adapter-no-health-auth".into(),
            ],
            environment,
            true,
        );
        if status_route {
            registration.health_path = "/round72-origin-health".into();
            registration.environment.insert(
                "FAKE_STATUS_REQUEST_RECORD".into(),
                self.file("status-requests.txt")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        let manifest =
            providers::registry::manifest_from_draft(&registration).map_err(|e| e.to_string())?;
        public_io(fs::write(
            self.file("registration.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        ))?;
        self.record_file("registration", &self.file("registration.json"))?;
        self.success(&[
            "runtime",
            "register-manifest",
            &self.file("registration.json").to_string_lossy(),
        ])?;
        self.success(&["runtime", "select", ENGINE, "launcher-1"])?;
        self.foreign = Some(ForeignServer::start());
        self.foreign_process = Some(PublicProcess::open(
            std::process::id(),
            &public_io(std::env::current_exe())?,
        )?);
        let port = free_port();
        public_require(port != self.foreign_port()?, "A and B ports collided")?;
        let expected = self.configure_fixture(&[
            ("models_dir", serde_json::json!(self.file("models"))),
            (
                "active_model",
                serde_json::json!(self.file("models/running-00001-of-00002.gguf")),
            ),
            ("port", serde_json::json!(port)),
        ])?;
        let config = self.fixture_readback(&expected)?;
        self.evidence.push(serde_json::json!({"setup_config":config,"home":self.home,
            "child_environment":"AIOLM/legacy removed; HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG roots and TMP/TEMP within unique home; proxies removed, NO_PROXY loopback"}));
        Ok(port)
    }
    fn foreign_port(&self) -> PublicResult<u16> {
        Ok(self.foreign.as_ref().ok_or("foreign missing")?.port)
    }
    fn contacts(&self) -> usize {
        self.foreign
            .as_ref()
            .map(|f| f.all_requests.load(Ordering::Acquire))
            .unwrap_or(0)
    }
    fn launch(&mut self, verb: &str, port: u16) -> PublicResult<()> {
        let owner_index = self.commands.len();
        let started = self.success(&["server", verb])?;
        self.capture_launch(owner_index, started, port)
    }
    fn capture_launch(
        &mut self,
        owner_index: usize,
        started: Value,
        port: u16,
    ) -> PublicResult<()> {
        let state_bytes = self.record_file("running-state", &self.state())?;
        let state: Value = serde_json::from_slice(&state_bytes).map_err(|e| e.to_string())?;
        let tree_bytes = self.record_file("tree", &self.file("launcher-1.json"))?;
        let tree: Value = serde_json::from_slice(&tree_bytes).map_err(|e| e.to_string())?;
        let id = |v: &Value| {
            v.as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .ok_or("missing PID".to_string())
        };
        let launcher = id(&tree["launcher"])?;
        let listener = id(&tree["server"])?;
        let collector = id(&state["log_collector"]["pid"])?;
        let processes = vec![
            PublicProcess::open(launcher, &self.image)?,
            PublicProcess::open(listener, &self.image)?,
            PublicProcess::open(collector, Path::new(env!("CARGO_BIN_EXE_aiolm-cli")))?,
        ];
        let directory = PathBuf::from(public_io(fs::read_to_string(
            self.file("launcher-1-directory.txt"),
        ))?);
        self.launches.push(PublicLaunch {
            processes,
            directory: directory.clone(),
            port,
        });
        let owner = self.commands[owner_index]
            .owner
            .process_handle()
            .ok_or("outer job missing")?;
        let membership: Vec<_> = [launcher, listener, collector]
            .map(|pid| serde_json::json!({"pid":pid,"member":owner.contains(pid)}))
            .to_vec();
        self.evidence.push(serde_json::json!({"outer_root":self.commands[owner_index].owner.id(),"membership":membership}));
        public_require(
            [launcher, listener, collector]
                .iter()
                .all(|pid| owner.contains(*pid)),
            "descendants escaped outer job",
        )?;
        public_require(
            launcher != listener && collector != launcher && collector != listener,
            "distinct tree/collector identities",
        )?;
        public_require(
            state["pid"] == launcher && started["pid"] == launcher && started["state"] == "running",
            "start/state identity",
        )?;
        public_require(
            public_io(fs::canonicalize(
                state["executable"]
                    .as_str()
                    .ok_or("state executable missing")?,
            ))? == public_io(fs::canonicalize(&self.image))?,
            "recorded executable",
        )?;
        let argv_bytes = self.record_file("launch-argv", &self.file("launch-argv.json"))?;
        let argv: Vec<String> = serde_json::from_slice(&argv_bytes).map_err(|e| e.to_string())?;
        let model = self
            .file("models/running-00001-of-00002.gguf")
            .to_string_lossy()
            .into_owned();
        public_require(
            argv.windows(2).any(|a| a == ["--model", &model]),
            "actual primary argv binding",
        )?;
        public_require(state["model"] == model, "recorded primary binding")?;
        public_require(
            !argv.iter().any(|a| a.starts_with("--api-key")),
            "auth-disabled argv",
        )?;
        for name in [".aiolm-launch.json", "effective-config.json"] {
            self.record_file(name, &directory.join(name))?;
        }
        self.evidence.push(serde_json::json!({"released_owner_lock_absent":!directory.join(".aiolm-launch.lock").exists()}));
        std::thread::sleep(Duration::from_millis(100));
        public_require(
            self.launches
                .last()
                .ok_or("launch missing")?
                .processes
                .iter()
                .all(PublicProcess::running),
            "outer-owned persistence after CLI exit",
        )?;
        public_require(
            get(port, "/v1/models").is_some_and(|s| s.contains("fake-model")),
            "owned A listener readiness",
        )?;
        Ok(())
    }
    fn natural(&mut self, index: usize, state_absent: bool) -> PublicResult<bool> {
        let launch = self.launches.get(index).ok_or("launch missing")?;
        let deadline = Instant::now() + EXIT_BOUND;
        let exits: Vec<_> = launch
            .processes
            .iter()
            .map(|p| serde_json::json!({"pid":p.pid,"exited":p.exited(deadline)}))
            .collect();
        let port_closed = TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], launch.port)),
            Duration::from_millis(250),
        )
        .is_err();
        let gone = !launch.directory.exists();
        let state_gone = !self.state().exists()
            && !self
                .file("profile/local/aiolm/headless-state.json")
                .exists();
        let clean = exits.iter().all(|p| p["exited"] == true)
            && port_closed
            && gone
            && (!state_absent || state_gone);
        self.evidence.push(serde_json::json!({"natural_product_cleanup":{"launch":index,"processes":exits,"port_closed":port_closed,
            "directory_absent":gone,"marker_absent":!launch.directory.join(".aiolm-launch.json").exists(),
            "owner_lock_absent":!launch.directory.join(".aiolm-launch.lock").exists(),"state_absent":state_gone}}));
        Ok(clean)
    }
    fn stop_and_observe(&mut self, index: usize) -> PublicResult<()> {
        let (ok, value) = self.command(&["server", "stop"])?;
        self.expect("public stop succeeded", ok && value["state"] == "stopped");
        let clean = self.natural(index, true)?;
        self.expect("natural product cleanup", clean);
        Ok(())
    }
    fn refused_file(&mut self, path: &Path, label: &str, guard: bool) -> PublicResult<()> {
        let before = self.record_file(&format!("{label}-before"), path)?;
        let (ok, value) = self.command(&["models", "delete", &path.to_string_lossy()])?;
        let error = value["error"].as_str().unwrap_or_default();
        self.expect(
            label,
            !ok && (!guard
                || error.contains("select another model/projector/draft")
                || error.contains("stop the headless server")),
        );
        let after = fs::read(path).ok();
        self.evidence.push(serde_json::json!({"file_after_delete":path,"raw":after.as_ref().map(|b| public_bytes(b))}));
        self.expect(
            &format!("{label} preserved bytes"),
            after.as_deref() == Some(&before),
        );
        Ok(())
    }
    fn status_health_route(&mut self, name: &str, port: u16) -> PublicResult<()> {
        let drift = matches!(name, "status-route-next" | "status-route-legacy-next");
        if drift {
            let mut next: Value =
                serde_json::from_slice(&public_io(fs::read(self.file("registration.json")))?)
                    .map_err(|e| e.to_string())?;
            public_require(
                next["probe"]["args"]
                    == serde_json::json!(["--adapter-probe", ENGINE, "launcher-1", "{model}"]),
                "original A probe argv contract",
            )?;
            next["runtime_id"] = "health-next".into();
            next["probe"]["args"][2] = "health-next".into();
            next["health_path"] = "/round72-next-health".into();
            let path = self.file("health-next.json");
            public_io(fs::write(
                &path,
                serde_json::to_vec(&next).map_err(|e| e.to_string())?,
            ))?;
            let registered =
                self.success(&["runtime", "register-manifest", &path.to_string_lossy()])?;
            public_require(
                registered["engine_id"] == ENGINE && registered["runtime_id"] == "health-next",
                "B registered before A launch with matching probe identity",
            )?;
        }
        self.launch("start", port)?;
        let baseline = self.success(&["server", "status"])?;
        public_require(
            baseline["state"] == "running" && baseline["health"] == true,
            "healthy original custom runtime before changing saved settings",
        )?;
        let mut state_path = self.state();
        if matches!(
            name,
            "status-route-legacy-next" | "status-route-no-engine-unchanged"
        ) {
            let mut legacy: Value = serde_json::from_slice(&public_io(fs::read(&state_path))?)
                .map_err(|e| e.to_string())?;
            let legacy = legacy.as_object_mut().ok_or("state object")?;
            // Optional proposed snapshot name; old records contain no such metadata.
            legacy.remove("health_path");
            if name == "status-route-no-engine-unchanged" {
                legacy.remove("engine");
            }
            public_io(fs::write(
                &state_path,
                serde_json::to_vec(&legacy).map_err(|e| e.to_string())?,
            ))?;
        }
        if name == "status-route-legacy-next" {
            let old = self.file("profile/local/aiolm/headless-state.json");
            public_io(fs::create_dir_all(old.parent().ok_or("old parent")?))?;
            public_io(fs::rename(&state_path, &old))?;
            state_path = old;
        }
        let state_before = self.record_file("status-original-state", &state_path)?;
        let original: Value = serde_json::from_slice(&state_before).map_err(|e| e.to_string())?;
        if drift {
            self.success(&["runtime", "select", ENGINE, "health-next"])?;
            self.set("port", &self.foreign_port()?.to_string())?;
            self.set(
                "active_model",
                &self.file("models/replacement.gguf").to_string_lossy(),
            )?;
        }
        let config_before = self.record_file("status-saved-config", &self.file("config.json"))?;
        let log_before = public_io(fs::read(self.file("status-requests.txt")))?;
        let contacts = self.contacts();
        let (ok, status) = self.command(&["server", "status"])?;
        let log_after = self.record_file("status-requests", &self.file("status-requests.txt"))?;
        self.expect(
            "status probes original custom route",
            log_after.strip_prefix(log_before.as_slice())
                == Some(&b"GET /round72-origin-health\n"[..]),
        );
        let mut expected = baseline;
        expected["engine"] = original["engine"].clone();
        self.expect(
            "status preserves every original public field",
            ok && status == expected,
        );
        let state_after = self.record_file("status-after-state", &state_path)?;
        self.expect(
            "status leaves raw state bytes unchanged",
            state_after == state_before,
        );
        self.expect(
            "status preserves full saved config bytes",
            public_io(fs::read(self.file("config.json")))? == config_before,
        );
        self.expect(
            "status never contacts saved-next foreign listener",
            self.contacts() == contacts,
        );
        self.expect(
            "foreign process remains live",
            self.foreign_process
                .as_ref()
                .is_some_and(PublicProcess::running),
        );
        self.stop_and_observe(0)?;
        self.expect(
            "stop preserves full saved config bytes",
            public_io(fs::read(self.file("config.json")))? == config_before,
        );
        self.expect(
            "stop preserves foreign isolation",
            self.contacts() == contacts
                && self
                    .foreign_process
                    .as_ref()
                    .is_some_and(PublicProcess::running),
        );
        Ok(())
    }
    fn behavior(&mut self, name: &str, port: u16) -> PublicResult<()> {
        if name.starts_with("status-route-") {
            return self.status_health_route(name, port);
        }
        if name == "saved-controls" {
            return self.saved_controls();
        }
        if name == "harness-early-error" {
            self.commands
                .push(PublicCommand::spawn(self.isolated_cli(&["config", "get"]))?);
            return Err("injected after outer owner registration before readers".into());
        }
        self.launch("start", port)?;
        if name == "harness-unwind" {
            panic!("injected unwind after owned server persistence");
        }
        if name == "unchanged" {
            let saved = self.success(&["config", "get"])?;
            let (ok, status) = self.command(&["server", "status"])?;
            self.expect(
                "unchanged running",
                ok && status["state"] == "running"
                    && status["url"] == format!("http://127.0.0.1:{port}/v1"),
            );
            self.stop_and_observe(0)?;
            let after = self.success(&["config", "get"])?;
            self.expect("saved A unchanged", after == saved);
        } else if name == "drift-stop" || name == "legacy-drift" {
            let state = self.record_file("before-drift-state", &self.state())?;
            if name == "legacy-drift" {
                let legacy = self.file("profile/local/aiolm/headless-state.json");
                public_io(fs::create_dir_all(legacy.parent().ok_or("legacy parent")?))?;
                public_io(fs::rename(self.state(), &legacy))?;
            }
            let b = self.foreign_port()?;
            self.set("port", &b.to_string())?;
            let saved = self.success(&["config", "get"])?;
            let path = if name == "legacy-drift" {
                self.file("profile/local/aiolm/headless-state.json")
            } else {
                self.state()
            };
            public_require(
                self.record_file("after-drift-state", &path)? == state,
                "config mutation altered running state",
            )?;
            let contacts = self.contacts();
            let (ok, status) = self.command(&["server", "status"])?;
            self.expect(
                "status manages original A",
                ok && status["state"] == "running"
                    && status["url"] == format!("http://127.0.0.1:{port}/v1"),
            );
            self.stop_and_observe(0)?;
            let after = self.success(&["config", "get"])?;
            self.expect("saved B preserved", saved == after && after["port"] == b);
            self.expect(
                "old status/stop never contacted foreign B",
                contacts == self.contacts(),
            );
            self.expect(
                "foreign process was never signaled",
                self.foreign_process
                    .as_ref()
                    .is_some_and(PublicProcess::running),
            );
        } else if name == "restart-free" {
            let b = free_port();
            public_require(
                b != port && b != self.foreign_port()?,
                "restart free-port collision",
            )?;
            self.set("port", &b.to_string())?;
            let owner_index = self.commands.len();
            let (ok, started) = self.command(&["server", "restart"])?;
            self.expect("free B restart succeeds", ok);
            if !ok {
                let old_clean = self.natural(0, true)?;
                self.expect("restart naturally cleaned old A", old_clean);
                return Ok(());
            }
            self.capture_launch(owner_index, started, b)?;
            let old_clean = self.natural(0, false)?;
            self.expect("restart naturally cleaned old A", old_clean);
            let (ok, status) = self.command(&["server", "status"])?;
            self.expect(
                "replacement B running",
                ok && status["state"] == "running"
                    && status["url"] == format!("http://127.0.0.1:{b}/v1"),
            );
            self.stop_and_observe(1)?;
            let cfg = self.success(&["config", "get"])?;
            self.expect("restart saved B preserved", cfg["port"] == b);
        } else if name == "restart-foreign" {
            let b = self.foreign_port()?;
            self.set("port", &b.to_string())?;
            let (ok, value) = self.command(&["server", "restart"])?;
            self.expect(
                "occupied B new launch fails",
                !ok && value["error"]
                    .as_str()
                    .is_some_and(|e| e.contains("exited before ready")),
            );
            let old_clean = self.natural(0, true)?;
            self.expect("failed new launch naturally cleaned old A", old_clean);
            // The failed launch's root may already be gone, but this retained
            // job positively accounts for its unpublished collector and tree.
            let job = self
                .commands
                .last()
                .ok_or("restart command missing")?
                .owner
                .process_handle()
                .ok_or("restart job missing")?;
            let empty = job.wait_exited(EXIT_BOUND);
            self.evidence
                .push(serde_json::json!({"natural_failed_new_job_empty":empty}));
            self.expect("failed new launch job naturally empty", empty);
            self.expect("failed new launch state absent", !self.state().exists());
            let directory = PathBuf::from(public_io(fs::read_to_string(
                self.file("launcher-1-directory.txt"),
            ))?);
            self.expect("failed new launch staging absent", !directory.exists());
            let cfg = self.success(&["config", "get"])?;
            self.expect("failed restart saved B preserved", cfg["port"] == b);
        } else if let Some(negative) = name.strip_prefix("negative-") {
            let original = self.record_file("valid-state", &self.state())?;
            let mut state: Value = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
            match negative {
                "pid" => state["pid"] = std::process::id().into(),
                "executable" => {
                    let other = self.file("different synthetic.exe");
                    public_io(fs::copy(&self.image, &other))?;
                    state["executable"] = other.to_string_lossy().into_owned().into();
                }
                _ => {
                    let url = match negative {
                        "malformed" => "not a URL".into(),
                        "https" => format!("https://127.0.0.1:{port}/v1"),
                        "localhost" => format!("http://localhost:{port}/v1"),
                        "nonloopback" => format!("http://192.0.2.1:{port}/v1"),
                        "noport" => "http://127.0.0.1/v1".into(),
                        "credentials" => format!("http://fixture:fixture@127.0.0.1:{port}/v1"),
                        "query" => format!("http://127.0.0.1:{port}/v1?fixture=1"),
                        "fragment" => format!("http://127.0.0.1:{port}/v1#fixture"),
                        "path" => format!("http://127.0.0.1:{port}/v1/extra"),
                        _ => return Err("unknown negative".into()),
                    };
                    state["url"] = url.into();
                }
            }
            public_io(fs::write(
                self.state(),
                serde_json::to_vec(&state).map_err(|e| e.to_string())?,
            ))?;
            self.record_file("negative-state", &self.state())?;
            let contacts = self.contacts();
            let (_, status) = self.command(&["server", "status"])?;
            self.expect(
                "invalid state status is not healthy",
                status["state"] != "running",
            );
            let (ok, _) = self.command(&["server", "stop"])?;
            self.expect("invalid state stop refuses", !ok);
            if negative == "credentials" {
                let (ok, _) = self.command(&["server", "restart"])?;
                self.expect("invalid state restart refuses", !ok);
            }
            self.expect(
                "invalid state cannot signal retained tree",
                self.launches[0]
                    .processes
                    .iter()
                    .all(PublicProcess::running),
            );
            self.expect(
                "invalid state never contacts B",
                contacts == self.contacts(),
            );
            self.expect(
                "query-only foreign handle remains live",
                self.foreign_process
                    .as_ref()
                    .is_some_and(PublicProcess::running),
            );
            // A mismatched state cannot invent a live binding for this file.
            if negative == "pid" || negative == "executable" {
                state["model"] = self
                    .file("models/unrelated.gguf")
                    .to_string_lossy()
                    .into_owned()
                    .into();
                public_io(fs::write(
                    self.state(),
                    serde_json::to_vec(&state).map_err(|e| e.to_string())?,
                ))?;
                let (ok, _) = self.command(&["models", "delete", "unrelated.gguf"])?;
                self.expect(
                    "stale state does not protect unrelated file",
                    ok && !self.file("models/unrelated.gguf").exists(),
                );
            }
            public_io(fs::write(self.state(), original))?;
            self.stop_and_observe(0)?;
        } else if name.starts_with("f2-") {
            if name == "f2-legacy" {
                let legacy = self.file("profile/local/aiolm/headless-state.json");
                public_io(fs::create_dir_all(legacy.parent().ok_or("legacy parent")?))?;
                public_io(fs::rename(self.state(), legacy))?;
            }
            self.set(
                "active_model",
                &self.file("models/replacement.gguf").to_string_lossy(),
            )?;
            let cfg = self.success(&["config", "get"])?;
            public_require(
                cfg["active_model"]
                    == self
                        .file("models/replacement.gguf")
                        .to_string_lossy()
                        .as_ref(),
                "replacement selection",
            )?;
            let target = if name == "f2-primary" || name == "f2-relative-primary" {
                self.file("models/running-00001-of-00002.gguf")
            } else {
                self.file("models/running-00002-of-00002.gguf")
            };
            if name == "f2-relative-primary" {
                let before = self.record_file("relative-primary-before", &target)?;
                let (ok, _) = self.command(&["models", "delete", "running-00001-of-00002.gguf"])?;
                self.expect(
                    "relative running primary refused",
                    !ok && fs::read(&target).ok().as_deref() == Some(&before),
                );
            } else if name == "f2-alias" {
                let alias = self.file("models").join("alias");
                self.aliases.push(alias.clone());
                let output = public_io(
                    Command::new("cmd")
                        .args(["/c", "mklink", "/J"])
                        .arg(&alias)
                        .arg(self.file("models"))
                        .output(),
                )?;
                self.evidence.push(serde_json::json!({"junction_argv":["cmd","/c","mklink","/J",alias.to_str().ok_or("alias UTF8")?,self.file("models").to_str().ok_or("target UTF8")?],
                    "exit":output.status.code(),"stdout":public_bytes(&output.stdout),"stderr":public_bytes(&output.stderr)}));
                public_require(output.status.success(), "junction creation")?;
                let alias_target = alias.join("running-00002-of-00002.gguf");
                public_require(
                    public_io(fs::canonicalize(&alias_target))?
                        == public_io(fs::canonicalize(&target))?,
                    "canonical shard alias",
                )?;
                self.evidence.push(serde_json::json!({"alias":alias_target,"canonical":public_io(fs::canonicalize(&alias_target))?}));
                self.refused_file(&alias_target, "running canonical shard alias refused", true)?;
            } else {
                self.refused_file(&target, "running primary/shard refused", true)?;
            }
            let (ok, _) = self.command(&["models", "delete", "unrelated.gguf"])?;
            self.expect(
                "unrelated deletion remains allowed",
                ok && !self.file("models/unrelated.gguf").exists(),
            );
            self.snapshot_controls(true)?;
            self.stop_and_observe(0)?;
            self.snapshot_controls(false)?;
            let after = self.success(&["config", "get"])?;
            self.expect("replacement config preserved", after == cfg);
        } else {
            return Err("unknown public case".into());
        }
        Ok(())
    }
    fn snapshot_controls(&mut self, running: bool) -> PublicResult<()> {
        let snapshot =
            self.file("models/hf/example/model/snapshots/0000000000000000000000000000000000000000");
        if running {
            public_io(fs::create_dir_all(snapshot.join("nested")))?;
            let config = br#"{"architectures":["LlamaForCausalLM"],"model_type":"llama"}"#;
            for (name, bytes) in [
                ("config.json", &config[..]),
                ("model.safetensors", &b"0000000000000000"[..]),
                ("nested/tokenizer.json", &b"{}"[..]),
                ("user-notes.txt", &b"kept"[..]),
            ] {
                public_io(fs::write(snapshot.join(name), bytes))?;
            }
            let manifest = serde_json::json!({"format":1,"repository":"example/model","revision":"0000000000000000000000000000000000000000","complete":true,
                "files":[{"path":"config.json","size":59},{"path":"model.safetensors","size":16},{"path":"nested/tokenizer.json","size":2}]});
            public_io(fs::write(
                snapshot.join(".aiolm-snapshot.json"),
                serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
            ))?;
            let (ok, value) = self.command(&["models", "delete", &snapshot.to_string_lossy()])?;
            self.expect(
                "live snapshot refusal preserved",
                !ok && value["error"]
                    .as_str()
                    .is_some_and(|e| e.contains("stop the headless server"))
                    && snapshot.join("model.safetensors").exists(),
            );
        } else {
            let (ok, value) = self.command(&["models", "delete", &snapshot.to_string_lossy()])?;
            self.expect(
                "stopped snapshot removes only owned files",
                ok && value["unlisted_files_preserved"] == true
                    && !snapshot.join("model.safetensors").exists()
                    && !snapshot.join("nested").exists(),
            );
        }
        self.expect(
            "snapshot unlisted bytes preserved",
            fs::read(snapshot.join("user-notes.txt")).ok().as_deref() == Some(&b"kept"[..]),
        );
        Ok(())
    }
    fn saved_controls(&mut self) -> PublicResult<()> {
        for (key, name) in [
            ("active_model", "running-00001-of-00002.gguf"),
            ("mmproj", "projector.mmproj"),
            ("spec_draft_model", "draft.gguf"),
        ] {
            self.set(key, &self.file(&format!("models/{name}")).to_string_lossy())?;
            self.refused_file(
                &self.file(&format!("models/{name}")),
                &format!("saved {key} refused"),
                true,
            )?;
        }
        let adapter = self.file("models/adapter.gguf");
        let enabled = serde_json::json!([{"path":adapter,"scale":1.0,"enabled":true}]);
        self.set("lora_adapters", &enabled.to_string())?;
        self.refused_file(&adapter, "saved enabled LoRA refused", false)?;
        let disabled = serde_json::json!([{"path":adapter,"scale":1.0,"enabled":false}]);
        self.set("lora_adapters", &disabled.to_string())?;
        let (ok, _) = self.command(&["models", "delete", &adapter.to_string_lossy()])?;
        self.expect("disabled LoRA deletion allowed", ok && !adapter.exists());
        let outside = self.file("outside-library.gguf");
        public_io(fs::write(&outside, b"synthetic containment negative\n"))?;
        self.refused_file(&outside, "absolute containment refused", false)?;
        let (ok, _) = self.command(&["models", "delete", "../outside-library.gguf"])?;
        self.expect("relative containment refused", !ok && outside.exists());
        let wrong = self.file("models/wrong.txt");
        public_io(fs::write(&wrong, b"synthetic extension negative\n"))?;
        self.refused_file(&wrong, "wrong extension refused", false)?;
        let unowned = self.file("models/external-snapshot");
        public_io(fs::create_dir_all(&unowned))?;
        public_io(fs::write(unowned.join("user-notes.txt"), b"kept"))?;
        let (ok, _) = self.command(&["models", "delete", &unowned.to_string_lossy()])?;
        self.expect(
            "unowned snapshot refused",
            !ok && unowned.join("user-notes.txt").exists(),
        );
        let (ok, _) =
            self.command(&["models", "delete", &self.file("models").to_string_lossy()])?;
        self.expect(
            "library root deletion refused",
            !ok && self.file("models").is_dir(),
        );
        Ok(())
    }
    fn finish_checked(&mut self) -> Vec<String> {
        if self.finished {
            return vec![];
        }
        self.phase("cleanup");
        self.finished = true;
        let mut errors = vec![];
        if !self.owns_home {
            self.evidence
                .push(serde_json::json!({"owns_home":false,"unowned_root_untouched":true}));
            return errors;
        }
        // This snapshot precedes every forced termination, including setup
        // errors and unwind, so harness reclamation cannot masquerade as stop.
        let files_in = |path: &Path| -> PublicResult<Vec<PathBuf>> {
            match fs::read_dir(path) {
                Ok(entries) => public_io(entries.map(|entry| entry.map(|e| e.path())).collect()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
                Err(error) => Err(error.to_string()),
            }
        };
        let cli_entries = files_in(&self.file("cli"));
        let temp_entries = files_in(&self.file("profile/temp"));
        let staging_entries = files_in(&self.file("runtimes/launch-staging"));
        for result in [&cli_entries, &temp_entries, &staging_entries] {
            if let Err(error) = result {
                errors.push(error.clone());
            }
        }
        self.evidence.push(serde_json::json!({"before_forced_harness_cleanup":{
            "home_exists":self.home.exists(),"current_state_exists":self.state().exists(),
            "legacy_state_exists":self.file("profile/local/aiolm/headless-state.json").exists(),
            "command_lock_exists":self.file("cli/headless-state.lock").exists(),
            "cli_entries":cli_entries,"temp_entries":temp_entries,
            "staging_entries":staging_entries,
            "launches":self.launches.iter().map(|launch|serde_json::json!({
                "processes":launch.processes.iter().map(|p|serde_json::json!({"pid":p.pid,"running":p.running()})).collect::<Vec<_>>(),
                "directory":launch.directory,"directory_exists":launch.directory.exists(),
                "marker_exists":launch.directory.join(".aiolm-launch.json").exists(),
                "owner_lock_exists":launch.directory.join(".aiolm-launch.lock").exists()})).collect::<Vec<_>>()}}));
        for command in &mut self.commands {
            if let Err(e) = command.finish_checked() {
                errors.push(e);
            }
        }
        self.evidence.push(serde_json::json!({"checked_commands":self.commands.iter().map(|c| serde_json::json!({
            "root_pid":c.owner.id(),"exit_after_cleanup":c.root_exit,"streams_done":c.streams_done,
            "stdout":c.stdout.as_ref().and_then(|r|r.result.as_ref()).map(|r|r.as_ref().map(|b|public_bytes(b)).map_err(String::as_str)),
            "stderr":c.stderr.as_ref().and_then(|r|r.result.as_ref()).map(|r|r.as_ref().map(|b|public_bytes(b)).map_err(String::as_str)),
            "job_empty":c.owner.process_handle().is_some_and(|job|job.wait_exited(Duration::ZERO))})).collect::<Vec<_>>()}));
        let deadline = Instant::now() + EXIT_BOUND;
        for launch in &self.launches {
            for process in &launch.processes {
                if !process.exited(deadline) {
                    errors.push(format!(
                        "retained PID {} survived harness cleanup",
                        process.pid
                    ));
                }
            }
        }
        if self.recover_interrupted_start {
            if let Err(error) = self.auxiliary_recover_interrupted_start_lock() {
                errors.push(error);
            }
        }
        let contacts = self.contacts();
        let foreign_live = self
            .foreign_process
            .as_ref()
            .is_some_and(PublicProcess::running);
        let foreign_health = self
            .foreign
            .as_ref()
            .is_none_or(|f| get(f.port, "/health").is_some_and(|s| s.contains("ok")));
        self.evidence.push(serde_json::json!({"before_forced_foreign_stop":{"contacts":contacts,"test_process_running":foreign_live,"health":foreign_health}}));
        if self.foreign.is_some() && (!foreign_live || !foreign_health) {
            errors.push("foreign service damaged".into());
        }
        if let Some(foreign) = &mut self.foreign {
            if let Err(e) = foreign.stop_checked() {
                errors.push(e);
            }
            self.evidence
                .push(serde_json::json!({"foreign_listener_stop":foreign.stop_evidence}));
        }
        for alias in &self.aliases {
            if alias.exists() {
                if let Err(e) = fs::remove_dir(alias) {
                    errors.push(e.to_string());
                }
            }
        }
        // Record all remaining synthetic files before removing the unique root.
        fn inventory(path: &Path, entries: &mut Vec<Value>) -> PublicResult<()> {
            if !path.exists() {
                return Ok(());
            }
            for entry in public_io(fs::read_dir(path))? {
                let entry = public_io(entry)?;
                let metadata = public_io(fs::symlink_metadata(entry.path()))?;
                use std::os::windows::fs::MetadataExt;
                public_require(
                    metadata.file_attributes() & 0x400 == 0,
                    "reparse point in unique home",
                )?;
                if metadata.is_dir() {
                    inventory(&entry.path(), entries)?;
                } else {
                    let raw = if entry.path().extension().is_some_and(|e| e == "exe") {
                        public_executable_digest(&entry.path())?
                    } else {
                        public_bytes(&public_io(fs::read(entry.path()))?)
                    };
                    entries.push(serde_json::json!({"path":entry.path(),"raw":raw}));
                }
            }
            Ok(())
        }
        let mut entries = vec![];
        if let Err(e) = inventory(&self.home, &mut entries) {
            errors.push(e);
        }
        let debris: Vec<_> = entries
            .iter()
            .filter(|e| {
                e["path"].as_str().is_some_and(|p| {
                    p.ends_with("headless-state.lock")
                        || p.ends_with(".part")
                        || p.contains("aiolm-api-key-")
                })
            })
            .cloned()
            .collect();
        if !debris.is_empty() {
            errors.push("command lock, part, or key debris".into());
        }
        self.evidence.push(serde_json::json!({"forced_harness_cleanup":{"files_before_root_removal":entries,"debris":debris,"all_native_exits":errors.is_empty()}}));
        // Never follow a reparse point, and never recursively remove outside this root.
        if errors.is_empty() && self.home.exists() {
            match fs::canonicalize(&self.home) {
                Ok(root)
                    if fs::canonicalize(std::env::temp_dir())
                        .is_ok_and(|temp| root.starts_with(temp))
                        && root.file_name() == self.home.file_name() =>
                {
                    if let Err(e) = fs::remove_dir_all(&self.home) {
                        errors.push(e.to_string());
                    }
                }
                _ => errors.push("unique home boundary verification failed".into()),
            }
        }
        if self.home.exists() {
            errors.push("unique home remains".into());
        }
        self.evidence.push(
            serde_json::json!({"checked_root_absent":!self.home.exists(),"cleanup_errors":errors}),
        );
        errors
    }
}
impl Drop for PublicCase {
    fn drop(&mut self) {
        for error in self.finish_checked() {
            eprintln!("public CLI cleanup: {error}");
        }
    }
}

async fn prepared_public_cli_regressions() {
    let parent = std::env::var_os("AIOLM_CLI_FIXTURE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    fs::create_dir_all(&parent).expect("create synthetic evidence parent");
    let evidence_root = parent.join(format!("aiolm-public-evidence-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&evidence_root).expect("create exclusive public evidence directory");
    let mut failures = vec![];
    let mut summaries = vec![];
    for name in [
        "status-route-unchanged",
        "status-route-next",
        "status-route-legacy-next",
        "status-route-no-engine-unchanged",
        "harness-early-error",
        "harness-unwind",
        "unchanged",
        "drift-stop",
        "legacy-drift",
        "restart-free",
        "restart-foreign",
        "negative-malformed",
        "negative-https",
        "negative-localhost",
        "negative-nonloopback",
        "negative-noport",
        "negative-credentials",
        "negative-query",
        "negative-fragment",
        "negative-path",
        "negative-pid",
        "negative-executable",
        "f2-primary",
        "f2-relative-primary",
        "f2-shard",
        "f2-alias",
        "f2-legacy",
        "saved-controls",
    ] {
        let mut case = PublicCase::new();
        case.config_through_cli = name == "status-route-unchanged";
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> PublicResult<()> {
                let port = case.setup_with_status_route(name.starts_with("status-route-"))?;
                case.phase("behavior");
                case.behavior(name, port)
            }));
        let cleanup = case.finish_checked();
        let observed_error = match result {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(_) => Some("fixture unwound".into()),
        };
        let setup_error = if name == "harness-early-error" {
            case.expect(
                "injected early error caught",
                observed_error.as_deref()
                    == Some("injected after outer owner registration before readers"),
            );
            None
        } else if name == "harness-unwind" {
            case.expect(
                "injected unwind caught",
                observed_error.as_deref() == Some("fixture unwound"),
            );
            None
        } else {
            observed_error.clone()
        };
        let failed: Vec<_> = case
            .expectations
            .iter()
            .filter(|(_, ok)| !ok)
            .map(|(label, _)| label.clone())
            .collect();
        let timings = case.timings();
        let failed_case = setup_error.is_some() || !cleanup.is_empty() || !failed.is_empty();
        summaries.push(serde_json::json!({"case":name,"failed":failed_case,"timings":timings}));
        let evidence = serde_json::json!({"case":name,"timings":timings,"observed_error":observed_error,"setup_error":setup_error,"cleanup_errors":cleanup,"expectations":case.expectations,"observations":case.evidence});
        fs::write(
            evidence_root.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&evidence).expect("serialize evidence"),
        )
        .expect("persist evidence");
        eprintln!(
            "public CLI {name}: setup={setup_error:?}, cleanup={cleanup:?}, behavior={failed:?}"
        );
        if failed_case {
            failures.push(name);
        }
    }
    fs::write(
        evidence_root.join("summary.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "cases":summaries,"failed_cases":failures
        }))
        .expect("serialize public timing summary"),
    )
    .expect("persist public timing summary");
    assert!(
        failures.is_empty(),
        "public CLI cases failed: {failures:?}; evidence {}",
        evidence_root.display()
    );
}

#[tokio::test]
async fn headless_start_owns_a_launcher_descendant_listener_and_only_that_listener() {
    let _auxiliary_contracts = configured_file_retention_contracts().await;
    prepared_public_cli_regressions().await;
    let area = TestHome::new();
    let home = area.path.clone();
    let root = providers::registry::root();
    // A launcher named like neither llama-server nor any known engine, so no
    // name can stand in for the ownership proof.
    let image = home.join(format!(
        "synthetic launcher{}",
        std::env::consts::EXE_SUFFIX
    ));
    fs::copy(env!("CARGO_BIN_EXE_fake-llama-server"), &image).unwrap();
    let engine = image.to_string_lossy().into_owned();
    let model = home.join("synthetic model.bin");
    fs::write(&model, b"synthetic model").unwrap();
    let state_file = home.join("cli").join("headless-state.json");
    let record = |name: &str| home.join(format!("{name}.json"));
    let environment = |name: &str| {
        BTreeMap::from([
            (
                "FAKE_LAUNCHER_RECORD".to_string(),
                record(name).to_string_lossy().into_owned(),
            ),
            (
                "FAKE_RESOURCE_RECORD".to_string(),
                home.join(format!("{name}-directory.txt"))
                    .to_string_lossy()
                    .into_owned(),
            ),
        ])
    };
    let serving = [
        "--adapter-resource-fixture",
        "--adapter-staging-log-fixture",
        "--adapter-engine",
        "--adapter-no-health-auth",
    ];
    for (runtime, behaviour, resources) in [
        ("launcher-1", &serving[..], true),
        (
            "holder-1",
            &[
                "--adapter-resource-fixture",
                "--adapter-hold-fixture",
                "--adapter-engine",
                "--adapter-no-health-auth",
            ][..],
            true,
        ),
        (
            "failing-1",
            &["--adapter-resource-fixture", "--fake-startup-failure"][..],
            true,
        ),
    ] {
        let mut prefix = vec!["--adapter-launcher-fixture".to_string()];
        prefix.extend(behaviour.iter().map(|arg| arg.to_string()));
        let draft = draft(
            &engine,
            &engine,
            runtime,
            prefix,
            environment(runtime),
            resources,
        );
        runtime_schema::register_entrypoint(&root, &draft, None)
            .await
            .unwrap();
    }
    let staged = |name: &str| {
        PathBuf::from(fs::read_to_string(home.join(format!("{name}-directory.txt"))).unwrap())
    };

    // The listener is the launcher's child. Start must prove it owned and
    // return, leaving the server running and serving after the CLI exits.
    let port = free_port();
    select(&model, "launcher-1", port);
    let mut start = Running::spawn(cli(&home, &["server", "start"]));
    let finished = start.finish_within(START_BOUND);
    let first = Tree::read(&record("launcher-1"), Some(&image));
    let Some((started, value)) = finished else {
        // Record what the descendant was serving, then stop the CLI and the
        // reported tree before failing.
        let served = get(port, "/v1/models");
        drop(start);
        drop(first);
        panic!("headless start did not accept its launcher's descendant listener within {START_BOUND:?}; the descendant served: {served:?}")
    };
    assert!(started, "headless start failed: {value}");
    let first = first.expect("the started launcher reported its tree");
    assert_eq!(value["state"], "running");
    assert_eq!(
        value["pid"].as_u64(),
        Some(u64::from(unsafe {
            windows_sys::Win32::System::Threading::GetProcessId(first.launcher.0)
        }))
    );
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        first.running(),
        "the launcher and its listener must outlive the CLI that started them"
    );
    let served = get(port, "/v1/models").unwrap_or_default();
    assert!(served.contains("fake-model"), "{served}");
    let first_directory = staged("launcher-1");
    assert!(first_directory.join("effective-config.json").is_file());
    let status = cli(&home, &["server", "status"]).output().unwrap();
    assert_eq!(json(&status)["state"], "running", "{status:?}");
    // Entries recovery must never reclaim: no owner record, an owner record
    // without a lock (an earlier release or another tool), a file, and a
    // junction whose target carries a complete owner record.
    let staging = first_directory.parent().unwrap().to_path_buf();
    let foreign_data = foreign_staging(&staging, &home);
    // A launch preparation is the recovery boundary. The persistent server
    // released by its exited CLI keeps its directory.
    drop(launch_resources::prepare(None, &mut Vec::new()).unwrap());
    assert!(first_directory.join("effective-config.json").is_file());

    // Restart replaces exactly that tree and its launch directory.
    fs::remove_file(record("launcher-1")).unwrap();
    let restarted = cli(&home, &["server", "restart"]).output().unwrap();
    assert!(restarted.status.success(), "restart failed: {restarted:?}");
    assert!(
        first.exits_within(EXIT_BOUND),
        "restart left the previous launcher tree running"
    );
    assert!(!first_directory.exists(), "restart left the old directory");
    let second = Tree::wait(&record("launcher-1"), Some(&image));
    assert!(second.running());
    let second_directory = staged("launcher-1");
    assert!(second_directory.join("effective-config.json").is_file());
    assert!(get(port, "/v1/models")
        .unwrap_or_default()
        .contains("fake-model"));

    // A file still held at stop fails the removal, not the ownership: the
    // state and owner record remain, and repeating stop finishes cleanup.
    let held = hold(&second_directory.join("held.log"));
    let blocked = cli(&home, &["server", "stop"]).output().unwrap();
    assert!(!blocked.status.success(), "{blocked:?}");
    assert!(
        second.exits_within(EXIT_BOUND),
        "stop left the launcher or its listener running"
    );
    assert!(state_file.exists(), "a failed cleanup dropped the state");
    assert!(second_directory.join(".aiolm-launch.json").is_file());
    drop(held);
    let stopped = cli(&home, &["server", "stop"]).output().unwrap();
    assert!(stopped.status.success(), "stop failed: {stopped:?}");
    assert!(!second_directory.exists(), "stop left the launch directory");
    assert!(!state_file.exists());
    assert!(get(port, "/health").is_none(), "the port is still served");

    // Desktop unload of the same launcher: its listener still holds the
    // engine log in the launch directory when termination starts. The whole
    // directory, owner record included, is gone once unload returns.
    let cfg = select(&model, "launcher-1", port);
    for _ in 0..3 {
        fs::remove_file(record("launcher-1")).unwrap();
        let ring = Arc::new(aiolm_lib::ErrBuf::default());
        let (child, _, _) = aiolm_lib::server::spawn(&cfg, "", &ring, &Default::default()).unwrap();
        let mut owned = Some(child);
        let tree = Tree::wait(&record("launcher-1"), Some(&image));
        let deadline = Instant::now() + START_BOUND;
        while get(port, "/health").is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let directory = staged("launcher-1");
        assert!(directory.join("engine.log").is_file());
        aiolm_lib::server::kill(&mut owned, Some(ring));
        let remaining: Vec<_> = fs::read_dir(&directory)
            .map(|entries| entries.flatten().map(|entry| entry.file_name()).collect())
            .unwrap_or_default();
        assert!(
            !directory.exists(),
            "unload left {} with {remaining:?}",
            directory.display()
        );
        assert!(tree.exits_within(EXIT_BOUND));
        assert!(get(port, "/health").is_none());
    }
    // A file still held when unload removes the directory (here by this
    // test, as an engine that is slow to exit would) must not cost the owner
    // record: the next launch preparation finishes the removal once the file
    // is released.
    fs::remove_file(record("launcher-1")).unwrap();
    let ring = Arc::new(aiolm_lib::ErrBuf::default());
    let (child, _, _) = aiolm_lib::server::spawn(&cfg, "", &ring, &Default::default()).unwrap();
    let mut owned = Some(child);
    let tree = Tree::wait(&record("launcher-1"), Some(&image));
    let deadline = Instant::now() + START_BOUND;
    while get(port, "/health").is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let directory = staged("launcher-1");
    let held = hold(&directory.join("held.log"));
    aiolm_lib::server::kill(&mut owned, Some(ring));
    assert!(tree.exits_within(EXIT_BOUND));
    for name in [".aiolm-launch.json", ".aiolm-launch.lock", "held.log"] {
        assert!(
            directory.join(name).is_file(),
            "unload removed {name} while a file was held"
        );
    }
    drop(held);
    drop(launch_resources::prepare(None, &mut Vec::new()).unwrap());
    assert!(!directory.exists(), "recovery did not finish the removal");

    // An unrelated process answers readiness on the configured port while
    // the launched tree runs without listening. Readiness reaches the model
    // check repeatedly and still never accepts that listener.
    let foreign = ForeignServer::start();
    select(&model, "holder-1", foreign.port);
    let mut start = Running::spawn(cli(&home, &["server", "start"]));
    let held = Tree::wait(&record("holder-1"), Some(&image));
    let deadline = Instant::now() + START_BOUND;
    while foreign.model_checks.load(Ordering::Acquire) < 3 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(foreign.model_checks.load(Ordering::Acquire) >= 3);
    let refused = start.finish_within(Duration::from_secs(2));
    assert!(
        refused.is_none(),
        "a foreign listener ended the start: {refused:?}"
    );
    assert!(!state_file.exists(), "a foreign listener produced state");
    assert!(held.running());
    // A concurrent launch preparation leaves this live start's directory.
    let interrupted = staged("holder-1");
    drop(launch_resources::prepare(None, &mut Vec::new()).unwrap());
    assert!(interrupted.join("effective-config.json").is_file());
    // Terminating the CLI before readiness (no destructor runs) still
    // reclaims the launcher and its descendant.
    start.child.kill().unwrap();
    start.child.wait().unwrap();
    assert!(
        held.exits_within(EXIT_BOUND),
        "terminating the CLI left its launched tree running"
    );
    assert!(!state_file.exists());
    drop(foreign);
    // No destructor ran, so the interrupted start's directory remains until
    // the next launch preparation in this home.
    assert!(interrupted.is_dir(), "{}", interrupted.display());
    // Another live launch (this test process) holds its own directory
    // across that boundary.
    let mut live_env = Vec::new();
    let live = launch_resources::prepare(
        Some(Request {
            version: 1,
            directory_env: "SYNTHETIC_LIVE_DIRECTORY".into(),
        }),
        &mut live_env,
    )
    .unwrap()
    .unwrap();
    let live_directory = PathBuf::from(&live_env[0].1);

    // The launched server fails before readiness: the CLI reports it and
    // leaves no process, state or launch directory.
    select(&model, "failing-1", free_port());
    let failed = cli(&home, &["server", "start"]).output().unwrap();
    assert!(!failed.status.success(), "{failed:?}");
    let error = json(&failed)["error"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(error.contains("exited before ready"), "{error}");
    let value: Value = serde_json::from_slice(&fs::read(record("failing-1")).unwrap()).unwrap();
    for key in ["launcher", "server"] {
        let pid = value[key].as_u64().unwrap() as u32;
        assert!(Process::gone(pid, &image), "failed start left {key} {pid}");
    }
    assert!(
        !staged("failing-1").exists(),
        "failed start left its directory"
    );
    assert!(!state_file.exists());
    // That start was the recovery boundary for the interrupted directory.
    assert!(
        !interrupted.exists(),
        "the next start did not reclaim the interrupted start's directory"
    );
    assert!(live_directory.is_dir(), "recovery removed a live launch");
    drop(live);
    assert!(!live_directory.exists());
    foreign_data.assert_preserved();

    // Explicit opt-in: the same journey through an actual venv `python.exe`
    // redirector, whose base interpreter runs this synthetic HTTP script.
    let Some(python) = std::env::var_os("AIOLM_TEST_VENV_PYTHON") else {
        return;
    };
    let script = home.join("synthetic server.py");
    fs::write(
        &script,
        r#"import http.server, json, os, sys
port = int(sys.argv[sys.argv.index("--port") + 1])
with open(os.environ["FAKE_LAUNCHER_RECORD"], "w") as record:
    json.dump({"launcher": os.getppid(), "server": os.getpid()}, record)
bodies = {"/health": b'{"status":"ok"}', "/v1/models": b'{"data":[{"id":"fake-model","object":"model"}]}'}
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = bodies.get(self.path, b"{}")
        self.send_response(200 if self.path in bodies else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
"#,
    )
    .unwrap();
    let python = python.to_string_lossy().into_owned();
    let venv = draft(
        &engine,
        &python,
        "venv-1",
        vec!["-I".into(), script.to_string_lossy().into_owned()],
        environment("venv-1"),
        false,
    );
    runtime_schema::register_entrypoint(&root, &venv, None)
        .await
        .unwrap();
    let port = free_port();
    select(&model, "venv-1", port);
    let mut start = Running::spawn(cli(&home, &["server", "start"]));
    let finished = start.finish_within(START_BOUND);
    let tree = Tree::read(&record("venv-1"), None);
    let Some((started, value)) = finished else {
        let served = get(port, "/v1/models");
        drop(start);
        drop(tree);
        panic!("headless start did not accept the venv interpreter's listener within {START_BOUND:?}; it served: {served:?}")
    };
    assert!(started, "venv headless start failed: {value}");
    let tree = tree.expect("the interpreter reported its redirector and itself");
    assert_eq!(
        value["pid"].as_u64(),
        Some(u64::from(unsafe {
            windows_sys::Win32::System::Threading::GetProcessId(tree.launcher.0)
        })),
        "the started process must be the redirector, not the listening interpreter"
    );
    std::thread::sleep(Duration::from_millis(500));
    assert!(tree.running());
    assert!(get(port, "/v1/models")
        .unwrap_or_default()
        .contains("fake-model"));
    let stopped = cli(&home, &["server", "stop"]).output().unwrap();
    assert!(stopped.status.success(), "venv stop failed: {stopped:?}");
    assert!(tree.exits_within(EXIT_BOUND));
    assert!(get(port, "/health").is_none());
    assert!(!state_file.exists());
}

// Synthetic configured-file retention and publication contracts. No inference.
// All paths, processes, ports and evidence are owned by this sequential fixture.
fn auxiliary_gguf(values: &[(&str, &str)]) -> Vec<u8> {
    fn text(out: &mut Vec<u8>, value: &str) {
        out.extend_from_slice(&(value.len() as u64).to_le_bytes());
        out.extend_from_slice(value.as_bytes());
    }
    let mut out = b"GGUF".to_vec();
    out.extend_from_slice(&3_u32.to_le_bytes());
    out.extend_from_slice(&0_u64.to_le_bytes());
    out.extend_from_slice(&(values.len() as u64).to_le_bytes());
    for (key, value) in values {
        text(&mut out, key);
        out.extend_from_slice(&8_u32.to_le_bytes());
        text(&mut out, value);
    }
    out.resize(out.len().div_ceil(32) * 32, 0);
    out
}

fn auxiliary_pid(value: &Value) -> PublicResult<u32> {
    value
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("missing PID".into())
}

// Acquire query-only identities before validating images; callers immediately
// transfer each handle into PublicCase.launches, including partial setup.
impl PublicProcess {
    fn retain(pid: u32) -> PublicResult<Self> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(format!(
                "retain PID {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self { handle, pid })
    }
    fn image(&self) -> PublicResult<PathBuf> {
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        public_require(
            unsafe { QueryFullProcessImageNameW(self.handle, 0, buffer.as_mut_ptr(), &mut length) }
                != 0,
            "query retained image",
        )?;
        Ok(PathBuf::from(String::from_utf16_lossy(
            &buffer[..length as usize],
        )))
    }
}

fn auxiliary_job_pids(mut contains: impl FnMut(u32) -> bool) -> PublicResult<Vec<u32>> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    public_require(snapshot != INVALID_HANDLE_VALUE, "process snapshot")?;
    struct Snapshot(HANDLE);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let _snapshot = Snapshot(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut valid = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    let mut pids = Vec::new();
    while valid {
        if contains(entry.th32ProcessID) {
            pids.push(entry.th32ProcessID);
        }
        valid = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    Ok(pids)
}

// Resolve the observed Windows console helper from the native system directory,
// never an environment value, development path or executable basename match.
fn auxiliary_console_host_image() -> PublicResult<PathBuf> {
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buffer = vec![0_u16; 32_768];
    let count = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    public_require(
        count > 0 && count < buffer.len() as u32,
        "native system directory query",
    )?;
    let directory = PathBuf::from(String::from_utf16_lossy(&buffer[..count as usize]));
    public_io(fs::canonicalize(directory.join("conhost.exe")))
}

// The injected unwind still requires both real native roles. Additional
// retained members must have the one exact trusted console-host image.
fn auxiliary_exact_native_handles(
    processes: &[PublicProcess],
    engine: &Path,
) -> PublicResult<bool> {
    let engine = public_io(fs::canonicalize(engine))?;
    let cli = public_io(fs::canonicalize(env!("CARGO_BIN_EXE_aiolm-cli")))?;
    let console = auxiliary_console_host_image()?;
    let mut native_count = 0;
    let mut collector_count = 0;
    for (index, process) in processes.iter().enumerate() {
        let image = public_io(fs::canonicalize(process.image()?))?;
        if index == 0 && image != engine {
            return Ok(false);
        }
        if image == engine {
            if !process.running() {
                return Ok(false);
            }
            native_count += 1;
        } else if image == cli {
            if !process.running() {
                return Ok(false);
            }
            collector_count += 1;
        } else if image != console {
            return Ok(false);
        }
    }
    Ok(native_count == 1 && collector_count == 1)
}

#[derive(Clone)]
struct AuxiliaryPlan {
    cwd: PathBuf,
    cli_cwd: PathBuf,
    model: String,
    projector: String,
    draft: String,
    loras: Vec<String>,
    speculative: bool,
    raw: Vec<String>,
    native: bool,
}

#[derive(Debug)]
struct AuxiliarySetupUnwind {
    home: PathBuf,
    outer_pid: u32,
    retained_pids: Vec<u32>,
}
impl AuxiliaryPlan {
    // Deliberately independent of product argument builders. Path values are
    // copied verbatim from the captured input, never slash/case normalized.
    fn argv(&self, port: u16) -> Vec<String> {
        if !self.native {
            let mut result = self.raw.clone();
            result.extend([
                "--model".into(),
                self.model.clone(),
                "--port".into(),
                port.to_string(),
            ]);
            return result;
        }
        let mut result: Vec<String> = [
            "--model",
            &self.model,
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--ctx-size",
            "512",
            "--batch-size",
            "1",
            "--ubatch-size",
            "1",
            "--keep",
            "0",
            "--cache-type-k",
            "f16",
            "--cache-type-v",
            "f16",
            "--flash-attn",
            "off",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        if !self.projector.is_empty() {
            result.extend(["--mmproj".into(), self.projector.clone()]);
        }
        if !self.loras.is_empty() {
            result.extend(["--lora".into(), self.loras.join(",")]);
        }
        result.extend(["--threads".into(), "1".into()]);
        if self.speculative {
            result.extend([
                "--spec-type".into(),
                "draft".into(),
                "--spec-draft-model".into(),
                self.draft.clone(),
            ]);
        }
        result.extend(["--cont-batching".into(), "--no-webui".into()]);
        result.extend(self.raw.clone());
        result.extend(
            [
                "--device",
                "none",
                "--n-gpu-layers",
                "0",
                "--no-kv-offload",
                "--no-op-offload",
                "--no-mmproj-offload",
            ]
            .map(str::to_owned),
        );
        if self.speculative {
            result.extend(
                ["--spec-draft-device", "none", "--spec-draft-ngl", "0"].map(str::to_owned),
            );
        }
        result
    }
    fn opened(&self) -> Vec<(&str, String)> {
        let mut files = vec![("--model", self.model.clone())];
        if self.native {
            if !self.projector.is_empty() {
                files.push(("--mmproj", self.projector.clone()));
            }
            if self.speculative && !self.draft.is_empty() {
                files.push(("--spec-draft-model", self.draft.clone()));
            }
            files.extend(self.loras.iter().cloned().map(|p| ("--lora", p)));
        }
        files
    }
}

impl PublicCase {
    fn auxiliary_command_at(&mut self, cwd: &Path, args: &[&str]) -> PublicResult<(bool, Value)> {
        let mut command = self.isolated_cli(args);
        command.current_dir(cwd);
        let started = Instant::now();
        let index = self.commands.len();
        self.commands.push(PublicCommand::spawn(command)?);
        let result = self.commands[index]
            .init_readers()
            .and_then(|()| self.commands[index].output());
        match result {
            Ok(output) => {
                let value =
                    serde_json::from_slice::<Value>(&output.stdout).map_err(|e| e.to_string());
                self.evidence.push(serde_json::json!({"argv":args,"phase":self.phase,"cwd":cwd,"elapsed_ms":started.elapsed().as_millis(),"exit":output.status.code(),"stdout":public_bytes(&output.stdout),"stderr":public_bytes(&output.stderr),"json":value}));
                Ok((output.status.success(), value?))
            }
            Err(error) => {
                self.evidence.push(serde_json::json!({"argv":args,"phase":self.phase,"cwd":cwd,"elapsed_ms":started.elapsed().as_millis(),"error":error}));
                Err(error)
            }
        }
    }
    fn auxiliary_clear(&mut self) -> PublicResult<()> {
        self.set(
            "active_model",
            &self.file("models/replacement.gguf").to_string_lossy(),
        )?;
        for (key, value) in [
            ("mmproj", ""),
            ("spec_type", "none"),
            ("spec_draft_model", ""),
            ("lora_adapters", "[]"),
        ] {
            self.set(key, value)?;
        }
        Ok(())
    }
    fn auxiliary_setup(&mut self, mode: &str) -> PublicResult<(u16, AuxiliaryPlan)> {
        // Retain one complete config-set journey, and the real long command
        // line in the oversize contract; other scenarios vary ownership/files.
        self.config_through_cli = matches!(mode, "enabled" | "oversize");
        let port = self.setup()?;
        let runtime = self.file("runtimes/local_aux67-cpu");
        public_io(fs::create_dir_all(&runtime))?;
        public_io(fs::write(
            runtime.join(".auxiliary-native-fixture"),
            b"owned synthetic fixture",
        ))?;
        for name in ["llama-server.exe", "llama-bench.exe"] {
            public_io(fs::copy(
                env!("CARGO_BIN_EXE_fake-llama-server"),
                runtime.join(name),
            ))?;
        }
        let language = auxiliary_gguf(&[("general.architecture", "llama")]);
        let projector = auxiliary_gguf(&[("general.architecture", "clip")]);
        let adapter = auxiliary_gguf(&[
            ("general.architecture", "llama"),
            ("general.type", "adapter"),
            ("adapter.type", "lora"),
        ]);
        for (name, bytes) in [
            ("fake-model.gguf", &language),
            ("draft.gguf", &language),
            ("vision.gguf", &projector),
            ("adapter.gguf", &adapter),
            ("disabled.gguf", &adapter),
        ] {
            public_io(fs::write(self.file(&format!("models/{name}")), bytes))?;
        }
        public_io(fs::create_dir(self.file("other-cwd")))?;
        let native = !matches!(
            mode,
            "ignored-missing"
                | "declared-cwd"
                | "resource-failure"
                | "drive-relative"
                | "descriptor-boundary"
        );
        let configured = !matches!(
            mode,
            "known-empty"
                | "known-empty-old"
                | "state-precedence"
                | "legacy-missing-current"
                | "legacy-null-current"
                | "legacy-missing-old"
                | "legacy-null-old"
                | "legacy-stop-restart"
                | "legacy-stopped-record"
                | "stale-pid"
                | "stale-executable"
                | "activation-failure"
                | "resource-failure"
                | "setup-error"
                | "setup-unwind"
                | "setup-reader-error"
                | "drive-relative"
                | "descriptor-boundary"
        );
        let mut plan = AuxiliaryPlan {
            cwd: public_io(std::env::current_dir())?,
            cli_cwd: public_io(std::env::current_dir())?,
            model: self
                .file("models/fake-model.gguf")
                .to_string_lossy()
                .into_owned(),
            projector: if configured {
                self.file("models/vision.gguf")
                    .to_string_lossy()
                    .into_owned()
            } else {
                String::new()
            },
            draft: if configured {
                self.file("models/draft.gguf")
                    .to_string_lossy()
                    .into_owned()
            } else {
                String::new()
            },
            loras: if configured {
                vec![self
                    .file("models/adapter.gguf")
                    .to_string_lossy()
                    .into_owned()]
            } else {
                vec![]
            },
            speculative: configured && mode != "dormant",
            raw: vec![],
            native,
        };
        if mode == "relative-cwd" {
            plan.cwd = self.home.clone();
            plan.cli_cwd = self.home.clone();
            plan.model = "models/fake-model.gguf".into();
            plan.projector = "models/vision.gguf".into();
            plan.draft = "models/draft.gguf".into();
            plan.loras = vec!["models/adapter.gguf".into()];
        }
        if mode == "slash-spelling" {
            // Deliberately configured forward slashes; argv comparison must
            // distinguish these from the equally resolving backslash spelling.
            plan.model = plan.model.replace('\\', "/");
            plan.projector = plan.projector.replace('\\', "/");
            plan.draft = plan.draft.replace('\\', "/");
            plan.loras = plan.loras.iter().map(|s| s.replace('\\', "/")).collect();
        }
        if mode == "shards" {
            for (role, bytes) in [
                ("main", &language),
                ("vision", &projector),
                ("draft", &language),
                ("adapter", &adapter),
            ] {
                for part in [1, 2] {
                    public_io(fs::write(
                        self.file(&format!("models/{role}-{part:05}-of-00002.gguf")),
                        bytes,
                    ))?;
                }
            }
            plan.model = self
                .file("models/main-00001-of-00002.gguf")
                .to_string_lossy()
                .into_owned();
            plan.projector = self
                .file("models/vision-00001-of-00002.gguf")
                .to_string_lossy()
                .into_owned();
            plan.draft = self
                .file("models/draft-00001-of-00002.gguf")
                .to_string_lossy()
                .into_owned();
            plan.loras = vec![self
                .file("models/adapter-00001-of-00002.gguf")
                .to_string_lossy()
                .into_owned()];
        }
        if matches!(mode, "aliases" | "alias-retarget") {
            let alias = self.file("models/owned-alias");
            self.auxiliary_junction(&alias, &self.file("models"))?;
            plan.model = alias.join("fake-model.gguf").to_string_lossy().into_owned();
            plan.projector = alias.join("vision.gguf").to_string_lossy().into_owned();
            plan.draft = alias.join("draft.gguf").to_string_lossy().into_owned();
            plan.loras = vec![alias.join("adapter.gguf").to_string_lossy().into_owned()];
        }
        if mode == "oversize" {
            let mut deep = self.file("models");
            for _ in 0..10 {
                deep = deep.join("가".repeat(70));
            }
            public_io(fs::create_dir_all(&deep))?;
            plan.loras.clear();
            for i in 0..32 {
                let file = deep.join(format!("adapter-{i:02}.gguf"));
                public_io(fs::write(&file, &adapter))?;
                plan.loras.push(file.to_string_lossy().into_owned());
            }
            public_require(
                plan.loras
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == 32,
                "32 distinct LoRA inputs",
            )?;
        }
        if mode == "ignored-missing" {
            plan.projector = self
                .file("models/missing-projector.gguf")
                .to_string_lossy()
                .into_owned();
            plan.draft = self
                .file("models/missing-draft.gguf")
                .to_string_lossy()
                .into_owned();
        }
        if mode == "drive-relative" {
            let absolute = self
                .file("models/absent.gguf")
                .to_string_lossy()
                .into_owned();
            public_require(
                absolute.as_bytes().get(1) == Some(&b':'),
                "drive letter temp root",
            )?;
            plan.projector = format!("{}:absent-auxiliary.gguf", &absolute[..1]);
        }
        plan.raw = vec![
            "--native-auxiliary-fixture".into(),
            self.file("native-receipt.json")
                .to_string_lossy()
                .into_owned(),
            "--native-ack-fixture".into(),
            self.file("native-ack").to_string_lossy().into_owned(),
        ];
        if mode == "descriptor-boundary" {
            plan.raw.extend([
                "--fixture-unlisted-file".into(),
                self.file("models/unrelated.gguf")
                    .to_string_lossy()
                    .into_owned(),
            ]);
        }
        if matches!(mode, "activation-failure" | "resource-failure") {
            plan.raw.extend([
                "--native-state-directory-fixture".into(),
                self.state().to_string_lossy().into_owned(),
            ]);
        }
        if native {
            self.image = runtime.join("llama-server.exe");
            self.success(&["runtime", "select", "cpu", "local_aux67"])?;
        } else {
            if mode == "declared-cwd" {
                plan.cwd = self.home.clone();
                plan.cli_cwd = self.file("other-cwd");
                plan.model = "models/fake-model.gguf".into();
                plan.projector = "models/vision.gguf".into();
                plan.draft = "models/draft.gguf".into();
                public_io(fs::create_dir(plan.cli_cwd.join("models")))?;
                public_io(fs::write(
                    plan.cli_cwd.join("models/fake-model.gguf"),
                    &language,
                ))?;
            }
            plan.raw.splice(
                0..0,
                [
                    "--adapter-launcher-fixture".into(),
                    "--adapter-resource-fixture".into(),
                    "--adapter-engine".into(),
                    "--adapter-no-health-auth".into(),
                ],
            );
            let mut registration = draft(
                &self.image.to_string_lossy(),
                &self.image.to_string_lossy(),
                "auxiliary-67",
                plan.raw.clone(),
                BTreeMap::from([
                    (
                        "FAKE_LAUNCHER_RECORD".into(),
                        self.file("launcher-1.json").to_string_lossy().into_owned(),
                    ),
                    (
                        "FAKE_RESOURCE_RECORD".into(),
                        self.file("launcher-1-directory.txt")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                ]),
                true,
            );
            if mode == "declared-cwd" {
                registration.working_directory = Some(plan.cwd.to_string_lossy().into_owned());
            }
            let manifest = providers::registry::manifest_from_draft(&registration)
                .map_err(|e| e.to_string())?;
            public_io(fs::write(
                self.file("aux-registration.json"),
                serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
            ))?;
            self.success(&[
                "runtime",
                "register-manifest",
                &self.file("aux-registration.json").to_string_lossy(),
            ])?;
            self.success(&["runtime", "select", ENGINE, "auxiliary-67"])?;
        }
        let mut loras: Vec<Value> = plan
            .loras
            .iter()
            .map(|p| serde_json::json!({"path":p,"scale":1,"enabled":true}))
            .collect();
        loras.push(
            serde_json::json!({"path":self.file("models/disabled.gguf"),"scale":1,"enabled":false}),
        );
        if mode == "oversize" {
            self.auxiliary_oversize_preflight(&plan, port)?;
        }
        let expected = self.configure_fixture(&[
            ("active_model", serde_json::json!(plan.model)),
            ("ngl", serde_json::json!(0)),
            ("ctx_size", serde_json::json!(512)),
            ("batch_size", serde_json::json!(1)),
            ("ubatch_size", serde_json::json!(1)),
            ("keep", serde_json::json!(0)),
            ("cache_type_k", serde_json::json!("f16")),
            ("cache_type_v", serde_json::json!("f16")),
            ("flash_attn", serde_json::json!("off")),
            ("threads", serde_json::json!(1)),
            ("parallel", serde_json::json!(0)),
            ("sleep_idle_seconds", serde_json::json!(-1)),
            ("request_timeout_seconds", serde_json::json!(3600)),
            ("spec_draft_n_max", serde_json::json!(3)),
            ("spec_draft_n_min", serde_json::json!(0)),
            ("spec_draft_p_min", serde_json::json!(0.0)),
            ("spec_draft_p_split", serde_json::json!(0.1)),
            ("mmproj", serde_json::json!(plan.projector)),
            ("spec_draft_model", serde_json::json!(plan.draft)),
            (
                "spec_type",
                serde_json::json!(if plan.speculative { "draft" } else { "none" }),
            ),
            ("lora_adapters", serde_json::json!(loras)),
            (
                "server_args",
                serde_json::json!(if native { plan.raw.as_slice() } else { &[] }),
            ),
        ])?;
        if native {
            let (ok, probe) = self
                .auxiliary_command_at(&plan.cli_cwd, &["runtime", "probe", "cpu", "local_aux67"])?;
            public_require(ok, "native probe command")?;
            public_require(
                probe["state"] == "available"
                    && probe["bench_available"] == true
                    && probe["devices"].as_array().is_some_and(Vec::is_empty),
                "finite native probe",
            )?;
            let flags = probe["flags"].as_array().ok_or("native flags missing")?;
            public_require(
                ["--mmproj", "--lora", "--spec-type", "--spec-draft-model"]
                    .iter()
                    .all(|flag| flags.iter().any(|v| v.as_str() == Some(*flag))),
                "native advertised binding flags",
            )?;
            self.evidence
                .push(serde_json::json!({"native_probe":probe}));
        }
        let configured = self.fixture_readback(&expected)?;
        self.evidence.push(serde_json::json!({"captured_plan":{"cwd":plan.cwd,"cli_cwd":plan.cli_cwd,"model":plan.model,"projector":plan.projector,"draft":plan.draft,"loras":plan.loras,"speculative":plan.speculative,"native":plan.native,"expected_argv":plan.argv(port)},"configured":configured}));
        Ok((port, plan))
    }
    fn auxiliary_junction(&mut self, alias: &Path, target: &Path) -> PublicResult<()> {
        // Register before spawning mklink, including a partially successful setup.
        self.aliases.push(alias.to_path_buf());
        let command_alias: PathBuf = alias.components().collect();
        let command_target: PathBuf = target.components().collect();
        let mut command = Command::new("cmd");
        command
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&command_alias)
            .arg(&command_target)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let index = self.commands.len();
        self.commands.push(PublicCommand::spawn(command)?);
        self.commands[index].init_readers()?;
        let output = self.commands[index].output()?;
        self.evidence.push(serde_json::json!({"junction":alias,"target":target,"command_alias":command_alias,"command_target":command_target,"exit":output.status.code(),"stdout":public_bytes(&output.stdout),"stderr":public_bytes(&output.stderr)}));
        public_require(output.status.success(), "owned junction creation")
    }
    fn auxiliary_oversize_preflight(
        &mut self,
        plan: &AuxiliaryPlan,
        port: u16,
    ) -> PublicResult<()> {
        // Quote every argument conservatively using Windows backslash rules.
        fn quoted(arg: &str) -> String {
            let mut out = String::from("\"");
            let mut slashes = 0;
            for c in arg.chars() {
                if c == '\\' {
                    slashes += 1;
                } else {
                    out.push_str(&"\\".repeat(if c == '\"' { slashes * 2 + 1 } else { slashes }));
                    out.push(c);
                    slashes = 0;
                }
            }
            out.push_str(&"\\".repeat(slashes * 2));
            out.push('"');
            out
        }
        let command_units = |argv: Vec<String>| {
            argv.iter()
                .map(|s| quoted(s))
                .collect::<Vec<_>>()
                .join(" ")
                .encode_utf16()
                .count()
                + 1
        };
        let engine = command_units(
            std::iter::once(self.image.to_string_lossy().into_owned())
                .chain(plan.argv(port))
                .collect(),
        );
        let mut loras: Vec<_> = plan
            .loras
            .iter()
            .map(|p| serde_json::json!({"path":p,"scale":1,"enabled":true}))
            .collect();
        loras.push(
            serde_json::json!({"path":self.file("models/disabled.gguf"),"scale":1,"enabled":false}),
        );
        let cli_units = command_units(vec![
            env!("CARGO_BIN_EXE_aiolm-cli").into(),
            "config".into(),
            "set".into(),
            "lora_adapters".into(),
            serde_json::to_string(&loras).map_err(|e| e.to_string())?,
        ]);
        let lower = serde_json::json!({"working_directory":public_io(fs::canonicalize(&plan.cwd))?,"auxiliary":plan.loras});
        let bytes = serde_json::to_vec_pretty(&lower).map_err(|e| e.to_string())?;
        self.evidence.push(serde_json::json!({"actual_path_rust_serde_preflight":{"engine_utf16_including_nul":engine,"config_utf16_including_nul":cli_units,"lower":public_bytes(&bytes),"distinct_loras":plan.loras.len()}}));
        public_require(
            engine <= 32767 && cli_units <= 32767 && bytes.len() > 65536,
            "actual Windows argv and Rust serde oversize preflight",
        )
    }
    fn auxiliary_launch(
        &mut self,
        plan: &AuxiliaryPlan,
        port: u16,
        mode: &str,
    ) -> PublicResult<(usize, bool, Value)> {
        let index = self.launches.len();
        let command_index = self.commands.len();
        // Retain an outer launch record BEFORE spawn/readers/receipt parsing.
        self.launches.push(PublicLaunch {
            processes: vec![],
            directory: self.file("no-native-resources"),
            port,
        });
        let mut command = self.isolated_cli(&["server", "start"]);
        command.current_dir(&plan.cli_cwd);
        self.commands.push(PublicCommand::spawn(command)?);
        if mode == "setup-reader-error" {
            let owned = &mut self.commands[command_index];
            owned.stdout = Some(PublicReader::spawn(
                owned.owner.stdout.take().ok_or("stdout pipe missing")?,
            )?);
            drop(owned.owner.stderr.take());
            return Err("injected after stdout reader start with stderr closed".into());
        }
        self.commands[command_index].init_readers()?;
        let deadline = Instant::now() + START_BOUND;
        while !self.file("native-receipt.json").is_file() {
            if public_io(std::process::Child::try_wait(
                &mut self.commands[command_index].owner,
            ))?
            .is_some()
            {
                return Err("server exited before native receipt; setup is not product RED".into());
            }
            public_require(Instant::now() < deadline, "native receipt timeout")?;
            std::thread::sleep(Duration::from_millis(10));
        }
        let raw = self.record_file("native-receipt", &self.file("native-receipt.json"))?;
        let receipt: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        let listener = auxiliary_pid(&receipt["pid"])?;
        let process = PublicProcess::retain(listener)?;
        self.launches[index].processes.push(process);
        let job = self.commands[command_index]
            .owner
            .process_handle()
            .ok_or("outer job missing")?;
        for pid in auxiliary_job_pids(|pid| job.contains(pid))? {
            if pid == listener || pid == self.commands[command_index].owner.id() {
                continue;
            }
            let process = PublicProcess::retain(pid)?;
            self.launches[index].processes.push(process);
        }
        if !plan.native {
            let directory = PathBuf::from(public_io(fs::read_to_string(
                self.file("launcher-1-directory.txt"),
            ))?);
            self.launches[index].directory = directory;
        }
        // Before ANY image/argv/byte assertion, persist identities and resource
        // marker bytes in the outer owner. Errors and unwind see the same facts.
        self.evidence.push(serde_json::json!({"retained_before_validation":{"outer":self.commands[command_index].owner.id(),"pids":self.launches[index].processes.iter().map(|p|p.pid).collect::<Vec<_>>(),"listener":listener,"port":port,"resource_directory":self.launches[index].directory}}));
        if !plan.native {
            self.record_file(
                "actual-resource-marker",
                &self.launches[index].directory.join(".aiolm-launch.json"),
            )?;
        }
        if mode == "setup-error" {
            return Err("injected after native handles retained before validation".into());
        }
        if mode == "setup-unwind" {
            let pids: Vec<_> = self.launches[index]
                .processes
                .iter()
                .map(|p| p.pid)
                .collect();
            self.evidence.push(serde_json::json!({"typed_setup_unwind_reached":{"home":self.home,"outer_pid":self.commands[command_index].owner.id(),"retained_pids":pids,"membership":pids.iter().map(|pid|job.contains(*pid)).collect::<Vec<_>>(),"handles_running":self.launches[index].processes.iter().map(PublicProcess::running).collect::<Vec<_>>()}}));
            std::panic::panic_any(AuxiliarySetupUnwind {
                home: self.home.clone(),
                outer_pid: self.commands[command_index].owner.id(),
                retained_pids: pids,
            });
        }
        let cli_image = public_io(fs::canonicalize(env!("CARGO_BIN_EXE_aiolm-cli")))?;
        let engine_image = public_io(fs::canonicalize(&self.image))?;
        let console_image = auxiliary_console_host_image()?;
        let mut image_facts = Vec::new();
        for process in &self.launches[index].processes {
            let queried = process.image();
            let canonical = queried.as_ref().ok().map(fs::canonicalize).transpose();
            image_facts.push(serde_json::json!({
                "pid":process.pid,"queried_image":queried.as_ref().ok(),
                "query_error":queried.as_ref().err(),
                "canonical_image":canonical.as_ref().ok().and_then(|path|path.as_ref()),
                "canonical_error":canonical.as_ref().err().map(ToString::to_string),
                "running":process.running(),"outer_job_member":job.contains(process.pid)
            }));
        }
        let image_record = serde_json::json!({"retained_image_diagnostics":image_facts,
            "expected_cli_raw":env!("CARGO_BIN_EXE_aiolm-cli"),"expected_cli_canonical":cli_image,
            "expected_engine_raw":self.image,"expected_engine_canonical":engine_image,"expected_console_canonical":console_image,
            "outer_owner_pid":self.commands[command_index].owner.id(),"receipt_listener_pid":listener});
        eprintln!("auxiliary owned image diagnostics {image_record}");
        self.evidence.push(image_record);
        let mut collectors = vec![];
        let mut engines = vec![];
        let mut console_hosts = vec![];
        for process in &self.launches[index].processes {
            public_require(
                job.contains(process.pid),
                "retained process escaped outer job",
            )?;
            let image = public_io(fs::canonicalize(process.image()?))?;
            if image == cli_image {
                collectors.push(process.pid);
            } else if image == engine_image {
                engines.push(process.pid);
            } else {
                public_require(image == console_image, "unexpected owned child image")?;
                console_hosts.push(process.pid);
            }
        }
        self.evidence.push(serde_json::json!({"retained_console_hosts":{"canonical_image":console_image,"pids":console_hosts,"all_handles_remain_owned":true}}));
        public_require(
            collectors.len() == 1 && engines.len() == if plan.native { 1 } else { 2 },
            "exact native/launcher/collector tree",
        )?;
        if !plan.native {
            let directory = &self.launches[index].directory;
            let expected_id = directory
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("resource UUID directory")?;
            let marker_path = directory.join(".aiolm-launch.json");
            let binding_started = Instant::now();
            // Spawning resumes the launcher before the parent binds its PID.
            // A descendant receipt alone is not the resource-binding barrier.
            let binding = launch_resource_binding::wait_for_resource_binding(
                expected_id,
                listener,
                &engines,
                deadline,
                || {
                    serde_json::from_slice(&public_io(fs::read(&marker_path))?)
                        .map_err(|error| error.to_string())
                },
                || {
                    self.launches[index]
                        .processes
                        .iter()
                        .filter(|process| {
                            engines.contains(&process.pid) || collectors.contains(&process.pid)
                        })
                        .all(|process| process.running() && job.contains(process.pid))
                },
            )?;
            let marker = binding.marker;
            let root_pid = binding.pid;
            self.evidence.push(serde_json::json!({"resource_marker_binding":{"marker":marker,"pending_observations":binding.pending_observations,"wait_ms":binding_started.elapsed().as_millis(),"within_original_start_bound":Instant::now()<=deadline}}));
            public_require(
                marker["version"] == 1
                    && root_pid != listener
                    && engines.contains(&root_pid)
                    && marker["id"].as_str()
                        == self.launches[index]
                            .directory
                            .file_name()
                            .and_then(|s| s.to_str()),
                "retained actual resource UUID/root PID",
            )?;
        }
        let expected = plan.argv(port);
        // The descendant receives every configured prefix except the launcher
        // control consumed by its parent. No path spelling transformations.
        let actual_expected: Vec<_> = expected
            .iter()
            .filter(|s| s.as_str() != "--adapter-launcher-fixture")
            .cloned()
            .collect();
        public_require(
            receipt["argv"] == serde_json::json!(actual_expected),
            "complete native argv differs literally",
        )?;
        public_require(
            public_io(fs::canonicalize(
                receipt["cwd"].as_str().ok_or("receipt cwd")?,
            ))? == public_io(fs::canonicalize(&plan.cwd))?,
            "actual launched cwd differs",
        )?;
        let files = receipt["files"].as_array().ok_or("opened files")?;
        let opened = plan.opened();
        public_require(files.len() == opened.len(), "opened role count")?;
        for (row, (flag, path)) in files.iter().zip(opened) {
            public_require(
                row["flag"] == flag
                    && row["path"] == path
                    && row["bytes"]
                        == serde_json::json!(public_io(fs::read(plan.cwd.join(&path)))?),
                "actual opened metadata-only GGUF differs",
            )?;
        }
        public_io(fs::write(self.file("native-ack"), b"retained"))?;
        let output = self.commands[command_index].output()?;
        let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        self.evidence.push(serde_json::json!({"start":{"argv":["server","start"],"cwd":plan.cwd,"exit":output.status.code(),"stdout":public_bytes(&output.stdout),"stderr":public_bytes(&output.stderr),"json":value},"verified_receipt":receipt,"collectors":collectors,"engines":engines}));
        if output.status.success() {
            let state_bytes = self.record_file("actual-native-state", &self.state())?;
            let state: Value = serde_json::from_slice(&state_bytes).map_err(|e| e.to_string())?;
            public_require(
                state["model"] == plan.model
                    && value["model"] == plan.model
                    && value["state"] == "running",
                "original primary state/public shape",
            )?;
            public_require(
                state["log_collector"]["pid"] == collectors[0]
                    && engines.contains(&auxiliary_pid(&state["pid"])?),
                "actual state process identities",
            )?;
            public_require(
                if plan.native {
                    state["pid"] == listener
                } else {
                    state["pid"] != listener
                },
                "direct versus descendant listener identity",
            )?;
            let directory = public_io(fs::canonicalize(&plan.cwd))?;
            let mut auxiliary = Vec::<String>::new();
            for path in [&plan.projector, &plan.draft]
                .into_iter()
                .chain(plan.loras.iter())
                .filter(|p| !p.trim().is_empty())
            {
                let name = directory.join(path);
                for retained in std::iter::once(name.clone()).chain(fs::canonicalize(&name).ok()) {
                    let name = retained
                        .into_os_string()
                        .into_string()
                        .map_err(|_| "expected retained path UTF8")?;
                    if !auxiliary.contains(&name) {
                        auxiliary.push(name);
                    }
                }
            }
            let target = fs::canonicalize(directory.join(&plan.model)).ok();
            self.expect(
                "exact configured typed launch metadata",
                state["file_bindings"]["working_directory"] == serde_json::json!(directory)
                    && state["file_bindings"]["auxiliary"] == serde_json::json!(auxiliary)
                    && state["file_bindings"]["model_target"] == serde_json::json!(target),
            );
            self.evidence.push(serde_json::json!({"actual_published_state_bytes":state_bytes.len(),"expected_configured_bindings":{"working_directory":directory,"auxiliary":auxiliary,"model_target":target},"actual_bindings":state["file_bindings"]}));
            if !plan.native {
                let marker: Value = serde_json::from_slice(&public_io(fs::read(
                    self.launches[index].directory.join(".aiolm-launch.json"),
                ))?)
                .map_err(|e| e.to_string())?;
                public_require(
                    marker["version"] == 1
                        && marker["pid"] == state["pid"]
                        && marker["id"].as_str()
                            == self.launches[index]
                                .directory
                                .file_name()
                                .and_then(|s| s.to_str()),
                    "actual UUID/PID resource ownership",
                )?;
            }
            public_require(
                self.launches[index]
                    .processes
                    .iter()
                    .filter(|process| {
                        engines.contains(&process.pid) || collectors.contains(&process.pid)
                    })
                    .all(PublicProcess::running),
                "native tree ended before transfer",
            )?;
            public_require(
                get(port, "/v1/models").is_some_and(|s| s.contains("fake-model")),
                "native ready listener",
            )?;
        }
        Ok((index, output.status.success(), value))
    }
    fn auxiliary_refused_at(
        &mut self,
        cwd: &Path,
        path: &str,
        label: &str,
        action: Option<&str>,
    ) -> PublicResult<()> {
        let target = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.file("models").join(path)
        };
        let before = public_io(fs::read(&target))?;
        self.evidence.push(serde_json::json!({"public_delete_before":{"label":label,"cwd":cwd,"requested":path,"resolved_fixture":target,"raw":public_bytes(&before)}}));
        let (ok, value) = self.auxiliary_command_at(cwd, &["models", "delete", path])?;
        let after = fs::read(&target);
        self.evidence.push(serde_json::json!({"public_delete_after":{"label":label,"requested":path,"raw":after.as_ref().ok().map(|b|public_bytes(b)),"read_error":after.as_ref().err().map(ToString::to_string)}}));
        self.expect(
            label,
            !ok && value["error"].as_str().is_some_and(|e| {
                action.map_or(
                    e.contains("select another") || e.contains("stop the headless"),
                    |s| e.contains(s),
                )
            }) && after.ok().as_deref() == Some(before.as_slice()),
        );
        Ok(())
    }
    fn auxiliary_stop(&mut self, index: usize) -> PublicResult<()> {
        let (ok, value) = self.command(&["server", "stop"])?;
        let natural = self.natural(index, true)?;
        self.expect(
            "natural native/collector/resource cleanup",
            ok && value["state"] == "stopped" && natural,
        );
        Ok(())
    }
    fn auxiliary_behavior(&mut self, mode: &str) -> PublicResult<()> {
        self.recover_interrupted_start =
            matches!(mode, "setup-error" | "setup-unwind" | "setup-reader-error");
        let (port, plan) = self.auxiliary_setup(mode)?;
        self.phase("behavior");
        let (index, ok, value) = self.auxiliary_launch(&plan, port, mode)?;
        if matches!(mode, "oversize" | "activation-failure" | "resource-failure") {
            self.expect(
                "publication error after actual receipt",
                !ok && value["error"].as_str().is_some_and(|e| {
                    if mode == "oversize" {
                        e.contains("headless state exceeds 65536")
                    } else {
                        e.contains("cannot activate")
                    }
                }),
            );
            let job = self
                .commands
                .last()
                .ok_or("start command")?
                .owner
                .process_handle()
                .ok_or("outer job")?;
            let deadline = Instant::now() + EXIT_BOUND;
            let empty = job.wait_exited(deadline.saturating_duration_since(Instant::now()));
            let exits: Vec<_> = self.launches[index]
                .processes
                .iter()
                .map(|p| (p.pid, p.exited(deadline)))
                .collect();
            let closed = TcpStream::connect_timeout(
                &([127, 0, 0, 1], port).into(),
                Duration::from_millis(250),
            )
            .is_err();
            let directory = &self.launches[index].directory;
            let parts: Vec<_> = public_io(fs::read_dir(self.file("cli")))?
                .filter_map(Result::ok)
                .filter(|e| e.path().extension().is_some_and(|e| e == "part"))
                .map(|e| e.path())
                .collect();
            self.evidence.push(serde_json::json!({"publication_before_forced_cleanup":{"empty_job":empty,"retained_exits":exits,"port_closed":closed,"parts":parts,"directory":directory,"directory_absent":!directory.exists(),"sentinel_owned_by_fixture":mode!="oversize"}}));
            self.expect(
                "failed publication reclaimed exact tree and resources",
                empty
                    && exits.iter().all(|(_, gone)| *gone)
                    && closed
                    && !directory.exists()
                    && parts.is_empty(),
            );
            if mode != "oversize" {
                public_require(self.state().is_dir(), "owned state sentinel survives")?;
                public_io(fs::remove_dir(self.state()))?;
            } else {
                self.expect("oversized state not published", !self.state().exists());
            }
            return Ok(());
        }
        public_require(
            ok,
            "real native/custom setup must start before deletion assertions",
        )?;
        let original = public_io(fs::read(self.state()))?;
        let original_value: Value = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
        let cwd = self.file("other-cwd");
        self.auxiliary_clear()?;
        if mode == "state-precedence" {
            let mut old = original_value.clone();
            old.as_object_mut()
                .ok_or("state object")?
                .remove("file_bindings");
            let path = self.file("profile/local/aiolm/headless-state.json");
            public_io(fs::create_dir_all(path.parent().ok_or("legacy parent")?))?;
            public_io(fs::write(
                path,
                serde_json::to_vec_pretty(&old).map_err(|e| e.to_string())?,
            ))?;
        }
        if mode.starts_with("legacy-") {
            let mut legacy = original_value.clone();
            if mode.contains("null") {
                legacy["file_bindings"] = Value::Null;
            } else {
                legacy
                    .as_object_mut()
                    .ok_or("state object")?
                    .remove("file_bindings");
            }
            let old = mode.ends_with("-old");
            let path = if old {
                self.file("profile/local/aiolm/headless-state.json")
            } else {
                self.state()
            };
            public_io(fs::create_dir_all(path.parent().ok_or("old parent")?))?;
            public_io(fs::write(
                &path,
                serde_json::to_vec_pretty(&legacy).map_err(|e| e.to_string())?,
            ))?;
            if old {
                public_io(fs::remove_file(self.state()))?;
            }
            self.auxiliary_refused_at(
                &cwd,
                &self.file("models/unrelated.gguf").to_string_lossy(),
                "legacy unknown action",
                Some("stop and start"),
            )?;
            let (ok, status) = self.command(&["server", "status"])?;
            self.expect(
                "legacy status still running",
                ok && status["state"] == "running",
            );
            self.auxiliary_stop(index)?;
            if mode == "legacy-stopped-record" {
                public_io(fs::write(
                    self.state(),
                    serde_json::to_vec_pretty(&legacy).map_err(|e| e.to_string())?,
                ))?;
            }
            let (ok, _) = self.command(&["models", "delete", "unrelated.gguf"])?;
            self.expect(
                "stopped legacy imposes no new refusal",
                ok && !self.file("models/unrelated.gguf").exists(),
            );
            if mode == "legacy-stop-restart" {
                public_io(fs::remove_file(self.file("native-receipt.json")))?;
                public_io(fs::remove_file(self.file("native-ack")))?;
                let fresh = plan.clone();
                self.set("active_model", &fresh.model)?;
                let (next, ok, _) = self.auxiliary_launch(&fresh, port, "restart")?;
                public_require(ok, "fresh restart setup")?;
                let state: Value = serde_json::from_slice(&public_io(fs::read(self.state()))?)
                    .map_err(|e| e.to_string())?;
                self.expect(
                    "fresh restart known empty",
                    state["file_bindings"]["auxiliary"] == serde_json::json!([]),
                );
                let unrelated = self.file("models/restarted-unrelated.gguf");
                public_io(fs::write(&unrelated, b"synthetic restarted unrelated"))?;
                let (ok, _) = self.command(&["models", "delete", &unrelated.to_string_lossy()])?;
                self.expect(
                    "fresh restart permits unrelated deletion",
                    ok && !unrelated.exists(),
                );
                self.auxiliary_stop(next)?;
            }
            return Ok(());
        }
        if matches!(mode, "stale-pid" | "stale-executable") {
            let mut stale = original_value.clone();
            if mode == "stale-pid" {
                stale["pid"] = std::process::id().into();
            } else {
                stale["executable"] = self
                    .file("not-the-running-engine.exe")
                    .to_string_lossy()
                    .into_owned()
                    .into();
            }
            stale
                .as_object_mut()
                .ok_or("state object")?
                .remove("file_bindings");
            public_io(fs::write(
                self.state(),
                serde_json::to_vec(&stale).map_err(|e| e.to_string())?,
            ))?;
            let contacts = self.contacts();
            let (ok, _) = self.command(&["models", "delete", "unrelated.gguf"])?;
            self.expect(
                "mismatched legacy has no live guard",
                ok && !self.file("models/unrelated.gguf").exists()
                    && self.contacts() == contacts
                    && self
                        .foreign_process
                        .as_ref()
                        .is_some_and(PublicProcess::running),
            );
            public_io(fs::write(self.state(), original))?;
            self.auxiliary_stop(index)?;
            return Ok(());
        }
        if matches!(mode, "known-empty" | "known-empty-old" | "state-precedence") {
            if mode == "known-empty-old" {
                let old = self.file("profile/local/aiolm/headless-state.json");
                public_io(fs::create_dir_all(old.parent().ok_or("legacy parent")?))?;
                public_io(fs::rename(self.state(), old))?;
            }
            self.expect(
                "new empty distinct from unknown",
                original_value["file_bindings"].is_object()
                    && original_value["file_bindings"]["auxiliary"] == serde_json::json!([]),
            );
            self.refused_file(
                &self.file("models/fake-model.gguf"),
                "new primary guard",
                true,
            )?;
            self.snapshot_controls(true)?;
        } else if mode == "drive-relative" {
            self.auxiliary_refused_at(
                &cwd,
                &self.file("models/unrelated.gguf").to_string_lossy(),
                "unresolved drive-relative is actionable",
                Some("absolute paths"),
            )?;
        } else if mode == "descriptor-boundary" {
            // Unknown strings in provider options are never guessed as paths.
            self.expect(
                "unknown configured strings are not a universal inventory",
                original_value["file_bindings"]["auxiliary"] == serde_json::json!([]),
            );
        } else {
            if mode == "next-config-runtime" {
                let b = self.foreign_port()?;
                self.set("port", &b.to_string())?;
                self.success(&["runtime", "select", ENGINE, "launcher-1"])?;
                let before = self.contacts();
                let (ok, status) = self.command(&["server", "status"])?;
                self.expect(
                    "drift status follows recorded URL",
                    ok && status["state"] == "running"
                        && status["url"] == format!("http://127.0.0.1:{port}/v1")
                        && self.contacts() == before,
                );
            }
            if mode == "next-model-root" {
                self.set("models_dir", &self.file("other-cwd").to_string_lossy())?;
                self.refused_file(
                    &self.file("models/vision.gguf"),
                    "outside next root containment",
                    false,
                )?;
                let models_root = self.home.to_string_lossy().into_owned();
                self.set("models_dir", &models_root)?;
            }
            if mode == "alias-retarget" {
                public_io(fs::remove_dir(self.file("models/owned-alias")))?;
                public_io(fs::create_dir(self.file("other-cwd/target")))?;
                self.auxiliary_junction(
                    &self.file("models/owned-alias"),
                    &self.file("other-cwd/target"),
                )?;
                self.auxiliary_refused_at(
                    &cwd,
                    &self.file("models/fake-model.gguf").to_string_lossy(),
                    "frozen primary canonical target survives retarget",
                    None,
                )?;
            }
            if mode == "relative-cwd" || mode == "declared-cwd" {
                let models_root = self.home.to_string_lossy().into_owned();
                self.set("models_dir", &models_root)?;
                public_io(fs::create_dir_all(cwd.join("models")))?;
                public_io(fs::write(
                    cwd.join("models/vision.gguf"),
                    auxiliary_gguf(&[("general.architecture", "clip")]),
                ))?;
                let (ok, _) = self.auxiliary_command_at(
                    &cwd,
                    &[
                        "models",
                        "delete",
                        &cwd.join("models/vision.gguf").to_string_lossy(),
                    ],
                )?;
                self.expect(
                    "next cwd same-name unrelated allowed",
                    ok && !cwd.join("models/vision.gguf").exists(),
                );
            }
            if mode == "shards" {
                let alias = self.file("models/shard-alias");
                self.auxiliary_junction(&alias, &self.file("models"))?;
                for role in ["main", "vision", "draft", "adapter"] {
                    let name = format!("{role}-00002-of-00002.gguf");
                    for path in [
                        self.file(&format!("models/{name}"))
                            .to_string_lossy()
                            .into_owned(),
                        name.clone(),
                        alias.join(&name).to_string_lossy().into_owned(),
                    ] {
                        self.auxiliary_refused_at(
                            &cwd,
                            &path,
                            "all-role second shard retained",
                            None,
                        )?;
                    }
                }
            } else if !matches!(mode, "ignored-missing" | "declared-cwd") {
                for name in ["vision.gguf", "draft.gguf", "adapter.gguf"] {
                    self.auxiliary_refused_at(
                        &cwd,
                        &self.file(&format!("models/{name}")).to_string_lossy(),
                        "frozen configured auxiliary retained",
                        None,
                    )?;
                }
                if mode == "aliases" {
                    for name in [
                        "fake-model.gguf",
                        "vision.gguf",
                        "draft.gguf",
                        "adapter.gguf",
                    ] {
                        self.auxiliary_refused_at(
                            &cwd,
                            &self
                                .file(&format!("models/owned-alias/{name}"))
                                .to_string_lossy(),
                            "original alias retained",
                            None,
                        )?;
                    }
                }
            } else if mode == "declared-cwd" {
                for name in ["vision.gguf", "draft.gguf"] {
                    self.auxiliary_refused_at(
                        &cwd,
                        &self.file(&format!("models/{name}")).to_string_lossy(),
                        "declared directory configured retention",
                        None,
                    )?;
                }
            } else {
                self.auxiliary_refused_at(
                    &cwd,
                    &self.file("models/adapter.gguf").to_string_lossy(),
                    "ignored configured enabled adapter retained",
                    None,
                )?;
                let aux = original_value["file_bindings"]["auxiliary"].as_array();
                self.expect(
                    "ignored missing lexical selections retained",
                    aux.is_some_and(|v| {
                        v.iter().any(|p| {
                            p.as_str()
                                .is_some_and(|s| s.ends_with("missing-projector.gguf"))
                        }) && v.iter().any(|p| {
                            p.as_str()
                                .is_some_and(|s| s.ends_with("missing-draft.gguf"))
                        })
                    }),
                );
            }
        }
        if mode != "drive-relative" {
            let (ok, _) = self.command(&[
                "models",
                "delete",
                &self.file("models/unrelated.gguf").to_string_lossy(),
            ])?;
            self.expect(
                "unrelated deletion succeeds",
                ok && !self.file("models/unrelated.gguf").exists(),
            );
            let (ok, _) = self.command(&[
                "models",
                "delete",
                &self.file("models/disabled.gguf").to_string_lossy(),
            ])?;
            self.expect(
                "disabled LoRA excluded",
                ok && !self.file("models/disabled.gguf").exists(),
            );
        }
        self.auxiliary_stop(index)?;
        if matches!(mode, "known-empty" | "known-empty-old" | "state-precedence") {
            self.snapshot_controls(false)?;
        }
        if mode == "saved-containment" {
            self.auxiliary_containment()?;
        }
        Ok(())
    }
    fn auxiliary_containment(&mut self) -> PublicResult<()> {
        for (path, bytes) in [
            (self.file("outside.gguf"), b"outside".as_slice()),
            (self.file("models/wrong.txt"), b"wrong".as_slice()),
        ] {
            public_io(fs::write(&path, bytes))?;
            self.refused_file(&path, "containment/type refusal", false)?;
        }
        public_io(fs::create_dir(self.file("models/not-a-file.gguf")))?;
        for path in [
            self.file("models/not-a-file.gguf"),
            self.file("models"),
            self.file("other-cwd"),
        ] {
            let (ok, _) = self.command(&["models", "delete", &path.to_string_lossy()])?;
            self.expect(
                "directory/root/unowned snapshot refused",
                !ok && path.is_dir(),
            );
        }
        let before = public_io(fs::read(self.file("outside.gguf")))?;
        let (ok, _) = self.command(&["models", "delete", "../outside.gguf"])?;
        self.expect(
            "relative escape bytes preserved",
            !ok && public_io(fs::read(self.file("outside.gguf")))? == before,
        );
        Ok(())
    }
    fn auxiliary_reclaim_owned_parts(&mut self) -> PublicResult<()> {
        let parent = self.file("cli");
        if !parent.exists() {
            return Ok(());
        }
        for entry in public_io(fs::read_dir(&parent))? {
            let path = public_io(entry)?.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("part name UTF8")?;
            if !name.ends_with(".part") {
                continue;
            }
            let ours = self
                .commands
                .iter()
                .any(|c| name.starts_with(&format!(".headless-state.{}.", c.owner.id())));
            let meta = public_io(fs::symlink_metadata(&path))?;
            use std::os::windows::fs::MetadataExt;
            public_require(
                ours && meta.is_file()
                    && meta.file_attributes() & 0x400 == 0
                    && public_io(fs::canonicalize(path.parent().ok_or("part parent")?))?
                        == public_io(fs::canonicalize(&parent))?,
                "refuse unowned/reparse staging cleanup",
            )?;
            let raw = self.record_file("part-before-forced-removal", &path)?;
            self.evidence.push(serde_json::json!({"forced_harness_part_removal":{"path":path,"raw":public_bytes(&raw),"product_cleanup":false}}));
            public_io(fs::remove_file(&path))?;
        }
        Ok(())
    }
}

struct AuxiliaryFailures {
    failures: Vec<&'static str>,
    evidence_root: PathBuf,
}
impl Drop for AuxiliaryFailures {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            assert!(
                self.failures.is_empty(),
                "auxiliary contracts failed: {:?}; evidence {}",
                self.failures,
                self.evidence_root.display()
            );
        }
    }
}

// Executed by the parent below, never used as a skipped contract case. Exiting
// without Rust destructors tests the kernel/job ownership during setup loss.
#[test]
#[ignore = "subprocess fixture; the auxiliary parent executes this explicitly"]
fn auxiliary_launch_cleanup_child() {
    let control = PathBuf::from(
        std::env::var_os("AIOLM_AUXILIARY_CLEANUP_CONTROL").expect("parent-owned child control"),
    );
    let ack = PathBuf::from(
        std::env::var_os("AIOLM_AUXILIARY_CLEANUP_ACK").expect("parent-owned child ack"),
    );
    let mut case = PublicCase::new();
    let mut allocated = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(control.with_extension("allocated.json"))
        .unwrap();
    allocated
        .write_all(
            &serde_json::to_vec(&serde_json::json!({"home":case.home,"pid":std::process::id()}))
                .unwrap(),
        )
        .unwrap();
    drop(allocated);
    let (port, plan) = case.auxiliary_setup("known-empty").unwrap();
    case.phase("behavior");
    let (index, ok, _) = case.auxiliary_launch(&plan, port, "cleanup-child").unwrap();
    assert!(ok);
    let mut ready = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&control)
        .unwrap();
    ready.write_all(&serde_json::to_vec(&serde_json::json!({"home":case.home,"pid":std::process::id(),"port":port,"foreign_port":case.foreign_port().unwrap(),"pids":case.launches[index].processes.iter().map(|p|p.pid).collect::<Vec<_>>(),"observations":case.evidence})).unwrap()).unwrap();
    drop(ready);
    let deadline = Instant::now() + START_BOUND;
    while !ack.is_file() {
        assert!(
            Instant::now() < deadline,
            "cleanup parent did not retain child"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::process::exit(77);
}

fn auxiliary_cleanup_child_contract(evidence_root: &Path) -> bool {
    let mut case = PublicCase::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> PublicResult<()> {
        case.setup()?;
        case.phase("behavior");
        let control = case.file("cleanup-child.json");
        let ack = case.file("cleanup-child.ack");
        let template = case.isolated_cli(&[]);
        let mut command = Command::new(public_io(std::env::current_exe())?);
        for (key, value) in template.get_envs() {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
        command
            .args([
                "--ignored",
                "--exact",
                "auxiliary_launch_cleanup_child",
                "--nocapture",
            ])
            .env("AIOLM_AUXILIARY_CLEANUP_CONTROL", &control)
            .env("AIOLM_AUXILIARY_CLEANUP_ACK", &ack)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let command_index = case.commands.len();
        case.commands.push(PublicCommand::spawn(command)?);
        case.commands[command_index].init_readers()?;
        let index = case.launches.len();
        case.launches.push(PublicLaunch {
            processes: vec![],
            directory: case.file("no-cleanup-resources"),
            port: 0,
        });
        let deadline = Instant::now() + START_BOUND;
        let receipt: Value = loop {
            if let Ok(raw) = fs::read(&control) {
                if let Ok(value) = serde_json::from_slice(&raw) {
                    break value;
                }
            }
            if public_io(std::process::Child::try_wait(
                &mut case.commands[command_index].owner,
            ))?
            .is_some()
            {
                return Err("cleanup child exited before ready receipt".into());
            }
            public_require(Instant::now() < deadline, "cleanup child ready timeout")?;
            std::thread::sleep(Duration::from_millis(10));
        };
        let root = PathBuf::from(receipt["home"].as_str().ok_or("child root")?);
        public_require(
            public_io(fs::canonicalize(&root))?
                .starts_with(public_io(fs::canonicalize(case.file("profile/temp")))?),
            "cleanup child root outside owned parent temp",
        )?;
        for pid in receipt["pids"].as_array().ok_or("cleanup child PIDs")? {
            let retained = PublicProcess::retain(auxiliary_pid(pid)?)?;
            case.launches[index].processes.push(retained);
        }
        case.launches[index].port = receipt["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .ok_or("child port")?;
        let job = case.commands[command_index]
            .owner
            .process_handle()
            .ok_or("child outer job")?;
        public_require(
            case.launches[index]
                .processes
                .iter()
                .all(|p| job.contains(p.pid)),
            "child native processes escaped parent job",
        )?;
        case.evidence.push(serde_json::json!({"cleanup_child_receipt":receipt,"all_handles_retained_before_exit":true}));
        public_io(fs::write(ack, b"retained"))?;
        let output = case.commands[command_index].output()?;
        let until = Instant::now() + EXIT_BOUND;
        let empty = job.wait_exited(until.saturating_duration_since(Instant::now()));
        let exits: Vec<_> = case.launches[index]
            .processes
            .iter()
            .map(|p| (p.pid, p.exited(until)))
            .collect();
        let mut closed = true;
        for key in ["port", "foreign_port"] {
            let port = receipt[key]
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .ok_or("child retained port")?;
            closed &= TcpStream::connect_timeout(
                &([127, 0, 0, 1], port).into(),
                Duration::from_millis(250),
            )
            .is_err()
                && TcpListener::bind(("127.0.0.1", port)).is_ok();
        }
        case.evidence.push(serde_json::json!({"cleanup_child_before_forced":{"exit":output.status.code(),"stdout":public_bytes(&output.stdout),"stderr":public_bytes(&output.stderr),"job_empty":empty,"retained_exits":exits,"ports_closed_reusable":closed,"root_still_owned":root.exists()}}));
        case.expect(
            "setup-loss child closed exact owned tree",
            output.status.code() == Some(77)
                && empty
                && exits.iter().all(|(_, gone)| *gone)
                && closed,
        );
        Ok(())
    }));
    let cleanup = case.finish_checked();
    let error = match result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e),
        Err(_) => Some("cleanup child harness unwound".into()),
    };
    let failed =
        error.is_some() || !cleanup.is_empty() || case.expectations.iter().any(|(_, ok)| !*ok);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(evidence_root.join("cleanup-child.json"))
        .expect("exclusive cleanup child evidence");
    file.write_all(&serde_json::to_vec_pretty(&serde_json::json!({"timings":case.timings(),"setup_error":error,"cleanup_errors":cleanup,"expectations":case.expectations,"observations":case.evidence})).unwrap()).unwrap();
    !failed
}

async fn configured_file_retention_contracts() -> AuxiliaryFailures {
    // Both configured and default evidence roots are exclusive. No runner-only
    // variable, skipped case, user path default or unconditional env panic.
    let parent = std::env::var_os("AIOLM_CLI_FIXTURE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    fs::create_dir_all(&parent).expect("create auxiliary evidence parent");
    let evidence_root = parent.join(format!("aiolm-auxiliary-evidence-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&evidence_root).expect("create exclusive auxiliary evidence root");
    let mut failures = vec![];
    let mut summaries = vec![];
    let cleanup_child_started = Instant::now();
    let cleanup_child_ok = auxiliary_cleanup_child_contract(&evidence_root);
    summaries.push(
        serde_json::json!({"case":"cleanup-child","failed":!cleanup_child_ok,
        "elapsed_ms":cleanup_child_started.elapsed().as_millis()}),
    );
    if !cleanup_child_ok {
        failures.push("cleanup-child");
    }
    for mode in [
        "enabled",
        "slash-spelling",
        "dormant",
        "ignored-missing",
        "known-empty",
        "known-empty-old",
        "state-precedence",
        "legacy-missing-current",
        "legacy-null-current",
        "legacy-missing-old",
        "legacy-null-old",
        "legacy-stop-restart",
        "legacy-stopped-record",
        "stale-pid",
        "stale-executable",
        "next-config-runtime",
        "next-model-root",
        "relative-cwd",
        "declared-cwd",
        "aliases",
        "alias-retarget",
        "shards",
        "saved-containment",
        "oversize",
        "activation-failure",
        "resource-failure",
        "setup-error",
        "setup-unwind",
        "setup-reader-error",
        "drive-relative",
        "descriptor-boundary",
    ] {
        let mut case = PublicCase::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            case.auxiliary_behavior(mode)
        }));
        // Inspect the private payload and live owned handles BEFORE cleanup.
        // An earlier unrelated panic, even with the same message, cannot pass.
        let exact_unwind = match &result {
            Err(payload) => {
                payload
                    .downcast_ref::<AuxiliarySetupUnwind>()
                    .is_some_and(|injection| {
                        injection.home == case.home
                            && injection.retained_pids.len() >= 2
                            && case.launches.last().is_some_and(|launch| {
                                launch.processes.iter().map(|p| p.pid).collect::<Vec<_>>()
                                    == injection.retained_pids
                                    && auxiliary_exact_native_handles(
                                        &launch.processes,
                                        &case.image,
                                    )
                                    .unwrap_or(false)
                            })
                            && case
                                .commands
                                .iter()
                                .find(|c| c.owner.id() == injection.outer_pid)
                                .and_then(|c| c.owner.process_handle())
                                .is_some_and(|job| {
                                    injection.retained_pids.iter().all(|pid| job.contains(*pid))
                                })
                            && case.evidence.iter().any(|entry| {
                                entry["typed_setup_unwind_reached"]["outer_pid"]
                                    == injection.outer_pid
                                    && entry["typed_setup_unwind_reached"]["retained_pids"]
                                        == serde_json::json!(injection.retained_pids)
                            })
                    })
            }
            _ => false,
        };
        case.evidence
            .push(serde_json::json!({"exact_typed_unwind_before_forced_cleanup":exact_unwind}));
        let part_cleanup = case.auxiliary_reclaim_owned_parts();
        // Existing checked cleanup snapshots every registered launch before
        // forcing jobs, and handles bounded EOF, foreign threads and roots.
        let ports: Vec<_> = case.launches.iter().map(|l| l.port).collect();
        let mut cleanup = case.finish_checked();
        if let Err(error) = part_cleanup {
            cleanup.push(error);
        }
        for port in ports {
            let closed = TcpStream::connect_timeout(
                &([127, 0, 0, 1], port).into(),
                Duration::from_millis(250),
            )
            .is_err();
            let reusable = TcpListener::bind(("127.0.0.1", port)).is_ok();
            case.evidence.push(serde_json::json!({"after_checked_cleanup_port":port,"closed":closed,"reusable":reusable}));
            if !closed || !reusable {
                cleanup.push(format!("owned port {port} not closed/reusable"));
            }
        }
        let observed = match result {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(_) if exact_unwind => Some("typed auxiliary setup unwind".into()),
            Err(_) => Some("unexpected fixture panic".into()),
        };
        let injected = if mode == "setup-error" {
            observed.as_deref() == Some("injected after native handles retained before validation")
        } else if mode == "setup-unwind" {
            exact_unwind && observed.as_deref() == Some("typed auxiliary setup unwind")
        } else if mode == "setup-reader-error" {
            observed.as_deref() == Some("injected after stdout reader start with stderr closed")
        } else {
            false
        };
        let setup_error = if injected { None } else { observed.clone() };
        if matches!(mode, "setup-error" | "setup-unwind" | "setup-reader-error") {
            case.expect("intended partial launch failure reached", injected);
        }
        let failed = setup_error.is_some()
            || !cleanup.is_empty()
            || case.expectations.iter().any(|(_, ok)| !*ok);
        let timings = case.timings();
        summaries.push(serde_json::json!({"case":mode,"failed":failed,"timings":timings}));
        let evidence = serde_json::json!({"case":mode,"timings":timings,"observed":observed,"setup_error":setup_error,"cleanup_errors":cleanup,"expectations":case.expectations,"observations":case.evidence});
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(evidence_root.join(format!("{mode}.json")))
            .expect("exclusive case evidence");
        file.write_all(&serde_json::to_vec_pretty(&evidence).expect("serialize finite evidence"))
            .expect("persist auxiliary evidence");
        eprintln!(
            "auxiliary {mode}: failed={failed}; evidence {}",
            evidence_root.display()
        );
        if failed {
            failures.push(mode);
        }
    }
    fs::write(
        evidence_root.join("summary.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "cases":summaries,"failed_cases":failures
        }))
        .expect("serialize auxiliary timing summary"),
    )
    .expect("persist auxiliary timing summary");
    AuxiliaryFailures {
        failures,
        evidence_root,
    }
}

impl PublicCase {
    // Only intentional partial-start controls enable this. Natural product
    // cleanup has already been recorded separately and is never relabelled.
    fn auxiliary_recover_interrupted_start_lock(&mut self) -> PublicResult<()> {
        let lock = self.file("cli/headless-state.lock");
        let metadata = match fs::symlink_metadata(&lock) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        use std::os::windows::fs::MetadataExt;
        public_require(
            metadata.is_file() && metadata.file_attributes() & 0x400 == 0 && metadata.len() <= 64,
            "unknown interrupted lock retained",
        )?;
        let bytes = self.record_file("interrupted-lock-before-public-recovery", &lock)?;
        let pid: u32 = std::str::from_utf8(&bytes)
            .map_err(|e| e.to_string())?
            .trim()
            .parse()
            .map_err(|_| "unparseable interrupted lock retained")?;
        let owner = self
            .commands
            .iter()
            .position(|command| command.owner.id() == pid)
            .ok_or("lock owner is not a retained fixture command")?;
        let exited = public_io(std::process::Child::try_wait(
            &mut self.commands[owner].owner,
        ))?;
        let jobs_empty = self.commands.iter().all(|command| {
            command
                .owner
                .process_handle()
                .is_some_and(|job| job.wait_exited(Duration::ZERO))
        });
        let handles_exited = self.launches.iter().all(|launch| {
            launch
                .processes
                .iter()
                .all(|process| process.exited(Instant::now()))
        });
        public_require(
            exited.is_some() && self.commands[owner].streams_done && jobs_empty && handles_exited,
            "interrupted owner or job not proved exited; lock retained",
        )?;
        self.evidence
            .push(serde_json::json!({"forced_fixture_lock_recovery_before":{
            "lock":lock,"raw":public_bytes(&bytes),"retained_owner_pid":pid,
            "retained_owner_exit":exited.map(|status|status.code()),"all_jobs_empty":jobs_empty,
            "all_retained_handles_exited":handles_exited,"product_natural_cleanup":false}}));
        let first_recovery = self.commands.len();
        let contacts = self.contacts();
        let result = self.command(&["server", "stop"]);
        let mut errors = Vec::new();
        for command in &mut self.commands[first_recovery..] {
            if let Err(error) = command.finish_checked() {
                errors.push(error);
            }
        }
        self.evidence.push(serde_json::json!({"forced_fixture_lock_recovery_after":{
            "result":result,"lock_absent":!lock.exists(),"recovery_command_errors":errors,
            "foreign_contacts_unchanged":contacts==self.contacts(),"product_natural_cleanup":false,
            "recovery_jobs":self.commands[first_recovery..].iter().map(|command|serde_json::json!({
                "pid":command.owner.id(),"exit":command.root_exit,"streams_done":command.streams_done,
                "job_empty":command.owner.process_handle().is_some_and(|job|job.wait_exited(Duration::ZERO))})).collect::<Vec<_>>()}}));
        let (ok, value) = result?;
        public_require(
            errors.is_empty()
                && ok
                && value["state"] == "stopped"
                && !lock.exists()
                && contacts == self.contacts(),
            "public interrupted-lock recovery failed; residue retained",
        )
    }
}
