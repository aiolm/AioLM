import { useState } from "react";
import { version } from "../../../package.json";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { formatBytes } from "../../shared/lib/units";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import ProgressBar from "../../shared/ui/ProgressBar";
import { appUpdater, openAppUpdateRelease, useAppUpdate } from "./appUpdater";
import { isUpdateBusy, type UpdateState } from "./updateStore";
import { updateText } from "./updateText";

// Installation runs download → verification → installer launch. Opening the
// installer is the last step AioLM performs; it does not signal update completion.
const installSteps = ["downloading", "verifying", "installing"] as const;
const installStepIndex: Partial<Record<UpdateState["phase"], number>> = { downloading: 0, verifying: 1, installing: 2, "installer-started": 3 };

export default function AppUpdateSettings({ query = "", updater = appUpdater, openRelease = openAppUpdateRelease }: { query?: string; updater?: typeof appUpdater; openRelease?: () => Promise<void> }) {
  const state = useAppUpdate(updater);
  const { locale } = useI18n();
  const copy = updateText[locale];
  const [confirm, setConfirm] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const native = updater.isNative();
  const busy = isUpdateBusy(state.phase);
  const info = state.info;
  const progress = state.progress;
  const total = progress?.total;
  const percent = progress && total ? Math.min(100, Math.floor((progress.downloaded / total) * 100)) : undefined;
  const stepIndex = installStepIndex[state.phase];
  const status = !native ? copy.nativeOnly
    : state.phase === "checking" ? copy.checking
    : state.phase === "downloading" ? copy.downloading
    : state.phase === "verifying" ? copy.verifying
    : state.phase === "installing" ? copy.installing
    : state.phase === "installer-started" ? copy.started
    : state.phase === "error" ? state.errorKind === "install" ? copy.installFailed : copy.checkFailed
    : info?.available ? copy.available
    : info ? info.latest_version ? copy.upToDate : copy.noRelease
    : copy.idle;
  if (query && !Object.values(copy).join(" ").toLocaleLowerCase().includes(query)) return null;

  return <div className="settings-row app-update" id="settings-app-update" data-setting="" role="group" aria-labelledby="settings-app-update-title">
    <div className="settings-copy"><h3 id="settings-app-update-title">{copy.title}</h3><p>{copy.description}</p></div>
    <div className="settings-control settings-actions">
      <button id="settings-check-update" type="button" className="app-button app-button--secondary" disabled={!native || busy} data-icon="refresh" onClick={() => void updater.check()}>{state.phase === "checking" ? copy.checking : copy.check}</button>
      {info?.available && <button type="button" className="app-button app-button--primary" data-icon="download" disabled={!native || busy || !info.can_install} onClick={() => setConfirm(true)}>{copy.install}</button>}
      {info?.available && <button type="button" className="app-button app-button--secondary" data-icon="open" disabled={!native || busy} onClick={() => {
        setReleaseError(null);
        void openRelease().catch((error: unknown) => setReleaseError(error instanceof Error ? error.message : String(error)));
      }}>{copy.releasePage}</button>}
    </div>
    <div className="app-update-content">
      <dl className="app-update-versions">
        <div><dt>{copy.current}</dt><dd>{info?.current_version ?? version}</dd></div>
        {info?.available && <div><dt>{copy.latest}</dt><dd>{info.latest_version}</dd></div>}
      </dl>
      <p className="app-update-status" role="status">{status}</p>
      {stepIndex !== undefined && <ol className="app-update-steps" aria-label={copy.steps}>
        {installSteps.map((step, index) => <li key={step} data-state={index < stepIndex ? "done" : index === stepIndex ? "current" : "pending"} aria-current={index === stepIndex ? "step" : undefined}>
          {copy.stepNames[index]}
        </li>)}
      </ol>}
      {state.phase === "downloading" && <div className="app-update-progress">
        <ProgressBar label={copy.downloadProgress} value={percent} />
        {percent !== undefined && <span>{percent}%</span>}
        {/* An unknown total reports bytes received, never a made-up percentage. */}
        {progress && <span className="app-update-bytes">{total ? copy.downloadedOf.replace("{done}", formatBytes(progress.downloaded)).replace("{total}", formatBytes(total)) : copy.downloaded.replace("{size}", formatBytes(progress.downloaded))}</span>}
      </div>}
      {state.error && <FeedbackBanner tone="error">{normalizeDisplayText(state.error)}</FeedbackBanner>}
      {releaseError && <FeedbackBanner tone="error">{normalizeDisplayText(releaseError)}</FeedbackBanner>}
      {info?.available && !info.can_install && <p className="app-update-note">{copy.unsupported}</p>}
      {info?.available && info.notes && <details className="app-update-notes"><summary>{copy.notes}</summary><div className="app-update-notes-body">{info.notes}</div></details>}
    </div>
    <ConfirmDialog open={confirm} title={copy.confirmTitle} description={copy.confirmBody} confirmLabel={copy.install} tone="primary"
      onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void updater.install(); }} />
  </div>;
}
