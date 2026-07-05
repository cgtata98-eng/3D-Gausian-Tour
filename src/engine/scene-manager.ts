import { Color, Entity, StandardMaterial, Vec3 } from 'playcanvas';
import type { AppBase, Texture, CameraFrame } from 'playcanvas';
import type { QualityMode } from '../store/ui-store';

/**
 * Quality preset table. `shBands` ∈ 0..3 (PlayCanvas SH define), `renderScale`
 * is multiplied into the drawing-buffer DPR (so 1.0 = native, 0.6 = 36% of native
 * pixels), `radialSort` toggles the per-frame depth-sort vs the cheaper view-dot
 * fallback. Tuned for "MID is invisible vs HIGH, LOW is the mobile escape valve."
 */
const QUALITY_PRESETS: Record<QualityMode, { shBands: number; renderScale: number; radialSort: boolean }> = {
  low:  { shBands: 1, renderScale: 0.6,  radialSort: false },
  mid:  { shBands: 2, renderScale: 0.85, radialSort: true  },
  high: { shBands: 3, renderScale: 1.0,  radialSort: true  },
};
import type { SceneManifest, Viewpoint, CameraPose, CameraKeyframe } from '../core/types';
import { interpolatePath, totalPathDurationSec, resolveStartViewpoint } from '../core/viewpoint';
import { downscaleCanvasToJpeg } from '../utils/video-recorder';
import { loadSceneManifest, resolveScenePath } from '../core/scene-manifest';
import { loadGSplat, loadSogFromIdb, loadSogFromUrl, applySplatTransform, isSogIdbRef } from './gsplat-loader';
import type { RenderMode } from './gsplat-loader';
import type { SplatTransform, RenderQualityConfig } from '../core/types';
import { applyRenderConfig, getRenderPreset } from './render-presets';
import { extractTrianglesFromEntity, raycastTriangles, type Triangle } from './mesh-raycaster';
import { loadCollisionGlb, setCollisionOpacity as setColOp, setCollisionVisible as setColVis } from './collision-loader';
import { applyHdri, applyHdriFromFile, crossfadeHdri, removeHdri } from './hdri-loader';
import { setStudioColor } from './studio';
import type { CollisionEntity } from './collision-loader';
import { CameraController } from './camera-controller';
import type { MovementMode } from './camera-controller';
import { OrbitCameraController } from './orbit-camera-controller';
import { useProjectStore } from '../store/project-store';

/** Either walk/fly controller (room tour) or orbit controller (showroom). The
 *  two classes are structurally compatible so SceneManager can hold either via
 *  the same field. */
type AnyCameraController = CameraController | OrbitCameraController;
import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { useUIStore } from '../store/ui-store';
import type { FurnitureMode, LightingMode, ViewMode } from '../store/ui-store';
import { isIdbRef, resolveBlobRef } from '../utils/idb';
import { panoramaToThumbnail } from '../utils/panorama-thumbnail';

/**
 * Resolve a manifest path (splat / panorama / floor plan) to a fetchable URL.
 * Priority: data: / blob: → as-is, idb: → fresh object URL from IDB blob, else relative → scene path.
 */
async function resolveAssetUrl(rawPath: string, sceneId: string): Promise<string> {
  if (isIdbRef(rawPath)) return resolveBlobRef(rawPath);
  if (rawPath.startsWith('data:') || rawPath.startsWith('blob:')) return rawPath;
  return resolveScenePath(sceneId, rawPath);
}

/** Drop collision triangles whose centroid lies outside `bounds` (margin already
 *  applied). Removes stray far-away voxel boxes that would floor-snap / jitter the
 *  player. Safety floor: if culling would remove >80% (bad/oversized AABB) keep the
 *  original set so collision is never accidentally starved. */
function cullTrianglesToBounds<T extends { a: Vec3; b: Vec3; c: Vec3 }>(
  tris: T[] | null,
  bounds: { min: Vec3; max: Vec3 } | null,
): T[] | null {
  if (!tris || !bounds) return tris;
  const { min, max } = bounds;
  const kept = tris.filter((t) => {
    const cx = (t.a.x + t.b.x + t.c.x) / 3;
    const cy = (t.a.y + t.b.y + t.c.y) / 3;
    const cz = (t.a.z + t.b.z + t.c.z) / 3;
    return cx >= min.x && cx <= max.x && cy >= min.y && cy <= max.y && cz >= min.z && cz <= max.z;
  });
  return kept.length >= Math.max(1, Math.floor(tris.length * 0.2)) ? kept : tris;
}

interface SkyboxSnapshot {
  skybox: Texture | null;
  envAtlas: Texture | null;
  intensity: number;
}

export class SceneManager {
  private app: AppBase;
  private camera: Entity;
  private cameraController: AnyCameraController | null = null;
  private splatEntity: Entity | null = null;
  private manifest: SceneManifest | null = null;
  private debugSyncHandler: ((dt: number) => void) | null = null;
  /** Debounce timer for syncing the active viewpoint's pose back to the manifest after drag. */
  private vpSyncTimer: number | null = null;
  private collisionWalkable: CollisionEntity | null = null;
  private collisionBlock: CollisionEntity | null = null;
  /** Per-channel toggles for whether the loaded collision GLBs are pushed
   *  to the camera controller. Driven from `useUIStore.useCollisionWalkable
   *  / useCollisionBlock` via {@link setCollisionWalkableEnabled} /
   *  {@link setCollisionBlockEnabled}. Default true so existing flows keep
   *  working without any UI wiring. */
  private walkableEnabled = true;
  private blockEnabled = true;
  /** Pending retry timer for the deferred AABB re-cull (see {@link scheduleBoundsRecull}). */
  private boundsRecullTimer: number | null = null;
  /** Last triangle sets pushed to the controller — reused by the pin-placement
   *  surface snap ({@link screenToScenePoint}) so it doesn't re-extract meshes. */
  private walkableTrisCache: Triangle[] | null = null;
  private blockTrisCache: Triangle[] | null = null;
  /** Serializes setActivePlan calls — rapid plan clicks would otherwise interleave
   *  teardown/load/assign across two runs (orphaned splat, wrong-plan collision). */
  private planSwitchQueue: Promise<void> = Promise.resolve();
  /** Bumped whenever the current collision set is torn down (plan switch / destroy).
   *  In-flight async collision loads capture the value at start and discard their
   *  result if it changed — a slow load from the OLD plan can then never install
   *  its floor/walls into the NEW plan. */
  private collisionGen = 0;
  /** Whether the green/red collision debug meshes are shown. Default false so the
   *  customer viewer (which never calls setCollisionVisible) keeps them hidden; the
   *  Debug "コリジョンを表示" toggle flips it. Applied to meshes as they finish loading. */
  private collisionVisible = false;
  private viewMode: ViewMode = 'splat';
  /** Snapshot of skybox state captured when entering 360 mode, restored on exit. */
  private savedSkybox: SkyboxSnapshot | null = null;
  private playerMarker: Entity | null = null;
  private markerSyncHandler: (() => void) | null = null;

  /** CameraFrame post pipeline, optional. Set up by `app-init.ts` for PlayCanvas
   *  path. Non-PlayCanvas paths leave this null and the grading config is ignored. */
  private cameraFrame: CameraFrame | null = null;

  /** Immediate-mode grid renderer registered on `update`. Non-null while visible. */
  private gridUpdateHandler: ((dt: number) => void) | null = null;

  /** Snapshot of `graphicsDevice.maxPixelRatio` at first `applyQualityMode` call.
   *  HIGH restores to this so it behaves exactly like the init-time configuration
   *  (the user observed HIGH being faster than expected when we forced
   *  `dpr * 1.0` ourselves). */
  private initialMaxPixelRatio: number | null = null;

  /** Mirror channel + cleanup handle. Used to broadcast (or slave to) camera pose
   *  across browser tabs for live demos. Reset on every `setMirrorMode` call. */
  private mirrorChannel: BroadcastChannel | null = null;
  private mirrorCleanup: (() => void) | null = null;

  /** Camera-animation state for the Debug 動画タブ. While `animHandler` is active
   *  the user input controller's update is detached so WASD/gamepad don't fight
   *  the animation. Restored when the animation finishes or `stopCameraAnimation`
   *  is called. */
  private animHandler: ((dt: number) => void) | null = null;
  private animState: {
    keyframes: CameraKeyframe[];
    totalMs: number;
    t0: number;
    /** Sub-range of the path to play. Both in [0,1]; endT > startT. Used by 動画タブ trim. */
    startT: number;
    endT: number;
    onProgress?: (t: number) => void;
    onDone?: () => void;
    suspendedControllerUpdate: ((dt: number) => void) | null;
  } | null = null;

