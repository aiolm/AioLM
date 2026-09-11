import { describe, expect, it } from 'vitest';
import { helpDefault, serverDefault } from './optionDefaults';
import { describeServerOption, parseRuntimeHelp, SERVER_OPTIONS } from './serverOptions';
import { tuningOptionMetadata } from '../../features/tuning/tuningOptionInfo';
import { ADVANCED_SAMPLING_FIELDS, TUNING_FIELD_CATALOG } from '../../features/tuning/tuningFields';

describe('upstream default values and option identities', () => {
  it.each([
    ['sample (default: 0.05)', '0.05'],
    ['context (default: 0, 0 = loaded from model)', '0, 0 = loaded from model'],
    ['threads (default:\n same as --threads)\n(env: THREADS)', 'same as --threads'],
    ["attention ('on', 'off', or 'auto', default: 'auto')", "'auto'"],
    ['message (default: "done (thinking)")\nextra help', '"done (thinking)"'],
    ["template (default: template taken from model's metadata)", "template taken from model's metadata"],
    ['path (default: )\n(env: PATH)', '""'],
    ['mode\n- none: single GPU\n- layer (default): layers\n- row: rows', 'layer'],
    ['RoPE scaling, defaults to linear unless specified by the model\n(env: TYPE)', 'linear unless specified by the model'],
    ['use model default if unspecified', 'model'],
    ['clear the default breakers (env: VALUE)', null],
  ])('extracts %s without dropping meaning', (description, expected) => {
    expect(helpDefault(description)).toBe(expected);
  });
  it('uses custom runtime values, aliases and unknowns instead of stale editing seeds', () => {
    const options = parseRuntimeHelp('--min-p N                minimum (default: 0.12)\n--top-n-sigma N           sigma (default: -2)\n--threads N               runtime omits the default');
    expect(tuningOptionMetadata('min_p', options, true)).toMatchObject({ signature: '--min-p N', requestKey: 'min_p', verified: true, defaults: { value: '0.12' } });
    expect(tuningOptionMetadata('top_n_sigma', options, true).signature).toBe('--top-n-sigma N');
    expect(tuningOptionMetadata('threads', options, true).defaults.value).toBeNull();
    expect(tuningOptionMetadata('ctx_size', options, true)).toMatchObject({ verified: false, missing: true });
  });
  it('provides explicit request identities without inventing CLI flags', () => {
    for (const key of ['n_probs', 'min_keep', 't_max_predict_ms', 'id_slot']) {
      const info = tuningOptionMetadata(key, SERVER_OPTIONS, false);
      expect(info.requestKey).toBe(key);
      expect(info.signature).toBeUndefined();
      expect(info.defaults.source).toBe('reference');
      expect(info.defaults.value).toBe(['id_slot', 't_max_predict_ms'].includes(key) ? '-1' : '0');
    }
    expect(tuningOptionMetadata('mirostat_lr', SERVER_OPTIONS, false)).toMatchObject({ requestKey: 'mirostat_eta', signature: '--mirostat-lr N' });
    expect(tuningOptionMetadata('mirostat_ent', SERVER_OPTIONS, false).requestKey).toBe('mirostat_tau');
  });
  it('covers every dedicated tuning control including raw overrides', () => {
    for (const key of [...TUNING_FIELD_CATALOG.map(field => field.key), 'flash_attn', 'reasoning_effort', 'samplers']) {
      const info = tuningOptionMetadata(key, SERVER_OPTIONS, false);
      expect(info.signature || info.requestKey, key).toBeTruthy();
      expect(info.defaults.value, key).not.toBeNull();
    }
    for (const field of ADVANCED_SAMPLING_FIELDS) expect(tuningOptionMetadata(field.key, SERVER_OPTIONS, false).defaults.value, field.key).not.toBeNull();
    expect(tuningOptionMetadata('raw-server:--cache-ram', SERVER_OPTIONS, false).signature).toContain('--cache-ram');
    expect(tuningOptionMetadata('raw-chat:mirostat_eta', SERVER_OPTIONS, false).signature).toContain('--mirostat-lr');
  });
  it('explains the load mode behind deprecated memory switches and excludes commands', () => {
    const options = parseRuntimeHelp('--mmap, --no-mmap        DEPRECATED: use --load-mode\n--load-mode MODE         model loading (default: auto)');
    expect(serverDefault(options[0], options).value).toBe('--load-mode: auto');
    expect(serverDefault(describeServerOption('--help')!, []).source).toBe('command');
    expect(serverDefault(describeServerOption('--unknown N')!, []).source).toBe('unknown');
    expect(serverDefault(describeServerOption('--tensor-split N')!, [])).toMatchObject({ source: 'reference', value: '0,0,…' });
    expect(serverDefault(describeServerOption('--tensor-split N', 'split (default: auto)')!, [])).toMatchObject({ source: 'help', value: 'auto' });
  });
});
