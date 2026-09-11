import type { AppConfig } from "../../shared/api/types";
import Tooltip from "../../shared/ui/Tooltip";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import TuningDefaultField from "./TuningDefaultField";
import TuningOptionMetadata from './TuningOptionMetadata';
import { SERVER_FIELDS, SERVER_TEXT_FIELDS, tuningFieldHint, tuningFieldLabel, tuningFieldTooltip, type NumericField, type NumericKey, type ServerTextKey } from "./tuningFields";
import TuningSpeculativeSection from "./TuningSpeculativeSection";

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
  const projectorField = SERVER_TEXT_FIELDS.find((field) => field.key === "mmproj");
  const projectorTooltip = projectorField ? tuningFieldTooltip(t as never, projectorField) : undefined;
  const cacheKeyField = SERVER_TEXT_FIELDS.find((field) => field.key === "cache_type_k");
  const cacheValueField = SERVER_TEXT_FIELDS.find((field) => field.key === "cache_type_v");
  const cacheFields = [cacheKeyField, cacheValueField].filter((field): field is NonNullable<typeof field> => Boolean(field));
  return (
    <section className="tuning-section tuning-section--server">
      {fields.length > 0 && <div className="tuning-field-list"><NumericFieldGrid fields={fields} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} /></div>}
      {showFlashAttention && <div className="mt-4 flex min-w-0 flex-col gap-1.5 w-full max-w-lg">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <label htmlFor="tuning-flash-attn" className="text-sm text-ink">{t("ui.flashAttention")}</label>
            <Tooltip content={{ title: t("ui.flashAttention") as string, description: t("ui.flashAttentionHint") as string }} label={`Help for ${t("ui.flashAttention")}`} id="tuning-flash-attn-help" />
          </div>
          <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
        </div>
        <TuningDefaultField fieldKey="flash_attn" label={t("ui.flashAttention")} hideLabel><CustomSelect
          id="tuning-flash-attn"
          value={cfg.flash_attn === "on" || cfg.flash_attn === "off" ? cfg.flash_attn : "auto"}
          options={[
            { value: "auto", label: "auto" },
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ]}
          onChange={updateFlash}
          disabled={disabled}
          className="w-full"
        /></TuningDefaultField>
        <span className="text-xs text-muted">{t("ui.flashAttentionHint")}</span>
      </div>}

      {showCacheTypes && showAdvanced && cacheFields.length > 0 && (
        <div className="mt-4 grid min-w-0 gap-4 app-form-grid">
          {cacheFields.map((field) => {
            const inputId = `tuning-${field.key}`;
            const value = serverTextValue(field.key);
            const label = tuningFieldLabel(t as never, field);
            const hint = tuningFieldHint(t as never, field);
            const tooltip = tuningFieldTooltip(t as never, field);
            return (
              <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <label htmlFor={inputId} className="app-text-wrap text-sm text-ink">{label}</label>
                  <Tooltip content={tooltip} label={`Help for ${label}`} id={`${inputId}-help`} />
                </div>
                <TuningDefaultField fieldKey={field.key} label={label} hideLabel><CustomSelect
                  id={inputId}
                  value={field.options?.includes(value) ? value : (field.options?.[0] ?? value)}
                  options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
                  onChange={(next) => {
                    onServerTextChange(field.key, next);
                    commitServerText(field.key, next);
                  }}
                  disabled={disabled}
                  className="w-full"
                /></TuningDefaultField>
                <span className="text-xs text-muted">{hint}</span>
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
                <label htmlFor="tuning-mmproj" className="text-sm text-ink">{t("ui.mmprojLabel")}</label>
                {projectorTooltip && <Tooltip content={projectorTooltip} label={`Help for ${t("ui.mmprojLabel")}`} id="tuning-mmproj-help" />}
              </div>
              <span className="shrink-0 text-xs text-warning">{t("extra.serverSide")}</span>
            </div>
            <input
              id="tuning-mmproj"
              value={serverTextValue("mmproj")}
              onChange={(event) => onServerTextChange("mmproj", event.target.value)}
              onBlur={(event) => commitServerText("mmproj", event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              disabled={!projectorEditable || disabled}
              placeholder={t("ui.mmprojPlaceholder")}
              className="app-input mt-1"
            />
            <span className="text-xs text-muted">{t("ui.mmprojHint")}</span>
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
