import {
  AppBase,
  AppOptions,
  createGraphicsDevice,
  CameraComponentSystem,
  RenderComponentSystem,
  LightComponentSystem,
  GSplatComponentSystem,
  GSplatHandler,
  TextureHandler,
  Mouse,
  TouchDevice,
  Keyboard,
  Entity,
  Color,
  DEVICETYPE_WEBGL2,
  CameraFrame,
  PIXELFORMAT_RGBA16F,
  PIXELFORMAT_RGBA32F,
  TONEMAP_LINEAR,
  ShaderChunks,
  SHADERLANGUAGE_GLSL,
} from 'playcanvas';
import type { RenderQualityConfig } from '../core/types';
import { applyRenderConfig } from './render-presets';

export interface AppContext {
  app: AppBase;
  camera: Entity;
  /** SuperSplat-equivalent post pipeline. Owned by initApp; cleaned up on app destroy. */
  cameraFrame: CameraFrame;
}

/**
 * Boot-time render options. `msaaSamples > 0` is the only setting that has to be
 * decided here (WebGL2 cannot change framebuffer sample count at runtime). Other
 * config (tone mapping, exposure, …) is applied right after init for completeness
 * but is also re-applied later by `SceneManager.loadScene` for live tweaks.
 */
export interface AppInitOptions {
  msaaSamples?: number;
  render?: RenderQualityConfig;
}

/**
 * Initialize PlayCanvas application with GSplat support.
 * Returns the app and a camera entity.
 */
