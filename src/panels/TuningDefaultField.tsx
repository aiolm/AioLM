import { createContext, useContext, useState, type ReactNode } from "react";
import type { AppConfig } from "../api";
import { useI18n } from "../i18n";
import { hasChatOverride, usesRuntimeDefault } from "../tuningDefaults";

export const TuningDefaultsContext = createContext<{
  cfg: AppConfig;
  disabled: boolean;
  reset: (key: string) => void;
} | null>(null);

/** Keeps stale manual values out of the effective-value display. */
export default function TuningDefaultField({ fieldKey, label, children, request = false, hideLabel = false }: {
  fieldKey: string; label: string; children: ReactNode; request?: boolean; hideLabel?: boolean;
}) {
  const context = useContext(TuningDefaultsContext);
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  if (!context) return <>{children}</>;
  const inherited = request ? !hasChatOverride(context.cfg, fieldKey) : usesRuntimeDefault(context.cfg, fieldKey);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-default-field={fieldKey}>
      {inherited && !editing ? <div className={hideLabel ? "py-2" : "rounded-lg border border-slate-700 p-3"}>
        {!hideLabel && <div className="text-sm text-slate-300">{label}</div>}
        <div className={`${hideLabel ? "" : "mt-2 "}text-xs text-emerald-400`}>{t("ui.runtimeDefaultActive")}</div>
      </div> : children}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {inherited && !editing ? <button type="button" className="app-button app-button--secondary app-button--sm" disabled={context.disabled}
          aria-label={t("ui.runtimeDefaultEditField", { label })} onClick={() => setEditing(true)}>{t("ui.runtimeDefaultEdit")}</button>
          : <button type="button" className="app-button app-button--secondary app-button--sm" disabled={context.disabled}
            aria-label={t("ui.runtimeDefaultResetField", { label })} onClick={() => { setEditing(false); context.reset(fieldKey); }}>{t("ui.runtimeDefaultReset")}</button>}
        {inherited && editing && <span className="text-slate-400">{t("ui.runtimeDefaultUntilEdit")}</span>}
      </div>
    </div>
  );
}
