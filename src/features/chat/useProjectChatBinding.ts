import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { readDocumentBinding } from "../../shared/api/index";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { activeProjectId, PROJECTS_CHANGED_EVENT, readProjects, type ProjectPreset } from "../projects/projectStore";
import type { ChatWorkspace } from "./chatHistory";
import type { DocumentAttachment } from "./chatUtils";
import { projectChatBindingCopy, projectDocumentBindingError } from "./projectChatBindingCopy";

const MAX_AUTOMATIC_DOCUMENTS = 4;

interface Options {
  workspace: ChatWorkspace;
  setWorkspace: Dispatch<SetStateAction<ChatWorkspace>>;
  documents: DocumentAttachment[];
  setDocuments: Dispatch<SetStateAction<DocumentAttachment[]>>;
  setSelectedTools: (toolIds: string[]) => void;
  composerRevision: number;
  phase: "idle" | "thinking" | "streaming";
  hasPendingTurn: boolean;
  locale: Locale;
}

interface BindingState {
  projectName: string | null;
  loading: boolean;
  error: string | null;
  application?: {
    generation: number;
    documents: DocumentAttachment[];
    owned: DocumentAttachment[];
  };
}

/** Applies a project's first four bindings only to the current idle composer.
 * Document failures are atomic and visible; no partial context is silently sent.
 */
