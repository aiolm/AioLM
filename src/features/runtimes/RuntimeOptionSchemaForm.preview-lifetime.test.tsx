import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RuntimeOptionSchemaForm from './RuntimeOptionSchemaForm';
import * as runtimeHelp from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import { effectiveSchema } from '../../testing/effectiveSchema';

vi.mock('../../shared/api/runtimeHelp', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/runtimeHelp')>(),
  runtimeHelpResolve: vi.fn(),
}));

const schema = effectiveSchema([
  { key: 'label', flag: '--label', target: 'launch', group: 'other', kind: { type: 'text' } },
]).schema;
const scope: string[] = [];
const onChange = vi.fn();
const form = (values: Record<string, unknown>, compact = false) => (
  <I18nProvider initialLocale="en">
    <RuntimeOptionSchemaForm schema={schema} scope={scope} values={values} compact={compact} onChange={onChange} />
  </I18nProvider>
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const advance = async (milliseconds: number) => {
  await act(async () => { vi.advanceTimersByTime(milliseconds); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(runtimeHelp.runtimeHelpResolve).mockResolvedValue({ argv: [], request: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('standalone runtime argv preview lifetime', () => {
  it('waits 150 ms after the latest saved values before resolving their preview', async () => {
    vi.mocked(runtimeHelp.runtimeHelpResolve).mockResolvedValue({ argv: ['--label', 'latest'], request: {} });
    const state = render(form({ label: 'first' }));
    await advance(149);
    expect(runtimeHelp.runtimeHelpResolve).not.toHaveBeenCalled();

    const latest = { label: 'latest' };
    state.rerender(form(latest));
    await advance(149);
    expect(runtimeHelp.runtimeHelpResolve).not.toHaveBeenCalled();
    await advance(1);

    expect(runtimeHelp.runtimeHelpResolve).toHaveBeenCalledExactlyOnceWith(schema, scope, latest);
    expect(screen.getByText('"--label" "latest"', { selector: 'pre' })).toBeVisible();
  });

  it.each(['success', 'validation failure'] as const)('ignores an old %s after a newer preview completes', async outcome => {
    const old = deferred<Awaited<ReturnType<typeof runtimeHelp.runtimeHelpResolve>>>();
    vi.mocked(runtimeHelp.runtimeHelpResolve)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ argv: ['--label', 'latest'], request: {} });
    const state = render(form({ label: 'first' }));
    await advance(150);
    state.rerender(form({ label: 'latest' }));
    await advance(150);

    await act(async () => {
      if (outcome === 'success') old.resolve({ argv: ['--label', 'stale'], request: {} });
      else old.reject([{ key: 'label', message: 'stale validation failure' }]);
      await old.promise.catch(() => undefined);
    });

    expect(screen.getByText('"--label" "latest"', { selector: 'pre' })).toBeVisible();
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^--label/)).not.toHaveAttribute('aria-invalid');
  });

  it('cancels queued resolution when switching to compact mode or unmounting', async () => {
    const values = { label: 'kept' };
    const state = render(form(values));
    state.rerender(form(values, true));
    await advance(150);
    expect(runtimeHelp.runtimeHelpResolve).not.toHaveBeenCalled();

    state.rerender(form(values));
    state.unmount();
    await advance(150);
    expect(runtimeHelp.runtimeHelpResolve).not.toHaveBeenCalled();
  });
});
