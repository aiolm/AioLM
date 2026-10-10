import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import type { AppPreferences } from "../../shared/config/preferences";
import { useI18n } from "../../shared/i18n/i18n";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import { isServerRunning } from "../../shared/lib/serverLifecycle";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { useChatThreads } from "./useChatThreads";
import { useChatAttachments } from "./useChatAttachments";
import { useChatMcpTools } from "./useChatMcpTools";
import { useChatSend } from "./useChatSend";
import ChatThreadSidebar from "./ChatThreadSidebar";
import ChatConversationHeader from "./ChatConversationHeader";
import ChatMessageLog from "./ChatMessageLog";
import ChatComposer from "./ChatComposer";
import { providerCopy } from '../../shared/i18n/providerCopy';
import { notifySessionStatusChanged, sessionConfig, sessionDefinitionFromStatus } from "../../shared/runtime/sessionUtils";
import { useSessionPolling } from "../../shared/hooks/useSessionPolling";
import { anySessionActivity, sessionHasActivity } from "../../shared/state/sessionActivity";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { prepareSessionProfile } from "../model-settings/prepareSessionProfile";
import { modelSettingsCopy } from "../model-settings/modelSettingsCopy";
import { titleFromMessage } from "./chatHistory";
import { useChatSkills } from "./useChatSkills";
import ChatSkillPicker from "./ChatSkillPicker";
import { chatPersonalizationText, type ChatPersonalizationTextKey } from "../../shared/i18n/chatPersonalizationText";
import { useFlashMessage } from "../../shared/hooks/useFlashMessage";
import { embeddingSessionLabel, embeddingSessions, selectEmbeddingSession } from './embeddingTarget';
import { embeddingTargetCopy } from './embeddingTargetCopy';
import { canPrepareAttachment } from './mediaPreprocessing';
import { mediaPreparationCopy } from './mediaPreparationCopy';
import { chatTemplateCopy } from './chatTemplateCopy';
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import { useProjectChatBinding } from './useProjectChatBinding';
import { projectChatBindingCopy } from './projectChatBindingCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import PanelFeedback from '../../shared/ui/PanelFeedback';
import { displayChatTitle } from './chatThreadTitle';

