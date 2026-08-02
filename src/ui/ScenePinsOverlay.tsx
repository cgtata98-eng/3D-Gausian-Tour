import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useUIStore } from '../store/ui-store';
import { useCameraStore } from '../store/camera-store';
import type { ScenePin } from '../core/types';
import { getPinPlacements } from '../core/pin-placements';
import { tokens , shellSurface } from './design-tokens';

/**
 * HTML overlay that renders annotation pins anchored to 3D positions in the
 * active plan. Each pin's screen position is recomputed every frame by calling
 * the engine's `worldToScreen` helper, written directly to the chip element's
 * `transform` via a ref so React doesn't re-render every frame (smooth even
 * with many pins / fast camera movement). Clicking a chip toggles a popup
 * with title / comment / image and a "商品を見る" link.
 *
 * Requires a SceneManager that exposes `worldToScreen(world)`. The Viewer /
 * DebugViewer already stash the live manager on `window.__sceneManager`, so we
 * reach in via that handle to avoid threading another React ref through every
 * caller.
 *
 * Visibility is gated by `useUIStore.showPins` — the toolbar / sidebar toggle
 * sets this to false to hide all pins. The Viewer's outer gate also checks
 * `viewerToolbar.pins` so customers only see pins on opted-in scenes.
 */
type SceneManagerLike = {
  worldToScreen?: (w: [number, number, number]) => { x: number; y: number } | null;
  screenToScenePoint?: (x: number, y: number) => [number, number, number] | null;
};

export function ScenePinsOverlay({
  containerRef,
  editable = false,
}: {
  /** The element pins should be positioned within (the canvas wrapper). Used
   *  to compute the canvas offset within its container — typically zero, but
   *  the read keeps us robust if a future layout adds padding/border. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Debug authoring: drag a chip to move its placement directly in 3D — the
   *  new position surface-snaps to the collision mesh under the cursor (B1).
   *  Writes go through `updatePinPlacement` only (position; the placement's
   *  viewpoint binding is untouched by a drag). */
  editable?: boolean;
}) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const activeViewpoint = useCameraStore((s) => s.activeViewpoint);
  const showPins = useUIStore((s) => s.showPins);
  const activePlan = manifest?.plans?.find((p) => p.id === activePlanId);
  // Flatten (pin, placement) pairs to one chip per placement bound to the
  // CURRENT viewpoint. Same tag → multiple chips when it has multiple
  // placements. Each chip's DOM key combines pin id + placement id so
  // refs / animation state stay stable across viewpoint changes.
  type RenderEntry = { pin: ScenePin; placementId: string; position: [number, number, number] };
  const entries: RenderEntry[] = useMemo(() => {
    if (!activeViewpoint) return [];
    const out: RenderEntry[] = [];
    for (const pin of activePlan?.pins ?? []) {
      for (const pl of getPinPlacements(pin)) {
        if (pl.viewpointId === activeViewpoint) {
          out.push({ pin, placementId: pl.id, position: pl.position });
        }
      }
    }
    return out;
  }, [activePlan?.pins, activeViewpoint]);
  const [openId, setOpenId] = useState<string | null>(null);
  // Direct DOM refs keyed by pin id — the rAF tick mutates each chip's
  // transform without triggering React re-renders, so dragging the camera
  // is smooth even with dozens of pins on screen.
  const chipRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  // Chip-drag state (editable only). `moved` distinguishes a real drag from a
  // click; the click that trails a drag's pointer-up is suppressed so it
  // doesn't toggle the popup (same phantom-click mechanism as FloorPlanMiniMap).
  const dragRef = useRef<{ pinId: string; placementId: string; startX: number; startY: number; moved: boolean } | null>(null);

  /** Move the dragged placement to the surface point under the cursor. */
  const dragTo = (clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    const sm = (window as unknown as { __sceneManager?: SceneManagerLike }).__sceneManager;
    const canvas = containerRef.current?.querySelector('canvas');
    if (!sm?.screenToScenePoint || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const pos = sm.screenToScenePoint(clientX - r.left, clientY - r.top);
    if (!pos) return;
    useSceneStore.getState().updatePinPlacement(d.pinId, d.placementId, { position: pos });
  };

  useEffect(() => {
    if (entries.length === 0 || !showPins) return;
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const sm = (window as unknown as { __sceneManager?: SceneManagerLike }).__sceneManager;
      if (!sm?.worldToScreen) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const container = containerRef.current;
      const canvas = container?.querySelector('canvas');
      const containerRect = container?.getBoundingClientRect();
      const canvasRect = canvas?.getBoundingClientRect();
      const offsetX = (canvasRect && containerRect) ? canvasRect.left - containerRect.left : 0;
      const offsetY = (canvasRect && containerRect) ? canvasRect.top - containerRect.top : 0;
      for (const entry of entries) {
        const key = chipKey(entry.pin.id, entry.placementId);
        const node = chipRefs.current.get(key);
        if (!node) continue;
        // Method call (preserves `this` binding) — see worldToScreen comment in scene-manager.
        const p = sm.worldToScreen(entry.position);
        if (!p) {
          node.style.display = 'none';
          continue;
        }
        const x = p.x + offsetX;
        const y = p.y + offsetY;
        node.style.display = '';
        node.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [entries, showPins, containerRef]);

  // Close the open popup when the user clicks outside any pin.
  useEffect(() => {
    if (!openId) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('[data-pin-overlay]')) return;
      setOpenId(null);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [openId]);

  // Drop refs for chips that disappeared (Map GC).
  useLayoutEffect(() => {
    const live = new Set(entries.map((e) => chipKey(e.pin.id, e.placementId)));
    for (const k of chipRefs.current.keys()) {
      if (!live.has(k)) chipRefs.current.delete(k);
    }
  }, [entries]);

  if (!showPins || entries.length === 0) return null;

  return (
    <>
      {entries.map((entry) => {
        const key = chipKey(entry.pin.id, entry.placementId);
        const isOpen = openId === key;
        return (
          <div
            key={key}
            ref={(node) => { chipRefs.current.set(key, node); }}
            data-pin-overlay
            style={pinAnchorStyle}
          >
            <button
              type="button"
              onClick={() => {
                // A drag's trailing click must not toggle the popup.
                if (dragRef.current?.moved) { dragRef.current = null; return; }
                dragRef.current = null;
                setOpenId(isOpen ? null : key);
              }}
              onPointerDown={(e) => {
                if (!editable || e.button !== 0) return;
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
                dragRef.current = {
                  pinId: entry.pin.id,
                  placementId: entry.placementId,
                  startX: e.clientX,
                  startY: e.clientY,
                  moved: false,
                };
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d) return;
                // 3px slack so a shaky click doesn't count as a drag.
                if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= 3) return;
                d.moved = true;
                dragTo(e.clientX, e.clientY);
              }}
              onPointerUp={() => {
                // Keep dragRef until the trailing click consumes `moved`.
                if (dragRef.current && !dragRef.current.moved) dragRef.current = null;
              }}
              title={editable ? `${entry.pin.title || 'タグ'} — ドラッグで移動（メッシュ表面に吸着）` : entry.pin.title}
              className="glass-edge"
              style={{ ...chipStyle, ...(isOpen ? chipStyleActive : null), ...(editable ? { cursor: 'grab', touchAction: 'none' as const } : null) }}
            >
              <span style={chipDot} />
              <span style={chipLabel}>{entry.pin.title || 'タグ'}</span>
            </button>
            {isOpen && <PinPopup pin={entry.pin} />}
          </div>
        );
      })}
    </>
  );
}

