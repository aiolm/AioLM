import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ChatConversationHeader from './ChatConversationHeader';
import { createChatThread } from './chatHistory';
import { chatText } from '../../shared/i18n/chatI18n';

afterEach(cleanup);

it('keeps media ordering opt-in and sends the explicit conversation choice', () => {
  const update = renderHeader();
  fireEvent.click(screen.getByLabelText('Conversation settings', { selector: 'summary' }));
  const choice = screen.getByRole('checkbox', { name: 'Attachments before message text' });
  expect(choice).not.toBeChecked();
  expect(choice).toHaveAccessibleDescription(/conversation history/);
  fireEvent.click(choice);
  expect(update).toHaveBeenCalledExactlyOnceWith({ mediaBeforeText: true });
});

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

function renderTargetHeader() {
  const session = vi.fn();
  const embedding = vi.fn();
  const thread = createChatThread(1, 'synthetic-target-thread', 'Synthetic target conversation');
  function TargetHeader() {
    const [selectedSession, setSelectedSession] = useState('default');
    const [selectedEmbedding, setSelectedEmbedding] = useState('automatic');
    return <ChatConversationHeader threadPanelOpen={false} setThreadPanelOpen={vi.fn()}
      activeThread={thread} activeProjectName={null} phase="idle" onUpdateThread={vi.fn()}
      sessionLabel="Model session"
      sessionOptions={[{ id: 'default', label: 'Default session' }, { id: 'worker', label: 'Worker session' }]}
      selectedSessionId={selectedSession} model=""
      onSelectSession={value => { setSelectedSession(value); session(value); }}
      embedding={{ label: 'Embedding model', hint: 'Choose a synthetic embedding target.', value: selectedEmbedding,
        options: [{ value: 'automatic', label: 'Automatic embedding' }, { value: 'local', label: 'Local embedding' }],
        onChange: value => { setSelectedEmbedding(value); embedding(value); } }}
      ct={key => chatText.en[key]} />;
  }
  render(<TargetHeader />);
  return { session, embedding };
}

it.each([
  { kind: 'session' as const, label: 'Model session', value: 'worker', option: 'Worker session' },
  { kind: 'embedding' as const, label: 'Embedding model', value: 'local', option: 'Local embedding' },
])('keeps conversation settings open and focus visible after choosing $label', ({ kind, label, value, option }) => {
  const callbacks = renderTargetHeader();
  const summary = screen.getByLabelText('Conversation settings', { selector: 'summary' });
  fireEvent.click(summary);
  const details = summary.closest('details');
  const combo = screen.getByRole('combobox', { name: label });
  combo.focus();
  fireEvent.click(combo);
  const menu = screen.getByRole('listbox', { name: label });
  expect(document.body).toContainElement(menu);
  expect(details).not.toContainElement(menu);
  expect(combo).toHaveAttribute('aria-controls', menu.id);
  const choice = screen.getByRole('option', { name: option });
  fireEvent.pointerDown(choice);
  fireEvent.mouseDown(choice);
  fireEvent.mouseUp(choice);
  fireEvent.click(choice);
  expect(callbacks[kind]).toHaveBeenCalledExactlyOnceWith(value);
  expect(callbacks[kind === 'session' ? 'embedding' : 'session']).not.toHaveBeenCalled();
  expect(details).toHaveAttribute('open');
  expect(combo).toHaveTextContent(option);
  expect(combo).toHaveAttribute('aria-expanded', 'false');
  expect(combo).toBeVisible();
  expect(combo).toHaveFocus();
});

it('still closes conversation settings for an unrelated listbox or the document body', () => {
  const callbacks = renderTargetHeader();
  render(<ul id="unrelated-listbox" role="listbox" aria-label="Unrelated choices">
    <li role="option" aria-selected="false">Unrelated option</li>
  </ul>);
  const summary = screen.getByLabelText('Conversation settings', { selector: 'summary' });
  const details = summary.closest('details');
  fireEvent.click(summary);
  const combo = screen.getByRole('combobox', { name: 'Model session' });
  fireEvent.click(combo);
  const ownedMenu = screen.getByRole('listbox', { name: 'Model session' });
  expect(combo).toHaveAttribute('aria-controls', ownedMenu.id);
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Unrelated option' }));
  expect(details).not.toHaveAttribute('open');
  fireEvent.pointerDown(document.body);
  fireEvent.click(summary);
  expect(details).toHaveAttribute('open');
  fireEvent.mouseDown(document.body);
  expect(details).not.toHaveAttribute('open');
  expect(callbacks.session).not.toHaveBeenCalled();
  expect(callbacks.embedding).not.toHaveBeenCalled();
});

it('lets the select consume Escape before closing settings and returning focus to the summary', () => {
  const callbacks = renderTargetHeader();
  const summary = screen.getByLabelText('Conversation settings', { selector: 'summary' });
  const details = summary.closest('details');
  fireEvent.click(summary);
  const combo = screen.getByRole('combobox', { name: 'Model session' });
  combo.focus();
  fireEvent.keyDown(combo, { key: 'ArrowDown' });
  expect(screen.getByRole('listbox', { name: 'Model session' })).toBeInTheDocument();
  fireEvent.keyDown(combo, { key: 'ArrowDown' });
  fireEvent.keyDown(combo, { key: 'Escape' });
  expect(combo).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('listbox', { name: 'Model session' })).not.toBeInTheDocument();
  expect(details).toHaveAttribute('open');
  expect(combo).toHaveTextContent('Default session');
  expect(combo).toBeVisible();
  expect(combo).toHaveFocus();
  expect(callbacks.session).not.toHaveBeenCalled();
  expect(callbacks.embedding).not.toHaveBeenCalled();
  fireEvent.keyDown(combo, { key: 'Escape' });
  expect(details).not.toHaveAttribute('open');
  expect(summary).toHaveFocus();
});