  constructor(app: AppBase, camera: Entity, cameraFrame?: CameraFrame | null) {
    this.app = app;
    this.camera = camera;
    this.cameraFrame = cameraFrame ?? null;
  }

  /**
   * Toggle a debug XZ-plane grid (10×10 m, 1 m cells; major lines on the world axes).
   * Drawn via `app.drawLines` per frame so there's no entity / material to manage —
   * disabling unhooks the update handler and the grid disappears next frame.
   */
  setGridVisible(visible: boolean) {
    if (visible && !this.gridUpdateHandler) {
      const positions: Vec3[] = [];
      const colors: Color[] = [];
      const minor = new Color(0.45, 0.45, 0.5, 1);
      const axis = new Color(0.78, 0.78, 0.85, 1);
      const half = 10;
      for (let i = -half; i <= half; i++) {
        const c = i === 0 ? axis : minor;
        positions.push(new Vec3(i, 0, -half), new Vec3(i, 0, half));
        colors.push(c, c);
        positions.push(new Vec3(-half, 0, i), new Vec3(half, 0, i));
        colors.push(c, c);
      }
      this.gridUpdateHandler = () => {
        this.app.drawLines(positions, colors);
      };
      this.app.on('update', this.gridUpdateHandler);
    } else if (!visible && this.gridUpdateHandler) {
      this.app.off('update', this.gridUpdateHandler);
      this.gridUpdateHandler = null;
    }
  }

  async loadScene(sceneId: string) {
    const store = useSceneStore.getState();
    store.setLoading(true);
    store.setError(null);
    store.setLoadProgress(0);
    // splat ローダーから呼ばれるバイト進捗コールバック。0..1 / null をそのまま流す。
    const onProgress = (p: number | null) => useSceneStore.getState().setLoadProgress(p);

    try {
      const existing = store.manifest;
      const manifest = (existing && existing.id === sceneId) ? existing : await loadSceneManifest(sceneId);
      this.manifest = manifest;
      if (!existing || existing.id !== sceneId) {
        store.setManifest(manifest);
      }

      // The store synthesises a default plan (absorbing legacy fields) on setManifest.
      const ensured = useSceneStore.getState().manifest ?? manifest;
      this.manifest = ensured;
      const activePlanId = useSceneStore.getState().activePlanId;
      const activePlan = ensured.plans?.find((p) => p.id === activePlanId) ?? ensured.plans?.[0];

      // Splat: optional. Prefer SOG bundle when present (smaller / faster), otherwise PLY.
      if (activePlan?.splatSog && isSogIdbRef(activePlan.splatSog)) {
        // SOG stored in IDB (user uploaded via Debug UI).
        this.splatEntity = await loadSogFromIdb(
          this.app,
          sceneId,
          activePlan.id,
          `splat-${sceneId}-${activePlan.id}`,
          activePlan.splatTransform,
        );
      } else if (activePlan?.splatSog) {
        // SOG hosted as a URL (R2 / scene-relative path / data URL).
        const sogUrl = await resolveAssetUrl(activePlan.splatSog, sceneId);
        this.splatEntity = await loadSogFromUrl(
          this.app,
          sogUrl,
          `splat-${sceneId}-${activePlan.id}`,
          activePlan.splatTransform,
          onProgress,
        );
      } else if (activePlan?.splat) {
        const splatUrl = await resolveAssetUrl(activePlan.splat, sceneId);
        this.splatEntity = await loadGSplat(this.app, splatUrl, `splat-${sceneId}-${activePlan.id}`, activePlan.splatTransform, onProgress);
      }
      // Apply the user's saved quality preset now that the splat material exists.
      this.applyQualityMode(useUIStore.getState().qualityMode);

      // `product` (= 単体 showroom) はオービットカメラで回して見るモード。床コリジョンや
      // 視点 (viewpoint) は使わないため、CameraController 経路を丸ごとスキップして
      // OrbitCameraController を入れる。それ以外は従来の walk/fly カメラ。
      const project = useProjectStore.getState().getProject(sceneId);
      const isProduct = project?.type === 'product';

      // Auto-load collision GLBs (walkable / block) if the active plan declares
      // them. References can be IDB blobs (Debug-side authoring) or relative
      // paths resolved against R2 (customer viewer). 製品 showroom では使用しない。
      if (!isProduct && activePlan?.collision?.walkable) {
        void this.loadCollisionFromManifestRef(activePlan.collision.walkable, 'walkable');
      }
      if (!isProduct && activePlan?.collision?.block) {
        void this.loadCollisionFromManifestRef(activePlan.collision.block, 'block');
      }

      if (isProduct) {
        this.cameraController = new OrbitCameraController(this.app, this.camera, {
          fov: manifest.settings.zoomFovMax ?? 45,
          zoomFovMin: manifest.settings.zoomFovMin ?? 20,
          zoomFovMax: manifest.settings.zoomFovMax ?? 90,
        });
      } else {
        this.cameraController = new CameraController(this.app, this.camera, {
          moveSpeed: manifest.settings.moveSpeed,
          cameraHeight: manifest.settings.initialHeight ?? manifest.settings.cameraHeight,
          zoomFovMin: manifest.settings.zoomFovMin ?? 25,
          zoomFovMax: manifest.settings.zoomFovMax ?? 100,
        });
      }
      if (typeof manifest.settings.pitchMaxUp === 'number') {
        this.cameraController.setPitchMaxUp(manifest.settings.pitchMaxUp);
      }
      // Auto-sync on drag was removed — casual exploration would silently rewrite the
      // viewpoint's saved direction. The user now commits an orientation explicitly via the
      // 📷 button (`captureCurrentFrameAsManualThumbnail`) or the yaw slider in 図面設定.

      if (!isProduct) {
        this.createPlayerMarker();

        // Capture a thumbnail at each viewpoint's start position while still on the loading screen.
        if (activePlan && activePlan.splat) {
          const thumbs = await this.captureViewpointThumbnails();
          if (activePlan.id) store.setViewpointThumbnails(activePlan.id, thumbs);
        }

        // Initial pose = the plan's designated start viewpoint (Plan.startViewpointId),
        // falling back to the first viewpoint for un-designated / legacy plans. Legacy
        // `fixedPosition` / `initialPositionMode` are not used for placement.
        const startVp = resolveStartViewpoint(activePlan);
        if (startVp) {
          this.jumpToViewpoint(startVp);
        }
      } else if (this.splatEntity && this.cameraController instanceof OrbitCameraController) {
        // showroom: orbit カメラを splat に合わせる。PlayCanvas v2 の gsplat instance では
        // AABB を `.instance.aabb` で読めるが、ビルドによってフィールド名がブレるので
        // 複数経路を試す。AABB が取れなければ splat entity のワールド位置をターゲットに
        // フォールバック (= 少なくとも entity の方向は向く)。
        const splatEnt = this.splatEntity;
        const gs = splatEnt.gsplat as unknown as {
          instance?: { aabb?: { center: Vec3; halfExtents: Vec3 } | null; customAabb?: { center: Vec3; halfExtents: Vec3 } | null };
          aabb?: { center: Vec3; halfExtents: Vec3 } | null;
          customAabb?: { center: Vec3; halfExtents: Vec3 } | null;
        } | null;
        const aabb = gs?.instance?.aabb ?? gs?.instance?.customAabb ?? gs?.aabb ?? gs?.customAabb ?? null;
        if (aabb && aabb.center && aabb.halfExtents) {
          // AABB はローカル空間想定 — splatTransform が当たった entity でワールド変換する。
          const worldCenter = splatEnt.getWorldTransform().transformPoint(aabb.center.clone());
          this.cameraController.setTarget(worldCenter.x, worldCenter.y, worldCenter.z);
          const radius = Math.max(aabb.halfExtents.x, aabb.halfExtents.y, aabb.halfExtents.z);
          this.cameraController.frameRadius(Math.max(0.5, radius * 1.6));
          console.info('[showroom] orbit target =', worldCenter, ' radius =', radius);
        } else {
          // フォールバック: entity の現在ワールド座標を target に。距離は既定 2.5m。
          const p = splatEnt.getPosition();
          this.cameraController.setTarget(p.x, p.y, p.z);
          console.warn('[showroom] gsplat AABB not available, using entity position', p);
        }
      }

      // Sync camera to store + sample FPS. PlayCanvas passes `dt` (seconds since last
      // frame) to `update` callbacks; we accumulate ~200ms of samples then push a
      // smoothed value to the UI store. Camera sync runs every 6 frames to keep
      // React re-renders cheap.
      let frameCount = 0;
      let fpsAccumDt = 0;
      let fpsAccumFrames = 0;
      let fpsLastSetMs = performance.now();
      this.debugSyncHandler = (dt: number) => {
        fpsAccumDt += dt;
        fpsAccumFrames++;
        const now = performance.now();
        if (now - fpsLastSetMs >= 200 && fpsAccumDt > 0) {
          useUIStore.getState().setFps(Math.round(fpsAccumFrames / fpsAccumDt));
          fpsAccumDt = 0;
          fpsAccumFrames = 0;
          fpsLastSetMs = now;
        }
        frameCount++;
        if (frameCount % 6 !== 0) return;
        if (!this.cameraController) return;
        const p = this.camera.getPosition();
        const camStore = useCameraStore.getState();
        camStore.setPosition([p.x, p.y, p.z]);
        camStore.setPitch(this.cameraController.getPitch());
        camStore.setYaw(this.cameraController.getYaw());
        camStore.setFov(this.cameraController.getFov());
      };
      this.app.on('update', this.debugSyncHandler);

      // Keep the 3rd-person marker glued to the player every frame.
      this.markerSyncHandler = () => {
        const marker = this.playerMarker;
        if (!marker || !marker.enabled || !this.cameraController) return;
        const p = this.cameraController.getPlayerPosition();
        marker.setPosition(p.x, p.y, p.z);
      };
      this.app.on('update', this.markerSyncHandler);

      // Apply per-scene render-quality settings (tone mapping, exposure, splat scale, …).
      // The boot-time `initApp` already applied the non-splat parts when the canvas
      // came up; running it again here is what wires `splatScale` / `highQualitySH` to
      // the freshly-loaded splat entity.
      this.applyRenderConfig(ensured.settings.render);

      store.setLoaded(true);
      store.setLoading(false);
      store.setLoadProgress(null);
    } catch (err) {
      store.setError(err instanceof Error ? err.message : String(err));
      store.setLoading(false);
      store.setLoadProgress(null);
    }
  }

