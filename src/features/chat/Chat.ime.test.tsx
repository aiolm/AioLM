import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPanel from './Chat';
import * as api from '../../shared/api/index';
import { I18nProvider, type Locale } from '../../shared/i18n/i18n';
import { chatText } from '../../shared/i18n/chatI18n';
import { defaultPreferences } from '../../shared/config/preferences';
import { createTestStore } from '../../testing/appStore';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null }));
vi.mock('../../shared/api/transport', () => ({ isNativeRuntimeAvailable: () => false }));
vi.mock('../../shared/api/index', () => ({
  chatStream: vi.fn(), serverActivity: vi.fn(async () => undefined),
  sessionList: vi.fn(async () => []), normalizeSessionList: (value: unknown) => Array.isArray(value) ? value : [],
  mcpListServers: vi.fn(async () => []), mcpListTools: vi.fn(async () => []),
}));

async function composer(enterToSend = true, locale: Locale = 'en') {
  const store = createTestStore();
  store.status = { state: 'running', url: 'http://127.0.0.1:8080', api_key: 'synthetic-key', model: 'model.gguf' };
  const preferences = defaultPreferences();
  preferences.chat.enterToSend = enterToSend;
  render(<I18nProvider initialLocale={locale}><ChatPanel store={store} preferences={preferences} /></I18nProvider>);
  await screen.findByRole('log', { name: chatText[locale].conversation });
  return screen.getByRole('textbox', { name: chatText[locale].chatMessage }) as HTMLTextAreaElement;
}

function nativeInput(textarea: HTMLTextAreaElement, value: string, inputType: string, data: string) {
  fireEvent.input(textarea, { target: { value }, inputType, data, isComposing: false });
}

function koreanDraft(textarea: HTMLTextAreaElement) {
  // Some WKWebViews emit input before keydown 229 and no composition events.
  for (const [value, key, inputType] of [['ㅎ', 'ㅎ', 'insertText'], ['하', 'ㅏ', 'insertReplacementText'], ['한', 'ㄴ', 'insertReplacementText']] as const) {
    nativeInput(textarea, value, inputType, value);
    fireEvent.keyDown(textarea, { key, keyCode: 229, isComposing: false });
    fireEvent.keyUp(textarea, { key });
  }
}

async function expectNoRequest(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => { await Promise.resolve(); });
  expect(api.serverActivity).not.toHaveBeenCalled();
  expect(api.chatStream).not.toHaveBeenCalled();
  expect(textarea).toHaveValue(value);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.chatStream).mockImplementation(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ content: 'Accepted.' });
    return 'Accepted.';
  });
});

