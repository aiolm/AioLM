import type { BenchmarkOutboxStore, QueuedBenchmark } from "./outbox.ts";

const STORE = "submissions";
const DESTINATIONS = "destinations";

/** No silent in-memory fallback: a queued confirmation means the transaction committed. */
export function createIndexedDbOutbox(factory: IDBFactory | undefined = globalThis.indexedDB, databaseName = "aiolm-benchmark-sharing"): BenchmarkOutboxStore {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    if (!factory) return Promise.reject(new Error("Durable sharing storage is unavailable in this environment."));
    if (!database) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        let abandoned = false;
        const request = factory.open(databaseName, 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          const submissions = db.objectStoreNames.contains(STORE)
            ? request.transaction!.objectStore(STORE)
            : db.createObjectStore(STORE, { keyPath: "id" });
          if (!submissions.indexNames.contains("created")) submissions.createIndex("created", ["createdAt", "id"]);
          if (!submissions.indexNames.contains("state_due")) submissions.createIndex("state_due", ["state", "nextAttemptAt", "id"]);
          if (!submissions.indexNames.contains("local_reconcile")) submissions.createIndex("local_reconcile", ["localReconcileAt", "id"]);
          if (!submissions.indexNames.contains("acknowledged_cache")) submissions.createIndex("acknowledged_cache", ["localCachePolicy", "localAcknowledgedAt", "id"]);
          if (!db.objectStoreNames.contains(DESTINATIONS)) db.createObjectStore(DESTINATIONS);
          const cursor = submissions.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) return;
            const entry = current.value as QueuedBenchmark;
            if (entry.state === "sent" && entry.source?.runId && entry.receipt && entry.localAcknowledgedAt === undefined && entry.localReconcileAt === undefined) {
              current.update({ ...entry, localReconcileAt: 0 });
            }
            current.continue();
          };
        };
        request.onerror = () => reject(request.error ?? new Error("Unable to open sharing storage."));
        request.onblocked = () => { abandoned = true; reject(new Error("Another app window is blocking the sharing storage upgrade.")); };
        request.onsuccess = () => {
          const db = request.result;
          if (abandoned) { db.close(); return; }
          db.onversionchange = () => { db.close(); database = undefined; };
          resolve(db);
        };
      }).catch((error: unknown) => { database = undefined; throw error; });
    }
    return database;
  };
  return {
    async list(page = {}) {
      const limit = page.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid sharing page size.");
      if (Number(!!page.pendingAcknowledgement) + Number(!!page.acknowledgedCache) + Number(!!page.state) > 1) throw new RangeError("Choose a single sharing page filter.");
      if (page.skip !== undefined && (!page.acknowledgedCache || !Number.isInteger(page.skip) || page.skip < 0 || page.skip > 100)) throw new RangeError("Invalid cache retention offset.");
      const db = await open();
      return new Promise<QueuedBenchmark[]>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const objectStore = tx.objectStore(STORE);
        const index = objectStore.index(page.acknowledgedCache ? "acknowledged_cache" : page.pendingAcknowledgement ? "local_reconcile" : page.state ? "state_due" : "created");
        const range = page.acknowledgedCache
          ? IDBKeyRange.bound(["acknowledged-v1", 0, ""], ["acknowledged-v1", ...(page.after ?? [Number.MAX_SAFE_INTEGER, "\uffff"])], false, !!page.after)
          : page.pendingAcknowledgement
          ? IDBKeyRange.bound(page.after ?? [0, ""], [page.dueBefore ?? Number.MAX_SAFE_INTEGER, "\uffff"], !!page.after)
          : page.state
          ? IDBKeyRange.bound(page.after ? [page.state, ...page.after] : [page.state, 0, ""], [page.state, page.dueBefore ?? Number.MAX_SAFE_INTEGER, "\uffff"], !!page.after)
          : page.after ? IDBKeyRange.upperBound(page.after, true) : undefined;
        const request = page.acknowledgedCache ? index.openKeyCursor(range, "prev") : index.openCursor(range, page.state || page.pendingAcknowledgement ? "next" : "prev");
        const results: QueuedBenchmark[] = [];
        let skipped = false;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (page.skip && !skipped) { skipped = true; cursor.advance(page.skip); return; }
          if (page.acknowledgedCache) {
            const row = objectStore.get(cursor.primaryKey);
            row.onsuccess = () => {
              results.push(row.result as QueuedBenchmark);
              if (results.length < limit) cursor.continue();
            };
          } else {
            results.push((cursor as IDBCursorWithValue).value as QueuedBenchmark);
            if (results.length < limit) cursor.continue();
          }
        };
        tx.oncomplete = () => resolve(results);
        tx.onabort = () => reject(tx.error ?? new Error("Unable to read sharing storage."));
        tx.onerror = () => reject(tx.error ?? new Error("Unable to read sharing storage."));
      });
    },
    async get(id) {
      const db = await open();
      return new Promise<QueuedBenchmark | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(id);
        request.onsuccess = () => resolve(request.result as QueuedBenchmark | undefined);
        tx.onabort = () => reject(tx.error ?? new Error("Unable to read sharing storage."));
        tx.onerror = () => reject(tx.error ?? new Error("Unable to read sharing storage."));
      });
    },
    async cooldown(destination, until) {
      const db = await open();
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(DESTINATIONS, until === undefined ? "readonly" : "readwrite");
        const objectStore = tx.objectStore(DESTINATIONS);
        const request = objectStore.get(destination);
        let result = 0;
        request.onsuccess = () => {
          result = Math.max(typeof request.result === "number" ? request.result : 0, until ?? 0);
          if (until !== undefined) objectStore.put(result, destination);
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? new Error("Unable to persist the sharing retry deadline."));
        tx.onerror = () => reject(tx.error ?? new Error("Unable to read the sharing retry deadline."));
      });
    },
    async mutate(id, update) {
      const db = await open();
      return new Promise<QueuedBenchmark | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const objectStore = tx.objectStore(STORE);
        const request = objectStore.get(id);
        let result: QueuedBenchmark | undefined;
        let failure: unknown;
        request.onsuccess = () => {
          try {
            const current = request.result as QueuedBenchmark | undefined;
            result = update(current);
            if (result === current) return;
            if (result) objectStore.put(result);
            else objectStore.delete(id);
          } catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure ?? tx.error ?? new Error("Sharing storage did not commit the change."));
        tx.onerror = () => reject(tx.error ?? new Error("Unable to update sharing storage."));
      });
    },
  };
}
