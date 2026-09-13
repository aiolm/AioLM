import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/api/types';
import { MODEL_PROFILE_KEYS, settingsSnapshot, type SettingsProfileLibrary } from '../../shared/config/settingsProfiles';
import { RUNTIME_DEFAULT_KEYS } from '../../shared/config/tuningDefaults';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { testConfig } from '../../testing/appStore';
import { BENCHMARK_CONTROLLED_KEYS, resetProfileSettings } from './profileResetState';

const manualSettings = {
  active_backend: 'vulkan', active_build: 'custom-build', runtime_defaults: ['temperature'],
  ngl: 4, ctx_size: 32768, batch_size: 16, ubatch_size: 8, keep: 12,
  cache_type_k: 'q8_0', cache_type_v: 'q8_0', flash_attn: 'off', n_cpu_moe: 3, threads: 7,
  temperature: 0.2, top_p: 0.6, top_k: 12,
  spec_type: 'draft', spec_draft_n_max: 8, spec_draft_n_min: 2, spec_draft_p_min: 0.4,
  spec_draft_p_split: 0.6, spec_draft_ngl: '2', spec_draft_device: 'runtime:vulkan:Vulkan0', spec_draft_model: 'models/draft.gguf',
  reasoning: 'off', reasoning_format: 'none', reasoning_effort: 'high', reasoning_budget: 512,
  reasoning_budget_message: 'Complete the response.', reasoning_preserve: 'on',
  server_args: ['--seed', '17', '--custom-flag'], chat_options: { stop: ['finish'], seed: 42, chat_template_kwargs: { enable_thinking: false } },
  mmproj: 'models/projector.gguf', parallel: 3, request_timeout_seconds: 123, sleep_idle_seconds: 45,
  lora_adapters: [{ path: 'models/adapter.gguf', scale: 0.5, enabled: true }],
  gpu: { gpu_ids: ['runtime:vulkan:Vulkan0'], main_gpu: 'runtime:vulkan:Vulkan0', split_mode: 'layer', tensor_split: [1], draft_gpu_id: 'runtime:vulkan:Vulkan0' },
} satisfies Required<Pick<AppConfig, typeof MODEL_PROFILE_KEYS[number]>>;

const customConfig = (): AppConfig => ({ ...structuredClone(testConfig), ...structuredClone(manualSettings) });

describe('full profile defaults', () => {
  it('resets every profile field while retaining the selected model', () => {
    const cfg = customConfig();
    const reset = resetProfileSettings(cfg, false);

    expect(Object.keys(manualSettings).sort()).toEqual([...MODEL_PROFILE_KEYS].sort());
    expect(settingsSnapshot(reset)).toEqual({
      ...tuningResetValues(), runtime_defaults: [...RUNTIME_DEFAULT_KEYS].sort(),
      active_backend: '', active_build: '', spec_draft_device: '', spec_draft_model: '', mmproj: '',
      server_args: [], chat_options: {}, lora_adapters: [],
      gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null },
    });
    expect(reset.active_model).toBe(cfg.active_model);
    expect(reset).toMatchObject({ ngl: 99, ctx_size: 4096 });
    expect(cfg).toEqual(customConfig());
  });

  it('uses product defaults independently of the prior manual values and default markers', () => {
    const reset = resetProfileSettings(customConfig(), false);
    const fresh = resetProfileSettings({ ...structuredClone(testConfig), runtime_defaults: [] }, false);
    const inherited = resetProfileSettings({ ...customConfig(), runtime_defaults: [...RUNTIME_DEFAULT_KEYS] }, false);

    expect(settingsSnapshot(reset)).toEqual(settingsSnapshot(fresh));
    expect(settingsSnapshot(reset)).toEqual(settingsSnapshot(inherited));
  });

  it.each([false, true])('preserves benchmark workload settings with inherited markers set to %s', inherited => {
    const cfg = customConfig();
    const controlledDefaults = RUNTIME_DEFAULT_KEYS.filter(key => BENCHMARK_CONTROLLED_KEYS.has(key));
    cfg.runtime_defaults = inherited ? [...controlledDefaults, 'threads'] : ['threads'];
    const original = structuredClone(cfg);
    const reset = resetProfileSettings(cfg, true);

    for (const key of MODEL_PROFILE_KEYS) {
      if (BENCHMARK_CONTROLLED_KEYS.has(key)) expect(reset[key], key).toEqual(cfg[key]);
    }
    for (const key of controlledDefaults) expect(reset.runtime_defaults?.includes(key), key).toBe(inherited);
    expect(reset.runtime_defaults).toEqual(RUNTIME_DEFAULT_KEYS.filter(key => inherited || !BENCHMARK_CONTROLLED_KEYS.has(key)).sort());
    expect(reset).toMatchObject({ active_model: cfg.active_model, active_backend: '', active_build: '', mmproj: '',
      spec_draft_model: '', server_args: [], lora_adapters: [], threads: tuningResetValues().threads });
    expect(cfg).toEqual(original);
  });

  it('leaves saved profiles, sessions, and application settings untouched', () => {
    const library: SettingsProfileLibrary = {
      version: 1, revision: 3, legacy_imported: true,
      entries: [{ id: 'saved-source', name: 'Saved source', scope: 'model', revision: 2, settings: structuredClone(manualSettings), system_prompt: 'Saved prompt' }],
      applied: { 'model:model.gguf': { model: 'model.gguf', profile_id: 'saved-source', settings: structuredClone(manualSettings), system_prompt: 'Saved prompt' } },
    };
    const cfg = { ...customConfig(), settings_profiles: library, port: 9000, models_dir: 'models/custom', iters: 8,
      stop_existing_sessions_on_load: false,
      sessions: [{ id: 'saved-session', name: 'Saved session', models: { primary_model: 'models/session.gguf', mmproj: 'models/session-projector.gguf', draft_model: '' },
        gpu: structuredClone(manualSettings.gpu), enabled: true, execution: { threads: 10 }, model_profile_id: 'saved-source' }],
    };
    const original = structuredClone(cfg);
    const reset = resetProfileSettings(cfg, false);

    expect(reset.settings_profiles).toBe(cfg.settings_profiles);
    expect(reset.sessions).toBe(cfg.sessions);
    expect(reset).toMatchObject({ port: 9000, models_dir: 'models/custom', iters: 8, stop_existing_sessions_on_load: false });
    expect(cfg).toEqual(original);
  });

  it('creates independent editable default collections for each draft', () => {
    const cfg = customConfig();
    const first = resetProfileSettings(cfg, false);
    const second = resetProfileSettings(cfg, false);
    first.gpu!.gpu_ids.push('runtime:vulkan:Vulkan1');
    first.server_args.push('--seed', '3');
    first.chat_options.stop = ['new stop'];
    first.lora_adapters.push({ path: 'models/new-adapter.gguf', scale: 1, enabled: true });
    first.runtime_defaults!.length = 0;

    expect(second).toEqual(resetProfileSettings(customConfig(), false));
    expect(cfg).toEqual(customConfig());
  });
});
