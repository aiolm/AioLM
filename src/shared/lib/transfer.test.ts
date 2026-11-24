import { describe, expect, it } from "vitest";
import { appendDownloadSample, estimateDownloadSpeed, type DownloadSample } from "./transfer";

describe("download transfer speed sampling", () => {
  it("retains an older anchor through high-frequency bursts so speed does not drop to null", () => {
    let samples: DownloadSample[] = [];
    for (let i = 0; i < 60; i += 1) {
      samples = appendDownloadSample(samples, i * 1024 * 64, 1000 + i * 25);
    }
    const speed = estimateDownloadSpeed(samples);
    expect(speed).not.toBeNull();
    // 59 * 64 KiB over 59 * 25 ms = 2,560 KiB/s
    expect(speed).toBeCloseTo((59 * 1024 * 64) / 1.475, 1);
  });

  it("falls back to the most recent anchor beyond windowMs after a pause without losing speed", () => {
    let samples: DownloadSample[] = [
      { received: 0, at: 1000 },
      { received: 10 * 1024 * 1024, at: 5000 },
    ];
    // Next chunk arrives 100ms after the resume after a >3s gap.
    samples = appendDownloadSample(samples, 10 * 1024 * 1024 + 512 * 1024, 5100);
    const speed = estimateDownloadSpeed(samples);
    expect(speed).not.toBeNull();
    expect(speed).toBeGreaterThan(0);
  });

  it("restarts sampling cleanly if byte count resets and reports 0 B/s during temporary stalls", () => {
    let samples: DownloadSample[] = [
      { received: 2048, at: 1000 },
      { received: 4096, at: 2000 },
    ];
    samples = appendDownloadSample(samples, 512, 2500);
    expect(samples).toEqual([{ received: 512, at: 2500 }]);
    expect(estimateDownloadSpeed(samples)).toBeNull();

    samples = appendDownloadSample(samples, 512, 3200);
    expect(estimateDownloadSpeed(samples)).toBe(0);
  });
});
