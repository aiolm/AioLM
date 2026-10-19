import { useCallback, useSyncExternalStore } from 'react';
import * as api from '../../shared/api/index';
import type { VerificationRecord } from '../../shared/api/types';
import type { AppStore } from '../../shared/state/store';
import { translate } from '../../shared/i18n/i18nUnified';
import type { Locale } from '../../shared/i18n/i18nCatalog';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { runtimeInventoryRevision, useRuntimeInventoryRevision } from '../../shared/runtime/runtimeInventoryEvents';

export const DEEP_VERIFICATION_TASK = 'deep-verification';
const CANCELLATION_MESSAGES = new Set([
  'deep verification cancelled',
  'cancelled',
]);

interface DeepVerificationOperation {
  identity: string;
  cancelRequested: boolean;
}

interface DeepVerificationResult {
  identity: string;
  record?: VerificationRecord;
  error?: string;
}

interface DeepVerificationState {
  busy: boolean;
  result: DeepVerificationResult | null;
}

let activeOperation: DeepVerificationOperation | null = null;
let latestResult: DeepVerificationResult | null = null;
let stateSnapshot: DeepVerificationState = { busy: false, result: null };
const listeners = new Set<() => void>();

function getActiveOperation(): DeepVerificationOperation | null {
  // Only settlement of the native request releases ownership. Its task row is
  // a UI projection and can disappear independently of the running request.
  return activeOperation;
}

function publishState() {
  const busy = getActiveOperation() !== null;
  if (stateSnapshot.busy === busy && stateSnapshot.result === latestResult) return;
  stateSnapshot = { busy, result: latestResult };
  for (const listener of listeners) listener();
}

function setSharedResult(next: DeepVerificationResult | null) {
  latestResult = next;
  publishState();
}

function subscribeDeepVerification(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getDeepVerificationSnapshot(): DeepVerificationState {
  return stateSnapshot;
}

/**
 * The opt-in deep check, run against the real model instead of the canary.
 *
 * It runs two perplexity passes over the selected model and can take the better
 * part of an hour, so it belongs in the task strip rather than behind a button
 * that appears to hang: the strip is where its progress is read and where it is
 * cancelled from, and the panel it was started from can be left meanwhile.
 */
export function useDeepVerification(store: AppStore, locale: Locale) {
  const state = useSyncExternalStore(
    subscribeDeepVerification,
    getDeepVerificationSnapshot,
    getDeepVerificationSnapshot,
  );
  const revision = useRuntimeInventoryRevision();
  const identity = JSON.stringify([store.getConfig?.() ?? store.cfg, revision]);

  const cancelOperation = useCallback(async (currentOperation = getActiveOperation()) => {
    if (!currentOperation || getActiveOperation() !== currentOperation || currentOperation.cancelRequested) return;
    currentOperation.cancelRequested = true;
    if (latestResult?.error) setSharedResult(null);
    updateTask(DEEP_VERIFICATION_TASK, { state: 'cancelling', detail: translate(locale, 'ui.deepVerifyRunning') });
    try {
      await api.verifyCancel();
    } catch (cause) {
      if (getActiveOperation() !== currentOperation) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      currentOperation.cancelRequested = false;
      updateTask(DEEP_VERIFICATION_TASK, { state: 'running', detail: message });
      setSharedResult({ identity: currentOperation.identity, error: message });
    }
  }, [locale]);

  const cancel = useCallback(() => {
    void cancelOperation();
  }, [cancelOperation]);

  const start = useCallback(() => {
    const cfg = store.getConfig?.() ?? store.cfg;
    if (!cfg || getActiveOperation()) return;
    // The result belongs to this exact configuration and inventory. A late
    // completion still finishes its task, but never labels another selection.
    const verifiedIdentity = JSON.stringify([cfg, runtimeInventoryRevision()]);
    const currentOperation: DeepVerificationOperation = { identity: verifiedIdentity, cancelRequested: false };
    activeOperation = currentOperation;
    latestResult = null;
    registerTask({
      id: DEEP_VERIFICATION_TASK,
      kind: 'runtime',
      label: translate(locale, 'ui.deepVerify'),
      detail: translate(locale, 'ui.deepVerifyRunning'),
      // It holds the GPUs for its whole run; leaving the panel must not end it.
      interruptible: true,
      cancel: () => cancelOperation(currentOperation),
    });
    publishState();
    void api.verifyModelDeeply(cfg)
      .then(result => {
        if (activeOperation !== currentOperation) return;
        latestResult = { identity: verifiedIdentity, record: result };
        finishTask(DEEP_VERIFICATION_TASK, result.verdict === 'pass' ? 'completed' : 'failed', result.detail);
      })
      .catch(cause => {
        if (activeOperation !== currentOperation) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        const cancelled = CANCELLATION_MESSAGES.has(message);
        latestResult = cancelled ? null : { identity: verifiedIdentity, error: message };
        finishTask(DEEP_VERIFICATION_TASK, cancelled ? 'cancelled' : 'failed', message);
      })
      .finally(() => {
        if (activeOperation === currentOperation) {
          activeOperation = null;
          publishState();
        }
      });
  }, [cancelOperation, locale, store]);

  const current = state.result?.identity === identity ? state.result : null;
  return {
    busy: state.busy,
    record: current?.record ?? null,
    error: current?.error ?? null,
    start,
    cancel,
    dismiss: () => setSharedResult(null),
  };
}
