import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import { buildMcpFunctionNames } from '../mcp/mcpUtils';
import { projectFromConfig, setActiveProjectId, writeProjects } from '../projects/projectStore';
import ChatPanel from './Chat';
import { createChatThread, loadChatWorkspace, saveChatWorkspace, type ChatHistoryMessage, type ChatThread } from './chatHistory';
import { mcpToolDefinition } from './useChatMcpTools';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null }));
vi.mock('../../shared/api/index', () => ({
  isNativeRuntimeAvailable: () => false,
  sessionList: vi.fn(async () => []),
  normalizeSessionList: (value: unknown) => Array.isArray(value) ? value : [],
  serverActivity: vi.fn(async () => undefined),
  readDocumentBinding: vi.fn(),
  mcpListServers: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
  mcpCancelToolCall: vi.fn(async () => undefined),
  chatStream: vi.fn(),
}));
vi.mock('../../shared/lib/notifications', () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const streamMock = vi.mocked(api.chatStream);
const server = { id: 'fixture', name: 'Synthetic tools', enabled: true, command: 'synthetic', args: [] };
const slowLookup: api.McpTool = { name: 'slow_lookup', description: 'Synthetic slow archive lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } };
const otherLookup: api.McpTool = { name: 'other_lookup', description: 'Unrelated synthetic tool', input_schema: { type: 'object', properties: {} } };
const functionName = buildMcpFunctionNames([{ serverId: 'fixture', toolName: 'slow_lookup' }])[0];
const definition = mcpToolDefinition({ serverId: 'fixture', serverName: 'Synthetic tools', tool: slowLookup }, functionName);
const question = 'Use the lookup tool for synthetic-key.';
const savedRequest: api.ChatMessage[] = [{ role: 'system', content: 'Synthetic system prompt' }, { role: 'user', content: question }];

function savedToolTurn(): ChatHistoryMessage[] {
  return [
    { role: 'user', content: question },
    { role: 'assistant', content: '', reasoning: 'Synthetic reasoning', model: 'synthetic-chat', finishReason: 'tool_calls', toolRound: 'cancelled',
      retry: { version: 1, text: question, images: [], documents: [], history: savedRequest,
        tools: [{ serverId: 'fixture', serverName: 'Synthetic tools', toolName: 'slow_lookup', definition }] } },
  ];
}

async function renderSaved(thread: ChatThread = { ...createChatThread(1, 'saved-tool-turn'), title: 'Saved tool turn', messages: savedToolTurn() }, heading = thread.title, others: ChatThread[] = []) {
  saveChatWorkspace({ activeThreadId: thread.id, threads: [thread, ...others] });
  const store = createTestStore({ active_model: '/synthetic/chat-model' });
  store.status = { state: 'running', model: 'synthetic-chat', url: 'http://127.0.0.1:1/v1', api_key: 'synthetic-key' };
  render(<I18nProvider initialLocale="en"><ChatPanel store={store} /></I18nProvider>);
  await screen.findByRole('heading', { name: heading });
  fireEvent.click(screen.getByText('MCP tools'));
  return { thread, log: within(screen.getByRole('log', { name: 'Conversation' })) };
}

function requestsTool() {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ tool_calls: [{ index: 0, id: 'call-retry', name: functionName, arguments: '{"key":"synthetic-key"}' }], finish_reason: 'tool_calls' });
    return '';
  });
}

function answers(text: string) {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ content: text });
    return text;
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  streamMock.mockReset();
  vi.mocked(api.mcpListServers).mockResolvedValue([server]);
  vi.mocked(api.mcpListTools).mockResolvedValue([slowLookup, otherLookup]);
});

