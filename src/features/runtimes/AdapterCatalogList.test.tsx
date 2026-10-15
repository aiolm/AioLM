import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import AdapterCatalogList from './AdapterCatalogList';

it('lists built-in and registered adapters together and searches engines unknown to the app', () => {
  render(<I18nProvider initialLocale="en"><AdapterCatalogList catalog={[
    { id: 'llama.cpp', engine: 'llama.cpp', server: 'llama-server', availability: { supported: true, detail: '' }, options: [] },
    { id: 'custom.synthetic', engine: 'Synthetic', server: 'openai-v1', kind: 'external-process', availability: { supported: true, detail: '' }, options: [] },
  ]} runtimes={[
    { provider: 'llama.cpp', id: 'b1-cpu', engine: 'llama.cpp', server: 'llama-server', accelerator: 'cpu', installation: 'managed', location: '/synthetic/runtime', available: true, problems: [] },
  ]} /></I18nProvider>);
  expect(screen.getByText(/Built-in/)).toBeInTheDocument();
  expect(screen.getByText(/Custom/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search adapters' }), { target: { value: 'synthetic' } });
  expect(screen.queryByText(/llama\.cpp · llama-server/)).not.toBeInTheDocument();
  expect(screen.getByText(/Synthetic/)).toBeInTheDocument();
});
