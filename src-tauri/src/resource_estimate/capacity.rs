//! Dedicated GPU memory the configured device selection brings to a placement.
//!
//! A configuration names a GPU in one of two ways. A hardware stable id names
//! one physical card from [`hardware::detect`](crate::hardware::detect), so its
//! memory is read from that card's profile entry. A `runtime:<backend>:<Name>`
//! id names an entry of the runtime's own `--list-devices` output, which
//! follows the backend's enumeration (CUDA's fastest-first order, the Vulkan
//! loader, HIP) rather than the operating system's adapter order, so it is
//! resolved only against the device lines that runtime reported. The caller
//! passes those lines from an earlier probe; nothing here starts a runtime.
//!
//! llama.cpp lists integrated GPUs as well (`GGML_BACKEND_DEVICE_TYPE_IGPU` for
//! a Vulkan integrated device or a CUDA/HIP device with `prop.integrated`), and
//! the total they report is system memory. They are counted as shared, never
//! as dedicated capacity. Anything that cannot be established — a listed device
//! that matches no detected card, a missing memory figure, an id nothing
//! reports — makes the result `None` rather than a zero or a guess.

use crate::config::{AppConfig, SplitMode};
use crate::hardware::{DeviceProfile, GpuDevice, GpuVendor};

const MIB: u64 = 1024 * 1024;

/// Memory the selected GPUs contribute to a placement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GpuCapacity {
    /// Total memory of the selected dedicated GPUs, in bytes: the runtime's
    /// reported total for a runtime id, the driver's for a hardware id.
    pub(crate) dedicated_bytes: u64,
    /// Selected GPUs the runtime will place work on, integrated ones included.
    pub(crate) devices: usize,
    /// A selected GPU is integrated, so what it holds lands in system RAM.
    pub(crate) shared: bool,
}

/// One selected GPU, as far as capacity is concerned.
#[derive(Clone, Copy)]
struct Selected {
    integrated: bool,
    total_bytes: Option<u64>,
}

/// One entry of the runtime's device list.
struct Listed<'a> {
    name: &'a str,
    identity: String,
    total_bytes: Option<u64>,
}

/// What the configured GPU selection offers, or `None` when that cannot be
/// established without guessing.
///
/// `runtime_devices` are the `--list-devices` lines of the configured runtime,
/// empty when none were probed. Selection follows
/// `llama_model_load_from_file_impl` (`src/llama.cpp`): the configured devices,
/// or else every dedicated GPU the runtime lists and its integrated ones only
/// when it lists none; `SplitMode::Single` keeps just the main GPU, which
/// defaults to the first of those.
pub(super) fn gpu_capacity(
    cfg: &AppConfig,
    profile: Option<&DeviceProfile>,
    runtime_devices: &[String],
) -> Option<GpuCapacity> {
    let backend = cfg.active_backend.as_str();
    let (prefix, vendor) = backend_devices(backend)?;
    let listed = listed_devices(runtime_devices, prefix);
    let pool: Vec<&GpuDevice> = profile
        .into_iter()
        .flat_map(|profile| &profile.gpus)
        .filter(|gpu| vendor.is_none_or(|vendor| gpu.vendor == vendor))
        .collect();
    let scope = format!("runtime:{backend}:");
    let resolve = |id: &str| -> Option<Selected> {
        if id.starts_with("runtime:") {
            let name = id.strip_prefix(&scope)?;
            return classify(listed.iter().find(|device| device.name == name)?, &pool);
        }
        let gpu = pool.iter().find(|gpu| gpu.stable_id == id)?;
        Some(Selected {
            integrated: gpu.integrated,
            total_bytes: gpu.vram_mb.and_then(|mb| mb.checked_mul(MIB)),
        })
    };

    let placement = &cfg.gpu;
    let mut ids: Vec<&str> = Vec::new();
    for id in &placement.gpu_ids {
        if !ids.contains(&id.as_str()) {
            ids.push(id);
        }
    }
    let main = placement.main_gpu.as_deref();
    // `--main-gpu` indexes the `--device` list, and launch refuses one outside it.
    if main.is_some_and(|main| !ids.is_empty() && !ids.contains(&main)) {
        return None;
    }
    let single = placement.split_mode == SplitMode::Single;
    let selected = match main {
        Some(main) if single => vec![resolve(main)?],
        _ if !ids.is_empty() => {
            let ids = if single { &ids[..1] } else { &ids[..] };
            ids.iter()
                .map(|id| resolve(id))
                .collect::<Option<Vec<_>>>()?
        }
        _ => {
            let listed = listed
                .iter()
                .map(|device| classify(device, &pool))
                .collect::<Option<Vec<_>>>()?;
            let dedicated: Vec<_> = listed
                .iter()
                .copied()
                .filter(|device| !device.integrated)
                .collect();
            let mut defaults = if dedicated.is_empty() {
                listed
            } else {
                dedicated
            };
            if single {
                defaults.truncate(1);
            }
            defaults
        }
    };
    if selected.is_empty() {
        return None;
    }
    let mut dedicated_bytes = 0u64;
    for device in selected.iter().filter(|device| !device.integrated) {
        dedicated_bytes = dedicated_bytes.checked_add(device.total_bytes?)?;
    }
    Some(GpuCapacity {
        dedicated_bytes,
        devices: selected.len(),
        shared: selected.iter().any(|device| device.integrated),
    })
}

