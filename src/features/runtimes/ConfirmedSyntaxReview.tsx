import type { ConfirmedSyntax, EffectiveSchema } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';

function describe(syntax: ConfirmedSyntax): string {
  const parts: string[] = [];
  if (syntax.arity) parts.push(`${syntax.arity.min}..${syntax.arity.max ?? '∞'}`);
  if (syntax.repeatable !== undefined) parts.push(syntax.repeatable ? '×N' : '×1');
  const role = syntax.positional;
  if (role) parts.push(role.role === 'user' ? '@user' : role.role === 'binding' ? `@{${role.name}}` : `@entry[${role.index + 1}]`);
  return parts.join(' ');
}

/** Confirmations the user made, shown apart from help and adapter facts:
 * whether they apply to the accepted help, what the current help says
 * instead, and explicit actions to remove or re-confirm them. */
export default function ConfirmedSyntaxReview({ effective, disabled, onSave, onDiscard }: {
  effective: EffectiveSchema;
  disabled: boolean;
  /** Replace the confirmations for the accepted help. */
  onSave: (options: Record<string, ConfirmedSyntax>) => void;
  onDiscard: () => void;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const view = effective.supplement;
  if (effective.supplement_error) {
    return (
      <FeedbackBanner tone="error">
        {copy.supplementError}: {effective.supplement_error}
        <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={onDiscard}>{copy.discardConfirmations}</button>
      </FeedbackBanner>
    );
  }
  if (!view || Object.keys(view.options).length === 0) return null;
  const canPin = effective.help_state === 'current' && !!effective.accepted_fingerprint;
  // Re-confirming carries only facts the current help still leaves unknown;
  // what it now documents or contradicts stays the help's.
  const eligible: Record<string, ConfirmedSyntax> = {};
  for (const [key, syntax] of Object.entries(view.options)) {
    const option = effective.help_keys.includes(key) ? effective.schema.options.find(item => item.key === key) : undefined;
    if (!option || option.managed || option.target !== 'launch') continue;
    const kept: ConfirmedSyntax = {
      ...(syntax.arity && option.arity.certainty === 'unknown' ? { arity: syntax.arity } : {}),
      ...(syntax.repeatable !== undefined && option.repeatable.certainty === 'unknown' ? { repeatable: syntax.repeatable } : {}),
    };
    if (kept.arity || kept.repeatable !== undefined) eligible[key] = kept;
  }
  return (
    <section className="app-card app-card--tight mt-3" aria-label={copy.supplementTitle}>
      <h4>{copy.supplementTitle}</h4>
      <p role="status">{view.current ? copy.supplementCurrent : copy.supplementStale} ({view.fingerprint.slice(0, 12)})</p>
      <ul>
        {Object.entries(view.options).map(([key, syntax]) => {
          const conflicts = view.conflicts.filter(conflict => conflict.key === key);
          return (
            <li key={key}>
              <code>{key}</code> {describe(syntax)}
              {conflicts.map(conflict => (
                <span key={conflict.field}> · {conflict.field === 'option' ? copy.supplementHelpAbsent
                  : `${copy.supplementConflict} (${conflict.field}: ${JSON.stringify(conflict.help)})`}</span>
              ))}
              {view.current && (
                <button type="button" className="app-button app-button--secondary" disabled={disabled}
                  aria-label={`${copy.removeConfirmation}: ${key}`}
                  onClick={() => onSave(Object.fromEntries(Object.entries(view.options).filter(([other]) => other !== key)))}>{copy.removeConfirmation}</button>
              )}
            </li>
          );
        })}
      </ul>
      {!view.current && canPin && Object.keys(eligible).length > 0 && (
        <button type="button" className="app-button app-button--secondary" disabled={disabled}
          onClick={() => onSave(eligible)}>{copy.confirmAgain} ({Object.keys(eligible).join(', ')})</button>
      )}
      <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={onDiscard}>{copy.discardConfirmations}</button>
    </section>
  );
}
