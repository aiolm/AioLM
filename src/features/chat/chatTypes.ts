/** Data shared by conversation history, attachments, and document retrieval. */
export type { PreparedVideoFrame, MediaPreparation, ImageAttachment } from '../../shared/api/mediaTypes.ts';
import type { DocumentAttachment } from '../../shared/api/mediaTypes.ts';

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
