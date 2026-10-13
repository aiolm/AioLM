import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ChatConversationHeader from './ChatConversationHeader';
import { createChatThread } from './chatHistory';
import { chatText } from '../../shared/i18n/chatI18n';

afterEach(cleanup);

function renderHeader() {
  const update = vi.fn();
  render(<ChatConversationHeader threadPanelOpen={false} setThreadPanelOpen={vi.fn()}
    activeThread={createChatThread(1, 'synthetic-thread', 'Synthetic conversation')}
    activeProjectName={null} phase="idle" onUpdateThread={update}
    sessionLabel="Model session" sessionOptions={[{ id: 'default', label: 'Default session' }]}
    selectedSessionId="default" model="" onSelectSession={vi.fn()} ct={key => chatText.en[key]} />);
  return update;
}

it('keeps the compact conversation settings control named and exposes the existing title editor', () => {
  const update = renderHeader();
  const summary = screen.getByLabelText('Conversation settings', { selector: 'summary' });
  expect(summary).toHaveAccessibleName('Conversation settings');
  expect(summary).toHaveAttribute('title', 'Conversation settings');
  fireEvent.click(summary);
  expect(summary.closest('details')).toHaveAttribute('open');
  const title = screen.getByLabelText('Title');
  expect(title).toHaveValue('Synthetic conversation');
  fireEvent.change(title, { target: { value: 'Edited synthetic conversation' } });
  expect(update).toHaveBeenCalledExactlyOnceWith({ title: 'Edited synthetic conversation' });
});

it('returns keyboard focus to the named summary when Escape closes conversation settings', () => {
  renderHeader();
  const summary = screen.getByLabelText('Conversation settings', { selector: 'summary' });
  fireEvent.click(summary);
  const title = screen.getByLabelText('Title');
  title.focus();
  expect(title).toHaveFocus();
  fireEvent.keyDown(title, { key: 'Escape' });
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(summary).toHaveFocus();
  expect(summary).toHaveAccessibleName('Conversation settings');
});
