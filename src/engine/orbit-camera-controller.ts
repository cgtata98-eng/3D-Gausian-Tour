import { Vec3, math } from 'playcanvas';
import type { AppBase, Entity } from 'playcanvas';
import type { Triangle } from './mesh-raycaster';
import type { MovementMode } from './camera-controller';

/**
 * Orbit camera for the showroom (`projectType === 'product'`) mode. Rotates the
 * camera around a fixed `target` point in the world. Single-touch / left-drag =
 * orbit, right-drag / two-finger pan = move the target, wheel / pinch = dolly.
 *
 * The class is intentionally structurally compatible with `CameraController` so
 * that `SceneManager` can hold either via the same field — methods that don't
 * make sense for an orbit camera (walk / fly mode toggles, walkable triangles,
 * touch joystick, etc.) are accepted as no-ops.
 */
export interface OrbitCameraOptions {
  /** Initial camera distance from the target. */
  distance: number;
  minDistance: number;
  maxDistance: number;
  /** Initial pitch in degrees. Negative = camera looks slightly down. */
  pitch: number;
  /** Initial yaw in degrees. */
  yaw: number;
  /** FOV in degrees. */
  fov: number;
  zoomFovMin: number;
  zoomFovMax: number;
}

const DEFAULTS: OrbitCameraOptions = {
  distance: 2.5,
  minDistance: 0.2,
  maxDistance: 30,
  pitch: -10,
  yaw: 0,
  fov: 45,
  zoomFovMin: 20,
  zoomFovMax: 90,
};

const RAD = Math.PI / 180;

export class OrbitCameraController {
  private app: AppBase;
  private entity: Entity;
  private canvas: HTMLCanvasElement;

  private target = new Vec3(0, 0, 0);
  private distance: number;
  private minDistance: number;
  private maxDistance: number;
  private yaw: number;
  private pitch: number;
  private fov: number;
  private zoomFovMin: number;
  private zoomFovMax: number;
  private pitchMaxUp = 89;
  private pitchMin = -89;

  private movementLocked = false;

  // input state
  private activePointers: Map<number, { x: number; y: number; button: number; type: string }> = new Map();
  private lastPinchDist = 0;
  private updateHandler: ((dt: number) => void) | null = null;
  private cleanups: Array<() => void> = [];

  constructor(app: AppBase, entity: Entity, opts: Partial<OrbitCameraOptions> = {}) {
    this.app = app;
    this.entity = entity;
    this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    const o = { ...DEFAULTS, ...opts };
    this.distance = o.distance;
    this.minDistance = o.minDistance;
    this.maxDistance = o.maxDistance;
    this.yaw = o.yaw;
    this.pitch = o.pitch;
    this.fov = o.fov;
    this.zoomFovMin = o.zoomFovMin;
    this.zoomFovMax = o.zoomFovMax;
    this.attachInput();
    this.apply();
  }

  // ── Input ─────────────────────────────────────────────────────

