//! Persistent help snapshots, descriptors and stored-value bridging.
//!
//! In-memory discovery (`HelpService`) rejects stale concurrent results and
//! invalidates caches on fingerprint change. This module gives the same
//! guarantees on disk: a snapshot is only reused when its fingerprint still
//! matches the current executable, declared artifacts, help argv, environment
//! (including locale), runtime version and parser. Changed builds never reuse
//! an old cache; the UI shows a config diff and retained values instead.
//!
//! Manifest v1 files remain readable. Help schemas live in sidecar files next
//! to each registration, so old registrations without a snapshot keep working
//! and no config migration is required. Stored profile values keep both
//! legacy scalar shapes and new override objects; unknown keys are retained
//! and block launch until reviewed.
use super::runtime_help::{HelpCommand, HelpReport, HelpService};
use super::runtime_help_parse::{diff_with_saved, SchemaDiff};
use super::runtime_options::{OptionIssue, OptionSchema, Override, ResolvedOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

/// A complete discovery result: the owned help run plus its parsed schema.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelpSnapshot {
    pub report: HelpReport,
    pub schema: OptionSchema,
}

/// Runtime descriptor shown across registration, settings and execution.
/// Help success never implies protocol readiness; a fresh model probe still
/// decides `Ready`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDescriptor {
    pub engine: String,
    pub runtime: String,
    pub fingerprint: String,
    pub help_complete: bool,
    pub schema: OptionSchema,
    pub diff: Option<SchemaDiff>,
    /// Saved keys retained but absent from the new schema.
    pub retained: Vec<String>,
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        && !value.starts_with(['-', '.'])
}

fn snapshot_root(root: &Path, engine: &str, runtime: &str) -> Result<PathBuf, String> {
    if !valid_segment(engine) || !valid_segment(runtime) {
        return Err("invalid engine or runtime identity for help snapshots".into());
    }
    // Engine IDs are `custom.*`; the directory layout mirrors registrations.
    let dir = root.join(engine).join(runtime).join("help");
    for component in [
        root.join(engine),
        root.join(engine).join(runtime),
        dir.clone(),
    ] {
        if std::fs::symlink_metadata(&component).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("help snapshot paths must not be symbolic links".into());
        }
    }
    Ok(dir)
}

fn snapshot_path_for(
    root: &Path,
    engine: &str,
    runtime: &str,
    fingerprint: &str,
) -> Result<PathBuf, String> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("help snapshot fingerprint must be SHA-256 hex".into());
    }
    Ok(snapshot_root(root, engine, runtime)?.join(format!("{fingerprint}.json")))
}

/// Persist a complete discovery result atomically. Partial or failed reports
/// never become snapshots; callers must rediscover instead.
pub fn save_snapshot(
    root: &Path,
    engine: &str,
    runtime: &str,
    snapshot: &HelpSnapshot,
) -> Result<PathBuf, String> {
    if !snapshot.report.complete() {
        return Err("only complete help results become persistent snapshots".into());
    }
    snapshot.schema.validate()?;
    if snapshot.schema.binding.fingerprint != snapshot.report.identity.fingerprint {
        return Err("snapshot schema must match its help fingerprint".into());
    }
    let path = snapshot_path_for(root, engine, runtime, &snapshot.report.identity.fingerprint)?;
    let bytes = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
    if bytes.len() > 3 * 1024 * 1024 {
        return Err("help snapshot exceeds 3 MiB".into());
    }
    crate::config::atomic_write(&path, &bytes)?;
    Ok(path)
}

/// Load a snapshot only when its fingerprint is requested. Callers compare
/// against the current `HelpCommand` identity; changed builds get `None`.
pub fn load_snapshot(
    root: &Path,
    engine: &str,
    runtime: &str,
    fingerprint: &str,
) -> Result<Option<HelpSnapshot>, String> {
    let path = snapshot_path_for(root, engine, runtime, fingerprint)?;
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 3 * 1024 * 1024 {
        return Err("help snapshot exceeds 3 MiB".into());
    }
    let snapshot: HelpSnapshot =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid help snapshot: {e}"))?;
    if !snapshot.report.complete() {
        return Ok(None);
    }
    snapshot.schema.validate()?;
    if snapshot.report.identity.fingerprint != fingerprint
        || snapshot.schema.binding.fingerprint != fingerprint
    {
        return Ok(None);
    }
    Ok(Some(snapshot))
}

