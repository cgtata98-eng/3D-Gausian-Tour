import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FloorPlanConfig, Plan, Vec2, WalkGraph, WalkNode } from '../core/types';
import { cellLabel, findWalkNode, stepForward } from '../core/walk-graph';
import { resolveScenePath } from '../core/scene-manifest';
import { useCameraStore } from '../store/camera-store';
import * as idb from '../utils/idb';
import { tokens } from './design-tokens';
import { surfaceClass, IconTrash } from './components';

/** Destructive controls — same shell as everywhere else, rather than `ST.btn`
 *  with a `#b91c1c` text colour bolted on. */
const DANGER_BTN = `${surfaceClass('danger')} ds-pill ds-pill--sm`;

/** Matches FloorPlanMiniMap / CollisionWallEditor so all three plan-map views
 *  share the same world↔map calibration. */
const PADDING = 20;

const DEFAULT_CELL_SIZE = 1.0; // meters

interface Props {
  sceneId: string;
  plan: Plan;
  floorPlan: FloorPlanConfig;
  /** Eye level for node positions (VR 360° — no floor collision needed). */
  cameraHeight: number;
  onChange: (walk: WalkGraph | undefined) => void;
  /** Show a node's panorama in the main view (360 mode). */
  onPreviewNode: (node: WalkNode) => void;
  onClose: () => void;
}

/**
 * C7: dense-walkthrough authoring dock (VR 360° mode). Renders the plan's
 * floor-plan image with a meter grid at the bottom of the screen; the author
 * clicks cells to place `WalkNode`s, drags dots to fine-tune, assigns a 360°
 * image per node, and test-walks the graph (前進 = stepForward with the live
 * camera yaw).
 *
 * Writes ONLY `plan.walk` via onChange. Curated viewpoints, mapYaw, and the
 * live camera are never touched — node transitions preserve the live facing.
 *
 * Rendered through createPortal(document.body): position:fixed inside the
 * DebugViewer layout gets trapped by an ancestor's backdrop-filter.
 */
