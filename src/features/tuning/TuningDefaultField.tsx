import { createContext, useContext, useState, type ReactNode } from "react";
import type { AppConfig } from "../../shared/api/types";
import { useI18n } from "../../shared/i18n/i18n";
import { hasChatOverride, usesRuntimeDefault } from "../../shared/config/tuningDefaults";
import TuningOptionMetadata from './TuningOptionMetadata';
import catalog from '../../shared/config/tuningDefaultsCatalog.json';
import { serverOptionsText } from '../../shared/i18n/serverOptionsI18n';

export const TuningDefaultsContext = createContext<{
  cfg: AppConfig;
  disabled: boolean;
  revision?: number;
  reset: (key: string) => void;
} | null>(null);

/** Keeps stale manual values out of the effective-value display. */
export default function TuningDefaultField({ fieldKey, label, children, request = false, hideLabel = false }: {
  fieldKey: string; label: string; children: ReactNode; request?: boolean; hideLabel?: boolean;
}) {
  const context = useContext(TuningDefaultsContext);
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const identity = `${context?.cfg.active_model}/${context?.revision ?? 0}`;
  const [editingIdentity, setEditingIdentity] = useState(identity);
  if (editingIdentity !== identity) {
    setEditingIdentity(identity);
    setEditing(false);
  }
  if (!context) return <>{children}<TuningOptionMetadata fieldKey={fieldKey} /></>;
  const inherited = request ? !hasChatOverride(context.cfg, fieldKey) : usesRuntimeDefault(context.cfg, fieldKey);
  return (
    <div className="tuning-default-field flex min-w-0 flex-col gap-2" data-default-field={fieldKey}>
      <div className="tuning-default-field__content">
      {inherited && !editing ? <div className={hideLabel ? "py-2" : "rounded-lg border border-line-strong p-3"}>
        {!hideLabel && <div className="text-sm text-ink">{label}</div>}
        <div className={`${hideLabel ? "" : "mt-2 "}text-xs text-success`}>{catalog.some(field => field.key === fieldKey && field.appDefault) ? serverOptionsText[locale].defaultApp : t("ui.runtimeDefaultActive")}</div>
      </div> : children}
      <TuningOptionMetadata fieldKey={fieldKey} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {inherited && !editing ? <button type="button" className="app-button app-button--secondary app-button--sm" disabled={context.disabled}
          aria-label={t("ui.runtimeDefaultEditField", { label })} onClick={() => setEditing(true)}>{t("ui.runtimeDefaultEdit")}</button>
          : <button type="button" className="app-button app-button--secondary app-button--sm" disabled={context.disabled}
            aria-label={t("ui.runtimeDefaultResetField", { label })} onClick={() => { setEditing(false); context.reset(fieldKey); }}>{t("ui.runtimeDefaultReset")}</button>}
        {inherited && editing && <span className="text-muted">{t("ui.runtimeDefaultUntilEdit")}</span>}
      </div>
    </div>
  );
}
