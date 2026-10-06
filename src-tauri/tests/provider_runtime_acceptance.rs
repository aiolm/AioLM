//! Opt-in actual-engine acceptance for Linux vLLM, Apple Silicon vllm-metal
//! (via the vLLM engine) and mlx-vlm.
//!
//! The default `cargo test` gate runs only the synthetic schema and platform
//! checks below: no engine, model, accelerator or network is touched. The live
//! harness run is `#[ignore]`d and needs explicit inputs in an isolated
//! temporary AIOLM_HOME. It never downloads a model and never runs
//! `runtime install`.
//!
//! Live run (Linux example, from the repository root):
//! ```sh
//! AIOLM_PROVIDER_ACCEPTANCE=1 \
//! AIOLM_PROVIDER_ENGINE=vllm \
//! AIOLM_PROVIDER_PYTHON=/usr/bin/python3 \
//! AIOLM_PROVIDER_MODEL=/data/models/qwen2.5-0.5b-snapshot \
//! AIOLM_PROVIDER_REVISION=0123456789abcdef0123456789abcdef01234567 \
//! AIOLM_PROVIDER_CLI=.codex-target/release/aiolm-cli \
//! AIOLM_PROVIDER_PORT=18080 \
//! cargo test --locked --manifest-path src-tauri/Cargo.toml \
//!   --test provider_runtime_acceptance -- --ignored --nocapture --test-threads=1
//! ```
//! Reuse an already registered runtime with `AIOLM_PROVIDER_RUNTIME=<id>`
//! instead of `AIOLM_PROVIDER_PYTHON`. A Windows host must report `blocked`,
//! never a Linux/macOS native pass. Task modes (`AIOLM_PROVIDER_TASK`
//! chat|embedding|transcription, default chat) keep embedding-only and STT
//! checkpoints from failing a mandatory chat they never claimed.
//!
//! Scope boundary: the headless CLI talks directly to the engine and bypasses
//! the application protocol and gateway. Engine verdicts prove engine
//! behavior only; media/history/adapter/gateway coverage belongs to precise
//! GUI/native tests and is never inferred from an engine 4xx.

use std::path::{Path, PathBuf};

const REQUIRED_CHECKS: &[&str] = &[
    "platform",
    "registration",
    "probe",
    "runtime_identity",
    "config_selection",
    "model_validation",
    "server_launch",
    "model_alias",
    "stream_text_usage",
    "cancel",
    "restart",
    "stop",
    "media_supported",
    "media_refusal",
    "tools",
    "embeddings",
    "transcription",
    "benchmark",
    "deep_verification",
    "cleanup",
];

const ALLOWED_STATUSES: &[&str] = &["pass", "fail", "unsupported", "unrun", "blocked"];

fn outcome_of(statuses: &[&str]) -> &'static str {
    if statuses.contains(&"fail") {
        return "fail";
    }
    if statuses.contains(&"blocked") {
        return "blocked";
    }
    "pass"
}

#[test]
fn acceptance_statuses_are_closed_and_fail_beats_blocked() {
    assert_eq!(outcome_of(&["pass", "unsupported", "unrun"]), "pass");
    assert_eq!(outcome_of(&["pass", "blocked", "unrun"]), "blocked");
    assert_eq!(outcome_of(&["pass", "blocked", "fail"]), "fail");
    for status in ALLOWED_STATUSES {
        assert!(
            ["pass", "fail", "unsupported", "unrun", "blocked"].contains(status),
            "unexpected status {status}"
        );
    }
    assert_eq!(REQUIRED_CHECKS.len(), 20);
}

#[test]
fn windows_hosts_cannot_claim_native_python_engine_support() {
    use aiolm_lib::providers::{availability_for, ProviderId};
    // availability_for lets tests supply the host triple without executing tools.
    assert!(!availability_for(ProviderId::Vllm, "windows", "x86_64").supported);
    assert!(!availability_for(ProviderId::MlxVlm, "windows", "x86_64").supported);
    assert!(!availability_for(ProviderId::MlxVlm, "linux", "x86_64").supported);
    assert!(availability_for(ProviderId::Vllm, "linux", "x86_64").supported);
    assert!(availability_for(ProviderId::MlxVlm, "macos", "aarch64").supported);
}

