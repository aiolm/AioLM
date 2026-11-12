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
import { useI18n } from "../../shared/i18n/i18n";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { isServerBusy } from "../../shared/lib/serverLifecycle";
import * as api from "../../shared/api/index";
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { profileApplicationConfig, profileSettingsSnapshot, settingsEqual, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { executionSettings } from '../../shared/config/executionSettings';
import { appliedProfile, mergeProfileEditor, profileLibrary } from '../model-settings/profileEditor';
import { useProjectResources } from "./useProjectResources";

function fileName(project: ProjectPreset): string {
  return `${project.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "aiolm-project"}.json`;
}

function currentProjectSetup(store: AppStore) {
  const current = store.getConfig() ?? store.cfg;
  if (!current) return null;
  const resolved = resolveProfileForExecution(current, profileLibrary(current));
  return { config: { ...structuredClone(current), ...profileApplicationConfig(resolved.application) }, application: resolved.application };
}

function projectDraftSignature(name: string, description: string, systemPrompt: string, config: AppConfig | null,
  application: ProfileApplication | undefined, tools: string[], documents: ProjectDocument[]): string {
  return JSON.stringify([name, description, systemPrompt, config ? executionSettings(config) : null, application, tools, documents]);
}

export interface ProjectsPanelProps {
  store: AppStore;
  onOpenTuning?: () => void;
}

export function useProjectsController({ store, onOpenTuning }: ProjectsPanelProps) {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectPreset | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savedDraft, setSavedDraft] = useState('');
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null);
  const latestDraft = useRef({ selectedId, name, description, configSnapshot, systemPrompt, selectedTools, documents });
  latestDraft.current = { selectedId, name, description, configSnapshot, systemPrompt, selectedTools, documents };

  const cfg = store.cfg;
  const storeRef = useRef(store); storeRef.current = store;
  // Unlike other panels' "server running" guards, Projects also blocks applying a
  // project while the server is starting/stopping: applying rewrites the server
  // config, and that must wait until the server is fully stopped, not just idle.
  const serverRunning = isServerBusy(store.status.state);
  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId]);
  const draftSignature = useMemo(
    () => savedDraft === '' ? '' : projectDraftSignature(name, description, systemPrompt, configSnapshot, profileApplication, selectedTools, documents),
    [savedDraft, name, description, systemPrompt, configSnapshot, profileApplication, selectedTools, documents],
  );
  const draftDirty = savedDraft !== '' && savedDraft !== draftSignature;
  const draftDirtyRef = useRef(draftDirty);
  draftDirtyRef.current = draftDirty;

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
      setSavedDraft(projectDraftSignature('', '', setup?.application.system_prompt ?? '', setup?.config ?? null, setup?.application, [], []));
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
    setSavedDraft(projectDraftSignature(project.name, project.description, project.systemPrompt,
      cfg ? { ...cfg, ...project.config } : null, project.profileApplication, project.toolIds, project.documentBindings));
  };
  const loadProjectRef = useRef(loadProject); loadProjectRef.current = loadProject;
  const projectsRef = useRef(projects); projectsRef.current = projects;

  const switchEditor = (action: () => void) => {
    if (pendingSwitch) return;
    const perform = () => {
      try { action(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setNotice(null); }
    };
    if (draftDirtyRef.current) setPendingSwitch(() => perform);
    else perform();
  };

  useEffect(() => {
    loadProjectRef.current(projectsRef.current.find((project) => project.id === selectedId) ?? null);
    // Only selection changes rehydrate the editor; catalog updates preserve edits.
  }, [selectedId]);

  const hydratedNewDraft = useRef(false);
  useEffect(() => {
    if (hydratedNewDraft.current || selectedId || configSnapshot || !cfg) return;
    hydratedNewDraft.current = true;
    const setup = currentProjectSetup(storeRef.current);
    setSystemPrompt(setup?.application.system_prompt ?? '');
    setConfigSnapshot(setup?.config ?? null);
    setProfileApplication(setup?.application);
    setSavedDraft(projectDraftSignature('', '', setup?.application.system_prompt ?? '', setup?.config ?? null, setup?.application, [], []));
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
      setConfigSnapshot(structuredClone(savedConfig)); setSystemPrompt(savedPrompt);
      if (resolved) setProfileApplication(resolved.application);
      setSavedDraft(projectDraftSignature(name, description, savedPrompt, savedConfig, resolved?.application ?? incomingApplication, selectedTools, documents));
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
      const latest = readProjects();
      // Runtime persistence can finish after deletion; preserve that newer
      // project action instead of restoring its removed active pointer.
      if (!latest.some(item => item.id === project.id)) return;
      let projectStateWritten = false;
      if (savedApplication) {
        const application = savedApplication;
        const profileSettings = executionSettings(profileApplicationConfig(application));
        const savedProject = latest.find(item => item.id === project.id);
        if (savedProject && savedProject.config.active_model === project.config.active_model
          && savedProject.systemPrompt === project.systemPrompt && settingsEqual(savedProject.config, project.config)) {
          const next = latest.map(item => item.id === project.id ? {
            ...item, profileApplication: application,
            config: { ...item.config, ...profileSettings }, systemPrompt: application.system_prompt,
          } : item);
          setActiveProjectId(project.id, undefined, next); setProjects(next);
          projectStateWritten = true;
        }
        const draft = latestDraft.current;
        if (draft.selectedId === project.id && draft.configSnapshot?.active_model === project.config.active_model
          && draft.systemPrompt === project.systemPrompt && settingsEqual(draft.configSnapshot, project.config)) {
          setProfileApplication(structuredClone(application));
          setConfigSnapshot(previous => previous ? { ...previous, ...profileSettings } : previous);
          setSystemPrompt(application.system_prompt);
          if (!draftDirtyRef.current) setSavedDraft(projectDraftSignature(draft.name, draft.description, application.system_prompt,
            { ...draft.configSnapshot, ...profileSettings }, application, draft.selectedTools, draft.documents));
        }
      }
      if (!projectStateWritten) setActiveProjectId(project.id);
      setNotice(t("ui.appliedProjectNamed", { name: project.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
    }
  };

  const remove = (project: ProjectPreset) => {
    if (shouldConfirmDestructive()) setPendingDelete(project);
    else confirmRemove(project);
  };

  const confirmRemove = (project: ProjectPreset) => {
    try {
      const next = deleteProject(project.id, projects);
      writeProjects(next, undefined, activeProjectId() === project.id ? null : undefined);
      setProjects(next);
      if (selectedId === project.id) setSelectedId(next[0]?.id ?? null);
      setPendingDelete(null);
      setError(null);
      setNotice(t("ui.deletedProjectNamed", { name: project.name }));
    } catch (cause) {
      setPendingDelete(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
    }
  };

  const exportSelected = async (project: ProjectPreset) => {
    if (exporting) return;
    setExporting(true);
    setNotice(null);
    setError(null);
    try {
      const contents = exportProject(project);
      if (api.isNativeRuntimeAvailable()) {
        if (await api.projectExportJson(contents, fileName(project))) setNotice(t("common.saved"));
        return;
      }
      const blob = new Blob([contents], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      try {
        anchor.href = url;
        anchor.download = fileName(project);
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };

  const importSelected = async (file?: File) => {
    if (importing || (!file && !api.isNativeRuntimeAvailable())) return;
    setImporting(true);
    setNotice(null);
    setError(null);
    try {
      const contents = file ? await file.text() : await api.projectImportJson();
      if (contents === null) return;
      switchEditor(() => {
        const current = readProjects();
        const project = importProject(contents, current);
        const next = upsertProject(project, current);
        writeProjects(next);
        setProjects(next);
        loadProject(project);
        setNotice(t("ui.importedProjectNamed", { name: project.name }));
        setError(null);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  const snapshot = configSnapshot ?? cfg;
  const liveConfig = profileApplication && snapshot ? store.getConfig() ?? snapshot : null;
  const { displayedProfile, displayConfig } = useMemo(() => {
    if (!profileApplication || !snapshot || !liveConfig) return { displayedProfile: undefined, displayConfig: snapshot };
    const displayedProfile = resolveProfileForExecution(snapshot, profileLibrary(liveConfig), profileApplication).application;
    return { displayedProfile, displayConfig: { ...snapshot, ...profileApplicationConfig(displayedProfile) } };
  }, [snapshot, profileApplication, liveConfig]);
  const displayedPrompt = displayedProfile?.system_prompt ?? systemPrompt;
  const displayedProfileName = displayedProfile?.profile_name ?? profileApplication?.profile_name ?? null;
  const displayedProfileRevision = displayedProfile?.profile_revision ?? profileApplication?.profile_revision ?? null;

  const toolCount = selectedTools.length;
  const docCount = documents.length;
  const isActiveSelection = selected ? activeProjectId() === selected.id : false;
  const resources = useProjectResources({ selectedTools, setSelectedTools, setDocuments, setError });

  return {
    ...resources, t, locale, cfg, projects, selectedId, selected, name, setName, description, setDescription,
    documents, error, setError, notice, setNotice, pendingSwitch, pendingDelete, importing, exporting,
    displayedProfileName, displayedProfileRevision, displayConfig, displayedPrompt, toolCount, docCount,
    isActiveSelection, serverRunning, busy: store.busy, save, apply, remove, exportSelected, importSelected,
    openProjectEditor, canOpenProjectEditor: modelSettings ? Boolean(cfg) : Boolean(onOpenTuning),
    newProject: () => switchEditor(() => loadProject(null)),
    selectProject: (project: ProjectPreset) => { if (project.id !== selectedId) switchEditor(() => loadProject(project)); },
    confirmSwitch: () => { const action = pendingSwitch; setPendingSwitch(null); action?.(); },
    cancelSwitch: () => setPendingSwitch(null),
    confirmDeletion: () => { if (pendingDelete) confirmRemove(pendingDelete); },
    cancelDeletion: () => setPendingDelete(null),
  };
}

export type ProjectsController = ReturnType<typeof useProjectsController>;
