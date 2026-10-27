import { describe, expect, it } from 'vitest';
import type { PerformanceBenchmarkRow } from '../../shared/api/types.ts';
import type { Locale } from '../../shared/i18n/i18n';
import { benchmarkCopy } from './benchmarkCopy.ts';
import { performanceMarkdown } from './performanceMarkdown.ts';
import type { PerformanceBenchmarkRecord } from './performanceRecords.ts';

function row(overrides: Partial<PerformanceBenchmarkRow> = {}): PerformanceBenchmarkRow {
  return {
    id: 'single-1', prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1,
    completion_tokens: 128, cached_tokens: 0, ttft_ms: 100, tpot_ms: 10,
    pp_tps: 10240, tg_tps: 100, e2e_ms: 1370, total_tps: 93.4, peak_memory_bytes: null, timing_source: 'client', ...overrides,
  };
}

type Overrides = Omit<Partial<PerformanceBenchmarkRecord>, 'result'> & { result?: Partial<PerformanceBenchmarkRecord['result']> };

function record(rows: PerformanceBenchmarkRow[], { result, ...overrides }: Overrides = {}, request: Partial<PerformanceBenchmarkRecord['request']> = {}): PerformanceBenchmarkRecord {
  return {
    schemaVersion: 1, id: 'perf-1', createdAt: Date.UTC(2026, 8, 12),
    model: 'D:/models/Qwen3-8B-Q4_K_M.gguf', backend: 'vulkan', build: 'b10840',
    request: { run_id: 'perf-1', prompt_lengths: [1024], generation_length: 128, batch_sizes: [2], repetitions: 1, context_profile: 'novel_en', warmup: true, ...request },
    result: { run_id: 'perf-1', rows, status: 'complete', args: ['--ctx-size', '2304', '--api-key', 'SECRET-TOKEN'], runtime_version: '10840', context_size: 2304, parallel: 2, ...result },
    ...overrides,
  };
}

const dataLines = (markdown: string) => markdown.split('\n').filter((line) => line.startsWith('|'));
/** Cell boundaries are the pipes that are not escaped. */
const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());

