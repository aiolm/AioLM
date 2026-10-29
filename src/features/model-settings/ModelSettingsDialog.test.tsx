import { cfg, mount, numeric, openOptions } from '../../testing/modelSettingsDialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { rememberExecution } from '../models/modelExecutionState';
import { captureProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';
import * as api from '../../shared/api';
import { appliedProfile, SettingsDeliveryError } from './profileEditor';
import { describeLaunchFailure, profileStatusCopy } from './profileStatusCopy';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import { ORDER_KEY } from '../runtimes/optionOrder';

// Each file keeps isolated mocks and the original semantic journeys.
describe('model settings editor', { timeout: 45000 }, () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it.each(['llama.cpp', 'custom.prompt-preservation'] as const)('keeps unsaved instructions through %s option reset, explicit save and reopening', async provider => {
    const original = { ...cfg, active_provider: provider, active_runtime: 'synthetic', ctx_size: 12288, port: 9100,
      provider_options: { [provider]: { workers: 8 } } };
    const source = captureProfile(original, 'Prompt and options', 'global', 'Saved instructions');
    const application = materializeProfileApplication(original, 'Saved instructions', source);
    const saved = { ...original, settings_profiles: { ...emptyProfileLibrary(), entries: [source],
      applied: { [profileTargetKey(original.active_model, 'default', provider)]: application } } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [schemaOption({ key: 'workers', flag: '--workers', group: 'other', target: 'launch', kind: { type: 'integer' } })]));
    const { onProfileCommit, onApply, getSaved } = mount({ initialConfig: saved, initialSection: 'profiles' });
    expect(screen.getAllByRole('button', { name: 'Reset options to defaults' })).toHaveLength(1);
    openOptions();
    fireEvent.click(screen.getByRole('tab', { name: provider === 'llama.cpp' ? 'Generation' : 'Conversation instructions' }));
    const prompt = screen.getByRole('textbox', { name: 'Default system prompt' });
    const instructions = '  Keep my edited instructions.\nSecond line.  ';
    fireEvent.change(prompt, { target: { value: instructions } });
    const reset = screen.getByRole('button', { name: 'Reset options to defaults' });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue(instructions);
    expect(screen.getAllByRole('button', { name: 'Reset options to defaults' })).toHaveLength(1);
    expect(getSaved()).toEqual(saved);
    expect(onApply).not.toHaveBeenCalled(); expect(onProfileCommit).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(save).toBeEnabled()); fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onProfileCommit).toHaveBeenCalledOnce());
    const [draft, edit] = vi.mocked(onProfileCommit).mock.calls[0];
    expect(draft).toMatchObject({ active_provider: provider, active_runtime: 'synthetic', active_model: original.active_model, port: 9100 });
    expect(edit.application.system_prompt).toBe(instructions);
    expect(edit.library.entries.find(entry => entry.id === source.id)?.system_prompt).toBe(instructions);
    expect(onApply).not.toHaveBeenCalled();
    const persisted = getSaved();
    cleanup();
    mount({ initialConfig: persisted, initialSection: 'prompt' });
    expect(screen.getByRole('textbox', { name: 'Default system prompt' })).toHaveValue(instructions);
  });

  it.each(['stale', 'unchecked'] as const)('does not offer an option reset before a %s engine schema is checked', async help_state => {
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [], { help_state }));
    mount({ initialConfig: { ...cfg, active_provider: 'custom.unchecked', active_runtime: 'synthetic' }, initialSection: 'profiles' });
    const reset = screen.getByRole('button', { name: 'Reset options to defaults' });
    expect(reset).toBeDisabled();
    await within(screen.getByRole('region', { name: 'Current values' })).findByText('The engine’s options need to be checked again. Reload its help before using these saved settings.');
    expect(reset).toBeDisabled();
  });

  it('retains malformed option order and reports review without claiming the reset succeeded', async () => {
    const provider = 'custom.order-review';
    const values = { workers: 8, [ORDER_KEY]: { version: 2, occurrences: [{ key: 'workers' }] } };
    const saved: api.AppConfig = { ...cfg, active_provider: provider, active_runtime: 'synthetic', provider_options: { [provider]: values } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [schemaOption({ key: 'workers', flag: '--workers', group: 'other', target: 'launch', kind: { type: 'integer' } })]));
    const { onProfileCommit, onApply, getSaved } = mount({ initialConfig: saved, initialSection: 'advanced' });
    const reset = screen.getByRole('button', { name: 'Reset options to defaults' });
    await waitFor(() => expect(reset).toBeEnabled()); fireEvent.click(reset);
    expect(await screen.findByText('Check the saved option order, then try resetting again.')).toBeVisible();
    expect(screen.queryByText('Options reset to defaults.')).not.toBeInTheDocument();
    expect(screen.queryByText('Options already use defaults.')).not.toBeInTheDocument();
    expect(getSaved()).toEqual(saved);
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
  });

  it.each([
    { draft: 'clean', confirmation: 'native composition', dirty: false, isComposing: true, keyCode: 13 },
    { draft: 'edited', confirmation: 'native composition', dirty: true, isComposing: true, keyCode: 13 },
    { draft: 'clean', confirmation: '229 fallback', dirty: false, isComposing: false, keyCode: 229 },
    { draft: 'edited', confirmation: '229 fallback', dirty: true, isComposing: false, keyCode: 229 },
    { draft: 'clean', confirmation: 'compositionend before Enter', dirty: false, isComposing: false, keyCode: 13, committed: true },
    { draft: 'edited', confirmation: 'compositionend before Enter', dirty: true, isComposing: false, keyCode: 13, committed: true },
  ] as const)('keeps the $draft model preview during $confirmation Enter and loads only after confirmation', async scenario => {
    const { dirty, isComposing, keyCode } = scenario;
    const committed = 'committed' in scenario;
    const nextPath = 'models/模型-한글-🦊.gguf';
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [
      { name: 'a.gguf', path: cfg.active_model, size_mb: 3000, is_vision: false },
      { name: '模型-한글-🦊.gguf', path: nextPath, size_mb: 1500, is_vision: false },
    ], truncated: false });
    vi.spyOn(api, 'modelMetadata').mockResolvedValue({});
    rememberExecution({ ...cfg, active_model: nextPath, ctx_size: 16384 });
    const stored = localStorage.getItem('aiolm-model-execution');
    const initial = structuredClone(cfg);
    const initialBefore = structuredClone(initial);
    const { onApply, onClose, onProfileCommit, onReloadProfile, getSaved } = mount({ initialSection: 'tuning', initialConfig: initial });
    const savedBefore = structuredClone(getSaved());
    if (dirty) {
      fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
      fireEvent.blur(numeric('ctx_size'));
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Model' }));
    const oldModel = await screen.findByRole('button', { name: /^a\.gguf/ });
    const nextModel = screen.getByRole('button', { name: /^模型-한글-🦊\.gguf/ });
    const path = screen.getByRole('textbox', { name: 'Model path' });
    fireEvent.change(path, { target: { value: nextPath } });
    if (committed) {
      // Native WebKit can omit compositionstart and finish composition before Enter.
      fireEvent.keyDown(path, { key: 'Unidentified', keyCode: 229 });
      fireEvent.input(path, { target: { value: nextPath }, inputType: 'insertFromComposition', isComposing: true });
      fireEvent.compositionEnd(path, { data: '한글' });
    }
    let nativeDefaultAvailable = false;
    await act(async () => { nativeDefaultAvailable = fireEvent.keyDown(path, { key: 'Enter', keyCode, isComposing }); });
    const header = () => document.querySelector('.model-settings-header p[title]');
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
    expect(header()).toHaveAttribute('title', cfg.active_model);
    expect(oldModel).toHaveAttribute('aria-pressed', 'true');
    expect(nextModel).toHaveAttribute('aria-pressed', 'false');
    expect(numeric('ctx_size')).toHaveValue(dirty ? 8192 : cfg.ctx_size);
    expect(path).toHaveValue(nextPath);
    expect(screen.getByRole('button', { name: 'Load into editor' })).toBeEnabled();
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onReloadProfile).not.toHaveBeenCalled();
    expect(getSaved()).toEqual(savedBefore);
    expect(initial).toEqual(initialBefore);
    expect(localStorage.getItem('aiolm-model-execution')).toBe(stored);
    expect(nativeDefaultAvailable).toBe(!committed);

    fireEvent.keyUp(path, { key: 'Enter', keyCode: 13 });
    await act(async () => {
      expect(fireEvent.keyDown(path, { key: 'Enter', keyCode: 13, isComposing: false })).toBe(false);
    });
    if (dirty) {
      expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
      expect(header()).toHaveAttribute('title', cfg.active_model);
      expect(numeric('ctx_size')).toHaveValue(8192);
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument());
      expect(header()).toHaveAttribute('title', cfg.active_model);
      expect(numeric('ctx_size')).toHaveValue(8192);
      expect(path).toHaveValue(nextPath);
      fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
      expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    }
    await waitFor(() => expect(nextModel).toHaveAttribute('aria-pressed', 'true'));
    openOptions();
    await waitFor(() => expect(header()).toHaveAttribute('title', nextPath));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
    expect(oldModel).toHaveAttribute('aria-pressed', 'false');
    expect(nextModel).toHaveAttribute('aria-pressed', 'true');
    expect(numeric('ctx_size')).toHaveValue(16384);
    expect(path).toHaveValue(nextPath);
    expect(screen.queryByRole('button', { name: 'Load into editor' })).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled(); expect(onReloadProfile).not.toHaveBeenCalled();
    expect(getSaved()).toEqual(savedBefore);
    expect(initial).toEqual(initialBefore);
    expect(localStorage.getItem('aiolm-model-execution')).toBe(stored);
  });
  it.each(['runtime', 'engine'] as const)('loads a typed model path without treating %s selection as profile edits', async selection => {
    const provider = 'custom.new-engine';
    const selected: api.AppConfig = { ...cfg, active_provider: provider, active_runtime: 'build-one' };
    const profile = captureProfile(selected, 'Engine profile', 'global', '');
    vi.spyOn(api, 'providerCatalog').mockResolvedValue([{ id: provider, engine: 'New engine', server: 'openai-v1', availability: { supported: true, detail: '' }, options: [] },
      { id: 'custom.previous-engine', engine: 'Previous engine', server: 'openai-v1', availability: { supported: true, detail: '' }, options: [] }]);
    vi.spyOn(api, 'providerRuntimes').mockResolvedValue(['build-one', 'build-two'].map(id => ({
      id, provider, engine: 'New engine', server: 'openai-v1', accelerator: 'synthetic', installation: 'external', location: 'synthetic', available: true, problems: [],
    })));
    const initial = selection === 'engine' ? { ...selected, active_provider: 'custom.previous-engine' as api.ProviderId } : selected;
    const { onApply, onClose, onProfileCommit } = mount({ initialSection: undefined, initialConfig: { ...initial, settings_profiles: { ...emptyProfileLibrary(), entries: [profile] } } });
    if (selection === 'engine') fireEvent.click(await screen.findByRole('radio', { name: 'New engine' }));
    await screen.findByRole('radio', { name: /^build-two/ });
    fireEvent.click(screen.getByRole('radio', { name: /^build-two/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this profile and adjust options' }));
    expect(screen.getByRole('heading', { name: 'Adjust options' })).toBeVisible();
    // Runtime selection is not a profile-owned setting; it must not make the
    // profile look edited or turn a local path load into a discard prompt.
    expect(screen.getByRole('heading', { name: selection === 'engine' ? 'Default' : 'Engine profile' })).toBeVisible();
    expect(screen.queryByText('Global profile · unsaved changes')).not.toBeInTheDocument();
    const path = screen.getByRole('textbox', { name: 'Model path' });
    fireEvent.change(path, { target: { value: 'models/next.gguf' } });
    await act(async () => { fireEvent.keyDown(path, { key: 'Enter', keyCode: 13 }); });
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load into editor' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Model & settings' })).toBeVisible();
    expect(screen.getByRole('radio', { name: /^build-two/, hidden: true })).toBeChecked();
    expect(path).toHaveValue('models/next.gguf');
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onProfileCommit).not.toHaveBeenCalled();
  });
});

