use super::*;

#[cfg(windows)]
pub(super) fn merge_visual_studio_environment(
    environment: &mut Vec<(OsString, OsString)>,
    cl: &Path,
    cancel: Option<&AtomicBool>,
) {
    let Some(vc_root) = cl.ancestors().find(|path| {
        path.file_name()
            .is_some_and(|name| name == OsStr::new("VC"))
    }) else {
        return;
    };
    let vcvarsall = vc_root
        .join("Auxiliary")
        .join("Build")
        .join("vcvarsall.bat");
    if vcvarsall.is_file() {
        let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
        let command_line = format!("call \"{}\" x64 >nul && set", vcvarsall.display());
        let mut command = crate::procutil::std_command(comspec);
        command
            .env_clear()
            .envs(child_environment())
            .args(["/d", "/s", "/c", &command_line]);
        if let Ok(output) = crate::procutil::capture_stdout_cancellable(
            &mut command,
            Duration::from_secs(30),
            256 * 1024,
            cancel,
        ) {
            if output.status.success() {
                const NAMES: &[&str] = &[
                    "PATH",
                    "INCLUDE",
                    "LIB",
                    "LIBPATH",
                    "VCToolsInstallDir",
                    "VCToolsVersion",
                    "VCToolsRedistDir",
                    "WindowsSdkDir",
                    "WindowsSdkVerBinPath",
                    "WindowsSDKVersion",
                    "UniversalCRTSdkDir",
                    "UCRTVersion",
                    "VSCMD_ARG_HOST_ARCH",
                    "VSCMD_ARG_TGT_ARCH",
                ];
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let Some((name, value)) = line.split_once('=') else {
                        continue;
                    };
                    if !NAMES.contains(&name) {
                        continue;
                    }
                    if name == "PATH" {
                        append_environment_paths(environment, OsStr::new(value));
                    } else {
                        set_environment_value(environment, name, OsString::from(value));
                    }
                }
            }
        }
    }

    // `vcvarsall.bat` is the supported entry point, but it can fail when the
    // app was launched by a GUI with a reduced environment (or when cmd uses
    // a non-UTF code page). Clang still needs the import and library search
    // paths even in that case. Reconstruct them from the compiler and SDK
    // layout instead of letting the link fail with an opaque kernel32.lib
    // error after configure has already started.
    if !cl.ancestors().any(|path| {
        path.file_name()
            .is_some_and(|name| name == OsStr::new("MSVC"))
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == OsStr::new("Tools"))
    }) {
        return;
    }
    let Some(toolset_version) = cl.ancestors().find(|path| {
        path.parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == OsStr::new("MSVC"))
    }) else {
        return;
    };

    let sdk_root = environment_value(environment, "WindowsSdkDir")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(windows_sdk_root);
    let sdk_version = sdk_root.as_deref().and_then(|root| {
        environment_value(environment, "WindowsSDKVersion")
            .map(|value| {
                value
                    .to_string_lossy()
                    .trim_matches(['\\', '/'])
                    .to_string()
            })
            .filter(|version| root.join("Include").join(version).is_dir())
            .map(PathBuf::from)
            .or_else(|| {
                newest_directory(&root.join("Include"))
                    .and_then(|path| path.file_name().map(PathBuf::from))
            })
    });

    let mut include_paths = vec![toolset_version.join("include")];
    let visual_studio_include = vc_root.join("Auxiliary").join("VS").join("include");
    include_paths.push(visual_studio_include);
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        for name in ["ucrt", "um", "shared", "winrt", "cppwinrt"] {
            include_paths.push(root.join("Include").join(version).join(name));
        }
    }
    include_paths.retain(|path| path.is_dir());
    merge_path_variable(environment, "INCLUDE", &include_paths);

    let mut lib_paths = vec![toolset_version.join("lib").join("x64")];
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        for name in ["ucrt", "um"] {
            lib_paths.push(root.join("Lib").join(version).join(name).join("x64"));
        }
    }
    lib_paths.retain(|path| path.is_dir());
    merge_path_variable(environment, "LIB", &lib_paths);

    let mut libpath_paths = lib_paths;
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        libpath_paths.push(root.join("UnionMetadata").join(version));
        libpath_paths.push(root.join("References").join(version));
    }
    libpath_paths.retain(|path| path.is_dir());
    merge_path_variable(environment, "LIBPATH", &libpath_paths);

    let mut path_prefixes = vec![cl.parent().unwrap_or(vc_root).to_path_buf()];
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        path_prefixes.push(root.join("bin").join(version).join("x64"));
        path_prefixes.push(root.join("bin").join(version));
    }
    path_prefixes.retain(|path| path.is_dir());
    prepend_environment_paths(environment, &path_prefixes);

    if let Some(root) = sdk_root {
        set_environment_value(environment, "WindowsSdkDir", root.into_os_string());
    }
    if let Some(version) = sdk_version {
        set_environment_value(
            environment,
            "WindowsSDKVersion",
            OsString::from(format!("{}\\", version.display())),
        );
    }
    set_environment_value(
        environment,
        "VCToolsInstallDir",
        toolset_version.to_path_buf().into_os_string(),
    );
    if let Some(version) = toolset_version.file_name() {
        set_environment_value(environment, "VCToolsVersion", version.to_os_string());
    }
}

