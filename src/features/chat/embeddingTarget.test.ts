import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../shared/api/types';
import { selectEmbeddingSession } from './embeddingTarget';

const session = (id: string): SessionStatus => ({ id, name: id, state: 'running', url: 'http://127.0.0.1:9090', model: 'synthetic',
  engine: { provider: 'vllm', runtime_id: id, upstream_model: 'synthetic', modalities: { text: true, image: false, audio: false, video: false }, request_fields: {}, embedding_model: `${id}-encoder` } });

describe('document embedding target', () => {
  it('prefers the answering session and never picks an arbitrary engine when multiple other targets are running', () => {
    const own = session('answering'); const other = session('other');
    expect(selectEmbeddingSession([other, own], 'answering', 'auto')).toBe(own);
    expect(selectEmbeddingSession([other, own], 'third', 'auto')).toBeUndefined();
    expect(selectEmbeddingSession([other], 'third', 'auto')).toBe(other);
    expect(selectEmbeddingSession([other, own], 'answering', 'other')).toBe(other);
    expect(selectEmbeddingSession([{ ...other, state: 'stopped' }], 'answering', 'other')).toBeUndefined();
    expect(selectEmbeddingSession([own], 'answering', 'lexical')).toBeUndefined();
  });
});
