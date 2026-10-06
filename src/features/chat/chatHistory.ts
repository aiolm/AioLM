import type { ChatCitation, DocumentAttachment, ImageAttachment } from "./chatTypes.ts";
import { invoke, isNativeRuntimeAvailable } from "../../shared/api/transport.ts";
import { storageAdapter } from "../../shared/storage/storageAdapter.ts";
import { sanitizeResponseMetrics, type ResponseMetrics } from "../../shared/lib/metrics.ts";
import { copyMediaPreparation, validMediaPreparation } from './mediaPreparationHistory.ts';

export type { ChatCitation } from "./chatTypes.ts";

export const CHAT_WORKSPACE_KEY = "aiolm.chat-workspace.v2";
const LEGACY_CHAT_WORKSPACE_KEY = "aiolm.chat-workspace.v1";
/** The open conversation. It is interface state, kept in the browser profile. */
const ACTIVE_THREAD_KEY = "aiolm.chat-active-thread.v1";
/** Set once this browser profile's conversations have moved into the data folder. */
const NATIVE_STORAGE_KEY = "aiolm.chat-storage.v1";
const CHAT_DB_NAME = "aiolm-chat";
const CHAT_DB_VERSION = 1;
const CHAT_STORE = "workspace";
const CHAT_RECORD_KEY = "active";
const LOCAL_IMAGE_LIMIT = 512 * 1024;
const LOCAL_DOCUMENT_LIMIT = 64 * 1024;
const PERSISTED_TEXT_LIMIT = 16 * 1024;
const PERSISTED_REASONING_LIMIT = 16 * 1024;
const PERSISTED_MESSAGES_LIMIT = 100;
const PERSISTED_THREADS_LIMIT = 100;
const PERSISTED_RAW_LIMIT = 4 * 1024 * 1024;

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** Model used for this response, captured when its request starts. */
  model?: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  reasoning?: string;
  interrupted?: boolean;
  failed?: boolean;
  citations?: ChatCitation[];
  metrics?: ResponseMetrics;
}

export interface ChatThread {
  id: string;
  title: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatHistoryMessage[];
}

export interface ChatWorkspace {
  activeThreadId: string;
  threads: ChatThread[];
}

export interface ChatStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  /** Optional so test doubles only need the read/write pair. */
  removeItem?: (key: string) => void;
}

export type ChatPersistenceResult = "native" | "indexeddb" | "local" | "unavailable";

function sameWorkspace(left: ChatWorkspace, right: ChatWorkspace): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function browserStorage(): ChatStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function validImage(value: unknown): value is ImageAttachment {
  if (value === null || typeof value !== "object") return false;
  const image = value as Partial<ImageAttachment>;
  return typeof image.name === "string" && typeof image.dataUrl === "string"
    && (image.kind === undefined || ['image', 'audio', 'video'].includes(image.kind))
    && (image.ref === undefined || /^[a-f0-9]{64}\.(?:png|jpe?g|webp|wav|mp3|flac|mp4|webm)$/.test(image.ref))
    && (image.preparation === undefined || validMediaPreparation(image.preparation, image));
}

function validDocument(value: unknown): value is DocumentAttachment {
  if (value === null || typeof value !== "object") return false;
  const document = value as Partial<DocumentAttachment>;
  return typeof document.name === "string"
    && typeof document.path === "string"
    && typeof document.text === "string";
}

function validCitation(value: unknown): value is ChatCitation {
  if (value === null || typeof value !== "object") return false;
  const citation = value as Partial<ChatCitation>;
  return typeof citation.name === "string"
    && typeof citation.path === "string"
    && typeof citation.offset === "number"
    && Number.isInteger(citation.offset)
    && citation.offset >= 0
    && (citation.score === undefined || (typeof citation.score === "number" && Number.isFinite(citation.score)));
}

