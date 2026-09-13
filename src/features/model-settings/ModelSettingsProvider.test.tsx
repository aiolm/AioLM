import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestStore as createBaseTestStore } from '../../testing/appStore';
import type { AppConfig, SessionDefinition, SessionStatus } from '../../shared/api/types';
import type { AppStore } from '../../shared/state/store';
import { executionSettings } from '../../shared/config/executionSettings';
import { sessionConfig } from '../../shared/runtime/sessionUtils';
import { setSessionActivity } from '../../shared/state/sessionActivity';
import type { ModelSettingsDialogProps } from './ModelSettingsDialog';
import { ModelSettingsProvider, useModelSettings, type ModelSettingsContext, type ModelSettingsRequest } from './ModelSettingsProvider';
import { captureProfile, deleteSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey, setDefaultSettingsProfile } from '../../shared/config/settingsProfiles';
import { SettingsDeliveryError, type ProfileEditorResult } from './profileEditor';

const mocks = vi.hoisted(() => ({
  dialog: null as ModelSettingsDialogProps | null,
  sessionList: vi.fn(), serverStatus: vi.fn(), preflightLaunch: vi.fn(),
  sessionStart: vi.fn(), sessionStop: vi.fn(), applyRequestSettings: vi.fn(),
}));

vi.mock('./ModelSettingsDialog', () => ({ default: (props: ModelSettingsDialogProps) => {
  mocks.dialog = props;
  return <div data-testid="settings-dialog" />;
} }));
vi.mock('../../shared/i18n/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../../shared/api/index', () => ({
  isNativeRuntimeAvailable: () => false,
  sessionList: mocks.sessionList, serverStatus: mocks.serverStatus,
  normalizeSessionList: (value: SessionStatus[]) => value,
  preflightLaunch: mocks.preflightLaunch, sessionStart: mocks.sessionStart,
  sessionStop: mocks.sessionStop, applyRequestSettings: mocks.applyRequestSettings,
}));
let context: ModelSettingsContext;
function Consumer() { context = useModelSettings()!; return null; }

function createTestStore(overrides: Partial<AppConfig> = {}): AppStore {
  const store = createBaseTestStore(overrides);
  const cfg = store.cfg!;
  const oldProfile = { ...captureProfile(cfg, 'Old', 'global', 'Old prompt'), id: 'profile-old' };
  const newProfile = { ...captureProfile(cfg, 'New', 'global', 'New prompt'), id: 'profile-new' };
  cfg.settings_profiles ??= { ...emptyProfileLibrary(), revision: 1, legacy_imported: true, entries: [oldProfile, newProfile], applied: {
    [profileTargetKey(cfg.active_model)]: materializeProfileApplication(cfg, 'Old prompt', oldProfile),
    ...Object.fromEntries((cfg.sessions ?? []).map(definition => [profileTargetKey(definition.models.primary_model, definition.id), materializeProfileApplication(sessionConfig(cfg, definition), 'Old prompt', oldProfile)])),
  } };
  return store;
}

function editorResult(dialog: ModelSettingsDialogProps, cfg: AppConfig, profileId = 'profile-old'): ProfileEditorResult {
  const library = structuredClone(dialog.initialConfig.settings_profiles!);
  const profile = library.entries.find(entry => entry.id === profileId) ?? library.entries[0];
  return { baseRevision: library.revision, library, application: materializeProfileApplication(cfg, profile?.system_prompt ?? '', profile) };
}

function apply(dialog: ModelSettingsDialogProps, cfg: AppConfig, intent: 'save' | 'start', profileId = 'profile-old') {
  return dialog.onApply(cfg, intent, editorResult(dialog, cfg, profileId));
}

