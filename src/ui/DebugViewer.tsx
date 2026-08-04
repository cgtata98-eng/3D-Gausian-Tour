import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadSceneManifest } from '../core/scene-manifest';
import type { ViewerEngine, CameraKeyframe } from '../core/types';
import { pickSupportedMime, CanvasRecorder, downloadBlob } from '../utils/video-recorder';
import { interpolatePath, totalPathDurationSec, resolveStartViewpoint } from '../core/viewpoint';
import * as clipLib from '../utils/clip-library';
import type { ClipMeta } from '../utils/clip-library';
import { navigate } from '../utils/url';
import { publishScene } from '../utils/publish';
import { TopDownCollisionEditor, type TopDownManager } from './TopDownCollisionEditor';
import { WalkGraphEditor } from './WalkGraphEditor';
import { WalkthroughControls } from './WalkthroughControls';
import { walkPlaceholderPanorama } from '../utils/walk-placeholder';
import { buildWallBlockGlb, buildFloorWalkableGlb } from '../utils/wall-collision-builder';
import type { CollisionWallData, WalkNode } from '../core/types';
import { getAuthRole } from '../utils/auth';
import { ThreeSceneManager } from '../engine/three/three-scene-manager';
import { SceneManager } from '../engine/scene-manager';
import { initApp } from '../engine/app-init';
import { DEFAULT_STUDIO_COLOR } from '../engine/studio';

/** Either renderer satisfies the methods DebugViewer calls. */
type AnySceneManager = ThreeSceneManager | SceneManager;
import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { useUIStore } from '../store/ui-store';
import { useProjectStore } from '../store/project-store';
import { LoadingScreen } from './LoadingScreen';
import { AiScreenOverlay, AiGeneratingOverlay } from './LeftPanel';
import { ViewerOverlay } from './ViewerOverlay';
import { ApiKeySettings } from './ApiKeySettings';
import { AmbientAudio } from './AmbientAudio';
import { FootstepAudio } from './FootstepAudio';
import { BGM_PRESETS } from '../core/audio-presets';
import { FloorPlanMiniMap } from './FloorPlanMiniMap';
import { VRThumbPreview } from './VRThumbPreview';
import { ScenePinsOverlay } from './ScenePinsOverlay';
import { useDemoModeCamera } from './useDemoModeCamera';
import { targetFromYaw } from '../core/viewpoint';
import { DEFAULT_SIDEBAR_ORDER, type OrderableSidebarBlock } from '../core/types';
import { getPinPlacements } from '../core/pin-placements';
import { tokens } from './design-tokens';
import {
  surfaceClass, Chip, Tag, PillToggle, SegmentedControl,
  IconClose, IconTrash, IconCheck, IconEdit, IconPin, IconTarget, IconCamera, IconPhoto,
} from './components';
import * as idb from '../utils/idb';
import { unzipSync } from 'fflate';

