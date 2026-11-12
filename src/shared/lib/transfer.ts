/** Transfer-rate sampling shared by every panel that moves files. */
export interface DownloadSample {
  received: number;
  at: number;
}

/** Sliding-window speed over recent progress samples. Null while undetermined. */
export function estimateDownloadSpeed(
  samples: readonly DownloadSample[],
  windowMs = 3000,
  minWindowMs = 500,
): number | null {
  if (samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  let earliest = samples[0];
  if (!latest || !earliest) return null;
  const cutoff = latest.at - windowMs;
  for (const sample of samples) {
    if (sample.at >= cutoff) {
      earliest = sample;
      break;
    }
    earliest = sample;
  }
  const elapsedMs = latest.at - earliest.at;
  if (elapsedMs < minWindowMs) return null;
  const deltaBytes = latest.received - earliest.received;
  if (!Number.isFinite(deltaBytes) || deltaBytes < 0) return null;
  return (deltaBytes / elapsedMs) * 1000;
}

/** Seconds until `total` at `speedBps`, or null while the rate or size is unknown. */
export function estimateRemainingSeconds(received: number, total: number, speedBps: number | null | undefined): number | null {
  if (!speedBps || speedBps <= 0 || !Number.isFinite(speedBps) || !(total > 0) || received < 0) return null;
  return Math.max(0, total - received) / speedBps;
}
