//! Bridges `config::GpuPlacement` (what the user configured, keyed by
//! hardware-stable GPU ids) to the command-line device names llama.cpp
//! actually expects (`CUDA0`, `ROCm1`, ...), which are positional and depend
//! entirely on how the selected backend enumerates devices *right now*.
//!
//! Resolution happens once, at launch time, against a freshly detected
//! [`DeviceProfile`] — never cached — so a config saved months ago still
//! points at the same physical card even if a GPU was added, removed, or
//! reordered by a driver update in the meantime. A configured id that is not
//! present on this machine is always an error: never fall back to "let
//! llama.cpp guess", which would silently run on the CPU or the wrong GPU.

use crate::config::GpuPlacement;
use crate::hardware::{DeviceProfile, GpuDevice, GpuVendor};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResolvedGpu {
    /// Value for `--device`, e.g. `Some("CUDA0,CUDA1")`.
    pub device_flag: Option<String>,
    /// Value for `--main-gpu`.
    pub main_gpu_index: Option<usize>,
    /// Value for `--split-mode`.
    pub split_mode: Option<&'static str>,
    /// Values for `--tensor-split`.
    pub tensor_split: Vec<f32>,
    /// Value for `--spec-draft-device`, e.g. `Some("Vulkan0")`.
    pub draft_device: Option<String>,
}

impl ResolvedGpu {
    pub fn is_empty(&self) -> bool {
        self.device_flag.is_none()
            && self.main_gpu_index.is_none()
            && self.split_mode.is_none()
            && self.tensor_split.is_empty()
            && self.draft_device.is_none()
    }
}

/// The `--device`/`--main-gpu` prefix llama.cpp uses for a backend's devices.
/// `None` means the backend has no per-GPU-id device flag at all (either it
/// is not GPU-accelerated, or — as for `vulkan`, which enumerates every
/// vendor together — the vendor filter below already covers it under a
/// different prefix owner).
fn device_prefix(backend: &str) -> Option<&'static str> {
    match backend {
        "cuda" => Some("CUDA"),
        "rocm" => Some("ROCm"),
        "vulkan" => Some("Vulkan"),
        "sycl" => Some("SYCL"),
        _ => None,
    }
}

/// Which vendor's devices a backend's device list is drawn from. `None` for
/// `vulkan` because it enumerates GPUs from every vendor in one list.
fn vendor_for_backend(backend: &str) -> Option<GpuVendor> {
    match backend {
        "cuda" => Some(GpuVendor::Nvidia),
        "rocm" => Some(GpuVendor::Amd),
        "sycl" => Some(GpuVendor::Intel),
        _ => None,
    }
}

fn device_pool<'a>(profile: &'a DeviceProfile, backend: &str) -> Vec<&'a GpuDevice> {
    match vendor_for_backend(backend) {
        Some(vendor) => profile
            .gpus
            .iter()
            .filter(|gpu| gpu.vendor == vendor)
            .collect(),
        None => profile.gpus.iter().collect(),
    }
}

pub fn resolve(
    placement: &GpuPlacement,
    backend: &str,
    profile: &DeviceProfile,
) -> Result<ResolvedGpu, String> {
    let mut resolved = ResolvedGpu::default();
    if placement.is_empty() {
        return Ok(resolved);
    }
    let Some(prefix) = device_prefix(backend) else {
        return Err(format!(
            "GPU placement is configured but backend '{}' does not support pinning devices by id; select cuda, rocm, vulkan, or sycl, or clear the GPU assignment",
            if backend.is_empty() { "(none selected)" } else { backend }
        ));
    };
    let pool = device_pool(profile, backend);

    let index_of = |stable_id: &str| -> Result<usize, String> {
        pool.iter()
            .position(|gpu| gpu.stable_id == stable_id)
            .ok_or_else(|| {
                format!(
                    "configured GPU '{stable_id}' was not found on this machine for backend '{backend}'; reselect a detected GPU rather than starting without one"
                )
            })
    };

    if !placement.gpu_ids.is_empty() {
        let mut names = Vec::with_capacity(placement.gpu_ids.len());
        for id in &placement.gpu_ids {
            names.push(format!("{prefix}{}", index_of(id)?));
        }
        resolved.device_flag = Some(names.join(","));
    }

    if let Some(main_gpu) = &placement.main_gpu {
        resolved.main_gpu_index =
            Some(main_device_index(placement, main_gpu, index_of(main_gpu)?)?);
    }

    resolved.split_mode = placement.split_mode.as_flag_value();
    resolved.tensor_split = placement.tensor_split.clone();

    if let Some(draft_id) = &placement.draft_gpu_id {
        resolved.draft_device = Some(format!("{prefix}{}", index_of(draft_id)?));
    }

    Ok(resolved)
}

