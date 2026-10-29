import { vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { I18nProvider, type Locale } from '../shared/i18n/i18n';
import { testConfig } from './appStore';
import { ModelSettingsDialog, type ModelSettingsDialogProps } from '../features/model-settings/ModelSettingsDialog';
import { appliedProfile, mergeProfileEditor, profileLibraryConfigPatch } from '../features/model-settings/profileEditor';
import { effectiveSchema } from './effectiveSchema';

vi.mock('../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../shared/api')>(),
  providerRuntimeOptions: vi.fn(async () => []),
  providerOptionIssues: vi.fn(async () => []),
  providerOptionSchema: vi.fn(async () => effectiveSchema([])),
  runtimeHelpTarget: vi.fn(() => new Promise(() => undefined)),
  providerCatalog: async () => [{ id: 'llama.cpp', engine: 'llama.cpp', server: 'llama-server', availability: { supported: true, detail: '' }, options: [] }],
  providerRuntimes: async () => [{ id: 'b123-cpu', provider: 'llama.cpp', backend: 'cpu', build: 'b123', engine: 'llama.cpp', server: 'llama-server', version: 'b123', accelerator: 'cpu', installation: 'managed', location: 'runtime', available: true, problems: [] }],
  listModels: vi.fn(async () => ({ models: [
    { name: 'a.gguf', path: 'models/a.gguf', size_mb: 3000, is_vision: false },
    { name: 'b.gguf', path: 'models/b.gguf', size_mb: 1500, is_vision: false },
  ], truncated: false })),
  rtList: vi.fn(async () => [{ backend: 'cpu', build: 'b123', dir: 'runtime', size_mb: 30 }]),
  deviceProfile: vi.fn(async () => ({ profile: { gpus: [] }, backends: [] })),
  rtProbe: vi.fn(async () => ({ backend: 'cpu', build: 'b123', devices: [], diagnostics: [], flags: [], state: 'available', server_help: '' })),
  modelMetadata: vi.fn(async () => ({})),
  estimateModelResources: vi.fn(async () => ({ vram_bytes: 0, ram_offload_bytes: 2 * 1024 ** 3, ssd_offload_bytes: 0,
    required_vram_bytes: 0, host_memory_bytes: 512 * 1024 ** 2, vram_capacity_bytes: null, ram_capacity_bytes: null,
    disk_bytes: 3 * 1024 ** 3, disk_complete: true, model_bytes: 3 * 1024 ** 3, auxiliary_bytes: 0, kv_bytes: null, notes: ['approximate'] })),
}));

const cfg = { ...testConfig, active_model: 'models/a.gguf', runtime_defaults: [] };
function mount(props: Partial<ModelSettingsDialogProps> = {}, locale: Locale = 'en') {
  const onApply = props.onApply ?? vi.fn(async () => {});
  const onClose = props.onClose ?? vi.fn();
  let persisted = structuredClone(props.initialConfig ?? cfg);
  const onProfileCommit = props.onProfileCommit ?? vi.fn(async (draft, edit, applyTarget) => {
    persisted = applyTarget ? { ...draft, settings_profiles: mergeProfileEditor(persisted, edit, 'default') } : { ...persisted, ...profileLibraryConfigPatch(persisted, edit) };
    return { config: persisted, application: appliedProfile(persisted)! };
  });
  const onReloadProfile = props.onReloadProfile ?? vi.fn(async () => ({ config: persisted, application: appliedProfile(persisted)! }));
  function Harness() {
    const [open, setOpen] = useState(true);
    return <ModelSettingsDialog open={open} initialConfig={structuredClone(cfg)} mode="default" targetLabel="Default execution" initialSection="model"
      {...props} onProfileCommit={onProfileCommit} onReloadProfile={onReloadProfile} onApply={onApply} onClose={() => { onClose(); setOpen(false); }} />;
  }
  render(<I18nProvider initialLocale={locale}><Harness /></I18nProvider>);
  return { onApply, onClose, onProfileCommit, onReloadProfile, getSaved: () => persisted };
}
function rawChat() {
  const direct = screen.getByRole('button', { name: 'Enter arguments directly', hidden: true });
  if (direct.getAttribute('aria-pressed') !== 'true') fireEvent.click(direct);
  return screen.getByLabelText('Extra request JSON');
}
function numeric(key: string) { return document.querySelector<HTMLInputElement>(`input[id$="-${key}"]`)!; }
function openOptions() {
  const runtimeNext = screen.queryByRole('button', { name: 'Continue to profile' });
  if (runtimeNext) fireEvent.click(runtimeNext);
  const profileNext = screen.queryByRole('button', { name: 'Use this profile and adjust options' });
  if (profileNext) fireEvent.click(profileNext);
}

// Every test file gets isolated module state and the same production-shaped fixture.

export { cfg, mount, rawChat, numeric, openOptions };
