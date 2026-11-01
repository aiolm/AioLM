import { publicBenchmarkSchema, benchmarkReceiptSchema } from './schema.js';
import type { PublicBenchmarkSubmission, LegacyPublicBenchmarkSubmission, ServingPublicBenchmarkSubmission, BenchmarkConfiguration, BenchmarkReceipt, RecordedSetting, ServingExecution } from './types.js';

interface JsonSchema {
  type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[];
  additionalProperties?: boolean; items?: JsonSchema; enum?: unknown[]; const?: unknown;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; minItems?: number; maxItems?: number;
  uniqueItems?: boolean; oneOf?: JsonSchema[]; allOf?: JsonSchema[]; not?: JsonSchema;
  if?: JsonSchema; then?: JsonSchema; else?: JsonSchema;
  $ref?: string; $defs?: Record<string, JsonSchema>;
}
const contractSchema = publicBenchmarkSchema as JsonSchema;
const patterns = new Map<string, RegExp>();

function matchesSchema(value: unknown, spec: JsonSchema, path: string): boolean {
  try { assertSchema(value, spec, path); return true; } catch { return false; }
}

function assertSchema(value: unknown, spec: JsonSchema, path: string): void {
  if (spec.$ref) {
    const definition = spec.$ref.startsWith('#/$defs/') ? contractSchema.$defs?.[spec.$ref.slice('#/$defs/'.length)] : undefined;
    if (!definition) throw new Error('Unknown benchmark schema definition.');
    assertSchema(value, definition, path);
  }
  const fail = () => { throw new Error(`Invalid public benchmark field: ${path}`); };
  if (spec.oneOf) {
    let matches = 0;
    let firstError: unknown;
    for (const branch of spec.oneOf) {
      try { assertSchema(value, branch, path); matches++; }
      catch (error) { firstError ??= error; }
    }
    if (matches === 0 && firstError instanceof Error) throw firstError;
    if (matches !== 1) fail();
  }
  for (const branch of spec.allOf ?? []) assertSchema(value, branch, path);
  if (spec.not && matchesSchema(value, spec.not, path)) fail();
  if (spec.if) {
    const branch = matchesSchema(value, spec.if, path) ? spec.then : spec.else;
    if (branch) assertSchema(value, branch, path);
  }
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
    if ((spec.minLength !== undefined && value.length < spec.minLength) || (spec.maxLength !== undefined && value.length > spec.maxLength)) fail();
    if (spec.pattern) {
      let pattern = patterns.get(spec.pattern);
      if (!pattern) { pattern = new RegExp(spec.pattern); patterns.set(spec.pattern, pattern); }
      if (!pattern.test(value)) fail();
    }
  }
  if (Array.isArray(value)) {
    if ((spec.minItems !== undefined && value.length < spec.minItems) || (spec.maxItems !== undefined && value.length > spec.maxItems)) fail();
    if (spec.uniqueItems && new Set(value.map(entry => JSON.stringify(entry))).size !== value.length) fail();
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

function validateLegacyConfigurationRules(result: Pick<LegacyPublicBenchmarkSubmission, 'runtime' | 'execution'>, schemaVersion: 1 | 2): void {
  const metal = result.runtime.variant === 'vllm-metal';
  if (metal ? schemaVersion !== 2 || result.runtime.name !== 'vllm' || result.runtime.backend !== 'metal' || !result.runtime.plugin_version
    : result.runtime.plugin_version !== undefined || result.runtime.name === 'vllm' && result.runtime.backend === 'metal') throw new Error('Invalid vllm-metal runtime identity.');
  if (schemaVersion === 1 && result.runtime.name !== 'llama.cpp') throw new Error('Version 1 benchmarks describe llama.cpp measurements.');
  if (schemaVersion === 2 && result.runtime.name !== 'llama.cpp' && result.execution.settings !== null) throw new Error('Python engines cannot carry llama.cpp execution settings.');
}

function validateLegacy(result: LegacyPublicBenchmarkSubmission): void {
  validateLegacyConfigurationRules(result, result.schema_version);
  const metal = result.runtime.variant === 'vllm-metal';
  if (result.schema_version === 1 && (result.model.format !== undefined || result.method?.version === 2)) throw new Error('Version 1 benchmarks describe llama.cpp GGUF measurements.');
  if (result.schema_version === 2) {
    const formats = result.runtime.name === 'llama.cpp' ? ['gguf'] : metal ? ['hf-safetensors', 'mlx', 'gguf'] : result.runtime.name === 'vllm' ? ['hf-safetensors'] : ['hf-safetensors', 'mlx'];
    if (!result.model.format || !formats.includes(result.model.format) || result.method && result.method.version !== 2 || result.runtime.name !== 'llama.cpp' && result.model.metadata != null) throw new Error('Invalid runtime/model format for version 2 benchmark.');
  }
}

const asciiCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function compareSettings(a: RecordedSetting, b: RecordedSetting): number {
  const target = asciiCompare(a.target, b.target);
  if (target) return target;
  for (let index = 0; index < Math.min(a.scope.length, b.scope.length); index++) {
    const scope = asciiCompare(a.scope[index], b.scope[index]);
    if (scope) return scope;
  }
  return a.scope.length - b.scope.length || asciiCompare(a.name, b.name);
}

function validateExecution(execution: ServingExecution): void {
  for (let index = 1; index < execution.settings.length; index++) {
    if (compareSettings(execution.settings[index - 1], execution.settings[index]) >= 0) throw new Error('Public settings must have unique, ASCII-sorted target/scope/name identities.');
  }
}

function validateServing(result: ServingPublicBenchmarkSubmission): void {
  const { workload, execution } = result;
  const ordered = (values: number[]) => values.every((value, index) => index === 0 || value > values[index - 1]);
  if (!ordered(workload.inputs.map(input => input.bytes)) || !ordered(workload.concurrencies) || workload.inputs.length * workload.concurrencies.length > 64) throw new Error('Invalid serving workload operating points.');
  validateExecution(execution);
  const requests = execution.settings.filter(setting => setting.target === 'request');
  const expected = ['max_tokens', 'stream', ...(workload.request_usage ? ['stream_options.include_usage'] : []), 'temperature'];
  if (requests.length !== expected.length || requests.some((setting, index) => setting.name !== expected[index]) || requests.find(setting => setting.name === 'max_tokens')?.value !== workload.max_output_tokens) throw new Error('Public request settings must describe the exact common serving request.');
  const rows = result.measurements.rows;
  if (rows.length !== workload.inputs.length * workload.concurrencies.length * workload.repetitions) throw new Error('Incomplete serving measurement grid.');
  const inputs = new Set(workload.inputs.map(input => input.bytes));
  const concurrencies = new Set(workload.concurrencies);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.input_bytes}/${row.concurrency}/${row.max_output_tokens}/${row.repetition}`;
    if (!inputs.has(row.input_bytes) || !concurrencies.has(row.concurrency) || row.max_output_tokens !== workload.max_output_tokens || row.repetition > workload.repetitions || seen.has(key)) throw new Error('Invalid serving measurement grid membership.');
    seen.add(key);
    if (!Number.isSafeInteger(row.content_bytes + row.reasoning_bytes) || row.output_bytes !== row.content_bytes + row.reasoning_bytes || row.finish_reasons.length !== row.concurrency) throw new Error('Invalid serving output byte counts or finish slots.');
    const counters = [row.reported_prompt_tokens, row.reported_completion_tokens, row.reported_cached_tokens];
    const known = counters.filter(value => value !== null).length;
    if ((row.usage_status === 'complete' && known !== 3) || (row.usage_status === 'partial' && known === 3) || ((row.usage_status === 'missing' || row.usage_status === 'invalid') && known !== 0) || (row.reported_cached_tokens !== null && row.reported_prompt_tokens !== null && row.reported_cached_tokens > row.reported_prompt_tokens)) throw new Error('Invalid serving reported usage.');
    if ((row.content_bytes === 0 && row.first_content_ms !== null) || (row.reasoning_bytes === 0 && row.first_reasoning_ms !== null) || (row.output_bytes === 0 && row.first_output_ms !== null)) throw new Error('Empty serving output cannot have a first-output observation.');
    if (execution.memory_scope === 'unavailable' && row.peak_memory_bytes !== null) throw new Error('Unavailable compute memory cannot carry a measurement.');
  }
}

/** Shared by public export, the upload queue, and HTTP boundary validation. */
export function validatePublicBenchmark(value: unknown): PublicBenchmarkSubmission {
  assertSchema(value, contractSchema, 'benchmark');
  const result = value as PublicBenchmarkSubmission;
  if (result.schema_version === 3) validateServing(result);
  else validateLegacy(result);
  if ((result.model.status === 'sha256') !== (result.model.sha256 !== null)) throw new Error('Invalid public benchmark model identity.');
  const metadata = result.model.metadata;
  if (metadata?.artifact && (!metadata.repository || metadata.source === 'gguf')) throw new Error('A public model artifact requires a matched download repository.');
  return result;
}

/** Validate only an actual legacy runtime/execution projection; no fabricated measurements. */
export function validateLegacyBenchmarkConfiguration(value: unknown, schemaVersion: 1 | 2): Pick<LegacyPublicBenchmarkSubmission, 'runtime' | 'execution'> {
  const properties = contractSchema.$defs?.legacy.properties;
  if (!properties?.runtime || !properties.execution || ![1, 2].includes(schemaVersion)) throw new Error('Unsupported legacy benchmark configuration.');
  assertSchema(value, {
    type: 'object', properties: { runtime: properties.runtime, execution: properties.execution },
    required: ['runtime', 'execution'], additionalProperties: false,
  }, 'configuration');
  const result = value as Pick<LegacyPublicBenchmarkSubmission, 'runtime' | 'execution'>;
  validateLegacyConfigurationRules(result, schemaVersion);
  return result;
}

/** Validate a configuration projection without manufacturing a model or workload. */
export function validateBenchmarkConfiguration(value: unknown): BenchmarkConfiguration {
  assertSchema(value, {
    type: 'object', properties: { runtime: { $ref: '#/$defs/servingRuntime' }, execution: { $ref: '#/$defs/servingExecution' } },
    required: ['runtime', 'execution'], additionalProperties: false,
  }, 'configuration');
  const result = value as BenchmarkConfiguration;
  validateExecution(result.execution);
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
