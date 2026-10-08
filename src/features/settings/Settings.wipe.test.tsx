import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { defaultPreferences } from '../../shared/config/preferences';
import { sessionHasActivity } from '../../shared/state/sessionActivity';
import { storageAdapter } from '../../shared/storage/storageAdapter';
import { invoke } from '../../shared/api/transport';
import { createTestStore } from '../../testing/appStore';
import ChatPanel from '../chat/Chat';
import { CHAT_WORKSPACE_KEY, createChatThread, type ChatWorkspace } from '../chat/chatHistory';
import { clearDocumentIndex } from '../chat/documentIndex';
import SettingsPanel from './Settings';

const cache = vi.hoisted(() => new Map<string, unknown>());
const runtime = vi.hoisted(() => ({ native: false }));
vi.mock('../../shared/api/transport.ts', () => ({ isNativeRuntimeAvailable: () => runtime.native, invoke: vi.fn() }));
vi.mock('../../shared/storage/storageAdapter.ts', () => ({ storageAdapter: {
  get: vi.fn(async (key: string) => cache.get(key) ?? null),
  set: vi.fn(async (key: string, value: unknown) => { cache.set(key, value); }),
  remove: vi.fn(async (key: string) => { cache.delete(key); }),
} }));
vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null }));
vi.mock('../chat/documentIndex', async importOriginal => {
  const original = await importOriginal<typeof import('../chat/documentIndex')>();
  return { ...original, clearDocumentIndex: vi.fn(original.clearDocumentIndex) };
});
vi.mock('../../shared/api/index', () => ({
  isNativeRuntimeAvailable: () => false,
  sessionList: vi.fn(async () => []),
  normalizeSessionList: (value: unknown) => Array.isArray(value) ? value : [],
  serverActivity: vi.fn(async () => undefined),
  chatStream: vi.fn(),
  mcpListServers: vi.fn(async () => [{ id: 'synthetic', name: 'Synthetic tools', command: 'synthetic', args: [], enabled: true }]),
  mcpListTools: vi.fn(async () => [{ name: 'echo', input_schema: { type: 'object', properties: {} } }]),
  mcpCallTool: vi.fn(), mcpCancelToolCall: vi.fn(async () => undefined),
  pickAttachment: vi.fn(async () => '/synthetic/context.md'),
  readDocumentText: vi.fn(async () => 'Synthetic document content'),
  embedText: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const originalText = 'ORIGINAL-SYNTHETIC-CONTENT';
const original: ChatWorkspace = { activeThreadId: 'original', threads: [{ ...createChatThread(1, 'original', 'Prior synthetic conversation'),
  messages: [{ role: 'user', content: originalText }] }] };

function mount() {
  const store = createTestStore({ active_model: '/synthetic/model.gguf' });
  store.status = { state: 'running', model: '/synthetic/model.gguf', url: 'http://127.0.0.1:1/v1', api_key: 'synthetic-key' };
  render(<I18nProvider initialLocale="en"><ChatPanel store={store} /><SettingsPanel preferences={defaultPreferences()} update={vi.fn()} reset={vi.fn()} /></I18nProvider>);
  return store;
}

async function erase() {
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete all conversation data' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete all conversation data' }).at(-1)!);
  await screen.findByText('Conversation and document data deleted.');
}

async function send(text: string) {
  fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

beforeEach(() => {
  localStorage.clear(); cache.clear(); vi.clearAllMocks(); runtime.native = false;
  vi.mocked(invoke).mockReset();
  vi.mocked(storageAdapter.get).mockReset().mockImplementation(async key => (cache.get(key) ?? null) as never);
  vi.mocked(storageAdapter.set).mockReset().mockImplementation(async (key, value) => { cache.set(key, value); });
  vi.mocked(api.serverActivity).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.mcpCallTool).mockReset();
  vi.mocked(api.chatStream).mockReset().mockResolvedValue('New synthetic answer');
  vi.mocked(api.readDocumentText).mockReset().mockResolvedValue('Synthetic document content');
  vi.mocked(api.embedText).mockReset();
  vi.mocked(clearDocumentIndex).mockClear();
  localStorage.setItem(CHAT_WORKSPACE_KEY, JSON.stringify(original));
});

