import type { AppConfig } from "../../shared/api/types";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import TuningDefaultField from "./TuningDefaultField";
import TuningOptionMetadata from './TuningOptionMetadata';
import { MTP_FIELDS, type NumericField, type NumericKey, type ServerTextKey } from "./tuningFields";
import { SPEC_DRAFT_NGL_OPTIONS, SPEC_TYPE_OPTIONS } from "../../shared/config/tuningValidation";
import { useTuningId } from './TuningIdScope';
import { useI18n } from '../../shared/i18n/i18n';
import { tuningHelp } from '../../shared/i18n/tuningHelp';

type SpecSelectKey = Extract<ServerTextKey, "spec_type" | "spec_draft_ngl">;
type SpecTextKey = Extract<ServerTextKey, "spec_type" | "spec_draft_ngl" | "spec_draft_device" | "spec_draft_model">;

interface Props {
  cfg: AppConfig;
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  serverTextValue: (key: SpecTextKey) => string;
  serverSelectValue: (key: SpecSelectKey) => string;
  selectServerText: (key: SpecSelectKey, value: string) => void;
  onServerTextChange: (key: SpecTextKey, value: string) => void;
  commitServerText: (key: SpecTextKey, value: string) => void;
}

/** Presentational: the "Speculative decoding" sub-section of the server tuning form. */
export default function TuningSpeculativeSection({
  cfg, t, disabled, numericDrafts, onNumericChange, onNumericCommit,
  serverTextValue, serverSelectValue, selectServerText, onServerTextChange, commitServerText,
}: Props) {
  const id = useTuningId();
  const { locale } = useI18n();
  const help = tuningHelp[locale];
  return (
    <div className="mt-5 rounded-lg border border-line-strong/80 bg-surface/40 p-3">
      <h3 className="app-section-title">{t("ui.specTitle")}</h3>
      <p className="app-section-hint mb-4">{t("ui.specHint")}</p>
      <div className="grid gap-4 app-form-grid">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor={`${id}-spec-type`} className="text-sm text-ink">{t("ui.specTypeLabel")}</label>
            </div>
            <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
          </div>
          <TuningDefaultField fieldKey="spec_type" label={t("ui.specTypeLabel")}><CustomSelect
            id={`${id}-spec-type`}
            ariaDescribedBy={`${id}-spec-type-hint`}
            value={serverSelectValue("spec_type")}
            options={[
              ...SPEC_TYPE_OPTIONS.map((val) => ({ value: val, label: val })),
              { value: "custom", label: t("ui.customCommaList") },
            ]}
            onChange={(val) => selectServerText("spec_type", val)}
            disabled={disabled}
            className="w-full"
          />
          <div className="tuning-custom-input-slot">
            {serverSelectValue("spec_type") === "custom" && (
              <input
                aria-label={t("ui.customValueFor", { label: t("ui.specTypeLabel") })}
                aria-describedby={`${id}-spec-type-hint`}
                value={serverTextValue("spec_type")}
                onChange={(event) => onServerTextChange("spec_type", event.target.value)}
                onBlur={(event) => commitServerText("spec_type", event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={disabled}
                placeholder="draft-mtp,ngram-mod"
                className="app-input font-mono"
              />
            )}
          </div>
          <span id={`${id}-spec-type-hint`} className="text-xs text-muted">{help.specType}</span></TuningDefaultField>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor={`${id}-spec-draft-ngl`} className="text-sm text-ink">{t("ui.specDraftNglLabel")}</label>
            </div>
            <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
          </div>
          <TuningDefaultField fieldKey="spec_draft_ngl" label={t("ui.specDraftNglLabel")}><CustomSelect
            id={`${id}-spec-draft-ngl`}
            ariaDescribedBy={`${id}-spec-draft-ngl-hint`}
            value={serverSelectValue("spec_draft_ngl")}
            options={[
              ...SPEC_DRAFT_NGL_OPTIONS.map((val) => ({ value: val, label: val })),
              { value: "custom", label: t("ui.customNumeric") },
            ]}
            onChange={(val) => selectServerText("spec_draft_ngl", val)}
            disabled={disabled}
            className="w-full"
          />
          <div className="tuning-custom-input-slot">
            {serverSelectValue("spec_draft_ngl") === "custom" && (
              <input
                aria-label={t("ui.customValueFor", { label: t("ui.specDraftNglLabel") })}
                aria-describedby={`${id}-spec-draft-ngl-hint`}
                value={serverTextValue("spec_draft_ngl")}
                onChange={(event) => onServerTextChange("spec_draft_ngl", event.target.value)}
                onBlur={(event) => commitServerText("spec_draft_ngl", event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={disabled}
                placeholder="32"
                inputMode="numeric"
                className="app-input"
              />
            )}
          </div>
          <span id={`${id}-spec-draft-ngl-hint`} className="text-xs text-muted">{help.specDraftGpuLayers}</span></TuningDefaultField>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor={`${id}-spec-draft-device`} className="text-sm text-ink">{t("ui.specDraftDeviceLabel")}</label>
            </div>
            <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
          </div>
          <input
            id={`${id}-spec-draft-device`}
            aria-describedby={`${id}-spec-draft-device-hint`}
            value={serverTextValue("spec_draft_device")}
            onChange={(event) => onServerTextChange("spec_draft_device", event.target.value)}
            onBlur={(event) => commitServerText("spec_draft_device", event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={disabled}
            placeholder={t("ui.specDraftDevicePlaceholder")}
            className="w-full rounded-lg border border-line-strong app-bg-muted px-3 py-2 text-sm text-ink focus:border-accent-line focus:outline-none"
          />
          <span id={`${id}-spec-draft-device-hint`} className="text-xs text-muted">{help.specDraftDevice}</span>
          <TuningOptionMetadata fieldKey="spec_draft_device" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor={`${id}-spec-draft-model`} className="text-sm text-ink">{t("ui.specDraftModelLabel")}</label>
            </div>
            <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
          </div>
          <input
            id={`${id}-spec-draft-model`}
            aria-describedby={`${id}-spec-draft-model-hint`}
            value={serverTextValue("spec_draft_model")}
            onChange={(event) => onServerTextChange("spec_draft_model", event.target.value)}
            onBlur={(event) => commitServerText("spec_draft_model", event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={disabled}
            placeholder={t("ui.specDraftModelPlaceholder")}
            className="w-full rounded-lg border border-line-strong app-bg-muted px-3 py-2 text-sm text-ink focus:border-accent-line focus:outline-none"
          />
          <span id={`${id}-spec-draft-model-hint`} className="text-xs text-muted">{help.specDraftModel}</span>
          <TuningOptionMetadata fieldKey="spec_draft_model" />
        </div>
      </div>
      <div className="mt-4 grid gap-4 app-form-grid">
        <NumericFieldGrid fields={MTP_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} />
      </div>
    </div>
  );
}
