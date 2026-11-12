import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAppUpdate, installAppUpdate, onAppUpdateProgress } from '../../shared/api/appUpdates';
import { appUpdater } from './appUpdater';

vi.mock('../../shared/api/transport', () => ({ isNativeRuntimeAvailable: () => true }));
vi.mock('../../shared/api/appUpdates', () => ({
  checkAppUpdate: vi.fn(), installAppUpdate: vi.fn(), onAppUpdateProgress: vi.fn(), openAppUpdateRelease: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkAppUpdate).mockResolvedValue({ current_version: '1.0.0', latest_version: '1.1.0', available: true,
    can_install: true, release_url: 'https://example.com/releases/1.1.0', published_at: null, notes: null });
  vi.mocked(installAppUpdate).mockResolvedValue(undefined);
  vi.mocked(onAppUpdateProgress).mockResolvedValue(() => undefined);
});

describe('desktop update IPC failures', () => {
  it('shows a structured check rejection without object coercion', async () => {
    vi.mocked(checkAppUpdate).mockRejectedValueOnce({ code: 'synthetic_failure', message: 'Synthetic update check failure' });
    await appUpdater.check();
    expect(appUpdater.getSnapshot()).toMatchObject({ phase: 'error', error: 'Synthetic update check failure', errorKind: 'check' });
  });

  it('shows a structured install rejection and removes the progress listener', async () => {
    const stop = vi.fn();
    vi.mocked(onAppUpdateProgress).mockResolvedValueOnce(stop);
    vi.mocked(installAppUpdate).mockRejectedValueOnce({ message: 'Synthetic installer failure' });
    await appUpdater.check();
    await appUpdater.install();
    expect(appUpdater.getSnapshot()).toMatchObject({ phase: 'error', error: 'Synthetic installer failure', errorKind: 'install' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not start installation when progress registration fails', async () => {
    vi.mocked(onAppUpdateProgress).mockRejectedValueOnce({ message: 'Synthetic listener failure' });
    await appUpdater.check();
    await appUpdater.install();
    expect(appUpdater.getSnapshot()).toMatchObject({ phase: 'error', error: 'Synthetic listener failure', errorKind: 'install' });
    expect(installAppUpdate).not.toHaveBeenCalled();
  });
});