function validMessage(value: unknown): value is ChatHistoryMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Partial<ChatHistoryMessage>;
  return (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string"
    && (message.images === undefined || (Array.isArray(message.images) && message.images.every(validImage)))
    && (message.documents === undefined || (Array.isArray(message.documents) && message.documents.every(validDocument)))
    && (message.reasoning === undefined || typeof message.reasoning === "string")
    && (message.interrupted === undefined || typeof message.interrupted === "boolean")
    && (message.failed === undefined || typeof message.failed === "boolean")
    && (message.citations === undefined || (Array.isArray(message.citations) && message.citations.every(validCitation)));
}

function normalizeThread(value: unknown): ChatThread | null {
  if (value === null || typeof value !== "object") return null;
  const thread = value as Partial<ChatThread>;
  if (typeof thread.id !== "string" || !thread.id || typeof thread.title !== "string") return null;
  if (!Array.isArray(thread.messages) || !thread.messages.every(validMessage)) return null;
  return {
    id: thread.id,
    title: thread.title.trim() || "New conversation",
    systemPrompt: typeof thread.systemPrompt === "string" ? thread.systemPrompt : "You are a helpful assistant.",
    createdAt: typeof thread.createdAt === "number" ? thread.createdAt : Date.now(),
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : Date.now(),
    messages: thread.messages,
  };
}

function normalizeWorkspace(value: unknown): ChatWorkspace | null {
  if (value === null || typeof value !== "object") return null;
  const parsed = value as Partial<ChatWorkspace>;
  const threads = Array.isArray(parsed.threads)
    ? parsed.threads.map(normalizeThread).filter((thread): thread is ChatThread => thread !== null)
    : [];
  if (!threads.length) return null;
  const activeThreadId = typeof parsed.activeThreadId === "string" && threads.some((thread) => thread.id === parsed.activeThreadId)
    ? parsed.activeThreadId
    : threads[0].id;
  return { activeThreadId, threads };
}

function parseWorkspace(raw: string | null): ChatWorkspace | null {
  if (!raw || raw.length > PERSISTED_RAW_LIMIT) return null;
  try {
    return normalizeWorkspace(JSON.parse(raw));
  } catch {
    return null;
  }
}

function safeThread(thread: ChatThread): ChatThread {
  return {
    ...thread,
    systemPrompt: thread.systemPrompt.slice(0, PERSISTED_TEXT_LIMIT),
    messages: thread.messages.slice(-PERSISTED_MESSAGES_LIMIT).map((message) => {
      const safeMessage: ChatHistoryMessage = {
        role: message.role,
        content: message.content.slice(0, PERSISTED_TEXT_LIMIT),
      };
      if (message.role === "assistant" && typeof message.model === "string" && message.model.trim()) {
        safeMessage.model = message.model.trim().slice(0, 4096);
      }
      if (message.reasoning !== undefined) safeMessage.reasoning = message.reasoning.slice(0, PERSISTED_REASONING_LIMIT);
      if (message.interrupted) safeMessage.interrupted = true;
      if (message.failed) safeMessage.failed = true;
      if (message.images !== undefined) {
        safeMessage.images = message.images.slice(0, 4).map((image) => ({
          name: image.name,
          ...(image.ref ? { ref: image.ref, kind: image.kind ?? 'image', mime: image.mime, sizeBytes: image.sizeBytes } : {}),
          ...(image.preparation && validMediaPreparation(image.preparation, image) ? { preparation: copyMediaPreparation(image.preparation) } : {}),
          dataUrl: image.ref ? '' : image.dataUrl.length <= (isNativeRuntimeAvailable() ? 64 * 1024 * 1024 : LOCAL_IMAGE_LIMIT) ? image.dataUrl : "",
        }));
      }
      if (message.documents !== undefined) {
        safeMessage.documents = message.documents.slice(0, 4).map((document) => ({
          ...document,
          text: document.text.slice(0, LOCAL_DOCUMENT_LIMIT),
        }));
      }
      if (message.citations !== undefined) safeMessage.citations = message.citations.slice(0, 64);
      const metrics = sanitizeResponseMetrics(message.metrics);
      if (metrics) safeMessage.metrics = metrics;
      return safeMessage;
    }),
  };
}

