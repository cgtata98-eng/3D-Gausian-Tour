import { useEffect, useRef, useState } from 'react';
import { ThreeSceneManager } from '../engine/three/three-scene-manager';
import { SceneManager } from '../engine/scene-manager';
import { initApp } from '../engine/app-init';
import { loadSceneManifest } from '../core/scene-manifest';
import type { ViewerEngine } from '../core/types';
import { useSceneStore } from '../store/scene-store';
import { useUIStore } from '../store/ui-store';
import { useProjectStore } from '../store/project-store';
import { LoadingScreen } from './LoadingScreen';
import { ViewerOverlay } from './ViewerOverlay';
import { WalkthroughControls } from './WalkthroughControls';
import { AiScreenOverlay, AiGeneratingOverlay } from './LeftPanel';
import { AmbientAudio } from './AmbientAudio';
import { FootstepAudio } from './FootstepAudio';
import { useDemoModeCamera } from './useDemoModeCamera';
import { MobileJoystick } from './MobileJoystick';
import { ScenePinsOverlay } from './ScenePinsOverlay';
import { tokens } from './design-tokens';

/** Subset of methods Viewer needs, satisfied by both ThreeSceneManager and the
 *  PlayCanvas SceneManager. Lets `sceneManagerRef` hold either implementation. */
type AnySceneManager = ThreeSceneManager | SceneManager;

interface ViewerProps {
  sceneId: string;
}

