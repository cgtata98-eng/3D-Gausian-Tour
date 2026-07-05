import { useEffect, useRef, useState } from 'react';
import type { CollisionWallData, FloorPlanConfig, Vec2 } from '../core/types';
import { resolveScenePath } from '../core/scene-manifest';
import { tokens } from './design-tokens';

/** Matches FloorPlanMiniMap's world→map padding so walls drawn here line up
 *  with the viewpoint dots the user already calibrated the bounds against. */
const PADDING = 20;

const DEFAULT_WALLS: CollisionWallData = {
  segments: [],
  floorPolygon: undefined,
  wallHeight: 2.5,
  wallThickness: 0.1,
  floorY: 0,
};

type EditMode = 'wall' | 'floor' | 'erase';

interface Props {
  sceneId: string;
  floorPlan: FloorPlanConfig;
  /** Current authoring data (undefined = nothing drawn yet). */
  walls: CollisionWallData | undefined;
  /** Persist authoring data to the manifest (called on every edit). */
  onChange: (walls: CollisionWallData) => void;
  /** Build GLBs from the current data and install them as the manual set. */
  onGenerate: (walls: CollisionWallData) => Promise<void>;
  generating: boolean;
  /** Editor viewport width in px (height follows the image aspect). */
  size?: number;
}

/**
 * 図面 wall editor (B2 手動系統): draw wall segments / a floor outline on the
 * floor-plan image, then bake them into `manualBlock` / `manualWalkable`
 * collision GLBs via `onGenerate`.
 *
 * Interactions:
 *   壁 mode  — click = place point, next click = complete a segment and chain
 *              from its end (polyline). 右クリック / Esc ends the chain.
 *   床 mode  — click = append a polygon vertex. 右クリック removes the last one.
 *   消す mode — click near a segment / polygon vertex to remove it.
 *
 * Writes ONLY `collision.walls` (authoring data) via onChange — GLBs and the
 * active mesh change exclusively through the explicit 生成 button. Viewpoints,
 * mapYaw, and the live camera are never touched.
 */