export async function initApp(canvas: HTMLCanvasElement, init?: AppInitOptions): Promise<AppContext> {
  const wantsAA = (init?.msaaSamples ?? 0) > 0;
  // SuperSplat-spec graphics device options (per
  // docs/playcanvas-supersplat-quality-migration.md). depth/stencil are off because
  // GSplat doesn't write/read them; xrCompatible off shaves init cost. We keep
  // `preserveDrawingBuffer: true` for now so `canvas.toDataURL()` based thumbnail
  // capture (`captureViewpointThumbnails`) keeps working — switching that path to
  // `frameend`-synchronised capture is a separate task.
  const device = await createGraphicsDevice(canvas, {
    deviceTypes: [DEVICETYPE_WEBGL2],
    antialias: wantsAA,
    depth: false,
    stencil: false,
    xrCompatible: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  } as Parameters<typeof createGraphicsDevice>[1] & { preserveDrawingBuffer: boolean; depth: boolean; stencil: boolean; xrCompatible: boolean });

  const app = new AppBase(canvas);
  const opts = new AppOptions();
  opts.graphicsDevice = device;

  opts.componentSystems = [
    CameraComponentSystem,
    RenderComponentSystem,
    LightComponentSystem,
    GSplatComponentSystem,
  ];

  opts.resourceHandlers = [
    GSplatHandler,
    // Required for SOG bundles — SogParser loads each webp through the texture handler.
    TextureHandler,
  ];

  // Input
  opts.mouse = new Mouse(canvas);
  opts.touch = new TouchDevice(canvas);
  opts.keyboard = new Keyboard(window);

  app.init(opts);

  // Size canvas to its DOM container (allows embedding inside flex layouts)
  app.setCanvasFillMode('NONE' as any);
  app.setCanvasResolution('AUTO' as any);

  // Scene defaults
  app.scene.ambientLight = new Color(0.3, 0.3, 0.3);

  // Create camera
  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: new Color(0.1, 0.1, 0.15),
    fov: 60,
    nearClip: 0.1,
    farClip: 1000,
  });
  camera.setPosition(0, 1.6, 5);
  camera.lookAt(0, 1.6, 0);
  app.root.addChild(camera);

  // SuperSplat-equivalent post pipeline: HDR float backbuffer + linear tonemap +
  // gamma applied at the very end of the chain. Without this PlayCanvas v2's default
  // gsplat output (`prepareOutputFromGamma`) does a gamma→linear→tone→gamma round-trip
  // through 8-bit framebuffers and noticeably yellows / softens splats. Step 1 of
  // `docs/playcanvas-supersplat-quality-migration.md`.
  //
  // `bypassColorPipeline` ON のときは CameraFrame は作るが (= HDR float バッファで
  // 8bit バンディング = 「もやもや」を回避)、`gsplatOutputVS` の passthrough 上書きは
  // **行わない** → gsplat シェーダのデフォルトのガンマ経路 (= 学習時の色味そのまま) を
  // 通す。grading / exposure は applyRenderConfig 側でスキップ。
  // 既定 (undefined) は SuperSplat 同等パイプライン ON 扱い — bypass は明示的に
  // `true` を入れたときだけ。`false`/未設定はどちらも gsplatOutputVS passthrough を当てる。
  const bypass = init?.render?.bypassColorPipeline === true;
  const cameraFrame = new CameraFrame(app, camera.camera!);
  cameraFrame.rendering.toneMapping = TONEMAP_LINEAR;
  cameraFrame.rendering.renderFormats = [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F];
  cameraFrame.update();

  if (!bypass) {
    // Step 2: replace the gsplat fragment's gamma encode with a passthrough — the
    // post pipeline above handles gamma at the end so the gsplat shader must NOT
    // re-encode. Always paired with the CameraFrame above; mismatched and colors go
    // washed out / over-saturated.
    //
    // PlayCanvas's current gsplat shader calls `prepareOutputFromGamma` with **one**
    // argument (`prepareOutputFromGamma(max(clr.xyz, 0.0))`), but earlier versions and
    // some upstream samples use the two-argument `(vec3, float)` form. Defining both
    // overloads keeps the chunk drop-in compatible across PlayCanvas v2 minors —
    // emitting only the 2-arg form crashes shader compile with "no matching overloaded
    // function found" and the splat renders nothing.
    ShaderChunks
      .get(app.graphicsDevice, SHADERLANGUAGE_GLSL)
      .set('gsplatOutputVS', `
        vec3 prepareOutputFromGamma(vec3 gammaColor) {
            return gammaColor;
        }
        vec3 prepareOutputFromGamma(vec3 gammaColor, float depth) {
            return gammaColor;
        }
      `);
  }

  // Step 3: radial-distance sort instead of view-direction dot. Suppresses the
  // brief "unsorted" artifact during fast yaw/pitch changes. Kept on in bypass
  // mode too — it's a sort-order fix, not color processing.
  app.scene.gsplat.radialSorting = true;

  // Boot-time render config (tone mapping, exposure, gamma, splat scale, etc.). MSAA
  // is already baked into the device above and isn't applied again here. The same
  // config is re-applied by SceneManager.loadScene once the splat entity exists, so
  // splat-specific knobs (`splatScale`, `highQualitySH`) take effect there.
  if (init?.render) {
    applyRenderConfig(app, camera, null, init.render, cameraFrame);
  }

  // Observe container size; resize canvas accordingly.
  // Guard against post-destroy invocations from pending observer callbacks.
  const parent = canvas.parentElement ?? canvas;
  let destroyed = false;
  const doResize = () => {
    if (destroyed || !app.graphicsDevice || !app.graphicsDevice.canvas) return;
    try {
      const rect = parent.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      app.resizeCanvas(w, h);
    } catch {
      // swallow; app likely in the middle of being torn down
    }
  };
  const ro = new ResizeObserver(doResize);
  ro.observe(parent);
  const onWinResize = () => doResize();
  window.addEventListener('resize', onWinResize);
  app.on('destroy', () => {
    destroyed = true;
    ro.disconnect();
    window.removeEventListener('resize', onWinResize);
  });
  doResize();

  app.start();

  // Make sure the post pipeline is torn down with the app — leaks the offscreen
  // float framebuffer otherwise.
  app.on('destroy', () => {
    try { cameraFrame.destroy(); } catch { /* ignore */ }
  });

  return { app, camera, cameraFrame };
}
