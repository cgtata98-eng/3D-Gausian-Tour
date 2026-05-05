/**
 * Saved-clip library for the Debug 動画タブ.
 *
 * Blobs are stored in IndexedDB at key `clip:${id}` (so they survive reloads).
 * Lightweight metadata (id, sceneId, createdAt, …) lives in localStorage so
 * listing doesn't need an async fetch. Concatenation is done in-browser by
 * playing each clip back into a `<video>` → `<canvas>` → `MediaRecorder` chain;
 * this re-encodes once but avoids pulling in ffmpeg.wasm.
 */
import * as idb from './idb';
import { CanvasRecorder, downloadBlob, downscaleCanvasToJpeg, pickSupportedMime } from './video-recorder';

const META_KEY = '3droomtour:video-clips:v1';

export interface ClipMeta {
  id: string;
  sceneId: string;
  planId: string | null;
  createdAt: number;
  /** Approx duration in milliseconds. Filled in after the recording stops. */
  durationMs: number;
  /** Container extension. */
  ext: 'mp4' | 'webm';
  /** First-frame thumbnail (JPEG data URL, ~240px). */
  thumbnail?: string;
  /** Origin: 'path' = scene 補間, 'free' = 画面操作. */
  origin: 'path' | 'free';
  /** byte size for display. */
  bytes: number;
}

function loadMetas(): ClipMeta[] {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMetas(metas: ClipMeta[]): void {
  try { localStorage.setItem(META_KEY, JSON.stringify(metas)); }
  catch { /* localStorage full / disabled — degrade silently */ }
}

const blobKey = (id: string) => `clip:${id}`;

/** Persist a recorded clip. Generates a thumbnail from the first decoded frame. */
export async function saveClip(blob: Blob, partial: Omit<ClipMeta, 'id' | 'createdAt' | 'bytes' | 'thumbnail'>): Promise<ClipMeta> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await idb.saveBlob(blobKey(id), blob);
  const thumbnail = await captureFirstFrameThumbnail(blob).catch(() => undefined);
  const meta: ClipMeta = {
    ...partial,
    id,
    createdAt: Date.now(),
    bytes: blob.size,
    thumbnail,
  };
  const metas = loadMetas();
  metas.push(meta);
  saveMetas(metas);
  return meta;
}

export function listClips(sceneId: string): ClipMeta[] {
  // No sort — return in stored order so the UI's drag-reorder is authoritative.
  // New clips are pushed at the end (oldest-first chronological by default).
  return loadMetas().filter((m) => m.sceneId === sceneId);
}

/** Persist a new order for the given scene's clips. Other scenes' clips keep
 *  their current positions. */
export function reorderClipsForScene(sceneId: string, orderedIds: string[]): ClipMeta[] {
  const all = loadMetas();
  const sceneMetas = all.filter((m) => m.sceneId === sceneId);
  const idToMeta = new Map(sceneMetas.map((m) => [m.id, m]));
  const reordered: ClipMeta[] = [];
  for (const id of orderedIds) {
    const m = idToMeta.get(id);
    if (m) { reordered.push(m); idToMeta.delete(id); }
  }
  // Any clips not mentioned in `orderedIds` stay in their original relative order
  // appended to the end.
  for (const m of sceneMetas) if (idToMeta.has(m.id)) reordered.push(m);
  // Walk the global list, replacing scene entries in-place with the new order.
  let r = 0;
  const next: ClipMeta[] = [];
  for (const m of all) {
    if (m.sceneId === sceneId) next.push(reordered[r++] ?? m);
    else next.push(m);
  }
  saveMetas(next);
  return reordered;
}

export async function deleteClip(id: string): Promise<void> {
  await idb.deleteBlob(blobKey(id));
  const metas = loadMetas().filter((m) => m.id !== id);
  saveMetas(metas);
}

export async function getClipBlob(id: string): Promise<Blob | null> {
  return idb.loadBlob(blobKey(id));
}

export async function downloadClip(id: string, filename: string): Promise<void> {
  const blob = await getClipBlob(id);
  if (!blob) throw new Error('clip not found');
  downloadBlob(blob, filename);
}

