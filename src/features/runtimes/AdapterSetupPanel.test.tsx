import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import AdapterSetupPanel from './AdapterSetupPanel';

vi.mock('../../shared/api/runtimeHelp', async origin => ({
  ...await origin<typeof import('../../shared/api/runtimeHelp')>(),
  adapterSetupImport: vi.fn(), adapterSetupPrepare: vi.fn(),
  adapterSetupCancel: vi.fn(async () => true), pickRuntimePath: vi.fn(),
}));
const recipe: api.AdapterSetupRecipe = {
  version: 1, id: 'any.vendor', title: 'Arbitrary engine adapter', description: 'Explicit setup information',
  fields: [{ key: 'program', label: 'Installed executable', kind: 'file', required: true },
    { key: 'revision', label: 'Source revision', kind: 'text', required: true, default: 'synthetic-revision' }],
  prepare: { program: '{input:program}', args: ['--prepare'], env: {} },
};
const draft = { engine_id: 'custom.unseen' } as api.EntrypointDraft;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.pickRuntimePath).mockResolvedValue('/synthetic/engine.setup.json');
  vi.mocked(api.adapterSetupImport).mockResolvedValue(recipe);
});
function mount() {
  const onPrepared = vi.fn(), onBusyChange = vi.fn();
  const view = render(<I18nProvider initialLocale="en"><AdapterSetupPanel disabled={false} onBusyChange={onBusyChange} onPrepared={onPrepared} /></I18nProvider>);
  return { ...view, onPrepared, onBusyChange };
}

it('loads arbitrary recipe data only on request and passes exact Unicode input tokens', async () => {
  const view = mount();
  expect(api.pickRuntimePath).not.toHaveBeenCalled();
  expect(api.adapterSetupImport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Import AioLM connection setup (.json)' }));
  const program = await screen.findByLabelText('Installed executable (Required)');
  expect(screen.getByText(recipe.title)).toBeVisible();
  expect(program).toBeRequired();
  expect(screen.getByLabelText('Source revision (Required)')).toHaveValue('synthetic-revision');
  fireEvent.change(program, { target: { value: '/synthetic path/눈길 ; &/engine' } });
  vi.mocked(api.adapterSetupPrepare).mockResolvedValue(draft);
  fireEvent.submit(screen.getByRole('button', { name: 'Check installation and continue' }).closest('form')!);
  await waitFor(() => expect(view.onPrepared).toHaveBeenCalledWith(draft));
  expect(api.adapterSetupPrepare).toHaveBeenCalledWith(expect.any(String), recipe,
    { program: '/synthetic path/눈길 ; &/engine', revision: 'synthetic-revision' });
});

it('discards a cancelled late result, retains inputs and permits an explicit retry after failure', async () => {
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Import AioLM connection setup (.json)' }));
  fireEvent.change(await screen.findByLabelText('Installed executable (Required)'), { target: { value: '/synthetic/engine' } });
  let resolve!: (value: api.EntrypointDraft) => void;
  vi.mocked(api.adapterSetupPrepare).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.submit(screen.getByRole('button', { name: 'Check installation and continue' }).closest('form')!);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await act(async () => resolve(draft));
  expect(view.onPrepared).not.toHaveBeenCalled();
  expect(api.adapterSetupCancel).toHaveBeenCalled();
  expect(screen.getByLabelText('Installed executable (Required)')).toHaveValue('/synthetic/engine');
  vi.mocked(api.adapterSetupPrepare).mockRejectedValueOnce(new Error('Selected installation is incomplete'));
  fireEvent.submit(screen.getByRole('button', { name: 'Check installation and continue' }).closest('form')!);
  expect(await screen.findByText(/Selected installation is incomplete/)).toBeVisible();
  expect(screen.getByLabelText('Installed executable (Required)')).toHaveValue('/synthetic/engine');
  vi.mocked(api.adapterSetupPrepare).mockResolvedValueOnce(draft);
  fireEvent.submit(screen.getByRole('button', { name: 'Check installation and continue' }).closest('form')!);
  await waitFor(() => expect(view.onPrepared).toHaveBeenCalledTimes(1));
});

it('imports an additional adapter without a closed engine list and ignores late picker results after leaving', async () => {
  const view = mount();
  vi.mocked(api.pickRuntimePath).mockResolvedValueOnce('/synthetic/new-adapter.json');
  fireEvent.click(screen.getByRole('button', { name: 'Import AioLM connection setup (.json)' }));
  await screen.findByLabelText('Installed executable (Required)');
  expect(api.adapterSetupImport).toHaveBeenCalledWith('/synthetic/new-adapter.json');
  vi.mocked(api.adapterSetupImport).mockResolvedValueOnce({
    ...recipe, id: 'another.vendor', title: 'Another independent adapter',
    fields: [{ key: 'folder', label: 'Installation folder', kind: 'folder', required: true, default: '/synthetic/package' }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import AioLM connection setup (.json)' }));
  expect(await screen.findByLabelText('Installation folder (Required)')).toHaveValue('/synthetic/package');
  expect(screen.queryByLabelText('Installed executable (Required)')).not.toBeInTheDocument();
  expect(screen.getByText('Another independent adapter')).toBeVisible();
  expect(api.adapterSetupPrepare).not.toHaveBeenCalled();
  let resolve!: (value: string) => void;
  vi.mocked(api.pickRuntimePath).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
  view.unmount();
  await act(async () => resolve('/synthetic/late-file'));
  expect(view.onPrepared).not.toHaveBeenCalled();
  expect(view.onBusyChange).toHaveBeenLastCalledWith(false);
});
