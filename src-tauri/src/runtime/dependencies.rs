use super::*;

/// Complete an already-installed vendor runtime from a compatible local SDK.
/// Release archives for Windows ROCm may intentionally omit BLAS DLLs and
/// kernel data, while aiolm requires managed runtimes to remain usable
/// after the launching shell (and its SDK PATH) disappears.
pub async fn repair_runtime_dependencies(
    backend: &str,
    build: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), AppError> {
    if !matches!(backend, "cuda" | "rocm") {
        return Ok(());
    }
    let destination = runtime_dir(backend, build)?;
    let backend = backend.to_string();
    tokio::task::spawn_blocking(move || {
        copy_backend_runtime_dependencies(&backend, &destination, &cancel)
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                crate::error::ErrorKind::Cancelled
            } else {
                crate::error::ErrorKind::Internal
            },
            format!("runtime dependency repair task failed: {error}"),
        )
    })?
}

#[cfg(windows)]
fn msvc_runtime_directory_has_dll(directory: &Path, expected: &str) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name == expected {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn msvc_crt_has_required_files(directory: &Path) -> bool {
    msvc_runtime_directory_has_dll(directory, "msvcp140.dll")
        && msvc_runtime_directory_has_dll(directory, "vcruntime140.dll")
}

#[cfg(windows)]
fn msvc_openmp_has_required_files(directory: &Path) -> bool {
    msvc_runtime_directory_has_dll(directory, "vcomp140.dll")
}

#[cfg(any(windows, test))]
pub(super) fn is_msvc_runtime_library_name(name: &str) -> bool {
    // Prefix matching also selects DebugCRT and CLR-specific libraries from
    // a developer's System32. Only the retail C/C++ and OpenMP runtime belongs
    // in a portable inference bundle (VS 2022's redistributable file set).
    matches!(
        name.to_ascii_lowercase().as_str(),
        "concrt140.dll"
            | "msvcp140.dll"
            | "msvcp140_1.dll"
            | "msvcp140_2.dll"
            | "msvcp140_atomic_wait.dll"
            | "msvcp140_codecvt_ids.dll"
            | "vccorlib140.dll"
            | "vcruntime140.dll"
            | "vcruntime140_1.dll"
            | "vcruntime140_threads.dll"
            | "vcomp140.dll"
    )
}

#[cfg(windows)]
fn msvc_runtime_directory_is_candidate(directory: &Path) -> bool {
    msvc_crt_has_required_files(directory) || msvc_openmp_has_required_files(directory)
}

#[cfg(windows)]
fn path_has_directory(path: &Path, expected: &str) -> bool {
    path.ancestors().any(|ancestor| {
        ancestor
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(expected))
    })
}

#[cfg(windows)]
fn find_msvc_runtime_directories(
    root: &Path,
    architecture: &str,
    depth: u32,
    matches: &mut Vec<PathBuf>,
) {
    if depth > 5 || !root.is_dir() {
        return;
    }
    if path_has_directory(root, architecture) && msvc_runtime_directory_is_candidate(root) {
        matches.push(root.to_path_buf());
    }
    let mut directories = fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            (metadata.is_dir() && !metadata.file_type().is_symlink()).then_some(path)
        })
        .collect::<Vec<_>>();
    directories.sort();
    for directory in directories {
        find_msvc_runtime_directories(&directory, architecture, depth + 1, matches);
    }
}

#[cfg(windows)]
fn locate_msvc_runtime_directories() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = std::env::var_os("VCToolsRedistDir").map(PathBuf::from) {
        roots.push(root);
    }
    if let Some(cl) = locate_tool("cl") {
        if let Some(vc_root) = cl.ancestors().find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("VC"))
        }) {
            roots.push(vc_root.join("Redist").join("MSVC"));
        }
    }
    roots.dedup();
    let mut directories = Vec::new();
    for root in roots {
        find_msvc_runtime_directories(&root, bundle_architecture(), 0, &mut directories);
    }
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        let system32 = PathBuf::from(system_root).join("System32");
        if msvc_runtime_directory_is_candidate(&system32) {
            directories.push(system32);
        }
    }
    directories.sort_by(|left, right| right.cmp(left));
    directories.dedup();
    directories
}

