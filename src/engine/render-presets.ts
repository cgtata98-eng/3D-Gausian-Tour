import {
  Color,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_ACES,
  TONEMAP_ACES2,
  TONEMAP_FILMIC,
  TONEMAP_HEJL,
} from 'playcanvas';
import type { AppBase, Entity, CameraFrame } from 'playcanvas';
import type { RenderQualityConfig } from '../core/types';

const TONEMAP_BY_NAME: Record<NonNullable<RenderQualityConfig['toneMapping']>, number> = {
  linear: TONEMAP_LINEAR,
  neutral: TONEMAP_NEUTRAL,
  aces: TONEMAP_ACES,
  aces2: TONEMAP_ACES2,
  filmic: TONEMAP_FILMIC,
  hejl: TONEMAP_HEJL,
};

/** Display name + UI hint for a render-quality preset, addressable by id. */
export type RenderMode = 'default' | 'sharp' | 'highq';

/**
 * One-click preset bundles for the `RenderModePanel`. Selecting a preset writes the
 * matching `RenderQualityConfig` over `manifest.settings.render`, then applies it via
 * `applyRenderConfig`. Field-level fine-tuning lives on the Debug 描画品質 section.
 *
 * Trimmed to 露出 / 背景色 only. PlayCanvas (default) applies exposure through the
 * `CameraFrame` post pipeline (TONEMAP_LINEAR) that `app-init.ts` configures, so it
 * affects splat output too. Three-based engines: Spark applies it, mkkellogg only
 * affects cube / background.
 */
export const RENDER_PRESETS: Record<RenderMode, RenderQualityConfig> = {
  default: {
    exposureEV: 0,
    clearColor: [0.1, 0.1, 0.15],
  },
  sharp: {
    exposureEV: 0,
    clearColor: [0.1, 0.1, 0.15],
  },
  highq: {
    exposureEV: 0.3,
    clearColor: [0.08, 0.08, 0.10],
  },
};

/**
 * Apply a render-quality config to the live scene. Mutates camera/scene/cameraFrame
 * directly — does NOT touch the manifest. Caller decides whether to persist. The
 * Three.js SceneManager has its own `applyRenderConfig` for that rendering path.
 *
 * `cameraFrame` is optional so the function still works for callers that haven't
 * plumbed it through yet (Spark / mkkellogg paths). The grading knobs only take
 * effect when `cameraFrame` is supplied (= PlayCanvas path).
 */
export function applyRenderConfig(
  app: AppBase,
  camera: Entity | null,
  _splatEntity: Entity | null,
  cfg?: RenderQualityConfig | null,
  cameraFrame?: CameraFrame | null,
) {
  if (!cfg) return;

  type CamWithRender = { clearColor: Color };
  const cam = (camera?.camera ?? null) as CamWithRender | null;

  // bypass ON: exposure / toneMapping / grading の上書きはすべて無視。
  // gsplatOutputVS の上書きが効いていないので、シェーダ既定の gamma 経路を素通しさせる。
  // 既定 (undefined) は bypass 扱い — 色調整は明示的に `false` を入れたときだけ有効。
  const bypass = cfg.bypassColorPipeline !== false;

  if (!bypass && cfg.exposureEV !== undefined) {
    app.scene.exposure = Math.pow(2, cfg.exposureEV);
  } else if (bypass) {
    app.scene.exposure = 1;
  }
  if (cfg.clearColor !== undefined && cam) {
    cam.clearColor = new Color(cfg.clearColor[0], cfg.clearColor[1], cfg.clearColor[2]);
  }

  if (cameraFrame) {
    let dirty = false;
    if (bypass) {
      cameraFrame.rendering.toneMapping = TONEMAP_LINEAR;
      if (cameraFrame.grading.enabled) {
        cameraFrame.grading.enabled = false;
        cameraFrame.grading.saturation = 1;
        cameraFrame.grading.contrast = 1;
        cameraFrame.grading.brightness = 1;
      }
      dirty = true;
    } else {
      if (cfg.toneMapping !== undefined) {
        cameraFrame.rendering.toneMapping = TONEMAP_BY_NAME[cfg.toneMapping] ?? TONEMAP_LINEAR;
        dirty = true;
      }
      const wantsGrading = cfg.saturation !== undefined
        || cfg.contrast !== undefined
        || cfg.brightness !== undefined;
      if (wantsGrading) {
        cameraFrame.grading.enabled = true;
        if (cfg.saturation !== undefined) cameraFrame.grading.saturation = cfg.saturation;
        if (cfg.contrast !== undefined) cameraFrame.grading.contrast = cfg.contrast;
        if (cfg.brightness !== undefined) cameraFrame.grading.brightness = cfg.brightness;
        dirty = true;
      }
    }
    if (dirty) cameraFrame.update();
  }
}

/**
 * Resolve a preset's `RenderQualityConfig` for one-click application.
 * Falls back to `default` if `mode` is unrecognised (defensive — should never happen).
 */
export function getRenderPreset(mode: RenderMode): RenderQualityConfig {
  return RENDER_PRESETS[mode] ?? RENDER_PRESETS.default;
}
