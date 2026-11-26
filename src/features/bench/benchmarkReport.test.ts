// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Workbook } from 'exceljs';
import type { PerformanceBenchmarkRow } from '../../shared/api/types';
import { benchmarkReport } from './benchmarkReport';
import { benchmarkWorkbook } from './benchmarkWorkbook';
import { performanceMarkdown } from './performanceMarkdown';
import type { ServingPerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';
import { benchmarkHistoryModelLabel, recordedBenchmarkModelLabel, performanceCsv } from './performanceRecords';
import { defined } from '../../testing/assertDefined';
import { servingBenchmark } from '../../testing/servingBenchmark';
import type { Locale } from '../../shared/i18n/i18n';

function serving(rows: PerformanceBenchmarkRow[]): ServingPerformanceBenchmarkRecord {
  const record = servingBenchmark();
  record.createdAt = Date.UTC(2026, 8, 12);
  record.model = '/synthetic/private/replaced-model';
  record.request.repetitions = 3;
  record.result.rows = rows;
  record.result.args = ['--threads', '8', '--credential', 'PRIVATE-TOKEN'];
  record.result.engine_args = ['/private/engine', '--credential', 'PRIVATE-ENGINE-TOKEN'];
  record.result.engine_args_error = 'PRIVATE-ENGINE-CAPTURE-ERROR';
  const provenance = defined(record.result.provenance);
  provenance.app_version = '0.3.5';
  provenance.recorded_model_label = 'Recorded-label';
  provenance.runtime = { name: 'sglang', version: '1.2', backend: 'cuda', build: 'build-7', variant: 'variant-x', plugin_version: null };
  provenance.model = { format: 'hf-safetensors', status: 'sha256', sha256: 'a'.repeat(64), size_bytes: 123456,
    repository: 'Example/Recorded-model', revision: 'b'.repeat(40), local_fingerprint: 'PRIVATE-FINGERPRINT' };
  provenance.workload.repetitions = 3;
  provenance.execution = { topology: 'owned', memory_scope: 'owned_process_tree', settings: [
    { target: 'launch', scope: [], name: 'threads', value: null, unit: 'threads', role: null },
    { target: 'launch', scope: ['serve'], name: 'enabled', value: false, unit: null, role: null },
    { target: 'request', scope: [], name: 'max_tokens', value: 128, unit: 'tokens', role: null },
    { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
    { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
  ] };
  return record;
}
function trial(overrides: Partial<PerformanceBenchmarkRow> = {}): PerformanceBenchmarkRow {
  return { ...defined(servingBenchmark().result.rows[0]), first_output_ms: 10, e2e_ms: 1000, output_bytes: 10, ...overrides };
}
const csvCells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => defined(match[1]).replace(/""/g, '"'));
const markdownCells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());

// Export seams: frozen local record -> actual CSV, reopened workbook and copied Markdown.
describe('benchmark report exports', () => {
  it('preserves reproducibility metadata and the eight metrics in CSV, XLSX and Markdown', async () => {
    const record = servingBenchmark();
    const report = benchmarkReport([record]);
    const column = (key: string) => report.columns.findIndex(value => value.key === key);
    const metricKeys = ['first_output_ms', 'prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms',
      'reported_tokens_per_second', 'output_bytes_per_second', 'e2e_ms', 'peak_memory_bytes'];
    expect(report.columns.filter(value => /\.(median|min|max|samples)$/.test(value.key ?? '')).map(value => value.key))
      .toEqual(metricKeys.flatMap(key => ['median', 'min', 'max', 'samples'].map(stat => `${key}.${stat}`)));
    expect(report.columns).toHaveLength(60);
    expect(report.columns.map(value => value.key).join(' ')).not.toMatch(/legacy|content_bytes|reasoning_bytes|reported_prompt_tokens|reported_completion_tokens|cached|output_bytes\./);
    const csv = performanceCsv([record]).trim().split('\r\n').map(csvCells);
    const markdown = performanceMarkdown(record, 'en').split('\n').filter(line => line.startsWith('|')).map(markdownCells);
    const workbook = new Workbook();
    await workbook.xlsx.load(await benchmarkWorkbook(report));
    const sheet = defined(workbook.worksheets[0]);
    for (const [key, value] of Object.entries({
      method: 'openai-chat-serving@5', 'workload.corpus': 'novel_en', 'workload.cache_policy': 'cold_prompt',
      'workload.prompt_nonce': '0123456789abcdef0123456789abcdef', max_output_tokens: 128,
      'first_output_ms.median': 20, 'prefill_tokens_per_second.median': null, 'decode_tokens_per_second.median': null,
      'tpot_ms.median': null, 'reported_tokens_per_second.median': null, 'output_bytes_per_second.median': 60,
      'e2e_ms.median': 200, 'peak_memory_bytes.median': null,
    })) {
      const index = column(key);
      expect(index, key).toBeGreaterThanOrEqual(0);
      expect(defined(csv[1])[index]).toBe(value == null ? '' : String(value));
      expect(sheet.getCell(2, index + 1).value).toBe(value);
      expect(defined(markdown[2])[index]).toBe(value == null ? 'N/A' : String(value));
    }
    expect(JSON.stringify(sheet.getSheetValues())).not.toMatch(/PRIVATE|synthetic|private|diagnostic/);
  });

  it.each<[Locale, string[]]>([
    ['en', ['First output (ms)', 'Prompt processing per request (tok/s)', 'Generation speed per request (tok/s)', 'Time per output token (ms)', 'Total token throughput (tok/s)', 'Observed output (B/s)', 'Batch duration (ms)', 'Peak process RAM (bytes)']],
    ['ko', ['첫 출력 (ms)', '요청당 입력 처리 속도 (tok/s)', '요청당 생성 속도 (tok/s)', '출력 토큰당 시간 (ms)', '전체 토큰 처리량 (tok/s)', '관측 출력 (B/s)', '배치 소요 시간 (ms)', '최대 프로세스 RAM (bytes)']],
    ['ja', ['最初の出力 (ms)', 'リクエストあたりの入力処理速度 (tok/s)', 'リクエストあたりの生成速度 (tok/s)', '出力トークンあたりの時間 (ms)', '全体トークン処理量 (tok/s)', '観測出力 (B/s)', 'バッチ所要時間 (ms)', '最大プロセス RAM (bytes)']],
    ['zh', ['首次输出 (ms)', '每请求输入处理速度 (tok/s)', '每请求生成速度 (tok/s)', '每输出令牌时间 (ms)', '总令牌吞吐量 (tok/s)', '观测输出 (B/s)', '批次耗时 (ms)', '进程峰值 RAM (bytes)']],
  ])('keeps %s metric labels in display order', (locale, labels) => {
    expect(benchmarkReport([servingBenchmark()], locale).columns.filter(column => column.key?.endsWith('.median'))
      .map(column => column.label.split(' · ')[0])).toEqual(labels);
  });

  it('preserves the same frozen identity, typed settings and observed statistics in all three formats', async () => {
    const record = serving([
      trial(),
      trial({ id: 'trial-2', repetition: 2, first_output_ms: null, e2e_ms: 0, output_bytes: 20 }),
      trial({ id: 'trial-3', repetition: 3, first_output_ms: 30, output_bytes: 30 }),
    ]);
    const report = benchmarkReport([record]);
    const csv = performanceCsv([record]).trim().split('\r\n').map(csvCells);
    const markdown = performanceMarkdown(record, 'en').split('\n').filter(line => line.startsWith('|')).map(markdownCells);
    const workbook = new Workbook();
    await workbook.xlsx.load(await benchmarkWorkbook(report));
    const sheet = defined(workbook.worksheets[0]);
    const headers = defined(csv[0]);
    const csvValues = defined(csv[1]);
    const markdownValues = defined(markdown[2]);
    const expected = {
      'Model': 'Recorded-label', 'Method': 'openai-chat-serving@5', 'Input unit': 'utf8_bytes',
      'Runtime name': 'sglang', 'Runtime version': '1.2', 'Runtime backend': 'cuda', 'Runtime build': 'build-7',
      'Runtime variant': 'variant-x', 'Runtime plugin version': null, 'Model format': 'hf-safetensors',
      'Model identity status': 'sha256', 'Model SHA256': 'a'.repeat(64), 'Model size (bytes)': 123456,
      'Model repository': 'Example/Recorded-model', 'Model revision (not weight SHA)': 'b'.repeat(40),
      'App version': '0.3.5', 'Execution topology': 'owned', 'Memory scope': 'owned_process_tree',
      'Input UTF8 bytes': 4096, 'Max output token request': 128, 'Samples': 3,
      'First output (ms) · median': 20, 'First output (ms) · min': 10, 'First output (ms) · max': 30, 'First output (ms) · samples': 2,
      'Observed output (B/s) · median': 20, 'Observed output (B/s) · min': 10, 'Observed output (B/s) · max': 30, 'Observed output (B/s) · samples': 2,
      'Total token throughput (tok/s) · median': null, 'Time per output token (ms) · median': null,
    };
    for (const [header, value] of Object.entries(expected)) {
      const index = headers.indexOf(header);
      expect(index, header).toBeGreaterThanOrEqual(0);
      expect(csvValues[index], header).toBe(value == null ? '' : String(value));
      expect(sheet.getCell(2, index + 1).value, header).toBe(value);
      expect(markdownValues[index], header).toBe(value == null ? 'N/A' : String(value));
    }
    const settings: unknown = JSON.parse(defined(csvValues[headers.indexOf('Public settings')]));
    expect(settings).toEqual([
      { target: 'launch', scope: [], name: 'threads', value: null, unit: 'threads', role: null },
      { target: 'launch', scope: ['serve'], name: 'enabled', value: false, unit: null, role: null },
      { target: 'request', scope: [], name: 'max_tokens', value: 128, unit: 'tokens', role: null },
      { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
      { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
    ]);
    expect(sheet.getCell(2, headers.indexOf('Public settings') + 1).value).toBe(JSON.stringify(settings));
    expect(performanceMarkdown(record, 'en')).toContain('"value":null');
    for (const exported of [csv.join('\n'), JSON.stringify(sheet.getSheetValues()), performanceMarkdown(record, 'en')]) {
      expect(exported).not.toMatch(/synthetic|PRIVATE|--threads|--credential|replaced-model|local_fingerprint|Infinity|NaN/);
    }
  });

  it('distinguishes unknown derived rates from observed zero without re-averaging or nonfinite output', () => {
    const record = serving([
      trial({ e2e_ms: 1e-320, output_bytes: 1 }),
      trial({ id: 'zero', input_bytes: 8192, e2e_ms: 1, first_output_ms: null, output_bytes: 0 }),
    ]);
    const report = benchmarkReport([record]);
    const rate = report.columns.findIndex(column => column.key === 'output_bytes_per_second.median');
    const samples = report.columns.findIndex(column => column.key === 'output_bytes_per_second.samples');
    const first = defined(report.rows[0]);
    const second = defined(report.rows[1]);
    expect(first[rate]).toBeNull();
    expect(first[samples]).toBeNull();
    expect(second[rate]).toBe(0);
    expect(second[samples]).toBe(1);
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
      const value = defined(report.rows[0])[report.columns.findIndex(column => column.key === key)];
      expect(value).toBe(key === 'recorded_model_label' ? '' : null);
    }
    expect(performanceCsv([record])).not.toMatch(/synthetic|PRIVATE|replaced-model|--threads/);
    record.model = '/other/local-selection';
    expect(benchmarkHistoryModelLabel(record)).toBe('local-selection');
    expect(benchmarkReport([record])).toEqual(report);
  });

  it('exports the new usage-backed observations without deriving or exposing raw token counts', () => {
    const record = serving([trial({
      reported_prompt_tokens: 50, reported_completion_tokens: 11, usage_status: 'complete',
      prefill_tokens_per_second: 500, decode_tokens_per_second: 10, tpot_ms: 100,
    })]);
    const report = benchmarkReport([record]);
    for (const [key, value] of Object.entries({
      prefill_tokens_per_second: 500, decode_tokens_per_second: 10, tpot_ms: 100, reported_tokens_per_second: 11,
    })) {
      const index = report.columns.findIndex(column => column.key === `${key}.median`);
      expect(defined(report.rows[0])[index]).toBe(value);
    }
    expect(report.columns.some(column => column.key?.startsWith('reported_prompt_tokens'))).toBe(false);
    expect(report.columns.some(column => column.key?.startsWith('reported_completion_tokens'))).toBe(false);
  });

  it('preserves selected snapshot labels in report exports while dropping local paths and shard suffixes', () => {
    const saved = serving([trial()]);
    defined(saved.result.provenance).recorded_model_label = 'variants · 4bit/model-0001-of-0004.safetensors';
    const report = benchmarkReport([saved]);
    const labelIndex = report.columns.findIndex(column => column.key === 'recorded_model_label');
    expect(defined(report.rows[0])[labelIndex]).toBe('variants · 4bit/model.safetensors');
  });
});