function rgbToHex([r, g, b]: [number, number, number]): string {
  const toHex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export function DebugViewer({ sceneId }: { sceneId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const smRef = useRef<AnySceneManager | null>(null);
  const [ready, setReady] = useState(false);
  const { isLoading, error, manifest } = useSceneStore();
  const position = useCameraStore(s => s.position);
  const pitch = useCameraStore(s => s.pitch);
  const yaw = useCameraStore(s => s.yaw);
  const fov = useCameraStore(s => s.fov);
  const activeVp = useCameraStore(s => s.activeViewpoint);
  const addViewpoint = useSceneStore(s => s.addViewpoint);
  const removeViewpoint = useSceneStore(s => s.removeViewpoint);
  const updateViewpointLabel = useSceneStore(s => s.updateViewpointLabel);
  const setFloorPlanImage = useSceneStore(s => s.setFloorPlanImage);
  const updateInfo = useSceneStore(s => s.updateInfo);
  const setSceneName = useSceneStore(s => s.setSceneName);
  const updateSettings = useSceneStore(s => s.updateSettings);
  const projectsList = useProjectStore((s) => s.projects);

  /** Top-level tab in the left panel. 'global' shows mansion/camera/etc; 'plan' shows the active plan;
   *  'video' is the scene1→scene2 MP4 recorder. Pins live inside the Plan tab next to viewpoints. */
  const [debugTab, setDebugTab] = useState<'global' | 'plan' | 'video'>('global');
  const [showAddVp, setShowAddVp] = useState(false);
  const [newVpName, setNewVpName] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [copied, setCopied] = useState(false);
  const [exportedVp, setExportedVp] = useState(false);
  const [infoJsonCopied, setInfoJsonCopied] = useState(false);
  const [moveSpeed, setMoveSpeedLocal] = useState<number>(3);
  const [fovLocal, setFovLocal] = useState<number>(60);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [colLoading, setColLoading] = useState<string | null>(null);
  const [walkEditorOpen, setWalkEditorOpen] = useState(false);
  const [topDownColOpen, setTopDownColOpen] = useState(false);
  const walkableRef = useRef<HTMLInputElement>(null);
  const blockRef = useRef<HTMLInputElement>(null);
  const [hdriLoading, setHdriLoading] = useState(false);
  const [hdriName, setHdriName] = useState<string | null>(null);
  const hdriInputRef = useRef<HTMLInputElement>(null);
  const [studioBgColor, setStudioBgColor] = useState(rgbToHex(DEFAULT_STUDIO_COLOR));
  const [panoLoading, setPanoLoading] = useState<string | null>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);
  const [panoTargetVp, setPanoTargetVp] = useState<string | null>(null);

  // ── 動画タブ state ──
  const [videoMode, setVideoMode] = useState<'path' | 'free'>('path');
  const [videoKeyframes, setVideoKeyframes] = useState<CameraKeyframe[]>([]);
  const [videoFps, setVideoFps] = useState<30 | 60>(60);
  const [videoRecState, setVideoRecState] = useState<'idle' | 'previewing' | 'recording'>('idle');
  const [videoProgress, setVideoProgress] = useState<number>(0);
  const [videoError, setVideoError] = useState<string | null>(null);
  /** Free-rec: 'starting' = 2s countdown before record, 'recording' = active,
   *  'stopping' = 2s buffer after stop click. Countdown number is rendered as a
   *  big overlay on the canvas. */
  const [freeRecState, setFreeRecState] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const [freeRecCountdown, setFreeRecCountdown] = useState<number>(0);
  const [freeRecElapsedMs, setFreeRecElapsedMs] = useState<number>(0);
  // Clip library — list of saved recordings for the current sceneId. Loaded on
  // mount + after each save / delete.
  const [videoLibrary, setVideoLibrary] = useState<ClipMeta[]>([]);
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set());
  const [concatRunning, setConcatRunning] = useState<boolean>(false);
  const [concatProgress, setConcatProgress] = useState<{ clipIndex: number; t01: number; total: number } | null>(null);
  // Trim range (0..1 of the path) — only this slice is rendered when previewing /
  // recording. Reset to (0, 1) whenever the keyframe count changes since absolute
  // positions stop meaning the same place.
  const [videoTrimStart, setVideoTrimStart] = useState<number>(0);
  const [videoTrimEnd, setVideoTrimEnd] = useState<number>(1);
  useEffect(() => {
    setVideoTrimStart(0);
    setVideoTrimEnd(1);
  }, [videoKeyframes.length]);
  const viewMode = useUIStore(s => s.viewMode);
  const movementMode = useUIStore(s => s.movementMode);
  // 「その他」(展示 / 屋外 / 任意の空間) では住居系 (基本情報 = 間取り / 専有面積 / 階数 / 所在地) は出さない
  const projectType = useUIStore(s => s.projectType);
  const isOtherProject = projectType === 'other';
  const setPlanPanoramaStore = useSceneStore(s => s.setPlanPanorama);
  const activePlanId = useSceneStore(s => s.activePlanId);
  const addPlanStore = useSceneStore(s => s.addPlan);
  const removePlanStore = useSceneStore(s => s.removePlan);
  const updatePlanLabelStore = useSceneStore(s => s.updatePlanLabel);
  const setPlanSplatStore = useSceneStore(s => s.setPlanSplat);
  const setPlanSplatSogStore = useSceneStore(s => s.setPlanSplatSog);
  const setPlanCollisionStore = useSceneStore(s => s.setPlanCollision);
  const setPlanCollisionSourceStore = useSceneStore(s => s.setPlanCollisionSource);
  const setPlanCollisionWallsStore = useSceneStore(s => s.setPlanCollisionWalls);
  const setPlanCollisionTransformStore = useSceneStore(s => s.setPlanCollisionTransform);
  const setPlanWalkStore = useSceneStore(s => s.setPlanWalk);
  const setPlanSplatSourceNameStore = useSceneStore(s => s.setPlanSplatSourceName);
  const [showAddPlan, setShowAddPlan] = useState(false);
  const [newPlanName, setNewPlanName] = useState('');
  const [editPlanId, setEditPlanId] = useState<string | null>(null);
  const [editPlanLabel, setEditPlanLabel] = useState('');
  const [planSplatTargetId, setPlanSplatTargetId] = useState<string | null>(null);
  const [planSplatBusy, setPlanSplatBusy] = useState<string | null>(null);
  const planSplatInputRef = useRef<HTMLInputElement>(null);
  // Drag-over highlight state for the plan / viewpoint rows. Tracked separately
  // so a row only lights up while the cursor is over IT, not its sibling rows.
  const [planDragOverId, setPlanDragOverId] = useState<string | null>(null);
  const [vpDragOverId, setVpDragOverId] = useState<string | null>(null);
  // Drag-reorder state for the viewpoint list. Separate from `vpDragOverId`
  // (file drop) so the two highlights / drop effects never collide.
  const [vpDragSrcId, setVpDragSrcId] = useState<string | null>(null);
  const [vpReorderOverId, setVpReorderOverId] = useState<string | null>(null);
  const vpRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const reorderViewpoints = useSceneStore(s => s.reorderViewpoints);
  const setStartViewpoint = useSceneStore(s => s.setStartViewpoint);
  const setViewpointPose = useSceneStore(s => s.setViewpointPose);
  // 「位置を変更」モード — { pinId, placementId } がセットされている間、preview を
  // クリックするとその placement の position が新しい床面交点に書き換えられる。
  // 新規タグ作成は「+ タグを追加」(未配置で list へ) → ドラッグで preview に配置。
  const [pinMoveTargetId, setPinMoveTargetId] = useState<{ pinId: string; placementId: string } | null>(null);
  const thumbs = useSceneStore(s => s.viewpointThumbnails);
  // For VR-mode "+ VR視点を追加" form: an optional panorama file picked alongside the name.
  const [addVpPanoFile, setAddVpPanoFile] = useState<File | null>(null);
  const [addVpPanoName, setAddVpPanoName] = useState<string | null>(null);
  const addVpPanoInputRef = useRef<HTMLInputElement>(null);
  const isVRMode = viewMode === '360';
  // True when at least one plan has actual 3DGS data (PLY or SOG). Drives the
  // visibility of splat-only UI (移動速度 / 初期高さ / 足音 / コリジョン) so a
  // project that only holds panoramas — even if its viewMode happens to be
  // 'splat' — won't surface walking-related controls. "歩けないので" everything
  // tied to walking gets hidden when there's nothing to walk through.
  const hasSplatData = manifest?.plans?.some((p) => !!p.splat || !!p.splatSog) ?? false;
  // Persistence state: last successful IDB save time + dirty/saving flag.
  type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  /** Collapsed by default — the user said FOV bounds are rarely tweaked, defaults (25°–100°) are fine. */
  const [showZoomRange, setShowZoomRange] = useState(false);

  // Restore viewMode / projectType from the project store on direct URL entry — otherwise
  // a hard-reload of a VR scene would land in splat mode (the UI store default) and show
  // splat-only UI (collision, splat upload, etc) on a 360 project.
  useEffect(() => {
    const project = useProjectStore.getState().getProject(sceneId);
    if (project) {
      useUIStore.getState().setViewMode(project.viewMode);
      useUIStore.getState().setProjectType(project.type);
    }
  }, [sceneId]);

  // 描画エンジンは **マウント時点** で決定 (= リロードで反映)。実行中のホットスワップは
  // race が大きく不安定なので避ける。エンジン選択を変更した場合は「リロード」ボタンで再起動。
  useEffect(() => {
    const canvas = canvasRef.current;
    const preview = previewWrapRef.current;
    if (!canvas || !preview) return;
    let destroyed = false;

    (async () => {
      try {
        // initApp の前にマニフェストを先読み (engine 判定 + MSAA 設定取り出し)。
        const manifest = await loadSceneManifest(sceneId);
        if (destroyed) return;
        useSceneStore.getState().setManifest(manifest);
        const renderCfg = manifest.settings.render;
        console.info('[init] manifest loaded. settings.render =', renderCfg);
        // PlayCanvas with the SuperSplat-quality migration is now the default. Three
        // engines remain selectable via `manifest.settings.render.engine`.
        const engineToUse: ViewerEngine = renderCfg?.engine ?? 'playcanvas';
        console.info(`[init] engineToUse = ${engineToUse} (engine=${renderCfg?.engine ?? '(none)'})`);
        if (engineToUse === 'playcanvas') {
          canvas.style.display = 'block';
          const ctx = await initApp(canvas, { msaaSamples: renderCfg?.msaaSamples ?? 4, render: renderCfg });
          if (destroyed) { ctx.app.destroy(); return; }
          const sm = new SceneManager(ctx.app, ctx.camera, ctx.cameraFrame);
          smRef.current = sm;
          setReady(true);
          await sm.loadScene(sceneId);
        } else {
          canvas.style.display = 'none';
          const manager = new ThreeSceneManager(preview, engineToUse, { debug: true });
          if (destroyed) { manager.destroy(); return; }
          smRef.current = manager;
          setReady(true);
          await manager.loadScene(sceneId);
        }
      } catch (e) { console.error(e); }
    })();

    return () => {
      destroyed = true;
      try { smRef.current?.destroy(); } catch { /* ignore */ }
      smRef.current = null;
      // Use the nodes captured when the effect ran — the refs may already point
      // elsewhere (or be null) by cleanup time.
      canvas.style.display = 'block';
      Array.from(preview.querySelectorAll('canvas')).forEach((node) => {
        if (node !== canvas) node.remove();
      });
      setReady(false);
    };
  }, [sceneId]);

  // Auto-persist the manifest to IndexedDB whenever it changes (debounced).
  // First effect run (from a HMR or fresh mount) writes the current state immediately so
  // any pre-existing in-memory edits get captured.
  useEffect(() => {
    if (!manifest) return;
    setSaveState((prev) => (prev === 'saved' ? 'dirty' : prev));
    const t = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        await idb.saveManifest(manifest.id, manifest);
        setLastSavedAt(Date.now());
        setSaveState('saved');
      } catch (e) {
        console.error('[idb] manifest save failed:', e);
        setSaveState('error');
      }
    }, 400);
    return () => clearTimeout(t);
  }, [manifest]);

  const saveNow = async () => {
    const m = useSceneStore.getState().manifest;
    if (!m) return;
    setSaveState('saving');
    try {
      await idb.saveManifest(m.id, m);
      setLastSavedAt(Date.now());
      setSaveState('saved');
    } catch (e) {
      console.error('[idb] manual save failed:', e);
      setSaveState('error');
    }
  };

  const handleVpClick = (id: string) => {
    const state = useSceneStore.getState();
    const plan = state.manifest?.plans?.find((p) => p.id === state.activePlanId);
    const vp = plan?.viewpoints.find((v) => v.id === id);
    if (vp) smRef.current?.jumpToViewpoint(vp);
  };

  const getCameraTarget = (): [number, number, number] => [
    +(position[0] - Math.sin(yaw * Math.PI / 180)).toFixed(3),
    +(position[1] + Math.tan(pitch * Math.PI / 180)).toFixed(3),
    +(position[2] - Math.cos(yaw * Math.PI / 180)).toFixed(3),
  ];

  const copyCamera = () => {
    navigator.clipboard.writeText(JSON.stringify({ position: position.map(v => +v.toFixed(3)), target: getCameraTarget(), fov: +fov.toFixed(1) }, null, 2));
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const addVp = () => {
    if (!newVpName.trim()) return;
    const id = 'vp_' + Date.now();
    // Read pose directly from the controller — camera-store sync is throttled to ~6 frames,
    // so reading it here can lag behind the actual view (visible mismatch between the saved
    // direction and the user's framing on slow scenes). Falls back to camera-store values
    // if the manager isn't ready yet (extreme edge case).
    const live = smRef.current?.getLiveCameraPose();
    const livePos: [number, number, number] = live?.position ?? position;
    const liveYaw = live?.yaw ?? yaw;
    const livePitch = live?.pitch ?? pitch;
    const liveFov = live?.fov ?? fov;
    const pos: [number, number, number] = [+livePos[0].toFixed(3), +livePos[1].toFixed(3), +livePos[2].toFixed(3)];
    // VR (360°): always save facing yaw=0 / pitch=0 so the panorama starts at its canonical
    // "front" — with hdri-loader.ts's 180° skybox rotation this samples the panorama's
    // center, and the floor-plan cone (mapYaw default 0) points up on the map.
    // 3DGS (splat): save the live look direction so jumping back to the viewpoint truly
    // restores the framing the user composed.
    const target: [number, number, number] = isVRMode
      ? targetFromYaw(pos, 0, pos[1])
      : [
          +(pos[0] - Math.sin(liveYaw * Math.PI / 180)).toFixed(3),
          +(pos[1] + Math.tan(livePitch * Math.PI / 180)).toFixed(3),
          +(pos[2] - Math.cos(liveYaw * Math.PI / 180)).toFixed(3),
        ];
    const savedVp = { id, label: newVpName.trim(), position: pos, target, fov: +liveFov.toFixed(1) };
    addViewpoint(savedVp);
    // In VR mode, attach the panorama picked alongside the name.
    if (isVRMode && addVpPanoFile && activePlanId) {
      const file = addVpPanoFile;
      const reader = new FileReader();
      reader.onload = async (e) => {
        const d = e.target?.result as string;
        if (!d) return;
        const sm = smRef.current;
        if (sm) await sm.setViewpointPanorama(id, d);
        else setPlanPanoramaStore(activePlanId, id, d);
      };
      reader.readAsDataURL(file);
    }
    setNewVpName('');
    setShowAddVp(false);
    setAddVpPanoFile(null);
    setAddVpPanoName(null);
    // Jump the live camera to the new pose so live yaw matches the saved 0° immediately —
    // without this the active cone (which follows live yaw) keeps showing whatever angle
    // the camera was drifting at, instead of pointing up like the saved direction.
    useCameraStore.getState().setActiveViewpoint(id);
    smRef.current?.jumpToViewpoint(savedVp);
  };
  const cancelAddVp = () => {
    setShowAddVp(false);
    setNewVpName('');
    setAddVpPanoFile(null);
    setAddVpPanoName(null);
  };

  const renameVp = (id: string) => { if (editLabel.trim()) updateViewpointLabel(id, editLabel.trim()); setEditId(null); };

  const exportVps = () => {
    if (!manifest) return;
    const activePlan = manifest.plans?.find((p) => p.id === activePlanId);
    navigator.clipboard.writeText(JSON.stringify(activePlan?.viewpoints ?? [], null, 2));
    setExportedVp(true); setTimeout(() => setExportedVp(false), 2000);
  };

  const exportInfoJson = () => {
    if (!manifest) return;
    const activePlan = manifest.plans?.find((p) => p.id === activePlanId);
    const payload = { name: manifest.name, plan: activePlan?.label, info: activePlan?.info ?? {} };
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setInfoJsonCopied(true); setTimeout(() => setInfoJsonCopied(false), 2000);
  };

  const handleFloorPlanFile = (file: File) => {
    // Some browsers/OS combinations leave file.type empty for valid images, so fall back
    // to extension matching. Accept the common raster + vector image formats.
    const looksLikeImage =
      file.type.startsWith('image/') ||
      /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i.test(file.name);
    if (!looksLikeImage) {
      console.warn('floor plan: rejected file (not an image):', file.name, file.type);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const d = e.target?.result as string;
      if (d) setFloorPlanImage(d);
    };
    reader.onerror = () => console.error('floor plan: read failed', reader.error);
    reader.readAsDataURL(file);
  };
  const clearFloorPlan = () => {
    setFloorPlanImage('');
  };

  /**
   * 既存データの一括移行ユーティリティ。MAP クリック / dot ドラッグで `position` 同期する
   * ロジックが入る前に作られた視点は `mapPosition` だけ書き換わり `position` が古いまま残る
   * (= ジャンプ先が全部同じ場所になる) ことがある。この関数を 1 度叩くと、active plan の
   * 全視点について `mapPosition` 値を `position.x / .z` に焼き込み、`target` も同じ delta だけ
   * 平行移動して向きを保つ。`mapPosition` が未設定 / 既に position と一致するものはスキップ。
   * isVRMode のチェックはしない — ユーザーが明示的に「焼き込み」と意思表示したケースなので
   * VR/GS どちらの project type でも実行する。
   */
  const syncMapPositionsToCameraAnchors = () => {
    if (!activePlanId) return;
    let updated = 0;
    useSceneStore.setState((s) => {
      if (!s.manifest?.plans) return s;
      return {
        manifest: {
          ...s.manifest,
          plans: s.manifest.plans.map((p) => {
            if (p.id !== activePlanId) return p;
            return {
              ...p,
              viewpoints: p.viewpoints.map((v) => {
                if (!v.mapPosition) return v;
                const [mx, mz] = v.mapPosition;
                if (Math.abs(mx - v.position[0]) < 1e-3 && Math.abs(mz - v.position[2]) < 1e-3) return v;
                const dx = mx - v.position[0];
                const dz = mz - v.position[2];
                updated++;
                return {
                  ...v,
                  position: [+mx.toFixed(3), v.position[1], +mz.toFixed(3)] as [number, number, number],
                  target: [+(v.target[0] + dx).toFixed(3), v.target[1], +(v.target[2] + dz).toFixed(3)] as [number, number, number],
                };
              }),
            };
          }),
        },
      };
    });
    if (updated > 0 && activeVp) {
      const av = useSceneStore.getState().manifest?.plans?.find(p => p.id === activePlanId)?.viewpoints.find(v => v.id === activeVp);
      if (av) smRef.current?.jumpToViewpoint(av);
    }
    alert(`${updated} 件の視点を MAP 位置に同期しました`);
  };

  const showCollision = useUIStore(s => s.showCollision);
  const toggleCollision = useUIStore(s => s.toggleCollision);
  const useCollisionWalkable = useUIStore(s => s.useCollisionWalkable);
  const toggleUseCollisionWalkable = useUIStore(s => s.toggleUseCollisionWalkable);
  const useCollisionBlock = useUIStore(s => s.useCollisionBlock);
  const toggleUseCollisionBlock = useUIStore(s => s.toggleUseCollisionBlock);
  const collisionOpacity = useUIStore(s => s.collisionOpacity);
  const setCollisionOpacity = useUIStore(s => s.setCollisionOpacity);
  const showGrid = useUIStore(s => s.showGrid);
  const toggleGrid = useUIStore(s => s.toggleGrid);

  useEffect(() => { smRef.current?.setCollisionVisible(showCollision); }, [showCollision]);
  useEffect(() => { if (ready) smRef.current?.setCollisionWalkableEnabled(useCollisionWalkable); }, [ready, useCollisionWalkable]);
  useEffect(() => { if (ready) smRef.current?.setCollisionBlockEnabled(useCollisionBlock); }, [ready, useCollisionBlock]);
  useEffect(() => { smRef.current?.setCollisionOpacity(collisionOpacity); }, [collisionOpacity]);
  useEffect(() => { if (ready) smRef.current?.setGridVisible(showGrid); }, [ready, showGrid]);

  // 動画タブ: プラン・シーン切替でキーフレームをクリア（位置情報がプラン跨ぎで意味を失う）。
  useEffect(() => {
    setVideoKeyframes([]);
    setVideoRecState('idle');
    setVideoProgress(0);
    setVideoError(null);
    setFreeRecState('idle');
    setFreeRecCountdown(0);
    setFreeRecElapsedMs(0);
    smRef.current?.stopCameraAnimation?.();
  }, [activePlanId, sceneId]);

  // 動画ライブラリ: シーン切替時に再読込。プラン違いは同じシーン (= 同じ project) なので一覧
  // にまとめて出す（プラン跨ぎで使い回せたほうが便利）。
  useEffect(() => {
    setVideoLibrary(clipLib.listClips(sceneId));
    setSelectedClipIds(new Set());
  }, [sceneId]);

  // Seed the move-speed slider from the manifest. Depends on the seed VALUE (not the
  // whole `manifest` reference) so unrelated settings patches like initialHeight
  // don't blow away in-flight slider edits.
  const moveSpeedSeed = manifest?.settings.moveSpeed;
  useEffect(() => {
    if (!ready || moveSpeedSeed === undefined) return;
    setMoveSpeedLocal(moveSpeedSeed);
  }, [ready, moveSpeedSeed]);
  // Seed the FOV slider ONLY on viewer-ready / plan switch — NOT on seed-value
  // changes. Re-seeding on value change meant a 📷 save to the seed viewpoint
  // (which rewrites its fov) yanked the slider back mid-edit (A14). The latest
  // seed is read from the store inside the effect, and comes from the START
  // viewpoint — the one the camera actually lands on — not viewpoints[0].
  useEffect(() => {
    if (!ready) return;
    const m = useSceneStore.getState().manifest;
    const plan = m?.plans?.find((p) => p.id === activePlanId);
    setFovLocal(plan?.fixedPosition?.fov ?? resolveStartViewpoint(plan)?.fov ?? 60);
  }, [ready, activePlanId]);

  const onMoveSpeedChange = (v: number) => { setMoveSpeedLocal(v); smRef.current?.setMoveSpeed(v); };
  const onFovChange = (v: number) => { setFovLocal(v); smRef.current?.setFov(v); };

  // ホイールで moveSpeed を上下できる (Arrival Space スタイル)。controller がここに通知
  // してくるので、スライダーの表示と manifest 設定を同期。
  useEffect(() => {
    if (!ready) return;
    const cb = (v: number) => {
      setMoveSpeedLocal(+v.toFixed(2));
      useSceneStore.getState().updateSettings({ moveSpeed: +v.toFixed(2) });
    };
    smRef.current?.setOnMoveSpeedChange(cb);
    return () => { smRef.current?.setOnMoveSpeedChange(null); };
  }, [ready]);

  /**
   * MAP クリックで視点を配置する。
   * - VR (360°): `position` はパノラマ撮影位置として不変、`mapPosition` (= MAP 上の dot) だけ動かす。
   * - GS (splat): `position.x / .z` を (worldX, worldZ) で上書き + `target` を同じ delta だけ
   *   平行移動して「向きを保ったまま位置だけ移動」する。`mapPosition` も同期するので MAP の
   *   dot と実ジャンプ先が一致する。アクティブ視点ならクリック直後にカメラを新位置へ jump。
   */
  const placeViewpointAt = (vpId: string, worldX: number, worldZ: number) => {
    if (!activePlanId) return;
    const x = +worldX.toFixed(3);
    const z = +worldZ.toFixed(3);
    // MAP-ONLY: dragging / clicking the floor-plan moves the DOT (mapPosition) only.
    // The real 3D camera, target, thumbnail-capture point, and start position are NOT
    // touched — relocating the camera is the explicit "ドット位置をカメラに反映" action
    // (bakeViewpointToCamera). This holds for both GS and VR (no viewMode fork), matching
    // the documented decoupling in types.ts and stopping the "move dot → break camera/thumbnail" chain.
    useSceneStore.setState((s) => {
      if (!s.manifest?.plans) return s;
      return {
        manifest: {
          ...s.manifest,
          plans: s.manifest.plans.map((p) => {
            if (p.id !== activePlanId) return p;
            return {
              ...p,
              viewpoints: p.viewpoints.map((v) =>
                v.id === vpId ? { ...v, mapPosition: [x, z] as [number, number] } : v
              ),
            };
          }),
        },
      };
    });
  };

  /** Explicit "reflect dot → camera": commit ONE viewpoint's floor-plan dot (mapPosition)
   *  onto its real 3D camera (position + target shifted by the same delta), and jump there
   *  if it's the active viewpoint. Pairs with the map-only dot dragging above. */
  const bakeViewpointToCamera = (vpId: string) => {
    if (!activePlanId) return;
    let baked: { id: string; label: string; position: [number, number, number]; target: [number, number, number]; fov: number } | null = null;
    useSceneStore.setState((s) => {
      if (!s.manifest?.plans) return s;
      return {
        manifest: {
          ...s.manifest,
          plans: s.manifest.plans.map((p) => {
            if (p.id !== activePlanId) return p;
            return {
              ...p,
              viewpoints: p.viewpoints.map((v) => {
                if (v.id !== vpId || !v.mapPosition) return v;
                const [mx, mz] = v.mapPosition;
                const dx = mx - v.position[0];
                const dz = mz - v.position[2];
                const position: [number, number, number] = [+mx.toFixed(3), v.position[1], +mz.toFixed(3)];
                const target: [number, number, number] = [
                  +(v.target[0] + dx).toFixed(3), v.target[1], +(v.target[2] + dz).toFixed(3),
                ];
                baked = { id: v.id, label: v.label, position, target, fov: v.fov };
                return { ...v, position, target };
              }),
            };
          }),
        },
      };
    });
    if (baked && activeVp === vpId) smRef.current?.jumpToViewpoint(baked);
  };

  /** Yaw (0–360°) of the cone for this viewpoint — purely from `mapYaw` (the slider).
   *  Independent of `target` so saving the VR preview thumbnail / initial direction does
   *  NOT shift this number. Defaults to 0° when the user hasn't touched the slider. */
  const getViewpointYaw = (vp: { mapYaw?: number }): number => {
    if (typeof vp.mapYaw === 'number') return ((vp.mapYaw % 360) + 360) % 360;
    return 0;
  };

  /**
   * 図面設定 方向キー / yaw スライダー: writes ONLY `mapYaw` (display-only field).
   * Does NOT touch `target` — that's what `jumpToViewpoint` uses to set the view in
   * the production viewer ("本番"). Rotating the cone here is purely cosmetic; the
   * actual view stays anchored to the saved `target`. Does NOT touch the live camera
   * either (rule 3).
   */
  const setViewpointYaw = (vpId: string, yawDeg: number) => {
    if (!activePlanId) return;
    const normalized = ((yawDeg % 360) + 360) % 360;
    useSceneStore.setState((s) => {
      if (!s.manifest?.plans) return s;
      return {
        manifest: {
          ...s.manifest,
          plans: s.manifest.plans.map((p) => p.id === activePlanId ? {
            ...p,
            viewpoints: p.viewpoints.map((v) => v.id === vpId ? { ...v, mapYaw: normalized } : v),
          } : p),
        },
      };
    });
  };



  // Collision GLB install (upload / auto-gen / wall-editor output). Saves the
  // blob into the per-source IDB slot, points the plan's collision config at it
  // (switching the plan's active source to match so the result is immediately
  // visible), and hot-loads it into the engine.
  const handleColFile = async (file: File | Blob, type: 'walkable' | 'block', source: 'manual' | 'auto' = 'manual') => {
    const sm = smRef.current; if (!sm) return;
    const sceneId = manifest?.id;
    const planId = activePlanId;
    if (!sceneId || !planId) return;
    setColLoading(type);
    try {
      const blobKey = `collision:${sceneId}:${planId}:${source}:${type}`;
      const blob = file instanceof File ? file : new Blob([await file.arrayBuffer()], { type: 'model/gltf-binary' });
      await idb.saveBlob(blobKey, blob);
      const ref = `${idb.IDB_REF_PREFIX}${blobKey}`;
      setPlanCollisionSourceStore(planId, source);
      setPlanCollisionStore(planId, source, type, ref);
      await sm.loadCollisionFromManifestRef(ref, type);
      sm.setCollisionVisible(true);
      if (!showCollision) toggleCollision();
    } catch (e) {
      console.error(`collision ${type} upload failed:`, e);
      alert('コリジョン読込失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setColLoading(null);
    }
  };

  /** Bake the 俯瞰 wall editor's drawing into manual collision GLBs:
   *  segments → block (walls), floor outline → walkable (floor).
   *  適用後の手動セットは常に「描画どおり」— a channel with NO drawn geometry
   *  is CLEARED, so erasing every wall and re-applying really removes the
   *  baked walls (previously the stale GLB survived and looked un-erasable). */
  const handleGenerateWalls = async (walls: CollisionWallData) => {
    const planId = activePlanId; if (!planId) return;
    setColLoading('walls');
    try {
      setPlanCollisionWallsStore(planId, walls); // persist authoring data first
      const blockGlb = buildWallBlockGlb(walls);
      const floorGlb = buildFloorWalkableGlb(walls);
      // NOTE: 順序は「ロード→クリア」でなく必ず逐次 — clearCollision は
      // collisionGen を進めるので、並行中のロードがあると破棄されてしまう。
      if (floorGlb) {
        await handleColFile(floorGlb, 'walkable', 'manual');
      } else {
        setPlanCollisionStore(planId, 'manual', 'walkable', undefined);
        smRef.current?.clearCollision?.('walkable');
      }
      if (blockGlb) {
        await handleColFile(blockGlb, 'block', 'manual');
      } else {
        setPlanCollisionStore(planId, 'manual', 'block', undefined);
        smRef.current?.clearCollision?.('block');
      }
    } catch (e) {
      console.error('wall collision generation failed:', e);
      alert('壁コリジョン生成に失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setColLoading(null);
    }
  };

  const handleHdriFile = async (file: File) => {
    const sm = smRef.current; if (!sm) return;
    setHdriLoading(true);
    try {
      const result = await sm.loadHdri(file);
      if (result === true) setHdriName(file.name);
      else alert(`HDRI の読み込みに失敗しました: ${file.name}\n${result}`);
    } finally {
      setHdriLoading(false);
    }
  };

  const handleHdriRemove = () => { smRef.current?.removeHdri(); setHdriName(null); };

  // Apply the background color to the camera whenever it changes. HDRI, when
  // loaded, draws on top via the SKYBOX layer; removing HDRI re-exposes this
  // color.
  useEffect(() => {
    if (!ready) return;
    smRef.current?.setStudioColor?.(hexToRgb(studioBgColor));
  }, [ready, studioBgColor]);

  // Apply view mode to the engine when it changes
  useEffect(() => {
    if (!ready) return;
    smRef.current?.setViewMode(viewMode);
  }, [ready, viewMode]);

  // Apply perspective (1st / 3rd person) when it changes
  useEffect(() => {
    if (!ready) return;
    smRef.current?.setMovementMode(movementMode);
  }, [ready, movementMode]);

  // Demo mode (Xrealtracking): start WebSocket + push head-tracking offsets to camera.
  useDemoModeCamera(ready ? smRef.current : null);

  // Live-apply render-quality settings whenever they change (toolbar / preset clicks).
  useEffect(() => {
    if (!ready) return;
    smRef.current?.applyRenderConfig(manifest?.settings.render);
  }, [ready, manifest?.settings.render]);

  // Expose the live scene manager on window so the AI sidebar block can call
  // `captureCurrent360Snapshot()` without going through a React ref chain.
  useEffect(() => {
    (window as unknown as { __sceneManager?: AnySceneManager | null }).__sceneManager = smRef.current;
  }, [ready]);

  // Esc cancels pin move mode.
  useEffect(() => {
    if (!pinMoveTargetId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinMoveTargetId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinMoveTargetId]);

  // Re-apply panorama when the active color variant changes (360° mode only).
  const activeColor = useUIStore(s => s.activeColor);
  useEffect(() => {
    if (!ready) return;
    void smRef.current?.applyActiveColor();
  }, [ready, activeColor]);
  // Live quality preset (LOW / MID / HIGH). Without this hook the Debug preview
  // ignored the toolbar's quality switch entirely, so HIGH and LOW looked the same.
  const qualityMode = useUIStore((s) => s.qualityMode);
  useEffect(() => {
    if (!ready) return;
    const sm = smRef.current;
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
  // AI variant: only kind='screen' is supported now — `AiScreenOverlay` handles
  // the 2D overlay. No engine-side reaction needed.

  const captureCurrentAsThumb = (id: string) => {
    const sm = smRef.current;
    if (!sm || !activePlanId) return;
    // GS/splat: 📷 ALSO commits the live camera pose to the viewpoint, so the saved
    // thumbnail and the jump/start position are the same place ("サムネで決めた位置で
    // スタート"). VR/360: the thumbnail is regenerated from the panorama; the position
    // stays the panorama capture spot (don't move it from a non-existent walk position).
    if (!isVRMode) {
      const live = sm.getLiveCameraPose?.();
      if (live) {
        const pos: [number, number, number] = [+live.position[0].toFixed(3), +live.position[1].toFixed(3), +live.position[2].toFixed(3)];
        const target: [number, number, number] = [
          +(pos[0] - Math.sin(live.yaw * Math.PI / 180)).toFixed(3),
          +(pos[1] + Math.tan(live.pitch * Math.PI / 180)).toFixed(3),
          +(pos[2] - Math.cos(live.yaw * Math.PI / 180)).toFixed(3),
        ];
        setViewpointPose(id, pos, target, +live.fov.toFixed(1));
      }
    }
    void sm.captureCurrentFrameAsManualThumbnail(id);
  };

  const addPlan = () => {
    if (!newPlanName.trim()) return;
    const id = 'plan_' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now());
    // New plans start completely empty: no splat, no viewpoints, no floor plan, no info.
    addPlanStore({ id, label: newPlanName.trim(), viewpoints: [] });
    setNewPlanName('');
    setShowAddPlan(false);
  };
  const renamePlan = (id: string) => {
    if (editPlanLabel.trim()) updatePlanLabelStore(id, editPlanLabel.trim());
    setEditPlanId(null);
  };
  const switchPlan = async (id: string) => {
    if (id === activePlanId) return;
    await smRef.current?.setActivePlan(id);
  };
  /**
   * Splat upload — accepts both PLY and SOG in one path.
   *
   * Detection rule:
   *   - If the selection contains `meta.json` AND any `.webp` → treat as SOG
   *     bundle (multi-file). All files saved under `splat:<s>:<p>:sog/<name>` and
   *     `Plan.splatSog` set to the sentinel marker. `Plan.splat` cleared so the
   *     loader doesn't see a stale PLY ref alongside.
   *   - Otherwise the first file is treated as a single PLY / SPLAT and saved
   *     under `Plan.splat` (legacy path). Any prior SOG bundle is wiped.
   *
   * The user picks **one** button regardless of format; the picker is
   * `multiple` + `accept` is broad so SuperSplat-exported folders show up.
   */
  const handlePlanSplatFiles = async (files: FileList | File[], planId: string) => {
    const sceneId = manifest?.id ?? 'unknown';
    const list = Array.from(files);
    if (list.length === 0) return;

    const hasMeta = list.some((f) => f.name.toLowerCase() === 'meta.json');
    const hasWebp = list.some((f) => f.name.toLowerCase().endsWith('.webp'));
    const isLegacySog = hasMeta && hasWebp;
    // Single-file SOG bundle (SuperSplat's newer export — zip wrapping meta.json + webps).
    // PlayCanvas v2's SogBundleParser handles the zip extraction internally.
    const isSogBundle = list.length === 1 && list[0].name.toLowerCase().endsWith('.sog');
    const isSog = isLegacySog || isSogBundle;

    setPlanSplatBusy(planId);
    try {
      const sogPrefix = `splat:${sceneId}:${planId}:sog/`;
      // Always wipe whichever bundle is leaving so we don't leak stale blobs.
      const oldSogKeys = await idb.listBlobKeys(sogPrefix);
      await Promise.all(oldSogKeys.map((k) => idb.deleteBlob(k)));

      if (isSog) {
        if (isSogBundle) {
          // Single-file `.sog` is a zip of `meta.json` + textures. Unzip client-side
          // so we can store individual blobs and reuse the meta.json + webp loader path
          // (PlayCanvas v2's SogBundleParser has issues with synthesised per-texture URLs).
          const buf = await list[0].arrayBuffer();
          const entries = unzipSync(new Uint8Array(buf));
          for (const [entryName, data] of Object.entries(entries)) {
            // `data` is a Uint8Array view; copy via slice to a fresh ArrayBuffer for Blob.
            await idb.saveBlob(`${sogPrefix}${entryName}`, new Blob([data.slice()]));
          }
          setPlanSplatSourceNameStore(planId, list[0].name);
        } else {
          for (const f of list) {
            await idb.saveBlob(`${sogPrefix}${f.name}`, f);
          }
          // Multi-file legacy SOG: name comes from the meta.json's parent
          // folder if available; otherwise fall back to "<count> files".
          setPlanSplatSourceNameStore(planId, `${list.length} files (legacy SOG)`);
        }
        setPlanSplatSogStore(planId, `sog-idb:${sceneId}:${planId}`);
        // Clear PLY ref so the loader doesn't accidentally fall back to it.
        setPlanSplatStore(planId, undefined);
      } else {
        const f = list[0];
        const blobKey = `splat:${sceneId}:${planId}:${Date.now()}`;
        await idb.saveBlob(blobKey, f);
        setPlanSplatStore(planId, `${idb.IDB_REF_PREFIX}${blobKey}`);
        setPlanSplatSogStore(planId, undefined);
        setPlanSplatSourceNameStore(planId, f.name);
      }
      if (planId === activePlanId) await smRef.current?.setActivePlan(planId);
    } catch (e) {
      console.error('plan splat upload failed:', e);
      alert('Splat アップロード失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPlanSplatBusy(null);
    }
  };

  /** Wipe both PLY and SOG references for a plan (and the SOG IDB blobs). */
  const handlePlanSplatClear = async (planId: string) => {
    const sceneId = manifest?.id ?? 'unknown';
    const sogPrefix = `splat:${sceneId}:${planId}:sog/`;
    const sogKeys = await idb.listBlobKeys(sogPrefix);
    await Promise.all(sogKeys.map((k) => idb.deleteBlob(k)));
    setPlanSplatStore(planId, undefined);
    setPlanSplatSogStore(planId, undefined);
    if (planId === activePlanId) await smRef.current?.setActivePlan(planId);
  };

  const handlePanoFile = (file: File, viewpointId: string) => {
    const sm = smRef.current;
    if (!activePlanId) return;
    setPanoLoading(viewpointId);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const d = e.target?.result as string;
      if (d) {
        if (sm) await sm.setViewpointPanorama(viewpointId, d);
        else setPlanPanoramaStore(activePlanId, viewpointId, d);
      }
      setPanoLoading(null);
    };
    reader.readAsDataURL(file);
  };

  /* `handlePanoRemove` lived here for the 「削除」pill on a viewpoint row. The
     pill is gone (a 360 image is replaced, not cleared), and the store action
     `setPlanPanorama(planId, vpId, undefined)` is untouched if it needs to
     come back. */

  // ── Drag-and-drop file upload (plan rows / viewpoint rows) ─────────────
  // Row-level handlers so the user can drop a PLY/SOG onto a plan (3DGS) or
  // a panorama onto a viewpoint (VR) instead of clicking the upload button.
  // dragOver fires continuously while hovering — preventDefault is what
  // makes the browser treat the row as a drop target.
  const isSplatFile = (f: File) => /\.(ply|splat|sog)$/i.test(f.name);
  const isImageFile = (f: File) =>
    f.type.startsWith('image/') || /\.(jpg|jpeg|png|hdr|exr|webp|avif|bmp|tif|tiff)$/i.test(f.name);

  const handlePlanRowDragOver = (e: React.DragEvent, planId: string) => {
    if (isVRMode) return; // VR plans don't take a single drop; viewpoints do.
    if (e.dataTransfer.types.indexOf('Files') < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (planDragOverId !== planId) setPlanDragOverId(planId);
  };
  const handlePlanRowDragLeave = (e: React.DragEvent) => {
    // Ignore leaves that fire because the cursor moved onto a child element.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setPlanDragOverId(null);
  };
  const handlePlanRowDrop = (e: React.DragEvent, planId: string) => {
    if (isVRMode) return;
    e.preventDefault();
    setPlanDragOverId(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    // SOG legacy bundle is multi-file (meta.json + .webp) — pass through;
    // single-file PLY/SPLAT/.sog also work. Reject if nothing splat-like dropped.
    const looksValid = files.some(isSplatFile) || files.some((f) => f.name.toLowerCase() === 'meta.json');
    if (!looksValid) {
      alert('Splat ファイル (PLY / SPLAT / SOG) をドロップしてください。');
      return;
    }
    void handlePlanSplatFiles(files, planId);
  };

  const handleVpRowDragOver = (e: React.DragEvent, vpId: string) => {
    const types = e.dataTransfer.types;
    // Reorder takes precedence: a row dragged via its handle carries a custom
    // type we set in `handleVpHandleDragStart` so file drops stay distinct.
    if (types.indexOf('application/x-vp-reorder') >= 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (vpReorderOverId !== vpId) setVpReorderOverId(vpId);
      return;
    }
    if (!isVRMode) return; // panorama drop is VR-only.
    if (types.indexOf('Files') < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (vpDragOverId !== vpId) setVpDragOverId(vpId);
  };
  const handleVpRowDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setVpDragOverId(null);
    setVpReorderOverId(null);
  };
  const handleVpRowDrop = (e: React.DragEvent, vpId: string) => {
    const sourceId = e.dataTransfer.getData('application/x-vp-reorder');
    if (sourceId) {
      e.preventDefault();
      setVpReorderOverId(null);
      setVpDragSrcId(null);
      if (sourceId !== vpId) reorderViewpoints(sourceId, vpId);
      return;
    }
    if (!isVRMode) return;
    e.preventDefault();
    setVpDragOverId(null);
    const file = Array.from(e.dataTransfer.files ?? []).find(isImageFile);
    if (!file) {
      alert('画像ファイル (JPG / PNG / HDR / EXR 等) をドロップしてください。');
      return;
    }
    handlePanoFile(file, vpId);
  };
  // Drag handle (☰) on each row initiates reorder. We don't make the whole
  // row draggable so the label / buttons stay clickable as before.
  const handleVpHandleDragStart = (e: React.DragEvent, vpId: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-vp-reorder', vpId);
    const row = vpRowRefs.current[vpId];
    if (row) e.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
    setVpDragSrcId(vpId);
  };
  const handleVpHandleDragEnd = () => {
    setVpDragSrcId(null);
    setVpReorderOverId(null);
  };

  /**
   * Set the project's main thumbnail (used in ProjectScreen cards) by copying a viewpoint's
   * thumbnail data URL. `dataUrl === undefined` clears it back to the placeholder.
   */
  const setProjectThumbnail = (dataUrl: string | undefined) => {
    useProjectStore.getState().updateProject(sceneId, { thumbnail: dataUrl });
  };

  /** Toggle a flag on `manifest.variants` to control which optional left-toolbar tools appear. */
  const toggleVariantTool = (key: 'furniture' | 'lighting') => {
    useSceneStore.setState((s) => {
      if (!s.manifest) return s;
      const variants = { ...(s.manifest.variants ?? {}) };
      variants[key] = !variants[key];
      return { manifest: { ...s.manifest, variants } };
    });
  };

  return (
    <div className="ds-screen" style={S.root}>
      {/* Header */}
      <div className="ds-blur ds-authoring__bar" style={S.header}>
        <a
          href="/"
          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate('/'); }}
          className={`${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface`}
          style={S.viewerBtn}
        >← Project</a>
        <div style={S.logo}>
          <Tag variant="warn">DEV</Tag>
          <span className="ds-title">{manifest?.name || sceneId}</span>
        </div>
        <div style={{ flex: 1 }} />
        <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} onClick={saveNow} />
        <PublishButton sceneId={sceneId} manifest={manifest} />
        <a
          href={`/viewer/${sceneId}`}
          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(`/viewer/${sceneId}`); }}
          className={`${surfaceClass('accent')} ds-pill ds-pill--sm`} style={S.viewerBtn}
        >Viewer →</a>
      </div>

      <div className="ds-authoring" style={S.body}>
        {/* LEFT: scrollable settings */}
        <div className="ds-authoring__panel" style={S.left}>
            {/* ===== Tabs: プロジェクト / プラン / 動画 ===== */}
            {/* Three two-line buttons plus an "active" recipe — i.e. the shared
                segmented control, re-implemented. Switching to the real one
                also brings back the sliding indicator, which a hand-rolled
                version always loses. */}
            <PillToggle
              value={debugTab}
              onChange={setDebugTab}
              options={[
                { value: 'global', title: 'プロジェクト', sub: 'PROJECT' },
                { value: 'plan', title: 'プラン', sub: 'PLAN' },
                { value: 'video', title: '動画', sub: 'VIDEO' },
              ]}
              style={S.tabBar}
            />

            {/* ===== プラン切替タブ (プランタブの最上部, アクティブプランを切替えるピル) ===== */}
            {debugTab === 'plan' && manifest?.plans && manifest.plans.length > 0 && (
              <div className={`${surfaceClass('plain')} ds-pill ds-fill-surface`} style={S.planPills} role="tablist" aria-label="プラン切替">
                <span className="ds-label" style={S.planPillsLabel}>PLAN</span>
                {manifest.plans.map((p) => {
                  const isActive = p.id === activePlanId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => switchPlan(p.id)}
                      className={`${surfaceClass(isActive ? 'accent' : 'plain')} ds-pill ds-pill--sm${isActive ? '' : ' ds-fill-surface'}`}
                      title={isActive ? `編集中: ${p.label}` : `${p.label} に切替`}
                    >
                      {p.label}
                    </button>
                  );
                })}
                {manifest.plans.length > 1 && <PlanCameraLinkToggle />}
              </div>
            )}

            {/* ===== 基本情報 (アクティブプラン) — 住居・店舗 (mansion) 専用 ===== */}
            {debugTab === 'plan' && !isOtherProject && (() => {
              const activePlan = manifest?.plans?.find(p => p.id === activePlanId);
              const info = activePlan?.info ?? {};
              const vis = info.visibility ?? {};
              const setVis = (key: 'overall' | 'heading' | 'area' | 'floor' | 'location' | 'notes', val: boolean) => {
                updateInfo({ visibility: { ...vis, [key]: val } });
              };
              return (
                <Section
                  title={`基本情報${activePlan ? ` — ${activePlan.label}` : ''}`}
                  subtitle="PLAN INFO"
                  action={<button onClick={exportInfoJson} className={BTN}>{infoJsonCopied ? '✓ コピー済' : 'JSONエクスポート'}</button>}
                  defaultOpen={false}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <LabeledInput label="タイプ" value={info.type ?? ''} onChange={(v) => updateInfo({ type: v })} placeholder="type" />
                      <LabeledInput label="間取り" value={info.roomType ?? ''} onChange={(v) => updateInfo({ roomType: v })} placeholder="1LDK" />
                    </div>
                    {/* Paired for the same reason as タイプ / 間取り above: both are short
                        one-line facts, and stacking them full-width left a column of wide
                        fields holding a handful of characters each. */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <LabeledInput label="面積" value={info.area ?? ''} onChange={(v) => updateInfo({ area: v })} placeholder="42.5㎡" />
                      <LabeledInput label="階数 / 構造" value={info.floor ?? ''} onChange={(v) => updateInfo({ floor: v })} placeholder="3F / RC造" />
                    </div>
                    <LabeledInput label="所在地" value={info.location ?? ''} onChange={(v) => updateInfo({ location: v })} placeholder="東京都千代田区…" />
                    <LabeledInput label="メモ" value={info.notes ?? ''} onChange={(v) => updateInfo({ notes: v })} placeholder="自由記入 (改行で複数行)" />
                    <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div className="ds-label">ビューア「物件概要」表示</div>
                      <VisRow label="全体 (このブロックを表示)" checked={vis.overall !== false} onChange={(c) => setVis('overall', c)} />
                      <VisRow label="間取り見出し" checked={vis.heading !== false} onChange={(c) => setVis('heading', c)} disabled={vis.overall === false} />
                      <VisRow label="専有面積 + 坪換算" checked={vis.area !== false} onChange={(c) => setVis('area', c)} disabled={vis.overall === false} />
                      <VisRow label="階数 / 構造" checked={vis.floor !== false} onChange={(c) => setVis('floor', c)} disabled={vis.overall === false} />
                      <VisRow label="所在地" checked={vis.location !== false} onChange={(c) => setVis('location', c)} disabled={vis.overall === false} />
                      <VisRow label="メモ" checked={vis.notes !== false} onChange={(c) => setVis('notes', c)} disabled={vis.overall === false} />
                    </div>
                  </div>
                </Section>
              );
            })()}

            {/* ===== カラー (素材バリエーション) — アクティブプランの colorVariants 編集。住居・店舗 (mansion) 専用 ===== */}
            {debugTab === 'plan' && activePlanId && !isOtherProject && (() => {
              const activePlan = manifest?.plans?.find(p => p.id === activePlanId);
              if (!activePlan) return null;
              const variants = activePlan.colorVariants ?? [];
              const writeVariants = (next: typeof variants) => {
                useSceneStore.setState((s) => {
                  if (!s.manifest?.plans) return s;
                  return {
                    manifest: {
                      ...s.manifest,
                      plans: s.manifest.plans.map((p) => p.id === activePlanId ? { ...p, colorVariants: next.length > 0 ? next : undefined } : p),
                    },
                  };
                });
              };
              const addVariant = () => {
                const id = 'col_' + Date.now();
                writeVariants([...variants, { id, label: `カラー ${variants.length + 1}`, swatch: '#a89372', panoramas: {} }]);
              };
              const updateVariant = (vid: string, patch: Partial<{ label: string; swatch: string }>) => {
                writeVariants(variants.map((v) => v.id === vid ? { ...v, ...patch } : v));
              };
              const removeVariant = (vid: string) => {
                writeVariants(variants.filter((v) => v.id !== vid));
              };
              const setVariantPano = (vid: string, vpId: string, dataUrl: string | undefined) => {
                writeVariants(variants.map((v) => {
                  if (v.id !== vid) return v;
                  const next = { ...(v.panoramas ?? {}) };
                  if (dataUrl === undefined) delete next[vpId];
                  else next[vpId] = dataUrl;
                  return { ...v, panoramas: next };
                }));
              };
              const handleVariantPanoFile = (vid: string, vpId: string, file: File) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                  const d = e.target?.result as string;
                  if (d) setVariantPano(vid, vpId, d);
                };
                reader.readAsDataURL(file);
              };
              return (
                <Section title={`カラー (素材バリエーション)`} subtitle="COLOR VARIANTS" defaultOpen={false}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div className="ds-hint">
                      同じ視点で素材色違いに切り替えるバリエーション。各バリアントに視点ごとの 360° パノラマを登録します (未登録の視点は標準パノラマを利用)。
                    </div>
                    <button onClick={addVariant} className={BTN_PRIMARY}>+ バリアント追加</button>
                    {variants.map((v) => (
                      <div key={v.id} className="ds-well" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="color"
                            value={v.swatch ?? '#a89372'}
                            onChange={(e) => updateVariant(v.id, { swatch: e.target.value })}
                            className="ds-swatch-input"
                            style={{ width: 32, height: 28 }}
                            title="スウォッチ色"
                          />
                          <input
                            type="text"
                            value={v.label}
                            onChange={(e) => updateVariant(v.id, { label: e.target.value })}
                            style={{ flex: 1, ...S.formInput }}
                            placeholder="ラベル (例: ナチュラル)"
                          />
                          <button onClick={() => removeVariant(v.id)} className={dangerIconClass} title="削除"><IconTrash /></button>
                        </div>
                        {/* 視点ごとのパノラマ登録 */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {(activePlan.viewpoints ?? []).map((vp) => {
                            const has = !!v.panoramas?.[vp.id];
                            return (
                              <div key={vp.id} className="ds-body" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ flex: 1 }}>{vp.label}</span>
                                <span className={`ds-sub ${has ? 'ds-ok' : 'ds-faint'}`}>{has ? '登録済' : '未登録'}</span>
                                <label className={BTN} style={{ cursor: 'pointer' }}>
                                  パノラマ
                                  <input
                                    type="file"
                                    accept="image/*"
                                    style={{ display: 'none' }}
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file) handleVariantPanoFile(v.id, vp.id, file);
                                      e.target.value = '';
                                    }}
                                  />
                                </label>
                                {has && (
                                  <button onClick={() => setVariantPano(v.id, vp.id, undefined)} className={dangerIconClass} title="360 を外す"><IconClose /></button>
                                )}
                              </div>
                            );
                          })}
                          {(activePlan.viewpoints ?? []).length === 0 && (
                            <div className="ds-empty">視点がまだありません</div>
                          )}
                        </div>
                      </div>
                    ))}
                    {variants.length === 0 && (
                      <div className="ds-empty">まだバリアントがありません</div>
                    )}
                  </div>
                </Section>
              );
            })()}

            {/* (表示モードは Project 画面で選択するためここからは削除) */}

            {/* ===== プロジェクト名・サムネ (プロジェクトタブ) ===== */}
            {debugTab === 'global' && (() => {
              // Subscribe so thumb-pick updates re-render this section.
              const project = projectsList.find((p) => p.id === sceneId);
              const currentThumb = project?.thumbnail;
              // Collect every viewpoint across all plans with its best thumbnail (manual > auto-captured).
              const allVpThumbs = manifest?.plans?.flatMap((plan) => plan.viewpoints.map((vp) => ({
                planId: plan.id,
                planLabel: plan.label,
                vp,
                thumb: plan.thumbnails?.[vp.id] ?? thumbs[plan.id]?.[vp.id],
              }))) ?? [];
              const isThumbSelected = (t: string | undefined) => !!t && !!currentThumb && t === currentThumb;
              return (
                <Section title="プロジェクト名・サムネ" subtitle="NAME & THUMBNAIL" defaultOpen={false}>
                  <LabeledInput label="プロジェクト名" value={manifest?.name ?? ''} onChange={setSceneName} placeholder="例: モダンマンション B 棟" />

                  <div style={{ height: 12 }} />
                  <div className="ds-label" style={S.subTitle}>メインサムネ</div>
                  <div style={S.projThumbHead}>
                    <div className="ds-tile__thumb" style={S.projThumbPreview}>
                      {currentThumb ? (
                        <img src={currentThumb} alt="" style={S.projThumbPreviewImg} />
                      ) : (
                        <span className="ds-hint">未設定</span>
                      )}
                    </div>
                    <div className="ds-hint" style={{ flex: 1 }}>
                      プロジェクト一覧カードに表示されるサムネ。下から好きな視点を選択してください。
                    </div>
                    {currentThumb && (
                      <button
                        type="button"
                        onClick={() => setProjectThumbnail(undefined)}
                        className={dangerXsClass}
                        title="メインサムネをリセット"
                      >
                        リセット
                      </button>
                    )}
                  </div>
                  {allVpThumbs.length > 0 ? (
                    <div className="ds-well" style={S.projThumbGrid}>
                      {allVpThumbs.map(({ planId, planLabel, vp, thumb }) => {
                        const selected = isThumbSelected(thumb);
                        return (
                          <button
                            key={`${planId}-${vp.id}`}
                            type="button"
                            disabled={!thumb}
                            onClick={() => thumb && setProjectThumbnail(thumb)}
                            className={`${surfaceClass(selected ? 'accent' : 'plain')} ds-tile${selected ? '' : ' ds-fill-surface'}`}
                            data-active={selected}
                            style={{ position: 'relative' }}
                            title={thumb ? `${planLabel} / ${vp.label} に設定` : 'まだサムネが撮影されていません'}
                          >
                            <span className="ds-tile__thumb">
                              {thumb
                                ? <img src={thumb} alt="" style={S.projThumbCellImg} />
                                : <span className="ds-faint" style={S.projThumbCellPh}>—</span>}
                            </span>
                            <span className="ds-tile__label">
                              {(manifest?.plans?.length ?? 0) > 1 ? `${planLabel} / ` : ''}{vp.label}
                            </span>
                            {selected && <span className="ds-accent" style={S.projThumbCheck}><IconCheck /></span>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="ds-empty">視点がまだありません。プランタブで視点を追加してください。</div>
                  )}
                </Section>
              );
            })()}

            {/* ===== 各プラン (プロジェクトタブ — どのプランを編集中か) =====
                 ツールバー表示より先。プロジェクトを開いて最初にすることは
                 「どのプランを編集するか」で、ビューアの項目出し分けはその後。 */}
            {debugTab === 'global' && (
            <Section
              title={`各プラン (${manifest?.plans?.length ?? 0})`}
              subtitle="PLANS"
              action={<button onClick={() => { setShowAddPlan(true); setNewPlanName(''); }} className={BTN_PRIMARY}>+ プランを追加</button>}
              defaultOpen={false}
            >
              {manifest?.plans && manifest.plans.length > 0 ? (
                <div style={S.vpList}>
                  {manifest.plans.map((p) => {
                    const isActive = p.id === activePlanId;
                    const isEditing = editPlanId === p.id;
                    const isBusy = planSplatBusy === p.id;
                    const splatLabel = p.splatSog
                      ? `(SOG${p.splatSourceName ? ` · ${p.splatSourceName}` : ''})`
                      : !p.splat
                        ? '(未設定)'
                        : p.splat.startsWith('blob:')
                          ? `(アップロード${p.splatSourceName ? ` · ${p.splatSourceName}` : ''})`
                          : p.splat.startsWith(idb.IDB_REF_PREFIX)
                            ? `(IDB${p.splatSourceName ? ` · ${p.splatSourceName}` : ''})`
                            : p.splat.startsWith('data:')
                              ? '(data URL)'
                              : p.splat;
                    const panoCount = p.panoramas ? Object.keys(p.panoramas).length : 0;
                    const planVpCount = p.viewpoints.length;
                    const isPlanDragOver = planDragOverId === p.id;
                    return (
                      <div
                        key={p.id}
                        className={`${rowClass(isActive)} ds-row--tight`}
                        data-drop={isPlanDragOver || undefined}
                        onDragOver={(e) => handlePlanRowDragOver(e, p.id)}
                        onDragLeave={handlePlanRowDragLeave}
                        onDrop={(e) => handlePlanRowDrop(e, p.id)}
                      >
                        <button
                          onClick={() => switchPlan(p.id)}
                          className="ds-swatch"
                          data-active={isActive}
                          style={S.vpDot}
                          aria-label="activate"
                          title={isActive ? '使用中' : 'このプランに切替'}
                          disabled={isBusy}
                        />
                        {/* Name and counts share one line. A plan row is scanned
                            for "which plan am I on", not read, so the second
                            line was costing height without earning it. The meta
                            gives up its width first — the label is the
                            identity, the counts are a glance. */}
                        <div style={S.planMain}>
                          {isEditing ? (
                            <input
                              type="text" value={editPlanLabel}
                              onChange={e => setEditPlanLabel(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') renamePlan(p.id); if (e.key === 'Escape') setEditPlanId(null); }}
                              onBlur={() => renamePlan(p.id)}
                              autoFocus style={S.inputInline}
                            />
                          ) : (
                            <>
                              <div onClick={() => switchPlan(p.id)} className="ds-body" style={S.planLabel}>
                                {p.label}
                              </div>
                              <div className="ds-hint" style={S.planMeta}>
                                {isVRMode ? (
                                  <>
                                    <span>VR視点 {planVpCount}</span>
                                    <span style={S.vpMetaSep}>·</span>
                                    <span>画像 {panoCount}/{planVpCount}</span>
                                  </>
                                ) : (
                                  <>
                                    <span>splat {splatLabel}</span>
                                    <span style={S.vpMetaSep}>·</span>
                                    <span>視点 {planVpCount}</span>
                                    <span style={S.vpMetaSep}>·</span>
                                    <span>360 {panoCount}/{planVpCount}</span>
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                        <div style={S.vpActions}>
                          {!isVRMode && (
                            <>
                              <button
                                title="Splat ファイルをアップロード（PLY / SPLAT 単体、または SOG なら meta.json + .webp 全て選択）"
                                onClick={() => { setPlanSplatTargetId(p.id); planSplatInputRef.current?.click(); }}
                                className="ds-iconbtn"
                                disabled={isBusy}
                              >
                                {isBusy ? '⏳' : '⇪'}
                              </button>
                              {(p.splat || p.splatSog) && (
                                <button
                                  title="このプランの Splat を削除"
                                  onClick={() => void handlePlanSplatClear(p.id)}
                                  className={dangerIconClass}
                                  disabled={isBusy}
                                ><IconClose /></button>
                              )}
                            </>
                          )}
                          <button title="名前を変更" onClick={() => { setEditPlanId(p.id); setEditPlanLabel(p.label); }} className="ds-iconbtn">✎</button>
                          <button
                            title="プランを削除"
                            onClick={() => { if (manifest.plans!.length > 1) removePlanStore(p.id); }}
                            className={dangerIconClass}
                            disabled={manifest.plans!.length <= 1}
                          ><IconTrash /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="ds-empty">プランがまだありません</div>
              )}
              {showAddPlan && (
                <div className={`${surfaceClass('plain')} ds-panel ds-fill-surface`} style={S.inlineCard}>
                  <input type="text" placeholder="プラン名を入力（例: モダン / 北欧）" value={newPlanName}
                    onChange={e => setNewPlanName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addPlan(); if (e.key === 'Escape') setShowAddPlan(false); }}
                    autoFocus style={S.input} />
                  <div className="ds-hint" style={{ marginTop: 6 }}>
                    {isVRMode
                      ? '新規プランは完全に空（VR視点 / 画像 / 図面 / info すべて未設定）で作成されます。'
                      : '新規プランは完全に空（splat / 視点 / 図面 / info すべて未設定）で作成されます。'}
                  </div>
                  <div style={S.btnRow}>
                    <button onClick={addPlan} className={BTN_PRIMARY}>追加</button>
                    <button onClick={() => setShowAddPlan(false)} className={BTN}>キャンセル</button>
                  </div>
                </div>
              )}
            </Section>
            )}

            {/* ===== ツールバー表示 (プロジェクトタブ) — 全プロジェクト共通。
                 ビューアのサイドバー / オーバーレイの各項目を表示するか個別に切替える。 ===== */}
            {debugTab === 'global' && (
              <ViewerToolbarSection
                tb={manifest?.viewerToolbar ?? {}}
                isOtherProject={isOtherProject}
                isVRMode={isVRMode}
                variants={manifest?.variants}
                onChange={(patch) => {
                  const cur = manifest?.viewerToolbar ?? {};
                  useSceneStore.getState().setViewerToolbar({ ...cur, ...patch });
                }}
                onReset={() => useSceneStore.getState().setViewerToolbar(null)}
                onToggleVariant={toggleVariantTool}
              />
            )}

            {/* ===== 環境音 (プロジェクトタブ, 各プランの下) =====
                BGM は両モードで使える (パノラマでも音楽は流せる)。足音は歩く
                3DGS でしか意味がないので、VR モード or splat データが無い場合は
                subsection を出さない。 */}
            {debugTab === 'global' && (() => {
              const setSceneAudio = useSceneStore.getState().setSceneAudio;
              const handleAudioFile = async (file: File) => {
                if (!manifest) return;
                try {
                  const blobKey = `audio:${manifest.id}:${Date.now()}`;
                  await idb.saveBlob(blobKey, file);
                  setSceneAudio(`${idb.IDB_REF_PREFIX}${blobKey}`);
                } catch (e) {
                  console.error('audio upload failed:', e);
                }
              };
              return (
                <Section title="環境音" subtitle="AUDIO" defaultOpen={false}>
                  {/* BGM (ループ環境音) */}
                  <div className="ds-label" style={S.subTitle}>BGM (ループ環境音)</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <span className={`ds-sub ${manifest?.audio ? 'ds-ok' : 'ds-faint'}`}>
                      {manifest?.audio ? '設定済' : '未設定'}
                    </span>
                    <div style={{ flex: 1 }} />
                    <label className={BTN} style={{ cursor: 'pointer' }}>
                      {manifest?.audio ? '差し替え' : '+ 音声ファイル'}
                      <input
                        type="file"
                        accept="audio/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleAudioFile(f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {manifest?.audio && (
                      <button onClick={() => setSceneAudio(undefined)} className={dangerPillClass}><IconTrash />削除</button>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {BGM_PRESETS.map((preset) => {
                      const isActive = manifest?.audio === preset.path;
                      return (
                        <Chip
                          key={preset.id}
                          active={isActive}
                          onClick={() => setSceneAudio(preset.path)}
                          title={isActive ? '使用中' : `${preset.label} を設定`}
                        >
                          {preset.label}
                        </Chip>
                      );
                    })}
                  </div>
                  <div className="ds-hint" style={{ marginTop: 4 }}>
                    プリセットから選ぶか、独自の音声ファイルをアップロード。ビューア側のスピーカーアイコンから再生切替。
                  </div>

                  {/* 足音 (デフォルト固定 / ON-OFF + ボリューム、Shift で走行)
                      VR / パノラマモードや splat データ無しでは歩かないので非表示。 */}
                  {!isVRMode && hasSplatData && (
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                    <div className="ds-label" style={S.subTitle}>足音</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <span className="ds-hint">WASD で歩行、Shift で走行</span>
                      <div style={{ flex: 1 }} />
                      {(() => {
                        const enabled = manifest?.settings.footstepEnabled !== false; // default ON
                        return (
                          <button
                            type="button"
                            onClick={() => useSceneStore.getState().updateSettings({ footstepEnabled: !enabled })}
                            className={`${surfaceClass(enabled ? 'success' : 'plain')} ds-pill ds-pill--xs${enabled ? '' : ' ds-fill-surface'}`}
                          >
                            {enabled ? 'ON' : 'OFF'}
                          </button>
                        );
                      })()}
                    </div>
                    {(() => {
                      const enabled = manifest?.settings.footstepEnabled !== false;
                      const vol = Math.max(0, Math.min(1, manifest?.settings.footstepVolume ?? 0.7));
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, opacity: enabled ? 1 : 0.4 }}>
                          <span className="ds-hint" style={{ minWidth: 64 }}>ボリューム</span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={vol}
                            disabled={!enabled}
                            onChange={(e) => useSceneStore.getState().updateSettings({ footstepVolume: Number(e.target.value) })}
                            style={{ flex: 1, accentColor: tokens.color.accent }}
                          />
                          <span className="ds-mono ds-faint" style={{ minWidth: 32, textAlign: 'right' }}>
                            {Math.round(vol * 100)}%
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                  )}
                </Section>
              );
            })()}

            {/* ===== 描画品質 (全体) — 3DGS 描画ノブ群 + ビューアエンジン選択 ===== */}
            {debugTab === 'global' && (
              <RenderQualitySection
                cfg={manifest?.settings.render ?? {}}
                isVRMode={isVRMode}
                onPatch={(patch) => useSceneStore.getState().updateSettings({
                  render: { ...(manifest?.settings.render ?? {}), ...patch },
                })}
                onApply={(merged) => smRef.current?.applyRenderConfig(merged)}
                onReset={() => useSceneStore.getState().updateSettings({ render: undefined })}
                onSwitchEngine={async (engine) => {
                  console.info(`[switch] click engine=${engine}`);
                  const cur = useSceneStore.getState().manifest?.settings.render ?? {};
                  const nextRender = { ...cur, engine };
                  useSceneStore.getState().updateSettings({ render: nextRender });
                  const m = useSceneStore.getState().manifest;
                  console.info('[switch] manifest after updateSettings:', m?.settings.render);
                  if (m) {
                    try {
                      await idb.saveManifest(m.id, m);
                      console.info('[switch] idb.saveManifest OK');
                    } catch (e) {
                      console.error('[switch] save FAILED:', e);
                      alert('エンジン保存失敗: ' + (e instanceof Error ? e.message : String(e)));
                      return;
                    }
                  } else {
                    console.warn('[switch] no manifest in store, save skipped');
                  }
                  // 短い視覚フィードバックを出してからリロード (本当に切替が起きたか確認用)。
                  const overlay = document.createElement('div');
                  overlay.textContent = `${engine.toUpperCase()} に切替中…`;
                  overlay.className = 'ds-reload-veil';
                  document.body.appendChild(overlay);
                  setTimeout(() => window.location.reload(), 600);
                }}
                onToggleBypassPipeline={async (next) => {
                  // CameraFrame と gsplatOutputVS は init 時固定。トグル変更は
                  // manifest を保存してからフルリロードしないと反映されない。
                  console.info(`[bypass] toggle bypassColorPipeline=${next}`);
                  const cur = useSceneStore.getState().manifest?.settings.render ?? {};
                  const nextRender = { ...cur, bypassColorPipeline: next };
                  useSceneStore.getState().updateSettings({ render: nextRender });
                  const m = useSceneStore.getState().manifest;
                  if (m) {
                    try {
                      await idb.saveManifest(m.id, m);
                    } catch (e) {
                      console.error('[bypass] save FAILED:', e);
                      alert('カラーパイプライン設定の保存失敗: ' + (e instanceof Error ? e.message : String(e)));
                      return;
                    }
                  }
                  const overlay = document.createElement('div');
                  overlay.textContent = next ? '色調整なしで再起動中…' : 'SuperSplat 同等処理に戻して再起動中…';
                  overlay.className = 'ds-reload-veil';
                  document.body.appendChild(overlay);
                  setTimeout(() => window.location.reload(), 600);
                }}
              />
            )}

            {/* ===== Camera (全体, viewMode で出し分け) ===== */}
            {debugTab === 'global' && (
            <Section title="カメラ" subtitle={viewMode === '360' ? 'CAMERA — 360VR' : 'CAMERA — 3DGS'} defaultOpen={false}>
              <div style={S.kvGrid}>
                <KV label="Position X" value={position[0].toFixed(2)} accent="#f87171" />
                <KV label="Position Y" value={position[1].toFixed(2)} accent="#22c55e" />
                <KV label="Position Z" value={position[2].toFixed(2)} accent="#60a5fa" />
                <KV label="Pitch" value={`${pitch.toFixed(1)}°`} />
                <KV label="Yaw" value={`${yaw.toFixed(1)}°`} />
                <KV label="FOV" value={`${fov.toFixed(0)}°`} />
              </div>

              <label className="ds-check" style={{ ...S.toggle, marginTop: 6 }} title="床面 (Y=0) のグリッドを表示。位置・スケール確認用">
                <input type="checkbox" checked={showGrid} onChange={toggleGrid} />
                <span>グリッドを表示 <span className="ds-hint" style={S.toolbarHint}>(XZ 平面 / 1 m メッシュ)</span></span>
              </label>

              {viewMode === 'splat' ? (
                <>
                  {/* 移動速度 / 初期高さ は 3DGS で実際に歩き回るときの設定なので、
                      splat データが入ってる時だけ出す。パノラマモードに切り替え忘れた
                      VR プロジェクトでも UI が混乱しないようガード。 */}
                  {hasSplatData && (
                    <Slider label="移動速度" min={0.1} max={30} step={0.1} value={moveSpeed} onChange={onMoveSpeedChange} />
                  )}
                  <Slider label="FOV" min={30} max={120} step={1} value={fovLocal} onChange={onFovChange} />
                  {hasSplatData && (
                    <Slider
                      label="初期高さ (m)"
                      min={-10}
                      max={10}
                      step={0.05}
                      value={manifest?.settings.initialHeight ?? manifest?.settings.cameraHeight ?? 1.6}
                      onChange={(v) => {
                        const next = +v.toFixed(2);
                        updateSettings({ initialHeight: next });
                        smRef.current?.setCurrentHeight(next);
                      }}
                    />
                  )}

                  {/* PLY (3DGS) の軸 / 位置調整 — 上下逆さまな PLY を直したり、モデルを地面に合わせる */}
                  {(() => {
                    const activePlan = manifest?.plans?.find((p) => p.id === activePlanId);
                    // PLY だけでなく SOG bundle (`.sog` 単一 / meta.json+webp) でも同じ
                    // splatTransform を使うので、どちらかがあれば編集 UI を出す。
                    if (!activePlan?.splat && !activePlan?.splatSog) return null;
                    const t = activePlan.splatTransform ?? {};
                    const rot = t.rotation ?? [180, 0, 0];
                    const pos = t.position ?? [0, 0, 0];
                    const setT = (next: { rotation?: [number, number, number]; position?: [number, number, number] }) => {
                      const merged = {
                        rotation: next.rotation ?? rot,
                        position: next.position ?? pos,
                      };
                      useSceneStore.getState().setPlanSplatTransform(activePlan.id, merged);
                      smRef.current?.setSplatTransform(merged);
                    };
                    const round = (v: number) => +v.toFixed(2);
                    const setRot = (i: 0 | 1 | 2, v: number) => {
                      const r: [number, number, number] = [rot[0], rot[1], rot[2]];
                      r[i] = round(v);
                      setT({ rotation: r });
                    };
                    const setPos = (i: 0 | 1 | 2, v: number) => {
                      const p: [number, number, number] = [pos[0], pos[1], pos[2]];
                      p[i] = round(v);
                      setT({ position: p });
                    };
                    const reset = () => {
                      useSceneStore.getState().setPlanSplatTransform(activePlan.id, null);
                      smRef.current?.setSplatTransform(undefined);
                    };
                    const isModified = !!activePlan.splatTransform;
                    return (
                      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span className="ds-label" style={S.subTitle}>PLY 軸 / 位置</span>
                          <div style={{ flex: 1 }} />
                          {isModified && (
                            <button type="button" onClick={reset} className={`${surfaceClass('danger')} ds-pill ds-pill--xs`} title="既定 (rot=[180,0,0], pos=[0,0,0]) に戻す">
                              リセット
                            </button>
                          )}
                        </div>
                        <div className="ds-hint" style={{ marginBottom: 6 }}>
                          PLY が上下逆さま / 床にめり込む場合に調整。プランごとに保存されます。
                        </div>
                        <div className="ds-label" style={{ marginTop: 4 }}>回転 (°)</div>
                        <Slider label="X (前後の傾き)" min={-180} max={180} step={1} value={rot[0]} onChange={(v) => setRot(0, v)} />
                        <Slider label="Y (水平回転)"   min={-180} max={180} step={1} value={rot[1]} onChange={(v) => setRot(1, v)} />
                        <Slider label="Z (左右の傾き)" min={-180} max={180} step={1} value={rot[2]} onChange={(v) => setRot(2, v)} />
                        <div className="ds-label" style={{ marginTop: 8 }}>位置 (m)</div>
                        <Slider label="X (左右)" min={-50} max={50} step={0.05} value={pos[0]} onChange={(v) => setPos(0, v)} />
                        <Slider label="Y (前後)" min={-50} max={50} step={0.05} value={pos[2]} onChange={(v) => setPos(2, v)} />
                        <Slider label="Z (高さ)" min={-50} max={50} step={0.05} value={pos[1]} onChange={(v) => setPos(1, v)} />
                      </div>
                    );
                  })()}

                  <div style={S.btnRow}>
                    <button onClick={copyCamera} className={BTN}>{copied ? '✓ コピー済' : 'JSONコピー'}</button>
                    <button onClick={() => { setShowAddVp(true); setNewVpName(''); }} className={BTN_PRIMARY}>+ 視点として保存</button>
                  </div>
                  {showAddVp && (
                    <div className={`${surfaceClass('plain')} ds-panel ds-fill-surface`} style={S.inlineCard}>
                      <input type="text" placeholder="視点名を入力（例: リビング）" value={newVpName}
                        onChange={e => setNewVpName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') addVp(); if (e.key === 'Escape') setShowAddVp(false); }}
                        autoFocus style={S.input} />
                      <div style={S.btnRow}>
                        <button onClick={addVp} className={BTN_PRIMARY}>保存</button>
                        <button onClick={() => setShowAddVp(false)} className={BTN}>キャンセル</button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="ds-hint" style={{ marginBottom: 6 }}>
                    プレビュー上で <strong>マウスホイール</strong> でズーム可能。<br />
                    範囲は <code className="ds-code">{manifest?.settings.zoomFovMin ?? 25}°〜{manifest?.settings.zoomFovMax ?? 100}°</code> で固定。
                  </div>
                  {!showZoomRange ? (
                    <button
                      type="button"
                      onClick={() => setShowZoomRange(true)}
                      className={`${surfaceClass('neutral')} ds-pill ds-pill--xs ds-fill-neutral`}
                      title="ロック範囲を変更（通常は変更不要）"
                    >
                      ズーム範囲を変更…
                    </button>
                  ) : (
                    <div className="ds-well" style={S.zoomRangeBox}>
                      <div style={S.zoomRangeHead}>
                        <span className="ds-label" style={S.subTitle}>拡大縮小範囲 (FOV)</span>
                        <button type="button" onClick={() => setShowZoomRange(false)} className="ds-iconbtn" title="折りたたむ"><IconClose /></button>
                      </div>
                      <Slider
                        label="最小 (ズームイン上限)"
                        min={15} max={90} step={1}
                        value={manifest?.settings.zoomFovMin ?? 25}
                        onChange={(v) => {
                          const max = manifest?.settings.zoomFovMax ?? 100;
                          const next = Math.min(Math.round(v), max - 1);
                          updateSettings({ zoomFovMin: next });
                          (smRef.current as { setZoomFovBounds?: (a: number, b: number) => void } | null)?.setZoomFovBounds?.(next, max);
                          if (fovLocal < next) onFovChange(next);
                        }}
                      />
                      <Slider
                        label="最大 (ズームアウト上限)"
                        min={40} max={140} step={1}
                        value={manifest?.settings.zoomFovMax ?? 100}
                        onChange={(v) => {
                          const min = manifest?.settings.zoomFovMin ?? 25;
                          const next = Math.max(Math.round(v), min + 1);
                          updateSettings({ zoomFovMax: next });
                          (smRef.current as { setZoomFovBounds?: (a: number, b: number) => void } | null)?.setZoomFovBounds?.(min, next);
                          if (fovLocal > next) onFovChange(next);
                        }}
                      />
                    </div>
                  )}
                  <Slider
                    label="現在の FOV (テスト用)"
                    min={manifest?.settings.zoomFovMin ?? 25}
                    max={manifest?.settings.zoomFovMax ?? 100}
                    step={1}
                    value={fovLocal}
                    onChange={onFovChange}
                  />
                  <div style={{ height: 8 }} />
                  <div className="ds-label" style={S.subTitle}>視線ロック</div>
                  <Slider
                    label="上向きの上限 (°)"
                    min={0} max={89} step={1}
                    value={manifest?.settings.pitchMaxUp ?? 89}
                    onChange={(v) => {
                      const next = Math.round(v);
                      updateSettings({ pitchMaxUp: next });
                      smRef.current?.setPitchMaxUp(next);
                    }}
                  />
                </>
              )}

            </Section>
            )}

            {/* ===== Viewpoints (アクティブプラン) ===== */}
            {debugTab === 'plan' && (
            <Section
              title={`${isVRMode ? 'VR視点' : '視点'} (${manifest?.plans?.find(p => p.id === activePlanId)?.viewpoints.length ?? 0})`}
              subtitle={isVRMode ? 'VR PANORAMA' : 'VIEWPOINTS'}
              defaultOpen={false}
              action={
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => { setShowAddVp(true); setNewVpName(''); setAddVpPanoFile(null); setAddVpPanoName(null); }} className={BTN_PRIMARY}>+ {isVRMode ? 'VR視点' : '視点'}を追加</button>
                  <button onClick={exportVps} className={BTN}>{exportedVp ? '✓ コピー済' : 'JSONエクスポート'}</button>
                </div>
              }
            >
              {manifest && ready ? (() => {
                const activePlan = manifest.plans?.find(p => p.id === activePlanId);
                const activeViewpoints = activePlan?.viewpoints ?? [];
                if (activeViewpoints.length === 0) {
                  return <div className="ds-empty">このプランの{isVRMode ? 'VR視点' : '視点'}がまだ追加されていません</div>;
                }
                const planThumbs = activePlan?.thumbnails ?? {};
                const autoThumbs = (activePlanId && thumbs[activePlanId]) || {};
                return (
                  <div style={S.vpList}>
                    {activeViewpoints.map(vp => {
                      const isA = activeVp === vp.id;
                      const isStart = activePlan?.startViewpointId === vp.id;
                      const dotOffset = !!vp.mapPosition && (Math.abs(vp.mapPosition[0] - vp.position[0]) > 1e-3 || Math.abs(vp.mapPosition[1] - vp.position[2]) > 1e-3);
                      const isE = editId === vp.id;
                      const thumb = planThumbs[vp.id] ?? autoThumbs[vp.id];
                      const isManual = !!planThumbs[vp.id];
                      const vpPanoSrc = activePlan?.panoramas?.[vp.id];
                      const showVrPreview = isA && isVRMode && !!vpPanoSrc && !!activePlanId;
                      const isVpDragOver = vpDragOverId === vp.id;
                      const isReorderTarget = vpReorderOverId === vp.id && vpDragSrcId !== vp.id;
                      const isDragSrc = vpDragSrcId === vp.id;
                      return (
                        <div key={vp.id}>
                        <div
                          ref={(el) => { vpRowRefs.current[vp.id] = el; }}
                          className={rowClass(isA)}
                          data-drop={isVpDragOver || undefined}
                          data-reorder={isReorderTarget || undefined}
                          style={isDragSrc ? { opacity: 0.4 } : undefined}
                          onDragOver={(e) => handleVpRowDragOver(e, vp.id)}
                          onDragLeave={handleVpRowDragLeave}
                          onDrop={(e) => handleVpRowDrop(e, vp.id)}
                        >
                          <span
                            draggable
                            onDragStart={(e) => handleVpHandleDragStart(e, vp.id)}
                            onDragEnd={handleVpHandleDragEnd}
                            className="ds-sub"
                            style={S.vpDragHandle}
                            title="ドラッグで並び替え"
                            aria-label="reorder"
                          >
                            ☰
                          </span>
                          <button
                            onClick={() => handleVpClick(vp.id)}
                            className="ds-tile__thumb"
                            style={S.vpThumb}
                            aria-label="jump"
                            title={isManual ? '手動サムネ（クリックでジャンプ）' : '自動サムネ（クリックでジャンプ）'}
                          >
                            {thumb ? <img src={thumb} alt="" style={S.vpThumbImg} /> : <span className="ds-faint" style={S.vpThumbEmpty}>—</span>}
                            {isManual && <Tag variant="success" style={S.vpThumbBadge}>M</Tag>}
                          </button>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {isE ? (
                              <input
                                type="text" value={editLabel}
                                onChange={e => setEditLabel(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') renameVp(vp.id); if (e.key === 'Escape') setEditId(null); }}
                                onBlur={() => renameVp(vp.id)}
                                autoFocus style={S.inputInline}
                              />
                            ) : (
                              <div onClick={() => handleVpClick(vp.id)} className="ds-title" style={S.vpLabel}>
                                {vp.label}
                                {isStart && <span className="ds-hint ds-accent" style={{ marginLeft: 6 }}>🏁 初期位置</span>}
                              </div>
                            )}
                            <div className="ds-mono ds-hint" style={S.vpMeta}>
                              <span>pos [{vp.position.map(v => v.toFixed(1)).join(', ')}]</span>
                              <span style={S.vpMetaSep}>·</span>
                              <span>fov {vp.fov}°</span>
                            </div>
                          </div>
                          <div style={S.vpActions}>
                            {/* Emoji, not icons, until now: a glyph is whatever the
                                installed font decides, so this row sat at a different
                                weight and size from every other control beside it. */}
                            <button
                              title={isStart ? '初期位置に設定済み（シーンを開くとここから開始）' : 'この視点を初期位置にする（開いたらここから開始）'}
                              onClick={() => setStartViewpoint(vp.id)}
                              className={isStart ? `${surfaceClass('accent')} ds-pill ds-pill--icon ds-pill--xs` : roundIconClass}
                            >
                              <IconPin />
                            </button>
                            {dotOffset && (
                              <button
                                title="ドット位置をカメラに反映（カメラ・初期位置・サムネ撮影点をドットの場所へ移動）"
                                onClick={() => bakeViewpointToCamera(vp.id)}
                                className={`${surfaceClass('warn')} ds-pill ds-pill--icon ds-pill--xs`}
                              >
                                <IconTarget />
                              </button>
                            )}
                            <button
                              title={isVRMode ? 'パノラマからサムネを再生成' : '今いる位置・向き・画をこの視点に保存（位置＋サムネを更新／ジャンプ先＝この画になる）'}
                              onClick={() => captureCurrentAsThumb(vp.id)}
                              className={roundIconClass}
                            >
                              <IconCamera />
                            </button>
                            {/* Set / replace the 360 image. Removing one is done by
                                replacing it, so the separate 「削除」pill is gone —
                                it was the one square label in a row of round icons. */}
                            <button
                              title={activePlan?.panoramas?.[vp.id] ? '360パノラマ: 設定済み（クリックで差し替え）' : '360パノラマを追加'}
                              onClick={() => { setPanoTargetVp(vp.id); panoInputRef.current?.click(); }}
                              className={activePlan?.panoramas?.[vp.id] ? `${surfaceClass('success')} ds-pill ds-pill--icon ds-pill--xs` : roundIconClass}
                              disabled={panoLoading === vp.id}
                            >
                              <IconPhoto />
                            </button>
                            <button title="名前を変更" onClick={() => { setEditId(vp.id); setEditLabel(vp.label); }} className={roundIconClass}><IconEdit /></button>
                            <button title="削除" onClick={() => removeViewpoint(vp.id)} className={dangerIconClass}><IconTrash /></button>
                          </div>
                        </div>
                        {showVrPreview && activePlanId && vpPanoSrc && (
                          <VRThumbPreview vp={vp} planId={activePlanId} panoramaSrc={vpPanoSrc} />
                        )}
                        </div>
                      );
                    })}
                  </div>
                );
              })() : (
                <div className="ds-empty">読み込み中…</div>
              )}
              {showAddVp && (
                <div className={`${surfaceClass('plain')} ds-panel ds-fill-surface`} style={S.inlineCard}>
                  <input
                    type="text"
                    placeholder={isVRMode ? 'VR視点名を入力（例: 玄関 / リビング）' : '視点名を入力（例: リビング）'}
                    value={newVpName}
                    onChange={e => setNewVpName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addVp(); if (e.key === 'Escape') cancelAddVp(); }}
                    autoFocus
                    style={S.input}
                  />
                  {isVRMode && (
                    <>
                      <div style={{ height: 6 }} />
                      <button type="button" onClick={() => addVpPanoInputRef.current?.click()} className={`${shellClass}`} style={S.fileBtn}>
                        {addVpPanoName ? `🌐 ${addVpPanoName}` : '🌐 360 画像を選択（任意 / .jpg .png .hdr .exr）'}
                      </button>
                      <div className="ds-hint" style={{ marginTop: 6 }}>
                        画像はあとから視点行の 🌐 ボタンでも差し替えできます。
                      </div>
                    </>
                  )}
                  <div style={S.btnRow}>
                    <button onClick={addVp} className={BTN_PRIMARY}>保存</button>
                    <button onClick={cancelAddVp} className={BTN}>キャンセル</button>
                  </div>
                </div>
              )}
            </Section>
            )}

            {/* ===== Collision — プランタブ (3DGS のみ; 360VR では不要)
                 パノラマだけのプロジェクト (splat データ無し) でも歩かないので非表示。 */}
            {debugTab === 'plan' && viewMode === 'splat' && hasSplatData && (() => {
              const activePlanForCol = manifest?.plans?.find(p => p.id === activePlanId);
              const col = activePlanForCol?.collision;
              const busy = colLoading !== null;
              return (
            <Section title="コリジョン" subtitle="COLLISION" defaultOpen={false}>
              <label className="ds-check" style={S.toggle}>
                <input type="checkbox" checked={useCollisionWalkable} onChange={toggleUseCollisionWalkable} />
                <span>walkable を使用 <span className="ds-hint">（床スナップ／重力）</span></span>
              </label>
              <label className="ds-check" style={S.toggle}>
                <input type="checkbox" checked={useCollisionBlock} onChange={toggleUseCollisionBlock} />
                <span>block を使用 <span className="ds-hint">（壁衝突）</span></span>
              </label>
              <label className="ds-check" style={S.toggle}>
                <input type="checkbox" checked={showCollision} onChange={toggleCollision} />
                <span>コリジョンを表示 <span className="ds-hint">（デバッグメッシュ）</span></span>
              </label>
              {showCollision && (
                <Slider label="不透明度" min={0} max={1} step={0.05} value={collisionOpacity} onChange={setCollisionOpacity} />
              )}

              {/* ── 全体調整 — GS とのスケール/位置ズレを丸ごと合わせ込む ── */}
              {(() => {
                const tf = col?.transform;
                const pos = tf?.position ?? [0, 0, 0];
                const scale = tf?.scale ?? 1;
                const rotY = tf?.rotationY ?? 0;
                const hasAny = !!(col?.walkable || col?.block);
                const applyTf = (patch: Partial<import('../core/types').CollisionTransform>) => {
                  if (!activePlanId) return;
                  const next: import('../core/types').CollisionTransform = {
                    position: patch.position ?? (pos as [number, number, number]),
                    scale: patch.scale ?? scale,
                    rotationY: patch.rotationY ?? rotY,
                  };
                  const identity = next.scale === 1 && next.rotationY === 0
                    && next.position![0] === 0 && next.position![1] === 0 && next.position![2] === 0;
                  setPlanCollisionTransformStore(activePlanId, identity ? undefined : next);
                  smRef.current?.setCollisionTransform?.();
                };
                const setPosAxis = (axis: 0 | 1 | 2, v: number) => {
                  const p = [...pos] as [number, number, number];
                  p[axis] = +v.toFixed(3);
                  applyTf({ position: p });
                };
                return (
                  <>
                    <div className="ds-label" style={{ ...S.subTitle, marginTop: 14 }}>全体調整（図面⇄GS 合わせ込み）</div>
                    {!hasAny ? (
                      <div className="ds-hint">
                        コリジョンを生成/アップロードすると、ここで全体のオフセット・スケール・回転を調整できます。
                      </div>
                    ) : (
                      <>
                        <div className="ds-hint" style={{ marginBottom: 6 }}>
                          「コリジョンを表示」を ON にして、緑/赤メッシュが GS に重なるように調整してください。歩行判定は操作を止めた 0.3 秒後に追従します。
                        </div>
                        {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                          <Slider
                            key={label}
                            label={`オフセット ${label}`}
                            min={-10}
                            max={10}
                            step={0.05}
                            value={pos[axis]}
                            onChange={(v) => setPosAxis(axis as 0 | 1 | 2, v)}
                          />
                        ))}
                        <Slider label="スケール" min={0.2} max={3} step={0.01} value={scale}
                          onChange={(v) => applyTf({ scale: +v.toFixed(3) })} />
                        <Slider label="回転 Y (°)" min={-180} max={180} step={0.5} value={rotY}
                          onChange={(v) => applyTf({ rotationY: +v.toFixed(1) })} />
                        {tf && (
                          <button
                            type="button"
                            className={BTN} style={{ marginTop: 4 }}
                            onClick={() => {
                              if (!activePlanId) return;
                              setPlanCollisionTransformStore(activePlanId, undefined);
                              smRef.current?.setCollisionTransform?.();
                            }}
                          >
                            ↺ 調整をリセット
                          </button>
                        )}
                      </>
                    )}
                  </>
                );
              })()}

              {/* ── 俯瞰で描く (GS を断面表示して直接なぞる — 主経路) ── */}
              <div className="ds-label" style={{ ...S.subTitle, marginTop: 14 }}>俯瞰で描く（GS 直接）</div>
              <button
                type="button"
                className={`${shellClass}`} style={{ ...S.fileBtn, opacity: topDownColOpen ? 0.6 : 1 }}
                disabled={topDownColOpen}
                onClick={() => {
                  const sm = smRef.current;
                  if (!sm || !('enterTopDownView' in sm)) { alert('俯瞰編集は PlayCanvas エンジンのみ対応です'); return; }
                  const floorY = col?.walls?.floorY ?? 0;
                  const ok = (sm as unknown as { enterTopDownView: (y: number) => boolean }).enterTopDownView(floorY + 1.2);
                  if (!ok) { alert('splat のロード完了後に開いてください'); return; }
                  setTopDownColOpen(true);
                }}
                title="GS を水平に切断して真上（正投影）から見下ろし、壁や床の輪郭を直接なぞって描きます"
              >
                ⬇ GS を切って上から描く
              </button>
              <div className="ds-hint" style={{ marginTop: 4 }}>
                断面スライダーで切断高さを変えながら、見えている壁をなぞってください。
              </div>

              {/* ── GLB アップロード (外部ツールで作った場合) ── */}
              <div className="ds-label" style={{ ...S.subTitle, marginTop: 14 }}>GLB アップロード</div>
              <div className="ds-label" style={{ ...S.subTitle, marginTop: 6 }}><span className="ds-swatch" style={{ ...S.colorDot, background: '#22c55e' }} />WALKABLE</div>
              <button onClick={() => walkableRef.current?.click()} className={`${shellClass}`} style={S.fileBtn} disabled={busy}>
                {colLoading === 'walkable' ? '読み込み中…' : 'GLB ファイルを選択'}
              </button>
              <input ref={walkableRef} type="file" accept=".glb" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleColFile(f, 'walkable', 'manual'); e.target.value = ''; }} />
              <div className="ds-label" style={{ ...S.subTitle, marginTop: 10 }}><span className="ds-swatch" style={{ ...S.colorDot, background: '#ef4444' }} />BLOCK</div>
              <button onClick={() => blockRef.current?.click()} className={`${shellClass}`} style={S.fileBtn} disabled={busy}>
                {colLoading === 'block' ? '読み込み中…' : 'GLB ファイルを選択'}
              </button>
              <input ref={blockRef} type="file" accept=".glb" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleColFile(f, 'block', 'manual'); e.target.value = ''; }} />
            </Section>
              );
            })()}

            {/* ===== ウォークスルー (VR 360° 専用) — 密パノラマグリッド移動 (B3〜B6/C7) ===== */}
            {debugTab === 'plan' && isVRMode && (() => {
              const planForWalk = manifest?.plans?.find(p => p.id === activePlanId);
              const walkNodes = planForWalk?.walk?.nodes ?? [];
              const walkAssigned = walkNodes.filter(n => n.panorama).length;
              return (
                <Section title="ウォークスルー" subtitle="WALKTHROUGH" defaultOpen={false}>
                  <div className="ds-hint" style={{ marginBottom: 8 }}>
                    100枚超の360°画像をグリッド配置し、向いている方向へ「前進」して隣のノードへ移動する
                    ストリートビュー型ナビ。シーン一覧の視点とは独立です。
                  </div>
                  <InfoRow label="ノード数" value={`${walkNodes.length}（画像 ${walkAssigned}/${walkNodes.length}）`} />
                  <InfoRow label="開始ノード" value={planForWalk?.walk?.startNodeId ?? (walkNodes[0]?.id ?? '—')} mono />
                  <InfoRow label="隣接方式" value={planForWalk?.walk?.adjacency ?? 'grid4'} mono />
                  {planForWalk?.floorPlan?.image ? (
                    <button type="button" className={`${shellClass}`} style={S.fileBtn} onClick={() => setWalkEditorOpen(v => !v)}>
                      {walkEditorOpen ? '▼ エディタを閉じる' : '🗺 グリッドエディタを開く（画面下部）'}
                    </button>
                  ) : (
                    <div className="ds-hint">
                      図面画像が未設定です。「図面設定」で画像と bounds を設定するとグリッドエディタが使えます。
                    </div>
                  )}
                </Section>
              );
            })()}

            {/* ===== Floor Plan Config (アクティブプラン) ===== */}
            {debugTab === 'plan' && (() => {
              const activePlan = manifest?.plans?.find(p => p.id === activePlanId);
              const fp = activePlan?.floorPlan;
              return (
                <Section title="図面設定" subtitle="FLOOR PLAN" defaultOpen={false}>
                  <button onClick={() => fileInputRef.current?.click()} className={`${shellClass}`} style={S.fileBtn}>
                    {fp?.image ? '画像を変更' : '画像を選択'}（またはプレビューにドロップ）
                  </button>
                  <div className="ds-hint" style={{ marginTop: 6 }}>
                    対応形式: JPG / PNG / GIF / WebP / BMP / SVG / AVIF / HEIC / TIFF
                  </div>
                  {fp?.image && (
                    <div className={`${surfaceClass('plain')} ds-block ds-fill-surface`} style={S.floorPlanThumbWrap}>
                      <div className="ds-sticky-cover" style={S.floorPlanSticky}>
                      <div className="ds-well" style={S.floorPlanEditorWrap}>
                        <FloorPlanMiniMap
                          onViewpointClick={handleVpClick}
                          editable={true}
                          size={420}
                          style={S.floorPlanEditor}
                          onMapClick={(wx, wz) => {
                            if (activeVp) placeViewpointAt(activeVp, wx, wz);
                          }}
                          onMoveViewpoint={(id, wx, wz) => placeViewpointAt(id, wx, wz)}
                          onMoveViewpointEnd={() => { /* map-only: dragging the dot never moves the camera (use 📍 reflect) */ }}
                        />
                      </div>
                      <div className="ds-hint" style={{ marginTop: 4 }}>
                        ・<strong className="ds-warn">赤ピン</strong>（選択中の視点）— マップクリックで配置。<strong>初期位置</strong>は視点リストの 🏁 で指定<br />
                        ・他の視点のドットを直接ドラッグして移動も可<br />
                        ・扇形 = その視点の視野の向き（下の yaw スライダーで調整）
                      </div>
                      </div>{/* /floorPlanSticky */}

                      {/* 視点ごとの「向き (yaw)」編集 + 現在地に設定 */}
                      {(() => {
                        const vpsForEdit = activePlan?.viewpoints ?? [];
                        if (vpsForEdit.length === 0) return null;
                        return (
                          <div className="ds-well" style={S.vpPosList}>
                            {vpsForEdit.map((vp) => {
                              const isA = activeVp === vp.id;
                              const yawNow = Math.round(getViewpointYaw(vp));
                              return (
                                <div key={vp.id} style={S.vpYawRow}>
                                  <button
                                    type="button"
                                    onClick={() => handleVpClick(vp.id)}
                                    className={`${surfaceClass(isA ? 'accent' : 'plain')} ds-pill ds-pill--xs${isA ? '' : ' ds-fill-surface'}`}
                                    style={{ justifyContent: 'flex-start' }}
                                    title={isA ? '選択中（クリックでマップ配置可）' : 'クリックでこの視点を選択'}
                                  >
                                    {isA ? '◉' : '○'} {vp.label}
                                  </button>
                                  <div style={S.vpYawControls}>
                                    <input
                                      type="number"
                                      min={0}
                                      max={360}
                                      step={1}
                                      value={yawNow}
                                      onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (Number.isFinite(v)) setViewpointYaw(vp.id, ((v % 360) + 360) % 360);
                                      }}
                                      className="ds-input--compact"
                                      style={S.vpYawInput}
                                      title="向き (0–360°)"
                                    />
                                    <span className="ds-mono ds-sub" style={S.vpYawUnit}>°</span>
                                    <input
                                      type="range"
                                      min={0}
                                      max={360}
                                      step={1}
                                      value={yawNow}
                                      onChange={(e) => setViewpointYaw(vp.id, parseFloat(e.target.value))}
                                      style={S.vpYawSlider}
                                      title="向きを 0–360° で動かす"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => setViewpointYaw(vp.id, 0)}
                                      title="向きを 0° にリセット"
                                      className="ds-iconbtn"
                                      style={S.vpPosActionBtn}
                                    >
                                      ↺
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                      <button
                        type="button"
                        onClick={syncMapPositionsToCameraAnchors}
                        className={BTN}
                        title="MAP 上の dot 位置を、各視点の camera 位置 (position) に焼き込みます。古い視点 (= MAP ドラッグだけで配置してジャンプ先が同じ場所になってしまった視点) の一括移行に使用。target も同じ delta だけ平行移動して向きを保ちます。"
                      >
                        📍 MAP 位置で position を焼き直し
                      </button>
                      <button
                        type="button"
                        onClick={clearFloorPlan}
                        className={dangerPillClass}
                        style={{ alignSelf: 'flex-end' }}
                        title="図面画像を削除"
                      >
                        <IconTrash />削除
                      </button>
                    </div>
                  )}
                  {/* The image path and the bounds / offset / scale / rotation readout used
                      to be printed here. They are derived values the panel already lets you
                      set by direct manipulation, so on screen they were six rows of noise
                      under the thing they describe. */}
                  {!fp && <div className="ds-empty">このプランの図面はまだ設定されていません</div>}
                </Section>
              );
            })()}

            {/* ===== Environment (HDRI) — プランタブ最下部 ===== */}
            {debugTab === 'plan' && (
            <Section title="HDRI環境" subtitle="HDRI" defaultOpen={false}>
              <div className="ds-label" style={{ marginTop: 4, marginBottom: 4 }}>HDRI (360° 背景)</div>
              <button onClick={() => hdriInputRef.current?.click()} className={`${shellClass}`} style={S.fileBtn}>
                {hdriLoading ? '読み込み中…' : (hdriName || '画像ファイルを選択 (HDR / PNG / JPG)')}
              </button>
              <input ref={hdriInputRef} type="file" accept=".hdr,.png,.jpg,.jpeg" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleHdriFile(f); e.target.value = ''; }}
              />
              {hdriName && (
                <button onClick={handleHdriRemove} className={dangerPillClass}><IconTrash />HDRI を削除</button>
              )}

              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                <div className="ds-label" style={{ marginBottom: 4 }}>背景色</div>
                <div className="ds-hint" style={{ marginBottom: 8 }}>
                  HDRI 未設定時に見える背景の色。HDRI を読み込むとその裏側になります。
                </div>
                <StudioColorRow label="背景色" value={studioBgColor} onChange={setStudioBgColor} />
              </div>
            </Section>
            )}

            {/* ===== ピン (商品リンクタグ) — プランタブ。
                  ピンはプランデータの一部 (Plan.pins[]) なのでプランタブに置く。
                  Viewer での表示有無は ツールバー表示 → 「タグ」で切替。 */}
            {debugTab === 'plan' && (
              <PinsPlanSection
                pins={manifest?.plans?.find((p) => p.id === activePlanId)?.pins ?? []}
                activePlanId={activePlanId}
                activePlan={manifest?.plans?.find((p) => p.id === activePlanId)}
                smRef={smRef}
                moveTargetId={pinMoveTargetId}
                onStartMove={(pinId, placementId) => setPinMoveTargetId({ pinId, placementId })}
                onCancelMove={() => setPinMoveTargetId(null)}
              />
            )}

            {debugTab === 'video' && (
              <VideoTabPanel
                manifest={manifest}
                activePlanId={activePlanId}
                sceneId={sceneId}
                smRef={smRef}
                mode={videoMode}
                setMode={setVideoMode}
                keyframes={videoKeyframes}
                setKeyframes={setVideoKeyframes}
                fps={videoFps}
                setFps={setVideoFps}
                recState={videoRecState}
                setRecState={setVideoRecState}
                progress={videoProgress}
                setProgress={setVideoProgress}
                error={videoError}
                setError={setVideoError}
                freeRecState={freeRecState}
                setFreeRecState={setFreeRecState}
                freeRecCountdown={freeRecCountdown}
                setFreeRecCountdown={setFreeRecCountdown}
                freeRecElapsedMs={freeRecElapsedMs}
                setFreeRecElapsedMs={setFreeRecElapsedMs}
                library={videoLibrary}
                setLibrary={setVideoLibrary}
                selectedClipIds={selectedClipIds}
                setSelectedClipIds={setSelectedClipIds}
                concatRunning={concatRunning}
                setConcatRunning={setConcatRunning}
                concatProgress={concatProgress}
                setConcatProgress={setConcatProgress}
                trimStart={videoTrimStart}
                setTrimStart={setVideoTrimStart}
                trimEnd={videoTrimEnd}
                setTrimEnd={setVideoTrimEnd}
              />
            )}

            <div style={{ height: 20 }} />
        </div>

        {/* RIGHT: Full-height preview mirroring the Viewer */}
        <div
          ref={previewWrapRef}
          onDrop={e => {
            e.preventDefault();
            setIsDragOver(false);
            // Pin drop: タグ行を preview にドロップ → 今いる視点に **新しい配置を追加**。
            // 既存の配置はそのまま残るので、同じタグを複数視点・複数箇所に置ける。
            const pinId = e.dataTransfer.getData('application/x-pin-id');
            if (pinId) {
              const canvas = canvasRef.current;
              if (!canvas) return;
              const r = canvas.getBoundingClientRect();
              const cx = e.clientX - r.left;
              const cy = e.clientY - r.top;
              const sm = smRef.current;
              // Surface snap (B1): stick to the collision mesh under the cursor
              // (depth resolved automatically); floor plane is the fallback.
              const pos = sm && 'screenToScenePoint' in sm
                ? (sm as { screenToScenePoint: (x: number, y: number) => [number, number, number] | null }).screenToScenePoint(cx, cy)
                : null;
              if (pos) {
                const activeVpId = useCameraStore.getState().activeViewpoint;
                if (activeVpId) {
                  useSceneStore.getState().addPinPlacement(pinId, {
                    id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    viewpointId: activeVpId,
                    position: pos,
                  });
                }
              }
              return;
            }
            // File drop fallback (floor plan upload).
            const f = e.dataTransfer.files[0];
            if (f) handleFloorPlanFile(f);
          }}
          onDragOver={e => {
            e.preventDefault();
            // dropEffect must be compatible with the drag source's effectAllowed,
            // otherwise the browser shows a 🚫 cursor and blocks the drop. Pin
            // rows are 'copy' (drop = add new placement) so we mirror it here.
            if (e.dataTransfer.types.includes('application/x-pin-id')) {
              e.dataTransfer.dropEffect = 'copy';
            } else {
              setIsDragOver(true);
            }
          }}
          onDragLeave={() => setIsDragOver(false)}
          onClick={(e) => {
            if (!activePlanId || !pinMoveTargetId) return;
            // Move-mode click: resolve canvas-pixel coords, intersect floor,
            // update the targeted placement's position + bind to the active
            // viewpoint so it appears at this angle from now on.
            const canvas = canvasRef.current;
            if (!canvas) return;
            const r = canvas.getBoundingClientRect();
            const cx = e.clientX - r.left;
            const cy = e.clientY - r.top;
            const sm = smRef.current;
            // Surface snap (B1) — same resolver as drop-to-place.
            const pos = sm && 'screenToScenePoint' in sm
              ? (sm as { screenToScenePoint: (x: number, y: number) => [number, number, number] | null }).screenToScenePoint(cx, cy)
              : null;
            if (!pos) return;
            const activeVpId = useCameraStore.getState().activeViewpoint;
            if (!activeVpId) return;
            useSceneStore.getState().updatePinPlacement(pinMoveTargetId.pinId, pinMoveTargetId.placementId, { position: pos, viewpointId: activeVpId });
            setPinMoveTargetId(null);
          }}
          className="ds-preview"
          data-drag={isDragOver || undefined}
          style={pinMoveTargetId ? { cursor: 'crosshair' } : undefined}
        >
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          <ApiKeySettings />
          <AiScreenOverlay />
          <AiGeneratingOverlay />
          <FpsOverlay />
          <ScenePinsOverlay containerRef={previewWrapRef} editable />
          {/* 俯瞰コリジョン編集 — GS を断面表示して直接なぞるモード */}
          {topDownColOpen && (() => {
            const planForCol = manifest?.plans?.find(p => p.id === activePlanId);
            const closeTopDown = () => {
              const sm = smRef.current;
              if (sm && 'exitTopDownView' in sm) (sm as unknown as { exitTopDownView: () => void }).exitTopDownView();
              setTopDownColOpen(false);
            };
            return (
              <TopDownCollisionEditor
                getManager={() => {
                  const sm = smRef.current;
                  return sm && 'enterTopDownView' in sm ? (sm as unknown as TopDownManager) : null;
                }}
                walls={planForCol?.collision?.walls}
                onChange={(w) => { if (activePlanId) setPlanCollisionWallsStore(activePlanId, w); }}
                onGenerate={handleGenerateWalls}
                generating={colLoading === 'walls'}
                initialSliceY={(planForCol?.collision?.walls?.floorY ?? 0) + 1.2}
                onClose={closeTopDown}
              />
            );
          })()}
          {debugTab === 'video' && (
            <VideoOverlay
              freeRecState={freeRecState}
              freeRecCountdown={freeRecCountdown}
              freeRecElapsedMs={freeRecElapsedMs}
              recState={videoRecState}
            />
          )}
          {isLoading && <LoadingScreen />}
          {error && (
            <div className={`${surfaceClass('danger')} ds-overlay ds-overlay--card`} style={S.errorBox}>
              <div className="ds-title" style={{ marginBottom: 6 }}>読み込みエラー</div>
              <div className="ds-sub">{error}</div>
            </div>
          )}
          {ready && !isLoading && !error && (
            <>
              <AmbientAudio />
              <FootstepAudio />
              <ViewerOverlay
                sceneId={sceneId}
                onViewpointClick={handleVpClick}
                showDebugLink={false}
                enableViewpointShortcuts={false}
                hideLeftPanel={debugTab === 'video'}
                onPlanSwitch={(planId) => { void smRef.current?.setActivePlan(planId); }}
              />
              <WalkthroughControls getManager={() => smRef.current} />
            </>
          )}
          {isDragOver && (
            <div className="ds-dropveil"><span>画像をドロップして図面を設定</span></div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg,.avif,.heic,.heif,.tif,.tiff"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFloorPlanFile(f); e.target.value = ''; }}
          />
        </div>
      </div>
      <input
        ref={panoInputRef}
        type="file"
        accept=".hdr,.exr,.png,.jpg,.jpeg,image/*"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0];
          const id = panoTargetVp;
          if (f && id) handlePanoFile(f, id);
          setPanoTargetVp(null);
          e.target.value = '';
        }}
      />
      {/* The "画像ファイルからサムネを設定" picker was removed along with its
          button. `setViewpointManualThumb` in the store is untouched, so
          restoring it is putting the button and this input back. */}
      <input
        ref={planSplatInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={e => {
          const fs = e.target.files;
          const id = planSplatTargetId;
          if (fs && fs.length > 0 && id) void handlePlanSplatFiles(fs, id);
          setPlanSplatTargetId(null);
          e.target.value = '';
        }}
      />
      <input
        ref={addVpPanoInputRef}
        type="file"
        accept=".hdr,.exr,.png,.jpg,.jpeg,image/*"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) { setAddVpPanoFile(f); setAddVpPanoName(f.name); }
          e.target.value = '';
        }}
      />
      {/* ウォークスルー グリッドエディタ (C7) — createPortal で body 直下に出る下部ドック */}
      {walkEditorOpen && isVRMode && (() => {
        const planForWalk = manifest?.plans?.find(p => p.id === activePlanId);
        if (!planForWalk?.floorPlan?.image || !manifest) return null;
        return (
          <WalkGraphEditor
            sceneId={manifest.id}
            plan={planForWalk}
            floorPlan={planForWalk.floorPlan}
            cameraHeight={manifest.settings.cameraHeight ?? 1.6}
            onChange={(walk) => { if (activePlanId) setPlanWalkStore(activePlanId, walk); }}
            onPreviewNode={(node: WalkNode) => {
              void smRef.current?.showPanoramaPreview(node.panorama ?? walkPlaceholderPanorama(node)).then((ok) => {
                // Assigned image failed (e.g. dangling idb: ref) — show the
                // direction-guide placeholder instead of leaving the old view.
                if (!ok && node.panorama) void smRef.current?.showPanoramaPreview(walkPlaceholderPanorama(node));
              });
            }}
            onClose={() => setWalkEditorOpen(false)}
          />
        );
      })()}
    </div>
  );
}

// ----- subcomponents -----

/**
 * リンクトグル — Debug の PLAN 切替ピル列の右端に置く。ON にしてプランを切り替えると
 * SceneManager.setActivePlan は新プランの最初の視点へジャンプせず **現在のカメラ位置を保持**。
 * 用途: 同じ部屋の昼/夜プランを別 PLY で持っているとき、同じ立ち位置で照明だけ比較したい。
 */
function PlanCameraLinkToggle() {
  const linkPlanCamera = useUIStore((s) => s.linkPlanCamera);
  const setLinkPlanCamera = useUIStore((s) => s.setLinkPlanCamera);
  return (
    <button
      type="button"
      onClick={() => setLinkPlanCamera(!linkPlanCamera)}
      className={`${surfaceClass(linkPlanCamera ? 'accent' : 'plain')} ds-pill ds-pill--icon ds-pill--xs${linkPlanCamera ? '' : ' ds-fill-surface'}`}
      style={{ marginLeft: 'auto' }}
      title={linkPlanCamera
        ? 'カメラ位置を保持してプラン切替中 (クリックで OFF)'
        : 'プラン切替時にカメラ位置を保持しない (クリックで ON: 同じ場所で昼夜比較に便利)'}
    >
      {linkPlanCamera ? '🔗' : '⛓'}
    </button>
  );
}

/**
 * Multi-channel publish notification: desktop notification (if granted) +
 * tab-title prefix + a short beep. The user wanted to walk away while a
 * 100MB+ upload runs and come back to a clear "done" signal.
 */
const ORIGINAL_TITLE = typeof document !== 'undefined' ? document.title : '';

function setTitlePrefix(prefix: string) {
  if (typeof document === 'undefined') return;
  document.title = prefix ? `${prefix} ${ORIGINAL_TITLE}` : ORIGINAL_TITLE;
}

function focusListener() {
  // Restore the title once the user comes back to the tab.
  setTitlePrefix('');
  window.removeEventListener('focus', focusListener);
}

function beep(durationMs = 200, freq = 880) {
  try {
    const W = window as unknown as { webkitAudioContext?: typeof AudioContext };
    const Ctx = window.AudioContext ?? W.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, durationMs);
  } catch { /* ignore — sound is best-effort */ }
}

function notifyPublishDone(sceneId: string, url: string, elapsedMs: number) {
  const sec = (elapsedMs / 1000).toFixed(1);
  const title = '✓ 公開完了';
  const body = `${sceneId} を ${sec}s で公開しました\n${url}`;
  setTitlePrefix('(✓ 公開完了)');
  window.addEventListener('focus', focusListener);
  beep(180, 880);
  setTimeout(() => beep(180, 1320), 220);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: `publish-${sceneId}` });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore — notification is best-effort */ }
  }
}

function notifyPublishError(sceneId: string, msg: string) {
  setTitlePrefix('(× 公開失敗)');
  window.addEventListener('focus', focusListener);
  beep(120, 220);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('× 公開失敗', { body: `${sceneId}: ${msg}`, tag: `publish-error-${sceneId}` });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  }
}

/**
 * "公開する" button — uploads the current scene + assets to R2 via the
 * Worker's /api/publish/* endpoint. Opens a small status overlay during the
 * upload and shows the customer-facing URL when done.
 */
function PublishButton({ sceneId, manifest }: { sceneId: string; manifest: { id?: string; plans?: unknown[] } | null }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ message: string; current: number; total: number } | null>(null);
  const [doneUrl, setDoneUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (!manifest?.id) { setError('シーンが読み込まれていません'); return; }
    setError(null);
    setDoneUrl(null);
    setBusy(true);
    // Ask for desktop-notification permission proactively. Browsers ignore the
    // request if the user already decided (granted / denied), so it's safe to
    // call every time.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    const startedAt = Date.now();
    try {
      await publishScene(manifest as never, (p) => setProgress(p));
      const url = `${window.location.origin}/viewer/${sceneId}`;
      setDoneUrl(url);
      useProjectStore.getState().updateProject(sceneId, { publishedAt: Date.now() });
      notifyPublishDone(sceneId, url, Date.now() - startedAt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      notifyPublishError(sceneId, msg);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // Share-login users can't publish (publish/R2 is admin-only on the Worker).
  if (getAuthRole() !== 'admin') return null;

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title="現在のシーンを R2 に公開して、顧客が URL でアクセスできるようにする"
        className={`${surfaceClass(busy ? 'neutral' : 'success')} ds-pill ds-pill--sm`}
        style={{ marginRight: 6 }}
      >
        {busy ? '公開中…' : '🚀 公開'}
      </button>
      {(busy || doneUrl || error) && createPortal(
        <div
          className={`${surfaceClass('plain')} ds-dialog ds-fill-surface`}
          style={{ position: 'fixed', top: 70, right: 16, zIndex: 9999, width: 360 }}
        >
          {busy && progress && (
            <>
              <div className="ds-field-label" style={{ marginBottom: 6 }}>公開中…</div>
              <div className="ds-hint" style={{ marginBottom: 6 }}>
                {progress.message}
                <span className="ds-faint" style={{ marginLeft: 6 }}>{progress.current}/{progress.total}</span>
              </div>
              <div className="ds-progress">
                <div
                  className="ds-progress__fill"
                  style={{ width: `${Math.round((progress.current / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
            </>
          )}
          {!busy && doneUrl && (
            <>
              <div className="ds-field-label ds-ok" style={{ marginBottom: 8 }}>✓ 公開完了</div>
              <div className="ds-hint" style={{ marginBottom: 6 }}>顧客に送る URL:</div>
              <input
                readOnly
                value={doneUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="ds-input ds-input--compact ds-mono"
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(doneUrl)}
                  className={`${surfaceClass('accent')} ds-pill ds-pill--xs`}
                  style={{ flex: 1 }}
                >コピー</button>
                <button
                  type="button"
                  onClick={() => setDoneUrl(null)}
                  className={`${surfaceClass('plain')} ds-pill ds-pill--xs ds-fill-surface`}
                >閉じる</button>
              </div>
            </>
          )}
          {!busy && error && (
            <>
              <div className="ds-field-label ds-warn" style={{ marginBottom: 6 }}>公開失敗</div>
              <div className="ds-hint" style={{ marginBottom: 8, wordBreak: 'break-word' }}>{error}</div>
              <button
                type="button"
                onClick={() => setError(null)}
                className={`${surfaceClass('plain')} ds-pill ds-pill--xs ds-fill-surface`}
              >閉じる</button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── プランタブ: シーンピン (商品リンクタグ) ────────────────────────────
//
// Pin annotations anchored to 3D world positions. Authoring lives here in
// the debug UI's Plan tab; rendering lives in `ScenePinsOverlay.tsx`. Each
// pin row edits one `Plan.pins[]` entry and writes through the scene-store
// helpers so HMR / IDB autosave catches changes like every other field.

type AnyManagerRef = React.MutableRefObject<{
  worldToScreen?: (w: [number, number, number]) => { x: number; y: number } | null;
  getCameraForwardPoint?: (d?: number) => [number, number, number];
  jumpToPose?: (pose: import('../core/types').CameraPose) => void;
  screenToFloorPoint?: (canvasX: number, canvasY: number) => [number, number, number] | null;
} | null>;

function PinsPlanSection({
  pins,
  activePlanId,
  activePlan,
  smRef,
  moveTargetId,
  onStartMove,
  onCancelMove,
}: {
  pins: import('../core/types').ScenePin[];
  activePlanId: string | null;
  activePlan: import('../core/types').Plan | undefined;
  smRef: AnyManagerRef;
  /** { pinId, placementId } currently in move-mode (next canvas click updates that placement). */
  moveTargetId: { pinId: string; placementId: string } | null;
  /** Enter move-mode for a specific placement. */
  onStartMove: (pinId: string, placementId: string) => void;
  /** Cancel the move-mode without changing the placement. */
  onCancelMove: () => void;
}) {
  const addPin = useSceneStore((s) => s.addPin);
  const removePin = useSceneStore((s) => s.removePin);
  const updatePin = useSceneStore((s) => s.updatePin);
  const removePinPlacement = useSceneStore((s) => s.removePinPlacement);
  const updatePinPlacement = useSceneStore((s) => s.updatePinPlacement);
  const activeViewpoint = useCameraStore((s) => s.activeViewpoint);
  // 「この視点で見えている配置だけ表示」フィルタ (B1)。placements は viewpointId に
  // 束縛されているので、多視点で同じタグを使い回すとリストが膨らむ — 既定 ON で
  // 今のアングルの分だけに絞る。
  const [onlyCurrentVp, setOnlyCurrentVp] = useState(true);
  // Dropping the picker on a pin row uploads a thumbnail image as a base64
  // data URL. Keep the `<input type=file>` ref-bound so the click can be
  // triggered programmatically from the row's button.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileTargetRef = useRef<string | null>(null);
  // Per-pin expand/collapse — many pins clutter the panel fast, so default
  // is collapsed. Multiple pins can be open simultaneously.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const togglePin = (id: string) => setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const handleImageFile = (file: File) => {
    const id = fileTargetRef.current;
    if (!id) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      if (typeof data === 'string') updatePin(id, { image: data });
    };
    reader.readAsDataURL(file);
  };

  if (!activePlanId) {
    return (
      <Section title="タグ" subtitle="PINS" defaultOpen={true}>
        <div className="ds-empty">プランが選択されていません</div>
      </Section>
    );
  }

  return (
    <Section
      title={`タグ (${pins.length})`}
      subtitle="PINS"
      defaultOpen={true}
      action={(
        <button
          type="button"
          onClick={() => {
            // 「+ タグを追加」は metadata だけのタグをリストに追加。位置と視点は
            // 未設定のまま — 後でリスト行をプレビューにドラッグするか 📍 で配置する。
            const newId = `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            addPin({ id: newId, title: '新しいタグ' });
          }}
          className={BTN_PRIMARY}
          title="タグをリストに追加 (配置はあとからドラッグ or 📍 で)"
        >
          + タグを追加
        </button>
      )}
    >
      {moveTargetId && (
        <div className={`${surfaceClass('success')} ds-panel`} style={pinPlacementBanner}>
          ✏️ 位置変更モード中 — プレビューをクリックでピンを移動 (Esc で解除)
        </div>
      )}

      <label className="ds-check" style={{ marginBottom: 8 }}
        title="配置一覧を、今表示中の視点に束縛された配置だけに絞ります">
        <input type="checkbox" checked={onlyCurrentVp} onChange={(e) => setOnlyCurrentVp(e.target.checked)} />
        この視点の配置のみ表示
      </label>

      {pins.length === 0 ? (
        <div className="ds-empty">まだタグが追加されていません</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pins.map((pin, idx) => {
            const isExpanded = expandedIds.has(pin.id);
            const placements = getPinPlacements(pin);
            const placementCount = placements.length;
            return (
            <div
              key={pin.id}
              className={`${surfaceClass('plain')} ds-panel ds-fill-surface`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-pin-id', pin.id);
                e.dataTransfer.effectAllowed = 'copy';
                const ghost = document.createElement('canvas');
                ghost.width = 1; ghost.height = 1;
                e.dataTransfer.setDragImage(ghost, 0, 0);
              }}
            >
              {/* 折りたたみヘッダ — クリックで開閉。タイトル空のときは "タグN" にフォールバック。 */}
              <button
                type="button"
                onClick={() => togglePin(pin.id)}
                className="ds-section__toggle"
                style={pinHeaderRow}
                title={isExpanded ? '折りたたむ' : '展開して編集'}
              >
                <span className="ds-section__chevron" style={pinHeaderChevron}>{isExpanded ? '▼' : '▶'}</span>
                <span className="ds-title" style={pinHeaderTitle}>
                  タグ{idx + 1}：{pin.title || '(無題)'}
                </span>
                <span className="ds-hint" style={pinHeaderHint}>
                  {placementCount > 0 ? `配置：${placementCount}箇所` : '未配置 — ドラッグで配置'}
                </span>
              </button>

              {!isExpanded ? null : (
              <>
              <div style={{ height: 8 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <input
                  type="text"
                  value={pin.title}
                  onChange={(e) => updatePin(pin.id, { title: e.target.value })}
                  placeholder="タイトル (例: ソファ)"
                  style={{ ...S.input, flex: 1 }}
                />
                <button
                  type="button"
                  title="このタグを複製 (metadata だけコピー、配置は新規)"
                  onClick={() => {
                    const newId = `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                    addPin({
                      id: newId,
                      title: pin.title,
                      comment: pin.comment,
                      url: pin.url,
                      image: pin.image,
                    });
                  }}
                  className="ds-iconbtn"
                >📄</button>
                <button
                  type="button"
                  title="このタグを完全削除 (すべての配置も消える)"
                  onClick={() => removePin(pin.id)}
                  className={dangerIconClass}
                ><IconTrash /></button>
              </div>

              <textarea
                value={pin.comment ?? ''}
                onChange={(e) => updatePin(pin.id, { comment: e.target.value })}
                placeholder="コメント (任意 / 複数行)"
                rows={2}
                className="ds-textarea"
                style={{ minHeight: 48 }}
              />
              <div style={{ height: 6 }} />
              <input
                type="url"
                value={pin.url ?? ''}
                onChange={(e) => updatePin(pin.id, { url: e.target.value })}
                placeholder="URL (https://… 商品ページなど)"
                style={S.input}
              />

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                {pin.image ? (
                  <img src={pin.image} alt="" className="ds-thumb" style={pinThumbStyle} />
                ) : (
                  <div className="ds-thumb ds-faint" style={{ ...pinThumbStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    🖼
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <button
                    type="button"
                    onClick={() => { fileTargetRef.current = pin.id; fileInputRef.current?.click(); }}
                    className={`${surfaceClass('neutral')} ds-pill ds-pill--xs ds-fill-neutral`}
                  >
                    {pin.image ? '画像を差し替え' : '+ 画像を追加'}
                  </button>
                  {pin.image && (
                    <button
                      type="button"
                      onClick={() => updatePin(pin.id, { image: undefined })}
                      className={dangerPillClass}
                    ><IconTrash />画像を削除</button>
                  )}
                </div>
              </div>

              {(() => {
                const visiblePlacements = onlyCurrentVp
                  ? placements.filter((pl) => pl.viewpointId === activeViewpoint)
                  : placements;
                return (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                <div className="ds-label" style={{ marginBottom: 6 }}>
                  配置一覧 ({onlyCurrentVp ? `この視点 ${visiblePlacements.length} / 全 ${placementCount}` : `${placementCount}箇所`})
                  {placementCount === 0 && <span className="ds-sub ds-faint" style={{ marginLeft: 8 }}>未配置 — タイトル行をドラッグでプレビューに配置</span>}
                  {placementCount > 0 && visiblePlacements.length === 0 && (
                    <span className="ds-sub ds-faint" style={{ marginLeft: 8 }}>この視点への配置なし（フィルタ解除で全表示）</span>
                  )}
                </div>
                {visiblePlacements.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {visiblePlacements.map((pl) => {
                      const vpLabel = activePlan?.viewpoints.find((v) => v.id === pl.viewpointId)?.label ?? '不明な視点';
                      const isMoving = moveTargetId?.pinId === pin.id && moveTargetId?.placementId === pl.id;
                      // 数値微調整: 各軸を STEP ずつ加減 or 直接入力。position は
                      // タプルなので複製してから該当軸だけ書き換えて updatePinPlacement。
                      const NUDGE_STEP = 0.05;
                      const setAxis = (axis: 0 | 1 | 2, value: number) => {
                        const next = [...pl.position] as [number, number, number];
                        next[axis] = value;
                        updatePinPlacement(pin.id, pl.id, { position: next });
                      };
                      const nudge = (axis: 0 | 1 | 2, delta: number) => {
                        setAxis(axis, +(pl.position[axis] + delta).toFixed(3));
                      };
                      // 視点ローカル微調整 (B1): 今カメラが向いている方向を基準に
                      // 左右/前後(水平)/上下 で動かす。ワールド XYZ を頭の中で
                      // 回転させなくて済むので直感的。yaw はクリック時に読む。
                      const nudgeLocal = (kind: 'lr' | 'ud' | 'fb', sign: 1 | -1) => {
                        const step = NUDGE_STEP * sign;
                        const yawRad = useCameraStore.getState().yaw * Math.PI / 180;
                        // カメラ規約: forward = (-sin, -cos), right = (cos, -sin) (XZ)
                        const d: [number, number, number] = kind === 'ud'
                          ? [0, step, 0]
                          : kind === 'fb'
                            ? [-Math.sin(yawRad) * step, 0, -Math.cos(yawRad) * step]
                            : [Math.cos(yawRad) * step, 0, -Math.sin(yawRad) * step];
                        updatePinPlacement(pin.id, pl.id, {
                          position: [
                            +(pl.position[0] + d[0]).toFixed(3),
                            +(pl.position[1] + d[1]).toFixed(3),
                            +(pl.position[2] + d[2]).toFixed(3),
                          ],
                        });
                      };
                      return (
                        <div key={pl.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div className="ds-well" style={placementRowStyle}>
                          <span className="ds-title" style={placementVpLabel}>{vpLabel}</span>
                          <button
                            type="button"
                            title={isMoving ? 'クリックして位置変更モードを解除' : 'プレビューをクリックでこの配置の位置を変更'}
                            onClick={() => isMoving ? onCancelMove() : onStartMove(pin.id, pl.id)}
                            className={isMoving ? `${surfaceClass('accent')} ds-pill ds-pill--icon ds-pill--xs` : 'ds-iconbtn'}
                          >📍</button>
                          <button
                            type="button"
                            title="この配置位置にジャンプ"
                            onClick={() => {
                              const p = pl.position;
                              smRef.current?.jumpToPose?.({
                                position: [p[0], p[1] + 1.2, p[2] + 1.5],
                                target: p,
                                fov: 60,
                              });
                            }}
                            className="ds-iconbtn"
                          >🎯</button>
                          <button
                            type="button"
                            title="この配置だけ削除 (タグ自体は残る)"
                            onClick={() => removePinPlacement(pin.id, pl.id)}
                            className={dangerIconClass}
                          ><IconClose /></button>
                        </div>
                        {/* 数値微調整 (X/Y/Z を ±0.05m ずつ、または直接入力) */}
                        <div style={placementNudgeRow}>
                          {(['X', 'Y', 'Z'] as const).map((label, axis) => (
                            <div key={label} style={nudgeAxisGroup}>
                              <span className="ds-label" style={nudgeAxisLabel}>{label}</span>
                              <button
                                type="button"
                                title={`${label} を -${NUDGE_STEP}m`}
                                onClick={() => nudge(axis as 0 | 1 | 2, -NUDGE_STEP)}
                                className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-fill-surface`}
                                style={nudgeBtn}
                              >−</button>
                              <input
                                type="number"
                                step={NUDGE_STEP}
                                value={pl.position[axis]}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value);
                                  if (Number.isFinite(v)) setAxis(axis as 0 | 1 | 2, v);
                                }}
                                className="ds-input--compact"
                                style={nudgeInput}
                                title={`${label} 座標 (m)`}
                              />
                              <button
                                type="button"
                                title={`${label} を +${NUDGE_STEP}m`}
                                onClick={() => nudge(axis as 0 | 1 | 2, NUDGE_STEP)}
                                className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-fill-surface`}
                                style={nudgeBtn}
                              >＋</button>
                            </div>
                          ))}
                        </div>
                        {/* 視点ローカル微調整 (B1): カメラの向き基準で 左右/上下/前後 */}
                        <div style={placementNudgeRow}>
                          <span className="ds-label" style={{ ...nudgeAxisLabel, minWidth: 46 }} title="今の視点の向きを基準に動かします">視点基準</span>
                          {([
                            ['lr', '←', -1, '左へ'], ['lr', '→', 1, '右へ'],
                            ['ud', '↓', -1, '下へ'], ['ud', '↑', 1, '上へ'],
                            ['fb', '－', -1, '手前へ (カメラ側)'], ['fb', '＋', 1, '奥へ'],
                          ] as ['lr' | 'ud' | 'fb', string, 1 | -1, string][]).map(([kind, glyph, sign, tip], i) => (
                            <button
                              key={i}
                              type="button"
                              title={`${tip} ${NUDGE_STEP}m`}
                              onClick={() => nudgeLocal(kind, sign)}
                              className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-fill-surface`}
                              style={nudgeBtn}
                            >{glyph}</button>
                          ))}
                        </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
                );
              })()}
              </>
              )}
            </div>
            );
          })}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImageFile(f);
          e.target.value = '';
          fileTargetRef.current = null;
        }}
      />
    </Section>
  );
}