#[derive(Clone, Debug)]
struct RuntimeDevice {
    name: String,
    index: usize,
    searchable: String,
    identity: String,
}

fn searchable(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn parse_runtime_devices(lines: &[String], prefix: &str) -> Vec<RuntimeDevice> {
    lines
        .iter()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (name, description) = trimmed.split_once(':')?;
            let suffix = name.trim().strip_prefix(prefix)?;
            let index = suffix.parse::<usize>().ok()?;
            Some(RuntimeDevice {
                name: name.trim().to_string(),
                index,
                searchable: searchable(&format!("{name} {description}")),
                identity: searchable(description),
            })
        })
        .collect()
}

/// Resolve stable OS GPU ids against the device names reported by the exact
/// llama-server binary that is about to launch. This prevents an OS adapter
/// enumeration order from being mistaken for CUDA/ROCm/Vulkan/SYCL order.
pub fn resolve_with_runtime_devices(
    placement: &GpuPlacement,
    backend: &str,
    profile: &DeviceProfile,
    runtime_lines: &[String],
) -> Result<ResolvedGpu, String> {
    if placement.is_empty() {
        return Ok(ResolvedGpu::default());
    }
    let Some(prefix) = device_prefix(backend) else {
        return resolve(placement, backend, profile);
    };
    let runtime_devices = parse_runtime_devices(runtime_lines, prefix);
    if runtime_devices.is_empty() {
        return Err(format!(
            "the selected {backend} runtime did not report any {prefix} devices; refresh the runtime probe or clear the GPU assignment"
        ));
    }
    let pool = device_pool(profile, backend);
    let resolve_id = |stable_id: &str| -> Result<&RuntimeDevice, String> {
        // Explicit runtime-index selection makes no claim about OS/PCI order.
        // Scope it to its backend and revalidate against the fresh probe.
        if stable_id.starts_with("runtime:") {
            let scope = format!("runtime:{backend}:");
            return stable_id.strip_prefix(&scope)
                .and_then(|name| runtime_devices.iter().find(|device| device.name == name))
                .ok_or_else(|| format!("runtime GPU '{stable_id}' is unavailable for {backend}; probe and reselect a runtime device"));
        }
        let gpu = pool
            .iter()
            .find(|gpu| gpu.stable_id == stable_id)
            .ok_or_else(|| {
                format!(
                    "configured GPU '{stable_id}' was not found on this machine for backend '{backend}'"
                )
            })?;
        let name = searchable(&gpu.name);
        let pci = gpu.pci_id.as_deref().map(searchable);
        let stable = searchable(&gpu.stable_id);
        let candidates = runtime_devices
            .iter()
            .filter(|device| {
                (!name.is_empty()
                    && (device.searchable.contains(&name) || name.contains(&device.searchable)))
                    || pci
                        .as_ref()
                        .is_some_and(|pci| !pci.is_empty() && device.searchable.contains(pci))
                    || (!stable.is_empty() && device.searchable.contains(&stable))
            })
            .collect::<Vec<_>>();
        match candidates.as_slice() {
            [device] => Ok(*device),
            [] => Err(format!(
                "GPU '{}' ({}) could not be matched to the devices reported by the selected runtime",
                gpu.name, gpu.stable_id
            )),
            _ => {
                Err(format!(
                    "GPU '{}' ({}) is ambiguous in the runtime device list; refresh GPU choices and select an explicit {prefix} runtime device instead of guessing physical GPU order",
                    gpu.name, gpu.stable_id
                ))
            }
        }
    };

    let mut resolved = ResolvedGpu::default();
    if !placement.gpu_ids.is_empty() {
        resolved.device_flag = Some(
            placement
                .gpu_ids
                .iter()
                .map(|id| resolve_id(id).map(|device| device.name.clone()))
                .collect::<Result<Vec<_>, _>>()?
                .join(","),
        );
    }
    if let Some(main_gpu) = &placement.main_gpu {
        resolved.main_gpu_index = Some(main_device_index(
            placement,
            main_gpu,
            resolve_id(main_gpu)?.index,
        )?);
    }
    resolved.split_mode = placement.split_mode.as_flag_value();
    resolved.tensor_split = placement.tensor_split.clone();
    if let Some(draft_id) = &placement.draft_gpu_id {
        resolved.draft_device = Some(resolve_id(draft_id)?.name.clone());
    }
    Ok(resolved)
}

