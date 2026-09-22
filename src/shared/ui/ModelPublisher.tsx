import type { ModelMetadata } from '../api/types';
import { useI18n } from '../i18n/i18n';

function repositoryOwner(repository?: string): string | undefined {
  if (!repository) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository) ? repository.split('/')[0] : undefined;
}

function repositoryFromUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.username || url.password || url.port) return undefined;
    return url.pathname.replace(/^\//, '').replace(/\/$/, '');
  } catch { return undefined; }
}

export function modelPublishers(metadata?: ModelMetadata, repository?: string) {
  const publisher = repositoryOwner(repository) ?? repositoryOwner(metadata?.download_repository)
    ?? repositoryOwner(metadata?.directory_repository)
    ?? repositoryOwner(repositoryFromUrl(metadata?.repo_url));
  const people = [
    { role: 'publisher' as const, name: publisher },
    { role: 'quantizer' as const, name: metadata?.quantized_by?.trim() },
    { role: 'author' as const, name: metadata?.author?.trim() },
    { role: 'organization' as const, name: metadata?.organization?.trim() },
  ];
  return people.filter(person => !!person.name);
}

const labels = {
  publisher: 'ui.modelPublisher', quantizer: 'ui.modelQuantizer',
  author: 'ui.modelAuthor', organization: 'ui.modelOrganization',
} as const;

export default function ModelPublisher({ metadata, repository }: { metadata?: ModelMetadata; repository?: string }) {
  const { t } = useI18n();
  const people = modelPublishers(metadata, repository);
  if (!people.length) return null;
  return <span className="model-publishers">{people.map(({ role, name }) => <span key={role}
    className={`model-publisher${role === 'publisher' ? ' model-publisher--primary' : ''}`}
    title={t(role === 'publisher' && repository ? 'ui.modelBadgeHub'
      : role === 'publisher' && metadata?.download_repository ? 'ui.modelPublisherDownload'
      : role === 'publisher' && metadata?.directory_repository ? 'ui.modelPublisherDirectory' : 'ui.modelBadgeMetadata')}>
    <span className="model-publisher-label">{t(labels[role])}</span><strong>{name}</strong>
  </span>)}</span>;
}
