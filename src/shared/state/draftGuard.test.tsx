import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/i18n';
import { DraftGuardProvider, useDraftGuard, useEditorDraft } from './draftGuard';

function Draft({ save, discard, priority = 0 }: { save: () => Promise<boolean>; discard: () => void; priority?: number }) {
  const [dirty, setDirty] = useState(true);
  useEditorDraft({ dirty, priority, save: async () => { const saved = await save(); if (saved) setDirty(false); return saved; }, discard: () => { discard(); setDirty(false); } });
  return null;
}
function Action({ run }: { run: () => Promise<void> }) {
  const guard = useDraftGuard();
  return <button onClick={() => void guard.run(run)}>Switch model</button>;
}

describe('unsaved execution settings', () => {
  it('saves settings before a profile capture and then performs exactly one pending action', async () => {
    const order: string[] = [];
    const run = vi.fn(async () => { order.push('switch'); });
    render(<I18nProvider initialLocale="en"><DraftGuardProvider>
      <Draft priority={1} save={async () => { order.push('profile'); return true; }} discard={vi.fn()} />
      <Draft save={async () => { order.push('settings'); return true; }} discard={vi.fn()} /><Action run={run} />
    </DraftGuardProvider></I18nProvider>);
    fireEvent.click(screen.getByText('Switch model')); fireEvent.click(screen.getByText('Switch model'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByText('Save & continue'));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(order).toEqual(['settings', 'profile', 'switch']);
  });
  it('does not invoke the action when a draft fails validation, then allows discard', async () => {
    const run = vi.fn(async () => {}); const save = vi.fn(async () => false); const discard = vi.fn();
    render(<I18nProvider initialLocale="en"><DraftGuardProvider><Draft save={save} discard={discard} /><Action run={run} /></DraftGuardProvider></I18nProvider>);
    fireEvent.click(screen.getByText('Switch model')); fireEvent.click(screen.getByText('Save & continue'));
    await screen.findByRole('alert'); expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Discard & continue'));
    await waitFor(() => expect(run).toHaveBeenCalledOnce()); expect(discard).toHaveBeenCalledOnce();
  });
  it('cancels without saving or discarding', () => {
    const run = vi.fn(async () => {}); const save = vi.fn(async () => true); const discard = vi.fn();
    render(<I18nProvider initialLocale="en"><DraftGuardProvider><Draft save={save} discard={discard} /><Action run={run} /></DraftGuardProvider></I18nProvider>);
    fireEvent.click(screen.getByText('Switch model')); fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'));
    expect(run).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
  });
});
