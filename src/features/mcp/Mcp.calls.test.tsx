import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import { ActivePanelContext } from '../../shared/ui/PanelFeedback';
import { TaskCancellationProvider } from '../../shared/ui/TaskCancellation';
import TaskStrip from '../../shared/ui/TaskStrip';
import { createTestStore } from '../../testing/appStore';
import McpPanel from './Mcp';
import { saveMcpApprovalPolicy } from './approvalPolicy';

vi.mock('../../shared/api/index', () => ({
  mcpListServers: vi.fn(), mcpListTools: vi.fn(), mcpCallTool: vi.fn(), mcpCancelToolCall: vi.fn(),
}));

const servers = ['alpha', 'beta'].map(id => ({ id, name: `${id} tools`, command: 'synthetic-engine', args: [], enabled: true }));
const tool = { name: 'echo', input_schema: { type: 'object' } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Surface({ active = true }: { active?: boolean }) {
  return <I18nProvider initialLocale="en"><TaskCancellationProvider>
    <section hidden={!active}><ActivePanelContext.Provider value={active}><McpPanel store={createTestStore()} /></ActivePanelContext.Provider></section>
    <TaskStrip />
  </TaskCancellationProvider></I18nProvider>;
}

async function startCall() {
  fireEvent.click((await screen.findByText('alpha tools')).closest('button')!);
  fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare call: echo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review tool call' }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve and run once' }));
  await waitFor(() => expect(api.mcpCallTool).toHaveBeenCalledOnce());
}

describe('MCP manual call ownership', () => {
  beforeEach(() => {
    localStorage.clear(); vi.resetAllMocks(); Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.mcpListServers).mockResolvedValue(servers);
    vi.mocked(api.mcpListTools).mockResolvedValue([tool]);
    vi.mocked(api.mcpCancelToolCall).mockResolvedValue(undefined);
  });
  afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); });

  it('keeps one cancellable task through the native approval and RPC wait, and discards a late cancelled result', async () => {
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    render(<Surface />); await startCall();
    const id = vi.mocked(api.mcpCallTool).mock.calls[0][3];
    expect(id).toEqual(expect.any(String));
    expect(getTaskSnapshot()).toEqual([expect.objectContaining({ state: 'running', interruptible: true, label: expect.stringContaining('alpha tools') })]);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.mcpCancelToolCall).toHaveBeenCalledWith(id));
    expect(getTaskSnapshot()[0].state).toBe('cancelling');
    await act(async () => call.resolve({ text: 'Late cancelled receipt' }));
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
    expect(screen.queryByLabelText('Tool result')).not.toBeInTheDocument();
    expect(api.mcpCancelToolCall).toHaveBeenCalledOnce();
  });

  it('retains global cancellation when navigation hides the MCP panel', async () => {
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    const view = render(<Surface />); await startCall();
    view.rerender(<Surface active={false} />);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.mcpCancelToolCall).toHaveBeenCalledOnce());
    await act(async () => call.reject(new Error('MCP tool call cancelled')));
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
  });

  it('cancels the owned call on server selection and does not show its result in the new server', async () => {
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    render(<Surface />); await startCall();
    fireEvent.click(screen.getByText('beta tools').closest('button')!);
    await waitFor(() => expect(api.mcpCancelToolCall).toHaveBeenCalledOnce());
    await act(async () => call.resolve({ text: 'Alpha private result' }));
    expect(screen.queryByLabelText('Tool result')).not.toBeInTheDocument();
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
  });

  it('requests cancellation on actual unmount and settles the owned task without publishing a result', async () => {
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    const view = render(<Surface />); await startCall(); view.unmount();
    await waitFor(() => expect(api.mcpCancelToolCall).toHaveBeenCalledOnce());
    await act(async () => call.resolve({ text: 'Unmounted receipt' }));
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
  });

  it('keeps cancellation retryable after a transport failure while the original call is pending', async () => {
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    vi.mocked(api.mcpCancelToolCall).mockRejectedValueOnce(new Error('Synthetic cancel transport failure'));
    render(<Surface />); await startCall();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByText('Synthetic cancel transport failure', { exact: true });
    expect(getTaskSnapshot()[0].state).toBe('running');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.mcpCancelToolCall).toHaveBeenCalledTimes(2));
    await act(async () => call.reject(new Error('MCP tool call cancelled')));
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
  });

  it('does not revive a settled task when the cancellation response fails late', async () => {
    const call = deferred<unknown>(); const cancellation = deferred<void>();
    vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    vi.mocked(api.mcpCancelToolCall).mockReturnValue(cancellation.promise);
    render(<Surface />); await startCall();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => call.reject(new Error('MCP tool call cancelled')));
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
    await act(async () => cancellation.reject(new Error('Late synthetic cancellation response')));
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
    expect(screen.queryByText('Late synthetic cancellation response')).not.toBeInTheDocument();
  });

  it('preserves an ordinary approved result and completes its task', async () => {
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    render(<Surface />); await startCall();
    await act(async () => call.resolve({ text: 'Approved receipt' }));
    expect(await screen.findByLabelText('Tool result')).toHaveTextContent('Approved receipt');
    expect(getTaskSnapshot()[0].state).toBe('completed');
    expect(api.mcpCancelToolCall).not.toHaveBeenCalled();
  });

  it('does not remember a cancelled call as a session approval', async () => {
    saveMcpApprovalPolicy('session');
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    render(<Surface />); await startCall();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.mcpCancelToolCall).toHaveBeenCalledOnce());
    await act(async () => call.resolve({ text: 'Late cancelled receipt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review tool call' }));
    expect(screen.getByRole('button', { name: 'Approve and run once' })).toBeInTheDocument();
    expect(api.mcpCallTool).toHaveBeenCalledOnce();
  });
});
