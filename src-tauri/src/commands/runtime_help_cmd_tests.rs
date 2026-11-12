//! Exercise the IPC handlers with a task-scoped native dialog response. Each
//! journey runs in its own process so registrations and approvals never touch
//! another test's home or the user's settings.
use super::*;
use crate::{
    error::ErrorKind,
    native_confirm::{TestAnswer, TEST_ANSWERS},
    providers::ProviderId,
};
use std::{cell::RefCell, collections::VecDeque, fs, future::Future, io::Write, path::PathBuf};

const SUITE: &str = "AIOLM_HELP_APPROVAL_SUITE";
const MARKER: &str = "SYNTHETIC_HELP_EXECUTION_MARKER";
const JOURNEY: &str = "commands::runtime_help_cmd::tests::approval_journey_child";
const PROCESS: &str = "commands::runtime_help_cmd::tests::help_process_child";

struct Home(PathBuf);
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn answer<T>(answers: &[bool], future: impl Future<Output = T>) -> T {
    TEST_ANSWERS
        .scope(
            RefCell::new(
                answers
                    .iter()
                    .copied()
                    .map(TestAnswer::Immediate)
                    .collect::<VecDeque<_>>(),
            ),
            async {
                let result = future.await;
                TEST_ANSWERS.with(|answers| {
                    assert!(
                        answers.borrow().is_empty(),
                        "execution bypassed native approval"
                    );
                });
                result
            },
        )
        .await
}

fn denied<T: std::fmt::Debug>(result: Result<T, crate::error::AppError>) {
    assert_eq!(result.unwrap_err().kind, ErrorKind::Denied);
}

async fn pending_answer<T: Send + 'static>(
    future: impl Future<Output = T> + Send + 'static,
) -> (
    tokio::task::JoinHandle<T>,
    tokio::sync::oneshot::Sender<bool>,
) {
    let (opened, ready) = tokio::sync::oneshot::channel();
    let (answer, receiver) = tokio::sync::oneshot::channel();
    let pending = tokio::spawn(TEST_ANSWERS.scope(
        RefCell::new(VecDeque::from([TestAnswer::Delayed {
            opened,
            answer: receiver,
        }])),
        future,
    ));
    tokio::time::timeout(std::time::Duration::from_secs(10), ready)
        .await
        .expect("approval dialog did not open")
        .expect("approval request disappeared");
    (pending, answer)
}

async fn cancelled<T: std::fmt::Debug>(
    pending: tokio::task::JoinHandle<Result<T, crate::error::AppError>>,
    late_answer: tokio::sync::oneshot::Sender<bool>,
) {
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), pending)
        .await
        .expect("cancelled approval kept waiting for an answer")
        .unwrap();
    assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
    assert!(
        late_answer.send(true).is_err(),
        "cancelled prompt still accepted an answer"
    );
}

