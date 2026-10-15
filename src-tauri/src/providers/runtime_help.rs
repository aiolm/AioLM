//! Shell-free help discovery. This reports command syntax only; protocol/model
//! readiness stays with the adapter's independent fresh probe.
use crate::procutil;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const PARSER_VERSION: u32 = 1;
const MAX_STREAM_BYTES: usize = 1024 * 1024;
const CACHE_ENTRIES: usize = 16;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    #[default]
    Auto,
    Utf8,
    Utf16Le,
    Utf16Be,
}

/// The adapter resolves the complete child environment. Clearing inherited env
/// makes the fingerprint describe what was actually passed, including locale.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelpCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub working_directory: Option<PathBuf>,
    pub artifacts: Vec<PathBuf>,
    pub runtime_version: String,
    pub scope: Vec<String>,
    pub encoding: Encoding,
    pub timeout_ms: u64,
    pub output_limit: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub fingerprint: String,
    pub executable_sha256: String,
    pub artifacts_sha256: BTreeMap<PathBuf, String>,
    pub parser_version: u32,
}

fn sha256(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|e| format!("cannot read help artifact {}: {e}", path.display()))?;
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err("help artifacts must be regular files".into());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("help discovery cancelled".into());
        }
        let size = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        hasher.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

impl HelpCommand {
    pub fn identity(&self, cancel: &AtomicBool) -> Result<Identity, String> {
        // Windows Command implicitly runs batch files through cmd.exe. Require
        // a real executable/interpreter so our argv boundary stays shell-free.
        if cfg!(windows)
            && self
                .program
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        {
            return Err("select an executable or an explicit interpreter; implicit Windows batch execution is not a help command".into());
        }
        if !self.program.is_absolute()
            || !self.program.is_file()
            || self.args.len() > 256
            || self
                .args
                .iter()
                .any(|s| s.len() > 32768 || s.contains('\0'))
            || self.args.iter().map(String::len).sum::<usize>() > 131072
            || self.environment.len() > 512
            || self.environment.iter().any(|(k, v)| {
                k.is_empty()
                    || k.contains(['\0', '='])
                    || k.len() + v.len() > 131072
                    || v.contains('\0')
            })
            || self
                .environment
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>()
                > 512 * 1024
            || self.artifacts.len() > 4096
            || !(1..=180000).contains(&self.timeout_ms)
            || !(1024..=MAX_STREAM_BYTES).contains(&self.output_limit)
            || self.runtime_version.len() > 4096
            || self.runtime_version.contains('\0')
            || self.scope.len() > 8
            || self.scope.iter().any(|s| {
                s.is_empty()
                    || s.len() > 128
                    || s.starts_with('-')
                    || s.contains(['\0', '/', '\\'])
                    || s.chars().any(char::is_whitespace)
            })
        {
            return Err("invalid help command: use an absolute executable, bounded argv/environment and explicit limits".into());
        }
        let program = self.program.canonicalize().map_err(|e| e.to_string())?;
        let current_directory = std::env::current_dir().map_err(|e| e.to_string())?;
        let working_directory = Some(
            self.working_directory
                .as_ref()
                .unwrap_or(&current_directory),
        )
        .map(|path| {
            if !path.is_absolute() || !path.is_dir() {
                return Err(
                    "help working directory must be an existing absolute directory".to_string(),
                );
            }
            path.canonicalize().map_err(|e| e.to_string())
        })
        .transpose()?;
        let executable_sha256 = sha256(&program, cancel)?;
        let mut artifacts_sha256 = BTreeMap::new();
        for artifact in &self.artifacts {
            if !artifact.is_absolute() {
                return Err("help artifacts need absolute paths".into());
            }
            let path = artifact.canonicalize().map_err(|e| e.to_string())?;
            if artifacts_sha256
                .insert(path.clone(), sha256(&path, cancel)?)
                .is_some()
            {
                return Err("duplicate help artifact".into());
            }
        }
        let identity = serde_json::json!({
            "program":program,"sha256":executable_sha256,"artifacts":artifacts_sha256,
            "working_directory":working_directory,"args":self.args,"environment":self.environment,
            "runtime_version":self.runtime_version,"scope":self.scope,"encoding":self.encoding,
            "output_limit":self.output_limit,"timeout_ms":self.timeout_ms,"parser":PARSER_VERSION,
            "os":std::env::consts::OS,"arch":std::env::consts::ARCH,
        });
        Ok(Identity {
            fingerprint: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&identity).map_err(|e| e.to_string())?)
            ),
            executable_sha256,
            artifacts_sha256,
            parser_version: PARSER_VERSION,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextOutput {
    /// Decoded original with escape sequences retained for diagnostic copying.
    pub text: String,
    pub clean_text: String,
    pub encoding: String,
    pub decoding_loss: bool,
    pub truncated: bool,
    pub read_error: Option<String>,
}

fn without_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            if ch != '\r' {
                out.push(ch);
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' || (c == '\u{1b}' && chars.peek() == Some(&'\\')) {
                        if c == '\u{1b}' {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn decode(stream: procutil::CapturedStream, requested: Encoding) -> TextOutput {
    let bytes = stream.bytes.as_slice();
    let (encoding, bytes) = match requested {
        Encoding::Auto if bytes.starts_with(&[0xff, 0xfe]) => (Encoding::Utf16Le, &bytes[2..]),
        Encoding::Auto if bytes.starts_with(&[0xfe, 0xff]) => (Encoding::Utf16Be, &bytes[2..]),
        Encoding::Auto | Encoding::Utf8 if bytes.starts_with(&[0xef, 0xbb, 0xbf]) => {
            (Encoding::Utf8, &bytes[3..])
        }
        Encoding::Auto => (Encoding::Utf8, bytes),
        other => (other, bytes),
    };
    let (text, decoding_loss, name) = match encoding {
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let words = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| {
                    if encoding == Encoding::Utf16Le {
                        u16::from_le_bytes([p[0], p[1]])
                    } else {
                        u16::from_be_bytes([p[0], p[1]])
                    }
                })
                .collect::<Vec<_>>();
            let decoded = String::from_utf16(&words);
            let loss = bytes.len() % 2 != 0 || decoded.is_err();
            (
                decoded.unwrap_or_else(|_| String::from_utf16_lossy(&words)),
                loss,
                if encoding == Encoding::Utf16Le {
                    "utf-16le"
                } else {
                    "utf-16be"
                },
            )
        }
        _ => {
            let decoded = String::from_utf8_lossy(bytes);
            let loss = matches!(decoded, std::borrow::Cow::Owned(_));
            (
                decoded.into_owned(),
                loss,
                if loss {
                    "unrecognized bytes (UTF-8 replacement view)"
                } else {
                    "utf-8"
                },
            )
        }
    };
    TextOutput {
        clean_text: without_ansi(&text),
        text,
        encoding: name.into(),
        decoding_loss,
        truncated: stream.truncated,
        read_error: stream.read_error,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelpReport {
    pub identity: Identity,
    pub scope: Vec<String>,
    pub stdout: TextOutput,
    pub stderr: TextOutput,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub cancelled: bool,
    pub timed_out: bool,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

impl HelpReport {
    /// A readable partial/failing report remains diagnostic, never a verified
    /// discovery cache entry. Help success still establishes no API capability.
    pub fn complete(&self) -> bool {
        self.identity.parser_version == PARSER_VERSION
            && self.success
            && self.error.is_none()
            && !self.cancelled
            && !self.timed_out
            && [&self.stdout, &self.stderr]
                .iter()
                .all(|s| !s.truncated && !s.decoding_loss && s.read_error.is_none())
    }
}

pub fn discover(command: &HelpCommand, cancel: &AtomicBool) -> Result<HelpReport, String> {
    let before = Instant::now();
    let identity = command.identity(cancel)?;
    let mut process = procutil::std_command(&command.program);
    process
        .env_clear()
        .envs(&command.environment)
        .args(&command.args);
    process.current_dir(
        command
            .working_directory
            .clone()
            .unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?),
    );
    let captured = procutil::capture_help_cancellable(
        &mut process,
        Duration::from_millis(command.timeout_ms),
        command.output_limit,
        Some(cancel),
    )
    .map_err(|e| procutil::spawn_error(&command.program, &e))?;
    let (success, exit_code, cancelled, timed_out, mut error) = match captured.status {
        Ok(status) => (status.success(), status.code(), false, false, None),
        Err(error) => (
            false,
            None,
            error.kind() == std::io::ErrorKind::Interrupted,
            error.kind() == std::io::ErrorKind::TimedOut,
            Some(error.to_string()),
        ),
    };
    if !cancelled && !timed_out && command.identity(cancel)? != identity {
        error=Some("runtime or help artifacts changed during discovery; rediscover before applying options".into());
    }
    Ok(HelpReport {
        identity,
        scope: command.scope.clone(),
        stdout: decode(captured.stdout, command.encoding),
        stderr: decode(captured.stderr, command.encoding),
        exit_code,
        success,
        cancelled,
        timed_out,
        error,
        elapsed_ms: before.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

#[derive(Clone)]
pub struct DiscoveryTicket {
    pub id: String,
    pub cancel: Arc<AtomicBool>,
    owner: String,
}

#[derive(Default)]
struct ServiceState {
    active: BTreeMap<String, DiscoveryTicket>,
    cache: BTreeMap<String, HelpReport>,
}

/// Each settings owner has one publication slot. Starting a new discovery
/// cancels only its predecessor; a late predecessor cannot populate the cache.
#[derive(Default)]
pub struct HelpService(Mutex<ServiceState>);

impl HelpService {
    pub fn begin(&self, owner: &str) -> Result<DiscoveryTicket, String> {
        if owner.is_empty() || owner.len() > 512 || owner.contains('\0') {
            return Err("invalid discovery owner".into());
        }
        let mut state = self
            .0
            .lock()
            .map_err(|_| "help discovery lock was poisoned")?;
        if state.active.len() >= 128 && !state.active.contains_key(owner) {
            return Err("too many active help discoveries".into());
        }
        let ticket = DiscoveryTicket {
            id: uuid::Uuid::new_v4().to_string(),
            cancel: Arc::new(AtomicBool::new(false)),
            owner: owner.into(),
        };
        if let Some(previous) = state.active.insert(owner.into(), ticket.clone()) {
            previous.cancel.store(true, Ordering::Release);
        }
        Ok(ticket)
    }

    pub fn cancel(&self, id: &str) -> Result<bool, String> {
        let state = self
            .0
            .lock()
            .map_err(|_| "help discovery lock was poisoned")?;
        if let Some(ticket) = state.active.values().find(|t| t.id == id) {
            ticket.cancel.store(true, Ordering::Release);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn cached(
        &self,
        command: &HelpCommand,
        cancel: &AtomicBool,
    ) -> Result<Option<HelpReport>, String> {
        let identity = command.identity(cancel)?;
        let state = self
            .0
            .lock()
            .map_err(|_| "help discovery lock was poisoned")?;
        Ok(state.cache.get(&identity.fingerprint).cloned())
    }

    pub fn finish(&self, ticket: &DiscoveryTicket, report: &HelpReport) -> Result<(), String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "help discovery lock was poisoned")?;
        if !state
            .active
            .get(&ticket.owner)
            .is_some_and(|t| t.id == ticket.id)
        {
            return Err("help discovery superseded; late result discarded".into());
        }
        state.active.remove(&ticket.owner);
        if ticket.cancel.load(Ordering::Acquire) {
            return Err("help discovery cancelled".into());
        }
        if report.complete() {
            if state.cache.len() >= CACHE_ENTRIES {
                if let Some(key) = state.cache.keys().next().cloned() {
                    state.cache.remove(&key);
                }
            }
            state
                .cache
                .insert(report.identity.fingerprint.clone(), report.clone());
        }
        Ok(())
    }

    pub fn failed(&self, ticket: &DiscoveryTicket) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .active
            .get(&ticket.owner)
            .is_some_and(|t| t.id == ticket.id)
        {
            state.active.remove(&ticket.owner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    const CHILD: &str = "AIOLM_HELP_TEST_CHILD";
    const CHILD_NAME: &str = "providers::runtime_help::tests::discovery_child";

    struct Artifact {
        root: PathBuf,
        path: PathBuf,
    }
    impl Artifact {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("aiolm-help-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let path = root.join("synthetic-artifact.txt");
            fs::write(&path, b"build one").unwrap();
            Self { root, path }
        }
    }
    impl Drop for Artifact {
        fn drop(&mut self) {
            for name in ["synthetic-artifact.txt", "ready.txt"] {
                let _ = fs::remove_file(self.root.join(name));
            }
            let _ = fs::remove_dir(&self.root);
        }
    }

    fn command(mode: &str) -> HelpCommand {
        let mut environment: BTreeMap<String, String> =
            super::super::python_env::engine_environment()
                .into_iter()
                .map(|(key, value)| {
                    (
                        key.into_string().expect("test environment name is Unicode"),
                        value
                            .into_string()
                            .expect("test environment value is Unicode"),
                    )
                })
                .collect();
        environment.insert(CHILD.into(), mode.into());
        environment.insert("LC_ALL".into(), "C".into());
        HelpCommand {
            program: std::env::current_exe().unwrap(),
            args: vec!["--exact".into(), CHILD_NAME.into(), "--nocapture".into()],
            environment,
            working_directory: Some(std::env::temp_dir()),
            artifacts: vec![],
            runtime_version: "test-r1".into(),
            scope: vec![],
            encoding: Encoding::Auto,
            timeout_ms: 10000,
            output_limit: 4096,
        }
    }

    #[test]
    fn discovery_child() {
        let Ok(mode) = std::env::var(CHILD) else {
            return;
        };
        match mode.as_str() {
            "normal" => {
                println!("\u{1b}[32m  --new-flag VALUE\u{1b}[0m   freshly installed\n한글 help");
                eprintln!("  --stderr-option ARG   separate stream");
            }
            "overflow" => {
                std::io::stdout().write_all(&vec![b'x'; 65536]).unwrap();
                std::io::stderr().write_all(&vec![b'y'; 65536]).unwrap();
            }
            "failure" => {
                eprintln!("synthetic help failed");
                std::process::exit(9);
            }
            "fork" => {
                let mut child = procutil::std_command(std::env::current_exe().unwrap())
                    .args(["--exact", CHILD_NAME, "--nocapture"])
                    .env(CHILD, "wait")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::inherit())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                    .unwrap();
                fs::write(
                    std::env::var("AIOLM_HELP_READY_FILE").unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
                println!("partial help before cancellation");
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(60));
                child.wait().unwrap();
            }
            "wait" => {
                println!("partial help before timeout");
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(60));
            }
            "mutate" => {
                fs::write(
                    std::env::var("AIOLM_HELP_MUTATE_FILE").unwrap(),
                    b"build two",
                )
                .unwrap();
                println!("  --changed VALUE");
            }
            _ => panic!("unknown synthetic help mode"),
        }
    }

    #[test]
    fn actual_discovery_separates_streams_preserves_raw_ansi_and_establishes_no_protocol() {
        let report = discover(&command("normal"), &AtomicBool::new(false)).unwrap();
        assert!(report.complete(), "{report:?}");
        assert_eq!(report.exit_code, Some(0));
        assert!(report.stdout.text.contains("\u{1b}[32m"));
        assert!(!report.stdout.clean_text.contains('\u{1b}'));
        assert!(report.stdout.clean_text.contains("--new-flag VALUE"));
        assert!(report.stdout.clean_text.contains("한글 help"));
        assert!(report.stderr.clean_text.contains("--stderr-option"));
        assert!(!report.stdout.clean_text.contains("--stderr-option"));
    }

    #[test]
    fn fingerprint_changes_for_runtime_artifact_args_locale_version_scope_and_limits() {
        let artifact = Artifact::new();
        let mut original = command("normal");
        original.artifacts.push(artifact.path.clone());
        let cancel = AtomicBool::new(false);
        let first = original.identity(&cancel).unwrap();
        assert_eq!(first, original.identity(&cancel).unwrap());
        for field in 0..7 {
            let mut changed = original.clone();
            match field {
                0 => changed.args.push("--help=all".into()),
                1 => {
                    changed
                        .environment
                        .insert("LC_ALL".into(), "C.UTF-8".into());
                }
                2 => changed.runtime_version = "test-r2".into(),
                3 => changed.scope = vec!["serve".into()],
                4 => changed.working_directory = Some(artifact.root.clone()),
                5 => changed.output_limit = 2048,
                _ => changed.encoding = Encoding::Utf16Le,
            }
            assert_ne!(
                first.fingerprint,
                changed.identity(&cancel).unwrap().fingerprint,
                "field {field}"
            );
        }
        fs::write(&artifact.path, b"build two").unwrap();
        assert_ne!(
            first.fingerprint,
            original.identity(&cancel).unwrap().fingerprint
        );
        assert!(!serde_json::to_string(&first).unwrap().contains("LC_ALL"));
    }

    #[test]
    fn output_limit_reports_truncation_and_drains_both_streams_to_exit() {
        let report = discover(&command("overflow"), &AtomicBool::new(false)).unwrap();
        assert!(report.success);
        assert!(!report.complete());
        assert!(report.stdout.truncated);
        assert!(report.stderr.truncated);
        assert!(report.stdout.text.len() <= 4096);
        assert!(report.stderr.text.len() <= 4096);
        assert!(report.stderr.text.starts_with('y')); // help keeps its head, not legacy diagnostic tail
    }

    #[test]
    fn failing_help_retains_exit_status_and_diagnostics_without_verified_fallback() {
        let report = discover(&command("failure"), &AtomicBool::new(false)).unwrap();
        assert!(!report.complete());
        assert_eq!(report.exit_code, Some(9));
        assert!(report.stderr.text.contains("synthetic help failed"));
        let service = HelpService::default();
        let ticket = service.begin("runtime-a").unwrap();
        service.finish(&ticket, &report).unwrap();
        assert!(service
            .cached(&command("failure"), &AtomicBool::new(false))
            .unwrap()
            .is_none());
    }

    #[test]
    fn timeout_retains_partial_output_and_reaps_owned_process() {
        let mut command = command("wait");
        command.timeout_ms = 500;
        let before = Instant::now();
        let report = discover(&command, &AtomicBool::new(false)).unwrap();
        assert!(report.timed_out);
        assert!(!report.complete());
        assert!(report.stdout.text.contains("partial help before timeout"));
        assert!(before.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn cancellation_before_spawn_does_not_run_the_command() {
        let artifact = Artifact::new();
        let mut command = command("mutate");
        command.environment.insert(
            "AIOLM_HELP_MUTATE_FILE".into(),
            artifact.path.to_string_lossy().into(),
        );
        assert!(discover(&command, &AtomicBool::new(true))
            .unwrap_err()
            .contains("cancelled"));
        assert_eq!(fs::read(&artifact.path).unwrap(), b"build one");
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_reclaims_real_descendant_and_retains_partial_help() {
        let artifact = Artifact::new();
        let ready = artifact.root.join("ready.txt");
        let mut command = command("fork");
        command.environment.insert(
            "AIOLM_HELP_READY_FILE".into(),
            ready.to_string_lossy().into(),
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let sender = cancel.clone();
        let running = std::thread::spawn(move || discover(&command, &sender));
        let deadline = Instant::now() + Duration::from_secs(5);
        let pid = loop {
            if let Ok(text) = fs::read_to_string(&ready) {
                if let Ok(pid) = text.parse::<u32>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "help descendant did not start");
            std::thread::sleep(Duration::from_millis(10));
        };
        let child = procutil::ProcessExitProbe::open(pid)
            .expect("hold the actual descendant handle before cancelling");
        // Give the parent a chance to flush its diagnostic after ready.txt.
        std::thread::sleep(Duration::from_millis(30));
        cancel.store(true, Ordering::Release);
        let report = running.join().unwrap().unwrap();
        assert!(report.cancelled);
        assert!(!report.complete());
        assert!(report.stdout.text.contains("partial help"));
        // TerminateJobObject initiates TerminateProcess for each descendant.
        // Pipe EOF can precede its process object becoming signalled. Hold the
        // exact handle and await completion, as existing ownership tests do.
        assert!(
            child.wait(Duration::from_secs(2)),
            "owned descendant survived cancellation"
        );
    }

    #[test]
    fn runtime_mutation_during_help_blocks_cache_publication() {
        let artifact = Artifact::new();
        let mut command = command("mutate");
        command.artifacts.push(artifact.path.clone());
        command.environment.insert(
            "AIOLM_HELP_MUTATE_FILE".into(),
            artifact.path.to_string_lossy().into(),
        );
        let report = discover(&command, &AtomicBool::new(false)).unwrap();
        assert!(report.success);
        assert!(!report.complete());
        assert!(report.error.unwrap().contains("changed during discovery"));
    }

    #[test]
    fn latest_owner_wins_and_cancelling_old_ticket_preserves_other_owners() {
        let service = HelpService::default();
        let first = service.begin("a").unwrap();
        let other = service.begin("b").unwrap();
        let latest = service.begin("a").unwrap();
        assert!(first.cancel.load(Ordering::Acquire));
        assert!(!other.cancel.load(Ordering::Acquire));
        assert!(!latest.cancel.load(Ordering::Acquire));
        let report = discover(&command("normal"), &AtomicBool::new(false)).unwrap();
        assert!(service
            .finish(&first, &report)
            .unwrap_err()
            .contains("superseded"));
        assert!(service
            .cached(&command("normal"), &AtomicBool::new(false))
            .unwrap()
            .is_none());
        service.finish(&latest, &report).unwrap();
        assert_eq!(
            service
                .cached(&command("normal"), &AtomicBool::new(false))
                .unwrap(),
            Some(report)
        );
        assert!(!service.cancel(&first.id).unwrap());
        assert!(service.cancel(&other.id).unwrap());
        service.failed(&other);
    }

    #[test]
    fn changed_artifact_cannot_reuse_a_successful_help_cache() {
        let artifact = Artifact::new();
        let mut command = command("normal");
        command.artifacts.push(artifact.path.clone());
        let service = HelpService::default();
        let ticket = service.begin("a").unwrap();
        let report = discover(&command, &ticket.cancel).unwrap();
        service.finish(&ticket, &report).unwrap();
        assert!(service
            .cached(&command, &AtomicBool::new(false))
            .unwrap()
            .is_some());
        fs::write(&artifact.path, b"build changed").unwrap();
        assert!(service
            .cached(&command, &AtomicBool::new(false))
            .unwrap()
            .is_none());
    }

    #[test]
    fn fingerprint_reads_executable_bytes_and_refuses_invalid_command_boundaries() {
        let artifact = Artifact::new();
        let mut command = command("normal");
        command.program = artifact.path.clone();
        let first = command.identity(&AtomicBool::new(false)).unwrap();
        fs::write(&artifact.path, b"different executable bytes").unwrap();
        let second = command.identity(&AtomicBool::new(false)).unwrap();
        assert_ne!(first.executable_sha256, second.executable_sha256);
        assert_ne!(first.fingerprint, second.fingerprint);
        for field in 0..5 {
            let mut invalid = command.clone();
            match field {
                0 => invalid.program = PathBuf::from("relative-executable"),
                1 => invalid.args.push("nul\0arg".into()),
                2 => {
                    invalid
                        .environment
                        .insert("INVALID=NAME".into(), "value".into());
                }
                3 => invalid.scope = vec!["--not-a-subcommand".into()],
                _ => invalid.output_limit = MAX_STREAM_BYTES + 1,
            }
            assert!(
                invalid.identity(&AtomicBool::new(false)).is_err(),
                "field {field}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_batch_files_cannot_introduce_an_implicit_shell() {
        let artifact = Artifact::new();
        let batch = artifact.root.join("synthetic-wrapper.CmD");
        fs::write(&batch, b"@echo synthetic help\r\n").unwrap();
        let mut command = command("normal");
        command.program = batch.clone();
        let error = command.identity(&AtomicBool::new(false)).unwrap_err();
        fs::remove_file(batch).unwrap();
        assert!(error.contains("implicit Windows batch"));
    }

    #[test]
    fn real_overlapping_discovery_cancels_old_process_and_only_new_result_is_cached() {
        let artifact = Artifact::new();
        let ready = artifact.root.join("ready.txt");
        let service = Arc::new(HelpService::default());
        let old = service.begin("same-editor").unwrap();
        let unrelated = service.begin("other-editor").unwrap();
        let mut slow = command("fork");
        slow.environment.insert(
            "AIOLM_HELP_READY_FILE".into(),
            ready.to_string_lossy().into(),
        );
        let old_cancel = old.cancel.clone();
        let running = std::thread::spawn(move || discover(&slow, &old_cancel));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.is_file() {
            assert!(Instant::now() < deadline, "old help did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        let latest = service.begin("same-editor").unwrap();
        let fresh = discover(&command("normal"), &latest.cancel).unwrap();
        assert!(fresh.complete());
        service.finish(&latest, &fresh).unwrap();
        let obsolete = running.join().unwrap().unwrap();
        assert!(obsolete.cancelled);
        assert!(service
            .finish(&old, &obsolete)
            .unwrap_err()
            .contains("superseded"));
        assert_eq!(
            service
                .cached(&command("normal"), &AtomicBool::new(false))
                .unwrap(),
            Some(fresh)
        );
        assert!(!unrelated.cancel.load(Ordering::Acquire));
        service.failed(&unrelated);
    }

    #[test]
    fn reports_from_another_parser_version_cannot_become_verified_cache_entries() {
        let mut report = discover(&command("normal"), &AtomicBool::new(false)).unwrap();
        report.identity.parser_version = PARSER_VERSION + 1;
        assert!(!report.complete());
        let service = HelpService::default();
        let ticket = service.begin("a").unwrap();
        service.finish(&ticket, &report).unwrap();
        assert!(service
            .cached(&command("normal"), &AtomicBool::new(false))
            .unwrap()
            .is_none());
    }

    #[test]
    fn encoding_and_ansi_are_explicit_and_loss_never_qualifies_as_complete() {
        let source = "\u{1b}[31m한글\u{1b}[0m\n";
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(source.encode_utf16().flat_map(u16::to_le_bytes));
        let decoded = decode(
            procutil::CapturedStream {
                bytes,
                ..Default::default()
            },
            Encoding::Auto,
        );
        assert_eq!(decoded.encoding, "utf-16le");
        assert_eq!(decoded.clean_text, "한글\n");
        assert!(!decoded.decoding_loss);
        let invalid = decode(
            procutil::CapturedStream {
                bytes: vec![0xff, 0x80],
                ..Default::default()
            },
            Encoding::Auto,
        );
        assert!(invalid.decoding_loss);
        assert!(invalid.encoding.contains("unrecognized"));
        assert_eq!(without_ansi("a\u{1b}]0;synthetic title\u{7}b\u{1b}]8;;https://example.invalid\u{1b}\\link\u{1b}]8;;\u{1b}\\"),"ablink");
    }
}
