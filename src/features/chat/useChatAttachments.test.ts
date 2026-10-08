import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import type { ImageAttachment } from './chatTypes';
import { useChatAttachments } from './useChatAttachments';

vi.mock('../../shared/api/index', () => ({ pickAttachment: vi.fn(), readDocumentText: vi.fn(), importMedia: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const setError = vi.fn();
  return { ...renderHook(() => useChatAttachments({ visionReady: true, setError })), setError };
}

beforeEach(() => vi.clearAllMocks());

describe('composer attachment ownership', () => {
  it.each(['document', 'media'] as const)('reports capacity when a delayed %s import loses its slot to another update', async kind => {
    const text = deferred<string>();
    const media = deferred<ImageAttachment>();
    vi.mocked(api.pickAttachment).mockResolvedValue(`/attachments/requested.${kind === 'document' ? 'md' : 'png'}`);
    vi.mocked(api.readDocumentText).mockReturnValue(text.promise);
    vi.mocked(api.importMedia).mockReturnValue(media.promise);
    const { result, setError } = setup();
    let adding!: Promise<void>;
    act(() => { adding = result.current.addAttachment(); });
    await waitFor(() => expect(kind === 'document' ? api.readDocumentText : api.importMedia).toHaveBeenCalledOnce());
    const existingDocuments = Array.from({ length: 4 }, (_, index) => ({ name: `project-${index}.md`, path: `/synthetic/project-${index}.md`, text: `Bound document ${index}` }));
    const existingMedia = Array.from({ length: 4 }, (_, index) => ({ name: `existing-${index}.png`, ref: `existing-media-${index}`, dataUrl: '', kind: 'image' as const }));
    // A project binding can fill the slots in the same batch that the manual read finishes.
    await act(async () => {
      if (kind === 'document') { result.current.setDocuments(existingDocuments); text.resolve('Requested document'); }
      else { result.current.setAttachments(existingMedia); media.resolve({ name: 'requested.png', ref: 'requested-media', dataUrl: '', kind: 'image' }); }
      await adding;
    });
    expect(kind === 'document' ? result.current.documents : result.current.attachments).toEqual(kind === 'document' ? existingDocuments : existingMedia);
    expect(result.current.attachmentStatus).toBe('failed');
    expect(setError).toHaveBeenLastCalledWith(expect.stringContaining(`up to 4 ${kind === 'document' ? 'documents' : 'media files'}`));
    act(() => {
      if (kind === 'document') result.current.setDocuments([]);
      else result.current.setAttachments([]);
    });
    await act(async () => { await result.current.addAttachment(); });
    expect(kind === 'document' ? result.current.documents : result.current.attachments).toHaveLength(1);
    expect(result.current.attachmentStatus).toBe('ready');
    expect(setError).toHaveBeenLastCalledWith(null);
  });

  it('accepts an already attached document when that path appears during its pending read', async () => {
    const read = deferred<string>();
    vi.mocked(api.pickAttachment).mockResolvedValue('/synthetic/shared.md');
    vi.mocked(api.readDocumentText).mockReturnValue(read.promise);
    const { result, setError } = setup();
    let adding!: Promise<void>;
    act(() => { adding = result.current.addAttachment(); });
    await waitFor(() => expect(api.readDocumentText).toHaveBeenCalledOnce());
    const existing = { name: 'shared.md', path: '/synthetic/shared.md', text: 'Previously bound content' };
    await act(async () => { result.current.setDocuments([existing]); read.resolve('Later manual content'); await adding; });
    expect(result.current.documents).toEqual([existing]);
    expect(result.current.attachmentStatus).toBe('ready');
    expect(setError).toHaveBeenLastCalledWith(null);
  });

  it.each(['document', 'media'] as const)('ignores a late %s import after switching conversations', async kind => {
    const text = deferred<string>();
    const media = deferred<ImageAttachment>();
    vi.mocked(api.pickAttachment).mockResolvedValue(`/attachments/old.${kind === 'document' ? 'md' : 'png'}`);
    vi.mocked(api.readDocumentText).mockReturnValue(text.promise);
    vi.mocked(api.importMedia).mockReturnValue(media.promise);
    const { result, setError } = setup();
    let adding!: Promise<void>;
    act(() => { adding = result.current.addAttachment(); });
    await waitFor(() => expect(kind === 'document' ? api.readDocumentText : api.importMedia).toHaveBeenCalledOnce());
    act(() => result.current.clearComposerAttachments());
    await act(async () => {
      if (kind === 'document') text.resolve('Old conversation document');
      else media.resolve({ name: 'old.png', dataUrl: '', ref: 'synthetic-media', kind: 'image' });
      await adding;
    });
    expect(result.current.documents).toEqual([]);
    expect(result.current.attachments).toEqual([]);
    expect(result.current.attachmentStatus).toBe('idle');
    expect(setError).not.toHaveBeenCalled();
  });

  it('does not read the old picker selection after the composer was reset', async () => {
    const selection = deferred<string | null>();
    vi.mocked(api.pickAttachment).mockReturnValue(selection.promise);
    const { result } = setup();
    let adding!: Promise<void>;
    act(() => { adding = result.current.addAttachment(); });
    act(() => result.current.clearComposerAttachments());
    await act(async () => { selection.resolve('/attachments/old.md'); await adding; });
    expect(api.readDocumentText).not.toHaveBeenCalled();
    expect(result.current.attachmentStatus).toBe('idle');
  });

  it('opens only one picker when two attachment actions occur before rendering', async () => {
    const selection = deferred<string | null>();
    vi.mocked(api.pickAttachment).mockReturnValue(selection.promise);
    const { result } = setup();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.addAttachment(); second = result.current.addAttachment(); });
    expect(api.pickAttachment).toHaveBeenCalledOnce();
    await act(async () => { selection.resolve(null); await Promise.all([first, second]); });
    expect(result.current.attachmentStatus).toBe('idle');
  });

  it('does not let an old failed read replace the status of a newer import', async () => {
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    vi.mocked(api.pickAttachment).mockResolvedValueOnce('/attachments/old.md').mockResolvedValueOnce('/attachments/new.md');
    vi.mocked(api.readDocumentText).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const { result, setError } = setup();
    let oldAdding!: Promise<void>;
    let newAdding!: Promise<void>;
    act(() => { oldAdding = result.current.addAttachment(); });
    await waitFor(() => expect(api.readDocumentText).toHaveBeenCalledOnce());
    act(() => result.current.clearComposerAttachments());
    act(() => { newAdding = result.current.addAttachment(); });
    await waitFor(() => expect(api.readDocumentText).toHaveBeenCalledTimes(2));
    await act(async () => { oldRead.reject(new Error('Old file was removed')); await oldAdding; });
    expect(result.current.attachmentStatus).toBe('reading');
    expect(setError).not.toHaveBeenCalled();
    await act(async () => { newRead.resolve('New conversation context'); await newAdding; });
    expect(result.current.documents).toEqual([{ name: 'new.md', path: '/attachments/new.md', text: 'New conversation context' }]);
    expect(result.current.attachmentStatus).toBe('ready');
  });

  it('ignores import failures after the chat has unmounted', async () => {
    const read = deferred<string>();
    vi.mocked(api.pickAttachment).mockResolvedValue('/attachments/old.md');
    vi.mocked(api.readDocumentText).mockReturnValue(read.promise);
    const { result, unmount, setError } = setup();
    let adding!: Promise<void>;
    act(() => { adding = result.current.addAttachment(); });
    await waitFor(() => expect(api.readDocumentText).toHaveBeenCalledOnce());
    unmount();
    await act(async () => { read.reject(new Error('File unavailable')); await adding; });
    expect(setError).not.toHaveBeenCalled();
  });
});
