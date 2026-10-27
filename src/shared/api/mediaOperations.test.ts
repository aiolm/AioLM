import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractVideoFrames, transcribeMedia } from './commands';
import { invoke } from './transport';

vi.mock('./transport.ts', () => ({ invoke: vi.fn(), isNativeRuntimeAvailable: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('cancellable immutable media operations', () => {
  beforeEach(() => vi.clearAllMocks());
  it('passes the explicitly selected speech session and an operation id without URLs or keys', async () => {
    vi.mocked(invoke).mockResolvedValue({ text: 'Transcript', sessionId: 'speech', model: 'whisper' });
    await expect(transcribeMedia(`${'a'.repeat(64)}.wav`, 'speech')).resolves.toMatchObject({ sessionId: 'speech' });
    expect(invoke).toHaveBeenCalledWith('transcribe_media', { reference: `${'a'.repeat(64)}.wav`, sessionId: 'speech', operationId: expect.any(String) });
  });
  it('cancels the same operation while native work is pending and refuses its late result', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(command => command === 'extract_video_frames'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(undefined));
    const controller = new AbortController();
    const pending = extractVideoFrames(`${'a'.repeat(64)}.mp4`, controller.signal);
    const operationId = vi.mocked(invoke).mock.calls[0][1]?.operationId;
    controller.abort();
    expect(invoke).toHaveBeenCalledWith('cancel_media_operation', { operationId });
    finish({ frames: [] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('never starts an already cancelled operation and removes its listener after completion', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(transcribeMedia('synthetic.wav', 'speech', cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValue({ frames: [] });
    const completed = new AbortController();
    await extractVideoFrames('synthetic.mp4', completed.signal);
    completed.abort();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