// --main-gpu indexes the selected --device list, not the global runtime list.
fn main_device_index(
    placement: &GpuPlacement,
    id: &str,
    runtime_index: usize,
) -> Result<usize, String> {
    if placement.gpu_ids.is_empty() {
        return Ok(runtime_index);
    }
    placement
        .gpu_ids
        .iter()
        .position(|selected| selected == id)
        .ok_or_else(|| format!("main GPU '{id}' is not in the selected device list"))
}

/// Every device the selected runtime reports, named explicitly.
///
/// Leaving the selection empty means "let the backend decide", which is not a
/// safe default here: `validate_safe_auto_placement` already refuses it for
/// Vulkan with indistinguishable cards, because spanning them automatically has
/// lost the device outright. Naming what the runtime reports keeps the same
/// intent — use the GPUs that are there — while staying explicit enough to
/// resolve, verify and show back to the user.
pub fn select_all_runtime_devices(backend: &str, runtime_lines: &[String]) -> Vec<String> {
    let Some(prefix) = device_prefix(backend) else {
        return Vec::new();
    };
    parse_runtime_devices(runtime_lines, prefix)
        .into_iter()
        .map(|device| format!("runtime:{backend}:{}", device.name))
        .collect()
}

/// What a backend switch did to a saved GPU selection.
#[derive(Clone, Debug, PartialEq)]
pub struct Remapped {
    pub placement: GpuPlacement,
    /// Selections that had no counterpart under the new backend and were
    /// dropped. Empty when everything carried over.
    pub dropped: Vec<String>,
}

/// Which physical card a runtime-scoped id names, as (identity, position among
/// cards reporting that same identity). Two cards of the same model report the
/// same text, so the position is what keeps them apart.
fn device_identity(devices: &[RuntimeDevice], name: &str) -> Option<(String, usize)> {
    let device = devices.iter().find(|item| item.name == name)?;
    let position = devices
        .iter()
        .filter(|item| item.identity == device.identity)
        .position(|item| item.name == name)?;
    Some((device.identity.clone(), position))
}

fn device_named(devices: &[RuntimeDevice], identity: &str, position: usize) -> Option<String> {
    devices
        .iter()
        .filter(|item| item.identity == identity)
        .nth(position)
        .map(|item| item.name.clone())
}

