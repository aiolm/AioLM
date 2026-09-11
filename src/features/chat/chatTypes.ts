/** Data shared by conversation history, attachments, and document retrieval. */
export interface ImageAttachment {
  name: string;
  dataUrl: string;
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