#[test]
fn ipc_help_approvals_cover_registered_commands() {
    let home =
        Home(std::env::temp_dir().join(format!("aiolm-help-approval-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&home.0).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", JOURNEY, "--nocapture"])
        .env(SUITE, "1")
        .env("AIOLM_HOME", &home.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn help_process_child() {
    let Some(marker) = std::env::var_os(MARKER) else {
        return;
    };
    writeln!(
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(marker)
            .unwrap(),
        "executed"
    )
    .unwrap();
    println!("Options:\n  --approved VALUE   Synthetic execution option");
}

#[test]
fn approval_journey_child() {
    if std::env::var_os(SUITE).is_none() {
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let home = PathBuf::from(std::env::var_os("AIOLM_HOME").unwrap());
        let marker = home.join("executions.txt");
        let program = std::env::current_exe().unwrap();
        let prefix = vec!["--exact".to_owned(), PROCESS.to_owned(), "--nocapture".to_owned()];
        let artifact = home.join("declared-artifact");
        fs::write(&artifact, b"synthetic declared engine").unwrap();
        let engine = "custom.helpapproval";
        let runtime = "synthetic";
        let mut launch_args = prefix.clone();
        launch_args.extend(["--model".into(), "{model}".into(), "--port".into(), "{port}".into()]);
        let manifest: crate::providers::registry::RuntimeManifest = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "adapter_version": 1,
            "engine_id": engine, "runtime_id": runtime, "display_name": "Synthetic help runtime",
            "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
            "protocol": "openai-v1", "model_formats": ["unknown"], "health_path": "/health",
            "probe": {"program": program, "args": ["{model}"], "env": {}},
            "launch": {"program": program, "args": launch_args, "env": {MARKER: marker}},
            "artifacts": [artifact]
        })).unwrap();
        crate::providers::registry::validate_manifest(&manifest).unwrap();
        let registration = adapters_root().join(engine).join(runtime);
        fs::create_dir_all(&registration).unwrap();
        fs::write(registration.join("registration.json"), serde_json::to_vec(&serde_json::json!({
            "manifest": manifest, "executable_sha256": "synthetic", "probe_sha256": "synthetic"
        })).unwrap()).unwrap();
        let cfg = crate::config::AppConfig {
            active_provider: engine.into(), active_runtime: runtime.into(), ..Default::default()
        };
        let request = runtime_schema::HelpRequest {
            encoding: None, locale: None, working_directory: Some(home.to_string_lossy().into_owned()),
            program: None, args: prefix.clone(),
            scope: crate::providers::runtime_command::scope(None, &prefix).unwrap(),
        };
        let command = runtime_schema::help_command(&cfg, &request).unwrap();

        // Registration, including a valid prefix and environment, cannot bypass
        // approval through either the raw or selected-runtime IPC route.
        denied(answer(&[false], runtime_help_discover(
            "raw-denied".into(), engine.into(), runtime.into(), command.clone(), vec![]
        )).await);
        denied(answer(&[false], runtime_help_discover_selected(cfg.clone(), request.clone())).await);
        assert!(!marker.exists(), "a denied discovery executed its child");

        let mut artifact_request = request.clone();
        artifact_request.program = Some(artifact.to_string_lossy().into_owned());
        artifact_request.args = vec!["arbitrary-artifact-argument".into()];
        artifact_request.scope.clear();
        denied(answer(&[false], runtime_help_discover_selected(cfg.clone(), artifact_request)).await);

        let entry: crate::providers::registry::EntrypointHelp = serde_json::from_value(serde_json::json!({
            "engine_id": engine, "runtime_id": runtime, "program": program,
            "prefix": prefix, "artifacts": [artifact], "environment": {MARKER: marker},
            "protocol": {"kind": "openai_http"}
        })).unwrap();

        // Cancellation must reach the dialog before any help process exists.
        // The withdrawn prompt cannot save a late Yes as a reusable approval.
        let (pending, late_answer) = pending_answer(runtime_help_discover_selected(
            cfg.clone(), request.clone()
        )).await;
        assert!(runtime_help_cancel_selected(cfg.clone()).await.unwrap());
        cancelled(pending, late_answer).await;
        denied(answer(&[false], runtime_help_discover_selected(cfg.clone(), request.clone())).await);

        let (pending, late_answer) = pending_answer(runtime_help_discover(
            "waiting-raw".into(), engine.into(), runtime.into(), command.clone(), vec![]
        )).await;
        assert!(runtime_help_cancel_owner("waiting-raw".into()).await.unwrap());
        cancelled(pending, late_answer).await;
        denied(answer(&[false], runtime_help_discover(
            "waiting-raw".into(), engine.into(), runtime.into(), command.clone(), vec![]
        )).await);

        let (pending, late_answer) = pending_answer(entrypoint_help_discover(
            entry.clone(), request.clone(), Some(cfg.clone())
        )).await;
        assert!(entrypoint_help_cancel(entry.clone()).await.unwrap());
        cancelled(pending, late_answer).await;

        // A newer discovery by the same owner withdraws the old prompt too.
        let (pending, late_answer) = pending_answer(runtime_help_discover_selected(
            cfg.clone(), request.clone()
        )).await;
        denied(answer(&[false], runtime_help_discover_selected(cfg.clone(), request.clone())).await);
        cancelled(pending, late_answer).await;
        denied(answer(&[false], runtime_help_discover_selected(cfg.clone(), request.clone())).await);

        // Dropping the requesting future releases its owner and prompt.
        let (pending, late_answer) = pending_answer(runtime_help_discover_selected(
            cfg.clone(), request.clone()
        )).await;
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        assert!(late_answer.send(true).is_err());
        assert!(!runtime_help_cancel_selected(cfg.clone()).await.unwrap());
        denied(answer(&[false], runtime_help_discover_selected(cfg.clone(), request.clone())).await);
        denied(answer(&[false], entrypoint_help_discover(entry, request.clone(), Some(cfg.clone()))).await);
        assert!(!marker.exists());

        // The exact approved command runs, and its persisted approval is shared
        // by the selected-runtime route without asking again.
        let (report, _) = answer(&[true], runtime_help_discover(
            "raw-approved".into(), engine.into(), runtime.into(), command.clone(), vec![]
        )).await.unwrap();
        assert!(report.complete(), "{report:?}");
        assert_eq!(fs::read_to_string(&marker).unwrap(), "executed\n");
        let (report, _) = answer(&[], runtime_help_discover_selected(cfg.clone(), request.clone())).await.unwrap();
        assert!(report.complete(), "{report:?}");
        assert_eq!(fs::read_to_string(&marker).unwrap(), "executed\nexecuted\n");

        let mut changed_args = request.clone();
        changed_args.args.push("--test-threads=1".into());
        denied(answer(&[false], runtime_help_discover_selected(cfg.clone(), changed_args)).await);
        let other_directory = home.join("other-directory");
        fs::create_dir(&other_directory).unwrap();
        let mut changed_directory = request.clone();
        changed_directory.working_directory = Some(other_directory.to_string_lossy().into_owned());
        denied(answer(&[false], runtime_help_discover_selected(cfg, changed_directory)).await);
        let mut changed_environment = command;
        changed_environment.environment.insert("SYNTHETIC_EXECUTION_CONTEXT".into(), "changed".into());
        denied(answer(&[false], runtime_help_discover(
            "changed-environment".into(), engine.into(), runtime.into(), changed_environment, vec![]
        )).await);
        assert_eq!(fs::read_to_string(&marker).unwrap(), "executed\nexecuted\n");

        // A fixed -m entry point is not safe just because it is installed:
        // external Python may import code from the requested directory.
        for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
            let external = crate::providers::python_env::PythonRuntimeManifest {
                format: 1, provider, id: "external-synthetic".into(),
                kind: crate::providers::python_env::InstallationKind::External,
                python: program.to_string_lossy().into_owned(), requested_version: None,
                probe: Some(crate::providers::python_env::ProbeRecord {
                    version: "synthetic".into(), ..Default::default()
                }),
            };
            let directory = crate::providers::python_env::providers_root().join(provider.as_str()).join(&external.id);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(crate::providers::python_env::MANIFEST), serde_json::to_vec(&external).unwrap()).unwrap();
            let cfg = crate::config::AppConfig {
                active_provider: provider.as_str().into(), active_runtime: external.id.clone(), ..Default::default()
            };
            let (args, scope) = crate::providers::launch::help_entry(&external).unwrap();
            let request = runtime_schema::HelpRequest {
                encoding: None, locale: None, working_directory: Some(home.to_string_lossy().into_owned()),
                program: None, args, scope,
            };
            let selected = crate::providers::adapter::help::Selected::python(&external).unwrap();
            let command = crate::providers::adapter::help::help_command(&cfg, &selected, &request).unwrap();
            denied(answer(&[false], runtime_help_discover(
                "external-denied".into(), provider.as_str().into(), external.id.clone(), command, vec![]
            )).await);
            // The selected route also enforces host compatibility before the
            // approval boundary. Exercise it where these engine kinds run.
            if (provider == ProviderId::Vllm && cfg!(target_os = "linux"))
                || (provider == ProviderId::MlxVlm
                    && cfg!(all(target_os = "macos", target_arch = "aarch64")))
            {
                denied(answer(&[false], runtime_help_discover_selected(cfg, request)).await);
            }
        }
        assert_eq!(fs::read_to_string(&marker).unwrap(), "executed\nexecuted\n");
    });
}
