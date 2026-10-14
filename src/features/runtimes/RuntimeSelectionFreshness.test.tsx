import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as api from '../../shared/api';
import { testConfig } from '../../testing/appStore';
import type { AppStore } from '../../shared/state/store';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import { publishInstalledRuntimes, resetInstalledRuntimes } from '../../shared/runtime/installedRuntimes';
import ExternalRuntimeRegistration from './ExternalRuntimeRegistration';
import ProviderEnvironments from './ProviderEnvironments';
import { useDeepVerification } from './useDeepVerification';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  isNativeRuntimeAvailable: () => true,
  providerCatalog: vi.fn(async () => []),
  providerRuntimes: vi.fn(async () => []),
  providerRemove: vi.fn(async () => undefined),
  runtimeAdapterRegister: vi.fn(),
  pickRuntimeAdapter: vi.fn(),
  rtCancel: vi.fn(),
  rtList: vi.fn(async () => []),
  verifyModelDeeply: vi.fn(),
  verifyCancel: vi.fn(async () => undefined),
}));

const synthetic = (version: string): api.RuntimeInstance => ({
  provider: 'custom.synthetic', id: 'syn-1', engine: 'Synthetic engine', server: 'synthetic', version,
  accelerator: 'cpu', installation: 'external', location: 'synthetic', available: true, problems: [],
});
const customConfig = { ...testConfig, active_provider: 'custom.synthetic' as const, active_runtime: 'syn-1' };

beforeEach(() => {
  vi.clearAllMocks();
  resetInstalledRuntimes();
});

describe('runtime labels follow the current inventory (U2)', () => {
  it('names the re-registered runtime version, not the one read before re-registration', async () => {
    vi.mocked(api.providerRuntimes).mockResolvedValue([synthetic('synthetic-1.0')]);
    render(<I18nProvider initialLocale="en">
      <ExternalRuntimeRegistration locked={false} onRegistered={vi.fn()} onBusyChange={vi.fn()} />
      <p data-testid="selection"><RuntimeSelectionLabel config={customConfig} /></p>
    </I18nProvider>);
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('synthetic-1.0'));

    vi.mocked(api.providerRuntimes).mockResolvedValue([synthetic('1.1-cors')]);
    vi.mocked(api.runtimeAdapterRegister).mockResolvedValue({ engine_id: 'custom.synthetic', runtime_id: 'syn-1', display_name: 'Synthetic engine' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'synthetic/runtime.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probe & register' }));
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('1.1-cors'));
    expect(screen.getByTestId('selection')).not.toHaveTextContent('synthetic-1.0');
  });

  it('stops naming a removed runtime version', async () => {
    vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'custom.synthetic', engine: 'Synthetic engine', server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.mocked(api.providerRuntimes).mockResolvedValue([synthetic('synthetic-1.0')]);
    render(<I18nProvider initialLocale="en">
      <ProviderEnvironments active provider="custom.synthetic" />
      <p data-testid="selection"><RuntimeSelectionLabel config={customConfig} /></p>
    </I18nProvider>);
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('synthetic-1.0'));
    vi.mocked(api.providerRuntimes).mockResolvedValue([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.providerRemove).toHaveBeenCalledWith('custom.synthetic', 'syn-1'));
    await waitFor(() => expect(screen.getByTestId('selection')).not.toHaveTextContent('synthetic-1.0'));
  });

  it('never shows a superseded llama.cpp version while switching back to that engine', () => {
    const llamaConfig = { ...testConfig, active_provider: 'llama.cpp' as const, active_backend: 'cuda', active_build: 'b10638' };
    publishInstalledRuntimes([{ backend: 'cuda', build: 'b10638', dir: 'runtimes/cuda-b10638', size_mb: 1, version: { semver: '0.3.0-dev', build: 10638, commit: 'aaa' } }]);
    const seen: string[] = [];
    function Probe({ config }: { config: api.AppConfig }) {
      const ref = useRef<HTMLParagraphElement>(null);
      // Layout effects see every committed frame, including one later corrected by a passive effect.
      useLayoutEffect(() => { seen.push(ref.current?.textContent ?? ''); });
      return <p ref={ref}><RuntimeSelectionLabel config={config} /></p>;
    }
    const view = (config: api.AppConfig) => <I18nProvider initialLocale="en"><Probe config={config} /></I18nProvider>;
    const rendered = render(view(llamaConfig));
    rendered.rerender(view(customConfig));
    act(() => publishInstalledRuntimes([{ backend: 'cuda', build: 'b10638', dir: 'runtimes/cuda-b10638', size_mb: 1, version: { semver: '0.3.1', build: 10638, commit: 'bbb' } }]));
    seen.length = 0;
    rendered.rerender(view(llamaConfig));
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) expect(text).not.toContain('0.3.0-dev');
    expect(seen.at(-1)).toContain('0.3.1');
  });
});

describe('deep verification results belong to what was verified (U2)', () => {
  function verifyHarness(initial: api.AppConfig) {
    const holder = { cfg: initial };
    const store = { get cfg() { return holder.cfg; }, getConfig: () => holder.cfg } as unknown as AppStore;
    return { holder, store };
  }

  it('drops a result once the selected runtime changes', async () => {
    const llamaConfig = { ...testConfig, active_provider: 'llama.cpp' as const, active_backend: 'cuda', active_build: 'b10638', active_model: 'models/synthetic.gguf' };
    const { holder, store } = verifyHarness(llamaConfig);
    vi.mocked(api.verifyModelDeeply).mockResolvedValue({ verdict: 'pass', detail: 'synthetic match', suite_version: 1, recorded_at: '' });
    function Harness() {
      const deep = useDeepVerification(store, 'en');
      return <><button type="button" onClick={deep.start}>verify</button><p data-testid="record">{deep.record?.detail ?? 'none'}</p></>;
    }
    const rendered = render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'verify' })); });
    expect(screen.getByTestId('record')).toHaveTextContent('synthetic match');
    holder.cfg = { ...llamaConfig, active_build: 'b10700' };
    rendered.rerender(<Harness />);
    expect(screen.getByTestId('record')).toHaveTextContent('none');
  });

  it('drops a result when its runtime is registered again', async () => {
    const config = { ...customConfig, active_model: 'models/synthetic.gguf' };
    const { store } = verifyHarness(config);
    vi.mocked(api.verifyModelDeeply).mockResolvedValue({ verdict: 'unsupported', detail: 'synthetic-1.0 result', suite_version: 1, recorded_at: '' });
    vi.mocked(api.runtimeAdapterRegister).mockResolvedValue({ engine_id: 'custom.synthetic', runtime_id: 'syn-1', display_name: 'Synthetic engine' });
    function Harness() {
      const deep = useDeepVerification(store, 'en');
      return <><ExternalRuntimeRegistration locked={false} onRegistered={vi.fn()} onBusyChange={vi.fn()} />
        <button type="button" onClick={deep.start}>verify</button><p data-testid="record">{deep.record?.detail ?? 'none'}</p></>;
    }
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'verify' })); });
    expect(screen.getByTestId('record')).toHaveTextContent('synthetic-1.0 result');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'synthetic/runtime.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probe & register' }));
    await waitFor(() => expect(api.runtimeAdapterRegister).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('record')).toHaveTextContent('none'));
  });
});
