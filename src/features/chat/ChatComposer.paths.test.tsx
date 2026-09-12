import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import ChatComposer from './ChatComposer';
import MessageBubble from './MessageBubble';

describe('chat path presentation', () => {
  it('hides prefixes in tool arguments and context notices without changing the approved arguments', () => {
    const raw = String.raw`\\?\UNC\server\share\notes.md`;
    const display = String.raw`\\server\share\notes.md`;
    const argumentsValue = { path: raw };
    const approved = vi.fn();
    const attachmentActions = { onAddAttachment: vi.fn(), onAddDocument: vi.fn(), onAddImage: vi.fn() };
    const removeDocument = vi.fn();
    const { container } = render(<I18nProvider initialLocale="en"><ChatComposer
      contextWarning={`Cannot read ${raw}`} contextSources={[raw]}
      mcpCatalog={[]} selectedMcpTools={[]} toggleMcpTool={vi.fn()} loadingMcpTools={false}
      refreshMcpTools={vi.fn()} mcpDefinitions={[]}
      pendingToolCall={{ serverId: 'files', serverName: 'Files', toolName: 'read', argumentsValue,
        call: { id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify(argumentsValue) } } }}
      onApproveTool={() => approved(argumentsValue)} onRejectTool={vi.fn()}
      attachments={[{ name: raw, dataUrl: 'data:image/png;base64,AA==' }]} onRemoveAttachment={vi.fn()} attachmentStatus="ready"
      documents={[{ name: raw, path: raw, text: 'Notes' }]} onRemoveDocument={removeDocument}
      input="" setInput={vi.fn()} onKeyDown={vi.fn()} disabled={false} phase="idle"
      {...attachmentActions} onStop={vi.fn()} aborting={false} onSend={vi.fn()} canSend={false}
      model="model.gguf" displayModel="model.gguf" msgsLength={0} metrics={null} ct={key => key}
    /></I18nProvider>);
    expect(container.textContent).toContain(`Cannot read ${display}`);
    expect(container.textContent).not.toContain('\\\\?\\');
    expect(JSON.parse(container.querySelector('pre')!.textContent!)).toEqual({ path: display });
    fireEvent.click(screen.getByRole('button', { name: 'approveTool' }));
    expect(approved).toHaveBeenCalledWith({ path: raw });
    expect(screen.getByRole('img')).toHaveAttribute('alt', display);
    const removeButtons = screen.getAllByRole('button', { name: `removeAttachment: ${display}` });
    fireEvent.click(removeButtons[1]);
    expect(removeDocument).toHaveBeenCalledWith(raw);
  });

  it('cleans restored attachment labels while preserving conversation content and attachment data', () => {
    const raw = String.raw`\\?\C:\docs\notes.md`;
    const display = String.raw`C:\docs\notes.md`;
    const message = {
      role: 'user' as const, content: `Explain the prefix in ${raw}`,
      documents: [{ name: raw, path: raw, text: 'Notes' }],
      images: [{ name: raw, dataUrl: 'data:image/png;base64,AA==' }],
    };
    render(<MessageBubble message={message} index={0} messageCount={1} phase="idle" copied={false} compact={false} locale="en" onCopy={vi.fn()} />);
    expect(screen.getByText(`Document · ${display}`)).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('alt', display);
    expect(screen.getByText(message.content)).toBeInTheDocument();
    expect(message.documents[0].path).toBe(raw);
  });
});
