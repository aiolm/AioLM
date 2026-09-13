import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { I18nProvider, type Locale } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { ModelSettingsDialog, type ModelSettingsDialogProps } from './ModelSettingsDialog';
import { rememberExecution } from '../models/modelExecutionState';
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';
import * as api from '../../shared/api';
import { appliedProfile, mergeProfileEditor, profileLibraryConfigPatch, SettingsDeliveryError } from './profileEditor';
import { resetProfileSettings } from './profileResetState';

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
    return <ModelSettingsDialog open={open} initialConfig={structuredClone(cfg)} mode="default" targetLabel="Default execution"
      {...props} onProfileCommit={onProfileCommit} onReloadProfile={onReloadProfile} onApply={onApply} onClose={() => { onClose(); setOpen(false); }} />;
  }
  render(<I18nProvider initialLocale={locale}><Harness /></I18nProvider>);
  return { onApply, onClose, onProfileCommit, onReloadProfile, getSaved: () => persisted };
}
function numeric(key: string) { return document.querySelector<HTMLInputElement>(`input[id$="-${key}"]`)!; }

describe('model settings editor', { timeout: 15000 }, () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it.each(['default', 'session', 'benchmark', 'project'] as const)('saves edited options into the named selected profile from the %s target', async mode => {
    const source = captureProfile(cfg, 'Selected profile', 'global', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', source);
    const { onApply, onProfileCommit, onClose, getSaved } = mount({ mode, initialSection: 'tuning', initialConfig: { ...cfg,
      settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(numeric('ngl'), { target: { value: '25' } });
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toHaveAccessibleDescription('Save to: Selected profile');
    fireEvent.click(save);
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Selected profile' })).toBeVisible());
    const [next, edit, applyTarget] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(applyTarget).toBe(true);
    expect(next.ngl).toBe(25);
    expect(edit.application.profile_id).toBe(source.id);
    expect(edit.library.entries).toHaveLength(1);
    expect(edit.library.entries[0]).toMatchObject({ id: source.id, name: source.name, settings: { ngl: 25 } });
    expect(getSaved().settings_profiles?.entries[0]).toMatchObject({ id: source.id, settings: { ngl: 25 } });
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
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Editable profile' })).toBeVisible());
    expect(getSaved().settings_profiles?.entries).toEqual([expect.objectContaining({ id: source.id, revision: source.revision + 1, settings: expect.objectContaining({ ctx_size: 8192 }) })]);
    expect(screen.getByRole('button', { name: 'Performance & memory' })).toHaveAttribute('aria-current', 'page');
    expect(numeric('ctx_size')).toHaveValue(8192);

    fireEvent.change(numeric('ctx_size'), { target: { value: '12288' } });
    expect(screen.getByRole('heading', { name: 'Editable profile · Editing' })).toBeVisible();
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    expect(screen.getByRole('heading', { name: 'Editable profile' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Generation' }));
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Updated prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Editable profile' })).toBeVisible());
    expect(onProfileCommit).toHaveBeenCalledTimes(2);
    expect(getSaved().settings_profiles?.entries).toEqual([expect.objectContaining({ id: source.id, revision: source.revision + 2, system_prompt: 'Updated prompt', settings: expect.objectContaining({ ctx_size: 8192 }) })]);
    expect(appliedProfile(getSaved())).toMatchObject({ profile_id: source.id, profile_revision: source.revision + 2, system_prompt: 'Updated prompt' });
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Model & settings' })).not.toBeInTheDocument();
  });

  it('places reset before profile save in the full profile banner', () => {
    mount({ initialSection: 'profiles' });
    const banner = screen.getByRole('button', { name: 'Save profile' }).closest('.settings-profile-banner')!;
    expect(within(banner as HTMLElement).getAllByRole('button').map(button => button.textContent)).toEqual([
      'Reset all to defaults', 'Save profile', 'Save as new',
    ]);
  });

  it('shows only the designated default before a model is selected and protects it', () => {
    mount({ initialConfig: { ...cfg, active_model: '' }, initialSection: 'profiles' });
    expect(document.querySelectorAll('.settings-profile-chip')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Default · Selected · Default profile' }));
    const preview = within(screen.getByRole('region', { name: 'Preview' }));
    expect(preview.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
    expect(preview.queryByRole('button', { name: 'Select this profile' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
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

  it('leaves inherited numeric and text values unchanged when navigating through their inputs', async () => {
    const { onClose, onApply } = mount({ initialSection: 'tuning', initialConfig: { ...cfg, ngl: 12, runtime_defaults: ['ngl', 'temperature', 'reasoning_budget_message'], reasoning_budget_message: 'old value' } });
    await waitFor(() => expect(api.rtList).toHaveBeenCalled());
    expect(numeric('ngl')).toHaveValue(99);
    expect(numeric('ngl')).toBeEnabled();
    fireEvent.focus(numeric('ngl')); fireEvent.blur(numeric('ngl'));
    fireEvent.pointerUp(document.querySelector('input[id$="-ngl-range"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Generation' }));
    fireEvent.focus(numeric('temperature')); fireEvent.blur(numeric('temperature'));
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
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
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledWith(expect.objectContaining({ ngl: 25, runtime_defaults: ['temperature'] }), expect.objectContaining({ application: expect.objectContaining({ settings: expect.objectContaining({ ngl: 25 }) }) }), true));
  });

  it('starts with no model selected and restores the saved model settings on explicit choice', async () => {
    const saved = { ...cfg, ctx_size: 12288, mmproj: 'models/projector.gguf' };
    const { onApply } = mount({ initialConfig: saved, requireModelSelection: true });
    expect(screen.getByRole('dialog', { name: 'Model & settings' })).toBeVisible();
    expect(within(screen.getByRole('navigation', { name: 'Model & settings' })).getByRole('button', { name: 'Runtime & GPU' })).toBeVisible();
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

  it('previews another model with its remembered configuration without changing the first model', async () => {
    rememberExecution({ ...cfg, active_model: 'models/b.gguf', ctx_size: 16384, chat_options: { stop: ['synthetic-stop'] } });
    const stored = localStorage.getItem('aiolm-model-execution');
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { onProfileCommit } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /b.gguf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Performance & memory' }));
    expect(numeric('ctx_size').value).toBe('16384');
    fireEvent.change(numeric('ctx_size'), { target: { value: '12288' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
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
    expect(await screen.findByText('Error: Synthetic save failure')).toBeVisible();
    expect(numeric('ctx_size').value).toBe('8192');
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Recovered profile · Editing' })).toBeVisible();
    expect(persisted.ctx_size).toBe(cfg.ctx_size);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
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
    expect(screen.getByText('Model profile · unsaved changes')).toBeVisible();
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
    expect(getSaved().settings_profiles?.entries).toEqual([expect.objectContaining({ name: 'Default' }), expect.objectContaining({ name: 'Recovered profile' }), expect.objectContaining({ name: 'Concise', system_prompt: 'Use concise answers.' })]);
    const assignment = appliedProfile(getSaved())!;
    expect(assignment.profile_id).toBe(getSaved().settings_profiles?.entries.find(profile => profile.name === 'Concise')?.id);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(getSaved().settings_profiles?.entries).toHaveLength(3);
  });

  it('keeps invalid inputs while browsing profile previews and allows reverting the working draft', async () => {
    const { onProfileCommit } = mount({ initialSection: 'advanced' });
    fireEvent.change(screen.getByLabelText('Extra request JSON'), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default · Default profile' }));
    expect(within(screen.getByRole('region', { name: 'Preview' })).getByRole('button', { name: 'Select this profile' })).toBeDisabled();
    expect(screen.getByLabelText('Extra request JSON')).toHaveValue('{');
    expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(screen.getByLabelText('Extra request JSON')).toHaveValue('{}'));
  });

  it('preserves benchmark workload values when applying the Default profile', async () => {
    const { onProfileCommit, getSaved } = mount({ mode: 'benchmark', initialSection: 'profiles' });
    expect(screen.queryByRole('button', { name: 'Generation' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Default · Default profile' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Preview' })).getByRole('button', { name: 'Select this profile' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    expect(getSaved()).toMatchObject({ ctx_size: cfg.ctx_size, temperature: cfg.temperature, parallel: cfg.parallel, ngl: cfg.ngl });
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
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    expect(screen.getAllByRole('button', { name: /Shared settings/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Shared settings · Selected · Editing' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Shared settings · Default profile' }));
    expect(screen.getByRole('button', { name: 'Save profile' })).toHaveAccessibleDescription('Save to: Shared settings');
    expect(screen.getByRole('button', { name: 'Recovered settings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const edit = vi.mocked(onProfileCommit).mock.calls[0][1];
    expect(edit.application.profile_id).toBe(copy.id);
    expect(edit.library.entries.find(entry => entry.id === copy.id)?.settings.ngl).toBe(25);
    expect(edit.library.entries.find(entry => entry.id === source.id)?.settings).toEqual(source.settings);
  });

  it('reloads saved target values after renaming a profile without storing the working edits', async () => {
    const profile = captureProfile(cfg, 'Saved profile', 'model', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', profile);
    const { getSaved } = mount({ initialSection: 'sampling', initialConfig: { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [profile, defaultSettingsProfile()], applied: { [profileTargetKey(cfg.active_model)]: application } } } });
    fireEvent.change(screen.getByLabelText('Default system prompt'), { target: { value: 'Working prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saved profile · Selected · Editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Renamed profile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Saved profile · Editing' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Generation' }));
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Saved prompt');
    expect(getSaved().settings_profiles?.entries[0]).toMatchObject({ name: 'Renamed profile', system_prompt: 'Saved prompt' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.change(screen.getByLabelText('Extra request JSON'), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saved profile · Selected · Editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }));
    await waitFor(() => expect(getSaved().settings_profiles?.default_profile_id).toBe(profile.id));
    expect(onProfileCommit).toHaveBeenCalledOnce();
    expect(getSaved().temperature).toBe(cfg.temperature);
    expect(appliedProfile(getSaved())).toMatchObject({ system_prompt: 'Saved prompt', settings: { temperature: cfg.temperature } });
    fireEvent.click(screen.getByRole('button', { name: 'Generation' }));
    expect(numeric('temperature')).toHaveValue(1.3);
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Working prompt');
    expect(screen.getByLabelText('Extra request JSON')).toHaveValue('{');
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
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    expect(screen.getByRole('button', { name: 'Saved once · Selected' })).toBeVisible();
    expect(onProfileCommit).toHaveBeenCalledOnce();
  });

  it('keeps one save label while explaining when a running server needs a restart', () => {
    mount({ initialSection: 'sampling', liveState: 'running', liveConfig: cfg });
    fireEvent.change(numeric('temperature'), { target: { value: '0.9' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Performance & memory' }));
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
    fireEvent.change(screen.getByLabelText('Extra request JSON'), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    fireEvent.click(screen.getByRole('button', { name: /^Original settings ·/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Original settings · Editing' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Reset to defaults.');
    expect(screen.getByLabelText('Extra request JSON')).toHaveValue('{}');
    expect(screen.getByLabelText('Extra server arguments (one per line)')).toHaveValue('');
    expect(numeric('ctx_size')).toHaveValue(4096);
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    expect(getSaved()).toEqual(saved);
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Original settings · Editing' })).not.toBeInTheDocument());
    expect(numeric('ctx_size')).toHaveValue(16384);
    expect(screen.getByLabelText('Extra request JSON')).toHaveValue(JSON.stringify(custom.chat_options, null, 2));
    fireEvent.click(screen.getByRole('button', { name: 'Generation' }));
    expect(screen.getByLabelText('Default system prompt')).toHaveValue('Saved prompt');
  });

  it('confirms that untouched profile values already use defaults without marking them as edited', () => {
    const defaults = resetProfileSettings(cfg, false);
    const source = captureProfile(defaults, 'Default values', 'model', '');
    const application = materializeProfileApplication(defaults, '', source);
    const saved = { ...defaults, settings_profiles: { ...emptyProfileLibrary(), entries: [source],
      applied: { [profileTargetKey(cfg.active_model)]: application } } };
    const { onApply, onProfileCommit, onClose, getSaved } = mount({ initialConfig: saved, initialSection: 'profiles' });
    expect(screen.getByRole('heading', { name: 'Default values' })).toBeVisible();
    expect(screen.queryByText(/Reset all options in the selected profile/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    expect(screen.getByRole('status')).toHaveTextContent('Already using defaults.');
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
    fireEvent.change(screen.getByLabelText('Extra request JSON'), { target: { value: '{' } });
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    expect(screen.getByRole('status')).toHaveTextContent('Reset to defaults.');
    expect(screen.getByLabelText('Extra request JSON')).toHaveValue('{}');
    expect(screen.getByRole('heading', { name: 'Default values' })).toBeVisible();
    expect(getSaved()).toEqual(saved);
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    expect(screen.getByRole('status')).toHaveTextContent('Already using defaults.');
  });

  it('saves a full reset and empty prompt into the selected profile without detaching its identity', async () => {
    const source = captureProfile({ ...cfg, ctx_size: 12288 }, 'Source settings', 'model', 'Saved prompt');
    const application = materializeProfileApplication(cfg, 'Saved prompt', source);
    const saved = { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [source, defaultSettingsProfile()], applied: { [profileTargetKey(cfg.active_model)]: application } } };
    const { onProfileCommit } = mount({ initialConfig: saved, initialSection: 'profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const [draft, edit, applyTarget] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(draft).toMatchObject(resetProfileSettings(saved, false));
    expect(applyTarget).toBe(true);
    expect(edit.application.system_prompt).toBe('');
    expect(edit.application.profile_id).toBe(source.id);
    expect(edit.application.profile_name).toBe(source.name);
    expect(edit.library.entries).toEqual([expect.objectContaining({ id: source.id, name: source.name, revision: source.revision + 1, system_prompt: '', settings: expect.objectContaining({ runtime_defaults: expect.arrayContaining(['ctx_size', 'temperature']), chat_options: {} }) }), defaultSettingsProfile()]);
    const stored = edit.library.entries[0];
    expect(stored.settings).toEqual(edit.application.settings);
    expect(source.settings.ctx_size).toBe(12288);
    expect(source.system_prompt).toBe('Saved prompt');
  });
});
