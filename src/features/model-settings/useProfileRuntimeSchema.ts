import { useEffect, useMemo, useState } from 'react';
import { providerOptionSchema } from '../../shared/api';
import { providerOf, type ProviderId } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';
import type { EffectiveSchema } from '../../shared/api/runtimeHelp';

export interface ProfileRuntimeSchema {
  provider: ProviderId;
  runtime: string;
  view?: EffectiveSchema;
  pending: boolean;
  retry: () => void;
}

/** Recheck on entry or selection changes; reject late answers and old display values. */
export function useProfileRuntimeSchema(config: AppConfig | undefined, enabled: boolean): ProfileRuntimeSchema {
  const [revision, setRevision] = useState(0);
  const request = useMemo(() => ({ config, enabled, revision }), [config, enabled, revision]);
  const [result, setResult] = useState<{ request: typeof request; view?: EffectiveSchema }>();
  useEffect(() => {
    if (!enabled || !config || !config.active_runtime) return;
    let active = true;
    void providerOptionSchema(config).then(view => {
      if (active) setResult({ request, view });
    }).catch(() => {
      // Validation diagnostics may contain option values. Summaries expose
      // status only; detailed errors remain in the option editor.
      if (active) setResult({ request });
    });
    return () => { active = false; };
  }, [config, enabled, request]);
  const current = result?.request === request;
  return { provider: providerOf(config ?? {}), runtime: config?.active_runtime ?? '',
    view: current ? result?.view : undefined,
    pending: enabled && !!config?.active_runtime && !current,
    retry: () => setRevision(value => value + 1) };
}
