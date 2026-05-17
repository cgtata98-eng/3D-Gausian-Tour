import { useCallback, useEffect, useRef, useState } from 'react';
import { useCameraStore } from '../store/camera-store';
import { useSceneStore } from '../store/scene-store';
import { resolveScenePath } from '../core/scene-manifest';
import { tokens } from './design-tokens';

const PADDING = 20;

interface FloorPlanMiniMapProps {
  onViewpointClick: (id: string) => void;
  size?: number;
  style?: React.CSSProperties;
  editable?: boolean;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /**
   * Click-to-place callback. Fired when the user clicks on empty map area in editable mode.
   * Receives world (x, z) coordinates. The caller decides which viewpoint to move.
   */
  onMapClick?: (worldX: number, worldZ: number) => void;
  /**
   * Dot-drag delegate. When provided, dragging a dot routes through this callback
   * INSTEAD of writing `mapPosition` directly — the caller decides whether to also
   * sync the camera-anchor `position` (GS mode) or keep them separate (VR mode).
   */
  onMoveViewpoint?: (vpId: string, worldX: number, worldZ: number) => void;
  /** Fired once on mouseup at the end of a dot drag. Caller can use this to
   *  finalize side-effects (e.g. jump the camera to the new pose). */
  onMoveViewpointEnd?: (vpId: string) => void;
}

function isImageFile(f: string): boolean { return /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(f); }

