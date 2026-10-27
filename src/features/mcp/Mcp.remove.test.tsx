import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import { defaultPreferences, savePreferences } from '../../shared/config/preferences';
import McpPanel from './Mcp';

vi.mock('../../shared/api/index', () => ({
  mcpListServers: vi.fn(), mcpRemoveServer: vi.fn(), mcpSaveServer: vi.fn(),
  mcpListTools: vi.fn(), mcpCallTool: vi.fn(), mcpCancelToolCall: vi.fn(),
}));
const servers: api.McpServer[] = ['alpha', 'beta'].map(id => ({
  id, name: `${id} tools`, command: 'synthetic-server', args: ['original'], enabled: true,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const select = (id: string) => fireEvent.click(screen.getByText(`${id} tools`).closest('button')!);
async function openPanel(selected = 'alpha') {
  render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
  await screen.findByText('alpha tools'); select(selected);
}
async function confirmAlphaRemoval() {
  fireEvent.click(screen.getByRole('button', { name: 'Remove alpha tools' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete MCP server?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete server' }));
  await waitFor(() => expect(api.mcpRemoveServer).toHaveBeenCalledWith('alpha'));
  return dialog;
}

describe('MCP removal ownership', () => {
  beforeEach(() => {
    localStorage.clear(); vi.resetAllMocks(); Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.mcpListServers).mockResolvedValue(servers);
    vi.mocked(api.mcpListTools).mockResolvedValue([{ name: 'beta_echo', input_schema: { type: 'object' } }]);
    vi.mocked(api.mcpCancelToolCall).mockResolvedValue(undefined);
  });

  it('keeps a later server selection and draft after the earlier selected server is removed', async () => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel();
    const dialog = await confirmAlphaRemoval();
    // Dismissing the still-open confirmation does not cancel an issued native removal.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    select('beta');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep beta draft' } });
    await act(async () => pending.resolve([servers[1]]));
    expect(screen.queryByText('alpha tools')).not.toBeInTheDocument();
    expect(screen.getByText('beta tools').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Name')).toHaveValue('Keep beta draft');
    expect(screen.getByLabelText('Arguments, one per line')).toHaveValue('original');
    expect(api.mcpSaveServer).not.toHaveBeenCalled();
  });

  it('does not issue duplicate removals while confirmation is already pending', async () => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel();
    const dialog = await confirmAlphaRemoval();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete server' }));
    // Settle all issued shared promises before asserting, including a possible duplicate.
    await act(async () => pending.resolve([servers[1]]));
    expect(api.mcpRemoveServer).toHaveBeenCalledTimes(1);
  });

  it('clears the still-current removed server while preserving the other definition', async () => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel(); await confirmAlphaRemoval();
    await act(async () => pending.resolve([servers[1]]));
    expect(screen.queryByText('alpha tools')).not.toBeInTheDocument();
    expect(screen.getByText('beta tools')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Arguments, one per line')).toHaveValue('');
    expect(api.mcpSaveServer).not.toHaveBeenCalled();
  });

  it('retains the current server and draft after its removal fails', async () => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep alpha draft' } });
    await confirmAlphaRemoval();
    await act(async () => pending.reject(new Error('Synthetic current removal failure')));
    expect(await screen.findByText('Synthetic current removal failure')).toBeVisible();
    expect(screen.getByText('alpha tools').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Name')).toHaveValue('Keep alpha draft');
    expect(api.mcpSaveServer).not.toHaveBeenCalled();
  });

  it('preserves a later beta draft and successful discovery feedback after alpha removal rejects', async () => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel();
    const dialog = await confirmAlphaRemoval();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    select('beta');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep beta draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
    await screen.findByRole('button', { name: 'Prepare call: beta_echo' });
    expect(screen.getByText('Tool descriptions loaded. No tools were run.')).toBeVisible();
    await act(async () => pending.reject(new Error('Retired alpha removal failure')));
    expect(screen.getByText('beta tools').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Name')).toHaveValue('Keep beta draft');
    expect(screen.getByRole('button', { name: 'Prepare call: beta_echo' })).toBeEnabled();
    expect(screen.getByText('Tool descriptions loaded. No tools were run.')).toBeVisible();
    expect(screen.queryByText('Retired alpha removal failure')).not.toBeInTheDocument();
    expect(screen.getByText('alpha tools')).toBeVisible();
  });

  it('keeps a newer beta removal confirmation open when alpha removal finishes', async () => {
    const alpha = deferred<api.McpServer[]>(); const beta = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockImplementation(id => id === 'alpha' ? alpha.promise : beta.promise);
    await openPanel();
    const firstDialog = await confirmAlphaRemoval();
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Cancel' }));
    select('beta');
    fireEvent.click(screen.getByRole('button', { name: 'Remove beta tools' }));
    const nextDialog = await screen.findByRole('dialog', { name: 'Delete MCP server?' });
    expect(within(nextDialog).getByText('Remove the saved connection to beta tools? The server program and its files are kept.')).toBeVisible();
    await act(async () => alpha.resolve([servers[1]]));
    expect(nextDialog).toHaveAttribute('open');
    expect(within(nextDialog).getByText('Remove the saved connection to beta tools? The server program and its files are kept.')).toBeVisible();
    expect(vi.mocked(api.mcpRemoveServer).mock.calls.map(([id]) => id)).toEqual(['alpha']);
    fireEvent.click(within(nextDialog).getByRole('button', { name: 'Delete server' }));
    await waitFor(() => expect(api.mcpRemoveServer).toHaveBeenCalledWith('beta'));
    await act(async () => beta.resolve([]));
    expect(screen.queryByText('alpha tools')).not.toBeInTheDocument();
    expect(screen.queryByText('beta tools')).not.toBeInTheDocument();
  });

  it('does not duplicate removal when destructive confirmations are explicitly disabled', async () => {
    const preferences = defaultPreferences(); preferences.advanced.confirmDestructiveActions = false;
    savePreferences(preferences);
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel();
    const remove = screen.getByRole('button', { name: 'Remove alpha tools' });
    fireEvent.click(remove); fireEvent.click(remove);
    expect(screen.queryByRole('dialog', { name: 'Delete MCP server?' })).not.toBeInTheDocument();
    await act(async () => pending.resolve([servers[1]]));
    expect(api.mcpRemoveServer).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('alpha tools')).not.toBeInTheDocument();
    expect(screen.getByText('beta tools')).toBeVisible();
  });

  it('clears the actually removed current target after selection moved away and back', async () => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel();
    const dialog = await confirmAlphaRemoval();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    select('beta'); select('alpha');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New alpha draft' } });
    await act(async () => pending.resolve([servers[1]]));
    expect(screen.queryByText('alpha tools')).not.toBeInTheDocument();
    expect(screen.getByText('beta tools')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Arguments, one per line')).toHaveValue('');
    expect(api.mcpSaveServer).not.toHaveBeenCalled();
  });

  it('prevents a reopened confirmation from duplicating a pending removal and retires it when that target is removed', async () => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel();
    const previousDialog = await confirmAlphaRemoval();
    fireEvent.click(within(previousDialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove alpha tools' }));
    const reopened = await screen.findByRole('dialog', { name: 'Delete MCP server?' });
    const remove = within(reopened).getByRole('button', { name: 'Delete server' });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    await act(async () => pending.resolve([servers[1]]));
    expect(api.mcpRemoveServer).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('alpha tools')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Delete MCP server?' })).not.toBeInTheDocument();
    expect(screen.getByText('beta tools')).toBeVisible();
  });

  it.each(['success', 'failure'] as const)('preserves newer feedback in the same selected beta view after unrelated alpha removal %s', async outcome => {
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    await openPanel('beta');
    const dialog = await confirmAlphaRemoval();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep beta draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
    await screen.findByRole('button', { name: 'Prepare call: beta_echo' });
    await act(async () => outcome === 'success' ? pending.resolve([servers[1]]) : pending.reject(new Error('Retired unrelated alpha failure')));
    expect(screen.getByText('beta tools').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Name')).toHaveValue('Keep beta draft');
    expect(screen.getByText('Tool descriptions loaded. No tools were run.')).toBeVisible();
    expect(screen.queryByText('Retired unrelated alpha failure')).not.toBeInTheDocument();
    expect(screen.queryByText('MCP server removed.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare call: beta_echo' })).toBeEnabled();
  });

  it('does not restore old removal-button focus after dismissal and a newer editor focus', async () => {
    const frames: FrameRequestCallback[] = [];
    const animation = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    const flushFrames = () => act(() => { for (const callback of frames.splice(0)) callback(0); });
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    try {
      await openPanel();
      const dialog = await confirmAlphaRemoval();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      // Finish the ordinary dialog-close focus restoration before choosing new focus.
      flushFrames();
      select('beta');
      const input = screen.getByLabelText('Name'); input.focus();
      expect(input).toHaveFocus();
      await act(async () => pending.reject(new Error('Retired alpha focus failure')));
      flushFrames();
      expect(input).toHaveFocus();
      expect(input).toHaveValue('beta tools');
      expect(screen.getByText('beta tools').closest('button')).toHaveAttribute('aria-current', 'true');
    } finally { animation.mockRestore(); }
  });
  function holdAnimationFrames() {
    let nextId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id); });
    return {
      pending: () => callbacks.size,
      flush: () => act(() => {
        // Work scheduled during a frame belongs to the next frame, as in a
        // browser. A callback may cancel a later callback in this same frame.
        for (const id of [...callbacks.keys()]) {
          const callback = callbacks.get(id);
          if (!callback) continue;
          callbacks.delete(id);
          callback(0);
        }
      }),
      restore: () => { callbacks.clear(); cancel.mockRestore(); request.mockRestore(); },
    };
  }

  it('keeps newer beta editor focus when a failed-removal close frame runs later', async () => {
    const frames = holdAnimationFrames();
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    try {
      await openPanel();
      const dialog = await confirmAlphaRemoval();
      frames.flush(); // ordinary opening focus, before removal settles
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      await act(async () => pending.reject(new Error('Synthetic failed-removal focus boundary')));
      expect(dialog).not.toHaveAttribute('open');
      expect(screen.getByText('Synthetic failed-removal focus boundary')).toBeVisible();
      expect(frames.pending()).toBeGreaterThan(0); // hold the actual close callback
      select('beta');
      const input = screen.getByLabelText('Name');
      fireEvent.change(input, { target: { value: 'Keep beta focus and draft' } });
      input.focus();
      expect(input).toHaveFocus();
      frames.flush();
      expect(input).toHaveFocus();
      expect(input).toHaveValue('Keep beta focus and draft');
      expect(screen.getByText('beta tools').closest('button')).toHaveAttribute('aria-current', 'true');
      expect(screen.getByRole('button', { name: 'Remove alpha tools' })).toBeVisible();
      expect(api.mcpRemoveServer).toHaveBeenCalledTimes(1);
      expect(api.mcpRemoveServer).toHaveBeenCalledWith('alpha');
      expect(api.mcpSaveServer).not.toHaveBeenCalled();
    } finally { frames.restore(); }
  });

  it('keeps newer editor focus when an ordinary Cancel close frame runs later', async () => {
    const frames = holdAnimationFrames();
    try {
      await openPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Remove alpha tools' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete MCP server?' });
      frames.flush();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(dialog).not.toHaveAttribute('open');
      expect(frames.pending()).toBeGreaterThan(0);
      select('beta');
      const input = screen.getByLabelText('Name'); input.focus();
      frames.flush();
      expect(input).toHaveFocus();
      expect(input).toHaveValue('beta tools');
      expect(api.mcpRemoveServer).not.toHaveBeenCalled();
      expect(api.mcpSaveServer).not.toHaveBeenCalled();
    } finally { frames.restore(); }
  });

  it.each(['cancel', 'failed-removal'] as const)('retains normal %s focus restoration without a newer owner', async outcome => {
    const frames = holdAnimationFrames();
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    try {
      await openPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Remove alpha tools' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete MCP server?' });
      frames.flush();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      if (outcome === 'cancel') {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      } else {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete server' }));
        await waitFor(() => expect(api.mcpRemoveServer).toHaveBeenCalledWith('alpha'));
        await act(async () => pending.reject(new Error('Synthetic ordinary removal failure')));
        expect(screen.getByText('Synthetic ordinary removal failure')).toBeVisible();
      }
      expect(dialog).not.toHaveAttribute('open');
      frames.flush();
      expect(screen.getByRole('button', { name: 'Remove alpha tools' })).toHaveFocus();
      expect(screen.getByText('alpha tools').closest('button')).toHaveAttribute('aria-current', 'true');
      expect(screen.getByLabelText('Name')).toHaveValue('alpha tools');
      expect(api.mcpRemoveServer).toHaveBeenCalledTimes(outcome === 'cancel' ? 0 : 1);
      expect(api.mcpSaveServer).not.toHaveBeenCalled();
    } finally { frames.restore(); }
  });

  it('leaves a newer beta confirmation and its focus owned by that dialog', async () => {
    const frames = holdAnimationFrames();
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    try {
      await openPanel();
      await confirmAlphaRemoval();
      frames.flush();
      await act(async () => pending.reject(new Error('Synthetic alpha removal failure before beta confirmation')));
      // Do not flush the old alpha close callback before opening beta.
      select('beta');
      fireEvent.click(screen.getByRole('button', { name: 'Remove beta tools' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete MCP server?' });
      frames.flush();
      expect(dialog).toHaveAttribute('open');
      expect(within(dialog).getByText('Remove the saved connection to beta tools? The server program and its files are kept.')).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(api.mcpRemoveServer).toHaveBeenCalledTimes(1);
      expect(api.mcpRemoveServer).toHaveBeenCalledWith('alpha');
      expect(api.mcpSaveServer).not.toHaveBeenCalled();
    } finally { frames.restore(); }
  });

  it('discards a queued failed-removal close callback after actual unmount', async () => {
    const frames = holdAnimationFrames();
    const pending = deferred<api.McpServer[]>();
    vi.mocked(api.mcpRemoveServer).mockReturnValue(pending.promise);
    try {
      const mounted = render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
      await screen.findByText('alpha tools'); select('alpha');
      await confirmAlphaRemoval(); frames.flush();
      await act(async () => pending.reject(new Error('Synthetic failure before actual unmount')));
      expect(frames.pending()).toBeGreaterThan(0);
      mounted.unmount();
      render(<input aria-label="Later independent editor" defaultValue="Keep outside focus" />);
      const input = screen.getByLabelText('Later independent editor'); input.focus();
      frames.flush();
      expect(input).toHaveFocus();
      expect(input).toHaveValue('Keep outside focus');
      expect(screen.queryByRole('button', { name: 'Remove alpha tools' })).not.toBeInTheDocument();
      expect(api.mcpRemoveServer).toHaveBeenCalledTimes(1);
      expect(api.mcpRemoveServer).toHaveBeenCalledWith('alpha');
      expect(api.mcpSaveServer).not.toHaveBeenCalled();
    } finally { frames.restore(); }
  });
});
