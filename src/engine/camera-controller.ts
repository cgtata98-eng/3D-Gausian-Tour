import { Entity, Vec3, math } from 'playcanvas';
import type { AppBase } from 'playcanvas';
import { raycastTriangles, type Triangle } from './mesh-raycaster';

/**
 * Movement model. Mirror of `ui-store.MovementMode` — kept here as a copy so the engine
 * layer doesn't depend on the React store types directly.
 */
export type MovementMode = 'walk' | 'fly';

export interface CameraControllerOptions {
  moveSpeed: number;
  lookSpeed: number;
  cameraHeight: number;
  heightStep: number;
  minHeight: number;
  maxHeight: number;
  /** Minimum FOV achievable via mouse-wheel zoom (most zoomed-in). */
  zoomFovMin: number;
  /** Maximum FOV achievable via mouse-wheel zoom (most zoomed-out). */
  zoomFovMax: number;
  /** Multiplier applied to FOV per wheel notch. <1 = zoom in, >1 = zoom out. */
  zoomStep: number;
  /** Multiplier applied to moveSpeed per wheel notch in 3DGS mode (>1 = faster, <1 = slower). */
  moveSpeedStep: number;
  /** Lower clamp for moveSpeed when adjusted via the wheel. */
  moveSpeedMin: number;
  /** Upper clamp for moveSpeed when adjusted via the wheel. */
  moveSpeedMax: number;
  /** Speed multiplier while Shift is held alongside WASD (sprint / run). */
  sprintMultiplier: number;
  /** Player capsule radius — block collision keeps the camera at least this far from walls. */
  capsuleRadius: number;
  /**
   * Fly mode only: meters of camera Y translation per mouse-drag pixel. Applied alongside
   * the pitch rotation so dragging the mouse upward both looks up AND raises the camera —
   * matches Arrival Space's "look up = also move up" navigation feel.
   */
  dragTranslateSpeed: number;
}

const DEFAULT_OPTIONS: CameraControllerOptions = {
  moveSpeed: 3.0,
  lookSpeed: 0.2,
  cameraHeight: 1.6,
  heightStep: 0.2,
  minHeight: -10,
  maxHeight: 10,
  zoomFovMin: 25,
  zoomFovMax: 100,
  zoomStep: 0.92,
  moveSpeedStep: 1.18,
  moveSpeedMin: 0.1,
  moveSpeedMax: 30,
  sprintMultiplier: 2.5,
  capsuleRadius: 0.3,
  dragTranslateSpeed: 0.01,
};

// ── Floor-snap tuning (walk mode) ───────────────────────────────────────────
// These affect ONLY the vertical (Y) floor-follow math. yaw / pitch / target /
// mapYaw are never read or written by the floor-snap code.
/** Probe origin height above the feet — catches small steps UP. */
const FLOOR_PROBE_UP = 0.6;
/** Probe reach below the feet — catches small steps DOWN. */
const FLOOR_PROBE_DOWN = 1.2;
/** Generous straight-down probe to (re)acquire the floor on mode-switch /
 *  collision-load / viewpoint-jump, where the eye may start well above the floor. */
const SNAP_PROBE_DOWN = 30;
/** Floor hits flatter than this in Y are rejected (vertical box faces / floater
 *  shells) so the player never snaps onto a wall or floater treated as "floor". */
const FLOOR_MIN_ABS_NORMAL_Y = 0.5;
/** Reject per-frame floor jumps larger than this (anti-teleport onto stray geometry). */
const FLOOR_STEP_MAX = 0.5;
/** Vertical damping factor per frame (anti-jitter on stepped voxel floors). */
const FLOOR_SNAP_LERP = 0.35;
/** Skip sub-centimetre corrections so a settled player doesn't micro-jitter. */
const FLOOR_SNAP_DEADBAND = 0.01;
/** Clamp range for derived eye-height-above-floor (human standing range). */
const EYE_HEIGHT_MIN = 0.3;
const EYE_HEIGHT_MAX = 3.0;
/** Upward probe reach used when the down-probe fails because the player is buried
 *  BELOW the floor surface (the floor is above the eye). */
const REACQUIRE_PROBE_UP = 3;

/**
 * First-person camera controller with mouse look, WASD movement, and two movement modes
 * (walk / fly). Walk follows the walkable collision floor; fly is free 6DoF. Both modes
 * respect block-collision walls when a block mesh is registered.
 */
export class CameraController {
  private app: AppBase;
  private entity: Entity;
  private options: CameraControllerOptions;

