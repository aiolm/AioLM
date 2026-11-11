import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, translate } from '../../shared/i18n/i18n';
import PullRequestProvenance from './RuntimePullRequestProvenance';
import type { PullRequestPreview } from '../../shared/api/types';

describe('runtime status explanations', () => {
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
