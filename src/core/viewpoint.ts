import type { Viewpoint, Vec3, CameraPose, CameraKeyframe } from './types';

/** Lerp between two Vec3 values */
export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Ease-out cubic */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Ease-in-out cubic — smooth at both ends. Used by the camera animator. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
/** Ease-in cubic — slow start, full speed at end (use when the segment ends at
 *  a pass-through waypoint so we keep momentum into the next one). */
export function easeInCubic(t: number): number {
  return t * t * t;
}

/** Total duration of a multi-keyframe path in seconds (ignores the last
 *  keyframe's `durationSec` since it has no successor). */
export function totalPathDurationSec(keyframes: CameraKeyframe[]): number {
  if (keyframes.length < 2) return 0;
  let s = 0;
  for (let i = 0; i < keyframes.length - 1; i++) s += Math.max(0.001, keyframes[i].durationSec);
  return s;
}

/** Centripetal Catmull-Rom for one axis. Passes through `b` at t=0 and `c` at t=1
 *  with tangents derived from `a` and `d` so the curve is C¹ continuous across
 *  control points — i.e. no kinks at waypoints. */
function catmullRom1D(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((-a + 3 * b - 3 * c + d) * t3 + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + c) * t + 2 * b);
}

function catmullRomVec3(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  return [
    catmullRom1D(p0[0], p1[0], p2[0], p3[0], t),
    catmullRom1D(p0[1], p1[1], p2[1], p3[1], t),
    catmullRom1D(p0[2], p1[2], p2[2], p3[2], t),
  ];
}

/** Mirror `a` across `b` — used to fabricate phantom control points at the path
 *  endpoints so the spline tangent matches the segment direction (no curl-back). */
function mirrorVec3(a: Vec3, b: Vec3): Vec3 {
  return [2 * b[0] - a[0], 2 * b[1] - a[1], 2 * b[2] - a[2]];
}

/**
 * Compute the camera pose at parameter `tRaw ∈ [0, 1]` along the path.
 *
 * Spatial path (position + target) is a Catmull-Rom spline through the keyframe
 * poses, which gives tangent-continuous (smooth) motion at every waypoint —
 * essential for the pass-through mode where the camera doesn't stop. The path
 * still passes exactly through each keyframe.
 *
 * Temporal easing per segment depends on the `passThrough` flag of the
 * segment's boundary keyframes — a pass-through waypoint suppresses easing on
 * its side so the camera doesn't slow down at it:
 *
 *   - both endpoints stop (default)        → easeInOutCubic   (slow-fast-slow)
 *   - start stops, end passes through      → easeInCubic      (slow-fast)
 *   - start passes through, end stops      → easeOutCubic     (fast-slow)
 *   - both pass through                    → linear           (constant)
 *
 * The first and last keyframes always count as "stop" regardless of flag —
 * the path always starts at rest and ends at rest.
 *
 * Returns null if there are fewer than 2 keyframes.
 */
export function interpolatePath(keyframes: CameraKeyframe[], tRaw: number): CameraPose | null {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) return keyframes[0].pose;
  const total = totalPathDurationSec(keyframes);
  if (total <= 0) return keyframes[0].pose;
  const t = Math.max(0, Math.min(1, tRaw));
  const elapsed = t * total;
  const last = keyframes.length - 1;
  let acc = 0;
  for (let i = 0; i < last; i++) {
    const segDur = Math.max(0.001, keyframes[i].durationSec);
    if (elapsed <= acc + segDur || i === last - 1) {
      const segT = Math.max(0, Math.min(1, (elapsed - acc) / segDur));
      // First/last keyframes are always "stop"; only middle waypoints honour passThrough.
      const startsAtRest = i === 0 || !keyframes[i].passThrough;
      const endsAtRest = i + 1 === last || !keyframes[i + 1].passThrough;
      const eased =
        startsAtRest && endsAtRest ? easeInOutCubic(segT)
          : startsAtRest && !endsAtRest ? easeInCubic(segT)
          : !startsAtRest && endsAtRest ? easeOutCubic(segT)
          : segT; // linear
      const p1 = keyframes[i].pose;
      const p2 = keyframes[i + 1].pose;
      // Phantom control points at path ends: mirror so the tangent aligns with the
      // segment direction (avoids curl-back when there's no neighbour).
      const p0pos = i > 0 ? keyframes[i - 1].pose.position : mirrorVec3(p2.position, p1.position);
      const p0tgt = i > 0 ? keyframes[i - 1].pose.target : mirrorVec3(p2.target, p1.target);
      const p3pos = i + 2 <= last ? keyframes[i + 2].pose.position : mirrorVec3(p1.position, p2.position);
      const p3tgt = i + 2 <= last ? keyframes[i + 2].pose.target : mirrorVec3(p1.target, p2.target);
      return {
        position: catmullRomVec3(p0pos, p1.position, p2.position, p3pos, eased),
        target: catmullRomVec3(p0tgt, p1.target, p2.target, p3tgt, eased),
        fov: p1.fov + (p2.fov - p1.fov) * eased,
      };
    }
    acc += segDur;
  }
  return keyframes[last].pose;
}

/** Find a viewpoint by ID */
export function findViewpoint(viewpoints: Viewpoint[], id: string): Viewpoint | undefined {
  return viewpoints.find((v) => v.id === id);
}

/**
 * Derive PlayCanvas yaw (0–360°) from a viewpoint's saved `target - position`.
 * Single source of truth for "the saved direction this viewpoint faces" — used
 * by both maps (debug 図面 + viewer MAP) so their cones agree.
 *
 * PlayCanvas convention: yaw 0 → forward = -Z. yaw rotates CCW around +Y.
 * → yaw = atan2(-dx, -dz).
 */
export function deriveYawFromTarget(vp: { position: Vec3; target: Vec3 }): number {
  const dx = vp.target[0] - vp.position[0];
  const dz = vp.target[2] - vp.position[2];
  if (dx * dx + dz * dz < 1e-6) return 0;
  let deg = Math.atan2(-dx, -dz) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/**
 * Build a unit-length `target` 1m in front of `position` for the given PlayCanvas yaw.
 * `targetY` is preserved so existing pitch is untouched. Inverse of `deriveYawFromTarget`.
 */
export function targetFromYaw(position: Vec3, yawDeg: number, targetY: number): Vec3 {
  const r = yawDeg * Math.PI / 180;
  return [
    +(position[0] - Math.sin(r)).toFixed(3),
    targetY,
    +(position[2] - Math.cos(r)).toFixed(3),
  ];
}
