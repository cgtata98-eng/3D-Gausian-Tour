/**
 * Frontend → Cloudflare Worker upload helpers. Used by the DebugViewer's
 * "公開" button to push the current scene + assets to R2 in one go.
 *
 * The Worker route is `/api/publish/<sceneId>/<filename>` and accepts:
 *   - `PUT`    upload binary; body is the raw file bytes
 *   - `DELETE` remove an object
 *
 * Auth is HTTP Basic against the same credentials as the AuthGate.
 */
import { getAuthHeader } from './auth';
import { zip } from 'fflate';
import * as idb from './idb';

function authHeader(): string {
  return getAuthHeader();
}

/** Cloudflare Workers free-plan body limit is 100MB. Our chunk size leaves
 *  headroom for HTTP framing and matches R2 multipart's 5MB-minimum-per-part
 *  rule (everything except the last must be ≥ 5MB). */
const SINGLE_PUT_MAX = 90 * 1024 * 1024; // < 100MB Worker body limit
const CHUNK_SIZE = 50 * 1024 * 1024;     // 50MB parts

/** Upload a file to R2. Picks single-PUT for small files, R2 multipart for
 *  anything over ~90MB so we don't hit the Workers body limit. */
export async function publishFile(sceneId: string, filename: string, body: Blob): Promise<void> {
  if (body.size <= SINGLE_PUT_MAX) {
    return publishFileSingle(sceneId, filename, body);
  }
  return publishFileMultipart(sceneId, filename, body);
}

async function publishFileSingle(sceneId: string, filename: string, body: Blob): Promise<void> {
  const res = await fetch(`/api/publish/${encodeURIComponent(sceneId)}/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': body.type || 'application/octet-stream',
    },
    body,
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status} ${res.statusText} (${filename})`);
}

async function publishFileMultipart(sceneId: string, filename: string, body: Blob): Promise<void> {
  const baseUrl = `/api/publish/${encodeURIComponent(sceneId)}/${encodeURIComponent(filename)}`;
  const contentType = body.type || 'application/octet-stream';

  // 1. Create multipart upload, get an uploadId.
  const createRes = await fetch(`${baseUrl}?action=create&contentType=${encodeURIComponent(contentType)}`, {
    method: 'POST',
    headers: { 'Authorization': authHeader() },
  });
  if (!createRes.ok) throw new Error(`multipart create failed: ${createRes.status}`);
  const { uploadId } = await createRes.json() as { uploadId: string };

  // 2. Upload parts sequentially. (Could parallelise but home-internet uplink
  //    is the bottleneck anyway, and serial keeps memory usage flat.)
  const parts: Array<{ partNumber: number; etag: string }> = [];
  try {
    for (let offset = 0, partNumber = 1; offset < body.size; offset += CHUNK_SIZE, partNumber++) {
      const chunk = body.slice(offset, Math.min(offset + CHUNK_SIZE, body.size));
      const partRes = await fetch(`${baseUrl}?action=part&uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}`, {
        method: 'PUT',
        headers: { 'Authorization': authHeader(), 'Content-Type': contentType },
        body: chunk,
      });
      if (!partRes.ok) throw new Error(`part ${partNumber} failed: ${partRes.status}`);
      const { etag } = await partRes.json() as { etag: string };
      parts.push({ partNumber, etag });
    }
  } catch (e) {
    // Try to clean up so we don't leave a half-finished upload sitting on R2
    // (R2 charges for orphaned multipart uploads after the lifecycle window).
    try {
      await fetch(`${baseUrl}?action=abort&uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'POST',
        headers: { 'Authorization': authHeader() },
      });
    } catch { /* ignore */ }
    throw e;
  }

  // 3. Tell R2 to stitch the parts into the final object.
  const completeRes = await fetch(`${baseUrl}?action=complete&uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'POST',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts }),
  });
  if (!completeRes.ok) throw new Error(`multipart complete failed: ${completeRes.status}`);
}