function localSafeWorkspace(workspace: ChatWorkspace): ChatWorkspace {
  const active = workspace.threads.find((thread) => thread.id === workspace.activeThreadId);
  const orderedThreads = active
    ? [active, ...workspace.threads.filter((thread) => thread.id !== active.id)]
    : workspace.threads;
  return {
    ...workspace,
    threads: orderedThreads.slice(0, PERSISTED_THREADS_LIMIT).map(safeThread),
  };
}

function persistedWorkspace(workspace: ChatWorkspace): ChatWorkspace {
  const safe = localSafeWorkspace(workspace);
  const threads = safe.threads.filter((thread) => thread.messages.length > 0 || thread.id === safe.activeThreadId);
  return {
    ...safe,
    threads: threads.length ? threads : [safe.threads[0]],
    activeThreadId: threads.some((thread) => thread.id === safe.activeThreadId)
      ? safe.activeThreadId
      : threads[0]?.id ?? safe.activeThreadId,
  };
}

function openChatDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CHAT_STORE)) request.result.createObjectStore(CHAT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
  });
}

async function readIndexedWorkspace(): Promise<ChatWorkspace | null> {
  const db = await openChatDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CHAT_STORE, "readonly").objectStore(CHAT_STORE).get(CHAT_RECORD_KEY);
    request.onsuccess = () => {
      db.close();
      const workspace = normalizeWorkspace(request.result);
      resolve(workspace ? persistedWorkspace(workspace) : null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error ?? new Error("IndexedDB read failed."));
    };
  });
}

async function writeIndexedWorkspace(workspace: ChatWorkspace): Promise<void> {
  const db = await openChatDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHAT_STORE, "readwrite");
    transaction.objectStore(CHAT_STORE).put(workspace, CHAT_RECORD_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB write failed."));
    };
  });
}

async function deleteIndexedWorkspace(): Promise<void> {
  const db = await openChatDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHAT_STORE, "readwrite");
    transaction.objectStore(CHAT_STORE).delete(CHAT_RECORD_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB delete failed."));
    };
  });
}

export function titleFromMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "New conversation";
  return compact;
}

export function createChatThread(
  now = Date.now(),
  id = `thread-${now}`,
  title = "New conversation",
): ChatThread {
  return {
    id,
    title,
    systemPrompt: "",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function defaultChatWorkspace(now = Date.now()): ChatWorkspace {
  const thread = createChatThread(now);
  return { activeThreadId: thread.id, threads: [thread] };
}

export function mergeHydratedWorkspace(
  persisted: ChatWorkspace,
  current: ChatWorkspace,
  initial: ChatWorkspace,
): ChatWorkspace {
  if (sameWorkspace(current, initial)) return persisted;

  const initialById = new Map(initial.threads.map((thread) => [thread.id, thread]));
  const currentById = new Map(current.threads.map((thread) => [thread.id, thread]));
  const merged = persisted.threads.flatMap((thread) => {
    const local = currentById.get(thread.id);
    const baseline = initialById.get(thread.id);
    if (!local && baseline) return [];
    const localChanged = local && (!baseline || JSON.stringify(local) !== JSON.stringify(baseline));
    return [localChanged ? local : thread];
  });
  for (const local of current.threads) {
    if (!persisted.threads.some((thread) => thread.id === local.id) && !initialById.has(local.id)) merged.push(local);
  }
  const activeThreadId = current.activeThreadId !== initial.activeThreadId && currentById.has(current.activeThreadId)
    ? current.activeThreadId
    : persisted.threads.some((thread) => thread.id === persisted.activeThreadId)
      ? persisted.activeThreadId
      : merged[0]?.id ?? current.activeThreadId;
  return { activeThreadId, threads: merged };
}

/** Removes the pre-migration localStorage copy of the workspace. */
export function dropLegacyChatWorkspace(storage: ChatStorage | null = browserStorage()): void {
  try {
    storage?.removeItem?.(LEGACY_CHAT_WORKSPACE_KEY);
  } catch {
    // Nothing to do when storage is unavailable.
  }
}

/**
 * Erases every stored conversation - the files in the data folder and all
 * three browser copies (IndexedDB, the localStorage mirror, and the
 * pre-migration key) - and returns a fresh workspace. Deleting a single thread
 * already removes it from storage; this is the "leave nothing behind" path
 * exposed in Settings.
 */
export async function clearChatWorkspace(): Promise<ChatWorkspace> {
  const fresh = defaultChatWorkspace();
  await clearBrowserConversations();
  if (isNativeRuntimeAvailable()) {
    await inNativeQueue(async () => {
      await invoke("conversations_clear");
      nativeWritten = new Map();
    });
  }
  return fresh;
}

async function clearBrowserConversations(): Promise<void> {
  const storage = browserStorage();
  try {
    storage?.removeItem?.(CHAT_WORKSPACE_KEY);
  } catch {
    // Continue; the remaining copies still need clearing.
  }
  dropLegacyChatWorkspace(storage);
  try {
    await storageAdapter.remove(CHAT_WORKSPACE_KEY);
  } catch {
    // The adapter is optional; the dedicated database is cleared below.
  }
  try {
    await deleteIndexedWorkspace();
  } catch {
    // No IndexedDB copy to clear.
  }
}

export function loadChatWorkspace(storage: ChatStorage | null = browserStorage()): ChatWorkspace {
  if (!storage) return defaultChatWorkspace();
  try {
    return persistedWorkspace(parseWorkspace(storage.getItem(CHAT_WORKSPACE_KEY))
      ?? parseWorkspace(storage.getItem(LEGACY_CHAT_WORKSPACE_KEY))
      ?? defaultChatWorkspace());
  } catch {
    return defaultChatWorkspace();
  }
}

export function saveChatWorkspace(
  workspace: ChatWorkspace,
  storage: ChatStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CHAT_WORKSPACE_KEY, JSON.stringify(persistedWorkspace(workspace)));
  } catch {
    // A full/blocked localStorage must not break chatting.
  }
}

