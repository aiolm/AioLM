import { useId, useState, type Dispatch, type SetStateAction } from 'react';
import { TuningIdScope } from '../tuning/TuningIdScope';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { parseNumericInput, SPEC_DRAFT_NGL_OPTIONS, SPEC_TYPE_OPTIONS } from '../../shared/config/tuningValidation';
import { TuningDefaultsContext } from '../tuning/TuningDefaultField';
import { TuningOptionsContext } from '../tuning/TuningOptionMetadata';
import TuningServerSection from '../tuning/TuningServerSection';
import TuningSamplingSection from '../tuning/TuningSamplingSection';
import TuningReasoningSection from '../tuning/TuningReasoningSection';
import { ADVANCED_SAMPLING_FIELDS, MTP_FIELDS, REASONING_FIELDS, SAMPLING_FIELDS, SERVER_FIELDS, type NumericKey, type ServerTextKey } from '../tuning/tuningFields';
import { tuningDisplayConfig } from '../tuning/tuningResetState';
import { removeChatOverride, resetTuningField } from '../../shared/config/tuningDefaults';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import type { useServerOptions } from '../tuning/useServerOptions';

/**
 * Context beyond which an entry is a typo rather than an intent.
 *
 * Far past what any hardware can hold, so it never stands between a user and a
 * configuration llama.cpp would accept; it exists only so a pasted phone number
 * is caught here instead of at launch.
 */
const CONTEXT_SANITY_MAX = 4_194_304;

export type DraftPatch = (patch: Partial<AppConfig>) => void;

