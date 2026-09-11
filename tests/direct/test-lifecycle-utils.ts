import assert from "node:assert/strict";
import { BENCHMARK_RECORD_SCHEMA, benchmarkCsv, benchmarkMetrics } from "../../src/features/bench/benchmarkRecords.ts";
import { classifyLifecycleError, isLifecycleCancellation, isServerBusy, isServerRunning, lifecycleErrorMessage, nextPollDelay, shouldPoll } from "../../src/shared/lib/serverLifecycle.ts";
import { configExport, parseConfigExport } from "../../src/shared/lib/exports.ts";
import { deriveTokensPerSecond } from "../../src/shared/lib/metrics.ts";
import { normalizeDisplayPath, normalizeDisplayPathLines, normalizeDisplayText } from "../../src/shared/lib/displayPaths.ts";

assert.equal(isServerRunning("running"), true);
for (const state of ["starting", "stopping", "stopped", "failed", "crashed", ""]) {
  assert.equal(isServerRunning(state), false, `isServerRunning("${state}") should be false`);
}
for (const state of ["running", "starting", "stopping"]) {
  assert.equal(isServerBusy(state), true, `isServerBusy("${state}") should be true`);
}
for (const state of ["stopped", "failed", "crashed", ""]) {
  assert.equal(isServerBusy(state), false, `isServerBusy("${state}") should be false`);
}

assert.equal(classifyLifecycleError(new Error("address already in use")), "port");
assert.equal(classifyLifecycleError(new Error("out of memory")), "memory");
assert.equal(classifyLifecycleError(new Error("startup timeout")), "timeout");
assert.match(lifecycleErrorMessage("start", new Error("port bind failed")), /port/i);
assert.equal(isLifecycleCancellation(new Error("server start cancelled")), true);
assert.equal(isLifecycleCancellation(new Error("server failed to load")), false);
assert.equal(nextPollDelay(1000, 0), 1000);
assert.equal(nextPollDelay(1000, 5), 10000);
assert.equal(shouldPoll("hidden"), false);
assert.equal(shouldPoll("visible"), true);
assert.equal(deriveTokensPerSecond(100, 2000), 50);
assert.equal(normalizeDisplayPath("\\\\?\\C:\\models\\model.gguf"), "C:\\models\\model.gguf");
assert.equal(normalizeDisplayPath("\\\\?\\UNC\\server\\share\\model.gguf"), "\\\\server\\share\\model.gguf");
assert.equal(normalizeDisplayText("--model=\\\\?\\C:\\models\\model.gguf"), "--model=C:\\models\\model.gguf");
assert.equal(normalizeDisplayPathLines("--model\n\\\\?\\C:\\models\\model.gguf"), "--model\nC:\\models\\model.gguf");
for (const [raw, display] of [
  [String.raw`\\?\C:\models\model.gguf`, String.raw`C:\models\model.gguf`],
  [String.raw`\\?\UNC\server\share\model.gguf`, String.raw`\\server\share\model.gguf`],
  [String.raw`\\?\unc\server\share\model.gguf`, String.raw`\\server\share\model.gguf`],
]) {
  const diagnostic = { path: raw, error: `Could not load ${raw}` };
  const normalized = normalizeDisplayText(JSON.stringify(diagnostic, null, 2));
  assert.deepEqual(JSON.parse(normalized), { path: display, error: `Could not load ${display}` });
  assert.equal(normalizeDisplayText(normalized), normalized);
  assert.equal(diagnostic.path, raw);
}
assert.equal(normalizeDisplayText("  ordinary text\nC:\\models\\a.gguf  "), "  ordinary text\nC:\\models\\a.gguf  ");
const exported = configExport({ theme: "dark" });
assert.deepEqual(parseConfigExport<typeof exported.preferences>(JSON.stringify(exported)), { theme: "dark" });
const csv = benchmarkCsv([{
  schemaVersion: BENCHMARK_RECORD_SCHEMA, id: "x", fingerprint: "f", createdAt: 0,
  model: "m", backend: "b", build: "v", ctx: 1, ngl: 2, threads: 3, parallel: 1, iters: 2,
  device: { fingerprint: "dev", os: "windows", arch: "x86_64", cpu: "CPU", cpuThreads: 8, gpu: "GPU", gpuVendor: "amd", gpuVramMb: 16384 },
  rows: benchmarkMetrics([{ test: "tg", size: "1", batch: "2", tps: 3 }]),
}]);
assert.match(csv, /^createdAt,fingerprint,deviceFingerprint/);
assert.match(csv, /"dev".*"GPU".*"tg".*"3","tok\/s"/);
assert.doesNotMatch(csv, /undefined/);
console.log("lifecycle utility tests passed");
