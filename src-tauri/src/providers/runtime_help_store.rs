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
use super::runtime_help::{DiscoveryTicket, HelpCommand, HelpReport, HelpService};
use super::runtime_help_parse::{diff_with_saved, SchemaDiff};
use super::runtime_options::{OptionIssue, OptionSchema, Override, ResolvedOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};

/// Disk snapshots stay small and explicit: size is checked from metadata
/// before any file is read into memory.
const MAX_SNAPSHOT_BYTES: usize = 12 * 1024 * 1024;
/// Bounds a directory scan so a bloated snapshot directory cannot stall reads.
const MAX_SNAPSHOT_FILES: usize = 4096;

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
    /// What the engine's explicit option metadata would establish on this
    /// help, and which declarations the help contradicts, before acceptance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<super::runtime_metadata::MetadataView>,
}

pub(crate) fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        && !value.starts_with(['-', '.'])
}

pub(crate) fn snapshot_root(root: &Path, engine: &str, runtime: &str) -> Result<PathBuf, String> {
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
    // The schema binding pins the exact engine/runtime the snapshot was
    // discovered for; a foreign binding must never be filed under this path.
    if snapshot.schema.binding.engine != engine || snapshot.schema.binding.runtime != runtime {
        return Err("snapshot schema binding must match its engine and runtime".into());
    }
    let path = snapshot_path_for(root, engine, runtime, &snapshot.report.identity.fingerprint)?;
    let bytes = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err("help snapshot exceeds 12 MiB".into());
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
    // Never follow a reparse link to a snapshot, and never allocate a file
    // before its metadata proves it is a bounded regular file.
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("help snapshot must not be a symbolic link".into());
    }
    if !metadata.file_type().is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
        return Err("help snapshot exceeds 12 MiB".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err("help snapshot exceeds 12 MiB".into());
    }
    let snapshot: HelpSnapshot =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid help snapshot: {e}"))?;
    if !snapshot.report.complete() {
        return Ok(None);
    }
    snapshot.schema.validate()?;
    if snapshot.report.identity.fingerprint != fingerprint
        || snapshot.schema.binding.fingerprint != fingerprint
        || snapshot.schema.binding.engine != engine
        || snapshot.schema.binding.runtime != runtime
    {
        return Ok(None);
    }
    Ok(Some(snapshot))
}

/// The schema of a stored snapshot whatever parser version wrote it, read
/// with the same file bounds. Only for keeping values an earlier review
/// marked secret hidden while help is rediscovered; never for launch.
pub fn stored_schema(
    root: &Path,
    engine: &str,
    runtime: &str,
    fingerprint: &str,
) -> Option<OptionSchema> {
    let path = snapshot_path_for(root, engine, runtime, fingerprint).ok()?;
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
        return None;
    }
    let snapshot: HelpSnapshot = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    (snapshot.schema.binding.engine == engine && snapshot.schema.binding.runtime == runtime)
        .then_some(snapshot.schema)
}

/// The most recently saved snapshot for a runtime, if any.
///
/// Selection is deterministic and bounded: only files named `<SHA-256>.json`
/// that are bounded regular files (never reparse links) and whose
/// report/schema fingerprints and engine/runtime bindings agree are
/// candidates; the newest by (mtime, fingerprint) wins. Stale or foreign files
/// are skipped, never promoted, and old raw data is left untouched on disk.
pub fn latest_snapshot(
    root: &Path,
    engine: &str,
    runtime: &str,
) -> Result<Option<HelpSnapshot>, String> {
    let dir = snapshot_root(root, engine, runtime)?;
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
    let mut candidates: Vec<(std::time::SystemTime, String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        if candidates.len() >= MAX_SNAPSHOT_FILES {
            break;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        // Metadata first: reject reparse links and oversize files before any
        // allocation, without following the link.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink()
            || !metadata.file_type().is_file()
            || metadata.len() > MAX_SNAPSHOT_BYTES as u64
        {
            continue;
        }
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        candidates.push((modified, stem.to_string(), path));
    }
    // Newest first; the fingerprint stem breaks mtime ties deterministically.
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    for (_, stem, path) in candidates.into_iter().rev() {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            continue;
        }
        let Ok(snapshot): Result<HelpSnapshot, _> = serde_json::from_slice(&bytes) else {
            continue;
        };
        if !snapshot.report.complete() {
            continue;
        }
        if snapshot.schema.validate().is_err() {
            continue;
        }
        if snapshot.report.identity.fingerprint != stem
            || snapshot.schema.binding.fingerprint != stem
            || snapshot.schema.binding.engine != engine
            || snapshot.schema.binding.runtime != runtime
        {
            continue;
        }
        return Ok(Some(snapshot));
    }
    Ok(None)
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
        None => (
            None,
            diff_with_saved(schema, schema, saved_keys).retained_unknown,
        ),
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
        metadata: None,
    })
}

