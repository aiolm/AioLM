import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import { SERVER_OPTIONS } from '../../shared/config/serverOptions';
import { testConfig } from '../../testing/appStore';
import type { AppConfig } from '../../shared/api/types';
import DraftTuningEditor from './DraftTuningEditor';
import { withManualOverrides } from '../../shared/config/tuningDefaults';

const runtime = {
  options: SERVER_OPTIONS,
  verified: false,
  loading: false,
  error: undefined,
  capabilities: undefined,
  refresh: vi.fn(),
};

function mount(section: string, initialConfig: AppConfig, benchmark = false) {
  const onInvalid = vi.fn();
  function Harness() {
    const [cfg, setCfg] = useState(initialConfig);
    return <>
      <DraftTuningEditor
        cfg={cfg}
        section={section}
        disabled={false}
        benchmark={benchmark}
        runtime={runtime}
        onChange={patch => setCfg(current => ({ ...current, ...withManualOverrides(current, patch) }))}
        onInvalid={onInvalid}
      />
      <output data-testid="draft-config">{JSON.stringify(cfg)}</output>
    </>;
  }
  render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
  return { onInvalid, config: () => JSON.parse(screen.getByTestId('draft-config').textContent ?? '{}') as AppConfig };
}

describe('fixed numeric settings', () => {
  it('accepts model context zero or at least 512 without accepting a value native save would clamp', () => {
    const { config, onInvalid } = mount('tuning', { ...testConfig, ctx_size: 0, runtime_defaults: [] });
    const context = screen.getByRole('spinbutton', { name: 'Context size' });
    fireEvent.change(context, { target: { value: '256' } });
    expect(context).toHaveAttribute('aria-invalid', 'true');
    expect(onInvalid).toHaveBeenLastCalledWith('ctx_size', true);
    expect(config().ctx_size).toBe(0);
    fireEvent.change(context, { target: { value: '512' } });
    expect(config().ctx_size).toBe(512);
    fireEvent.change(context, { target: { value: '0' } });
    expect(config().ctx_size).toBe(0);
  });

  it('rejects explicit microbatches above batch and batch reductions below explicit microbatch', () => {
    const { config, onInvalid } = mount('tuning', { ...testConfig, batch_size: 2048, ubatch_size: 512, runtime_defaults: [] });
    const batch = screen.getByRole('spinbutton', { name: 'Batch size' });
    const microbatch = screen.getByRole('spinbutton', { name: 'Micro batch size' });
    fireEvent.change(microbatch, { target: { value: '4096' } });
    expect(onInvalid).toHaveBeenLastCalledWith('ubatch_size', true);
    expect(config().ubatch_size).toBe(512);
    fireEvent.change(batch, { target: { value: '256' } });
    expect(onInvalid).toHaveBeenLastCalledWith('batch_size', true);
    expect(config().batch_size).toBe(2048);
    fireEvent.change(microbatch, { target: { value: '128' } });
    expect(onInvalid).toHaveBeenCalledWith('batch_size', false);
    expect(config()).toMatchObject({ batch_size: 256, ubatch_size: 128 });
  });

  it('validates manual microbatch against the effective inherited batch, not its stale raw placeholder', () => {
    const { config, onInvalid } = mount('tuning', { ...testConfig, batch_size: 128, ubatch_size: 512, runtime_defaults: ['batch_size'] });
    expect(screen.getByRole('spinbutton', { name: 'Batch size' })).toHaveValue(2048);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Micro batch size' }), { target: { value: '1024' } });
    expect(onInvalid).toHaveBeenLastCalledWith('ubatch_size', false);
    expect(config()).toMatchObject({ batch_size: 128, ubatch_size: 1024, runtime_defaults: ['batch_size'] });
  });

  it('allows a smaller manual batch without rewriting or blocking an inherited microbatch', () => {
    const { config, onInvalid } = mount('tuning', { ...testConfig, batch_size: 2048, ubatch_size: 512, runtime_defaults: ['ubatch_size'] });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Batch size' }), { target: { value: '128' } });
    expect(onInvalid).toHaveBeenLastCalledWith('batch_size', false);
    expect(config()).toMatchObject({ batch_size: 128, ubatch_size: 512, runtime_defaults: ['ubatch_size'] });
    expect(screen.getByRole('spinbutton', { name: 'Micro batch size' })).not.toHaveAttribute('aria-invalid');
  });

  it('accepts the keep-all sentinel without changing the default keep policy', () => {
    const { config, onInvalid } = mount('tuning', { ...testConfig, keep: 0, runtime_defaults: [] });
    const keep = screen.getByRole('spinbutton', { name: 'Keep tokens' });
    expect(keep).toHaveValue(0);
    fireEvent.change(keep, { target: { value: '-1' } });
    fireEvent.blur(keep);
    expect(config().keep).toBe(-1);
    expect(onInvalid).toHaveBeenLastCalledWith('keep', false);
  });

  it('accepts disabled Top-k and temperatures above one', () => {
    const { config, onInvalid } = mount('sampling', { ...testConfig, runtime_defaults: [] });
    const topK = screen.getByRole('spinbutton', { name: 'Top-k' });
    const temperature = screen.getByRole('spinbutton', { name: 'Temperature' });
    fireEvent.change(topK, { target: { value: '0' } });
    fireEvent.change(temperature, { target: { value: '1.5' } });
    expect(config()).toMatchObject({ top_k: 0, temperature: 1.5 });
    expect(onInvalid).toHaveBeenLastCalledWith('temperature', false);
  });

  it('shows stored advanced values outside slider policy without rewriting them on blur', () => {
    const { config } = mount('sampling', { ...testConfig, runtime_defaults: [], chat_options: { dry_multiplier: 4, mirostat: 3 } });
    fireEvent.click(screen.getByText('More llama.cpp sampling controls'));
    const multiplier = screen.getByRole('spinbutton', { name: 'DRY multiplier' });
    expect(multiplier).toHaveValue(4);
    expect(screen.getByRole('textbox', { name: 'Custom value for Mirostat mode' })).toHaveValue('3');
    fireEvent.blur(multiplier);
    expect(config().chat_options).toEqual({ dry_multiplier: 4, mirostat: 3 });
  });

  it('rejects zero repetition penalty but accepts a positive value below slider step', () => {
    const { config, onInvalid } = mount('sampling', { ...testConfig, runtime_defaults: [], chat_options: { repeat_penalty: 1 } });
    fireEvent.click(screen.getByText('More llama.cpp sampling controls'));
    const penalty = screen.getByRole('spinbutton', { name: 'Repeat penalty' });
    fireEvent.change(penalty, { target: { value: '0' } });
    expect(penalty).toHaveAttribute('aria-invalid', 'true');
    expect(onInvalid).toHaveBeenLastCalledWith('repeat_penalty', true);
    expect(config().chat_options.repeat_penalty).toBe(1);
    fireEvent.change(penalty, { target: { value: '0.001' } });
    expect(onInvalid).toHaveBeenLastCalledWith('repeat_penalty', false);
    expect(config().chat_options.repeat_penalty).toBe(0.001);
    expect(penalty).toBeValid();
  });

  it('accepts disabled or positive idle sleep but rejects zero without replacing the stored value', () => {
    const { config, onInvalid } = mount('tuning', { ...testConfig, sleep_idle_seconds: -1, runtime_defaults: [] });
    const sleep = screen.getByRole('spinbutton', { name: 'Sleep after idle (seconds)' });
    fireEvent.change(sleep, { target: { value: '0' } });
    expect(sleep).toHaveAttribute('aria-invalid', 'true');
    expect(onInvalid).toHaveBeenLastCalledWith('sleep_idle_seconds', true);
    expect(config().sleep_idle_seconds).toBe(-1);
    fireEvent.change(sleep, { target: { value: '1' } });
    expect(config().sleep_idle_seconds).toBe(1);
    fireEvent.change(sleep, { target: { value: '-1' } });
    expect(config().sleep_idle_seconds).toBe(-1);
  });

  it('displays effective request aliases and replaces them only on explicit edits', () => {
    const { config } = mount('sampling', { ...testConfig, runtime_defaults: [], chat_options: { mirostat_eta: 0.7, mirostat_lr: 0.2, mirostat_tau: 9, max_completion_tokens: 512 } });
    fireEvent.click(screen.getByText('More llama.cpp sampling controls'));
    const rate = screen.getByRole('spinbutton', { name: 'Mirostat learning rate' });
    expect(rate).toHaveValue(0.7);
    expect(screen.getByRole('spinbutton', { name: 'Mirostat target entropy' })).toHaveValue(9);
    const tokens = screen.getByRole('spinbutton', { name: 'Max tokens' });
    expect(tokens).toHaveValue(512);
    expect(config().chat_options).toEqual({ mirostat_eta: 0.7, mirostat_lr: 0.2, mirostat_tau: 9, max_completion_tokens: 512 });
    fireEvent.change(rate, { target: { value: '0.3' } });
    fireEvent.blur(rate);
    expect(config().chat_options).toEqual({ mirostat_lr: 0.3, mirostat_tau: 9, max_completion_tokens: 512 });
    fireEvent.change(tokens, { target: { value: '256' } });
    fireEvent.blur(tokens);
    expect(config().chat_options).toEqual({ mirostat_lr: 0.3, mirostat_tau: 9, max_tokens: 256 });
  });

  it('retains saved negative windows visibly but rejects new negative request values', () => {
    const { config, onInvalid } = mount('sampling', { ...testConfig, runtime_defaults: [], chat_options: { repeat_last_n: -1, dry_penalty_last_n: -1 } });
    fireEvent.click(screen.getByText('More llama.cpp sampling controls'));
    const repeat = screen.getByRole('spinbutton', { name: 'Repeat last n' });
    const dry = screen.getByRole('spinbutton', { name: 'DRY penalty last n' });
    expect(repeat).toHaveValue(-1);
    expect(dry).toHaveValue(-1);
    fireEvent.blur(repeat);
    expect(config().chat_options).toEqual({ repeat_last_n: -1, dry_penalty_last_n: -1 });
    fireEvent.change(repeat, { target: { value: '-2' } });
    expect(onInvalid).toHaveBeenLastCalledWith('repeat_last_n', true);
    expect(config().chat_options.repeat_last_n).toBe(-1);
    fireEvent.change(repeat, { target: { value: '0' } });
    expect(config().chat_options.repeat_last_n).toBe(0);
  });
});

