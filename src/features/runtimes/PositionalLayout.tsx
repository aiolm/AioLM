import { useId, useState } from 'react';
import { staticCandidates, type ConfirmedSyntax, type EffectiveSchema, type PositionalRole } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';

const encode = (role?: PositionalRole): string =>
  !role ? '' : role.role === 'user' ? 'user' : role.role === 'binding' ? `binding:${role.name}` : `static:${role.index}`;

const decode = (value: string): PositionalRole | undefined => {
  if (value === 'user') return { role: 'user' };
  if (value.startsWith('binding:')) return { role: 'binding', name: value.slice('binding:'.length) };
  if (value.startsWith('static:')) return { role: 'static', index: Number(value.slice('static:'.length)) };
  return undefined;
};

/** Who fills each positional slot of the reviewed help, edited and saved as
 * one layout: help shows names and order, never whether the launch template
 * already fills a slot. The backend refuses incomplete or gapped layouts. */
export default function PositionalLayout({ effective, disabled, onSave }: {
  effective: EffectiveSchema;
  disabled: boolean;
  /** Replace all confirmations for the accepted help. */
  onSave: (options: Record<string, ConfirmedSyntax>) => void;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const slots = effective.schema.options
    .filter(option => option.position !== null && option.position !== undefined && option.target === 'launch' && effective.help_keys.includes(option.key))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const saved = effective.supplement?.current ? effective.supplement.options : {};
  const initial = () => Object.fromEntries(slots.map(slot => [slot.key, encode(saved[slot.key]?.positional)]));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  // Which review the draft belongs to: the runtime, its accepted help, its
  // slots and the roles saved for them. Equal empty defaults of two reviews
  // must not let an unsaved choice carry over.
  const { engine, runtime } = effective.schema.binding;
  const signature = JSON.stringify({ engine, runtime, help: effective.accepted_fingerprint ?? null, roles: initial() });
  const [base, setBase] = useState(signature);
  // A new review, another runtime or a saved layout replaces unsaved choices.
  if (base !== signature) {
    setBase(signature);
    setDraft(initial());
  }
  if (slots.length === 0) return null;
  const entry = effective.entry;
  const conflicts = (effective.supplement?.conflicts ?? []).filter(conflict => conflict.field === 'positional');
  const confirmable = effective.help_state === 'current' && !!effective.accepted_fingerprint && !!entry;
  const choices = [
    { value: '', label: copy.positionalUnmapped },
    { value: 'user', label: copy.positionalUser },
    ...(entry?.positional_bindings ?? []).map(name => ({ value: `binding:${name}`, label: `${copy.positionalBinding}: ${name}` })),
    ...(entry ? staticCandidates(entry) : []).map(index => ({ value: `static:${index}`, label: `${copy.positionalStatic} ${index + 1}: ${entry?.prefix[index]}` })),
  ];
  const save = () => {
    const options: Record<string, ConfirmedSyntax> = {};
    // Other confirmed facts are kept; positional roles come from the draft.
    for (const [key, syntax] of Object.entries(saved)) {
      const rest: ConfirmedSyntax = { ...syntax };
      delete rest.positional;
      if (rest.arity || rest.repeatable !== undefined) options[key] = rest;
    }
    for (const slot of slots) {
      const role = decode(draft[slot.key] ?? '');
      if (role) options[slot.key] = { ...options[slot.key], positional: role };
    }
    onSave(options);
  };
  return (
    <section className="app-card app-card--tight mt-3" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.positionalTitle}</h4>
      <p className="app-section-hint">{entry ? copy.positionalHint : copy.positionalNoEntry}</p>
      {conflicts.length > 0 && (
        <FeedbackBanner tone="error">{copy.positionalConflict}: {String(conflicts[0].help)}</FeedbackBanner>
      )}
      {entry && (
        <>
          <ol>
            {slots.map(slot => (
              <li key={slot.key}>
                <CustomSelect ariaLabel={`${slot.key} ${copy.positionalTitle}`} value={draft[slot.key] ?? ''}
                  disabled={disabled || !confirmable} options={choices}
                  onChange={value => setDraft(current => ({ ...current, [slot.key]: value }))} />
                <span> {slot.key}{slot.help ? ` — ${slot.help}` : ''}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="app-button app-button--secondary" disabled={disabled || !confirmable} onClick={save}>{copy.positionalSave}</button>
        </>
      )}
    </section>
  );
}