  private pitch = 0;
  private yaw = 0;
  /** Eye-level offset above the floor (walk) or absolute Y (fly). */
  private currentHeight: number;
  /** Last-used eye-level height while in walk mode. Restored on fly→walk so the
   *  camera drops back to standing height instead of staying at fly altitude. */
  private lastWalkHeight: number;
  private keys: Set<string> = new Set();
  private isLeftMouseDown = false;
  private movementLocked = false;
  private canvas: HTMLCanvasElement;
  /** Logical "player" position. The camera renders AT this. */
  private playerPos: Vec3;
  private movementMode: MovementMode = 'walk';
  /** Upper pitch clamp in degrees (0–89). Defaults to 89 (almost straight up). */
  private pitchMaxUp = 89;

  /** Pre-extracted world-space triangles for floor raycasting (walk mode). null = no floor. */
  private walkableTris: Triangle[] | null = null;
  /** Pre-extracted world-space triangles for wall collision (both modes). null = no walls. */
  private blockTris: Triangle[] | null = null;
  /** Last accepted floor Y, used as a prior for hit/miss hysteresis and step-jump
   *  rejection so the player can't teleport onto a stray box and doesn't jitter. */
  private lastFloorY: number | null = null;

  // For touch controls
  private lastTouchX = 0;
  private lastTouchY = 0;
  private touchActive = false;

  private updateHandler: ((dt: number) => void) | null = null;
  private cleanups: Array<() => void> = [];
  /** Notified whenever yaw/pitch changes due to user input (drag) — used for auto-saving the active viewpoint's pose. */
  private onLookInputChange: (() => void) | null = null;
  /** Notified when `moveSpeed` is changed by the wheel (so the debug slider can sync). */
  private onMoveSpeedChange: ((speed: number) => void) | null = null;

  /** Render-only head-tracking offset (degrees). Mirrors `ThreeCameraController` so
   *  `useDemoModeCamera` can drive either renderer. Stored yaw/pitch are not mutated. */
  private trackingYaw = 0;
  private trackingPitch = 0;

  // Gamepad — mirror of `ThreeCameraController`. Per-pad timestamp history is used to
  // pick the most-recently-active pad (handles ghost slots / drifting controllers).
  private padTsHistory = new Map<number, { ts: number; lastChange: number }>();
  // Last gamepad sample, captured once per `update()` so movement / rotation share it.
  private padFwd = 0;
  private padStrafe = 0;
  private padYaw = 0;
  private padPitch = 0;
  private padUp = 0;
  private padR2 = 0;
  // Mobile virtual joystick deltas in the same -1..1 convention as the gamepad.
  // Set externally by the on-screen joystick component (see ui/MobileJoystick.tsx).
  private touchFwd = 0;
  private touchStrafe = 0;
  // Edge-detect state for ✕/□ → moveSpeed step (mirrors wheel handler).
  private prevPadCross = false;
  private prevPadSquare = false;

  constructor(app: AppBase, camera: Entity, options?: Partial<CameraControllerOptions>) {
    this.app = app;
    this.entity = camera;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    this.currentHeight = this.options.cameraHeight;
    this.lastWalkHeight = this.options.cameraHeight;
    this.playerPos = this.entity.getPosition().clone();

    const euler = this.entity.getEulerAngles();
    this.pitch = euler.x;
    this.yaw = euler.y;

    this.setupMouseInput();
    this.setupKeyboardInput();
    this.setupTouchInput();
    this.setupWheelInput();
    this.setupUpdate();
  }

  /**
   * ホイール挙動はモード別:
   * - **360° (movementLocked)**: 既存の FOV ズーム — 範囲は `zoomFovMin..zoomFovMax`。
   * - **3DGS**: 移動速度 (moveSpeed) を上下。スクロールアップで速く、ダウンで遅く。
   *   Arrival Space の "wheel = walk speed" 方式。
   */
  private setupWheelInput() {
    this.addListener(this.canvas, 'wheel', ((e: WheelEvent) => {
      e.preventDefault();
      if (this.movementLocked) {
        const cam = this.entity.camera as { fov?: number } | null;
        if (!cam || typeof cam.fov !== 'number') return;
        const factor = e.deltaY < 0 ? this.options.zoomStep : 1 / this.options.zoomStep;
        const next = math.clamp(cam.fov * factor, this.options.zoomFovMin, this.options.zoomFovMax);
        if (Math.abs(next - cam.fov) < 0.05) return;
        cam.fov = next;
      } else {
        const factor = e.deltaY < 0 ? this.options.moveSpeedStep : 1 / this.options.moveSpeedStep;
        const next = math.clamp(this.options.moveSpeed * factor, this.options.moveSpeedMin, this.options.moveSpeedMax);
        if (Math.abs(next - this.options.moveSpeed) < 0.005) return;
        this.options.moveSpeed = next;
        this.onMoveSpeedChange?.(next);
      }
    }) as EventListener, { passive: false });
  }

