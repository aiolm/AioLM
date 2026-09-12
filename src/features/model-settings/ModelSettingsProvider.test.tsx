import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestStore } from '../../testing/appStore';
import type { AppConfig, SessionDefinition, SessionStatus } from '../../shared/api/types';
import type { AppStore } from '../../shared/state/store';
import { executionSettings } from '../../shared/config/executionSettings';
import { sessionConfig } from '../../shared/runtime/sessionUtils';
import { setSessionActivity } from '../../shared/state/sessionActivity';
import type { ModelSettingsDialogProps } from './ModelSettingsDialog';
import { ModelSettingsProvider, useModelSettings, type ModelSettingsContext, type ModelSettingsRequest } from './ModelSettingsProvider';

const mocks = vi.hoisted(() => ({
  dialog: null as ModelSettingsDialogProps | null,
  sessionList: vi.fn(), serverStatus: vi.fn(), preflightLaunch: vi.fn(),
  sessionStart: vi.fn(), sessionStop: vi.fn(), applyRequestSettings: vi.fn(), saveProfileSelection: vi.fn(),
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
vi.mock('../profiles/modelProfiles', () => ({
  getActiveModelProfile: () => ({ id: 'profile-old', system_prompt: 'Old prompt' }),
  loadProfiles: () => ({ activeServerId: 'server-profile', activeModelId: 'profile-old',
    model: [{ id: 'profile-old', system_prompt: 'Old prompt' }, { id: 'profile-new', system_prompt: 'New prompt' }] }),
  saveProfileSelection: mocks.saveProfileSelection,
}));

let context: ModelSettingsContext;
function Consumer() { context = useModelSettings()!; return null; }

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
  vi.clearAllMocks(); mocks.dialog = null;
  mocks.sessionList.mockResolvedValue([]);
  mocks.serverStatus.mockResolvedValue({ state: 'stopped' });
  mocks.preflightLaunch.mockImplementation(async (cfg: AppConfig) => structuredClone(cfg));
  mocks.sessionStart.mockResolvedValue(undefined);
  mocks.applyRequestSettings.mockImplementation(async (cfg: AppConfig) => executionSettings(cfg));
});
afterEach(() => { cleanup(); setSessionActivity('work', false); setSessionActivity('default', false); });

describe('model settings target application', () => {
  it('opens and cancels without configuration, profile, or lifecycle writes', async () => {
    const store = createTestStore();
    const dialog = await open(store, { target: { kind: 'default' } });
    act(() => dialog.onClose());
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled(); expect(store.stop).not.toHaveBeenCalled();
    expect(mocks.preflightLaunch).not.toHaveBeenCalled();
    expect(mocks.saveProfileSelection).not.toHaveBeenCalled();
  });

  it.each(['benchmark', 'project'] as const)('applies %s settings only to the requesting editor', async kind => {
    const store = createTestStore();
    const onApply = vi.fn();
    const dialog = await open(store, { target: { kind, id: 'target' }, onApply });
    await act(async () => { await dialog.onApply({ ...dialog.initialConfig, active_model: 'chosen.gguf', ctx_size: 8192 }, 'save'); });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'chosen.gguf', ctx_size: 8192 }));
    expect(store.cfg?.active_model).toBe('model.gguf');
    expect(store.updateConfig).not.toHaveBeenCalled(); expect(store.start).not.toHaveBeenCalled();
    expect(mocks.sessionStart).not.toHaveBeenCalled(); expect(mocks.preflightLaunch).not.toHaveBeenCalled();
    expect(mocks.saveProfileSelection).not.toHaveBeenCalled();
  });

  it('saves named execution settings without changing the default target or shared profile assignment', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await dialog.onApply({ ...dialog.initialConfig, temperature: 0.2, ctx_size: 8192 }, 'save', { modelProfileId: 'profile-new' }); });
    expect(store.cfg).toMatchObject({ active_model: 'model.gguf', temperature: 0.8, ctx_size: 4096 });
    expect(store.cfg?.sessions?.[0]).toMatchObject({ id: 'work', model_profile_id: 'profile-new', execution: { temperature: 0.2, ctx_size: 8192 } });
    expect(mocks.saveProfileSelection).not.toHaveBeenCalled(); expect(mocks.sessionStart).not.toHaveBeenCalled();
  });

  it('rechecks session removal at the serialized save boundary', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const save = store.updateConfig;
    store.updateConfig = vi.fn(async patch => { store.cfg!.sessions = []; return save(patch); });
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await expect(dialog.onApply({ ...dialog.initialConfig, temperature: 0.2 }, 'save')).rejects.toThrow('removed'); });
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
    await act(async () => { await expect(dialog.onApply({ ...dialog.initialConfig, temperature: 0.2 }, 'save')).rejects.toThrow('temperature'); });
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
    await act(async () => { await dialog.onApply({ ...dialog.initialConfig, temperature: 0.2 }, 'save'); });
    expect(store.cfg?.sessions?.[0]).toMatchObject({ name: 'Renamed elsewhere', enabled: false, execution: { temperature: 0.2 } });
  });
});

