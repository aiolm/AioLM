import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import { effectiveSchema } from '../../testing/effectiveSchema';
import {
  captureProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey,
} from '../../shared/config/settingsProfiles';
import { ModelSettingsProvider } from '../model-settings/ModelSettingsProvider';
// Load the real lazy module before the first DOM query; transform cost belongs
// to test setup, while the production provider still opens its real dialog.
import '../model-settings/ModelSettingsDialog';
import { MODEL_EXECUTION_KEY, rememberExecution } from './modelExecutionState';
import ModelWorkspace from './ModelWorkspace';

// Only native boundaries are replaced. Workspace, settings provider, dialog,
// compatibility helpers, profile expansion, profile editor and store updates run.
vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  listModels: vi.fn(), cancelModelScan: vi.fn(async () => undefined),
  sessionList: vi.fn(async () => []), sessionSummaryList: vi.fn(async () => []),
  isNativeRuntimeAvailable: vi.fn(() => false),
  serverStatus: vi.fn(async () => ({ state: 'stopped' })),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerRuntimeOptions: vi.fn(),
  providerOptionSchema: vi.fn(), providerOptionIssues: vi.fn(async () => []),
  deviceProfile: vi.fn(async () => ({ profile: { gpus: [] }, backends: [] })),
  modelMetadata: vi.fn(async () => ({})), rtList: vi.fn(async () => []),
  preflightLaunch: vi.fn(), applyRequestSettings: vi.fn(), sessionStart: vi.fn(), sessionStop: vi.fn(),
  // This fixture never requests help acceptance or a runtime-management view.
  runtimeHelpTarget: vi.fn(() => new Promise(() => undefined)),
}));

const TARGET = 'models/provider-target';
const DEPARTING = 'models/departing.gguf';
const OPTIONS: api.ProviderOption[] = [{
  key: 'max_model_len', flag: '--max-model-len', target: 'launch', group: 'context', kind: { type: 'integer' },
}];
const MODALITIES = { text: true, image: false, audio: false, video: false };
const TARGET_MODEL: api.GgufModel = {
  name: 'provider-target', path: TARGET, size_mb: 2048, is_vision: false,
  compatibility: [
    { provider: 'llama.cpp', status: 'unsupported', tasks: [], modalities: MODALITIES,
      limitations: [], readiness: [], evidence: 'synthetic-boundary-record', reasons: [{ code: 'synthetic-unsupported', detail: 'Synthetic model record rejects the departing engine.' }] },
    { provider: 'vllm', status: 'supported', tasks: ['generate'], modalities: MODALITIES,
      limitations: [], readiness: [], evidence: 'synthetic-boundary-record', reasons: [] },
    { provider: 'mlx-vlm', status: 'unsupported', tasks: [], modalities: MODALITIES,
      limitations: [], readiness: [], evidence: 'synthetic-boundary-record', reasons: [] },
  ],
};

const storedValues = () => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));

