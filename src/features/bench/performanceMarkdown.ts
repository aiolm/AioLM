import type { Locale } from '../../shared/i18n/i18n';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { benchmarkCopy } from './benchmarkCopy';
import { benchmarkReport } from './benchmarkReport';
import type { PerformanceBenchmarkRecord } from './performanceRecords';

const notes: Record<Locale, string> = {
  en: 'Serving measurements are client-observed; token/cache counts are self-reported and may be unknown. Statistics are per-metric medians, minima, maxima and observed sample counts. Legacy columns retain historical token measurements. Model revisions describe source snapshots, not weight integrity.',
  ko: 'Serving 측정값은 클라이언트 관측값이며 토큰/캐시 수는 엔진 보고값으로 미확인일 수 있습니다. 통계는 지표별 중앙값·최솟값·최댓값·관측 표본 수입니다. Legacy 열은 과거 토큰 측정값을 보존합니다. 모델 리비전은 출처 스냅샷이며 가중치 무결성 증거가 아닙니다.',
  ja: 'Serving 測定値はクライアント観測値です。トークン/キャッシュ数はエンジンの報告値で、不明な場合があります。統計は指標ごとの中央値・最小値・最大値・観測標本数です。Legacy 列は過去のトークン測定値を保持します。モデルリビジョンは出典スナップショットであり、重みの完全性の証拠ではありません。',
  zh: 'Serving 测量值由客户端观测；token/缓存计数由引擎报告，可能未知。统计为各指标的中位数、最小值、最大值和观测样本数。Legacy 列保留历史 token 测量值。模型修订描述来源快照，并非权重完整性证明。',
};
const ESCAPES: Record<string, string> = { '\\': '\\\\', '`': '\\`', '*': '\\*', '[': '\\[', ']': '\\]', '|': '\\|', '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** Inert table/heading text without truncating the frozen data, including public settings. */
function markdownText(value: string): string {
  return normalizeDisplayText(value).replace(/[\r\n\p{Cc}\p{Cf}]/gu, ' ').replace(/[\\`*[\]|&<>]/g, char => ESCAPES[char]);
}

/** Exactly the same frozen identity and aggregate cells as CSV and XLSX, with Markdown escaping. */
export function performanceMarkdown(record: PerformanceBenchmarkRecord, locale: Locale): string {
  const copy = benchmarkCopy(locale);
  const report = benchmarkReport([record], locale);
  if (!report.rows.length) return '';
  const text = (value: string | number | null) => value == null ? copy.unavailable : markdownText(String(value));
  return [
    `# ${copy.title} · ${text(report.rows[0][0]) || copy.unavailable}`,
    '',
    `| ${report.columns.map(column => markdownText(column.label)).join(' | ')} |`,
    `| ${report.columns.map(column => column.numFmt ? '---:' : '---').join(' | ')} |`,
    ...report.rows.map(row => `| ${row.map(text).join(' | ')} |`),
    '', notes[locale], '',
  ].join('\n');
}
