import * as THREE from 'three';
import type { ThreeTriangle } from './three-mesh-raycaster';
import { raycastThreeTriangles } from './three-mesh-raycaster';

/** Movement model. Mirror of the PlayCanvas-side `MovementMode`. */
export type MovementMode = 'walk' | 'fly';

export interface ThreeCameraOptions {
  moveSpeed: number;
  lookSpeed: number;
  cameraHeight: number;
  heightStep: number;
  minHeight: number;
  maxHeight: number;
  zoomFovMin: number;
  zoomFovMax: number;
  zoomStep: number;
  /** Wheel-controlled moveSpeed bounds + multiplier (3DGS only). */
  moveSpeedStep: number;
  moveSpeedMin: number;
  moveSpeedMax: number;
  sprintMultiplier: number;
  capsuleRadius: number;
  /** Fly-mode mouse Y-drag → camera Y translation, m per pixel. */
  dragTranslateSpeed: number;
}

const DEFAULT: ThreeCameraOptions = {
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
 * Port of `engine/camera-controller.ts` to three.js. Walk / fly modes with floor
 * follow and block collision via mesh raycasts. Same key bindings as the PlayCanvas
 * version: WASD / arrows for horizontal, Q = up / E = down, Shift = sprint, mouse
 * drag for look (in fly mode also translates Y), wheel adjusts moveSpeed in 3DGS
 * mode (and FOV in locked / 360 mode).
 */
export class ThreeCameraController {
  readonly camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private opts: ThreeCameraOptions;

  private pitch = 0;
  private yaw = 0;
  private currentHeight: number;
  /** Last-used eye-level height while in walk mode. Restored on fly→walk so the
   *  camera drops back to standing height instead of staying at fly altitude. */
  private lastWalkHeight: number;
  private playerPos = new THREE.Vector3(0, 0, 0);
  private mode: MovementMode = 'walk';
  private movementLocked = false;
  private pitchMaxUp = 89;

  private keys = new Set<string>();
  private isLeftMouseDown = false;
  private cleanups: Array<() => void> = [];
  private rafId: number | null = null;
  private lastFrameTs = 0;

  private walkableTris: ThreeTriangle[] | null = null;
  private blockTris: ThreeTriangle[] | null = null;

  private onLookInputChange: (() => void) | null = null;
  private onMoveSpeedChange: ((s: number) => void) | null = null;

  // Demo / head-tracking offsets — added on top of `yaw` / `pitch` only at render
  // time so saved viewpoints, the floor-plan cone (`mapYaw`), and stored target
  // values are never mutated. WASD direction also follows the combined yaw so the
  // camera moves where the user is looking, mirroring the Xrealtracking PoC.
  private trackingYaw = 0;
  private trackingPitch = 0;

  // Gamepad — most-recently-active pad index (handles ghost / extra slots).
  private padTsHistory = new Map<number, { ts: number; lastChange: number }>();
  // Last gamepad sample, captured once per `update()` so movement / rotation share it.
  private padFwd = 0;
  private padStrafe = 0;
  private padYaw = 0;
  private padPitch = 0;
  private padUp = 0;
  private padR2 = 0;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, opts?: Partial<ThreeCameraOptions>) {
    this.camera = camera;
    this.canvas = canvas;
    this.opts = { ...DEFAULT, ...opts };
    this.currentHeight = this.opts.cameraHeight;
    this.lastWalkHeight = this.opts.cameraHeight;
    this.playerPos.copy(camera.position);

    this.setupMouse();
    this.setupKeyboard();
    this.setupWheel();
    this.setupTouch();
    this.startRAF();
  }

  // ── Public API (mirror of PlayCanvas CameraController) ──

  setMoveSpeed(s: number) { this.opts.moveSpeed = s; }
  getMoveSpeed() { return this.opts.moveSpeed; }
  setFov(fov: number) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  getFov() { return this.camera.fov; }
  setMovementLocked(v: boolean) { this.movementLocked = v; }
  setPitchMaxUp(deg: number) {
    this.pitchMaxUp = THREE.MathUtils.clamp(deg, 0, 89);
    if (this.pitch > this.pitchMaxUp) this.pitch = this.pitchMaxUp;
  }
  setZoomFovBounds(min: number, max: number) {
    if (max <= min) return;
    this.opts.zoomFovMin = min; this.opts.zoomFovMax = max;
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov, min, max);
    this.camera.updateProjectionMatrix();
  }
  setOnLookInputChange(cb: (() => void) | null) { this.onLookInputChange = cb; }
  setOnMoveSpeedChange(cb: ((s: number) => void) | null) { this.onMoveSpeedChange = cb; }

  /** Set head-tracking offset (degrees). Pure overlay — does NOT mutate stored
   *  yaw/pitch or any saved viewpoint data. Pass 0/0 to disable. */
  setTrackingOffset(yawDeg: number, pitchDeg: number) {
    this.trackingYaw = yawDeg;
    this.trackingPitch = pitchDeg;
  }
  setYaw(deg: number) {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    this.yaw = d;
    this.applyPose();
  }
  setPitch(deg: number) {
    this.pitch = THREE.MathUtils.clamp(deg, -89, this.pitchMaxUp);
    this.applyPose();
  }
  setCurrentHeight(h: number) {
    this.currentHeight = THREE.MathUtils.clamp(h, this.opts.minHeight, this.opts.maxHeight);
    if (this.mode === 'fly') this.playerPos.y = this.currentHeight;
    this.applyPose();
  }
  getCurrentHeight() { return this.currentHeight; }
  getPitch() { return this.pitch; }
  getYaw() { return this.yaw; }
  setMovementMode(mode: MovementMode) {
    if (this.mode === mode) return;
    // Leaving walk: remember the eye-level so fly→walk later restores it instead of
    // inheriting the fly absolute Y (which made the camera "float" at sky height).
    if (this.mode === 'walk') this.lastWalkHeight = this.currentHeight;
    this.mode = mode;
    if (mode === 'walk') {
      this.currentHeight = this.lastWalkHeight;
      if (this.walkableTris) {
        this.snapToFloor();
      } else {
        // No floor mesh: assume floor at y=0 and drop to walking eye level.
        this.playerPos.y = this.currentHeight;
      }
    }
    this.applyPose();
  }
  getMovementMode(): MovementMode { return this.mode; }
  getPlayerPosition(): THREE.Vector3 { return this.playerPos.clone(); }
  setWalkableTriangles(tris: ThreeTriangle[] | null) { this.walkableTris = (tris && tris.length > 0) ? tris : null; }
  setBlockTriangles(tris: ThreeTriangle[] | null) { this.blockTris = (tris && tris.length > 0) ? tris : null; }

  jumpTo(position: [number, number, number], target: [number, number, number], fov?: number) {
    this.playerPos.set(position[0], position[1], position[2]);
    this.currentHeight = position[1];
    const dx = target[0] - position[0];
    const dy = target[1] - position[1];
    const dz = target[2] - position[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-6) {
      const fx = dx / len, fy = dy / len, fz = dz / len;
      const RAD2DEG = 180 / Math.PI;
      this.pitch = THREE.MathUtils.clamp(Math.asin(fy) * RAD2DEG, -89, this.pitchMaxUp);
      this.yaw = Math.atan2(-fx, -fz) * RAD2DEG;
    }
    if (fov !== undefined) this.setFov(fov);
    this.applyPose();
  }

  // ── Input handlers ──

  private addListener(target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions) {
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  private setupMouse() {
    this.addListener(this.canvas, 'mousedown', ((e: MouseEvent) => {
      if (e.button === 0) this.isLeftMouseDown = true;
    }) as EventListener);
    this.addListener(window, 'mouseup', ((e: MouseEvent) => {
      if (e.button === 0) this.isLeftMouseDown = false;
    }) as EventListener);
    this.addListener(this.canvas, 'mousemove', ((e: MouseEvent) => {
      if (!this.isLeftMouseDown) return;
      this.yaw -= e.movementX * this.opts.lookSpeed;
      this.pitch -= e.movementY * this.opts.lookSpeed;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -89, this.pitchMaxUp);
      if (this.mode === 'fly') {
        this.playerPos.y += -e.movementY * this.opts.dragTranslateSpeed;
        this.currentHeight = this.playerPos.y;
      }
      this.onLookInputChange?.();
    }) as EventListener);
  }

  private setupKeyboard() {
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
    // Window focus loss / Alt-Tab: keyup may never fire, leaving Z/C/WASD "stuck" and
    // the camera spinning forever. Clear the held set on blur and on tab visibility
    // changes so we always come back to a clean state.
    this.addListener(window, 'blur', (() => { this.keys.clear(); }) as EventListener);
    this.addListener(document, 'visibilitychange', (() => {
      if (document.hidden) this.keys.clear();
    }) as EventListener);
  }

  private setupWheel() {
    this.addListener(this.canvas, 'wheel', ((e: WheelEvent) => {
      e.preventDefault();
      if (this.movementLocked) {
        const factor = e.deltaY < 0 ? this.opts.zoomStep : 1 / this.opts.zoomStep;
        const next = THREE.MathUtils.clamp(this.camera.fov * factor, this.opts.zoomFovMin, this.opts.zoomFovMax);
        if (Math.abs(next - this.camera.fov) < 0.05) return;
        this.camera.fov = next;
        this.camera.updateProjectionMatrix();
      } else {
        const factor = e.deltaY < 0 ? this.opts.moveSpeedStep : 1 / this.opts.moveSpeedStep;
        const next = THREE.MathUtils.clamp(this.opts.moveSpeed * factor, this.opts.moveSpeedMin, this.opts.moveSpeedMax);
        if (Math.abs(next - this.opts.moveSpeed) < 0.005) return;
        this.opts.moveSpeed = next;
        this.onMoveSpeedChange?.(next);
      }
    }) as EventListener, { passive: false });
  }

  private setupTouch() {
    let touching = false;
    let lx = 0, ly = 0;
    this.addListener(this.canvas, 'touchstart', ((e: TouchEvent) => {
      if (e.touches.length === 1) { touching = true; lx = e.touches[0].clientX; ly = e.touches[0].clientY; }
    }) as EventListener);
    this.addListener(this.canvas, 'touchmove', ((e: TouchEvent) => {
      if (!touching || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - lx;
      const dy = e.touches[0].clientY - ly;
      lx = e.touches[0].clientX; ly = e.touches[0].clientY;
      this.yaw -= dx * this.opts.lookSpeed;
      this.pitch -= dy * this.opts.lookSpeed;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -89, this.pitchMaxUp);
      if (this.mode === 'fly') {
        this.playerPos.y += -dy * this.opts.dragTranslateSpeed;
        this.currentHeight = this.playerPos.y;
      }
      this.onLookInputChange?.();
    }) as EventListener, { passive: false });
    this.addListener(this.canvas, 'touchend', (() => { touching = false; }) as EventListener);
  }

  // ── Update loop ──

  private startRAF() {
    this.lastFrameTs = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastFrameTs) / 1000);
      this.lastFrameTs = now;
      this.update(dt);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Suspend the input/update RAF. Used by `ThreeSceneManager.playCameraAnimation`
   *  so user input (gamepad/keyboard tick) doesn't fight the animation. Mirror of
   *  the PlayCanvas `app.off('update', updateHandler)` pattern. */
  suspendUpdate() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
  /** Resume the input/update RAF. Idempotent. */
  resumeUpdate() {
    if (this.rafId === null) this.startRAF();
  }

  private update(dt: number) {
    this.pollGamepad();
    if (!this.movementLocked) {
      // Right stick → yaw / pitch (in addition to mouse drag). Both axes inverted
      // (push-up looks up, push-right turns right) per the Xrealtracking gs.html PoC.
      const turnRate = 90; // deg/sec at full stick deflection
      this.yaw -= this.padYaw * turnRate * dt;
      this.pitch -= this.padPitch * (turnRate * 0.7) * dt;
      // Z / C で yaw 左右回転 (60°/sec) — その場で軸回転したい時用 (Xrealtracking PoC 準拠)。
      if (this.keys.has('KeyZ')) this.yaw -= 60 * dt;
      if (this.keys.has('KeyC')) this.yaw += 60 * dt;
      if (this.pitch > this.pitchMaxUp) this.pitch = this.pitchMaxUp;
      if (this.pitch < -89) this.pitch = -89;
      const turning = Math.abs(this.padYaw) > 0.001 || Math.abs(this.padPitch) > 0.001
        || this.keys.has('KeyZ') || this.keys.has('KeyC');
      if (turning) this.onLookInputChange?.();

      const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      // R2 analog → 1× → 5× boost (matches gs.html). Stacks with Shift sprint.
      const padBoost = 1 + this.padR2 * 4;
      const speedMul = (sprinting ? this.opts.sprintMultiplier : 1) * padBoost;
      const speed = this.opts.moveSpeed * speedMul * dt;
      if (this.mode === 'walk') this.updateWalk(dt, speed, sprinting);
      else this.updateFly(speed);
    }
    this.applyPose();
  }

  /** Sample the active gamepad, mirroring gs.html's "live" pad selection so a
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

    // **Live-only**: if no pad is actively reporting we treat input as zero. A common
    // failure mode was a phantom Windows pad slot (or a real pad with stick drift)
    // sitting at ~0.16 — above our deadzone — and slowly rotating the camera even
    // when the user wasn't touching anything. By requiring an active timestamp
    // change in the last 500 ms we ignore those entirely. Modern browsers update
    // `Gamepad.timestamp` every poll while a stick is held, so held-input still works.
    const pad = standardLive ?? live;
    if (!pad) {
      this.padFwd = this.padStrafe = this.padYaw = this.padPitch = this.padUp = this.padR2 = 0;
      return;
    }

    // Deadzone bumped from 0.15 → 0.20 so common analog stick drift doesn't slip
    // through. PS5/Xbox sticks at rest typically report < 0.1, so this still feels
    // responsive once the user actually pushes a stick.
    const dz = (v: number, d = 0.20) => Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d) / (1 - d);
    this.padStrafe = dz(pad.axes[0] ?? 0);          // left stick X
    this.padFwd    = -dz(pad.axes[1] ?? 0);         // left stick Y (up = forward)
    this.padYaw    = dz(pad.axes[2] ?? 0);          // right stick X
    this.padPitch  = dz(pad.axes[3] ?? 0);          // right stick Y
    this.padUp     = ((pad.buttons[12]?.pressed ? 1 : 0) - (pad.buttons[13]?.pressed ? 1 : 0)); // D-pad ↑/↓
    this.padR2     = pad.buttons[7]?.value ?? 0;    // R2 analog
  }

  private updateWalk(dt: number, speed: number, sprinting: boolean) {
    const heightSpeed = this.opts.heightStep * dt * 3 * (sprinting ? this.opts.sprintMultiplier : 1);
    if (this.keys.has('KeyQ')) this.currentHeight = Math.min(this.currentHeight + heightSpeed, this.opts.maxHeight);
    if (this.keys.has('KeyE')) this.currentHeight = Math.max(this.currentHeight - heightSpeed, this.opts.minHeight);

    // WASD direction follows the *combined* yaw (base + head tracking) so the
    // user moves toward where they're looking when demo mode is on.
    const yawRad = (this.yaw + this.trackingYaw) * Math.PI / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rgtX = Math.cos(yawRad);
    const rgtZ = -Math.sin(yawRad);
    // Stack keyboard + left-stick analog. Magnitudes clamp to 1 below so diagonals
    // don't outrun straight motion when both keys and stick agree.
    const fwdAmt    = ((this.keys.has('KeyW') || this.keys.has('ArrowUp'))    ? 1 : 0)
                    - ((this.keys.has('KeyS') || this.keys.has('ArrowDown'))  ? 1 : 0)
                    + this.padFwd;
    const strafeAmt = ((this.keys.has('KeyD') || this.keys.has('ArrowRight')) ? 1 : 0)
                    - ((this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  ? 1 : 0)
                    + this.padStrafe;
    let mx = fwdX * fwdAmt + rgtX * strafeAmt;
    let mz = fwdZ * fwdAmt + rgtZ * strafeAmt;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }
    mx *= speed; mz *= speed;
    const blocked = this.applyBlockCollision(mx, 0, mz);
    this.playerPos.x += blocked.x;
    this.playerPos.z += blocked.z;

    // D-pad ↑/↓ height adjust (same step rate as Q/E keys).
    if (this.padUp > 0) this.currentHeight = Math.min(this.currentHeight + heightSpeed, this.opts.maxHeight);
    if (this.padUp < 0) this.currentHeight = Math.max(this.currentHeight - heightSpeed, this.opts.minHeight);

    if (this.walkableTris) {
      const floorY = this.raycastFloor(this.playerPos.x, this.playerPos.z);
      this.playerPos.y = (floorY ?? this.playerPos.y - this.currentHeight) + this.currentHeight;
    } else {
      this.playerPos.y = this.currentHeight;
    }
  }

  private updateFly(speed: number) {
    const yawRad = (this.yaw + this.trackingYaw) * Math.PI / 180;
    const pitchRad = (this.pitch + this.trackingPitch) * Math.PI / 180;
    const cosP = Math.cos(pitchRad);
    const fwdX = -Math.sin(yawRad) * cosP;
    const fwdY = Math.sin(pitchRad);
    const fwdZ = -Math.cos(yawRad) * cosP;
    const rgtX = Math.cos(yawRad);
    const rgtZ = -Math.sin(yawRad);
    const fwdAmt    = ((this.keys.has('KeyW') || this.keys.has('ArrowUp'))    ? 1 : 0)
                    - ((this.keys.has('KeyS') || this.keys.has('ArrowDown'))  ? 1 : 0)
                    + this.padFwd;
    const strafeAmt = ((this.keys.has('KeyD') || this.keys.has('ArrowRight')) ? 1 : 0)
                    - ((this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  ? 1 : 0)
                    + this.padStrafe;
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

  private applyBlockCollision(mx: number, my: number, mz: number) {
    if (!this.blockTris) return { x: mx, y: my, z: mz };
    const len = Math.hypot(mx, my, mz);
    if (len < 1e-6) return { x: 0, y: 0, z: 0 };
    const dir = new THREE.Vector3(mx / len, my / len, mz / len);
    const r = this.opts.capsuleRadius;
    const hit = raycastThreeTriangles(this.playerPos, dir, this.blockTris, len + r);
    if (!hit) return { x: mx, y: my, z: mz };
    const safe = Math.max(0, hit.t - r);
    return { x: dir.x * safe, y: dir.y * safe, z: dir.z * safe };
  }

  private raycastFloor(x: number, z: number): number | null {
    if (!this.walkableTris) return null;
    const start = (this.playerPos.y > 0 ? this.playerPos.y : 0) + 50;
    const origin = new THREE.Vector3(x, start, z);
    const down = new THREE.Vector3(0, -1, 0);
    const hit = raycastThreeTriangles(origin, down, this.walkableTris, 100);
    return hit ? hit.point.y : null;
  }

  private snapToFloor() {
    if (!this.walkableTris) return;
    const floorY = this.raycastFloor(this.playerPos.x, this.playerPos.z);
    if (floorY !== null) this.playerPos.y = floorY + this.currentHeight;
  }

  /**
   * Apply yaw/pitch to camera quaternion. We use the PlayCanvas "yaw around world Y,
   * then pitch around local X" convention. Equivalent to YXZ Euler order applied as
   * (pitch, yaw, 0).
   */
  private applyPose() {
    this.camera.position.copy(this.playerPos);
    this.camera.rotation.order = 'YXZ';
    // Render with base + head-tracking offset. Stored `this.pitch` / `this.yaw` are
    // the user-controlled (mouse / jumpTo) values; head tracking is purely additive.
    const renderPitch = THREE.MathUtils.clamp(this.pitch + this.trackingPitch, -89, this.pitchMaxUp);
    const renderYaw = this.yaw + this.trackingYaw;
    this.camera.rotation.set(
      THREE.MathUtils.degToRad(renderPitch),
      THREE.MathUtils.degToRad(renderYaw),
      0,
    );
  }

  destroy() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    this.cleanups = [];
  }
}
