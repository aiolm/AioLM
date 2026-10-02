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
  readAgentsFile,
  readSkill,
  saveAgentsFile,
} from './personalization.ts';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true);
});

describe('personalization commands', () => {
  it('sends the native command names and camelCase arguments', async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await getChatPersonalization();
    expect(invoke).toHaveBeenLastCalledWith('chat_personalization');
    await readSkill('aiolm:review');
    expect(invoke).toHaveBeenLastCalledWith('personalization_read_skill', { id: 'aiolm:review' });
    await readAgentsFile('agents');
    expect(invoke).toHaveBeenLastCalledWith('personalization_read_agents', { source: 'agents' });
    await saveAgentsFile('aiolm', 'Be brief.', null);
    expect(invoke).toHaveBeenLastCalledWith('personalization_save_agents', {
      source: 'aiolm',
      content: 'Be brief.',
      expectedRevision: null,
    });
  });

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
