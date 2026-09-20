/** Byte and transfer-rate formatting shared by every panel that moves files. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatSpeedBps(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "unknown speed";
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

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
