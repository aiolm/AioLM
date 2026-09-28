import { describe, expect, it } from 'vitest';
import { describeServerOption, SERVER_OPTIONS } from '../../shared/config/serverOptions';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { isCustomizedSetting } from './profileValueState';

const reference = tuningResetValues(SERVER_OPTIONS);
const custom = (key: string, value: unknown, settings = {}, options = SERVER_OPTIONS, verified = false) =>
  isCustomizedSetting(key, value, settings, options, verified);

describe('customized profile values', () => {
  it('keeps inherited fields muted even when a stale explicit value remains', () => {
    expect(custom('batch_size', 16, { runtime_defaults: ['batch_size'], batch_size: 16 })).toBe(false);
    expect(custom('ctx_size', 32768, { runtime_defaults: ['ctx_size'] })).toBe(false);
    expect(custom('batch_size', 16, { runtime_defaults: ['ubatch_size'] })).toBe(true);
  });

  it('mutes explicit values equal to the app or documented default and emphasizes different ones', () => {
    expect(custom('ctx_size', 4096)).toBe(false);
    expect(custom('ngl', 99)).toBe(false);
    expect(custom('ctx_size', 32768)).toBe(true);
    expect(custom('batch_size', reference.batch_size)).toBe(false);
    expect(custom('batch_size', reference.batch_size! + 1)).toBe(true);
    expect(custom('temperature', reference.temperature)).toBe(false);
    expect(custom('temperature', 0.2)).toBe(true);
    expect(custom('cache_type_k', reference.cache_type_k)).toBe(false);
    expect(custom('cache_type_k', 'q8_0')).toBe(true);
  });

  it('compares against verified runtime defaults and ignores unverified runtime help', () => {
    const runtime = [describeServerOption('-b, --batch-size N', 'logical maximum batch size (default: 4096)')!];
    expect(custom('batch_size', 4096, {}, runtime, true)).toBe(false);
    expect(custom('batch_size', reference.batch_size, {}, runtime, true)).toBe(reference.batch_size !== 4096);
    expect(custom('batch_size', reference.batch_size, {}, runtime, false)).toBe(false);
  });

  it('does not emphasize automatic app sentinels', () => {
    expect(custom('threads', 0)).toBe(false);
    expect(custom('parallel', 0)).toBe(false);
    expect(custom('parallel', -1)).toBe(false);
    expect(custom('reasoning', 'auto')).toBe(false);
    expect(custom('reasoning_preserve', 'auto')).toBe(false);
    expect(custom('reasoning_effort', 'default')).toBe(false);
    expect(custom('threads', 7)).toBe(true);
    expect(custom('reasoning_effort', 'high')).toBe(true);
  });

  it('mutes empty optional values, default GPU placement, and selection metadata', () => {
    for (const [key, value] of Object.entries({
      server_args: [], chat_options: {}, lora_adapters: [], mmproj: '', spec_draft_model: ' ', spec_draft_device: '',
      gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null },
      active_model: 'models/primary.gguf', active_backend: 'vulkan', active_build: 'custom-build', runtime_defaults: ['temperature'],
    })) expect(custom(key, value), key).toBe(false);
    expect(custom('gpu', { gpu_ids: [], split_mode: 'none', tensor_split: [] })).toBe(false);
    expect(custom('gpu', undefined)).toBe(false);
  });

  it('emphasizes nonempty advanced payloads, adapters, model paths, and GPU placement', () => {
    for (const [key, value] of Object.entries({
      server_args: ['--seed', '17'], chat_options: { seed: 42 },
      lora_adapters: [{ path: 'models/adapter.gguf', scale: 0.5, enabled: true }],
      mmproj: 'models/projector.gguf', spec_draft_model: 'models/draft.gguf',
      gpu: { gpu_ids: ['runtime:vulkan:Vulkan0'], main_gpu: null, split_mode: 'layer', tensor_split: [1], draft_gpu_id: null },
    })) expect(custom(key, value), key).toBe(true);
    expect(custom('min_p', 0.2, { chat_options: { min_p: 0.2 } })).toBe(true);
    expect(custom('n_probs', 0, { chat_options: { n_probs: 0 } })).toBe(false);
    expect(custom('response_format', { type: 'json_object' }, { chat_options: { response_format: { type: 'json_object' } } })).toBe(true);
  });

  it('stays muted when there is no default to compare against', () => {
    expect(custom('unknown_setting', 5)).toBe(false);
    expect(custom('batch_size', undefined)).toBe(false);
  });
});
