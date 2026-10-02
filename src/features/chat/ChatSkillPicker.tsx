import { useId, useState } from "react";
import type { ChatSkill } from "../../shared/api/personalization";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import StableLabel from "../../shared/ui/StableLabel";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import type { ChatPersonalizationTextKey } from "../../shared/i18n/chatPersonalizationText";
import { filterSkills } from "./chatPersonalization";

interface ChatSkillPickerProps {
  native: boolean;
  catalog: ChatSkill[];
  warnings: string[];
  loadError: string | null;
  loading: boolean;
  loaded: boolean;
  selectedSkillIds: string[];
  onToggleSkill: (id: string) => void;
  onRefresh: () => void;
  /** Locked while a response or MCP approval is pending. */
  locked: boolean;
  closeLabel: string;
  pt: (key: ChatPersonalizationTextKey, vars?: Record<string, string | number>) => string;
}

/** Searchable multi-select list of local skills; selections apply to the next message only. */
export default function ChatSkillPicker({ native, catalog, warnings, loadError, loading, loaded, selectedSkillIds, onToggleSkill, onRefresh, locked, closeLabel, pt }: ChatSkillPickerProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const hintId = useId();
  const visible = filterSkills(catalog, query);
  const sourceLabel = (skill: ChatSkill) => skill.source === "agents" ? pt("sourceAgents") : pt("sourceAiolm");
  return (
    <details className="chat-mcp-tools chat-skill-picker mt-2 app-card app-card--flush" onToggle={(event) => { if (event.currentTarget.open && !loaded && !loading && native) onRefresh(); }}>
      <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium ui-color-ink">{pt("skills")}{selectedSkillIds.length > 0 ? ` · ${selectedSkillIds.length}` : ""}</summary>
      <div className="chat-mcp-expanded border-t p-3 ui-border-color-border">
        <button type="button" data-icon="close" className="chat-mcp-close app-button app-button--secondary app-button--sm absolute right-2 top-2" onClick={(event) => { const details = event.currentTarget.closest("details"); if (details) { details.open = false; details.querySelector("summary")?.focus(); } }}>{closeLabel}</button>
        <div className="flex flex-wrap items-center gap-2 pr-16">
          <button type="button" data-icon="refresh" onClick={onRefresh} disabled={!native || loading} className="app-button app-button--secondary app-button--sm"><StableLabel value={loading ? pt("loadingSkills") : pt("refreshSkills")} labels={[pt("loadingSkills"), pt("refreshSkills")]} /></button>
        </div>
        <p id={hintId} className="mt-2 text-xs ui-color-faint">{pt("skillsHint")}</p>
        {!native && <FeedbackBanner tone="warning" className="mt-2">{pt("nativeOnly")}</FeedbackBanner>}
        {loadError && <FeedbackBanner tone="error" className="mt-2">{pt("catalogFailed", { error: loadError })}</FeedbackBanner>}
        {warnings.length > 0 && <FeedbackBanner tone="warning" className="mt-2">{pt("instructionWarnings", { warnings: warnings.join(" ") })}</FeedbackBanner>}
        {native && loaded && (
          <>
            <label htmlFor={searchId} className="mt-2 block text-xs ui-color-muted">{pt("searchSkills")}</label>
            <input id={searchId} type="search" className="app-input mt-1" value={query} onChange={(event) => setQuery(event.target.value)} aria-describedby={hintId} />
            {catalog.length === 0
              ? <p className="mt-2 text-xs ui-color-faint" role="status">{pt("noSkills")}</p>
              : visible.length === 0
                ? <p className="mt-2 text-xs ui-color-faint" role="status">{pt("noSkillMatches")}</p>
                : (
                  <fieldset className="chat-mcp-catalog-slot mt-2">
                    <legend className="sr-only">{pt("skills")}</legend>
                    <div className="flex flex-col gap-1.5">
                      {visible.map((skill) => (
                        <label key={skill.id} className="flex max-w-full items-start gap-1.5 text-xs ui-color-muted">
                          <input type="checkbox" className="mt-0.5" checked={selectedSkillIds.includes(skill.id)} onChange={() => onToggleSkill(skill.id)} disabled={locked} />
                          <span className="min-w-0 app-text-wrap">
                            <span className="ui-color-ink">{normalizeDisplayText(skill.name)}</span>
                            <span className="mx-1 opacity-40">·</span>
                            <span>{sourceLabel(skill)}</span>
                            {skill.description && <span className="block ui-color-faint">{normalizeDisplayText(skill.description)}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
          </>
        )}
      </div>
    </details>
  );
}