/** Never rejects: a store that cannot be read yields what the browser holds. */
export async function loadChatWorkspaceAsync(): Promise<ChatWorkspace> {
  if (!isNativeRuntimeAvailable()) return loadBrowserWorkspace();
  try {
    return await loadNativeWorkspace();
  } catch (error) {
    console.error("Conversations could not be read from the data folder.", error);
    return loadBrowserWorkspace();
  }
}

async function loadBrowserWorkspace(): Promise<ChatWorkspace> {
  try {
    const stored = await storageAdapter.get<unknown>(CHAT_WORKSPACE_KEY);
    const normalized = normalizeWorkspace(stored);
    if (normalized) return persistedWorkspace(normalized);
    const legacy = parseWorkspace(browserStorage()?.getItem(LEGACY_CHAT_WORKSPACE_KEY) ?? null);
    if (legacy) {
      const migrated = persistedWorkspace(legacy);
      await storageAdapter.set(CHAT_WORKSPACE_KEY, migrated);
      // Drop the pre-migration copy; otherwise conversations the user later
      // deletes stay readable in localStorage forever.
      dropLegacyChatWorkspace();
      return migrated;
    }
  } catch {
    // Fall through to the dedicated IndexedDB/localStorage compatibility path.
  }
  try {
    const indexed = await readIndexedWorkspace();
    if (indexed) return indexed;
  } catch {
    // Fall back to the synchronous localStorage copy below.
  }
  return loadChatWorkspace();
}

export async function saveChatWorkspaceAsync(workspace: ChatWorkspace): Promise<ChatPersistenceResult> {
  if (isNativeRuntimeAvailable()) return saveNativeWorkspace(workspace);
  const safe = persistedWorkspace(workspace);
  saveChatWorkspace(safe);
  try {
    await storageAdapter.set(CHAT_WORKSPACE_KEY, safe);
    return "indexeddb";
  } catch {
    try {
      await writeIndexedWorkspace(safe);
      return "indexeddb";
    } catch {
      return browserStorage() ? "local" : "unavailable";
    }
  }
}

interface StoredConversations {
  threads: unknown[];
  /** Conversation folders the data folder holds but could not read. */
  warnings: string[];
}

/** Each conversation as last written to the data folder, so a save writes only what changed. */
let nativeWritten = new Map<string, string>();
let nativeQueue: Promise<void> = Promise.resolve();

