import type { ReactNode } from 'react';
import { useI18n } from '../../shared/i18n/i18n';
import { settingsFlowCopy } from './settingsFlowCopy';

export type SettingsStep = 'runtime' | 'profile' | 'options';

export default function SettingsFlowNav({ step, runtime, profile, canProfile, canOptions, disabled, onSelect }: {
  step: SettingsStep; runtime: ReactNode; profile: string; canProfile: boolean; canOptions: boolean;
  disabled: boolean; onSelect: (step: SettingsStep) => void;
}) {
  const { locale } = useI18n(); const copy = settingsFlowCopy[locale];
  return <nav className="model-settings-flow" aria-label={copy.journey}>
    <ol>{(['runtime', 'profile', 'options'] as const).map((value, index) => {
      const summary = value === 'options' ? '' : (value === 'runtime' ? runtime : canProfile ? profile : '') || copy.choose;
      return <li key={value}>
        <button type="button" aria-current={step === value ? 'step' : undefined}
          disabled={disabled || value === 'profile' && !canProfile || value === 'options' && !canOptions}
          onClick={() => onSelect(value)}>
          <span className="model-settings-step-number" aria-hidden="true">{index + 1}</span>
          <span><strong>{copy[value]}</strong>{summary && <small title={typeof summary === 'string' ? summary : undefined}>{summary}</small>}</span>
        </button>
      </li>;
    })}</ol>
  </nav>;
}