/** Delete one object from R2. */
export async function unpublishFile(sceneId: string, filename: string): Promise<void> {
  const res = await fetch(`/api/publish/${encodeURIComponent(sceneId)}/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: { 'Authorization': authHeader() },
  });
  if (!res.ok) throw new Error(`unpublish failed: ${res.status} (${filename})`);
}

/**
 * Re-zip the SOG bundle parts stored in IDB back into a single `.sog` file
 * that the runtime SOG loader can read. The Debug UI splits a user-uploaded
 * `.sog` (zip of `meta.json` + `*.webp`) into individual IDB blobs for fast
 * editing; for publish we recombine them so the customer fetches one URL.
 *
 * Performance notes:
 *   - IDB blob reads run in parallel (Promise.all) — IDB is happy to multiplex
 *     read requests, so this beats serial reads by 5–10× on big bundles.
 *   - Uses `zip` (async) instead of `zipSync` so fflate runs in a Web Worker
 *     and the main thread stays responsive while the bundle (often 100MB+) is
 *     packed. Level 0 = store, since the *.webp parts inside are already
 *     compressed; re-deflating just burns CPU.
 *
 * Returns null if no SOG bundle exists for this scene/plan.
 */
export async function repackSogBundle(sceneId: string, planId: string): Promise<Blob | null> {
  const prefix = `splat:${sceneId}:${planId}:sog/`;
  const keys = await idb.listBlobKeys(prefix);
  if (keys.length === 0) return null;
  // Read every part in parallel.
  const parts = await Promise.all(keys.map(async (key) => {
    const blob = await idb.loadBlob(key);
    if (!blob) return null;
    return { name: key.slice(prefix.length), bytes: new Uint8Array(await blob.arrayBuffer()) };
  }));
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const part of parts) {
    if (part) entries[part.name] = [part.bytes, { level: 0 }];
  }
  if (!entries['meta.json']) return null;
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 0 }, (err, data) => {
      if (err) reject(err); else resolve(data);
    });
  });
  return new Blob([new Uint8Array(zipped)], { type: 'application/octet-stream' });
}

/**
 * Resolve a stored splat reference (PLY/SPZ blob in IDB) to a Blob. Used by
 * publish to upload the actual file regardless of its origin.
 */
export async function resolveSplatBlob(splatRef: string | undefined): Promise<Blob | null> {
  if (!splatRef) return null;
  if (splatRef.startsWith(idb.IDB_REF_PREFIX)) {
    const key = splatRef.slice(idb.IDB_REF_PREFIX.length);
    return idb.loadBlob(key);
  }
  // Already a relative path / URL — caller should fetch it directly.
  return null;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

interface PublishProgress {
  message: string;
  current: number;
  total: number;
}

interface SceneLike {
  id: string;
  plans?: Array<{
    id: string;
    splat?: string;
    splatSpz?: string;
    splatSog?: string;
    floorPlan?: { image?: string; [k: string]: unknown };
    collision?: {
      walkable?: string; block?: string;
      manualWalkable?: string; manualBlock?: string;
      autoWalkable?: string; autoBlock?: string;
      source?: string;
    };
    walk?: { nodes?: Array<{ id: string; panorama?: string; [k: string]: unknown }>; [k: string]: unknown };
    video360?: {
      src?: string;
      srcReverse?: string;
      variants?: Array<{ id: string; src?: string; srcReverse?: string; [k: string]: unknown }>;
      edges?: Array<{ id: string; clip?: { src?: string; reverse?: string; [k: string]: unknown }; [k: string]: unknown }>;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

/**
 * 360°動画の素材で、まだアップロードが要るもの。
 *
 * オーサリング中は IDB 参照 (`idb:...`) か data URL になっている。そのまま
 * scene.json に書いて配ると、お客さんの端末にはその blob が無いので黒い画面に
 * なる。ここで実体を上げてファイル名に書き換える。
 *
 * すでにファイル名 (R2 に上げ済み) のものは触らない ―
 * `scripts/video360/build-variants.mjs --publish` で先に上げてある経路がある。
 */
function video360Slots(v360: NonNullable<NonNullable<SceneLike['plans']>[number]['video360']>) {
  const slots: { get: () => string | undefined; set: (name: string) => void; hint: string }[] = [];
  slots.push({ get: () => v360.src, set: (n) => { v360.src = n; }, hint: 'main' });
  slots.push({ get: () => v360.srcReverse, set: (n) => { v360.srcReverse = n; }, hint: 'main-rev' });
  for (const va of v360.variants ?? []) {
    slots.push({ get: () => va.src, set: (n) => { va.src = n; }, hint: va.id });
    slots.push({ get: () => va.srcReverse, set: (n) => { va.srcReverse = n; }, hint: `${va.id}-rev` });
  }
  for (const e of v360.edges ?? []) {
    if (!e.clip) continue;
    const clip = e.clip;
    slots.push({ get: () => clip.src, set: (n) => { clip.src = n; }, hint: `clip-${e.id}` });
    slots.push({ get: () => clip.reverse, set: (n) => { clip.reverse = n; }, hint: `clip-${e.id}-rev` });
  }
  return slots;
}

/** その参照はアップロードが要るか (IDB / data URL か)。 */
function needsUpload(ref: string | undefined): boolean {
  return !!ref && (ref.startsWith(idb.IDB_REF_PREFIX) || ref.startsWith('data:'));
}

/**
 * Publish a scene to R2 in one go: re-pack the SOG bundle, upload binaries,
 * rewrite the manifest so it references those uploaded paths, and finally
 * upload the manifest. After this returns, customers can open
 * `https://<host>/viewer/<sceneId>` and the runtime fetches everything from R2.
 */
export async function publishScene(
  manifest: SceneLike,
  onProgress: (p: PublishProgress) => void = () => {},
): Promise<void> {
  const sceneId = manifest.id;
  if (!sceneId) throw new Error('manifest has no id');

  // Deep clone so we can rewrite paths without mutating the live store state.
  const publicManifest: SceneLike = JSON.parse(JSON.stringify(manifest));

  // Pre-count how many uploads we'll do for the progress display.
  const plans = publicManifest.plans ?? [];
  let total = 1; // scene.json
  for (const plan of plans) {
    if (plan.splatSog && plan.splatSog.startsWith('sog-idb:')) total++;
    if (plan.splat && plan.splat.startsWith(idb.IDB_REF_PREFIX)) total++;
    if (plan.splatSpz && plan.splatSpz.startsWith(idb.IDB_REF_PREFIX)) total++;
    if (plan.floorPlan?.image && plan.floorPlan.image.startsWith('data:')) total++;
    if (plan.collision?.walkable?.startsWith(idb.IDB_REF_PREFIX)) total++;
    if (plan.collision?.block?.startsWith(idb.IDB_REF_PREFIX)) total++;
    for (const node of plan.walk?.nodes ?? []) {
      if (node.panorama?.startsWith(idb.IDB_REF_PREFIX) || node.panorama?.startsWith('data:')) total++;
    }
    if (plan.video360) total += video360Slots(plan.video360).filter((s) => needsUpload(s.get())).length;
  }
  let current = 0;
  const tick = (message: string) => onProgress({ message, current: ++current, total });

  for (const plan of plans) {
    const planId = plan.id;

    // SOG bundle (multi-file, IDB-stored). Re-zip and upload as a single .sog.
    if (plan.splatSog && plan.splatSog.startsWith('sog-idb:')) {
      tick(`SOG を再パック中: ${planId}`);
      const sogBlob = await repackSogBundle(sceneId, planId);
      if (sogBlob) {
        const filename = plans.length > 1 ? `splat-${planId}.sog` : 'splat.sog';
        await publishFile(sceneId, filename, sogBlob);
        plan.splatSog = filename;
      }
    }

    // Raw PLY / SPZ blob in IDB. Upload as-is and rewrite the path.
    if (plan.splat && plan.splat.startsWith(idb.IDB_REF_PREFIX)) {
      const blob = await resolveSplatBlob(plan.splat);
      if (blob) {
        const filename = plans.length > 1 ? `splat-${planId}.ply` : 'splat.ply';
        tick(`PLY をアップロード: ${filename}`);
        await publishFile(sceneId, filename, blob);
        plan.splat = filename;
      }
    }
    if (plan.splatSpz && plan.splatSpz.startsWith(idb.IDB_REF_PREFIX)) {
      const blob = await resolveSplatBlob(plan.splatSpz);
      if (blob) {
        const filename = plans.length > 1 ? `splat-${planId}.spz` : 'splat.spz';
        tick(`SPZ をアップロード: ${filename}`);
        await publishFile(sceneId, filename, blob);
        plan.splatSpz = filename;
      }
    }

    // Floor plan image as data URL → upload as PNG.
    if (plan.floorPlan?.image && plan.floorPlan.image.startsWith('data:')) {
      const filename = plans.length > 1 ? `floorplan-${planId}.png` : 'floorplan.png';
      tick(`図面をアップロード: ${filename}`);
      const blob = await dataUrlToBlob(plan.floorPlan.image);
      await publishFile(sceneId, filename, blob);
      (plan.floorPlan as { image: string }).image = filename;
    }

    // Collision GLBs (walkable / block) — upload from IDB and rewrite refs.
    // Only the ACTIVE set is published; the manual*/auto* stashes are authoring
    // state whose idb: refs are meaningless on the customer's machine, so strip
    // them (and the source marker) from the public manifest.
    if (plan.collision) {
      for (const type of ['walkable', 'block'] as const) {
        const ref = plan.collision[type];
        if (!ref || !ref.startsWith(idb.IDB_REF_PREFIX)) continue;
        const blob = await idb.loadBlob(ref.slice(idb.IDB_REF_PREFIX.length));
        if (!blob) continue;
        const filename = plans.length > 1
          ? `collision-${type}-${planId}.glb`
          : `collision-${type}.glb`;
        tick(`コリジョンをアップロード: ${filename}`);
        await publishFile(sceneId, filename, blob);
        plan.collision[type] = filename;
      }
      delete plan.collision.manualWalkable;
      delete plan.collision.manualBlock;
      delete plan.collision.autoWalkable;
      delete plan.collision.autoBlock;
      delete plan.collision.source;
    }

    // Walkthrough-node panoramas (idb blobs / data URLs) → upload and rewrite,
    // mirroring the per-viewpoint panorama handling above.
    for (const node of plan.walk?.nodes ?? []) {
      const src = node.panorama;
      if (!src) continue;
      let blob: Blob | null = null;
      if (src.startsWith(idb.IDB_REF_PREFIX)) blob = await idb.loadBlob(src.slice(idb.IDB_REF_PREFIX.length));
      else if (src.startsWith('data:')) blob = await dataUrlToBlob(src);
      if (!blob) continue;
      const filename = plans.length > 1 ? `walk-${planId}-${node.id}.jpg` : `walk-${node.id}.jpg`;
      tick(`ウォークスルー画像をアップロード: ${filename}`);
      await publishFile(sceneId, filename, blob);
      node.panorama = filename;
    }

    // 360°動画の素材。本編・反転・描き分けバリアント・エッジ専用クリップまで、
    // まだ IDB / data URL のものを実ファイルにして参照を書き換える。
    // ここが無いと、オーサリングでは映るのに配ると真っ黒、という壊れ方になる。
    if (plan.video360) {
      for (const slot of video360Slots(plan.video360)) {
        const ref = slot.get();
        if (!needsUpload(ref)) continue;
        let blob: Blob | null = null;
        if (ref!.startsWith(idb.IDB_REF_PREFIX)) blob = await idb.loadBlob(ref!.slice(idb.IDB_REF_PREFIX.length));
        else blob = await dataUrlToBlob(ref!);
        if (!blob) continue;
        // 拡張子は中身から決める。webm を .mp4 で置くと、Range 取得で codec を
        // 誤判定するブラウザがあって再生できなくなる。
        const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'mp4' : 'bin';
        const filename = plans.length > 1
          ? `video360-${planId}-${slot.hint}.${ext}`
          : `video360-${slot.hint}.${ext}`;
        tick(`360°動画をアップロード: ${filename}`);
        await publishFile(sceneId, filename, blob);
        slot.set(filename);
      }
    }
  }

  // Upload manifest LAST so customers never see a half-published state where
  // scene.json already references files that haven't finished uploading.
  tick('scene.json をアップロード中…');
  const manifestBlob = new Blob([JSON.stringify(publicManifest, null, 2)], { type: 'application/json' });
  await publishFile(sceneId, 'scene.json', manifestBlob);

  // Drop a tiny marker so the project's friendly name shows up as a sub-folder
  // in the R2 dashboard. Without this every scene is just a random 16-char
  // bucket prefix and you can't tell `qi8...` apart from `k7m...`.
  const friendlyName = typeof publicManifest.name === 'string' ? publicManifest.name : '';
  const safeName = friendlyName
    .replace(/[\\/:*?"<>|]/g, '')   // strip filesystem-unsafe chars
    .trim()
    .slice(0, 60);
  if (safeName) {
    try {
      await publishFile(sceneId, `_name_${safeName}/.placeholder`, new Blob([''], { type: 'text/plain' }));
    } catch (e) {
      console.warn('marker folder upload failed (non-fatal):', e);
    }
  }
}
