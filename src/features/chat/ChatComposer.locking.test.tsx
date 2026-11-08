import { useEffect, type ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as api from '../../shared/api/index';
import { useChatMcpTools } from './useChatMcpTools';
import ChatComposer from './ChatComposer';
import ChatSkillPicker from './ChatSkillPicker';

vi.mock('../../shared/api/index', () => ({ mcpListServers: vi.fn(), mcpListTools: vi.fn() }));

function props(): ComponentProps<typeof ChatComposer> {
  return {
    contextWarning: null, contextSources: [], mcpCatalog: [{ serverId: 'catalog', serverName: 'Catalog', tool: { name: 'lookup', input_schema: {} } }],
    selectedMcpTools: ['catalog:lookup'], toggleMcpTool: vi.fn(), loadingMcpTools: false, refreshMcpTools: vi.fn(), mcpDefinitions: [],
    pendingToolCall: null, toolCallInProgress: false, onApproveTool: vi.fn(), onRejectTool: vi.fn(), attachments: [], onRemoveAttachment: vi.fn(), attachmentStatus: 'idle',
    documents: [], onRemoveDocument: vi.fn(), input: 'Next question', setInput: vi.fn(), onKeyDown: vi.fn(), disabled: false, phase: 'idle',
    onAddAttachment: vi.fn(), onStop: vi.fn(), aborting: false, onSend: vi.fn(), canSend: true, msgsLength: 2, responseState: 'complete', ct: key => key,
  };
}

describe('composer turn locks', () => {
  it('keeps only one tool picker open without losing the draft or its send action', () => {
    const options = props();
    options.skillPicker = <ChatSkillPicker native catalog={[]} warnings={[]} loadError={null} loading={false} loaded
      selectedSkillIds={[]} onToggleSkill={vi.fn()} onRefresh={vi.fn()} locked={false} closeLabel="close" pt={key => key} />;
    render(<I18nProvider initialLocale="en"><ChatComposer {...options} /></I18nProvider>);
    const mcp = screen.getByText('mcpTools').closest('details')!;
    const skills = screen.getByText('skills').closest('details')!;
    mcp.open = true;
    fireEvent(mcp, new Event('toggle'));
    expect(mcp).toHaveAttribute('open');
    skills.open = true;
    fireEvent(skills, new Event('toggle'));
    expect(skills).toHaveAttribute('open');
    expect(mcp).not.toHaveAttribute('open');
    mcp.open = true;
    fireEvent(mcp, new Event('toggle'));
    expect(skills).not.toHaveAttribute('open');
    fireEvent.click(within(mcp).getByRole('button', { name: 'close' }));
    expect(mcp).not.toHaveAttribute('open');
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveValue('Next question');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(options.onSend).toHaveBeenCalledOnce();
  });

  it('closes an open tool picker when the turn locks and keeps it closed until idle', () => {
    const options = props();
    const view = render(<I18nProvider initialLocale="en"><ChatComposer {...options} /></I18nProvider>);
    const summary = screen.getByText('mcpTools', { selector: 'summary' });
    const picker = summary.closest('details')!;
    fireEvent.click(summary);
    expect(picker).toHaveAttribute('open');
    view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...options} phase="preparing" /></I18nProvider>);
    expect(picker).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(picker).not.toHaveAttribute('open');
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveValue('Next question');
    view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...options} /></I18nProvider>);
    fireEvent.click(summary);
    expect(picker).toHaveAttribute('open');
  });

  it('locks draft and tool changes during approval while preserving the draft and approval actions', () => {
    const options = props();
    options.selectedMcpTools = ['catalog:lookup', 'offline:remember'];
    options.pendingToolCall = { serverId: 'catalog', serverName: 'Catalog', toolName: 'lookup', argumentsValue: {},
      call: { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } } };
    const view = render(<I18nProvider initialLocale="en"><ChatComposer {...options} /></I18nProvider>);
    const details = screen.getByText('mcpTools').closest('details')!;
    details.open = true;
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveValue('Next question');
    expect(within(details).getByRole('checkbox')).toBeDisabled();
    for (const name of ['attachFile', 'send', 'loadMcpTools']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'approveTool' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'rejectTool' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('mcpApprovalRequired');
    expect(screen.getByRole('status')).not.toHaveTextContent('responseReady');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    fireEvent.click(screen.getByRole('button', { name: 'attachFile' }));
    fireEvent.click(screen.getByRole('button', { name: 'loadMcpTools' }));
    expect(options.onSend).not.toHaveBeenCalled();
    expect(options.onAddAttachment).not.toHaveBeenCalled();
    expect(options.refreshMcpTools).not.toHaveBeenCalled();
    const removeTool = screen.getByRole('button', { name: 'Remove MCP tool: remember' });
    expect(removeTool).toBeDisabled();
    fireEvent.click(removeTool);
    expect(options.toggleMcpTool).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'approveTool' }));
    expect(options.onApproveTool).toHaveBeenCalledOnce();

    view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...options} pendingToolCall={null} /></I18nProvider>);
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveValue('Next question');
    expect(screen.getByRole('button', { name: 'send' })).toBeEnabled();
  });

  it('keeps input editable but prevents sending while an attachment is still reading', () => {
    const options = props();
    render(<I18nProvider initialLocale="en"><ChatComposer {...options} attachmentStatus="reading" /></I18nProvider>);
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'attachFile' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(options.onSend).not.toHaveBeenCalled();
  });

  it('distinguishes the native tool wait from its follow-up model request while keeping Stop available', () => {
    const options = props();
    const view = render(<I18nProvider initialLocale="en"><ChatComposer {...options} phase="preparing" toolCallInProgress /></I18nProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('waitingMcpTool');
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    expect(options.onStop).toHaveBeenCalledOnce();
    view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...options} phase="prefill" toolCallInProgress={false} /></I18nProvider>);
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'stop' })).toBeEnabled();
    view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...options} phase="decoding" toolCallInProgress={false} /></I18nProvider>);
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'stop' })).toBeEnabled();
  });
});

