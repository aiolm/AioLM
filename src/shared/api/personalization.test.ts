// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcError } from './ipcError.ts';
vi.mock('./transport.ts', () => ({
  isNativeRuntimeAvailable: vi.fn(() => true),
  invoke: vi.fn(),
}));

import { invoke, isNativeRuntimeAvailable } from './transport.ts';
import {
  getChatPersonalization,
  isAgentsFileConflict,
} from './personalization.ts';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true);
});

describe('personalization commands', () => {
  it('gives the browser preview an empty context without calling the native runtime', async () => {
    vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
    await expect(getChatPersonalization()).resolves.toEqual({ instructions: [], skills: [], warnings: [] });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('save conflicts', () => {
  it('recognizes a native stale-revision refusal independently of its wording', () => {
    expect(isAgentsFileConflict(new IpcError('busy', 'The file revision changed.'))).toBe(true);
    expect(isAgentsFileConflict(new IpcError('internal', 'Save conflict: could not save'))).toBe(false);
    expect(isAgentsFileConflict(new Error('Save conflict: could not save'))).toBe(false);
    expect(isAgentsFileConflict(undefined)).toBe(false);
  });
});
