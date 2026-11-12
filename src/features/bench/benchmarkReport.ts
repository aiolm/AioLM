import type { Locale } from '../../shared/i18n/i18n';
import { inferenceMetricCopy } from '../../shared/i18n/inferenceMetricCopy';
import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { SERVING_METRIC_KEYS, summarizePerformanceRows, summarizeServingPoints } from '../../shared/contracts/benchmark/aggregation';
import { publicModelSource } from '../../shared/contracts/benchmark/publicBenchmark';
import { benchmarkCopy } from './benchmarkCopy';
import { visibleBenchmarkRecords } from './benchmarkCancellation';
import type { PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';
import { recordedBenchmarkModelLabel } from './performanceRecords';

export interface BenchmarkReport {
  sheetName: string;
  columns: Array<{ key?: string; label: string; width: number; numFmt?: string }>;
  rows: Array<Array<string | number | null>>;
}

const identityKeys = ['measured_at', 'method', 'input_unit', 'runtime.name', 'runtime.version', 'runtime.backend', 'runtime.build', 'runtime.variant', 'runtime.plugin_version', 'model.format', 'model.status', 'model.sha256', 'model.size_bytes', 'model.repository', 'model.revision', 'app_version', 'execution.topology', 'execution.memory_scope', 'execution.settings'] as const;
const identityLabels: Record<Locale, string[]> = {
  en: ['Measured at', 'Method', 'Input unit', 'Runtime name', 'Runtime version', 'Runtime backend', 'Runtime build', 'Runtime variant', 'Runtime plugin version', 'Model format', 'Model identity status', 'Model SHA256', 'Model size (bytes)', 'Model repository', 'Model revision (not weight SHA)', 'App version', 'Execution topology', 'Memory scope', 'Public settings'],
  ko: ['측정 시각', '측정 방법', '입력 단위', '런타임 이름', '런타임 버전', '런타임 백엔드', '런타임 빌드', '런타임 변형', '런타임 플러그인 버전', '모델 형식', '모델 식별 상태', '모델 SHA256', '모델 크기 (bytes)', '모델 저장소', '모델 리비전 (가중치 SHA 아님)', '앱 버전', '실행 구성', '메모리 관측 범위', '공개 설정'],
  ja: ['測定日時', '測定方法', '入力単位', 'ランタイム名', 'ランタイムバージョン', 'ランタイムバックエンド', 'ランタイムビルド', 'ランタイム種別', 'プラグインバージョン', 'モデル形式', 'モデル識別状態', 'モデル SHA256', 'モデルサイズ (bytes)', 'モデルリポジトリ', 'モデルリビジョン (重み SHA ではない)', 'アプリバージョン', '実行構成', 'メモリ観測範囲', '公開設定'],
  zh: ['测量时间', '测量方法', '输入单位', '运行时名称', '运行时版本', '运行时后端', '运行时构建', '运行时变体', '插件版本', '模型格式', '模型身份状态', '模型 SHA256', '模型大小 (bytes)', '模型仓库', '模型修订 (非权重 SHA)', '应用版本', '执行拓扑', '内存观测范围', '公开设置'],
};
const metricLabels: Record<Locale, string[]> = {
  en: ['First output (ms)', 'First content (ms)', 'First reasoning (ms)', 'Batch duration (ms)', 'Content (bytes)', 'Reasoning (bytes)', 'Observed output (bytes)', 'Observed output (B/s)', 'Reported prompt tokens', 'Reported completion tokens', 'Reported cached tokens', 'Reported tokens/s', 'Peak process RAM (bytes)'],
  ko: ['첫 출력 (ms)', '첫 본문 (ms)', '첫 reasoning (ms)', '배치 소요 시간 (ms)', '본문 (bytes)', 'Reasoning (bytes)', '관측 출력 (bytes)', '관측 출력 (B/s)', '보고된 입력 토큰', '보고된 출력 토큰', '보고된 캐시 토큰', '보고된 tok/s', '최대 프로세스 RAM (bytes)'],
  ja: ['最初の出力 (ms)', '最初の本文 (ms)', '最初の reasoning (ms)', 'バッチ所要時間 (ms)', '本文 (bytes)', 'Reasoning (bytes)', '観測出力 (bytes)', '観測出力 (B/s)', '報告入力トークン', '報告出力トークン', '報告キャッシュトークン', '報告 tok/s', '最大プロセス RAM (bytes)'],
  zh: ['首次输出 (ms)', '首次正文 (ms)', '首次 reasoning (ms)', '批次耗时 (ms)', '正文 (bytes)', 'Reasoning (bytes)', '观测输出 (bytes)', '观测输出 (B/s)', '报告输入 token', '报告输出 token', '报告缓存 token', '报告 tok/s', '进程峰值 RAM (bytes)'],
};
const pointLabels: Record<Locale, string[]> = {
  en: ['Input UTF8 bytes', 'Max output token request', 'Concurrency', 'Samples'],
  ko: ['입력 UTF8 bytes', '최대 출력 token 요청', '동시 요청 수', '표본 수'],
  ja: ['入力 UTF8 bytes', '最大出力 token リクエスト', '同時リクエスト数', '標本数'],
  zh: ['输入 UTF8 bytes', '最大输出 token 请求', '并发请求数', '样本数'],
};
const statLabels: Record<Locale, string[]> = {
  en: ['median', 'min', 'max', 'samples'], ko: ['중앙값', '최소', '최대', '표본 수'],
  ja: ['中央値', '最小', '最大', '標本数'], zh: ['中位数', '最小', '最大', '样本数'],
};

/** Same local clock as history, with a sortable spreadsheet representation. */
function measuredAt(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function displayLabel(record: PerformanceBenchmarkRecord): string {
  return normalizeDisplayText(modelDisplayName(recordedBenchmarkModelLabel(record))).split(/[\\/]/).pop()?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() ?? '';
}
const finite = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : null;

/** One data projection for CSV, XLSX and Markdown. No live model/runtime lookups or argv parsing. */
export function benchmarkReport(records: PerformanceBenchmarkRecord[], locale: Locale = 'en'): BenchmarkReport {
  const copy = benchmarkCopy(locale);
  const legacyColumns = [
    ['prompt_tokens', copy.promptLengths], ['generation_length', copy.generation], ['ttft_ms', `${copy.ttft} (ms)`],
    ['tpot_ms', `${copy.tpot} (ms)`], ['pp_tps', `${copy.pp} (tok/s)`], ['tg_tps', `${copy.tg} (tok/s)`],
    ['tg_stddev', `${inferenceMetricCopy(locale).decodeDeviation} (tok/s)`], ['speedup', copy.speedup],
    ['e2e_seconds', `${copy.e2e} (${copy.seconds})`], ['total_tps', `${copy.throughput} (tok/s)`],
    ['peak_memory_gib', `${copy.memory} (GiB)`],
  ] as const;
  const onlyFixedOutput = records.length > 0 && records.every(record => record.schemaVersion === 2 && record.request.method.version === 2);
  const columns: Array<BenchmarkReport['columns'][number] & { key: string }> = [
    { key: 'recorded_model_label', label: copy.shareModel, width: 42 },
    // Each locale defines one label per identity key, in the same order.
    ...identityKeys.map((key, index) => ({ key, label: identityLabels[locale][index]!, width: key === 'execution.settings' ? 60 : 24, ...(key === 'model.size_bytes' ? { numFmt: '#,##0' } : {}) })),
    // Each locale defines the four point labels in this key order.
    ...['input_bytes', 'max_output_tokens', 'concurrency', 'samples'].map((key, index) => ({ key, label: index === 1 && onlyFixedOutput ? copy.outputTokens : pointLabels[locale][index]!, width: 20, numFmt: '#,##0' })),
    ...SERVING_METRIC_KEYS.flatMap((key, index) => ['median', 'min', 'max', 'samples'].map((stat, statIndex) => ({
      key: `${key}.${stat}`, label: `${metricLabels[locale][index]} · ${statLabels[locale][statIndex]}`, width: 24,
      numFmt: stat === 'samples' ? '#,##0' : '#,##0.###############',
    }))),
    ...legacyColumns.map(([key, label]) => ({ key: `legacy.${key}`, label: `${copy.legacy} · ${label}`, width: 26, numFmt: '#,##0.###############' })),
    { key: 'status', label: copy.shareStatus, width: 14 },
  ];
  const rows: BenchmarkReport['rows'] = [];
  for (const record of visibleBenchmarkRecords(records)) {
    const p = record.result.provenance;
    const serving = record.schemaVersion === 2 ? record.result.provenance : undefined;
    const legacy = record.schemaVersion === 1 ? record : undefined;
    const runtime = serving?.runtime;
    const model = p?.model;
    const source = model ? publicModelSource(model) : undefined;
    const method = p?.method ?? (record.schemaVersion === 2 ? record.request.method : undefined);
    const values: Record<string, string | number | null> = {
      recorded_model_label: displayLabel(record), measured_at: measuredAt(record.createdAt),
      method: method ? `${method.id}@${method.version}` : null, input_unit: record.schemaVersion === 2 ? 'utf8_bytes' : 'tokens',
      'runtime.name': runtime?.name ?? null, 'runtime.version': runtime?.version ?? legacy?.result.runtime_version ?? null,
      'runtime.backend': runtime?.backend ?? legacy?.backend ?? null, 'runtime.build': runtime?.build ?? legacy?.build ?? null,
      'runtime.variant': runtime?.variant ?? legacy?.result.runtime_variant ?? null,
      'runtime.plugin_version': runtime?.plugin_version ?? legacy?.result.runtime_plugin_version ?? null,
      'model.format': model?.format ?? null, 'model.status': model?.status ?? null, 'model.sha256': model?.sha256 ?? null,
      'model.size_bytes': finite(model?.size_bytes), 'model.repository': source?.repository ?? null, 'model.revision': source?.revision ?? null,
      app_version: p?.app_version ?? null, 'execution.topology': serving?.execution.topology ?? null,
      'execution.memory_scope': serving?.execution.memory_scope ?? null,
      'execution.settings': serving ? JSON.stringify(serving.execution.settings) : null,
    };
    const status = { complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed }[record.result.status];
    const append = (point: Record<string, string | number | null> = {}, pointStatus = status) => {
      rows.push(columns.map(column => (column.key === 'status' ? pointStatus : point[column.key] ?? values[column.key] ?? null)));
    };
    if (record.schemaVersion === 2) {
      const points = summarizeServingPoints(record.result.rows);
      if (!points.length) append();
      for (const point of points) {
        const cells: Record<string, number | null> = { input_bytes: point.input_bytes, max_output_tokens: point.max_output_tokens, concurrency: point.concurrency, samples: point.samples };
        for (const key of SERVING_METRIC_KEYS) {
          for (const stat of ['median', 'min', 'max', 'samples'] as const) cells[`${key}.${stat}`] = finite(point[key]?.[stat]);
        }
        append(cells);
      }
    } else {
      const points = summarizePerformanceRows(record.result.rows);
      if (!points.length) append();
      for (const point of points) append({
        concurrency: point.concurrency, samples: point.samples,
        'legacy.prompt_tokens': point.prompt_tokens, 'legacy.generation_length': point.generation_length,
        'legacy.ttft_ms': finite(point.ttft_ms), 'legacy.tpot_ms': finite(point.tpot_ms),
        'legacy.pp_tps': finite(point.pp_tps), 'legacy.tg_tps': finite(point.tg_tps),
        'legacy.tg_stddev': point.samples > 1 ? finite(point.tg_stddev) : null,
        'legacy.speedup': point.concurrency > 1 ? finite(point.speedup) : null,
        'legacy.e2e_seconds': point.error ? null : finite(point.e2e_ms / 1000), 'legacy.total_tps': finite(point.total_tps),
        'legacy.peak_memory_gib': point.peak_memory_bytes == null ? null : finite(point.peak_memory_bytes / 1024 ** 3),
      }, point.error ? copy.failed : status);
    }
  }
  return { sheetName: copy.shareResults, columns, rows };
}