export function WalkGraphEditor({ sceneId, plan, floorPlan, cameraHeight, onChange, onPreviewNode, onClose }: Props) {
  const walk: WalkGraph = plan.walk ?? { nodes: [], adjacency: 'grid4', cellSize: DEFAULT_CELL_SIZE };
  const nodes = walk.nodes;
  const cellSize = walk.cellSize ?? DEFAULT_CELL_SIZE;
  const adjacency = walk.adjacency ?? 'grid4';

  /** Multi-select: marquee drag / Shift+click accumulate; size 1 = detail panel. */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  /** The node currently shown in the main view — gets an orange ring. */
  const [previewedId, setPreviewedId] = useState<string | null>(null);
  /** Tool: 選択 (marquee) / 青ペン (include) / グレーペン (exclude). */
  const [paintMode, setPaintMode] = useState<'select' | 'add' | 'erase'>('select');
  /** Live paint preview during a drag: nodeId → excluded. Committed on pointer-up. */
  const [pendingPaint, setPendingPaint] = useState<Map<string, boolean> | null>(null);
  /** Rubber-band rectangle while dragging in 選択 mode (svg coords). */
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [snap, setSnap] = useState(true);
  const selectOne = (id: string | null) => setSelectedIds(id ? new Set([id]) : new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  /** Map zoom/pan: CSS transform on the img+svg stack. svgPt maps through the
   *  svg's live bounding rect, so pointer math is zoom-agnostic for free. */
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 });
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Esc = 選択解除
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedIds(new Set()); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);
  /** Non-null while panning the map; suppresses the trailing click-to-place. */
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const liveYaw = useCameraStore((s) => s.yaw);

  const selected = selectedIds.size === 1 ? findWalkNode(walk, selectedIds.values().next().value as string) : undefined;

  // ── Geometry: same bounds mapping as the other plan-map views ──
  const bounds = floorPlan.bounds;
  const worldW = bounds.max[0] - bounds.min[0];
  const worldH = bounds.max[1] - bounds.min[1];
  const aspect = worldW / worldH || 1;
  // Dock mode: fixed 300px strip (width follows aspect, may scroll).
  // Expanded mode: fit the whole map into the viewport — height AND width.
  const availH = vp.h - 150; // header + paddings + dock margins
  const availW = vp.w - 12 * 2 - 12 * 2 - 250 - 12; // dock margins + body padding + side panel + gap
  const dH = expanded ? Math.max(220, Math.min(availH, availW / aspect)) : 300;
  const dW = Math.max(220, dH * aspect);
  const toMX = (wx: number) => PADDING + ((wx - bounds.min[0]) / worldW) * (dW - PADDING * 2);
  const toMY = (wz: number) => PADDING + ((wz - bounds.min[1]) / worldH) * (dH - PADDING * 2);
  const toWorld = (mx: number, my: number): Vec2 => [
    +(bounds.min[0] + ((mx - PADDING) / (dW - PADDING * 2)) * worldW).toFixed(3),
    +(bounds.min[1] + ((my - PADDING) / (dH - PADDING * 2)) * worldH).toFixed(3),
  ];
  const imageUrl = floorPlan.image.startsWith('data:') ? floorPlan.image : resolveScenePath(sceneId, floorPlan.image);

  const cols = Math.max(1, Math.round(worldW / cellSize));
  const rows = Math.max(1, Math.round(worldH / cellSize));
  const cellAt = (w: Vec2) => ({
    col: Math.min(cols - 1, Math.max(0, Math.floor((w[0] - bounds.min[0]) / cellSize))),
    row: Math.min(rows - 1, Math.max(0, Math.floor((w[1] - bounds.min[1]) / cellSize))),
  });
  const cellCenter = (row: number, col: number): Vec2 => [
    +(bounds.min[0] + (col + 0.5) * cellSize).toFixed(3),
    +(bounds.min[1] + (row + 0.5) * cellSize).toFixed(3),
  ];
  /** Cell → node lookup derived from POSITION (never the stored `cell`, which
   *  can be stale after a grid-size change) so hit-testing always matches what
   *  is drawn on screen. */
  const cellKey = (r: number, c: number) => `${r}:${c}`;
  const nodeByCell = new Map<string, WalkNode>();
  for (const n of nodes) {
    const cd = cellAt([n.position[0], n.position[2]]);
    if (!nodeByCell.has(cellKey(cd.row, cd.col))) nodeByCell.set(cellKey(cd.row, cd.col), n);
  }
  /** Pixel rect of a cell (map coords). */
  const cellRect = (row: number, col: number) => {
    const x = toMX(bounds.min[0] + col * cellSize);
    const y = toMY(bounds.min[1] + row * cellSize);
    return {
      x, y,
      w: toMX(bounds.min[0] + (col + 1) * cellSize) - x,
      h: toMY(bounds.min[1] + (row + 1) * cellSize) - y,
    };
  };

  // ── Map zoom (wheel, cursor-anchored) + pan (drag) ──
  // Native listener: React's onWheel is passive, so preventDefault would warn.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        const z = Math.min(8, Math.max(1, v.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
        if (z === v.z) return v;
        const k = z / v.z;
        return {
          z,
          tx: Math.min(0, Math.max(dW - dW * z, cx - (cx - v.tx) * k)),
          ty: Math.min(0, Math.max(dH - dH * z, cy - (cy - v.ty) * k)),
        };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [dW, dH, collapsed]);
  // Canvas size changed (expand toggle / window resize) → the old translation
  // no longer fits its clamp range; start over from 100%.
  useEffect(() => { setView({ z: 1, tx: 0, ty: 0 }); }, [dW, dH]);

  /** client (native event) → svg coordinate space, zoom-agnostic. */
  const clientToSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: (clientX - r.left) * (dW / r.width), y: (clientY - r.top) * (dH / r.height) };
  };

  const paintAt = (clientX: number, clientY: number, acc: Map<string, boolean>) => {
    const p = clientToSvg(clientX, clientY);
    const cell = cellAt(toWorld(p.x, p.y));
    const node = nodeByCell.get(cellKey(cell.row, cell.col));
    if (!node) return;
    const excluded = paintMode === 'erase';
    if (acc.get(node.id) === excluded) return;
    acc.set(node.id, excluded);
    setPendingPaint(new Map(acc));
  };

  const startPaint = (e: React.PointerEvent) => {
    const acc = new Map<string, boolean>();
    let last = { x: e.clientX, y: e.clientY };
    paintAt(e.clientX, e.clientY, acc);
    // Interpolate along the drag segment (every ~4 client px) so a fast stroke
    // paints every cell it crosses instead of skipping between pointer events.
    const onMove = (ev: PointerEvent) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(ev.clientX - last.x, ev.clientY - last.y) / 4));
      for (let i = 1; i <= steps; i++) {
        paintAt(last.x + ((ev.clientX - last.x) * i) / steps, last.y + ((ev.clientY - last.y) * i) / steps, acc);
      }
      last = { x: ev.clientX, y: ev.clientY };
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (acc.size) {
        commit({
          nodes: nodes.map((n) =>
            acc.has(n.id) ? { ...n, excluded: acc.get(n.id) ? true : false } : n),
        });
      }
      setPendingPaint(null);
      // Suppress the trailing click so it doesn't select / place.
      panRef.current = { x: 0, y: 0, tx: 0, ty: 0, moved: true };
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startPan = (e: React.PointerEvent) => {
    panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    const onMove = (ev: PointerEvent) => {
      const p = panRef.current;
      if (!p) return;
      const dx = ev.clientX - p.x;
      const dy = ev.clientY - p.y;
      if (!p.moved && Math.hypot(dx, dy) < 4) return;
      p.moved = true;
      setView((v) => ({
        z: v.z,
        tx: Math.min(0, Math.max(dW - dW * v.z, p.tx + dx)),
        ty: Math.min(0, Math.max(dH - dH * v.z, p.ty + dy)),
      }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Keep `moved` until the trailing svg click consumes it (phantom-click guard).
      if (panRef.current && !panRef.current.moved) panRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** 選択モードの左ドラッグ = 矩形複数選択 (Shift で追加)。 */
  const startMarquee = (e: React.PointerEvent) => {
    const start = clientToSvg(e.clientX, e.clientY);
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      const p = clientToSvg(ev.clientX, ev.clientY);
      setMarquee({ x1: start.x, y1: start.y, x2: p.x, y2: p.y });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setMarquee(null);
      if (!moved) return; // plain click → svg/node onClick handles it
      const p = clientToSvg(ev.clientX, ev.clientY);
      const minX = Math.min(start.x, p.x);
      const maxX = Math.max(start.x, p.x);
      const minY = Math.min(start.y, p.y);
      const maxY = Math.max(start.y, p.y);
      // Cell-overlap selection: a cell counts only when the rectangle covers
      // ≥30% of it — grazing a neighboring row/col by a few px no longer
      // sweeps in the whole line of cells.
      const ids = nodes
        .filter((n) => {
          const cd = cellAt([n.position[0], n.position[2]]);
          const r = cellRect(cd.row, cd.col);
          const ox = Math.max(0, Math.min(r.x + r.w, maxX) - Math.max(r.x, minX));
          const oy = Math.max(0, Math.min(r.y + r.h, maxY) - Math.max(r.y, minY));
          return ox * oy >= 0.3 * r.w * r.h;
        })
        .map((n) => n.id);
      setSelectedIds((prev) => (ev.shiftKey ? new Set([...prev, ...ids]) : new Set(ids)));
      panRef.current = { x: 0, y: 0, tx: 0, ty: 0, moved: true }; // suppress trailing click
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onWrapPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault(); // no middle-click autoscroll
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    if (paintMode !== 'select') startPaint(e);
    else startMarquee(e);
  };

  const svgPt = (e: React.MouseEvent | React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (dW / r.width), y: (e.clientY - r.top) * (dH / r.height) };
  };

  const commit = (patch: Partial<WalkGraph>) => onChange({ ...walk, ...patch });
  const updateNode = (id: string, patch: Partial<WalkNode>) =>
    commit({ nodes: nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });

  // ── Rebuild the graph as a clean full grid: exactly ONE node per cell, every
  //    node carries its cell's canonical label. Existing nodes are re-binned by
  //    position; when two land in the same cell (stale nodes from an old grid
  //    size) the one WITH a panorama wins. Kills the "NM-2" duplicate-label
  //    mess a cellSize change used to leave behind. Panoramas survive renames —
  //    their idb blobs are re-keyed to the new node id so a later drop on the
  //    old label can't clobber them. ──
  const fillAllCells = async () => {
    const byCell = new Map<string, WalkNode>();
    for (const n of nodes) {
      const cell = cellAt([n.position[0], n.position[2]]);
      const k = `${cell.row}:${cell.col}`;
      const prev = byCell.get(k);
      if (!prev || (!prev.panorama && n.panorama)) byCell.set(k, n);
    }
    const nextNodes: WalkNode[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const existing = byCell.get(`${row}:${col}`);
        const id = cellLabel(walk, row, col);
        const pos = cellCenter(row, col);
        // 範囲 (excluded) の引き継ぎ: 画像あり or 明示的に青塗り済みなら範囲内、
        // それ以外 (新規セル含む) は範囲外 (gray) で始める。
        const excluded = existing?.panorama ? false : existing?.excluded === false ? false : true;
        // Manual `neighbors` maps reference pre-rename ids — drop them; grid
        // adjacency re-derives from cells.
        nextNodes.push({
          id,
          cell: { row, col },
          position: [pos[0], existing?.position[1] ?? cameraHeight, pos[1]],
          ...(excluded ? { excluded: true } : { excluded: false }),
          ...(existing?.panorama ? { panorama: existing.panorama } : {}),
          ...(existing?.yawOffset ? { yawOffset: existing.yawOffset } : {}),
        });
      }
    }
    // Re-key renamed panorama blobs so future drops on the old id can't overwrite them.
    for (const n of nextNodes) {
      if (!n.panorama?.startsWith(idb.IDB_REF_PREFIX)) continue;
      const oldKey = n.panorama.slice(idb.IDB_REF_PREFIX.length);
      const wantKey = `walkpano:${sceneId}:${plan.id}:${n.id}`;
      if (oldKey === wantKey) continue;
      const blob = await idb.loadBlob(oldKey);
      if (blob) {
        await idb.saveBlob(wantKey, blob);
        n.panorama = `${idb.IDB_REF_PREFIX}${wantKey}`;
      }
    }
    // Start node follows its cell's new canonical label.
    const oldStart = nodes.find((n) => n.id === walk.startNodeId);
    const startCell = oldStart ? cellAt([oldStart.position[0], oldStart.position[2]]) : null;
    const startNodeId = startCell ? cellLabel(walk, startCell.row, startCell.col) : nextNodes[0]?.id;
    selectOne(null);
    commit({ nodes: nextNodes, startNodeId });
    setTestMsg(`⊞ ${rows}×${cols} = ${nextNodes.length} セルに整理配置`);
  };

  // Changing the cell size re-bins every node into the new grid so adjacency
  // (nodeAtCell) stays consistent with what's drawn on screen.
  const changeCellSize = (v: number) => {
    const c = Math.max(1, Math.round(worldW / v));
    const r = Math.max(1, Math.round(worldH / v));
    const cellFor = (x: number, z: number) => ({
      col: Math.min(c - 1, Math.max(0, Math.floor((x - bounds.min[0]) / v))),
      row: Math.min(r - 1, Math.max(0, Math.floor((z - bounds.min[1]) / v))),
    });
    commit({
      cellSize: v,
      nodes: nodes.map((n) => ({ ...n, cell: cellFor(n.position[0], n.position[2]) })),
    });
  };

  // Open with the grid already populated — an empty graph auto-fills once
  // (guarded so huge grids from a tiny cellSize don't explode node count).
  const autoFilled = useRef(false);
  useEffect(() => {
    if (autoFilled.current || nodes.length > 0 || rows * cols > 2500) return;
    autoFilled.current = true;
    void fillAllCells();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Placement / selection ──
  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (panRef.current?.moved) { panRef.current = null; return; } // pan tail — not a place
    const pt = svgPt(e);
    const w = toWorld(pt.x, pt.y);
    const { row, col } = cellAt(w);
    const existing = nodeByCell.get(cellKey(row, col));
    if (existing) { selectOne(existing.id); return; }
    // New node at the cell center (snap) or the click point (free).
    const pos = snap ? cellCenter(row, col) : w;
    let id = cellLabel(walk, row, col);
    if (findWalkNode(walk, id)) { // duplicate label guard (free-placed nodes can share a cell)
      let i = 2;
      while (findWalkNode(walk, `${id}-${i}`)) i++;
      id = `${id}-${i}`;
    }
    const node: WalkNode = {
      id,
      cell: { row, col },
      position: [pos[0], cameraHeight, pos[1]],
      excluded: false, // explicitly placed = part of the walk range (blue)
    };
    commit({ nodes: [...nodes, node], startNodeId: walk.startNodeId ?? id });
    selectOne(id);
  };

  // ── Selected-node actions ──
  const assignPanorama = async (file: File) => {
    if (!selected) return;
    const key = `walkpano:${sceneId}:${plan.id}:${selected.id}`;
    await idb.saveBlob(key, file);
    const ref = `${idb.IDB_REF_PREFIX}${key}`;
    updateNode(selected.id, { panorama: ref, excluded: false }); // image assigned → part of the range
    onPreviewNode({ ...selected, panorama: ref });
    setPreviewedId(selected.id);
  };
  // ── Drag & drop panorama assignment ──
  // 1 file → the node in the cell under the cursor. Multiple files → sorted by
  // filename (numeric-aware) and assigned row-major starting at the drop cell,
  // skipping deleted cells — the bulk path for 100+ panorama shoots.
  const onCanvasDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    const pt = svgPt(e);
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const start = cellAt(toWorld(pt.x, pt.y));
    const ordered = nodes
      .filter((n) => n.cell)
      .sort((a, b) => (a.cell!.row - b.cell!.row) || (a.cell!.col - b.cell!.col));
    let targets: WalkNode[];
    if (files.length === 1) {
      const exact = ordered.find((n) => n.cell!.row === start.row && n.cell!.col === start.col);
      targets = exact ? [exact] : [];
    } else {
      const startIdx = ordered.findIndex(
        (n) => n.cell!.row > start.row || (n.cell!.row === start.row && n.cell!.col >= start.col),
      );
      targets = startIdx < 0 ? [] : ordered.slice(startIdx, startIdx + files.length);
    }
    if (!targets.length) { setTestMsg('ドロップ先のセルにノードがありません'); return; }
    const refs = new Map<string, string>();
    for (let i = 0; i < targets.length; i++) {
      const key = `walkpano:${sceneId}:${plan.id}:${targets[i].id}`;
      await idb.saveBlob(key, files[i]);
      refs.set(targets[i].id, `${idb.IDB_REF_PREFIX}${key}`);
    }
    commit({ nodes: nodes.map((n) => (refs.has(n.id) ? { ...n, panorama: refs.get(n.id)!, excluded: false } : n)) });
    selectOne(targets[0].id);
    setTestMsg(targets.length === 1
      ? `🖼 ${targets[0].id} に割り当て`
      : `🖼 ${targets.length} 枚を ${targets[0].id} から行順に割り当て`);
    // Immediate feedback: show the first dropped panorama in the main view.
    onPreviewNode({ ...targets[0], panorama: refs.get(targets[0].id)! });
    setPreviewedId(targets[0].id);
  };

  const removeNodes = (ids: ReadonlySet<string>) => {
    // Also scrub explicit-neighbor references so the graph never dangles.
    const nextNodes = nodes.filter((n) => !ids.has(n.id)).map((n) => {
      if (!n.neighbors) return n;
      const entries = Object.entries(n.neighbors).filter(([, v]) => v && !ids.has(v));
      return { ...n, neighbors: entries.length ? Object.fromEntries(entries) : undefined };
    });
    commit({
      nodes: nextNodes,
      startNodeId: ids.has(walk.startNodeId ?? '') ? nextNodes[0]?.id : walk.startNodeId,
    });
    selectOne(null);
  };

  /** 複数選択への一括 範囲IN/OUT。 */
  const setRangeFor = (ids: ReadonlySet<string>, excluded: boolean) =>
    commit({ nodes: nodes.map((n) => (ids.has(n.id) ? { ...n, excluded } : n)) });
  const testStep = () => {
    if (!selected) return;
    const target = stepForward(selected, liveYaw, walk);
    if (!target) { setTestMsg('→ 壁（±45°内に移動先なし）'); return; }
    setTestMsg(`→ ${target.id} へ前進${target.panorama ? '' : '（仮画像）'}`);
    selectOne(target.id);
    onPreviewNode(target); // imageless nodes show the direction-guide placeholder
    setPreviewedId(target.id);
    setExpanded(false); // shrink so the view is visible
  };

  const assignedCount = nodes.filter((n) => n.panorama).length;

  const dock = (
    <div style={{ ...ST.dock, top: expanded && !collapsed ? 12 : undefined, height: collapsed ? 40 : undefined }}>
      {/* Header */}
      <div style={ST.header}>
        <span style={ST.title}>ウォークスルー編集</span>
        <span style={ST.stat}>ノード {nodes.length}（画像 {assignedCount}/{nodes.length}）</span>
        <label style={ST.ctl} title="ノードをセル中心に吸着">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />スナップ
        </label>
        <label style={ST.ctl} title="セル寸法 (m)。小さくするほどグリッドが細かくなる">
          セル
          <input
            type="number" min={0.1} max={5} step={0.05} value={cellSize}
            onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v > 0) changeCellSize(v); }}
            style={ST.numInput}
          />m
        </label>
        <label style={ST.ctl} title="グリッドの列数を直接指定（セル寸法を自動計算）">
          分割
          <input
            type="number" min={2} max={100} step={1} value={cols}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 2 && v <= 200) changeCellSize(+(worldW / v).toFixed(3));
            }}
            style={ST.numInput}
          />列 × {rows}行
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            { k: 'select', label: '🖱 選択', tip: 'クリック選択 / ドラッグで矩形複数選択 (Shift で追加)' },
            { k: 'add', label: '🔵 青ペン', tip: 'ドラッグしたセルを歩ける範囲 (青) にする' },
            { k: 'erase', label: '⚪ グレーペン', tip: 'ドラッグしたセルを範囲外 (灰・進入不可) にする' },
          ] as const).map((t) => (
            <button key={t.k} type="button" title={t.tip}
              style={{
                ...ST.headBtn,
                ...(paintMode === t.k
                  ? { background: 'rgba(61,142,197,0.18)', borderColor: tokens.color.accent, fontWeight: tokens.font.weight.strong }
                  : {}),
              }}
              onClick={() => setPaintMode(t.k)}>
              {t.label}
            </button>
          ))}
        </div>
        {selectedIds.size > 0 && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ ...ST.stat, color: tokens.color.accent, fontWeight: tokens.font.weight.strong }}>選択 {selectedIds.size}</span>
            <button type="button" style={ST.headBtn} title="選択セルを歩ける範囲 (青) にする"
              onClick={() => setRangeFor(selectedIds, false)}>🔵 青に</button>
            <button type="button" style={ST.headBtn} title="選択セルを範囲外 (灰・進入不可) にする"
              onClick={() => setRangeFor(selectedIds, true)}>⚪ 灰に</button>
            <button type="button" style={ST.headBtn} title="選択解除 (Esc)"
              onClick={() => selectOne(null)}>✕ 解除</button>
          </div>
        )}
        <label style={ST.ctl} title="隣接の自動生成方式。manual = 各ノードの明示指定のみ">
          隣接
          <select
            value={adjacency}
            onChange={(e) => commit({ adjacency: e.target.value as WalkGraph['adjacency'] })}
            style={ST.select}
          >
            <option value="grid4">grid4（上下左右）</option>
            <option value="grid8">grid8（斜めも）</option>
            <option value="manual">manual</option>
          </select>
        </label>
        <button type="button" style={ST.headBtn} onClick={() => void fillAllCells()}
          title="全セルを 1 セル 1 ノードに整理し直す。重複・古いラベルを解消（画像割当は保持、重複セルは画像持ち優先）">
          ⊞ 全セル配置
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" style={ST.headBtn} onClick={() => setExpanded((v) => !v)} title="地図を画面いっぱいに表示">
          {expanded ? '⤡ 縮小' : '⛶ 拡大'}
        </button>
        <button type="button" style={ST.headBtn} onClick={() => setCollapsed((v) => !v)}>{collapsed ? '▲ 開く' : '▼ たたむ'}</button>
        <button type="button" style={ST.headBtn} onClick={onClose}>✕ 閉じる</button>
      </div>

      {!collapsed && (
        <div style={{ ...ST.body, flex: 1, minHeight: 0, justifyContent: expanded ? 'center' : undefined }}>
          {/* Map canvas */}
          <div
            ref={wrapRef}
            style={{ ...ST.canvasWrap, width: dW, height: dH, boxShadow: dragOver ? `0 0 0 3px ${tokens.color.accent}` : undefined }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => void onCanvasDrop(e)}
            onPointerDown={onWrapPointerDown}
          >
            <div style={{ position: 'absolute', inset: 0, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`, transformOrigin: '0 0' }}>
            <img src={imageUrl} alt="floor plan" style={ST.image} draggable={false} />
            <svg ref={svgRef} width={dW} height={dH} viewBox={`0 0 ${dW} ${dH}`} style={ST.svg} onClick={onSvgClick}>
              {/* Grid overlay */}
              {Array.from({ length: cols + 1 }, (_, c) => {
                const x = toMX(bounds.min[0] + c * cellSize);
                return <line key={`gc${c}`} x1={x} y1={toMY(bounds.min[1])} x2={x} y2={toMY(bounds.max[1])} stroke="rgba(61,142,197,0.25)" strokeWidth={0.75} />;
              })}
              {Array.from({ length: rows + 1 }, (_, r) => {
                const y = toMY(bounds.min[1] + r * cellSize);
                return <line key={`gr${r}`} x1={toMX(bounds.min[0])} y1={y} x2={toMX(bounds.max[0])} y2={y} stroke="rgba(61,142,197,0.25)" strokeWidth={0.75} />;
              })}
              {/* Nodes */}
              {nodes.map((n) => {
                const cx = toMX(n.position[0]);
                const cy = toMY(n.position[2]);
                const isSel = selectedIds.has(n.id);
                const isStart = n.id === (walk.startNodeId ?? nodes[0]?.id);
                // 灰 = 範囲外 (進入不可) / 青 = 歩ける範囲・画像なし (仮画像) / 緑 = 画像あり
                const excluded = pendingPaint?.get(n.id) ?? n.excluded;
                const fill = excluded ? 'rgba(120,120,130,0.85)' : n.panorama ? '#22c55e' : '#3b82f6';
                return (
                  <g key={n.id} style={{ cursor: paintMode === 'select' ? 'pointer' : 'crosshair' }}
                    onClick={(e) => {
                      if (paintMode !== 'select') return; // paint drags handle these cells
                      e.stopPropagation();
                      if (!panRef.current?.moved) {
                        if (e.shiftKey) {
                          setSelectedIds((prev) => {
                            const s = new Set(prev);
                            if (s.has(n.id)) s.delete(n.id); else s.add(n.id);
                            return s;
                          });
                        } else {
                          selectOne(n.id);
                        }
                      }
                      panRef.current = null;
                    }}
                  >
                    {/* Cell-sized hit area (position-derived cell, so it always
                        matches the drawn dot). Selected cells fill with accent —
                        the range is visible BEFORE applying 🔵/⚪ actions. */}
                    {(() => {
                      const cd = cellAt([n.position[0], n.position[2]]);
                      const r = cellRect(cd.row, cd.col);
                      return (
                        <rect x={r.x} y={r.y} width={r.w} height={r.h}
                          fill={isSel ? 'rgba(61,142,197,0.30)' : 'transparent'}
                          stroke={isSel ? tokens.color.accent : 'none'}
                          strokeWidth={isSel ? 1.5 : 0}
                        />
                      );
                    })()}
                    {n.id === previewedId && <circle cx={cx} cy={cy} r={14} fill="none" stroke="#f97316" strokeWidth={1.35} />}
                    <circle cx={cx} cy={cy} r={7} fill={fill} stroke="#fff" strokeWidth={1.35} />
                    <text x={cx} y={cy - 11} textAnchor="middle" fontSize={10} fontWeight={700}
                      style={{ pointerEvents: 'none' }}
                      fill={isSel ? tokens.color.accent : 'rgba(31,41,55,0.85)'}
                      stroke="rgba(255,255,255,0.85)" strokeWidth={1.35} paintOrder="stroke">
                      {isStart ? '🏁' : ''}{n.id}
                    </text>
                  </g>
                );
              })}
              {marquee && (
                <rect
                  x={Math.min(marquee.x1, marquee.x2)}
                  y={Math.min(marquee.y1, marquee.y2)}
                  width={Math.abs(marquee.x2 - marquee.x1)}
                  height={Math.abs(marquee.y2 - marquee.y1)}
                  fill="rgba(61,142,197,0.12)"
                  stroke={tokens.color.accent}
                  strokeWidth={1.35}
                  strokeDasharray="6 4"
                />
              )}
            </svg>
            </div>
            {view.z > 1 && (
              <button type="button" style={ST.zoomBadge} title="ズームをリセット (100%)"
                onClick={() => setView({ z: 1, tx: 0, ty: 0 })}>
                🔍 {Math.round(view.z * 100)}% ✕
              </button>
            )}
          </div>

          {/* Side panel */}
          <div style={ST.panel}>
            {selected ? (
              <>
                <div style={ST.panelTitle}>ノード {selected.id}</div>
                <div style={ST.panelRow}>
                  位置 <span style={ST.mono}>[{selected.position[0]}, {selected.position[2]}]</span>
                  {selected.cell && <span style={ST.mono}> cell({selected.cell.row},{selected.cell.col})</span>}
                </div>
                <button type="button" style={ST.btn} onClick={() => panoInputRef.current?.click()}>
                  {selected.panorama ? '🖼 360°画像を差し替え' : '🖼 360°画像を割り当て'}
                </button>
                <input ref={panoInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void assignPanorama(f); e.target.value = ''; }} />
                <button type="button" style={ST.btn}
                  onClick={() => { onPreviewNode(selected); setPreviewedId(selected.id); setExpanded(false); }}>
                  👁 メインビューに表示{selected.panorama ? '' : '（仮画像）'}
                </button>
                <label style={ST.panelRow} title="パノラマの北向き補正（撮影時の機首方位、度）。前進判定の yaw に加算">
                  北補正
                  <input type="number" min={-180} max={360} step={1} value={selected.yawOffset ?? 0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) updateNode(selected.id, { yawOffset: v || undefined }); }}
                    style={ST.numInput} />°
                </label>
                <button type="button" style={ST.btn}
                  onClick={() => updateNode(selected.id, { excluded: !selected.excluded })}>
                  {selected.excluded ? '🔵 歩ける範囲に含める' : '⚪ 範囲から外す（灰）'}
                </button>
                <button type="button" style={ST.btn}
                  disabled={walk.startNodeId === selected.id}
                  onClick={() => commit({ startNodeId: selected.id })}>
                  🏁 開始ノードにする
                </button>
                <button type="button" style={ST.btn} onClick={testStep}
                  title="ライブカメラの向き (yaw) で stepForward を実行し、遷移先を選択・表示">
                  ⤴ 前進テスト（現在の向き {Math.round(liveYaw)}°）
                </button>
                {testMsg && <div style={ST.testMsg}>{testMsg}</div>}
                <button type="button" className={DANGER_BTN} onClick={() => removeNodes(new Set([selected.id]))}><IconTrash />削除</button>
              </>
            ) : selectedIds.size > 1 ? (
              <>
                <div style={ST.panelTitle}>{selectedIds.size} ノード選択中</div>
                <button type="button" style={ST.btn} onClick={() => setRangeFor(selectedIds, false)}>
                  🔵 歩ける範囲に含める
                </button>
                <button type="button" style={ST.btn} onClick={() => setRangeFor(selectedIds, true)}>
                  ⚪ 範囲から外す（灰）
                </button>
                <button type="button" className={DANGER_BTN}
                  onClick={() => { if (confirm(`選択中の ${selectedIds.size} ノードを削除しますか？`)) removeNodes(selectedIds); }}>
                  <IconTrash />選択ノードを削除
                </button>
                <button type="button" style={ST.btn} onClick={() => selectOne(null)}>選択解除</button>
              </>
            ) : (
              <div style={ST.panelEmpty}>
                灰 = 範囲外（進入不可） / 青 = 歩ける範囲（仮画像で表示） / 緑 = 画像あり。<br />
                🔵 青ペン / ⚪ グレーペンでドラッグして範囲を塗り分け。<br />
                🖱 選択でドラッグ → 矩形複数選択（Shift+クリックで追加）。<br />
                橙リング = いまメインビューに表示中。<br />
                ホイールで拡大、パンは中ボタン or Alt+ドラッグ。<br />
                画像ファイルをセルへドラッグ&ドロップで割り当て（自動で範囲に入る）。<br />
                複数枚まとめてドロップ → ファイル名順に行方向へ連続割り当て。
              </div>
            )}
            {nodes.length > 0 && (
              <button type="button" className={DANGER_BTN} style={{ marginTop: 'auto' }}
                onClick={() => { if (confirm(`全 ${nodes.length} ノードを削除しますか？（割当画像の参照も消えます）`)) { onChange(undefined); selectOne(null); } }}>
                <IconTrash />全ノード削除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(dock, document.body);
}

const ST: Record<string, React.CSSProperties> = {
  dock: {
    position: 'fixed',
    left: 12,
    right: 12,
    bottom: 12,
    zIndex: 60,
    background: tokens.glass.surfaceStrong,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    boxShadow: tokens.shadow.dialog,
    overflow: 'hidden',
    fontFamily: tokens.font.family,
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 14px',
    borderBottom: `1px solid ${tokens.color.hairline}`,
    fontSize: 11.5,
    color: tokens.color.text,
  },
  title: { fontWeight: tokens.font.weight.strong, letterSpacing: 0.3 },
  stat: { fontSize: 10.5, color: tokens.color.textMute },
  ctl: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: tokens.color.textMute },
  numInput: {
    width: 56,
    padding: '2px 4px',
    fontSize: 10.5,
    fontFamily: tokens.font.mono,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.glass.surface,
    color: tokens.color.text,
  },
  select: {
    padding: '3px 10px',
    fontSize: tokens.font.size.xs,
    borderWidth: 0,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: tokens.radius.pill,
    background: tokens.gradient.track,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
    boxShadow: 'inset 0 2px 3px rgba(118,130,154,0.20), inset 0 -1.5px 1px rgba(255,255,255,0.90)',
    outline: 'none', cursor: 'pointer',
  },
  headBtn: {
    padding: '4px 10px',
    fontSize: 10.5,
    background: tokens.gradient.surface,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  body: { display: 'flex', gap: 12, padding: 12, alignItems: 'stretch', overflowX: 'auto' },
  canvasWrap: {
    position: 'relative',
    borderRadius: tokens.radius.sm,
    overflow: 'hidden',
    border: `1px solid ${tokens.color.border}`,
    background: '#f4f4f5',
    flexShrink: 0,
  },
  image: { position: 'absolute', inset: 0, width: '100%', height: '100%', userSelect: 'none' },
  svg: { position: 'absolute', top: 0, left: 0, cursor: 'crosshair' },
  panel: {
    width: 250,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 10.5,
    color: tokens.color.text,
  },
  panelTitle: { fontWeight: tokens.font.weight.strong, fontSize: 11.5 },
  panelRow: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: tokens.color.textMute },
  mono: { fontFamily: tokens.font.mono, fontSize: 9.5 },
  btn: {
    padding: '6px 10px',
    fontSize: 10.5,
    textAlign: 'left',
    background: tokens.gradient.surface,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  zoomBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 2,
    padding: '4px 10px',
    fontSize: 10.5,
    background: tokens.glass.surfaceStrong,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
    boxShadow: tokens.shadow.dialog,
  },
  testMsg: { fontSize: 10.5, color: tokens.color.accent, fontWeight: tokens.font.weight.strong },
  panelEmpty: { fontSize: 10.5, color: tokens.color.textMute, lineHeight: 1.7 },
};
