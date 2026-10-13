/* global process, fetch, AbortController, TextDecoder, setTimeout */
// Host-native acceptance. The supplied CLI must already be built on this host;
// engines/models are inspected in place and never installed or downloaded.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { SseParser } from '../src/shared/api/sse.ts';

const execute = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, i, all) => value.startsWith('--') ? [...rows, [value.slice(2), all[i + 1]]] : rows, []));
for (const key of ['cli', 'manifest', 'model', 'provenance']) if (!args[key]) throw new Error(`Required: --${key}`);
const output = resolve(args.output ?? join('tmp', 'runtime-adapter-validation', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const home = join(output, 'home'); await mkdir(home);
const env = { ...process.env, AIOLM_HOME: home };
for (const name of Object.keys(env)) if (/^(AIOLM_|LLAMA_BOARD_)/i.test(name) && name !== 'AIOLM_HOME') delete env[name];
const manifest = JSON.parse(await readFile(resolve(args.manifest), 'utf8'));
const provenance = JSON.parse(await readFile(resolve(args.provenance), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(provenance.model_revision ?? '') || !Array.isArray(provenance.files) || !provenance.files.length) throw new Error('Provenance requires a full model revision and files with SHA-256');
const steps = [];
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function hash(path) { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }
async function command(label, commandArgs, expectedFailure = false) {
  try {
    const result = await execute(resolve(args.cli), commandArgs, { env, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(join(output, `${label}.log`), result.stdout + result.stderr, { flag: 'wx', mode: 0o600 });
    check(!expectedFailure, `${label}: unexpected success`);
    return JSON.parse(result.stdout);
  } catch (error) {
    if (error.stdout !== undefined) await writeFile(join(output, `${label}.log`), String(error.stdout ?? '') + String(error.stderr ?? ''), { flag: 'wx', mode: 0o600 });
    if (!expectedFailure || !error.code || typeof error.code !== 'number') throw error;
    return { failed: true };
  }
}
async function record(label, action) {
  try { const evidence = await action(); steps.push({ item: label, status: 'pass', evidence }); }
  catch (error) { steps.push({ item: label, status: 'fail', error: String(error.message ?? error) }); throw error; }
}
const reserve = createServer(); await new Promise((done, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', done); });
const port = reserve.address().port; await new Promise(done => reserve.close(done));
let url, served;
const ownedPids = new Set();
async function stopped() {
  const listener = () => new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(false); });
    socket.once('timeout', () => { socket.destroy(); done(true); });
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const live = [...ownedPids].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
    if (!live.length && !await listener()) return { ownedPids: [...ownedPids], portClosed: true };
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('An owned server PID or port remains after shutdown');
}
async function completion(cancel = false) {
  const controller = new AbortController(); let content = '', usage;
  const response = await fetch(`${url}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: served, messages: [{ role: 'user', content: cancel ? 'Write the numbers from 1 through 1000, one number per line. Continue until the limit.' : 'Compute 2 + 3. Reply with the number only.' }], stream: true, stream_options: { include_usage: true }, max_tokens: cancel ? 1024 : 32 }) });
  check(response.ok, `Chat returned ${response.status}`);
  const parser = new SseParser(delta => { content += delta.content ?? ''; if (delta.usage) usage = delta.usage; }); const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      parser.push(decoder.decode(chunk, { stream: true }));
      if (cancel && content) { check(!parser.isFinished(), 'Stream completed before cancellation could be exercised'); controller.abort(); break; }
    }
  } catch (error) {
    if (!controller.signal.aborted || !content) throw error;
  }
  if (controller.signal.aborted) return { streamAbortedAfterContent: true };
  parser.finish();
  check(/\b5\b/.test(content), 'The arithmetic answer did not contain 5');
  check(Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens > 0 && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens > 0, 'Authoritative tokenizer usage was not supplied');
  return { content, usage, answerContainsFive: /5/.test(content) };
}
try {
  await record('A01 provenance', async () => {
    for (const file of provenance.files) check(/^[0-9a-f]{64}$/.test(file.sha256) && await hash(resolve(file.path)) === file.sha256, 'Model/dependency hash mismatch');
    return { modelRevision: provenance.model_revision, verifiedFiles: provenance.files.length };
  });
  await record('A02 register and select', async () => {
    await command('register', ['runtime', 'register-manifest', resolve(args.manifest)]);
    await command('select', ['runtime', 'select', manifest.engine_id, manifest.runtime_id]);
    await command('model', ['config', 'set', 'active_model', resolve(args.model)]);
    await command('port', ['config', 'set', 'port', String(port)]);
    const probe = await command('probe', ['runtime', 'probe', manifest.engine_id, manifest.runtime_id]); served = probe.upstream_model;
    check(probe.provider === manifest.engine_id && probe.runtime_id === manifest.runtime_id, 'Probe identity mismatch');
    return { engine: probe.provider, runtime: probe.runtime_id, servedModel: served };
  });
  await record('A03 actual response and usage', async () => { const started = await command('start', ['server', 'start']); url = started.url; ownedPids.add(started.pid); check(url && started.pid, 'No owned server URL/PID'); return completion(); });
  await record('A04 cancellation preserves server', async () => { const result = await completion(true); const status = await command('status-after-cancel', ['server', 'status']); check(status.state === 'running', 'Server stopped after cancelling stream'); return result; });
  await record('A05 restart', async () => { const result = await command('restart', ['server', 'restart']); url = result.url; ownedPids.add(result.pid); return completion(); });
  await record('A06 shutdown and unavailable selection', async () => {
    await command('stop', ['server', 'stop']); await stopped();
    await command('remove', ['runtime', 'remove', manifest.engine_id, manifest.runtime_id]);
    const cfg = await command('config-after-remove', ['config', 'get']);
    const value = cfg.config ?? cfg; check(value.active_provider === manifest.engine_id && value.active_runtime === manifest.runtime_id, 'Removed registration rewrote selection');
    await command('missing-registration-start', ['server', 'start'], true);
    return { savedSelectionPreserved: true, missingRegistrationRefused: true };
  });
  await record('A07 register again without rebuilding', async () => {
    await command('register-again', ['runtime', 'register-manifest', resolve(args.manifest)]);
    const started = await command('start-again', ['server', 'start']); url = started.url; ownedPids.add(started.pid);
    return completion();
  });
} catch (error) { process.exitCode = 1; process.stderr.write(`${error.message}\n`); }
finally {
  try { await command('final-stop', ['server', 'stop']); const evidence = await stopped(); steps.push({ item: 'A08 cleanup', status: 'pass', evidence }); } catch (error) { steps.push({ item: 'A08 cleanup', status: 'fail', error: String(error) }); process.exitCode = 1; }
  await record('A09 external files preserved', async () => { for (const file of provenance.files) check(await hash(resolve(file.path)) === file.sha256, 'External file changed during acceptance'); return { verifiedFiles: provenance.files.length }; }).catch(() => { process.exitCode = 1; });
  const sourceDiff = (await execute('git', ['diff', 'HEAD'])).stdout;
  const sourceDirty = (await execute('git', ['status', '--porcelain'])).stdout.trim().length > 0;
  const source = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(output, 'results.json'), JSON.stringify({ schema_version: 1, source, source_dirty: sourceDirty, tracked_diff_sha256: createHash('sha256').update(sourceDiff).digest('hex'), cli_sha256: await hash(resolve(args.cli)), manifest_sha256: await hash(resolve(args.manifest)), os: process.platform, arch: process.arch, engine_id: manifest.engine_id, runtime_id: manifest.runtime_id, model_revision: provenance.model_revision, synthetic: provenance.synthetic === true, steps, remaining: ['Native GUI / profiles / multi-session / MCP / RAG / media / gateway authentication', 'Unsupported benchmark/deep/portable capabilities must stay unavailable'] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Acceptance evidence: ${output}\n`);
}
