export function benchmarkFingerprint(value: { model: string; backend: string; build: string; ctx: number; ngl: number; threads: number; parallel: number; iters: number; runtimeDefaults?: string[] }): string {
  const base = [value.model, value.backend, value.build, value.ctx, value.ngl, value.threads, value.parallel, value.iters].join("|");
  return value.runtimeDefaults?.length ? `${base}|defaults=${[...value.runtimeDefaults].sort().join(",")}` : base;
}

/** Bump when a stored record's shape changes; readers drop older envelopes. */
export const BENCHMARK_RECORD_SCHEMA = 1;

/**
 * The device a run happened on, denormalized into the record so an exported or
 * uploaded result stands on its own. `fingerprint` is the device-class key a
 * benchmark service groups by; it carries nothing that identifies the owner.
 */
export interface BenchmarkDevice {
  fingerprint: string;
  os: string;
  arch: string;
  cpu: string;
  cpuThreads: number;
  gpu?: string;
  gpuVendor?: string;
  gpuVramMb?: number;
}

/**
 * One measurement from a run. llama-bench already emits several per run
 * (`pp512`, `tg128`, …); `test` names the workload and `unit` keeps the record
 * readable when metrics beyond tokens/s are added.
 */
export interface BenchmarkMetric {
  test: string;
  size: string;
  batch: string;
  value: number;
  unit: string;
}

export interface BenchmarkRecord {
  /** Numeric fields retain their saved manual values; these keys were inherited instead. */
  runtimeDefaults?: string[];
  schemaVersion: number;
  id: string;
  /** Configuration key used to spot reruns of the same setup. */
  fingerprint: string;
  createdAt: number;
  model: string;
  backend: string;
  build: string;
  runtimeVersion?: string;
  ctx: number;
  ngl: number;
  threads: number;
  parallel: number;
  iters: number;
  device?: BenchmarkDevice;
  rows: BenchmarkMetric[];
  /** Terminal state is optional so records written by older builds remain valid. */
  status?: "complete" | "partial" | "cancelled" | "crashed" | "failed";
  error?: string;
}

/** Normalizes llama-bench output into the stored metric shape. */
export function benchmarkMetrics(rows: Array<{ test: string; size: string; batch: string; tps: number }>): BenchmarkMetric[] {
  return rows.map((row) => ({ test: row.test, size: row.size, batch: row.batch, value: row.tps, unit: "tok/s" }));
}

const CSV_COLUMNS = [
  "createdAt", "fingerprint", "deviceFingerprint", "os", "arch", "cpu", "cpuThreads", "gpu", "gpuVendor", "gpuVramMb",
  "model", "backend", "build", "runtimeVersion", "ctx", "ngl", "threads", "parallel", "iters",
  "test", "size", "batch", "value", "unit",
] as const;

export function benchmarkCsv(records: BenchmarkRecord[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    for (const row of record.rows) {
      lines.push([
        new Date(record.createdAt).toISOString(), record.fingerprint,
        record.device?.fingerprint ?? "", record.device?.os ?? "", record.device?.arch ?? "",
        record.device?.cpu ?? "", record.device?.cpuThreads ?? "", record.device?.gpu ?? "",
        record.device?.gpuVendor ?? "", record.device?.gpuVramMb ?? "",
        record.model, record.backend, record.build, record.runtimeVersion ?? "",
        record.runtimeDefaults?.includes("ctx_size") ? "default" : record.ctx,
        record.runtimeDefaults?.includes("ngl") ? "default" : record.ngl,
        record.runtimeDefaults?.includes("threads") ? "default" : record.threads,
        record.runtimeDefaults?.includes("parallel") ? "default" : record.parallel, record.iters,
        row.test, row.size, row.batch, row.value, row.unit,
      ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}
