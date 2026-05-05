/** 3D position [x, y, z] */
export type Vec3 = [number, number, number];

/** 2D position [x, z] */
export type Vec2 = [number, number];

/** Minimal camera state for video keyframes (Debug → 動画タブ). */
export interface CameraPose {
  position: Vec3;
  target: Vec3;
  fov: number;
}

/** One stop in a video path. `durationSec` is the time from THIS keyframe to the
 *  next one; the last keyframe's duration is ignored. `thumbnail` is a small
 *  JPEG data URL captured at the moment the keyframe was added — purely for the
 *  "where am I again?" UX. `passThrough` (default false) means "the camera does
 *  not stop here" — easing is suppressed at this waypoint so motion stays
 *  continuous through it. Ignored on the first / last keyframes (the path
 *  always starts and ends at rest). */
export interface CameraKeyframe {
  pose: CameraPose;
  durationSec: number;
  thumbnail?: string;
  passThrough?: boolean;
}

/**
 * A named camera viewpoint. Lives on a `Plan` — different plans may have different
 * room layouts and therefore different viewpoints.
 */
export interface Viewpoint {
  id: string;
  label: string;
  /** Actual 3D camera location for jumpToViewpoint — this is what the panorama / thumbnail was captured from. */
  position: Vec3;
  target: Vec3;
  fov: number;
  /**
   * Optional override for where the dot is drawn on the floor-plan map (XZ in world units).
   * Decoupled from `position` so dragging the dot on the map doesn't relocate the camera or
   * desync from where the thumbnail/panorama was actually captured.
   * If undefined, the renderer falls back to `[position[0], position[2]]`.
   */
  mapPosition?: Vec2;
  /**
   * **Display-only** cone direction on the floor-plan map (PlayCanvas yaw, 0–360°).
   * Strictly decoupled from `target` and the live camera — the yaw slider in 図面設定
   * writes here, and both maps (debug 図面 + viewer MAP) read here for cone rendering.
   * `jumpToViewpoint` ignores this and always uses `target`, so rotating the cone never
   * rotates the actual view in the viewer ("本番"). If undefined, the cone falls back to
   * the direction derived from `target - position`.
   */
  mapYaw?: number;
  beauty?: string;
  masks?: Record<string, string>;
  /** @deprecated Migrated to `Plan.panoramas[id]` on load — kept only so legacy scene.json files still work. */
  panorama360?: string;
  /** @deprecated Migrated to `Plan.thumbnails[id]` on load — kept only so legacy scene.json files still work. */
  thumbnail?: string;
}

/** Floor plan display configuration */
export interface FloorPlanConfig {
  image: string;
  bounds: {
    min: Vec2;
    max: Vec2;
  };
  worldToImage: {
    offsetX: number;
    offsetZ: number;
    scaleX: number;
    scaleZ: number;
    rotation: number;
  };
}

/** Collision model paths */
export interface CollisionConfig {
  walkable: string;
  block: string;
}

/** Initial camera position mode */
export type InitialPositionMode = 'fixed' | 'auto';

/** Fixed initial camera position. Lives on a `Plan` (coordinates are layout-specific). */
export interface FixedPosition {
  position: Vec3;
  target: Vec3;
  fov?: number;
}

/**
 * Active 3DGS rendering engine.
 * - `mkkellogg` — three.js based GaussianSplats3D. Default. SH degree 3. Reads PLY/SPLAT/KSPLAT.
 * - `spark`     — Niantic Spark, three.js based. Reads PLY/SPZ. Use with `Plan.splatSpz` for
 *                 ~10x smaller download than the PLY counterpart.
 *
 * Legacy values like `'playcanvas'` may exist in old manifests; they fall through
 * the runtime default (mkkellogg) since the PlayCanvas engine path was removed.
 */
export type ViewerEngine = 'mkkellogg' | 'spark' | 'playcanvas';

/**
 * Per-scene 3DGS render-quality config. All fields optional — undefined means "leave
 * the engine default alone".
 *
 * The color-grading knobs (`toneMapping` / `saturation` / `contrast` / `brightness`)
 * apply through PlayCanvas's `CameraFrame` post pipeline (set up in `app-init.ts`)
 * so they only affect the PlayCanvas engine. Spark / mkkellogg pipelines fall back
 * to their built-in tonemap and ignore those knobs.
 */
