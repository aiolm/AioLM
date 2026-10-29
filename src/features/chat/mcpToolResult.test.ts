// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { serializeMcpToolResult } from './mcpToolResult';

describe('model-facing MCP text observations', () => {
  it('preserves arbitrary text and explicit error flags without mutating the native result', () => {
    for (const isError of [undefined, false, true]) {
      const result = { content: [{ type: 'text', text: 'Line one\n"quoted" value: 47' }], ...(isError === undefined ? {} : { isError }) };
      const original = structuredClone(result);
      expect(JSON.parse(serializeMcpToolResult(result))).toEqual({ text: result.content[0].text, ...(isError === undefined ? {} : { isError }) });
      expect(result).toEqual(original);
    }
  });
  it('keeps rich blocks, structured content, annotations and unknown fields verbatim', () => {
    for (const result of [
      { content: [] }, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] },
      { content: [{ type: 'text', text: 'a', annotations: { audience: ['user'] } }] },
      { content: [{ type: 'text', text: 'a' }], structuredContent: { value: 47 } },
      { content: [{ type: 'text', text: 'a' }], _meta: { synthetic: true } },
      { content: [{ type: 'text', text: 'a' }], text: 'another field' },
      { content: [{ type: 'text', text: 'a' }], isError: 'invalid' },
      { content: [{ type: 'text', text: 47 }] }, null, 'legacy result',
    ]) expect(serializeMcpToolResult(result)).toBe(JSON.stringify(result));
  });
  it('checks the original result limit before flattening its wrapper', () => {
    expect(() => serializeMcpToolResult({ content: [{ type: 'text', text: 'x'.repeat(256_000) }] })).toThrow('256 KiB');
    expect(() => serializeMcpToolResult(undefined)).toThrow('no JSON result');
  });
});
