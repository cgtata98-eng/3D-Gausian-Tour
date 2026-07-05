/**
 * Manual collision-mesh builder for the 図面 wall editor (B2 手動系統).
 *
 * Input is the authored `CollisionWallData` (wall segments + floor outline in
 * world XZ, drawn on the floor plan). Output is standard binary glTF (.glb)
 * Blobs that flow through the exact same pipeline as uploaded / auto-generated
 * collision GLBs: IDB blob → `loadCollisionFromManifestRef` → publish to R2.
 *
 *   walls (segments) → each segment extruded into a wallHeight × wallThickness
 *                      box → ONE mesh → `manualBlock` GLB
 *   floorPolygon     → ear-clipping triangulation at floorY → `manualWalkable` GLB
 *
 * The GLB writer is minimal (single mesh / node / scene, POSITION + indices)
 * — the collision loaders only extract triangles, so materials/normals are
 * intentionally omitted.
 */
import type { CollisionWallData, Vec2 } from '../core/types';

// ── Mesh accumulation ────────────────────────────────────────────────────────

interface MeshData {
  positions: number[]; // xyz triplets
  indices: number[];
}

/** Append a box for one wall segment: footprint = segment swept by ±thickness/2,
 *  extruded from floorY to floorY + height. */
function appendWallBox(mesh: MeshData, a: Vec2, b: Vec2, floorY: number, height: number, thickness: number) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return; // degenerate segment
  // Perpendicular (in XZ) scaled to half the wall thickness.
  const nx = (-dz / len) * (thickness / 2);
  const nz = (dx / len) * (thickness / 2);
  const y0 = floorY;
  const y1 = floorY + height;
  // 8 corners: [a-n, a+n, b+n, b-n] × [bottom, top] — a CCW footprint loop.
  const base = mesh.positions.length / 3;
  const corners: [number, number][] = [
    [a[0] - nx, a[1] - nz],
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
  ];
  for (const y of [y0, y1]) {
    for (const [x, z] of corners) mesh.positions.push(x, y, z);
  }
  // Quads: 4 sides + bottom + top (indices into the 8 corners: 0-3 bottom, 4-7 top).
  const quads: [number, number, number, number][] = [
    [0, 1, 5, 4], // side a
    [1, 2, 6, 5], // side +n
    [2, 3, 7, 6], // side b
    [3, 0, 4, 7], // side -n
    [3, 2, 1, 0], // bottom
    [4, 5, 6, 7], // top
  ];
  for (const [q0, q1, q2, q3] of quads) {
    mesh.indices.push(base + q0, base + q1, base + q2, base + q0, base + q2, base + q3);
  }
}

/**
 * Ear-clipping triangulation of a simple polygon in XZ (handles concave
 * outlines like L字 rooms; self-intersecting input degrades gracefully by
 * dropping the leftover ring). Returns index triples into `poly`.
 */
function triangulatePolygon(poly: Vec2[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  // Work on a CCW copy (positive signed area). Flip index mapping if reversed.
  const area = poly.reduce((acc, p, i) => {
    const q = poly[(i + 1) % n];
    return acc + (p[0] * q[1] - q[0] * p[1]);
  }, 0) / 2;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (area < 0) idx.reverse();

  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const pointInTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) => {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  const out: number[] = [];
  const ring = [...idx];
  let guard = 0;
  while (ring.length > 3 && guard++ < 10_000) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const i0 = ring[(i + ring.length - 1) % ring.length];
      const i1 = ring[i];
      const i2 = ring[(i + 1) % ring.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (cross(a, b, c) <= 0) continue; // reflex vertex — not an ear
      // Any other ring vertex inside the candidate ear? → not clippable.
      let contains = false;
      for (const j of ring) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(poly[j], a, b, c)) { contains = true; break; }
      }
      if (contains) continue;
      out.push(i0, i1, i2);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate input — emit what we have
  }
  if (ring.length === 3) out.push(ring[0], ring[1], ring[2]);
  return out;
}

// ── Minimal GLB writer ───────────────────────────────────────────────────────

/** Encode a single indexed triangle mesh as a binary glTF 2.0 (.glb) Blob. */
function encodeGlb(mesh: MeshData, name: string): Blob {
  const positions = new Float32Array(mesh.positions);
  const indices = new Uint32Array(mesh.indices);

  // BIN layout: positions | indices (both 4-byte aligned by construction).
  const posBytes = positions.byteLength;
  const idxBytes = indices.byteLength;
  const binLen = posBytes + idxBytes;
  const bin = new Uint8Array(binLen);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), posBytes);

  // Min/max are REQUIRED on the POSITION accessor by the glTF spec.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }

  const gltf = {
    asset: { version: '2.0', generator: '3droomtour wall-collision-builder' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: idxBytes, target: 34963 },
    ],
    buffers: [{ byteLength: binLen }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binPadded = (binLen + 3) & ~3;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;

  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  let o = 0;
  // Header
  dv.setUint32(o, 0x46546c67, true); o += 4; // 'glTF'
  dv.setUint32(o, 2, true); o += 4;
  dv.setUint32(o, total, true); o += 4;
  // JSON chunk (padded with spaces)
  dv.setUint32(o, jsonPadded, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // 'JSON'
  u8.set(jsonBytes, o);
  u8.fill(0x20, o + jsonBytes.length, o + jsonPadded);
  o += jsonPadded;
  // BIN chunk (padded with zeros)
  dv.setUint32(o, binPadded, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4; // 'BIN\0'
  u8.set(bin, o);

  return new Blob([out], { type: 'model/gltf-binary' });
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Build the `manualBlock` GLB (walls) from drawn segments. Null when no walls. */
export function buildWallBlockGlb(walls: CollisionWallData): Blob | null {
  const mesh: MeshData = { positions: [], indices: [] };
  for (const seg of walls.segments) {
    appendWallBox(mesh, seg.a, seg.b, walls.floorY, walls.wallHeight, walls.wallThickness);
  }
  if (mesh.indices.length === 0) return null;
  return encodeGlb(mesh, 'manual-walls');
}

/** Build the `manualWalkable` GLB (flat floor at floorY) from the outline
 *  polygon. Null when fewer than 3 points or the polygon degenerates. */
export function buildFloorWalkableGlb(walls: CollisionWallData): Blob | null {
  const poly = walls.floorPolygon;
  if (!poly || poly.length < 3) return null;
  const tris = triangulatePolygon(poly);
  if (tris.length === 0) return null;
  const mesh: MeshData = { positions: [], indices: [] };
  for (const p of poly) mesh.positions.push(p[0], walls.floorY, p[1]);
  mesh.indices.push(...tris);
  return encodeGlb(mesh, 'manual-floor');
}
