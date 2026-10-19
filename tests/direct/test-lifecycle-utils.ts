import assert from "node:assert/strict";
import { classifyLifecycleError, isLifecycleCancellation, isServerBusy, isServerRunning, lifecycleErrorMessage, nextPollDelay, shouldPoll } from "../../src/shared/lib/serverLifecycle.ts";
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
const parserFailure = "server exited before ready (1). importing.py: Triton not installed. model /synthetic/model. setup_server(args, reuse_port=False)\nKeyError: invalid tool call parser: Hermes (chose from { hermes })";
assert.equal(classifyLifecycleError(parserFailure), "unknown", "parser rejection must not be mistaken for a conflicting port or invalid model");
assert.match(lifecycleErrorMessage("start", parserFailure), /Open diagnostics/);
assert.equal(classifyLifecycleError("server exited before ready. importing.py: use_fast deprecated"), "unknown");
for (const detail of ["listen EADDRINUSE", "port 8080 is already in use", "unable to bind to 127.0.0.1:8080"]) {
  assert.equal(classifyLifecycleError(detail), "port", detail);
}
for (const [action, detail] of [
  ["start", "finish or stop the active response in session 'default' before loading a model"],
  ["start", "finish or stop the active response before replacing this model"],
  ["stop", "finish or stop the active response before unloading this model"],
  ["start", "finish or stop the active response in session 'synthetic-timeout-memory-port' before loading a model"],
] as const) {
  for (const error of [detail, new Error(detail)]) {
    assert.equal(classifyLifecycleError(error), "active-response", detail);
    const message = lifecycleErrorMessage(action, error);
    assert.ok(message.startsWith(action === "start" ? "Model load failed:" : "Model unload failed:"));
    assert.ok(message.includes("Finish or stop the active response, then try again."));
    assert.ok(message.endsWith(` (${detail})`), "the lifecycle guard must retain its original detail");
    assert.doesNotMatch(message, /model path|file integrity|could not be loaded/i);
  }
}
for (const [detail, kind, hint] of [
  ["startup timeout", "timeout", "The operation timed out."],
  ["port bind failed", "port", "The configured port is already in use."],
  ["runtime executable not found", "executable", "The runtime executable could not be found."],
  ["invalid model file", "model", "Check the model path and file integrity."],
  ["out of memory", "memory", "There is not enough available memory or VRAM"],
  ["server exited before ready (1)", "unknown", "Open diagnostics for the runtime log"],
] as const) {
  assert.equal(classifyLifecycleError(detail), kind);
  assert.ok(lifecycleErrorMessage("start", detail).includes(hint));
}
for (const detail of [
  'server exited before ready (1). File "/synthetic/runtime/loader.py": ValueError: To serve at least one request with the model max seq len, 2.0 GiB KV cache is needed, which is larger than the available KV cache memory (1.0 GiB).',
  'Model load failed: CUDA out of memory during startup timeout. File "/synthetic/runtime/model.py"',
  'Model loader: ValueError: No available memory for the cache blocks.',
]) {
  assert.equal(classifyLifecycleError(detail), "memory", "explicit allocation failures take precedence over model/traceback and startup wrapper text");
  const message = lifecycleErrorMessage("start", detail);
  assert.match(message, /There is not enough available memory or VRAM/);
  assert.doesNotMatch(message, /model path|file integrity/);
  assert.ok(message.endsWith(` (${detail})`), "the runtime allocation failure remains available in diagnostics");
}
assert.equal(classifyLifecycleError('invalid model file; inspect /synthetic/memory/loader.py'), "model");
assert.equal(isLifecycleCancellation(new Error("server start cancelled")), true);
assert.equal(isLifecycleCancellation(new Error("server failed to load")), false);
assert.equal(nextPollDelay(1000, 0), 1000);
assert.equal(nextPollDelay(1000, 5), 10000);
assert.equal(shouldPoll("hidden"), false);
assert.equal(shouldPoll("visible"), true);
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
console.log("lifecycle utility tests passed");