const tensorLog = [
  'server exited before ready (1).',
  '0.00.056.525 I cmn common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)',
  '0.00.056.609 I srv init: The UI is disabled',
  "0.00.059.317 I srv load_model: loading model 'C:\\models\\Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64-00001-of-00033.gguf'",
  '0.00.185.799 W common_fit_params: failed to fit params to free device memory: llama_params_fit is not implemented for SPLIT_MODE_TENSOR, abort',
  "0.00.305.007 E llama_model_load: error loading model: LLAMA_SPLIT_MODE_TENSOR not implemented for architecture 'qwen4exp'",
  '0.00.305.015 E llama_model_load_from_file_impl: failed to load model',
  '0.00.306.207 E srv llama_server: exiting due to model loading error',
].join('\n');

const ansiTensorLog = `\u001b[34m${tensorLog}\u001b[0m`;

describe('launch failure summary', () => {
  it('summarizes a tensor failure without timestamps or model paths', () => {
    const view = describeLaunchFailure(`${profileStatusCopy.ko.savedFailure}${ansiTensorLog}`, 'ko');
    expect(view.summary).toBe('이 모델은 Tensor 분할 모드(실험적)를 지원하지 않습니다.\nGPU 설정의 분할 모드를 자동, layer 또는 row로 변경한 뒤 다시 실행해 주세요.');
    expect(view.summary).not.toContain('설정은 저장했지만');
    expect(view.summary).not.toMatch(/\d+\.\d+/);
    expect(view.detail).toContain('llama_model_load');
    expect(view.detail).not.toContain('\u001b');
  });

  it('falls back to the representative error line with a shortened model path', () => {
    const log = [
      'server exited before ready (9).',
      '0.02.000.000 I srv init: The UI is disabled',
      "0.03.000.000 E srv load_model: failed to load model, 'C:\\models\\Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64-00001-of-00033.gguf'",
    ].join('\n');
    const view = describeLaunchFailure(log, 'en');
    expect(view.summary).toBe("srv load_model: failed to load model, 'Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64.gguf'");
    expect(view.detail).toContain('server exited before ready (9)');
  });

  it('passes ordinary messages through without a details section', () => {
    const view = describeLaunchFailure('These settings changed elsewhere.', 'ko');
    expect(view).toEqual({ summary: 'These settings changed elsewhere.', detail: null });
  });

  it('surfaces a bare argument-parser error line', () => {
    const log = 'server exited before ready (1).\nerror: invalid argument: --no-mmap';
    const view = describeLaunchFailure(log, 'en');
    expect(view.summary).toBe('error: invalid argument: --no-mmap');
    expect(view.detail).toContain('server exited before ready (1)');
  });
});

