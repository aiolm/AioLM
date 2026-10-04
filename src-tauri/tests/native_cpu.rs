//! Explicit live acceptance: real managed CPU install and CLI inference after
//! the launcher exits. Only public, hash-pinned model data and a disposable home
//! are used. Run alone with AIOLM_NATIVE_CPU=1 and --ignored --test-threads=1.
use aiolm_lib::runtime;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

// Qwen's Apache-2.0 model, pinned to the publisher's immutable revision.
const MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf";
const MODEL_SHA256: &str = "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db";
const MODEL_BYTES: u64 = 491_400_032;

struct Home(PathBuf);

impl Home {
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aiolm-cli"));
        for (key, _) in std::env::vars_os() {
            let upper = key.to_string_lossy().to_ascii_uppercase();
            if upper.starts_with("AIOLM_") || upper.starts_with("LLAMA_BOARD_") {
                command.env_remove(key);
            }
        }
        for (key, subdir) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("APPDATA", "roaming"),
            ("LOCALAPPDATA", "local"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("AIOLM_HOME", "aiolm"),
        ] {
            let path = self.0.join(subdir);
            std::fs::create_dir_all(&path).expect("isolated home directory");
            command.env(key, path);
        }
        command
    }

    fn cli(&self, args: &[&str]) -> Value {
        eprintln!("CLI command: {args:?}");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            let mut command = tokio::process::Command::from(self.command());
            command.kill_on_drop(true).args(args);
            tokio::time::timeout(Duration::from_secs(120), command.output()).await
        });
        // Windows pipe readers may still be draining a descendant after the
        // launcher times out. Do not let runtime teardown hide the diagnosis.
        rt.shutdown_timeout(Duration::from_secs(1));
        if result.is_err() {
            for name in [
                "headless-server.log",
                "headless-state.json",
                "headless-state.lock",
            ] {
                let path = self.0.join("aiolm/cli").join(name);
                eprintln!(
                    "{name}: {}",
                    std::fs::read_to_string(path).unwrap_or_default()
                );
            }
        }
        let output = result
            .unwrap_or_else(|_| panic!("CLI command did not finish and close its output: {args:?}"))
            .expect("CLI process");
        assert!(
            output.status.success(),
            "{args:?}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("CLI JSON")
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let child = self
            .command()
            .args(["server", "stop"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while matches!(child.try_wait(), Ok(None)) {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
#[ignore = "downloads a public 491 MB model and CPU runtime; set AIOLM_NATIVE_CPU=1 and run alone"]
fn real_cpu_cli_lifecycle() {
    assert_eq!(std::env::var("AIOLM_NATIVE_CPU").as_deref(), Ok("1"));
    let home = Home(std::env::temp_dir().join(format!("aiolm-cpu-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(home.0.join("aiolm")).unwrap();
    // This integration binary has one explicitly selected test. The installer
    // reads only AIOLM_HOME and does not run legacy settings migration.
    std::env::set_var("AIOLM_HOME", home.0.join("aiolm"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap();
    let (build, model) = rt.block_on(async {
        let latest = runtime::latest_for("cpu")
            .await
            .expect("CPU release metadata");
        runtime::install_with(
            &|_, _, _| {},
            "cpu",
            &latest.build,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("managed CPU download, digest, extraction and preflight");
        println!(
            "CPU runtime installed: {} ({})",
            latest.build, latest.file_name
        );
        let model = home.0.join("model with spaces.gguf");
        let mut file = std::fs::File::create(&model).unwrap();
        let mut response = client
            .get(MODEL_URL)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        while let Some(chunk) = response.chunk().await.unwrap() {
            bytes += chunk.len() as u64;
            assert!(bytes <= MODEL_BYTES, "model exceeded pinned size");
            hash.update(&chunk);
            file.write_all(&chunk).unwrap();
        }
        assert_eq!(bytes, MODEL_BYTES);
        assert_eq!(format!("{:x}", hash.finalize()), MODEL_SHA256);
        println!("Model download and pinned SHA-256 verification passed");
        (latest.build, model)
    });
    assert_eq!(home.cli(&["config", "get"])["active_build"], "");
    home.cli(&["runtime", "select", "cpu", &build]);
    home.cli(&["config", "set", "active_model", model.to_str().unwrap()]);
    home.cli(&["config", "set", "ctx_size", "2048"]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    home.cli(&["config", "set", "port", &port.to_string()]);
    println!("Probing selected runtime before launch");
    home.cli(&["runtime", "probe", "cpu", &build]);
    println!("Selected runtime capability probe passed");
    let mut last_pid = None;
    for action in ["start", "restart"] {
        let started = home.cli(&["server", action]);
        println!("CLI {action} launcher exited");
        assert_eq!(started["state"], "running");
        let pid = started["pid"].as_u64().unwrap();
        assert_ne!(last_pid, Some(pid));
        last_pid = Some(pid);
        let log = PathBuf::from(started["log_path"].as_str().unwrap());
        let before = std::fs::read(&log).unwrap_or_default();
        let response = rt.block_on(async {
            client
                .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
                .json(
                    &json!({"messages":[{"role":"user","content":"Reply with exactly: OK"}],
                    "stream":true,"max_tokens":16,"temperature":0}),
                )
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        assert!(response.contains("[DONE]"), "SSE did not complete");
        let answer: String = response
            .lines()
            .filter_map(|line| {
                let value: Value = serde_json::from_str(line.strip_prefix("data: ")?).ok()?;
                value["choices"][0]["delta"]["content"]
                    .as_str()
                    .map(str::to_owned)
            })
            .collect();
        assert!(!answer.trim().is_empty(), "no model answer");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::fs::read(&log).unwrap_or_default() == before {
            assert!(
                std::time::Instant::now() < deadline,
                "logs stopped after launcher exit"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        println!("CLI {action}: real CPU SSE answer and continuing logs passed");
    }
    assert_eq!(home.cli(&["server", "stop"])["state"], "stopped");
    assert_eq!(home.cli(&["server", "status"])["state"], "stopped");
    assert!(std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
    println!("CLI stop: managed server stopped and port released");
}
