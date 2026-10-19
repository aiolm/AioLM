import { useI18n } from '../../shared/i18n/i18n';
import { settingsFlowCopy } from './settingsFlowCopy';

export type SettingsStep = 'runtime' | 'profile' | 'options';

export default function SettingsFlowNav({ step, runtime, profile, canProfile, canOptions, disabled, onSelect }: {
  step: SettingsStep; runtime: string; profile: string; canProfile: boolean; canOptions: boolean;
  disabled: boolean; onSelect: (step: SettingsStep) => void;
}) {
  const { locale } = useI18n(); const copy = settingsFlowCopy[locale];
  return <nav className="model-settings-flow" aria-label={copy.journey}>
    <ol>{(['runtime', 'profile', 'options'] as const).map((value, index) => <li key={value}>
      <button type="button" aria-current={step === value ? 'step' : undefined}
        disabled={disabled || value === 'profile' && !canProfile || value === 'options' && !canOptions}
        onClick={() => onSelect(value)}>
        <span className="model-settings-step-number" aria-hidden="true">{index + 1}</span>
        <span><strong>{copy[value]}</strong>{value !== 'options' && <small>{(value === 'runtime' ? runtime : canProfile ? profile : '') || copy.choose}</small>}</span>
      </button>
    </li>)}</ol>
  </nav>;
}
