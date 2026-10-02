import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BenchmarkExplorerActions, { useBenchmarkProfileImport } from './BenchmarkExplorerActions';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as api from '../../shared/api/benchmarkExplorer';
import { testConfig } from '../../testing/appStore';
import type { AppStore } from '../../shared/state/store';
import type { AppConfig } from '../../shared/api/types';

vi.mock('../../shared/api/benchmarkExplorer', () => ({
  openAiolmWebsite: vi.fn(async () => undefined), openBenchmarkExplorer: vi.fn(async () => undefined),
  readPublicBenchmark: vi.fn(), onBenchmarkProfileImport: vi.fn(),
}));
vi.mock('../../shared/api/transport', () => ({ isNativeRuntimeAvailable: () => true }));

let importRecord: (id: string) => void;
let cfg: AppConfig;
let store: AppStore;
const stop = vi.fn();
function Harness() {
  const importer = useBenchmarkProfileImport(store);
  return <><BenchmarkExplorerActions listenerReady={importer.listenerReady} />
    {importer.notice && <p role="status">{importer.notice.text}</p>}</>;
}
const detail = { id: 'public-1', benchmark: { runtime: { name: 'llama.cpp', version: null, backend: 'cpu', build: 'b123' },
  execution: { context_size: 32768, parallel: 4, settings: null, effective_args: ['--batch-size', '1024'] } } };

beforeEach(() => {
  vi.clearAllMocks();
  cfg = structuredClone(testConfig);
  store = { updateConfig: vi.fn(async patch => { cfg = { ...cfg, ...(typeof patch === 'function' ? patch(cfg) : patch) }; return cfg; }) } as unknown as AppStore;
  vi.mocked(api.onBenchmarkProfileImport).mockImplementation(async cb => { importRecord = cb; return stop; });
  vi.mocked(api.readPublicBenchmark).mockResolvedValue(detail);
});
afterEach(cleanup);

describe('public benchmark actions', () => {
  it('opens the localized website and enables browsing after the import listener is ready', async () => {
    render(<I18nProvider initialLocale="ko"><Harness /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '공개 벤치마크 조회' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'AioLM 웹사이트' }));
    await waitFor(() => expect(api.openAiolmWebsite).toHaveBeenCalledWith('ko'));
    await waitFor(() => expect(screen.getByRole('button', { name: '공개 벤치마크 조회' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '공개 벤치마크 조회' }));
    expect(api.openBenchmarkExplorer).toHaveBeenCalledWith('ko', '실행 설정으로 프로필 생성', expect.any(String));
  });

  it('appends one reusable profile without replacing existing settings and leaves repeated imports unchanged', async () => {
    const before = structuredClone(cfg);
    const view = render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    await waitFor(() => expect(api.onBenchmarkProfileImport).toHaveBeenCalled());
    await act(async () => importRecord('public-1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Profile created:');
    const profile = cfg.settings_profiles!.entries.find(entry => entry.id === 'profile-benchmark-public-1');
    expect(profile?.settings).toMatchObject({ ctx_size: 32768, parallel: 4, batch_size: 1024 });
    expect({ ...cfg, settings_profiles: before.settings_profiles }).toEqual(before);
    profile!.name = 'Edited benchmark profile';
    profile!.settings.batch_size = 512;
    const saved = structuredClone(cfg);
    await act(async () => importRecord('public-1'));
    expect(cfg).toEqual(saved);
    expect(screen.getByRole('status')).toHaveTextContent('Edited benchmark profile');
    view.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects invalid record ids and shows failures without reporting a successful save', async () => {
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    await waitFor(() => expect(api.onBenchmarkProfileImport).toHaveBeenCalled());
    await act(async () => importRecord('../manage'));
    expect(api.readPublicBenchmark).not.toHaveBeenCalled();
    vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error('disk full'));
    await act(async () => importRecord('public-1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not create the profile.');
    expect(cfg.settings_profiles?.entries.some(entry => entry.id === 'profile-benchmark-public-1')).not.toBe(true);
  });
});
