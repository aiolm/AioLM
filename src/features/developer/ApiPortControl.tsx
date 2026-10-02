import { useState } from "react";
import StableLabel from "../../shared/ui/StableLabel";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import { useI18n } from "../../shared/i18n/i18n";

/**
 * The public API port. Saving it while the API is running restarts the API
 * listener only; the parent owns that restart and never touches a loaded model.
 */
export default function ApiPortControl({ savedPort, running, runningPort, disabled, onApply, onRestart }: {
  savedPort: number;
  running: boolean;
  runningPort: number;
  disabled: boolean;
  /** Resolves true once the port is saved (and, if the API was running, restarted). */
  onApply: (port: number) => Promise<boolean>;
  onRestart: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? String(savedPort);
  const valid = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  const changed = draft !== null && Number(draft) !== savedPort;
  const stale = running && runningPort !== savedPort;
  const apply = async () => {
    if (!valid || !changed || saving) return;
    setSaving(true);
    try {
      if (await onApply(Number(value))) setDraft(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="api-port-form" onSubmit={(event) => { event.preventDefault(); void apply(); }}>
      <label htmlFor="developer-api-port" className="app-eyebrow ui-font-size-12px">{t("ui.apiPort")}</label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input id="developer-api-port" className="app-input w-28" type="number" inputMode="numeric" min={1} max={65535} step={1} value={value}
          aria-describedby="developer-api-port-hint developer-api-port-feedback" aria-invalid={draft !== null && !valid}
          disabled={disabled || saving} onChange={(event) => setDraft(event.target.value)} />
        <button data-icon="save" type="submit" className="app-button app-button--secondary app-button--sm" disabled={disabled || saving || !changed || !valid} aria-busy={saving}>
          <StableLabel value={running ? t("ui.savePortRestart") : t("ui.savePort")} labels={[t("ui.savePortRestart"), t("ui.savePort")]} />
        </button>
        {draft !== null && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={saving} data-icon="close" onClick={() => setDraft(null)}>{t("common.cancel")}</button>}
      </div>
      <p id="developer-api-port-hint" className="mt-2 text-xs ui-color-faint">{t("ui.apiPortHint")}</p>
      <div id="developer-api-port-feedback" className="text-xs ui-color-muted">
        {draft !== null && !valid && <p role="alert" className="mt-1">{t("ui.apiPortInvalid")}</p>}
        {stale && <FeedbackBanner tone="warning" className="api-port-pending" action={{ label: t("ui.restartApi"), disabled, onClick: onRestart }}>{t("ui.apiPortPending", { port: savedPort, current: runningPort })}</FeedbackBanner>}
      </div>
    </form>
  );
}
