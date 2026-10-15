//! Shell-free help discovery IPC.
//!
//! The UI never runs help on render. It reads a cached or persistent snapshot
//! for display and only runs an owned child on an explicit Discover action.
//! Help success never implies protocol readiness; registration still runs a
//! fresh model probe before reporting Ready.
use crate::{
    providers::{
        runtime_help::{HelpCommand, HelpReport, HelpService},
        runtime_help_parse::{AppliedOverlay, SchemaDiff},
        runtime_help_store::{self, HelpSnapshot, RuntimeDescriptor},
        runtime_options::{OptionIssue, OptionSchema, ResolvedOptions},
    },
    state::AppState,
};
use serde_json::{Map, Value};
use std::sync::atomic::Ordering;
use tauri::State;

static HELP_SERVICE: std::sync::OnceLock<HelpService> = std::sync::OnceLock::new();

fn service() -> &'static HelpService {
    HELP_SERVICE.get_or_init(HelpService::default)
}

fn adapters_root() -> std::path::PathBuf {
    crate::providers::registry::root()
}

/// Explicit discovery: runs the owned help child once, parses, persists and
/// describes the result against the previous snapshot. Saved values are never
/// deleted; absent keys are reported as retained.
#[tauri::command]
pub(crate) async fn runtime_help_discover(
    state: State<'_, AppState>,
    owner: String,
    engine: String,
    runtime: String,
    command: HelpCommand,
    saved_keys: Vec<String>,
) -> Result<(HelpReport, RuntimeDescriptor), String> {
    if super::runtimes::runtime_resources_in_use(&state)? {
        // Discovery itself does not start a model server, so live sessions do
        // not block it. Sessions only gate registration, which owns probes.
        let _ = &state;
    }
    let root = adapters_root();
    let owner = owner.clone();
    let engine = engine.clone();
    let runtime = runtime.clone();
    tokio::task::spawn_blocking(move || {
        runtime_help_store::discover_persist_describe(
            service(),
            &root,
            &owner,
            &engine,
            &runtime,
            &command,
            &saved_keys,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cached display path: never spawns a child. Returns the persistent snapshot
/// for an exact fingerprint, or `None` when rediscovery is required.
#[tauri::command]
pub(crate) async fn runtime_help_cached(
    engine: String,
    runtime: String,
    fingerprint: String,
) -> Result<Option<HelpSnapshot>, String> {
    let root = adapters_root();
    tokio::task::spawn_blocking(move || {
        runtime_help_store::load_snapshot(&root, &engine, &runtime, &fingerprint)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cancel one in-flight discovery by ticket. Other owners are unaffected.
#[tauri::command]
pub(crate) async fn runtime_help_cancel(ticket_id: String) -> Result<bool, String> {
    service().cancel(&ticket_id)
}

/// Cancel the in-flight discovery for one settings owner. Other owners keep running.
#[tauri::command]
pub(crate) async fn runtime_help_cancel_owner(owner: String) -> Result<bool, String> {
    service().cancel_owner(&owner)
}

/// Shared stop path for long help runs.
#[tauri::command]
pub(crate) async fn runtime_help_cancel_all(state: State<'_, AppState>) -> Result<(), String> {
    state.runtime_cancel.store(true, Ordering::Release);
    Ok(())
}

/// Authoritative argv/request resolution for a help-derived schema.
/// Managed bindings stay rejected; launch fills them from app-owned controls.
#[tauri::command]
pub(crate) fn runtime_help_resolve(
    schema: OptionSchema,
    scope: Vec<String>,
    stored: Map<String, Value>,
) -> Result<ResolvedOptions, Vec<OptionIssue>> {
    runtime_help_store::resolve_stored(&schema, &scope, &stored)
}

/// Apply explicit adapter metadata over parsed help. Conflicts are reported
/// for review; help observations win rather than being silently overwritten.
#[tauri::command]
pub(crate) fn runtime_help_apply_overlay(
    base: OptionSchema,
    overlay: OptionSchema,
) -> Result<AppliedOverlay, String> {
    crate::providers::runtime_help_parse::apply_overlay(base, overlay)
}

/// Compare two schemas and note retained saved keys.
#[tauri::command]
pub(crate) fn runtime_help_diff(
    old: OptionSchema,
    new: OptionSchema,
    saved_keys: Vec<String>,
) -> Result<SchemaDiff, String> {
    old.validate()?;
    new.validate()?;
    Ok(crate::providers::runtime_help_parse::diff_with_saved(
        &old,
        &new,
        &saved_keys,
    ))
}

/// Parse a complete help report without spawning. Failed or truncated reports
/// never parse; callers must rediscover.
#[tauri::command]
pub(crate) fn runtime_help_parse(
    report: HelpReport,
    engine: String,
    runtime: String,
) -> Result<OptionSchema, String> {
    let binding = crate::providers::runtime_options::SchemaBinding {
        engine,
        runtime,
        fingerprint: report.identity.fingerprint.clone(),
    };
    crate::providers::runtime_help_parse::parse_help_report(&report, binding)
}
