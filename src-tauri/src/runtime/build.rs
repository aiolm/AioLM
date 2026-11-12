use super::*;

/// Options that keep a PR configure inside the archive already on disk.
///
/// The source archive is downloaded once, pinned to a commit, and its digest
/// recorded. Anything CMake fetches *afterwards* - a `FetchContent` clone, a
/// `find_package` that falls back to a download - is outside that boundary:
/// it is not pinned, not recorded, needs Git and network on every PC, and on a
/// machine behind a proxy or without Git it fails deep into a long build
/// instead of at the start.
///
/// So each of these is turned off rather than made to work:
///
/// - `LLAMA_BUILD_BORINGSSL`: BoringSSL is a `FetchContent` Git clone that
///   additionally needs a Go toolchain. It exists to give `llama-server` an
///   HTTPS listener. aiolm talks to the server over loopback HTTP and
///   never sets `--ssl-key-file`, so the dependency buys nothing here.
/// - `LLAMA_CURL` / `LLAMA_OPENSSL`: these power the server's own
///   download-a-model-by-URL path and need libcurl/OpenSSL development
///   packages that most Windows PCs do not have. aiolm manages models
///   itself and never asks the server to fetch one.
///
/// An unknown `-D` is a warning in CMake, not an error, so setting these on a
/// PR whose tree has never heard of them is safe.
///
/// `FETCHCONTENT_QUIET=OFF` does not disable anything - it makes any fetch
/// that still happens visible in the log, so `build_failure_hint` can name it.
pub(super) const SOURCE_BUILD_OFFLINE_OPTIONS: &[&str] = &[
    "-DLLAMA_BUILD_BORINGSSL=OFF",
    "-DLLAMA_CURL=OFF",
    "-DLLAMA_OPENSSL=OFF",
    // aiolm talks to the server's loopback API and never opens the
    // server's embedded browser UI. A PR archive may still contain a full
    // tools/ui source tree, whose default CMake path runs npm (or fetches a
    // prebuilt asset from Hugging Face), so disable both paths explicitly.
    "-DLLAMA_BUILD_UI=OFF",
    "-DLLAMA_USE_PREBUILT_UI=OFF",
];

/// Turn the tail of a failed build into something the user can act on.
///
/// A CMake failure is thousands of lines that end in a one-line error, and the
/// error is rarely self-explanatory to someone who did not choose to run a
/// compiler. Each arm below is a failure that a normal PC actually hits.
pub(super) fn build_failure_hint(log: &str) -> Option<&'static str> {
    let lowered = log.to_ascii_lowercase();
    let contains_any = |needles: &[&str]| needles.iter().any(|needle| lowered.contains(needle));

    if contains_any(&[
        "fetchcontent",
        "failed to clone",
        "git did not exit cleanly",
        "could not resolve host",
        "could not resolve proxy",
        "unable to access 'https",
        "ssl certificate problem",
        "server certificate verification failed",
    ]) {
        return Some(
            "this PR's build tried to download a dependency of its own. aiolm pins and verifies only the PR source archive, so a build that fetches more needs Git and working network access (including your proxy and CA bundle) on this PC. Install Git, check HTTPS_PROXY/SSL_CERT_FILE if you are behind a proxy, or install a released runtime instead.",
        );
    }
    if contains_any(&[
        "no cmake_cxx_compiler could be found",
        "no cmake_c_compiler could be found",
        "could not find any instance of visual studio",
        "no suitable generator",
        "cmake_make_program is not set",
    ]) {
        return Some(
            "no C++ compiler was found. Install the Visual Studio Build Tools with the \"Desktop development with C++\" workload on Windows, Xcode command line tools on macOS, or a gcc/clang toolchain and Ninja on Linux, then try again.",
        );
    }
    if contains_any(&[
        "no space left on device",
        "there is not enough space on the disk",
        "0x80070070",
    ]) {
        return Some(
            "the disk filled up. A llama.cpp build needs several GB of free space for the extracted source and the build tree; free some space and try again.",
        );
    }
    if contains_any(&["nvcc fatal", "unsupported gpu architecture"]) {
        return Some(
            "the CUDA compiler rejected the build. This usually means the installed CUDA Toolkit is too old for this PR; update the toolkit, or build this PR for the vulkan or cpu backend.",
        );
    }
    if contains_any(&["glslc", "spir-v", "shaderc"]) {
        return Some(
            "the Vulkan shader compiler failed. Make sure the LunarG Vulkan SDK is installed and glslc is on PATH, or build this PR for the cpu backend.",
        );
    }
    if contains_any(&["out of memory", "c1060", "compiler is out of heap space"]) {
        return Some(
            "the compiler ran out of memory. Close other applications and try again; a parallel llama.cpp build can need several GB of RAM per core.",
        );
    }
    None
}

