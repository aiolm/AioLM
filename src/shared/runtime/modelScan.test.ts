// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { cancelModelScan, listModels, type ModelScanResult } from '../api';
import { startModelScan } from './modelScan';

vi.mock('../api', () => ({ listModels: vi.fn(), cancelModelScan: vi.fn(async () => undefined) }));
afterEach(() => vi.clearAllMocks());

it('cancels only the owning consumer and does not cancel completed scans', async () => {
  const resolve: ((value: ModelScanResult) => void)[] = [];
  vi.mocked(listModels).mockImplementation(() => new Promise(done => { resolve.push(done); }));
  const first = startModelScan('models/first');
  const second = startModelScan('models/second');
  const firstId = vi.mocked(listModels).mock.calls[0][1];
  const secondId = vi.mocked(listModels).mock.calls[1][1];
  expect(firstId).not.toBe(secondId);
  first.cancel(); first.cancel();
  expect(cancelModelScan).toHaveBeenCalledExactlyOnceWith(firstId);
  resolve[1]({ models: [], truncated: false });
  await second.result;
  second.cancel();
  expect(cancelModelScan).toHaveBeenCalledTimes(1);
  resolve[0]({ models: [], truncated: false });
  await first.result;
});
