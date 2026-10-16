import { invoke } from './transport.ts';
import type { AppConfig } from './types.ts';

export type HelpEncoding = 'auto' | 'utf8' | 'utf16_le' | 'utf16_be' | 'utf16le' | 'utf16be' | 'cp949' | 'cp932' | 'windows-1252';

export interface HelpCommand {
  program: string;
  args: string[];
  environment: Record<string, string>;
  working_directory?: string | null;
  artifacts: string[];
  runtime_version: string;
  scope: string[];
  encoding: HelpEncoding;
  timeout_ms: number;
  output_limit: number;
}

export interface HelpTextOutput {
  raw_bytes_base64?: string | null;
  text: string;
  clean_text: string;
  encoding: string;
  decoding_loss: boolean;
  truncated: boolean;
  read_error?: string | null;
}

export interface HelpIdentity {
  fingerprint: string;
  executable_sha256: string;
  artifacts_sha256: Record<string, string>;
  parser_version: number;
}

export interface HelpReport {
  identity: HelpIdentity;
  scope: string[];
  stdout: HelpTextOutput;
  stderr: HelpTextOutput;
  exit_code?: number | null;
  success: boolean;
  cancelled: boolean;
  timed_out: boolean;
  error?: string | null;
  elapsed_ms: number;
}

export interface OptionSchemaFact<T> {
  value?: T | null;
  certainty: 'unknown' | 'documented' | 'verified' | 'user_confirmed';
  source?: unknown;
}

export interface OptionSchemaSpelling {
  flag: string;
  style?: 'separate' | 'equals';
  polarity?: boolean | null;
}

export interface OptionSchemaDefinition {
  key: string;
  scope: string[];
  spellings: OptionSchemaSpelling[];
  position?: number | null;
  kind: OptionSchemaFact<string>;
  arity: OptionSchemaFact<{ min: number; max?: number | null }>;
  repeatable: OptionSchemaFact<boolean>;
  choices: OptionSchemaFact<unknown[]>;
  range: OptionSchemaFact<{ min?: number | null; max?: number | null }>;
  unit: OptionSchemaFact<string>;
  runtime_default: OptionSchemaFact<{ literal: unknown }>;
  group: string;
  help: string;
  target: 'launch' | 'request';
  request_field: OptionSchemaFact<string>;
  restart_required: OptionSchemaFact<boolean>;
  sensitive: OptionSchemaFact<boolean>;
  local_path: OptionSchemaFact<boolean>;
  managed?: 'model' | 'host' | 'port' | 'authentication' | 'discovery' | 'entry_point' | 'reserved' | null;
  raw_spans: unknown[];
}

export interface OptionSchema {
  schema_version: number;
  binding: { engine: string; runtime: string; fingerprint: string };
  options: OptionSchemaDefinition[];
  constraints: unknown[];
  raw_help: Array<{ id: string; scope: string[]; stream: string; text: string; truncated: boolean }>;
  end_of_options: OptionSchemaFact<boolean>;
}

export interface SchemaDiff {
  added: string[];
  removed: string[];
  changed: string[];
  retained_unknown: string[];
}

/** A declared fact that differs from what the reviewed help shows. */
export interface FactConflict {
  /** Effective option key; empty when no option has the flag. */
  key: string;
  /** Empty when the declaration names a positional. */
  flag: string;
  /** The positional key a declaration names; omitted for flags and constraints. */
  positional?: string;
  field: string;
  /** What reviewed help shows; null when it shows nothing. */
  observed: unknown;
  declared: unknown;
  /** Adapter id and revision of the declaration. */
  declared_by: string;
  applies: 'observed' | 'declared';
  /** A saved value is refused (and retained) instead of misplaced. */
  blocking: boolean;
}

/** An engine's explicit option metadata and what it established. */
export interface MetadataView {
  adapter: string;
  revision: string;
  builtin: boolean;
  applied: string[];
  conflicts: FactConflict[];
  error?: string | null;
}

/** Versioned adapter option metadata embedded in a manifest or entry. */
export interface OptionMetadata {
  version: number;
  engine_id: string;
  adapter: { id: string; revision: string };
  /** Each entry names exactly one observed flag spelling or help positional key. */
  options?: Array<({ flag: string } | { positional: string }) & Record<string, unknown>>;
  constraints?: unknown[];
}

