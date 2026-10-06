import { useEffect, useState } from 'react';
import * as api from '../api';
import { providerOf, providerDisplayName, runtimeLabel } from '../api/providers';
import { useI18n } from '../i18n/i18n';
import { providerCopy } from '../i18n/providerCopy';
import { runtimeVersionLabel, useInstalledRuntimes } from '../runtime/installedRuntimes';

/** Name the selected engine installation without inheriting a different engine's build. */
export default function RuntimeSelectionLabel({ config, separator = ' / ' }: { config?: Partial<api.AppConfig> | null; separator?: string }) {
  const { locale } = useI18n();
  const provider = providerOf(config ?? {});
  const installed = useInstalledRuntimes(provider === 'llama.cpp');
  const id = config?.active_runtime ?? '';
  const [runtime, setRuntime] = useState<api.RuntimeInstance>();
  useEffect(() => {
    let active = true;
    setRuntime(undefined);
    if (provider !== 'llama.cpp' && id && api.isNativeRuntimeAvailable()) {
      void api.providerRuntimes().then(entries => {
        if (active) setRuntime(entries.find(entry => entry.provider === provider && entry.id === id));
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [provider, id]);
  if (provider !== 'llama.cpp') {
    return `${providerDisplayName(provider)} · ${runtime?.provider === provider && runtime.id === id ? runtimeLabel(runtime) : id || providerCopy[locale].choose}`;
  }
  const backend = config?.active_backend || 'PATH';
  const build = config?.active_build;
  return `llama.cpp · ${backend}${build ? `${separator}${runtimeVersionLabel(installed, backend, build)}` : ''}`;
}
