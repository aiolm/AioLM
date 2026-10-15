import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { useChatMcpTools } from './useChatMcpTools';

vi.mock('../../shared/api/index', () => ({ mcpListServers: vi.fn(), mcpListTools: vi.fn() }));
const tools: api.McpTool[] = [{ name: 'lookup', input_schema: {} }, { name: 'summarize', input_schema: {} }];

function setup() {
  return renderHook(() => useChatMcpTools());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.mcpListServers).mockResolvedValue([{ id: 'catalog', name: 'Catalog', enabled: true, command: 'synthetic', args: [] }]);
  vi.mocked(api.mcpListTools).mockResolvedValue(tools);
});

describe('MCP catalog refresh selection', () => {
  it('keeps deselected tools off and does not select newly discovered tools on refresh', async () => {
    const { result } = setup();
    await act(async () => { await result.current.refreshMcpTools(); });
    expect(result.current.selectedMcpTools).toEqual(['catalog:lookup', 'catalog:summarize']);
    act(() => result.current.toggleMcpTool('catalog:lookup'));
    vi.mocked(api.mcpListTools).mockResolvedValue([...tools, { name: 'new-tool', input_schema: {} }]);
    await act(async () => { await result.current.refreshMcpTools(); });
    expect(result.current.selectedMcpTools).toEqual(['catalog:summarize']);
    expect(result.current.mcpDefinitions).toHaveLength(1);
    expect([...result.current.mcpEntryByFunctionName.values()].map(entry => entry.tool.name)).toEqual(['summarize']);
  });

  it.each([{ selected: ['catalog:lookup'] }, { selected: [] }])('honors explicit project selection $selected before the first catalog load', async ({ selected }) => {
    const { result } = setup();
    act(() => result.current.setSelectedMcpTools(selected));
    await act(async () => { await result.current.refreshMcpTools(); });
    expect(result.current.selectedMcpTools).toEqual(selected);
    expect(result.current.mcpDefinitions).toHaveLength(selected.length);
  });

  it('retains selections changed while a refresh is waiting for the server', async () => {
    const { result } = setup();
    await act(async () => { await result.current.refreshMcpTools(); });
    let loaded!: (value: api.McpTool[]) => void;
    vi.mocked(api.mcpListTools).mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
    let refreshing!: Promise<unknown>;
    act(() => { refreshing = result.current.refreshMcpTools(); });
    await waitFor(() => expect(api.mcpListTools).toHaveBeenCalledTimes(2));
    act(() => result.current.setSelectedMcpTools(['catalog:lookup']));
    await act(async () => { loaded(tools); await refreshing; });
    expect(result.current.selectedMcpTools).toEqual(['catalog:lookup']);
  });

  it('coalesces simultaneous refresh actions and preserves selection when discovery fails', async () => {
    const { result } = setup();
    await act(async () => { await result.current.refreshMcpTools(); });
    act(() => result.current.setSelectedMcpTools(['catalog:lookup']));
    let failed!: (cause: Error) => void;
    vi.mocked(api.mcpListServers).mockImplementationOnce(() => new Promise((_resolve, reject) => { failed = reject; }));
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => { first = result.current.refreshMcpTools(); second = result.current.refreshMcpTools(); });
    expect(api.mcpListServers).toHaveBeenCalledTimes(2);
    await act(async () => { failed(new Error('Server unavailable')); await Promise.all([first, second]); });
    expect(result.current.selectedMcpTools).toEqual(['catalog:lookup']);
    expect(result.current.mcpDefinitions).toHaveLength(1);
    expect(result.current.mcpError).toBe('MCP tool discovery failed: Server unavailable');
    expect(result.current.loadingMcpTools).toBe(false);
    await act(async () => { await result.current.refreshMcpTools(); });
    expect(result.current.mcpError).toBeNull();
    expect(result.current.selectedMcpTools).toEqual(['catalog:lookup']);
  });
});
