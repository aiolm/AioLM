// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { modelMetadata } from '../api/commands';
import { invalidateModelMetadata, readModelMetadata } from './modelMetadata';
import type { ModelMetadata } from '../api/types';

vi.mock('../api/commands', () => ({ modelMetadata: vi.fn() }));
beforeEach(() => { invalidateModelMetadata(); vi.resetAllMocks(); });

it('reuses results until a rescan invalidates them, and retries failures', async () => {
  vi.mocked(modelMetadata).mockResolvedValue({ architecture: 'qwen4exp' });
  expect(await readModelMetadata('models/example.gguf')).toEqual({ architecture: 'qwen4exp' });
  await readModelMetadata('models/example.gguf');
  expect(modelMetadata).toHaveBeenCalledTimes(1);
  invalidateModelMetadata();
  vi.mocked(modelMetadata).mockRejectedValueOnce(new Error('unavailable'));
  await expect(readModelMetadata('models/example.gguf')).rejects.toThrow('unavailable');
  await readModelMetadata('models/example.gguf');
  expect(modelMetadata).toHaveBeenCalledTimes(3);
});

it('deduplicates pending reads and limits concurrent header access', async () => {
  const finish: Array<(value: ModelMetadata) => void> = [];
  vi.mocked(modelMetadata).mockImplementation(() => new Promise(resolve => finish.push(resolve)));
  const reads = Array.from({ length: 6 }, (_, i) => readModelMetadata(`models/${i}.gguf`));
  expect(readModelMetadata('models/0.gguf')).toBe(reads[0]);
  await vi.waitFor(() => expect(modelMetadata).toHaveBeenCalledTimes(4));
  finish[0]({ architecture: 'qwen4exp' });
  finish[1]({});
  await vi.waitFor(() => expect(modelMetadata).toHaveBeenCalledTimes(6));
  finish.slice(2).forEach(resolve => resolve({}));
  await Promise.all(reads);
});
