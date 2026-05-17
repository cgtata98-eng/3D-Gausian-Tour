import {
  AppBase,
  ADDRESS_REPEAT,
  ADDRESS_CLAMP_TO_EDGE,
  BoxGeometry,
  CULLFACE_FRONT,
  FILTER_LINEAR,
  GraphNode,
  LAYERID_SKYBOX,
  Layer,
  Mesh,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  PIXELFORMAT_RGBA16F,
  SEMANTIC_POSITION,
  SHADERLANGUAGE_GLSL,
  ShaderChunks,
  ShaderMaterial,
  Texture,
  TEXTURETYPE_DEFAULT,
} from 'playcanvas';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { HalfFloatType } from 'three';

/**
 * Custom equirect skybox — bypasses PlayCanvas's `EnvLighting.generateSkyboxCubemap`
 * cubemap conversion entirely and renders the panorama by sampling the equirect 2D
 * texture directly via spherical coordinates from the view direction.
 *
 * Why: `EnvLighting.generateSkyboxCubemap` bakes the equirect into 6 cube faces. The
 * +Y / -Y faces collapse the equirect's polar rows into a single texel at face
 * centre (and a faint "+" of seams where the side faces meet) — visible as a small
 * dot at zenith / nadir. Sampling the equirect directly per fragment, the way
 * pano2VR does, means there is no pre-bake step and the GPU's bilinear filter
 * smooths the polar pixels naturally.
 *
 * The vertex shader is reused from PlayCanvas's existing `skyboxVS` chunk so the
 * `cubeMapRotationMatrix` uniform (driven by `app.scene.skyboxRotation`) keeps
 * working — yaw 0 still aligns with the equirect centre.
 */

const FRAGMENT_GLSL = `
varying vec3 vViewDir;
uniform sampler2D equirectTex;
// 1.0 = HDR float texture (already linear, may exceed 1.0).
// 0.0 = LDR sRGB-encoded 8bit (needs gamma decode).
uniform float uIsHdr;
const float PI = 3.141592653589793;
void main(void) {
  vec3 dir = normalize(vViewDir);
  // Match the X-flip the cubemap path applies (skybox.js: \`dir.x *= -1.0\`)
  // so handedness lines up with everything that already calibrates against
  // \`app.scene.skyboxRotation\`.
  dir.x = -dir.x;
  float lon = atan(dir.x, dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 1.0 - (lat / PI + 0.5));
  // mipmaps are explicitly disabled on the source texture (see
  // applyEquirectSkybox), so plain texture2D always samples the original
  // full-resolution image. Without that texture-side guard the equirect seam
  // (uv.x wrapping 1.0 → 0.0 between adjacent screen pixels) confuses the
  // GPU's dFdx/dFdy MIP heuristic into picking the smallest MIP and the
  // whole skybox renders blurry.
  vec3 raw = texture2D(equirectTex, uv).rgb;
  // LDR: decode sRGB → linear so the camera's HDR-float pipeline + post-pipeline
  // gamma encode produce the same brightness as the original cubemap path
  // (which used decodeGamma() in the skybox PS).
  // HDR: data is already linear radiance — skip the decode and let the camera
  // tone-mapper compress values >1.0 naturally.
  vec3 linear = mix(pow(raw, vec3(2.2)), raw, uIsHdr);
  gl_FragColor = vec4(linear, 1.0);
}
`;

interface SkyState {
  meshInstance: MeshInstance;
  mesh: Mesh;
  material: ShaderMaterial;
  layer: Layer;
  ownedTexture: Texture | null;
}

/** Per-app skybox state so we can tear down cleanly when swapping panoramas. */
const stateByApp = new WeakMap<AppBase, SkyState>();

interface LoadedTexture {
  texture: Texture;
  isHdr: boolean;
}

/**
 * Decode an image URL into a brand-new full-resolution `Texture`. We don't reuse
 * the texture loaded via `Asset` / `TextureHandler` because that path enables
 * mipmaps and may apply other defaults that we can't reliably override after
 * upload — once the GPU has the mipmapped version, sampling can pick a blurred
 * level even with `texture2DLod(.., 0.0)` due to the equirect seam confusing
 * dFdx/dFdy. Constructing the texture from scratch with explicit mipmaps=false
 * eliminates that whole class of issues.
 */
async function loadEquirectTextureFromUrl(app: AppBase, url: string): Promise<LoadedTexture> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error(`equirect image load failed: ${url}`));
    i.src = url;
  });
  const tex = new Texture(app.graphicsDevice, {
    name: 'equirect-skybox',
    width: img.naturalWidth,
    height: img.naturalHeight,
    format: PIXELFORMAT_RGBA8,
    type: TEXTURETYPE_DEFAULT,
    addressU: ADDRESS_REPEAT,
    addressV: ADDRESS_CLAMP_TO_EDGE,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    mipmaps: false,
  });
  tex.setSource(img);
  return { texture: tex, isHdr: false };
}

/**
 * Parse a Radiance .hdr (RGBE) file via three's HDRLoader and upload as an
 * RGBA16F (half-float) texture. Half-float (vs full Float32) is critical for
 * 8K panoramas: 8192×4096×4×4 = 512MB single Float32 allocation hits browser
 * OOM limits on many systems; halving it to 256MB clears that bar. RGBA16F is
 * always linear-filterable on WebGL2 (RGBA32F isn't, without
 * textureFloatFilterable). Half-float range is ~±65504 which covers any sane
 * panorama luminance — no visible precision loss for skybox display.
 */
