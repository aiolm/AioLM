import type { AppConfig } from "../../shared/api/types";
import { useI18n } from "../../shared/i18n/i18n";
import TuningSliderField from "./TuningSliderField";
import TuningDefaultField from "./TuningDefaultField";
import { tuningFieldDescription, tuningFieldLabel, type NumericField, type NumericKey } from "./tuningFields";
import { useTuningId } from './TuningIdScope';

interface NumericFieldGridProps {
  fields: readonly NumericField[];
  cfg: AppConfig;
  drafts: Partial<Record<NumericKey, string>>;
  disabled: boolean;
  onChange: (key: NumericKey, value: string) => void;
  onCommit: (field: NumericField, value: string) => void;
}

export default function NumericFieldGrid({ fields, cfg, drafts, disabled, onChange, onCommit }: NumericFieldGridProps) {
  const { t } = useI18n();
  const id = useTuningId();
  return (
    <>
      {fields.map((field) => {
        const current = typeof cfg[field.key] === "number" ? cfg[field.key] as number : field.min;
        const draft = drafts[field.key] ?? String(current);
        const inputId = `${id}-${field.key}`;
        const label = tuningFieldLabel(t, field);
        const description = tuningFieldDescription(t, field);
        return (
          <TuningDefaultField key={field.key} fieldKey={field.key} label={label}><TuningSliderField
            id={inputId}
            label={label}
            min={field.min}
            max={field.max}
            step={field.step}
            hint={description}
            value={draft}
            onChange={(value) => onChange(field.key, value)}
            onCommit={(value) => onCommit(field, value)}
            disabled={disabled}
            valueMeta={<span className={`shrink-0 text-xs ${field.server ? "text-warning" : "text-success"}`}>
              {field.server ? t("extra.serverSide") : t("extra.perRequest")}
            </span>}
          /></TuningDefaultField>
        );
      })}
    </>
  );
}
