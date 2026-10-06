/** Data shared by conversation history, attachments, and document retrieval. */
export interface PreparedVideoFrame {
  ref: string;
  timestampSeconds: number;
}

export type MediaPreparation =
  | { kind: 'transcription'; text: string; sessionId: string; model: string }
  | { kind: 'video-frames'; frames: PreparedVideoFrame[] };

export interface ImageAttachment {
  kind?: 'image' | 'audio' | 'video';
  ref?: string;
  mime?: string;
  sizeBytes?: number;
  name: string;
  dataUrl: string;
  /** Explicit preparation kept beside the original immutable attachment. */
  preparation?: MediaPreparation;
}

export interface DocumentAttachment {
  name: string;
  path: string;
  text: string;
}

export interface DocumentChunk {
  document: DocumentAttachment;
  text: string;
  score: number;
  order: number;
  offset: number;
}

export interface RankedDocumentChunk {
  chunk: DocumentChunk;
  score: number;
}

export interface ChatCitation {
  name: string;
  path: string;
  offset: number;
  score?: number;
}
