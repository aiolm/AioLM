import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import MessageBubble from './MessageBubble';
import type { ChatHistoryMessage } from '../../shared/api/conversationTypes'
import type { ChatPhase } from './chatSendTypes';

function bubble(message: ChatHistoryMessage, phase: ChatPhase, isLast = true) {
  return <MessageBubble message={message} index={0} isLast={isLast} phase={phase} copied={false} compact={false} locale="ko" onCopy={vi.fn()} />;
}

it('keeps progress visible before answer text, including reasoning-only decoding, then clears it on completion', () => {
  const pending: ChatHistoryMessage = { role: 'assistant', content: '' };
  const view = render(bubble(pending, 'prefill'));
  expect(screen.getByRole('status')).toBeVisible();
  expect(view.container.querySelector('.chat-message-row')).not.toHaveClass('chat-message-completed');
  // Buffered output and tool-call generation leave the answer empty too.
  view.rerender(bubble(pending, 'decoding'));
  expect(screen.getByRole('status')).toBeVisible();
  const reasoning = { ...pending, reasoning: 'Compare the available options.' };
  view.rerender(bubble(reasoning, 'decoding'));
  expect(screen.getByRole('status')).toBeVisible();
  expect(screen.getByText(reasoning.reasoning)).not.toBeVisible();
  view.rerender(bubble({ ...reasoning, finishReason: 'stop' }, 'idle'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(view.container.querySelector('.chat-message-row')).toHaveClass('chat-message-completed');
});

it('does not add request progress to user messages or completed historical replies', () => {
  const view = render(bubble({ role: 'user', content: '' }, 'prefill'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(bubble({ role: 'assistant', content: '' }, 'prefill', false));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(bubble({ role: 'assistant', content: '', finishReason: 'stop' }, 'prefill'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('keeps reasoning selectable and offers its collapse action as a native button', () => {
  const reasoning = 'Compare the available options.';
  const view = render(bubble({ role: 'assistant', content: 'Answer', reasoning }, 'idle'));
  const details = view.container.querySelector('details')!;
  details.open = true;
  const collapse = screen.getByRole('button', { name: reasoning });
  expect(collapse.tagName).toBe('BUTTON');
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(collapse);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.click(collapse);
  expect(details.open).toBe(true);
  selection.removeAllRanges();
  fireEvent.click(collapse);
  expect(details.open).toBe(false);
});
