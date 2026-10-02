import type * as api from "../../shared/api/types";
import { getChatPersonalization, readSkill, type AgentInstructionsFile, type ChatSkill, type PersonalizationSource } from "../../shared/api/personalization";
import type { ChatPersonalizationTextKey } from "../../shared/i18n/chatPersonalizationText";

/**
 * Local instructions and skills for one chat turn.
 *
 * Global AGENTS files and skill bodies are composed into the request's system
 * message only; they are never written into the conversation's own system
 * prompt or saved message history. A snapshot is taken once per new user turn
 * so retries and tool follow-ups keep the exact instructions they started with
 * even when the files change on disk.
 */

/** Read-only tool the model calls to load one SKILL.md from this turn's catalog. MCP function names always contain `__`, so this cannot collide with them. */
export const SKILL_TOOL_NAME = "aiolm_read_skill";
/** Automatic skill reads per response, counted separately from the MCP limit. */
export const MAX_SKILL_READS_PER_RESPONSE = 4;
const CATALOG_DESCRIPTION_LIMIT = 300;
const SKILL_ID_LIMIT = 200;
const SOURCE_ORDER: Record<PersonalizationSource, number> = { agents: 0, aiolm: 1 };
const SOURCE_TITLE: Record<PersonalizationSource, string> = {
  agents: "General agent instructions (.agents)",
  aiolm: "AioLM instructions (.aiolm)",
};

export interface InvokedSkill {
  skill: ChatSkill;
  content: string;
}

export interface TurnPersonalization {
  /** Existing, non-empty instruction files: `.agents` first, then `.aiolm`. */
  instructions: AgentInstructionsFile[];
  catalog: ChatSkill[];
  /** Skills the user selected or referenced with `$name`, resolved before the request. */
  invoked: InvokedSkill[];
  warnings: string[];
  /** Skill bodies already read in this turn, so a retry or follow-up never re-reads a changed file. */
  reads: Map<string, string>;
}

export function orderedInstructions(files: AgentInstructionsFile[]): AgentInstructionsFile[] {
  return files
    .filter((file) => file.exists && file.content.trim())
    .sort((left, right) => SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source]);
}

export function hasPersonalization(turn: TurnPersonalization | null | undefined): turn is TurnPersonalization {
  return !!turn && (turn.instructions.length > 0 || turn.catalog.length > 0 || turn.invoked.length > 0);
}

function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Global instructions first (later, more specific sections win), then the conversation's own prompt, then the skill catalog and invoked skills. */
export function buildPersonalizedSystemPrompt(basePrompt: string, turn: TurnPersonalization | null | undefined): string {
  if (!hasPersonalization(turn)) return basePrompt;
  const sections: string[] = [];
  if (turn.instructions.length > 0) {
    sections.push([
      "# Local instructions",
      "These come from the user's local instruction files. Later sections are more specific and take precedence over earlier ones.",
      ...turn.instructions.map((file) => `## ${SOURCE_TITLE[file.source]}\n${file.content.trim()}`),
    ].join("\n\n"));
  }
  sections.push(`# Conversation instructions\n${basePrompt}`);
  if (turn.catalog.length > 0) {
    sections.push([
      "# Skills",
      `Skills are optional instruction packages stored on this computer. When one is relevant to the request, call the \`${SKILL_TOOL_NAME}\` tool with its id to read its full instructions before following them. Only the ids listed here are valid.`,
      turn.catalog.map((skill) => `- id: ${skill.id} | name: ${oneLine(skill.name, 80)} | source: ${skill.source} | ${oneLine(skill.description, CATALOG_DESCRIPTION_LIMIT)}`).join("\n"),
    ].join("\n\n"));
  }
  if (turn.invoked.length > 0) {
    sections.push([
      "# Skills invoked by the user",
      "The user explicitly asked to use these skills for this message.",
      ...turn.invoked.map(({ skill, content }) => `## Skill: ${oneLine(skill.name, 80)} (${skill.id})\n${content.trim()}`),
    ].join("\n\n"));
  }
  return sections.join("\n\n");
}

