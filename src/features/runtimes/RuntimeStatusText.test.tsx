import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, translate } from '../../shared/i18n/i18n';
import RuntimeCapabilitiesCard from './RuntimeCapabilitiesCard';
import PullRequestProvenance from './RuntimePullRequestProvenance';
import type { PullRequestPreview, RuntimeCapabilities } from '../../shared/api/types';

describe('runtime status explanations', () => {
  it('translates a failed executable check without removing its diagnostic or enabling a locked probe', () => {
    const onProbe = vi.fn();
    const capabilities: RuntimeCapabilities = { backend: 'cpu', build: 'synthetic-build', executable: 'synthetic-server',
      state: 'failed preflight', version: '', flags: [], devices: [], diagnostics: ['Synthetic binary fingerprint changed'] };
    const { container } = render(<I18nProvider initialLocale="ko"><RuntimeCapabilitiesCard locale="ko" t={(key, vars) => translate('ko', key, vars)}
      capabilities={capabilities} probeBusy={false} serverRunning probeTarget={{ backend: 'cpu', build: 'synthetic-build' }} onProbe={onProbe} /></I18nProvider>);
    expect(screen.getByText('실행 파일 점검 실패')).toBeVisible();
    expect(screen.getByRole('button', { name: '다시 점검' })).toBeDisabled();
    expect(onProbe).not.toHaveBeenCalled();
    const diagnostic = container.querySelector('details')!;
    expect(diagnostic).not.toHaveAttribute('open');
    fireEvent.click(diagnostic.querySelector('summary')!);
    expect(screen.getByText('Synthetic binary fingerprint changed')).toBeVisible();
    expect(capabilities.state).toBe('failed preflight');
  });

  it('translates PR state and retains draft and provenance warnings', () => {
    const preview: PullRequestPreview = { pull_request: 42, title: 'Synthetic change', state: 'open', draft: true,
      author: 'synthetic-author', repository: 'synthetic/repo', head_ref: 'feature', commit: 'synthetic-commit', fork: true,
      url: 'https://example.invalid/pull/42', archive_url: 'https://example.invalid/archive', updated_at: '', advisories: ['draft', 'fork'] };
    render(<I18nProvider initialLocale="ko"><PullRequestProvenance locale="ko" t={(key, vars) => translate('ko', key, vars)} preview={preview} backend="cpu" /></I18nProvider>);
    expect(screen.getByText('열려 있음 · 초안')).toBeVisible();
    expect(screen.getByText('synthetic-commit')).toBeVisible();
    expect(screen.getAllByText(/synthetic\/repo/).length).toBeGreaterThan(0);
    expect(screen.getByText(/아직 초안/)).toBeVisible();
    expect(preview.state).toBe('open');
  });
});
