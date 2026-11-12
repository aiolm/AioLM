import { describe, expect, it } from 'vitest';
import { IpcError, isIpcErrorKind, toIpcError } from './ipcError';

describe('toIpcError', () => {
  it('turns a typed native rejection into an IpcError that formats like the old string rejection', () => {
    const error = toIpcError({ kind: 'cancelled', message: 'server start cancelled' });
    expect(error).toBeInstanceOf(IpcError);
    expect(isIpcErrorKind(error, 'cancelled')).toBe(true);
    expect(String(error)).toBe('server start cancelled');
    expect((error as IpcError).message).toBe('server start cancelled');
  });

  it('passes through strings, errors and objects that are not typed rejections', () => {
    const plain = new Error('boom');
    expect(toIpcError('legacy text')).toBe('legacy text');
    expect(toIpcError(plain)).toBe(plain);
    const sharing = { code: 'verification_required', message: 'Verify first' };
    expect(toIpcError(sharing)).toBe(sharing);
    const unknownKind = { kind: 'exploded', message: 'x' };
    expect(toIpcError(unknownKind)).toBe(unknownKind);
    expect(toIpcError({ kind: 'toString', message: 'x' })).not.toBeInstanceOf(IpcError);
  });
});