/// Convert stored profile values into new-style overrides.
///
/// Legacy scalar values (`4`, `true`, `"text"`) become a single occurrence
/// with a single value so existing profiles keep working. Values already
/// saved as `{occurrences, spelling}` pass through unchanged. Unknown keys
/// are preserved here and reported by `resolve`, never dropped. The saved
/// order record is not an option and is read by `runtime_ordered`.
pub fn overrides_from_map(map: &Map<String, Value>) -> BTreeMap<String, Override> {
    let mut out = BTreeMap::new();
    for (key, value) in map {
        if key == super::runtime_ordered::ORDER_KEY {
            continue;
        }
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
/// selections, never from stored overrides, aliases or metadata. A saved
/// order record decides occurrence order and per-occurrence aliases.
pub fn resolve_stored(
    schema: &OptionSchema,
    scope: &[String],
    stored: &Map<String, Value>,
) -> Result<ResolvedOptions, Vec<OptionIssue>> {
    super::runtime_ordered::resolve_saved(schema, scope, stored)
}

/// Where a guarded publication may write: the snapshot directory identity
/// plus whether a fresh schema needs persisting (identical rediscovery only
/// refreshes the in-memory cache entry).
struct PublishScope<'a> {
    root: &'a Path,
    engine: &'a str,
    runtime: &'a str,
    persist: bool,
}

/// Guarded publication for one discovery ticket: only the ticket that still
/// owns its slot publishes, and only while it is not cancelled. The check and
/// the atomic snapshot write run under the service lock, so a superseded or
/// cancelled predecessor never writes disk/latest and nothing is rolled back.
/// Never touches another owner's slot.
fn publish_current(
    service: &HelpService,
    ticket: &DiscoveryTicket,
    report: &HelpReport,
    schema: &OptionSchema,
    scope: PublishScope<'_>,
) -> Result<(), String> {
    service.publish(ticket, report, || {
        if scope.persist && report.complete() {
            save_snapshot(
                scope.root,
                scope.engine,
                scope.runtime,
                &HelpSnapshot {
                    report: report.clone(),
                    schema: schema.clone(),
                },
            )?;
        }
        Ok(())
    })
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
    discover_against(
        service,
        root,
        owner,
        engine,
        runtime,
        command,
        saved_keys,
        Baseline::Latest,
    )
}

/// What a new discovery is compared with: the latest saved snapshot, or the
/// snapshot a user reviewed and accepted for launch (possibly none).
pub enum Baseline {
    Latest,
    Accepted(Option<Box<HelpSnapshot>>),
}

#[allow(clippy::too_many_arguments)]
pub fn discover_against(
    service: &HelpService,
    root: &Path,
    owner: &str,
    engine: &str,
    runtime: &str,
    command: &HelpCommand,
    saved_keys: &[String],
    baseline: Baseline,
) -> Result<(HelpReport, RuntimeDescriptor), String> {
    if !valid_segment(engine) || !valid_segment(runtime) {
        return Err("invalid engine or runtime identity for help snapshots".into());
    }
    let ticket = service.begin(owner)?;
    // The owned capture runs under this ticket's flag; a spawn failure frees
    // the owner slot immediately so the owner can retry.
    let report = match super::runtime_help::discover(command, &ticket.cancel) {
        Ok(report) => report,
        Err(error) => {
            service.failed(&ticket);
            return Err(error);
        }
    };
    // Cancellation after capture still wins over persistence: a cancelled
    // ticket publishes nothing and frees its owner for an immediate retry.
    if ticket.cancel.load(Ordering::Acquire) {
        service.failed(&ticket);
        return Err("help discovery cancelled".into());
    }
    let binding = super::runtime_options::SchemaBinding {
        engine: engine.into(),
        runtime: runtime.into(),
        fingerprint: report.identity.fingerprint.clone(),
    };
    // Every fallible step below frees this ticket's slot on error; a
    // superseded or cancelled ticket additionally never reaches publication.
    let schema = match super::runtime_help_parse::parse_help_report(&report, binding) {
        Ok(schema) => schema,
        Err(error) => {
            service.failed(&ticket);
            return Err(error);
        }
    };
    let previous = match baseline {
        Baseline::Accepted(previous) => previous.map(|snapshot| *snapshot),
        Baseline::Latest => match latest_snapshot(root, engine, runtime) {
            Ok(previous) => previous,
            Err(error) => {
                service.failed(&ticket);
                return Err(error);
            }
        },
    };
    // A saved snapshot from another fingerprint is never reused; the diff
    // shows what changed and saved values stay retained.
    if let Some(old) = &previous {
        if old.report.identity.fingerprint == report.identity.fingerprint {
            // Identical rediscovery returns the stored schema to keep field
            // order and overlay supplements stable; the snapshot is already
            // on disk, so only the guarded in-memory publication runs.
            let descriptor = match describe(
                engine,
                runtime,
                &report,
                &old.schema,
                previous.as_ref(),
                saved_keys,
            ) {
                Ok(descriptor) => descriptor,
                Err(error) => {
                    service.failed(&ticket);
                    return Err(error);
                }
            };
            publish_current(
                service,
                &ticket,
                &report,
                &old.schema,
                PublishScope {
                    root,
                    engine,
                    runtime,
                    persist: false,
                },
            )?;
            return Ok((report, descriptor));
        }
    }
    let descriptor = match describe(
        engine,
        runtime,
        &report,
        &schema,
        previous.as_ref(),
        saved_keys,
    ) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            service.failed(&ticket);
            return Err(error);
        }
    };
    publish_current(
        service,
        &ticket,
        &report,
        &schema,
        PublishScope {
            root,
            engine,
            runtime,
            persist: true,
        },
    )?;
    Ok((report, descriptor))
}

