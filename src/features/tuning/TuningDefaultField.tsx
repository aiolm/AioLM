import { createContext, useContext, type ReactNode } from "react";
import type { AppConfig } from "../../shared/api/types";
import { useI18n } from "../../shared/i18n/i18n";
import { hasChatOverride, usesRuntimeDefault } from "../../shared/config/tuningDefaults";
import TuningOptionMetadata from './TuningOptionMetadata';
import catalog from '../../shared/config/tuningDefaultsCatalog.json';
import { serverOptionsText } from '../../shared/i18n/serverOptionsI18n';

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
    <div className="tuning-default-field flex min-w-0 flex-col gap-2" data-default-field={fieldKey}>
      <div className="tuning-default-field__content">
      {children}
      <TuningOptionMetadata fieldKey={fieldKey} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={context.disabled}
          aria-label={t("ui.runtimeDefaultResetField", { label })} onClick={() => context.reset(fieldKey)}>{t("ui.runtimeDefaultReset")}</button>
        {inherited && <span className="text-success">{catalog.some(field => field.key === fieldKey && field.appDefault) ? serverOptionsText[locale].defaultApp : t("ui.runtimeDefaultActive")}</span>}
      </div>
    </div>
  );
}
