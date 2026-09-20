//! One append-only journal per run. Only the requested history page is decoded;
//! interrupted writes discard their incomplete final line, preserving trials.
mod locks;
mod receipts;
pub(crate) use receipts::{acknowledge, Acknowledgement, UploadReceipt};

use crate::performance_bench::{PerformanceBenchRequest, PerformanceBenchResult};
use locks::{RunLock, StoreLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const MAX_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;
static ACTIVE_RUNS: LazyLock<Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Serialize)]
pub(crate) struct HistoryPage {
    pub records: Vec<Value>,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Entry {
    Start {
        record: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<JournalOrigin>,
    },
    Metadata {
        result: Value,
    },
    Trial {
        row: Value,
    },
    Finish {
        result: Value,
    },
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum JournalOrigin {
    Native,
    Legacy,
}

fn encoded(entry: &Entry) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn metadata(result: &PerformanceBenchResult) -> Value {
    // Serialize metadata without walking/cloning accumulated rows each trial.
    let mut value = json!({
        "run_id": result.run_id, "status": result.status, "message": result.message,
        "args": result.args, "runtime_version": result.runtime_version,
        "context_size": result.context_size, "parallel": result.parallel,
    });
    if let Some(provenance) = &result.provenance {
        value["provenance"] = json!(provenance);
    }
    value
}

fn valid_row(row: &Value) -> bool {
    let nonnegative = |value: &Value| {
        value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number >= 0.0)
    };
    row.get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && [
            "prompt_tokens",
            "generation_length",
            "concurrency",
            "repetition",
        ]
        .iter()
        .all(|name| {
            row.get(*name)
                .and_then(Value::as_u64)
                .is_some_and(|number| number > 0)
        })
        && ["completion_tokens", "cached_tokens", "e2e_ms"]
            .iter()
            .all(|name| row.get(*name).is_some_and(nonnegative))
        && [
            "ttft_ms",
            "tpot_ms",
            "pp_tps",
            "tg_tps",
            "total_tps",
            "peak_memory_bytes",
        ]
        .iter()
        .all(|name| {
            row.get(*name)
                .is_some_and(|value| value.is_null() || nonnegative(value))
        })
        && row
            .get("timing_source")
            .and_then(Value::as_str)
            .is_some_and(|value| ["client", "server"].contains(&value))
        && row
            .get("error")
            .is_none_or(|value| value.is_null() || value.is_string())
}

fn files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(root.join("runs")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(format!("cannot read benchmark history: {error}")),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        {
            paths.push(entry.path());
        }
    }
    paths.sort_unstable_by(|left, right| right.file_name().cmp(&left.file_name()));
    Ok(paths)
}

fn validate_record(record: &Value) -> Result<(), String> {
    let id = record
        .get("id")
        .and_then(Value::as_str)
        .ok_or("benchmark record is missing its id")?;
    if id.is_empty()
        || id.len() > 128
        || record.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !record
            .get("createdAt")
            .and_then(Value::as_u64)
            .is_some_and(|value| value <= 8_640_000_000_000_000)
        || ["model", "backend", "build"]
            .iter()
            .any(|name| !record.get(*name).is_some_and(Value::is_string))
    {
        return Err("invalid benchmark record envelope".into());
    }
    let mut request: PerformanceBenchRequest = serde_json::from_value(
        record
            .get("request")
            .cloned()
            .ok_or("benchmark request is missing")?,
    )
    .map_err(|error| error.to_string())?;
    crate::performance_bench::validate_request(&mut request)?;
    if let Some(value) = record.pointer("/result/provenance") {
        let provenance: super::provenance::BenchmarkProvenance =
            serde_json::from_value(value.clone())
                .map_err(|error| format!("invalid benchmark provenance: {error}"))?;
        provenance.validate(&request.context_profile)?;
    }
    if request.run_id != id
        || record.pointer("/result/run_id").and_then(Value::as_str) != Some(id)
        || !record
            .pointer("/result/rows")
            .and_then(Value::as_array)
            .is_some_and(|rows| rows.len() <= 640 && rows.iter().all(valid_row))
        || !record
            .pointer("/result/args")
            .and_then(Value::as_array)
            .is_some_and(|args| args.iter().all(Value::is_string))
        || !record
            .pointer("/result/runtime_version")
            .is_some_and(Value::is_string)
        || ["context_size", "parallel"].iter().any(|name| {
            record
                .get("result")
                .and_then(|result| result.get(*name))
                .and_then(Value::as_u64)
                .is_none()
        })
        || record
            .pointer("/result/message")
            .is_some_and(|value| !value.is_null() && !value.is_string())
        || !record
            .pointer("/result/status")
            .and_then(Value::as_str)
            .is_some_and(|status| ["complete", "partial", "failed", "cancelled"].contains(&status))
    {
        return Err("benchmark record and request do not match".into());
    }
    if serde_json::to_vec(record)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_RECORD_BYTES
    {
        return Err("benchmark record exceeds the storage size limit".into());
    }
    Ok(())
}

