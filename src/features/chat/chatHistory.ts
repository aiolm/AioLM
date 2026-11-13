import type { ChatThread, ChatWorkspace, ChatStorage, ChatPersistenceResult, ChatWorkspaceClearDetail } from "../../shared/api/conversationTypes.ts";
import { isNativeRuntimeAvailable } from "../../shared/api/transport.ts";
import { conversationDelete, conversationSave, conversationsClear, conversationsImport, conversationsLoad, type StoredConversations } from "../../shared/api/conversations.ts";
import { storageAdapter } from "../../shared/storage/storageAdapter.ts";
import { isPristineThread, normalizeThread, normalizeWorkspace, parseWorkspace, persistedWorkspace, safeThread } from "./chatHistorySchema.ts";
import { defaultChatWorkspace } from "./chatWorkspace.ts";

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

/** Every mounted conversation participates in deleting the shared workspace. */
export const CHAT_WORKSPACE_CLEAR_EVENT = "aiolm:chat-workspace-clear";
let clearingWorkspace = false;
let clearOperation: Promise<ChatWorkspace> | null = null;
const historyOperations = new Set<Promise<unknown>>();

export function isChatWorkspaceClearing(): boolean { return clearingWorkspace; }

function notifyWorkspaceClear(detail: ChatWorkspaceClearDetail): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHAT_WORKSPACE_CLEAR_EVENT, { detail }));
}

function trackHistoryOperation<T>(operation: Promise<T>): Promise<T> {
  historyOperations.add(operation);
  void operation.then(() => historyOperations.delete(operation), () => historyOperations.delete(operation));
  return operation;
}

function browserStorage(): ChatStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
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
      resolve(workspace ? persistedWorkspace(workspace, isNativeRuntimeAvailable()) : null);
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
  if (typeof indexedDB === "undefined") return;
  const db = await openChatDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CHAT_STORE, "readwrite");
      transaction.objectStore(CHAT_STORE).delete(CHAT_RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB delete failed."));
    });
  } finally { db.close(); }
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
export function clearChatWorkspace(clearRelatedData?: () => Promise<void>): Promise<ChatWorkspace> {
  if (clearOperation) return clearOperation;
  clearingWorkspace = true;
  notifyWorkspaceClear({ state: "clearing" });
  const operation = (async () => {
    try {
      // Reads can migrate browser data and saves may already be queued. They
      // must settle before deletion, so none can restore an older copy later.
      await Promise.allSettled([...historyOperations]);
      const results = await Promise.allSettled([
        clearBrowserConversations(),
        isNativeRuntimeAvailable() ? inNativeQueue(async () => {
          await conversationsClear();
          nativeWritten = new Map();
        }) : Promise.resolve(),
        Promise.resolve().then(() => clearRelatedData?.()),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const fresh = defaultChatWorkspace();
      clearingWorkspace = false;
      notifyWorkspaceClear({ state: "cleared", workspace: fresh });
      return fresh;
    } catch (error) {
      clearingWorkspace = false;
      notifyWorkspaceClear({ state: "failed" });
      throw error;
    } finally {
      clearOperation = null;
    }
  })();
  clearOperation = operation;
  return operation;
}

async function clearBrowserConversations(): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => {
      if (typeof window !== "undefined") window.localStorage.removeItem(LEGACY_CHAT_WORKSPACE_KEY);
    }),
    storageAdapter.remove(CHAT_WORKSPACE_KEY),
    deleteIndexedWorkspace(),
  ]);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export function loadChatWorkspace(storage: ChatStorage | null = browserStorage()): ChatWorkspace {
  if (clearingWorkspace || !storage) return defaultChatWorkspace();
  try {
    return persistedWorkspace(parseWorkspace(storage.getItem(CHAT_WORKSPACE_KEY))
      ?? parseWorkspace(storage.getItem(LEGACY_CHAT_WORKSPACE_KEY))
      ?? defaultChatWorkspace(), isNativeRuntimeAvailable());
  } catch {
    return defaultChatWorkspace();
  }
}

export function saveChatWorkspace(
  workspace: ChatWorkspace,
  storage: ChatStorage | null = browserStorage(),
): void {
  if (clearingWorkspace || !storage) return;
  try {
    storage.setItem(CHAT_WORKSPACE_KEY, JSON.stringify(persistedWorkspace(workspace, isNativeRuntimeAvailable())));
  } catch {
    // A full/blocked localStorage must not break chatting.
  }
}

/** Never rejects: a store that cannot be read yields what the browser holds. */
export function loadChatWorkspaceAsync(): Promise<ChatWorkspace> {
  if (clearingWorkspace) return Promise.resolve(defaultChatWorkspace());
  return trackHistoryOperation((async () => {
    if (!isNativeRuntimeAvailable()) return loadBrowserWorkspace();
    try {
      return await loadNativeWorkspace();
    } catch (error) {
      console.error("Conversations could not be read from the data folder.", error);
      return loadBrowserWorkspace();
    }
  })());
}

