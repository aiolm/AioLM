import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { modelMetadata } from '../api/commands';
import { invalidateModelMetadata } from '../runtime/modelMetadata';
import type { ModelMetadata } from '../api/types';
import ModelBadges from './ModelBadges';
import { I18nProvider } from '../i18n/i18n';

vi.mock('../api/commands', () => ({ modelMetadata: vi.fn() }));
vi.mock('../api/transport', () => ({ isNativeRuntimeAvailable: () => true }));
afterEach(() => { vi.unstubAllGlobals(); invalidateModelMetadata(); vi.resetAllMocks(); });

it('reads only visible model rows and discards a previous path response', async () => {
  const observe: Array<() => void> = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      observe.push(() => callback([{ isIntersecting: true }]));
    }
    observe() {}
    disconnect() {}
  });
  let finishOld!: (metadata: ModelMetadata) => void;
  vi.mocked(modelMetadata).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce({ architecture: 'qwen4exp', tags: ['reasoning', 'custom-tag'] });
  const view = (path: string) => <I18nProvider initialLocale="en"><ModelBadges model={path} localPath={path} /></I18nProvider>;
  const { rerender } = render(view('models/old.gguf'));
  expect(modelMetadata).not.toHaveBeenCalled();
  act(() => observe[0]());
  await waitFor(() => expect(modelMetadata).toHaveBeenCalledTimes(1));
  rerender(view('models/next.gguf'));
  act(() => observe[1]());
  expect(await screen.findByText('qwen4exp')).toBeVisible();
  expect(screen.getByText('custom-tag')).toBeVisible();
  await act(async () => { finishOld({ architecture: 'llama' }); });
  expect(screen.queryByText('llama')).not.toBeInTheDocument();
});
