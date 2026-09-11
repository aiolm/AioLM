import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { DraftGuardProvider } from '../../shared/state/draftGuard';
import { createTestStore } from '../../testing/appStore';
import type { AppStore } from '../../shared/state/store';
import ModelWorkspace from './ModelWorkspace';
import { useExecutionStore } from './useExecutionStore';
import { useCallback, useState } from 'react';
import * as api from '../../shared/api/index';

vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  listModels: vi.fn(async () => ({ models: [
    { name: 'a.gguf', path: 'a.gguf', size_mb: 3000, is_vision: false },
    { name: 'b.gguf', path: 'b.gguf', size_mb: 1500, is_vision: false },
    { name: 'missing.gguf', path: 'missing.gguf', size_mb: 1500, is_vision: false, shards: { missing: ['part2'], files: ['missing.gguf'], total: 2 } },
  ], truncated: false })),
  rtList: vi.fn(async () => [{ backend: 'cpu', build: 'b123', dir: 'runtime', size_mb: 30 }]),
  deviceProfile: vi.fn(async () => ({ profile: { gpus: [] }, backends: [] })),
  rtProbe: vi.fn(async () => ({ backend: 'cpu', build: 'b123', devices: [], diagnostics: [], flags: [], state: 'available', server_help: '' })),
  listServerLoraAdapters: vi.fn(async () => []),
}));
function Harness({ base }: { base: AppStore }) {
  const [cfg, setConfig] = useState(base.cfg);
  const updateConfig = useCallback<AppStore['updateConfig']>(async patch => {
    const saved = await base.updateConfig(patch);
    setConfig({ ...saved });
    return saved;
  }, [base]);
  const execution = useExecutionStore({ ...base, cfg, updateConfig });
  return <ModelWorkspace store={execution.store} onSelectModel={execution.selectModel} active section={{ id: 'setup', revision: 0 }} onNavigate={vi.fn()} />;
}
function mount(base = createTestStore({ active_model: 'a.gguf' })) {
  render(<I18nProvider initialLocale="en"><DraftGuardProvider><Harness base={base} /></DraftGuardProvider></I18nProvider>);
  return base;
}
function findModelButton(path: string) {
  // Wait for the asynchronous scan without repeatedly traversing the large tuning form.
  const library = document.querySelector<HTMLElement>('.model-workspace-library')!;
  return within(library).findByRole('button', { name: `Configure & run: ${path}` }, { timeout: 3000 });
}
describe('model execution workspace', () => {
  beforeEach(() => { localStorage.clear(); Element.prototype.scrollIntoView = vi.fn(); });
  it('selects without starting, restores per-model edits and starts from the same screen', async () => {
    const base = mount();
    await findModelButton('b.gguf');
    expect(screen.getByLabelText('Runtime', { selector: 'select' })).toHaveValue('cpu/b123');
    fireEvent.change(screen.getByRole('spinbutton', { name: /Context size/ }), { target: { value: '8192' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: /Context size/ }));
    await waitFor(() => expect(base.cfg?.ctx_size).toBe(8192));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Configure & run: b.gguf' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: b.gguf' }));
    await waitFor(() => expect(base.cfg?.active_model).toBe('b.gguf'));
    expect(base.start).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Configure & run: a.gguf' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: a.gguf' }));
    await waitFor(() => expect(base.cfg?.active_model).toBe('a.gguf'));
    expect(base.cfg?.ctx_size).toBe(8192);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(base.start).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Configure & run: missing.gguf' })).toBeDisabled();
  });
  it('requires an explicit stop before switching and cancellation leaves the server alone', async () => {
    const base = createTestStore({ active_model: 'a.gguf' }); base.status = { state: 'running' };
    mount(base);
    fireEvent.click(await findModelButton('b.gguf'));
    const dialog = await screen.findByRole('dialog', { name: 'Stop and switch model?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(base.stop).not.toHaveBeenCalled(); expect(base.cfg?.active_model).toBe('a.gguf');
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: b.gguf' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stop and switch model?' })).getByRole('button', { name: 'Stop & select' }));
    await waitFor(() => expect(base.cfg?.active_model).toBe('b.gguf'));
    expect(base.stop).toHaveBeenCalledOnce(); expect(base.start).not.toHaveBeenCalled();
  });
  it('blocks invalid drafts and allows discarding before model selection', async () => {
    const base = mount();
    await findModelButton('b.gguf');
    fireEvent.change(screen.getByRole('spinbutton', { name: /Context size/ }), { target: { value: '-8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: b.gguf' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save & continue' }));
    await within(dialog).findByRole('alert');
    expect(base.cfg?.active_model).toBe('a.gguf');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard & continue' }));
    await waitFor(() => expect(base.cfg?.active_model).toBe('b.gguf'));
    expect(base.cfg?.ctx_size).toBe(4096);
  });
  it('shows a missing runtime and blocks starting without silently replacing it', async () => {
    const base = mount(createTestStore({ active_model: 'a.gguf', active_backend: 'cuda', active_build: 'missing' }));
    await screen.findByText('This runtime is not installed. Install it or select another runtime.');
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(base.cfg?.active_backend).toBe('cuda'); expect(base.start).not.toHaveBeenCalled();
  });
  it('keeps buttons, expanded settings and runtime resources mounted when selecting a model', async () => {
    mount();
    await findModelButton('b.gguf');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    const detail = document.querySelector('.model-workspace-detail')!;
    const buttons = Array.from(detail.querySelectorAll('button'));
    const advanced = detail.querySelector<HTMLDetailsElement>('.execution-disclosure')!;
    advanced.open = true;
    const calls = [vi.mocked(api.rtList).mock.calls.length, vi.mocked(api.rtProbe).mock.calls.length, vi.mocked(api.deviceProfile).mock.calls.length];
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: b.gguf' }));
    await screen.findByRole('heading', { name: 'b.gguf' });
    expect(buttons.every(button => button.isConnected)).toBe(true);
    expect(advanced.open).toBe(true);
    expect([vi.mocked(api.rtList).mock.calls.length, vi.mocked(api.rtProbe).mock.calls.length, vi.mocked(api.deviceProfile).mock.calls.length]).toEqual(calls);
  });
});