  jumpToViewpoint(viewpoint: Viewpoint) {
    if (!this.cameraController) return;
    // Camera always lands at the 📷-captured `position` + `target` so the load-time view matches
    // the saved thumbnail exactly. Floor-plan cones are derived from the same `target - position`
    // (or live yaw when active), never from a separate override.
    this.cameraController.jumpTo(viewpoint.position, viewpoint.target, viewpoint.fov);
    // Push pose into the camera-store synchronously so the floor-plan live cone snaps to the
    // right direction immediately — without this it lags ~100ms behind (next throttled sync).
    const camStore = useCameraStore.getState();
    camStore.setActiveViewpoint(viewpoint.id);
    camStore.setPosition([viewpoint.position[0], viewpoint.position[1], viewpoint.position[2]]);
    camStore.setYaw(this.cameraController.getYaw());
    camStore.setPitch(this.cameraController.getPitch());
    camStore.setFov(this.cameraController.getFov());
    if (this.viewMode === '360') {
      void this.applyActiveViewpointPanorama();
    }
  }

  /** Snapshot the current camera (position / target / fov) as a `CameraPose`. Used
   *  by the Debug 動画タブ "現在のカメラを保存" button. Returns null if the
   *  controller hasn't been initialised yet. */
  getCurrentPose(): CameraPose | null {
    if (!this.cameraController) return null;
    const cam = this.camera;
    const fwd = cam.forward;
    const pos = cam.getPosition();
    const fov = (cam.camera as { fov?: number } | null)?.fov ?? this.cameraController.getFov();
    return {
      position: [pos.x, pos.y, pos.z],
      target: [pos.x + fwd.x, pos.y + fwd.y, pos.z + fwd.z],
      fov,
    };
  }

  /** Apply a saved `CameraPose` immediately. Equivalent to `jumpToViewpoint` but
   *  takes a bare pose instead of a full `Viewpoint`. */
  jumpToPose(pose: CameraPose): void {
    if (!this.cameraController) return;
    this.cameraController.jumpTo(pose.position, pose.target, pose.fov);
  }

  /**
   * Project a 3D world point to 2D canvas pixel coordinates. Returns null when
   * the point is behind the camera (or when the camera component isn't ready).
   * Used by the scene-pins overlay to position HTML markers each frame.
   *
   * Behind-camera detection uses dot(world - camPos, forward). PlayCanvas's
   * `Camera.worldToScreen` does perspective divide internally and the resulting
   * `screenCoord.z` is the pre-divide clip z (not a reliable "behind" flag) —
   * relying on it produced inconsistent visibility, so we check explicitly.
   */
  worldToScreen(world: [number, number, number]): { x: number; y: number } | null {
    const cam = this.camera.camera;
    if (!cam) return null;
    const camPos = this.camera.getPosition();
    const fwd = this.camera.forward;
    const dx = world[0] - camPos.x;
    const dy = world[1] - camPos.y;
    const dz = world[2] - camPos.z;
    if (dx * fwd.x + dy * fwd.y + dz * fwd.z <= 0) return null;
    const out = new Vec3();
    cam.worldToScreen(new Vec3(world[0], world[1], world[2]), out);
    return { x: out.x, y: out.y };
  }

  /**
   * Synthesize a world-space position in front of the current camera.
   * Used by the "+ ピンを追加" button to drop a pin at a sensible default
   * location (~2 m ahead) the user can then drag in the 3D scene.
   */
  getCameraForwardPoint(distance = 2): [number, number, number] {
    const pos = this.camera.getPosition();
    const fwd = this.camera.forward;
    return [
      +(pos.x + fwd.x * distance).toFixed(3),
      +(pos.y + fwd.y * distance).toFixed(3),
      +(pos.z + fwd.z * distance).toFixed(3),
    ];
  }

  /**
   * Click-to-place helper for scene pins. Casts a ray from the camera through
   * the given canvas-pixel coordinate and returns the world-space intersection
   * with the floor plane (Y = 0). Falls back to "camera forward 2 m" when the
   * ray points up / parallel to the floor and would never intersect.
   *
   * No splat-surface raycasting — Gaussian Splat is not a triangle mesh, so
   * intersecting against the floor plane gives a deterministic, predictable
   * spot the author can refine via the X/Y/Z sliders afterwards.
   */
  screenToFloorPoint(canvasX: number, canvasY: number): [number, number, number] | null {
    const cam = this.camera.camera;
    if (!cam) return null;
    // PlayCanvas's `screenToWorld(x, y, z)` reads canvas-pixel x/y plus a
    // distance from the camera. We need TWO points — one at the near plane
    // and one further out — to define the ray direction without assuming
    // anything about FOV / aspect / etc.
    const near = new Vec3();
    const far = new Vec3();
    cam.screenToWorld(canvasX, canvasY, cam.nearClip, near);
    cam.screenToWorld(canvasX, canvasY, cam.nearClip + 1, far);
    const dir = new Vec3().sub2(far, near).normalize();
    if (Math.abs(dir.y) < 1e-4) {
      // Ray parallel to the floor — never hits Y=0. Fall back gracefully.
      return this.getCameraForwardPoint(2);
    }
    const camPos = this.camera.getPosition();
    // (camPos + t·dir).y = 0 → t = -camPos.y / dir.y
    const t = -camPos.y / dir.y;
    if (t <= 0) {
      // Floor plane is behind the camera (looking up). Use forward fallback.
      return this.getCameraForwardPoint(2);
    }
    return [
      +(camPos.x + dir.x * t).toFixed(3),
      0,
      +(camPos.z + dir.z * t).toFixed(3),
    ];
  }