fn record_digest(record: &Value) -> String {
    format!(
        "{:x}.jsonl",
        Sha256::digest(record["id"].as_str().expect("validated id").as_bytes())
    )
}

fn existing_digests(root: &Path) -> Result<HashSet<String>, String> {
    Ok(files(root)?
        .into_iter()
        .filter_map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.split_once('-'))
                .map(|(_, digest)| digest.to_owned())
        })
        .collect())
}

fn path_for(
    root: &Path,
    record: &Value,
    existing: &HashSet<String>,
) -> Result<Option<PathBuf>, String> {
    validate_record(record)?;
    let digest = record_digest(record);
    if existing.contains(&digest)
        || receipts::has_tombstone(root, record["id"].as_str().expect("validated id"))?
    {
        return Ok(None);
    }
    let created = record["createdAt"].as_u64().expect("validated timestamp");
    Ok(Some(
        root.join("runs").join(format!("{created:016}-{digest}")),
    ))
}

struct Writer {
    file: File,
    rows: usize,
    prepared: bool,
}

pub(crate) struct RunJournal {
    writer: Mutex<Writer>,
    path: PathBuf,
    run_lock: Option<RunLock>,
    activity_marker: PathBuf,
}

impl Drop for RunJournal {
    fn drop(&mut self) {
        // Keep marker removal and run-lock release atomic to other app instances.
        // A failed cleanup leaves a harmless marker for the next locked lookup.
        let root = self.path.parent().and_then(Path::parent);
        if let Some(root) = root {
            if let Ok(_store) = StoreLock::acquire(root) {
                drop(self.run_lock.take());
                let _ = fs::remove_file(&self.activity_marker);
            }
        }
        if let Ok(mut active) = ACTIVE_RUNS.lock() {
            active.remove(&self.path);
        }
    }
}

impl RunJournal {
    pub(crate) fn begin(root: &Path, record: Value) -> Result<Self, String> {
        let _lock = StoreLock::acquire(root)?;
        let path = path_for(root, &record, &existing_digests(root)?)?
            .ok_or("benchmark run id already exists")?;
        let rows = record["result"]["rows"]
            .as_array()
            .expect("validated rows")
            .len();
        let run_id = record["id"].as_str().expect("validated id").to_owned();
        let run_lock = RunLock::acquire(root, &run_id)?
            .ok_or("benchmark run is active in another application instance")?;
        crate::config::atomic_write(
            &path,
            &encoded(&Entry::Start {
                record,
                origin: Some(JournalOrigin::Native),
            })?,
        )?;
        sync_parent(&path)?;
        let file = OpenOptions::new()
            .append(true)
            .read(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let activity_marker = locks::mark_active(root, &run_id)?;
        ACTIVE_RUNS
            .lock()
            .map_err(|_| "active benchmark store lock was poisoned")?
            .insert(path.clone());
        Ok(Self {
            writer: Mutex::new(Writer {
                file,
                rows,
                prepared: false,
            }),
            path,
            run_lock: Some(run_lock),
            activity_marker,
        })
    }

    pub(crate) fn checkpoint(&self, result: &PerformanceBenchResult) -> Result<(), String> {
        self.write(result, false)
    }

    pub(crate) fn finish(&self, result: &PerformanceBenchResult) -> Result<(), String> {
        self.write(result, true)
    }

    fn write(&self, result: &PerformanceBenchResult, finish: bool) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "benchmark journal lock was poisoned")?;
        let mut bytes = Vec::new();
        if !writer.prepared && !finish {
            bytes.extend(encoded(&Entry::Metadata {
                result: metadata(result),
            })?);
        }
        for row in result.rows.iter().skip(writer.rows) {
            bytes.extend(encoded(&Entry::Trial {
                row: serde_json::to_value(row).map_err(|error| error.to_string())?,
            })?);
        }
        if finish {
            bytes.extend(encoded(&Entry::Finish {
                result: metadata(result),
            })?);
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let length = writer
            .file
            .metadata()
            .map_err(|error| error.to_string())?
            .len();
        if length + bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err("benchmark journal exceeds the storage size limit".into());
        }
        if let Err(error) = writer
            .file
            .write_all(&bytes)
            .and_then(|()| writer.file.sync_all())
        {
            // Roll back a short write so a later finish cannot make a torn line
            // look like a valid event. A crash still leaves only a torn tail.
            let _ = writer.file.set_len(length);
            let _ = writer.file.sync_all();
            return Err(format!("cannot persist benchmark measurement: {error}"));
        }
        writer.rows = result.rows.len();
        writer.prepared = true;
        Ok(())
    }
}

fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path.parent().ok_or("benchmark path has no directory")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

struct ReplayedRun {
    record: Value,
    origin: Option<JournalOrigin>,
    finalized: bool,
}

#[cfg(test)]
fn replay(path: &Path) -> Result<Value, String> {
    Ok(replay_run(path)?.record)
}

fn replay_run(path: &Path) -> Result<ReplayedRun, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("benchmark journal exceeds the storage size limit".into());
    }
    let mut record: Option<Value> = None;
    let mut finished = false;
    let mut origin = None;
    let mut torn_tail = false;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if !line.ends_with(b"\n") {
            torn_tail = true;
            break;
        }
        let entry: Entry = serde_json::from_slice(line)
            .map_err(|error| format!("benchmark journal contains a corrupt event: {error}"))?;
        match entry {
            Entry::Start {
                record: initial,
                origin: source,
            } => {
                if record.is_some() {
                    return Err("benchmark journal contains duplicate start events".into());
                }
                validate_record(&initial)?;
                record = Some(initial);
                origin = source;
            }
            Entry::Trial { row } => {
                finished = false;
                if !valid_row(&row) {
                    return Err("benchmark journal contains an invalid trial".into());
                }
                let rows = record
                    .as_mut()
                    .and_then(|value| value.pointer_mut("/result/rows"))
                    .and_then(Value::as_array_mut)
                    .ok_or("benchmark trial is missing its start event")?;
                rows.push(row);
            }
            Entry::Metadata { result } => {
                finished = false;
                update_result(&mut record, result)?;
            }
            Entry::Finish { result } => {
                update_result(&mut record, result)?;
                finished = true;
            }
        }
    }
    let mut record = record.ok_or("benchmark journal has no complete start event")?;
    if !finished {
        let has_rows = record["result"]["rows"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty());
        record["result"]["status"] = json!(if has_rows { "partial" } else { "failed" });
        record["result"]["message"] = json!(
            "benchmark was interrupted before finalization; persisted measurements were recovered"
        );
    }
    validate_record(&record)?;
    Ok(ReplayedRun {
        record,
        origin,
        finalized: finished && !torn_tail,
    })
}