/* Size only — the frame and the empty-slot fill come from `.ds-thumb`. */
const pinThumbStyle: React.CSSProperties = {
  width: 56,
  height: 56,
  flexShrink: 0,
};

/* Layout only from here — appearance comes from the `.ds-*` classes applied at
 * the call sites (`.ds-section__toggle` header, `.ds-well` placement row,
 * `.ds-title` / `.ds-hint` for the type).
 *
 * `.ds-section__toggle` rather than `.ds-rowbtn`: the latter carries a bottom
 * divider and its own padding, which inside a pin card would draw a line that
 * belongs to a different component. */
const pinHeaderRow: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  textAlign: 'left' as const,
};

const pinHeaderChevron: React.CSSProperties = { width: 12, flexShrink: 0 };

const pinHeaderTitle: React.CSSProperties = {
  flex: 1,
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
};

const pinHeaderHint: React.CSSProperties = { flexShrink: 0 };

const placementRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 6px',
};

const placementVpLabel: React.CSSProperties = {
  flex: 1,
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
};

const placementNudgeRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  padding: '0 6px 2px',
};

const nudgeAxisGroup: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flex: 1,
};

const nudgeAxisLabel: React.CSSProperties = { width: 10, flexShrink: 0 };

const nudgeBtn: React.CSSProperties = { width: 18, height: 18, flexShrink: 0 };

