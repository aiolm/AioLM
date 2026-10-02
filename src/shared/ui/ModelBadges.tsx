import { useLayoutEffect, useRef, useState } from 'react';
import type { ModelMetadata } from '../api/types';
import { useI18n } from '../i18n/i18n';
import { useVisibleModelMetadata } from './useVisibleModelMetadata';
import ModelPublisher, { modelPublishers, modelPublisherLabels } from './ModelPublisher';
import Badge from './Badge';

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

const normalizeBadge = (value: string) => value.toLowerCase().replace(/[-_.\s]/g, '');

/** Summaries prioritize model capabilities; the complete metadata stays available in details. */
export function summaryModelBadges(badges: ModelBadge[], people: ReturnType<typeof modelPublishers> = []): ModelBadge[] {
  const core = badges.filter(badge => badge.kind !== 'tag').map(badge => normalizeBadge(badge.value));
  const names = new Set(people.map(person => normalizeBadge(person.name ?? '')));
  const priority = (badge: ModelBadge) => {
    if (badge.kind !== 'tag') return 0;
    if (/^(gguf|moe|reasoning|vision|embedding|text-generation|image-text-to-text|feature-extraction)$/i.test(badge.value)) return 1;
    return 2;
  };
  return badges.filter(badge => {
    if (badge.kind !== 'tag') return true;
    const key = normalizeBadge(badge.value);
    return !badge.value.includes(':') && !names.has(key)
      && !/^(model|transformers|pytorch|safetensors|endpoints_compatible)$/i.test(badge.value)
      && !core.some(value => value === key || (value.startsWith(key) && /^\d/.test(value.slice(key.length))));
  }).sort((a, b) => priority(a) - priority(b)).slice(0, 5);
}

/** Fit a prefix into two rows, reserving space for the omitted-information count. */
export function fittingModelBadgeCount(width: number, badgeWidths: number[], moreWidth: number, total: number, gap = 4): number {
  if (width <= 0) return badgeWidths.length;
  for (let count = badgeWidths.length; count >= 0; count--) {
    const widths = badgeWidths.slice(0, count);
    if (total > count) widths.push(moreWidth);
    let rows = 1;
    let used = 0;
    for (const item of widths) {
      const size = Math.min(item, width);
      if (used && used + gap + size > width) { rows++; used = size; }
      else used += (used ? gap : 0) + size;
    }
    if (rows <= 2) return count;
  }
  return 0;
}

function ModelBadgeItem({ badge }: { badge: ModelBadge }) {
  const { t } = useI18n();
  const label = t(badgeLabels[badge.kind]);
  const source = t(badge.source === 'metadata' ? 'ui.modelBadgeMetadata' : badge.source === 'hub' ? 'ui.modelBadgeHub' : 'ui.modelBadgeFilename');
  return <Badge className="model-badge" title={`${label}: ${badge.value} · ${source}`}>
    <span className="sr-only">{label}: </span><span className="model-badge-value">{badge.value}</span>
  </Badge>;
}

function CompactModelBadges({ badges, total }: { badges: ModelBadge[]; total: number }) {
  const { t, locale } = useI18n();
  const measure = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ signature: string; count: number }>();
  const signature = JSON.stringify(badges);
  const count = fit?.signature === signature ? Math.min(fit.count, badges.length) : badges.length;
  const hidden = total - count;
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const items = Array.from(node.children);
    const update = () => {
      const widths = items.map(item => item.getBoundingClientRect().width);
      const gap = Number.parseFloat(getComputedStyle(node).columnGap) || 0;
      const next = fittingModelBadgeCount(node.getBoundingClientRect().width, widths.slice(0, -1), widths.at(-1) ?? 0, total, gap);
      setFit(previous => previous?.signature === signature && previous.count === next ? previous : { signature, count: next });
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const item of items) observer.observe(item);
    return () => observer.disconnect();
  }, [signature, total, locale]);
  if (!total) return null;
  return <span className="model-badge-summary">
    <span className="model-badges">{badges.slice(0, count).map(badge => <ModelBadgeItem key={`${badge.kind}:${badge.value}`} badge={badge} />)}
      {hidden > 0 && <Badge className="model-badge model-badge-more" title={t('ui.modelBadgeMoreHint')}><span className="model-badge-value">{t('ui.modelBadgeMore', { count: hidden })}</span></Badge>}
    </span>
    <span ref={measure} className="model-badges model-badges--measure" aria-hidden="true">
      {badges.map(badge => <Badge className="model-badge" key={`${badge.kind}:${badge.value}`}><span className="model-badge-value" data-measure-value={badge.value} /></Badge>)}
      <Badge className="model-badge model-badge-more"><span className="model-badge-value" data-measure-value={t('ui.modelBadgeMore', { count: total })} /></Badge>
    </span>
  </span>;
}

export default function ModelBadges({ model, metadata, localPath, tags, repository, mode = 'compact' }: {
  model: string; metadata?: ModelMetadata; localPath?: string; tags?: string[]; repository?: string; mode?: 'compact' | 'detail';
}) {
  const { t } = useI18n();
  const visible = useVisibleModelMetadata(metadata ? undefined : localPath);
  const details = metadata ?? visible.metadata;
  const badges = modelBadges(model, details, tags);
  const people = modelPublishers(details, repository);
  if (!badges.length && !localPath && !people.length) return null;
  const summary = <><ModelPublisher metadata={details} repository={repository} compact />
    <CompactModelBadges badges={summaryModelBadges(badges, people)} total={badges.length + Math.max(0, people.length - 1)} /></>;
  if (mode === 'compact') return <span ref={visible.ref} className="model-information model-information--compact">{summary}</span>;
  return <div ref={node => { visible.ref.current = node; }} className="model-information model-information--detail">{summary}
    {(badges.length > 0 || people.length > 1) && <details className="model-metadata-details">
      <summary>{t('ui.modelBadgeAll', { count: badges.length + people.length })}</summary>
      <dl className="model-metadata-fields">
        {people.map(({ role, name }) => <div key={role}><dt>{t(modelPublisherLabels[role])}</dt><dd>{name}</dd></div>)}
        {badges.map(badge => {
          const colon = badge.kind === 'tag' ? badge.value.indexOf(':') : -1;
          return <div key={`${badge.kind}:${badge.value}`}><dt>{colon > 0 ? badge.value.slice(0, colon) : t(badgeLabels[badge.kind])}</dt>
            <dd>{colon > 0 ? badge.value.slice(colon + 1) : badge.value}</dd></div>;
        })}
      </dl>
    </details>}
  </div>;
}
