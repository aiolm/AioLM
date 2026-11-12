import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BenchmarkExplorerActions, { useBenchmarkProfileImport } from './BenchmarkExplorerActions';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as api from '../../shared/api/benchmarkExplorer';
import * as providers from '../../shared/api';
import { runtimeHelpResolvePlan, type EffectiveSchema } from '../../shared/api/runtimeHelp';
import { testConfig } from '../../testing/appStore';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import type { AppStore } from '../../shared/state/store';
import type { AppConfig } from '../../shared/api/types';
import type { JsonValue } from '../../shared/config/tuningValidation';
import type { ServingPerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';
import { webcrypto } from 'node:crypto';

vi.mock('../../shared/api/benchmarkExplorer', () => ({
  openAiolmWebsite: vi.fn(async () => undefined), openBenchmarkExplorer: vi.fn(async () => undefined),
  readPublicBenchmark: vi.fn(), onBenchmarkProfileImport: vi.fn(),
}));
vi.mock('../../shared/api/transport', () => ({ isNativeRuntimeAvailable: () => true, invoke: vi.fn() }));
vi.mock('../../shared/api', async importOriginal => ({ ...await importOriginal<typeof providers>(),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerOptionSchema: vi.fn(),
}));
vi.mock('../../shared/api/runtimeHelp', async importOriginal => ({ ...await importOriginal<object>(), runtimeHelpResolvePlan: vi.fn() }));

let importRecord: (id: string) => void;
let cfg: AppConfig;
let store: AppStore;
const stop = vi.fn();
const known = <T,>(value: T) => ({ value, certainty: 'documented' as const });
const batch = { ...schemaOption({ key: 'destination_batch', flag: '--batch', group: 'Runtime', target: 'launch', kind: { type: 'integer' } }), benchmark_public: known(true) };
const checked = () => effectiveSchema([], [batch], { benchmark_names: { destination_batch: 'batch' } });
const detail = { id: 'public-1', benchmark: { schema_version: 3,
  runtime: { name: null, version: null, backend: null, build: null, variant: null, plugin_version: null },
  execution: { topology: 'attached', memory_scope: 'unavailable', settings: [
    { target: 'launch', scope: [], name: 'batch', value: 16, unit: null, role: null },
    { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
  ] } } };
const localRecord: ServingPerformanceBenchmarkRecord = {
  schemaVersion: 2, id: 'local-run', createdAt: 1000, model: '/synthetic/private-model',
  request: { run_id: 'local-run', method: { id: 'openai-chat-serving', version: 1 }, context_profile: 'novel_en',
    prompt_bytes: [4096], max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: true, request_usage: false },
  result: { run_id: 'local-run', status: 'failed', rows: [], args: ['--batch', '99', '--api-key', 'synthetic-secret'],
    provenance: { schema_version: 2, app_version: '0.3.5', method: { id: 'openai-chat-serving', version: 1 },
      workload: { corpus: 'novel_en', corpus_version: 1, inputs: [{ bytes: 4096, sha256: 'a'.repeat(64) }],
        max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: true, request_usage: false, cache_policy: 'as_configured' },
      runtime: { name: 'Fourth engine', version: null, backend: null, build: null, variant: null, plugin_version: null },
      model: { format: 'unknown', status: 'unidentified', sha256: null, size_bytes: null }, recorded_model_label: 'Recorded model',
      environment: { scope: 'aiolm_host', os: 'linux', arch: 'aarch64', cpu: { name: 'Example CPU', logical_cores: 8 },
        installed_gpus: [], execution: { mode: 'unknown', selected_gpus: [], devices: [], selection_complete: false }, detection: '' },
      execution: { topology: 'attached', memory_scope: 'unavailable', settings: [
        { target: 'launch', scope: [], name: 'batch', value: 16, unit: null, role: null },
      ] },
    },
  },
};
function Harness() {
  const importer = useBenchmarkProfileImport(store);
  return <><BenchmarkExplorerActions listenerReady={importer.listenerReady} />
    {importer.importDialog}
    <button type="button" onClick={() => void importer.importLocal(localRecord)}>Import local run</button>
    {importer.notice && <p role="status">{importer.notice.text}</p>}</>;
}
async function openImport(id = 'public-1') {
  await waitFor(() => expect(api.onBenchmarkProfileImport).toHaveBeenCalled());
  await act(async () => importRecord(id));
  return screen.findByRole('dialog');
}
async function chooseRuntime(name = /build-one/) {
  fireEvent.click(await screen.findByRole('radio', { name }));
  return screen.findByRole('button', { name: 'Create profile' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  cfg = { ...structuredClone(testConfig), active_provider: 'custom.destination', active_runtime: 'build-one' };
  store = { getConfig: () => cfg, updateConfig: vi.fn(async (patch: Parameters<AppStore['updateConfig']>[0]) => { cfg = { ...cfg, ...(typeof patch === 'function' ? patch(cfg) : patch) }; return cfg; }) } as unknown as AppStore;
  vi.mocked(api.onBenchmarkProfileImport).mockImplementation(async cb => { importRecord = cb; return stop; });
  vi.mocked(api.readPublicBenchmark).mockResolvedValue(detail);
  vi.mocked(providers.providerCatalog).mockResolvedValue([{ id: 'custom.destination', engine: 'Destination engine', server: 'engine', availability: { supported: true, detail: '' }, options: [] }]);
  const runtime: providers.RuntimeInstance = { provider: 'custom.destination', id: 'build-one', engine: 'Destination engine', server: 'engine', version: '1.0', accelerator: 'cpu', installation: 'external', location: '/synthetic/one', available: true, problems: [] };
  vi.mocked(providers.providerRuntimes).mockResolvedValue([runtime, { ...runtime, id: 'build-two', location: '/synthetic/two' }]);
  vi.mocked(providers.providerOptionSchema).mockResolvedValue(checked());
  vi.mocked(runtimeHelpResolvePlan).mockResolvedValue({ argv: ['--batch', '16'], request: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

  it('requires destination selection and explicit confirmation, then preserves user edits on reimport', async () => {
    const before = structuredClone(cfg);
    const view = render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    const dialog = await openImport();
    expect(dialog.parentElement).toBe(document.body);
    expect(within(dialog).getByRole('button', { name: 'Create profile' })).toBeDisabled();
    expect(store.updateConfig).not.toHaveBeenCalled();
    await chooseRuntime();
    const confirm = screen.getByRole('button', { name: 'Create profile' });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(dialog).toHaveTextContent('destination_batch');
    fireEvent.click(confirm);
    expect(await screen.findByRole('status')).toHaveTextContent('Profile created:');
    const profile = cfg.settings_profiles!.entries.find(entry => entry.id.startsWith('profile-benchmark-'))!;
    expect(profile.id).toMatch(/^profile-benchmark-[a-f0-9]{64}$/);
    expect(profile.settings).toEqual({ provider_options: { 'custom.destination': { destination_batch: 16 } } });
    expect({ ...cfg, settings_profiles: before.settings_profiles }).toEqual(before);
    profile.name = 'Edited benchmark profile';
    profile.settings.provider_options!['custom.destination']!.destination_batch = 8;
    const saved = structuredClone(cfg);
    await openImport(); await chooseRuntime();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create profile' })).toBeEnabled());
    expect(screen.getByRole('dialog')).toHaveTextContent('user-edited settings will be kept');
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cfg).toEqual(saved);
    expect(screen.getByRole('status')).toHaveTextContent('Edited benchmark profile');
    view.unmount(); expect(stop).toHaveBeenCalledOnce();
  });

  it('discards cancelled source reads and stale destination schemas without saving to another target', async () => {
    let resolveSource!: (value: JsonValue) => void;
    vi.mocked(api.readPublicBenchmark).mockReturnValueOnce(new Promise(resolve => { resolveSource = resolve; }));
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    await openImport();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => resolveSource(detail));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
    let resolveSchema!: (value: EffectiveSchema) => void;
    vi.mocked(providers.providerOptionSchema).mockReturnValueOnce(new Promise(resolve => { resolveSchema = resolve; }));
    await openImport(); await chooseRuntime();
    fireEvent.click(screen.getByRole('radio', { name: /build-two/ }));
    await waitFor(() => expect(providers.providerOptionSchema).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create profile' })).toBeEnabled());
    await act(async () => resolveSchema(effectiveSchema([], [], { benchmark_names: {} })));
    expect(screen.getByRole('dialog')).toHaveTextContent('destination_batch');
    expect(screen.queryByText(/No compatible launch settings/)).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('uses the same destination confirmation for failed local runs and never restores their raw private arguments', async () => {
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    const before = structuredClone(cfg);
    fireEvent.click(screen.getByRole('button', { name: 'Import local run' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
    await chooseRuntime();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create profile' })).toBeEnabled());
    expect(screen.getByRole('dialog')).toHaveTextContent('16');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('synthetic-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cfg).toEqual(before);
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(api.readPublicBenchmark).not.toHaveBeenCalled();
  });

  it('shows real schema errors, retries, and explicitly confirms an empty default profile', async () => {
    vi.mocked(providers.providerOptionSchema).mockRejectedValueOnce(new Error('Synthetic checked-schema failure'));
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    await openImport(); await chooseRuntime();
    expect(await screen.findByText(/Synthetic checked-schema failure/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create profile' })).toBeDisabled();
    vi.mocked(providers.providerOptionSchema).mockResolvedValueOnce(effectiveSchema([], [], { benchmark_names: {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const confirm = await screen.findByRole('button', { name: 'Create default profile' });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByRole('dialog')).toHaveTextContent('not a reproduction of this run');
    expect(store.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cfg.settings_profiles!.entries.find(entry => entry.id.startsWith('profile-benchmark-'))?.settings).toEqual({});
  });

  it('reuses old same-provider IDs unchanged and prevents reselection while saving', async () => {
    cfg.settings_profiles = { version: 1, revision: 1, entries: [{ id: 'profile-benchmark-public-1', name: 'Old edited profile', provider: 'custom.destination', scope: 'global', revision: 3, settings: { provider_options: { 'custom.destination': { destination_batch: 4 } } } }], applied: {}, legacy_imported: true };
    let finishSave!: (value: AppConfig) => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(async patch => {
      cfg = { ...cfg, ...(typeof patch === 'function' ? patch(cfg) : patch) };
      return new Promise(resolve => { finishSave = resolve; });
    });
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    await openImport(); await chooseRuntime();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create profile' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(screen.getByRole('radio', { name: /build-two/ })).toBeDisabled();
    await act(async () => importRecord('another-source'));
    expect(api.readPublicBenchmark).toHaveBeenCalledTimes(1);
    await act(async () => finishSave(cfg));
    expect(cfg.settings_profiles.entries.filter(entry => entry.id.startsWith('profile-benchmark-'))).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Old edited profile');
  });

  it('rejects invalid record ids and keeps save errors in the confirmation for retry', async () => {
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    await waitFor(() => expect(api.onBenchmarkProfileImport).toHaveBeenCalled());
    await act(async () => importRecord('../manage'));
    expect(api.readPublicBenchmark).not.toHaveBeenCalled();
    vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error('disk full'));
    await openImport(); await chooseRuntime();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create profile' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText(/disk full/)).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(cfg.settings_profiles?.entries.some(entry => entry.id.startsWith('profile-benchmark-'))).not.toBe(true);
  });
});
