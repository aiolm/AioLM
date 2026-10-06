import { useRef, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { createTestStore } from '../../testing/appStore';
import { createChatThread, type ChatHistoryMessage } from './chatHistory';
import type { ImageAttachment } from './chatTypes';
import { useChatSend } from './useChatSend';

vi.mock('../../shared/api/index', () => ({
  chatStream: vi.fn(async () => 'Answer'), serverActivity: vi.fn(async () => undefined),
  transcribeMedia: vi.fn(async () => ({ text: 'Local speech transcript', sessionId: 'speech', model: 'whisper-small' })),
  extractVideoFrames: vi.fn(async () => ({ frames: [{ ref: `${'c'.repeat(64)}.jpg`, timestampSeconds: 0 }] })),
}));
const answering: api.EngineInfo = { provider: 'vllm', runtime_id: 'metal', upstream_model: 'answer',
  modalities: { text: true, image: true, audio: false, video: false }, tasks: ['generate'], request_fields: {} };
const audio: ImageAttachment = { name: 'speech.wav', kind: 'audio', ref: `${'a'.repeat(64)}.wav`, dataUrl: '' };
const video: ImageAttachment = { name: 'scene.mp4', kind: 'video', ref: `${'b'.repeat(64)}.mp4`, dataUrl: '' };

function setup(attachments: ImageAttachment[], preprocessing = { audioSessionId: 'speech', videoFrames: true }) {
  const store = createTestStore({ active_provider: 'vllm', active_model: 'answer' });
  return renderHook(() => {
    const [msgs, setMsgs] = useState<ChatHistoryMessage[]>([]);
    const [input, setInput] = useState('Summarize');
    const [phase, setPhase] = useState<'idle' | 'thinking' | 'streaming'>('idle');
    const atBottomRef = useRef(true);
    const send = useChatSend({ store, engine: answering, mediaPreprocessing: preprocessing,
      baseUrl: 'http://127.0.0.1:18080', apiKey: 'synthetic', model: 'answer', sessionId: 'answer-session',
      activeThread: createChatThread(), msgs, setMsgs, input, setInput, phase, setPhase, attachments,
      setAttachments: vi.fn(), documents: [], setDocuments: vi.fn(), atBottomRef, mcpDefinitions: [], mcpEntryByFunctionName: new Map() });
    return { ...send, msgs, phase };
  });
}

describe('chat preprocessing on the selected answering session', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
  it('sends labeled transcripts and sampled frames while keeping original references and answering engine', async () => {
    const { result } = setup([audio, video]);
    await act(async () => { await result.current.send(); });
    expect(api.transcribeMedia).toHaveBeenCalledWith(audio.ref, 'speech', expect.any(AbortSignal));
    expect(api.extractVideoFrames).toHaveBeenCalledWith(video.ref, expect.any(AbortSignal), 4);
    const [url, , model, history, sampling] = vi.mocked(api.chatStream).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:18080'); expect(model).toBe('answer');
    expect(sampling.engine).toEqual(answering);
    expect(JSON.stringify(history)).toContain('Local speech transcript');
    expect(JSON.stringify(history)).toContain('Audio track is not included');
    expect(JSON.stringify(history)).not.toContain(audio.ref);
    expect(result.current.msgs[0].images).toMatchObject([{ ref: audio.ref, preparation: { sessionId: 'speech' } }, { ref: video.ref, preparation: { kind: 'video-frames' } }]);
  });
  it('reuses prepared input on retry after an answering-engine failure', async () => {
    vi.mocked(api.chatStream).mockRejectedValueOnce(new Error('synthetic engine error'));
    const { result } = setup([audio]);
    await act(async () => { await result.current.send(); });
    expect(result.current.failedRef.current?.images[0].preparation).toMatchObject({ text: 'Local speech transcript' });
    await act(async () => { await result.current.send(true); });
    expect(api.transcribeMedia).toHaveBeenCalledTimes(1);
    expect(api.chatStream).toHaveBeenCalledTimes(2);
  });
  it('shares the four-part budget between multiple videos', async () => {
    const clips = [video, { ...video, ref: `${'d'.repeat(64)}.mp4` }, { ...video, ref: `${'e'.repeat(64)}.mp4` }, { ...video, ref: `${'f'.repeat(64)}.mp4` }];
    const { result } = setup(clips);
    await act(async () => { await result.current.send(); });
    expect(api.extractVideoFrames).toHaveBeenCalledTimes(4);
    expect(vi.mocked(api.extractVideoFrames).mock.calls.map(call => call[2])).toEqual([1, 1, 1, 1]);
    expect(api.chatStream).toHaveBeenCalledTimes(1);
  });
  it('stops during preparation before recording a transcript or sending chat', async () => {
    let finish!: (value: api.MediaTranscription) => void;
    vi.mocked(api.transcribeMedia).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = setup([audio]);
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.send(); });
    expect(result.current.phase).toBe('thinking');
    await act(async () => { result.current.stop(); finish({ text: 'Late result', sessionId: 'speech', model: 'whisper' }); await pending; });
    expect(api.chatStream).not.toHaveBeenCalled();
    expect(result.current.msgs).toEqual([]);
    expect(result.current.phase).toBe('idle');
  });
  it('refuses unsupported original media until a preprocessing route is explicitly selected', async () => {
    const { result } = setup([audio], { audioSessionId: '', videoFrames: false });
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toContain('does not support');
    expect(api.transcribeMedia).not.toHaveBeenCalled(); expect(api.chatStream).not.toHaveBeenCalled();
  });
});
