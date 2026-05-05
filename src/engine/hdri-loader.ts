import {
  AppBase,
  Asset,
  Quat,
  Texture,
  TextureHandler,
  EnvLighting,
  Vec3,
} from 'playcanvas';

/** 180° rotation around +Y, baked once. Aligns equirect u=0.5 with camera yaw=0. */
const SKYBOX_Y_FLIP = new Quat().setFromAxisAngle(Vec3.UP, 180);

/**
 * Load an HDRI image (HDR/PNG/JPG/EXR) and apply it as skybox + environment lighting.
 * Accepts a URL or data URL.
 *
 * The skybox is rotated 180° around Y so the equirect's longitude-0 (image horizontal
 * center, u=0.5) lines up with PlayCanvas's camera yaw 0 (looking -Z). Without this,
 * camera yaw 0 samples the equirect's seam and the saved-view ↔ rendered-view alignment
 * is impossible to achieve without per-component yaw offsets that ripple into the
 * floor-plan map (mapYaw / cone direction). With the rotation, "yaw 0 = front" holds
 * end-to-end across preview, camera, mapYaw and live cone.
 */
export async function applyHdri(app: AppBase, url: string): Promise<void> {
  // Ensure TextureHandler is registered
  if (!app.loader.getHandler('texture')) {
    app.loader.addHandler('texture', new TextureHandler(app));
  }

  const texture = await loadTexture(app, url);

  // Skybox cubemap face size. The previous fixed 512 visibly downsampled 4K+ panoramas;
  // 1024 quadruples the resolution while keeping GPU memory modest (~24 MB RGBA8).
  const skyboxCubemap = EnvLighting.generateSkyboxCubemap(texture, 1024);
  app.scene.skybox = skyboxCubemap;

  // Env atlas drives ambient/reflections, not the visible background, so default size is fine.
  const lightingSource = EnvLighting.generateLightingSource(texture);
  const envAtlas = EnvLighting.generateAtlas(lightingSource);
  app.scene.envAtlas = envAtlas;

  app.scene.skyboxIntensity = 1.0;
  app.scene.skyboxMip = 0;
  app.scene.skyboxRotation = SKYBOX_Y_FLIP;
}

/** Remove the current skybox */
export function removeHdri(app: AppBase) {
  app.scene.skybox = null;
  app.scene.envAtlas = null;
}

/** Set skybox intensity */
export function setHdriIntensity(app: AppBase, intensity: number) {
  app.scene.skyboxIntensity = intensity;
}

function loadTexture(app: AppBase, url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const asset = new Asset('hdri', 'texture', { url });
    asset.on('load', () => {
      resolve(asset.resource as Texture);
    });
    asset.on('error', (err: string) => {
      reject(new Error(`Failed to load HDRI: ${err}`));
    });
    app.assets.add(asset);
    app.assets.load(asset);
  });
}