const nudgeInput: React.CSSProperties = { width: '100%', minWidth: 0, textAlign: 'center' as const };

const pinPlacementBanner: React.CSSProperties = { padding: '8px 10px', marginBottom: 10 };

/**
 * FPS overlay shown only inside the Debug preview pane (not in the public Viewer).
 * Reads `useUIStore.fps` which is updated ~5 Hz from the SceneManager's `update`
 * callback. Hidden when the splat hasn't loaded (= fps still 0) so the placeholder
 * doesn't flash during scene init.
 */
function FpsOverlay() {
  const fps = useUIStore((s) => s.fps);
  if (fps <= 0) return null;
  return <div className="ds-hud" style={fpsOverlayStyle}>FPS {fps}</div>;
}
const fpsOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 50,
  pointerEvents: 'none',
};

function SaveIndicator({ state, lastSavedAt, onClick }: {
  state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  lastSavedAt: number | null;
  onClick: () => void;
}) {
  const fmt = (t: number) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };
  // The text colour is uniformly `tokens.color.text` now (status is conveyed
  // by the dot colour, not by tinting the label). Keeping just the dot.
  let label = '保存';
  let dot = COLOR.textMute;
  if (state === 'saving') { label = '保存中…'; dot = COLOR.accent; }
  else if (state === 'dirty') { label = '未保存の変更'; dot = COLOR.warn; }
  else if (state === 'saved') { label = `保存済 ${lastSavedAt ? fmt(lastSavedAt) : ''}`; dot = COLOR.ok; }
  else if (state === 'error') { label = '保存エラー（クリックで再試行）'; dot = COLOR.danger; }
  else { label = '未保存'; }

  return (
    <button
      type="button"
      onClick={onClick}
      title="今すぐ IndexedDB に保存します（ブラウザを閉じても残ります）"
      className={`${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface`}
      style={{ gap: 8 }}
    >
      {/* The dot's colour IS the state, so it stays a value rather than a class. */}
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, boxShadow: `0 0 6px ${dot}`, flexShrink: 0 }} />
      {label}
    </button>
  );
}

