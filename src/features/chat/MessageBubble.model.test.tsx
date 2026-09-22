import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import MessageBubble from './MessageBubble';
import { defaultChatWorkspace, loadChatWorkspace, saveChatWorkspace, type ChatHistoryMessage } from './chatHistory';

function bubble(message: ChatHistoryMessage) {
  return <MessageBubble message={message} index={0} messageCount={1} phase="idle" copied={false} compact={false} locale="ko" onCopy={vi.fn()} />;
}

it('displays the recorded model and icon with a readable filename', () => {
  const { container } = render(bubble({ role: 'assistant', content: 'Answer', model: '/library/community/Qwen-example.gguf' }));
  expect(screen.getByText('Qwen-example.gguf')).toBeVisible();
  expect(screen.getByText('응답 모델:')).toBeInTheDocument();
  expect(container.querySelector('.model-family-icon')).toHaveAttribute('src', '/model-icons/qwen.svg');
});

it('labels legacy answers without attributing them to the currently selected model', () => {
  const { rerender } = render(bubble({ role: 'assistant', content: 'Old answer' }));
  expect(screen.getByText('모델 기록 없음')).toBeVisible();
  rerender(bubble({ role: 'user', content: 'Question' }));
  expect(screen.queryByText('모델 기록 없음')).not.toBeInTheDocument();
});

it('preserves different response models through conversation saving and loading', () => {
  const workspace = defaultChatWorkspace(100);
  workspace.threads[0].messages = [
    { role: 'assistant', content: 'First', model: 'Qwen-example.gguf' },
    { role: 'assistant', content: 'Second', model: 'gemma-example.gguf', interrupted: true },
    { role: 'assistant', content: 'Legacy' },
  ];
  let saved = '';
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  saveChatWorkspace(workspace, storage);
  expect(loadChatWorkspace(storage).threads[0].messages).toEqual(workspace.threads[0].messages);
});
