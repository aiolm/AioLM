import { publicBenchmarkSchema } from './schema.js';

type OutputPolicySchema = {
  $defs: {
    fixedOutputTokens: { enum: number[] };
    historicalOutputTokens: { maximum: number };
    servingWorkload: { properties: { max_output_tokens: { maximum: number } } };
  };
};
// The bundled schema owns these values; its public declaration intentionally hides its shape.
const schema = publicBenchmarkSchema as OutputPolicySchema;
const definitions = schema.$defs;

/** Exact engine-reported output targets accepted by fixed-output method v2. */
export const FIXED_OUTPUT_TOKENS: readonly number[] = Object.freeze(definitions.fixedOutputTokens.enum);
export const MAX_SERVING_OUTPUT_TOKENS = definitions.servingWorkload.properties.max_output_tokens.maximum;
export const HISTORICAL_CAP_MAX_OUTPUT_TOKENS = definitions.historicalOutputTokens.maximum;