it('clears the mounted chat and does not restore removed conversations on its next save', async () => {
  mount();
  await screen.findByText(originalText, { exact: true });
  await waitFor(() => expect(storageAdapter.set).toHaveBeenCalled());
  await erase();
  expect(screen.queryByText(originalText, { exact: true })).not.toBeInTheDocument();
  await send('New conversation after removal');
  await screen.findByText('New synthetic answer', { exact: true });
  await waitFor(() => expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).toContain('New conversation after removal'));
  expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).not.toContain(originalText);
  expect(localStorage.getItem(CHAT_WORKSPACE_KEY)).not.toContain(originalText);
});

it('waits for an older pending save before removing every persisted copy', async () => {
  const pending = deferred<void>();
  vi.mocked(storageAdapter.set).mockImplementationOnce(async (key, value) => { await pending.promise; cache.set(key, value); });
  mount();
  await waitFor(() => expect(storageAdapter.set).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete all conversation data' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete all conversation data' }).at(-1)!);
  await act(async () => { pending.resolve(); await pending.promise; });
  await screen.findByText('Conversation and document data deleted.');
  expect(screen.queryByText(originalText, { exact: true })).not.toBeInTheDocument();
  expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).not.toContain(originalText);
});

it('invalidates old hydration when it finishes during removal', async () => {
  const pending = deferred<ChatWorkspace>();
  vi.mocked(storageAdapter.get).mockReturnValueOnce(pending.promise);
  mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete all conversation data' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete all conversation data' }).at(-1)!);
  await act(async () => { pending.resolve(original); await pending.promise; });
  await screen.findByText('Conversation and document data deleted.');
  expect(screen.queryByText(originalText, { exact: true })).not.toBeInTheDocument();
  expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).not.toContain(originalText);
});

it.each(['preparation', 'streaming', 'approval', 'tool-running'] as const)('cancels %s and ignores its late completion after removal', async stage => {
  const preparation = deferred<void>();
  const response = deferred<string>();
  const tool = deferred<unknown>();
  let streamDelta: ((delta: api.ChatDelta) => void) | undefined;
  if (stage === 'preparation') vi.mocked(api.serverActivity).mockImplementationOnce(() => preparation.promise);
  vi.mocked(api.chatStream).mockImplementationOnce(async (_url, _key, _model, _history, _sampling, onDelta) => {
    streamDelta = onDelta;
    if (stage === 'approval' || stage === 'tool-running') {
      onDelta({ tool_calls: [{ index: 0, id: 'synthetic-call', name: _sampling.tools![0].function.name, arguments: '{}' }] });
      return '';
    }
    onDelta({ content: 'Old stream content' });
    return response.promise;
  });
  vi.mocked(api.mcpCallTool).mockReturnValueOnce(tool.promise);
  mount();
  await waitFor(() => expect(storageAdapter.set).toHaveBeenCalled());
  if (stage === 'approval' || stage === 'tool-running') {
    fireEvent.click(screen.getByText('MCP tools'));
    fireEvent.click(screen.getByRole('button', { name: 'Load MCP tools' }));
    await screen.findByText('Synthetic tools · echo');
  }
  await send('Old active turn');
  if (stage === 'preparation') await waitFor(() => expect(api.serverActivity).toHaveBeenCalled());
  else if (stage === 'approval' || stage === 'tool-running') {
    await screen.findByRole('button', { name: 'Approve once' });
    if (stage === 'tool-running') {
      fireEvent.click(screen.getByRole('button', { name: 'Approve once' }));
      await waitFor(() => expect(api.mcpCallTool).toHaveBeenCalled());
    }
  } else await waitFor(() => expect(api.chatStream).toHaveBeenCalled());
  await erase();
  expect(sessionHasActivity('default')).toBe(false);
  expect(screen.queryByRole('button', { name: 'Approve once' })).not.toBeInTheDocument();
  const fresh = deferred<string>();
  vi.mocked(api.chatStream).mockReset().mockImplementationOnce(async (_url, _key, _model, _history, _sampling, onDelta) => {
    onDelta({ content: 'Fresh response in progress' });
    return fresh.promise;
  });
  await send('Fresh turn after removal');
  await screen.findByRole('button', { name: 'Stop generation' });
  await act(async () => { preparation.resolve(); streamDelta?.({ content: 'Late removed content' }); response.resolve('Late removed content'); tool.resolve({ content: 'Late removed result' }); });
  expect(screen.getByRole('button', { name: 'Stop generation' })).toBeEnabled();
  expect(sessionHasActivity('default')).toBe(true);
  expect(screen.queryByText(originalText, { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText('Old active turn', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText('Late removed content', { exact: true })).not.toBeInTheDocument();
  expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).not.toContain('Old active turn');
  if (stage === 'tool-running') expect(api.mcpCancelToolCall).toHaveBeenCalledOnce();
  await act(async () => { fresh.resolve('Fresh response complete'); });
  await screen.findByText('Fresh response complete', { exact: true });
  expect(sessionHasActivity('default')).toBe(false);
  await waitFor(() => expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).toContain('Fresh turn after removal'));
  expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).not.toContain(originalText);
});