function Section({ title, subtitle, action, children, defaultOpen = true }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`${surfaceClass('plain')} ds-section ds-fill-surface`} data-open={open || undefined}>
      <header className="ds-section__head">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="ds-section__toggle"
          aria-expanded={open}
        >
          {/* Rotation is state, so it stays inline; everything else is in the class. */}
          <span className="ds-section__chevron" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          <span className="ds-section__title">{title}</span>
          {subtitle && <span className="ds-section__sub">{subtitle}</span>}
        </button>
        {open && action}
      </header>
      {open && <div className="ds-section__body">{children}</div>}
    </section>
  );
}

/** `accent` is an AXIS colour (X/Y/Z red-green-blue), i.e. data — it stays at
 *  the call site rather than becoming a variant. */
function KV({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className={`${surfaceClass('neutral')} ds-panel ds-fill-neutral`} style={S.kvCell}>
      <div className="ds-label" style={{ marginBottom: 2, ...(accent ? { color: accent } : null) }}>{label}</div>
      <div className="ds-mono" style={S.kvVal}>{value}</div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="ds-sub" style={S.infoRow}>
      <div style={S.infoLabel}>{label}</div>
      <div className={mono ? 'ds-mono' : undefined} style={S.infoVal}>{value}</div>
    </div>
  );
}

