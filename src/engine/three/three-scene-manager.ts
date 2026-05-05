import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DropInViewer, SceneFormat } from '@mkkellogg/gaussian-splats-3d';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { ViewerEngine, RenderQualityConfig, Viewpoint, SceneManifest, CameraPose, CameraKeyframe } from '../../core/types';
import { interpolatePath, totalPathDurationSec } from '../../core/viewpoint';
import { downscaleCanvasToJpeg } from '../../utils/video-recorder';
import { useSceneStore } from '../../store/scene-store';
import { useCameraStore } from '../../store/camera-store';
import { resolveSplatUrl } from '../resolve-splat-url';
import { loadSceneManifest } from '../../core/scene-manifest';
import { ThreeCameraController, type MovementMode } from './three-camera-controller';
import { extractThreeTriangles } from './three-mesh-raycaster';

/**
 * Three.js–based scene manager. Mirrors the public API of the PlayCanvas-based
 * `SceneManager` so `Viewer.tsx` / `DebugViewer.tsx` can use either interchangeably
 * (we type the ref as a union and rely on structural typing).
 *
 * Drives the splat rendering through one of:
 * - **mkkellogg** — `DropInViewer` (a `THREE.Group`) added to the scene. SH degree 3. Reads PLY.
 * - **spark**     — `SparkRenderer` + `SplatMesh` added to the scene. Reads PLY/SPZ.
 *                   Prefers `Plan.splatSpz` when present (~10x smaller than PLY).
 *
 * Both engines share the same camera controller, collision, viewpoint, and
 * render-config code paths. Runtime LOD was removed because Spark's `lod: 'quality'`
 * triggers a 30+s WASM Bhatt-LoD build per load with no caching, and pre-baking LOD
 * into SPZ requires Spark's git-repo Rust CLI (not in the npm distribution). If true
 * LOD becomes necessary later, bake offline via `rust/build-lod` and add a separate
 * `splatSpzLod` field carrying a `flagLod=true` SPZ.
 */
export class ThreeSceneManager {
  private engine: ViewerEngine;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controller: ThreeCameraController;
  private splatGroup: THREE.Object3D | null = null;
  private collisionWalkable: THREE.Object3D | null = null;
  private collisionBlock: THREE.Object3D | null = null;
  private rafId: number | null = null;
  private cleanups: Array<() => void> = [];
  private storeSyncFrame = 0;
  /** Tiny rotating reference cube so the user can confirm the renderer pipeline is alive
   *  even when the splat hasn't finished loading or fails to render. */
  private debugCube: THREE.Mesh;
  /** HUD overlay showing engine + load state. */
  private hud: HTMLDivElement;

  /** Show debug HUD / test cube / FPS. DebugViewer enables; production Viewer disables. */
  private debug: boolean;
  /** Sliding-window FPS computation state. */
  private fpsFrames: number[] = [];
  /** Last "status" text passed to setHud — re-rendered with refreshed FPS each tick. */
  private lastHudStatus = 'initializing…';

  /** Camera-animation state for the Debug 動画タブ. While `animRafId` is non-null
   *  the controller's input RAF is suspended so user input doesn't fight the
   *  animation. Restored when the animation finishes. */
  private animRafId: number | null = null;
  private animState: {
    keyframes: CameraKeyframe[];
    totalMs: number;
    t0: number;
    startT: number;
    endT: number;
    onProgress?: (t: number) => void;
    onDone?: () => void;
  } | null = null;

  constructor(host: HTMLElement, engine: ViewerEngine, opts?: { debug?: boolean }) {
    this.engine = engine;
    this.debug = !!opts?.debug;

    // Canvas + renderer.
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.appendChild(canvas);
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    // 3DGS の splat 色は線形空間で計算 → ディスプレイは sRGB エンコーディング前提なので、
    // 明示的に sRGB 出力にしないと Three.js 既定 (Linear) で全体が沈んで見える。
    // manifest に render 設定がないシーンでも SuperSplat 相当の発色になるよう既定値を上書き。
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Scene + camera.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0.1, 0.1, 0.15);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(0, 1.6, 5);

