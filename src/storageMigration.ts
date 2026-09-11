/** Runs before importing application modules: their initializers read preferences. */
const PREFIX = "llama-board";
const JOURNAL = "aiolm.migration.v1";
const DATABASES = ["llama-board-storage", "llama-board-chat", "llama-board-document-index"];
export interface MigratedPath { from: string; to: string }
type StoredRecord = { key: IDBValidKey; value: unknown };
type Snapshot = { name: string; keyPath: string | string[] | null; autoIncrement: boolean; indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[]; records: StoredRecord[] }[];

function isStructuredKey(key: string): boolean {
  const suffix = key.replace(/^(?:llama-board|aiolm)/, "");
  return ["-preferences", "-model-profiles", "-benchmark-history.v1", ".projects.v1", ".chat-workspace.v1", ".chat-workspace.v2", ".latest-runtimes.v2"].includes(suffix)
    || suffix.startsWith(".document-index.");
}

function parseStructuredValue(key: string, raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  if (isStructuredKey(key) && (!value || typeof value !== "object")) {
    throw new Error(`Invalid structured data in ${key}. Original data has been preserved.`);
  }
  return value;
}

export function migrateStoredValue(value: unknown, paths: MigratedPath[]): unknown {
  if (typeof value === "string") {
    for (const { from, to } of paths) {
      const normalized = value.replace(/\\/g, "/"), source = from.replace(/\\/g, "/").replace(/\/$/, "");
      if (normalized.toLowerCase() === source.toLowerCase() || normalized.toLowerCase().startsWith(source.toLowerCase() + "/")) return to.replace(/\\/g, "/") + normalized.slice(source.length);
    }
    if (value.startsWith(PREFIX + ".document-index.") || value === PREFIX + ".project.v1") return value.replace(PREFIX, "aiolm");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => migrateStoredValue(item, paths));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrateStoredValue(item, paths)]));
  return value; // Preserve Blob, ArrayBuffer, Date and typed arrays without serialization.
}

function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let missing = false;
    request.onupgradeneeded = () => { missing = true; request.transaction?.abort(); };
    request.onerror = event => { if (missing) { event.preventDefault(); resolve(null); } else reject(request.error); };
    request.onblocked = () => reject(new Error("Close other AioLM windows and retry the data migration."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function snapshot(name: string): Promise<Snapshot> {
  const db = await openExisting(name);
  if (!db) return [];
  try {
    const names = Array.from(db.objectStoreNames);
    if (!names.length) return [];
    return await new Promise<Snapshot>((resolve, reject) => {
      const tx = db.transaction(names, "readonly");
      const result: Snapshot = [];
      for (const name of names) {
        const source = tx.objectStore(name);
        const entry: Snapshot[number] = { name, keyPath: source.keyPath, autoIncrement: source.autoIncrement, indexes: Array.from(source.indexNames).map(name => {
          const i = source.index(name); return { name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry };
        }), records: [] };
        result.push(entry);
        const cursor = source.openCursor();
        cursor.onsuccess = () => { if (cursor.result) { entry.records.push({ key: cursor.result.key, value: cursor.result.value }); cursor.result.continue(); } };
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Could not read previous application data."));
    });
  } finally { db.close(); }
}

async function copyDatabase(name: string, data: Snapshot, paths: MigratedPath[]): Promise<void> {
  if (!data.length) return;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const entry of data) {
        const store = request.result.createObjectStore(entry.name, { keyPath: entry.keyPath, autoIncrement: entry.autoIncrement });
        for (const index of entry.indexes) store.createIndex(index.name, index.keyPath, index);
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close other AioLM windows and retry the data migration."));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(data.map(s => s.name), "readwrite");
      for (const entry of data) {
        const store = tx.objectStore(entry.name);
        for (const record of entry.records) {
          const value = migrateStoredValue(record.value, paths);
          const key = typeof record.key === "string" ? record.key.replace(/^llama-board/, "aiolm") : record.key;
          if (store.keyPath === null) store.put(value, key); else store.put(value);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Could not copy previous application data."));
    });
  } finally { db.close(); }
}

async function migrate(paths: MigratedPath[]): Promise<void> {
  const state = localStorage.getItem(JOURNAL);
  if (state === "complete" || state === "existing") return;
  if (state && state !== "copying") throw new Error("The AioLM migration record is invalid. Restore it from your backup before retrying.");
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter(Boolean);
  const hasNewLocal = keys.some(key => key.startsWith("aiolm") && key !== JOURNAL);
  const hasIdb = typeof indexedDB !== "undefined";
  if (!state) {
    let hasNewDatabase = false;
    if (hasIdb) for (const name of DATABASES) {
      const data = await snapshot(name.replace(PREFIX, "aiolm"));
      if (data.some(store => store.records.length)) hasNewDatabase = true;
    }
    if (hasNewLocal || hasNewDatabase) {
      // Existing data is never replaced, including damaged data. Report damage
      // instead of importing over it or silently initializing defaults.
      for (const key of keys.filter(key => key.startsWith("aiolm") && key !== JOURNAL)) {
        const raw = localStorage.getItem(key)!;
        if (isStructuredKey(key) || /^\s*[[{]/.test(raw)) parseStructuredValue(key, raw);
        if (key === "aiolm-theme" && !["light", "dark", "system"].includes(raw)) throw new Error("Existing AioLM theme data is invalid; original data has been preserved.");
      }
      localStorage.setItem(JOURNAL, "existing"); return;
    }
  }
  const local = keys.filter(key => key.startsWith(PREFIX)).map(key => {
    const raw = localStorage.getItem(key)!;
    // Validate structured stores before any new settings can be saved.
    let value = raw;
    if (isStructuredKey(key) || /^\s*[[{]/.test(raw)) value = JSON.stringify(migrateStoredValue(parseStructuredValue(key, raw), paths));
    return [key.replace(PREFIX, "aiolm"), value] as const;
  });
  localStorage.setItem(JOURNAL, "copying");
  if (hasIdb) for (const name of DATABASES) await copyDatabase(name.replace(PREFIX, "aiolm"), await snapshot(name), paths);
  for (const [key, value] of local) localStorage.setItem(key, value);
  localStorage.setItem(JOURNAL, "complete");
}

export async function migrateBrowserStorage(paths: MigratedPath[] = []): Promise<void> {
  // Every window gates its module initialization; only one can copy the shared
  // browser profile at a time. A terminated window releases its Web Lock.
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request(JOURNAL, () => migrate(paths));
  } else await migrate(paths);
}
