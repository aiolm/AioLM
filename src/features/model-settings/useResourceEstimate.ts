import { useEffect, useState } from 'react';
import * as api from '../../shared/api';
import type { ServerOption } from '../../shared/config/serverOptions';
import { defaultScalar } from '../../shared/config/tuningResetValues';
import { tuningOptionMetadata } from '../tuning/tuningOptionInfo';

/** Resolve app-owned defaults and verified runtime defaults, preserving unknown values. */
export function resourceEstimateConfig(cfg: api.AppConfig, options: readonly ServerOption[], verified: boolean): api.AppConfig {
  const resolved: Record<string, string | number> = {};
  const unresolved = (cfg.runtime_defaults ?? []).filter(key => {
    // Launch disables speculative decoding, including a configured draft model, while spec_type is inherited.
    if (key === 'spec_type') return true;
    const metadata = tuningOptionMetadata(key, options, verified);
    if (metadata.defaults.source !== 'app' && (!metadata.verified || metadata.defaults.source !== 'help')) return true;
    let scalar = defaultScalar(metadata.defaults.value);
    if (key === 'spec_draft_ngl' && typeof scalar === 'number') scalar = String(scalar);
    if (scalar === undefined || typeof scalar !== typeof cfg[key as keyof api.AppConfig]) return true;
    resolved[key] = scalar;
    return false;
  });
  return { ...cfg, ...resolved, runtime_defaults: unresolved };
}

export function useResourceEstimate(cfg: api.AppConfig, options: readonly ServerOption[], verified: boolean, enabled: boolean, runtimeDevices: readonly string[] = []) {
  const [revision, setRevision] = useState(0);
  const configKey = JSON.stringify(resourceEstimateConfig(cfg, options, verified));
  const devicesKey = JSON.stringify(runtimeDevices);
  const key = `${revision}:${configKey}:${devicesKey}`;
  const [result, setResult] = useState<{ key: string; estimate?: api.ResourceEstimate; error?: boolean }>();
  // A reopened or corrected view waits for its own request instead of showing an earlier result or error.
  if (!enabled && result) setResult(undefined);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // Request immediately after each valid edit; a response for an older draft can never replace it.
    void api.estimateModelResources(JSON.parse(configKey) as api.AppConfig, JSON.parse(devicesKey) as string[])
      .then(estimate => { if (active) setResult({ key, estimate }); })
      .catch(() => { if (active) setResult({ key, error: true }); });
    return () => { active = false; };
  }, [configKey, devicesKey, key, enabled]);
  const current = enabled && result?.key === key ? result : undefined;
  return { estimate: current?.estimate, error: current?.error ?? false, loading: enabled && !current,
    retry: () => setRevision(value => value + 1) };
}