function namedSession(): SessionDefinition {
  return { id: 'work', name: 'Work', enabled: true, model_profile_id: 'profile-old',
    models: { primary_model: 'work.gguf', mmproj: '', draft_model: '' },
    gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null },
  };
}
async function open(store: AppStore, request: ModelSettingsRequest) {
  render(<ModelSettingsProvider store={store}><Consumer /></ModelSettingsProvider>);
  act(() => context.open(request));
  await waitFor(() => expect(mocks.dialog).not.toBeNull());
  return mocks.dialog!;
}
function running(cfg: AppConfig, id = 'default'): SessionStatus {
  return { id, name: id, state: 'running', model: cfg.active_model, active_requests: 0, idle_seconds: 0,
    execution: executionSettings(cfg), pid: 1234 };
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.dialog = null;
  mocks.sessionList.mockResolvedValue([]);
  mocks.serverStatus.mockResolvedValue({ state: 'stopped' });
  mocks.preflightLaunch.mockImplementation(async (cfg: AppConfig) => structuredClone(cfg));
  mocks.sessionStart.mockResolvedValue(undefined);
  mocks.applyRequestSettings.mockImplementation(async (cfg: AppConfig) => executionSettings(cfg));
});
afterEach(() => { cleanup(); setSessionActivity('work', false); setSessionActivity('default', false); });

