// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildChatRequestBody } from './chat';
import type { EngineInfo } from './providers';

const engine: EngineInfo = { provider: 'vllm', runtime_id: 'synthetic', upstream_model: 'base-model',
  modalities: { text: true, image: false, audio: false, video: false }, tasks: ['generate'], request_fields: {} };
const sampling = { temperature: 0, top_p: 1, top_k: 40, provider: 'vllm' as const, engine };

describe('loaded chat capabilities', () => {
  it('refuses a completion-only model with actionable template guidance', () => {
    expect(() => buildChatRequestBody('public-model', [{ role: 'user', content: 'hello' }],
      { ...sampling, engine: { ...engine, chat_supported: false } })).toThrow(/Instruct\/chat model.*--chat-template/);
  });

  it('preserves chat requests for explicit support and older capability records', () => {
    for (const chat_supported of [true, undefined]) {
      const body = buildChatRequestBody('public-model', [{ role: 'user', content: 'hello' }],
        { ...sampling, engine: { ...engine, chat_supported } });
      expect(body.model).toBe('base-model');
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(body.chat_supported).toBeUndefined();
    }
  });

  it('keeps core streaming compatible when optional usage support is undeclared or false', () => {
    for (const stream_usage_supported of [undefined, false]) {
      const body = buildChatRequestBody('public-model', [{ role: 'user', content: 'hello' }],
        { ...sampling, engine: { ...engine, stream_usage_supported } });
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty('stream_options');
    }
  });

  it('requests usage only for declared support and preserves explicit stream options', () => {
    const supported = { ...engine, stream_usage_supported: true };
    expect(buildChatRequestBody('public-model', [], { ...sampling, engine: supported }).stream_options)
      .toEqual({ include_usage: true });
    for (const stream_usage_supported of [undefined, false, true]) {
      const explicit = { include_usage: false, include_obfuscation: false };
      const body = buildChatRequestBody('public-model', [], {
        ...sampling, engine: { ...engine, stream_usage_supported, request_fields: { stream_options: explicit } },
      });
      expect(body.stream_options).toEqual(explicit);
    }
  });
});
