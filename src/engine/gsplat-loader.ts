import { Asset, Entity, SHADERLANGUAGE_GLSL } from 'playcanvas';
import type { AppBase } from 'playcanvas';
import { unzipSync } from 'fflate';
import type { SplatTransform, Vec3 } from '../core/types';
import * as idb from '../utils/idb';

/** Sentinel prefix written to `Plan.splatSog` so we can tell the manifest carries an
 *  SOG bundle (multiple files in IDB) vs a single PLY blob ref. */
const SOG_IDB_PREFIX = 'sog-idb:';
const SOG_IDB_KEY_PREFIX = (sceneId: string, planId: string) => `splat:${sceneId}:${planId}:sog/`;

export function makeSogIdbRef(sceneId: string, planId: string): string {
  return `${SOG_IDB_PREFIX}${sceneId}:${planId}`;
}
export function isSogIdbRef(value: string | undefined): boolean {
  return !!value && value.startsWith(SOG_IDB_PREFIX);
}
export function sogBundleKeyPrefix(sceneId: string, planId: string): string {
  return SOG_IDB_KEY_PREFIX(sceneId, planId);
}

// `RenderMode` lives in `render-presets.ts` so the preset table and the type travel
// together. Re-exported here to preserve existing import paths.
export type { RenderMode } from './render-presets';

/** Default Euler rotation applied when a plan has no `splatTransform.rotation` override. */
export const DEFAULT_SPLAT_ROTATION: Vec3 = [180, 0, 0];
/** Default position offset applied when a plan has no `splatTransform.position` override. */
export const DEFAULT_SPLAT_POSITION: Vec3 = [0, 0, 0];

/** Steps 5/6 of `docs/playcanvas-supersplat-quality-migration.md`: a `gsplatModifyVS`
 *  chunk that pipes a `viewerSplatScale` uniform into the per-splat scale. The
 *  built-in shader doesn't read `mat.setParameter('splatScale', …)`, so we override
 *  the chunk and feed the value through this uniform instead. */
const VIEWER_MODIFY_CHUNK = `
uniform float viewerSplatScale;

void modifySplatCenter(inout vec3 center) {}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    scale *= viewerSplatScale;
}

void modifySplatColor(vec3 center, inout vec4 color) {}
`;
const DEFAULT_SPLAT_SCALE = 1.15; // SuperSplat-feel default; 1.15〜1.25 is usable.
const DEFAULT_SH_BANDS = 3;       // 0..3, full SH at load time.

/** ロード% を上位 (LoadingScreen) に伝えるためのコールバック。`progress` は 0..1、
 *  Content-Length が取れず正確な分母が分からないときは `null` (= ステータス不明)。 */
export type LoadProgress = (progress: number | null) => void;

/**
 * `fetch` を呼びつつ Reader API で逐次バイト数を集計、`onProgress(0..1)` を発火しながら
 * 全バイトを 1 個の Blob にまとめて返す。Content-Length が無い (= 圧縮転送など) 場合は
 * 1 度だけ `null` を発火してから黙々と読む — 上位は「ダウンロード中だが %未確定」として
 * スピナーだけ出せばよい。
 */
