import { describe, expect, it } from 'vitest';
import { describeServerOption, getOptionOccurrences, managedServerOption, parseRuntimeHelp, replaceServerOption, runtimeServerOptions, SERVER_OPTIONS, serverArgsFromText, serverArgsToText, serverOptionChoices, serverOptionMatches } from './serverOptions';

const option = (signature: string) => describeServerOption(signature)!;
describe('runtime server option catalog', () => {
  it('covers the full official catalog and legacy memory controls', () => {
    expect(SERVER_OPTIONS.length).toBeGreaterThanOrEqual(255);
    expect(new Set(SERVER_OPTIONS.map(item => item.id)).size).toBe(SERVER_OPTIONS.length);
    for (const flag of ['--mmap', '--mlock', '--load-mode', '--threads-batch', '--rope-scaling', '--yarn-orig-ctx', '--cache-ram', '--numa', '--grammar', '--metrics', '--spec-draft-threads']) {
      expect(SERVER_OPTIONS.some(item => item.flags.includes(flag)), flag).toBe(true);
    }
    expect(serverOptionMatches(option('--mmap, --no-mmap'), 'm map')).toBe(true);
  });
  it('reads signatures, aliases, switches, arguments and continuation text without inventing prose flags', () => {
    const help = '----- common params -----\n-t,    --threads N                      worker count\n                                       defaults to --threads-batch\n--mmap, --no-mmap                       map weights\n--custom-pr-option START END             custom build option\n--flash-attn [on|off|auto]               attention';
    const parsed = parseRuntimeHelp(help);
    expect(parsed.map(item => item.id)).toEqual(['--threads', '--mmap', '--custom-pr-option', '--flash-attn']);
    expect(parsed[0].description).toContain('defaults to --threads-batch');
    expect(parsed[1].arity).toBe(0);
    expect(parsed[2].arity).toBe(2);
    expect(parsed[3].choices).toEqual(['on', 'off', 'auto']);
    // The argument form is what an editor prompts for; the flag is never part of it.
    expect(parsed.map(item => item.argument)).toEqual(['N', '', 'START END', '[on|off|auto]']);
    expect(parseRuntimeHelp('--spec-draft-threads N                draft threads (default:\n                                        --threads)\n--threads N                            threads').map(item => item.id)).toEqual(['--spec-draft-threads', '--threads']);
    expect(runtimeServerOptions(help)).toEqual(parsed);
    expect(runtimeServerOptions('unavailable')).toBe(SERVER_OPTIONS);
  });
  it('recovers values an option lists as prose instead of putting them in its signature', () => {
    // Verbatim shapes from llama-server --help: a bare MODE placeholder whose
    // real values only appear as bullets underneath it.
    const described = (signature: string, description: string) => describeServerOption(signature, description)!;
    const lazy = described('-lzm, --lazy-mode MODE', 'on-demand reading of certain tensors\n(default: auto)\n- on: read the rows of such tensors from disk on demand\n- auto: on, but only for tensors larger than 4 GiB\n- off: always keep them resident');
    expect(lazy.choices).toEqual([]);
    expect(serverOptionChoices(lazy)).toEqual(['on', 'auto', 'off']);

    const load = described('-lm, --load-mode MODE', 'model loading mode (default: auto)\n- auto: mmap, unless a device does not support it\n- none: no special loading mode\n- mmap+mlock: mmap plus mlock\n- dio: use DirectIO if available');
    expect(serverOptionChoices(load)).toEqual(['auto', 'none', 'mmap+mlock', 'dio']);

    // A "(default)" annotation before the colon must not hide a value.
    const numa = described('--numa TYPE', 'NUMA optimizations\n- distribute (default): spread execution over all nodes\n- isolate: one node only');
    expect(serverOptionChoices(numa)).toEqual(['distribute', 'isolate']);

    // A signature that does enumerate its values stays authoritative.
    expect(serverOptionChoices(option('--flash-attn [on|off|auto]'))).toEqual(['on', 'off', 'auto']);
    const split = described('-sm, --split-mode {none,layer,row}', 'how to split\n- none: one GPU only\n- layer (default): split layers');
    expect(serverOptionChoices(split)).toEqual(['none', 'layer', 'row']);

    // Ordinary prose and multi-value options offer nothing to pick from.
    expect(serverOptionChoices(described('--cache-ram N', 'cache memory, -1 for all'))).toEqual([]);
    expect(serverOptionChoices(described('--control-vector-layer-range START END', '- start: first\n- end: last'))).toEqual([]);
  });
  it('round-trips one option per line, keeping spaces inside a value', () => {
    const options = [
      option('-lm, --load-mode MODE'), option('--jinja'), option('--log-file FNAME'),
      option('--cache-ram N'), option('--control-vector-layer-range START END'),
    ];
    const text = ['--load-mode none', '--jinja', String.raw`--log-file C:\My Logs\a.log`, '--cache-ram -1', '--control-vector-layer-range 2 8'].join('\n');
    const args = ['--load-mode', 'none', '--jinja', String.raw`C:\My Logs\a.log`, '-1', '2', '8'];
    // The flag ends at the first space; the rest is one value unless arity says otherwise.
    expect(serverArgsFromText(text, options)).toEqual([
      '--load-mode', 'none', '--jinja', '--log-file', args[3], '--cache-ram', '-1', '--control-vector-layer-range', '2', '8',
    ]);
    expect(serverArgsToText(serverArgsFromText(text, options), options)).toBe(text);
  });
  it('rejects a value on a switch and a missing value, and keeps unlisted build flags usable', () => {
    const options = [option('--jinja'), option('-lm, --load-mode MODE'), option('--control-vector-layer-range START END')];
    expect(() => serverArgsFromText('--jinja on', options)).toThrow('does not take a value');
    expect(() => serverArgsFromText('--control-vector-layer-range 2', options)).toThrow('needs 2 value(s)');
    expect(() => serverArgsFromText('--model C:/a.gguf', options)).toThrow('app-managed');
    // A flag the runtime help never listed still takes the rest of its line.
    expect(serverArgsFromText('--future-pr-option 7\n--future-pr-switch', options)).toEqual(['--future-pr-option', '7', '--future-pr-switch']);
    expect(serverArgsToText(['--future-pr-option', '7', '--future-pr-switch'], options)).toBe('--future-pr-option 7\n--future-pr-switch');
  });
  it('replaces both sides of a toggle and restores inheritance without affecting adjacent args', () => {
    const mmap = option('--mmap, --no-mmap');
    const args = ['--mmap', '--cache-ram', '-1', '--no-mmap', '--jinja'];
    expect(replaceServerOption(args, mmap, [{ flag: '--mmap', values: [] }])).toEqual(['--mmap', '--cache-ram', '-1', '--jinja']);
    expect(replaceServerOption(args, mmap, [])).toEqual(['--cache-ram', '-1', '--jinja']);
  });
  it('preserves paths with spaces, negative values, equals syntax and repeated multi-argument options', () => {
    const control = option('--control-vector-layer-range START END');
    expect(replaceServerOption(['--cache-ram=-1', '--jinja'], control, [{ flag: control.id, values: ['2', '8'] }])).toEqual(['--cache-ram=-1', '--jinja', control.id, '2', '8']);
    const vector = option('--control-vector FNAME');
    const items = [{ flag: vector.id, values: ['C:\\My Models\\a.gguf'] }, { flag: vector.id, values: ['C:\\My Models\\b.gguf'] }];
    const args = replaceServerOption(['--cache-ram', '-1'], vector, items);
    expect(getOptionOccurrences(args, vector)).toEqual(items);
    expect(replaceServerOption(args, vector, [])).toEqual(['--cache-ram', '-1']);
    expect(getOptionOccurrences(['--cache-ram=-1'], option('--cache-ram N'))).toEqual([{ flag: '--cache-ram', values: ['-1'] }]);
  });
  it('does not consume another option when removing an incomplete raw value', () => {
    expect(replaceServerOption(['--cache-ram', '--jinja'], option('--cache-ram N'), [])).toEqual(['--jinja']);
  });
  it('rejects invalid argv and routes managed aliases to their dedicated control', () => {
    expect(managedServerOption(option('-dev, --device DEVICE'))).toBe('--device');
    expect(() => replaceServerOption([], option('--host HOST'), [{ flag: '--host', values: ['0.0.0.0'] }])).toThrow('app-managed');
    for (const value of ['', 'a\nb', 'a\0b']) expect(() => replaceServerOption([], option('--cache-ram N'), [{ flag: '--cache-ram', values: [value] }])).toThrow();
  });
});