    // Resize tracker.
    const doResize = () => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(host);
    this.cleanups.push(() => ro.disconnect());
    doResize();

    // Camera controller (walk/fly + collision).
    this.controller = new ThreeCameraController(this.camera, canvas);

    // Spark needs a SparkRenderer in the scene to drive its per-frame splat update.
    if (this.engine === 'spark') {
      const spark = new SparkRenderer({ renderer: this.renderer });
      this.scene.add(spark);
    }

    // Debug cube + HUD: shown only when `debug: true` (= DebugViewer). Production
    // Viewer keeps the canvas clean.
    const cubeColor = engine === 'spark' ? 0x60a5fa : 0xfb923c;
    const cubeGeom = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const cubeMat = new THREE.MeshBasicMaterial({ color: cubeColor });
    this.debugCube = new THREE.Mesh(cubeGeom, cubeMat);
    this.debugCube.position.set(0, 1.2, 0);
    this.debugCube.visible = this.debug;
    this.scene.add(this.debugCube);

    // HUD は右上固定 (左上だと LeftPanel サイドバーに隠れて見えないため)。
    const hud = document.createElement('div');
    const hudBg = engine === 'spark' ? 'rgba(37,99,235,0.85)' : 'rgba(234,88,12,0.85)';
    hud.style.cssText = `
      position: absolute; top: 12px; right: 12px; z-index: 5;
      padding: 6px 12px; font-size: 13px; font-weight: 700;
      font-family: ui-monospace, monospace;
      background: ${hudBg}; color: #fff; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      pointer-events: none; user-select: none; letter-spacing: 0.3px;
      display: ${this.debug ? 'block' : 'none'};
      white-space: nowrap;
    `;
    hud.textContent = `${engine.toUpperCase()} — initializing…`;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(hud);
    this.hud = hud;
    this.cleanups.push(() => { if (hud.parentElement) hud.parentElement.removeChild(hud); });

