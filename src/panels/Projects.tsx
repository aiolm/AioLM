import PanelFeedback from "../components/PanelFeedback";
import StableLabel from "../components/StableLabel";
import { useEffect, useMemo, useState } from "react";
import type { AppStore } from "../store";
import type { AppConfig } from "../api";
import {
  activeProjectId,
  deleteProject,
  exportProject,
  importProject,
  projectConfigPatch,
  projectFromConfig,
  PROJECTS_CHANGED_EVENT,
  readProjects,
  setActiveProjectId,
  upsertProject,
  writeProjects,
  type ProjectPreset,
} from "../projectStore";
import FeedbackBanner from "../components/FeedbackBanner";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { useI18n } from "../i18n";
import { shouldConfirmDestructive } from "../preferences";
import { isServerBusy, normalizeDisplayPath, normalizeDisplayPathLines } from "../lifecycleUtils";


function fileName(project: ProjectPreset): string {
  return `${project.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "aiolm-project"}.json`;
}

export default function ProjectsPanel({ store, onOpenTuning }: { store: AppStore; onOpenTuning?: () => void }) {
  const { t } = useI18n();

  const [projects, setProjects] = useState<ProjectPreset[]>(readProjects);
  const [selectedId, setSelectedId] = useState<string | null>(() => activeProjectId());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
  const [configSnapshot, setConfigSnapshot] = useState<AppConfig | null>(store.cfg);
  const [toolIds, setToolIds] = useState("");
  const [documentPaths, setDocumentPaths] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectPreset | null>(null);

  const cfg = store.cfg;
  // Unlike other panels' "server running" guards, Projects also blocks applying a
  // project while the server is starting/stopping: applying rewrites the server
  // config, and that must wait until the server is fully stopped, not just idle.
  const serverRunning = isServerBusy(store.status.state);
  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId]);

  const loadProject = (project: ProjectPreset | null) => {
    if (!project) {
      setSelectedId(null);
      setName("");
      setDescription("");
      setSystemPrompt("You are a helpful assistant.");
      setConfigSnapshot(cfg ? structuredClone(cfg) : null);
      setToolIds("");
      setDocumentPaths("");
      return;
    }
    setSelectedId(project.id);
    setName(project.name);
    setDescription(project.description);
    setSystemPrompt(project.systemPrompt);
    setConfigSnapshot(cfg ? { ...cfg, ...structuredClone(project.config) } : null);
    setToolIds(project.toolIds.join("\n"));
    setDocumentPaths(project.documentBindings.map((document) => document.path).join("\n"));
  };

  useEffect(() => {
    loadProject(selected);
    // A selection change intentionally rehydrates the editor from the stored preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    const refresh = () => {
      const next = readProjects();
      setProjects(next);
      const active = activeProjectId();
      setSelectedId(active && next.some((project) => project.id === active) ? active : next[0]?.id ?? null);
    };
    window.addEventListener(PROJECTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, refresh);
  }, []);

  const buildConfig = (): AppConfig => {
    if (!configSnapshot && !cfg) throw new Error(t("ui.configLoading"));
    return structuredClone(configSnapshot ?? cfg!);
  };

  const save = () => {
    try {
      const bindings = documentPaths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
      }));
      const project = projectFromConfig(name, systemPrompt, buildConfig(), bindings, toolIds.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean), description);
      const existing = selectedId ? projects.find((item) => item.id === selectedId) : null;
      const saved = existing ? { ...project, id: existing.id, createdAt: existing.createdAt } : project;
      const next = upsertProject(saved, projects);
      writeProjects(next);
      setProjects(next);
      setSelectedId(saved.id);
      setActiveProjectId(saved.id);
      setNotice(t("ui.savedProjectNamed", { name: saved.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
    }
  };

  const apply = async (project: ProjectPreset) => {
    if (serverRunning) {
      setError(t("ui.stopBeforeApplyProject"));
      return;
    }
    try {
      await store.updateConfig(projectConfigPatch(project));
      setActiveProjectId(project.id);
      setNotice(t("ui.appliedProjectNamed", { name: project.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = (project: ProjectPreset) => {
    if (shouldConfirmDestructive()) setPendingDelete(project);
    else confirmRemove(project);
  };

  const confirmRemove = (project: ProjectPreset) => {
    const next = deleteProject(project.id, projects);
    writeProjects(next);
    setProjects(next);
    if (selectedId === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
      setSelectedId(next[0]?.id ?? null);
    }
    setPendingDelete(null);
    setNotice(t("ui.deletedProjectNamed", { name: project.name }));
  };

  const exportSelected = (project: ProjectPreset) => {
    const blob = new Blob([exportProject(project)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName(project);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importSelected = async (file: File | undefined) => {
    if (!file) return;
    try {
      const project = importProject(await file.text());
      const next = upsertProject(project, projects);
      writeProjects(next);
      setProjects(next);
      setSelectedId(project.id);
      setNotice(t("ui.importedProjectNamed", { name: project.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="app-eyebrow">{t("section.projects")}</div>
          <h2 className="mt-1 text-[18px] font-semibold tracking-tight ui-color-ink" >{t("ui.projectsTitle")}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed ui-color-muted" >{t("ui.projectsDescription")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => loadProject(null)} className="app-button app-button--primary app-button--sm">{t("panel.newProject")}</button>
          <label className="app-button app-button--secondary app-button--sm cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]">
            {t("panel.importJson")}
            <input
              type="file"
              accept="application/json,.json"
              aria-label={t("panel.importJson")}
              className="sr-only"
              onChange={(event) => { void importSelected(event.target.files?.[0]); event.currentTarget.value = ""; }}
            />
          </label>
        </div>
      </div>
      <PanelFeedback>
        {error && <FeedbackBanner tone="error" title={t("panel.projectActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </PanelFeedback>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("ui.deleteProjectTitle")}
        description={pendingDelete ? t("ui.deleteProjectBody", { name: pendingDelete.name }) : ""}
        confirmLabel={t("panel.deleteProject")}
        onConfirm={() => { if (pendingDelete) confirmRemove(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />
      <div className="grid shrink-0 items-start gap-4 app-master-detail">
        <aside className="min-w-0 rounded-xl border p-3 ui-border-color-border ui-background-panel" >
          <div className="px-2 py-2 text-xs ui-color-faint" >{t("ui.savedProjectsCount")} · {projects.length}</div>
          <div className="space-y-1 overflow-auto">
            {projects.length === 0 && <EmptyState title={t("panel.noProjects")} description={t("ui.projectsEmptyHint")} />}
            {projects.map((project) => <div key={project.id} className={`app-list-row flex items-center justify-between gap-1 px-1 py-1 ${project.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => setSelectedId(project.id)} aria-current={project.id === selectedId ? "true" : undefined} className="min-w-0 flex-1 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ui-focus)]"><span className="block app-text-wrap text-xs font-medium ui-color-ink" >{project.name}</span><span className="mt-0.5 block app-text-wrap text-xs ui-color-faint" >{normalizeDisplayPath(project.config.active_model).split(/[\\/]/).pop() || t("ui.noModelShort")}</span></button>{project.id === activeProjectId() && <span className="mr-1 rounded-full border px-2 py-0.5 text-xs font-medium ui-border-color-success-border ui-background-success-bg ui-color-success-ink" >{t("ui.active")}</span>}</div>)}
          </div>
        </aside>
        <section className="min-w-0 rounded-xl border p-4 ui-border-color-border ui-background-panel" >
          <div className="grid gap-3 app-form-grid">
            <label className="text-xs ui-color-muted" >{t("ui.fieldProjectName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("panel.projectNamePlaceholder")} className="app-input mt-1" /></label>
            <label className="text-xs ui-color-muted" >{t("ui.fieldDescription")}<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("ui.fieldDescriptionPlaceholder")} className="app-input mt-1" /></label>
          </div>
          <label className="mt-3 block text-xs ui-color-muted" >{t("ui.fieldSystemPrompt")}<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={3} className="app-textarea mt-1" /></label>
          <section className="project-config-snapshot">
            <h3>{t("ui.projectSavedSetup")}</h3>
            <p>{t("ui.projectSnapshotHint")}</p>
            <dl>
              <div><dt>{t("ui.fieldModelPath")}</dt><dd title={normalizeDisplayPath((configSnapshot ?? cfg)?.active_model ?? "")}>{normalizeDisplayPath((configSnapshot ?? cfg)?.active_model ?? "").split(/[\\/]/).pop() || t("load.noModel")}</dd></div>
              <div><dt>{t("ui.fieldBackend")}</dt><dd>{(configSnapshot ?? cfg)?.active_backend || "PATH"} · {(configSnapshot ?? cfg)?.active_build || "system"}</dd></div>
              <div><dt>{t("ui.fieldContext")}</dt><dd>{(configSnapshot ?? cfg)?.runtime_defaults?.includes("ctx_size") ? t("ui.runtimeDefaultShort") : (configSnapshot ?? cfg)?.ctx_size.toLocaleString()}</dd></div>
            </dl>
            <div className="profile-snapshot-actions">
              <button type="button" className="app-button app-button--secondary" disabled={!cfg} onClick={() => { setConfigSnapshot(structuredClone(cfg)); setNotice(t("ui.projectSnapshotCaptured")); }}>{t("ui.useCurrentSetup")}</button>
              {onOpenTuning && <button type="button" className="app-button app-button--ghost" onClick={onOpenTuning}>{t("ui.editTuning")}</button>}
            </div>
          </section>
          <div className="mt-4 border-t pt-3 ui-border-color-border" >
            <h4 className="app-section-title">{t("panel.chatWorkspace")}</h4>
            <div className="mt-3 grid gap-4 app-form-grid">
            <label className="text-xs ui-color-muted" >{t("ui.fieldToolIds")}<textarea value={toolIds} onChange={(event) => setToolIds(event.target.value)} rows={3} placeholder="server-id:tool-name" className="app-textarea mt-1 app-mono text-xs" /></label>
            <label className="text-xs ui-color-muted" >{t("ui.fieldDocuments")}<textarea value={normalizeDisplayPathLines(documentPaths)} onChange={(event) => setDocumentPaths(event.target.value)} rows={3} placeholder="C:\\docs\\project.md" className="app-textarea mt-1 app-mono text-xs" /></label>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button type="button" onClick={save} disabled={!name.trim() || !cfg} title={!name.trim() ? t("ui.nameRequired") : undefined} className="app-button app-button--primary app-button--sm"><StableLabel value={selected ? t("panel.updateProject") : t("panel.saveProject")} labels={[t("panel.updateProject"), t("panel.saveProject")]} /></button>
            {selected && <><button type="button" onClick={() => void apply(selected)} disabled={serverRunning || store.busy} title={serverRunning ? t("ui.stopBeforeApplyProject") : undefined} className="app-button app-button--primary app-button--sm">{t("panel.applyRuntime")}</button><button type="button" onClick={() => exportSelected(selected)} className="app-button app-button--secondary app-button--sm">{t("panel.exportJson")}</button><button type="button" onClick={() => remove(selected)} className="app-button app-button--danger app-button--sm">{t("panel.delete")}</button></>}
          </div>
          <p className="mt-3 text-xs leading-relaxed ui-color-faint" >{t("ui.projectsFooter")}</p>
        </section>
      </div>
    </div>
  );
}
