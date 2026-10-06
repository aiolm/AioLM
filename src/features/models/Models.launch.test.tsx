import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { defaultPreferences, savePreferences } from '../../shared/config/preferences';
import { createTestStore } from '../../testing/appStore';
import ModelsPanel from './Models';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null, MANAGE_MODEL_RUNTIMES: 'synthetic-manage-runtimes' }));
vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  isNativeRuntimeAvailable: () => false,
  listModels: vi.fn(async () => ({ models: [{ name: 'next.gguf', path: 'models/next.gguf', size_mb: 1, is_vision: false }], truncated: false })),
}));

describe('model library replacement launches', () => {
  beforeEach(() => {
    localStorage.clear();
    const preferences = defaultPreferences();
    preferences.advanced.confirmDestructiveActions = false;
    savePreferences(preferences);
  });

  it.each(['save', 'preflight'] as const)('preserves the running process when replacement %s fails', async failure => {
    const store = createTestStore({ active_model: 'models/current.gguf', models_dir: 'models' });
    store.status = { state: 'running', model: 'models/current.gguf' };
    if (failure === 'save') vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error('Synthetic save failure'));
    else vi.mocked(store.start).mockRejectedValueOnce(new Error('Synthetic preflight failure'));
    render(<I18nProvider initialLocale="en"><ModelsPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart (switch model): next.gguf' }));
    await waitFor(() => expect(screen.getByText(new RegExp(`Synthetic ${failure} failure`))).toBeVisible());
    expect(store.stop).not.toHaveBeenCalled();
    if (failure === 'save') expect(store.start).not.toHaveBeenCalled();
    else expect(store.start).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'models/next.gguf' }), true);
    expect(store.status).toMatchObject({ state: 'running', model: 'models/current.gguf' });
  });
});
