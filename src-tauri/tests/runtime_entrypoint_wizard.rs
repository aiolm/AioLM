//! Entry-point registration from explicit choices: an interpreter-style
//! program with a script prefix (spaces and Unicode), help discovered before
//! registration through the same command derivation, bindings checked against
//! that help, an explicit credential variable and probe, and the reviewed help
//! applying to the registered engine without rediscovery. Synthetic only.
use aiolm_lib::{
    providers::{
        self,
        registry::{
            ArgBinding, AuthBinding, DraftHelp, EntrypointDraft, EntrypointHelp, ProcessSpec,
            ServingProtocol,
        },
        runtime_help::HelpService,
        runtime_help_store::{self, Baseline},
        runtime_schema::{self, HelpRequest, HelpState},
    },
    server, AppConfig, ErrBuf,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct TestHome {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl TestHome {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("aiolm-entrypoint-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // One test per integration binary; no concurrent reader of this.
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

#[tokio::test]
async fn explicit_entrypoint_registration_pins_reviewed_help_for_launch() {
    #[cfg(windows)]
    reviewed_binding_arity_before_registration();
    let area = TestHome::new();
    let engine = providers::ProviderId::parse("custom.entryfixture").unwrap();
    let program = env!("CARGO_BIN_EXE_fake-llama-server").to_string();
    let scripts = area.path.join("엔진 scripts");
    fs::create_dir(&scripts).unwrap();
    let script = scripts.join("serve engine.py");
    fs::write(&script, b"synthetic entry script v1").unwrap();
    let other_script = scripts.join("other.py");
    fs::write(&other_script, b"synthetic other script").unwrap();
    let model = area.path.join("synthetic model.model");
    fs::write(&model, b"synthetic weights").unwrap();
    let argv_file = area.path.join("argv.json");
    let prefix = vec![
        script.to_string_lossy().into_owned(),
        "--adapter-engine".to_string(),
        "--adapter-no-health-auth".to_string(),
    ];
    let entry = EntrypointHelp {
        command_layout: None,
        engine_id: engine,
        runtime_id: "local-1".into(),
        program: program.clone(),
        prefix: prefix.clone(),
        working_directory: Some(area.path.to_string_lossy().into_owned()),
        artifacts: vec![script.to_string_lossy().into_owned()],
        environment: BTreeMap::from([(
            "FAKE_ENGINE_ARGV_FILE".to_string(),
            argv_file.to_string_lossy().into_owned(),
        )]),
        protocol: ServingProtocol::OpenaiHttp,
        option_metadata: None,
    };
    let mut help_args = prefix.clone();
    help_args.extend(["--adapter-help-fixture".to_string(), "--help".to_string()]);
    let request = HelpRequest {
        encoding: None,
        locale: None,
        working_directory: None,
        program: None,
        args: help_args,
        scope: vec![],
    };
    // Help before registration, through the registered engine's derivation.
    let provisional = providers::registry::provisional_manifest(&entry).unwrap();
    let command = runtime_schema::manifest_help_command(&provisional, &request).unwrap();
    assert!(command.artifacts.contains(&script));
    let root = providers::registry::root();
    let (report, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        &root,
        "entry-owner",
        engine.as_str(),
        "local-1",
        &command,
        &[],
        Baseline::Latest,
    )
    .unwrap();
    assert!(report.complete());
    let help = DraftHelp {
        fingerprint: descriptor.fingerprint.clone(),
        request: request.clone(),
    };
    let draft = EntrypointDraft {
        command_layout: None,
        options_separator: None,
        launch_resources: None,
        models: vec![],
        engine_id: engine,
        runtime_id: "local-1".into(),
        display_name: "Synthetic entry point".into(),
        program: program.clone(),
        prefix: prefix.clone(),
        working_directory: entry.working_directory.clone(),
        artifacts: entry.artifacts.clone(),
        environment: entry.environment.clone(),
        model: ArgBinding::Flag {
            flag: "--model".into(),
            equals: false,
        },
        port: ArgBinding::Flag {
            flag: "--port".into(),
            equals: false,
        },
        host: Some(ArgBinding::Flag {
            flag: "--host".into(),
            equals: false,
        }),
        served_model: None,
        auth: AuthBinding::Env {
            name: "SYNTHETIC_API_KEY".into(),
        },
        protocol: ServingProtocol::OpenaiHttp,
        probe: ProcessSpec {
            program: program.clone(),
            args: vec![
                "--adapter-probe".into(),
                engine.as_str().into(),
                "local-1".into(),
                "{model}".into(),
            ],
            env: BTreeMap::new(),
            working_directory: None,
        },
        health_path: "/health".into(),
        health_authenticated: false,
        model_formats: vec!["unknown".into()],
        help: Some(help),
        option_metadata: None,
    };

    // The manifest is exactly the user's choices: no invented credential
    // variable, probe arguments, bindings or protocol.
    let manifest = providers::registry::manifest_from_draft(&draft).unwrap();
    let mut expected_args = prefix.clone();
    expected_args
        .extend(["--model", "{model}", "--host", "{host}", "--port", "{port}"].map(String::from));
    assert_eq!(manifest.launch.args, expected_args);
    assert_eq!(
        manifest
            .launch
            .env
            .get("SYNTHETIC_API_KEY")
            .map(String::as_str),
        Some("{api_key}")
    );
    assert!(!manifest.launch.env.contains_key("ENGINE_KEY"));
    assert_eq!(manifest.probe, draft.probe);
    assert_eq!(providers::registry::launch_prefix(&manifest), prefix);

    // Binding spellings must be documented by the discovered help.
    let mut typo = draft.clone();
    typo.model = ArgBinding::Flag {
        flag: "--modle".into(),
        equals: false,
    };
    let typo_manifest = providers::registry::manifest_from_draft(&typo).unwrap();
    assert!(
        runtime_schema::draft_acceptance(&root, &typo, &typo_manifest)
            .unwrap_err()
            .contains("--modle")
    );
    // A draft whose engine changed after discovery is refused.
    let mut moved = draft.clone();
    moved
        .environment
        .insert("FAKE_ENGINE_HELP".into(), "v2".into());
    let moved_manifest = providers::registry::manifest_from_draft(&moved).unwrap();
    assert!(
        runtime_schema::draft_acceptance(&root, &moved, &moved_manifest)
            .unwrap_err()
            .contains("changed")
    );

    // Register; the pre-registration discovery is the accepted help.
    let registered = runtime_schema::register_entrypoint(&root, &draft, None)
        .await
        .unwrap();
    assert_eq!(registered, manifest);
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut cfg = AppConfig {
        active_provider: engine.as_str().into(),
        active_runtime: "local-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        port,
        ..Default::default()
    };
    cfg.normalize();
    let effective = runtime_schema::effective(&root, &cfg, true).unwrap();
    assert_eq!(effective.help_state, HelpState::Current);
    let Value::Object(values) = json!({"fresh_label": "Ünïcode value", "fresh_count": "3"})
    else {
        unreachable!()
    };
    cfg.provider_options.insert(engine.as_str().into(), values);
    providers::adapter::refresh(&cfg, None).await.unwrap();
    let planned = providers::registry::command(&cfg, port, "synthetic-key").unwrap();
    let tail = ["--fresh-count", "3", "--fresh-label", "Ünïcode value"].map(String::from);
    assert!(planned.args.ends_with(&tail), "{:?}", planned.args);
    assert!(planned
        .env
        .iter()
        .any(|(name, value)| name == "SYNTHETIC_API_KEY" && value == "synthetic-key"));

    // The spawned process receives the script prefix and options verbatim.
    let info = providers::execution::info(&cfg).unwrap();
    let err = Arc::new(ErrBuf::default());
    let (child, url, _) = server::spawn(&cfg, "synthetic-key", &err, &Default::default()).unwrap();
    let shared = Arc::new(Mutex::new(server::ServerState::new()));
    {
        let mut state = shared.lock().unwrap();
        state.child = Some(child);
        state.engine = Some(info);
    }
    server::wait_ready(shared.clone(), &url, "synthetic-key", 5, &err)
        .await
        .unwrap();
    let argv: Vec<String> = serde_json::from_slice(&fs::read(&argv_file).unwrap()).unwrap();
    assert!(argv.starts_with(&prefix), "{argv:?}");
    assert!(argv.ends_with(&tail), "{argv:?}");
    {
        let mut state = shared.lock().unwrap();
        server::kill(&mut state.child, Some(err.clone()));
    }

    observe_post_registration_help_pin_failure(&root, &entry, &request, &draft, &cfg).await;

    // Another script through the same interpreter is not this engine's help.
    let mut other_args = prefix.clone();
    other_args[0] = other_script.to_string_lossy().into_owned();
    other_args.push("--help".into());
    assert!(runtime_schema::help_command(
        &cfg,
        &HelpRequest {
            encoding: None,
            locale: None,
            working_directory: None,
            program: None,
            args: other_args,
            scope: vec![],
        }
    )
    .unwrap_err()
    .contains("entry point"));
    // Editing the declared script is detected before anything runs.
    fs::write(&script, b"synthetic entry script v2").unwrap();
    assert!(providers::registry::command(&cfg, port, "synthetic-key")
        .unwrap_err()
        .contains("changed"));
}
// Characterize the original split-publication outcome before choosing a recovery policy.
async fn observe_post_registration_help_pin_failure(
    root: &std::path::Path,
    entry: &EntrypointHelp,
    request: &HelpRequest,
    draft: &EntrypointDraft,
    cfg: &AppConfig,
) {
    let runtime = "pin-write-fault";
    let mut fault_entry = entry.clone();
    fault_entry.runtime_id = runtime.into();
    let provisional = providers::registry::provisional_manifest(&fault_entry).unwrap();
    let command = runtime_schema::manifest_help_command(&provisional, request).unwrap();
    let (report, descriptor) = runtime_help_store::discover_against(
        &HelpService::default(),
        root,
        "entry-owner-pin-fault",
        entry.engine_id.as_str(),
        runtime,
        &command,
        &[],
        Baseline::Latest,
    )
    .unwrap();
    assert!(report.complete());
    let mut fault_draft = draft.clone();
    fault_draft.runtime_id = runtime.into();
    fault_draft.probe.args = vec![
        "--adapter-probe".into(),
        entry.engine_id.as_str().into(),
        runtime.into(),
        "{model}".into(),
    ];
    let probe_marker = root.join("pin-write-fault-probed.txt");
    fault_draft.probe.env.insert(
        "FAKE_PROBE_MARKER".into(),
        probe_marker.to_string_lossy().into_owned(),
    );
    fault_draft.help = Some(DraftHelp {
        fingerprint: descriptor.fingerprint.clone(),
        request: request.clone(),
    });
    let manifest = providers::registry::manifest_from_draft(&fault_draft).unwrap();
    let runtime_dir = root.join(entry.engine_id.as_str()).join(runtime);
    let accepted_path = runtime_dir.join("help").join("accepted.json");
    let registration_path = runtime_dir.join("registration.json");
    assert!(!accepted_path.exists());
    assert!(!registration_path.exists());
    fs::create_dir(&accepted_path).unwrap();
    // Only the final pin-write target is faulty; reviewed help is still valid.
    let acceptance = runtime_schema::draft_acceptance(root, &fault_draft, &manifest)
        .unwrap()
        .unwrap();
    assert_eq!(acceptance.fingerprint, descriptor.fingerprint);
    let first_error = runtime_schema::register_entrypoint(root, &fault_draft, None)
        .await
        .unwrap_err();
    assert!(!first_error.is_empty());
    assert!(accepted_path.is_dir());
    assert!(registration_path.is_file());
    assert_eq!(fs::read(&probe_marker).unwrap(), b"probed");
    assert_eq!(
        providers::registry::manifest(entry.engine_id, runtime).unwrap(),
        manifest
    );
    let registration_bytes = fs::read(&registration_path).unwrap();
    let record: Value = serde_json::from_slice(&registration_bytes).unwrap();
    assert_eq!(
        record["probe"]["engine_id"].as_str(),
        Some(entry.engine_id.as_str())
    );
    assert_eq!(record["probe"]["runtime_id"].as_str(), Some(runtime));
    let accepted_error =
        runtime_schema::load_accepted(root, entry.engine_id.as_str(), runtime).unwrap_err();
    assert!(
        accepted_error.contains("bounded regular file"),
        "{accepted_error}"
    );
    let retry_error = runtime_schema::register_entrypoint(root, &fault_draft, None)
        .await
        .unwrap_err();
    assert!(retry_error.contains("already registered"), "{retry_error}");
    assert_eq!(fs::read(&registration_path).unwrap(), registration_bytes);
    // Remove only this empty synthetic fault directory, preserving the published build.
    fs::remove_dir(&accepted_path).unwrap();
    let mut recovered_cfg = cfg.clone();
    recovered_cfg.active_runtime = runtime.into();
    let accepted =
        runtime_schema::accept(root, &recovered_cfg, &descriptor.fingerprint, request).unwrap();
    assert_eq!(accepted.fingerprint, descriptor.fingerprint);
    assert!(accepted_path.is_file());
    let recovered = runtime_schema::effective(root, &recovered_cfg, true).unwrap();
    assert_eq!(recovered.help_state, HelpState::Current);
    let registration_preserved = fs::read(&registration_path).unwrap() == registration_bytes;
    assert!(registration_preserved);
    eprintln!(
        "entrypoint_help_pin_write_observation: {}",
        json!({
            "first_error": first_error,
            "accepted_record_error": accepted_error,
            "retry_error": retry_error,
            "registration_preserved": registration_preserved,
            "probe_completed": record["probe"]["runtime_id"].as_str() == Some(runtime),
            "public_accept_recovered_current": recovered.help_state == HelpState::Current,
        })
    );
}
// Synthetic Windows checks retain ownership of every fixture child and file.
#[cfg(windows)]
#[allow(dead_code)]
#[path = "../src/procutil/windows_job.rs"]
mod binding_arity_job;

#[cfg(windows)]
type ArityResult<T> = Result<T, Box<dyn std::error::Error>>;

// Check attributes BEFORE canonicalization, including every existing ancestor.
// Never make a link target become the intended root by replacing the path.
#[cfg(windows)]
fn binding_arity_plain(path: &std::path::Path) -> ArityResult<fs::Metadata> {
    use std::os::windows::fs::MetadataExt;
    for at in path.ancestors() {
        let metadata = fs::symlink_metadata(at)?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("fixture path contains FILE_ATTRIBUTE_REPARSE_POINT".into());
        }
    }
    Ok(fs::symlink_metadata(path)?)
}

#[cfg(windows)]
struct BindingArityArea {
    boundary: PathBuf,
    path: PathBuf,
    token: Vec<u8>,
    owns: bool,
}

#[cfg(windows)]
impl BindingArityArea {
    fn new() -> ArityResult<Self> {
        let intended = std::env::temp_dir();
        if !intended.is_absolute() {
            return Err("temp boundary is not absolute".into());
        }
        if !binding_arity_plain(&intended)?.is_dir() {
            return Err("temp boundary is not a directory".into());
        }
        let boundary = intended.canonicalize()?;
        binding_arity_plain(&boundary)?;
        let token = uuid::Uuid::new_v4().to_string().into_bytes();
        let path = boundary.join(format!("aiolm-binding-arity-{}", uuid::Uuid::new_v4()));
        let mut area = Self {
            boundary,
            path,
            token,
            owns: false,
        };
        fs::create_dir(&area.path)?; // Exclusive claim; existing paths are never adopted.
        area.owns = true; // Establish ownership before any subsequent fallible operation.
        area.check_root()?;
        use std::io::Write;
        let mut marker = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(area.path.join("owner.token"))?;
        marker.write_all(&area.token)?;
        marker.sync_all()?;
        Ok(area)
    }

    fn check_root(&self) -> ArityResult<()> {
        if !self.owns
            || self.path.parent() != Some(self.boundary.as_path())
            || !self.path.is_absolute()
            || self.path == self.boundary
        {
            return Err("fixture root ownership/boundary is uncertain".into());
        }
        if !binding_arity_plain(&self.path)?.is_dir()
            || self.boundary.canonicalize()? != self.boundary
            || self.path.canonicalize()? != self.path
        {
            return Err("fixture root canonical identity changed".into());
        }
        Ok(())
    }

    fn verify(&self) -> ArityResult<()> {
        self.check_root()?;
        let marker = self.path.join("owner.token");
        if !binding_arity_plain(&marker)?.is_file() || fs::read(marker)? != self.token {
            return Err("fixture ownership marker changed".into());
        }
        Ok(())
    }

    fn remove_checked(&mut self) -> ArityResult<()> {
        self.verify()?;
        // Complete audit first. A reparse point anywhere refuses ALL removal.
        binding_arity_tree(&self.path)?;
        fn remove(area: &BindingArityArea, at: &std::path::Path) -> ArityResult<()> {
            area.verify()?;
            let mut entries = fs::read_dir(at)?.collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path() == area.path.join("owner.token"));
            for item in entries {
                let path = item.path();
                if path == area.path.join("owner.token") {
                    continue;
                }
                area.verify()?;
                let metadata = binding_arity_plain(&path)?;
                if path.canonicalize()? != path || !path.starts_with(&area.path) {
                    return Err("fixture removal path escaped owned root".into());
                }
                if metadata.is_dir() {
                    remove(area, &path)?;
                    fs::remove_dir(&path)?;
                } else if metadata.is_file() {
                    fs::remove_file(&path)?;
                } else {
                    return Err("nonregular removal entry".into());
                }
            }
            Ok(())
        }
        remove(self, &self.path)?;
        self.verify()?;
        fs::remove_file(self.path.join("owner.token"))?;
        self.check_root()?;
        fs::remove_dir(&self.path)?; // Never recurse on an unchecked root.
        if fs::symlink_metadata(&self.path)
            .err()
            .is_none_or(|e| e.kind() != std::io::ErrorKind::NotFound)
        {
            return Err("fixture removal absence not proved".into());
        }
        self.owns = false;
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for BindingArityArea {
    fn drop(&mut self) {
        // No best-effort recursive deletion on an error or a partially initialized root.
        if self.owns {
            eprintln!("R65_ARITY_AREA_RETAINED={:?}", self.path);
        }
    }
}

#[cfg(windows)]
#[derive(Default)]
struct BindingArityCleanup {
    finished: bool,
    started: bool,
    natural_status: Option<String>,
    receipt: Value,
}

#[cfg(windows)]
struct BindingArityOwned {
    child: Option<std::process::Child>,
    job: Option<binding_arity_job::ProcessJob>,
    receipt: Arc<Mutex<BindingArityCleanup>>,
}

#[cfg(windows)]
impl BindingArityOwned {
    fn new(receipt: Arc<Mutex<BindingArityCleanup>>) -> ArityResult<Self> {
        Ok(Self {
            child: None,
            job: Some(binding_arity_job::ProcessJob::new()?),
            receipt,
        })
    }

    fn spawn(&mut self, command: &mut std::process::Command, mode: &str) -> ArityResult<()> {
        use std::os::{windows::io::AsRawHandle, windows::process::CommandExt};
        command.creation_flags(0x0800_0000 | 0x0000_0004);
        self.child = Some(command.spawn()?); // Owner already exists before spawn.
        if mode == "error-after-spawn" {
            return Err("injected after spawn".into());
        }
        let child = self.child.as_ref().ok_or("missing owned child")?;
        let job = self.job.as_ref().ok_or("missing owned job")?;
        job.assign(child.as_raw_handle())?;
        if mode == "error-after-assign" {
            return Err("injected after assignment".into());
        }
        job.capture_members(None)?;
        if mode == "error-after-capture" {
            return Err("injected after capture".into());
        }
        binding_arity_job::resume(child.id())?;
        Ok(())
    }

    fn close(&mut self) -> ArityResult<()> {
        use std::time::{Duration, Instant};
        if self
            .receipt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finished
        {
            return Ok(());
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        {
            let mut state = self.receipt.lock().unwrap_or_else(|e| e.into_inner());
            if !state.started {
                state.natural_status = self
                    .child
                    .as_mut()
                    .map(|child| child.try_wait())
                    .transpose()?
                    .flatten()
                    .map(|s| s.to_string());
                state.started = true; // Retries must never relabel forced exit as natural.
            }
        }
        // terminate() retains native handles before terminating; wait_empty()
        // checks those handles as well as current membership, and fails closed.
        if let Some(job) = &self.job {
            job.terminate();
        }
        // Also covers assignment failure: the still-suspended root cannot fork.
        if let Some(child) = &mut self.child {
            let _ = child.kill();
        }
        let empty = self
            .job
            .as_ref()
            .is_none_or(|job| job.wait_empty(deadline.saturating_duration_since(Instant::now())));
        let root_status = loop {
            match self
                .child
                .as_mut()
                .map(|child| child.try_wait())
                .transpose()?
            {
                None => break None,
                Some(Some(status)) => break Some(status),
                Some(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => return Err("owned root wait deadline expired".into()),
            }
        };
        if let Some(child) = &mut self.child {
            child.wait()?;
        }
        let mut state = self.receipt.lock().unwrap_or_else(|e| e.into_inner());
        state.receipt = json!({"job_empty_and_retained_members_signaled": empty,
            "root_reaped": self.child.is_none() || root_status.is_some(),
            "natural_status_before_termination": state.natural_status.clone(),
            "root_status_after_cleanup": root_status.map(|s| s.to_string())});
        if !empty {
            return Err("owned job cleanup not proved; retain handles and area".into());
        }
        state.finished = true;
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for BindingArityOwned {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            let mut state = self.receipt.lock().unwrap_or_else(|e| e.into_inner());
            state.receipt["cleanup_error"] = json!(error.to_string());
            // Keep native ownership on an unproved cleanup. Never turn loss of
            // the owner into a successful cleanup or delete a still-used area.
            if let Some(job) = self.job.take() {
                std::mem::forget(job);
            }
            if let Some(child) = self.child.take() {
                std::mem::forget(child);
            }
        }
    }
}

#[cfg(windows)]
fn binding_arity_command(
    area: &BindingArityArea,
    test: &str,
) -> ArityResult<std::process::Command> {
    use std::process::Stdio;
    area.verify()?;
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .args(["--exact", test, "--nocapture"])
        .current_dir(&area.path);
    // Modify the child command only; never set/remove the parent environment.
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if ["AIOLM_", "LLAMA_BOARD_", "FAKE_", "SYNTHETIC_"]
            .iter()
            .any(|p| upper.starts_with(p))
            || ["HOMEDRIVE", "HOMEPATH"].contains(&upper.as_str())
        {
            command.env_remove(name);
        }
    }
    for (name, relative) in [
        ("AIOLM_HOME", "home"),
        ("HOME", "user"),
        ("USERPROFILE", "user"),
        ("APPDATA", "roaming"),
        ("LOCALAPPDATA", "local"),
        ("XDG_CONFIG_HOME", "xdg-config"),
        ("XDG_DATA_HOME", "xdg-data"),
        ("XDG_CACHE_HOME", "xdg-cache"),
        ("XDG_STATE_HOME", "xdg-state"),
        ("XDG_RUNTIME_DIR", "xdg-runtime"),
        ("TMP", "temp"),
        ("TEMP", "temp"),
        ("TMPDIR", "temp"),
    ] {
        let path = area.path.join(relative);
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                binding_arity_plain(&path)?;
            }
            Err(e) => return Err(e.into()),
        }
        command.env(name, path);
    }
    command
        .env(
            "AIOLM_ARITY_JOURNEY_OUTPUT",
            area.path.join("observations.json"),
        )
        .env("AIOLM_ARITY_FIXTURE_AREA", &area.path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(area.path.join("stdout.raw"))?,
        ))
        .stderr(Stdio::from(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(area.path.join("stderr.raw"))?,
        ));
    Ok(command)
}

#[cfg(windows)]
struct BindingArityInjectedUnwind;

#[cfg(windows)]
fn binding_arity_run(mode: &str) -> Value {
    use std::time::{Duration, Instant};
    let mut area = match BindingArityArea::new() {
        Ok(area) => area,
        Err(error) => {
            return json!({"mode": mode, "setup_error": error.to_string(), "cleanup_pass": false})
        }
    };
    let cleanup = Arc::new(Mutex::new(BindingArityCleanup::default()));
    let mut observation = Value::Null;
    let mut natural_success = false;
    let mut descendant_contained = false;
    let mut injection_reached = false;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> ArityResult<()> {
        let mut owned = BindingArityOwned::new(cleanup.clone())?;
        let test = if mode == "semantic" {
            "reviewed_binding_arity_child"
        } else {
            "reviewed_binding_arity_cleanup_child"
        };
        let mut command = binding_arity_command(&area, test)?;
        // Assignment/capture failures exercise the same Drop path as injection.
        injection_reached = mode.starts_with("error-after-") && mode != "error-after-ready";
        owned.spawn(&mut command, mode)?;
        if mode != "semantic" {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !area.path.join("ready").is_file() {
                if Instant::now() >= deadline {
                    return Err("cleanup descendant readiness timeout".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid: u32 = fs::read_to_string(area.path.join("descendant.pid"))?.parse()?;
            let job = owned.job.as_ref().ok_or("missing cleanup job")?;
            job.capture_members(None)?;
            descendant_contained = job.contains(pid);
            if !descendant_contained {
                return Err("cleanup descendant is not in owned job".into());
            }
            injection_reached = true;
            if mode == "error-after-ready" {
                return Err("injected after descendant readiness".into());
            }
            if mode == "unwind-after-ready" {
                std::panic::panic_any(BindingArityInjectedUnwind);
            }
            fs::write(area.path.join("stop"), b"stop")?;
        }
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            match owned
                .child
                .as_mut()
                .ok_or("missing owned child")?
                .try_wait()?
            {
                Some(status) => {
                    natural_success = status.success();
                    break;
                }
                None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                _ => return Err("owned child natural completion deadline expired".into()),
            }
        }
        owned.close()?;
        if mode == "semantic" {
            observation = serde_json::from_slice(&fs::read(area.path.join("observations.json"))?)?;
        }
        Ok(())
    }));
    let (setup_error, unwind) = match result {
        Ok(Ok(())) => (None, false),
        Ok(Err(e)) => (Some(e.to_string()), false),
        Err(payload) => (
            Some(
                if payload.is::<BindingArityInjectedUnwind>() {
                    "caught injected owned-tree unwind"
                } else {
                    "caught unexpected unwind"
                }
                .into(),
            ),
            true,
        ),
    };
    // Drop has completed before reading files, inventory, or removal.
    let state = cleanup.lock().unwrap_or_else(|e| e.into_inner());
    let process_pass = state.finished;
    let process_receipt = state.receipt.clone();
    drop(state);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let removal = (|| -> ArityResult<()> {
        if !process_pass {
            return Err("refuse inventory/removal: process cleanup unproved".into());
        }
        area.verify()?;
        binding_arity_tree(&area.path)?;
        stdout = fs::read(area.path.join("stdout.raw"))?;
        stderr = fs::read(area.path.join("stderr.raw"))?;
        area.remove_checked()
    })();
    json!({"mode": mode, "setup_error": setup_error, "unwind": unwind,
        "injection_reached": injection_reached, "descendant_contained": descendant_contained,
        "natural_success": natural_success, "process_cleanup": process_receipt,
        "cleanup_pass": removal.is_ok(), "cleanup_error": removal.err().map(|e| e.to_string()),
        "area": area.path, "intended_canonical_temp_boundary": area.boundary, "stdout": stdout, "stderr": stderr, "observations": observation})
}

#[cfg(windows)]
fn reviewed_binding_arity_before_registration() {
    let parent_environment = std::env::vars_os().collect::<BTreeMap<_, _>>();
    // Explicit external NEW receipt persists; otherwise create a unique owned
    // synthetic receipt and remove it after verified capture, before assertions.
    let mut receipt_area = None;
    let receipt_path = match std::env::var_os("AIOLM_ARITY_PREFLIGHT_RECEIPT") {
        Some(path) => {
            let path = PathBuf::from(path);
            assert!(path.is_absolute(), "receipt selector must be absolute");
            binding_arity_plain(path.parent().expect("receipt parent"))
                .expect("plain existing receipt parent");
            path
        }
        None => {
            let area = BindingArityArea::new().expect("exclusive default receipt area");
            area.verify().expect("default receipt ownership");
            let path = area.path.join("receipt.json");
            receipt_area = Some(area);
            path
        }
    };
    let mut receipt_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&receipt_path)
        .expect("exclusive preflight receipt output");
    let mut runs = Vec::new();
    for mode in [
        "normal-cleanup",
        "error-after-spawn",
        "error-after-assign",
        "error-after-capture",
        "error-after-ready",
        "unwind-after-ready",
    ] {
        runs.push(binding_arity_run(mode));
    }
    // No semantic RED is accepted unless all six ownership controls pass.
    let controls_pass = runs.iter().all(|run| {
        let mode = run["mode"].as_str().unwrap_or_default();
        run["cleanup_pass"] == true
            && run["process_cleanup"]["root_reaped"] == true
            && run["process_cleanup"]["job_empty_and_retained_members_signaled"] == true
            && if mode == "normal-cleanup" {
                run["setup_error"].is_null()
                    && run["natural_success"] == true
                    && run["descendant_contained"] == true
            } else {
                run["injection_reached"] == true
                    && run["setup_error"].as_str().is_some_and(|e| {
                        e.starts_with("injected ")
                            || (mode == "unwind-after-ready" && e.starts_with("caught injected"))
                    })
                    && run["natural_success"] == false
                    && run["process_cleanup"]["natural_status_before_termination"].is_null()
                    && (mode != "unwind-after-ready" || run["unwind"] == true)
                    && (!mode.ends_with("ready") || run["descendant_contained"] == true)
            }
    });
    let semantic = if controls_pass {
        binding_arity_run("semantic")
    } else {
        json!({"not_started": "ownership controls failed"})
    };
    let host_unchanged = parent_environment == std::env::vars_os().collect::<BTreeMap<_, _>>();
    let mut receipt = json!({"ownership_controls": runs, "controls_pass": controls_pass,
        "host_environment_unchanged": host_unchanged, "semantic": semantic,
        "parent_receipt": {"path": receipt_path, "external_retained": receipt_area.is_none(),
            "owned_transient": receipt_area.is_some(), "cleanup": if receipt_area.is_some() {"pending"} else {"not-applicable"}}});
    use std::io::Write;
    let bytes = serde_json::to_vec_pretty(&receipt).unwrap();
    receipt_file.write_all(&bytes).unwrap();
    receipt_file.sync_all().unwrap();
    drop(receipt_file);
    assert_eq!(
        fs::read(&receipt_path).expect("verify new receipt bytes"),
        bytes
    );
    let receipt_cleanup = match &mut receipt_area {
        Some(area) => area.remove_checked(),
        None => Ok(()),
    };
    receipt["parent_receipt"]["cleanup"] = if receipt_area.is_some() {
        match &receipt_cleanup {
            Ok(()) => json!("removed-and-absent"),
            Err(e) => json!({"retained_error": e.to_string()}),
        }
    } else {
        json!("not-applicable")
    };
    assert!(
        receipt_cleanup.is_ok(),
        "parent receipt cleanup: {receipt:#}"
    );
    assert!(controls_pass && host_unchanged, "{receipt:#}");
    assert_eq!(semantic["cleanup_pass"], true, "{receipt:#}");
    assert!(semantic["setup_error"].is_null(), "{receipt:#}");
    let observations = semantic["observations"].clone();
    let natural_success = semantic["natural_success"] == true;
    let empty = semantic["process_cleanup"]["job_empty_and_retained_members_signaled"] == true;
    let stdout = &semantic["stdout"];
    let stderr = &semantic["stderr"];
    // Reject temporary files with atomic_write's actual names.
    for row in observations["rows"]
        .as_array()
        .expect("complete child rows for staging audit")
    {
        let tree = row["tree_after"]
            .as_object()
            .expect("complete child tree for staging audit");
        assert!(
            tree.keys().all(|path| !path
                .split('/')
                .any(|part| part.starts_with('.') && part.contains(".tmp-"))),
            "atomic temporary file retained: {row:#}"
        );
    }
    // Validate ownership and all normal cases before contradictory bindings.

    assert!(
        empty && natural_success,
        "owned fixture failed: stdout={stdout:?}, stderr={stderr:?}"
    );
    assert!(
        observations.get("setup_error").is_none(),
        "{observations:#}"
    );
    let rows = observations["rows"]
        .as_array()
        .expect("complete child observations");
    assert_eq!(rows.len(), 16, "{observations:#}");
    for row in rows {
        let label = row["label"].as_str().unwrap();
        assert_eq!(row["help_complete"], true, "{label}: {row:#}");
        assert_eq!(row["help_exact"], true, "{label}: {row:#}");
        assert_eq!(row["help_idle"], true, "{label}: {row:#}");
        assert_eq!(
            row["arity"], row["expected_arity"],
            "{label}: parser prerequisite {row:#}"
        );
        assert_eq!(row["help_source"], true, "{label}: unsourced fact {row:#}");
        assert_eq!(row["draft_unchanged"], true, "{label}: {row:#}");
        assert_eq!(row["manifest_unchanged"], true, "{label}: {row:#}");
        assert_eq!(row["saved_unchanged"], true, "{label}: {row:#}");
        assert_eq!(row["staging_absent"], true, "{label}: {row:#}");
        assert_eq!(
            row["manifest_argv"], row["expected_argv"],
            "{label}: {row:#}"
        );
        let rejected = row["reject"].as_bool().unwrap();
        if !rejected {
            assert_eq!(row["acceptance_error"], Value::Null, "{label}: {row:#}");
            assert_eq!(row["registration_error"], Value::Null, "{label}: {row:#}");
            assert_eq!(row["probe_ran"], true, "{label}: {row:#}");
            assert_eq!(row["registration_exists"], true, "{label}: {row:#}");
            assert_eq!(row["accepted_exists"], row["uses_help"], "{label}: {row:#}");
            assert_eq!(
                row["registered_manifest"], row["manifest"],
                "{label}: {row:#}"
            );
            assert_eq!(
                row["resolved_argv"], row["expected_argv"],
                "{label}: {row:#}"
            );
        }
    }
    // Every parser prerequisite and valid control is checked before an
    // expected rejection can fail; incidental setup is not a policy RED.
    for row in rows.iter().filter(|row| row["reject"] == true) {
        let label = row["label"].as_str().unwrap();
        let message = row["acceptance_error"].as_str().unwrap_or_default();
        assert!(
            message.contains("binding")
                && message.contains("one value")
                && message.contains("discovered help"),
            "{label}: intended rejection absent {row:#}"
        );
        let message = row["registration_error"].as_str().unwrap_or_default();
        assert!(
            message.contains("binding")
                && message.contains("one value")
                && message.contains("discovered help"),
            "{label}: {row:#}"
        );
        assert_eq!(
            row["tree_unchanged"], true,
            "{label}: partial writes {row:#}"
        );
        assert_eq!(row["probe_ran"], false, "{label}: {row:#}");
        assert_eq!(row["registration_exists"], false, "{label}: {row:#}");
        assert_eq!(row["accepted_exists"], false, "{label}: {row:#}");
    }
}

#[cfg(windows)]
fn binding_arity_tree(root: &std::path::Path) -> Result<Value, Box<dyn std::error::Error>> {
    binding_arity_plain(root)?;
    if !root.is_absolute() || root.canonicalize()? != root {
        return Err("noncanonical inventory root".into());
    }
    fn visit(
        root: &std::path::Path,
        at: &std::path::Path,
        all: &mut BTreeMap<String, Value>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        binding_arity_plain(at)?;
        if !at.starts_with(root) || at.canonicalize()? != at {
            return Err("inventory directory escaped root".into());
        }
        for item in fs::read_dir(at)? {
            let path = item?.path();
            let metadata = binding_arity_plain(&path)?;
            if !path.starts_with(root) || path.canonicalize()? != path {
                return Err("inventory entry escaped root".into());
            }
            let key = path
                .strip_prefix(root)?
                .to_str()
                .ok_or("non-Unicode fixture path")?
                .replace('\\', "/");
            if metadata.is_dir() {
                all.insert(key, json!({"directory": true}));
                visit(root, &path, all)?;
            } else if metadata.is_file() {
                all.insert(key, json!({"bytes": fs::read(&path)?}));
            } else {
                return Err("non-regular fixture entry".into());
            }
        }
        Ok(())
    }
    let mut all = BTreeMap::new();
    visit(root, root, &mut all)?;
    Ok(serde_json::to_value(all)?)
}

#[cfg(windows)]
async fn binding_arity_observations() -> Result<Value, Box<dyn std::error::Error>> {
    use aiolm_lib::providers::{
        registry,
        runtime_options::{Arity, Source},
    };
    binding_arity_child_area()?;
    let home = PathBuf::from(std::env::var_os("AIOLM_HOME").ok_or("missing isolated home")?);
    let root = registry::root();
    if !root.starts_with(&home) {
        return Err("registry root escaped the synthetic home".into());
    }
    let engine = providers::ProviderId::parse("custom.bindingarityfixture").unwrap();
    let program = env!("CARGO_BIN_EXE_fake-llama-server").to_string();
    let expected_help = include_str!("runtime_binding_arity_help.txt");
    for (name, bytes) in [
        ("config.json", b"{\"synthetic\":\"config\"}".as_slice()),
        ("profiles.json", b"{\"synthetic\":\"profiles\"}".as_slice()),
        (
            "conversations.json",
            b"{\"synthetic\":\"conversations\"}".as_slice(),
        ),
    ] {
        fs::write(home.join(name), bytes)?;
    }
    let saved = ["config.json", "profiles.json", "conversations.json"];
    let saved_before = saved
        .iter()
        .map(|p| fs::read(home.join(p)))
        .collect::<Result<Vec<_>, _>>()?;
    // The existing default fixture supplies switch/pair/model/host/port.
    // Added syntax extends only its finite help branch, never launch parsing.
    let mut cases = Vec::new();
    for role in ["model", "port", "host", "served"] {
        cases.push((
            role,
            role,
            "--fresh-switch",
            Some(Arity {
                min: 0,
                max: Some(0),
            }),
            true,
            true,
            false,
        ));
        cases.push((
            role,
            role,
            "--fresh-pair",
            Some(Arity {
                min: 2,
                max: Some(2),
            }),
            true,
            true,
            false,
        ));
    }
    cases.extend([
        (
            "exact-one",
            "model",
            "--fresh-label",
            Some(Arity {
                min: 1,
                max: Some(1),
            }),
            false,
            true,
            false,
        ),
        (
            "optional-one",
            "model",
            "--fresh-optional",
            Some(Arity {
                min: 0,
                max: Some(1),
            }),
            false,
            true,
            false,
        ),
        (
            "variable-one-min",
            "model",
            "--fresh-files",
            Some(Arity { min: 1, max: None }),
            false,
            true,
            false,
        ),
        (
            "variable-zero-min",
            "model",
            "--fresh-any",
            Some(Arity { min: 0, max: None }),
            false,
            true,
            false,
        ),
        (
            "alias-one",
            "port",
            "-p",
            Some(Arity {
                min: 1,
                max: Some(1),
            }),
            false,
            true,
            false,
        ),
        ("unknown-alias", "model", "-i", None, false, true, false),
        // Explicit equals syntax stays valid when help shows separate values.
        (
            "equals-policy-control",
            "model",
            "--fresh-label",
            Some(Arity {
                min: 1,
                max: Some(1),
            }),
            false,
            true,
            true,
        ),
        // Explicit legacy contract: absence of help does not mandate discovery.
        (
            "no-help-contract",
            "model",
            "--fresh-switch",
            Some(Arity {
                min: 0,
                max: Some(0),
            }),
            false,
            false,
            false,
        ),
    ]);
    let mut rows = Vec::new();
    for (index, (label, role, flag, expected_arity, reject, uses_help, equals)) in
        cases.into_iter().enumerate()
    {
        let runtime = format!("case-{index}");
        let runtime_dir = root.join(engine.as_str()).join(&runtime);
        let marker = home.join(format!("probe-{index}.txt"));
        let entry = EntrypointHelp {
            command_layout: None,
            engine_id: engine,
            runtime_id: runtime.clone(),
            program: program.clone(),
            prefix: vec!["--adapter-engine".into()],
            working_directory: Some(home.to_string_lossy().into_owned()),
            artifacts: vec![],
            environment: BTreeMap::from([("FAKE_ENGINE_HELP".into(), "binding-arity".into())]),
            protocol: ServingProtocol::OpenaiHttp,
            option_metadata: None,
        };
        let request = HelpRequest {
            encoding: None,
            locale: None,
            working_directory: None,
            program: None,
            args: vec![
                "--adapter-engine".into(),
                "--adapter-help-fixture".into(),
                "--help".into(),
            ],
            scope: vec![],
        };
        let provisional = registry::provisional_manifest(&entry)?;
        let command = runtime_schema::manifest_help_command(&provisional, &request)?;
        let service = HelpService::default();
        let (report, descriptor) = runtime_help_store::discover_against(
            &service,
            &root,
            "binding-arity-owner",
            engine.as_str(),
            &runtime,
            &command,
            &[],
            Baseline::Latest,
        )?;
        let snapshot = runtime_help_store::load_snapshot(
            &root,
            engine.as_str(),
            &runtime,
            &descriptor.fingerprint,
        )?
        .ok_or("missing public discovery snapshot")?;
        let option = snapshot
            .schema
            .options
            .iter()
            .find(|option| option.spellings.iter().any(|s| s.flag == flag))
            .ok_or("fixture flag not parsed")?;
        let arity = option.arity.supported().copied();
        let help_source = if arity.is_some() {
            matches!(option.arity.source, Some(Source::Help { .. }))
        } else {
            option.arity.source.is_none() && option.arity.supported().is_none()
        };
        let flag_binding = |name: &str| ArgBinding::Flag {
            flag: name.into(),
            equals: false,
        };
        let mut draft = EntrypointDraft {
            command_layout: None,
            options_separator: None,
            launch_resources: None,
            models: vec![],
            engine_id: engine,
            runtime_id: runtime.clone(),
            display_name: "Synthetic binding arity".into(),
            program: program.clone(),
            prefix: entry.prefix.clone(),
            working_directory: entry.working_directory.clone(),
            artifacts: vec![],
            environment: entry.environment.clone(),
            model: flag_binding("--model"),
            port: flag_binding("--port"),
            host: Some(flag_binding("--host")),
            served_model: None,
            auth: AuthBinding::None,
            protocol: ServingProtocol::OpenaiHttp,
            probe: ProcessSpec {
                program: program.clone(),
                args: vec![
                    "--adapter-probe".into(),
                    engine.as_str().into(),
                    runtime.clone(),
                    "{model}".into(),
                ],
                env: BTreeMap::from([(
                    "FAKE_PROBE_MARKER".into(),
                    marker.to_string_lossy().into_owned(),
                )]),
                working_directory: None,
            },
            health_path: "/health".into(),
            health_authenticated: false,
            model_formats: vec!["unknown".into()],
            help: uses_help.then(|| DraftHelp {
                fingerprint: descriptor.fingerprint.clone(),
                request,
            }),
            option_metadata: None,
        };
        let chosen = ArgBinding::Flag {
            flag: flag.into(),
            equals,
        };
        match role {
            "model" => draft.model = chosen,
            "port" => draft.port = chosen,
            "host" => draft.host = Some(chosen),
            "served" => draft.served_model = Some(chosen),
            _ => return Err("unknown case role".into()),
        }
        let draft_before = serde_json::to_vec(&draft)?;
        let manifest = registry::manifest_from_draft(&draft)?;
        let manifest_before = serde_json::to_vec(&manifest)?;
        let mut expected_argv = entry.prefix.clone();
        for (name, binding) in [
            ("model", Some(&draft.model)),
            ("host", draft.host.as_ref()),
            ("port", Some(&draft.port)),
            ("model_alias", draft.served_model.as_ref()),
        ] {
            if let Some(ArgBinding::Flag { flag, equals }) = binding {
                let token = format!("{{{name}}}");
                if *equals {
                    expected_argv.push(format!("{flag}={token}"));
                } else {
                    expected_argv.extend([flag.clone(), token]);
                }
            }
        }
        fs::write(
            runtime_dir.join("keep.bin"),
            b"synthetic pre-existing runtime data",
        )?;
        let tree_before = binding_arity_tree(&home)?;
        let acceptance = runtime_schema::draft_acceptance(&root, &draft, &manifest);
        let registration = runtime_schema::register_entrypoint(&root, &draft, None).await;
        let tree_after = binding_arity_tree(&home)?;
        // Resolve a public command without executing it. No saved generic
        // options: the app-owned template must stay byte-for-byte intact.
        let resolved_argv = if registration.is_ok() {
            let cfg = AppConfig {
                active_provider: engine.as_str().into(),
                active_runtime: runtime.clone(),
                ..Default::default()
            };
            Some(runtime_schema::registered_arguments(
                &root,
                &cfg,
                &manifest,
                &manifest.launch.args,
            )?)
        } else {
            None
        };
        let staging_absent = tree_after
            .as_object()
            .ok_or("tree object")?
            .keys()
            .all(|p| {
                !p.split('/')
                    .any(|c| c == ".registering" || c.ends_with(".tmp") || c.ends_with(".staging"))
            });
        rows.push(json!({"label": format!("{label}-{flag}"), "reject": reject, "uses_help": uses_help,
            "help_complete": report.complete(), "help_exact": report.stdout.clean_text == expected_help && report.stderr.clean_text.is_empty(),
            "help_idle": service.cancel_all()? == 0, "arity": arity, "expected_arity": expected_arity, "help_source": help_source,
            "acceptance_error": acceptance.err(), "registration_error": registration.as_ref().err(),
            "probe_ran": marker.exists(), "registration_exists": runtime_dir.join("registration.json").is_file(),
            "accepted_exists": runtime_dir.join("help").join("accepted.json").is_file(),
            "tree_unchanged": tree_before == tree_after, "staging_absent": staging_absent,
            "saved_unchanged": saved.iter().map(|p| fs::read(home.join(p))).collect::<Result<Vec<_>, _>>()? == saved_before,
            "draft_unchanged": serde_json::to_vec(&draft)? == draft_before,
            "manifest_unchanged": serde_json::to_vec(&manifest)? == manifest_before,
            "draft": draft, "manifest": manifest, "registered_manifest": registration.ok(),
            "manifest_argv": manifest.launch.args, "expected_argv": expected_argv, "resolved_argv": resolved_argv,
            "raw_help": report, "snapshot": snapshot, "tree_before": tree_before, "tree_after": tree_after}));
    }
    Ok(json!({"rows": rows}))
}

#[cfg(windows)]
#[test]
fn reviewed_binding_arity_child() {
    let Some(path) = std::env::var_os("AIOLM_ARITY_JOURNEY_OUTPUT") else {
        return;
    };
    binding_arity_child_area().expect("refuse invalid child routing before any output write");
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())
        .and_then(|runtime| {
            runtime
                .block_on(binding_arity_observations())
                .map_err(|e| e.to_string())
        });
    let value = result.unwrap_or_else(|error| json!({"setup_error": error}));
    // Parent treats a missing/malformed observation as setup failure, after
    // reclaiming the entire owned tree and removing its synthetic directory.
    use std::io::Write;
    let bytes = serde_json::to_vec(&value).expect("serialize full child observation");
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .expect("exclusive child observation");
    output
        .write_all(&bytes)
        .expect("complete child observation write");
    output.sync_all().expect("flush child observation");
}

