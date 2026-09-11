import StableLabel from "../components/StableLabel";
import type * as api from "../api";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { buildNumber, capabilityLabel } from "../runtimeUtils";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  capabilities: api.RuntimeCapabilities | null;
  probeBusy: boolean;
  serverRunning: boolean;
  activeBackend: string;
  activeBuild: string;
  onProbe: () => void;
}

export default function RuntimeCapabilitiesCard({ t, capabilities, probeBusy, serverRunning, activeBackend, activeBuild, onProbe }: Props) {
  return (
    <section className="runtime-capabilities-card mb-4 rounded-xl border p-4 ui-border-color-border ui-background-panel"  aria-labelledby="runtime-capabilities-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="runtime-capabilities-heading" className="app-section-title">{t("section.runtimes")}</h2>
          <p className="app-section-hint">{t("ui.probeHint")}</p>
        </div>
        <button type="button" onClick={onProbe} disabled={probeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeSelect") : undefined} className="app-button app-button--primary app-button--sm shrink-0"><StableLabel value={probeBusy ? t("ui.probing") : t("ui.probeRuntime")} labels={[t("ui.probing"), t("ui.probeRuntime")]} /></button>
      </div>
      {!capabilities && <p className="mt-3 text-xs ui-color-faint" >{activeBackend && activeBuild ? t("ui.probeReady", { backend: activeBackend, build: buildNumber(activeBuild) }) : t("ui.probeNoRuntime")}</p>}
      {capabilities && (
        <div className="mt-3.5 grid gap-2.5 app-summary-grid">
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeState")}</div><div className={["mt-1 text-xs font-semibold", (capabilities.state === "available" ? "ui-color-success" : "ui-color-warning")].filter(Boolean).join(" ")} >{capabilityLabel(capabilities.state)}</div><div className="mt-1 text-xs tabular-nums ui-color-faint" >{capabilities.backend} · {capabilities.build}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeVersion")}</div><div className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-xs ui-color-ink" >{capabilities.version || t("ui.notReported")}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeFlags")}</div><div className="mt-1 text-xs ui-color-ink" >{t("ui.flagsDiscovered", { count: capabilities.flags.length })}</div><div className="mt-1 app-text-wrap font-mono text-xs ui-color-faint"  title={capabilities.flags.join(", ")}>{capabilities.flags.join(", ") || t("ui.none")}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeDevices")}</div><div className="mt-1 text-xs ui-color-ink" >{t("ui.devicesVisible", { count: capabilities.devices.length })}</div><div className="mt-1 app-text-wrap text-xs ui-color-faint"  title={capabilities.devices.join(" · ")}>{capabilities.devices.join(" · ") || t("ui.noDevicesReported")}</div></div>
          <div className="rounded-lg border p-3 ui-border-color-border ui-background-mono-bg" ><div className="app-eyebrow">{t("ui.probeBench")}</div><div className={["mt-1 text-xs font-semibold", (capabilities.bench_available ? "ui-color-success" : "ui-color-warning")].filter(Boolean).join(" ")} >{capabilities.bench_available ? t("ui.benchAvailable") : t("ui.benchMissing")}</div><div className="mt-1 text-xs ui-color-faint" >llama-bench --help</div></div>
        </div>
      )}
      {capabilities?.diagnostics.length ? <details className="mt-3"><summary className="cursor-pointer text-xs ui-color-warning" >{t("ui.diagnosticsCount", { count: capabilities.diagnostics.length })}</summary><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-xs ui-background-mono-bg ui-color-faint" >{capabilities.diagnostics.join("\n")}</pre></details> : null}
    </section>
  );
}
