import type { AppConfig } from "../../shared/api/types";
import Tooltip from "../../shared/ui/Tooltip";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import TuningDefaultField from "./TuningDefaultField";
import { REASONING_FIELDS, type NumericField, type NumericKey } from "./tuningFields";
import { useTuningId } from './TuningIdScope';

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
  return (
    <section className="tuning-section tuning-section--reasoning min-w-0 rounded-xl border border-line-strong app-bg-muted p-4">
      <p className="mb-4 text-xs text-muted">{t("extra.reasoningDescription")}</p>
      <div className="grid gap-4 app-form-grid">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={`${id}-reasoning`} className="text-sm text-ink">{t("ui.reasoningMode")}</label>
            <Tooltip content={{ title: "Reasoning mode", description: "Select whether the runtime should expose model reasoning content." }} label={`Help for ${t("ui.reasoningMode")}`} id={`${id}-reasoning-help`} />
          </div>
          <TuningDefaultField fieldKey="reasoning" label={t("ui.reasoningMode")} hideLabel><CustomSelect
            id={`${id}-reasoning`}
            value={cfg.reasoning}
            options={[
              { value: "auto", label: "auto" },
              { value: "on", label: "on" },
              { value: "off", label: "off" },
            ]}
            onChange={(val) => updateServerText("reasoning", val)}
            disabled={disabled}
            className="w-full"
          /></TuningDefaultField>
          <span className="text-xs text-muted">--reasoning.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={`${id}-reasoning-format`} className="text-sm text-ink">{t("ui.reasoningFormat")}</label>
            <Tooltip content={{ title: "Reasoning format", description: "Choose the template format used for reasoning content." }} label={`Help for ${t("ui.reasoningFormat")}`} id={`${id}-reasoning-format-help`} />
          </div>
          <TuningDefaultField fieldKey="reasoning_format" label={t("ui.reasoningFormat")} hideLabel><CustomSelect
            id={`${id}-reasoning-format`}
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
          /></TuningDefaultField>
          <span className="text-xs text-muted">--reasoning-format.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={`${id}-reasoning-preserve`} className="text-sm text-ink">{t("ui.reasoningPreserve")}</label>
            <Tooltip content={{ title: "Preserve reasoning", description: "Keep reasoning state available to the chat template when supported." }} label={`Help for ${t("ui.reasoningPreserve")}`} id={`${id}-reasoning-preserve-help`} />
          </div>
          <TuningDefaultField fieldKey="reasoning_preserve" label={t("ui.reasoningPreserve")} hideLabel><CustomSelect
            id={`${id}-reasoning-preserve`}
            value={cfg.reasoning_preserve}
            options={[
              { value: "auto", label: t("ui.templateDefault") },
              { value: "on", label: "on" },
              { value: "off", label: "off" },
            ]}
            onChange={(val) => updateServerText("reasoning_preserve", val)}
            disabled={disabled}
            className="w-full"
          /></TuningDefaultField>
          <span className="text-xs text-muted">--reasoning-preserve / --no-reasoning-preserve.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor={`${id}-reasoning-effort`} className="text-sm text-ink">{t("ui.reasoningEffort")}</label>
              <Tooltip content={{ title: "Reasoning effort", description: "Per-request effort hint; default leaves the model template in control." }} label={`Help for ${t("ui.reasoningEffort")}`} id={`${id}-reasoning-effort-help`} />
            </div>
            <span className="shrink-0 text-xs text-warning">{t("ui.serverAndRequest")}</span>
          </div>
          <TuningDefaultField fieldKey="reasoning_effort" label={t("ui.reasoningEffort")} hideLabel><CustomSelect
            id={`${id}-reasoning-effort`}
            value={cfg.reasoning_effort}
            options={[
              { value: "default", label: "default" },
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
          /></TuningDefaultField>
          <span className="text-xs text-muted">{t("ui.reasoningEffortHint")}</span>
        </div>
      </div>
      <div className="mt-4 grid gap-4 app-form-grid">
        <NumericFieldGrid fields={REASONING_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={`${id}-reasoning-budget-message`} className="text-sm text-ink">{t("ui.budgetMessageLabel")}</label>
            <Tooltip content={{ title: "Budget message", description: "Optional server message shown when the reasoning budget is exhausted." }} label={`Help for ${t("ui.budgetMessageLabel")}`} id={`${id}-reasoning-budget-message-help`} />
          </div>
          <TuningDefaultField fieldKey="reasoning_budget_message" label={t("ui.budgetMessageLabel")} hideLabel><input
            id={`${id}-reasoning-budget-message`}
            value={reasoningBudgetMessageValue}
            onChange={(event) => onReasoningBudgetMessageChange(event.target.value)}
            onBlur={(event) => onReasoningBudgetMessageCommit(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={disabled}
            placeholder={t("ui.optional")}
            className="app-input mt-1"
          /></TuningDefaultField>
          <span className="text-xs text-muted">{t("ui.budgetMessageHint")}</span>
        </div>
      </div>
    </section>
  );
}