#[cfg(windows)]
pub(super) fn environment_value(
    environment: &[(OsString, OsString)],
    name: &str,
) -> Option<OsString> {
    environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(OsStr::new(name)))
        .map(|(_, value)| value.clone())
        .filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn append_environment_paths(environment: &mut Vec<(OsString, OsString)>, additional: &OsStr) {
    let existing = environment_value(environment, "PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut paths = existing;
    paths.extend(std::env::split_paths(additional));
    if let Ok(path) = std::env::join_paths(paths) {
        set_environment_value(environment, "PATH", path);
    }
}

#[cfg(windows)]
fn merge_path_variable(environment: &mut Vec<(OsString, OsString)>, name: &str, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    let mut merged = environment_value(environment, name)
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    for path in paths {
        if !merged.iter().any(|existing| existing == path) {
            merged.push(path.clone());
        }
    }
    if let Ok(value) = std::env::join_paths(merged) {
        set_environment_value(environment, name, value);
    }
}

#[cfg(windows)]
fn newest_directory(root: &Path) -> Option<PathBuf> {
    let mut directories = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| right.cmp(left));
    directories.into_iter().next()
}

#[cfg(windows)]
fn windows_sdk_root() -> Option<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .map(|root| root.join("Windows Kits").join("10"))
        .find(|root| root.is_dir())
}

