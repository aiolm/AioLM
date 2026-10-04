//! The CLI's log collector must outlive the command that started it while
//! retaining bounded, redacted output until the server closes its pipes.
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

const FIXTURE_ENV: &str = "AIOLM_HEADLESS_LOG_LAUNCH_FIXTURE";
const MAX_LOG_BYTES: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(15);

struct TemporaryHome(PathBuf);

impl TemporaryHome {
    fn new() -> Self {
        let path = env::temp_dir().join(format!("aiolm-headless-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("home with spaces/aiolm/cli")).unwrap();
        Self(path)
    }

    fn home(&self) -> PathBuf {
        self.0.join("home with spaces")
    }
}

impl Drop for TemporaryHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Launcher(Child);

impl Drop for Launcher {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn isolate_home(command: &mut Command, home: &Path) {
    for (key, _) in env::vars_os() {
        let normalized = key.to_string_lossy().to_ascii_uppercase();
        if normalized.starts_with("AIOLM_") || normalized.starts_with("LLAMA_BOARD_") {
            command.env_remove(key);
        }
    }
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("APPDATA", home.join("roaming"))
        .env("LOCALAPPDATA", home.join("local"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("AIOLM_HOME", home.join("aiolm"));
}

fn wait_for_log(path: &Path, needle: &str) -> String {
    let deadline = Instant::now() + DEADLINE;
    loop {
        let contents = fs::read_to_string(path).unwrap_or_default();
        if contents.contains(needle) {
            return contents;
        }
        assert!(Instant::now() < deadline, "log did not contain {needle:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn logs_survive_the_launcher_and_drain_redacted_bounded_output_at_eof() {
    let temporary = TemporaryHome::new();
    let home = temporary.home();
    let log = home.join("aiolm/cli/headless-server.log");
    fs::write(&log, []).unwrap();

    let (reader, mut writer) = std::io::pipe().unwrap();
    let mut command = Command::new(env::current_exe().unwrap());
    isolate_home(&mut command, &home);
    command
        .args(["--ignored", "--exact", "launch_collector_fixture"])
        .env(FIXTURE_ENV, "1")
        .stdin(reader)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut launcher = Launcher(command.spawn().unwrap());
    // Command retains its configured descriptors even after spawning.
    drop(command);
    let mut stderr = launcher.0.stderr.take().unwrap();
    let (closed_tx, closed_rx) = mpsc::channel();
    let output_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stderr.read_to_end(&mut bytes).map(|_| bytes);
        let _ = closed_tx.send(result);
    });

    let deadline = Instant::now() + DEADLINE;
    loop {
        if let Some(status) = launcher.0.try_wait().unwrap() {
            assert!(status.success(), "collector launcher failed: {status}");
            break;
        }
        assert!(Instant::now() < deadline, "collector launcher did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
    // Only the collector now retains this stderr pipe. Its continued lifetime
    // must not depend on the launcher process or an in-process pump thread.
    assert!(matches!(
        closed_rx.recv_timeout(Duration::from_millis(100)),
        Err(RecvTimeoutError::Timeout)
    ));

    writer.write_all(b"after-launcher-exit\n").unwrap();
    wait_for_log(&log, "after-launcher-exit");
    for fragment in [b"--to".as_slice(), b"ken=synthetic-", b"split-secret"] {
        writer.write_all(fragment).unwrap();
        std::thread::sleep(Duration::from_millis(30));
    }
    writer.write_all(b"\n").unwrap();
    let unicode = "한글 로그".as_bytes();
    writer.write_all(&unicode[..2]).unwrap();
    std::thread::sleep(Duration::from_millis(30));
    writer.write_all(&unicode[2..]).unwrap();
    writer.write_all(b"\nredaction-complete\n").unwrap();
    let redacted = wait_for_log(&log, "redaction-complete");
    assert!(redacted.contains("--token=[REDACTED]"), "{redacted}");
    assert!(!redacted.contains("synthetic-"), "{redacted}");
    assert!(!redacted.contains("split-secret"), "{redacted}");
    assert!(redacted.contains("한글 로그"), "{redacted}");

    // One unterminated record cannot bypass the memory bound or persist an
    // unredacted prefix. Collection must resume at the next logical line.
    writer.write_all(b"oversized-secret token=").unwrap();
    writer.write_all(&vec![b'x'; 64 * 1024]).unwrap();
    writer.write_all(b"\nafter-oversized-line\n").unwrap();
    let bounded = wait_for_log(&log, "after-oversized-line");
    assert!(bounded.contains("[oversized headless log line omitted]"));
    assert!(!bounded.contains("oversized-secret"));

    fs::remove_file(&log).unwrap();
    writer.write_all(b"after-log-removal\n").unwrap();
    wait_for_log(&log, "after-log-removal");

    // Filesystem failure must not close the pipe or stop model inference.
    // Drain enough output to detect an exited reader, then restore the path.
    fs::remove_file(&log).unwrap();
    fs::create_dir(&log).unwrap();
    for _ in 0..256 {
        writer.write_all(&[b'x'; 8191]).unwrap();
        writer.write_all(b"\n").unwrap();
    }
    fs::remove_dir(&log).unwrap();
    writer.write_all(b"after-log-write-recovery\n").unwrap();
    wait_for_log(&log, "after-log-write-recovery");

    // Ordinary short records collectively exceed retention. An unterminated
    // final record must still be redacted and flushed when stdin reaches EOF.
    let padding = "x".repeat(4096);
    for index in 0..270 {
        writeln!(writer, "bounded-{index:04} {padding}").unwrap();
    }
    writer
        .write_all(b"final-tail token=synthetic-eof-secret")
        .unwrap();
    drop(writer);
    let stderr = closed_rx
        .recv_timeout(DEADLINE)
        .expect("collector did not exit after stdin reached EOF")
        .expect("cannot read collector stderr");
    output_reader.join().unwrap();
    assert!(
        stderr.is_empty(),
        "collector emitted diagnostics: {stderr:?}"
    );

    let retained = fs::read(&log).unwrap();
    assert_eq!(retained.len(), MAX_LOG_BYTES);
    let retained = String::from_utf8(retained).unwrap();
    assert!(!retained.contains("after-launcher-exit"));
    assert!(retained.contains("bounded-0269"));
    assert!(retained.ends_with("final-tail token=[REDACTED]"));
    assert!(!retained.contains("synthetic-eof-secret"));
}

#[test]
#[ignore = "subprocess fixture for the headless log lifetime test"]
fn launch_collector_fixture() {
    if env::var(FIXTURE_ENV).as_deref() != Ok("1") {
        return;
    }
    let collector = Command::new(env!("CARGO_BIN_EXE_aiolm-cli"))
        .arg("--internal-headless-log")
        .stdin(Stdio::inherit())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start the CLI log collector");
    // This fixture deliberately transfers lifetime to the inherited input
    // pipe, just as a successful CLI start transfers it to llama-server.
    drop(collector);
}
