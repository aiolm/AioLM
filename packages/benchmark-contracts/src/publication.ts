import { validatePublicBenchmark } from './validate.js';
import type { PublicBenchmarkSubmission } from './types.js';

/** Maximum description length in Unicode codepoints. */
export const DESCRIPTION_MAX_CODEPOINTS = 4000;
/** Whole publication request UTF-8 limit; overlimit requests are rejected, never truncated. */
export const PUBLICATION_MAX_UTF8_BYTES = 4 * 1024 * 1024;
/** Maximum measurement rows per request. */
export const PUBLICATION_MAX_ROWS = 10000;

/** New publication request: exact benchmark snapshot plus Markdown description. */
export interface BenchmarkPublicationRequest {
  benchmark: PublicBenchmarkSubmission;
  description_md: string;
}

/** Legacy bare submission accepted with an empty description. */
export type BenchmarkPublicationInput = BenchmarkPublicationRequest | PublicBenchmarkSubmission;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function countCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const unit = value.codePointAt(index) ?? 0;
    index += unit > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

/** Early-bounded length check; never spreads an arbitrarily long string. */
function exceedsCodePointLimit(value: string, limit: number): boolean {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const unit = value.codePointAt(index) ?? 0;
    index += unit > 0xffff ? 2 : 1;
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Shared description validation covers type and length only (max 4000 codepoints).
 * Rendering safety (HTML/images/unsafe links suppressed consistently, including code
 * fences, autolinks, and reference links) belongs to the AST renderer allowlist:
 * react-markdown with skipHtml, an explicit allowedElements list, unwrapDisallowed,
 * and a urlTransform accepting http(s) only. Do not hand-roll Markdown parsing here.
 */
export function validateDescriptionMd(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid publication description.');
  if (exceedsCodePointLimit(value, DESCRIPTION_MAX_CODEPOINTS)) throw new Error('Publication description exceeds 4000 characters.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPublicationWrapper(value: unknown): value is BenchmarkPublicationRequest {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && hasOwn(value, 'benchmark') && hasOwn(value, 'description_md');
}

/** Normalize wrapper or legacy bare submission; legacy keeps an empty description. */
export function normalizePublicationInput(value: unknown): BenchmarkPublicationRequest {
  if (isPublicationWrapper(value)) {
    const benchmark = validatePublicBenchmark(value.benchmark);
    const description_md = validateDescriptionMd(value.description_md);
    return { benchmark, description_md };
  }
  const benchmark = validatePublicBenchmark(value);
  return { benchmark, description_md: '' };
}

/** Validate bounds shared by wrapper and legacy bodies. */
export function validatePublicationRequest(value: unknown): BenchmarkPublicationRequest {
  const request = normalizePublicationInput(value);
  if (request.benchmark.measurements.rows.length > PUBLICATION_MAX_ROWS) {
    throw new Error('Publication exceeds 10000 measurement rows.');
  }
  const serialized = JSON.stringify(request);
  if (utf8ByteLength(serialized) > PUBLICATION_MAX_UTF8_BYTES) {
    throw new Error('Publication request exceeds 4MiB.');
  }
  return request;
}

/** Once-serialized exact request bytes; retry reuses these bytes so the body hash stays stable. */
export function serializePublicationRequest(request: BenchmarkPublicationRequest): string {
  const normalized = validatePublicationRequest(request);
  return JSON.stringify(normalized);
}

/** Parse an exact request snapshot without re-serializing caller data first. */
export function parsePublicationSnapshot(body: string): BenchmarkPublicationRequest {
  if (utf8ByteLength(body) > PUBLICATION_MAX_UTF8_BYTES) throw new Error('Publication request exceeds 4MiB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Invalid publication request body.');
  }
  const request = normalizePublicationInput(parsed);
  if (request.benchmark.measurements.rows.length > PUBLICATION_MAX_ROWS) {
    throw new Error('Publication exceeds 10000 measurement rows.');
  }
  return request;
}