  private addListener<K extends string>(target: EventTarget, type: K, fn: EventListener, options?: AddEventListenerOptions) {
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  private setupMouseInput() {
    this.addListener(this.canvas, 'mousedown', ((e: MouseEvent) => {
      if (e.button === 0) this.isLeftMouseDown = true;
    }) as EventListener);
    this.addListener(window, 'mouseup', ((e: MouseEvent) => {
      if (e.button === 0) this.isLeftMouseDown = false;
    }) as EventListener);
    this.addListener(this.canvas, 'mousemove', ((e: MouseEvent) => {
      if (!this.isLeftMouseDown) return;
      this.yaw -= e.movementX * this.options.lookSpeed;
      this.pitch -= e.movementY * this.options.lookSpeed;
      this.pitch = math.clamp(this.pitch, -89, this.pitchMaxUp);
      // フライモード: マウスを上下にドラッグすると視線方向 (pitch) だけでなくカメラ自体の Y も
      // 平行移動。Arrival Space のように「上を見ると上に進む」感覚にするため。歩くモードでは
      // 床追従が乱れるので適用しない。
      if (this.movementMode === 'fly') {
        this.playerPos.y += -e.movementY * this.options.dragTranslateSpeed;
        this.currentHeight = this.playerPos.y;
      }
      this.onLookInputChange?.();
    }) as EventListener);
  }

  private setupKeyboardInput() {
    // While the user is typing in a text field (e.g. naming a viewpoint), don't accumulate
    // movement keys — otherwise WASD would slide the camera while editing labels.
    const isTypingTarget = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || !!(t && t.isContentEditable);
    };
    this.addListener(window, 'keydown', ((e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      this.keys.add(e.code);
    }) as EventListener);
    this.addListener(window, 'keyup', ((e: KeyboardEvent) => { this.keys.delete(e.code); }) as EventListener);
  }

  /** 2 本指の距離。ピンチの倍率を出すのに使う。 */
  private pinchDist = 0;

  /**
   * ピンチで画角 (FOV) を変える。
   *
   * スマホにはホイールが無いので、寄り引きの手段がここしかない。ホイールと違って
   * **モードで挙動を変えない** ― 3DGS でホイールが歩行速度を変えるのは、動かしながら
   * 何度も回せる入力だから成り立つ話で、指では「寄りたい」以外の意図がまず無い。
   */
  private applyPinch(e: TouchEvent): void {
    const a = e.touches[0];
    const b = e.touches[1];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (this.pinchDist <= 0) { this.pinchDist = dist; return; }
    const cam = this.entity.camera as { fov?: number } | null;
    if (!cam || typeof cam.fov !== 'number') { this.pinchDist = dist; return; }
    // 指を広げる = 寄る = FOV を小さく。距離の比をそのまま倍率にすると、
    // どの画角からでも同じ手の動きで同じだけ寄れる。
    const ratio = this.pinchDist / Math.max(1, dist);
    const next = math.clamp(cam.fov * ratio, this.options.zoomFovMin, this.options.zoomFovMax);
    this.pinchDist = dist;
    if (Math.abs(next - cam.fov) < 0.01) return;
    cam.fov = next;
    this.onLookInputChange?.();
  }

  private setupTouchInput() {
    this.addListener(this.canvas, 'touchstart', ((e: TouchEvent) => {
      if (e.touches.length >= 2) {
        // 2 本目が触れた時点で見回しは止める。片方の指の移動が回転として
        // 拾われると、寄せている最中に画がぐるっと回る。
        this.touchActive = false;
        this.pinchDist = 0;
        return;
      }
      if (e.touches.length === 1) {
        this.touchActive = true;
        this.lastTouchX = e.touches[0].clientX;
        this.lastTouchY = e.touches[0].clientY;
      }
    }) as EventListener);
    this.addListener(this.canvas, 'touchmove', ((e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        this.applyPinch(e);
        return;
      }
      if (!this.touchActive || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - this.lastTouchX;
      const dy = e.touches[0].clientY - this.lastTouchY;
      this.lastTouchX = e.touches[0].clientX;
      this.lastTouchY = e.touches[0].clientY;
      this.yaw -= dx * this.options.lookSpeed;
      this.pitch -= dy * this.options.lookSpeed;
      this.pitch = math.clamp(this.pitch, -89, this.pitchMaxUp);
      // フライモードはマウスドラッグと同様に Y 方向の平行移動も加える。
      if (this.movementMode === 'fly') {
        this.playerPos.y += -dy * this.options.dragTranslateSpeed;
        this.currentHeight = this.playerPos.y;
      }
      this.onLookInputChange?.();
    }) as EventListener, { passive: false });
    const endTouch = ((e: TouchEvent) => {
      this.touchActive = false;
      this.pinchDist = 0;
      // 指が 1 本残ったら、そこを新しい起点にする。前の座標のままだと、
      // 離した瞬間に画面が飛ぶ。
      if (e.touches.length === 1) {
        this.touchActive = true;
        this.lastTouchX = e.touches[0].clientX;
        this.lastTouchY = e.touches[0].clientY;
      }
    }) as EventListener;
    this.addListener(this.canvas, 'touchend', endTouch);
    this.addListener(this.canvas, 'touchcancel', endTouch);
  }

