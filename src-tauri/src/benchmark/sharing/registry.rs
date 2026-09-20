//! Durable per-submission owner records binding submissions to body hashes.
//!
//! Each submission owns one small record file
//! `<benchmarks>/sharing/owners/<sha256hex(submission_id)>.json` holding only
//! non-secret metadata: credential reference, exact request-body SHA-256,
//! destination endpoint, service origin and creation time. Full publication
//! bodies (up to 4 MiB) and owner secrets are never stored here.
//!
//! Reads open a single record file directly: no directory creation, no lock
//! files, no rewrites, so lookups and paginated listing scale past thousands
//! of bindings and never mutate storage. Mutations serialize across app
//! processes on a stable per-submission OS lock file that measurement code
//! never acquires, so registry work cannot make a measurement wait and one
//! submission never waits on another's vault prompt. A crash between the
//! vault write and the record commit leaves a pending intent file that the
//! next attempt completes instead of orphaning a key.

use super::errors::SharingError;
use super::vault::VAULT_SERVICE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

const RECORD_VERSION: u32 = 1;
const MAX_RECORD_BYTES: u64 = 4096;
pub(crate) const MAX_LIST_LIMIT: usize = 100;
pub(crate) const DEFAULT_LIST_LIMIT: usize = 25;
/// Caps skipped corrupt files per listing so a garbage directory cannot force
/// an unbounded scan; valid records are unaffected.
const MAX_LIST_SKIPS: usize = 128;

/// Placeholder body hash for bindings restored from a recovery file before
/// the frozen publication body is known. The first prepare adopts the real
/// hash; verification and submission refuse the placeholder.
pub(crate) const UNKNOWN_BODY: &str = "unknown";

fn valid_body_hash(hash: &str) -> bool {
    hash == UNKNOWN_BODY || (hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// Directory holding the registry, its lock files and per-submission records.
pub(crate) fn sharing_dir(benchmarks_root: &Path) -> PathBuf {
    benchmarks_root.join("sharing")
}

fn owners_dir(benchmarks_root: &Path) -> PathBuf {
    sharing_dir(benchmarks_root).join("owners")
}

fn legacy_path(benchmarks_root: &Path) -> PathBuf {
    sharing_dir(benchmarks_root).join("registry.json")
}

/// Non-secret handle the frontend may persist in its outbox.
pub(crate) fn credential_ref(submission_id: &str) -> String {
    format!("keyring/{VAULT_SERVICE}/{submission_id}")
}

/// Stable per-submission file stem: hex SHA-256 of the validated UUID.
fn record_stem(submission_id: &str) -> Result<String, SharingError> {
    super::recovery::validate_submission_id(submission_id).map_err(|_| {
        SharingError::binding_conflict_msg("The submission id is not a valid identifier.")
    })?;
    Ok(format!("{:x}", Sha256::digest(submission_id.as_bytes())))
}

fn record_path(benchmarks_root: &Path, submission_id: &str) -> Result<PathBuf, SharingError> {
    Ok(owners_dir(benchmarks_root).join(format!("{}.json", record_stem(submission_id)?)))
}

fn lock_path(benchmarks_root: &Path, submission_id: &str) -> Result<PathBuf, SharingError> {
    Ok(owners_dir(benchmarks_root).join(format!("{}.lock", record_stem(submission_id)?)))
}

fn pending_path(benchmarks_root: &Path, submission_id: &str) -> Result<PathBuf, SharingError> {
    Ok(owners_dir(benchmarks_root).join(format!("{}.pending.json", record_stem(submission_id)?)))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    version: u32,
    submission_id: String,
    credential_ref: String,
    body_sha256: String,
    destination: String,
    origin: String,
    created_at_ms: u64,
}

impl Record {
    /// Stage a crash-recovery intent before the vault write.
    pub(crate) fn stage(
        submission_id: &str,
        body_sha256: &str,
        destination: &str,
        origin: &str,
        created_at_ms: u64,
    ) -> Self {
        Self {
            version: RECORD_VERSION,
            submission_id: submission_id.into(),
            credential_ref: credential_ref(submission_id),
            body_sha256: body_sha256.into(),
            destination: destination.into(),
            origin: origin.into(),
            created_at_ms,
        }
    }

    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }
}

/// Immutable owner binding returned to callers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OwnerBinding {
    pub credential_ref: String,
    pub body_sha256: String,
    pub destination: String,
    pub origin: String,
    pub created_at_ms: u64,
}

