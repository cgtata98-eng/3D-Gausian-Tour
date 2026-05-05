import type { SceneManifest } from './types';
import { useProjectStore } from '../store/project-store';
import * as idb from '../utils/idb';

const SCENES_BASE = '/assets/scenes';

/** Build a minimal manifest from a Project entry — used when no scene.json exists on disk yet. */
function buildVirtualManifest(sceneId: string): SceneManifest | null {
  const project = useProjectStore.getState().getProject(sceneId);
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    settings: {
      cameraHeight: 1.6,
      initialHeight: 1.6,
      moveSpeed: 3.0,
      collisionCapsuleRadius: 0.3,
      collisionCapsuleHeight: 1.6,
      initialPositionMode: 'auto',
    },
  };
}

/**
 * Load and validate a scene manifest. Resolution order:
 *   1. IndexedDB (the user's edited copy — viewpoints, panoramas, info, ...)
 *   2. /assets/scenes/{id}/scene.json (shipped baseline)
 *   3. Virtual manifest synthesised from the project store
 */
export async function loadSceneManifest(sceneId: string): Promise<SceneManifest> {
  // 1. IDB takes precedence so user edits survive reloads.
  try {
    const persisted = await idb.loadManifest<SceneManifest>(sceneId);
    if (persisted && persisted.id) return persisted;
  } catch (e) {
    console.warn('[idb] manifest load failed, falling back:', e);
  }

  // 2. Network fetch.
  const url = `${SCENES_BASE}/${sceneId}/scene.json`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const manifest: SceneManifest = await res.json();
      if (!manifest.id) throw new Error(`Invalid scene manifest: "id" is required`);
      return manifest;
    }
    // 404 etc — fall through to virtual lookup.
  } catch {
    // Network error — fall through.
  }

  // 3. Virtual fallback.
  const virtual = buildVirtualManifest(sceneId);
  if (virtual) return virtual;

  throw new Error(`Scene "${sceneId}" not found (no scene.json and no project entry)`);
}

/** Resolve a relative asset path within a scene */
export function resolveScenePath(sceneId: string, relativePath: string): string {
  return `${SCENES_BASE}/${sceneId}/${relativePath}`;
}
