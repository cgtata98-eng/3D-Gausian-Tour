import { useEffect, useRef, useState } from 'react';
import type { CollisionWallData, Vec2 } from '../core/types';
import { tokens } from './design-tokens';

/** Manager surface the editor needs (PlayCanvas SceneManager provides all). */
export interface TopDownManager {
  worldToScreen: (w: [number, number, number]) => { x: number; y: number } | null;
  screenToPlanePoint: (x: number, y: number, planeY: number) => [number, number, number] | null;
  setSplatClipY: (y: number | null) => void;
  nudgeTopDownCamera: (dx: number, dy: number, dz: number) => void;
  zoomTopDownCamera: (factor: number) => void;
  getTopDownOrthoHeight: () => number;
  setTopDownOrientation: (orient: 'top' | 'side') => void;
  getTopDownCenterXZ: () => { x: number; z: number } | null;
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
  /** 'top' = plan view (drawing), 'side' = elevation view (床Y/壁高 drag). */
  const [view, setView] = useState<'top' | 'side'>('top');
  const [pending, setPending] = useState<Vec2 | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [sliceY, setSliceY] = useState(initialSliceY);
  /** Bumped after pan/zoom so projections recompute (camera moves only via us). */
  const [viewTick, setViewTick] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Right-drag pan state. `moved` distinguishes pan from right-click (= end chain). */
  const panRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /** Side-view guide-line drag: which line + values at drag start. */
  const lineDragRef = useRef<{ kind: 'floor' | 'top'; startPy: number; floorY0: number; wallH0: number } | null>(null);

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

