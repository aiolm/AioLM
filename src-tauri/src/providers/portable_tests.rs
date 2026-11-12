use super::*;

fn synthetic_platform() -> PortablePlatform {
    PortablePlatform {
        os: current_os().into(),
        arch: current_arch().into(),
        python_version: "3.12.4".into(),
        python_implementation: "CPython".into(),
        python_abi: "cpython-312-test".into(),
        macos_version: String::new(),
    }
}

fn synthetic_probe(provider: ProviderId) -> python_env::ProbeRecord {
    let mut packages = BTreeMap::new();
    match provider {
        ProviderId::Vllm => {
            for (name, version) in [
                ("torch", "2.4.0"),
                ("transformers", "4.44.0"),
                ("tokenizers", "0.19.0"),
                ("safetensors", "0.4.0"),
                ("numpy", "1.26.0"),
            ] {
                packages.insert(name.into(), version.into());
            }
            python_env::ProbeRecord {
                version: "0.31.0".into(),
                variant: "standard".into(),
                python_version: "3.12.4".into(),
                python_arch: current_arch().into(),
                python_implementation: "CPython".into(),
                python_abi: "cpython-312-test".into(),
                platform_system: match current_os() {
                    "macos" => "Darwin",
                    "linux" => "Linux",
                    "windows" => "Windows",
                    other => other,
                }
                .into(),
                accelerator: "cpu".into(),
                package_versions: packages,
                server_flags: vec!["--host".into(), "--port".into()],
                ..Default::default()
            }
        }
        ProviderId::MlxVlm => {
            for (name, version) in [
                ("mlx", "0.20.0"),
                ("mlx-lm", "0.20.0"),
                ("transformers", "4.44.0"),
                ("tokenizers", "0.19.0"),
                ("safetensors", "0.4.0"),
                ("numpy", "1.26.0"),
            ] {
                packages.insert(name.into(), version.into());
            }
            python_env::ProbeRecord {
                version: "0.7.6".into(),
                python_version: "3.12.4".into(),
                python_arch: current_arch().into(),
                python_implementation: "CPython".into(),
                python_abi: "cpython-312-test".into(),
                platform_system: match current_os() {
                    "macos" => "Darwin",
                    "linux" => "Linux",
                    "windows" => "Windows",
                    other => other,
                }
                .into(),
                accelerator: "cpu".into(),
                package_versions: packages,
                server_flags: vec!["--host".into()],
                ..Default::default()
            }
        }
        ProviderId::Llama | ProviderId::Custom(_) => Default::default(),
    }
}

/// Wheel filenames escape `-`/`_` in the distribution part as `_`; the
/// parser normalizes them back, so dashed names round-trip exactly.
fn synthetic_wheel_filename(name: &str, version: &str) -> String {
    format!("{}-{version}-py3-none-any.whl", name.replace('-', "_"))
}

/// Index-installed freeze matching [`synthetic_probe`]: every engine
/// dependency present, exact versions, no installer provenance.
fn synthetic_freeze(provider: ProviderId) -> FreezeMap {
    let probe = synthetic_probe(provider);
    let mut freeze = FreezeMap::new();
    for (name, version) in &probe.package_versions {
        freeze.insert(
            normalize_dist(name),
            FrozenDist {
                portable_commit: String::new(),
                version: version.clone(),
                direct_url: None,
            },
        );
    }
    let engine = normalize_dist(python_env::package_name(provider));
    freeze.insert(
        engine,
        FrozenDist {
            portable_commit: String::new(),
            version: probe.version.clone(),
            direct_url: None,
        },
    );
    if provider == ProviderId::Vllm && !probe.metal_version.is_empty() {
        freeze.insert(
            "vllm-metal".into(),
            FrozenDist {
                portable_commit: String::new(),
                version: probe.metal_version.clone(),
                direct_url: None,
            },
        );
    }
    freeze
}

fn synthetic_manifest(provider: ProviderId) -> PortableManifest {
    let probe = synthetic_probe(provider);
    let freeze = synthetic_freeze(provider);
    // The probe carries engine extras the freeze supersedes; align them so
    // the recipe reflects one coherent environment.
    let mut probe = probe;
    probe.package_versions.remove("vllm-metal");
    let sources = export_freeze(provider, &probe, &freeze).unwrap();
    let packages: BTreeMap<String, String> = sources
        .keys()
        .map(|name| (name.clone(), freeze[name].version.clone()))
        .collect();
    let wheels = packages
        .iter()
        .map(|(name, version)| {
            let filename = synthetic_wheel_filename(name, version);
            let bytes = synthetic_wheel_bytes(name, version);
            PortableWheel {
                name: name.clone(),
                version: version.clone(),
                filename,
                sha256: sha256_bytes(&bytes),
                size: bytes.len() as u64,
            }
        })
        .collect();
    PortableManifest {
        format: PORTABLE_FORMAT,
        kind: PORTABLE_KIND.into(),
        provider,
        variant: "standard".into(),
        version: probe.version.clone(),
        plugin_version: String::new(),
        mlx_version: probe.mlx_version.clone(),
        mlx_lm_commit: String::new(),
        platform: synthetic_platform(),
        packages,
        sources: sources
            .into_iter()
            .map(|(name, source)| (name, source.to_owned()))
            .collect(),
        wheels,
        constraints: String::new(),
    }
}

fn synthetic_wheel_bytes(name: &str, version: &str) -> Vec<u8> {
    synthetic_wheel_bytes_full(name, version, &[])
}

/// Spec-valid pure-Python wheels `pip install` accepts offline: METADATA,
/// WHEEL and a RECORD with real hashes, plus optional dependencies so the
/// end-to-end test proves closure resolution from local files only.
fn synthetic_wheel_bytes_full(name: &str, version: &str, requires: &[&str]) -> Vec<u8> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::Digest as _;
    let dist = name.replace('-', "_");
    let prefix = format!("{dist}-{version}.dist-info");
    let mut metadata = format!("Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n");
    for dep in requires {
        metadata.push_str(&format!("Requires-Dist: {dep}\n"));
    }
    let wheel =
        "Wheel-Version: 1.0\nGenerator: aiolm-portable-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n";
    let module = format!("{dist}.py");
    let module_body = format!("VALUE = {version:?}\n");
    let mut files: Vec<(String, Vec<u8>)> = vec![
        (format!("{prefix}/METADATA"), metadata.into_bytes()),
        (format!("{prefix}/WHEEL"), wheel.as_bytes().to_vec()),
        (module, module_body.into_bytes()),
    ];
    let mut record = String::new();
    for (path, bytes) in &files {
        let digest = URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(bytes));
        record.push_str(&format!("{path},sha256={digest},{}\n", bytes.len()));
    }
    record.push_str(&format!("{prefix}/RECORD,,\n"));
    files.push((format!("{prefix}/RECORD"), record.into_bytes()));
    let mut buffer = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        // Fixed entry time: callers hash these bytes and later rebuild the
        // same wheel, so the wall-clock default would make them differ.
        let options =
            zip::write::SimpleFileOptions::default().last_modified_time(zip::DateTime::default());
        for (path, bytes) in &files {
            writer.start_file(path, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }
    buffer
}

fn write_wheels_dir(manifest: &PortableManifest, dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    for wheel in &manifest.wheels {
        fs::write(
            dir.join(&wheel.filename),
            synthetic_wheel_bytes(&wheel.name, &wheel.version),
        )
        .unwrap();
    }
}

fn write_test_archive(manifest: &PortableManifest, path: &Path) {
    let dir = path
        .parent()
        .unwrap()
        .join(format!("stage-{}", short_nonce()));
    write_wheels_dir(manifest, &dir);
    let cancel = AtomicBool::new(false);
    write_archive(manifest, &dir, path, &cancel).unwrap();
    fs::remove_dir_all(&dir).unwrap();
}

