import { invoke, isNativeRuntimeAvailable } from "./transport.ts";

/** Where personal instructions and skills come from: AioLM's data folder or the shared `~/.agents`. */
export type PersonalizationSource = "aiolm" | "agents";

export interface AgentInstructionsFile {
  source: PersonalizationSource;
  path: string;
  exists: boolean;
  /** Text with any UTF-8 byte-order mark removed; empty when the file is missing. */
  content: string;
  /** SHA-256 of the bytes on disk, or null when the file is missing. */
  revision: string | null;
}

export interface ChatSkill {
  /** Opaque, stable, source-scoped catalog id to pass back to `readSkill`: usually `<source>:<folder>`, hashed for unusual folder names. */
  id: string;
  name: string;
  description: string;
  source: PersonalizationSource;
  path: string;
}

export interface ChatPersonalization {
  /** Shared (`agents`) instructions first, then AioLM's. */
  instructions: AgentInstructionsFile[];
  /** Metadata only; same-name skills resolve to the AioLM one. */
  skills: ChatSkill[];
  warnings: string[];
}

export interface SkillContent {
  skill: ChatSkill;
  content: string;
}

/** Window event the settings UI dispatches after a successful save so the chat reloads. */
export const PERSONALIZATION_CHANGED_EVENT = "aiolm-personalization-changed";

/** Prefix of the native error for a save whose expected revision no longer matches the file. */
const CONFLICT_PREFIX = "Save conflict:";

/** The browser preview has no files to read, so it chats without personalization. */
export function getChatPersonalization(): Promise<ChatPersonalization> {
  if (!isNativeRuntimeAvailable()) return Promise.resolve({ instructions: [], skills: [], warnings: [] });
  return invoke<ChatPersonalization>("chat_personalization");
}

export const readSkill = (id: string) => invoke<SkillContent>("personalization_read_skill", { id });

export const readAgentsFile = (source: PersonalizationSource) =>
  invoke<AgentInstructionsFile>("personalization_read_agents", { source });

/** Saves only while the file still has `expectedRevision` (null: still missing) and returns it with its new revision. */
export const saveAgentsFile = (source: PersonalizationSource, content: string, expectedRevision: string | null) =>
  invoke<AgentInstructionsFile>("personalization_save_agents", { source, content, expectedRevision });

/** True when a save was refused because the file changed after it was read; nothing was written. */
export function isAgentsFileConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.startsWith(CONFLICT_PREFIX);
}
