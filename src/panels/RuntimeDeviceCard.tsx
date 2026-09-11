import StableLabel from "../components/StableLabel";
import type * as api from "../api";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  device: api.DeviceReport | null;
  deviceSummary: string;
  showAll: boolean;
  hiddenCount: number;
  onToggleShowAll: () => void;
}

export default function RuntimeDeviceCard({ t, device, deviceSummary, showAll, hiddenCount, onToggleShowAll }: Props) {
  return (
    <section className="runtime-detected-device mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ui-border-color-border ui-background-panel"  aria-labelledby="detected-device-heading">
      <div className="min-w-0">
        <h2 id="detected-device-heading" className="app-eyebrow">{t("ui.detectedDevice")}</h2>
        <div className="mt-1 min-w-0 app-text-wrap text-sm font-medium ui-color-ink"  title={deviceSummary}>{deviceSummary}</div>
        <div className="mt-0.5 min-w-0 app-text-wrap text-xs tabular-nums ui-color-faint"  title={device ? `${device.profile.cpu.name} · ${device.profile.cpu.logical_cores}T · ${device.profile.os}/${device.profile.arch}` : undefined}>
          {device ? `${device.profile.cpu.name} · ${device.profile.cpu.logical_cores}T · ${device.profile.os}/${device.profile.arch}` : "—"}
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