/// Re-point a saved GPU selection at the equivalent devices of another backend.
///
/// A runtime-scoped id names a device inside one backend's own enumeration, so
/// `runtime:rocm:ROCm1` means nothing to Vulkan. Switching backends used to
/// leave that selection in place, where it survived every settings screen and
/// only failed at launch with "unavailable for vulkan". Each selected device is
/// matched to the one the new backend reports with the same identity at the same
/// position among identical cards, which is the only correspondence the two
/// lists actually establish. Anything without a counterpart is dropped and
/// named, never guessed at: picking the wrong card silently is the failure this
/// module exists to prevent.
pub fn remap_runtime_devices(
    placement: &GpuPlacement,
    from_backend: &str,
    from_devices: &[String],
    to_backend: &str,
    to_devices: &[String],
) -> Remapped {
    let mut next = placement.clone();
    let mut dropped = Vec::new();
    if from_backend == to_backend || placement.is_empty() {
        return Remapped {
            placement: next,
            dropped,
        };
    }
    let from_prefix = device_prefix(from_backend);
    let to_prefix = device_prefix(to_backend);
    let old = from_prefix.map(|prefix| parse_runtime_devices(from_devices, prefix));
    let new = to_prefix.map(|prefix| parse_runtime_devices(to_devices, prefix));
    let scope = format!("runtime:{from_backend}:");
    let mut convert = |id: &str| -> Option<String> {
        // A hardware stable id already identifies the card itself, so it needs
        // no translation; only a runtime-scoped name is backend-specific.
        let Some(name) = id.strip_prefix(&scope) else {
            return Some(id.to_string());
        };
        let (old, new) = (old.as_ref()?, new.as_ref()?);
        let (identity, position) = device_identity(old, name)?;
        let mapped = device_named(new, &identity, position)?;
        Some(format!("runtime:{to_backend}:{mapped}"))
    };

    let mut ids = Vec::with_capacity(placement.gpu_ids.len());
    for id in &placement.gpu_ids {
        match convert(id) {
            Some(mapped) => ids.push(mapped),
            None => dropped.push(id.clone()),
        }
    }
    next.main_gpu = placement.main_gpu.as_deref().and_then(&mut convert);
    next.draft_gpu_id = placement.draft_gpu_id.as_deref().and_then(&mut convert);
    if placement.main_gpu.is_some() && next.main_gpu.is_none() {
        dropped.extend(placement.main_gpu.clone());
    }
    if placement.draft_gpu_id.is_some() && next.draft_gpu_id.is_none() {
        dropped.extend(placement.draft_gpu_id.clone());
    }
    // Ratios are positional against the selected devices, so a shorter list
    // would silently re-weight the survivors.
    if ids.len() != placement.gpu_ids.len() {
        next.tensor_split.clear();
    }
    next.gpu_ids = ids;
    if let Some(main) = &next.main_gpu {
        if !next.gpu_ids.is_empty() && !next.gpu_ids.iter().any(|id| id == main) {
            next.main_gpu = None;
        }
    }
    Remapped {
        placement: next,
        dropped,
    }
}