export function FloorPlanMiniMap({ onViewpointClick, size = 200, style: overrideStyle, editable = false, collapsible = false, defaultCollapsed = false, onMapClick, onMoveViewpoint, onMoveViewpointEnd }: FloorPlanMiniMapProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const position = useCameraStore((s) => s.position);
  const yaw = useCameraStore((s) => s.yaw);
  const activeVp = useCameraStore((s) => s.activeViewpoint);
  const sceneId = manifest?.id ?? '';
  const activePlan = manifest?.plans?.find((p) => p.id === activePlanId);

  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<{ vpId: string; sx: number; sy: number; ox: number; oz: number } | null>(null);

  const fpImage = activePlan?.floorPlan?.image;
  const isData = !!fpImage && fpImage.startsWith('data:');
  const hasFile = !!fpImage && (isData || isImageFile(fpImage));
  const imageUrl = isData ? fpImage : (fpImage ? resolveScenePath(sceneId, fpImage) : '');

  useEffect(() => {
    if (!hasFile || !imageUrl) { setImgSize(null); setImgFailed(false); return; }
    setImgFailed(false);
    const img = new Image();
    img.onload = () => { setImgSize({ w: img.naturalWidth, h: img.naturalHeight }); setImgFailed(false); };
    img.onerror = () => { setImgSize(null); setImgFailed(true); };
    img.src = imageUrl;
  }, [imageUrl, hasFile]);

  const hasImage = hasFile && !imgFailed;

  const floorPlan = activePlan?.floorPlan;
  const viewpoints = activePlan?.viewpoints ?? [];
  const bounds = floorPlan?.bounds ?? { min: [0, 0] as [number, number], max: [1, 1] as [number, number] };
  const worldW = bounds.max[0] - bounds.min[0];
  const worldH = bounds.max[1] - bounds.min[1];
  const aspect = imgSize ? imgSize.w / imgSize.h : worldW / worldH;
  let dW = size, dH = size;
  if (aspect > 1) dH = size / aspect; else dW = size * aspect;

  const toMX = (wx: number) => PADDING + ((wx - bounds.min[0]) / worldW) * (dW - PADDING * 2);
  const toMY = (wz: number) => PADDING + ((wz - bounds.min[1]) / worldH) * (dH - PADDING * 2);
  // If the active viewpoint has a `mapPosition` override (because the user dragged its dot
  // away from the actual capture location), render the player marker at that override too —
  // otherwise the green cone and the red pin disagree visually even though they're "the same".
  const activeVpObj = viewpoints.find((v) => v.id === activeVp);
  const camWorldX = activeVpObj?.mapPosition ? activeVpObj.mapPosition[0] : position[0];
  const camWorldZ = activeVpObj?.mapPosition ? activeVpObj.mapPosition[1] : position[2];
  const camX = toMX(camWorldX), camY = toMY(camWorldZ);
  // PlayCanvas yaw 0 → forward (-Z) → screen "up". Yaw rotates CCW around +Y when viewed from
  // above, so on a top-down map yaw 90° → looking -X → screen "left". Mapping: screen-angle =
  // yaw + 90° (so tip = camera + (cos(angle), -sin(angle)) — note Y is flipped because SVG +Y is down).
  const yawRad = (yaw + 90) * Math.PI / 180;
  const cl = Math.min(dW, dH) * 0.09, cs = 0.4;
  const tip = { x: camX + Math.cos(yawRad) * cl, y: camY - Math.sin(yawRad) * cl };
  const cL = { x: camX + Math.cos(yawRad + cs) * cl * 0.7, y: camY - Math.sin(yawRad + cs) * cl * 0.7 };
  const cR = { x: camX + Math.cos(yawRad - cs) * cl * 0.7, y: camY - Math.sin(yawRad - cs) * cl * 0.7 };
  const rW = (dW - PADDING * 2) / 4 * 0.85, rH = (dH - PADDING * 2) / 4 * 0.85;
  const mr = dW > 250 ? 8 : 5, fs = dW > 250 ? 12 : 9;

  const getSvgPt = useCallback((cx: number, cy: number) => {
    const svg = svgRef.current; if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left) * (dW / r.width), y: (cy - r.top) * (dH / r.height) };
  }, [dW, dH]);

  const onDS = useCallback((id: string, cx: number, cy: number) => {
    if (!editable) return;
    const vp = viewpoints.find(v => v.id === id); if (!vp) return;
    const pt = getSvgPt(cx, cy);
    // Use the same fallback as the renderer (`(0, 0)` when mapPosition is unset) so the
    // drag origin matches the dot's actual on-screen position. Falling back to vp.position
    // here causes the dot to jump on first drag because the dot is rendered at (0, 0).
    const ox = vp.mapPosition ? vp.mapPosition[0] : 0;
    const oz = vp.mapPosition ? vp.mapPosition[1] : 0;
    dragRef.current = { vpId: id, sx: pt.x, sy: pt.y, ox, oz };
    setDraggingId(id);
  }, [editable, viewpoints, getSvgPt]);

  const onDM = useCallback((cx: number, cy: number) => {
    const d = dragRef.current; if (!d) return;
    const pt = getSvgPt(cx, cy);
    const dwx = ((pt.x - d.sx) / (dW - PADDING * 2)) * worldW;
    const dwz = ((pt.y - d.sy) / (dH - PADDING * 2)) * worldH;
    const newX = +(d.ox + dwx).toFixed(3);
    const newZ = +(d.oz + dwz).toFixed(3);
    // If the caller wants to own the move semantics (e.g. GS mode also syncs
    // `position`), delegate. Otherwise fall back to the legacy "only `mapPosition`"
    // path so VR-only callers keep working.
    if (onMoveViewpoint) {
      onMoveViewpoint(d.vpId, newX, newZ);
      return;
    }
    if (!activePlanId) return;
    useSceneStore.setState((s) => {
      if (!s.manifest?.plans) return s;
      return {
        manifest: {
          ...s.manifest,
          plans: s.manifest.plans.map((p) => p.id === activePlanId ? {
            ...p,
            viewpoints: p.viewpoints.map((v) => v.id === d.vpId ? { ...v, mapPosition: [newX, newZ] as [number, number] } : v),
          } : p),
        },
      };
    });
  }, [getSvgPt, dW, dH, worldW, worldH, activePlanId, onMoveViewpoint]);

  const onDE = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    if (d && onMoveViewpointEnd) onMoveViewpointEnd(d.vpId);
  }, [onMoveViewpointEnd]);

  /** Convert a screen click on the SVG to world (x, z) using the same toMX/toMY mapping. */
  const onSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!editable || !onMapClick) return;
    // If a viewpoint group handled the click first, it'll have stopped propagation.
    const pt = getSvgPt(e.clientX, e.clientY);
    // Inverse of toMX / toMY:
    const worldX = bounds.min[0] + ((pt.x - PADDING) / (dW - PADDING * 2)) * worldW;
    const worldZ = bounds.min[1] + ((pt.y - PADDING) / (dH - PADDING * 2)) * worldH;
    // Ignore clicks landing in the padding margin.
    if (pt.x < PADDING || pt.x > dW - PADDING || pt.y < PADDING || pt.y > dH - PADDING) return;
    onMapClick(worldX, worldZ);
  }, [editable, onMapClick, getSvgPt, bounds.min, dW, dH, worldW, worldH]);

  useEffect(() => {
    if (!draggingId) return;
    const mm = (e: MouseEvent) => { e.preventDefault(); onDM(e.clientX, e.clientY); };
    const mu = () => onDE();
    window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu);
    return () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
  }, [draggingId, onDM, onDE]);

  if (!manifest) return null;

  const defStyle: React.CSSProperties = {
    position: 'absolute', bottom: 24, left: 24, width: dW, height: dH,
    background: tokens.glass.surfaceStrong,
    borderRadius: tokens.radius.card,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    boxShadow: tokens.shadow.glass,
    overflow: 'hidden', userSelect: 'none',
    zIndex: 4,
    fontFamily: tokens.font.family,
  };

  if (collapsible && collapsed) {
    const baseBottom = (defStyle.bottom as number) ?? 24;
    const baseLeft = (defStyle.left as number) ?? 18;
    return (
      <button
        onClick={() => setCollapsed(false)}
        title="図面を表示"
        style={{
          position: 'absolute', bottom: baseBottom, left: baseLeft,
          width: 44, height: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: tokens.glass.surfaceStrong,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.pill,
          backdropFilter: tokens.backdrop,
          WebkitBackdropFilter: tokens.backdrop,
          color: tokens.color.text,
          cursor: 'pointer',
          boxShadow: tokens.shadow.glass,
          zIndex: 4,
          outline: 'none',
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
          <path d="M9 3v15M15 6v15" />
        </svg>
      </button>
    );
  }

  return (
    <div style={{ ...defStyle, ...overrideStyle, width: dW, height: dH }}>
      {hasImage && <img src={imageUrl} alt="" style={{ position: 'absolute', top: PADDING, left: PADDING, width: dW - PADDING * 2, height: dH - PADDING * 2, objectFit: 'fill', opacity: 0.7, pointerEvents: 'none' }} />}
      {collapsible && (
        <button
          onClick={() => setCollapsed(true)}
          title="図面を隠す"
          style={{
            position: 'absolute', top: 8, right: 8,
            width: 26, height: 26,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: tokens.glass.surfaceStrong,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.pill,
            color: tokens.color.text,
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
            zIndex: 2,
            backdropFilter: tokens.backdrop,
            WebkitBackdropFilter: tokens.backdrop,
            boxShadow: tokens.shadow.glass,
            outline: 'none',
            fontFamily: tokens.font.family,
          }}
        >×</button>
      )}
      <svg
        ref={svgRef}
        width={dW}
        height={dH}
        viewBox={`0 0 ${dW} ${dH}`}
        style={{ position: 'absolute', top: 0, left: 0, cursor: editable && onMapClick ? 'crosshair' : 'default' }}
        onClick={onSvgClick}
      >
        {!hasImage && Array.from({ length: 5 }).map((_, i) => {
          const gx = PADDING + ((dW - PADDING * 2) / 4) * i, gy = PADDING + ((dH - PADDING * 2) / 4) * i;
          return <g key={i}><line x1={gx} y1={PADDING} x2={gx} y2={dH - PADDING} stroke="rgba(0,0,0,0.08)" strokeWidth={0.5} /><line x1={PADDING} y1={gy} x2={dW - PADDING} y2={gy} stroke="rgba(0,0,0,0.08)" strokeWidth={0.5} /></g>;
        })}
        {!hasImage && <rect x={PADDING} y={PADDING} width={dW - PADDING * 2} height={dH - PADDING * 2} fill="none" stroke="rgba(0,0,0,0.2)" strokeWidth={1.5} rx={4} />}
        {/* Render non-active viewpoints first so the active red pin always sits on top. */}
        {[...viewpoints].sort((a, b) => (a.id === activeVp ? 1 : 0) - (b.id === activeVp ? 1 : 0)).map(vp => {
          // Pin position is purely `mapPosition`. Default origin (0,0) when unset — never
          // falls back to `vp.position` (which 📷 mutates).
          const mx = vp.mapPosition ? vp.mapPosition[0] : 0;
          const mz = vp.mapPosition ? vp.mapPosition[1] : 0;
          const cx = toMX(mx), cy = toMY(mz);
          const isA = activeVp === vp.id, isD = draggingId === vp.id, canD = editable;
          // Debug 図面 cone is purely `mapYaw` (slider). Independent of `target`, so saving
          // the VR thumbnail / initial direction never spins the cone. Defaults to 0°.
          const vpYaw = typeof vp.mapYaw === 'number' ? vp.mapYaw : 0;
          const hasDir = true;
          const vpYawRad = (vpYaw + 90) * Math.PI / 180;
          const vcl = cl * (isA ? 0.75 : 0.55);
          const vSpread = 0.55;
          const vTip = { x: cx + Math.cos(vpYawRad) * vcl, y: cy - Math.sin(vpYawRad) * vcl };
          const vL = { x: cx + Math.cos(vpYawRad + vSpread) * vcl * 0.7, y: cy - Math.sin(vpYawRad + vSpread) * vcl * 0.7 };
          const vR = { x: cx + Math.cos(vpYawRad - vSpread) * vcl * 0.7, y: cy - Math.sin(vpYawRad - vSpread) * vcl * 0.7 };
          // Active = red + bigger + halo. Inactive = dark neutral so it stays readable on
          // any floor-plan image (white themed panel makes white pins disappear).
          const pinFill = isA ? '#ef4444' : 'rgba(31,41,55,0.7)';
          const pinStroke = '#fff';
          const pinR = isA ? mr + 3 : mr - 2;
          const coneFill = isA ? 'rgba(239,68,68,0.4)' : 'rgba(31,41,55,0.18)';
          const coneStroke = isA ? 'rgba(239,68,68,0.95)' : 'rgba(31,41,55,0.5)';
          const labelFill = isA ? '#b91c1c' : 'rgba(31,41,55,0.85)';
          return hasImage ? (
            <g key={vp.id} style={{ cursor: canD ? (isD ? 'grabbing' : 'grab') : 'pointer' }}
              onClick={(e) => { e.stopPropagation(); if (!isD) onViewpointClick(vp.id); }}
              onMouseDown={e => { if (canD) { e.preventDefault(); e.stopPropagation(); onDS(vp.id, e.clientX, e.clientY); } }}>
              {hasDir && (
                <polygon points={`${cx},${cy} ${vL.x},${vL.y} ${vTip.x},${vTip.y} ${vR.x},${vR.y}`} fill={coneFill} stroke={coneStroke} strokeWidth={isA ? 1.2 : 0.8} />
              )}
              {isA && (
                /* Outer ring for the active red pin to make it pop against busy floor plan images. */
                <circle cx={cx} cy={cy} r={pinR + 4} fill="none" stroke="rgba(239,68,68,0.45)" strokeWidth={2} />
              )}
              <circle cx={cx} cy={cy} r={pinR} fill={pinFill} stroke={pinStroke} strokeWidth={isA ? 2 : 1} />
              <text x={cx} y={cy - pinR - 4} textAnchor="middle" fill={labelFill} fontSize={fs} fontFamily="sans-serif" fontWeight={isA || isD ? 'bold' : 'normal'} stroke="rgba(0,0,0,0.6)" strokeWidth={2} paintOrder="stroke">{vp.label}</text>
            </g>
          ) : (
            <g key={vp.id} style={{ cursor: canD ? (isD ? 'grabbing' : 'grab') : 'pointer' }}
              onClick={(e) => { e.stopPropagation(); if (!isD) onViewpointClick(vp.id); }}
              onMouseDown={e => { if (canD) { e.preventDefault(); e.stopPropagation(); onDS(vp.id, e.clientX, e.clientY); } }}>
              <rect x={cx - rW / 2} y={cy - rH / 2} width={rW} height={rH}
                fill={isA ? 'rgba(239,68,68,0.18)' : 'rgba(0,0,0,0.04)'}
                stroke={isA ? 'rgba(239,68,68,0.7)' : 'rgba(0,0,0,0.12)'}
                strokeWidth={isA ? 1.4 : 0.8}
                strokeDasharray={isA ? 'none' : '3 2'} rx={3} />
              <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                fill={isA ? '#b91c1c' : 'rgba(31,41,55,0.6)'} fontSize={fs} fontFamily="sans-serif" fontWeight={isA ? 'bold' : 'normal'}>{vp.label}</text>
              {hasDir && (
                <polygon points={`${cx},${cy} ${vL.x},${vL.y} ${vTip.x},${vTip.y} ${vR.x},${vR.y}`} fill={coneFill} stroke={coneStroke} strokeWidth={0.8} />
              )}
            </g>
          );
        })}
        {!editable && (
          <>
            <polygon points={`${camX},${camY} ${cL.x},${cL.y} ${tip.x},${tip.y} ${cR.x},${cR.y}`} fill="rgba(76,175,80,0.3)" stroke="rgba(76,175,80,0.7)" strokeWidth={0.8} />
            <circle cx={camX} cy={camY} r={dW > 250 ? 6 : 4} fill="#4caf50" stroke="#fff" strokeWidth={1.5} />
          </>
        )}
      </svg>
    </div>
  );
}
