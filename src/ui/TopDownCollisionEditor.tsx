import { useEffect, useRef, useState } from 'react';
import type { CollisionWallData, Vec2 } from '../core/types';
import { tokens } from './design-tokens';

/** Manager surface the editor needs (PlayCanvas SceneManager provides all). */
export interface TopDownManager {
  worldToScreen: (w: [number, number, number]) => { x: number; y: number } | null;
  screenToPlanePoint: (x: number, y: number, planeY: number) => [number, number, number] | null;
  setSplatClipY: (y: number | null) => void;
  nudgeTopDownCamera: (dx: number, dy: number, dz: number) => void;
  getLiveCameraPose: () => { position: [number, number, number]; fov: number };
}

const DEFAULT_WALLS: CollisionWallData = {
  segments: [],
  floorPolygon: undefined,
  wallHeight: 2.5,
  wallThickness: 0.1,
  floorY: 0,
};

type EditMode = 'wall' | 'floor' | 'erase';

interface Props {
  getManager: () => TopDownManager | null;
  walls: CollisionWallData | undefined;
  onChange: (walls: CollisionWallData) => void;
  onGenerate: (walls: CollisionWallData) => Promise<void>;
  generating: boolean;
  /** Initial cross-section height (world Y). */
  initialSliceY: number;
  onClose: () => void;
}

/**
 * 俯瞰コリジョン編集 — drawing walls DIRECTLY over the sliced GS, no floor
 * plan needed. The camera is parked above the splat (SceneManager
 * enterTopDownView), the splat is cross-sectioned at 断面高さ so walls/floor
 * read like a dollhouse cutaway, and clicks land on the 床Y plane.
 *
 * Edits the SAME `collision.walls` data as the 図面 wall editor — both are
 * views over one authoring model, so you can rough-in on the plan and refine
 * over the GS (or skip the plan entirely).
 *
 *   左クリック   — 壁の点を置く（連続で折れ線）/ 床外周の頂点 / 消す
 *   右ドラッグ   — パン（右クリックだけなら壁チェーン終了）
 *   ホイール     — ズーム（カメラ高さ）
 *
 * The camera only moves through our own pan/zoom handlers (movement is locked
 * while the mode is active), so screen projections are recomputed per edit /
 * pan tick instead of per frame — no rAF loop.
 */
