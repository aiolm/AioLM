import { useId } from 'react';
import type { FactConflict, MetadataView, OptionSchema } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';

type Copy = (typeof runtimeOptionsCopy)['en'];

function shown(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fieldLabel(field: string, copy: Copy): string {
  const label = (copy as Record<string, string>)[`field_${field}`];
  return label ?? field;
}

/** Facts that describe syntax or handling, never a value an option holds. */
const VALUE_FREE = new Set(['arity', 'kind', 'key', 'target', 'repeatable', 'unit', 'restart_required', 'sensitive', 'local_path']);

/** A difference about an option declared or documented secret. */
function secret(conflict: FactConflict, schema?: OptionSchema): boolean {
  const option = schema?.options.find(item => item.key === conflict.key);
  const sensitive = option?.sensitive;
  const declared = conflict.declared as { sensitive?: unknown } | null;
  return (sensitive?.certainty !== 'unknown' && sensitive?.value === true)
    || (typeof declared === 'object' && declared !== null && declared.sensitive === true);
}

/** Declared option facts that differ from the reviewed help, with the
 * declaration's provenance, which side the schema uses and whether a saved
 * value is refused. Shown at help review, registration and in settings.
 * Value literals of secret options (defaults, choices) are never shown. */
export default function RuntimeFactDifferences({ conflicts = [], metadata, schema }: {
  conflicts?: FactConflict[];
  metadata?: MetadataView | null;
  /** The schema the differences describe, for recognising secret options. */
  schema?: OptionSchema;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const all = [...conflicts, ...(metadata?.conflicts ?? [])];
  const describe = metadata && (!metadata.builtin || metadata.error);
  if (!describe && all.length === 0) return null;
  const value = (conflict: FactConflict, literal: unknown) =>
    (secret(conflict, schema) && !VALUE_FREE.has(conflict.field) && literal !== null && literal !== undefined ? '•••' : shown(literal));
  return (
    <section className="mt-3" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.differencesTitle}</h4>
      {describe && (
        <p>
          {copy.metadataFrom}: {copy.sourceAdapter} {metadata.adapter} ({metadata.revision})
          {metadata.builtin ? ` · ${copy.builtinMetadata}` : ''} · {metadata.applied.length} {copy.metadataApplied}
        </p>
      )}
      {metadata?.error && <FeedbackBanner tone="warning">{metadata.error}</FeedbackBanner>}
      {all.length > 0 && <p className="app-section-hint">{copy.differencesHint}</p>}
      {all.length > 0 && (
        <ul>
          {all.map((conflict, index) => (
            <li key={`${conflict.flag}:${conflict.field}:${index}`}>
              <code>{conflict.flag || conflict.key}</code>
              {` · ${fieldLabel(conflict.field, copy)} · ${copy.sourceHelp}: ${value(conflict, conflict.observed)} · ${conflict.declared_by}: ${value(conflict, conflict.declared)} · `}
              {conflict.applies === 'observed' ? copy.appliesObserved : copy.appliesDeclared}
              {conflict.blocking && ` · ${copy.blocksLaunch}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
