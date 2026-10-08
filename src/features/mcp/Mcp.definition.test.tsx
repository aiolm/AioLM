import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import { createTestStore } from '../../testing/appStore';
import { saveMcpApprovalPolicy } from './approvalPolicy';
import McpPanel from './Mcp';

vi.mock('../../shared/api/index', () => ({ mcpListServers: vi.fn(), mcpSaveServer: vi.fn(), mcpListTools: vi.fn(), mcpCallTool: vi.fn(), mcpCancelToolCall: vi.fn() }));
const servers = ['alpha', 'beta'].map(id => ({ id, name: `${id} tools`, command: 'synthetic-server', args: ['old'], enabled: true }));
const tool = (name = 'old_echo'): api.McpTool => ({ name, input_schema: { type: 'object' } });
const savedNotice = 'MCP server saved. Tool discovery starts only when you request it.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function openPanel() {
  render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
  fireEvent.click((await screen.findByText('alpha tools')).closest('button')!);
}
function save() { fireEvent.click(screen.getByRole('button', { name: 'Save server' })); }
function editArgs() { fireEvent.change(screen.getByLabelText('Arguments, one per line'), { target: { value: 'new' } }); }
async function discover(name = 'old_echo') {
  fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
  await screen.findByRole('button', { name: `Prepare call: ${name}` });
}
function review(name = 'old_echo') {
  fireEvent.click(screen.getByRole('button', { name: `Prepare call: ${name}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Review tool call' }));
}

describe('MCP saved definition ownership', () => {
  beforeEach(() => {
    localStorage.clear(); vi.resetAllMocks(); Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.mcpListServers).mockResolvedValue(servers);
    vi.mocked(api.mcpListTools).mockResolvedValue([tool()]);
    vi.mocked(api.mcpSaveServer).mockImplementation(async server => servers.map(existing => existing.id === server.id ? server : existing));
    vi.mocked(api.mcpCancelToolCall).mockResolvedValue(undefined);
  });
  afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); });

  it('discards metadata and the reviewed call when saved arguments change, then discovers the new definition', async () => {
    await openPanel(); await discover(); review(); editArgs(); save();
    await screen.findByText(savedNotice);
    expect(screen.queryByRole('button', { name: 'Prepare call: old_echo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and run once' })).not.toBeInTheDocument();
    vi.mocked(api.mcpListTools).mockResolvedValue([tool('new_echo')]);
    await discover('new_echo');
    expect(api.mcpListTools).toHaveBeenLastCalledWith('alpha');
    expect(api.mcpCallTool).not.toHaveBeenCalled();
  });

  it.each(['command', 'enabled'])('invalidates old metadata when the saved %s changes', async field => {
    await openPanel(); await discover();
    if (field === 'command') fireEvent.change(screen.getByLabelText('Executable / command'), { target: { value: 'new-synthetic-server' } });
    else fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    save(); await screen.findByText(savedNotice);
    expect(screen.queryByRole('button', { name: 'Prepare call: old_echo' })).not.toBeInTheDocument();
    if (field === 'enabled') expect(screen.getByRole('button', { name: 'Discover tools' })).toBeDisabled();
  });

  it('keeps metadata for an unchanged executable, arguments and enabled state when only the display name changes', async () => {
    await openPanel(); await discover(); review();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed alpha tools' } }); save();
    await screen.findByText(savedNotice);
    expect(screen.getByRole('button', { name: 'Prepare call: old_echo' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve and run once' })).toBeEnabled();
  });

  it('discards a pending old discovery when saving a changed definition fails, and allows rediscovery', async () => {
    const old = deferred<api.McpTool[]>();
    vi.mocked(api.mcpListTools).mockReturnValueOnce(old.promise);
    vi.mocked(api.mcpSaveServer).mockRejectedValueOnce(new Error('Synthetic save failure'));
    await openPanel(); fireEvent.click(screen.getByRole('button', { name: 'Discover tools' })); editArgs(); save();
    await screen.findByText('Synthetic save failure');
    await act(async () => old.resolve([tool()]));
    expect(screen.queryByRole('button', { name: 'Prepare call: old_echo' })).not.toBeInTheDocument();
    expect(screen.getByText('Synthetic save failure')).toBeInTheDocument();
    await discover();
    expect(screen.queryByText('Synthetic save failure')).not.toBeInTheDocument();
  });

  it('requires a fresh review after a changed definition even when the tool name matches a previous session approval', async () => {
    saveMcpApprovalPolicy('session'); vi.mocked(api.mcpCallTool).mockResolvedValue({ text: 'Synthetic receipt' });
    await openPanel(); await discover(); review();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and run once' }));
    await screen.findByLabelText('Tool result'); editArgs(); save(); await screen.findByText(savedNotice);
    expect(screen.queryByLabelText('Tool result')).not.toBeInTheDocument();
    await discover(); review();
    expect(screen.getByRole('button', { name: 'Approve and run once' })).toBeEnabled();
    expect(api.mcpCallTool).toHaveBeenCalledOnce();
  });

  it('requests cancellation for a call owned by the replaced definition and discards its late result', async () => {
    const call = deferred<unknown>(); vi.mocked(api.mcpCallTool).mockReturnValue(call.promise);
    await openPanel(); await discover(); review();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and run once' }));
    const callId = vi.mocked(api.mcpCallTool).mock.calls[0][3]; editArgs(); save();
    await waitFor(() => expect(api.mcpCancelToolCall).toHaveBeenCalledWith(callId));
    await act(async () => call.resolve({ text: 'Retired definition receipt' }));
    expect(screen.queryByLabelText('Tool result')).not.toBeInTheDocument();
    expect(getTaskSnapshot()[0].state).toBe('cancelled');
  });

  it.each(['success', 'failure'])('does not move a new selection back to the server whose save %s arrives late', async outcome => {
    const pending = deferred<api.McpServer[]>(); vi.mocked(api.mcpSaveServer).mockReturnValue(pending.promise);
    await openPanel(); editArgs(); save(); fireEvent.click(screen.getByText('beta tools').closest('button')!);
    await act(async () => outcome === 'success' ? pending.resolve([{ ...servers[0], args: ['new'] }, servers[1]]) : pending.reject(new Error('Retired save failure')));
    expect(screen.getByLabelText('Name')).toHaveValue('beta tools');
    expect(screen.getByLabelText('Arguments, one per line')).toHaveValue('old');
    expect(screen.getByText('beta tools').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByText('Retired save failure')).not.toBeInTheDocument();
    expect(screen.queryByText(savedNotice)).not.toBeInTheDocument();
  });

  it('preserves a fresh draft after an earlier save finishes and prevents duplicate writes during that save', async () => {
    const pending = deferred<api.McpServer[]>(); vi.mocked(api.mcpSaveServer).mockReturnValue(pending.promise);
    await openPanel(); save();
    expect(screen.getByRole('button', { name: 'Save server' })).toBeDisabled();
    save(); expect(api.mcpSaveServer).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await act(async () => pending.resolve(servers));
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Discover tools' })).not.toBeInTheDocument();
    expect(screen.queryByText(savedNotice)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save server' })).toBeEnabled();
  });

  it('holds discovery and approval while the unchanged definition is being saved, then restores the reviewed call', async () => {
    const pending = deferred<api.McpServer[]>(); vi.mocked(api.mcpSaveServer).mockReturnValue(pending.promise);
    await openPanel(); await discover(); review(); save();
    expect(screen.getByRole('button', { name: 'Discover tools' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Prepare call: old_echo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Review tool call' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve and run once' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save server' })).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Approve and run once' }));
    expect(api.mcpCallTool).not.toHaveBeenCalled();
    await act(async () => pending.resolve(servers));
    expect(screen.getByRole('button', { name: 'Approve and run once' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discover tools' })).toBeEnabled();
  });

  it('discards a successful old discovery and its completion notice after a changed definition is saved', async () => {
    const old = deferred<api.McpTool[]>(); vi.mocked(api.mcpListTools).mockReturnValueOnce(old.promise);
    await openPanel(); fireEvent.click(screen.getByRole('button', { name: 'Discover tools' })); editArgs(); save();
    await screen.findByText(savedNotice);
    await act(async () => old.resolve([tool()]));
    expect(screen.queryByRole('button', { name: 'Prepare call: old_echo' })).not.toBeInTheDocument();
    expect(screen.queryByText('Tool metadata loaded. No tool has been called.')).not.toBeInTheDocument();
    expect(screen.getByText(savedNotice)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover tools' })).toBeEnabled();
  });

  it('retains another server approval when only the current server definition changes', async () => {
    saveMcpApprovalPolicy('session'); vi.mocked(api.mcpCallTool).mockResolvedValue({ text: 'Synthetic receipt' });
    await openPanel();
    fireEvent.click(screen.getByText('beta tools').closest('button')!); await discover(); review();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and run once' })); await screen.findByLabelText('Tool result');
    fireEvent.click(screen.getByText('alpha tools').closest('button')!); editArgs(); save(); await screen.findByText(savedNotice);
    fireEvent.click(screen.getByText('beta tools').closest('button')!); await discover(); review();
    await waitFor(() => expect(api.mcpCallTool).toHaveBeenCalledTimes(2));
    expect(api.mcpCallTool).toHaveBeenLastCalledWith('beta', 'old_echo', {}, expect.any(String));
    expect(screen.queryByRole('button', { name: 'Approve and run once' })).not.toBeInTheDocument();
  });
});
