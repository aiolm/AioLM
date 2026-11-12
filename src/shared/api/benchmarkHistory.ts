import type { BenchmarkReceipt } from '@aiolm/benchmark-contracts';
import type { LegacyPerformanceBenchmarkRequest, LegacyPerformanceBenchmarkResult, PerformanceBenchmarkRequest, PerformanceBenchmarkResult } from './types.ts';
import { invoke } from './transport.ts';

/** Hardware context retained with each measurement; no machine or owner identifiers. */
export interface BenchmarkDevice {
  fingerprint: string;
  os: string;
  arch: string;
  cpu: string;
  cpuThreads: number;
  gpu?: string;
  gpuVendor?: string;
  gpuVramMb?: number;
}

interface PerformanceRecordIdentity {
  localState?: 'recovery' | 'cached';
  remoteReceipt?: BenchmarkReceipt & { destination: string };
  acknowledgedAt?: number;
  id: string;
  createdAt: number;
  model: string;
  device?: BenchmarkDevice;
}

/** Legacy records retain their token-based request/result without migration. */
export interface LegacyPerformanceBenchmarkRecord extends PerformanceRecordIdentity {
  schemaVersion: 1;
  backend: string;
  build: string;
  request: LegacyPerformanceBenchmarkRequest;
  result: LegacyPerformanceBenchmarkResult;
}

export interface ServingPerformanceBenchmarkRecord extends PerformanceRecordIdentity {
  schemaVersion: 2;
  request: PerformanceBenchmarkRequest;
  result: PerformanceBenchmarkResult;
}
export type PerformanceBenchmarkRecord = LegacyPerformanceBenchmarkRecord | ServingPerformanceBenchmarkRecord;

export interface BenchmarkHistoryPage {
  records: PerformanceBenchmarkRecord[];
  total: number;
  next_offset: number | null;
  warnings?: string[];
}

export interface BenchmarkAcknowledgement {
  acknowledged: boolean;
  pruned: number;
  warnings: string[];
}

export const benchmarkHistoryList = (offset: number, limit: number): Promise<BenchmarkHistoryPage> =>
  invoke<BenchmarkHistoryPage>('benchmark_history_list', { offset, limit });
export const benchmarkHistoryImport = (records: PerformanceBenchmarkRecord[]): Promise<number> =>
  invoke<number>('benchmark_history_import', { records });
export const benchmarkHistoryDelete = (runId: string): Promise<void> =>
  invoke<void>('benchmark_history_delete', { runId });
export const benchmarkExportCsv = (contents: string, fileName: string): Promise<boolean> =>
  invoke<boolean>('benchmark_export_csv', { contents, fileName });
export const benchmarkExportXlsx = (contents: number[], fileName: string): Promise<boolean> =>
  invoke<boolean>('benchmark_export_xlsx', { contents, fileName });
export const benchmarkAcknowledgeUpload = (runId: string, receipt: BenchmarkReceipt & { destination: string }): Promise<BenchmarkAcknowledgement> =>
  invoke<BenchmarkAcknowledgement>('benchmark_acknowledge_upload', { runId, receipt });
