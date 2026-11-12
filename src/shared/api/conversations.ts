import type { ChatThread } from './conversationTypes.ts';
import type { JsonValue } from '../config/tuningValidation.ts';
import { invoke } from './transport.ts';

export interface StoredConversations {
  threads: JsonValue[];
  /** Conversation folders the data folder holds but could not read. */
  warnings: string[];
}

export const conversationsLoad = (): Promise<StoredConversations> => invoke<StoredConversations>('conversations_load');
export const conversationsImport = (threads: ChatThread[]): Promise<number> => invoke<number>('conversations_import', { threads });
export const conversationsClear = (): Promise<void> => invoke<void>('conversations_clear');
export const conversationSave = (thread: ChatThread): Promise<void> => invoke<void>('conversation_save', { thread });
export const conversationDelete = (id: string): Promise<void> => invoke<void>('conversation_delete', { id });
