import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { I18nProvider, type Locale } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { ModelSettingsDialog, type ModelSettingsDialogProps } from './ModelSettingsDialog';
import { rememberExecution } from '../models/modelExecutionState';
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';
import * as api from '../../shared/api';
import { appliedProfile, mergeProfileEditor, profileLibraryConfigPatch, SettingsDeliveryError } from './profileEditor';
import { describeLaunchFailure, profileStatusCopy } from './profileStatusCopy';
import { resetProfileOptions, resetProfileSettings } from './profileResetState';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import { ORDER_KEY } from '../runtimes/optionOrder';
import { registerTask, removeTask } from '../../shared/state/taskRegistry';
import { LocalTaskCancelButton, TaskCancellationProvider } from '../../shared/ui/TaskCancellation';
import TaskStrip from '../../shared/ui/TaskStrip';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
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

// These flows render every settings section; shared CI runners need time for DOM queries and saves.
describe('model settings editor', { timeout: 45000 }, () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  it('keeps profile-library preparation bounded while editing a model option with many saved profiles', () => {
    const base = captureProfile(cfg, 'Saved settings', 'global', 'Keep these instructions');
    const entries = [defaultSettingsProfile(), ...Array.from({ length: 64 }, (_, index) => ({
      ...base, id: `saved-${index}`, name: `Saved settings ${index}`,
    }))];
    const library = { ...emptyProfileLibrary(), entries };
    const before = structuredClone(library);
    mount({ initialSection: 'tuning', initialConfig: { ...cfg, settings_profiles: library } });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    const libraryCopies = clone.mock.calls.filter(([value]) =>
      value && typeof value === 'object' && 'entries' in value && Array.isArray(value.entries) && value.entries.length >= entries.length);
    expect(libraryCopies).toHaveLength(0);
    expect(numeric('ctx_size')).toHaveValue(8192);
    expect(library).toEqual(before);
  });
  it('guides ordinary entry through runtime and profile before exposing option editors', async () => {
    const { onApply, onProfileCommit } = mount({ initialSection: undefined });
    expect(screen.getByRole('heading', { name: 'Choose runtime' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Settings profiles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to profile' }));
    expect(screen.getByRole('heading', { name: 'Choose profile' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Settings profiles' })).not.toBeInTheDocument();
    expect(document.querySelector('.settings-profile-chips')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Runtime' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use this profile and adjust options' }));
    expect(screen.getByRole('heading', { name: 'Adjust options' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Model' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Runtime' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Settings profiles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Profiles' })).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
  });
  it('requires a runtime selection before profile or option navigation', () => {
    const onManageRuntimes = vi.fn();
    mount({ initialConfig: { ...cfg, active_backend: '', active_build: '' }, initialSection: 'advanced', onManageRuntimes });
    expect(screen.getByRole('heading', { name: 'Choose runtime' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue to profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Choose profile/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Adjust options/ })).toBeDisabled();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage runtimes' }));
    expect(onManageRuntimes).toHaveBeenCalledWith(expect.objectContaining({ active_backend: '', active_build: '' }));
  });

  it('shares cancellation with the inline runtime manager and restores it when that retained manager is hidden', async () => {
    const cancel = vi.fn();
    const commit = vi.fn(); const reload = vi.fn();
    registerTask({ id: 'runtime-adapter-registration', kind: 'runtime', label: 'Synthetic registration', interruptible: true, cancel });
    try {
      render(<I18nProvider initialLocale="en"><TaskCancellationProvider><TaskStrip /><ModelSettingsDialog open initialConfig={cfg}
        mode="default" targetLabel="Synthetic execution" onApply={vi.fn()} onClose={vi.fn()} onProfileCommit={commit} onReloadProfile={reload}
        renderRuntimeManager={() => <LocalTaskCancelButton taskId="runtime-adapter-registration" onClick={cancel}>Cancel registration</LocalTaskCancelButton>} />
      </TaskCancellationProvider></I18nProvider>);
      const strip = () => within(screen.getByRole('complementary', { name: 'Background tasks' }));
      expect(strip().getByRole('button', { name: 'Cancel' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Manage runtimes' }));
      expect(await screen.findByRole('button', { name: 'Cancel registration' })).toBeVisible();
      await waitFor(() => expect(strip().queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Back to runtime' }));
      await waitFor(() => expect(strip().getByRole('button', { name: 'Cancel' })).toBeEnabled());
      expect(screen.queryByRole('button', { name: 'Cancel registration' })).not.toBeInTheDocument();
      fireEvent.click(strip().getByRole('button', { name: 'Cancel' }));
      expect(cancel).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
    } finally { act(() => removeTask('runtime-adapter-registration')); }
  });
  it('manages runtimes inside the same modal, retains both drafts and waits for active operations', async () => {
    const inventory = vi.spyOn(api, 'providerRuntimes');
    const onManageRuntimes = vi.fn();
    function Manager({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
      return <div><input aria-label="Registration draft" defaultValue="" />
        <button type="button" onClick={() => onBusyChange(true)}>Begin operation</button>
        <button type="button" onClick={() => { inventory.mockResolvedValue([
          { id: 'b123-cpu', provider: 'llama.cpp', backend: 'cpu', build: 'b123', engine: 'llama.cpp', server: 'llama-server', accelerator: 'cpu', installation: 'managed', location: 'synthetic', available: true, problems: [] },
          { id: 'b456-cpu', provider: 'llama.cpp', backend: 'cpu', build: 'b456', engine: 'llama.cpp', server: 'llama-server', accelerator: 'cpu', installation: 'managed', location: 'synthetic', available: true, problems: [] },
        ]); onBusyChange(false); }}>Finish operation</button></div>;
    }
    const { onClose, onApply, onProfileCommit } = mount({ initialSection: 'tuning', onManageRuntimes,
      renderRuntimeManager: ({ onBusyChange }) => <Manager onBusyChange={onBusyChange} /> });
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.blur(numeric('ctx_size'));
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    const modal = screen.getByRole('dialog', { name: 'Model & settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage runtimes' }));
    expect(screen.getByRole('dialog', { name: 'Manage runtimes' })).toBe(modal);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    const registration = screen.getByLabelText('Registration draft');
    registration.focus();
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(registration).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Registration draft'), { target: { value: 'Unsaved entry point' } });
    fireEvent.click(screen.getByRole('button', { name: 'Begin operation' }));
    expect(screen.getByRole('button', { name: 'Back to runtime' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent(modal, new Event('cancel', { cancelable: true }));
    expect(screen.getByLabelText('Registration draft')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Finish operation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to runtime' }));
    expect(await screen.findByRole('radio', { name: /^b456/ })).toBeVisible();
    expect(screen.getByRole('radio', { name: /^b123/ })).toBeChecked();
    openOptions();
    expect(numeric('ctx_size')).toHaveValue(8192);
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage runtimes' }));
    expect(screen.getByLabelText('Registration draft')).toHaveValue('Unsaved entry point');
    fireEvent(modal, new Event('cancel', { cancelable: true }));
    expect(screen.getByRole('heading', { name: 'Choose runtime' })).toBeVisible();
    expect(onManageRuntimes).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
  });
  it('keeps the option draft on backward navigation and confirms before replacing it with another profile', async () => {
    const alternate = captureProfile({ ...cfg, ctx_size: 12288 }, 'Alternate settings', 'global', '');
    const { onProfileCommit } = mount({ initialSection: 'tuning', initialConfig: { ...cfg,
      settings_profiles: { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), alternate] } } });
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.blur(numeric('ctx_size'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to profile' }));
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Alternate settings' }));
    expect(screen.getByRole('button', { name: 'Use this profile and adjust options' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Select this profile' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeVisible();
    expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Adjust options/ }));
    expect(numeric('ctx_size')).toHaveValue(8192);
    expect(numeric('ctx_size')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Back to profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alternate settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select this profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument());
    openOptions();
    expect(numeric('ctx_size')).toHaveValue(12288);
    expect(screen.queryByRole('combobox', { name: 'Settings profiles' })).not.toBeInTheDocument();
  });
  it('focuses the new stage heading and exposes the current stage to assistive technology', async () => {
    mount({ initialSection: undefined });
    expect(screen.getByRole('button', { name: /^Choose runtime/ })).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to profile' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Choose profile' })).toHaveFocus());
    expect(screen.getByRole('button', { name: /^Choose profile/ })).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'Use this profile and adjust options' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Adjust options' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Choose runtime' })).toHaveFocus());
  });
  it('shows only the chosen external engine profiles and reconfirms after changing runtime builds', async () => {
    const provider = 'custom.new-engine';
    const selected: api.AppConfig = { ...cfg, active_provider: provider, active_runtime: 'build-one' };
    const own = captureProfile(selected, 'New engine profile', 'global', '');
    const other = captureProfile(cfg, 'Other engine profile', 'global', '');
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: 'New engine', server: 'openai-v1', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue(['build-one', 'build-two'].map(id => ({
      id, provider, engine: 'New engine', server: 'openai-v1', accelerator: 'synthetic', installation: 'external', location: 'synthetic', available: true, problems: [],
    })));
    const { onApply, onProfileCommit } = mount({ initialSection: undefined, initialConfig: { ...selected,
      settings_profiles: { ...emptyProfileLibrary(), entries: [own, other] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to profile' }));
    expect(screen.getByRole('button', { name: /^New engine profile/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Other engine profile/ })).not.toBeInTheDocument();
    openOptions();
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Choose runtime' })).toHaveFocus());
    await screen.findByRole('radio', { name: /^build-two · synthetic · Registered installation/ });
    expect(screen.getByRole('radio', { name: /^build-two/ })).toBeEnabled();
    // Use the latest inventory after the asynchronous refresh.
    fireEvent.click(screen.getByRole('radio', { name: /^build-two · synthetic · Registered installation/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /^build-two/ })).toBeChecked());
    expect(screen.getByRole('button', { name: /^Choose profile/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Adjust options/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /^build-one · synthetic · Registered installation/ }));
    expect(screen.getByRole('button', { name: /^Adjust options/ })).toBeDisabled();
    openOptions();
    expect(screen.getByRole('heading', { name: 'Adjust options' })).toBeVisible();
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
  });
  it('does not steal focus from a control used before the stage focus frame', async () => {
    mount({ initialSection: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to profile' }));
    const picker = document.querySelector<HTMLButtonElement>('.settings-profile-chip')!;
    picker.focus();
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(picker).toHaveFocus();
  });
  it('shows external schema options together without assuming performance or reasoning categories', async () => {
    const provider = 'custom.unfamiliar';
    const options = [
      schemaOption({ key: 'fresh-cache', flag: '--fresh-cache', target: 'launch', group: 'memory', kind: { type: 'integer' } }),
      schemaOption({ key: 'fresh-policy', flag: '--fresh-policy', target: 'launch', group: 'engine-specific', kind: { type: 'text' } }),
      schemaOption({ key: 'fresh-budget', flag: '--fresh-budget', target: 'launch', group: 'reasoning', kind: { type: 'integer' } }),
    ];
    vi.mocked(api.providerOptionSchema).mockResolvedValueOnce(effectiveSchema([], options));
    vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
    mount({ initialConfig: { ...cfg, active_provider: provider, active_runtime: 'specific-build' }, initialSection: 'reasoning' });
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Model', 'Runtime options', 'Conversation instructions']);
    const tab = screen.getByRole('tab', { name: 'Runtime options' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tab.id);
    for (const flag of ['--fresh-cache', '--fresh-policy', '--fresh-budget']) expect(await screen.findByLabelText(new RegExp(`^${flag}`))).toBeVisible();
    expect(screen.queryByLabelText('Default system prompt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Conversation instructions' }));
    expect(screen.getByLabelText('Default system prompt')).toBeVisible();
    expect(screen.getByText(/AioLM conversation instructions/)).toBeVisible();
  });
  it('opens external runtime setup at selection and keeps runtime management beside the selectors', async () => {
    const onManageRuntimes = vi.fn();
    mount({ initialConfig: { ...cfg, active_provider: 'custom.unfamiliar', active_runtime: 'specific-build' }, initialSection: 'setup', onManageRuntimes });
    expect(screen.queryByRole('tab', { name: 'Runtime connection' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose runtime' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    const context = document.querySelector<HTMLElement>('.model-settings-runtime-selection')!;
    fireEvent.click(within(context).getByRole('button', { name: 'Manage runtimes' }));
    expect(onManageRuntimes).toHaveBeenCalledWith(expect.objectContaining({ active_provider: 'custom.unfamiliar', active_runtime: 'specific-build' }));
  });
  it('offers an external unknown model to launch validation without claiming compatibility', async () => {
    const provider = 'custom.unfamiliar';
    const candidate: api.GgufModel = { name: 'Unverified family model', path: 'models/unverified.gguf', size_mb: 1, is_vision: false,
      compatibility: [{ provider, status: 'unknown' as const, tasks: [], modalities: { text: false, image: false, audio: false, video: false },
        reasons: [], limitations: [], readiness: [], evidence: 'adapter-manifest' }] };
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: 'Unfamiliar engine', server: 'openai-v1', options: [], availability: { supported: true, detail: '' } }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([{ id: 'specific-build', provider, engine: 'Unfamiliar engine', server: 'openai-v1', accelerator: 'unverified', installation: 'external', location: 'synthetic', available: true, problems: [] }]);
    vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
    const onApply = vi.fn(async () => { throw new Error('This installed engine cannot load this model.'); });
    vi.mocked(api.listModels).mockResolvedValueOnce({ models: [candidate], truncated: false });
    const { onClose } = mount({ initialConfig: { ...cfg, active_model: '', active_provider: provider, active_runtime: 'specific-build' }, initialSection: 'model', onApply });
    const row = await screen.findByRole('button', { name: /Unverified family model/ });
    expect(api.modelLoadable(candidate, provider)).toBe(false);
    fireEvent.click(row);
    const start = screen.getByRole('button', { name: 'Save profile & start' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_provider: provider, active_runtime: 'specific-build', active_model: candidate.path }), 'start', expect.anything()));
    expect(await screen.findByText(/This installed engine cannot load this model/)).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('keeps the first save-as click available when a checked runtime option loses focus', async () => {
    const option = schemaOption({ key: 'fresh-label', flag: '--fresh-label', target: 'launch', group: 'advanced', kind: { type: 'text' } });
    vi.mocked(api.providerOptionSchema).mockResolvedValueOnce(effectiveSchema([], [option]));
    const check = vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
    const { onProfileCommit } = mount({ initialSection: 'advanced' });
    const field = await screen.findByLabelText(/^--fresh-label/);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'quoted "label" ; & 공백' } });
    const saveAs = screen.getByRole('button', { name: 'Save as new' });
    await waitFor(() => expect(saveAs).toBeEnabled());
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({
      provider_options: expect.objectContaining({ 'llama.cpp': expect.objectContaining({ 'fresh-label': 'quoted "label" ; & 공백' }) }),
    }));
    const checksBeforeBlur = check.mock.calls.length;
    // A real pointer activation blurs the input between mouse down and click.
    fireEvent.mouseDown(saveAs);
    fireEvent.blur(field);
    fireEvent.mouseUp(saveAs);
    fireEvent.click(saveAs);
    expect(screen.getByLabelText('Profile name')).toBeVisible();
    expect(screen.queryByText('Checking runtime options…')).not.toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(checksBeforeBlur);
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Fresh runtime options' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create new profile' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    expect(onProfileCommit).toHaveBeenCalledWith(expect.objectContaining({
      provider_options: expect.objectContaining({ 'llama.cpp': expect.objectContaining({ 'fresh-label': 'quoted "label" ; & 공백' }) }),
    }), expect.anything(), true);
  });
  it.each(['vllm', 'mlx-vlm'] as const)('keeps an unedited %s profile clean and blocks saving while its option check is pending', async provider => {
    let finish!: (issues: Awaited<ReturnType<typeof api.providerOptionIssues>>) => void;
    vi.spyOn(api, 'providerOptionIssues').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: provider, server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimeOptions').mockResolvedValue([]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([{ id: 'synthetic', provider, engine: provider, server: 'synthetic', accelerator: 'synthetic', installation: 'external', location: 'runtime', available: true, problems: [] }]);
    const { onClose, onProfileCommit, onApply } = mount({ initialConfig: { ...cfg, active_provider: provider, active_runtime: 'synthetic', provider_options: {} }, initialSection: 'sampling' });
    await waitFor(() => expect(api.providerOptionIssues).toHaveBeenCalled());
    expect(screen.getByText('Checking runtime options…')).toBeVisible();
    expect(screen.queryByText(/Correct invalid fields/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unsaved changes/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
    await act(async () => { finish([]); });
  });
  it('previews and applies a common profile from the single list before selecting a primary model', async () => {
    const initialConfig = { ...cfg, active_model: '', settings_profiles: undefined };
    const first = { ...captureProfile(initialConfig, 'Initial setup', 'global', ''), id: 'initial-setup' };
    const selected = { ...captureProfile({ ...initialConfig, temperature: 0.3 }, 'Selected setup', 'global', ''), id: 'selected-setup' };
    const library = { ...emptyProfileLibrary(), entries: [first, selected], default_profile_id: first.id, legacy_imported: true };
    const { onProfileCommit } = mount({ initialConfig: { ...initialConfig, settings_profiles: library }, initialSection: 'profiles' });
    expect(screen.queryByRole('combobox', { name: 'Settings profiles' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Selected setup' }));
    expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select this profile' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalled());
    expect(onProfileCommit).toHaveBeenCalledWith(expect.objectContaining({ active_model: '', temperature: 0.3 }), expect.anything(), true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Selected setup · Selected' })).toBeVisible());
  });

  it('offers GGUF language models as llama draft companions and excludes snapshot directories', async () => {
    vi.mocked(api.listModels).mockResolvedValueOnce({ models: [
      { name: 'language.gguf', path: 'models/language.gguf', size_mb: 1, is_vision: false },
      { name: 'Snapshot model', path: 'models/snapshot', size_mb: 1, is_vision: false },
      { name: 'mmproj.gguf', path: 'models/mmproj.gguf', size_mb: 1, is_vision: true },
    ], truncated: false });
    mount({ initialSection: 'adapters' });
    await waitFor(() => expect(api.listModels).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('combobox', { name: 'Draft model' }));
    expect(screen.getByRole('option', { name: 'language.gguf' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Snapshot model' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'mmproj.gguf' })).not.toBeInTheDocument();
  });

  it('edits each companion model once, retaining arbitrary Unicode paths in the saved profile', async () => {
    const { onProfileCommit } = mount({ initialSection: 'adapters' });
    const projector = screen.getByRole('combobox', { name: 'Vision projector' });
    const draft = screen.getByRole('combobox', { name: 'Draft model' });
    expect(screen.queryByRole('textbox', { name: /Draft model|projector/i })).not.toBeInTheDocument();
    expect(document.querySelector('input[id$="-spec-draft-model"]')).not.toBeInTheDocument();
    expect(document.querySelector('input[id$="-spec-draft-device"]')).not.toBeInTheDocument();
    fireEvent.change(projector, { target: { value: 'models/별도 폴더/projector.gguf' } });
    fireEvent.change(draft, { target: { value: 'models/별도 폴더/draft.gguf' } });
    expect(draft).toHaveValue('models/별도 폴더/draft.gguf');
    const save = screen.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save); fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledWith(expect.objectContaining({
      mmproj: 'models/별도 폴더/projector.gguf', spec_draft_model: 'models/별도 폴더/draft.gguf',
    }), expect.anything(), true));
  });

  it('keeps one broad reset and one llama command importer while preserving field reset', async () => {
    mount({ initialSection: 'tuning' });
    expect(screen.getAllByRole('button', { name: 'Reset options to defaults' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Reset to runtime defaults' })).not.toBeInTheDocument();
    const fieldReset = document.querySelector<HTMLButtonElement>('[data-default-field="ctx_size"] button')!;
    expect(fieldReset).toBeEnabled();
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.click(fieldReset);
    expect(numeric('ctx_size')).toHaveValue(4096);
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(screen.queryByRole('button', { name: 'Import command' })).not.toBeInTheDocument();
    const paste = document.querySelector<HTMLTextAreaElement>('#model-settings-paste')!;
    expect(paste).toBeVisible();
    fireEvent.change(paste, { target: { value: 'llama-server --ctx-size 8192 --temp 0.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply pasted settings' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Performance & memory' }));
    expect(numeric('ctx_size')).toHaveValue(8192);
    fireEvent.click(screen.getByRole('tab', { name: 'Generation' }));
    expect(numeric('temperature')).toHaveValue(0.4);
  });

  it('keeps native Windows path prefixes when choosing a catalog companion while displaying a readable path', async () => {
    const path = String.raw`\\?\C:\Synthetic Models\한글 draft.gguf`;
    vi.mocked(api.listModels).mockResolvedValueOnce({ models: [{ name: 'Catalog draft', path, size_mb: 1, is_vision: false }], truncated: false });
    const { onProfileCommit } = mount({ initialSection: 'adapters' });
    await waitFor(() => expect(api.listModels).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('combobox', { name: 'Draft model' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Catalog draft' }));
    const input = screen.getByRole('combobox', { name: 'Draft model' });
    expect(input).toHaveValue(String.raw`C:\Synthetic Models\한글 draft.gguf`);
    // A no-op edit must not replace the native access path with its display form.
    fireEvent.change(input, { target: { value: String.raw`C:\Synthetic Models\한글 draft.gguf` } });
    const save = screen.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save); fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledWith(expect.objectContaining({ spec_draft_model: path }), expect.anything(), true));
  });

  it.each(['unsupported', 'readiness'] as const)('keeps a saved model visible and blocks launch for a newly selected runtime %s failure', async failure => {
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: 'vllm', engine: 'vllm', server: 'vllm', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue(['wide', 'narrow'].map(id => ({
      id, provider: 'vllm' as const, engine: 'vllm', server: 'vllm', accelerator: 'synthetic',
      installation: 'external', location: 'synthetic-runtime', available: true, problems: [],
    })));
    const scan: typeof api.listModels = async (_directory, _scan, selection) => ({ models: [{
      name: 'Saved snapshot', path: 'models/snapshot', size_mb: 1, is_vision: false,
      compatibility: [{ provider: 'vllm', status: selection?.runtime === 'narrow' && failure === 'unsupported' ? 'unsupported' : 'supported',
        tasks: ['generate'], modalities: { text: true, image: false, audio: false, video: false },
        limitations: [], readiness: selection?.runtime === 'narrow' && failure === 'readiness' ? ['Selected runtime cannot load this snapshot.'] : [], evidence: 'runtime-probe',
        reasons: selection?.runtime === 'narrow' && failure === 'unsupported' ? [{ code: 'architecture-not-registered', detail: 'Selected runtime cannot load this snapshot.' }] : [],
      }],
    }], truncated: false });
    vi.mocked(api.listModels).mockImplementationOnce(scan).mockImplementationOnce(scan);
    const { onApply } = mount({ initialConfig: { ...cfg, active_provider: 'vllm', active_runtime: 'wide', active_model: 'models/snapshot' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^narrow · synthetic · Registered installation/ }));
    expect(screen.getByRole('button', { name: /^Adjust options/ })).toBeDisabled();
    openOptions();
    await waitFor(() => expect(screen.getByText(/Selected runtime cannot load this snapshot/)).toBeVisible());
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Model path' })).toHaveValue('models/snapshot');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile & start' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('restores unsaved system prompts independently when switching inference engines', async () => {
    vi.spyOn(api, 'providerCatalog').mockResolvedValue(['llama.cpp', 'vllm', 'mlx-vlm'].map(id => ({ id: id as api.ProviderId,
      engine: id, server: 'synthetic-server', availability: { supported: true, detail: '' }, options: [] })));
    vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([
      { id: 'b123-cpu', provider: 'llama.cpp', backend: 'cpu', build: 'b123', engine: 'llama.cpp', server: 'llama-server', accelerator: 'cpu', installation: 'managed', location: 'synthetic', available: true, problems: [] },
      { id: 'synthetic', provider: 'vllm', engine: 'vllm', server: 'synthetic', accelerator: 'synthetic', installation: 'external', location: 'synthetic', available: true, problems: [] },
    ]);
    mount({ initialSection: 'sampling' });
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Unsaved llama prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^vLLM/ }));
    expect(screen.getByRole('button', { name: 'Continue to profile' })).toBeDisabled();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('radio', { name: /^synthetic · synthetic · Registered installation/ }));
    openOptions();
    await waitFor(() => expect(screen.getByLabelText('Default system prompt')).toHaveValue(''));
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Unsaved vLLM prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^llama\.cpp/ }));
    openOptions();
    await waitFor(() => expect(screen.getByLabelText('Default system prompt')).toHaveValue('Unsaved llama prompt'));
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^vLLM/ }));
    openOptions();
    await waitFor(() => expect(screen.getByLabelText('Default system prompt')).toHaveValue('Unsaved vLLM prompt'));
  });

  it.each(['vllm', 'mlx-vlm'] as const)('reports only the selected %s runtime inputs for a multimodal snapshot', async provider => {
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: provider, server: 'synthetic-server', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([{ id: 'synthetic-runtime', provider, engine: provider, server: 'synthetic-server', accelerator: 'synthetic', installation: 'external', location: 'synthetic-runtime', available: true, problems: [] }]);
    vi.mocked(api.listModels).mockResolvedValueOnce({ models: [{
      name: 'Multimodal snapshot', path: 'models/snapshot', size_mb: 1, is_vision: false,
      artifact: { name: 'Multimodal snapshot', path: 'models/snapshot', format: 'mlx', role: 'model', size_bytes: 1024, file_count: 2,
        architectures: ['SyntheticVisionModel'], modalities: { text: true, image: true, audio: true, video: true }, missing: [], incomplete: false, ownership: 'external', notes: [] },
      compatibility: [{ provider, status: 'partial', tasks: ['generate'], modalities: { text: true, image: true, audio: false, video: false },
        limitations: ['Native audio and video are unavailable.'], readiness: [], reasons: [], evidence: 'synthetic-runtime-probe' }],
    }], truncated: false });
    mount({ initialConfig: { ...cfg, active_provider: provider, active_runtime: 'synthetic-runtime', active_model: 'models/snapshot' } });
    await waitFor(() => expect(screen.getByText('Supported inputs: text, image')).toBeVisible());
    expect(document.querySelector('.model-settings-footer-bar')).not.toHaveTextContent(/audio|video/);
  });

  it('keeps the selected model summary compact and exposes all metadata without changing settings', async () => {
    vi.mocked(api.modelMetadata).mockResolvedValueOnce({ architecture: 'future-architecture', author: 'Synthetic Author',
      context_length: 32768, tags: ['reasoning', 'base_model:original/long-model-name', 'license:apache-2.0'] });
    const { onApply, onProfileCommit } = mount({ initialSection: 'model' });
    const summary = await screen.findByText(/All model information/);
    const disclosure = summary.closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(within(disclosure).getByText('original/long-model-name')).not.toBeVisible();
    fireEvent.click(summary);
    expect(within(disclosure).getByText('original/long-model-name')).toBeVisible();
    expect(within(disclosure).getByText('Synthetic Author')).toBeVisible();
    expect(within(disclosure).getByText('apache-2.0')).toBeVisible();
    expect(onApply).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled();
  });

  it('refreshes resource estimates as execution settings change before applying them', async () => {
    const { onApply, onProfileCommit } = mount({ initialSection: 'tuning' });
    await waitFor(() => expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB'));
    expect(screen.getByTestId('resource-disk')).toHaveTextContent('0 B');
    numeric('ctx_size').focus();
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    await waitFor(() => expect(api.estimateModelResources).toHaveBeenLastCalledWith(expect.objectContaining({ ctx_size: 8192 }), expect.any(Array)));
    // Refreshed estimates must not take focus or input away from the edited control.
    await waitFor(() => expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB'));
    expect(numeric('ctx_size')).toHaveFocus();
    expect(numeric('ctx_size')).toHaveValue(8192);
    fireEvent.change(numeric('ngl'), { target: { value: '25' } });
    await waitFor(() => expect(api.estimateModelResources).toHaveBeenLastCalledWith(expect.objectContaining({ ngl: 25, ctx_size: 8192 }), expect.any(Array)));
    expect(onApply).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled();
  });

  it('focuses its heading after opening unless focus already moved to a control', async () => {
    const nextFrame = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    mount({ initialSection: 'tuning' });
    await nextFrame();
    expect(screen.getByRole('heading', { name: 'Model & settings' })).toHaveFocus();
    cleanup();
    mount({ initialSection: 'tuning' });
    // A control focused before the opening frame keeps its focus.
    numeric('ctx_size').focus();
    await nextFrame();
    expect(numeric('ctx_size')).toHaveFocus();
  });

  it.each(['default', 'session', 'benchmark', 'project'] as const)('saves edited options into the named selected profile from the %s target', async mode => {
    const source = captureProfile(cfg, 'Selected profile', 'global', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', source);
    const { onApply, onProfileCommit, onClose, getSaved } = mount({ mode, initialSection: 'tuning', initialConfig: { ...cfg,
      settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(numeric('ngl'), { target: { value: '25' } });
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toHaveAccessibleDescription('Save to: Selected profile');
    fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Selected profile' })).toBeVisible());
    const [next, edit, applyTarget] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(applyTarget).toBe(true);
    expect(next.ngl).toBe(25);
    expect(edit.application.profile_id).toBe(source.id);
    expect(edit.library.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(1);
    expect(edit.library.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ id: source.id, name: source.name, settings: { ngl: 25 } });
    expect(getSaved().settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ id: source.id, settings: { ngl: 25 } });
    expect(screen.getByRole('dialog', { name: 'Model & settings' })).toBeVisible();
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'Save profile', 'Save to: Selected profile'], ['ko', '프로필 저장', '저장 대상: Selected profile'],
    ['ja', 'プロファイルを保存', '保存先: Selected profile'], ['zh', '保存预设', '保存到: Selected profile'],
  ] as const)('names the existing profile save target in %s', (locale, label, description) => {
    const source = captureProfile(cfg, 'Selected profile', 'model', '');
    const application = materializeProfileApplication(cfg, '', source);
    mount({ initialConfig: { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [source],
      applied: { [profileTargetKey(cfg.active_model)]: application } } } }, locale);
    expect(screen.getByRole('button', { name: label })).toHaveAccessibleDescription(description);
  });

  it('keeps the editor open across repeated saves to the same profile and closes without discarding saved values', async () => {
    const source = captureProfile(cfg, 'Editable profile', 'global', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', source);
    const { onApply, onProfileCommit, onClose, getSaved } = mount({ initialSection: 'tuning', initialConfig: { ...cfg,
      settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Editable profile' })).toBeVisible());
    expect(getSaved().settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([expect.objectContaining({ id: source.id, revision: source.revision + 1, settings: expect.objectContaining({ ctx_size: 8192 }) })]);
    expect(screen.getByRole('tab', { name: 'Performance & memory' })).toHaveAttribute('aria-selected', 'true');
    expect(numeric('ctx_size')).toHaveValue(8192);

    fireEvent.change(numeric('ctx_size'), { target: { value: '12288' } });
    expect(screen.getByRole('heading', { name: 'Editable profile · Editing' })).toBeVisible();
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    expect(screen.getByRole('heading', { name: 'Editable profile' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Generation' }));
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Updated prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Editable profile' })).toBeVisible());
    expect(onProfileCommit).toHaveBeenCalledTimes(2);
    expect(getSaved().settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([expect.objectContaining({ id: source.id, revision: source.revision + 2, system_prompt: 'Updated prompt', settings: expect.objectContaining({ ctx_size: 8192 }) })]);
    expect(appliedProfile(getSaved())).toMatchObject({ profile_id: source.id, profile_revision: source.revision + 2, system_prompt: 'Updated prompt' });
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Model & settings' })).not.toBeInTheDocument();
  });

  it('offers reset and save in the profile selection detail and keeps them in option editing', () => {
    mount({ initialSection: 'profiles' });
    const current = within(screen.getByRole('region', { name: 'Current values' }));
    expect(current.getByRole('button', { name: 'Save profile' })).toBeVisible();
    expect(current.getByRole('button', { name: 'Reset options to defaults' })).toBeVisible();
    openOptions();
    const banner = screen.getByRole('button', { name: 'Save profile' }).closest('.settings-profile-banner')!;
    expect(within(banner as HTMLElement).getAllByRole('button').map(button => button.textContent)).toEqual([
      'Reset options to defaults', 'Save profile', 'Save as new',
    ]);
  });

  it('shows only the designated default before a model is selected and protects it', () => {
    mount({ initialConfig: { ...cfg, active_model: '' }, initialSection: 'profiles' });
    expect(document.querySelectorAll('.settings-profile-chip')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Default · Selected · Default profile' }));
    const current = within(screen.getByRole('region', { name: 'Current values' }));
    expect(current.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
    expect(current.queryByRole('button', { name: 'Select this profile' })).not.toBeInTheDocument();
    expect(current.getByRole('button', { name: 'Save profile' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Preset profiles' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('keeps launch cancellation separate from closing the editor', () => {
    const onCancelStart = vi.fn();
    const { onClose } = mount({ busy: true, liveState: 'starting', onCancelStart });
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelStart).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('exposes preflight progress and cancellation before a server starts', () => {
    const onCancelStart = vi.fn();
    const { onClose } = mount({ busy: true, liveState: 'stopped', preflightState: 'checking', onCancelStart });
    expect(screen.getByText('Checking the selected engine and model…')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelStart).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports preflight cancellation while preventing repeated cancellation', () => {
    mount({ busy: true, liveState: 'stopped', preflightState: 'cancelling', onCancelStart: vi.fn() });
    expect(screen.getByText('Cancelling the engine and model check…')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('offers unloading instead of loading while the target holds a model', () => {
    // Launching again would race the process that is already up, so the footer
    // drops the start action entirely rather than leaving a dead button on it.
    const onStop = vi.fn();
    mount({ liveState: 'running', liveConfig: cfg, onStop });
    expect(screen.queryByRole('button', { name: 'Save profile & restart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save profile & start' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unload' }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('keeps the stop action visible but inert while the target is already shutting down', () => {
    mount({ liveState: 'stopping', onStop: vi.fn() });
    expect(screen.getByRole('button', { name: 'Working' })).toBeDisabled();
  });

  it('restores the launch action once nothing is running', async () => {
    mount({ liveState: 'stopped', onStop: vi.fn(), initialConfig: { ...cfg, active_backend: 'cpu', active_build: 'b123' } });
    expect(screen.queryByRole('button', { name: 'Unload' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeEnabled());
  });

  it('withholds saving onto the profile the running server was started from', () => {
    // Overwriting it would leave the profile describing settings the live
    // process is not using; editing and saving elsewhere stay available.
    const source = captureProfile(cfg, 'Selected profile', 'global', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', source);
    mount({ initialSection: 'sampling', liveState: 'running', liveConfig: cfg, onStop: vi.fn(),
      initialApplication: application, liveApplication: application,
      initialConfig: { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(numeric('temperature'), { target: { value: '0.9' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(screen.getByText('The running model was started from this profile. Stop it, or save to another profile, to change these settings.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeEnabled();
  });

  it('leaves inherited numeric and text values unchanged when navigating through their inputs', async () => {
    const { onClose, onApply } = mount({ initialSection: 'tuning', initialConfig: { ...cfg, ngl: 12, runtime_defaults: ['ngl', 'temperature', 'reasoning_budget_message'], reasoning_budget_message: 'old value' } });
    await waitFor(() => expect(api.rtList).toHaveBeenCalled());
    expect(numeric('ngl')).toHaveValue(99);
    expect(numeric('ngl')).toBeEnabled();
    fireEvent.focus(numeric('ngl')); fireEvent.blur(numeric('ngl'));
    fireEvent.pointerUp(document.querySelector('input[id$="-ngl-range"]')!);
    fireEvent.click(screen.getByRole('tab', { name: 'Generation' }));
    fireEvent.focus(numeric('temperature')); fireEvent.blur(numeric('temperature'));
    fireEvent.click(screen.getByRole('tab', { name: 'Reasoning' }));
    const message = document.querySelector<HTMLInputElement>('input[id$="-reasoning-budget-message"]')!;
    expect(message).toHaveValue('');
    fireEvent.focus(message); fireEvent.blur(message);
    expect(screen.queryByRole('button', { name: /Set custom value/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });

  it('edits and resets inherited options directly while preserving defaults for other fields', async () => {
    const { onProfileCommit } = mount({ initialSection: 'tuning', initialConfig: { ...cfg, runtime_defaults: ['ngl', 'temperature'] } });
    await waitFor(() => expect(api.rtList).toHaveBeenCalled());
    fireEvent.change(numeric('ngl'), { target: { value: '-' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Reset GPU layers.*to default/ }));
    expect(numeric('ngl')).toHaveValue(99);
    expect(numeric('ngl')).toBeEnabled();
    fireEvent.change(numeric('ngl'), { target: { value: '25' } });
    fireEvent.blur(numeric('ngl'));
    expect(screen.getAllByRole('button', { name: 'Save profile' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledWith(expect.objectContaining({ ngl: 25, runtime_defaults: ['temperature'] }), expect.objectContaining({ application: expect.objectContaining({ settings: expect.objectContaining({ ngl: 25 }) }) }), true));
  });

  it('starts with no model selected and restores the saved model settings on explicit choice', async () => {
    const saved = { ...cfg, ctx_size: 12288, mmproj: 'models/projector.gguf' };
    const { onApply } = mount({ initialConfig: saved, requireModelSelection: true });
    expect(screen.getByRole('dialog', { name: 'Model & settings' })).toBeVisible();
    expect(within(screen.getByRole('tablist', { name: 'Model & settings' })).getByRole('tab', { name: 'Runtime & GPU' })).toBeVisible();
    const first = await screen.findByRole('button', { name: /a.gguf/ });
    const second = await screen.findByRole('button', { name: /b.gguf/ });
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(second).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile & start' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_model: saved.active_model, ctx_size: 12288, mmproj: saved.mmproj }), 'start', expect.any(Object)));
    expect(saved.active_model).toBe('models/a.gguf');
  });

  it('requires a managed runtime before starting and never offers a system runtime', async () => {
    mount({ initialConfig: { ...cfg, active_backend: '', active_build: '' } });
    await waitFor(() => expect(api.rtList).toHaveBeenCalled());
    expect(screen.queryByRole('combobox', { name: 'Runtime' })).not.toBeInTheDocument();
    const options = within(screen.getByRole('group', { name: 'Runtime' })).getAllByRole('radio').map(option => option.closest('label')?.textContent ?? '');
    expect(options.some(option => option.startsWith('b123 (b123-cpu) · cpu · Installed by AioLM'))).toBe(true);
    expect(options.some(option => /system/i.test(option))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Save profile & start' })).not.toBeInTheDocument();
    expect(screen.getByText('No runtime is selected.')).toBeVisible();
    expect(screen.getByRole('radio', { name: /^b123/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue to profile' })).toBeDisabled();
  });

  it('reports a selected runtime as missing when the installed list loads empty', async () => {
    // An empty list is a real answer — nothing installed — not a list that has
    // not loaded yet, so the selected runtime must be reported as missing.
    vi.mocked(api.rtList).mockResolvedValueOnce([]);
    mount();
    expect(await screen.findByText('This runtime is not installed. Install it or select another runtime.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
  });

  it.each(['llama.cpp', 'vllm', 'mlx-vlm'] as const)('waits for the %s inventory before reporting a selected runtime as missing', async provider => {
    let finish!: () => void;
    if (provider === 'llama.cpp') {
      vi.mocked(api.rtList).mockReturnValueOnce(new Promise(resolve => {
        finish = () => resolve([{ backend: 'cpu', build: 'b123', dir: 'runtime', size_mb: 30 }]);
      }));
    } else {
      vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: provider, server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
      vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
      vi.spyOn(api, 'providerRuntimeOptions').mockResolvedValue([]);
      vi.spyOn(api, 'providerRuntimes').mockReturnValue(new Promise(resolve => {
        finish = () => resolve([{ id: 'synthetic', provider, engine: provider, server: 'synthetic', accelerator: 'synthetic', installation: 'external', location: 'runtime', available: true, problems: [] }]);
      }));
    }
    const { onApply, onProfileCommit } = mount({ initialSection: 'gpu', initialConfig: {
      ...cfg, active_provider: provider, active_runtime: provider === 'llama.cpp' ? '' : 'synthetic',
    } });
    await waitFor(() => expect(api.deviceProfile).toHaveBeenCalled());
    expect(screen.queryByText('The selected runtime is not installed. You can save these settings, but install the runtime before starting.')).not.toBeInTheDocument();
    expect(screen.queryByText('This runtime is not installed. Install it or select another runtime.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeEnabled());
    expect(screen.queryByText('The selected runtime is not installed. You can save these settings, but install the runtime before starting.')).not.toBeInTheDocument();
  });

  it.each(['vllm', 'mlx-vlm'] as const)('asks to select a %s runtime without claiming an unselected runtime is missing', async provider => {
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: provider, server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([{ id: 'synthetic', provider, engine: provider, server: 'synthetic', accelerator: 'synthetic', installation: 'external', location: 'runtime', available: true, problems: [] }]);
    vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'providerRuntimeOptions').mockResolvedValue([]);
    const { onApply, onProfileCommit } = mount({ initialSection: 'runtime', initialConfig: { ...cfg, active_provider: provider, active_runtime: '' } });
    expect(await screen.findByText('No runtime is selected.')).toBeVisible();
    await waitFor(() => expect(api.providerRuntimes).toHaveBeenCalled());
    expect(screen.queryByText('The selected runtime is not installed. You can save these settings, but install the runtime before starting.')).not.toBeInTheDocument();
    expect(screen.queryByText('This runtime is not installed. Install it or select another runtime.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to profile' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save profile & start' })).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled();
  });

  it.each(['vllm', 'mlx-vlm'] as const)('reports a missing %s runtime after its inventory successfully loads empty', async provider => {
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: provider, server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([]);
    vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'providerRuntimeOptions').mockResolvedValue([]);
    const { onApply } = mount({ initialSection: 'runtime', initialConfig: { ...cfg, active_provider: provider, active_runtime: 'synthetic' } });
    expect(await screen.findByText('The selected runtime is not installed. You can save these settings, but install the runtime before starting.')).toBeVisible();
    openOptions();
    expect(screen.getByText('This runtime is not installed. Install it or select another runtime.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile & start' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('keeps numeric edits out of persistence until apply, and discards them on cancel', async () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onApply, onClose } = mount({ initialSection: 'tuning' });
    await waitFor(() => expect(api.rtList).toHaveBeenCalled());
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.blur(numeric('ctx_size'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('cancels only the discard modal and returns focus without losing the draft', async () => {
    const { onApply, onClose } = mount({ initialSection: 'tuning' });
    await waitFor(() => expect(api.rtList).toHaveBeenCalled());
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.click(close);
    const confirmation = screen.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await waitFor(() => expect(within(confirmation).getByRole('button', { name: 'Keep editing' })).toHaveFocus());
    expect(confirmation.closest('[inert]')).toBeNull();
    fireEvent(confirmation, new Event('cancel', { bubbles: true, cancelable: true }));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Model & settings' })).toBeVisible();
    expect(numeric('ctx_size')).toHaveValue(8192);
    expect(close).toHaveFocus();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('previews another model with its remembered configuration without changing the first model', async () => {
    rememberExecution({ ...cfg, active_model: 'models/b.gguf', ctx_size: 16384, chat_options: { stop: ['synthetic-stop'] } });
    const stored = localStorage.getItem('aiolm-model-execution');
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onProfileCommit } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /b.gguf/ }));
    openOptions();
    fireEvent.click(screen.getByRole('tab', { name: 'Performance & memory' }));
    expect(numeric('ctx_size').value).toBe('16384');
    fireEvent.change(numeric('ctx_size'), { target: { value: '12288' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    expect(onProfileCommit).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'models/b.gguf', ctx_size: 12288 }), expect.any(Object), true);
    expect(cfg.ctx_size).toBe(4096);
    expect(localStorage.getItem('aiolm-model-execution')).toBe(stored);
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps invalid numbers and failed profile saves editable for retry', async () => {
    let persisted: api.AppConfig = structuredClone(cfg);
    const onProfileCommit = vi.fn<ModelSettingsDialogProps['onProfileCommit']>(async (draft, edit) => {
      persisted = { ...draft, settings_profiles: mergeProfileEditor(persisted, edit, 'default') };
      return { config: persisted, application: appliedProfile(persisted)! };
    }).mockRejectedValueOnce(new Error('Synthetic save failure'));
    const { onApply, onClose } = mount({ initialSection: 'tuning', onProfileCommit });
    fireEvent.change(numeric('ctx_size'), { target: { value: '-' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Error: Synthetic save failure')).toBeVisible();
    expect(numeric('ctx_size').value).toBe('8192');
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Recovered profile · Editing' })).toBeVisible();
    expect(persisted.ctx_size).toBe(cfg.ctx_size);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Recovered profile' })).toBeVisible());
    expect(persisted.ctx_size).toBe(8192);
    expect(screen.queryByText('Error: Synthetic save failure')).not.toBeInTheDocument();
    expect(onProfileCommit).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });


  it('previews a profile without changing editor values and applies it immediately without closing', async () => {
    const profile = captureProfile({ ...cfg, ctx_size: 12288 }, 'Synthetic profile', 'model', '');
    const { onApply, onProfileCommit, onClose, getSaved } = mount({ initialSection: 'profiles', initialConfig: { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [profile, defaultSettingsProfile()] } } });
    fireEvent.click(screen.getByRole('button', { name: profile.name }));
    expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent('12288');
    expect(numeric('ctx_size')).toHaveValue(cfg.ctx_size);
    expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('region', { name: 'Preview' })).getByRole('button', { name: 'Select this profile' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument());
    expect(getSaved().ctx_size).toBe(12288);
    expect(screen.getByRole('button', { name: 'Synthetic profile · Selected' })).toBeVisible();
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it('clears editing when options return to their initial values and can revert a later edit', async () => {
    const profile = captureProfile({ ...cfg, ctx_size: 8192 }, 'Base profile', 'model', '');
    const saved = { ...cfg, ctx_size: 12288 };
    const application = materializeProfileApplication(saved, '', profile);
    const { onReloadProfile } = mount({ initialSection: 'tuning', initialConfig: { ...saved, settings_profiles: { ...emptyProfileLibrary(), entries: [profile, defaultSettingsProfile()], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(numeric('ctx_size'), { target: { value: '16384' } });
    expect(screen.getByRole('heading', { name: 'Base profile · Editing' })).toBeVisible();
    expect(screen.getByText('Global profile · unsaved changes')).toBeVisible();
    fireEvent.change(numeric('ctx_size'), { target: { value: '12288' } });
    expect(screen.getByRole('heading', { name: 'Base profile' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
    fireEvent.change(numeric('ctx_size'), { target: { value: '16384' } });
    expect(screen.getByRole('heading', { name: 'Base profile · Editing' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(onReloadProfile).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Base profile' })).toBeVisible());
    expect(numeric('ctx_size')).toHaveValue(12288);
  });

  it('saves a new profile immediately and keeps it after closing the dialog', async () => {
    const { getSaved, onProfileCommit, onClose } = mount({ initialSection: 'sampling' });
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Use concise answers.' } });
    fireEvent.click(screen.getByText('Save as new', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Concise' } });
    await act(async () => { fireEvent.click(screen.getByText('Create new profile', { selector: 'button' })); });
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument());
    expect(getSaved().settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([expect.objectContaining({ name: 'Default' }), expect.objectContaining({ name: 'Recovered profile' }), expect.objectContaining({ name: 'Concise', system_prompt: 'Use concise answers.' })]);
    const assignment = appliedProfile(getSaved())!;
    expect(assignment.profile_id).toBe(getSaved().settings_profiles?.entries.find(profile => profile.name === 'Concise')?.id);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(getSaved().settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(3);
  });

  it('keeps invalid inputs while browsing profile previews and allows reverting the working draft', async () => {
    const { onProfileCommit } = mount({ initialSection: 'advanced' });
    fireEvent.change(rawChat(), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Default · Default profile' }));
    expect(within(screen.getByRole('region', { name: 'Preview' })).getByRole('button', { name: 'Select this profile' })).toBeDisabled();
    expect(rawChat()).toHaveValue('{');
    expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(rawChat()).toHaveValue('{}'));
  });

  it('preserves benchmark workload values and inherits the other tuning fields when applying the Default profile', async () => {
    const { onProfileCommit, getSaved } = mount({ mode: 'benchmark', initialSection: 'profiles' });
    expect(screen.queryByRole('tab', { name: 'Generation' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Default · Default profile' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Preview' })).getByRole('button', { name: 'Select this profile' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    // The Default profile owns every tuning field, so GPU layers follow its
    // runtime default while the benchmark keeps the workload values it controls.
    expect(getSaved()).toMatchObject({ ctx_size: cfg.ctx_size, temperature: cfg.temperature, parallel: cfg.parallel, ngl: tuningResetValues().ngl });
    expect(getSaved().runtime_defaults).toContain('ngl');
  });

  it('keeps failed profile saves editable without inventing a completed profile', async () => {
    const onProfileCommit = vi.fn(async () => { throw new Error('Synthetic save failure'); });
    mount({ initialSection: 'sampling', onProfileCommit });
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Keep this prompt.' } });
    fireEvent.click(screen.getByText('Save as new', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Retry me' } });
    await act(async () => { fireEvent.click(screen.getByText('Create new profile', { selector: 'button' })); });
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    expect(screen.getByText('Create new profile', { selector: 'button' })).toBeEnabled();
    expect(screen.getByLabelText('Profile name')).toHaveValue('Retry me');
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Keep this prompt.');
    expect(screen.getByRole('heading', { name: 'Recovered profile · Editing' })).toBeVisible();
  });

  it('shows existing model copies and saves the actual selected profile while another profile is previewed', async () => {
    const source = captureProfile(cfg, 'Shared settings', 'global', '');
    const copy = { ...captureProfile(cfg, source.name, 'model', ''), source_id: source.id, source_scope: 'global' as const };
    const orphan = { ...captureProfile(cfg, 'Recovered settings', 'model', ''), source_id: 'deleted-source', source_scope: 'global' as const };
    const application = materializeProfileApplication(cfg, '', copy);
    const { onProfileCommit } = mount({ initialSection: 'tuning', initialConfig: { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [source, copy, orphan], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(numeric('ngl'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    expect(document.querySelectorAll('.settings-profile-chip')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Shared settings · Selected · Editing' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Shared settings · Default profile' }));
    expect(screen.getByRole('button', { name: 'Use this profile and adjust options' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Recovered settings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Adjust options/ }));
    expect(screen.getByRole('button', { name: 'Save profile' })).toHaveAccessibleDescription('Save to: Shared settings');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const edit = vi.mocked(onProfileCommit).mock.calls[0][1];
    expect(edit.application.profile_id).toBe(copy.id);
    expect(edit.library.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').find(entry => entry.id === copy.id)?.settings.ngl).toBe(25);
    expect(edit.library.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').find(entry => entry.id === source.id)?.settings).toEqual(source.settings);
  });

  it('reloads saved target values after renaming a profile without storing the working edits', async () => {
    const profile = captureProfile(cfg, 'Saved profile', 'model', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', profile);
    const { getSaved } = mount({ initialSection: 'sampling', initialConfig: { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [profile, defaultSettingsProfile()], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Working prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Saved profile · Selected · Editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Renamed profile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Saved profile · Editing' })).not.toBeInTheDocument());
    openOptions();
    fireEvent.click(screen.getByRole('tab', { name: 'Generation' }));
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Saved prompt');
    expect(getSaved().settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ name: 'Renamed profile', system_prompt: 'Saved prompt' });
  });

  it('preserves Working profile values and invalid drafts when only the default designation changes', async () => {
    const profile = captureProfile(cfg, 'Saved profile', 'model', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', profile);
    const { getSaved, onProfileCommit } = mount({ initialSection: 'sampling', initialConfig: { ...cfg,
      settings_profiles: { ...emptyProfileLibrary(), entries: [profile, defaultSettingsProfile()],
        applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(numeric('temperature'), { target: { value: '1.3' } });
    fireEvent.blur(numeric('temperature'));
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Working prompt' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    fireEvent.change(rawChat(), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Saved profile · Selected · Editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }));
    await waitFor(() => expect(getSaved().settings_profiles?.default_profile_id).toBe(profile.id));
    expect(onProfileCommit).toHaveBeenCalledOnce();
    expect(getSaved().temperature).toBe(cfg.temperature);
    expect(appliedProfile(getSaved())).toMatchObject({ system_prompt: 'Saved prompt', settings: { temperature: cfg.temperature } });
    fireEvent.click(screen.getByRole('button', { name: /^Adjust options/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Generation' }));
    expect(numeric('temperature')).toHaveValue(1.3);
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Working prompt');
    expect(rawChat()).toHaveValue('{');
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeVisible();
  });

  it('closes a completed save form when only delivery fails and keeps the saved profile available', async () => {
    const onProfileCommit = vi.fn(async (draft, edit) => {
      const saved = { ...draft, settings_profiles: mergeProfileEditor(cfg, edit, 'default') };
      throw new SettingsDeliveryError('Synthetic delivery failure', saved, appliedProfile(saved)!);
    });
    mount({ initialSection: 'sampling', onProfileCommit });
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Saved prompt' } });
    fireEvent.click(screen.getByText('Save as new', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Saved once' } });
    await act(async () => { fireEvent.click(screen.getByText('Create new profile', { selector: 'button' })); });
    await waitFor(() => expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Settings were saved');
    expect(screen.getByRole('heading', { name: 'Saved once' })).toBeVisible();
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Saved prompt');
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    expect(screen.getByRole('button', { name: 'Saved once · Selected' })).toBeVisible();
    expect(onProfileCommit).toHaveBeenCalledOnce();
  });

  it('keeps one save label while explaining when a running server needs a restart', () => {
    mount({ initialSection: 'sampling', liveState: 'running', liveConfig: cfg });
    fireEvent.change(numeric('temperature'), { target: { value: '0.9' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Performance & memory' }));
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    expect(screen.getByText('Save the profile and reload to use these execution options.')).toBeVisible();
  });

  it('resets all fields within the selected profile and can restore its saved settings', async () => {
    const custom = { ...cfg, active_backend: 'cpu', active_build: 'b123', ctx_size: 16384, mmproj: 'models/projector.gguf',
      spec_draft_model: 'models/draft.gguf', lora_adapters: [{ path: 'models/adapter.gguf', enabled: true, scale: 0.5 }],
      server_args: ['--seed', '12'], chat_options: { min_p: 0.12 }, gpu: { gpu_ids: ['gpu-synthetic'], main_gpu: 'gpu-synthetic', split_mode: 'single' as const, tensor_split: [], draft_gpu_id: null } };
    const source = captureProfile(custom, 'Original settings', 'model', 'Saved prompt');
    const application = materializeProfileApplication(custom, 'Saved prompt', source);
    const saved = { ...custom, settings_profiles: { ...emptyProfileLibrary(), entries: [source, defaultSettingsProfile()], applied: { [profileTargetKey(custom.active_model)]: application } } };
    const { onApply, onProfileCommit, getSaved } = mount({ initialConfig: saved, initialSection: 'advanced' });
    fireEvent.change(rawChat(), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Original settings ·/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Adjust options/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset options to defaults' }));
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Original settings · Editing' })).toBeVisible();
    expect(within(document.querySelector<HTMLElement>('.settings-profile-banner')!).getByRole('status')).toHaveTextContent('Options reset to defaults.');
    expect(rawChat()).toHaveValue('{}');
    expect(screen.getByLabelText('Extra server arguments (one per line)')).toHaveValue('');
    expect(numeric('ctx_size')).toHaveValue(4096);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile' }), document.querySelector('.model-settings-footer')?.textContent ?? '').toBeEnabled());
    expect(getSaved()).toEqual(saved);
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Original settings · Editing' })).not.toBeInTheDocument());
    expect(numeric('ctx_size')).toHaveValue(16384);
    expect(rawChat()).toHaveValue(JSON.stringify(custom.chat_options, null, 2));
    fireEvent.click(screen.getByRole('tab', { name: 'Generation' }));
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Saved prompt');
  });

  it('confirms that untouched profile values already use defaults without marking them as edited', () => {
    const defaults = resetProfileSettings(cfg, false);
    const source = captureProfile(defaults, 'Default values', 'model', 'Keep these instructions');
    const application = materializeProfileApplication(defaults, 'Keep these instructions', source);
    const saved = { ...defaults, settings_profiles: { ...emptyProfileLibrary(), entries: [source],
      applied: { [profileTargetKey(cfg.active_model)]: application } } };
    const { onApply, onProfileCommit, onClose, getSaved } = mount({ initialConfig: saved, initialSection: 'profiles' });
    openOptions();
    expect(screen.getByRole('heading', { name: 'Default values' })).toBeVisible();
    expect(screen.queryByText(/Reset all options in the selected profile/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset options to defaults' }));
    expect(within(document.querySelector<HTMLElement>('.settings-profile-banner')!).getByRole('status')).toHaveTextContent('Options already use defaults.');
    expect(screen.getByRole('heading', { name: 'Default values' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Default values · Editing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
    expect(getSaved()).toEqual(saved);
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });

  it('reports a completed reset when clearing an invalid draft whose saved values already use defaults', () => {
    const defaults = resetProfileSettings(cfg, false);
    const source = captureProfile(defaults, 'Default values', 'model', '');
    const application = materializeProfileApplication(defaults, '', source);
    const saved = { ...defaults, settings_profiles: { ...emptyProfileLibrary(), entries: [source],
      applied: { [profileTargetKey(cfg.active_model)]: application } } };
    const { onApply, onProfileCommit, getSaved } = mount({ initialConfig: saved, initialSection: 'advanced' });
    fireEvent.change(rawChat(), { target: { value: '{' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Adjust options/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset options to defaults' }));
    expect(within(document.querySelector<HTMLElement>('.settings-profile-banner')!).getByRole('status')).toHaveTextContent('Options reset to defaults.');
    expect(rawChat()).toHaveValue('{}');
    expect(screen.getByRole('heading', { name: 'Default values' })).toBeVisible();
    expect(getSaved()).toEqual(saved);
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset options to defaults' }));
    expect(within(document.querySelector<HTMLElement>('.settings-profile-banner')!).getByRole('status')).toHaveTextContent('Options already use defaults.');
  });

  it('saves external option defaults only on explicit profile save, keeping the model, runtime and conversation settings', async () => {
    const provider = 'custom.defaults';
    const external = { ...cfg, active_provider: provider as api.ProviderId, active_runtime: 'synthetic', request_timeout_seconds: 123,
      provider_options: { [provider]: { workers: 8 }, 'llama.cpp': { keep: 9 } } };
    const source = captureProfile(external, 'Engine options', 'model', 'Keep this prompt');
    const application = materializeProfileApplication(external, 'Keep this prompt', source);
    const saved = { ...external, settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(external.active_model)]: application } } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [schemaOption({ key: 'workers', flag: '--workers', group: 'other', target: 'launch', kind: { type: 'integer' }, runtime_default: '4' })]));
    const { onApply, onProfileCommit, getSaved } = mount({ initialConfig: saved, initialSection: 'advanced' });
    const reset = await screen.findByRole('button', { name: 'Reset options to defaults' });
    expect(screen.getAllByRole('button', { name: 'Reset options to defaults' })).toHaveLength(1);
    await waitFor(() => expect(reset).toBeEnabled()); fireEvent.click(reset);
    expect(screen.getByLabelText(/^--workers/)).toHaveValue('');
    expect(getSaved()).toEqual(saved);
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled()); fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const [draft, edit] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(draft).toMatchObject({ active_provider: provider, active_runtime: 'synthetic', active_model: external.active_model,
      request_timeout_seconds: 123, provider_options: { [provider]: {}, 'llama.cpp': { keep: 9 } } });
    expect(draft.provider_options).toEqual({ [provider]: {}, 'llama.cpp': { keep: 9 } });
    expect(edit.application).toMatchObject({ profile_id: source.id, profile_name: source.name, system_prompt: 'Keep this prompt',
      settings: { request_timeout_seconds: 123, provider_options: { [provider]: {} } } });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('resets and saves the selected external profile from profile selection without starting the engine', async () => {
    const provider = 'custom.profile-edit';
    const external = { ...cfg, active_provider: provider as api.ProviderId, active_runtime: 'synthetic', provider_options: { [provider]: { workers: 8 } } };
    const source = captureProfile(external, 'Editable engine profile', 'global', 'Saved prompt');
    const application = materializeProfileApplication(external, 'Saved prompt', source);
    const saved = { ...external, settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(external.active_model)]: application } } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [schemaOption({ key: 'workers', flag: '--workers', group: 'other', target: 'launch', kind: { type: 'integer' } })]));
    const { onApply, onProfileCommit, getSaved } = mount({ initialConfig: saved, initialSection: 'profiles' });
    expect(screen.getByRole('heading', { name: 'Choose profile' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Save profile' })).toHaveLength(1);
    const reset = screen.getByRole('button', { name: 'Reset options to defaults' });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    expect(screen.getByRole('region', { name: 'Current values' })).toHaveTextContent('Options reset to defaults.');
    expect(getSaved()).toEqual(saved); expect(onProfileCommit).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled()); fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(save); fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const [draft, edit] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(draft).toMatchObject({ active_provider: provider, active_runtime: 'synthetic', active_model: external.active_model });
    expect(draft.provider_options?.[provider]).toEqual({});
    expect(edit.application).toMatchObject({ profile_id: source.id, profile_name: source.name, system_prompt: 'Saved prompt' });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Choose profile' })).toBeVisible();
  });

  it('shares one runtime verification across profile details, option edits, full reset and save confirmation', async () => {
    const provider = 'custom.shared-schema';
    const read = vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [schemaOption({ key: 'workers', flag: '--workers', group: 'other', target: 'launch', kind: { type: 'integer' } })]));
    read.mockClear();
    const { onProfileCommit } = mount({ initialSection: 'profiles', initialConfig: { ...cfg, active_provider: provider, active_runtime: 'synthetic', provider_options: { [provider]: { workers: 2 } } } });
    expect(await within(screen.getByRole('region', { name: 'Current values' })).findByText('--workers')).toBeVisible();
    expect(read).toHaveBeenCalledOnce();
    openOptions();
    fireEvent.change(screen.getByLabelText(/^--workers/), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    expect(within(screen.getByRole('region', { name: 'Current values' })).getByText('9')).toBeVisible();
    expect(read).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reset options to defaults' }));
    const save = screen.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled()); fireEvent.click(save);
    expect(screen.getByRole('dialog', { name: /^Save these changes/ })).toBeVisible();
    expect(read).toHaveBeenCalledOnce(); expect(onProfileCommit).not.toHaveBeenCalled();
  });

  it.each(['custom.profile-edit', 'vllm'] as const)('validates %s options before saving from profile selection without visiting the option tab', async provider => {
    let finish!: (issues: Awaited<ReturnType<typeof api.providerOptionIssues>>) => void;
    const check = vi.spyOn(api, 'providerOptionIssues').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { onProfileCommit, onApply } = mount({ initialSection: 'profiles', initialConfig: { ...cfg, active_provider: provider, active_runtime: 'synthetic' } });
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset options to defaults' })).toBeEnabled();
    await act(async () => { finish([{ key: 'workers', code: 'synthetic-review', message: 'Synthetic option needs review' }]); });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
    check.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Reset options to defaults' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled());
  });

  it('resets options while retaining the saved prompt and profile identity', async () => {
    const source = captureProfile({ ...cfg, ctx_size: 12288 }, 'Source settings', 'model', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', source);
    const saved = { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [source, defaultSettingsProfile()], applied: { [profileTargetKey(cfg.active_model)]: application } } };
    const { onProfileCommit } = mount({ initialConfig: saved, initialSection: 'profiles' });
    openOptions();
    fireEvent.click(screen.getByRole('button', { name: 'Reset options to defaults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const [draft, edit, applyTarget] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(draft).toMatchObject(resetProfileOptions(saved, false));
    expect(applyTarget).toBe(true);
    expect(edit.application.system_prompt).toBe('Saved prompt');
    expect(edit.application.profile_id).toBe(source.id);
    expect(edit.application.profile_name).toBe(source.name);
    expect(edit.library.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([expect.objectContaining({ id: source.id, name: source.name, revision: source.revision + 1, system_prompt: 'Saved prompt', settings: expect.objectContaining({ runtime_defaults: expect.arrayContaining(['ctx_size', 'temperature']), chat_options: {} }) }), defaultSettingsProfile()]);
    const stored = edit.library.entries[0];
    expect(stored.settings).toEqual(edit.application.settings);
    expect(source.settings.ctx_size).toBe(12288);
    expect(source.system_prompt).toBe('Saved prompt');
  });

  it.each(['llama.cpp', 'custom.prompt-preservation'] as const)('keeps unsaved instructions through %s option reset, explicit save and reopening', async provider => {
    const original = { ...cfg, active_provider: provider, active_runtime: 'synthetic', ctx_size: 12288, port: 9100,
      provider_options: { [provider]: { workers: 8 } } };
    const source = captureProfile(original, 'Prompt and options', 'global', 'Saved instructions');
    const application = materializeProfileApplication(original, 'Saved instructions', source);
    const saved = { ...original, settings_profiles: { ...emptyProfileLibrary(), entries: [source],
      applied: { [profileTargetKey(original.active_model, 'default', provider)]: application } } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [schemaOption({ key: 'workers', flag: '--workers', group: 'other', target: 'launch', kind: { type: 'integer' } })]));
    const { onProfileCommit, onApply, getSaved } = mount({ initialConfig: saved, initialSection: 'profiles' });
    expect(screen.getAllByRole('button', { name: 'Reset options to defaults' })).toHaveLength(1);
    openOptions();
    fireEvent.click(screen.getByRole('tab', { name: provider === 'llama.cpp' ? 'Generation' : 'Conversation instructions' }));
    const prompt = screen.getByRole('textbox', { name: 'Default system prompt' });
    const instructions = '  Keep my edited instructions.\nSecond line.  ';
    fireEvent.change(prompt, { target: { value: instructions } });
    const reset = screen.getByRole('button', { name: 'Reset options to defaults' });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue(instructions);
    expect(screen.getAllByRole('button', { name: 'Reset options to defaults' })).toHaveLength(1);
    expect(getSaved()).toEqual(saved);
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled()); fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const [draft, edit] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(draft).toMatchObject({ active_provider: provider, active_runtime: 'synthetic', active_model: original.active_model, port: 9100 });
    expect(edit.application.system_prompt).toBe(instructions);
    expect(edit.library.entries.find(entry => entry.id === source.id)?.system_prompt).toBe(instructions);
    expect(onApply).not.toHaveBeenCalled();
    const persisted = getSaved();
    cleanup();
    mount({ initialConfig: persisted, initialSection: 'prompt' });
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue(instructions);
  });

  it.each(['stale', 'unchecked'] as const)('does not offer an option reset before a %s engine schema is checked', async help_state => {
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [], { help_state }));
    mount({ initialConfig: { ...cfg, active_provider: 'custom.unchecked', active_runtime: 'synthetic' }, initialSection: 'profiles' });
    const reset = screen.getByRole('button', { name: 'Reset options to defaults' });
    expect(reset).toBeDisabled();
    await within(screen.getByRole('region', { name: 'Current values' })).findByText('The engine’s options need to be checked again. Reload its help before using these saved settings.');
    expect(reset).toBeDisabled();
  });

  it('retains malformed option order and reports review without claiming the reset succeeded', async () => {
    const provider = 'custom.order-review';
    const values = { workers: 8, [ORDER_KEY]: { version: 2, occurrences: [{ key: 'workers' }] } };
    const saved: api.AppConfig = { ...cfg, active_provider: provider, active_runtime: 'synthetic', provider_options: { [provider]: values } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [schemaOption({ key: 'workers', flag: '--workers', group: 'other', target: 'launch', kind: { type: 'integer' } })]));
    const { onProfileCommit, onApply, getSaved } = mount({ initialConfig: saved, initialSection: 'advanced' });
    const reset = screen.getByRole('button', { name: 'Reset options to defaults' });
    await waitFor(() => expect(reset).toBeEnabled()); fireEvent.click(reset);
    expect(await screen.findByText('Check the saved option order, then try resetting again.')).toBeVisible();
    expect(screen.queryByText('Options reset to defaults.')).not.toBeInTheDocument();
    expect(screen.queryByText('Options already use defaults.')).not.toBeInTheDocument();
    expect(getSaved()).toEqual(saved);
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
  });

  it.each([
    { draft: 'clean', confirmation: 'native composition', dirty: false, isComposing: true, keyCode: 13 },
    { draft: 'edited', confirmation: 'native composition', dirty: true, isComposing: true, keyCode: 13 },
    { draft: 'clean', confirmation: '229 fallback', dirty: false, isComposing: false, keyCode: 229 },
    { draft: 'edited', confirmation: '229 fallback', dirty: true, isComposing: false, keyCode: 229 },
  ] as const)('keeps the $draft model preview during $confirmation Enter and loads only after confirmation', async ({ dirty, isComposing, keyCode }) => {
    const nextPath = 'models/模型-한글-🦊.gguf';
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [
      { name: 'a.gguf', path: cfg.active_model, size_mb: 3000, is_vision: false },
      { name: '模型-한글-🦊.gguf', path: nextPath, size_mb: 1500, is_vision: false },
    ], truncated: false });
    vi.spyOn(api, 'modelMetadata').mockResolvedValue({});
    rememberExecution({ ...cfg, active_model: nextPath, ctx_size: 16384 });
    const stored = localStorage.getItem('aiolm-model-execution');
    const initial = structuredClone(cfg);
    const initialBefore = structuredClone(initial);
    const { onApply, onClose, onProfileCommit, onReloadProfile, getSaved } = mount({ initialSection: 'tuning', initialConfig: initial });
    const savedBefore = structuredClone(getSaved());
    if (dirty) {
      fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
      fireEvent.blur(numeric('ctx_size'));
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Model' }));
    const oldModel = await screen.findByRole('button', { name: /^a\.gguf/ });
    const nextModel = screen.getByRole('button', { name: /^模型-한글-🦊\.gguf/ });
    const path = screen.getByRole('textbox', { name: 'Model path' });
    fireEvent.change(path, { target: { value: nextPath } });
    let nativeDefaultAvailable = false;
    await act(async () => { nativeDefaultAvailable = fireEvent.keyDown(path, { key: 'Enter', keyCode, isComposing }); });
    const header = () => document.querySelector('.model-settings-header p[title]');
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
    expect(header()).toHaveAttribute('title', cfg.active_model);
    expect(oldModel).toHaveAttribute('aria-pressed', 'true');
    expect(nextModel).toHaveAttribute('aria-pressed', 'false');
    expect(numeric('ctx_size')).toHaveValue(dirty ? 8192 : cfg.ctx_size);
    expect(path).toHaveValue(nextPath);
    expect(screen.getByRole('button', { name: 'Load into editor' })).toBeEnabled();
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onReloadProfile).not.toHaveBeenCalled();
    expect(getSaved()).toEqual(savedBefore);
    expect(initial).toEqual(initialBefore);
    expect(localStorage.getItem('aiolm-model-execution')).toBe(stored);
    expect(nativeDefaultAvailable).toBe(true);

    await act(async () => {
      expect(fireEvent.keyDown(path, { key: 'Enter', keyCode: 13, isComposing: false })).toBe(false);
    });
    if (dirty) {
      expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
      expect(header()).toHaveAttribute('title', cfg.active_model);
      expect(numeric('ctx_size')).toHaveValue(8192);
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument());
      expect(header()).toHaveAttribute('title', cfg.active_model);
      expect(numeric('ctx_size')).toHaveValue(8192);
      expect(path).toHaveValue(nextPath);
      fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
      expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    }
    await waitFor(() => expect(nextModel).toHaveAttribute('aria-pressed', 'true'));
    openOptions();
    await waitFor(() => expect(header()).toHaveAttribute('title', nextPath));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
    expect(oldModel).toHaveAttribute('aria-pressed', 'false');
    expect(nextModel).toHaveAttribute('aria-pressed', 'true');
    expect(numeric('ctx_size')).toHaveValue(16384);
    expect(path).toHaveValue(nextPath);
    expect(screen.queryByRole('button', { name: 'Load into editor' })).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onReloadProfile).not.toHaveBeenCalled();
    expect(getSaved()).toEqual(savedBefore);
    expect(initial).toEqual(initialBefore);
    expect(localStorage.getItem('aiolm-model-execution')).toBe(stored);
  });
});

const tensorLog = [
  'server exited before ready (1).',
  '0.00.056.525 I cmn common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)',
  '0.00.056.609 I srv init: The UI is disabled',
  "0.00.059.317 I srv load_model: loading model 'C:\\models\\Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64-00001-of-00033.gguf'",
  '0.00.185.799 W common_fit_params: failed to fit params to free device memory: llama_params_fit is not implemented for SPLIT_MODE_TENSOR, abort',
  "0.00.305.007 E llama_model_load: error loading model: LLAMA_SPLIT_MODE_TENSOR not implemented for architecture 'qwen4exp'",
  '0.00.305.015 E llama_model_load_from_file_impl: failed to load model',
  '0.00.306.207 E srv llama_server: exiting due to model loading error',
].join('\n');

const ansiTensorLog = `\u001b[34m${tensorLog}\u001b[0m`;

describe('launch failure summary', () => {
  it('summarizes a tensor failure without timestamps or model paths', () => {
    const view = describeLaunchFailure(`${profileStatusCopy.ko.savedFailure}${ansiTensorLog}`, 'ko');
    expect(view.summary).toBe('이 모델은 Tensor 분할 모드(실험적)를 지원하지 않습니다.\nGPU 설정의 분할 모드를 자동, layer 또는 row로 변경한 뒤 다시 실행해 주세요.');
    expect(view.summary).not.toContain('설정은 저장했지만');
    expect(view.summary).not.toMatch(/\d+\.\d+/);
    expect(view.detail).toContain('llama_model_load');
    expect(view.detail).not.toContain('\u001b');
  });

  it('falls back to the representative error line with a shortened model path', () => {
    const log = [
      'server exited before ready (9).',
      '0.02.000.000 I srv init: The UI is disabled',
      "0.03.000.000 E srv load_model: failed to load model, 'C:\\models\\Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64-00001-of-00033.gguf'",
    ].join('\n');
    const view = describeLaunchFailure(log, 'en');
    expect(view.summary).toBe("srv load_model: failed to load model, 'Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64.gguf'");
    expect(view.detail).toContain('server exited before ready (9)');
  });

  it('passes ordinary messages through without a details section', () => {
    const view = describeLaunchFailure('These settings changed elsewhere.', 'ko');
    expect(view).toEqual({ summary: 'These settings changed elsewhere.', detail: null });
  });

  it('surfaces a bare argument-parser error line', () => {
    const log = 'server exited before ready (1).\nerror: invalid argument: --no-mmap';
    const view = describeLaunchFailure(log, 'en');
    expect(view.summary).toBe('error: invalid argument: --no-mmap');
    expect(view.detail).toContain('server exited before ready (1)');
  });
});

describe('launch failure display', { timeout: 45000 }, () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('shows a short summary first and keeps the raw log behind details', async () => {
    const onApply = vi.fn(async () => { throw new SettingsDeliveryError(tensorLog, cfg, appliedProfile(cfg)!); });
    mount({ onApply }, 'ko');
    fireEvent.click(await screen.findByRole('button', { name: /a\.gguf/ }));
    const start = screen.getByRole('button', { name: '프로필 저장 후 실행' });
    await waitFor(() => expect(start).toBeEnabled());
    await act(async () => { fireEvent.click(start); });
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('설정은 저장했지만');
    const summary = within(alert).getByText(/Tensor 분할 모드/);
    expect(summary.textContent).not.toMatch(/\d+\.\d+\.\d+/);
    expect(summary.textContent).not.toContain('Qwen3.8');
    expect(within(alert).getByText(/GPU 설정의 분할 모드/)).toBeVisible();
    expect(within(alert).getByText('자세히')).toBeVisible();
    expect(within(alert).getByText(/llama_model_load/)).toBeInTheDocument();
  });
});

describe('confirming a profile save', () => {
  const source = captureProfile(cfg, 'Selected profile', 'global', 'Saved prompt');
  const application = materializeProfileApplication(cfg, 'Saved prompt', source);
  const withProfile = { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(cfg.active_model)]: application } } };

  it('shows each edited option with its own before and after arrow', () => {
    // A profile is a wide snapshot and the editor gives no sense of how much of
    // it an edit touched; overwriting one is not undoable from here.
    const { onProfileCommit } = mount({ initialSection: 'tuning', initialConfig: withProfile });
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.change(numeric('ngl'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    const confirm = screen.getByRole('dialog', { name: /^Save these changes/ });
    const changes = within(confirm).getAllByRole('term').map(term => term.parentElement!);
    expect(changes.map(row => row.querySelector('dt')?.textContent)).toEqual(['Context size', 'GPU layers']);
    expect(changes.map(row => [row.querySelector('.settings-profile-change-before')?.textContent,
      row.querySelector('.settings-profile-change-after')?.textContent])).toEqual([
      [String(cfg.ctx_size), '8192'], [String(cfg.ngl), '25'],
    ]);
    for (const row of changes) expect(row.querySelector('.settings-profile-change-arrow')).toHaveTextContent('→');
    expect(onProfileCommit).not.toHaveBeenCalled();
  });

  it('writes nothing when the confirmation is cancelled, and keeps the edit', () => {
    const { onProfileCommit } = mount({ initialSection: 'tuning', initialConfig: withProfile });
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onProfileCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /^Save these changes/ })).not.toBeInTheDocument();
    expect(numeric('ctx_size')).toHaveValue(8192);
  });

  it('says so plainly when a save would rewrite nothing', () => {
    mount({ initialSection: 'tuning', initialConfig: withProfile });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(within(screen.getByRole('dialog', { name: /^Save these changes/ })).getByText('Nothing in this profile would change.')).toBeVisible();
  });
});

describe('context size bounds', () => {
  it('accepts a context past the catalogue guess when nothing states a smaller one', async () => {
    // 131072 was an app constant, not a limit llama.cpp has; refusing a larger
    // value blocked configurations that load perfectly well.
    mount({ initialSection: 'tuning' });
    await waitFor(() => expect(numeric('ctx_size')).toBeInTheDocument());
    fireEvent.change(numeric('ctx_size'), { target: { value: '262144' } });
    expect(screen.queryByText(/Correct invalid fields/)).not.toBeInTheDocument();
    expect(numeric('ctx_size')).toHaveValue(262144);
  });

  it('still refuses an entry that is garbage rather than large and names the field in plain language', async () => {
    mount({ initialSection: 'tuning' });
    await waitFor(() => expect(numeric('ctx_size')).toBeInTheDocument());
    fireEvent.change(numeric('ctx_size'), { target: { value: '99999999' } });
    await waitFor(() => expect(screen.getByText('Correct invalid fields before applying. (Context size)')).toBeVisible());
    expect(screen.queryByText(/ctx_size/)).not.toBeInTheDocument();
  });

  it('localizes invalid field names, unknown model format badges, and model picker modalities in Korean while preserving unknown modality keys', async () => {
    vi.mocked(api.listModels).mockResolvedValueOnce({
      models: [{
        name: 'mystery.bin',
        path: 'models/mystery.bin',
        size_mb: 500,
        is_vision: false,
        artifact: {
          name: 'mystery.bin',
          path: 'models/mystery.bin',
          format: 'unknown',
          role: 'model',
          size_bytes: 500 * 1024 * 1024,
          file_count: 1,
          modalities: Object.assign({ text: true, image: true, audio: false, video: false }, { depth: true, constructor: true }),
          incomplete: false,
          missing: [],
          architectures: [],
          ownership: 'external',
          notes: [],
        },
      }],
      truncated: false,
    });
    mount({ initialSection: 'model', initialConfig: { ...cfg, active_model: 'models/mystery.bin' } }, 'ko');
    expect((await screen.findAllByText(/형식 미확인/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/형식 미확인 · 텍스트, 이미지, depth, constructor · —/)).toBeVisible();
    expect(screen.queryByText('unknown', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '성능·메모리' }));
    await waitFor(() => expect(numeric('ctx_size')).toBeInTheDocument());
    fireEvent.change(numeric('ctx_size'), { target: { value: '99999999' } });
    await waitFor(() => expect(screen.getByText('잘못 입력된 항목을 수정한 뒤 적용하세요. (컨텍스트 크기)')).toBeVisible());
  });

  it('bounds the control at what the model states it was trained for', async () => {
    vi.mocked(api.modelMetadata).mockResolvedValue({ context_length: 8192 });
    mount({ initialSection: 'tuning' });
    await waitFor(() => expect(api.modelMetadata).toHaveBeenCalled());
    fireEvent.change(numeric('ctx_size'), { target: { value: '16384' } });
    await waitFor(() => expect(screen.getByText(/Correct invalid fields/)).toBeVisible());
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    await waitFor(() => expect(screen.queryByText(/Correct invalid fields/)).not.toBeInTheDocument());
  });
});
