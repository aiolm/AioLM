import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestStore } from '../../testing/appStore';
import { useExecutionStore } from './useExecutionStore';
import { restoreExecution } from './modelExecutionState';

describe('execution store', () => {
  beforeEach(() => localStorage.clear());
  it('keeps unrelated controls available during saves while start waits for persistence', async () => {
    const base = createTestStore();
    const save = base.updateConfig;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    base.updateConfig = vi.fn(async patch => { await gate; return save(patch); });
    const busyStates: boolean[] = [];
    const hook = renderHook(() => {
      const execution = useExecutionStore(base);
      busyStates.push(execution.store.busy);
      return execution;
    });
    let pending!: Promise<unknown>;
    let start!: Promise<unknown>;
    await act(async () => {
      pending = hook.result.current.store.updateConfig({ ctx_size: 8192 });
      start = hook.result.current.store.start();
    });
    expect(base.start).not.toHaveBeenCalled();
    expect(hook.result.current.store.busy).toBe(false);
    await act(async () => { finish(); await pending; await start; });
    expect(base.cfg?.ctx_size).toBe(8192);
    expect(base.start).toHaveBeenCalledOnce();
    expect(busyStates.every(busy => !busy)).toBe(true);
    base.busy = true;
    hook.rerender();
    expect(hook.result.current.store.busy).toBe(true);
  });
  it('restores a model after edits, switching and remounting', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.updateConfig({ ctx_size: 8192, temperature: 0.3 }); });
    await act(async () => { await hook.result.current.selectModel('b.gguf'); });
    await act(async () => { await hook.result.current.store.updateConfig({ ctx_size: 2048, temperature: 1.2 }); });
    hook.unmount();
    const reopened = renderHook(() => useExecutionStore(base));
    await act(async () => { await reopened.result.current.selectModel('a.gguf'); });
    expect(base.cfg).toMatchObject({ active_model: 'a.gguf', ctx_size: 8192, temperature: 0.3 });
    expect(restoreExecution(base.cfg!, 'b.gguf')).toMatchObject({ ctx_size: 2048, temperature: 1.2 });
  });
  it('keeps the old selection on save failure and allows retry', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const save = base.updateConfig;
    base.updateConfig = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(save);
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await expect(hook.result.current.selectModel('b.gguf')).rejects.toThrow('disk full'); });
    expect(base.cfg?.active_model).toBe('a.gguf');
    await act(async () => { await hook.result.current.store.start(); });
    expect(base.start).toHaveBeenCalledOnce();
    await act(async () => { await hook.result.current.selectModel('b.gguf'); });
    expect(base.cfg?.active_model).toBe('b.gguf');
  });
  it('serializes selections and makes explicit project configuration take precedence', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await Promise.all([hook.result.current.store.updateConfig({ ctx_size: 8192 }), hook.result.current.selectModel('b.gguf')]); });
    await act(async () => { await hook.result.current.store.updateConfig({ active_model: 'a.gguf', ctx_size: 32768 }); });
    expect(base.cfg).toMatchObject({ active_model: 'a.gguf', ctx_size: 32768 });
    expect(restoreExecution(base.cfg!, 'a.gguf').ctx_size).toBe(32768);
  });
  it('rejects a storage failure before changing the native model', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const hook = renderHook(() => useExecutionStore(base));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    try {
      await act(async () => { await expect(hook.result.current.selectModel('b.gguf')).rejects.toThrow('Storage full'); });
      expect(base.cfg?.active_model).toBe('a.gguf'); expect(base.updateConfig).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
  it('saves session and app metadata without accessing model memory', async () => {
    const base = createTestStore();
    const hook = renderHook(() => useExecutionStore(base));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    try {
      await act(async () => { await hook.result.current.store.updateConfig({ sessions: [], stop_existing_sessions_on_load: false }); });
      expect(base.cfg?.stop_existing_sessions_on_load).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
});
