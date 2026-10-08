import type { ComponentProps } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import { chatText } from '../../shared/i18n/chatI18n';
import type { Locale } from '../../shared/i18n/i18nCatalog';
import type { ImageAttachment } from './chatTypes';
import ChatComposer from './ChatComposer';

const legacyImage: ImageAttachment = { name: 'picture.png', dataUrl: 'data:image/png;base64,AA==' };
const audio: ImageAttachment = { name: 'speech.wav', kind: 'audio', ref: `${'a'.repeat(64)}.wav`, dataUrl: '' };
const video: ImageAttachment = { name: 'clip.mp4', kind: 'video', ref: `${'b'.repeat(64)}.mp4`, dataUrl: '' };
const cases: { name: string; attachments: ImageAttachment[] }[] = [
  { name: 'a legacy image without a kind', attachments: [legacyImage] },
  { name: 'audio', attachments: [audio] },
  { name: 'video', attachments: [video] },
  { name: 'mixed image, audio and video', attachments: [legacyImage, audio, video] },
];
const expectedMediaLabel: Record<Locale, string> = {
  en: 'Pending media attachments',
  ko: '첨부할 미디어',
  ja: '保留中のメディア添付',
  zh: '待处理媒体附件',
};

function props(locale: Locale, attachments: ImageAttachment[]): ComponentProps<typeof ChatComposer> {
  return {
    locale, contextWarning: null, contextSources: [], mcpCatalog: [], selectedMcpTools: [],
    toggleMcpTool: vi.fn(), loadingMcpTools: false, refreshMcpTools: vi.fn(), mcpDefinitions: [],
    pendingToolCall: null, onApproveTool: vi.fn(), onRejectTool: vi.fn(), attachments,
    onRemoveAttachment: vi.fn(), attachmentStatus: 'ready',
    documents: [{ name: 'notes.txt', path: '/synthetic/documents/notes.txt', text: 'Synthetic notes' }],
    onRemoveDocument: vi.fn(), input: '', setInput: vi.fn(), onKeyDown: vi.fn(), disabled: false, phase: 'idle',
    onAddAttachment: vi.fn(), onStop: vi.fn(), aborting: false, onSend: vi.fn(), canSend: false,
    msgsLength: 0, ct: key => chatText[locale][key],
  };
}

describe.each(['en', 'ko', 'ja', 'zh'] as const)('pending media attachments in %s', locale => {
  it.each(cases)('names $name as media while preserving separate document removal', ({ attachments }) => {
    const originalAttachments = structuredClone(attachments);
    const options = props(locale, attachments);
    render(<I18nProvider initialLocale={locale}><ChatComposer {...options} /></I18nProvider>);

    const mediaGroup = screen.getByRole('group', { name: expectedMediaLabel[locale] });
    const documentGroup = screen.getByRole('group', { name: chatText[locale].pendingDocuments });
    expect(screen.queryByRole('group', { name: chatText[locale].pendingImages })).not.toBeInTheDocument();
    expect(mediaGroup).not.toContainElement(documentGroup);
    expect(documentGroup).not.toContainElement(mediaGroup);
    expect(within(mediaGroup).queryByText('notes.txt')).not.toBeInTheDocument();

    for (const attachment of attachments) {
      fireEvent.click(within(mediaGroup).getByRole('button', {
        name: `${chatText[locale].removeAttachment}: ${attachment.name}`,
      }));
      expect(options.onRemoveAttachment).toHaveBeenLastCalledWith(attachment.ref ?? attachment.dataUrl);
    }
    expect(options.onRemoveAttachment).toHaveBeenCalledTimes(attachments.length);
    expect(options.onRemoveDocument).not.toHaveBeenCalled();
    fireEvent.click(within(documentGroup).getByRole('button', {
      name: `${chatText[locale].removeAttachment}: notes.txt`,
    }));
    expect(options.onRemoveDocument).toHaveBeenCalledOnce();
    expect(options.onRemoveDocument).toHaveBeenCalledWith('/synthetic/documents/notes.txt');
    expect(options.onRemoveAttachment).toHaveBeenCalledTimes(attachments.length);
    expect(attachments).toEqual(originalAttachments);
  });
});