describe('model settings target application', () => {
  it('reopens a saved stopped model with its selected profile and prompt', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    expect(dialog.requireModelSelection).toBe(false);
    expect(dialog.initialConfig.active_model).toBe('model.gguf');
    expect(dialog.initialApplication).toMatchObject({ profile_id: 'profile-old', system_prompt: 'Old prompt' });
    act(() => dialog.onClose());
    act(() => context.open({ target: { kind: 'default' } }));
    await waitFor(() => expect(mocks.dialog!.requireModelSelection).toBe(false));
    expect(mocks.dialog!.initialApplication).toMatchObject({ profile_id: 'profile-old', system_prompt: 'Old prompt' });
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('opens and cancels without configuration, profile, or lifecycle writes', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    act(() => dialog.onClose());
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled(); expect(store.stop).not.toHaveBeenCalled();
    expect(mocks.preflightLaunch).not.toHaveBeenCalled();
  });

  it('preserves settings saved for the next run when reopening the loaded model', async () => {
    const store = createTestStore({ ctx_size: 8192 });
    store.status = running({ ...store.cfg!, ctx_size: 4096 });
    mocks.serverStatus.mockResolvedValue(store.status);
    const dialog = await open(store, { target: { kind: 'default' } });
    expect(dialog.initialConfig.ctx_size).toBe(8192);
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save'); });
    expect(store.cfg).toMatchObject({ ctx_size: 8192, temperature: 0.2 });
    expect(store.start).not.toHaveBeenCalled();
  });

  it.each(['benchmark', 'project'] as const)('saves the selected profile before delivering %s settings without changing other targets', async kind => {
    const store = createTestStore();
    const previous = structuredClone(store.cfg!.settings_profiles!.applied);
    const onApply = vi.fn();
    const dialog = await open(store, { target: { kind, id: 'target' }, onApply });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, active_model: 'chosen.gguf', ctx_size: 8192, ngl: 7 }, 'save'); });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'chosen.gguf', ctx_size: 8192, ngl: 7 }), expect.objectContaining({ model: 'chosen.gguf', profile_id: 'profile-old', system_prompt: 'Old prompt' }));
    expect(store.cfg?.active_model).toBe('model.gguf');
    expect(store.cfg?.settings_profiles?.entries).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.entries[0]).toMatchObject({ id: 'profile-old', settings: { ngl: 7, ctx_size: kind === 'benchmark' ? 4096 : 8192 } });
    expect(store.cfg?.settings_profiles?.applied).toEqual(previous);
    expect(store.updateConfig).toHaveBeenCalledOnce(); expect(store.start).not.toHaveBeenCalled();
    expect(mocks.sessionStart).not.toHaveBeenCalled(); expect(mocks.preflightLaunch).not.toHaveBeenCalled();
  });

  it('saves named execution settings without changing the default target or shared profile assignment', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, temperature: 0.2, ctx_size: 8192 }, 'save', 'profile-new'); });
    expect(store.cfg).toMatchObject({ active_model: 'model.gguf', temperature: 0.8, ctx_size: 4096 });
    expect(store.cfg?.sessions?.[0]).toMatchObject({ id: 'work', execution: { temperature: 0.2, ctx_size: 8192 } });
    expect(store.cfg?.sessions?.[0]).not.toHaveProperty('model_profile_id');
    expect(store.cfg?.settings_profiles?.applied['session:work']).toMatchObject({ profile_id: 'profile-new', system_prompt: 'New prompt' });
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('model.gguf')].system_prompt).toBe('Old prompt');
    expect(mocks.sessionStart).not.toHaveBeenCalled();
  });

  it('rechecks session removal at the serialized save boundary', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const save = store.updateConfig;
    store.updateConfig = vi.fn(async patch => { store.cfg!.sessions = []; return save(patch); });
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await expect(apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save')).rejects.toThrow('removed'); });
    expect(store.cfg?.sessions).toEqual([]);
    expect(mocks.sessionStart).not.toHaveBeenCalled();
  });

  it('preserves a concurrent session rename and rejects overlapping tuning changes', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const save = store.updateConfig;
    store.updateConfig = vi.fn(async patch => {
      store.cfg!.sessions = [{ ...store.cfg!.sessions![0], name: 'Renamed elsewhere', execution: { temperature: 0.4 } }];
      return save(patch);
    });
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await expect(apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save')).rejects.toThrow('temperature'); });
    expect(store.cfg?.sessions?.[0]).toMatchObject({ name: 'Renamed elsewhere', execution: { temperature: 0.4 } });
  });

  it('merges a tuning edit with unrelated session metadata changed while saving', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const save = store.updateConfig;
    store.updateConfig = vi.fn(async patch => {
      store.cfg!.sessions = [{ ...store.cfg!.sessions![0], name: 'Renamed elsewhere', enabled: false }];
      return save(patch);
    });
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save'); });
    expect(store.cfg?.sessions?.[0]).toMatchObject({ name: 'Renamed elsewhere', enabled: false, execution: { temperature: 0.2 } });
  });

  it('rejects a stale profile revision at the serialized save boundary without saving execution changes', async () => {
    const store = createTestStore();
    const save = store.updateConfig;
    store.updateConfig = vi.fn(async patch => {
      store.cfg!.settings_profiles = { ...store.cfg!.settings_profiles!, revision: 2 };
      return save(patch);
    });
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await expect(apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save')).rejects.toThrow('Profiles changed elsewhere'); });
    expect(store.cfg?.temperature).toBe(0.8);
    expect(store.cfg?.settings_profiles?.revision).toBe(2);
    expect(store.start).not.toHaveBeenCalled();
  });

  it('saves profile edits before delivering project values while preserving other targets', async () => {
    const store = createTestStore();
    const onApply = vi.fn();
    const dialog = await open(store, { target: { kind: 'project', id: 'project' }, onApply });
    const draft = { ...dialog.initialConfig, active_model: 'project.gguf', temperature: 0.4 };
    const edit = editorResult(dialog, draft);
    edit.library.entries[0].name = 'Renamed';
    edit.application.system_prompt = 'Project prompt';
    await act(async () => { await dialog.onApply(draft, 'save', edit); });
    expect(store.updateConfig).toHaveBeenCalledOnce();
    expect(store.cfg).toMatchObject({ active_model: 'model.gguf', temperature: 0.8 });
    expect(store.cfg?.settings_profiles?.entries[0].name).toBe('Renamed');
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('model.gguf')].system_prompt).toBe('Old prompt');
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'project.gguf', temperature: 0.4 }), expect.objectContaining({ system_prompt: 'Project prompt' }));
    expect(store.start).not.toHaveBeenCalled();
  });

  it.each(['project', 'benchmark'] as const)('does not deliver %s options when the profile save fails', async kind => {
    const store = createTestStore();
    const previous = structuredClone(store.cfg);
    vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error('profile save failed'));
    const onApply = vi.fn();
    const dialog = await open(store, { target: { kind, id: 'target' }, onApply });
    await act(async () => {
      await expect(apply(dialog, { ...dialog.initialConfig, ngl: 7 }, 'save')).rejects.toThrow('profile save failed');
    });
    expect(store.cfg).toEqual(previous);
    expect(onApply).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('selects saved profile values without publishing model-only draft options', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, temperature: 0.2 };
    const edit = editorResult(dialog, draft, 'profile-new');
    edit.application.system_prompt = 'Unsaved prompt';
    await act(async () => { await dialog.onProfileCommit(draft, edit, true); });
    expect(store.cfg?.temperature).toBe(0.8);
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('model.gguf')]).toMatchObject({
      profile_id: 'profile-new', settings: { temperature: 0.8 }, system_prompt: 'New prompt',
    });
    expect(store.cfg?.settings_profiles?.entries).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.entries[1]).toMatchObject({ settings: { temperature: 0.8 }, system_prompt: 'New prompt' });
  });

  it('opens full saved settings for another model using the same selected profile', async () => {
    const store = createTestStore();
    const profile = store.cfg!.settings_profiles!.entries[0];
    store.cfg!.settings_profiles!.applied[profileTargetKey('other.gguf')] = materializeProfileApplication({ ...store.cfg!, active_model: 'other.gguf' }, 'Old prompt', profile);
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, active_backend: 'cuda', active_build: 'b456', ngl: 7 };
    const edit = editorResult(dialog, draft);
    edit.application.system_prompt = 'Saved shared prompt';
    await act(async () => { await dialog.onApply(draft, 'save', edit); });
    act(() => context.open({ target: { kind: 'default' }, config: { ...store.cfg!, active_model: 'other.gguf' } }));
    expect(mocks.dialog!.initialConfig).toMatchObject({ active_model: 'other.gguf', active_backend: 'cuda', active_build: 'b456', ngl: 7 });
    expect(mocks.dialog!.initialApplication).toMatchObject({ profile_id: 'profile-old', system_prompt: 'Saved shared prompt' });
    expect(store.cfg?.settings_profiles?.entries).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('other.gguf')]).toMatchObject({ settings: { ngl: 0 }, system_prompt: 'Old prompt' });
  });
});