/// Environment variable that hands the CUDA architecture list to the user.
///
/// Accepts exactly what `CMAKE_CUDA_ARCHITECTURES` accepts, e.g. `89-real`, or
/// `75-real;80-real;90-virtual`, or the word `all`.
pub(super) const CUDA_ARCHITECTURES_OVERRIDE: &str = "AIOLM_CUDA_ARCHITECTURES";

/// The list used when the host's GPU generation cannot be determined.
///
/// Deliberately not llama.cpp's own default (which spans a decade of hardware
/// and multiplies the compile time of every CUDA kernel by the length of the
/// list): these are the generations a machine running a current llama.cpp
/// actually has, and the trailing `-virtual` entry emits PTX so a newer card
/// than any of them still runs the result through driver JIT.
pub(super) const CUDA_ARCHITECTURES_PORTABLE: &str = "75-real;80-real;86-real;89-real;90-virtual";

/// Reject anything that is not a CUDA architecture list, so an environment
/// variable cannot smuggle extra arguments into the configure line.
fn valid_cuda_architectures(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    if value.eq_ignore_ascii_case("all") || value.eq_ignore_ascii_case("all-major") {
        return true;
    }
    value.split(';').all(|entry| {
        let entry = entry.trim();
        let digits = entry
            .trim_end_matches("-real")
            .trim_end_matches("-virtual")
            .trim_end_matches('a')
            .trim_end_matches('f');
        !digits.is_empty()
            && digits.len() <= 4
            && digits.chars().all(|character| character.is_ascii_digit())
    })
}

/// Turn detected compute capabilities (`["8.9", "8.6"]`) into a CMake list.
///
/// Real code is emitted for each capability found, and PTX for the newest one,
/// so the build stays usable if the user later drops in a newer card. This is
/// the whole point of doing it host-aware: a machine with one RTX 4090 spends
/// its compile budget on `89` instead of on five generations it will never run.
fn cuda_architectures_for_host(capabilities: &[String]) -> Option<String> {
    let mut codes: Vec<u32> = capabilities
        .iter()
        .filter_map(|capability| {
            let mut parts = capability.trim().split('.');
            let major = parts.next()?.parse::<u32>().ok()?;
            let minor = parts.next().unwrap_or("0").parse::<u32>().ok()?;
            (major >= 5).then_some(major * 10 + minor)
        })
        .collect();
    codes.sort_unstable();
    codes.dedup();
    let newest = *codes.last()?;
    let mut entries: Vec<String> = codes.iter().map(|code| format!("{code}-real")).collect();
    entries.push(format!("{newest}-virtual"));
    Some(entries.join(";"))
}

/// The CUDA architecture list for this build: the user's choice if they made
/// one, else the host's own GPUs, else a portable list.
pub(super) fn cuda_architectures(override_value: Option<&str>, detected: &[String]) -> String {
    if let Some(value) = override_value {
        let value = value.trim();
        if valid_cuda_architectures(value) {
            return value.to_string();
        }
    }
    cuda_architectures_for_host(detected).unwrap_or_else(|| CUDA_ARCHITECTURES_PORTABLE.to_string())
}

