import { createContext, useContext, type ReactNode } from "react";
import type { AppConfig } from "../../shared/api/types";
import { useI18n } from "../../shared/i18n/i18n";
import { hasChatOverride, usesRuntimeDefault } from "../../shared/config/tuningDefaults";
import TuningOptionMetadata from './TuningOptionMetadata';

export const TuningDefaultsContext = createContext<{
  cfg: AppConfig;
  disabled: boolean;
  reset: (key: string) => void;
} | null>(null);

/**
 * Keeps controls editable while showing whether their value follows the runtime.
 * A render callback receives the reset button so the field can place it in its
 * own title row; below the metadata it read as the next setting's action.
 */
export default function TuningDefaultField({ fieldKey, label, children, request = false }: {
  fieldKey: string; label: string; children: ReactNode | ((resetAction: ReactNode) => ReactNode); request?: boolean;
}) {
  const context = useContext(TuningDefaultsContext);
  const { t } = useI18n();
  const resetLabel = t("ui.runtimeDefaultResetField", { label });
  const resetAction = context && <button type="button" className="app-icon-button app-icon-button--sm" disabled={context.disabled}
    aria-label={resetLabel} title={resetLabel} onClick={() => context.reset(fieldKey)}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
    </svg>
  </button>;
  const content = typeof children === "function"
    ? children(resetAction)
    : <>{resetAction && <div className="tuning-field-title"><span>{label}</span>{resetAction}</div>}{children}</>;
  if (!context) return <>{content}<TuningOptionMetadata fieldKey={fieldKey} /></>;
  const inherited = request ? !hasChatOverride(context.cfg, fieldKey) : usesRuntimeDefault(context.cfg, fieldKey);
  const value = request
    ? (context.cfg.chat_options as Record<string, unknown> | undefined)?.[fieldKey]
    : (context.cfg as unknown as Record<string, unknown>)[fieldKey];
  return (
    <div className="tuning-default-field" data-default-field={fieldKey}>
      <div className="tuning-default-field__content">
      {content}
      </div>
      <TuningOptionMetadata fieldKey={fieldKey} inherited={inherited} value={value} />
    </div>
  );
}
