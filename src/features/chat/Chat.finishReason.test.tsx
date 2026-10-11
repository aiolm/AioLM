import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import { translate } from '../../shared/i18n/i18nUnified';
import ChatComposer from './ChatComposer';
import MessageBubble from './MessageBubble';
import { defaultChatWorkspace, loadChatWorkspace, saveChatWorkspace } from './chatHistory';

it('keeps the output limit notice with the saved partial answer after reloading', () => {
  const workspace = defaultChatWorkspace(100);
  workspace.threads[0].messages = [{ role: 'assistant', content: 'Partial answer', finishReason: 'length' }];
  let raw = '';
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  saveChatWorkspace(workspace, storage);
  const message = loadChatWorkspace(storage).threads[0].messages[0];
  render(<MessageBubble message={message} index={0} messageCount={1} phase="idle" copied={false} compact={false} locale="ko" onCopy={vi.fn()} />);
  expect(screen.getByText(/출력 토큰 한도에 도달/)).toBeVisible();
  expect(screen.getByText('Partial answer')).toBeVisible();
  expect(screen.getByRole('button', { name: '복사' })).toBeEnabled();
});

it('shows the latest response limit in the composer without replacing active generation status', () => {
  const props: ComponentProps<typeof ChatComposer> = {
    contextWarning: null, contextSources: [], mcpCatalog: [], selectedMcpTools: [], toggleMcpTool: vi.fn(),
    loadingMcpTools: false, refreshMcpTools: vi.fn(), mcpDefinitions: [], pendingToolCall: null,
    onApproveTool: vi.fn(), onRejectTool: vi.fn(), attachments: [], onRemoveAttachment: vi.fn(), attachmentStatus: 'idle',
    documents: [], onRemoveDocument: vi.fn(), input: '', setInput: vi.fn(), onKeyDown: vi.fn(), disabled: false,
    phase: 'idle', onAddAttachment: vi.fn(), onStop: vi.fn(), aborting: false, onSend: vi.fn(), canSend: false,
    msgsLength: 2, responseState: 'complete', responseFinishReason: 'length', ct: key => translate('en', `chat.${key}`),
  };
  const view = render(<I18nProvider initialLocale="en"><ChatComposer {...props} /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Output token limit reached');
  expect(screen.getByRole('status')).not.toHaveTextContent('Response complete');
  view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...props} phase="thinking" /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for the first token');
  view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...props} responseFinishReason="stop" /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Response complete');
  view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...props} responseState="failed" /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Request failed');
  expect(screen.getByRole('status')).not.toHaveTextContent('Output token limit reached');
  view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...props} responseState="interrupted" /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Generation stopped');
  expect(screen.getByRole('status')).not.toHaveTextContent('Response complete');
  view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...props} responseState="none" msgsLength={1} /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent(/^1 messages$/);
  view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...props} responseState="none" msgsLength={0} /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Empty conversation');
});