describe('launch failure display', { timeout: 45000 }, () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('shows a short summary first and keeps the raw log behind details', async () => {
    const onApply = vi.fn(async () => { throw new SettingsDeliveryError(tensorLog, cfg, appliedProfile(cfg)!); });
    mount({ onApply }, 'ko');
    fireEvent.click(await screen.findByRole('button', { name: /a\.gguf/ }));
    const start = screen.getByRole('button', { name: '프로필 저장 후 실행' });
    await waitFor(() => expect(start).toBeEnabled());
    await act(async () => { fireEvent.click(start); });
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('설정은 저장했지만');
    const summary = within(alert).getByText(/Tensor 분할 모드/);
    expect(summary.textContent).not.toMatch(/\d+\.\d+\.\d+/);
    expect(summary.textContent).not.toContain('Qwen3.8');
    expect(within(alert).getByText(/GPU 설정의 분할 모드/)).toBeVisible();
    expect(within(alert).getByText('자세히')).toBeVisible();
    expect(within(alert).getByText(/llama_model_load/)).toBeInTheDocument();
  });
});

describe('confirming a profile save', () => {
  const source = captureProfile(cfg, 'Selected profile', 'global', 'Saved prompt');
  const application = materializeProfileApplication(cfg, 'Saved prompt', source);
  const withProfile = { ...cfg, settings_profiles: { ...emptyProfileLibrary(), entries: [source], applied: { [profileTargetKey(cfg.active_model)]: application } } };

  it('shows each edited option with its own before and after arrow', () => {
    // A profile is a wide snapshot and the editor gives no sense of how much of
    // it an edit touched; overwriting one is not undoable from here.
    const { onProfileCommit } = mount({ initialSection: 'tuning', initialConfig: withProfile });
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.change(numeric('ngl'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    const confirm = screen.getByRole('dialog', { name: /^Save these changes/ });
    const changes = within(confirm).getAllByRole('term').map(term => term.parentElement!);
    expect(changes.map(row => row.querySelector('dt')?.textContent)).toEqual(['Context size', 'GPU layers']);
    expect(changes.map(row => [row.querySelector('.settings-profile-change-before')?.textContent,
      row.querySelector('.settings-profile-change-after')?.textContent])).toEqual([
      [String(cfg.ctx_size), '8192'], [String(cfg.ngl), '25'],
    ]);
    for (const row of changes) expect(row.querySelector('.settings-profile-change-arrow')).toHaveTextContent('→');
    expect(onProfileCommit).not.toHaveBeenCalled();
  });

  it('writes nothing when the confirmation is cancelled, and keeps the edit', () => {
    const { onProfileCommit } = mount({ initialSection: 'tuning', initialConfig: withProfile });
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onProfileCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /^Save these changes/ })).not.toBeInTheDocument();
    expect(numeric('ctx_size')).toHaveValue(8192);
  });

  it('says so plainly when a save would rewrite nothing', () => {
    mount({ initialSection: 'tuning', initialConfig: withProfile });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(within(screen.getByRole('dialog', { name: /^Save these changes/ })).getByText('Nothing in this profile would change.')).toBeVisible();
  });
});

