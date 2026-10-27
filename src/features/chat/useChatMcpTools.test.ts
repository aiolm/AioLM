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
  it('reuses derived values while an unrelated refresh state changes', async () => {
    const { result } = setup();
    await act(async () => { await result.current.refreshMcpTools(); });
    const initialDefinitions = result.current.mcpDefinitions;
    const initialEntries = result.current.mcpEntryByFunctionName;
    act(() => result.current.toggleMcpTool('catalog:lookup'));
    expect(result.current.mcpDefinitions).not.toBe(initialDefinitions);
    expect(result.current.mcpEntryByFunctionName).not.toBe(initialEntries);
    const definitions = result.current.mcpDefinitions;
    const entries = result.current.mcpEntryByFunctionName;
    let loaded!: (value: api.McpServer[]) => void;
    vi.mocked(api.mcpListServers).mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
    let refreshing!: Promise<unknown>;
    act(() => { refreshing = result.current.refreshMcpTools(); });
    await waitFor(() => expect(api.mcpListServers).toHaveBeenCalledTimes(2));
    expect(result.current.loadingMcpTools).toBe(true);
    expect(result.current.mcpDefinitions).toBe(definitions);
    expect(result.current.mcpEntryByFunctionName).toBe(entries);
    await act(async () => { loaded([{ id: 'catalog', name: 'Catalog', enabled: true, command: 'synthetic', args: [] }]); await refreshing; });
    expect(result.current.mcpDefinitions).not.toBe(definitions);
    expect(result.current.mcpEntryByFunctionName).not.toBe(entries);
  });

  it('does not reread tool definitions during an unrelated refresh rerender', async () => {
    let schemaReads = 0;
    const tool: api.McpTool = {
      name: 'counted',
      get input_schema() { schemaReads += 1; return {}; },
    };
    vi.mocked(api.mcpListTools).mockResolvedValue([tool]);
    const { result } = setup();
    await act(async () => { await result.current.refreshMcpTools(); });
    const readsAfterDiscovery = schemaReads;
    let loaded!: (value: api.McpServer[]) => void;
    vi.mocked(api.mcpListServers).mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
    let refreshing!: Promise<unknown>;
    act(() => { refreshing = result.current.refreshMcpTools(); });
    await waitFor(() => expect(api.mcpListServers).toHaveBeenCalledTimes(2));
    expect(schemaReads).toBe(readsAfterDiscovery);
    await act(async () => { loaded([{ id: 'catalog', name: 'Catalog', enabled: true, command: 'synthetic', args: [] }]); await refreshing; });
  });

  it('preserves catalog order and collision suffixes while pruning missing selections', async () => {
    const first = { name: 'same', input_schema: { type: 'object', properties: { first: { type: 'string' } } } };
    const second = { name: 'same', input_schema: { type: 'object', properties: { second: { type: 'number' } } } };
    vi.mocked(api.mcpListTools).mockResolvedValue([second, first, { name: 'other', input_schema: { type: 'object' } }]);
    const { result } = setup();
    act(() => result.current.setSelectedMcpTools(['catalog:other', 'catalog:same', 'catalog:missing']));
    await act(async () => { await result.current.refreshMcpTools(); });
    expect(result.current.selectedMcpTools).toEqual(['catalog:other', 'catalog:same']);
    expect(result.current.mcpDefinitions.map(definition => definition.function.name)).toEqual(['catalog__same', 'catalog__same_2', 'catalog__other']);
    expect(result.current.mcpDefinitions.map(definition => definition.function.parameters)).toEqual([second.input_schema, first.input_schema, { type: 'object' }]);
    expect([...result.current.mcpEntryByFunctionName.keys()]).toEqual(['catalog__same', 'catalog__same_2', 'catalog__other']);
  });

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
