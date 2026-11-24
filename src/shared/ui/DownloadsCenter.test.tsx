import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { IpcError } from '../api/ipcError';
import { defaultPreferences, savePreferences } from '../config/preferences';
import { I18nProvider } from '../i18n/i18n';
import {
  getPendingDownloadsSnapshot,
  recordCompletedDownload,
  refreshPendingDownloads,
  resetPendingDownloadsStoreForTests,
} from '../state/pendingDownloadsStore';
import {
  finishTask,
  getTaskSnapshot,
  registerTask,
  removeTask,
} from '../state/taskRegistry';
import ActivityCenter from './ActivityCenter';
import DownloadsCenter from './DownloadsCenter';
import { PanelFeedbackOutlet, PanelFeedbackProvider } from './PanelFeedback';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    hfPendingDownloads: vi.fn(async () => []),
    hfDiscardDownload: vi.fn(async () => undefined),
    hfDownloadModel: vi.fn(),
    hfDownloadSnapshot: vi.fn(),
    hfCancelDownload: vi.fn(async () => undefined),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.hfPendingDownloads).mockResolvedValue([]);
  localStorage.clear();
  resetPendingDownloadsStoreForTests();
  for (const task of getTaskSnapshot()) removeTask(task.id);
});

afterEach(() => {
  cleanup();
  resetPendingDownloadsStoreForTests();
  for (const task of getTaskSnapshot()) removeTask(task.id);
});

