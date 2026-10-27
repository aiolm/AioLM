import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import DeepVerificationControls from './DeepVerificationControls';

describe('runtime verification coverage', () => {
  it('reports a vLLM KL lower bound as partial coverage without labeling it a full verification pass or failure', () => {
    render(<I18nProvider initialLocale="en"><DeepVerificationControls t={key => key} provider="vllm" serverRunning={false} state={{
      busy: false, error: null, start: vi.fn(), cancel: vi.fn(), record: { verdict: 'unsupported', detail: 'Only the observed partition was compared.',
        method: 'vllm-topk-partition-kld', coverage: 'partial', median_kld_lower_bound: 0.002, top_k: 20 },
    }} /></I18nProvider>);
    expect(screen.getByText('Partial verification')).toBeInTheDocument();
    expect(screen.getByText(/KL ≥ 0.002/)).toBeInTheDocument();
    expect(screen.queryByText('ui.deepVerifyPass')).not.toBeInTheDocument();
    expect(screen.queryByText('ui.deepVerifyFail')).not.toBeInTheDocument();
  });
  it('explains unavailable external reference verification before a request is sent', () => {
    const start = vi.fn();
    render(<I18nProvider initialLocale="en"><DeepVerificationControls t={key => key} provider="custom.example" serverRunning={false} state={{ busy: false, error: null, record: null, start, cancel: vi.fn() }} /></I18nProvider>);
    expect(screen.getByRole('button', { name: 'ui.deepVerify' })).toBeDisabled();
    expect(screen.getByText("This runtime adapter does not support comparison with CPU reference results.")).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });
});
