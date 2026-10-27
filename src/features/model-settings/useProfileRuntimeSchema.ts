import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { providerOptionSchema } from '../../shared/api';
import { providerOf, type ProviderId } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';
import type { EffectiveSchema } from '../../shared/api/runtimeHelp';
import { useRuntimeInventoryRevision } from '../../shared/runtime/runtimeInventoryEvents';

export interface ProfileRuntimeSchema {
  provider: ProviderId;
  runtime: string;
  view?: EffectiveSchema;
  pending: boolean;
  /** Only the option editor displays diagnostics; summaries show status only. */
  error?: string;
  retry: () => void;
}

export const ProfileRuntimeSchemaContext = createContext<ProfileRuntimeSchema | null>(null);

/** One checked schema per runtime in this workspace. Profile values do not
 * affect its facts. Reentry, runtime selection and explicit retry recheck it. */
export function useProfileRuntimeSchema(config: AppConfig | undefined, enabled: boolean): ProfileRuntimeSchema {
  const shared = useContext(ProfileRuntimeSchemaContext);
  const provider = providerOf(config ?? {});
  const runtime = provider === 'llama.cpp'
    ? config?.active_backend && config.active_build ? `${config.active_backend}:${config.active_build}` : ''
    : config?.active_runtime ?? '';
  const sharedMatches = shared?.provider === provider && shared.runtime === runtime;
  const latest = useRef(config); latest.current = config;
  const inventory = useRuntimeInventoryRevision();
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  const request = useMemo(() => ({ provider, runtime, enabled, revision, inventory }), [provider, runtime, enabled, revision, inventory]);
  const [result, setResult] = useState<{ request: typeof request; view?: EffectiveSchema; error?: string }>();
  const pending = useRef<{ request: typeof request; promise: Promise<EffectiveSchema> } | undefined>(undefined);
  useEffect(() => {
    if (sharedMatches || !request.enabled || !request.runtime || !latest.current) return;
    let active = true;
    // React's effect replay can subscribe again to this same pending read.
    // Completed reads are never reused for a later workspace entry or retry.
    if (pending.current?.request !== request) pending.current = { request, promise: providerOptionSchema(latest.current) };
    void pending.current.promise.then(view => {
      if (active) setResult({ request, view });
    }).catch(cause => {
      // Validation diagnostics may contain option values. Summaries expose
      // status only; detailed errors remain in the option editor.
      if (active) setResult({ request, error: String(cause) });
    });
    return () => { active = false; };
  }, [request, sharedMatches]);
  if (enabled && sharedMatches) return shared;
  const current = result?.request === request;
  return { provider, runtime,
    view: current ? result?.view : undefined,
    error: current ? result?.error : undefined,
    pending: enabled && !!runtime && !current, retry };
}
