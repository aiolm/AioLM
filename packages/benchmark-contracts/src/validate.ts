import { publicBenchmarkSchema, benchmarkReceiptSchema } from './schema.js';
import type { PublicBenchmarkSubmission, BenchmarkReceipt } from './types.js';

interface JsonSchema {
  type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[];
  additionalProperties?: boolean; items?: JsonSchema; enum?: unknown[]; const?: unknown;
  minimum?: number; maximum?: number; maxLength?: number; pattern?: string; minItems?: number; maxItems?: number;
  $ref?: string; $defs?: Record<string, JsonSchema>;
}
const contractSchema = publicBenchmarkSchema as JsonSchema;
const patterns = new Map<string, RegExp>();

function assertSchema(value: unknown, spec: JsonSchema, path: string): void {
  if (spec.$ref) {
    const definition = contractSchema.$defs?.[spec.$ref.slice('#/$defs/'.length)];
    if (!definition) throw new Error('Unknown benchmark schema definition.');
    return assertSchema(value, definition, path);
  }
  const fail = () => { throw new Error(`Invalid public benchmark field: ${path}`); };
  const types = typeof spec.type === 'string' ? [spec.type] : spec.type;
  if (types && !types.some(type => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isSafeInteger(value)
    : typeof value === type)) fail();
  if ('const' in spec && value !== spec.const) fail();
  if (spec.enum && !spec.enum.includes(value)) fail();
  if (typeof value === 'number' && (!Number.isFinite(value) || (spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) fail();
  if (typeof value === 'string') {
    if (spec.maxLength !== undefined && value.length > spec.maxLength) fail();
    if (spec.pattern) {
      let pattern = patterns.get(spec.pattern);
      if (!pattern) { pattern = new RegExp(spec.pattern); patterns.set(spec.pattern, pattern); }
      if (!pattern.test(value)) fail();
    }
  }
  if (Array.isArray(value)) {
    if ((spec.minItems !== undefined && value.length < spec.minItems) || (spec.maxItems !== undefined && value.length > spec.maxItems)) fail();
    if (spec.items) value.forEach((entry, index) => assertSchema(entry, spec.items!, `${path}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of spec.required ?? []) if (!Object.prototype.hasOwnProperty.call(record, key)) fail();
    for (const [key, entry] of Object.entries(record)) {
      if (spec.properties && Object.prototype.hasOwnProperty.call(spec.properties, key)) assertSchema(entry, spec.properties[key], `${path}.${key}`);
      else if (spec.additionalProperties === false) fail();
    }
  }
}

/** Shared by public export, the upload queue, and HTTP boundary validation. */
export function validatePublicBenchmark(value: unknown): PublicBenchmarkSubmission {
  assertSchema(value, contractSchema, 'benchmark');
  const result = value as PublicBenchmarkSubmission;
  if ((result.model.status === 'sha256') !== (result.model.sha256 !== null)) throw new Error('Invalid public benchmark model identity.');
  return result;
}

/** Transport-specific origin/authentication policy belongs to the calling HTTP client. */
export function validateBenchmarkReceipt(value: unknown, expectedSubmissionId?: string): BenchmarkReceipt {
  assertSchema(value, benchmarkReceiptSchema as JsonSchema, 'receipt');
  const receipt = value as BenchmarkReceipt;
  if (expectedSubmissionId !== undefined && receipt.submission_id !== expectedSubmissionId) throw new Error('Receipt does not identify this submission.');
  if (receipt.url !== undefined) new URL(receipt.url);
  return receipt;
}
