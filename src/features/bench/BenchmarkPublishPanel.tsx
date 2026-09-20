import { useEffect, useRef, useState } from 'react';
import type { PublicBenchmarkSubmission } from '@aiolm/benchmark-contracts';
import { parseStoredPublicationBody } from '../../shared/contracts/benchmark/publication.ts';
import { getTaskSnapshot, subscribeTasks } from '../../shared/state/taskRegistry.ts';
import {
  benchmarkSharingConfiguration,
  benchmarkSharingOpenManagement,
  benchmarkSharingRecoveryCopy,
  benchmarkSharingRecoveryExport,
  benchmarkSharingRecoveryImport,
  normalizeSharingOrigin,
} from '../../shared/api/benchmarkSharing.ts';
import { isNativeRuntimeAvailable } from '../../shared/api/transport.ts';
import { createNativeSelectedTransport } from '../../shared/sharing/nativeTransport.ts';
import { createPublicationController, type PublicationOutbox } from '../../shared/sharing/publicationController.ts';
import { dispatchSelectedBenchmark, enqueuePublicationBenchmark, getQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox.ts';

type Copy = ReturnType<typeof import('./benchmarkCopy.ts').benchmarkCopy>;

const measurement = {
  isActive: () => getTaskSnapshot().some((task) => task.kind === 'benchmark' && (task.state === 'running' || task.state === 'cancelling')),
  subscribe: subscribeTasks,
};

/**
 * Single review-to-publish flow for one stable snapshot. The snapshot and
 * description come from the review card, so one submission ID always maps to
 * one exact body. Retry and restart reuse the frozen queued body.
 */
export function BenchmarkPublishPanel({ snapshot, description, sourceRunId, busy, copy, onQueued, onBound, onWorkingChange, outbox }: {
  snapshot: PublicBenchmarkSubmission; description: string; sourceRunId: string;
  busy: boolean; copy: Copy; onQueued?: () => void; onBound?: (description: string) => void;
  onWorkingChange?: (working: boolean) => void;
  outbox?: PublicationOutbox;
}) {
  const submissionId = snapshot.submission_id;
  const [phase, setPhase] = useState<'idle' | 'working'>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [serviceUrl, setServiceUrl] = useState<string | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const controllerRef = useRef<ReturnType<typeof createPublicationController> | null>(null);
  const outboxRef = useRef<PublicationOutbox | null>(null);
  if (!outboxRef.current) {
    outboxRef.current = outbox ?? { enqueuePublication: enqueuePublicationBenchmark, dispatchSelected: dispatchSelectedBenchmark, get: getQueuedBenchmark };
  }
  if (!controllerRef.current) {
    controllerRef.current = createPublicationController({ measurement, outbox: outboxRef.current });
  }
  const onBoundRef = useRef(onBound);
  onBoundRef.current = onBound;
  const onWorkingChangeRef = useRef(onWorkingChange);
  onWorkingChangeRef.current = onWorkingChange;

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

  // Adopt an already-frozen body on mount and restart.
  useEffect(() => {
    let active = true;
    if (!isNativeRuntimeAvailable()) return;
    void outboxRef.current!.get(submissionId)
      .then((entry) => { if (active && entry?.requestBody) onBoundRef.current?.(entry.descriptionMd ?? description); })
      .catch(() => undefined);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

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

  const actionable = (code: string | null) => {
    if (code === 'verification_required') return copy.publishBlocked;
    if (code === 'ownership_missing') return copy.recoveryHint;
    if (code === 'submission_deleted') return copy.publishDeleted;
    return copy.publishError;
  };

  const publish = async () => {
    const controller = controllerRef.current!;
    if (busy || phase !== 'idle' || !isNativeRuntimeAvailable() || !serviceReady) return;
    const aborter = new AbortController();
    abortRef.current = aborter;
    runningRef.current = true;
    setPhase('working');
    setError(null);
    setErrorCode(null);
    setReceiptId(null);
    try {
      const existing = await outboxRef.current!.get(submissionId);
      // A previously attempted legacy bare entry keeps its exact body for the
      // legacy path; surface the conflict before any native binding mutation.
      if (existing && !existing.requestBody && (existing.attempts > 0 || existing.state === 'sending' || existing.state === 'sent')) {
        throw new Error(copy.legacyConflict);
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
        onQueued?.();
        onBoundRef.current?.(existing.descriptionMd ?? description);
      } else {
        setStatus(copy.publishPreparing);
        if (aborter.signal.aborted) return;
        const prepared = await controller.prepare({ benchmark: snapshot, description_md: description }, { runId: sourceRunId }, aborter.signal);
        destination = prepared.destination;
        onQueued?.();
        onBoundRef.current?.(description);
      }
      if (!destination) throw new Error(copy.publishNeedsService);
      if (aborter.signal.aborted) return;
      setStatus(copy.publishSubmitting);
      const sent = await controller.publishSelected(submissionId, createNativeSelectedTransport(destination), aborter.signal);
      if (sent === 1) {
        const done = await outboxRef.current!.get(submissionId);
        setReceiptId(done?.receipt?.id ?? null);
        setStatus(null);
        onQueued?.();
      } else {
        const current = await outboxRef.current!.get(submissionId);
        const code = current?.error?.code ?? null;
        setErrorCode(code);
        setError(actionable(code));
      }
    } catch (caught) {
      await freezeFromStorage();
      if (!aborter.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setErrorCode(null);
      } else {
        setStatus(null);
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setPhase('idle');
    }
  };

  const cancel = async () => {
    abortRef.current?.abort();
    await controllerRef.current!.cancel(submissionId).catch(() => undefined);
    setStatus(null);
  };

  const recoveryExport = async () => {
    if (busy) return;
    setRecoveryStatus(null);
    setError(null);
    try {
      const saved = await benchmarkSharingRecoveryExport(submissionId);
      setRecoveryStatus(saved ? copy.recoverySaved : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const recoveryImport = async () => {
    if (busy) return;
    setRecoveryStatus(null);
    setError(null);
    try {
      const result = await benchmarkSharingRecoveryImport();
      setRecoveryStatus(result ? copy.recoveryImported : null);
      if (result) onQueued?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const recoveryCopy = async () => {
    if (busy) return;
    try {
      const ok = await benchmarkSharingRecoveryCopy(submissionId);
      setRecoveryStatus(ok ? copy.recoveryCopied : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openManagement = async () => {
    if (busy) return;
    try {
      await benchmarkSharingOpenManagement(submissionId);
      setRecoveryStatus(null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const serviceReady = serviceUrl !== null && serviceUrl !== undefined && isNativeRuntimeAvailable();
  const unavailable = !serviceReady;
  const nativeMissing = !isNativeRuntimeAvailable();
  const working = phase !== 'idle' || busy;

  return (
    <section className="performance-card performance-public" aria-label={copy.publishTitle}>
      <h3>{copy.publishTitle}</h3>
      <p>{copy.publishHint}</p>
      {unavailable && <p role="status">{copy.publishNeedsService}</p>}
      <div className="performance-actions">
        <button type="button" className="app-button app-button--primary app-button--sm" disabled={working || unavailable} onClick={() => void publish()}>{phase === 'working' ? (status ?? copy.publishSubmitting) : copy.publishSelected}</button>
        {phase !== 'idle' && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => void cancel()}>{copy.cancelPublish}</button>}
        {phase === 'idle' && errorCode === 'verification_required' && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={working || unavailable} onClick={() => void publish()}>{copy.reverify}</button>}
      </div>
      {status && phase === 'working' && <p role="status">{status}</p>}
      {receiptId && <p role="status">{copy.publishAccepted} <code>{receiptId}</code></p>}
      {error && <p role="alert">{error}</p>}
      <div className="performance-recovery">
        <h4>{copy.recoveryTitle}</h4>
        <p>{copy.recoveryHint}</p>
        <div className="performance-actions">
          <button type="button" className="app-button app-button--secondary app-button--sm" disabled={working || nativeMissing} onClick={() => void recoveryExport()}>{copy.recoveryExport}</button>
          <button type="button" className="app-button app-button--secondary app-button--sm" disabled={working || nativeMissing} onClick={() => void recoveryImport()}>{copy.recoveryImport}</button>
          <button type="button" className="app-button app-button--secondary app-button--sm" disabled={working || nativeMissing} onClick={() => void recoveryCopy()}>{copy.recoveryCopy}</button>
          <button type="button" className="app-button app-button--secondary app-button--sm" disabled={working || unavailable} onClick={() => void openManagement()}>{copy.openManagement}</button>
        </div>
        {recoveryStatus && <p role="status">{recoveryStatus}</p>}
      </div>
    </section>
  );
}
