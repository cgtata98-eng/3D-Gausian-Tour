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
  minHeight: 0.3,
  maxHeight: 5.0,
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

  private setupTouchInput() {
    this.addListener(this.canvas, 'touchstart', ((e: TouchEvent) => {
      if (e.touches.length === 1) {
        this.touchActive = true;
        this.lastTouchX = e.touches[0].clientX;
        this.lastTouchY = e.touches[0].clientY;
      }
    }) as EventListener);
    this.addListener(this.canvas, 'touchmove', ((e: TouchEvent) => {
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
    this.addListener(this.canvas, 'touchend', (() => { this.touchActive = false; }) as EventListener);
  }

  private setupUpdate() {
    this.updateHandler = (dt: number) => { this.update(dt); };
    this.app.on('update', this.updateHandler);
  }

  getPitch(): number { return this.pitch; }
  getYaw(): number { return this.yaw; }
  getFov(): number { return (this.entity.camera as any)?.fov ?? 60; }
  getMoveSpeed(): number { return this.options.moveSpeed; }
  setMoveSpeed(speed: number) { this.options.moveSpeed = speed; }
  /** Mobile / touch on-screen joystick input. `x` and `y` are normalised to -1..1
   *  where +x = right strafe, -y = forward (the screen-up-is-forward convention). */
  setTouchJoystick(x: number, y: number) {
    this.touchStrafe = x;
    this.touchFwd = -y;
  }
  setFov(fov: number) { if (this.entity.camera) (this.entity.camera as any).fov = fov; }
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

    // Floor follow: drop a ray straight down from above the player and snap onto the
    // walkable surface. If no floor mesh is registered the player just stays at
    // currentHeight (legacy behavior preserved).
    if (this.walkableTris) {
      const floorY = this.raycastFloor(this.playerPos.x, this.playerPos.z);
      this.playerPos.y = (floorY ?? this.playerPos.y - this.currentHeight) + this.currentHeight;
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
   * Resolve the floor Y at a given XZ, used for floor-snap during walk mode.
   *
   * The walkable mesh comes from splat-transform's carve recipe, which
   * produces a 3D NAVIGABLE VOLUME (not a flat surface). Carved volumes can
   * be wildly irregular — they leak through wall gaps into adjacent rooms,
   * pick up floater bubbles at random Y, and have multi-level floors. Naive
   * ray-down-from-50m or ray-up-from-50m hits whichever surface happens to
   * be closest in either direction, which on irregular meshes teleports
   * the player to ceiling height or to a far-away floater.
   *
   * Strategy: trust the player's current Y as a prior. The floor must be
   * within walking-step distance directly below them. Cast DOWN from just
   * above the player, capped at 3 m — that's enough to catch a real step
   * down but not enough to reach a leaked-through floater. If nothing's
   * within that range, return null (don't snap, keep current Y).
   */
  private raycastFloor(x: number, z: number): number | null {
    if (!this.walkableTris) return null;
    const start = this.playerPos.y;
    const hit = raycastTriangles(x, start, z, 0, -1, 0, this.walkableTris, 3);
    return hit ? hit.point.y : null;
  }

  /** When entering walk mode from fly, drop the player onto the walkable floor. */
  private snapToFloor() {
    if (!this.walkableTris) return;
    const floorY = this.raycastFloor(this.playerPos.x, this.playerPos.z);
    if (floorY !== null) this.playerPos.y = floorY + this.currentHeight;
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
    this.currentHeight = position[1];

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
