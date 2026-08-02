import { useEffect } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { useUIStore } from '../store/ui-store';
import { LeftPanel } from './LeftPanel';
import { calibrateHeadTracker } from '../utils/head-tracker';
import { navigate } from '../utils/url';
import { surfaceClass } from './components';
import { WALKTHROUGH_AUTHORING_ONLY } from '../core/walk-graph';

interface ViewerOverlayProps {
  sceneId: string;
  onViewpointClick: (id: string) => void;
  /** When false, hides the "back to debug" gear button (use inside the debug preview) */
  showDebugLink?: boolean;
  /**
   * When false, disables the A/D viewpoint cycling shortcut. Used inside the DebugViewer
   * preview where A/D should remain pure camera strafing — viewpoints are still
   * being authored, so teleport-on-keypress would interrupt the workflow.
   */
  enableViewpointShortcuts?: boolean;
  /** When true, suppresses the LeftPanel sidebar (floor plan / viewpoints / etc).
   *  Used by the Debug 動画タブ to keep the canvas clean during preview / recording. */
  hideLeftPanel?: boolean;
}

/**
 * The full set of UI overlays shown on top of the 3D canvas in Viewer mode.
 * Shared between Viewer and DebugViewer's preview pane so they stay visually identical.
 *
 * 移動モード (歩く / フライ) のトグルは、以前ここにフローティングボタンとして表示していたが、
 * `LeftPanel` のサイドバー内 (`MovementModeBlock`) に統合済みなのでここからは削除している。
 */
