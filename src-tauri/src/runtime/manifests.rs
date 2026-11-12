use super::*;

pub(super) fn compatible_manifest(root: &Path, name: &str) -> PathBuf {
    let current = root.join(name);
    if current.exists() {
        current
    } else {
        root.join(name.replacen("aiolm-", "llama-board-", 1))
    }
}

pub(super) fn write_version_manifest(dir: &Path, version: &RuntimeVersion) {
    if let Ok(json) = serde_json::to_string(version) {
        let _ = fs::write(dir.join(VERSION_MANIFEST), json);
    }
}

pub(super) fn write_source_manifest(dir: &Path, source: &RuntimeSource) -> Result<(), String> {
    let json = serde_json::to_string(source)
        .map_err(|error| format!("failed to encode source manifest: {error}"))?;
    fs::write(dir.join(SOURCE_MANIFEST), json)
        .map_err(|error| format!("failed to record source manifest: {error}"))
}

pub(super) fn read_version_manifest(dir: &Path) -> Option<RuntimeVersion> {
    let raw = fs::read_to_string(compatible_manifest(dir, VERSION_MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(super) fn read_source_manifest(dir: &Path) -> Option<RuntimeSource> {
    let raw = fs::read_to_string(compatible_manifest(dir, SOURCE_MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}
