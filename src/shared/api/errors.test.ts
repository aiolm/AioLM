import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors';
import { IpcError } from './ipcError';

describe('IPC error messages', () => {
  it.each([
    [new Error('Synthetic JavaScript failure'), 'Synthetic JavaScript failure'],
    [new IpcError('denied', 'Synthetic native refusal'), 'Synthetic native refusal'],
    [{ kind: 'busy', message: 'Synthetic native busy failure' }, 'Synthetic native busy failure'],
    ['Synthetic native failure', 'Synthetic native failure'],
    [{ code: 'synthetic_failure', message: 'Synthetic structured failure' }, 'Synthetic structured failure'],
    [{ error: 'Synthetic legacy failure' }, 'Synthetic legacy failure'],
    [{ code: 'synthetic_failure' }, '{"code":"synthetic_failure"}'],
  ])('preserves readable rejection text for %j', (cause, expected) => {
    expect(errorMessage(cause)).toBe(expected);
  });

  it('provides readable fallback text for cyclic native rejections', () => {
    const cause: { nested?: object } = {};
    cause.nested = cause;
    expect(errorMessage(cause)).toBe('An unexpected error occurred.');
  });
});