impl From<Record> for OwnerBinding {
    fn from(entry: Record) -> Self {
        Self {
            credential_ref: entry.credential_ref,
            body_sha256: entry.body_sha256,
            destination: entry.destination,
            origin: entry.origin,
            created_at_ms: entry.created_at_ms,
        }
    }
}

/// Nonsecret ownership entry for the paginated recovery-management list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct OwnedItem {
    pub submission_id: String,
    pub credential_ref: String,
    pub destination: String,
    pub created_at_ms: u64,
}

pub(crate) fn now_ms() -> Result<u64, SharingError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| SharingError::vault_unavailable_msg("The ownership registry is unavailable."))
}

fn validate_record(record: &Record) -> Result<(), SharingError> {
    if record.version != RECORD_VERSION {
        return Err(SharingError::vault_unavailable_msg(
            "The ownership registry is unavailable.",
        ));
    }
    super::recovery::validate_submission_id(&record.submission_id).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    if record.credential_ref != credential_ref(&record.submission_id) {
        return Err(SharingError::vault_unavailable_msg(
            "The ownership registry is unavailable.",
        ));
    }
    if !valid_body_hash(&record.body_sha256) {
        return Err(SharingError::vault_unavailable_msg(
            "The ownership registry is unavailable.",
        ));
    }
    super::config::validate_base_url(&record.origin).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    let origin =
        super::config::origin_of(&super::config::validate_base_url(&record.origin).map_err(
            |_| SharingError::vault_unavailable_msg("The ownership registry is unavailable."),
        )?);
    super::config::validate_destination(&origin, &record.destination).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    if record.created_at_ms > 8_640_000_000_000_000 {
        return Err(SharingError::vault_unavailable_msg(
            "The ownership registry is unavailable.",
        ));
    }
    Ok(())
}

fn read_record_file(path: &Path) -> Result<Option<Record>, SharingError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(SharingError::vault_unavailable_msg(
                "The ownership registry is unavailable.",
            ));
        }
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
        })?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err(SharingError::vault_unavailable_msg(
            "The ownership registry is unavailable.",
        ));
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    validate_record(&record)?;
    Ok(Some(record))
}

fn write_record_file(path: &Path, record: &Record) -> Result<(), SharingError> {
    validate_record(record)?;
    crate::config::atomic_write(
        path,
        &serde_json::to_vec(record).map_err(|_| {
            SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
        })?,
    )
    .map_err(|_| SharingError::vault_unavailable_msg("The ownership registry is unavailable."))
}

/// Legacy single-file registry (previous iteration). Only read by the
/// one-time migration; never written by current code.
#[derive(Deserialize)]
struct LegacyFile {
    version: u32,
    bindings: HashMap<String, LegacyEntry>,
}

#[derive(Deserialize)]
struct LegacyEntry {
    credential_ref: String,
    body_sha256: String,
    destination: String,
    origin: String,
    created_at_ms: u64,
}

/// Migrate a legacy `registry.json` to per-submission records exactly once,
/// preserving every valid entry and renaming the original aside (never
/// deleting). Later calls are a cheap existence check with no writes.
fn ensure_migrated(benchmarks_root: &Path) -> Result<(), SharingError> {
    let legacy = legacy_path(benchmarks_root);
    if fs::symlink_metadata(&legacy).is_err() {
        return Ok(());
    }
    std::fs::create_dir_all(sharing_dir(benchmarks_root)).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    let migrate_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(sharing_dir(benchmarks_root).join(".migrate.lock"))
        .map_err(|_| {
            SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
        })?;
    migrate_lock.lock().map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    if fs::symlink_metadata(&legacy).is_err() {
        return Ok(());
    }
    let mut bytes = Vec::new();
    File::open(&legacy)
        .map_err(|_| SharingError::vault_unavailable_msg("The ownership registry is unavailable."))?
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
        })?;
    let legacy_file: LegacyFile = serde_json::from_slice(&bytes).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    if legacy_file.version != 1 {
        return Err(SharingError::vault_unavailable_msg(
            "The ownership registry is unavailable.",
        ));
    }
    std::fs::create_dir_all(owners_dir(benchmarks_root)).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    for (submission_id, entry) in &legacy_file.bindings {
        let record = Record {
            version: RECORD_VERSION,
            submission_id: submission_id.clone(),
            credential_ref: entry.credential_ref.clone(),
            body_sha256: entry.body_sha256.clone(),
            destination: entry.destination.clone(),
            origin: entry.origin.clone(),
            created_at_ms: entry.created_at_ms,
        };
        // Preserve first: never overwrite a record the new layout already owns.
        if validate_record(&record).is_ok() {
            if let Ok(path) = record_path(benchmarks_root, submission_id) {
                if fs::symlink_metadata(&path).is_err() {
                    let _ = write_record_file(&path, &record);
                }
            }
        }
    }
    let mut archived = legacy.clone();
    archived.set_extension("json.migrated");
    if fs::symlink_metadata(&archived).is_ok() {
        archived.set_extension(format!("json.migrated-{}", now_ms()?));
    }
    std::fs::rename(&legacy, &archived).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    Ok(())
}

