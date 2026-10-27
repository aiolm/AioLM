import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createTestStore } from '../../testing/appStore';
import type { ModelSettingsDialogProps } from './ModelSettingsDialog';

vi.mock('../../shared/api/index', () => ({ isNativeRuntimeAvailable: () => false }));
vi.mock('../../shared/i18n/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('./ModelSettingsDialog', () => ({ default: ({ open, initialConfig, onClose }: ModelSettingsDialogProps) => open
  ? <div role="dialog" aria-label="Model settings"><output>{initialConfig.active_model}</output><button onClick={onClose}>Close editor</button></div>
  : null }));

it('keeps a mounted provider connected to consumers when its implementation module is reevaluated', async () => {
  // Distinct query imports reevaluate the provider while its ordinary dependency modules stay cached.
  const previousUrl = './ModelSettingsProvider.tsx?context-refresh-previous';
  const refreshedUrl = './ModelSettingsProvider.tsx?context-refresh-current';
  const previous = await import(/* @vite-ignore */ previousUrl) as typeof import('./ModelSettingsProvider');
  const refreshed = await import(/* @vite-ignore */ refreshedUrl) as typeof import('./ModelSettingsProvider');
  const model = '/synthetic/models/loaded.gguf';
  const store = createTestStore({ active_model: '/synthetic/models/next.gguf' });
  store.status = { state: 'running', model: 'served-alias', execution: { active_model: model } };
  function RefreshedConsumer() {
    const settings = refreshed.useModelSettings();
    return <button disabled={!settings} onClick={() => settings?.open({ target: { kind: 'default' } })}>Open model settings</button>;
  }
  render(<previous.ModelSettingsProvider store={store}><RefreshedConsumer /></previous.ModelSettingsProvider>);
  expect(screen.getByRole('button', { name: 'Open model settings' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open model settings' }));
  expect(await screen.findByRole('dialog', { name: 'Model settings' })).toHaveTextContent(model);
  fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(store.status).toMatchObject({ state: 'running', model: 'served-alias', execution: { active_model: model } });
  expect(store.updateConfig).not.toHaveBeenCalled();
  expect(store.start).not.toHaveBeenCalled();
  expect(store.stop).not.toHaveBeenCalled();
});
