import { CustomSelect } from "../../shared/ui/CustomSelect";
import Badge from "../../shared/ui/Badge";
import { useState, type ReactNode } from "react";
import { useI18n } from "../../shared/i18n/i18n";
import { useTuningId } from './TuningIdScope';
import { tuningHelp } from '../../shared/i18n/tuningHelp';
import { TuningOptionLabel } from './TuningOptionMetadata';
import './tuning-sampler-chain.css';

export const SAMPLER_CHAIN_OPTIONS = [
  "dry",
  "top_k",
  "top_p",
  "min_p",
  "typ_p",
  "temperature",
  "dynatemp",
  "xtc",
  "penalties",
  "mirostat",
] as const;

export function normalizeSamplerChain(value: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    const sampler = item.trim();
    if (!sampler || seen.has(sampler)) continue;
    seen.add(sampler);
    normalized.push(sampler);
  }
  return normalized.slice(0, 64);
}

export interface TuningSamplerChainProps {
  /** `value` is the controlled spelling; `samplers` is kept for direct use. */
  value?: readonly string[];
  samplers?: readonly string[];
  options?: readonly string[];
  disabled?: boolean;
  onChange?: (samplers: string[]) => void;
  onReorder?: (samplers: string[]) => void;
  onSamplersChange?: (samplers: string[]) => void;
  /** Field-scoped action, such as reset, kept in the chain's title row. */
  headerAction?: ReactNode;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const EMPTY_SAMPLER_CHAIN: readonly string[] = [];

/**
 * Ordered sampler-chain editor. Native drag events keep this dependency-free
 * for the desktop shell, while the adjacent move buttons make the same action
 * available to keyboard and touch users.
 */
export default function TuningSamplerChain({
  value,
  samplers,
  options = SAMPLER_CHAIN_OPTIONS,
  disabled = false,
  onChange,
  onReorder,
  onSamplersChange,
  headerAction,
}: TuningSamplerChainProps) {
  const { t, locale } = useI18n();
  const help = tuningHelp[locale];
  const id = useTuningId();
  const source = value ?? samplers ?? EMPTY_SAMPLER_CHAIN;
  const normalizedSource = normalizeSamplerChain(source);
  const [localDraft, setLocalDraft] = useState<{ source: readonly string[]; value: string[] } | null>(null);
  const [drag, setDrag] = useState<{ source: readonly string[]; index: number } | null>(null);
  const [selectedToAdd, setSelectedToAdd] = useState("");
  const draftIsCurrent = localDraft !== null && localDraft.source === source;
  const dragIsCurrent = drag !== null && sameValues(drag.source, normalizedSource);
  // Controlled replacements supersede optimistic edits and invalidate a held chip
  // before a drop can use the old ordering.
  if (localDraft && !draftIsCurrent) setLocalDraft(null);
  if (drag && !dragIsCurrent) setDrag(null);
  const draft = draftIsCurrent ? localDraft.value : normalizedSource;
  const draggedIndex = dragIsCurrent ? drag.index : null;

  const publish = (next: readonly string[]) => {
    const normalized = normalizeSamplerChain(next);
    setLocalDraft({ source, value: normalized });
    onChange?.(normalized);
    onReorder?.(normalized);
    onSamplersChange?.(normalized);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (disabled || target < 0 || target >= draft.length) return;
    const current = draft[index];
    const destination = draft[target];
    if (current === undefined || destination === undefined) return;
    const next = [...draft];
    next[index] = destination;
    next[target] = current;
    publish(next);
  };

  const drop = (targetIndex: number) => {
    if (disabled || draggedIndex === null || draggedIndex === targetIndex) return;
    if (draggedIndex < 0 || draggedIndex >= draft.length || targetIndex < 0 || targetIndex >= draft.length) {
      setDrag(null);
      return;
    }
    const next = [...draft];
    const [item] = next.splice(draggedIndex, 1);
    if (item === undefined) {
      setDrag(null);
      return;
    }
    next.splice(targetIndex, 0, item);
    publish(next);
    setDrag(null);
  };

  const availableOptions = options.filter((option) => !draft.includes(option));

  return (
    <div className="tuning-sampler-chain app-card app-card--tight" data-testid="tuning-sampler-chain">
      <div className="tuning-sampler-chain__header flex-wrap">
        <div className="tuning-field-title">
          <h3 className="tuning-sampler-chain__title"><TuningOptionLabel fieldKey="samplers" label={t("extra.samplerChainTitle")} /></h3>
          {headerAction}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge className="shrink-0">{t("extra.samplerChainCount", { count: draft.length })}</Badge>
        </div>
      </div>

      {draft.length > 0 ? (
        <ol className="tuning-sampler-chain__list" role="list" aria-label={t("extra.samplerChainTitle")} aria-describedby={`${id}-sampler-chain-hint`}>
          {/* Explicit list roles preserve Safari VoiceOver semantics with list-style: none and grid layout. */}
          {draft.map((sampler, index) => (
            <li
              key={sampler}
              role="listitem"
              aria-label={sampler}
              className={`tuning-sampler-chip app-list-row ${draggedIndex === index ? "is-dragging" : ""}`}
              draggable={!disabled}
              onDragStart={() => setDrag({ source: normalizedSource, index })}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => drop(index)}
              onDragEnd={() => setDrag(null)}
              data-sampler={sampler}
              data-testid={`sampler-chip-${sampler}`}
            >
              <span className="tuning-sampler-chip__grip" aria-hidden="true">⋮⋮</span>
              <span className="tuning-sampler-chip__number" aria-hidden="true">{index + 1}</span>
              <span className="tuning-sampler-chip__name">{sampler}</span>
              <span className="tuning-sampler-chip__actions">
                <button type="button" className="app-icon-button app-icon-button--sm" onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label={help.moveSamplerEarlier.replace('{name}', sampler)}>←</button>
                <button type="button" className="app-icon-button app-icon-button--sm" onClick={() => move(index, 1)} disabled={disabled || index === draft.length - 1} aria-label={help.moveSamplerLater.replace('{name}', sampler)}>→</button>
                <button type="button" className="app-icon-button app-icon-button--sm app-icon-button--danger" onClick={() => publish(draft.filter((_, itemIndex) => itemIndex !== index))} disabled={disabled} aria-label={help.removeSampler.replace('{name}', sampler)}>×</button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="tuning-sampler-chain__empty" role="status">{t("extra.samplerChainEmpty")}</p>
      )}

      <div className="tuning-sampler-chain__add">
        <label htmlFor={`${id}-sampler-add`} className="sr-only">{t("extra.samplerChainAdd")}</label>
        <CustomSelect id={`${id}-sampler-add`} ariaDescribedBy={`${id}-sampler-chain-hint`} value={selectedToAdd} onChange={setSelectedToAdd} disabled={disabled || availableOptions.length === 0} className="tuning-sampler-chain__select" ariaLabel={t("extra.samplerChainAdd")} options={[{ value: "", label: t("extra.samplerChainAddPlaceholder") }, ...availableOptions.map(option => ({ value: option, label: option }))]} />
        <button
          type="button"
          className="app-button app-button--secondary app-button--sm"
          disabled={disabled || !selectedToAdd}
          onClick={() => {
            if (!selectedToAdd) return;
            publish([...draft, selectedToAdd]);
            setSelectedToAdd("");
          }}
        >
          {t("extra.samplerChainAdd")}
        </button>
      </div>
      <p id={`${id}-sampler-chain-hint`} className="tuning-sampler-chain__hint">{help.samplerChain}</p>
    </div>
  );
}

export { TuningSamplerChain };
