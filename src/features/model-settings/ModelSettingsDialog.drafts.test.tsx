import { cfg, mount, numeric, openOptions } from '../../testing/modelSettingsDialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { type ModelSettingsDialogProps } from './ModelSettingsDialog';
import { rememberExecution } from '../models/modelExecutionState';
import { captureProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';
import * as api from '../../shared/api';
import { appliedProfile, mergeProfileEditor } from './profileEditor';

// Each file keeps isolated mocks and the original semantic journeys.
describe('model settings editor', { timeout: 45000 }, () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

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
    fireEvent.change(screen.getByRole('textbox', { name: 'Default system prompt' }), { target: { value: 'Updated prompt' } });
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
    expect(await screen.findByText('This runtime is not ready to use. Check it in runtime management, install it if needed, or select another runtime.')).toBeVisible();
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
    expect(screen.queryByText('The selected runtime is not ready to use. You can save these settings, but check it in runtime management and install it if needed before starting.')).not.toBeInTheDocument();
    expect(screen.queryByText('This runtime is not ready to use. Check it in runtime management, install it if needed, or select another runtime.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeEnabled());
    expect(screen.queryByText('The selected runtime is not ready to use. You can save these settings, but check it in runtime management and install it if needed before starting.')).not.toBeInTheDocument();
  });

  it.each(['vllm', 'mlx-vlm'] as const)('asks to select a %s runtime without claiming an unselected runtime is missing', async provider => {
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: provider, server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([{ id: 'synthetic', provider, engine: provider, server: 'synthetic', accelerator: 'synthetic', installation: 'external', location: 'runtime', available: true, problems: [] }]);
    vi.spyOn(api, 'providerOptionIssues').mockResolvedValue([]);
    vi.spyOn(api, 'providerRuntimeOptions').mockResolvedValue([]);
    const { onApply, onProfileCommit } = mount({ initialSection: 'runtime', initialConfig: { ...cfg, active_provider: provider, active_runtime: '' } });
    expect(await screen.findByText('No runtime is selected.')).toBeVisible();
    await waitFor(() => expect(api.providerRuntimes).toHaveBeenCalled());
    expect(screen.queryByText('The selected runtime is not ready to use. You can save these settings, but check it in runtime management and install it if needed before starting.')).not.toBeInTheDocument();
    expect(screen.queryByText('This runtime is not ready to use. Check it in runtime management, install it if needed, or select another runtime.')).not.toBeInTheDocument();
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
    expect(await screen.findByText('The selected runtime is not ready to use. You can save these settings, but check it in runtime management and install it if needed before starting.')).toBeVisible();
    openOptions();
    expect(screen.getByText('This runtime is not ready to use. Check it in runtime management, install it if needed, or select another runtime.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save profile & start' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile & start' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('keeps a registered but unprobed runtime blocked without describing it as uninstalled', async () => {
    const provider = 'custom.unprobed';
    const entry: api.RuntimeInstance = { provider, id: 'build-one', engine: 'external', server: 'openai-v1',
      accelerator: '', installation: 'external', location: 'synthetic-runtime', available: false, problems: [] };
    const initialConfig: api.AppConfig = { ...cfg, active_provider: provider, active_runtime: entry.id, active_backend: '', active_build: '' };
    const before = structuredClone({ entry, initialConfig });
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: 'Synthetic engine', server: 'openai-v1', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue([entry]);
    const { onApply, onProfileCommit, getSaved } = mount({ initialSection: 'runtime', initialConfig });
    const selected = await screen.findByRole('radio', { name: /build-one/ });
    expect(selected).toBeChecked(); expect(selected).toBeDisabled();
    expect(await screen.findByText('The selected runtime is not ready to use. You can save these settings, but check it in runtime management and install it if needed before starting.')).toBeVisible();
    openOptions();
    expect(screen.getByText('This runtime is not ready to use. Check it in runtime management, install it if needed, or select another runtime.')).toBeVisible();
    const start = screen.getByRole('button', { name: 'Save profile & start' });
    expect(start).toBeDisabled(); fireEvent.click(start);
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
    expect(getSaved()).toEqual(before.initialConfig);
    expect({ entry, initialConfig }).toEqual(before);
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
});
