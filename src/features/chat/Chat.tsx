import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { activeProjectId, PROJECTS_CHANGED_EVENT, readProjects } from "../projects/projectStore";
import type { DocumentAttachment } from "./chatUtils";
import type { AppPreferences } from "../../shared/config/preferences";
import { useI18n } from "../../shared/i18n/i18n";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import { isServerRunning } from "../../shared/lib/serverLifecycle";
import { normalizeDisplayPath } from "../../shared/lib/displayPaths";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { useChatThreads } from "./useChatThreads";
import { useChatAttachments } from "./useChatAttachments";
import { useChatMcpTools } from "./useChatMcpTools";
import { useChatSend } from "./useChatSend";
import ChatThreadSidebar from "./ChatThreadSidebar";
import ChatConversationHeader from "./ChatConversationHeader";
import ChatMessageLog from "./ChatMessageLog";
import ChatComposer from "./ChatComposer";
import { SESSION_STATUS_CHANGED_EVENT, notifySessionStatusChanged, sessionConfig, sessionDefinitionFromStatus } from "../../shared/runtime/sessionUtils";
import { anySessionActivity, sessionHasActivity } from "../../shared/state/sessionActivity";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { prepareSessionProfile } from "../model-settings/prepareSessionProfile";
import { modelSettingsCopy } from "../model-settings/modelSettingsCopy";
import { titleFromMessage } from "./chatHistory";

