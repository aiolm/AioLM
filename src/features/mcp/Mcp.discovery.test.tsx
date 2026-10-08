import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import McpPanel from './Mcp';

vi.mock('../../shared/api/index', () => ({ mcpListServers: vi.fn(), mcpListTools: vi.fn() }));

const servers = ['alpha', 'beta'].map(id => ({ id, name: `${id} tools`, command: 'synthetic-server', args: [], enabled: true }));
const metadata = (name: string): api.McpTool[] => [{ name, input_schema: { type: 'object' } }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function openPanel() {
  render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
  await screen.findByText('alpha tools');
}
function select(id: string) { fireEvent.click(screen.getByText(`${id} tools`).closest('button')!); }
function discover() { fireEvent.click(screen.getByRole('button', { name: 'Discover tools' })); }

describe('MCP discovery selection ownership', () => {
  beforeEach(() => {
    localStorage.clear(); vi.resetAllMocks(); Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.mcpListServers).mockResolvedValue(servers);
  });

  it('allows discovery for the new server immediately and discards late metadata from the previous server', async () => {
    const first = deferred<api.McpTool[]>(); vi.mocked(api.mcpListTools).mockReturnValueOnce(first.promise);
    await openPanel(); select('alpha'); discover(); select('beta');
    expect(screen.getByRole('button', { name: 'Discover tools' })).toBeEnabled();
    await act(async () => first.resolve(metadata('alpha_echo')));
    expect(screen.queryByRole('button', { name: 'Prepare call: alpha_echo' })).not.toBeInTheDocument();
    expect(screen.queryByText('Tool metadata loaded. No tool has been called.')).not.toBeInTheDocument();
  });

  it('keeps the newer search pending when an older request finishes', async () => {
    const first = deferred<api.McpTool[]>(); const second = deferred<api.McpTool[]>();
    vi.mocked(api.mcpListTools).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await openPanel(); select('alpha'); discover(); select('beta'); discover();
    await act(async () => first.resolve(metadata('alpha_echo')));
    expect(screen.getByRole('button', { name: 'Discovering' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Prepare call: alpha_echo' })).not.toBeInTheDocument();
    await act(async () => second.resolve(metadata('beta_echo')));
    expect(await screen.findByRole('button', { name: 'Prepare call: beta_echo' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discover tools' })).toBeEnabled();
    expect(api.mcpListTools).toHaveBeenNthCalledWith(2, 'beta');
  });

  it('does not replace current metadata or feedback with a previous server failure', async () => {
    const first = deferred<api.McpTool[]>();
    vi.mocked(api.mcpListTools).mockReturnValueOnce(first.promise).mockResolvedValueOnce(metadata('beta_echo'));
    await openPanel(); select('alpha'); discover(); select('beta'); discover();
    await screen.findByRole('button', { name: 'Prepare call: beta_echo' });
    await act(async () => first.reject(new Error('Retired alpha discovery failure')));
    expect(screen.queryByText('Retired alpha discovery failure')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare call: beta_echo' })).toBeEnabled();
    expect(screen.getByText('Tool metadata loaded. No tool has been called.')).toBeInTheDocument();
  });

  it.each(['success', 'failure'])('leaves a new server draft clear after a retired discovery %s', async outcome => {
    const first = deferred<api.McpTool[]>(); vi.mocked(api.mcpListTools).mockReturnValueOnce(first.promise);
    await openPanel(); select('alpha'); discover(); fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await act(async () => outcome === 'success' ? first.resolve(metadata('alpha_echo')) : first.reject(new Error('Retired draft discovery failure')));
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.queryByText('Tool metadata loaded. No tool has been called.')).not.toBeInTheDocument();
    expect(screen.queryByText('Retired draft discovery failure')).not.toBeInTheDocument();
  });

  it('does not revive a previous request after selecting the same server again', async () => {
    const first = deferred<api.McpTool[]>(); vi.mocked(api.mcpListTools).mockReturnValueOnce(first.promise);
    await openPanel(); select('alpha'); discover(); select('beta'); select('alpha');
    await act(async () => first.resolve(metadata('retired_alpha_echo')));
    expect(screen.queryByRole('button', { name: 'Prepare call: retired_alpha_echo' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover tools' })).toBeEnabled();
  });

  it('reports a current discovery failure and allows a successful retry', async () => {
    vi.mocked(api.mcpListTools).mockRejectedValueOnce(new Error('Current discovery failure')).mockResolvedValueOnce(metadata('alpha_echo'));
    await openPanel(); select('alpha'); discover();
    await screen.findByText('Current discovery failure');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discover tools' })).toBeEnabled());
    discover();
    expect(await screen.findByRole('button', { name: 'Prepare call: alpha_echo' })).toBeEnabled();
    expect(screen.queryByText('Current discovery failure')).not.toBeInTheDocument();
  });
});