  private setupUpdate() {
    this.updateHandler = (dt: number) => { this.update(dt); };
    this.app.on('update', this.updateHandler);
  }

  getPitch(): number { return this.pitch; }
  getYaw(): number { return this.yaw; }
  getFov(): number { return (this.entity.camera as { fov?: number } | undefined)?.fov ?? 60; }
  getMoveSpeed(): number { return this.options.moveSpeed; }
  setMoveSpeed(speed: number) { this.options.moveSpeed = speed; }
  /** Mobile / touch on-screen joystick input. `x` and `y` are normalised to -1..1
   *  where +x = right strafe, -y = forward (the screen-up-is-forward convention). */
  setTouchJoystick(x: number, y: number) {
    this.touchStrafe = x;
    this.touchFwd = -y;
  }
  setFov(fov: number) { if (this.entity.camera) (this.entity.camera as { fov: number }).fov = fov; }
  /** Demo-mode head-tracking offset (degrees). Render-only. */
  setTrackingOffset(yawDeg: number, pitchDeg: number) {
    this.trackingYaw = yawDeg;
    this.trackingPitch = pitchDeg;
  }
  /** When locked, suppress WASD / Q-E translation. Mouse look continues. Used by 360° viewpoint mode. */
  setMovementLocked(locked: boolean) { this.movementLocked = locked; }
  /** Clamp the upward pitch limit (used in 360 to stop the user looking past the panorama's top). */
  setPitchMaxUp(deg: number) {
    this.pitchMaxUp = math.clamp(deg, 0, 89);
    if (this.pitch > this.pitchMaxUp) this.pitch = this.pitchMaxUp;
  }
  /** Update wheel-zoom bounds and clamp the current FOV into the new range. */
  setZoomFovBounds(min: number, max: number) {
    if (max <= min) return;
    this.options.zoomFovMin = min;
    this.options.zoomFovMax = max;
    const cam = this.entity.camera as { fov?: number } | null;
    if (cam && typeof cam.fov === 'number') {
      const clamped = math.clamp(cam.fov, min, max);
      if (clamped !== cam.fov) cam.fov = clamped;
    }
  }
  /** Register a callback fired whenever the user drags to change yaw/pitch (NOT for jumpTo / setYaw). */
  setOnLookInputChange(cb: (() => void) | null) {
    this.onLookInputChange = cb;
  }
  /** Register a callback fired whenever the wheel adjusts moveSpeed (3DGS mode). */
  setOnMoveSpeedChange(cb: ((speed: number) => void) | null) {
    this.onMoveSpeedChange = cb;
  }
  /** Directly set yaw (degrees). Used by the floor-plan editor's direction slider for live preview. */
  setYaw(deg: number) {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    this.yaw = d;
    this.applyPose();
  }
  /** Directly set pitch (degrees), clamped to the configured range. */
  setPitch(deg: number) {
    this.pitch = math.clamp(deg, -89, this.pitchMaxUp);
    this.applyPose();
  }
  /** Directly place the player at an absolute eye position. Used by mirror-receive,
   *  where poses stream in from another tab: writing the entity position alone is not
   *  enough — the next `applyPose()` (from setYaw/setPitch) would snap the entity back
   *  to the stale internal `playerPos`, so the logical position must move too.
   *  currentHeight is mode-aware: in fly it IS the absolute Y (mirror the drag-translate
   *  convention); in walk it's eye-height-above-floor, so the pre-mirror standing height
   *  is kept — writing the absolute Y there would launch/sink the camera the moment
   *  mirroring turns off and the floor-follow eases toward floorY + currentHeight. */
  setPlayerPosition(x: number, y: number, z: number) {
    this.playerPos.set(x, y, z);
    if (this.movementMode === 'fly') this.currentHeight = y;
    this.applyPose();
  }
  /** Immediately set the camera's eye-level height. Used for live "initial height" tweaks in debug. */
  setCurrentHeight(h: number) {
    this.currentHeight = math.clamp(h, this.options.minHeight, this.options.maxHeight);
    if (this.movementMode === 'fly') this.playerPos.y = this.currentHeight;
    this.applyPose();
  }
  getCurrentHeight(): number { return this.currentHeight; }
  setMovementMode(mode: MovementMode) {
    if (this.movementMode === mode) return;
    // Leaving walk: remember the eye-level so fly→walk later restores it instead of
    // inheriting the fly absolute Y (which made the camera "float" at sky height).
    if (this.movementMode === 'walk') this.lastWalkHeight = this.currentHeight;
    this.movementMode = mode;
    if (mode === 'walk') {
      this.currentHeight = this.lastWalkHeight;
      if (this.walkableTris) {
        this.snapToFloor();
      } else {
        // No floor mesh: assume floor at y=0 and drop the player to walking eye level.
        this.playerPos.y = this.currentHeight;
      }
    }
    this.applyPose();
  }
  getMovementMode(): MovementMode { return this.movementMode; }
  /** Returns a copy of the logical player position. */
  getPlayerPosition(): Vec3 { return this.playerPos.clone(); }

