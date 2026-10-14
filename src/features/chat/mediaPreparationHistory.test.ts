import { describe, expect, it } from 'vitest';
import { buildMultimodalContent, estimateMessageTokens } from './chatUtils';
import { sameImages, toChatMessage } from './chatSendHelpers';
import { copyMediaPreparation, validMediaPreparation } from './mediaPreparationHistory';
import type { ImageAttachment } from './chatTypes';

const audio: ImageAttachment = { name: 'speech.wav', ref: `${'a'.repeat(64)}.wav`, kind: 'audio', dataUrl: '',
  preparation: { kind: 'transcription', text: 'Please summarize the quarterly figures.', sessionId: 'speech', model: 'whisper-small' } };
const video: ImageAttachment = { name: 'scene.mp4', ref: `${'b'.repeat(64)}.mp4`, kind: 'video', dataUrl: '',
  preparation: { kind: 'video-frames', frames: [{ ref: `${'c'.repeat(64)}.jpg`, timestampSeconds: 2.5 }] } };

describe('explicit media preparation in conversation replay', () => {
  it('preserves attachment sequence and frame labels when a conversation explicitly sends media before text', () => {
    const picture: ImageAttachment = { name: 'synthetic.png', dataUrl: 'data:image/png;base64,AA==', kind: 'image' };
    const message = { role: 'user' as const, content: 'Describe', images: [picture, video, audio] };
    const legacy = toChatMessage(message).content;
    expect(legacy).toEqual(buildMultimodalContent('Describe', message.images));
    expect(toChatMessage(message, true).content).toEqual([
      ...(legacy as Exclude<typeof legacy, string>).slice(1), { type: 'text', text: 'Describe' },
    ]);
    expect(message.images).toEqual([picture, video, audio]);
    expect(buildMultimodalContent('Text only', [], true)).toEqual([{ type: 'text', text: 'Text only' }]);
  });
  it('replays a labeled transcript without sending original audio or changing its source identity', () => {
    const message = toChatMessage({ role: 'user', content: 'Summarize', images: [audio] });
    expect(message.content).toEqual([{ type: 'text', text: 'Summarize' }, { type: 'text', text: expect.stringContaining(audio.preparation!.kind === 'transcription' ? audio.preparation!.text : '') }]);
    expect(JSON.stringify(message)).not.toContain(audio.ref);
    expect(audio.preparation).toMatchObject({ sessionId: 'speech', model: 'whisper-small' });
  });
  it('replays only immutable sampled images with timestamps and an explicit omitted-audio label', () => {
    const content = buildMultimodalContent('', [video]);
    expect(content).toEqual([
      { type: 'text', text: expect.stringContaining('Audio track is not included') },
      { type: 'text', text: '[Frame at 2.50 seconds]' },
      { type: 'aiolm_media', media: { ref: `${'c'.repeat(64)}.jpg`, kind: 'image' } },
    ]);
    expect(estimateMessageTokens({ role: 'user', content })).toBeGreaterThan(256);
    expect(video.ref).toBe(`${'b'.repeat(64)}.mp4`);
  });
  it('refuses malformed or mismatched persisted preparation instead of silently sending a native part', () => {
    for (const preparation of [
      { kind: 'transcription', text: '', sessionId: 'speech', model: 'whisper' },
      { kind: 'transcription', text: 'x'.repeat(64 * 1024 + 1), sessionId: 'speech', model: 'whisper' },
      { kind: 'video-frames', frames: [{ ref: '../outside.jpg', timestampSeconds: 0 }] },
      { kind: 'video-frames', frames: [{ ref: `${'c'.repeat(64)}.jpg`, timestampSeconds: NaN }] },
      { kind: 'video-frames', frames: Array.from({ length: 5 }, () => ({ ref: `${'c'.repeat(64)}.jpg`, timestampSeconds: 0 })) },
    ]) expect(validMediaPreparation(preparation, audio)).toBe(false);
    expect(validMediaPreparation(audio.preparation, { ...audio, kind: 'video' })).toBe(false);
    expect(() => buildMultimodalContent('', [{ ...video, preparation: audio.preparation }])).toThrow('preparation');
  });
  it('compares preparation as well as the original ref and copies only allowed metadata', () => {
    const changed = { ...audio, preparation: { ...audio.preparation, kind: 'transcription' as const, text: 'Changed', sessionId: 'speech', model: 'whisper-small' } };
    expect(sameImages([audio], [changed])).toBe(false);
    expect(sameImages([audio], [structuredClone(audio)])).toBe(true);
    const prepared = { ...audio.preparation!, path: '/private/source', secret: 'synthetic' };
    expect(copyMediaPreparation(prepared)).not.toHaveProperty('path');
    expect(copyMediaPreparation(prepared)).not.toHaveProperty('secret');
  });
});
