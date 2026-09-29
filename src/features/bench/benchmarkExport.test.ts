import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from 'exceljs';
import { invoke, isNativeRuntimeAvailable } from '../../shared/api/transport';
import { exportBenchmarkResults } from './benchmarkExport';
import { loadAllBenchmarkHistory } from './benchmarkRepository';
import type { PerformanceBenchmarkRecord } from './performanceRecords';

vi.mock('../../shared/api/transport', () => ({ invoke: vi.fn(), isNativeRuntimeAvailable: vi.fn(() => true) }));

const record: PerformanceBenchmarkRecord = {
  schemaVersion: 1, id: 'saved', createdAt: new Date(2025, 3, 5, 6, 7, 8).getTime(), model: 'models/예제.gguf', backend: 'cpu', build: 'b1',
  request: { run_id: 'saved', context_profile: 'novel_ko', prompt_lengths: [1024], generation_length: 128, batch_sizes: [], repetitions: 1, warmup: true },
  result: { run_id: 'saved', rows: [], status: 'failed', message: 'Synthetic failure', args: [], runtime_version: 'test', context_size: 4096, parallel: 1 },
};

beforeEach(() => { vi.clearAllMocks(); vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('benchmark CSV delivery', () => {
  it('defaults to a formatted workbook and sends its bytes unchanged to the native save dialog', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    expect(await exportBenchmarkResults([record], 'selected', 'xlsx', 'ko')).toBe('saved');
    const [command, args] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe('benchmark_export_xlsx');
    expect(args?.fileName).toBe('aiolm-benchmark_예제_2025-04-05_06-07-08.xlsx');
    const bytes = new Uint8Array(args?.contents as number[]);
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    const workbook = new Workbook();
    await workbook.xlsx.load(bytes.buffer);
    const sheet = workbook.getWorksheet('측정 결과')!;
    expect(sheet.getCell('A1').value).toBe('모델');
    expect(sheet.getCell('A2').value).toBe('예제.gguf');
    expect(sheet.getColumn(1).width).toBe(42);
    expect(sheet.columnCount).toBe(18);
    expect(sheet.getCell('A2').alignment.wrapText).toBe(true);
    expect(JSON.stringify(sheet.getSheetValues())).not.toMatch(/models\/|Synthetic failure|run_id/);
  });

  it('uses the native save command and retains failed runs and Korean model names', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    expect(await exportBenchmarkResults([record], 'selected', 'csv')).toBe('saved');
    expect(invoke).toHaveBeenCalledWith('benchmark_export_csv', {
      contents: expect.stringContaining('예제.gguf'), fileName: 'aiolm-benchmark_예제_2025-04-05_06-07-08.csv',
    });
    const csv = vi.mocked(invoke).mock.calls[0][1]!.contents as string;
    expect(csv).toContain('"Failed"');
    expect(csv).not.toContain('Synthetic failure');
    expect(csv).toContain('\r\n');
  });

  it('distinguishes cancelling the save dialog from a failed write', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(false).mockRejectedValueOnce('Permission denied');
    expect(await exportBenchmarkResults([record], 'selected', 'csv')).toBe('cancelled');
    await expect(exportBenchmarkResults([record], 'selected', 'csv')).rejects.toBe('Permission denied');
  });

  it('names full history by export time even when it contains only one run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 5, 7, 8, 9, 10));
    vi.mocked(invoke).mockResolvedValue(true);
    await exportBenchmarkResults([record], 'all', 'csv');
    expect(invoke).toHaveBeenCalledWith('benchmark_export_csv', {
      contents: expect.any(String), fileName: 'aiolm-benchmarks-all_2025-06-07_08-09-10.csv',
    });
  });

  it.each([
    ['C:\\synthetic\\models\\한글-모델-Q4_K_M-00001-of-00002.gguf', '한글-모델-Q4_K_M'],
    ['models/예제 : 모델?*.gguf', '예제-모델'],
    [`models/${'모델😀'.repeat(80)}.gguf`, '모델😀'.repeat(16)],
    ['models/...gguf', 'model'],
  ])('keeps model filenames portable without including local directories: %s', async (model, expected) => {
    vi.mocked(invoke).mockResolvedValue(true);
    await exportBenchmarkResults([{ ...record, model }], 'selected', 'csv');
    expect(invoke).toHaveBeenCalledWith('benchmark_export_csv', {
      contents: expect.any(String), fileName: `aiolm-benchmark_${expected}_2025-04-05_06-07-08.csv`,
    });
  });

  it('exports every history page, including results outside the visible page', async () => {
    const older = { ...record, id: 'older', model: 'models/older.gguf' };
    vi.mocked(invoke).mockResolvedValueOnce({ records: [record], total: 2, next_offset: 1 })
      .mockResolvedValueOnce({ records: [older], total: 2, next_offset: null }).mockResolvedValueOnce(true);
    expect(await exportBenchmarkResults(await loadAllBenchmarkHistory(), 'all', 'csv')).toBe('saved');
    expect(invoke).toHaveBeenNthCalledWith(1, 'benchmark_history_list', { offset: 0, limit: 100 });
    expect(invoke).toHaveBeenNthCalledWith(2, 'benchmark_history_list', { offset: 1, limit: 100 });
    const csv = vi.mocked(invoke).mock.calls[2][1]!.contents as string;
    expect(csv).toContain('"예제.gguf"');
    expect(csv).toContain('"older.gguf"');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('keeps the browser download URL alive until the browser can consume it', async () => {
    vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
    vi.useFakeTimers();
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:benchmark-csv');
      static revokeObjectURL = revoke;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('aiolm-benchmark_예제_2025-04-05_06-07-08.csv');
      expect(revoke).not.toHaveBeenCalled();
    });
    expect(await exportBenchmarkResults([record], 'selected', 'csv')).toBe('download-started');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:benchmark-csv');
    expect(invoke).not.toHaveBeenCalled();
  });
});