export function ViewerOverlay({ sceneId, onViewpointClick, showDebugLink = true, enableViewpointShortcuts = true, hideLeftPanel = false, onPlanSwitch }: ViewerOverlayProps & { onPlanSwitch?: (planId: string) => void }) {
  // A / D で視点を前後に移動 — **360° (VR) モード時のみ**。
  // 3DGS モードでは A/D は camera-controller の strafe (左右移動) に専用なので、視点
  // サイクルとは衝突する。VR ではテレポート式なので strafe 概念がなく、A/D を視点切替に
  // 使っても干渉しない。
  // - 押した瞬間 (e.repeat === false) のみ反応 → 連打で素早く切替できるが押しっぱなしで暴走しない
  // - 入力欄にフォーカスがあるときはスキップ (テキスト編集を妨げない)
  useEffect(() => {
    if (!enableViewpointShortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code !== 'KeyA' && e.code !== 'KeyD') return;
      // 3DGS では A/D は移動 (strafe) なので視点サイクルさせない。
      if (useUIStore.getState().viewMode !== '360') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      const state = useSceneStore.getState();
      const cam = useCameraStore.getState();
      const plan = state.manifest?.plans?.find((p) => p.id === state.activePlanId);
      if (!plan || plan.viewpoints.length === 0) return;
      const idx = plan.viewpoints.findIndex((v) => v.id === cam.activeViewpoint);
      const len = plan.viewpoints.length;
      const nextIdx = e.code === 'KeyA'
        ? (idx <= 0 ? len - 1 : idx - 1)
        : (idx === len - 1 ? 0 : idx + 1);
      onViewpointClick(plan.viewpoints[nextIdx].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onViewpointClick, enableViewpointShortcuts]);

  // 360° モードで移動キーを押したら 3DGS モードへ自動復帰 + アクティブな AI variant
  // をクリア。360° は固定視点なので「動こう」と思っても操作不能 → ユーザーは GS に
  // 戻りたいと判断。AI 360° variant を見ているケースも同じく抜ける。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      if (useUIStore.getState().viewMode !== '360') return;
      const movementKeys = new Set([
        'KeyW', 'KeyA', 'KeyS', 'KeyD',
        'KeyQ', 'KeyE',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      ]);
      if (!movementKeys.has(e.code)) return;
      // ウォークスルー (walk graph) 持ちプランでは W/↑ = 前進として
      // WalkthroughControls が消費する — GS へ自動復帰すると splat の無い
      // walk プランは白背景だけになる。移動キーでの 360 離脱は無効。
      // ただし編集画面でだけ。ビューアではウォークスルーを走らせないので、
      // キーを取り置く相手がおらず、押しても何も起きない状態になる。
      const st = useSceneStore.getState();
      const activePlan = st.manifest?.plans?.find((p) => p.id === st.activePlanId);
      const walkLive = !WALKTHROUGH_AUTHORING_ONLY || useUIStore.getState().isDeveloper;
      if (walkLive && activePlan?.walk && activePlan.walk.nodes.length > 0) return;
      const ui = useUIStore.getState();
      ui.setViewMode('splat');
      const sm = (window as unknown as { __sceneManager?: { setViewMode?: (v: 'splat' | '360') => void } }).__sceneManager;
      sm?.setViewMode?.('splat');
      if (ui.activeAiId) ui.setActiveAiId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // C でヘッドトラッキングの中央リセット — トラッキング ON のときだけ反応。
  // サイドバーの「↻ 中央リセット」ボタンと同じ `calibrateHeadTracker()` を叩くだけ。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code !== 'KeyC') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      if (!useUIStore.getState().demoMode) return;
      void calibrateHeadTracker();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // F で歩く⇄フライ切替 (3DGS のみ — 360° モードには移動概念がないので無視)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code !== 'KeyF') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      const ui = useUIStore.getState();
      if (ui.viewMode === '360') return;
      ui.setMovementMode(ui.movementMode === 'fly' ? 'walk' : 'fly');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Gamepad button edges (D-pad ←/→, L2, ○, △) ──────────────────
  // Continuous input (sticks, R2) and ✕/□ moveSpeed step are handled inside the
  // camera controller. Here we edge-detect button presses for actions that don't fit
  // "every frame" semantics:
  //  - D-pad ←/→: plan cycle prev/next within the current project — works in any view mode
  //  - L2:        toggle demo mode (mirrors the Xrealtracking PoC's L2 = trackingON/OFF)
  //  - ○:         toggle walk ⇄ fly (mirrors the F key, 3DGS only)
  //  - △:         center-reset head tracking (mirrors the C key, demo mode only)
  // Polled at 50 ms which is plenty for human button rate.
  useEffect(() => {
    if (!enableViewpointShortcuts) return;
    const prev = { dpadL: false, dpadR: false, l2: false, circle: false, triangle: false };
    const id = window.setInterval(() => {
      const gps = navigator.getGamepads ? navigator.getGamepads() : [];
      const valid = [...gps].filter((g): g is Gamepad => !!g);
      if (valid.length === 0) return;
      const pad = valid.find((g) => g.mapping === 'standard') ?? valid[0];
      const dpadL = pad.buttons[14]?.pressed ?? false;
      const dpadR = pad.buttons[15]?.pressed ?? false;
      const l2 = (pad.buttons[6]?.value ?? 0) > 0.5 || (pad.buttons[6]?.pressed ?? false);
      const circle = pad.buttons[1]?.pressed ?? false;
      const triangle = pad.buttons[3]?.pressed ?? false;

      // D-pad ← = prev plan, D-pad → = next plan within the current project. Wraps
      // around. Routes through the parent's `onPlanSwitch` so SceneManager.setActivePlan
      // runs (same path as the LeftPanel's plan switcher).
      const goPrevPlan = dpadL && !prev.dpadL;
      const goNextPlan = dpadR && !prev.dpadR;
      if (goPrevPlan || goNextPlan) {
        const state = useSceneStore.getState();
        const plans = state.manifest?.plans ?? [];
        if (plans.length > 1 && state.activePlanId) {
          const idx = plans.findIndex((p) => p.id === state.activePlanId);
          if (idx >= 0) {
            const len = plans.length;
            const nextIdx = goPrevPlan
              ? (idx <= 0 ? len - 1 : idx - 1)
              : (idx === len - 1 ? 0 : idx + 1);
            onPlanSwitch?.(plans[nextIdx].id);
          }
        }
      }
      if (l2 && !prev.l2) {
        const ui = useUIStore.getState();
        ui.setDemoMode(!ui.demoMode);
      }
      // ○ = walk/fly toggle (3DGS only — 360° has no movement model).
      if (circle && !prev.circle) {
        const ui = useUIStore.getState();
        if (ui.viewMode !== '360') {
          ui.setMovementMode(ui.movementMode === 'fly' ? 'walk' : 'fly');
        }
      }
      // △ = head-tracking center reset (only meaningful while demo mode is on).
      if (triangle && !prev.triangle) {
        if (useUIStore.getState().demoMode) {
          void calibrateHeadTracker();
        }
      }
      prev.dpadL = dpadL;
      prev.dpadR = dpadR;
      prev.l2 = l2;
      prev.circle = circle;
      prev.triangle = triangle;
    }, 50);
    return () => window.clearInterval(id);
  }, [enableViewpointShortcuts, onPlanSwitch]);

  return (
    <>
      {!hideLeftPanel && <LeftPanel onViewpointClick={onViewpointClick} onPlanSwitch={onPlanSwitch} />}

      <MirrorStatusBadge />

      {showDebugLink && (
        <a
          href={`/scene/${sceneId}`}
          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(`/scene/${sceneId}`); }}
          title="デバッグモード"
          className={`${surfaceClass('plain')} ds-overlay ds-overlay--pill ds-pill ds-pill--icon`}
          style={debugBtn}
          aria-label="Debug Mode"
        >
          <svg className="ds-icon" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </a>
      )}
    </>
  );
}

/**
 * ミラー送信中だけ画面右上に出すバッジ。クリックで停止 (mirrorMode='off')。
 * 送信していない / 受信側の画面では何も出さない。
 */
function MirrorStatusBadge() {
  const mode = useUIStore((s) => s.mirrorMode);
  const setMode = useUIStore((s) => s.setMirrorMode);
  if (mode !== 'send') return null;
  return (
    <button
      onClick={() => setMode('off')}
      className={`${surfaceClass('accent')} ds-pill ds-pill--sm`}
      style={mirrorBadge}
      title="ミラーリング送信中 (クリックで停止)"
      aria-label="Mirror sending — click to stop"
    >
      <span>📡</span>
      <span>送信中</span>
      <span style={{ opacity: 0.8 }}>⏹</span>
    </button>
  );
}

/** Layout only. */
const mirrorBadge: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  zIndex: 10,
};

const debugBtn: React.CSSProperties = {
  position: 'absolute',
  bottom: 144, left: 16,
  width: 40, height: 40,
  textDecoration: 'none',
  zIndex: 5,
};
