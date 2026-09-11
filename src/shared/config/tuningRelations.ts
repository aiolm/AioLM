export function validateTuningRelations(values: { ctxSize: number; parallel: number; ngl: number; temperature: number; dynatempRange: number; topP: number; minP: number }): string[] {
  const warnings: string[] = [];
  if (values.parallel > 1) warnings.push("Multiple server slots can increase memory usage.");
  if (values.ctxSize > 32_768) warnings.push("Large context sizes can consume substantial KV memory.");
  if (values.ngl === 0) warnings.push("GPU layers are disabled; inference will run on CPU unless the runtime chooses otherwise.");
  if (values.dynatempRange > 0 && values.temperature === 0) warnings.push("Dynamic temperature is enabled while temperature is zero.");
  if (values.topP < 1 && values.minP > 0.1) warnings.push("Top-p and Min-p are both restrictive; generation may become repetitive.");
  return warnings;
}
