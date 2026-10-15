import { invoke } from './transport.ts';

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