function loadEquirectTextureFromHdrBuffer(app: AppBase, buffer: ArrayBuffer): LoadedTexture {
  const loader = new HDRLoader();
  loader.type = HalfFloatType;
  // `HDRLoader.parse()` の戻り型は `data: Uint8Array | Float32Array` だが、`type = HalfFloatType`
  // を設定したときは実体が Uint16Array (= half-float ビット表現) になる。TS 型は追随できない
  // ので unknown 経由でキャスト。
  const parsed = loader.parse(buffer) as unknown as { width: number; height: number; data: Uint16Array };
  const device = app.graphicsDevice;
  const maxSize = (device as unknown as { maxTextureSize?: number }).maxTextureSize ?? 8192;
  if (parsed.width > maxSize || parsed.height > maxSize) {
    throw new Error(`HDRI が大きすぎます (${parsed.width}×${parsed.height})。このGPUの上限は ${maxSize}px です`);
  }
  // HDRLoader stores rows top-to-bottom in source order. The Image() path
  // ends up with the same orientation once `setSource(img)` runs with
  // PlayCanvas's default flipY=false, so the existing fragment-shader V flip
  // (`1.0 - (lat / PI + 0.5)`) works unchanged for both paths.
  const tex = new Texture(device, {
    name: 'equirect-skybox-hdr',
    width: parsed.width,
    height: parsed.height,
    format: PIXELFORMAT_RGBA16F,
    type: TEXTURETYPE_DEFAULT,
    addressU: ADDRESS_REPEAT,
    addressV: ADDRESS_CLAMP_TO_EDGE,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    mipmaps: false,
    levels: [parsed.data],
  });
  return { texture: tex, isHdr: true };
}

export async function applyEquirectSkybox(app: AppBase, url: string): Promise<void> {
  const loaded = await loadEquirectTextureFromUrl(app, url);
  installEquirectSky(app, loaded);
}

/**
 * Skybox variant that takes a raw `Blob` / `File` instead of a URL so the HDR
 * (.hdr Radiance RGBE) decoder can read the original bytes directly. PNG/JPG
 * still flow through the Image() decoder via an object URL — keeps the existing
 * `applyEquirectSkybox(app, url)` path callable for per-viewpoint panoramas
 * loaded from resolved asset URLs.
 */
export async function applyEquirectSkyboxFromBlob(app: AppBase, blob: Blob, name: string): Promise<void> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'exr') {
    throw new Error('EXR は未対応です。HDR / PNG / JPG をご利用ください');
  }
  let loaded: LoadedTexture;
  if (ext === 'hdr') {
    const buf = await blob.arrayBuffer();
    loaded = loadEquirectTextureFromHdrBuffer(app, buf);
  } else {
    const url = URL.createObjectURL(blob);
    try {
      loaded = await loadEquirectTextureFromUrl(app, url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  installEquirectSky(app, loaded);
}

function installEquirectSky(app: AppBase, loaded: LoadedTexture): void {
  removeEquirectSkybox(app);
  // Hide the cubemap-based skybox if anything previously installed one.
  app.scene.skybox = null;

  const device = app.graphicsDevice;
  const skyboxVS = ShaderChunks.get(device, SHADERLANGUAGE_GLSL).get('skyboxVS') ?? '';
  // WGSL fields omitted — the project runs on WebGL2 only (see app-init.ts:58)
  // so the GLSL path is the only one that's ever compiled.
  const material = new ShaderMaterial({
    uniqueName: 'EquirectSkyMaterial',
    vertexGLSL: skyboxVS,
    fragmentGLSL: FRAGMENT_GLSL,
    attributes: { aPosition: SEMANTIC_POSITION },
  });
  material.setParameter('equirectTex', loaded.texture);
  material.setParameter('uIsHdr', loaded.isHdr ? 1 : 0);
  material.cull = CULLFACE_FRONT;
  material.depthWrite = false;
  material.update();

  // BoxGeometry takes an options object, not the device. Default unit cube
  // is fine — the skybox vertex shader strips view translation so size only
  // matters relative to nearClip / farClip (any non-zero value works).
  const mesh = Mesh.fromGeometry(device, new BoxGeometry());
  const node = new GraphNode('EquirectSkyMesh');
  const meshInstance = new MeshInstance(mesh, material, node);
  meshInstance.cull = false;
  meshInstance.pick = false;

  const layer = app.scene.layers.getLayerById(LAYERID_SKYBOX);
  if (!layer) {
    // Should never happen — the SKYBOX layer is part of the default layer
    // composition. Leave the material dangling rather than crash.
    console.warn('[equirect-skybox] SKYBOX layer not found, skybox not added');
    return;
  }
  layer.addMeshInstances([meshInstance]);

  stateByApp.set(app, { meshInstance, mesh, material, layer, ownedTexture: loaded.texture });
}

export function removeEquirectSkybox(app: AppBase): void {
  const s = stateByApp.get(app);
  if (!s) return;
  s.layer.removeMeshInstances([s.meshInstance]);
  s.meshInstance.destroy();
  s.mesh.destroy();
  s.material.destroy();
  s.ownedTexture?.destroy();
  stateByApp.delete(app);
}