/// Vulkan may eagerly span every visible adapter when no `--device` is
/// supplied. With multiple indistinguishable cards this has caused driver
/// device-loss failures, so require an explicit selection for that case.
pub fn validate_safe_auto_placement(
    placement: &GpuPlacement,
    backend: &str,
    runtime_lines: &[String],
) -> Result<(), String> {
    if backend != "vulkan" || !placement.is_empty() {
        return Ok(());
    }
    let devices = parse_runtime_devices(runtime_lines, "Vulkan");
    let has_duplicate = devices.iter().enumerate().any(|(index, device)| {
        devices[index + 1..]
            .iter()
            .any(|other| device.identity == other.identity)
    });
    if has_duplicate {
        return Err(
            "the Vulkan runtime reports multiple identical GPUs; select one or more GPUs explicitly before starting the server to avoid unstable automatic placement"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SplitMode;
    use crate::hardware::{CpuInfo, DEVICE_PROFILE_SCHEMA};

    fn gpu(vendor: GpuVendor, stable_id: &str) -> GpuDevice {
        GpuDevice {
            vendor,
            name: "GeForce RTX 4090".into(),
            vram_mb: Some(24564),
            driver: None,
            pci_id: Some("10de:2684".into()),
            integrated: false,
            stable_id: stable_id.into(),
        }
    }

    fn profile(gpus: Vec<GpuDevice>) -> DeviceProfile {
        DeviceProfile {
            schema_version: DEVICE_PROFILE_SCHEMA,
            os: "windows".into(),
            arch: "x86_64".into(),
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

    #[test]
    fn empty_placement_resolves_to_nothing_and_needs_no_hardware() {
        let resolved = resolve(&GpuPlacement::default(), "", &profile(vec![])).unwrap();
        assert!(resolved.is_empty());
    }

    #[test]
    fn duplicate_chipset_cards_resolve_to_distinct_device_indices_by_stable_id() {
        // Two identical RTX 4090s: same vendor, same pci_id, same name — only
        // the stable id tells them apart, and only it must decide the index.
        let card_a = gpu(GpuVendor::Nvidia, "10de:2684#0000");
        let card_b = gpu(GpuVendor::Nvidia, "10de:2684#0001");
        let profile = profile(vec![card_a.clone(), card_b.clone()]);

        let placement = GpuPlacement {
            gpu_ids: vec!["10de:2684#0001".into(), "10de:2684#0000".into()],
            main_gpu: Some("10de:2684#0001".into()),
            ..GpuPlacement::default()
        };
        let resolved = resolve(&placement, "cuda", &profile).expect("both ids are present");
        // Order follows the configured gpu_ids, using each card's position in
        // the backend's own enumeration (device list order), not name/pci_id.
        assert_eq!(resolved.device_flag.as_deref(), Some("CUDA1,CUDA0"));
        assert_eq!(resolved.main_gpu_index, Some(0));
    }

    #[test]
    fn missing_configured_gpu_id_is_an_explicit_error_not_a_silent_fallback() {
        let profile = profile(vec![gpu(GpuVendor::Nvidia, "10de:2684#0000")]);
        let placement = GpuPlacement {
            gpu_ids: vec!["10de:2684#does-not-exist".into()],
            ..GpuPlacement::default()
        };
        let error = resolve(&placement, "cuda", &profile).unwrap_err();
        assert!(error.contains("10de:2684#does-not-exist"));
        assert!(error.contains("was not found"));
    }

    #[test]
    fn unsupported_backend_with_a_configured_placement_is_an_explicit_error() {
        let placement = GpuPlacement {
            gpu_ids: vec!["anything".into()],
            ..GpuPlacement::default()
        };
        assert!(resolve(&placement, "openvino", &profile(vec![])).is_err());
        assert!(resolve(&placement, "", &profile(vec![])).is_err());
    }

    #[test]
    fn vulkan_pools_every_vendor_together() {
        let nvidia = gpu(GpuVendor::Nvidia, "nv-0");
        let amd = GpuDevice {
            vendor: GpuVendor::Amd,
            stable_id: "amd-0".into(),
            ..nvidia.clone()
        };
        let profile = profile(vec![nvidia, amd]);
        let placement = GpuPlacement {
            gpu_ids: vec!["amd-0".into()],
            ..GpuPlacement::default()
        };
        let resolved = resolve(&placement, "vulkan", &profile).expect("amd-0 is present");
        assert_eq!(resolved.device_flag.as_deref(), Some("Vulkan1"));
    }

    #[test]
    fn split_mode_and_tensor_split_pass_through_without_needing_a_gpu_selection() {
        let placement = GpuPlacement {
            split_mode: SplitMode::Row,
            tensor_split: vec![0.6, 0.4],
            ..GpuPlacement::default()
        };
        let resolved = resolve(&placement, "cuda", &profile(vec![])).expect("no ids to resolve");
        assert_eq!(resolved.split_mode, Some("row"));
        assert_eq!(resolved.tensor_split, vec![0.6, 0.4]);
        assert!(resolved.device_flag.is_none());
    }

    #[test]
    fn explicit_single_and_tensor_modes_are_distinct_from_inheritance() {
        assert_eq!(SplitMode::None.as_flag_value(), None);
        assert_eq!(SplitMode::Single.as_flag_value(), Some("none"));
        assert_eq!(SplitMode::Tensor.as_flag_value(), Some("tensor"));
        for mode in [SplitMode::Single, SplitMode::Tensor] {
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(serde_json::from_str::<SplitMode>(&json).unwrap(), mode);
        }
    }

    #[test]
    fn draft_gpu_id_resolves_independently_of_the_main_device_list() {
        let main = gpu(GpuVendor::Nvidia, "main-0");
        let draft = GpuDevice {
            stable_id: "draft-0".into(),
            ..main.clone()
        };
        let profile = profile(vec![main.clone(), draft]);
        let placement = GpuPlacement {
            draft_gpu_id: Some("draft-0".into()),
            ..GpuPlacement::default()
        };
        let resolved = resolve(&placement, "cuda", &profile).expect("draft-0 is present");
        assert_eq!(resolved.draft_device.as_deref(), Some("CUDA1"));
        assert!(resolved.device_flag.is_none());
    }

    #[test]
    fn runtime_device_names_override_os_enumeration_order() {
        let first = GpuDevice {
            name: "NVIDIA RTX A".into(),
            ..gpu(GpuVendor::Nvidia, "gpu-a")
        };
        let second = GpuDevice {
            name: "NVIDIA RTX B".into(),
            ..gpu(GpuVendor::Nvidia, "gpu-b")
        };
        let placement = GpuPlacement {
            gpu_ids: vec!["gpu-a".into(), "gpu-b".into()],
            main_gpu: Some("gpu-a".into()),
            ..GpuPlacement::default()
        };
        let runtime_devices = vec![
            "CUDA0: NVIDIA RTX B (24564 MiB)".to_string(),
            "CUDA1: NVIDIA RTX A (24564 MiB)".to_string(),
        ];

        let resolved = resolve_with_runtime_devices(
            &placement,
            "cuda",
            &profile(vec![first, second]),
            &runtime_devices,
        )
        .expect("runtime devices can be matched by their reported names");

        assert_eq!(resolved.device_flag.as_deref(), Some("CUDA1,CUDA0"));
        assert_eq!(resolved.main_gpu_index, Some(0));
    }

    #[test]
    fn indistinguishable_duplicate_runtime_devices_require_explicit_selection() {
        let first = gpu(GpuVendor::Nvidia, "gpu-a");
        let second = gpu(GpuVendor::Nvidia, "gpu-b");
        let placement = GpuPlacement {
            gpu_ids: vec!["gpu-b".into(), "gpu-a".into()],
            main_gpu: Some("gpu-b".into()),
            ..GpuPlacement::default()
        };
        let runtime_devices = vec![
            "CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB)".to_string(),
            "CUDA1: NVIDIA GeForce RTX 4090 (24564 MiB)".to_string(),
        ];

        let resolved = resolve_with_runtime_devices(
            &placement,
            "cuda",
            &profile(vec![first, second]),
            &runtime_devices,
        )
        .expect_err("OS order does not establish runtime order");
        assert!(resolved.contains("ambiguous"));

        let explicit = GpuPlacement {
            gpu_ids: vec!["runtime:cuda:CUDA1".into(), "runtime:cuda:CUDA0".into()],
            main_gpu: Some("runtime:cuda:CUDA1".into()),
            ..GpuPlacement::default()
        };
        let resolved =
            resolve_with_runtime_devices(&explicit, "cuda", &profile(vec![]), &runtime_devices)
                .unwrap();
        assert!(resolve_with_runtime_devices(
            &explicit,
            "rocm",
            &profile(vec![]),
            &runtime_devices
        )
        .is_err());
        assert!(resolve_with_runtime_devices(
            &explicit,
            "cuda",
            &profile(vec![]),
            &runtime_devices[..1]
        )
        .is_err());

        assert_eq!(resolved.device_flag.as_deref(), Some("CUDA1,CUDA0"));
        assert_eq!(resolved.main_gpu_index, Some(0));
    }

    #[test]
    fn single_second_runtime_gpu_uses_local_main_index_zero() {
        let placement = GpuPlacement {
            gpu_ids: vec!["runtime:rocm:ROCm1".into()],
            main_gpu: Some("runtime:rocm:ROCm1".into()),
            ..GpuPlacement::default()
        };
        let devices = vec![
            "ROCm0: AMD Radeon (32768 MiB)".into(),
            "ROCm1: AMD Radeon (32768 MiB)".into(),
        ];
        let resolved =
            resolve_with_runtime_devices(&placement, "rocm", &profile(vec![]), &devices).unwrap();
        assert_eq!(resolved.device_flag.as_deref(), Some("ROCm1"));
        assert_eq!(resolved.main_gpu_index, Some(0));
        let mut invalid = placement;
        invalid.main_gpu = Some("runtime:rocm:ROCm0".into());
        assert!(
            resolve_with_runtime_devices(&invalid, "rocm", &profile(vec![]), &devices).is_err()
        );
    }

    #[test]
    fn switching_backend_repoints_a_saved_selection_at_the_same_cards() {
        // Two identical cards: the reported text cannot tell them apart, so the
        // position within the list is the only thing that can.
        let rocm = vec![
            "ROCm0: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
            "ROCm1: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
        ];
        let vulkan = vec![
            "Vulkan0: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
            "Vulkan1: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
        ];
        let placement = GpuPlacement {
            gpu_ids: vec!["runtime:rocm:ROCm1".into(), "runtime:rocm:ROCm0".into()],
            main_gpu: Some("runtime:rocm:ROCm1".into()),
            tensor_split: vec![3.0, 1.0],
            split_mode: SplitMode::Layer,
            draft_gpu_id: None,
        };

        let moved = remap_runtime_devices(&placement, "rocm", &rocm, "vulkan", &vulkan);
        assert_eq!(
            moved.placement.gpu_ids,
            vec!["runtime:vulkan:Vulkan1", "runtime:vulkan:Vulkan0"]
        );
        assert_eq!(
            moved.placement.main_gpu.as_deref(),
            Some("runtime:vulkan:Vulkan1")
        );
        // Order, ratios and split mode describe the same arrangement as before.
        assert_eq!(moved.placement.tensor_split, vec![3.0, 1.0]);
        assert_eq!(moved.placement.split_mode, SplitMode::Layer);
        assert!(moved.dropped.is_empty());

        // Selecting the same backend again changes nothing.
        let same = remap_runtime_devices(&placement, "rocm", &rocm, "rocm", &rocm);
        assert_eq!(same.placement, placement);
    }

    #[test]
    fn selecting_a_runtime_names_every_device_it_reports() {
        let devices = vec![
            "Vulkan0: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
            "Vulkan1: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
        ];
        assert_eq!(
            select_all_runtime_devices("vulkan", &devices),
            vec!["runtime:vulkan:Vulkan0", "runtime:vulkan:Vulkan1"]
        );
        // Lines belonging to another backend's prefix are not this backend's.
        assert!(select_all_runtime_devices("rocm", &devices).is_empty());
        // A backend with no per-device flag has nothing to name.
        assert!(select_all_runtime_devices("cpu", &devices).is_empty());
        assert!(select_all_runtime_devices("vulkan", &[]).is_empty());
    }

    #[test]
    fn a_card_with_no_counterpart_is_dropped_and_named_rather_than_guessed() {
        let rocm = vec![
            "ROCm0: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
            "ROCm1: AMD Radeon AI PRO R9700 (32624 MiB)".to_string(),
        ];
        // The new backend only reports one of the two cards.
        let vulkan = vec!["Vulkan0: AMD Radeon AI PRO R9700 (32624 MiB)".to_string()];
        let placement = GpuPlacement {
            gpu_ids: vec!["runtime:rocm:ROCm0".into(), "runtime:rocm:ROCm1".into()],
            tensor_split: vec![1.0, 1.0],
            ..GpuPlacement::default()
        };

        let moved = remap_runtime_devices(&placement, "rocm", &rocm, "vulkan", &vulkan);
        assert_eq!(moved.placement.gpu_ids, vec!["runtime:vulkan:Vulkan0"]);
        assert_eq!(moved.dropped, vec!["runtime:rocm:ROCm1"]);
        // Ratios are positional, so a shorter list must not silently re-weight.
        assert!(moved.placement.tensor_split.is_empty());

        // With no readable list for the previous backend, nothing is invented.
        let blind = remap_runtime_devices(&placement, "rocm", &[], "vulkan", &vulkan);
        assert!(blind.placement.gpu_ids.is_empty());
        assert_eq!(blind.dropped.len(), 2);

        // A hardware stable id already names the card itself and carries over.
        let hardware = GpuPlacement {
            gpu_ids: vec!["10de:2684#0000".into()],
            ..GpuPlacement::default()
        };
        let kept = remap_runtime_devices(&hardware, "rocm", &rocm, "vulkan", &vulkan);
        assert_eq!(kept.placement.gpu_ids, vec!["10de:2684#0000"]);
        assert!(kept.dropped.is_empty());
    }

    #[test]
    fn vulkan_auto_placement_rejects_duplicate_runtime_gpus() {
        let runtime_devices = vec![
            "Vulkan0: AMD Radeon AI PRO R9700 (32768 MiB)".to_string(),
            "Vulkan1: AMD Radeon AI PRO R9700 (32768 MiB)".to_string(),
        ];

        let error =
            validate_safe_auto_placement(&GpuPlacement::default(), "vulkan", &runtime_devices)
                .expect_err("automatic multi-GPU Vulkan placement should be explicit");

        assert!(error.contains("select"));
        assert!(error.contains("GPU"));
    }
}
