import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { buildChatRequestBody } from '../../shared/api/chat';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import ChatPanel from './Chat';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null }));
vi.mock('../../shared/api/index', () => ({
  isNativeRuntimeAvailable: () => false,
  sessionList: vi.fn(async () => []),
  normalizeSessionList: (value: unknown) => Array.isArray(value) ? value : [],
  serverActivity: vi.fn(async () => undefined),
  mcpListServers: vi.fn(),
  mcpListTools: vi.fn(),
  chatStream: vi.fn(),
}));

const tools = [{ name: 'echo', input_schema: { type: 'object', properties: {} } }];
const requestError = 'Enable automatic tool choice and select the model tool parser in the runtime profile.';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.mcpListServers).mockResolvedValue([{ id: 'fixture', name: 'Synthetic tools', enabled: true, command: 'synthetic', args: [] }]);
  vi.mocked(api.mcpListTools).mockResolvedValue(tools);
  vi.mocked(api.chatStream).mockImplementation(async (_url, _key, model, messages, sampling) => {
    buildChatRequestBody(model, messages, sampling);
    throw new Error('The unsupported tool request must be refused before transport.');
  });
});

it.each(['success', 'failure'] as const)('retains a request error when an earlier MCP discovery completes with %s', async outcome => {
  const store = createTestStore({ active_model: '/synthetic/chat-model', active_provider: 'vllm' });
  store.status = { state: 'running', model: 'synthetic-chat', url: 'http://127.0.0.1:1/v1', api_key: 'synthetic-key',
    execution: { active_model: '/synthetic/chat-model', active_provider: 'vllm' },
    engine: { provider: 'vllm', runtime_id: 'synthetic', upstream_model: 'synthetic-chat',
      modalities: { text: true, image: false, audio: false, video: false }, tasks: ['generate'],
      chat_supported: true, tools_auto: false, tool_parser: false, request_fields: {} } };
  render(<I18nProvider initialLocale="en"><ChatPanel store={store} /></I18nProvider>);
  const summary = screen.getByText('MCP tools');
  fireEvent.click(summary);
  fireEvent.click(screen.getByRole('button', { name: 'Load MCP tools' }));
  await screen.findByText('Synthetic tools · echo');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load MCP tools' })).toBeEnabled());

  let complete!: (value: api.McpTool[]) => void;
  let fail!: (cause: Error) => void;
  vi.mocked(api.mcpListTools).mockImplementationOnce(() => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
  fireEvent.click(screen.getByRole('button', { name: 'Load MCP tools' }));
  await waitFor(() => expect(api.mcpListTools).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Synthetic tool request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  const log = within(screen.getByRole('log', { name: 'Conversation' }));
  await log.findByText(requestError);
  await act(async () => {
    if (outcome === 'success') complete(tools);
    else fail(new Error('Synthetic discovery unavailable'));
  });
  expect(log.getByText(requestError)).toBeInTheDocument();
  if (outcome === 'failure') {
    expect(screen.getByText('MCP tool discovery failed: Synthetic discovery unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load MCP tools' }));
    await waitFor(() => expect(screen.queryByText('MCP tool discovery failed: Synthetic discovery unavailable')).not.toBeInTheDocument());
    expect(log.getByText(requestError)).toBeInTheDocument();
  }
});
