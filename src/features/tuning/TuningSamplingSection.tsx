import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "../../shared/api/types";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import { ADVANCED_SAMPLING_FIELDS, SAMPLING_FIELDS, type ChatOptionField, type NumericField, type NumericKey } from "./tuningFields";
import TuningChatOptionField from "./TuningChatOptionField";
import TuningSamplerChain from "./TuningSamplerChain";
import TuningDefaultField from "./TuningDefaultField";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  cfg: AppConfig;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  chatOptionDrafts: Record<string, string>;
  setChatOptionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  chatOptionSelectModes: Record<string, "select" | "custom">;
  setChatOptionSelectModes: Dispatch<SetStateAction<Record<string, "select" | "custom">>>;
  onChatOptionCommit: (field: ChatOptionField, value: string) => void;
  samplerChain: readonly string[];
  onSamplerChainChange: (samplers: string[]) => void;
  /** Quick view keeps the three common sampling controls visible only. */
  showAdvanced?: boolean;
}

export default function TuningSamplingSection({
  t, cfg, disabled, numericDrafts, onNumericChange, onNumericCommit,
  chatOptionDrafts, setChatOptionDrafts, chatOptionSelectModes, setChatOptionSelectModes, onChatOptionCommit,
  showAdvanced = true,
  samplerChain, onSamplerChainChange,
}: Props) {
  return (
    <section className="tuning-section tuning-section--sampling">
      <p className="app-section-hint mb-4">{t("ui.samplingHint")}</p>
      <div className="tuning-field-list"><NumericFieldGrid fields={SAMPLING_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} /></div>

      {showAdvanced && (
        <>
          <div className="mt-4"><TuningDefaultField fieldKey="samplers" label={t("ui.samplerChain")} request>
            <TuningSamplerChain samplers={samplerChain} disabled={disabled} onChange={onSamplerChainChange} />
          </TuningDefaultField></div>
          <details className="mt-5 rounded-lg border border-line-strong/80 bg-surface/40 p-3">
            <summary className="cursor-pointer text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line">{t("extra.moreSampling")}</summary>
            <p className="app-section-hint mb-4 mt-2">{t("ui.advancedSamplingHint")}</p>
            <div className="grid gap-4 app-form-grid tuning-sampling-grid">
              {ADVANCED_SAMPLING_FIELDS.map((field) => (
                <TuningChatOptionField
                  key={field.key}
                  cfg={cfg}
                  field={field}
                  t={t}
                  disabled={disabled}
                  chatOptionDrafts={chatOptionDrafts}
                  setChatOptionDrafts={setChatOptionDrafts}
                  chatOptionSelectModes={chatOptionSelectModes}
                  setChatOptionSelectModes={setChatOptionSelectModes}
                  onCommit={onChatOptionCommit}
                />
              ))}
            </div>
          </details>
        </>
      )}
      <div className="mt-5 text-xs text-muted">{t("extra.savedNextMessage")}</div>
    </section>
  );
}
