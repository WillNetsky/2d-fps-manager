// Thin promise wrapper around IndexedDB. No external dependency — just enough
// to open the database, run single-store transactions, and read key ranges.
// The universe persistence layer (storage.ts) is built on top of this.

const DB_NAME = "2d-fps";
const DB_VERSION = 1;

export const STORE_META = "meta";   // keyPath "id"            — UniverseSummary
export const STORE_CORE = "core";   // keyPath "id"            — Universe minus history
export const STORE_DAYS = "days";   // keyPath ["universeId","day"] — one CompletedDay each

export function idbAvailable(): boolean {
  try { return typeof indexedDB !== "undefined" && indexedDB !== null; }
  catch { return false; }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_CORE)) db.createObjectStore(STORE_CORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_DAYS)) db.createObjectStore(STORE_DAYS, { keyPath: ["universeId", "day"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Run `fn` inside a transaction over `stores` and resolve when the whole
// transaction commits (so writes are durable before the promise settles).
async function run<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    Promise.resolve(fn(tx)).then(r => { result = r; }, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return run(store, "readonly", tx => promisify<T>(tx.objectStore(store).get(key)));
}

export function idbGetAll<T>(store: string, query?: IDBKeyRange): Promise<T[]> {
  return run(store, "readonly", tx => promisify<T[]>(tx.objectStore(store).getAll(query)));
}

export function idbPut(store: string, value: unknown): Promise<void> {
  return run(store, "readwrite", tx => { tx.objectStore(store).put(value); });
}

// Put many records into one store within a single transaction.
export function idbPutMany(store: string, values: unknown[]): Promise<void> {
  return run(store, "readwrite", tx => {
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
  });
}

export function idbDelete(store: string, key: IDBValidKey | IDBKeyRange): Promise<void> {
  return run(store, "readwrite", tx => { tx.objectStore(store).delete(key); });
}
