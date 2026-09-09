import { useMemo, useState, type ReactNode } from "react";
import type { AppStore } from "../store";
import { useI18n } from "../i18n";
import { useTuningController } from "./useTuningController";
import TuningNavigation from "./TuningNavigation";
import TuningPresetBar from "./TuningPresetBar";
import { TuningDefaultsContext } from "./TuningDefaultField";
import TuningServerSection from "./TuningServerSection";
import TuningReasoningSection from "./TuningReasoningSection";
import TuningSamplingSection from "./TuningSamplingSection";
import TuningEscapeSection from "./TuningEscapeSection";
import {
  MTP_FIELDS,
  SERVER_FIELDS,
  TUNING_CATEGORIES,
  TUNING_CONTENT_PANEL_ID,
  TUNING_FIELD_CATALOG,
  tuningCatalogMatches,
  tuningFieldLabel,
  type TuningCategoryId,
  type TuningSectionId,
  type TuningViewMode,
} from "./tuningFields";

type TuningSection = TuningSectionId;

const SECTION_TO_CATEGORY: Record<TuningSection, TuningCategoryId> = {
  server: "runtime",
  sampling: "sampling",
  reasoning: "reasoning",
  escape: "advanced",
};

function categoryMatchesSearch(category: (typeof TUNING_CATEGORIES)[number], query: string, t: ReturnType<typeof useI18n>["t"]): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const categoryText = `${category.label} ${category.description} ${category.keywords.join(" ")} ${t(`extra.${category.labelKey}` as never)} ${t(`extra.${category.descriptionKey}` as never)}`.toLocaleLowerCase();
  if (categoryText.includes(normalized.toLocaleLowerCase())) return true;
  return TUNING_FIELD_CATALOG
    .filter((entry) => entry.category === category.id)
    .some((entry) => tuningCatalogMatches(entry, normalized) || tuningFieldLabel(t, entry).toLocaleLowerCase().includes(normalized));
}

function visibleFields<T extends { category: TuningCategoryId; advancedOnly?: boolean }>(
  fields: readonly T[], category: TuningCategoryId, mode: TuningViewMode,
): T[] {
  return fields.filter((field) => field.category === category && (mode === "advanced" || !field.advancedOnly));
}

