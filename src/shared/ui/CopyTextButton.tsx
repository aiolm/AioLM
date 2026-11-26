import { useEffect, useRef, useState } from 'react';

/** Copies `text` and reports the result next to the button. Feedback always
 * belongs to the text currently shown: replacing it clears the old result, and
 * a late clipboard answer for earlier text is ignored. */
export default function CopyTextButton({ text, labels, className }: {
  text: string; labels: { copy: string; copied: string; copyFailed: string }; className?: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const attempt = useRef(0);
  const timer = useRef<number | null>(null);
  const clearTimer = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => {
    attempt.current += 1;
    clearTimer();
    setStatus('idle');
  }, [text]);
  useEffect(() => () => { attempt.current += 1; clearTimer(); }, []);
  const copyText = async () => {
    clearTimer();
    const current = ++attempt.current;
    try {
      await navigator.clipboard.writeText(text);
      if (attempt.current !== current) return;
      setStatus('copied');
      timer.current = window.setTimeout(() => { if (attempt.current === current) setStatus('idle'); }, 1800);
    } catch {
      if (attempt.current === current) setStatus('error');
    }
  };
  return (
    <div className={className ? `app-page-actions ${className}` : 'app-page-actions'}>
      <button type="button" className="app-button app-button--secondary app-button--sm" data-icon="copy" onClick={() => void copyText()}>
        {labels.copy}
      </button>
      <span role="status" className="app-section-hint">{status === 'error' ? labels.copyFailed : status === 'copied' ? labels.copied : ''}</span>
    </div>
  );
}
