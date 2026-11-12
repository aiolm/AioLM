import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke as nativeInvoke } from '@tauri-apps/api/core';
import { listen as nativeListen } from '@tauri-apps/api/event';
import { invoke, listen, NATIVE_RUNTIME_ERROR, withNativeRuntime } from './transport';
import { IpcError, isIpcErrorKind } from './ipcError';
import { errorMessage } from './errors';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('native transport availability', () => {
  it('rejects commands, subscriptions and SDK actions in a browser preview without calling the SDK', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', undefined);
    const action = vi.fn(async () => undefined);
    await expect(invoke<void>('synthetic_command')).rejects.toThrow(NATIVE_RUNTIME_ERROR);
    await expect(listen<string>('synthetic-event', () => undefined)).rejects.toThrow(NATIVE_RUNTIME_ERROR);
    await expect(withNativeRuntime(action)).rejects.toThrow(NATIVE_RUNTIME_ERROR);
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(nativeListen).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('preserves the listener payload and cleanup when the native runtime is available', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const callback = vi.fn();
    const stop = vi.fn();
    vi.mocked(nativeListen).mockResolvedValueOnce(stop);
    await expect(listen<string>('synthetic-event', callback)).resolves.toBe(stop);
    expect(nativeListen).toHaveBeenCalledExactlyOnceWith('synthetic-event', callback);
  });

  it('converts serialized native failures before callers classify or display them', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.mocked(nativeInvoke).mockRejectedValueOnce({ kind: 'denied', message: 'Synthetic native refusal' });
    const cause: unknown = await invoke<void>('synthetic_command').catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(IpcError);
    expect(isIpcErrorKind(cause, 'denied')).toBe(true);
    expect(errorMessage(cause)).toBe('Synthetic native refusal');
    expect(String(cause)).toBe('Synthetic native refusal');
  });

  it('preserves benchmark sharing rejections with their dedicated code shape', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const cause = { code: 'verification_required', message: 'Synthetic sharing verification' };
    vi.mocked(nativeInvoke).mockRejectedValueOnce(cause);
    await expect(invoke<void>('benchmark_sharing_prepare')).rejects.toBe(cause);
  });
});
