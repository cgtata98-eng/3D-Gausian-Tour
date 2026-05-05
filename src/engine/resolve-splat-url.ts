import { resolveScenePath } from '../core/scene-manifest';
import { resolveBlobRef } from '../utils/idb';

/**
 * Resolve a manifest splat reference (one of `data:`, `blob:`, `idb:<key>`, `/-prefix`,
 * or a scene-relative path) into a fetchable URL that any of our 3DGS engines can
 * load. Mirrors the chain in `scene-manager.ts:resolveAssetUrl` but exported so the
 * engine adapters (mkkellogg, Spark) outside SceneManager can share it.
 *
 * For `idb:` refs the returned URL is a fresh `blob:` object URL — caller is
 * responsible for `URL.revokeObjectURL` on cleanup.
 */
export async function resolveSplatUrl(raw: string, sceneId: string): Promise<string> {
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
  if (raw.startsWith('idb:')) return resolveBlobRef(raw);
  if (raw.startsWith('/')) return raw;
  return resolveScenePath(sceneId, raw);
}
