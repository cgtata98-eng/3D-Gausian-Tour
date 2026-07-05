import { useEffect, useRef, useState } from 'react';
import { findWalkNode, resolveStartNode, stepForward } from '../core/walk-graph';
import { useCameraStore } from '../store/camera-store';
import { useSceneStore } from '../store/scene-store';
import { useUIStore } from '../store/ui-store';
import { tokens } from './design-tokens';

interface Props {
  /** The live scene manager (PlayCanvas union member implements the preview;
   *  Three engines return false and the controls simply do nothing). */
  getManager: () => {
    showPanoramaPreview: (src: string, opts?: { animated?: boolean }) => Promise<boolean>;
  } | null | undefined;
}

/**
 * Dense-walkthrough navigation (B3〜B6 runtime). Mounts in both Viewer and
 * DebugViewer; renders nothing unless the active plan has a `walk` graph and
 * the view is in 360° mode.
 *
 * 前進 = `stepForward` with the LIVE camera yaw → crossfade (C4) into the
 * neighbor's panorama. Facing is carried across hops (yaw untouched);
 * authored `mapYaw` / viewpoints are never read or written.
 *
 * Inputs: the ▲ button (touch-friendly) and W / ↑ keys.
 */
export function WalkthroughControls({ getManager }: Props) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const viewMode = useUIStore((s) => s.viewMode);

  const plan = manifest?.plans?.find((p) => p.id === activePlanId);
  const walk = plan?.walk;
  const active = viewMode === '360' && !!walk && walk.nodes.length > 0;
  const animated = manifest?.settings.walkAnimated !== false; // default true

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  // Reset to the start node when the plan (or graph presence) changes — during
  // render (React's "adjust state when props change" pattern).
  const [prevPlanKey, setPrevPlanKey] = useState(activePlanId);
  if (prevPlanKey !== activePlanId) {
    setPrevPlanKey(activePlanId);
    setCurrentId(null);
  }
  const startNode = walk ? resolveStartNode(walk) : undefined;
  const current = (walk && currentId ? findWalkNode(walk, currentId) : undefined) ?? startNode;

  // Entering the walkthrough: show the start node's panorama once (instant —
  // there's nothing meaningful to fade from).
  const enteredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !current?.panorama) return;
    const key = `${activePlanId}:${current.id}`;
    if (enteredRef.current === key) return;
    // Only auto-apply on activation / plan change, not on every step (steps
    // apply their own panorama with the transition).
    if (enteredRef.current?.startsWith(`${activePlanId}:`)) { enteredRef.current = key; return; }
    enteredRef.current = key;
    void getManager()?.showPanoramaPreview(current.panorama);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on activation/plan change only
  }, [active, activePlanId]);

  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1200);
  };
  useEffect(() => () => { if (flashTimer.current !== null) clearTimeout(flashTimer.current); }, []);

  const step = async () => {
    if (!walk || !current || busy) return;
    const target = stepForward(current, useCameraStore.getState().yaw, walk);
    if (!target?.panorama) { showFlash('この方向へは進めません'); return; }
    setBusy(true);
    try {
      await getManager()?.showPanoramaPreview(target.panorama, { animated });
      setCurrentId(target.id);
    } finally {
      setBusy(false);
    }
  };

  // W / ↑ = 前進 (movement keys are otherwise dead in locked 360 mode).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'KeyW' || e.code === 'ArrowUp') {
        e.preventDefault();
        void step();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!active || !current) return null;

  return (
    <div style={ST.wrap}>
      {flash && <div style={ST.flash}>{flash}</div>}
      <div style={ST.pill}>
        <button
          type="button"
          style={{ ...ST.stepBtn, opacity: busy ? 0.6 : 1 }}
          disabled={busy}
          onClick={() => void step()}
          title="向いている方向の隣のノードへ移動 (W / ↑ キーでも可)"
        >
          ▲ 前進
        </button>
        <span style={ST.nodeLabel}>{current.id}</span>
        <button
          type="button"
          style={ST.animBtn}
          onClick={() => useSceneStore.getState().updateSettings({ walkAnimated: !animated })}
          title="移動アニメーション (クロスフェード + ズーム) の ON/OFF"
        >
          {animated ? '🎞 アニメON' : '⏭ 即切替'}
        </button>
      </div>
    </div>
  );
}

const ST: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'absolute',
    left: '50%',
    bottom: 24,
    transform: 'translateX(-50%)',
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    fontFamily: tokens.font.family,
  },
  flash: {
    padding: '4px 12px',
    fontSize: 11.5,
    fontWeight: 600,
    color: tokens.color.text,
    background: tokens.glass.surfaceStrong,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
  },
  pill: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 10px',
    background: tokens.glass.surfaceStrong,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
  },
  stepBtn: {
    padding: '8px 18px',
    fontSize: 13,
    fontWeight: 700,
    background: tokens.gradient.accent,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.accentBorder}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glassAccent,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
  nodeLabel: {
    fontSize: 12,
    fontWeight: 700,
    fontFamily: tokens.font.mono,
    color: tokens.color.textMute,
    minWidth: 28,
    textAlign: 'center',
  },
  animBtn: {
    padding: '6px 10px',
    fontSize: 11,
    background: tokens.gradient.surface,
    color: tokens.color.textMute,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
  },
};
