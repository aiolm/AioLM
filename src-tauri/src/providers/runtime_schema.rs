//! One effective option schema per selected runtime.
//!
//! Built-in option catalogs and manifest options are adapter-sourced facts.
//! Help that a user discovered and accepted for the exact runtime adds the
//! options those catalogs do not describe. The settings UI renders this one
//! schema, saved values are validated against it and launch arguments come
//! from the same resolver, for built-in and registered engines alike.
//!
//! Which help applies is pinned: acceptance records the fingerprint of the
//! exact help command (executable and declared artifact hashes, argv, full
//! environment, runtime version, scope and parser). Launch recomputes that
//! identity and refuses saved help options when anything changed, keeping the
//! values for review instead of reusing another script's or build's options.
//!
//! App-owned bindings come from the adapter, not from option names: built-in
//! managed flags, and for registered engines every flag or positional slot its
//! launch template fills from `{model}`, `{port}`, `{host}` and friends.
use super::{
    options::{self, OptionKind, OptionSpec, OptionTarget},
    registry::{self, ExternalOption},
    runtime_help::{Encoding, HelpCommand, MAX_STREAM_BYTES},
    runtime_help_store::{self, HelpSnapshot},
    runtime_metadata::{self, Applies, FactConflict, MetadataView, OptionMetadata},
    runtime_options::{
        Arity, Certainty, Fact, ManagedBinding, NumericRange, OptionDefinition, OptionIssue,
        OptionSchema, ResolvedOptions, RuntimeDefault, Source, Spelling, Target, ValueKind,
        ValueStyle, SCHEMA_VERSION,
    },
    runtime_ordered::{self, ORDER_KEY},
    runtime_positional::{self, CommandEntry, PositionalRole},
    ProviderId,
};
use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub const ACCEPTED_VERSION: u32 = 1;
use super::adapter::help::{Compat, HELP_TIMEOUT_MS};
pub use super::adapter::help::{RuntimeKey, Selected};

/// Saved provider values with dedicated controls; never generic options.
const RESERVED_KEYS: &[&str] = &[
    options::EXTRA_ARGS_KEY,
    options::TRUST_REMOTE_CODE_KEY,
    super::launch::LORA_ADAPTERS_KEY,
    super::launch::REQUEST_LORA_KEY,
    super::launch::DRAFT_MODEL_KEY,
    ORDER_KEY,
];

/// The help command a user chose, minus everything the adapter decides
/// (environment, working directory, artifacts, limits).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HelpRequest {
    /// Explicit decoding for help bytes only; omitted requests keep Auto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<Encoding>,
    /// Child-local locale, never an operating system setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Explicit execution context. Declared adapter directories stay fixed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    /// Registered engines default to their launch program; a bridge's engine
    /// executable may be asked when it is a declared, hash-checked artifact.
    #[serde(default)]
    pub program: Option<String>,
    pub args: Vec<String>,
    #[serde(default)]
    pub scope: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcceptedHelp {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<PathBuf>,
    pub fingerprint: String,
    pub request: HelpRequest,
}

