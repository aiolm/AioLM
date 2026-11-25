import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/api/errors';
import type { AppStore } from '../../shared/state/store';
import type { AppPreferences } from '../../shared/config/preferences';
import { useI18n } from '../../shared/i18n/i18n';
import type { ChatTextKey } from '../../shared/i18n/chatI18n';
import { chatPersonalizationText, type ChatPersonalizationTextKey } from '../../shared/i18n/chatPersonalizationText';
import { useFlashMessage } from '../../shared/hooks/useFlashMessage';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { useChatThreads } from './useChatThreads';
import { useChatAttachments } from './useChatAttachments';
import { useNativeAttachmentDrop } from './useNativeAttachmentDrop';
import { useChatMcpTools } from './useChatMcpTools';
import { useChatSend } from './useChatSend';
import type { ChatPhase, QueuedChatMessage } from './chatSendTypes';
import type { ChatBusySubmit } from '../../shared/config/preferences';
import { chatQueueCopy } from './chatQueueCopy';
import { titleFromMessage } from './chatWorkspace';
import { unfinishedReply } from './chatRetrySnapshot';
import { useChatSkills } from './useChatSkills';
import { canPrepareAttachment } from './mediaPreprocessing';
import { chatTemplateCopy } from './chatTemplateCopy';
import { chatTaskCopy } from './chatTaskCopy';
import { useProjectChatBinding } from './useProjectChatBinding';
import { displayChatTitle, isGeneratedChatTitle } from './chatThreadTitle';
import { useChatSession } from './useChatSession';
import { useChatSessionLoad } from './useChatSessionLoad';
import { useChatScroll } from './useChatScroll';
import { useChatRetryTools } from './useChatRetryTools';

export interface ChatPanelProps {
  store: AppStore;
  preferences?: AppPreferences;
  onOpenModels?: () => void;
  onDiscoverModels?: () => void;
  active?: boolean;
}