describe('DownloadsCenter', () => {
  it('shows aggregate progress for concurrent active downloads without auto-opening and preserves paused items beside running ones', async () => {
    const cancelAlpha = vi.fn(async () => undefined);
    const cancelBeta = vi.fn(async () => undefined);
    const pausedEntry: api.PendingDownload = {
      id: 'pending-paused',
      repo_id: 'owner/paused',
      file_path: 'paused.Q4_K_M.gguf',
      revision: 'a'.repeat(40),
      snapshot: false,
      models_dir: 'models',
      include_companions: false,
      label: 'paused.Q4_K_M.gguf',
      total: 1000,
      received: 350,
      updated_at: 10,
      files: [{ path: 'models/paused.Q4_K_M.gguf', size: 1000 }],
    };
    vi.mocked(api.hfPendingDownloads).mockResolvedValue([pausedEntry]);

    registerTask({
      id: 'model-download:alpha',
      kind: 'model-download',
      repoId: 'owner/alpha',
      filePath: 'alpha.gguf',
      label: 'alpha.gguf',
      phase: 'downloading',
      received: 250,
      total: 500,
      interruptible: true,
      pausable: true,
      cancel: cancelAlpha,
    });
    registerTask({
      id: 'model-download:beta',
      kind: 'model-download',
      repoId: 'owner/beta',
      filePath: 'beta.gguf',
      label: 'beta.gguf',
      phase: 'downloading',
      received: 750,
      total: 1500,
      interruptible: true,
      pausable: true,
      cancel: cancelBeta,
    });

    render(
      <I18nProvider initialLocale="en">
        <DownloadsCenter />
      </I18nProvider>,
    );

    const trigger = await screen.findByTestId('downloads-center-trigger');
    // Aggregate = 1000 / 2000 = 50%, 2 active, 1 paused
    expect(trigger).toHaveAccessibleName('Downloads: 2 active (50%), 1 paused');
    expect(trigger).toHaveClass('is-active');
    expect(within(trigger).getByTestId('downloads-center-badge')).toHaveTextContent('2');
    expect(trigger.querySelector('progress')).toBeNull();
    expect(trigger.querySelector('.header-download-ring')).toBeNull();
    expect(screen.queryByTestId('downloads-center-popover')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const popover = await screen.findByTestId('downloads-center-popover');
    expect(within(popover).getAllByTestId('download-center-active-row')).toHaveLength(2);
    const pausedRows = within(popover).getAllByTestId('download-center-paused-row');
    expect(pausedRows).toHaveLength(1);
    expect(pausedRows[0]).toHaveTextContent('paused.Q4_K_M.gguf');

    // Pausing alpha does not cancel beta, and the paused entry remains visible.
    const alphaRow = within(popover)
      .getAllByTestId('download-center-active-row')
      .find((row) => row.textContent?.includes('alpha.gguf'))!;
    fireEvent.click(within(alphaRow).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(cancelAlpha).toHaveBeenCalledOnce());
    expect(cancelBeta).not.toHaveBeenCalled();
    expect(within(popover).getByTestId('download-center-paused-row')).toBeVisible();
  });

  it('resumes and discards paused items while another download is active', async () => {
    savePreferences({ ...defaultPreferences(), advanced: { confirmDestructiveActions: false } });
    const pendingBeta: api.PendingDownload = {
      id: 'pending-beta',
      repo_id: 'owner/beta',
      file_path: 'beta.gguf',
      revision: 'b'.repeat(40),
      snapshot: false,
      models_dir: 'models',
      include_companions: false,
      label: 'beta.gguf',
      total: 1000,
      received: 400,
      updated_at: 20,
      files: [{ path: 'models/beta.gguf', size: 1000 }],
    };
    const pendingGamma: api.PendingDownload = {
      id: 'pending-gamma',
      repo_id: 'owner/gamma',
      file_path: 'gamma.gguf',
      revision: 'c'.repeat(40),
      snapshot: false,
      models_dir: 'models',
      include_companions: false,
      label: 'gamma.gguf',
      total: 1000,
      received: 200,
      updated_at: 10,
      files: [{ path: 'models/gamma.gguf', size: 1000 }],
    };

    vi.mocked(api.hfPendingDownloads)
      .mockResolvedValueOnce([pendingBeta, pendingGamma])
      .mockResolvedValueOnce([pendingBeta]);
    let resolveResume!: (value: api.DownloadedModel) => void;
    vi.mocked(api.hfDownloadModel).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResume = resolve;
      }),
    );

    registerTask({
      id: 'model-download:alpha',
      kind: 'model-download',
      repoId: 'owner/alpha',
      filePath: 'alpha.gguf',
      label: 'alpha.gguf',
      phase: 'downloading',
      received: 100,
      total: 1000,
      interruptible: true,
      pausable: true,
      cancel: vi.fn(),
    });

    render(
      <I18nProvider initialLocale="en">
        <DownloadsCenter />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('downloads-center-trigger'));
    const popover = await screen.findByTestId('downloads-center-popover');
    await waitFor(() =>
      expect(within(popover).getAllByTestId('download-center-paused-row')).toHaveLength(2),
    );

    fireEvent.click(within(popover).getByRole('button', { name: 'Discard: gamma.gguf' }));
    await waitFor(() => expect(api.hfDiscardDownload).toHaveBeenCalledWith('pending-gamma'));

    fireEvent.click(within(popover).getByRole('button', { name: 'Resume: beta.gguf' }));
    await waitFor(() =>
      expect(api.hfDownloadModel).toHaveBeenCalledWith(
        'owner/beta',
        'beta.gguf',
        'models',
        undefined,
        'b'.repeat(40),
        expect.any(String),
      ),
    );
    expect(within(popover).getAllByTestId('download-center-active-row')).toHaveLength(2);

    await act(async () =>
      resolveResume({
        path: 'models/hf/owner/beta/beta.gguf',
        repo_id: 'owner/beta',
        file_path: 'beta.gguf',
        size_bytes: 1000,
      }),
    );
  });

  it('auto-opens with an alert when a download fails and triggers Configure on completed entries', async () => {
    const onConfigureModel = vi.fn();
    recordCompletedDownload({
      id: 'done-1',
      repoId: 'owner/done',
      label: 'done.gguf',
      filePath: 'done.gguf',
      path: 'models/done.gguf',
      projector: false,
      kind: 'gguf',
    });

    render(
      <I18nProvider initialLocale="en">
        <DownloadsCenter onConfigureModel={onConfigureModel} />
      </I18nProvider>,
    );

    act(() => {
      registerTask({
        id: 'model-download:fail',
        kind: 'model-download',
        repoId: 'owner/fail',
        filePath: 'fail.gguf',
        label: 'fail.gguf',
        interruptible: true,
      });
    });
    expect(screen.queryByTestId('downloads-center-popover')).not.toBeInTheDocument();

    act(() => {
      finishTask('model-download:fail', 'failed', 'Checksum mismatch');
    });
    const popover = await screen.findByTestId('downloads-center-popover');
    expect(within(popover).getByRole('alert')).toHaveTextContent('Checksum mismatch');

    fireEvent.click(within(popover).getByRole('button', { name: 'Configure' }));
    expect(onConfigureModel).toHaveBeenCalledWith({ path: 'models/done.gguf', projector: false });
    expect(screen.queryByTestId('downloads-center-popover')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('downloads-center-trigger'));
    const reopened = await screen.findByTestId('downloads-center-popover');
    fireEvent.click(within(reopened).getByRole('button', { name: 'Dismiss: fail.gguf' }));
    expect(screen.queryByText('Checksum mismatch')).not.toBeInTheDocument();
  });

  it('keeps IpcError cancellations non-error in paused storage', async () => {
    vi.mocked(api.hfPendingDownloads).mockResolvedValue([
      {
        id: 'pending-pause',
        repo_id: 'owner/pause',
        file_path: 'pause.gguf',
        revision: 'd'.repeat(40),
        snapshot: false,
        models_dir: 'models',
        include_companions: false,
        label: 'pause.gguf',
        total: 1000,
        received: 100,
        updated_at: 1,
        files: [],
      },
    ]);
    vi.mocked(api.hfDownloadModel).mockRejectedValueOnce(
      new IpcError('cancelled', 'model download cancelled'),
    );

    render(
      <I18nProvider initialLocale="en">
        <DownloadsCenter />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('downloads-center-trigger'));
    const popover = await screen.findByTestId('downloads-center-popover');
    fireEvent.click(await within(popover).findByRole('button', { name: 'Resume: pause.gguf' }));
    await waitFor(() =>
      expect(getTaskSnapshot().every((task) => task.state !== 'failed')).toBe(true),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the popover open when pausing the only active download and transitions seamlessly to Paused', async () => {
    const cancelOnly = vi.fn(async () => undefined);
    const pausedOnly: api.PendingDownload = {
      id: 'pending-only',
      repo_id: 'owner/only',
      file_path: 'only.gguf',
      revision: 'e'.repeat(40),
      snapshot: false,
      models_dir: 'models',
      include_companions: false,
      label: 'only.gguf',
      total: 1000,
      received: 420,
      updated_at: 30,
      files: [{ path: 'models/only.gguf', size: 1000 }],
    };
    let resolvePausedFetch!: (value: api.PendingDownload[]) => void;
    vi.mocked(api.hfPendingDownloads)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<api.PendingDownload[]>((resolve) => {
            resolvePausedFetch = resolve;
          }),
      );

    registerTask({
      id: 'model-download:only',
      kind: 'model-download',
      repoId: 'owner/only',
      filePath: 'only.gguf',
      label: 'only.gguf',
      phase: 'downloading',
      received: 420,
      total: 1000,
      interruptible: true,
      pausable: true,
      cancel: cancelOnly,
    });

    render(
      <I18nProvider initialLocale="en">
        <DownloadsCenter />
      </I18nProvider>,
    );

    const trigger = await screen.findByTestId('downloads-center-trigger');
    expect(trigger).toHaveClass('is-active');
    expect(trigger.querySelector('progress')).toBeNull();
    expect(trigger.querySelector('.header-download-ring')).toBeNull();
    expect(trigger).toHaveAccessibleName('Downloads: 1 active (42%)');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const popover = await screen.findByTestId('downloads-center-popover');
    fireEvent.click(within(popover).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(cancelOnly).toHaveBeenCalledOnce());

    // Simulate task finishing as cancelled before the async hfPendingDownloads() resolves.
    act(() => {
      finishTask('model-download:only', 'cancelled');
    });

    const stillOpen = screen.getByTestId('downloads-center-popover');
    expect(stillOpen).toBeVisible();
    expect(within(stillOpen).queryByText('No active or paused downloads.')).not.toBeInTheDocument();

    await act(async () => {
      resolvePausedFetch([pausedOnly]);
      await Promise.resolve();
    });

    const pausedRow = await within(stillOpen).findByTestId('download-center-paused-row');
    expect(pausedRow).toHaveTextContent('only.gguf');
    expect(within(stillOpen).getByRole('button', { name: 'Resume: only.gguf' })).toBeEnabled();
    expect(within(stillOpen).getByRole('button', { name: 'Discard: only.gguf' })).toBeEnabled();
    const updatedTrigger = screen.getByTestId('downloads-center-trigger');
    expect(updatedTrigger).toHaveAccessibleName('Downloads: 1 paused');
    expect(within(updatedTrigger).getByTestId('downloads-center-badge')).toHaveTextContent('1');
  });

  it('stays mounted as a fixed icon button when empty and shows empty copy on click', async () => {
    render(
      <I18nProvider initialLocale="en">
        <DownloadsCenter />
      </I18nProvider>,
    );

    const trigger = await screen.findByTestId('downloads-center-trigger');
    expect(trigger).toBeVisible();
    expect(trigger).toHaveAccessibleName('Downloads');
    expect(screen.queryByTestId('downloads-center-badge')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const popover = await screen.findByTestId('downloads-center-popover');
    expect(within(popover).getByText('No active or paused downloads.')).toBeVisible();
  });

  it('queues a trailing refresh when refreshPendingDownloads is called while another read is in flight', async () => {
    const trailingEntry: api.PendingDownload = {
      id: 'pending-trailing',
      repo_id: 'owner/trailing',
      file_path: 'trailing.gguf',
      revision: 'f'.repeat(40),
      snapshot: false,
      models_dir: 'models',
      include_companions: false,
      label: 'trailing.gguf',
      total: 1000,
      received: 250,
      updated_at: 40,
      files: [{ path: 'models/trailing.gguf', size: 1000 }],
    };
    let resolveFirst!: (value: api.PendingDownload[]) => void;
    let resolveSecond!: (value: api.PendingDownload[]) => void;
    vi.mocked(api.hfPendingDownloads)
      .mockImplementationOnce(
        () =>
          new Promise<api.PendingDownload[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<api.PendingDownload[]>((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const first = refreshPendingDownloads();
    const second = refreshPendingDownloads({ force: true });
    expect(getPendingDownloadsSnapshot().refreshing).toBe(true);
    expect(api.hfPendingDownloads).toHaveBeenCalledTimes(1);

    resolveFirst([]);
    await waitFor(() => expect(api.hfPendingDownloads).toHaveBeenCalledTimes(2));

    resolveSecond([trailingEntry]);
    await Promise.all([first, second]);

    expect(getPendingDownloadsSnapshot().refreshing).toBe(false);
    expect(getPendingDownloadsSnapshot().entries).toEqual([trailingEntry]);
  });

  it('shows runtime downloads in DownloadsCenter with localized phase, Cancel action, and steady speed', async () => {
    const cancelRuntime = vi.fn(async () => undefined);
    registerTask({
      id: 'runtime-operation',
      kind: 'runtime',
      downloadKind: 'runtime',
      label: 'llama.cpp · ROCm (AMD) · b11029',
      phase: 'downloading',
      received: 50 * 1024 * 1024,
      total: 200 * 1024 * 1024,
      speedBps: 25 * 1024 * 1024,
      interruptible: true,
      cancel: cancelRuntime,
    });

    const view = render(
      <I18nProvider initialLocale="en">
        <DownloadsCenter />
      </I18nProvider>,
    );

    const trigger = await screen.findByTestId('downloads-center-trigger');
    expect(trigger).toHaveClass('is-active');
    expect(within(trigger).getByTestId('downloads-center-badge')).toHaveTextContent('1');
    expect(trigger.querySelector('progress')).toBeNull();

    fireEvent.click(trigger);
    const row = await screen.findByTestId('download-center-active-row');
    expect(within(row).getByText('llama.cpp · ROCm (AMD) · b11029')).toBeVisible();
    expect(within(row).getByText('Downloading')).toBeVisible();
    expect(within(row).getByText('50.0 MiB / 200.0 MiB · 25.0 MiB/s · 6s left')).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();

    // 0 B/s pause keeps the speed readout visible rather than dropping to bytes only.
    act(() => {
      registerTask({
        id: 'runtime-operation',
        kind: 'runtime',
        downloadKind: 'runtime',
        label: 'llama.cpp · ROCm (AMD) · b11029',
        phase: 'downloading',
        received: 50 * 1024 * 1024,
        total: 200 * 1024 * 1024,
        speedBps: 0,
        interruptible: true,
        cancel: cancelRuntime,
      });
    });
    expect(within(row).getByText('50.0 MiB / 200.0 MiB · 0 B/s')).toBeVisible();

    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelRuntime).toHaveBeenCalledOnce());

    // Korean locale translates the backend phase token and action label properly.
    view.unmount();
    act(() => {
      registerTask({
        id: 'runtime-operation',
        kind: 'runtime',
        downloadKind: 'runtime',
        label: 'llama.cpp · ROCm (AMD) · b11029',
        phase: 'downloading',
        received: 50 * 1024 * 1024,
        total: 200 * 1024 * 1024,
        speedBps: 25 * 1024 * 1024,
        interruptible: true,
        cancel: cancelRuntime,
      });
    });
    render(
      <I18nProvider initialLocale="ko">
        <DownloadsCenter />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByTestId('downloads-center-trigger'));
    const koRow = await screen.findByTestId('download-center-active-row');
    expect(within(koRow).getByText('다운로드 중')).toBeVisible();
    expect(within(koRow).getByRole('button', { name: '취소' })).toBeVisible();
  });

  it('closes when ActivityCenter opens and shows app update downloads with speed', async () => {
    registerTask({
      id: 'app-update-download',
      kind: 'other',
      downloadKind: 'app-update',
      label: 'AioLM 1.2.0',
      phase: 'downloading',
      received: 10 * 1024 * 1024,
      total: 40 * 1024 * 1024,
      speedBps: 5 * 1024 * 1024,
      interruptible: true,
    });

    render(
      <I18nProvider initialLocale="en">
        <PanelFeedbackProvider>
          <DownloadsCenter />
          <ActivityCenter hasActivity={false} title="Tasks" attentionMessage="Attention" globalError={false}>
            <PanelFeedbackOutlet />
          </ActivityCenter>
        </PanelFeedbackProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('downloads-center-trigger'));
    const row = await screen.findByTestId('download-center-active-row');
    expect(within(row).getByText('AioLM 1.2.0')).toBeVisible();
    expect(within(row).getByText('Downloading')).toBeVisible();
    expect(within(row).getByText('10.0 MiB / 40.0 MiB · 5.0 MiB/s · 6s left')).toBeVisible();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('activity-center-trigger'));
    expect(screen.getByTestId('activity-center-popover')).not.toHaveAttribute('hidden');
    expect(screen.queryByTestId('downloads-center-popover')).not.toBeInTheDocument();
  });
});
