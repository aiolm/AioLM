import { useId, useState } from 'react';
import type { OptionSchema, PlannedOccurrence } from '../../shared/api/runtimeHelp';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { expandPlan, moveOccurrence, ORDER_KEY, readOrder } from './optionOrder';
import { supported } from './optionPresentation';

/** The saved command-line order of every orderable occurrence, reorderable
 * with buttons. Moving creates or updates the saved order record. */
export function OccurrenceOrder({ schema, values, disabled = false, onChange }: {
  schema: OptionSchema; values: Record<string, unknown>; disabled?: boolean; onChange: (next: Record<string, unknown>) => void;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const state = readOrder(values);
  const [status, setStatus] = useState('');
  if (!state.ok) {
    return (
      <FeedbackBanner tone="error">
        {copy.orderInvalid} ({state.error})
        <button type="button" className="app-button app-button--secondary" disabled={disabled}
          onClick={() => { const next = { ...values }; delete next[ORDER_KEY]; onChange(next); }}>{copy.discardOrder}</button>
      </FeedbackBanner>
    );
  }
  const plan = expandPlan(schema, values, state.order);
  if (plan.length < 2) return null;
  const options = new Map(schema.options.map(option => [option.key, option]));
  const label = (item: PlannedOccurrence) => {
    const flag = item.spelling ?? options.get(item.key)?.spellings[0]?.flag ?? item.key;
    const shown = supported(options.get(item.key)?.sensitive) === true ? item.values.map(() => '•••') : item.values.map(value => JSON.stringify(value));
    return [flag, ...shown].join(' ');
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    const item = plan[index];
    if (disabled || target < 0 || target >= plan.length || !item) return;
    onChange(moveOccurrence(schema, values, index, offset));
    setStatus(`${label(item)} → ${target + 1}`);
  };
  return (
    <section aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.orderTitle}</h4>
      <p className="app-section-hint">{copy.orderHint}</p>
      <ol>
        {plan.map((item, index) => (
          <li key={`${item.key}:${index}`}>
            <code>{label(item)}</code>{' '}
            {/* aria-disabled keeps focus on an edge button after a move. */}
            <button type="button" className="app-button app-button--secondary" aria-disabled={disabled || index === 0}
              aria-label={`${copy.moveUp}: ${label(item)}`} onClick={() => move(index, -1)}>{copy.moveUp}</button>
            <button type="button" className="app-button app-button--secondary" aria-disabled={disabled || index === plan.length - 1}
              aria-label={`${copy.moveDown}: ${label(item)}`} onClick={() => move(index, 1)}>{copy.moveDown}</button>
          </li>
        ))}
      </ol>
      <p role="status" className="app-section-hint">{status}</p>
    </section>
  );
}
