import { invoke } from './transport.ts';
import type { AppConfig } from './types.ts';

export interface HelpCommand {
  program: string;
  args: string[];
  environment: Record<string, string>;
  working_directory?: string | null;
  artifacts: string[];
  runtime_version: string;
  scope: string[];
  encoding: 'auto' | 'utf8' | 'utf16le' | 'utf16be';
  timeout_ms: number;
  output_limit: number;
}

export interface HelpTextOutput {
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
  managed?: 'model' | 'host' | 'port' | 'authentication' | 'discovery' | null;
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

export interface RuntimeDescriptor {
  engine: string;
  runtime: string;
  fingerprint: string;
  help_complete: boolean;
  schema: OptionSchema;
  diff?: SchemaDiff | null;
  retained: string[];
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
export const runtimeHelpImport = (
  schema: OptionSchema,
  scope: string[],
  text: string,
): Promise<ImportedPlan> =>
  invoke<ImportedPlan>('runtime_help_import', { schema, scope, text });

/** The help command a user chose; the adapter decides environment and artifacts. */
export interface HelpRequest {
  program?: string | null;
  args: string[];
  scope: string[];
}

export interface AcceptedHelp {
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
  /** Value counts and repetition the user confirmed for help options. */
  supplement?: SupplementView | null;
  /** A confirmation file this app refuses to read; nothing from it applies. */
  supplement_error?: string | null;
}

/** Syntax a user confirmed where the reviewed help left it unknown. */
export interface ConfirmedSyntax {
  arity?: { min: number; max: number | null };
  repeatable?: boolean;
}

export interface SupplementConflict {
  key: string;
  field: 'option' | 'arity' | 'repeatable';
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
export type AuthBinding = { kind: 'none' } | { kind: 'env'; name: string };
export type ServingProtocol = { kind: 'openai_http' } | { kind: 'bridge'; program: string; prefix: string[] };

export interface ProcessSpec {
  program: string;
  args: string[];
  env: Record<string, string>;
  working_directory?: string | null;
}

/** An entry point before any binding is chosen; enough to derive its help. */
export interface EntrypointHelp {
  engine_id: string;
  runtime_id: string;
  program: string;
  prefix: string[];
  working_directory?: string | null;
  artifacts: string[];
  environment: Record<string, string>;
  protocol: ServingProtocol;
}

export interface EntrypointDraft extends EntrypointHelp {
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
  engine_id: string;
  runtime_id: string;
  display_name: string;
  launch: ProcessSpec;
  probe: ProcessSpec;
  [field: string]: unknown;
}

export const entrypointHelpDiscover = (entry: EntrypointHelp, request: HelpRequest): Promise<[HelpReport, RuntimeDescriptor]> =>
  invoke<[HelpReport, RuntimeDescriptor]>('entrypoint_help_discover', { entry, request });

export const entrypointHelpCancel = (entry: EntrypointHelp): Promise<boolean> =>
  invoke<boolean>('entrypoint_help_cancel', { entry });

export const entrypointManifestPreview = (draft: EntrypointDraft): Promise<RegisteredManifest> =>
  invoke<RegisteredManifest>('entrypoint_manifest_preview', { draft });

export const runtimeEntrypointRegister = (draft: EntrypointDraft): Promise<RegisteredManifest> =>
  invoke<RegisteredManifest>('runtime_entrypoint_register', { draft });

export const pickRuntimePath = (kind: 'file' | 'folder'): Promise<string | null> =>
  invoke<string | null>('pick_runtime_path', { kind });