/// Device-name prefix and vendor of a backend's device list, as `gpu.rs`
/// resolves them at launch. Vulkan lists every vendor's GPUs together.
fn backend_devices(backend: &str) -> Option<(&'static str, Option<GpuVendor>)> {
    match backend {
        "cuda" => Some(("CUDA", Some(GpuVendor::Nvidia))),
        "rocm" => Some(("ROCm", Some(GpuVendor::Amd))),
        "vulkan" => Some(("Vulkan", None)),
        "sycl" => Some(("SYCL", Some(GpuVendor::Intel))),
        _ => None,
    }
}

/// Entries of `common_print_available_devices` (`common/arg.cpp`), printed as
/// `<name>: <description> (<total> MiB, <free> MiB free)`. Only the total is
/// kept: the free figure is whatever other programs left at probe time.
fn listed_devices<'a>(lines: &'a [String], prefix: &str) -> Vec<Listed<'a>> {
    let mut devices: Vec<Listed> = Vec::new();
    for line in lines {
        let Some((name, description)) = line.trim().split_once(':') else {
            continue;
        };
        let name = name.trim();
        let index = name.strip_prefix(prefix).unwrap_or_default();
        if index.is_empty()
            || !index.bytes().all(|byte| byte.is_ascii_digit())
            || devices.iter().any(|device| device.name == name)
        {
            continue;
        }
        let memory = description.rsplit_once('(').and_then(|(head, memory)| {
            let (mib, _) = memory.split_once(" MiB")?;
            Some((head, mib.trim().parse::<u64>().ok()?.checked_mul(MIB)?))
        });
        let (description, total_bytes) = match memory {
            Some((head, bytes)) => (head, Some(bytes)),
            None => (description, None),
        };
        devices.push(Listed {
            name,
            identity: searchable(description),
            total_bytes,
        });
    }
    devices
}

/// Whether a listed device is integrated, taken from the detected cards of the
/// same model: the runtime line does not say. A device that matches no card,
/// or matches cards that disagree, stays unknown.
fn classify(device: &Listed, pool: &[&GpuDevice]) -> Option<Selected> {
    let mut cards = pool
        .iter()
        .filter(|gpu| same_model(&gpu.name, &device.identity));
    let integrated = cards.next()?.integrated;
    if cards.any(|gpu| gpu.integrated != integrated) {
        return None;
    }
    Some(Selected {
        integrated,
        total_bytes: device.total_bytes,
    })
}

/// Name matching as `gpu::resolve_with_runtime_devices` does it, on
/// alphanumerics only, since runtimes and drivers punctuate names differently.
fn same_model(card: &str, identity: &str) -> bool {
    let card = searchable(card);
    !card.is_empty()
        && !identity.is_empty()
        && (identity.contains(&card) || card.contains(identity))
}

