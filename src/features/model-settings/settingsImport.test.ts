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
