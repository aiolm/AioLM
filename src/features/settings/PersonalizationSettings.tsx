import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import StatusBadge from "../../shared/ui/StatusBadge";
import { isNativeRuntimeAvailable } from "../../shared/api/index";
import { PERSONALIZATION_CHANGED_EVENT, isAgentsFileConflict, readAgentsFile, saveAgentsFile, type AgentInstructionsFile, type PersonalizationSource } from "../../shared/api/personalization";
import { useI18n } from "../../shared/i18n/i18n";
import { personalizationText } from "../../shared/i18n/personalizationText";
import { normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import type { AppPreferences } from "../../shared/config/preferences";

// When both files are selected, shared instructions precede AioLM-specific ones.
const sources: { id: PersonalizationSource; file: string }[] = [
  { id: "agents", file: "~/.agents/AGENTS.md" },
  { id: "aiolm", file: "~/.aiolm/AGENTS.md" },
];

type Notice = "saved" | "loadFailed" | "saveFailed" | "conflict";
interface Entry { file: AgentInstructionsFile | null; draft: string; phase: "idle" | "loading" | "saving"; notice: Notice | null; detail: string | null }
const emptyEntry: Entry = { file: null, draft: "", phase: "idle", notice: null, detail: null };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isDirty = (entry: Entry) => entry.file !== null && entry.draft !== entry.file.content;

/**
 * Drafts live with the settings panel rather than the editor view, so changing
 * the settings tab, the search text or the selected file never drops them.
 * Each file has its own request counter: a read or save that finishes after a
 * newer request for that file, or after the user moved to the other file, only
 * ever updates its own file's entry.
 */
export function usePersonalizationEditor() {
  const [source, setSource] = useState<PersonalizationSource>("agents");
  const [entries, setEntries] = useState<Record<PersonalizationSource, Entry>>({ agents: emptyEntry, aiolm: emptyEntry });
  const requests = useRef<Record<PersonalizationSource, number>>({ agents: 0, aiolm: 0 });
  const patch = useCallback((target: PersonalizationSource, next: (entry: Entry) => Partial<Entry>) => {
    setEntries((current) => ({ ...current, [target]: { ...current[target], ...next(current[target]) } }));
  }, []);

  const load = useCallback(async (target: PersonalizationSource) => {
    const request = ++requests.current[target];
    patch(target, () => ({ phase: "loading", notice: null, detail: null }));
    try {
      const file = await readAgentsFile(target);
      if (requests.current[target] === request) patch(target, () => ({ file, draft: file.content, phase: "idle" }));
    } catch (error) {
      if (requests.current[target] === request) patch(target, () => ({ phase: "idle", notice: "loadFailed", detail: errorText(error) }));
    }
  }, [patch]);

  const save = async (target: PersonalizationSource) => {
    const entry = entries[target];
    if (!entry.file || entry.phase !== "idle") return;
    const request = ++requests.current[target];
    patch(target, () => ({ phase: "saving", notice: null, detail: null }));
    try {
      // The loaded revision lets the backend refuse to overwrite an external edit.
      const file = await saveAgentsFile(target, entry.draft, entry.file.revision);
      if (requests.current[target] !== request) return;
      patch(target, () => ({ file, draft: file.content, phase: "idle", notice: "saved" }));
      window.dispatchEvent(new CustomEvent(PERSONALIZATION_CHANGED_EVENT, { detail: { source: target } }));
    } catch (error) {
      if (requests.current[target] !== request) return;
      patch(target, () => isAgentsFileConflict(error)
        ? { phase: "idle", notice: "conflict", detail: null }
        : { phase: "idle", notice: "saveFailed", detail: errorText(error) });
    }
  };

  const edit = (target: PersonalizationSource, draft: string) => patch(target, (entry) => ({ draft, notice: entry.notice === "saved" ? null : entry.notice }));

  return { source, setSource, entries, load, save, edit };
}

export type PersonalizationEditor = ReturnType<typeof usePersonalizationEditor>;

export default function PersonalizationSettings({ editor, query, instructionSources, onInstructionSourcesChange }: {
  editor: PersonalizationEditor; query: string;
  instructionSources: AppPreferences["personalization"]["instructionSources"];
  onInstructionSourcesChange: (sources: AppPreferences["personalization"]["instructionSources"]) => void;
}) {
  const { locale } = useI18n();
  const copy = personalizationText[locale];
  const native = isNativeRuntimeAvailable();
  const { source, setSource, entries, load, save, edit } = editor;
  const entry = entries[source];
  const dirty = isDirty(entry);
  const [confirmReload, setConfirmReload] = useState(false);
  const visible = !query || [copy.title, copy.intro, copy.skillsNote, copy.application, copy.applicationDesc, copy.source, copy.editor, copy.searchTerms].join(" ").toLocaleLowerCase().includes(query);

  // Each file is read the first time it is shown; later visits keep the draft.
  const needsLoad = visible && native && entry.file === null && entry.phase === "idle" && entry.notice === null;
  useEffect(() => { if (needsLoad) void load(source); }, [needsLoad, load, source]);

  if (!visible) return null;
  const intro = <div className="settings-personalization-intro"><p>{copy.intro}</p><p>{copy.skillsNote}</p></div>;
  // Applying a file and choosing which file to edit are separate decisions.
  const application = <fieldset className="settings-subsection" data-setting="" aria-describedby="settings-personalization-apply-description">
    <legend className="settings-subsection-title">{copy.application}</legend>
    <p id="settings-personalization-apply-description" className="settings-subsection-hint">{copy.applicationDesc}</p>
    <div className="settings-personalization-checks">
      {sources.map(({ id, file }) => <label key={id} className="settings-personalization-check">
        <input type="checkbox" checked={instructionSources[id]} onChange={event => onInstructionSourcesChange({ ...instructionSources, [id]: event.target.checked })} />
        <span><span>{id === "agents" ? copy.sourceAgents : copy.sourceAiolm}</span><code>{file}</code></span>
      </label>)}
    </div>
  </fieldset>;
  if (!native) return <div className="settings-personalization">
    {intro}
    {application}
    <div className="settings-subsection" data-setting="">
      <h3 className="settings-subsection-title">{copy.source}</h3>
      <div className="settings-note"><strong>{copy.unavailableTitle}</strong><p>{copy.unavailable}</p></div>
    </div>
  </div>;

  const busy = entry.phase !== "idle";
  const reload = () => { if (dirty) setConfirmReload(true); else void load(source); };
  const notice = entry.notice && {
    saved: { tone: "success" as const, message: copy.savedNotice },
    loadFailed: { tone: "error" as const, message: copy.loadFailed },
    saveFailed: { tone: "error" as const, message: copy.saveFailed },
    conflict: { tone: "warning" as const, message: copy.conflict },
  }[entry.notice];

  return <div className="settings-personalization">
    {intro}
    {application}
    <div className="settings-subsection" data-setting="">
      <fieldset className="settings-personalization-files" aria-describedby="settings-personalization-source-description">
        <legend className="settings-subsection-title">{copy.source}</legend>
        <p id="settings-personalization-source-description" className="settings-subsection-hint">{copy.sourceDesc}</p>
        <div className="settings-personalization-choices">
          {sources.map(({ id, file }) => {
            const label = id === "agents" ? copy.sourceAgents : copy.sourceAiolm;
            return <label key={id} className="settings-personalization-choice">
              <input type="radio" name="settings-personalization-source" value={id} checked={source === id} onChange={() => setSource(id)} />
              <span><span className="settings-personalization-choice-name">{label}{isDirty(entries[id]) && <span className="settings-personalization-dirty" title={copy.unsaved}><span aria-hidden="true"> •</span><span className="sr-only">{`, ${copy.unsaved}`}</span></span>}</span><code>{file}</code></span>
            </label>;
          })}
        </div>
      </fieldset>
      <form className="settings-personalization-editor" aria-busy={busy || undefined} onSubmit={(event) => { event.preventDefault(); void save(source); }}>
        <div className="settings-personalization-file">
          <p className="settings-personalization-path">{copy.path}: {entry.file ? <code>{normalizeDisplayPath(entry.file.path)}</code> : <code>{sources.find(item => item.id === source)!.file}</code>}</p>
          <div className="settings-personalization-state">
            {entry.phase === "loading" && <StatusBadge role="status" label={copy.loading} tone="neutral" />}
            {entry.phase === "saving" && <StatusBadge role="status" label={copy.saving} tone="info" />}
            {!busy && dirty && <StatusBadge label={copy.unsaved} tone="warning" />}
            {!busy && !dirty && entry.file?.exists && <StatusBadge label={copy.saved} tone="neutral" />}
          </div>
          {entry.file && !entry.file.exists && <p className="settings-personalization-hint">{copy.missing}</p>}
        </div>
        {notice && <FeedbackBanner tone={notice.tone}>{entry.detail ? `${notice.message} ${normalizeDisplayText(entry.detail)}` : notice.message}</FeedbackBanner>}
        <label className="settings-personalization-label" htmlFor="settings-personalization-text">{copy.editor}</label>
        <p id="settings-personalization-help" className="settings-personalization-hint">{copy.editorHelp}</p>
        <textarea
          id="settings-personalization-text"
          name="content"
          className="app-textarea settings-personalization-textarea"
          aria-describedby="settings-personalization-help"
          rows={14}
          spellCheck={false}
          value={entry.draft}
          readOnly={busy || entry.file === null}
          onChange={(event) => edit(source, event.target.value)}
        />
        <div className="settings-personalization-actions">
          <button type="submit" className="app-button app-button--primary" data-icon="save" disabled={busy || !dirty}>{entry.phase === "saving" ? copy.saving : copy.save}</button>
          <button type="button" className="app-button app-button--secondary" data-icon="refresh" disabled={busy} onClick={reload}>{copy.reload}</button>
        </div>
      </form>
    </div>
    <ConfirmDialog
      open={confirmReload}
      title={copy.reloadConfirmTitle}
      description={copy.reloadConfirmBody}
      confirmLabel={copy.reloadConfirmAction}
      confirmIcon="refresh"
      onConfirm={() => { setConfirmReload(false); void load(source); }}
      onCancel={() => setConfirmReload(false)}
    />
  </div>;
}