it('keeps sending locked until document deletion finishes', async () => {
  const pending = deferred<void>();
  vi.mocked(clearDocumentIndex).mockReturnValueOnce(pending.promise);
  mount();
  await waitFor(() => expect(storageAdapter.set).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete all conversation data' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete all conversation data' }).at(-1)!);
  await waitFor(() => expect(clearDocumentIndex).toHaveBeenCalled());
  await send('Message during removal');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(api.chatStream).not.toHaveBeenCalled();
  expect(screen.queryByText('Conversation and document data deleted.')).not.toBeInTheDocument();
  await act(async () => { pending.resolve(); });
  await screen.findByText('Conversation and document data deleted.');
  await send('Message after removal');
  await screen.findByText('New synthetic answer', { exact: true });
});

it('discards an attachment read that was started before removal', async () => {
  const pending = deferred<string>();
  vi.mocked(api.readDocumentText).mockReturnValueOnce(pending.promise);
  mount();
  await waitFor(() => expect(storageAdapter.set).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
  await waitFor(() => expect(api.readDocumentText).toHaveBeenCalled());
  await erase();
  await act(async () => { pending.resolve('Late extracted document content'); });
  expect(screen.queryByText('context.md', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

it('does not recreate the document cache from a cancelled embedding request', async () => {
  const pending = deferred<number[][]>();
  vi.mocked(api.embedText).mockReturnValueOnce(pending.promise);
  localStorage.setItem('aiolm.document-index.v1.synthetic', 'OLD-SYNTHETIC-CACHE');
  mount();
  await waitFor(() => expect(storageAdapter.set).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
  await screen.findByText('context.md', { exact: true });
  await send('Search the attached document');
  await waitFor(() => expect(api.embedText).toHaveBeenCalled());
  await erase();
  await act(async () => { pending.resolve([[1, 0], [1, 0]]); });
  expect(api.chatStream).not.toHaveBeenCalled();
  expect(Object.keys(localStorage).some(key => key.startsWith('aiolm.document-index.v1.'))).toBe(false);
  expect(JSON.stringify(cache.get(CHAT_WORKSPACE_KEY))).not.toContain('Synthetic document content');
});

it('reports native deletion failure and keeps its surviving conversation usable', async () => {
  runtime.native = true;
  localStorage.setItem('aiolm.chat-storage.v1', 'native');
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'conversations_clear') throw new Error('Synthetic storage unavailable');
    if (command === 'conversations_load') return { threads: original.threads, warnings: [] } as never;
    if (command === 'chat_personalization') return { instructions: [], skills: [], warnings: [] } as never;
    return undefined as never;
  });
  mount();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('conversations_load'));
  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete all conversation data' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete all conversation data' }).at(-1)!);
  await screen.findByText('Could not delete the stored data: Synthetic storage unavailable');
  expect(screen.queryByText('Conversation and document data deleted.')).not.toBeInTheDocument();
  expect(screen.getByText(originalText, { exact: true })).toBeInTheDocument();
  await send('New message after failed removal');
  await screen.findByText('New synthetic answer', { exact: true });
});
