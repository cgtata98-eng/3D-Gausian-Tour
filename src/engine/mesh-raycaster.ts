import { Vec3, Entity, MeshInstance } from 'playcanvas';

/**
 * Triangle in world space — three vertices baked into world coordinates at extraction
 * time so the raycaster can iterate them without per-frame matrix math.
 */
export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

export interface RayHit {
  /** Distance along the ray direction to the hit point. */
  t: number;
  /** World-space hit point (= origin + dir * t). */
  point: Vec3;
  /** Triangle face normal at the hit (not necessarily front-facing). */
  normal: Vec3;
}

/**
 * Walk an Entity's render hierarchy and bake every triangle into world space.
 *
 * No physics engine is loaded (no ammo / no rigidbody system), so movement / floor-follow
 * collision has to do triangle-vs-ray intersection in software. This pre-flattens the
 * mesh so each `update()` only does the iteration, not the matrix transforms.
 *
 * Performance: O(triangles) per ray. For a typical room walkable mesh (a few thousand
 * triangles) this is fine at 60fps. If a scene starts dropping frames, swap in a BVH.
 */
export function extractTrianglesFromEntity(root: Entity): Triangle[] {
  const out: Triangle[] = [];
  const meshInstances: MeshInstance[] = [];
  const collect = (e: Entity) => {
    const r = (e as Entity & { render?: { meshInstances?: MeshInstance[] } }).render;
    if (r?.meshInstances) meshInstances.push(...r.meshInstances);
    e.children.forEach((c) => { if (c instanceof Entity) collect(c); });
  };
  collect(root);

  for (const mi of meshInstances) {
    const mesh = mi.mesh;
    if (!mesh) continue;
    const positions: number[] = [];
    mesh.getPositions(positions);
    const indices: number[] = [];
    mesh.getIndices(indices);
    const wt = mi.node.getWorldTransform();
    const tmp = new Vec3();

    const transformVertex = (i: number, target: Vec3) => {
      tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      wt.transformPoint(tmp, target);
    };

    if (indices.length > 0) {
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = new Vec3();
        const b = new Vec3();
        const c = new Vec3();
        transformVertex(indices[i], a);
        transformVertex(indices[i + 1], b);
        transformVertex(indices[i + 2], c);
        out.push({ a, b, c });
      }
    } else {
      const triCount = Math.floor(positions.length / 9);
      for (let i = 0; i < triCount; i++) {
        const a = new Vec3();
        const b = new Vec3();
        const c = new Vec3();
        transformVertex(i * 3, a);
        transformVertex(i * 3 + 1, b);
        transformVertex(i * 3 + 2, c);
        out.push({ a, b, c });
      }
    }
  }
  return out;
}

/**
 * Möller–Trumbore ray vs triangle test. Returns the closest hit (smallest positive `t`)
 * within `[epsilon, maxT]`, or null. `dir` does not need to be normalized — `t` is in
 * units of `dir`, so passing a unit vector gives `t` in meters and is recommended.
 */
export function raycastTriangles(
  originX: number, originY: number, originZ: number,
  dirX: number, dirY: number, dirZ: number,
  triangles: Triangle[],
  maxT: number = Infinity,
): RayHit | null {
  const EPS = 1e-7;
  let bestT = maxT;
  let bestNX = 0, bestNY = 0, bestNZ = 0;
  let found = false;

  for (let k = 0; k < triangles.length; k++) {
    const tri = triangles[k];
    const ax = tri.a.x, ay = tri.a.y, az = tri.a.z;
    const e1x = tri.b.x - ax, e1y = tri.b.y - ay, e1z = tri.b.z - az;
    const e2x = tri.c.x - ax, e2y = tri.c.y - ay, e2z = tri.c.z - az;
    // h = dir × e2
    const hx = dirY * e2z - dirZ * e2y;
    const hy = dirZ * e2x - dirX * e2z;
    const hz = dirX * e2y - dirY * e2x;
    const a = e1x * hx + e1y * hy + e1z * hz;
    if (a > -EPS && a < EPS) continue;
    const f = 1 / a;
    const sx = originX - ax, sy = originY - ay, sz = originZ - az;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) continue;
    // q = s × e1
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = f * (dirX * qx + dirY * qy + dirZ * qz);
    if (v < 0 || u + v > 1) continue;
    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    if (t > EPS && t < bestT) {
      bestT = t;
      // face normal = e1 × e2
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }
      bestNX = nx; bestNY = ny; bestNZ = nz;
      found = true;
    }
  }

  if (!found) return null;
  return {
    t: bestT,
    point: new Vec3(originX + dirX * bestT, originY + dirY * bestT, originZ + dirZ * bestT),
    normal: new Vec3(bestNX, bestNY, bestNZ),
  };
}
