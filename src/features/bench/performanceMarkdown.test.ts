// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { PerformanceBenchmarkRow } from '../../shared/api/types';
import type { Locale } from '../../shared/i18n/i18n';
import { benchmarkCopy } from './benchmarkCopy';
import { performanceMarkdown } from './performanceMarkdown';
import { defined } from '../../testing/assertDefined';
import { servingBenchmark } from '../../testing/servingBenchmark';

function record(rows: PerformanceBenchmarkRow[] = []) {
  const saved = servingBenchmark();
  saved.model = 'D:/models/Recorded-model.gguf';
  saved.result.rows = rows;
  defined(saved.result.provenance).recorded_model_label = 'Recorded-model.gguf';
  return saved;
}
function row(overrides: Partial<PerformanceBenchmarkRow> = {}): PerformanceBenchmarkRow {
  return { ...defined(servingBenchmark().result.rows[0]), ...overrides };
}
const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());

// Copy output is a public seam: escaping and missing-value behavior must survive renderer changes.
describe('performance Markdown', () => {
  it.each<Locale>(['en', 'ko', 'ja', 'zh'])('preserves the serving method and unavailable token observations in %s', locale => {
    const markdown = performanceMarkdown(servingBenchmark(), locale);
    expect(markdown).toContain('openai-chat-serving@5');
    expect(markdown).toContain(benchmarkCopy(locale).unavailable);
    expect(markdown).not.toMatch(/PRIVATE|synthetic|private|diagnostic|NaN|Infinity/);
    const lines = markdown.split('\n').filter(line => line.startsWith('|')).map(cells);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toHaveLength(defined(lines[0]).length);
    if (locale === 'en') {
      const headers = defined(lines[0]);
      const values = defined(lines[2]);
      expect(values[headers.indexOf('Max output token request')]).toBe('128');
      expect(values[headers.indexOf('Observed output (B/s) · median')]).toBe('60');
      expect(values[headers.indexOf('Total token throughput (tok/s) · median')]).toBe('N/A');
    }
    expect(markdown).toContain('Per-point medians of client-observed timings; token metrics are engine-reported and empty when unreported.');
  });


  it('retains terminal status without copying potentially secret server log messages', () => {
    const failed = record();
    failed.result.status = 'failed';
    failed.result.message = 'PRIVATE-TOKEN /synthetic/private/model.gguf';
    const markdown = performanceMarkdown(failed, 'en');
    const lines = markdown.split('\n').filter(line => line.startsWith('|')).map(cells);
    const headers = defined(lines[0]);
    const values = defined(lines[2]);
    expect(values[headers.indexOf('Status')]).toBe('Failed');
    expect(values[headers.indexOf('Generation speed per request (tok/s) · median')]).toBe('N/A');
    expect(markdown).not.toMatch(/PRIVATE|synthetic/);
    failed.result.status = 'cancelled';
    expect(performanceMarkdown(failed, 'en')).toBe('');
    failed.result.rows = [row()];
    expect(performanceMarkdown(failed, 'en')).toContain('Cancelled');
  });

  it('makes model/runtime markup inert and preserves table boundaries without exposing local paths or diagnostics', () => {
    const saved = record([row(), row({ id: 'bad', concurrency: 2, failed: true, error: 'PRIVATE-LOG <script>bad()</script>' })]);
    saved.model = 'C:\\synthetic\\private\\Evil|Model<img src=x>.gguf';
    const provenance = defined(saved.result.provenance);
    provenance.recorded_model_label = 'Evil|Model<img src=x>.gguf';
    provenance.runtime.backend = 'ok | extra\n# Injected heading <script>bad()</script> ![x](javascript:bad()) `code` **bold** back\\slash';
    const markdown = performanceMarkdown(saved, 'en');
    expect(markdown).not.toMatch(/<img|<script|PRIVATE-LOG|synthetic|private|(?<!\\)\]\(|^# Injected/m);
    expect(markdown).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(markdown).toContain('\\`code\\` \\*\\*bold\\*\\* back\\\\slash');
    expect(markdown).toContain('Evil\\|Model&lt;img src=x&gt;.gguf');
    const lines = markdown.split('\n').filter(line => line.startsWith('|')).map(cells);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toHaveLength(defined(lines[0]).length);
  });

  it.each<Locale>(['en', 'ko', 'ja', 'zh'])('supports %s labels and missing values without interpolating absent fields', locale => {
    const copy = benchmarkCopy(locale);
    const markdown = performanceMarkdown(record([row({ decode_tokens_per_second: null, tpot_ms: null })]), locale);
    expect(markdown).toContain(`# ${copy.title} · Recorded-model.gguf`);
    expect(markdown).toContain(copy.unavailable);
    expect(markdown).toContain(copy.complete);
    expect(markdown).not.toMatch(/undefined|NaN|Infinity|\[object/);
  });
});