describe('context size bounds', () => {
  it('accepts a context past the catalogue guess when nothing states a smaller one', async () => {
    // 131072 was an app constant, not a limit llama.cpp has; refusing a larger
    // value blocked configurations that load perfectly well.
    mount({ initialSection: 'tuning' });
    await waitFor(() => expect(numeric('ctx_size')).toBeInTheDocument());
    fireEvent.change(numeric('ctx_size'), { target: { value: '262144' } });
    expect(screen.queryByText(/Correct invalid fields/)).not.toBeInTheDocument();
    expect(numeric('ctx_size')).toHaveValue(262144);
  });

  it('still refuses an entry that is garbage rather than large and names the field in plain language', async () => {
    mount({ initialSection: 'tuning' });
    await waitFor(() => expect(numeric('ctx_size')).toBeInTheDocument());
    fireEvent.change(numeric('ctx_size'), { target: { value: '99999999' } });
    await waitFor(() => expect(screen.getByText('Correct invalid fields before applying. (Context size)')).toBeVisible());
    expect(screen.queryByText(/ctx_size/)).not.toBeInTheDocument();
  });

  it('localizes invalid field names, unknown model format badges, and model picker modalities in Korean while preserving unknown modality keys', async () => {
    vi.mocked(api.listModels).mockResolvedValueOnce({
      models: [{
        name: 'mystery.bin',
        path: 'models/mystery.bin',
        size_mb: 500,
        is_vision: false,
        artifact: {
          name: 'mystery.bin',
          path: 'models/mystery.bin',
          format: 'unknown',
          role: 'model',
          size_bytes: 500 * 1024 * 1024,
          file_count: 1,
          modalities: Object.assign({ text: true, image: true, audio: false, video: false }, { depth: true, constructor: true }),
          incomplete: false,
          missing: [],
          architectures: [],
          ownership: 'external',
          notes: [],
        },
      }],
      truncated: false,
    });
    mount({ initialSection: 'model', initialConfig: { ...cfg, active_model: 'models/mystery.bin' } }, 'ko');
    expect((await screen.findAllByText(/형식 미확인/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/형식 미확인 · 텍스트, 이미지, depth, constructor · —/)).toBeVisible();
    expect(screen.queryByText('unknown', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '성능·메모리' }));
    await waitFor(() => expect(numeric('ctx_size')).toBeInTheDocument());
    fireEvent.change(numeric('ctx_size'), { target: { value: '99999999' } });
    await waitFor(() => expect(screen.getByText('잘못 입력된 항목을 수정한 뒤 적용하세요. (컨텍스트 크기)')).toBeVisible());
  });

  it('bounds the control at what the model states it was trained for', async () => {
    vi.mocked(api.modelMetadata).mockResolvedValue({ context_length: 8192 });
    mount({ initialSection: 'tuning' });
    await waitFor(() => expect(api.modelMetadata).toHaveBeenCalled());
    fireEvent.change(numeric('ctx_size'), { target: { value: '16384' } });
    await waitFor(() => expect(screen.getByText(/Correct invalid fields/)).toBeVisible());
    fireEvent.change(numeric('ctx_size'), { target: { value: '8192' } });
    await waitFor(() => expect(screen.queryByText(/Correct invalid fields/)).not.toBeInTheDocument());
  });
});
