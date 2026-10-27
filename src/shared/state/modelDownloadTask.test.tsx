import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { getTaskSnapshot, registerTask, removeTask, updateTask } from './taskRegistry';
import { MODEL_DOWNLOAD_TASK_ID, useModelDownloadTask } from './modelDownloadTask';

vi.mock('../api', () => ({ onModelDownloadProgress: vi.fn(async () => () => undefined), hfCancelDownload: vi.fn() }));
afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); vi.clearAllMocks(); });

it('keeps cancellation pending while later native progress arrives, then accepts cancellation completion', async () => {
  let progress!: (value: api.ModelDownloadProgress) => void;
  vi.mocked(api.onModelDownloadProgress).mockImplementation(async listener => { progress = listener; return () => undefined; });
  renderHook(() => useModelDownloadTask());
  await waitFor(() => expect(progress).toBeDefined());
  registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: 'model-download', label: 'synthetic', interruptible: true });
  updateTask(MODEL_DOWNLOAD_TASK_ID, { state: 'cancelling' });
  act(() => progress({ repo_id: 'synthetic/model', file_path: 'model.safetensors', phase: 'downloading', received: 16, total: 64 }));
  expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)).toMatchObject({ state: 'cancelling', received: 16 });
  act(() => progress({ repo_id: 'synthetic/model', file_path: 'model.safetensors', phase: 'cancelled', received: 16, total: 64 }));
  expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.state).toBe('cancelled');
});