function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="ds-label">{label}</span>
      <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={S.formInput} />
    </label>
  );
}

/** Small checkbox row for the 物件概要 visibility toggles. */
function VisRow({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (c: boolean) => void; disabled?: boolean }) {
  return (
    <label className="ds-check" data-disabled={disabled || undefined} style={{ display: 'flex' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Top-level toolbar visibility section. Defining this outside the parent's render tree
 * (instead of inline as an IIFE that captures `tb` / `setTb`) is what fixes the flicker
 * the user hit before — the parent re-renders frequently as live camera position
 * updates flow into the store, and an inline-defined component would be unmounted /
 * remounted on every one of those, eating the user's mouse events.
 */
type ToolbarKey = 'type' | 'overview' | 'viewpoints' | 'color' | 'map' | 'audio' | 'fullscreen' | 'movement' | 'demo' | 'quality' | 'aiGenerate' | 'pins';
type ToolbarOrderPatch = { order?: OrderableSidebarBlock[] };
type SidebarSizeOpt = 'large' | 'small';
type ToolbarPatch = Partial<Record<ToolbarKey, boolean>> & { size?: SidebarSizeOpt } & ToolbarOrderPatch;

function ViewerToolbarSection({
  tb,
  isOtherProject,
  isVRMode,
  variants,
  onChange,
  onReset,
  onToggleVariant,
}: {
  tb: Partial<Record<ToolbarKey, boolean>> & { size?: SidebarSizeOpt; order?: OrderableSidebarBlock[] };
  isOtherProject: boolean;
  isVRMode: boolean;
  variants?: { furniture?: boolean; lighting?: boolean };
  onChange: (patch: ToolbarPatch) => void;
  onReset: () => void;
  onToggleVariant: (k: 'furniture' | 'lighting') => void;
}) {
  return (
    <Section
      title="ツールバー表示"
      subtitle="VIEWER TOOLBAR"
      defaultOpen={false}
      action={<button onClick={onReset} className={BTN} title="すべて表示 (既定) に戻す">既定に戻す</button>}
    >
      <div className="ds-hint" style={{ marginBottom: 8 }}>
        ビューアに出す項目を選びます。チェックを外すと閲覧者にも非表示になります。<br />
        薄く表示されている項目は、現在のプロジェクト種別 / モードでは元から出ない項目です。
      </div>

      <div className="ds-label" style={S.toolbarGroupHead}>サイドバーサイズ</div>
      {/* Default is "small" — fits more content on the screen and avoids the
          empty bottom that "large" leaves on short panels. */}
      <PillToggle
        value={tb.size ?? 'small'}
        onChange={(size) => onChange({ size })}
        options={[
          { value: 'small', title: '小', sub: '内容の高さ分のみ (既定)' },
          { value: 'large', title: '大', sub: '全高表示' },
        ]}
        style={{ marginTop: 4 }}
      />
      <div className="ds-hint" style={{ marginTop: 6 }}>
        どちらも幅は 320px。「小」は表示中のセクション分だけ縦に伸びます。
      </div>

      <div className="ds-label" style={S.toolbarGroupHead}>サイドバー</div>
      {/* A grid, because `.ds-check` is inline-flex: written one per line in
          JSX, the rows still flowed as inline boxes and wrapped wherever the
          text ran out, so no two checkboxes lined up. The cells hold a column
          each — one column in the 320px sidebar, more when the panel is wide. */}
      <div style={S.toolbarGrid}>
        <ToolbarRow tb={tb} keyName="type"       label={isOtherProject && !isVRMode ? '場所 (プラン切替)' : 'タイプ (プラン切替)'} hint="— 既定 OFF" defaultOff onChange={onChange} />
        {/* 間取り / カラーは「その他」プロジェクトでは概念的に存在しないので
            DOM ごと出さない (grayed out で残しておくと UI のノイズ)。 */}
        {!isOtherProject && (
          <ToolbarRow tb={tb} keyName="overview"   label="間取り概要" hint="— 既定 OFF" defaultOff onChange={onChange} />
        )}
        <ToolbarRow tb={tb} keyName="viewpoints" label="シーン" hint="— 既定 OFF" defaultOff onChange={onChange} />
        {!isOtherProject && (
          <ToolbarRow tb={tb} keyName="color"      label="カラー (素材バリエーション)" hint="— 既定 OFF" defaultOff onChange={onChange} />
        )}
        <ToolbarRow tb={tb} keyName="aiGenerate" label="AI 画像生成" hint="— 既定 OFF" defaultOff onChange={onChange} />
        <ToolbarRow tb={tb} keyName="map"        label={isOtherProject ? 'MAP' : 'FLOOR MAP'} hint="— 既定 OFF" defaultOff onChange={onChange} />
        <ToolbarRow tb={tb} keyName="pins"       label="タグ (3D ピン / リンク付き)" hint="— 既定 OFF" defaultOff onChange={onChange} />
      </div>

      <div className="ds-label" style={S.toolbarGroupHead}>オーバーレイ / アイコン</div>
      {/* 環境音 (BGM) と ヘッドトラッキングはパノラマでも使える ─ enable 状態のままにする。
          移動モード切替・画質プリセットは 3DGS 専用なので VR モードでは行ごと非表示。 */}
      <div style={S.toolbarGrid}>
        <ToolbarRow tb={tb} keyName="audio"      label="環境音アイコン (タイトル右)" hint="— 既定 OFF" defaultOff onChange={onChange} />
        <ToolbarRow tb={tb} keyName="fullscreen" label="フルスクリーンアイコン" hint="— 既定 OFF" defaultOff onChange={onChange} />
        {!isVRMode && (
          <ToolbarRow tb={tb} keyName="movement"   label="移動モード切替 (歩く / フライ)" hint="— 既定 OFF" defaultOff onChange={onChange} />
        )}
        {!isVRMode && (
          <ToolbarRow tb={tb} keyName="quality"    label="画質 (LOW / MID / HIGH)" hint="— 既定 ON" onChange={onChange} />
        )}
        <ToolbarRow tb={tb} keyName="demo"       label="ヘッドトラッキング" hint="— 既定 OFF" defaultOff onChange={onChange} />
      </div>

      {!isOtherProject && (
        <>
          <div className="ds-label" style={S.toolbarGroupHead}>カラー内のサブ操作 (mansion)</div>
          <div style={S.toolbarGrid}>
            <label className="ds-check" style={S.toolbarRow}>
              <input
                type="checkbox"
                checked={!!variants?.furniture}
                onChange={() => onToggleVariant('furniture')}
              />
              <span style={S.toolbarRowLabel}>家具切替を表示</span>
              <span className="ds-hint" style={S.toolbarRowHint}>(家具あり / なし)</span>
            </label>
            <label className="ds-check" style={S.toolbarRow}>
              <input
                type="checkbox"
                checked={!!variants?.lighting}
                onChange={() => onToggleVariant('lighting')}
              />
              <span style={S.toolbarRowLabel}>情景切替を表示</span>
              <span className="ds-hint" style={S.toolbarRowHint}>(昼 / 夜)</span>
            </label>
          </div>
        </>
      )}

      <div className="ds-label" style={S.toolbarGroupHead}>並び替え</div>
      <SidebarOrderEditor tb={tb} isVRMode={isVRMode} onChange={onChange} />
    </Section>
  );
}

const ORDER_LABELS: Record<OrderableSidebarBlock, string> = {
  type: 'タイプ (プラン切替)',
  movement: '移動モード',
  tracking: 'ヘッドトラッキング',
  mobile: 'モバイル (移動スピード)',
  quality: '画質',
  overview: '間取り概要',
  viewpoints: 'シーン',
  color: 'カラー',
  aiGenerate: 'AI 画像生成',
  map: 'FLOOR MAP / MAP',
};

/**
 * Whether a sidebar block currently shows in the viewer based on the toolbar
 * config. Mirrors `LeftPanel.tsx` exactly — most blocks are **default OFF**
 * (only visible when explicitly checked), `quality` and `mobile` are
 * **default ON** (visible unless explicitly turned off), `tracking` reads
 * `tb.demo` (legacy storage name) and is default OFF.
 */
function isBlockVisible(id: OrderableSidebarBlock, tb: ToolbarPatch, isVRMode: boolean): boolean {
  // `mobile` lives on `ViewerToolbarConfig` but isn't in the local
  // `ToolbarKey` union (no checkbox row), so reach in via the bag type.
  const bag = tb as Record<string, unknown>;
  // 3DGS 専用ブロック — 並び替えリストでは VR モードのとき行ごと除外。
  // `mobile`(移動スピード) / `movement`(歩く・フライ) / `quality`(画質) は LeftPanel
  // 側で `viewMode === 'splat'` ガードされていて VR では描画されないため、
  // 並び替えリストに載せると UI の不整合になる。
  const splatOnly = id === 'mobile' || id === 'movement' || id === 'quality';
  if (isVRMode && splatOnly) return false;
  if (id === 'mobile')   return bag.mobile !== false;
  if (id === 'tracking') return tb.demo === true;
  if (id === 'quality')  return tb.quality !== false;
  return bag[id] === true;
}

/**
 * Sidebar block-order editor. Renders a drag-and-drop list of **only the
 * currently-visible blocks** (chk on in the rows above). Saves the merged order
 * (visible items first in their new order, then any hidden items in their default
 * positions) so toggling something back on inserts it sensibly.
 */
function SidebarOrderEditor({ tb, isVRMode, onChange }: { tb: ToolbarPatch; isVRMode: boolean; onChange: (patch: ToolbarPatch) => void }) {
  const userOrder = (tb.order ?? []).filter((id): id is OrderableSidebarBlock => DEFAULT_SIDEBAR_ORDER.includes(id as OrderableSidebarBlock));
  const seen = new Set(userOrder);
  const fullOrdered: OrderableSidebarBlock[] = [...userOrder, ...DEFAULT_SIDEBAR_ORDER.filter((id) => !seen.has(id))];
  const visibleOrdered = fullOrdered.filter((id) => isBlockVisible(id, tb, isVRMode));
  const hiddenOrdered = fullOrdered.filter((id) => !isBlockVisible(id, tb, isVRMode));

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // Merge a re-ordered visible list with the hidden remainder so toggling
  // something back on lands it at the spot it occupied in the default order.
  const persist = (newVisible: OrderableSidebarBlock[]) => {
    onChange({ order: [...newVisible, ...hiddenOrdered] });
  };

  const onDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    // Required for Firefox to fire dragend / drop.
    e.dataTransfer.setData('text/plain', String(idx));
  };
  const onDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropIdx !== idx) setDropIdx(idx);
  };
  const onDrop = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) {
      setDragIdx(null);
      setDropIdx(null);
      return;
    }
    const next = [...visibleOrdered];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(idx, 0, moved);
    setDragIdx(null);
    setDropIdx(null);
    persist(next);
  };
  const onDragEnd = () => { setDragIdx(null); setDropIdx(null); };
  const reset = () => onChange({ order: undefined });

  return (
    <div>
      <div className="ds-hint" style={{ marginBottom: 6 }}>
        サイドバーに表示される項目だけが並びます。ドラッグで順序を入替。表示／非表示は上のチェックボックスで切替。
      </div>
      {visibleOrdered.length === 0 ? (
        <div className="ds-empty">表示中の項目がありません</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {visibleOrdered.map((id, idx) => {
            const isDragging = dragIdx === idx;
            const isDropTarget = dropIdx === idx && dragIdx !== idx;
            return (
              <div
                key={id}
                draggable
                onDragStart={(e) => onDragStart(e, idx)}
                onDragOver={(e) => onDragOver(e, idx)}
                onDrop={(e) => onDrop(e, idx)}
                onDragEnd={onDragEnd}
                className={`${surfaceClass('plain')} ds-row ds-fill-surface`}
                data-drop={isDropTarget || undefined}
                data-reorder={isDragging || undefined}
                style={{ cursor: 'grab', opacity: isDragging ? 0.5 : 1, userSelect: 'none' }}
              >
                <span className="ds-faint" style={{ minWidth: 14, lineHeight: 1 }} title="ドラッグして並び替え">⋮⋮</span>
                <span className="ds-mono ds-hint" style={{ minWidth: 18 }}>{idx + 1}</span>
                <span className="ds-body" style={{ flex: 1 }}>{ORDER_LABELS[id]}</span>
              </div>
            );
          })}
        </div>
      )}
      <button onClick={reset} className={`${surfaceClass('neutral')} ds-pill ds-pill--xs ds-fill-neutral`} style={{ marginTop: 8 }} title="並び順を既定に戻す">並び順を既定に戻す</button>
    </div>
  );
}

/**
 * Engine switch button — defined at module scope (not inside the parent's render
 * function) so it doesn't get unmount/remount on every camera-store update. That
 * was the bug behind "クリックしても反応しない".
 */
function EngineSwitchButton({
  label,
  sub,
  isActive,
  onClick,
}: {
  label: string;
  sub: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => { if (!isActive) onClick(); }}
      className={`${surfaceClass(isActive ? 'accent' : 'plain')} ds-pill ds-pill--block${isActive ? '' : ' ds-fill-surface'}`}
      /* Layout only — the stacked, left-aligned content is specific to this
         button; surface / edge / motion all come from the classes above. */
      style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 1, textAlign: 'left' }}
      title={isActive ? '使用中' : `${label} に切替えてリロード`}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="ds-badge__char">{isActive ? '●' : '○'}</span>
        <span>{label}</span>
      </span>
      <span className="ds-hint">{sub}</span>
    </button>
  );
}

function ToolbarRow({
  tb,
  keyName,
  label,
  hint,
  disabled,
  defaultOff,
  onChange,
}: {
  tb: Partial<Record<ToolbarKey, boolean>>;
  keyName: ToolbarKey;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** When true, undefined value means OFF (= unchecked). Default convention is ON. */
  defaultOff?: boolean;
  onChange: (patch: ToolbarPatch) => void;
}) {
  const checked = defaultOff ? tb[keyName] === true : tb[keyName] !== false;
  return (
    <label
      className="ds-check"
      style={{ ...S.toolbarRow, opacity: disabled ? 0.45 : 1 }}
      title={disabled ? '現在のプロジェクト種別 / モードでは無効' : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange({ [keyName]: e.target.checked })}
      />
      {/* Label and default sit in separate cells so every "— 既定 …" lands on
          the same right edge. Inside one span they tracked the label's length
          and the column read as noise. */}
      <span style={S.toolbarRowLabel}>{label}</span>
      {hint && <span className="ds-hint" style={S.toolbarRowHint}>{hint}</span>}
    </label>
  );
}

// ── 描画品質 Section ───────────────────────────────────────────────

/**
 * Render-quality knob panel for the 全体 tab. Mirrors the `RenderQualityConfig` shape
 * 1:1 — each row writes a single field via `onPatch`, then the parent calls
 * `onApply` so SceneManager mutates the live scene. MSAA is split out because it
 * requires a page reload (browsers can't change framebuffer sample count at runtime).
 *
 * Defined at module scope (not inline) so the live camera-store updates the parent
 * subscribes to don't tear down + remount this panel each frame.
 */
