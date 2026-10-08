import { expect, it } from 'vitest';
import { loadedModelPath } from './loadedModel';

it('retains the loaded artifact when its public ID is an alias and the saved model has changed', () => {
  const path = '/synthetic/cache/models--example--Qwen-model/snapshots/' + 'a'.repeat(40);
  const status = { model: 'served-alias', execution: { active_model: path } };
  expect(loadedModelPath(status, '/synthetic/next-model')).toBe(path);
  expect(status.model).toBe('served-alias');
  expect(loadedModelPath({ model: 'C:\\models\\loaded.gguf' }, 'next.gguf')).toBe('C:\\models\\loaded.gguf');
});

it('preserves legacy IDs and uses a configured fallback only when no live identity exists', () => {
  expect(loadedModelPath({ model: 'legacy-model', execution: { active_model: '' } }, 'next-model')).toBe('legacy-model');
  expect(loadedModelPath(undefined, 'selected.gguf')).toBe('selected.gguf');
  expect(loadedModelPath({})).toBe('');
});
