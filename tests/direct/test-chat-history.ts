import assert from "node:assert/strict";
import {
  CHAT_WORKSPACE_KEY,
  createChatThread,
  defaultChatWorkspace,
  loadChatWorkspace,
  loadChatWorkspaceAsync,
  mergeHydratedWorkspace,
  saveChatWorkspace,
  saveChatWorkspaceAsync,
  threadMatchesQuery,
  titleFromMessage,
  type ChatHistoryMessage,
  type ChatStorage,
} from "../../src/features/chat/chatHistory.ts";
import { storageAdapter } from "../../src/shared/storage/storageAdapter.ts";

function storage(): ChatStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

const empty = defaultChatWorkspace(1000);
assert.equal(empty.threads.length, 1);
assert.equal(empty.threads[0].id, "thread-1000");
assert.equal(empty.threads[0].systemPrompt, "");
assert.equal(titleFromMessage("  Explain local inference\nwith details "), "Explain local inference with details");
assert.equal(titleFromMessage(""), "New conversation");
assert.equal(titleFromMessage("긴 대화 제목을 생략하지 않습니다. ".repeat(20)), "긴 대화 제목을 생략하지 않습니다. ".repeat(20).trim());

const saved = {
  activeThreadId: "thread-2000",
  threads: [{
    ...createChatThread(2000, "thread-2000", "Qwen notes"),
    messages: [{
      role: "assistant" as const,
      content: "answer",
      citations: [{ name: "notes.md", path: "C:/safe/notes.md", offset: 12, score: 0.75 }],
      metrics: {
        pp: { tokens: 1536, durationMs: 800, tokensPerSecond: 1920 },
        tg: { tokens: 256, durationMs: 4000, tokensPerSecond: 64 },
        preparationMs: 50,
        firstTokenMs: 810,
        requestMs: 4820,
        cachedTokens: 128,
      },
    }],
  }],
};
const store = storage();
saveChatWorkspace(saved, store);
assert.deepEqual(loadChatWorkspace(store), saved);
const priorPrompt = { ...saved, threads: [{ ...saved.threads[0], systemPrompt: "Keep this conversation instruction." }] };
saveChatWorkspace(priorPrompt, store);
assert.equal(loadChatWorkspace(store).threads[0].systemPrompt, "Keep this conversation instruction.");

function workspaceWithMetrics(metrics: unknown) {
  return {
    ...saved,
    threads: [{
      ...saved.threads[0],
      messages: [{ role: "assistant" as const, content: "Retain this answer", metrics: metrics as ChatHistoryMessage["metrics"] }],
    }],
  };
}

const partialMetrics = { pp: { tokens: 0 }, tg: {}, requestMs: 20 };
const partialWorkspace = workspaceWithMetrics(partialMetrics);
saveChatWorkspace(partialWorkspace, store);
assert.deepEqual(loadChatWorkspace(store), partialWorkspace);

const damagedMetrics = {
  pp: { tokens: 0, durationMs: NaN, tokensPerSecond: -2, extra: 99 },
  tg: { tokens: 7, durationMs: Infinity },
  requestMs: 20,
  unknown: "discard",
};
const sanitizedMetrics = { pp: { tokens: 0 }, tg: { tokens: 7 }, requestMs: 20 };
saveChatWorkspace(workspaceWithMetrics(damagedMetrics), store);
assert.deepEqual(loadChatWorkspace(store).threads[0].messages[0].metrics, sanitizedMetrics);
store.setItem(CHAT_WORKSPACE_KEY, JSON.stringify(workspaceWithMetrics(damagedMetrics)));
assert.deepEqual(loadChatWorkspace(store).threads[0].messages[0].metrics, sanitizedMetrics);

const invalidMetrics = {
  pp: { tokens: NaN, durationMs: -1, tokensPerSecond: Infinity },
  tg: { tokens: "invalid" },
  firstTokenMs: null,
  requestMs: -1,
};
for (const value of [null, "invalid", {}, invalidMetrics]) {
  const workspace = workspaceWithMetrics(value);
  saveChatWorkspace(workspace, store);
  assert.deepEqual(loadChatWorkspace(store).threads[0].messages, [{ role: "assistant", content: "Retain this answer" }]);
  store.setItem(CHAT_WORKSPACE_KEY, JSON.stringify(workspace));
  assert.deepEqual(loadChatWorkspace(store).threads[0].messages, [{ role: "assistant", content: "Retain this answer" }]);
}

const legacyWorkspace = {
  ...saved,
  threads: [{ ...saved.threads[0], messages: [{ role: "assistant" as const, content: "Answer without metrics" }] }],
};
const legacyStore = storage();
legacyStore.setItem("aiolm.chat-workspace.v1", JSON.stringify(legacyWorkspace));
assert.deepEqual(loadChatWorkspace(legacyStore), legacyWorkspace);

assert.equal(threadMatchesQuery({ ...saved.threads[0], messages: [{ role: "user", content: "find this phrase" }] }, "phrase"), true);
assert.equal(threadMatchesQuery({ ...saved.threads[0], messages: [{ role: "user", content: "find this phrase" }] }, "missing"), false);