  private attachInput() {
    const canvas = this.canvas;

    const onPointerDown = (e: PointerEvent) => {
      if (this.movementLocked) return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, type: e.pointerType });
      this.lastPinchDist = this.computePinchDist();
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (this.movementLocked) return;
      const prev = this.activePointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      // 2 fingers → pinch zoom + pan center
      if (this.activePointers.size === 2 && e.pointerType === 'touch') {
        const d = this.computePinchDist();
        if (this.lastPinchDist > 0 && d > 0) {
          const ratio = this.lastPinchDist / d;
          this.dollyMul(ratio);
        }
        this.lastPinchDist = d;
        // pan by the average pointer drag
        const avgDx = dx * 0.5;
        const avgDy = dy * 0.5;
        this.panTarget(avgDx, avgDy);
        this.apply();
        return;
      }
      // Right mouse button or middle button → pan
      if (prev.button === 2 || prev.button === 1) {
        this.panTarget(dx, dy);
        this.apply();
        return;
      }
      // single-finger / left-drag → orbit
      // pitch: ドラッグ上で「上から覗き込む」(= カメラが上に回る) のが自然なので、
      // dy<0 (上方向) で pitch を増やす符号にする。
      this.yaw -= dx * 0.4;
      this.pitch = math.clamp(this.pitch - dy * 0.4, this.pitchMin, this.pitchMaxUp);
      this.apply();
    };
    const onPointerUp = (e: PointerEvent) => {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) this.lastPinchDist = 0;
    };
    const onWheel = (e: WheelEvent) => {
      if (this.movementLocked) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.dollyMul(factor);
      this.apply();
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    const add = (target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    add(canvas, 'pointerdown', onPointerDown as EventListener);
    add(canvas, 'pointermove', onPointerMove as EventListener);
    add(canvas, 'pointerup', onPointerUp as EventListener);
    add(canvas, 'pointercancel', onPointerUp as EventListener);
    add(canvas, 'wheel', onWheel as EventListener, { passive: false });
    add(canvas, 'contextmenu', onContextMenu as EventListener);
  }

  private computePinchDist(): number {
    if (this.activePointers.size < 2) return 0;
    const pts = Array.from(this.activePointers.values()).slice(0, 2);
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  private dollyMul(factor: number) {
    this.distance = math.clamp(this.distance * factor, this.minDistance, this.maxDistance);
  }

  private panTarget(dxPx: number, dyPx: number) {
    // Pan amount scales with distance so it feels consistent at any zoom level.
    // Negate dx so a left-drag moves the target right (= world appears to slide right).
    const scale = 0.0022 * this.distance;
    const right = this.entity.right.clone().mulScalar(-dxPx * scale);
    const up = this.entity.up.clone().mulScalar(dyPx * scale);
    this.target.x += right.x + up.x;
    this.target.y += right.y + up.y;
    this.target.z += right.z + up.z;
  }

  // ── Pose ──────────────────────────────────────────────────────

  private apply() {
    const pr = this.pitch * RAD;
    const yr = this.yaw * RAD;
    const cosP = Math.cos(pr);
    // Pitch convention: positive pitch = camera looks UP (mirror of how the
    // walk camera reports pitch). For orbit positioning we negate so dragging
    // up moves the camera up (= looks down at target → natural).
    const x = this.target.x + this.distance * cosP * Math.sin(yr);
    const y = this.target.y - this.distance * Math.sin(pr);
    const z = this.target.z + this.distance * cosP * Math.cos(yr);
    this.entity.setPosition(x, y, z);
    this.entity.lookAt(this.target);
    const cam = this.entity.camera as { fov?: number } | null;
    if (cam) cam.fov = this.fov;
  }

  /** Frame the camera so a sphere of given radius around the current target fits the view. */
  frameRadius(radius: number) {
    const halfFov = this.fov * 0.5 * RAD;
    const sin = Math.sin(halfFov);
    if (sin > 1e-4) {
      this.distance = math.clamp(radius / sin, this.minDistance, this.maxDistance);
    }
    this.apply();
  }

  setTarget(x: number, y: number, z: number) {
    this.target.set(x, y, z);
    this.apply();
  }

  // ── Public interface (mirrors CameraController shape) ─────────

  getPitch(): number { return this.pitch; }
  getYaw(): number { return this.yaw; }
  getFov(): number { return (this.entity.camera as { fov?: number } | null)?.fov ?? this.fov; }
  getMoveSpeed(): number { return 0; }
  getCurrentHeight(): number { return this.target.y; }
  getMovementMode(): MovementMode { return 'walk'; }
  getPlayerPosition(): Vec3 { return this.target.clone(); }

  setMoveSpeed(_speed: number) { /* no-op for orbit */ }
  setTouchJoystick(_x: number, _y: number) { /* no-op for orbit */ }
  setFov(fov: number) {
    this.fov = math.clamp(fov, this.zoomFovMin, this.zoomFovMax);
    this.apply();
  }
  setTrackingOffset(_yawDeg: number, _pitchDeg: number) { /* no-op */ }
  setMovementLocked(locked: boolean) { this.movementLocked = locked; }
  setPitchMaxUp(deg: number) { this.pitchMaxUp = math.clamp(deg, 0, 89); }
  setZoomFovBounds(min: number, max: number) {
    if (max <= min) return;
    this.zoomFovMin = min;
    this.zoomFovMax = max;
    this.fov = math.clamp(this.fov, min, max);
    this.apply();
  }
  setOnLookInputChange(_cb: (() => void) | null) { /* no-op */ }
  setOnMoveSpeedChange(_cb: ((speed: number) => void) | null) { /* no-op */ }
  setYaw(deg: number) {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    this.yaw = d;
    this.apply();
  }
  setPitch(deg: number) {
    this.pitch = math.clamp(deg, this.pitchMin, this.pitchMaxUp);
    this.apply();
  }
  setCurrentHeight(_h: number) { /* no-op for orbit */ }
  setMovementMode(_mode: MovementMode) { /* no-op for orbit */ }
  setWalkableTriangles(_tris: Triangle[] | null) { /* no-op for orbit */ }
  setBlockTriangles(_tris: Triangle[] | null) { /* no-op for orbit */ }

  /**
   * Walk camera's `jumpTo(position, target, fov)` is recast here as: place the
   * camera at `position` looking at `target`, then snap the orbit invariants
   * (yaw/pitch/distance/target) so subsequent orbits revolve around `target`.
   */
  jumpTo(position: [number, number, number], target: [number, number, number], fov?: number) {
    this.target.set(target[0], target[1], target[2]);
    const dx = position[0] - target[0];
    const dy = position[1] - target[1];
    const dz = position[2] - target[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-4) {
      this.distance = math.clamp(d, this.minDistance, this.maxDistance);
      // Compute yaw / pitch so the camera lands at `position` looking at `target`.
      // y = -dist * sin(pitch)  =>  sin(pitch) = -dy/dist
      const pitchRad = Math.asin(math.clamp(-dy / d, -1, 1));
      this.pitch = math.clamp(pitchRad * 180 / Math.PI, this.pitchMin, this.pitchMaxUp);
      // x = dist*cos(pitch)*sin(yaw), z = dist*cos(pitch)*cos(yaw)
      const cosP = Math.cos(pitchRad);
      if (cosP > 1e-4) {
        this.yaw = Math.atan2(dx / (d * cosP), dz / (d * cosP)) * 180 / Math.PI;
      }
    }
    if (fov !== undefined) this.fov = math.clamp(fov, this.zoomFovMin, this.zoomFovMax);
    this.apply();
  }

  destroy() {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    if (this.updateHandler) {
      this.app.off('update', this.updateHandler);
      this.updateHandler = null;
    }
  }
}