  /**
   * Click/drag-to-place helper with SURFACE SNAP (B1): casts the pixel ray
   * against the loaded collision meshes (walls + floor volume — the splat has
   * no triangles, so collision is its raycastable proxy) and returns the
   * NEAREST hit, resolving the tag's depth automatically instead of always
   * landing on Y=0. Falls back to {@link screenToFloorPoint} when no collision
   * is loaded or the ray misses everything.
   */
  screenToScenePoint(canvasX: number, canvasY: number): [number, number, number] | null {
    const cam = this.camera.camera;
    if (!cam) return null;
    const near = new Vec3();
    const far = new Vec3();
    cam.screenToWorld(canvasX, canvasY, cam.nearClip, near);
    cam.screenToWorld(canvasX, canvasY, cam.nearClip + 1, far);
    const dir = new Vec3().sub2(far, near).normalize();
    const camPos = this.camera.getPosition();
    let bestT = Infinity;
    let best: [number, number, number] | null = null;
    for (const tris of [this.blockTrisCache, this.walkableTrisCache]) {
      if (!tris) continue;
      const hit = raycastTriangles(camPos.x, camPos.y, camPos.z, dir.x, dir.y, dir.z, tris, 60);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        best = [+hit.point.x.toFixed(3), +hit.point.y.toFixed(3), +hit.point.z.toFixed(3)];
      }
    }
    return best ?? this.screenToFloorPoint(canvasX, canvasY);
  }

  /** The host canvas. Used by the 動画タブ to attach a `MediaRecorder` via
   *  `canvas.captureStream()`. Returns null if PlayCanvas hasn't initialised. */
  getCanvas(): HTMLCanvasElement | null {
    return (this.app.graphicsDevice?.canvas as HTMLCanvasElement | undefined) ?? null;
  }

  /** Capture the next rendered frame as a small JPEG data URL. Used by the 動画タブ
   *  to attach a thumbnail to each saved keyframe so the user can recognise the
   *  spot at a glance instead of reading raw coordinates. Resolves null if the
   *  canvas isn't ready. */
  captureThumbnail(maxSize = 240): Promise<string | null> {
    const canvas = this.getCanvas();
    if (!canvas) return Promise.resolve(null);
    return new Promise((resolve) => {
      // PlayCanvas clears the drawing buffer after present, so we must read
      // immediately after the current frame's render finishes.
      const onPostrender = () => {
        try {
          this.app.off('postrender', onPostrender);
          resolve(downscaleCanvasToJpeg(canvas, maxSize));
        } catch {
          resolve(null);
        }
      };
      this.app.on('postrender', onPostrender);
    });
  }

  /** Animate the camera through a sequence of `keyframes`. Each keyframe carries
   *  its own `durationSec` to the next one (last one ignored). `startT` / `endT`
   *  optionally restrict playback to a sub-range of the path (both in [0,1]);
   *  defaults are 0 and 1 (full path). Detaches the user input controller for
   *  the duration so WASD/gamepad don't fight the animation. */
  playCameraAnimation(
    keyframes: CameraKeyframe[],
    cb?: { onProgress?: (t: number) => void; onDone?: () => void; startT?: number; endT?: number },
  ): void {
    this.stopCameraAnimation();
    if (!this.cameraController || keyframes.length < 2) return;
    const cc = this.cameraController as unknown as { updateHandler?: ((dt: number) => void) | null };
    const ccUpdate = cc.updateHandler ?? null;
    if (ccUpdate) this.app.off('update', ccUpdate);
    const startT = Math.max(0, Math.min(1, cb?.startT ?? 0));
    const endT = Math.max(startT + 0.0001, Math.min(1, cb?.endT ?? 1));
    const fullMs = totalPathDurationSec(keyframes) * 1000;
    const totalMs = Math.max(1, fullMs * (endT - startT));
    this.animState = {
      keyframes,
      totalMs,
      startT,
      endT,
      t0: performance.now(),
      onProgress: cb?.onProgress,
      onDone: cb?.onDone,
      suspendedControllerUpdate: ccUpdate,
    };
    // jump to the start frame so the first rendered frame after recorder.start()
    // is exactly the trim-start pose.
    const startPose = interpolatePath(keyframes, startT) ?? keyframes[0].pose;
    this.cameraController.jumpTo(startPose.position, startPose.target, startPose.fov);
    this.animHandler = () => this.tickCameraAnimation();
    this.app.on('update', this.animHandler);
  }

  /** Cancel any in-flight camera animation. Re-attaches the controller's update so
   *  user input works again. Safe to call when no animation is running. */
  stopCameraAnimation(): void {
    if (this.animHandler) {
      this.app.off('update', this.animHandler);
      this.animHandler = null;
    }
    const s = this.animState;
    this.animState = null;
    if (s?.suspendedControllerUpdate) this.app.on('update', s.suspendedControllerUpdate);
  }

  private tickCameraAnimation(): void {
    const s = this.animState;
    if (!s || !this.cameraController) return;
    const elapsed = performance.now() - s.t0;
    const tLocal = Math.min(1, elapsed / s.totalMs);
    const tGlobal = s.startT + (s.endT - s.startT) * tLocal;
    const pose = interpolatePath(s.keyframes, tGlobal);
    if (pose) this.cameraController.jumpTo(pose.position, pose.target, pose.fov);
    s.onProgress?.(tLocal);
    if (tLocal >= 1) {
      const done = s.onDone;
      this.stopCameraAnimation();
      done?.();
    }
  }

  /**
   * Switch between 3DGS splat rendering and 360° equirectangular panorama mode.
   * In '360' mode the splat is hidden, the active viewpoint's panorama becomes the skybox,
   * and camera translation is locked (mouse-look only).
   */
  async setViewMode(mode: ViewMode): Promise<void> {
    if (this.viewMode === mode) return;
    this.viewMode = mode;

    if (mode === '360') {
      this.savedSkybox = {
        skybox: this.app.scene.skybox,
        envAtlas: this.app.scene.envAtlas,
        intensity: this.app.scene.skyboxIntensity,
      };
      if (this.splatEntity) this.splatEntity.enabled = false;
      this.cameraController?.setMovementLocked(true);
      await this.applyActiveViewpointPanorama();
    } else {
      if (this.splatEntity) this.splatEntity.enabled = true;
      this.cameraController?.setMovementLocked(false);
      // Always tear down the custom equirect mesh; restoring the saved cubemap
      // skybox state alone leaves our mesh sitting in the SKYBOX layer and the
      // panorama leaks through behind the splat.
      removeHdri(this.app);
      if (this.savedSkybox) {
        this.app.scene.skybox = this.savedSkybox.skybox;
        this.app.scene.envAtlas = this.savedSkybox.envAtlas;
        this.app.scene.skyboxIntensity = this.savedSkybox.intensity;
        this.savedSkybox = null;
      }
    }
  }

  /**
   * Attach (or replace) a 360° panorama image on the **active plan** for a viewpoint.
   * Also auto-generates a thumbnail by cropping the panorama's front-facing region so
   * the viewpoint immediately has a meaningful preview without the user having to press
   * 📷. Live camera state is never touched.
   */
  async setViewpointPanorama(viewpointId: string, dataUrl: string): Promise<void> {
    const store = useSceneStore.getState();
    const activePlanId = store.activePlanId;
    if (!activePlanId) return;
    store.setPlanPanorama(activePlanId, viewpointId, dataUrl);
    this.manifest = useSceneStore.getState().manifest;
    if (this.viewMode === '360' && useCameraStore.getState().activeViewpoint === viewpointId) {
      await this.applyActiveViewpointPanorama();
    }
    // Auto-generate the manual thumbnail from the panorama so the list / cards have a
    // consistent preview anchored to the panorama (not to whatever yaw the live camera
    // happened to be at). User can re-trigger via 📷 if they want to refresh.
    try {
      const thumb = await panoramaToThumbnail(dataUrl, { width: 320, height: 200, fovDeg: 80 });
      useSceneStore.getState().setViewpointManualThumbnail(activePlanId, viewpointId, thumb);
    } catch (err) {
      console.warn(`auto-thumbnail from panorama failed for ${viewpointId}:`, err);
    }
  }

  /**
   * Switch the active plan: swap splat (or clear if undefined), jump to the new plan's first
   * viewpoint, and re-apply panorama in 360 mode.
   *
   * Camera pose is **not** preserved across plans — coordinates from one layout do not translate
   * to another, so we always restart at the new plan's first viewpoint (or fixed pose).
   */
  async setActivePlan(planId: string): Promise<void> {
    // Serialize: callers fire-and-forget (`void setActivePlan(id)`), so rapid plan
    // clicks would otherwise interleave two runs' teardown/load/assign steps.
    const run = this.planSwitchQueue.then(() => this.doSetActivePlan(planId));
    // Keep the chain alive even if a run rejects (error already logged inside).
    this.planSwitchQueue = run.catch(() => { /* swallowed for the queue only */ });
    return run;
  }

  private async doSetActivePlan(planId: string): Promise<void> {
    // Refresh from store — the UI may have added/renamed plans since loadScene cached `this.manifest`.
    this.manifest = useSceneStore.getState().manifest;
    const m = this.manifest;
    if (!m) return;
    const plan = m.plans?.find((p) => p.id === planId);
    if (!plan) return;

    // setActivePlanId resets activeViewpoint internally; do this first so any subsequent
    // panorama / capture lookups see the new active vp.
    useSceneStore.getState().setActivePlanId(planId);
    this.manifest = useSceneStore.getState().manifest;

    // Tear down the old splat unconditionally.
    if (this.splatEntity) {
      this.splatEntity.destroy();
      this.splatEntity = null;
    }

    // Tear down the old plan's collision and immediately clear the controller's
    // triangles, so walk-mode can never floor-snap / wall-block against the
    // PREVIOUS plan's geometry while (or after) the new plan loads. Bumping the
    // generation also invalidates any still-in-flight collision load.
    this.collisionGen++;
    this.collisionWalkable?.entity.destroy();
    this.collisionWalkable = null;
    this.collisionBlock?.entity.destroy();
    this.collisionBlock = null;
    this.syncCollisionTrianglesToController();

    // Load the new splat — only if the plan defines one. Otherwise leave the canvas blank.
    // Mirror loadScene's preference: SOG bundle first, fall back to PLY.
    // Wrap with `setLoading` so the LoadingScreen overlay covers plan-switch / reupload time
    // (it can take several seconds for big PLYs / SOGs).
    const hasSplat = !!plan.splatSog || !!plan.splat;
    if (hasSplat) {
      useSceneStore.getState().setLoading(true);
      useSceneStore.getState().setLoadProgress(0);
    }
    const onProgress = (p: number | null) => useSceneStore.getState().setLoadProgress(p);
    try {
      if (plan.splatSog && isSogIdbRef(plan.splatSog)) {
        this.splatEntity = await loadSogFromIdb(this.app, m.id, planId, `splat-${m.id}-${planId}`, plan.splatTransform);
        if (this.viewMode === '360') this.splatEntity.enabled = false;
      } else if (plan.splatSog) {
        const sogUrl = await resolveAssetUrl(plan.splatSog, m.id);
        this.splatEntity = await loadSogFromUrl(this.app, sogUrl, `splat-${m.id}-${planId}`, plan.splatTransform, onProgress);
        if (this.viewMode === '360') this.splatEntity.enabled = false;
      } else if (plan.splat) {
        const newUrl = await resolveAssetUrl(plan.splat, m.id);
        this.splatEntity = await loadGSplat(this.app, newUrl, `splat-${m.id}-${planId}`, plan.splatTransform, onProgress);
        if (this.viewMode === '360') this.splatEntity.enabled = false;
      }
    } catch (err) {
      console.error(`plan splat load failed (${planId}):`, err);
    } finally {
      if (hasSplat) {
        useSceneStore.getState().setLoading(false);
        useSceneStore.getState().setLoadProgress(null);
      }
    }
    // Re-apply quality preset (SH bands / radial sort / DPR) to the freshly-loaded splat.
    this.applyQualityMode(useUIStore.getState().qualityMode);

    // Load the NEW plan's collision (if declared) — after the splat load so the
    // AABB cull in syncCollisionTrianglesToController (triggered inside the
    // loader) runs against the new splat's bounds, not the old plan's. Mirrors
    // the loadScene auto-load path; product showrooms don't use collision.
    const isProduct = useProjectStore.getState().getProject(m.id)?.type === 'product';
    if (!isProduct && plan.collision?.walkable) {
      void this.loadCollisionFromManifestRef(plan.collision.walkable, 'walkable');
    }
    if (!isProduct && plan.collision?.block) {
      void this.loadCollisionFromManifestRef(plan.collision.block, 'block');
    }

    // Jump to the new plan's first viewpoint — UNLESS the user has the
    // "リンク" toggle on (`linkPlanCamera`), in which case we keep the current
    // camera pose. Use case: same room with separate day/night plans, the user
    // wants to compare lighting at the exact same spot.
    if (this.cameraController && !useUIStore.getState().linkPlanCamera) {
      const startVp = resolveStartViewpoint(plan);
      if (startVp) this.jumpToViewpoint(startVp);
    }

    if (this.viewMode === '360') {
      await this.applyActiveViewpointPanorama();
    }
  }

  /**
   * Resolve the panorama path for the active viewpoint from the active plan.
   * Priority (highest first):
   *   1. Active color variant (`useUIStore.activeColor`)
   *   2. The plan's default `panoramas[viewpointId]`
   * AI variants are screen-overlay only (handled by `AiScreenOverlay` in React),
   * so they don't participate in panorama path resolution.
   */
  private resolveActivePanoramaPath(): string | null {
    if (!this.manifest) return null;
    const activeId = useCameraStore.getState().activeViewpoint;
    if (!activeId) return null;
    const planId = useSceneStore.getState().activePlanId;
    const plan = this.manifest.plans?.find((p) => p.id === planId);
    const colorId = useUIStore.getState().activeColor;
    if (colorId) {
      const variant = plan?.colorVariants?.find((v) => v.id === colorId);
      const variantPath = variant?.panoramas?.[activeId];
      if (variantPath) return variantPath;
    }
    return plan?.panoramas?.[activeId] ?? null;
  }

  /**
   * Re-apply the panorama in 360° mode after the active color variant changed.
   * Splat mode: nothing visual changes (the splat itself is shared).
   */
  async applyActiveColor(): Promise<void> {
    if (this.viewMode === '360') {
      await this.applyActiveViewpointPanorama();
    }
  }

  /**
   * Show an arbitrary 360° panorama in the main view (walkthrough-node preview /
   * node transitions). Bypasses the viewpoint-panorama resolution entirely — the
   * walk layer is independent of curated viewpoints. 360 mode only (in splat
   * mode the skybox sits behind the splat and wouldn't be visible).
   * Camera yaw/pitch are untouched — facing carries across node hops.
   *
   * `animated: true` = the C4 "walking" transition: a short crossfade between
   * the two equirects plus a subtle FOV dolly-in that sells forward motion.
   * `false` / omitted = instant swap (the legacy behavior, and the editor
   * preview default).
   */
  async showPanoramaPreview(src: string, opts?: { animated?: boolean }): Promise<boolean> {
    if (!this.manifest || this.viewMode !== '360') return false;
    try {
      const url = await resolveAssetUrl(src, this.manifest.id);
      if (opts?.animated) {
        const fade = crossfadeHdri(this.app, url, 320);
        this.playWalkDolly(320);
        await fade;
      } else {
        await applyHdri(this.app, url);
      }
      return true;
    } catch (err) {
      console.error('panorama preview failed:', err);
      return false;
    }
  }

  /**
   * Forward-step FOV dolly (C4/B4): pinch the FOV in slightly and release over
   * `durationMs`, synced with the panorama crossfade. Pure render-side motion —
   * yaw/pitch/mapYaw/saved FOV settings are untouched, and the base FOV is
   * restored exactly when the tween ends (or when a new dolly supersedes it).
   */
  private walkDollyRaf: number | null = null;
  private playWalkDolly(durationMs: number) {
    const cc = this.cameraController;
    if (!cc) return;
    // Cancel a previous dolly and restore its base FOV first, so spammed steps
    // never compound the pinch.
    if (this.walkDollyRaf !== null) {
      cancelAnimationFrame(this.walkDollyRaf);
      this.walkDollyRaf = null;
      if (this.walkDollyBaseFov !== null) cc.setFov(this.walkDollyBaseFov);
    }
    const baseFov = cc.getFov();
    this.walkDollyBaseFov = baseFov;
    const pinch = baseFov * 0.10; // 10% in-and-out — noticeable, not nauseating
    const t0 = performance.now();
    const tick = () => {
      this.walkDollyRaf = null;
      const c = this.cameraController;
      if (!c) return;
      const t = Math.min(1, (performance.now() - t0) / durationMs);
      // sin(π·t): 0 → max pinch at the midpoint → back to 0.
      c.setFov(baseFov - pinch * Math.sin(Math.PI * t));
      if (t >= 1) {
        c.setFov(baseFov);
        this.walkDollyBaseFov = null;
        return;
      }
      this.walkDollyRaf = requestAnimationFrame(tick);
    };
    this.walkDollyRaf = requestAnimationFrame(tick);
  }
  private walkDollyBaseFov: number | null = null;

  private async applyActiveViewpointPanorama(): Promise<void> {
    if (!this.manifest) return;
    const path = this.resolveActivePanoramaPath();
    if (!path) {
      removeHdri(this.app);
      return;
    }
    try {
      const url = await resolveAssetUrl(path, this.manifest.id);
      await applyHdri(this.app, url);
    } catch (err) {
      console.error(`panorama load failed:`, err);
    }
  }

  /**
   * One-click render preset (= the RenderModePanel buttons). Resolves the preset's
   * `RenderQualityConfig` and applies it live. Caller is responsible for persisting
   * the preset's payload to `manifest.settings.render` if desired.
   */
  setRenderMode(mode: RenderMode) {
    this.applyRenderConfig(getRenderPreset(mode));
  }

  /**
   * Apply a render-quality config (tone mapping, exposure, gamma, splat scale, …) to
   * the live scene. Pass `null` / `undefined` to no-op. MSAA is intentionally NOT
   * handled here — it's framebuffer-level and requires a page reload (see
   * `app-init.ts → AppInitOptions.msaaSamples`).
   */
  applyRenderConfig(cfg: RenderQualityConfig | null | undefined) {
    applyRenderConfig(this.app, this.camera, this.splatEntity, cfg ?? undefined, this.cameraFrame);
  }

  /**
   * Apply a quality preset (LOW / MID / HIGH) to the live scene. Adjusts:
   *  - SH bands on the splat material (fragment ALU cost)
   *  - Render scale via `device.maxPixelRatio` (drawing-buffer pixel count → fragment fill rate)
   *  - Radial sorting (per-frame sort cost)
   *
   * Idempotent. Safe to call before the splat is loaded — SH bands then take effect
   * once `loadScene` / `setActivePlan` finishes (we re-apply at the end of those flows).
   */
  applyQualityMode(mode: QualityMode) {
    const preset = QUALITY_PRESETS[mode];

    // SH bands — splat material define
    if (this.splatEntity) {
      const mat = (this.splatEntity.gsplat as unknown as { instance?: { material?: {
        setDefine: (k: string, v: string) => void;
        update: () => void;
      } } }).instance?.material;
      if (mat) {
        mat.setDefine('SH_BANDS', String(preset.shBands));
        mat.update();
      }
    }

    // Render scale — multiply the *init-time* maxPixelRatio by the preset's scale
    // factor. Critical: derive from `initialMaxPixelRatio` (PlayCanvas v2 default
    // is `min(1, devicePixelRatio)`, capped at 1.0), NOT raw `window.devicePixelRatio`
    // — on Retina the latter would push LOW/MID *above* HIGH (1.2 / 1.7 vs 1.0).
    // Skip the resize entirely if the value didn't change so identical re-applies
    // (e.g. on splat reload) don't trigger spurious GPU reallocations.
    const dev = this.app.graphicsDevice as unknown as { maxPixelRatio: number };
    if (this.initialMaxPixelRatio === null) {
      this.initialMaxPixelRatio = dev.maxPixelRatio;
    }
    const target = mode === 'high'
      ? this.initialMaxPixelRatio
      : this.initialMaxPixelRatio * preset.renderScale;
    if (dev.maxPixelRatio !== target) {
      dev.maxPixelRatio = target;
      const canvas = this.app.graphicsDevice.canvas;
      const w = canvas.clientWidth || canvas.width;
      const h = canvas.clientHeight || canvas.height;
      if (w > 0 && h > 0) this.app.resizeCanvas(w, h);
    }

    // Radial sorting — frame-level switch on the gsplat scene config.
    const sceneGsplat = (this.app.scene as unknown as { gsplat: { radialSorting: boolean } }).gsplat;
    if (sceneGsplat) sceneGsplat.radialSorting = preset.radialSort;
  }

  /**
   * Toggle viewer mirroring across browser tabs (BroadcastChannel-based).
   *
   * - `'send'`    — broadcast camera pose every other frame (~30 Hz). Other tabs in
   *                 the same browser can receive it.
   * - `'receive'` — detach the camera-controller and slave the camera to incoming
   *                 broadcasts. Local mouse / keyboard input no longer moves the camera.
   * - `'off'`    — restore normal operation.
   *
   * Same-PC same-browser only (BroadcastChannel limitation). Cross-machine mirroring
   * would need a WebSocket relay (Cloudflare Worker / WebRTC) — separate task.
   */
  setMirrorMode(mode: 'off' | 'send' | 'receive') {
    // Tear down any previous mirror state first so toggling never leaks listeners.
    this.mirrorCleanup?.();
    this.mirrorCleanup = null;
    this.mirrorChannel?.close();
    this.mirrorChannel = null;
    if (mode === 'off') return;

    const channel = new BroadcastChannel('3droomtour-mirror');
    this.mirrorChannel = channel;

    if (mode === 'send') {
      let frameCount = 0;
      const handler = () => {
        // 30 Hz is plenty for smooth mirroring; halving from vsync 60 cuts the
        // postMessage churn the receiver has to absorb.
        frameCount++;
        if (frameCount % 2 !== 0) return;
        const cc = this.cameraController;
        if (!cc) return;
        const p = this.camera.getPosition();
        try {
          channel.postMessage({
            type: 'pose',
            position: [p.x, p.y, p.z],
            yaw: cc.getYaw(),
            pitch: cc.getPitch(),
            fov: cc.getFov(),
          });
        } catch { /* channel might be closing */ }
      };
      this.app.on('update', handler);
      this.mirrorCleanup = () => this.app.off('update', handler);
      return;
    }

    // mode === 'receive':
    // Detach the controller's per-frame update so it doesn't fight the slaved pose.
    const cc = this.cameraController as unknown as {
      updateHandler?: ((dt: number) => void) | null;
      setYaw?: (deg: number) => void;
      setPitch?: (deg: number) => void;
      setPlayerPosition?: (x: number, y: number, z: number) => void;
    } | null;
    const ccUpdate = cc?.updateHandler ?? null;
    if (ccUpdate) this.app.off('update', ccUpdate);

    const cam = this.camera.camera as unknown as { fov: number } | null;
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data as { type?: string; position?: [number, number, number]; yaw?: number; pitch?: number; fov?: number };
      if (msg?.type !== 'pose') return;
      if (msg.position) {
        // Move the controller's logical playerPos, not just the entity — the
        // setYaw/setPitch below end in applyPose(), whose final
        // `entity.setPosition(playerPos)` would overwrite a bare entity write
        // with the stale position (= the "rotation mirrors but position
        // doesn't" bug). Fall back to the entity write for controllers without
        // the method (orbit).
        if (cc?.setPlayerPosition) {
          cc.setPlayerPosition(msg.position[0], msg.position[1], msg.position[2]);
        } else {
          this.camera.setPosition(msg.position[0], msg.position[1], msg.position[2]);
        }
      }
      if (msg.yaw !== undefined && msg.pitch !== undefined) {
        // Match camera-controller's convention: pitch on X, yaw on Y, no roll.
        this.camera.setEulerAngles(msg.pitch, msg.yaw, 0);
        // Keep the controller's internal state in sync so a future "off" hands
        // back a sane pose to local input.
        if (cc?.setYaw) cc.setYaw(msg.yaw);
        if (cc?.setPitch) cc.setPitch(msg.pitch);
      }
      if (msg.fov !== undefined && cam) cam.fov = msg.fov;
    };
    channel.addEventListener('message', onMessage);

    this.mirrorCleanup = () => {
      channel.removeEventListener('message', onMessage);
      // Re-attach the controller's update so local input works again on 'off'.
      if (ccUpdate) this.app.on('update', ccUpdate);
    };
  }

  setMoveSpeed(speed: number) {
    this.cameraController?.setMoveSpeed(speed);
  }

  setTouchJoystick(x: number, y: number) {
    this.cameraController?.setTouchJoystick(x, y);
  }

  setFov(fov: number) {
    this.cameraController?.setFov(fov);
  }

  /** Demo-mode head-tracking offset (degrees). Render-only overlay. */
  setTrackingOffset(yawDeg: number, pitchDeg: number) {
    this.cameraController?.setTrackingOffset(yawDeg, pitchDeg);
  }

  /** Live camera pose straight from the controller — used by viewpoint authoring so
   *  the saved target reflects exactly what the user is looking at, not the throttled
   *  ~6-frame-old debug-sync snapshot in the camera-store. */
  getLiveCameraPose(): { position: [number, number, number]; yaw: number; pitch: number; fov: number } | null {
    if (!this.cameraController) return null;
    const p = this.camera.getPosition();
    return {
      position: [p.x, p.y, p.z],
      yaw: this.cameraController.getYaw(),
      pitch: this.cameraController.getPitch(),
      fov: this.cameraController.getFov(),
    };
  }

  /** Forward pitch clamp configuration to the controller (used by 360 mode UI). */
  setPitchMaxUp(deg: number) {
    this.cameraController?.setPitchMaxUp(deg);
  }

  /** Update wheel-zoom bounds at runtime (debug sliders live-edit). */
  setZoomFovBounds(min: number, max: number) {
    this.cameraController?.setZoomFovBounds(min, max);
  }
  /** Live update of the camera's eye-level height (so the 初期高さ slider reflects in preview). */
  setCurrentHeight(h: number) {
    this.cameraController?.setCurrentHeight(h);
  }

  /** Subscribe to wheel-driven moveSpeed changes (Debug slider auto-sync). */
  setOnMoveSpeedChange(cb: ((speed: number) => void) | null) {
    this.cameraController?.setOnMoveSpeedChange(cb);
  }

  /**
   * Apply rotation/position to the active splat entity without reloading. Used by the
   * debug CAMERA section sliders for live preview while the user drags. The persistent
   * value lives on `Plan.splatTransform` (set via the scene-store action).
   */
  setSplatTransform(transform: SplatTransform | undefined) {
    if (!this.splatEntity) return;
    applySplatTransform(this.splatEntity, transform);
  }

  /**
   * Swap the splat to a furniture/lighting variant.
   * Resolves `splatVariants[{furniture}_{lighting}]` from the manifest; no-op if not defined.
   * Camera pose is preserved.
   */
  async setVariant(furniture: FurnitureMode, lighting: LightingMode): Promise<void> {
    const m = this.manifest;
    if (!m || !m.splatVariants) return;
    const key = `${furniture}_${lighting}`;
    const relPath = m.splatVariants[key];
    if (!relPath) {
      console.warn(`no splat variant defined for ${key}`);
      return;
    }

    const url = `/assets/scenes/${m.id}/${relPath}`;

    // Preserve current camera pose
    const pos = this.camera.getPosition().clone();
    const rot = this.camera.getEulerAngles().clone();

    // Destroy old splat
    if (this.splatEntity) {
      this.splatEntity.destroy();
      this.splatEntity = null;
    }

    try {
      this.splatEntity = await loadGSplat(this.app, url, `splat-${m.id}-${key}`);
      this.camera.setPosition(pos);
      this.camera.setEulerAngles(rot.x, rot.y, rot.z);
    } catch (err) {
      console.error(`variant splat load failed (${key}):`, err);
    }
  }

  /** Load collision GLB from a data URL (drag & drop) */
  async loadCollisionFromDataUrl(dataUrl: string, type: 'walkable' | 'block'): Promise<boolean> {
    try {
      const gen = this.collisionGen;
      const color = type === 'walkable' ? '#00ff00' : '#ff0000';
      const col = await loadCollisionGlb(this.app, dataUrl, `collision-${type}`, color, 0.15);
      // A plan switch happened while this GLB was loading — the result belongs to
      // the OLD plan; installing it would arm the previous plan's floor/walls.
      if (gen !== this.collisionGen) { col.entity.destroy(); return false; }
      col.entity.enabled = true;
      this.app.root.addChild(col.entity);
      if (type === 'walkable') { this.collisionWalkable?.entity.destroy(); this.collisionWalkable = col; }
      else { this.collisionBlock?.entity.destroy(); this.collisionBlock = col; }
      // Hand the freshly extracted world-space triangles to the camera controller so
      // walk-mode floor follow / wall collision picks them up immediately. World matrices
      // need to be valid first — request a sync via the next animation frame. Then apply
      // the current viz state (hidden by default): the mesh extracts while enabled but
      // does NOT leak the green debug box into play.
      requestAnimationFrame(() => {
        this.syncCollisionTrianglesToController(type);
        setColVis(col, this.collisionVisible);
      });
      return true;
    } catch (e) { console.error(`Failed to load ${type} collision:`, e); return false; }
  }

  /** Resolve a manifest collision ref (`idb:<key>` or scene-relative path) and
   *  call the underlying loader. Used by both the Debug "auto-load on plan load"
   *  path and the customer viewer fetching from R2. */
  async loadCollisionFromManifestRef(ref: string, type: 'walkable' | 'block'): Promise<boolean> {
    try {
      const gen = this.collisionGen;
      const url = await resolveAssetUrl(ref, this.manifest?.id ?? '');
      const color = type === 'walkable' ? '#00ff00' : '#ff0000';
      const col = await loadCollisionGlb(this.app, url, `collision-${type}`, color, 0.15);
      // A plan switch happened while this GLB was loading — the result belongs to
      // the OLD plan; installing it would arm the previous plan's floor/walls.
      if (gen !== this.collisionGen) { col.entity.destroy(); return false; }
      col.entity.enabled = true;
      this.app.root.addChild(col.entity);
      if (type === 'walkable') { this.collisionWalkable?.entity.destroy(); this.collisionWalkable = col; }
      else { this.collisionBlock?.entity.destroy(); this.collisionBlock = col; }
      requestAnimationFrame(() => {
        this.syncCollisionTrianglesToController(type);
        setColVis(col, this.collisionVisible);
      });
      return true;
    } catch (e) { console.error(`Failed to load ${type} collision from ${ref}:`, e); return false; }
  }

  /** Re-extract triangles from one or both collision entities and push to the camera controller.
   *  Honors per-channel toggles — pushes `null` when physics is disabled
   *  even if the GLB is loaded, so newly-loaded meshes don't silently
   *  re-arm collision behind the user's back. */
  private syncCollisionTrianglesToController(only?: 'walkable' | 'block') {
    if (!this.cameraController) return;
    // Cull stray far-away voxel boxes (outside the splat AABB) before handing the
    // triangles to the controller, so they can't floor-snap / jitter the player.
    const bounds = this.computeSplatWorldBounds();
    if (!only || only === 'walkable') {
      const raw = (this.walkableEnabled && this.collisionWalkable) ? extractTrianglesFromEntity(this.collisionWalkable.entity) : null;
      this.walkableTrisCache = cullTrianglesToBounds(raw, bounds);
      this.cameraController.setWalkableTriangles(this.walkableTrisCache);
    }
    if (!only || only === 'block') {
      const raw = (this.blockEnabled && this.collisionBlock) ? extractTrianglesFromEntity(this.collisionBlock.entity) : null;
      this.blockTrisCache = cullTrianglesToBounds(raw, bounds);
      this.cameraController.setBlockTriangles(this.blockTrisCache);
    }
    // If the splat AABB wasn't available yet (big PLY/SOG still initializing right
    // after load), the triangles above went out UNculled — stray far-away boxes
    // survive and the player can floor-snap onto them. Pushing first keeps walking
    // usable immediately; retry until the AABB shows up, then re-cull.
    if (!bounds && this.splatEntity && (this.collisionWalkable || this.collisionBlock)) {
      this.scheduleBoundsRecull();
    }
  }

  /** Retry loop for the AABB cull above: poll until `computeSplatWorldBounds()`
   *  returns non-null (splat finished initializing), then re-sync (= re-cull) the
   *  collision triangles. Gives up after ~10 s — behavior then matches the old
   *  "no cull" path. A plan switch tears down `splatEntity` / the controller,
   *  which the tick detects; `destroy()` clears the timer. */
  private scheduleBoundsRecull() {
    if (this.boundsRecullTimer !== null) return; // a retry loop is already waiting
    let tries = 0;
    const tick = () => {
      this.boundsRecullTimer = null;
      if (!this.cameraController || !this.splatEntity) return; // scene torn down / plan switching
      if (this.computeSplatWorldBounds()) {
        this.syncCollisionTrianglesToController(); // re-extract + cull with real bounds
        return;
      }
      if (++tries < 40) {
        this.boundsRecullTimer = window.setTimeout(tick, 250);
      } else {
        console.warn('collision AABB cull skipped: splat bounds never became available');
      }
    };
    this.boundsRecullTimer = window.setTimeout(tick, 250);
  }

  /** World-space AABB of the active splat (with a margin), or null if unavailable.
   *  The gsplat AABB is local; transform its 8 corners to world so rotation/scale
   *  (e.g. the default [180,0,0] splatTransform) are handled correctly.
   *  Margin: 2.0 m — generous enough that a tight/slightly-off splat AABB doesn't
   *  cull legitimate floor triangles at the room edges (voxelized collision can
   *  overhang the splat by a voxel or two), while stray boxes — typically several
   *  meters out — still land outside. */
  private computeSplatWorldBounds(margin = 2.0): { min: Vec3; max: Vec3 } | null {
    const ent = this.splatEntity;
    if (!ent) return null;
    const gs = ent.gsplat as unknown as {
      instance?: { aabb?: { center: Vec3; halfExtents: Vec3 } | null; customAabb?: { center: Vec3; halfExtents: Vec3 } | null };
      aabb?: { center: Vec3; halfExtents: Vec3 } | null;
      customAabb?: { center: Vec3; halfExtents: Vec3 } | null;
    } | null;
    const aabb = gs?.instance?.aabb ?? gs?.instance?.customAabb ?? gs?.aabb ?? gs?.customAabb ?? null;
    if (!aabb?.center || !aabb?.halfExtents) return null;
    const wt = ent.getWorldTransform();
    const c = aabb.center, h = aabb.halfExtents;
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    const corner = new Vec3();
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          corner.set(c.x + sx * h.x, c.y + sy * h.y, c.z + sz * h.z);
          wt.transformPoint(corner, corner);
          min.x = Math.min(min.x, corner.x); min.y = Math.min(min.y, corner.y); min.z = Math.min(min.z, corner.z);
          max.x = Math.max(max.x, corner.x); max.y = Math.max(max.y, corner.y); max.z = Math.max(max.z, corner.z);
        }
      }
    }
    if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return null;
    min.x -= margin; min.y -= margin; min.z -= margin;
    max.x += margin; max.y += margin; max.z += margin;
    return { min, max };
  }

  /** Remove one collision channel entirely (mesh + controller triangles).
   *  Used when the active source (manual/auto) switches to a stash that has
   *  no GLB for this channel — disabling alone would leave the old mesh armed.
   *  NOTE: bumps `collisionGen` (any in-flight load is discarded), so callers
   *  doing a clear-then-reload must clear BOTH channels before starting loads. */
  clearCollision(type: 'walkable' | 'block') {
    this.collisionGen++;
    if (type === 'walkable') { this.collisionWalkable?.entity.destroy(); this.collisionWalkable = null; }
    else { this.collisionBlock?.entity.destroy(); this.collisionBlock = null; }
    this.syncCollisionTrianglesToController(type);
  }

  setCollisionVisible(visible: boolean) {
    this.collisionVisible = visible;
    if (this.collisionWalkable) setColVis(this.collisionWalkable, visible);
    if (this.collisionBlock) setColVis(this.collisionBlock, visible);
  }

  /** Toggle whether the walkable GLB drives floor-snap (gravity). Off →
   *  the player keeps their current Y instead of being raycast onto the
   *  walkable surface. */
  setCollisionWalkableEnabled(enabled: boolean) {
    this.walkableEnabled = enabled;
    this.syncCollisionTrianglesToController('walkable');
  }
  /** Toggle whether the block GLB blocks movement (walls). Off → walls are
   *  ignored; the player passes straight through them. Independent of
   *  walkable so you can disable just the walls while keeping gravity. */
  setCollisionBlockEnabled(enabled: boolean) {
    this.blockEnabled = enabled;
    this.syncCollisionTrianglesToController('block');
  }

  setCollisionOpacity(opacity: number) {
    if (this.collisionWalkable) setColOp(this.collisionWalkable, opacity);
    if (this.collisionBlock) setColOp(this.collisionBlock, opacity);
  }

  async loadHdri(file: File): Promise<true | string> {
    try {
      await applyHdriFromFile(this.app, file);
      return true;
    } catch (e) {
      console.error('Failed to load HDRI:', e);
      return e instanceof Error ? e.message : String(e);
    }
  }

  removeHdri() {
    removeHdri(this.app);
  }

  /** Studio = camera background color. Always-on (no mode toggle). HDRI, when
   *  loaded, draws over it via the SKYBOX layer; removing HDRI re-exposes this
   *  color. */
  setStudioColor(color: [number, number, number]) {
    setStudioColor(this.app, color);
  }

  getManifest() {
    return this.manifest;
  }

  /**
   * Jump through every viewpoint, render a frame, and capture the canvas as a JPEG data URL.
   * Requires graphics device to be created with preserveDrawingBuffer: true.
   *
   * The 846MB sample splat needs several frames after creation before the GPU sort buffer
   * stabilises — capturing too early yielded blank images, hence the warmup + per-jump waits.
   */
  async captureViewpointThumbnails(): Promise<Record<string, string>> {
    const manifest = this.manifest;
    const controller = this.cameraController;
    if (!manifest || !controller) return {};
    const planId = useSceneStore.getState().activePlanId;
    const plan = manifest.plans?.find((p) => p.id === planId);
    const vps = plan?.viewpoints ?? [];
    if (vps.length === 0) return {};

    const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement;
    const thumbs: Record<string, string> = {};

    // Warmup so the splat actually renders at least once before we start grabbing pixels.
    await this.waitFrames(8);

    for (const vp of vps) {
      controller.jumpTo(vp.position, vp.target, vp.fov);
      // Splat sort/render needs a few frames after each pose change to settle.
      await this.waitFrames(4);
      try {
        thumbs[vp.id] = canvas.toDataURL('image/jpeg', 0.7);
      } catch (err) {
        console.warn(`thumbnail capture failed for ${vp.id}:`, err);
      }
    }

    return thumbs;
  }

  /** Re-capture a single viewpoint's thumbnail (auto) for the active plan. */
  async recaptureViewpointThumbnail(viewpointId: string): Promise<string | null> {
    const manifest = this.manifest;
    const controller = this.cameraController;
    const planId = useSceneStore.getState().activePlanId;
    if (!manifest || !controller || !planId) return null;
    const plan = manifest.plans?.find((p) => p.id === planId);
    const vp = plan?.viewpoints.find((v) => v.id === viewpointId);
    if (!vp) return null;

    const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement;
    const prevActive = useCameraStore.getState().activeViewpoint;
    controller.jumpTo(vp.position, vp.target, vp.fov);
    await this.waitFrames(4);
    let dataUrl: string | null = null;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      useSceneStore.getState().setViewpointThumbnail(planId, vp.id, dataUrl);
    } catch (err) {
      console.warn(`thumbnail recapture failed for ${vp.id}:`, err);
    }
    // Restore where the user actually was.
    if (prevActive && prevActive !== vp.id) {
      const prev = plan?.viewpoints.find((v) => v.id === prevActive);
      if (prev) controller.jumpTo(prev.position, prev.target, prev.fov);
    }
    return dataUrl;
  }

  /**
   * 📷 from the VR視点 section: save the **manual thumbnail** for a viewpoint by
   * cropping the front-facing region of the viewpoint's panorama image. Independent
   * from the live preview / camera yaw — capturing a thumbnail never rotates, relocates
   * or otherwise mutates the viewpoint or the live camera. If the viewpoint has no
   * panorama yet, falls back to the current canvas frame so splat-only viewpoints still
   * have something to save.
   */
  async captureCurrentFrameAsManualThumbnail(viewpointId: string): Promise<string | null> {
    const sceneStore = useSceneStore.getState();
    const planId = sceneStore.activePlanId;
    if (!planId) return null;
    const manifest = sceneStore.manifest;
    const plan = manifest?.plans?.find((p) => p.id === planId);
    const panoSrc = plan?.panoramas?.[viewpointId];

    let dataUrl: string | null = null;
    if (panoSrc && manifest) {
      try {
        const url = await resolveAssetUrl(panoSrc, manifest.id);
        dataUrl = await panoramaToThumbnail(url, { width: 320, height: 200, fovDeg: 80 });
      } catch (err) {
        console.warn(`panorama-derived thumbnail failed for ${viewpointId}:`, err);
      }
    }
    if (!dataUrl) {
      // Fallback for splat-only viewpoints (no panorama set).
      try {
        const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement;
        dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (err) {
        console.warn(`manual capture fallback failed for ${viewpointId}:`, err);
        return null;
      }
    }
    useSceneStore.getState().setViewpointManualThumbnail(planId, viewpointId, dataUrl);
    return dataUrl;
  }

  /** Wait for `n` rendered frames using requestAnimationFrame (PlayCanvas drives off the same loop). */
  private waitFrames(n: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let i = 0;
      const tick = () => {
        i++;
        if (i >= n) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  setMovementMode(mode: MovementMode) {
    this.cameraController?.setMovementMode(mode);
    // Player marker (legacy 3rd-person visualisation) is always hidden in walk/fly modes —
    // both keep the camera at the player position. Marker code stays in case we revive it.
    if (this.playerMarker) this.playerMarker.enabled = false;
  }

  /** Build a small sphere parented to the world that visualises the player position in 3rd-person. */
  private createPlayerMarker() {
    if (this.playerMarker) return;
    const marker = new Entity('player-marker');
    marker.addComponent('render', { type: 'sphere' });
    marker.setLocalScale(0.28, 0.28, 0.28);
    const mat = new StandardMaterial();
    mat.diffuse = new Color(1.0, 0.78, 0.1);
    mat.emissive = new Color(0.5, 0.35, 0.0);
    mat.useLighting = false;
    mat.update();
    const meshInstances = (marker.render as { meshInstances?: { material: StandardMaterial }[] } | undefined)?.meshInstances;
    if (meshInstances) {
      for (const mi of meshInstances) mi.material = mat;
    }
    marker.enabled = false;
    this.app.root.addChild(marker);
    this.playerMarker = marker;
  }

  destroy() {
    if (this.vpSyncTimer) {
      clearTimeout(this.vpSyncTimer);
      this.vpSyncTimer = null;
    }
    if (this.boundsRecullTimer !== null) {
      clearTimeout(this.boundsRecullTimer);
      this.boundsRecullTimer = null;
    }
    // Invalidate in-flight collision loads so they can't attach to the torn-down app.
    this.collisionGen++;
    if (this.walkDollyRaf !== null) {
      cancelAnimationFrame(this.walkDollyRaf);
      this.walkDollyRaf = null;
    }
    this.stopCameraAnimation();
    if (this.debugSyncHandler) {
      this.app.off('update', this.debugSyncHandler);
      this.debugSyncHandler = null;
    }
    if (this.markerSyncHandler) {
      this.app.off('update', this.markerSyncHandler);
      this.markerSyncHandler = null;
    }
    this.cameraController?.destroy();
    this.cameraController = null;
    if (this.splatEntity) { this.splatEntity.destroy(); this.splatEntity = null; }
    if (this.playerMarker) { this.playerMarker.destroy(); this.playerMarker = null; }
    this.collisionWalkable?.entity.destroy();
    this.collisionWalkable = null;
    this.collisionBlock?.entity.destroy();
    this.collisionBlock = null;
    if (this.app.graphicsDevice) this.app.destroy();
  }
}
