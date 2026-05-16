import { AppBase, Color, Entity } from 'playcanvas';

/**
 * Studio backdrop = camera clearColor. Always present (no mode toggle). HDRI,
 * when loaded, draws on top of the clear via the SKYBOX layer; removing the
 * HDRI exposes this color again. Splats render unlit (3DGS color is baked) so
 * the studio doesn't contribute any lighting — it's purely the background.
 */
const DEFAULT_BG: [number, number, number] = [0.92, 0.92, 0.92];

export const DEFAULT_STUDIO_COLOR = DEFAULT_BG;

export function setStudioColor(app: AppBase, color: [number, number, number]): void {
  const cam = app.root.findByName('camera') as Entity | null;
  if (cam?.camera) {
    cam.camera.clearColor = new Color(color[0], color[1], color[2]);
  }
}
