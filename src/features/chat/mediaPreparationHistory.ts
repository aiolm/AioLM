import type { ImageAttachment, MediaPreparation } from './chatTypes.ts';

const imageRef = /^[a-f0-9]{64}\.(?:png|jpe?g|webp)$/;

/** Refuse malformed persisted preparation rather than replaying the original
 * audio/video as though the user had selected native inference. */
export function validMediaPreparation(value: unknown, attachment: Pick<ImageAttachment, 'kind' | 'ref'>): value is MediaPreparation {
  if (!attachment.ref || value === null || typeof value !== 'object') return false;
  const preparation = value as Partial<MediaPreparation>;
  if (preparation.kind === 'transcription') {
    return attachment.kind === 'audio' && typeof preparation.text === 'string'
      && !!preparation.text.trim() && preparation.text.length <= 64 * 1024
      && typeof preparation.sessionId === 'string' && !!preparation.sessionId && preparation.sessionId.length <= 128
      && typeof preparation.model === 'string' && !!preparation.model && preparation.model.length <= 4096;
  }
  if (preparation.kind === 'video-frames') {
    return attachment.kind === 'video' && Array.isArray(preparation.frames)
      && preparation.frames.length > 0 && preparation.frames.length <= 4
      && preparation.frames.every(frame => frame && typeof frame.ref === 'string' && imageRef.test(frame.ref)
        && typeof frame.timestampSeconds === 'number' && Number.isFinite(frame.timestampSeconds)
        && frame.timestampSeconds >= 0);
  }
  return false;
}

/** Rebuild the allowed fields only; history never stores paths or arbitrary
 * nested objects supplied by a preprocessing response. */
export function copyMediaPreparation(preparation: MediaPreparation): MediaPreparation {
  return preparation.kind === 'transcription'
    ? { kind: preparation.kind, text: preparation.text, sessionId: preparation.sessionId, model: preparation.model }
    : { kind: preparation.kind, frames: preparation.frames.map(frame => ({ ref: frame.ref, timestampSeconds: frame.timestampSeconds })) };
}
