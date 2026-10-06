/* global process, console, fetch, AbortController, setTimeout, clearTimeout, FormData, Blob, Buffer */
 // Opt-in actual-engine acceptance harness for Linux vLLM, Apple Silicon
 // vllm-metal (via the vLLM engine) and mlx-vlm.
 //
 // This harness never downloads a model and never installs an engine. The
 // caller supplies an explicit engine, an explicit interpreter or a registered
 // runtime id, and an explicit model path. Every run uses an isolated
 // temporary AIOLM_HOME and removes only what it created.
 //
 // Scope boundary: the native headless CLI (`server start/status/stop`,
 // `runtime register/probe/list/select`, `config`, `models list`, `doctor`)
 // talks directly to the engine process and bypasses the application protocol
 // and gateway layers (history, adapters, media pipeline, auth). Engine HTTP
 // verdicts below prove engine behavior only. Application-owned media
 // handling, history, adapter binding and gateway routing belong to precise
 // GUI/native tests and are never inferred from an engine 4xx here. In
 // particular, the `media_refusal` check records that the *engine* refused a
 // `file://` part; it does not prove the application refuses file paths.
 //
 // Live usage (Linux example):
 //   node scripts/smoke-provider-runtime.mjs --engine vllm \
 //     --python /usr/bin/python3 --model /data/models/qwen2.5-0.5b-snapshot \
 //     --revision 0123456789abcdef0123456789abcdef01234567 \
 //     --cli .codex-target/release/aiolm-cli --port 18080 \
 //     --out tmp/provider-acceptance-vllm.json
 //
 // Task modes (`--task chat` is the default):
 //   chat          text chat is mandatory; embeddings only when declared.
 //   embedding     embedding-only checkpoints must not fail mandatory chat:
 //                 a chat 400/404/422 becomes `unsupported`, embeddings must
 //                 pass with complete numeric vectors.
 //   transcription STT checkpoints must not fail mandatory chat either:
 //                 chat refusal becomes `unsupported`, transcription must pass.
 //
 // Synthetic self-check (no engine, no model, no network beyond loopback):
 //   node scripts/smoke-provider-runtime.mjs --self-test
 //
 // Result statuses are authoritative: "pass", "fail", "unsupported", "unrun"
 // or "blocked". A missing usage block, model alias or platform identity is a
 // failure, never a pass. Checks that never started stay "unrun". A host that
 // cannot run the selected engine reports "blocked" before any live attempt,
 // and a Windows run never reports a Linux/macOS native pass.
 //
 // Privacy: the shareable JSON written via --out never contains user
 // model/Python paths, PIDs or URLs. Inputs are stored as basenames, process
 // identity is never recorded, and error/detail strings are redacted of
 // absolute paths. Full local paths appear on the console only (with
 // --keep-home, or when a failed cleanup retains the isolated home).
 import assert from "node:assert/strict";
 import { spawnSync } from "node:child_process";
 import { createServer } from "node:http";
 import {
   existsSync,
   mkdtempSync,
   mkdirSync,
   readFileSync,
   rmSync,
   statSync,
   writeFileSync,
 } from "node:fs";
 import { tmpdir } from "node:os";
 import { dirname, join, resolve } from "node:path";

 export const RESULT_SCHEMA = 1;
 export const STATUSES = ["pass", "fail", "unsupported", "unrun", "blocked"];
 export const TASKS = ["chat", "embedding", "transcription"];
 export const CHECKS = [
   "platform",
   "registration",
   "probe",
   "runtime_identity",
   "config_selection",
   "model_validation",
   "server_launch",
   "model_alias",
   "stream_text_usage",
   "cancel",
   "restart",
   "stop",
   "media_supported",
   "media_refusal",
   "tools",
   "embeddings",
   "transcription",
   "benchmark",
   "deep_verification",
   "cleanup",
 ];

 export function newChecks() {
   const checks = {};
   for (const name of CHECKS) {
     checks[name] = { name, status: "unrun", detail: "not attempted", evidence: {} };
   }
   return checks;
 }

 export function setCheck(checks, name, status, detail = "", evidence = {}) {
   assert.ok(checks[name], `unknown check ${name}`);
   assert.ok(STATUSES.includes(status), `unknown status ${status}`);
   // A failure recorded after a live run started is never downgraded to a
   // skip-like status by later bookkeeping.
   if (checks[name].status === "fail" && (status === "unrun" || status === "blocked")) {
     return checks[name];
   }
   checks[name] = { name, status, detail: String(detail).slice(0, 2000), evidence };
   return checks[name];
 }

 export function summarize(checks) {
   const summary = { pass: 0, fail: 0, unsupported: 0, unrun: 0, blocked: 0 };
   for (const name of CHECKS) {
     const status = checks[name]?.status ?? "unrun";
     if (summary[status] !== undefined) summary[status] += 1;
   }
   const failed = summary.fail > 0;
   const blocked = !failed && summary.blocked > 0;
   return { ...summary, outcome: failed ? "fail" : blocked ? "blocked" : "pass" };
 }

 // A platform verdict must precede any live attempt. Windows cannot run the
 // managed Python engines natively; mlx-vlm needs Apple Silicon macOS and the
 // vllm-metal variant needs Apple Silicon macOS 15+ (checked again by probe).
 export function platformAllowsEngine(engine, platform = process.platform, arch = process.arch) {
   if (engine === "vllm") {
     if (platform === "linux") return { allowed: true, detail: `${platform}/${arch} supports vLLM` };
     if (platform === "darwin" && arch === "arm64") {
       return { allowed: true, detail: "darwin/arm64 may support vLLM via vllm-metal; probe decides" };
     }
     return { allowed: false, detail: `vLLM runtimes require Linux or Apple Silicon macOS 15+ with vllm-metal; this host is ${platform}/${arch}. Windows-native vLLM and WSL2 are not managed by AioLM.` };
   }
   if (engine === "mlx-vlm") {
     if (platform === "darwin" && arch === "arm64") {
       return { allowed: true, detail: "darwin/arm64 supports mlx-vlm" };
     }
     return { allowed: false, detail: `MLX runtimes (mlx-vlm) are supported on Apple Silicon macOS only; this host is ${platform}/${arch}.` };
   }
   return { allowed: false, detail: `unknown engine ${engine}; select vllm or mlx-vlm` };
 }

 export function assertUsagePresent(body, context = "chat") {
   const usage = body?.usage;
   assert.ok(usage && typeof usage === "object", `${context}: missing usage block: ${JSON.stringify(body).slice(0, 500)}`);
   for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
     assert.equal(typeof usage[key], "number", `${context}: usage.${key} must be a number`);
     assert.ok(Number.isFinite(usage[key]) && usage[key] >= 0, `${context}: usage.${key} must be finite`);
   }
   return usage;
 }

 export function assertModelsAlias(body) {
   const data = body?.data;
   assert.ok(Array.isArray(data) && data.length > 0, `GET /v1/models must list at least one served model: ${JSON.stringify(body).slice(0, 500)}`);
   for (const entry of data) {
     assert.equal(typeof entry?.id, "string", "each /v1/models entry must have a string id");
     assert.ok(entry.id.length > 0, "served model id must be nonempty");
   }
   return data.map((entry) => entry.id);
 }

 export function assertStreamEvents(events) {
   assert.ok(events.length > 0, "stream must emit at least one SSE data event");
   const texts = events.map((event) => event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.text ?? "").join("");
   assert.ok(texts.trim().length > 0, "streamed deltas must contain non-whitespace text");
   return texts;
 }

 // A genuine embedding verdict: every returned vector must be a complete,
 // nonempty, finite numeric array. A 200 with an empty or non-numeric vector
 // is corruption, never a pass.
 export function assertEmbeddingsPresent(body, context = "embeddings") {
   const data = body?.data;
   assert.ok(Array.isArray(data) && data.length > 0, `${context}: response must carry a nonempty data array: ${JSON.stringify(body).slice(0, 500)}`);
   let dims = -1;
   for (const entry of data) {
     const vector = entry?.embedding;
     assert.ok(Array.isArray(vector) && vector.length > 0, `${context}: every entry must carry a nonempty numeric embedding vector`);
     if (dims < 0) dims = vector.length;
     assert.equal(vector.length, dims, `${context}: embedding vectors must share one dimensionality`);
     for (const value of vector) {
       assert.equal(typeof value, "number", `${context}: embedding values must be numbers`);
       assert.ok(Number.isFinite(value), `${context}: embedding values must be finite`);
     }
   }
   return { count: data.length, dims };
 }

 // A probe pass needs engine identity from the installed package itself: a
 // nonempty version, no reported errors, the interpreter version, and a
 // platform identity. Anything less is a failure, never a pass.
 export function validateProbeRecord(record, engine = "") {
   assert.ok(record && typeof record === "object", `probe returned no record: ${JSON.stringify(record).slice(0, 300)}`);
   assert.ok(typeof record.version === "string" && record.version.length > 0, `${engine || "engine"} probe returned no version: ${JSON.stringify(record).slice(0, 500)}`);
   const errors = Array.isArray(record.errors) ? record.errors : [];
   assert.equal(errors.length, 0, `${engine || "engine"} probe reported errors: ${errors.join("; ").slice(0, 1000)}`);
   const platform = record.platform_system || record.platform_class || "";
   assert.ok(typeof platform === "string" && platform.length > 0, `${engine || "engine"} probe returned no platform identity (platform_system/platform_class)`);
   assert.ok(typeof record.python_version === "string" && record.python_version.length > 0, `${engine || "engine"} probe returned no python version`);
   return {
     version: record.version,
     variant: record.variant ?? "",
     plugin_version: record.metal_version ?? record.plugin_version ?? "",
     accelerator: record.accelerator ?? "",
     python_version: record.python_version,
     platform,
   };
 }

 export function parseArgs(argv) {
   const args = {
     engine: "",
     task: "chat",
     python: "",
     runtimeId: "",
     runtimeBundle: "",
     model: "",
     revision: "",
     companion: "",
     cli: "",
     port: 18080,
     timeoutMs: 60000,
     startTimeoutMs: 180000,
     out: "",
     keepHome: false,
     selfTest: false,
     expectEmbeddings: false,
     expectMedia: false,
     expectTools: false,
     expectTranscription: false,
     mediaFile: "",
     audioFile: "",
     prompt: "Say OK in five words or fewer.",
     maxTokens: 32,
   };
   for (let i = 0; i < argv.length; i += 1) {
     const token = argv[i];
     const next = () => {
       const value = argv[i + 1];
       assert.ok(value !== undefined && !value.startsWith("--"), `${token} needs a value`);
       i += 1;
       return value;
     };
     if (token === "--engine") args.engine = next();
     else if (token === "--task") {
       const task = next();
       assert.ok(TASKS.includes(task), `--task must be one of ${TASKS.join("|")}`);
       args.task = task;
     } else if (token === "--python") args.python = next();
     else if (token === "--runtime-id") args.runtimeId = next();
     else if (token === "--runtime-bundle") args.runtimeBundle = next();
     else if (token === "--model") args.model = next();
     else if (token === "--revision") args.revision = next();
     else if (token === "--companion") args.companion = next();
     else if (token === "--cli") args.cli = next();
     else if (token === "--port") args.port = Number(next());
     else if (token === "--timeout-ms") args.timeoutMs = Number(next());
     else if (token === "--start-timeout-ms") args.startTimeoutMs = Number(next());
     else if (token === "--out") args.out = next();
     else if (token === "--keep-home") args.keepHome = true;
     else if (token === "--self-test") args.selfTest = true;
     else if (token === "--expect-embeddings") args.expectEmbeddings = true;
     else if (token === "--expect-media") args.expectMedia = true;
     else if (token === "--expect-tools") args.expectTools = true;
     else if (token === "--expect-transcription") args.expectTranscription = true;
     else if (token === "--media-file") args.mediaFile = next();
     else if (token === "--audio-file") args.audioFile = next();
     else if (token === "--prompt") args.prompt = next();
     else if (token === "--max-tokens") args.maxTokens = Number(next());
     else if (token === "--help" || token === "-h") {
       args.help = true;
     } else {
       throw new Error(`unknown argument: ${token}`);
     }
   }
   return args;
 }

 export function helpText() {
   return [
     "Usage:",
     "  node scripts/smoke-provider-runtime.mjs --self-test",
     "  node scripts/smoke-provider-runtime.mjs --engine <vllm|mlx-vlm> --model <path> [--python <path>|--runtime-id <id>|--runtime-bundle <zip>] [--task chat|embedding|transcription] [--revision <sha>] [--companion <path>] [--cli <path>] [--port N] [--out result.json] [--expect-embeddings] [--expect-media] [--expect-tools] [--expect-transcription] [--media-file <image>] [--audio-file <wav>] [--keep-home]",
     "",
     "Inputs are explicit. --model is a local snapshot directory or GGUF file that",
     "already exists; --revision pins the expected HF commit when the model is a",
     "snapshot. Nothing is downloaded and `runtime install` is never invoked.",
     "Task modes keep embedding-only and STT checkpoints from failing mandatory",
     "chat: non-chat tasks record a refused chat as unsupported and require",
     "their own endpoint instead. --expect-* declares the operator verified",
     "support from the model registry/processor; a refused expected capability",
     "is a fail, not unsupported. Shareable JSON never carries user paths,",
     "PIDs or URLs; full local paths appear on the console only.",
   ].join("\n");
 }

 export function createIsolatedHome() {
   const temporary = mkdtempSync(join(tmpdir(), "aiolm-provider-acceptance-"));
   const home = join(temporary, "home with spaces");
   mkdirSync(home, { recursive: true });
   const env = { ...process.env };
   for (const key of Object.keys(env)) {
     if (/^(AIOLM_|LLAMA_BOARD_)/i.test(key)) delete env[key];
   }
   Object.assign(env, {
     HOME: home,
     USERPROFILE: home,
     APPDATA: join(home, "roaming"),
     LOCALAPPDATA: join(home, "local"),
     XDG_CONFIG_HOME: join(home, "config"),
     XDG_DATA_HOME: join(home, "data"),
     XDG_CACHE_HOME: join(home, "cache"),
     AIOLM_HOME: join(home, "aiolm"),
   });
   return { temporary, home, env, aiolmHome: join(home, "aiolm") };
 }

 export function runCli(executable, args, env, timeoutMs = 30000) {
   const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
   if (result.error) throw result.error;
   let body = null;
   try {
     body = JSON.parse(result.stdout);
   } catch {
     throw new Error(`${args.join(" ")} emitted non-JSON output (status ${result.status}): ${(result.stdout ?? "").slice(0, 1000)} ${(result.stderr ?? "").slice(0, 1000)}`);
   }
   if (result.status !== 0) {
     throw new Error(`${args.join(" ")} failed: ${body?.error ?? result.stdout.slice(0, 1000)}`);
   }
   return body;
 }

 export function inspectModelInput(modelPath, expectedRevision = "") {
   const evidence = { path: modelPath };
   if (!existsSync(modelPath)) {
     return { ok: false, kind: "missing", evidence, detail: `model path does not exist: ${modelPath}` };
   }
   const stat = statSync(modelPath);
   evidence.isDirectory = stat.isDirectory();
   evidence.isFile = stat.isFile();
   evidence.sizeBytes = stat.size;
   if (stat.isFile()) {
     evidence.kind = "gguf-file";
     if (expectedRevision) {
       return { ok: false, kind: "gguf-file", evidence, detail: "--revision applies to snapshot directories, not GGUF files" };
     }
     return { ok: true, kind: "gguf-file", evidence, detail: `GGUF file present (${stat.size} bytes)` };
   }
   // Snapshot directory: record manifest identity without downloading.
   const manifestPath = join(modelPath, ".aiolm-snapshot.json");
   if (existsSync(manifestPath)) {
     try {
       const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
       evidence.manifest = {
         repository: manifest.repository ?? "",
         revision: manifest.revision ?? "",
         complete: manifest.complete ?? false,
         files: Array.isArray(manifest.files) ? manifest.files.length : 0,
       };
       if (expectedRevision && manifest.revision !== expectedRevision) {
         return { ok: false, kind: "snapshot", evidence, detail: `snapshot revision ${manifest.revision} does not match --revision ${expectedRevision}` };
       }
       if (manifest.complete === false) {
         return { ok: true, kind: "snapshot-incomplete", evidence, detail: "snapshot manifest reports incomplete; server launch must refuse with readiness" };
       }
       return { ok: true, kind: "snapshot", evidence, detail: `snapshot ${manifest.repository ?? ""}@${manifest.revision ?? ""} with ${evidence.manifest.files} manifest files` };
     } catch (error) {
       return { ok: false, kind: "snapshot", evidence, detail: `cannot parse snapshot manifest: ${error.message}` };
     }
   }
   const configPath = join(modelPath, "config.json");
   evidence.hasConfig = existsSync(configPath);
   // An immutable revision is proved by an authoritative app manifest or
   // the standard Hub cache snapshots/<full-sha> path, never a guessed
   // substring of a directory name.
   if (expectedRevision) {
     const parts = modelPath.split(/[/\\]/);
     const revision = parts.at(-2) === 'snapshots' && /^[a-f0-9]{40}$/i.test(parts.at(-1) ?? '') ? parts.at(-1) : null;
     evidence.expectedRevision = expectedRevision;
     if (revision?.toLowerCase() !== expectedRevision.toLowerCase()) {
       return { ok: false, kind: "external-snapshot", evidence, detail: "cannot verify --revision: provide an app snapshot manifest or the exact Hub cache snapshots/<full-sha> directory" };
     }
     evidence.revision = revision;
   }
   return { ok: true, kind: "external-snapshot", evidence, detail: "external snapshot directory without app manifest; launch decides compatibility" };
 }

 // Shareable-JSON hygiene: basenames keep debuggability without user paths,
 // and error/detail strings are scrubbed of absolute paths and PIDs.
 export function basenameOf(value) {
   if (!value) return null;
   const base = String(value).split(/[/\\]/).pop() ?? "";
   return base.length > 0 ? base : null;
 }

