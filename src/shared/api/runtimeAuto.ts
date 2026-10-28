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

export interface PreparedRuntimeConnection {
  kind: 'attached' | 'managed';
  candidate: RuntimeCandidate;
  models: Array<{ id: string; name: string }>;
  detail: string;
  base_url: string | null;
  /** Opaque backend-owned preparation token. */
  plan: string;
}

export interface AutomaticRuntimeResult {
  engine_id: ProviderId;
  runtime_id: string;
  display_name: string;
  model_path: string;
  mode: 'attached' | 'managed';
  checks: string[];
}

export function runtimeAutoDiscover(folder?: string): Promise<RuntimeDiscovery> {
  return invoke('runtime_auto_discover', { folder: folder ?? null });
}

export function runtimeAutoInspect(candidate: RuntimeCandidate): Promise<PreparedRuntimeConnection> {
  return invoke('runtime_auto_inspect', { candidate });
}

export function runtimeAutoConnect(prepared: PreparedRuntimeConnection, modelId: string): Promise<AutomaticRuntimeResult> {
  return invoke('runtime_auto_connect', { prepared, modelId });
}

export function runtimeAutoCancel(): Promise<boolean> {
  return invoke('runtime_auto_cancel');
}
