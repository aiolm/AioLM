import { Component, StrictMode, type ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestStore as createBaseTestStore } from '../../testing/appStore';
import type { AppConfig, SessionDefinition, SessionStatus } from '../../shared/api/types';
import type { AppStore } from '../../shared/state/store';
import { executionConfig, executionSettings, settingsForSession } from '../../shared/config/executionSettings';
import { sessionConfig, notifySessionStatusChanged } from '../../shared/runtime/sessionUtils';
import { setSessionActivity } from '../../shared/state/sessionActivity';
import type { ModelSettingsDialogProps } from './ModelSettingsDialog';
import { MANAGE_MODEL_RUNTIMES, ModelSettingsProvider, useModelSettings, type ModelSettingsContext, type ModelSettingsRequest } from './ModelSettingsProvider';
import { applySettingsProfile, captureProfile, deleteSettingsProfile, emptyProfileLibrary, ensureProfileLibrary, materializeProfileApplication, profileSettingsSnapshot, profileTargetKey, setDefaultSettingsProfile } from '../../shared/config/settingsProfiles';
import { profileLibraryConfigPatch, requestProfileFromApplication, SettingsDeliveryError, type ProfileEditorResult } from './profileEditor';
import { createConfigSaveQueue } from '../../shared/state/configSaveQueue';

const mocks = vi.hoisted(() => ({
  dialog: null as ModelSettingsDialogProps | null, native: false, renders: 0, locale: 'en' as 'en' | 'ko',
  sessionList: vi.fn(), serverStatus: vi.fn(), preflightLaunch: vi.fn(), cancelLaunchPreflight: vi.fn(),
  sessionStart: vi.fn(), sessionStop: vi.fn(), applyRequestSettings: vi.fn(),
}));

