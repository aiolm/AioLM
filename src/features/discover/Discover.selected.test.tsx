import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import { getTaskSnapshot, registerTask, removeTask } from '../../shared/state/taskRegistry';
import { useModelSettings, type ModelSettingsContext } from '../model-settings/ModelSettingsProvider';
import DiscoverPanel from './Discover';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: vi.fn() }));
vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof api>(),
  hfSearchModels: vi.fn(), hfModelFiles: vi.fn(), hfInstalledFiles: vi.fn(), hfInstalledSnapshots: vi.fn(),
  hfDownloadSnapshot: vi.fn(), hfDownloadModel: vi.fn(), hfCancelDownload: vi.fn(async () => undefined),
}));

const repo: api.HfModel = { id: 'example/variants', author: 'example', downloads: 1, likes: 0, last_modified: '', tags: [], gated: false };
const inspection: api.HfRepositoryInspection = {
  gguf_files: [{ path: 'model.gguf', size_bytes: 1024, is_mmproj: false, download_url: '' }],
  safetensors_files: [
    { path: 'model.safetensors', size_bytes: 1024 },
    { path: 'model-fp16.safetensors', size_bytes: 2048 },
    { path: '4bit/model-00002-of-00002.safetensors', size_bytes: 2048 },
    { path: '4bit/model-00001-of-00002.safetensors', size_bytes: 1024 },
    { path: '8bit/model.safetensors', size_bytes: 4096 },
  ],
  has_root_safetensors: true,
};
const artifact: api.ModelArtifact = {
  path: 'models/selected-4bit', name: 'variants', format: 'mlx', role: 'model', size_bytes: 3200,
  file_count: 5, architectures: ['LlamaForCausalLM'], modalities: { text: true, image: false, audio: false, video: false },
  missing: [], incomplete: false, ownership: 'app', notes: [], repository: repo.id,
  selected_file: '4bit/model-00001-of-00002.safetensors',
};

function chooseFormat(name: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'Model format' }));
  fireEvent.click(screen.getByRole('option', { name }));
}
async function clickDownload(name: string) {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
function row(path: string) {
  return within(screen.getByText(path, { selector: 'div[title]' }).closest<HTMLElement>('[role="listitem"]')!);
}

let settings: ModelSettingsContext;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  settings = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
  vi.mocked(useModelSettings).mockReturnValue(settings);
  vi.mocked(api.hfSearchModels).mockResolvedValue([repo]);
  vi.mocked(api.hfModelFiles).mockResolvedValue(inspection);
  vi.mocked(api.hfInstalledFiles).mockResolvedValue([]);
  vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([]);
  vi.mocked(api.hfDownloadSnapshot).mockResolvedValue(artifact);
});
afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); });