#[cfg(windows)]
pub(super) fn locate_msvc_crt_directory() -> Option<PathBuf> {
    locate_msvc_runtime_directories()
        .into_iter()
        .find(|directory| msvc_crt_has_required_files(directory))
}

/// MSVC's import libraries are needed to build, but its CRT DLLs are not
/// copied beside a normal CMake target. Include the redistributable beside
/// every Windows bundle so a fresh PC does not need the VC++ Redistributable
/// installer just to start llama-server.
#[cfg(windows)]
pub(super) fn copy_msvc_runtime_dependencies(
    destination: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    copy_msvc_runtime_dependencies_from_sources(
        destination,
        cancel,
        &locate_msvc_runtime_directories(),
    )
}

#[cfg(windows)]
pub(super) fn copy_msvc_runtime_dependencies_from_sources(
    destination: &Path,
    cancel: &Arc<AtomicBool>,
    sources: &[PathBuf],
) -> Result<(), AppError> {
    // Do not silently strip an existing runtime's dependencies or export a
    // bundle contaminated by an earlier permissive copy. The source runtime
    // stays untouched; export's owned snapshot is discarded on error.
    for entry in fs::read_dir(destination).map_err(|error| AppError::from_io(&error))? {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".dll")
            && [
                "msvcp140",
                "vcruntime140",
                "vccorlib140",
                "vcomp140",
                "concrt140",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
            && !is_msvc_runtime_library_name(&name)
        {
            return Err(AppError::validation(format!("runtime contains a non-retail MSVC library ({name}); rebuild with the retail redistributable before exporting")));
        }
    }
    if sources.is_empty() && msvc_crt_has_required_files(destination) {
        return Ok(());
    }
    if sources.is_empty() {
        return Err(
            AppError::unavailable("could not locate the MSVC C/C++ runtime redistributable. Install the Visual Studio C++ workload with its redistributable component, then rebuild the PR runtime."),
        );
    }
    for source in sources {
        let entries = fs::read_dir(source).map_err(|error| AppError::from_io(&error))?;
        for entry in entries {
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::cancelled("runtime install cancelled"));
            }
            let entry = entry.map_err(|error| AppError::from_io(&error))?;
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|error| AppError::from_io(&error))?;
            let is_dll = path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"));
            if !metadata.is_file() || metadata.file_type().is_symlink() || !is_dll {
                continue;
            }
            if path_has_directory(source, "debug_nonredist")
                || !is_msvc_runtime_library_name(&entry.file_name().to_string_lossy())
            {
                continue;
            }
            let target = destination.join(entry.file_name());
            if target.exists() {
                continue;
            }
            fs::copy(&path, &target).map_err(|error| {
                AppError::new(
                    AppError::io_kind(&error),
                    format!(
                        "failed to package the MSVC runtime library {}: {error}",
                        path.display()
                    ),
                )
            })?;
        }
    }
    if !msvc_crt_has_required_files(destination) {
        return Err(AppError::unavailable("the MSVC redistributable directory contained no usable runtime DLLs; the PR was not activated."));
    }
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn copy_msvc_runtime_dependencies(
    _destination: &Path,
    _cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    Ok(())
}

