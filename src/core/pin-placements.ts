import type { PinPlacement, ScenePin } from './types';

/**
 * Read all placements of a `ScenePin`, transparently migrating the legacy
 * single-placement (`position` + `viewpointId` at the top level) into a
 * synthetic `PinPlacement` array. Existing saved scenes keep working without
 * any one-shot migration script — just calling this on every read promotes
 * them lazily.
 */
export function getPinPlacements(pin: ScenePin): PinPlacement[] {
  if (pin.placements && pin.placements.length > 0) return pin.placements;
  if (pin.position && pin.viewpointId) {
    return [{ id: 'legacy', viewpointId: pin.viewpointId, position: pin.position }];
  }
  return [];
}

/** Generate a short unique id for a placement (independent of the pin's id). */
export function newPlacementId(): string {
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