  /** Register the walkable collision mesh (extracted to triangles). Pass null to clear. */
  setWalkableTriangles(tris: Triangle[] | null) {
    this.walkableTris = (tris && tris.length > 0) ? tris : null;
    // A different mesh invalidates the step-clamp history — otherwise a floor at a
    // different Y (plan switch) is rejected forever as a ">0.5 m step".
    this.lastFloorY = null;
    // Collision loads async (after the initial jumpTo), so re-derive the spawn
    // eye-height now that we actually know where the floor is. No-op in fly mode.
    if (this.walkableTris) this.reacquireFloorHeight();
  }
  /** Register the block (wall) collision mesh. Pass null to clear. */
  setBlockTriangles(tris: Triangle[] | null) {
    this.blockTris = (tris && tris.length > 0) ? tris : null;
  }

  private update(dt: number) {
    this.pollGamepad();
    if (!this.movementLocked) {
      // Right stick → yaw / pitch (in addition to mouse drag). Both axes inverted
      // (push-up looks up, push-right turns right). Mirrors `ThreeCameraController`.
      const turnRate = 90; // deg/sec at full stick deflection
      this.yaw -= this.padYaw * turnRate * dt;
      this.pitch -= this.padPitch * (turnRate * 0.7) * dt;
      this.pitch = math.clamp(this.pitch, -89, this.pitchMaxUp);
      if (Math.abs(this.padYaw) > 0.001 || Math.abs(this.padPitch) > 0.001) {
        this.onLookInputChange?.();
      }

      const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      // R2 analog → 1× → 5× boost (matches Three controller / gs.html). Stacks with Shift sprint.
      const padBoost = 1 + this.padR2 * 4;
      const speedMul = (sprinting ? this.options.sprintMultiplier : 1) * padBoost;
      const speed = this.options.moveSpeed * speedMul * dt;

      if (this.movementMode === 'walk') {
        this.updateWalk(dt, speed);
      } else {
        this.updateFly(speed);
      }
    }

    this.applyPose();
  }

  /** Sample the active gamepad, mirroring `ThreeCameraController.pollGamepad` so a
   *  ghost pad slot (no axes/buttons changing) doesn't override the real one. */
  private pollGamepad() {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    const valid = [...gps].filter((g): g is Gamepad => !!g);
    if (valid.length === 0) {
      this.padFwd = this.padStrafe = this.padYaw = this.padPitch = this.padUp = this.padR2 = 0;
      return;
    }
    const now = performance.now();
    for (const g of valid) {
      const prev = this.padTsHistory.get(g.index);
      if (!prev || prev.ts !== g.timestamp) this.padTsHistory.set(g.index, { ts: g.timestamp, lastChange: now });
    }
    const standardLive = valid.find((g) => g.mapping === 'standard'
      && (now - (this.padTsHistory.get(g.index)?.lastChange ?? 0)) < 500);
    const live = valid.find((g) => (now - (this.padTsHistory.get(g.index)?.lastChange ?? 0)) < 500);

    // Live-only: ignore pads that haven't reported a timestamp change in the last 500 ms.
    // Modern browsers update `Gamepad.timestamp` every poll while a stick is held, so
    // held-input still works. This filters out phantom slots and drifting sticks.
    const pad = standardLive ?? live;
    if (!pad) {
      this.padFwd = this.padStrafe = this.padYaw = this.padPitch = this.padUp = this.padR2 = 0;
      return;
    }

    // 0.20 deadzone — PS5/Xbox sticks at rest typically report < 0.1, so this filters drift.
    const dz = (v: number, d = 0.20) => Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d) / (1 - d);
    this.padStrafe = dz(pad.axes[0] ?? 0);          // left stick X
    this.padFwd    = -dz(pad.axes[1] ?? 0);         // left stick Y (up = forward)
    this.padYaw    = dz(pad.axes[2] ?? 0);          // right stick X
    this.padPitch  = dz(pad.axes[3] ?? 0);          // right stick Y
    this.padUp     = ((pad.buttons[12]?.pressed ? 1 : 0) - (pad.buttons[13]?.pressed ? 1 : 0)); // D-pad ↑/↓
    this.padR2     = pad.buttons[7]?.value ?? 0;    // R2 analog

