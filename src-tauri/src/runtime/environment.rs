use super::*;

/// Names every spawned child may inherit, on every platform: enough of the OS
/// for a process to start, find its temp directory, and format messages.
pub(super) const BASE_ENVIRONMENT: &[&str] =
    &["PATH", "HOME", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];

/// Windows needs considerably more than PATH before a process can start: the
/// CRT, the loader, and every SDK's CMake package resolve their own locations
/// through these. A build that inherits only PATH configures on the machine it
/// was developed on and fails on the next PC, which is the failure this list
/// exists to prevent.
#[cfg(windows)]
pub(super) const PLATFORM_ENVIRONMENT: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
    "OS",
];

#[cfg(target_os = "macos")]
pub(super) const PLATFORM_ENVIRONMENT: &[&str] = &[
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CACHE_HOME",
    "DYLD_FALLBACK_LIBRARY_PATH",
];

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) const PLATFORM_ENVIRONMENT: &[&str] = &[
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "LD_LIBRARY_PATH",
];

/// GPU-stack names a *runtime* child needs to enumerate and select a device.
pub(super) const RUNTIME_DEVICE_ENVIRONMENT: &[&str] = &[
    "VK_ICD_FILENAMES",
    "VK_DRIVER_FILES",
    "VK_LAYER_PATH",
    "VK_INSTANCE_LAYERS",
    "VK_ADD_LAYER_PATH",
    "VK_LOADER_DEBUG",
    "VK_LOADER_DRIVERS_SELECT",
    "DISABLE_LAYER_AMD_SWITCHABLE_GRAPHICS_1",
    "CUDA_VISIBLE_DEVICES",
    "CUDA_DEVICE_ORDER",
    "CUDA_PATH",
    "CUDA_MODULE_LOADING",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "HIP_PATH",
    "ROCM_PATH",
    "HSA_OVERRIDE_GFX_VERSION",
    "HSA_ENABLE_SDMA",
    "GPU_MAX_HW_QUEUES",
    "AMD_SERIALIZE_KERNEL",
    "HSA_XNACK",
    "ROCBLAS_TENSILE_LIBPATH",
    "HIPBLASLT_TENSILE_LIBPATH",
    "ROCM_KPACK_PATH",
    "ROCM_KPACK_PATH_PREFIX",
    "ONEAPI_DEVICE_SELECTOR",
    "SYCL_DEVICE_FILTER",
    "ZE_AFFINITY_MASK",
    "GGML_VK_VISIBLE_DEVICES",
    "GGML_CUDA_VISIBLE_DEVICES",
];

/// Toolchain roots. Every SDK below publishes its CMake package through one of
/// these, so dropping them turns a working machine into "SDK not found".
pub(super) const BUILD_TOOLCHAIN_ENVIRONMENT: &[&str] = &[
    "CUDA_PATH",
    "CUDA_HOME",
    "CUDA_TOOLKIT_ROOT_DIR",
    "CUDACXX",
    "CUDAHOSTCXX",
    "CUDAFLAGS",
    "NVCC_CCBIN",
    "HIPCXX",
    "HIPCC",
    "VULKAN_SDK",
    "VK_SDK_PATH",
    "HIP_PATH",
    "ROCM_PATH",
    "ONEAPI_ROOT",
    "VCPKG_ROOT",
    "VCPKG_DEFAULT_TRIPLET",
    "PKG_CONFIG_PATH",
    "PKG_CONFIG_LIBDIR",
];

/// CMake, the generator it picks, and the compiler driver underneath it.
pub(super) const BUILD_TOOLING_ENVIRONMENT: &[&str] = &[
    "CMAKE_PREFIX_PATH",
    "CMAKE_TOOLCHAIN_FILE",
    "CMAKE_GENERATOR",
    "CMAKE_GENERATOR_PLATFORM",
    "CMAKE_GENERATOR_TOOLSET",
    "CMAKE_GENERATOR_INSTANCE",
    "CMAKE_MAKE_PROGRAM",
    "CMAKE_BUILD_PARALLEL_LEVEL",
    "CMAKE_C_COMPILER_LAUNCHER",
    "CMAKE_CXX_COMPILER_LAUNCHER",
    "NINJA_STATUS",
    "MAKEFLAGS",
    "CC",
    "CXX",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
];