  // ── Left click: draw / erase (top view only — side view is for the guides) ──
  const onClick = (e: React.MouseEvent) => {
    if (generating || e.button !== 0 || view !== 'top') return;
    const w = toWorld(e.clientX, e.clientY);
    if (!w) return;
    if (mode === 'wall') {
      if (!pending) { setPending(w); return; }
      commit({ segments: [...data.segments, { a: pending, b: w }] });
      setPending(w);
    } else if (mode === 'floor') {
      commit({ floorPolygon: [...(data.floorPolygon ?? []), w] });
    } else {
      // erase: nearest wall segment (distance to the WHOLE projected line, not
      // just its midpoint — long walls were un-erasable away from the middle)
      // or floor vertex, within ~14px on screen.
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      /** Screen-space distance from the click to segment ab. */
      const distToSeg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const abx = b.x - a.x, aby = b.y - a.y;
        const len2 = abx * abx + aby * aby;
        const t = len2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / len2));
        return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
      };
      let bestKind: 'seg' | 'poly' | null = null;
      let bestIdx = -1;
      let bestDist = 14;
      data.segments.forEach((s, i) => {
        const a = project(s.a);
        const b = project(s.b);
        if (!a || !b) return;
        const d = distToSeg(a, b);
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
  // Orthographic view: meters-per-pixel comes straight from orthoHeight
  // (visible world height = 2 × orthoHeight), independent of camera altitude.
  const metersPerPx = () => {
    const el = wrapRef.current;
    if (!el || !sm) return 0.01;
    return (2 * sm.getTopDownOrthoHeight()) / el.getBoundingClientRect().height;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 2) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const ld = lineDragRef.current;
    if (ld) {
      // Side-view guide drag: screen up = +Y world.
      const dWorld = -(e.clientY - ld.startPy) * metersPerPx();
      if (ld.kind === 'floor') {
        commit({ floorY: +(ld.floorY0 + dWorld).toFixed(3) });
      } else {
        commit({ wallHeight: Math.max(0.2, +(ld.wallH0 + dWorld).toFixed(3)) });
      }
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (pan.moved || Math.hypot(dx, dy) > 3) {
        pan.moved = true;
        const mpp = metersPerPx();
        // Top: screen right = +X, screen down = +Z (yaw 0 looking down).
        // Side: screen right = +X, screen down = -Y (yaw 0, pitch 0).
        if (view === 'top') sm?.nudgeTopDownCamera(-dx * mpp, 0, -dy * mpp);
        else sm?.nudgeTopDownCamera(-dx * mpp, dy * mpp, 0);
        pan.x = e.clientX;
        pan.y = e.clientY;
        setViewTick((t) => t + 1);
      }
      return;
    }
    if (view !== 'top') return;
    const w = toWorld(e.clientX, e.clientY);
    if (w) setCursor(w);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (lineDragRef.current && e.button === 0) {
      lineDragRef.current = null;
      // Re-bake so the red/green meshes follow the new floor/height right away.
      if (data.segments.length > 0 || (data.floorPolygon?.length ?? 0) >= 3) void onGenerate(data);
      return;
    }
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
    sm.zoomTopDownCamera(e.deltaY > 0 ? 1.12 : 1 / 1.12);
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
        {/* ── 横ビュー: 床Y / 壁上端 のドラッグガイド ── */}
        {view === 'side' && sm && (() => {
          const c = sm.getTopDownCenterXZ();
          if (!c) return null;
          const fl = sm.worldToScreen([c.x, data.floorY, c.z]);
          const tp = sm.worldToScreen([c.x, data.floorY + data.wallHeight, c.z]);
          const startLineDrag = (kind: 'floor' | 'top') => (e: React.PointerEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            wrapRef.current?.setPointerCapture(e.pointerId);
            lineDragRef.current = { kind, startPy: e.clientY, floorY0: data.floorY, wallH0: data.wallHeight };
          };
          const guide = (y: number, color: string, label: string, kind: 'floor' | 'top') => (
            <g key={kind} style={{ pointerEvents: 'auto', cursor: 'ns-resize' }} onPointerDown={startLineDrag(kind)}>
              <line x1={0} y1={y} x2={9999} y2={y} stroke="transparent" strokeWidth={18} />
              <line x1={0} y1={y} x2={9999} y2={y} stroke={color} strokeWidth={1.35} strokeDasharray="10 6" />
              <text x={14} y={y - 8} fontSize={12} fontWeight={700} fill={color}
                stroke="rgba(255,255,255,0.9)" strokeWidth={3} paintOrder="stroke">{label}</text>
            </g>
          );
          return (
            <>
              {fl && guide(fl.y, '#16a34a', `床Y ${data.floorY.toFixed(2)}m — ドラッグで上下`, 'floor')}
              {tp && guide(tp.y, '#dc2626', `壁上端 ${(data.floorY + data.wallHeight).toFixed(2)}m（壁高 ${data.wallHeight.toFixed(2)}m）`, 'top')}
            </>
          );
        })()}
        {view === 'top' && projPoly.length >= 2 && (
          <polygon points={projPoly.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="rgba(34,197,94,0.15)" stroke="rgba(34,197,94,0.95)" strokeWidth={1.35} />
        )}
        {view === 'top' && projPoly.map((p, i) => (
          <circle key={`fp-${i}`} cx={p.x} cy={p.y} r={5}
            fill={i === 0 ? '#16a34a' : 'rgba(34,197,94,0.95)'} stroke="#fff" strokeWidth={1.35} />
        ))}
        {view === 'top' && mode === 'floor' && projPoly.length > 0 && projCursor && (
          <line x1={projPoly[projPoly.length - 1].x} y1={projPoly[projPoly.length - 1].y}
            x2={projCursor.x} y2={projCursor.y}
            stroke="rgba(34,197,94,0.6)" strokeWidth={1.35} strokeDasharray="5 4" />
        )}
        {view === 'top' && projSegs.map((s) => (
          <line key={`w-${s.i}`} x1={s.a.x} y1={s.a.y} x2={s.b.x} y2={s.b.y}
            stroke="rgba(239,68,68,0.95)" strokeWidth={4} strokeLinecap="round" />
        ))}
        {view === 'top' && mode === 'wall' && projPending && (
          <>
            <circle cx={projPending.x} cy={projPending.y} r={5} fill="#ef4444" stroke="#fff" strokeWidth={1.35} />
            {projCursor && (
              <line x1={projPending.x} y1={projPending.y} x2={projCursor.x} y2={projCursor.y}
                stroke="rgba(239,68,68,0.6)" strokeWidth={1.35} strokeDasharray="5 4" />
            )}
          </>
        )}
      </svg>

      {/* Toolbar */}
      <div style={ST.toolbar} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <span style={ST.title}>⬇ 俯瞰で描く</span>
        {([['top', '上から'], ['side', '横から']] as ['top' | 'side', string][]).map(([v, label]) => (
          <button key={v} type="button"
            onClick={() => {
              if (view === v) return;
              sm?.setTopDownOrientation(v);
              // 横ビューは床〜天井の全高を見て合わせたいので断面クリップを一時解除。
              // 上に戻すとスライダー値で再クリップ。
              sm?.setSplatClipY(v === 'side' ? null : sliceY);
              setView(v);
              setPending(null);
              setViewTick((t) => t + 1);
            }}
            title={v === 'top' ? '平面図ビュー（壁・床を描く）' : '立面ビュー（床Y と壁の高さをドラッグで合わせる）'}
            style={{ ...ST.modeBtn, ...(view === v ? ST.modeBtnActive : null) }}>{label}</button>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: tokens.color.hairline }} />
        {view === 'top' && ([['wall', '壁'], ['floor', '床外周'], ['erase', '消す']] as [EditMode, string][]).map(([m, label]) => (
          <button key={m} type="button" onClick={() => { setMode(m); setPending(null); }}
            style={{ ...ST.modeBtn, ...(mode === m ? ST.modeBtnActive : null) }}>{label}</button>
        ))}
        {view === 'top' && (
          <label style={ST.param} title="この高さより上の GS を非表示（断面）">
            断面
            <input type="range" min={data.floorY - 0.5} max={data.floorY + 4} step={0.05} value={sliceY}
              onChange={(e) => changeSlice(parseFloat(e.target.value))} style={{ width: 90 }} />
            <span style={ST.mono}>{sliceY.toFixed(2)}m</span>
          </label>
        )}
        {paramInput('床Y', data.floorY, 0.05, (v) => commit({ floorY: v }), '描画平面と床 GLB のワールド Y')}
        {paramInput('壁高', data.wallHeight, 0.1, (v) => commit({ wallHeight: v }), '壁の押し出し高さ (m)')}
        <button
          type="button"
          disabled={generating}
          onClick={() => {
            // 適用 = 手動セットを「描画どおり」にする。空チャンネルはクリア
            // されるので、全消し→適用 で焼き込み済みの壁も消える。
            if (data.segments.length === 0 && poly.length < 3) {
              if (!confirm('壁も床も描かれていません。適用すると手動コリジョン (壁・床) を削除します。よろしいですか？')) return;
            }
            void onGenerate(data);
          }}
          style={{ ...ST.generateBtn, opacity: generating ? 0.5 : 1 }}
          title="描いた壁→block / 床外周→walkable を生成して適用。描いていないチャンネルはクリアされます"
        >
          {generating ? '生成中…' : '⚒ 生成して適用'}
        </button>
        <button type="button" style={ST.closeBtn} onClick={onClose}>✕ 終了</button>
      </div>

      <div style={ST.hint}>
        {view === 'side'
          ? <>緑の線 = 床の高さ / 赤の線 = 壁の上端。GS の床・天井に合わせて上下にドラッグ（離すと自動で再生成）／ 右ドラッグ: パン ／ ホイール: ズーム</>
          : <>左クリック: {mode === 'wall' ? '壁の点を置く（連続で折れ線 / 右クリックか Esc で終了）' : mode === 'floor' ? '床外周の頂点を追加（右クリックで最後を削除）' : '壁線・頂点を削除'}
        ／ 右ドラッグ: パン ／ ホイール: ズーム ／ 壁 {data.segments.length} 本・床 {poly.length} 点</>}
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
    fontSize: 10.5,
    color: tokens.color.text,
    cursor: 'default',
    whiteSpace: 'nowrap',
  },
  title: { fontWeight: tokens.font.weight.strong, letterSpacing: 0.3 },
  modeBtn: {
    padding: '4px 10px',
    fontSize: 10.5,
    fontWeight: tokens.font.weight.strong,
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
  param: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: tokens.color.textMute },
  numInput: {
    width: 58,
    padding: '2px 4px',
    fontSize: 10.5,
    fontFamily: tokens.font.mono,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.glass.surface,
    color: tokens.color.text,
  },
  mono: { fontFamily: tokens.font.mono, fontSize: 9.5 },
  generateBtn: {
    padding: '6px 12px',
    fontSize: 10.5,
    fontWeight: tokens.font.weight.strong,
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
    fontSize: 10.5,
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
    fontSize: 10.5,
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
