import { invoke } from './transport.ts';
import type { ProviderId } from './providers.ts';

/** Discovery is an observation of an installation or process, never proof
 * that it can serve a model. The backend verifies the selected candidate. */
export interface RuntimeCandidate {
  id: string;
  source: 'local_process' | 'selected_folder';
  display_name: string;
  entrypoint_path: string | null;
  command?: {
    program: string;
    args: string[];
    working_directory?: string | null;
    argv_source: string;
  } | null;
  endpoints: Array<{ host: string; port: number }>;
  entrypoint_kind: 'native' | 'interpreter' | 'container' | 'attached' | 'unknown';
  state: 'needs_configuration';
  pid?: number | null;
  process_identity?: string | null;
  reasons: string[];
}

export interface RuntimeDiscovery {
  candidates: RuntimeCandidate[];
  warnings: string[];
  truncated: boolean;
}

/** A command path the program documents for serving, such as `serve llm`.
 * An empty path is the entry point itself. */
export interface LaunchCommand {
  path: string[];
  summary: string;
}

export interface PreparedRuntimeConnection {
  /** `choose_command`: several documented commands can serve a model; inspect
   * again with one of `commands` before connecting. */
  kind: 'attached' | 'managed' | 'choose_command';
  candidate: RuntimeCandidate;
  /** Models an attached server lists; every one is registered. Empty for a
   * managed launch, which serves whichever library model a session starts. */
  models: Array<{ id: string; name: string }>;
  detail: string;
  base_url: string | null;
  /** Opaque backend-owned preparation token. */
  plan: string;
  /** Documented command path a managed launch uses; empty otherwise. */
  command?: string[];
  commands?: LaunchCommand[];
}

export interface AutomaticRuntimeResult {
  engine_id: ProviderId;
  runtime_id: string;
  display_name: string;
  mode: 'attached' | 'managed';
  checks: string[];
}

export function runtimeAutoDiscover(folder?: string): Promise<RuntimeDiscovery> {
  return invoke('runtime_auto_discover', { folder: folder ?? null });
}

export function runtimeAutoInspect(candidate: RuntimeCandidate, command?: string[]): Promise<PreparedRuntimeConnection> {
  return invoke('runtime_auto_inspect', { candidate, command: command ?? null });
}

/** Registers the engine without choosing a model; each model is checked when
 * a session first starts it. */
export function runtimeAutoConnect(prepared: PreparedRuntimeConnection): Promise<AutomaticRuntimeResult> {
  return invoke('runtime_auto_connect', { prepared });
}

export function runtimeAutoCancel(): Promise<boolean> {
  return invoke('runtime_auto_cancel');
}
