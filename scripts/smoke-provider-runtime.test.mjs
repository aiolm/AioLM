/* global process, Buffer, console, setTimeout, clearTimeout, AbortController, fetch */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import { readRuntimeAdapterStream, validateRuntimeAdapterCompletion, validateRuntimeAdapterRecovery } from "./runtime-adapter-stream.mjs";
import {
  CHECKS,
  STATUSES,
  assertEmbeddingsPresent,
  assertModelsAlias,
  assertStreamEvents,
  assertUsagePresent,
  cancelChatStreamAndRecover,
  createIsolatedHome,
  inspectModelInput,
  newChecks,
  parseArgs,
  platformAllowsEngine,
  readChatStream,
  runCli,
  runLive,
  sanitizeResultForFile,
  setCheck,
  summarize,
  validateProbeRecord,
} from "./smoke-provider-runtime.mjs";

function adapterStream(frames) {
  let read = 0, cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    pull(target) {
      if (read === frames.length) target.close();
      else target.enqueue(typeof frames[read] === 'string' ? encoder.encode(frames[read++]) : frames[read++]);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: { body }, observed: () => ({ read, cancelled }) };
}
const adapterFrame = (delta, finish_reason = undefined) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;

for (const field of ['reasoning_content', 'reasoning']) test(`registered adapter cancels on ${field} before final content`, async () => {
  const stream = adapterStream([adapterFrame({ [field]: 'planning' }), 'data: [DONE]\n\n']);
  const controller = new AbortController();
  const result = await readRuntimeAdapterStream(stream.response, { controller, cancel: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.streamAbortedAfterOutput, true);
  assert.equal(result.streamAbortedAfterContent, false);
  assert.equal(result.cancelledOn, 'reasoning');
  assert.equal(result.reasoningChars, 8);
  assert.equal(result.content, '');
  assert.deepEqual(stream.observed(), { read: 1, cancelled: true });
});

test('registered adapter keeps content cancellation evidence accurate', async () => {
  const stream = adapterStream([adapterFrame({ content: '1' }), 'data: [DONE]\n\n']);
  const controller = new AbortController();
  const result = await readRuntimeAdapterStream(stream.response, { controller, cancel: true });
  assert.equal(result.streamAbortedAfterOutput, true);
  assert.equal(result.streamAbortedAfterContent, true);
  assert.equal(result.cancelledOn, 'content');
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(stream.observed(), { read: 1, cancelled: true });
});

test('registered adapter rejects a cancellation that never reached generation output', async () => {
  const stream = adapterStream([adapterFrame({ role: 'assistant' }), 'data: [DONE]\n\n']);
  const controller = new AbortController();
  await assert.rejects(readRuntimeAdapterStream(stream.response, { controller, cancel: true }), /before cancellation/);
  assert.equal(controller.signal.aborted, false);
});

for (const terminal of [adapterFrame({ content: '5' }, 'stop'), adapterFrame({ content: '5' }) + 'data: [DONE]\n\n']) {
  test(`registered adapter refuses already completed cancellation (${terminal.includes('[DONE]') ? 'DONE' : 'finish reason'})`, async () => {
    const stream = adapterStream([terminal]);
    const controller = new AbortController();
    await assert.rejects(readRuntimeAdapterStream(stream.response, { controller, cancel: true }), /before cancellation/);
    assert.equal(controller.signal.aborted, false);
  });
}

test('registered adapter preserves malformed-stream failures during cancellation', async () => {
  const stream = adapterStream(['data: broken-json\n\n']);
  const controller = new AbortController();
  await assert.rejects(readRuntimeAdapterStream(stream.response, { controller, cancel: true }), /invalid SSE/);
  assert.equal(controller.signal.aborted, false);
});

test('registered adapter keeps reasoning separate from final text and usage', async () => {
  const encoded = new TextEncoder().encode(adapterFrame({ reasoning_content: 'planning' }) + adapterFrame({ content: '한글 5' }));
  const split = encoded.indexOf(0xed) + 1;
  assert.ok(split > 0);
  const usage = { prompt_tokens: 3, completion_tokens: 4 };
  const stream = adapterStream([encoded.slice(0, split), encoded.slice(split), `data: ${JSON.stringify({ usage, choices: [] })}`]);
  const result = await readRuntimeAdapterStream(stream.response, { controller: new AbortController() });
  assert.equal(result.content, '한글 5');
  assert.equal(result.reasoningChars, 8);
  assert.deepEqual(result.usage, usage);
});

test('registered adapter reasoning cancellation closes the actual HTTP stream and leaves the server usable', { timeout: 5000 }, async () => {
  let naturalEnd = false, prematureClose = false;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.end('ready'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    response.write(adapterFrame({ reasoning_content: 'planning' }));
    const fallback = setTimeout(() => { naturalEnd = true; response.end('data: [DONE]\n\n'); }, 500);
    response.on('close', () => { clearTimeout(fallback); prematureClose = !response.writableFinished; resolveClosed(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal, headers: { Connection: 'close' } });
    const result = await readRuntimeAdapterStream(response, { controller, cancel: true });
    await closed;
    assert.equal(result.cancelledOn, 'reasoning');
    assert.equal(controller.signal.aborted, true);
    assert.equal(prematureClose, true);
    assert.equal(naturalEnd, false);
    assert.equal(await (await fetch(`${url}/health`, { headers: { Connection: 'close' } })).text(), 'ready');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('provider acceptance cancels fast open output before natural completion and recovers with usage', { timeout: 3000 }, async () => {
  let naturalEnd = false, prematureClose = false, requests = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const payloads = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      payloads.push(JSON.parse(body));
      requests += 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      if (requests === 1) {
        response.write(adapterFrame({ content: '1' }));
        const fallback = setTimeout(() => { naturalEnd = true; response.end('data: [DONE]\n\n'); }, 100);
        response.on('close', () => {
          clearTimeout(fallback); prematureClose = !response.writableFinished; resolveClosed();
        });
      } else {
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await cancelChatStreamAndRecover(`http://127.0.0.1:${server.address().port}`, { max_tokens: 32 }, 1000);
    await closed;
    assert.equal(result.cancelled, true);
    assert.equal(result.sawData, true);
    assert.equal(result.completedEarly, false);
    assert.equal(prematureClose, true);
    assert.equal(naturalEnd, false);
    assert.deepEqual(result.after.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    assert.ok(payloads.every(payload => payload.stream_options.include_usage === true));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

async function withProviderCancellationServer(reply, check) {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => { requests += 1; reply(response, requests); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await check(`http://127.0.0.1:${server.address().port}`, () => requests);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function providerRecovery(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

async function cancellationWithinBound(operation) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('cancellation did not settle within the test bound')), 500);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

for (const field of ['reasoning_content', 'reasoning']) {
  test(`provider acceptance cancels on ${field} and closes the actual stream`, async () => {
    let prematureClose = false, naturalEnd = false;
    await withProviderCancellationServer((response, count) => {
      if (count !== 1) { providerRecovery(response); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      response.write(adapterFrame({ role: 'assistant' }) + adapterFrame({ [field]: 'planning' }));
      const fallback = setTimeout(() => { naturalEnd = true; response.end('data: [DONE]\n\n'); }, 100);
      response.on('close', () => { clearTimeout(fallback); prematureClose = !response.writableFinished; });
    }, async url => {
      const result = await cancelChatStreamAndRecover(url, { max_tokens: 32 }, 1000);
      assert.equal(result.cancelled, true);
      assert.equal(prematureClose, true);
      assert.equal(naturalEnd, false);
      assert.equal(result.after.usage.total_tokens, 2);
    });
  });
}

for (const [kind, frame, error] of [
  ['finish reason with content', adapterFrame({ content: '5' }, 'stop'), /before cancellation/],
  ['DONE in the same body chunk', adapterFrame({ content: '5' }) + 'data: [DONE]\n\n', /before cancellation/],
  ['role-only output', adapterFrame({ role: 'assistant' }) + 'data: [DONE]\n\n', /before cancellation/],
  ['empty output', '', /before cancellation/],
  ['malformed output', 'data: broken-json\n\n', /invalid SSE/],
]) {
  test(`provider acceptance rejects ${kind} as cancellation evidence`, async () => {
    await withProviderCancellationServer((response, count) => {
      if (count !== 1) { providerRecovery(response); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      response.end(frame);
    }, async (url, requests) => {
      await assert.rejects(cancelChatStreamAndRecover(url, {}, 1000), error);
      assert.equal(requests(), 1, 'failed cancellation must not be disguised by a successful follow-up');
    });
  });
}

test('provider acceptance preserves a stream read error before generation output', async () => {
  await withProviderCancellationServer((response, count) => {
    if (count !== 1) { providerRecovery(response); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    response.write(adapterFrame({ role: 'assistant' }));
    const failure = setTimeout(() => response.destroy(new Error('synthetic early stream failure')), 10);
    response.on('close', () => clearTimeout(failure));
  }, async (url, requests) => {
    await assert.rejects(cancelChatStreamAndRecover(url, {}, 1000), /aborted|socket|reset|terminated/i);
    assert.equal(requests(), 1);
  });
});

for (const stage of ['headers', 'generation output', 'recovery headers']) {
  test(`provider acceptance bounds the whole cancellation while waiting for ${stage}`, async () => {
    await withProviderCancellationServer((response, count) => {
      if (stage === 'headers' || (stage === 'recovery headers' && count > 1)) return;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      response.write(adapterFrame(stage === 'generation output' ? { role: 'assistant' } : { content: '1' }));
    }, async (url, requests) => {
      await assert.rejects(cancellationWithinBound(cancelChatStreamAndRecover(url, {}, 40)), /stream.*timed? ?out/);
      assert.equal(requests(), stage === 'recovery headers' ? 2 : 1);
    });
  });
}

test("chat acceptance uses fresh connections across same-port server replacement", async () => {
  const connections = [];
  const handler = (req, res) => {
    connections.push(req.headers.connection);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  };
  let server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  try {
    assert.equal((await readChatStream(url, {}, 5000)).ok, true);
    await new Promise(resolve => server.close(resolve));
    server = createServer(handler);
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    const after = await readChatStream(url, {}, 5000);
    assert.equal(assertStreamEvents(after.events), "OK");
    assert.equal(after.usage.total_tokens, 2);
    assert.deepEqual(connections, ["close", "close"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("platform gate never reports a Windows native pass", () => {
  assert.equal(platformAllowsEngine("vllm", "win32", "x64").allowed, false);
  assert.equal(platformAllowsEngine("mlx-vlm", "win32", "x64").allowed, false);
  assert.equal(platformAllowsEngine("vllm", "linux", "x64").allowed, true);
  assert.equal(platformAllowsEngine("vllm", "darwin", "arm64").allowed, true);
  assert.equal(platformAllowsEngine("mlx-vlm", "darwin", "arm64").allowed, true);
  assert.equal(platformAllowsEngine("mlx-vlm", "linux", "x64").allowed, false);
  assert.equal(platformAllowsEngine("mlx-vlm", "darwin", "x64").allowed, false);
  assert.equal(platformAllowsEngine("unknown", "linux", "x64").allowed, false);
});

test("missing usage, model alias or stream text never passes", () => {
  assert.throws(() => assertUsagePresent({}), /missing usage/);
  assert.throws(() => assertUsagePresent({ usage: { prompt_tokens: "8", completion_tokens: 2, total_tokens: 10 } }), /must be a number/);
  assert.throws(() => assertUsagePresent({ usage: { prompt_tokens: 8, completion_tokens: 2 } }), /total_tokens/);
  assert.deepEqual(
    assertUsagePresent({ usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }),
    { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  );
  assert.throws(() => assertModelsAlias({ data: [] }), /at least one/);
  assert.throws(() => assertModelsAlias({ data: [{ id: "" }] }), /nonempty/);
  assert.deepEqual(assertModelsAlias({ data: [{ id: "alias" }] }), ["alias"]);
  assert.throws(() => assertStreamEvents([]), /at least one SSE/);
  assert.throws(
    () => assertStreamEvents([{ choices: [{ delta: { content: "   " } }] }]),
    /non-whitespace/,
  );
  assert.equal(
    assertStreamEvents([{ choices: [{ delta: { content: "synthetic " } }] }, { choices: [{ delta: { content: "OK" } }] }]),
    "synthetic OK",
  );
});

test("embedding vectors must be complete nonempty numeric arrays", () => {
  assert.deepEqual(
    assertEmbeddingsPresent({ data: [{ embedding: [0.1, -2, 3.5], index: 0 }] }),
    { count: 1, dims: 3 },
  );
  assert.throws(() => assertEmbeddingsPresent({ data: [] }), /nonempty data/);
  assert.throws(() => assertEmbeddingsPresent({ data: [{ embedding: [] }] }), /nonempty numeric/);
  assert.throws(() => assertEmbeddingsPresent({ data: [{ embedding: [0.1, "x"] }] }), /must be numbers/);
  assert.throws(() => assertEmbeddingsPresent({ data: [{ embedding: [0.1] }, { embedding: [0.1, 0.2] }] }), /one dimensionality/);
});

test("probe passes only with version, clean errors and platform identity", () => {
  const good = {
    version: "0.31.0", variant: "standard", metal_version: "", python_version: "3.12.0",
    platform_system: "Linux", platform_class: "linux", accelerator: "cpu", errors: [],
  };
  const identity = validateProbeRecord(good, "vllm");
  assert.equal(identity.version, "0.31.0");
  assert.equal(identity.platform, "Linux");
  assert.throws(() => validateProbeRecord({ ...good, version: "" }, "vllm"), /no version/);
  assert.throws(() => validateProbeRecord({ ...good, errors: ["boom"] }, "vllm"), /reported errors/);
  assert.throws(() => validateProbeRecord({ ...good, platform_system: "", platform_class: "" }, "vllm"), /platform identity/);
  assert.throws(() => validateProbeRecord({ ...good, python_version: "" }, "vllm"), /python version/);
});

test("a recorded failure is never downgraded to unrun or blocked", () => {
  const checks = newChecks();
  setCheck(checks, "server_launch", "fail", "boom", {});
  setCheck(checks, "server_launch", "unrun", "later bookkeeping", {});
  assert.equal(checks.server_launch.status, "fail");
  setCheck(checks, "server_launch", "blocked", "later gate", {});
  assert.equal(checks.server_launch.status, "fail");
});

test("summary keeps fail over blocked and blocked over pass", () => {
  const checks = newChecks();
  for (const name of CHECKS) setCheck(checks, name, "pass", "ok", {});
  assert.equal(summarize(checks).outcome, "pass");
  setCheck(checks, "embeddings", "unsupported", "no embedding", {});
  assert.equal(summarize(checks).outcome, "pass");
  setCheck(checks, "stream_text_usage", "blocked", "no host", {});
  assert.equal(summarize(checks).outcome, "blocked");
  setCheck(checks, "server_launch", "fail", "engine refused", {});
  assert.equal(summarize(checks).outcome, "fail");
});

test("argument parsing rejects unknown flags and missing values", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--engine"]), /needs a value/);
  assert.throws(() => parseArgs(["--task", "video"]), /--task must be/);
  const args = parseArgs(["--engine", "vllm", "--model", "m", "--python", "p", "--port", "18081", "--task", "embedding", "--expect-media"]);
  assert.equal(args.engine, "vllm");
  assert.equal(args.task, "embedding");
  assert.equal(args.expectMedia, true);
  assert.equal(args.port, 18081);
  assert.equal(parseArgs([]).task, "chat");
});

test("model inspection never invents a download and pins revisions", () => {
  const missing = inspectModelInput(join(tmpdir(), "aiolm-definitely-missing-12345"));
  assert.equal(missing.ok, false);
  const fileDir = mkdtempSync(join(tmpdir(), "aiolm-harness-file-"));
  try {
    const gguf = join(fileDir, "tiny.gguf");
    writeFileSync(gguf, Buffer.from("GGUF"));
    assert.equal(inspectModelInput(gguf).ok, true);
    assert.equal(inspectModelInput(gguf, "abc123").ok, false);
  } finally {
    rmSync(fileDir, { recursive: true, force: true });
  }
});

test("snapshot manifests record revision and incomplete state", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiolm-harness-snap-"));
  try {
    const revision = "a".repeat(40);
    const snapshot = join(dir, "snap");
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, ".aiolm-snapshot.json"), JSON.stringify({
      format: 1, repository: "example/model", revision, complete: true, files: [{ path: "config.json", size: 10 }],
    }));
    const complete = inspectModelInput(snapshot, revision);
    assert.equal(complete.ok, true);
    assert.equal(complete.kind, "snapshot");
    const mismatch = inspectModelInput(snapshot, "b".repeat(40));
    assert.equal(mismatch.ok, false);
    writeFileSync(join(snapshot, ".aiolm-snapshot.json"), JSON.stringify({
      format: 1, repository: "example/model", revision, complete: false, files: [],
    }));
    const incomplete = inspectModelInput(snapshot, revision);
    assert.equal(incomplete.ok, true);
    assert.equal(incomplete.kind, "snapshot-incomplete");
    // An unverified external pin fails instead of becoming native evidence.
    const external = join(dir, "external");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "config.json"), "{}");
    const unverified = inspectModelInput(external, revision);
    assert.equal(unverified.ok, false);
    assert.equal(unverified.kind, "external-snapshot");
    assert.match(unverified.detail, /cannot verify/);
    const cache = join(dir, 'models--example--model', 'snapshots', revision);
    mkdirSync(cache, { recursive: true });
    assert.equal(inspectModelInput(cache, revision).ok, true);
    assert.equal(inspectModelInput(cache, 'b'.repeat(40)).ok, false);
    const guessed = join(dir, `external-${revision.slice(0, 8)}`);
    mkdirSync(guessed, { recursive: true });
    assert.equal(inspectModelInput(guessed, revision).ok, false);
    writeFileSync(join(snapshot, '.aiolm-snapshot.json'), JSON.stringify({ complete: true, files: [] }));
    assert.equal(inspectModelInput(snapshot, revision).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isolated home clears parent AIOLM state and points AIOLM_HOME inside it", () => {
  process.env.AIOLM_SMOKE_PARENT = "1";
  process.env.AIOLM_HOME = "/definitely/not/isolated";
  const isolated = createIsolatedHome();
  try {
    assert.ok(isolated.home.includes("home with spaces"));
    assert.ok(isolated.env.AIOLM_HOME.startsWith(isolated.home));
    assert.equal(isolated.env.AIOLM_SMOKE_PARENT, undefined);
    assert.ok(isolated.env.HOME === isolated.home || isolated.env.USERPROFILE === isolated.home);
  } finally {
    rmSync(isolated.temporary, { recursive: true, force: true });
    delete process.env.AIOLM_SMOKE_PARENT;
    delete process.env.AIOLM_HOME;
  }
});

test("CLI runner parses JSON and surfaces failures without swallowing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiolm-harness-cli-"));
  try {
    const okStub = join(dir, "ok-stub.mjs");
    writeFileSync(okStub, 'console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));\n');
    const ok = runCli(process.execPath, [okStub, "hello"], process.env, 10000);
    assert.equal(ok.ok, true);
    const failStub = join(dir, "fail-stub.mjs");
    writeFileSync(failStub, 'console.log(JSON.stringify({ error: "boom" })); process.exit(1);\n');
    assert.throws(() => runCli(process.execPath, [failStub], process.env, 10000), /boom/);
    const noisyStub = join(dir, "noisy-stub.mjs");
    writeFileSync(noisyStub, 'console.log("not json");\n');
    assert.throws(() => runCli(process.execPath, [noisyStub], process.env, 10000), /non-JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shareable JSON carries no user paths, PIDs or URLs", () => {
  const nasty = {
    schema: 1,
    inputs: { python: "C:\\Users\\someone\\python.exe", model: "/home/someone/models/x", cli: "/opt/aiolm/aiolm-cli" },
    checks: {
      server_launch: { name: "server_launch", status: "pass", detail: "server running pid 4242 at http://127.0.0.1:18080/v1", evidence: { pid: 4242, url: "http://127.0.0.1:18080/v1" } },
      stop: { name: "stop", status: "pass", detail: "left running", evidence: {} },
    },
    runtime: { location: "/home/someone/.venv/bin/python" },
    error: "cannot open /home/someone/models/x: pid 99",
  };
  const clean = sanitizeResultForFile(nasty);
  const text = JSON.stringify(clean);
  assert.ok(!text.includes("someone"), `user path leaked: ${text}`);
  assert.ok(!text.includes("127.0.0.1"), `URL leaked: ${text}`);
  assert.ok(!text.includes("4242"), `PID leaked: ${text}`);
  assert.ok(!text.includes("pid 99"), `PID leaked: ${text}`);
  assert.equal(clean.checks.server_launch.evidence.pid, "[redacted]");
  assert.equal(clean.checks.server_launch.evidence.url, "[redacted]");
});

// --- Injected-fake live-path coverage ------------------------------------
// The fake CLI below mirrors the real aiolm-cli JSON shapes from
// src-tauri/src/bin/aiolm-cli.rs: `runtime register` returns a manifest with
// {id, probe}, `runtime probe` returns the manifest, `runtime list` returns
// an array, `server start/stop` plus `server status` drive the lifecycle,
// and `doctor` reports readiness. The fake engine streams SSE with
// authoritative usage only when asked via stream_options.include_usage.
const FAKE_CLI_SOURCE = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_STATE_DIR || ".";
const mode = process.env.FAKE_CLI_MODE || "ok";
const stateFile = join(dir, "fake-server-state.json");
const configFile = join(dir, "fake-config.json");
const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fb; } };
const writeJson = (f, o) => { mkdirSync(dir, { recursive: true }); writeFileSync(f, JSON.stringify(o)); };
const out = (o) => console.log(JSON.stringify(o));
const fail = (msg) => { console.log(JSON.stringify({ error: msg })); process.exit(1); };
const [cmd, sub, ...rest] = process.argv.slice(2);
const RUNTIME_ID = "test-runtime-1";
const probeRecord = () => ({
  version: "0.31.0-synthetic", variant: "standard", metal_version: "",
  python_version: "3.12.0", python_arch: "x86_64", platform_system: "Linux",
  platform_class: "linux", accelerator: "cpu", architectures: ["Qwen2ForCausalLM"],
  generation_architectures: ["Qwen2ForCausalLM"], embedding_architectures: [],
  multimodal_architectures: [], server_flags: ["--port"], errors: [], probed_at: 1,
});
const listed = (provider) => ({
  id: RUNTIME_ID, provider, engine: "vllm", server: "vllm",
  version: "0.31.0-synthetic", variant: "standard", accelerator: "cpu",
  installation: "external", location: "[test]", available: true, problems: [],
});
if (cmd === "runtime" && sub === "register") {
  if (mode === "register-fails") fail("synthetic registration refused");
  const cfg = readJson(configFile, {});
  cfg.runtimeId = RUNTIME_ID;
  writeJson(configFile, cfg);
  out({ id: RUNTIME_ID, provider: rest[0], kind: "external", python: rest[1], probe: probeRecord() });
} else if (cmd === "runtime" && sub === "import") {
  if (mode === "import-fails") fail("synthetic offline import refused");
  out({ id: RUNTIME_ID, provider: mode === "import-wrong-provider" ? "mlx-vlm" : "vllm", kind: "managed", probe: probeRecord() });
} else if (cmd === "runtime" && sub === "probe") {
  if (mode === "unknown-runtime" || rest[1] !== RUNTIME_ID) fail("no such runtime: " + rest[1]);
  if (mode === "probe-no-version") out({ id: rest[1], provider: rest[0], probe: { ...probeRecord(), version: "", python_version: "", platform_system: "", platform_class: "", errors: ["synthetic: package not importable"] } });
  else if (mode === "probe-errors") out({ id: rest[1], provider: rest[0], probe: { ...probeRecord(), errors: ["synthetic probe error"] } });
  else out({ id: rest[1], provider: rest[0], probe: probeRecord() });
} else if (cmd === "runtime" && sub === "list") {
  if (mode === "unknown-runtime") out([]);
  else if (mode === "runtime-not-ready") out([{ ...listed("vllm"), available: false, problems: ["synthetic not ready"] }]);
  else out([listed("vllm"), listed("mlx-vlm")]);
} else if (cmd === "runtime" && sub === "select") {
  out({ ok: true });
} else if (cmd === "config" && sub === "set") {
  const cfg = readJson(configFile, {});
  const key = rest[0];
  const value = rest.slice(1).join(" ");
  cfg[key] = key === "port" ? Number(value) : value;
  writeJson(configFile, cfg);
  out({ ok: true, changed: key });
} else if (cmd === "config" && sub === "get") {
  const cfg = readJson(configFile, {});
  const emb = process.env.FAKE_EMBEDDING_MODEL;
  out({ active_model: cfg.active_model ?? "", port: cfg.port ?? 0, provider_options: emb ? { vllm: { embedding_model: emb } } : {} });
} else if (cmd === "doctor") {
  if (mode === "doctor-not-ready") out({ provider: "vllm", runtime: RUNTIME_ID, runtime_ready: false, readiness_source: "live-python-probe", runtime_problem: "synthetic not ready" });
  else out({ provider: "vllm", runtime: RUNTIME_ID, runtime_ready: true, readiness_source: "live-python-probe", runtime_problem: "" });
} else if (cmd === "server" && sub === "start") {
  if (mode === "start-fails") fail("synthetic start refused");
  if (mode === "start-refuses-incomplete") fail("snapshot incomplete: readiness reports missing weights");
  const st = readJson(stateFile, {});
  st.running = true;
  writeJson(stateFile, st);
  out({ state: "running", model: "test" });
} else if (cmd === "server" && sub === "status") {
  if (mode === "status-unhealthy") out({ state: "running", managed: true, health: false });
  else {
    const st = readJson(stateFile, {});
    if (st.running) out({ state: "running", managed: true, health: true });
    else out({ state: "stopped", managed: false });
  }
} else if (cmd === "server" && sub === "restart") {
  if (mode === "restart-broken") {
    const st = readJson(stateFile, {});
    st.running = false;
    writeJson(stateFile, st);
    out({ state: "starting", managed: true, health: false });
  } else {
    const st = readJson(stateFile, {});
    st.running = true;
    writeJson(stateFile, st);
    out({ state: "running", managed: true, health: true });
  }
} else if (cmd === "server" && sub === "stop") {
  if (mode === "stop-fails") fail("synthetic stop refused");
  const st = readJson(stateFile, {});
  st.running = false;
  writeJson(stateFile, st);
  out({ state: "stopped", managed: false });
} else {
  fail("unknown fake command: " + cmd + " " + sub);
}
`;

function startFakeEngine({ behavior = "ok" } = {}) {
  const behaviors = new Set(String(behavior).split("+"));
  const has = (name) => behaviors.has(name);
  const seen = { payloads: [], cancelled: false, transcriptionHits: 0, streamOptionsSeen: [] };
  const send = (res, status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      send(res, 200, { status: "ok" });
    } else if (req.url === "/v1/models") {
      send(res, 200, { data: [{ id: "fake-alias" }] });
    } else if (req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        seen.payloads.push(payload);
        if (payload.stream === true) seen.streamOptionsSeen.push(payload.stream_options ?? null);
        const text = JSON.stringify(payload);
        if (has("chat-500")) {
          send(res, 500, { error: "synthetic engine error" });
          return;
        }
        if (text.includes("file://")) {
          if (has("file-refusal-empty")) {
            send(res, 400, {});
            return;
          }
          if (has("file-refusal-500")) {
            send(res, 500, { error: "synthetic file URI server error" });
            return;
          }
          if (has("file-accepted")) {
            send(res, 200, { choices: [{ message: { role: "assistant", content: "synthetic file content" } }] });
            return;
          }
          send(res, 400, { error: { code: "unsupported_input", message: "Local paths are refused." } });
          return;
        }
        if (has("chat-refuses-400")) {
          send(res, 400, { error: { code: "unsupported_task", message: "embedding-only checkpoint" } });
          return;
        }
        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
          if (has("tools-refuse-400")) {
            send(res, 400, { error: { code: "unsupported_tools", message: "no tool parser" } });
            return;
          }
          send(res, 200, {
            choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } }] } }],
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          });
          return;
        }
        if (text.includes("image_url") && payload.stream === false) {
          if (has("media-ok")) {
            send(res, 200, {
              choices: [{ message: { role: "assistant", content: "a pixel" } }],
              usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 },
            });
            return;
          }
          send(res, 400, { error: { code: "unsupported_media", message: "text-only checkpoint" } });
          return;
        }
        const slow = Number(payload.max_tokens ?? 0) >= 64;
        const head = `data: ${JSON.stringify({ choices: [{ delta: { content: "fake " } }] })}\n\n`;
        const tail = `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`
          + "data: [DONE]\n\n";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(head);
        req.on("close", () => { if (!res.writableEnded) seen.cancelled = true; });
        if (slow) {
          setTimeout(() => { if (!res.writableEnded) res.end(tail); }, 1200);
        } else {
          res.end(tail);
        }
      });
    } else if (req.url === "/v1/embeddings") {
      req.resume();
      req.on("end", () => {
        if (has("embeddings-ok")) {
          send(res, 200, { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }], model: "fake-alias" });
        } else if (has("embeddings-empty")) {
          send(res, 200, { data: [{ embedding: [], index: 0 }] });
        } else {
          send(res, 400, { error: { code: "unsupported", message: "no embedding model declared" } });
        }
      });
    } else if (req.url === "/v1/audio/transcriptions") {
      req.resume();
      req.on("end", () => {
        seen.transcriptionHits += 1;
        if (has("transcription-refuses")) {
          send(res, 400, { error: { code: "unsupported_task", message: "not an STT checkpoint" } });
        } else {
          send(res, 200, { text: "fake transcript" });
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      resolveServer({ server, port: server.address().port, seen, close: () => server.close() });
    });
  });
}

const LIVE_REVISION = "c".repeat(40);

function makeModelDir({ complete = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aiolm-live-model-"));
  const snapshot = join(dir, "snap");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, "config.json"), "{}");
  writeFileSync(join(snapshot, ".aiolm-snapshot.json"), JSON.stringify({
    format: 1, repository: "example/model", revision: LIVE_REVISION, complete, files: [{ path: "config.json", size: 2 }],
  }));
  const python = join(dir, "python3");
  writeFileSync(python, "fake-interpreter");
  return { dir, snapshot, python };
}

function makeLiveCase() {
  const dir = mkdtempSync(join(tmpdir(), "aiolm-live-case-"));
  const stubPath = join(dir, "fake-cli.mjs");
  writeFileSync(stubPath, FAKE_CLI_SOURCE);
  const stateDir = join(dir, "cli-state");
  mkdirSync(stateDir, { recursive: true });
  return { dir, stubPath, stateDir };
}

async function runLiveWithFakes({ task = "chat", behavior = "ok", cliMode = "ok", extraArgs = {}, extraEnv = {} } = {}) {
  const live = makeLiveCase();
  const model = makeModelDir({ complete: extraArgs.snapshotComplete ?? true });
  const engine = await startFakeEngine({ behavior });
  const outPath = join(live.dir, "result.json");
  const args = {
    engine: "vllm",
    task,
    python: model.python,
    runtimeId: "",
    model: model.snapshot,
    revision: LIVE_REVISION,
    companion: "",
    cli: process.execPath,
    port: engine.port,
    timeoutMs: 10000,
    startTimeoutMs: 15000,
    out: outPath,
    keepHome: false,
    selfTest: false,
    expectEmbeddings: false,
    expectMedia: false,
    expectTools: false,
    expectTranscription: false,
    mediaFile: "",
    audioFile: "",
    prompt: "Say OK.",
    maxTokens: 16,
    ...extraArgs,
  };
  delete args.snapshotComplete;
  if (args.runtimeBundle === 'fixture') {
    args.runtimeBundle = join(model.dir, 'synthetic-runtime.zip');
    writeFileSync(args.runtimeBundle, 'synthetic bundle for fake CLI');
  }
  const result = await runLive(args, {
    platform: "linux",
    arch: "x64",
    cliPrefix: [live.stubPath],
    extraEnv: { FAKE_STATE_DIR: live.stateDir, FAKE_CLI_MODE: cliMode, ...extraEnv },
  });
  return { result, live, model, engine, outPath };
}

function closeLive({ live, model, engine }) {
  engine.close();
  rmSync(live.dir, { recursive: true, force: true });
  rmSync(model.dir, { recursive: true, force: true });
}

function assertChecksShape(result) {
  assert.equal(result.schema, 1);
  assert.equal(result.synthetic, false);
  for (const name of CHECKS) {
    const check = result.checks[name];
    assert.ok(check, `missing check ${name}`);
    assert.ok(STATUSES.includes(check.status), `check ${name} has unknown status ${check.status}`);
  }
  for (const status of STATUSES) {
    const actual = Object.values(result.checks).filter(check => check.status === status).length;
    assert.equal(result.summary[status], actual, `published ${status} count must include the final cleanup result`);
  }
}

test("live path with fakes: successful stop, mid-body cancel and redacted shareable JSON", async () => {
  const { result, live, model, engine, outPath } = await runLiveWithFakes();
  try {
    assert.equal(result.live, true);
    assert.equal(result.summary.outcome, "pass");
    assert.equal(result.checks.server_launch.status, "pass");
    assert.equal(result.checks.model_alias.status, "pass");
    assert.equal(result.checks.stream_text_usage.status, "pass");
    assert.equal(result.checks.cancel.status, "pass");
    assert.equal(result.checks.restart.status, "pass");
    assert.equal(result.checks.stop.status, "pass");
    assert.equal(result.checks.cleanup.status, "pass");
    assert.deepEqual(result.servedAlias, "fake-alias");
    assert.deepEqual(result.usage, { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 });
    // The server observed a cancelled open body, and every streamed chat
    // request asked for authoritative usage.
    assert.equal(engine.seen.cancelled, true);
    const streamed = engine.seen.payloads.filter((payload) => payload.stream === true);
    assert.ok(streamed.length > 0, "expected streamed chat requests");
    for (const options of engine.seen.streamOptionsSeen) {
      assert.equal(options?.include_usage, true);
    }
    // Tools acceptance is recorded separately from the actual tool call.
    assert.equal(result.checks.tools.status, "pass");
    assert.equal(result.tools.called, true);
    assertChecksShape(result);
    // Shareable JSON hygiene.
    const fileText = readFileSync(outPath, "utf8");
    assert.ok(!fileText.includes("127.0.0.1"), "shareable JSON must not carry URLs");
    assert.ok(!/"pid"/.test(fileText), "shareable JSON must not carry PIDs");
    const file = JSON.parse(fileText);
    assert.ok(!String(file.inputs.python ?? "").includes("/") && !String(file.inputs.python ?? "").includes("\\"), "python input must be a basename");
    assert.ok(!String(file.inputs.model ?? "").includes("/") && !String(file.inputs.model ?? "").includes("\\"), "model input must be a basename");
  } finally {
    closeLive({ live, model, engine });
  }
});

test("failure cleanup retention: a stop failure keeps the isolated home and fails cleanup", async () => {
  const errors = [];
  const original = console.error;
  console.error = (...parts) => { errors.push(parts.join(" ")); };
  const { result, live, model, engine } = await runLiveWithFakes({ cliMode: "stop-fails" });
  console.error = original;
  try {
    assert.equal(result.summary.outcome, "fail");
    assert.equal(result.checks.stop.status, "fail");
    assert.equal(result.checks.cleanup.status, "fail");
    assertChecksShape(result);
    assert.match(result.checks.cleanup.detail, /retained/);
    const retained = errors.find((line) => line.includes("retaining isolated home for manual stop:"));
    assert.ok(retained, "retained home must be logged on console only");
    const home = retained.split("manual stop:")[1].trim();
    assert.ok(home.length > 0, "console must carry the retained home path");
    rmSync(home, { recursive: true, force: true });
  } finally {
    closeLive({ live, model, engine });
  }
});

test("declared capability failure: expected media refusal is fail, not unsupported", async () => {
  {
    const run = await runLiveWithFakes({ extraArgs: { expectMedia: true } });
    try {
      assert.equal(run.result.checks.media_supported.status, "fail");
      assert.equal(run.result.summary.outcome, "fail");
    } finally {
      closeLive({ live: run.live, model: run.model, engine: run.engine });
    }
  }
  {
    const run = await runLiveWithFakes();
    try {
      assert.equal(run.result.checks.media_supported.status, "unsupported");
    } finally {
      closeLive({ live: run.live, model: run.model, engine: run.engine });
    }
  }
});

test("file URI server errors remain failures without claiming the engine accepted the input", async () => {
  const run = await runLiveWithFakes({ behavior: "file-refusal-500" });
  try {
    assert.equal(run.result.checks.media_refusal.status, "fail");
    assert.equal(run.result.checks.media_refusal.evidence.status, 500);
    assert.match(run.result.checks.media_refusal.detail, /server error.*500/);
    assert.doesNotMatch(run.result.checks.media_refusal.detail, /not refused|accepted/);
    assert.equal(run.result.summary.outcome, "fail");
    assert.equal(run.result.checks.cleanup.status, "pass");
  } finally {
    closeLive(run);
  }
});

test("file URI acceptance remains a failure", async () => {
  const run = await runLiveWithFakes({ behavior: "file-accepted" });
  try {
    assert.equal(run.result.checks.media_refusal.status, "fail");
    assert.equal(run.result.checks.media_refusal.evidence.status, 200);
    assert.match(run.result.checks.media_refusal.detail, /not refused.*200/);
    assert.equal(run.result.summary.outcome, "fail");
    assert.equal(run.result.checks.cleanup.status, "pass");
  } finally {
    closeLive(run);
  }
});

test("file URI refusal without an error explanation cannot pass", async () => {
  const run = await runLiveWithFakes({ behavior: "file-refusal-empty" });
  try {
    assert.equal(run.result.checks.media_refusal.status, "fail");
    assert.equal(run.result.checks.media_refusal.evidence.status, 400);
    assert.match(run.result.checks.media_refusal.detail, /without an error explanation/);
    assert.equal(run.result.summary.outcome, "fail");
    assert.equal(run.result.checks.cleanup.status, "pass");
  } finally {
    closeLive(run);
  }
});

test("declared tools refusal is unsupported unless expected, then fail", async () => {
  {
    const run = await runLiveWithFakes({ behavior: "tools-refuse-400" });
    try {
      assert.equal(run.result.checks.tools.status, "unsupported");
      assert.equal(run.result.summary.outcome, "pass");
    } finally {
      closeLive({ live: run.live, model: run.model, engine: run.engine });
    }
  }
  {
    const run = await runLiveWithFakes({ behavior: "tools-refuse-400", extraArgs: { expectTools: true } });
    try {
      assert.equal(run.result.checks.tools.status, "fail");
      assert.equal(run.result.summary.outcome, "fail");
    } finally {
      closeLive({ live: run.live, model: run.model, engine: run.engine });
    }
  }
});

test("missing explicit input never summarizes as pass", async () => {
  const live = makeLiveCase();
  try {
    const missing = await runLive(
      {
        engine: "vllm", task: "chat", python: "", runtimeId: "", model: "",
        revision: "", companion: "", cli: process.execPath, port: 18080,
        timeoutMs: 5000, startTimeoutMs: 5000, out: "", keepHome: false,
        selfTest: false, expectEmbeddings: false, expectMedia: false,
        expectTools: false, expectTranscription: false, mediaFile: "", audioFile: "",
        prompt: "hi", maxTokens: 8,
      },
      { platform: "linux", arch: "x64", cliPrefix: [live.stubPath], extraEnv: { FAKE_STATE_DIR: live.stateDir } },
    );
    assert.equal(missing.checks.model_validation.status, "fail");
    assert.equal(missing.summary.outcome, "fail");
  } finally {
    rmSync(live.dir, { recursive: true, force: true });
  }
});

test("probe without version or with errors is a failure, not a pass", async () => {
  {
    const run = await runLiveWithFakes({ cliMode: "probe-no-version" });
    try {
      assert.equal(run.result.checks.probe.status, "fail");
      assert.match(run.result.checks.probe.detail, /no version|importable/);
      assert.equal(run.result.summary.outcome, "fail");
    } finally {
      closeLive({ live: run.live, model: run.model, engine: run.engine });
    }
  }
  {
    const run = await runLiveWithFakes({ cliMode: "probe-errors" });
    try {
      assert.equal(run.result.checks.probe.status, "fail");
      assert.equal(run.result.summary.outcome, "fail");
    } finally {
      closeLive({ live: run.live, model: run.model, engine: run.engine });
    }
  }
});

test("runtime-id reuse in a fresh isolated home fails honestly at probe", async () => {
  const run = await runLiveWithFakes({
    cliMode: "unknown-runtime",
    extraArgs: { python: "", runtimeId: "ghost-runtime-1" },
  });
  try {
    assert.equal(run.result.checks.registration.status, "pass");
    assert.match(run.result.checks.registration.detail, /isolated home starts empty/);
    assert.equal(run.result.checks.probe.status, "fail");
    assert.equal(run.result.summary.outcome, "fail");
  } finally {
    closeLive({ live: run.live, model: run.model, engine: run.engine });
  }
});

test("embedding task: chat refusal is unsupported and vectors are genuinely verified", async () => {
  const run = await runLiveWithFakes({
    task: "embedding",
    behavior: "chat-refuses-400+embeddings-ok",
    extraArgs: { expectEmbeddings: true, task: "embedding" },
  });
  try {
    // chat refusal from an embedding-only checkpoint must not fail the run.
    assert.equal(run.result.checks.stream_text_usage.status, "unsupported");
    assert.equal(run.result.checks.embeddings.status, "pass");
    assert.deepEqual(run.result.embeddings, { count: 1, dims: 4 });
    assert.equal(run.result.summary.outcome, "pass");
  } finally {
    closeLive({ live: run.live, model: run.model, engine: run.engine });
  }
});

test("embedding task without a declared model fails instead of passing silently", async () => {
  const run = await runLiveWithFakes({ task: "embedding", behavior: "chat-refuses-400", extraArgs: { task: "embedding" } });
  try {
    assert.equal(run.result.checks.embeddings.status, "fail");
    assert.equal(run.result.summary.outcome, "fail");
  } finally {
    closeLive({ live: run.live, model: run.model, engine: run.engine });
  }
});

test("options-declared embeddings refusal is unsupported, not fail", async () => {
  const run = await runLiveWithFakes({ extraEnv: { FAKE_EMBEDDING_MODEL: "/models/embedder" } });
  try {
    assert.equal(run.result.checks.embeddings.status, "unsupported");
    assert.equal(run.result.summary.outcome, "pass");
  } finally {
    closeLive({ live: run.live, model: run.model, engine: run.engine });
  }
});

test("corrupt embedding vectors fail the genuine check", async () => {
  const run = await runLiveWithFakes({
    task: "embedding",
    behavior: "embeddings-empty",
    extraArgs: { expectEmbeddings: true, task: "embedding" },
  });
  try {
    assert.equal(run.result.checks.embeddings.status, "fail");
    assert.equal(run.result.summary.outcome, "fail");
  } finally {
    closeLive({ live: run.live, model: run.model, engine: run.engine });
  }
});

test("transcription task: STT passes without mandatory chat", async () => {
  const run = await runLiveWithFakes({
    task: "transcription",
    behavior: "chat-refuses-400",
    extraArgs: { task: "transcription" },
  });
  try {
    assert.equal(run.result.checks.stream_text_usage.status, "unsupported");
    assert.equal(run.result.checks.transcription.status, "pass");
    assert.ok(run.result.transcript.chars > 0);
    assert.equal(run.result.summary.outcome, "pass");
  } finally {
    closeLive({ live: run.live, model: run.model, engine: run.engine });
  }
});

test("incomplete snapshots are refused at launch as the negative fixture", async () => {
  const run = await runLiveWithFakes({ cliMode: "start-refuses-incomplete", extraArgs: { snapshotComplete: false } });
  try {
    assert.equal(run.result.model.kind, "snapshot-incomplete");
    assert.equal(run.result.checks.server_launch.status, "pass");
    assert.match(run.result.checks.server_launch.detail, /refused incomplete snapshot as expected/);
    assert.equal(run.result.checks.stream_text_usage.status, "unrun");
    assert.equal(run.result.summary.outcome, "pass");
  } finally {
    closeLive({ live: run.live, model: run.model, engine: run.engine });
  }
});

test("portable bundle imports into the harness home and preserves import failures", async () => {
  for (const cliMode of ['ok', 'import-fails', 'import-wrong-provider']) {
    const run = await runLiveWithFakes({ cliMode, extraArgs: { python: '', runtimeBundle: 'fixture' } });
    try {
      assert.equal(run.result.checks.registration.status, cliMode === 'ok' ? 'pass' : 'fail');
      if (cliMode === 'ok') {
        assert.equal(run.result.checks.registration.evidence.source, 'portable-bundle');
        assert.equal(run.result.checks.stream_text_usage.status, 'pass');
        assert.equal(run.result.inputs.runtimeBundle, 'synthetic-runtime.zip');
      } else assert.equal(run.result.summary.outcome, 'fail');
    } finally {
      closeLive({ live: run.live, model: run.model, engine: run.engine });
    }
  }
});

test("synthetic self-test runs on loopback and never claims a native pass", () => {
  const result = spawnSync(process.execPath, ["scripts/smoke-provider-runtime.mjs", "--self-test"], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /synthetic=yes/);
  assert.match(result.stdout, /live=no/);
  assert.match(result.stdout, /stream_text_usage: pass/);
  assert.match(result.stdout, /media_refusal: pass/);
  assert.match(result.stdout, /cancel: pass/);
  assert.match(result.stdout, /transcription: pass/);
  assert.match(result.stdout, /tools: pass/);
});


test('external acceptance rejects echoed prompts or extra answers despite containing the expected number', () => {
  const usage = { prompt_tokens: 42, completion_tokens: 2 };
  assert.equal(validateRuntimeAdapterCompletion({ content: ' 5\n', usage }, '5').answerExact, true);
  for (const content of ['15', '5\nuser: Compute 2 + 3.\nassistant: 5', 'The answer is 5', '5 5', '']) {
    assert.throws(() => validateRuntimeAdapterCompletion({ content, usage }, '5'), /exactly match/);
  }
  assert.throws(() => validateRuntimeAdapterCompletion({ content: '5' }, '5'), /tokenizer usage/);
});

test('external cancellation recovery requires the same process for the follow-up answer', () => {
  const running = { state: 'running', pid: 123 };
  assert.equal(validateRuntimeAdapterRecovery(running, running, running), true);
  for (const changed of [{ state: 'stopped', pid: 123 }, { state: 'running', pid: 124 }, { state: 'running' }]) {
    assert.throws(() => validateRuntimeAdapterRecovery(running, changed, running), /same running server/);
    assert.throws(() => validateRuntimeAdapterRecovery(running, running, changed), /same running server/);
  }
});
