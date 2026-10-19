import { useEffect, useState } from 'react';
import * as api from '../api';
import { providerOf, providerDisplayName } from '../api/providers';
import { runtimeInstanceLabel } from '../i18n/runtimeInstanceText';
import { useI18n } from '../i18n/i18n';
import { providerCopy } from '../i18n/providerCopy';
import { runtimeVersionLabel, useInstalledRuntimes } from '../runtime/installedRuntimes';
import { useRuntimeInventoryRevision } from '../runtime/runtimeInventoryEvents';

/** Name the selected engine installation without inheriting a different engine's build. */
export default function RuntimeSelectionLabel({ config, separator = ' / ' }: { config?: Partial<api.AppConfig> | null; separator?: string }) {
  const { locale } = useI18n();
  const provider = providerOf(config ?? {});
  const installed = useInstalledRuntimes(provider === 'llama.cpp');
  const id = config?.active_runtime ?? '';
  const revision = useRuntimeInventoryRevision();
  const identity = JSON.stringify([provider, id, revision]);
  const [resolved, setResolved] = useState<{ identity: string; runtime?: api.RuntimeInstance }>();
  const runtime = resolved?.identity === identity ? resolved.runtime : undefined;
  useEffect(() => {
    let active = true;
    if (provider !== 'llama.cpp' && id && api.isNativeRuntimeAvailable()) {
      void api.providerRuntimes().then(entries => {
        if (active) setResolved({ identity, runtime: entries.find(entry => entry.provider === provider && entry.id === id) });
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [provider, id, identity]);
  if (provider !== 'llama.cpp') {
    return `${providerDisplayName(provider)} · ${runtime?.provider === provider && runtime.id === id ? runtimeInstanceLabel(runtime, locale) : id || providerCopy[locale].choose}`;
  }
  const backend = config?.active_backend || 'PATH';
  const build = config?.active_build;
  return `llama.cpp · ${backend}${build ? `${separator}${runtimeVersionLabel(installed, backend, build)}` : ''}`;
}
