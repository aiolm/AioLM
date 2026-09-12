import StableLabel from "../../shared/ui/StableLabel";
import type * as api from "../../shared/api/types";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  device: api.DeviceReport | null;
  deviceSummary: string;
  showAll: boolean;
  hiddenCount: number;
  onToggleShowAll: () => void;
}

export default function RuntimeDeviceCard({ t, device, deviceSummary, showAll, hiddenCount, onToggleShowAll }: Props) {
  const displayDevice = normalizeDisplayText(deviceSummary);
  const displayCpu = device ? normalizeDisplayText(`${device.profile.cpu.name} · ${device.profile.cpu.logical_cores}T · ${device.profile.os}/${device.profile.arch}`) : "—";
  return (
    <section className="runtime-detected-device mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ui-border-color-border ui-background-panel"  aria-labelledby="detected-device-heading">
      <div className="min-w-0">
        <h2 id="detected-device-heading" className="app-eyebrow">{t("ui.detectedDevice")}</h2>
        <div className="mt-1 min-w-0 app-text-wrap text-sm font-medium ui-color-ink"  title={displayDevice}>{displayDevice}</div>
        <div className="mt-0.5 min-w-0 app-text-wrap text-xs tabular-nums ui-color-faint"  title={device ? displayCpu : undefined}>
          {displayCpu}
        </div>
      </div>
      <div className="runtime-device-actions flex shrink-0 flex-wrap items-center gap-2">
        <span className={[`runtime-hidden-count text-xs ${!showAll && hiddenCount > 0 ? "" : "is-empty"}`, "ui-color-faint"].filter(Boolean).join(" ")} >{t("ui.hiddenBackends", { count: hiddenCount })}</span>
        <button type="button" aria-pressed={showAll} onClick={onToggleShowAll} className="app-button app-button--secondary runtime-show-all">
          <StableLabel value={showAll ? t("ui.showRecommendedOnly") : t("ui.showAllBackends")} labels={[t("ui.showRecommendedOnly"), t("ui.showAllBackends")]} />
        </button>
      </div>
    </section>
  );
}
