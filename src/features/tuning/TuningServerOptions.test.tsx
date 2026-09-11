import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore, testConfig } from '../../testing/appStore';
import { withManualOverrides } from '../../shared/config/tuningDefaults';
import TuningPanel from './Tuning';
import { ADVANCED_SAMPLING_FIELDS, chatOptionValue } from './tuningFields';

const help = '--mmap, --no-mmap                       memory mapping\n--cache-ram N                          cache memory\n--min-p N                              minimum probability\n--top-p N                              probability\n--port PORT                            HTTP port\n--future-pr-option N                   custom build option';
beforeEach(() => {
  vi.spyOn(api, 'rtProbe').mockResolvedValue({ backend: 'cpu', build: 'b123', executable: 'llama-server', state: 'available', version: 'test', flags: [], devices: [], diagnostics: [], server_help: help });
});

function mount() {
  let saved = { ...structuredClone(testConfig), runtime_defaults: ['top_p'], server_args: ['--cache-ram', '-1'] };
  function Live() {
    const [cfg, setCfg] = useState(saved);
    return <I18nProvider initialLocale="en"><TuningPanel store={{ ...createTestStore(), cfg, updateConfig: async patch => {
      saved = { ...saved, ...withManualOverrides(saved, typeof patch === 'function' ? patch(saved) : patch) };
      setCfg(saved);
      return saved;
    } }} /></I18nProvider>;
  }
  render(<Live />);
  return () => saved;
}

function openOption(flag: string) {
  const element = document.querySelector<HTMLDetailsElement>(`[data-server-option="${flag}"]`)!;
  element.open = true;
  return within(element);
}

describe('server option editing', () => {
  it('discovers a custom build option, saves mmap, and resets it without removing other settings', async () => {
    const cfg = mount();
    fireEvent.click(screen.getByRole('button', { name: 'All server options' }));
    await waitFor(() => expect(document.querySelector('[data-server-option="--future-pr-option"]')).toBeInTheDocument());
    expect(document.querySelector('[data-server-option="--load-mode"]')).not.toBeInTheDocument();
    const mmap = openOption('--mmap');
    fireEvent.click(mmap.getByRole('button', { name: 'Set custom value' }));
    fireEvent.change(mmap.getByRole('combobox'), { target: { value: '--no-mmap' } });
    fireEvent.click(mmap.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(cfg().server_args).toEqual(['--cache-ram', '-1', '--no-mmap']));
    fireEvent.click(mmap.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(cfg().server_args).toEqual(['--cache-ram', '-1']));
  });
  it('saves port through the dedicated config and rejects an invalid port', async () => {
    const cfg = mount();
    fireEvent.click(screen.getByRole('button', { name: 'All server options' }));
    await waitFor(() => expect(document.querySelector('[data-server-option="--port"]')).toBeInTheDocument());
    const port = openOption('--port');
    fireEvent.change(port.getByRole('textbox'), { target: { value: '9000' } });
    fireEvent.click(port.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(cfg().port).toBe(9000));
    expect(cfg().server_args).toEqual(['--cache-ram', '-1']);
    fireEvent.change(port.getByRole('textbox'), { target: { value: '65536' } });
    fireEvent.click(port.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(port.getByRole('alert')).toHaveTextContent('1–65535'));
    expect(cfg().port).toBe(9000);
  });
  it('restores request inheritance when resetting a raw sampling override', async () => {
    const cfg = mount();
    fireEvent.click(screen.getByRole('button', { name: 'All server options' }));
    await waitFor(() => expect(document.querySelector('[data-server-option="--top-p"]')).toBeInTheDocument());
    const topP = openOption('--top-p');
    fireEvent.click(topP.getByRole('button', { name: 'Set custom value' }));
    fireEvent.change(topP.getByRole('textbox'), { target: { value: '0.6' } });
    fireEvent.click(topP.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(cfg().top_p).toBe(0.6));
    expect(cfg().runtime_defaults).not.toContain('top_p');
    fireEvent.click(topP.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(cfg().runtime_defaults).toContain('top_p'));
    expect(cfg().server_args).toEqual(['--cache-ram', '-1']);
  });
  it('displays server sampling overrides and prioritizes explicit request values', () => {
    const field = ADVANCED_SAMPLING_FIELDS.find(item => item.key === 'min_p')!;
    expect(chatOptionValue({ server_args: ['--min-p', '0.17'] }, field)).toBe(0.17);
    expect(chatOptionValue({ server_args: ['--min-p=0.17'], chat_options: { min_p: 0.1 } }, field)).toBe(0.1);
  });
});
