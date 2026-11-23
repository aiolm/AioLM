import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPanel from './Chat';
import { clearChatWorkspace, loadChatWorkspace, saveChatWorkspaceAsync } from './chatHistory';
import { createChatThread } from './chatWorkspace';
import { useChatScroll } from './useChatScroll';
import * as api from '../../shared/api/index';
import { getChatPersonalization, type ChatSkill } from '../../shared/api/personalization';
import * as transport from '../../shared/api/transport';
import { defaultPreferences } from '../../shared/config/preferences';
import { I18nProvider } from '../../shared/i18n/i18n';
import type { AppStore } from '../../shared/state/store';
import { createTestStore } from '../../testing/appStore';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null }));

vi.mock('../../shared/api/transport', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/api/transport')>(),
  isNativeRuntimeAvailable: vi.fn(() => false),
}));

vi.mock('../../shared/api/personalization', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/api/personalization')>(),
  getChatPersonalization: vi.fn(async () => ({ instructions: [], skills: [], warnings: [] })),
  readSkill: vi.fn(),
}));

vi.mock('../../shared/api/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  isNativeRuntimeAvailable: vi.fn(() => false),
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  sessionList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown): unknown[] => (Array.isArray(value) ? value : [])),
  mcpListServers: vi.fn(async () => [
    { id: 'fixture', name: 'Synthetic tools', enabled: true, command: 'synthetic', args: [] },
  ]),
  mcpListTools: vi.fn(async () => []),
  mcpCallTool: vi.fn(),
  mcpCancelToolCall: vi.fn(async () => undefined),
  importPastedImage: vi.fn(),
  onAttachmentDrag: vi.fn(async () => () => undefined),
  onAttachmentDrop: vi.fn(async () => () => undefined),
  discardAttachmentDrop: vi.fn(async () => undefined),
}));

function runningStore(vision = false): AppStore {
  const base = createTestStore({ active_model: 'C:/models/chat.gguf' });
  return {
    ...base,
    status: {
      state: 'running',
      url: 'http://127.0.0.1:8080',
      api_key: 'synthetic-key',
      model: 'chat.gguf',
      engine: {
        provider: 'llama.cpp',
        runtime_id: 'synthetic',
        upstream_model: 'chat.gguf',
        modalities: { text: true, image: vision, audio: false, video: false },
        tasks: ['generate'],
        chat_supported: true,
        tools_auto: true,
        tool_parser: true,
        request_fields: {},
      },
    },
  };
}

function openDetails(summaryText: string): HTMLDetailsElement {
  const summary = screen.getByText(summaryText, { selector: 'summary' });
  fireEvent.click(summary);
  const details = summary.closest('details')!;
  if (!details.open) {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  }
  return details;
}

