/**
 * Cross-origin migration of authoring data.
 *
 * Project data never leaves the browser: the project list lives in
 * `localStorage`, and scene manifests plus splat blobs live in IndexedDB
 * (`3droomtour`). All of that is keyed by origin. So moving the site from
 * `cg-gaussian.iucgs.workers.dev` to `cg-rooms.com` strands the old data —
 * same Worker, same bundle, different storage jar.
 *
 * The transfer runs between two windows of the same deployed app:
 *
 *   receiver (new origin)  ──window.open──▶  source (old origin, `?source=1`)
 *                          ◀──postMessage──
 *
 * A popup, not an iframe, and that is the whole trick. Chrome and Edge
 * partition storage for cross-site iframes, so an embedded old-origin frame
 * would open an empty partition and truthfully report "no data". A popup is a
 * top-level browsing context for its own origin and sees the real jar.
 *
 * Flow control is one item per ack, so a multi-gigabyte blob store never has
 * more than a single blob in flight.
 */
import * as idb from './idb';

export const MIGRATE_CHANNEL = '3droomtour-migrate';

/**
 * Origins allowed to take part in a transfer, in either role. The source
 * window refuses to speak to an opener outside this list, so a hostile page
 * cannot pop open our source route and drain the store.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://cg-rooms.com',
  'https://www.cg-rooms.com',
  'https://cg-gaussian.iucgs.workers.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
];

/** Pre-filled in the receiver UI — the origin we are migrating away from. */
export const DEFAULT_SOURCE_ORIGIN = 'https://cg-gaussian.iucgs.workers.dev';

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin);
}

/* ────────────────────────────────────────────────────────────────────────────
   What counts as project data
   ──────────────────────────────────────────────────────────────────────────── */

/** Arrays of `{ id, … }` — merged entry by entry rather than replaced wholesale. */
const LIST_LS_KEYS = ['3droomtour:projects:v1', '3droomtour:video-clips:v1'] as const;

/** Scalar preferences — copied only when the receiver has no value of its own. */
const SCALAR_LS_KEYS = ['3droomtour:projects:sort:v1', '3droomtour:qualityMode'] as const;

/** Opt-in, because these are credentials rather than project content. */
const API_KEY_LS_KEYS = ['3dcggs:openai-api-key', '3dcggs:gemini-api-key', '3dcggs:ai-model'] as const;

// `admin-auth-v1` is deliberately absent: the login record is cheap to recreate
// and copying a session across origins is the kind of thing that ages badly.

export type LsSnapshot = Record<string, string>;

export function readLsSnapshot(includeApiKeys: boolean): LsSnapshot {
  const keys: string[] = [...LIST_LS_KEYS, ...SCALAR_LS_KEYS];
  if (includeApiKeys) keys.push(...API_KEY_LS_KEYS);
  const out: LsSnapshot = {};
  for (const k of keys) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    } catch {
      /* storage disabled — nothing to migrate from this origin anyway */
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
   Wire protocol
   ──────────────────────────────────────────────────────────────────────────── */

export interface Inventory {
  manifestKeys: string[];
  blobKeys: string[];
  /** Sum of `Blob.size`. Metadata only — the bytes are not read to compute it. */
  blobBytes: number;
}

export type SourceMsg =
  | { ch: string; type: 'ready' }
  | ({ ch: string; type: 'inventory'; ls: LsSnapshot } & Inventory)
  | { ch: string; type: 'manifest'; key: string; value: unknown; index: number }
  | { ch: string; type: 'blob'; key: string; blob: Blob; index: number }
  | { ch: string; type: 'done' }
  | { ch: string; type: 'error'; message: string };

export type ReceiverMsg =
  | { ch: string; type: 'start'; includeApiKeys: boolean }
  | { ch: string; type: 'ack'; index: number }
  | { ch: string; type: 'bye' };

/** Narrow an untyped `MessageEvent.data` to one of our messages. */
export function asMigrateMsg<T extends { ch: string; type: string }>(data: unknown): T | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { ch?: unknown; type?: unknown };
  if (d.ch !== MIGRATE_CHANNEL || typeof d.type !== 'string') return null;
  return data as T;
}