/// What the settings UI may ask: the program and prefix are adapter-owned.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HelpTarget {
    pub engine: String,
    pub runtime: String,
    pub program: String,
    /// Built-in engines always ask their own entry point.
    pub fixed: bool,
    /// Arguments every help request for the launch program starts with.
    pub prefix: Vec<String>,
    pub request: HelpRequest,
    pub accepted: Option<AcceptedHelp>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HelpState {
    /// No help was accepted; only catalog/manifest options apply.
    None,
    /// The accepted help still describes the runtime exactly.
    Current,
    /// The runtime, its artifacts or its help command changed since review.
    Stale,
    /// Accepted, but the identity was not recomputed for this view.
    Unchecked,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EffectiveSchema {
    pub schema: OptionSchema,
    /// Validation-only spellings, including accepted rows shadowed by the
    /// declaration. They do not widen the structured resolver's syntax.
    #[serde(skip)]
    pub(crate) additional_arg_flags: BTreeMap<String, Option<ManagedBinding>>,
    /// Attached services cannot accept process launch controls.
    pub supports_launch_args: bool,
    /// Canonical public names, excluding every member of an identity collision.
    pub benchmark_names: BTreeMap<String, String>,
    /// Subcommand scope the accepted help describes.
    pub scope: Vec<String>,
    pub help_state: HelpState,
    pub help_detail: String,
    pub accepted_fingerprint: Option<String>,
    /// Keys from the built-in catalog or manifest (compatibility mapping).
    pub compat_keys: Vec<String>,
    /// Keys only accepted help describes.
    pub help_keys: Vec<String>,
    /// Help options hidden because a catalog option already covers them.
    pub shadowed: Vec<String>,
    /// Catalog/manifest facts that differ from the accepted help rows they
    /// shadow, with provenance. The declaration keeps its legacy mapping;
    /// a blocking difference refuses a saved value instead of misplacing it.
    pub conflicts: Vec<FactConflict>,
    /// The engine's explicit option metadata: provenance, the options it
    /// described and the declarations observed help or bindings overrode.
    pub metadata: Option<MetadataView>,
    /// Value counts and repetition the user confirmed for help options whose
    /// help left them unknown, shown apart from help and adapter facts.
    pub supplement: Option<SupplementView>,
    /// A saved confirmation file this app refuses to read (malformed, newer,
    /// oversized); nothing from it applies and help options needing it block.
    pub supplement_error: Option<String>,
    /// The registered command head (program, prefix, layout, bindings) a
    /// pasted command and positional roles are judged against. Absent for
    /// built-in runtimes, whose commands the app builds itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<CommandEntry>,
}

pub const SUPPLEMENT_VERSION: u32 = 1;
/// Written only when a positional role is confirmed, so files without one
/// stay readable by earlier versions and newer roles are refused by them.
pub const SUPPLEMENT_POSITIONAL_VERSION: u32 = 2;

/// Syntax a user confirmed for one help option. Only facts the help left
/// unknown can be confirmed; this never describes protocol abilities, types,
/// ranges, defaults, constraints or app-owned bindings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConfirmedSyntax {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arity: Option<Arity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeatable: Option<bool>,
    /// Who fills a help positional slot; only with supplement version 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positional: Option<PositionalRole>,
}

/// Confirmations pinned to the accepted help they were made for. Another
/// help fingerprint (a rebuilt runtime or a newer review) never inherits them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Supplement {
    pub version: u32,
    pub fingerprint: String,
    pub options: BTreeMap<String, ConfirmedSyntax>,
}

/// A confirmation the current help contradicts or no longer covers.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SupplementConflict {
    pub key: String,
    /// `option` (absent or app-owned now), `arity` or `repeatable`.
    pub field: String,
    pub confirmed: Value,
    /// What the current help documents; null when it has no such option.
    pub help: Value,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SupplementView {
    pub fingerprint: String,
    pub options: BTreeMap<String, ConfirmedSyntax>,
    /// The confirmations describe the accepted help and are in effect.
    pub current: bool,
    /// Keys whose unknown facts the confirmations established.
    pub applied: Vec<String>,
    pub conflicts: Vec<SupplementConflict>,
}

pub fn runtime_key(cfg: &AppConfig) -> Result<RuntimeKey, crate::error::AppError> {
    super::adapter::help::runtime_key(cfg)
}

// Responsibilities stay separate; this facade is also consumed by integration tests.
mod benchmark;
mod catalog;
mod effective;
mod help;
mod launch;
mod persistence;
mod redaction;

pub use benchmark::benchmark_names;
pub(crate) use benchmark::capture_benchmark_settings;
use benchmark::lock_private_benchmark_options;
pub(crate) use catalog::{adapter_source, blank, documented};
use catalog::{
    argv_text, blocking_issue, compat, compat_fingerprint, declared_differences,
    protect_binding_aliases,
};
pub use catalog::{
    discovery_saved_keys, entrypoint_saved_keys, from_external, from_spec, selected_metadata,
    spec_arguments,
};
use effective::{build_effective, help_slots};
pub use effective::{effective, effective_for};
use help::{current_identity, option_help_command_for};
pub use help::{
    draft_acceptance, help_command, help_target, manifest_help_command, register_entrypoint,
};
pub(crate) use help::{
    ensure_automatic_help, reconfirm_stale_help_for_start, register_entrypoint_outcome,
    resume_entrypoint_help, unicode_environment, EntrypointRegistration,
};
use launch::generic_entries;
pub(crate) use launch::{additional_launch_args, binding_for};
pub use launch::{
    assemble_registered_arguments, help_launch_args, launch_arguments, launch_identity,
    registered_arguments, saved_issues, saved_issues_for,
};
use persistence::write_accepted;
pub use persistence::{
    accept, clear_supplement, entrypoint_baseline, load_accepted, load_supplement, save_supplement,
};
pub use redaction::{mask_argv, mask_config, sensitive_keys, stored_sensitive_keys, REDACTED};

#[cfg(test)]
#[path = "runtime_schema_tests.rs"]
mod tests;
