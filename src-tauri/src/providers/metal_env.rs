//! Managed Metal wheel policy and persisted probe validation.
//! Pins are taken from vllm-project/vllm-metal v0.30.0, not its development branch.
use super::python_env::{parse_python_version, ProbeRecord};

pub const VARIANT: &str = "vllm-metal";
pub const VERSION: &str = "0.30.0";
pub const CORE_VERSION: &str = "0.30.0+cpu";
pub const MLX_VERSION: &str = "0.32.1";
pub const MLX_LM_COMMIT: &str = "9e6acca691e64d6d8bb808c328fcdea459099cca";
pub const REQUIREMENTS: &str = "vllm-metal requires Apple Silicon macOS 15 or later and native arm64 CPython 3.12; managed installs pair vllm-metal 0.30.0 with vLLM 0.30.0+cpu.";

// Hash fragments make pip verify the release asset bytes, even if a tag's
// downloadable assets are replaced later. Both digests are release API metadata.
pub const CORE_WHEEL: &str = "https://github.com/vllm-project/vllm/releases/download/v0.30.0/vllm-0.30.0%2Bcpu-cp312-cp312-macosx_11_0_arm64.whl#sha256=fd9adfd566a8afa4ecbdf36b04bab10ebf43cd9ca18eca4b0a0bf2013b8de135";
pub const PLUGIN_WHEEL: &str = "https://github.com/vllm-project/vllm-metal/releases/download/v0.30.0/vllm_metal-0.30.0-cp312-cp312-macosx_15_0_arm64.whl#sha256=3955de8b2c75b633ef889b70fa469a4db661a0c5bb2f78e36272d68b16da9353";
pub const CONSTRAINTS: &str = include_str!("metal_constraints.txt");

pub fn eligible(os: &str, arch: &str, macos_version: &str) -> bool {
    os == "macos"
        && matches!(arch, "aarch64" | "arm64")
        && macos_version
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .is_some_and(|v| v >= 15)
}

pub fn interpreter_problems(record: &ProbeRecord) -> Vec<String> {
    let mut problems = Vec::new();
    if !eligible(
        if record.platform_system == "Darwin" {
            "macos"
        } else {
            &record.platform_system
        },
        &record.python_arch,
        &record.macos_version,
    ) {
        problems.push(REQUIREMENTS.into());
    }
    if parse_python_version(&record.python_version) != Some((3, 12))
        || record.python_implementation != "CPython"
        || record.python_abi != "cpython-312-darwin"
    {
        problems.push("vllm-metal release wheels require native CPython 3.12 (cp312 ABI)".into());
    }
    problems
}

