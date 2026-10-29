import { cfg, mount, numeric, openOptions } from '../../testing/modelSettingsDialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary } from '../../shared/config/settingsProfiles';
import * as api from '../../shared/api';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import { registerTask, removeTask } from '../../shared/state/taskRegistry';
import { LocalTaskCancelButton, TaskCancellationProvider } from '../../shared/ui/TaskCancellation';
import TaskStrip from '../../shared/ui/TaskStrip';

// Each file keeps isolated mocks and the original semantic journeys.
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
    const stage = document.querySelector<HTMLElement>('.model-settings-body')!;
    stage.scrollTo = ((options: ScrollToOptions) => { stage.scrollTop = options.top ?? stage.scrollTop; }) as typeof stage.scrollTo;
    // The new stage arrives focused and at its top in the same update, before a
    // frame can paint it elsewhere and move what the next pointer press aims at.
    const navigate = (button: string | RegExp, heading: string) => {
      stage.scrollTop = 302;
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(screen.getByRole('heading', { name: heading })).toHaveFocus();
      expect(stage.scrollTop).toBe(0);
    };
    expect(screen.getByRole('button', { name: /^Choose runtime/ })).toHaveAttribute('aria-current', 'step');
    navigate('Continue to profile', 'Choose profile');
    expect(screen.getByRole('button', { name: /^Choose profile/ })).toHaveAttribute('aria-current', 'step');
    navigate('Use this profile and adjust options', 'Adjust options');
    navigate('Back to profile', 'Choose profile');
    // A control used once the stage has arrived keeps its focus in later frames.
    const chip = document.querySelector<HTMLButtonElement>('.settings-profile-chip')!;
    chip.focus();
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(chip).toHaveFocus();
    navigate(/^Choose runtime/, 'Choose runtime');
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
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toBeVisible();
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let mounted!: ReturnType<typeof mount>;
      // Flush the runtime/schema responses, then drive the option editor's
      // real validation debounce without racing DOM queries against CI load.
      await act(async () => {
        mounted = mount({ initialConfig: { ...cfg, active_provider: 'vllm', active_runtime: 'wide', active_model: 'models/snapshot' } });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('radio', { name: /^narrow · synthetic · Registered installation/ }));
      });
      expect(screen.getByRole('button', { name: /^Adjust options/ })).toBeDisabled();
      openOptions();
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      expect(screen.getByText(/Selected runtime cannot load this snapshot/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Model path' })).toHaveValue('models/snapshot');
      fireEvent.click(screen.getByRole('button', { name: 'Save profile & start' }));
      expect(mounted.onApply).not.toHaveBeenCalled();
    } finally { cleanup(); vi.useRealTimers(); }
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Unsaved llama prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^vLLM/ }));
    expect(screen.getByRole('button', { name: 'Continue to profile' })).toBeDisabled();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('radio', { name: /^synthetic · synthetic · Registered installation/ }));
    openOptions();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue(''));
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Unsaved vLLM prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^llama\.cpp/ }));
    openOptions();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue('Unsaved llama prompt'));
    fireEvent.click(screen.getByRole('button', { name: /^Choose runtime/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^vLLM/ }));
    openOptions();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue('Unsaved vLLM prompt'));
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
});