fn update_result(record: &mut Option<Value>, result: Value) -> Result<(), String> {
    let target = record
        .as_mut()
        .and_then(|value| value.get_mut("result"))
        .and_then(Value::as_object_mut)
        .ok_or("benchmark metadata is missing its start event")?;
    for (key, value) in result
        .as_object()
        .ok_or("benchmark metadata must be an object")?
    {
        if key != "rows" {
            target.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

pub(crate) fn list(root: &Path, offset: usize, limit: usize) -> Result<HistoryPage, String> {
    let _lock = StoreLock::acquire(root)?;
    let (active_digests, mut warnings) = locks::active_digests(root)?;
    let paths = {
        let active = ACTIVE_RUNS
            .lock()
            .map_err(|_| "active benchmark store lock was poisoned")?;
        files(root)?
            .into_iter()
            .filter(|path| !active.contains(path))
            .filter(|path| {
                !RunLock::journal_digest(path).is_ok_and(|digest| active_digests.contains(digest))
            })
            .collect::<Vec<_>>()
    };
    let total = paths.len();
    let limit = limit.clamp(1, 100);
    let mut records = Vec::new();
    let mut scanned = 0;
    for path in paths.into_iter().skip(offset).take(limit) {
        scanned += 1;
        let run_lock = match RunLock::for_journal(root, &path) {
            Ok(Some(lock)) => Some(lock),
            Ok(None) => continue,
            Err(error) => {
                warnings.push(format!(
                    "a benchmark record could not be safely locked and was preserved: {error}"
                ));
                continue;
            }
        };
        match replay_run(&path) {
            Ok(mut run) => {
                if let Err(error) = receipts::attach_state(root, &mut run.record) {
                    warnings.push(error);
                }
                records.push(run.record);
            }
            Err(error) => warnings.push(format!(
                "a benchmark record could not be read and was preserved: {error}"
            )),
        }
        drop(run_lock);
    }
    let next = offset.saturating_add(scanned);
    Ok(HistoryPage {
        records,
        total,
        next_offset: (next < total).then_some(next),
        warnings,
    })
}

pub(crate) fn import(root: &Path, records: Vec<Value>) -> Result<usize, String> {
    if records.len() > 100 {
        return Err("import at most 100 benchmark records at a time".into());
    }
    for record in &records {
        validate_record(record)?;
    }
    let _lock = StoreLock::acquire(root)?;
    let mut imported = 0;
    let mut existing = existing_digests(root)?;
    for record in records {
        let Some(path) = path_for(root, &record, &existing)? else {
            continue;
        };
        let digest = record_digest(&record);
        let mut result = record["result"].clone();
        result
            .as_object_mut()
            .ok_or("benchmark result is missing")?
            .remove("rows");
        let mut bytes = encoded(&Entry::Start {
            record,
            origin: Some(JournalOrigin::Legacy),
        })?;
        bytes.extend(encoded(&Entry::Finish { result })?);
        crate::config::atomic_write(&path, &bytes)?;
        sync_parent(&path)?;
        existing.insert(digest);
        imported += 1;
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::performance_bench::PerformanceBenchRow;
    pub(super) fn root() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("aiolm-benchmark-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    pub(super) fn record(id: &str, created: u64) -> Value {
        json!({ "schemaVersion": 1, "id": id, "createdAt": created, "model": "synthetic.gguf", "backend": "cpu", "build": "synthetic",
            "request": { "run_id": id, "prompt_lengths": [16], "generation_length": 8, "batch_sizes": [], "repetitions": 1, "context_profile": "novel_en", "warmup": false },
            "result": { "run_id": id, "rows": [], "status": "complete", "message": null, "args": [], "runtime_version": "synthetic", "context_size": 256, "parallel": 1 } })
    }
    pub(super) fn row() -> PerformanceBenchRow {
        PerformanceBenchRow {
            id: "synthetic-trial".into(),
            prompt_tokens: 16,
            generation_length: 8,
            concurrency: 1,
            repetition: 1,
            completion_tokens: 8,
            cached_tokens: 0,
            ttft_ms: Some(1.0),
            tpot_ms: Some(1.0),
            pp_tps: Some(100.0),
            tg_tps: Some(10.0),
            e2e_ms: 8.0,
            total_tps: Some(1.0),
            peak_memory_bytes: None,
            timing_source: "client",
            error: None,
        }
    }
    #[test]
    fn history_keeps_more_than_twenty_runs_and_import_preserves_native_ids() {
        let root = root();
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        let records: Vec<_> = (0..25)
            .map(|index| record(&format!("synthetic-{index}"), index))
            .collect();
        assert_eq!(import(&root, records.clone()).unwrap(), 25);
        assert_eq!(import(&root, records).unwrap(), 0);
        let page = list(&root, 0, 20).unwrap();
        assert_eq!(page.total, 25);
        assert_eq!(page.next_offset, Some(20));
        assert_eq!(page.records[0]["createdAt"], 24);
        assert_eq!(list(&root, 20, 20).unwrap().records.len(), 5);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_run_recovers_complete_trials_and_ignores_torn_tail() {
        let root = root();
        let journal = RunJournal::begin(&root, record("interrupted", 10)).unwrap();
        let path = files(&root).unwrap().remove(0);
        drop(journal);
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(&encoded(&Entry::Trial { row: json!(row()) }).unwrap())
            .unwrap();
        file.write_all(b"{\"kind\":\"finish\",\"result\":").unwrap();
        file.sync_all().unwrap();
        drop(file);
        let page = list(&root, 0, 20).unwrap();
        assert_eq!(page.records[0]["result"]["status"], "partial");
        assert_eq!(
            page.records[0]["result"]["rows"].as_array().unwrap().len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ids_cannot_escape_store_and_import_rejects_mismatched_records() {
        let root = root();
        import(&root, vec![record("../../synthetic", 0)]).unwrap();
        assert_eq!(files(&root).unwrap().len(), 1);
        let mut invalid = record("a", 0);
        invalid["result"]["run_id"] = json!("b");
        assert!(import(&root, vec![invalid]).is_err());
        let mut invalid_provenance = record("invalid-provenance", 1);
        invalid_provenance["result"]["provenance"] = json!({ "schema_version": 1 });
        assert!(import(&root, vec![invalid_provenance.clone()]).is_err());
        let path = root
            .join("runs")
            .join("0000000000000001-invalid-provenance.jsonl");
        fs::write(
            &path,
            encoded(&Entry::Start {
                record: invalid_provenance,
                origin: None,
            })
            .unwrap(),
        )
        .unwrap();
        let history = list(&root, 0, 20).unwrap();
        assert_eq!(history.records.len(), 1);
        assert_eq!(history.warnings.len(), 1);
        assert!(path.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn active_run_stays_out_of_history_and_finalization_does_not_duplicate_rows() {
        let root = root();
        let initial = record("durable", 10);
        let request = serde_json::from_value(initial["request"].clone()).unwrap();
        let journal = RunJournal::begin(&root, initial).unwrap();
        let mut result = crate::performance_bench::failed(
            &request,
            &crate::config::AppConfig::default(),
            "pending".into(),
        );
        result.args = vec!["--threads".into(), "8".into()];
        journal.checkpoint(&result).unwrap();
        result.rows.push(row());
        journal.checkpoint(&result).unwrap();
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        let recovered = replay(&journal.path).unwrap();
        assert_eq!(recovered["result"]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(recovered["result"]["status"], "partial");
        assert_eq!(recovered["result"]["args"][1], "8");
        result.status = "complete";
        result.message = None;
        journal.finish(&result).unwrap();
        drop(journal);
        let reopened = list(&root, 0, 20).unwrap();
        assert_eq!(
            reopened.records[0]["result"]["rows"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(reopened.records[0]["result"]["status"], "complete");
        assert!(reopened.records[0]["result"].get("provenance").is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn write_failures_are_reported_without_losing_prior_measurements() {
        let root = root();
        let initial = record("failed-write", 10);
        let request = serde_json::from_value(initial["request"].clone()).unwrap();
        let journal = RunJournal::begin(&root, initial).unwrap();
        let mut result = crate::performance_bench::failed(
            &request,
            &crate::config::AppConfig::default(),
            "pending".into(),
        );
        result.rows.push(row());
        journal.checkpoint(&result).unwrap();
        journal.writer.lock().unwrap().file = File::open(&journal.path).unwrap();
        let mut second = row();
        second.id = "second-trial".into();
        result.rows.push(second);
        assert!(journal.checkpoint(&result).is_err());
        drop(journal);
        assert_eq!(
            list(&root, 0, 20).unwrap().records[0]["result"]["rows"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_record_does_not_hide_other_history_and_is_preserved() {
        let root = root();
        import(&root, vec![record("good", 1)]).unwrap();
        let corrupt = root.join("runs").join("0000000000000002-corrupt.jsonl");
        fs::write(&corrupt, b"corrupt\n").unwrap();
        let history = list(&root, 0, 20).unwrap();
        assert_eq!(history.records.len(), 1);
        assert_eq!(history.total, 2);
        assert_eq!(history.warnings.len(), 1);
        assert!(corrupt.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