export function CollisionWallEditor({ sceneId, floorPlan, walls, onChange, onGenerate, generating, size = 420 }: Props) {
  const data = walls ?? DEFAULT_WALLS;
  const [mode, setMode] = useState<EditMode>('wall');
  /** Chain-start point while drawing a wall polyline (world XZ). */
  const [pending, setPending] = useState<Vec2 | null>(null);
  /** Live cursor position (world XZ) for the rubber-band preview line. */
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const fpImage = floorPlan.image;
  const imageUrl = fpImage.startsWith('data:') ? fpImage : resolveScenePath(sceneId, fpImage);

  // Measure the image so the editor box matches its aspect ratio (mirrors
  // FloorPlanMiniMap's sizing so the two views of the same plan agree).
  const [prevUrl, setPrevUrl] = useState(imageUrl);
  if (prevUrl !== imageUrl) { setPrevUrl(imageUrl); }
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) setImgSize({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl]);

  const bounds = floorPlan.bounds;
  const worldW = bounds.max[0] - bounds.min[0];
  const worldH = bounds.max[1] - bounds.min[1];
  const aspect = imgSize ? imgSize.w / imgSize.h : (worldW / worldH || 1);
  let dW = size, dH = size;
  if (aspect > 1) dH = size / aspect; else dW = size * aspect;

  const toMX = (wx: number) => PADDING + ((wx - bounds.min[0]) / worldW) * (dW - PADDING * 2);
  const toMY = (wz: number) => PADDING + ((wz - bounds.min[1]) / worldH) * (dH - PADDING * 2);
  const toWorld = (mx: number, my: number): Vec2 => [
    +(bounds.min[0] + ((mx - PADDING) / (dW - PADDING * 2)) * worldW).toFixed(3),
    +(bounds.min[1] + ((my - PADDING) / (dH - PADDING * 2)) * worldH).toFixed(3),
  ];

  const svgPt = (e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (dW / r.width), y: (e.clientY - r.top) * (dH / r.height) };
  };

  const commit = (patch: Partial<CollisionWallData>) => onChange({ ...data, ...patch });

  // ── Click handling per mode ──
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (generating) return;
    const pt = svgPt(e);
    const w = toWorld(pt.x, pt.y);
    if (mode === 'wall') {
      if (!pending) { setPending(w); return; }
      commit({ segments: [...data.segments, { a: pending, b: w }] });
      setPending(w); // chain: next segment starts where this one ended
    } else if (mode === 'floor') {
      commit({ floorPolygon: [...(data.floorPolygon ?? []), w] });
    } else {
      // erase: nearest wall segment (by midpoint) or floor vertex within ~12px.
      const threshold = 12;
      let bestKind: 'seg' | 'poly' | null = null;
      let bestIdx = -1;
      let bestDist = threshold;
      data.segments.forEach((s, i) => {
        const mx = (toMX(s.a[0]) + toMX(s.b[0])) / 2;
        const my = (toMY(s.a[1]) + toMY(s.b[1])) / 2;
        const d = Math.hypot(pt.x - mx, pt.y - my);
        if (d < bestDist) { bestDist = d; bestKind = 'seg'; bestIdx = i; }
      });
      (data.floorPolygon ?? []).forEach((p, i) => {
        const d = Math.hypot(pt.x - toMX(p[0]), pt.y - toMY(p[1]));
        if (d < bestDist) { bestDist = d; bestKind = 'poly'; bestIdx = i; }
      });
      if (bestKind === 'seg') commit({ segments: data.segments.filter((_, i) => i !== bestIdx) });
      else if (bestKind === 'poly') commit({ floorPolygon: (data.floorPolygon ?? []).filter((_, i) => i !== bestIdx) });
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (mode === 'wall') setPending(null); // end the chain
    else if (mode === 'floor' && data.floorPolygon?.length) {
      commit({ floorPolygon: data.floorPolygon.slice(0, -1) });
    }
  };

  // Esc also ends the wall chain (matches the right-click affordance).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPending(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const poly = data.floorPolygon ?? [];
  const polyPoints = poly.map((p) => `${toMX(p[0])},${toMY(p[1])}`).join(' ');

  const numInput = (label: string, value: number, min: number, max: number, step: number, onV: (v: number) => void, title: string) => (
    <label style={ST.param} title={title}>
      <span style={ST.paramLabel}>{label}</span>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onV(v); }}
        style={ST.paramInput}
      />
    </label>
  );

  return (
    <div style={ST.wrap}>
      {/* Mode toolbar */}
      <div style={ST.toolbar}>
        {([['wall', '壁を引く'], ['floor', '床の外周'], ['erase', '消す']] as [EditMode, string][]).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setPending(null); }}
            style={{ ...ST.modeBtn, ...(mode === m ? ST.modeBtnActive : null) }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Canvas */}
      <div style={{ ...ST.canvasWrap, width: dW, height: dH }}>
        <img src={imageUrl} alt="floor plan" style={ST.image} draggable={false} />
        <svg
          ref={svgRef}
          width={dW}
          height={dH}
          viewBox={`0 0 ${dW} ${dH}`}
          style={{ ...ST.svg, cursor: generating ? 'wait' : 'crosshair' }}
          onClick={onClick}
          onContextMenu={onContextMenu}
          onMouseMove={(e) => { const p = svgPt(e); setCursor(toWorld(p.x, p.y)); }}
          onMouseLeave={() => setCursor(null)}
        >
          {/* Floor polygon (green, walkable) */}
          {poly.length >= 2 && (
            <polygon points={polyPoints} fill="rgba(34,197,94,0.18)" stroke="rgba(34,197,94,0.9)" strokeWidth={1.5} />
          )}
          {poly.map((p, i) => (
            <circle key={`fp-${i}`} cx={toMX(p[0])} cy={toMY(p[1])} r={4}
              fill={i === 0 ? '#16a34a' : 'rgba(34,197,94,0.9)'} stroke="#fff" strokeWidth={1} />
          ))}
          {/* Rubber band: floor mode — from last polygon point to cursor */}
          {mode === 'floor' && poly.length > 0 && cursor && (
            <line x1={toMX(poly[poly.length - 1][0])} y1={toMY(poly[poly.length - 1][1])}
              x2={toMX(cursor[0])} y2={toMY(cursor[1])}
              stroke="rgba(34,197,94,0.5)" strokeWidth={1.5} strokeDasharray="4 3" />
          )}

          {/* Wall segments (red, block) */}
          {data.segments.map((s, i) => (
            <line key={`w-${i}`}
              x1={toMX(s.a[0])} y1={toMY(s.a[1])} x2={toMX(s.b[0])} y2={toMY(s.b[1])}
              stroke="rgba(239,68,68,0.9)" strokeWidth={3} strokeLinecap="round" />
          ))}
          {/* Rubber band: wall mode — from the pending chain point to cursor */}
          {mode === 'wall' && pending && (
            <>
              <circle cx={toMX(pending[0])} cy={toMY(pending[1])} r={4} fill="#ef4444" stroke="#fff" strokeWidth={1} />
              {cursor && (
                <line x1={toMX(pending[0])} y1={toMY(pending[1])} x2={toMX(cursor[0])} y2={toMY(cursor[1])}
                  stroke="rgba(239,68,68,0.5)" strokeWidth={2} strokeDasharray="4 3" />
              )}
            </>
          )}
        </svg>
      </div>

      <div style={ST.hint}>
        {mode === 'wall' && 'クリックで壁の始点→終点。連続で折れ線。右クリック / Esc で線を終了。'}
        {mode === 'floor' && 'クリックで床外周の頂点を追加（歩ける範囲）。右クリックで最後の頂点を削除。'}
        {mode === 'erase' && '壁線の中央付近 / 床の頂点をクリックで削除。'}
      </div>

      {/* Params */}
      <div style={ST.paramRow}>
        {numInput('壁高さ', data.wallHeight, 0.5, 10, 0.1, (v) => commit({ wallHeight: v }), '床から押し出す壁の高さ (m)')}
        {numInput('厚み', data.wallThickness, 0.02, 1, 0.01, (v) => commit({ wallThickness: v }), '壁の厚み (m)')}
        {numInput('床Y', data.floorY, -20, 20, 0.05, (v) => commit({ floorY: v }), '床平面のワールド Y (m)。ライブカメラの足元に合わせる')}
      </div>

      {/* Status + actions */}
      <div style={ST.status}>
        壁 {data.segments.length} 本 / 床外周 {poly.length} 点{poly.length > 0 && poly.length < 3 ? '（3点以上で有効）' : ''}
      </div>
      <div style={ST.actions}>
        <button
          type="button"
          disabled={generating || (data.segments.length === 0 && poly.length < 3)}
          onClick={() => void onGenerate(data)}
          style={{ ...ST.generateBtn, opacity: generating || (data.segments.length === 0 && poly.length < 3) ? 0.5 : 1 }}
          title="壁線→block GLB / 床外周→walkable GLB を生成して手動コリジョンとして適用"
        >
          {generating ? '生成中…' : '⚒ GLB 生成して適用'}
        </button>
        <button
          type="button"
          disabled={generating}
          onClick={() => { if (confirm('描いた壁・床をすべて消去しますか？（適用済み GLB はそのまま）')) { setPending(null); onChange({ ...data, segments: [], floorPolygon: undefined }); } }}
          style={ST.clearBtn}
        >
          全消去
        </button>
      </div>
    </div>
  );
}

