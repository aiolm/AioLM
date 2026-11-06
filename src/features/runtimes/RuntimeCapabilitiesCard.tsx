import StatusBadge from "../../shared/ui/StatusBadge";
import type * as api from "../../shared/api/types";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { countRuntimeDeviceEntries, formatRecordedRuntimeVersion } from "../../shared/runtime/runtimeUtils";
import type { Locale } from '../../shared/i18n/i18n';
import { capabilityStateText } from '../../shared/i18n/statusDisplayCopy';
import { useRuntimeVersionLabel } from "../../shared/runtime/installedRuntimes";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";

interface Props {
  locale?: Locale;
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  capabilities: api.RuntimeCapabilities | null;
  /** The build the shown capabilities describe. Probing belongs to its build row. */
  probeTarget: { backend: string; build: string } | null;
}

export default function RuntimeCapabilitiesCard({ t, locale = 'en', capabilities, probeTarget }: Props) {
  const displayFlags = normalizeDisplayText(capabilities?.flags.join(", ") ?? "");
  const displayDevices = normalizeDisplayText(capabilities?.devices.join(" · ") ?? "");
  const targetVersion = useRuntimeVersionLabel(probeTarget?.backend ?? "", probeTarget?.build ?? "");
  // The probe names the binary it just ran; its raw banner stays in the probe result, not the label.
  const probedVersion = capabilities ? normalizeDisplayText(formatRecordedRuntimeVersion(capabilities.version, capabilities.build, t("ui.notReported"))) : "";
  return (
    <section className="app-card runtime-tool runtime-capabilities-card" aria-labelledby="runtime-capabilities-heading">
      <div className="runtime-tool__header">
        <h3 id="runtime-capabilities-heading" className="runtime-tool__title">{t("section.runtimes")}</h3>
        <p className="app-section-hint">{t("ui.probeHint")}</p>
      </div>
      <p className="runtime-tool__meta">{probeTarget ? t("ui.probeTarget", { backend: probeTarget.backend, build: targetVersion }) : t("ui.probeChooseBuild")}</p>
      {capabilities && (
        <dl className="runtime-facts">
          <div><dt>{t("ui.probeState")}</dt><dd><StatusBadge label={capabilityStateText(capabilities.state, locale)} tone={capabilities.state === "available" ? "success" : "warning"} /><span className="runtime-facts__detail runtime-number">{capabilities.backend} · {probedVersion}</span></dd></div>
          <div><dt>{t("ui.probeVersion")}</dt><dd className="runtime-number">{probedVersion}</dd></div>
          <div><dt>{t("ui.probeFlags")}</dt><dd>{t("ui.flagsDiscovered", { count: capabilities.flags.length })}<span className="runtime-facts__detail runtime-facts__code">{displayFlags || t("ui.none")}</span></dd></div>
          <div><dt>{t("ui.probeDevices")}</dt><dd>{t("ui.devicesVisible", { count: countRuntimeDeviceEntries(capabilities.devices) })}<span className="runtime-facts__detail" title={displayDevices}>{displayDevices || t("ui.noDevicesReported")}</span></dd></div>
          <div><dt>{t("ui.probeBench")}</dt><dd><StatusBadge label={capabilities.bench_available ? t("ui.benchAvailable") : t("ui.benchMissing")} tone={capabilities.bench_available ? "success" : "warning"} /><span className="runtime-facts__detail">llama-bench --help</span></dd></div>
        </dl>
      )}
      {capabilities?.diagnostics.length ? <details className="runtime-tool__diagnostics"><summary>{t("ui.diagnosticsCount", { count: capabilities.diagnostics.length })}</summary><pre className="runtime-tool__pre">{normalizeDisplayText(capabilities.diagnostics.join("\n"))}</pre></details> : null}
    </section>
  );
}