/// Metal ready probe mirroring the pinned release (Apple Silicon macOS 15,
/// CPython 3.12, matched core/plugin, exact mlx-lm revision). Built here
/// because `metal_env::tests` is that module's private fixture.
fn ready_metal_probe() -> python_env::ProbeRecord {
    python_env::ProbeRecord {
        variant: metal_env::VARIANT.into(),
        version: metal_env::CORE_VERSION.into(),
        metal_version: metal_env::VERSION.into(),
        imported_version: metal_env::CORE_VERSION.into(),
        imported_metal_version: metal_env::VERSION.into(),
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
        mlx_version: metal_env::MLX_VERSION.into(),
        package_versions: BTreeMap::from([(
            "mlx-lm-commit".into(),
            metal_env::MLX_LM_COMMIT.into(),
        )]),
        metal_registry_scan: 1,
        ..Default::default()
    }
}

#[test]
fn manifest_constants_match_python_env() {
    // The portable publisher writes through the shared constants, so an
    // import is always readable by the public loader; a drift would
    // publish unreadable runtimes.
    assert_eq!(RUNTIME_MANIFEST_FILE, "aiolm-provider-runtime.json");
    assert_eq!(RUNTIME_MANIFEST_FORMAT, 1);
}

#[test]
fn portable_identities_stay_provider_scoped() {
    let id = portable_id("0.31.0");
    python_env::validate_id(&id).unwrap();
    assert!(id.starts_with("portable-"), "{id}");
    assert_ne!(portable_id("0.31.0"), portable_id("0.31.0"));
    let manifest = synthetic_manifest(ProviderId::Vllm);
    let encoded = serde_json::to_vec(&manifest).unwrap();
    let text = String::from_utf8(encoded).unwrap();
    assert!(!text.contains("backend"), "{text}");
    assert!(!text.contains("\"build\""), "{text}");
    assert!(text.contains("\"provider\":\"vllm\""), "{text}");
}

#[test]
fn dependency_closure_covers_the_full_freeze_and_agrees_with_the_probe() {
    for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
        let probe = synthetic_probe(provider);
        let freeze = synthetic_freeze(provider);
        let sources = export_freeze(provider, &probe, &freeze).unwrap();
        // Every active dependency travels, including declared bootstrap
        // dependencies; unrelated installed packages were excluded earlier.
        assert_eq!(sources.len(), freeze.len());
        assert_eq!(sources[python_env::package_name(provider)], SOURCE_PYPI);
        // A required identity missing from the freeze fails.
        let mut missing = freeze.clone();
        let first = required_packages(provider, "standard")[0];
        missing.remove(first);
        assert!(export_freeze(provider, &probe, &missing).is_err());
        // A skew between the probe and the freeze means the environment
        // changed mid-export and the recipe refuses to guess.
        let mut skew = freeze.clone();
        skew.insert(
            normalize_dist(python_env::package_name(provider)),
            FrozenDist {
                portable_commit: String::new(),
                version: "9.9.9".into(),
                direct_url: None,
            },
        );
        assert!(export_freeze(provider, &probe, &skew)
            .unwrap_err()
            .message
            .contains("changed between probing"));
    }
    // A declared pip dependency is included in the exact active closure.
    let probe = synthetic_probe(ProviderId::Vllm);
    let mut freeze = synthetic_freeze(ProviderId::Vllm);
    freeze.insert(
        "pip".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: "24.0".into(),
            direct_url: None,
        },
    );
    let sources = export_freeze(ProviderId::Vllm, &probe, &freeze).unwrap();
    assert!(sources.contains_key("pip"));
}

#[test]
fn export_rejects_unsupported_install_sources_explicitly() {
    let probe = synthetic_probe(ProviderId::Vllm);
    let base = synthetic_freeze(ProviderId::Vllm);
    // A VCS checkout cannot round-trip: reinstalling from a wheel drops
    // the revision the probe verifies, so the export names it instead of
    // fabricating provenance.
    let mut git = base.clone();
    git.insert(
        "mlx-lm".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: "0.3.4".into(),
            direct_url: Some(
                r#"{"url":"https://github.com/ml-explore/mlx-lm","vcs_info":{"vcs":"git","commit_id":"9e6acca691e64d6d8bb808c328fcdea459099cca"}}"#
                    .into(),
            ),
        },
    );
    assert!(export_freeze(ProviderId::Vllm, &probe, &git)
        .unwrap_err()
        .message
        .contains("git commit"));
    // A local directory install embeds a personal path and has no
    // reproducible wheel source.
    let mut local = base.clone();
    local.insert(
        "transformers".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: "4.44.0".into(),
            direct_url: Some(
                r#"{"url":"file:///home/user/src/transformers","dir_info":{}}"#.into(),
            ),
        },
    );
    assert!(export_freeze(ProviderId::Vllm, &probe, &local)
        .unwrap_err()
        .message
        .contains("unsupported source"));
    // Editables are live checkouts, not versions.
    let mut editable = base.clone();
    editable.insert(
        "tokenizers".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: "0.19.0".into(),
            direct_url: Some(
                r#"{"url":"file:///home/user/src/tokenizers","dir_info":{"editable":true}}"#.into(),
            ),
        },
    );
    assert!(export_freeze(ProviderId::Vllm, &probe, &editable)
        .unwrap_err()
        .message
        .contains("editable"));
    // Unknown archive hosts are not reproducible sources.
    let mut mirror = base.clone();
    mirror.insert(
        "safetensors".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: "0.4.0".into(),
            direct_url: Some(
                r#"{"url":"https://mirror.example.invalid/safetensors-0.4.0-py3-none-any.whl","archive_info":{"hash":"sha256=00"}}"#.into(),
            ),
        },
    );
    assert!(export_freeze(ProviderId::Vllm, &probe, &mirror)
        .unwrap_err()
        .message
        .contains("unsupported"));
    // An index wheel reinstall reproduces from the pinned version.
    let mut index = base.clone();
    index.insert(
        "safetensors".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: "0.4.0".into(),
            direct_url: Some(
                r#"{"url":"https://files.pythonhosted.org/packages/safetensors-0.4.0-py3-none-any.whl","archive_info":{"hash":"sha256=00"}}"#.into(),
            ),
        },
    );
    let sources = export_freeze(ProviderId::Vllm, &probe, &index).unwrap();
    assert_eq!(sources["safetensors"], SOURCE_PYPI);
}

#[test]
fn freeze_parsing_trusts_only_the_marked_line() {
    let stdout = "WARNING: engine printed noise\nAIOLM_FREEZE=[{\"name\":\"vLLM\",\"version\":\"0.31.0\",\"direct_url\":null},{\"name\":\"torch\",\"version\":\"2.4.0\",\"direct_url\":null}]\n";
    let freeze = parse_freeze_output(stdout).unwrap();
    assert_eq!(freeze["vllm"].version, "0.31.0");
    assert_eq!(freeze["torch"].version, "2.4.0");
    assert!(parse_freeze_output("no marker").is_err());
    assert!(parse_freeze_output("AIOLM_FREEZE=[{\"name\":\"x\"}]").is_err());
}

