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
        });
        Self {
            port,
            model_checks,
            stop,
            thread: Some(thread),
        }
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

#[tokio::test]
async fn headless_start_owns_a_launcher_descendant_listener_and_only_that_listener() {
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
