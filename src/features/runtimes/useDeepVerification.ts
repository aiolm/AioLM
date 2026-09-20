import { useCallback, useState } from 'react';
import * as api from '../../shared/api/index';
import type { VerificationRecord } from '../../shared/api/types';
import type { AppStore } from '../../shared/state/store';
import { translate } from '../../shared/i18n/i18nUnified';
import type { Locale } from '../../shared/i18n/i18nCatalog';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';

export const DEEP_VERIFICATION_TASK = 'deep-verification';

/**
 * The opt-in deep check, run against the real model instead of the canary.
 *
 * It runs two perplexity passes over the selected model and can take the better
 * part of an hour, so it belongs in the task strip rather than behind a button
 * that appears to hang: the strip is where its progress is read and where it is
 * cancelled from, and the panel it was started from can be left meanwhile.
 */
export function useDeepVerification(store: AppStore, locale: Locale) {
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<VerificationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    updateTask(DEEP_VERIFICATION_TASK, { state: 'cancelling' });
    void api.verifyCancel().catch(() => undefined);
  }, []);

  const start = useCallback(() => {
    const cfg = store.getConfig?.() ?? store.cfg;
    if (!cfg || busy) return;
    setBusy(true);
    setRecord(null);
    setError(null);
    registerTask({
      id: DEEP_VERIFICATION_TASK,
      kind: 'runtime',
      label: translate(locale, 'ui.deepVerify'),
      detail: translate(locale, 'ui.deepVerifyRunning'),
      // It holds the GPUs for its whole run; leaving the panel must not end it.
      interruptible: true,
    });
    void api.verifyModelDeeply(cfg)
      .then(result => {
        setRecord(result);
        finishTask(DEEP_VERIFICATION_TASK, result.verdict === 'pass' ? 'completed' : 'failed', result.detail);
      })
      .catch(cause => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        finishTask(DEEP_VERIFICATION_TASK, /cancel/i.test(message) ? 'cancelled' : 'failed', message);
      })
      .finally(() => setBusy(false));
  }, [busy, locale, store]);

  return { busy, record, error, start, cancel, dismiss: () => { setRecord(null); setError(null); } };
}
