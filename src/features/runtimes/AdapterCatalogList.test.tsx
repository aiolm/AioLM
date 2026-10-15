import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import type { ProviderDescription, RuntimeInstance } from '../../shared/api/providers';
import AdapterCatalogList from './AdapterCatalogList';

const catalog: ProviderDescription[] = [
  { id: 'vllm', engine: 'vLLM', server: 'vllm serve', availability: { supported: true, detail: '' }, options: [] },
  { id: 'llama.cpp', engine: 'llama.cpp', server: 'llama-server', availability: { supported: true, detail: '' }, options: [] },
  { id: 'custom.synthetic', engine: 'Synthetic', server: 'openai-v1', kind: 'external-process', availability: { supported: true, detail: '' }, options: [] },
  { id: 'mlx-vlm', engine: 'MLX', server: 'mlx_vlm.server', availability: { supported: false, detail: 'Apple Silicon only' }, options: [] },
];
const runtimes: RuntimeInstance[] = [
  { provider: 'llama.cpp', id: 'b1-cpu', engine: 'llama.cpp', server: 'llama-server', accelerator: 'cpu', installation: 'managed', location: '/synthetic/runtime', available: true, problems: [] },
  { provider: 'custom.synthetic', id: 'build-1', engine: 'Synthetic', server: 'openai-v1', accelerator: 'external', installation: 'registered', location: '/synthetic/engine', available: false, problems: ['probe program missing'] },
];

function renderList(onOpen = vi.fn()) {
  render(<I18nProvider initialLocale="en"><AdapterCatalogList catalog={catalog} runtimes={runtimes} onOpen={onOpen} /></I18nProvider>);
  return onOpen;
}

it('lists built-in and registered adapters in one name-ordered inventory with install, registration and support states', () => {
  renderList();
  const rows = within(screen.getByRole('region', { name: 'Inference engines' })).getAllByRole('listitem').filter(item => item.classList.contains('adapter-row'));
  expect(rows.map(row => within(row).getAllByRole('button')[0])).toEqual([
    screen.getByRole('button', { name: 'llama.cpp' }), screen.getByRole('button', { name: 'MLX' }),
    screen.getByRole('button', { name: 'Synthetic' }), screen.getByRole('button', { name: 'vLLM' }),
  ]);
  expect(screen.getByRole('button', { name: 'llama.cpp' })).toHaveAccessibleDescription(/llama-server Built-in 1 runtime\(s\) installed/);
  expect(screen.getByRole('button', { name: 'Synthetic' })).toHaveAccessibleDescription(/Custom 1 runtime\(s\) registered Runtime needs attention/);
  expect(screen.getByRole('button', { name: 'MLX' })).toHaveAccessibleDescription(/Unavailable on this device/);
  expect(screen.getByRole('button', { name: 'vLLM' })).toHaveAccessibleDescription(/No runtime installed/);
  // Registration says nothing about whether a model is Ready.
  expect(screen.queryByText(/^Ready$/)).not.toBeInTheDocument();
  expect(screen.getByText(/does not make a model Ready/)).toBeVisible();
});

it('filters an engine unknown to the app, expands its details with the keyboard and opens it explicitly', () => {
  const onOpen = renderList();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search adapters' }), { target: { value: 'synth' } });
  expect(screen.queryByRole('button', { name: 'llama.cpp' })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('1 of 4 engines');
  const details = screen.getByRole('button', { name: 'Details Synthetic' });
  expect(details).toHaveAttribute('aria-expanded', 'false');
  details.focus();
  fireEvent.click(details);
  expect(details).toHaveAttribute('aria-expanded', 'true');
  expect(document.getElementById(details.getAttribute('aria-controls')!)).toHaveTextContent('build-1 · external · registered · Runtime needs attention · probe program missing');
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic' }));
  expect(onOpen).toHaveBeenCalledWith('custom.synthetic');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search adapters' }), { target: { value: 'no such engine' } });
  expect(screen.getByText('No adapters match this search.')).toBeVisible();
});
