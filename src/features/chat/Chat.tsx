import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { CustomSelect } from '../../shared/ui/CustomSelect';
import ChatThreadSidebar from "./ChatThreadSidebar";
import ChatConversationHeader from "./ChatConversationHeader";
import ChatMessageLog from "./ChatMessageLog";
import ChatComposer from "./ChatComposer";
import { providerCopy } from '../../shared/i18n/providerCopy';
import { modelSettingsCopy } from "../model-settings/modelSettingsCopy";
import { formatModelLabel, isModelFilePath, normalizeDisplayPath } from "../../shared/lib/displayPaths";
import { chatRetryCopy, chatRetryToolsCopy } from "./chatRetryCopy";
import ChatSkillPicker from "./ChatSkillPicker";
import { dismissPersonalizationWarnings, useVisiblePersonalizationWarnings } from "./personalizationWarningDismissal";
import { embeddingSessionLabel } from './embeddingTarget';
import { embeddingTargetCopy } from './embeddingTargetCopy';
import { mediaPreparationCopy } from './mediaPreparationCopy';
import { projectChatBindingCopy } from './projectChatBindingCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import PanelFeedback from '../../shared/ui/PanelFeedback';
import { displayChatTitle } from './chatThreadTitle';
import { chatPersistenceCopy } from './chatPersistenceCopy';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { chatTurnOwnerCopy } from './chatTurnOwnerCopy';
import { useChatPanelController, type ChatPanelProps } from './useChatPanelController';

