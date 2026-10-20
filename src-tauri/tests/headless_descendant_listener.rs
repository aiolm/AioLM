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
        // This integration binary has one test, so no concurrent env readers.
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
        }
    }
}
impl ForeignServer {
    fn stop_checked(&mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Release);
        if self.thread.is_some() {
            self.finished
                .recv_timeout(EXIT_BOUND)
                .map_err(|e| format!("foreign stop: {e}"))?;
            if let Some(thread) = self.thread.take() {
                thread
                    .join()
                    .map_err(|_| "foreign thread panicked".to_string())?;
            }
        }
        if TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
            return Err("foreign listener remains after checked stop".into());
        }
        Ok(())
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
            self.init_readers()?;
            let stdout = self
                .stdout
                .as_mut()
                .ok_or("stdout reader missing")?
                .finish();
            let stderr = self
                .stderr
                .as_mut()
                .ok_or("stderr reader missing")?
                .finish();
            self.streams_done = true;
            stdout?;
            stderr?;
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
}
impl PublicCase {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("aiolm-public-cli-{}", uuid::Uuid::new_v4()));
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
        }
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
                self.evidence.push(serde_json::json!({"argv":args,"cwd":std::env::current_dir().ok(),"elapsed_ms":start.elapsed().as_millis(),
                    "exit":output.status.code(),"stdout":public_bytes(&output.stdout),"stderr":public_bytes(&output.stderr),"json":value}));
                Ok((output.status.success(), value?))
            }
            Err(error) => {
                self.evidence.push(serde_json::json!({"argv":args,"error":error,"elapsed_ms":start.elapsed().as_millis()}));
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
    fn setup(&mut self) -> PublicResult<u16> {
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
        let registration = draft(
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
        self.set("models_dir", &self.file("models").to_string_lossy())?;
        self.set(
            "active_model",
            &self
                .file("models/running-00001-of-00002.gguf")
                .to_string_lossy(),
        )?;
        self.foreign = Some(ForeignServer::start());
        self.foreign_process = Some(PublicProcess::open(
            std::process::id(),
            &public_io(std::env::current_exe())?,
        )?);
        let port = free_port();
        public_require(port != self.foreign_port()?, "A and B ports collided")?;
        self.set("port", &port.to_string())?;
        let config = self.success(&["config", "get"])?;
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
    fn behavior(&mut self, name: &str, port: u16) -> PublicResult<()> {
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
                    let mut raw = public_bytes(&public_io(fs::read(entry.path()))?);
                    if entry.path().extension().is_some_and(|e| e == "exe") {
                        raw.as_object_mut()
                            .ok_or("raw object missing")?
                            .remove("base64");
                    }
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
    let evidence_root = std::env::var_os("AIOLM_CLI_FIXTURE_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("aiolm-cli-evidence-{}", uuid::Uuid::new_v4()))
        });
    fs::create_dir_all(&evidence_root).expect("create synthetic evidence directory");
    let mut failures = vec![];
    for name in [
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
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> PublicResult<()> {
                let port = case.setup()?;
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
        let evidence = serde_json::json!({"case":name,"observed_error":observed_error,"setup_error":setup_error,"cleanup_errors":cleanup,"expectations":case.expectations,"observations":case.evidence});
        fs::write(
            evidence_root.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&evidence).expect("serialize evidence"),
        )
        .expect("persist evidence");
        eprintln!(
            "public CLI {name}: setup={setup_error:?}, cleanup={cleanup:?}, behavior={failed:?}"
        );
        if setup_error.is_some() || !cleanup.is_empty() || !failed.is_empty() {
            failures.push(name);
        }
    }
    assert!(
        failures.is_empty(),
        "public CLI cases failed: {failures:?}; evidence {}",
        evidence_root.display()
    );
}

#[tokio::test]
async fn headless_start_owns_a_launcher_descendant_listener_and_only_that_listener() {
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