export interface RuntimeDescriptor {
  engine: string;
  runtime: string;
  fingerprint: string;
  help_complete: boolean;
  schema: OptionSchema;
  diff?: SchemaDiff | null;
  retained: string[];
  /** Review of the engine's option metadata against this discovery. */
  metadata?: MetadataView | null;
}

export interface HelpSnapshot {
  report: HelpReport;
  schema: OptionSchema;
}

export interface ResolvedOptions {
  argv: string[];
  request: Record<string, unknown>;
}

export interface OptionIssue {
  key: string;
  message: string;
}

/** Explicit discovery: runs the owned help child once. Never call on render. */
export const runtimeHelpDiscover = (
  owner: string,
  engine: string,
  runtime: string,
  command: HelpCommand,
  savedKeys: string[] = [],
): Promise<[HelpReport, RuntimeDescriptor]> =>
  invoke<[HelpReport, RuntimeDescriptor]>('runtime_help_discover', {
    owner, engine, runtime, command, savedKeys,
  });

/** Cached display path: never spawns a child. */
export const runtimeHelpCached = (
  engine: string,
  runtime: string,
  fingerprint: string,
): Promise<HelpSnapshot | null> =>
  invoke<HelpSnapshot | null>('runtime_help_cached', { engine, runtime, fingerprint });

export const runtimeHelpCancelOwner = (owner: string): Promise<boolean> =>
  invoke<boolean>('runtime_help_cancel_owner', { owner });

export const runtimeHelpResolve = (
  schema: OptionSchema,
  scope: string[],
  stored: Record<string, unknown>,
): Promise<ResolvedOptions> =>
  invoke<ResolvedOptions>('runtime_help_resolve', { schema, scope, stored });

export const runtimeHelpDiff = (
  old: OptionSchema,
  next: OptionSchema,
  savedKeys: string[] = [],
): Promise<SchemaDiff> =>
  invoke<SchemaDiff>('runtime_help_diff', { old, new: next, savedKeys });

export const runtimeHelpParse = (
  report: HelpReport,
  engine: string,
  runtime: string,
): Promise<OptionSchema> =>
  invoke<OptionSchema>('runtime_help_parse', { report, engine, runtime });

export interface PlannedOccurrence {
  key: string;
  spelling?: string | null;
  values: unknown[];
}

export interface ImportedPlan {
  plan: PlannedOccurrence[];
  managed: string[];
  unrecognized: string[];
}

/** Order-preserving resolution: flags follow plan order within each scope depth. */
export const runtimeHelpResolvePlan = (
  schema: OptionSchema,
  scope: string[],
  plan: PlannedOccurrence[],
): Promise<ResolvedOptions> =>
  invoke<ResolvedOptions>('runtime_help_resolve_plan', { schema, scope, plan });

/** Split a pasted command into an ordered plan preserving input order. */
export type CommandSyntax = 'posix' | 'windows';

export const runtimeHelpImport = (
  schema: OptionSchema,
  scope: string[],
  text: string,
  syntax?: CommandSyntax,
  entry?: CommandEntry | null,
): Promise<ImportedPlan> =>
  invoke<ImportedPlan>('runtime_help_import', { schema, scope, text, ...(syntax ? { syntax } : {}), ...(entry ? { entry } : {}) });

/** The help command a user chose; the adapter decides environment and artifacts. */
export interface HelpRequest {
  encoding?: HelpEncoding | null;
  locale?: string | null;
  working_directory?: string | null;
  program?: string | null;
  args: string[];
  scope: string[];
}

export interface AcceptedHelp {
  working_directory?: string | null;
  version: number;
  fingerprint: string;
  request: HelpRequest;
}

/** The selected runtime's adapter-owned help command. */
export interface HelpTarget {
  engine: string;
  runtime: string;
  program: string;
  fixed: boolean;
  prefix: string[];
  request: HelpRequest;
  accepted?: AcceptedHelp | null;
}

export type HelpState = 'none' | 'current' | 'stale' | 'unchecked';

