import { useCallback, useRef, useState } from 'react';
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
import type { ChatPhase } from './chatSendTypes';
import { titleFromMessage } from './chatWorkspace';
import { unfinishedReply } from './chatRetrySnapshot';
import { useChatSkills } from './useChatSkills';
import { canPrepareAttachment } from './mediaPreprocessing';
import { chatTemplateCopy } from './chatTemplateCopy';
import { chatTaskCopy } from './chatTaskCopy';
import { useProjectChatBinding } from './useProjectChatBinding';
import { displayChatTitle } from './chatThreadTitle';
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
  const [copiedMessage, showCopied] = useFlashMessage(1800);
  const copied = copiedMessage === null ? null : Number(copiedMessage);
  const session = useChatSession({ store, active, modelSettings, t, locale });
  const {
    selectedSessionId, selectedStatus, embeddingSelection, embeddingChoice,
    mediaOptions, serverOn, modalities, visionReady, baseUrl, apiKey, model, effectiveConfig,
  } = session;
  const composerDropRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const attachmentState = useChatAttachments({ visionReady, modalities, locale,
    audioPreprocessAvailable: !!mediaOptions.audioSessionId, videoPreprocessAvailable: session.videoFrames && visionReady,
    setError: (message) => setError(message) });
  const { attachments, documents, attachmentStatus, setAttachments, setDocuments, addDroppedAttachments, clearComposerAttachments } = attachmentState;
  const mcp = useChatMcpTools();
  const { mcpCatalog, mcpCatalogLoaded, selectedMcpTools, setSelectedMcpTools, mcpSelectionRevision, refreshMcpTools, mcpEntryByFunctionName, mcpDefinitions } = mcp;
  const skills = useChatSkills();

  const requireIdle = () => {
    if (phase === 'idle' && !pendingToolCall) return true;
    setError(ct('stopCurrentResponseFirst'));
    return false;
  };

  const resetComposer = () => {
    setInput('');
    clearComposerAttachments();
    skills.clearSelectedSkills();
    resetChatState();
    setComposerRevision((revision) => revision + 1);
  };

  const threads = useChatThreads({ phase, hasPendingTurn: () => pendingToolCall !== null, requireIdle, onSwitchThread: resetComposer, defaultThreadTitle: ct('newConversation') });
  const {
    workspace, setWorkspace, activeThread, liveThread, msgs, setMsgs, viewMessages,
    viewingLiveThread, clearingWorkspace, setThreadPanelOpen, updateActiveThread,
  } = threads;
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
  });
  const { setError, error, aborting, pendingToolCall, toolCallInProgress, retryToolsMissing, send, resetChatState } = turn;

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
  const canSend = viewingLiveThread && serverOn && chatSupported && !startingSession && !clearingWorkspace && generates && !!apiKey && !!model && !incompatibleMedia && attachmentStatus !== 'reading' && !projectDocumentsLoading && !projectDocumentsError && phase === 'idle' && !pendingToolCall && !aborting && !store.busy && (!!input.trim() || attachments.length > 0 || documents.length > 0);
  const disabled = !serverOn || !model || !apiKey;
  const loadingModel = !serverOn && selectedStatus.state !== 'failed' && selectedStatus.state !== 'crashed' && (selectedStatus.state === 'starting' || store.busy || startingSession);
  useNativeAttachmentDrop({ targetRef: composerDropRef, active,
    enabled: viewingLiveThread && !disabled && phase === 'idle' && pendingToolCall === null && attachmentStatus !== 'reading'
      && !(documents.length >= 4 && attachments.length >= 4),
    onDrop: addDroppedAttachments, setError });

  const scroll = useChatScroll(viewMessages, visiblePhase, atBottomRef);
  const closeThreadPanel = useCallback(() => setThreadPanelOpen(false), [setThreadPanelOpen]);

  // Stable identity (not the inline `ct` closure) so MessageBubble's memo bailout
  // survives streaming re-renders of ChatPanel; see MessageBubble.tsx's doc comment.
  const copyMessage = useCallback((index: number, text: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        showCopied(String(index));
      } catch (caught) {
        setError(`${t('chat.requestFailed')}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    })();
  }, [t, setError, showCopied]);

  const sendMessage = () => {
    if (!canSend) return;
    // Resolve the full automatic title with the user's action, before retrieval
    // or generation can finish and resize the conversation heading later.
    if (activeThread?.title === 'New conversation' && input.trim()) {
      updateActiveThread({ title: titleFromMessage(input) });
    }
    void send(false, undefined, canSend);
  };

  const enterToSend = preferences?.chat.enterToSend ?? true;
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (including the keyCode 229 some engines report) must never send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey && enterToSend) {
      event.preventDefault();
      sendMessage();
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
    t, locale, ct, pt, modelSettings, phase, input, setInput, copied, composerDropRef,
    session, sessionLoad, attachmentState, mcp, skills, threads, turn, project, scroll, retry,
    visiblePhase, visibleError, ownerTitle, requireIdle, incompatibleMedia, chatSupported, generates,
    chatUnavailable, canSend, disabled, loadingModel, closeThreadPanel, copyMessage, sendMessage,
    enterToSend, onKeyDown, lastMessage, responseState, recoverable,
  };
}
