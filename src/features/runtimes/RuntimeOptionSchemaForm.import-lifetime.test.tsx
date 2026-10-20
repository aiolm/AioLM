import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RuntimeOptionSchemaForm from './RuntimeOptionSchemaForm';
import * as runtimeHelp from '../../shared/api/runtimeHelp';
import type { ImportedPlan, OptionSchema } from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import { effectiveSchema } from '../../testing/effectiveSchema';

vi.mock('../../shared/api/runtimeHelp', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/runtimeHelp')>(),
  runtimeHelpImport: vi.fn(), runtimeHelpResolve: vi.fn(),
}));

const schema = effectiveSchema([
  { key: 'count', flag: '--count', target: 'launch', group: 'other', kind: { type: 'integer' } },
  { key: 'label', flag: '--label', target: 'launch', group: 'other', kind: { type: 'text' } },
]).schema;
const initial = { count: 5, label: 'original', retained_unknown: { nested: ['kept'] } };
const plan = (count: number): ImportedPlan => ({ plan: [{ key: 'count', spelling: '--count', values: [count] }], managed: [], unrecognized: [] });
const expected = (count: number, label = 'original') => ({
  count, label, retained_unknown: { nested: ['kept'] },
  '@option_order': { version: 1, occurrences: [{ key: 'label' }, { key: 'count' }] },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async (request: ReturnType<typeof deferred<ImportedPlan>>, result: ImportedPlan) => {
  await act(async () => { request.resolve(result); await request.promise; });
};
const applyIfAvailable = () => {
  const button = screen.queryByRole('button', { name: 'Apply these options' });
  if (button) fireEvent.click(button);
};

function mounted() {
  const values = structuredClone(initial);
  const before = structuredClone(values);
  const onChange = vi.fn();
  const view = (current: OptionSchema = schema, scope: string[] = [], saved = values) => <I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} scope={scope} values={saved} onChange={onChange} /></I18nProvider>;
  const rendered = render(view());
  fireEvent.click(screen.getByText('Import a pasted command line'));
  const paste = screen.getByRole('textbox', { name: /Pasted command/ });
  const write = (text: string) => fireEvent.change(paste, { target: { value: text } });
  const read = () => fireEvent.click(screen.getByRole('button', { name: 'Read options from command' }));
  return { ...rendered, values, before, onChange, view, paste, write, read };
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.mocked(runtimeHelp.runtimeHelpResolve).mockResolvedValue({ argv: [], request: {} });
});
afterEach(cleanup);

