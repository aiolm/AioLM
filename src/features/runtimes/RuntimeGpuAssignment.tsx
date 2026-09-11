import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { useEffect, useRef, useState } from "react";
import type * as api from "../../shared/api/types";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import TuningOptionMetadata from '../tuning/TuningOptionMetadata';
import { cloneGpuPlacement, gpuDeviceLabel, gpuTensorSplitDrafts, parseGpuTensorSplits, toggleGpuSelection, missingGpuIds } from "../../shared/runtime/sessionUtils";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  device: api.DeviceReport | null;
  placement: api.GpuPlacement;
  disabled: boolean;
  onChange: (placement: api.GpuPlacement) => Promise<void>;
}

export default function RuntimeGpuAssignment({ t, device, placement, disabled, onChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => cloneGpuPlacement(placement));
  const [splitDrafts, setSplitDrafts] = useState(() => gpuTensorSplitDrafts(placement));
  const [customSplit, setCustomSplit] = useState(placement.tensor_split.length > 0);
  const gpus = (device?.profile.gpus ?? []).filter(
    (gpu): gpu is typeof gpu & { stable_id: string } => Boolean(gpu.stable_id),
  );
  const selected = draft.gpu_ids;
  const placementKey = JSON.stringify(placement);
  const [baselineKey, setBaselineKey] = useState(placementKey);
  const previousPlacementKey = useRef(placementKey);
  const baseline = JSON.parse(baselineKey) as api.GpuPlacement;
  const [conflict, setConflict] = useState(false);
  const parsedSplit = customSplit ? parseGpuTensorSplits(splitDrafts, selected) : [];
  const dirty = parsedSplit === null
    || draft.main_gpu !== (baseline.main_gpu ?? null)
    || draft.draft_gpu_id !== (baseline.draft_gpu_id ?? null)
    || draft.split_mode !== baseline.split_mode
    || JSON.stringify(draft.gpu_ids) !== JSON.stringify(baseline.gpu_ids)
    || JSON.stringify(parsedSplit) !== JSON.stringify(baseline.tensor_split);

  useEffect(() => {
    if (previousPlacementKey.current === placementKey) return;
    previousPlacementKey.current = placementKey;
    if (dirty) { setConflict(true); return; }
    const saved = JSON.parse(placementKey) as api.GpuPlacement;
    setBaselineKey(placementKey);
    setDraft(cloneGpuPlacement(saved));
    setSplitDrafts(gpuTensorSplitDrafts(saved));
    setCustomSplit(saved.tensor_split.length > 0);
    setError(null);
  }, [placementKey, dirty]);

  const save = async () => {
    const tensorSplit = customSplit ? parseGpuTensorSplits(splitDrafts, selected) : [];
    if (tensorSplit === null) {
      setError(t("ui.gpuTensorSplitInvalid"));
      return;
    }
    setError(null);
    try {
      const saved = { ...draft, tensor_split: tensorSplit };
      await onChange(saved);
      setBaselineKey(JSON.stringify(saved));
      setConflict(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggle = (stableId: string) => {
    setDraft((current) => toggleGpuSelection(current, stableId, gpus));
    setSplitDrafts((current) => stableId in current ? current : { ...current, [stableId]: "1" });
  };

  return (
    <section className="mb-4 rounded-xl border p-4 ui-border-color-border ui-background-panel"  aria-labelledby="gpu-assignment-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="gpu-assignment-heading" className="app-section-title">{t("ui.gpuAssignment")}</h2>
          <p className="app-section-hint">{t("ui.gpuRuntimeIdentityHint")}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2"><span className="text-xs ui-color-faint" >{t("ui.gpuDefaultScope")}</span><span className="app-status-badge">{dirty ? t("ui.gpuUnsaved") : t("ui.gpuSelectedCount", { count: selected.length })}</span></div>
      </div>
      {error && <div className="mt-3 rounded-lg border px-3 py-2 text-sm ui-border-color-error-border ui-background-error-bg ui-color-error-ink"  role="alert">{normalizeDisplayText(error)}</div>}
      {conflict && <div className="mt-3 text-sm" role="status">{t("ui.gpuExternalChange")}</div>}
      {missingGpuIds(draft, gpus).length > 0 && <p className="mt-3 text-sm" role="status">{t("ui.gpuMissingWarning")}</p>}
      <TuningOptionMetadata fieldKey="raw-server:--device" />
      {gpus.length === 0 ? <p className="mt-3 text-sm ui-color-faint" >{t("ui.gpuNoDetected")}</p> : (
        <div className="mt-3 grid gap-2 app-form-grid">
          {gpus.map((gpu, index) => (
            <label key={gpu.stable_id} className={["flex cursor-pointer items-start gap-3 rounded-lg border p-3", (selected.includes(gpu.stable_id) ? "ui-border-color-accent" : "ui-border-color-border")].filter(Boolean).join(" ")} >
              <input type="checkbox" checked={selected.includes(gpu.stable_id)} disabled={disabled} onChange={() => toggle(gpu.stable_id)} className="mt-1" />
              <span className="min-w-0">
                <span className="block app-text-wrap text-sm font-medium ui-color-ink" >{gpuDeviceLabel(gpu, index)}</span>
                <span className="block text-xs ui-color-faint" >{gpu.vram_mb ? `${gpu.vram_mb.toLocaleString()} MiB / ` : ""}{gpu.integrated ? "integrated / " : ""}{t("ui.gpuStableId")}: {gpu.stable_id}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-4 grid gap-3 app-form-grid">
        <label className="text-sm ui-color-muted" >{t("ui.gpuMain")}
          <TuningOptionMetadata fieldKey="raw-server:--main-gpu" />
          <CustomSelect className="mt-1 w-full" ariaLabel={t("ui.gpuMain")} value={draft.main_gpu ?? ""} disabled={disabled || selected.length === 0} onChange={value => setDraft((current) => ({ ...current, main_gpu: value || null }))} options={[{ value: "", label: t("ui.gpuAny") }, ...gpus.filter(gpu => selected.includes(gpu.stable_id)).map(gpu => ({ value: gpu.stable_id ?? "", label: gpuDeviceLabel(gpu, gpus.indexOf(gpu)) }))]} />
        </label>
        <label className="text-sm ui-color-muted" >{t("ui.gpuDraft")}
          <TuningOptionMetadata fieldKey="spec_draft_device" />
          <CustomSelect className="mt-1 w-full" ariaLabel={t("ui.gpuDraft")} value={draft.draft_gpu_id ?? ""} disabled={disabled} onChange={value => setDraft((current) => ({ ...current, draft_gpu_id: value || null }))} options={[{ value: "", label: t("ui.gpuAny") }, ...gpus.map(gpu => ({ value: gpu.stable_id ?? "", label: gpuDeviceLabel(gpu, gpus.indexOf(gpu)) }))]} />
        </label>
        <label className="text-sm ui-color-muted" >{t("ui.gpuSplitMode")}
          <TuningOptionMetadata fieldKey="raw-server:--split-mode" />
          <CustomSelect className="mt-1 w-full" ariaLabel={t("ui.gpuSplitMode")} value={draft.split_mode} disabled={disabled} onChange={value => setDraft((current) => ({ ...current, split_mode: value as api.SplitMode }))} options={[{ value: "none", label: t("ui.gpuAny") }, { value: "single", label: t("ui.gpuSplitNone") }, { value: "layer", label: t("ui.gpuSplitLayer") }, { value: "row", label: t("ui.gpuSplitRow") }, { value: "tensor", label: "Tensor (experimental)" }]} />
        </label>
        <fieldset className="min-w-0 text-sm" disabled={disabled || selected.length < 2}>
          <legend className="ui-color-muted" >{t("ui.gpuTensorSplit")}</legend>
          <TuningOptionMetadata fieldKey="raw-server:--tensor-split" />
          <label className="mt-1 flex items-center gap-2 text-xs ui-color-muted" ><input type="checkbox" checked={customSplit} onChange={(event) => setCustomSplit(event.target.checked)} />{t("ui.gpuCustomTensorSplit")}</label>
          {customSplit && <div className="mt-2 grid gap-2">
            {selected.map((id) => {
              const gpu = gpus.find((item) => item.stable_id === id);
              return <label key={id} className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 text-xs ui-color-faint" ><span className="app-text-wrap">{gpu ? gpuDeviceLabel(gpu, gpus.indexOf(gpu)) : id}</span><input aria-label={`${t("ui.gpuTensorSplit")} ${id}`} className="app-input w-full font-mono" inputMode="decimal" value={splitDrafts[id] ?? "1"} onChange={(event) => setSplitDrafts((current) => ({ ...current, [id]: event.target.value }))} /></label>;
            })}
          </div>}
          {customSplit && <span className="mt-1 block text-xs ui-color-faint" >{t("ui.gpuTensorSplitHint")}</span>}
        </fieldset>
      </div>
      <div className="mt-4 flex justify-end"><button type="button" className="app-button app-button--primary" disabled={disabled || !dirty} onClick={() => void save()}>{t("panel.save")}</button></div>
    </section>
  );
}
