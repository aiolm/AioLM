import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import { ProviderOptions } from '../model-settings/ProviderControls';
import { ProfileRuntimeSchemaContext } from '../model-settings/useProfileRuntimeSchema';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  providerCatalog: vi.fn(), providerOptionIssues: vi.fn(), providerRuntimeOptions: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.providerCatalog).mockResolvedValue([]);
  vi.mocked(api.providerRuntimeOptions).mockResolvedValue([]);
  vi.mocked(api.providerOptionIssues).mockResolvedValue([]);
});

const option = (key: string, group: string) => schemaOption({ key, flag: `--${key}`, group, target: 'launch', kind: { type: 'text' } });

// The option host supports updating the same effective schema object in
// place; the category chooser must follow it just as the field list does.
it('offers and filters by a category added to the same schema object in place', async () => {
  const provider = 'custom.synthetic';
  const effective = effectiveSchema([], [option('alpha', 'memory')]);
  const shared = { provider: provider as api.ProviderId, runtime: 'build', view: effective, pending: false, retry: vi.fn() };
  const cfg: api.AppConfig = { ...testConfig, active_provider: provider, active_runtime: 'build', provider_options: { [provider]: { alpha: 'saved' } } };
  const view = () => <I18nProvider initialLocale="en"><ProfileRuntimeSchemaContext.Provider value={shared}>
    <ProviderOptions collapseTools hideDefaultsReset cfg={cfg} disabled={false} onChange={vi.fn()} onInvalid={vi.fn()} />
  </ProfileRuntimeSchemaContext.Provider></I18nProvider>;
  const rendered = render(view());
  expect(await screen.findByRole('textbox', { name: /^--alpha/ })).toHaveValue('saved');

  effective.schema.options.push(option('zeta', 'sampling'));
  rendered.rerender(view());
  await waitFor(() => expect(screen.getByRole('textbox', { name: /^--zeta/ })).toBeInTheDocument());

  fireEvent.click(screen.getByRole('combobox', { name: 'Group' }));
  fireEvent.click(screen.getByRole('option', { name: 'sampling' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: /^--alpha/ })).not.toBeInTheDocument());
  expect(screen.getByRole('textbox', { name: /^--zeta/ })).toBeInTheDocument();
});
