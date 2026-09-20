import {
  normalizePublicationInput,
  parsePublicationSnapshot,
  serializePublicationRequest,
  validateDescriptionMd,
  validatePublicationRequest,
  PUBLICATION_MAX_ROWS,
  PUBLICATION_MAX_UTF8_BYTES,
  DESCRIPTION_MAX_CODEPOINTS,
  type BenchmarkPublicationRequest,
} from '@aiolm/benchmark-contracts';

export {
  PUBLICATION_MAX_ROWS,
  PUBLICATION_MAX_UTF8_BYTES,
  DESCRIPTION_MAX_CODEPOINTS,
  type BenchmarkPublicationRequest,
};
export { validateDescriptionMd, validatePublicationRequest, normalizePublicationInput, parsePublicationSnapshot, serializePublicationRequest };

/** Once-serialized exact request bytes plus identity; retry reuses body so the hash stays stable. */
export function createPublicationBody(request: BenchmarkPublicationRequest): { body: string; submissionId: string } {
  const normalized = validatePublicationRequest(request);
  const body = serializePublicationRequest(normalized);
  return { body, submissionId: normalized.benchmark.submission_id };
}

/** Parse a stored exact snapshot; legacy bare bodies keep an empty description. */
export function parseStoredPublicationBody(body: string): BenchmarkPublicationRequest {
  return parsePublicationSnapshot(body);
}

/** SHA-256 hex of exact UTF-8 request bytes for upload-session binding. */
export async function sha256HexText(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is unavailable in this environment.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
