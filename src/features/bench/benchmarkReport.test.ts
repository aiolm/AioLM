// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Workbook } from 'exceljs';
import type { PerformanceBenchmarkRow } from '../../shared/api/types';
import { benchmarkReport } from './benchmarkReport';
import { benchmarkWorkbook } from './benchmarkWorkbook';
import { performanceMarkdown } from './performanceMarkdown';
import { benchmarkHistoryModelLabel, recordedBenchmarkModelLabel, performanceCsv, type LegacyPerformanceBenchmarkRecord, type ServingPerformanceBenchmarkRecord } from './performanceRecords';

function serving(rows: PerformanceBenchmarkRow[]): ServingPerformanceBenchmarkRecord {
  return {
    schemaVersion: 2, id: 'serving', model: '/synthetic/private/replaced-model', createdAt: Date.UTC(2026, 8, 12),
    request: { run_id: 'serving', method: { id: 'openai-chat-serving', version: 1 }, context_profile: 'novel_en', prompt_bytes: [4096],
      max_output_tokens: 128, concurrencies: [1], repetitions: 3, warmup: true, request_usage: false },
    result: { run_id: 'serving', status: 'complete', rows, args: ['--threads', '8', '--credential', 'PRIVATE-TOKEN'], provenance: {
      schema_version: 2, app_version: '0.3.5', method: { id: 'openai-chat-serving', version: 1 }, recorded_model_label: 'Recorded-label',
      runtime: { name: 'sglang', version: '1.2', backend: 'cuda', build: 'build-7', variant: 'variant-x', plugin_version: null },
      model: { format: 'hf-safetensors', status: 'sha256', sha256: 'a'.repeat(64), size_bytes: 123456,
        repository: 'Example/Recorded-model', revision: 'b'.repeat(40), local_fingerprint: 'PRIVATE-FINGERPRINT' },
      workload: { corpus: 'novel_en', corpus_version: 1, inputs: [{ bytes: 4096, sha256: 'c'.repeat(64) }], max_output_tokens: 128,
        concurrencies: [1], repetitions: 3, warmup: true, request_usage: false, cache_policy: 'as_configured' },
      execution: { topology: 'owned', memory_scope: 'owned_process_tree', settings: [
        { target: 'launch', scope: [], name: 'threads', value: null, unit: 'threads', role: null },
        { target: 'launch', scope: ['serve'], name: 'enabled', value: false, unit: null, role: null },
        { target: 'request', scope: [], name: 'max_tokens', value: 128, unit: 'tokens', role: null },
        { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
        { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
      ] },
      environment: { scope: 'aiolm_host', os: 'test', arch: 'test', cpu: { name: 'CPU', logical_cores: 4 }, installed_gpus: [],
        execution: { mode: 'unknown', selected_gpus: [], devices: [], selection_complete: false }, detection: 'test' },
    } },
  };
}
function trial(overrides: Partial<PerformanceBenchmarkRow> = {}): PerformanceBenchmarkRow {
  return { id: 'trial', input_bytes: 4096, max_output_tokens: 128, concurrency: 1, repetition: 1,
    first_output_ms: 10, first_content_ms: 10, first_reasoning_ms: null, e2e_ms: 1000,
    content_bytes: 10, reasoning_bytes: 0, output_bytes: 10, reported_prompt_tokens: null, reported_completion_tokens: null,
    reported_cached_tokens: null, usage_status: 'missing', finish_reasons: ['stop'], peak_memory_bytes: null,
    timing_source: 'client', failed: false, ...overrides };
}
const csvCells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replace(/""/g, '"'));
const markdownCells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());

