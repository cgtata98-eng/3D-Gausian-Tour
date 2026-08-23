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
 *  built-in shader doesn't read `mat.setParameter('splatScale', 窶ｦ)`, so we override
 *  the chunk and feed the value through this uniform instead. */
const VIEWER_MODIFY_CHUNK = `
uniform float viewerSplatScale;
// 菫ｯ迸ｰ譁ｭ髱｢ (top-down collision editing): splats whose WORLD-space Y is above
// this are collapsed to zero scale (= invisible). 1e9 = disabled. The world
// transform is passed as our own uniform because \`matrix_model\` lives in
// gsplatCenterVS, which is #included AFTER this chunk 窶・GLSL can't forward-
// reference it from here.
uniform float viewerClipY;
uniform mat4 viewerClipModelMat;

void modifySplatCenter(inout vec3 center) {}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    scale *= viewerSplatScale;
    if (viewerClipY < 8.9e8) {
        float worldY = (viewerClipModelMat * vec4(modifiedCenter, 1.0)).y;
        if (worldY > viewerClipY) scale = vec3(0.0);
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {}
`;
/** viewerClipY value that disables the cross-section (see chunk guard). */
export const SPLAT_CLIP_DISABLED = 1e9;
const DEFAULT_SPLAT_SCALE = 1.15; // SuperSplat-feel default; 1.15縲・.25 is usable.
const DEFAULT_SH_BANDS = 3;       // 0..3, full SH at load time.

/** 繝ｭ繝ｼ繝・ 繧剃ｸ贋ｽ・(LoadingScreen) 縺ｫ莨昴∴繧九◆繧√・繧ｳ繝ｼ繝ｫ繝舌ャ繧ｯ縲Ａprogress` 縺ｯ 0..1縲・ *  Content-Length 縺悟叙繧後★豁｣遒ｺ縺ｪ蛻・ｯ阪′蛻・°繧峨↑縺・→縺阪・ `null` (= 繧ｹ繝・・繧ｿ繧ｹ荳肴・)縲・*/
export type LoadProgress = (progress: number | null) => void;

/**
 * `fetch` 繧貞他縺ｳ縺､縺､ Reader API 縺ｧ騾先ｬ｡繝舌う繝域焚繧帝寔險医～onProgress(0..1)` 繧堤匱轣ｫ縺励↑縺後ｉ
 * 蜈ｨ繝舌う繝医ｒ 1 蛟九・ Blob 縺ｫ縺ｾ縺ｨ繧√※霑斐☆縲・ontent-Length 縺檎┌縺・(= 蝨ｧ邵ｮ霆｢騾√↑縺ｩ) 蝣ｴ蜷医・
 * 1 蠎ｦ縺縺・`null` 繧堤匱轣ｫ縺励※縺九ｉ鮟吶・→隱ｭ繧 窶・荳贋ｽ阪・縲後ム繧ｦ繝ｳ繝ｭ繝ｼ繝我ｸｭ縺縺・%譛ｪ遒ｺ螳壹阪→縺励※
 * 繧ｹ繝斐リ繝ｼ縺縺大・縺帙・繧医＞縲・ */
