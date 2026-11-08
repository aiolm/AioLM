import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { snapshotModelName } from '../api/providers';
import type { SnapshotDisplayName } from '../api/providers';
import { isNativeRuntimeAvailable } from '../api/transport';
import ModelName, { useModelNames } from './ModelName';

vi.mock(import('../api/providers'), async original => ({ ...await original(), snapshotModelName: vi.fn() }));
vi.mock(import('../api/transport'), async original => ({ ...await original(), isNativeRuntimeAvailable: vi.fn() }));
const first = '/synthetic/hf/example/variants/snapshots/' + 'a'.repeat(40);
const second = '/synthetic/hf/example/other/snapshots/' + 'b'.repeat(40);
const selectedLabel = (name: string): SnapshotDisplayName => ({ name, selected: true });
beforeEach(() => { vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true); vi.mocked(snapshotModelName).mockReset(); });

it('keeps the fallback on failed inspection and retries a later mount', async () => {
  vi.mocked(snapshotModelName).mockRejectedValueOnce(new Error('Synthetic unreadable model card'));
  const view = render(<ModelName model={first} />);
  await waitFor(() => expect(snapshotModelName).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(screen.getByText('variants')).toBeVisible();
  view.unmount();
  vi.mocked(snapshotModelName).mockResolvedValueOnce(selectedLabel('now-readable-model'));
  render(<ModelName model={first} />);
  expect(await screen.findByText('now-readable-model')).toBeVisible();
  expect(snapshotModelName).toHaveBeenCalledTimes(2);
});

it('does not let an earlier model inspection relabel a newly selected model', async () => {
  let finish!: (value: SnapshotDisplayName | null) => void;
  vi.mocked(snapshotModelName).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  vi.mocked(snapshotModelName).mockResolvedValueOnce(selectedLabel('second-model'));
  const view = render(<ModelName model={first} />);
  await waitFor(() => expect(snapshotModelName).toHaveBeenCalledWith(first));
  view.rerender(<ModelName model={second} />);
  expect(await screen.findByText('second-model')).toBeVisible();
  await act(async () => { finish(selectedLabel('first-model')); });
  expect(screen.getByText('second-model')).toBeVisible();
  expect(screen.queryByText('first-model')).not.toBeInTheDocument();
});

it('deduplicates concurrent labels and releases a read after both consumers resolve', async () => {
  let finish!: (value: SnapshotDisplayName | null) => void;
  vi.mocked(snapshotModelName).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<><p><ModelName model={first} /></p><p><ModelName model={first} /></p></>);
  await waitFor(() => expect(snapshotModelName).toHaveBeenCalledOnce());
  await act(async () => { finish(selectedLabel('shared-label')); });
  expect(screen.getAllByText('shared-label')).toHaveLength(2);
  view.unmount();
  vi.mocked(snapshotModelName).mockResolvedValueOnce(selectedLabel('edited-label'));
  render(<ModelName model={first} />);
  expect(await screen.findByText('edited-label')).toBeVisible();
  expect(snapshotModelName).toHaveBeenCalledTimes(2);
});

it('keeps browser preview and empty model labels available without native IPC', () => {
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
  const view = render(<ModelName model={first} />);
  expect(screen.getByText('variants')).toBeVisible();
  view.rerender(<ModelName empty="Choose a model" />);
  expect(screen.getByText('Choose a model')).toBeVisible();
  expect(snapshotModelName).not.toHaveBeenCalled();
});

it('resolves dynamic option names independently, deduplicates paths and retains their order', async () => {
  let finish!: (value: SnapshotDisplayName | null) => void;
  vi.mocked(snapshotModelName).mockImplementation(path => path === first
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(selectedLabel('second-model')));
  const { result, rerender } = renderHook(({ paths }) => useModelNames(paths), { initialProps: { paths: [first, second, first, '/synthetic/known.gguf'] } });
  expect(result.current).toEqual(['variants', 'other', 'variants', 'known.gguf']);
  await waitFor(() => expect(result.current).toEqual(['variants', 'second-model', 'variants', 'known.gguf']));
  expect(snapshotModelName).toHaveBeenCalledTimes(2);
  rerender({ paths: [second, '/synthetic/known.gguf', first] });
  expect(result.current).toEqual(['second-model', 'known.gguf', 'variants']);
  await act(async () => { finish(selectedLabel('first-model')); });
  expect(result.current).toEqual(['second-model', 'known.gguf', 'first-model']);
  expect(snapshotModelName).toHaveBeenCalledTimes(2);
});

it('ignores removed option reads and leaves failed inspections as their original labels', async () => {
  let finish!: (value: SnapshotDisplayName | null) => void;
  vi.mocked(snapshotModelName).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  vi.mocked(snapshotModelName).mockRejectedValueOnce(new Error('Synthetic unreadable model card'));
  const { result, rerender } = renderHook(({ paths }) => useModelNames(paths), { initialProps: { paths: [first] } });
  await waitFor(() => expect(snapshotModelName).toHaveBeenCalledWith(first));
  rerender({ paths: [second] });
  await waitFor(() => expect(snapshotModelName).toHaveBeenCalledWith(second));
  await act(async () => { finish(selectedLabel('removed-model')); });
  expect(result.current).toEqual(['other']);
});

it('does not fetch dynamic option names in browser preview', () => {
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
  const { result } = renderHook(() => useModelNames([first, '/synthetic/known.gguf', '']));
  expect(result.current).toEqual(['variants', 'known.gguf', '']);
  expect(snapshotModelName).not.toHaveBeenCalled();
});

it('distinguishes selected bundles without changing whole repository labels', async () => {
  vi.mocked(snapshotModelName).mockResolvedValueOnce({ name: 'A whole-model card title', selected: false });
  const view = render(<ModelName model={first} />);
  await waitFor(() => expect(snapshotModelName).toHaveBeenCalledWith(first));
  await act(async () => {});
  expect(screen.getByText('variants')).toBeVisible();
  expect(screen.queryByText('A whole-model card title')).not.toBeInTheDocument();

  vi.mocked(snapshotModelName).mockResolvedValueOnce(selectedLabel('variants · 4bit/model.safetensors'));
  const variant = first.replace('a'.repeat(40), 'c'.repeat(40));
  view.rerender(<ModelName model={variant} />);
  expect(await screen.findByText('variants · 4bit/model.safetensors')).toBeVisible();

  vi.mocked(snapshotModelName).mockResolvedValueOnce({ name: 'Declared external model', selected: false });
  view.rerender(<ModelName model={'/synthetic/external/snapshots/' + 'd'.repeat(40)} />);
  expect(await screen.findByText('Declared external model')).toBeVisible();
});
