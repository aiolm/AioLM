import { useState } from "react";
import { version } from "../../../package.json";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { appUpdater, openAppUpdateRelease, useAppUpdate } from "./appUpdater";
import { isUpdateBusy } from "./updateStore";
import { updateText } from "./updateText";

export default function AppUpdateSettings({ query = "", updater = appUpdater, openRelease = openAppUpdateRelease }: { query?: string; updater?: typeof appUpdater; openRelease?: () => Promise<void> }) {
  const state = useAppUpdate(updater);
  const { locale } = useI18n();
  const copy = updateText[locale];
  const [confirm, setConfirm] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const native = updater.isNative();
  const busy = isUpdateBusy(state.phase);
  const info = state.info;
  const total = state.progress?.total;
  const percent = total ? Math.min(100, Math.floor((state.progress!.downloaded / total) * 100)) : undefined;
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

  return <div className="settings-row app-update-settings" id="settings-app-update">
    <div className="settings-copy"><h4>{copy.title}</h4><p>{copy.description}</p></div>
    <div className="app-update-content">
      <p>{copy.current}: <strong>{info?.current_version ?? version}</strong>{info?.available && <> · {copy.latest}: <strong>{info.latest_version}</strong></>}</p>
      <p role="status">{status}</p>
      {state.error && <p role="alert" className="ui-color-error-ink">{normalizeDisplayText(state.error)}</p>}
      {releaseError && <p role="alert" className="ui-color-error-ink">{normalizeDisplayText(releaseError)}</p>}
      {state.phase === "downloading" && <div className="app-update-progress"><progress aria-label={copy.downloadProgress} max={100} value={percent} />{percent !== undefined && <span>{percent}%</span>}</div>}
      {info?.available && !info.can_install && <p>{copy.unsupported}</p>}
      {info?.available && info.notes && <details><summary>{copy.notes}</summary><div className="app-update-notes">{info.notes}</div></details>}
      <div className="app-update-actions">
        <button id="settings-check-update" type="button" className="app-button app-button--secondary" disabled={!native || busy} onClick={() => void updater.check()}>{state.phase === "checking" ? copy.checking : copy.check}</button>
        {info?.available && <button type="button" className="app-button app-button--primary" disabled={!native || busy || !info.can_install} onClick={() => setConfirm(true)}>{copy.install}</button>}
        {info?.available && <button type="button" className="app-button app-button--secondary" disabled={!native || busy} onClick={() => {
          setReleaseError(null);
          void openRelease().catch((error: unknown) => setReleaseError(error instanceof Error ? error.message : String(error)));
        }}>{copy.releasePage}</button>}
      </div>
    </div>
    <ConfirmDialog open={confirm} title={copy.confirmTitle} description={copy.confirmBody} confirmLabel={copy.install} tone="primary"
      onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void updater.install(); }} />
  </div>;
}