/** Tuning panel: server-side values require restart; sampling applies next chat. */
export default function TuningPanel({ store, section = "server" }: { store: AppStore; section?: TuningSection }) {
  const { t } = useI18n();
  const tuning = useTuningController(store);
  const { cfg } = tuning;
  const [mode, setMode] = useState<TuningViewMode>("quick");
  const [activeCategory, setActiveCategory] = useState<TuningCategoryId>(SECTION_TO_CATEGORY[section]);
  const [query, setQuery] = useState("");

  const visibleCategories = useMemo(
    () => TUNING_CATEGORIES.filter((category) => (query.trim() || category.modes.includes(mode)) && categoryMatchesSearch(category, query, t)),
    [mode, query, t],
  );
  const selectedCategory = visibleCategories.find((category) => category.id === activeCategory) ?? visibleCategories[0] ?? null;

  if (!cfg) {
    return (
      <div className="app-page-scroll tuning-panel flex h-full min-h-0 flex-col p-4">
        <div className="panel-loading" role="status" aria-label={t("extra.loading")}>
          <span className="panel-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  const renderSection = (category: (typeof TUNING_CATEGORIES)[number] | null): ReactNode => {
    const current = category?.section ?? null;
    if (current === "server") {
      const categoryId = category?.id ?? "runtime";
      const fieldMode = query.trim() ? "advanced" : mode;
      const serverFields = categoryId === "speculative"
        ? visibleFields(MTP_FIELDS, categoryId, fieldMode)
        : visibleFields(SERVER_FIELDS, categoryId, fieldMode);
      return (
        <TuningServerSection
          t={t}
          cfg={cfg}
          disabled={tuning.configMutationsDisabled}
          numericDrafts={tuning.numericDrafts}
          onNumericChange={(key, value) => tuning.setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))}
          onNumericCommit={(field, value) => void tuning.commitNumeric(field, value)}
          updateFlash={tuning.updateFlash}
          serverTextValue={tuning.serverTextValue}
          onServerTextChange={(key, value) => tuning.setServerTextDrafts((drafts) => ({ ...drafts, [key]: value }))}
          commitServerText={(key, value) => void tuning.commitServerText(key, value)}
          projectorEditable={tuning.projectorEditable}
          serverSelectValue={tuning.serverSelectValue}
          selectServerText={tuning.selectServerText}
          showAdvanced={mode === "advanced" || !!query.trim()}
          fields={serverFields}
          showFlashAttention={categoryId === "runtime"}
          showProjector={categoryId === "multimodal"}
          showSpeculative={categoryId === "speculative"}
          showCacheTypes={categoryId === "context"}
        />
      );
    }
    if (current === "reasoning") {
      return (
        <TuningReasoningSection
          t={t}
          cfg={cfg}
          disabled={tuning.configMutationsDisabled}
          numericDrafts={tuning.numericDrafts}
          onNumericChange={(key, value) => tuning.setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))}
          onNumericCommit={(field, value) => void tuning.commitNumeric(field, value)}
          updateServerText={tuning.updateServerText}
          updateReasoningEffort={tuning.updateReasoningEffort}
          reasoningBudgetMessageValue={tuning.serverTextValue("reasoning_budget_message")}
          onReasoningBudgetMessageChange={(value) => tuning.setServerTextDrafts((currentDrafts) => ({ ...currentDrafts, reasoning_budget_message: value }))}
          onReasoningBudgetMessageCommit={(value) => void tuning.commitServerText("reasoning_budget_message", value)}
        />
      );
    }
    if (current === "sampling") {
      return (
        <TuningSamplingSection
          t={t}
          cfg={cfg}
          disabled={tuning.configMutationsDisabled}
          numericDrafts={tuning.numericDrafts}
          onNumericChange={(key, value) => tuning.setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))}
          onNumericCommit={(field, value) => void tuning.commitNumeric(field, value)}
          chatOptionDrafts={tuning.chatOptionDrafts}
          setChatOptionDrafts={tuning.setChatOptionDrafts}
          chatOptionSelectModes={tuning.chatOptionSelectModes}
          setChatOptionSelectModes={tuning.setChatOptionSelectModes}
          onChatOptionCommit={(field, value) => void tuning.commitChatOption(field, value)}
          samplerChain={Array.isArray(cfg.chat_options.samplers) ? cfg.chat_options.samplers.filter((value): value is string => typeof value === "string") : []}
          onSamplerChainChange={(samplers) => void tuning.updateSamplerChain(samplers)}
          showAdvanced={mode === "advanced" || !!query.trim()}
        />
      );
    }
    if (current === "escape") {
      return (
        <TuningEscapeSection
          t={t}
          disabled={tuning.configMutationsDisabled}
          advancedError={tuning.advancedError}
          serverArgsDraft={tuning.serverArgsDraft}
          onServerArgsChange={(value) => {
            tuning.serverArgsDraftRef.current = value;
            tuning.setServerArgsDraft(value);
            tuning.setServerArgsDirty(true);
            tuning.setAdvancedError(null);
          }}
          serverArgsDirty={tuning.serverArgsDirty}
          onSaveServerArgs={() => void tuning.saveServerArgs()}
          chatOptionsDraft={tuning.chatOptionsDraft}
          onChatOptionsChange={(value) => {
            tuning.chatOptionsDraftRef.current = value;
            tuning.setChatOptionsDraft(value);
            tuning.setChatOptionsDirty(true);
            tuning.setAdvancedError(null);
          }}
          chatOptionsDirty={tuning.chatOptionsDirty}
          onSaveChatOptions={() => void tuning.saveChatOptions()}
        />
      );
    }
    return null;
  };

  return (
    <div className="tuning-redesign tuning-panel relative flex h-full min-h-0 flex-col" data-tuning-mode={mode} data-tuning-category={selectedCategory?.id ?? "none"}>
      <div className="tuning-redesign__body">
        <TuningNavigation
          categories={visibleCategories}
          activeCategory={selectedCategory?.id ?? activeCategory}
          onSelectCategory={setActiveCategory}
          mode={mode}
          onModeChange={setMode}
          query={query}
          onQueryChange={setQuery}
        />

        <div
          className="tuning-redesign__content"
          id={TUNING_CONTENT_PANEL_ID}
          role="tabpanel"
          aria-labelledby={`tuning-mode-tab-${mode}`}
        >
          <div className="tuning-panel-scroll">
            <TuningPresetBar
              t={t}
              phase={tuning.phase === "dirty" && store.status.state === "stopped" ? "idle" : tuning.phase}
              flash={tuning.flash}
              dismissFlash={tuning.dismissFlash}
              changedServerFields={tuning.changedServerFields}
              relationWarnings={tuning.relationWarnings}
              busy={tuning.configMutationsDisabled}
              pendingBulkChange={tuning.pendingBulkChange}
              setPendingBulkChange={tuning.setPendingBulkChange}
              applyPreset={(name) => void tuning.applyPreset(name)}
              resetDefaults={tuning.resetDefaults}
              profileLabel={tuning.modelProfileName ? t("ui.loadProfileNamed", { profile: tuning.modelProfileName }) : undefined}
              onResetAll={() => tuning.setPendingBulkChange({
                title: t("ui.runtimeDefaultsResetAll"), description: t("ui.runtimeDefaultsConfirm"),
                confirmLabel: t("ui.runtimeDefaultsResetAll"), run: () => void tuning.resetRuntimeDefaults(),
              })}
            />
            {selectedCategory ? (
              <div className="tuning-category-heading">
                <h2>{t(`extra.${selectedCategory.labelKey}` as never) || selectedCategory.label}</h2>
                <p>{t(`extra.${selectedCategory.descriptionKey}` as never) || selectedCategory.description}</p>
              </div>
            ) : (
              <div className="tuning-navigation__empty" role="status">{t("extra.noSettingsMatchQuery", { query })}</div>
            )}
            <TuningDefaultsContext.Provider key={tuning.defaultsRevision} value={{ cfg, disabled: tuning.configMutationsDisabled, reset: (key) => void tuning.resetRuntimeDefaults(key) }}>
              {renderSection(selectedCategory)}
            </TuningDefaultsContext.Provider>
          </div>
        </div>
      </div>
      <footer className="tuning-apply-footer">
        <p>{t("ui.tuningSaveHint")}</p>
        {(store.status.state === "running" || tuning.phase === "applying") && <button type="button" className="app-button app-button--primary" onClick={() => void tuning.applyRestart()} disabled={tuning.configMutationsDisabled || !cfg.active_model}>
          {tuning.phase === "applying" ? t("extra.applying") : t("extra.applyRestart")}
        </button>}
      </footer>
    </div>
  );
}