it('after a restart, offers to reload the tools a saved tool turn used instead of retrying without them, then retries with only those after a fresh approval', async () => {
  const { thread, log } = await renderSaved();
  expect(await log.findByText(/Retry needs the MCP tools offered with this reply \(Synthetic tools · slow_lookup\), and they are not loaded/)).toBeInTheDocument();
  expect(log.queryByRole('button', { name: 'Retry last message' })).not.toBeInTheDocument();
  expect(streamMock).not.toHaveBeenCalled();
  expect(loadChatWorkspace().threads[0].messages).toEqual(thread.messages);

  fireEvent.click(log.getByRole('button', { name: 'Reload MCP tools for Retry' }));
  const retry = await log.findByRole('button', { name: 'Retry last message' });
  expect(api.mcpListServers).toHaveBeenCalledOnce();
  // Only the reply's own tool is restored; discovery does not choose every listed tool.
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · slow_lookup' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · other_lookup' })).not.toBeChecked();

  requestsTool();
  fireEvent.click(retry);
  const approve = await screen.findByRole('button', { name: 'Approve once' });
  expect(streamMock).toHaveBeenCalledOnce();
  expect(streamMock.mock.calls[0][3]).toEqual(savedRequest);
  expect(streamMock.mock.calls[0][4].tools).toEqual([definition]);
  expect(api.mcpCallTool).not.toHaveBeenCalled();

  vi.mocked(api.mcpCallTool).mockResolvedValueOnce({ content: [{ type: 'text', text: 'synthetic-key: amber-0000' }] });
  answers('The archive answered amber-0000.');
  fireEvent.click(approve);
  expect(await log.findByText('The archive answered amber-0000.')).toBeInTheDocument();
  expect(api.mcpCallTool).toHaveBeenCalledExactlyOnceWith('fixture', 'slow_lookup', { key: 'synthetic-key' }, expect.any(String));
  expect(streamMock.mock.calls[1][3].at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-retry', name: functionName, content: '{"text":"synthetic-key: amber-0000"}' });
});

it.each([
  ['the server no longer lists the tool', () => vi.mocked(api.mcpListTools).mockResolvedValue([otherLookup])],
  ['the server is disabled', () => vi.mocked(api.mcpListServers).mockResolvedValue([{ ...server, enabled: false }])],
  ['the server was removed', () => vi.mocked(api.mcpListServers).mockResolvedValue([])],
])('explains that Retry is unavailable when %s, and sends nothing', async (_case, arrange) => {
  arrange();
  const { thread, log } = await renderSaved();
  fireEvent.click(await log.findByRole('button', { name: 'Reload MCP tools for Retry' }));
  expect(await log.findByText(/MCP tools offered with this reply \(Synthetic tools · slow_lookup\) are no longer offered/)).toBeInTheDocument();
  expect(log.queryByRole('button', { name: 'Retry last message' })).not.toBeInTheDocument();
  expect(streamMock).not.toHaveBeenCalled();
  expect(loadChatWorkspace().threads[0].messages).toEqual(thread.messages);
});

it('does not restore a tool whose definition changed since the reply, and explains why', async () => {
  vi.mocked(api.mcpListTools).mockResolvedValue([{ ...slowLookup, description: 'Synthetic slow archive lookup, reworded' }, otherLookup]);
  const { thread, log } = await renderSaved();
  fireEvent.click(await log.findByRole('button', { name: 'Reload MCP tools for Retry' }));
  expect(await log.findByText(/MCP tools offered with this reply \(Synthetic tools · slow_lookup\) changed since then/)).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · slow_lookup' })).not.toBeChecked();
  expect(log.queryByRole('button', { name: 'Retry last message' })).not.toBeInTheDocument();
  expect(streamMock).not.toHaveBeenCalled();
  expect(loadChatWorkspace().threads[0].messages).toEqual(thread.messages);
});