/// Ask the driver what is installed. Present on every machine with a working
/// NVIDIA driver, which a CUDA build already requires.
pub(super) async fn detected_cuda_capabilities() -> Vec<String> {
    let Ok(smi) = which::which("nvidia-smi") else {
        return Vec::new();
    };
    let probe = run_probe(&smi, &["--query-gpu=compute_cap", "--format=csv,noheader"]).await;
    if !probe.success {
        return Vec::new();
    }
    probe
        .text
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && line.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .collect()
}

/// What a PR build produces, stated once so the UI, the docs and the build
/// itself cannot drift apart.
///
/// aiolm builds the server and the perplexity tool that GPU verification runs
/// before a device placement may start; without it a GPU PR runtime could never
/// pass that check. Nothing else is built: llama-bench is an optional
/// diagnostic helper that aiolm never needs, so a source build neither builds
/// nor requires it.
/// Tests and examples are off because they roughly double the build for code
/// aiolm never runs. The server's optional embedded web UI is **not**
/// built here: aiolm uses the loopback API directly, so no Node
/// toolchain is needed and no UI asset is fetched at build time - the same
/// reason the network options in `SOURCE_BUILD_OFFLINE_OPTIONS` are off.
pub const SOURCE_BUILD_TARGETS: &[&str] = &["llama-server", "llama-perplexity"];

pub(super) fn source_build_configure_args(
    backend: &str,
    source_root: &Path,
    build_root: &Path,
    cuda_architectures: &str,
) -> Result<Vec<String>, AppError> {
    validate_source_build_backend(backend)?;
    let backend_option = match backend {
        "vulkan" => "GGML_VULKAN",
        "cuda" => "GGML_CUDA",
        "rocm" => "GGML_HIP",
        "metal" => "GGML_METAL",
        "cpu" => "GGML_CPU",
        _ => unreachable!("validate_source_build_backend checked the backend"),
    };
    let backend_extra = match backend {
        // Without an explicit list CMake compiles every architecture llama.cpp
        // names by default, which is the single biggest cost in a CUDA build.
        "cuda" => vec![format!("-DCMAKE_CUDA_ARCHITECTURES={cuda_architectures}")],
        "metal" => vec!["-DGGML_METAL_EMBED_LIBRARY=ON".into()],
        _ => Vec::new(),
    };
    let mut args = vec![
        "-S".into(),
        source_root.to_string_lossy().into_owned(),
        "-B".into(),
        build_root.to_string_lossy().into_owned(),
        "-DCMAKE_BUILD_TYPE=Release".into(),
        "-DGGML_NATIVE=OFF".into(),
        "-DBUILD_SHARED_LIBS=ON".into(),
        "-DGGML_BACKEND_DL=ON".into(),
        "-DGGML_CPU_ALL_VARIANTS=ON".into(),
        format!(
            "-DGGML_METAL={}",
            if backend == "metal" { "ON" } else { "OFF" }
        ),
        "-DLLAMA_BUILD_COMMON=ON".into(),
        "-DLLAMA_BUILD_SERVER=ON".into(),
        "-DLLAMA_BUILD_TOOLS=ON".into(),
        "-DLLAMA_BUILD_TESTS=OFF".into(),
        "-DLLAMA_BUILD_EXAMPLES=OFF".into(),
        // Make any fetch that still happens visible in the log so
        // `build_failure_hint` can name it.
        "-DFETCHCONTENT_QUIET=OFF".into(),
        format!("-D{backend_option}=ON"),
    ]
    .into_iter()
    // Keep the configure inside the source archive that was already
    // downloaded and hash-recorded.
    .chain(
        SOURCE_BUILD_OFFLINE_OPTIONS
            .iter()
            .map(|option| (*option).to_string()),
    )
    .chain(backend_extra)
    .collect::<Vec<_>>();
    #[cfg(windows)]
    if backend == "rocm" {
        // ROCm's Windows CMake path treats HIP sources as C++ because CMake's
        // native HIP language support is unavailable there. The upstream
        // build recipe therefore uses Ninja plus ROCm's clang pair; the
        // Visual Studio generator otherwise hands .cu files to cl.exe.
        let mut toolchain = vec![
            "-G".to_string(),
            "Ninja".to_string(),
            "-DCMAKE_C_COMPILER=clang".to_string(),
            "-DCMAKE_CXX_COMPILER=clang++".to_string(),
        ];
        toolchain.append(&mut args);
        args = toolchain;
    }
    // Windows resolves DLLs beside the executable. On Unix, keep vendor
    // libraries beside the staged binaries and ask the platform loader to
    // search that directory after activation. The token is intentionally
    // passed as an argv value; it is not shell-expanded.
    if let Some(rpath) = portable_runtime_rpath() {
        args.push(format!("-DCMAKE_BUILD_RPATH={rpath}"));
        args.push(format!("-DCMAKE_INSTALL_RPATH={rpath}"));
        args.push("-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON".into());
        args.push("-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON".into());
    }
    Ok(args)
}

