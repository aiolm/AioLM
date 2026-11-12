use super::*;

/// Architecture list used wherever a test only cares about the other
/// configure options; the CUDA policy has its own tests.
const TEST_CUDA_ARCHITECTURES: &str = "89-real;89-virtual";

fn test_directory(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "aiolm-{prefix}-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ))
}

fn test_source() -> RuntimeSource {
    RuntimeSource {
        pull_request: 27342,
        repository: "contributor/llama.cpp".into(),
        head_ref: "feature".into(),
        author: "contributor".into(),
        state: "open".into(),
        fork: true,
        commit: "0123456789abcdef0123456789abcdef01234567".into(),
        archive_sha256: String::new(),
        commit_check: "github-actions-checkout-ref".into(),
        url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
    }
}

fn test_bundle_manifest(root: &Path) -> RuntimeBundleManifest {
    let files = collect_runtime_files(root)
        .expect("collect test runtime files")
        .into_iter()
        .map(|(path, file, bytes)| RuntimeBundleFile {
            path,
            bytes,
            sha256: sha256_file(&file).expect("hash test runtime file"),
        })
        .collect();
    RuntimeBundleManifest {
        format: RUNTIME_BUNDLE_FORMAT,
        backend: "cpu".into(),
        build: "pr27342".into(),
        platform: release_platform().into(),
        architecture: bundle_architecture().into(),
        version: None,
        source: Some(test_source()),
        files,
    }
}

fn write_test_archive(path: &Path, name: &str, contents: &[u8]) {
    use std::io::Write;
    let file = fs::File::create(path).expect("create test archive");
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file(name, zip::write::SimpleFileOptions::default())
        .expect("start test archive entry");
    archive
        .write_all(contents)
        .expect("write test archive entry");
    archive.finish().expect("finish test archive");
}

#[cfg(windows)]
fn noisy_command() -> Command {
    let mut command = Command::new("cmd");
    command.args([
        "/c",
        "for /L %i in (1,1,6000) do @echo 0123456789012345678901234567890123456789012345678901234567890123",
    ]);
    command
}

#[cfg(not(windows))]
fn noisy_command() -> Command {
    let mut command = Command::new("sh");
    command.args([
        "-c",
        "yes 0123456789012345678901234567890123456789012345678901234567890123 | head -n 6000",
    ]);
    command
}

/// Every name any allowlist can contribute, whether or not it is set on
/// this machine. The environment functions only return names that are set,
/// so testing what they *may* return needs the lists themselves.
fn every_allowlisted_name() -> Vec<&'static str> {
    [
        BASE_ENVIRONMENT,
        PLATFORM_ENVIRONMENT,
        RUNTIME_DEVICE_ENVIRONMENT,
        BUILD_TOOLCHAIN_ENVIRONMENT,
        BUILD_TOOLING_ENVIRONMENT,
        BUILD_PLATFORM_ENVIRONMENT,
        BUILD_NETWORK_ENVIRONMENT,
    ]
    .concat()
}

fn pull_request_json(
    number: u64,
    state: &str,
    merged: bool,
    head_repo: Option<&str>,
) -> PullRequestDetail {
    let repo = head_repo
        .map(|name| format!(r#"{{"full_name":"{name}"}}"#))
        .unwrap_or_else(|| "null".into());
    let merged_at = if merged {
        r#""2026-08-01T00:00:00Z""#
    } else {
        "null"
    };
    serde_json::from_str(&format!(
        r#"{{
            "number": {number},
            "title": "server: add a thing",
            "state": "{state}",
            "draft": true,
            "merged_at": {merged_at},
            "updated_at": "2026-08-20T10:00:00Z",
            "user": {{"login": "contributor"}},
            "head": {{
                "sha": "0123456789ABCDEF0123456789abcdef01234567",
                "ref": "feature-branch",
                "repo": {repo}
            }}
        }}"#
    ))
    .expect("fixture should decode")
}

// ---- L1: deterministic, newest-first toolchain discovery ----

