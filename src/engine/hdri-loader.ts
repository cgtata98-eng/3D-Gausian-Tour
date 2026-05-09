import { AppBase, Quat, Vec3 } from 'playcanvas';
import { applyEquirectSkybox, removeEquirectSkybox } from './equirect-skybox';

/** 180° rotation around +Y, baked once. Aligns equirect u=0.5 with camera yaw=0. */
const SKYBOX_Y_FLIP = new Quat().setFromAxisAngle(Vec3.UP, 180);

/**
 * Load a panorama image (PNG/JPG; HDR/EXR not supported in this path) and apply
 * it as the visible 360° skybox.
 *
 * The visible skybox is rendered by `equirect-skybox.ts` — a custom mesh that
 * samples the equirect texture directly via spherical UVs from the view
 * direction. This bypasses PlayCanvas's `EnvLighting.generateSkyboxCubemap`,
 * which otherwise bakes a visible "dot" at zenith / nadir from the equirect's
 * polar rows being collapsed into a single cubemap texel at +Y / -Y face
 * centre.
 *
 * The skybox is rotated 180° around Y so the equirect's longitude-0 (image horizontal
 * center, u=0.5) lines up with PlayCanvas's camera yaw 0 (looking -Z). Without this,
 * camera yaw 0 samples the equirect's seam and the saved-view ↔ rendered-view alignment
 * is impossible to achieve without per-component yaw offsets that ripple into the
 * floor-plan map (mapYaw / cone direction). With the rotation, "yaw 0 = front" holds
 * end-to-end across preview, camera, mapYaw and live cone.
 *
 * IBL / env atlas is intentionally not generated here. PlayCanvas's `Sky` falls
 * back to envAtlas when `scene.skybox` is null and renders the small mipmap
 * atlas into the SKYBOX layer, which blurs everything our custom mesh would
 * have drawn. Since the 3DGS splat doesn't use IBL reflections (and the
 * 360 mode shows nothing else), dropping env atlas costs nothing visible.
 */
export async function applyHdri(app: AppBase, url: string): Promise<void> {
  // Force the env atlas off so PlayCanvas's auto SkyMesh fallback path (which
  // would otherwise render the tiny mipmap atlas as a blurred backdrop) stays
  // disabled. See module-level comment for the full reasoning.
  app.scene.envAtlas = null;
  app.scene.skybox = null;

  await applyEquirectSkybox(app, url);

  app.scene.skyboxIntensity = 1.0;
  app.scene.skyboxMip = 0;
  app.scene.skyboxRotation = SKYBOX_Y_FLIP;
}

/** Remove the current skybox */
export function removeHdri(app: AppBase) {
  removeEquirectSkybox(app);
  app.scene.skybox = null;
  app.scene.envAtlas = null;
}

/** Set skybox intensity */
export function setHdriIntensity(app: AppBase, intensity: number) {
  app.scene.skyboxIntensity = intensity;
}
