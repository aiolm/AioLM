import { useContext } from "react";
import { TuningDefaultsContext } from "./TuningDefaultField";
import { useI18n } from "../i18n";
import TuningOptionMetadata from './TuningOptionMetadata';

export default function TuningRawDefaults() {
  const context = useContext(TuningDefaultsContext);
  const { t } = useI18n();
  if (!context) return null;
  const args = [...new Set(context.cfg.server_args.filter((arg) => /^--?[a-zA-Z]/.test(arg)).map((arg) => arg.split("=", 1)[0]))];
  const fields = [...args.map((label) => ({ key: `raw-server:${label}`, label })),
    ...Object.keys(context.cfg.chat_options).map((label) => ({ key: `raw-chat:${label}`, label }))];
  if (!fields.length) return null;
  return <details className="mt-4 rounded-lg border border-line-strong p-3">
    <summary className="cursor-pointer text-sm text-ink">{t("ui.runtimeDefaultRaw")}</summary>
    <p className="my-2 text-xs text-muted">{t("ui.runtimeDefaultRawHint")}</p>
    <div className="grid min-w-0 gap-2 app-form-grid">
      {fields.map(({ key, label }) => <div key={key} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border border-line-strong p-2">
        <div className="min-w-0"><code className="text-xs text-ink">{label}</code><TuningOptionMetadata fieldKey={key} /></div>
        <button type="button" disabled={context.disabled} className="app-button app-button--secondary app-button--sm" aria-label={t("ui.runtimeDefaultResetRaw", { label })}
          onClick={() => context.reset(key)}>{t("ui.runtimeDefaultReset")}</button>
      </div>)}
    </div>
  </details>;
}