/// The most recently saved snapshot for a runtime, if any.
pub fn latest_snapshot(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<Option<HelpSnapshot>, String> {
    let dir = snapshot_root(root, engine, runtime)?;
    let mut best: Option<(std::time::SystemTime, HelpSnapshot)> = None;
    let entries = std::fs::read_dir(&dir).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            return "no help snapshot for this runtime".to_string();
        }
        e.to_string()
    });
    let entries = match entries {
        Ok(entries) => entries,
        Err(message) if message.contains("no help snapshot") => return Ok(None),
        Err(message) => return Err(message),
    };
    for entry in entries.flatten().take(64) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(snapshot): Result<HelpSnapshot, _> = serde_json::from_slice(&bytes) else {
            continue;
        };
        if !snapshot.report.complete() {
            continue;
        }
        if snapshot.schema.validate().is_err() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(time, _)| modified >= *time) {
            best = Some((modified, snapshot));
        }
    }
    Ok(best.map(|(_, snapshot)| snapshot))
}

/// Describe the current discovery against the latest saved snapshot.
/// Saved values are never deleted; absent keys are reported as retained.
pub fn describe(
    engine: &str,
    runtime: &str,
    report: &HelpReport,
    schema: &OptionSchema,
    previous: Option<&HelpSnapshot>,
    saved_keys: &[String],
) -> Result<RuntimeDescriptor, String> {
    schema.validate()?;
    if schema.binding.fingerprint != report.identity.fingerprint {
        return Err("descriptor schema must match its help report".into());
    }
    let (diff, retained) = match previous {
        None => (None, Vec::new()),
        Some(old) => {
            let diff = diff_with_saved(&old.schema, schema, saved_keys);
            let retained = diff.retained_unknown.clone();
            (Some(diff), retained)
        }
    };
    Ok(RuntimeDescriptor {
        engine: engine.into(),
        runtime: runtime.into(),
        fingerprint: report.identity.fingerprint.clone(),
        help_complete: report.complete(),
        schema: schema.clone(),
        diff,
        retained,
    })
}

/// Convert stored profile values into new-style overrides.
///
/// Legacy scalar values (`4`, `true`, `"text"`) become a single occurrence
/// with a single value so existing profiles keep working. Values already
/// saved as `{occurrences, spelling}` pass through unchanged. Unknown keys
/// are preserved here and reported by `resolve`, never dropped.
pub fn overrides_from_map(map: &Map<String, Value>) -> BTreeMap<String, Override> {
    let mut out = BTreeMap::new();
    for (key, value) in map {
        if let Some(obj) = value.as_object() {
            if obj.contains_key("occurrences") {
                if let Ok(parsed) = serde_json::from_value::<Override>(value.clone()) {
                    out.insert(key.clone(), parsed);
                    continue;
                }
            }
        }
        out.insert(
            key.clone(),
            Override {
                spelling: None,
                occurrences: vec![vec![value.clone()]],
            },
        );
    }
    out
}

/// Convert overrides back to stored values. Single-occurrence single-value
/// overrides use the legacy scalar shape so old readers keep working;
/// repeated or multi-value overrides use the explicit object shape.
pub fn map_from_overrides(overrides: &BTreeMap<String, Override>) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in overrides {
        if value.spelling.is_none()
            && value.occurrences.len() == 1
            && value.occurrences[0].len() == 1
        {
            map.insert(key.clone(), value.occurrences[0][0].clone());
        } else if let Ok(encoded) = serde_json::to_value(value) {
            map.insert(key.clone(), encoded);
        }
    }
    map
}

/// Authoritative argv/request resolution for help-derived schemas.
/// Managed bindings stay rejected here; launch fills them from app-owned
/// selections, never from stored overrides, aliases or metadata.
pub fn resolve_stored(
    schema: &OptionSchema,
    scope: &[String],
    stored: &Map<String, Value>,
) -> Result<ResolvedOptions, Vec<OptionIssue>> {
    schema.resolve(scope, &overrides_from_map(stored))
}

