import { useEffect, useSyncExternalStore } from 'react';
import { PROVIDERS, providerDisplayName, providerCatalog, runtimeCatalogSnapshot, subscribeRuntimeCatalog, type ProviderId } from '../api/providers';
import { useI18n } from '../i18n/i18n';
import { providerCopy } from '../i18n/providerCopy';
import { CustomSelect } from './CustomSelect';

/** Browsing an engine's inventory does not change the model's execution profile. */
export default function EngineSelect({ value, onChange, disabled = false, size = 'md' }: { value: ProviderId; onChange: (provider: ProviderId) => void; disabled?: boolean; size?: 'sm' | 'md' }) {
  const { locale } = useI18n();
  const catalog = useSyncExternalStore(subscribeRuntimeCatalog, runtimeCatalogSnapshot);
  useEffect(() => { void providerCatalog().catch(() => undefined); }, []);
  const choices = [...new Set<ProviderId>([...PROVIDERS, ...catalog.map(item => item.id), value])];
  return <label className="engine-select">{providerCopy[locale].engine}<CustomSelect ariaLabel={providerCopy[locale].engine} value={value} disabled={disabled} size={size}
    options={choices.map(provider => ({ value: provider, label: providerDisplayName(provider) }))} onChange={onChange} /></label>;
}