function ProjectToolComposer({ onSend }: { onSend: (definitions: api.ChatToolDefinition[]) => void }) {
  const mcp = useChatMcpTools();
  const { setSelectedMcpTools } = mcp;
  useEffect(() => {
    setSelectedMcpTools(['catalog:lookup', 'offline:remember', 'removed:archive']);
  }, [setSelectedMcpTools]);
  return <ChatComposer {...props()} {...mcp} refreshMcpTools={() => void mcp.refreshMcpTools()}
    onSend={() => onSend(mcp.mcpDefinitions)} />;
}

it('lets a user resolve stored tool choices, remove one unavailable choice, and recover another on rediscovery', async () => {
  vi.mocked(api.mcpListServers).mockResolvedValue([
    { id: 'catalog', name: 'Catalog', enabled: true, command: 'synthetic', args: [] },
  ]);
  vi.mocked(api.mcpListTools).mockResolvedValue([{ name: 'lookup', input_schema: {} }]);
  const send = vi.fn();
  render(<I18nProvider initialLocale="en"><ProjectToolComposer onSend={send} /></I18nProvider>);
  const selected = within(screen.getByRole('group', { name: 'mcpTools' }));
  expect(selected.getByText('lookup · Not loaded')).toBeInTheDocument();
  expect(selected.getByText('remember · Not loaded')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  expect(send).toHaveBeenLastCalledWith([]);
  fireEvent.click(screen.getByRole('button', { name: 'loadMcpTools' }));
  await selected.findByText('Catalog · lookup');
  expect(selected.getByText('remember · Unavailable')).toBeInTheDocument();
  expect(selected.getByText('archive · Unavailable')).toBeInTheDocument();
  fireEvent.click(selected.getByRole('button', { name: 'Remove MCP tool: archive' }));
  expect(selected.queryByText('archive · Unavailable')).not.toBeInTheDocument();
  expect(selected.getByText('remember · Unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  expect(send).toHaveBeenLastCalledWith([
    { type: 'function', function: { name: 'catalog__lookup', parameters: {} } },
  ]);
  vi.mocked(api.mcpListServers).mockResolvedValue([
    { id: 'catalog', name: 'Catalog', enabled: true, command: 'synthetic', args: [] },
    { id: 'offline', name: 'Memory', enabled: true, command: 'synthetic', args: [] },
    { id: 'removed', name: 'Archive', enabled: true, command: 'synthetic', args: [] },
  ]);
  vi.mocked(api.mcpListTools).mockImplementation(async serverId => [
    { name: serverId === 'catalog' ? 'lookup' : serverId === 'offline' ? 'remember' : 'archive', input_schema: {} },
  ]);
  await waitFor(() => expect(screen.getByRole('button', { name: 'loadMcpTools' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'loadMcpTools' }));
  await selected.findByText('Memory · remember');
  expect(selected.queryByText('Archive · archive')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('mcpTools', { selector: 'summary' }));
  expect(screen.getByRole('checkbox', { name: 'Archive · archive' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Memory · remember' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  expect(send).toHaveBeenLastCalledWith([
    { type: 'function', function: { name: 'catalog__lookup', parameters: {} } },
    { type: 'function', function: { name: 'offline__remember', parameters: {} } },
  ]);
});

it.each([
  ['en', 'Not loaded', 'Unavailable', 'Remove MCP tool'],
  ['ko', '불러오지 않음', '사용할 수 없음', 'MCP 도구 제거'],
  ['ja', '未読み込み', '利用不可', 'MCPツールを削除'],
  ['zh', '尚未加载', '不可用', '移除 MCP 工具'],
] as const)('explains and removes unresolved selections in %s', (locale, notLoaded, unavailable, remove) => {
  const options = { ...props(), locale, mcpCatalog: [], selectedMcpTools: ['missing:lookup', 'other:remember'] };
  const view = render(<I18nProvider initialLocale={locale}><ChatComposer {...options} /></I18nProvider>);
  expect(screen.getByText(`lookup · ${notLoaded}`)).toBeInTheDocument();
  view.rerender(<I18nProvider initialLocale={locale}><ChatComposer {...options} mcpCatalogLoaded /></I18nProvider>);
  expect(screen.getByText(`lookup · ${unavailable}`)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: `${remove}: lookup` }));
  expect(options.toggleMcpTool).toHaveBeenCalledWith('missing:lookup');
  fireEvent.click(screen.getByRole('button', { name: 'loadMcpTools' }));
  expect(options.refreshMcpTools).toHaveBeenCalledOnce();
});
