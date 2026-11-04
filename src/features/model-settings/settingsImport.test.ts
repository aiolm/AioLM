// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { SERVER_OPTIONS, getOptionOccurrences } from '../../shared/config/serverOptions';
import { parseSettingsText, tokenizeCommand } from './settingsImport';

const base = { ...testConfig, server_args: [] as string[] };

/** The command a model card hands out, copied with PowerShell's continuations. */
const PASTED = [
  '  -n 49152 `',
  '  -c 131072 `',
  '  --threads 12 `',
  '  -b 8192 `',
  '  -ub 2048 `',
  '  -fa on `',
  '  --parallel 1 `',
  '  -ngl 999 `',
  '  --jinja `',
  '  --reasoning-format deepseek `',
  '  --temp 0.7 `',
  '  --top-k 20 `',
  '  --top-p 0.95 `',
  '  --min-p 0.0 `',
  '  --reasoning off `',
  '  --cache-type-k q8_0 `',
  '  --cache-type-v q8_0',
].join('\n');

describe('pasted settings', () => {
  it('reads a whole llama-server command into the controls it belongs to', () => {
    const result = parseSettingsText(PASTED, SERVER_OPTIONS, base);
    expect(result.rejected).toEqual([]);
    expect(result.patch).toMatchObject({
      ctx_size: 131072, threads: 12, batch_size: 8192, ubatch_size: 2048,
      parallel: 1, ngl: 999, flash_attn: 'on', reasoning: 'off',
      reasoning_format: 'deepseek', cache_type_k: 'q8_0', cache_type_v: 'q8_0',
      temperature: 0.7, top_k: 20, top_p: 0.95,
    });
    // Request-scoped values go to the chat options, not to server flags.
    expect(result.patch.chat_options).toMatchObject({ max_tokens: 49152, min_p: 0 });
    // A flag the app knows but does not manage is kept as an extra argument.
    const jinja = SERVER_OPTIONS.find(option => option.id === '--jinja')!;
    expect(getOptionOccurrences(result.patch.server_args ?? [], jinja)).toHaveLength(1);
  });

  it('imports benchmark launch settings without overwriting saved request values', () => {
    const result = parseSettingsText('--ctx-size 32768 --parallel 4 --cache-type-k q8_0 --temp 0.7 --min-p 0.1 -n 128', SERVER_OPTIONS, base, true);
    expect(result.patch).toEqual({ ctx_size: 32768, parallel: 4, cache_type_k: 'q8_0' });
    expect(result.applied.map(item => item.flag)).toEqual(['--ctx-size', '--parallel', '--cache-type-k']);
    expect(result.rejected).toEqual([
      { flag: '--temp', reason: 'request' }, { flag: '--min-p', reason: 'request' }, { flag: '-n', reason: 'request' },
    ]);
    expect(base.chat_options).toEqual(testConfig.chat_options);
  });

  it('names what it could not apply instead of dropping it', () => {
    // Silently ignoring part of a pasted command is how a model ends up running
    // with settings nobody chose.
    const result = parseSettingsText('--not-a-flag 3 --threads notanumber --ctx-size', SERVER_OPTIONS, base);
    expect(result.rejected).toEqual([
      { flag: '--not-a-flag', reason: 'unknown' },
      { flag: '--threads', reason: 'value', value: 'notanumber' },
      { flag: '--ctx-size', reason: 'missing' },
    ]);
    expect(result.patch).toEqual({});
  });

  it('rejects a value outside what the control accepts, and says what it accepts', () => {
    // Clamping would apply a setting the user did not ask for; the range is what
    // makes the report actionable.
    const result = parseSettingsText('--temp 9', SERVER_OPTIONS, base);
    expect(result.rejected).toEqual([{ flag: '--temp', reason: 'value', value: '9', range: { min: 0, max: 2 } }]);
    expect(result.patch).toEqual({});
  });
  it('imports context zero or at least 512 rather than accepting a value native save would replace', () => {
    const invalid = parseSettingsText('--ctx-size 256', SERVER_OPTIONS, base);
    expect(invalid.patch).toEqual({});
    expect(invalid.rejected).toEqual([{ flag: '--ctx-size', reason: 'value', value: '256', range: { min: 512, max: 131072, allowZero: true } }]);
    expect(parseSettingsText('--ctx-size 0', SERVER_OPTIONS, base).patch).toEqual({ ctx_size: 0 });
    expect(parseSettingsText('--ctx-size 512', SERVER_OPTIONS, base).patch).toEqual({ ctx_size: 512 });
  });

  it('rejects incompatible explicit batch edits while importing a valid pair in either order', () => {
    expect(parseSettingsText('--ubatch-size 4096', SERVER_OPTIONS, base).patch).toEqual({});
    expect(parseSettingsText('--batch-size 256', SERVER_OPTIONS, base).patch).toEqual({});
    for (const command of ['--batch-size 256 --ubatch-size 128', '--ubatch-size 128 --batch-size 256']) {
      const result = parseSettingsText(command, SERVER_OPTIONS, base);
      expect(result.rejected).toEqual([]);
      expect(result.patch).toEqual({ batch_size: 256, ubatch_size: 128 });
    }
  });

  it('uses runtime-help batch defaults and never constrains a new batch against an inherited microbatch', () => {
    const options = SERVER_OPTIONS.map(option => option.flags.includes('--batch-size')
      ? { ...option, description: 'logical maximum batch size (default: 4096)' } : option);
    const batchInherited = { ...base, batch_size: 128, ubatch_size: 512, runtime_defaults: ['batch_size'] };
    const microbatch = parseSettingsText('--ubatch-size 3072', options, batchInherited);
    expect(microbatch.rejected).toEqual([]);
    expect(microbatch.patch).toEqual({ ubatch_size: 3072 });
    const microbatchInherited = { ...base, ubatch_size: 512, runtime_defaults: ['ubatch_size'] };
    const batch = parseSettingsText('--batch-size 128', SERVER_OPTIONS, microbatchInherited);
    expect(batch.rejected).toEqual([]);
    expect(batch.patch).toEqual({ batch_size: 128 });
    expect(microbatchInherited).toMatchObject({ ubatch_size: 512, runtime_defaults: ['ubatch_size'] });
  });

  it('imports keep-all and disabled Top-k without changing their sentinel values', () => {
    const result = parseSettingsText('--keep -1 --top-k 0 --temp 1.5', SERVER_OPTIONS, base);
    expect(result.rejected).toEqual([]);
    expect(result.patch).toEqual({ keep: -1, top_k: 0, temperature: 1.5 });
  });

  it('rejects zero idle sleep while preserving its disabled and positive settings', () => {
    const zero = parseSettingsText('--sleep-idle-seconds 0', SERVER_OPTIONS, base);
    expect(zero.patch).toEqual({});
    expect(zero.rejected).toHaveLength(1);
    expect(parseSettingsText('--sleep-idle-seconds -1', SERVER_OPTIONS, base).patch).toEqual({ sleep_idle_seconds: -1 });
    expect(parseSettingsText('--sleep-idle-seconds 1', SERVER_OPTIONS, base).patch).toEqual({ sleep_idle_seconds: 1 });
  });

  it('replaces canonical request aliases when importing an explicit control value', () => {
    const result = parseSettingsText('--mirostat-lr 0.3 -n 256', SERVER_OPTIONS, {
      ...base, chat_options: { mirostat_eta: 0.7, max_completion_tokens: 512 },
    });
    expect(result.rejected).toEqual([]);
    expect(result.patch.chat_options).toEqual({ mirostat_lr: 0.3, max_tokens: 256 });
  });

  it('rejects zero repetition penalty without imposing an artificial positive minimum', () => {
    const zero = parseSettingsText('--repeat-penalty 0', SERVER_OPTIONS, base);
    expect(zero.patch).toEqual({});
    expect(zero.rejected).toEqual([{ flag: '--repeat-penalty', reason: 'value', value: '0', range: { min: 0, minExclusive: true, max: 2 } }]);
    const positive = parseSettingsText('--repeat-penalty 0.001', SERVER_OPTIONS, base);
    expect(positive.rejected).toEqual([]);
    expect(positive.patch.chat_options).toEqual({ repeat_penalty: 0.001 });
  });

  it('rejects fractional token counts instead of silently rounding or storing them', () => {
    const result = parseSettingsText('--keep 1.5 --top-k 2.5 --dry-allowed-length 1.5 -n 2.5', SERVER_OPTIONS, base);
    expect(result.patch).toEqual({});
    expect(result.rejected.map(entry => [entry.flag, entry.reason])).toEqual([
      ['--keep', 'value'], ['--top-k', 'value'], ['--dry-allowed-length', 'value'], ['-n', 'value'],
    ]);
  });

  it('keeps negative numeric arguments as values instead of treating them as flags', () => {
    const result = parseSettingsText('-n -1 --threads -1', SERVER_OPTIONS, base);
    expect(result.patch.chat_options).toEqual({ max_tokens: -1 });
    expect(result.rejected).toEqual([{ flag: '--threads', reason: 'value', value: '-1', range: { min: 0, max: 64 } }]);
  });

  it('keeps nonnumeric dash-prefixed tokens as option boundaries', () => {
    const boundaries = parseSettingsText('--threads -- --threads - --threads --unknown? --\u672a\u77e5', SERVER_OPTIONS, base);
    expect(boundaries.rejected).toEqual([
      { flag: '--threads', reason: 'missing' }, { flag: '--', reason: 'unknown' },
      { flag: '--threads', reason: 'missing' }, { flag: '-', reason: 'unknown' },
      { flag: '--threads', reason: 'missing' }, { flag: '--unknown?', reason: 'unknown' },
      { flag: '--未知', reason: 'unknown' },
    ]);

    const negatives = parseSettingsText('--threads -0.5 --threads -1e3 -n -1', SERVER_OPTIONS, base);
    expect(negatives.patch.chat_options).toEqual({ max_tokens: -1 });
    expect(negatives.rejected).toEqual([
      { flag: '--threads', reason: 'value', value: '-0.5', range: { min: 0, max: 64 } },
      { flag: '--threads', reason: 'value', value: '-1e3', range: { min: 0, max: 64 } },
    ]);
  });

  it('keeps every continuation style and quoted values intact', () => {
    expect(tokenizeCommand('-c 4096 `\n  -t 8')).toEqual(['-c', '4096', '-t', '8']);
    expect(tokenizeCommand('-c 4096 \\\n  -t 8')).toEqual(['-c', '4096', '-t', '8']);
    expect(tokenizeCommand('-c 4096 ^\n  -t 8')).toEqual(['-c', '4096', '-t', '8']);
    expect(tokenizeCommand('-m "C:/my models/a.gguf"')).toEqual(['-m', 'C:/my models/a.gguf']);
  });

  it('ignores the executable the command was copied with', () => {
    const result = parseSettingsText('llama-server.exe --threads 4', SERVER_OPTIONS, base);
    expect(result.patch).toEqual({ threads: 4 });
    expect(result.rejected).toEqual([]);
  });

  it('leaves the configuration alone when the text holds nothing to apply', () => {
    const result = parseSettingsText('   ', SERVER_OPTIONS, base);
    expect(result).toEqual({ patch: {}, applied: [], rejected: [] });
  });
});