describe('chat Enter and IME confirmation', () => {
  it.each([
    { locale: 'en', hint: 'Message (Enter for newline; use the send button)', send: 'Send message' },
    { locale: 'ko', hint: '메시지 (Enter 줄바꿈, 전송 버튼으로 전송)', send: '메시지 전송' },
    { locale: 'ja', hint: 'メッセージ（Enterで改行、送信ボタンで送信）', send: 'メッセージを送信' },
    { locale: 'zh', hint: '消息（Enter 换行，使用发送按钮发送）', send: '发送消息' },
  ] as const)('explains newline Enter and sends only with the button when Enter-to-send is off ($locale)', async ({ locale, hint, send }) => {
    const textarea = await composer(false, locale);
    expect(textarea).toHaveAttribute('placeholder', hint);
    const draft = 'First line\nSecond line';
    nativeInput(textarea, draft, 'insertFromPaste', draft);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 })).toBe(true);
    await expectNoRequest(textarea, draft);
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 });
    fireEvent.click(screen.getByRole('button', { name: send }));
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    expect(vi.mocked(api.chatStream).mock.calls[0][3]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: draft }),
    ]));
  });

  it('consumes a WK replacement commit before Enter and sends only with the next Enter', async () => {
    const textarea = await composer();
    expect(textarea).toHaveAttribute('placeholder', 'Message (Enter to send, Shift+Enter for newline)');
    koreanDraft(textarea);
    nativeInput(textarea, '한', 'insertReplacementText', '한');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, isComposing: false })).toBe(false);
    await expectNoRequest(textarea, '한');
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
  });

  it('consumes compositionend before Enter without losing the confirmed draft', async () => {
    const textarea = await composer();
    fireEvent.compositionStart(textarea);
    nativeInput(textarea, '한', 'insertCompositionText', '한');
    fireEvent.compositionEnd(textarea, { data: '한' });
    nativeInput(textarea, '한', 'insertCompositionText', '한');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 })).toBe(false);
    await expectNoRequest(textarea, '한');
  });

  it('lets a pending native Enter commit and ignores its later compositionend and repeats', async () => {
    const textarea = await composer();
    koreanDraft(textarea);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 })).toBe(true);
    fireEvent.compositionEnd(textarea, { data: '한' });
    nativeInput(textarea, '한', 'insertFromComposition', '한');
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, repeat: true });
    await expectNoRequest(textarea, '한');
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
  });

  it.each([{ keyCode: 13, isComposing: true }, { keyCode: 229, isComposing: false }])('does not consume another Enter after a marked Enter (%j)', async fields => {
    const textarea = await composer();
    fireEvent.compositionStart(textarea);
    nativeInput(textarea, '한', 'insertCompositionText', '한');
    fireEvent.keyDown(textarea, { key: 'Enter', ...fields });
    fireEvent.input(textarea, { target: { value: '한' }, inputType: 'insertCompositionText', data: '한', isComposing: true });
    fireEvent.compositionEnd(textarea, { data: '한' });
    await expectNoRequest(textarea, '한');
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
  });

  it.each(['pointer', 'mouse', 'blur', 'paste', 'other-key'] as const)('sends already confirmed text after %s without an extra Enter', async action => {
    const textarea = await composer();
    koreanDraft(textarea);
    if (action === 'pointer') fireEvent.pointerDown(textarea);
    if (action === 'mouse') fireEvent.mouseDown(textarea);
    if (action === 'blur') { fireEvent.blur(textarea); fireEvent.focus(textarea); }
    if (action === 'paste') nativeInput(textarea, '한 pasted', 'insertFromPaste', ' pasted');
    if (action === 'other-key') fireEvent.keyDown(textarea, { key: 'ArrowLeft', keyCode: 37 });
    // Late final input/end events must not re-arm text confirmed by interaction.
    nativeInput(textarea, textarea.value, 'insertCompositionText', '한');
    fireEvent.compositionEnd(textarea, { data: '한' });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
  });

  it('keeps normal English Enter sending, including non-IME replacement text', async () => {
    const textarea = await composer();
    nativeInput(textarea, 'hello', 'insertText', 'hello');
    nativeInput(textarea, 'hello', 'insertReplacementText', 'hello');
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
  });

  it('does not treat a modifier key alone as confirming marked text', async () => {
    const textarea = await composer();
    koreanDraft(textarea);
    fireEvent.keyDown(textarea, { key: 'Shift', keyCode: 16 });
    fireEvent.keyUp(textarea, { key: 'Shift', keyCode: 16 });
    nativeInput(textarea, '한', 'insertReplacementText', '한');
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await expectNoRequest(textarea, '한');
  });

  it.each([{ enterToSend: true, shiftKey: true }, { enterToSend: false, shiftKey: false }])('keeps newline Enter available (%j)', async ({ enterToSend, shiftKey }) => {
    const textarea = await composer(enterToSend);
    nativeInput(textarea, 'hello', 'insertText', 'hello');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, shiftKey })).toBe(true);
    await expectNoRequest(textarea, 'hello');
  });

  it.each([{ enterToSend: true, shiftKey: true }, { enterToSend: false, shiftKey: false }])('confirms Korean before making newline Enter available (%j)', async ({ enterToSend, shiftKey }) => {
    const textarea = await composer(enterToSend);
    koreanDraft(textarea);
    nativeInput(textarea, '한', 'insertReplacementText', '한');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, shiftKey })).toBe(false);
    await expectNoRequest(textarea, '한');
    fireEvent.keyUp(textarea, { key: 'Enter', keyCode: 13 });
    expect(fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13, shiftKey })).toBe(true);
    await expectNoRequest(textarea, '한');
  });

  it('clears composition state when the draft is emptied', async () => {
    const textarea = await composer();
    koreanDraft(textarea);
    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
  });
});
