import { useRef, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { createTestStore } from '../../testing/appStore';
import { sessionHasActivity } from '../../shared/state/sessionActivity';
import type { ChatHistoryMessage } from './chatHistory';
import type { DocumentAttachment, ImageAttachment } from './chatUtils';
import { useChatSend } from './useChatSend';

vi.mock('../../shared/api/index', () => ({
  chatStream: vi.fn(), embedText: vi.fn(), serverActivity: vi.fn(async () => undefined),
}));
vi.mock('./documentIndex', () => ({ loadDocumentVectors: vi.fn(async () => null), saveDocumentVectors: vi.fn(async () => undefined) }));
vi.mock('../../shared/lib/notifications', () => ({ notifyCompletion: vi.fn(async () => undefined) }));

function setup(initialDocuments: DocumentAttachment[] = []) {
  const store = createTestStore();
  return renderHook(() => {
    const [msgs, setMsgs] = useState<ChatHistoryMessage[]>([]);
    const [input, setInput] = useState('Original question');
    const [phase, setPhase] = useState<'idle' | 'thinking' | 'streaming'>('idle');
    const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
    const [documents, setDocuments] = useState(initialDocuments);
    const atBottomRef = useRef(true);
    const send = useChatSend({
      store, effectiveConfig: store.cfg, modelProfile: null, sessionId: 'lifecycle-session',
      baseUrl: 'http://127.0.0.1:8080', apiKey: 'test-key', model: 'model.gguf',
      activeThread: undefined, msgs, setMsgs, input, setInput, phase, setPhase,
      attachments, setAttachments, documents, setDocuments, atBottomRef,
      mcpDefinitions: [], mcpEntryByFunctionName: new Map(),
    });
    return { ...send, msgs, phase, documents, input };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('chat turn lifecycle', () => {
  it('Stop cancels document embeddings, releases the session, and preserves the unsent input', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(api.embedText).mockImplementation((_url, _key, _model, _input, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      });
    });
    const document = { name: 'notes.md', path: '/documents/notes.md', text: 'Synthetic context' };
    const { result } = setup([document]);
    let sending!: Promise<void>;
    act(() => { sending = result.current.send(); });
    await waitFor(() => expect(api.embedText).toHaveBeenCalledOnce());
    expect(sessionHasActivity('lifecycle-session')).toBe(true);
    await act(async () => { result.current.stop(); await sending; });
    expect(requestSignal?.aborted).toBe(true);
    expect(result.current.phase).toBe('idle');
    expect(result.current.aborting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.documents).toEqual([document]);
    expect(result.current.input).toBe('Original question');
    expect(result.current.msgs).toEqual([]);
    expect(sessionHasActivity('lifecycle-session')).toBe(false);
    expect(api.chatStream).not.toHaveBeenCalled();
  });

  it('resetting the composer cannot retry a failure from the previous conversation', async () => {
    vi.mocked(api.chatStream).mockRejectedValueOnce(new Error('Connection failed'));
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.failedRef.current?.text).toBe('Original question');
    act(() => result.current.resetChatState());
    expect(result.current.failedRef.current).toBeNull();
    // An unrelated error in the new composer must not recover the old turn.
    act(() => result.current.setError('File attachment failed'));
    await act(async () => { await result.current.send(true); });
    expect(api.chatStream).toHaveBeenCalledOnce();
  });
});
