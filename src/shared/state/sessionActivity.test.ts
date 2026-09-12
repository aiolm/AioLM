import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { anySessionActivity, sessionHasActivity, setSessionActivity, useSessionActivity } from './sessionActivity';

afterEach(() => {
  cleanup();
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

  it('updates the selected session subscription when activity or the selection changes', () => {
    const { result, rerender } = renderHook(({ id }) => useSessionActivity(id), { initialProps: { id: 'default' } });
    expect(result.current).toBe(false);
    act(() => setSessionActivity('work', true));
    expect(result.current).toBe(false);
    rerender({ id: 'work' });
    expect(result.current).toBe(true);
    act(() => setSessionActivity('work', false));
    expect(result.current).toBe(false);
    act(() => setSessionActivity('default', true));
    rerender({ id: 'default' });
    expect(result.current).toBe(true);
  });
});
