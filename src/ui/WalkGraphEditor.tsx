import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FloorPlanConfig, Plan, Vec2, WalkGraph, WalkNode } from '../core/types';
import { cellLabel, findWalkNode, stepForward } from '../core/walk-graph';
import { resolveScenePath } from '../core/scene-manifest';
import { useCameraStore } from '../store/camera-store';
import * as idb from '../utils/idb';
import { tokens } from './design-tokens';

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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);
  /** Non-null while dragging a node dot; suppresses the click-to-place that
   *  follows pointer-up (same phantom-click mechanism as FloorPlanMiniMap). */
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const liveYaw = useCameraStore((s) => s.yaw);

  const selected = selectedId ? findWalkNode(walk, selectedId) : undefined;

  // ── Geometry: same bounds mapping as the other plan-map views ──
  const bounds = floorPlan.bounds;
  const worldW = bounds.max[0] - bounds.min[0];
  const worldH = bounds.max[1] - bounds.min[1];
  const H = 300; // canvas height in px — dock is horizontal, width follows aspect
  const aspect = worldW / worldH || 1;
  const dH = H, dW = Math.max(220, H * aspect);
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

  const svgPt = (e: React.MouseEvent | React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (dW / r.width), y: (e.clientY - r.top) * (dH / r.height) };
  };

  const commit = (patch: Partial<WalkGraph>) => onChange({ ...walk, ...patch });
  const updateNode = (id: string, patch: Partial<WalkNode>) =>
    commit({ nodes: nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });

  // ── Placement / selection ──
  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragRef.current?.moved) { dragRef.current = null; return; } // drag tail — not a place
    dragRef.current = null;
    const pt = svgPt(e);
    const w = toWorld(pt.x, pt.y);
    const { row, col } = cellAt(w);
    const existing = nodes.find((n) => n.cell && n.cell.row === row && n.cell.col === col);
    if (existing) { setSelectedId(existing.id); return; }
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
    };
    commit({ nodes: [...nodes, node], startNodeId: walk.startNodeId ?? id });
    setSelectedId(id);
  };

  // ── Node dot drag (pointer events + capture) ──
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { id, moved: false };
    setSelectedId(id);
  };
  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    d.moved = true;
    const pt = svgPt(e);
    const w = toWorld(pt.x, pt.y);
    const cell = cellAt(w);
    const pos = snap ? cellCenter(cell.row, cell.col) : w;
    const node = findWalkNode(walk, d.id);
    if (!node) return;
    updateNode(d.id, { position: [pos[0], node.position[1], pos[1]], cell });
  };
  const onNodePointerUp = () => {
    // Keep dragRef until the trailing svg click consumes `moved` (phantom-click guard).
    if (dragRef.current && !dragRef.current.moved) dragRef.current = null;
  };

  // ── Selected-node actions ──
  const assignPanorama = async (file: File) => {
    if (!selected) return;
    const key = `walkpano:${sceneId}:${plan.id}:${selected.id}`;
    await idb.saveBlob(key, file);
    const ref = `${idb.IDB_REF_PREFIX}${key}`;
    updateNode(selected.id, { panorama: ref });
    onPreviewNode({ ...selected, panorama: ref });
  };
  const removeNode = (id: string) => {
    // Also scrub explicit-neighbor references so the graph never dangles.
    const nextNodes = nodes.filter((n) => n.id !== id).map((n) => {
      if (!n.neighbors) return n;
      const entries = Object.entries(n.neighbors).filter(([, v]) => v !== id);
      return { ...n, neighbors: entries.length ? Object.fromEntries(entries) : undefined };
    });
    commit({ nodes: nextNodes, startNodeId: walk.startNodeId === id ? nextNodes[0]?.id : walk.startNodeId });
    if (selectedId === id) setSelectedId(null);
  };
  const testStep = () => {
    if (!selected) return;
    const target = stepForward(selected, liveYaw, walk);
    if (!target) { setTestMsg('→ 壁（±45°内に移動先なし）'); return; }
    setTestMsg(`→ ${target.id} へ前進`);
    setSelectedId(target.id);
    if (target.panorama) onPreviewNode(target);
  };

  const assignedCount = nodes.filter((n) => n.panorama).length;

  const dock = (
    <div style={{ ...ST.dock, height: collapsed ? 40 : undefined }}>
      {/* Header */}
      <div style={ST.header}>
        <span style={ST.title}>ウォークスルー編集</span>
        <span style={ST.stat}>ノード {nodes.length}（画像 {assignedCount}/{nodes.length}）</span>
        <label style={ST.ctl} title="ノードをセル中心に吸着">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />スナップ
        </label>
        <label style={ST.ctl} title="セル寸法 (m)">
          セル
          <input
            type="number" min={0.25} max={5} step={0.25} value={cellSize}
            onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v > 0) commit({ cellSize: v }); }}
            style={ST.numInput}
          />m
        </label>
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
        <div style={{ flex: 1 }} />
        <button type="button" style={ST.headBtn} onClick={() => setCollapsed((v) => !v)}>{collapsed ? '▲ 開く' : '▼ たたむ'}</button>
        <button type="button" style={ST.headBtn} onClick={onClose}>✕ 閉じる</button>
      </div>

      {!collapsed && (
        <div style={ST.body}>
          {/* Map canvas */}
          <div style={{ ...ST.canvasWrap, width: dW, height: dH }}>
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
                const isSel = n.id === selectedId;
                const isStart = n.id === (walk.startNodeId ?? nodes[0]?.id);
                const fill = n.panorama ? '#22c55e' : 'rgba(120,120,130,0.85)';
                return (
                  <g key={n.id} style={{ cursor: 'grab' }}
                    onPointerDown={(e) => onNodePointerDown(e, n.id)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={onNodePointerUp}
                  >
                    {isSel && <circle cx={cx} cy={cy} r={11} fill="none" stroke={tokens.color.accent} strokeWidth={2} />}
                    <circle cx={cx} cy={cy} r={7} fill={fill} stroke="#fff" strokeWidth={1.5} />
                    <text x={cx} y={cy - 11} textAnchor="middle" fontSize={10} fontWeight={700}
                      fill={isSel ? tokens.color.accent : 'rgba(31,41,55,0.85)'}
                      stroke="rgba(255,255,255,0.85)" strokeWidth={2.5} paintOrder="stroke">
                      {isStart ? '🏁' : ''}{n.id}
                    </text>
                  </g>
                );
              })}
            </svg>
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
                {selected.panorama && (
                  <button type="button" style={ST.btn} onClick={() => onPreviewNode(selected)}>👁 メインビューに表示</button>
                )}
                <label style={ST.panelRow} title="パノラマの北向き補正（撮影時の機首方位、度）。前進判定の yaw に加算">
                  北補正
                  <input type="number" min={-180} max={360} step={1} value={selected.yawOffset ?? 0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) updateNode(selected.id, { yawOffset: v || undefined }); }}
                    style={ST.numInput} />°
                </label>
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
                <button type="button" style={{ ...ST.btn, color: '#b91c1c' }} onClick={() => removeNode(selected.id)}>🗑 削除</button>
              </>
            ) : (
              <div style={ST.panelEmpty}>
                セルをクリックしてノードを配置。<br />
                ドットをドラッグで微調整（スナップ {snap ? 'ON' : 'OFF'}）。<br />
                緑 = 360°画像 割当済み / 灰 = 未割当。<br />
                未割当ノードへは前進できません。
              </div>
            )}
            {nodes.length > 0 && (
              <button type="button" style={{ ...ST.btn, marginTop: 'auto', color: '#b91c1c' }}
                onClick={() => { if (confirm(`全 ${nodes.length} ノードを削除しますか？（割当画像の参照も消えます）`)) { onChange(undefined); setSelectedId(null); } }}>
                全ノード削除
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
    borderBottom: `1px solid ${tokens.color.border}`,
    fontSize: 12,
    color: tokens.color.text,
  },
  title: { fontWeight: 700, letterSpacing: 0.3 },
  stat: { fontSize: 11, color: tokens.color.textMute },
  ctl: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: tokens.color.textMute },
  numInput: {
    width: 56,
    padding: '2px 4px',
    fontSize: 11.5,
    fontFamily: tokens.font.mono,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.glass.surface,
    color: tokens.color.text,
  },
  select: {
    padding: '2px 4px',
    fontSize: 11.5,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.glass.surface,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
  },
  headBtn: {
    padding: '4px 10px',
    fontSize: 11.5,
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
    fontSize: 11.5,
    color: tokens.color.text,
  },
  panelTitle: { fontWeight: 700, fontSize: 13 },
  panelRow: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: tokens.color.textMute },
  mono: { fontFamily: tokens.font.mono, fontSize: 10.5 },
  btn: {
    padding: '6px 10px',
    fontSize: 11.5,
    textAlign: 'left',
    background: tokens.gradient.surface,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  testMsg: { fontSize: 11, color: tokens.color.accent, fontWeight: 600 },
  panelEmpty: { fontSize: 11, color: tokens.color.textMute, lineHeight: 1.7 },
};