async function fetchWithProgress(url: string, onProgress?: LoadProgress): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText} (${url})`);
  const totalHdr = res.headers.get('content-length');
  const total = totalHdr ? parseInt(totalHdr, 10) : 0;
  if (!res.body || !total) {
    // 進捗を取れないケース: Blob だけ返して null を流す。
    onProgress?.(null);
    return res.blob();
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  onProgress?.(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Uint8Array<SharedArrayBuffer> 含みの型と Blob ctor の BlobPart 期待型が
    // 噛み合わないので、安全に ArrayBuffer 側にコピーして詰める (`slice().buffer`)。
    chunks.push(value.slice().buffer);
    received += value.byteLength;
    onProgress?.(Math.min(1, received / total));
  }
  onProgress?.(1);
  return new Blob(chunks);
}

/**
 * Load a .ply/.splat file and add it to the scene as a GSplat entity.
 * High quality spherical harmonics enabled.
 *
 * `transform` lets a plan override rotation / position (typical use: fix an
 * upside-down PLY export, nudge model height). Defaults match the original hard-coded
 * `setEulerAngles(180, 0, 0)` so behavior is unchanged for existing scenes.
 */
export async function loadGSplat(
  app: AppBase,
  url: string,
  name: string = 'gsplat',
  transform?: SplatTransform,
  onProgress?: LoadProgress,
): Promise<Entity> {
  // バイト進捗が欲しいので一旦 fetch で全バイトを取得 → Blob → object URL を Asset に渡す。
  // (`data:` / `blob:` / `mem://` 等はそのまま PlayCanvas に投げる — 進捗は出ない)
  let assetUrl = url;
  let revoke: string | null = null;
  if (/^https?:|^\//.test(url)) {
    const blob = await fetchWithProgress(url, onProgress);
    assetUrl = URL.createObjectURL(blob);
    revoke = assetUrl;
  } else {
    onProgress?.(null);
  }
  return new Promise((resolve, reject) => {
    const asset = new Asset(name, 'gsplat', { url: assetUrl });
    asset.on('load', () => {
      if (revoke) URL.revokeObjectURL(revoke);
      const entity = new Entity(name);
      entity.addComponent('gsplat', {
        asset: asset,
      });
      const rot = transform?.rotation ?? DEFAULT_SPLAT_ROTATION;
      const pos = transform?.position ?? DEFAULT_SPLAT_POSITION;
      entity.setEulerAngles(rot[0], rot[1], rot[2]);
      entity.setLocalPosition(pos[0], pos[1], pos[2]);
      app.root.addChild(entity);

      // Steps 5/6 of the SuperSplat-quality migration. The legacy
      // `(entity.gsplat as any).highQualitySH = true` doesn't actually flip SH on
      // PLY (the component's `_highQualitySH` defaults to true and the setter
      // early-returns), so we force the SH band count via `setDefine` on the
      // material instead. Same place we install the splatScale chunk.
      const mat = (entity.gsplat as unknown as { instance?: { material?: {
        setDefine: (k: string, v: string) => void;
        update: () => void;
        setParameter: (k: string, v: number) => void;
        getShaderChunks: (lang: typeof SHADERLANGUAGE_GLSL) => { set: (k: string, v: string) => void };
      } } }).instance?.material;
      if (mat) {
        mat.setDefine('SH_BANDS', String(DEFAULT_SH_BANDS));
        mat.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyVS', VIEWER_MODIFY_CHUNK);
        mat.setParameter('viewerSplatScale', DEFAULT_SPLAT_SCALE);
        mat.update(); // single shader recompile after both define + chunk are set
      }

      resolve(entity);
    });
    asset.on('error', (err: string) => {
      if (revoke) URL.revokeObjectURL(revoke);
      reject(new Error(`Failed to load GSplat: ${err}`));
    });
    app.assets.add(asset);
    app.assets.load(asset);
  });
}

/**
 * Load a SOG bundle previously uploaded via the Debug UI. The files (meta.json +
 * `*.webp`) live in IDB under `splat:<scene>:<plan>:sog/<filename>`; we resolve them
 * to fresh object URLs and feed them to PlayCanvas's SogParser via:
 *   - `file.url` set to a fake `meta.json` path so the gsplat handler dispatches
 *     to the JSON parser (the handler keys off filename extension).
 *   - `file.contents` pre-fetched as ArrayBuffer so the parser skips the network
 *     fetch (blob URLs would 404 if the parser tried to refetch them by URL string).
 *   - `mapUrl` callback that the parser uses to resolve the texture filenames it
 *     reads out of meta.json's `files` arrays, returning the matching IDB blob URL.
 *
 * Caller is responsible for `Plan.splatTransform` — applied here just like PLY.
 */
