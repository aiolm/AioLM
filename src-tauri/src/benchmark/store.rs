//! One append-only journal per run. Only the requested history page is decoded;
//! interrupted writes discard their incomplete final line, preserving trials.
mod deletions;
mod locks;
mod receipts;
pub(crate) use deletions::delete;
pub(crate) use receipts::{acknowledge, Acknowledgement, UploadReceipt};

use crate::error::AppError;
use crate::performance_bench::{PerformanceBenchRequest, PerformanceBenchResult};
use locks::{RunLock, StoreLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const MAX_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
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
}

fn encoded(entry: &Entry) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(entry).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn metadata(result: &PerformanceBenchResult) -> Value {
    let mut value = json!({
        "run_id": result.run_id, "status": result.status, "message": result.message,
        "args": result.args,
    });
    if let Some(engine_args) = &result.engine_args {
        value["engine_args"] = json!(engine_args);
    }
    if let Some(error) = &result.engine_args_error {
        value["engine_args_error"] = json!(error);
    }
    if let Some(provenance) = &result.provenance {
        value["provenance"] = json!(provenance);
    }
    value
}

fn valid_serving_row(value: &Value) -> bool {
    crate::performance_bench::PerformanceBenchRow::deserialize(value)
        .is_ok_and(|row| row.validate())
}

fn validate_serving_record(record: &Value) -> Result<(), String> {
    let id = record
        .get("id")
        .and_then(Value::as_str)
        .ok_or("benchmark record is missing its id")?;
    if id.is_empty()
        || id.len() > 128
        || !record
            .get("createdAt")
            .and_then(Value::as_u64)
            .is_some_and(|n| n <= 8_640_000_000_000_000)
        || !record.get("model").is_some_and(Value::is_string)
    {
        return Err("invalid benchmark record envelope".into());
    }
    let raw_request = record
        .get("request")
        .ok_or("benchmark request is missing")?;
    let mut request =
        PerformanceBenchRequest::deserialize(raw_request).map_err(|e| e.to_string())?;
    crate::performance_bench::validate_request(&mut request)?;
    let rows = record
        .pointer("/result/rows")
        .and_then(Value::as_array)
        .ok_or("benchmark rows are missing")?;
    if id != request.run_id
        || record.pointer("/result/run_id").and_then(Value::as_str) != Some(id)
        || rows.len() > 10000
        || !rows.iter().all(valid_serving_row)
        || !record
            .pointer("/result/args")
            .and_then(Value::as_array)
            .is_some_and(|args| args.iter().all(Value::is_string))
        || !record.pointer("/result/engine_args").is_none_or(|args| {
            args.as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
        })
        || !record
            .pointer("/result/engine_args_error")
            .is_none_or(Value::is_string)
        || record
            .pointer("/result/message")
            .is_some_and(|v| !v.is_null() && !v.is_string())
        || !record
            .pointer("/result/status")
            .and_then(Value::as_str)
            .is_some_and(|s| ["complete", "partial", "failed", "cancelled"].contains(&s))
    {
        return Err("benchmark record and request do not match".into());
    }
    let mut input_hashes = HashSet::new();
    for value in rows {
        let hashes = value["input_sha256_by_request"]
            .as_array()
            .ok_or("cold prompt trial is missing request input hashes")?;
        if hashes.len() != value["concurrency"].as_u64().unwrap() as usize {
            return Err("cold prompt input hashes do not match the request slots".into());
        }
        for hash in hashes {
            let hash = hash.as_str().ok_or("invalid cold prompt input hash")?;
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || !input_hashes.insert(hash)
            {
                return Err(
                    "cold prompt request input hashes must be valid and globally unique".into(),
                );
            }
        }
    }
    let mut points = HashSet::new();
    for row in rows {
        let input = row["input_bytes"].as_u64().unwrap() as u32;
        let concurrency = row["concurrency"].as_u64().unwrap() as u32;
        let cap = row["max_output_tokens"].as_u64().unwrap() as u32;
        let repetition = row["repetition"].as_u64().unwrap() as u32;
        if !request.prompt_bytes.contains(&input)
            || !request.concurrencies.contains(&concurrency)
            || cap != request.max_output_tokens
            || repetition > request.repetitions
            || !points.insert((input, concurrency, cap, repetition))
        {
            return Err("serving trial is outside the requested grid or duplicated".into());
        }
    }
    if let Some(value) = record.pointer("/result/provenance") {
        let provenance = super::provenance::ServingBenchmarkProvenance::deserialize(value)
            .map_err(|e| format!("invalid benchmark provenance: {e}"))?;
        provenance.validate(&request.context_profile)?;
        let workload = &provenance.workload;
        if provenance.method.version != request.method.version
            || workload
                .inputs
                .iter()
                .map(|input| input.bytes)
                .collect::<Vec<_>>()
                != request.prompt_bytes
            || workload.concurrencies != request.concurrencies
            || workload.max_output_tokens != request.max_output_tokens
            || workload.repetitions != request.repetitions
            || workload.warmup != request.warmup
            // Usage may be frozen off after the first batch negotiates it.
            || (workload.request_usage && !request.request_usage)
        {
            return Err("serving provenance does not match the requested workload".into());
        }
        let first_concurrency = request.concurrencies[0];
        for row in rows {
            if row["concurrency"].as_u64() == Some(u64::from(first_concurrency))
                && row["repetition"].as_u64() == Some(1)
            {
                let input = workload
                    .inputs
                    .iter()
                    .find(|input| row["input_bytes"].as_u64() == Some(u64::from(input.bytes)))
                    .ok_or("cold prompt trial has no input descriptor")?;
                if row["input_sha256_by_request"][0].as_str() != Some(input.sha256.as_str()) {
                    return Err(
                        "cold prompt input descriptor does not match the first request".into(),
                    );
                }
            }
        }
        if provenance.execution.memory_scope
            == crate::providers::protocol::ServingMemoryScope::Unavailable
            && rows.iter().any(|row| !row["peak_memory_bytes"].is_null())
        {
            return Err("serving memory measurement has no owned scope".into());
        }
    } else if !rows.is_empty() {
        return Err("serving measurements require frozen provenance".into());
    }
    if record.pointer("/result/status").and_then(Value::as_str) == Some("complete")
        && points.len()
            != request.prompt_bytes.len()
                * request.concurrencies.len()
                * request.repetitions as usize
    {
        return Err("complete serving benchmark is missing requested trials".into());
    }
    // A complete serving grid can exceed the publication cap while fitting its local journal.
    if serde_json::to_vec(record).map_err(|e| e.to_string())?.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("benchmark record exceeds the storage size limit".into());
    }
    Ok(())
}