describe('profile actions within an open editor', () => {
  it('designates a default without saving or applying unsaved execution values', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, temperature: 1.2 };
    const edit = editorResult(dialog, draft);
    edit.library = setDefaultSettingsProfile(edit.library, 'profile-new');
    await act(async () => { await dialog.onProfileCommit(draft, edit, false); });
    expect(store.cfg?.settings_profiles?.default_profile_id).toBe('profile-new');
    expect(store.cfg?.temperature).toBe(0.8);
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('model.gguf')].profile_id).toBe('profile-old');
    expect(store.cfg?.settings_profiles?.entries[1].settings.temperature).toBe(0.8);
    expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
  });

  it('deletes a used profile and moves active and saved session settings to the default without restarting', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const library = store.cfg!.settings_profiles!;
    library.default_profile_id = 'profile-new';
    library.entries[1].settings.temperature = 0.25;
    const live = running(store.cfg!); store.status = live;
    const dialog = await open(store, { target: { kind: 'default' } });
    const edit = editorResult(dialog, dialog.initialConfig);
    edit.library = deleteSettingsProfile(edit.library, 'profile-old');
    await act(async () => {
      const saved = await dialog.onProfileCommit(dialog.initialConfig, edit, false);
      expect(saved.application).toMatchObject({ profile_id: 'profile-new', system_prompt: 'New prompt', settings: { temperature: 0.25 } });
    });
    expect(store.cfg?.temperature).toBe(0.25);
    expect(store.cfg?.sessions?.[0]).toMatchObject({ id: 'work', name: 'Work', enabled: true, execution: { temperature: 0.25 } });
    expect(store.cfg?.settings_profiles?.applied['session:work']).toMatchObject({ profile_id: 'profile-new', system_prompt: 'New prompt' });
    const requestConfig = context.getRequestConfig('default', store.cfg!, live);
    expect(requestConfig).toMatchObject({ temperature: 0.25, ctx_size: live.execution!.ctx_size });
    expect(context.getRequestProfile('default', requestConfig)).toMatchObject({ id: 'profile-new', temperature: 0.25, system_prompt: 'New prompt' });
    expect(store.start).not.toHaveBeenCalled(); expect(mocks.sessionStart).not.toHaveBeenCalled();
    expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
    act(() => dialog.onClose());
    act(() => context.open({ target: { kind: 'session', sessionId: 'work' } }));
    expect(mocks.dialog?.initialConfig.temperature).toBe(0.25);
    expect(mocks.dialog?.initialApplication?.profile_id).toBe('profile-new');
  });

  it('opens a project with a deleted profile using default values and prompt', async () => {
    const store = createTestStore();
    const removed = { ...materializeProfileApplication({ ...store.cfg!, temperature: 1.2 }, 'Deleted prompt', store.cfg!.settings_profiles!.entries[1]), profile_id: 'removed' };
    const dialog = await open(store, { target: { kind: 'project', id: 'project' }, config: { ...store.cfg!, temperature: 1.2 }, application: removed });
    expect(dialog.initialConfig.temperature).toBe(0.8);
    expect(dialog.initialApplication).toMatchObject({ profile_id: 'profile-old', system_prompt: 'Old prompt' });
    expect(dialog.initialConfig.settings_profiles?.entries).toHaveLength(2);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each(['project', 'benchmark'] as const)('delivers default replacement to a %s editor when its profile is deleted', async kind => {
    const store = createTestStore();
    store.cfg!.settings_profiles!.default_profile_id = 'profile-new';
    store.cfg!.settings_profiles!.entries[1].settings.temperature = 0.25;
    const target = { ...store.cfg!, active_model: 'target.gguf', temperature: 1.2 };
    const application = materializeProfileApplication(target, 'Old prompt', store.cfg!.settings_profiles!.entries[0]);
    const onApply = vi.fn();
    const dialog = await open(store, { target: { kind, id: 'target' }, config: target, application, onApply });
    const edit = editorResult(dialog, dialog.initialConfig);
    edit.library = deleteSettingsProfile(edit.library, 'profile-old');
    await act(async () => { await dialog.onProfileCommit(dialog.initialConfig, edit, false); });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'target.gguf', temperature: 0.25 }), expect.objectContaining({ profile_id: 'profile-new', system_prompt: 'New prompt' }));
    expect(store.cfg?.settings_profiles?.entries.map(entry => entry.id)).toEqual(['profile-new']);
    expect(mocks.dialog?.initialConfig.active_model).toBe('target.gguf');
    const reloaded = await mocks.dialog!.onReloadProfile('target.gguf');
    expect(reloaded.config.settings_profiles?.entries.map(entry => entry.id)).toEqual(['profile-new']);
    expect(reloaded.application.profile_id).toBe('profile-new');
    expect(store.start).not.toHaveBeenCalled();
  });

  it('persists and applies a profile without closing the editor or restarting the model', async () => {
    const store = createTestStore();
    store.cfg!.settings_profiles!.entries[1].settings.temperature = 0.2;
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, temperature: 0.2 };
    let saved: Awaited<ReturnType<ModelSettingsDialogProps['onProfileCommit']>> | undefined;
    await act(async () => { saved = await dialog.onProfileCommit(draft, editorResult(dialog, draft, 'profile-new'), true); });
    expect(saved?.config.temperature).toBe(0.2);
    expect(saved?.application.profile_id).toBe('profile-new');
    expect(store.cfg?.settings_profiles?.revision).toBe(2);
    expect(mocks.applyRequestSettings).toHaveBeenCalledOnce();
    expect(context.getRequestProfile('default', store.cfg!)?.system_prompt).toBe('New prompt');
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
    expect(store.start).not.toHaveBeenCalled();
    expect(mocks.preflightLaunch).not.toHaveBeenCalled();
  });

  it('saves library changes without publishing unsaved editor values or profile selection', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, temperature: 0.1, ctx_size: 32768 };
    const edit = editorResult(dialog, draft, 'profile-new');
    edit.library.entries[1].name = 'Renamed';
    let saved: Awaited<ReturnType<ModelSettingsDialogProps['onProfileCommit']>> | undefined;
    await act(async () => { saved = await dialog.onProfileCommit(draft, edit, false); });
    expect(store.cfg).toMatchObject({ temperature: 0.8, ctx_size: 4096 });
    expect(saved?.config).toMatchObject({ temperature: 0.8, ctx_size: 4096 });
    expect(saved?.application.profile_id).toBe('profile-old');
    expect(store.cfg?.settings_profiles?.entries[1].name).toBe('Renamed');
    expect(mocks.sessionList).not.toHaveBeenCalled();
    expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
    act(() => mocks.dialog!.onClose());
    expect(store.cfg?.settings_profiles?.entries[1].name).toBe('Renamed');
  });

  it('reloads the latest saved profile without rewriting the previous target snapshot', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    store.cfg!.settings_profiles!.entries[0].settings.temperature = 1.4;
    store.cfg!.settings_profiles!.entries[0].system_prompt = 'Changed reusable prompt';
    let result!: Awaited<ReturnType<ModelSettingsDialogProps['onReloadProfile']>>;
    await act(async () => { result = await dialog.onReloadProfile('model.gguf'); });
    expect(result.config.temperature).toBe(1.4);
    expect(result.application.system_prompt).toBe('Changed reusable prompt');
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('model.gguf')]).toMatchObject({ settings: { temperature: 0.8 }, system_prompt: 'Old prompt' });
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('reloads another model using its assigned profile instead of stale target options', async () => {
    const store = createTestStore();
    const other = { ...store.cfg!, active_model: 'other.gguf', ctx_size: 16384, temperature: 0.3 };
    store.cfg!.settings_profiles!.applied[profileTargetKey(other.active_model)] = materializeProfileApplication(other, 'Other model prompt', store.cfg!.settings_profiles!.entries[0]);
    const dialog = await open(store, { target: { kind: 'default' } });
    let result!: Awaited<ReturnType<ModelSettingsDialogProps['onReloadProfile']>>;
    await act(async () => { result = await dialog.onReloadProfile('other.gguf'); });
    expect(result.config).toMatchObject({ active_model: 'other.gguf', ctx_size: 4096, temperature: 0.8 });
    expect(result.application).toMatchObject({ profile_id: 'profile-old', system_prompt: 'Old prompt' });
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey(other.active_model)].settings.ctx_size).toBe(16384);
    expect(store.cfg?.active_model).toBe('model.gguf');
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps the selected model when applying after its saved settings are reloaded', async () => {
    const store = createTestStore();
    const other = { ...store.cfg!, active_model: 'other.gguf', ctx_size: 16384, temperature: 0.3 };
    store.cfg!.settings_profiles!.applied[profileTargetKey(other.active_model)] = materializeProfileApplication(other, 'Other model prompt', store.cfg!.settings_profiles!.entries[0]);
    const dialog = await open(store, { target: { kind: 'default' } });
    let result: Awaited<ReturnType<ModelSettingsDialogProps['onReloadProfile']>> | undefined;
    await act(async () => { result = await dialog.onReloadProfile('other.gguf'); });
    const saved = result!;
    const edit = { baseRevision: saved.config.settings_profiles!.revision, library: structuredClone(saved.config.settings_profiles!), application: saved.application };
    await act(async () => { await mocks.dialog!.onProfileCommit(saved.config, edit, true); });
    expect(store.cfg).toMatchObject({ active_model: 'other.gguf', ctx_size: 4096, temperature: 0.8 });
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('other.gguf')]).toMatchObject({ profile_id: 'profile-old', system_prompt: 'Old prompt' });
  });

  it.each(['project', 'benchmark'] as const)('keeps immediate %s delivery inside its target', async kind => {
    const store = createTestStore();
    const onApply = vi.fn();
    const dialog = await open(store, { target: { kind, id: 'target' }, onApply });
    const draft = { ...dialog.initialConfig, active_model: 'target.gguf', ngl: 7 };
    const edit = editorResult(dialog, draft, 'profile-new');
    edit.saveMode = kind === 'benchmark' ? 'benchmark' : 'all';
    edit.library.entries[1].name = 'Changed';
    await act(async () => { await dialog.onProfileCommit(draft, edit, true); });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'target.gguf', ngl: 7 }), expect.objectContaining({ profile_id: 'profile-new', system_prompt: 'New prompt' }));
    expect(store.cfg).toMatchObject({ active_model: 'model.gguf', ctx_size: 4096 });
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('model.gguf')].profile_id).toBe('profile-old');
    expect(store.cfg?.settings_profiles?.entries[1].name).toBe('Changed');
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
    let reloaded!: Awaited<ReturnType<ModelSettingsDialogProps['onReloadProfile']>>;
    await act(async () => { reloaded = await mocks.dialog!.onReloadProfile('target.gguf'); });
    expect(reloaded.config).toMatchObject({ active_model: 'target.gguf', ngl: 7 });
    expect(reloaded.application.system_prompt).toBe('New prompt');
    expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
  });

  it('retains a successful immediate save when request delivery fails and retries from that revision', async () => {
    const store = createTestStore();
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    mocks.applyRequestSettings.mockRejectedValueOnce(new Error('request delivery failed'));
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, temperature: 0.2 };
    let failure: unknown;
    await act(async () => { try { await dialog.onProfileCommit(draft, { ...editorResult(dialog, draft, 'profile-new'), saveMode: 'all' }, true); } catch (cause) { failure = cause; } });
    expect(failure).toBeInstanceOf(SettingsDeliveryError);
    const saved = failure as SettingsDeliveryError;
    expect(store.cfg?.temperature).toBe(0.2);
    expect(context.getRequestProfile('default', dialog.initialConfig)?.system_prompt).toBe('Old prompt');
    const edit = { baseRevision: saved.saved.settings_profiles!.revision, library: structuredClone(saved.saved.settings_profiles!), application: saved.application };
    await act(async () => { await mocks.dialog!.onProfileCommit(saved.saved, edit, true); });
    expect(store.cfg?.settings_profiles?.revision).toBe(3);
    expect(store.cfg?.settings_profiles?.entries).toHaveLength(2);
    expect(context.getRequestProfile('default', store.cfg!)?.system_prompt).toBe('New prompt');
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('preserves a project target when its library save succeeds but target delivery fails', async () => {
    const store = createTestStore();
    const onApply = vi.fn().mockRejectedValueOnce(new Error('project save failed'));
    const dialog = await open(store, { target: { kind: 'project', id: 'project' }, onApply });
    const draft = { ...dialog.initialConfig, temperature: 0.2 };
    const edit = editorResult(dialog, draft, 'profile-new');
    edit.library.entries[1].name = 'Renamed';
    let failure: unknown;
    await act(async () => { try { await dialog.onProfileCommit(draft, edit, true); } catch (cause) { failure = cause; } });
    expect(failure).toBeInstanceOf(SettingsDeliveryError);
    expect(store.cfg?.settings_profiles?.revision).toBe(2);
    expect(store.cfg?.settings_profiles?.entries[1].name).toBe('Renamed');
    const restored = await mocks.dialog!.onReloadProfile('model.gguf');
    expect(restored.config.temperature).toBe(0.8);
    expect(restored.config.settings_profiles?.revision).toBe(2);
    expect(restored.application.system_prompt).toBe('Old prompt');
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });
});

