import { create } from 'zustand';
import type { RenderMode } from '../engine/gsplat-loader';

export type LeftPanelId = 'map' | 'viewpoints' | 'furniture' | 'lighting' | null;
export type FurnitureMode = 'on' | 'off';
export type LightingMode = 'day' | 'night';
/** Renderer choice: 3D Gaussian Splat scene or 360° equirectangular panorama per-viewpoint */
export type ViewMode = 'splat' | '360';
/**
 * Movement model:
 * - `walk` — gravity-locked: player follows the walkable collision floor (or stays at the
 *   configured eye level if no walkable mesh is loaded). WASD on the horizontal plane.
 * - `fly`  — free-fly: WASD moves along the camera's forward direction (pitch-aware), Q/E
 *   for vertical. Block collision still applies in both modes (walls stop you).
 */
export type MovementMode = 'walk' | 'fly';
/**
 * Top-level project category:
 *  - `mansion` 住居・店舗ツアー (= 既定)
 *  - `other`   展示・屋外などの汎用空間 (= ルームツアー UI を一部省略)
 *  - `product` 単体モデル showroom (= ターンテーブル / orbit カメラ。家具など 1 点を回して見る)
 */
export type ProjectType = 'mansion' | 'other' | 'product';

/** Big sidebar sections that the user can hide / restore individually via the × on each. */
export type SidebarSection = 'type' | 'color' | 'viewpoints' | 'map' | 'tools' | 'movement' | 'tracking' | 'quality' | 'aiGenerate' | 'mobile';

/**
 * Viewer quality preset. Combines SH bands, render scale (DPR), and radial sort
 * into three levels. Initial value auto-detected by device, then user-overridable
 * via the toolbar block. Persisted to `localStorage` so the user's choice sticks.
 */
export type QualityMode = 'low' | 'mid' | 'high';
const QUALITY_STORAGE_KEY = '3droomtour:qualityMode';
function detectDefaultQuality(): QualityMode {
  if (typeof navigator === 'undefined') return 'high';
  const ua = navigator.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (isMobile) return 'low';
  // hardwareConcurrency is widely supported; deviceMemory is Chrome/Edge-only
  // so we can't rely on it. Treat 4 cores or fewer as a low-end laptop.
  const cores = navigator.hardwareConcurrency ?? 8;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (cores <= 4) return 'mid';
  if (mem !== undefined && mem < 4) return 'mid';
  return 'high';
}
function loadInitialQuality(): QualityMode {
  try {
    const v = localStorage.getItem(QUALITY_STORAGE_KEY);
    if (v === 'low' || v === 'mid' || v === 'high') return v;
  } catch { /* private mode etc. */ }
  return detectDefaultQuality();
}