/// Run shell-free discovery for one owner, parse, persist and describe.
/// The in-memory service cancels a previous discovery by the same owner; a
/// late predecessor can never publish. A changed executable or artifact
/// invalidates both the memory cache and the disk snapshot.
pub fn discover_persist_describe(
    service: &HelpService,
    root: &Path,
    owner: &str,
    engine: &str,
    runtime: &str,
    command: &HelpCommand,
    saved_keys: &[String],
) -> Result<(HelpReport, RuntimeDescriptor), String> {
    if !valid_segment(engine) || !valid_segment(runtime) {
        return Err("invalid engine or runtime identity for help snapshots".into());
    }
    let ticket = service.begin(owner)?;
    let cancel: AtomicBool = AtomicBool::new(false);
    // Link ticket cancellation to this run.
    let report = super::runtime_help::discover(command, &ticket.cancel)
        .inspect_err(|_| service.failed(&ticket))?;
    if cancel.load(std::sync::atomic::Ordering::Acquire) {
        service.failed(&ticket);
        return Err("help discovery cancelled".into());
    }
    let binding = super::runtime_options::SchemaBinding {
        engine: engine.into(),
        runtime: runtime.into(),
        fingerprint: report.identity.fingerprint.clone(),
    };
    let schema = super::runtime_help_parse::parse_help_report(&report, binding)?;
    let previous = latest_snapshot(root, engine, runtime)?;
    // A saved snapshot from another fingerprint is never reused; the diff
    // shows what changed and saved values stay retained.
    if let Some(old) = &previous {
        if old.report.identity.fingerprint == report.identity.fingerprint {
            // Identical rediscovery returns the stored schema to keep field
            // order and overlay supplements stable.
            let descriptor = describe(
                engine,
                runtime,
                &report,
                &old.schema,
                previous.as_ref(),
                saved_keys,
            )?;
            service.finish(&ticket, &report)?;
            return Ok((report, descriptor));
        }
    }
    let descriptor = describe(
        engine,
        runtime,
        &report,
        &schema,
        previous.as_ref(),
        saved_keys,
    )?;
    if report.complete() {
        let snapshot = HelpSnapshot {
            report: report.clone(),
            schema: schema.clone(),
        };
        // Failure to persist never promotes a result to verified.
        if let Err(error) = save_snapshot(root, engine, runtime, &snapshot) {
            service.failed(&ticket);
            return Err(error);
        }
    }
    service.finish(&ticket, &report)?;
    Ok((report, descriptor))
}

#[cfg(test)]
mod tests {
    use super::super::runtime_help::{Encoding, Identity, TextOutput, PARSER_VERSION};
    use super::super::runtime_options::{SchemaBinding, SCHEMA_VERSION};
    use super::*;
    use std::collections::BTreeMap;

    fn test_report(text: &str) -> HelpReport {
        HelpReport {
            identity: Identity {
                fingerprint: "a".repeat(64),
                executable_sha256: "b".repeat(64),
                artifacts_sha256: BTreeMap::new(),
                parser_version: PARSER_VERSION,
            },
            scope: vec![],
            stdout: TextOutput {
                text: text.into(),
                clean_text: text.into(),
                encoding: "utf-8".into(),
                decoding_loss: false,
                truncated: false,
                read_error: None,
            },
            stderr: TextOutput {
                text: String::new(),
                clean_text: String::new(),
                encoding: "utf-8".into(),
                decoding_loss: false,
                truncated: false,
                read_error: None,
            },
            exit_code: Some(0),
            success: true,
            cancelled: false,
            timed_out: false,
            error: None,
            elapsed_ms: 1,
        }
    }

