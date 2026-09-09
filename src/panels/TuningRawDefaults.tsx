import { useContext } from "react";
import { TuningDefaultsContext } from "./TuningDefaultField";
import { useI18n } from "../i18n";

export default function TuningRawDefaults() {
  const context = useContext(TuningDefaultsContext);
  const { t } = useI18n();
  if (!context) return null;
  const args = [...new Set(context.cfg.server_args.filter((arg) => /^--?[a-zA-Z]/.test(arg)).map((arg) => arg.split("=", 1)[0]))];
  const fields = [...args.map((label) => ({ key: `raw-server:${label}`, label })),
    ...Object.keys(context.cfg.chat_options).map((label) => ({ key: `raw-chat:${label}`, label }))];
  if (!fields.length) return null;
  return <details className="mt-4 rounded-lg border border-slate-700 p-3">
    <summary className="cursor-pointer text-sm text-slate-300">{t("ui.runtimeDefaultRaw")}</summary>
    <p className="my-2 text-xs text-slate-400">{t("ui.runtimeDefaultRawHint")}</p>
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      {fields.map(({ key, label }) => <div key={key} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border border-slate-700 p-2">
        <code className="min-w-0 break-all text-xs text-slate-300">{label}</code>
        <button type="button" disabled={context.disabled} className="app-button app-button--secondary app-button--sm" aria-label={t("ui.runtimeDefaultResetRaw", { label })}
          onClick={() => context.reset(key)}>{t("ui.runtimeDefaultReset")}</button>
      </div>)}
    </div>
  </details>;
}