export function Viewer({ sceneId }: ViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneManagerRef = useRef<AnySceneManager | null>(null);
  const [ready, setReady] = useState(false);
  const { isLoading, error, manifest } = useSceneStore();
  const furniture = useUIStore((s) => s.furniture);
  const lighting = useUIStore((s) => s.lighting);
  const viewMode = useUIStore((s) => s.viewMode);
  const movementMode = useUIStore((s) => s.movementMode);
  const activeColor = useUIStore((s) => s.activeColor);
  const showGrid = useUIStore((s) => s.showGrid);
  const qualityMode = useUIStore((s) => s.qualityMode);
  // Expose the live scene manager on window so the AI sidebar block (which doesn't
  // have a ref to it through React) can call `captureCurrent360Snapshot()`.
  useEffect(() => {
    (window as unknown as { __sceneManager?: AnySceneManager | null }).__sceneManager = sceneManagerRef.current;
  }, [ready]);

  // Restore viewMode / projectType from the project store on direct URL entry — otherwise
  // a hard-reload of a VR scene would land in splat mode (the UI store default).
  useEffect(() => {
    const project = useProjectStore.getState().getProject(sceneId);
    if (project) {
      useUIStore.getState().setViewMode(project.viewMode);
      useUIStore.getState().setProjectType(project.type);
    }
  }, [sceneId]);

  // 描画エンジンは **マウント時点** で決定 (= リロードで反映)。実行中のホットスワップは
  // PlayCanvas / mkkellogg / Spark で WebGL コンテキストを破棄→再作成する race が大きく
  // 不安定なので避ける。エンジン選択を変更した場合は「リロード」ボタンを押す運用。
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let destroyed = false;
    (async () => {
      try {
        const manifest = await loadSceneManifest(sceneId);
        if (destroyed) return;
        useSceneStore.getState().setManifest(manifest);
        // 色調整 (bypassColorPipeline) は Debug 側のオーサリングだけが決める。
        // Viewer は manifest 値をそのまま使い、セッション上書きは持たない。
        const renderCfg = manifest.settings.render;
        // Default flipped to PlayCanvas — the SuperSplat-quality migration in
        // `app-init.ts` + `gsplat-loader.ts` (CameraFrame post pipeline, gamma
        // passthrough, radialSorting, SH define, splatScale chunk) brings PlayCanvas
        // output up to SuperSplat-editor parity. Three-based engines (mkkellogg /
        // spark) remain available via `manifest.settings.render.engine`.
        const engineToUse: ViewerEngine = renderCfg?.engine ?? 'playcanvas';
        if (engineToUse === 'playcanvas') {
          canvas.style.display = 'block';
          const ctx = await initApp(canvas, { msaaSamples: renderCfg?.msaaSamples ?? 4, render: renderCfg });
          if (destroyed) { ctx.app.destroy(); return; }
          const sm = new SceneManager(ctx.app, ctx.camera, ctx.cameraFrame);
          sceneManagerRef.current = sm;
          setReady(true);
          await sm.loadScene(sceneId);
        } else {
          canvas.style.display = 'none';
          const manager = new ThreeSceneManager(wrap, engineToUse);
          if (destroyed) { manager.destroy(); return; }
          sceneManagerRef.current = manager;
          setReady(true);
          await manager.loadScene(sceneId);
        }
      } catch (err) {
        console.error('Failed to initialize viewer:', err);
      }
    })();
    return () => {
      destroyed = true;
      try { sceneManagerRef.current?.destroy(); } catch { /* ignore */ }
      sceneManagerRef.current = null;
      // Use the nodes captured when the effect ran — the refs may already point
      // elsewhere (or be null) by cleanup time.
      canvas.style.display = 'block';
      Array.from(wrap.querySelectorAll('canvas')).forEach((node) => { if (node !== canvas) node.remove(); });
      setReady(false);
    };
  }, [sceneId]);

  // Swap splat when furniture / lighting mode changes. No-op if manifest has no splatVariants.
  useEffect(() => {
    if (!ready || !manifest?.splatVariants) return;
    sceneManagerRef.current?.setVariant(furniture, lighting);
  }, [ready, manifest, furniture, lighting]);

  // Mirror view mode and movement mode from UI store into the engine.
  useEffect(() => { if (ready) sceneManagerRef.current?.setViewMode(viewMode); }, [ready, viewMode]);
  useEffect(() => { if (ready) sceneManagerRef.current?.setMovementMode(movementMode); }, [ready, movementMode]);

  // タッチ端末: シーン準備完了後 / モバイル設定値変更時に moveSpeed を強制適用。
  // manifest.settings.moveSpeed が新しい CameraController の初期値として焼き込まれるため、
  // セッションでユーザーが選んだ値を消さないようここで上書きしておく。
  const mobileMoveSpeed = useUIStore((s) => s.mobileMoveSpeed);
  useEffect(() => {
    if (!ready) return;
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    sceneManagerRef.current?.setMoveSpeed(mobileMoveSpeed);
  }, [ready, mobileMoveSpeed]);

  // Demo mode (Xrealtracking): start WebSocket + push head-tracking offsets to camera.
  useDemoModeCamera(ready ? sceneManagerRef.current : null);
  // Debug grid toggle.
  useEffect(() => { if (ready) sceneManagerRef.current?.setGridVisible(showGrid); }, [ready, showGrid]);
  // Live-apply render-quality settings whenever they change (toolbar / preset clicks).
  // bypassColorPipeline は CameraFrame の有無を切り替えるので、トグルは reload で反映する
  // (= 初期化時の `initApp` だけが見る)。ここでは触らない。
  useEffect(() => {
    if (!ready) return;
    sceneManagerRef.current?.applyRenderConfig(manifest?.settings.render);
  }, [ready, manifest?.settings.render]);
  useEffect(() => { if (ready) void sceneManagerRef.current?.applyActiveColor(); }, [ready, activeColor]);
  // AI variant: only kind='screen' is supported now — `AiScreenOverlay` paints
  // the 2D result on top of the canvas. No engine-side mode switching needed.
  // (kind='panorama' entries from old runs are simply ignored here.)
  // Live quality preset (LOW / MID / HIGH). Re-applies on mount + every store change.
  // Three-based engines (Spark / mk) ignore it — only PlayCanvas's SceneManager has the method.
  useEffect(() => {
    if (!ready) return;
    const sm = sceneManagerRef.current;
    if (sm && 'applyQualityMode' in sm) sm.applyQualityMode(qualityMode);
  }, [ready, qualityMode]);
  // Mirror mode (canvas pixel stream over WebRTC, BroadcastChannel-signalled).
  const mirrorMode = useUIStore((s) => s.mirrorMode);
  useEffect(() => {
    if (!ready || mirrorMode !== 'send') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let sender: { stop(): void } | null = null;
    void import('../utils/mirror-rtc').then(({ MirrorSender }) => {
      if (cancelled) return;
      const s = new MirrorSender();
      s.start(canvas);
      sender = s;
    });
    return () => { cancelled = true; sender?.stop(); };
  }, [ready, mirrorMode]);

  const handleViewpointClick = (viewpointId: string) => {
    const manager = sceneManagerRef.current;
    if (!manager) return;
    const state = useSceneStore.getState();
    const m = state.manifest;
    if (!m) return;
    const plan = m.plans?.find((p) => p.id === state.activePlanId);
    const vp = plan?.viewpoints.find((v) => v.id === viewpointId);
    if (vp) manager.jumpToViewpoint(vp);
  };

  return (
    <div ref={wrapRef} style={wrap}>
      <canvas ref={canvasRef} style={canvasStyle} />
      <AiScreenOverlay />
      <AiGeneratingOverlay />

      {/* Show the loading overlay from t=0 (before manifest/engine are ready) all the
          way through `loadScene` — otherwise the manifest fetch + WebGL init window leaves
          a blank canvas with no feedback. */}
      {(!ready || isLoading) && !error && <LoadingScreen />}

      {error && (
        <div style={errorBox}>
          <div style={{ fontSize: 13, fontWeight: tokens.font.weight.strong, marginBottom: 6 }}>読み込みに失敗しました</div>
          <div style={{ fontSize: 11.5, opacity: 0.75 }}>{error}</div>
        </div>
      )}

      {ready && !isLoading && !error && (
        <>
          <AmbientAudio />
          <FootstepAudio />
          <ViewerOverlay
            sceneId={sceneId}
            onViewpointClick={handleViewpointClick}
            showDebugLink={false}
            onPlanSwitch={(planId) => { void sceneManagerRef.current?.setActivePlan(planId); }}
          />
          <WalkthroughControls getManager={() => sceneManagerRef.current} />
          {/* 移動が無い product (showroom) ではジョイスティックを出さない。OrbitCameraController が
              キャンバスの touch / pointer をそのまま使うので joystick オーバーレイは邪魔。 */}
          {useUIStore.getState().projectType !== 'product' && (
            <MobileJoystick onChange={(x, y) => {
              sceneManagerRef.current?.setTouchJoystick?.(x, y);
              // ジョイスティックを動かしたら左サイドバーを閉じる (スマホのみ。
              // MobileJoystick 自体が pointer:coarse 端末でしか描画されないので、
              // ここに来た時点で touch device 確定)。閉じる操作は冪等なので毎フレーム呼んで OK。
              if (x !== 0 || y !== 0) useUIStore.getState().setSidebarCollapsed(true);
            }} />
          )}
          <PinsOverlayGate containerRef={wrapRef} />
        </>
      )}
    </div>
  );
}