    fn test_schema(fingerprint: &str) -> OptionSchema {
        let report = test_report("Options:\n  --threads N           threads\n");
        super::super::runtime_help_parse::parse_help_report(
            &report,
            SchemaBinding {
                engine: "custom.example".into(),
                runtime: "build-a".into(),
                fingerprint: fingerprint.into(),
            },
        )
        .unwrap()
    }

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aiolm-help-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn snapshots_persist_only_complete_results_and_reject_changed_fingerprints() {
        let root = temp_root();
        let report = test_report("Options:\n  --threads N           threads\n");
        let schema = test_schema(&report.identity.fingerprint);
        let snapshot = HelpSnapshot {
            report: report.clone(),
            schema,
        };
        let path = save_snapshot(&root, "custom.example", "build-a", &snapshot).unwrap();
        assert!(path.is_file());
        assert!(load_snapshot(
            &root,
            "custom.example",
            "build-a",
            &report.identity.fingerprint
        )
        .unwrap()
        .is_some());
        // Another fingerprint never reuses this cache entry.
        assert!(
            load_snapshot(&root, "custom.example", "build-a", &"c".repeat(64))
                .unwrap()
                .is_none()
        );
        let mut failed = report.clone();
        failed.success = false;
        let schema = test_schema(&failed.identity.fingerprint);
        assert!(save_snapshot(
            &root,
            "custom.example",
            "build-a",
            &HelpSnapshot {
                report: failed,
                schema
            }
        )
        .is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn latest_snapshot_and_diff_keep_saved_values_retained() {
        let root = temp_root();
        let first = test_report(
            "Options:\n  --keep VALUE            keep\n  --gone VALUE            gone\n",
        );
        let first_schema = super::super::runtime_help_parse::parse_help_report(
            &first,
            SchemaBinding {
                engine: "custom.example".into(),
                runtime: "build-a".into(),
                fingerprint: first.identity.fingerprint.clone(),
            },
        )
        .unwrap();
        save_snapshot(
            &root,
            "custom.example",
            "build-a",
            &HelpSnapshot {
                report: first.clone(),
                schema: first_schema.clone(),
            },
        )
        .unwrap();
        let latest = latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .unwrap();
        assert_eq!(latest.schema, first_schema);
        let second = test_report(
            "Options:\n  --keep VALUE            keep\n  --fresh VALUE           fresh\n",
        );
        let mut second_binding = first_binding();
        second_binding.fingerprint = second.identity.fingerprint.clone();
        let second_schema =
            super::super::runtime_help_parse::parse_help_report(&second, second_binding).unwrap();
        let descriptor = describe(
            "custom.example",
            "build-a",
            &second,
            &second_schema,
            Some(&latest),
            &["gone".into()],
        )
        .unwrap();
        let diff = descriptor.diff.unwrap();
        assert!(diff.added.contains(&"fresh".to_string()));
        assert!(diff.removed.contains(&"gone".to_string()));
        assert_eq!(descriptor.retained, vec!["gone".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }

    fn first_binding() -> SchemaBinding {
        SchemaBinding {
            engine: "custom.example".into(),
            runtime: "build-a".into(),
            fingerprint: "a".repeat(64),
        }
    }

    #[test]
    fn stored_maps_round_trip_legacy_scalars_and_override_objects() {
        let mut map = Map::new();
        map.insert("threads".into(), Value::from(4));
        map.insert("label".into(), Value::from("explicit"));
        map.insert("empty".into(), Value::from(""));
        let overrides = overrides_from_map(&map);
        assert_eq!(overrides["threads"].occurrences, vec![vec![Value::from(4)]]);
        let back = map_from_overrides(&overrides);
        assert_eq!(back["threads"], Value::from(4));
        assert_eq!(back["empty"], Value::from(""));
        // Repeated tuples use the explicit object shape.
        let repeated = BTreeMap::from([(
            "pair".to_string(),
            Override {
                spelling: None,
                occurrences: vec![
                    vec![Value::from(1), Value::from(2)],
                    vec![Value::from(3), Value::from(4)],
                ],
            },
        )]);
        let encoded = map_from_overrides(&repeated);
        assert!(encoded["pair"].is_object());
        assert_eq!(overrides_from_map(&encoded)["pair"], repeated["pair"]);
    }

    #[test]
    fn resolve_blocks_managed_bindings_and_unknown_arity() {
        let schema = test_schema(&"a".repeat(64));
        let mut stored = Map::new();
        stored.insert("threads".into(), Value::from("4"));
        // Managed bindings are rejected even when help spells the flag.
        let managed_schema = {
            let mut schema = schema.clone();
            // Parser already marks --port managed; add a synthetic managed key.
            schema.options.push(serde_json::from_value(serde_json::json!({
                "key": "port", "spellings": [{"flag": "--port"}],
                "kind": {"value": "integer", "certainty": "verified", "source": {"kind": "adapter", "id": "t", "revision": "r"}},
                "arity": {"value": {"min": 1, "max": 1}, "certainty": "verified", "source": {"kind": "adapter", "id": "t", "revision": "r"}},
                "target": "launch", "managed": "port"
            })).unwrap());
            schema.validate().unwrap();
            schema
        };
        let mut managed = Map::new();
        managed.insert("port".into(), Value::from(8080));
        assert!(resolve_stored(&managed_schema, &[], &managed).is_err());
        assert!(resolve_stored(&schema, &[], &stored).is_ok());
        // Unknown keys are retained as errors, never dropped.
        let mut unknown = stored.clone();
        unknown.insert("removed".into(), Value::from("original"));
        let before = unknown.clone();
        let Err(issues) = resolve_stored(&schema, &[], &unknown) else {
            panic!("unknown saved option must block launch");
        };
        assert!(issues.iter().any(|i| i.key == "removed"));
        assert_eq!(unknown, before);
    }

    #[test]
    fn snapshot_paths_reject_symlinks_and_bad_identities() {
        let root = temp_root();
        assert!(snapshot_root(&root, "custom.example", "build-a").is_ok());
        assert!(snapshot_root(&root, "../escape", "build-a").is_err());
        assert!(snapshot_path_for(&root, "custom.example", "build-a", "short").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn encoding_is_preserved_in_snapshots_without_shell() {
        let _ = Encoding::Auto;
        assert!(valid_segment("custom.example"));
        assert!(!valid_segment("../x"));
    }

    #[test]
    fn schema_version_constant_matches_options_contract() {
        assert_eq!(SCHEMA_VERSION, 1);
    }
}