fn files(root: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = files_unsorted(root)?;
    paths.sort_unstable_by(|left, right| right.file_name().cmp(&left.file_name()));
    Ok(paths)
}

fn files_unsorted(root: &Path) -> Result<Vec<PathBuf>, AppError> {
    let entries = match fs::read_dir(root.join("runs")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(AppError::io("cannot read benchmark history", &error)),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| AppError::from_io(&error))?;
        if !entry
            .file_type()
            .map_err(|error| AppError::from_io(&error))?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn validate_record(record: &Value) -> Result<(), String> {
    if record.get("schemaVersion").and_then(Value::as_u64) != Some(3) {
        return Err("unsupported benchmark record".into());
    }
    validate_serving_record(record)
}

fn record_digest(record: &Value) -> String {
    format!(
        "{:x}.jsonl",
        Sha256::digest(record["id"].as_str().expect("validated id").as_bytes())
    )
}

fn existing_digests(root: &Path) -> Result<HashSet<String>, AppError> {
    Ok(files_unsorted(root)?
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
) -> Result<Option<PathBuf>, AppError> {
    validate_record(record).map_err(AppError::validation)?;
    let digest = record_digest(record);
    let id = record["id"].as_str().expect("validated id");
    if existing.contains(&digest)
        || receipts::has_tombstone(root, id)?
        || deletions::has_tombstone(root, id)?
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
    pub(crate) fn begin(root: &Path, record: Value) -> Result<Self, AppError> {
        let _lock = StoreLock::acquire(root)?;
        let path = path_for(root, &record, &existing_digests(root)?)?
            .ok_or_else(|| AppError::validation("benchmark run id already exists"))?;
        let rows = record["result"]["rows"]
            .as_array()
            .expect("validated rows")
            .len();
        let run_id = record["id"].as_str().expect("validated id").to_owned();
        let run_lock = RunLock::acquire(root, &run_id)?.ok_or_else(|| {
            AppError::busy("benchmark run is active in another application instance")
        })?;
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
            .map_err(|error| AppError::from_io(&error))?;
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

    pub(crate) fn checkpoint(&self, result: &PerformanceBenchResult) -> Result<(), AppError> {
        self.write(result, false)
    }

    pub(crate) fn finish(&self, result: &PerformanceBenchResult) -> Result<(), AppError> {
        self.write(result, true)
    }

    fn write(&self, result: &PerformanceBenchResult, finish: bool) -> Result<(), AppError> {
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
            .map_err(|error| AppError::from_io(&error))?
            .len();
        if length + bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(AppError::validation(
                "benchmark journal exceeds the storage size limit",
            ));
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
            return Err(AppError::io("cannot persist benchmark measurement", &error));
        }
        writer.rows = result.rows.len();
        writer.prepared = true;
        Ok(())
    }
}

fn sync_parent(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    File::open(path.parent().ok_or("benchmark path has no directory")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| AppError::from_io(&error))?;
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

/// Inspect only the start line: unsupported journals remain untouched and are
/// excluded before pagination without decoding historical rows or provenance.
fn supported_journal(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path).map_err(|error| AppError::from_io(&error))?;
    let mut line = Vec::new();
    BufReader::new(file)
        .take(MAX_JOURNAL_BYTES + 1)
        .read_until(b'\n', &mut line)
        .map_err(|error| AppError::from_io(&error))?;
    if !line.ends_with(b"\n") || line.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(AppError::validation(
            "benchmark journal has no complete start event",
        ));
    }
    let start: Value = serde_json::from_slice(&line).map_err(|error| {
        AppError::validation(format!(
            "benchmark journal contains a corrupt event: {error}"
        ))
    })?;
    if start["kind"] != "start" {
        return Err(AppError::validation(
            "benchmark journal has no complete start event",
        ));
    }
    Ok(start
        .pointer("/record/schemaVersion")
        .and_then(Value::as_u64)
        == Some(3))
}

fn require_supported_journal(path: &Path) -> Result<(), AppError> {
    if !supported_journal(path)? {
        return Err(AppError::validation("unsupported benchmark record"));
    }
    Ok(())
}

fn replay_run(path: &Path) -> Result<ReplayedRun, AppError> {
    require_supported_journal(path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| AppError::from_io(&error))?
        .take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::from_io(&error))?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(AppError::validation(
            "benchmark journal exceeds the storage size limit",
        ));
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
        let entry: Entry = serde_json::from_slice(line).map_err(|error| {
            AppError::validation(format!(
                "benchmark journal contains a corrupt event: {error}"
            ))
        })?;
        match entry {
            Entry::Start {
                record: initial,
                origin: source,
            } => {
                if record.is_some() {
                    return Err(AppError::validation(
                        "benchmark journal contains duplicate start events",
                    ));
                }
                validate_record(&initial).map_err(AppError::validation)?;
                record = Some(initial);
                origin = source;
            }
            Entry::Trial { row } => {
                finished = false;
                if !valid_serving_row(&row) {
                    return Err(AppError::validation(
                        "benchmark journal contains an invalid trial",
                    ));
                }
                let rows = record
                    .as_mut()
                    .and_then(|value| value.pointer_mut("/result/rows"))
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| {
                        AppError::validation("benchmark trial is missing its start event")
                    })?;
                rows.push(row);
            }
            Entry::Metadata { result } => {
                finished = false;
                update_result(&mut record, result).map_err(AppError::validation)?;
            }
            Entry::Finish { result } => {
                update_result(&mut record, result).map_err(AppError::validation)?;
                finished = true;
            }
        }
    }
    let mut record = record
        .ok_or_else(|| AppError::validation("benchmark journal has no complete start event"))?;
    if !finished {
        let has_rows = record["result"]["rows"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty());
        record["result"]["status"] = json!(if has_rows { "partial" } else { "failed" });
        record["result"]["message"] = json!(
            "benchmark was interrupted before finalization; persisted measurements were recovered"
        );
    }
    validate_record(&record).map_err(AppError::validation)?;
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
    let Value::Object(result) = result else {
        return Err("benchmark metadata must be an object".into());
    };
    for (key, value) in result {
        if key != "rows" {
            target.insert(key, value);
        }
    }
    Ok(())
}