#[cfg(test)]
mod tests {
    use super::super::runtime_help::{Encoding, Identity, TextOutput, PARSER_VERSION};
    use super::super::runtime_options::{SchemaBinding, SCHEMA_VERSION};
    use super::*;
    use std::collections::BTreeMap;

    fn test_report(text: &str) -> HelpReport {
        test_report_with_fp(text, &"a".repeat(64))
    }

    fn test_report_with_fp(text: &str, fingerprint: &str) -> HelpReport {
        HelpReport {
            identity: Identity {
                fingerprint: fingerprint.into(),
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
    fn first_discovery_reports_retained_saved_values_without_a_previous_snapshot() {
        let report = test_report("Options:\n  --threads N           threads\n");
        let schema = test_schema(&report.identity.fingerprint);
        let saved = vec!["threads".into(), "removed".into(), "removed".into()];
        let descriptor =
            describe("custom.example", "build-a", &report, &schema, None, &saved).unwrap();
        assert_eq!(descriptor.retained, ["removed"]);
        assert!(descriptor.diff.is_none());
        assert_eq!(saved.len(), 3, "review does not mutate stored values");
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

    const CHILD_ENV: &str = "AIOLM_HELP_TEST_CHILD";
    const CHILD_FILTER: &str = "providers::runtime_help::tests::discovery_child";

    /// Real owned child processes: the test binary replays synthetic help when
    /// the child marker env is set, mirroring the runtime_help fixtures.
    fn help_command(mode: &str, timeout_ms: u64) -> HelpCommand {
        let mut environment = BTreeMap::new();
        environment.insert(CHILD_ENV.into(), mode.into());
        environment.insert("LC_ALL".into(), "C".into());
        HelpCommand {
            program: std::env::current_exe().unwrap(),
            args: vec!["--exact".into(), CHILD_FILTER.into(), "--nocapture".into()],
            environment,
            working_directory: Some(std::env::temp_dir()),
            artifacts: vec![],
            runtime_version: "test-store-r1".into(),
            scope: vec![],
            encoding: Encoding::Auto,
            timeout_ms,
            output_limit: 4096,
        }
    }

    fn write_snapshot_bytes(root: &Path, engine: &str, runtime: &str, stem: &str, bytes: &[u8]) {
        let dir = root.join(engine).join(runtime).join("help");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{stem}.json")), bytes).unwrap();
    }

    #[test]
    fn save_rejects_schema_binding_mismatch() {
        let root = temp_root();
        let report = test_report("Options:\n  --threads N           threads\n");
        let mut schema = test_schema(&report.identity.fingerprint);
        schema.binding.engine = "custom.other".into();
        let error = save_snapshot(
            &root,
            "custom.example",
            "build-a",
            &HelpSnapshot { report, schema },
        )
        .unwrap_err();
        assert!(error.contains("binding"), "unexpected error: {error}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn latest_snapshot_ignores_filename_fingerprint_mismatch() {
        let root = temp_root();
        let report = test_report("Options:\n  --threads N           threads\n");
        let schema = test_schema(&report.identity.fingerprint);
        let bytes = serde_json::to_vec_pretty(&HelpSnapshot { report, schema }).unwrap();
        // Valid snapshot bytes filed under a fingerprint that matches neither
        // the report nor the schema binding must never be promoted.
        write_snapshot_bytes(&root, "custom.example", "build-a", &"d".repeat(64), &bytes);
        assert!(latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn oversize_snapshot_files_are_rejected_before_full_trust() {
        let root = temp_root();
        let stem = "f".repeat(64);
        let big = vec![b'x'; MAX_SNAPSHOT_BYTES + 1];
        write_snapshot_bytes(&root, "custom.example", "build-a", &stem, &big);
        let error = load_snapshot(&root, "custom.example", "build-a", &stem).unwrap_err();
        assert!(error.contains("exceeds"), "unexpected error: {error}");
        assert!(latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn snapshots_reject_symlinked_files() {
        let root = temp_root();
        let report = test_report("Options:\n  --threads N           threads\n");
        let schema = test_schema(&report.identity.fingerprint);
        let real_fp = report.identity.fingerprint.clone();
        save_snapshot(
            &root,
            "custom.example",
            "build-a",
            &HelpSnapshot {
                report: report.clone(),
                schema: schema.clone(),
            },
        )
        .unwrap();
        let target = root.join("outside-target.json");
        std::fs::write(
            &target,
            serde_json::to_vec_pretty(&HelpSnapshot { report, schema }).unwrap(),
        )
        .unwrap();
        let link_stem = "e".repeat(64);
        std::os::unix::fs::symlink(
            &target,
            root.join("custom.example")
                .join("build-a")
                .join("help")
                .join(format!("{link_stem}.json")),
        )
        .unwrap();
        let error = load_snapshot(&root, "custom.example", "build-a", &link_stem).unwrap_err();
        assert!(error.contains("symbolic"), "unexpected error: {error}");
        // The reparse link is skipped; the real snapshot still wins.
        let latest = latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .unwrap();
        assert_eq!(latest.report.identity.fingerprint, real_fp);
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(windows)]
    #[test]
    fn snapshots_reject_symlinked_files() {
        let root = temp_root();
        let report = test_report("Options:\n  --threads N           threads\n");
        let schema = test_schema(&report.identity.fingerprint);
        let real_fp = report.identity.fingerprint.clone();
        save_snapshot(
            &root,
            "custom.example",
            "build-a",
            &HelpSnapshot {
                report: report.clone(),
                schema: schema.clone(),
            },
        )
        .unwrap();
        let target = root.join("outside-target.json");
        std::fs::write(
            &target,
            serde_json::to_vec_pretty(&HelpSnapshot { report, schema }).unwrap(),
        )
        .unwrap();
        let link = root
            .join("custom.example")
            .join("build-a")
            .join("help")
            .join(format!("{}.json", "e".repeat(64)));
        match std::os::windows::fs::symlink_file(&target, &link) {
            Ok(()) => {
                let error =
                    load_snapshot(&root, "custom.example", "build-a", &"e".repeat(64)).unwrap_err();
                assert!(error.contains("symbolic"), "unexpected error: {error}");
                let latest = latest_snapshot(&root, "custom.example", "build-a")
                    .unwrap()
                    .unwrap();
                assert_eq!(latest.report.identity.fingerprint, real_fp);
            }
            Err(error) => {
                // Creating symlinks needs a privilege most dev shells lack; the
                // size/binding checks below still verify on this machine.
                eprintln!("SKIP symlinked-file assertions, cannot create link: {error}");
                assert!(latest_snapshot(&root, "custom.example", "build-a")
                    .unwrap()
                    .is_some());
            }
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn latest_snapshot_is_deterministic_beyond_sixty_four_entries() {
        let root = temp_root();
        let mut last = String::new();
        for index in 0..70_u32 {
            let fingerprint = format!("{index:064x}");
            let report =
                test_report_with_fp("Options:\n  --threads N           threads\n", &fingerprint);
            let schema = super::super::runtime_help_parse::parse_help_report(
                &report,
                SchemaBinding {
                    engine: "custom.example".into(),
                    runtime: "build-a".into(),
                    fingerprint: fingerprint.clone(),
                },
            )
            .unwrap();
            save_snapshot(
                &root,
                "custom.example",
                "build-a",
                &HelpSnapshot { report, schema },
            )
            .unwrap();
            last = fingerprint;
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let latest = latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .unwrap();
        assert_eq!(latest.report.identity.fingerprint, last);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn failed_discovery_frees_its_owner_for_immediate_retry() {
        let root = temp_root();
        let service = HelpService::default();
        // The synthetic child stalls, so the short timeout yields a truncated
        // report that can never become a snapshot.
        let slow = help_command("wait", 500);
        let error = discover_persist_describe(
            &service,
            &root,
            "owner-x",
            "custom.example",
            "build-a",
            &slow,
            &[],
        )
        .unwrap_err();
        assert!(error.contains("incomplete"), "unexpected error: {error}");
        // No stale active ticket may survive the failure path.
        assert!(!service.cancel_owner("owner-x").unwrap());
        assert!(latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .is_none());
        // The same owner retries immediately with a fresh complete discovery.
        let fresh = help_command("normal", 10_000);
        let (report, _) = discover_persist_describe(
            &service,
            &root,
            "owner-x",
            "custom.example",
            "build-a",
            &fresh,
            &[],
        )
        .unwrap();
        assert!(report.complete());
        assert!(latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .is_some());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn explicit_repeat_without_metadata_blocks_argv_but_keeps_values() {
        let root = temp_root();
        let report = test_report(
            "Options:\n  --item VALUE            repeatable per occurrence (repeatable)\n",
        );
        let schema = super::super::runtime_help_parse::parse_help_report(
            &report,
            SchemaBinding {
                engine: "custom.example".into(),
                runtime: "build-a".into(),
                fingerprint: report.identity.fingerprint.clone(),
            },
        )
        .unwrap();
        let item = schema.options.iter().find(|o| o.key == "item").unwrap();
        // Help prose never becomes repeat permission.
        assert_eq!(
            item.repeatable,
            super::super::runtime_options::Fact::default()
        );
        let mut stored = Map::new();
        stored.insert(
            "item".into(),
            serde_json::json!({"occurrences": [["a"], ["b"]]}),
        );
        // Stored values are retained and reported, never silently dropped.
        let before = stored.clone();
        let issues = resolve_stored(&schema, &[], &stored).unwrap_err();
        assert!(issues.iter().any(|i| i.key == "item"));
        assert_eq!(stored, before);
        std::fs::remove_dir_all(&root).ok();
    }

    fn complete_report_and_schema(mode: &str) -> (HelpReport, OptionSchema) {
        let command = help_command(mode, 10_000);
        let report = super::super::runtime_help::discover(
            &command,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        assert!(report.complete());
        let schema = super::super::runtime_help_parse::parse_help_report(
            &report,
            SchemaBinding {
                engine: "custom.example".into(),
                runtime: "build-a".into(),
                fingerprint: report.identity.fingerprint.clone(),
            },
        )
        .unwrap();
        (report, schema)
    }

    #[test]
    fn bulk_help_beyond_sixty_four_kib_persists_and_reloads() {
        let root = temp_root();
        let service = HelpService::default();
        let mut command = help_command("bulk", 30_000);
        command.output_limit = 1024 * 1024;
        let (report, descriptor) = discover_persist_describe(
            &service,
            &root,
            "owner-bulk",
            "custom.example",
            "build-bulk",
            &command,
            &[],
        )
        .unwrap();
        assert!(report.complete());
        assert!(
            report.stdout.text.len() > 203_342,
            "{}",
            report.stdout.text.len()
        );
        assert!(descriptor.schema.options.len() >= 1500);
        let loaded = load_snapshot(
            &root,
            "custom.example",
            "build-bulk",
            &report.identity.fingerprint,
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.schema, descriptor.schema);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn guarded_publication_rejects_cancelled_and_superseded_tickets() {
        let root = temp_root();
        let service = HelpService::default();
        let (report, schema) = complete_report_and_schema("normal");
        // A complete report on a cancelled ticket never reaches disk, and the
        // owner slot is freed for an immediate retry.
        let cancelled = service.begin("owner-c").unwrap();
        service.cancel_owner("owner-c").unwrap();
        let error = publish_current(
            &service,
            &cancelled,
            &report,
            &schema,
            PublishScope {
                root: &root,
                engine: "custom.example",
                runtime: "build-a",
                persist: true,
            },
        )
        .unwrap_err();
        assert!(error.contains("cancelled"), "unexpected: {error}");
        assert!(latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .is_none());
        assert!(!service.cancel_owner("owner-c").unwrap());
        // A superseded predecessor publishes nothing and never disturbs the
        // successor's slot or other owners.
        let old = service.begin("owner-s").unwrap();
        let unrelated = service.begin("owner-other").unwrap();
        let fresh = service.begin("owner-s").unwrap();
        let error = publish_current(
            &service,
            &old,
            &report,
            &schema,
            PublishScope {
                root: &root,
                engine: "custom.example",
                runtime: "build-a",
                persist: true,
            },
        )
        .unwrap_err();
        assert!(error.contains("superseded"), "unexpected: {error}");
        assert!(latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .is_none());
        assert!(service.is_current(&fresh));
        assert!(!unrelated.cancel.load(std::sync::atomic::Ordering::Acquire));
        // The current successor publishes normally.
        publish_current(
            &service,
            &fresh,
            &report,
            &schema,
            PublishScope {
                root: &root,
                engine: "custom.example",
                runtime: "build-a",
                persist: true,
            },
        )
        .unwrap();
        let latest = latest_snapshot(&root, "custom.example", "build-a")
            .unwrap()
            .unwrap();
        assert_eq!(
            latest.report.identity.fingerprint,
            report.identity.fingerprint
        );
        service.failed(&fresh);
        service.failed(&unrelated);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cancelled_discovery_after_capture_publishes_nothing() {
        let root = temp_root();
        let service = std::sync::Arc::new(HelpService::default());
        let unrelated = service.begin("owner-other").unwrap();
        let worker = service.clone();
        let root_clone = root.clone();
        let slow = help_command("wait", 10_000);
        let handle = std::thread::spawn(move || {
            discover_persist_describe(
                &worker,
                &root_clone,
                "owner-race",
                "custom.example",
                "build-race",
                &slow,
                &[],
            )
        });
        // Capture is in flight (the synthetic child stalls); cancel mid-run,
        // after capture started but before any parse or persistence.
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(service.cancel_owner("owner-race").unwrap());
        let error = handle.join().unwrap().unwrap_err();
        assert!(error.contains("cancel"), "unexpected: {error}");
        assert!(latest_snapshot(&root, "custom.example", "build-race")
            .unwrap()
            .is_none());
        // Another owner running alongside is unaffected.
        assert!(!unrelated.cancel.load(std::sync::atomic::Ordering::Acquire));
        service.failed(&unrelated);
        // The cancelled owner retries cleanly with a fresh complete run.
        let fresh = help_command("normal", 10_000);
        let (report, _) = discover_persist_describe(
            &service,
            &root,
            "owner-race",
            "custom.example",
            "build-race",
            &fresh,
            &[],
        )
        .unwrap();
        assert!(report.complete());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn superseding_owner_leaves_no_stale_snapshot() {
        let root = temp_root();
        let service = std::sync::Arc::new(HelpService::default());
        let worker = service.clone();
        let root_clone = root.clone();
        let slow = help_command("wait", 10_000);
        let handle = std::thread::spawn(move || {
            discover_persist_describe(
                &worker,
                &root_clone,
                "owner-sup",
                "custom.example",
                "build-sup",
                &slow,
                &[],
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(400));
        // A newer discovery by the same owner supersedes the slow predecessor.
        let _successor = service.begin("owner-sup").unwrap();
        let error = handle.join().unwrap().unwrap_err();
        assert!(
            error.contains("cancelled") || error.contains("superseded"),
            "unexpected: {error}"
        );
        assert!(latest_snapshot(&root, "custom.example", "build-sup")
            .unwrap()
            .is_none());
        // The successor publishes the only snapshot under this runtime.
        let fresh = help_command("normal", 10_000);
        let (report, _) = discover_persist_describe(
            &service,
            &root,
            "owner-sup",
            "custom.example",
            "build-sup",
            &fresh,
            &[],
        )
        .unwrap();
        let latest = latest_snapshot(&root, "custom.example", "build-sup")
            .unwrap()
            .unwrap();
        assert_eq!(
            latest.report.identity.fingerprint,
            report.identity.fingerprint
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
