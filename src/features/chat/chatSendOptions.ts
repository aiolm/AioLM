import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type * as api from "../../shared/api/types";
import type { EngineInfo } from "../../shared/api/providers";
import type { AppStore } from "../../shared/state/store";
import type { AppPreferences } from "../../shared/config/preferences";
import type { ChatHistoryMessage as Msg, ChatThread } from "../../shared/api/conversationTypes";
import type { DocumentAttachment, ImageAttachment } from "../../shared/api/mediaTypes";
import type { ModelProfile } from "../model-settings/profileEditor";
import type { ChatMcpTool } from "./useChatMcpTools";
import type { ChatPhase } from "./chatSendTypes";
import type { MediaPreprocessingOptions } from "./mediaPreprocessing";
import type { TurnPersonalization } from "./chatPersonalization";
import type { Locale } from "../../shared/i18n/i18nCatalog";

interface UseChatSendOptions {
  embeddingTarget?: { model: string; baseUrl: string; apiKey: string; namespace: string };
  engine?: EngineInfo;
  mediaPreprocessing?: MediaPreprocessingOptions;
  store: AppStore;
  effectiveConfig?: api.AppConfig | null;
  modelProfile?: ModelProfile | null;
  sessionId?: string;
  preferences?: AppPreferences;
  baseUrl: string | null;
  apiKey: string;
  model: string;
  activeThread: ChatThread | undefined;
  msgs: Msg[];
  setMsgs: Dispatch<SetStateAction<Msg[]>>;
  input: string;
  setInput: (value: string) => void;
  attachments: ImageAttachment[];
  documents: DocumentAttachment[];
  setAttachments: Dispatch<SetStateAction<ImageAttachment[]>>;
  setDocuments: Dispatch<SetStateAction<DocumentAttachment[]>>;
  mcpEntryByFunctionName: Map<string, ChatMcpTool>;
  mcpDefinitions: api.ChatToolDefinition[];
  atBottomRef: MutableRefObject<boolean>;
  phase: ChatPhase;
  setPhase: Dispatch<SetStateAction<ChatPhase>>;
  /** Skills picked in the composer for the next message. */
  selectedSkillIds?: string[];
  /** Clears the picker once a message carrying its selection is accepted. */
  onSkillsAccepted?: () => void;
  locale?: Locale;
}
export type { UseChatSendOptions };

export interface ChatTurnSnapshot {
  config: api.AppConfig | null;
  engine?: EngineInfo;
  mediaPreprocessing?: MediaPreprocessingOptions;
  embeddingTarget?: { model: string; baseUrl: string; apiKey: string; namespace: string };
  baseUrl: string;
  apiKey: string;
  model: string;
  sessionId: string;
  systemPrompt: string;
  mediaBeforeText: boolean;
  tools: api.ChatToolDefinition[];
  toolEntries: Map<string, ChatMcpTool>;
  /** Loaded once per new user turn; follow-ups and retries reuse it unchanged. */
  personalization: TurnPersonalization | null;
}
