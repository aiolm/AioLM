import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModelPublisher, { modelPublishers } from './ModelPublisher';
import ModelBadges from './ModelBadges';
import { I18nProvider } from '../i18n/i18n';

it('keeps repository publisher, quantizer and author roles distinct', () => {
  expect(modelPublishers({ author: 'Original Team', quantized_by: 'Quantizer', organization: 'Research Lab' }, 'publisher/model')).toEqual([
    { role: 'publisher', name: 'publisher' }, { role: 'quantizer', name: 'Quantizer' },
    { role: 'author', name: 'Original Team' }, { role: 'organization', name: 'Research Lab' },
  ]);
});

it('prioritizes the actual download repository over the repository named in the header', () => {
  expect(modelPublishers({ download_repository: 'distributor/model', repo_url: 'https://huggingface.co/original/model' })[0])
    .toEqual({ role: 'publisher', name: 'distributor' });
  expect(modelPublishers({ repo_url: 'https://huggingface.co/community/model/' })[0]).toEqual({ role: 'publisher', name: 'community' });
});

it.each(['https://huggingface.co.evil.test/owner/model', 'file:///models/owner/model', 'https://huggingface.co/datasets/owner/data', 'https://user@huggingface.co/owner/model'])('does not invent a publisher from %s', repo_url => {
  expect(modelPublishers({ repo_url })).toEqual([]);
});

it('shows localized publisher attribution prominently even without any model badges', () => {
  const { container } = render(<I18nProvider initialLocale="ko"><ModelBadges model="publisher/unknown" repository="publisher/unknown" /></I18nProvider>);
  expect(screen.getByText('배포자')).toBeVisible();
  expect(container.querySelector('.model-publisher--primary strong')).toHaveTextContent('publisher');
});

it('does not relabel an author as a distributor when origin is unknown', () => {
  render(<I18nProvider initialLocale="ko"><ModelPublisher metadata={{ author: 'Original Team' }} /></I18nProvider>);
  expect(screen.getByText('제작자')).toBeVisible();
  expect(screen.queryByText('배포자')).not.toBeInTheDocument();
});

it('shows the imported repository owner ahead of the original model author', () => {
  const metadata = { directory_repository: 'community-publisher/example-GGUF', repo_url: 'https://huggingface.co/original/model', author: 'Original Team' };
  const { container } = render(<I18nProvider initialLocale="ko"><ModelBadges model="example.gguf" metadata={metadata} /></I18nProvider>);
  expect(container.querySelector('.model-publisher--primary')).toHaveTextContent('배포자community-publisher');
  expect(container.querySelector('.model-publisher--primary')).toHaveAttribute('title', '모델 보관 폴더에서 확인한 배포자');
  expect(screen.getByText('Original Team')).toBeVisible();
  expect(modelPublishers({ ...metadata, download_repository: 'recorded/model' })[0].name).toBe('recorded');
  expect(modelPublishers(metadata, 'selected/model')[0].name).toBe('selected');
});
