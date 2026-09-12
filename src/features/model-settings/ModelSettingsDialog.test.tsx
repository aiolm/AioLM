import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { ModelSettingsDialog, type ModelSettingsDialogProps } from './ModelSettingsDialog';
import { rememberExecution } from '../models/modelExecutionState';
import { defaultModelProfile, defaultServerProfile, MODEL_PROFILES_STORAGE_KEY } from '../profiles/modelProfiles';
import * as api from '../../shared/api';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  listModels: vi.fn(async () => ({ models: [
    { name: 'a.gguf', path: 'models/a.gguf', size_mb: 3000, is_vision: false },
    { name: 'b.gguf', path: 'models/b.gguf', size_mb: 1500, is_vision: false },
  ], truncated: false })),
  rtList: vi.fn(async () => [{ backend: 'cpu', build: 'b123', dir: 'runtime', size_mb: 30 }]),
  deviceProfile: vi.fn(async () => ({ profile: { gpus: [] }, backends: [] })),
  rtProbe: vi.fn(async () => ({ backend: 'cpu', build: 'b123', devices: [], diagnostics: [], flags: [], state: 'available', server_help: '' })),
}));

const cfg = { ...testConfig, active_model: 'models/a.gguf', runtime_defaults: [] };
function mount(props: Partial<ModelSettingsDialogProps> = {}) {
  const onApply = props.onApply ?? vi.fn(async () => {});
  const onClose = props.onClose ?? vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return <ModelSettingsDialog open={open} initialConfig={structuredClone(cfg)} mode="default" targetLabel="Default execution"
      {...props} onApply={onApply} onClose={() => { onClose(); setOpen(false); }} />;
  }
  render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
  return { onApply, onClose };
}
function numeric(key: string) { return document.querySelector<HTMLInputElement>(`input[id$="-${key}"]`)!; }

