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
function modelLibrary() {
  return within(document.querySelector<HTMLElement>('.model-workspace-library')!);
}
function findModelButton(path: string) {
  return modelLibrary().findByRole('button', { name: `Configure & run: ${path}` }, { timeout: 3000 });
}
function getModelButton(path: string) {
  return modelLibrary().getByRole('button', { name: `Configure & run: ${path}` });
}
function getStartButton() {
  return within(document.querySelector<HTMLElement>('.execution-footer')!).getByRole('button', { name: 'Start' });
}
describe('model execution workspace', () => {
  beforeEach(() => { localStorage.clear(); Element.prototype.scrollIntoView = vi.fn(); });
  it('hides runtime failure paths inside nested feedback content and keeps configured paths intact', async () => {
    const raw = String.raw`\\?\C:\runtime\llama-server.exe`;
    const projector = String.raw`\\?\UNC\server\models\mmproj.gguf`;
    vi.mocked(api.rtList).mockRejectedValueOnce(new Error(`Cannot read ${raw}`));
    const base = mount(createTestStore({ active_model: 'a.gguf', mmproj: projector }));
    const detail = await screen.findByText(String.raw`Error: Cannot read C:\runtime\llama-server.exe`);
    expect(detail.closest('[role="alert"]')).toHaveTextContent('Could not load runtimes or devices');
    expect(document.body.textContent).not.toContain('\\\\?\\');
    const projectorInput = document.querySelector<HTMLInputElement>('#execution-projector')!;
    expect(projectorInput).toHaveValue(String.raw`\\server\models\mmproj.gguf`);
    fireEvent.blur(projectorInput);
    expect(base.cfg?.mmproj).toBe(projector);
    expect(base.updateConfig).not.toHaveBeenCalled();
  });

  it('formats model row labels and accessibility names while selecting the original path', async () => {
    const raw = String.raw`\\?\C:\models\b.gguf`;
    const display = String.raw`C:\models\b.gguf`;
    const model = { name: raw, path: raw, size_mb: 1500, is_vision: false };
    vi.mocked(api.listModels).mockResolvedValueOnce({ models: [model], truncated: false });
    const base = createTestStore();
    const select = vi.fn(async () => undefined);
    render(<I18nProvider initialLocale="en"><DraftGuardProvider><ModelWorkspace store={base} onSelectModel={select} active section={{ id: 'setup', revision: 0 }} onNavigate={vi.fn()} /></DraftGuardProvider></I18nProvider>);
    const button = await modelLibrary().findByRole('button', { name: `Select ${display}` });
    expect(button).toHaveTextContent(display);
    expect(document.body.textContent).not.toContain('\\\\?\\');
    for (const element of document.querySelectorAll('[aria-label], [title]')) {
      expect(element.getAttribute('aria-label') ?? '').not.toContain('\\\\?\\');
      expect(element.getAttribute('title') ?? '').not.toContain('\\\\?\\');
    }
    fireEvent.click(button);
    await waitFor(() => expect(select).toHaveBeenCalledWith(raw));
    expect(model.path).toBe(raw);
  });

  it('shows the grouped model label before and after scanning while preserving the launch path', async () => {
    const name = 'Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64';
    const path = `C:/models/${name}-00001-of-00033.gguf`;
    let finishScan!: (value: api.ModelScanResult) => void;
    vi.mocked(api.listModels).mockImplementationOnce(() => new Promise(resolve => { finishScan = resolve; }));
    const base = mount(createTestStore({ active_model: path }));
    expect(screen.getByRole('heading', { name: `${name}.gguf` })).toHaveAttribute('title', path);
    await waitFor(() => expect(finishScan).toBeDefined());
    finishScan({ models: [{ name: `${name}.gguf`, path, size_mb: 33000, is_vision: false,
      shards: { files: Array.from({ length: 33 }, (_, index) => `C:/models/${name}-${String(index + 1).padStart(5, '0')}-of-00033.gguf`), total: 33, missing: [] } }], truncated: false });
    await findModelButton(`${name}.gguf`);
    expect(screen.getByRole('heading', { name: `${name}.gguf` })).toHaveAttribute('title', path);
    await waitFor(() => expect(getStartButton()).toBeEnabled());
    fireEvent.click(getStartButton());
    await waitFor(() => expect(base.start).toHaveBeenCalledOnce());
    expect(base.cfg?.active_model).toBe(path);
  });
  it('selects without starting, restores per-model edits and starts from the same screen', async () => {
    const base = mount();
    await findModelButton('b.gguf');
    expect(screen.getByLabelText('Runtime', { selector: 'select' })).toHaveValue('cpu/b123');
    const contextSize = within(document.querySelector<HTMLElement>('.execution-quick')!).getByRole('spinbutton', { name: /Context size/ });
    fireEvent.change(contextSize, { target: { value: '8192' } });
    fireEvent.blur(contextSize);
    await waitFor(() => expect(base.cfg?.ctx_size).toBe(8192));
    await waitFor(() => expect(getModelButton('b.gguf')).toBeEnabled());
    fireEvent.click(getModelButton('b.gguf'));
    await waitFor(() => expect(base.cfg?.active_model).toBe('b.gguf'));
    expect(base.start).not.toHaveBeenCalled();
    await waitFor(() => expect(getModelButton('a.gguf')).toBeEnabled());
    fireEvent.click(getModelButton('a.gguf'));
    await waitFor(() => expect(base.cfg?.active_model).toBe('a.gguf'));
    expect(base.cfg?.ctx_size).toBe(8192);
    await waitFor(() => expect(getStartButton()).toBeEnabled());
    fireEvent.click(getStartButton());
    await waitFor(() => expect(base.start).toHaveBeenCalledOnce());
    expect(getModelButton('missing.gguf')).toBeDisabled();
  }, 10000); // Covers saving, two model transitions, and starting on slower CI runners.
  it('requires an explicit stop before switching and cancellation leaves the server alone', async () => {
    const base = createTestStore({ active_model: 'a.gguf' }); base.status = { state: 'running' };
    mount(base);
    fireEvent.click(await findModelButton('b.gguf'));
    const dialog = await screen.findByRole('dialog', { name: 'Stop and switch model?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(base.stop).not.toHaveBeenCalled(); expect(base.cfg?.active_model).toBe('a.gguf');
    fireEvent.click(getModelButton('b.gguf'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stop and switch model?' })).getByRole('button', { name: 'Stop & select' }));
    await waitFor(() => expect(base.cfg?.active_model).toBe('b.gguf'));
    expect(base.stop).toHaveBeenCalledOnce(); expect(base.start).not.toHaveBeenCalled();
  });
  it('blocks invalid drafts and allows discarding before model selection', async () => {
    const base = mount();
    await findModelButton('b.gguf');
    const contextSize = within(document.querySelector<HTMLElement>('.execution-quick')!).getByRole('spinbutton', { name: /Context size/ });
    fireEvent.change(contextSize, { target: { value: '-8' } });
    fireEvent.click(getModelButton('b.gguf'));
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
    expect(getStartButton()).toBeDisabled();
    expect(base.cfg?.active_backend).toBe('cuda'); expect(base.start).not.toHaveBeenCalled();
  });
  it('keeps buttons, expanded settings and runtime resources mounted when selecting a model', async () => {
    mount();
    await findModelButton('b.gguf');
    await waitFor(() => expect(getStartButton()).toBeEnabled());
    const detail = document.querySelector('.model-workspace-detail')!;
    const buttons = Array.from(detail.querySelectorAll('button'));
    const advanced = detail.querySelector<HTMLDetailsElement>('.execution-disclosure')!;
    advanced.open = true;
    const calls = [vi.mocked(api.rtList).mock.calls.length, vi.mocked(api.rtProbe).mock.calls.length, vi.mocked(api.deviceProfile).mock.calls.length];
    fireEvent.click(getModelButton('b.gguf'));
    await screen.findByRole('heading', { name: 'b.gguf' });
    expect(buttons.every(button => button.isConnected)).toBe(true);
    expect(advanced.open).toBe(true);
    expect([vi.mocked(api.rtList).mock.calls.length, vi.mocked(api.rtProbe).mock.calls.length, vi.mocked(api.deviceProfile).mock.calls.length]).toEqual(calls);
  });
});