export default function ChatPanel({ store, preferences, onOpenModels, onOpenDiagnostics, active = true }: { store: AppStore; preferences?: AppPreferences; onOpenModels?: () => void; onOpenDiagnostics?: () => void; active?: boolean }) {
  const { t, locale } = useI18n();
  const modelSettings = useModelSettings();
  const ct = (key: ChatTextKey) => t(`chat.${key}`);
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState("default");
  const [startingSession, setStartingSession] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let refreshing = false;
    const refreshSessions = () => {
      if (refreshing) return;
      refreshing = true;
      void api.sessionList().then(api.normalizeSessionList).then((items) => {
        if (!cancelled) {
          setSessions(items.filter((item) => item.id !== "default"));
          setSessionsLoaded(true);
        }
      }).catch(() => {
        if (!cancelled) {
          setSessionsLoaded(true);
        }
      }).finally(() => { refreshing = false; });
    };
    refreshSessions();
    const interval = window.setInterval(refreshSessions, 3000);
    window.addEventListener(SESSION_STATUS_CHANGED_EVENT, refreshSessions);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(SESSION_STATUS_CHANGED_EVENT, refreshSessions);
    };
  }, [active]);

  const savedSessions = store.cfg?.sessions ?? [];
  const availableSessions = [
    ...sessions,
    ...savedSessions.filter((definition) => !sessions.some((session) => session.id === definition.id)).map((definition): api.SessionStatus => ({
      id: definition.id, name: definition.name, state: "stopped", model: definition.models.primary_model,
      mmproj: definition.models.mmproj, draft_model: definition.models.draft_model,
    })),
  ];
  const selectedSession = selectedSessionId === "default" ? null : availableSessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedDefinition = savedSessions.find((definition) => definition.id === selectedSessionId)
    ?? (selectedSession && store.cfg ? sessionDefinitionFromStatus(selectedSession, store.cfg) : undefined);
  const selectedSessionAvailable = selectedSessionId === "default" || selectedSession !== null;

  useEffect(() => {
    if (sessionsLoaded && !selectedSessionAvailable) setSelectedSessionId("default");
  }, [sessionsLoaded, selectedSessionAvailable]);

  const selectedStatus = selectedSession ?? store.status;
  const serverOn = isServerRunning(selectedStatus.state);
  const visionReady = serverOn && !!selectedStatus.mmproj;

  const { attachments, documents, attachmentStatus, setAttachments, setDocuments, addAttachment, removeAttachment, removeDocument, clearComposerAttachments } = useChatAttachments({ visionReady, setError: (message) => setError(message) });
  const { mcpCatalog, selectedMcpTools, setSelectedMcpTools, loadingMcpTools, refreshMcpTools, toggleMcpTool, mcpEntryByFunctionName, mcpDefinitions } = useChatMcpTools({ setError: (message) => setError(message) });

  const requireIdle = () => {
    if (phase === "idle" && !pendingToolCall) return true;
    setError("Stop the current response first.");
    return false;
  };

  const resetComposer = () => {
    setInput("");
    clearComposerAttachments();
    resetChatState();
  };

  const {
    workspace, setWorkspace, activeThread, msgs, setMsgs, viewMessages, viewingLiveThread,
    threadQuery, setThreadQuery, threadPanelOpen, setThreadPanelOpen,
    pendingDelete, setPendingDelete, visibleThreads,
    selectThread, newThread, deleteThread, performDeleteThread, updateActiveThread,
  } = useChatThreads({ phase, requireIdle, onSwitchThread: resetComposer });

  const baseUrl = serverOn && selectedStatus.url ? selectedStatus.url : null;
  const apiKey = serverOn ? selectedStatus.api_key ?? "" : "";
  const targetConfig = store.cfg && selectedDefinition ? sessionConfig(store.cfg, selectedDefinition) : store.cfg;
  const configuredModel = selectedDefinition?.models.primary_model ?? (selectedSessionId === "default" ? store.cfg?.active_model ?? "" : selectedStatus.model ?? "");
  const model = serverOn ? selectedStatus.model || configuredModel : selectedSessionId === 'default' ? '' : configuredModel;
  const effectiveConfig = targetConfig
    ? modelSettings?.getRequestConfig(selectedSessionId, targetConfig, selectedStatus)
      ?? { ...targetConfig, ...(serverOn ? selectedStatus.execution : {}), active_model: model }
    : null;

  const {
    setError, error, contextWarning, contextSources, aborting, pendingToolCall, streamingDraft,
    failedRef, send, approvePendingTool, rejectPendingTool, stop, resetChatState,
  } = useChatSend({
    store, effectiveConfig, sessionId: selectedSessionId, preferences, baseUrl, apiKey, model, activeThread, msgs, setMsgs,
    modelProfile: effectiveConfig ? modelSettings?.getRequestProfile(selectedSessionId, effectiveConfig) : undefined,
    input, setInput, attachments, documents, setAttachments, setDocuments,
    mcpEntryByFunctionName, mcpDefinitions, atBottomRef, phase, setPhase,
  });

  const openModelSettings = () => {
    if (!requireIdle()) return;
    if (modelSettings) modelSettings.open({
      target: selectedSessionId === "default" ? { kind: "default" } : { kind: "session", sessionId: selectedSessionId },
      ...(selectedDefinition ? { definition: selectedDefinition } : {}),
    });
    else onOpenModels?.();
  };
  const startSelectedSession = async () => {
    if (!requireIdle() || startingSession || !targetConfig) return;
    if (selectedSessionId === 'default') { openModelSettings(); return; }
    const latest = store.getConfig?.() ?? store.cfg;
    if (!latest) return;
    if (sessionHasActivity(selectedSessionId) || ((latest.stop_existing_sessions_on_load ?? true) && anySessionActivity())) {
      setError("Stop the active response before loading a model.");
      return;
    }
    setStartingSession(true);
    setError(null);
    try {
      const definition = latest.sessions?.find((item) => item.id === selectedSessionId) ?? selectedDefinition;
      if (!definition) throw new Error("Save this session's model settings before starting it.");
      const prepared = await prepareSessionProfile(store, definition);
      await api.sessionStart(selectedSessionId, prepared, prepared.stop_existing_sessions_on_load ?? true);
      notifySessionStatusChanged();
      await store.refreshStatus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStartingSession(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const applyActiveProjectBinding = () => {
      const id = activeProjectId();
      const project = id ? readProjects().find((item) => item.id === id) : null;
      setActiveProjectName(project?.name ?? null);
      if (!project || phase !== "idle") return;
      setWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) => thread.id === current.activeThreadId
          ? { ...thread, systemPrompt: project.systemPrompt, updatedAt: Date.now() }
          : thread),
      }));
      setSelectedMcpTools(project.toolIds);
      void Promise.all(project.documentBindings.slice(0, 4).map(async (binding) => {
        try {
          return { name: binding.name, path: binding.path, text: await api.readDocumentBinding(binding.path) };
        } catch {
          return null;
        }
      })).then((loaded) => {
        if (!cancelled) setDocuments(loaded.filter((document): document is DocumentAttachment => document !== null));
      });
    };
    applyActiveProjectBinding();
    window.addEventListener(PROJECTS_CHANGED_EVENT, applyActiveProjectBinding);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECTS_CHANGED_EVENT, applyActiveProjectBinding);
    };
  }, [phase, setDocuments, setSelectedMcpTools, setWorkspace]);

  const displayModel = normalizeDisplayPath(model);
  const canSend = serverOn && !!apiKey && !!model && phase === "idle" && !pendingToolCall && !aborting && !store.busy && (!!input.trim() || attachments.length > 0 || documents.length > 0);
  const disabled = !serverOn || !model || !apiKey;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !atBottomRef.current || (msgs.length === 0 && phase === "idle")) return;
    const frame = window.requestAnimationFrame(() => {
      if (atBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [msgs, phase, streamingDraft]);

  // Stable identity (not the inline `ct` closure) so MessageBubble's memo bailout
  // survives streaming re-renders of ChatPanel; see MessageBubble.tsx's doc comment.
  const copyMessage = useCallback((index: number, text: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(index);
        window.setTimeout(() => setCopied((current) => (current === index ? null : current)), 1800);
      } catch (caught) {
        setError(`${t("chat.requestFailed")}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    })();
  }, [t, setError]);

  const sendMessage = () => {
    if (!canSend) return;
    // Resolve the full automatic title with the user's action, before retrieval
    // or generation can finish and resize the conversation heading later.
    if (activeThread?.title === "New conversation" && input.trim()) {
      updateActiveThread({ title: titleFromMessage(input) });
    }
    void send(false, undefined, canSend);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey && (preferences?.chat.enterToSend ?? true)) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="app-page-scroll chat-page">
      <ChatConversationHeader
        threadPanelOpen={threadPanelOpen}
        setThreadPanelOpen={setThreadPanelOpen}
        activeThread={activeThread}
        activeProjectName={activeProjectName}
        phase={phase}
        targetBusy={pendingToolCall !== null || startingSession}
        onUpdateThread={updateActiveThread}
        sessionLabel={t("ui.sessionsTitle")}
        sessionOptions={[
          { id: "default", label: t("ui.defaultSession") },
          ...availableSessions.map((session) => ({ id: session.id, label: `${session.name || session.id} · ${session.port ?? "—"} · ${session.state}`, disabled: session.state === "starting" || session.state === "stopping" })),
        ]}
        selectedSessionId={selectedSessionId}
        onSelectSession={(id) => { if (requireIdle()) setSelectedSessionId(id); }}
        ct={ct}
      />

      <div className="chat-layout">
        <ChatThreadSidebar
          open={threadPanelOpen}
          onClose={() => setThreadPanelOpen(() => false)}
          activeThreadId={workspace.activeThreadId}
          threadCount={workspace.threads.length}
          threadQuery={threadQuery}
          setThreadQuery={setThreadQuery}
          visibleThreads={visibleThreads}
          onSelect={selectThread}
          onDelete={deleteThread}
          onNewThread={newThread}
          ct={ct}
        />

        <div className="chat-conversation">
          <ChatMessageLog
            scrollRef={scrollRef}
            onScrollAtBottomChange={(atBottom) => { atBottomRef.current = atBottom; }}
            disabled={disabled}
            status={selectedStatus}
            model={model}
            serverOn={serverOn}
            msgs={viewMessages}
            streamingDraft={viewingLiveThread ? streamingDraft : null}
            phase={phase}
            copiedIndex={copied}
            compactMessages={preferences?.chat.compactMessages ?? false}
            locale={locale}
            onCopy={copyMessage}
            error={error}
            canRetry={!!failedRef.current}
            onRetry={() => void send(true)}
            ct={ct}
            onOpenModels={modelSettings || onOpenModels ? openModelSettings : undefined}
            modelSettingsLabel={modelSettings ? modelSettingsCopy[locale].title : undefined}
            onOpenDiagnostics={onOpenDiagnostics}
            onStart={() => void startSelectedSession()}
            starting={store.busy || startingSession}
          />

          <ChatComposer
            contextWarning={contextWarning}
            contextSources={contextSources}
            mcpCatalog={mcpCatalog}
            selectedMcpTools={selectedMcpTools}
            toggleMcpTool={toggleMcpTool}
            loadingMcpTools={loadingMcpTools}
            refreshMcpTools={() => void refreshMcpTools()}
            mcpDefinitions={mcpDefinitions}
            pendingToolCall={pendingToolCall}
            onApproveTool={() => void approvePendingTool()}
            onRejectTool={rejectPendingTool}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            attachmentStatus={attachmentStatus}
            documents={documents}
            onRemoveDocument={removeDocument}
            input={input}
            setInput={setInput}
            onKeyDown={onKeyDown}
            disabled={disabled}
            phase={phase}
            onAddAttachment={() => void addAttachment()}
            onStop={stop}
            aborting={aborting}
            onSend={sendMessage}
            canSend={canSend}
            model={model}
            displayModel={displayModel}
            msgsLength={viewMessages.length}
            ct={ct}
          />
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("chat.deleteTitle")}
        description={t("chat.deleteBody", { title: pendingDelete?.title || t("chat.newConversation") })}
        confirmLabel={t("chat.deleteConfirm")}
        onConfirm={() => { if (pendingDelete) performDeleteThread(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
