//! Exercises the real `runtime::install()` path against the live GitHub
//! release, including download, SHA-256 verification, extraction, the CUDA
//! sidecar and the staged preflight.
//!
//! Gated behind LLAMA_BOARD_RUNTIME_INSTALL=1 because it downloads hundreds of
//! megabytes and writes into the real app data directory.
//!
//! Run:
//!   $env:LLAMA_BOARD_RUNTIME_INSTALL = "1"
//!   cd src-tauri && cargo test --test runtime_install -- --nocapture --test-threads=1

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use llama_board_lib::runtime;

fn enabled() -> bool {
    std::env::var_os("LLAMA_BOARD_RUNTIME_INSTALL").is_some()
}

fn backends() -> Vec<String> {
    match std::env::var("LLAMA_BOARD_RUNTIME_BACKENDS") {
        Ok(list) => list
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        Err(_) => vec!["vulkan".to_string()],
    }
}

/// Gated behind `LLAMA_BOARD_RUNTIME_INSTALL=1` and `#[ignore]`: downloads a
/// live GitHub release, so it must not report "passed" in the default
/// `cargo test` gate when the env var is unset and nothing was downloaded.
/// Invoke explicitly with `cargo test --test runtime_install -- --ignored`.
#[test]
#[ignore = "downloads hundreds of MB from a live GitHub release; set LLAMA_BOARD_RUNTIME_INSTALL=1 and run with --ignored"]
fn installs_each_requested_backend_end_to_end() {
    if !enabled() {
        eprintln!("[SKIP] Set LLAMA_BOARD_RUNTIME_INSTALL=1 to run the real runtime install test.");
        return;
    }
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

    let mut failures = Vec::new();
    for backend in backends() {
        let result = runtime.block_on(async {
            let info = runtime::latest_for(&backend).await?;
            eprintln!(
                "[{backend}] latest={} asset={} digest={}",
                info.build,
                info.file_name,
                info.digest.as_deref().unwrap_or("<none>")
            );
            let sidecar = runtime::companion_asset_name(&info.build, &info.file_name);
            eprintln!("[{backend}] sidecar={sidecar:?}");
            runtime::install_with(
                &|phase, received, total| {
                    if phase != "downloading" || total > 0.0 {
                        eprintln!("[{backend}] {phase} {received:.0}/{total:.0}");
                    }
                },
                &backend,
                &info.build,
                Arc::new(AtomicBool::new(false)),
            )
            .await
        });
        match result {
            Ok(installed) => eprintln!(
                "[{backend}] OK {} ({:.1} MB) -> {}",
                installed.build, installed.size_mb, installed.dir
            ),
            Err(error) => {
                eprintln!("[{backend}] FAILED: {error}");
                failures.push(format!("{backend}: {error}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "runtime installs failed:\n{}",
        failures.join("\n")
    );
}

/// Uses a disposable app-data root, never the user's installed runtimes.
#[cfg(windows)]
#[test]
#[ignore = "live download cancellation; set LLAMA_BOARD_RUNTIME_INSTALL=1 and run alone"]
fn cancelled_download_removes_staging() {
    use std::sync::atomic::Ordering;
    assert!(enabled(), "set LLAMA_BOARD_RUNTIME_INSTALL=1");
    struct IsolatedAppData {
        original: Option<std::ffi::OsString>,
        root: std::path::PathBuf,
    }
    impl Drop for IsolatedAppData {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var("APPDATA", value),
                None => std::env::remove_var("APPDATA"),
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    let root = std::env::temp_dir().join(format!(
        "llama-board-download-test-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).expect("create isolated app data");
    let isolated = IsolatedAppData {
        original: std::env::var_os("APPDATA"),
        root,
    };
    std::env::set_var("APPDATA", &isolated.root);
    let cancel = Arc::new(AtomicBool::new(false));
    let saw_bytes = Arc::new(AtomicBool::new(false));
    let executor = tokio::runtime::Runtime::new().unwrap();
    let result = executor.block_on(async {
        let info = runtime::latest_for("vulkan").await?;
        runtime::install_with(
            &|phase, received, _| {
                if phase == "downloading" && received > 0.0 {
                    saw_bytes.store(true, Ordering::Release);
                    cancel.store(true, Ordering::Release);
                }
            },
            "vulkan",
            &info.build,
            cancel.clone(),
        )
        .await
    });
    assert!(
        saw_bytes.load(Ordering::Acquire),
        "no download bytes received: {result:?}"
    );
    assert!(result.is_err(), "cancelled download was installed");
    let runtime_root = isolated.root.join("llama-board").join("runtimes");
    if runtime_root.exists() {
        assert_eq!(
            std::fs::read_dir(runtime_root).unwrap().count(),
            0,
            "cancelled download left staging or installed files"
        );
    }
    println!("[runtime] live download cancelled after first bytes; staging removed");
}