fn vs_install(year: u32, edition: &str) -> VisualStudioInstall {
    VisualStudioInstall {
        year,
        edition: edition.to_string(),
        cmake: PathBuf::from(format!("/vs/{year}/{edition}/cmake")),
        #[cfg(windows)]
        edition_root: PathBuf::from(format!("/vs/{year}/{edition}")),
    }
}

/// A spawned grandchild that keeps appending to a marker file until its
/// process group is killed, shared by the cancellation and timeout
/// process-group tests below so each only has to state what makes it
/// distinct: which stop path it exercises.
#[cfg(unix)]
struct MarkerGrandchild {
    root: PathBuf,
    marker: PathBuf,
    pid_file: PathBuf,
    child: TransientChild,
}

#[cfg(unix)]
async fn spawn_marker_grandchild() -> MarkerGrandchild {
    let root = std::env::temp_dir().join(format!(
        "aiolm-process-group-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&root).expect("create process-group test root");
    let marker = root.join("grandchild-alive");
    let pid_file = root.join("grandchild.pid");
    let mut command = Command::new("sh");
    command.args([
        "-c",
        "(while :; do printf x >> \"$AIOLM_MARKER\"; sleep 0.02; done) & child=$!; echo \"$child\" > \"$AIOLM_PID\"; wait",
    ])
    .env("AIOLM_MARKER", &marker)
    .env("AIOLM_PID", &pid_file);
    configure_build_process_group(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = TransientChild::spawn(&mut command).expect("spawn process-group test child");

    for _ in 0..100 {
        if marker.is_file() && pid_file.is_file() {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }
    assert!(marker.is_file(), "grandchild did not start");
    MarkerGrandchild {
        root,
        marker,
        pid_file,
        child,
    }
}

/// Asserts the marker file stopped growing (the grandchild is dead) and
/// cleans up, killing the recorded PID directly as a last resort so a
/// failed assertion never leaves a background process running. Takes the
/// marker/pid_file/root by value rather than the whole `MarkerGrandchild`
/// because callers have already moved `child` into `supervise_build_child`
/// by this point.
#[cfg(unix)]
async fn assert_grandchild_stopped_and_cleanup(
    marker: PathBuf,
    pid_file: PathBuf,
    root: PathBuf,
    context: &str,
) {
    let grandchild_pid = fs::read_to_string(&pid_file)
        .expect("read grandchild pid")
        .trim()
        .parse::<libc::pid_t>()
        .expect("parse grandchild pid");

    let size_after_stop = fs::metadata(&marker).map(|metadata| metadata.len());
    sleep(Duration::from_millis(120)).await;
    let size_after_wait = fs::metadata(&marker).map(|metadata| metadata.len());

    // Clean up before asserting so a failed check leaves no child behind.
    // On the normal path the group kill has already made the PID invalid.
    unsafe {
        let _ = libc::kill(grandchild_pid, libc::SIGKILL);
    }
    let _ = fs::remove_dir_all(root);
    assert_eq!(
        size_after_stop.expect("read marker size after stopping build"),
        size_after_wait.expect("read marker size after waiting"),
        "grandchild kept writing after {context}"
    );
}

fn git_in(
    dir: &Path,
    environment: Option<&[(OsString, OsString)]>,
    args: &[&str],
) -> std::process::Output {
    let git = which::which("git").expect("git is required for the nested build-info regression");
    let mut command = std::process::Command::new(git);
    if let Some(environment) = environment {
        command.env_clear().envs(environment.iter().cloned());
    }
    command
        .args([
            "-c",
            "user.name=AioLM test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs")
}

#[path = "github_tests.rs"]
mod github;

#[path = "identity_tests.rs"]
mod identity;

#[path = "dependencies_tests.rs"]
mod dependencies;

#[path = "bundles_tests.rs"]
mod bundles;

#[path = "manifests_tests.rs"]
mod manifests;

#[path = "install_tests.rs"]
mod install;

#[path = "download_tests.rs"]
mod download;

#[path = "build_tests.rs"]
mod build;

#[path = "environment_tests.rs"]
mod environment;

#[path = "toolchain_tests.rs"]
mod toolchain;

#[path = "cleanup_tests.rs"]
mod cleanup;

#[path = "probe_tests.rs"]
mod probe;
