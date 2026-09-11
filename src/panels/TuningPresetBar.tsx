import PanelFeedback from "../components/PanelFeedback";
import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import StatusBadge from "../components/StatusBadge";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import type { TuningPhase } from "./useTuningController";

interface PendingBulkChange { title: string; description: string; confirmLabel: string; run: () => void }

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  phase: TuningPhase;
  flash: string | null;
  dismissFlash: () => void;
  changedServerFields: string[];
  relationWarnings: string[];
  busy: boolean;
  pendingBulkChange: PendingBulkChange | null;
  setPendingBulkChange: (value: PendingBulkChange | null) => void;
  applyPreset: (name: "CPU" | "Balanced" | "Max GPU") => void;
  resetDefaults: () => void;
  profileLabel?: string;
  onResetAll: () => void;
}

export default function TuningPresetBar({
  t, phase, flash, dismissFlash, changedServerFields, relationWarnings, busy,
  pendingBulkChange, setPendingBulkChange, applyPreset, resetDefaults, profileLabel, onResetAll,
}: Props) {
  return (
    <>
      <PanelFeedback>
        {flash && <FeedbackBanner tone={phase === "failed" ? "error" : "info"} onDismiss={dismissFlash}>{flash}</FeedbackBanner>}
        {phase === "dirty" && changedServerFields.length > 0 && (
          <FeedbackBanner tone="warning" title={t("ui.serverSettingsChangedCount", { count: changedServerFields.length })}>
            {changedServerFields.join(" · ")} · {t("extra.conversationsRemainSaved")}
          </FeedbackBanner>
        )}
        {relationWarnings.length > 0 && (
          <FeedbackBanner tone="warning" title={t("error.attention")}>
            <ul className="list-disc space-y-1 pl-4">{relationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </FeedbackBanner>
        )}
      </PanelFeedback>

      <div className="tuning-preset-bar mb-4 flex shrink-0 flex-wrap items-center gap-2.5">
        <details className="tuning-presets-menu">
        <summary className="app-button app-button--secondary">{t("extra.tuningPresets")}</summary>
        <div className="tuning-presets-options">
        {(["CPU", "Balanced", "Max GPU"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setPendingBulkChange({
              title: t("ui.presetTitle", { name }),
              description: t("ui.presetBody", { name }),
              confirmLabel: t("ui.presetConfirm"),
              run: () => applyPreset(name),
            })}
            disabled={phase === "applying" || busy}
            className="rounded-lg border border-line-strong app-bg-muted px-3 py-1.5 text-xs text-ink app-bg-elevated disabled:opacity-40"
          >
            {name}
          </button>
        ))}
        {profileLabel && <button
          type="button"
          onClick={() => setPendingBulkChange({
            title: t("ui.loadProfileTitle"),
            description: t("ui.loadProfileBody"),
            confirmLabel: t("ui.loadProfileConfirm"),
            run: resetDefaults,
          })}
          disabled={phase === "applying" || busy}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-muted app-bg-muted disabled:opacity-40"
        >
          {profileLabel}
        </button>}
        </div>
        </details>
        {phase === "idle" && <StatusBadge label={t("extra.saved")} tone="success" />}
        {phase === "dirty" && <StatusBadge label={t("extra.restartRequired")} tone="warning" />}
        {phase === "applying" && <StatusBadge label={t("extra.applying")} tone="neutral" />}
        {phase === "failed" && <StatusBadge label={t("extra.applyFailed")} tone="danger" />}
        {phase === "dirty" && <span className="text-xs text-warning">{t("extra.previousValues")}</span>}
        <button type="button" disabled={busy || phase === "applying"} onClick={onResetAll} title={t("ui.runtimeDefaultsHint")} className="app-button app-button--ghost tuning-reset-all">{t("ui.runtimeDefaultsResetAll")}</button>
      </div>
      <ConfirmDialog
        open={pendingBulkChange !== null}
        title={pendingBulkChange?.title ?? ""}
        description={pendingBulkChange?.description ?? ""}
        confirmLabel={pendingBulkChange?.confirmLabel ?? t("common.confirm")}
        cancelLabel={t("common.cancel")}
        tone="primary"
        onConfirm={() => { pendingBulkChange?.run(); setPendingBulkChange(null); }}
        onCancel={() => setPendingBulkChange(null)}
      />
    </>
  );
}