/** Decode the first frame of a blob and return a small JPEG data URL. */
async function captureFirstFrameThumbnail(blob: Blob, maxSize = 240): Promise<string | undefined> {
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    await new Promise<void>((resolve, reject) => {
      const onErr = () => reject(new Error('video load failed'));
      v.addEventListener('loadeddata', () => resolve(), { once: true });
      v.addEventListener('error', onErr, { once: true });
    });
    // Some browsers need a play→pause to actually paint the first frame.
    try { await v.play(); v.pause(); } catch { /* ignore */ }
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 320;
    c.height = v.videoHeight || 180;
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(v, 0, 0);
    return downscaleCanvasToJpeg(c, maxSize);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ConcatOptions {
  fps?: number;
  bitrate?: number;
  /** Emit (clipIndex, t01, totalClips) after each frame so the UI can show progress. */
  onProgress?: (clipIndex: number, t01: number, total: number) => void;
}

/**
 * Concatenate `clipIds` into a single video. Played sequentially through a hidden
 * `<video>` → `<canvas>` → `MediaRecorder` so the result is one continuous file.
 * Re-encodes once, but no native deps (ffmpeg.wasm not required).
 *
 * Resolution and frame-rate of the output are taken from the first clip's video
 * dimensions and the caller-supplied `fps`. Subsequent clips are scaled if their
 * size differs.
 */
export async function concatClips(clipIds: string[], opts: ConcatOptions = {}): Promise<{ blob: Blob; ext: 'mp4' | 'webm' }> {
  if (clipIds.length === 0) throw new Error('no clips selected');
  const blobs: Blob[] = [];
  for (const id of clipIds) {
    const b = await getClipBlob(id);
    if (!b) throw new Error(`clip blob missing: ${id}`);
    blobs.push(b);
  }

  // Probe first clip for dimensions.
  const first = blobs[0];
  const probeUrl = URL.createObjectURL(first);
  let w = 0, h = 0;
  try {
    const probe = document.createElement('video');
    probe.src = probeUrl;
    probe.muted = true;
    probe.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      probe.addEventListener('loadedmetadata', () => resolve(), { once: true });
      probe.addEventListener('error', () => reject(new Error('probe failed')), { once: true });
    });
    w = probe.videoWidth || 1280;
    h = probe.videoHeight || 720;
  } finally {
    URL.revokeObjectURL(probeUrl);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  const picked = pickSupportedMime();
  if (!picked) throw new Error('MediaRecorder 非対応');
  const fps = opts.fps ?? 60;
  const bitrate = opts.bitrate ?? 8_000_000;
  const recorder = new CanvasRecorder(canvas, picked.mime, fps, bitrate);
  recorder.start();

  try {
    for (let i = 0; i < blobs.length; i++) {
      await playClipIntoCanvas(blobs[i], ctx, w, h, (t) => opts.onProgress?.(i, t, blobs.length));
    }
  } catch (e) {
    // Try to stop the recorder cleanly even if we errored mid-way.
    try { await recorder.stop(); } catch { /* ignore */ }
    throw e;
  }

  const blob = await recorder.stop();
  return { blob, ext: picked.ext };
}

async function playClipIntoCanvas(
  blob: Blob,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  onProgress?: (t01: number) => void,
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      v.addEventListener('loadeddata', () => resolve(), { once: true });
      v.addEventListener('error', () => reject(new Error('clip load failed')), { once: true });
    });
    let raf = 0;
    const draw = () => {
      if (v.ended || v.paused) return;
      ctx.drawImage(v, 0, 0, w, h);
      const dur = v.duration || 1;
      onProgress?.(Math.min(1, v.currentTime / dur));
      raf = requestAnimationFrame(draw);
    };
    await v.play();
    raf = requestAnimationFrame(draw);
    await new Promise<void>((resolve) => {
      v.addEventListener('ended', () => resolve(), { once: true });
    });
    cancelAnimationFrame(raf);
    // One last paint so the final frame definitely lands in the recorder buffer.
    ctx.drawImage(v, 0, 0, w, h);
    onProgress?.(1);
  } finally {
    URL.revokeObjectURL(url);
  }
}
