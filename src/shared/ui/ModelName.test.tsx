import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { modelArtifact, type ModelArtifact } from '../api/providers';
import { isNativeRuntimeAvailable } from '../api/transport';
import ModelName, { useModelNames } from './ModelName';

vi.mock('../api/providers', async original => ({ ...await original<typeof import('../api/providers')>(), modelArtifact: vi.fn() }));
vi.mock('../api/transport', async original => ({ ...await original<typeof import('../api/transport')>(), isNativeRuntimeAvailable: vi.fn() }));
const first = '/synthetic/external/snapshots/' + 'a'.repeat(40);
const second = '/synthetic/external/snapshots/' + 'b'.repeat(40);
function artifact(path: string, name: string): ModelArtifact {
  return { path, name, format: 'mlx', role: 'model', size_bytes: 10, file_count: 3, architectures: [],
    modalities: { text: true, image: false, audio: false, video: false }, missing: [], incomplete: false, ownership: 'external', notes: [] };
}
beforeEach(() => { vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true); vi.mocked(modelArtifact).mockReset(); });

it('shows a declared external snapshot label while retaining the requested model path', async () => {
  vi.mocked(modelArtifact).mockResolvedValue(artifact(first, 'converted-model-4bit'));
  render(<ModelName model={first} />);
  expect(await screen.findByText('converted-model-4bit')).toBeVisible();
  expect(modelArtifact).toHaveBeenCalledWith(first);
  expect(screen.queryByText('a'.repeat(40))).not.toBeInTheDocument();
});

it('does not inspect familiar filenames, repository layouts or user-selected folder names', () => {
  const model = '/synthetic/hf/example/known-model/snapshots/' + 'a'.repeat(40);
  const view = render(<ModelName model={model} />);
  expect(screen.getByText('known-model')).toBeVisible();
  view.rerender(<ModelName model="/synthetic/primary.gguf" />);
  expect(screen.getByText('primary.gguf')).toBeVisible();
  view.rerender(<ModelName model="/synthetic/user-selected-folder" />);
  expect(screen.getByText('user-selected-folder')).toBeVisible();
  expect(modelArtifact).not.toHaveBeenCalled();
});

it('keeps the fallback on failed inspection and retries a later mount', async () => {
  vi.mocked(modelArtifact).mockRejectedValueOnce(new Error('Synthetic unreadable model card'));
  const view = render(<ModelName model={first} />);
  await waitFor(() => expect(modelArtifact).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(screen.getByText('a'.repeat(40))).toBeVisible();
  view.unmount();
  vi.mocked(modelArtifact).mockResolvedValueOnce(artifact(first, 'now-readable-model'));
  render(<ModelName model={first} />);
  expect(await screen.findByText('now-readable-model')).toBeVisible();
  expect(modelArtifact).toHaveBeenCalledTimes(2);
});

it('does not let an earlier model inspection relabel a newly selected model', async () => {
  let finish!: (value: ModelArtifact) => void;
  vi.mocked(modelArtifact).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  vi.mocked(modelArtifact).mockResolvedValueOnce(artifact(second, 'second-model'));
  const view = render(<ModelName model={first} />);
  await waitFor(() => expect(modelArtifact).toHaveBeenCalledWith(first));
  view.rerender(<ModelName model={second} />);
  expect(await screen.findByText('second-model')).toBeVisible();
  await act(async () => { finish(artifact(first, 'first-model')); });
  expect(screen.getByText('second-model')).toBeVisible();
  expect(screen.queryByText('first-model')).not.toBeInTheDocument();
});

it('deduplicates concurrent labels and releases a read after both consumers resolve', async () => {
  let finish!: (value: ModelArtifact) => void;
  vi.mocked(modelArtifact).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<><p><ModelName model={first} /></p><p><ModelName model={first} /></p></>);
  await waitFor(() => expect(modelArtifact).toHaveBeenCalledOnce());
  await act(async () => { finish(artifact(first, 'shared-label')); });
  expect(screen.getAllByText('shared-label')).toHaveLength(2);
  view.unmount();
  vi.mocked(modelArtifact).mockResolvedValueOnce(artifact(first, 'edited-label'));
  render(<ModelName model={first} />);
  expect(await screen.findByText('edited-label')).toBeVisible();
  expect(modelArtifact).toHaveBeenCalledTimes(2);
});

it('keeps browser preview and empty model labels available without native IPC', () => {
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
  const view = render(<ModelName model={first} />);
  expect(screen.getByText('a'.repeat(40))).toBeVisible();
  view.rerender(<ModelName empty="Choose a model" />);
  expect(screen.getByText('Choose a model')).toBeVisible();
  expect(modelArtifact).not.toHaveBeenCalled();
});

it('resolves dynamic option names independently, deduplicates paths and retains their order', async () => {
  let finish!: (value: ModelArtifact) => void;
  vi.mocked(modelArtifact).mockImplementation(path => path === first
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(artifact(second, 'second-model')));
  const { result, rerender } = renderHook(({ paths }) => useModelNames(paths), { initialProps: { paths: [first, second, first, '/synthetic/known.gguf'] } });
  expect(result.current).toEqual(['a'.repeat(40), 'b'.repeat(40), 'a'.repeat(40), 'known.gguf']);
  await waitFor(() => expect(result.current).toEqual(['a'.repeat(40), 'second-model', 'a'.repeat(40), 'known.gguf']));
  expect(modelArtifact).toHaveBeenCalledTimes(2);
  rerender({ paths: [second, '/synthetic/known.gguf', first] });
  expect(result.current).toEqual(['second-model', 'known.gguf', 'a'.repeat(40)]);
  await act(async () => { finish(artifact(first, 'first-model')); });
  expect(result.current).toEqual(['second-model', 'known.gguf', 'first-model']);
  expect(modelArtifact).toHaveBeenCalledTimes(2);
});

it('ignores removed option reads and leaves failed inspections as their original labels', async () => {
  let finish!: (value: ModelArtifact) => void;
  vi.mocked(modelArtifact).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  vi.mocked(modelArtifact).mockRejectedValueOnce(new Error('Synthetic unreadable model card'));
  const { result, rerender } = renderHook(({ paths }) => useModelNames(paths), { initialProps: { paths: [first] } });
  await waitFor(() => expect(modelArtifact).toHaveBeenCalledWith(first));
  rerender({ paths: [second] });
  await waitFor(() => expect(modelArtifact).toHaveBeenCalledWith(second));
  await act(async () => { finish(artifact(first, 'removed-model')); });
  expect(result.current).toEqual(['b'.repeat(40)]);
});

it('does not fetch dynamic option names in browser preview', () => {
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
  const { result } = renderHook(() => useModelNames([first, '/synthetic/known.gguf', '']));
  expect(result.current).toEqual(['a'.repeat(40), 'known.gguf', '']);
  expect(modelArtifact).not.toHaveBeenCalled();
});
