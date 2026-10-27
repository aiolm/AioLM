import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { benchmarkCopy } from './benchmarkCopy';

type Copy = Pick<ReturnType<typeof benchmarkCopy>, 'tableColumns' | 'previousColumns' | 'nextColumns' | 'columnsHint'>;

/** Keep every measurement reachable when its comparison table exceeds the window. */
export default function BenchmarkTableScroll({ label, copy, children }: { label: string; copy: Copy; children: ReactNode }) {
  const id = useId();
  const region = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, previous: false, next: false });
  const measure = useCallback(() => {
    const element = region.current;
    if (!element) return;
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    const next = { overflow: element.clientWidth > 0 && maximum > 1, previous: element.scrollLeft > 1, next: element.scrollLeft < maximum - 1 };
    setEdges(previous => previous.overflow === next.overflow && previous.previous === next.previous && previous.next === next.next ? previous : next);
  }, []);
  // Rows, translated headers and container width can change independently.
  useLayoutEffect(measure);
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const table = element.querySelector('table');
    if (table) observer?.observe(table);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);

  const move = (direction: 'previous' | 'next' | 'first' | 'last') => {
    const element = region.current;
    if (!element) return;
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    const step = Math.max(120, element.clientWidth * 0.75);
    const target = direction === 'first' ? 0 : direction === 'last' ? maximum
      : element.scrollLeft + (direction === 'next' ? step : -step);
    element.scrollLeft = Math.min(maximum, Math.max(0, target));
    measure();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A future link or control inside a cell retains its own keyboard behavior.
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !edges.overflow) return;
    const direction = event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next'
      : event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null;
    if (!direction) return;
    event.preventDefault();
    move(direction);
  };

  return <>
    <div ref={region} id={id} className="performance-table-scroll" role="region" aria-label={label}
      aria-describedby={edges.overflow ? `${id}-hint` : undefined} tabIndex={0} onScroll={measure} onKeyDown={onKeyDown}>
      {children}
    </div>
    {edges.overflow && <div className="performance-table-navigation" role="group" aria-label={`${label} · ${copy.tableColumns}`}>
      <span>{copy.tableColumns}</span><span id={`${id}-hint`} className="sr-only">{copy.columnsHint}</span>
      <button type="button" className="app-button app-button--ghost app-button--sm" aria-controls={id} aria-label={copy.previousColumns} title={copy.previousColumns} disabled={!edges.previous} onClick={() => move('previous')}>
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m12 4-6 6 6 6" /></svg>
      </button>
      <button type="button" className="app-button app-button--ghost app-button--sm" aria-controls={id} aria-label={copy.nextColumns} title={copy.nextColumns} disabled={!edges.next} onClick={() => move('next')}>
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m8 4 6 6-6 6" /></svg>
      </button>
    </div>}
  </>;
}
