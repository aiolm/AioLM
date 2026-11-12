import type { Locale } from '../../shared/i18n/i18n';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { benchmarkCopy } from './benchmarkCopy';
import { benchmarkReport } from './benchmarkReport';
import type { PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';

const notes: Record<Locale, string> = {
  en: 'Serving time and bytes are client-observed; token/cache counts are engine-reported. Method @2 requires the exact selected output-token count for every request; @1 records retain cap semantics and may have unknown counters. Statistics are per-metric medians, minima, maxima and observed sample counts. Legacy columns retain historical token measurements. Model revisions describe source snapshots, not weight integrity.',
  ko: 'Serving 시간·bytes는 클라이언트 관측값이며 토큰·캐시 수는 엔진 보고값입니다. @2는 모든 요청에서 선택한 출력 토큰 수를 검증하며, @1 기록은 상한 방식과 미확인 카운터를 그대로 보존합니다. 통계는 지표별 중앙값·최솟값·최댓값·관측 표본 수입니다. Legacy 열은 과거 토큰 측정값을 보존합니다. 모델 리비전은 출처 스냅샷이며 가중치 무결성 증거가 아닙니다.',
  ja: 'Serving の時間とbytesはクライアント観測値で、トークン・キャッシュ数はエンジン報告値です。@2は全リクエストで選択した出力トークン数を検証し、@1の記録は上限方式と不明なカウンターを保持します。統計は指標ごとの中央値・最小値・最大値・観測標本数です。Legacy列は過去のトークン測定値を保持します。モデルリビジョンは出典スナップショットであり、重みの完全性の証拠ではありません。',
  zh: 'Serving 时间和bytes由客户端观测，令牌和缓存数量由引擎报告。@2验证所有请求均达到所选输出令牌数，@1记录保留上限语义和未知计数。统计为各指标的中位数、最小值、最大值和观测样本数。Legacy列保留历史令牌测量值。模型修订描述来源快照，并非权重完整性证明。',
};
const ESCAPES: Record<string, string> = { '\\': '\\\\', '`': '\\`', '*': '\\*', '[': '\\[', ']': '\\]', '|': '\\|', '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** Inert table/heading text without truncating the frozen data, including public settings. */
function markdownText(value: string): string {
  return normalizeDisplayText(value).replace(/[\r\n\p{Cc}\p{Cf}]/gu, ' ').replace(/[\\`*[\]|&<>]/g, char => ESCAPES[char] ?? char);
}

/** Exactly the same frozen identity and aggregate cells as CSV and XLSX, with Markdown escaping. */
export function performanceMarkdown(record: PerformanceBenchmarkRecord, locale: Locale): string {
  const copy = benchmarkCopy(locale);
  const report = benchmarkReport([record], locale);
  const [firstRow] = report.rows;
  if (!firstRow) return '';
  const text = (value: string | number | null | undefined) => value == null ? copy.unavailable : markdownText(String(value));
  return [
    `# ${copy.title} · ${text(firstRow[0]) || copy.unavailable}`,
    '',
    `| ${report.columns.map(column => markdownText(column.label)).join(' | ')} |`,
    `| ${report.columns.map(column => column.numFmt ? '---:' : '---').join(' | ')} |`,
    ...report.rows.map(row => `| ${row.map(text).join(' | ')} |`),
    '', notes[locale], '',
  ].join('\n');
}