/** The one schema the settings UI renders and launch resolves. */
export interface EffectiveSchema {
  schema: OptionSchema;
  scope: string[];
  help_state: HelpState;
  help_detail: string;
  accepted_fingerprint?: string | null;
  compat_keys: string[];
  help_keys: string[];
  shadowed: string[];
  /** Catalog/manifest facts that differ from the accepted help they shadow. */
  conflicts?: FactConflict[];
  /** The engine's explicit option metadata, when it has any. */
  metadata?: MetadataView | null;
  /** Value counts and repetition the user confirmed for help options. */
  supplement?: SupplementView | null;
  /** A confirmation file this app refuses to read; nothing from it applies. */
  supplement_error?: string | null;
  /** The registered command head a pasted command and positional roles are
   * judged against; absent for built-in runtimes. */
  entry?: CommandEntry | null;
}

/** Who fills one help positional slot. */
export type PositionalRole =
  | { role: 'user' }
  | { role: 'binding'; name: string }
  | { role: 'static'; index: number };

/** A registered runtime's command head, from its adapter/entry data. */
export interface CommandEntry {
  version: 1;
  program: string;
  prefix: string[];
  layout?: CommandLayout | null;
  separator?: string | null;
  /** Positional bindings the launch template fills, in order; absent when
   * the manifest does not declare its bindings. */
  positional_bindings?: string[] | null;
  /** Positional roles in effect for the reviewed help. */
  positional_roles?: Record<string, PositionalRole>;
}

/** Literal prefix tokens that are positional to the help scope: with a
 * declared layout, those after the last subcommand that are not fixed
 * options or their values. Without a layout no token's role is known. */
export function staticCandidates(entry: CommandEntry): number[] {
  const layout = entry.layout;
  if (!layout) return [];
  const owned = new Set(layout.options.flatMap(option => Array.from({ length: option.values + 1 }, (_, i) => option.index + i)));
  const start = layout.subcommands.length ? layout.subcommands[layout.subcommands.length - 1] + 1 : 0;
  return entry.prefix.map((_, index) => index).filter(index => index >= start && !owned.has(index));
}

/** Syntax a user confirmed where the reviewed help left it unknown. */
export interface ConfirmedSyntax {
  arity?: { min: number; max: number | null };
  repeatable?: boolean;
  /** Who fills this help positional slot. */
  positional?: PositionalRole;
}

export interface SupplementConflict {
  key: string;
  field: 'option' | 'arity' | 'repeatable' | 'positional';
  confirmed: unknown;
  help: unknown;
}

export interface SupplementView {
  fingerprint: string;
  options: Record<string, ConfirmedSyntax>;
  /** The confirmations describe the accepted help and are in effect. */
  current: boolean;
  applied: string[];
  conflicts: SupplementConflict[];
}

/** Replace the selected runtime's confirmations for its accepted help. */
export const runtimeHelpConfirmSyntax = (cfg: AppConfig, fingerprint: string, options: Record<string, ConfirmedSyntax>): Promise<EffectiveSchema> =>
  invoke<EffectiveSchema>('runtime_help_confirm_syntax', { cfg, fingerprint, options });

/** Discard every confirmation, including a file this app refuses to read. */
export const runtimeHelpClearConfirmedSyntax = (cfg: AppConfig): Promise<EffectiveSchema> =>
  invoke<EffectiveSchema>('runtime_help_clear_confirmed_syntax', { cfg });

export const providerOptionSchema = (cfg: AppConfig): Promise<EffectiveSchema> =>
  invoke<EffectiveSchema>('provider_option_schema', { cfg });

export const runtimeHelpTarget = (cfg: AppConfig): Promise<HelpTarget> =>
  invoke<HelpTarget>('runtime_help_target', { cfg });

/** Explicit discovery for the selected runtime. Never call on render. */
export const runtimeHelpDiscoverSelected = (cfg: AppConfig, request: HelpRequest): Promise<[HelpReport, RuntimeDescriptor]> =>
  invoke<[HelpReport, RuntimeDescriptor]>('runtime_help_discover_selected', { cfg, request });

export const runtimeHelpCancelSelected = (cfg: AppConfig): Promise<boolean> =>
  invoke<boolean>('runtime_help_cancel_selected', { cfg });

export const runtimeHelpAccept = (cfg: AppConfig, fingerprint: string, request: HelpRequest): Promise<AcceptedHelp> =>
  invoke<AcceptedHelp>('runtime_help_accept', { cfg, fingerprint, request });

