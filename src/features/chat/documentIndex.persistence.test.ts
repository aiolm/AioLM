import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDocumentIndex,
  indexRecordForChunks,
  loadDocumentVectors,
  removeDocumentVectorsForPaths,
  saveDocumentVectors,
  type DocumentIndexRecord,
} from "./documentIndex";
import type { DocumentChunk } from "./chatTypes";

type FixtureRequest<T> = {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
};

function request<T>(): FixtureRequest<T> {
  return { result: undefined as T, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
}

const clone = <T,>(value: T): T => structuredClone(value);

/** Only the IndexedDB surface used by this cache, with independently staged
 * transactions and string primary keys. This does not model native RW locking
 * or active/inactive event windows. Request success and commit are separate. */
function indexDbFixture() {
  let committed = new Map<string, unknown>();
  const calls = { clear: 0, put: 0, delete: 0 };
  let created = false;
  let connections = 0;
  const active = new Set<Promise<void>>();
  type Gate = { requestsDone: Promise<void>; ready: () => void; complete: () => void; abort: () => void };
  let nextGate: Gate | undefined;
  type OpenGate = { opened: Promise<void>; ready: () => void; release: () => void };
  let nextOpen: OpenGate | undefined;
  const entries = (records: Map<string, unknown>) => [...records.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const snapshot = () => entries(committed).map(([, value]) => clone(value)) as DocumentIndexRecord[];
  const factory = {
    open(name: string, version: number) {
      if (name !== "aiolm-document-index" || version !== 1) throw new Error("Unexpected database identity");
      const opened = request<unknown>();
      const open = () => queueMicrotask(() => {
        connections += 1;
        let closed = false;
        const db = {
          objectStoreNames: { contains: (name: string) => name === "embeddings" && created },
          createObjectStore(name: string, options: IDBObjectStoreParameters) {
            if (name !== "embeddings" || options.keyPath !== "key") throw new Error("Unexpected store schema");
            created = true;
          },
          close() { if (!closed) { closed = true; connections -= 1; } },
          transaction(name: string, mode: IDBTransactionMode) {
            if (name !== "embeddings" || !created) throw new Error("Unexpected store");
            const staged = new Map([...committed].map(([key, value]) => [key, clone(value)]));
            const operations: Array<() => void> = [];
            const gate = mode === "readwrite" ? nextGate : undefined;
            if (mode === "readwrite") nextGate = undefined;
            let finish!: () => void;
            const done = new Promise<void>((resolve) => { finish = resolve; });
            active.add(done);
            let finished = false;
            const transaction = {
              error: null as DOMException | null,
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              onabort: null as (() => void) | null,
              objectStore(name: string) {
                if (name !== "embeddings") throw new Error("Unexpected store");
                const enqueue = <T,>(operation: () => T) => {
                  if (finished) throw new Error("Transaction is inactive");
                  const result = request<T>();
                  operations.push(() => { result.result = operation(); result.onsuccess?.(); });
                  return result;
                };
                const mutate = <T,>(operation: () => T) => {
                  if (mode !== "readwrite") throw new Error("Readonly transaction");
                  return enqueue(operation);
                };
                return {
                  getAll: () => enqueue(() => entries(staged).map(([, value]) => clone(value))),
                  getAllKeys: () => enqueue(() => entries(staged).map(([key]) => key)),
                  put: (record: DocumentIndexRecord) => {
                    const stored = clone(record);
                    calls.put += 1;
                    return mutate(() => { staged.set(stored.key, stored); return stored.key; });
                  },
                  delete: (key: string) => { calls.delete += 1; return mutate(() => { staged.delete(key); }); },
                  clear: () => { calls.clear += 1; return mutate(() => { staged.clear(); }); },
                };
              },
              abort() { complete(false); },
            };
            const complete = (commit: boolean) => {
              if (finished) return;
              finished = true;
              if (commit) {
                if (mode === "readwrite") committed = staged;
                transaction.oncomplete?.();
              } else {
                transaction.error = new DOMException("Synthetic transaction commit failed", "AbortError");
                transaction.onabort?.();
              }
              active.delete(done);
              finish();
            };
            queueMicrotask(() => {
              for (const operation of operations) {
                if (finished) break;
                operation();
              }
              if (gate) {
                gate.complete = () => complete(true);
                gate.abort = () => complete(false);
                gate.ready();
              } else complete(true);
            });
            return transaction;
          },
        };
        opened.result = db;
        if (!created) opened.onupgradeneeded?.();
        opened.onsuccess?.();
      });
      const gate = nextOpen;
      nextOpen = undefined;
      if (gate) { gate.release = open; gate.ready(); } else open();
      return opened;
    },
  };

  return {
    factory: factory as unknown as IDBFactory,
    snapshot,
    calls,
    // Pre-existing persisted rows are setup data, never filtered or bounded by
    // the fixture. All mutations under test run through the production API.
    seed(records: DocumentIndexRecord[]) {
      created = true;
      committed = new Map(records.map((record) => [record.key, clone(record)]));
    },
    seedRaw(records: Array<[string, unknown]>) {
      created = true;
      committed = new Map(records.map(([key, value]) => [key, clone(value)]));
    },
    holdNextOpen() {
      let ready!: () => void;
      const opened = new Promise<void>((resolve) => { ready = resolve; });
      const gate = { opened, ready, release: () => {} };
      nextOpen = gate;
      return gate;
    },
    holdNextWrite() {
      let ready!: () => void;
      const requestsDone = new Promise<void>((resolve) => { ready = resolve; });
      const gate = { requestsDone, ready, complete: () => {}, abort: () => {} };
      nextGate = gate;
      return gate;
    },
    async idle() { await Promise.all(active); },
    get connections() { return connections; },
  };
}

const chunk = (path: string): DocumentChunk => ({
  document: { name: path.split("/").at(-1)!, path, text: "synthetic document body" },
  text: "synthetic document body", offset: 0, score: 0, order: 0,
});

let database: ReturnType<typeof indexDbFixture>;
let previousStorage: Array<[string, string]>;

beforeEach(() => {
  previousStorage = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!]);
  localStorage.clear();
  database = indexDbFixture();
  vi.stubGlobal("indexedDB", database.factory);
});

