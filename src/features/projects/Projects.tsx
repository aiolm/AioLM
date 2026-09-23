import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppStore } from "../../shared/state/store";
import type { AppConfig } from "../../shared/api/types";
import {
  activeProjectId,
  deleteProject,
  exportProject,
  importProject,
  MAX_PROJECT_DOCUMENTS,
  MAX_PROJECT_TOOLS,
  projectConfigPatch,
  projectFromConfig,
  PROJECTS_CHANGED_EVENT,
  readProjects,
  setActiveProjectId,
  upsertProject,
  writeProjects,
  type ProjectDocument,
  type ProjectPreset,
} from "./projectStore";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import EmptyState from "../../shared/ui/EmptyState";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { useI18n } from "../../shared/i18n/i18n";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { isServerBusy } from "../../shared/lib/serverLifecycle";
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import * as api from "../../shared/api/index";
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { profileApplicationConfig, profileSettingsSnapshot, settingsEqual, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { executionSettings } from '../../shared/config/executionSettings';
import { appliedProfile, mergeProfileEditor, profileLibrary } from '../model-settings/profileEditor';
import { modelSettingsCopy } from '../model-settings/modelSettingsCopy';
import { runtimeVersionLabel, useInstalledRuntimes } from '../../shared/runtime/installedRuntimes';


function fileName(project: ProjectPreset): string {
  return `${project.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "aiolm-project"}.json`;
}

function currentProjectSetup(store: AppStore) {
  const current = store.getConfig() ?? store.cfg;
  if (!current) return null;
  const resolved = resolveProfileForExecution(current, profileLibrary(current));
  return { config: { ...structuredClone(current), ...profileApplicationConfig(resolved.application) }, application: resolved.application };
}

export default function ProjectsPanel({ store, onOpenTuning }: { store: AppStore; onOpenTuning?: () => void }) {
  const installedRuntimes = useInstalledRuntimes();
  const { t, locale } = useI18n();
  const modelSettings = useModelSettings();
  const guard = useDraftGuard();

  const [projects, setProjects] = useState<ProjectPreset[]>(readProjects);
  const [selectedId, setSelectedId] = useState<string | null>(() => activeProjectId());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState('');
  const [configSnapshot, setConfigSnapshot] = useState<AppConfig | null>(null);
  const [profileApplication, setProfileApplication] = useState<ProfileApplication | undefined>(undefined);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<{ serverId: string; serverName: string; toolName: string; key: string }[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectPreset | null>(null);
  const latestDraft = useRef({ selectedId, configSnapshot, systemPrompt });
  latestDraft.current = { selectedId, configSnapshot, systemPrompt };

  const cfg = store.cfg;
  // Unlike other panels' "server running" guards, Projects also blocks applying a
  // project while the server is starting/stopping: applying rewrites the server
  // config, and that must wait until the server is fully stopped, not just idle.
  const serverRunning = isServerBusy(store.status.state);
  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId]);

  const loadProject = (project: ProjectPreset | null) => {
    if (!project) {
      const setup = currentProjectSetup(store);
      setSelectedId(null);
      setName("");
      setDescription("");
      setSystemPrompt(setup?.application.system_prompt ?? '');
      setConfigSnapshot(setup?.config ?? null);
      setProfileApplication(setup?.application);
      setSelectedTools([]);
      setDocuments([]);
      return;
    }
    setSelectedId(project.id);
    setName(project.name);
    setDescription(project.description);
    setSystemPrompt(project.systemPrompt);
    setConfigSnapshot(cfg ? { ...cfg, ...structuredClone(project.config) } : null);
    setProfileApplication(project.profileApplication ? structuredClone(project.profileApplication) : undefined);
    setSelectedTools([...project.toolIds]);
    setDocuments(project.documentBindings.map((document) => ({ ...document })));
  };

  useEffect(() => {
    loadProject(projects.find((project) => project.id === selectedId) ?? null);
    // A selection change intentionally rehydrates the editor from the stored preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const hydratedNewDraft = useRef(false);
  useEffect(() => {
    if (hydratedNewDraft.current || selectedId || configSnapshot || !cfg) return;
    hydratedNewDraft.current = true;
    const setup = currentProjectSetup(store);
    setSystemPrompt(setup?.application.system_prompt ?? '');
    setConfigSnapshot(setup?.config ?? null);
    setProfileApplication(setup?.application);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, selectedId, configSnapshot]);

  useEffect(() => {
    const refresh = () => {
      const next = readProjects();
      setProjects(next);
      setSelectedId((previous) => {
        if (previous && next.some((project) => project.id === previous)) return previous;
        if (previous === null) return null;
        const active = activeProjectId();
        return active && next.some((project) => project.id === active) ? active : next[0]?.id ?? null;
      });
    };
    window.addEventListener(PROJECTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, refresh);
  }, []);

  const buildConfig = (): AppConfig => {
    if (!configSnapshot && !cfg) throw new Error(t("ui.configLoading"));
    return structuredClone(configSnapshot ?? cfg!);
  };

  const openModelSettings = (section: 'model' | 'runtime') => {
    if (!modelSettings || !cfg) return;
    const config = buildConfig();
    const library = profileLibrary(store.getConfig() ?? cfg);
    const resolved = profileApplication ? resolveProfileForExecution(config, library, profileApplication) : undefined;
    modelSettings.open({
      target: { kind: 'project', id: selectedId ?? 'new' },
      config: resolved ? { ...config, ...profileApplicationConfig(resolved.application) } : config,
      systemPrompt: resolved?.application.system_prompt ?? systemPrompt, section,
      application: resolved?.application,
      onApply: (next, application?: ProfileApplication) => {
        setConfigSnapshot(structuredClone(next));
        setProfileApplication(application ? structuredClone(application) : undefined);
        if (application) setSystemPrompt(application.system_prompt);
      },
    });
  };

  const openProjectEditor = () => {
    if (modelSettings) openModelSettings("model");
    else onOpenTuning?.();
  };

  const save = () => {
    try {
      const bindings = documents.slice(0, MAX_PROJECT_DOCUMENTS).map((document) => ({
        path: document.path,
        name: document.name || document.path.split(/[\\/]/).pop() || document.path,
      }));
      const config = buildConfig();
      const incomingApplication = profileApplication;
      const resolved = incomingApplication ? resolveProfileForExecution(config, profileLibrary(store.getConfig() ?? config), incomingApplication) : undefined;
      const savedConfig = resolved ? { ...config, ...profileApplicationConfig(resolved.application) } : config;
      const savedPrompt = resolved?.application.system_prompt ?? systemPrompt;
      const project = projectFromConfig(name, savedPrompt, savedConfig, bindings, selectedTools.slice(0, MAX_PROJECT_TOOLS), description, Date.now(), resolved?.application ?? incomingApplication);
      const existing = selectedId ? projects.find((item) => item.id === selectedId) : null;
      const saved = existing ? { ...project, id: existing.id, createdAt: existing.createdAt } : project;
      const next = upsertProject(saved, projects);
      writeProjects(next);
      setProjects(next);
      setSelectedId(saved.id);
      setActiveProjectId(saved.id);
      setConfigSnapshot(structuredClone(savedConfig)); setSystemPrompt(savedPrompt);
      if (resolved) setProfileApplication(resolved.application);
      setNotice(t(incomingApplication?.profile_id && !project.profileApplication ? "ui.projectProfileUnlinked" : "ui.savedProjectNamed", { name: saved.name }));
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
      let savedApplication: ProfileApplication | undefined;
      const applied = await guard.run(async () => {
        const saved = await store.updateConfig(current => {
          const patch = projectConfigPatch(project);
          const target = { ...current, ...patch };
          const library = profileLibrary(current);
          const resolved = resolveProfileForExecution(target, library, {
            ...project.profileApplication, model: target.active_model,
            settings: profileSettingsSnapshot(target), system_prompt: project.systemPrompt,
          });
          return { ...patch, ...executionSettings(profileApplicationConfig(resolved.application)), settings_profiles: mergeProfileEditor(current, {
            baseRevision: library.revision, library: resolved.library, application: resolved.application,
          }, 'default') };
        });
        savedApplication = appliedProfile(saved);
      });
      if (!applied) return;
      if (savedApplication) {
        const application = savedApplication;
        const profileSettings = executionSettings(profileApplicationConfig(application));
        const latest = readProjects();
        const savedProject = latest.find(item => item.id === project.id);
        if (savedProject && savedProject.config.active_model === project.config.active_model
          && savedProject.systemPrompt === project.systemPrompt && settingsEqual(savedProject.config, project.config)) {
          const next = latest.map(item => item.id === project.id ? {
            ...item, profileApplication: application,
            config: { ...item.config, ...profileSettings }, systemPrompt: application.system_prompt,
          } : item);
          writeProjects(next); setProjects(next);
        }
        const draft = latestDraft.current;
        if (draft.selectedId === project.id && draft.configSnapshot?.active_model === project.config.active_model
          && draft.systemPrompt === project.systemPrompt && settingsEqual(draft.configSnapshot, project.config)) {
          setProfileApplication(structuredClone(application));
          setConfigSnapshot(previous => previous ? { ...previous, ...profileSettings } : previous);
          setSystemPrompt(application.system_prompt);
        }
      }
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
    if (activeProjectId() === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
    }
    if (selectedId === project.id) {
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
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
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

  const snapshot = configSnapshot ?? cfg;
  const displayedProfile = profileApplication && snapshot
    ? resolveProfileForExecution(snapshot, profileLibrary(store.getConfig() ?? snapshot), profileApplication).application : undefined;
  const displayConfig = displayedProfile && snapshot ? { ...snapshot, ...profileApplicationConfig(displayedProfile) } : snapshot;
  const displayedPrompt = displayedProfile?.system_prompt ?? systemPrompt;
  const displayedProfileName = displayedProfile?.profile_name ?? profileApplication?.profile_name ?? null;
  const displayedProfileRevision = displayedProfile?.profile_revision ?? profileApplication?.profile_revision;

  const toolCount = selectedTools.length;
  const docCount = documents.length;
  const isActiveSelection = selected ? activeProjectId() === selected.id : false;
  const catalogKeys = new Set(mcpCatalog.map((entry) => entry.key));
  const staleTools = selectedTools.filter((key) => !catalogKeys.has(key));

  const loadMcpCatalog = async (silent: boolean) => {
    if (mcpLoading) return;
    setMcpLoading(true);
    try {
      const servers = await api.mcpListServers();
      const entries: { serverId: string; serverName: string; toolName: string; key: string }[] = [];
      for (const server of servers.filter((item) => item.enabled)) {
        const tools = await api.mcpListTools(server.id);
        for (const tool of tools) entries.push({ serverId: server.id, serverName: server.name, toolName: tool.name, key: `${server.id}:${tool.name}` });
      }
      setMcpCatalog(entries);
      if (!silent) setError(null);
    } catch (caught) {
      if (!silent) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMcpLoading(false);
    }
  };

  useEffect(() => {
    void loadMcpCatalog(true);
    // Load the registered MCP catalog once for the checkbox list; failures stay silent until an explicit refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTool = (key: string) => {
    setSelectedTools((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key].slice(0, MAX_PROJECT_TOOLS));
  };

  const addDocument = async () => {
    try {
      const path = await api.pickDocument();
      if (!path) return;
      const name = path.split(/[\\/]/).pop() || path;
      setDocuments((current) => {
        if (current.some((document) => document.path === path)) return current;
        if (current.length >= MAX_PROJECT_DOCUMENTS) return current;
        return [...current, { name, path }];
      });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const removeDocument = (path: string) => {
    setDocuments((current) => current.filter((document) => document.path !== path));
  };

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-1 text-[18px] font-semibold tracking-tight ui-color-ink" >{t("ui.projectsTitle")}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed ui-color-muted" >{t("ui.projectsDescription")}</p>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed ui-color-faint" >{t("ui.projectWorkflow")}</p>
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
        <aside className="min-w-0 app-card app-card--tight" >
          <div className="px-2 py-2 text-xs ui-color-faint" >{t("ui.savedProjectsCount")} · {projects.length}</div>
          <div className="space-y-1 overflow-auto">
            {projects.length === 0 && <EmptyState title={t("panel.noProjects")} description={t("ui.projectsEmptyHint")} />}
            {projects.map((project) => <div key={project.id} className={`app-list-row flex items-center justify-between gap-1 px-1 py-1 ${project.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => setSelectedId(project.id)} aria-current={project.id === selectedId ? "true" : undefined} className="min-w-0 flex-1 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ui-focus)]"><span className="block app-text-wrap text-xs font-medium ui-color-ink" >{project.name}</span><span className="mt-0.5 block app-text-wrap text-xs ui-color-faint" ><ModelIcon model={project.config.active_model} />{modelDisplayName(project.config.active_model) || t("ui.noModelShort")}</span><ModelBadges model={project.config.active_model} localPath={project.config.active_model} /><span className="mt-0.5 block app-text-wrap text-xs ui-color-faint" >{project.description || `tools ${project.toolIds.length} · docs ${project.documentBindings.length}`}</span></button>{project.id === activeProjectId() && <span className="mr-1 rounded-full border px-2 py-0.5 text-xs font-medium ui-border-color-success-border ui-background-success-bg ui-color-success-ink" >{t("ui.active")}</span>}</div>)}
          </div>
        </aside>
        <section className="min-w-0 app-card" >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold ui-color-ink">{selected ? t("ui.projectEditorEdit") : t("ui.projectEditorNew")}</h3>
            {isActiveSelection && <span className="rounded-full border px-2 py-0.5 text-xs font-medium ui-border-color-success-border ui-background-success-bg ui-color-success-ink">{t("ui.active")}</span>}
          </div>
          <h4 className="app-section-title">1 · {t("ui.fieldProjectName")} / {t("ui.fieldDescription")}</h4>
          <div className="mt-2 grid gap-3 app-form-grid">
            <label className="text-xs ui-color-muted" >{t("ui.fieldProjectName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("panel.projectNamePlaceholder")} className="app-input mt-1" /></label>
            <label className="text-xs ui-color-muted" >{t("ui.fieldDescription")}<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("ui.fieldDescriptionPlaceholder")} className="app-input mt-1" /></label>
          </div>
          <h4 className="app-section-title mt-4">2 · {t("ui.projectProfileLabel")}</h4>
          <section aria-label={t("ui.fieldSystemPrompt")} data-testid="project-prompt-preview" className="mt-2 rounded-xl border px-3 py-2.5 ui-border-color-border ui-background-surface-muted">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium ui-color-ink">
                {displayedProfileName ?? t("ui.projectNoProfile")}
                {typeof displayedProfileRevision === "number" ? <span className="ml-1 ui-color-faint">r{displayedProfileRevision}</span> : null}
              </span>
              <button type="button" onClick={openProjectEditor} disabled={modelSettings ? !cfg : !onOpenTuning} className="app-button app-button--secondary app-button--sm">{t("ui.projectEditPrompt")}</button>
            </div>
            <dl className="mt-2 space-y-1 text-xs">
              <div className="flex gap-2"><dt className="w-20 shrink-0 ui-color-muted">{t("ui.fieldModelPath")}</dt><dd className="min-w-0 flex-1 truncate ui-color-ink" title={normalizeDisplayPath(displayConfig?.active_model ?? '')}><ModelIcon model={displayConfig?.active_model ?? ''} />{modelDisplayName(displayConfig?.active_model ?? '') || t("load.noModel")}<ModelBadges model={displayConfig?.active_model ?? ''} localPath={displayConfig?.active_model ?? ''} /></dd></div>
              <div className="flex gap-2"><dt className="w-20 shrink-0 ui-color-muted">{t("ui.fieldBackend")}</dt><dd className="ui-color-ink">{displayConfig?.active_backend || "PATH"} · {displayConfig?.active_build ? runtimeVersionLabel(installedRuntimes, displayConfig.active_backend, displayConfig.active_build) : "system"}</dd></div>
              <div className="flex gap-2"><dt className="w-20 shrink-0 ui-color-muted">{t("ui.fieldContext")}</dt><dd className="ui-color-ink">{displayConfig?.runtime_defaults?.includes("ctx_size") ? t("ui.runtimeDefaultShort") : displayConfig?.ctx_size.toLocaleString()}</dd></div>
            </dl>
            <p className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed ui-color-ink">{displayedPrompt || t("ui.projectPromptEmpty")}</p>
            <p className="mt-1 text-xs ui-color-muted">{modelSettingsCopy[locale].projectPromptHint}</p>
          </section>
          <div className="mt-4 border-t pt-3 ui-border-color-border" >
            <h4 className="app-section-title">3 · {t("panel.chatWorkspace")}</h4>
            <p className="mt-1 text-xs ui-color-muted">{t("ui.projectChatLimitsHint")}</p>
            <div className="mt-3 grid gap-4 app-form-grid">
              <div className="flex min-w-0 flex-col">
                <div className="flex items-baseline justify-between gap-2 text-xs ui-color-muted">
                  <span id="project-mcp-heading">{t("ui.fieldToolIds")}</span>
                  <span className="ui-color-faint">{toolCount}</span>
                </div>
                <p className="mt-1 min-h-8 text-xs ui-color-muted">{t("ui.projectMcpHint")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void loadMcpCatalog(false)} disabled={mcpLoading} className="app-button app-button--secondary app-button--sm">{mcpLoading ? t("ui.projectMcpLoading") : t("ui.projectRefreshTools")}</button>
                </div>
                <div role="group" aria-labelledby="project-mcp-heading" className="mt-2 max-h-48 flex-1 space-y-1 overflow-auto rounded-lg border px-2 py-2 ui-border-color-border">
                  {mcpCatalog.length === 0 && !mcpLoading && <p className="px-1 py-1 text-xs ui-color-faint">{t("ui.projectNoMcpTools")}</p>}
                  {mcpCatalog.map((entry) => {
                    const checked = selectedTools.includes(entry.key);
                    const label = `${normalizeDisplayText(entry.serverName)} · ${normalizeDisplayText(entry.toolName)}`;
                    return <label key={entry.key} className="flex max-w-full items-center gap-1.5 text-xs ui-color-muted"><input type="checkbox" checked={checked} onChange={() => toggleTool(entry.key)} className="ui-accent-color-accent-solid" /><span className="max-w-52 app-text-wrap" title={entry.key}>{label}</span></label>;
                  })}
                  {staleTools.map((key) => <label key={key} className="flex max-w-full items-center gap-1.5 text-xs ui-color-muted"><input type="checkbox" checked onChange={() => toggleTool(key)} className="ui-accent-color-accent-solid" /><span className="max-w-52 app-text-wrap" title={key}>{key} · {t("ui.projectUnavailable")}</span></label>)}
                </div>
              </div>
              <div className="flex min-w-0 flex-col">
                <div className="flex items-baseline justify-between gap-2 text-xs ui-color-muted">
                  <span id="project-documents-heading">{t("ui.fieldDocuments")}</span>
                  <span className="ui-color-faint">{docCount}/{MAX_PROJECT_DOCUMENTS}</span>
                </div>
                <p className="mt-1 min-h-8 text-xs ui-color-muted">{t("ui.projectDocumentsHint")}</p>
                <div className="mt-2">
                  <button type="button" onClick={() => void addDocument()} disabled={docCount >= MAX_PROJECT_DOCUMENTS} className="app-button app-button--secondary app-button--sm">{t("ui.projectAddDocument")}</button>
                </div>
                <div role="group" aria-labelledby="project-documents-heading" className="mt-2 max-h-48 flex-1 space-y-1 overflow-auto rounded-lg border px-2 py-2 ui-border-color-border">
                  {documents.length === 0 && <p className="px-1 py-1 text-xs ui-color-faint">{t("ui.projectNoDocuments")}</p>}
                  {documents.map((document) => <div key={document.path} className="flex items-center justify-between gap-2 px-1 py-1"><span className="min-w-0 flex-1 truncate text-xs ui-color-ink" title={document.path}>{normalizeDisplayText(document.name)} <span className="ui-color-faint">· {normalizeDisplayPath(document.path)}</span></span><button type="button" onClick={() => removeDocument(document.path)} aria-label={t("ui.projectRemoveDocument", { name: document.name })} className="app-button app-button--ghost app-button--sm">×</button></div>)}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 border-t pt-3 ui-border-color-border" >
            <h4 className="app-section-title">4 · {t("panel.save")} / {t("panel.apply")}</h4>
            <p className="mt-1 text-xs ui-color-muted">{t("ui.projectSaveApplyHint")}</p>
          <div className="mt-2 flex flex-wrap gap-2.5">
            <button type="button" onClick={save} disabled={!name.trim() || !cfg} title={!name.trim() ? t("ui.nameRequired") : undefined} className="app-button app-button--primary app-button--sm"><StableLabel value={selected ? t("panel.updateProject") : t("panel.saveProject")} labels={[t("panel.updateProject"), t("panel.saveProject")]} /></button>
            {selected && <><button type="button" onClick={() => void apply(selected)} disabled={serverRunning || store.busy} title={serverRunning ? t("ui.stopBeforeApplyProject") : undefined} className="app-button app-button--secondary app-button--sm">{t("panel.applyRuntime")}</button><button type="button" onClick={() => exportSelected(selected)} className="app-button app-button--secondary app-button--sm">{t("panel.exportJson")}</button><button type="button" onClick={() => remove(selected)} className="app-button app-button--danger app-button--sm">{t("panel.delete")}</button></>}
          </div>
            <p className="mt-2 text-xs ui-color-faint">{t("ui.projectsFooter")}</p>
          </div>
        </section>
      </div>
    </div>
  );
}