async function loadBrowserWorkspace(): Promise<ChatWorkspace> {
  try {
    const stored = await storageAdapter.get<unknown>(CHAT_WORKSPACE_KEY);
    const normalized = normalizeWorkspace(stored);
    if (normalized) return persistedWorkspace(normalized, isNativeRuntimeAvailable());
    const legacy = parseWorkspace(browserStorage()?.getItem(LEGACY_CHAT_WORKSPACE_KEY) ?? null);
    if (legacy) {
      const migrated = persistedWorkspace(legacy, isNativeRuntimeAvailable());
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

export function saveChatWorkspaceAsync(workspace: ChatWorkspace): Promise<ChatPersistenceResult> {
  if (clearingWorkspace) return Promise.resolve("unavailable");
  return trackHistoryOperation((async () => {
    if (isNativeRuntimeAvailable()) return saveNativeWorkspace(workspace);
    const safe = persistedWorkspace(workspace, isNativeRuntimeAvailable());
    saveChatWorkspace(safe);
    try {
      return await storageAdapter.set(CHAT_WORKSPACE_KEY, safe);
    } catch {
      try {
        await writeIndexedWorkspace(safe);
        return "indexeddb";
      } catch {
        try {
          const storage = browserStorage();
          if (!storage) return "unavailable";
          storage.setItem(CHAT_WORKSPACE_KEY, JSON.stringify(safe));
          return "local";
        } catch {
          return "unavailable";
        }
      }
    }
  })());
}


/** Each conversation as last written to the data folder, so a save writes only what changed. */
let nativeWritten = new Map<string, string>();
let nativeQueue: Promise<void> = Promise.resolve();

function inNativeQueue<T>(task: () => Promise<T>): Promise<T> {
  const operation = nativeQueue.then(task, task);
  nativeQueue = operation.then(() => undefined, () => undefined);
  return operation;
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
  const stored = await moveBrowserConversations() ?? await conversationsLoad();
  for (const warning of stored.warnings) console.warn(`A conversation file was left untouched: ${warning}`);
  // New conversations come first, as the workspace keeps them.
  const threads = stored.threads
    .map(normalizeThread)
    .filter((thread): thread is ChatThread => thread !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
  nativeWritten = new Map(threads.map((thread) => [thread.id, JSON.stringify(safeThread(thread, isNativeRuntimeAvailable()))]));
  const first = threads[0];
  if (!first) return defaultChatWorkspace();
  const active = readActiveThreadId();
  return persistedWorkspace({
    activeThreadId: threads.find((thread) => thread.id === active)?.id ?? first.id,
    threads,
  }, isNativeRuntimeAvailable());
}

/**
 * Moves the conversations an earlier release kept in this browser profile
 * into the data folder, once, never overwriting one stored there. The browser
 * copies are removed only after every conversation is found in the data
 * folder; from then on they cannot bring back one deleted there.
 */
async function moveBrowserConversations(): Promise<StoredConversations | undefined> {
  const storage = browserStorage();
  if (storage?.getItem(NATIVE_STORAGE_KEY) === "native") return;
  const browser = await loadBrowserWorkspace();
  const threads = browser.threads.filter((thread) => !isPristineThread(thread));
  let stored: StoredConversations | undefined;
  if (threads.length) {
    await conversationsImport(threads);
    stored = await conversationsLoad();
    const ids = new Set(stored.threads.map((thread) => normalizeThread(thread)?.id));
    if (!threads.every((thread) => ids.has(thread.id))) {
      console.warn("Some conversations could not be moved to the data folder; the browser copies are kept.");
      return stored;
    }
    if (readActiveThreadId() === null) writeActiveThreadId(browser.activeThreadId);
  }
  await clearBrowserConversations();
  try {
    storage?.setItem(NATIVE_STORAGE_KEY, "native");
  } catch {
    // Importing again finds every conversation already stored.
  }
  return stored;
}

async function saveNativeWorkspace(workspace: ChatWorkspace): Promise<ChatPersistenceResult> {
  const safe = persistedWorkspace(workspace, isNativeRuntimeAvailable());
  writeActiveThreadId(safe.activeThreadId);
  const threads = safe.threads.filter((thread) => !isPristineThread(thread));
  try {
    await inNativeQueue(async () => {
      for (const thread of threads) {
        const written = JSON.stringify(thread);
        if (nativeWritten.get(thread.id) === written) continue;
        await conversationSave(thread);
        nativeWritten.set(thread.id, written);
      }
      // Deleted conversations, and the oldest ones past the kept limit.
      const kept = new Set(threads.map((thread) => thread.id));
      for (const id of [...nativeWritten.keys()]) {
        if (kept.has(id)) continue;
        await conversationDelete(id);
        nativeWritten.delete(id);
      }
    });
    return "native";
  } catch (error) {
    console.error("Conversations could not be saved to the data folder.", error);
    return "unavailable";
  }
}