/// The compiler environment a Visual Studio developer prompt exports. CMake
/// finds MSVC through the registry on its own, but when aiolm itself was
/// launched from a developer prompt these describe the *selected* toolset, and
/// dropping half of them produces a configure that mixes two.
#[cfg(windows)]
pub(super) const BUILD_PLATFORM_ENVIRONMENT: &[&str] = &[
    "INCLUDE",
    "LIB",
    "LIBPATH",
    "VSINSTALLDIR",
    "VCINSTALLDIR",
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

/// Xcode's active toolchain and deployment target. Without `DEVELOPER_DIR` a
/// machine with more than one Xcode picks a different SDK than the user's own
/// terminal does.
#[cfg(target_os = "macos")]
pub(super) const BUILD_PLATFORM_ENVIRONMENT: &[&str] =
    &["DEVELOPER_DIR", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET"];

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) const BUILD_PLATFORM_ENVIRONMENT: &[&str] = &["LIBRARY_PATH", "CPATH", "C_INCLUDE_PATH"];

/// Proxy, TLS-trust and Git names.
///
/// A source build reaches the network - the source archive aside, CMake and
/// any generator step may resolve a dependency - and on a corporate PC that
/// only works through the configured proxy and the corporate CA bundle.
///
/// These are the one category here that can legitimately carry a credential: a
/// proxy URL of the form `http://user:password@proxy` puts one in
/// `HTTPS_PROXY`. That is the user's own proxy credential, it is passed only
/// to CMake and its generator, and without it the build cannot reach anything
/// at all. It is documented in docs/SECURITY.md rather than silently dropped.
pub(super) const BUILD_NETWORK_ENVIRONMENT: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "GIT_EXEC_PATH",
];

/// Collect the values of `names` that are actually set, in order, without
/// duplicating a name that appears in more than one category.
fn collect_environment(groups: &[&[&str]]) -> Vec<(OsString, OsString)> {
    let mut seen = std::collections::HashSet::new();
    let mut environment = Vec::new();
    for name in groups.iter().flat_map(|group| group.iter()) {
        if !seen.insert(*name) {
            continue;
        }
        if let Some(value) = std::env::var_os(name) {
            environment.push((OsString::from(*name), value));
        }
    }
    environment
}

pub fn child_environment() -> Vec<(OsString, OsString)> {
    collect_environment(&[
        BASE_ENVIRONMENT,
        PLATFORM_ENVIRONMENT,
        RUNTIME_DEVICE_ENVIRONMENT,
    ])
}

/// Environment names that can make a staged runtime appear healthy only
/// because the build machine happens to have an SDK on its PATH. The actual
/// installed runtime must resolve its redistributable libraries from the
/// runtime directory; GPU driver libraries remain a host prerequisite.
const STAGED_RUNTIME_HOST_ENVIRONMENT: &[&str] = &[
    "PATH",
    "CUDA_PATH",
    "CUDA_HOME",
    "CUDA_TOOLKIT_ROOT_DIR",
    "CUDACXX",
    "CUDAHOSTCXX",
    "VULKAN_SDK",
    "VK_SDK_PATH",
    "HIP_PATH",
    "ROCM_PATH",
    "ONEAPI_ROOT",
    "PKG_CONFIG_PATH",
    "PKG_CONFIG_LIBDIR",
    "CMAKE_PREFIX_PATH",
    "CMAKE_TOOLCHAIN_FILE",
    "ROCBLAS_TENSILE_LIBPATH",
    "HIPBLASLT_TENSILE_LIBPATH",
    "ROCM_KPACK_PATH",
    "ROCM_KPACK_PATH_PREFIX",
    "CC",
    "CXX",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
];

pub(super) fn staged_runtime_environment_from(
    environment: Vec<(OsString, OsString)>,
    staging: &Path,
) -> Vec<(OsString, OsString)> {
    let staging_path = staging;
    let mut environment = environment
        .into_iter()
        .filter(|(name, _)| {
            !name
                .to_str()
                .is_some_and(|name| STAGED_RUNTIME_HOST_ENVIRONMENT.contains(&name))
        })
        .collect::<Vec<_>>();
    let staging = staging.as_os_str().to_os_string();
    // Keep the loader's search path deliberately single-rooted. The executable
    // directory is searched independently on Windows, while Unix builds also
    // receive the corresponding loader variable below.
    environment.push((OsString::from("PATH"), staging.clone()));
    #[cfg(target_os = "macos")]
    environment.push((OsString::from("DYLD_LIBRARY_PATH"), staging.clone()));
    #[cfg(all(unix, not(target_os = "macos")))]
    environment.push((OsString::from("LD_LIBRARY_PATH"), staging));
    add_packaged_gpu_library_paths(&mut environment, staging_path);
    environment
}

