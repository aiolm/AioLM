import type * as api from "../../shared/api/types";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { formatCpuCores, formatMebibytes } from "../../shared/lib/units";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  device: api.DeviceReport | null;
  deviceSummary: string;
}

/** The detected hardware as label/value rows in the page's side column; the
 * column stacks above the runtime list on narrow windows. */
export default function RuntimeDeviceCard({ t, device, deviceSummary }: Props) {
  const gpu = device ? device.profile.gpus.find((item) => !item.integrated) ?? device.profile.gpus[0] : undefined;
  // The GPU name and its memory read as a value and a secondary line, like the
  // CPU and its cores; the summary text stays the value when memory is unknown.
  const gpuName = normalizeDisplayText(gpu?.vram_mb ? gpu.name : deviceSummary);
  const gpuDetail = gpu?.vram_mb ? formatMebibytes(gpu.vram_mb) : null;
  const cpu = device ? normalizeDisplayText(device.profile.cpu.name) : null;
  const cores = device ? formatCpuCores(device.profile.cpu) : null;
  const platform = device ? normalizeDisplayText(`${device.profile.os}/${device.profile.arch}`) : null;
  return (
    <section className="runtime-device-summary" aria-labelledby="detected-device-heading">
      <h2 id="detected-device-heading">{t("ui.detectedDevice")}</h2>
      <dl className="runtime-device-properties">
        <div><dt>GPU</dt><dd title={normalizeDisplayText(deviceSummary)}>{gpuName}{gpuDetail && <span className="runtime-device-detail">{gpuDetail}</span>}</dd></div>
        {cpu && <div><dt>CPU</dt><dd title={cpu}>{cpu}{cores && <span className="runtime-device-detail">{cores}</span>}</dd></div>}
        {platform && <div><dt>OS</dt><dd>{platform}</dd></div>}
      </dl>
    </section>
  );
}
