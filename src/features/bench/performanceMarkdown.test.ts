// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LegacyPerformanceBenchmarkRow } from '../../shared/api/types';
import type { Locale } from '../../shared/i18n/i18n';
import { benchmarkCopy } from './benchmarkCopy';
import { performanceMarkdown } from './performanceMarkdown';
import type { LegacyPerformanceBenchmarkRecord } from './performanceRecords';

function record(rows: LegacyPerformanceBenchmarkRow[] = []): LegacyPerformanceBenchmarkRecord {
  return {
    schemaVersion: 1, id: 'old', createdAt: 0, model: 'D:/models/Recorded-model.gguf', backend: 'vulkan', build: 'b7',
    request: { run_id: 'old', prompt_lengths: [1024], generation_length: 128, batch_sizes: [2], repetitions: 2, context_profile: 'novel_en', warmup: true },
    result: { run_id: 'old', rows, status: 'complete', args: ['--api-key', 'PRIVATE-TOKEN'], runtime_version: '7', context_size: 4096, parallel: 2 },
  };
}
function row(overrides: Partial<LegacyPerformanceBenchmarkRow> = {}): LegacyPerformanceBenchmarkRow {
  return { id: 'old-row', prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0,
    ttft_ms: 100, tpot_ms: 10, pp_tps: 10240, tg_tps: 100, e2e_ms: 1370, total_tps: 93.4, peak_memory_bytes: null, timing_source: 'client', ...overrides };
}
const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());

// Copy output is a public seam: escaping and missing-value behavior must survive renderer changes.
describe('performance Markdown', () => {
  it('preserves historical repeat aggregation without relabeling token measurements as serving bytes', () => {
    const markdown = performanceMarkdown(record([
      row({ id: 's1', tg_tps: 80 }), row({ id: 's2', repetition: 2, tg_tps: 120 }),
      row({ id: 'b1', concurrency: 2, tg_tps: 170 }), row({ id: 'b2', concurrency: 2, repetition: 2, tg_tps: 190 }),
    ]), 'en');
    const [headers, , single, batch] = markdown.split('\n').filter(line => line.startsWith('|')).map(cells);
    expect(single[headers.indexOf('Legacy · token-based cold-prompt method · Output generation (Decode / TG) (tok/s)')]).toBe('100');
    expect(batch[headers.indexOf('Legacy · token-based cold-prompt method · Output generation (Decode / TG) (tok/s)')]).toBe('180');
    expect(batch[headers.indexOf('Legacy · token-based cold-prompt method · Speedup')]).toBe('1.8');
    expect(single[headers.indexOf('Input unit')]).toBe('tokens');
    expect(single[headers.indexOf('Input UTF8 bytes')]).toBe('N/A');
    expect(single[headers.indexOf('First output (ms) · median')]).toBe('N/A');
    expect(markdown).not.toMatch(/PRIVATE-TOKEN|--api-key|D:|models\//);
  });

  it('retains terminal status without copying potentially secret server log messages', () => {
    const failed = record();
    failed.result.status = 'failed';
    failed.result.message = 'PRIVATE-TOKEN /synthetic/private/model.gguf';
    const markdown = performanceMarkdown(failed, 'en');
    const [headers, , values] = markdown.split('\n').filter(line => line.startsWith('|')).map(cells);
    expect(values[headers.indexOf('Status')]).toBe('Failed');
    expect(values[headers.indexOf('Legacy · token-based cold-prompt method · Output generation (Decode / TG) (tok/s)')]).toBe('N/A');
    expect(markdown).not.toMatch(/PRIVATE|synthetic/);
    failed.result.status = 'cancelled';
    expect(performanceMarkdown(failed, 'en')).toBe('');
    failed.result.rows = [row()];
    expect(performanceMarkdown(failed, 'en')).toContain('Cancelled');
  });

  it('makes model/runtime markup inert and preserves table boundaries without exposing local paths or diagnostics', () => {
    const saved = record([row(), row({ id: 'bad', concurrency: 2, error: 'PRIVATE-LOG <script>bad()</script>' })]);
    saved.model = 'C:\\synthetic\\private\\Evil|Model<img src=x>.gguf';
    saved.backend = 'ok | extra\n# Injected heading <script>bad()</script> ![x](javascript:bad()) `code` **bold** back\\slash';
    const markdown = performanceMarkdown(saved, 'en');
    expect(markdown).not.toMatch(/<img|<script|PRIVATE-LOG|synthetic|private|(?<!\\)\]\(|^# Injected/m);
    expect(markdown).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(markdown).toContain('\\`code\\` \\*\\*bold\\*\\* back\\\\slash');
    expect(markdown).toContain('Evil\\|Model&lt;img src=x&gt;.gguf');
    const lines = markdown.split('\n').filter(line => line.startsWith('|')).map(cells);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toHaveLength(lines[0].length);
  });

  it.each<Locale>(['en', 'ko', 'ja', 'zh'])('supports %s labels and missing values without interpolating absent fields', locale => {
    const copy = benchmarkCopy(locale);
    const markdown = performanceMarkdown(record([row({ tg_tps: null, tpot_ms: null })]), locale);
    expect(markdown).toContain(`# ${copy.title} · Recorded-model.gguf`);
    expect(markdown).toContain(copy.unavailable);
    expect(markdown).toContain(copy.complete);
    expect(markdown).not.toMatch(/undefined|NaN|Infinity|\[object/);
  });
});
