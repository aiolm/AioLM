import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import * as api from '../../shared/api/index';
import { useModelSettings, type ModelSettingsContext } from '../model-settings/ModelSettingsProvider';
import { rememberExecution, MODEL_EXECUTION_KEY } from './modelExecutionState';
import ModelWorkspace from './ModelWorkspace';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: vi.fn(() => null) }));
vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  listModels: vi.fn(),
}));
const models: api.GgufModel[] = [
  { name: 'a.gguf', path: 'a.gguf', size_mb: 3000, is_vision: false },
  { name: 'b.gguf', path: 'b.gguf', size_mb: 1500, is_vision: false },
  { name: 'missing.gguf', path: 'missing.gguf', size_mb: 1500, is_vision: false, shards: { missing: [2], files: ['missing.gguf'], total: 2 } },
];
const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
function mount(base = createTestStore({ active_model: 'a.gguf' })) {
  render(<I18nProvider initialLocale="en"><ModelWorkspace store={base} onSelectModel={vi.fn()} active section={{ id: 'setup', revision: 0 }} onNavigate={vi.fn()} /></I18nProvider>);
  return base;
}
const findModelButton = (name: string) => within(document.querySelector<HTMLElement>('.model-workspace-library')!).findByRole('button', { name: 'Configure & run: ' + name });

describe('model management and settings', () => {
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks(); Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(useModelSettings).mockReturnValue(settings);
    vi.mocked(api.listModels).mockResolvedValue({ models, truncated: false });
  });
  it('opens a model draft while preserving the saved model and running server', async () => {
    const base = createTestStore({ active_model: 'a.gguf' }); base.status = { state: 'running', model: 'a.gguf' };
    mount(base);
    const stored = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.click(await findModelButton('b.gguf'));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'default' }, config: expect.objectContaining({ active_model: 'b.gguf' }) }));
    expect(base.cfg?.active_model).toBe('a.gguf');
    expect(base.start).not.toHaveBeenCalled(); expect(base.stop).not.toHaveBeenCalled(); expect(base.updateConfig).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled(); stored.mockRestore();
  });
  it('previews remembered settings without altering model memory', async () => {
    const base = createTestStore({ active_model: 'a.gguf', ctx_size: 4096 });
    rememberExecution({ ...base.cfg!, active_model: 'b.gguf', ctx_size: 8192, temperature: 0.25 });
    const saved = localStorage.getItem(MODEL_EXECUTION_KEY);
    mount(base);
    fireEvent.click(await findModelButton('b.gguf'));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_model: 'b.gguf', ctx_size: 8192, temperature: 0.25 }) }));
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(saved);
    expect(base.cfg?.ctx_size).toBe(4096);
  });
  it('preserves the first shard path while displaying a grouped model name', async () => {
    const name = 'Example-00001-of-00003.gguf', path = 'models/' + name;
    let finish!: (result: api.ModelScanResult) => void;
    vi.mocked(api.listModels).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const base = mount(createTestStore({ active_model: path }));
    expect(screen.getByRole('heading', { name: 'Example.gguf' })).toHaveAttribute('title', path);
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => finish({ models: [{ name: 'Example.gguf', path, size_mb: 3000, is_vision: false, shards: { files: [path, 'models/Example-00002-of-00003.gguf', 'models/Example-00003-of-00003.gguf'], total: 3, missing: [] } }], truncated: false }));
    fireEvent.click(await findModelButton('Example.gguf'));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_model: path }) }));
    expect(base.cfg?.active_model).toBe(path);
  });
  it('keeps missing-shard models unavailable for configuration', async () => {
    mount();
    const button = await findModelButton('missing.gguf');
    expect(button).toBeDisabled(); fireEvent.click(button);
    expect(settings.open).not.toHaveBeenCalled();
  });
  it('opens current model settings without retaining an inline execution form', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Configure and run' }));
    expect(settings.open).toHaveBeenCalledWith({ target: { kind: 'default' }, section: 'runtime' });
    expect(screen.queryByRole('spinbutton', { name: /Context size/ })).not.toBeInTheDocument();
  });
  it('opens model selection when no model is configured', () => {
    mount(createTestStore({ active_model: '' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    expect(settings.open).toHaveBeenCalledWith({ target: { kind: 'default' }, section: 'model' });
  });
});
