/** Transfer-rate sampling shared by every panel that moves files. */
export interface DownloadSample {
  received: number;
  at: number;
}

/** Append a progress sample while keeping at least one anchor older than `windowMs`. */
export function appendDownloadSample(
  samples: readonly DownloadSample[],
  received: number,
  at: number,
  windowMs = 4000,
  maxSamples = 120,
): DownloadSample[] {
  if (!Number.isFinite(received) || received < 0 || !Number.isFinite(at)) {
    return [...samples];
  }
  const last = samples[samples.length - 1];
  if (last && received < last.received) {
    return [{ received, at }];
  }
  const next =
    last && at <= last.at
      ? [...samples.slice(0, -1), { received: Math.max(last.received, received), at: last.at }]
      : [...samples, { received, at }];
  const cutoff = at - windowMs;
  let keepFrom = 0;
  while (keepFrom + 1 < next.length && next[keepFrom + 1]!.at <= cutoff) {
    keepFrom += 1;
  }
  const pruned = keepFrom > 0 ? next.slice(keepFrom) : next;
  if (pruned.length <= maxSamples) return pruned;
  // Preserve the oldest anchor so rapid bursts never collapse elapsed time below minWindowMs.
  return [pruned[0]!, ...pruned.slice(-(maxSamples - 1))];
}

/** Sliding-window speed over recent progress samples. Null while undetermined. */
export function estimateDownloadSpeed(
  samples: readonly DownloadSample[],
  windowMs = 3000,
  minWindowMs = 500,
): number | null {
  if (samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  if (!latest) return null;
  const cutoff = latest.at - windowMs;
  let anchor: DownloadSample | undefined;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const sample = samples[index]!;
    if (sample.at >= cutoff && latest.at - sample.at >= minWindowMs) {
      anchor = sample;
      break;
    }
  }
  if (!anchor) {
    for (let index = samples.length - 2; index >= 0; index -= 1) {
      const sample = samples[index]!;
      if (latest.at - sample.at >= minWindowMs) {
        anchor = sample;
        break;
      }
    }
  }
  if (!anchor) return null;
  const elapsedMs = latest.at - anchor.at;
  if (elapsedMs < minWindowMs) return null;
  const deltaBytes = latest.received - anchor.received;
  if (!Number.isFinite(deltaBytes) || deltaBytes < 0) return null;
  return (deltaBytes / elapsedMs) * 1000;
}

/** Seconds until `total` at `speedBps`, or null while the rate or size is unknown. */
export function estimateRemainingSeconds(received: number, total: number, speedBps: number | null | undefined): number | null {
  if (!speedBps || speedBps <= 0 || !Number.isFinite(speedBps) || !(total > 0) || received < 0) return null;
  return Math.max(0, total - received) / speedBps;
}
