import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "../../shared/api/types";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { clampNumber } from "../../shared/config/tuningValidation";
import { chatOptionValue, tuningFieldDescription, tuningFieldLabel, type ChatOptionField } from "./tuningFields";
import TuningSliderField from "./TuningSliderField";
import TuningDefaultField from "./TuningDefaultField";
import { useTuningId } from './TuningIdScope';

interface Props {
  cfg: AppConfig;
  field: ChatOptionField;
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  disabled: boolean;
  chatOptionDrafts: Record<string, string>;
  setChatOptionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  chatOptionSelectModes: Record<string, "select" | "custom">;
  setChatOptionSelectModes: Dispatch<SetStateAction<Record<string, "select" | "custom">>>;
  onCommit: (field: ChatOptionField, value: string) => void;
}

export default function TuningChatOptionField({
  cfg, field, t, disabled, chatOptionDrafts, setChatOptionDrafts,
  chatOptionSelectModes, setChatOptionSelectModes, onCommit,
}: Props) {
  const id = useTuningId();
  const current = clampNumber(chatOptionValue(cfg, field), field.min, field.max, field.defaultValue);
  const draft = chatOptionDrafts[field.key] ?? String(current);
  const inputId = `${id}-${field.key}`;
  const label = tuningFieldLabel(t as never, field);
  const description = tuningFieldDescription(t, field);
  const selectValue = field.options
    ? (chatOptionSelectModes[field.key] === "custom" || !field.options.some((option) => String(option.value) === draft) ? "custom" : draft)
    : null;
  return (
    <TuningDefaultField fieldKey={field.key} label={label} request><div className="flex min-w-0 flex-col gap-1.5">
      {field.options && <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <label htmlFor={inputId} className="app-text-wrap text-sm text-ink">{label}</label>
        </div>
        <span className="shrink-0 text-xs text-success">{t("extra.perRequest")}</span>
      </div>}
      {field.options ? (
        <>
          <CustomSelect
            id={inputId}
            ariaDescribedBy={`${inputId}-hint`}
            value={selectValue ?? "custom"}
            options={[
              ...field.options.map((opt) => ({ value: String(opt.value), label: field.key === 'mirostat' && opt.value === 0 ? t('ui.disabled') : opt.label })),
              { value: "custom", label: t("ui.customNumeric") },
            ]}
            onChange={(value) => {
              if (value === "custom") {
                setChatOptionSelectModes((modes) => ({ ...modes, [field.key]: "custom" }));
                setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: draft }));
              } else {
                setChatOptionSelectModes((modes) => {
                  const next = { ...modes };
                  delete next[field.key];
                  return next;
                });
                setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: value }));
                onCommit(field, value);
              }
            }}
            disabled={disabled}
            className="w-full"
          />
          <div className="tuning-custom-input-slot">
            {selectValue === "custom" && (
              <input
                aria-label={t("ui.customValueFor", { label })}
                aria-describedby={`${inputId}-hint`}
                type="text"
                inputMode="numeric"
                value={draft}
                step={field.step}
                min={field.min}
                max={field.max}
                onChange={(event) => setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: event.target.value }))}
                onBlur={(event) => { if (chatOptionDrafts[field.key] !== undefined) onCommit(field, event.currentTarget.value); }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={disabled}
                className="w-full min-w-0 rounded-lg border border-line-strong app-bg-muted px-3 py-2 text-sm text-ink focus:border-accent-line focus:outline-none"
              />
            )}
          </div>
        </>
      ) : (
        <TuningSliderField
          id={inputId}
          label={label}
          min={field.min}
          max={field.max}
          step={field.step}
          hint={description}
          value={draft}
          onChange={(value) => setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: value }))}
          onCommit={(value) => onCommit(field, value)}
          disabled={disabled}
          valueMeta={<span className="shrink-0 text-xs text-success">{t("extra.perRequest")}</span>}
        />
      )}
      {field.options && <span id={`${inputId}-hint`} className="text-xs text-muted">{description}</span>}
    </div></TuningDefaultField>
  );
}