export function redactPathsInString(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/https?:\/\/[^\s"'`,;]*/g, "[redacted-url]")
    .replace(/[A-Za-z]:\\[^\s"'`,;]*/g, "[redacted-path]")
    .replace(/(?<![\w/.-])\/(?:Users|home|data|tmp|var|etc|opt|usr|mnt|media|private)[^\s"'`,;]*/g, "[redacted-path]")
    .replace(/\bpid\s+\d+/gi, "pid [redacted]");
}

 // The file written via --out must never carry user model/Python paths, PIDs
 // or URLs. Internal evidence avoids them by construction (basenames only, no
 // pid/url keys), and this pass defensively redacts every string so a future
 // CLI error that embeds a path cannot leak into shareable JSON.
export function sanitizeResultForFile(result) {
  const copy = JSON.parse(JSON.stringify(result));
  const sensitiveKeys = new Set([
    "pid", "url", "location", "log_path", "logPath", "state_file", "stateFile",
    "executable", "home", "isolatedHome",
  ]);
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (sensitiveKeys.has(key)) {
          node[key] = "[redacted]";
          continue;
        }
        if (typeof value === "string") {
          // A bare "path" keeps relative names (manifest file lists) but
          // never absolute user paths; everything else is scrubbed textually.
          node[key] = key === "path" && /[/\\]/.test(value)
            ? (basenameOf(value) ?? "[redacted]")
            : redactPathsInString(value);
        } else {
          walk(value);
        }
      }
    }
  };
  walk(copy);
  return copy;
}

 async function fetchJson(url, init = {}, timeoutMs = 60000) {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms: ${url}`)), timeoutMs);
   try {
     const response = await fetch(url, { ...init, signal: init.signal ?? controller.signal });
     const text = await response.text();
     let body = null;
     try {
       body = text ? JSON.parse(text) : null;
     } catch {
       body = { _raw: text.slice(0, 2000) };
     }
     return { status: response.status, ok: response.ok, body };
   } finally {
     clearTimeout(timer);
   }
 }

 // vLLM only returns usage on streams when the client asks for it, so every
 // streamed chat request carries stream_options.include_usage.
 export async function readChatStream(url, payload, timeoutMs) {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(new Error("stream timeout")), timeoutMs);
   try {
     const response = await fetch(url, {
       method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ ...payload, stream: true, stream_options: { ...(payload.stream_options ?? {}), include_usage: true } }),
       signal: controller.signal,
     });
     const text = await response.text();
     if (!response.ok) {
       let body = null;
       try {
         body = JSON.parse(text);
       } catch {
         body = { _raw: text.slice(0, 1000) };
       }
       return { ok: false, status: response.status, body, events: [], usage: null };
     }
     const events = [];
     let usage = null;
     for (const chunk of text.split("\n")) {
       const line = chunk.trim();
       if (!line.startsWith("data:")) continue;
       const data = line.slice(5).trim();
       if (data === "[DONE]") continue;
       try {
         const event = JSON.parse(data);
         events.push(event);
         if (event?.usage) usage = event.usage;
       } catch {
         // Non-JSON SSE payloads are recorded as stream corruption.
       }
     }
     return { ok: true, status: response.status, body: null, events, usage, rawBytes: text.length };
   } finally {
     clearTimeout(timer);
   }
 }

 // Honest cancellation: read the open stream body and abort it mid-body, so
 // the server observes a cancelled stream. Awaiting only fetch headers would
 // resolve before the body completes and prove nothing. Returns the refusal
 // when the server rejects chat outright, so non-chat tasks can record unrun
 // instead of inventing a cancel verdict.
 export async function cancelChatStreamAndRecover(url, payload, timeoutMs, cancelAfterMs = 500) {
   const response = await fetch(url, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
   });
   if (!response.ok) {
     const text = await response.text();
     let body = null;
     try {
       body = JSON.parse(text);
     } catch {
       body = { _raw: text.slice(0, 1000) };
     }
     return { cancelled: false, refused: { status: response.status, body }, after: null };
   }
   const reader = response.body.getReader();
   let timerFired = false;
   const timer = setTimeout(() => {
     timerFired = true;
     try {
       reader.cancel(new Error("harness cancel"));
     } catch {
       // The reader already settled; the outcome below tells the story.
     }
   }, cancelAfterMs);
   let sawData = false;
   let completedEarly = false;
   try {
     for (;;) {
       const next = await reader.read();
       if (next.done) {
         completedEarly = !timerFired;
         break;
       }
       sawData = true;
     }
   } catch {
     // A read error after the cancel timer fired is the expected abort.
   } finally {
     clearTimeout(timer);
   }
   const cancelled = timerFired && !completedEarly;
   const after = await readChatStream(url, { ...payload, max_tokens: 8 }, timeoutMs);
   return { cancelled, sawData, completedEarly, refused: null, after };
 }

 // A 0.1s silent 8kHz mono WAV for transcription probes. Real voices need a
 // supplied --audio-file; this fixture only proves endpoint wiring.
 export function syntheticSilentWav() {
   const samples = 800;
   const header = Buffer.alloc(44);
   header.write("RIFF", 0);
   header.writeUInt32LE(36 + samples * 2, 4);
   header.write("WAVE", 8);
   header.write("fmt ", 12);
   header.writeUInt32LE(16, 16);
   header.writeUInt16LE(1, 20);
   header.writeUInt16LE(1, 22);
   header.writeUInt32LE(8000, 24);
   header.writeUInt32LE(16000, 28);
   header.writeUInt16LE(2, 32);
   header.writeUInt16LE(16, 34);
   header.write("data", 36);
   header.writeUInt32LE(samples * 2, 40);
   return Buffer.concat([header, Buffer.alloc(samples * 2)]);
 }

 export async function probeTranscription(base, alias, { audioFile = "", timeoutMs = 60000 } = {}) {
   const bytes = audioFile ? readFileSync(resolve(audioFile)) : syntheticSilentWav();
   const form = new FormData();
   form.append("model", alias);
   form.append("file", new Blob([bytes], { type: "audio/wav" }), "acceptance-probe.wav");
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(new Error("transcription timeout")), timeoutMs);
   try {
     const response = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form, signal: controller.signal });
     const text = await response.text();
     let body = null;
     try {
       body = text ? JSON.parse(text) : null;
     } catch {
       body = { _raw: text.slice(0, 1000) };
     }
     if (!response.ok) return { ok: false, status: response.status, body, transcript: "" };
     const transcript = typeof body?.text === "string" ? body.text : "";
     return { ok: true, status: response.status, body, transcript };
   } finally {
     clearTimeout(timer);
   }
 }

 const TINY_PNG_DATA_URI =
   "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

 function imagePartFor(args) {
   if (args.mediaFile) {
     const bytes = readFileSync(resolve(args.mediaFile));
     const lower = args.mediaFile.toLowerCase();
     const mime = lower.endsWith(".jpg") || lower.endsWith(".jpeg")
       ? "image/jpeg"
       : lower.endsWith(".webp")
         ? "image/webp"
         : lower.endsWith(".mp4")
           ? "video/mp4"
           : "image/png";
     return { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } };
   }
   return { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } };
 }

 export function resultSkeleton(args, host) {
   return {
     schema: RESULT_SCHEMA,
     harness: "scripts/smoke-provider-runtime.mjs",
     synthetic: false,
     live: false,
     host,
     task: args.task,
     inputs: {
       engine: args.engine,
       task: args.task,
       python: basenameOf(args.python),
       runtimeId: args.runtimeId || null,
       runtimeBundle: args.runtimeBundle ? basenameOf(args.runtimeBundle) : null,
       model: basenameOf(args.model),
       revision: args.revision || null,
       companion: basenameOf(args.companion),
       cli: basenameOf(args.cli),
       port: args.port,
       expectations: {
         embeddings: Boolean(args.expectEmbeddings) || args.task === "embedding",
         media: Boolean(args.expectMedia),
         tools: Boolean(args.expectTools),
         transcription: Boolean(args.expectTranscription) || args.task === "transcription",
       },
       mediaFile: Boolean(args.mediaFile),
       audioFile: Boolean(args.audioFile),
     },
     checks: newChecks(),
     summary: null,
   };
 }

 async function runSelfTest() {
   // Synthetic wiring check with a loopback fake engine. No real CLI, model
   // or accelerator is touched, and the result is marked synthetic so it can
   // never be mistaken for a Linux/macOS native pass.
   const checks = newChecks();
   const evidenceNote = "synthetic loopback fixture";
   let lastChatPayload = null;
   const server = createServer((req, res) => {
     if (req.url === "/health") {
       res.writeHead(200, { "content-type": "application/json" });
       res.end(JSON.stringify({ status: "ok" }));
     } else if (req.url === "/v1/models") {
       res.writeHead(200, { "content-type": "application/json" });
       res.end(JSON.stringify({ data: [{ id: "synthetic-alias" }] }));
     } else if (req.url === "/v1/chat/completions") {
       let body = "";
       req.on("data", (chunk) => { body += chunk; });
       req.on("end", () => {
         const payload = JSON.parse(body || "{}");
         lastChatPayload = payload;
         const text = JSON.stringify(payload);
         if (text.includes("file://")) {
           res.writeHead(400, { "content-type": "application/json" });
           res.end(JSON.stringify({ error: { code: "unsupported_input", message: "Local paths are refused." } }));
           return;
         }
         if (Array.isArray(payload.tools) && payload.tools.length > 0) {
           res.writeHead(200, { "content-type": "application/json" });
           res.end(JSON.stringify({
             choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } }] } }],
             usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
           }));
           return;
         }
         const hasImage = text.includes("image_url");
         if (hasImage && payload.stream === false) {
           res.writeHead(400, { "content-type": "application/json" });
           res.end(JSON.stringify({ error: { code: "unsupported_media", message: "This synthetic model is text-only." } }));
           return;
         }
         // Slow final chunk for large streams so the cancel probe aborts an
         // open body instead of racing a completed one.
         const slow = Number(payload.max_tokens ?? 0) >= 64;
         const head =
           `data: ${JSON.stringify({ choices: [{ delta: { content: "synthetic " } }] })}\n\n`;
         const tail =
           `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`
           + "data: [DONE]\n\n";
         res.writeHead(200, { "content-type": "text/event-stream" });
         res.write(head);
         if (slow) {
           setTimeout(() => { res.end(tail); }, 1500);
         } else {
           res.end(tail);
         }
       });
     } else if (req.url === "/v1/embeddings") {
       res.writeHead(400, { "content-type": "application/json" });
       res.end(JSON.stringify({ error: { code: "unsupported", message: "no embedding model declared" } }));
     } else if (req.url === "/v1/audio/transcriptions") {
       req.resume();
       req.on("end", () => {
         res.writeHead(200, { "content-type": "application/json" });
         res.end(JSON.stringify({ text: "synthetic transcript" }));
       });
     } else {
       res.writeHead(404);
       res.end();
     }
   });
   await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
   const port = server.address().port;
   const base = `http://127.0.0.1:${port}`;
   try {
     const health = await fetchJson(`${base}/health`, {}, 5000);
     setCheck(checks, "server_launch", health.ok ? "pass" : "fail", `synthetic health ${health.status}`, { evidenceNote });
     const models = await fetchJson(`${base}/v1/models`, {}, 5000);
     const aliases = assertModelsAlias(models.body);
     setCheck(checks, "model_alias", "pass", `synthetic alias ${aliases[0]}`, { evidenceNote });
     const stream = await readChatStream(`${base}/v1/chat/completions`, { model: aliases[0], messages: [{ role: "user", content: "hi" }] }, 5000);
     assert.ok(stream.ok, "synthetic stream must succeed");
     assertStreamEvents(stream.events);
     assertUsagePresent({ usage: stream.usage }, "synthetic");
     assert.equal(lastChatPayload?.stream_options?.include_usage, true, "chat streams must request stream_options.include_usage");
     setCheck(checks, "stream_text_usage", "pass", "synthetic streamed text with authoritative usage", { evidenceNote });
     // Cancellation aborts an open stream body, then the server recovers.
     const cancel = await cancelChatStreamAndRecover(
       `${base}/v1/chat/completions`,
       { model: aliases[0], messages: [{ role: "user", content: "hi" }], max_tokens: 64 },
       5000,
       100,
     );
     assert.ok(!cancel.refused, "synthetic chat must accept the cancel probe");
     assert.ok(cancel.cancelled, "synthetic cancel must abort the open stream body");
     assert.ok(cancel.after?.ok, "server must answer after the abort");
     assertUsagePresent({ usage: cancel.after.usage }, "synthetic post-cancel");
     setCheck(checks, "cancel", "pass", "synthetic mid-body abort followed by a fresh request", { evidenceNote });
     const mediaUnsupported = await fetchJson(`${base}/v1/chat/completions`, {
       method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ model: aliases[0], messages: [{ role: "user", content: [{ type: "text", text: "Describe this pixel." }, { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }] }], max_tokens: 16, stream: false }),
     }, 5000);
     setCheck(checks, "media_supported", !mediaUnsupported.ok ? "unsupported" : "pass", `synthetic image status ${mediaUnsupported.status}`, { evidenceNote });
     const refusal = await fetchJson(`${base}/v1/chat/completions`, {
       method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ model: aliases[0], messages: [{ role: "user", content: [{ type: "text", text: "Read this." }, { type: "image_url", image_url: { url: "file:///etc/hostname" } }] }] }),
     }, 5000);
     setCheck(checks, "media_refusal", !refusal.ok ? "pass" : "fail", `synthetic engine file:// refusal status ${refusal.status}`, { evidenceNote });
     const tools = await fetchJson(`${base}/v1/chat/completions`, {
       method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({
         model: aliases[0],
         messages: [{ role: "user", content: "What time is it?" }],
         tools: [{ type: "function", function: { name: "get_time", description: "Return the current time.", parameters: { type: "object", properties: {} } } }],
         tool_choice: "auto",
         max_tokens: 32,
         stream: false,
       }),
     }, 5000);
     if (tools.ok) {
       const message = tools.body?.choices?.[0]?.message ?? {};
       const called = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
       setCheck(checks, "tools", "pass", called ? "synthetic tool call returned" : "synthetic tools accepted; model answered with text", { evidenceNote, toolsAccepted: true, toolCalled: called });
     } else {
       setCheck(checks, "tools", "fail", `synthetic tools status ${tools.status}`, { evidenceNote });
     }
     const embeddings = await fetchJson(`${base}/v1/embeddings`, {
       method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ model: aliases[0], input: "hello" }),
     }, 5000);
     setCheck(checks, "embeddings", !embeddings.ok ? "unsupported" : "pass", `synthetic embeddings status ${embeddings.status}`, { evidenceNote });
     const transcription = await probeTranscription(base, aliases[0], { timeoutMs: 5000 });
     if (transcription.ok && transcription.transcript.trim().length > 0) {
       setCheck(checks, "transcription", "pass", "synthetic transcription returned text", { evidenceNote });
     } else {
       setCheck(checks, "transcription", "fail", `synthetic transcription status ${transcription.status}`, { evidenceNote });
     }
     // Statuses that need a real engine stay unrun in synthetic mode.
     for (const name of ["platform", "registration", "probe", "runtime_identity", "config_selection", "model_validation", "restart", "stop", "benchmark", "deep_verification", "cleanup"]) {
       if (checks[name].status === "unrun") {
         setCheck(checks, name, name === "platform" ? "pass" : "unrun", name === "platform" ? "synthetic host check" : "needs a real engine; not attempted synthetically", { evidenceNote });
       }
     }
     const summary = summarize(checks);
     return { schema: RESULT_SCHEMA, harness: "scripts/smoke-provider-runtime.mjs", synthetic: true, live: false, checks, summary };
   } finally {
     server.close();
   }
 }

 // Test-only injection point (no production effect): opts.platform/arch
 // override the gate, opts.cliPrefix prepends a fake CLI script when the
 // executable is the Node binary, and opts.extraEnv reaches the child CLI.
 export async function runLive(args, opts = {}) {
   const host = {
     platform: process.platform,
     arch: process.arch,
     node: process.version,
   };
   const result = resultSkeleton(args, host);
   const checks = result.checks;
   let isolated = null;
   let liveStarted = false;
   let serverRunning = false;
   let base = "";
   let servedAlias = "";
   const gatePlatform = opts.platform ?? process.platform;
   const gateArch = opts.arch ?? process.arch;
   const cliPrefix = opts.cliPrefix ?? [];
   const extraEnv = opts.extraEnv ?? {};
   const executable = resolve(args.cli || `.codex-target/debug/aiolm-cli${process.platform === "win32" ? ".exe" : ""}`);
   // Full local paths live in these locals only. The shareable result keeps
   // basenames; full paths reach the console alone (see --keep-home logging).
   const fullPython = args.python ? resolve(args.python) : "";
   const fullModel = args.model ? resolve(args.model) : "";
   const fullCompanion = args.companion ? resolve(args.companion) : "";
   const task = args.task || "chat";
   const chatRefusalIsUnsupported = task !== "chat";

   try {
     // 0. Platform gate: report blocked before touching any engine.
     const gate = platformAllowsEngine(args.engine, gatePlatform, gateArch);
     host.platformDetail = gate.detail;
     host.gate = `${gatePlatform}/${gateArch}`;
     if (!gate.allowed) {
       setCheck(checks, "platform", "blocked", gate.detail, {});
       for (const name of CHECKS) {
         if (name !== "platform" && checks[name].status === "unrun") {
           setCheck(checks, name, name === "cleanup" ? "pass" : "unrun", name === "cleanup" ? "nothing to clean" : "blocked by platform gate", {});
         }
       }
       setCheck(checks, "cleanup", "pass", "no live resources were created", {});
       result.summary = summarize(checks);
       result.live = false;
       return result;
     }
     setCheck(checks, "platform", "pass", gate.detail, {});

     // 1. Explicit inputs: every missing input records its failing check, so
     // a mis-invocation can never summarize as pass.
     if (!args.engine || !["vllm", "mlx-vlm"].includes(args.engine)) {
       setCheck(checks, "platform", "fail", `select --engine vllm or --engine mlx-vlm (got ${args.engine || "none"})`, {});
       throw new Error("select --engine vllm or --engine mlx-vlm");
     }
     if (!TASKS.includes(task)) {
       setCheck(checks, "platform", "fail", `select --task ${TASKS.join("|")} (got ${task})`, {});
       throw new Error(`select --task ${TASKS.join("|")}`);
     }
     if (!args.model) {
       setCheck(checks, "model_validation", "fail", "supply --model <existing snapshot dir or GGUF file>", {});
       throw new Error("supply --model <existing snapshot dir or GGUF file>");
     }
     if (args.runtimeBundle && (args.runtimeId || args.python)) {
       setCheck(checks, "registration", "fail", "--runtime-bundle must be used without --python or --runtime-id", {});
       throw new Error("--runtime-bundle must be used without --python or --runtime-id");
     }
     if (!args.runtimeId && !args.python && !args.runtimeBundle) {
       setCheck(checks, "registration", "fail", "supply --python <interpreter> to register or --runtime-id <id> to reuse", {});
       throw new Error("supply --python <interpreter> to register or --runtime-id <id> to reuse");
     }
     if (!existsSync(executable)) {
       setCheck(checks, "server_launch", "fail", "CLI binary not found; supply --cli <path to aiolm-cli>", { cli: basenameOf(args.cli) });
       throw new Error("CLI binary not found; supply --cli <path to aiolm-cli>");
     }
    const inspected = inspectModelInput(fullModel, args.revision);
    if (!inspected.ok) {
      const safeEvidence = { ...inspected.evidence };
      delete safeEvidence.path;
      setCheck(checks, "model_validation", "fail", inspected.detail, safeEvidence);
      throw new Error(redactPathsInString(inspected.detail));
    }
     if (args.revision && !/^[0-9a-fA-F]{40}$/.test(args.revision)) {
       setCheck(checks, "model_validation", "fail", "--revision must be a 40-character commit sha", {});
       throw new Error("--revision must be a 40-character commit sha");
     }
     if (args.companion && !existsSync(fullCompanion)) {
       setCheck(checks, "model_validation", "fail", "companion path does not exist", { companion: basenameOf(args.companion) });
       throw new Error("companion path does not exist");
     }
     if (args.python && !existsSync(fullPython)) {
       setCheck(checks, "registration", "fail", "python interpreter not found", { engine: args.engine });
       throw new Error("python interpreter not found");
     }
     if (args.runtimeBundle && (!existsSync(resolve(args.runtimeBundle)) || !statSync(resolve(args.runtimeBundle)).isFile())) {
       setCheck(checks, "registration", "fail", "runtime bundle is not an existing file", {});
       throw new Error("runtime bundle is not an existing file");
     }
     if (args.mediaFile && !existsSync(resolve(args.mediaFile))) {
       setCheck(checks, "media_supported", "fail", "media file does not exist", { mediaFile: basenameOf(args.mediaFile) });
       throw new Error("media file does not exist");
     }
     if (args.audioFile && !existsSync(resolve(args.audioFile))) {
       setCheck(checks, "transcription", "fail", "audio file does not exist", { audioFile: basenameOf(args.audioFile) });
       throw new Error("audio file does not exist");
     }
     if (!Number.isFinite(args.port) || args.port < 1 || args.port > 65535) {
       setCheck(checks, "config_selection", "fail", `invalid --port ${args.port}`, {});
       throw new Error(`invalid --port ${args.port}`);
     }
     const expectedIncomplete = inspected.kind === "snapshot-incomplete";

     // 2. Isolated home: the only state this harness writes.
     isolated = createIsolatedHome();
     base = `http://127.0.0.1:${args.port}`;
     const env = { ...isolated.env, ...extraEnv };
     const run = (cliArgs, timeoutMs = 30000) => runCli(executable, [...cliPrefix, ...cliArgs], env, timeoutMs);

     // 3. Registration: probe an explicitly supplied interpreter. Managed
     // install (which downloads) is out of scope and never invoked here.
     // A --runtime-id reuse cannot resolve against a fresh isolated home
     // (which starts with no manifests and never copies the real user home):
     // presence is verified at probe/runtime_identity below, so reuse of an
     // unknown id fails there honestly. Prefer --python registration; a
     // A supplied bundle is imported offline directly into this isolated home.
     let runtimeId = args.runtimeId;
     if (!runtimeId) {
       try {
         const registered = args.runtimeBundle
           ? run(["runtime", "import", resolve(args.runtimeBundle)], Math.max(180000, args.startTimeoutMs))
           : run(["runtime", "register", args.engine, fullPython], 180000);
         if (args.runtimeBundle) assert.equal(registered?.provider, args.engine, "imported runtime belongs to another engine");
         runtimeId = registered?.id ?? registered?.runtime?.id ?? "";
         assert.ok(runtimeId, `registration must return a runtime id: ${JSON.stringify(registered).slice(0, 500)}`);
         setCheck(checks, "registration", "pass", `${args.runtimeBundle ? 'imported offline' : 'registered'} ${args.engine} runtime ${runtimeId}`, { runtimeId, engine: args.engine, source: args.runtimeBundle ? 'portable-bundle' : 'interpreter' });
       } catch (error) {
         setCheck(checks, "registration", "fail", error.message, { engine: args.engine });
         throw error;
       }
     } else {
       setCheck(checks, "registration", "pass", `reusing explicitly supplied runtime ${runtimeId}; isolated home starts empty so presence is verified at probe/runtime_identity below`, { runtimeId, engine: args.engine });
     }
     result.inputs.runtimeId = runtimeId;

     // 4. Probe + runtime identity: version, variant, accelerator and platform
     // come from the installed engine itself, never from a guess. A probe
     // with errors or without platform identity is a failure, never a pass.
     try {
       const probe = run(["runtime", "probe", args.engine, runtimeId], 180000);
       const record = probe?.probe ?? probe;
       const identity = validateProbeRecord(record, args.engine);
       const evidence = {
         version: identity.version,
         variant: identity.variant,
         plugin_version: identity.plugin_version,
         accelerator: identity.accelerator,
         python_version: identity.python_version,
         platform: identity.platform,
       };
       setCheck(checks, "probe", "pass", `${args.engine} ${evidence.version}${evidence.variant ? ` variant ${evidence.variant}` : ""} accelerator ${evidence.accelerator || "unknown"} platform ${evidence.platform}`, evidence);
       result.probe = evidence;
     } catch (error) {
       if (checks.probe.status === "unrun") setCheck(checks, "probe", "fail", error.message, {});
       throw error;
     }

     try {
       const listed = run(["runtime", "list"], 30000);
       const instances = Array.isArray(listed) ? listed : listed?.runtimes ?? [];
       const match = instances.find((item) => item?.id === runtimeId && (item?.provider === args.engine || item?.provider?.includes?.(args.engine)));
       if (!match) {
         setCheck(checks, "runtime_identity", "fail", `runtime ${runtimeId} absent from runtime list in this isolated home (${instances.length} listed)`, { count: instances.length });
         throw new Error(`runtime ${runtimeId} absent from runtime list`);
       }
       const evidence = {
         id: match.id,
         provider: match.provider,
         version: match.version ?? "",
         variant: match.variant ?? "",
         plugin_version: match.plugin_version ?? "",
         accelerator: match.accelerator ?? "",
         installation: match.installation ?? "",
         available: match.available ?? false,
         problems: match.problems ?? [],
       };
       if (!evidence.available) {
         setCheck(checks, "runtime_identity", "fail", `runtime not ready: ${(evidence.problems || []).join("; ").slice(0, 1000)}`, { available: false, problems: evidence.problems });
         throw new Error(`runtime not ready: ${(evidence.problems || []).join("; ")}`);
       }
       setCheck(checks, "runtime_identity", "pass", `${evidence.provider} ${evidence.id} ${evidence.version ?? ""} (${evidence.installation}, ${evidence.accelerator || "unknown accelerator"})`, evidence);
       result.runtime = evidence;
     } catch (error) {
       if (checks.runtime_identity.status === "unrun") setCheck(checks, "runtime_identity", "fail", error.message, {});
       throw error;
     }

     // 5. Config/profile selection: runtime pair first, then model and port.
     // Provider options are left at engine defaults; unsupported values saved
     // here would fail launch validation by design.
     let declaredEmbeddingModel = "";
     try {
       run(["runtime", "select", args.engine, runtimeId], 30000);
       run(["config", "set", "active_model", fullModel], 30000);
       run(["config", "set", "port", String(args.port)], 30000);
       const config = run(["config", "get"], 30000);
       assert.equal(config?.active_model, fullModel, "active_model must round-trip");
       assert.equal(Number(config?.port), args.port, "port must round-trip");
       const providerOptions = config?.provider_options?.[args.engine] ?? {};
       if (typeof providerOptions?.embedding_model === "string" && providerOptions.embedding_model.length > 0) {
         declaredEmbeddingModel = providerOptions.embedding_model;
       }
       const doctor = run(["doctor"], 120000);
       const evidence = {
         provider: doctor?.provider ?? "",
         runtime: doctor?.runtime ?? "",
         runtime_ready: doctor?.runtime_ready ?? false,
         readiness_source: doctor?.readiness_source ?? "",
         runtime_problem: doctor?.runtime_problem ?? "",
       };
       if (!evidence.runtime_ready) {
         setCheck(checks, "config_selection", "fail", `doctor reports runtime not ready: ${evidence.runtime_problem || "unknown reason"}`, evidence);
         throw new Error(`doctor reports runtime not ready: ${evidence.runtime_problem}`);
       }
       setCheck(checks, "config_selection", "pass", `selected ${evidence.provider} runtime ${evidence.runtime} via ${evidence.readiness_source}`, evidence);
       result.doctor = evidence;
     } catch (error) {
       if (checks.config_selection.status === "unrun") setCheck(checks, "config_selection", "fail", error.message, {});
       throw error;
     }

     // 6. Model validation: existence plus manifest identity. Full tensor and
     // loader checks happen at server start. The immutable revision is only
     // meaningful from an authoritative manifest; external snapshots without
     // one keep their pin unverified (see inspectModelInput).
    {
      const safeEvidence = { ...inspected.evidence };
      delete safeEvidence.path;
      setCheck(checks, "model_validation", "pass", inspected.detail, { ...safeEvidence, kind: inspected.kind });
    }
     result.model = { kind: inspected.kind, complete: inspected.evidence.manifest?.complete ?? null };

     // 7. Live server launch. From here on, failures are failures: never
     // converted to skips. An incomplete snapshot is the explicit negative
     // fixture: the server must refuse it, and that refusal is the pass.
     liveStarted = true;
     result.live = true;
     try {
       run(["server", "start"], args.startTimeoutMs);
       serverRunning = true;
     } catch (error) {
       serverRunning = false;
       if (expectedIncomplete && /incomplete|not complete|readiness|missing|not ready|complete:false/i.test(error.message)) {
         setCheck(checks, "server_launch", "pass", `refused incomplete snapshot as expected: ${error.message.slice(0, 300)}`, { negativeFixture: true });
         for (const name of ["model_alias", "stream_text_usage", "cancel", "restart", "stop", "media_supported", "media_refusal", "tools", "embeddings", "transcription"]) {
           setCheck(checks, name, "unrun", "not attempted: incomplete snapshot refused at launch", {});
         }
         setCheck(checks, "benchmark", "unrun", "not attempted: incomplete snapshot refused at launch", {});
         setCheck(checks, "deep_verification", "unrun", "not attempted: incomplete snapshot refused at launch", {});
         result.summary = summarize(checks);
         return result;
       }
       setCheck(checks, "server_launch", "fail", error.message, {});
       throw error;
     }

     const status = run(["server", "status"], 30000);
     if (status?.state !== "running" || status?.health !== true) {
       setCheck(checks, "server_launch", "fail", `server status not healthy: ${JSON.stringify(status).slice(0, 1000)}`, { state: status?.state ?? "unknown", health: status?.health ?? false });
       throw new Error(`server status not healthy: ${JSON.stringify(status)}`);
     }
     setCheck(checks, "server_launch", "pass", `server reached running state with healthy status on loopback port ${args.port}`, { port: args.port, state: status.state, health: true });

     // 8. Model alias + readiness over HTTP.
     try {
       const models = await fetchJson(`${base}/v1/models`, {}, args.timeoutMs);
       if (!models.ok) {
         setCheck(checks, "model_alias", "fail", `GET /v1/models status ${models.status}: ${JSON.stringify(models.body).slice(0, 1000)}`, { status: models.status });
         throw new Error(`GET /v1/models failed with ${models.status}`);
       }
       const aliases = assertModelsAlias(models.body);
       servedAlias = aliases[0];
       setCheck(checks, "model_alias", "pass", `served alias ${servedAlias} (${aliases.length} listed)`, { aliases, count: aliases.length });
       result.servedAlias = servedAlias;
     } catch (error) {
       if (checks.model_alias.status === "unrun") setCheck(checks, "model_alias", "fail", error.message, {});
       throw error;
     }

     // 9. Task-specific text/embedding/transcription paths. Embedding-only
     // and STT checkpoints must not fail a mandatory chat they never
     // claimed: their chat refusal is unsupported, and their own endpoint
     // carries the verdict instead.
     if (task === "chat") {
       try {
         const stream = await readChatStream(`${base}/v1/chat/completions`, {
           model: servedAlias,
           messages: [{ role: "user", content: args.prompt }],
           max_tokens: args.maxTokens,
         }, args.timeoutMs);
         if (!stream.ok) {
           setCheck(checks, "stream_text_usage", "fail", `chat completions status ${stream.status}: ${JSON.stringify(stream.body).slice(0, 1000)}`, { status: stream.status });
           throw new Error(`chat completions failed with ${stream.status}`);
         }
         const text = assertStreamEvents(stream.events);
         const usage = assertUsagePresent({ usage: stream.usage }, "streamed chat");
         setCheck(checks, "stream_text_usage", "pass", `streamed ${text.length} chars; usage ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`, { usage, chars: text.length, rawBytes: stream.rawBytes });
         result.usage = usage;
       } catch (error) {
         if (checks.stream_text_usage.status === "unrun") setCheck(checks, "stream_text_usage", "fail", error.message, {});
         throw error;
       }
     } else {
       try {
         const probe = await readChatStream(`${base}/v1/chat/completions`, {
           model: servedAlias,
           messages: [{ role: "user", content: args.prompt }],
           max_tokens: 8,
         }, args.timeoutMs);
         if (probe.ok) {
           const text = assertStreamEvents(probe.events);
           const usage = assertUsagePresent({ usage: probe.usage }, "streamed chat");
           setCheck(checks, "stream_text_usage", "pass", `streamed ${text.length} chars although task=${task}; usage recorded`, { usage, chars: text.length });
           result.usage = usage;
         } else if (probe.status === 400 || probe.status === 404 || probe.status === 422) {
           setCheck(checks, "stream_text_usage", "unsupported", `${task} checkpoint refused chat (${probe.status}): ${JSON.stringify(probe.body).slice(0, 300)}`, { status: probe.status });
         } else {
           setCheck(checks, "stream_text_usage", "fail", `chat probe status ${probe.status}: ${JSON.stringify(probe.body).slice(0, 500)}`, { status: probe.status });
           throw new Error(`chat probe failed with ${probe.status}`);
         }
       } catch (error) {
         if (checks.stream_text_usage.status === "unrun") setCheck(checks, "stream_text_usage", "fail", error.message, {});
         throw error;
       }
     }

     // 10. Cancellation: abort one open stream body, then prove the server
     // still answers. Needs a chat stream; when the task checkpoint refuses
     // chat, cancellation stays unrun instead of inventing coverage.
     if (checks.stream_text_usage.status === "unsupported") {
       setCheck(checks, "cancel", "unrun", "chat refused for this task; stream cancellation not demonstrated", {});
     } else {
       try {
         const cancel = await cancelChatStreamAndRecover(`${base}/v1/chat/completions`, {
           model: servedAlias,
           messages: [{ role: "user", content: args.prompt }],
           max_tokens: Math.max(args.maxTokens, 64),
         }, args.timeoutMs, 500);
         if (cancel.refused) {
           if (chatRefusalIsUnsupported && [400, 404, 422].includes(cancel.refused.status)) {
             setCheck(checks, "cancel", "unrun", `chat refused for this task (${cancel.refused.status}); cancellation not demonstrated`, { status: cancel.refused.status });
           } else {
             setCheck(checks, "cancel", "fail", `cancel probe refused with ${cancel.refused.status}`, { status: cancel.refused.status });
             throw new Error(`cancel probe refused with ${cancel.refused.status}`);
           }
         } else if (!cancel.cancelled) {
           const reason = cancel.completedEarly
             ? "stream completed before the cancel window; rerun with larger --max-tokens to demonstrate cancellation"
             : "cancel did not abort the open stream body";
           setCheck(checks, "cancel", "fail", reason, { sawData: cancel.sawData, completedEarly: cancel.completedEarly });
           throw new Error(reason);
         } else {
           const after = cancel.after;
           if (!after?.ok || !after.events.length) {
             setCheck(checks, "cancel", "fail", "server did not answer after client abort", {});
             throw new Error("server did not answer after client abort");
           }
           assertUsagePresent({ usage: after.usage }, "post-cancel chat");
           setCheck(checks, "cancel", "pass", "aborted one open stream mid-body; next request completed with usage", { sawData: cancel.sawData });
         }
       } catch (error) {
         if (checks.cancel.status === "unrun") setCheck(checks, "cancel", "fail", error.message, {});
         throw error;
       }
     }

     // 11. Restart: stop and start through the CLI, then prove serving with
     // a task-appropriate request.
     try {
       run(["server", "restart"], args.startTimeoutMs);
       const restarted = run(["server", "status"], 30000);
      if (restarted?.state !== "running") {
        setCheck(checks, "restart", "fail", `restart status ${JSON.stringify(restarted).slice(0, 500)}`, { state: restarted?.state ?? "unknown" });
        throw new Error("restart did not return to running");
      }
      if (task === "chat") {
        const again = await readChatStream(`${base}/v1/chat/completions`, {
          model: servedAlias,
          messages: [{ role: "user", content: args.prompt }],
          max_tokens: 8,
        }, args.timeoutMs);
        if (!again.ok) {
          setCheck(checks, "restart", "fail", `post-restart chat status ${again.status}`, { status: again.status });
          throw new Error(`post-restart chat failed with ${again.status}`);
        }
        assertUsagePresent({ usage: again.usage }, "post-restart chat");
      } else {
        // Non-chat tasks prove the restarted server with the model list;
        // capability endpoints keep their own verdicts below.
        const models = await fetchJson(`${base}/v1/models`, {}, args.timeoutMs);
        if (!models.ok) {
          setCheck(checks, "restart", "fail", `post-restart models status ${models.status}`, { status: models.status });
          throw new Error(`post-restart models failed with ${models.status}`);
        }
        assertModelsAlias(models.body);
      }
      setCheck(checks, "restart", "pass", "restart returned to running and answered", {});
     } catch (error) {
       if (checks.restart.status === "unrun") setCheck(checks, "restart", "fail", error.message, {});
       throw error;
     }

     // 12. Supported media: a chat-task probe with a tiny image part.
     // Acceptance is recorded, not assumed: 200 with usage is a pass, an
     // actionable 4xx is unsupported for this model unless the operator
     // declared support via --expect-media (registry/processor evidence),
     // in which case refusal is a fail. Other statuses always fail.
     if (task !== "chat") {
       setCheck(checks, "media_supported", "unrun", `image chat is a chat-task probe; task=${task} skips it`, {});
     } else {
       try {
         const media = await fetchJson(`${base}/v1/chat/completions`, {
           method: "POST",
           headers: { "content-type": "application/json" },
           body: JSON.stringify({
             model: servedAlias,
             messages: [{ role: "user", content: [{ type: "text", text: "Describe this pixel." }, imagePartFor(args)] }],
             max_tokens: 16,
             stream: false,
           }),
         }, args.timeoutMs);
         if (media.ok) {
           try {
             assertUsagePresent(media.body, "image chat");
             setCheck(checks, "media_supported", "pass", args.mediaFile ? "supplied media file answered with usage" : "image data-URI request answered with usage", { status: media.status });
           } catch (error) {
             setCheck(checks, "media_supported", "fail", `image request lacked authoritative usage: ${error.message}`, { status: media.status });
             throw error;
           }
         } else if (media.status === 400 || media.status === 422) {
           if (args.expectMedia) {
             setCheck(checks, "media_supported", "fail", `media declared expected but refused (${media.status}): ${JSON.stringify(media.body).slice(0, 500)}`, { status: media.status });
             throw new Error(`expected media refused with ${media.status}`);
           }
           setCheck(checks, "media_supported", "unsupported", `image input refused (${media.status}): ${JSON.stringify(media.body).slice(0, 500)}`, { status: media.status });
         } else {
           setCheck(checks, "media_supported", "fail", `image request status ${media.status}: ${JSON.stringify(media.body).slice(0, 500)}`, { status: media.status });
           throw new Error(`image request failed with ${media.status}`);
         }
       } catch (error) {
         if (checks.media_supported.status === "unrun") setCheck(checks, "media_supported", "fail", error.message, {});
         throw error;
       }
     }

     // 13. Unsupported refusal: a file:// reference must always be refused
     // by the engine, independent of model vision support. This records the
     // engine verdict only; application file-path handling needs GUI/native
     // tests and is never inferred from this 4xx.
     if (task !== "chat") {
       setCheck(checks, "media_refusal", "unrun", `file:// refusal is a chat-task engine probe; task=${task} skips it`, {});
     } else {
       try {
         const refusal = await fetchJson(`${base}/v1/chat/completions`, {
           method: "POST",
           headers: { "content-type": "application/json" },
           body: JSON.stringify({
             model: servedAlias,
             messages: [{ role: "user", content: [{ type: "text", text: "Read this." }, { type: "image_url", image_url: { url: "file:///etc/hostname" } }] }],
             max_tokens: 8,
             stream: false,
           }),
         }, args.timeoutMs);
         if (!refusal.ok && refusal.status >= 400 && refusal.status < 500) {
           setCheck(checks, "media_refusal", "pass", `engine refused file:// input (${refusal.status}) with an actionable error; app file-path handling still needs GUI/native tests`, { status: refusal.status });
         } else {
           setCheck(checks, "media_refusal", "fail", `file:// input was not refused (status ${refusal.status})`, { status: refusal.status });
           throw new Error(`file:// input was not refused (status ${refusal.status})`);
         }
       } catch (error) {
         if (checks.media_refusal.status === "unrun") setCheck(checks, "media_refusal", "fail", error.message, {});
         throw error;
       }
     }

     // 14. Tools: a chat-task probe with automatic tool choice. A 200
     // records tools acceptance separately from an actual tool call: the
     // verdict notes whether tool_calls fired. Parser 400/422 is
     // unsupported unless --expect-tools declared support, then it fails.
     if (task !== "chat") {
       setCheck(checks, "tools", "unrun", `tool choice is a chat-task probe; task=${task} skips it`, {});
     } else {
       try {
         const tools = await fetchJson(`${base}/v1/chat/completions`, {
           method: "POST",
           headers: { "content-type": "application/json" },
           body: JSON.stringify({
             model: servedAlias,
             messages: [{ role: "user", content: "What time is it?" }],
             tools: [{ type: "function", function: { name: "get_time", description: "Return the current time.", parameters: { type: "object", properties: {} } } }],
             tool_choice: "auto",
             max_tokens: 32,
             stream: false,
           }),
         }, args.timeoutMs);
         if (tools.ok) {
           const message = tools.body?.choices?.[0]?.message ?? {};
           const called = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
           try {
             assertUsagePresent(tools.body, "tools chat");
           } catch (error) {
             setCheck(checks, "tools", "fail", `tools response lacked authoritative usage: ${error.message}`, { status: tools.status });
             throw error;
           }
           setCheck(checks, "tools", "pass", called ? `tool call returned (${message.tool_calls.length} call(s))` : "tools accepted (200 with usage) but the model answered with text; no tool call observed", { status: tools.status, toolsAccepted: true, toolCalled: called });
           result.tools = { accepted: true, called };
         } else if (tools.status === 400 || tools.status === 422) {
           if (args.expectTools) {
             setCheck(checks, "tools", "fail", `tools declared expected but refused (${tools.status}): ${JSON.stringify(tools.body).slice(0, 500)}`, { status: tools.status });
             throw new Error(`expected tools refused with ${tools.status}`);
           }
           setCheck(checks, "tools", "unsupported", `tool parser refused (${tools.status}): ${JSON.stringify(tools.body).slice(0, 500)}`, { status: tools.status, toolsAccepted: false, toolCalled: false });
         } else {
           setCheck(checks, "tools", "fail", `tools request status ${tools.status}: ${JSON.stringify(tools.body).slice(0, 500)}`, { status: tools.status });
           throw new Error(`tools request failed with ${tools.status}`);
         }
       } catch (error) {
         if (checks.tools.status === "unrun") setCheck(checks, "tools", "fail", error.message, {});
         throw error;
       }
     }

     // 15. Embeddings: mandatory for the embedding task (with complete
     // numeric vectors), otherwise only when declared via --expect-embeddings
     // or provider_options.embedding_model. A declared-but-refused endpoint
     // is unsupported, unless the operator declared it expected (or runs the
     // embedding task), in which case refusal is a fail.
     try {
       const expected = args.expectEmbeddings || task === "embedding";
       const declared = expected || declaredEmbeddingModel.length > 0;
       if (task === "embedding" && !declared) {
         setCheck(checks, "embeddings", "fail", "embedding task needs --expect-embeddings or a provider_options embedding_model declaration", {});
         throw new Error("embedding task needs a declared embedding model");
       }
       if (!declared) {
         setCheck(checks, "embeddings", "unrun", "no embedding model declared (pass --expect-embeddings or set provider_options embedding_model to test)", {});
       } else {
         const embeddings = await fetchJson(`${base}/v1/embeddings`, {
           method: "POST",
           headers: { "content-type": "application/json" },
           body: JSON.stringify({ model: servedAlias, input: "acceptance probe" }),
         }, args.timeoutMs);
         if (embeddings.ok) {
           try {
             const { count, dims } = assertEmbeddingsPresent(embeddings.body, "embeddings");
             setCheck(checks, "embeddings", "pass", `embeddings returned ${count} complete numeric vector(s) of dim ${dims}`, { count, dims });
             result.embeddings = { count, dims };
           } catch (error) {
             setCheck(checks, "embeddings", "fail", `embeddings response lacked complete numeric vectors: ${error.message}`, {});
             throw error;
           }
         } else if (embeddings.status === 400 || embeddings.status === 404 || embeddings.status === 422) {
           if (expected) {
             setCheck(checks, "embeddings", "fail", `embeddings declared expected but refused (${embeddings.status}): ${JSON.stringify(embeddings.body).slice(0, 500)}`, { status: embeddings.status });
             throw new Error(`expected embeddings refused with ${embeddings.status}`);
           }
           setCheck(checks, "embeddings", "unsupported", `embeddings refused (${embeddings.status}): ${JSON.stringify(embeddings.body).slice(0, 500)}`, { status: embeddings.status });
         } else {
           setCheck(checks, "embeddings", "fail", `embeddings status ${embeddings.status}: ${JSON.stringify(embeddings.body).slice(0, 500)}`, { status: embeddings.status });
           throw new Error(`embeddings failed with ${embeddings.status}`);
         }
       }
     } catch (error) {
       if (checks.embeddings.status === "unrun") setCheck(checks, "embeddings", "fail", error.message, {});
       throw error;
     }

     // 16. Transcription: mandatory for the transcription task, otherwise
     // unrun. Audio/video chat refusal stays separate: transcription support
     // (including any native STT) never establishes audio/video chat support.
     if (task !== "transcription") {
       setCheck(checks, "transcription", "unrun", "no STT checkpoint selected (run with --task transcription and an audio-capable model to test)", {});
     } else {
       try {
         const transcription = await probeTranscription(base, servedAlias, { audioFile: args.audioFile, timeoutMs: args.timeoutMs });
         if (transcription.ok && transcription.transcript.trim().length > 0) {
           setCheck(checks, "transcription", "pass", `transcription returned ${transcription.transcript.trim().length} chars${args.audioFile ? " for the supplied audio file" : " for the synthetic silence fixture"}`, { chars: transcription.transcript.trim().length });
           result.transcript = { chars: transcription.transcript.trim().length };
         } else if (!transcription.ok && [400, 404, 422, 415].includes(transcription.status)) {
           if (args.expectTranscription || task === "transcription") {
             setCheck(checks, "transcription", "fail", `transcription expected but refused (${transcription.status}): ${JSON.stringify(transcription.body).slice(0, 500)}`, { status: transcription.status });
             throw new Error(`expected transcription refused with ${transcription.status}`);
           }
           setCheck(checks, "transcription", "unsupported", `transcription refused (${transcription.status})`, { status: transcription.status });
         } else {
           setCheck(checks, "transcription", "fail", `transcription status ${transcription.status}: empty or missing text`, { status: transcription.status });
           throw new Error("transcription did not return text");
         }
       } catch (error) {
         if (checks.transcription.status === "unrun") setCheck(checks, "transcription", "fail", error.message, {});
         throw error;
       }
     }

     // 17. Benchmark and deep verification need the shared Rust API and a
     // cold-cache procedure. This CLI harness records the exact follow-up and
     // leaves the verdict unrun rather than estimating.
     setCheck(checks, "benchmark", "unrun", "run the desktop PerformanceBench cold-cache flow against this server for PP/TG, worker RSS and CSV/XLSX export; see provider-native-acceptance.md", {});
     setCheck(checks, "deep_verification", "unrun", "run DeepVerificationControls for this engine/runtime/model/options; vLLM reports a partial top-k KL bound, mlx-vlm a full-vocabulary KL; quantized weights without a CPU reference stay unsupported", {});

     // 18. Stop: reclaim the app-owned server process. serverRunning tracks
     // whether the process is still running: true only while state is
     // "running", so a successful stop (state left running) records a pass.
     try {
       run(["server", "stop"], 30000);
       const stopped = run(["server", "status"], 30000);
       serverRunning = stopped?.state === "running";
       if (!serverRunning) {
         setCheck(checks, "stop", "pass", `server left running state (now ${stopped?.state ?? "unknown"})`, { state: stopped?.state ?? "unknown" });
       } else {
         setCheck(checks, "stop", "fail", `server still running: ${JSON.stringify(stopped).slice(0, 500)}`, { state: stopped?.state ?? "unknown" });
         throw new Error("server still running after stop");
       }
     } catch (error) {
       if (checks.stop.status === "unrun") setCheck(checks, "stop", "fail", error.message, {});
       throw error;
     }

     result.summary = summarize(checks);
     return result;
   } catch (error) {
     result.error = error.message;
     // After a live start, downstream unstarted checks stay unrun but the
     // summary must remain fail: never swallow a started-run failure. Input
     // validation above already recorded its failing check, so a
     // mis-invocation summarizes as fail rather than a false pass.
     if (!result.summary) result.summary = summarize(checks);
     if (liveStarted && result.summary.outcome !== "fail") {
       // Ensure at least the active failure is visible even if bookkeeping missed it.
       if (checks.server_launch.status === "unrun") setCheck(checks, "server_launch", "fail", error.message, {});
       result.summary = summarize(checks);
     }
     if (!result.summary) result.summary = summarize(checks);
     return result;
   } finally {
     // Cleanup always runs: stop an owned server, then remove only the
     // isolated home. External interpreters and user data are untouched.
     // When the server is still running (or its status is unknown) after
     // stop attempts, the isolated home is RETAINED for manual recovery and
     // cleanup records fail: removing it would orphan a live process and
     // destroy the state needed to stop it.
     try {
       if (isolated) {
         const env = { ...isolated.env, ...extraEnv };
         const runCleanup = (cliArgs, timeoutMs = 30000) => runCli(executable, [...cliPrefix, ...cliArgs], env, timeoutMs);
         if (serverRunning) {
           try {
             runCleanup(["server", "stop"], 30000);
           } catch {
             // Fall through to the status check below for the verdict.
           }
         }
         let statusAfter = "unknown";
         try {
           const queried = runCleanup(["server", "status"], 15000);
           statusAfter = queried?.state ?? "unknown";
           serverRunning = statusAfter === "running";
         } catch {
           statusAfter = "unknown";
           if (liveStarted) serverRunning = true;
         }
         result.cleanupStatus = statusAfter;
         const mustRetain = liveStarted && (statusAfter === "running" || statusAfter === "starting_or_unhealthy" || statusAfter === "unknown");
         if (serverRunning && result.checks.stop.status === "unrun") {
           setCheck(result.checks, "stop", "fail", `server still ${statusAfter} after stop attempts`, { state: statusAfter });
         } else if (!serverRunning && result.checks.stop.status === "unrun") {
           setCheck(result.checks, "stop", "pass", `server stopped during cleanup (now ${statusAfter})`, { state: statusAfter });
         }
         if (mustRetain) {
           console.error(`[local-only] retaining isolated home for manual stop: ${isolated.temporary}`);
           setCheck(result.checks, "cleanup", "fail", `server status ${statusAfter}; isolated home retained under the system temp dir (full path on console only); stop it with AIOLM_HOME=<retained-home> <aiolm-cli> server stop, then remove the directory`, { status: statusAfter });
         } else if (!args.keepHome) {
           rmSync(isolated.temporary, { recursive: true, force: true });
           if (result.checks.cleanup.status !== "fail") {
             setCheck(result.checks, "cleanup", "pass", `isolated home removed; server status ${statusAfter}`, { status: statusAfter });
           }
         } else {
           console.log(`[local-only] kept isolated home: ${isolated.temporary}`);
           if (result.checks.cleanup.status !== "fail") {
             setCheck(result.checks, "cleanup", "pass", "isolated home kept (--keep-home; full path on console only)", { status: statusAfter });
           }
         }
         serverRunning = false;
       }
     } catch (cleanupError) {
       setCheck(result.checks, "cleanup", "fail", cleanupError.message, {});
     }
     if (!result.summary) result.summary = summarize(result.checks);
     else if (liveStarted && result.summary.outcome !== "fail" && Object.values(result.checks).some((check) => check.status === "fail")) {
       result.summary = summarize(result.checks);
     }
     if (args.out) {
       try {
         mkdirSync(dirname(resolve(args.out)), { recursive: true });
         writeFileSync(resolve(args.out), `${JSON.stringify(sanitizeResultForFile(result), null, 2)}\n`);
         result.out = args.out;
       } catch (writeError) {
         result.outError = writeError.message;
       }
     }
   }
 }

 function printResult(result) {
   const summary = result.summary ?? summarize(result.checks);
   console.log(`provider acceptance: live=${result.live ? "yes" : "no"} synthetic=${result.synthetic ? "yes" : "no"} task=${result.task ?? "chat"} outcome=${summary.outcome}`);
   for (const name of CHECKS) {
     const check = result.checks[name];
     console.log(`  ${name}: ${check.status}${check.detail ? ` — ${check.detail}` : ""}`);
   }
   if (result.error) console.log(`error: ${redactPathsInString(result.error)}`);
   if (result.out) console.log(`result JSON: ${result.out}`);
 }

 async function main() {
   const args = parseArgs(process.argv.slice(2));
   if (args.help) {
     console.log(helpText());
     return;
   }
   if (args.selfTest) {
     const result = await runSelfTest();
     printResult(result);
     const summary = summarize(result.checks);
     if (summary.fail > 0) process.exitCode = 1;
     return;
   }
   const result = await runLive(args);
   if (args.keepHome) {
     console.log("[local-only] full local paths (never in shareable JSON):");
     if (args.python) console.log(`[local-only] python: ${resolve(args.python)}`);
     if (args.model) console.log(`[local-only] model: ${resolve(args.model)}`);
     if (args.cli) console.log(`[local-only] cli: ${resolve(args.cli)}`);
   }
   printResult(result);
   if (result.summary?.outcome === "fail") process.exitCode = 1;
 }

 const invoked = process.argv[1] ? resolve(process.argv[1]).endsWith("smoke-provider-runtime.mjs") : false;
 if (invoked) {
   await main();
 }