describe('selected Safetensors model bundles', () => {
  it.each(['All formats', 'HF Safetensors', 'MLX Safetensors'])('offers separate standalone and folder models under %s with one accurately sized split choice', async format => {
    const store = createTestStore({ active_model: 'models/current.gguf', active_provider: 'llama.cpp' });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    if (format !== 'All formats') chooseFormat(format);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    for (const path of ['model.safetensors', 'model-fp16.safetensors', '4bit/model.safetensors', '8bit/model.safetensors']) {
      expect(await screen.findByRole('button', { name: `Download: ${path}` })).toBeVisible();
    }
    expect(row('4bit/model.safetensors').getByText('3.0 KiB')).toBeVisible();
    expect(row('model-fp16.safetensors').getByText('2.0 KiB')).toBeVisible();
    expect(screen.queryByText('4bit/model-00002-of-00002.safetensors')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download complete model folder' })).toBeVisible();
    expect(!!screen.queryByRole('button', { name: 'Download: model.gguf' })).toBe(format === 'All formats');
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['model.safetensors', 'model.safetensors'],
    ['model-fp16.safetensors', 'model-fp16.safetensors'],
    ['4bit/model.safetensors', '4bit/model-00001-of-00002.safetensors'],
    ['8bit/model.safetensors', '8bit/model.safetensors'],
  ])('downloads only the selected %s bundle and waits for explicit configuration', async (display, selectedFile) => {
    const installed = { ...artifact, path: `models/selected-${selectedFile}`, selected_file: selectedFile };
    vi.mocked(api.hfDownloadSnapshot).mockResolvedValue(installed);
    const store = createTestStore({ active_model: 'models/current.gguf', active_provider: 'llama.cpp', active_runtime: 'synthetic-runtime' });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload(`Download: ${display}`);
    const configure = await screen.findByRole('button', { name: `Configure and run: ${display}` });
    expect(api.hfDownloadSnapshot).toHaveBeenCalledExactlyOnceWith(repo.id, 'models', selectedFile);
    expect(api.hfDownloadModel).not.toHaveBeenCalled();
    expect(settings.open).not.toHaveBeenCalled();
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    expect(row(display).getByRole('button', { name: `Installed: ${display}` })).toBeDisabled();
    fireEvent.click(configure);
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({
      active_model: installed.path, active_provider: 'llama.cpp', active_runtime: 'synthetic-runtime',
    }) }));
  });

  it.each(['model-a.safetensors', 'model-b.safetensors'])('resolves %s to one installed index bundle before the refreshed lookup returns', async selected => {
    const members = ['model-a.safetensors', 'model-b.safetensors'];
    vi.mocked(api.hfModelFiles).mockResolvedValue({ ...inspection, safetensors_files: [
      { path: members[0], size_bytes: 1024 }, { path: members[1], size_bytes: 2048 },
      { path: 'other.safetensors', size_bytes: 4096 },
    ] });
    const installed = { ...artifact, path: 'models/stable-indexed', selected_file: members[0], selected_weight_files: members };
    vi.mocked(api.hfDownloadSnapshot).mockResolvedValue(installed);
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValueOnce([]).mockReturnValue(new Promise(() => {}));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload(`Download: ${selected}`);
    const configure = await screen.findByRole('button', { name: `Configure and run: ${members[0]}` });
    expect(row(members[0]).getByRole('button', { name: `Installed: ${members[0]}` })).toBeDisabled();
    expect(row(members[0]).getByText('3.0 KiB')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Download: model-b/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download: other.safetensors' })).toBeDisabled();
    fireEvent.click(configure);
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_model: installed.path }) }));
    expect(api.hfDownloadSnapshot).toHaveBeenCalledExactlyOnceWith(repo.id, 'models', selected);
  });

  it('groups an older noncanonical incomplete index selection into one retry without claiming unrelated weights', async () => {
    const members = ['model-a.safetensors', 'model-b.safetensors'];
    vi.mocked(api.hfModelFiles).mockResolvedValue({ ...inspection, safetensors_files: [
      { path: members[0], size_bytes: 1024 }, { path: members[1], size_bytes: 2048 },
      { path: 'other.safetensors', size_bytes: 4096 },
    ] });
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([{ ...artifact, selected_file: members[1],
      selected_weight_files: members, incomplete: true, missing: ['model-a.safetensors'] }]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload(`Retry: ${members[0]}`);
    expect(api.hfDownloadSnapshot).toHaveBeenCalledExactlyOnceWith(repo.id, 'models', members[0]);
    expect(screen.queryByRole('button', { name: /Retry: model-b/ })).not.toBeInTheDocument();
    expect(row('other.safetensors').queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('does not publish late index membership after browsing away and returning to the repository', async () => {
    const members = ['model-a.safetensors', 'model-b.safetensors'];
    vi.mocked(api.hfModelFiles).mockResolvedValue({ ...inspection, safetensors_files: members.map(path => ({ path, size_bytes: 1024 })) });
    vi.mocked(api.hfSearchModels).mockResolvedValue([repo, { ...repo, id: 'example/other' }]);
    let finish!: (value: api.ModelArtifact) => void;
    vi.mocked(api.hfDownloadSnapshot).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload(`Download: ${members[1]}`);
    fireEvent.click(screen.getByRole('button', { name: /example\/other/ }));
    fireEvent.click(screen.getByRole('button', { name: /example\/variants/ }));
    await screen.findByRole('button', { name: `Download: ${members[0]}` });
    await act(async () => finish({ ...artifact, selected_file: members[0], selected_weight_files: members }));
    expect(screen.queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Download: ${members[0]}` })).toBeVisible();
    expect(screen.getByRole('button', { name: `Download: ${members[1]}` })).toBeVisible();
  });

  it('isolates installed, incomplete and whole snapshot identities', async () => {
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([
      artifact,
      { ...artifact, path: 'models/interrupted-8bit', selected_file: '8bit/model.safetensors', incomplete: true, missing: ['tokenizer.json'] },
    ]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    expect(await screen.findByRole('button', { name: 'Configure and run: 4bit/model.safetensors' })).toBeVisible();
    expect(row('4bit/model.safetensors').getByRole('button', { name: 'Installed: 4bit/model.safetensors' })).toBeDisabled();
    expect(row('8bit/model.safetensors').getByRole('button', { name: 'Retry: 8bit/model.safetensors' })).toBeEnabled();
    expect(row('8bit/model.safetensors').queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
    expect(row('model.safetensors').getByRole('button', { name: 'Download: model.safetensors' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Configure and run' })).not.toBeInTheDocument();
    await clickDownload('Download complete model folder');
    expect(api.hfDownloadSnapshot).toHaveBeenCalledExactlyOnceWith(repo.id, 'models');
  });

  it('does not mark individual model choices installed from a whole snapshot', async () => {
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([{ ...artifact, selected_file: undefined }]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    expect(await screen.findByRole('button', { name: 'Configure and run' })).toBeVisible();
    await waitFor(() => expect(row('4bit/model.safetensors').getByRole('button', { name: 'Download: 4bit/model.safetensors' })).toBeEnabled());
    expect(row('4bit/model.safetensors').queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
  });

  it('offers nested-only choices without claiming a whole root snapshot is available', async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue({ ...inspection, gguf_files: [], has_root_safetensors: false, safetensors_files: inspection.safetensors_files.filter(file => file.path.includes('/')) });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload('Download: 4bit/model.safetensors');
    expect(api.hfDownloadSnapshot).toHaveBeenCalledWith(repo.id, 'models', '4bit/model-00001-of-00002.safetensors');
    expect(screen.queryByRole('button', { name: 'Download complete model folder' })).not.toBeInTheDocument();
  });

  it('blocks a missing split part instead of downloading a partial weight choice', async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue({ ...inspection, safetensors_files: [{ path: '4bit/model-00002-of-00002.safetensors', size_bytes: 2048 }] });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    expect(await screen.findByRole('button', { name: 'Download: 4bit/model.safetensors' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Download: 4bit/model.safetensors' }));
    expect(api.hfDownloadSnapshot).not.toHaveBeenCalled();
  });

  it.each(['wrong selection', 'whole result', 'missing config', 'incomplete'] as const)('does not offer configuration for a selected transfer returning %s', async result => {
    vi.mocked(api.hfDownloadSnapshot).mockResolvedValue({ ...artifact,
      selected_file: result === 'wrong selection' ? '8bit/model.safetensors' : result === 'whole result' ? undefined : artifact.selected_file,
      missing: result === 'missing config' ? ['config.json'] : [], incomplete: result === 'incomplete',
    });
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload('Download: 4bit/model.safetensors');
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === 'model-download')?.state).toBe('completed'));
    expect(screen.queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each(['repository', 'search', 'destination', 'replacement'] as const)('ignores selected completion actions after a %s change', async change => {
    let finish!: (value: api.ModelArtifact) => void;
    vi.mocked(api.hfDownloadSnapshot).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.mocked(api.hfSearchModels).mockResolvedValue([repo, { ...repo, id: 'example/other' }]);
    const store = createTestStore();
    const page = () => <I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>;
    const view = render(page());
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload('Download: 4bit/model.safetensors');
    const replacementCancel = vi.fn();
    if (change === 'repository') fireEvent.click(screen.getByRole('button', { name: /example\/other/ }));
    else if (change === 'search') fireEvent.click(screen.getByRole('button', { name: 'Search models' }));
    else if (change === 'destination') { store.cfg!.models_dir = 'models/elsewhere'; view.rerender(page()); }
    else act(() => registerTask({ id: 'model-download', kind: 'model-download', label: 'replacement', interruptible: true, cancel: replacementCancel }));
    await act(async () => finish(artifact));
    expect(screen.queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(settings.open).not.toHaveBeenCalled();
    if (change === 'replacement') expect(getTaskSnapshot().find(task => task.id === 'model-download')).toMatchObject({ state: 'running', cancel: replacementCancel });
  });

  it('refreshes an interrupted selection for retry without marking another model or the whole snapshot incomplete', async () => {
    let reject!: (cause: Error) => void;
    let installed: api.ModelArtifact[] = [];
    vi.mocked(api.hfInstalledSnapshots).mockImplementation(async () => installed);
    vi.mocked(api.hfDownloadSnapshot)
      .mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }))
      .mockImplementationOnce(async () => { installed = [artifact]; return artifact; });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload('Download: 4bit/model.safetensors');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    installed = [{ ...artifact, incomplete: true, missing: ['tokenizer.json'] }];
    await act(async () => reject(new Error('model download cancelled')));
    await waitFor(() => expect(row('4bit/model.safetensors').getByRole('button', { name: 'Retry: 4bit/model.safetensors' })).toBeEnabled());
    expect(row('4bit/model.safetensors').queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
    expect(row('8bit/model.safetensors').getByRole('button', { name: 'Download: 8bit/model.safetensors' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download complete model folder' })).toBeEnabled();
    await clickDownload('Retry: 4bit/model.safetensors');
    expect(await row('4bit/model.safetensors').findByRole('button', { name: 'Configure and run: 4bit/model.safetensors' })).toBeVisible();
    expect(settings.open).not.toHaveBeenCalled();
  });

  it.each(['network failed', 'model download cancelled'] as const)('leaves all model choices unconfigured after %s and retries the same selection', async failure => {
    let reject!: (cause: Error) => void;
    vi.mocked(api.hfDownloadSnapshot).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload('Download: 4bit/model.safetensors');
    if (failure === 'model download cancelled') {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(api.hfCancelDownload).toHaveBeenCalledOnce());
      expect(screen.getByRole('button', { name: 'Download: 8bit/model.safetensors' })).toBeDisabled();
    }
    await act(async () => reject(new Error(failure)));
    expect(getTaskSnapshot().find(task => task.id === 'model-download')?.state).toBe(failure === 'network failed' ? 'failed' : 'cancelled');
    expect(screen.queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
    await clickDownload('Download: 4bit/model.safetensors');
    expect(api.hfDownloadSnapshot).toHaveBeenNthCalledWith(2, repo.id, 'models', '4bit/model-00001-of-00002.safetensors');
    expect(await screen.findByRole('button', { name: 'Configure and run: 4bit/model.safetensors' })).toBeVisible();
    expect(row('8bit/model.safetensors').queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
  });

  it('does not revive configuration when cancellation races a successful selected result', async () => {
    let finish!: (value: api.ModelArtifact) => void;
    vi.mocked(api.hfDownloadSnapshot).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /example\/variants/ }));
    await clickDownload('Download: 4bit/model.safetensors');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.hfCancelDownload).toHaveBeenCalledOnce());
    await act(async () => finish(artifact));
    expect(screen.queryByRole('button', { name: /Configure/ })).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });
});
