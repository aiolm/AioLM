import type { ComponentProps } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import ChatComposer from './ChatComposer';
import ChatSkillPicker from './ChatSkillPicker';

function props(): ComponentProps<typeof ChatComposer> {
  return {
    contextWarning: null, contextSources: [], mcpCatalog: [{ serverId: 'catalog', serverName: 'Catalog', tool: { name: 'lookup', input_schema: {} } }],
    selectedMcpTools: ['catalog:lookup'], toggleMcpTool: vi.fn(), loadingMcpTools: false, refreshMcpTools: vi.fn(), mcpDefinitions: [],
    pendingToolCall: null, onApproveTool: vi.fn(), onRejectTool: vi.fn(), attachments: [], onRemoveAttachment: vi.fn(), attachmentStatus: 'idle',
    documents: [], onRemoveDocument: vi.fn(), input: 'Next question', setInput: vi.fn(), onKeyDown: vi.fn(), disabled: false, phase: 'idle',
    onAddAttachment: vi.fn(), onStop: vi.fn(), aborting: false, onSend: vi.fn(), canSend: true, msgsLength: 2, responseState: 'complete', ct: key => key,
  };
}

describe('composer turn locks', () => {
  it('keeps only one tool picker open without losing the draft or its send action', () => {
    const options = props();
    options.skillPicker = <ChatSkillPicker native catalog={[]} warnings={[]} loadError={null} loading={false} loaded
      selectedSkillIds={[]} onToggleSkill={vi.fn()} onRefresh={vi.fn()} locked={false} closeLabel="close" pt={key => key} />;
    render(<I18nProvider initialLocale="en"><ChatComposer {...options} /></I18nProvider>);
    const mcp = screen.getByText('mcpTools').closest('details')!;
    const skills = screen.getByText('skills').closest('details')!;
    mcp.open = true;
    fireEvent(mcp, new Event('toggle'));
    expect(mcp).toHaveAttribute('open');
    skills.open = true;
    fireEvent(skills, new Event('toggle'));
    expect(skills).toHaveAttribute('open');
    expect(mcp).not.toHaveAttribute('open');
    mcp.open = true;
    fireEvent(mcp, new Event('toggle'));
    expect(skills).not.toHaveAttribute('open');
    fireEvent.click(within(mcp).getByRole('button', { name: 'close' }));
    expect(mcp).not.toHaveAttribute('open');
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveValue('Next question');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(options.onSend).toHaveBeenCalledOnce();
  });

  it('locks draft and tool changes during approval while preserving the draft and approval actions', () => {
    const options = props();
    options.pendingToolCall = { serverId: 'catalog', serverName: 'Catalog', toolName: 'lookup', argumentsValue: {},
      call: { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } } };
    const view = render(<I18nProvider initialLocale="en"><ChatComposer {...options} /></I18nProvider>);
    const details = screen.getByText('mcpTools').closest('details')!;
    details.open = true;
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveValue('Next question');
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveAttribute('placeholder', 'placeholder');
    expect(within(details).getByRole('checkbox')).toBeDisabled();
    for (const name of ['attachFile', 'send', 'loadMcpTools']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'approveTool' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'rejectTool' })).toBeEnabled();
    expect(document.querySelector('.chat-composer-status')).toHaveTextContent('mcpApprovalRequired');
    expect(document.querySelector('.chat-composer-status')).not.toHaveTextContent('responseReady');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    fireEvent.click(screen.getByRole('button', { name: 'attachFile' }));
    fireEvent.click(screen.getByRole('button', { name: 'loadMcpTools' }));
    expect(options.onSend).not.toHaveBeenCalled();
    expect(options.onAddAttachment).not.toHaveBeenCalled();
    expect(options.refreshMcpTools).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'approveTool' }));
    expect(options.onApproveTool).toHaveBeenCalledOnce();

    view.rerender(<I18nProvider initialLocale="en"><ChatComposer {...options} pendingToolCall={null} /></I18nProvider>);
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toHaveValue('Next question');
    expect(screen.getByRole('button', { name: 'send' })).toBeEnabled();
  });

  it('keeps input editable but prevents sending while an attachment is still reading', () => {
    const options = props();
    render(<I18nProvider initialLocale="en"><ChatComposer {...options} attachmentStatus="reading" /></I18nProvider>);
    expect(screen.getByRole('textbox', { name: 'chatMessage' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'attachFile' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(options.onSend).not.toHaveBeenCalled();
  });
});
