import { useEffect, useRef, useState } from 'react';
import type { PublicBenchmarkSubmission } from '@aiolm/benchmark-contracts';
import { parseStoredPublicationBody } from '../../shared/contracts/benchmark/publication.ts';
import { getTaskSnapshot, subscribeTasks } from '../../shared/state/taskRegistry.ts';
import {
  benchmarkSharingConfiguration,
  benchmarkSharingOpenManagement,
  BenchmarkSharingError,
  normalizeSharingOrigin,
} from '../../shared/api/benchmarkSharing.ts';
import { isNativeRuntimeAvailable } from '../../shared/api/transport.ts';
import FeedbackBanner from '../../shared/ui/FeedbackBanner.tsx';
import { benchmarkManagementError } from './benchmarkManagementError';
import { createNativeSelectedTransport } from '../../shared/sharing/nativeTransport.ts';
import { createPublicationController, type PublicationOutbox } from '../../shared/sharing/publicationController.ts';
import { dispatchSelectedBenchmark, enqueuePublicationBenchmark, getQueuedBenchmark, retryQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox.ts';

type Copy = ReturnType<typeof import('./benchmarkCopy.ts').benchmarkCopy>;
type PublishOutbox = PublicationOutbox & { retry: (id: string) => Promise<void> };

function publicationError(code: string | null, copy: Copy): string {
  if (code === 'verification_required') return copy.publishBlocked;
  if (code === 'ownership_missing') return copy.publishOwnershipMissing;
  if (code === 'submission_deleted') return copy.publishDeleted;
  return copy.publishError;
}

const measurement = {
  isActive: () => getTaskSnapshot().some((task) => task.kind === 'benchmark' && (task.state === 'running' || task.state === 'cancelling')),
  subscribe: subscribeTasks,
};

/**
 * Single review-to-publish flow for one stable snapshot. The snapshot and
 * description come from the review card, so one submission ID always maps to
 * one exact body. Retry and restart reuse the frozen queued body.
 */
export function BenchmarkPublishPanel({ snapshot, description, sourceRunId, busy, copy, onPublished, onBound, onWorkingChange, outbox }: {
  snapshot: PublicBenchmarkSubmission; description: string; sourceRunId: string;
  busy: boolean; copy: Copy; onPublished?: () => void; onBound?: (description: string) => void;
  onWorkingChange?: (working: boolean) => void;
  outbox?: PublishOutbox;
}) {
  const submissionId = snapshot.submission_id;
  const [phase, setPhase] = useState<'idle' | 'working'>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [boundDestination, setBoundDestination] = useState<string | null>(null);
  const [serviceUrl, setServiceUrl] = useState<string | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const controllerRef = useRef<ReturnType<typeof createPublicationController> | null>(null);
  const outboxRef = useRef<PublishOutbox | null>(null);
  if (!outboxRef.current) {
    outboxRef.current = outbox ?? { enqueuePublication: enqueuePublicationBenchmark, dispatchSelected: dispatchSelectedBenchmark, get: getQueuedBenchmark, retry: retryQueuedBenchmark };
  }
  if (!controllerRef.current) {
    controllerRef.current = createPublicationController({ measurement, outbox: outboxRef.current });
  }
  const onBoundRef = useRef(onBound);
  onBoundRef.current = onBound;
  const onWorkingChangeRef = useRef(onWorkingChange);
  onWorkingChangeRef.current = onWorkingChange;
  const copyRef = useRef(copy);
  copyRef.current = copy;

  // Freeze the review editor while publication preparation runs so async
  // binding cannot race visible edits.
  useEffect(() => {
    onWorkingChangeRef.current?.(phase === 'working');
    if (phase !== 'working') return undefined;
    return () => { onWorkingChangeRef.current?.(false); };
  }, [phase]);

  // Configured-service availability gates publishing; fail closed when absent.
  useEffect(() => {
    let active = true;
    if (!isNativeRuntimeAvailable()) { setServiceUrl(null); return; }
    benchmarkSharingConfiguration().then(
      (config) => {
        if (!active) return;
        try {
          setServiceUrl(config.base_url === null ? null : normalizeSharingOrigin(config.base_url));
        } catch {
          setServiceUrl(null);
        }
      },
      () => { if (active) setServiceUrl(null); },
    );
    return () => { active = false; };
  }, []);

  // Restore completion too: an accepted result must never look like a fresh
  // submission when the review is reopened or the application restarts.
  useEffect(() => {
    let active = true;
    setRestoring(true);
    setRestoreFailed(false);
    setPublished(false);
    setError(null);
    setErrorCode(null);
    setBoundDestination(null);
    if (!isNativeRuntimeAvailable()) { setRestoring(false); return; }
    void outboxRef.current!.get(submissionId)
      .then((entry) => {
        if (!active) return;
        if (entry?.requestBody) onBoundRef.current?.(parseStoredPublicationBody(entry.requestBody).description_md);
        setPublished(entry?.state === 'sent' && !!entry.receipt);
        setBoundDestination(entry?.destination ?? null);
        if (entry?.error && entry.state !== 'sent') {
          const code = entry.error.status === 410 ? 'submission_deleted' : entry.error.code;
          setErrorCode(code);
          setError(publicationError(code, copyRef.current));
        }
      })
      .catch(() => { if (active) setRestoreFailed(true); })
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, [submissionId, restoreRevision]);

  // Unmount cancels pending workflow work.
  useEffect(() => {
    const controller = controllerRef.current!;
    const id = submissionId;
    return () => {
      abortRef.current?.abort();
      if (runningRef.current) void controller.cancel(id).catch(() => undefined);
    };
  }, [submissionId]);

  // Freeze the review to whatever wrapper is durably queued, even when native
  // binding fails or is cancelled: with persist-before-bind the original
  // request survives and retry must reuse it, never a re-edited draft.
  const freezeFromStorage = async () => {
    try {
      const stored = await outboxRef.current!.get(submissionId);
      if (!stored?.requestBody) return;
      try {
        onBoundRef.current?.(parseStoredPublicationBody(stored.requestBody).description_md);
      } catch {
        onBoundRef.current?.(stored.descriptionMd ?? description);
      }
    } catch {
      // A storage read failure here must not hide the publish error below.
    }
  };

  const publish = async () => {
    const controller = controllerRef.current!;
    if (busy || runningRef.current || published || restoring || restoreFailed || !serviceReady) return;
    const aborter = new AbortController();
    abortRef.current = aborter;
    runningRef.current = true;
    setPhase('working');
    setError(null);
    setErrorCode(null);
    try {
      const existing = await outboxRef.current!.get(submissionId);
      if (aborter.signal.aborted) return;
      if (existing?.state === 'sent' && existing.receipt) {
        setPublished(true);
        onPublished?.();
        return;
      }
      if (existing?.error?.code === 'submission_deleted' || existing?.error?.status === 410) {
        setErrorCode('submission_deleted');
        setError(copy.publishDeleted);
        return;
      }
      // A previously attempted legacy bare entry keeps its exact body for the
      // legacy path; surface the conflict before any native binding mutation.
      if (existing && !existing.requestBody && (existing.attempts > 0 || existing.state === 'sending' || existing.state === 'sent')) {
        setError(copy.legacyConflict);
        return;
      }
      // Reuse the frozen queued body on retry and restart; bind exactly once.
      let destination = existing?.destination
        ?? (existing?.origin ? `${existing.origin.replace(/\/+$/, '')}/v1/benchmark-runs` : undefined);
      if (existing?.requestBody && existing.credentialRef) {
        onBoundRef.current?.(existing.descriptionMd ?? description);
      } else if (existing?.requestBody) {
        // Offline wrapper: bind the exact frozen bytes before the first network request.
        setStatus(copy.publishPreparing);
        if (aborter.signal.aborted) return;
        const prepared = await controller.prepare(parseStoredPublicationBody(existing.requestBody), { runId: sourceRunId }, aborter.signal);
        destination = prepared.destination;
        onBoundRef.current?.(existing.descriptionMd ?? description);
      } else {
        setStatus(copy.publishPreparing);
        if (aborter.signal.aborted) return;
        const prepared = await controller.prepare({ benchmark: snapshot, description_md: description }, { runId: sourceRunId }, aborter.signal);
        destination = prepared.destination;
        onBoundRef.current?.(description);
      }
      if (!destination) throw new Error(copy.publishNeedsService);
      setBoundDestination(destination);
      if (aborter.signal.aborted) return;
      // Only an explicit click clears a rejected attempt. The outbox still
      // enforces origin cooldowns and never retries a deleted result.
      if (existing?.state === 'rejected') await outboxRef.current!.retry(submissionId);
      if (aborter.signal.aborted) return;
      setStatus(copy.publishSubmitting);
      const sent = await controller.publishSelected(submissionId, createNativeSelectedTransport(destination), aborter.signal,
        (next) => setStatus(next === 'verifying' ? copy.publishVerifying : copy.publishSubmitting));
      if (aborter.signal.aborted) return;
      if (sent === 1) {
        setPublished(true);
        onPublished?.();
        return;
      }
      const current = await outboxRef.current!.get(submissionId);
      if (current?.state === 'sent' && current.receipt) {
        setPublished(true);
        onPublished?.();
      } else {
        const code = current?.error?.code ?? null;
        setErrorCode(code);
        setError(publicationError(code, copy));
      }
    } catch (caught) {
      await freezeFromStorage();
      if (!aborter.signal.aborted) {
        const code = caught instanceof BenchmarkSharingError
          ? caught.serviceCode ?? (caught.kind === 'credential-missing' ? 'ownership_missing' : null)
          : null;
        setError(publicationError(code, copy));
        setErrorCode(code);
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setPhase('idle');
      setStatus(null);
    }
  };

  const cancel = async () => {
    abortRef.current?.abort();
    await controllerRef.current!.cancel(submissionId).catch(() => undefined);
    setStatus(null);
  };

  const openManagement = async () => {
    if (busy || runningRef.current) return;
    runningRef.current = true;
    setPhase('working');
    setError(null);
    try {
      await benchmarkSharingOpenManagement(submissionId);
    } catch (error) {
      setError(benchmarkManagementError(error, copy));
    } finally {
      runningRef.current = false;
      setPhase('idle');
    }
  };

  const serviceReady = serviceUrl !== null && serviceUrl !== undefined && isNativeRuntimeAvailable();
  const unavailable = !serviceReady;
  const working = phase !== 'idle' || busy || restoring;
  const destination = boundDestination ?? serviceUrl;
  const serviceHost = (() => { try { return destination ? new URL(destination).host : null; } catch { return null; } })();

  return (
    <div className="performance-publish">
      {restoring && <p role="status">{copy.publishRestoring}</p>}
      {restoreFailed && <FeedbackBanner tone="error" action={{ label: copy.publishRetry, disabled: busy, onClick: () => setRestoreRevision(value => value + 1) }}>{copy.publishRestoreError}</FeedbackBanner>}
      {published ? <>
        <FeedbackBanner tone="success">{copy.publishAccepted}</FeedbackBanner>
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={working} data-icon="open" onClick={() => void openManagement()}>{phase === 'working' ? copy.managementOpening : copy.openManagement}</button>
      </> : <>
        {serviceUrl === null && <FeedbackBanner tone="info">{copy.publishNeedsService}</FeedbackBanner>}
        {serviceHost && <p className="performance-hint">{copy.publishServiceLabel}: {serviceHost}</p>}
        <div className="performance-actions">
          <button type="button" className="app-button app-button--primary app-button--sm" disabled={working || unavailable || restoreFailed || errorCode === 'submission_deleted'} onClick={() => void publish()}>{phase === 'working' ? (status ?? copy.publishSubmitting) : error ? copy.publishRetry : copy.publishSelected}</button>
          {phase !== 'idle' && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => void cancel()}>{copy.cancelPublish}</button>}
        </div>
        {status && phase === 'working' && <p role="status">{status}</p>}
      </>}
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    </div>
  );
}