#[cfg(target_os = "macos")]
pub(super) fn portable_runtime_rpath() -> Option<&'static str> {
    Some("@loader_path")
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) fn portable_runtime_rpath() -> Option<&'static str> {
    Some("$ORIGIN")
}

#[cfg(not(unix))]
pub(super) fn portable_runtime_rpath() -> Option<&'static str> {
    None
}

pub(super) fn valid_parallelism(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.chars().all(|character| character.is_ascii_digit())
        && value.parse::<u32>().map(|jobs| jobs > 0).unwrap_or(false)
}

pub(super) fn source_build_args_with_parallelism(
    build_root: &Path,
    parallelism: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--build".into(),
        build_root.to_string_lossy().into_owned(),
        "--config".into(),
        "Release".into(),
        "--target".into(),
    ];
    args.extend(
        SOURCE_BUILD_TARGETS
            .iter()
            .map(|target| (*target).to_string()),
    );
    match parallelism {
        // CMake's default when no --parallel value is supplied is the full
        // core count. Keep that behaviour when the user has not configured a
        // cap, while ensuring a configured CMAKE_BUILD_PARALLEL_LEVEL is not
        // overridden by a bare --parallel flag.
        None => args.push("--parallel".into()),
        Some(value) if valid_parallelism(value) => {
            args.push("--parallel".into());
            args.push(value.trim().to_string());
        }
        Some(_) => {
            // Leave the flag out for an invalid value. CMake will report the
            // invalid environment value instead of silently falling back to
            // all cores, which could exhaust memory.
        }
    }
    args
}

pub(super) fn source_build_args(build_root: &Path) -> Vec<String> {
    // `var_os` matters here: an environment variable that is present but not
    // valid Unicode is still present and must not accidentally trigger the
    // bare full-core `--parallel` fallback.
    let parallelism = std::env::var_os("CMAKE_BUILD_PARALLEL_LEVEL")
        .map(|value| value.to_string_lossy().into_owned());
    source_build_args_with_parallelism(build_root, parallelism.as_deref())
}