pub(super) fn staged_runtime_environment(staging: &Path) -> Vec<(OsString, OsString)> {
    staged_runtime_environment_from(child_environment(), staging)
}

fn add_packaged_gpu_library_paths(environment: &mut Vec<(OsString, OsString)>, root: &Path) {
    let paths = [
        (
            "ROCBLAS_TENSILE_LIBPATH",
            root.join("rocblas").join("library"),
        ),
        (
            "HIPBLASLT_TENSILE_LIBPATH",
            root.join("hipblaslt").join("library"),
        ),
    ];
    for (name, path) in paths {
        // Newer BLAS libraries select an architecture subdirectory themselves.
        // Setting the legacy override to its parent disables that selection.
        if directory_has_files(&path) && !has_gpu_architecture_directories(&path) {
            set_environment_value(environment, name, path.into_os_string());
        }
    }
    // SDK DLLs move from bin/ to the managed runtime root. Their embedded
    // ../.kpack references must therefore resolve inside this same bundle.
    let mut archives = fs::read_dir(root.join(".kpack"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension() == Some(OsStr::new("kpack")))
        .collect::<Vec<_>>();
    archives.sort();
    if !archives.is_empty() {
        if let Ok(paths) = std::env::join_paths(archives) {
            set_environment_value(environment, "ROCM_KPACK_PATH", paths);
        }
    }
}

/// Runtime processes must not silently use a developer's installed SDK when a
/// portable bundle is being tested. Keep the normal OS/device environment,
/// replace PATH with the bundle directory, and point BLAS data loaders at
/// data copied into that directory.
pub fn child_environment_for_runtime(
    backend: &str,
    build: &str,
) -> Result<Vec<(OsString, OsString)>, String> {
    let root = runtime_dir(backend, build)?;
    let mut environment = child_environment();
    for name in [
        "CUDA_PATH",
        "CUDA_HOME",
        "CUDA_TOOLKIT_ROOT_DIR",
        "CUDACXX",
        "CUDAHOSTCXX",
        "VULKAN_SDK",
        "VK_SDK_PATH",
        "HIP_PATH",
        "ROCM_PATH",
        "ONEAPI_ROOT",
        "ROCBLAS_TENSILE_LIBPATH",
        "HIPBLASLT_TENSILE_LIBPATH",
        "ROCM_KPACK_PATH",
        "ROCM_KPACK_PATH_PREFIX",
    ] {
        environment.retain(|(key, _)| key != OsStr::new(name));
    }
    set_environment_value(&mut environment, "PATH", root.as_os_str().to_os_string());
    #[cfg(all(unix, not(target_os = "macos")))]
    set_environment_value(
        &mut environment,
        "LD_LIBRARY_PATH",
        root.as_os_str().to_os_string(),
    );
    #[cfg(target_os = "macos")]
    set_environment_value(
        &mut environment,
        "DYLD_LIBRARY_PATH",
        root.as_os_str().to_os_string(),
    );
    add_packaged_gpu_library_paths(&mut environment, &root);
    Ok(environment)
}

/// Keep the source-build environment small enough that a CMake configure does
/// not inherit credentials or unrelated application state, and large enough
/// that the same PR builds on someone else's PC.
pub(super) fn build_environment() -> Vec<(OsString, OsString)> {
    let mut environment = collect_environment(&[
        BASE_ENVIRONMENT,
        PLATFORM_ENVIRONMENT,
        BUILD_TOOLCHAIN_ENVIRONMENT,
        BUILD_TOOLING_ENVIRONMENT,
        BUILD_PLATFORM_ENVIRONMENT,
        BUILD_NETWORK_ENVIRONMENT,
    ]);
    environment.extend(build_environment_overrides());
    environment
}

/// Values the build child is *given* rather than allowed to inherit, because
/// each one closes a failure mode instead of carrying configuration.
pub(super) fn build_environment_overrides() -> Vec<(OsString, OsString)> {
    [
        // A Git or credential helper that stops to ask for a password would
        // hang forever behind a pipe no human can see. Make it fail instead.
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GCM_INTERACTIVE", "Never"),
        // Anything CMake downloads itself must still validate TLS, even if the
        // user's shell profile turned that off globally.
        ("CMAKE_TLS_VERIFY", "1"),
    ]
    .into_iter()
    .map(|(name, value)| (OsString::from(name), OsString::from(value)))
    .collect()
}

/// A source archive has no `.git`, so llama.cpp's build-info step runs
/// `git rev-parse`/`rev-list` and Git walks up the parent directories. When
/// the AioLM home lives inside another checkout (a development tree, a user's
/// own repository) that walk finds the enclosing repository and the built
/// server reports its commit and build count as its own. A ceiling at the
/// build workspace stops discovery there, so the engine reports no commit
/// rather than a foreign one. Both the given and the resolved spelling are
/// listed because Git compares ceilings after resolving drive aliases.
pub(super) fn with_git_ceiling(
    mut environment: Vec<(OsString, OsString)>,
    ceiling: &Path,
) -> Result<Vec<(OsString, OsString)>, String> {
    let mut entries = vec![ceiling.to_path_buf()];
    if let Ok(resolved) = ceiling.canonicalize() {
        let resolved = strip_verbatim_prefix(&resolved);
        if resolved != ceiling {
            entries.push(resolved);
        }
    }
    let joined = std::env::join_paths(&entries)
        .map_err(|error| format!("build workspace path cannot bound Git discovery: {error}"))?;
    set_environment_value(&mut environment, "GIT_CEILING_DIRECTORIES", joined);
    Ok(environment)
}

fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// llama.cpp's CMake keeps an explicitly defined `LLAMA_BUILD_COMMIT`, so the
/// built server reports the reviewed head instead of anything Git finds. Older
/// trees ignore the definition and report `unknown` behind the Git ceiling;
/// the build number stays the honest Git-less 0.
pub(super) fn reviewed_commit_define(commit: &str) -> Result<String, AppError> {
    validate_commit_sha(commit)?;
    Ok(format!(
        "-DLLAMA_BUILD_COMMIT={}",
        commit.to_ascii_lowercase()
    ))
}

/// A PR runtime's own `--version` must not name a commit other than the one
/// the user reviewed. An empty or `unknown` commit is accepted (an older tree
/// without the commit definition); anything else must be an abbreviated (at
/// least 7 hex digits) or full prefix of the reviewed head. The source
/// manifest records the reviewed head either way.
pub(super) fn reported_commit_matches_source(
    version: &RuntimeVersion,
    reviewed: &str,
) -> Result<(), AppError> {
    let reported = version.commit.trim().to_ascii_lowercase();
    let reviewed = reviewed.trim().to_ascii_lowercase();
    if reported.is_empty() || reported == "unknown" {
        return Ok(());
    }
    if reported.len() >= 7
        && reported.bytes().all(|byte| byte.is_ascii_hexdigit())
        && reviewed.starts_with(&reported)
    {
        return Ok(());
    }
    Err(AppError::validation(format!(
        "the built runtime reports commit {reported}, not the reviewed commit {reviewed}; the build read foreign Git metadata, so it was not activated"
    )))
}

/// Names that must never reach a child, whatever list they are added to.
///
/// The allowlists above already exclude everything by construction; this is
/// the assertion a future edit is checked against, so widening a category
/// cannot quietly hand a build a token.
#[cfg(test)]
pub(super) fn is_credential_name(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "SSH_AUTH_SOCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "NPM_TOKEN",
        "CARGO_REGISTRY_TOKEN",
    ];
    const FRAGMENTS: &[&str] = &[
        "token",
        "secret",
        "password",
        "passwd",
        "apikey",
        "api_key",
        "credential",
        "private_key",
    ];
    let lowered = name.to_ascii_lowercase();
    EXACT.iter().any(|exact| exact.eq_ignore_ascii_case(name))
        || FRAGMENTS.iter().any(|fragment| lowered.contains(fragment))
}

