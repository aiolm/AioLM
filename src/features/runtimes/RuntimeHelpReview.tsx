import { useEffect, useId, useRef, useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import {
  runtimeHelpAccept,
  runtimeHelpCancelSelected,
  runtimeHelpDiscoverSelected,
  runtimeHelpTarget,
  type EffectiveSchema,
  type HelpReport,
  type HelpRequest,
  type HelpTarget,
  type RuntimeDescriptor,
} from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { helpSummary } from './helpSummary';
import RuntimeArgumentList from './RuntimeArgumentList';
import { entrypointCopy } from '../../shared/i18n/entrypointCopy';

/** Discover, review and accept the selected runtime's help. Help runs only on
 * the explicit button; acceptance pins this exact runtime build. */
export default function RuntimeHelpReview({ cfg, effective, disabled, onAccepted }: {
  cfg: AppConfig;
  effective: EffectiveSchema;
  disabled: boolean;
  onAccepted: () => void;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const taskId = `runtime-help-review-${id}`;
  const [target, setTarget] = useState<HelpTarget | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<[HelpReport, RuntimeDescriptor] | null>(null);
  const [request, setRequest] = useState<HelpRequest | null>(null);
  const generation = useRef(0);
  const pending = useRef<AppConfig | null>(null);
  const cancelRequested = useRef(false);
  useEffect(() => {
    let active = true;
    setTarget(null); setFound(null); setError(''); setBusy(false); setAccepting(false); setRequest(null);
    void runtimeHelpTarget(cfg).then(next => {
      if (!active) return;
      setTarget(next);
      setExtra(next.request.args.slice(next.prefix.length));
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => {
      active = false;
      generation.current += 1;
      if (pending.current) void runtimeHelpCancelSelected(pending.current).catch(() => undefined);
      pending.current = null;
      finishTask(taskId, 'cancelled');
    };
    // The target depends only on the selected runtime identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.active_provider, cfg.active_runtime, cfg.active_backend, cfg.active_build]);
  const state = effective.help_state;
  const status = state === 'current' ? copy.helpCurrent : state === 'stale' ? copy.helpStale : state === 'unchecked' ? copy.helpUnchecked : copy.helpNone;
  const discover = async () => {
    if (!target || busy || accepting) return;
    const next: HelpRequest = target.fixed ? target.request : {
      program: target.request.program ?? null,
      args: [...target.prefix, ...extra],
      scope: target.request.scope,
    };
    const ownGeneration = ++generation.current;
    cancelRequested.current = false;
    pending.current = cfg;
    const current = () => ownGeneration === generation.current;
    setBusy(true); setError(''); setFound(null); setRequest(next);
    registerTask({ id: taskId, kind: 'runtime', label: copy.helpTitle, interruptible: true, cancel: () => { cancelRequested.current = true; void runtimeHelpCancelSelected(cfg); } });
    try {
      const result = await runtimeHelpDiscoverSelected(cfg, next);
      if (!current()) return;
      if (!cancelRequested.current) setFound(result);
      finishTask(taskId, cancelRequested.current ? 'cancelled' : 'completed');
    } catch (cause) {
      if (!current()) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = message.includes('cancelled');
      if (!cancelled) setError(message);
      finishTask(taskId, cancelled ? 'cancelled' : 'failed', message);
    } finally {
      if (current()) { pending.current = null; setBusy(false); }
    }
  };
  const accept = async () => {
    if (!found || !request || busy || accepting) return;
    const ownGeneration = ++generation.current;
    setAccepting(true);
    setError('');
    try {
      await runtimeHelpAccept(cfg, found[1].fingerprint, request);
      if (ownGeneration !== generation.current) return;
      setFound(null);
      onAccepted();
    } catch (cause) {
      if (ownGeneration === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (ownGeneration === generation.current) setAccepting(false);
    }
  };
  const summary = found ? helpSummary(found[1]) : null;
  return (
    <section className="app-card app-card--tight mt-3" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.helpTitle}</h4>
      <p role="status">{status}</p>
      {state === 'stale' && effective.help_detail && <FeedbackBanner tone="warning">{effective.help_detail}</FeedbackBanner>}
      {target && (
        <p className="app-section-hint">
          {copy.command}: {[target.program, ...target.prefix].map(token => JSON.stringify(token)).join(' ')}
        </p>
      )}
      {target && !target.fixed && (
        <RuntimeArgumentList label={entrypointCopy[locale].helpArgs} tokens={extra} disabled={disabled || busy || accepting}
          onChange={next => { setExtra(next); setFound(null); setRequest(null); }} />
      )}
      <div className="app-page-actions mt-3">
        <button type="button" className="app-button app-button--secondary" disabled={disabled || busy || accepting || !target} onClick={() => void discover()}>{copy.discover}</button>
        {busy && (
          <LocalTaskCancelButton taskId={taskId} onClick={() => { cancelRequested.current = true; updateTask(taskId, { state: 'cancelling' }); void runtimeHelpCancelSelected(cfg).catch(cause => setError(String(cause))); }}>
            {copy.cancel}
          </LocalTaskCancelButton>
        )}
      </div>
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
      {found && summary && (
        <div className="mt-3">
          <p>{copy.discovered}: {summary.total} {copy.options}</p>
          {summary.uncertain.length > 0 && <p>{copy.uncertain}: {summary.uncertain.length} ({summary.uncertain.slice(0, 20).join(', ')}{summary.uncertain.length > 20 ? ', …' : ''})</p>}
          {found[1].diff && (
            <ul>
              {found[1].diff.added.length > 0 && <li>{copy.added}: {found[1].diff.added.join(', ')}</li>}
              {found[1].diff.removed.length > 0 && <li>{copy.removed}: {found[1].diff.removed.join(', ')}</li>}
              {found[1].diff.changed.length > 0 && <li>{copy.changed}: {found[1].diff.changed.join(', ')}</li>}
            </ul>
          )}
          {found[1].retained.length > 0 && <FeedbackBanner tone="warning">{copy.retained}: {found[1].retained.join(', ')}</FeedbackBanner>}
          <details>
            <summary>{copy.rawHelp}</summary>
            <pre className="overflow-auto whitespace-pre-wrap">{[found[0].stdout.clean_text, found[0].stderr.clean_text].filter(Boolean).join('\n')}</pre>
          </details>
          {found[1].help_complete ? (
            <>
              <p className="app-section-hint">{copy.acceptHint}</p>
              <button type="button" className="app-button app-button--primary" disabled={disabled || busy || accepting} onClick={() => void accept()}>{copy.accept}</button>
            </>
          ) : <FeedbackBanner tone="error">{copy.incomplete}</FeedbackBanner>}
        </div>
      )}
    </section>
  );
}