use std::fs;

/// Acquire the stable per-submission OS lock. Held across the vault
/// read/generation/set plus the record commit for one submission only, so
/// concurrent processes serialize key creation without ever blocking other
/// submissions, the global registry or measurements.
pub(crate) fn submission_lock(
    benchmarks_root: &Path,
    submission_id: &str,
) -> Result<File, SharingError> {
    ensure_migrated(benchmarks_root)?;
    std::fs::create_dir_all(owners_dir(benchmarks_root)).map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path(benchmarks_root, submission_id)?)
        .map_err(|_| {
            SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
        })?;
    lock.lock().map_err(|_| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    Ok(lock)
}

/// Look up the binding for a submission. Pure read: no directories, locks or
/// writes, so polling and listing never mutate storage.
pub(crate) fn read_binding(
    benchmarks_root: &Path,
    submission_id: &str,
) -> Result<Option<OwnerBinding>, SharingError> {
    ensure_migrated(benchmarks_root)?;
    Ok(read_record_file(&record_path(benchmarks_root, submission_id)?)?.map(OwnerBinding::from))
}

pub(crate) enum InsertOutcome {
    Inserted,
    ExistedSame,
}

/// Insert a binding. Idempotent for the identical binding; refuses to drift
/// an existing binding to a different body, origin or destination. Callers
/// hold the per-submission lock across vault work; this only touches files.
pub(crate) fn insert_binding(
    benchmarks_root: &Path,
    submission_id: &str,
    body_sha256: &str,
    destination: &str,
    origin: &str,
    created_at_ms: u64,
) -> Result<InsertOutcome, SharingError> {
    if !valid_body_hash(body_sha256) {
        return Err(SharingError::binding_conflict_msg(
            "The publication body is invalid.",
        ));
    }
    let path = record_path(benchmarks_root, submission_id)?;
    if let Some(existing) = read_record_file(&path)? {
        if existing.body_sha256 == body_sha256
            && existing.destination == destination
            && existing.origin == origin
            && existing.credential_ref == credential_ref(submission_id)
        {
            return Ok(InsertOutcome::ExistedSame);
        }
        return Err(SharingError::binding_conflict_msg(
            "This submission is already bound to different data.",
        ));
    }
    write_record_file(
        &path,
        &Record {
            version: RECORD_VERSION,
            submission_id: submission_id.into(),
            credential_ref: credential_ref(submission_id),
            body_sha256: body_sha256.into(),
            destination: destination.into(),
            origin: origin.into(),
            created_at_ms,
        },
    )?;
    Ok(InsertOutcome::Inserted)
}

/// Adopt the real body hash for a binding restored from a recovery file.
/// Succeeds only from the `unknown` placeholder (or the identical hash, for
/// retried prepares); a concrete binding never drifts.
pub(crate) fn adopt_body_hash(
    benchmarks_root: &Path,
    submission_id: &str,
    body_sha256: &str,
) -> Result<OwnerBinding, SharingError> {
    if body_sha256 == UNKNOWN_BODY || !valid_body_hash(body_sha256) {
        return Err(SharingError::binding_conflict_msg(
            "The publication body is invalid.",
        ));
    }
    let path = record_path(benchmarks_root, submission_id)?;
    let mut record = read_record_file(&path)?.ok_or_else(|| {
        SharingError::binding_conflict_msg("This submission has no saved ownership.")
    })?;
    if record.body_sha256 != UNKNOWN_BODY && record.body_sha256 != body_sha256 {
        return Err(SharingError::binding_conflict_msg(
            "This submission is already bound to different data.",
        ));
    }
    record.body_sha256 = body_sha256.into();
    write_record_file(&path, &record)?;
    Ok(OwnerBinding::from(record))
}

/// Read a pending crash-recovery intent, if any. Pure read.
pub(crate) fn read_pending(
    benchmarks_root: &Path,
    submission_id: &str,
) -> Result<Option<Record>, SharingError> {
    read_record_file(&pending_path(benchmarks_root, submission_id)?)
}