/** Unique DOM key for a (pin, placement) pair. */
function chipKey(pinId: string, placementId: string): string {
  return `${pinId}#${placementId}`;
}

function PinPopup({ pin }: { pin: ScenePin }) {
  return (
    <div
      data-pin-overlay
      style={popupStyle}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={popupTitle}>{pin.title || 'タグ'}</div>
      {pin.image && (
        <img src={pin.image} alt="" style={popupImage} />
      )}
      {pin.comment && (
        <div style={popupComment}>{pin.comment}</div>
      )}
      {pin.url && (
        <a href={pin.url} target="_blank" rel="noopener noreferrer" style={popupLink}>
          商品を見る ↗
        </a>
      )}
    </div>
  );
}

// translate3d to (0,0) initially; the rAF tick overwrites this on the first
// frame. `position: absolute` anchors the chip into the wrapper's coordinate
// system; `pointerEvents: auto` lets clicks land even though the canvas
// underneath also has its own listeners.
const pinAnchorStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  transform: 'translate3d(-9999px, -9999px, 0)',
  pointerEvents: 'auto',
  zIndex: 60,
  // Smooth out the start-up flash before the first rAF write.
  willChange: 'transform',
};

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px 5px 6px',
  background: tokens.glass.surface,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  ...shellSurface('plain'),
  fontSize: tokens.font.size.md,
  fontWeight: tokens.font.weight.strong,
  cursor: 'pointer',
  outline: 'none',
  whiteSpace: 'nowrap' as const,
  maxWidth: 220,
};

const chipStyleActive: React.CSSProperties = shellSurface('accent');

const chipDot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: tokens.color.accent,
  borderWidth: 1,
  borderStyle: 'solid' as const,
  borderColor: 'rgba(255,255,255,0.85)',
  flexShrink: 0,
};

const chipLabel: React.CSSProperties = {
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis',
};

const popupStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: '50%',
  transform: 'translateX(-50%)',
  width: 240,
  padding: 12,
  background: tokens.glass.surfaceStrong,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  borderWidth: 1,
  borderStyle: 'solid' as const,
  borderColor: tokens.color.border,
  borderRadius: tokens.radius.card,
  boxShadow: tokens.shadow.dialog,
  color: tokens.color.text,
  fontFamily: tokens.font.family,
  zIndex: 70,
};

const popupTitle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: tokens.font.weight.strong,
  marginBottom: 8,
  lineHeight: 1.4,
};

const popupImage: React.CSSProperties = {
  width: '100%',
  height: 120,
  objectFit: 'cover' as const,
  borderRadius: tokens.radius.md,
  marginBottom: 8,
  background: 'rgba(0,0,0,0.06)',
};

const popupComment: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.55,
  color: tokens.color.textMute,
  marginBottom: 10,
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
};

const popupLink: React.CSSProperties = {
  display: 'block',
  textAlign: 'center' as const,
  padding: '8px 12px',
  background: tokens.gradient.accent,
  color: tokens.color.text,
  borderWidth: 1,
  borderStyle: 'solid' as const,
  borderColor: tokens.color.accentBorder,
  borderRadius: tokens.radius.pill,
  fontSize: 11.5,
  fontWeight: tokens.font.weight.strong,
  textDecoration: 'none',
  boxShadow: tokens.shadow.glassAccent,
};