afterEach(async () => {
  try {
    // This queued public mutation is also a barrier behind every prior save or
    // removal, before restoring globals or discarding this isolated database.
    await clearDocumentIndex();
    await database.idle();
    expect(database.connections).toBe(0);
  } finally {
    localStorage.clear();
    for (const [key, value] of previousStorage) localStorage.setItem(key, value);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("IndexedDB document vector persistence", () => {
  it("removes a saved path while preserving another complete persisted record", async () => {
    const alpha = chunk("/synthetic/alpha.txt");
    const beta = chunk("/synthetic/beta.txt");
    await saveDocumentVectors("model", [alpha], [[1, 0]], "endpoint");
    await saveDocumentVectors("model", [beta], [[0, 1]], "endpoint");
    // Upserting beta must leave alpha: the fixture never clears on its own.
    expect(database.snapshot()).toHaveLength(2);
    expect(await loadDocumentVectors("model", [alpha], "endpoint")).toEqual([[1, 0]]);
    expect(await loadDocumentVectors("model", [beta], "endpoint")).toEqual([[0, 1]]);
    const betaBefore = database.snapshot().find((record) => record.path === beta.document.path)!;

    expect(await removeDocumentVectorsForPaths([alpha.document.path])).toBe(1);

    expect(await loadDocumentVectors("model", [alpha], "endpoint")).toBeNull();
    expect(await loadDocumentVectors("model", [beta], "endpoint")).toEqual([[0, 1]]);
    expect(database.snapshot()).toEqual([betaBefore]);
    expect(await removeDocumentVectorsForPaths([alpha.document.path])).toBe(0);
    expect(await removeDocumentVectorsForPaths(["/synthetic/absent.txt"])).toBe(0);
    expect(await removeDocumentVectorsForPaths([])).toBe(0);
    expect(database.snapshot()).toEqual([betaBefore]);
    expect(Object.keys(localStorage)).toEqual([]);

    const full = Array.from({ length: 256 }, (_, index) =>
      indexRecordForChunks("model", [chunk(`/synthetic/retained-${index}.txt`)], [[index, 1]], index, "endpoint"));
    database.seed(full);
    const expected = full.slice(1).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const beforeCalls = { ...database.calls };
    expect(await removeDocumentVectorsForPaths([full[0].path])).toBe(1);
    expect(database.snapshot()).toEqual(expected);
    // A single-path removal must not rewrite the other retained records.
    expect({
      clear: database.calls.clear - beforeCalls.clear,
      put: database.calls.put - beforeCalls.put,
      delete: database.calls.delete - beforeCalls.delete,
    }).toEqual({ clear: 0, put: 0, delete: 1 });
  });

  it("removes the exact path across models and namespaces without changing another path", async () => {
    const alpha = chunk("/synthetic/alpha.txt"), beta = chunk("/synthetic/beta.txt");
    for (const [model, namespace] of [["a", "one"], ["b", "one"], ["a", "two"]]) {
      await saveDocumentVectors(model, [alpha], [[2, 3]], namespace);
      expect(await loadDocumentVectors(model, [alpha], namespace)).toEqual([[2, 3]]);
    }
    await saveDocumentVectors("a", [beta], [[4, 5]], "one");
    const betaBefore = database.snapshot().find((record) => record.path === beta.document.path)!;
    expect(await removeDocumentVectorsForPaths([alpha.document.path, alpha.document.path])).toBe(3);
    expect(database.snapshot()).toEqual([betaBefore]);
    for (const [model, namespace] of [["a", "one"], ["b", "one"], ["a", "two"]]) {
      expect(await loadDocumentVectors(model, [alpha], namespace)).toBeNull();
    }
    expect(await loadDocumentVectors("a", [beta], "one")).toEqual([[4, 5]]);
  });

  it("updates one key and preserves cloned records and serialized concurrent mutations", async () => {
    const alpha = chunk("/synthetic/alpha.txt"), beta = chunk("/synthetic/beta.txt");
    const vectors = [[1, 2]];
    await expect(saveDocumentVectors("a", [alpha], [[Number.POSITIVE_INFINITY]], "one"))
      .rejects.toThrow("invalid embedding vector");
    expect(database.snapshot()).toEqual([]);
    expect(Object.keys(localStorage)).toEqual([]);
    const open = database.holdNextOpen();
    const saving = saveDocumentVectors("a", [alpha], vectors, "one");
    await open.opened;
    try {
      vectors[0][0] = 99;
    } finally {
      open.release();
    }
    await saving;
    vectors[0][0] = 99;
    expect(await loadDocumentVectors("a", [alpha], "one")).toEqual([[1, 2]]);
    await saveDocumentVectors("a", [beta], [[3, 4]], "one");
    const betaBefore = database.snapshot().find((record) => record.path === beta.document.path)!;
    await saveDocumentVectors("a", [alpha], [[5, 6]], "one");
    const loaded = (await loadDocumentVectors("a", [alpha], "one"))!;
    loaded[0][0] = 88;
    expect(await loadDocumentVectors("a", [alpha], "one")).toEqual([[5, 6]]);
    expect(database.snapshot().find((record) => record.path === beta.document.path)).toEqual(betaBefore);
    await Promise.all([
      saveDocumentVectors("a", [alpha], [[7, 8]], "one"),
      saveDocumentVectors("a", [beta], [[9, 10]], "one"),
      removeDocumentVectorsForPaths([alpha.document.path]),
    ]);
    expect(await loadDocumentVectors("a", [alpha], "one")).toBeNull();
    expect(await loadDocumentVectors("a", [beta], "one")).toEqual([[9, 10]]);
    expect(database.snapshot()).toHaveLength(1);
  });

  it("keeps the newest 256 records despite key order and evicts legacy excess on the next write", async () => {
    const records = Array.from({ length: 260 }, (_, index) => {
      const document = chunk(`/synthetic/document-${index}.txt`);
      return indexRecordForChunks("a", [document], [[index, 1]], 0, "one");
    }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
      .map((record, index) => ({ ...record, updatedAt: 1000 - index }));
    database.seed(records);
    expect(database.snapshot()).toHaveLength(260);
    expect(database.snapshot()[0]).toEqual(records[0]);
    const newest = chunk(records[0].path), oldest = chunk(records.at(-1)!.path);
    expect(await loadDocumentVectors("a", [newest], "one")).toEqual(records[0].vectors);
    expect(await loadDocumentVectors("a", [oldest], "one")).toBeNull();
    const noMatch = database.snapshot();
    const noMatchCalls = { ...database.calls };
    expect(await removeDocumentVectorsForPaths([oldest.document.path])).toBe(0);
    expect(database.snapshot()).toEqual(noMatch);
    expect(database.calls).toEqual(noMatchCalls);
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const fresh = chunk("/synthetic/fresh.txt");
    await saveDocumentVectors("a", [fresh], [[50, 60]], "one");
    const expected = [...records.slice(0, 255), indexRecordForChunks("a", [fresh], [[50, 60]], 2000, "one")]
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    expect(database.snapshot()).toEqual(expected);
    expect(await loadDocumentVectors("a", [newest], "one")).toEqual(records[0].vectors);
    expect(await loadDocumentVectors("a", [fresh], "one")).toEqual([[50, 60]]);
    expect(await loadDocumentVectors("a", [oldest], "one")).toBeNull();

    const legacy = clone(expected.slice(0, 2));
    Object.assign(legacy[0], { updatedAt: Number.NaN, extra: { nested: ["retained", { value: 7 }] } });
    Reflect.deleteProperty(legacy[1], "updatedAt");
    database.seedRaw([
      ...legacy.map((record) => [record.key, record] as [string, unknown]),
      ["actual-corrupt-primary", { ...legacy[0], key: "different-claimed-key", vectors: [[Number.POSITIVE_INFINITY]] }],
    ]);
    const raw = database.snapshot();
    const beforeCleanup = { ...database.calls };
    expect(await removeDocumentVectorsForPaths(["/synthetic/no-match.txt"])).toBe(0);
    expect(database.snapshot()).toEqual(raw);
    expect(database.calls).toEqual(beforeCleanup);
    await saveDocumentVectors("a", [], [], "one");
    expect(database.snapshot()).toEqual(legacy.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  });

  it("waits for commit and retains the entire old snapshot on abort before a successful retry", async () => {
    const alpha = chunk("/synthetic/alpha.txt"), beta = chunk("/synthetic/beta.txt");
    await saveDocumentVectors("a", [alpha, beta], [[1, 2], [3, 4]], "one");
    const before = database.snapshot();
    const gate = database.holdNextWrite();
    let settled = false;
    const removal = removeDocumentVectorsForPaths([alpha.document.path]).then((count) => { settled = true; return count; });
    await gate.requestsDone;
    try {
      expect(settled).toBe(false);
      expect(database.snapshot()).toEqual(before);
    } finally {
      gate.abort();
    }
    // The existing fallback is empty: an aborted IDB removal must not report
    // one row removed or expose a partially cleared committed store.
    expect(await removal).toBe(0);
    expect(database.snapshot()).toEqual(before);
    expect(await loadDocumentVectors("a", [alpha], "one")).toEqual([[1, 2]]);
    expect(Object.keys(localStorage)).toEqual([]);
    expect(await removeDocumentVectorsForPaths([alpha.document.path])).toBe(1);
    expect(database.snapshot()).toEqual(before.filter((record) => record.path !== alpha.document.path));
    expect(await loadDocumentVectors("a", [beta], "one")).toEqual([[3, 4]]);

    const retained = database.snapshot();
    const gamma = chunk("/synthetic/gamma.txt");
    const fallbackGate = database.holdNextWrite();
    const saving = saveDocumentVectors("a", [gamma], [[5, 6]], "one");
    await fallbackGate.requestsDone;
    fallbackGate.abort();
    await saving;
    expect(database.snapshot()).toEqual(retained);
    vi.stubGlobal("indexedDB", undefined);
    expect(await loadDocumentVectors("a", [gamma], "one")).toEqual([[5, 6]]);
    vi.stubGlobal("indexedDB", database.factory);
    await saveDocumentVectors("a", [gamma], [[7, 8]], "one");
    expect(await loadDocumentVectors("a", [gamma], "one")).toEqual([[7, 8]]);
    expect(database.snapshot().find((record) => record.path === beta.document.path)).toEqual(retained[0]);
  });

  it("does not publish staged writes before transaction completion", async () => {
    const alpha = chunk("/synthetic/alpha.txt"), beta = chunk("/synthetic/beta.txt");
    await saveDocumentVectors("a", [alpha], [[1, 2]], "one");
    const before = database.snapshot();
    const gate = database.holdNextWrite();
    let settled = false;
    const saving = saveDocumentVectors("a", [beta], [[3, 4]], "one").then(() => { settled = true; });
    await gate.requestsDone;
    try {
      expect(settled).toBe(false);
      expect(database.snapshot()).toEqual(before);
    } finally {
      gate.complete();
    }
    await saving;
    expect(settled).toBe(true);
    expect(database.snapshot()).toHaveLength(2);
    expect(await loadDocumentVectors("a", [alpha], "one")).toEqual([[1, 2]]);
    expect(await loadDocumentVectors("a", [beta], "one")).toEqual([[3, 4]]);
  });
});