function fixture(currentProvider: 'llama.cpp' | 'vllm', assigned: boolean) {
  const store = createTestStore({
    active_provider: currentProvider, active_model: DEPARTING,
    active_runtime: currentProvider === 'vllm' ? 'selected-vllm-runtime' : 'departing-runtime',
    runtime_defaults: [], provider_options: { vllm: { max_model_len: 999 } },
  });
  const cfg = store.cfg!;
  const departing = { ...captureProfile(cfg, 'Departing saved profile', 'global', 'Departing instructions'), id: 'departing-profile' };
  const targetConfig = { ...cfg, active_provider: 'vllm' as const, active_model: TARGET,
    request_timeout_seconds: 222, provider_options: { vllm: { max_model_len: 16384 } } };
  const fallbackConfig = { ...targetConfig, request_timeout_seconds: 111,
    provider_options: { vllm: { max_model_len: 2048 } } };
  const targetProfile = { ...captureProfile(targetConfig, 'Assigned target profile', 'global', 'Assigned target instructions'), id: 'vllm-target', revision: 3 };
  const defaultProfile = { ...captureProfile(fallbackConfig, 'Provider default profile', 'global', 'Provider default instructions'), id: 'vllm-default' };
  const library = { ...emptyProfileLibrary(), revision: 7, legacy_imported: true,
    entries: [departing, defaultProfile, targetProfile],
    ...(currentProvider === 'llama.cpp' ? { default_profile_id: departing.id } : {}),
    provider_defaults: { [currentProvider]: departing.id, vllm: defaultProfile.id },
    applied: {
      [profileTargetKey(DEPARTING, 'default', currentProvider)]: materializeProfileApplication(cfg, 'Departing instructions', departing),
      ...(assigned ? { [profileTargetKey(TARGET, 'default', 'vllm')]: {
        ...materializeProfileApplication({ ...targetConfig, request_timeout_seconds: 200,
          provider_options: { vllm: { max_model_len: 12288 } } }, 'Older assigned instructions', targetProfile),
        profile_revision: 2,
      } } : {}),
    },
  };
  cfg.settings_profiles = library;
  // Distinct provider-scoped memory must remain untouched by card preview/save.
  rememberExecution({ ...cfg, active_provider: 'llama.cpp', active_model: TARGET, ctx_size: 65536, temperature: 1.2 });
  rememberExecution({ ...targetConfig, request_timeout_seconds: 333,
    provider_options: { vllm: { max_model_len: 32768 } } });
  return { store, before: structuredClone(cfg), memory: localStorage.getItem(MODEL_EXECUTION_KEY), storage: storedValues(),
    expected: assigned ? targetProfile : defaultProfile,
    expectedConfig: assigned ? targetConfig : fallbackConfig };
}

function mount(store: ReturnType<typeof createTestStore>) {
  const selectOutsideEditor = vi.fn();
  render(<I18nProvider initialLocale="en"><ModelSettingsProvider store={store}>
    <ModelWorkspace store={store} onSelectModel={selectOutsideEditor} active
      section={{ id: 'setup', revision: 0 }} onNavigate={vi.fn()} />
  </ModelSettingsProvider></I18nProvider>);
  return selectOutsideEditor;
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.listModels).mockResolvedValue({ models: [TARGET_MODEL], truncated: false });
  vi.mocked(api.providerCatalog).mockResolvedValue(api.PROVIDERS.map(id => ({
    id, engine: id, server: 'synthetic-server', availability: { supported: true, detail: '' },
    options: id === 'vllm' ? OPTIONS : [],
  })));
  vi.mocked(api.providerRuntimes).mockResolvedValue([{
    id: 'selected-vllm-runtime', provider: 'vllm', engine: 'vllm', server: 'synthetic-server',
    accelerator: 'synthetic', installation: 'external', location: 'synthetic-runtime', available: true, problems: [],
  }]);
  vi.mocked(api.providerRuntimeOptions).mockResolvedValue(OPTIONS);
  vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema(OPTIONS));
});
afterEach(cleanup);