// Test-binary helpers are inert unless explicitly selected by the parent.
#[cfg(windows)]
fn binding_arity_child_area() -> ArityResult<PathBuf> {
    let area =
        PathBuf::from(std::env::var_os("AIOLM_ARITY_FIXTURE_AREA").ok_or("missing fixture area")?);
    if !area.is_absolute() || !binding_arity_plain(&area)?.is_dir() || area.canonicalize()? != area
    {
        return Err("child fixture area is not an absolute plain canonical directory".into());
    }
    let output = PathBuf::from(
        std::env::var_os("AIOLM_ARITY_JOURNEY_OUTPUT").ok_or("missing explicit child output")?,
    );
    if output != area.join("observations.json") {
        return Err("child output is outside selected area".into());
    }
    for (name, relative) in [
        ("AIOLM_HOME", "home"),
        ("HOME", "user"),
        ("USERPROFILE", "user"),
        ("APPDATA", "roaming"),
        ("LOCALAPPDATA", "local"),
        ("XDG_CONFIG_HOME", "xdg-config"),
        ("XDG_DATA_HOME", "xdg-data"),
        ("XDG_CACHE_HOME", "xdg-cache"),
        ("XDG_STATE_HOME", "xdg-state"),
        ("XDG_RUNTIME_DIR", "xdg-runtime"),
        ("TMP", "temp"),
        ("TEMP", "temp"),
        ("TMPDIR", "temp"),
    ] {
        let path =
            PathBuf::from(std::env::var_os(name).ok_or("missing isolated environment path")?);
        if path != area.join(relative)
            || !binding_arity_plain(&path)?.is_dir()
            || path.canonicalize()? != path
        {
            return Err("child environment path escaped selected area".into());
        }
    }
    for (name, _) in std::env::vars_os() {
        let key = name.to_string_lossy().to_ascii_uppercase();
        if key.starts_with("FAKE_")
            || key.starts_with("SYNTHETIC_")
            || key.starts_with("LLAMA_BOARD_")
            || (key.starts_with("AIOLM_")
                && ![
                    "AIOLM_HOME",
                    "AIOLM_ARITY_JOURNEY_OUTPUT",
                    "AIOLM_ARITY_FIXTURE_AREA",
                ]
                .contains(&key.as_str()))
        {
            return Err("conflicting inherited fixture/application environment".into());
        }
    }
    Ok(area)
}