describe('draft tuning field resets', () => {
  it('keeps native context, server parallelism and cache settings editable in benchmark mode', () => {
    const { config } = mount('tuning', { ...testConfig, ctx_size: 8192, parallel: 2, cache_type_k: 'q8_0', runtime_defaults: [] }, true);
    const context = screen.getByRole('spinbutton', { name: 'Context size' });
    const parallel = screen.getByRole('spinbutton', { name: 'Server slots' });
    expect(context).toBeEnabled();
    expect(parallel).toBeEnabled();
    fireEvent.change(context, { target: { value: '32768' } });
    fireEvent.change(parallel, { target: { value: '4' } });
    expect(config()).toMatchObject({ ctx_size: 32768, parallel: 4, cache_type_k: 'q8_0' });
  });

  it('preserves native request values in benchmark mode until explicitly cleared', () => {
    const { config } = mount('sampling', { ...testConfig, temperature: 0.7, runtime_defaults: [] }, true);
    expect(screen.getByRole('spinbutton', { name: 'Temperature' })).toBeDisabled();
    const clear = screen.getByRole('button', { name: 'Reset Temperature to default' });
    expect(clear).toBeEnabled();
    expect(config().temperature).toBe(0.7);
    fireEvent.click(clear);
    expect(config().runtime_defaults).toContain('temperature');
  });

  it('clears a custom Mirostat draft and preserves the controlled reset patch', () => {
    const { config, onInvalid } = mount('sampling', { ...testConfig, runtime_defaults: [], chat_options: { mirostat: 1, min_p: 0.2 } });
    fireEvent.click(screen.getByText('More llama.cpp sampling controls'));
    const minP = screen.getByRole('spinbutton', { name: 'Min-p' });
    fireEvent.change(minP, { target: { value: '1.5' } });
    fireEvent.blur(minP);
    expect(onInvalid).toHaveBeenCalledWith('min_p', true);

    const mirostat = screen.getByRole('combobox', { name: 'Mirostat mode' });
    fireEvent.click(mirostat);
    fireEvent.click(screen.getByRole('option', { name: 'Custom numeric value' }));
    const custom = screen.getByRole('textbox', { name: 'Custom value for Mirostat mode' });
    fireEvent.change(custom, { target: { value: 'not-a-number' } });
    fireEvent.blur(custom);
    expect(onInvalid).toHaveBeenCalledWith('mirostat', true);
    expect(screen.getByRole('button', { name: 'Reset Mirostat mode to default' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Mirostat mode to default' }));

    expect(screen.queryByRole('textbox', { name: 'Custom value for Mirostat mode' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mirostat mode' })).toHaveTextContent('Disabled');
    expect(screen.getByRole('spinbutton', { name: 'Min-p' })).toHaveValue(1.5);
    expect(config().runtime_defaults).not.toContain('mirostat');
    expect(config().chat_options).toMatchObject({ min_p: 0.2 });
    expect(config().chat_options).not.toHaveProperty('mirostat');
    expect(onInvalid).toHaveBeenLastCalledWith('mirostat', false);
  });

  it.each([
    ['spec_type', 'Speculative type(s)', 'Custom / comma-separated', 'Custom value for Speculative type(s)', 'future-draft'],
    ['spec_draft_ngl', 'Draft GPU layers', 'Custom numeric value', 'Custom value for Draft GPU layers', '37'],
  ])('clears the %s custom input through the real caller reset path', (_key, label, customOption, inputName, value) => {
    const { config } = mount('adapters', { ...testConfig, runtime_defaults: [] });
    const select = screen.getByRole('combobox', { name: label });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: customOption }));
    const custom = screen.getByRole('textbox', { name: inputName });
    fireEvent.change(custom, { target: { value } });
    fireEvent.blur(custom);
    fireEvent.click(screen.getByRole('button', { name: `Reset ${label} to default` }));

    expect(screen.queryByRole('textbox', { name: inputName })).not.toBeInTheDocument();
    expect(config().runtime_defaults).toContain(_key);
  });
});