function RenderQualitySection({
  cfg,
  onPatch,
  onApply,
  onReset,
  onSwitchEngine,
  onToggleBypassPipeline,
  isVRMode,
}: {
  cfg: import('../core/types').RenderQualityConfig;
  onPatch: (patch: Partial<import('../core/types').RenderQualityConfig>) => void;
  onApply: (merged: import('../core/types').RenderQualityConfig) => void;
  onReset: () => void;
  /** 即時 engine 切替: manifest を同期保存してからフルリロードする */
  onSwitchEngine: (engine: 'mkkellogg' | 'spark' | 'playcanvas') => Promise<void> | void;
  /** カラーパイプライン bypass トグル: CameraFrame は init 時固定なので保存→リロード。 */
  onToggleBypassPipeline: (next: boolean) => Promise<void> | void;
  /** パノラマモードでは splat エンジン (PlayCanvas / Spark) の選択は無関係なので非表示。 */
  isVRMode: boolean;
}) {
  const ev = cfg.exposureEV ?? 0;
  const cc = cfg.clearColor ?? [0.1, 0.1, 0.15];

  const patch = (p: Partial<import('../core/types').RenderQualityConfig>) => {
    const merged = { ...cfg, ...p };
    onPatch(p);
    onApply(merged);
  };

  const colorHex = '#' + cc.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

  return (
    <Section
      title="描画品質"
      subtitle="RENDER QUALITY"
      defaultOpen={false}
      action={<button onClick={onReset} className={BTN} title="manifest.settings.render を未設定に戻す">既定に戻す</button>}
    >
      <div className="ds-hint" style={{ marginBottom: 8 }}>
        露出 / 背景色は両エンジン反映。彩度・コントラスト・明るさ・トーンマップは PlayCanvas のみ反映。
      </div>

      {/* ビューアエンジン切替 — 各ボタンは「保存 + 即リロード」で切替を即時反映。
          パノラマモードでは splat エンジン選択は意味が無いので非表示。 */}
      {!isVRMode && (
        <>
          <div className="ds-label" style={S.toolbarGroupHead}>ビューアエンジン</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 4 }}>
            <EngineSwitchButton
              label="PlayCanvas"
              sub="PLY / SOG (既定)"
              isActive={(cfg.engine ?? 'playcanvas') === 'playcanvas'}
              onClick={() => onSwitchEngine('playcanvas')}
            />
            <EngineSwitchButton
              label="Spark"
              sub="SPZ 軽量 / 高速"
              isActive={cfg.engine === 'spark'}
              onClick={() => onSwitchEngine('spark')}
            />
          </div>
          <div className="ds-hint" style={{ marginTop: 6 }}>
            ボタンを押すと自動でリロードしてエンジンが切り替わります。
          </div>
        </>
      )}

      {/* カラーパイプライン トグル — チェック = 色調整 ON = SuperSplat 同等パイプライン
          (HDR + gsplatOutputVS passthrough + 露出/トーン/grading 反映)。
          チェック外し = 学習時色味でそのまま (bypass=true)。
          下のカラー調整スライダー (露出 / トーン / 彩度等) は OFF 中描画に反映されないので
          視覚的ヒントとして露出スライダーより**上**に置く。
          切替は init 時固定なので内部的に保存→リロード。
          PlayCanvas エンジンのときだけ意味があるので Spark 中は隠す。 */}
      {!isVRMode && (cfg.engine ?? 'playcanvas') === 'playcanvas' && (
        <>
          <div className="ds-label" style={S.toolbarGroupHead}>カラーパイプライン</div>
          <label className="ds-check" style={{ ...S.toggle, marginTop: 4 }} title="チェックを入れると露出 / トーン / カラー補正が描画に反映されます。外すと学習時の色味のまま表示します。">
            <input
              type="checkbox"
              checked={cfg.bypassColorPipeline !== true}
              onChange={(e) => onToggleBypassPipeline(!e.target.checked)}
            />
            <span>色調整 ON</span>
          </label>
        </>
      )}

      <Slider label="露出 (EV)" min={-3} max={3} step={0.1} value={ev} onChange={(v) => patch({ exposureEV: +v.toFixed(2) })} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <span className="ds-hint" style={{ width: 56 }}>背景色</span>
        <input
          type="color"
          value={colorHex}
          onChange={(e) => {
            const hex = e.target.value;
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            patch({ clearColor: [r, g, b] });
          }}
          className="ds-swatch-input"
          style={{ width: 36, height: 24 }}
        />
        <span className="ds-mono ds-faint">{colorHex}</span>
      </div>

      {/* カラー調整 — PlayCanvas (CameraFrame) でのみ反映。Spark / mkkellogg では無視される。
          bypass ON 中は CameraFrame が無いので、これらのスライダーは保存はされるが描画には反映されない。 */}
      <div className="ds-label" style={S.toolbarGroupHead}>カラー調整 (PlayCanvas)</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span className="ds-sub" style={{ width: 80 }}>トーン</span>
        {/* This was the last surface still on the migration bridge, and it was
            wearing the RAISED shell — a select dressed as a button — while
            every other field in the app is a recessed slot. Element-level
            styling handles it now. */}
        <select
          value={cfg.toneMapping ?? 'linear'}
          onChange={(e) => patch({ toneMapping: e.target.value as NonNullable<import('../core/types').RenderQualityConfig['toneMapping']> })}
          style={{ flex: 1, padding: '6px 12px' }}
        >
          <option value="linear">Linear (既定)</option>
          <option value="neutral">Neutral</option>
          <option value="aces">ACES</option>
          <option value="aces2">ACES 2</option>
          <option value="filmic">Filmic</option>
          <option value="hejl">Hejl</option>
        </select>
      </div>
      <Slider label="彩度"     min={0}   max={2}   step={0.05} value={cfg.saturation ?? 1}  onChange={(v) => patch({ saturation: +v.toFixed(2) })} />
      <Slider label="コントラスト" min={0.5} max={1.5} step={0.05} value={cfg.contrast   ?? 1}  onChange={(v) => patch({ contrast:   +v.toFixed(2) })} />
      <Slider label="明るさ"   min={0}   max={3}   step={0.05} value={cfg.brightness ?? 1}  onChange={(v) => patch({ brightness: +v.toFixed(2) })} />
    </Section>
  );
}

/**
 * Slider with a value field that doubles as a number input — drag the range or type a
 * number directly. The text input keeps a local string buffer while focused so the user
 * can stage intermediate states like "-" or "1." without the parent clobbering them;
 * on blur / Enter we parse + clamp to [min, max] and commit. Esc cancels back to value.
 */
function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (!isFinite(n)) { setDraft(null); return; }
    const clamped = Math.max(min, Math.min(max, n));
    onChange(clamped);
    setDraft(null);
  };
  const display = draft ?? value.toFixed(2);
  return (
    <div style={{ margin: '8px 0' }}>
      <div style={S.sliderHeader}>
        <span className="ds-sub">{label}</span>
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={display}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
            else if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); }
          }}
          className="ds-input--compact"
          style={S.sliderValInput}
        />
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={S.slider} />
    </div>
  );
}

function StudioColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
      <span className="ds-sub" style={{ flex: 1 }}>{label}</span>
      {/* Both wells were still on platform chrome: a 4px-radius OS colour box
          and a text field that inherited the sunken recipe. The hex readout is
          something you read far more often than you type into, so it takes the
          raised shell like every other pill instead of reading as a slot. */}
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="ds-swatch-input"
        style={{ width: 44 }}
      />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface ds-mono`}
        style={{ width: 92, textAlign: 'center' }}
      />
    </div>
  );
}

// ── Video tab panel (multi-scene path → MP4) ─────────────────────
const DEFAULT_SEGMENT_SEC = 3.0;
const FREE_REC_BUFFER_SEC = 2; // start countdown / stop countdown for the free-recording mode

/* The video tab used to inject its own stylesheet here — tap feedback, a
 * thumbnail hover ring and two @keyframes. Every rule either duplicated
 * `.ds-pill` / `.ds-thumb` or fought them (a 0.9 press against the pill's
 * 0.975, a #3b82f6 outline against the accent ring), so one panel's buttons
 * behaved unlike every other button in the app. The two animations that were
 * genuinely missing — the REC pulse and the countdown pop — now live on
 * `.ds-rec-dot` / `.ds-countdown` in design-system.css. */

function VideoTabPanel(props: {
  manifest: { id: string } | null;
  activePlanId: string | null;
  sceneId: string;
  smRef: React.MutableRefObject<AnySceneManager | null>;
  mode: 'path' | 'free';
  setMode: (m: 'path' | 'free') => void;
  keyframes: CameraKeyframe[];
  setKeyframes: React.Dispatch<React.SetStateAction<CameraKeyframe[]>>;
  fps: 30 | 60;
  setFps: (f: 30 | 60) => void;
  recState: 'idle' | 'previewing' | 'recording';
  setRecState: (s: 'idle' | 'previewing' | 'recording') => void;
  progress: number;
  setProgress: (n: number) => void;
  error: string | null;
  setError: (e: string | null) => void;
  freeRecState: 'idle' | 'starting' | 'recording' | 'stopping';
  setFreeRecState: (s: 'idle' | 'starting' | 'recording' | 'stopping') => void;
  freeRecCountdown: number;
  setFreeRecCountdown: (n: number) => void;
  freeRecElapsedMs: number;
  setFreeRecElapsedMs: (n: number) => void;
  library: ClipMeta[];
  setLibrary: React.Dispatch<React.SetStateAction<ClipMeta[]>>;
  selectedClipIds: Set<string>;
  setSelectedClipIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  concatRunning: boolean;
  setConcatRunning: (b: boolean) => void;
  concatProgress: { clipIndex: number; t01: number; total: number } | null;
  setConcatProgress: (p: { clipIndex: number; t01: number; total: number } | null) => void;
  trimStart: number;
  setTrimStart: (n: number) => void;
  trimEnd: number;
  setTrimEnd: (n: number) => void;
}) {
  // Movement mode (walk / fly) — usually toggled from the LeftPanel which is
  // hidden in the video tab, so we surface it here too.
  const movementMode = useUIStore((s) => s.movementMode);
  const setMovementMode = useUIStore((s) => s.setMovementMode);
  const movementLocked = props.recState !== 'idle' || props.freeRecState === 'starting' || props.freeRecState === 'stopping';

  return (
    <Section title="動画" subtitle="VIDEO" defaultOpen={true}>
      {/* movement mode (walk / fly) — locked while a path recording / countdown is mid-flow.
          Both of these rows were segmented controls rebuilt by hand: a glass tray,
          transparent segments and an accent recipe on the active one. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="ds-label">移動モード</span>
        <SegmentedControl
          value={movementMode}
          onChange={setMovementMode}
          options={[
            { id: 'walk', label: '歩く', disabled: movementLocked },
            { id: 'fly', label: 'フライ', disabled: movementLocked },
          ]}
        />
      </div>

      {/* mode tabs */}
      <PillToggle
        value={props.mode}
        onChange={props.setMode}
        options={[
          { value: 'path', title: 'scene 補間', sub: 'カメラ位置を補間して動画化', disabled: props.recState !== 'idle' || props.freeRecState !== 'idle' },
          { value: 'free', title: '画面操作', sub: '操作画面をそのまま録画', disabled: props.recState !== 'idle' || props.freeRecState !== 'idle' },
        ]}
        style={{ marginBottom: 10 }}
      />

      {props.mode === 'path' ? <PathRecordingPanel {...props} /> : <FreeRecordingPanel {...props} />}

      {props.error && (
        <div className={`${surfaceClass('danger')} ds-panel`} style={{ marginTop: 8 }}>
          {props.error}
        </div>
      )}

      <ClipLibrarySection {...props} />
    </Section>
  );
}

// ── Path mode ────────────────────────────────────────────────────
function PathRecordingPanel({
  manifest, activePlanId, sceneId, smRef,
  keyframes, setKeyframes, fps, setFps,
  recState, setRecState, progress, setProgress, setError,
  setLibrary,
  trimStart, setTrimStart, trimEnd, setTrimEnd,
}: React.ComponentProps<typeof VideoTabPanel>) {
  const isBusy = recState !== 'idle';
  const canRun = keyframes.length >= 2 && !isBusy;
  const totalSec = totalPathDurationSec(keyframes);
  const [sceneDragIdx, setSceneDragIdx] = useState<number | null>(null);
  const [sceneDragOverIdx, setSceneDragOverIdx] = useState<number | null>(null);

  const handleSceneDragStart = (idx: number) => (e: React.DragEvent) => {
    if (isBusy) { e.preventDefault(); return; }
    setSceneDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  };
  const handleSceneDragOver = (idx: number) => (e: React.DragEvent) => {
    if (sceneDragIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (sceneDragOverIdx !== idx) setSceneDragOverIdx(idx);
  };
  const handleSceneDragLeave = () => setSceneDragOverIdx(null);
  const handleSceneDrop = (dropIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const fromIdx = sceneDragIdx;
    setSceneDragIdx(null);
    setSceneDragOverIdx(null);
    if (fromIdx === null || fromIdx === dropIdx) return;
    setKeyframes((kfs) => {
      const next = [...kfs];
      const [moved] = next.splice(fromIdx, 1);
      const insertIdx = dropIdx > fromIdx ? dropIdx - 1 : dropIdx;
      next.splice(insertIdx, 0, moved);
      return next;
    });
  };
  const handleSceneDragEnd = () => { setSceneDragIdx(null); setSceneDragOverIdx(null); };

  const captureCurrentPoseAndThumb = async (): Promise<{ pose: NonNullable<ReturnType<NonNullable<typeof smRef.current>['getCurrentPose']>>; thumbnail: string | null } | null> => {
    const sm = smRef.current;
    const pose = sm?.getCurrentPose?.();
    if (!pose) { setError('カメラ未初期化'); return null; }
    const thumbnail = sm?.captureThumbnail ? await sm.captureThumbnail(240) : null;
    return { pose, thumbnail };
  };

  const addCurrentAsScene = async () => {
    const r = await captureCurrentPoseAndThumb();
    if (!r) return;
    setError(null);
    setKeyframes((kfs) => [...kfs, { pose: r.pose, durationSec: DEFAULT_SEGMENT_SEC, thumbnail: r.thumbnail ?? undefined }]);
  };

  const overwriteScene = async (idx: number) => {
    const r = await captureCurrentPoseAndThumb();
    if (!r) return;
    setError(null);
    setKeyframes((kfs) => kfs.map((kf, i) => i === idx ? { ...kf, pose: r.pose, thumbnail: r.thumbnail ?? kf.thumbnail } : kf));
  };

  const removeScene = (idx: number) => setKeyframes((kfs) => kfs.filter((_, i) => i !== idx));
  const moveScene = (idx: number, delta: -1 | 1) => {
    setKeyframes((kfs) => {
      const next = [...kfs];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return kfs;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };
  const adjustSegmentDuration = (idx: number, delta: number) =>
    setKeyframes((kfs) => kfs.map((kf, i) => i === idx ? { ...kf, durationSec: Math.max(1, Math.min(60, Math.round(kf.durationSec + delta))) } : kf));
  const togglePassThrough = (idx: number) =>
    setKeyframes((kfs) => kfs.map((kf, i) => i === idx ? { ...kf, passThrough: !kf.passThrough } : kf));
  const jumpToIndex = (idx: number) => {
    const kf = keyframes[idx];
    if (kf) smRef.current?.jumpToPose?.(kf.pose);
  };

  const handlePreview = () => {
    if (keyframes.length < 2) { setError('scene を 2 つ以上追加してください'); return; }
    const sm = smRef.current;
    if (!sm?.playCameraAnimation) { setError('再生未対応'); return; }
    setError(null);
    setRecState('previewing');
    setProgress(trimStart);
    sm.playCameraAnimation(keyframes, {
      startT: trimStart,
      endT: trimEnd,
      onProgress: (tLocal) => setProgress(trimStart + (trimEnd - trimStart) * tLocal),
      onDone: () => { setRecState('idle'); setProgress(trimEnd); },
    });
  };

  const handleStopPreview = () => {
    smRef.current?.stopCameraAnimation?.();
    setRecState('idle');
  };

  const handleSetTrimStart = () => setTrimStart(Math.min(progress, trimEnd - 0.001));
  const handleSetTrimEnd = () => setTrimEnd(Math.max(progress, trimStart + 0.001));
  const handleResetTrim = () => { setTrimStart(0); setTrimEnd(1); };

  const handleRecord = async () => {
    if (keyframes.length < 2) { setError('scene を 2 つ以上追加してください'); return; }
    const sm = smRef.current;
    if (!sm?.playCameraAnimation || !sm?.getCanvas) { setError('録画未対応'); return; }
    const canvas = sm.getCanvas();
    if (!canvas) { setError('canvas が取れません'); return; }
    const picked = pickSupportedMime();
    if (!picked) { setError('このブラウザは MediaRecorder 非対応'); return; }
    setError(null);
    setRecState('recording');
    setProgress(trimStart);
    const startPose = interpolatePath(keyframes, trimStart) ?? keyframes[0].pose;
    sm.jumpToPose?.(startPose);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const recorder = new CanvasRecorder(canvas, picked.mime, fps);
    try { recorder.start(); }
    catch (e) {
      setError(`録画開始に失敗: ${e instanceof Error ? e.message : String(e)}`);
      setRecState('idle'); return;
    }
    sm.playCameraAnimation(keyframes, {
      startT: trimStart,
      endT: trimEnd,
      onProgress: (tLocal) => setProgress(trimStart + (trimEnd - trimStart) * tLocal),
      onDone: async () => {
        try {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const blob = await recorder.stop();
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const planId = activePlanId ?? 'plan';
          downloadBlob(blob, `${manifest?.id ?? sceneId}_${planId}_${ts}.${picked.ext}`);
          // Persist to the library so the user can re-download or concatenate later.
          try {
            await clipLib.saveClip(blob, {
              sceneId,
              planId: activePlanId,
              durationMs: Math.round(totalSec * 1000 * (trimEnd - trimStart)),
              ext: picked.ext,
              origin: 'path',
            });
            setLibrary(clipLib.listClips(sceneId));
          } catch (e) {
            console.warn('clip save failed:', e);
          }
        } catch (e) {
          setError(`書き出しに失敗: ${e instanceof Error ? e.message : String(e)}`);
        } finally { setRecState('idle'); setProgress(trimEnd); }
      },
    });
  };

  const handleScrub = (t: number) => {
    if (isBusy || keyframes.length < 2) return;
    setProgress(t);
    const pose = interpolatePath(keyframes, t);
    if (pose) smRef.current?.jumpToPose?.(pose);
  };
  const handleClear = () => { setKeyframes([]); setProgress(0); setError(null); };

  return (
    <>
      <div className="ds-hint" style={{ marginBottom: 8 }}>
        カメラを動かし「+ 現在のカメラを scene として追加」を繰り返すと、その順にカメラが動く動画になります。
        scene 行の右の数値は「次の scene までの秒数」。
      </div>

      {keyframes.length === 0 && (
        <div className="ds-dropzone">
          まだ scene がありません。下の「+ scene を追加」を押してください。
        </div>
      )}
      {keyframes.map((kf, i) => {
        const isLast = i === keyframes.length - 1;
        const isDragging = sceneDragIdx === i;
        const isDropTarget = sceneDragOverIdx === i && sceneDragIdx !== null && sceneDragIdx !== i;
        return (
          <div
            key={i}
            draggable={!isBusy}
            onDragStart={handleSceneDragStart(i)}
            onDragOver={handleSceneDragOver(i)}
            onDragLeave={handleSceneDragLeave}
            onDrop={handleSceneDrop(i)}
            onDragEnd={handleSceneDragEnd}
            className="ds-well"
            data-reorder={isDropTarget || undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              margin: '6px 0', padding: '6px',
              opacity: isDragging ? 0.4 : 1,
              cursor: isBusy ? 'default' : 'grab',
            }}
          >
            <span title="ドラッグで並べ替え" className="ds-faint" style={{ userSelect: 'none', cursor: isBusy ? 'default' : 'grab', flexShrink: 0 }}>⋮⋮</span>
            {/* thumbnail */}
            {kf.thumbnail ? (
              <img
                src={kf.thumbnail}
                alt={`scene ${i + 1}`}
                className="ds-thumb"
            data-clickable="true"
                draggable={false}
                onClick={() => !isBusy && jumpToIndex(i)}
                style={{ width: 84, height: 56, cursor: isBusy ? 'default' : 'pointer' }}
              />
            ) : (
              <div className="ds-thumb" style={{ width: 84, height: 56 }}>no img</div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="ds-title">scene{i + 1}</span>
                {/* 通過 / 停止 toggle — only meaningful on middle waypoints. First / last
                    always stop because the path starts and ends at rest. */}
                {i > 0 && !isLast && (
                  <button
                    type="button"
                    onClick={() => togglePassThrough(i)}
                    disabled={isBusy}
                    title={kf.passThrough ? '通過 (止まらない) — クリックで停止に切替' : '停止 (waypoint で減速) — クリックで通過に切替'}
                    className={`${surfaceClass(kf.passThrough ? 'processing' : 'neutral')} ds-pill ds-pill--xs${kf.passThrough ? '' : ' ds-fill-neutral'}`}
                  >
                    {kf.passThrough ? '⤳ 通過' : '■ 停止'}
                  </button>
                )}
              </div>
              <div className="ds-mono ds-hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                ({kf.pose.position[0].toFixed(1)}, {kf.pose.position[1].toFixed(1)}, {kf.pose.position[2].toFixed(1)})
              </div>
              {!isLast && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                  <span className="ds-hint">次の scene へ</span>
                  <button
                    type="button"
                    className={`${VIDEO_BTN}`}
                    onClick={() => adjustSegmentDuration(i, -1)}
                    disabled={isBusy || kf.durationSec <= 1}
                    title="−1 秒"
                    style={btnIcon()}
                  >−</button>
                  <span className="ds-mono" style={{ minWidth: 28, textAlign: 'center' }}>
                    {Math.round(kf.durationSec)}
                  </span>
                  <button
                    type="button"
                    className={`${VIDEO_BTN}`}
                    onClick={() => adjustSegmentDuration(i, +1)}
                    disabled={isBusy || kf.durationSec >= 60}
                    title="+1 秒"
                    style={btnIcon()}
                  >+</button>
                  <span className="ds-hint">秒</span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', gap: 2 }}>
                <button type="button" className={`${VIDEO_BTN}`} onClick={() => jumpToIndex(i)} disabled={isBusy} title="この位置にジャンプ" style={btnIcon()}>↑</button>
                <button type="button" className={`${VIDEO_BTN}`} onClick={() => overwriteScene(i)} disabled={isBusy} title="現在のカメラで上書き" style={btnIcon()}>⟳</button>
              </div>
              <div style={{ display: 'flex', gap: 2 }}>
                <button type="button" className={`${VIDEO_BTN}`} onClick={() => moveScene(i, -1)} disabled={isBusy || i === 0} title="上へ" style={btnIcon()}>▲</button>
                <button type="button" className={`${VIDEO_BTN}`} onClick={() => moveScene(i, 1)} disabled={isBusy || isLast} title="下へ" style={btnIcon()}>▼</button>
                <button type="button" className={`${dangerIconClass}`} onClick={() => removeScene(i)} disabled={isBusy} title="削除"><IconTrash /></button>
              </div>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        className="ds-dropzone"
        onClick={addCurrentAsScene}
        disabled={isBusy}
        style={{ marginTop: 6 }}
      >
        + 現在のカメラを scene{keyframes.length + 1} として追加
      </button>

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--ds-hairline)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="ds-sub">合計 <strong className="ds-title">{totalSec.toFixed(1)}秒</strong></span>
        <div style={{ flex: 1 }} />
        <span className="ds-sub">FPS</span>
        {([60, 30] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`${surfaceClass(fps === f ? 'accent' : 'plain')} ds-pill ds-pill--xs${fps === f ? '' : ' ds-fill-surface'}`}
            onClick={() => setFps(f)}
            disabled={isBusy}
          >
            {f}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span className="ds-sub">プレビュー位置</span>
          <span style={{ flex: 1 }} />
          <span className="ds-mono ds-sub">
            {(progress * totalSec).toFixed(1)}s / {totalSec.toFixed(1)}s
          </span>
        </div>
        {/* slider with trim-range highlight underneath */}
        <div style={{ position: 'relative' }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={progress}
            disabled={!canRun && !isBusy}
            onChange={(e) => handleScrub(parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: isBusy ? tokens.color.danger : tokens.color.accent, display: 'block' }}
          />
          {/* trim range bar — green strip showing what will be exported */}
          <div className="ds-progress" style={{ position: 'relative', width: '100%', height: 6, marginTop: 2 }}>
            <div
              className="ds-trimband"
              style={{
                left: `${trimStart * 100}%`,
                width: `${(trimEnd - trimStart) * 100}%`,
              }}
            />
          </div>
          <div className="ds-mono ds-hint" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
            <span>0s</span>
            <span>{totalSec.toFixed(1)}s</span>
          </div>
        </div>
      </div>

      {/* trim controls */}
      <div className={`${surfaceClass('success')} ds-panel`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, padding: '6px 8px' }}>
        <span className="ds-title" style={{ minWidth: 56 }}>出力範囲</span>
        <span className="ds-mono ds-hint" style={{ flex: 1 }}>
          {(trimStart * totalSec).toFixed(1)}s 〜 {(trimEnd * totalSec).toFixed(1)}s
          <span className="ds-faint" style={{ marginLeft: 6 }}>({((trimEnd - trimStart) * totalSec).toFixed(1)}s)</span>
        </span>
        <button type="button" className={`${VIDEO_BTN}`} onClick={handleSetTrimStart} disabled={isBusy}
          title="現在のスクラブ位置を開始に設定"
        >⊏ 開始</button>
        <button type="button" className={`${VIDEO_BTN}`} onClick={handleSetTrimEnd} disabled={isBusy}
          title="現在のスクラブ位置を終了に設定"
        >終了 ⊐</button>
        <button type="button" className={`${VIDEO_BTN}`} onClick={handleResetTrim} disabled={isBusy || (trimStart === 0 && trimEnd === 1)}
          title="全体に戻す"
        >↻</button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {recState === 'previewing' ? (
          <button
            type="button"
            className={`${surfaceClass('neutral')} ds-pill ds-fill-neutral`}
            onClick={handleStopPreview}
            style={{ flex: '1 1 auto' }}
          >
            ■ プレビュー停止
          </button>
        ) : (
          <button
            type="button"
            className={`${surfaceClass('plain')} ds-pill ds-fill-surface`}
            onClick={handlePreview}
            disabled={!canRun}
            style={{ flex: '1 1 auto' }}
          >
            ▶ プレビュー再生
          </button>
        )}
        <button
          type="button"
          className={`${surfaceClass('danger')} ds-pill`}
          onClick={handleRecord}
          disabled={!canRun}
          style={{ flex: '1 1 auto' }}
        >
          ● 録画 → MP4 ダウンロード
        </button>
        <button
          type="button"
          className={`${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface`}
          onClick={handleClear}
          disabled={isBusy || keyframes.length === 0}
        >
          <IconClose />全クリア
        </button>
      </div>

      {isBusy && (
        <div className="ds-sub" style={{ marginTop: 10 }}>
          {recState === 'recording' ? '録画中…' : 'プレビュー再生中…'}
          <div className="ds-progress" style={{ width: '100%', height: 4, marginTop: 4 }}>
            <div
              className="ds-progress__fill"
              data-tone={recState === 'recording' ? 'danger' : undefined}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      )}
    </>
  );
}

// ── Free-recording mode (操作画面をそのまま録画) ─────────────────
function FreeRecordingPanel({
  manifest, activePlanId, sceneId, smRef, fps, setFps,
  freeRecState, setFreeRecState,
  freeRecCountdown, setFreeRecCountdown,
  freeRecElapsedMs, setFreeRecElapsedMs,
  setError,
  setLibrary,
}: React.ComponentProps<typeof VideoTabPanel>) {
  const recorderRef = useRef<CanvasRecorder | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const elapsedRafRef = useRef<number | null>(null);
  const recordStartTsRef = useRef<number>(0);
  const mimeRef = useRef<{ mime: string; ext: 'mp4' | 'webm' } | null>(null);

  // Cleanup any pending timers if unmounted mid-flow.
  useEffect(() => {
    return () => {
      if (startTimerRef.current) window.clearTimeout(startTimerRef.current);
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
      if (elapsedRafRef.current) cancelAnimationFrame(elapsedRafRef.current);
    };
  }, []);

  const isBusy = freeRecState !== 'idle';

  const tickElapsed = () => {
    if (recordStartTsRef.current > 0) {
      setFreeRecElapsedMs(performance.now() - recordStartTsRef.current);
    }
    elapsedRafRef.current = requestAnimationFrame(tickElapsed);
  };

  const handleStart = () => {
    if (isBusy) return;
    const sm = smRef.current;
    if (!sm?.getCanvas) { setError('録画未対応'); return; }
    const canvas = sm.getCanvas();
    if (!canvas) { setError('canvas が取れません'); return; }
    const picked = pickSupportedMime();
    if (!picked) { setError('このブラウザは MediaRecorder 非対応'); return; }
    mimeRef.current = picked;
    setError(null);
    setFreeRecState('starting');
    setFreeRecCountdown(FREE_REC_BUFFER_SEC);
    setFreeRecElapsedMs(0);

    // Tick down every 1s. After FREE_REC_BUFFER_SEC seconds, actually start MediaRecorder.
    let remaining = FREE_REC_BUFFER_SEC;
    const tick = () => {
      remaining -= 1;
      if (remaining > 0) {
        setFreeRecCountdown(remaining);
        startTimerRef.current = window.setTimeout(tick, 1000);
      } else {
        setFreeRecCountdown(0);
        try {
          recorderRef.current = new CanvasRecorder(canvas, picked.mime, fps);
          recorderRef.current.start();
          recordStartTsRef.current = performance.now();
          setFreeRecState('recording');
          tickElapsed();
        } catch (e) {
          setError(`録画開始に失敗: ${e instanceof Error ? e.message : String(e)}`);
          setFreeRecState('idle');
        }
      }
    };
    startTimerRef.current = window.setTimeout(tick, 1000);
  };

  const handleStop = () => {
    if (freeRecState !== 'recording') return;
    setFreeRecState('stopping');
    setFreeRecCountdown(FREE_REC_BUFFER_SEC);
    let remaining = FREE_REC_BUFFER_SEC;
    const tick = () => {
      remaining -= 1;
      if (remaining > 0) {
        setFreeRecCountdown(remaining);
        stopTimerRef.current = window.setTimeout(tick, 1000);
      } else {
        setFreeRecCountdown(0);
        void finalize();
      }
    };
    stopTimerRef.current = window.setTimeout(tick, 1000);
  };

  const handleAbort = () => {
    if (startTimerRef.current) { window.clearTimeout(startTimerRef.current); startTimerRef.current = null; }
    if (stopTimerRef.current) { window.clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
    if (elapsedRafRef.current) { cancelAnimationFrame(elapsedRafRef.current); elapsedRafRef.current = null; }
    if (recorderRef.current) {
      try { void recorderRef.current.stop(); } catch { /* ignore */ }
      recorderRef.current = null;
    }
    setFreeRecState('idle');
    setFreeRecCountdown(0);
    setFreeRecElapsedMs(0);
    recordStartTsRef.current = 0;
  };

  const finalize = async () => {
    const recorder = recorderRef.current;
    const picked = mimeRef.current;
    const durationMs = recordStartTsRef.current > 0 ? performance.now() - recordStartTsRef.current : 0;
    if (elapsedRafRef.current) { cancelAnimationFrame(elapsedRafRef.current); elapsedRafRef.current = null; }
    if (!recorder || !picked) { setFreeRecState('idle'); return; }
    try {
      const blob = await recorder.stop();
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const planId = activePlanId ?? 'plan';
      downloadBlob(blob, `${manifest?.id ?? sceneId}_${planId}_free_${ts}.${picked.ext}`);
      try {
        await clipLib.saveClip(blob, {
          sceneId,
          planId: activePlanId,
          durationMs: Math.round(durationMs),
          ext: picked.ext,
          origin: 'free',
        });
        setLibrary(clipLib.listClips(sceneId));
      } catch (e) {
        console.warn('clip save failed:', e);
      }
    } catch (e) {
      setError(`書き出しに失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      recorderRef.current = null;
      setFreeRecState('idle');
      setFreeRecCountdown(0);
      setFreeRecElapsedMs(0);
      recordStartTsRef.current = 0;
    }
  };

  const elapsedSec = freeRecElapsedMs / 1000;

  return (
    <>
      <div className="ds-hint" style={{ marginBottom: 10 }}>
        「録画開始」を押すと <strong>{FREE_REC_BUFFER_SEC} 秒</strong>後に録画が始まります（操作の準備時間）。
        「録画停止」を押すと <strong>{FREE_REC_BUFFER_SEC} 秒</strong>後に停止します（仕舞いの操作時間）。
        その間にプレビュー画面で自由にカメラを動かしてください。
      </div>

      {/* fps */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="ds-sub">FPS</span>
        {([60, 30] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`${surfaceClass(fps === f ? 'accent' : 'plain')} ds-pill ds-pill--xs${fps === f ? '' : ' ds-fill-surface'}`}
            onClick={() => setFps(f)}
            disabled={isBusy}
          >
            {f}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {freeRecState === 'recording' && (
          <span className="ds-mono ds-warn">
            ● {elapsedSec.toFixed(1)}s
          </span>
        )}
      </div>

      {/* main action button */}
      {freeRecState === 'idle' && (
        <button
          type="button"
          className={`${surfaceClass('danger')} ds-pill ds-pill--lg`}
          onClick={handleStart}
          style={{ width: '100%' }}
        >
          ● 録画開始
        </button>
      )}
      {freeRecState === 'starting' && (
        <button
          type="button"
          className={`${surfaceClass('warn')} ds-pill ds-pill--lg`}
          onClick={handleAbort}
          style={{ width: '100%' }}
        >
          開始まで {freeRecCountdown}s … キャンセル
        </button>
      )}
      {freeRecState === 'recording' && (
        <button
          type="button"
          className={`${surfaceClass('neutral')} ds-pill ds-pill--lg ds-fill-neutral`}
          onClick={handleStop}
          style={{ width: '100%' }}
        >
          ■ 録画停止 → {FREE_REC_BUFFER_SEC} 秒バッファ後に書き出し
        </button>
      )}
      {freeRecState === 'stopping' && (
        <button
          type="button"
          disabled
          className={`${surfaceClass('warn')} ds-pill ds-pill--lg`}
          style={{ width: '100%' }}
        >
          停止まで {freeRecCountdown}s …
        </button>
      )}
    </>
  );
}

// Big centered overlay rendered ON the canvas during free-rec countdowns / live status.
function VideoOverlay({
  freeRecState, freeRecCountdown, freeRecElapsedMs, recState,
}: {
  freeRecState: 'idle' | 'starting' | 'recording' | 'stopping';
  freeRecCountdown: number;
  freeRecElapsedMs: number;
  recState: 'idle' | 'previewing' | 'recording';
}) {
  const showCountdown = freeRecState === 'starting' || freeRecState === 'stopping';
  const showRecBadge = freeRecState === 'recording' || recState === 'recording';
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6 }}>
      {showCountdown && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
          <div
            key={freeRecCountdown}
            className="ds-countdown"
          >
            {freeRecCountdown}
          </div>
          <div className="ds-countdown__label">
            {freeRecState === 'starting' ? '録画開始まで…' : '録画停止まで…'}
          </div>
        </div>
      )}
      {showRecBadge && !showCountdown && (
        <div className="ds-hud" style={{ position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="ds-rec-dot" />
            REC {freeRecState === 'recording' ? `${(freeRecElapsedMs / 1000).toFixed(1)}s` : ''}
        </div>
      )}
    </div>
  );
}

