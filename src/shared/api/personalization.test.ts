// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  it('recognizes the native stale-revision refusal however it is rejected', () => {
    const message = 'Save conflict: /tmp/AGENTS.md changed after it was opened.';
    expect(isAgentsFileConflict(message)).toBe(true);
    expect(isAgentsFileConflict(new Error(message))).toBe(true);
    expect(isAgentsFileConflict('/tmp/AGENTS.md could not be saved: denied')).toBe(false);
    expect(isAgentsFileConflict(undefined)).toBe(false);
  });
});
