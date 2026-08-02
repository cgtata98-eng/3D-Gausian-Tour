import { useEffect, useRef, useState } from 'react';
import { findWalkNode, resolveStartNode, stepForward, WALKTHROUGH_AUTHORING_ONLY } from '../core/walk-graph';
import { walkPlaceholderPanorama } from '../utils/walk-placeholder';
import { useCameraStore } from '../store/camera-store';
import { useSceneStore } from '../store/scene-store';
import { useUIStore } from '../store/ui-store';
import { surfaceClass } from './components';

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
  /**
   * The kill switch lives HERE, not at the two call sites.
   *
   * Gating the mount in `Viewer` left the DebugViewer's preview — which is a
   * preview OF the viewer — still running it, so the feature was still on
   * screen. A component that must not ship yet should refuse to render
   * itself; then there is no call site left to forget.
   *
   * `?mode=dev` still brings it up, so it can be exercised while it is being
   * built. `active` also gates the key handler and the step effect below, so
   * this switches off the behaviour, not just the bar.
   */
  const isDeveloper = useUIStore((s) => s.isDeveloper);
  const enabled = !WALKTHROUGH_AUTHORING_ONLY || isDeveloper;
  const active = enabled && viewMode === '360' && !!walk && walk.nodes.length > 0;
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
  // Walk-only plans have no viewpoint panorama, so 360 mode starts black.
  // Resolve a starting node inside the painted range (excluded = gray cells
  // are out of bounds): start node with an image → any node with an image →
  // start node if in range → any in-range node (direction-guide placeholder).
  const inRange = (n?: { excluded?: boolean }) => !!n && !n.excluded;
  const fallbackNode =
    inRange(startNode) && startNode?.panorama
      ? startNode
      : walk?.nodes.find((n) => !n.excluded && n.panorama)
        ?? (inRange(startNode) ? startNode : walk?.nodes.find((n) => !n.excluded));
  const current = (walk && currentId ? findWalkNode(walk, currentId) : undefined) ?? fallbackNode;

  // Entering the walkthrough: show the start node's panorama once (instant —
  // there's nothing meaningful to fade from). Depends on the resolved node too:
  // when the FIRST image gets assigned while already in 360 mode, the effect
  // must re-fire — with [active, plan] deps alone the view stayed black.
  const enteredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !current) return;
    const key = `${activePlanId}:${current.id}`;
    if (enteredRef.current === key) return;
    // Only auto-apply on activation / plan change / first image, not on every
    // step (steps apply their own panorama with the transition).
    if (enteredRef.current?.startsWith(`${activePlanId}:`)) { enteredRef.current = key; return; }
    enteredRef.current = key;
    // Mode entry races the engine: this (child) effect fires BEFORE the parent
    // effect that calls `sm.setViewMode('360')`, so the first attempt can hit
    // the manager while it still thinks it's in splat mode and get `false`
    // back. Retry briefly before concluding the engine really can't do 360.
    let cancelled = false;
    const tryShow = (attempt: number, usePlaceholder: boolean) => {
      const src = (usePlaceholder ? undefined : current.panorama) ?? walkPlaceholderPanorama(current);
      void getManager()?.showPanoramaPreview(src).then((ok) => {
        if (cancelled || ok !== false) return;
        if (attempt < 5) setTimeout(() => tryShow(attempt + 1, usePlaceholder), 120);
        // Assigned image failed (e.g. dangling idb: ref) — the generated
        // placeholder is a data URL and can still succeed. Never leave white.
        else if (!usePlaceholder && current.panorama) tryShow(0, true);
        else showFlash('360°表示に失敗 — エンジンが未対応の可能性 (PlayCanvas に切替してください)');
      });
    };
    tryShow(0, false);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on activation / plan change / first image only
  }, [active, activePlanId, current?.id, current?.panorama]);

  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1200);
  };
  useEffect(() => () => { if (flashTimer.current !== null) clearTimeout(flashTimer.current); }, []);

  const step = async () => {
    if (!walk || !current || busy) return;
    const target = stepForward(current, useCameraStore.getState().yaw, walk);
    if (!target) { showFlash('この方向へは進めません'); return; }
    setBusy(true);
    try {
      const src = target.panorama ?? walkPlaceholderPanorama(target);
      let ok = await getManager()?.showPanoramaPreview(src, { animated });
      if (!ok && target.panorama) {
        // Assigned image failed to load (e.g. dangling idb: ref) — step onto the
        // direction-guide placeholder instead of leaving the previous panorama.
        ok = await getManager()?.showPanoramaPreview(walkPlaceholderPanorama(target), { animated });
        if (ok) showFlash('画像の読込に失敗 — 仮画像を表示中');
      }
      if (ok) setCurrentId(target.id);
      else showFlash('360°表示に失敗 — エンジンが未対応の可能性 (PlayCanvas に切替してください)');
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

  if (!active) return null;
  if (!current) {
    // Grid exists but the walkable range (blue) hasn't been painted yet.
    return (
      <div style={ST.wrap}>
        <div className={FLASH}>ウォークスルー範囲が未設定です — エディタの 🖌 で歩ける範囲（青）を塗ってください</div>
      </div>
    );
  }

  return (
    <div style={ST.wrap}>
      {flash && <div className={FLASH}>{flash}</div>}
      <div className={`${surfaceClass('plain')} ds-overlay ds-overlay--pill`} style={ST.pill}>
        <button
          type="button"
          className={`${surfaceClass('accent')} ds-pill ds-pill--sm`}
          disabled={busy}
          onClick={() => void step()}
          title="向いている方向の隣のノードへ移動 (W / ↑ キーでも可)"
        >
          ▲ 前進
        </button>
        <span className="ds-mono" style={ST.nodeLabel}>{current.id}</span>
        <button
          type="button"
          className={`${surfaceClass('plain')} ds-pill ds-pill--xs ds-fill-surface`}
          onClick={() => useSceneStore.getState().updateSettings({ walkAnimated: !animated })}
          title="移動の見せ方の切替。ON = ウォークスルー風 (クロスフェード+ズームで歩く演出) / OFF = 即切替 (密なグリッドで GS のように動ける風)。どちらでも「向き→隣ノード」の移動ルールは同じ"
        >
          {animated ? '🚶 ウォークスルー風' : '⚡ 即切替 (GS風)'}
        </button>
      </div>
    </div>
  );
}

/** A transient status line above the control bar — same surface, pill shape. */
const FLASH = `${surfaceClass('plain')} ds-overlay ds-overlay--pill ds-pill ds-pill--xs`;

/** Layout only. */
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
  },
  pill: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 10px',
  },
  nodeLabel: {
    minWidth: 28,
    textAlign: 'center',
  },
};
