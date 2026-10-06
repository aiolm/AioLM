/**
 * Explicit app-level audio/video preprocessing for chat.
 *
 * Native vllm-metal v0.30.0 has no audio/video chat (image-only vision).
 * These pure helpers label the two transparent fallbacks so neither is
 * mistaken for native understanding:
 * - audio: transcript text from an explicitly selected running local
 *   transcription session is inserted as labeled text; the original audio
 *   reference stays in history and the answering runtime never changes.
 * - video: at most four sampled stills travel as ordinary image parts to an
 *   image-capable answering model, labeled as sampled frames with no audio
 *   track. Local ffmpeg is optional and never auto-installed.
 *
 * Selection, IPC, history writes and send wiring belong to the chat owner;
 * this module only formats labels and bounds so it stays testable without
 * native engines.
 */

import * as api from '../../shared/api/index';
import type { ImageAttachment } from './chatTypes';
import { copyMediaPreparation, validMediaPreparation } from './mediaPreparationHistory';

export const MAX_VIDEO_FRAMES = 4;

export interface MediaPreprocessingOptions { audioSessionId?: string; videoFrames: boolean }

export function canPrepareAttachment(attachment: ImageAttachment, modalities: ChatModalities | undefined, options: MediaPreprocessingOptions): boolean {
  if (attachment.preparation) {
    return validMediaPreparation(attachment.preparation, attachment)
      && (attachment.preparation.kind === 'transcription' ? modalities?.text === true : modalities?.image === true);
  }
  const kind = attachment.kind ?? 'image';
  if (kind === 'audio' && options.audioSessionId) return !!attachment.ref && modalities?.text === true;
  if (kind === 'video' && options.videoFrames) return !!attachment.ref && modalities?.image === true;
  return modalities?.[kind] === true;
}

/** Preparation is explicit, cancellable, and returns a fresh attachment list
 * only after every operation succeeds. Existing prepared history is reused. */
export async function prepareChatAttachments(attachments: ImageAttachment[], modalities: ChatModalities | undefined,
  options: MediaPreprocessingOptions, signal: AbortSignal): Promise<ImageAttachment[]> {
  const sampling = attachments.filter(attachment => !attachment.preparation && attachment.kind === 'video' && options.videoFrames);
  const fixedParts = attachments.reduce((total, attachment) => {
    if (attachment.preparation?.kind === 'video-frames') return total + attachment.preparation.frames.length;
    if (attachment.preparation?.kind === 'transcription' || (attachment.kind === 'audio' && options.audioSessionId)
      || sampling.includes(attachment)) return total;
    return total + 1;
  }, 0);
  let remainingVideos = sampling.length;
  let availableFrames = MAX_VIDEO_FRAMES - fixedParts;
  if (availableFrames < remainingVideos || fixedParts > MAX_VIDEO_FRAMES) throw new Error('A message supports at most four media parts, including sampled video frames. Remove attachments before sending.');
  const prepared: ImageAttachment[] = [];
  for (const attachment of attachments) {
    signal.throwIfAborted();
    if (!canPrepareAttachment(attachment, modalities, options)) throw new Error(`The running model does not support ${attachment.kind ?? 'image'} input or its selected preprocessing route.`);
    if (attachment.preparation) {
      prepared.push({ ...attachment, preparation: copyMediaPreparation(attachment.preparation) });
      continue;
    }
    if (attachment.kind === 'audio' && options.audioSessionId) {
      const result = await api.transcribeMedia(attachment.ref!, options.audioSessionId, signal);
      signal.throwIfAborted();
      const preparation = { kind: 'transcription' as const, text: result.text, sessionId: result.sessionId, model: result.model };
      if (result.sessionId !== options.audioSessionId || !validMediaPreparation(preparation, attachment)) throw new Error('The selected speech session returned an invalid transcript.');
      prepared.push({ ...attachment, preparation });
    } else if (attachment.kind === 'video' && options.videoFrames) {
      const maxFrames = Math.min(MAX_VIDEO_FRAMES, Math.floor(availableFrames / remainingVideos));
      const result = await api.extractVideoFrames(attachment.ref!, signal, maxFrames);
      signal.throwIfAborted();
      const preparation = { kind: 'video-frames' as const, frames: result.frames };
      if (!validMediaPreparation(preparation, attachment) || result.frames.length > maxFrames) throw new Error('Video sampling returned invalid or excessive frames.');
      availableFrames -= result.frames.length;
      remainingVideos -= 1;
      prepared.push({ ...attachment, preparation: copyMediaPreparation(preparation) });
    } else {
      prepared.push({ ...attachment });
    }
  }
  return prepared;
}

export const VIDEO_NO_AUDIO_NOTE =
  "sampled frames only; no audio track was transcribed or understood";

export interface ChatModalities {
  text?: boolean;
  image?: boolean;
  audio?: boolean;
  video?: boolean;
}

/** Frames travel as image parts, so only image-capable answering models qualify. */
export function canPreprocessVideoForAnswering(modalities?: ChatModalities | null): boolean {
  return modalities?.image === true;
}

/** Labeled transcript text inserted into chat for audio preprocessing. */
export function formatTranscriptInsert(
  attachmentName: string,
  sessionLabel: string,
  transcript: string,
  truncated: boolean,
): string {
  const text = transcript.trim();
  const shown = text === "" ? "(empty transcript)" : text;
  const name = attachmentName.trim();
  const session = sessionLabel.trim();
  const suffix = truncated ? " (truncated to the transcription limit)" : "";
  return `[transcription of ${name} via ${session}]${suffix}\n${shown}`;
}

/** Label for one sampled video frame sent as an image part. */
export function formatFrameLabel(
  attachmentName: string,
  index: number,
  total: number,
  timestampSecs?: number | null,
): string {
  const when =
    typeof timestampSecs === "number" && Number.isFinite(timestampSecs) && timestampSecs >= 0
      ? ` at ${timestampSecs.toFixed(1)}s`
      : "";
  return `[frame ${index + 1}/${total} of ${attachmentName.trim()}${when}; ${VIDEO_NO_AUDIO_NOTE}]`;
}

/** Evenly spaced sample plan for a known duration; empty when unknown. */
export function frameTimestamps(durationSecs: number, maxFrames: number): number[] {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) return [];
  const count = Math.min(Math.max(Math.floor(maxFrames), 1), MAX_VIDEO_FRAMES);
  return Array.from({ length: count }, (_, i) => (durationSecs * (i + 1)) / (count + 1));
}

/** Status line for the preprocessing button/banner while work is pending. */
export function preprocessStatus(kind: "audio" | "video", state: "idle" | "working" | "ready" | "failed"): string {
  if (state === "working") return kind === "audio" ? "Transcribing audio…" : "Sampling video frames…";
  if (state === "ready") return kind === "audio" ? "Transcript ready" : "Frames ready";
  if (state === "failed") return kind === "audio" ? "Transcription failed" : "Frame sampling failed";
  return kind === "audio" ? "Transcribe for chat" : "Sample frames for chat";
}
