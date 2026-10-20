import { describe, it, expect } from 'vitest';
import { resolveDetectedToolCall } from './chatSendHelpers';
import type { ChatMcpTool } from './useChatMcpTools';

function resolve(schema: unknown, args: Record<string, unknown>) {
  const entry: ChatMcpTool = {
    serverId: 'synthetic-server', serverName: 'Synthetic MCP',
    tool: { name: 'synthetic_tool', description: 'Synthetic argument validation', input_schema: schema },
  };
  return resolveDetectedToolCall({
    id: 'synthetic-call', type: 'function',
    function: { name: 'approved_tool', arguments: JSON.stringify(args) },
  }, new Map([['approved_tool', entry]]));
}

describe('approved MCP calls use JSON-owned argument fields', () => {
  for (const key of ['constructor', 'toString', 'valueOf']) {
    it(`requires an own ${key} field`, () => {
      expect(() => resolve({ type: 'object', required: [key] }, {})).toThrow(`missing required field: ${key}`);
    });

    it(`accepts an omitted optional ${key} field`, () => {
      expect(resolve({ type: 'object', properties: { [key]: { type: 'string' } } }, {}).argumentsValue).toEqual({});
    });

    it(`accepts the explicit JSON ${key} field`, () => {
      const args = JSON.parse(`{"${key}":"provided"}`);
      expect(resolve({ type: 'object', required: [key], properties: { [key]: { type: 'string' } } }, args).argumentsValue).toEqual(args);
    });
  }

  it('keeps ordinary required and declared type validation', () => {
    expect(() => resolve({ required: ['name'], properties: { name: { type: 'string' } } }, {})).toThrow('missing required field: name');
    expect(() => resolve({ required: ['name'], properties: { name: { type: 'string' } } }, { name: 4 })).toThrow('name must be a string');
    expect(resolve({ required: ['name'], properties: { name: { type: 'string' } } }, { name: 'present' }).argumentsValue).toEqual({ name: 'present' });
  });
});
