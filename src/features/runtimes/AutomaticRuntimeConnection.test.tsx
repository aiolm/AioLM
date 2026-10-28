import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/runtimeAuto';
import { pickRuntimePath } from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import AutomaticRuntimeConnection from './AutomaticRuntimeConnection';

vi.mock('../../shared/api/runtimeAuto', () => ({
  runtimeAutoDiscover: vi.fn(), runtimeAutoInspect: vi.fn(), runtimeAutoConnect: vi.fn(), runtimeAutoCancel: vi.fn(),
}));
vi.mock('../../shared/api/runtimeHelp', () => ({ pickRuntimePath: vi.fn() }));

const candidate: api.RuntimeCandidate = {
  id: 'synthetic-observed-entry', source: 'local_process', display_name: 'Example local service', entrypoint_path: '/synthetic/service',
  command: { program: '/synthetic/service', args: [], working_directory: '/synthetic', argv_source: 'observed' },
  endpoints: [{ host: '127.0.0.1', port: 43121 }], entrypoint_kind: 'native', state: 'needs_configuration',
  pid: 12345, process_identity: 'synthetic-identity', reasons: ['Observed loopback listener'],
};
const prepared: api.PreparedRuntimeConnection = {
  kind: 'attached', candidate, base_url: 'http://127.0.0.1:43121/v1', plan: 'opaque-preparation-token', detail: 'Synthetic endpoint metadata',
  models: [{ id: 'sample-model', name: 'Sample model' }],
};
const connected: api.AutomaticRuntimeResult = {
  engine_id: 'custom.synthetic', runtime_id: 'example-connection', display_name: candidate.display_name,
  model_path: '/synthetic/app/connection-model.json', mode: 'attached', checks: ['JSON response checked', 'Complete streaming response checked'],
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const task of getTaskSnapshot()) removeTask(task.id);
  vi.mocked(api.runtimeAutoDiscover).mockResolvedValue({ candidates: [candidate], warnings: [], truncated: false });
  vi.mocked(api.runtimeAutoInspect).mockResolvedValue(prepared);
  vi.mocked(api.runtimeAutoConnect).mockResolvedValue(connected);
  vi.mocked(api.runtimeAutoCancel).mockResolvedValue(true);
  vi.mocked(pickRuntimePath).mockResolvedValue('/synthetic/installation');
});

function show(props: Partial<Parameters<typeof AutomaticRuntimeConnection>[0]> = {}) {
  const onConnected = props.onConnected ?? vi.fn();
  return { onConnected, ...render(<I18nProvider initialLocale="en"><AutomaticRuntimeConnection locked={false} onConnected={onConnected} {...props} /></I18nProvider>) };
}
async function find() {
  fireEvent.click(screen.getByRole('button', { name: 'Find automatically' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
}

it('waits for explicit discovery and exposes no IDs, executable or setup-file fields', () => {
  show();
  expect(api.runtimeAutoDiscover).not.toHaveBeenCalled();
  expect(api.runtimeAutoInspect).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByText(/do not need to know which language/)).toBeInTheDocument();
  expect(screen.getByText(/do not need to pick an executable or configuration file/)).toBeInTheDocument();
});

it('inspects a sole discovery automatically, then waits for actual verification before claiming success', async () => {
  let resolve!: (result: api.AutomaticRuntimeResult) => void;
  vi.mocked(api.runtimeAutoConnect).mockReturnValue(new Promise(done => { resolve = done; }));
  const { onConnected } = show();
  await find();
  expect(api.runtimeAutoInspect).toHaveBeenCalledExactlyOnceWith(candidate);
  expect(screen.queryByText('Connection verified.')).not.toBeInTheDocument();
  expect(screen.getByText(/Disconnecting in AioLM leaves the original server running/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(api.runtimeAutoConnect).toHaveBeenCalledExactlyOnceWith(prepared, 'sample-model');
  expect(screen.getByText('Testing model responses and streaming…')).toBeInTheDocument();
  expect(onConnected).not.toHaveBeenCalled();
  await act(async () => resolve(connected));
  expect(onConnected).toHaveBeenCalledExactlyOnceWith(connected);
  expect(screen.getByText('Connection verified.')).toBeInTheDocument();
  expect(screen.getByText(/you do not need to create a settings file/)).toBeInTheDocument();
  expect(screen.getAllByText(/does not verify image, audio, video, tool use, or response quality/).length).toBeGreaterThan(0);
});

it('lets users select among discoveries without preferring names or interpreting their languages', async () => {
  const second = { ...candidate, id: 'synthetic-command', display_name: 'Another local service', entrypoint_kind: 'interpreter' as const };
  vi.mocked(api.runtimeAutoDiscover).mockResolvedValue({ candidates: [candidate, second], warnings: [], truncated: false });
  vi.mocked(api.runtimeAutoInspect).mockResolvedValue({ ...prepared, candidate: second, kind: 'managed' });
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Find automatically' }));
  await screen.findByRole('radio', { name: /Another local service/ });
  expect(api.runtimeAutoInspect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: /Another local service/ }));
  await waitFor(() => expect(api.runtimeAutoInspect).toHaveBeenCalledExactlyOnceWith(second));
  expect(await screen.findByText(/AioLM starts and stops this engine/)).toBeInTheDocument();
});

it('uses one installation-folder selection as the discovery fallback', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Choose installation folder' }));
  await waitFor(() => expect(api.runtimeAutoDiscover).toHaveBeenCalledExactlyOnceWith('/synthetic/installation'));
  expect(pickRuntimePath).toHaveBeenCalledExactlyOnceWith('folder');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
});

it('does not start discovery when the folder dialog is dismissed', async () => {
  vi.mocked(pickRuntimePath).mockResolvedValue(null);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Choose installation folder' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Find automatically' })).toBeEnabled());
  expect(api.runtimeAutoDiscover).not.toHaveBeenCalled();
  expect(screen.queryByText('Connection verified.')).not.toBeInTheDocument();
});

