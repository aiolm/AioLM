import type { ComponentProps } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import ChatComposer from './ChatComposer';
import { chatQueueCopy } from './chatQueueCopy';

const copy = chatQueueCopy.en;

function props(): ComponentProps<typeof ChatComposer> {
  return {
    contextWarning: null, contextSources: [], mcpCatalog: [], selectedMcpTools: [], toggleMcpTool: vi.fn(), loadingMcpTools: false,
    refreshMcpTools: vi.fn(), mcpDefinitions: [], pendingToolCall: null, toolCallInProgress: false, onApproveTool: vi.fn(), onRejectTool: vi.fn(),
    attachments: [], onRemoveAttachment: vi.fn(), attachmentStatus: 'idle', documents: [], onRemoveDocument: vi.fn(),
    input: 'Next question', setInput: vi.fn(), onKeyDown: vi.fn(), disabled: false, phase: 'decoding', onAddAttachment: vi.fn(),
    onStop: vi.fn(), aborting: false, onSend: vi.fn(), canSend: false, msgsLength: 2, responseState: 'none', ct: key => key,
    canQueue: true, onQueue: vi.fn(), onSteer: vi.fn(), onSteerQueued: vi.fn(), onRemoveQueued: vi.fn(), onResumeQueue: vi.fn(),
  };
}

const view = (overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) =>
  render(<I18nProvider initialLocale="en"><ChatComposer {...props()} {...overrides} /></I18nProvider>);
const actionLabels = () => screen.getAllByRole('button').map(button => button.textContent).filter(label => label === copy.queue || label === copy.steer);

describe('composer queue actions', () => {
  it('offers both actions next to Stop during a reply, preferred action first', () => {
    const options = props();
    const { rerender } = render(<I18nProvider initialLocale="en"><ChatComposer {...options} /></I18nProvider>);
    expect(actionLabels()).toEqual([copy.queue, copy.steer]);
    expect(screen.getByRole('button', { name: 'stop' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'send' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.steer }));
    expect(options.onSteer).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: copy.queue }));
    expect(options.onQueue).toHaveBeenCalledOnce();

    rerender(<I18nProvider initialLocale="en"><ChatComposer {...options} busySubmit="steer" /></I18nProvider>);
    expect(actionLabels()).toEqual([copy.steer, copy.queue]);
  });

  it('offers sending now during an MCP approval, which has no Stop button', () => {
    view({ phase: 'idle', pendingToolCall: { serverId: 's', serverName: 'Server', toolName: 'lookup', argumentsValue: {},
      call: { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } } } });
    expect(actionLabels()).toEqual([copy.queue, copy.steer]);
    expect(screen.queryByRole('button', { name: 'stop' })).not.toBeInTheDocument();
  });

  it('offers only queueing while nothing is running to interrupt, and nothing without a draft', () => {
    const { rerender } = view({ phase: 'idle', disabled: true, loadingModel: true });
    expect(actionLabels()).toEqual([copy.queue]);
    rerender(<I18nProvider initialLocale="en"><ChatComposer {...props()} input="" canQueue={false} /></I18nProvider>);
    expect(actionLabels()).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveAttribute('placeholder', copy.placeholderBusy);
  });

  it('keeps a plain Send when the conversation is ready and nothing waits', () => {
    const options = props();
    render(<I18nProvider initialLocale="en"><ChatComposer {...options} phase="idle" canSend /></I18nProvider>);
    expect(actionLabels()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(options.onSend).toHaveBeenCalledOnce();
  });

  it('lists queued messages with their attachments and lets each be sent now or removed', () => {
    const options = props();
    render(<I18nProvider initialLocale="en"><ChatComposer {...options}
      steering={{ id: 'steer', text: 'Steering message', images: [], documents: [], skillIds: [] }}
      queue={[
        { id: 'a', text: 'First   queued\nmessage', images: [], documents: [{ name: 'notes.md', path: 'notes.md', text: 'Notes' }], skillIds: [] },
        { id: 'b', text: 'Second queued', images: [], documents: [], skillIds: [] },
      ]} /></I18nProvider>);
    const region = screen.getByRole('region', { name: copy.queued.replace('{count}', '3') });
    const items = within(region).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(copy.next);
    expect(items[0]).toHaveTextContent('Steering message');
    // The steering message is already on its way; it has no actions of its own.
    expect(within(items[0]!).queryByRole('button')).not.toBeInTheDocument();
    expect(items[1]).toHaveTextContent('First queued message');
    expect(items[1]).toHaveTextContent(copy.attachments.replace('{count}', '1'));

    fireEvent.click(within(items[1]!).getByRole('button', { name: copy.sendNow }));
    expect(options.onSteerQueued).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: `${copy.remove}: Second queued` }));
    expect(options.onRemoveQueued).toHaveBeenCalledWith('b');
    expect(screen.queryByText(copy.paused)).not.toBeInTheDocument();
  });

  it('explains a paused queue and resumes it', () => {
    const options = props();
    render(<I18nProvider initialLocale="en"><ChatComposer {...options} phase="idle" queuePaused
      queue={[{ id: 'a', text: 'Waiting', images: [], documents: [], skillIds: [] }]} /></I18nProvider>);
    expect(screen.getByText(copy.paused)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.resume }));
    expect(options.onResumeQueue).toHaveBeenCalledOnce();
  });
});
