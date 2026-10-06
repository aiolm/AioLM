import { PROVIDERS, providerDisplayName, type ProviderId } from '../api/providers';
import { useI18n } from '../i18n/i18n';
import { providerCopy } from '../i18n/providerCopy';
import { CustomSelect } from './CustomSelect';

/** Browsing an engine's inventory does not change the model's execution profile. */
export default function EngineSelect({ value, onChange, disabled = false, size = 'md' }: { value: ProviderId; onChange: (provider: ProviderId) => void; disabled?: boolean; size?: 'sm' | 'md' }) {
  const { locale } = useI18n();
  return <label className="engine-select">{providerCopy[locale].engine}<CustomSelect ariaLabel={providerCopy[locale].engine} value={value} disabled={disabled} size={size}
    options={PROVIDERS.map(provider => ({ value: provider, label: providerDisplayName(provider) }))} onChange={onChange} /></label>;
}