/** The video panel's dense step buttons. The disabled look is NOT spelled here:
 *  `.ds-pill:disabled` already dims and blocks it, and these buttons all carry
 *  a real `disabled` attribute — saying it twice is how the two drifted apart
 *  (0.35 opacity here, 0.45 in the design system). */
const VIDEO_BTN = `${surfaceClass('plain')} ds-pill ds-pill--xs ds-fill-surface`;
const btnIcon = (): React.CSSProperties => ({ minWidth: 22 });

// ── Clip library section ─────────────────────────────────────────
function ClipLibrarySection({
  manifest, activePlanId, sceneId,
  recState, freeRecState,
  library, setLibrary,
  selectedClipIds, setSelectedClipIds,
  concatRunning, setConcatRunning,
  concatProgress, setConcatProgress,
  setError,
}: React.ComponentProps<typeof VideoTabPanel>) {
  const isRecording = recState !== 'idle' || freeRecState !== 'idle';
  const isBusy = isRecording || concatRunning;
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handleDragStart = (id: string) => (e: React.DragEvent) => {
    if (isBusy) { e.preventDefault(); return; }
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const handleDragOver = (idx: number) => (e: React.DragEvent) => {
    if (!draggedId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };
  const handleDragLeave = () => setDragOverIdx(null);
  const handleDrop = (dropIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = draggedId;
    setDraggedId(null);
    setDragOverIdx(null);
    if (!id) return;
    const fromIdx = library.findIndex((c) => c.id === id);
    if (fromIdx === -1 || fromIdx === dropIdx) return;
    const next = [...library];
    const [moved] = next.splice(fromIdx, 1);
    const insertIdx = dropIdx > fromIdx ? dropIdx - 1 : dropIdx;
    next.splice(insertIdx, 0, moved);
    setLibrary(next);
    clipLib.reorderClipsForScene(sceneId, next.map((c) => c.id));
  };
  const handleDragEnd = () => { setDraggedId(null); setDragOverIdx(null); };

  const toggleSelect = (id: string) => {
    setSelectedClipIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDelete = async (id: string) => {
    try {
      await clipLib.deleteClip(id);
      setLibrary(clipLib.listClips(sceneId));
      setSelectedClipIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(`削除に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRedownload = async (clip: ClipMeta) => {
    try {
      const ts = new Date(clip.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await clipLib.downloadClip(clip.id, `${manifest?.id ?? sceneId}_${clip.planId ?? 'plan'}_${clip.origin}_${ts}.${clip.ext}`);
    } catch (e) {
      setError(`ダウンロードに失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Concatenate the selected clips in their current library order. The user
  // controls that order via drag-and-drop, so this simply respects what they see.
  const handleConcat = async () => {
    const ids = library.filter((c) => selectedClipIds.has(c.id)).map((c) => c.id);
    if (ids.length < 2) {
      setError('結合するには 2 本以上選択してください');
      return;
    }
    setError(null);
    setConcatRunning(true);
    setConcatProgress({ clipIndex: 0, t01: 0, total: ids.length });
    try {
      const { blob, ext } = await clipLib.concatClips(ids, {
        fps: 60,
        onProgress: (clipIndex, t01, total) => setConcatProgress({ clipIndex, t01, total }),
      });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const planId = activePlanId ?? 'plan';
      downloadBlob(blob, `${manifest?.id ?? sceneId}_${planId}_concat_${ts}.${ext}`);
      // Save the concatenated result to the library too so it shows up in the list.
      try {
        await clipLib.saveClip(blob, {
          sceneId,
          planId: activePlanId,
          durationMs: 0, // unknown without re-decoding; library shows '?'
          ext,
          origin: 'path',
        });
        setLibrary(clipLib.listClips(sceneId));
      } catch (e) { console.warn('concat save failed:', e); }
    } catch (e) {
      setError(`結合に失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConcatRunning(false);
      setConcatProgress(null);
    }
  };

  const formatBytes = (n: number) => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  };
  const formatDuration = (ms: number) => {
    if (ms <= 0) return '?';
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(0).padStart(2, '0')}`;
  };

  const selectedCount = selectedClipIds.size;

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--ds-hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="ds-title">ライブラリ</span>
        <span className="ds-hint">{library.length} 本保存済</span>
        <div style={{ flex: 1 }} />
        {selectedCount > 0 && (
          <button
            type="button"
            className={`${VIDEO_BTN}`}
            onClick={() => setSelectedClipIds(new Set())}
            disabled={isBusy}
          >
            選択解除
          </button>
        )}
      </div>

      {library.length === 0 && (
        <div className="ds-dropzone">
          まだ保存された動画はありません。録画すると自動で保存されます。
        </div>
      )}

      {library.map((clip, idx) => {
        const checked = selectedClipIds.has(clip.id);
        const isDragging = draggedId === clip.id;
        const isDropTarget = dragOverIdx === idx && draggedId && draggedId !== clip.id;
        return (
          <div
            key={clip.id}
            draggable={!isBusy}
            onDragStart={handleDragStart(clip.id)}
            onDragOver={handleDragOver(idx)}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop(idx)}
            onDragEnd={handleDragEnd}
            className={checked ? `${surfaceClass('accent')} ds-row` : 'ds-well'}
            data-reorder={isDropTarget || undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              margin: '4px 0', padding: '6px',
              opacity: isDragging ? 0.4 : 1,
              cursor: isBusy ? 'default' : 'grab',
            }}
          >
            <span title="ドラッグで並べ替え" className="ds-faint" style={{ cursor: isBusy ? 'default' : 'grab', userSelect: 'none' }}>⋮⋮</span>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggleSelect(clip.id)}
              disabled={isBusy}
              style={{ flexShrink: 0 }}
            />
            {clip.thumbnail ? (
              <img
                src={clip.thumbnail}
                alt=""
                draggable={false}
                className="ds-thumb"
                style={{ width: 64, height: 40, pointerEvents: 'none' }}
              />
            ) : (
              <div className="ds-thumb" style={{ width: 64, height: 40 }}>no img</div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ds-title">
                <span className="ds-sub" style={{ marginRight: 4 }}>{idx + 1}.</span>
                {clip.origin === 'path' ? '🎞 scene 補間' : '📹 画面操作'}
                <span className="ds-sub" style={{ marginLeft: 6 }}>
                  {formatDuration(clip.durationMs)} / {formatBytes(clip.bytes)} / .{clip.ext}
                </span>
              </div>
              <div className="ds-hint">
                {new Date(clip.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {clip.planId && <span style={{ marginLeft: 6 }}>plan: {clip.planId}</span>}
              </div>
            </div>
            <button type="button" className={`${VIDEO_BTN}`} onClick={() => handleRedownload(clip)} disabled={isBusy} title="再ダウンロード" style={btnIcon()}>↓</button>
            <button type="button" className={`${dangerIconClass}`} onClick={() => handleDelete(clip.id)} disabled={isBusy} title="削除"><IconTrash /></button>
          </div>
        );
      })}

      {library.length >= 2 && (
        <button
          type="button"
          className={`${surfaceClass('accent')} ds-pill`}
          onClick={handleConcat}
          disabled={isBusy || selectedCount < 2}
          style={{ width: '100%', marginTop: 8 }}
        >
          🔗 選択した {selectedCount} 本を結合 → MP4
        </button>
      )}

      {concatRunning && concatProgress && (
        <div className="ds-sub" style={{ marginTop: 8 }}>
          結合中… clip {concatProgress.clipIndex + 1} / {concatProgress.total}（{Math.round(concatProgress.t01 * 100)}%）
          <div className="ds-progress" style={{ width: '100%', height: 4, marginTop: 4 }}>
            <div
              className="ds-progress__fill"
              style={{ width: `${Math.round(((concatProgress.clipIndex + concatProgress.t01) / concatProgress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ----- styles -----

// Mapped to the shared liquid-glass design tokens. Keeping the local `COLOR`
// alias rather than tearing it out everywhere — every entry here is just
// a re-export of the token, so future palette tweaks happen in one file
// (`design-tokens.ts`) and propagate. Typed as `string` so consumers that
// cross-assign different entries (e.g. `dot = state==='saving' ? accent
// : warn`) don't trip narrowing.
const COLOR: Record<string, string> = {
  bg: tokens.color.bg,
  panel: tokens.color.surface,
  panel2: tokens.color.surfaceSoft,
  border: tokens.color.border,
  borderSoft: tokens.color.hairline,
  text: tokens.color.text,
  textDim: tokens.color.text,
  textMute: tokens.color.textMute,
  accent: tokens.color.accent,
  accentText: tokens.color.accent,
  warn: tokens.color.warn,
  danger: tokens.color.danger,
  ok: tokens.color.success,
};

/** Class list for the shared white pill — see `fileBtn`. */
const shellClass = `${surfaceClass('plain')} ds-pill ds-fill-surface`;

/* Panel buttons. `btn` is the ordinary grey action; `btnPrimary` is white —
   deliberately not green, because these are "add a plan / a viewpoint / a
   variant" actions and the success hue read as a confirmation that nothing had
   actually confirmed. */
const BTN = `${surfaceClass('neutral')} ds-pill ds-pill--sm ds-fill-neutral`;
const BTN_PRIMARY = `${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface`;

/* Destructive controls. Every one of these was drawn by hand at its call site
   — a rose tint here, a `#f87171` glyph there, a 6px-radius outlined box in
   the floor-plan panel — so the same action looked like three different
   controls depending on which panel you were in. `ds-v-danger` already carries
   the rose edge, fill, text colour and glow; the only choice left is icon-only
   or labelled. No `ds-fill-surface`: it would override the variant's own fill
   (both are one class deep, and the neutral one is declared later). */
const dangerIconClass = `${surfaceClass('danger')} ds-pill ds-pill--icon ds-pill--xs`;
const dangerPillClass = `${surfaceClass('danger')} ds-pill ds-pill--sm`;
/** Labelled but sitting in a dense row, beside 24px icon buttons. */
const dangerXsClass = `${surfaceClass('danger')} ds-pill ds-pill--xs`;
/** Round liquid icon button — the action row on a viewpoint / plan entry. */
const roundIconClass = `${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`;

/** A list row: accent while selected, plain otherwise. Drop / reorder states
 *  ride on `data-drop` / `data-reorder`, not on merged style objects. */
const rowClass = (active: boolean) =>
  `${surfaceClass(active ? 'accent' : 'plain')} ds-row${active ? '' : ' ds-fill-surface'}`;

const S: Record<string, React.CSSProperties> = {
  root: {
    width: '100vw', height: '100vh',
    display: 'grid', gridTemplateRows: '48px 1fr', gridTemplateColumns: '1fr',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '0 16px',
    borderBottom: `1px solid var(--ds-hairline)`,
  },
  logo: { display: 'flex', alignItems: 'center', gap: 10 },
  fpsChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '5px 13px',
  },
  fpsDot: { width: 6, height: 6, borderRadius: '50%' },
  viewerBtn: { textDecoration: 'none' },
  /* The two-column split and the panel's divider live in `.ds-authoring` /
     `.ds-authoring__panel` — they need a media query to survive a phone, and
     a media query cannot be written inline. */
  body: { minHeight: 0, overflow: 'hidden' },
  left: {
    minWidth: 0, minHeight: 0,
    overflowY: 'auto', overflowX: 'hidden',
    padding: '14px 10px',
    display: 'flex', flexDirection: 'column', gap: 10,
    scrollbarWidth: 'thin',
  },

  kvGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 },
  kvCell: { padding: '8px 12px', minWidth: 0 },
  kvVal: { whiteSpace: 'nowrap' as const },

  btnRow: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' },
  /* Raised, not sunken. The sunken recipe (shadow on top, no outer drop)
     belongs to things you type INTO — inputs, tracks. Using it for a button
     said "this is a slot" while the control was in fact pressable, which is
     why these read as inert panels. They are ordinary buttons that happen to
     open a file picker, so they take the ordinary pill. */
  fileBtn: {
    width: '100%',
    textAlign: 'center' as const,
  },

  inlineCard: { marginTop: 10, padding: 10 },
  /* `input` / `inputInline` / `formInput` were three copies of the sunken
     recipe. `design-system.css` styles `<input>` at ELEMENT level, so a bare
     input is already correct and only its size belongs here. */
  input: {},
  inputInline: { padding: '4px 10px' },
  formInput: {},

  vpList: { display: 'flex', flexDirection: 'column', gap: 6 },
  vpDragHandle: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 28,
    cursor: 'grab', userSelect: 'none' as const,
    flexShrink: 0,
  } as React.CSSProperties,
  vpDot: {
    width: 10, height: 10, borderRadius: '50%', padding: 0,
    cursor: 'pointer',
    flexShrink: 0,
  },
  vpThumb: {
    position: 'relative' as const,
    width: 56, height: 42,
    padding: 0,
    overflow: 'hidden',
    cursor: 'pointer',
    flexShrink: 0,
  },
  vpThumbImg: {
    width: '100%', height: '100%', objectFit: 'cover' as const, display: 'block',
  },
  vpThumbEmpty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '100%', height: '100%',
  },
  vpThumbBadge: { position: 'absolute' as const, top: 2, right: 2 },
  vpLabel: {
    cursor: 'pointer',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  vpMeta: {
    marginTop: 2,
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    wordBreak: 'break-all' as const,
  },
  vpMetaSep: { opacity: 0.4 },
  vpActions: { display: 'flex', gap: 2, flexShrink: 0 },

  /* Plan rows only — the viewpoint list keeps its two-line form, where the
     second line carries coordinates you actually read. */
  planMain: {
    flex: 1, minWidth: 0,
    display: 'flex', alignItems: 'baseline', gap: 8,
  },
  /* Basis `auto` against the meta's `0`: the name is measured from its own
     text and keeps that width, and the meta lives on whatever is left. With
     both at `auto` a long SOG filename bid for the same space and squeezed the
     name down to デフォ…, which is the one part of the row you cannot lose. */
  planLabel: {
    flex: '0 1 auto', minWidth: '4.5em',
    cursor: 'pointer',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  planMeta: {
    flex: '1 1 0', minWidth: 0,
    display: 'flex', alignItems: 'baseline', gap: 6,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },

  toggle: { userSelect: 'none', padding: '4px 0' },
  subTitle: {
    display: 'flex', alignItems: 'center', gap: 6,
    marginTop: 12, marginBottom: 6,
  },
  colorDot: { width: 8, height: 8, borderRadius: '50%' },

  fpsBig: {
    display: 'flex', alignItems: 'baseline', gap: 6,
    marginTop: 10, padding: '14px 16px',
  },

  infoRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 8,
    padding: '6px 0', borderBottom: '1px solid var(--ds-hairline)',
  },
  infoLabel: { flexShrink: 0 },
  infoVal: {
    textAlign: 'right' as const,
    minWidth: 0, flex: 1,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },

  floorPlanThumbWrap: {
    position: 'relative' as const,
    marginTop: 10,
    padding: 6,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 6,
  },
  floorPlanSticky: {
    // Pin the banner + map + hint to the top of the scrolling left panel so the user can
    // see direction changes as they slide a yaw control further down the list. `top` is
    // chosen to clear the section's tab bar (which is already position: sticky, top: 0).
    position: 'sticky' as const,
    top: 56,
    zIndex: 4,
    paddingBottom: 4,
    margin: '-6px -6px 0 -6px',
    paddingLeft: 6,
    paddingRight: 6,
    paddingTop: 6,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 6,
  },
  floorPlanThumbImg: {
    width: '100%',
    maxHeight: 220,
    objectFit: 'contain' as const,
    display: 'block' as const,
  },
  floorPlanEditorWrap: {
    position: 'relative' as const,
    width: '100%',
    display: 'flex' as const,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    padding: 4,
    minHeight: 220,
  },
  floorPlanEditor: {
    position: 'relative' as const,
    bottom: 'auto' as const,
    left: 'auto' as const,
    margin: 0,
  },

  vpPosList: {
    marginTop: 10,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 4,
    // Cap the height so a long viewpoint list scrolls internally instead of pushing the
    // sticky map out of the floor-plan container.
    maxHeight: 380,
    overflowY: 'auto' as const,
    scrollbarWidth: 'thin' as const,
  },
  vpPosHeader: {
    display: 'grid' as const,
    gridTemplateColumns: 'minmax(80px, 1fr) 64px 64px 28px',
    gap: 6,
    alignItems: 'center' as const,
    padding: '0 4px 2px 4px',
    borderBottom: '1px solid var(--ds-hairline)',
  },
  vpPosHeaderName: { textAlign: 'left' as const },
  vpPosHeaderCol: { textAlign: 'center' as const },
  vpPosRow: {
    display: 'grid' as const,
    gridTemplateColumns: 'minmax(80px, 1fr) 64px 64px 28px',
    gap: 6,
    alignItems: 'center' as const,
    padding: 4,
  },
  vpPosName: {
    cursor: 'pointer',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  vpPosActionBtn: { width: 28, height: 24, flexShrink: 0 },

  vpYawRow: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 4,
    padding: 6,
  },
  vpYawControls: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingLeft: 4,
  },
  vpYawInput: { width: 56, flexShrink: 0 },
  vpYawUnit: { flexShrink: 0 },
  vpYawSlider: { flex: 1, minWidth: 80 },

  zoomRangeBox: { marginTop: 6 },
  zoomRangeHead: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 4,
  },

  // ── Project main thumbnail picker ─────────────────────────────────
  projThumbHead: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: 10,
    marginTop: 4,
    marginBottom: 8,
  },
  projThumbPreview: {
    width: 88,
    aspectRatio: '4 / 3',
    flexShrink: 0,
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  projThumbPreviewImg: {
    width: '100%', height: '100%', objectFit: 'cover' as const, display: 'block' as const,
  },
  projThumbGrid: {
    display: 'grid' as const,
    gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
    gap: 6,
    maxHeight: 280,
    overflowY: 'auto' as const,
    scrollbarWidth: 'thin' as const,
  },
  projThumbCellImg: {
    width: '100%',
    aspectRatio: '4 / 3',
    objectFit: 'cover' as const,
    display: 'block' as const,
  },
  projThumbCellPh: {
    width: '100%',
    aspectRatio: '4 / 3',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  projThumbCheck: { position: 'absolute' as const, top: 4, right: 6 },

  tabBar: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
    margin: '0 0 4px 0',
  },
  planPills: {
    display: 'flex' as const,
    flexWrap: 'wrap' as const,
    alignItems: 'center' as const,
    gap: 6,
    padding: '8px 12px',
    marginBottom: 6,
  },
  planPillsLabel: { marginRight: 2, paddingLeft: 4 },
  modeRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  modeHint: { marginTop: 8 },
  toolbarGroupHead: { marginTop: 12 },
  toolbarHint: { marginLeft: 6 },
  /* One toggle per cell. `auto-fill` rather than a fixed count: the same panel
     is 320px docked and ~520px in the authoring layout.
     340px is the width of the longest row that must not wrap — 移動モード切替
     (歩く / フライ) plus its 既定 — so a second column can only appear once
     there is honest room for one. At 248px the panel landed within 2px of the
     1/2-column boundary, where a hair more width silently starts wrapping. */
  toolbarGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    columnGap: 18,
    rowGap: 2,
    marginTop: 2,
  },
  toolbarRow: { userSelect: 'none' as const, padding: '4px 0', width: '100%' },
  /* Takes the slack so the hint is pushed to the cell's right edge. */
  toolbarRowLabel: { flex: 1, minWidth: 0 },
  toolbarRowHint: { flexShrink: 0, marginLeft: 8 },
  sliderHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 8 },
  sliderValInput: { width: 64 },
  slider: { width: '100%' },

  errorBox: {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    padding: '14px 18px',
    maxWidth: 320, textAlign: 'center' as const,
    zIndex: 20,
  },
};