export default function ChatPanel({ store, preferences, onOpenModels, onDiscoverModels, active = true }: ChatPanelProps) {
  const {
    t, locale, ct, pt, modelSettings, phase, input, setInput, copied, composerDropRef, composerTextareaRef, isDragOver,
    session: {
      selectedSessionId, setSelectedSessionId, selectedStatus, sessionOptions,
      embeddingSelection, setEmbeddingSelection, availableEmbeddingSessions,
      audioSessionId, setAudioSessionId, videoFrames, setVideoFrames, speechSessions,
      serverOn, visionReady, configuredModel, model, effectiveConfig,
    },
    sessionLoad: { startingSession, sessionLoadNotice, openModelSettings, startSelectedSession, cancelSelectedSessionLoad },
    attachmentState: { attachments, documents, attachmentStatus, addAttachment, addPastedImages, removeAttachment, removeDocument },
    mcp: { mcpCatalog, mcpCatalogLoaded, selectedMcpTools, loadingMcpTools, mcpError, dismissMcpError, refreshMcpTools, toggleMcpTool, selectAllMcpTools, clearMcpTools, mcpDefinitions },
    skills,
    threads: {
      workspace, activeThread, liveThread, msgs, viewMessages, viewingLiveThread, saveFailed, retrySave,
      threadQuery, setThreadQuery, threadPanelOpen, setThreadPanelOpen, pendingDelete, setPendingDelete,
      visibleThreads, selectThread, deleteThread, performDeleteThread, updateActiveThread,
    },
    msgsThreadId,
    turn: {
      contextWarning, personalizationWarnings, contextSources, aborting, pendingToolCall, toolCallInProgress, streamingDraftStore,
      canRetry, retryUnavailable, setError, send, approvePendingTool, rejectPendingTool,
    },
    project: {
      projectName: activeProjectName, documentsLoading: projectDocumentsLoading,
      documentsError: projectDocumentsError, retryDocuments: retryProjectDocuments,
    },
    scroll: { scrollRef, onDraftRendered, onScrollAtBottomChange, showScrollToBottom, scrollToBottom },
    retry: { retryTools, restoreRetryTools },
    visiblePhase, visibleError, uiError, setUiError, requireIdle, incompatibleMedia, chatSupported, generates,
    chatUnavailable, canSend, canEditMessages, canRegenerate, disabled, loadingModel, closeThreadPanel, startNewThread,
    copyMessage, editUserMessage, regenerateLast, continueLast, sendMessage,
    enterToSend, onKeyDown, lastMessage, responseState, recoverable, queueState,
  } = useChatPanelController({ store, preferences, onOpenModels, active });
  const embeddingCopy = embeddingTargetCopy[locale];
  const mediaCopy = mediaPreparationCopy[locale];
  const projectCopy = projectChatBindingCopy[locale];
  const ownerCopy = chatTurnOwnerCopy[locale];
  const pickerWarnings = useVisiblePersonalizationWarnings(skills.warnings);
  const turnWarnings = useVisiblePersonalizationWarnings(personalizationWarnings);

  return (
    <div className="app-page-scroll chat-page">

      <div className="chat-layout">
        {threadPanelOpen && <div className="chat-thread-backdrop" aria-hidden="true" onClick={closeThreadPanel} />}
        <ChatThreadSidebar
          open={threadPanelOpen}
          active={active}
          onClose={closeThreadPanel}
          activeThreadId={workspace.activeThreadId}
          liveThreadId={msgsThreadId}
          liveActive={phase !== 'idle' || pendingToolCall !== null}
          liveApproval={pendingToolCall !== null}
          liveMessageCount={msgs.length}
          threadCount={workspace.threads.length}
          threadQuery={threadQuery}
          setThreadQuery={setThreadQuery}
          visibleThreads={visibleThreads}
          onSelect={selectThread}
          onDelete={deleteThread}
          onNewThread={startNewThread}
          ct={ct}
        />

        <div className="chat-conversation">
          <ChatConversationHeader
            threadPanelOpen={threadPanelOpen}
            setThreadPanelOpen={setThreadPanelOpen}
            activeThread={activeThread}
            activeProjectName={activeProjectName}
            phase={phase}
            targetBusy={pendingToolCall !== null || startingSession}
            threadFieldsLocked={viewingLiveThread && (phase !== 'idle' || pendingToolCall !== null)}
            onUpdateThread={updateActiveThread}
            sessionLabel={t("ui.sessionsTitle")}
            sessionOptions={sessionOptions}
            selectedSessionId={selectedSessionId}
            embedding={selectedStatus.engine || availableEmbeddingSessions.length ? {
              label: embeddingCopy.label, hint: embeddingCopy.hint, value: embeddingSelection,
              options: [{ value: 'auto', label: embeddingCopy.auto }, { value: 'lexical', label: embeddingCopy.lexical },
                ...availableEmbeddingSessions.map(session => ({ value: session.id, label: embeddingSessionLabel(session) })),
                ...(!['auto', 'lexical'].includes(embeddingSelection) && !availableEmbeddingSessions.some(session => session.id === embeddingSelection)
                  ? [{ value: embeddingSelection, label: `${embeddingCopy.unavailable} · ${embeddingSelection}` }] : [])],
              onChange: value => { if (requireIdle()) setEmbeddingSelection(value); },
            } : undefined}
            model={model || configuredModel}
            runtimeConfig={selectedStatus.engine ? { ...effectiveConfig, active_provider: selectedStatus.engine.provider, active_runtime: selectedStatus.engine.runtime_id } : effectiveConfig}
            onSelectSession={(id) => { if (!startingSession && requireIdle()) { setSelectedSessionId(id); skills.clearSelectedSkills(); } }}
            ct={ct}
            mediaControls={
              <fieldset className="chat-media-controls" aria-describedby="chat-media-preprocessing-hint">
                <legend>{mediaCopy.label}</legend>
                <p id="chat-media-preprocessing-hint" className="text-xs ui-color-muted">{mediaCopy.hint}</p>
                <label className="chat-media-target text-xs ui-color-muted">
                  {mediaCopy.audio}
                  <CustomSelect value={audioSessionId} disabled={phase !== 'idle' || pendingToolCall !== null}
                    onChange={setAudioSessionId} ariaLabel={mediaCopy.audio}
                    options={[{ value: '', label: mediaCopy.native },
                      ...speechSessions.map(session => {
                        const rawModel = session.model ?? '';
                        const shortened = isModelFilePath(rawModel);
                        const modelLabel = formatModelLabel(rawModel) || rawModel;
                        return {
                          value: session.id,
                          label: `${session.name || session.id} · ${modelLabel}`,
                          title: shortened ? normalizeDisplayPath(rawModel) : undefined,
                        };
                      }),
                      ...(audioSessionId && !speechSessions.some(session => session.id === audioSessionId)
                        ? [{ value: audioSessionId, label: `${audioSessionId} · ${t('ui.sessionStopped')}`, disabled: true }] : [])]} />
                </label>
                <label className="chat-media-video flex items-center gap-2 text-xs ui-color-ink">
                  <input type="checkbox" checked={videoFrames} disabled={!visionReady || phase !== 'idle' || pendingToolCall !== null}
                    onChange={event => setVideoFrames(event.target.checked)} />
                  {mediaCopy.video}
                </label>
              </fieldset>
            }
          />
          {startingSession && <div className="chat-session-status flex items-center gap-2 text-xs ui-color-muted" role="status">
            <span>{t('ui.sessionStarting')}</span>
            <LocalTaskCancelButton taskId={`session-load-${selectedSessionId}`} onClick={() => void cancelSelectedSessionLoad()}>{t('common.cancel')}</LocalTaskCancelButton>
          </div>}
          {sessionLoadNotice && <p className="chat-session-status text-xs ui-color-muted" role="status">{t('ui.taskCancelled')}</p>}
          <ChatMessageLog
            scrollRef={scrollRef}
            onScrollAtBottomChange={onScrollAtBottomChange}
            disabled={disabled}
            status={selectedStatus}
            model={model}
            serverOn={serverOn}
            canGenerate={chatSupported && generates}
            msgs={viewMessages}
            streamingDraftStore={viewingLiveThread ? streamingDraftStore : null}
            onDraftRendered={onDraftRendered}
            phase={visiblePhase}
            copiedIndex={copied}
            compactMessages={preferences?.chat.compactMessages ?? false}
            expandReasoning={preferences?.chat.expandReasoning ?? false}
            locale={locale}
            onCopy={copyMessage}
            onEditMessage={viewingLiveThread ? editUserMessage : undefined}
            editDisabled={!canEditMessages}
            onRegenerate={viewingLiveThread ? regenerateLast : undefined}
            onContinue={viewingLiveThread ? continueLast : undefined}
            regenerateDisabled={!canRegenerate}
            error={visibleError}
            onDismissError={viewingLiveThread ? () => setError(null) : undefined}
            showScrollToBottom={showScrollToBottom}
            onScrollToBottom={scrollToBottom}
            canRetry={viewingLiveThread && canRetry}
            recoverable={recoverable}
            retryNotice={viewingLiveThread && retryUnavailable ? chatRetryCopy[locale][retryUnavailable] : null}
            retryToolsAction={viewingLiveThread && retryTools ? {
              notice: chatRetryToolsCopy[locale][retryTools.state].replace('{tools}', retryTools.tools.map(tool => `${tool.serverName} · ${tool.toolName}`).join(', ')),
              label: chatRetryToolsCopy[locale].reload, onClick: () => void restoreRetryTools(), disabled: loadingMcpTools,
            } : null}
            onRetry={() => { if (viewingLiveThread && recoverable && canRetry) void send(true); }}
            ct={ct}
            onOpenModels={modelSettings || onOpenModels ? openModelSettings : undefined}
            onDiscoverModels={selectedSessionId === "default" && !configuredModel ? onDiscoverModels : undefined}
            modelSettingsLabel={modelSettings ? modelSettingsCopy[locale].title : undefined}
            onStart={() => void startSelectedSession()}
            starting={store.busy || startingSession}
          />

          <PanelFeedback>
            {saveFailed && <FeedbackBanner tone="error" action={{ label: chatPersistenceCopy[locale].retry, onClick: retrySave }}>{chatPersistenceCopy[locale].failed}</FeedbackBanner>}
            {uiError && <FeedbackBanner tone="error" onDismiss={() => setUiError(null)}>{uiError}</FeedbackBanner>}
            {mcpError && <FeedbackBanner tone="error" onDismiss={dismissMcpError}>{mcpError}</FeedbackBanner>}
            {viewingLiveThread && projectDocumentsLoading && <FeedbackBanner tone="info">{projectCopy.loading}</FeedbackBanner>}
            {viewingLiveThread && projectDocumentsError && <FeedbackBanner tone="error" action={{ label: projectCopy.retry, onClick: retryProjectDocuments }}>{projectDocumentsError}</FeedbackBanner>}
          </PanelFeedback>
          {!viewingLiveThread && liveThread && <div className="chat-owner-banner">
            <button type="button" className="app-button app-button--secondary" onClick={() => selectThread(liveThread)}>{ownerCopy.returnTo}</button>
          </div>}
          {/* The composer and its approval/context state belong to the live buffer,
              not the conversation being browsed. Keep that buffer intact on return. */}
          {viewingLiveThread && <ChatComposer
            dropTargetRef={composerDropRef}
            isDragOver={isDragOver}
            textareaRef={composerTextareaRef}
            onPasteImages={(files) => void addPastedImages(files)}
            locale={locale}
            contextWarning={[contextWarning, incompatibleMedia ? providerCopy[locale].blocked : null, chatUnavailable].filter(Boolean).join(' ') || null}
            personalizationWarning={turnWarnings.length > 0 ? pt("instructionWarnings", { warnings: turnWarnings.join(" ") }) : null}
            onDismissPersonalizationWarning={() => dismissPersonalizationWarnings(personalizationWarnings)}
            contextSources={contextSources}
            mcpCatalog={mcpCatalog}
            mcpCatalogLoaded={mcpCatalogLoaded}
            selectedMcpTools={selectedMcpTools}
            toggleMcpTool={toggleMcpTool}
            onSelectAllMcpTools={selectAllMcpTools}
            onClearMcpTools={clearMcpTools}
            loadingMcpTools={loadingMcpTools}
            refreshMcpTools={() => void refreshMcpTools()}
            mcpDefinitions={mcpDefinitions}
            pendingToolCall={pendingToolCall}
            toolCallInProgress={toolCallInProgress}
            onApproveTool={() => { if (viewingLiveThread) void approvePendingTool(); }}
            onRejectTool={() => { if (viewingLiveThread) rejectPendingTool(); }}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            attachmentStatus={attachmentStatus}
            documents={documents}
            onRemoveDocument={removeDocument}
            input={input}
            setInput={setInput}
            onKeyDown={onKeyDown}
            enterToSend={enterToSend}
            disabled={disabled}
            phase={phase}
            loadingModel={loadingModel}
            onAddAttachment={() => void addAttachment()}
            onStop={queueState.stopByUser}
            aborting={aborting}
            onSend={sendMessage}
            canSend={canSend}
            msgsLength={viewMessages.length}
            responseState={responseState}
            responseWithoutOutput={lastMessage?.role === 'assistant' && !lastMessage.content && !lastMessage.reasoning}
            responseFinishReason={lastMessage?.finishReason}
            ct={ct}
            skillPicker={<ChatSkillPicker native={skills.native} catalog={skills.catalog} warnings={pickerWarnings} onDismissWarnings={() => dismissPersonalizationWarnings(skills.warnings)} loadError={skills.loadError} loading={skills.loading} loaded={skills.loaded} selectedSkillIds={skills.selectedSkillIds} onToggleSkill={skills.toggleSkill} onRefresh={() => void skills.refreshSkills()} locked={phase !== "idle" || pendingToolCall !== null} closeLabel={ct("close")} pt={pt} />}
            selectedSkills={skills.selectedSkills}
            onRemoveSkill={skills.toggleSkill}
            skillsLocked={phase !== "idle" || pendingToolCall !== null}
            selectedSkillsLabel={pt("selectedSkills")}
            removeSkillLabel={pt("removeSkill")}
            queue={queueState.queue}
            steering={queueState.steering}
            queuePaused={queueState.queuePaused}
            queuePauseReason={queueState.queuePauseReason}
            modelUnavailable={queueState.modelUnavailable}
            canQueue={queueState.canQueue}
            busySubmit={queueState.busySubmit}
            onQueue={queueState.queueMessage}
            onSteer={queueState.steerMessage}
            onSteerQueued={queueState.steerQueued}
            onRemoveQueued={queueState.removeQueued}
            onResumeQueue={queueState.resumeQueue}
          />}
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
