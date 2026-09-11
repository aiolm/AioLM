import StableLabel from "../../shared/ui/StableLabel";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppStore } from "../../shared/state/store";
import { useI18n } from "../../shared/i18n/i18n";
import { useTuningController } from "./useTuningController";
import TuningNavigation from "./TuningNavigation";
import TuningPresetBar from "./TuningPresetBar";
import { TuningDefaultsContext } from "./TuningDefaultField";
import { TuningOptionsContext } from './TuningOptionMetadata';
import TuningServerSection from "./TuningServerSection";
import TuningReasoningSection from "./TuningReasoningSection";
import TuningSamplingSection from "./TuningSamplingSection";
import TuningEscapeSection from "./TuningEscapeSection";
import TuningServerOptions from './TuningServerOptions';
import { useServerOptions } from './useServerOptions';
import { tuningDisplayConfig } from './tuningResetState';
import { serverOptionMatches } from '../../shared/config/serverOptions';
import { serverOptionsText } from '../../shared/i18n/serverOptionsI18n';
import type { ViewId } from '../../shared/types/navigation';
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
  options: "options",
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
export default function TuningPanel({ store, section = "server", onNavigate }: { store: AppStore; section?: TuningSection; onNavigate?: (view: ViewId) => void }) {
  const { t, locale } = useI18n();
  const runtime = useServerOptions(store.cfg?.active_backend ?? '', store.cfg?.active_build ?? '');
  const tuning = useTuningController(store, runtime.options);
  const cfg = useMemo(() => tuning.cfg ? tuningDisplayConfig(tuning.cfg, runtime.options) : null, [tuning.cfg, runtime.options]);
  const [mode, setMode] = useState<TuningViewMode>("quick");
  const [activeCategory, setActiveCategory] = useState<TuningCategoryId>(SECTION_TO_CATEGORY[section]);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const optionCopy = serverOptionsText[locale];

  const visibleCategories = useMemo(
    () => TUNING_CATEGORIES.map(category => category.id === 'options' ? { ...category, label: optionCopy.title, description: optionCopy.description } : category)
      .filter((category) => (query.trim() || category.modes.includes(mode)) && (category.id === 'options'
        ? !query.trim() || runtime.options.some(option => serverOptionMatches(option, query)) || category.label.includes(query)
        : categoryMatchesSearch(category, query, t))),
    [mode, query, t, optionCopy, runtime.options],
  );
  const selectedCategory = visibleCategories.find((category) => category.id === activeCategory) ?? visibleCategories[0] ?? null;
  useEffect(() => {
    if (!panelRef.current) return;
    panelRef.current.scrollTop = 0;
    const content = panelRef.current.querySelector('.tuning-panel-scroll');
    if (content) content.scrollTop = 0;
  }, [selectedCategory?.id]);

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
    const renderOptions = (memoryOnly = false) => <TuningServerOptions cfg={cfg} runtime={runtime}
      disabled={tuning.configMutationsDisabled} rawDirty={tuning.serverArgsDirty} onSave={tuning.saveServerOption}
      query={memoryOnly ? '' : query} memoryOnly={memoryOnly} onNavigate={onNavigate}
      onCategory={next => { setQuery(''); setMode('advanced'); setActiveCategory(next); }} />;
    if (current === 'options') return renderOptions();
    if (current === "server") {
      const categoryId = category?.id ?? "runtime";
      const fieldMode = query.trim() ? "advanced" : mode;
      const serverFields = categoryId === "speculative"
        ? visibleFields(MTP_FIELDS, categoryId, fieldMode)
        : visibleFields(SERVER_FIELDS, categoryId, fieldMode);
      return (
        <><TuningServerSection
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
        />{categoryId === 'context' && renderOptions(true)}</>
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
    <div ref={panelRef} className="tuning-redesign tuning-panel relative flex h-full min-h-0 flex-col" data-tuning-mode={mode} data-tuning-category={selectedCategory?.id ?? "none"}>
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
                <h2>{selectedCategory.labelKey ? t(`extra.${selectedCategory.labelKey}` as never) : selectedCategory.label}</h2>
                <p>{selectedCategory.descriptionKey ? t(`extra.${selectedCategory.descriptionKey}` as never) : selectedCategory.description}</p>
              </div>
            ) : (
              <div className="tuning-navigation__empty" role="status">{t("extra.noSettingsMatchQuery", { query })}</div>
            )}
            <TuningDefaultsContext.Provider key={tuning.defaultsRevision} value={{ cfg: tuning.cfg!, disabled: tuning.configMutationsDisabled, reset: (key) => void tuning.resetRuntimeDefaults(key) }}>
              <TuningOptionsContext.Provider value={runtime}>
              {renderSection(selectedCategory)}
              </TuningOptionsContext.Provider>
            </TuningDefaultsContext.Provider>
          </div>
        </div>
      </div>
      <footer className="tuning-apply-footer">
        <p>{t("ui.tuningSaveHint")}</p>
        <button type="button" className="app-button app-button--primary" onClick={() => void tuning.applyRestart()} disabled={tuning.configMutationsDisabled || !cfg.active_model || store.status.state !== "running"}>
          <StableLabel value={tuning.phase === "applying" ? t("extra.applying") : t("extra.applyRestart")} labels={[t("extra.applying"), t("extra.applyRestart")]} />
        </button>
      </footer>
    </div>
  );
}
