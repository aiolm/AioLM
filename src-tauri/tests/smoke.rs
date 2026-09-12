//! End-to-end smoke test: spawn the real llama-server, wait for /health, run a
//! streaming chat completion, then kill. Gated behind AIOLM_SMOKE=1 so it
//! doesn't run in the default suite (it loads a multi-GB model).
//!
//! Run:
//!   $env:AIOLM_SMOKE = "1"
//!   $env:AIOLM_SMOKE_MODEL = "C:\path\to\model.gguf"
//!   cd src-tauri && cargo test --test smoke -- --ignored --nocapture --test-threads=1
//! Optional: AIOLM_SMOKE_BACKEND/BUILD select a managed runtime;
//! DEVICE selects runtime device names; PORT permits concurrent isolated runs;
//! MMPROJ tests image input; SPEC_TYPE/DRAFT test a draft head;
//! CANCEL_LOAD=1 tests interruption before readiness. These do not change saved settings.
use std::sync::{Arc, Mutex};

use aiolm_lib::{server, AppConfig, ErrBuf};

fn cfg_with(model: &str) -> AppConfig {
    AppConfig {
        active_model: model.to_string(),
        active_backend: aiolm_lib::branding::env_var("AIOLM_SMOKE_BACKEND").unwrap_or_default(),
        active_build: aiolm_lib::branding::env_var("AIOLM_SMOKE_BUILD").unwrap_or_default(),
        mmproj: aiolm_lib::branding::env_var("AIOLM_SMOKE_MMPROJ").unwrap_or_default(),
        spec_type: aiolm_lib::branding::env_var("AIOLM_SMOKE_SPEC_TYPE")
            .unwrap_or_else(|_| "none".into()),
        spec_draft_model: aiolm_lib::branding::env_var("AIOLM_SMOKE_DRAFT").unwrap_or_default(),
        port: aiolm_lib::branding::env_var("AIOLM_SMOKE_PORT")
            .map(|value| value.parse().expect("valid smoke port"))
            .unwrap_or(18081),
        ngl: 999,
        ctx_size: 4096,
        flash_attn: "on".into(),
        ..AppConfig::default()
    }
}

#[tokio::test]
#[ignore = "loads a real model; set AIOLM_SMOKE=1 and run explicitly"]
async fn smoke_real_benchmark_cancel_keeps_progress() {
    use aiolm_lib::performance_bench;
    use std::sync::atomic::{AtomicBool, Ordering};
    assert_eq!(
        aiolm_lib::branding::env_var("AIOLM_SMOKE").as_deref(),
        Ok("1")
    );
    let model = aiolm_lib::branding::env_var("AIOLM_SMOKE_MODEL").expect("set smoke model");
    let mut cfg = cfg_with(&model);
    if let Ok(gpu_id) = std::env::var("AIOLM_BENCH_SMOKE_GPU") {
        cfg.gpu.gpu_ids = vec![gpu_id];
    } else if let Ok(devices) = aiolm_lib::branding::env_var("AIOLM_SMOKE_DEVICE") {
        cfg.gpu.gpu_ids = devices
            .split(',')
            .map(|device| format!("runtime:{}:{}", cfg.active_backend, device.trim()))
            .collect();
    }
    let gpu = aiolm_lib::validate_launch_config(&mut cfg)
        .await
        .expect("selected runtime must pass launch validation");
    let cancel = Arc::new(AtomicBool::new(false));
    let callback_cancel = cancel.clone();
    let rows = Arc::new(Mutex::new(Vec::new()));
    let callback_rows = rows.clone();
    let progress: performance_bench::Progress = Arc::new(move |event| {
        if let Some(row) = event.row {
            callback_rows.lock().unwrap().push(row);
            callback_cancel.store(true, Ordering::Release);
        }
    });
    let request = performance_bench::PerformanceBenchRequest {
        run_id: "smoke-cancel".into(),
        prompt_lengths: vec![512],
        generation_length: 8,
        batch_sizes: vec![2],
        repetitions: 1,
        context_profile: "code_python".into(),
        warmup: true,
    };
    let active_pid = Arc::new(Mutex::new(None));
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        performance_bench::run(
            cfg,
            request,
            gpu,
            cancel,
            active_pid.clone(),
            progress,
            "unknown".into(),
            false,
        ),
    )
    .await
    .expect("benchmark did not reach a cancellable result in time");
    assert_eq!(result.status, "cancelled", "{:?}", result.message);
    assert!(
        active_pid.lock().unwrap().is_none(),
        "cancelled benchmark retained its process"
    );
    assert!(
        !rows.lock().unwrap().is_empty(),
        "no live progress before cancellation"
    );
    assert!(
        !result.rows.is_empty(),
        "cancellation discarded completed rows"
    );
    let completed = &result.rows[0];
    assert!(completed.error.is_none(), "{:?}", completed.error);
    assert_eq!(completed.prompt_tokens, 512);
    assert_eq!(completed.completion_tokens, 8);
    assert_eq!(completed.cached_tokens, 0);
    println!(
        "[smoke] cancelled benchmark retained {} rows",
        result.rows.len()
    );
}