fn backend_sdk_roots(backend: &str) -> Vec<PathBuf> {
    let variables: &[&str] = match backend {
        "cuda" => &["CUDA_PATH", "CUDA_HOME", "CUDA_TOOLKIT_ROOT_DIR"],
        "rocm" => &["HIP_PATH", "ROCM_PATH"],
        _ => &[],
    };
    let mut roots = Vec::new();
    for variable in variables {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            if root.is_dir() && !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    let compiler_root = match backend {
        "cuda" => sdk_root_from_tool("nvcc"),
        "rocm" => sdk_root_from_tool("hipcc"),
        _ => None,
    };
    if let Some(root) = compiler_root.filter(|root| root.is_dir()) {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

pub(super) fn is_backend_runtime_library(backend: &str, file_name: &str) -> bool {
    let name = file_name.to_ascii_lowercase();
    let dynamic = name.ends_with(".dll")
        || name.contains(".so.")
        || name.ends_with(".so")
        || name.ends_with(".dylib");
    if !dynamic {
        return false;
    }
    // The Linux SDK's HIP/BLAS libraries also depend on relocated compiler
    // libraries and its private, namespaced system dependencies. Host driver
    // libraries (libcuda/libamdvlk/libdrm_amdgpu) are deliberately excluded.
    if cfg!(target_os = "linux")
        && backend == "rocm"
        && [
            "libroctx64.so",
            "librocroller.so",
            "librocm_sysdeps_",
            "libclang-cpp.so",
            "libllvm.so",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        return true;
    }
    let prefixes: &[&str] = match backend {
        "cuda" => &[
            "cudart",
            "libcudart",
            "cublas",
            "libcublas",
            "nvrtc",
            "libnvrtc",
            "nvjitlink",
            "libnvjitlink",
            "nvfatbin",
            "libnvfatbin",
            "nvblas",
            "libnvblas",
        ],
        "rocm" => &[
            "amdhip64",
            "libamdhip64",
            "hiprtc",
            "libhiprtc",
            "hipblas",
            "libhipblas",
            "hipblaslt",
            "libhipblaslt",
            "rocblas",
            "librocblas",
            "rocsolver",
            "librocsolver",
            "hsa-runtime64",
            "libhsa-runtime64",
            "amd_comgr",
            "libamd_comgr",
            "rocprofiler-register",
            "librocprofiler-register",
            "rocm_kpack",
            "librocm_kpack",
            "tensilelite-host",
            "libtensilelite-host",
            "origami",
            "liborigami",
        ],
        _ => &[],
    };
    prefixes.iter().any(|prefix| name.starts_with(prefix))
}

pub(super) fn directory_has_files(directory: &Path) -> bool {
    fs::read_dir(directory)
        .map(|entries| {
            entries.flatten().any(|entry| {
                fs::symlink_metadata(entry.path())
                    .map(|metadata| metadata.is_file())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub(super) fn has_gpu_architecture_directories(directory: &Path) -> bool {
    gpu_architecture_directories(directory).next().is_some()
}

fn gpu_architecture_directories(directory: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let architecture = name.strip_prefix("gfx")?;
            (!architecture.is_empty()
                && architecture.chars().all(|c| c.is_ascii_alphanumeric())
                && entry.file_type().ok()?.is_dir())
            .then(|| entry.path())
        })
}

fn blas_library_has_data(directory: &Path) -> bool {
    directory_has_files(directory)
        || gpu_architecture_directories(directory).any(|path| directory_has_files(&path))
}

fn directory_has_named_runtime_library(destination: &Path, prefix: &str) -> bool {
    fs::read_dir(destination)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                    return false;
                };
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return false;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                let name = name.strip_prefix("lib").unwrap_or(&name);
                name.starts_with(prefix)
            })
        })
        .unwrap_or(false)
}

pub(super) fn rocm_runtime_dependencies_complete(destination: &Path) -> bool {
    if !directory_has_named_runtime_library(destination, "amdhip64")
        || (!directory_has_named_runtime_library(destination, "hipblas")
            && !directory_has_named_runtime_library(destination, "rocblas"))
    {
        return false;
    }
    let rocblas_ok = !directory_has_named_runtime_library(destination, "rocblas")
        || blas_library_has_data(&destination.join("rocblas").join("library"));
    let hipblaslt_ok = !directory_has_named_runtime_library(destination, "hipblaslt")
        || blas_library_has_data(&destination.join("hipblaslt").join("library"));
    rocblas_ok && hipblaslt_ok && rocm_shared_library_dependencies(destination).is_ok()
}

/// Check only redistributable ROCm dependencies, not libraries supplied by the
/// operating system or GPU driver. Actual ELF dependency names avoid requiring
/// newer SDK libraries in older bundles that never used them.
#[cfg(target_os = "linux")]
fn rocm_shared_library_dependencies(destination: &Path) -> Result<(), AppError> {
    let directories = ["", "rocm_sysdeps/lib", "llvm/lib"];
    let mut libraries = HashMap::new();
    for relative in directories {
        let Ok(entries) = fs::read_dir(destination.join(relative)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && (is_backend_runtime_library("rocm", &name) || name == "libggml-hip.so")
            {
                libraries.insert(entry.file_name(), entry.path());
            }
        }
    }
    for path in libraries.values() {
        let needed = elf::needed_libraries(path).map_err(|error| {
            AppError::validation(format!("could not inspect {}: {error}", path.display()))
        })?;
        for name in needed {
            if is_backend_runtime_library("rocm", &name)
                && !libraries.contains_key(OsStr::new(&name))
            {
                return Err(AppError::unavailable(format!(
                    "{} requires missing packaged library {name}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                )));
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn rocm_shared_library_dependencies(_destination: &Path) -> Result<(), AppError> {
    Ok(())
}

pub(super) fn backend_runtime_dependencies_complete(backend: &str, destination: &Path) -> bool {
    match backend {
        "rocm" => rocm_runtime_dependencies_complete(destination),
        "cuda" => {
            directory_has_named_runtime_library(destination, "cudart")
                && directory_has_named_runtime_library(destination, "cublas")
        }
        _ => true,
    }
}

fn count_files_recursive(directory: &Path) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries.flatten().fold(0, |count, entry| {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            return count;
        };
        if metadata.is_dir() {
            count.saturating_add(count_files_recursive(&path))
        } else if metadata.is_file() {
            count.saturating_add(1)
        } else {
            count
        }
    })
}

/// Copy redistributable vendor runtime libraries beside the PR binaries. The
/// build output's backend plugin is not enough: CUDA/HIP shared libraries are
/// supplied by their SDK and are otherwise found only on the build machine.
/// The host GPU driver is intentionally excluded because it is supplied by
/// the operating system and cannot safely be redistributed.
pub(super) fn copy_backend_runtime_dependencies(
    backend: &str,
    destination: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    copy_backend_runtime_dependencies_from_roots(
        backend,
        destination,
        cancel,
        &backend_sdk_roots(backend),
    )
}

pub(super) fn copy_backend_runtime_dependencies_from_roots(
    backend: &str,
    destination: &Path,
    cancel: &Arc<AtomicBool>,
    roots: &[PathBuf],
) -> Result<(), AppError> {
    if !matches!(backend, "cuda" | "rocm") {
        return Ok(());
    }
    // Exporting an already-portable runtime on a PC that no longer has the
    // original SDK should still work. Source builds take the other path below
    // because their destination does not yet contain the required libraries.
    if backend_runtime_dependencies_complete(backend, destination) {
        return Ok(());
    }
    let mut found = 0_usize;
    let mut found_data = 0_usize;
    for root in roots {
        if cfg!(windows)
            && backend == "rocm"
            && !["bin", "lib", "lib64", "lib/x64"]
                .iter()
                .any(|relative| rocm_runtime_dependencies_complete(&root.join(relative)))
        {
            continue;
        }
        let mut library_directories =
            vec![("bin", ""), ("lib", ""), ("lib64", ""), ("lib/x64", "")];
        if cfg!(target_os = "linux") && backend == "rocm" {
            library_directories.extend([
                ("lib/rocm_sysdeps/lib", "rocm_sysdeps/lib"),
                ("lib64/rocm_sysdeps/lib", "rocm_sysdeps/lib"),
                ("lib/llvm/lib", "llvm/lib"),
                ("lib64/llvm/lib", "llvm/lib"),
            ]);
        }
        for (relative, target_relative) in library_directories {
            let directory = root.join(relative);
            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if cancel.load(Ordering::Acquire) {
                    return Err(AppError::cancelled("runtime install cancelled"));
                }
                let path = entry.path();
                let Ok(metadata) = fs::metadata(&path) else {
                    continue;
                };
                if !metadata.is_file()
                    || !is_backend_runtime_library(backend, &entry.file_name().to_string_lossy())
                {
                    continue;
                }
                let sdk_root = fs::canonicalize(root).map_err(|error| AppError::from_io(&error))?;
                let resolved =
                    fs::canonicalize(&path).map_err(|error| AppError::from_io(&error))?;
                if !resolved.starts_with(&sdk_root) {
                    return Err(AppError::validation(
                        "runtime SDK library link escapes the configured SDK",
                    ));
                }
                found += 1;
                let target_directory = destination.join(target_relative);
                let target = target_directory.join(entry.file_name());
                if target.exists() {
                    if backend == "rocm" && sha256_file(&target)? != sha256_file(&path)? {
                        return Err(AppError::validation("the installed ROCm libraries do not match the configured SDK. Import a complete runtime bundle built with that SDK instead of mixing vendor libraries."));
                    }
                    continue;
                }
                fs::create_dir_all(&target_directory).map_err(|error| AppError::from_io(&error))?;
                fs::copy(&path, &target).map_err(|error| {
                    AppError::new(
                        AppError::io_kind(&error),
                        format!(
                            "failed to package the {backend} runtime library {}: {error}",
                            path.display()
                        ),
                    )
                })?;
                #[cfg(unix)]
                fs::set_permissions(&target, metadata.permissions())
                    .map_err(|error| AppError::from_io(&error))?;
            }
        }
        if backend == "rocm" {
            for (relative, target_name) in [
                ("bin/rocblas", "rocblas"),
                ("lib/rocblas", "rocblas"),
                ("bin/hipblaslt", "hipblaslt"),
                ("lib/hipblaslt", "hipblaslt"),
                (".kpack", ".kpack"),
                ("share/therock", "share/therock"),
                ("share/doc", "share/doc"),
            ] {
                let source = root.join(relative);
                if !source.is_dir() {
                    continue;
                }
                let target = destination.join(target_name);
                copy_runtime_tree(&source, &target, cancel)?;
                found_data = found_data.saturating_add(count_files_recursive(&target));
            }
        }
        // Do not overwrite one complete SDK's kernel data with another SDK's
        // files merely because both SDK roots are configured on the host.
        if backend_runtime_dependencies_complete(backend, destination) {
            break;
        }
    }
    if found == 0 {
        return Err(AppError::unavailable(format!("could not package the {backend} runtime libraries from the installed SDK. Keep the SDK root configured (HIP_PATH/ROCM_PATH for ROCm, CUDA_PATH/CUDA_HOME for CUDA) and retry; the PR was not activated.")));
    }
    if backend == "rocm" && !rocm_runtime_dependencies_complete(destination) {
        rocm_shared_library_dependencies(destination)?;
        return Err(AppError::unavailable("could not package the ROCm rocblas/hipblaslt library data needed at runtime. The HIP SDK's bin/rocblas and bin/hipblaslt directories must be available; the PR was not activated."));
    }
    if backend == "rocm" && found_data == 0 {
        return Err(AppError::unavailable("the ROCm SDK exposed runtime DLLs but no rocblas/hipblaslt kernel data; the PR was not activated."));
    }
    Ok(())
}
