import { describe, expect, it } from 'vitest';
import { verificationOverrideKey } from './serverLifecycle';

/** The refusal text is the only place the key exists. */
describe('verification override key', () => {
  const key = 'a'.repeat(64);

  it('recovers the key a refused launch printed', () => {
    expect(verificationOverrideKey(
      `this runtime computed wrong results with the selected GPUs on this machine, so the server was not started. Select a different runtime build or GPU selection, or start it anyway with verification override key ${key}.`,
    )).toBe(key);
  });

  it('finds nothing in an ordinary failure, so no override is offered', () => {
    expect(verificationOverrideKey('Server start failed: the configured port is already in use.')).toBeNull();
    expect(verificationOverrideKey(null)).toBeNull();
    expect(verificationOverrideKey('')).toBeNull();
  });

  it('ignores anything that is not a key the gate could have printed', () => {
    expect(verificationOverrideKey('verification override key not-a-key')).toBeNull();
    expect(verificationOverrideKey(`verification override key ${'a'.repeat(63)}`)).toBeNull();
  });
});