describe('performance Markdown', () => {
  it('names the measured Metal plugin and core versions independently of legacy llama.cpp builds', () => {
    const markdown = performanceMarkdown(record([row()], { backend: 'metal', result: {
      provider: 'vllm', runtime_version: '0.30.0', runtime_variant: 'vllm-metal', runtime_plugin_version: '0.30.0',
    } }), 'en');
    expect(markdown).toContain('vllm-metal 0.30.0 · vLLM 0.30.0');
    expect(markdown).not.toContain('10840');
  });
  it('summarizes a single and a concurrent request under the model file name', () => {
    const markdown = performanceMarkdown(record([
      row({ peak_memory_bytes: 3 * 1024 ** 3 }),
      row({ id: 'batch-1', concurrency: 2, ttft_ms: 180, tpot_ms: 11.5, pp_tps: 9000, tg_tps: 180, e2e_ms: 2500, total_tps: 102.4 }),
    ]), 'en');

    expect(markdown).toBe([
      '# Benchmark · Qwen3-8B-Q4_K_M.gguf',
      '',
      'Completed · vulkan · b10840',
      '',
      '- Prompt content: Prose · English',
      '- Input tokens: 1,024',
      '- Output tokens: 128',
      '- Concurrent requests: 1× / 2×',
      '- Repetitions: 1',
      '- Warm up before measuring: Enabled',
      '- Total trials: 2 / 2',
      '- Server context tokens: 2,304',
      '- Server request slots: 2',
      '',
      '## Single requests',
      '',
      '| Input / output tokens | Samples | TTFT (ms) | TPOT (ms) | Input processing (Prefill / PP) · estimated (tok/s) | Output generation (Decode / TG) (tok/s) | Total time (s) | Total throughput (tok/s) | Peak process RAM |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| 1,024 / 128 | 1 | 100.0 | 10.00 | 10240.0 | 100.0 | 1.37 | 93.4 | 3.00 GiB |',
      '',
      '## Concurrent requests',
      '',
      '| Input / output tokens | Concurrent requests | Samples | TTFT (ms) | TPOT (ms) | Input processing (Prefill / PP) · estimated (tok/s) | Output generation (Decode / TG) (tok/s) | Speedup | Total time (s) | Total throughput (tok/s) | Peak process RAM |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| 1,024 / 128 | 2× | 1 | 180.0 | 11.50 | 9000.0 | 180.0 | 1.80× | 2.50 | 102.4 | N/A |',
      '',
      'Rates use client-observed timings. Repeated tests show means and Output generation (Decode / TG) speed standard deviation.',
      '',
    ].join('\n'));
    // The model directory, launch arguments and their values stay out of the copy.
    expect(markdown).not.toMatch(/D:|models\/|--api-key|SECRET-TOKEN|ctx-size/);
  });

  it('shows repeat means, generation deviation, the peak RAM and the speedup of the aggregated rows', () => {
    const markdown = performanceMarkdown(record([
      row({ id: 's1', repetition: 1, ttft_ms: 90, tpot_ms: 9, pp_tps: 10000, tg_tps: 80, e2e_ms: 1000, total_tps: 90, peak_memory_bytes: 1024 ** 2 }),
      row({ id: 's2', repetition: 2, ttft_ms: 110, tpot_ms: 11, pp_tps: 12000, tg_tps: 120, e2e_ms: 1400, total_tps: 110, peak_memory_bytes: 2 * 1024 ** 2 }),
      // The same trial reported twice must not become a third sample.
      row({ id: 's2', repetition: 2, tg_tps: 120 }),
      row({ id: 'b1', concurrency: 2, repetition: 1, tg_tps: 170 }),
      row({ id: 'b2', concurrency: 2, repetition: 2, tg_tps: 190 }),
    ], {}, { repetitions: 2 }), 'en');

    const [single, batch] = dataLines(markdown).filter((line) => /^\| 1,024/.test(line)).map(cells);
    expect(single).toEqual(['1,024 / 128', '2', '100.0', '10.00', '11000.0', '100.0 ± 28.3', '1.20', '100.0', '2.0 MiB']);
    // 180 tok/s against the 100 tok/s single-request mean.
    expect(batch.slice(0, 3)).toEqual(['1,024 / 128', '2×', '2']);
    expect(batch[6]).toBe('180.0 ± 14.1');
    expect(batch[7]).toBe('1.80×');
    expect(markdown).toContain('- Total trials: 4 / 4');
    expect(markdown).toContain('- Repetitions: 2');
  });

  it('keeps missing measurements and failed trials unavailable instead of zero', () => {
    const markdown = performanceMarkdown(record([
      row({ id: 'ok-1' }),
      // One unmeasured sample makes the aggregate unmeasured; it is not averaged as zero.
      row({ id: 'ok-2', repetition: 2, tg_tps: null, tpot_ms: null }),
      row({ id: 'bad', concurrency: 2, error: 'connection closed', ttft_ms: null, tpot_ms: null, pp_tps: null, tg_tps: null, total_tps: null, e2e_ms: 0 }),
    ], {}, { repetitions: 2 }), 'en');

    const [single, failed] = dataLines(markdown).filter((line) => /^\| 1,024/.test(line)).map(cells);
    expect(single).toEqual(['1,024 / 128', '2', '100.0', 'N/A', '10240.0', 'N/A', '1.37', '93.4', 'N/A']);
    expect(failed).toEqual(['1,024 / 128 · Failed: connection closed', '2×', '0', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A']);
    expect(markdown).toContain('- Total trials: 2 / 4');
    expect(markdown).not.toMatch(/\b0\.0\b|0\.00/);
  });

  it('describes failed, cancelled and empty runs without inventing a table', () => {
    const failed = record([], { result: { status: 'failed', message: 'server exited with code 1', runtime_version: '', context_size: 0, parallel: 0, args: [] } });
    const markdown = performanceMarkdown(failed, 'en');
    expect(markdown).toContain('Failed · vulkan · b10840');
    expect(markdown).toContain('Message: server exited with code 1');
    expect(markdown).toContain('- Total trials: 0 / 2');
    expect(markdown).toContain('No measurements were recorded.');
    expect(markdown).not.toMatch(/Server context tokens|Server request slots|^\|/m);

    const cancelled = performanceMarkdown(record([row()], { result: { status: 'cancelled' } }), 'en');
    expect(cancelled).toContain('Cancelled · vulkan · b10840');
    expect(cancelled).toContain('- Total trials: 1 / 2');
    expect(cancelled).toContain('## Single requests');
    expect(cancelled).not.toContain('## Concurrent requests');
    expect(cancelled).not.toContain('No measurements were recorded.');
  });

  it('cannot be broken out of its table or lines by model, backend, error or message text', () => {
    const hostile = 'ok | extra\nline two\r\n# Injected heading\n| fake | row |\n- item <script>alert(1)</script> ![x](javascript:alert(1)) `code` **bold** back\\slash';
    const markdown = performanceMarkdown(record([
      row(),
      row({ id: 'bad', concurrency: 2, error: hostile, tg_tps: null }),
    ], {
      model: 'C:\\Users\\alice\\My Models\\Evil|Model<img src=x onerror=alert(1)>.gguf',
      backend: 'vulkan|<b>',
    }), 'en');
    const withMessage = performanceMarkdown(record([row()], { result: { status: 'partial', message: hostile } }), 'en');

    for (const text of [markdown, withMessage]) {
      // No raw markup or block start survives from the untrusted text.
      expect(text).not.toMatch(/<script|<img|<b>|<\/script>/);
      // A link needs an unescaped `](`; the escaped one below is inert text.
      expect(text).not.toMatch(/(?<!\\)\]\(/);
      expect(text).not.toMatch(/^# Injected|^\| fake|^- item/m);
      expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(text).toContain('\\`code\\` \\*\\*bold\\*\\* back\\\\slash');
    }
    // Every row of both tables keeps the header's column count.
    const lines = dataLines(markdown);
    expect(lines.length).toBeGreaterThan(4);
    const singleColumns = cells(lines[0]).length;
    const batchColumns = cells(lines[3]).length;
    expect(lines.slice(0, 3).map((line) => cells(line).length)).toEqual([singleColumns, singleColumns, singleColumns]);
    expect(lines.slice(3).map((line) => cells(line).length)).toEqual([batchColumns, batchColumns, batchColumns]);
    // The escaped model name is a single heading line.
    expect(markdown.split('\n')[0]).toBe('# Benchmark · Evil\\|Model&lt;img src=x onerror=alert(1)&gt;.gguf');
    expect(markdown.split('\n')[2]).toBe('Completed · vulkan\\|&lt;b&gt; · b10840');
  });

  it('reduces local paths in error text to file names and bounds its length', () => {
    const error = 'failed to load C:\\Users\\alice\\My Models\\secret\\m.gguf: bad magic; also \\\\NAS\\share\\team\\n.bin and /home/alice/models/o.gguf via https://example.com/v1/chat';
    const markdown = performanceMarkdown(record([row({ id: 'bad', error, tg_tps: null })]), 'en');
    expect(markdown).toContain('Failed: failed to load m.gguf: bad magic; also n.bin and o.gguf via https://example.com/v1/chat');
    expect(markdown).not.toMatch(/alice|NAS|My Models|secret/);

    const long = performanceMarkdown(record([row({ id: 'bad', error: `boom ${'x'.repeat(5000)}`, tg_tps: null })]), 'en');
    const cell = dataLines(long).map(cells).find((columns) => columns[0].includes('Failed'))![0];
    expect(cell.endsWith('…')).toBe(true);
    expect(cell.length).toBeLessThan(260);
  });

  it('writes Korean labels, units and missing values', () => {
    const markdown = performanceMarkdown(record([
      row({ id: 's1', repetition: 1, tg_tps: 80 }),
      row({ id: 's2', repetition: 2, tg_tps: 120 }),
      row({ id: 'b1', concurrency: 2, tg_tps: 180, peak_memory_bytes: null }),
    ], { result: { status: 'partial', message: '일부 요청이 실패했습니다.' } }, { context_profile: 'novel_ko', repetitions: 2, warmup: false }), 'ko');

    expect(markdown).toContain('# 벤치마크 · Qwen3-8B-Q4_K_M.gguf');
    expect(markdown).toContain('부분 결과 · vulkan · b10840');
    expect(markdown).toContain('메시지: 일부 요청이 실패했습니다.');
    expect(markdown).toContain('- 입력 내용: 산문 · 한국어');
    expect(markdown).toContain('- 측정 전 워밍업: 사용 안 함');
    expect(markdown).toContain('- 전체 측정 횟수: 3 / 4');
    expect(markdown).toContain('## 단일 요청');
    expect(markdown).toContain('## 동시 요청');
    expect(markdown).toContain('| 입력 / 출력 토큰 | 표본 수 | TTFT (ms) | TPOT (ms) | 입력 처리 (Prefill / PP) · 추정 (tok/s) | 출력 생성 (Decode / TG) (tok/s) | 전체 시간 (s) | 전체 처리량 (tok/s) | 최대 프로세스 RAM |');
    expect(markdown).toContain('100.0 ± 28.3');
    expect(markdown).toContain('측정 불가');
    expect(markdown).toContain('속도는 클라이언트에서 관측한 시간으로 계산합니다.');
    expect(markdown).not.toContain('undefined');
  });

  it.each<Locale>(['en', 'ko', 'ja', 'zh'])('uses the %s benchmark strings for every heading and note', (locale) => {
    const copy = benchmarkCopy(locale);
    const markdown = performanceMarkdown(record([row(), row({ id: 'b', concurrency: 2 })]), locale);
    for (const text of [copy.title, copy.single, copy.batch, copy.complete, copy.corpus, copy.promptLengths, copy.totalTests, copy.metricsHint]) expect(markdown).toContain(text);
    expect(markdown).not.toMatch(/undefined|\[object/);
    expect(performanceMarkdown(record([]), locale)).not.toContain('undefined');
  });
});
