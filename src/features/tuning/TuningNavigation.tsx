import { useRef, type KeyboardEvent } from "react";
import { useI18n } from "../../shared/i18n/i18n";
import TabNav from "../../shared/ui/TabNav";
import { TUNING_CONTENT_PANEL_ID, type TuningCategory, type TuningCategoryId, type TuningViewMode } from "./tuningFields";

const MODES: readonly TuningViewMode[] = ["quick", "advanced"];

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="8.5" cy="8.5" r="4.5" />
      <path d="m12 12 4 4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

interface Props {
  categories: readonly TuningCategory[];
  activeCategory: TuningCategoryId;
  onSelectCategory: (category: TuningCategoryId) => void;
  mode: TuningViewMode;
  onModeChange: (mode: TuningViewMode) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

/** Tuning navigation shell; the panel supplies field-level slices to each section. */
export default function TuningNavigation({
  categories, activeCategory, onSelectCategory, mode, onModeChange, query, onQueryChange,
}: Props) {
  const { t } = useI18n();
  const categoryRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleCategoryKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % categories.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + categories.length) % categories.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = categories.length - 1;
    else return;
    event.preventDefault();
    onSelectCategory(categories[nextIndex].id);
    categoryRefs.current[nextIndex]?.focus();
  };

  return (
    <aside className="tuning-navigation" aria-label={t("extra.tuningNavigationLabel")}>
      <TabNav
        items={MODES.map((value) => ({ id: value, label: value === "quick" ? t("extra.quickMode") : t("extra.advancedMode") }))}
        active={mode}
        onSelect={onModeChange}
        label={t("extra.tuningDetailLevel")}
        tabId={(value) => `tuning-mode-tab-${value}`}
        panelId={() => TUNING_CONTENT_PANEL_ID}
        className="tuning-navigation__mode"
      />

      <div className="tuning-navigation__search">
        <label className="sr-only" htmlFor="tuning-settings-search">{t("extra.searchTuningSettingsLabel")}</label>
        <span className="tuning-navigation__search-icon" aria-hidden="true"><SearchIcon /></span>
        <input
          id="tuning-settings-search"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("extra.searchSettingsPlaceholder")}
          aria-label={t("extra.searchTuningSettingsLabel")}
          className="app-input"
          data-tuning-search
        />
        {query && (
          <button
            type="button"
            className="tuning-navigation__search-clear app-icon-button app-icon-button--sm"
            aria-label={t("extra.clearTuningSearch")}
            onClick={() => onQueryChange("")}
          >
            <ClearIcon />
          </button>
        )}
      </div>

      <div className="sr-only">{t("extra.categories")}</div>
      <nav className="tuning-navigation__categories" aria-label={t("extra.tuningCategoriesLabel")}>
        {categories.map((category, index) => {
          const isActive = category.id === activeCategory;
          return (
            <button
              key={category.id}
              ref={(el) => { categoryRefs.current[index] = el; }}
              type="button"
              className={`tuning-category-link app-nav-item ${isActive ? "is-active" : ""}`}
              aria-current={isActive ? "true" : undefined}
              aria-controls={TUNING_CONTENT_PANEL_ID}
              tabIndex={isActive ? 0 : -1}
              title={category.descriptionKey ? t(`extra.${category.descriptionKey}` as never) : category.description}
              onClick={() => onSelectCategory(category.id)}
              onKeyDown={(event) => handleCategoryKeyDown(event, index)}
              data-tuning-category={category.id}
            >
              <span className="tuning-category-link__label">{category.labelKey ? t(`extra.${category.labelKey}` as never) : category.label}</span>
              <span className="tuning-category-link__chevron"><ChevronIcon /></span>
            </button>
          );
        })}
        {categories.length === 0 && (
          <p className="tuning-navigation__empty">{t("extra.noMatchingSettings")}</p>
        )}
      </nav>
    </aside>
  );
}

export type { Props as TuningNavigationProps };
