import type { AppConfig, GpuPlacement, GpuDevice, SessionDefinition, SessionStatus } from "./api";

export const DEFAULT_SESSION_ID = "default";
export const SESSION_STATUS_CHANGED_EVENT = "llama-board:session-status-changed";

export function notifySessionStatusChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));
}

export function emptyGpuPlacement(): GpuPlacement {
  return { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null };
}

export function cloneGpuPlacement(value: GpuPlacement | null | undefined): GpuPlacement {
  return {
    gpu_ids: [...(value?.gpu_ids ?? [])],
    main_gpu: value?.main_gpu ?? null,
    split_mode: value?.split_mode ?? "none",
    tensor_split: [...(value?.tensor_split ?? [])],
    draft_gpu_id: value?.draft_gpu_id ?? null,
  };
}

export function defaultSessionDefinition(cfg: AppConfig): SessionDefinition {
  return {
    id: `session-${Date.now().toString(36)}`,
    name: "",
    models: { primary_model: cfg.active_model ?? "", mmproj: cfg.mmproj ?? "", draft_model: cfg.spec_draft_model ?? "" },
    gpu: cloneGpuPlacement(cfg.gpu),
    enabled: true,
  };
}

export function sessionPort(status: Pick<SessionStatus, "port" | "url"> | null | undefined, fallback = 0): number {
  if (typeof status?.port === "number" && status.port > 0) return status.port;
  const match = status?.url?.match(/:(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : fallback;
}

export function missingGpuIds(placement: GpuPlacement | null | undefined, devices: GpuDevice[]): string[] {
  const ids = new Set(devices.map((device) => device.stable_id).filter((id): id is string => Boolean(id)));
  return [...new Set([...(placement?.gpu_ids ?? []), placement?.main_gpu, placement?.draft_gpu_id].filter((id): id is string => Boolean(id)))].filter((id) => !ids.has(id));
}

export function gpuDeviceLabel(device: GpuDevice, index: number): string {
  if (device.stable_id?.startsWith("runtime:")) return device.name;
  const identity = device.stable_id ? ` · ${device.stable_id}` : "";
  return `GPU ${index} · ${device.name}${identity}`;
}

/** Runtime indices are explicit choices, not unverified physical-card identities. */
export function runtimeGpuDevices(backend: string, lines: string[]): GpuDevice[] {
  const prefix = ({ rocm: "ROCm", cuda: "CUDA", vulkan: "Vulkan", sycl: "SYCL" } as Record<string, string>)[backend];
  if (!prefix) return [];
  const seen = new Set<string>();
  return lines.flatMap((line) => {
    const match = line.trim().match(new RegExp(`^(${prefix}\\d+):\\s*(.+)$`));
    if (!match || seen.has(match[1])) return [];
    seen.add(match[1]);
    const vendor = backend === "rocm" ? "amd" : backend === "cuda" ? "nvidia" : backend === "sycl" ? "intel" : "unknown";
    return [{ name: `${match[1]} · ${match[2]}`, stable_id: `runtime:${backend}:${match[1]}`, vendor, integrated: false } as GpuDevice];
  });
}

export function toggleGpuSelection(placement: GpuPlacement, id: string, devices: GpuDevice[]): GpuPlacement {
  const available = new Set(devices.map((device) => device.stable_id));
  const retained = placement.gpu_ids.filter((value) => available.has(value));
  const gpu_ids = retained.includes(id) ? retained.filter((value) => value !== id) : [...retained, id];
  return { ...placement, gpu_ids, tensor_split: [],
    main_gpu: placement.main_gpu && gpu_ids.includes(placement.main_gpu) ? placement.main_gpu : null,
    draft_gpu_id: placement.draft_gpu_id && available.has(placement.draft_gpu_id) ? placement.draft_gpu_id : null,
  };
}

export function parseTensorSplit(value: string, expectedCount: number): number[] | null {
  if (!value.trim()) return [];
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  const values = parts.map(Number);
  if (values.some((number) => !Number.isFinite(number) || number < 0)) return null;
  if (expectedCount > 1 && values.length !== expectedCount) return null;
  return values;
}

export function gpuTensorSplitDrafts(placement: GpuPlacement): Record<string, string> {
  return Object.fromEntries(placement.gpu_ids.map((id, index) => [id, String(placement.tensor_split[index] ?? 1)]));
}

export function parseGpuTensorSplits(drafts: Record<string, string>, gpuIds: string[]): number[] | null {
  if (gpuIds.length < 2) return [];
  const values = gpuIds.map((id) => Number(drafts[id]?.trim()));
  return values.some((value, index) => !drafts[gpuIds[index]]?.trim() || !Number.isFinite(value) || value < 0)
    ? null
    : values;
}

export function sessionConfig(cfg: AppConfig, definition: SessionDefinition): AppConfig {
  return {
    ...cfg,
    active_model: definition.models.primary_model,
    mmproj: definition.models.mmproj,
    spec_draft_model: definition.models.draft_model,
    gpu: cloneGpuPlacement(definition.gpu),
  };
}

export function sessionStatusLabel(state: SessionStatus["state"]): "running" | "starting" | "stopped" | "crashed" | "failed" | "stopping" {
  if (state === "running") return "running";
  if (state === "starting") return "starting";
  if (state === "crashed") return "crashed";
  if (state === "failed") return "failed";
  if (state === "stopping") return "stopping";
  return "stopped";
}