describe('standalone runtime command import ownership', () => {
  it('control: applies an unchanged completed import explicitly and preserves unrelated data', async () => {
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(plan(11));
    const state = mounted();
    state.write('--count 11'); state.read();
    await screen.findByText('Imported option order: count');
    expect(state.onChange).not.toHaveBeenCalled();
    applyIfAvailable();
    expect(state.onChange).toHaveBeenCalledWith(expected(11));
    expect(state.paste).toHaveValue('--count 11');
    expect(state.values).toEqual(state.before);
  });

  it('does not apply a completed old plan after the visible pasted command is edited', async () => {
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(plan(11));
    const state = mounted();
    state.write('--count 11'); state.read();
    await screen.findByText('Imported option order: count');
    state.write('--count 22');
    applyIfAvailable();
    expect.soft(state.onChange).not.toHaveBeenCalled();
    expect(state.paste).toHaveValue('--count 22');
    expect(state.values).toEqual(state.before);
  });

  it('discards a pending result after the pasted command changes without another Read', async () => {
    const old = deferred<ImportedPlan>();
    vi.mocked(runtimeHelp.runtimeHelpImport).mockReturnValue(old.promise);
    const state = mounted();
    state.write('--count 11'); state.read();
    state.write('--count 22');
    await settle(old, plan(11));
    applyIfAvailable();
    expect.soft(state.onChange).not.toHaveBeenCalled();
    expect(state.paste).toHaveValue('--count 22');
    expect(state.values).toEqual(state.before);
  });

  it('keeps the newer successful command when an older successful response arrives last', async () => {
    const old = deferred<ImportedPlan>(); const next = deferred<ImportedPlan>();
    vi.mocked(runtimeHelp.runtimeHelpImport).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const state = mounted();
    state.write('--count 11'); state.read();
    state.write('--count 22'); state.read();
    await settle(next, plan(22));
    await settle(old, plan(11));
    applyIfAvailable();
    expect(state.onChange).toHaveBeenCalledWith(expected(22));
    expect(state.paste).toHaveValue('--count 22');
  });

  it('ignores an old rejection after the newer command has completed successfully', async () => {
    const old = deferred<ImportedPlan>(); const next = deferred<ImportedPlan>();
    vi.mocked(runtimeHelp.runtimeHelpImport).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const state = mounted();
    state.write('--count "'); state.read();
    state.write('--count 22'); state.read();
    await settle(next, plan(22));
    await act(async () => { old.reject(new Error('synthetic-old-command-rejected')); await old.promise.catch(() => undefined); });
    expect.soft(screen.queryByText('synthetic-old-command-rejected')).not.toBeInTheDocument();
    applyIfAvailable();
    expect(state.onChange).toHaveBeenCalledWith(expected(22));
  });

  it.each(['schema', 'scope'] as const)('invalidates an accepted import after its %s owner changes', async owner => {
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(plan(11));
    const state = mounted();
    state.write('--count 11'); state.read();
    await screen.findByText('Imported option order: count');
    const nextSchema = owner === 'schema' ? { ...schema, binding: { ...schema.binding, runtime: 'different-synthetic-runtime', fingerprint: 'b'.repeat(64) } } : schema;
    state.rerender(state.view(nextSchema, owner === 'scope' ? ['serve'] : []));
    applyIfAvailable();
    expect.soft(state.onChange).not.toHaveBeenCalled();
    expect(state.paste).toHaveValue('--count 11');
    expect(state.values).toEqual(state.before);
  });

  it.each(['schema', 'scope'] as const)('discards an in-flight import after its %s owner changes', async owner => {
    const old = deferred<ImportedPlan>();
    vi.mocked(runtimeHelp.runtimeHelpImport).mockReturnValue(old.promise);
    const state = mounted();
    state.write('--count 11'); state.read();
    const nextSchema = owner === 'schema' ? { ...schema, binding: { ...schema.binding, runtime: 'different-synthetic-runtime', fingerprint: 'b'.repeat(64) } } : schema;
    state.rerender(state.view(nextSchema, owner === 'scope' ? ['serve'] : []));
    await settle(old, plan(11));
    applyIfAvailable();
    expect.soft(state.onChange).not.toHaveBeenCalled();
    expect(state.values).toEqual(state.before);
  });

  it.each(['schema', 'scope'] as const)('does not restore an accepted plan when its %s owner changes away and back', async owner => {
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(plan(11));
    const state = mounted();
    state.write('--count 11'); state.read();
    await screen.findByText('Imported option order: count');
    const nextSchema = owner === 'schema' ? { ...schema, binding: { ...schema.binding, runtime: 'different-synthetic-runtime' } } : schema;
    state.rerender(state.view(nextSchema, owner === 'scope' ? ['serve'] : []));
    state.rerender(state.view());
    applyIfAvailable();
    expect(state.onChange).not.toHaveBeenCalled();
  });

  it.each(['schema', 'scope'] as const)('does not accept an old pending response after its %s owner changes away and back', async owner => {
    const old = deferred<ImportedPlan>();
    vi.mocked(runtimeHelp.runtimeHelpImport).mockReturnValue(old.promise);
    const state = mounted();
    state.write('--count 11'); state.read();
    const nextSchema = owner === 'schema' ? { ...schema, binding: { ...schema.binding, runtime: 'different-synthetic-runtime' } } : schema;
    state.rerender(state.view(nextSchema, owner === 'scope' ? ['serve'] : []));
    state.rerender(state.view());
    await settle(old, plan(11));
    applyIfAvailable();
    expect(state.onChange).not.toHaveBeenCalled();
  });

  it('control: equal scope contents and fresh unrelated saved values do not change command ownership', async () => {
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(plan(11));
    const state = mounted();
    state.write('--count 11'); state.read();
    await screen.findByText('Imported option order: count');
    const updated = { ...state.values, label: 'current' };
    state.rerender(state.view(schema, [], updated));
    applyIfAvailable();
    expect(state.onChange).toHaveBeenCalledWith(expected(11, 'current'));
    expect(updated).toEqual({ ...state.before, label: 'current' });
  });

  it('control: an unmounted request cannot replace the new mounted form import', async () => {
    const old = deferred<ImportedPlan>(); const next = deferred<ImportedPlan>();
    vi.mocked(runtimeHelp.runtimeHelpImport).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const previous = mounted();
    previous.write('--count 11'); previous.read();
    previous.unmount();
    const current = mounted();
    current.write('--count 22'); current.read();
    await settle(next, plan(22));
    await settle(old, plan(11));
    applyIfAvailable();
    expect(previous.onChange).not.toHaveBeenCalled();
    expect(current.onChange).toHaveBeenCalledWith(expected(22));
  });
});