    // RAF.
    let lastHudUpdate = 0;
    const loop = () => {
      const now = performance.now();
      this.fpsFrames.push(now);
      // Drop frames older than 1s.
      while (this.fpsFrames.length > 1 && now - this.fpsFrames[0] > 1000) this.fpsFrames.shift();
      this.storeSyncFrame++;
      // Camera-store sync at ~10fps (every 6 frames). Keeps the floor-plan map's
      // live cone aligned with the current camera direction.
      if (this.storeSyncFrame % 6 === 0) {
        const camStore = useCameraStore.getState();
        const p = this.camera.position;
        camStore.setPosition([p.x, p.y, p.z]);
        camStore.setPitch(this.controller.getPitch());
        camStore.setYaw(this.controller.getYaw());
        camStore.setFov(this.camera.fov);
      }
      // Spin the debug cube so a still cube also tells you the RAF stopped.
      this.debugCube.rotation.y += 0.01;
      this.renderer.render(this.scene, this.camera);
      // HUD FPS — refresh ~3x/s in debug mode only.
      if (this.debug && now - lastHudUpdate > 333) {
        lastHudUpdate = now;
        if (this.hud) this.hud.innerHTML = this.formatHudHtml(this.lastHudStatus);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Compute current FPS from the sliding 1s frame buffer. */
  private currentFps(): number {
    const n = this.fpsFrames.length;
    if (n < 2) return 0;
    const span = (this.fpsFrames[n - 1] - this.fpsFrames[0]) / 1000;
    return span > 0 ? (n - 1) / span : 0;
  }

  private setHud(msg: string) {
    this.lastHudStatus = msg;
    if (this.hud) this.hud.innerHTML = this.formatHudHtml(msg);
  }

  // ── Scene loading ──

  async loadScene(sceneId: string): Promise<void> {
    const store = useSceneStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const existing = store.manifest;
      const manifest = (existing && existing.id === sceneId) ? existing : await loadSceneManifest(sceneId);
      if (!existing || existing.id !== sceneId) store.setManifest(manifest);
      const ensured: SceneManifest = useSceneStore.getState().manifest ?? manifest;
      const activePlanId = useSceneStore.getState().activePlanId;
      const activePlan = ensured.plans?.find((p) => p.id === activePlanId) ?? ensured.plans?.[0];

      // Spark prefers the SPZ variant when available (~10x smaller than PLY); mkkellogg
      // can't read SPZ so it always uses the PLY in `splat`.
      const splatRef = (this.engine === 'spark' && activePlan?.splatSpz) || activePlan?.splat;
      if (splatRef) {
        this.setHud(`${this.engine === 'spark' && activePlan?.splatSpz ? 'SPZ' : 'PLY'} 解決中…`);
        const splatUrl = await resolveSplatUrl(splatRef, sceneId);
        this.setHud('スプラット読み込み中…');
        await this.loadSplat(splatUrl, activePlan?.splatTransform);
        // HUD と最終 bbox はエンジン側のコールバック (mkkellogg は await 完了 / Spark は
        // onLoad) で更新される。ここでは何もしない (Spark は scene 追加直後に return
        // するので、ここで bbox を取ると常に 0 になる)。
      } else {
        this.setHud('PLY 未設定');
      }

      // Auto-load collision (walkable / block) if the active plan has refs.
      if (activePlan?.collision?.walkable) {
        const url = await resolveSplatUrl(activePlan.collision.walkable, sceneId);
        await this.loadCollisionFromUrl(url, 'walkable');
      }
      if (activePlan?.collision?.block) {
        const url = await resolveSplatUrl(activePlan.collision.block, sceneId);
        await this.loadCollisionFromUrl(url, 'block');
      }

      // Apply render-quality config.
      this.applyRenderConfig(ensured.settings.render);

      // Jump to first viewpoint.
      const vps = activePlan?.viewpoints ?? [];
      if (vps.length > 0) this.jumpToViewpoint(vps[0]);

      store.setLoaded(true);
      store.setLoading(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[three] loadScene failed:', err);
      this.setHud(`エラー: ${msg.slice(0, 60)}`);
      store.setError(msg);
      store.setLoading(false);
    }
  }

  private async loadSplat(url: string, transform?: { rotation?: [number, number, number]; position?: [number, number, number] }) {
    if (this.splatGroup) {
      this.scene.remove(this.splatGroup);
      this.splatGroup = null;
    }
    const rot = transform?.rotation ?? [180, 0, 0];
    const pos = transform?.position ?? [0, 0, 0];

    console.info(`[three] loadSplat (${this.engine}) ${url.startsWith('blob:') ? '(blob)' : url.slice(0, 80)}`);
    if (this.engine === 'spark') {
      // Pure load: no `lod`/`lodScale`/`lodAbove` — those would trigger the WASM Bhatt
      // LoD construction (30+ seconds for 5M splats) every load. SPZ alone gives the
      // download-size win; for true distance LOD we'd need to pre-bake offline.
      const t0 = performance.now();
      const splat = new SplatMesh({
        url,
        onLoad: () => {
          const dt = ((performance.now() - t0) / 1000).toFixed(1);
          const ns = (splat as { numSplats?: number }).numSplats ?? 0;
          console.info(`[three] Spark onLoad ${dt}s — numSplats=${ns}`);
          this.setHud(`描画中 (${dt}s / ${ns.toLocaleString()} splats)`);
        },
        onProgress: (e: ProgressEvent) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            this.setHud(`Spark ダウンロード ${pct}% (${(e.loaded / 1048576).toFixed(0)}/${(e.total / 1048576).toFixed(0)} MB)`);
          } else {
            this.setHud(`Spark ダウンロード ${(e.loaded / 1048576).toFixed(0)} MB`);
          }
        },
      });
      splat.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]));
      splat.position.set(pos[0], pos[1], pos[2]);
      this.scene.add(splat);
      this.splatGroup = splat;
      // 3 秒ごとに状態をログ。固まっているのか進行中なのか分かる用。10 回 = 30秒で停止。
      let beats = 0;
      const heartbeat = window.setInterval(() => {
        beats++;
        const s = splat as { isInitialized?: boolean; numSplats?: number };
        const dt = ((performance.now() - t0) / 1000).toFixed(1);
        console.info(`[three] Spark ${dt}s — isInitialized=${s.isInitialized}, numSplats=${s.numSplats ?? 0}`);
        if (s.isInitialized || beats >= 10) clearInterval(heartbeat);
      }, 3000);
      this.cleanups.push(() => clearInterval(heartbeat));
    } else {
      // mkkellogg DropInViewer — extends THREE.Group, can be added to any scene.
      const dropIn = new DropInViewer({
        sphericalHarmonicsDegree: 3,
        ignoreDevicePixelRatio: false,
        sharedMemoryForWorkers: false,
      }) as THREE.Group & {
        addSplatScene: (url: string, opts?: Record<string, unknown>) => Promise<void>;
        dispose?: () => void | Promise<void>;
        viewer?: { splatMesh?: THREE.Object3D | null };
      };
      dropIn.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]));
      dropIn.position.set(pos[0], pos[1], pos[2]);
      this.scene.add(dropIn);
      try {
        const t0 = performance.now();
        await dropIn.addSplatScene(url, {
          format: SceneFormat.Ply,
          showLoadingUI: false,
          progressiveLoad: false,
        });
        const dt = ((performance.now() - t0) / 1000).toFixed(1);
        const splatMeshChildren = dropIn.viewer?.splatMesh?.children?.length ?? 0;
        console.info(`[three] addSplatScene OK in ${dt}s (mkkellogg). dropIn.children=${dropIn.children.length}, splatMesh.children=${splatMeshChildren}`);
        this.setHud(`描画中 (${dt}s でロード)`);
      } catch (err) {
        console.error(`[three] addSplatScene failed (mkkellogg):`, err);
        this.setHud(`mkkellogg PLY ロード失敗: ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
      }
      this.splatGroup = dropIn;
    }
  }

  private async loadCollisionFromUrl(url: string, type: 'walkable' | 'block'): Promise<boolean> {
    try {
      const loader = new GLTFLoader();
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.load(url, (g) => resolve(g as unknown as { scene: THREE.Group }), undefined, reject);
      });
      const group = gltf.scene;
      // Visualisation material so the user can see collision when they toggle visible.
      const color = type === 'walkable' ? 0x00ff00 : 0xff0000;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide });
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = mat;
      });
      group.visible = false;
      this.scene.add(group);
      const tris = extractThreeTriangles(group);
      if (type === 'walkable') {
        this.removeCollision('walkable');
        this.collisionWalkable = group;
        this.controller.setWalkableTriangles(tris);
      } else {
        this.removeCollision('block');
        this.collisionBlock = group;
        this.controller.setBlockTriangles(tris);
      }
      return true;
    } catch (err) {
      console.error(`three collision load failed (${type}):`, err);
      return false;
    }
  }

  private removeCollision(type: 'walkable' | 'block') {
    const cur = type === 'walkable' ? this.collisionWalkable : this.collisionBlock;
    if (cur) {
      this.scene.remove(cur);
      if (type === 'walkable') this.collisionWalkable = null;
      else this.collisionBlock = null;
    }
    if (type === 'walkable') this.controller.setWalkableTriangles(null);
    else this.controller.setBlockTriangles(null);
  }

  // ── Public API mirroring SceneManager ──

  jumpToViewpoint(vp: Viewpoint) {
    this.controller.jumpTo(vp.position, vp.target, vp.fov);
    const camStore = useCameraStore.getState();
    camStore.setActiveViewpoint(vp.id);
    camStore.setPosition([vp.position[0], vp.position[1], vp.position[2]]);
    camStore.setPitch(this.controller.getPitch());
    camStore.setYaw(this.controller.getYaw());
    if (vp.fov !== undefined) camStore.setFov(vp.fov);
  }

  /** Live camera pose straight from the controller — used by viewpoint authoring so
   *  the saved target reflects exactly what the user is looking at, not the throttled
   *  ~6-frame-old debug-sync snapshot in the camera-store. */
  getLiveCameraPose(): { position: [number, number, number]; yaw: number; pitch: number; fov: number } {
    const p = this.camera.position;
    return {
      position: [p.x, p.y, p.z],
      yaw: this.controller.getYaw(),
      pitch: this.controller.getPitch(),
      fov: this.controller.getFov(),
    };
  }

  setMovementMode(m: MovementMode) { this.controller.setMovementMode(m); }
  setMoveSpeed(s: number) { this.controller.setMoveSpeed(s); }
  setFov(f: number) { this.controller.setFov(f); }
  setTouchJoystick(x: number, y: number) { this.controller.setTouchJoystick(x, y); }

  /** Snapshot the current camera pose. Used by the Debug 動画タブ. */
  getCurrentPose(): CameraPose | null {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const p = this.camera.position;
    return {
      position: [p.x, p.y, p.z],
      target: [p.x + dir.x, p.y + dir.y, p.z + dir.z],
      fov: this.camera.fov,
    };
  }

  /** Apply a saved pose immediately (no animation). */
  jumpToPose(pose: CameraPose): void {
    this.controller.jumpTo(pose.position, pose.target, pose.fov);
  }

  /** The host canvas. Used by the 動画タブ to attach a `MediaRecorder` via
   *  `canvas.captureStream()`. */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /** Capture the current camera view as a small JPEG data URL. The renderer is
   *  forced to draw immediately so the framebuffer holds the latest frame
   *  (renderer is initialised with `preserveDrawingBuffer: true` so toDataURL
   *  on the GL canvas is also valid; we go via a small 2D canvas regardless to
   *  resize). */
  async captureThumbnail(maxSize = 240): Promise<string | null> {
    try {
      this.renderer.render(this.scene, this.camera);
      return downscaleCanvasToJpeg(this.canvas, maxSize);
    } catch {
      return null;
    }
  }

  /** Animate the camera through `keyframes`. Each keyframe carries `durationSec`
   *  to the next (last is ignored). `startT` / `endT` optionally restrict
   *  playback to a sub-range (both in [0,1]). Suspends the controller's input
   *  RAF so user input doesn't fight the animation. */
  playCameraAnimation(
    keyframes: CameraKeyframe[],
    cb?: { onProgress?: (t: number) => void; onDone?: () => void; startT?: number; endT?: number },
  ): void {
    this.stopCameraAnimation();
    if (keyframes.length < 2) return;
    this.controller.suspendUpdate();
    const startT = Math.max(0, Math.min(1, cb?.startT ?? 0));
    const endT = Math.max(startT + 0.0001, Math.min(1, cb?.endT ?? 1));
    const startPose = interpolatePath(keyframes, startT) ?? keyframes[0].pose;
    this.controller.jumpTo(startPose.position, startPose.target, startPose.fov);
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
    };
    const tick = () => {
      const s = this.animState;
      if (!s) return;
      const elapsed = performance.now() - s.t0;
      const tLocal = Math.min(1, elapsed / s.totalMs);
      const tGlobal = s.startT + (s.endT - s.startT) * tLocal;
      const pose = interpolatePath(s.keyframes, tGlobal);
      if (pose) this.controller.jumpTo(pose.position, pose.target, pose.fov);
      s.onProgress?.(tLocal);
      if (tLocal >= 1) {
        const done = s.onDone;
        this.stopCameraAnimation();
        done?.();
        return;
      }
      this.animRafId = requestAnimationFrame(tick);
    };
    this.animRafId = requestAnimationFrame(tick);
  }

  stopCameraAnimation(): void {
    if (this.animRafId !== null) {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = null;
    }
    if (this.animState) {
      this.animState = null;
      this.controller.resumeUpdate();
    }
  }
  /** Demo mode head-tracking offset (degrees). Pure render overlay — does NOT touch
   *  saved viewpoint targets, mapYaw, or stored yaw/pitch. */
  setTrackingOffset(yawDeg: number, pitchDeg: number) { this.controller.setTrackingOffset(yawDeg, pitchDeg); }
  setPitchMaxUp(d: number) { this.controller.setPitchMaxUp(d); }
  setCurrentHeight(h: number) { this.controller.setCurrentHeight(h); }
  setZoomFovBounds(min: number, max: number) { this.controller.setZoomFovBounds(min, max); }
  setOnMoveSpeedChange(cb: ((s: number) => void) | null) { this.controller.setOnMoveSpeedChange(cb); }

  /** No-op placeholders — three engines don't yet implement these PlayCanvas-only flows. */
  async setActivePlan(_planId: string): Promise<void> { /* noop — TODO */ }
  setViewMode(_mode: 'splat' | '360') { /* noop — 360 mode not yet implemented in three */ }
  async applyActiveColor(): Promise<void> { /* noop — color variants not yet implemented */ }
  async setVariant(_f: 'on' | 'off', _l: 'day' | 'night'): Promise<void> { /* noop */ }
  setRenderMode(_m: 'default' | 'sharp' | 'highq') { /* preset is applied via applyRenderConfig */ }
  async setViewpointPanorama(_viewpointId: string, _dataUrl: string): Promise<void> { /* noop — 360 不対応 */ }
  async loadHdri(_dataUrl: string): Promise<boolean> { return false; /* noop — 360 不対応 */ }
  removeHdri(): void { /* noop — 360 不対応 */ }
  setHdriIntensity(_v: number) { /* noop — 360 不対応 */ }
  /** PlayCanvas SceneManager がカメラを最後にレンダリングした位置でフレームをキャプチャする
   *  機能の three.js 等価。ここでは renderer の preserveDrawingBuffer 経由でキャンバスを
   *  toDataURL して返すだけ。マニフェストへの保存は呼び出し側で行う。 */
  async captureCurrentFrameAsManualThumbnail(viewpointId: string): Promise<string | null> {
    try {
      // 強制レンダして最新フレームを反映させる。
      this.renderer.render(this.scene, this.camera);
      const dataUrl = this.canvas.toDataURL('image/jpeg', 0.86);
      const planId = useSceneStore.getState().activePlanId;
      if (planId) useSceneStore.getState().setViewpointManualThumbnail(planId, viewpointId, dataUrl);
      return dataUrl;
    } catch (err) {
      console.warn('three thumbnail capture failed:', err);
      return null;
    }
  }

  setSplatTransform(t: { rotation?: [number, number, number]; position?: [number, number, number] } | undefined) {
    if (!this.splatGroup) return;
    const rot = t?.rotation ?? [180, 0, 0];
    const pos = t?.position ?? [0, 0, 0];
    this.splatGroup.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]));
    this.splatGroup.position.set(pos[0], pos[1], pos[2]);
  }

  applyRenderConfig(cfg?: RenderQualityConfig | null) {
    if (!cfg) return;
    // Tone mapping was removed — neither mkkellogg's nor Spark's splat shaders honor
    // renderer.toneMapping (it would only affect the debug cube and background, never
    // the splats themselves). EffectComposer post-pass also doesn't work because
    // DropInViewer's internal sort target hijacks the composer's read buffer.
    if (cfg.exposureEV !== undefined) {
      const exp = Math.pow(2, cfg.exposureEV);
      this.renderer.toneMappingExposure = exp;
      // Spark only — apply RGBA multiply via SplatMesh.recolor so the splats brighten/darken.
      // mkkellogg has no equivalent and cannot respond to live exposure edits.
      if (this.engine === 'spark' && this.splatGroup) {
        (this.splatGroup as { recolor?: THREE.Color }).recolor = new THREE.Color(exp, exp, exp);
      }
    }
    if (cfg.clearColor !== undefined) {
      this.scene.background = new THREE.Color(cfg.clearColor[0], cfg.clearColor[1], cfg.clearColor[2]);
    }
  }

  async loadCollisionFromDataUrl(dataUrl: string, type: 'walkable' | 'block'): Promise<boolean> {
    return this.loadCollisionFromUrl(dataUrl, type);
  }
  /** PlayCanvas-side parity. Three's `loadCollisionFromUrl` already accepts
   *  data: / blob: / http URLs, so just resolve the manifest ref via the same
   *  resolver and forward. */
  async loadCollisionFromManifestRef(ref: string, type: 'walkable' | 'block'): Promise<boolean> {
    const sceneId = useSceneStore.getState().manifest?.id ?? '';
    const url = await resolveSplatUrl(ref, sceneId);
    return this.loadCollisionFromUrl(url, type);
  }

  setCollisionVisible(v: boolean) {
    if (this.collisionWalkable) this.collisionWalkable.visible = v;
    if (this.collisionBlock) this.collisionBlock.visible = v;
  }

  /** Debug XZ-plane grid (matches the PlayCanvas-side `setGridVisible`). 20×20 m. */
  private gridHelper: THREE.GridHelper | null = null;
  setGridVisible(v: boolean) {
    if (v && !this.gridHelper) {
      const grid = new THREE.GridHelper(20, 20, 0xc6c6d0, 0x707078);
      grid.position.y = 0;
      this.scene.add(grid);
      this.gridHelper = grid;
    } else if (!v && this.gridHelper) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      const m = this.gridHelper.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((mat) => mat.dispose()); else m.dispose();
      this.gridHelper = null;
    }
  }

  setCollisionOpacity(o: number) {
    const apply = (g: THREE.Object3D | null) => {
      if (!g) return;
      g.traverse((node) => {
        const m = (node as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m && 'opacity' in m) { m.opacity = o; m.needsUpdate = true; }
      });
    };
    apply(this.collisionWalkable);
    apply(this.collisionBlock);
  }

  /**
   * Format HUD inner HTML — main status line + colored FPS badge with the
   * recommended target. Called every ~333ms by the RAF loop in debug mode.
   * Color thresholds: ≥50 green / ≥30 amber / else red.
   */
  private formatHudHtml(statusText: string): string {
    const fps = this.currentFps();
    const fpsRounded = Math.round(fps);
    const target = 60;
    const fpsColor = fps >= 50 ? '#22c55e' : fps >= 30 ? '#fbbf24' : '#f87171';
    const head = `${this.engine.toUpperCase()} — ${statusText}`;
    return `
      <div>${escapeHtml(head)}</div>
      <div style="margin-top:4px; font-size:11px; font-weight:500; opacity:0.95">
        FPS <span style="color:${fpsColor}; font-weight:700">${fpsRounded || '—'}</span>
        <span style="opacity:0.7">/ ${target} 推奨</span>
      </div>
    `;
  }

  destroy() {
    this.stopCameraAnimation();
    if (this.hud && this.hud.parentElement) this.hud.parentElement.removeChild(this.hud);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    this.cleanups = [];
    try { this.controller.destroy(); } catch { /* ignore */ }
    if (this.splatGroup) {
      const dispose = (this.splatGroup as { dispose?: () => void | Promise<void> }).dispose;
      if (typeof dispose === 'function') { try { void dispose.call(this.splatGroup); } catch { /* ignore */ } }
    }
    try { this.renderer.dispose(); } catch { /* ignore */ }
    if (this.canvas.parentElement) this.canvas.parentElement.removeChild(this.canvas);
  }
}

/** Escape minimal HTML special chars so engine label / status text can't inject markup. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c] ?? c
  ));
}
