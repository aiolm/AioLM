import type { ModelMetadata } from '../api/types';
import { useI18n } from '../i18n/i18n';
import { useVisibleModelMetadata } from './useVisibleModelMetadata';
import ModelPublisher, { modelPublishers } from './ModelPublisher';

export interface ModelBadge {
  kind: 'family' | 'architecture' | 'parameters' | 'quantization' | 'context' | 'projector' | 'tag';
  value: string;
  source: 'filename' | 'metadata' | 'hub';
}

const badgeLabels = {
  family: 'ui.modelBadgeFamily', architecture: 'ui.modelBadgeArchitecture',
  parameters: 'ui.modelBadgeParameters', quantization: 'ui.modelBadgeQuantization',
  context: 'ui.modelBadgeContext', projector: 'ui.modelBadgeProjector',
  tag: 'ui.modelBadgeTag',
} as const;

/** Names provide hints only; a GGUF architecture takes precedence over family hints. */
export function modelBadges(model: string, metadata?: ModelMetadata, tags: string[] = []): ModelBadge[] {
  const name = model.replace(/\\/g, '/').split('/').at(-1) ?? '';
  if (!name.trim()) return [];
  const badges: ModelBadge[] = [];
  const family = name.match(/(?:^|[^a-z])(qwen\d*(?:[.]\d+)?|(?:embedding)?gemma(?:[-_.]?\d+)?|deepseek(?:[-_.]r\d+)?|llama(?:[-_.]?\d+(?:[.]\d+)?)?|mistral|mixtral|ministral|magistral|devstral|codestral|(?:chat)?glm(?:[-_.]?\d+(?:[.]\d+)?)?)(?=[^a-z0-9]|$)/i)?.[1];
  if (metadata?.architecture?.trim()) badges.push({ kind: 'architecture', value: metadata.architecture.trim(), source: 'metadata' });
  else if (family) badges.push({ kind: 'family', value: family, source: 'filename' });
  const parameters = name.match(/(?:^|[-_.])(\d+(?:[.]\d+)?(?:x\d+(?:[.]\d+)?)?[bm])(?=[-_.]|$)/i)?.[1];
  if (metadata?.size_label?.trim()) badges.push({ kind: 'parameters', value: metadata.size_label.trim(), source: 'metadata' });
  else if (parameters) badges.push({ kind: 'parameters', value: parameters.toUpperCase(), source: 'filename' });
  const quantization = name.match(/(?:^|[-_.])(IQ[1-4]_(?:XXS|XS|NL|S|M)|Q[1-8]_(?:K(?:_[SML])?|[01])|TQ[12]_0|BF16|F16|F32|MXFP4(?:_MOE)?|NVFP4)(?=[-_.]|$)/i)?.[1];
  if (metadata?.quantization?.trim()) badges.push({ kind: 'quantization', value: metadata.quantization.trim(), source: 'metadata' });
  else if (quantization) badges.push({ kind: 'quantization', value: quantization.toUpperCase(), source: 'filename' });
  if (metadata?.context_length && Number.isFinite(metadata.context_length) && metadata.context_length > 0) {
    const length = metadata.context_length;
    badges.push({ kind: 'context', value: length % 1024 === 0 ? `${length / 1024}K` : `${length}`, source: 'metadata' });
  }
  if (/(?:^|[-_.])mmproj(?=[-_.]|$)/i.test(name)) badges.push({ kind: 'projector', value: 'mmproj', source: 'filename' });
  const declared = [metadata?.model_type, metadata?.finetune, metadata?.license ? `license:${metadata.license}` : undefined,
    ...(metadata?.languages ?? []), ...(metadata?.tags ?? [])];
  if (metadata?.expert_count && metadata.expert_count > 1) {
    declared.push('MoE', `experts:${metadata.expert_count}`);
    if (metadata.expert_used_count) declared.push(`active-experts:${metadata.expert_used_count}`);
  }
  for (const tag of declared) if (tag?.trim()) badges.push({ kind: 'tag', value: tag.trim(), source: 'metadata' });
  for (const tag of tags) if (tag.trim()) badges.push({ kind: 'tag', value: tag.trim(), source: 'hub' });
  const seen = new Set<string>();
  return badges.filter(badge => {
    const key = badge.value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export default function ModelBadges({ model, metadata, localPath, tags, repository }: { model: string; metadata?: ModelMetadata; localPath?: string; tags?: string[]; repository?: string }) {
  const { t } = useI18n();
  const visible = useVisibleModelMetadata(metadata ? undefined : localPath);
  const details = metadata ?? visible.metadata;
  const badges = modelBadges(model, details, tags);
  if (!badges.length && !localPath && !modelPublishers(details, repository).length) return null;
  return <span ref={visible.ref} className="model-information">
    <ModelPublisher metadata={details} repository={repository} />
    {badges.length > 0 && <span className="model-badges">{badges.map(badge => {
    const label = t(badgeLabels[badge.kind]);
    const source = t(badge.source === 'metadata' ? 'ui.modelBadgeMetadata' : badge.source === 'hub' ? 'ui.modelBadgeHub' : 'ui.modelBadgeFilename');
    return <span key={`${badge.kind}:${badge.value}`} className="model-badge" title={`${label}: ${badge.value} · ${source}`}>
      <span className="sr-only">{label}: </span>{badge.value}
    </span>;
  })}</span>}</span>;
}
