import { useEffect, useRef, useState } from 'react';
import { toPublicBenchmark, type PublicBenchmarkSubmission } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import { parseStoredPublicationBody } from '../../shared/contracts/benchmark/publication.ts';
import { getQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox.ts';
import FeedbackBanner from '../../shared/ui/FeedbackBanner.tsx';
import type { PerformanceBenchmarkRecord } from './performanceRecords.ts';
import type { benchmarkCopy } from './benchmarkCopy.ts';
import { DescriptionEditor } from './DescriptionEditor.tsx';
import { BenchmarkPublishPanel } from './BenchmarkPublishPanel.tsx';
import { PublicBenchmarkSummary } from './PublicBenchmarkSummary.tsx';

type Copy = ReturnType<typeof benchmarkCopy>;

type Hydration = 'idle' | 'pending' | 'ready' | 'failed';

export function PublicBenchmarkReview({ record, busy, copy, onPublished, onWorkingChange }: { record: PerformanceBenchmarkRecord; busy: boolean; copy: Copy; onPublished?: () => void; onWorkingChange?: (working: boolean) => void }) {
  const [open, setOpen] = useState(true);
  const [snapshot, setSnapshot] = useState<PublicBenchmarkSubmission | null>(null);
  const [description, setDescription] = useState('');
  const [boundDescription, setBoundDescription] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [hydration, setHydration] = useState<Hydration>('idle');
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  // Submission IDs with a finished hydration; set only on completion so
  // StrictMode setup-cleanup-setup refetches instead of stalling.
  const hydratedFor = useRef<string | null>(null);
  // A fallback ID for records without a native UUID keeps the snapshot stable
  // across close/reopen instead of minting a new submission per toggle.
  const fallbackId = useRef<string | null>(null);
  // One submission ID maps to one exact body: the editor shows the frozen
  // description once bound, and the panel publishes this same snapshot.
  // The editor also freezes while publication preparation runs so async
  // binding cannot race visible edits.
  const effectiveDescription = boundDescription ?? description;
  const editorLocked = busy || publishing || hydration !== 'ready' || boundDescription !== null;

  useEffect(() => {
    onWorkingChange?.(publishing);
    return () => { onWorkingChange?.(false); };
  }, [publishing, onWorkingChange]);

  // A different record needs a fresh review; never show one record's frozen
  // snapshot as another record's publishable body.
  useEffect(() => {
    hydratedFor.current = null;
    fallbackId.current = null;
    setSnapshot(null);
    setDescription('');
    setBoundDescription(null);
    setError(null);
    setHydration('idle');
    setHydrationError(null);
  }, [record.id]);

  // Opening prepares the snapshot automatically; closing keeps it so a
  // reopen shows the same submission instead of minting a new one.
  useEffect(() => {
    if (!open || snapshot || hydration !== 'idle') return;
    try {
      const nativeId = /^performance-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(record.id)?.[1];
      if (!nativeId && !fallbackId.current) fallbackId.current = crypto.randomUUID();
      setSnapshot(toPublicBenchmark(record, nativeId ?? fallbackId.current!));
      setError(null);
    } catch { setError(copy.publicInvalid); }
  }, [open, snapshot, hydration, record, copy.publicInvalid]);

  // Hydrate the exact frozen wrapper before anything becomes publishable, so a
  // reload restores the benchmark bytes actually queued instead of displaying
  // a newly derived draft as the frozen snapshot.
  const submissionId = snapshot?.submission_id;
  useEffect(() => {
    if (!snapshot || !submissionId || hydratedFor.current === submissionId) return;
    setHydration('pending');
    setHydrationError(null);
    let active = true;
    void getQueuedBenchmark(submissionId)
      .then((entry) => {
        if (!active) return;
        hydratedFor.current = submissionId;
        if (!entry?.requestBody) { setHydration('ready'); return; }
        try {
          const frozen = parseStoredPublicationBody(entry.requestBody);
          setSnapshot(frozen.benchmark);
          setBoundDescription(frozen.description_md);
          setHydration('ready');
        } catch {
          // Never combine a new benchmark with an old description: surface the
          // corrupt snapshot and block publication of a different body.
          setHydrationError(copy.hydrateError);
          setHydration('failed');
        }
      })
      .catch(() => {
        if (!active) return;
        hydratedFor.current = submissionId;
        setHydrationError(copy.hydrateError);
        setHydration('failed');
      });
    return () => { active = false; };
  }, [snapshot, submissionId, copy.hydrateError]);
  const actionsReady = hydration === 'ready';
  return (
    <details className="app-card app-card--flush performance-card performance-details performance-share" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{copy.publicReview}</summary>
      <p>{copy.publicHint}</p>
      {open && !snapshot && !error && <p role="status">{copy.hydrateLoading}</p>}
      {open && error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
      {open && snapshot && hydration === 'pending' && <p role="status">{copy.hydrateLoading}</p>}
      {open && snapshot && hydration === 'failed' && hydrationError && <FeedbackBanner tone="error">{hydrationError}</FeedbackBanner>}
      {open && snapshot && actionsReady && <>
        <PublicBenchmarkSummary snapshot={snapshot} copy={copy} />
        <DescriptionEditor
          value={effectiveDescription}
          onChange={setDescription}
          disabled={editorLocked}
          label={copy.descriptionLabel}
          hint={copy.descriptionHint}
          rows={3}
          countLabel={(used, max) => `${copy.descriptionCount}: ${used} / ${max}`}
        />
        {boundDescription !== null && <p>{copy.descriptionLockedHint}</p>}
        <BenchmarkPublishPanel
          snapshot={snapshot}
          description={effectiveDescription}
          sourceRunId={record.id}
          busy={busy}
          copy={copy}
          onPublished={onPublished}
          onBound={(value) => setBoundDescription(value)}
          onWorkingChange={setPublishing}
        />
      </>}
    </details>
  );
}