export interface RenderQualityConfig {
  /** WebGL multisample antialiasing samples (0/2/4/8). PlayCanvas-only and must be
   *  set at app init since the framebuffer sample count is fixed for the lifetime
   *  of the GL context. Default 4. */
  msaaSamples?: number;
  /** Exposure in stops (-3..+3). PlayCanvas: scene.exposure → CameraFrame tonemap.
   *  Spark: applies as splat `recolor`. mkkellogg: cube + bg only. */
  exposureEV?: number;
  /** Camera clearColor as `[r, g, b]` in 0..1. Default `[0.1, 0.1, 0.15]`. */
  clearColor?: [number, number, number];
  /** Active 3DGS rendering engine. Default 'playcanvas'. */
  engine?: ViewerEngine;
  /**
   * Tone mapping curve applied at the end of the post pipeline (PlayCanvas only).
   * `linear` = passthrough, `neutral` = mild filmic with hue preservation,
   * `aces` / `aces2` = stronger filmic with shoulder, `filmic` = classic filmic,
   * `hejl` = approximated filmic. Default `'linear'`.
   */
  toneMapping?: 'linear' | 'neutral' | 'aces' | 'aces2' | 'filmic' | 'hejl';
  /** Saturation 0..2 (1 = neutral). PlayCanvas only. Enables CameraFrame.grading. */
  saturation?: number;
  /** Contrast 0.5..1.5 (1 = neutral). PlayCanvas only. */
  contrast?: number;
  /** Brightness 0..3 (1 = neutral). PlayCanvas only. Multiplies on top of exposure. */
  brightness?: number;
}

/**
 * Camera/movement defaults — kept at the scene level because they are UX preferences
 * (avatar height, walking speed) that should feel consistent across plans.
 *
 * Per-plan initial pose lives on `Plan.fixedPosition` because its coordinates are
 * tied to a specific layout.
 */
export interface SceneSettings {
  cameraHeight: number;
  /** Camera eye-level Y at scene load. Falls back to cameraHeight when omitted. */
  initialHeight?: number;
  moveSpeed: number;
  collisionCapsuleRadius: number;
  collisionCapsuleHeight: number;
  initialPositionMode: InitialPositionMode;
  // ── 360 mode bounds (ignored in 3DGS mode) ───────────────────────
  /** Smallest FOV the user can zoom INTO (most zoomed-in). Default 25°. */
  zoomFovMin?: number;
  /** Largest FOV the user can zoom OUT to. Default 100°. */
  zoomFovMax?: number;
  /** Maximum upward pitch in degrees (0–89). Lower this to stop the user looking straight up. */
  pitchMaxUp?: number;
  /** 3DGS render quality knobs (tone mapping, exposure, MSAA, splat scale, …). */
  render?: RenderQualityConfig;
  /** Play built-in footstep audio while WASD is held. Default true. */
  footstepEnabled?: boolean;
  /** Footstep audio volume in [0, 1]. Default 0.7. */
  footstepVolume?: number;
}

/** Optional splat variants for furniture/lighting swap. Keys follow `${furniture}_${lighting}` */
export interface SplatVariants {
  /** e.g. { "on_day": "splat_furn_day.ply", "off_night": "splat_empty_night.ply" } */
  [key: string]: string;
}

/**
 * Per-plan transform applied to the loaded 3DGS entity. Lets the user fix the up-axis
 * (some PLY/SPLAT exports come in upside-down or rotated) and nudge the model into
 * place without re-exporting.
 *
 * Defaults when undefined: `rotation = [180, 0, 0]` (legacy +X flip used since the very
 * first commit — kept as the default so existing scenes don't move) and
 * `position = [0, 0, 0]`.
 */
export interface SplatTransform {
  /** Euler angles in degrees (XYZ order). */
  rotation?: Vec3;
  /** World-space offset in meters (XYZ). */
  position?: Vec3;
}

