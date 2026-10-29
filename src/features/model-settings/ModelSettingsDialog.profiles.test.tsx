import { cfg, mount, rawChat, numeric, openOptions } from '../../testing/modelSettingsDialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';
import * as api from '../../shared/api';
import { appliedProfile, mergeProfileEditor, SettingsDeliveryError } from './profileEditor';
import { resetProfileOptions, resetProfileSettings } from './profileResetState';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';

// Each file keeps isolated mocks and the original semantic journeys.
describe('model settings editor', { timeout: 45000 }, () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });


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
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Use concise answers.' } });
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Keep this prompt.' } });
    fireEvent.click(screen.getByText('Save as new', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Retry me' } });
    await act(async () => { fireEvent.click(screen.getByText('Create new profile', { selector: 'button' })); });
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    expect(screen.getByText('Create new profile', { selector: 'button' })).toBeEnabled();
    expect(screen.getByLabelText('Profile name')).toHaveValue('Retry me');
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue('Keep this prompt.');
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Working prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /^Choose profile/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Saved profile · Selected · Editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Renamed profile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Saved profile · Editing' })).not.toBeInTheDocument());
    openOptions();
    fireEvent.click(screen.getByRole('tab', { name: 'Generation' }));
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue('Saved prompt');
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Working prompt' } });
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
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue('Working prompt');
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Saved prompt' } });
    fireEvent.click(screen.getByText('Save as new', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Saved once' } });
    await act(async () => { fireEvent.click(screen.getByText('Create new profile', { selector: 'button' })); });
    await waitFor(() => expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Settings were saved');
    expect(screen.getByRole('heading', { name: 'Saved once' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue('Saved prompt');
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
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue('Saved prompt');
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
});
