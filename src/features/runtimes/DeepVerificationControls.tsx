import type { UnifiedKey, TranslationVars } from '../../shared/i18n/i18nUnified';
import { useI18n } from '../../shared/i18n/i18n';
import type { ProviderId } from '../../shared/api/providers';
import type { VerificationRecord } from '../../shared/api/types';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import StatusBadge from '../../shared/ui/StatusBadge';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { DEEP_VERIFICATION_TASK } from './useDeepVerification';

export interface DeepVerificationState {
  busy: boolean;
  record: { verdict: string; detail: string } & Partial<Omit<VerificationRecord, 'verdict' | 'detail'>> | null;
  error: string | null; start: () => void; cancel: () => void;
}
const copy = {
  ko: { partial: '검증 범위 제한', unavailable: '검증 불가', hint: '선택한 모델을 CPU 기준 결과와 비교합니다. 엔진과 모델에 따라 비교 가능한 범위가 달라집니다.' },
  en: { partial: 'Partial verification', unavailable: 'Verification unavailable', hint: 'Compares the selected model with CPU reference results. Available coverage depends on the engine and model.' },
  ja: { partial: '部分的な検証', unavailable: '検証不可', hint: '選択したモデルをCPU基準の結果と比較します。比較可能な範囲はエンジンとモデルにより異なります。' },
  zh: { partial: '部分验证', unavailable: '无法验证', hint: '将所选模型与CPU参考结果比较。可验证范围取决于引擎和模型。' },
};

export default function DeepVerificationControls({ t, state, provider = 'llama.cpp', runtimeBusy = false, serverRunning }: {
  t: (key: UnifiedKey, vars?: TranslationVars) => string; state: DeepVerificationState; provider?: ProviderId; runtimeBusy?: boolean; serverRunning: boolean;
}) {
  const { locale } = useI18n(); const text = copy[locale];
  const record = state.record;
  const unsupported = record?.verdict === 'unsupported';
  return <div className="runtime-deep-verify">
    <p className="app-section-hint">{provider === 'llama.cpp' ? t('ui.deepVerifyHint') : text.hint}</p>
    <div className="runtime-deep-verify-actions">
      {state.busy ? <LocalTaskCancelButton taskId={DEEP_VERIFICATION_TASK} onClick={state.cancel} className="app-button app-button--danger app-button--sm">{t('common.cancel')}</LocalTaskCancelButton>
        : <button type="button" data-icon="probe" onClick={state.start} disabled={runtimeBusy || serverRunning} title={serverRunning ? t('ui.stopBeforeSelect') : undefined} className="app-button app-button--secondary app-button--sm">{t('ui.deepVerify')}</button>}
      {record && <StatusBadge label={unsupported ? record.coverage === 'partial' ? text.partial : text.unavailable : t(record.verdict === 'pass' ? 'ui.deepVerifyPass' : 'ui.deepVerifyFail')}
        tone={unsupported ? 'warning' : record.verdict === 'pass' ? 'success' : 'danger'} />}
    </div>
    {record && <p className="app-section-hint">{normalizeDisplayText(record.detail)}</p>}
    {record?.method && <p className="app-section-hint">{record.method}{record.median_kld !== undefined ? ` · KL ${record.median_kld}` : ''}
      {record.median_kld_lower_bound !== undefined ? ` · KL ≥ ${record.median_kld_lower_bound}` : ''}{record.top_k !== undefined ? ` · top ${record.top_k}` : ''}</p>}
    {state.error && <FeedbackBanner tone="error">{normalizeDisplayText(state.error)}</FeedbackBanner>}
  </div>;
}