/// What a supervised build step produced: its exit status plus a bounded tail
/// of each pipe.
#[derive(Debug)]
pub(super) struct BuildCommandOutput {
    pub(super) status: std::process::ExitStatus,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

/// Wait for a long-running build child, emitting a progress tick every second
/// and honouring both cancellation and `deadline`.
///
/// Both pipes are drained for the entire life of the child - a build that
/// writes more than the retained tail has to keep running, not deadlock on a
/// full pipe or die on a broken one - and they are only joined after the
/// process has exited, so no handle is ever closed under a live child.
pub(super) async fn supervise_build_child(
    mut child: TransientChild,
    progress: ProgressSink<'_>,
    phase: &str,
    label: &str,
    cancel: &Arc<AtomicBool>,
    deadline: Duration,
) -> Result<BuildCommandOutput, AppError> {
    let Some(stdout) = child.stdout.take() else {
        terminate_build_child(&mut child).await;
        return Err(AppError::internal(format!(
            "{label} stdout was not captured"
        )));
    };
    let readers = BuildReaders::attach(stdout, child.stderr.take());
    let started = Instant::now();
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            terminate_build_child(&mut child).await;
            let _ = readers.finish(CANCEL_READER_TIMEOUT).await;
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        let elapsed = started.elapsed();
        if elapsed >= deadline {
            // The deadline is a backstop against a hung compiler or a stalled
            // network probe, not a normal exit path: kill the tree the same
            // way cancellation does, then hand back whatever the log already
            // captured so the failure is actionable.
            terminate_build_child(&mut child).await;
            let (stdout, stderr) = readers.finish(CANCEL_READER_TIMEOUT).await;
            let detail = build_failure_detail(&stdout, &stderr);
            let mut message = format!(
                "{label} exceeded its {} timeout after {} and was terminated",
                format_seconds(deadline),
                format_seconds(elapsed)
            );
            if !detail.is_empty() {
                message.push_str(": ");
                message.push_str(&detail);
            }
            return Err(AppError::timeout(message));
        }
        let tick = Duration::from_secs(1).min(deadline - elapsed);
        tokio::select! {
            result = child.wait() => {
                match result {
                    Ok(status) => {
                        break status;
                    }
                    // The child is unreachable but not necessarily gone: kill
                    // the tree and join the drains before returning, so no
                    // pipe outlives this call and no build is left orphaned.
                    Err(error) => {
                        terminate_build_child(&mut child).await;
                        let _ = readers.finish(CANCEL_READER_TIMEOUT).await;
                        return Err(AppError::internal(format!("{label} wait failed: {error}")));
                    }
                }
            }
            _ = sleep(tick) => {
                progress(phase, started.elapsed().as_secs_f64(), 0.0);
            }
        }
    };
    let (stdout, stderr) = readers.finish(BUILD_READER_TIMEOUT).await;
    Ok(BuildCommandOutput {
        status,
        stdout,
        stderr,
    })
}

/// The drain tasks of a supervised build child, kept together so every exit
/// path joins both of them before the call returns.
struct BuildReaders {
    stdout: (OwnedTask<()>, SharedLog),
    stderr: Option<(OwnedTask<()>, SharedLog)>,
}

impl BuildReaders {
    fn attach(
        stdout: tokio::process::ChildStdout,
        stderr: Option<tokio::process::ChildStderr>,
    ) -> Self {
        let stdout_log = shared_log(MAX_BUILD_LOG_TAIL, Retain::Tail);
        let stdout_task = tokio::spawn(drain_stream_into(stdout, stdout_log.clone()));
        let stderr = stderr.map(|stderr| {
            let log = shared_log(MAX_BUILD_LOG_TAIL, Retain::Tail);
            let task = tokio::spawn(drain_stream_into(stderr, log.clone()));
            (task.into(), log)
        });
        Self {
            stdout: (stdout_task.into(), stdout_log),
            stderr,
        }
    }

    pub(super) async fn finish(self, limit: Duration) -> (Vec<u8>, Vec<u8>) {
        let (task, log) = self.stdout;
        let stdout = finish_build_reader(task, &log, limit).await;
        let stderr = match self.stderr {
            Some((task, log)) => finish_build_reader(task, &log, limit).await,
            None => Vec::new(),
        };
        (stdout, stderr)
    }
}

/// Render a duration as seconds with one decimal place. The same format
/// reads naturally for a minute-scale production timeout and a
/// millisecond-scale test deadline alike.
fn format_seconds(duration: Duration) -> String {
    format!("{:.1}s", duration.as_secs_f64())
}

/// Last `limit` characters of `text`, so a failure report keeps the diagnostic
/// that ended the build instead of the banner that started it.
pub(super) fn tail_chars(text: &str, limit: usize) -> String {
    let mut tail = text.chars().rev().take(limit).collect::<Vec<_>>();
    tail.reverse();
    tail.into_iter().collect()
}

