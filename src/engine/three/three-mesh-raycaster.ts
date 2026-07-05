import * as THREE from 'three';

/**
 * Triangle in world space — three vertices baked at extraction time so the raycaster
 * can iterate them without per-frame matrix math. Mirror of `mesh-raycaster.ts`'s
 * type but uses `THREE.Vector3` so the three.js engines can share the structure.
 */
export interface ThreeTriangle {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
}

export interface ThreeRayHit {
  t: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/** Walk a THREE.Object3D hierarchy and bake every triangle into world space. */
export function extractThreeTriangles(root: THREE.Object3D): ThreeTriangle[] {
  const out: ThreeTriangle[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh.isMesh && mesh.geometry)) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const idx = geom.index;
    const wt = mesh.matrixWorld;
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    if (idx) {
      const ar = idx.array as ArrayLike<number>;
      for (let i = 0; i + 2 < ar.length; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, ar[i]).applyMatrix4(wt);
        const b = new THREE.Vector3().fromBufferAttribute(pos, ar[i + 1]).applyMatrix4(wt);
        const c = new THREE.Vector3().fromBufferAttribute(pos, ar[i + 2]).applyMatrix4(wt);
        out.push({ a, b, c });
      }
    } else {
      for (let i = 0; i + 2 < pos.count; i += 3) {
        vA.fromBufferAttribute(pos, i).applyMatrix4(wt);
        vB.fromBufferAttribute(pos, i + 1).applyMatrix4(wt);
        vC.fromBufferAttribute(pos, i + 2).applyMatrix4(wt);
        out.push({ a: vA.clone(), b: vB.clone(), c: vC.clone() });
      }
    }
  });
  return out;
}

/**
 * Möller–Trumbore ray vs triangle test. `dir` should be a unit vector for `t` to be
 * in meters. Returns the closest hit within `[epsilon, maxT]` or null.
 *
 * `minAbsNormalY` (0 = off) skips triangles whose face normal is not steep enough in Y,
 * i.e. only accepts surfaces at least this horizontal (|ny| ≥ minAbsNormalY). Used by
 * floor-snap to ignore vertical box faces / floater shells and find the real floor below.
 * Mirror of `mesh-raycaster.ts`.
 */
export function raycastThreeTriangles(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  triangles: ThreeTriangle[],
  maxT: number = Infinity,
  minAbsNormalY: number = 0,
): ThreeRayHit | null {
  const EPS = 1e-7;
  let bestT = maxT;
  let bestNX = 0, bestNY = 0, bestNZ = 0;
  let found = false;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;

  for (let k = 0; k < triangles.length; k++) {
    const tri = triangles[k];
    const ax = tri.a.x, ay = tri.a.y, az = tri.a.z;
    const e1x = tri.b.x - ax, e1y = tri.b.y - ay, e1z = tri.b.z - az;
    const e2x = tri.c.x - ax, e2y = tri.c.y - ay, e2z = tri.c.z - az;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const a = e1x * hx + e1y * hy + e1z * hz;
    if (a > -EPS && a < EPS) continue;
    const f = 1 / a;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = f * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) continue;
    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    if (t > EPS && t < bestT) {
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }
      // Surface-orientation filter (floor-snap): reject non-horizontal hits so a
      // vertical box face / floater shell directly below is skipped and the real
      // floor beyond it is found instead.
      if (minAbsNormalY > 0 && Math.abs(ny) < minAbsNormalY) continue;
      bestT = t;
      bestNX = nx; bestNY = ny; bestNZ = nz;
      found = true;
    }
  }

  if (!found) return null;
  return {
    t: bestT,
    point: new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT),
    normal: new THREE.Vector3(bestNX, bestNY, bestNZ),
  };
}
