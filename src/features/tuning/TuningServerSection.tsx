import type { AppConfig } from "../../shared/api/types";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import TuningDefaultField from "./TuningDefaultField";
import TuningOptionMetadata from './TuningOptionMetadata';
import { SERVER_FIELDS, SERVER_TEXT_FIELDS, tuningFieldDescription, tuningFieldLabel, type NumericField, type NumericKey, type ServerTextKey } from "./tuningFields";
import TuningSpeculativeSection from "./TuningSpeculativeSection";
import { useTuningId } from './TuningIdScope';
import { useI18n } from '../../shared/i18n/i18n';
import { tuningHelp } from '../../shared/i18n/tuningHelp';

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  cfg: AppConfig;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  updateFlash: (value: string) => void;
  serverTextValue: (key: ServerTextKey) => string;
  onServerTextChange: (key: ServerTextKey, value: string) => void;
  commitServerText: (key: ServerTextKey, value: string) => void;
  projectorEditable: boolean;
  serverSelectValue: (key: "spec_type" | "spec_draft_ngl") => string;
  selectServerText: (key: "spec_type" | "spec_draft_ngl", value: string) => void;
  /** Advanced-only nested controls are omitted from the Quick view. */
  showAdvanced?: boolean;
  /** Field-level category slicing supplied by TuningPanel. */
  fields?: readonly NumericField[];
  showFlashAttention?: boolean;
  showProjector?: boolean;
  showSpeculative?: boolean;
  showCacheTypes?: boolean;
}

export default function TuningServerSection({
  t, cfg, disabled, numericDrafts, onNumericChange, onNumericCommit, updateFlash,
  serverTextValue, onServerTextChange, commitServerText, projectorEditable,
  serverSelectValue, selectServerText, showAdvanced = true,
  fields = SERVER_FIELDS, showFlashAttention = true, showProjector = true,
  showSpeculative = true, showCacheTypes = true,
}: Props) {
  const id = useTuningId();
  const { locale } = useI18n();
  const cacheKeyField = SERVER_TEXT_FIELDS.find((field) => field.key === "cache_type_k");
  const cacheValueField = SERVER_TEXT_FIELDS.find((field) => field.key === "cache_type_v");
  const cacheFields = [cacheKeyField, cacheValueField].filter((field): field is NonNullable<typeof field> => Boolean(field));
  return (
    <section className="tuning-section tuning-section--server">
      {fields.length > 0 && <div className="tuning-field-list"><NumericFieldGrid fields={fields} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} /></div>}
      {showFlashAttention && <div className="mt-4 flex min-w-0 flex-col gap-1.5 w-full max-w-lg">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <label htmlFor={`${id}-flash-attn`} className="text-sm text-ink">{t("ui.flashAttention")}</label>
          </div>
          <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
        </div>
        <TuningDefaultField fieldKey="flash_attn" label={t("ui.flashAttention")}><CustomSelect
          id={`${id}-flash-attn`}
          ariaDescribedBy={`${id}-flash-attn-hint`}
          value={cfg.flash_attn === "on" || cfg.flash_attn === "off" ? cfg.flash_attn : "auto"}
          options={[
            { value: "auto", label: "auto" },
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ]}
          onChange={updateFlash}
          disabled={disabled}
          className="w-full"
        /><span id={`${id}-flash-attn-hint`} className="text-xs text-muted">{tuningHelp[locale].flashAttention}</span></TuningDefaultField>
      </div>}

      {showCacheTypes && showAdvanced && cacheFields.length > 0 && (
        <div className="mt-4 grid min-w-0 gap-4 app-form-grid">
          {cacheFields.map((field) => {
            const inputId = `${id}-${field.key}`;
            const value = serverTextValue(field.key);
            const label = tuningFieldLabel(t as never, field);
            const description = tuningFieldDescription(t, field);
            return (
              <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <label htmlFor={inputId} className="app-text-wrap text-sm text-ink">{label}</label>
                </div>
                <TuningDefaultField fieldKey={field.key} label={label}><CustomSelect
                  id={inputId}
                  ariaDescribedBy={`${inputId}-hint`}
                  value={field.options?.includes(value) ? value : (field.options?.[0] ?? value)}
                  options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
                  onChange={(next) => {
                    onServerTextChange(field.key, next);
                    commitServerText(field.key, next);
                  }}
                  disabled={disabled}
                  className="w-full"
                /><span id={`${inputId}-hint`} className="text-xs text-muted">{description}</span></TuningDefaultField>
              </div>
            );
          })}
        </div>
      )}

      {showAdvanced && (showProjector || showSpeculative) && (
        <>
          {showProjector && <div className="mt-4 flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <label htmlFor={`${id}-mmproj`} className="text-sm text-ink">{t("ui.mmprojLabel")}</label>
              </div>
              <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
            </div>
            <input
              id={`${id}-mmproj`}
              aria-describedby={`${id}-mmproj-hint`}
              value={serverTextValue("mmproj")}
              onChange={(event) => onServerTextChange("mmproj", event.target.value)}
              onBlur={(event) => commitServerText("mmproj", event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              disabled={!projectorEditable || disabled}
              placeholder={t("ui.mmprojPlaceholder")}
              className="app-input mt-1"
            />
            <span id={`${id}-mmproj-hint`} className="text-xs text-muted">{tuningHelp[locale].projector}</span>
            <TuningOptionMetadata fieldKey="mmproj" />
          </div>}

          {showSpeculative && <TuningSpeculativeSection
            cfg={cfg}
            t={t}
            disabled={disabled}
            numericDrafts={numericDrafts}
            onNumericChange={onNumericChange}
            onNumericCommit={onNumericCommit}
            serverTextValue={serverTextValue}
            serverSelectValue={serverSelectValue}
            selectServerText={selectServerText}
            onServerTextChange={onServerTextChange}
            commitServerText={commitServerText}
          />}
        </>
      )}
    </section>
  );
}
