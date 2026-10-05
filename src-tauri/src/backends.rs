//! Which llama.cpp runtime backends make sense on this device.
//!
//! A pure function of a [`DeviceProfile`] with no I/O, so it is cheap to test
//! and can later be superseded by a policy fetched from the benchmark service
//! without touching detection or the UI.

use serde::{Deserialize, Serialize};

use crate::hardware::{DeviceProfile, GpuVendor};
use crate::runtime::{catalog_supports, CATALOG_BACKENDS};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum BackendFit {
    /// Can drive the GPU that was actually detected. This is the only tier the
    /// runtime list shows by default.
    Recommended,
    /// Runs on this machine but not on its GPU — a CPU fallback, not a match.
    Compatible,
    /// The hardware this backend targets is not present at all.
    Unsupported,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BackendSuitability {
    pub backend: String,
    pub fit: BackendFit,
    /// Machine-readable justification; the UI localizes it.
    pub reason: String,
    /// Device that drove the verdict, when one did.
    pub device: Option<String>,
}

fn entry(
    backend: &str,
    fit: BackendFit,
    reason: &str,
    device: Option<String>,
) -> BackendSuitability {
    BackendSuitability {
        backend: backend.to_string(),
        fit,
        reason: reason.to_string(),
        device,
    }
}

fn device_name(profile: &DeviceProfile, vendor: GpuVendor) -> Option<String> {
    profile
        .gpus
        .iter()
        .filter(|gpu| gpu.vendor == vendor)
        .max_by_key(|gpu| (!gpu.integrated, gpu.vram_mb.unwrap_or(0)))
        .map(|gpu| gpu.name.clone())
}

pub fn recommend(profile: &DeviceProfile) -> Vec<BackendSuitability> {
    if !matches!(profile.arch.as_str(), "x86_64" | "aarch64") {
        return CATALOG_BACKENDS
            .iter()
            .map(|backend| entry(backend, BackendFit::Unsupported, "archNotSupported", None))
            .collect();
    }

    let nvidia = profile.has_vendor(GpuVendor::Nvidia);
    let amd_discrete = profile.has_discrete(GpuVendor::Amd);
    let amd_any = profile.has_vendor(GpuVendor::Amd);
    let intel = profile.has_vendor(GpuVendor::Intel);
    // Integrated parts still count here: Vulkan drives them, so a machine with
    // only an iGPU is not a "no GPU" machine.
    let has_gpu = profile
        .gpus
        .iter()
        .any(|gpu| gpu.vendor != GpuVendor::Unknown);

    let mut recommendations = vec![
        if profile.os == "macos"
            && profile.arch == "aarch64"
            && profile.has_vendor(GpuVendor::Apple)
        {
            entry(
                "metal",
                BackendFit::Recommended,
                "vendorMatch",
                device_name(profile, GpuVendor::Apple),
            )
        } else if profile.os == "macos" && has_gpu {
            // Metal drives the AMD, Intel or virtual GPU of an Intel Mac.
            entry(
                "metal",
                BackendFit::Recommended,
                "vendorMatch",
                profile.primary_gpu().map(|gpu| gpu.name.clone()),
            )
        } else {
            entry("metal", BackendFit::Unsupported, "osNotSupported", None)
        },
        if nvidia {
            entry(
                "cuda",
                BackendFit::Recommended,
                "vendorMatch",
                device_name(profile, GpuVendor::Nvidia),
            )
        } else {
            entry("cuda", BackendFit::Unsupported, "needsNvidia", None)
        },
        if amd_discrete {
            entry(
                "rocm",
                BackendFit::Recommended,
                "vendorMatch",
                device_name(profile, GpuVendor::Amd),
            )
        } else if amd_any {
            // ROCm's Windows support for integrated parts is inconsistent.
            entry(
                "rocm",
                BackendFit::Compatible,
                "integratedOnly",
                device_name(profile, GpuVendor::Amd),
            )
        } else {
            entry("rocm", BackendFit::Unsupported, "needsAmd", None)
        },
        if intel {
            entry(
                "sycl",
                BackendFit::Recommended,
                "vendorMatch",
                device_name(profile, GpuVendor::Intel),
            )
        } else {
            entry("sycl", BackendFit::Unsupported, "needsIntel", None)
        },
        if intel {
            entry(
                "openvino",
                BackendFit::Recommended,
                "vendorMatch",
                device_name(profile, GpuVendor::Intel),
            )
        } else {
            // OpenVINO still runs on any x86 CPU, just without an accelerator.
            entry("openvino", BackendFit::Compatible, "cpuFallback", None)
        },
        // Vulkan drives any modern GPU, so whenever one was detected it is a
        // genuine match for it — not a lesser alternative to the vendor runtime.
        if has_gpu {
            entry(
                "vulkan",
                BackendFit::Recommended,
                "portableGpu",
                profile.primary_gpu().map(|gpu| gpu.name.clone()),
            )
        } else {
            entry("vulkan", BackendFit::Unsupported, "needsGpu", None)
        },
        // The CPU build never uses the GPU, so it only counts as a match when
        // there is no GPU to match against.
        if has_gpu {
            entry("cpu", BackendFit::Compatible, "alwaysWorks", None)
        } else {
            entry("cpu", BackendFit::Recommended, "noGpuDetected", None)
        },
    ];
    for item in &mut recommendations {
        if !catalog_supports(&item.backend, &profile.os, &profile.arch) {
            item.fit = BackendFit::Unsupported;
            item.reason = "platformNotSupported".into();
            item.device = None;
        }
    }
    // Intel Macs have a CPU-only release, even when an AMD/Intel GPU is detected.
    if !recommendations
        .iter()
        .any(|item| item.fit == BackendFit::Recommended)
    {
        if let Some(cpu) = recommendations
            .iter_mut()
            .find(|item| item.backend == "cpu" && item.fit == BackendFit::Compatible)
        {
            cpu.fit = BackendFit::Recommended;
            cpu.reason = "cpuFallback".into();
        }
    }
    recommendations
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::{CpuInfo, GpuDevice, DEVICE_PROFILE_SCHEMA};

    fn profile(arch: &str, gpus: Vec<GpuDevice>) -> DeviceProfile {
        DeviceProfile {
            schema_version: DEVICE_PROFILE_SCHEMA,
            os: "windows".into(),
            arch: arch.into(),
            cpu: CpuInfo {
                name: "CPU".into(),
                logical_cores: 16,
                physical_cores: Some(8),
            },
            gpus,
            detection: "test".into(),
            fingerprint: "test".into(),
        }
    }

    fn gpu(vendor: GpuVendor, name: &str, integrated: bool) -> GpuDevice {
        GpuDevice {
            vendor,
            name: name.into(),
            vram_mb: Some(if integrated { 512 } else { 16384 }),
            driver: None,
            pci_id: None,
            integrated,
            stable_id: format!("test-{name}"),
        }
    }

    fn fit_of(list: &[BackendSuitability], backend: &str) -> BackendFit {
        list.iter()
            .find(|item| item.backend == backend)
            .expect(backend)
            .fit
    }

    /// Exactly what the runtime list shows before the user opts into more.
    fn shown_by_default(list: &[BackendSuitability]) -> Vec<&str> {
        let mut names: Vec<&str> = list
            .iter()
            .filter(|item| item.fit == BackendFit::Recommended)
            .map(|item| item.backend.as_str())
            .collect();
        names.sort_unstable();
        names
    }

    #[test]
    fn every_known_backend_gets_exactly_one_verdict() {
        let list = recommend(&profile("x86_64", vec![]));
        assert_eq!(list.len(), CATALOG_BACKENDS.len());
        for backend in CATALOG_BACKENDS {
            assert_eq!(
                list.iter().filter(|item| item.backend == *backend).count(),
                1,
                "{backend}"
            );
        }
    }

    #[test]
    fn a_discrete_amd_card_recommends_rocm_and_demotes_the_rest() {
        let list = recommend(&profile(
            "x86_64",
            vec![
                gpu(GpuVendor::Amd, "Radeon AI PRO R9700", false),
                gpu(GpuVendor::Amd, "Radeon(TM) Graphics", true),
            ],
        ));
        // Both runtimes drive this card, so both stay visible; everything that
        // cannot touch it is hidden.
        assert_eq!(shown_by_default(&list), vec!["rocm", "vulkan"]);
        assert_eq!(fit_of(&list, "cuda"), BackendFit::Unsupported);
        assert_eq!(fit_of(&list, "sycl"), BackendFit::Unsupported);
        assert_eq!(fit_of(&list, "openvino"), BackendFit::Compatible);
        assert_eq!(fit_of(&list, "cpu"), BackendFit::Compatible);
        // The verdict names the card so the UI can explain itself.
        let rocm = list.iter().find(|item| item.backend == "rocm").unwrap();
        assert_eq!(rocm.device.as_deref(), Some("Radeon AI PRO R9700"));
    }

    #[test]
    fn integrated_amd_only_leaves_vulkan_as_the_match() {
        let list = recommend(&profile(
            "x86_64",
            vec![gpu(GpuVendor::Amd, "Radeon(TM) Graphics", true)],
        ));
        // Vulkan drives an iGPU; ROCm's Windows iGPU support does not hold up.
        assert_eq!(shown_by_default(&list), vec!["vulkan"]);
        assert_eq!(fit_of(&list, "rocm"), BackendFit::Compatible);
        assert_eq!(fit_of(&list, "cpu"), BackendFit::Compatible);
    }

    #[test]
    fn nvidia_recommends_cuda_and_intel_recommends_the_intel_stack() {
        let nv = recommend(&profile(
            "x86_64",
            vec![gpu(GpuVendor::Nvidia, "GeForce RTX 4090", false)],
        ));
        assert_eq!(shown_by_default(&nv), vec!["cuda", "vulkan"]);
        assert_eq!(fit_of(&nv, "rocm"), BackendFit::Unsupported);

        let intel = recommend(&profile(
            "x86_64",
            vec![gpu(GpuVendor::Intel, "Arc A770", false)],
        ));
        assert_eq!(shown_by_default(&intel), vec!["openvino", "sycl", "vulkan"]);
        assert_eq!(fit_of(&intel, "cuda"), BackendFit::Unsupported);
    }

    #[test]
    fn a_machine_with_no_gpu_shows_only_the_cpu_build() {
        let list = recommend(&profile("x86_64", vec![]));
        assert_eq!(shown_by_default(&list), vec!["cpu"]);
        assert_eq!(fit_of(&list, "vulkan"), BackendFit::Unsupported);
        assert_eq!(fit_of(&list, "cuda"), BackendFit::Unsupported);
        assert_eq!(fit_of(&list, "rocm"), BackendFit::Unsupported);
    }

    #[test]
    fn nothing_that_cannot_reach_the_gpu_is_shown_by_default() {
        for gpus in [
            vec![gpu(GpuVendor::Amd, "Radeon AI PRO R9700", false)],
            vec![gpu(GpuVendor::Nvidia, "RTX 4090", false)],
            vec![gpu(GpuVendor::Intel, "Arc A770", false)],
        ] {
            let list = recommend(&profile("x86_64", gpus));
            // The CPU build never touches a GPU, so it is never a match when
            // one exists.
            assert!(!shown_by_default(&list).contains(&"cpu"));
            assert!(!shown_by_default(&list).is_empty());
        }
    }

    #[test]
    fn unsupported_architectures_have_no_installable_catalog_asset() {
        let list = recommend(&profile(
            "riscv64",
            vec![gpu(GpuVendor::Nvidia, "Orin", false)],
        ));
        assert!(list.iter().all(|item| item.fit == BackendFit::Unsupported));
        assert!(list.iter().all(|item| item.reason == "archNotSupported"));
    }

    #[test]
    fn apple_silicon_recommends_metal_and_intel_macos_uses_cpu() {
        let mut apple = profile(
            "aarch64",
            vec![gpu(GpuVendor::Apple, "Apple Test Chip", true)],
        );
        apple.os = "macos".into();
        assert_eq!(shown_by_default(&recommend(&apple)), vec!["metal"]);
        assert_eq!(
            fit_of(&recommend(&apple), "vulkan"),
            BackendFit::Unsupported
        );
        let mut intel = profile(
            "x86_64",
            vec![gpu(GpuVendor::Intel, "Intel Test GPU", true)],
        );
        intel.os = "macos".into();
        assert_eq!(shown_by_default(&recommend(&intel)), vec!["cpu"]);
    }

    #[test]
    fn linux_arm_can_install_cpu_and_vulkan_without_advertising_x64_only_backends() {
        let mut device = profile("aarch64", vec![gpu(GpuVendor::Amd, "Test GPU", false)]);
        device.os = "linux".into();
        assert_eq!(shown_by_default(&recommend(&device)), vec!["vulkan"]);
        assert_eq!(fit_of(&recommend(&device), "rocm"), BackendFit::Unsupported);
        assert_eq!(fit_of(&recommend(&device), "cpu"), BackendFit::Compatible);
    }
}