const initialWorkspace = {
  activeThreadId: "thread-local",
  threads: [
    {
      ...createChatThread(3000, "thread-local", "Local"),
      messages: [],
    },
    createChatThread(3001, "thread-deleted", "Deleted locally"),
  ],
};
const persistedWorkspace = {
  activeThreadId: "thread-persisted",
  threads: [
    {
      ...createChatThread(4000, "thread-local", "Persisted title"),
      messages: [{ role: "assistant" as const, content: "persisted answer" }],
    },
    {
      ...createChatThread(4001, "thread-other", "Other"),
      messages: [{ role: "user" as const, content: "other thread" }],
    },
    createChatThread(4002, "thread-deleted", "Persisted deleted copy"),
  ],
};
const editedBeforeHydration = {
  activeThreadId: "thread-local",
  threads: [{
    ...initialWorkspace.threads[0],
    title: "Edited locally",
    messages: [{ role: "user" as const, content: "typed before hydration" }],
  }],
};
const merged = mergeHydratedWorkspace(persistedWorkspace, editedBeforeHydration, initialWorkspace);
assert.equal(merged.threads.find((thread) => thread.id === "thread-local")?.title, "Edited locally");
assert.equal(merged.threads.find((thread) => thread.id === "thread-local")?.messages[0]?.content, "typed before hydration");
assert.equal(merged.threads.some((thread) => thread.id === "thread-other"), true);
assert.equal(merged.threads.some((thread) => thread.id === "thread-deleted"), false);
assert.equal(mergeHydratedWorkspace(persistedWorkspace, initialWorkspace, initialWorkspace).activeThreadId, "thread-persisted");

store.setItem("aiolm.chat-workspace.v1", "not-json");
assert.equal(loadChatWorkspace(store).threads.length, 1);

const originalWindow = (globalThis as { window?: unknown }).window;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { get localStorage() { throw new Error("blocked storage"); } },
});
assert.doesNotThrow(() => loadChatWorkspace());
Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
assert.doesNotThrow(() => loadChatWorkspace({
  getItem: () => { throw new Error("storage read blocked"); },
  setItem: () => { throw new Error("storage write blocked"); },
}));

const largeWorkspace = {
  activeThreadId: "thread-large",
  threads: [{
    ...createChatThread(5000, "thread-large"),
    messages: [{ role: "user" as const, content: "x".repeat(100_000) }],
  }],
};
const boundedStore = storage();
saveChatWorkspace(largeWorkspace, boundedStore);
assert.ok((loadChatWorkspace(boundedStore).threads[0]?.messages[0]?.content.length ?? 0) < 20_000);

const indexedValues = new Map<string, unknown>();
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const originalAdapterGet = storageAdapter.get;
const originalAdapterSet = storageAdapter.set;
Object.defineProperty(globalThis, "indexedDB", {
  configurable: true,
  value: {
    open(databaseName: string, version: number) {
      assert.equal(version, 1);
      const database = {
        close() {},
        transaction(storeName: string) {
          const transaction = {
            oncomplete: null as (() => void) | null,
            objectStore: () => ({
              get(key: string) {
                const request = { result: structuredClone(indexedValues.get(`${databaseName}/${storeName}/${key}`)), onsuccess: null as (() => void) | null };
                queueMicrotask(() => request.onsuccess?.());
                return request;
              },
              put(value: unknown, key: string) {
                indexedValues.set(`${databaseName}/${storeName}/${key}`, structuredClone(value));
                queueMicrotask(() => transaction.oncomplete?.());
              },
            }),
          };
          return transaction;
        },
      };
      const request = { result: database, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  },
});
try {
  for (const path of ["adapter", "compatibility"] as const) {
    if (path === "compatibility") {
      storageAdapter.get = async () => { throw new Error("Adapter unavailable"); };
      storageAdapter.set = async () => { throw new Error("Adapter unavailable"); };
    }
    const recordKey = path === "adapter" ? `aiolm-storage/values/${CHAT_WORKSPACE_KEY}` : "aiolm-chat/workspace/active";
    for (const workspace of [saved, partialWorkspace, legacyWorkspace]) {
      assert.equal(await saveChatWorkspaceAsync(workspace), "indexeddb");
      assert.deepEqual(indexedValues.get(recordKey), workspace);
      assert.deepEqual(await loadChatWorkspaceAsync(), workspace);
    }
    assert.equal(await saveChatWorkspaceAsync(workspaceWithMetrics(damagedMetrics)), "indexeddb");
    assert.deepEqual(indexedValues.get(recordKey), workspaceWithMetrics(sanitizedMetrics));
    indexedValues.set(recordKey, workspaceWithMetrics(damagedMetrics));
    assert.deepEqual((await loadChatWorkspaceAsync()).threads[0].messages[0].metrics, sanitizedMetrics);
    indexedValues.set(recordKey, workspaceWithMetrics(invalidMetrics));
    assert.deepEqual((await loadChatWorkspaceAsync()).threads[0].messages, [{ role: "assistant", content: "Retain this answer" }]);
  }
} finally {
  storageAdapter.get = originalAdapterGet;
  storageAdapter.set = originalAdapterSet;
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
}
console.log("chat history tests passed");
