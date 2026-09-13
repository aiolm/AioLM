import { createContext, useContext, type ReactNode } from "react";
import type { AppConfig } from "../../shared/api/types";
import { useI18n } from "../../shared/i18n/i18n";
import { hasChatOverride, usesRuntimeDefault } from "../../shared/config/tuningDefaults";
import TuningOptionMetadata from './TuningOptionMetadata';
import { settingMetadataCopy } from '../../shared/i18n/settingMetadataCopy';

export const TuningDefaultsContext = createContext<{
  cfg: AppConfig;
  disabled: boolean;
  reset: (key: string) => void;
} | null>(null);

/** Keeps controls editable while showing whether their value follows the runtime. */
export default function TuningDefaultField({ fieldKey, label, children, request = false }: {
  fieldKey: string; label: string; children: ReactNode; request?: boolean;
}) {
  const context = useContext(TuningDefaultsContext);
  const { t, locale } = useI18n();
  if (!context) return <>{children}<TuningOptionMetadata fieldKey={fieldKey} /></>;
  const inherited = request ? !hasChatOverride(context.cfg, fieldKey) : usesRuntimeDefault(context.cfg, fieldKey);
  return (
    <div className="tuning-default-field" data-default-field={fieldKey}>
      <div className="tuning-default-field__content">
      {children}
      </div>
      <TuningOptionMetadata fieldKey={fieldKey} inherited={inherited}>
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={context.disabled}
          aria-label={t("ui.runtimeDefaultResetField", { label })} onClick={() => context.reset(fieldKey)}>{settingMetadataCopy[locale].reset}</button>
      </TuningOptionMetadata>
    </div>
  );
}
