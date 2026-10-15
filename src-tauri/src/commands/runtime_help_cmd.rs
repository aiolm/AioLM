//! Shell-free help discovery IPC.
//!
//! The UI never runs help on render. It reads a cached or persistent snapshot
//! for display and only runs an owned child on an explicit Discover action.
//! Help success never implies protocol readiness; registration still runs a
//! fresh model probe before reporting Ready.
use crate::providers::{
    runtime_help::{HelpCommand, HelpReport, HelpService},
    runtime_help_parse::{AppliedOverlay, SchemaDiff},
    runtime_help_store::{self, HelpSnapshot, RuntimeDescriptor},
    runtime_metadata,
    runtime_options::{OptionIssue, OptionSchema, ResolvedOptions},
    runtime_schema,
};
use serde_json::{Map, Value};

static HELP_SERVICE: std::sync::OnceLock<HelpService> = std::sync::OnceLock::new();

fn service() -> &'static HelpService {
    HELP_SERVICE.get_or_init(HelpService::default)
}

#[tauri::command]
pub(crate) fn adapter_setup_list() -> Result<Vec<crate::providers::adapter_setup::Recipe>, String> {
    crate::providers::adapter_setup::provided()
}

#[tauri::command]
pub(crate) async fn adapter_setup_import(
    path: String,
) -> Result<crate::providers::adapter_setup::Recipe, String> {
    tokio::task::spawn_blocking(move || {
        crate::providers::adapter_setup::import(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn adapter_setup_prepare(
    owner: String,
    recipe: crate::providers::adapter_setup::Recipe,
    inputs: std::collections::BTreeMap<String, String>,
) -> Result<crate::providers::registry::EntrypointDraft, String> {
    tokio::task::spawn_blocking(move || {
        crate::providers::adapter_setup::prepare(service(), &owner, &recipe, &inputs)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn adapter_setup_cancel(owner: String) -> Result<bool, String> {
    service().cancel_owner(&format!("setup:{owner}"))
}

fn adapters_root() -> std::path::PathBuf {
    crate::providers::registry::root()
}

/// Explicit discovery: runs the owned help child once, parses, persists and
/// describes the result against the previous snapshot. Saved values are never
/// deleted; absent keys are reported as retained.
#[tauri::command]
pub(crate) async fn runtime_help_discover(
    owner: String,
    engine: String,
    runtime: String,
    command: HelpCommand,
    saved_keys: Vec<String>,
) -> Result<(HelpReport, RuntimeDescriptor), String> {
    // Discovery never starts a model server, so live sessions do not block it;
    // sessions only gate registration, which owns probes.
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

/// The adapter-owned help command for the selected runtime: program, entry
/// prefix and the request that was accepted (or the adapter default).
#[tauri::command]
pub(crate) async fn runtime_help_target(
    cfg: crate::config::AppConfig,
) -> Result<runtime_schema::HelpTarget, String> {
    tokio::task::spawn_blocking(move || runtime_schema::help_target(&adapters_root(), &cfg))
        .await
        .map_err(|e| e.to_string())?
}

/// Discover the selected runtime's help through its adapter-derived command.
/// One discovery per runtime runs at a time; a newer one supersedes it. The
/// result is compared with the accepted help, never applied until accepted.
#[tauri::command]
pub(crate) async fn runtime_help_discover_selected(
    cfg: crate::config::AppConfig,
    request: runtime_schema::HelpRequest,
) -> Result<(HelpReport, RuntimeDescriptor), String> {
    tokio::task::spawn_blocking(move || {
        let root = adapters_root();
        let key = runtime_schema::runtime_key(&cfg)?;
        let command = runtime_schema::help_command(&cfg, &request)?;
        let accepted = runtime_schema::load_accepted(&root, &key.engine, &key.runtime)?;
        let baseline = match accepted {
            Some(accepted) => runtime_help_store::load_snapshot(
                &root,
                &key.engine,
                &key.runtime,
                &accepted.fingerprint,
            )?,
            None => None,
        };
        let saved_keys = runtime_schema::discovery_saved_keys(
            &cfg,
            &runtime_schema::Selected::from_config(&cfg)?,
        )?;
        let (report, mut descriptor) = runtime_help_store::discover_against(
            service(),
            &root,
            &format!("runtime:{}/{}", key.engine, key.runtime),
            &key.engine,
            &key.runtime,
            &command,
            &saved_keys,
            runtime_help_store::Baseline::Accepted(baseline.map(Box::new)),
        )?;
        // Reviewed together with the help it will be applied to.
        if let Some((metadata, builtin)) = runtime_schema::selected_metadata(&cfg)? {
            descriptor.metadata = Some(runtime_metadata::review(
                &descriptor.schema,
                &metadata,
                builtin,
            ));
        }
        Ok((report, descriptor))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cancel the selected runtime's in-flight discovery.
#[tauri::command]
pub(crate) async fn runtime_help_cancel_selected(
    cfg: crate::config::AppConfig,
) -> Result<bool, String> {
    let key = runtime_schema::runtime_key(&cfg)?;
    service().cancel_owner(&format!("runtime:{}/{}", key.engine, key.runtime))
}

/// Accept a reviewed discovery for launch. The current command must still
/// produce the same fingerprint.
#[tauri::command]
pub(crate) async fn runtime_help_accept(
    cfg: crate::config::AppConfig,
    fingerprint: String,
    request: runtime_schema::HelpRequest,
) -> Result<runtime_schema::AcceptedHelp, String> {
    tokio::task::spawn_blocking(move || {
        runtime_schema::accept(&adapters_root(), &cfg, &fingerprint, &request)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save the value counts and repetition the user confirmed for options the
/// selected runtime's accepted help leaves unknown, pinned to that help.
#[tauri::command]
pub(crate) async fn runtime_help_confirm_syntax(
    cfg: crate::config::AppConfig,
    fingerprint: String,
    options: std::collections::BTreeMap<String, runtime_schema::ConfirmedSyntax>,
) -> Result<runtime_schema::EffectiveSchema, String> {
    tokio::task::spawn_blocking(move || {
        runtime_schema::save_supplement(&adapters_root(), &cfg, &fingerprint, options)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Discard every confirmation for the selected runtime, including a file
/// this app refuses to read. Saved option values are untouched.
#[tauri::command]
pub(crate) async fn runtime_help_clear_confirmed_syntax(
    cfg: crate::config::AppConfig,
) -> Result<runtime_schema::EffectiveSchema, String> {
    tokio::task::spawn_blocking(move || runtime_schema::clear_supplement(&adapters_root(), &cfg))
        .await
        .map_err(|e| e.to_string())?
}

/// The one option schema the settings UI renders for the selected runtime:
/// catalog/manifest options plus accepted help, with app-owned bindings.
#[tauri::command]
pub(crate) async fn provider_option_schema(
    cfg: crate::config::AppConfig,
) -> Result<runtime_schema::EffectiveSchema, String> {
    tokio::task::spawn_blocking(move || runtime_schema::effective(&adapters_root(), &cfg, true))
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

/// Shared stop path for long help runs. Only help discoveries are cancelled;
/// runtime installs, builds and probes keep their own cancellation flag.
#[tauri::command]
pub(crate) async fn runtime_help_cancel_all() -> Result<usize, String> {
    cancel_all_discoveries()
}

/// Cancels every in-flight help discovery. Their owned children are reaped by
/// the capture loop; app shutdown additionally terminates transient trees.
pub(crate) fn cancel_all_discoveries() -> Result<usize, String> {
    service().cancel_all()
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

/// Order-preserving resolution: flags follow plan order within each scope
/// depth instead of schema order. Same validation as grouped profiles.
#[tauri::command]
pub(crate) fn runtime_help_resolve_plan(
    schema: OptionSchema,
    scope: Vec<String>,
    plan: crate::providers::runtime_ordered::OrderedPlan,
) -> Result<ResolvedOptions, Vec<OptionIssue>> {
    crate::providers::runtime_ordered::resolve_plan(&schema, &scope, &plan)
}

/// Split a pasted command into an ordered plan preserving input order.
/// Managed and unknown words land in review buckets, never silently emitted.
#[tauri::command]
pub(crate) fn runtime_help_import(
    schema: OptionSchema,
    scope: Vec<String>,
    text: String,
    syntax: Option<crate::providers::options::CommandSyntax>,
    entry: Option<crate::providers::runtime_positional::CommandEntry>,
) -> Result<crate::providers::runtime_ordered::ImportedPlan, String> {
    // The selected runtime's registered entry, when the caller has one,
    // lets a pasted full command skip exactly that program and prefix.
    crate::providers::runtime_ordered::import_plan_for_entry(
        &schema,
        &scope,
        entry.as_ref(),
        &text,
        syntax.unwrap_or_default(),
    )
}

/// Discover an entry point's help before registration, through the same
/// command derivation the registered engine will use, so the reviewed help
/// can be pinned at registration without running help twice.
#[tauri::command]
pub(crate) async fn entrypoint_help_discover(
    entry: crate::providers::registry::EntrypointHelp,
    request: runtime_schema::HelpRequest,
    cfg: Option<crate::config::AppConfig>,
) -> Result<(HelpReport, RuntimeDescriptor), String> {
    tokio::task::spawn_blocking(move || {
        let manifest = crate::providers::registry::provisional_manifest(&entry)?;
        let command = runtime_schema::manifest_help_command(&manifest, &request)?;
        let cfg = match cfg {
            Some(cfg) => cfg,
            None => crate::config::load_result()?,
        };
        let saved_keys = runtime_schema::entrypoint_saved_keys(&cfg, entry.engine_id);
        let baseline = runtime_schema::entrypoint_baseline(
            &adapters_root(),
            entry.engine_id.as_str(),
            &entry.runtime_id,
        )?;
        let (report, mut descriptor) = runtime_help_store::discover_against(
            service(),
            &adapters_root(),
            &entrypoint_owner(&entry),
            entry.engine_id.as_str(),
            &entry.runtime_id,
            &command,
            &saved_keys,
            baseline,
        )?;
        // The entry's explicit metadata is part of the help identity and is
        // reviewed against this help before any binding is chosen.
        if let Some(metadata) = &entry.option_metadata {
            descriptor.metadata = Some(runtime_metadata::review(
                &descriptor.schema,
                metadata,
                false,
            ));
        }
        Ok((report, descriptor))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cancel an entry point's in-flight help discovery.
#[tauri::command]
pub(crate) async fn entrypoint_help_cancel(
    entry: crate::providers::registry::EntrypointHelp,
) -> Result<bool, String> {
    service().cancel_owner(&entrypoint_owner(&entry))
}

fn entrypoint_owner(entry: &crate::providers::registry::EntrypointHelp) -> String {
    format!(
        "entrypoint:{}/{}",
        entry.engine_id.as_str(),
        entry.runtime_id
    )
}

/// The manifest an entry-point draft would register, for review before the
/// register action. Adds nothing the user did not choose.
#[tauri::command]
pub(crate) fn entrypoint_manifest_preview(
    draft: crate::providers::registry::EntrypointDraft,
) -> Result<crate::providers::registry::RuntimeManifest, String> {
    crate::providers::registry::manifest_from_draft(&draft)
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