fn searchable(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GpuPlacement;
    use crate::hardware::{CpuInfo, DEVICE_PROFILE_SCHEMA};

    const GIB: u64 = 1024 * MIB;

    fn card(
        vendor: GpuVendor,
        name: &str,
        stable_id: &str,
        vram_mb: Option<u64>,
        integrated: bool,
    ) -> GpuDevice {
        GpuDevice {
            vendor,
            name: name.into(),
            vram_mb,
            driver: None,
            pci_id: None,
            integrated,
            stable_id: stable_id.into(),
        }
    }

    fn profile(gpus: Vec<GpuDevice>) -> DeviceProfile {
        DeviceProfile {
            schema_version: DEVICE_PROFILE_SCHEMA,
            os: "test".into(),
            arch: "test".into(),
            cpu: CpuInfo {
                name: "Test CPU".into(),
                logical_cores: 8,
                physical_cores: Some(4),
            },
            gpus,
            detection: "test".into(),
            fingerprint: "test".into(),
        }
    }

    /// Two dedicated cards of different sizes, detected larger one first.
    fn nvidia() -> DeviceProfile {
        profile(vec![
            card(
                GpuVendor::Nvidia,
                "Test Accel 24G",
                "gpu-a",
                Some(24_576),
                false,
            ),
            card(
                GpuVendor::Nvidia,
                "Test Accel 16G",
                "gpu-b",
                Some(16_384),
                false,
            ),
        ])
    }

    /// An integrated part detected ahead of two identical dedicated cards.
    fn amd() -> DeviceProfile {
        profile(vec![
            card(
                GpuVendor::Amd,
                "Test Radeon Graphics",
                "amd-igpu",
                Some(512),
                true,
            ),
            card(
                GpuVendor::Amd,
                "Test Radeon Pro 32G",
                "amd-0",
                Some(32_768),
                false,
            ),
            card(
                GpuVendor::Amd,
                "Test Radeon Pro 32G",
                "amd-1",
                Some(32_768),
                false,
            ),
        ])
    }

    const AMD_LINES: [&str; 4] = [
        "Available devices:",
        "ROCm0: Test Radeon Graphics (16384 MiB, 15000 MiB free)",
        "ROCm1: Test Radeon Pro 32G (32752 MiB, 1000 MiB free)",
        "ROCm2: Test Radeon Pro 32G (32752 MiB, 32000 MiB free)",
    ];

    fn config(backend: &str, ids: &[&str], main: Option<&str>, split_mode: SplitMode) -> AppConfig {
        AppConfig {
            active_backend: backend.into(),
            gpu: GpuPlacement {
                gpu_ids: ids.iter().map(|id| id.to_string()).collect(),
                main_gpu: main.map(str::to_string),
                split_mode,
                ..GpuPlacement::default()
            },
            ..AppConfig::default()
        }
    }

    fn lines(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    fn capacity(dedicated_bytes: u64, devices: usize, shared: bool) -> Option<GpuCapacity> {
        Some(GpuCapacity {
            dedicated_bytes,
            devices,
            shared,
        })
    }

    #[test]
    fn hardware_ids_sum_the_selected_dedicated_cards() {
        let machine = nvidia();
        let both = config("cuda", &["gpu-a", "gpu-b"], None, SplitMode::Layer);
        assert_eq!(
            gpu_capacity(&both, Some(&machine), &[]),
            capacity(40 * GIB, 2, false)
        );
        let one = config("cuda", &["gpu-b"], None, SplitMode::None);
        assert_eq!(
            gpu_capacity(&one, Some(&machine), &[]),
            capacity(16 * GIB, 1, false)
        );
        // The same card named twice is still one card.
        let repeated = config("cuda", &["gpu-a", "gpu-a"], None, SplitMode::Layer);
        assert_eq!(
            gpu_capacity(&repeated, Some(&machine), &[]),
            capacity(24 * GIB, 1, false)
        );
    }

    #[test]
    fn single_mode_keeps_only_the_main_gpu() {
        let machine = nvidia();
        let main = config(
            "cuda",
            &["gpu-a", "gpu-b"],
            Some("gpu-b"),
            SplitMode::Single,
        );
        assert_eq!(
            gpu_capacity(&main, Some(&machine), &[]),
            capacity(16 * GIB, 1, false)
        );
        // llama.cpp's main GPU defaults to the first selected device.
        let first = config("cuda", &["gpu-a", "gpu-b"], None, SplitMode::Single);
        assert_eq!(
            gpu_capacity(&first, Some(&machine), &[]),
            capacity(24 * GIB, 1, false)
        );
        // Only single mode narrows the selection to the main GPU.
        let layered = config("cuda", &["gpu-a", "gpu-b"], Some("gpu-b"), SplitMode::Layer);
        assert_eq!(
            gpu_capacity(&layered, Some(&machine), &[]),
            capacity(40 * GIB, 2, false)
        );
        // Launch refuses a main GPU outside the device list.
        for mode in [SplitMode::Single, SplitMode::Layer] {
            let outside = config("cuda", &["gpu-a"], Some("gpu-b"), mode);
            assert_eq!(gpu_capacity(&outside, Some(&machine), &[]), None);
        }
    }

    #[test]
    fn runtime_ids_follow_the_runtime_list_not_the_detected_order() {
        let machine = nvidia();
        // The runtime enumerates the smaller card first, and an older runtime
        // prints no free figure.
        let reported = lines(&[
            "CUDA0: Test Accel 16G (16380 MiB, 15000 MiB free)",
            "CUDA1: Test Accel 24G (24560 MiB)",
        ]);
        let first = config("cuda", &["runtime:cuda:CUDA0"], None, SplitMode::None);
        assert_eq!(
            gpu_capacity(&first, Some(&machine), &reported),
            capacity(16_380 * MIB, 1, false)
        );
        let both = config(
            "cuda",
            &["runtime:cuda:CUDA1", "runtime:cuda:CUDA0"],
            Some("runtime:cuda:CUDA1"),
            SplitMode::Single,
        );
        assert_eq!(
            gpu_capacity(&both, Some(&machine), &reported),
            capacity(24_560 * MIB, 1, false)
        );
        // Without the runtime's own list the position means nothing.
        assert_eq!(gpu_capacity(&first, Some(&machine), &[]), None);
        // Another backend's id, or one the runtime does not list, is unknown.
        for id in ["runtime:rocm:ROCm0", "runtime:cuda:CUDA2"] {
            let cfg = config("cuda", &[id], None, SplitMode::None);
            assert_eq!(gpu_capacity(&cfg, Some(&machine), &reported), None);
        }
    }

    #[test]
    fn integrated_gpus_are_shared_memory_not_a_dedicated_pool() {
        let machine = amd();
        let reported = lines(&AMD_LINES);
        let mixed = config(
            "rocm",
            &["runtime:rocm:ROCm0", "runtime:rocm:ROCm2"],
            None,
            SplitMode::Layer,
        );
        assert_eq!(
            gpu_capacity(&mixed, Some(&machine), &reported),
            capacity(32_752 * MIB, 2, true)
        );
        let integrated = config("rocm", &["runtime:rocm:ROCm0"], None, SplitMode::None);
        assert_eq!(
            gpu_capacity(&integrated, Some(&machine), &reported),
            capacity(0, 1, true)
        );
        let hardware = config("rocm", &["amd-igpu", "amd-1"], None, SplitMode::Layer);
        assert_eq!(
            gpu_capacity(&hardware, Some(&machine), &reported),
            capacity(32 * GIB, 2, true)
        );
    }

    #[test]
    fn an_empty_selection_is_the_runtime_default_device_set() {
        let machine = amd();
        let reported = lines(&AMD_LINES);
        let all = config("rocm", &[], None, SplitMode::None);
        assert_eq!(
            gpu_capacity(&all, Some(&machine), &reported),
            capacity(2 * 32_752 * MIB, 2, false)
        );
        let single = config("rocm", &[], None, SplitMode::Single);
        assert_eq!(
            gpu_capacity(&single, Some(&machine), &reported),
            capacity(32_752 * MIB, 1, false)
        );
        // Integrated GPUs are used only when nothing dedicated is listed.
        let only_integrated = lines(&AMD_LINES[..2]);
        assert_eq!(
            gpu_capacity(&all, Some(&machine), &only_integrated),
            capacity(0, 1, true)
        );
        // Summing every detected adapter would be a guess.
        assert_eq!(gpu_capacity(&all, Some(&machine), &[]), None);
    }

    #[test]
    fn anything_unestablished_is_none_rather_than_zero() {
        let machine = nvidia();
        let cfg = config("cuda", &["runtime:cuda:CUDA0"], None, SplitMode::None);
        // A listed device that matches no detected card.
        let unknown = lines(&["CUDA0: Other Accel (8192 MiB, 8000 MiB free)"]);
        assert_eq!(gpu_capacity(&cfg, Some(&machine), &unknown), None);
        assert_eq!(gpu_capacity(&cfg, None, &unknown), None);
        // A listed device without a memory figure.
        let unmeasured = lines(&["CUDA0: Test Accel 24G"]);
        assert_eq!(gpu_capacity(&cfg, Some(&machine), &unmeasured), None);
        // A name shared by an integrated and a dedicated card.
        let ambiguous = profile(vec![
            card(GpuVendor::Amd, "Test Radeon", "amd-igpu", Some(512), true),
            card(
                GpuVendor::Amd,
                "Test Radeon Pro 32G",
                "amd-0",
                Some(32_768),
                false,
            ),
        ]);
        let listed = lines(&["ROCm0: Test Radeon Pro 32G (32752 MiB, 32000 MiB free)"]);
        let rocm = config("rocm", &["runtime:rocm:ROCm0"], None, SplitMode::None);
        assert_eq!(gpu_capacity(&rocm, Some(&ambiguous), &listed), None);
        // A card whose memory the driver did not report.
        let unreported = profile(vec![card(
            GpuVendor::Nvidia,
            "Test Accel",
            "gpu-a",
            None,
            false,
        )]);
        let hardware = config("cuda", &["gpu-a"], None, SplitMode::None);
        assert_eq!(gpu_capacity(&hardware, Some(&unreported), &[]), None);
        // A card that is not on this machine, or not on this backend's list.
        for (backend, id) in [("cuda", "gpu-missing"), ("rocm", "gpu-a")] {
            let cfg = config(backend, &[id], None, SplitMode::None);
            assert_eq!(gpu_capacity(&cfg, Some(&machine), &[]), None);
        }
        assert_eq!(gpu_capacity(&hardware, None, &[]), None);
        // A backend without GPU devices has no GPU capacity to report.
        for backend in ["cpu", "openvino", ""] {
            let cfg = config(backend, &["gpu-a"], None, SplitMode::None);
            assert_eq!(gpu_capacity(&cfg, Some(&machine), &[]), None);
        }
    }
}
