//! Exercise real adapter refresh inside preparation in a process with its own home.
use super::*;
use serde_json::json;
use std::{fs, net::TcpListener, path::Path, process::Command};

const WORKER: &str = "commands::server::launch_preparation_tests::isolated_preparation_worker";
const PROBE: &str = r#"
import json, os, pathlib, socket, subprocess, sys, time
root, model = pathlib.Path(sys.argv[1]), sys.argv[2]
if model:
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    (root / 'started.json').write_text(json.dumps([os.getpid(), child.pid, listener.getsockname()[1]]))
    try:
        while not (root / 'release').exists():
            time.sleep(0.01)
    finally:
        child.terminate()
        child.wait()
        listener.close()
    if (root / 'failure').exists():
        sys.stderr.write('invalid weights in ' + model + '\nrequest cancelled by upstream fixture\n')
        sys.exit(7)
print(json.dumps(dict(schema_version=1, engine_id='custom.preparation', runtime_id='synthetic',
    version='synthetic-1', accelerator='cpu', model=model, model_supported=bool(model),
    served_model='synthetic-model', capabilities=dict(tasks=['generate'],
    modalities=dict(text=True, image=False, audio=False, video=False), chat=True, tools=False))))
"#;

#[test]
fn launch_preparation_in_flight() {
    let root = std::env::temp_dir().join(format!("aiolm-prepare-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", WORKER, "--nocapture", "--test-threads=1"])
        .env("AIOLM_PREPARATION_TEST_ROOT", &root)
        .env("AIOLM_HOME", root.join("data"))
        .env("HOME", root.join("home"))
        .env("CFFIXED_USER_HOME", root.join("home"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", root.join("share"))
        .output()
        .unwrap();
    println!("{}", String::from_utf8_lossy(&output.stdout));
    // Keep an optional raw observation copy outside the disposable fixture.
    if let Some(path) = std::env::var_os("AIOLM_PREPARATION_OBSERVATIONS") {
        if root.join("observations.json").is_file() {
            fs::copy(root.join("observations.json"), path).unwrap();
        }
    }
    fs::remove_dir_all(root).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn wait_started(root: &Path) -> Vec<u64> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(bytes) = fs::read(root.join("started.json")) {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    return value;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the real probe must be running before the test requests cancellation")
}

async fn assert_reaped(started: &[u64]) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let gone = started[..2]
                .iter()
                .all(|pid| unsafe { libc::kill(*pid as i32, 0) != 0 });
            if gone {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owned probe and descendant must exit");
    let listener = TcpListener::bind(("127.0.0.1", started[2] as u16))
        .expect("owned probe listener must be released");
    drop(listener);
}

#[tokio::test]
async fn isolated_preparation_worker() {
    let Some(root) = std::env::var_os("AIOLM_PREPARATION_TEST_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let probe = root.join("probe.py");
    fs::write(&probe, PROBE).unwrap();
    let python = which::which("python3").expect("synthetic probe requires Python 3");
    let manifest = serde_json::from_value(json!({
        "schema_version": 1, "adapter_version": 1, "engine_id": "custom.preparation",
        "runtime_id": "synthetic", "display_name": "Synthetic preparation probe",
        "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
        "protocol": "openai-v1",
        "probe": {"program": python, "args": [probe, root, "{model}"]},
        "launch": {"program": python, "args": [probe, root, "{model}", "{port}"],
            "env": {"SYNTHETIC_API_KEY": "{api_key}"}},
        "artifacts": [probe], "model_formats": ["unknown"], "health_path": "/health"
    }))
    .unwrap();
    crate::providers::registry::register_manifest(manifest, None)
        .await
        .unwrap();
    let model = root.join("cancelled-runs-model.bin");
    fs::write(&model, b"synthetic model bytes").unwrap();
    let cfg = config::AppConfig {
        active_provider: "custom.preparation".into(),
        active_runtime: "synthetic".into(),
        active_model: model.to_string_lossy().into_owned(),
        ..Default::default()
    };
    let mut observations = Vec::new();
    for case in [
        "cancel",
        "failure",
        "success",
        "busy-success",
        "exit-success",
        "busy-cancel",
        "exit-cancel",
        "busy-failure",
        "exit-failure",
        "artifact-change",
    ] {
        for name in ["started.json", "release", "failure"] {
            let _ = fs::remove_file(root.join(name));
        }
        if case.contains("failure") {
            fs::write(root.join("failure"), b"fail after the gate").unwrap();
        }
        let state = AppState::default();
        state.server.lock().unwrap().model = "current-model".into();
        let pending = state.sessions.begin_pending_start("owned").unwrap();
        let unrelated = state.sessions.begin_pending_start("unrelated").unwrap();
        let cancel = pending.cancel_flag();
        assert!(!cancel.load(Ordering::Acquire));
        config::save(&config::AppConfig::default()).unwrap();
        let preparation = prepare_launch(&state, cfg.clone(), true, &cancel);
        tokio::pin!(preparation);
        let started = tokio::select! {
            result = &mut preparation => panic!("preparation finished before the probe gate: {:?}", result.err()),
            started = wait_started(&root) => started,
        };
        // A different settings save occurs while this probe is in flight.
        let latest = config::save(&config::AppConfig {
            port: 49123,
            ..config::load_result().unwrap()
        })
        .unwrap();
        let saved_bytes = fs::read(config::config_path()).unwrap();
        if case.starts_with("busy-") {
            state.runtime_busy.store(true, Ordering::Release);
        }
        if case.starts_with("exit-") {
            state.exiting.store(true, Ordering::Release);
        }
        if case == "artifact-change" {
            fs::write(
                &probe,
                format!("{PROBE}\n# changed after the probe started\n"),
            )
            .unwrap();
        }
        if case.contains("cancel") {
            // Exercise the same pending-start owner cancellation used by session_stop.
            state.sessions.cancel_pending_start("owned");
        } else {
            fs::write(root.join("release"), b"finish probe").unwrap();
        }
        let result = tokio::time::timeout(Duration::from_secs(10), &mut preparation)
            .await
            .unwrap();
        let outcome = match result {
            Ok(prepared) => {
                assert_eq!(case, "success");
                assert_eq!(prepared.cfg.active_model, cfg.active_model);
                assert_eq!(prepared.cfg.port, latest.port);
                assert_eq!(
                    config::load_result().unwrap().active_model,
                    cfg.active_model
                );
                "prepared".to_string()
            }
            Err(error) => {
                if case == "artifact-change" {
                    assert_eq!(
                        error,
                        "adapter artifact changed; register the updated build explicitly"
                    );
                } else if case.ends_with("failure") {
                    assert!(error.contains("invalid weights in"), "{error}");
                    assert!(error.contains(&cfg.active_model), "{error}");
                    assert!(
                        error.contains("request cancelled by upstream fixture"),
                        "{error}"
                    );
                } else if case.contains("cancel") {
                    assert_eq!(error, "server start cancelled");
                } else if case.starts_with("busy-") {
                    assert!(
                        error.contains("a runtime operation is in progress"),
                        "{error}"
                    );
                } else if case.starts_with("exit-") {
                    assert_eq!(error, "application is exiting");
                } else {
                    panic!("unexpected preparation failure in {case}: {error}");
                }
                assert_eq!(fs::read(config::config_path()).unwrap(), saved_bytes);
                error
            }
        };
        assert!(!unrelated.cancel_flag().load(Ordering::Acquire));
        assert_eq!(state.server.lock().unwrap().model, "current-model");
        assert!(state.server.lock().unwrap().child.is_none());
        assert_reaped(&started).await;
        let row = json!({"case":case,"cancelInitiallySet":false,"probePid":started[0],
            "descendantPid":started[1],"port":started[2],"outcome":outcome,
            "ownedProcessesExited":true,"ownedPortReleased":true,
            "unrelatedOwnerPreserved":true,"unrelatedConfigPreserved":true});
        println!("{row}");
        observations.push(row);
    }
    for (busy, exiting, expected) in [
        (
            true,
            true,
            "a runtime operation is in progress; wait for it to finish before starting the server",
        ),
        (false, true, "application is exiting"),
        (false, false, "server start cancelled"),
    ] {
        let state = AppState::default();
        state.runtime_busy.store(busy, Ordering::Release);
        state.exiting.store(exiting, Ordering::Release);
        let error = prepare_launch(
            &state,
            config::AppConfig::default(),
            true,
            &Arc::new(AtomicBool::new(true)),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error, expected);
    }
    fs::write(
        root.join("observations.json"),
        serde_json::to_vec_pretty(&observations).unwrap(),
    )
    .unwrap();
}