/** Property metadata. Lives on a `Plan` so each plan can describe a different layout (1LDK vs 2LDK, …). */
export interface SceneInfo {
  /** e.g. "新築マンション", "中古戸建て" */
  type?: string;
  /** e.g. "1LDK", "2LDK+S" */
  roomType?: string;
  /** e.g. "42.5㎡" */
  area?: string;
  /** e.g. "3F / RC造 5階建" */
  floor?: string;
  /** e.g. "東京都千代田区…" */
  location?: string;
  /** Free-form memo shown in Viewer INFO panel */
  notes?: string;
  /**
   * Per-field visibility toggles for the 物件概要 block in the viewer sidebar.
   * Each flag defaults to **true** (visible) when undefined — set to `false` to hide.
   * `overall: false` hides the entire 物件概要 block (master switch).
   */
  visibility?: {
    overall?: boolean;
    heading?: boolean;
    area?: boolean;
    floor?: boolean;
    location?: boolean;
    notes?: boolean;
  };
}

/**
 * Material / finish color variant within a single plan. Each variant supplies its own
 * panorama set keyed by viewpoint id, so switching colors swaps every viewpoint's
 * panorama in lock-step (same camera, same layout, different flooring/wall finish).
 */
export interface ColorVariant {
  /** Stable id used to address this variant. */
  id: string;
  /** User-facing name shown next to the swatch (e.g. "ナチュラル", "ダーク"). */
  label: string;
  /** Optional CSS color for the swatch chip in the picker. */
  swatch?: string;
  /** Per-viewpoint panorama path keyed by viewpoint id. */
  panoramas: Record<string, string>;
}

/**
 * A "plan" is one design proposal for the property: its own 3DGS splat, per-viewpoint
 * 360° panoramas, viewpoints, floor plan, collision, and metadata. Switching plans
 * swaps everything visual at once so users can compare designs side-by-side.
 *
 * **All freshly-created plans are empty** (`splat`/`floorPlan`/`collision`/`info`
 * undefined, `viewpoints: []`). The user fills them in via the debug UI.
 */
export interface Plan {
  id: string;
  label: string;

  // ── Visual content ────────────────────────────────────────────────
  /** 3DGS file path (relative) or blob/data URL. Undefined → engine shows a placeholder. */
  splat?: string;
  /**
   * Optional SPZ (Niantic Spark compressed format) variant of the same scene as `splat`.
   * When present and the active engine is Spark, the runtime prefers this URL for ~10x
   * smaller download than PLY. mkkellogg cannot read SPZ so it always uses `splat`.
   * Generate via `node scripts/convert-ply-to-spz.mjs <input.ply>`.
   */
  splatSpz?: string;
  /**
   * Optional SOG (Self-Organizing Gaussians) bundle. When present and the active engine
   * is PlayCanvas, the runtime prefers this over `splat`. SOG is multi-file
   * (`meta.json` + several `*.webp` images); we store all parts as IDB blobs under a
   * shared prefix and persist a single sentinel string here in the form
   * `sog-idb:${sceneId}:${planId}` to mark the bundle as present.
   */
  splatSog?: string;
  /** Original filename of the uploaded splat (e.g. `kousei_750.sog`). Used by
   *  the Debug UI's plan card so the author can tell at a glance which source
   *  is loaded — `(SOG)` alone is ambiguous when multiple plans use SOG. */
  splatSourceName?: string;
  /**
   * Optional rotation / position override for the 3DGS entity. Mainly used to fix
   * up-axis differences between PLY exports (some come out upside-down, some Z-up vs
   * Y-up) and to nudge the model height. See `SplatTransform` for defaults.
   */
  splatTransform?: SplatTransform;
  /** Per-viewpoint 360° panorama (path or data URL), keyed by viewpoint id. */
  panoramas?: Record<string, string>;
  /** Per-viewpoint **manual** thumbnails. Auto-captures live in the runtime store. */
  thumbnails?: Record<string, string>;