/// Every fixture below carries all required checks: a partial object must be
/// rejected for its missing checks, never mistaken for an honest verdict.
fn full_checks(status: &str, detail: &str) -> serde_json::Value {
    let mut checks = serde_json::Map::new();
    for name in REQUIRED_CHECKS {
        checks.insert(
            name.to_string(),
            serde_json::json!({ "name": name, "status": status, "detail": detail, "evidence": {} }),
        );
    }
    serde_json::Value::Object(checks)
}

fn honest_live_result() -> serde_json::Value {
    let mut result = serde_json::json!({
        "schema": 1,
        "synthetic": false,
        "live": true,
        "task": "chat",
        "servedAlias": "qwen2.5-0.5b",
        "usage": { "prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10 },
        "embeddings": { "count": 1, "dims": 4 },
        "transcript": { "chars": 16 },
        "tools": { "accepted": true, "called": true },
        "inputs": {
            "engine": "vllm",
            "task": "chat",
            "python": "python3",
            "runtimeId": "test-runtime-1",
            "model": "qwen2.5-0.5b-snapshot",
            "revision": "0123456789abcdef0123456789abcdef01234567",
            "companion": null,
            "cli": "aiolm-cli",
            "port": 18080,
        },
        "checks": full_checks("pass", "honest"),
    });
    result["checks"]["stream_text_usage"]["evidence"] = serde_json::json!({ "usage": { "prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10 } });
    result["checks"]["tools"]["evidence"] =
        serde_json::json!({ "toolsAccepted": true, "toolCalled": true });
    result["checks"]["embeddings"]["evidence"] = serde_json::json!({ "count": 1, "dims": 4 });
    result["checks"]["benchmark"] = serde_json::json!({ "name": "benchmark", "status": "unrun", "detail": "desktop follow-up", "evidence": {} });
    result["checks"]["deep_verification"] = serde_json::json!({ "name": "deep_verification", "status": "unrun", "detail": "desktop follow-up", "evidence": {} });
    result
}

/// A streamed-text pass without authoritative usage is an invented pass.
/// The harness must fail it instead.
#[test]
fn result_schema_rejects_a_stream_pass_without_usage() {
    let mut dishonest = honest_live_result();
    dishonest["usage"] = serde_json::Value::Null;
    dishonest["checks"]["stream_text_usage"]["evidence"] = serde_json::json!({});
    assert!(
        validate_result(&dishonest).is_err(),
        "a stream pass without usage tokens must be rejected"
    );
    let mut honest = honest_live_result();
    honest["checks"]["stream_text_usage"] = serde_json::json!({ "name": "stream_text_usage", "status": "fail", "detail": "missing usage", "evidence": {} });
    honest["usage"] = serde_json::Value::Null;
    assert!(validate_result(&honest).is_ok());
}

#[test]
fn result_schema_rejects_partial_objects_and_missing_genuine_evidence() {
    // A partial object with a single check is not an honest fixture.
    let partial = serde_json::json!({
        "schema": 1,
        "synthetic": false,
        "live": true,
        "checks": {
            "stream_text_usage": { "name": "stream_text_usage", "status": "fail", "detail": "missing usage", "evidence": {} }
        },
        "usage": null,
    });
    assert!(
        validate_result(&partial).is_err(),
        "a result missing required checks must be rejected"
    );

    // A model-alias pass without a served alias is invented coverage.
    let mut no_alias = honest_live_result();
    no_alias["servedAlias"] = serde_json::json!("");
    assert!(validate_result(&no_alias).is_err());

    // An embeddings pass without complete vector dimensions is invented.
    let mut no_vectors = honest_live_result();
    no_vectors["embeddings"] = serde_json::json!({ "count": 0, "dims": 0 });
    assert!(validate_result(&no_vectors).is_err());

    // A transcription pass without transcript text is invented.
    let mut no_transcript = honest_live_result();
    no_transcript["transcript"] = serde_json::json!({ "chars": 0 });
    assert!(validate_result(&no_transcript).is_err());

    // A tools pass must record acceptance separately from the actual call.
    let mut no_tool_evidence = honest_live_result();
    no_tool_evidence["checks"]["tools"]["evidence"] = serde_json::json!({});
    assert!(validate_result(&no_tool_evidence).is_err());

    assert!(validate_result(&honest_live_result()).is_ok());
}

#[test]
fn shareable_results_carry_no_user_paths_or_process_identity() {
    assert!(validate_privacy(&honest_live_result()).is_ok());
    let mut raw = honest_live_result();
    raw["inputs"]["python"] = serde_json::json!("/home/operator/.venvs/vllm/bin/python");
    raw["inputs"]["model"] = serde_json::json!("/data/models/qwen2.5-0.5b-snapshot");
    assert!(validate_privacy(&raw).is_err());
    let mut pid = honest_live_result();
    pid["checks"]["server_launch"]["evidence"] =
        serde_json::json!({ "pid": 4242, "url": "http://127.0.0.1:18080/v1" });
    assert!(validate_privacy(&pid).is_err());
}

fn validate_result(result: &serde_json::Value) -> Result<(), String> {
    if result.get("schema") != Some(&serde_json::json!(1)) {
        return Err("result schema must be 1".into());
    }
    let checks = result
        .get("checks")
        .and_then(|value| value.as_object())
        .ok_or("result checks must be an object")?;
    for name in REQUIRED_CHECKS {
        let check = checks
            .get(*name)
            .ok_or_else(|| format!("missing check {name}"))?;
        let status = check
            .get("status")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("check {name} needs a status"))?;
        if !ALLOWED_STATUSES.contains(&status) {
            return Err(format!("check {name} has unknown status {status}"));
        }
    }
    let status_of = |name: &str| {
        checks
            .get(name)
            .and_then(|check| check.get("status"))
            .and_then(|status| status.as_str())
    };
    // No fake pass: a streamed-text pass must carry authoritative usage.
    if status_of("stream_text_usage") == Some("pass") {
        let usage = result.get("usage").ok_or("stream pass needs usage")?;
        for key in ["prompt_tokens", "completion_tokens", "total_tokens"] {
            if usage.get(key).and_then(|value| value.as_u64()).is_none() {
                return Err(format!("stream pass needs usage.{key} as a number"));
            }
        }
    }
    // No fake alias: a model-alias pass must name the served alias.
    if status_of("model_alias") == Some("pass") {
        let alias = result
            .get("servedAlias")
            .and_then(|value| value.as_str())
            .ok_or("model alias pass needs servedAlias")?;
        if alias.is_empty() {
            return Err("model alias pass needs a nonempty servedAlias".into());
        }
    }
    // No fake vectors: an embeddings pass must record complete dimensions.
    if status_of("embeddings") == Some("pass") {
        let embeddings = result
            .get("embeddings")
            .ok_or("embeddings pass needs embeddings")?;
        let count = embeddings
            .get("count")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let dims = embeddings
            .get("dims")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        if count == 0 || dims == 0 {
            return Err("embeddings pass needs a nonzero count and dims".into());
        }
    }
    // No fake transcript: a transcription pass must record transcript text.
    if status_of("transcription") == Some("pass") {
        let chars = result
            .get("transcript")
            .and_then(|value| value.get("chars"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        if chars == 0 {
            return Err("transcription pass needs nonzero transcript chars".into());
        }
    }
    // Tools acceptance stays separate from the actual tool call.
    if status_of("tools") == Some("pass") {
        let evidence = checks
            .get("tools")
            .and_then(|check| check.get("evidence"))
            .ok_or("tools pass needs evidence")?;
        if evidence.get("toolsAccepted") != Some(&serde_json::json!(true)) {
            return Err("tools pass must record toolsAccepted".into());
        }
        if evidence
            .get("toolCalled")
            .and_then(|value| value.as_bool())
            .is_none()
        {
            return Err("tools pass must record whether toolCalled fired".into());
        }
    }
    // A blocked platform must not claim a live server pass.
    if status_of("platform") == Some("blocked") && status_of("server_launch") == Some("pass") {
        return Err("a blocked platform must not report a server launch pass".into());
    }
    // Synthetic fixtures are never native evidence.
    if result.get("synthetic") == Some(&serde_json::json!(true))
        && result.get("live") == Some(&serde_json::json!(true))
    {
        return Err("a synthetic fixture must not claim live=true".into());
    }
    validate_privacy(result)
}

/// Shareable JSON (the --out file) must never carry user model/Python paths,
/// PIDs or URLs. Inputs stay basenames; full local paths belong on the
/// console only (--keep-home logging).
fn validate_privacy(result: &serde_json::Value) -> Result<(), String> {
    if let Some(inputs) = result.get("inputs").and_then(|value| value.as_object()) {
        for key in ["python", "model", "cli", "companion"] {
            if let Some(path) = inputs.get(key).and_then(|value| value.as_str()) {
                if path.contains('/') || path.contains('\\') || path.contains(':') {
                    return Err(format!(
                        "shareable inputs.{key} must be a basename, not a path"
                    ));
                }
            }
        }
    }
    let text = serde_json::to_string(result).map_err(|error| error.to_string())?;
    for marker in [
        "\"pid\"",
        "\"location\"",
        "\"log_path\"",
        "\"state_file\"",
        "127.0.0.1",
        "http://",
    ] {
        if text.contains(marker) {
            return Err(format!("shareable result must not contain {marker}"));
        }
    }
    Ok(())
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("set {name} to run the live provider acceptance test"))
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .to_path_buf()
}

/// Gated behind `AIOLM_PROVIDER_ACCEPTANCE=1` and `#[ignore]`: runs the real
/// Node harness with explicit inputs in an isolated home. Nothing is
/// downloaded. On a host that cannot run the engine the harness must report
/// `blocked`, not a pass.
#[test]
#[ignore = "needs an explicit engine, interpreter, model and CLI; set AIOLM_PROVIDER_ACCEPTANCE=1 and run with --ignored"]
fn live_provider_acceptance_through_isolated_harness() {
    if std::env::var("AIOLM_PROVIDER_ACCEPTANCE").as_deref() != Ok("1") {
        eprintln!(
            "[SKIP] Set AIOLM_PROVIDER_ACCEPTANCE=1 to run the real provider acceptance test."
        );
        return;
    }
    let engine = required_env("AIOLM_PROVIDER_ENGINE")
        .expect("set AIOLM_PROVIDER_ENGINE to vllm or mlx-vlm");
    assert!(
        engine == "vllm" || engine == "mlx-vlm",
        "AIOLM_PROVIDER_ENGINE must be vllm or mlx-vlm"
    );
    let task = std::env::var("AIOLM_PROVIDER_TASK").unwrap_or_else(|_| "chat".into());
    assert!(
        task == "chat" || task == "embedding" || task == "transcription",
        "AIOLM_PROVIDER_TASK must be chat, embedding or transcription"
    );
    let model = required_env("AIOLM_PROVIDER_MODEL")
        .expect("set AIOLM_PROVIDER_MODEL to an existing snapshot dir or GGUF file");
    assert!(
        Path::new(&model).exists(),
        "AIOLM_PROVIDER_MODEL does not exist: {model}"
    );
    let cli =
        required_env("AIOLM_PROVIDER_CLI").expect("set AIOLM_PROVIDER_CLI to the aiolm-cli binary");
    assert!(
        Path::new(&cli).exists(),
        "AIOLM_PROVIDER_CLI not found: {cli}"
    );
    let python = std::env::var("AIOLM_PROVIDER_PYTHON").unwrap_or_default();
    let runtime = std::env::var("AIOLM_PROVIDER_RUNTIME").unwrap_or_default();
    assert!(
        !python.is_empty() || !runtime.is_empty(),
        "set AIOLM_PROVIDER_PYTHON to register or AIOLM_PROVIDER_RUNTIME to reuse"
    );
    if !python.is_empty() {
        assert!(
            Path::new(&python).exists(),
            "AIOLM_PROVIDER_PYTHON not found: {python}"
        );
    }

    let root = repo_root();
    let harness = root.join("scripts").join("smoke-provider-runtime.mjs");
    assert!(harness.exists(), "harness not found: {}", harness.display());
    let out = std::env::temp_dir().join(format!(
        "aiolm-provider-acceptance-{}-{engine}.json",
        uuid::Uuid::new_v4()
    ));
    let port = std::env::var("AIOLM_PROVIDER_PORT").unwrap_or_else(|_| "18080".into());

    let mut args = vec![
        harness.to_string_lossy().into_owned(),
        "--engine".into(),
        engine.clone(),
        "--task".into(),
        task,
        "--model".into(),
        model.clone(),
        "--cli".into(),
        cli.clone(),
        "--port".into(),
        port,
        "--out".into(),
        out.to_string_lossy().into_owned(),
    ];
    if !python.is_empty() {
        args.push("--python".into());
        args.push(python.clone());
    }
    if !runtime.is_empty() {
        args.push("--runtime-id".into());
        args.push(runtime.clone());
    }
    if let Ok(revision) = std::env::var("AIOLM_PROVIDER_REVISION") {
        args.push("--revision".into());
        args.push(revision);
    }
    if let Ok(companion) = std::env::var("AIOLM_PROVIDER_COMPANION") {
        args.push("--companion".into());
        args.push(companion);
    }
    if let Ok(media) = std::env::var("AIOLM_PROVIDER_MEDIA_FILE") {
        args.push("--media-file".into());
        args.push(media);
    }
    if let Ok(audio) = std::env::var("AIOLM_PROVIDER_AUDIO_FILE") {
        args.push("--audio-file".into());
        args.push(audio);
    }
    if std::env::var("AIOLM_PROVIDER_EXPECT_EMBEDDINGS").as_deref() == Ok("1") {
        args.push("--expect-embeddings".into());
    }
    if std::env::var("AIOLM_PROVIDER_EXPECT_MEDIA").as_deref() == Ok("1") {
        args.push("--expect-media".into());
    }
    if std::env::var("AIOLM_PROVIDER_EXPECT_TOOLS").as_deref() == Ok("1") {
        args.push("--expect-tools".into());
    }
    if std::env::var("AIOLM_PROVIDER_EXPECT_TRANSCRIPTION").as_deref() == Ok("1") {
        args.push("--expect-transcription".into());
    }

    let node = if cfg!(windows) { "node.exe" } else { "node" };
    let output = std::process::Command::new(node)
        .args(&args)
        .current_dir(&root)
        .output()
        .expect("spawn the provider acceptance harness");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        out.exists(),
        "harness must write its JSON result even on failure (status {}):\n{stdout}\n{stderr}",
        output.status
    );
    let text = std::fs::read_to_string(&out).expect("read harness result");
    let result: serde_json::Value = serde_json::from_str(&text).expect("parse harness result");
    let _ = std::fs::remove_file(&out);
    validate_result(&result).expect("harness result must satisfy the acceptance schema");
    // A started live run must never be swallowed as a skip: a non-zero
    // harness exit with live=true is a failure, not an unrun.
    if result.get("live") == Some(&serde_json::json!(true)) {
        assert!(
            output.status.success() || result["summary"]["outcome"] == serde_json::json!("fail"),
            "a live harness failure must stay fail:\n{stdout}\n{stderr}"
        );
    }
    eprintln!("provider acceptance stdout:\n{stdout}");
    if !output.status.success() {
        panic!("provider acceptance harness failed:\n{stdout}\n{stderr}");
    }
}