#[test]
fn pinned_release_wheels_keep_their_fragment_verified_source() {
    // The Metal core/plugin ship as GitHub release assets, never PyPI:
    // the installed archive URL must match the pinned asset, and the
    // download pin carries the `#sha256` fragment pip verifies.
    let mut probe = synthetic_probe(ProviderId::Vllm);
    probe.variant = metal_env::VARIANT.into();
    probe.version = metal_env::CORE_VERSION.into();
    probe.metal_version = metal_env::VERSION.into();
    probe.mlx_version = metal_env::MLX_VERSION.into();
    let mut freeze = FreezeMap::new();
    for (name, version) in [
        ("vllm", metal_env::CORE_VERSION),
        ("mlx", metal_env::MLX_VERSION),
        ("transformers", "4.44.0"),
    ] {
        freeze.insert(
            name.into(),
            FrozenDist {
                portable_commit: String::new(),
                version: version.into(),
                direct_url: None,
            },
        );
    }
    freeze.insert(
        "vllm-metal".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: metal_env::VERSION.into(),
            direct_url: Some(format!(
                "{{\"url\":\"{}\",\"archive_info\":{{}}}}",
                metal_env::PLUGIN_WHEEL.split('#').next().unwrap()
            )),
        },
    );
    // The pinned pure-Python mlx-lm capture carries checked file hashes.
    freeze.insert(
        "mlx-lm".into(),
        FrozenDist {
            portable_commit: String::new(),
            version: "0.3.4".into(),
            direct_url: Some(
                format!(
                    "{{\"url\":\"https://{MLX_LM_UPSTREAM}\",\"vcs_info\":{{\"vcs\":\"git\",\"commit_id\":\"{}\"}}}}",
                    metal_env::MLX_LM_COMMIT
                ),
            ),
        },
    );
    let sources = export_freeze(ProviderId::Vllm, &probe, &freeze).unwrap();
    assert_eq!(sources["mlx-lm"], "pinned-git");
    assert_eq!(sources["vllm-metal"], SOURCE_RELEASE_URL);
    let args = download_args(&freeze, &sources_owned(&sources), "vllm-metal");
    assert!(
        args.iter().any(|arg| arg
            .starts_with("vllm-metal @ https://github.com/vllm-project/vllm-metal/")
            && arg.contains("#sha256=")),
        "{args:?}"
    );
    assert!(args.iter().any(|arg| arg == "mlx==0.32.1"), "{args:?}");
    assert!(!args.iter().any(|arg| arg.starts_with("mlx-lm")));
}

fn sources_owned(sources: &BTreeMap<String, &'static str>) -> BTreeMap<String, String> {
    sources
        .iter()
        .map(|(name, source)| (name.clone(), source.to_string()))
        .collect()
}

#[test]
fn export_manifest_carries_no_personal_paths() {
    for provider in [ProviderId::Vllm, ProviderId::MlxVlm] {
        let manifest = synthetic_manifest(provider);
        validate_manifest(&manifest).unwrap();
        let text = serde_json::to_string(&manifest).unwrap();
        for marker in ["/home/", "/Users/", "C:\\Users", "C:/Users", "backend"] {
            assert!(!text.contains(marker), "{marker} in {text}");
        }
    }
}