// Keep cleanup armed across every assertion and network error, including panic.
struct SmokeGuard {
    state: Arc<Mutex<server::ServerState>>,
    key_file: Option<std::path::PathBuf>,
}

struct SmokeLog(std::path::PathBuf);

impl Drop for SmokeLog {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Drop for SmokeGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        server::kill(&mut state.child, None);
        server::cleanup_api_key_file(self.key_file.as_deref());
    }
}

/// Gated behind `AIOLM_SMOKE=1` and `#[ignore]`: the default `cargo
/// test` gate must not report this as "passed" when it never actually ran a
/// server (see `tests/smoke_fake.rs` for the deterministic equivalent that
/// always runs). Invoke explicitly with `cargo test --test smoke -- --ignored`.
#[test]
#[ignore = "downloads/loads a multi-GB model; set AIOLM_SMOKE=1 and run with --ignored"]
fn smoke_real_server_and_chat() {
    assert_eq!(
        aiolm_lib::branding::env_var("AIOLM_SMOKE").as_deref(),
        Ok("1"),
        "set AIOLM_SMOKE=1 for the explicitly requested live test"
    );
    let model = aiolm_lib::branding::env_var("AIOLM_SMOKE_MODEL").expect("set AIOLM_SMOKE_MODEL");
    let mut cfg = cfg_with(&model);
    let log =
        SmokeLog(std::env::temp_dir().join(format!("aiolm-smoke-{}.log", uuid::Uuid::new_v4())));
    let log_path = &log.0;
    cfg.server_args.extend([
        "--log-file".into(),
        log_path.to_string_lossy().into_owned(),
        "--verbosity".into(),
        "4".into(),
    ]);
    cfg.reasoning = "off".into();

    let ring = Arc::new(ErrBuf::default());
    let api_key = "smoke-token";
    let mut resolved_gpu = aiolm_lib::gpu::ResolvedGpu {
        device_flag: aiolm_lib::branding::env_var("AIOLM_SMOKE_DEVICE").ok(),
        main_gpu_index: aiolm_lib::branding::env_var("AIOLM_SMOKE_MAIN_INDEX")
            .ok()
            .map(|value| value.parse().expect("main GPU index")),
        split_mode: aiolm_lib::branding::env_var("AIOLM_SMOKE_MAIN_INDEX")
            .ok()
            .map(|_| "none"),
        ..Default::default()
    };
    if aiolm_lib::branding::env_var("AIOLM_SMOKE_VALIDATE_PLACEMENT").as_deref() == Ok("1") {
        cfg.gpu.gpu_ids = resolved_gpu
            .device_flag
            .as_deref()
            .expect("set smoke device")
            .split(',')
            .map(|name| format!("runtime:{}:{name}", cfg.active_backend))
            .collect();
        cfg.gpu.main_gpu = cfg.gpu.gpu_ids.first().cloned();
        let validation_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        resolved_gpu = validation_runtime
            .block_on(aiolm_lib::validate_launch_config(&mut cfg))
            .expect("application launch configuration validation");
        assert_eq!(resolved_gpu.main_gpu_index, Some(0));
    }
    let (child, url, api_key_file) = match server::spawn(&cfg, api_key, &ring, &resolved_gpu) {
        Ok(v) => v,
        Err(e) => panic!("spawn failed: {e}\nstderr: {}", ring.tail()),
    };
    let shared = Arc::new(Mutex::new(server::ServerState::default()));
    shared.lock().expect("server state lock").attach_starting(
        child,
        url.clone(),
        api_key.to_string(),
        model.clone(),
        cfg.mmproj.clone(),
        cfg.spec_draft_model.clone(),
    );
    let _guard = SmokeGuard {
        state: shared.clone(),
        key_file: api_key_file.clone(),
    };
    if aiolm_lib::branding::env_var("AIOLM_SMOKE_CANCEL_LOAD").as_deref() == Ok("1") {
        std::thread::sleep(std::time::Duration::from_millis(200));
        drop(_guard);
        assert!(
            shared.lock().unwrap().child.is_none(),
            "cancelled load retained a process"
        );
        assert!(
            std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{}", cfg.port).parse().unwrap(),
                std::time::Duration::from_secs(1)
            )
            .is_err(),
            "cancelled load retained a listener"
        );
        println!("[smoke] loading cancelled; process and port released");
        return;
    }
    println!("[smoke] spawned, url={url} — waiting for /health…");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let ready =
        rt.block_on(async { server::wait_ready(shared.clone(), &url, api_key, 600, &ring).await });
    server::cleanup_api_key_file(api_key_file.as_deref());
    if let Err(e) = ready {
        panic!("wait_ready failed: {e}");
    }
    println!("[smoke] server is READY");

    let base = url.replace("/v1", "");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .unwrap();
    let content = if cfg.mmproj.is_empty() {
        serde_json::json!("Reply with exactly: OK")
    } else {
        serde_json::json!([
            {"type":"text","text":"Describe this image briefly."},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LZkAAAAASUVORK5CYII="}}
        ])
    };
    let body = serde_json::json!({
        "model": "smoke",
        "messages": [{"role":"user","content":content}],
        "stream": true,
        "max_tokens": 16,
        "temperature": 0.0
    });
    let resp = rt.block_on(async {
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .expect("chat request failed")
    });
    assert!(resp.status().is_success(), "chat HTTP {}", resp.status());

    let got = rt.block_on(async {
        let mut buf = Vec::new();
        let mut stream = resp;
        while let Some(chunk) = stream.chunk().await.expect("SSE stream failed") {
            buf.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&buf).to_string()
    });
    println!("[smoke] completed streaming response ({} bytes)", got.len());
    assert!(!got.is_empty(), "no SSE data received");
    assert!(got.contains("data:"), "expected SSE 'data:' frames");
    let log_bytes = std::fs::read(log_path).expect("read full runtime log");
    let tail = String::from_utf8_lossy(&log_bytes);
    for line in tail.lines().filter(|line| {
        line.contains("offload") || line.contains("buffer size") || line.contains("eval time")
    }) {
        println!("[smoke] {line}");
    }
    if let Ok(device) = aiolm_lib::branding::env_var("AIOLM_SMOKE_DEVICE") {
        for name in device.split(',') {
            assert!(
                tail.contains(name),
                "selected GPU {name} absent from runtime log"
            );
        }
        assert!(
            tail.contains("offloaded") && !tail.contains("offloaded 0/"),
            "GPU offload not confirmed"
        );
    }
    assert!(got.contains("[DONE]"), "stream did not complete: {got}");
    let mut answer = String::new();
    for data in got.lines().filter_map(|line| line.strip_prefix("data: ")) {
        if data == "[DONE]" {
            continue;
        }
        let frame: serde_json::Value = serde_json::from_str(data).expect("valid SSE JSON");
        assert!(frame.get("error").is_none(), "runtime error frame: {frame}");
        if let Some(text) = frame["choices"][0]["delta"]["content"].as_str() {
            answer.push_str(text);
        }
    }
    assert!(!answer.trim().is_empty(), "stream contained no answer");
    if cfg.mmproj.is_empty() {
        assert_eq!(answer.trim(), "OK", "model did not follow the smoke prompt");
    }

    server::kill(
        &mut shared.lock().expect("server state lock").child,
        Some(ring.clone()),
    );
    assert!(
        std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", cfg.port).parse().unwrap(),
            std::time::Duration::from_secs(1)
        )
        .is_err(),
        "server port still open after shutdown"
    );
    println!("[smoke] killed server; port released");
}