/// Human-readable tail of a failed build step: stdout first, then stderr.
pub(super) fn build_failure_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let mut output = String::from_utf8_lossy(stdout).into_owned();
    let stderr = String::from_utf8_lossy(stderr);
    if !stderr.trim().is_empty() {
        output.push('\n');
        output.push_str(stderr.trim());
    }
    tail_chars(output.trim(), MAX_BUILD_DETAIL_CHARS)
        .trim()
        .to_string()
}

/// The configure step only ever runs `cmake -S -B`; anything else invoked
/// through this helper is the build step, which needs the much larger budget.
fn cmake_phase_timeout(phase: &str) -> Duration {
    if phase == "configuring" {
        CMAKE_CONFIGURE_TIMEOUT
    } else {
        CMAKE_BUILD_TIMEOUT
    }
}

pub(super) async fn run_cmake_command(
    cmake: &Path,
    backend: &str,
    progress: ProgressSink<'_>,
    phase: &str,
    args: &[String],
    current_dir: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    let deadline = cmake_phase_timeout(phase);
    let environment_tool = cmake.to_path_buf();
    let environment_backend = backend.to_string();
    let environment_cancel = cancel.clone();
    let environment = tokio::task::spawn_blocking(move || {
        build_environment_for_backend(
            &environment_tool,
            &environment_backend,
            Some(&environment_cancel),
        )
    })
    .await
    .map_err(|error| format!("failed to prepare CMake environment: {error}"))?;
    // Each build runs in its private workspace; Git discovery stops there.
    let environment = with_git_ceiling(environment, current_dir)?;
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("runtime install cancelled"));
    }
    let mut command = crate::procutil::tokio_command(cmake);
    configure_build_process_group(&mut command);
    command
        .env_clear()
        .envs(environment)
        .current_dir(current_dir);
    command
        .kill_on_drop(true)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = TransientChild::spawn(&mut command)
        .map_err(|error| AppError::io(&format!("failed to start CMake for {phase}"), &error))?;
    let label = format!("CMake {phase}");
    let supervised = supervise_build_child(child, progress, phase, &label, cancel, deadline).await;
    let output = supervised?;
    if output.status.success() {
        return Ok(());
    }
    let detail = build_failure_detail(&output.stdout, &output.stderr);
    let mut message = format!(
        "{label} failed with {}: {}",
        output.status,
        if detail.is_empty() {
            "no diagnostic output"
        } else {
            detail.as_str()
        }
    );
    if let Some(hint) = build_failure_hint(&detail) {
        message.push_str("\n\nWhat to do: ");
        message.push_str(hint);
    }
    Err(AppError::internal(message))
}

/// Recorded in the source manifest so a runtime says how well its origin is
/// established, rather than implying more than was actually checked.
pub(super) const COMMIT_CHECK_MATCHED: &str = "archive-directory-matches-commit";

pub(super) const COMMIT_CHECK_UNKNOWN: &str = "archive-layout-unrecognised";

/// What the extracted tree proves about which commit it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ArchiveCommitCheck {
    /// The top-level directory names exactly the commit that was requested.
    Matches,
    /// It names a different commit: GitHub served a tree nobody asked for.
    Mismatch(String),
    /// It carries no commit id at all. An archive layout we do not recognise,
    /// so this check has nothing to say and the build must fail closed.
    Unknown,
}

/// A codeload archive requested by commit id unpacks into `<repo>-<sha>`.
///
/// That suffix is produced by GitHub from the ref in the URL, so finding our
/// own commit there is evidence that the returned archive has the requested
/// provenance - unlike a digest this machine computed from those same bytes.
/// It is a provenance/layout check, not a cryptographic signature; the HTTPS
/// connection and the exact commit request provide the transport boundary.
pub(super) fn archive_commit_check(source_root: &Path, expected: &str) -> ArchiveCommitCheck {
    let Some(name) = source_root.file_name().and_then(|name| name.to_str()) else {
        return ArchiveCommitCheck::Unknown;
    };
    let Some((_, suffix)) = name.rsplit_once('-') else {
        return ArchiveCommitCheck::Unknown;
    };
    let suffix = suffix.to_ascii_lowercase();
    if validate_commit_sha(&suffix).is_err() {
        return ArchiveCommitCheck::Unknown;
    }
    if suffix == expected.trim().to_ascii_lowercase() {
        ArchiveCommitCheck::Matches
    } else {
        ArchiveCommitCheck::Mismatch(suffix)
    }
}