describe('workspace provider fallback profile integration', () => {
  // Each case traverses the real workspace, dialog, profiles, tabs and Apply.
  // Allow time for that DOM journey while retaining every state/save boundary.
  it.each([
    { name: 'uses the fallback provider target assignment', currentProvider: 'llama.cpp' as const, assigned: true, clearsRuntime: true, malformedBrowserMemory: false },
    { name: 'uses the fallback provider default when no target assignment exists', currentProvider: 'llama.cpp' as const, assigned: false, clearsRuntime: true, malformedBrowserMemory: false },
    { name: 'retains the current provider runtime and target assignment', currentProvider: 'vllm' as const, assigned: true, clearsRuntime: false, malformedBrowserMemory: false },
    { name: 'opens the fallback target assignment without parsing unrelated malformed memory', currentProvider: 'llama.cpp' as const, assigned: true, clearsRuntime: true, malformedBrowserMemory: true },
  ])('$name without changing saved state before Apply', { timeout: 10_000 }, async ({ currentProvider, assigned, clearsRuntime, malformedBrowserMemory }) => {
    const state = fixture(currentProvider, assigned);
    if (malformedBrowserMemory) {
      localStorage.setItem(MODEL_EXECUTION_KEY, '{invalid synthetic memory');
      state.memory = localStorage.getItem(MODEL_EXECUTION_KEY); state.storage = storedValues();
    }
    const { store, before, memory, storage, expected, expectedConfig } = state;
    const outside = mount(store);
    const library = within(document.querySelector<HTMLElement>('.model-workspace-library')!);
    fireEvent.click(await library.findByRole('button', { name: 'Configure & run: provider-target' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Model & settings' }));
    expect(dialog.getByRole('radio', { name: /^vLLM/ })).toBeChecked();
    const runtime = await dialog.findByRole('radio', { name: /^selected-vllm-runtime/ });
    expect(runtime).toHaveProperty('checked', !clearsRuntime);
    expect(dialog.getByRole('button', { name: 'Continue to profile' })).toHaveProperty('disabled', clearsRuntime);
    expect(store.cfg).toEqual(before);
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(memory);
    expect(storedValues()).toEqual(storage);
    expect(outside).not.toHaveBeenCalled();

    if (clearsRuntime) fireEvent.click(runtime);
    fireEvent.click(dialog.getByRole('button', { name: 'Continue to profile' }));
    expect(dialog.getByRole('heading', { name: 'Choose profile' })).toBeVisible();
    // The reusable entry is newer than its saved application. Execution uses
    // current profile values/prompt while retaining the target's chosen identity.
    expect.soft(dialog.getByRole('button', { name: new RegExp('^' + expected.name) })).toHaveAttribute('aria-pressed', 'true');
    expect.soft(dialog.queryByRole('button', { name: /^Recovered profile/ })).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Use this profile and adjust options' }));
    fireEvent.click(dialog.getByRole('tab', { name: 'Performance & memory' }));
    expect.soft(await dialog.findByLabelText(/^--max-model-len/)).toHaveValue(String(expectedConfig.provider_options!.vllm!.max_model_len));
    fireEvent.click(dialog.getByRole('tab', { name: 'Generation' }));
    expect.soft(dialog.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue(expected.system_prompt);
    expect(store.cfg).toEqual(before);
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(memory);
    expect(storedValues()).toEqual(storage);

    const save = dialog.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(store.updateConfig).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
    expect.soft(store.cfg).toMatchObject({ active_provider: 'vllm', active_model: TARGET,
      active_runtime: 'selected-vllm-runtime', request_timeout_seconds: expectedConfig.request_timeout_seconds,
      provider_options: { vllm: { max_model_len: expectedConfig.provider_options!.vllm!.max_model_len } } });
    expect.soft(store.cfg!.settings_profiles!.applied[profileTargetKey(TARGET, 'default', 'vllm')]).toMatchObject({
      provider: 'vllm', model: TARGET, profile_id: expected.id, system_prompt: expected.system_prompt,
    });
    const providerEntries = before.settings_profiles!.entries.filter(entry => entry.provider === 'vllm');
    expect.soft(store.cfg!.settings_profiles!.entries.filter(entry => entry.provider === 'vllm').map(entry => entry.id))
      .toEqual(providerEntries.map(entry => entry.id));
    for (const entry of providerEntries.filter(entry => entry.id !== expected.id)) {
      expect(store.cfg!.settings_profiles!.entries.find(saved => saved.id === entry.id)).toEqual(entry);
    }
    expect(store.cfg!.settings_profiles!.applied[profileTargetKey(DEPARTING, 'default', currentProvider)])
      .toEqual(before.settings_profiles!.applied[profileTargetKey(DEPARTING, 'default', currentProvider)]);
    if (assigned) expect.soft(store.cfg!.settings_profiles!.entries.find(entry => entry.id === 'vllm-default'))
      .toEqual(before.settings_profiles!.entries.find(entry => entry.id === 'vllm-default'));
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(memory);
    expect(store.start).not.toHaveBeenCalled(); expect(store.stop).not.toHaveBeenCalled();
    expect(api.preflightLaunch).not.toHaveBeenCalled(); expect(api.sessionStart).not.toHaveBeenCalled();
  });
});
