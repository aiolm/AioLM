import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { getTaskSnapshot, registerTask, removeTask, updateTask } from './taskRegistry';
import { MODEL_DOWNLOAD_TASK_ID, modelDownloadTaskId, useModelDownloadTask } from './modelDownloadTask';

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

it('tracks concurrent downloads independently by download_id', async () => {
  let progress!: (value: api.ModelDownloadProgress) => void;
  vi.mocked(api.onModelDownloadProgress).mockImplementation(async listener => { progress = listener; return () => undefined; });
  renderHook(() => useModelDownloadTask());
  await waitFor(() => expect(progress).toBeDefined());

  act(() => {
    progress({ download_id: 'dl-1', repo_id: 'owner/one', file_path: 'one.gguf', phase: 'downloading', received: 25, total: 100 });
    progress({ download_id: 'dl-2', repo_id: 'owner/two', file_path: 'two.gguf', phase: 'downloading', received: 60, total: 100 });
  });

  const taskOne = getTaskSnapshot().find(task => task.id === modelDownloadTaskId('dl-1'));
  const taskTwo = getTaskSnapshot().find(task => task.id === modelDownloadTaskId('dl-2'));
  expect(taskOne).toMatchObject({ state: 'running', received: 25, total: 100, repoId: 'owner/one' });
  expect(taskTwo).toMatchObject({ state: 'running', received: 60, total: 100, repoId: 'owner/two' });

  await taskOne?.cancel?.();
  expect(api.hfCancelDownload).toHaveBeenCalledWith('dl-1');

  act(() => progress({ download_id: 'dl-1', repo_id: 'owner/one', file_path: 'one.gguf', phase: 'cancelled', received: 25, total: 100 }));
  expect(getTaskSnapshot().find(task => task.id === modelDownloadTaskId('dl-1'))?.state).toBe('cancelled');
  expect(getTaskSnapshot().find(task => task.id === modelDownloadTaskId('dl-2'))?.state).toBe('running');
});

it('formats shard-suffixed file paths into unified download task labels', async () => {
  let progress!: (value: api.ModelDownloadProgress) => void;
  vi.mocked(api.onModelDownloadProgress).mockImplementation(async listener => { progress = listener; return () => undefined; });
  renderHook(() => useModelDownloadTask());
  await waitFor(() => expect(progress).toBeDefined());

  act(() => {
    progress({ download_id: 'dl-st', repo_id: 'owner/repo', file_path: '4bit/model-00001-of-00004.safetensors', phase: 'downloading', received: 10, total: 100 });
    progress({ download_id: 'dl-4d', repo_id: 'owner/repo', file_path: 'model-0001-of-0004.gguf', phase: 'downloading', received: 20, total: 100 });
  });

  expect(getTaskSnapshot().find(task => task.id === modelDownloadTaskId('dl-st'))?.label).toBe('4bit/model.safetensors');
  expect(getTaskSnapshot().find(task => task.id === modelDownloadTaskId('dl-4d'))?.label).toBe('model.gguf');
});
