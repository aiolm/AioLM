import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, SourceTextModule } from 'node:vm';
import ts from 'typescript';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmPath = process.env.npm_execpath;
assert(npmPath, 'Run this smoke test with npm test so the current npm executable is available.');
const scratchLocation = process.env.BENCHMARK_CONTRACTS_TEST_TMP ?? join(process.env.INIT_CWD ?? packageRoot, 'tmp');
mkdirSync(scratchLocation, { recursive: true });
const scratchParent = realpathSync(scratchLocation);
const scratch = mkdtempSync(join(scratchParent, 'aiolm-contracts-'));
const runNpm = (args, cwd) => execFileSync(process.execPath, [npmPath, ...args, '--cache', join(scratch, 'npm-cache')], { cwd, encoding: 'utf8', windowsHide: true });

const servingRow = { input_bytes: 4096, max_output_tokens: 128, concurrency: 1, repetition: 1,
  input_sha256_by_request: ['a'.repeat(64)], first_output_ms: 50, e2e_ms: 200, output_bytes: 12,
  reported_prompt_tokens: null, reported_completion_tokens: null,
  prefill_tokens_per_second: null, decode_tokens_per_second: null, tpot_ms: null,
  usage_status: 'missing', finish_reasons: ['stop'], peak_memory_bytes: null, timing_source: 'client', failed: false };
