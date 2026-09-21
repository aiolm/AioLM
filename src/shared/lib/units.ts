/**
 * Unit formatting for every user-visible quantity in the desktop UI.
 *
 * Byte counts here are always binary: the runtime, the model scanner and the
 * download stream all divide by 1024, so the labels are the binary ones and a
 * displayed number always means what its label says. The decimal SI labels the
 * UI used before named a different quantity than the one they were printed on.
 */

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
/** Decimals per unit: whole bytes, then enough precision to stay readable. */
const BINARY_DECIMALS = [0, 1, 1, 2, 2] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(BINARY_DECIMALS[unit])} ${BINARY_UNITS[unit]}`;
}

/**
 * Format a count the backend already reports in mebibytes. Model sizes, VRAM
 * and the memory estimate are all `len() / 1024 / 1024`, so they scale back to
 * bytes exactly and print with the same ladder as every other byte quantity.
 */
export function formatMebibytes(mebibytes: number): string {
  return formatBytes(mebibytes * 1024 * 1024);
}

export function formatSpeedBps(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "unknown speed";
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

/**
 * `8 Core / 16 Thread`, or `16 Thread` alone when the physical core count was
 * not detected. Hardware detection only reports logical processors on some
 * platforms, and calling those "cores" overstates the machine, so the physical
 * half is omitted rather than guessed.
 */
export function formatCpuCores(cpu: { logical_cores: number; physical_cores?: number | null }): string {
  const threads = `${cpu.logical_cores} Thread`;
  const physical = cpu.physical_cores;
  return typeof physical === "number" && Number.isFinite(physical) && physical > 0
    ? `${physical} Core / ${threads}`
    : threads;
}