  // ── Layout content ────────────────────────────────────────────────
  /** Property metadata for this plan (type, roomType, area, …). */
  info?: SceneInfo;
  /** Floor plan image + world↔image transform. */
  floorPlan?: FloorPlanConfig;
  /** Collision GLB references. The runtime SceneManager caches loaded entities per plan. */
  collision?: CollisionConfig;
  /** Camera positions for this plan. May be empty for a brand-new plan. */
  viewpoints: Viewpoint[];
  /** Initial camera pose when `settings.initialPositionMode === 'fixed'`. */
  fixedPosition?: FixedPosition;
  /**
   * Optional color / material variants for this plan. When set and the user picks one
   * via the カラー UI, that variant's `panoramas` override `Plan.panoramas`.
   */
  colorVariants?: ColorVariant[];
  /**
   * History of AI-generated panorama sets for this plan. Each entry holds the
   * user's prompt and a per-viewpoint panorama (path / blob ref / data URL).
   * Picking one in the AI 画像生成 sidebar swaps the displayed panoramas just like
   * `colorVariants` does, but without manual asset uploads.
   */
  aiHistory?: AiGenerationEntry[];

  // ── Free-form ────────────────────────────────────────────────────
  /** Free-form note shown next to the plan switcher. */
  notes?: string;
}

/**
 * One AI-generated variant. The `kind` field decides how the result is consumed:
 *  - `'screen'`   → a flat 2D image taken from the current canvas. Shown as an
 *                   overlay on top of the live view (previewable, dismissable).
 *                   `image` holds the result; `panoramas` is unused.
 *  - `'panorama'` → a 360° equirectangular image. Behaves like a `colorVariant`:
 *                   one entry per viewpoint in `panoramas`. Switches the engine
 *                   into 360° mode on activation.
 */
export interface AiGenerationEntry {
  id: string;
  /** Display name. Defaults to the prompt's first 24 chars. */
  label?: string;
  /** The text the user typed when generating. Stored verbatim for reference / re-runs. */
  prompt: string;
  /** ms since epoch when this entry was created. */
  createdAt: number;
  /** Result kind — controls how the runtime applies / displays the entry. */
  kind: 'screen' | 'panorama';
  /** Per-viewpoint panorama (kind='panorama' tied to a viewpoint). */
  panoramas?: Record<string, string>;
  /**
   * Single panorama not tied to any viewpoint — used when the user generated
   * from the **current free camera position in 3DGS** (no viewpoint context).
   * Wins over `panoramas` when both are present.
   */
  panorama?: string;
  /** Single 2D image for kind='screen'. Path / data URL / `idb:` ref. */
  image?: string;
  /** Small thumbnail (data URL or path). */
  thumbnail?: string;
}

/** Variant availability flags — whether the UI toggles are active */
export interface VariantConfig {
  furniture?: boolean;
  lighting?: boolean;
}

/**
 * Sidebar size preset.
 * - `large` — default. 320px wide, fills the full viewport height.
 * - `small` — same 320px width but **shrinks vertically to fit its content** (= タブの
 *   分だけ). Per-section visibility (`viewerToolbar.<key>`) still applies; this preset
 *   only affects the panel's geometry.
 */
export type SidebarSize = 'large' | 'small';

/**
 * Per-scene "what shows up in the viewer's left sidebar / overlays" configuration.
 *
 * **Defaults: every flag undefined = visible.** The author un-checks an item in the
 * Debug 全体タブ → ツールバー表示 to turn it off for end users. Some items are also
 * implicitly gated by other state (mansion/other project type, 3DGS/360 view mode,
 * presence of `audio`/`floorPlan`/`colorVariants` data) — those gates compose with
 * this one (both must allow the item).
 *
 * Distinct from the transient `hiddenSections` in `useUIStore` — that one is a
 * per-session "user collapsed it" state that resets on reload.
 */
