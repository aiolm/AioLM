import ModelName from '../../shared/ui/ModelName';
import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { MAX_PROJECT_DOCUMENTS } from "./projectStore";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import EmptyState from "../../shared/ui/EmptyState";
import Badge from "../../shared/ui/Badge";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import * as api from "../../shared/api/index";
import { modelSettingsCopy } from '../model-settings/modelSettingsCopy';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import { providerOf } from '../../shared/api/providers';
import { providerCopy } from '../../shared/i18n/providerCopy';
import { SERVER_OPTIONS } from '../../shared/config/serverOptions';
import { settingDefaultInfo } from '../../shared/config/defaultValueDisplay';
import DefaultValue from '../../shared/ui/DefaultValue';
import { executionText } from '../../shared/i18n/executionI18n';
import type { ProjectsController } from "./useProjectsController";

export default function ProjectsView({ controller }: { controller: ProjectsController }) {
  const {
    t, locale, cfg, projects, activeId, selectedId, selected, name, setName, description, setDescription,
    documents, error, setError, notice, setNotice, pendingSwitch, pendingApply, pendingDelete, importing, exporting,
    displayedProfileName, displayedProfileRevision, displayConfig, displayedPrompt, toolCount, docCount,
    isActiveSelection, serverRunning, busy, save, apply, deactivate, remove, exportSelected, importSelected,
    confirmSaveAndApply, cancelApply,
    openProjectEditor, canOpenProjectEditor, newProject, selectProject, confirmSwitch, cancelSwitch,
    confirmDeletion, cancelDeletion, mcpCatalog, mcpLoading, selectedToolKeys, staleTools,
    loadMcpCatalog, toggleTool, addDocument, removeDocument,
  } = controller;

  return (
    <div className="app-page-scroll projects-page relative flex h-full min-h-0 flex-col">
      <header className="app-page-header">
        <div>
          <h1 className="app-page-title">{t("ui.projectsTitle")}</h1>
          <p className="app-page-description" >{t("ui.projectsDescription")}</p>
        </div>
        <div className="app-page-actions">
          <button type="button" onClick={newProject} className="app-button app-button--primary">{t("panel.newProject")}</button>
          {api.isNativeRuntimeAvailable() ? <button type="button" data-icon="upload" onClick={() => void importSelected()} disabled={importing} className="app-button app-button--secondary">{t("panel.importJson")}</button> : <label data-icon="upload" className="app-button app-button--secondary cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]">
            {t("panel.importJson")}
            <input
              type="file"
              accept="application/json,.json"
              aria-label={t("panel.importJson")}
              className="sr-only"
              onChange={(event) => { void importSelected(event.target.files?.[0]); event.currentTarget.value = ""; }}
            />
          </label>}
        </div>
      </header>
      <PanelFeedback>
        {error && <FeedbackBanner tone="error" title={t("panel.projectActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </PanelFeedback>
      <ConfirmDialog
        open={pendingSwitch !== null}
        title={executionText[locale].unsavedTitle}
        description={executionText[locale].unsavedBody}
        confirmLabel={modelSettingsCopy[locale].discard}
        cancelLabel={modelSettingsCopy[locale].keep}
        onConfirm={confirmSwitch}
        onCancel={cancelSwitch}
      />
      <ConfirmDialog
        open={pendingApply !== null}
        title={t("ui.projectApplyUnsavedTitle")}
        description={t("ui.projectApplyUnsavedBody")}
        confirmLabel={t("ui.saveAndApply")}
        cancelLabel={t("panel.cancel")}
        tone="primary"
        onConfirm={() => void confirmSaveAndApply()}
        onCancel={cancelApply}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("ui.deleteProjectTitle")}
        description={pendingDelete ? t("ui.deleteProjectBody", { name: pendingDelete.name }) : ""}
        confirmLabel={t("panel.deleteProject")}
        onConfirm={confirmDeletion}
        onCancel={cancelDeletion}
      />
      <div className="projects-workspace app-master-detail grid flex-1">
        <aside className="projects-list" aria-labelledby="projects-list-title">
          <div className="projects-list-header">
            <h2 id="projects-list-title" className="app-section-title">{t("ui.savedProjectsCount")}</h2>
            <span className="models-list-count">{projects.length}</span>
          </div>
          <div className="projects-list-items space-y-1">
            {projects.length === 0 && <EmptyState title={t("panel.noProjects")} description={t("ui.projectsEmptyHint")} />}
            {projects.map((project) => <div key={project.id} className={`app-list-row projects-list-row flex items-center justify-between gap-1 ${project.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => selectProject(project)} aria-current={project.id === selectedId ? "true" : undefined} className="app-list-row__action w-full min-w-0 flex-col items-start overflow-hidden"><span className="block w-full max-w-full min-w-0 [overflow-wrap:anywhere] text-xs font-medium ui-color-ink" >{project.name}</span><span className="projects-model-line" ><ModelIcon model={project.config.active_model} /><span><ModelName model={project.config.active_model} empty={t("ui.noModelShort")} /></span></span><ModelBadges mode="compact" model={project.config.active_model} localPath={project.config.active_model} /><span className="mt-0.5 block w-full max-w-full min-w-0 [overflow-wrap:anywhere] text-xs ui-color-faint" >{project.description || t("ui.projectToolsDocsSummary", { tools: project.toolIds.length, docs: project.documentBindings.length })}</span></button>{project.id === activeId && <Badge tone="success" className="shrink-0">{t("ui.active")}</Badge>}</div>)}
          </div>
        </aside>
        <section className="projects-editor" aria-labelledby="project-editor-title">
          <div className="projects-editor-header">
            <h2 id="project-editor-title" className="app-section-title">{selected ? t("ui.projectEditorEdit") : t("ui.projectEditorNew")}</h2>
            {isActiveSelection && <div className="flex flex-wrap items-center gap-2"><Badge tone="success">{t("ui.active")}</Badge><button type="button" onClick={deactivate} className="app-button app-button--ghost app-button--sm">{t("ui.deactivate")}</button></div>}
          </div>
          <div className="grid gap-3 app-form-grid">
            <label className="projects-field" >{t("ui.fieldProjectName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("panel.projectNamePlaceholder")} className="app-input" /></label>
            <label className="projects-field" >{t("ui.fieldDescription")}<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("ui.fieldDescriptionPlaceholder")} className="app-input" /></label>
          </div>
          <h3 className="app-section-title mt-6">{t("ui.projectProfileLabel")}</h3>
          <section aria-label={t("ui.fieldSystemPrompt")} data-testid="project-prompt-preview" className="projects-profile-summary">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium ui-color-ink">
                {displayedProfileName ?? t("ui.projectNoProfile")}
                {displayedProfileName && displayedProfileRevision ? ` · ${t("ui.projectProfileRevision", { revision: displayedProfileRevision })}` : ""}
              </span>
              <button type="button" data-icon="edit" onClick={openProjectEditor} disabled={!canOpenProjectEditor} className="app-button app-button--secondary app-button--sm">{t("ui.projectEditPrompt")}</button>
            </div>
            <dl className="projects-profile-facts">
              <div><dt>{t("ui.fieldModelPath")}</dt><dd className="projects-profile-model-cell" title={normalizeDisplayPath(displayConfig?.active_model ?? '')}><span className="projects-profile-model"><ModelIcon model={displayConfig?.active_model ?? ''} /><span><ModelName model={displayConfig?.active_model} empty={t("load.noModel")} /></span></span><ModelBadges mode="compact" model={displayConfig?.active_model ?? ''} localPath={displayConfig?.active_model ?? ''} /></dd></div>
              <div><dt>{t("ui.fieldBackend")}</dt><dd className="min-w-0 app-text-wrap ui-color-ink"><RuntimeSelectionLabel config={displayConfig} separator=" · " /></dd></div>
              <div><dt>{t("ui.fieldContext")}</dt><dd className="min-w-0 app-text-wrap ui-color-ink">{providerOf(displayConfig ?? {}) !== 'llama.cpp'
                ? providerOf(displayConfig ?? {}) === 'vllm' && typeof displayConfig?.provider_options?.vllm?.max_model_len === 'number' && displayConfig.provider_options.vllm.max_model_len > 0
                  ? displayConfig.provider_options.vllm.max_model_len.toLocaleString() : providerCopy[locale].inherit
                : displayConfig?.runtime_defaults?.includes("ctx_size") ? <DefaultValue info={settingDefaultInfo("ctx_size", SERVER_OPTIONS, false, locale, { selected: true })} /> : displayConfig?.ctx_size.toLocaleString()}</dd></div>
            </dl>
            <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed ui-color-ink">{displayedPrompt || t("ui.projectPromptEmpty")}</p>
            <p className="mt-1 text-xs ui-color-muted">{modelSettingsCopy[locale].projectPromptHint}</p>
          </section>
          <section className="mt-6 border-t pt-4 ui-border-color-border" aria-labelledby="project-workspace-title">
            <h3 id="project-workspace-title" className="app-section-title">{t("panel.chatWorkspace")}</h3>
            <p className="mt-1 text-xs ui-color-muted">{t("ui.projectChatLimitsHint")}</p>
            <div className="projects-workspace-columns">
              <div className="projects-workspace-column">
                <div className="flex items-baseline justify-between gap-2 text-xs ui-color-muted">
                  <span id="project-mcp-heading">{t("ui.fieldToolIds")}</span>
                  <span className="tabular-nums ui-color-faint">{toolCount}</span>
                </div>
                <p className="text-xs ui-color-muted">{t("ui.projectMcpHint")}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" data-icon="refresh" onClick={() => void loadMcpCatalog(false)} disabled={mcpLoading} className="app-button app-button--secondary app-button--sm"><StableLabel value={mcpLoading ? t("ui.projectMcpLoading") : t("ui.projectRefreshTools")} labels={[t("ui.projectMcpLoading"), t("ui.projectRefreshTools")]} /></button>
                </div>
                <div role="group" aria-labelledby="project-mcp-heading" className="projects-selection-list space-y-1">
                  {mcpCatalog.length === 0 && !mcpLoading && <p className="px-1 py-1 text-xs ui-color-faint">{t("ui.projectNoMcpTools")}</p>}
                  {mcpCatalog.map((entry) => {
                    const checked = selectedToolKeys.has(entry.key);
                    const label = `${normalizeDisplayText(entry.serverName)} · ${normalizeDisplayText(entry.toolName)}`;
                    return <label key={entry.key} className="flex max-w-full items-center gap-1.5 px-1 py-1 text-xs ui-color-muted"><input type="checkbox" checked={checked} onChange={() => toggleTool(entry.key)} /><span className="min-w-0 flex-1 app-text-wrap" title={entry.key}>{label}</span></label>;
                  })}
                  {staleTools.map((key) => <label key={key} className="flex max-w-full items-center gap-1.5 px-1 py-1 text-xs ui-color-muted"><input type="checkbox" checked onChange={() => toggleTool(key)} /><span className="min-w-0 flex-1 app-text-wrap" title={key}>{key} · {t("ui.projectUnavailable")}</span></label>)}
                </div>
              </div>
              <div className="projects-workspace-column">
                <div className="flex items-baseline justify-between gap-2 text-xs ui-color-muted">
                  <span id="project-documents-heading">{t("ui.fieldDocuments")}</span>
                  <span className="tabular-nums ui-color-faint">{docCount}/{MAX_PROJECT_DOCUMENTS}</span>
                </div>
                <p className="text-xs ui-color-muted">{t("ui.projectDocumentsHint")}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" data-icon="add" onClick={() => void addDocument()} disabled={docCount >= MAX_PROJECT_DOCUMENTS} className="app-button app-button--secondary app-button--sm">{t("ui.projectAddDocument")}</button>
                </div>
                <div role="group" aria-labelledby="project-documents-heading" className="projects-selection-list space-y-1">
                  {documents.length === 0 && <p className="px-1 py-1 text-xs ui-color-faint">{t("ui.projectNoDocuments")}</p>}
                  {documents.map((document) => <div key={document.path} className="flex items-center justify-between gap-2 px-1 py-1"><span className="min-w-0 flex-1 truncate text-xs ui-color-ink" title={normalizeDisplayPath(document.path)}>{normalizeDisplayText(document.name)} <span className="ui-color-faint">· {normalizeDisplayPath(document.path)}</span></span><button type="button" onClick={() => removeDocument(document.path)} aria-label={t("ui.projectRemoveDocument", { name: document.name })} className="app-icon-button app-icon-button--sm app-icon-button--danger"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}
                </div>
              </div>
            </div>
          </section>
          <section className="mt-6 border-t pt-4 ui-border-color-border" aria-labelledby="project-save-title">
            <h3 id="project-save-title" className="app-section-title">{t("panel.save")} / {t("panel.apply")}</h3>
            <p className="mt-1 text-xs ui-color-muted">{t("ui.projectSaveApplyHint")}</p>
          <div className="projects-editor-actions mt-3">
            <button type="button" onClick={() => save()} disabled={!name.trim() || !cfg} title={!name.trim() ? t("ui.nameRequired") : undefined} className="app-button app-button--primary"><StableLabel value={selected ? t("panel.updateProject") : t("panel.saveProject")} labels={[t("panel.updateProject"), t("panel.saveProject")]} /></button>
            {selected && <><button type="button" data-icon="play" onClick={() => void apply(selected)} disabled={serverRunning || busy} title={serverRunning ? t("ui.stopBeforeApplyProject") : undefined} className="app-button app-button--secondary">{t("panel.applyRuntime")}</button><button type="button" data-icon="download" onClick={() => void exportSelected(selected)} disabled={exporting} className="app-button app-button--secondary">{t("panel.exportJson")}</button><button type="button" data-icon="delete" onClick={() => remove(selected)} className="app-button app-button--danger">{t("panel.delete")}</button></>}
          </div>
            <p className="mt-2 text-xs ui-color-faint">{t("ui.projectsFooter")}</p>
          </section>
        </section>
      </div>
    </div>
  );
}