export function TopDownCollisionEditor({ getManager, walls, onChange, onGenerate, generating, initialSliceY, onClose }: Props) {
  const data = walls ?? DEFAULT_WALLS;
  const [mode, setMode] = useState<EditMode>('wall');
  const [pending, setPending] = useState<Vec2 | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [sliceY, setSliceY] = useState(initialSliceY);
  /** Bumped after pan/zoom so projections recompute (camera moves only via us). */
  const [viewTick, setViewTick] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Right-drag pan state. `moved` distinguishes pan from right-click (= end chain). */
  const panRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const sm = getManager();

  // ── Projections (world XZ at floorY → overlay px) ──
  const project = (p: Vec2): { x: number; y: number } | null =>
    sm?.worldToScreen([p[0], data.floorY, p[1]]) ?? null;
  const toWorld = (clientX: number, clientY: number): Vec2 | null => {
    const el = wrapRef.current;
    if (!el || !sm) return null;
    const r = el.getBoundingClientRect();
    const w = sm.screenToPlanePoint(clientX - r.left, clientY - r.top, data.floorY);
    return w ? [w[0], w[2]] : null;
  };

  const commit = (patch: Partial<CollisionWallData>) => onChange({ ...data, ...patch });

  // ── Left click: draw / erase (mirrors CollisionWallEditor semantics) ──
  const onClick = (e: React.MouseEvent) => {
    if (generating || e.button !== 0) return;
    const w = toWorld(e.clientX, e.clientY);
    if (!w) return;
    if (mode === 'wall') {
      if (!pending) { setPending(w); return; }
      commit({ segments: [...data.segments, { a: pending, b: w }] });
      setPending(w);
    } else if (mode === 'floor') {
      commit({ floorPolygon: [...(data.floorPolygon ?? []), w] });
    } else {
      // erase: nearest segment midpoint / floor vertex within ~14px on screen.
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      let bestKind: 'seg' | 'poly' | null = null;
      let bestIdx = -1;
      let bestDist = 14;
      data.segments.forEach((s, i) => {
        const m = project([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]);
        if (!m) return;
        const d = Math.hypot(px - m.x, py - m.y);
        if (d < bestDist) { bestDist = d; bestKind = 'seg'; bestIdx = i; }
      });
      (data.floorPolygon ?? []).forEach((p, i) => {
        const m = project(p);
        if (!m) return;
        const d = Math.hypot(px - m.x, py - m.y);
        if (d < bestDist) { bestDist = d; bestKind = 'poly'; bestIdx = i; }
      });
      if (bestKind === 'seg') commit({ segments: data.segments.filter((_, i) => i !== bestIdx) });
      else if (bestKind === 'poly') commit({ floorPolygon: (data.floorPolygon ?? []).filter((_, i) => i !== bestIdx) });
    }
  };

  // ── Right drag = pan / right click = end chain / wheel = zoom ──
  const metersPerPx = () => {
    const el = wrapRef.current;
    if (!el || !sm) return 0.01;
    const pose = sm.getLiveCameraPose();
    const h = Math.max(0.5, pose.position[1] - data.floorY);
    return (2 * h * Math.tan((pose.fov / 2) * Math.PI / 180)) / el.getBoundingClientRect().height;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 2) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const pan = panRef.current;
    if (pan) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (pan.moved || Math.hypot(dx, dy) > 3) {
        pan.moved = true;
        const mpp = metersPerPx();
        // Screen right = +X, screen down = +Z while parked at yaw 0 looking down.
        sm?.nudgeTopDownCamera(-dx * mpp, 0, -dy * mpp);
        pan.x = e.clientX;
        pan.y = e.clientY;
        setViewTick((t) => t + 1);
      }
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    if (w) setCursor(w);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 2) return;
    const pan = panRef.current;
    panRef.current = null;
    if (pan && !pan.moved) {
      // Plain right click — end the wall chain / drop the last floor vertex.
      if (mode === 'wall') setPending(null);
      else if (mode === 'floor' && data.floorPolygon?.length) commit({ floorPolygon: data.floorPolygon.slice(0, -1) });
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!sm) return;
    const pose = sm.getLiveCameraPose();
    const h = Math.max(0.5, pose.position[1] - data.floorY);
    sm.nudgeTopDownCamera(0, (e.deltaY > 0 ? 1 : -1) * h * 0.12, 0);
    setViewTick((t) => t + 1);
  };

  // Esc ends the chain; slice slider drives the shader clip live.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPending(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const changeSlice = (v: number) => {
    setSliceY(v);
    sm?.setSplatClipY(v);
  };

  // Recompute projections when camera moved (viewTick) or data changed — the
  // render below calls project() directly, so viewTick only needs to force it.
  void viewTick;

  const poly = data.floorPolygon ?? [];
  const projSegs = data.segments
    .map((s, i) => ({ i, a: project(s.a), b: project(s.b) }))
    .filter((s): s is { i: number; a: { x: number; y: number }; b: { x: number; y: number } } => !!s.a && !!s.b);
  const projPoly = poly.map((p) => project(p)).filter((p): p is { x: number; y: number } => !!p);
  const projPending = pending ? project(pending) : null;
  const projCursor = cursor ? project(cursor) : null;

  const paramInput = (label: string, value: number, step: number, onV: (v: number) => void, title: string) => (
    <label style={ST.param} title={title}>
      {label}
      <input type="number" step={step} value={value}
        onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onV(v); }}
        style={ST.numInput} />
    </label>
  );

  return (
    <div
      ref={wrapRef}
      style={ST.overlay}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg style={ST.svg} width="100%" height="100%">
        {projPoly.length >= 2 && (
          <polygon points={projPoly.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="rgba(34,197,94,0.15)" stroke="rgba(34,197,94,0.95)" strokeWidth={2} />
        )}
        {projPoly.map((p, i) => (
          <circle key={`fp-${i}`} cx={p.x} cy={p.y} r={5}
            fill={i === 0 ? '#16a34a' : 'rgba(34,197,94,0.95)'} stroke="#fff" strokeWidth={1.5} />
        ))}
        {mode === 'floor' && projPoly.length > 0 && projCursor && (
          <line x1={projPoly[projPoly.length - 1].x} y1={projPoly[projPoly.length - 1].y}
            x2={projCursor.x} y2={projCursor.y}
            stroke="rgba(34,197,94,0.6)" strokeWidth={1.5} strokeDasharray="5 4" />
        )}
        {projSegs.map((s) => (
          <line key={`w-${s.i}`} x1={s.a.x} y1={s.a.y} x2={s.b.x} y2={s.b.y}
            stroke="rgba(239,68,68,0.95)" strokeWidth={4} strokeLinecap="round" />
        ))}
        {mode === 'wall' && projPending && (
          <>
            <circle cx={projPending.x} cy={projPending.y} r={5} fill="#ef4444" stroke="#fff" strokeWidth={1.5} />
            {projCursor && (
              <line x1={projPending.x} y1={projPending.y} x2={projCursor.x} y2={projCursor.y}
                stroke="rgba(239,68,68,0.6)" strokeWidth={2.5} strokeDasharray="5 4" />
            )}
          </>
        )}
      </svg>

      {/* Toolbar */}
      <div style={ST.toolbar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <span style={ST.title}>⬇ 俯瞰で描く</span>
        {([['wall', '壁'], ['floor', '床外周'], ['erase', '消す']] as [EditMode, string][]).map(([m, label]) => (
          <button key={m} type="button" onClick={() => { setMode(m); setPending(null); }}
            style={{ ...ST.modeBtn, ...(mode === m ? ST.modeBtnActive : null) }}>{label}</button>
        ))}
        <label style={ST.param} title="この高さより上の GS を非表示（断面）">
          断面
          <input type="range" min={data.floorY - 0.5} max={data.floorY + 4} step={0.05} value={sliceY}
            onChange={(e) => changeSlice(parseFloat(e.target.value))} style={{ width: 90 }} />
          <span style={ST.mono}>{sliceY.toFixed(2)}m</span>
        </label>
        {paramInput('床Y', data.floorY, 0.05, (v) => commit({ floorY: v }), '描画平面と床 GLB のワールド Y')}
        {paramInput('壁高', data.wallHeight, 0.1, (v) => commit({ wallHeight: v }), '壁の押し出し高さ (m)')}
        <button
          type="button"
          disabled={generating || (data.segments.length === 0 && poly.length < 3)}
          onClick={() => void onGenerate(data)}
          style={{ ...ST.generateBtn, opacity: generating || (data.segments.length === 0 && poly.length < 3) ? 0.5 : 1 }}
        >
          {generating ? '生成中…' : '⚒ 生成して適用'}
        </button>
        <button type="button" style={ST.closeBtn} onClick={onClose}>✕ 終了</button>
      </div>

      <div style={ST.hint}>
        左クリック: {mode === 'wall' ? '壁の点を置く（連続で折れ線 / 右クリックか Esc で終了）' : mode === 'floor' ? '床外周の頂点を追加（右クリックで最後を削除）' : '壁線・頂点を削除'}
        ／ 右ドラッグ: パン ／ ホイール: ズーム ／ 壁 {data.segments.length} 本・床 {poly.length} 点
      </div>
    </div>
  );
}

const ST: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 55,
    cursor: 'crosshair',
    touchAction: 'none',
  },
  svg: { position: 'absolute', inset: 0, pointerEvents: 'none' },
  toolbar: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: tokens.glass.surfaceStrong,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
    fontFamily: tokens.font.family,
    fontSize: 11.5,
    color: tokens.color.text,
    cursor: 'default',
    whiteSpace: 'nowrap',
  },
  title: { fontWeight: 700, letterSpacing: 0.3 },
  modeBtn: {
    padding: '4px 10px',
    fontSize: 11.5,
    fontWeight: 600,
    background: tokens.gradient.surface,
    color: tokens.color.textMute,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  modeBtnActive: {
    background: tokens.gradient.accent,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.accentBorder}`,
    boxShadow: tokens.shadow.glassAccent,
  },
  param: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: tokens.color.textMute },
  numInput: {
    width: 58,
    padding: '2px 4px',
    fontSize: 11.5,
    fontFamily: tokens.font.mono,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.glass.surface,
    color: tokens.color.text,
  },
  mono: { fontFamily: tokens.font.mono, fontSize: 10.5 },
  generateBtn: {
    padding: '6px 12px',
    fontSize: 11.5,
    fontWeight: 700,
    background: tokens.gradient.accent,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.accentBorder}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glassAccent,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  closeBtn: {
    padding: '6px 10px',
    fontSize: 11.5,
    background: tokens.gradient.surface,
    color: tokens.color.textMute,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  hint: {
    position: 'absolute',
    bottom: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '5px 14px',
    fontSize: 11,
    color: tokens.color.text,
    background: tokens.glass.surfaceStrong,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
    whiteSpace: 'nowrap',
    fontFamily: tokens.font.family,
  },
};