/// Stage a pending intent before the vault write so a crash can be completed
/// by the next attempt instead of orphaning a key.
pub(crate) fn write_pending(
    benchmarks_root: &Path,
    record: &Record,
    submission_id: &str,
) -> Result<(), SharingError> {
    write_record_file(&pending_path(benchmarks_root, submission_id)?, record)
}

/// Commit a staged intent to the durable record and clear the intent.
pub(crate) fn commit_pending(
    benchmarks_root: &Path,
    submission_id: &str,
) -> Result<OwnerBinding, SharingError> {
    let pending = pending_path(benchmarks_root, submission_id)?;
    let record = read_record_file(&pending)?.ok_or_else(|| {
        SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
    })?;
    write_record_file(&record_path(benchmarks_root, submission_id)?, &record)?;
    let _ = std::fs::remove_file(&pending);
    Ok(OwnerBinding::from(record))
}

/// Discard a staged intent that never minted a key (e.g. superseded by an
/// import carrying its own authority).
pub(crate) fn clear_pending(
    benchmarks_root: &Path,
    submission_id: &str,
) -> Result<(), SharingError> {
    let pending = pending_path(benchmarks_root, submission_id)?;
    match std::fs::remove_file(&pending) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SharingError::vault_unavailable_msg(
            "The ownership registry is unavailable.",
        )),
    }
}

fn valid_cursor(cursor: &str) -> bool {
    cursor.len() == 64 && cursor.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Paginated nonsecret ownership records without opening the OS vault and
/// without mutating storage. Names sort lexicographically; the opaque cursor
/// is the last returned record name. Only the returned page's files are read.
pub(crate) fn list_owned(
    benchmarks_root: &Path,
    after: Option<&str>,
    limit: usize,
) -> Result<(Vec<OwnedItem>, Option<String>), SharingError> {
    ensure_migrated(benchmarks_root)?;
    let limit = limit.clamp(1, MAX_LIST_LIMIT);
    if let Some(cursor) = after {
        if !valid_cursor(cursor) {
            return Err(SharingError::binding_conflict_msg(
                "The ownership cursor is invalid.",
            ));
        }
    }
    let dir = owners_dir(benchmarks_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), None));
        }
        Err(_) => {
            return Err(SharingError::vault_unavailable_msg(
                "The ownership registry is unavailable.",
            ));
        }
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| {
            SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
        })?;
        if !entry
            .file_type()
            .map_err(|_| {
                SharingError::vault_unavailable_msg("The ownership registry is unavailable.")
            })?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.len() == 69 && name.ends_with(".json") && valid_cursor(&name[..64]) {
            names.push(name);
        }
    }
    names.sort();
    // Names are `<64-hex>.json` while the opaque cursor is the bare 64-hex
    // key: compare stems so the cursor record itself is excluded. Comparing
    // full names would re-include it and loop forever at limit 1.
    let start = match after {
        Some(cursor) => names.partition_point(|name| name[..64] <= *cursor),
        None => 0,
    };
    let mut page: Vec<(String, OwnedItem)> = Vec::new();
    let mut skips = 0;
    for name in names.iter().skip(start) {
        if page.len() > limit {
            break;
        }
        if skips > MAX_LIST_SKIPS {
            break;
        }
        match read_record_file(&dir.join(name)) {
            Ok(Some(record)) => {
                // Recovery-restored bindings (UNKNOWN body) are listable for
                // management (copy/export/open) without adopting a body; only
                // upload requires a known hash. Staged intents never match
                // the filename filter above.
                page.push((
                    name[..64].to_owned(),
                    OwnedItem {
                        submission_id: record.submission_id,
                        credential_ref: record.credential_ref,
                        destination: record.destination,
                        created_at_ms: record.created_at_ms,
                    },
                ));
            }
            Ok(None) => continue,
            Err(_) => {
                skips += 1;
                continue;
            }
        }
    }
    let next_cursor = if page.len() > limit {
        page.pop();
        page.last().map(|(cursor, _)| cursor.clone())
    } else {
        None
    };
    Ok((
        page.into_iter().map(|(_, item)| item).collect(),
        next_cursor,
    ))
}