#[test]
fn archive_round_trip_verifies_hashes() {
    let root = std::env::temp_dir().join(format!("aiolm-portable-roundtrip-{}", short_nonce()));
    fs::create_dir_all(&root).unwrap();
    let manifest = synthetic_manifest(ProviderId::Vllm);
    let path = root.join("bundle.zip");
    write_test_archive(&manifest, &path);
    let cancel = AtomicBool::new(false);
    let (read, wheels) = read_archive(&path, &cancel).unwrap();
    assert_eq!(read, manifest);
    assert_eq!(wheels.len(), manifest.wheels.len());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn import_extracts_verified_wheels_into_private_home_staging() {
    let root = std::env::temp_dir().join(format!("aiolm-portable-private-{}", short_nonce()));
    fs::create_dir_all(&root).unwrap();
    let manifest = synthetic_manifest(ProviderId::Vllm);
    let archive = root.join("bundle.zip");
    write_test_archive(&manifest, &archive);
    let home = root.join("home");
    let (verified, staging) = read_archive_files(&archive, &AtomicBool::new(false), &home).unwrap();
    assert_eq!(verified, manifest);
    assert_eq!(staging.0.parent(), Some(home.as_path()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&staging.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    for wheel in &manifest.wheels {
        assert!(staging.0.join(&wheel.filename).is_file());
    }
    let path = staging.0.clone();
    drop(staging);
    assert!(!path.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tampered_wheel_bytes_are_rejected() {
    let root = std::env::temp_dir().join(format!("aiolm-portable-tamper-{}", short_nonce()));
    fs::create_dir_all(&root).unwrap();
    let manifest = synthetic_manifest(ProviderId::Vllm);
    // Rebuild the archive with altered wheel content while the manifest
    // still carries the original hash, so reading must fail.
    let dir = root.join("altered");
    write_wheels_dir(&manifest, &dir);
    let first = &manifest.wheels[0];
    let mut bytes = fs::read(dir.join(&first.filename)).unwrap();
    bytes[10] ^= 0xFF;
    fs::write(dir.join(&first.filename), &bytes).unwrap();
    let cancel = AtomicBool::new(false);
    let altered = root.join("altered.zip");
    // The manifest still carries the original hash, so reading must fail.
    let file = fs::File::create(&altered).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file(PORTABLE_MANIFEST_NAME, options).unwrap();
    writer
        .write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    for wheel in &manifest.wheels {
        writer
            .start_file(format!("{PORTABLE_WHEELS_DIR}/{}", wheel.filename), options)
            .unwrap();
        writer
            .write_all(&fs::read(dir.join(&wheel.filename)).unwrap())
            .unwrap();
    }
    writer.finish().unwrap();
    let error = read_archive(&altered, &cancel).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(error.message.contains("SHA-256"), "{error}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn unsafe_paths_collisions_and_sources_are_rejected() {
    for bad in [
        "../escape.zip",
        "/absolute.zip",
        "wheels\\win.zip",
        "C:/win.zip",
        "wheels/../../escape.whl",
    ] {
        assert!(safe_archive_path(bad).is_err(), "{bad}");
    }
    assert!(safe_archive_path("wheels/setup.py").is_err());
    assert!(safe_archive_path("wheels/pkg-1.0.tar.gz").is_err());
    assert!(safe_archive_path("wheels/nested/pkg-1.0-py3-none-any.whl").is_err());
    assert!(safe_archive_path("extra.txt").is_err());
    assert!(safe_archive_path(PORTABLE_MANIFEST_NAME).is_ok());
    assert!(safe_archive_path("wheels/synthetic_pkg-1.0-py3-none-any.whl").is_ok());
    // sdists are never valid wheel filenames.
    assert!(parse_wheel_filename("pkg-1.0.tar.gz").is_err());
    assert!(parse_wheel_filename("setup.py").is_err());
    // Duplicate wheel filenames collide.
    let mut manifest = synthetic_manifest(ProviderId::Vllm);
    manifest.wheels.push(manifest.wheels[0].clone());
    assert!(validate_manifest(&manifest)
        .unwrap_err()
        .message
        .contains("repeats"));
    // A wheel outside the recorded closure is rejected, not installed.
    let mut unknown = synthetic_manifest(ProviderId::Vllm);
    unknown
        .packages
        .insert("evil-tunnel".into(), "9.9.9".into());
    unknown
        .sources
        .insert("evil-tunnel".into(), SOURCE_PYPI.into());
    unknown.wheels.push(PortableWheel {
        name: "evil-tunnel".into(),
        version: "9.9.9".into(),
        filename: "evil_tunnel-9.9.9-py3-none-any.whl".into(),
        sha256: "0".repeat(64),
        size: 10,
    });
    assert!(validate_manifest(&unknown).is_ok());
    unknown.wheels.pop();
    assert!(validate_manifest(&unknown)
        .unwrap_err()
        .message
        .contains("has no vendored wheel"));
    // Sources without a reproducible kind are rejected before any install.
    let mut source = synthetic_manifest(ProviderId::Vllm);
    source.sources.insert("torch".into(), "git".into());
    assert!(validate_manifest(&source)
        .unwrap_err()
        .message
        .contains("no reproducible wheel source"));
}

#[test]
fn staged_extras_fail_instead_of_dropping_undeclared_dependencies() {
    // `pip download` resolving an undeclared latest dependency must fail
    // the export: silently dropping it would break the offline import.
    let root = std::env::temp_dir().join(format!("aiolm-portable-extra-{}", short_nonce()));
    fs::create_dir_all(&root).unwrap();
    let manifest = synthetic_manifest(ProviderId::Vllm);
    let dir = root.join("wheels");
    write_wheels_dir(&manifest, &dir);
    fs::write(
        dir.join("undeclared_latest-9.9.9-py3-none-any.whl"),
        synthetic_wheel_bytes("undeclared-latest", "9.9.9"),
    )
    .unwrap();
    let error = inventory_wheels(&manifest, &dir).unwrap_err();
    assert!(
        error
            .message
            .contains("not part of the recorded dependency closure"),
        "{error}"
    );
    assert!(!root.join("bundle.zip").exists());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn same_platform_gate_rejects_foreign_bundles() {
    let mut manifest = synthetic_manifest(ProviderId::Vllm);
    validate_manifest(&manifest).unwrap();
    check_compatible(&manifest, current_os(), current_arch()).unwrap();
    let foreign_os = if current_os() == "linux" {
        "macos"
    } else {
        "linux"
    };
    assert!(check_compatible(&manifest, foreign_os, current_arch())
        .unwrap_err()
        .message
        .contains("was built for"));
    let foreign_arch = if normalize_arch(current_arch()) == "x86_64" {
        "aarch64"
    } else {
        "x86_64"
    };
    assert!(check_compatible(&manifest, current_os(), foreign_arch)
        .unwrap_err()
        .message
        .contains("was built for"));
    manifest.platform.python_abi = "cpython-399-test".into();
    manifest.platform.python_version = "3.9.0".into();
    assert!(check_compatible(&manifest, current_os(), current_arch()).is_err());
}

#[test]
fn portable_archive_headers_match_their_vendored_identities() {
    let rebuild = |manifest: &mut PortableManifest| {
        manifest.wheels = manifest
            .packages
            .iter()
            .map(|(name, version)| {
                let bytes = synthetic_wheel_bytes(name, version);
                PortableWheel {
                    name: name.clone(),
                    version: version.clone(),
                    filename: synthetic_wheel_filename(name, version),
                    sha256: sha256_bytes(&bytes),
                    size: bytes.len() as u64,
                }
            })
            .collect();
    };
    let standard = synthetic_manifest(ProviderId::Vllm);
    let legacy_mlx_vlm = synthetic_manifest(ProviderId::MlxVlm);
    assert!(standard.plugin_version.is_empty() && standard.mlx_version.is_empty());
    assert!(legacy_mlx_vlm.plugin_version.is_empty() && legacy_mlx_vlm.mlx_version.is_empty());
    let mut reported_mlx_vlm = legacy_mlx_vlm.clone();
    reported_mlx_vlm.mlx_version = reported_mlx_vlm.packages["mlx"].clone();
    let mut unrelated_mlx = standard.clone();
    unrelated_mlx.mlx_version = "0.99.0".into();
    unrelated_mlx.packages.insert("mlx".into(), "0.20.0".into());
    unrelated_mlx
        .sources
        .insert("mlx".into(), SOURCE_PYPI.into());
    rebuild(&mut unrelated_mlx);

    // A standard vLLM fixture has no MLX/plugin member. Explicitly supply all
    // current Metal minima and sources before changing its variant and headers.
    let mut metal = standard.clone();
    metal.variant = metal_env::VARIANT.into();
    metal.version = metal_env::CORE_VERSION.into();
    metal.plugin_version = metal_env::VERSION.into();
    metal.mlx_version = metal_env::MLX_VERSION.into();
    metal.mlx_lm_commit = metal_env::MLX_LM_COMMIT.into();
    metal.platform = platform_of_probe(&ready_metal_probe());
    for (name, version, source) in [
        ("vllm", metal_env::CORE_VERSION, SOURCE_RELEASE_URL),
        ("vllm-metal", metal_env::VERSION, SOURCE_RELEASE_URL),
        ("mlx", metal_env::MLX_VERSION, SOURCE_PYPI),
    ] {
        metal.packages.insert(name.into(), version.into());
        metal.sources.insert(name.into(), source.into());
    }
    rebuild(&mut metal);
    // The existing Metal validator also permits this public distribution
    // spelling; preserve it with matching package/wheel metadata.
    let mut public_metal = metal.clone();
    public_metal.version = metal_env::VERSION.into();
    public_metal
        .packages
        .insert("vllm".into(), metal_env::VERSION.into());
    public_metal
        .sources
        .insert("vllm".into(), SOURCE_PYPI.into());
    rebuild(&mut public_metal);

    let controls = [
        ("vllm-empty-optionals", &standard),
        ("mlx-vlm-empty-optionals", &legacy_mlx_vlm),
        ("mlx-vlm-populated-mlx", &reported_mlx_vlm),
        ("vllm-unrelated-mlx", &unrelated_mlx),
        ("metal-cpu-distribution", &metal),
        ("metal-public-distribution", &public_metal),
    ];
    let fixture = PortableBoundaryFixture::new();
    let cancel = AtomicBool::new(false);
    let mut control_failures = Vec::new();
    for (label, manifest) in controls {
        for required in required_packages(manifest.provider, &manifest.variant) {
            assert!(
                manifest.packages.contains_key(*required),
                "{label}: {required}"
            );
            assert!(
                manifest.sources.contains_key(*required),
                "{label}: {required}"
            );
            assert!(
                manifest.wheels.iter().any(|wheel| wheel.name == *required),
                "{label}: {required}"
            );
        }
        let wheels = fixture.root.join(format!("control-{label}-wheels"));
        write_wheels_dir(manifest, &wheels);
        let output = fixture.root.join(format!("control-{label}.zip"));
        let validation_error = validate_manifest(manifest).err();
        let writer = write_archive(manifest, &wheels, &output, &cancel);
        println!(
            "PORTABLE_HEADER_CONTROL label={label} validation_error={validation_error:?} writer_error={:?} published={}",
            writer.as_ref().err(), output.is_file(),
        );
        if validation_error.is_some() || writer.is_err() || !output.is_file() {
            control_failures.push(label);
        }
    }
    // Coherent bundles must publish before contradictory cases are meaningful.
    assert!(
        control_failures.is_empty(),
        "clean controls failed: {control_failures:?}"
    );
    // Preserve the distinct imported-module/public-version exception. The
    // frozen distribution/header stay +cpu; this is not a package-version alias.
    let mut imported_public = ready_metal_probe();
    imported_public.imported_version = metal_env::VERSION.into();
    check_imported_probe(&metal, &imported_public).unwrap();
    let mut public_record = ready_metal_probe();
    public_record.version = metal_env::VERSION.into();
    public_record.imported_version = metal_env::VERSION.into();
    check_imported_probe(&public_metal, &public_record).unwrap();
    // The unchanged late gate independently refuses a different installed
    // MLX identity. This pure synthetic record is not an executed probe.
    let mut wrong_mlx = ready_metal_probe();
    wrong_mlx.mlx_version = "0.0.0".into();
    let late_mlx_error = check_imported_probe(&metal, &wrong_mlx).unwrap_err();
    println!("PORTABLE_HEADER_LATE_MLX error={late_mlx_error:?}");
    assert_eq!(
        late_mlx_error.message,
        "imported MLX version differs from the bundle"
    );

    let rows = [
        ("vllm-engine", &standard, "vllm"),
        ("mlx-vlm-engine", &legacy_mlx_vlm, "mlx-vlm"),
        ("metal-engine", &metal, "vllm"),
        ("metal-plugin", &metal, "vllm-metal"),
        ("metal-mlx", &metal, "mlx"),
        ("mlx-vlm-populated-mlx", &reported_mlx_vlm, "mlx"),
    ];
    let mut failures = Vec::new();
    for (label, clean, member) in rows {
        let mut skew = clean.clone();
        assert_ne!(skew.packages[member], "0.0.0");
        *skew.packages.get_mut(member).unwrap() = "0.0.0".into();
        // Real filenames, METADATA, RECORD, bytes, sizes and digests all follow
        // the changed package. Only the semantic header promise now disagrees.
        rebuild(&mut skew);
        let wheels = fixture.root.join(format!("skew-{label}-wheels"));
        write_wheels_dir(&skew, &wheels);
        let output = fixture.root.join(format!("skew-{label}.zip"));
        let validation_error = validate_manifest(&skew).err();
        let writer = write_archive(&skew, &wheels, &output, &cancel);
        println!(
            "PORTABLE_HEADER_SKEW label={label} member={member} package={} engine_header={} plugin_header={} mlx_header={} validation_error={validation_error:?} writer_error={:?} published={}",
            skew.packages[member], skew.version, skew.plugin_version, skew.mlx_version,
            writer.as_ref().err(), output.exists(),
        );
        if validation_error.is_none() || writer.is_ok() || output.exists() {
            failures.push(label);
        }
    }
    // Check every identity and clean all owned archives before reporting failure.
    drop(fixture);
    assert!(
        failures.is_empty(),
        "contradictory portable identities accepted: {failures:?}"
    );
}

#[test]
fn export_freeze_rejects_populated_mlx_identity_drift() {
    let metal_probe = ready_metal_probe();
    let mut metal_freeze = synthetic_freeze(ProviderId::Vllm);
    for (name, version) in [
        ("vllm", metal_env::CORE_VERSION),
        ("vllm-metal", metal_env::VERSION),
        ("mlx", metal_env::MLX_VERSION),
    ] {
        metal_freeze.insert(
            name.into(),
            FrozenDist {
                version: version.into(),
                direct_url: None,
                portable_commit: String::new(),
            },
        );
    }
    let mlx_freeze = synthetic_freeze(ProviderId::MlxVlm);
    let mut mlx_probe = synthetic_probe(ProviderId::MlxVlm);
    mlx_probe.mlx_version = mlx_freeze["mlx"].version.clone();
    let mut legacy_probe = mlx_probe.clone();
    legacy_probe.mlx_version.clear();
    let mut legacy_freeze = mlx_freeze.clone();
    legacy_freeze.get_mut("mlx").unwrap().version = "0.0.0".into();
    let mut unrelated_probe = synthetic_probe(ProviderId::Vllm);
    unrelated_probe.mlx_version = "0.99.0".into();
    let mut unrelated_freeze = synthetic_freeze(ProviderId::Vllm);
    unrelated_freeze.insert("mlx".into(), legacy_freeze["mlx"].clone());

    let controls = [
        (
            "metal-coherent",
            ProviderId::Vllm,
            &metal_probe,
            &metal_freeze,
        ),
        (
            "mlx-vlm-coherent",
            ProviderId::MlxVlm,
            &mlx_probe,
            &mlx_freeze,
        ),
        (
            "mlx-vlm-empty-optional",
            ProviderId::MlxVlm,
            &legacy_probe,
            &legacy_freeze,
        ),
        (
            "vllm-unrelated-mlx",
            ProviderId::Vllm,
            &unrelated_probe,
            &unrelated_freeze,
        ),
    ];
    let mut control_failures = Vec::new();
    for (label, provider, probe, freeze) in controls {
        for required in required_packages(provider, &probe.variant) {
            assert!(freeze.contains_key(*required), "{label}: {required}");
        }
        let result = export_freeze(provider, probe, freeze);
        let complete = result.as_ref().is_ok_and(|sources| {
            sources.len() == freeze.len() && sources.keys().all(|name| freeze.contains_key(name))
        });
        println!(
            "PORTABLE_FREEZE_CONTROL label={label} error={:?} complete={complete}",
            result.as_ref().err()
        );
        if !complete {
            control_failures.push(label);
        }
    }
    assert!(
        control_failures.is_empty(),
        "coherent freeze controls failed: {control_failures:?}"
    );

    let mut failures = Vec::new();
    for (label, provider, probe, freeze) in [
        ("metal-mlx", ProviderId::Vllm, &metal_probe, &metal_freeze),
        (
            "mlx-vlm-populated-mlx",
            ProviderId::MlxVlm,
            &mlx_probe,
            &mlx_freeze,
        ),
    ] {
        let mut drift = freeze.clone();
        drift.get_mut("mlx").unwrap().version = "0.0.0".into();
        let error = export_freeze(provider, probe, &drift).err();
        println!(
            "PORTABLE_FREEZE_DRIFT label={label} reported_mlx={} frozen_mlx={} error={error:?}",
            probe.mlx_version, drift["mlx"].version
        );
        if error.is_none() {
            failures.push(label);
        }
    }
    assert!(
        failures.is_empty(),
        "changed MLX inventory accepted before download: {failures:?}"
    );
}

#[test]
fn recipe_construction_rejects_populated_mlx_identity_drift() {
    let fixture = PortableBoundaryFixture::new();
    let python = fixture.root.join("synthetic-interpreter-file");
    let bytes = b"synthetic existing interpreter file; never executed";
    fs::write(&python, bytes).unwrap();
    let freeze = synthetic_freeze(ProviderId::MlxVlm);
    let mut probe = synthetic_probe(ProviderId::MlxVlm);
    probe.mlx_version = freeze["mlx"].version.clone();
    let manifest = python_env::PythonRuntimeManifest {
        format: RUNTIME_MANIFEST_FORMAT,
        provider: ProviderId::MlxVlm,
        id: "external-freshness".into(),
        kind: python_env::InstallationKind::External,
        python: python.to_string_lossy().into_owned(),
        requested_version: None,
        probe: Some(probe),
    };
    assert!(manifest.problems().is_empty(), "{:?}", manifest.problems());
    let recipe = build_export_manifest(&manifest, &freeze).unwrap();
    assert_eq!(recipe.packages["mlx"], recipe.mlx_version);
    assert!(recipe.wheels.is_empty());
    let mut drift = freeze.clone();
    drift.get_mut("mlx").unwrap().version = "0.0.0".into();
    let mut legacy = manifest.clone();
    legacy.probe.as_mut().unwrap().mlx_version.clear();
    assert!(legacy.problems().is_empty());
    let legacy_recipe = build_export_manifest(&legacy, &drift).unwrap();
    let legacy_accepted =
        legacy_recipe.mlx_version.is_empty() && legacy_recipe.packages["mlx"] == "0.0.0";
    assert!(legacy_accepted);
    let result = build_export_manifest(&manifest, &drift);
    let bytes_unchanged = fs::read(&python).unwrap() == bytes;
    println!("PORTABLE_RECIPE_DRIFT coherent_mlx={} empty_optional_accepted={legacy_accepted} reported_mlx={} frozen_mlx={} result_error={:?} interpreter_bytes_unchanged={bytes_unchanged}", recipe.mlx_version, manifest.probe.as_ref().unwrap().mlx_version, drift["mlx"].version, result.as_ref().err());
    assert!(bytes_unchanged);
    drop(fixture);
    assert!(
        result.is_err(),
        "recipe accepted changed MLX before wheel download"
    );
}

#[test]
fn metal_provenance_is_preserved_and_checked() {
    let mut manifest = synthetic_manifest(ProviderId::Vllm);
    manifest.variant = metal_env::VARIANT.into();
    manifest.version = metal_env::CORE_VERSION.into();
    manifest.plugin_version = metal_env::VERSION.into();
    manifest.mlx_version = metal_env::MLX_VERSION.into();
    manifest.mlx_lm_commit = metal_env::MLX_LM_COMMIT.into();
    manifest.platform = PortablePlatform {
        os: "macos".into(),
        arch: "arm64".into(),
        python_version: "3.12.7".into(),
        python_implementation: "CPython".into(),
        python_abi: "cpython-312-darwin".into(),
        macos_version: "15.0".into(),
    };
    for (name, version) in [
        ("vllm", metal_env::CORE_VERSION),
        ("vllm-metal", metal_env::VERSION),
        ("mlx", metal_env::MLX_VERSION),
    ] {
        manifest.packages.insert(name.into(), version.into());
        manifest.sources.insert(name.into(), SOURCE_PYPI.into());
    }
    manifest
        .sources
        .insert("vllm-metal".into(), SOURCE_RELEASE_URL.into());
    manifest
        .sources
        .insert("vllm".into(), SOURCE_RELEASE_URL.into());
    // Rebuild the wheel inventory from the final closure so filenames,
    // versions, sizes and hashes agree exactly.
    manifest.wheels = manifest
        .packages
        .iter()
        .map(|(name, version)| {
            let filename = synthetic_wheel_filename(name, version);
            let bytes = synthetic_wheel_bytes(name, version);
            PortableWheel {
                name: name.clone(),
                version: version.clone(),
                filename,
                sha256: sha256_bytes(&bytes),
                size: bytes.len() as u64,
            }
        })
        .collect();
    validate_manifest(&manifest).unwrap();
    // check_compatible with explicit macos/arm64 passes for the bundle.
    check_compatible(&manifest, "macos", "aarch64").unwrap();
    // Wrong ABI is rejected before anything installs.
    let mut abi = manifest.clone();
    abi.platform.python_abi = "cpython-313-darwin".into();
    abi.platform.python_version = "3.13.0".into();
    assert!(check_compatible(&abi, "macos", "aarch64")
        .unwrap_err()
        .message
        .contains("cp312"));
    // Altered source revision is rejected.
    let mut commit = manifest.clone();
    commit.mlx_lm_commit = "0".repeat(40);
    assert!(validate_manifest(&commit)
        .unwrap_err()
        .message
        .contains("mlx-lm"));
    let probe = ready_metal_probe();
    check_imported_probe(&manifest, &probe).unwrap();
    assert!(check_imported_probe(&commit, &probe)
        .unwrap_err()
        .message
        .contains("mlx-lm"));
    // Altered plugin version is rejected.
    let mut plugin = manifest.clone();
    plugin.plugin_version = "0.31.0".into();
    let probe = ready_metal_probe();
    assert!(check_imported_probe(&plugin, &probe).is_err());
}

#[test]
fn cancelled_archive_read_never_publishes() {
    let root = std::env::temp_dir().join(format!("aiolm-portable-cancel-{}", short_nonce()));
    fs::create_dir_all(&root).unwrap();
    let manifest = synthetic_manifest(ProviderId::Vllm);
    let path = root.join("bundle.zip");
    write_test_archive(&manifest, &path);
    let cancel = AtomicBool::new(true);
    let error = read_archive(&path, &cancel).unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
    assert!(error.message.contains("cancelled"), "{error}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn failed_probe_blocks_publication_and_cleans_staging() {
    // A probe with errors must never become a published runtime: the
    // gate below mirrors the check `import_into` runs before writing the
    // manifest, and staging cleanup removes the directory on failure.
    let manifest = synthetic_manifest(ProviderId::MlxVlm);
    let mut bad = synthetic_probe(ProviderId::MlxVlm);
    bad.errors.push("synthetic probe failure".into());
    assert!(check_imported_probe(&manifest, &bad).is_err());
    let staging = std::env::temp_dir().join(format!("aiolm-portable-staging-{}", short_nonce()));
    fs::create_dir_all(staging.join("venv")).unwrap();
    {
        let _cleanup = StagingCleanup(staging.clone());
    }
    assert!(!staging.exists());
}

#[test]
fn export_rejects_unhealthy_and_unknown_runtimes() {
    let freeze = synthetic_freeze(ProviderId::Vllm);
    let healthy = python_env::PythonRuntimeManifest {
        format: RUNTIME_MANIFEST_FORMAT,
        provider: ProviderId::Vllm,
        id: "external-synthetic".into(),
        kind: python_env::InstallationKind::External,
        python: "synthetic-python".into(),
        requested_version: None,
        probe: Some(synthetic_probe(ProviderId::Vllm)),
    };
    // problems() reports the missing interpreter file, so an export of a
    // broken registration is refused before any wheel work starts.
    assert!(!healthy.problems().is_empty());
    assert!(build_export_manifest(&healthy, &freeze).is_err());
    let llama = python_env::PythonRuntimeManifest {
        format: RUNTIME_MANIFEST_FORMAT,
        provider: ProviderId::Llama,
        id: "b0-cpu".into(),
        kind: python_env::InstallationKind::Managed,
        python: "synthetic".into(),
        requested_version: None,
        probe: None,
    };
    assert!(build_export_manifest(&llama, &freeze)
        .unwrap_err()
        .message
        .contains("only Python"));
}

#[tokio::test]
async fn import_cancelled_before_start_allocates_nothing() {
    // The pre-cancelled token must fail before any runtime directory is
    // allocated, so a cancelled import can never leave a partial runtime.
    let root = provider_root(ProviderId::Vllm);
    let before: Vec<String> = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let archive = std::env::temp_dir().join(format!("aiolm-portable-absent-{}.zip", short_nonce()));
    let cancel = Arc::new(AtomicBool::new(true));
    let error = import_bundle(&archive, cancel, |_| {}).await.unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
    assert!(error.message.contains("cancelled"), "{error}");
    let after: Vec<String> = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(before, after);
}

/// A base interpreter for the synthetic offline test, if the machine has
/// one. Temp fixtures only: nothing is installed outside the test root.
fn find_test_python() -> Option<(PathBuf, Vec<String>)> {
    for (program, prefix) in [
        ("python3", Vec::new()),
        ("python", Vec::new()),
        ("py", vec!["-3".to_owned()]),
    ] {
        let Ok(path) = which::which(program) else {
            continue;
        };
        let mut command = crate::procutil::std_command(&path);
        let mut args = prefix.clone();
        args.push("--version".to_owned());
        command.env_clear().args(&args);
        let Ok(output) = crate::procutil::capture_stdout_cancellable(
            &mut command,
            Duration::from_secs(20),
            4096,
            None,
        ) else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        let version = text
            .lines()
            .next()
            .and_then(python_env::parse_python_version)?;
        if version >= (3, 10) {
            return Some((path, prefix));
        }
    }
    None
}

fn run_test_python(
    base: &(PathBuf, Vec<String>),
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut command = crate::procutil::std_command(&base.0);
    let mut full: Vec<String> = base.1.clone();
    full.extend(args.iter().map(|arg| arg.to_string()));
    command
        .env_clear()
        .envs(python_env::engine_environment())
        .args(&full);
    crate::procutil::capture_stdout_cancellable(&mut command, timeout, 16 * 1024 * 1024, None)
        .map_err(|error| error.to_string())
}

#[test]
fn synthetic_offline_venv_install_resolves_closure_and_reports_identity() {
    // Real mechanism, synthetic packages: build two spec-valid wheels with
    // a dependency edge, create an isolated venv, install strictly offline
    // with the exact flags `import_into` uses, then probe the installed
    // versions through the venv interpreter. No network, no user envs.
    let Some(base) = find_test_python() else {
        eprintln!("SKIP: no Python 3.10+ interpreter for the offline venv test");
        return;
    };
    let root = std::env::temp_dir().join(format!("aiolm-portable-e2e-{}", short_nonce()));
    let _cleanup = StagingCleanup(root.clone());
    let links = root.join("wheels");
    fs::create_dir_all(&links).unwrap();
    let engine_wheel = ("synthetic-engine", "1.0.0");
    let lib_wheel = ("synthetic-lib", "2.0.0");
    for (name, version, requires) in [
        (
            engine_wheel.0,
            engine_wheel.1,
            vec!["synthetic-lib"].as_slice(),
        ),
        (lib_wheel.0, lib_wheel.1, vec![].as_slice()),
    ] {
        let filename = synthetic_wheel_filename(name, version);
        fs::write(
            links.join(filename),
            synthetic_wheel_bytes_full(name, version, requires),
        )
        .unwrap();
    }
    let venv = root.join("venv");
    let created = run_test_python(
        &base,
        &["-m", "venv", &venv.to_string_lossy()],
        Duration::from_secs(300),
    );
    if created.is_err_and(|error| {
        eprintln!("SKIP: venv creation failed ({error})");
        true
    }) {
        let _ = fs::remove_dir_all(&root);
        return;
    }
    let venv_python = if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    };
    assert!(venv_python.is_file(), "venv interpreter missing");
    // Exactly the offline install contract `import_into` enforces.
    let status = run_test_python(
        &(venv_python.clone(), Vec::new()),
        &[
            "-I",
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            "--only-binary=:all:",
            "--no-input",
            "--disable-pip-version-check",
            "--find-links",
            &links.to_string_lossy(),
            "synthetic-engine==1.0.0",
            "synthetic-lib==2.0.0",
        ],
        Duration::from_secs(300),
    )
    .unwrap();
    assert!(
        status.status.success(),
        "offline install failed: {}",
        String::from_utf8_lossy(&status.stderr)
    );
    // Probe the installed identities through the new interpreter.
    let probed = run_test_python(
        &(venv_python, Vec::new()),
        &[
            "-I",
            "-c",
            "import importlib.metadata as m,json;print('AIOLM_PROBE='+json.dumps({'synthetic-engine':m.version('synthetic-engine'),'synthetic-lib':m.version('synthetic-lib')}))",
        ],
        Duration::from_secs(60),
    )
    .unwrap();
    assert!(probed.status.success());
    let text = String::from_utf8_lossy(&probed.stdout).into_owned();
    let line = text
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("AIOLM_PROBE="))
        .unwrap();
    let versions: BTreeMap<String, String> = serde_json::from_str(line).unwrap();
    assert_eq!(versions["synthetic-engine"], "1.0.0");
    // The dependency edge resolved from local wheels only.
    assert_eq!(versions["synthetic-lib"], "2.0.0");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn portable_ids_preserve_random_suffix_for_long_accepted_versions() {
    let mut failures = Vec::new();
    for version in [
        "0.31.0".to_owned(),
        "1".repeat(54),
        "1".repeat(64),
        "V1.0+RC1".to_owned(),
        "!!!".to_owned(),
    ] {
        assert!(valid_version(&version));
        let first = portable_id(&version);
        let second = portable_id(&version);
        for id in [&first, &second] {
            python_env::validate_id(id).unwrap();
            assert!(id.starts_with("portable-") && id.len() <= 64, "{id}");
            let suffix = id.rsplit_once('-').unwrap().1;
            if suffix.len() != 12 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                failures.push(format!(
                    "version length {} lost its twelve-digit nonce: {id}",
                    version.len()
                ));
            }
        }
        if first == second {
            failures.push(format!(
                "version length {} reused the same runtime identity: {first}",
                version.len()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

struct PortableBoundaryFixture {
    base: PathBuf,
    root: PathBuf,
}

impl PortableBoundaryFixture {
    fn new() -> Self {
        let base = std::env::temp_dir().canonicalize().unwrap();
        let root = base.join(format!("aiolm-portable-boundary-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        assert_eq!(root.parent(), Some(base.as_path()));
        Self { base, root }
    }
}

impl Drop for PortableBoundaryFixture {
    fn drop(&mut self) {
        let owned = self.root.canonicalize().unwrap();
        assert_eq!(owned, self.root);
        assert_eq!(owned.parent(), Some(self.base.as_path()));
        fs::remove_dir_all(owned).unwrap();
    }
}

// Build malformed archive inputs without going through the writer's gate;
// every vendored wheel still has the fixture's real bytes and digest.
fn write_raw_manifest_fixture(manifest: &PortableManifest, path: &Path) {
    let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive.start_file(PORTABLE_MANIFEST_NAME, options).unwrap();
    archive
        .write_all(&serde_json::to_vec(manifest).unwrap())
        .unwrap();
    for wheel in &manifest.wheels {
        archive
            .start_file(format!("{PORTABLE_WHEELS_DIR}/{}", wheel.filename), options)
            .unwrap();
        archive
            .write_all(&synthetic_wheel_bytes(&wheel.name, &wheel.version))
            .unwrap();
    }
    archive.finish().unwrap();
}

#[tokio::test]
async fn personal_path_case_variants_are_rejected_at_public_archive_boundaries() {
    let fixture = PortableBoundaryFixture::new();
    let mut clean = synthetic_manifest(ProviderId::Vllm);
    // A reader that accepts the manifest stops at the existing platform
    // gate, before provider roots or any interpreter are considered.
    clean.platform.os = "synthetic-foreign".into();
    validate_manifest(&clean).unwrap();
    let wheels_dir = fixture.root.join("wheels");
    write_wheels_dir(&clean, &wheels_dir);
    let clean_path = fixture.root.join("clean.zip");
    let cancel = AtomicBool::new(false);
    write_archive(&clean, &wheels_dir, &clean_path, &cancel).unwrap();
    let (round_trip, wheels) = read_archive(&clean_path, &cancel).unwrap();
    assert_eq!(round_trip, clean);
    assert_eq!(wheels.len(), clean.wheels.len());
    let clean_import_error = import_bundle(&clean_path, Arc::new(AtomicBool::new(false)), |_| {
        panic!("a foreign-platform fixture must never start installation")
    })
    .await
    .unwrap_err();
    assert!(clean_import_error
        .message
        .contains("built for synthetic-foreign"));

    let mut failures = Vec::new();
    for (index, marker) in [
        "/home/synthetic/private",
        "/Users/synthetic/private",
        "/uSeRs/synthetic/private",
        "C:/Users/synthetic/private",
        "c:/uSeRs/synthetic/private",
    ]
    .into_iter()
    .enumerate()
    {
        let mut manifest = clean.clone();
        manifest.constraints = marker.into();
        let validation_error = validate_manifest(&manifest).err();
        let output = fixture.root.join(format!("writer-{index}.zip"));
        let writer_error = write_archive(&manifest, &wheels_dir, &output, &cancel).err();
        if writer_error.is_some() {
            assert!(!output.exists());
        }
        let input = fixture.root.join(format!("reader-{index}.zip"));
        write_raw_manifest_fixture(&manifest, &input);
        let reader_error = import_bundle(&input, Arc::new(AtomicBool::new(false)), |_| {
            panic!("a manifest rejection must never start installation")
        })
        .await
        .unwrap_err();
        println!(
            "PORTABLE_PATH_BOUNDARIES marker={marker:?} validation={validation_error:?} writer={writer_error:?} reader={reader_error:?} published={}",
            output.exists()
        );
        for (boundary, error) in [
            ("validation", validation_error.as_ref()),
            ("public writer", writer_error.as_ref()),
            ("public import reader", Some(&reader_error)),
        ] {
            if !error.is_some_and(|error| error.message.contains("personal paths or credentials")) {
                failures.push(format!("{boundary} accepted {marker:?}: {error:?}"));
            }
        }
    }
    for wheel in &clean.wheels {
        assert_eq!(
            fs::read(wheels_dir.join(&wheel.filename)).unwrap(),
            synthetic_wheel_bytes(&wheel.name, &wheel.version)
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

const LOGGED_OUTPUT_TEST: &str =
    "providers::portable::tests::run_logged_preserves_lossy_output_and_owned_cancellation";
const RAW_OUTPUT_TEST: &str = "providers::portable::tests::portable_logged_raw_output_fixture";
const RAW_OUTPUT_MODE: &str = "__aiolm_portable_raw_output=";
const LOGGED_OUTPUT_ISOLATED: &str = "AIOLM_PORTABLE_LOGGED_OUTPUT_ISOLATED";
const LOGGED_CONTROL: &str = "PORTABLE_VALID_CONTROL";
const LOGGED_COMPLETE: &str = "PORTABLE_INVALID_COMPLETE";
const LOGGED_EOF: &str = "PORTABLE_EOF_INVALID=";

#[test]
fn run_logged_preserves_lossy_output_and_owned_cancellation() {
    if std::env::var_os(LOGGED_OUTPUT_ISOLATED).is_none() {
        // Isolate the panic observer from every other test's reader tasks.
        let mut command = crate::procutil::std_command(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                LOGGED_OUTPUT_TEST,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(LOGGED_OUTPUT_ISOLATED, "1");
        let output = crate::procutil::capture_output_cancellable(
            &mut command,
            Duration::from_secs(60),
            1024 * 1024,
            None,
        )
        .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        print!("{stdout}");
        eprint!("{stderr}");
        assert!(
            output.status.success(),
            "isolated output fixture failed: {stderr}"
        );
        assert!(stdout.contains("test result: ok. 1 passed"));
        return;
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(observe_logged_output());
}

async fn observe_logged_output() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    let cancel = Arc::new(AtomicBool::new(false));
    let panics = Arc::new(AtomicUsize::new(0));
    let observed_panics = panics.clone();
    let panic_cancel = cancel.clone();
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        observed_panics.fetch_add(1, Ordering::AcqRel);
        // A real detached-reader panic otherwise loses the completion line
        // and leaves this fixture waiting for the install timeout.
        panic_cancel.store(true, Ordering::Release);
        previous_hook(info);
    }));

    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let mode = format!(
        "{RAW_OUTPUT_MODE}line:{}",
        listener.local_addr().unwrap().port()
    );
    let progress = Arc::new(Mutex::new(Vec::<String>::new()));
    let delivered = progress.clone();
    let completed = Arc::new(AtomicBool::new(false));
    let delivered_complete = completed.clone();
    let progress_cancel = cancel.clone();
    let operation_cancel = cancel.clone();
    let program = std::env::current_exe().unwrap();
    let operation = crate::procutil::OwnedTask::from(tokio::spawn(async move {
        run_logged(
            &program,
            &[
                "--exact",
                RAW_OUTPUT_TEST,
                "--nocapture",
                "--test-threads=1",
                "--skip",
                &mode,
            ],
            &operation_cancel,
            move |line| {
                if line == LOGGED_COMPLETE {
                    delivered_complete.store(true, Ordering::Release);
                    progress_cancel.store(true, Ordering::Release);
                }
                delivered.lock().unwrap().push(line);
            },
            LoggedOperation::Portable,
        )
        .await
    }));
    // Deadlines only reclaim a broken fixture; success comes from output,
    // the actual cancellation result and the owned child's socket closing.
    let accepted = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await;
    let outcome = tokio::time::timeout(Duration::from_secs(10), operation).await;
    let socket_closed = if let Ok(Ok((mut peer, _))) = accepted {
        let mut byte = [0u8; 1];
        match tokio::time::timeout(
            Duration::from_secs(10),
            tokio::io::AsyncReadExt::read(&mut peer, &mut byte),
        )
        .await
        {
            Ok(Ok(0)) => true,
            Ok(Err(error)) => matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ),
            _ => false,
        }
    } else {
        false
    };
    let reader_panics = panics.load(Ordering::Acquire);
    let lines = progress.lock().unwrap().clone();
    let control = lines.iter().any(|line| line == LOGGED_CONTROL);
    let complete = completed.load(Ordering::Acquire);
    let lossy_line = lines.iter().find(|line| line.starts_with('\u{fffd}'));
    let bounded_line = lossy_line.is_some_and(|line| {
        line.len() <= MAX_OUTPUT_LINE + " [truncated]".len()
            && line.strip_suffix(" [truncated]").is_some_and(|prefix| {
                !prefix.is_empty() && prefix.chars().all(|ch| ch == '\u{fffd}')
            })
    });
    let cancelled =
        matches!(&outcome, Ok(Ok(Err(error))) if error.kind == crate::error::ErrorKind::Cancelled);

    // The no-newline stderr record must survive the real post-exit drain
    // into the failure tail. That stage deliberately has no progress call.
    let program = std::env::current_exe().unwrap();
    let mode = format!("{RAW_OUTPUT_MODE}eof");
    let eof_cancel = Arc::new(AtomicBool::new(false));
    let eof_outcome = tokio::time::timeout(
        Duration::from_secs(10),
        run_logged(
            &program,
            &[
                "--exact",
                RAW_OUTPUT_TEST,
                "--nocapture",
                "--test-threads=1",
                "--skip",
                &mode,
            ],
            &eof_cancel,
            |_| {},
            LoggedOperation::Portable,
        ),
    )
    .await;
    let eof_error = match &eof_outcome {
        Ok(Err(error)) => Some(error.message.as_str()),
        _ => None,
    };
    let eof_line = eof_error.and_then(|error| {
        error
            .split_once("failed (7): ")
            .and_then(|(_, tail)| tail.lines().find(|line| line.starts_with(LOGGED_EOF)))
    });
    let bounded_tail = eof_line.is_some_and(|line| {
        line.len() <= MAX_OUTPUT_LINE + " [truncated]".len()
            && line
                .strip_prefix(LOGGED_EOF)
                .and_then(|line| line.strip_suffix(" [truncated]"))
                .is_some_and(|payload| {
                    !payload.is_empty() && payload.chars().all(|ch| ch == '\u{fffd}')
                })
    });
    println!(
        "PORTABLE_LOGGED_OUTPUT reader_panics={reader_panics} control={control} complete={complete} lossy_line_bytes={:?} bounded_line={bounded_line} cancelled={cancelled} child_socket_closed={socket_closed} outcome={outcome:?} eof_line_bytes={:?} bounded_tail={bounded_tail} eof_failed_seven={}",
        lossy_line.map(String::len), eof_line.map(str::len), eof_error.is_some_and(|error| error.contains("failed (7):"))
    );
    let mut failures = Vec::new();
    for (passed, problem) in [
        (reader_panics == 0, "a real detached output reader panicked"),
        (control, "ordinary stdout progress was lost"),
        (complete, "stdout progress after invalid UTF-8 was lost"),
        (
            bounded_line,
            "lossy newline output lost its valid bounded record",
        ),
        (cancelled, "the real operation did not report cancellation"),
        (socket_closed, "the owned writer child was not reclaimed"),
        (
            eof_error.is_some_and(|error| error.contains("failed (7):")),
            "the actual child failure was lost",
        ),
        (
            bounded_tail,
            "the no-newline failure tail exceeded the output bound",
        ),
    ] {
        if !passed {
            failures.push(problem);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn portable_logged_raw_output_fixture() {
    // --skip is an inert libtest argument that carries this child-only
    // mode through run_logged's deliberately cleared environment.
    let Some(mode) =
        std::env::args().find_map(|arg| arg.strip_prefix(RAW_OUTPUT_MODE).map(str::to_owned))
    else {
        return;
    };
    if let Some(port) = mode.strip_prefix("line:") {
        let mut lifetime = std::net::TcpStream::connect((
            std::net::Ipv4Addr::LOCALHOST,
            port.parse::<u16>().unwrap(),
        ))
        .unwrap();
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "\n{LOGGED_CONTROL}").unwrap();
        stdout.write_all(&[0xff; MAX_OUTPUT_LINE]).unwrap();
        writeln!(stdout, "\n{LOGGED_COMPLETE}").unwrap();
        stdout.flush().unwrap();
        // This child cannot finish normally while its parent holds the
        // socket; EOF on the parent's peer therefore observes termination.
        let mut byte = [0u8; 1];
        let _ = std::io::Read::read(&mut lifetime, &mut byte);
    } else {
        assert_eq!(mode, "eof");
        let mut stderr = std::io::stderr().lock();
        stderr.write_all(LOGGED_EOF.as_bytes()).unwrap();
        stderr.write_all(&[0xff; MAX_OUTPUT_LINE]).unwrap();
        stderr.flush().unwrap();
        std::process::exit(7);
    }
}
