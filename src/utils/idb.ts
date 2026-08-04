/**
 * Minimal IndexedDB wrapper for persisting scene manifests + binary blobs (splat files).
 *
 * Stores:
 *   - "manifests"  →  per-sceneId SceneManifest (JSON-cloneable)
 *   - "blobs"      →  uploaded files (splat .ply/.splat). Manifest holds an `idb:<key>` reference.
 *
 * Panoramas / thumbnails / floor plans stay as data URLs inside the manifest itself —
 * they round-trip through structured clone fine and avoid the extra resolve step.
 */
const DB_NAME = '3droomtour';
const DB_VERSION = 1;
const STORE_MANIFESTS = 'manifests';
const STORE_BLOBS = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MANIFESTS)) db.createObjectStore(STORE_MANIFESTS);
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  return dbPromise;
}

function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then((db) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    }),
  );
}

export function saveManifest(sceneId: string, manifest: unknown): Promise<IDBValidKey> {
  return withStore<IDBValidKey>(STORE_MANIFESTS, 'readwrite', (s) => s.put(manifest, sceneId));
}
export function loadManifest<T = unknown>(sceneId: string): Promise<T | null> {
  return withStore<T | undefined>(STORE_MANIFESTS, 'readonly', (s) => s.get(sceneId)).then(
    (v) => v ?? null,
  );
}
export function deleteManifest(sceneId: string): Promise<void> {
  return withStore<void>(STORE_MANIFESTS, 'readwrite', (s) => s.delete(sceneId));
}

export function saveBlob(key: string, blob: Blob): Promise<IDBValidKey> {
  return withStore<IDBValidKey>(STORE_BLOBS, 'readwrite', (s) => s.put(blob, key));
}
export function loadBlob(key: string): Promise<Blob | null> {
  return withStore<Blob | undefined>(STORE_BLOBS, 'readonly', (s) => s.get(key)).then(
    (v) => v ?? null,
  );
}
export function deleteBlob(key: string): Promise<void> {
  return withStore<void>(STORE_BLOBS, 'readwrite', (s) => s.delete(key));
}

/** List every sceneId that has a stored manifest. Used by the cross-origin
 *  migration to enumerate what needs copying. */
export function listManifestKeys(): Promise<string[]> {
  return openDb().then((db) =>
    new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_MANIFESTS, 'readonly');
      const req = tx.objectStore(STORE_MANIFESTS).getAllKeys();
      req.onsuccess = () =>
        resolve((req.result as IDBValidKey[]).filter((k): k is string => typeof k === 'string'));
      req.onerror = () => reject(req.error);
    }),
  );
}

/** List blob keys that start with the given prefix. Used by SOG load to find all
 *  files belonging to a plan (`splat:<scene>:<plan>:sog:<filename>`). */
export function listBlobKeys(prefix?: string): Promise<string[]> {
  return openDb().then((db) =>
    new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readonly');
      const req = tx.objectStore(STORE_BLOBS).getAllKeys();
      req.onsuccess = () => {
        const all = (req.result as IDBValidKey[]).filter((k): k is string => typeof k === 'string');
        resolve(prefix ? all.filter((k) => k.startsWith(prefix)) : all);
      };
      req.onerror = () => reject(req.error);
    }),
  );
}

/** Reference token used inside manifests to point at a Blob saved in the `blobs` store. */
export const IDB_REF_PREFIX = 'idb:';

export function isIdbRef(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(IDB_REF_PREFIX);
}
export function idbRefKey(ref: string): string {
  return ref.slice(IDB_REF_PREFIX.length);
}

/**
 * Resolve a string that may be one of:
 *   - data:...   — returned as-is
 *   - blob:...   — returned as-is (in-memory object URL; not persisted)
 *   - idb:...    — looked up in the blob store, returned as a fresh object URL
 *   - other      — returned as-is (caller resolves relative paths)
 *
 * Caller is responsible for `URL.revokeObjectURL` if they want to free memory.
 */
export async function resolveBlobRef(value: string): Promise<string> {
  if (!isIdbRef(value)) return value;
  const blob = await loadBlob(idbRefKey(value));
  if (!blob) throw new Error(`IDB blob missing for key: ${idbRefKey(value)}`);
  return URL.createObjectURL(blob);
}