describe('model launch preparation', () => {
  it('keeps a running model and saved configuration intact when preflight fails', async () => {
    const store = createTestStore();
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    mocks.preflightLaunch.mockRejectedValueOnce(new Error('missing model shard'));
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await expect(dialog.onApply({ ...dialog.initialConfig, active_model: 'replacement.gguf' }, 'start')).rejects.toThrow('missing model shard'); });
    expect(store.updateConfig).not.toHaveBeenCalled(); expect(store.stop).not.toHaveBeenCalled(); expect(store.start).not.toHaveBeenCalled();
    expect(store.cfg?.active_model).toBe('model.gguf');
  });

  it('launches normalized settings through native replacement without stopping first', async () => {
    const store = createTestStore();
    const live = running(store.cfg!); store.status = live;
    mocks.serverStatus.mockResolvedValue(live);
    mocks.preflightLaunch.mockImplementationOnce(async (cfg: AppConfig) => ({ ...cfg, ctx_size: 512 }));
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await dialog.onApply({ ...dialog.initialConfig, ctx_size: 200 }, 'start'); });
    expect(store.cfg?.ctx_size).toBe(512);
    expect(store.start).toHaveBeenCalledWith(expect.objectContaining({ ctx_size: 512 }), true);
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('blocks a default launch that would interrupt another active response', async () => {
    const store = createTestStore({ stop_existing_sessions_on_load: true });
    const dialog = await open(store, { target: { kind: 'default' } });
    setSessionActivity('work', true);
    await act(async () => { await expect(dialog.onApply(dialog.initialConfig, 'start')).rejects.toThrow('current response'); });
    expect(mocks.preflightLaunch).not.toHaveBeenCalled(); expect(store.start).not.toHaveBeenCalled();
  });

  it('retains a successful save if starting the selected model fails', async () => {
    const store = createTestStore();
    vi.mocked(store.start).mockRejectedValueOnce(new Error('runtime failed'));
    const dialog = await open(store, { target: { kind: 'default' } });
    await act(async () => { await expect(dialog.onApply({ ...dialog.initialConfig, active_model: 'replacement.gguf' }, 'start')).rejects.toThrow('runtime failed'); });
    expect(store.cfg?.active_model).toBe('replacement.gguf');
    expect(mocks.dialog).not.toBeNull();
    expect(store.stop).not.toHaveBeenCalled();
  });

  it('keeps live request settings and profile when changes are saved for the next run', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const liveConfig = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    const live = running(liveConfig, 'work');
    mocks.sessionList.mockResolvedValue([live]);
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await dialog.onApply({ ...dialog.initialConfig, ctx_size: 8192, temperature: 0.2 }, 'save', { modelProfileId: 'profile-new' }); });
    const saved = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    expect(saved).toMatchObject({ ctx_size: 8192, temperature: 0.2 });
    expect(context.getRequestConfig('work', saved, live)).toMatchObject({ ctx_size: 4096, temperature: 0.8 });
    expect(context.getRequestProfile('work', liveConfig)?.system_prompt).toBe('Old prompt');
    expect(store.cfg?.sessions?.[0].model_profile_id).toBe('profile-new');
    expect(mocks.applyRequestSettings).not.toHaveBeenCalled(); expect(mocks.sessionStart).not.toHaveBeenCalled();
  });

  it('applies request-only edits to the running target without restarting its process', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const liveConfig = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    mocks.sessionList.mockResolvedValue([running(liveConfig, 'work')]);
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await dialog.onApply({ ...dialog.initialConfig, temperature: 0.2 }, 'save'); });
    expect(mocks.applyRequestSettings).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'work.gguf', temperature: 0.2 }), 'work');
    expect(mocks.sessionStart).not.toHaveBeenCalled(); expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled(); expect(mocks.preflightLaunch).not.toHaveBeenCalled();
    expect(store.cfg?.temperature).toBe(0.8);
  });

  it('uses the saved profile after another entry point restarts the same model', async () => {
    const store = createTestStore({ sessions: [namedSession()] });
    const liveConfig = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    const live = running(liveConfig, 'work');
    mocks.sessionList.mockResolvedValue([live]);
    const dialog = await open(store, { target: { kind: 'session', sessionId: 'work' } });
    await act(async () => { await dialog.onApply({ ...dialog.initialConfig, ctx_size: 8192 }, 'save', { modelProfileId: 'profile-new' }); });
    expect(context.getRequestProfile('work', liveConfig)?.system_prompt).toBe('Old prompt');
    const restarted = sessionConfig(store.cfg!, store.cfg!.sessions![0]);
    context.getRequestConfig('work', restarted, { ...running(restarted, 'work'), pid: 5678 });
    expect(context.getRequestProfile('work', restarted)?.system_prompt).toBe('New prompt');
  });
});
