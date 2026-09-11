import { describe, expect, it } from 'vitest';
import { describeServerOption, getOptionOccurrences, managedServerOption, parseRuntimeHelp, replaceServerOption, runtimeServerOptions, SERVER_OPTIONS, serverOptionMatches } from './serverOptions';

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
    expect(parseRuntimeHelp('--spec-draft-threads N                draft threads (default:\n                                        --threads)\n--threads N                            threads').map(item => item.id)).toEqual(['--spec-draft-threads', '--threads']);
    expect(runtimeServerOptions(help)).toEqual(parsed);
    expect(runtimeServerOptions('unavailable')).toBe(SERVER_OPTIONS);
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
