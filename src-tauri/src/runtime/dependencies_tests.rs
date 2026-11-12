use super::*;

#[test]
fn msvc_runtime_names_reject_debug_clr_and_prefix_lookalikes() {
    for name in [
        "msvcp140.dll",
        "MSVCP140_1.DLL",
        "msvcp140_2.dll",
        "msvcp140_atomic_wait.dll",
        "msvcp140_codecvt_ids.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "vcruntime140_threads.dll",
        "vccorlib140.dll",
        "concrt140.dll",
        "vcomp140.dll",
    ] {
        assert!(is_msvc_runtime_library_name(name), "retail DLL: {name}");
    }
    for name in [
        "msvcp140d.dll",
        "msvcp140_1d.dll",
        "msvcp140d_atomic_wait.dll",
        "vcruntime140d.dll",
        "vcruntime140_1d.dll",
        "vcruntime140_threadsd.dll",
        "concrt140d.dll",
        "vcomp140d.dll",
        "vccorlib140d.dll",
        "msvcp140_clr0400.dll",
        "vcruntime140_clr0400.dll",
        "msvcp140_fake.dll",
        "msvcp140.dll.exe",
        "kernel32.dll",
    ] {
        assert!(
            !is_msvc_runtime_library_name(name),
            "non-retail DLL: {name}"
        );
    }
}

