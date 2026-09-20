import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

const row = { prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1,
  completion_tokens: 128, cached_tokens: 0, ttft_ms: 40, tpot_ms: 10, pp_tps: 100,
  tg_tps: 32, e2e_ms: 1400, total_tps: 90, peak_memory_bytes: null, timing_source: 'client', failed: false };
const payload = { schema_version: 1, submission_id: '00000000-0000-4000-8000-000000000001', app_version: null, method: null,
  workload: { corpus: 'novel_en', corpus_version: null, corpus_sha256: null, prompt_lengths: [1024], generation_length: 128, batch_sizes: [2], repetitions: 2, warmup: true },
  model: { status: 'unidentified', sha256: null, size_bytes: null }, runtime: { name: 'llama.cpp', version: null, backend: 'cpu', build: null },
  environment: null, execution: { context_size: 4096, parallel: 2, settings: null },
  measurements: { status: 'complete', rows: [row, { ...row, repetition: 2, tg_tps: 64 }, { ...row, concurrency: 2, tg_tps: 96 }] },
};

try {
  const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], packageRoot));
  const archive = Array.isArray(packed) ? packed[0] : packed['@aiolm/benchmark-contracts'] ?? packed;
  assert.equal(typeof archive.filename, 'string', 'npm pack did not return an archive.');
  const packedPaths = archive.files.map(entry => entry.path);
  assert(packedPaths.includes('dist/index.js') && packedPaths.includes('dist/index.d.ts'));
  assert(packedPaths.includes('schema/public-benchmark.schema.json') && packedPaths.includes('schema/publication.schema.json') && packedPaths.includes('schema/openapi.json'));
  assert(packedPaths.includes('LICENSE'));
  for (const path of packedPaths) assert(/^(?:dist\/[^/]+\.(?:js|d\.ts)|schema\/(?:public-benchmark\.schema|publication\.schema|openapi)\.json|package\.json|README\.md|LICENSE)$/.test(path), `Unexpected packed file: ${path}`);

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
    import { validatePublicBenchmark, validateBenchmarkReceipt, summarizePublicBenchmarkRows, publicBenchmarkSchema, validatePublicationRequest, normalizePublicationInput, parsePublicationSnapshot, serializePublicationRequest, validateDescriptionMd, encodeRecoveryCode, decodeRecoveryCode, RECOVERY_FIXTURE, base64UrlEncode, base64UrlDecode, normalizeServiceOrigin, parseServiceError, normalizeBaseUrl, benchmarkRunsUrl, publicationSchema } from '@aiolm/benchmark-contracts';
    const payload = ${JSON.stringify(payload)};
    assert.equal(validatePublicBenchmark(payload), payload);
    assert.equal(summarizePublicBenchmarkRows(payload.measurements.rows).find(row => row.concurrency === 2).speedup, 2);
    assert.throws(() => validatePublicBenchmark({ ...payload, local_path: '/private/model.gguf' }));
    assert.throws(() => validatePublicBenchmark({ ...payload, constructor: 'private' }));
    assert.equal(validateBenchmarkReceipt({ submission_id: payload.submission_id, id: 'accepted-1' }, payload.submission_id).id, 'accepted-1');
    assert.throws(() => validateBenchmarkReceipt({ submission_id: payload.submission_id, id: 'accepted-1' }, '00000000-0000-4000-8000-000000000002'));
    assert.throws(() => validateBenchmarkReceipt({ submission_id: payload.submission_id, id: 'accepted-1', url: 'invalid url' }));
    assert(Object.isFrozen(publicBenchmarkSchema.properties));
    assert(Object.isFrozen(publicationSchema.properties));
    assert.equal(typeof globalThis.__TAURI_INTERNALS__, 'undefined');
    const publication = validatePublicationRequest({ benchmark: payload, description_md: 'Hello **world**' });
    assert.equal(publication.description_md, 'Hello **world**');
    assert.equal(normalizePublicationInput(payload).description_md, '');
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
    assert.equal(parsePublicationSnapshot(body).benchmark.submission_id, payload.submission_id);
    assert.throws(() => parsePublicationSnapshot('{invalid'));
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
  assert.equal(browser.namespace.validatePublicBenchmark(payload), payload);
  assert.equal(browser.namespace.summarizePublicBenchmarkRows(payload.measurements.rows).find(row => row.concurrency === 2).speedup, 2);
  const failed = browser.namespace.summarizePublicBenchmarkRows([{ ...row, failed: true }])[0];
  assert.equal(failed.samples, 0); assert.equal(failed.tg_tps, null);
  const unknown = browser.namespace.summarizePublicBenchmarkRows([{ ...row, tg_tps: null }])[0];
  assert.equal(unknown.speedup, null);

  const publicSchema = JSON.parse(readFileSync(consumerRequire.resolve('@aiolm/benchmark-contracts/schema'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(browser.namespace.publicBenchmarkSchema)), publicSchema);
  const openapi = JSON.parse(readFileSync(consumerRequire.resolve('@aiolm/benchmark-contracts/openapi'), 'utf8'));
  const requestSchema = openapi.paths['/v1/benchmark-runs'].post.requestBody.content['application/json'].schema;
  assert.ok(Array.isArray(requestSchema.oneOf) && requestSchema.oneOf.some(entry => entry.$ref === './publication.schema.json'));
  assert.ok(requestSchema.oneOf.some(entry => entry.$ref === './public-benchmark.schema.json'));
  assert.equal(openapi.paths['/v1/upload-sessions'].post.operationId, 'createUploadSession');
  assert.equal(openapi.paths['/v1/benchmark-runs/{id}'].delete.operationId, 'deleteBenchmarkRun');
  assert.equal(browser.namespace.validatePublicationRequest({ benchmark: payload, description_md: '' }).description_md, '');
  assert.equal(browser.namespace.decodeRecoveryCode(browser.namespace.encodeRecoveryCode(browser.namespace.RECOVERY_FIXTURE)).version, 1);

  writeFileSync(join(consumer, 'consumer.ts'), `
    import { validatePublicBenchmark, validateBenchmarkReceipt, summarizePublicBenchmarkRows, validatePublicationRequest, decodeRecoveryCode, type PublicBenchmarkSubmission, type BenchmarkSummary, type BenchmarkReceipt, type BenchmarkPublicationRequest } from '@aiolm/benchmark-contracts';
    const payload: PublicBenchmarkSubmission = validatePublicBenchmark({});
    const summaries: BenchmarkSummary[] = summarizePublicBenchmarkRows(payload.measurements.rows);
    const receipt: BenchmarkReceipt = validateBenchmarkReceipt({}, payload.submission_id);
    const publication: BenchmarkPublicationRequest = validatePublicationRequest({ benchmark: payload, description_md: '' });
    export { summaries, receipt, publication };
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