it('keeps empty and truncated discovery honest and offers the folder fallback', async () => {
  vi.mocked(api.runtimeAutoDiscover).mockResolvedValue({ candidates: [], warnings: ['Some process metadata was unavailable.'], truncated: true });
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Find automatically' }));
  expect(await screen.findByText(/No connection was found/)).toBeInTheDocument();
  expect(screen.getByText(/Discovery reached its limit/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose installation folder' })).toBeEnabled();
  expect(api.runtimeAutoInspect).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
});

it('shows an inspection failure and does not offer an unverified connection', async () => {
  vi.mocked(api.runtimeAutoInspect).mockRejectedValue(new Error('No supported API was observed.'));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Find automatically' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The connection could not be verified.');
  expect(screen.getByRole('alert')).toHaveTextContent('No supported API was observed.');
  expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  expect(api.runtimeAutoConnect).not.toHaveBeenCalled();
});

it('requires a choice when several models are available', async () => {
  vi.mocked(api.runtimeAutoInspect).mockResolvedValue({ ...prepared, models: [...prepared.models, { id: 'other-model', name: 'Other model' }] });
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Find automatically' }));
  const model = await screen.findByRole('combobox', { name: 'Model to use' });
  await waitFor(() => expect(model).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  fireEvent.click(model);
  fireEvent.click(screen.getByRole('option', { name: 'Other model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(api.runtimeAutoConnect).toHaveBeenCalledWith(expect.anything(), 'other-model'));
});

it('blocks connect if no model can be selected', async () => {
  vi.mocked(api.runtimeAutoInspect).mockResolvedValue({ ...prepared, models: [] });
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Find automatically' }));
  expect(await screen.findByText(/No model is available to select/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
});

it('rejects duplicate activation before React renders its busy state', async () => {
  let resolve!: (result: api.AutomaticRuntimeResult) => void;
  vi.mocked(api.runtimeAutoConnect).mockReturnValue(new Promise(done => { resolve = done; }));
  show();
  await find();
  const button = screen.getByRole('button', { name: 'Connect' });
  fireEvent.click(button); fireEvent.click(button);
  expect(api.runtimeAutoConnect).toHaveBeenCalledTimes(1);
  await act(async () => resolve(connected));
});

it('keeps a failed model verification out of the connected state and allows a retry', async () => {
  vi.mocked(api.runtimeAutoConnect).mockRejectedValueOnce(new Error('The stream ended without a completion event.'));
  const { onConnected } = show();
  await find();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The stream ended without a completion event.');
  expect(screen.queryByText('Connection verified.')).not.toBeInTheDocument();
  expect(onConnected).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText('Connection verified.')).toBeInTheDocument();
  expect(onConnected).toHaveBeenCalledExactlyOnceWith(connected);
});

it('cancels once and ignores a late verification result', async () => {
  let resolve!: (result: api.AutomaticRuntimeResult) => void;
  vi.mocked(api.runtimeAutoConnect).mockReturnValue(new Promise(done => { resolve = done; }));
  const { onConnected } = show();
  await find();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.runtimeAutoCancel).toHaveBeenCalledTimes(1);
  await act(async () => resolve(connected));
  expect(onConnected).not.toHaveBeenCalled();
  expect(screen.queryByText('Connection verified.')).not.toBeInTheDocument();
  expect(screen.getByText('The operation was cancelled.')).toBeInTheDocument();
});

it('cancels active work on unmount without publishing a late connection', async () => {
  let resolve!: (result: api.AutomaticRuntimeResult) => void;
  vi.mocked(api.runtimeAutoConnect).mockReturnValue(new Promise(done => { resolve = done; }));
  const onBusyChange = vi.fn();
  const { onConnected, unmount } = show({ onBusyChange });
  await find();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  unmount();
  expect(api.runtimeAutoCancel).toHaveBeenCalledTimes(1);
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  await act(async () => resolve(connected));
  expect(onConnected).not.toHaveBeenCalled();
});

it('keeps a pending operation alive when the parent replaces a callback', async () => {
  let resolve!: (result: api.AutomaticRuntimeResult) => void;
  vi.mocked(api.runtimeAutoConnect).mockReturnValue(new Promise(done => { resolve = done; }));
  const { rerender } = show();
  await find();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  const updated = vi.fn();
  rerender(<I18nProvider initialLocale="en"><AutomaticRuntimeConnection locked={false} onConnected={updated} onBusyChange={vi.fn()} /></I18nProvider>);
  expect(api.runtimeAutoCancel).not.toHaveBeenCalled();
  await act(async () => resolve(connected));
  expect(updated).toHaveBeenCalledExactlyOnceWith(connected);
});

it('blocks all launch actions while the parent has locked runtime changes', () => {
  show({ locked: true });
  expect(screen.getByRole('button', { name: 'Find automatically' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Choose installation folder' })).toBeDisabled();
  expect(api.runtimeAutoDiscover).not.toHaveBeenCalled();
});