const serving = { schema_version: 4, submission_id: '00000000-0000-4000-8000-000000000001', app_version: null,
  method: { id: 'openai-chat-serving', version: 5 },
  workload: { corpus: 'novel_en', corpus_version: 2, inputs: [{ bytes: 4096, sha256: 'a'.repeat(64) }],
    max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: false, request_usage: false,
    cache_policy: 'cold_prompt', prompt_nonce: '0123456789abcdef0123456789abcdef' },
  runtime: { name: null, version: null, backend: null, build: null, variant: null, plugin_version: null },
  model: { status: 'unidentified', sha256: null, size_bytes: null, format: 'unknown' }, environment: null,
  execution: { topology: 'unknown', memory_scope: 'unavailable', settings: [
    { target: 'request', scope: [], name: 'max_tokens', value: 128, unit: 'tokens', role: null },
    { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
    { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
  ] }, measurements: { status: 'complete', rows: [servingRow] } };

try {
  // A deleted source module must disappear from the next distributable, while
  // unchanged modules keep their timestamps for live workspace consumers.
  const buildFixture = join(scratch, 'build-fixture');
  cpSync(join(packageRoot, 'src'), join(buildFixture, 'src'), { recursive: true });
  cpSync(join(packageRoot, 'schema'), join(buildFixture, 'schema'), { recursive: true });
  copyFileSync(join(packageRoot, 'tsconfig.json'), join(buildFixture, 'tsconfig.json'));
  mkdirSync(join(buildFixture, 'scripts'));
  const typescriptUrl = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  writeFileSync(join(buildFixture, 'scripts/build.mjs'), readFileSync(join(packageRoot, 'scripts/build.mjs'), 'utf8').replace("'typescript'", JSON.stringify(typescriptUrl)));
  const retiredSource = join(buildFixture, 'src/retired.ts');
  writeFileSync(retiredSource, 'export const retired = true;\n');
  const build = () => execFileSync(process.execPath, [join(buildFixture, 'scripts/build.mjs')], { windowsHide: true });
  build();
  const keptModules = ['index.js', 'index.d.ts', 'schema.js', 'schema.d.ts'];
  const timestamps = keptModules.map(name => statSync(join(buildFixture, 'dist', name)).mtimeMs);
  unlinkSync(retiredSource);
  build();
  assert(!existsSync(join(buildFixture, 'dist/retired.js')) && !existsSync(join(buildFixture, 'dist/retired.d.ts')), 'Retired modules remained in the build output.');
  assert.deepEqual(keptModules.map(name => statSync(join(buildFixture, 'dist', name)).mtimeMs), timestamps, 'An unchanged rebuild invalidated live workspace modules.');

  const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], packageRoot));
  const archive = Array.isArray(packed) ? packed[0] : packed['@aiolm/benchmark-contracts'] ?? packed;
  assert.equal(typeof archive.filename, 'string', 'npm pack did not return an archive.');
  const packedPaths = archive.files.map(entry => entry.path);
  assert(packedPaths.includes('dist/index.js') && packedPaths.includes('dist/index.d.ts'));
  assert(packedPaths.includes('schema/public-benchmark.schema.json') && packedPaths.includes('schema/publication.schema.json') && packedPaths.includes('schema/openapi.json'));
  assert(packedPaths.includes('LICENSE'));
  for (const path of packedPaths) assert(/^(?:dist\/[^/]+\.(?:js|d\.ts)|schema\/(?:public-benchmark\.schema|publication\.schema|openapi)\.json|package\.json|LICENSE)$/.test(path), `Unexpected packed file: ${path}`);

  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  copyFileSync(join(scratch, archive.filename), join(consumer, 'benchmark-contracts.tgz'));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'benchmark-contract-consumer', private: true, type: 'module', dependencies: { '@aiolm/benchmark-contracts': 'file:./benchmark-contracts.tgz' } }));
  runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
  const consumerRequire = createRequire(join(consumer, 'package.json'));
  const entryPath = consumerRequire.resolve('@aiolm/benchmark-contracts');
  const installedDist = dirname(realpathSync(entryPath));
  assert(installedDist.startsWith(`${realpathSync(consumer)}${sep}`), 'The packed consumer must not resolve a workspace link.');

  writeFileSync(join(consumer, 'node-smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { validatePublicBenchmark, validateBenchmarkConfiguration, validateBenchmarkReceipt, servingMetricValues, summarizeServingPoints, SERVING_METRIC_KEYS, publicBenchmarkSchema, validatePublicationRequest, normalizePublicationInput, parsePublicationSnapshot, serializePublicationRequest, validateDescriptionMd, DESCRIPTION_MAX_CODEPOINTS, PUBLICATION_MAX_UTF8_BYTES, PUBLICATION_MAX_ROWS, countCodePoints, utf8ByteLength, encodeRecoveryCode, decodeRecoveryCode, RECOVERY_FIXTURE, base64UrlEncode, base64UrlDecode, normalizeServiceOrigin, parseServiceError, normalizeBaseUrl, benchmarkRunsUrl, assertIsoTimestamp, publicationSchema, formatRuntimeVersionLabel, MAX_SERVING_OUTPUT_TOKENS } from '@aiolm/benchmark-contracts';
    const serving = ${JSON.stringify(serving)};
    const observed = serving.measurements.rows[0];
    assert.equal(validatePublicBenchmark(serving), serving);
    assert.equal(MAX_SERVING_OUTPUT_TOKENS, 128);
    const rejectServing = (mutate, expected) => {
      const candidate = structuredClone(serving);
      mutate(candidate);
      assert.throws(() => validatePublicBenchmark(candidate), expected);
    };
    for (const version of [1, 2, 3, 4]) rejectServing(value => { value.method.version = version; });
    for (const version of [1, 2, 3]) rejectServing(value => { value.schema_version = version; });
    for (const cap of [1, 128]) {
      const candidate = structuredClone(serving);
      candidate.workload.max_output_tokens = cap;
      candidate.execution.settings[0].value = cap;
      candidate.measurements.rows[0].max_output_tokens = cap;
      assert.equal(validatePublicBenchmark(candidate), candidate);
    }
    for (const cap of [0, 129]) rejectServing(value => {
      value.workload.max_output_tokens = cap;
      value.execution.settings[0].value = cap;
      value.measurements.rows[0].max_output_tokens = cap;
    });
    for (const field of ['content_bytes', 'reasoning_bytes', 'first_content_ms', 'first_reasoning_ms',
      'reported_cached_tokens', 'reported_completion_tokens_by_request']) {
      rejectServing(value => { value.measurements.rows[0][field] = field.endsWith('_by_request') ? [128] : 0; });
    }
    for (const mutate of [
      value => { value.local_path = '/private/model'; },
      value => { value.constructor = 'private'; },
      value => { value.method.id = 'cold-prompt-serving'; },
      value => { value.runtime.name = 'private/path'; },
      value => { value.runtime.variant = 'x'.repeat(257); },
      value => { delete value.runtime.plugin_version; },
      value => { value.workload.corpus_version = 1; },
      value => { value.workload.cache_policy = 'as_configured'; },
      value => { value.workload.warmup = true; },
      value => { delete value.workload.prompt_nonce; },
      value => { value.workload.prompt_nonce = 'A'.repeat(32); },
      value => { value.workload.prompt_nonce = 'a'.repeat(31); },
      value => { value.workload.prompt_nonce = 'a'.repeat(33); },
      value => { value.workload.prompt_nonce += String.fromCharCode(10); },
      value => { value.workload.prompt_lengths = [4096]; },
      value => { value.workload.inputs[0].sha256_by_slot = ['a'.repeat(64)]; },
      value => { value.workload.inputs[0].raw_prompt = 'private'; },
      value => { value.workload.inputs[0].sha256 = 'A'.repeat(64); },
      value => { value.workload.inputs[0].bytes = 255; },
      value => { value.workload.inputs[0].bytes = 1048577; },
      value => { value.workload.inputs.push({ ...value.workload.inputs[0] }); },
      value => { value.workload.inputs.unshift({ bytes: 8192, sha256: 'b'.repeat(64) }); },
      value => { value.workload.concurrencies = []; },
      value => { value.workload.concurrencies = [1, 1]; },
      value => { value.workload.concurrencies = [2, 1]; },
      value => { value.workload.concurrencies = [0]; },
      value => { value.workload.concurrencies = [65]; },
      value => { value.workload.repetitions = 0; },
      value => { value.workload.repetitions = 101; },
      value => { value.measurements.status = 'partial'; },
      value => { value.measurements.rows = []; },
      value => { value.measurements.rows.push({ ...observed }); },
      value => { value.measurements.rows[0].input_bytes = 8192; },
      value => { value.measurements.rows[0].max_output_tokens = 129; },
      value => { value.measurements.rows[0].max_output_tokens = 64; },
      value => { value.measurements.rows[0].concurrency = 2; },
      value => { value.measurements.rows[0].repetition = 2; },
      value => { value.measurements.rows[0].failed = true; },
      value => { value.measurements.rows[0].error = 'private'; },
      value => { delete value.measurements.rows[0].input_sha256_by_request; },
      value => { value.measurements.rows[0].input_sha256_by_request = []; },
      value => { value.measurements.rows[0].input_sha256_by_request = ['a'.repeat(64), 'b'.repeat(64)]; },
      value => { value.measurements.rows[0].input_sha256_by_request = ['b'.repeat(64)]; },
      value => { value.measurements.rows[0].input_sha256_by_request = ['A'.repeat(64)]; },
      value => { value.measurements.rows[0].input_sha256_by_request = ['a'.repeat(63)]; },
      value => { value.measurements.rows[0].input_sha256_by_request = ['a'.repeat(64) + String.fromCharCode(10)]; },
      value => { value.measurements.rows[0].input_sha256_by_request = ['/private/prompt']; },
      value => { value.measurements.rows[0].input_sha256_by_request = [null]; },
      value => { value.measurements.rows[0].output_bytes = Number.MAX_SAFE_INTEGER + 1; },
      value => { value.measurements.rows[0].e2e_ms = Infinity; },
      value => { value.measurements.rows[0].first_output_ms = -1; },
      value => { value.measurements.rows[0].reported_prompt_tokens = -1; },
      value => { value.measurements.rows[0].reported_prompt_tokens = 0.5; },
      value => { value.measurements.rows[0].reported_completion_tokens = Number.MAX_SAFE_INTEGER + 1; },
      value => { value.measurements.rows[0].usage_status = 'complete'; },
      value => { value.measurements.rows[0].reported_prompt_tokens = 0; },
      value => { Object.assign(value.measurements.rows[0], { usage_status: 'partial', reported_prompt_tokens: 0, reported_completion_tokens: 0 }); },
      value => { value.measurements.rows[0].finish_reasons = []; },
      value => { value.measurements.rows[0].finish_reasons = ['eos']; },
      value => { value.measurements.rows[0].timing_source = 'server'; },
      value => { value.measurements.rows[0].peak_memory_bytes = 1; },
      value => { value.model.size_bytes = Number.MAX_SAFE_INTEGER + 1; },
      value => { value.model.status = 'sha256'; },
      value => { value.model.sha256 = 'a'.repeat(64); },
      value => { value.execution.raw_argv = ['--secret']; },
      value => { value.execution.settings[0].value = 127; },
      value => { value.execution.settings[0].role = 'context.total_tokens'; },
      value => { value.execution.settings[0].scope = ['serve']; },
      value => { value.execution.settings[0].unit = null; },
      value => { value.execution.settings[1].value = false; },
      value => { value.execution.settings[1].unit = 'tokens'; },
      value => { value.execution.settings[2].value = 1; },
      value => { value.execution.settings.reverse(); },
      value => { value.execution.settings.push({ ...value.execution.settings[2] }); },
      value => { value.execution.settings.pop(); },
      value => { value.workload.request_usage = true; },
      value => { value.execution.settings[0].raw = 'private'; },
    ]) rejectServing(mutate);
    for (const name of ['ignore_eos', 'min_tokens', 'stream_options.include_usage']) {
      rejectServing(value => { value.execution.settings.push({ target: 'request', scope: [], name, value: true, unit: null, role: null }); });
    }

    const usageRequested = structuredClone(serving);
    usageRequested.workload.request_usage = true;
    usageRequested.execution.settings.splice(2, 0, { target: 'request', scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null });
    assert.equal(validatePublicBenchmark(usageRequested), usageRequested, 'Requesting usage does not require a server to report it.');
    for (const mutate of [
      value => { value.workload.request_usage = false; },
      value => { value.execution.settings[2].value = false; },
      value => { value.execution.settings[2].scope = ['nested']; },
      value => { value.execution.settings[2].unit = 'tokens'; },
      value => { value.execution.settings[2].role = 'context.total_tokens'; },
    ]) {
      const candidate = structuredClone(usageRequested);
      mutate(candidate);
      assert.throws(() => validatePublicBenchmark(candidate));
    }
    for (const counters of [
      { usage_status: 'complete', reported_prompt_tokens: 0, reported_completion_tokens: 0 },
      { usage_status: 'complete', reported_prompt_tokens: 55, reported_completion_tokens: 1 },
      { usage_status: 'partial', reported_prompt_tokens: null, reported_completion_tokens: 129 },
      { usage_status: 'partial', reported_prompt_tokens: Number.MAX_SAFE_INTEGER, reported_completion_tokens: null },
      { usage_status: 'partial', reported_prompt_tokens: null, reported_completion_tokens: null },
      { usage_status: 'invalid', reported_prompt_tokens: null, reported_completion_tokens: null },
    ]) {
      const candidate = structuredClone(usageRequested);
      Object.assign(candidate.measurements.rows[0], counters);
      assert.equal(validatePublicBenchmark(candidate), candidate, 'A request cap is not proof of engine compliance.');
    }
    const usage = structuredClone(usageRequested);
    Object.assign(usage.measurements.rows[0], { reported_prompt_tokens: 55, reported_completion_tokens: 128,
      prefill_tokens_per_second: 1100, decode_tokens_per_second: 100, tpot_ms: 10, usage_status: 'complete' });
    assert.equal(validatePublicBenchmark(usage), usage);
    for (const field of ['prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms']) {
      rejectServing(value => { value.measurements.rows[0][field] = 1; }, /Serving rates must match their usage evidence\\./);
      for (const invalid of [-1, NaN, Infinity, -Infinity]) {
        const candidate = structuredClone(usage);
        candidate.measurements.rows[0][field] = invalid;
        assert.throws(() => validatePublicBenchmark(candidate));
      }
      const noFirstOutput = structuredClone(usage);
      noFirstOutput.measurements.rows[0].first_output_ms = null;
      for (const key of ['prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms']) {
        noFirstOutput.measurements.rows[0][key] = key === field ? 1 : null;
      }
      assert.throws(() => validatePublicBenchmark(noFirstOutput), /Serving rates must match their usage evidence\\./);
    }
    for (const field of ['decode_tokens_per_second', 'tpot_ms']) {
      const candidate = structuredClone(usage);
      candidate.measurements.rows[0][field] = 0;
      assert.throws(() => validatePublicBenchmark(candidate), /Serving rates must match their usage evidence\\./);
      candidate.measurements.rows[0][field] = 1;
      candidate.measurements.rows[0].reported_completion_tokens = null;
      candidate.measurements.rows[0].usage_status = 'partial';
      candidate.measurements.rows[0][field === 'tpot_ms' ? 'decode_tokens_per_second' : 'tpot_ms'] = null;
      assert.throws(() => validatePublicBenchmark(candidate), /Serving rates must match their usage evidence\\./);
    }
    const noPromptUsage = structuredClone(usage);
    noPromptUsage.measurements.rows[0].reported_prompt_tokens = null;
    noPromptUsage.measurements.rows[0].usage_status = 'partial';
    assert.throws(() => validatePublicBenchmark(noPromptUsage), /Serving rates must match their usage evidence\\./);
    noPromptUsage.measurements.rows[0].prefill_tokens_per_second = null;
    assert.equal(validatePublicBenchmark(noPromptUsage), noPromptUsage);
    const zeroPrefill = structuredClone(usage);
    zeroPrefill.measurements.rows[0].prefill_tokens_per_second = 0;
    assert.equal(validatePublicBenchmark(zeroPrefill), zeroPrefill);
    for (const status of ['missing', 'invalid']) {
      const candidate = structuredClone(usage);
      candidate.measurements.rows[0].usage_status = status;
      assert.throws(() => validatePublicBenchmark(candidate));
    }

    const withGrid = workload => {
      let nextHash = 0;
      const rows = workload.inputs.flatMap(input => workload.concurrencies.flatMap(concurrency =>
        Array.from({ length: workload.repetitions }, (_, index) => ({ ...observed, input_bytes: input.bytes,
          max_output_tokens: workload.max_output_tokens, concurrency, repetition: index + 1,
          finish_reasons: Array(concurrency).fill('stop'),
          input_sha256_by_request: Array.from({ length: concurrency }, () => (++nextHash).toString(16).padStart(64, '0')) }))));
      const inputs = workload.inputs.map(input => ({ ...input,
        sha256: rows.find(row => row.input_bytes === input.bytes).input_sha256_by_request[0] }));
      return { ...serving, workload: { ...workload, inputs }, execution: { ...serving.execution,
        settings: serving.execution.settings.map(setting => setting.name === 'max_tokens' ? { ...setting, value: workload.max_output_tokens } : setting) },
        measurements: { status: 'complete', rows } };
    };
    const grid = withGrid({ ...serving.workload, inputs: [{ bytes: 256 }, { bytes: 1048576 }],
      concurrencies: [1, 2], repetitions: 2 });
    grid.measurements.rows.reverse();
    assert.equal(validatePublicBenchmark(grid), grid, 'Input descriptor consistency uses point identity, not row ordering.');
    for (const mutate of [
      value => { value.measurements.rows[0].input_sha256_by_request[1] = value.measurements.rows[0].input_sha256_by_request[0]; },
      value => { value.measurements.rows[0].input_sha256_by_request[0] = value.measurements.rows[1].input_sha256_by_request[0]; },
      value => { value.workload.inputs[1].sha256 = 'f'.repeat(64); },
      value => { value.measurements.rows.pop(); },
      value => { value.measurements.rows[0].repetition = 3; },
      value => { value.measurements.rows[0] = structuredClone(value.measurements.rows[1]); },
    ]) {
      const candidate = structuredClone(grid);
      mutate(candidate);
      assert.throws(() => validatePublicBenchmark(candidate));
    }
    const maximumSlots = withGrid({ ...serving.workload, concurrencies: [64] });
    assert.equal(validatePublicBenchmark(maximumSlots), maximumSlots);
    maximumSlots.measurements.rows[0].input_sha256_by_request.push('f'.repeat(64));
    assert.throws(() => validatePublicBenchmark(maximumSlots));
    const maxPoints = withGrid({ ...serving.workload, inputs: Array.from({ length: 64 }, (_, index) => ({ bytes: 256 + index })) });
    assert.equal(validatePublicBenchmark(maxPoints), maxPoints);
    const tooManyPoints = withGrid({ ...maxPoints.workload, concurrencies: [1, 2] });
    assert.throws(() => validatePublicBenchmark(tooManyPoints));
    const emptyOutput = structuredClone(serving);
    Object.assign(emptyOutput.measurements.rows[0], { output_bytes: 0, first_output_ms: null, e2e_ms: 0 });
    assert.equal(validatePublicBenchmark(emptyOutput), emptyOutput);
    emptyOutput.measurements.rows[0].first_output_ms = 0;
    assert.throws(() => validatePublicBenchmark(emptyOutput));
    for (const topology of ['owned', 'attached', 'unknown']) {
      const candidate = structuredClone(serving);
      candidate.execution.topology = topology;
      assert.equal(validatePublicBenchmark(candidate), candidate);
    }
    for (const name of ['llama.cpp', 'vllm', 'mlx-vlm', 'sglang', null]) {
      for (const format of ['gguf', 'hf-safetensors', 'mlx', 'unknown']) {
        const engineNeutral = { ...serving, runtime: { ...serving.runtime, name, variant: 'arbitrary-safe-variant' }, model: { ...serving.model, format } };
        assert.equal(validatePublicBenchmark(engineNeutral), engineNeutral);
      }
    }
    const host = { scope: 'aiolm_host', os: null, arch: null, cpu: { name: null, logical_cores: 0 },
      installed_gpus: [], execution: { mode: 'unknown', selected_gpus: [], selection_complete: false } };
    assert.equal(validatePublicBenchmark({ ...serving, environment: host }).environment, host);
    const { scope, ...unscopedHost } = host;
    assert.throws(() => validatePublicBenchmark({ ...serving, environment: unscopedHost }));
    const source = { kind: 'huggingface', repository: 'example/model-name', revision: 'b'.repeat(40) };
    assert.equal(validatePublicBenchmark({ ...serving, model: { ...serving.model, source, size_bytes: Number.MAX_SAFE_INTEGER } }).model.source, source);
    for (const badSource of [{ ...source, repository: '../private' }, { ...source, revision: 'B'.repeat(40) }, { ...source, local_path: 'private' },
      { ...source, repository: 'a/' + 'b'.repeat(129) }, { ...source, repository: 'example/model..name' }]) {
      assert.throws(() => validatePublicBenchmark({ ...serving, model: { ...serving.model, source: badSource } }));
    }
    const metadata = { format: 'GGUF', name: null, architecture: null, size_label: null, quantization: null,
      file_type: null, quantized_by: null, repository: null, base_models: [], artifact: null, source: 'gguf' };
    assert.equal(validatePublicBenchmark({ ...serving, model: { ...serving.model, format: 'gguf', metadata } }).model.metadata, metadata);
    assert.throws(() => validatePublicBenchmark({ ...serving, model: { ...serving.model, metadata } }));
    const configuration = { runtime: serving.runtime, execution: { ...serving.execution, settings: [] } };
    assert.equal(validateBenchmarkConfiguration(configuration), configuration);
    assert.throws(() => validateBenchmarkConfiguration({ ...configuration, model: serving.model }));
    assert.throws(() => validateBenchmarkConfiguration({ runtime: serving.runtime }));
    assert.throws(() => validateBenchmarkConfiguration({ ...configuration, runtime: { ...serving.runtime, process_id: 'private' } }));
    const launch = { target: 'launch', scope: [], name: 'threads', value: 8, unit: 'threads', role: null };
    const configWith = settings => ({ ...configuration, execution: { ...configuration.execution, settings } });
    for (const value of [null, false, 0, -1, 0.5, 'safe-choice', [], [1, -1, 0.5]]) {
      const candidate = configWith([{ ...launch, value }]);
      assert.equal(validateBenchmarkConfiguration(candidate), candidate);
    }
    const boundedSettings = Array.from({ length: 128 }, (_, index) => ({ ...launch, name: 'setting-' + String(index).padStart(3, '0') }));
    assert.equal(validateBenchmarkConfiguration(configWith(boundedSettings)).execution.settings.length, 128);
    for (const settings of [
      [...boundedSettings, { ...launch, name: 'z' }], [launch, launch], [{ ...launch, scope: Array(9).fill('serve') }],
      [{ ...launch, scope: ['bad/scope'] }], [{ ...launch, name: '-bad' }], [{ ...launch, name: 'x'.repeat(65) }],
      [{ ...launch, unit: 'secret' }], [{ ...launch, role: 'private' }], [{ ...launch, value: 'x'.repeat(129) }],
      [{ ...launch, value: '-injected' }], [{ ...launch, value: '/private/path' }], [{ ...launch, value: 'user@host' }],
      [{ ...launch, value: { secret: true } }], [{ ...launch, value: [true] }], [{ ...launch, value: Array(65).fill(1) }],
      [{ ...launch, value: NaN }], [{ ...launch, value: [Infinity] }], [{ ...launch, raw_argv: ['--secret'] }],
      [{ ...launch, target: 'request', name: 'model' }], [{ ...launch, target: 'request', name: 'temperature', value: 0, unit: null, scope: ['serve'] }],
    ]) assert.throws(() => validateBenchmarkConfiguration(configWith(settings)));
    const scopedSettings = [launch, { ...launch, scope: ['serve'] }, { ...launch, scope: ['serve', 'worker'] }];
    assert.equal(validateBenchmarkConfiguration(configWith(scopedSettings)).execution.settings.length, 3);
    assert.throws(() => validateBenchmarkConfiguration(configWith(scopedSettings.toReversed())));
    for (const topology of ['attached', 'unknown']) assert.throws(() => validateBenchmarkConfiguration({
      ...configuration, execution: { ...configuration.execution, topology, memory_scope: 'owned_process_tree' } }));

    const metricKeys = ['first_output_ms', 'prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms',
      'reported_tokens_per_second', 'output_bytes_per_second', 'e2e_ms', 'peak_memory_bytes'];
    assert.deepEqual(SERVING_METRIC_KEYS, metricKeys);
    assert.deepEqual(Object.keys(servingMetricValues(observed)).sort(), [...metricKeys].sort());
    assert.equal(servingMetricValues(observed).output_bytes_per_second, 60);
    assert.equal(servingMetricValues(observed).reported_tokens_per_second, null);
    assert.equal(servingMetricValues(usage.measurements.rows[0]).prefill_tokens_per_second, 1100);
    assert.equal(servingMetricValues(usage.measurements.rows[0]).decode_tokens_per_second, 100);
    assert.equal(servingMetricValues(usage.measurements.rows[0]).tpot_ms, 10);
    const point = summarizeServingPoints([10, null, 30].map(first_output_ms => ({ ...observed, first_output_ms })))[0];
    assert.deepEqual(Object.keys(point).sort(), ['input_bytes', 'concurrency', 'max_output_tokens', 'samples', ...metricKeys].sort());
    assert.deepEqual(point.first_output_ms, { median: 20, min: 10, max: 30, samples: 2 });
    assert.equal(point.samples, 3);
    const throughputRows = [1, 2].map(repetition => ({ ...usage.measurements.rows[0], repetition,
      output_bytes: 600, reported_completion_tokens: 128, e2e_ms: 2000, tpot_ms: 10 }));
    const throughput = summarizeServingPoints(throughputRows)[0];
    assert.equal(throughput.output_bytes_per_second.median, 300);
    assert.equal(throughput.reported_tokens_per_second.median, 64);
    assert.equal(throughput.tpot_ms.median, 10);
    const clean = summarizeServingPoints([observed, { ...observed, failed: true }, { ...observed, error: 'private failure' },
      { ...observed, input_bytes: 8192, failed: true }, { ...observed, input_bytes: 16384, error: 'private failure' }]);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].samples, 1);
    assert.equal(servingMetricValues({ ...observed, output_bytes: 0 }).output_bytes_per_second, 0);
    for (const e2e_ms of [0, 1e-320]) {
      const extreme = { ...observed, output_bytes: 1, e2e_ms };
      assert.equal(servingMetricValues(extreme).output_bytes_per_second, null);
      assert.equal(summarizeServingPoints([extreme])[0].output_bytes_per_second, null);
      assert.equal(servingMetricValues({ ...extreme, reported_completion_tokens: 1 }).reported_tokens_per_second, null);
      assert.equal(validatePublicBenchmark({ ...serving, measurements: { status: 'complete', rows: [extreme] } }).measurements.rows[0], extreme);
    }
    assert.equal(servingMetricValues({ ...observed, reported_completion_tokens: 2 }).reported_tokens_per_second, 10);
    assert.equal(servingMetricValues({ ...observed, reported_completion_tokens: 0 }).reported_tokens_per_second, 0);
    const sorted = summarizeServingPoints([
      { ...observed, input_bytes: 8192, concurrency: 2 },
      { ...observed, input_bytes: 8192 }, { ...observed, concurrency: 2 },
      { ...observed, max_output_tokens: 64 }, observed,
    ]);
    assert.deepEqual(sorted.map(point => [point.input_bytes, point.concurrency, point.max_output_tokens]), [[4096, 1, 64], [4096, 1, 128], [8192, 1, 128], [4096, 2, 128], [8192, 2, 128]]);
    assert.equal(summarizeServingPoints([{ ...observed, e2e_ms: Number.MAX_VALUE }, { ...observed, e2e_ms: Number.MAX_VALUE }])[0].e2e_ms.median, Number.MAX_VALUE);
    const timestamp = value => assertIsoTimestamp(value);
    for (const value of [
      '2024-02-29T23:59:59Z',
      '2024-02-29T23:59:59.123456789+05:30',
      '2024-02-29t23:59:59.1z',
      '2000-02-29T00:00:00-04:00',
      '0000-02-29T00:00:00Z',
    ]) assert.equal(timestamp(value), value);
    for (const value of [
      'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)',
      '2023-02-29T00:00:00Z',
      '2024-13-01T00:00:00Z',
      '2024-02-29T24:00:00Z',
      '2024-02-29T00:00:00',
      '', undefined, null, 42,
    ]) assert.throws(() => timestamp(value));
    assert.equal(validateBenchmarkReceipt({ submission_id: serving.submission_id, id: 'accepted-1' }, serving.submission_id).id, 'accepted-1');
    assert.throws(() => validateBenchmarkReceipt({ submission_id: serving.submission_id, id: 'accepted-1' }, '00000000-0000-4000-8000-000000000002'));
    assert.throws(() => validateBenchmarkReceipt({ submission_id: serving.submission_id, id: 'accepted-1', url: 'invalid url' }));
    assert(Object.isFrozen(publicBenchmarkSchema.$defs.serving.properties));
    assert(Object.isFrozen(publicationSchema.properties));
    assert.equal(typeof globalThis.__TAURI_INTERNALS__, 'undefined');
    const publication = validatePublicationRequest({ benchmark: serving, description_md: 'Hello **world**' });
    assert.equal(publication.description_md, 'Hello **world**');
    assert.deepEqual(normalizePublicationInput(publication), publication);
    for (const normalize of [normalizePublicationInput, validatePublicationRequest, serializePublicationRequest]) {
      assert.throws(() => normalize(serving), 'Bare submissions are not publication requests.');
    }
    assert.throws(() => parsePublicationSnapshot(JSON.stringify(serving)));
    assert.throws(() => validatePublicationRequest({ ...publication, extra: true }));
    assert.throws(() => validatePublicationRequest({ benchmark: serving }));
    const fence = String.fromCharCode(96, 96, 96);
    const tick = String.fromCharCode(96);
    assert.equal(validateDescriptionMd(fence + 'html\\n<script>alert(1)</script>\\n' + fence), fence + 'html\\n<script>alert(1)</script>\\n' + fence);
    assert.equal(validateDescriptionMd('See <https://example.test/run/1> for details.'), 'See <https://example.test/run/1> for details.');
    assert.equal(validateDescriptionMd('Code sample: ' + tick + '![alt](https://example.test/x.png)' + tick + ' stays literal.'), 'Code sample: ' + tick + '![alt](https://example.test/x.png)' + tick + ' stays literal.');
    assert.equal(validateDescriptionMd('Reference link [site][1]\\n\\n[1]: https://example.test'), 'Reference link [site][1]\\n\\n[1]: https://example.test');
    assert.equal(validateDescriptionMd('import x from "y" in a code fence:\\n' + fence + 'js\\nimport x from "y"\\n' + fence), 'import x from "y" in a code fence:\\n' + fence + 'js\\nimport x from "y"\\n' + fence);
    assert.throws(() => validateDescriptionMd('x'.repeat(4001)));
    assert.throws(() => validateDescriptionMd(42));
    const body = serializePublicationRequest(publication);
    assert.equal(body, JSON.stringify({ benchmark: serving, description_md: 'Hello **world**' }));
    assert.equal(utf8ByteLength(body), new TextEncoder().encode(body).length);
    const originalStringify = JSON.stringify;
    let publicationStringifications = 0;
    JSON.stringify = function(value, ...rest) {
      if (value?.benchmark === serving) publicationStringifications++;
      return originalStringify.call(this, value, ...rest);
    };
    try {
      assert.equal(serializePublicationRequest(publication), body);
    } finally {
      JSON.stringify = originalStringify;
    }
    assert.equal(publicationStringifications, 1, 'Publication serialization should stringify the normalized request once.');
    assert.equal(parsePublicationSnapshot(body).benchmark.submission_id, serving.submission_id);
    assert.deepEqual(parsePublicationSnapshot(body).benchmark.measurements.rows[0].input_sha256_by_request, ['a'.repeat(64)]);
    assert.equal(parsePublicationSnapshot(body).benchmark.workload.prompt_nonce, '0123456789abcdef0123456789abcdef');
    assert.throws(() => parsePublicationSnapshot('{invalid'));
    const unicodeDescription = '😀'.repeat(DESCRIPTION_MAX_CODEPOINTS);
    assert.equal(countCodePoints(unicodeDescription), DESCRIPTION_MAX_CODEPOINTS);
    assert.equal(validateDescriptionMd(unicodeDescription), unicodeDescription);
    assert.throws(() => validateDescriptionMd(unicodeDescription + '😀'), /Publication description exceeds 4000 characters\\./);

    assert.equal(PUBLICATION_MAX_ROWS, 10000);
    // A complete 64-point, 100-repetition grid is the largest supported method workload.
    const maximumGrid = withGrid({ ...maxPoints.workload, concurrencies: [2], repetitions: 100 });
    assert.equal(validatePublicationRequest({ benchmark: maximumGrid, description_md: '' }).benchmark.measurements.rows.length, 6400);
    assert.throws(() => validatePublicationRequest({
      benchmark: { ...maximumGrid, measurements: { status: 'complete', rows: Array(PUBLICATION_MAX_ROWS + 1).fill(observed) } },
      description_md: ''
    }), /Invalid public benchmark field: benchmark\\.measurements\\.rows/);

    // Increase only valid observations; grid membership and unique request evidence stay intact.
    const largeRows = maximumGrid.measurements.rows.map(row => ({ ...row,
      first_output_ms: Number.MAX_VALUE, e2e_ms: Number.MAX_VALUE, output_bytes: Number.MAX_SAFE_INTEGER,
      reported_prompt_tokens: Number.MAX_SAFE_INTEGER, reported_completion_tokens: Number.MAX_SAFE_INTEGER,
      prefill_tokens_per_second: Number.MAX_VALUE, decode_tokens_per_second: Number.MAX_VALUE, tpot_ms: Number.MAX_VALUE,
      usage_status: 'complete', finish_reasons: Array(row.concurrency).fill('not_reported'), peak_memory_bytes: Number.MAX_SAFE_INTEGER }));
    const requestForLargeRowCount = largeRowCount => ({
      benchmark: { ...maximumGrid, execution: { ...maximumGrid.execution, topology: 'owned', memory_scope: 'owned_process_tree' },
        measurements: { status: 'complete', rows: maximumGrid.measurements.rows.map((row, index) => index < largeRowCount ? largeRows[index] : row) } },
      description_md: ''
    });
    assert(utf8ByteLength(JSON.stringify(requestForLargeRowCount(0))) < PUBLICATION_MAX_UTF8_BYTES);
    assert(utf8ByteLength(JSON.stringify(requestForLargeRowCount(largeRows.length))) > PUBLICATION_MAX_UTF8_BYTES);
    let lowerLargeRowCount = 0;
    let upperLargeRowCount = largeRows.length;
    while (lowerLargeRowCount < upperLargeRowCount) {
      const candidate = Math.ceil((lowerLargeRowCount + upperLargeRowCount) / 2);
      const candidateBody = JSON.stringify(requestForLargeRowCount(candidate));
      if (utf8ByteLength(candidateBody) <= PUBLICATION_MAX_UTF8_BYTES) lowerLargeRowCount = candidate;
      else upperLargeRowCount = candidate - 1;
    }
    const boundaryRequest = requestForLargeRowCount(lowerLargeRowCount);
    const boundaryBytes = utf8ByteLength(JSON.stringify(boundaryRequest));
    const boundaryDescriptionLength = PUBLICATION_MAX_UTF8_BYTES - boundaryBytes;
    assert(boundaryDescriptionLength >= 0 && boundaryDescriptionLength <= DESCRIPTION_MAX_CODEPOINTS, 'Synthetic boundary request did not leave a valid description range.');
    boundaryRequest.description_md = 'x'.repeat(boundaryDescriptionLength);
    const exactLimitBody = serializePublicationRequest(boundaryRequest);
    assert.equal(utf8ByteLength(exactLimitBody), PUBLICATION_MAX_UTF8_BYTES);
    assert.equal(parsePublicationSnapshot(exactLimitBody).description_md.length, boundaryDescriptionLength);
    const overlimitRequest = { ...boundaryRequest, description_md: boundaryRequest.description_md + 'x' };
    assert.equal(utf8ByteLength(JSON.stringify(overlimitRequest)), PUBLICATION_MAX_UTF8_BYTES + 1);
    assert.throws(() => serializePublicationRequest(overlimitRequest), /Publication request exceeds 4MiB\\./);
    assert.throws(() => parsePublicationSnapshot(JSON.stringify(overlimitRequest)), /Publication request exceeds 4MiB\\./);
    const code = encodeRecoveryCode(RECOVERY_FIXTURE);
    assert.ok(code.startsWith('aiolm-recovery-v1.'));
    assert.equal(code, 'aiolm-recovery-v1.eyJ2ZXJzaW9uIjoxLCJvcmlnaW4iOiJodHRwczovL2JlbmNobWFya3MuZXhhbXBsZS50ZXN0Iiwic3VibWlzc2lvbl9pZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInNlY3JldCI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUEifQ');
    assert.equal(decodeRecoveryCode(code).submission_id, RECOVERY_FIXTURE.submission_id);
    assert.throws(() => decodeRecoveryCode(code, 'https://other.example.test'));
    assert.deepEqual([...base64UrlDecode('AA')], [0]);
    assert.throws(() => base64UrlDecode('AB'));
    assert.throws(() => decodeRecoveryCode('aiolm-recovery-v1.' + base64UrlEncode(new Uint8Array([255, 255]))));
    assert.throws(() => normalizeServiceOrigin('https://example.test/api'));
    assert.throws(() => normalizeServiceOrigin('https://example.test/api/'));
    assert.throws(() => encodeRecoveryCode({ ...RECOVERY_FIXTURE, origin: 'https://example.test/api' }));
    assert.equal(normalizeServiceOrigin('https://example.test/'), 'https://example.test');
    assert.equal(normalizeServiceOrigin('https://example.test'), 'https://example.test');
    assert.equal(parseServiceError(401, JSON.stringify({ error: { code: 'verification_required', message: 'Verify' } }), 1000).recoverable, true);
    assert.equal(parseServiceError(410, JSON.stringify({ error: { code: 'submission_deleted', message: 'Gone' } })).terminal, true);
    assert.equal(benchmarkRunsUrl('https://example.test/'), 'https://example.test/v1/benchmark-runs');
    assert.throws(() => normalizeBaseUrl('http://example.test'));
    const label = input => formatRuntimeVersionLabel(input);
    assert.equal(label({ name: 'llama.cpp', version: '0.3.0-dev', build: 'b10638' }), '0.3.0-dev(10638)');
    assert.equal(label({ name: 'llama.cpp', version: '0.3.0-dev', build: 10638 }), '0.3.0-dev(10638)');
    assert.equal(label({ name: 'llama.cpp', version: '0.3.0-dev' }), '0.3.0-dev');
    assert.equal(label({ name: 'llama.cpp', build: 'b10638' }), 'b10638');
    assert.equal(label({ name: 'llama.cpp', version: null, build: null }), null);
    assert.equal(label({ name: 'llama.cpp', version: 'unknown', build: '' }), null);
    assert.equal(label({ name: 'llama.cpp', version: '0.3.0-dev (build 10638, commit bf9421646)', build: 'b1' }), '0.3.0-dev(10638)');
    assert.equal(label({ name: 'llama.cpp', version: 'compiler: x\\nversion: 0.3.0-dev (build 10638, commit bf9421646)' }), '0.3.0-dev(10638)');
    assert.equal(label({ name: 'llama.cpp', version: 'version: 4589 (1a2b3c4)', build: 'b9999' }), 'b4589');
    assert.equal(label({ name: 'llama.cpp', version: 'b123-abcdef', build: 'b9999' }), 'b123');
    assert.equal(label({ name: 'llama.cpp', build: 'pr12345' }), 'pr12345');
    assert.equal(label({ name: 'llama.cpp', version: '0.0.0-dev (build 0, commit unknown)', build: 'pr12345' }), '0.0.0-dev(pr12345)');
    assert.equal(label({ name: 'llama.cpp', version: 'version: 0 (unknown)', build: 0 }), null);
    assert.equal(label({ name: 'llama.cpp', version: '0.3.0-dev', build: 'b0' }), '0.3.0-dev');
    assert.equal(label({ name: 'llama.cpp', build: 'local_b10840_nop2p' }), 'local_b10840_nop2p');
    assert.equal(label({ name: 'vllm', version: '0.6.3.post1' }), '0.6.3.post1');
    assert.equal(label({ name: 'MLX', version: 'b123-abcdef', build: 'b7' }), 'b123-abcdef(b7)');
    assert.equal(label({ version: 'version: 0.3.0-dev (build 10638)' }), 'version: 0.3.0-dev (build 10638)');
    assert.equal(label({ name: 'vllm' }), null);
    assert.equal(label({ name: 'vllm', variant: 'vllm-metal', version: '0.30.0', plugin_version: '0.30.0', build: 'stale-build' }), 'vllm-metal 0.30.0 · vLLM 0.30.0');
  `);
  execFileSync(process.execPath, ['node-smoke.mjs'], { cwd: consumer, stdio: 'pipe', windowsHide: true });

  // A browser ESM graph can load only packed relative modules, with no Node or app globals.
  const context = createContext({ URL, TextEncoder, TextDecoder: globalThis.TextDecoder });
  const modules = new Map();
  const getModule = path => {
    const absolute = realpathSync(path);
    assert(absolute.startsWith(`${installedDist}${sep}`), 'Browser module escaped the packed runtime.');
    if (!modules.has(absolute)) modules.set(absolute, new SourceTextModule(readFileSync(absolute, 'utf8'), { context, identifier: pathToFileURL(absolute).href }));
    return modules.get(absolute);
  };
  const browser = getModule(entryPath);
  await browser.link((specifier, referencing) => {
    assert(specifier.startsWith('./'), `Browser runtime imported an external module: ${specifier}`);
    return getModule(resolve(dirname(fileURLToPath(referencing.identifier)), specifier));
  });
  await browser.evaluate();
  assert.equal(browser.namespace.validatePublicBenchmark(serving), serving);
  const browserSnapshot = browser.namespace.serializePublicationRequest({ benchmark: serving, description_md: '' });
  assert.deepEqual(JSON.parse(browserSnapshot).benchmark.measurements.rows[0].input_sha256_by_request, ['a'.repeat(64)]);
  assert.equal(browser.namespace.parsePublicationSnapshot(browserSnapshot).benchmark.method.version, 5);
  assert.equal(browser.namespace.servingMetricValues(servingRow).output_bytes_per_second, 60);
  assert.equal(browser.namespace.validateBenchmarkConfiguration({ runtime: serving.runtime, execution: serving.execution }).runtime, serving.runtime);
  const browserPoint = browser.namespace.summarizeServingPoints([servingRow])[0];
  assert.equal(browserPoint.first_output_ms.median, 50);
  assert.equal(browserPoint.reported_tokens_per_second, null);
  assert.equal(browser.namespace.summarizeServingPoints([{ ...servingRow, failed: true }]).length, 0);

  const publicSchema = JSON.parse(readFileSync(consumerRequire.resolve('@aiolm/benchmark-contracts/schema'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(browser.namespace.publicBenchmarkSchema)), publicSchema);
  const openapi = JSON.parse(readFileSync(consumerRequire.resolve('@aiolm/benchmark-contracts/openapi'), 'utf8'));
  assert.equal(openapi.info.version, '3.0.0');
  assert.equal(JSON.parse(readFileSync(consumerRequire.resolve('@aiolm/benchmark-contracts/package.json'), 'utf8')).version, '0.15.0');
  assert(publicSchema.$defs.servingRuntime && publicSchema.$defs.servingExecution);
  const requestSchema = openapi.paths['/v1/benchmark-runs'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(requestSchema, { $ref: './publication.schema.json' });
  assert.equal(openapi.paths['/v1/upload-sessions'].post.operationId, 'createUploadSession');
  assert.equal(openapi.paths['/v1/benchmark-runs/{id}'].delete.operationId, 'deleteBenchmarkRun');
  assert.equal(browser.namespace.validatePublicationRequest({ benchmark: serving, description_md: '' }).description_md, '');
  const browserPublication = { benchmark: serving, description_md: '😀'.repeat(4000) };
  assert.equal(browser.namespace.countCodePoints(browserPublication.description_md), 4000);
  assert.equal(browser.namespace.serializePublicationRequest(browserPublication), JSON.stringify(browserPublication));
  assert.throws(() => browser.namespace.validateDescriptionMd(browserPublication.description_md + '😀'), /Publication description exceeds 4000 characters\./);
  assert.throws(() => browser.namespace.validatePublicBenchmark({}), /Invalid public benchmark field/);
  assert.equal(browser.namespace.formatRuntimeVersionLabel({ name: 'llama.cpp', version: '0.3.0-dev', build: 'b10638' }), '0.3.0-dev(10638)');
  assert.equal(browser.namespace.decodeRecoveryCode(browser.namespace.encodeRecoveryCode(browser.namespace.RECOVERY_FIXTURE)).version, 1);

  writeFileSync(join(consumer, 'consumer.ts'), `
    import { validatePublicBenchmark, validateBenchmarkConfiguration, validateBenchmarkReceipt, summarizeServingPoints, servingMetricValues, validatePublicationRequest, decodeRecoveryCode, formatRuntimeVersionLabel, type RuntimeVersionLabelInput, type PublicBenchmarkSubmission, type BenchmarkEnvironment, type BenchmarkConfiguration, type ServingBenchmarkPoint, type ServingMetricKey, type BenchmarkReceipt, type BenchmarkPublicationRequest } from '@aiolm/benchmark-contracts';
    const payload: PublicBenchmarkSubmission = validatePublicBenchmark({});
    const schemaVersion: 4 = payload.schema_version;
    const servingPoints: ServingBenchmarkPoint[] = summarizeServingPoints(payload.measurements.rows);
    const metricValues: Record<ServingMetricKey, number | null> = servingMetricValues(payload.measurements.rows[0]);
    const environment: BenchmarkEnvironment | null = payload.environment;
    const configuration: BenchmarkConfiguration = validateBenchmarkConfiguration({});
    const receipt: BenchmarkReceipt = validateBenchmarkReceipt({}, payload.submission_id);
    const publication: BenchmarkPublicationRequest = validatePublicationRequest({ benchmark: payload, description_md: '' });
    const runtimeInput: RuntimeVersionLabelInput = { name: payload.runtime.name, version: payload.runtime.version, build: payload.runtime.build };
    const runtimeLabel: string | null = formatRuntimeVersionLabel(runtimeInput);
    const metalIdentity: PublicBenchmarkSubmission['runtime'] = { name: 'vllm', version: '0.30.0', backend: 'metal', build: null, variant: 'vllm-metal', plugin_version: '0.30.0' };
    const servingInput: import('@aiolm/benchmark-contracts').ServingInput = { bytes: 4096, sha256: 'a'.repeat(64) };
    const servingWorkload: import('@aiolm/benchmark-contracts').ServingWorkload = { corpus: 'novel_en', corpus_version: 2,
      inputs: [servingInput], max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: false, request_usage: false,
      cache_policy: 'cold_prompt', prompt_nonce: '0123456789abcdef0123456789abcdef' };
    const servingRow: import('@aiolm/benchmark-contracts').ServingBenchmarkRow = ${JSON.stringify(servingRow)};
    const servingMethod: import('@aiolm/benchmark-contracts').ServingPublicBenchmarkSubmission['method'] = { id: 'openai-chat-serving', version: 5 };
    export { servingInput, servingWorkload, servingMethod, servingRow };
    export { schemaVersion, servingPoints, metricValues, environment, configuration, receipt, publication, runtimeLabel, metalIdentity };
  `);
  const program = ts.createProgram([join(consumer, 'consumer.ts')], { strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
  for (const path of packedPaths) {
    if (!/\.(?:js|ts|json)$/.test(path)) continue;
    const text = readFileSync(join(installedDist, '..', path), 'utf8');
    assert(!/(?:[A-Z]:[\\/]Users[\\/]|\/Users\/|\/home\/|src\/shared\/api|@tauri-apps)/.test(text), `Environment or app dependency leaked into ${path}`);
  }
  process.stdout.write('Packed contracts passed offline install, Node/browser imports, schema checks and isolated TypeScript consumption.\n');
} finally {
  const target = realpathSync(scratch);
  assert.equal(dirname(target), scratchParent, 'Refusing to clean a path outside the test scratch directory.');
  assert(basename(target).startsWith('aiolm-contracts-'), 'Refusing to clean an unexpected scratch directory.');
  rmSync(target, { recursive: true, force: true });
}