pub(super) fn build_environment_with_tool(tool: &Path) -> Vec<(OsString, OsString)> {
    let mut environment = build_environment();
    let Some(tool_dir) = tool.parent() else {
        return environment;
    };

    let existing_path = environment
        .iter()
        .find(|(key, _)| key == OsStr::new("PATH"))
        .map(|(_, value)| value.clone());
    let mut path_entries = vec![tool_dir.to_path_buf()];

    // Visual Studio ships Ninja beside its bundled CMake, while standalone
    // CMake distributions may put ninja.exe directly in the same bin folder.
    // Keep all known layouts in the child PATH so a GUI-launched app does not
    // need a developer prompt or a globally edited PATH.
    let mut ninja_dirs = vec![tool_dir.to_path_buf(), tool_dir.join("Ninja")];
    if let Some(parent) = tool_dir.parent() {
        ninja_dirs.push(parent.join("Ninja"));
        if let Some(grandparent) = parent.parent() {
            ninja_dirs.push(grandparent.join("Ninja"));
        }
    }
    for ninja_dir in ninja_dirs {
        if ninja_dir.is_dir() {
            path_entries.push(ninja_dir);
        }
    }
    // `cl.exe` is often found by the preflight through Visual Studio's
    // install tree rather than the user's PATH. Keep that same discovery
    // effective for CMake's compiler probe; a successful preflight must not
    // be followed by a configure that cannot launch the compiler.
    #[cfg(windows)]
    if let Some(compiler_dir) =
        locate_tool("cl").and_then(|path| path.parent().map(Path::to_path_buf))
    {
        path_entries.push(compiler_dir);
    }
    if let Some(existing_path) = existing_path {
        path_entries.extend(std::env::split_paths(&existing_path));
    }

    if let Ok(path) = std::env::join_paths(path_entries) {
        if let Some((_, value)) = environment
            .iter_mut()
            .find(|(key, _)| key == OsStr::new("PATH"))
        {
            *value = path;
        } else {
            environment.push((OsString::from("PATH"), path));
        }
    }
    environment
}

