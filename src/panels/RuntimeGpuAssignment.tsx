import { useEffect, useRef, useState } from "react";
import type * as api from "../api";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { cloneGpuPlacement, gpuDeviceLabel, gpuTensorSplitDrafts, parseGpuTensorSplits, toggleGpuSelection, missingGpuIds } from "../sessionUtils";

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
    <section className="mb-4 rounded-xl border p-4" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }} aria-labelledby="gpu-assignment-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="gpu-assignment-heading" className="app-section-title">{t("ui.gpuAssignment")}</h2>
          <p className="app-section-hint">{t("ui.gpuRuntimeIdentityHint")}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2"><span className="text-xs" style={{ color: "var(--board-faint)" }}>{t("ui.gpuDefaultScope")}</span><span className="app-status-badge">{dirty ? t("ui.gpuUnsaved") : t("ui.gpuSelectedCount", { count: selected.length })}</span></div>
      </div>
      {error && <div className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--tone-error-border)", background: "var(--tone-error-bg)", color: "var(--tone-error-ink)" }} role="alert">{error}</div>}
      {conflict && <div className="mt-3 text-sm" role="status">{t("ui.gpuExternalChange")}</div>}
      {missingGpuIds(draft, gpus).length > 0 && <p className="mt-3 text-sm" role="status">{t("ui.gpuMissingWarning")}</p>}
      {gpus.length === 0 ? <p className="mt-3 text-sm" style={{ color: "var(--board-faint)" }}>{t("ui.gpuNoDetected")}</p> : (
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {gpus.map((gpu, index) => (
            <label key={gpu.stable_id} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3" style={{ borderColor: selected.includes(gpu.stable_id) ? "var(--board-accent)" : "var(--board-border)" }}>
              <input type="checkbox" checked={selected.includes(gpu.stable_id)} disabled={disabled} onChange={() => toggle(gpu.stable_id)} className="mt-1" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium" style={{ color: "var(--board-ink)" }}>{gpuDeviceLabel(gpu, index)}</span>
                <span className="block text-xs" style={{ color: "var(--board-faint)" }}>{gpu.vram_mb ? `${gpu.vram_mb.toLocaleString()} MiB / ` : ""}{gpu.integrated ? "integrated / " : ""}{t("ui.gpuStableId")}: {gpu.stable_id}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm" style={{ color: "var(--board-muted)" }}>{t("ui.gpuMain")}
          <select className="app-input mt-1 w-full" value={draft.main_gpu ?? ""} disabled={disabled || selected.length === 0} onChange={(event) => setDraft((current) => ({ ...current, main_gpu: event.target.value || null }))}>
            <option value="">{t("ui.gpuAny")}</option>
            {gpus.filter((gpu) => selected.includes(gpu.stable_id)).map((gpu) => <option key={gpu.stable_id} value={gpu.stable_id}>{gpuDeviceLabel(gpu, gpus.indexOf(gpu))}</option>)}
          </select>
        </label>
        <label className="text-sm" style={{ color: "var(--board-muted)" }}>{t("ui.gpuDraft")}
          <select className="app-input mt-1 w-full" value={draft.draft_gpu_id ?? ""} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, draft_gpu_id: event.target.value || null }))}>
            <option value="">{t("ui.gpuAny")}</option>
            {gpus.map((gpu, index) => <option key={gpu.stable_id} value={gpu.stable_id}>{gpuDeviceLabel(gpu, index)}</option>)}
          </select>
        </label>
        <label className="text-sm" style={{ color: "var(--board-muted)" }}>{t("ui.gpuSplitMode")}
          <select className="app-input mt-1 w-full" value={draft.split_mode} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, split_mode: event.target.value as api.SplitMode }))}>
            <option value="none">{t("ui.gpuSplitNone")}</option>
            <option value="layer">{t("ui.gpuSplitLayer")}</option>
            <option value="row">{t("ui.gpuSplitRow")}</option>
          </select>
        </label>
        <fieldset className="min-w-0 text-sm" disabled={disabled || selected.length < 2}>
          <legend style={{ color: "var(--board-muted)" }}>{t("ui.gpuTensorSplit")}</legend>
          <label className="mt-1 flex items-center gap-2 text-xs" style={{ color: "var(--board-muted)" }}><input type="checkbox" checked={customSplit} onChange={(event) => setCustomSplit(event.target.checked)} />{t("ui.gpuCustomTensorSplit")}</label>
          {customSplit && <div className="mt-2 grid gap-2">
            {selected.map((id) => {
              const gpu = gpus.find((item) => item.stable_id === id);
              return <label key={id} className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 text-xs" style={{ color: "var(--board-faint)" }}><span className="truncate">{gpu ? gpuDeviceLabel(gpu, gpus.indexOf(gpu)) : id}</span><input aria-label={`${t("ui.gpuTensorSplit")} ${id}`} className="app-input w-full font-mono" inputMode="decimal" value={splitDrafts[id] ?? "1"} onChange={(event) => setSplitDrafts((current) => ({ ...current, [id]: event.target.value }))} /></label>;
            })}
          </div>}
          {customSplit && <span className="mt-1 block text-xs" style={{ color: "var(--board-faint)" }}>{t("ui.gpuTensorSplitHint")}</span>}
        </fieldset>
      </div>
      <div className="mt-4 flex justify-end"><button type="button" className="app-button app-button--primary" disabled={disabled || !dirty} onClick={() => void save()}>{t("panel.save")}</button></div>
    </section>
  );
}