#[cfg(windows)]
#[test]
fn reviewed_binding_arity_cleanup_child() {
    if std::env::var_os("AIOLM_ARITY_JOURNEY_OUTPUT").is_none() {
        return;
    }
    let area = binding_arity_child_area().expect("isolated cleanup child");
    let mut descendant = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "reviewed_binding_arity_cleanup_leaf",
            "--nocapture",
        ])
        .stdin(std::process::Stdio::null())
        .spawn()
        .expect("owned cleanup descendant");
    fs::write(area.join("descendant.pid"), descendant.id().to_string()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !area.join("leaf-ready").is_file() {
        assert!(
            std::time::Instant::now() < deadline,
            "cleanup leaf readiness deadline"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    fs::write(area.join("ready"), b"ready").unwrap();
    assert!(descendant
        .wait()
        .expect("natural cleanup descendant wait")
        .success());
}

#[cfg(windows)]
#[test]
fn reviewed_binding_arity_cleanup_leaf() {
    if std::env::var_os("AIOLM_ARITY_JOURNEY_OUTPUT").is_none() {
        return;
    }
    let area = binding_arity_child_area().expect("isolated cleanup leaf");
    // Hold real native file handles across the injected parent error/unwind.
    let _held = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(area.join("leaf-held.raw"))
        .unwrap();
    fs::write(area.join("leaf-ready"), b"ready").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    while !area.join("stop").is_file() {
        assert!(
            std::time::Instant::now() < deadline,
            "cleanup leaf natural stop deadline"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