describe('Chat UX improvements', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.isNativeRuntimeAvailable).mockReturnValue(false);
    vi.mocked(transport.isNativeRuntimeAvailable).mockReturnValue(false);
    await clearChatWorkspace();
    vi.mocked(api.mcpListServers).mockResolvedValue([
      { id: 'fixture', name: 'Synthetic tools', enabled: true, command: 'synthetic', args: [] },
    ]);
    vi.mocked(api.mcpListTools).mockResolvedValue([]);
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resets scroll state across thread switches and exposes Jump to latest when scrolled up', async () => {
    const atBottomRef = { current: false };
    const { result, rerender } = renderHook(
      ({ activeThreadId }: { activeThreadId: string }) => useChatScroll([], 'idle', atBottomRef, activeThreadId),
      { initialProps: { activeThreadId: 't1' } },
    );
    expect(atBottomRef.current).toBe(true);

    const scroller = document.createElement('div');
    const scrollToSpy = vi.fn();
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollTo: { configurable: true, value: scrollToSpy },
    });
    result.current.scrollRef.current = scroller;

    atBottomRef.current = false;
    act(() => result.current.onScrollAtBottomChange(false));
    expect(result.current.showScrollToBottom).toBe(true);

    rerender({ activeThreadId: 't2' });
    expect(atBottomRef.current).toBe(true);
    expect(result.current.showScrollToBottom).toBe(false);

    act(() => result.current.onScrollAtBottomChange(false));
    expect(result.current.showScrollToBottom).toBe(true);
    act(() => result.current.scrollToBottom());
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' });
    expect(result.current.showScrollToBottom).toBe(false);

    const thread = createChatThread(100, 'scroll-thread', 'Scroll test');
    thread.messages = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'World' }];
    await saveChatWorkspaceAsync({ activeThreadId: thread.id, threads: [thread] });

    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} /></I18nProvider>);
    const log = await screen.findByRole('log', { name: 'Conversation' });
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 250 },
      scrollTop: { configurable: true, writable: true, value: 10 },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    fireEvent.scroll(log);
    const jumpButton = await screen.findByRole('button', { name: 'Jump to latest' });
    expect(log).not.toContainElement(jumpButton);
    fireEvent.click(jumpButton);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('tracks live badge and message count while streaming, and allows editing/deleting non-live threads', async () => {
    const t1 = createChatThread(300, 'alpha', 'Alpha');
    const t2 = createChatThread(200, 'beta', 'Beta');
    const t3 = createChatThread(100, 'gamma', 'Gamma');
    await saveChatWorkspaceAsync({ activeThreadId: 'alpha', threads: [t1, t2, t3] });

    let finishStream!: (text: string) => void;
    vi.mocked(api.chatStream).mockImplementationOnce((_u, _k, _m, _msgs, _s, onDelta) => {
      onDelta({ content: 'Partial ' });
      return new Promise((resolve) => {
        finishStream = resolve;
      });
    });

    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} /></I18nProvider>);
    const composer = await screen.findByRole('textbox', { name: 'Chat message' });
    fireEvent.change(composer, { target: { value: 'Stream question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    const sidebar = screen.getByRole('complementary', { name: 'Conversations' });
    expect(await within(sidebar).findByText('Generating')).toBeVisible();
    const alphaRow = within(sidebar).getByRole('button', { name: 'Alpha' }).closest<HTMLElement>('.chat-thread-row')!;
    expect(within(alphaRow).getByText('2 messages')).toBeVisible();
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Delete conversation: Alpha' }));
    expect(screen.queryByRole('dialog', { name: 'Delete this conversation?' })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'Alpha' })).toBeInTheDocument();

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Beta' }));
    const settingsBtn = screen.getByLabelText('Conversation settings');
    const settingsDetails = settingsBtn.closest('details')!;
    settingsDetails.open = true;
    fireEvent(settingsDetails, new Event('toggle'));
    const titleInput = screen.getByLabelText('Title');
    expect(titleInput).toBeEnabled();
    fireEvent.change(titleInput, { target: { value: 'Beta renamed' } });
    expect(within(sidebar).getByRole('button', { name: 'Beta renamed' })).toBeInTheDocument();

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Delete conversation: Gamma' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this conversation?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
    expect(within(sidebar).queryByRole('button', { name: 'Gamma' })).not.toBeInTheDocument();

    await act(async () => {
      finishStream('Partial answer');
    });
    await waitFor(() => expect(within(sidebar).queryByText('Generating')).not.toBeInTheDocument());
  });

  it('auto-names threads whose title was explicitly cleared to empty and clears sidebar search', async () => {
    const t1 = createChatThread(200, 'blank', '');
    const t2 = createChatThread(100, 'other', 'Other topic');
    await saveChatWorkspaceAsync({ activeThreadId: 'blank', threads: [t1, t2] });
    vi.mocked(api.chatStream).mockImplementationOnce(async (_u, _k, _m, _msgs, _s, onDelta) => {
      onDelta({ content: 'Answer' });
      return 'Answer';
    });

    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} /></I18nProvider>);
    const sidebar = await screen.findByRole('complementary', { name: 'Conversations' });
    const search = within(sidebar).getByRole('textbox', { name: 'Search conversations' });
    fireEvent.change(search, { target: { value: 'Other' } });
    expect(within(sidebar).queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(within(sidebar).getByRole('button', { name: 'Other topic' })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'New' } });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Clear all' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();

    const composer = screen.getByRole('textbox', { name: 'Chat message' });
    fireEvent.change(composer, { target: { value: 'How does KV cache work?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(loadChatWorkspace().threads.find((t) => t.id === 'blank')?.title).toBe('How does KV cache work?'));
  });

  it('allows dismissing MCP and stream errors and clears stale stream errors after recovery', async () => {
    vi.mocked(api.mcpListTools).mockRejectedValueOnce(new Error('MCP discovery boom'));
    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} /></I18nProvider>);
    openDetails('MCP tools');
    fireEvent.click(screen.getByRole('button', { name: 'Load MCP tools' }));

    const mcpAlert = await screen.findByText(/MCP discovery boom/);
    fireEvent.click(within(mcpAlert.closest('[role="alert"]')!).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/MCP discovery boom/)).not.toBeInTheDocument();

    vi.mocked(api.chatStream)
      .mockRejectedValueOnce(new Error('First send failed'))
      .mockRejectedValueOnce(new Error('Second send failed'))
      .mockImplementationOnce(async (_u, _k, _m, _msgs, _s, onDelta) => {
        onDelta({ content: 'Recovered output' });
        return 'Recovered output';
      });

    const composer = screen.getByRole('textbox', { name: 'Chat message' });
    fireEvent.change(composer, { target: { value: 'Try one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    const errOne = await screen.findByText(/First send failed/);
    fireEvent.click(within(errOne.closest('[role="alert"]')!).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/First send failed/)).not.toBeInTheDocument();

    fireEvent.change(composer, { target: { value: 'Try two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(/Second send failed/)).toBeVisible();

    fireEvent.change(composer, { target: { value: 'Try three' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Recovered output')).toBeVisible();
    expect(screen.queryByText(/Second send failed/)).not.toBeInTheDocument();
  });

  it('closes pickers on focusin and two-step Escape, and adds MCP filter, bulk selection, descriptions, and empty state', async () => {
    vi.mocked(api.isNativeRuntimeAvailable).mockReturnValue(true);
    vi.mocked(transport.isNativeRuntimeAvailable).mockReturnValue(true);
    const skills: ChatSkill[] = [
      { id: 's1', name: 'review', description: 'Review diff', source: 'agents', path: 'synthetic/review' },
      { id: 's2', name: 'pdf', description: 'PDF helper', source: 'aiolm', path: 'synthetic/pdf' },
    ];
    vi.mocked(getChatPersonalization).mockResolvedValue({ instructions: [], skills, warnings: [] });

    vi.mocked(api.mcpListTools)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { name: 'echo', description: 'Echo text back', input_schema: { type: 'object', properties: {} } },
        { name: 'search', description: 'Search docs', input_schema: { type: 'object', properties: {} } },
      ]);

    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} /></I18nProvider>);
    const skillDetails = openDetails('Skills');
    const skillSummary = within(skillDetails).getByText('Skills', { selector: 'summary' });
    const skillSearch = await within(skillDetails).findByLabelText('Search skills');
    fireEvent.change(skillSearch, { target: { value: 'review' } });
    fireEvent.keyDown(skillSearch, { key: 'Escape' });
    expect(skillSearch).toHaveValue('');
    expect(skillDetails.open).toBe(true);

    fireEvent.keyDown(skillSearch, { key: 'Escape' });
    expect(skillDetails.open).toBe(false);
    expect(skillSummary).toHaveFocus();

    openDetails('Skills');
    expect(within(skillDetails).getByLabelText('Search skills')).toHaveValue('');
    const composer = screen.getByRole('textbox', { name: 'Chat message' });
    fireEvent.focusIn(composer);
    expect(skillDetails.open).toBe(false);

    const mcpDetails = openDetails('MCP tools');
    fireEvent.click(within(mcpDetails).getByRole('button', { name: 'Load MCP tools' }));
    expect(await within(mcpDetails).findByText('No MCP tools are available from enabled servers.')).toBeVisible();

    fireEvent.click(within(mcpDetails).getByRole('button', { name: 'Load MCP tools' }));
    const echoCheckbox = await within(mcpDetails).findByRole('checkbox', { name: 'Synthetic tools · echo' });
    expect(echoCheckbox.closest('label')).not.toHaveTextContent('Echo text back');
    const describedBy = echoCheckbox.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent('Echo text back');

    const mcpSearch = within(mcpDetails).getByLabelText('Search MCP tools');
    fireEvent.change(mcpSearch, { target: { value: 'search' } });
    expect(within(mcpDetails).queryByRole('checkbox', { name: 'Synthetic tools · echo' })).not.toBeInTheDocument();
    expect(within(mcpDetails).getByRole('checkbox', { name: 'Synthetic tools · search' })).toBeInTheDocument();
    fireEvent.change(mcpSearch, { target: { value: '' } });

    fireEvent.click(within(mcpDetails).getByRole('button', { name: 'Select all' }));
    expect(within(mcpDetails).getByRole('checkbox', { name: 'Synthetic tools · echo' })).toBeChecked();
    expect(within(mcpDetails).getByRole('checkbox', { name: 'Synthetic tools · search' })).toBeChecked();

    fireEvent.click(within(mcpDetails).getByRole('button', { name: 'Clear all' }));
    expect(within(mcpDetails).getByRole('checkbox', { name: 'Synthetic tools · echo' })).not.toBeChecked();
    expect(within(mcpDetails).getByRole('checkbox', { name: 'Synthetic tools · search' })).not.toBeChecked();
  });

  it('pastes valid images via native importPastedImage and rejects unsupported or oversized images', async () => {
    vi.mocked(api.isNativeRuntimeAvailable).mockReturnValue(true);
    vi.mocked(transport.isNativeRuntimeAvailable).mockReturnValue(true);
    vi.mocked(api.importPastedImage).mockResolvedValue({
      name: 'clip.png',
      kind: 'image',
      ref: `${'a'.repeat(64)}.png`,
      dataUrl: 'data:image/png;base64,AA==',
      mime: 'image/png',
    });

    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore(true)} /></I18nProvider>);
    const composer = await screen.findByRole('textbox', { name: 'Chat message' });

    const gif = new File([new Uint8Array([71, 73, 70, 56])], 'bad.gif', { type: 'image/gif' });
    fireEvent.paste(composer, { clipboardData: { items: [], files: [gif] } });
    expect(await screen.findByText(/Only PNG, JPEG, and WebP images can be pasted\./)).toBeVisible();

    const oversized = new File([new Uint8Array([137, 80, 78, 71])], 'huge.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { value: 21 * 1024 * 1024 });
    fireEvent.paste(composer, { clipboardData: { items: [], files: [oversized] } });
    expect(await screen.findByText(/Pasted images must be 20 MiB or smaller\./)).toBeVisible();

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const validPng = new File([pngBytes], 'clip.png', { type: 'image/png' });
    Object.assign(validPng, { arrayBuffer: async () => pngBytes.buffer });
    await act(async () => {
      fireEvent.paste(composer, { clipboardData: { items: [], files: [validPng] } });
    });
    await waitFor(() => expect(api.importPastedImage).toHaveBeenCalledWith(expect.any(String), 'image/png', 'clip.png'));
    expect(await screen.findByRole('img', { name: 'clip.png' })).toBeInTheDocument();
  });

  it('supports Ctrl+Enter sending when Enter-to-send is off and global Escape to abort active streaming', async () => {
    let capturedSignal!: AbortSignal;
    let rejectAbort!: (err: Error) => void;
    vi.mocked(api.chatStream).mockImplementationOnce((_u, _k, _m, _msgs, _s, _onDelta, signal) => {
      capturedSignal = signal!;
      return new Promise((_resolve, reject) => {
        rejectAbort = reject;
        signal?.addEventListener('abort', () => rejectAbort(new DOMException('Aborted', 'AbortError')));
      });
    });

    const prefs = defaultPreferences();
    prefs.chat.enterToSend = false;
    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} preferences={prefs} /></I18nProvider>);
    const composer = await screen.findByRole('textbox', { name: 'Chat message' });

    fireEvent.change(composer, { target: { value: 'Shortcut prompt' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(api.chatStream).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    expect(capturedSignal.aborted).toBe(false);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(capturedSignal.aborted).toBe(true));
  });

  it('renders persisted citations, user Copy message & Edit resend, and assistant Continue & Regenerate', async () => {
    const thread = createChatThread(100, 'seeded', 'Seeded chat');
    thread.messages = [
      { role: 'user', content: 'Original prompt' },
      {
        role: 'assistant',
        content: 'Truncated reply',
        finishReason: 'length',
        citations: [{ name: 'guide.md', path: '/docs/guide.md', offset: 24, score: 0.92 }],
      },
    ];
    await saveChatWorkspaceAsync({ activeThreadId: 'seeded', threads: [thread] });

    vi.mocked(api.chatStream)
      .mockImplementationOnce(async (_u, _k, _m, _msgs, _s, onDelta) => {
        onDelta({ content: 'Continued part' });
        return 'Continued part';
      })
      .mockImplementationOnce(async (_u, _k, _m, _msgs, _s, onDelta) => {
        onDelta({ content: 'Regenerated answer' });
        return 'Regenerated answer';
      });

    render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} /></I18nProvider>);
    expect(await screen.findByText('Sources (1)')).toBeInTheDocument();
    expect(screen.getByText(/guide\.md/)).toBeInTheDocument();
    expect(screen.getByText(/#25 · 92%/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith('Original prompt');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Continued part')).toBeInTheDocument();
    expect(api.chatStream).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByText('Regenerated answer')).toBeInTheDocument();
    expect(api.chatStream).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Continued part')).not.toBeInTheDocument();

    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons[0]!);
    expect(screen.getByRole('textbox', { name: 'Chat message' })).toHaveValue('Original prompt');
    expect(screen.queryByText('Regenerated answer')).not.toBeInTheDocument();
  });

  it('keeps long thread titles non-overlapping with compact delete buttons and closes mobile sidebar via backdrop', async () => {
    const first = { ...createChatThread(1, 't1'), title: 'VeryLongUnbrokenThreadTitleForOverlapVerification1234567890' };
    const second = { ...createChatThread(2, 't2'), title: 'Second thread' };
    await saveChatWorkspaceAsync({ activeThreadId: 't1', threads: [first, second] });

    const { container } = render(<I18nProvider initialLocale="en"><ChatPanel store={runningStore()} /></I18nProvider>);
    const titleNode = await screen.findByText(first.title, { selector: '.chat-thread-title' });
    const row = titleNode.closest<HTMLElement>('.chat-thread-row');
    expect(row).not.toBeNull();
    expect(titleNode.closest('.chat-thread-entry')).not.toBeNull();
    expect(titleNode.closest('.chat-thread-title')).not.toBeNull();

    const deleteButton = within(row!).getByRole('button', { name: `Delete conversation: ${first.title}` });
    expect(deleteButton.className).toContain('app-icon-button--sm');
    expect(deleteButton.className).toContain('shrink-0');

    const toggle = container.querySelector<HTMLButtonElement>('.chat-thread-toggle');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    const backdrop = container.querySelector<HTMLDivElement>('.chat-thread-backdrop');
    expect(backdrop).not.toBeNull();
    expect(container.querySelector('.chat-thread-sidebar')?.className).toContain('is-open');

    fireEvent.click(backdrop!);
    expect(container.querySelector('.chat-thread-backdrop')).toBeNull();
    expect(container.querySelector('.chat-thread-sidebar')?.className).not.toContain('is-open');
  });
});
