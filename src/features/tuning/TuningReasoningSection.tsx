import type { AppConfig } from "../../shared/api/types";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import TuningDefaultField from "./TuningDefaultField";
import { TuningOptionsContext } from './TuningOptionMetadata';
import { settingDefaultLabel } from '../../shared/config/defaultValueDisplay';
import { REASONING_FIELDS, type NumericField, type NumericKey } from "./tuningFields";
import { useTuningId } from './TuningIdScope';
import { useContext } from 'react';
import { useI18n } from '../../shared/i18n/i18n';
import { tuningHelp } from '../../shared/i18n/tuningHelp';

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  cfg: AppConfig;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  updateServerText: (key: "reasoning" | "reasoning_format" | "reasoning_preserve", value: string) => void;
  updateReasoningEffort: (value: string) => void;
  reasoningBudgetMessageValue: string;
  onReasoningBudgetMessageChange: (value: string) => void;
  onReasoningBudgetMessageCommit: (value: string) => void;
}

export default function TuningReasoningSection({
  t, cfg, disabled, numericDrafts, onNumericChange, onNumericCommit,
  updateServerText, updateReasoningEffort, reasoningBudgetMessageValue,
  onReasoningBudgetMessageChange, onReasoningBudgetMessageCommit,
}: Props) {
  const id = useTuningId();
  const { locale } = useI18n();
  const help = tuningHelp[locale];
  const runtime = useContext(TuningOptionsContext);
  const preserveDefault = settingDefaultLabel('reasoning_preserve', runtime.options, runtime.verified, locale, { selected: cfg.reasoning_preserve === 'auto', compact: true });
  const effortDefault = settingDefaultLabel('reasoning_effort', runtime.options, runtime.verified, locale, { selected: cfg.reasoning_effort === 'default', compact: true });
  const budgetMessageDefault = settingDefaultLabel('reasoning_budget_message', runtime.options, runtime.verified, locale);
  return (
    <section className="tuning-section tuning-section--reasoning min-w-0 app-card app-card--muted">
      <p className="mb-4 text-xs text-muted">{t("extra.reasoningDescription")}</p>
      <div className="grid gap-4 app-form-grid">
        <div className="flex min-w-0 flex-col gap-1.5">
          <TuningDefaultField fieldKey="reasoning" label={t("ui.reasoningMode")}>{(resetAction) => <><div className="tuning-field-title">
            <label htmlFor={`${id}-reasoning`} className="text-sm text-ink">{t("ui.reasoningMode")}</label>
            {resetAction}
          </div>
          <CustomSelect
            id={`${id}-reasoning`}
            ariaDescribedBy={`${id}-reasoning-hint`}
            value={cfg.reasoning}
            options={[
              { value: "auto", label: "auto" },
              { value: "on", label: "on" },
              { value: "off", label: "off" },
            ]}
            onChange={(val) => updateServerText("reasoning", val)}
            disabled={disabled}
            className="w-full"
          /><span id={`${id}-reasoning-hint`} className="text-xs text-muted">{help.reasoning}</span></>}</TuningDefaultField>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <TuningDefaultField fieldKey="reasoning_format" label={t("ui.reasoningFormat")}>{(resetAction) => <><div className="tuning-field-title">
            <label htmlFor={`${id}-reasoning-format`} className="text-sm text-ink">{t("ui.reasoningFormat")}</label>
            {resetAction}
          </div>
          <CustomSelect
            id={`${id}-reasoning-format`}
            ariaDescribedBy={`${id}-reasoning-format-hint`}
            value={cfg.reasoning_format}
            options={[
              { value: "auto", label: "auto" },
              { value: "none", label: "none" },
              { value: "deepseek", label: "deepseek" },
              { value: "deepseek-legacy", label: "deepseek-legacy" },
            ]}
            onChange={(val) => updateServerText("reasoning_format", val)}
            disabled={disabled}
            className="w-full"
          /><span id={`${id}-reasoning-format-hint`} className="text-xs text-muted">{help.reasoningFormat}</span></>}</TuningDefaultField>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <TuningDefaultField fieldKey="reasoning_preserve" label={t("ui.reasoningPreserve")}>{(resetAction) => <><div className="tuning-field-title">
            <label htmlFor={`${id}-reasoning-preserve`} className="text-sm text-ink">{t("ui.reasoningPreserve")}</label>
            {resetAction}
          </div>
          <CustomSelect
            id={`${id}-reasoning-preserve`}
            ariaDescribedBy={`${id}-reasoning-preserve-hint`}
            value={cfg.reasoning_preserve}
            options={[
              { value: "auto", label: cfg.reasoning_preserve === 'auto' ? preserveDefault : `${t("ui.templateDefault")} · ${preserveDefault}` },
              { value: "on", label: "on" },
              { value: "off", label: "off" },
            ]}
            onChange={(val) => updateServerText("reasoning_preserve", val)}
            disabled={disabled}
            className="w-full"
          /><span id={`${id}-reasoning-preserve-hint`} className="text-xs text-muted">{help.reasoningPreserve}</span></>}</TuningDefaultField>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <TuningDefaultField fieldKey="reasoning_effort" label={t("ui.reasoningEffort")}>{(resetAction) => <><div className="flex flex-wrap items-center justify-between gap-2">
            <div className="tuning-field-title">
              <label htmlFor={`${id}-reasoning-effort`} className="text-sm text-ink">{t("ui.reasoningEffort")}</label>
              {resetAction}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="shrink-0 text-xs text-warning">{t("ui.serverAndRequest")}</span>
            </div>
          </div>
          <CustomSelect
            id={`${id}-reasoning-effort`}
            ariaDescribedBy={`${id}-reasoning-effort-hint`}
            value={cfg.reasoning_effort}
            options={[
              { value: "default", label: cfg.reasoning_effort === 'default' ? effortDefault : `default · ${effortDefault}` },
              { value: "none", label: "none" },
              { value: "minimal", label: "minimal" },
              { value: "low", label: "low" },
              { value: "medium", label: "medium" },
              { value: "high", label: "high" },
              { value: "xhigh", label: "xhigh" },
              { value: "max", label: "max" },
            ]}
            onChange={(val) => updateReasoningEffort(val)}
            disabled={disabled}
            className="w-full"
          /><span id={`${id}-reasoning-effort-hint`} className="text-xs text-muted">{help.reasoningEffort}</span></>}</TuningDefaultField>
        </div>
      </div>
      <div className="mt-4 grid gap-4 app-form-grid">
        <NumericFieldGrid fields={REASONING_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <TuningDefaultField fieldKey="reasoning_budget_message" label={t("ui.budgetMessageLabel")}>{(resetAction) => <><div className="tuning-field-title">
            <label htmlFor={`${id}-reasoning-budget-message`} className="text-sm text-ink">{t("ui.budgetMessageLabel")}</label>
            {resetAction}
          </div>
          <input
            id={`${id}-reasoning-budget-message`}
            aria-describedby={`${id}-reasoning-budget-message-hint`}
            value={reasoningBudgetMessageValue}
            onChange={(event) => onReasoningBudgetMessageChange(event.target.value)}
            onBlur={(event) => onReasoningBudgetMessageCommit(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={disabled}
            placeholder={`${t("ui.optional")} · ${budgetMessageDefault}`}
            className="app-input mt-1"
          /><span id={`${id}-reasoning-budget-message-hint`} className="text-xs text-muted">{help.reasoningBudgetMessage}</span></>}</TuningDefaultField>
        </div>
      </div>
    </section>
  );
}
