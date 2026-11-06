/** Minimal IndexedDB key-value store for the voting wallet (browser only). */

const DB_NAME = "govzones-wallet";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(req ? (req as IDBRequest<T>).result : undefined);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export const kv = {
  get: <T>(key: string) => tx<T>("readonly", (s) => s.get(key) as IDBRequest<T>),
  set: (key: string, value: unknown) => tx("readwrite", (s) => void s.put(value, key)),
  del: (key: string) => tx("readwrite", (s) => void s.delete(key)),
  clear: () => tx("readwrite", (s) => void s.clear()),
};