export function skillToolDefinition(): api.ChatToolDefinition {
  return {
    type: "function",
    function: {
      name: SKILL_TOOL_NAME,
      description: "Read the full instructions (SKILL.md) of one skill listed in the system message's skill catalog. Read-only; it cannot run scripts or open other files.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "A skill id exactly as listed in the catalog." } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  };
}

/** Rejects anything that looks like a path before it can reach the native reader. */
export function isSafeSkillId(id: string): boolean {
  return id.length > 0 && id.length <= SKILL_ID_LIMIT && !/[/\\\u0000-\u001f\u007f]/.test(id) && !id.includes("..");
}

export type SkillToolCallResult = { skill: ChatSkill } | { error: string };

/** Validates a model's `aiolm_read_skill` arguments against this turn's catalog only. */
export function parseSkillToolCall(call: api.ChatToolCall, catalog: ChatSkill[]): SkillToolCallResult {
  let value: unknown;
  try {
    value = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { error: "Arguments must be a JSON object such as {\"id\": \"<skill id>\"}." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Arguments must be a JSON object such as {\"id\": \"<skill id>\"}." };
  const keys = Object.keys(value);
  const id = (value as { id?: unknown }).id;
  if (keys.length !== 1 || typeof id !== "string") return { error: "Arguments must contain only a string \"id\"." };
  if (!isSafeSkillId(id)) return { error: "The skill id is not valid. Use an id exactly as listed in the catalog." };
  const skill = catalog.find((item) => item.id === id);
  if (!skill) return { error: `Unknown skill id: ${id}. Use an id exactly as listed in the catalog.` };
  return { skill };
}

export function skillToolResult(skill: ChatSkill, content: string): string {
  return `Skill: ${skill.name} (${skill.id})\n\n${content}`;
}

/**
 * Finds `$skill-name` references (in any script) typed in a message. Code spans and fenced
 * blocks are ignored, as are amounts (`$5`), escaped `\$name`, inline math
 * (`$x^2$`) and all-caps words such as `$PATH` or `$USD`.
 */
export function findSkillReferences(text: string): string[] {
  let fence: string | null = null;
  const prose = text.split("\n").map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return "";
    }
    if (marker) {
      fence = marker;
      return "";
    }
    return line.replace(/(`+)[^`]*?\1/g, " ");
  }).join("\n").normalize("NFC");
  const names: string[] = [];
  // Skill names may use any script (native folder and front-matter names are Unicode), so letters are matched with \p{L}.
  const pattern = /(^|[^\p{L}\p{M}\p{N}_$\\])\$(\p{L}(?:[\p{L}\p{M}\p{N}_.:-]{0,62}[\p{L}\p{M}\p{N}_])?)(?=$|[\s.,;:!?)\]}"'。、，．！？：；）」』】〉》])/gmu;
  for (const match of prose.matchAll(pattern)) {
    const name = match[2];
    if (name === name.toUpperCase() && /\p{Lu}/u.test(name)) continue;
    if (!names.some((item) => item.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

export interface ResolvedSkillSelection {
  skills: ChatSkill[];
  unknownNames: string[];
  missingIds: string[];
}

/** Matches picker selections (by id) and `$name` references (by catalog name) against the turn catalog, deduplicated by id. */
export function resolveSkillSelection(text: string, selectedIds: string[], catalog: ChatSkill[]): ResolvedSkillSelection {
  const skills: ChatSkill[] = [];
  const add = (skill: ChatSkill) => { if (!skills.some((item) => item.id === skill.id)) skills.push(skill); };
  const missingIds: string[] = [];
  for (const id of selectedIds) {
    const skill = catalog.find((item) => item.id === id);
    if (skill) add(skill);
    else missingIds.push(id);
  }
  const unknownNames: string[] = [];
  for (const name of findSkillReferences(text)) {
    const catalogName = (item: ChatSkill) => item.name.normalize("NFC");
    const skill = catalog.find((item) => catalogName(item) === name) ?? catalog.find((item) => catalogName(item).toLowerCase() === name.toLowerCase());
    if (skill) add(skill);
    else unknownNames.push(name);
  }
  return { skills, unknownNames, missingIds };
}

type PersonalizationText = (key: ChatPersonalizationTextKey, vars?: Record<string, string | number>) => string;

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

async function readCatalogSkill(skill: ChatSkill): Promise<string> {
  const loaded = await readSkill(skill.id);
  if (loaded.skill.id !== skill.id) throw new Error(`expected ${skill.id}, received ${loaded.skill.id}`);
  return loaded.content;
}

/**
 * Loads a fresh snapshot for a new user turn and resolves the skills the user
 * invoked. Throws a user-facing message when loading fails or a requested
 * skill is unknown, so the caller can keep the unsent draft.
 */
export async function prepareTurnPersonalization(text: string, selectedIds: string[], signal: AbortSignal, pt: PersonalizationText): Promise<TurnPersonalization> {
  let context;
  try {
    context = await getChatPersonalization();
  } catch (caught) {
    throw new Error(pt("loadFailed", { error: errorMessage(caught) }));
  }
  signal.throwIfAborted();
  const catalog = context.skills.filter((skill) => isSafeSkillId(skill.id));
  const selection = resolveSkillSelection(text, selectedIds, catalog);
  if (selection.unknownNames.length > 0) throw new Error(pt("unknownSkill", { names: selection.unknownNames.map((name) => `$${name}`).join(", ") }));
  if (selection.missingIds.length > 0) throw new Error(pt("skillUnavailable", { names: selection.missingIds.join(", ") }));
  const reads = new Map<string, string>();
  const invoked: InvokedSkill[] = [];
  for (const skill of selection.skills) {
    let content: string;
    try {
      content = await readCatalogSkill(skill);
    } catch (caught) {
      signal.throwIfAborted();
      throw new Error(pt("skillReadFailed", { name: skill.name, error: errorMessage(caught) }));
    }
    signal.throwIfAborted();
    reads.set(skill.id, content);
    invoked.push({ skill, content });
  }
  return { instructions: orderedInstructions(context.instructions), catalog, invoked, warnings: context.warnings, reads };
}

/** Answers one `aiolm_read_skill` call. Invalid or unknown ids never reach the native reader; the model gets the error as the tool result. */
export async function answerSkillToolCall(call: api.ChatToolCall, turn: TurnPersonalization): Promise<{ skill: ChatSkill | null; content: string }> {
  const parsed = parseSkillToolCall(call, turn.catalog);
  if ("error" in parsed) return { skill: null, content: `Error: ${parsed.error}` };
  const { skill } = parsed;
  let content = turn.reads.get(skill.id);
  if (content === undefined) {
    try {
      content = await readCatalogSkill(skill);
    } catch (caught) {
      return { skill, content: `Error: could not read skill ${skill.id}: ${errorMessage(caught)}` };
    }
    turn.reads.set(skill.id, content);
  }
  return { skill, content: skillToolResult(skill, content) };
}

export function filterSkills(catalog: ChatSkill[], query: string): ChatSkill[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return catalog;
  return catalog.filter((skill) => skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle));
}
