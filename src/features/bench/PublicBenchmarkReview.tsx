import { useEffect, useRef, useState } from 'react';
import { toPublicBenchmark, type PublicBenchmarkSubmission } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import { parseStoredPublicationBody } from '../../shared/contracts/benchmark/publication.ts';
import { enqueuePublicationBenchmark, getQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox.ts';
import { isNativeRuntimeAvailable } from '../../shared/api/transport.ts';
import type { PerformanceBenchmarkRecord } from './performanceRecords.ts';
import type { benchmarkCopy } from './benchmarkCopy.ts';
import { DescriptionEditor } from './DescriptionEditor.tsx';
import { BenchmarkPublishPanel } from './BenchmarkPublishPanel.tsx';

type Copy = ReturnType<typeof benchmarkCopy>;

type Hydration = 'idle' | 'pending' | 'ready' | 'failed';

export function PublicBenchmarkReview({ record, busy, copy, onQueued }: { record: PerformanceBenchmarkRecord; busy: boolean; copy: Copy; onQueued?: () => void }) {
  const [snapshot, setSnapshot] = useState<PublicBenchmarkSubmission | null>(null);
  const [description, setDescription] = useState('');
  const [boundDescription, setBoundDescription] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [hydration, setHydration] = useState<Hydration>('idle');
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  // Submission IDs with a finished hydration; set only on completion so
  // StrictMode setup-cleanup-setup refetches instead of stalling.
  const hydratedFor = useRef<string | null>(null);
  // One submission ID maps to one exact body: the editor shows the frozen
  // description once bound, and the panel publishes this same snapshot.
  // The editor also freezes while publication preparation runs so async
  // binding cannot race visible edits.
  const effectiveDescription = boundDescription ?? description;
  const editorLocked = busy || saving || publishing || hydration !== 'ready' || boundDescription !== null;
  const prepare = () => {
    try {
      const nativeId = /^performance-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(record.id)?.[1];
      setSnapshot(toPublicBenchmark(record, nativeId ?? crypto.randomUUID()));
      setError(null);
    } catch { setError(copy.publicInvalid); }
  };

  // A different record needs a fresh review; never show one record's frozen
  // snapshot as another record's publishable body.
  useEffect(() => {
    hydratedFor.current = null;
    setSnapshot(null);
    setDescription('');
    setBoundDescription(null);
    setError(null);
    setQueued(false);
    setSaving(false);
    setHydration('idle');
    setHydrationError(null);
  }, [record.id]);

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
          // corrupt snapshot and block export/publication of a different body.
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
  const download = () => {
    if (!snapshot || hydration !== 'ready') return;
    const wrapper = { benchmark: snapshot, description_md: effectiveDescription };
    const url = URL.createObjectURL(new Blob([JSON.stringify(wrapper, null, 2)], { type: 'application/json' }));
    try {
      const link = document.createElement('a');
      link.href = url; link.download = `aiolm-public-benchmark-${snapshot.submission_id}.json`; link.click();
    } finally { URL.revokeObjectURL(url); }
  };
  const enqueue = async () => {
    if (!snapshot || hydration !== 'ready' || saving || busy || publishing) return;
    setSaving(true); setError(null);
    try {
      // Offline wrapper keeps the effective (possibly restored) description
      // with the snapshot; no service needed. No legacy fallback: a binding
      // conflict or validation failure must surface instead of silently
      // dropping the description.
      await enqueuePublicationBenchmark(
        { benchmark: snapshot, description_md: effectiveDescription },
        isNativeRuntimeAvailable() ? { source: { runId: record.id } } : undefined,
      );
      // Freeze the review to the persisted wrapper so later edits cannot drift
      // from the durable bytes.
      setBoundDescription(effectiveDescription);
      setQueued(true); onQueued?.();
    }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.queueError);
    }
    finally { setSaving(false); }
  };
  const actionsReady = hydration === 'ready';
  return <section className="performance-card performance-public" aria-label={copy.publicReview}>
    <h3>{copy.publicReview}</h3><p>{copy.publicHint}</p>
    {!snapshot && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} onClick={prepare}>{copy.preparePublic}</button>}
    {snapshot && hydration === 'pending' && <p role="status">{copy.hydrateLoading}</p>}
    {snapshot && hydration === 'failed' && <p role="alert">{hydrationError}</p>}
    {snapshot && actionsReady && <>
      <p>{copy.publicUnknown}</p>
      <pre className="performance-public-json" tabIndex={0} aria-label={copy.publicPreview}>{JSON.stringify(snapshot, null, 2)}</pre>
      <div className="performance-actions">
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} onClick={download}>{copy.exportPublic}</button>
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || saving || queued} onClick={() => void enqueue()}>{queued ? copy.queued : copy.queuePublic}</button>
      </div>
      <p role={queued ? 'status' : undefined}>{copy.queueHint}</p>
      <DescriptionEditor
        value={effectiveDescription}
        onChange={setDescription}
        disabled={editorLocked}
        label={copy.descriptionLabel}
        hint={copy.descriptionHint}
        countLabel={(used, max) => `${copy.descriptionCount}: ${used} / ${max}`}
      />
      <BenchmarkPublishPanel
        snapshot={snapshot}
        description={effectiveDescription}
        sourceRunId={record.id}
        busy={busy}
        copy={copy}
        onQueued={onQueued}
        onBound={(value) => setBoundDescription(value)}
        onWorkingChange={setPublishing}
      />
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