const ST: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 },
  toolbar: { display: 'flex', gap: 6 },
  modeBtn: {
    flex: 1,
    padding: '6px 8px',
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
  canvasWrap: {
    position: 'relative',
    borderRadius: tokens.radius.md,
    overflow: 'hidden',
    border: `1px solid ${tokens.color.border}`,
    alignSelf: 'center',
    background: '#f4f4f5',
  },
  image: { position: 'absolute', inset: 0, width: '100%', height: '100%', userSelect: 'none' },
  svg: { position: 'absolute', top: 0, left: 0 },
  hint: { fontSize: 10.5, color: tokens.color.textMute, lineHeight: 1.5 },
  paramRow: { display: 'flex', gap: 8 },
  param: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  paramLabel: { fontSize: 10, color: tokens.color.textMute, fontWeight: 600 },
  paramInput: {
    width: '100%',
    padding: '4px 6px',
    fontSize: 12,
    fontFamily: tokens.font.mono,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.glass.surface,
    color: tokens.color.text,
    boxSizing: 'border-box',
  },
  status: { fontSize: 11, color: tokens.color.text, fontWeight: 600 },
  actions: { display: 'flex', gap: 8 },
  generateBtn: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 700,
    background: tokens.gradient.accent,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.accentBorder}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glassAccent,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  clearBtn: {
    padding: '8px 12px',
    fontSize: 11.5,
    background: tokens.gradient.surface,
    color: tokens.color.textMute,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
};