async function fetchWithProgress(url: string, onProgress?: LoadProgress): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText} (${url})`);
  const totalHdr = res.headers.get('content-length');
  const total = totalHdr ? parseInt(totalHdr, 10) : 0;
  if (!res.body || !total) {
    // 騾ｲ謐励ｒ蜿悶ｌ縺ｪ縺・こ繝ｼ繧ｹ: Blob 縺縺題ｿ斐＠縺ｦ null 繧呈ｵ√☆縲・    onProgress?.(null);
    return new Uint8Array(await res.arrayBuffer());
  }
  // 受け取りは **1 本の Uint8Array に直接積む**。
  //
  // 以前はチャンクを配列に貯めて Blob を作り、そのあと arrayBuffer() で読み直して
  // いた。90MB の .sog でピークが 3 倍以上になり、スマホ (特に iOS Safari) では
  // タブごと落ちる。Content-Length は分かっているので、最初から確保して埋める。
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  /** Content-Length を超えた場合の逃げ道。圧縮転送だと申告より長く届きうる。 */
  let overflow: Uint8Array[] | null = null;
  let received = 0;
  onProgress?.(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!overflow && received + value.byteLength > total) overflow = [out.subarray(0, received)];
    if (overflow) overflow.push(value.slice());
    else out.set(value, received);
    received += value.byteLength;
    onProgress?.(Math.min(1, received / total));
  }
  onProgress?.(1);
  if (overflow) {
    const len = overflow.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(len);
    let at = 0;
    for (const c of overflow) { merged.set(c, at); at += c.byteLength; }
    return merged;
  }
  // 申告より短ければ途中で切れている。ここで止めないと、下流が「壊れたファイル」
  // として扱い、zip なら「invalid zip data」という原因の分からない失敗になる。
  if (received < total) {
    throw new Error(`ダウンロードが途中で切れました: ${received} / ${total} バイト (${url})`);
  }
  return out;
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
  // 繝舌う繝磯ｲ謐励′谺ｲ縺励＞縺ｮ縺ｧ荳譌ｦ fetch 縺ｧ蜈ｨ繝舌う繝医ｒ蜿門ｾ・竊・Blob 竊・object URL 繧・Asset 縺ｫ貂｡縺吶・  // (`data:` / `blob:` / `mem://` 遲峨・縺昴・縺ｾ縺ｾ PlayCanvas 縺ｫ謚輔￡繧・窶・騾ｲ謐励・蜃ｺ縺ｪ縺・
  let assetUrl = url;
  let revoke: string | null = null;
  if (/^https?:|^\//.test(url)) {
    const bytes = await fetchWithProgress(url, onProgress);
    assetUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
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
        mat.setParameter('viewerClipY', SPLAT_CLIP_DISABLED);
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
 * Caller is responsible for `Plan.splatTransform` 窶・applied here just like PLY.
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
      // mapUrl is a SOG parser hook 窶・present at runtime in PlayCanvas v2 but
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
        mat.setParameter('viewerClipY', SPLAT_CLIP_DISABLED);
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
 * 中身が本当に zip かを先に見る。
 *
 * fflate は zip でないものを渡されると「invalid zip data」としか言わない。実際に
 * 起きるのはたいてい **404 ではなく 200 で zip 以外が返っている** ケースで
 * (SPA のフォールバックが index.html を返す / R2 のエラーページ / 認証の入口への
 * リダイレクト)、あのメッセージからは何が返ってきたのか一切分からない。
 *
 * 先頭 4 バイトを見れば zip かどうかは確定する。違うなら、何が返ってきたのかを
 * 添えて落とす — 原因を突き止めるのに要るのはその 1 行だけ。
 */
function assertZip(buf: Uint8Array, url: string, contentType: string): void {
  // ローカルファイルヘッダ "PK\x03\x04"。中身が空の zip ("PK\x05\x06") も通す。
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06));
  if (isZip) return;
  const head = new TextDecoder().decode(buf.slice(0, 64)).replace(/\s+/g, ' ').trim();
  const looksHtml = /^<!doctype|^<html/i.test(head);
  throw new Error(
    `SOG が zip ではありません (${url}) — ${buf.length} バイト / Content-Type: ${contentType || '不明'}`
    + (looksHtml
      ? '。HTML が返っています: そのファイルが R2 に無く、SPA のフォールバックか'
        + 'エラーページを掴んでいます。公開しなおして .sog が上がっているか確認してください。'
      : `。先頭: "${head.slice(0, 48)}"`),
  );
}

/**
 * Load a SOG bundle from a single-file `.sog` URL (zip wrapping `meta.json` +
 * `*.webp` textures, the SuperSplat-export format). Used for R2-hosted assets
 * 窶・the customer's browser fetches one URL, we unzip in-memory with fflate,
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
  const buf = await fetchWithProgress(sogUrl, onProgress);
  assertZip(buf, sogUrl, 'application/octet-stream');
  const entries = unzipSync(buf);

  const urlMap = new Map<string, string>();
  let meta: unknown = null;
  for (const [filename, data] of Object.entries(entries)) {
    // `data.slice()` を挟まない。Blob の生成で中身はどのみち複製されるので、
    // 事前のコピーは丸ごと無駄 ― 90MB の束では素材 1 個ごとに効いてくる。
    const blob = new Blob([(data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength)]);
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
        mat.setParameter('viewerClipY', SPLAT_CLIP_DISABLED);
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
 * `render-presets.ts 竊・applyRenderConfig`, which `SceneManager.setRenderMode` /
 * `applyRenderConfig` use directly. Kept exported so any stray callers still link.
 */
export function applyRenderMode(_entity: Entity, _mode: import('./render-presets').RenderMode) {}