describe('model launch preparation', () => {
  it('keeps a running model and saved configuration intact when preflight fails', async () => {
    const store = createTestStore();
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    mocks.preflightLaunch.mockRejectedValueOnce(new Error('missing model shard'));
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await expect(apply(dialog, { ...dialog.initialConfig, active_model: 'replacement.gguf' }, 'start')).rejects.toThrow('missing model shard'); });
    expect(store.updateConfig).not.toHaveBeenCalled(); expect(store.stop).not.toHaveBeenCalled(); expect(store.start).not.toHaveBeenCalled();
    expect(store.cfg?.active_model).toBe('model.gguf');
  });

  it('launches normalized settings through native replacement without stopping first', async () => {
    const store = createTestStore();
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    mocks.preflightLaunch.mockImplementationOnce(async (cfg: AppConfig) => ({ ...cfg, ctx_size: 512 }));
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, ctx_size: 200 }, 'start'); });
    expect(store.cfg?.ctx_size).toBe(512);
    expect(store.cfg?.settings_profiles?.entries).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.entries[0]).toMatchObject({ id: 'profile-old', settings: { ctx_size: 512 } });
    expect(store.start).toHaveBeenCalledWith(expect.objectContaining({ ctx_size: 512 }), true);
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('blocks a default launch that would interrupt another active response', async () => {
    const store = createTestStore({ stop_existing_sessions_on_load: true });
    const dialog = await open(store, { target: { kind: 'default' } });
    setSessionActivity('work', true);
    await act(async () => { await expect(apply(dialog, dialog.initialConfig, 'start')).rejects.toThrow('current response'); });
    expect(mocks.preflightLaunch).not.toHaveBeenCalled(); expect(store.start).not.toHaveBeenCalled();
  });

  it('retains a successful save if starting the selected model fails', async () => {
    const store = createTestStore();
    vi.mocked(store.start).mockRejectedValueOnce(new Error('runtime failed'));
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await expect(apply(dialog, { ...dialog.initialConfig, active_model: 'replacement.gguf' }, 'start')).rejects.toThrow('runtime failed'); });
    expect(store.cfg?.active_model).toBe('replacement.gguf');
    expect(mocks.dialog).not.toBeNull();
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('retries a failed post-save launch from the committed profile revision without duplicate profiles', async () => {
    const store = createTestStore();
    vi.mocked(store.start).mockRejectedValueOnce(new Error('runtime failed'));
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, active_model: 'replacement.gguf', ctx_size: 8192 };
    let failure: unknown;
    await act(async () => { try { await apply(dialog, draft, 'start', 'profile-new'); } catch (cause) { failure = cause; } });
    expect(failure).toBeInstanceOf(SettingsDeliveryError);
    const saved = failure as SettingsDeliveryError;
    expect(saved.saved.settings_profiles?.revision).toBe(2);
    expect(saved.application.system_prompt).toBe('New prompt');
    const edit: ProfileEditorResult = { baseRevision: saved.saved.settings_profiles!.revision, library: structuredClone(saved.saved.settings_profiles!), application: saved.application };
    await act(async () => { await mocks.dialog!.onApply(saved.saved, 'start', edit); });
    expect(store.start).toHaveBeenCalledTimes(2);
    expect(store.cfg?.settings_profiles?.revision).toBe(3);
    expect(store.cfg?.settings_profiles?.entries).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.applied[profileTargetKey('replacement.gguf')].system_prompt).toBe('New prompt');
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('keeps live request settings and profile when changes are saved for the next run', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const liveConfig = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    const live = running(liveConfig, 'work');
    mocks.sessionList.mockResolvedValue([live]);
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, ctx_size: 8192, temperature: 0.2 }, 'save', 'profile-new'); });
    const saved = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    expect(saved).toMatchObject({ ctx_size: 8192, temperature: 0.2 });
    expect(context.getRequestConfig('work', saved, live)).toMatchObject({ ctx_size: 4096, temperature: 0.8 });
    expect(context.getRequestProfile('work', liveConfig)?.system_prompt).toBe('Old prompt');
    expect(store.cfg?.settings_profiles?.applied['session:work']).toMatchObject({ profile_id: 'profile-new', system_prompt: 'New prompt' });
    expect(mocks.applyRequestSettings).not.toHaveBeenCalled(); expect(mocks.sessionStart).not.toHaveBeenCalled();
  });

  it('applies request-only edits to the running target without restarting its process', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const liveConfig = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    mocks.sessionList.mockResolvedValue([running(liveConfig, 'work')]);
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save'); });
    expect(mocks.applyRequestSettings).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'work.gguf', temperature: 0.2 }), 'work');
    expect(mocks.sessionStart).not.toHaveBeenCalled(); expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled(); expect(mocks.preflightLaunch).not.toHaveBeenCalled();
    expect(store.cfg?.temperature).toBe(0.8);
  });

  it('applies a prompt-only edit to the next request without restarting a running model', async () => {
    const store = createTestStore();
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    const dialog = await open(store, { target: { kind: 'default' } });
    const edit = editorResult(dialog, dialog.initialConfig);
    edit.application.system_prompt = 'Only the prompt changed';
    await act(async () => { await dialog.onApply(dialog.initialConfig, 'save', edit); });
    expect(mocks.applyRequestSettings).toHaveBeenCalledOnce();
    expect(context.getRequestProfile('default', store.cfg!)?.system_prompt).toBe('Only the prompt changed');
    expect(store.start).not.toHaveBeenCalled();
    expect(store.cfg?.settings_profiles?.entries[0].system_prompt).toBe('Only the prompt changed');
  });

  it('uses the saved profile after another entry point restarts the same model', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const liveConfig = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    const live = running(liveConfig, 'work');
    mocks.sessionList.mockResolvedValue([live]);
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, ctx_size: 8192 }, 'save', 'profile-new'); });
    expect(context.getRequestProfile('work', liveConfig)?.system_prompt).toBe('Old prompt');
    const restarted = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    context.getRequestConfig('work', restarted, { ...running(restarted, 'work'), pid: 5678 });
    expect(context.getRequestProfile('work', restarted)?.system_prompt).toBe('New prompt');
  });

  it('shows the new running profile after an external restart without visiting chat', async () => {
    const store = createTestStore();
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, ctx_size: 8192 }, 'save', 'profile-new'); });
    store.status = { ...running(store.cfg!), pid: 5678 };
    act(() => context.open({ target: { kind: 'default' } }));
    expect(mocks.dialog?.liveApplication?.system_prompt).toBe('New prompt');
    expect(mocks.dialog?.liveApplication?.profile_id).toBe('profile-new');
  });
});
