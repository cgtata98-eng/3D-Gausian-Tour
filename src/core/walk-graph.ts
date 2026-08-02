/**
 * WalkGraph navigation + grid helpers (C3) — pure functions, no engine deps.
 *
 * Core model: the player stands on a `WalkNode` and presses forward; we pick
 * the neighbor whose bearing is closest to where the camera is facing (within
 * ±45°) and transition there. Facing is preserved across transitions — nodes
 * carry no yaw of their own (avoids the A16 dual-source problem by design).
 *
 * Bearing convention: SAME as the camera yaw used everywhere else in this
 * codebase (PlayCanvas: yaw 0 → forward −Z, CCW-positive around +Y, i.e.
 * `atan2(-dx, -dz)` — see `deriveYawFromTarget`). A neighbor's bearing is
 * "the yaw a camera at `from` would have when looking straight at `to`",
 * so `stepForward` can compare it against the live camera yaw directly.
 */
import type { Vec3, WalkGraph, WalkNode } from './types';

/** Normalize an angle in degrees to (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Camera-yaw bearing from `from` toward `to` (world XZ; yaw convention above). */
export function yawBearing(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (dx * dx + dz * dz < 1e-9) return 0;
  let deg = Math.atan2(-dx, -dz) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

export function findWalkNode(graph: WalkGraph, id: string): WalkNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** The node the walkthrough starts at: `startNodeId` → fallback `nodes[0]`. */
export function resolveStartNode(graph: WalkGraph): WalkNode | undefined {
  return graph.nodes.find((n) => n.id === graph.startNodeId) ?? graph.nodes[0];
}

export function nodeAtCell(graph: WalkGraph, row: number, col: number): WalkNode | undefined {
  return graph.nodes.find((n) => n.cell && n.cell.row === row && n.cell.col === col);
}

export interface WalkNeighbor {
  node: WalkNode;
  /** Camera-yaw bearing from the source node toward this neighbor. */
  bearing: number;
}

/**
 * Resolve a node's neighbors as `{node, bearing}` pairs.
 *
 * Explicit `node.neighbors` (or `adjacency: 'manual'`) takes precedence and
 * REPLACES grid derivation — an authored override is how doorways get walled
 * off. Otherwise neighbors come from `cell` adjacency: 4-way (grid4, default)
 * or 8-way (grid8, diagonals). Bearings always come from the two nodes'
 * actual world positions, never from the compass key or the grid axes — so a
 * rotated / non-uniform grid still steps visually correctly.
 */
export function resolveNeighbors(node: WalkNode, graph: WalkGraph): WalkNeighbor[] {
  const out: WalkNeighbor[] = [];
  const seen = new Set<string>();
  const push = (nb: WalkNode | undefined) => {
    if (!nb || nb.id === node.id || seen.has(nb.id)) return;
    seen.add(nb.id);
    out.push({ node: nb, bearing: yawBearing(node.position, nb.position) });
  };

  if (node.neighbors || graph.adjacency === 'manual') {
    for (const id of Object.values(node.neighbors ?? {})) {
      if (id) push(findWalkNode(graph, id));
    }
    return out;
  }

  if (!node.cell) return out;
  const { row, col } = node.cell;
  const offsets: [number, number][] = graph.adjacency === 'grid8'
    ? [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]
    : [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of offsets) {
    push(nodeAtCell(graph, row + dr, col + dc));
  }
  return out;
}

/**
 * Pick the node a forward-step from `node` should land on, given the live
 * camera `yaw` (degrees, camera convention). Returns null when nothing
 * navigable lies within ±`thresholdDeg` of the facing direction (= wall).
 *
 * `node.yawOffset` (panorama north correction) is added to the live yaw
 * before matching, so an unaligned 360° image still steps where the user is
 * visually looking. Neighbors without an assigned panorama are fair targets —
 * the runtime shows a generated direction-guide placeholder for them
 * (walk-placeholder.ts), so authoring can be tested before any photo exists.
 */
export function stepForward(
  node: WalkNode,
  yaw: number,
  graph: WalkGraph,
  thresholdDeg = 45,
): WalkNode | null {
  const effectiveYaw = yaw + (node.yawOffset ?? 0);
  let best: WalkNode | null = null;
  let bestErr = thresholdDeg;
  for (const nb of resolveNeighbors(node, graph)) {
    if (nb.node.excluded) continue; // VR 範囲外 (gray) — walls / outside
    const err = Math.abs(angleDiffDeg(effectiveYaw, nb.bearing));
    if (err < bestErr) {
      bestErr = err;
      best = nb.node;
    }
  }
  return best;
}

// ── Grid labels (authoring / display) ────────────────────────────────────────

/** Spreadsheet-style label for index i: A..Z, AA..AZ, BA.. */
export function gridAxisLabel(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Node label for a cell: letter-letter pairs `rowLetter + colLetter` —
 *  `AA AB AC / BA BB BC / …` (both axes spreadsheet letters). Honors authored
 *  `rows` / `cols` label arrays when present. */
export function cellLabel(graph: WalkGraph, row: number, col: number): string {
  const r = graph.rows?.[row] ?? gridAxisLabel(row);
  const c = graph.cols?.[col] ?? gridAxisLabel(col);
  return `${r}${c}`;
}