#[cfg(windows)]
#[test]
fn msvc_runtime_copy_uses_retail_files_without_capturing_developer_utilities() {
    let root = test_directory("msvc-retail-copy");
    let system = root.join("System32");
    let debug = root.join("debug_nonredist").join("x64");
    let destination = root.join("destination");
    for directory in [&system, &debug, &destination] {
        fs::create_dir_all(directory).unwrap();
    }
    for name in [
        "msvcp140.dll",
        "vcruntime140.dll",
        "vccorlib140.dll",
        "vcomp140.dll",
    ] {
        fs::write(system.join(name), b"synthetic retail DLL").unwrap();
        fs::write(debug.join(name), b"synthetic developer utility").unwrap();
    }
    for name in ["msvcp140d.dll", "vcruntime140_clr0400.dll", "kernel32.dll"] {
        fs::write(system.join(name), b"synthetic non-runtime file").unwrap();
    }
    let cancel = Arc::new(AtomicBool::new(false));
    copy_msvc_runtime_dependencies_from_sources(&destination, &cancel, &[debug, system.clone()])
        .unwrap();
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 4);
    assert_eq!(
        fs::read(destination.join("msvcp140.dll")).unwrap(),
        b"synthetic retail DLL"
    );
    assert!(system.join("msvcp140d.dll").is_file());
    assert!(!destination.join("msvcp140d.dll").exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn msvc_runtime_export_refuses_existing_non_retail_files_without_removing_them() {
    let root = test_directory("msvc-non-retail-input");
    fs::create_dir_all(&root).unwrap();
    let file = root.join("vcruntime140d.dll");
    fs::write(&file, b"synthetic original dependency").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let error = copy_msvc_runtime_dependencies_from_sources(&root, &cancel, &[]).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(error.message.contains("non-retail MSVC library"), "{error}");
    assert_eq!(fs::read(&file).unwrap(), b"synthetic original dependency");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn vendor_runtime_packaging_matches_sdk_libraries_but_not_host_drivers() {
    for name in ["cudart64_12.dll", "libcublas.so.12.4", "libnvJitLink.so.12"] {
        assert!(is_backend_runtime_library("cuda", name), "{name}");
    }
    for name in [
        "amdhip64.dll",
        "librocblas.so.4",
        "hipblaslt.dll",
        "libhsa-runtime64.so.1",
        "rocm_kpack.dll",
        "librocm_kpack.so.1",
        "libtensilelite-host.dll",
        "origami.dll",
    ] {
        assert!(is_backend_runtime_library("rocm", name), "{name}");
    }
    for name in [
        "nvcuda.dll",
        "libcuda.so.1",
        "libamdvlk64.so",
        "libdrm_amdgpu.so.1",
    ] {
        assert!(!is_backend_runtime_library("cuda", name), "{name}");
        assert!(!is_backend_runtime_library("rocm", name), "{name}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn linux_rocm_bundle_preserves_elf_dependencies_and_repairs_incomplete_bundles() {
    let root = test_directory("linux-rocm-elf-dependencies");
    let sdk = root.join("sdk");
    let bundle = root.join("bundle");
    fs::create_dir_all(sdk.join("lib/rocblas/library")).unwrap();
    fs::create_dir_all(sdk.join("lib/hipblaslt/library")).unwrap();
    fs::create_dir_all(sdk.join("lib/rocm_sysdeps/lib")).unwrap();
    fs::create_dir_all(sdk.join("lib/llvm/lib")).unwrap();
    fs::create_dir_all(&bundle).unwrap();
    for (name, needed) in [
        (
            "libamdhip64.so.7",
            vec!["libamd_comgr.so.3", "libhsa-runtime64.so.1"],
        ),
        (
            "libamd_comgr.so.3",
            vec!["libclang-cpp.so.23", "libLLVM.so.23"],
        ),
        (
            "libhsa-runtime64.so.1",
            vec!["librocm_sysdeps_drm_amdgpu.so.1"],
        ),
        ("libhipblas.so.3", vec!["librocblas.so.5"]),
        (
            "librocblas.so.5",
            vec!["libhipblaslt.so.1", "libroctx64.so.4"],
        ),
        ("libhipblaslt.so.1", vec!["librocroller.so.1"]),
        ("libroctx64.so.4", vec!["libc.so.6"]),
        ("librocroller.so.1", vec!["librocm_sysdeps_z.so.1"]),
        ("rocm_sysdeps/lib/librocm_sysdeps_z.so.1", vec!["libc.so.6"]),
        (
            "rocm_sysdeps/lib/librocm_sysdeps_drm_amdgpu.so.1",
            vec!["libc.so.6"],
        ),
        ("llvm/lib/libclang-cpp.so.23", vec!["libLLVM.so.23"]),
        ("llvm/lib/libLLVM.so.23", vec!["librocm_sysdeps_z.so.1"]),
    ] {
        fs::write(sdk.join("lib").join(name), elf::fixture(&needed)).unwrap();
    }
    for name in ["rocblas", "hipblaslt"] {
        fs::write(
            sdk.join("lib").join(name).join("library/kernels.dat"),
            b"kernels",
        )
        .unwrap();
    }
    for name in ["libcuda.so.1", "libamdvlk64.so", "libdrm_amdgpu.so.1"] {
        fs::write(sdk.join("lib").join(name), b"host driver").unwrap();
    }
    fs::write(
        sdk.join("lib/llvm/lib/libLLVM.a"),
        b"static compiler archive",
    )
    .unwrap();
    fs::write(
        bundle.join("libggml-hip.so"),
        elf::fixture(&["libhipblas.so.3", "libamdhip64.so.7"]),
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    copy_backend_runtime_dependencies_from_roots(
        "rocm",
        &bundle,
        &cancel,
        std::slice::from_ref(&sdk),
    )
    .unwrap();
    assert!(rocm_runtime_dependencies_complete(&bundle));
    assert!(bundle
        .join("rocm_sysdeps/lib/librocm_sysdeps_z.so.1")
        .is_file());
    assert!(bundle.join("llvm/lib/libLLVM.so.23").is_file());
    for name in [
        "libcuda.so.1",
        "libamdvlk64.so",
        "libdrm_amdgpu.so.1",
        "llvm/lib/libLLVM.a",
    ] {
        assert!(!bundle.join(name).exists(), "{name}");
    }
    // Complete bundles need no SDK, including when another SDK is selected.
    copy_backend_runtime_dependencies_from_roots("rocm", &bundle, &cancel, &[]).unwrap();
    let other_sdk = root.join("other-sdk");
    fs::create_dir_all(other_sdk.join("lib")).unwrap();
    fs::write(other_sdk.join("lib/libamdhip64.so.7"), b"incompatible HIP").unwrap();
    copy_backend_runtime_dependencies_from_roots("rocm", &bundle, &cancel, &[other_sdk]).unwrap();
    // HIP and BLAS alone must not hide a missing transitive SONAME.
    fs::remove_file(bundle.join("llvm/lib/libLLVM.so.23")).unwrap();
    assert!(!rocm_runtime_dependencies_complete(&bundle));
    copy_backend_runtime_dependencies_from_roots(
        "rocm",
        &bundle,
        &cancel,
        std::slice::from_ref(&sdk),
    )
    .unwrap();
    assert!(rocm_runtime_dependencies_complete(&bundle));
    // Existing nested libraries retain the same SDK mismatch protection.
    fs::remove_file(bundle.join("libroctx64.so.4")).unwrap();
    fs::write(
        bundle.join("llvm/lib/libLLVM.so.23"),
        b"different compiler runtime",
    )
    .unwrap();
    let error =
        copy_backend_runtime_dependencies_from_roots("rocm", &bundle, &cancel, &[sdk]).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(
        error.message.contains("do not match the configured SDK"),
        "{error}"
    );
    assert_eq!(
        fs::read(bundle.join("llvm/lib/libLLVM.so.23")).unwrap(),
        b"different compiler runtime"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn older_rocm_bundles_do_not_require_unused_modern_sdk_libraries() {
    let root = test_directory("older-rocm-dependencies");
    fs::create_dir_all(&root).unwrap();
    for name in ["libamdhip64.so.6", "libhipblas.so.2"] {
        fs::write(root.join(name), elf::fixture(&["libc.so.6"])).unwrap();
    }
    assert!(rocm_runtime_dependencies_complete(&root));
    copy_backend_runtime_dependencies_from_roots(
        "rocm",
        &root,
        &Arc::new(AtomicBool::new(false)),
        &[],
    )
    .unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rocm_bundle_keeps_architecture_data_and_transitive_libraries() {
    let root = test_directory("rocm-sdk-layout");
    let sdk = root.join("sdk");
    let other_sdk = root.join("other-sdk");
    let bundle = root.join("bundle");
    fs::create_dir_all(sdk.join("bin/hipblaslt/library/gfx1201")).unwrap();
    fs::create_dir_all(other_sdk.join("bin/hipblaslt/library/gfx1201")).unwrap();
    fs::create_dir_all(sdk.join(".kpack")).unwrap();
    fs::create_dir_all(sdk.join("share/doc/hip")).unwrap();
    fs::create_dir_all(sdk.join("share/therock")).unwrap();
    fs::create_dir_all(&bundle).unwrap();
    for name in [
        "amdhip64_7.dll",
        "amd_comgr.dll",
        "hipblas.dll",
        "libhipblaslt.dll",
        "libtensilelite-host.dll",
        "origami.dll",
        "rocm_kpack.dll",
    ] {
        fs::write(sdk.join("bin").join(name), name).unwrap();
        fs::write(other_sdk.join("bin").join(name), name).unwrap();
    }
    fs::write(
        sdk.join("bin/hipblaslt/library/gfx1201/TensileLibrary.dat"),
        b"kernel data",
    )
    .unwrap();
    fs::write(sdk.join(".kpack/blas_gfx1201.kpack"), b"packed kernels").unwrap();
    fs::write(sdk.join("share/doc/hip/LICENSE"), b"synthetic notice").unwrap();
    fs::write(sdk.join("share/therock/therock_manifest.json"), b"{}").unwrap();
    fs::write(
        other_sdk.join("bin/hipblaslt/library/gfx1201/TensileLibrary.dat"),
        b"different SDK",
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    copy_backend_runtime_dependencies_from_roots(
        "rocm",
        &bundle,
        &cancel,
        &[sdk.clone(), other_sdk],
    )
    .unwrap();
    assert!(rocm_runtime_dependencies_complete(&bundle));
    for name in [
        "rocm_kpack.dll",
        "libtensilelite-host.dll",
        "origami.dll",
        ".kpack/blas_gfx1201.kpack",
        "share/doc/hip/LICENSE",
        "share/therock/therock_manifest.json",
    ] {
        assert!(bundle.join(name).is_file(), "{name}");
    }
    assert_eq!(
        fs::read(bundle.join("hipblaslt/library/gfx1201/TensileLibrary.dat")).unwrap(),
        b"kernel data"
    );
    // A complete modern bundle remains portable without the original SDK.
    copy_backend_runtime_dependencies_from_roots("rocm", &bundle, &cancel, &[]).unwrap();
    fs::remove_file(bundle.join("hipblaslt/library/gfx1201/TensileLibrary.dat")).unwrap();
    assert!(!rocm_runtime_dependencies_complete(&bundle));
    fs::write(bundle.join("amdhip64_7.dll"), b"different HIP runtime").unwrap();
    let error =
        copy_backend_runtime_dependencies_from_roots("rocm", &bundle, &cancel, &[sdk]).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(
        error.message.contains("do not match the configured SDK"),
        "{error}"
    );
    assert_eq!(
        fs::read(bundle.join("amdhip64_7.dll")).unwrap(),
        b"different HIP runtime"
    );
    assert!(!bundle
        .join("hipblaslt/library/gfx1201/TensileLibrary.dat")
        .exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_vendor_sdk_keeps_unavailable_dependency_errors() {
    let root = test_directory("missing-vendor-sdk");
    fs::create_dir_all(&root).unwrap();
    let error = copy_backend_runtime_dependencies_from_roots(
        "cuda",
        &root,
        &Arc::new(AtomicBool::new(false)),
        &[],
    )
    .unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Unavailable);
    assert!(error
        .message
        .contains("could not package the cuda runtime libraries"));
    fs::remove_dir_all(root).unwrap();
}