export default function ChatPanel({ store, preferences, onOpenModels, onOpenDiagnostics, active = true }: { store: AppStore; preferences?: AppPreferences; onOpenModels?: () => void; onOpenDiagnostics?: () => void; active?: boolean }) {
  const { t, locale } = useI18n();
  const modelSettings = useModelSettings();
  const ct = (key: ChatTextKey) => t(`chat.${key}`);
  const pt = (key: ChatPersonalizationTextKey, vars?: Record<string, string | number>) => chatPersonalizationText(locale, key, vars);
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
  const [input, setInput] = useState("");
  const [composerRevision, setComposerRevision] = useState(0);
  const [copiedMessage, showCopied] = useFlashMessage(1800);
  const copied = copiedMessage === null ? null : Number(copiedMessage);
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState("default");
  const [embeddingSelection, setEmbeddingSelection] = useState('auto');
  const [audioSessionId, setAudioSessionId] = useState('');
  const [videoFrames, setVideoFrames] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scrollViewportRef = useRef<{ width: number; height: number } | null>(null);

  // The shared poller also refreshes on session status changes, and serves an
  // open model settings dialog from the same session_list request.
  useSessionPolling({
    active,
    details: true,
    onData: (items) => {
      setSessions(items.filter((item) => item.id !== "default"));
      setSessionsLoaded(true);
    },
    onError: () => setSessionsLoaded(true),
  });

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
  const embeddingCandidates = [{ ...store.status, id: 'default', name: t('ui.defaultSession') }, ...sessions];
  const embeddingChoice = selectEmbeddingSession(embeddingCandidates, selectedSessionId, embeddingSelection);
  const embeddingCopy = embeddingTargetCopy[locale];
  const serverOn = isServerRunning(selectedStatus.state);
  const modalities = selectedStatus.engine?.modalities;
  const visionReady = serverOn && (modalities?.image ?? !!selectedStatus.mmproj);
  const speechSessions = embeddingCandidates.filter(session => isServerRunning(session.state)
    && session.engine?.tasks?.includes('transcription'));
  const mediaOptions = { audioSessionId: speechSessions.some(session => session.id === audioSessionId) ? audioSessionId : undefined, videoFrames };
  const mediaCopy = mediaPreparationCopy[locale];

  const { attachments, documents, attachmentStatus, setAttachments, setDocuments, addAttachment, removeAttachment, removeDocument, clearComposerAttachments } = useChatAttachments({ visionReady, modalities,
    audioPreprocessAvailable: !!mediaOptions.audioSessionId, videoPreprocessAvailable: videoFrames && visionReady,
    setError: (message) => setError(message) });
  const { mcpCatalog, selectedMcpTools, setSelectedMcpTools, loadingMcpTools, mcpError, refreshMcpTools, toggleMcpTool, mcpEntryByFunctionName, mcpDefinitions } = useChatMcpTools();

  const skills = useChatSkills();

  const requireIdle = () => {
    if (phase === "idle" && !pendingToolCall) return true;
    setError("Stop the current response first.");
    return false;
  };

  const resetComposer = () => {
    setInput("");
    clearComposerAttachments();
    skills.clearSelectedSkills();
    resetChatState();
    setComposerRevision((revision) => revision + 1);
  };

  const {
    workspace, setWorkspace, activeThread, msgs, setMsgs, viewMessages, viewingLiveThread, clearingWorkspace,
    threadQuery, setThreadQuery, threadPanelOpen, setThreadPanelOpen,
    pendingDelete, setPendingDelete, visibleThreads,
    selectThread, newThread, deleteThread, performDeleteThread, updateActiveThread,
  } = useChatThreads({ phase, hasPendingTurn: () => pendingToolCall !== null, requireIdle, onSwitchThread: resetComposer, defaultThreadTitle: ct('newConversation') });

  const baseUrl = serverOn && selectedStatus.url ? selectedStatus.url : null;
  const apiKey = serverOn ? selectedStatus.api_key ?? "" : "";
  const targetConfig = store.cfg && selectedDefinition ? sessionConfig(store.cfg, selectedDefinition) : store.cfg;
  const configuredModel = selectedDefinition?.models.primary_model ?? (selectedSessionId === "default" ? store.cfg?.active_model ?? "" : selectedStatus.model ?? "");
  const model = serverOn ? loadedModelPath(selectedStatus, configuredModel) : selectedSessionId === 'default' ? '' : configuredModel;
  const effectiveConfig = targetConfig
    ? modelSettings?.getRequestConfig(selectedSessionId, targetConfig, selectedStatus)
      ?? { ...targetConfig, ...(serverOn ? selectedStatus.execution : {}), active_model: model }
    : null;

  const {
    setError, error, contextWarning, contextSources, aborting, pendingToolCall, streamingDraft,
    failedRef, send, approvePendingTool, rejectPendingTool, stop, resetChatState,
  } = useChatSend({
    store, effectiveConfig, engine: selectedStatus.engine, mediaPreprocessing: mediaOptions,
    embeddingTarget: embeddingChoice ? { model: embeddingChoice.engine!.embedding_model!, baseUrl: embeddingChoice.url!, apiKey: embeddingChoice.api_key ?? '',
      namespace: embeddingChoice.engine!.embedding_namespace ?? `${embeddingChoice.engine!.provider}:${embeddingChoice.model}` }
      : selectedStatus.engine || embeddingSelection !== 'auto' ? { model: '', baseUrl: '', apiKey: '', namespace: '' } : undefined,
    sessionId: selectedSessionId, preferences, baseUrl, apiKey, model, activeThread, msgs, setMsgs,
    modelProfile: effectiveConfig ? modelSettings?.getRequestProfile(selectedSessionId, effectiveConfig) : undefined,
    input, setInput, attachments, documents, setAttachments, setDocuments,
    mcpEntryByFunctionName, mcpDefinitions, atBottomRef, phase, setPhase,
    selectedSkillIds: skills.selectedSkillIds, onSkillsAccepted: skills.clearSelectedSkills, locale,
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

  const {
    projectName: activeProjectName, documentsLoading: projectDocumentsLoading,
    documentsError: projectDocumentsError, retryDocuments: retryProjectDocuments,
  } = useProjectChatBinding({ workspace, setWorkspace, documents, setDocuments,
    setSelectedTools: setSelectedMcpTools, composerRevision, phase,
    hasPendingTurn: pendingToolCall !== null, locale });
  const projectCopy = projectChatBindingCopy[locale];

  const incompatibleMedia = attachments.some(attachment => {
    return !canPrepareAttachment(attachment, modalities ?? { text: true, image: visionReady, audio: false, video: false }, mediaOptions);
  });
  const chatSupported = selectedStatus.engine?.chat_supported !== false;
  const canSend = serverOn && chatSupported && !clearingWorkspace && (selectedStatus.engine?.tasks?.includes('generate') ?? true) && !!apiKey && !!model && !incompatibleMedia && attachmentStatus !== 'reading' && !projectDocumentsLoading && !projectDocumentsError && phase === "idle" && !pendingToolCall && !aborting && !store.busy && (!!input.trim() || attachments.length > 0 || documents.length > 0);
  const disabled = !serverOn || !model || !apiKey;
  const loadingModel = !serverOn && selectedStatus.state !== 'failed' && selectedStatus.state !== 'crashed' && (selectedStatus.state === 'starting' || store.busy || startingSession);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    scrollViewportRef.current = { width: element.clientWidth, height: element.clientHeight };
    // Keep the latest reply in view when a window or composer changes size.
    // A reader who scrolled into history retains their place.
    const observer = new ResizeObserver(() => {
      scrollViewportRef.current = { width: element.clientWidth, height: element.clientHeight };
      if (atBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
        showCopied(String(index));
      } catch (caught) {
        setError(`${t("chat.requestFailed")}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    })();
  }, [t, setError, showCopied]);

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
    // IME composition (including the keyCode 229 some engines report) must never send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
        embedding={selectedStatus.engine || embeddingSessions(embeddingCandidates).length ? {
          label: embeddingCopy.label, hint: embeddingCopy.hint, value: embeddingSelection,
          options: [{ value: 'auto', label: embeddingCopy.auto }, { value: 'lexical', label: embeddingCopy.lexical },
            ...embeddingSessions(embeddingCandidates).map(session => ({ value: session.id, label: embeddingSessionLabel(session) })),
            ...(!['auto', 'lexical'].includes(embeddingSelection) && !embeddingSessions(embeddingCandidates).some(session => session.id === embeddingSelection)
              ? [{ value: embeddingSelection, label: embeddingCopy.lexical }] : [])],
          onChange: value => { if (requireIdle()) setEmbeddingSelection(value); },
        } : undefined}
        model={model || configuredModel}
        runtimeConfig={selectedStatus.engine ? { ...effectiveConfig, active_provider: selectedStatus.engine.provider, active_runtime: selectedStatus.engine.runtime_id } : effectiveConfig}
        onSelectSession={(id) => { if (requireIdle()) { setSelectedSessionId(id); skills.clearSelectedSkills(); } }}
        ct={ct}
      />

      <details className="mb-3 rounded-lg border p-3 ui-border-color-border">
        <summary>{mediaCopy.label}</summary>
        <p className="my-2 text-sm">{mediaCopy.hint}</p>
        <label className="mr-3 inline-flex items-center gap-2">
          {mediaCopy.audio}
          <CustomSelect value={audioSessionId} disabled={phase !== 'idle' || pendingToolCall !== null}
            onChange={setAudioSessionId} ariaLabel={mediaCopy.audio}
            options={[{ value: '', label: mediaCopy.native },
              ...speechSessions.map(session => ({ value: session.id, label: `${session.name || session.id} · ${session.model}` })),
              ...(audioSessionId && !speechSessions.some(session => session.id === audioSessionId)
                ? [{ value: audioSessionId, label: `${audioSessionId} · ${t('ui.sessionStopped')}`, disabled: true }] : [])]} />
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={videoFrames} disabled={!visionReady || phase !== 'idle' || pendingToolCall !== null}
            onChange={event => setVideoFrames(event.target.checked)} />
          {mediaCopy.video}
        </label>
      </details>

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
            onScrollAtBottomChange={(atBottom) => {
              const element = scrollRef.current;
              const viewport = scrollViewportRef.current;
              // Resizing can emit scroll before ResizeObserver restores the bottom.
              if (!element || !viewport || (element.clientWidth === viewport.width && element.clientHeight === viewport.height)) atBottomRef.current = atBottom;
            }}
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

          <PanelFeedback>
            {mcpError && <FeedbackBanner tone="error">{mcpError}</FeedbackBanner>}
            {projectDocumentsLoading && <FeedbackBanner tone="info">{projectCopy.loading}</FeedbackBanner>}
            {projectDocumentsError && <FeedbackBanner tone="error" action={{ label: projectCopy.retry, onClick: retryProjectDocuments }}>{projectDocumentsError}</FeedbackBanner>}
          </PanelFeedback>
          <ChatComposer
            locale={locale}
            contextWarning={[contextWarning, incompatibleMedia ? providerCopy[locale].blocked : null, serverOn && !chatSupported ? chatTemplateCopy[locale] : null].filter(Boolean).join(' ') || null}
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
            loadingModel={loadingModel}
            onAddAttachment={() => void addAttachment()}
            onStop={stop}
            aborting={aborting}
            onSend={sendMessage}
            canSend={canSend}
            msgsLength={viewMessages.length}
            responseFinishReason={viewMessages.at(-1)?.finishReason}
            ct={ct}
            skillPicker={<ChatSkillPicker native={skills.native} catalog={skills.catalog} warnings={skills.warnings} loadError={skills.loadError} loading={skills.loading} loaded={skills.loaded} selectedSkillIds={skills.selectedSkillIds} onToggleSkill={skills.toggleSkill} onRefresh={() => void skills.refreshSkills()} locked={phase !== "idle" || pendingToolCall !== null} closeLabel={ct("close")} pt={pt} />}
            selectedSkills={skills.selectedSkills}
            onRemoveSkill={skills.toggleSkill}
            skillsLocked={phase !== "idle" || pendingToolCall !== null}
            selectedSkillsLabel={pt("selectedSkills")}
            removeSkillLabel={pt("removeSkill")}
          />
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("chat.deleteTitle")}
        description={t("chat.deleteBody", { title: displayChatTitle(pendingDelete?.title, ct('newConversation')) })}
        confirmLabel={t("chat.deleteConfirm")}
        onConfirm={() => { if (pendingDelete) performDeleteThread(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