    // ✕ / □ edge → moveSpeed step. Same factor / clamp / notify path as the wheel
    // handler so the Debug slider stays in sync. One step per press (no auto-repeat).
    const cross = pad.buttons[0]?.pressed ?? false;
    const square = pad.buttons[2]?.pressed ?? false;
    if (cross && !this.prevPadCross) this.stepMoveSpeed(this.options.moveSpeedStep);
    if (square && !this.prevPadSquare) this.stepMoveSpeed(1 / this.options.moveSpeedStep);
    this.prevPadCross = cross;
    this.prevPadSquare = square;
  }

  /** Multiply current moveSpeed by `factor`, clamp to [moveSpeedMin, moveSpeedMax],
   *  and notify listeners. Shared by the wheel handler and ✕/□ buttons. */
  private stepMoveSpeed(factor: number) {
    const next = math.clamp(this.options.moveSpeed * factor, this.options.moveSpeedMin, this.options.moveSpeedMax);
    if (Math.abs(next - this.options.moveSpeed) < 0.005) return;
    this.options.moveSpeed = next;
    this.onMoveSpeedChange?.(next);
  }

  /** Walk mode: WASD on the horizontal plane (yaw only), Q/E adjust eye level above the floor.
   *  キー割当: **Q = 上 / E = 下**。Shift 同時押しで `sprintMultiplier` 倍速 (WASD と同じ感覚)。 */
  private updateWalk(dt: number, speed: number) {
    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const heightSpeed = this.options.heightStep * dt * 3 * (sprinting ? this.options.sprintMultiplier : 1);
    if (this.keys.has('KeyQ')) {
      this.currentHeight = Math.min(this.currentHeight + heightSpeed, this.options.maxHeight);
    }
    if (this.keys.has('KeyE')) {
      this.currentHeight = Math.max(this.currentHeight - heightSpeed, this.options.minHeight);
    }

    const yawRad = this.yaw * Math.PI / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rgtX = Math.cos(yawRad);
    const rgtZ = -Math.sin(yawRad);

    // Stack keyboard + left-stick analog. Magnitude clamps to 1 below so diagonals
    // don't outrun straight motion when both keys and stick agree.
    const fwdAmt    = ((this.keys.has('KeyW') || this.keys.has('ArrowUp'))    ? 1 : 0)
                    - ((this.keys.has('KeyS') || this.keys.has('ArrowDown'))  ? 1 : 0)
                    + this.padFwd + this.touchFwd;
    const strafeAmt = ((this.keys.has('KeyD') || this.keys.has('ArrowRight')) ? 1 : 0)
                    - ((this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  ? 1 : 0)
                    + this.padStrafe + this.touchStrafe;
    let mx = fwdX * fwdAmt + rgtX * strafeAmt;
    let mz = fwdZ * fwdAmt + rgtZ * strafeAmt;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }
    mx *= speed; mz *= speed;

    const blocked = this.applyBlockCollision(mx, 0, mz);
    this.playerPos.x += blocked.x;
    this.playerPos.z += blocked.z;

    // D-pad ↑/↓ height adjust (same step rate as Q/E keys).
    if (this.padUp > 0) this.currentHeight = Math.min(this.currentHeight + heightSpeed, this.options.maxHeight);
    if (this.padUp < 0) this.currentHeight = Math.max(this.currentHeight - heightSpeed, this.options.minHeight);

    // Floor follow: probe down for the walkable surface, then EASE the eye toward
    // floor + eye-height. Damped (not a hard snap) with a step-jump reject + hit/miss
    // hysteresis so the player can't teleport onto a stray box/floater and doesn't
    // jitter on a stepped voxel floor. Y only — yaw/pitch/target untouched.
    if (this.walkableTris) {
      const raw = this.raycastFloor(this.playerPos.x, this.playerPos.z);
      const accepted = (raw !== null
        && (this.lastFloorY === null || Math.abs(raw - this.lastFloorY) <= FLOOR_STEP_MAX))
        ? raw : null;
      if (accepted !== null) this.lastFloorY = accepted;
      const base = accepted ?? this.lastFloorY;
      if (base !== null) {
        const targetY = base + this.currentHeight;
        const dy = targetY - this.playerPos.y;
        if (Math.abs(dy) > FLOOR_SNAP_DEADBAND) this.playerPos.y += dy * FLOOR_SNAP_LERP;
      }
      // Floor never acquired yet → hold the current Y until a probe succeeds.
      // (Writing `currentHeight` as an ABSOLUTE Y here teleported the player into
      // the air / underground, since in walk mode it's an eye-height offset.)
    } else {
      this.playerPos.y = this.currentHeight;
    }
  }

  /** Fly mode: WASD along camera forward (pitch-aware), Q/E for vertical world movement. */
  private updateFly(speed: number) {
    const yawRad = this.yaw * Math.PI / 180;
    const pitchRad = this.pitch * Math.PI / 180;
    const cosP = Math.cos(pitchRad);
    const fwdX = -Math.sin(yawRad) * cosP;
    const fwdY = Math.sin(pitchRad);
    const fwdZ = -Math.cos(yawRad) * cosP;
    const rgtX = Math.cos(yawRad);
    const rgtZ = -Math.sin(yawRad);

    // Stack keyboard + left-stick analog (and D-pad ↑/↓ for vertical). Magnitude clamps
    // to 1 below so diagonals don't outrun straight motion.
    const fwdAmt    = ((this.keys.has('KeyW') || this.keys.has('ArrowUp'))    ? 1 : 0)
                    - ((this.keys.has('KeyS') || this.keys.has('ArrowDown'))  ? 1 : 0)
                    + this.padFwd + this.touchFwd;
    const strafeAmt = ((this.keys.has('KeyD') || this.keys.has('ArrowRight')) ? 1 : 0)
                    - ((this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  ? 1 : 0)
                    + this.padStrafe + this.touchStrafe;
    const upAmt     = ((this.keys.has('KeyQ')) ? 1 : 0)
                    - ((this.keys.has('KeyE')) ? 1 : 0)
                    + this.padUp;
    let mx = fwdX * fwdAmt + rgtX * strafeAmt;
    let my = fwdY * fwdAmt + upAmt;
    let mz = fwdZ * fwdAmt + rgtZ * strafeAmt;
    const mag = Math.hypot(mx, my, mz);
    if (mag > 1) { mx /= mag; my /= mag; mz /= mag; }
    mx *= speed; my *= speed; mz *= speed;

    const blocked = this.applyBlockCollision(mx, my, mz);
    this.playerPos.x += blocked.x;
    this.playerPos.y += blocked.y;
    this.playerPos.z += blocked.z;
    this.currentHeight = this.playerPos.y;
  }

  /**
   * Stop just before a wall: cast a ray from the player in the move direction; if the
   * hit distance is less than the move + capsule radius, clip the move so the camera
   * stops `capsuleRadius` away from the surface. Crude (no slide along the wall) but
   * predictable and cheap.
   */
  private applyBlockCollision(mx: number, my: number, mz: number): { x: number; y: number; z: number } {
    if (!this.blockTris) return { x: mx, y: my, z: mz };
    const len = Math.hypot(mx, my, mz);
    if (len < 1e-6) return { x: 0, y: 0, z: 0 };
    const dx = mx / len, dy = my / len, dz = mz / len;
    const r = this.options.capsuleRadius;
    const hit = raycastTriangles(this.playerPos.x, this.playerPos.y, this.playerPos.z, dx, dy, dz, this.blockTris, len + r);
    if (!hit) return { x: mx, y: my, z: mz };
    const safe = Math.max(0, hit.t - r);
    return { x: dx * safe, y: dy * safe, z: dz * safe };
  }

  /**
   * Resolve the floor Y at a given XZ, used for per-frame floor-snap during walk.
   *
   * The walkable mesh comes from splat-transform's carve recipe, which produces a
   * 3D NAVIGABLE VOLUME (not a flat surface): it leaks through wall gaps into
   * adjacent rooms, picks up floater bubbles at random Y, and has voxel-stepped /
   * multi-level floors. A naive nearest-hit down-ray snaps onto whichever surface
   * is closest — often a floater or a vertical box face — and teleports the player.
   *
   * Strategy: cast DOWN from just above the FEET (not the drifting eye) over a short
   * window, and require a near-horizontal hit (|normal.y| ≥ FLOOR_MIN_ABS_NORMAL_Y)
   * so box sides / floater shells are skipped and the real floor is found. Returns
   * null when nothing floor-like is within range (caller holds the last floor).
   */
  private raycastFloor(x: number, z: number): number | null {
    if (!this.walkableTris) return null;
    const feetY = this.playerPos.y - this.currentHeight;
    const start = feetY + FLOOR_PROBE_UP;
    const hit = raycastTriangles(
      x, start, z, 0, -1, 0, this.walkableTris,
      FLOOR_PROBE_UP + FLOOR_PROBE_DOWN, FLOOR_MIN_ABS_NORMAL_Y,
    );
    return hit ? hit.point.y : null;
  }

  /** When entering walk mode from fly, drop the player onto the walkable floor.
   *  Uses a generous straight-down probe from the current eye (the player may be
   *  high up in fly) and requires a horizontal hit. */
  private snapToFloor() {
    if (!this.walkableTris) return;
    const hit = raycastTriangles(
      this.playerPos.x, this.playerPos.y, this.playerPos.z, 0, -1, 0,
      this.walkableTris, SNAP_PROBE_DOWN, FLOOR_MIN_ABS_NORMAL_Y,
    );
    if (hit) {
      this.lastFloorY = hit.point.y;
      this.playerPos.y = hit.point.y + this.currentHeight;
    }
  }

  /**
   * (Re)derive eye-height-above-floor from an absolute-Y prior. Called when the
   * walkable mesh (re)arrives — collision loads async, after the initial jumpTo —
   * and from jumpTo when the mesh is already present. Casts down from the current
   * eye and sets currentHeight = clamp(eyeY − floorY) so the first frame lands the
   * eye at floor + a sane standing height regardless of the scene's absolute floor
   * Y (which a collision regen can shift). Prevents launch-into-air / sink-underground.
   */
  private reacquireFloorHeight() {
    if (!this.walkableTris || this.movementMode !== 'walk') return;
    const down = raycastTriangles(
      this.playerPos.x, this.playerPos.y, this.playerPos.z, 0, -1, 0,
      this.walkableTris, SNAP_PROBE_DOWN, FLOOR_MIN_ABS_NORMAL_Y,
    );
    // Buried-player recovery: if the down-probe misses, the floor surface may be
    // ABOVE the eye (regen shifted the floor up / authored Y sits under it). A
    // short UP-probe finds it so the player pops back out instead of staying sunk.
    const hit = down ?? raycastTriangles(
      this.playerPos.x, this.playerPos.y, this.playerPos.z, 0, 1, 0,
      this.walkableTris, REACQUIRE_PROBE_UP, FLOOR_MIN_ABS_NORMAL_Y,
    );
    if (!hit) return;
    // Floor below → derive eye height from the prior. Floor ABOVE (buried) → the
    // prior is meaningless, reset to the standard standing height.
    this.currentHeight = down
      ? math.clamp(this.playerPos.y - hit.point.y, EYE_HEIGHT_MIN, EYE_HEIGHT_MAX)
      : this.options.cameraHeight;
    this.lastFloorY = hit.point.y;
    this.playerPos.y = hit.point.y + this.currentHeight;
    this.applyPose();
  }

  /** Apply orientation from yaw/pitch and position. Demo-mode tracking offset is added
   *  here only — `this.yaw` / `this.pitch` themselves stay untouched so saved viewpoint
   *  targets and `mapYaw` are never disturbed. */
  private applyPose() {
    const renderPitch = math.clamp(this.pitch + this.trackingPitch, -89, this.pitchMaxUp);
    const renderYaw = this.yaw + this.trackingYaw;
    this.entity.setEulerAngles(renderPitch, renderYaw, 0);
    this.entity.setPosition(this.playerPos);
  }

  /** Jump the player to a viewpoint and orient the camera toward `target`. */
  jumpTo(position: [number, number, number], target: [number, number, number], fov?: number) {
    this.playerPos.set(position[0], position[1], position[2]);
    // Teleporting invalidates the step-clamp history (the destination floor may
    // legitimately sit at a very different Y).
    this.lastFloorY = null;
    // Walk mode treats currentHeight as eye-height ABOVE the floor, not absolute Y.
    // Seed it with the authored absolute Y, then (if the walkable mesh is loaded)
    // re-derive it from the floor below so off-origin scans / regen-shifted floors
    // don't launch or sink the player. Fly mode keeps absolute Y.
    this.currentHeight = position[1];
    if (this.movementMode === 'walk' && this.walkableTris) this.reacquireFloorHeight();

    const dx = target[0] - position[0];
    const dy = target[1] - position[1];
    const dz = target[2] - position[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-6) {
      const fx = dx / len;
      const fy = dy / len;
      const fz = dz / len;
      const RAD2DEG = 180 / Math.PI;
      this.pitch = math.clamp(Math.asin(fy) * RAD2DEG, -89, this.pitchMaxUp);
      this.yaw = Math.atan2(-fx, -fz) * RAD2DEG;
    }

    if (fov && this.entity.camera) {
      (this.entity.camera as { fov: number }).fov = fov;
    }

    this.applyPose();
  }

  destroy() {
    if (this.updateHandler) {
      this.app.off('update', this.updateHandler);
      this.updateHandler = null;
    }
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
  }
}