function inNativeQueue<T>(task: () => Promise<T>): Promise<T> {
  const operation = nativeQueue.then(task, task);
  nativeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Nothing has been put into it yet; such a conversation gets no file. */
function untouched(thread: ChatThread): boolean {
  return thread.messages.length === 0 && !thread.systemPrompt.trim() && thread.title === "New conversation";
}

function readActiveThreadId(): string | null {
  try {
    return browserStorage()?.getItem(ACTIVE_THREAD_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeActiveThreadId(id: string): void {
  try {
    browserStorage()?.setItem(ACTIVE_THREAD_KEY, id);
  } catch {
    // The newest conversation opens instead.
  }
}

async function loadNativeWorkspace(): Promise<ChatWorkspace> {
  await moveBrowserConversations();
  const stored = await invoke<StoredConversations>("conversations_load");
  for (const warning of stored.warnings) console.warn(`A conversation file was left untouched: ${warning}`);
  // New conversations come first, as the workspace keeps them.
  const threads = stored.threads
    .map(normalizeThread)
    .filter((thread): thread is ChatThread => thread !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
  nativeWritten = new Map(threads.map((thread) => [thread.id, JSON.stringify(safeThread(thread))]));
  if (!threads.length) return defaultChatWorkspace();
  const active = readActiveThreadId();
  return persistedWorkspace({
    activeThreadId: threads.find((thread) => thread.id === active)?.id ?? threads[0].id,
    threads,
  });
}

/**
 * Moves the conversations an earlier release kept in this browser profile
 * into the data folder, once, never overwriting one stored there. The browser
 * copies are removed only after every conversation is found in the data
 * folder; from then on they cannot bring back one deleted there.
 */
async function moveBrowserConversations(): Promise<void> {
  const storage = browserStorage();
  if (storage?.getItem(NATIVE_STORAGE_KEY) === "native") return;
  const browser = await loadBrowserWorkspace();
  const threads = browser.threads.filter((thread) => !untouched(thread));
  if (threads.length) {
    await invoke<number>("conversations_import", { threads });
    const stored = await invoke<StoredConversations>("conversations_load");
    const ids = new Set(stored.threads.map((thread) => normalizeThread(thread)?.id));
    if (!threads.every((thread) => ids.has(thread.id))) {
      console.warn("Some conversations could not be moved to the data folder; the browser copies are kept.");
      return;
    }
    if (readActiveThreadId() === null) writeActiveThreadId(browser.activeThreadId);
  }
  try {
    storage?.setItem(NATIVE_STORAGE_KEY, "native");
  } catch {
    // Importing again finds every conversation already stored.
  }
  await clearBrowserConversations();
}

async function saveNativeWorkspace(workspace: ChatWorkspace): Promise<ChatPersistenceResult> {
  const safe = persistedWorkspace(workspace);
  writeActiveThreadId(safe.activeThreadId);
  const threads = safe.threads.filter((thread) => !untouched(thread));
  try {
    await inNativeQueue(async () => {
      for (const thread of threads) {
        const written = JSON.stringify(thread);
        if (nativeWritten.get(thread.id) === written) continue;
        await invoke("conversation_save", { thread });
        nativeWritten.set(thread.id, written);
      }
      // Deleted conversations, and the oldest ones past the kept limit.
      const kept = new Set(threads.map((thread) => thread.id));
      for (const id of [...nativeWritten.keys()]) {
        if (kept.has(id)) continue;
        await invoke("conversation_delete", { id });
        nativeWritten.delete(id);
      }
    });
    return "native";
  } catch (error) {
    console.error("Conversations could not be saved to the data folder.", error);
    return "unavailable";
  }
}

export function threadMatchesQuery(thread: ChatThread, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const fields = [thread.title, thread.systemPrompt];
  for (const message of thread.messages) {
    fields.push(message.content);
    for (const image of message.images ?? []) fields.push(image.name);
    for (const document of message.documents ?? []) fields.push(document.name, document.text);
  }
  return fields.some((field) => field.toLowerCase().includes(normalized));
}
