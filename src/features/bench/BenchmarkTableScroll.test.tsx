import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BenchmarkTableScroll from './BenchmarkTableScroll';
import { benchmarkCopy } from './benchmarkCopy';

const copy = benchmarkCopy('en');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function view(label = 'Measurements') {
  return <BenchmarkTableScroll label={label} copy={copy}>
    <table><tbody><tr><td><button type="button">Cell action</button></td></tr></tbody></table>
  </BenchmarkTableScroll>;
}

function resize(region: HTMLElement, width: number, content: number) {
  Object.defineProperties(region, { clientWidth: { configurable: true, value: width }, scrollWidth: { configurable: true, value: content } });
  fireEvent(window, new Event('resize'));
}

describe('benchmark measurement columns', () => {
  it('shows controls only for overflow and bounds movement at both ends', () => {
    render(view());
    const region = screen.getByRole('region', { name: 'Measurements' });
    resize(region, 320, 320);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    resize(region, 320, 960);
    const previous = screen.getByRole('button', { name: copy.previousColumns });
    const next = screen.getByRole('button', { name: copy.nextColumns });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    expect(next).toHaveAttribute('aria-controls', region.id);
    expect(region).toHaveAccessibleDescription(copy.columnsHint);
    fireEvent.click(next);
    expect(region.scrollLeft).toBeGreaterThan(0);
    expect(previous).toBeEnabled();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(region.scrollLeft).toBe(640);
    expect(next).toBeDisabled();
    fireEvent.click(previous);
    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(region.scrollLeft).toBe(0);
    expect(previous).toBeDisabled();
    resize(region, 960, 960);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('leaves cell controls, modified shortcuts and vertical scrolling alone', () => {
    render(view());
    const region = screen.getByRole('region');
    resize(region, 320, 960);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cell action' }), { key: 'End' });
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      fireEvent.keyDown(region, { key: 'End', [modifier]: true });
    }
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    fireEvent(region, down);
    expect(down.defaultPrevented).toBe(false);
    expect(region.scrollLeft).toBe(0);
    fireEvent.keyDown(region, { key: 'End' });
    expect(region.scrollLeft).toBe(640);
    fireEvent.keyDown(region, { key: 'Home' });
    expect(region.scrollLeft).toBe(0);
  });

  it('keeps individual comparison tables independent', () => {
    render(<>{view('Single')}{view('Concurrent')}</>);
    const single = screen.getByRole('region', { name: 'Single' });
    const concurrent = screen.getByRole('region', { name: 'Concurrent' });
    resize(single, 320, 960);
    resize(concurrent, 320, 1200);
    fireEvent.click(within(screen.getByRole('group', { name: `Concurrent · ${copy.tableColumns}` })).getByRole('button', { name: copy.nextColumns }));
    expect(concurrent.scrollLeft).toBeGreaterThan(0);
    expect(single.scrollLeft).toBe(0);
  });

  it('remeasures changed content and releases its resize observer on unmount', () => {
    let notify = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const { unmount } = render(view());
    const region = screen.getByRole('region');
    expect(observe).toHaveBeenCalledWith(region);
    expect(observe).toHaveBeenCalledWith(region.querySelector('table'));
    Object.defineProperties(region, { clientWidth: { configurable: true, value: 320 }, scrollWidth: { configurable: true, value: 960 } });
    act(notify);
    expect(screen.getByRole('button', { name: copy.nextColumns })).toBeEnabled();
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each(['en', 'ko', 'ja', 'zh'] as const)('provides translated controls and keyboard instructions in %s', locale => {
    const translated = benchmarkCopy(locale);
    render(<BenchmarkTableScroll label="Metrics" copy={translated}><table><tbody><tr><td>PP / TG</td></tr></tbody></table></BenchmarkTableScroll>);
    const region = screen.getByRole('region');
    resize(region, 320, 960);
    expect(screen.getByRole('button', { name: translated.previousColumns })).toBeDisabled();
    expect(screen.getByRole('button', { name: translated.nextColumns })).toBeEnabled();
    expect(region).toHaveAccessibleDescription(translated.columnsHint);
  });
});
