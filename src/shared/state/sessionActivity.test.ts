import { afterEach, describe, expect, it } from 'vitest';
import { anySessionActivity, sessionHasActivity, setSessionActivity } from './sessionActivity';

afterEach(() => {
  for (const id of ['default', 'work', 'other']) setSessionActivity(id, false);
});

describe('session response activity', () => {
  it('keeps simultaneous sessions independent and reports activity until all have finished', () => {
    setSessionActivity('default', true);
    setSessionActivity('work', true);
    expect(anySessionActivity()).toBe(true);
    setSessionActivity('default', false);
    expect(sessionHasActivity('default')).toBe(false);
    expect(sessionHasActivity('work')).toBe(true);
    expect(anySessionActivity()).toBe(true);
    setSessionActivity('work', false);
    expect(anySessionActivity()).toBe(false);
  });

  it('does not let finishing an unrelated session release the active session', () => {
    setSessionActivity('work', true);
    setSessionActivity('other', false);
    expect(sessionHasActivity('work')).toBe(true);
    expect(sessionHasActivity('other')).toBe(false);
    setSessionActivity('work', true);
    setSessionActivity('work', false);
    expect(anySessionActivity()).toBe(false);
  });
});