/** Holds the next discovery of the fixture server's tools until the test answers it. */
function deferDiscovery() {
  let answer!: (tools: api.McpTool[]) => void;
  vi.mocked(api.mcpListTools).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  return async () => {
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    await act(async () => { answer([slowLookup, otherLookup]); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load MCP tools' })).toBeEnabled());
  };
}

it('does not let a restore started in one conversation select tools after switching to another', async () => {
  const other: ChatThread = { ...createChatThread(2, 'other-thread'), title: 'Other conversation',
    messages: [{ role: 'user', content: 'Another question' }, { role: 'assistant', content: 'Finished answer' }] };
  const saved: ChatThread = { ...createChatThread(1, 'saved-tool-turn'), title: 'Saved tool turn', messages: savedToolTurn() };
  const { log } = await renderSaved(saved, saved.title, [other]);
  const finish = deferDiscovery();
  fireEvent.click(await log.findByRole('button', { name: 'Reload MCP tools for Retry' }));
  fireEvent.click(screen.getByRole('button', { name: 'Other conversation' }));
  await screen.findByRole('heading', { name: 'Other conversation' });
  await finish();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · slow_lookup' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · other_lookup' })).not.toBeChecked();

  // Back in the saved conversation the restore can simply be asked for again.
  fireEvent.click(screen.getByRole('button', { name: 'Saved tool turn' }));
  const savedLog = within(screen.getByRole('log', { name: 'Conversation' }));
  fireEvent.click(await savedLog.findByRole('button', { name: 'Reload MCP tools for Retry' }));
  expect(await savedLog.findByRole('button', { name: 'Retry last message' })).toBeEnabled();
  expect(streamMock).not.toHaveBeenCalled();
});

it("leaves a project's tools in place when the project is applied while a restore is pending", async () => {
  const { log } = await renderSaved();
  const finish = deferDiscovery();
  fireEvent.click(await log.findByRole('button', { name: 'Reload MCP tools for Retry' }));
  const project = projectFromConfig('Synthetic project', '', createTestStore().cfg!, [], ['fixture:other_lookup']);
  act(() => { writeProjects([project]); setActiveProjectId(project.id); });
  await finish();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · other_lookup' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · slow_lookup' })).not.toBeChecked();
  expect(log.queryByRole('button', { name: 'Retry last message' })).not.toBeInTheDocument();
  expect(streamMock).not.toHaveBeenCalled();
});

it('keeps a tool choice the user makes while a restore is pending', async () => {
  const { log } = await renderSaved();
  // A first catalog load selects every tool, so the turn's tool is available at first.
  fireEvent.click(screen.getByRole('button', { name: 'Load MCP tools' }));
  await log.findByRole('button', { name: 'Retry last message' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic tools · slow_lookup' }));
  const finish = deferDiscovery();
  fireEvent.click(await log.findByRole('button', { name: 'Reload MCP tools for Retry' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic tools · other_lookup' }));
  await finish();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · slow_lookup' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · other_lookup' })).not.toBeChecked();
  expect(log.queryByRole('button', { name: 'Retry last message' })).not.toBeInTheDocument();
  expect(streamMock).not.toHaveBeenCalled();
});

it("keeps a restored tool selection when the conversation's project defaults select none", async () => {
  const project = projectFromConfig('Synthetic project', '', createTestStore().cfg!, [], []);
  writeProjects([project]); setActiveProjectId(project.id);
  const thread: ChatThread = { ...createChatThread(1, 'project-tool-turn'), title: 'Project tool turn', messages: savedToolTurn(),
    projectBinding: { id: project.id, updatedAt: project.updatedAt } };
  const { log } = await renderSaved(thread, `${thread.title} · ${project.name}`);
  fireEvent.click(await log.findByRole('button', { name: 'Reload MCP tools for Retry' }));
  answers('Answer with the restored tool offered.');
  fireEvent.click(await log.findByRole('button', { name: 'Retry last message' }));
  expect(await log.findByText('Answer with the restored tool offered.')).toBeInTheDocument();
  expect(streamMock.mock.calls[0][4].tools).toEqual([definition]);
  expect(screen.getByRole('checkbox', { name: 'Synthetic tools · slow_lookup' })).toBeChecked();
});
