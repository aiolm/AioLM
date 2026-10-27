import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import { SERVER_OPTIONS } from '../../shared/config/serverOptions';
import { testConfig } from '../../testing/appStore';
import type { AppConfig } from '../../shared/api/types';
import DraftTuningEditor from './DraftTuningEditor';

const runtime = {
  options: SERVER_OPTIONS,
  verified: false,
  loading: false,
  error: undefined,
  capabilities: undefined,
  refresh: vi.fn(),
};

function mount(section: string, initialConfig: AppConfig) {
  const onInvalid = vi.fn();
  function Harness() {
    const [cfg, setCfg] = useState(initialConfig);
    return <>
      <DraftTuningEditor
        cfg={cfg}
        section={section}
        disabled={false}
        benchmark={false}
        runtime={runtime}
        onChange={patch => setCfg(current => ({ ...current, ...patch }))}
        onInvalid={onInvalid}
      />
      <output data-testid="draft-config">{JSON.stringify(cfg)}</output>
    </>;
  }
  render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
  return { onInvalid, config: () => JSON.parse(screen.getByTestId('draft-config').textContent ?? '{}') as AppConfig };
}

describe('draft tuning field resets', () => {
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