// Export seams: frozen local record -> actual CSV, reopened workbook and copied Markdown.
describe('benchmark report exports', () => {
  it('preserves the same frozen identity, typed settings and observed statistics in all three formats', async () => {
    const record = serving([
      trial(),
      trial({ id: 'trial-2', repetition: 2, first_output_ms: null, first_content_ms: null, e2e_ms: 0, content_bytes: 20, output_bytes: 20 }),
      trial({ id: 'trial-3', repetition: 3, first_output_ms: 30, first_content_ms: 30, content_bytes: 30, output_bytes: 30 }),
    ]);
    const report = benchmarkReport([record]);
    const csv = performanceCsv([record]).trim().split('\r\n').map(csvCells);
    const markdown = performanceMarkdown(record, 'en').split('\n').filter(line => line.startsWith('|')).map(markdownCells);
    const workbook = new Workbook();
    await workbook.xlsx.load(await benchmarkWorkbook(report) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0];
    const expected = {
      'Model': 'Recorded-label', 'Method': 'openai-chat-serving@1', 'Input unit': 'utf8_bytes',
      'Runtime name': 'sglang', 'Runtime version': '1.2', 'Runtime backend': 'cuda', 'Runtime build': 'build-7',
      'Runtime variant': 'variant-x', 'Runtime plugin version': null, 'Model format': 'hf-safetensors',
      'Model identity status': 'sha256', 'Model SHA256': 'a'.repeat(64), 'Model size (bytes)': 123456,
      'Model repository': 'Example/Recorded-model', 'Model revision (not weight SHA)': 'b'.repeat(40),
      'App version': '0.3.5', 'Execution topology': 'owned', 'Memory scope': 'owned_process_tree',
      'Input UTF8 bytes': 4096, 'Max output token request': 128, 'Samples': 3,
      'First output (ms) · median': 20, 'First output (ms) · min': 10, 'First output (ms) · max': 30, 'First output (ms) · samples': 2,
      'Observed output (B/s) · median': 20, 'Observed output (B/s) · min': 10, 'Observed output (B/s) · max': 30, 'Observed output (B/s) · samples': 2,
      'Reasoning (bytes) · median': 0, 'Reported tokens/s · median': null,
      'Legacy · token-based cold-prompt method · Input processing (Prefill / PP) · estimated (tok/s)': null,
    };
    for (const [header, value] of Object.entries(expected)) {
      const index = csv[0].indexOf(header);
      expect(index, header).toBeGreaterThanOrEqual(0);
      expect(csv[1][index], header).toBe(value == null ? '' : String(value));
      expect(sheet.getCell(2, index + 1).value, header).toBe(value);
      expect(markdown[2][index], header).toBe(value == null ? 'N/A' : String(value));
    }
    const settings = JSON.parse(csv[1][csv[0].indexOf('Public settings')]);
    expect(settings).toEqual([
      { target: 'launch', scope: [], name: 'threads', value: null, unit: 'threads', role: null },
      { target: 'launch', scope: ['serve'], name: 'enabled', value: false, unit: null, role: null },
      { target: 'request', scope: [], name: 'max_tokens', value: 128, unit: 'tokens', role: null },
      { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
      { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
    ]);
    expect(sheet.getCell(2, csv[0].indexOf('Public settings') + 1).value).toBe(JSON.stringify(settings));
    expect(performanceMarkdown(record, 'en')).toContain('"value":null');
    for (const exported of [csv.join('\n'), JSON.stringify(sheet.getSheetValues()), performanceMarkdown(record, 'en')]) {
      expect(exported).not.toMatch(/synthetic|PRIVATE|--threads|--credential|replaced-model|local_fingerprint|Infinity|NaN/);
    }
  });

  it('distinguishes unknown derived rates from observed zero without re-averaging or nonfinite output', () => {
    const record = serving([
      trial({ e2e_ms: 1e-320, content_bytes: 1, output_bytes: 1 }),
      trial({ id: 'zero', input_bytes: 8192, e2e_ms: 1, first_output_ms: null, first_content_ms: null, content_bytes: 0, output_bytes: 0 }),
    ]);
    const report = benchmarkReport([record]);
    const rate = report.columns.findIndex(column => column.key === 'output_bytes_per_second.median');
    const samples = report.columns.findIndex(column => column.key === 'output_bytes_per_second.samples');
    expect(report.rows[0][rate]).toBeNull();
    expect(report.rows[0][samples]).toBeNull();
    expect(report.rows[1][rate]).toBe(0);
    expect(report.rows[1][samples]).toBe(1);
    expect(performanceCsv([record])).not.toMatch(/Infinity|NaN/);
    expect(performanceMarkdown(record, 'en')).not.toMatch(/Infinity|NaN/);
  });

  it('leaves absent provenance unknown rather than deriving model identity or settings from paths and arguments', () => {
    const record = serving([]);
    delete record.result.provenance;
    record.result.status = 'failed';
    expect(benchmarkHistoryModelLabel(record)).toBe('replaced-model');
    expect(recordedBenchmarkModelLabel(record)).toBe('');
    const report = benchmarkReport([record]);
    for (const key of ['recorded_model_label', 'runtime.name', 'model.format', 'model.sha256', 'model.size_bytes', 'execution.settings']) {
      const value = report.rows[0][report.columns.findIndex(column => column.key === key)];
      expect(value).toBe(key === 'recorded_model_label' ? '' : null);
    }
    expect(performanceCsv([record])).not.toMatch(/synthetic|PRIVATE|replaced-model|--threads/);
    record.model = '/other/local-selection';
    expect(benchmarkHistoryModelLabel(record)).toBe('local-selection');
    expect(benchmarkReport([record])).toEqual(report);
  });

  it('keeps historical token measurements in separate Legacy columns when exported alongside serving data', () => {
    const legacy: LegacyPerformanceBenchmarkRecord = {
      schemaVersion: 1, id: 'old', createdAt: 0, model: 'old.gguf', backend: 'cpu', build: 'b1',
      request: { run_id: 'old', context_profile: 'novel_en', prompt_lengths: [1024], generation_length: 128, batch_sizes: [], repetitions: 1, warmup: true },
      result: { run_id: 'old', status: 'complete', args: [], runtime_version: '1', context_size: 4096, parallel: 1, rows: [{
        id: 'old-row', prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0,
        ttft_ms: 100, tpot_ms: 10, pp_tps: 10240, tg_tps: 100, e2e_ms: 1370, total_tps: 93.4, peak_memory_bytes: null, timing_source: 'client',
      }] },
    };
    const report = benchmarkReport([serving([trial()]), legacy]);
    const column = (key: string) => report.columns.findIndex(value => value.key === key);
    expect(report.rows[0][column('legacy.pp_tps')]).toBeNull();
    expect(report.rows[1][column('legacy.pp_tps')]).toBe(10240);
    expect(report.rows[1][column('legacy.tg_tps')]).toBe(100);
    expect(report.rows[1][column('legacy.tpot_ms')]).toBe(10);
    expect(report.rows[1][column('legacy.prompt_tokens')]).toBe(1024);
    expect(report.rows[1][column('input_bytes')]).toBeNull();
    expect(report.rows[1][column('first_output_ms.median')]).toBeNull();
    expect(report.rows[1][column('input_unit')]).toBe('tokens');
    expect(report.rows[1][column('method')]).toBeNull();
  });
});