/** All handlers edit an in-memory draft. Persistence belongs to the dialog's caller. */
export default function DraftTuningEditor({ cfg, section, disabled, benchmark = false, runtime, contextLimit, onChange, onInvalid }: {
  cfg: AppConfig; section: string; disabled: boolean; benchmark?: boolean;
  /** Context the selected model was trained for, when its header states one. */
  contextLimit?: number;
  runtime: ReturnType<typeof useServerOptions>; onChange: DraftPatch;
  onInvalid: (key: string, invalid: boolean) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const display = tuningDisplayConfig(cfg, runtime.options);
  const [numbers, setNumbers] = useState<Partial<Record<NumericKey, string>>>({});
  const [chatNumbers, setChatNumbers] = useState<Record<string, string>>({});
  const [selectModes, setSelectModes] = useState<Record<string, 'select' | 'custom'>>({});
  const [customText, setCustomText] = useState<Partial<Record<ServerTextKey, boolean>>>({});
  const pairCandidate = (key: 'batch_size' | 'ubatch_size', drafts: Partial<Record<NumericKey, string>>) => {
    if (drafts[key] === undefined) return display[key];
    const field = SERVER_FIELDS.find(item => item.key === key)!;
    const value = parseNumericInput(drafts[key], field.step);
    return value !== null && value >= field.min && value <= field.max ? value : null;
  };
  const pairMinimum = (drafts: Partial<Record<NumericKey, string>>) => cfg.runtime_defaults?.includes('ubatch_size') && drafts.ubatch_size === undefined
    ? 1 : Math.max(1, pairCandidate('ubatch_size', drafts) ?? display.ubatch_size);
  const effectiveBatch = pairCandidate('batch_size', numbers) ?? display.batch_size;
  /**
   * The largest value a control accepts.
   *
   * Context is the one bound this app does not get to decide on its own. When
   * the model's header states what it was trained for, that is the bound. When
   * it does not — an unreadable header, a model not scanned yet — the app has no
   * basis for a limit, and the catalogue's 131072 was a guess that refused
   * perfectly loadable configurations; `CONTEXT_SANITY_MAX` only catches input
   * that is garbage rather than large. A value already configured always
   * qualifies: rejecting a setting for having been made is not validation.
   */
  const ceilingOf = (field: { key: string; max: number }) => {
    if (field.key === 'ctx_size') return Math.max(contextLimit ?? CONTEXT_SANITY_MAX, Number(cfg.ctx_size) || 0);
    if (field.key === 'ubatch_size') return Math.min(field.max, effectiveBatch);
    return field.max;
  };
  const minimumBatch = pairMinimum(numbers);
  const numeric = (key: NumericKey, raw: string) => {
    const nextNumbers = { ...numbers, [key]: raw };
    setNumbers(nextNumbers);
    if (key === 'batch_size' || key === 'ubatch_size') {
      const batch = pairCandidate('batch_size', nextNumbers) ?? display.batch_size;
      const patch: Partial<AppConfig> = {};
      const updatePair = (current: 'batch_size' | 'ubatch_size') => {
        if (nextNumbers[current] === undefined) return;
        const field = SERVER_FIELDS.find(item => item.key === current)!;
        const value = pairCandidate(current, nextNumbers);
        const min = current === 'batch_size' ? pairMinimum(nextNumbers) : field.min;
        const max = current === 'ubatch_size' ? Math.min(field.max, batch) : field.max;
        const valid = value !== null && value >= min && value <= max;
        onInvalid(current, !valid);
        if (valid) patch[current] = value;
      };
      updatePair(key === 'batch_size' ? 'ubatch_size' : 'batch_size');
      updatePair(key);
      if (Object.keys(patch).length) onChange(patch);
      return;
    }
    const field = [...SERVER_FIELDS, ...MTP_FIELDS, ...SAMPLING_FIELDS, ...REASONING_FIELDS].find(item => item.key === key)!;
    const value = parseNumericInput(raw, field.step);
    const valid = value !== null && ((field.allowZero && value === 0) || value >= field.min) && value <= ceilingOf(field) && !field.excludedValues?.includes(value);
    onInvalid(key, !valid);
    if (valid) onChange({ [key]: value });
  };
  const chatNumeric = (key: string, raw: string) => {
    const field = ADVANCED_SAMPLING_FIELDS.find(item => item.key === key)!;
    const value = parseNumericInput(raw, field.step);
    const valid = value !== null && (field.minExclusive ? value > field.min : value >= field.min) && value <= field.max;
    onInvalid(key, !valid);
    return valid ? value : undefined;
  };
  const setChatDrafts: Dispatch<SetStateAction<Record<string, string>>> = update => {
    const next = typeof update === 'function' ? update(chatNumbers) : update;
    setChatNumbers(next);
    let options = { ...cfg.chat_options };
    for (const [key, raw] of Object.entries(next)) {
      if (raw === chatNumbers[key]) continue;
      const value = chatNumeric(key, raw);
      if (value !== undefined) {
        options = removeChatOverride(options, key);
        options[key] = value;
      }
    }
    onChange({ chat_options: options });
  };
  const clearDrafts = (key?: string) => {
    if (!key) {
      for (const name of new Set([...Object.keys(numbers), ...Object.keys(chatNumbers), ...Object.keys(customText), ...Object.keys(selectModes)])) onInvalid(name, false);
      setNumbers({}); setChatNumbers({}); setCustomText({}); setSelectModes({});
    }
    else {
      onInvalid(key, false);
      setNumbers(previous => { const next = { ...previous }; delete next[key as NumericKey]; return next; });
      setChatNumbers(previous => { const next = { ...previous }; delete next[key]; return next; });
      setCustomText(previous => { const next = { ...previous }; delete next[key as ServerTextKey]; return next; });
      setSelectModes(previous => { const next = { ...previous }; delete next[key]; return next; });
    }
  };
  const reset = (key: string) => {
    clearDrafts(key);
    onChange(resetTuningField(cfg, key, tuningResetValues(runtime.options)));
  };
  const textValue = (key: ServerTextKey) => String(display[key] ?? '');
  const text = (key: ServerTextKey, value: string) => onChange({ [key]: value });
  const commitText = (key: ServerTextKey, value: string) => { if (value !== textValue(key)) text(key, value); };
  const optionsFor = (key: 'spec_type' | 'spec_draft_ngl'): readonly string[] => key === 'spec_type' ? SPEC_TYPE_OPTIONS : SPEC_DRAFT_NGL_OPTIONS;
  const numericProps = { numericDrafts: numbers, onNumericChange: numeric, onNumericCommit: (field: { key: NumericKey }, value: string) => numeric(field.key, value) };
  // Match explicit edit bounds, but keep an inherited microbatch's runtime
  // default visible without flagging it as a conflicting manual override.
  const fields = SERVER_FIELDS.map(field => ({
    ...field,
    min: field.key === 'batch_size' ? minimumBatch : field.min,
    max: field.key === 'ubatch_size' && cfg.runtime_defaults?.includes('ubatch_size') && numbers.ubatch_size === undefined
      ? Math.max(ceilingOf(field), display.ubatch_size) : ceilingOf(field),
  }));
  return <TuningIdScope.Provider value={id}><TuningOptionsContext.Provider value={runtime}><TuningDefaultsContext.Provider value={{ cfg, disabled, reset }}>
    {section === 'sampling' ? <TuningSamplingSection t={t} cfg={display} disabled={disabled || benchmark} {...numericProps}
      chatOptionDrafts={chatNumbers} setChatOptionDrafts={setChatDrafts} chatOptionSelectModes={selectModes} setChatOptionSelectModes={setSelectModes}
      onChatOptionCommit={(field, value) => { const parsed = chatNumeric(field.key, value); if (parsed !== undefined) onChange({ chat_options: { ...removeChatOverride(cfg.chat_options, field.key), [field.key]: parsed } }); }}
      samplerChain={Array.isArray(display.chat_options.samplers) ? display.chat_options.samplers.filter((value): value is string => typeof value === 'string') : []}
      onSamplerChainChange={samplers => onChange({ chat_options: { ...cfg.chat_options, samplers } })} draftMode />
      : section === 'reasoning' ? <TuningReasoningSection t={t} cfg={display} disabled={disabled} {...numericProps}
        requestReadOnly={benchmark} updateServerText={text} updateReasoningEffort={reasoning_effort => onChange({ reasoning_effort })}
        reasoningBudgetMessageValue={textValue('reasoning_budget_message')} onReasoningBudgetMessageChange={value => text('reasoning_budget_message', value)}
        onReasoningBudgetMessageCommit={value => commitText('reasoning_budget_message', value)} />
        : <TuningServerSection t={t} cfg={display} disabled={disabled} {...numericProps} fields={section === 'adapters' ? [] : fields}
          showFlashAttention={section !== 'adapters'} showCacheTypes={section !== 'adapters'} showProjector={false} showSpeculative={section === 'adapters'} showDraftBindings={false}
          updateFlash={flash_attn => onChange({ flash_attn })} serverTextValue={textValue} onServerTextChange={text} commitServerText={commitText} projectorEditable
          serverSelectValue={key => customText[key] || !optionsFor(key).includes(textValue(key)) ? 'custom' : textValue(key)}
          selectServerText={(key, value) => { setCustomText(previous => ({ ...previous, [key]: value === 'custom' })); if (value !== 'custom') text(key, value); }} />}
  </TuningDefaultsContext.Provider></TuningOptionsContext.Provider></TuningIdScope.Provider>;
}