#[cfg(test)]
pub(crate) fn test_root() -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("aiolm-sharing-registry-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[cfg(test)]
// The Windows-only cleanup branch below restores writability on a temp file
// so the temp directory can be removed; unix uses mode bits instead.
#[allow(clippy::permissions_set_readonly_false)]
fn restore_writable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[cfg(not(unix))]
    {
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBMISSION: &str = "123e4567-e89b-42d3-a456-426614174000";
    const ORIGIN: &str = "https://benchmarks.example.test";
    const DESTINATION: &str = "https://benchmarks.example.test/v1/benchmark-runs";

    fn insert(root: &Path, submission: &str, body: &str, created: u64) -> InsertOutcome {
        let _lock = submission_lock(root, submission).unwrap();
        insert_binding(root, submission, body, DESTINATION, ORIGIN, created).unwrap()
    }

    #[test]
    fn insert_is_idempotent_and_rejects_drift() {
        let root = test_root();
        assert!(read_binding(&root, SUBMISSION).unwrap().is_none());
        assert!(matches!(
            insert(&root, SUBMISSION, &"a".repeat(64), 1000),
            InsertOutcome::Inserted
        ));
        assert!(matches!(
            insert(&root, SUBMISSION, &"a".repeat(64), 2000),
            InsertOutcome::ExistedSame
        ));
        let binding = read_binding(&root, SUBMISSION).unwrap().unwrap();
        assert_eq!(binding.credential_ref, credential_ref(SUBMISSION));
        assert_eq!(binding.origin, ORIGIN);
        assert_eq!(binding.created_at_ms, 1000);
        // Same id with a different body or destination must never drift.
        let _lock = submission_lock(&root, SUBMISSION).unwrap();
        assert!(insert_binding(
            &root,
            SUBMISSION,
            &"b".repeat(64),
            DESTINATION,
            ORIGIN,
            3000
        )
        .is_err());
        assert!(insert_binding(
            &root,
            SUBMISSION,
            &"a".repeat(64),
            "https://benchmarks.example.test/v1/other",
            ORIGIN,
            3000,
        )
        .is_err());
        drop(_lock);
        // The original binding survives the refused drifts.
        let binding = read_binding(&root, SUBMISSION).unwrap().unwrap();
        assert_eq!(binding.body_sha256, "a".repeat(64));
        assert_eq!(binding.created_at_ms, 1000);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restored_binding_adopts_its_body_once() {
        let root = test_root();
        insert(&root, SUBMISSION, UNKNOWN_BODY, 1000);
        let _lock = submission_lock(&root, SUBMISSION).unwrap();
        let adopted = adopt_body_hash(&root, SUBMISSION, &"d".repeat(64)).unwrap();
        assert_eq!(adopted.body_sha256, "d".repeat(64));
        // Retried prepares with the same body succeed; others refuse.
        adopt_body_hash(&root, SUBMISSION, &"d".repeat(64)).unwrap();
        assert!(adopt_body_hash(&root, SUBMISSION, &"e".repeat(64)).is_err());
        drop(_lock);
        assert_eq!(
            read_binding(&root, SUBMISSION)
                .unwrap()
                .unwrap()
                .body_sha256,
            "d".repeat(64)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_never_mutate_storage() {
        let root = test_root();
        insert(&root, SUBMISSION, &"c".repeat(64), 1000);
        let path = record_path(&root, SUBMISSION).unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        // Even with the lock file removed and the record read-only, lookups
        // and listing succeed without recreating or rewriting anything.
        std::fs::remove_file(lock_path(&root, SUBMISSION).unwrap()).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(
            read_binding(&root, SUBMISSION)
                .unwrap()
                .unwrap()
                .body_sha256,
            "c".repeat(64)
        );
        let (items, next) = list_owned(&root, None, 25).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(next, None);
        assert!(fs::symlink_metadata(lock_path(&root, SUBMISSION).unwrap()).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
        restore_writable(&path);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_registry_migrates_once_and_is_preserved() {
        let root = test_root();
        std::fs::create_dir_all(sharing_dir(&root)).unwrap();
        let second = "123e4567-e89b-42d3-a456-426614174001";
        let legacy = serde_json::json!({
            "version": 1,
            "bindings": {
                SUBMISSION: {
                    "credential_ref": credential_ref(SUBMISSION),
                    "body_sha256": "a".repeat(64),
                    "destination": DESTINATION,
                    "origin": ORIGIN,
                    "created_at_ms": 111,
                },
                second: {
                    "credential_ref": credential_ref(second),
                    "body_sha256": UNKNOWN_BODY,
                    "destination": DESTINATION,
                    "origin": ORIGIN,
                    "created_at_ms": 222,
                },
                "not-a-uuid": {
                    "credential_ref": "bogus",
                    "body_sha256": "z",
                    "destination": "bogus",
                    "origin": "bogus",
                    "created_at_ms": 0,
                },
            },
        });
        std::fs::write(legacy_path(&root), serde_json::to_vec(&legacy).unwrap()).unwrap();
        // A read triggers the one-time migration of valid records only.
        let binding = read_binding(&root, SUBMISSION).unwrap().unwrap();
        assert_eq!(binding.created_at_ms, 111);
        assert!(fs::symlink_metadata(legacy_path(&root)).is_err());
        let archived = sharing_dir(&root).join("registry.json.migrated");
        assert!(fs::symlink_metadata(&archived).is_ok());
        // Second reads need no migration and see the migrated record.
        let binding = read_binding(&root, SUBMISSION).unwrap().unwrap();
        assert_eq!(binding.body_sha256, "a".repeat(64));
        assert!(read_binding(&root, "not-a-uuid").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_list_paginates_beyond_one_hundred() {
        let root = test_root();
        for index in 0..150u32 {
            let submission = format!("123e4567-e89b-42d3-a456-{:012}", 1000 + index);
            insert(&root, &submission, &"f".repeat(64), 5000 + index as u64);
        }
        let mut seen = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let (items, next) = list_owned(&root, cursor.as_deref(), 25).unwrap();
            assert!(!items.is_empty());
            pages += 1;
            for item in items {
                assert!(seen.insert(item.submission_id.clone()));
                assert_eq!(item.destination, DESTINATION);
                assert!(item.created_at_ms >= 5000);
            }
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 150);
        assert_eq!(pages, 6);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_list_traverses_exactly_once_at_limit_one() {
        let root = test_root();
        for index in 0..7u32 {
            let submission = format!("123e4567-e89b-42d3-a456-{:012}", 3000 + index);
            insert(&root, &submission, &"f".repeat(64), 9000 + index as u64);
        }
        // The cursor record must not repeat: limit 1 walks the whole set and
        // terminates instead of looping on the same record forever.
        let mut seen = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let (items, next) = list_owned(&root, cursor.as_deref(), 1).unwrap();
            assert_eq!(items.len(), 1);
            assert!(seen.insert(items[0].submission_id.clone()));
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 7);
        assert_eq!(cursor, None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_list_scales_beyond_five_hundred() {
        let root = test_root();
        for index in 0..600u32 {
            let submission = format!("123e4567-e89b-42d3-a456-{:012}", 2000 + index);
            insert(&root, &submission, &"e".repeat(64), 7000 + index as u64);
        }
        let mut total = 0;
        let mut cursor: Option<String> = None;
        loop {
            let (items, next) = list_owned(&root, cursor.as_deref(), 100).unwrap();
            total += items.len();
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(total, 600);
        // Oversized limits clamp instead of over-reading.
        let (items, _) = list_owned(&root, None, 10_000).unwrap();
        assert_eq!(items.len(), 100);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_intent_round_trip() {
        let root = test_root();
        let record = Record {
            version: RECORD_VERSION,
            submission_id: SUBMISSION.into(),
            credential_ref: credential_ref(SUBMISSION),
            body_sha256: "a".repeat(64),
            destination: DESTINATION.into(),
            origin: ORIGIN.into(),
            created_at_ms: 999,
        };
        assert!(read_pending(&root, SUBMISSION).unwrap().is_none());
        write_pending(&root, &record, SUBMISSION).unwrap();
        assert_eq!(read_pending(&root, SUBMISSION).unwrap().unwrap(), record);
        // Staged intents are invisible to lookups and listing until committed.
        assert!(read_binding(&root, SUBMISSION).unwrap().is_none());
        let (items, _) = list_owned(&root, None, 25).unwrap();
        assert!(items.is_empty());
        let committed = commit_pending(&root, SUBMISSION).unwrap();
        assert_eq!(committed.created_at_ms, 999);
        assert_eq!(
            read_binding(&root, SUBMISSION)
                .unwrap()
                .unwrap()
                .body_sha256,
            "a".repeat(64)
        );
        assert!(read_pending(&root, SUBMISSION).unwrap().is_none());
        clear_pending(&root, SUBMISSION).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_paths_stay_clear_of_journals_receipts_and_cache() {
        let root = test_root();
        let dir = sharing_dir(&root);
        assert!(!dir.join("owners").starts_with(root.join("runs")));
        assert!(!dir.join("owners").starts_with(root.join("receipts")));
        assert!(!dir.join("owners").starts_with(root.join("recent-cache")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