interface UIState {
  isDeveloper: boolean;
  /** Active color variant id (`Plan.colorVariants[*].id`). null = use the plan's default panoramas. */
  activeColor: string | null;
  setActiveColor: (id: string | null) => void;
  /** Sidebar sections currently hidden (transient — resets on reload). */
  hiddenSections: SidebarSection[];
  toggleSection: (id: SidebarSection) => void;
  setSectionHidden: (id: SidebarSection, hidden: boolean) => void;
  /** When true, the entire left sidebar collapses to a small floating expand button. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  /** Ambient audio toggle. Default: muted (= the audio element is paused) — browser
   *  autoplay restrictions require a user gesture to start playback anyway. */
  audioMuted: boolean;
  setAudioMuted: (v: boolean) => void;
  /** Ambient audio volume 0..1. */
  audioVolume: number;
  setAudioVolume: (v: number) => void;
  showCollision: boolean;
  /** Pushes the walkable GLB triangles to the camera controller so the
   *  player snaps to the floor. Off → no gravity, current Y is held. */
  useCollisionWalkable: boolean;
  /** Pushes the block GLB triangles to the camera controller so the player
   *  collides with walls. Off → walls are ignored, player passes through. */
  useCollisionBlock: boolean;
  showFloorPlan: boolean;
  showDebugStats: boolean;
  /** Debug grid on the XZ plane (Y=0). Helps eyeball splat scale / position. */
  showGrid: boolean;
  collisionOpacity: number;
  renderMode: RenderMode;
  viewMode: ViewMode;
  movementMode: MovementMode;
  projectType: ProjectType;
  fps: number;
  activePanel: LeftPanelId;
  furniture: FurnitureMode;
  lighting: LightingMode;
  toggleDeveloper: () => void;
  toggleCollision: () => void;
  toggleUseCollisionWalkable: () => void;
  toggleUseCollisionBlock: () => void;
  toggleFloorPlan: () => void;
  toggleDebugStats: () => void;
  toggleGrid: () => void;
  setCollisionOpacity: (opacity: number) => void;
  setRenderMode: (mode: RenderMode) => void;
  setViewMode: (mode: ViewMode) => void;
  setMovementMode: (mode: MovementMode) => void;
  setProjectType: (t: ProjectType) => void;
  setFps: (fps: number) => void;
  setActivePanel: (id: LeftPanelId) => void;
  setFurniture: (m: FurnitureMode) => void;
  setLighting: (m: LightingMode) => void;
  /**
   * ヘッドトラッキング: ブラウザ内蔵 (MediaPipe FaceLandmarker) で webcam から顔向きを
   * 推定し、yaw / pitch をカメラへ overlay 反映する。360° モード時は無視される
   * (パノラマは別経路で yaw 制御済み)。トグル ON 時に webcam 許可を要求。
   * ※ 内部名 `demoMode` は元 PoC の名残りでそのまま保持 (storage / 既存コード互換)。
   */
  demoMode: boolean;
  setDemoMode: (v: boolean) => void;
  /**
   * Active quality preset. Influences SH bands, render scale, and radial sort.
   * Initial value comes from device sniffing; user-set values are persisted.
   */
  qualityMode: QualityMode;
  setQualityMode: (m: QualityMode) => void;
  /** Active AI generation entry id (= active variant). null → original / no AI variant. */
  activeAiId: string | null;
  setActiveAiId: (id: string | null) => void;
  /**
   * When true, switching plans (= タイプ切替) preserves the current camera pose
   * instead of teleporting to the new plan's first viewpoint. Use case: same
   * physical room with day/night plans — keep the user's position so they see
   * the same spot under different lighting.
   */
  linkPlanCamera: boolean;
  setLinkPlanCamera: (v: boolean) => void;
  /**
   * Viewer mirror mode for live demos:
   *  - `off`     — normal operation (default)
   *  - `send`    — broadcast camera pose to other tabs in this browser
   *  - `receive` — listen and slave to incoming broadcasts; disables local camera input
   * Synchronisation uses the BroadcastChannel API (same PC / same browser only).
   */
  mirrorMode: 'off' | 'send' | 'receive';
  setMirrorMode: (m: 'off' | 'send' | 'receive') => void;
  /** True while a generation request is in flight; lets the block disable the
   *  generate button and show a spinner. */
  aiBusy: boolean;
  setAiBusy: (v: boolean) => void;
  /** Viewer-side toggle for the 3D annotation pins (商品リンクタグ).
   *  Author opts the project into showing pins via `viewerToolbar.pins`; this
   *  flag is the runtime per-session show/hide the customer can flip. Default ON. */
  showPins: boolean;
  setShowPins: (v: boolean) => void;
  /**
   * モバイル (touch) の移動スピード m/s。manifest.settings.moveSpeed が
   * リセット既定 (3.0) を強いるのを避け、セッション中はユーザー設定値を保持する。
   * メモリのみ (リロードで初期値 5.0 に戻る) — 永続化はしない。
   */
  mobileMoveSpeed: number;
  setMobileMoveSpeed: (v: number) => void;
  /**
   * MobileJoystick がデッドゾーンを超えて入力されている間 true。FootstepAudio が
   * これを参照して足音 ON/OFF を切り替える (スマホはキーボード/ゲームパッドが
   * 無いので、joystick がそのまま「移動中」フラグになる)。
   */
  mobileJoystickActive: boolean;
  setMobileJoystickActive: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isDeveloper: new URLSearchParams(window.location.search).get('mode') === 'dev',
  activeColor: null,
  setActiveColor: (activeColor) => set({ activeColor }),
  hiddenSections: [],
  toggleSection: (id) => set((s) => ({
    hiddenSections: s.hiddenSections.includes(id)
      ? s.hiddenSections.filter((x) => x !== id)
      : [...s.hiddenSections, id],
  })),
  setSectionHidden: (id, hidden) => set((s) => ({
    hiddenSections: hidden
      ? (s.hiddenSections.includes(id) ? s.hiddenSections : [...s.hiddenSections, id])
      : s.hiddenSections.filter((x) => x !== id),
  })),
  sidebarCollapsed: false,
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  audioMuted: true,
  setAudioMuted: (audioMuted) => set({ audioMuted }),
  audioVolume: 0.5,
  setAudioVolume: (audioVolume) => set({ audioVolume: Math.max(0, Math.min(1, audioVolume)) }),
  showCollision: false,
  useCollisionWalkable: true,
  useCollisionBlock: true,
  showFloorPlan: true,
  showDebugStats: false,
  showGrid: false,
  collisionOpacity: 0.15,
  renderMode: 'default',
  viewMode: 'splat',
  movementMode: 'walk',
  projectType: 'mansion',
  fps: 0,
  activePanel: null,
  furniture: 'on',
  lighting: 'day',
  toggleDeveloper: () => set((s) => ({ isDeveloper: !s.isDeveloper })),
  toggleCollision: () => set((s) => ({ showCollision: !s.showCollision })),
  toggleUseCollisionWalkable: () => set((s) => ({ useCollisionWalkable: !s.useCollisionWalkable })),
  toggleUseCollisionBlock: () => set((s) => ({ useCollisionBlock: !s.useCollisionBlock })),
  toggleFloorPlan: () => set((s) => ({ showFloorPlan: !s.showFloorPlan })),
  toggleDebugStats: () => set((s) => ({ showDebugStats: !s.showDebugStats })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  setCollisionOpacity: (collisionOpacity) => set({ collisionOpacity }),
  setRenderMode: (renderMode) => set({ renderMode }),
  setViewMode: (viewMode) => set({ viewMode }),
  setMovementMode: (movementMode) => set({ movementMode }),
  setProjectType: (projectType) => set({ projectType }),
  setFps: (fps) => set({ fps }),
  setActivePanel: (activePanel) => set({ activePanel }),
  setFurniture: (furniture) => set({ furniture }),
  setLighting: (lighting) => set({ lighting }),
  demoMode: false,
  setDemoMode: (demoMode) => set({ demoMode }),
  qualityMode: loadInitialQuality(),
  setQualityMode: (qualityMode) => {
    try { localStorage.setItem(QUALITY_STORAGE_KEY, qualityMode); } catch { /* ignore */ }
    set({ qualityMode });
  },
  activeAiId: null,
  setActiveAiId: (activeAiId) => set({ activeAiId }),
  linkPlanCamera: false,
  setLinkPlanCamera: (linkPlanCamera) => set({ linkPlanCamera }),
  mirrorMode: 'off',
  setMirrorMode: (mirrorMode) => set({ mirrorMode }),
  aiBusy: false,
  setAiBusy: (aiBusy) => set({ aiBusy }),
  showPins: true,
  setShowPins: (showPins) => set({ showPins }),
  mobileMoveSpeed: 5,
  setMobileMoveSpeed: (mobileMoveSpeed) => set({ mobileMoveSpeed }),
  mobileJoystickActive: false,
  setMobileJoystickActive: (mobileJoystickActive) => set({ mobileJoystickActive }),
}));
