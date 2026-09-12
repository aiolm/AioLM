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
import { resetAllTuning, resetTuningField } from '../../shared/config/tuningDefaults';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { findModelTuningProfile } from '../../shared/config/qwenDefaults';
import type { useServerOptions } from '../tuning/useServerOptions';
import { modelSettingsCopy } from './modelSettingsCopy';

export type DraftPatch = (patch: Partial<AppConfig>) => void;
export const BENCHMARK_CONTROLLED_KEYS = new Set(['ctx_size', 'parallel', 'request_timeout_seconds', 'sleep_idle_seconds', 'temperature', 'top_p', 'top_k', 'chat_options', 'reasoning_effort']);

/** All handlers edit an in-memory draft. Persistence belongs to the dialog's caller. */
export default function DraftTuningEditor({ cfg, section, disabled, benchmark, runtime, onChange, onInvalid, onResetDrafts }: {
  cfg: AppConfig; section: string; disabled: boolean; benchmark: boolean;
  runtime: ReturnType<typeof useServerOptions>; onChange: DraftPatch;
  onInvalid: (key: string, invalid: boolean) => void;
  onResetDrafts: () => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const copy = modelSettingsCopy[locale];
  const display = tuningDisplayConfig(cfg, runtime.options);
  const [numbers, setNumbers] = useState<Partial<Record<NumericKey, string>>>({});
  const [chatNumbers, setChatNumbers] = useState<Record<string, string>>({});
  const [selectModes, setSelectModes] = useState<Record<string, 'select' | 'custom'>>({});
  const [customText, setCustomText] = useState<Partial<Record<ServerTextKey, boolean>>>({});
  const numeric = (key: NumericKey, raw: string) => {
    setNumbers(previous => ({ ...previous, [key]: raw }));
    const field = [...SERVER_FIELDS, ...MTP_FIELDS, ...SAMPLING_FIELDS, ...REASONING_FIELDS].find(item => item.key === key)!;
    const value = parseNumericInput(raw, field.step);
    const valid = value !== null && value >= field.min && value <= field.max;
    onInvalid(key, !valid);
    if (valid) onChange({ [key]: value });
  };
  const chatNumeric = (key: string, raw: string) => {
    const field = ADVANCED_SAMPLING_FIELDS.find(item => item.key === key)!;
    const value = parseNumericInput(raw, field.step);
    const valid = value !== null && value >= field.min && value <= field.max;
    onInvalid(key, !valid);
    return valid ? value : undefined;
  };
  const setChatDrafts: Dispatch<SetStateAction<Record<string, string>>> = update => {
    const next = typeof update === 'function' ? update(chatNumbers) : update;
    setChatNumbers(next);
    const options = { ...cfg.chat_options };
    for (const [key, raw] of Object.entries(next)) {
      if (raw === chatNumbers[key]) continue;
      const value = chatNumeric(key, raw);
      if (value !== undefined) options[key] = value;
    }
    onChange({ chat_options: options });
  };
  const clearDrafts = (key?: string) => {
    for (const name of [...Object.keys(numbers), ...Object.keys(chatNumbers)]) if (!key || key === name) onInvalid(name, false);
    if (!key) { setNumbers({}); setChatNumbers({}); setCustomText({}); setSelectModes({}); }
    else {
      setNumbers(previous => { const next = { ...previous }; delete next[key as NumericKey]; return next; });
      setChatNumbers(previous => { const next = { ...previous }; delete next[key]; return next; });
    }
  };
  const filterPatch = (patch: Partial<AppConfig>) => benchmark
    ? Object.fromEntries(Object.entries(patch).filter(([key]) => !BENCHMARK_CONTROLLED_KEYS.has(key))) as Partial<AppConfig> : patch;
  const bulk = (patch: Partial<AppConfig>) => { clearDrafts(); onChange(filterPatch(patch)); onResetDrafts(); };
  const reset = (key?: string) => {
    clearDrafts(key);
    onChange(filterPatch(key ? resetTuningField(cfg, key, tuningResetValues(runtime.options)) : resetAllTuning(tuningResetValues(runtime.options))));
    if (!key) onResetDrafts();
  };
  const textValue = (key: ServerTextKey) => String(display[key] ?? '');
  const text = (key: ServerTextKey, value: string) => onChange({ [key]: value });
  const commitText = (key: ServerTextKey, value: string) => { if (value !== textValue(key)) text(key, value); };
  const optionsFor = (key: 'spec_type' | 'spec_draft_ngl'): readonly string[] => key === 'spec_type' ? SPEC_TYPE_OPTIONS : SPEC_DRAFT_NGL_OPTIONS;
  const profile = findModelTuningProfile(cfg.active_model, cfg.active_build);
  const numericProps = { numericDrafts: numbers, onNumericChange: numeric, onNumericCommit: (field: { key: NumericKey }, value: string) => numeric(field.key, value) };
  const fields = SERVER_FIELDS.filter(field => !benchmark || !BENCHMARK_CONTROLLED_KEYS.has(field.key));
  return <TuningIdScope.Provider value={id}><TuningOptionsContext.Provider value={runtime}><TuningDefaultsContext.Provider value={{ cfg, disabled, reset }}>
    <div className="model-settings-presets">
      <span>{copy.preset}</span>
      <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled} onClick={() => bulk({ ngl: 0, threads: 0, flash_attn: 'off' })}>{copy.cpu}</button>
      <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled} onClick={() => bulk({ ngl: 99, ctx_size: 8192, threads: 0, flash_attn: 'auto' })}>{copy.balanced}</button>
      <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled} onClick={() => bulk({ ngl: 99, ctx_size: 16384, threads: 0, flash_attn: 'on' })}>{copy.maxGpu}</button>
      {profile && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled} onClick={() => bulk({ ...profile.defaults, mmproj: cfg.mmproj, server_args: [...profile.serverArgs], chat_options: structuredClone(profile.chatOptions) })}>{copy.tuningProfile}</button>}
      <button type="button" className="app-button app-button--ghost app-button--sm" disabled={disabled} onClick={() => reset()}>{copy.reset}</button>
    </div>
    {section === 'sampling' ? <TuningSamplingSection t={t} cfg={display} disabled={disabled} {...numericProps}
      chatOptionDrafts={chatNumbers} setChatOptionDrafts={setChatDrafts} chatOptionSelectModes={selectModes} setChatOptionSelectModes={setSelectModes}
      onChatOptionCommit={(field, value) => { const parsed = chatNumeric(field.key, value); if (parsed !== undefined) onChange({ chat_options: { ...cfg.chat_options, [field.key]: parsed } }); }}
      samplerChain={Array.isArray(display.chat_options.samplers) ? display.chat_options.samplers.filter((value): value is string => typeof value === 'string') : []}
      onSamplerChainChange={samplers => onChange({ chat_options: { ...cfg.chat_options, samplers } })} draftMode />
      : section === 'reasoning' ? <TuningReasoningSection t={t} cfg={display} disabled={disabled} {...numericProps}
        updateServerText={text} updateReasoningEffort={reasoning_effort => onChange({ reasoning_effort })}
        reasoningBudgetMessageValue={textValue('reasoning_budget_message')} onReasoningBudgetMessageChange={value => text('reasoning_budget_message', value)}
        onReasoningBudgetMessageCommit={value => commitText('reasoning_budget_message', value)} />
        : <TuningServerSection t={t} cfg={display} disabled={disabled} {...numericProps} fields={section === 'adapters' ? [] : fields}
          showFlashAttention={section !== 'adapters'} showCacheTypes={section !== 'adapters'} showProjector={false} showSpeculative={section === 'adapters'}
          updateFlash={flash_attn => onChange({ flash_attn })} serverTextValue={textValue} onServerTextChange={text} commitServerText={commitText} projectorEditable
          serverSelectValue={key => customText[key] || !optionsFor(key).includes(textValue(key)) ? 'custom' : textValue(key)}
          selectServerText={(key, value) => { setCustomText(previous => ({ ...previous, [key]: value === 'custom' })); if (value !== 'custom') text(key, value); }} />}
  </TuningDefaultsContext.Provider></TuningOptionsContext.Provider></TuningIdScope.Provider>;
}