export async function loadSogFromIdb(
  app: AppBase,
  sceneId: string,
  planId: string,
  name: string = 'gsplat',
  transform?: SplatTransform,
): Promise<Entity> {
  const prefix = sogBundleKeyPrefix(sceneId, planId);
  const keys = await idb.listBlobKeys(prefix);
  if (keys.length === 0) throw new Error(`SOG bundle not found in IDB (prefix=${prefix})`);

  const urlMap = new Map<string, string>();
  let meta: unknown = null;
  for (const key of keys) {
    const blob = await idb.loadBlob(key);
    if (!blob) continue;
    const filename = key.slice(prefix.length);
    urlMap.set(filename, URL.createObjectURL(blob));
    if (filename === 'meta.json') meta = JSON.parse(await blob.text());
  }
  if (!meta) throw new Error('SOG bundle missing meta.json');

  return new Promise((resolve, reject) => {
    // Asset url is a fake `.json` path so the gsplat handler dispatches to SogParser
    // (handler keys off filename extension). The parser short-circuits its network
    // fetch when `asset.data.means` is already populated, so we hand it the
    // **pre-parsed** meta.json instead of bytes. Texture filenames inside meta are
    // resolved by `options.mapUrl` to our IDB blob URLs.
    const asset = new Asset(name, 'gsplat', {
      url: `mem://${sceneId}/${planId}/meta.json`,
      filename: 'meta.json',
    }, meta as object, {
      // mapUrl is a SOG parser hook — present at runtime in PlayCanvas v2 but
      // missing from the public Asset options type, so we cast.
      mapUrl: (filename: string) => urlMap.get(filename) ?? '',
    } as unknown as { crossOrigin?: 'anonymous' | 'use-credentials' | null });
    asset.on('load', () => {
      const entity = new Entity(name);
      entity.addComponent('gsplat', { asset });
      const rot = transform?.rotation ?? DEFAULT_SPLAT_ROTATION;
      const pos = transform?.position ?? DEFAULT_SPLAT_POSITION;
      entity.setEulerAngles(rot[0], rot[1], rot[2]);
      entity.setLocalPosition(pos[0], pos[1], pos[2]);
      app.root.addChild(entity);

      const mat = (entity.gsplat as unknown as { instance?: { material?: {
        setDefine: (k: string, v: string) => void;
        update: () => void;
        setParameter: (k: string, v: number) => void;
        getShaderChunks: (lang: typeof SHADERLANGUAGE_GLSL) => { set: (k: string, v: string) => void };
      } } }).instance?.material;
      if (mat) {
        mat.setDefine('SH_BANDS', String(DEFAULT_SH_BANDS));
        mat.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyVS', VIEWER_MODIFY_CHUNK);
        mat.setParameter('viewerSplatScale', DEFAULT_SPLAT_SCALE);
        mat.update();
      }

      resolve(entity);
    });
    asset.on('error', (err: string) => reject(new Error(`Failed to load SOG bundle: ${err}`)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}

/** Apply rotation + position to an already-loaded GSplat entity (for live preview). */
export function applySplatTransform(entity: Entity, transform: SplatTransform | undefined) {
  const rot = transform?.rotation ?? DEFAULT_SPLAT_ROTATION;
  const pos = transform?.position ?? DEFAULT_SPLAT_POSITION;
  entity.setEulerAngles(rot[0], rot[1], rot[2]);
  entity.setLocalPosition(pos[0], pos[1], pos[2]);
}

/**
 * Load a SOG bundle from a single-file `.sog` URL (zip wrapping `meta.json` +
 * `*.webp` textures, the SuperSplat-export format). Used for R2-hosted assets
 * — the customer's browser fetches one URL, we unzip in-memory with fflate,
 * and feed the parts straight to PlayCanvas's SogParser. Mirrors
 * `loadSogFromIdb` but skips the IDB hop.
 */
export async function loadSogFromUrl(
  app: AppBase,
  sogUrl: string,
  name: string = 'gsplat',
  transform?: SplatTransform,
  onProgress?: LoadProgress,
): Promise<Entity> {
  const blob = await fetchWithProgress(sogUrl, onProgress);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const entries = unzipSync(buf);

  const urlMap = new Map<string, string>();
  let meta: unknown = null;
  for (const [filename, data] of Object.entries(entries)) {
    const blob = new Blob([data.slice()]);
    urlMap.set(filename, URL.createObjectURL(blob));
    if (filename === 'meta.json') {
      meta = JSON.parse(new TextDecoder().decode(data));
    }
  }
  if (!meta) throw new Error('SOG zip missing meta.json');

  return new Promise((resolve, reject) => {
    const asset = new Asset(name, 'gsplat', {
      url: `mem://${name}/meta.json`,
      filename: 'meta.json',
    }, meta as object, {
      mapUrl: (filename: string) => urlMap.get(filename) ?? '',
    } as unknown as { crossOrigin?: 'anonymous' | 'use-credentials' | null });
    asset.on('load', () => {
      const entity = new Entity(name);
      entity.addComponent('gsplat', { asset });
      const rot = transform?.rotation ?? DEFAULT_SPLAT_ROTATION;
      const pos = transform?.position ?? DEFAULT_SPLAT_POSITION;
      entity.setEulerAngles(rot[0], rot[1], rot[2]);
      entity.setLocalPosition(pos[0], pos[1], pos[2]);
      app.root.addChild(entity);

      const mat = (entity.gsplat as unknown as { instance?: { material?: {
        setDefine: (k: string, v: string) => void;
        update: () => void;
        setParameter: (k: string, v: number) => void;
        getShaderChunks: (lang: typeof SHADERLANGUAGE_GLSL) => { set: (k: string, v: string) => void };
      } } }).instance?.material;
      if (mat) {
        mat.setDefine('SH_BANDS', String(DEFAULT_SH_BANDS));
        mat.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyVS', VIEWER_MODIFY_CHUNK);
        mat.setParameter('viewerSplatScale', DEFAULT_SPLAT_SCALE);
        mat.update();
      }

      resolve(entity);
    });
    asset.on('error', (err: string) => reject(new Error(`Failed to load SOG bundle from URL: ${err}`)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}

/**
 * Legacy no-op shim. The actual quality application now lives in
 * `render-presets.ts → applyRenderConfig`, which `SceneManager.setRenderMode` /
 * `applyRenderConfig` use directly. Kept exported so any stray callers still link.
 */
export function applyRenderMode(_entity: Entity, _mode: import('./render-presets').RenderMode) {}