export type ArgBinding = { kind: 'flag'; flag: string; equals?: boolean } | { kind: 'positional' };
export interface LaunchBindings {
  version: 1;
  options_separator?: '--' | null;
  prefix_len: number;
  bindings: Array<{ name: 'model' | 'host' | 'port' | 'model_alias'; argument: ArgBinding }>;
}
export type AuthBinding = { kind: 'none' } | { kind: 'env'; name: string };
export type ServingProtocol = { kind: 'openai_http' } | { kind: 'bridge'; program: string; prefix: string[]; engine_argv_env?: string | null };

export interface BridgeCommand {
  version: 1;
  environment_variable: string;
  argv: string[];
}

export interface ProcessSpec {
  program: string;
  args: string[];
  env: Record<string, string>;
  working_directory?: string | null;
}

/** Explicit roles in the serving entry prefix, indexed by argv position. */
export interface CommandLayout {
  version: 1;
  subcommands: number[];
  options: Array<{ index: number; values: number }>;
}

/** An entry point before any binding is chosen; enough to derive its help. */
export interface EntrypointHelp {
  command_layout?: CommandLayout | null;
  engine_id: string;
  runtime_id: string;
  program: string;
  prefix: string[];
  working_directory?: string | null;
  artifacts: string[];
  environment: Record<string, string>;
  protocol: ServingProtocol;
  /** Omitted unless the user supplies the adapter's option metadata. */
  option_metadata?: OptionMetadata;
}

export interface EntrypointDraft extends EntrypointHelp {
  options_separator?: '--' | null;
  launch_resources?: { version: 1; directory_env: string } | null;
  models?: Array<{ path: string; name: string }>;
  display_name: string;
  model: ArgBinding;
  port: ArgBinding;
  host?: ArgBinding | null;
  served_model?: ArgBinding | null;
  auth: AuthBinding;
  probe: ProcessSpec;
  health_path: string;
  health_authenticated: boolean;
  model_formats: string[];
  help?: { fingerprint: string; request: HelpRequest } | null;
}

export interface RegisteredManifest {
  command_layout?: CommandLayout | null;
  engine_id: string;
  runtime_id: string;
  display_name: string;
  launch: ProcessSpec;
  probe: ProcessSpec;
  launch_bindings?: LaunchBindings | null;
  bridge_command?: BridgeCommand | null;
  [field: string]: unknown;
}

export const entrypointHelpDiscover = (entry: EntrypointHelp, request: HelpRequest, cfg?: AppConfig): Promise<[HelpReport, RuntimeDescriptor]> =>
  invoke<[HelpReport, RuntimeDescriptor]>('entrypoint_help_discover', { entry, request, ...(cfg ? { cfg } : {}) });

export const entrypointHelpCancel = (entry: EntrypointHelp): Promise<boolean> =>
  invoke<boolean>('entrypoint_help_cancel', { entry });

export const entrypointManifestPreview = (draft: EntrypointDraft): Promise<RegisteredManifest> =>
  invoke<RegisteredManifest>('entrypoint_manifest_preview', { draft });

export const runtimeEntrypointRegister = (draft: EntrypointDraft): Promise<RegisteredManifest> =>
  invoke<RegisteredManifest>('runtime_entrypoint_register', { draft });

export const pickRuntimePath = (kind: 'file' | 'folder'): Promise<string | null> =>
  invoke<string | null>('pick_runtime_path', { kind });

export interface AdapterSetupRecipe {
  version: 1; id: string; title: string; description: string;
  fields: Array<{ key: string; label: string; kind: 'file' | 'folder' | 'text'; required: boolean; default?: string }>;
  prepare: ProcessSpec;
  artifacts?: string[];
}
export const adapterSetupList = (): Promise<AdapterSetupRecipe[]> => invoke<AdapterSetupRecipe[]>('adapter_setup_list');
export const adapterSetupImport = (path: string): Promise<AdapterSetupRecipe> => invoke<AdapterSetupRecipe>('adapter_setup_import', { path });
export const adapterSetupPrepare = (owner: string, recipe: AdapterSetupRecipe, inputs: Record<string, string>): Promise<EntrypointDraft> =>
  invoke<EntrypointDraft>('adapter_setup_prepare', { owner, recipe, inputs });
export const adapterSetupCancel = (owner: string): Promise<boolean> => invoke<boolean>('adapter_setup_cancel', { owner });