pub(super) fn find_source_root(extracted: &Path) -> Result<PathBuf, AppError> {
    if extracted.join("CMakeLists.txt").is_file() {
        return Ok(extracted.to_path_buf());
    }
    let mut roots = Vec::new();
    let entries = fs::read_dir(extracted).map_err(|error| AppError::from_io(&error))?;
    for entry in entries {
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        let metadata = entry
            .metadata()
            .map_err(|error| AppError::from_io(&error))?;
        if metadata.is_dir() && entry.path().join("CMakeLists.txt").is_file() {
            roots.push(entry.path());
        }
    }
    match roots.as_slice() {
        [root] => Ok(root.clone()),
        [] => Err(AppError::validation(
            "llama.cpp source archive has no top-level CMakeLists.txt",
        )),
        _ => Err(AppError::validation(
            "llama.cpp source archive has multiple possible source roots",
        )),
    }
}

pub(super) fn find_built_runtime_dir(build_root: &Path) -> Result<PathBuf, AppError> {
    let candidates = [
        build_root.join("bin").join("Release"),
        build_root.join("bin"),
        build_root.join("Release"),
    ];
    if let Some(candidate) = candidates
        .iter()
        .find(|candidate| has_runtime_binaries(candidate))
    {
        return Ok(candidate.clone());
    }

    let mut pending = vec![(build_root.to_path_buf(), 0_u32)];
    let mut visited = 0_usize;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 8 || visited >= 4096 {
            continue;
        }
        visited += 1;
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            if has_runtime_binaries(&path) {
                return Ok(path);
            }
            pending.push((path, depth + 1));
        }
    }
    Err(AppError::not_found(format!(
        "CMake completed but {} was not found in the build output",
        server_executable_name()
    )))
}

/// The build output directory is the one holding llama-server. Optional tools
/// such as llama-bench are copied with it when present but are not required.
fn has_runtime_binaries(directory: &Path) -> bool {
    directory.join(server_executable_name()).is_file()
}

pub(super) fn copy_runtime_tree(
    source: &Path,
    destination: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    let root = fs::canonicalize(source).map_err(|error| AppError::from_io(&error))?;
    copy_runtime_tree_in(&root, &root, destination, cancel)
}

fn copy_runtime_tree_in(
    root: &Path,
    source: &Path,
    destination: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    fs::create_dir_all(destination).map_err(|error| AppError::from_io(&error))?;
    let entries = fs::read_dir(source).map_err(|error| AppError::from_io(&error))?;
    for entry in entries {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        let path = entry.path();
        let mut metadata =
            fs::symlink_metadata(&path).map_err(|error| AppError::from_io(&error))?;
        if metadata.file_type().is_symlink() {
            // CMake produces SONAME aliases on Linux and macOS. Materialize
            // only file aliases inside this build tree, never directory links.
            let resolved = fs::canonicalize(&path).map_err(|error| AppError::from_io(&error))?;
            if !resolved.starts_with(root) || !resolved.is_file() {
                return Err(AppError::validation(
                    "runtime build output link escapes its tree or targets a directory",
                ));
            }
            metadata = fs::metadata(&resolved).map_err(|error| AppError::from_io(&error))?;
        }
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_runtime_tree_in(root, &path, &target, cancel)?;
        } else {
            fs::copy(&path, &target).map_err(|error| AppError::from_io(&error))?;
            #[cfg(unix)]
            fs::set_permissions(&target, metadata.permissions())
                .map_err(|error| AppError::from_io(&error))?;
        }
    }
    Ok(())
}