describe('model settings editor', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('keeps numeric blur and preset edits out of persistence until apply, and discards them on cancel', async () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onApply, onClose } = mount({ initialSection: 'tuning' });
    await waitFor(() => expect(api.rtList).toHaveBeenCalled());
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.blur(numeric('ctx_size'));
    fireEvent.click(screen.getByRole('button', { name: 'Balanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('previews another model with its remembered configuration without changing the first model', async () => {
    rememberExecution({ ...cfg, active_model: 'models/b.gguf', ctx_size: 16384, chat_options: { stop: ['synthetic-stop'] } });
    const stored = localStorage.getItem('aiolm-model-execution');
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onApply } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /b.gguf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Model settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Performance & memory' }));
    expect(numeric('ctx_size').value).toBe('16384');
    fireEvent.change(numeric('ctx_size'), { target: { value: '12288' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save selection & settings' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'models/b.gguf', ctx_size: 12288 }), 'save', {});
    expect(cfg.ctx_size).toBe(4096);
    expect(localStorage.getItem('aiolm-model-execution')).toBe(stored);
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps invalid numbers and failed applies editable', async () => {
    const onApply = vi.fn(async () => { throw new Error('Synthetic save failure'); });
    mount({ initialSection: 'tuning', onApply });
    fireEvent.change(numeric('ctx_size'), { target: { value: '-' } });
    expect(screen.getByRole('button', { name: 'Save selection & settings' })).toBeDisabled();
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save selection & settings' }));
    expect(await screen.findByText('Error: Synthetic save failure')).toBeVisible();
    expect(numeric('ctx_size').value).toBe('8192');
    expect(screen.getByRole('button', { name: 'Save selection & settings' })).toBeEnabled();
  });

  it('loads a profile only into the target draft and never writes its source', async () => {
    const server = { ...defaultServerProfile(cfg), ctx_size: 12288, name: 'Synthetic server' };
    const model = defaultModelProfile(cfg);
    localStorage.setItem(MODEL_PROFILES_STORAGE_KEY, JSON.stringify({ version: 4, server: [server], model: [model], activeServerId: server.id, activeModelId: model.id, activeServerIds: {} }));
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onApply } = mount({ initialSection: 'profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save selection & settings' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ ctx_size: 12288 }), 'save', { serverProfileId: server.id });
    expect(writes).not.toHaveBeenCalled();
  });

  it('guards a profile-only selection before closing even when its tuning values are unchanged', async () => {
    const server = defaultServerProfile(cfg);
    const original = defaultModelProfile(cfg);
    const selected = { ...original, id: 'model-brief', name: 'Brief answers', system_prompt: 'Keep answers brief.' };
    localStorage.setItem(MODEL_PROFILES_STORAGE_KEY, JSON.stringify({ version: 4, server: [server], model: [original, selected], activeServerId: server.id, activeModelId: original.id, activeServerIds: {} }));
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onApply, onClose } = mount({ initialSection: 'profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Generation profile' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Generation profile' }));
    fireEvent.click(screen.getByRole('option', { name: selected.name }));
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save selection & settings' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(cfg, 'save', { modelProfileId: selected.id, systemPrompt: selected.system_prompt }));
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps benchmark-controlled fields out of presets and hides chat settings', async () => {
    const { onApply } = mount({ mode: 'benchmark', initialSection: 'tuning' });
    expect(numeric('ctx_size')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generation' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Balanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to benchmark' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ ctx_size: 4096, parallel: 0, temperature: 0.8, ngl: 99 }), 'save', {});
  });

  it('places dropdown menus inside the dialog and consumes Escape before closing the editor', async () => {
    const { onClose } = mount({ initialSection: 'runtime' });
    const select = screen.getByRole('combobox', { name: 'Runtime & GPU' });
    fireEvent.click(select);
    const list = await screen.findByRole('listbox', { name: 'Runtime & GPU' });
    expect(list.closest('dialog')).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(select, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Runtime & GPU' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  it('clears invalid raw drafts when resetting tuning and preserves cancellation isolation', () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onApply } = mount({ initialSection: 'advanced' });
    fireEvent.change(screen.getByLabelText('Extra request JSON'), { target: { value: '{' } });
    expect(screen.getByRole('button', { name: 'Save selection & settings' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Performance & memory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to runtime defaults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByLabelText('Extra request JSON')).toHaveValue('{}');
    expect(screen.getByRole('button', { name: 'Save selection & settings' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onApply).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });

  it('requires explicit shared profile save and keeps those completed saves when the target is cancelled', () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onApply } = mount({ initialSection: 'profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Generation profile' }));
    fireEvent.click(screen.getByText('Shared profile management'));
    const prompt = screen.getByLabelText('Default system prompt');
    fireEvent.change(prompt, { target: { value: 'Use short synthetic examples.' } });
    fireEvent.blur(prompt);
    expect(writes).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save selection & settings' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save shared profile' }));
    expect(JSON.parse(localStorage.getItem(MODEL_PROFILES_STORAGE_KEY)!).model[0].system_prompt).toBe('Use short synthetic examples.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(MODEL_PROFILES_STORAGE_KEY)!).model[0].system_prompt).toBe('Use short synthetic examples.');
  });

  it('reports shared profile storage failures without discarding the prompt edit', () => {
    mount({ initialSection: 'profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Generation profile' }));
    fireEvent.click(screen.getByText('Shared profile management'));
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Keep this draft.' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota limit'); });
    fireEvent.click(screen.getByRole('button', { name: 'Save shared profile' }));
    expect(screen.getByText('Error: Synthetic quota limit')).toBeVisible();
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Keep this draft.');
    expect(screen.getByRole('button', { name: 'Save selection & settings' })).toBeDisabled();
  });

  it('distinguishes next-request apply from settings that need the running server restarted', () => {
    mount({ initialSection: 'sampling', liveState: 'running', liveConfig: cfg });
    fireEvent.change(numeric('temperature'), { target: { value: '0.9' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Apply & restart' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Performance & memory' }));
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    expect(screen.getByRole('button', { name: 'Save for next run' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });
});