pub(crate) fn list(root: &Path, offset: usize, limit: usize) -> Result<HistoryPage, AppError> {
    let _lock = StoreLock::acquire(root)?;
    let (active_digests, mut warnings) = locks::active_digests(root)?;
    let deleted = deletions::deleted_digests(root)?;
    let paths = {
        let active = ACTIVE_RUNS
            .lock()
            .map_err(|_| "active benchmark store lock was poisoned")?;
        files(root)?
            .into_iter()
            .filter(|path| !active.contains(path))
            .filter(|path| {
                !RunLock::journal_digest(path)
                    .is_ok_and(|digest| active_digests.contains(digest) || deleted.contains(digest))
            })
            .filter(|path| !matches!(supported_journal(path), Ok(false)))
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
    pub(super) fn serving_row() -> PerformanceBenchRow {
        serde_json::from_value(json!({"id":"synthetic-trial", "input_bytes":256,
            "max_output_tokens":128,"concurrency":1,"repetition":1,
            "input_sha256_by_request":["a".repeat(64)],
            "first_output_ms":1.0,"e2e_ms":8.0,"output_bytes":2,
            "reported_prompt_tokens":null,"reported_completion_tokens":null,
            "prefill_tokens_per_second":null,"decode_tokens_per_second":null,"tpot_ms":null,
            "usage_status":"missing","finish_reasons":["stop"],"peak_memory_bytes":null,
            "timing_source":"client","failed":false,"error":null}))
        .unwrap()
    }

    pub(super) fn serving_result(id: &str) -> PerformanceBenchResult {
        let cfg = crate::config::AppConfig::default();
        let request = PerformanceBenchRequest {
            run_id: id.into(),
            method: crate::performance_bench::ServingMethod {
                id: "openai-chat-serving".into(),
                version: crate::performance_bench::METHOD_VERSION,
            },
            context_profile: "novel_en".into(),
            prompt_bytes: vec![256],
            max_output_tokens: 128,
            concurrencies: vec![1],
            repetitions: 1,
            warmup: false,
            request_usage: true,
        };
        let workload = serde_json::from_value(json!({
            "corpus":"novel_en","corpus_version":2,
            "inputs":[{"bytes":256,"sha256":"a".repeat(64)}],
            "max_output_tokens":128,"concurrencies":[1],"repetitions":1,
            "warmup":false,"request_usage":true,"cache_policy":"cold_prompt",
            "prompt_nonce":"0123456789abcdef0123456789abcdef"
        }))
        .unwrap();
        let model = serde_json::from_value(
            json!({"status":"unidentified","sha256":null,"size_bytes":null}),
        )
        .unwrap();
        let profile = serde_json::from_value(json!({
            "schema_version":1, "fingerprint":"synthetic",
            "os":"synthetic", "arch":"synthetic", "cpu":{"name":"synthetic","logical_cores":1},
            "gpus":[], "detection":"synthetic"
        }))
        .unwrap();
        let mut result = crate::performance_bench::failed(&request, &cfg, "pending".into());
        result.provenance = Some(super::super::provenance::capture_serving(
            &cfg,
            &profile,
            model,
            workload,
            None,
            "Synthetic model".into(),
        ));
        result
    }

    pub(super) fn serving_record(id: &str, created: u64) -> Value {
        json!({"schemaVersion":3,"id":id,"createdAt":created,"model":"synthetic.model",
            "request":{"run_id":id,"method":{"id":"openai-chat-serving","version":5},
                "context_profile":"novel_en","prompt_bytes":[256],"max_output_tokens":128,
                "concurrencies":[1],"repetitions":1,"warmup":false,"request_usage":true},
            "result":serving_result(id)})
    }

    #[test]
    fn metadata_updates_preserve_unknown_values_and_persisted_rows() {
        let mut stored = Some(serving_record("metadata", 7));
        let persisted_rows = json!([serving_row()]);
        stored.as_mut().unwrap()["result"]["rows"] = persisted_rows.clone();
        let extension = json!({"nested": [null, {"é": "漢字"}], "enabled": true});
        for (index, incoming_rows) in [
            json!([{"must_not_replace": true}]),
            Value::Null,
            json!({"not": "rows"}),
            json!(7),
        ]
        .into_iter()
        .enumerate()
        {
            update_result(
                &mut stored,
                json!({"rows": incoming_rows, "extension": extension.clone(), "nullable": null, "last": index}),
            )
            .unwrap();
            let result = &stored.as_ref().unwrap()["result"];
            assert_eq!(result["rows"], persisted_rows);
            assert_eq!(result["extension"], extension);
            assert_eq!(result.get("nullable"), Some(&Value::Null));
            assert_eq!(result["last"], json!(index));
        }
    }

    #[test]
    fn metadata_requires_a_start_before_rejecting_non_object_updates() {
        for incoming in [
            Value::Null,
            json!(false),
            json!("invalid"),
            json!([]),
            json!({}),
        ] {
            let mut missing = None;
            assert_eq!(
                update_result(&mut missing, incoming).unwrap_err(),
                "benchmark metadata is missing its start event"
            );
            assert!(missing.is_none());
        }
        for incoming in [Value::Null, json!(false), json!("invalid"), json!([])] {
            let mut stored = Some(serving_record("metadata", 7));
            let before = stored.clone();
            assert_eq!(
                update_result(&mut stored, incoming).unwrap_err(),
                "benchmark metadata must be an object"
            );
            assert_eq!(stored, before);
        }
    }

    #[test]
    fn unsupported_journals_are_hidden_before_pagination_and_byte_identical() {
        let root = root();
        for index in 0..3 {
            let id = format!("supported-{index}");
            drop(RunJournal::begin(&root, serving_record(&id, index)).unwrap());
        }
        let runs = root.join("runs");
        let mut unsupported = Vec::new();
        for version in [1, 2] {
            let mut old = serving_record(&format!("unsupported-{version}"), 100 + version);
            old["schemaVersion"] = json!(version);
            let path = runs.join(format!("{:016}-{}", 100 + version, record_digest(&old)));
            let mut bytes = serde_json::to_vec(&json!({
                "kind":"start","origin":"legacy","record":old
            }))
            .unwrap();
            // The unread tail is intentionally not decodable by the new reader.
            bytes.extend_from_slice(b"\nold unsupported event\n{\"torn\":");
            fs::write(&path, &bytes).unwrap();
            unsupported.push((path, bytes));
        }
        let first = list(&root, 0, 2).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.records.len(), 2);
        assert_eq!(first.next_offset, Some(2));
        assert_eq!(first.records[0]["id"], "supported-2");
        assert!(first.warnings.is_empty(), "{:?}", first.warnings);
        let last = list(&root, 2, 2).unwrap();
        assert_eq!(last.records.len(), 1);
        assert_eq!(last.total, 3);
        assert_eq!(last.next_offset, None);
        assert!(last.warnings.is_empty());
        for (path, bytes) in unsupported {
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(
                replay_run(&path).err().unwrap(),
                AppError::validation("unsupported benchmark record")
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_paginates_all_supported_runs_and_rejects_duplicate_ids() {
        let root = root();
        for index in 0..25 {
            let id = format!("supported-{index}");
            drop(RunJournal::begin(&root, serving_record(&id, index)).unwrap());
            assert!(RunJournal::begin(&root, serving_record(&id, index + 100)).is_err());
        }
        let first = list(&root, 0, 20).unwrap();
        assert_eq!(first.total, 25);
        assert_eq!(first.records.len(), 20);
        assert_eq!(first.records[0]["createdAt"], 24);
        assert_eq!(first.next_offset, Some(20));
        let last = list(&root, 20, 20).unwrap();
        assert_eq!(last.records.len(), 5);
        assert_eq!(last.next_offset, None);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_run_recovers_complete_trials_and_ignores_torn_tail() {
        let root = root();
        let journal = RunJournal::begin(&root, serving_record("interrupted", 10)).unwrap();
        let path = files(&root).unwrap().remove(0);
        drop(journal);
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(
            &encoded(&Entry::Trial {
                row: json!(serving_row()),
            })
            .unwrap(),
        )
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
    fn active_run_stays_out_of_history_and_finalization_does_not_duplicate_rows() {
        let root = root();
        let initial = serving_record("durable", 10);
        let journal = RunJournal::begin(&root, initial).unwrap();
        let mut result = serving_result("durable");
        result.args = vec!["--threads".into(), "8".into()];
        result.engine_args = Some(vec![
            r"C:\synthetic\engine.exe".into(),
            "--threads".into(),
            "8".into(),
        ]);
        journal.checkpoint(&result).unwrap();
        result.rows.push(serving_row());
        journal.checkpoint(&result).unwrap();
        assert_eq!(list(&root, 0, 20).unwrap().total, 0);
        let recovered = replay(&journal.path).unwrap();
        assert_eq!(recovered["result"]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(recovered["result"]["status"], "partial");
        assert_eq!(recovered["result"]["args"][1], "8");
        assert_eq!(
            recovered["result"]["engine_args"],
            json!([r"C:\synthetic\engine.exe", "--threads", "8"])
        );
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
        assert_eq!(
            reopened.records[0]["result"]["engine_args"],
            json!([r"C:\synthetic\engine.exe", "--threads", "8"])
        );
        assert_eq!(
            reopened.records[0]["result"]["provenance"]["schema_version"],
            3
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn engine_args_validation_allows_absence_and_rejects_non_string_tokens() {
        let legacy = serving_record("legacy-without-engine-args", 10);
        assert!(legacy["result"].get("engine_args").is_none());
        validate_record(&legacy).unwrap();

        let mut valid_with_engine_args = legacy.clone();
        valid_with_engine_args["result"]["engine_args"] =
            json!(["/synthetic/engine", "--threads", "8"]);
        validate_record(&valid_with_engine_args).unwrap();

        let mut bad_type = legacy.clone();
        bad_type["result"]["engine_args"] = json!("not-an-array");
        assert!(validate_record(&bad_type).is_err());

        let mut bad_element = legacy.clone();
        bad_element["result"]["engine_args"] = json!(["/synthetic/engine", 8]);
        assert!(validate_record(&bad_element).is_err());

        let mut capture_failed = legacy.clone();
        capture_failed["result"]["engine_args_error"] = json!("synthetic capture failure");
        validate_record(&capture_failed).unwrap();

        let mut bad_error = legacy;
        bad_error["result"]["engine_args_error"] = json!(["not", "a", "string"]);
        assert!(validate_record(&bad_error).is_err());
    }

    #[test]
    fn engine_capture_failure_reason_survives_checkpoint_and_finish() {
        let root = root();
        let journal = RunJournal::begin(&root, serving_record("capture-failed", 10)).unwrap();
        let mut result = serving_result("capture-failed");
        result.args = vec!["/synthetic/aiolm".into(), "--internal-runtime-auto".into()];
        result.engine_args_error = Some("synthetic capture failure".into());
        result.rows.push(serving_row());
        journal.checkpoint(&result).unwrap();
        let recovered = replay(&journal.path).unwrap();
        assert!(recovered["result"].get("engine_args").is_none());
        assert_eq!(
            recovered["result"]["engine_args_error"],
            "synthetic capture failure"
        );
        result.status = "complete";
        result.message = None;
        journal.finish(&result).unwrap();
        drop(journal);
        let reopened = list(&root, 0, 20).unwrap();
        assert_eq!(
            reopened.records[0]["result"]["engine_args_error"],
            "synthetic capture failure"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn usage_downgrade_is_durable_before_any_trial_and_after_completion() {
        let root = root();
        let id = "usage-downgrade";
        let initial = serving_record(id, 10);
        let row = serving_row();
        let mut result = serving_result(id);
        let journal = RunJournal::begin(&root, initial).unwrap();

        let provenance = result.provenance.as_mut().unwrap();
        provenance.workload.request_usage = false;
        provenance.execution.settings =
            super::super::provenance::common_request_settings(128, false);
        journal.checkpoint(&result).unwrap();
        let prepared = replay(&journal.path).unwrap();
        assert_eq!(prepared["request"]["request_usage"], true);
        assert_eq!(
            prepared["result"]["provenance"]["workload"]["request_usage"],
            false
        );
        assert_eq!(prepared["result"]["rows"], json!([]));
        assert_eq!(
            prepared["result"]["provenance"]["execution"]["settings"],
            json!(super::super::provenance::common_request_settings(
                128, false
            ))
        );

        result.rows.push(row);
        journal.checkpoint(&result).unwrap();
        let measured = replay(&journal.path).unwrap();
        assert_eq!(measured["request"]["request_usage"], true);
        assert_eq!(
            measured["result"]["provenance"]["workload"]["request_usage"],
            false
        );
        assert_eq!(measured["result"]["rows"].as_array().unwrap().len(), 1);
        result.status = "complete";
        result.message = None;
        journal.finish(&result).unwrap();
        drop(journal);
        let reopened = list(&root, 0, 20).unwrap();
        assert!(reopened.warnings.is_empty(), "{:?}", reopened.warnings);
        assert_eq!(reopened.total, 1);
        assert_eq!(reopened.records[0]["request"]["request_usage"], true);
        assert_eq!(
            reopened.records[0]["result"]["provenance"]["workload"]["request_usage"],
            false
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serving_identity_and_formats_survive_interrupted_and_finished_history() {
        use crate::providers::artifacts::ArtifactFormat;
        let root = root();
        for (index, format) in [
            ArtifactFormat::HfSafetensors,
            ArtifactFormat::Mlx,
            ArtifactFormat::Gguf,
            ArtifactFormat::Unknown,
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("serving-history-{index}");
            let initial = serving_record(&id, 10 + index as u64);
            let journal = RunJournal::begin(&root, initial).unwrap();
            let mut result = serving_result(&id);
            let provenance = result.provenance.as_mut().unwrap();
            provenance.runtime.name = Some("fourth-engine".into());
            provenance.runtime.version = Some("0.30.0".into());
            provenance.runtime.variant = Some("metal-variant".into());
            provenance.runtime.plugin_version = Some("0.30.1".into());
            provenance.runtime.backend = Some("metal".into());
            provenance.model.format = Some(format);
            let mut row = serving_row();
            row.e2e_ms = 52.591_499_999_999_996;
            result.rows.push(row);
            journal.checkpoint(&result).unwrap();
            if index != 0 {
                result.status = "complete";
                result.message = None;
                journal.finish(&result).unwrap();
            }
            drop(journal);
            let stored = list(&root, 0, 20)
                .unwrap()
                .records
                .into_iter()
                .find(|value| value["id"] == id)
                .unwrap();
            let recorded = &stored["result"]["provenance"];
            assert_eq!(recorded["runtime"]["name"], "fourth-engine");
            assert_eq!(recorded["runtime"]["version"], "0.30.0");
            assert_eq!(recorded["runtime"]["variant"], "metal-variant");
            assert_eq!(recorded["runtime"]["plugin_version"], "0.30.1");
            assert_eq!(recorded["model"]["format"], json!(format));
            assert_eq!(recorded["workload"]["inputs"][0]["bytes"], 256);
            assert_eq!(
                stored["result"]["rows"][0]["e2e_ms"].as_f64(),
                Some(52.591_499_999_999_996)
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn write_failures_are_reported_without_losing_prior_measurements() {
        let root = root();
        let initial = serving_record("failed-write", 10);
        let journal = RunJournal::begin(&root, initial).unwrap();
        let mut result = serving_result("failed-write");
        result.rows.push(serving_row());
        journal.checkpoint(&result).unwrap();
        journal.writer.lock().unwrap().file = File::open(&journal.path).unwrap();
        let mut second = serving_row();
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
        drop(RunJournal::begin(&root, serving_record("good", 1)).unwrap());
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

#[cfg(test)]
mod serving_validation_tests {
    use super::*;

    #[test]
    fn current_rows_reject_invalid_usage_rates_and_non_grid_trials() {
        let mut complete = tests::serving_record("validated-serving", 1);
        complete["result"]["rows"] = json!([tests::serving_row()]);
        complete["result"]["status"] = json!("complete");
        complete["result"]["message"] = Value::Null;
        validate_record(&complete).unwrap();
        for mutation in [
            ("reported_prompt_tokens", json!(9_007_199_254_740_992u64)),
            ("usage_status", json!("complete")),
            ("content_bytes", json!(2)),
            ("prefill_tokens_per_second", json!(100.0)),
            ("max_output_tokens", json!(64)),
            ("peak_memory_bytes", json!(1)),
            ("finish_reasons", json!([])),
        ] {
            let mut invalid = complete.clone();
            invalid["result"]["rows"][0][mutation.0] = mutation.1;
            assert!(validate_record(&invalid).is_err(), "{}", mutation.0);
        }
        let mut duplicate = complete.clone();
        duplicate["result"]["rows"] = json!([tests::serving_row(), tests::serving_row()]);
        assert!(validate_record(&duplicate).is_err());
        let mut incomplete = complete;
        incomplete["result"]["rows"] = json!([]);
        assert!(validate_record(&incomplete).is_err());
        incomplete["result"]["status"] = json!("failed");
        validate_record(&incomplete).unwrap();
    }

    fn cold_prompt_record() -> Value {
        let mut record = tests::serving_record("cold-prompt-round-trip", 4);
        record["request"]["concurrencies"] = json!([1, 2]);
        record["request"]["repetitions"] = json!(2);
        let provenance = &mut record["result"]["provenance"];
        provenance["workload"]["concurrencies"] = json!([1, 2]);
        provenance["workload"]["repetitions"] = json!(2);
        provenance["workload"]["inputs"][0]["sha256"] = json!("a".repeat(64));
        let template = json!(tests::serving_row());
        record["result"]["rows"] = json!([
            (1, 1, vec!["a".repeat(64)]),
            (1, 2, vec!["b".repeat(64)]),
            (2, 1, vec!["c".repeat(64), "d".repeat(64)]),
            (2, 2, vec!["e".repeat(64), "f".repeat(64)]),
        ]
        .into_iter()
        .map(|(concurrency, repetition, hashes)| {
            let mut row = template.clone();
            row["id"] = json!(format!("c{concurrency}-r{repetition}"));
            row["concurrency"] = json!(concurrency);
            row["repetition"] = json!(repetition);
            row["finish_reasons"] = json!(vec!["stop"; concurrency]);
            row["input_sha256_by_request"] = json!(hashes);
            row
        })
        .collect::<Vec<_>>());
        record["result"]["status"] = json!("complete");
        record["result"]["message"] = Value::Null;
        record
    }

    #[test]
    fn store_round_trip_retains_all_point_hashes() {
        let cold = cold_prompt_record();
        let mut cold = cold;
        cold["request"]["request_usage"] = json!(false);
        cold["result"]["provenance"]["workload"]["request_usage"] = json!(false);
        cold["result"]["provenance"]["execution"]["settings"] = json!(
            super::super::provenance::common_request_settings(128, false)
        );
        let root = tests::root();
        for cap in [1, 128] {
            let mut boundary = cold.clone();
            boundary["request"]["max_output_tokens"] = json!(cap);
            boundary["result"]["provenance"]["workload"]["max_output_tokens"] = json!(cap);
            boundary["result"]["provenance"]["execution"]["settings"] = json!(
                super::super::provenance::common_request_settings(cap, false)
            );
            for row in boundary["result"]["rows"].as_array_mut().unwrap() {
                row["max_output_tokens"] = json!(cap);
            }
            validate_record(&boundary).unwrap();
        }
        let mut downgraded = cold.clone();
        downgraded["request"]["request_usage"] = json!(true);
        validate_record(&downgraded).unwrap();
        for (pointer, value) in [
            ("/result/provenance/workload/prompt_nonce", Value::Null),
            (
                "/result/provenance/workload/prompt_nonce",
                json!("a".repeat(31)),
            ),
            (
                "/result/provenance/workload/prompt_nonce",
                json!("A".repeat(32)),
            ),
            ("/result/provenance/workload/corpus_version", json!(1)),
            (
                "/result/provenance/workload/cache_policy",
                json!("as_configured"),
            ),
            ("/result/provenance/workload/warmup", json!(true)),
            ("/result/provenance/workload/request_usage", json!(true)),
            (
                "/result/provenance/workload/inputs/0/sha256",
                json!("0".repeat(64)),
            ),
            ("/result/rows/0/input_sha256_by_request", Value::Null),
            ("/result/rows/0/input_sha256_by_request", json!([])),
            (
                "/result/rows/0/input_sha256_by_request",
                json!(["A".repeat(64)]),
            ),
            (
                "/result/rows/2/input_sha256_by_request",
                json!(["c".repeat(64)]),
            ),
            (
                "/result/rows/2/input_sha256_by_request",
                json!(["c".repeat(64), "c".repeat(64)]),
            ),
            (
                "/result/rows/2/input_sha256_by_request",
                json!(["a".repeat(64), "d".repeat(64)]),
            ),
        ] {
            let mut invalid = cold.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(validate_record(&invalid).is_err(), "{pointer}");
        }
        let mut missing = cold.clone();
        missing["result"]["rows"][0]
            .as_object_mut()
            .unwrap()
            .remove("input_sha256_by_request");
        assert!(validate_record(&missing).is_err());
        for topology in ["owned", "attached", "unknown"] {
            let mut supported = cold.clone();
            supported["result"]["provenance"]["execution"]["topology"] = json!(topology);
            validate_record(&supported).unwrap();
        }
        let mut initial = cold.clone();
        initial["result"]["rows"] = json!([]);
        initial["result"]["status"] = json!("failed");
        let journal = RunJournal::begin(&root, initial).unwrap();
        let mut result = tests::serving_result("cold-prompt-round-trip");
        result.provenance =
            Some(serde_json::from_value(cold["result"]["provenance"].clone()).unwrap());
        result.rows = serde_json::from_value(cold["result"]["rows"].clone()).unwrap();
        result.status = "complete";
        result.message = None;
        journal.finish(&result).unwrap();
        drop(journal);
        let page = list(&root, 0, 10).unwrap();
        assert!(page.warnings.is_empty(), "{:?}", page.warnings);
        let mut expected = cold;
        expected["localState"] = json!("recovery");
        assert_eq!(page.records, vec![expected]);
        fs::remove_dir_all(root).unwrap();
    }
}
