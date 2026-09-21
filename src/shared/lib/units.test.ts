import { describe, expect, it } from "vitest";
import { formatBytes, formatCpuCores, formatMebibytes, formatSpeedBps } from "./units";

describe("display units", () => {
  it("labels byte quantities with the binary units they are actually counted in", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(formatBytes(1024 ** 3)).toBe("1.00 GiB");
    expect(formatBytes(1024 ** 4)).toBe("1.00 TiB");
    // Beyond the last unit the value keeps growing rather than rolling over.
    expect(formatBytes(2048 * 1024 ** 4)).toBe("2048.00 TiB");
  });

  it("refuses to invent a size it was not given", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(-1)).toBe("unknown size");
    expect(formatSpeedBps(Number.POSITIVE_INFINITY)).toBe("unknown speed");
    expect(formatMebibytes(Number.NaN)).toBe("unknown size");
  });

  it("scales the backend's mebibyte counts back to exact byte quantities", () => {
    expect(formatMebibytes(1)).toBe("1.0 MiB");
    expect(formatMebibytes(1024)).toBe("1.00 GiB");
    expect(formatMebibytes(8192)).toBe("8.00 GiB");
  });

  it("appends a rate to the same byte ladder", () => {
    expect(formatSpeedBps(1536)).toBe("1.5 KiB/s");
    expect(formatSpeedBps(0)).toBe("0 B/s");
  });

  it("only calls cores cores when the core count was actually reported", () => {
    expect(formatCpuCores({ logical_cores: 16, physical_cores: 8 })).toBe("8 Core / 16 Thread");
    expect(formatCpuCores({ logical_cores: 16 })).toBe("16 Thread");
    expect(formatCpuCores({ logical_cores: 16, physical_cores: null })).toBe("16 Thread");
    expect(formatCpuCores({ logical_cores: 16, physical_cores: 0 })).toBe("16 Thread");
    // A processor without simultaneous multithreading still reports both.
    expect(formatCpuCores({ logical_cores: 8, physical_cores: 8 })).toBe("8 Core / 8 Thread");
  });
});
