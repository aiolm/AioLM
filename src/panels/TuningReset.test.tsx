import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import * as api from '../api';
import { I18nProvider } from '../i18n';
import { withManualOverrides } from '../tuningDefaults';
import { createTestStore, testConfig } from '../testing/appStore';
import Tuning from './Tuning';

const help = '--gpu-layers, --n-gpu-layers N          layers (default: auto)\n--top-p N               nucleus (default: 0.87)\n--min-p N                minimum (default: 0.12)\n--cache-ram N            memory (default: 8192)';
beforeEach(() => vi.spyOn(api, 'rtProbe').mockResolvedValue({ backend: 'cpu', build: 'b123', executable: 'llama-server', state: 'available', version: 'test', flags: [], devices: [], diagnostics: [], server_help: help }));

function mount(overrides: Partial<api.AppConfig> = {}) {
  let saved = { ...structuredClone(testConfig), ngl: 55, top_p: 0.3, chat_options: { min_p: 0.6 }, ...overrides };
  function Live() {
    const [cfg, setCfg] = useState(saved);
    return <I18nProvider initialLocale="en"><Tuning store={{ ...createTestStore(), cfg, updateConfig: async patch => {
      saved = { ...saved, ...withManualOverrides(saved, typeof patch === 'function' ? patch(saved) : patch) };
      setCfg(saved); return saved;
    } }} /></I18nProvider>;
  }
  const view = render(<Live />);
  return { saved: () => saved, view };
}
const field = (key: string) => within(document.querySelector(`[data-default-field="${key}"]`)!);

describe('reset then edit', () => {
  it('forgets saved and unsaved GPU counts, persists 99, and opens 99 after remount', async () => {
    const test = mount();
    fireEvent.change(field('ngl').getByRole('spinbutton'), { target: { value: '23' } });
    fireEvent.click(field('ngl').getByRole('button', { name: /Reset.*to default/i }));
    await waitFor(() => expect(test.saved().ngl).toBe(99));
    expect(test.saved().runtime_defaults).toContain('ngl');
    fireEvent.click(field('ngl').getByRole('button', { name: /Set custom value/ }));
    expect(field('ngl').getByRole('spinbutton')).toHaveValue(99);
    const persisted = JSON.parse(JSON.stringify(test.saved()));
    test.view.unmount(); mount(persisted);
    fireEvent.click(field('ngl').getByRole('button', { name: /Set custom value/ }));
    expect(field('ngl').getByRole('spinbutton')).toHaveValue(99);
  });
  it('uses 99 for an old inherited config that still contains a manual GPU value', () => {
    mount({ ngl: 12, runtime_defaults: ['ngl'] });
    expect(document.querySelector('[data-option-metadata="ngl"] .option-default-value > code')).toHaveTextContent('99');
    fireEvent.click(field('ngl').getByRole('button', { name: /Set custom value/ }));
    expect(field('ngl').getByRole('spinbutton')).toHaveValue(99);
  });
  it('opens an inherited draft GPU control at the numeric runtime default, not its old value or auto', async () => {
    vi.mocked(api.rtProbe).mockResolvedValue({ backend: 'cpu', build: 'b123', executable: 'llama-server', state: 'available', version: 'test', flags: [], devices: [], diagnostics: [], server_help: '--spec-draft-ngl N          layers (default: 32)' });
    mount({ spec_draft_ngl: '12', runtime_defaults: ['spec_draft_ngl'] });
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    fireEvent.click(document.querySelector('[data-tuning-category="speculative"]')!);
    await waitFor(() => expect(document.querySelector('[data-option-metadata="spec_draft_ngl"] .option-default-value > code')).toHaveTextContent('32'));
    fireEvent.click(field('spec_draft_ngl').getByRole('button', { name: /Set custom value/ }));
    expect(field('spec_draft_ngl').getByRole('textbox')).toHaveValue('32');
  });
  it('resets context to the displayed app default and discards an old reasoning message draft', async () => {
    const test = mount({ ctx_size: 8192, reasoning_budget_message: 'old message' });
    fireEvent.click(screen.getByRole('button', { name: 'Context & memory' }));
    expect(document.querySelector('[data-option-metadata="ctx_size"] .option-default-value > code')).toHaveTextContent('4096');
    fireEvent.click(field('ctx_size').getByRole('button', { name: /Reset.*to default/i }));
    await waitFor(() => expect(test.saved().ctx_size).toBe(4096));
    fireEvent.click(field('ctx_size').getByRole('button', { name: /Set custom value/ }));
    expect(field('ctx_size').getByRole('spinbutton')).toHaveValue(4096);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
    fireEvent.change(field('reasoning_budget_message').getByRole('textbox'), { target: { value: 'unsaved message' } });
    fireEvent.click(field('reasoning_budget_message').getByRole('button', { name: /Reset.*to default/i }));
    await waitFor(() => expect(test.saved().reasoning_budget_message).toBe(''));
    fireEvent.click(field('reasoning_budget_message').getByRole('button', { name: /Set custom value/ }));
    expect(field('reasoning_budget_message').getByRole('textbox')).toHaveValue('');
  });
  it('starts primary and advanced samplers at the selected runtime defaults after reset', async () => {
    const test = mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sampling' }));
    await waitFor(() => expect(document.querySelector('[data-option-metadata="top_p"]')).toHaveTextContent('0.87'));
    fireEvent.click(field('top_p').getByRole('button', { name: /Reset.*to default/i }));
    await waitFor(() => expect(test.saved().top_p).toBe(0.87));
    fireEvent.click(field('top_p').getByRole('button', { name: /Set custom value/ }));
    expect(field('top_p').getByRole('spinbutton')).toHaveValue(0.87);
    document.querySelector<HTMLDetailsElement>('.tuning-section--sampling details')!.open = true;
    fireEvent.click(field('min_p').getByRole('button', { name: /Reset.*to default/i }));
    await waitFor(() => expect(test.saved().chat_options).not.toHaveProperty('min_p'));
    fireEvent.click(field('min_p').getByRole('button', { name: /Set custom value/ }));
    expect(field('min_p').getByRole('spinbutton')).toHaveValue(0.12);
  });
  it('reopens a catalog option at its default instead of an old saved argument', async () => {
    const test = mount({ server_args: ['--cache-ram', '123'] });
    fireEvent.click(screen.getByRole('button', { name: 'All server options' }));
    await waitFor(() => expect(document.querySelector('[data-server-option="--cache-ram"]')).toBeInTheDocument());
    const row = document.querySelector<HTMLDetailsElement>('[data-server-option="--cache-ram"]')!;
    row.open = true;
    fireEvent.click(within(row).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(test.saved().server_args).toEqual([]));
    fireEvent.click(within(row).getByRole('button', { name: 'Set custom value' }));
    expect(within(row).getByRole('textbox')).toHaveValue('8192');
  });
});
