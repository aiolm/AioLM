import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { ORDER_KEY, readOrder } from './optionOrder';

/** Recovery for a saved command-line order this app cannot read, which blocks
 * launch. A readable order needs no controls here: it follows the pasted
 * command's order, and the launch preview shows the result. */
export function OccurrenceOrder({ values, disabled = false, onChange }: {
  values: Record<string, unknown>; disabled?: boolean; onChange: (next: Record<string, unknown>) => void;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const state = readOrder(values);
  if (state.ok) return null;
  return (
    <FeedbackBanner tone="error">
      {copy.orderInvalid} ({state.error})
      <button type="button" className="app-button app-button--secondary" disabled={disabled}
        onClick={() => { const next = { ...values }; delete next[ORDER_KEY]; onChange(next); }}>{copy.discardOrder}</button>
    </FeedbackBanner>
  );
}
