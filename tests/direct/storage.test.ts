// @vitest-environment node
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { storageAdapter, storageSchema } from "../../src/shared/storage/storageAdapter.ts";
import { CHAT_WORKSPACE_KEY, loadChatWorkspaceAsync, saveChatWorkspaceAsync } from "../../src/features/chat/chatHistory.ts";
import { createChatThread } from "../../src/features/chat/chatWorkspace.ts";

test("storage contracts", async () => {
  assert.deepEqual(storageSchema(), { name: "aiolm-storage", version: 1, store: "values" });
});

test("fallback writes supersede stale IndexedDB values until IndexedDB writes recover", async () => {
  const values = new Map<string, string>();
  const indexedValues = new Map<string, unknown>();
  let failWrites = true;
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  vi.stubGlobal("indexedDB", {
    open() {
      const database = {
        close() {},
        transaction(_store: string, mode: string) {
          if (mode === "readwrite" && failWrites) throw new Error("Synthetic write failure");
          const transaction = {
            oncomplete: null as (() => void) | null,
            objectStore: () => ({
              get(key: string) {
                const request = { result: structuredClone(indexedValues.get(key)), onsuccess: null as (() => void) | null };
                queueMicrotask(() => request.onsuccess?.());
                return request;
              },
              put(value: unknown, key: string) {
                indexedValues.set(key, structuredClone(value));
                queueMicrotask(() => transaction.oncomplete?.());
              },
              delete(key: string) {
                indexedValues.delete(key);
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
  });
  try {
    indexedValues.set("revision", { revision: 1 });
    assert.equal(await storageAdapter.set("revision", { revision: 2 }), "local");
    assert.equal(values.get("revision"), '{"revision":2}');
    assert.deepEqual(await storageAdapter.get("revision"), { revision: 2 });

    const thread = createChatThread(1, "synthetic-thread");
    const older = { activeThreadId: thread.id, threads: [thread] };
    const newer = { ...older, threads: [{ ...thread, systemPrompt: "Synthetic revised instructions" }] };
    indexedValues.set(CHAT_WORKSPACE_KEY, older);
    assert.equal(await saveChatWorkspaceAsync(newer), "local");
    assert.deepEqual(await loadChatWorkspaceAsync(), newer);

    failWrites = false;
    assert.equal(await storageAdapter.set("revision", { revision: 3 }), "indexeddb");
    values.set("revision", '{"revision":4}');
    assert.deepEqual(await storageAdapter.get("revision"), { revision: 3 }, "A synchronous mirror is not a fallback write.");
    assert.equal(await saveChatWorkspaceAsync(older), "indexeddb");
    assert.deepEqual(await loadChatWorkspaceAsync(), older);

    failWrites = true;
    await storageAdapter.set("revision", { revision: 5 });
    failWrites = false;
    await storageAdapter.remove("revision");
    assert.equal(await storageAdapter.get("revision"), null);
    indexedValues.set("revision", { revision: 6 });
    values.set("revision", '{"revision":7}');
    assert.deepEqual(await storageAdapter.get("revision"), { revision: 6 }, "Removal clears fallback precedence as well as the stored value.");
  } finally {
    vi.unstubAllGlobals();
  }
});
