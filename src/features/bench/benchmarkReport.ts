import type { Locale } from '../../shared/i18n/i18n';
import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { SERVING_METRIC_KEYS, summarizeServingPoints } from '../../shared/contracts/benchmark/aggregation';
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
  en: ['First output (TTFT, ms)', 'Prompt processing per request (Prefill, tok/s)', 'Generation speed per request (Decode, tok/s)', 'Time per output token (TPOT, ms)', 'Total token throughput (tok/s)', 'Observed output (B/s)', 'Batch duration (E2E, ms)', 'Peak process RAM (bytes)'],
  ko: ['첫 출력 (TTFT, ms)', '요청당 입력 처리 속도 (Prefill, tok/s)', '요청당 생성 속도 (Decode, tok/s)', '출력 토큰당 시간 (TPOT, ms)', '전체 토큰 처리량 (Throughput, tok/s)', '관측 출력 (B/s)', '배치 소요 시간 (E2E, ms)', '최대 프로세스 RAM (bytes)'],
  ja: ['最初の出力 (TTFT, ms)', 'リクエストあたりの入力処理速度 (Prefill, tok/s)', 'リクエストあたりの生成速度 (Decode, tok/s)', '出力トークンあたりの時間 (TPOT, ms)', '全体トークン処理量 (Throughput, tok/s)', '観測出力 (B/s)', 'バッチ所要時間 (E2E, ms)', '最大プロセス RAM (bytes)'],
  zh: ['首次输出 (TTFT, ms)', '每请求输入处理速度 (Prefill, tok/s)', '每请求生成速度 (Decode, tok/s)', '每输出令牌时间 (TPOT, ms)', '总令牌吞吐量 (Throughput, tok/s)', '观测输出 (B/s)', '批次耗时 (E2E, ms)', '进程峰值 RAM (bytes)'],
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
  return normalizeDisplayText(modelDisplayName(recordedBenchmarkModelLabel(record))).replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}
const finite = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : null;

/** One data projection for CSV, XLSX and Markdown. No live model/runtime lookups or argv parsing. */
export function benchmarkReport(records: PerformanceBenchmarkRecord[], locale: Locale = 'en'): BenchmarkReport {
  const copy = benchmarkCopy(locale);
  const columns: Array<BenchmarkReport['columns'][number] & { key: string }> = [
    { key: 'recorded_model_label', label: copy.shareModel, width: 42 },
    // Each locale defines one label per identity key, in the same order.
    ...identityKeys.map((key, index) => ({ key, label: identityLabels[locale][index]!, width: key === 'execution.settings' ? 60 : 24, ...(key === 'model.size_bytes' ? { numFmt: '#,##0' } : {}) })),
    { key: 'workload.corpus', label: copy.corpus, width: 20 },
    { key: 'workload.cache_policy', label: copy.cachePolicy, width: 24 },
    { key: 'workload.prompt_nonce', label: copy.promptNonce, width: 36 },
    // Each locale defines the four point labels in this key order.
    ...['input_bytes', 'max_output_tokens', 'concurrency', 'samples'].map((key, index) => ({ key, label: pointLabels[locale][index]!, width: 20, numFmt: '#,##0' })),
    ...SERVING_METRIC_KEYS.flatMap((key, index) => ['median', 'min', 'max', 'samples'].map((stat, statIndex) => ({
      key: `${key}.${stat}`, label: `${metricLabels[locale][index]} · ${statLabels[locale][statIndex]}`, width: 24,
      numFmt: stat === 'samples' ? '#,##0' : '#,##0.###############',
    }))),
    { key: 'status', label: copy.shareStatus, width: 14 },
  ];
  const rows: BenchmarkReport['rows'] = [];
  for (const record of visibleBenchmarkRecords(records)) {
    const p = record.result.provenance;
    const runtime = p?.runtime;
    const model = p?.model;
    const source = model ? publicModelSource(model) : undefined;
    const method = p?.method ?? record.request.method;
    const values: Record<string, string | number | null> = {
      recorded_model_label: displayLabel(record), measured_at: measuredAt(record.createdAt),
      method: `${method.id}@${method.version}`, input_unit: 'utf8_bytes',
      'runtime.name': runtime?.name ?? null, 'runtime.version': runtime?.version ?? null,
      'runtime.backend': runtime?.backend ?? null, 'runtime.build': runtime?.build ?? null,
      'runtime.variant': runtime?.variant ?? null,
      'runtime.plugin_version': runtime?.plugin_version ?? null,
      'model.format': model?.format ?? null, 'model.status': model?.status ?? null, 'model.sha256': model?.sha256 ?? null,
      'model.size_bytes': finite(model?.size_bytes), 'model.repository': source?.repository ?? null, 'model.revision': source?.revision ?? null,
      app_version: p?.app_version ?? null, 'execution.topology': p?.execution.topology ?? null,
      'execution.memory_scope': p?.execution.memory_scope ?? null,
      'execution.settings': p ? JSON.stringify(p.execution.settings) : null,
      'workload.corpus': p?.workload.corpus ?? null,
      'workload.cache_policy': p?.workload.cache_policy ?? null,
      'workload.prompt_nonce': p?.workload.prompt_nonce ?? null,
    };
    const status = { complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed }[record.result.status];
    const append = (point: Record<string, string | number | null> = {}, pointStatus = status) => {
      rows.push(columns.map(column => (column.key === 'status' ? pointStatus : point[column.key] ?? values[column.key] ?? null)));
    };
    const points = summarizeServingPoints(record.result.rows);
    if (!points.length) append();
    for (const point of points) {
      const cells: Record<string, number | null> = { input_bytes: point.input_bytes, max_output_tokens: point.max_output_tokens, concurrency: point.concurrency, samples: point.samples };
      for (const key of SERVING_METRIC_KEYS) {
        for (const stat of ['median', 'min', 'max', 'samples'] as const) cells[`${key}.${stat}`] = finite(point[key]?.[stat]);
      }
      append(cells);
    }
  }
  return { sheetName: copy.shareResults, columns, rows };
}
