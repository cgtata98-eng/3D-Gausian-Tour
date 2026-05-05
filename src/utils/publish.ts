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
import { ADMIN_USERNAME, ADMIN_PASSWORD } from '../shared/admin-credentials';
import { zip } from 'fflate';
import * as idb from './idb';

function authHeader(): string {
  return 'Basic ' + btoa(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`);
}

/** Upload a single file to R2 under `<sceneId>/<filename>`. Throws on non-2xx. */
export async function publishFile(sceneId: string, filename: string, body: Blob): Promise<void> {
  const res = await fetch(`/api/publish/${encodeURIComponent(sceneId)}/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': body.type || 'application/octet-stream',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`publish failed: ${res.status} ${res.statusText} (${filename})`);
  }
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
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
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
  }

  // Upload manifest LAST so customers never see a half-published state where
  // scene.json already references files that haven't finished uploading.
  tick('scene.json をアップロード中…');
  const manifestBlob = new Blob([JSON.stringify(publicManifest, null, 2)], { type: 'application/json' });
  await publishFile(sceneId, 'scene.json', manifestBlob);
}