export interface ViewerToolbarConfig {
  /** Plan switcher block (タイプ / 場所). */
  type?: boolean;
  /** Property overview block (間取り概要) — mansion only. */
  overview?: boolean;
  /** Viewpoints block (シーン). */
  viewpoints?: boolean;
  /** Color / material variants block (カラー) — mansion only. */
  color?: boolean;
  /** Floor-plan map block (MAP / FLOOR MAP). */
  map?: boolean;
  /** Speaker icon (BGM mute toggle) in the title bar — 3DGS only. */
  audio?: boolean;
  /** Fullscreen icon in the title bar. */
  fullscreen?: boolean;
  /** Walk / fly toggle in the lower-left of the viewer — 3DGS only. */
  movement?: boolean;
  /** Demo / head-tracking block — 3DGS only. Default OFF (制作者がツールバーで明示的に有効化)。 */
  demo?: boolean;
  /** Quality preset block (画質 LOW/MID/HIGH) — 3DGS only. Default ON. */
  quality?: boolean;
  /** AI image generation block (AI 画像生成). Lets the user generate variant
   *  panoramas via prompt; results are saved to the plan's AI history and can
   *  be browsed / downloaded like manual color variants. Default ON. */
  aiGenerate?: boolean;
  /** Sidebar size preset. Default 'large'. */
  size?: SidebarSize;
  /**
   * Display order of sidebar blocks. Items not present fall back to their default
   * position. Unknown ids are ignored. Hidden items (`movement === false` etc.) are
   * still skipped at render time.
   */
  order?: OrderableSidebarBlock[];
}

/** Sidebar blocks the user can reorder via Debug → ツールバー表示 → 並び替え. */
export type OrderableSidebarBlock =
  | 'type'
  | 'movement'
  | 'tracking'
  | 'quality'
  | 'overview'
  | 'viewpoints'
  | 'color'
  | 'aiGenerate'
  | 'map';

/** Default sidebar block order — used when `viewerToolbar.order` is unset or partial. */
export const DEFAULT_SIDEBAR_ORDER: OrderableSidebarBlock[] = [
  'type',
  'movement',
  'tracking',
  'quality',
  'overview',
  'viewpoints',
  'color',
  'aiGenerate',
  'map',
];

/**
 * Root scene manifest (scene.json).
 *
 * Only **mansion identity** (`id`, `name`) and **camera defaults** (`settings`) live at this level.
 * Everything else (visuals, layout, info, viewpoints, floor plan, collision) lives on each `Plan`.
 *
 * Legacy JSON files that have top-level `splat` / `info` / `collision` / `floorPlan` /
 * `viewpoints` / `splatVariants` are migrated into `plans[0]` at load time.
 */
export interface SceneManifest {
  id: string;
  name: string;
  settings: SceneSettings;
  /** The store guarantees this is non-empty after `setManifest` (a default plan is synthesized if absent). */
  plans?: Plan[];
  /**
   * Optional ambient audio (BGM / 環境音) for this scene. May be a `data:` URL, a
   * relative path (resolved against `/assets/scenes/{id}/`), or an `idb:<key>` ref to
   * a blob saved in IndexedDB. Loops automatically; the viewer starts muted and the
   * user toggles play via the title-bar speaker button.
   */
  audio?: string;

  // ── Legacy top-level fields (read at load, then folded into the default plan) ──
  /** @deprecated Migrated into `plans[0].splat`. */
  splat?: string;
  /** @deprecated Migrated into `plans[0].splatSpz`. */
  splatSpz?: string;
  /** @deprecated Migrated into `plans[0].splatSog`. */
  splatSog?: string;
  /** @deprecated Migrated into `plans[0].info`. */
  info?: SceneInfo;
  /** @deprecated Migrated into `plans[0].collision`. */
  collision?: CollisionConfig;
  /** @deprecated Migrated into `plans[0].floorPlan`. */
  floorPlan?: FloorPlanConfig;
  /** @deprecated Migrated into `plans[0].viewpoints`. */
  viewpoints?: Viewpoint[];
  /** Author-controlled visibility of viewer sidebar / overlay items. Default = all visible. */
  viewerToolbar?: ViewerToolbarConfig;
  /** @deprecated Furniture/lighting toggles (kept for the LeftPanel UI). */
  variants?: VariantConfig;
  /** @deprecated Map of variant key → splat path. Key format: `${furniture:on|off}_${lighting:day|night}` */
  splatVariants?: SplatVariants;
}