/* ────────────────────────────────────────────────────────────────────────────
   Source side — collecting
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Enumerate what this origin holds. Blob sizes come from the `Blob` handles
 * IndexedDB hands back, which carry a byte count without reading the payload,
 * so this stays cheap even for a store full of splats.
 */
export async function collectInventory(): Promise<Inventory> {
  const [manifestKeys, blobKeys] = await Promise.all([
    idb.listManifestKeys().catch(() => [] as string[]),
    idb.listBlobKeys().catch(() => [] as string[]),
  ]);
  let blobBytes = 0;
  for (const key of blobKeys) {
    try {
      const blob = await idb.loadBlob(key);
      if (blob) blobBytes += blob.size;
    } catch {
      /* unreadable entry — the transfer step reports it individually */
    }
  }
  return { manifestKeys, blobKeys, blobBytes };
}

/* ────────────────────────────────────────────────────────────────────────────
   Receiver side — applying
   ──────────────────────────────────────────────────────────────────────────── */

export interface MergeCounts {
  added: number;
  overwritten: number;
  kept: number;
}

function emptyCounts(): MergeCounts {
  return { added: 0, overwritten: 0, kept: 0 };
}

function parseIdList(raw: string | null): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/**
 * Merge an incoming `{ id, … }[]` into whatever this origin already has.
 * Order follows the existing list first so the receiver's own arrangement is
 * not reshuffled by the import.
 */
function mergeIdList(existingRaw: string | null, incomingRaw: string, overwrite: boolean) {
  const counts = emptyCounts();
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of parseIdList(existingRaw)) {
    const id = entry.id;
    if (typeof id === 'string') byId.set(id, entry);
  }
  for (const entry of parseIdList(incomingRaw)) {
    const id = entry.id;
    if (typeof id !== 'string') continue;
    if (!byId.has(id)) {
      byId.set(id, entry);
      counts.added++;
    } else if (overwrite) {
      byId.set(id, entry);
      counts.overwritten++;
    } else {
      counts.kept++;
    }
  }
  return { json: JSON.stringify([...byId.values()]), counts };
}

export interface LsApplyResult {
  /** Per-key merge tallies for the list-shaped keys. */
  lists: Record<string, MergeCounts>;
  /** Scalar keys actually written. */
  scalarsWritten: string[];
}

export function applyLsSnapshot(snapshot: LsSnapshot, overwrite: boolean): LsApplyResult {
  const lists: Record<string, MergeCounts> = {};
  const scalarsWritten: string[] = [];
  const listKeys = new Set<string>(LIST_LS_KEYS);

  for (const [key, incoming] of Object.entries(snapshot)) {
    try {
      if (listKeys.has(key)) {
        const { json, counts } = mergeIdList(localStorage.getItem(key), incoming, overwrite);
        localStorage.setItem(key, json);
        lists[key] = counts;
      } else if (overwrite || localStorage.getItem(key) === null) {
        localStorage.setItem(key, incoming);
        scalarsWritten.push(key);
      }
    } catch {
      /* quota or disabled storage — surfaced by the caller's own tallies */
    }
  }
  return { lists, scalarsWritten };
}

/** Keys already present on the receiver, so the UI can skip or overwrite. */
export async function readExistingIdbKeys(): Promise<{ manifests: Set<string>; blobs: Set<string> }> {
  const [manifests, blobs] = await Promise.all([
    idb.listManifestKeys().catch(() => [] as string[]),
    idb.listBlobKeys().catch(() => [] as string[]),
  ]);
  return { manifests: new Set(manifests), blobs: new Set(blobs) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