vi.mock('./ModelSettingsDialog', () => ({ default: (props: ModelSettingsDialogProps) => {
  mocks.dialog = props;
  mocks.renders += 1;
  return <div data-testid="settings-dialog" />;
} }));
vi.mock('../runtimes/Runtimes', () => ({ default: ({ engineRequest }: { engineRequest: { provider: string } }) => <p>Inline runtime manager: {engineRequest.provider}</p> }));
vi.mock('../../shared/i18n/i18n', () => ({ useI18n: () => ({ locale: mocks.locale, t: (key: string) => key }) }));
vi.mock('../../shared/api/index', () => ({
  isNativeRuntimeAvailable: () => mocks.native,
  sessionList: mocks.sessionList, serverStatus: mocks.serverStatus,
  normalizeSessionList: (value: SessionStatus[]) => value,
  preflightLaunch: mocks.preflightLaunch, cancelLaunchPreflight: mocks.cancelLaunchPreflight, sessionStart: mocks.sessionStart,
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
async function pollSessions() {
  const calls = mocks.sessionList.mock.calls.length;
  await act(async () => {
    notifySessionStatusChanged();
    await vi.waitFor(() => expect(mocks.sessionList.mock.calls.length).toBeGreaterThan(calls));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
async function initialPoll() {
  await waitFor(() => expect(mocks.sessionList).toHaveBeenCalled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.dialog = null; mocks.native = false; mocks.renders = 0; mocks.locale = 'en';
  mocks.sessionList.mockResolvedValue([]);
  mocks.serverStatus.mockResolvedValue({ state: 'stopped' });
  mocks.preflightLaunch.mockImplementation(async (cfg: AppConfig) => structuredClone(cfg));
  mocks.cancelLaunchPreflight.mockResolvedValue(undefined);
  mocks.sessionStart.mockResolvedValue(undefined);
  mocks.sessionStop.mockResolvedValue(undefined);
  mocks.applyRequestSettings.mockImplementation(async (cfg: AppConfig) => executionSettings(cfg));
});
afterEach(() => { cleanup(); setSessionActivity('work', false); setSessionActivity('default', false); });

describe('model settings target application', () => {
  it('requires an external candidate to pass the selected runtime preflight before saving or launching', async () => {
    const store = createTestStore({ active_provider: 'custom.example', active_runtime: 'specific-build', active_model: 'deployment.json' });
    const dialog = await open(store, { target: { kind: 'default' } });
    const before = structuredClone(store.cfg);
    mocks.preflightLaunch.mockRejectedValueOnce(new Error('Selected runtime rejected this model'));
    await expect(apply(dialog, dialog.initialConfig, 'start')).rejects.toThrow('Selected runtime rejected this model');
    expect(mocks.preflightLaunch).toHaveBeenCalledWith(expect.objectContaining({ active_provider: 'custom.example', active_runtime: 'specific-build', active_model: 'deployment.json' }), expect.any(String));
    expect(store.cfg).toEqual(before);
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    expect(mocks.sessionStart).not.toHaveBeenCalled();
  });
  it('cancels the pending preflight without saving its late result or stopping another target, then retries with a new owner', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const dialog = await open(store, { target: { kind: 'default' } });
    const before = structuredClone(store.cfg);
    let finish!: (cfg: AppConfig) => void;
    mocks.preflightLaunch.mockImplementationOnce(() => new Promise<AppConfig>(resolve => { finish = resolve; }));
    let result!: Promise<unknown>;
    act(() => { result = apply(dialog, dialog.initialConfig, 'start').then(() => undefined, cause => cause); });
    await waitFor(() => expect(mocks.preflightLaunch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.dialog?.onCancelStart).toBeTypeOf('function'));
    const owner = mocks.preflightLaunch.mock.calls[0][1];
    expect(owner).toBeTypeOf('string');
    act(() => { mocks.dialog!.onCancelStart!(); });
    await waitFor(() => expect(mocks.cancelLaunchPreflight).toHaveBeenCalledWith(owner));
    let outcome: unknown;
    await act(async () => { finish({ ...dialog.initialConfig, ctx_size: 512 }); outcome = await result; });
    expect(String(outcome)).toContain('server start cancelled');
    expect(store.cfg).toEqual(before);
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    expect(mocks.sessionStart).not.toHaveBeenCalled();
    expect(mocks.sessionStop).not.toHaveBeenCalled();
    await act(async () => { await apply(mocks.dialog!, dialog.initialConfig, 'start'); });
    expect(mocks.preflightLaunch).toHaveBeenCalledTimes(2);
    expect(mocks.preflightLaunch.mock.calls[1][1]).not.toBe(owner);
    expect(store.start).toHaveBeenCalledTimes(1);
    expect(mocks.cancelLaunchPreflight).toHaveBeenCalledTimes(1);
  });
  it('opens and saves a loaded snapshot without replacing its path with the public engine alias', async () => {
    const path = '/synthetic/cache/models--community--Qwen-model/snapshots/' + 'a'.repeat(40);
    const store = createTestStore({ active_model: path, active_provider: 'vllm', active_runtime: 'synthetic-runtime' });
    const library = store.cfg!.settings_profiles!;
    library.applied = Object.fromEntries(Object.values(library.applied).map(application => [profileTargetKey(application.model, 'default', 'vllm'), application]));
    store.status = { ...running(store.cfg!), model: 'served-alias' };
    mocks.serverStatus.mockResolvedValue(store.status);
    const dialog = await open(store, { target: { kind: 'default' } });
    expect(dialog.initialConfig.active_model).toBe(path);
    expect(context.getRequestConfig('default', { ...store.cfg!, active_model: '/synthetic/next-model' }, store.status).active_model).toBe(path);
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save'); });
    expect(store.cfg?.active_model).toBe(path);
    expect(mocks.preflightLaunch).not.toHaveBeenCalled();
    expect(store.status.model).toBe('served-alias');
  });
  it('opens runtime management for the edited engine without persisting the draft', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    const listener = vi.fn();
    window.addEventListener(MANAGE_MODEL_RUNTIMES, listener);
    try {
      const manager = dialog.renderRuntimeManager?.({ config: { ...store.cfg!, active_provider: 'vllm', active_runtime: 'synthetic-metal' }, revision: 1, active: true, onBusyChange: vi.fn() });
      await act(async () => { render(manager); });
      expect(await screen.findByText('Inline runtime manager: vllm')).toBeVisible();
      expect(listener).not.toHaveBeenCalled();
      expect(context.suspended).toBe(false);
      expect(store.updateConfig).not.toHaveBeenCalled();
    } finally { window.removeEventListener(MANAGE_MODEL_RUNTIMES, listener); }
  });
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ id: 'profile-old', settings: { ngl: 7, ctx_size: kind === 'benchmark' ? 4096 : 8192 } });
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0].name).toBe('Renamed');
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[1]).toMatchObject({ settings: { temperature: 0.8 }, system_prompt: 'New prompt' });
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[1].settings.temperature).toBe(0.8);
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
    expect(dialog.initialConfig.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').map(entry => entry.id)).toEqual(['profile-new']);
    expect(mocks.dialog?.initialConfig.active_model).toBe('target.gguf');
    const reloaded = await mocks.dialog!.onReloadProfile('target.gguf');
    expect(reloaded.config.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').map(entry => entry.id)).toEqual(['profile-new']);
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[1].name).toBe('Renamed');
    expect(mocks.sessionList).not.toHaveBeenCalled();
    expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
    act(() => mocks.dialog!.onClose());
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[1].name).toBe('Renamed');
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[1].name).toBe('Changed');
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[1].name).toBe('Renamed');
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toMatchObject({ id: 'profile-old', settings: { ctx_size: 512 } });
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

  it('stops the default target from inside the dialog', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    act(() => dialog.onStop!());
    expect(store.stop).toHaveBeenCalledOnce();
  });

  it('stops a session target from inside the dialog', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    act(() => dialog.onStop!());
    expect(mocks.sessionStop).toHaveBeenCalledWith('work');
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('keeps settings savable mid-transition and defers only the launch', async () => {
    const store = createTestStore();
    mocks.serverStatus.mockResolvedValue({ state: 'starting' });
    const dialog = await open(store, { target: { kind: 'default' } });
    // Two overlapping launches would race over the same process...
    await act(async () => { await expect(apply(dialog, dialog.initialConfig, 'start')).rejects.toThrow('Wait for the current model operation'); });
    expect(store.start).not.toHaveBeenCalled();
    // ...but writing settings for the next load does not, and refusing that is
    // what made the dialog useless for the length of a VRAM load.
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, temperature: 0.2 }, 'save'); });
    expect(store.cfg?.temperature).toBe(0.2);
  });

  it('closes as soon as a launch is issued, leaving the load to finish on its own', async () => {
    // Reading a model into VRAM takes minutes, and this dialog is modal: waiting
    // for the load here put an unusable overlay over the whole app for that long.
    const store = createTestStore();
    let resolveStart = () => {};
    vi.mocked(store.start).mockReturnValueOnce(new Promise<string>(resolve => { resolveStart = () => resolve(''); }));
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, active_model: 'replacement.gguf' }, 'start'); });
    expect(store.start).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument());
    await act(async () => { resolveStart(); });
  });

  it('retains a successful save if starting the selected model fails', async () => {
    const store = createTestStore();
    vi.mocked(store.start).mockRejectedValueOnce(new Error('runtime failed'));
    const dialog = await open(store, { target: { kind: 'default' } });
    // The launch is reported by the store's own status and error banner, so the
    // failure no longer has to keep a dialog open to be seen.
    await act(async () => { await apply(dialog, { ...dialog.initialConfig, active_model: 'replacement.gguf' }, 'start'); });
    expect(store.cfg?.active_model).toBe('replacement.gguf');
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('retries a failed launch from the committed profile revision without duplicate profiles', async () => {
    const store = createTestStore();
    vi.mocked(store.start).mockRejectedValueOnce(new Error('runtime failed'));
    const dialog = await open(store, { target: { kind: 'default' } });
    const draft = { ...dialog.initialConfig, active_model: 'replacement.gguf', ctx_size: 8192 };
    await act(async () => { await apply(dialog, draft, 'start', 'profile-new'); });
    expect(store.cfg?.settings_profiles?.revision).toBe(2);
    await waitFor(() => expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument());

    // Reopening reads the library the first attempt committed, so the retry edits
    // that profile instead of saving a second copy of it.
    act(() => context.open({ target: { kind: 'default' } }));
    await waitFor(() => expect(screen.getByTestId('settings-dialog')).toBeInTheDocument());
    const reopened = mocks.dialog!;
    expect(reopened.initialApplication?.system_prompt).toBe('New prompt');
    await act(async () => { await apply(reopened, reopened.initialConfig, 'start', 'profile-new'); });
    expect(store.start).toHaveBeenCalledTimes(2);
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(2);
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
    expect(store.cfg?.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0].system_prompt).toBe('Only the prompt changed');
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

describe('session polling', () => {
  it('skips editor renders when a poll only changes usage counters and delivers lifecycle changes', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const cfg = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    mocks.native = true;
    let idle = 0;
    mocks.sessionList.mockImplementation(async () => [{ ...running(cfg, 'work'), idle_seconds: ++idle, active_requests: idle % 2 }]);
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await initialPoll();
    const renders = mocks.renders;
    const props = mocks.dialog;
    await pollSessions();
    await pollSessions();
    await pollSessions();
    expect(mocks.renders).toBe(renders);
    expect(mocks.dialog).toBe(props);
    expect(dialog.liveState).toBe('running');

    mocks.sessionList.mockResolvedValue([{ ...running({ ...cfg, temperature: 0.4 }, 'work'), state: 'starting' }]);
    await pollSessions();
    expect(mocks.renders).toBe(renders + 1);
    expect(mocks.dialog?.liveState).toBe('starting');
    expect(mocks.dialog?.liveConfig?.temperature).toBe(0.4);
  });

  it('keeps another target current for a later session editor opened after the poll', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const cfg = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    mocks.native = true;
    mocks.sessionList.mockResolvedValue([running(cfg, 'work')]);
    await open(store, { target: { kind: 'default' } });
    await initialPoll();

    mocks.sessionList.mockResolvedValue([{ ...running({ ...cfg, temperature: 0.3 }, 'work'), state: 'starting', pid: 5678 }]);
    await pollSessions();
    act(() => context.open({ target: { kind: 'session', sessionId: 'work' } }));
    await waitFor(() => expect(mocks.dialog?.liveState).toBe('starting'));
    expect(mocks.dialog?.liveConfig?.temperature).toBe(0.3);
  });

  it('delivers nested execution changes when the same session object is reused in StrictMode', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const cfg = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    const status = running(cfg, 'work');
    mocks.native = true;
    mocks.sessionList.mockResolvedValue([status]);
    render(<StrictMode><ModelSettingsProvider store={store}><Consumer /></ModelSettingsProvider></StrictMode>);
    act(() => context.open({ target: { kind: 'session', sessionId: 'work' } }));
    await waitFor(() => expect(mocks.dialog?.liveConfig?.temperature).toBe(cfg.temperature));

    status.execution!.temperature = 0.35;
    status.execution!.gpu = { ...cfg.gpu!, gpu_ids: ['gpu-2'] };
    await pollSessions();
    expect(mocks.dialog?.liveConfig).toMatchObject({ temperature: 0.35, gpu: { gpu_ids: ['gpu-2'] } });
    status.execution!.gpu!.gpu_ids[0] = 'gpu-3';
    await pollSessions();
    expect(mocks.dialog?.liveConfig?.gpu?.gpu_ids).toEqual(['gpu-3']);

    status.state = 'stopping';
    await pollSessions();
    expect(mocks.dialog?.liveState).toBe('stopping');
    status.model = 'replacement.gguf';
    status.execution!.active_model = 'replacement.gguf';
    await pollSessions();
    expect(mocks.dialog?.liveConfig?.active_model).toBe('replacement.gguf');
    // An unassigned replacement must not keep the previous model's profile.
    expect(mocks.dialog?.liveApplication).toBeUndefined();
  });

  it.each([
    { name: 'omitted to native null', initialPid: undefined, nextPid: null },
    { name: 'native null to omitted', initialPid: null, nextPid: undefined },
  ])('refreshes the displayed profile when only the PID changes from $name', async ({ initialPid, nextPid }) => {
    const store = createTestStore({ sessions: [namedSession()] });
    const cfg = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    // Native Option<u32> serializes as null; optional frontend status fields
    // may be absent. Both wire shapes must retain their process identity.
    const wireStatus = (pid: number | null | undefined): SessionStatus => JSON.parse(JSON.stringify({ ...running(cfg, 'work'), pid }));
    let status = wireStatus(initialPid);
    mocks.native = true;
    mocks.sessionList.mockImplementation(async () => [status]);
    await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await initialPoll();
    const dialog = mocks.dialog!;
    const draft = { ...dialog.initialConfig, ctx_size: 8192 };
    await act(async () => { await dialog.onProfileCommit(draft, { ...editorResult(dialog, draft, 'profile-new'), saveMode: 'all' }, true); });
    expect(mocks.dialog?.liveApplication?.system_prompt).toBe('Old prompt');

    status = wireStatus(nextPid);
    await pollSessions();
    expect(mocks.dialog?.liveApplication?.system_prompt).toBe('New prompt');
    status = wireStatus(initialPid);
    await pollSessions();
    expect(mocks.dialog?.liveApplication?.system_prompt).toBe('Old prompt');
  });

  it('updates the load-policy notice when another session arrives, stops or disappears', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const cfg = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    const selected = running(cfg, 'work');
    let statuses = [selected];
    mocks.native = true;
    mocks.sessionList.mockImplementation(async () => statuses);
    await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await initialPoll();
    expect(mocks.dialog?.executionNotice).toBeUndefined();

    statuses = [selected, { ...running(cfg, 'other'), state: 'starting' }];
    await pollSessions();
    expect(mocks.dialog?.executionNotice).toBeTruthy();
    statuses = [selected, { ...running(cfg, 'other'), state: 'stopped' }];
    await pollSessions();
    expect(mocks.dialog?.executionNotice).toBeUndefined();
    statuses = [{ ...running(cfg, 'other'), state: 'running' }];
    await pollSessions();
    expect(mocks.dialog?.liveState).toBe('stopped');
    expect(mocks.dialog?.liveConfig).toBeUndefined();
    expect(mocks.dialog?.executionNotice).toBeTruthy();
  });

  it('refreshes the editor label and missing-session feedback when the locale changes between polls', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    mocks.native = true;
    mocks.sessionList.mockResolvedValue([running(sessionConfig(store.cfg!, store.cfg!.sessions![0]), 'work')]);
    const view = render(<ModelSettingsProvider store={store}><Consumer /></ModelSettingsProvider>);
    act(() => context.open({ target: { kind: 'session', sessionId: 'work' } }));
    await initialPoll();
    expect(mocks.dialog?.targetLabel).toBe('Session: Work');
    mocks.locale = 'ko';
    view.rerender(<ModelSettingsProvider store={store}><Consumer /></ModelSettingsProvider>);
    expect(mocks.dialog?.targetLabel).toBe('세션: Work');
    act(() => context.open({ target: { kind: 'session', sessionId: 'removed' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('선택한 세션이 삭제되었습니다. 설정을 다시 열어 세션을 선택해 주세요.');
  });

  it('reopens with a fresh first result after a pending poll completes while closed', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const cfg = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    mocks.native = true;
    mocks.sessionList.mockImplementation(async () => [running(cfg, 'work')]);
    await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await initialPoll();
    expect(mocks.dialog?.liveState).toBe('running');
    let finish!: (value: SessionStatus[]) => void;
    mocks.sessionList.mockImplementationOnce(() => new Promise<SessionStatus[]>(resolve => { finish = resolve; }));
    const calls = mocks.sessionList.mock.calls.length;
    act(() => notifySessionStatusChanged());
    await vi.waitFor(() => expect(mocks.sessionList.mock.calls.length).toBeGreaterThan(calls));
    act(() => mocks.dialog!.onClose());
    await act(async () => { finish([{ ...running(cfg, 'work'), state: 'failed' }]); });
    expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument();

    mocks.sessionList.mockImplementation(async () => [{ ...running({ ...cfg, temperature: 0.25 }, 'work'), state: 'starting' }]);
    act(() => context.open({ target: { kind: 'session', sessionId: 'work' } }));
    await waitFor(() => expect(mocks.dialog?.liveState).toBe('starting'));
    expect(mocks.dialog?.liveConfig?.temperature).toBe(0.25);
  });
});

describe('running profile without a live cache', () => {
  class Failure extends Component<{ children: ReactNode }, { error?: Error }> {
    state: { error?: Error } = {};
    static getDerivedStateFromError(error: Error) { return { error }; }
    render() { return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children; }
  }
  // Each re-render stands in for a session poll: the provider renders again
  // with whatever the store holds at that moment.
  async function openView(store: AppStore, request: ModelSettingsRequest) {
    const tree = () => <Failure><ModelSettingsProvider store={store}><Consumer /></ModelSettingsProvider></Failure>;
    const view = render(tree());
    act(() => context.open(request));
    await waitFor(() => expect(mocks.dialog).not.toBeNull());
    return () => view.rerender(tree());
  }
  const live = () => mocks.dialog?.liveApplication;
  const key = profileTargetKey('model.gguf');

  it('follows saved and in-place configuration changes, the loaded model and the engine of the default target', async () => {
    const store = createTestStore();
    const cfg = store.cfg!;
    store.status = running(cfg);
    const rerender = await openView(store, { target: { kind: 'default' } });
    expect(live()).toMatchObject({ model: 'model.gguf', profile_id: 'profile-old', profile_name: 'Old', system_prompt: 'Old prompt' });

    // The test store assigns each saved patch onto the same configuration object.
    await store.updateConfig(current => ({ settings_profiles: { ...current.settings_profiles!,
      entries: current.settings_profiles!.entries.map(entry => entry.id === 'profile-old' ? { ...entry, name: 'Renamed' } : entry) } }));
    rerender();
    expect(store.cfg).toBe(cfg);
    expect(live()).toMatchObject({ profile_id: 'profile-old', profile_name: 'Renamed', system_prompt: 'Old prompt' });

    await store.updateConfig(current => ({ settings_profiles: { ...current.settings_profiles!, applied: { ...current.settings_profiles!.applied,
      [key]: { ...current.settings_profiles!.applied[key], system_prompt: 'Saved prompt' } } } }));
    rerender();
    expect(live()).toMatchObject({ profile_id: 'profile-old', system_prompt: 'Saved prompt' });

    cfg.settings_profiles!.applied[key].profile_id = 'profile-new';
    rerender();
    expect(live()).toMatchObject({ profile_id: 'profile-new', profile_name: 'New', system_prompt: 'Saved prompt' });

    await store.updateConfig(current => ({ settings_profiles: setDefaultSettingsProfile(current.settings_profiles!, 'profile-old') }));
    rerender();
    expect(cfg.settings_profiles!.default_profile_id).toBe('profile-old');
    expect(live()).toMatchObject({ profile_id: 'profile-new', profile_name: 'New', system_prompt: 'Saved prompt' });

    // Without a saved snapshot, the running target is recovered from the execution values.
    await store.updateConfig(current => ({ settings_profiles: { ...current.settings_profiles!,
      applied: Object.fromEntries(Object.entries(current.settings_profiles!.applied).filter(([target]) => target !== key)) } }));
    rerender();
    expect(live()).toMatchObject({ model: 'model.gguf', settings: { temperature: 0.8 } });
    await store.updateConfig({ temperature: 0.3 });
    rerender();
    expect(live()).toMatchObject({ model: 'model.gguf', settings: { temperature: 0.3 } });

    const other = { ...cfg, active_model: 'other.gguf', temperature: 0.6 };
    await store.updateConfig(current => ({ settings_profiles: { ...current.settings_profiles!, applied: { ...current.settings_profiles!.applied,
      [profileTargetKey('other.gguf')]: materializeProfileApplication(other, 'Other prompt', current.settings_profiles!.entries[1]) } } }));
    rerender();
    expect(live()).toMatchObject({ model: 'model.gguf', settings: { temperature: 0.3 } });
    store.status = running(other);
    rerender();
    expect(live()).toMatchObject({ model: 'other.gguf', profile_id: 'profile-new', system_prompt: 'Other prompt', settings: { temperature: 0.6 } });
    const shown = structuredClone(live());
    store.status = { ...running(other), pid: 5678 };
    rerender();
    expect(live()).toEqual(shown);

    await store.updateConfig({ active_provider: 'vllm' });
    rerender();
    expect(live()).toMatchObject({ provider: 'vllm', model: 'other.gguf' });
    expect(store.updateConfig).toHaveBeenCalledTimes(7);
    expect(store.start).not.toHaveBeenCalled();
  });

  it('prefers the live cache of the same process and returns to it after another process was shown', async () => {
    const store = createTestStore();
    const status = running(store.cfg!); store.status = status;
    mocks.serverStatus.mockResolvedValue(status);
    const rerender = await openView(store, { target: { kind: 'default' } });
    const edit = editorResult(mocks.dialog!, mocks.dialog!.initialConfig);
    edit.application.system_prompt = 'Delivered prompt';
    await act(async () => { await mocks.dialog!.onProfileCommit(mocks.dialog!.initialConfig, { ...edit, saveMode: 'all' }, true); });
    expect(mocks.applyRequestSettings).toHaveBeenCalledOnce();
    expect(live()?.system_prompt).toBe('Delivered prompt');

    await store.updateConfig(current => ({ settings_profiles: { ...current.settings_profiles!, applied: { ...current.settings_profiles!.applied,
      [key]: { ...current.settings_profiles!.applied[key], system_prompt: 'Later saved prompt' } } } }));
    rerender();
    expect(live()?.system_prompt).toBe('Delivered prompt');
    store.status = { ...status, pid: 5678 };
    rerender();
    expect(live()?.system_prompt).toBe('Later saved prompt');
    store.status = status;
    rerender();
    expect(live()?.system_prompt).toBe('Delivered prompt');
  });

  it('shows the saved profile of each running session target', async () => {
    mocks.native = true;
    const work = namedSession();
    const play = { ...namedSession(), id: 'play', name: 'Play', models: { ...work.models, primary_model: 'play.gguf' } };
    const store = createTestStore({ sessions: [work, play] });
    const cfg = store.cfg!;
    cfg.settings_profiles!.applied['session:play'] = materializeProfileApplication(sessionConfig(cfg, play), 'Play prompt', cfg.settings_profiles!.entries[1]);
    mocks.sessionList.mockImplementation(async () => [running(sessionConfig(cfg, work), 'work'), running(sessionConfig(cfg, play), 'play')]);
    await openView(store, { target: { kind: 'session', sessionId: 'work' } });
    await waitFor(() => expect(live()).toMatchObject({ model: 'work.gguf', profile_id: 'profile-old', system_prompt: 'Old prompt' }));
    act(() => context.open({ target: { kind: 'session', sessionId: 'play' } }));
    await waitFor(() => expect(live()).toMatchObject({ model: 'play.gguf', profile_id: 'profile-new', system_prompt: 'Play prompt' }));
    act(() => context.open({ target: { kind: 'session', sessionId: 'work' } }));
    await waitFor(() => expect(live()).toMatchObject({ model: 'work.gguf', profile_id: 'profile-old', system_prompt: 'Old prompt' }));
  });

  it('reads a target without a stored library from browser storage on every render and reports invalid storage', async () => {
    const legacy = (prompt: string) => JSON.stringify({ version: 4, server: [], model: [{ id: 'old', name: 'Old', system_prompt: prompt }] });
    localStorage.setItem('aiolm-model-profiles', legacy('Legacy prompt'));
    const store = createBaseTestStore();
    store.status = running(store.cfg!);
    const rerender = await openView(store, { target: { kind: 'default' } });
    expect(store.cfg).not.toHaveProperty('settings_profiles');
    expect(live()).toMatchObject({ model: 'model.gguf', system_prompt: 'Legacy prompt' });
    localStorage.setItem('aiolm-model-profiles', legacy('Changed legacy prompt'));
    rerender();
    expect(live()).toMatchObject({ model: 'model.gguf', system_prompt: 'Changed legacy prompt' });
    localStorage.setItem('aiolm-model-profiles', '{invalid');
    rerender();
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot import saved profiles: invalid aiolm-model-profiles. The original data has been preserved.');
    expect(localStorage.getItem('aiolm-model-profiles')).toBe('{invalid');
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('reports a stored library error on the next render instead of the earlier running profile', async () => {
    const store = createTestStore();
    store.status = running(store.cfg!);
    const rerender = await openView(store, { target: { kind: 'default' } });
    expect(live()?.system_prompt).toBe('Old prompt');
    const posix = '/Models/Example.gguf';
    const saved = { ...store.cfg!.settings_profiles!.applied[key], model: posix };
    await store.updateConfig(current => ({ settings_profiles: { ...current.settings_profiles!, applied: { ...current.settings_profiles!.applied,
      'model:/models/example.gguf': saved, [profileTargetKey(posix)]: { ...saved, system_prompt: 'Different prompt' } } } }));
    rerender();
    expect(screen.getByRole('alert')).toHaveTextContent(/^Conflicting saved settings for the same model path\.$/);
  });
});

describe('post-save profile removal snapshots', () => {
  function removalStore(removedId = 'profile-old', retainedId = 'profile-new') {
    const store = createTestStore({ runtime_defaults: [], sessions: [namedSession()],
      chat_options: { stop: ['old request'] }, provider_options: { 'llama.cpp': { synthetic: { order: ['old'] } } } });
    const library = store.cfg!.settings_profiles!;
    library.entries[0].id = removedId;
    library.entries[1].id = retainedId;
    library.entries[1].settings = { ...library.entries[1].settings, temperature: 0.25, ctx_size: 32768,
      chat_options: { stop: [' retained ', '\n'], synthetic: { order: ['second', 'first'] } } };
    library.entries[1].system_prompt = '  Replacement prompt\n';
    for (const application of Object.values(library.applied)) application.profile_id = removedId;
    store.cfg!.sessions![0].model_profile_id = removedId;
    library.default_profile_id = retainedId;
    store.cfg!.settings_profiles = ensureProfileLibrary(library);
    return store;
  }

  function expectedTarget(saved: AppConfig, initial: AppConfig, kind: 'default' | 'session' | 'project' | 'benchmark', retainedId: string) {
    const target = kind === 'session' ? sessionConfig(saved, saved.sessions!.find(item => item.id === 'work')!)
      : kind === 'default' ? saved : executionConfig(saved, executionSettings(initial));
    const profile = saved.settings_profiles!.entries.find(entry => entry.id === retainedId)!;
    const application = materializeProfileApplication(applySettingsProfile(target, profile), profile.system_prompt ?? '', profile);
    return { config: { ...executionConfig(target, application.settings), settings_profiles: saved.settings_profiles }, application };
  }

  it.each([
    { kind: 'default', removedId: '\u00e9', retainedId: 'e\u0301' },
    { kind: 'session', removedId: 'Exact', retainedId: 'exact' },
    { kind: 'project', removedId: '__proto__', retainedId: 'constructor' },
    { kind: 'benchmark', removedId: 'constructor', retainedId: '__proto__' },
  ] as const)('uses the returned queued-save snapshot for $kind and literal id $removedId', async ({ kind, removedId, retainedId }) => {
    const store = removalStore(removedId, retainedId);
    const liveBase = structuredClone(store.cfg!);
    const live = running(liveBase); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    const prime = await open(store, { target: { kind: 'default' } });
    await act(async () => { await apply(prime, { ...prime.initialConfig, ctx_size: 8192 }, 'save', removedId); });
    expect(context.getRequestProfile('default', liveBase)?.id).toBe(removedId);

    const onApply = vi.fn();
    const targetConfig = { ...store.cfg!, active_model: 'target.gguf' };
    const request: ModelSettingsRequest = kind === 'default' ? { target: { kind }, onApply }
      : kind === 'session' ? { target: { kind, sessionId: 'work' }, onApply }
      : { target: { kind, id: 'target' }, config: targetConfig,
        application: materializeProfileApplication(targetConfig, 'Old prompt', store.cfg!.settings_profiles!.entries.find(entry => entry.id === removedId)!), onApply };
    act(() => context.open(request));
    const dialog = mocks.dialog!;
    const edit = editorResult(dialog, dialog.initialConfig, removedId);
    edit.baseLibrary = structuredClone(edit.library);
    edit.library.entries.find(entry => entry.id === retainedId)!.name = 'Retained after save';
    const editBefore = structuredClone(edit);
    const previousLibrary = store.cfg!.settings_profiles!;
    const previousBefore = structuredClone(previousLibrary);
    const baseRevision = previousLibrary.revision;

    // A real save queue holds an unrelated write, then a background deletion,
    // then the provider's metadata-only edit. Its patch is resolved against the
    // latest configuration, while the provider captured the earlier library.
    let current = store.cfg!;
    let release!: () => void;
    let persistenceCalls = 0;
    const queue = createConfigSaveQueue<AppConfig>(() => current, value => { current = value; store.cfg = value; }, async value => {
      if (++persistenceCalls === 1) await new Promise<void>(resolve => { release = resolve; });
      return structuredClone(value);
    }, () => undefined);
    store.getConfig = () => current;
    store.updateConfig = vi.fn(queue);
    let blocker!: Promise<AppConfig>;
    await act(async () => { blocker = queue({}); await waitFor(() => expect(release).toBeTypeOf('function')); });
    const background = queue(latestCfg => {
      const library = deleteSettingsProfile(latestCfg.settings_profiles!, removedId);
      return profileLibraryConfigPatch(latestCfg, { baseRevision: latestCfg.settings_profiles!.revision, library,
        application: structuredClone(library.applied[profileTargetKey(latestCfg.active_model)]) });
    });
    let pending!: ReturnType<ModelSettingsDialogProps['onProfileCommit']>;
    act(() => { pending = dialog.onProfileCommit(dialog.initialConfig, edit, false); });
    expect(onApply).not.toHaveBeenCalled();
    expect(store.updateConfig).toHaveBeenCalledOnce();
    let backgroundSaved!: AppConfig;
    let result!: Awaited<typeof pending>;
    await act(async () => { release(); await blocker; backgroundSaved = await background; result = await pending; });
    expect(edit.library.entries.some(entry => entry.id === removedId)).toBe(true);
    expect(backgroundSaved.settings_profiles!.entries.some(entry => entry.id === removedId)).toBe(false);
    const expectedSaved: AppConfig = { ...structuredClone(backgroundSaved), settings_profiles: {
      ...structuredClone(backgroundSaved.settings_profiles!), revision: baseRevision + 2,
      entries: backgroundSaved.settings_profiles!.entries.map(entry => entry.id === retainedId ? { ...structuredClone(entry), name: 'Retained after save' } : structuredClone(entry)),
      applied: Object.fromEntries(Object.entries(backgroundSaved.settings_profiles!.applied).map(([key, application]) => [key,
        application.profile_id === retainedId ? { ...structuredClone(application), profile_name: 'Retained after save' } : structuredClone(application)])),
    } };
    const expected = expectedTarget(expectedSaved, dialog.initialConfig, kind, retainedId);
    expect(store.cfg).toEqual(expectedSaved);
    expect(result).toEqual(expected);
    expect(previousLibrary).toEqual(previousBefore);
    expect(edit).toEqual(editBefore);
    expect(result.config).not.toBe(store.cfg);
    expect(result.config.settings_profiles).not.toBe(store.cfg!.settings_profiles);
    expect(result.application.settings).not.toBe(edit.application.settings);
    expect(result.application.settings.chat_options).not.toBe(store.cfg!.settings_profiles!.entries.find(entry => entry.id === retainedId)!.settings.chat_options);
    if (kind === 'default' || kind === 'session') expect(result.application.settings).not.toBe(store.cfg!.settings_profiles!.applied[profileTargetKey(result.config.active_model, kind === 'session' ? 'work' : 'default')].settings);
    if (kind === 'project' || kind === 'benchmark') expect(onApply.mock.calls).toEqual([[expected.config, expected.application]]);
    else expect(onApply).not.toHaveBeenCalled();

    const activeKey = profileTargetKey(expectedSaved.active_model);
    const activeApplication = expectedSaved.settings_profiles!.applied[activeKey];
    const requestConfig = context.getRequestConfig('default', store.cfg!, live);
    expect(requestConfig).toEqual({ ...executionConfig(expectedSaved, live.execution!),
      temperature: 0.25, top_p: activeApplication.settings.top_p, top_k: activeApplication.settings.top_k,
      reasoning_effort: activeApplication.settings.reasoning_effort, chat_options: structuredClone(activeApplication.settings.chat_options), runtime_defaults: [] });
    expect(context.getRequestProfile('default', requestConfig)).toEqual(requestProfileFromApplication(activeApplication));
    const work = sessionConfig(expectedSaved, expectedSaved.sessions![0]);
    const workRequest = context.getRequestConfig('work', work, running(sessionConfig(liveBase, liveBase.sessions![0]), 'work'));
    expect(context.getRequestProfile('work', workRequest)).toEqual(requestProfileFromApplication(expectedSaved.settings_profiles!.applied['session:work']));

    const freshEdit: ProfileEditorResult = { baseRevision: expectedSaved.settings_profiles!.revision,
      baseLibrary: structuredClone(expectedSaved.settings_profiles!), library: structuredClone(expectedSaved.settings_profiles!), application: structuredClone(result.application) };
    freshEdit.library.entries.find(entry => entry.id === retainedId)!.name = 'Fresh retained';
    let fresh!: Awaited<typeof pending>;
    await act(async () => { fresh = await mocks.dialog!.onProfileCommit(result.config, freshEdit, false); });
    const freshLibrary = { ...structuredClone(expectedSaved.settings_profiles!), revision: baseRevision + 3,
      entries: expectedSaved.settings_profiles!.entries.map(entry => entry.id === retainedId ? { ...structuredClone(entry), name: 'Fresh retained' } : structuredClone(entry)),
      applied: Object.fromEntries(Object.entries(expectedSaved.settings_profiles!.applied).map(([key, application]) => [key,
        application.profile_id === retainedId ? { ...structuredClone(application), profile_name: 'Fresh retained' } : structuredClone(application)])) };
    const freshSaved = { ...expectedSaved, settings_profiles: freshLibrary };
    expect(store.cfg).toEqual(freshSaved);
    expect(fresh).toEqual(expectedTarget(freshSaved, expected.config, kind, retainedId));
    expect(onApply).toHaveBeenCalledTimes(kind === 'project' || kind === 'benchmark' ? 1 : 0);
    expect(store.start).not.toHaveBeenCalled(); expect(store.stop).not.toHaveBeenCalled();
    expect(mocks.sessionStart).not.toHaveBeenCalled(); expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
    expect(mocks.preflightLaunch).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();

    (result.application.settings.chat_options!.stop as string[]).push('output only');
    result.config.settings_profiles!.entries[0].name = 'Output only';
    expect(store.cfg).toEqual(freshSaved);
    expect(edit).toEqual(editBefore);
    if (kind === 'project' || kind === 'benchmark') expect(onApply.mock.calls).toEqual([[expected.config, expected.application]]);

    // Invalidate the deletion fallback. The live cache must also have dropped
    // the deleted ID, so request-profile resolution now uses the saved identity.
    store.cfg!.settings_profiles!.applied[activeKey].system_prompt = 'Later saved prompt';
    const incoming = executionConfig(store.cfg!, live.execution!);
    expect(context.getRequestProfile('default', incoming)).toEqual(requestProfileFromApplication({
      ...store.cfg!.settings_profiles!.applied[activeKey], settings: profileSettingsSnapshot(incoming),
    }));
  });

  it.each(['project', 'benchmark'] as const)('retains the successful metadata save when %s deletion delivery rejects, then retries without redelivery', async kind => {
    const store = removalStore();
    const onApply = vi.fn().mockRejectedValueOnce(new Error('replacement delivery failed'));
    const target = { ...store.cfg!, active_model: 'target.gguf' };
    const dialog = await open(store, { target: { kind, id: 'target' }, config: target,
      application: materializeProfileApplication(target, 'Old prompt', store.cfg!.settings_profiles!.entries[0]), onApply });
    const before = structuredClone(store.cfg!);
    const edit = editorResult(dialog, dialog.initialConfig);
    edit.library = deleteSettingsProfile(edit.library, 'profile-old');
    const editBefore = structuredClone(edit);
    let failure: unknown;
    await act(async () => { try { await dialog.onProfileCommit(dialog.initialConfig, edit, false); } catch (cause) { failure = cause; } });
    const expectedSaved = { ...executionConfig(before, edit.library.applied[profileTargetKey(before.active_model)].settings),
      settings_profiles: { ...structuredClone(edit.library), revision: before.settings_profiles!.revision + 1, legacy_imported: true } };
    expect(before).not.toHaveProperty('gpu');
    expect(expectedSaved.gpu).toEqual({ gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null });
    // Equivalent empty placement is not a saved change from an absent GPU.
    delete expectedSaved.gpu;
    // No named-session replacement is omitted from this full expected config.
    const definition = before.sessions![0];
    const replacement = edit.library.applied['session:work'];
    const expectedWork = settingsForSession(definition, executionConfig(sessionConfig(before, definition), replacement.settings));
    delete expectedWork.model_profile_id;
    expectedSaved.sessions = [expectedWork];
    const expected = expectedTarget(expectedSaved, dialog.initialConfig, kind, 'profile-new');
    expect(store.cfg).toEqual(expectedSaved);
    expect(failure).toBeInstanceOf(SettingsDeliveryError);
    expect((failure as SettingsDeliveryError).saved).toEqual(expected.config);
    expect((failure as SettingsDeliveryError).application).toEqual(expected.application);
    expect(onApply.mock.calls).toEqual([[expected.config, expected.application]]);
    expect(edit).toEqual(editBefore);
    const retry: ProfileEditorResult = { baseRevision: expectedSaved.settings_profiles.revision,
      library: structuredClone(expectedSaved.settings_profiles), application: structuredClone(expected.application) };
    let retried!: Awaited<ReturnType<ModelSettingsDialogProps['onProfileCommit']>>;
    await act(async () => { retried = await mocks.dialog!.onProfileCommit(expected.config, retry, false); });
    const retriedSaved = { ...expectedSaved, settings_profiles: { ...expectedSaved.settings_profiles, revision: expectedSaved.settings_profiles.revision + 1 } };
    expect(store.cfg).toEqual(retriedSaved);
    expect(retried).toEqual(expectedTarget(retriedSaved, expected.config, kind, 'profile-new'));
    expect(onApply).toHaveBeenCalledOnce();
    expect(store.start).not.toHaveBeenCalled(); expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('leaves metadata, callbacks and request state unchanged when the library save rejects, then releases the lock', async () => {
    const store = removalStore();
    const onApply = vi.fn();
    const dialog = await open(store, { target: { kind: 'default' }, onApply });
    const edit = editorResult(dialog, dialog.initialConfig);
    edit.library = deleteSettingsProfile(edit.library, 'profile-old');
    const before = structuredClone({ cfg: store.cfg, edit });
    const originalError = new Error('profile library save failed');
    vi.mocked(store.updateConfig).mockRejectedValueOnce(originalError);
    let failure: unknown;
    await act(async () => { try { await dialog.onProfileCommit(dialog.initialConfig, edit, false); } catch (cause) { failure = cause; } });
    expect(failure).toBe(originalError);
    expect({ cfg: store.cfg, edit }).toEqual(before);
    expect(onApply).not.toHaveBeenCalled();
    expect(context.getRequestProfile('default', store.cfg!)?.id).toBe('profile-old');
    await act(async () => { await mocks.dialog!.onProfileCommit(dialog.initialConfig, edit, false); });
    expect(store.cfg!.settings_profiles!.revision).toBe(before.cfg!.settings_profiles!.revision + 1);
    expect(context.getRequestProfile('default', store.cfg!)?.id).toBe('profile-new');
    expect(store.start).not.toHaveBeenCalled(); expect(mocks.applyRequestSettings).not.toHaveBeenCalled();
  });
});