export function useProjectChatBinding(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const generation = useRef(0);
  const reload = useRef<(() => void) | null>(null);
  // Identity identifies only attachments this hook supplied. A manual file with
  // the same path must not be removed or replaced when a project is deactivated.
  const owned = useRef<DocumentAttachment[]>([]);
  const toolContext = useRef('');
  const requestedDefaults = useRef<{ id: string; updatedAt: number } | null>(null);
  const [state, setState] = useState<BindingState>(() => {
    try {
      const id = activeProjectId();
      const project = id ? readProjects().find(item => item.id === id) : null;
      return { projectName: project?.name ?? null,
        loading: !!project?.documentBindings.length && options.phase === "idle" && !options.hasPendingTurn, error: null };
    } catch {
      return { projectName: null, loading: false, error: projectChatBindingCopy[options.locale].projectReadFailed };
    }
  });

  const retryDocuments = useCallback(() => reload.current?.(), []);

  useEffect(() => {
    let mounted = true;
    const load = (event?: Event) => {
      const ownGeneration = ++generation.current;
      const current = latest.current;
      const threadId = current.workspace.activeThreadId;
      const revision = current.composerRevision;
      const isCurrent = () => mounted && generation.current === ownGeneration
        && latest.current.workspace.activeThreadId === threadId
        && latest.current.composerRevision === revision
        && latest.current.phase === "idle" && !latest.current.hasPendingTurn;
      let project: ProjectPreset | null | undefined;
      try {
        const id = activeProjectId();
        project = id ? readProjects().find(item => item.id === id) : null;
      } catch {
        setState({ projectName: null, loading: false, error: projectChatBindingCopy[current.locale].projectReadFailed });
        return;
      }
      if (event?.type === PROJECTS_CHANGED_EVENT) {
        requestedDefaults.current = project ? { id: project.id, updatedAt: project.updatedAt } : null;
      }
      if (current.phase !== "idle" || current.hasPendingTurn) {
        setState({ projectName: project?.name ?? null, loading: false, error: null });
        return;
      }
      if (!project) {
        const previous = owned.current;
        if (previous.length) current.setDocuments(documents => {
          if (!isCurrent()) return documents;
          const kept = documents.filter(document => !previous.includes(document));
          return kept.length === documents.length ? documents : kept;
        });
        owned.current = [];
        toolContext.current = '';
        setState({ projectName: null, loading: false, error: null });
        return;
      }

      const projectName = project.name;
      const prompt = project.systemPrompt;
      const binding = { id: project.id, updatedAt: project.updatedAt };
      const explicit = requestedDefaults.current?.id === binding.id
        && requestedDefaults.current.updatedAt === binding.updatedAt;
      current.setWorkspace(workspace => {
        if (!isCurrent() || workspace.activeThreadId !== threadId) return workspace;
        const thread = workspace.threads.find(thread => thread.id === threadId);
        if (!thread || (!explicit && thread.projectBinding?.id === binding.id
          && thread.projectBinding.updatedAt === binding.updatedAt)) return workspace;
        // Legacy saved conversations already own their instructions. Applying
        // a project explicitly can replace them; reopening Chat cannot.
        const applyPrompt = explicit || !!thread.projectBinding || (!thread.messages.length && !thread.systemPrompt);
        return { ...workspace, threads: workspace.threads.map(thread => thread.id === threadId
          ? { ...thread, ...(applyPrompt ? { systemPrompt: prompt } : {}), projectBinding: binding, updatedAt: Date.now() } : thread) };
      });
      requestedDefaults.current = null;
      const context = JSON.stringify([threadId, binding.id, binding.updatedAt]);
      if (explicit || toolContext.current !== context) {
        current.setSelectedTools(project.toolIds.slice());
        toolContext.current = context;
      }
      setState({ projectName, loading: true, error: null });
      const bindings = project.documentBindings.slice(0, MAX_AUTOMATIC_DOCUMENTS);
      void Promise.all(bindings.map(async binding => {
        try {
          const text = await readDocumentBinding(binding.path);
          return { document: { ...binding, text } as DocumentAttachment, name: binding.name };
        } catch {
          return { document: null, name: binding.name };
        }
      })).then(results => {
        if (!isCurrent()) return;
        const failed = results.filter(result => result.document === null).map(result => result.name);
        if (failed.length) {
          setState({ projectName, loading: false, error: projectDocumentBindingError(latest.current.locale, "failed", failed) });
          return;
        }
        const before = latest.current.documents;
        const manual = before.filter(document => !owned.current.includes(document));
        const loaded = results.flatMap(result => result.document ? [result.document] : []);
        const automatic = loaded.filter(document => !manual.some(item => item.path === document.path));
        if (manual.length + automatic.length > MAX_AUTOMATIC_DOCUMENTS) {
          setState({ projectName, loading: false, error: projectDocumentBindingError(latest.current.locale, "capacity", automatic.map(document => document.name)) });
          return;
        }
        const documents = [...manual, ...automatic];
        // Retain old ownership until the guarded update commits, so rapid
        // deactivation can remove both prior and newly queued automatic files.
        owned.current = [...owned.current, ...automatic];
        latest.current.setDocuments(previous => isCurrent() && previous === before ? documents : previous);
        setState({ projectName, loading: false, error: null,
          application: { generation: ownGeneration, documents, owned: automatic } });
      });
    };
    reload.current = load;
    load();
    window.addEventListener(PROJECTS_CHANGED_EVENT, load);
    return () => {
      mounted = false;
      generation.current += 1;
      if (reload.current === load) reload.current = null;
      window.removeEventListener(PROJECTS_CHANGED_EVENT, load);
    };
  }, [options.workspace.activeThreadId, options.composerRevision, options.phase, options.hasPendingTurn]);

  useEffect(() => {
    const application = state.application;
    if (!application || application.generation !== generation.current) return;
    if (options.documents === application.documents) {
      owned.current = application.owned;
      setState(current => current.application === application ? { ...current, application: undefined } : current);
    } else {
      setState(current => current.application === application
        ? { projectName: current.projectName, loading: false, error: projectChatBindingCopy[latest.current.locale].changed } : current);
    }
  }, [options.documents, state.application]);

  return {
    projectName: state.projectName,
    documentsLoading: state.loading,
    documentsError: state.error ?? (state.application && options.documents !== state.application.documents
      ? projectChatBindingCopy[options.locale].changed : null),
    retryDocuments,
  };
}
