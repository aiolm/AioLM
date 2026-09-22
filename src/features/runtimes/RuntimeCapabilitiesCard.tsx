import StableLabel from "../../shared/ui/StableLabel";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import { DEEP_VERIFICATION_TASK } from "./useDeepVerification";
import type * as api from "../../shared/api/types";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { buildNumber, capabilityLabel } from "../../shared/runtime/runtimeUtils";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  capabilities: api.RuntimeCapabilities | null;
  probeBusy: boolean;
  runtimeBusy?: boolean;
  serverRunning: boolean;
  /** The build the shown capabilities describe, and the one a re-probe reads. */
  probeTarget: { backend: string; build: string } | null;
  onProbe: () => void;
  /** The opt-in deep check of this runtime against the selected model. */
  deepVerify?: { busy: boolean; record: { verdict: string; detail: string } | null; error: string | null; start: () => void; cancel: () => void };
}

export default function RuntimeCapabilitiesCard({ t, capabilities, probeBusy, runtimeBusy = false, serverRunning, probeTarget, onProbe, deepVerify }: Props) {
  const displayFlags = normalizeDisplayText(capabilities?.flags.join(", ") ?? "");
  const displayDevices = normalizeDisplayText(capabilities?.devices.join(" · ") ?? "");
  return (
    <section className="runtime-capabilities-card mb-4 app-card"  aria-labelledby="runtime-capabilities-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="runtime-capabilities-heading" className="app-section-title">{t("section.runtimes")}</h2>
          <p className="app-section-hint">{t("ui.probeHint")}</p>
        </div>
        <button type="button" onClick={onProbe} disabled={!probeTarget || probeBusy || runtimeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeSelect") : undefined} className="app-button app-button--primary app-button--sm shrink-0"><StableLabel value={probeBusy ? t("ui.probing") : t("ui.probeAgain")} labels={[t("ui.probing"), t("ui.probeAgain")]} /></button>
      </div>
      {deepVerify && <div className="runtime-deep-verify">
        <p className="app-section-hint">{t("ui.deepVerifyHint")}</p>
        <div className="runtime-deep-verify-actions">
          {deepVerify.busy
            ? <LocalTaskCancelButton taskId={DEEP_VERIFICATION_TASK} onClick={deepVerify.cancel} className="app-button app-button--danger app-button--sm">{t("common.cancel")}</LocalTaskCancelButton>
            : <button type="button" onClick={deepVerify.start} disabled={runtimeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeSelect") : undefined} className="app-button app-button--secondary app-button--sm">{t("ui.deepVerify")}</button>}
          {deepVerify.record && <span className={deepVerify.record.verdict === "pass" ? "app-status-badge app-status-badge--success" : "app-status-badge app-status-badge--danger"}>{t(deepVerify.record.verdict === "pass" ? "ui.deepVerifyPass" : "ui.deepVerifyFail")}</span>}
        </div>
        {deepVerify.record && <p className="app-section-hint">{normalizeDisplayText(deepVerify.record.detail)}</p>}
        {deepVerify.error && <p className="text-error" role="alert">{normalizeDisplayText(deepVerify.error)}</p>}
      </div>}
      <p className="mt-3 text-xs ui-color-faint" >{probeTarget ? t("ui.probeTarget", { backend: probeTarget.backend, build: buildNumber(probeTarget.build) }) : t("ui.probeChooseBuild")}</p>
      {capabilities && (
        <div className="mt-3.5 grid gap-2.5 app-summary-grid">
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeState")}</div><div className={["mt-1 text-xs font-semibold", (capabilities.state === "available" ? "ui-color-success" : "ui-color-warning")].filter(Boolean).join(" ")} >{capabilityLabel(capabilities.state)}</div><div className="mt-1 text-xs tabular-nums ui-color-faint" >{capabilities.backend} · {capabilities.build}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeVersion")}</div><div className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-xs ui-color-ink" >{normalizeDisplayText(capabilities.version || t("ui.notReported"))}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeFlags")}</div><div className="mt-1 text-xs ui-color-ink" >{t("ui.flagsDiscovered", { count: capabilities.flags.length })}</div><div className="mt-1 max-h-20 overflow-auto app-text-wrap font-mono text-xs ui-color-faint" >{displayFlags || t("ui.none")}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeDevices")}</div><div className="mt-1 text-xs ui-color-ink" >{t("ui.devicesVisible", { count: capabilities.devices.length })}</div><div className="mt-1 app-text-wrap text-xs ui-color-faint"  title={displayDevices}>{displayDevices || t("ui.noDevicesReported")}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeBench")}</div><div className={["mt-1 text-xs font-semibold", (capabilities.bench_available ? "ui-color-success" : "ui-color-warning")].filter(Boolean).join(" ")} >{capabilities.bench_available ? t("ui.benchAvailable") : t("ui.benchMissing")}</div><div className="mt-1 text-xs ui-color-faint" >llama-bench --help</div></div>
        </div>
      )}
      {capabilities?.diagnostics.length ? <details className="mt-3"><summary className="cursor-pointer text-xs ui-color-warning" >{t("ui.diagnosticsCount", { count: capabilities.diagnostics.length })}</summary><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-xs ui-background-mono-bg ui-color-faint" >{normalizeDisplayText(capabilities.diagnostics.join("\n"))}</pre></details> : null}
    </section>
  );
}
