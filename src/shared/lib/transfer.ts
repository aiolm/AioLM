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
  const cutoff = latest.at - windowMs;
  let earliest = samples[0];
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