/// Legacy standard probes remain valid. A Metal claim always needs explicit
/// provenance; installing MLX beside Linux CPU vLLM does not establish Metal.
pub fn probe_problems(record: &ProbeRecord) -> Vec<String> {
    if record.variant.is_empty() || record.variant == "standard" {
        return if !record.metal_version.is_empty() || record.accelerator == "metal" {
            vec!["vllm-metal requires a new probe with explicit Metal platform provenance".into()]
        } else {
            Vec::new()
        };
    }
    if record.variant != VARIANT {
        return vec![format!("unknown vLLM runtime variant: {}", record.variant)];
    }
    let mut problems = interpreter_problems(record);
    if record.metal_version != VERSION || !matches!(record.version.as_str(), VERSION | CORE_VERSION)
    {
        problems.push("supported vllm-metal 0.30.0 requires matching vLLM 0.30.0 core".into());
    }
    // Core setup.py can add +cpu to distribution metadata after writing the
    // imported _version.py. Accept only that known pinned build suffix split.
    let core_import_matches = record.imported_version == record.version
        || (record.version == CORE_VERSION && record.imported_version == VERSION);
    if !core_import_matches || record.imported_metal_version != record.metal_version {
        problems
            .push("imported vLLM/plugin versions differ from installed package metadata".into());
    }
    if record.mlx_version != MLX_VERSION {
        problems.push(format!(
            "vllm-metal 0.30.0 native wheel requires mlx=={MLX_VERSION}"
        ));
    }
    if record
        .package_versions
        .get("mlx-lm-commit")
        .is_none_or(|commit| commit != MLX_LM_COMMIT)
    {
        problems
            .push("mlx-lm source revision is missing or differs from the pinned vllm-metal dependency; probe an environment installed with the release dependencies".into());
    }
    if record.platform_class != "vllm_metal.platform.MetalPlatform"
        || record.accelerator != "metal"
        || !record.metal_available
        || !record.metal_native_importable
    {
        problems.push("vLLM did not select an available vllm-metal MetalPlatform".into());
    }
    if record.metal_registry_scan == 0 {
        problems.push("vllm-metal needs an installed loader registry probe before use".into());
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn ready_probe() -> ProbeRecord {
        ProbeRecord {
            variant: VARIANT.into(),
            version: CORE_VERSION.into(),
            metal_version: VERSION.into(),
            imported_version: CORE_VERSION.into(),
            imported_metal_version: VERSION.into(),
            python_version: "3.12.7".into(),
            python_arch: "arm64".into(),
            python_implementation: "CPython".into(),
            python_abi: "cpython-312-darwin".into(),
            platform_system: "Darwin".into(),
            macos_version: "15.0".into(),
            platform_class: "vllm_metal.platform.MetalPlatform".into(),
            accelerator: "metal".into(),
            metal_available: true,
            metal_native_importable: true,
            mlx_version: MLX_VERSION.into(),
            package_versions: std::collections::BTreeMap::from([(
                "mlx-lm-commit".into(),
                MLX_LM_COMMIT.into(),
            )]),
            metal_registry_scan: 1,
            ..Default::default()
        }
    }

    #[test]
    fn eligibility_requires_macos_15_and_native_apple_silicon() {
        assert!(eligible("macos", "aarch64", "15.0"));
        assert!(eligible("macos", "arm64", "26.1"));
        for (os, arch, version) in [
            ("macos", "aarch64", "14.9"),
            ("macos", "x86_64", "15.0"),
            ("windows", "aarch64", "15.0"),
            ("linux", "aarch64", "15.0"),
            ("macos", "aarch64", ""),
        ] {
            assert!(!eligible(os, arch, version));
        }
    }

    #[test]
    fn pinned_wheels_match_release_abi_version_and_integrity() {
        assert!(CORE_WHEEL
            .contains("/v0.30.0/vllm-0.30.0%2Bcpu-cp312-cp312-macosx_11_0_arm64.whl#sha256="));
        assert!(PLUGIN_WHEEL
            .contains("/v0.30.0/vllm_metal-0.30.0-cp312-cp312-macosx_15_0_arm64.whl#sha256="));
        assert!(CONSTRAINTS.contains("vllm==0.30.0+cpu"));
        assert!(CONSTRAINTS.contains("mlx==0.32.1"));
        assert!(!CORE_WHEEL.contains("latest") && !PLUGIN_WHEEL.contains("latest"));
    }

    #[test]
    fn metal_requires_provenance_and_rejects_each_wrong_machine_or_package() {
        let ready = ready_probe();
        assert!(probe_problems(&ready).is_empty());
        let mutations: Vec<fn(&mut ProbeRecord)> = vec![
            |r| r.python_arch = "x86_64".into(),
            |r| r.platform_system = "Linux".into(),
            |r| r.macos_version = "14.0".into(),
            |r| r.python_version = "3.13.0".into(),
            |r| r.python_abi = "cpython-313-darwin".into(),
            |r| r.python_implementation = "PyPy".into(),
            |r| r.metal_version = "0.31.0".into(),
            |r| r.version = "0.31.0".into(),
            |r| r.imported_version = "0.29.0".into(),
            |r| r.imported_metal_version.clear(),
            |r| r.mlx_version = "0.33.0".into(),
            |r| r.platform_class = "vllm.platforms.cpu.CpuPlatform".into(),
            |r| r.accelerator = "cpu".into(),
            |r| r.metal_available = false,
            |r| r.metal_native_importable = false,
            |r| r.metal_registry_scan = 0,
            |r| {
                r.package_versions.remove("mlx-lm-commit");
            },
            |r| {
                r.package_versions
                    .insert("mlx-lm-commit".into(), "0".repeat(40));
            },
        ];
        for mutate in mutations {
            let mut wrong = ready.clone();
            mutate(&mut wrong);
            assert!(!probe_problems(&wrong).is_empty(), "{wrong:?}");
        }
        let legacy: ProbeRecord =
            serde_json::from_str(r#"{"version":"0.31.0","accelerator":"cpu"}"#).unwrap();
        assert!(legacy.variant.is_empty());
        assert!(probe_problems(&legacy).is_empty());
        let mut fake = legacy;
        fake.accelerator = "metal".into();
        assert!(!probe_problems(&fake).is_empty());
    }

    #[test]
    fn cpu_distribution_suffix_preserves_imported_public_version_identity() {
        let mut record = ready_probe();
        record.imported_version = VERSION.into();
        assert!(probe_problems(&record).is_empty());
        record.imported_version = "0.29.0".into();
        assert!(!probe_problems(&record).is_empty());
    }
}
