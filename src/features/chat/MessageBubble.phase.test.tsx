import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import MessageBubble from './MessageBubble';
import type { ChatHistoryMessage } from './chatHistory';
import type { ChatPhase } from './chatSendTypes';

function bubble(message: ChatHistoryMessage, phase: ChatPhase, index = 0, messageCount = 1) {
  return <MessageBubble message={message} index={index} messageCount={messageCount} phase={phase} copied={false} compact={false} locale="ko" onCopy={vi.fn()} />;
}

it('keeps progress visible before answer text, including reasoning-only decoding, then clears it on completion', () => {
  const pending: ChatHistoryMessage = { role: 'assistant', content: '' };
  const view = render(bubble(pending, 'prefill'));
  expect(screen.getByRole('status')).toBeVisible();
  // Buffered output and tool-call generation leave the answer empty too.
  view.rerender(bubble(pending, 'decoding'));
  expect(screen.getByRole('status')).toBeVisible();
  const reasoning = { ...pending, reasoning: 'Compare the available options.' };
  view.rerender(bubble(reasoning, 'decoding'));
  expect(screen.getByRole('status')).toBeVisible();
  expect(screen.getByText(reasoning.reasoning)).not.toBeVisible();
  view.rerender(bubble({ ...reasoning, finishReason: 'stop' }, 'idle'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('does not add request progress to user messages or completed historical replies', () => {
  const view = render(bubble({ role: 'user', content: '' }, 'prefill'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(bubble({ role: 'assistant', content: '' }, 'prefill', 0, 2));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(bubble({ role: 'assistant', content: '', finishReason: 'stop' }, 'prefill'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