export function useChatPanelController({ store, preferences, onOpenModels, active = true }: ChatPanelProps) {
  const { t, locale } = useI18n();
  const modelSettings = useModelSettings();
  const ct = useCallback((key: ChatTextKey) => t(`chat.${key}`), [t]);
  const pt = useCallback((key: ChatPersonalizationTextKey, vars?: Record<string, string | number>) => chatPersonalizationText(locale, key, vars), [locale]);
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const [input, setInput] = useState('');
  const [composerRevision, setComposerRevision] = useState(0);
  const [uiError, setUiError] = useState<string | null>(null);
  // Messages written while a turn could not start yet. They belong to the live
  // conversation; `steering` goes first and interrupts whatever is running.
  const [queue, setQueue] = useState<QueuedChatMessage[]>([]);
  const [steering, setSteering] = useState<QueuedChatMessage | null>(null);
  // Why the queue waits for the user: a stopped or failed turn, or a model
  // that is neither loaded nor loading.
  const [queuePauseReason, setQueuePauseReason] = useState<'turn' | 'model' | null>(null);
  const queuePaused = queuePauseReason !== null;
  const setQueuePaused = (paused: boolean) => setQueuePauseReason(paused ? 'turn' : null);
  const hasQueued = queue.length > 0 || steering !== null;
  const queueCopy = chatQueueCopy[locale];
  const [copiedMessage, showCopied] = useFlashMessage(1800);
  const copied = copiedMessage === null ? null : Number(copiedMessage);
  const session = useChatSession({ store, active, modelSettings, t, locale });
  const {
    selectedSessionId, selectedStatus, embeddingSelection, embeddingChoice,
    mediaOptions, serverOn, modalities, visionReady, baseUrl, apiKey, model, effectiveConfig,
  } = session;
  const composerDropRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const viewingLiveThreadRef = useRef(true);

  const attachmentState = useChatAttachments({ visionReady, modalities, locale,
    audioPreprocessAvailable: !!mediaOptions.audioSessionId, videoPreprocessAvailable: session.videoFrames && visionReady,
    setError: setUiError });
  const { attachments, documents, attachmentStatus, setAttachments, setDocuments, addDroppedAttachments, clearComposerAttachments } = attachmentState;
  const mcp = useChatMcpTools();
  const { mcpCatalog, mcpCatalogLoaded, selectedMcpTools, setSelectedMcpTools, mcpSelectionRevision, refreshMcpTools, mcpEntryByFunctionName, mcpDefinitions } = mcp;
  const skills = useChatSkills();

  const requireIdle = () => {
    if (phase === 'idle' && !pendingToolCall && !hasQueued) return true;
    if (phase === 'idle' && !pendingToolCall) {
      // Not a turn failure: it must not pause the queue it is asking about.
      setUiError(queueCopy.clearQueueFirst);
      return false;
    }
    const message = ct('stopCurrentResponseFirst');
    if (viewingLiveThreadRef.current) setError(message);
    else setUiError(message);
    return false;
  };

  const resetComposer = () => {
    setUiError(null);
    setInput('');
    clearComposerAttachments();
    skills.clearSelectedSkills();
    setQueue([]);
    setSteering(null);
    setQueuePaused(false);
    resetChatState();
    setComposerRevision((revision) => revision + 1);
  };

  const threads = useChatThreads({ phase, hasPendingTurn: () => pendingToolCall !== null || hasQueued, requireIdle, onSwitchThread: resetComposer, defaultThreadTitle: ct('newConversation') });
  const {
    workspace, setWorkspace, activeThread, liveThread, msgsThreadId, msgs, setMsgs, viewMessages,
    viewingLiveThread, clearingWorkspace, setThreadPanelOpen, updateActiveThread, writeBackPending,
  } = threads;
  viewingLiveThreadRef.current = viewingLiveThread;
  const turn = useChatSend({
    store, effectiveConfig, engine: selectedStatus.engine, mediaPreprocessing: mediaOptions,
    embeddingTarget: embeddingChoice ? { model: embeddingChoice.engine!.embedding_model!, baseUrl: embeddingChoice.url!, apiKey: embeddingChoice.api_key ?? '',
      namespace: embeddingChoice.engine!.embedding_namespace ?? `${embeddingChoice.engine!.provider}:${embeddingChoice.model}` }
      : selectedStatus.engine || embeddingSelection !== 'auto' ? { model: '', baseUrl: '', apiKey: '', namespace: '' } : undefined,
    sessionId: selectedSessionId, preferences, baseUrl, apiKey, model, activeThread: liveThread, msgs, setMsgs,
    modelProfile: effectiveConfig ? modelSettings?.getRequestProfile(selectedSessionId, effectiveConfig) : undefined,
    input, setInput, attachments, documents, setAttachments, setDocuments,
    mcpEntryByFunctionName, mcpDefinitions, atBottomRef, phase, setPhase,
    selectedSkillIds: skills.selectedSkillIds, onSkillsAccepted: skills.clearSelectedSkills, locale,
    onQueuedNotSent: (message) => restoreUnsentRef.current(message),
  });
  const { setError, error, aborting, pendingToolCall, toolCallInProgress, retryToolsMissing, sendQueued, regenerate, continueResponse, stop, rejectPendingTool, resetChatState } = turn;

  const visiblePhase = viewingLiveThread ? phase : 'idle';
  const visibleError = viewingLiveThread ? error : null;
  const ownerTitle = displayChatTitle(liveThread?.title, ct('newConversation'));
  const sessionLoad = useChatSessionLoad({
    store, modelSettings, t, selectedSessionId, selectedSession: session.selectedSession,
    selectedDefinition: session.selectedDefinition, targetConfig: session.targetConfig,
    onOpenModels, requireIdle, setError, ct,
  });
  const { startingSession } = sessionLoad;

  const project = useProjectChatBinding({ workspace, setWorkspace, documents, setDocuments,
    setSelectedTools: setSelectedMcpTools, composerRevision, phase,
    hasPendingTurn: pendingToolCall !== null, locale });
  const { documentsLoading: projectDocumentsLoading, documentsError: projectDocumentsError } = project;

  const incompatibleMedia = attachments.some(attachment => {
    return !canPrepareAttachment(attachment, modalities ?? { text: true, image: visionReady, audio: false, video: false }, mediaOptions);
  });
  const chatSupported = selectedStatus.engine?.chat_supported !== false;
  const generates = selectedStatus.engine?.tasks?.includes('generate') ?? true;
  // A session that serves only other tasks (embeddings, transcription) is explained by those tasks, not as a missing chat template.
  const chatUnavailable = !serverOn ? null : !generates ? chatTaskCopy(locale, selectedStatus.engine?.tasks ?? []) : !chatSupported ? chatTemplateCopy[locale] : null;
  // Whether the live conversation can start a turn now, whoever is viewing it.
  const turnReady = serverOn && chatSupported && !startingSession && !clearingWorkspace && generates && !!apiKey && !!model && !projectDocumentsLoading && !projectDocumentsError && phase === 'idle' && !pendingToolCall && !aborting && !store.busy;
  const composerReady = !incompatibleMedia && attachmentStatus !== 'reading' && (!!input.trim() || attachments.length > 0 || documents.length > 0);
  const canSend = viewingLiveThread && turnReady && composerReady;
  const loadingModel = !serverOn && selectedStatus.state !== 'failed' && selectedStatus.state !== 'crashed' && (selectedStatus.state === 'starting' || store.busy || startingSession);
  // No model is loaded and none is on its way, so nothing would ever start the queue.
  const modelUnavailable = !serverOn && !loadingModel;
  // A message can wait for a reply, an approval or a model load, but not for a
  // session that cannot chat at all or for a model nobody is loading: it would
  // never leave the queue.
  const canQueue = viewingLiveThread && !clearingWorkspace && composerReady && !chatUnavailable && !modelUnavailable;
  const turnBusy = phase !== 'idle' || pendingToolCall !== null;
  const busySubmit: ChatBusySubmit = preferences?.chat.busySubmit ?? 'queue';
  const canEditMessages = viewingLiveThread && phase === 'idle' && !pendingToolCall && !toolCallInProgress && !aborting;
  const canRegenerate = viewingLiveThread && serverOn && chatSupported && !startingSession && !clearingWorkspace && generates && !!apiKey && !!model && !projectDocumentsLoading && !projectDocumentsError && phase === 'idle' && !pendingToolCall && !toolCallInProgress && !aborting && !store.busy;
  const disabled = !serverOn || !model || !apiKey;
  const { isDragOver } = useNativeAttachmentDrop({ targetRef: composerDropRef, active,
    enabled: viewingLiveThread && !disabled && phase === 'idle' && pendingToolCall === null && attachmentStatus !== 'reading'
      && !(documents.length >= 4 && attachments.length >= 4),
    onDrop: addDroppedAttachments, setError: setUiError, locale });

  const scroll = useChatScroll(viewMessages, visiblePhase, atBottomRef, activeThread?.id ?? '');
  const closeThreadPanel = useCallback(() => setThreadPanelOpen(false), [setThreadPanelOpen]);

  const startNewThreadRef = useRef<() => void>(() => undefined);
  startNewThreadRef.current = () => {
    threads.newThread();
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
  };
  const startNewThread = useCallback(() => startNewThreadRef.current(), []);

  useEffect(() => {
    if (!active) return;
    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open], details[open], [role="listbox"]')) return;
      if (!viewingLiveThreadRef.current || phase === 'idle' || aborting) return;
      event.preventDefault();
      stopRef.current();
    };
    const onShortcutNewThread = () => startNewThreadRef.current();
    window.addEventListener('keydown', onGlobalKeyDown);
    window.addEventListener('aiolm:chat-new-thread', onShortcutNewThread);
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown);
      window.removeEventListener('aiolm:chat-new-thread', onShortcutNewThread);
    };
  }, [active, phase, aborting]);

  const bubbleActionRef = useRef({
    canEditMessages, canRegenerate, msgs, setMsgs, setInput, setAttachments, setDocuments,
    resetChatState, setUiError, regenerate, continueResponse, updateActiveThread,
  });
  bubbleActionRef.current = {
    canEditMessages, canRegenerate, msgs, setMsgs, setInput, setAttachments, setDocuments,
    resetChatState, setUiError, regenerate, continueResponse, updateActiveThread,
  };

  // Stable identity (not the inline `ct` closure) so MessageBubble's memo bailout
  // survives streaming re-renders of ChatPanel; see MessageBubble.tsx's doc comment.
  const copyMessage = useCallback((index: number, text: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        showCopied(String(index));
      } catch (caught) {
        setUiError(`${t('chat.requestFailed')}: ${errorMessage(caught)}`);
      }
    })();
  }, [t, showCopied]);

  const editUserMessage = useCallback((index: number) => {
    const state = bubbleActionRef.current;
    if (!state.canEditMessages) return;
    const target = state.msgs[index];
    if (!target || target.role !== 'user') return;
    state.resetChatState();
    state.setUiError(null);
    state.setMsgs((current) => current.slice(0, index));
    state.setInput(target.content);
    state.setAttachments(target.images ?? []);
    state.setDocuments(target.documents ?? []);
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }, []);

  const regenerateLast = useCallback(() => {
    const state = bubbleActionRef.current;
    if (!state.canRegenerate) return;
    state.setUiError(null);
    void state.regenerate();
  }, []);

  const continueLast = useCallback(() => {
    const state = bubbleActionRef.current;
    if (!state.canRegenerate) return;
    state.setUiError(null);
    void state.continueResponse();
  }, []);

  // Resolve the full automatic title with the user's action, before retrieval
  // or generation can finish and resize the conversation heading later. Queued
  // messages may start while another conversation is open, so this names the
  // live conversation, not the one on screen.
  const retitleLiveThread = (text: string) => {
    if (!text.trim() || !isGeneratedChatTitle(liveThread?.title)) return;
    setWorkspace((current) => ({
      ...current,
      threads: current.threads.map((thread) => thread.id === msgsThreadId && isGeneratedChatTitle(thread.title)
        ? { ...thread, title: titleFromMessage(text), updatedAt: Date.now() } : thread),
    }));
  };

  // The draft leaves the composer as soon as it is sent, so the composer is
  // free for the next message while this one is still being prepared.
  const sendMessage = () => {
    if (!canSend) return;
    setUiError(null);
    retitleLiveThread(input);
    void sendQueued(takeComposer());
  };

  const takeComposer = (): QueuedChatMessage => {
    const item = { id: crypto.randomUUID(), text: input, images: attachments, documents, skillIds: skills.selectedSkillIds.slice() };
    setInput('');
    setAttachments([]);
    setDocuments([]);
    skills.clearSelectedSkills();
    return item;
  };

  /** Ends whatever holds the conversation so `item` starts as soon as it can. */
  const steerWith = (item: QueuedChatMessage) => {
    // An earlier message waiting to steer keeps its place right after this one.
    if (steering) setQueue((current) => [steering, ...current]);
    setSteering(item);
    if (pendingToolCall) rejectPendingTool();
    else if (phase !== 'idle' && !aborting) stop();
  };

  const submitComposer = (mode: ChatBusySubmit) => {
    // With messages already waiting, a new one goes behind them unless the
    // queue was paused, which hands the next turn back to the user.
    if (canSend && (!hasQueued || queuePaused)) { sendMessage(); return; }
    if (!canQueue) return;
    setUiError(null);
    const item = takeComposer();
    if (mode === 'steer') steerWith(item);
    else setQueue((current) => [...current, item]);
  };

  // A message whose request never went out returns to an empty composer as it
  // was; if a newer draft is already there, it waits at the head of a paused queue.
  const composerRef = useRef({ input, attachments, documents });
  composerRef.current = { input, attachments, documents };
  const restoreUnsentRef = useRef<(message: QueuedChatMessage) => void>(() => undefined);
  restoreUnsentRef.current = (message) => {
    const composer = composerRef.current;
    if (!composer.input.trim() && composer.attachments.length === 0 && composer.documents.length === 0) {
      composerRef.current = { input: message.text, attachments: message.images, documents: message.documents };
      setInput(message.text);
      setAttachments(message.images);
      setDocuments(message.documents);
      skills.setSelectedSkillIds(message.skillIds);
      return;
    }
    setQueue((current) => [message, ...current]);
    setQueuePaused(true);
  };

  const steerQueued = (id: string) => {
    const item = queue.find((candidate) => candidate.id === id);
    if (!item) return;
    setQueue((current) => current.filter((candidate) => candidate.id !== id));
    steerWith(item);
  };
  const removeQueued = (id: string) => setQueue((current) => current.filter((candidate) => candidate.id !== id));
  const resumeQueue = () => {
    setError(null);
    setQueuePaused(false);
  };

  // A stop the user asked for, or a failed turn, must not be followed by the
  // next queued message on its own: the queue waits until it is resumed.
  const stopByUser = () => {
    if (hasQueued) setQueuePaused(true);
    stop();
  };
  const stopRef = useRef(stopByUser);
  stopRef.current = stopByUser;
  useEffect(() => {
    // Rejecting an approval to steer reports an error too; that one was asked for.
    if (error && queue.length > 0 && !steering) setQueuePaused(true);
  }, [error, queue.length, steering]);
  useEffect(() => {
    if (!hasQueued && queuePaused) setQueuePauseReason(null);
  }, [hasQueued, queuePaused]);
  // A model that was unloaded or failed to load stops the queue, steering
  // message included, until a model is running and the user resumes it.
  useEffect(() => {
    if (!modelUnavailable || !hasQueued) return;
    if (steering) {
      setQueue((current) => [steering, ...current]);
      setSteering(null);
    }
    if (queuePauseReason !== 'model') setQueuePauseReason('model');
  }, [modelUnavailable, hasQueued, steering, queuePauseReason]);

  const dispatchRef = useRef<() => void>(() => undefined);
  dispatchRef.current = () => {
    // A steering message runs past a pause or an error; the queue does not.
    const next = steering ?? (!queuePaused && !error ? queue[0] : undefined);
    if (!next) return;
    const modalitiesNow = modalities ?? { text: true, image: visionReady, audio: false, video: false };
    if (next.images.some(image => !canPrepareAttachment(image, modalitiesNow, mediaOptions))) {
      // Kept, not dropped: the user can remove it or switch to a capable session.
      if (steering) {
        setSteering(null);
        setQueue((current) => [next, ...current]);
      }
      setQueuePaused(true);
      setUiError(ct('unsupportedAttachment'));
      return;
    }
    if (steering) setSteering(null);
    else setQueue((current) => current.filter((candidate) => candidate.id !== next.id));
    setUiError(null);
    retitleLiveThread(next.text);
    void sendQueued(next);
  };
  // Started only after the finished turn is written back: the next turn's
  // history is read from the workspace, not from the buffer being released.
  useEffect(() => {
    if (turnReady && !writeBackPending) dispatchRef.current();
  }, [turnReady, writeBackPending, steering, queue, queuePaused, error]);

  const enterToSend = preferences?.chat.enterToSend ?? true;
  const otherSubmit: ChatBusySubmit = busySubmit === 'queue' ? 'steer' : 'queue';
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (including the keyCode 229 some engines report) must never send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitComposer(busySubmit);
      return;
    }
    // Alt+Enter picks the other busy action, so both stay one keystroke away.
    if (event.key === 'Enter' && event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (!turnBusy) return;
      event.preventDefault();
      submitComposer(otherSubmit);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && enterToSend) {
      event.preventDefault();
      submitComposer(busySubmit);
    }
  };

  const lastMessage = viewMessages.at(-1);
  const responseState: 'failed' | 'interrupted' | 'tool-request' | 'complete' | 'none' = visibleError || lastMessage?.failed ? 'failed'
    : lastMessage?.interrupted ? 'interrupted'
    : lastMessage?.finishReason === 'tool_calls' || lastMessage?.toolRound ? 'tool-request'
    : lastMessage?.role === 'assistant' ? 'complete' : 'none';
  // Retry belongs to the conversation that owns the live buffer, once nothing is running or awaiting approval.
  const recoverable = viewingLiveThread && phase === 'idle' && !pendingToolCall && !toolCallInProgress && unfinishedReply(lastMessage);
  const retry = useChatRetryTools({
    retryToolsMissing, mcpCatalog, selectedMcpTools, mcpCatalogLoaded,
    threadId: workspace.activeThreadId, reply: msgs.at(-1), viewingLiveThread,
    requireIdle, setSelectedMcpTools, mcpSelectionRevision, refreshMcpTools,
  });

  return {
    t, locale, ct, pt, modelSettings, phase, input, setInput, copied, composerDropRef, composerTextareaRef, isDragOver,
    session, sessionLoad, attachmentState, mcp, skills, threads, msgsThreadId, turn, project, scroll, retry,
    visiblePhase, visibleError, uiError, setUiError, ownerTitle, requireIdle, incompatibleMedia, chatSupported, generates,
    chatUnavailable, canSend, canEditMessages, canRegenerate, disabled, loadingModel, closeThreadPanel, startNewThread,
    copyMessage, editUserMessage, regenerateLast, continueLast, sendMessage,
    enterToSend, onKeyDown, lastMessage, responseState, recoverable,
    queueState: {
      queue, steering, queuePaused, queuePauseReason, modelUnavailable, canQueue, turnBusy, busySubmit,
      queueMessage: () => submitComposer('queue'), steerMessage: () => submitComposer('steer'),
      steerQueued, removeQueued, resumeQueue, stopByUser,
    },
  };
}