pub(super) fn set_environment_value(
    environment: &mut Vec<(OsString, OsString)>,
    name: &str,
    value: impl Into<OsString>,
) {
    let value = value.into();
    if let Some((_, current)) = environment
        .iter_mut()
        .find(|(key, _)| key == OsStr::new(name))
    {
        *current = value;
    } else {
        environment.push((OsString::from(name), value));
    }
}

pub(super) fn prepend_environment_paths(
    environment: &mut Vec<(OsString, OsString)>,
    prefixes: &[PathBuf],
) {
    let existing = environment
        .iter()
        .find(|(key, _)| key == OsStr::new("PATH"))
        .map(|(_, value)| value.clone());
    let mut paths = prefixes.to_vec();
    if let Some(existing) = existing {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        set_environment_value(environment, "PATH", path);
    }
}

/// Add the selected vendor SDK to the build child even when the user installed
/// it in a standard location that did not export its root variables. The
/// preflight and the packaging code use the same compiler-derived root, so the
/// compiler, CMake's package lookup, and staged sidecars cannot silently come
/// from three different SDK versions.
pub(super) fn build_environment_for_backend(
    tool: &Path,
    backend: &str,
    cancel: Option<&AtomicBool>,
) -> Vec<(OsString, OsString)> {
    let mut environment = build_environment_with_tool(tool);
    #[cfg(windows)]
    if let Some(cl) = locate_tool("cl") {
        merge_visual_studio_environment(&mut environment, &cl, cancel);
    }
    #[cfg(not(windows))]
    let _ = cancel;
    let (root, variable_names): (Option<PathBuf>, &[&str]) = match backend {
        "cuda" => (sdk_root_from_tool("nvcc"), &["CUDA_PATH", "CUDA_HOME"]),
        "rocm" => (sdk_root_from_tool("hipcc"), &["HIP_PATH", "ROCM_PATH"]),
        "vulkan" => (sdk_root_from_tool("glslc"), &["VULKAN_SDK"]),
        _ => (None, &[]),
    };
    let Some(root) = root else {
        return environment;
    };
    for variable in variable_names {
        if !environment
            .iter()
            .any(|(name, _)| name == OsStr::new(variable))
        {
            set_environment_value(&mut environment, variable, root.as_os_str().to_os_string());
        }
    }
    let mut path_prefixes = vec![root.join("bin")];
    if backend == "rocm" {
        path_prefixes.push(root.join("llvm").join("bin"));
        if let Some(hipcc) = locate_tool("hipcc") {
            if let Some(parent) = hipcc.parent() {
                path_prefixes.push(parent.to_path_buf());
            }
        }
        // Linux CMake uses HIPCXX when it enables the HIP language. Windows
        // uses clang++ as an ordinary C++ compiler instead (see the configure
        // arguments below), but setting this when available is harmless and
        // helps mixed ROCm toolchains choose the same compiler everywhere.
        let clangxx_name = format!("clang++{}", std::env::consts::EXE_SUFFIX);
        let clangxx_candidates = [
            root.join("llvm").join("bin").join(&clangxx_name),
            root.join("bin").join(&clangxx_name),
        ];
        if let Some(clangxx) = clangxx_candidates.into_iter().find(|path| path.is_file()) {
            set_environment_value(
                &mut environment,
                "HIPCXX",
                clangxx.as_os_str().to_os_string(),
            );
        }
        #[cfg(windows)]
        if let Some(ninja) = locate_ninja() {
            if let Some(parent) = ninja.parent() {
                path_prefixes.push(parent.to_path_buf());
            }
        }
    }
    path_prefixes.retain(|path| path.is_dir());
    prepend_environment_paths(&mut environment, &path_prefixes);
    environment
}
