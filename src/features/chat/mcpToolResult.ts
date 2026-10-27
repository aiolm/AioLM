/** Format a tool observation for the model without changing the native RPC result. */
export function serializeMcpToolResult(result: unknown): string {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw new Error("MCP tool returned no JSON result.");
  if (serialized.length > 256_000) throw new Error("MCP tool result exceeds the 256 KiB chat safety limit.");
  if (!result || typeof result !== "object" || Array.isArray(result)) return serialized;
  const record = result as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "content" && key !== "isError")) return serialized;
  if (record.isError !== undefined && typeof record.isError !== "boolean") return serialized;
  if (!Array.isArray(record.content) || record.content.length !== 1) return serialized;
  const block: unknown = record.content[0];
  if (!block || typeof block !== "object" || Array.isArray(block)) return serialized;
  const textBlock = block as Record<string, unknown>;
  if (textBlock.type !== "text" || typeof textBlock.text !== "string"
    || Object.keys(textBlock).some(key => key !== "type" && key !== "text")) return serialized;
  // A simple text observation needs no nested content-block wrapper. Smaller
  // models can otherwise repeat call arguments instead of reading that text.
  // Rich, structured, annotated and unfamiliar results remain intact above.
  return JSON.stringify({ text: textBlock.text, ...(record.isError === undefined ? {} : { isError: record.isError }) });
}