/**
 * Gate the pins overlay by both the per-project toolbar opt-in
 * (`viewerToolbar.pins === true`) and the runtime sidebar show toggle
 * (`showPins`). Either being false hides the overlay. Kept inline in this
 * file (rather than baked into ScenePinsOverlay) so DebugViewer can render
 * the overlay unconditionally for authoring while customers go through
 * this gate.
 */
function PinsOverlayGate({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const tb = useSceneStore((s) => s.manifest?.viewerToolbar);
  const showPins = useUIStore((s) => s.showPins);
  if (!tb?.pins) return null;
  if (!showPins) return null;
  return <ScenePinsOverlay containerRef={containerRef} />;
}

const wrap: React.CSSProperties = {
  position: 'relative',
  width: '100vw',
  height: '100vh',
  overflow: 'hidden',
  background: tokens.color.bg,
  color: tokens.color.text,
  fontFamily: tokens.font.family,
};

const canvasStyle: React.CSSProperties = { width: '100%', height: '100%', display: 'block' };

const errorBox: React.CSSProperties = {
  position: 'absolute', top: '50%', left: '50%',
  transform: 'translate(-50%, -50%)',
  background: tokens.glass.surfaceStrong,
  border: `1px solid ${tokens.color.dangerBorder}`,
  color: tokens.color.text,
  padding: '20px 26px',
  borderRadius: tokens.radius.card,
  textAlign: 'center',
  maxWidth: 360,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  boxShadow: tokens.shadow.dialog,
  fontFamily: tokens.font.family,
};
