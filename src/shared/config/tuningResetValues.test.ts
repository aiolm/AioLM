import { describe, expect, it } from 'vitest';
import { parseRuntimeHelp, SERVER_OPTIONS } from './serverOptions';
import { tuningOptionMetadata } from '../../features/tuning/tuningOptionInfo';
import { defaultScalar, tuningResetValues } from './tuningResetValues';
import { ADVANCED_SAMPLING_FIELDS } from '../../features/tuning/tuningFields';
import { tuningDisplayConfig } from '../../features/tuning/tuningResetState';
import { testConfig } from '../../testing/appStore';

describe('default display and reset agreement', () => {
  it('matches every numeric dedicated default and advanced sampler to the reference catalog', () => {
    const values = tuningResetValues();
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'number') expect(value, key).toBe(defaultScalar(tuningOptionMetadata(key, SERVER_OPTIONS, false).defaults.value));
    }
    const display = tuningDisplayConfig({ ...testConfig, chat_options: {}, server_args: [] }, SERVER_OPTIONS);
    for (const field of ADVANCED_SAMPLING_FIELDS) {
      expect(display.chat_options[field.key], field.key).toBe(defaultScalar(tuningOptionMetadata(field.key, SERVER_OPTIONS, false).defaults.value));
    }
  });
  it('uses the same explicit app context default regardless of a runtime model-dependent default', () => {
    const options = parseRuntimeHelp('--ctx-size N          context (default: 0, 0 = loaded from model)');
    expect(tuningResetValues(options).ctx_size).toBe(4096);
    expect(tuningOptionMetadata('ctx_size', options, true).defaults).toEqual({ value: '4096', source: 'app' });
  });
  it.each([
    ['enabled', 'on'], ['disabled', 'off'], ['template default', 'auto'],
  ])('preserves the runtime reasoning default %s when opening the editor', (runtimeDefault, expected) => {
    const options = parseRuntimeHelp(`--reasoning-preserve, --no-reasoning-preserve         preserve (default: ${runtimeDefault})`);
    expect(tuningResetValues(options).reasoning_preserve).toBe(expected);
    const display = tuningDisplayConfig({ ...testConfig, reasoning_preserve: 'off', runtime_defaults: ['reasoning_preserve'] }, options);
    expect(display.reasoning_preserve).toBe(expected);
  });
  it('retains numeric draft GPU defaults rather than replacing them with auto', () => {
    const options = parseRuntimeHelp('--spec-draft-ngl N           layers (default: 32)');
    expect(tuningResetValues(options).spec_draft_ngl).toBe('32');
    expect(tuningOptionMetadata('spec_draft_ngl', options, true).defaults.value).toBe('32');
  });
});