/// Locate Ninja in PATH or beside one of the CMake distributions that
/// aiolm already knows how to find. Windows ROCm builds deliberately use
/// Ninja because CMake's Visual Studio generator sends HIP sources to cl.exe.
#[cfg(windows)]
pub(super) fn locate_ninja() -> Option<PathBuf> {
    if let Ok(path) = which::which("ninja") {
        if path.is_file() {
            return Some(path);
        }
    }

    for cmake in windows_cmake_candidates() {
        let Some(cmake_dir) = cmake.parent() else {
            continue;
        };
        let mut ninja_dirs = vec![cmake_dir.to_path_buf(), cmake_dir.join("Ninja")];
        if let Some(parent) = cmake_dir.parent() {
            ninja_dirs.push(parent.join("Ninja"));
            if let Some(grandparent) = parent.parent() {
                ninja_dirs.push(grandparent.join("Ninja"));
            }
        }
        for directory in ninja_dirs {
            let candidate = directory.join("ninja.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

/// Visual Studio editions, most complete first.
///
/// Any edition ships the same bundled CMake, so this only decides which of two
/// equally new installs is tried first. It is spelled out rather than left to
/// directory order because `read_dir` returns entries in whatever order the
/// filesystem happens to hold them - which is not the same on two PCs, or even
/// on one PC after an update, and a build tool that changes under the user is
/// worse than one that is merely not their favourite.
#[cfg(any(windows, test))]
const VISUAL_STUDIO_EDITIONS: &[&str] = &["Enterprise", "Professional", "Community", "BuildTools"];

/// One `…/Microsoft Visual Studio/<year>/<edition>` install.
#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct VisualStudioInstall {
    pub(super) year: u32,
    pub(super) edition: String,
    pub(super) cmake: PathBuf,
    #[cfg(windows)]
    pub(super) edition_root: PathBuf,
}

#[cfg(windows)]
fn visual_studio_cmake(edition_root: &Path) -> PathBuf {
    edition_root
        .join("Common7")
        .join("IDE")
        .join("CommonExtensions")
        .join("Microsoft")
        .join("CMake")
        .join("CMake")
        .join("bin")
        .join("cmake.exe")
}

/// Order installs newest-first, and identically on every machine.
///
/// Newest year wins; within a year the edition order above decides; an edition
/// nobody has heard of sorts after the known ones by name. Ties are broken by
/// path so the result is a total order with no dependence on directory order.
#[cfg(any(windows, test))]
pub(super) fn sort_visual_studio_installs(installs: &mut [VisualStudioInstall]) {
    installs.sort_by(|left, right| {
        let rank = |edition: &str| {
            VISUAL_STUDIO_EDITIONS
                .iter()
                .position(|known| known.eq_ignore_ascii_case(edition))
                .unwrap_or(VISUAL_STUDIO_EDITIONS.len())
        };
        right
            .year
            .cmp(&left.year)
            .then_with(|| rank(&left.edition).cmp(&rank(&right.edition)))
            .then_with(|| left.edition.cmp(&right.edition))
            .then_with(|| left.cmake.cmp(&right.cmake))
    });
}

/// Collect the Visual Studio installs under one `Program Files` root.
#[cfg(windows)]
fn visual_studio_installs(root: &Path) -> Vec<VisualStudioInstall> {
    let mut installs = Vec::new();
    let Ok(years) = fs::read_dir(root.join("Microsoft Visual Studio")) else {
        return installs;
    };
    for year in years.flatten() {
        if !year.metadata().map(|meta| meta.is_dir()).unwrap_or(false) {
            continue;
        }
        // A non-numeric directory here is not a release year (VS also keeps
        // "Shared" beside them), so it cannot be ranked and is skipped.
        let Some(parsed) = year
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(editions) = fs::read_dir(year.path()) else {
            continue;
        };
        for edition in editions.flatten() {
            if !edition
                .metadata()
                .map(|meta| meta.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            installs.push(VisualStudioInstall {
                year: parsed,
                edition: edition.file_name().to_string_lossy().into_owned(),
                cmake: visual_studio_cmake(&edition.path()),
                edition_root: edition.path(),
            });
        }
    }
    installs
}

/// Where CMake is looked for on Windows when it is not on `PATH`, in the order
/// it is tried.
///
/// A standalone CMake install comes first: the user installed it deliberately
/// and it is almost always newer than whatever Visual Studio bundles. Visual
/// Studio's copies follow, newest release first.
#[cfg(windows)]
pub(super) fn windows_cmake_candidates() -> Vec<PathBuf> {
    let roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"];
    let mut standalone = Vec::new();
    let mut installs = Vec::new();
    for variable in roots {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        standalone.push(root.join("CMake").join("bin").join("cmake.exe"));
        if variable == "LOCALAPPDATA" {
            standalone.push(
                root.join("Programs")
                    .join("CMake")
                    .join("bin")
                    .join("cmake.exe"),
            );
            continue;
        }
        installs.extend(visual_studio_installs(&root));
    }
    sort_visual_studio_installs(&mut installs);
    standalone
        .into_iter()
        .chain(installs.into_iter().map(|install| install.cmake))
        .collect()
}

#[cfg(windows)]
fn windows_cl_candidates() -> Vec<PathBuf> {
    let mut installs = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        installs.extend(visual_studio_installs(&root));
    }
    if let Some(root) = std::env::var_os("VSINSTALLDIR").map(PathBuf::from) {
        installs.push(VisualStudioInstall {
            // The process was explicitly launched from this developer
            // environment. Prefer its selected toolset over an arbitrary
            // installed edition, even when the directory name is not a
            // numeric Visual Studio release year.
            year: u32::MAX,
            edition: "DeveloperCommandPrompt".into(),
            cmake: PathBuf::new(),
            edition_root: root,
        });
    }
    sort_visual_studio_installs(&mut installs);

    let mut candidates = Vec::new();
    for install in installs {
        let msvc_root = install.edition_root.join("VC").join("Tools").join("MSVC");
        let Ok(versions) = fs::read_dir(msvc_root) else {
            continue;
        };
        let mut versions: Vec<PathBuf> = versions
            .flatten()
            .filter_map(|entry| {
                entry
                    .metadata()
                    .ok()
                    .filter(|meta| meta.is_dir())
                    .map(|_| entry.path())
            })
            .collect();
        versions.sort_by(|left, right| right.cmp(left));
        for version in versions {
            // Prefer a native x64 compiler, then fall back to the other host
            // and target combinations that Visual Studio installs.
            for (host, target) in [
                ("Hostx64", "x64"),
                ("Hostx86", "x64"),
                ("Hostx64", "x86"),
                ("Hostx86", "x86"),
            ] {
                candidates.push(version.join("bin").join(host).join(target).join("cl.exe"));
            }
        }
    }
    candidates
}

pub(super) fn locate_tool(name: &str) -> Option<PathBuf> {
    let configured_name = match name {
        "cc" => Some("CC"),
        "c++" => Some("CXX"),
        "nvcc" => Some("CUDACXX"),
        _ => None,
    };
    if let Some(variable) = configured_name {
        if let Some(value) = std::env::var_os(variable) {
            let path = PathBuf::from(value);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Ok(path) = which::which(name) {
        if path.is_file() {
            return Some(path);
        }
    }

    let root_variables: &[&str] = match name {
        "nvcc" => &["CUDA_PATH", "CUDA_HOME", "CUDA_TOOLKIT_ROOT_DIR"],
        "hipcc" => &["HIP_PATH", "ROCM_PATH"],
        "clang" | "clang++" => &["HIP_PATH", "ROCM_PATH"],
        "glslc" => &["VULKAN_SDK", "VK_SDK_PATH"],
        _ => &[],
    };
    for variable in root_variables {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        for relative in ["bin", ""] {
            let candidate = root.join(relative).join(name);
            #[cfg(windows)]
            let candidate = if candidate
                .extension()
                .is_some_and(|extension| extension == "exe")
            {
                candidate
            } else {
                candidate.with_extension("exe")
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    #[cfg(windows)]
    if name.eq_ignore_ascii_case("cl") {
        return windows_cl_candidates()
            .into_iter()
            .find(|path| path.is_file());
    }

    None
}

/// Infer the SDK root from a compiler installed in `<root>/bin`. This keeps
/// standard ROCm/CUDA installations usable when their vendor installer did
/// not export HIP_PATH, ROCM_PATH, or CUDA_PATH (common on Unix systems).
pub(super) fn sdk_root_from_tool(name: &str) -> Option<PathBuf> {
    let tool = locate_tool(name)?;
    let tool = fs::canonicalize(&tool).unwrap_or(tool);
    #[cfg(windows)]
    let tool = strip_windows_verbatim_prefix(tool);
    tool.parent()?.parent().map(Path::to_path_buf)
}

/// CMake's Windows Ninja generator invokes compiler and linker commands
/// through `cmd.exe`. The Win32 APIs accept `\\?\` extended paths, but cmd.exe
/// does not reliably execute them: it can compile a direct Ninja command and
/// then fail the link command with the unhelpful "path not found" message.
/// Never put such a path in PATH or a compiler variable handed to a child.
#[cfg(windows)]
pub(super) fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    const UNC_PREFIX: &str = "\\\\?\\UNC\\";
    const VERBATIM_PREFIX: &str = "\\\\?\\";
    if let Some(rest) = value.strip_prefix(UNC_PREFIX) {
        PathBuf::from(format!("\\\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(VERBATIM_PREFIX) {
        PathBuf::from(rest)
    } else {
        path
    }
}

/// A `hipcc` executable by itself is not an SDK. Distro packages sometimes
/// leave a wrapper at `/usr/bin/hipcc` even when the HIP headers and runtime
/// libraries are absent, so require an SDK marker before treating the inferred
/// parent as a usable ROCm installation.
fn rocm_sdk_root_has_runtime(root: &Path) -> bool {
    if root.join("include").join("hip").is_dir() {
        return true;
    }
    ["bin", "lib", "lib64", "lib/x64"].iter().any(|relative| {
        let Ok(entries) = fs::read_dir(root.join(relative)) else {
            return false;
        };
        entries.flatten().any(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
                && is_backend_runtime_library("rocm", &entry.file_name().to_string_lossy())
        })
    })
}

fn rocm_sdk_is_configured() -> bool {
    ["HIP_PATH", "ROCM_PATH"].iter().any(|variable| {
        std::env::var_os(variable)
            .map(PathBuf::from)
            .is_some_and(|root| root.is_dir() && rocm_sdk_root_has_runtime(&root))
    }) || sdk_root_from_tool("hipcc").is_some_and(|root| rocm_sdk_root_has_runtime(&root))
}

fn locate_cmake() -> Option<PathBuf> {
    if let Ok(path) = which::which("cmake") {
        if path.is_file() {
            return Some(path);
        }
    }

    #[cfg(windows)]
    {
        windows_cmake_candidates()
            .into_iter()
            .find(|path| path.is_file())
    }

    // Kitware's app keeps its command-line tools inside the bundle unless the
    // user also runs its separate command-line installation step.
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        [
            Some(PathBuf::from("/Applications")),
            home.map(|home| home.join("Applications")),
        ]
        .into_iter()
        .flatten()
        .map(|root| root.join("CMake.app/Contents/bin/cmake"))
        .find(|path| path.is_file())
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        None
    }
}

/// Name the places that were actually searched, per platform.
///
/// "the standard Windows install locations" is not advice on a Mac, and the
/// user's next move differs by platform, so say the platform's own.
pub(super) fn cmake_not_found_error() -> AppError {
    let hint = if cfg!(windows) {
        "install it from cmake.org or with `winget install Kitware.CMake`, or add the C++ CMake tools to your Visual Studio install"
    } else if cfg!(target_os = "macos") {
        "install it with `brew install cmake`, or put the CMake app from cmake.org in Applications"
    } else {
        "install it with your package manager, for example `apt install cmake ninja-build` or `dnf install cmake ninja-build`"
    };
    let searched = if cfg!(windows) {
        "PATH, the standard CMake install directories, and the copies bundled with Visual Studio"
    } else if cfg!(target_os = "macos") {
        "PATH, Homebrew and the CMake app in Applications"
    } else {
        "PATH"
    };
    AppError::not_found(format!(
        "CMake was not found. aiolm looked in {searched}. A PR build needs CMake and a C++ toolchain: {hint}, then try again."
    ))
}

/// The oldest CMake that can run the command lines in this file.
///
/// Not llama.cpp's own floor - that is lower - but ours: `-S`/`-B` needs 3.13,
/// `--target a b` (llama-server *and* llama-perplexity in one build) needs 3.15,
/// and `CMAKE_CUDA_ARCHITECTURES` needs 3.18. A PR whose own
/// `cmake_minimum_required` is higher still fails at configure, and
/// `build_failure_hint` explains that case separately.
const MIN_CMAKE_VERSION: (u32, u32) = (3, 18);

/// Parse the first line of `cmake --version`, e.g.
/// `cmake version 3.29.2` or `cmake version 3.31.0-rc1`.
pub(super) fn parse_cmake_version(text: &str) -> Option<(u32, u32, u32)> {
    let line = text.lines().find(|line| line.contains("cmake version"))?;
    let rest = line.split("cmake version").nth(1)?.trim();
    let number = rest
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find(|part| !part.is_empty())?;
    let mut parts = number.split('.').map(|part| part.parse::<u32>().ok());
    let major = parts.next().flatten()?;
    let minor = parts.next().flatten().unwrap_or(0);
    let patch = parts.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

pub(super) fn cmake_version_error(path: &Path, version: (u32, u32, u32)) -> Option<AppError> {
    if (version.0, version.1) >= MIN_CMAKE_VERSION {
        return None;
    }
    Some(AppError::unavailable(format!(
        "the CMake at {} is version {}.{}.{}, but a PR build needs at least {}.{}. Install a newer CMake (cmake.org, winget \"Kitware.CMake\", or the Visual Studio installer's C++ CMake tools) and try again.",
        path.display(),
        version.0,
        version.1,
        version.2,
        MIN_CMAKE_VERSION.0,
        MIN_CMAKE_VERSION.1
    )))
}

/// Run the located CMake once before anything is downloaded, so a toolchain
/// that cannot work says so in a second rather than after a source download.
async fn cmake_preflight(path: &Path) -> Result<(u32, u32, u32), AppError> {
    let probe = run_probe(path, &["--version"]).await;
    if !probe.success {
        let diagnostic = probe
            .diagnostic
            .unwrap_or_else(|| AppError::unavailable("it did not report a version"));
        return Err(AppError::new(diagnostic.kind, format!(
            "the CMake at {} could not be run: {diagnostic}. Check that the install is intact, or put a working cmake on PATH.",
            path.display()
        )));
    }
    let version = parse_cmake_version(&probe.text).ok_or_else(|| {
        AppError::validation(format!(
            "the CMake at {} reported a version this build does not understand: {}",
            path.display(),
            probe.text.lines().next().unwrap_or("(no output)").trim()
        ))
    })?;
    if let Some(error) = cmake_version_error(path, version) {
        return Err(error);
    }
    Ok(version)
}

/// Free bytes on the volume holding `path`, or `None` when the platform will
/// not say. A missing answer never blocks a build - it only means the early
/// warning cannot be given.
pub(super) fn available_bytes(path: &Path) -> Option<u64> {
    // The deepest existing ancestor: the workspace directory itself may not
    // have been created yet when the check runs.
    let mut probe = path;
    loop {
        if probe.exists() {
            break;
        }
        probe = probe.parent()?;
    }
    platform_available_bytes(probe)
}

#[cfg(windows)]
fn platform_available_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_for_caller: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_for_caller,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free_for_caller)
}

#[cfg(unix)]
fn platform_available_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let raw = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(raw.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    // f_bavail is what an unprivileged process may actually use, which is the
    // number that matters here.
    (stats.f_bavail as u64).checked_mul(stats.f_frsize as u64)
}

#[cfg(not(any(windows, unix)))]
fn platform_available_bytes(_path: &Path) -> Option<u64> {
    None
}

pub(super) const GIB: u64 = 1024 * 1024 * 1024;

/// Rough space a source build needs on the volume it runs on: the archive, the
/// extracted tree, and the object files, which dominate.
///
/// Deliberately an underestimate of a worst case rather than an overestimate:
/// this exists to catch "you have 2 GB free", not to argue with someone who
/// knows their own disk.
pub(super) fn required_build_bytes(backend: &str) -> u64 {
    match backend {
        // Every CUDA kernel is compiled once per architecture in the list.
        "cuda" => 20 * GIB,
        _ => 10 * GIB,
    }
}

/// Space the *installed* runtime needs, which is a different volume whenever
/// the runtimes directory and the download directory are not on the same
/// drive. The staged copy and the outgoing backup coexist for the length of
/// one rename, so budget for two.
pub(super) const INSTALLED_RUNTIME_BYTES: u64 = 4 * GIB;

/// A directory-name nonce short enough not to eat the Windows path budget.
///
/// 12 hex characters is 48 bits. These names only have to be unique among the
/// installs running on one machine at one moment - the runtime busy guard
/// means that is normally one - so this is collisions-never territory while
/// costing 20 fewer characters than a full UUID on every path beneath it.
pub(super) fn short_nonce() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

pub(super) fn free_space_error(
    label: &str,
    path: &Path,
    required: u64,
    available: Option<u64>,
) -> Option<String> {
    let available = available?;
    if available >= required {
        return None;
    }
    let gib = |bytes: u64| format!("{:.1} GB", bytes as f64 / GIB as f64);
    Some(format!(
        "not enough free disk space for the {label}: it needs about {}, but only {} is free on {}. Free some space, or move the aiolm data directory to a larger drive, then try again.",
        gib(required),
        gib(available),
        path.display()
    ))
}

/// Check all local prerequisites before the PR confirmation dialog is shown.
///
/// The installer calls this again after confirmation because a user can leave
/// the dialog open while changing their toolchain. Returning the located CMake
/// keeps the second call from resolving a different executable between the
/// preflight and configure steps.
pub async fn source_build_preflight(backend: &str) -> Result<PathBuf, AppError> {
    validate_source_build_backend(backend)?;
    // Tool discovery walks Visual Studio/SDK installation trees. Keep that
    // filesystem work off Tokio's async worker so a slow or disconnected
    // installation cannot freeze the UI while the confirmation screen is
    // being prepared.
    let backend_for_lookup = backend.to_string();
    let (toolchain_error, cmake) = tokio::task::spawn_blocking(move || {
        let toolchain_error = source_build_toolchain_error(&backend_for_lookup);
        let cmake = if toolchain_error.is_none() {
            locate_cmake()
        } else {
            None
        };
        (toolchain_error, cmake)
    })
    .await
    .map_err(|error| {
        let message = format!("source build toolchain lookup task failed: {error}");
        if error.is_cancelled() {
            AppError::cancelled(message)
        } else {
            AppError::internal(message)
        }
    })?;
    if let Some(error) = toolchain_error {
        return Err(error);
    }
    let cmake = cmake.ok_or_else(cmake_not_found_error)?;
    // Run it once. A CMake that is too old, or broken, is far cheaper to find
    // out about here than after a source download and a ten-minute configure.
    cmake_preflight(&cmake).await?;
    Ok(cmake)
}

/// Backends a local pull-request source build can honestly produce.
///
/// CPU needs no vendor SDK, Vulkan needs the LunarG SDK's `glslc`, CUDA needs
/// the toolkit's `nvcc`, and ROCm needs `hipcc` plus a ROCm/HIP SDK. CUDA and
/// ROCm runtime libraries and their kernel data are copied beside the staged
/// binaries when the SDK exposes them. GPU driver libraries are deliberately
/// not copied: they belong to the host driver.
pub const SOURCE_BUILD_BACKENDS: &[&str] = &["cpu", "vulkan", "cuda", "rocm", "metal"];

/// Reject a backend that cannot be built from source on an ordinary machine,
/// before anything is resolved, downloaded or extracted.
pub fn validate_source_build_backend(backend: &str) -> Result<(), AppError> {
    validate_catalog_backend(backend)?;
    if SOURCE_BUILD_BACKENDS.contains(&backend) {
        return Ok(());
    }
    let reason = match backend {
        "sycl" => "the Intel oneAPI icx/icpx compiler driver and the environment that setvars installs, neither of which this build inherits",
        "openvino" => "the OpenVINO toolkit, its setupvars environment, and OpenVINO runtime libraries that are not part of the build tree",
        _ => "a vendor toolchain and runtime libraries that aiolm cannot detect or package",
    };
    Err(AppError::unavailable(format!(
        "PR builds are not supported for the {backend} backend: it needs {reason}. Install a released {backend} runtime from the backend list instead, or build this PR yourself with the vendor toolchain. PR builds are supported for: {}.",
        SOURCE_BUILD_BACKENDS.join(", ")
    )))
}

/// Host toolchain lookups, injected so the preflight policy can be tested
/// without depending on what happens to be installed on the test machine.
pub(super) struct ToolchainView<'a> {
    pub(super) executable: &'a dyn Fn(&str) -> bool,
    pub(super) directory_variable: &'a dyn Fn(&str) -> bool,
}

fn missing_host_compiler(view: &ToolchainView<'_>) -> Option<AppError> {
    if cfg!(windows) {
        if !(view.executable)("cl") {
            return Some(AppError::not_found(
                "a PR build needs the Microsoft C/C++ compiler (cl.exe). Install Visual Studio Build Tools with the Desktop development with C++ workload, or open aiolm from a Visual Studio Developer Command Prompt, then try again.",
            ));
        }
    } else if !(view.executable)("cc") && !(view.executable)("gcc") && !(view.executable)("clang") {
        return Some(AppError::not_found(
            "a PR build needs a C compiler (cc, gcc, or clang). Install your platform's C/C++ development toolchain and try again (for example `xcode-select --install` on macOS or `apt install build-essential` on Debian/Ubuntu).",
        ));
    } else if !(view.executable)("c++")
        && !(view.executable)("g++")
        && !(view.executable)("clang++")
    {
        return Some(AppError::not_found(
            "a PR build needs a C++ compiler (c++, g++, or clang++). Install your platform's C++ development toolchain and try again (for example `xcode-select --install` on macOS or `apt install build-essential` on Debian/Ubuntu).",
        ));
    }
    None
}

/// Explain what is missing for a supported source build, or `None` when the
/// machine already has what the backend needs.
pub(super) fn missing_source_build_toolchain(
    backend: &str,
    view: &ToolchainView<'_>,
) -> Option<AppError> {
    if let Some(error) = missing_host_compiler(view) {
        return Some(error);
    }
    match backend {
        "cuda" => (!(view.executable)("nvcc"))
        .then(|| {
            AppError::unavailable("a CUDA PR build needs the NVIDIA CUDA Toolkit compiler: install it and make sure nvcc is on PATH (or set CUDACXX to its full path), then try again. Without a toolkit, install a released CUDA runtime or build the PR for the vulkan or cpu backend.")
        }),
        "rocm" => {
            let has_sdk = (view.directory_variable)("HIP_PATH")
                || (view.directory_variable)("ROCM_PATH");
            if !(view.executable)("hipcc") || !has_sdk {
                Some(AppError::unavailable(
                    "a ROCm PR build needs the AMD ROCm/HIP SDK and its hipcc compiler: install ROCm, make sure hipcc is on PATH, and set HIP_PATH or ROCM_PATH to the SDK root, then try again. The finished build is tied to this machine's installed AMD driver.",
                ))
            } else if !(view.executable)("clang") || !(view.executable)("clang++") {
                Some(AppError::not_found(
                    "this ROCm installation is missing its clang/clang++ compiler pair. Repair the ROCm/HIP SDK or add its bin/llvm/bin directories to PATH, then try again.",
                ))
            } else {
                None
            }
        }
        "vulkan" => (!(view.executable)("glslc"))
        .then(|| {
            AppError::unavailable("a Vulkan PR build needs the LunarG Vulkan SDK's glslc shader compiler: install the SDK and make sure glslc is on PATH (or set VULKAN_SDK/VK_SDK_PATH to a complete SDK), then try again. Without the SDK, install a released Vulkan runtime or build the PR for the cpu backend.")
        }),
        _ => None,
    }
}

/// Backends a source build cannot target on this OS and architecture.
pub(super) fn source_build_platform_error(backend: &str, os: &str, arch: &str) -> Option<AppError> {
    if backend == "metal" && os != "macos" {
        return Some(AppError::unavailable(
            "Metal source builds require macOS and the Xcode command line tools.",
        ));
    }
    // Upstream's x64 build disables Metal, and its accuracy and memory use on
    // Intel Mac GPUs are not verified, so Intel Macs build for the CPU only.
    if backend == "metal" && arch != "aarch64" {
        return Some(AppError::unavailable(
            "Metal PR builds are supported on Apple silicon Macs only; select cpu on an Intel Mac.",
        ));
    }
    if os == "macos" && matches!(backend, "cuda" | "rocm") {
        return Some(AppError::unavailable(format!(
            "{backend} source builds are not supported on macOS; select metal or cpu."
        )));
    }
    None
}

fn source_build_toolchain_error(backend: &str) -> Option<AppError> {
    if let Some(error) =
        source_build_platform_error(backend, std::env::consts::OS, std::env::consts::ARCH)
    {
        return Some(error);
    }
    let executable = |name: &str| locate_tool(name).is_some();
    let rocm_sdk_present = rocm_sdk_is_configured();
    let directory_variable = |name: &str| {
        if matches!(name, "HIP_PATH" | "ROCM_PATH") {
            rocm_sdk_present
        } else {
            std::env::var_os(name)
                .map(|value| Path::new(&value).is_dir())
                .unwrap_or(false)
        }
    };
    if let Some(error) = missing_source_build_toolchain(
        backend,
        &ToolchainView {
            executable: &executable,
            directory_variable: &directory_variable,
        },
    ) {
        return Some(error);
    }
    #[cfg(windows)]
    if locate_msvc_crt_directory().is_none() {
        return Some(AppError::unavailable(
            "a Windows PR build needs the MSVC C/C++ runtime redistributable so the finished llama-server can run on a PC without Visual Studio. Install Visual Studio Build Tools with the Desktop development with C++ workload and its redistributable component, then try again.",
        ));
    }
    #[cfg(windows)]
    if backend == "rocm" && !windows_clang_link_environment_ready() {
        return Some(AppError::unavailable(
            "the Windows ROCm build also needs the Windows SDK import and library paths. Install the Windows 10/11 SDK through Visual Studio Build Tools with the Desktop development with C++ workload, then try again. aiolm does not need a Developer Command Prompt; it loads the paths automatically when the SDK is installed.",
        ));
    }
    #[cfg(windows)]
    if backend == "rocm" && locate_ninja().is_none() {
        return Some(AppError::not_found(
            "a Windows ROCm PR build needs Ninja because llama.cpp's HIP sources must be compiled with the ROCm clang toolchain. Install Ninja (or the CMake tools component in Visual Studio Build Tools) and put ninja.exe on PATH, then try again.",
        ));
    }
    None
}

#[cfg(windows)]
fn windows_clang_link_environment_ready() -> bool {
    let Some(cl) = locate_tool("cl") else {
        return false;
    };
    let mut environment = build_environment();
    merge_visual_studio_environment(&mut environment, &cl, None);
    let has_directory = |name: &str| {
        environment_value(&environment, name)
            .map(|value| std::env::split_paths(&value).any(|path| path.is_dir()))
            .unwrap_or(false)
    };
    let has_windows_library = environment_value(&environment, "LIB")
        .map(|value| std::env::split_paths(&value).any(|path| path.join("kernel32.lib").is_file()))
        .unwrap_or(false);
    has_directory("INCLUDE") && has_windows_library
}
