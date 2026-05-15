import React, { useEffect, useRef, useState } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { useUIStore } from '../store/ui-store';
import { useTrackingStore } from '../store/tracking-store';
import { calibrateHeadTracker } from '../utils/head-tracker';
import { resolveScenePath } from '../core/scene-manifest';
import { DEFAULT_SIDEBAR_ORDER, type OrderableSidebarBlock } from '../core/types';
import * as idb from '../utils/idb';
import { tokens } from './design-tokens';

/**
 * Constrain pan so the zoomed image still covers the viewport (no empty letterbox edges).
 * Transform is `translate(panX, panY) scale(scale)` on a `dW × dH` content; clamp panX into
 * `[-(scale-1)*dW, 0]` and panY likewise.
 */
function clampZoom(z: { scale: number; panX: number; panY: number }, dW: number, dH: number) {
  const minX = -(z.scale - 1) * dW;
  const minY = -(z.scale - 1) * dH;
  return {
    scale: z.scale,
    panX: Math.max(minX, Math.min(0, z.panX)),
    panY: Math.max(minY, Math.min(0, z.panY)),
  };
}

interface LeftPanelProps {
  onViewpointClick: (id: string) => void;
  /** Switch the active plan (= type). Required to render the タイプ block. */
  onPlanSwitch?: (planId: string) => void;
}

export function LeftPanel({ onViewpointClick, onPlanSwitch }: LeftPanelProps) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const activePlan = manifest?.plans?.find((p) => p.id === activePlanId);

  const sceneName = manifest?.name ?? '3D Gaussian Tour';
  const hasMap = !!activePlan?.floorPlan?.image;
  const hiddenSections = useUIStore((s) => s.hiddenSections);
  const setSectionHidden = useUIStore((s) => s.setSectionHidden);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  // 「その他」(展示 / 屋外 / 任意の空間) のときは住居・店舗向けの項目 (間取り概要) を出さない
  const projectType = useUIStore((s) => s.projectType);
  const isOther = projectType === 'other';
  const viewMode = useUIStore((s) => s.viewMode);
  // 制作者が Debug → ツールバー表示 で消した項目はそもそも DOM に出さない。
  // 既定 (= undefined) は表示扱い。
  const tb = manifest?.viewerToolbar ?? {};
  // サイドバーサイズ — 'large' (既定: 全高表示) / 'small' (内容の高さ分だけに縮める。幅は同じ 320)。
  // 表示する項目は両モード共通。`small` は純粋にパネルの縦サイズのみ変える。
  // Default flipped to 'small' — keeps the panel compact unless the
  // author explicitly opts into the full-height "大" preset.
  const sidebarSize = tb.size ?? 'small';
  // スマホ配置: 縦向き → 右下フロート (left ジョイスティックと干渉しない幅にクランプ)、
  // 横向き → 右側フル高。デスクトップは従来通り左側。`useTouchDevice` を先に評価して
  // mobile placement だけが上書きとして効くようにする。
  const isTouchDevice = useTouchDevice();
  const isPortrait = usePortraitOrientation();
  const placement: SidebarPlacement = !isTouchDevice ? 'left' : (isPortrait ? 'portrait' : 'right');
  const sStyles = sidebarSizeStyles(sidebarSize, placement);
  // 既定はすべて OFF（顧客向けに最小限の UI を配信したい想定）。制作者が Debug →
  // ツールバー表示で必要な項目を明示的にチェックして出します。
  // 例外: `quality` だけは既定 ON — 描画品質はビューア側で見る人の端末性能に応じて
  // 切り替えたい操作なので、毎回チェックさせると面倒。
  const showType       = tb.type       === true;
  const showOverview   = tb.overview   === true && !isOther;
  const showViewpoints = tb.viewpoints === true;
  const showColor      = tb.color      === true && !isOther;
  const showMap        = tb.map        === true;
  // 拡大 (fullscreen) はデスクトップ専用。スマホ (touch) は OS 側の全画面 UI と
   // 衝突するうえ、サイドバー幅が限られるのでアイコンを出さない。
  const showFullscreen = tb.fullscreen === true && !isTouchDevice;
  // タグ (ピン) は viewerToolbar.pins で制作者が opt-in したときだけアイコンが出る。
  // タップで `useUIStore.showPins` が反転 → ScenePinsOverlay の出し分けに使う。
  const showPinsToggle = tb.pins === true;
  const showMovement   = tb.movement   === true && viewMode === 'splat';
  // ヘッドトラッキングは VR モードでも有効 (パノラマ視点回転に使える)。
  const showDemo       = tb.demo       === true;
  const showQuality    = tb.quality    !== false && viewMode === 'splat';
  const showAiGenerate = tb.aiGenerate === true;
  // Mobile-only block: only relevant on touch devices, so we gate by
  // `pointer: coarse` regardless of the toolbar config. The author can still
  // suppress it explicitly with `tb.mobile === false`.
  // `isTouchDevice` は上で placement のために評価済みなので再代入はしない。
  const showMobile     = tb.mobile     !== false && viewMode === 'splat' && isTouchDevice;

  // Collapsed: render only a tiny floating button to bring the sidebar back.
  // 折りたたみハンドルの位置はサイドバーと同側に揃える (PC 左上 / スマホ縦 右下 / スマホ横 右上)。
  if (sidebarCollapsed) {
    const handleStyle = collapsedHandleStyle(placement);
    // 左/右上で「>」、右下では「<」のような感じだと意味が逆になるので、向きも合わせて反転。
    const chevronD = placement === 'left' ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6';
    return (
      <button onClick={() => setSidebarCollapsed(false)} style={handleStyle} title={`${sceneName} を表示`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={chevronD} />
        </svg>
      </button>
    );
  }


  return (
    <>
      <div style={sStyles.sidebar}>
        {/* タイトル枠 — 右端に音声トグル + 拡大 + サイドバー全閉ボタン */}
        <div style={sidebarTitleBlock}>
          <span style={sidebarTitle}>{sceneName}</span>
          <div style={{ flex: 1 }} />
          {manifest?.audio && <AmbientAudioToggle />}
          {showPinsToggle && <PinsVisibilityToggle />}
          {showFullscreen && <FullscreenButton iconOnly />}
          <button onClick={() => setSidebarCollapsed(true)} style={titleIconBtn} title="サイドバーを閉じる (ビューを最大化)">
            <span style={titleIconGlyph}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </span>
          </button>
        </div>

        <div style={sidebarScrollArea}>
        {(() => {
          // Render blocks in the order defined by `viewerToolbar.order` (with the
          // default order filling in any missing ids). Each block is gated by its
          // existing visibility flag (`showType` etc.) so reordering doesn't override
          // the show/hide semantics.
          const blocks: Record<OrderableSidebarBlock, React.ReactNode> = {
            type: showType ? <TypeSelectBlock onPlanSwitch={onPlanSwitch} /> : null,
            movement: showMovement ? (hiddenSections.includes('movement') ? (
              <ClosedSectionHandle label="移動モード" onOpen={() => setSectionHidden('movement', false)} />
            ) : (
              <MovementModeBlock />
            )) : null,
            tracking: showDemo ? (hiddenSections.includes('tracking') ? (
              <ClosedSectionHandle label="ヘッドトラッキング" onOpen={() => setSectionHidden('tracking', false)} />
            ) : (
              <DemoModeBlock />
            )) : null,
            mobile: showMobile ? (hiddenSections.includes('mobile') ? (
              <ClosedSectionHandle label="移動スピード" onOpen={() => setSectionHidden('mobile', false)} />
            ) : (
              <MobileToolsBlock onClose={() => setSectionHidden('mobile', true)} />
            )) : null,
            quality: showQuality ? (hiddenSections.includes('quality') ? (
              <ClosedSectionHandle label="画質" onOpen={() => setSectionHidden('quality', false)} />
            ) : (
              <QualityBlock />
            )) : null,
            overview: showOverview ? <OverviewBlock /> : null,
            viewpoints: showViewpoints ? (hiddenSections.includes('viewpoints') ? (
              <ClosedSectionHandle label="シーン" onOpen={() => setSectionHidden('viewpoints', false)} />
            ) : (
              <div style={sidebarBlock}>
                <div style={overviewHeaderRow}>
                  <span style={blockHeading}>シーン</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setSectionHidden('viewpoints', true)} style={overviewCloseBtn} title="シーンを閉じる">×</button>
                </div>
                <ViewpointsContent onViewpointClick={onViewpointClick} />
              </div>
            )) : null,
            color: showColor ? <ColorSelectBlock /> : null,
            aiGenerate: showAiGenerate ? (hiddenSections.includes('aiGenerate') ? (
              <ClosedSectionHandle label="AI 画像生成" onOpen={() => setSectionHidden('aiGenerate', false)} />
            ) : (
              <AiImageGenBlock />
            )) : null,
            map: showMap ? (hiddenSections.includes('map') ? (
              <ClosedSectionHandle label={isOther ? 'MAP' : 'FLOOR MAP'} onOpen={() => setSectionHidden('map', false)} />
            ) : (
              <div style={{ ...sidebarBlock, ...sidebarMapBlock }}>
                <div style={overviewHeaderRow}>
                  <span style={blockHeading}>{isOther ? 'MAP' : 'FLOOR MAP'}</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setSectionHidden('map', true)} style={overviewCloseBtn} title="MAP を閉じる">×</button>
                </div>
                {hasMap ? (
                  <MapContent onViewpointClick={onViewpointClick} />
                ) : (
                  <div style={{ padding: '20px 10px', color: tokens.color.textMute, fontSize: 12, textAlign: 'center' }}>
                    このプランの図面はまだ設定されていません
                  </div>
                )}
              </div>
            )) : null,
          };
          // Compose ordered list: user-configured ids first (deduped), then any
          // defaults the user didn't list (forward-compat for new blocks added to
          // DEFAULT_SIDEBAR_ORDER after they saved an order).
          const userOrder = (tb.order ?? []).filter((id) => id in blocks) as OrderableSidebarBlock[];
          const seen = new Set(userOrder);
          const finalOrder: OrderableSidebarBlock[] = [
            ...userOrder,
            ...DEFAULT_SIDEBAR_ORDER.filter((id) => !seen.has(id)),
          ];
          return finalOrder.map((id) => <React.Fragment key={id}>{blocks[id]}</React.Fragment>);
        })()}
        </div>

      </div>

    </>
  );
}


// ── Map ───────────────────────────────────────────────────────────

function MapContent({ onViewpointClick }: { onViewpointClick: (id: string) => void }) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const yaw = useCameraStore((s) => s.yaw);
  const activeVp = useCameraStore((s) => s.activeViewpoint);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  /** Pan + zoom in CSS-pixel space relative to the map's top-left. scale ∈ [1, 8]. */
  const [zoom, setZoom] = useState({ scale: 1, panX: 0, panY: 0 });
  // Suppress the synthetic click that fires after a pan-drag so the user doesn't accidentally
  // teleport to a viewpoint right after panning.
  const suppressNextClickRef = useRef(false);
  // The green live-look cone starts visually anchored at the blue cone's direction (`mapYaw`
  // / saved direction) when the user enters a viewpoint. Once the user mouse-drags to look
  // around, it switches to following live camera yaw. Reset on viewpoint change. Pure display
  // — does not touch the live camera or the manifest.
  const [followLive, setFollowLive] = useState(false);
  const lastVpRef = useRef<string | null>(null);
  const baseYawRef = useRef<number>(0);
  useEffect(() => {
    if (lastVpRef.current !== activeVp) {
      lastVpRef.current = activeVp;
      baseYawRef.current = yaw;
      setFollowLive(false);
    } else if (!followLive && Math.abs(yaw - baseYawRef.current) > 0.5) {
      setFollowLive(true);
    }
  }, [activeVp, yaw, followLive]);

  const activePlan = manifest?.plans?.find((p) => p.id === activePlanId);
  const floorPlan = activePlan?.floorPlan;
  const fpImage = floorPlan?.image;
  const isData = !!fpImage && fpImage.startsWith('data:');
  const hasFile = !!fpImage && (isData || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(fpImage));
  const imageUrl = isData ? fpImage : (fpImage && manifest ? resolveScenePath(manifest.id, fpImage) : '');

  useEffect(() => {
    if (!hasFile || !imageUrl) { setImgSize(null); setImgFailed(false); return; }
    setImgFailed(false);
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => { setImgSize(null); setImgFailed(true); };
    img.src = imageUrl;
  }, [imageUrl, hasFile]);

  // Reset zoom when the underlying floor plan changes (different plan or scene).
  useEffect(() => {
    setZoom({ scale: 1, panX: 0, panY: 0 });
  }, [imageUrl, activePlanId]);

  // Native non-passive wheel listener so we can preventDefault and stop the panel scrolling.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const rect = map.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setZoom((z) => {
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const newScale = Math.max(1, Math.min(8, z.scale * factor));
        if (Math.abs(newScale - z.scale) < 1e-3) return z;
        const ratio = newScale / z.scale;
        // Solve: keep the cursor anchor (mx, my) at the same screen pixel after zoom.
        const newPanX = mx * (1 - ratio) + z.panX * ratio;
        const newPanY = my * (1 - ratio) + z.panY * ratio;
        return clampZoom({ scale: newScale, panX: newPanX, panY: newPanY }, rect.width, rect.height);
      });
    };
    map.addEventListener('wheel', handler, { passive: false });
    return () => map.removeEventListener('wheel', handler);
  }, []);

  if (!manifest || !floorPlan) {
    return (
      <div style={{ padding: '20px 10px', color: tokens.color.textMute, fontSize: 12, textAlign: 'center' }}>
        このプランの図面はまだ設定されていません
      </div>
    );
  }

  // Sized to fit within the new sidebar's MAP block (sidebar 320 − padding/border ~24).
  const size = 280;
  const worldW = floorPlan.bounds.max[0] - floorPlan.bounds.min[0];
  const worldH = floorPlan.bounds.max[1] - floorPlan.bounds.min[1];
  const aspect = imgSize ? imgSize.w / imgSize.h : worldW / worldH;
  let dW = size, dH = size;
  if (aspect > 1) dH = size / aspect; else dW = size * aspect;

  // No padding inset — the floor plan image fills the panel completely. SVG dots can sit
  // right at the edges; the wrapping div has overflow:visible so labels aren't clipped.
  const toMX = (wx: number) => ((wx - floorPlan.bounds.min[0]) / worldW) * dW;
  const toMY = (wz: number) => ((wz - floorPlan.bounds.min[1]) / worldH) * dH;

  const hasImage = hasFile && !imgFailed;
  const viewpoints = activePlan?.viewpoints ?? [];

  const onPanStart = (e: React.MouseEvent) => {
    if (zoom.scale <= 1.001) return; // nothing to pan when at base scale
    // Do not start a pan if the mousedown was on a clickable viewpoint dot.
    const target = e.target as Element | null;
    if (target?.closest('[data-vp-dot="1"]')) return;
    const startX = e.clientX, startY = e.clientY;
    const startPanX = zoom.panX, startPanY = zoom.panY;
    let moved = false;
    const rect = mapRef.current?.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
      setZoom((z) => clampZoom({ scale: z.scale, panX: startPanX + dx, panY: startPanY + dy }, rect?.width ?? 0, rect?.height ?? 0));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (moved) suppressNextClickRef.current = true;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onDoubleClick = () => setZoom({ scale: 1, panX: 0, panY: 0 });

  return (
    <div
      ref={mapRef}
      onMouseDown={onPanStart}
      onDoubleClick={onDoubleClick}
      style={{
        position: 'relative', width: dW, height: dH, borderRadius: 6,
        overflow: 'hidden',
        cursor: zoom.scale > 1.001 ? 'grab' : 'default',
        userSelect: 'none',
      }}
    >
    <div style={{ position: 'absolute', top: 0, left: 0, width: dW, height: dH, transform: `translate(${zoom.panX}px, ${zoom.panY}px) scale(${zoom.scale})`, transformOrigin: '0 0' }}>
      {hasImage && <img src={imageUrl} alt="" style={{ position: 'absolute', top: 0, left: 0, width: dW, height: dH, objectFit: 'fill', display: 'block', borderRadius: 6 }} />}
      <svg width={dW} height={dH} viewBox={`0 0 ${dW} ${dH}`} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
        {!hasImage && <rect x={0} y={0} width={dW} height={dH} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" strokeWidth={1} rx={4} />}
        {/* Sort: inactive first, active last so the active dot + its live cone always sit on top. */}
        {[...viewpoints].sort((a, b) => (a.id === activeVp ? 1 : 0) - (b.id === activeVp ? 1 : 0)).map((vp) => {
          const mx = vp.mapPosition ? vp.mapPosition[0] : 0;
          const mz = vp.mapPosition ? vp.mapPosition[1] : 0;
          const cx = toMX(mx), cy = toMY(mz);
          const isA = activeVp === vp.id;
          const fill = isA ? '#4caf50' : 'rgba(15,17,22,0.9)';
          const stroke = '#fff';
          const r = isA ? 6 : 5;
          const sw = isA ? 2 : 1.5;
          // Main cone — manual direction from the 図面 yaw slider (`mapYaw`). Same source
          // as the debug 図面 so both maps' main cones agree. Independent of `target`,
          // so saving the VR thumbnail / initial direction never spins the cone.
          const vpYaw = typeof vp.mapYaw === 'number' ? vp.mapYaw : 0;
          const yawRad = (vpYaw + 90) * Math.PI / 180;
          const cl = Math.min(dW, dH) * (isA ? 0.11 : 0.08);
          const cTip = { x: cx + Math.cos(yawRad) * cl, y: cy - Math.sin(yawRad) * cl };
          const cLL = { x: cx + Math.cos(yawRad + 0.45) * cl * 0.65, y: cy - Math.sin(yawRad + 0.45) * cl * 0.65 };
          const cRR = { x: cx + Math.cos(yawRad - 0.45) * cl * 0.65, y: cy - Math.sin(yawRad - 0.45) * cl * 0.65 };
          // Main cone is kept in the DOM but rendered transparent — we may want to bring
          // it back as a visible "saved direction" indicator later, so the structure stays.
          const mainCone = (
            <polygon
              points={`${cx},${cy} ${cLL.x},${cLL.y} ${cTip.x},${cTip.y} ${cRR.x},${cRR.y}`}
              fill="transparent"
              stroke="transparent"
            />
          );
          // Live-look cone, only on the active viewpoint. Green so it reads as
          // "where you're currently looking" — independent from the manual mapYaw.
          // Initial direction matches the blue cone (mapYaw / derive); after the user
          // mouse-drags, it follows live yaw. The live camera itself is never touched.
          let liveCone: React.ReactNode = null;
          if (isA) {
            const initialYaw = typeof vp.mapYaw === 'number' ? vp.mapYaw : 0;
            const lYawDeg = followLive ? yaw : initialYaw;
            const lYawRad = (lYawDeg + 90) * Math.PI / 180;
            const ll = Math.min(dW, dH) * 0.11;
            // Live-look fan (sector) — uniform radius gives a true circular leading edge.
            const fanSpread = 0.45; // half-angle in rad
            const lL = { x: cx + Math.cos(lYawRad + fanSpread) * ll, y: cy - Math.sin(lYawRad + fanSpread) * ll };
            const lR = { x: cx + Math.cos(lYawRad - fanSpread) * ll, y: cy - Math.sin(lYawRad - fanSpread) * ll };
            const liveFanPath = `M ${cx},${cy} L ${lL.x},${lL.y} A ${ll},${ll} 0 0 0 ${lR.x},${lR.y} Z`;
            liveCone = (
              <path
                d={liveFanPath}
                fill="rgba(76,175,80,0.4)"
                stroke="rgba(76,175,80,0.95)"
                strokeWidth={1.2}
                strokeLinejoin="round"
              />
            );
          }
          return (
            <g
              key={vp.id}
              data-vp-dot="1"
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                if (suppressNextClickRef.current) {
                  suppressNextClickRef.current = false;
                  e.stopPropagation();
                  return;
                }
                onViewpointClick(vp.id);
              }}
              role="button"
              aria-label={`${vp.label} に移動`}
            >
              {/* Invisible larger hit-target so the dot stays easy to click on touch / dense maps. */}
              <circle cx={cx} cy={cy} r={Math.max(r + 6, 12)} fill="transparent" />
              {mainCone}
              {liveCone}
              <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />
              <text x={cx} y={cy - r - 4} textAnchor="middle" fill={isA ? '#4caf50' : '#f5f7fa'} fontSize={11} fontWeight={isA ? 'bold' : 600} stroke="rgba(0,0,0,0.75)" strokeWidth={3} paintOrder="stroke">{vp.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
    {zoom.scale > 1.001 && (
      <div style={zoomBadge} title="ダブルクリックで等倍に戻す">
        ×{zoom.scale.toFixed(1)}
      </div>
    )}
    </div>
  );
}

/** Inline summary of basic info — type / roomType / area. Hidden when nothing is set. */
function InfoSummary({
  inline = false,
  visibility,
}: {
  inline?: boolean;
  visibility?: { overall?: boolean; heading?: boolean; area?: boolean; floor?: boolean; location?: boolean; notes?: boolean };
} = {}) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  if (!manifest) return null;
  const activePlan = manifest.plans?.find((p) => p.id === activePlanId);
  const info = activePlan?.info ?? {};

  if (inline) return <InfoOverview info={{ ...info, visibility: visibility ?? info.visibility }} />;

  const items: string[] = [];
  if (info.type) items.push(info.type);
  if (info.roomType) items.push(info.roomType);
  if (info.area) items.push(info.area);
  if (items.length === 0) return null;
  return <span style={infoSummary}>{items.join(' · ')}</span>;
}

type VisKey = 'overall' | 'heading' | 'area' | 'floor' | 'location' | 'notes';

/** Tiny sidebar handle for a closed big section (タイプ / カラー / MAP). Click to reopen. */
function ClosedSectionHandle({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button onClick={onOpen} style={overviewClosedBar} title={`${label} を表示`}>
      <span style={overviewClosedChevron}>▶</span>
      <span style={overviewClosedLabel}>{label}</span>
    </button>
  );
}

/**
 * タイプ選択ブロック — lists every plan in the manifest as a chip. Clicking switches
 * the active plan via the parent's `onPlanSwitch` (which owns the SceneManager).
 *
 * ラベル: 通常は「タイプ」。ただし「その他」プロジェクト × 3DGS モード時は「場所」を表示
 * (展示空間や屋外のように複数の場所を切替えるユースケースに合わせた呼称)。
 */
function TypeSelectBlock({ onPlanSwitch }: { onPlanSwitch?: (planId: string) => void }) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const hiddenSections = useUIStore((s) => s.hiddenSections);
  const setSectionHidden = useUIStore((s) => s.setSectionHidden);
  const projectType = useUIStore((s) => s.projectType);
  const viewMode = useUIStore((s) => s.viewMode);
  const plans = manifest?.plans ?? [];
  const blockLabel = projectType === 'other' && viewMode === 'splat' ? '場所' : 'タイプ';
  if (hiddenSections.includes('type')) {
    return <ClosedSectionHandle label={blockLabel} onOpen={() => setSectionHidden('type', false)} />;
  }
  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>{blockLabel}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('type', true)} style={overviewCloseBtn} title={`${blockLabel}を閉じる`}>×</button>
      </div>
      {plans.length === 0 ? (
        <div style={emptyHint}>プラン未追加 — デバッグ画面のプランタブで追加できます</div>
      ) : plans.length === 1 ? (
        <div style={chipRow}>
          <button style={{ ...chipBtn, ...chipBtnActive }} disabled title="単一プラン">{plans[0].label}</button>
        </div>
      ) : (
        <div style={chipRow}>
          {plans.map((p) => {
            const isA = p.id === activePlanId;
            return (
              <button
                key={p.id}
                onClick={() => onPlanSwitch?.(p.id)}
                style={{ ...chipBtn, ...(isA ? chipBtnActive : null) }}
                title={isA ? '使用中' : `${p.label} に切替`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * カラー選択ブロック — material/color variant picker. Each chip swaps the panorama
 * set used for every viewpoint in the active plan (same camera, same layout, only
 * the surface materials differ).
 */
function ColorSelectBlock() {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const activeColor = useUIStore((s) => s.activeColor);
  const setActiveColor = useUIStore((s) => s.setActiveColor);
  const hiddenSections = useUIStore((s) => s.hiddenSections);
  const setSectionHidden = useUIStore((s) => s.setSectionHidden);
  const activePlan = manifest?.plans?.find((p) => p.id === activePlanId);
  const variants = activePlan?.colorVariants ?? [];
  const showFurnitureTool = !!manifest?.variants?.furniture;
  const showLightingTool = !!manifest?.variants?.lighting;
  if (hiddenSections.includes('color')) {
    return <ClosedSectionHandle label="カラー" onOpen={() => setSectionHidden('color', false)} />;
  }
  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>カラー</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('color', true)} style={overviewCloseBtn} title="カラーを閉じる">×</button>
      </div>
      {variants.length === 0 ? (
        <div style={emptyHint}>素材バリエーション未設定 — デバッグ画面の「カラー」セクションから追加できます</div>
      ) : (
        <div style={chipRow}>
          <button
            onClick={() => setActiveColor(null)}
            style={{ ...colorChip, ...(activeColor === null ? colorChipActive : null) }}
            title="標準カラー"
          >
            <span style={{ ...colorSwatch, background: '#e5e7eb' }} />
            <span>標準</span>
          </button>
          {variants.map((v) => {
            const isA = v.id === activeColor;
            return (
              <button
                key={v.id}
                onClick={() => setActiveColor(v.id)}
                style={{ ...colorChip, ...(isA ? colorChipActive : null) }}
                title={v.label}
              >
                <span style={{ ...colorSwatch, background: v.swatch || '#a89372' }} />
                <span>{v.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 家具 / 情景 トグル — manifest.variants で有効になっている場合だけ */}
      {(showFurnitureTool || showLightingTool) && (
        <div style={colorInlineToggles}>
          {showFurnitureTool && (
            <div style={inlineToggleRow}>
              <span style={inlineToggleLabel}>家具</span>
              <FurnitureContent />
            </div>
          )}
          {showLightingTool && (
            <div style={inlineToggleRow}>
              <span style={inlineToggleLabel}>情景</span>
              <LightingContent />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 物件概要 sidebar block. Each row has a small × that hides only that row; the header
 * × closes the whole block (overall=false). When closed, the block collapses to a tiny
 * "▶ 物件概要" handle so the user can reopen it from the viewer.
 */
function OverviewBlock() {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const updateInfo = useSceneStore((s) => s.updateInfo);
  if (!manifest) return null;
  const activePlan = manifest.plans?.find((p) => p.id === activePlanId);
  const info = activePlan?.info ?? {};
  const vis = info.visibility ?? {};
  const isOverall = vis.overall !== false;
  const setVis = (key: VisKey, val: boolean) => updateInfo({ visibility: { ...vis, [key]: val } });

  // Closed (overall = false) → tiny restore handle.
  if (!isOverall) {
    return (
      <button onClick={() => setVis('overall', true)} style={overviewClosedBar} title="間取り概要を表示">
        <span style={overviewClosedChevron}>▶</span>
        <span style={overviewClosedLabel}>間取り概要</span>
      </button>
    );
  }

  // Are any items currently hidden? If so, expose a "全表示" restore link.
  const anyHidden = vis.heading === false || vis.area === false || vis.floor === false || vis.location === false || vis.notes === false;
  const restoreAll = () => updateInfo({ visibility: { overall: true } });

  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>間取り概要</span>
        {anyHidden && (
          <button onClick={restoreAll} style={overviewRestoreBtn} title="非表示にした項目を戻す" aria-label="全表示">+</button>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setVis('overall', false)} style={overviewCloseBtn} title="間取り概要を閉じる">×</button>
      </div>
      <InfoSummary inline visibility={vis} />
    </div>
  );
}

/**
 * Hierarchical property overview styled after the reference real-estate VR template:
 *   [type-badge] | heading (roomType / menu)
 *               | □ 専有面積 | XX㎡ (約YY坪)
 *               | ※sub-note
 *               | ・floor / location / free-form lines
 *
 * Uses only the fields available on `SceneInfo` (type / roomType / area / floor /
 * location / notes). Missing fields are skipped. The 坪 conversion runs whenever the
 * area string contains a numeric value (1㎡ ≈ 0.3025 坪, rounded to 2 decimals).
 */
function InfoOverview({
  info,
}: {
  info: { type?: string; roomType?: string; area?: string; floor?: string; location?: string; notes?: string; visibility?: { overall?: boolean; heading?: boolean; area?: boolean; floor?: boolean; location?: boolean; notes?: boolean } };
}) {
  const v = info.visibility ?? {};
  const showHeading = v.heading !== false && !!info.roomType;
  const showArea = v.area !== false && !!info.area;
  const showFloor = v.floor !== false && !!info.floor;
  const showLocation = v.location !== false && !!info.location;
  const showNotes = v.notes !== false && !!info.notes;
  if (!showHeading && !showArea && !showFloor && !showLocation && !showNotes) {
    return <span style={infoSummaryEmpty}>—</span>;
  }
  const badgeChar = (info.type || info.roomType || '').charAt(0).toUpperCase() || '·';
  const tsuboLabel = showArea ? formatTsubo(info.area) : null;

  return (
    <div style={overviewWrap}>
      <div style={overviewBadge}>
        <span style={overviewBadgeChar}>{badgeChar}</span>
        <span style={overviewBadgeLabel}>type</span>
      </div>
      <div style={overviewBody}>
        {showHeading && (
          <div style={overviewHeading}>{info.roomType}</div>
        )}
        {showArea && (
          <div style={overviewArea}>
            <span style={overviewAreaLabel}>□ 専有面積</span>
            <span style={overviewAreaSep}>｜</span>
            <span style={overviewAreaValue}>{info.area}</span>
            {tsuboLabel && <span style={overviewAreaSub}>{tsuboLabel}</span>}
          </div>
        )}
        {showFloor && info.floor && (
          <div style={overviewBullet}>・{info.floor}</div>
        )}
        {showLocation && info.location && (
          <div style={overviewBullet}>・{info.location}</div>
        )}
        {showNotes && info.notes && info.notes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length > 0 && (
          <ul style={overviewBullets}>
            {info.notes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line, i) => (
              <li key={i} style={overviewBullet}>・{line}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Convert a square-meter string ("113.62㎡" / "42.5") into a "(約XX.XX坪)" annotation. */
function formatTsubo(area: string | undefined): string | null {
  if (!area) return null;
  const m = area.match(/[\d.]+/);
  if (!m) return null;
  const sqm = parseFloat(m[0]);
  if (!isFinite(sqm) || sqm <= 0) return null;
  const tsubo = (sqm * 0.3025).toFixed(2);
  return `（約${tsubo}坪）`;
}

// ── Viewpoints ────────────────────────────────────────────────────

function ViewpointsContent({ onViewpointClick }: { onViewpointClick: (id: string) => void }) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const thumbs = useSceneStore((s) => s.viewpointThumbnails);
  const activeVp = useCameraStore((s) => s.activeViewpoint);
  if (!manifest) return null;
  const activePlan = manifest.plans?.find((p) => p.id === activePlanId);
  const planThumbs = activePlan?.thumbnails ?? {};
  const autoThumbs = (activePlanId && thumbs[activePlanId]) || {};
  const viewpoints = activePlan?.viewpoints ?? [];
  if (viewpoints.length === 0) {
    return (
      <div style={{ padding: '20px 10px', color: tokens.color.textMute, fontSize: 12, textAlign: 'center' }}>
        このプランのシーンはまだ追加されていません
      </div>
    );
  }
  return (
    <div style={vpGrid}>
      {viewpoints.map((vp) => {
        const isA = activeVp === vp.id;
        const thumb = planThumbs[vp.id] ?? autoThumbs[vp.id];
        return (
          <button
            key={vp.id}
            onClick={() => onViewpointClick(vp.id)}
            style={{ ...vpGridCard, ...(isA ? vpCardActive : null) }}
          >
            <div style={vpGridThumb}>
              {thumb ? <img src={thumb} alt="" style={vpThumbImg} /> : <div style={vpThumbPh}>…</div>}
            </div>
            <span style={{ ...vpGridLabel, ...(isA ? vpLabelActive : null) }}>{vp.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Movement mode (walk / fly) ───────────────────────────────────

/**
 * Sidebar block for switching between walk and fly movement modes. Replaces the old
 * floating toggle in the lower-left of the viewer (`ViewerOverlay.perspectiveToggle`),
 * which has been removed.
 *
 * Visibility of this block is gated upstream by the parent (3DGS only +
 * `viewerToolbar.movement !== false`).
 */
function MovementModeBlock() {
  const value = useUIStore((s) => s.movementMode);
  const setValue = useUIStore((s) => s.setMovementMode);
  const setSectionHidden = useUIStore((s) => s.setSectionHidden);
  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>移動モード</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('movement', true)} style={overviewCloseBtn} title="移動モードを閉じる">×</button>
      </div>
      <SegmentedToggle
        value={value}
        onChange={setValue}
        options={[
          { id: 'walk', label: '歩く' },
          { id: 'fly',  label: 'フライ' },
        ]}
      />
    </div>
  );
}

// ── AI image generation ──────────────────────────────────────────

/**
 * Resize a blob into a small JPEG `data:` URL for sidebar thumbnails.
 * Keeps the longer edge ≤ `maxSize` (default 256). JPEG quality 0.75 strikes a
 * good balance — the typical 1024×1024 PNG (~1 MB) becomes a ~15 KB thumb.
 */
async function makeThumbnail(blob: Blob, maxSize = 256): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = (e) => rej(new Error(`thumb img load: ${String(e)}`));
      i.src = url;
    });
    const ratio = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
    const w = Math.max(1, Math.round(img.naturalWidth * ratio));
    const h = Math.max(1, Math.round(img.naturalHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d ctx unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.75);
  } finally {
    URL.revokeObjectURL(url);
  }
}


/**
 * Full-canvas overlay for AI variants of `kind: 'screen'`. The variant is just a 2D
 * image (no panorama, no splat reproduction), so we layer it on top of the live
 * canvas and let the user dismiss it via × — that clears `activeAiId` and the live
 * scene is visible again. Mounted as a sibling of the canvas in Viewer / DebugViewer.
 */
export function AiScreenOverlay() {
  const activeAiId = useUIStore((s) => s.activeAiId);
  const setActiveAiId = useUIStore((s) => s.setActiveAiId);
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const plan = manifest?.plans?.find((p) => p.id === activePlanId);
  const entry = plan?.aiHistory?.find((e) => e.id === activeAiId);
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState({ scale: 1, panX: 0, panY: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setZoom({ scale: 1, panX: 0, panY: 0 });
    if (!entry || entry.kind !== 'screen' || !entry.image) return;
    const path = entry.image;
    (async () => {
      const url = idb.isIdbRef(path) ? await idb.resolveBlobRef(path) : path;
      if (alive) setSrc(url);
    })();
    return () => { alive = false; };
  }, [entry]);

  // Wheel zoom anchored at the cursor: solve for the new pan that keeps the world
  // point under the cursor in the same screen position before/after the scale change.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    setZoom((z) => {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.max(1, Math.min(8, z.scale * factor));
      if (next === z.scale) return z;
      const ratio = next / z.scale;
      const nx = cx - (cx - z.panX) * ratio;
      const ny = cy - (cy - z.panY) * ratio;
      return next === 1 ? { scale: 1, panX: 0, panY: 0 } : { scale: next, panX: nx, panY: ny };
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (zoom.scale === 1) return;
    draggingRef.current = { startX: e.clientX, startY: e.clientY, startPanX: zoom.panX, startPanY: zoom.panY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = draggingRef.current;
    if (!d) return;
    setZoom((z) => ({ ...z, panX: d.startPanX + (e.clientX - d.startX), panY: d.startPanY + (e.clientY - d.startY) }));
  };
  const onMouseUp = () => { draggingRef.current = null; };

  const fit = () => setZoom({ scale: 1, panX: 0, panY: 0 });

  const onDownload = () => {
    if (!entry || !src) return;
    // `src` is either a blob URL (idb-resolved) or a data URL; both work as <a download>.
    const safe = (entry.label || entry.prompt || 'ai').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const a = document.createElement('a');
    a.href = src;
    a.download = `${safe || 'ai'}_${entry.id}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  if (!entry || entry.kind !== 'screen' || !src) return null;
  return (
    <div
      ref={wrapRef}
      style={aiOverlayStyle}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <img
        src={src}
        alt={entry.prompt}
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          transform: `translate(${zoom.panX}px, ${zoom.panY}px) scale(${zoom.scale})`,
          transformOrigin: 'center center',
          cursor: zoom.scale > 1 ? 'grab' : 'default',
          userSelect: 'none',
        }}
      />
      <div style={aiOverlayToolbar}>
        <button type="button" onClick={onDownload} style={aiOverlayBtn} title="ダウンロード">⬇</button>
        <button type="button" onClick={fit} style={aiOverlayBtn} title="フィット (1×)">⤢</button>
        <button type="button" onClick={() => setActiveAiId(null)} style={aiOverlayBtn} title="閉じる">×</button>
      </div>
      {zoom.scale > 1 && <div style={aiOverlayZoomHud}>{zoom.scale.toFixed(1)}×</div>}
    </div>
  );
}

const aiOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: '#000',
  zIndex: 50,
  pointerEvents: 'auto',
  overflow: 'hidden',
};
const aiOverlayToolbar: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  display: 'flex',
  gap: 6,
};
const aiOverlayZoomHud: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 12,
  padding: '4px 10px',
  background: 'rgba(0,0,0,0.55)',
  color: '#fff',
  borderRadius: 12,
  fontSize: 11,
  fontWeight: 600,
  fontFamily: tokens.font.mono,
  letterSpacing: 0.5,
  pointerEvents: 'none',
};

/**
 * Translucent full-screen busy overlay shown while an AI generation request is
 * in flight. Blocks pointer events so the user can't double-fire generation;
 * dismisses automatically when `aiBusy` flips back to false. Mounted as a sibling
 * of the canvas in Viewer / DebugViewer.
 */
export function AiGeneratingOverlay() {
  const aiBusy = useUIStore((s) => s.aiBusy);
  if (!aiBusy) return null;
  return (
    <div style={aiBusyOverlay}>
      <div style={aiBusySpinner} />
      <div style={aiBusyText}>AI 画像を生成中…</div>
      <div style={aiBusySubText}>10〜30 秒ほどかかります</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const aiBusyOverlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: tokens.glass.surfaceStrong,
  zIndex: 80,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 14,
  pointerEvents: 'auto',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};
const aiBusySpinner: React.CSSProperties = {
  width: 44,
  height: 44,
  border: `3px solid ${tokens.color.border}`,
  borderTopColor: tokens.color.accent,
  borderRadius: '50%',
  animation: 'spin 0.9s linear infinite',
};
const aiBusyText: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: tokens.color.text,
  letterSpacing: 0.6,
  fontFamily: tokens.font.family,
};
const aiBusySubText: React.CSSProperties = {
  fontSize: 11.5,
  color: tokens.color.textMute,
  letterSpacing: 0.4,
  fontFamily: tokens.font.family,
  marginTop: -6,
  fontWeight: 500,
};

const aiOverlayBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: 'rgba(0,0,0,0.55)',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.3)',
  fontSize: 16,
  cursor: 'pointer',
  fontFamily: 'inherit',
  lineHeight: 1,
  padding: 0,
};




/**
 * AI 画像生成 — プロンプト入力 + 履歴一覧の統合ブロック。
 *
 * 「+ 新規生成」のような 2 段階 UI を踏まず、ブロックを開いた瞬間にプロンプトを書ける。
 * 生成は **現在の viewpoint の 360° パノラマ** に固定 (将来「他視点へ複製」をカード
 * メニューから後付けで提供)。履歴カードは色バリアントと同じ感覚で **クリック1発で切替** —
 * 元に戻すときは ⚪ "元" カードを選ぶ。
 *
 * 現状はバックエンド未接続のスタブ実装。生成ボタンは `aiBusy` を立てて 1.5 秒待機後に
 * ダミーエントリを履歴に積むだけで、本物の画像差し替えは行わない。Cloudflare Worker +
 * OpenAI 接続が出来次第、`onGenerate` の中身だけ差し替える。
 */
function AiImageGenBlock() {
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const manifest = useSceneStore((s) => s.manifest);
  const plan = manifest?.plans?.find((p) => p.id === activePlanId);
  const history = plan?.aiHistory ?? [];
  const addEntry = useSceneStore((s) => s.addAiGenerationEntry);
  const removeEntry = useSceneStore((s) => s.removeAiGenerationEntry);
  const activeAiId = useUIStore((s) => s.activeAiId);
  const setActiveAiId = useUIStore((s) => s.setActiveAiId);
  const aiBusy = useUIStore((s) => s.aiBusy);
  const setAiBusy = useUIStore((s) => s.setAiBusy);
  const setSectionHidden = useUIStore((s) => s.setSectionHidden);
  const [prompt, setPrompt] = useState('');
  const [refImages, setRefImages] = useState<string[]>([]);
  const refInputRef = useRef<HTMLInputElement>(null);

  // Multi-image API call. The first entry is treated by OpenAI as the primary
  // input; subsequent entries are additional references the model may sample
  // style / palette / texture from.
  const callOpenAI = async (sources: string[], p: string): Promise<string | null> => {
    const r = await fetch('/api/ai/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: sources, prompt: p }),
    });
    const j = await r.json() as { data?: { b64_json?: string }[]; error?: { message?: string } };
    if (!r.ok) {
      alert('生成エラー: ' + (j.error?.message ?? r.statusText));
      return null;
    }
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) {
      alert('生成結果が空でした');
      return null;
    }
    return `data:image/png;base64,${b64}`;
  };

  const onPickRefs = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const dataUrls: string[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const r = new FileReader();
      const url = await new Promise<string>((res, rej) => {
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(r.error ?? new Error('FileReader error'));
        r.readAsDataURL(f);
      });
      dataUrls.push(url);
    }
    // 3 枚までに制限（プライマリの画面スクショと合わせて合計 4 枚を AI に渡す）
    setRefImages((cur) => [...cur, ...dataUrls].slice(0, 3));
  };
  const removeRef = (idx: number) => setRefImages((cur) => cur.filter((_, i) => i !== idx));

  const generateScreen = async (p: string) => {
    if (!plan || !manifest) return;
    // Grab the live canvas pixels. `preserveDrawingBuffer: true` is set in app-init
    // so toDataURL works without a manual readPixels round-trip.
    const canvas = document.querySelector('canvas');
    if (!canvas) {
      alert('canvas が見つかりません');
      return;
    }
    const srcDataUrl = canvas.toDataURL('image/png');
    // Primary input = current screen, plus any reference images the user attached.
    const sources = [srcDataUrl, ...refImages];
    const resultDataUrl = await callOpenAI(sources, p);
    if (!resultDataUrl) return;
    const resultBlob = await (await fetch(resultDataUrl)).blob();
    const id = `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // Save the full-resolution PNG to IDB so the overlay can pull it back later.
    const blobKey = `ai:${manifest.id}:${plan.id}:${id}:screen`;
    await idb.saveBlob(blobKey, resultBlob);

    // Generate a small JPEG thumbnail (256px max). Storing the full PNG data URL
    // on the entry was costing megabytes per history card and tanking FPS as the
    // list grew — the small thumb keeps the sidebar light while the full image
    // stays in IDB / the user's Downloads folder.
    const thumbDataUrl = await makeThumbnail(resultBlob, 256);

    // Auto-download a "正規" copy to the browser's Downloads folder so the user
    // doesn't lose the full-resolution result if they clear IDB / switch projects.
    const safe = (p || 'ai').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const a = document.createElement('a');
    a.href = resultDataUrl;
    a.download = `${safe}_${id}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    addEntry({
      id,
      prompt: p,
      label: p.slice(0, 24),
      createdAt: Date.now(),
      kind: 'screen',
      image: `${idb.IDB_REF_PREFIX}${blobKey}`,
      thumbnail: thumbDataUrl,
    });
    setActiveAiId(id);
  };

  const onGenerate = async () => {
    const p = prompt.trim();
    if (!p || aiBusy) return;
    if (!plan || !manifest) {
      alert('プランが選択されていません');
      return;
    }
    setAiBusy(true);
    try {
      await generateScreen(p);
      setPrompt('');
      setRefImages([]);
    } catch (e) {
      alert('生成失敗: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setAiBusy(false);
    }
  };

  const onDelete = (id: string) => {
    if (!window.confirm('この生成を削除しますか？')) return;
    removeEntry(id);
    if (activeAiId === id) setActiveAiId(null);
  };

  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>AI 画像生成</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('aiGenerate', true)} style={overviewCloseBtn} title="AI 画像生成を閉じる">×</button>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="例: フローリングを白いオークに"
        rows={2}
        disabled={aiBusy}
        style={aiPromptStyle}
      />
      <div style={aiRefRow}>
        {refImages.map((url, i) => (
          <div key={i} style={aiRefThumb}>
            <img src={url} alt="" style={aiRefImg} />
            <button type="button" onClick={() => removeRef(i)} style={aiRefRemove} title="削除">×</button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => refInputRef.current?.click()}
          disabled={aiBusy || refImages.length >= 3}
          style={aiRefAddBtn}
          title="参照画像を追加 (最大 3 枚)"
        >+</button>
        <input
          ref={refInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { void onPickRefs(e.target.files); e.target.value = ''; }}
        />
      </div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={aiBusy || prompt.trim().length === 0}
        style={aiGenerateBtn(aiBusy || prompt.trim().length === 0)}
      >
        {aiBusy ? '生成中…' : '生成'}
      </button>
      <div style={vpGrid}>
        {history.map((e) => {
          const isA = activeAiId === e.id;
          return (
            <div key={e.id} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setActiveAiId(e.id)}
                style={{ ...vpGridCard, ...(isA ? vpCardActive : null), width: '100%' }}
                title={e.prompt}
              >
                <div style={vpGridThumb}>
                  {e.thumbnail ? <img src={e.thumbnail} alt="" style={vpThumbImg} /> : <div style={vpThumbPh}>…</div>}
                </div>
              </button>
              <div style={aiCardActions}>
                <button type="button" onClick={() => onDelete(e.id)} style={aiCardActionBtn} title="削除">✕</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const aiRefRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 4,
};
const aiRefThumb: React.CSSProperties = {
  position: 'relative',
  width: 40,
  height: 40,
  borderRadius: 4,
  overflow: 'hidden',
  border: '1px solid rgba(0,0,0,0.15)',
};
const aiRefImg: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};
const aiRefRemove: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  width: 14,
  height: 14,
  fontSize: 9,
  lineHeight: 1,
  background: 'rgba(0,0,0,0.6)',
  color: '#fff',
  border: 'none',
  borderRadius: '0 0 0 4px',
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
};
const aiRefAddBtn: React.CSSProperties = {
  width: 40,
  height: 40,
  fontSize: 18,
  fontWeight: 300,
  lineHeight: 1,
  background: tokens.gradient.surface,
  color: tokens.color.textFaint,
  border: `1px dashed ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  cursor: 'pointer',
  fontFamily: tokens.font.family,
  padding: 0,
  outline: 'none',
};

const aiPromptStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  fontSize: 12,
  padding: '10px 14px',
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontFamily: tokens.font.family,
  color: tokens.color.text,
  background: tokens.gradient.track,
  boxSizing: 'border-box',
  minHeight: 56,
  outline: 'none',
  boxShadow: tokens.shadow.inset,
};

const aiGenerateBtn = (disabled: boolean): React.CSSProperties => ({
  marginTop: 6,
  width: '100%',
  padding: '10px 14px',
  fontSize: 12.5,
  fontWeight: 700,
  background: disabled ? tokens.gradient.neutral : tokens.gradient.accent,
  color: tokens.color.text,
  border: `1px solid ${disabled ? tokens.color.border : tokens.color.accentBorder}`,
  borderRadius: tokens.radius.pill,
  boxShadow: disabled ? tokens.shadow.glass : tokens.shadow.glassAccent,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: tokens.font.family,
  letterSpacing: 0.4,
  outline: 'none',
});

const aiCardActions: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  display: 'flex',
  gap: 1,
};

const aiCardActionBtn: React.CSSProperties = {
  width: 16,
  height: 16,
  fontSize: 9,
  lineHeight: 1,
  background: 'rgba(255,255,255,0.85)',
  border: '1px solid rgba(0,0,0,0.15)',
  borderRadius: 3,
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
  color: tokens.color.text,
};

// ── Quality preset ───────────────────────────────────────────────

/**
 * 画質プリセット (LOW / MID / HIGH)。中身は SH bands / 描画スケール / radial sort の
 * 組合せで、`scene-manager.ts` の `applyQualityMode` が当てる。初期値はデバイス判定
 * (mobile→LOW, low-end→MID, それ以外→HIGH) で `localStorage` 保存。
 *
 * 真の octree LOD ではない (= splat 数は変わらない) — モバイルや低スペック PC で
 * fragment コストとピクセル fill rate を落として FPS を稼ぐ用途。
 */
function QualityBlock() {
  const value = useUIStore((s) => s.qualityMode);
  const setValue = useUIStore((s) => s.setQualityMode);
  const setSectionHidden = useUIStore((s) => s.setSectionHidden);
  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>画質</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('quality', true)} style={overviewCloseBtn} title="画質を閉じる">×</button>
      </div>
      <SegmentedToggle
        value={value}
        onChange={setValue}
        options={[
          { id: 'low',  label: 'Low' },
          { id: 'mid',  label: 'Mid' },
          { id: 'high', label: 'High' },
        ]}
      />
    </div>
  );
}

// ── Mobile tools (touch-device-only) ─────────────────────────────

/** True when the page is running on a touch / coarse-pointer device. Mirrors
 *  the gate `MobileJoystick` uses. */
function useTouchDevice(): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(pointer: coarse)');
    setMatch(mq.matches);
    const onChange = () => setMatch(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return match;
}

/** Portrait (= 縦向き) なら true。回転で値が切り替わるので useMobileSidebarPlacement の
 *  根拠に使う。デスクトップは isTouch=false 経由で無効化される想定なので素直に
 *  `(orientation: portrait)` の真偽だけ拾う。 */
function usePortraitOrientation(): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(orientation: portrait)');
    setMatch(mq.matches);
    const onChange = () => setMatch(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return match;
}

/**
 * Mobile-only sidebar block. Mouse-wheel / keyboard speed controls don't exist
 * on phones, so we surface a continuous slider for walk speed. The active
 * SceneManager exposes `setMoveSpeed` via the `window.__sceneManager` global,
 * which both engines write into the controller's `options.moveSpeed`.
 *
 * 値は `useUIStore.mobileMoveSpeed` に保持 — 他セクションの開閉や設定変更で
 * 当ブロックがアンマウント／再マウントしても、ユーザーが設定した値が
 * セッション中ずっと維持される (リロードまで)。
 */
const MOBILE_SPEED_MIN = 0.5;
const MOBILE_SPEED_MAX = 20;

function MobileToolsBlock({ onClose }: { onClose: () => void }) {
  const speed = useUIStore((s) => s.mobileMoveSpeed);
  const setSpeed = useUIStore((s) => s.setMobileMoveSpeed);

  const apply = (s: number) => {
    setSpeed(s);
    const sm = (window as unknown as { __sceneManager?: { setMoveSpeed?: (s: number) => void } }).__sceneManager;
    sm?.setMoveSpeed?.(s);
  };

  // Push the current stored speed into the engine whenever this block remounts.
  // Reading from the store (not a constant) means a re-mount after closing /
  // re-opening the section preserves the user's last value instead of snapping
  // back to the default.
  useEffect(() => {
    const sm = (window as unknown as { __sceneManager?: { setMoveSpeed?: (s: number) => void } }).__sceneManager;
    sm?.setMoveSpeed?.(speed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>移動スピード</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={overviewCloseBtn} title="閉じる">×</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span style={{ fontSize: 10.5, color: tokens.color.textMute }}>遅</span>
        <input
          type="range"
          min={MOBILE_SPEED_MIN}
          max={MOBILE_SPEED_MAX}
          step={0.5}
          value={speed}
          onChange={(e) => apply(parseFloat(e.target.value))}
          style={{ flex: 1, accentColor: tokens.color.accent }}
        />
        <span style={{ fontSize: 10.5, color: tokens.color.textMute }}>速</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, fontSize: 11, color: tokens.color.textMute, fontFamily: 'monospace' }}>
        <span>{MOBILE_SPEED_MIN.toFixed(1)} m/s</span>
        <span style={{ fontWeight: 700, color: tokens.color.accent }}>{speed.toFixed(1)} m/s</span>
        <span>{MOBILE_SPEED_MAX.toFixed(1)} m/s</span>
      </div>
    </div>
  );
}

// ── Head tracking ────────────────────────────────────────────────

/**
 * Sidebar block to toggle head tracking — starts the browser-side MediaPipe
 * FaceLandmarker tracker on the webcam and drives the camera with the user's head
 * pose. No external process needed. The first toggle ON triggers a webcam permission
 * prompt; "calibrating…" until the first face frame, then "tracking" once the
 * zero-point is captured.
 */
function DemoModeBlock() {
  const enabled = useUIStore((s) => s.demoMode);
  const setEnabled = useUIStore((s) => s.setDemoMode);
  const setSectionHidden = useUIStore((s) => s.setSectionHidden);
  const connected = useTrackingStore((s) => s.connected);
  const status: string = !enabled ? 'OFF' : connected ? '取得中 (face)' : 'カメラ準備中…';
  const statusColor = !enabled ? 'rgba(0,0,0,0.4)' : connected ? '#15803d' : '#b45309';
  return (
    <div style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span style={blockHeading}>ヘッドトラッキング</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: statusColor, fontWeight: 600 }}>{status}</span>
        <button onClick={() => setSectionHidden('tracking', true)} style={{ ...overviewCloseBtn, marginLeft: 6 }} title="ヘッドトラッキングを閉じる">×</button>
      </div>
      <SegmentedToggle
        value={enabled ? 'on' : 'off'}
        onChange={(v) => setEnabled(v === 'on')}
        options={[
          { id: 'off', label: 'OFF' },
          { id: 'on',  label: 'ON' },
        ]}
      />
      {enabled && (
        <button
          type="button"
          onClick={() => calibrateHeadTracker()}
          disabled={!connected}
          style={{
            marginTop: 6,
            width: '100%',
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 600,
            background: connected ? '#ffffff' : 'rgba(0,0,0,0.04)',
            border: `1px solid ${connected ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.08)'}`,
            color: connected ? '#1f2937' : 'rgba(0,0,0,0.35)',
            borderRadius: 6,
            cursor: connected ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
          }}
          title="今の頭の向きを基準にゼロ点を取り直す"
        >
          ↻ 中央リセット
        </button>
      )}
      {enabled && (
        <div style={{ fontSize: 10.5, color: 'rgba(0,0,0,0.55)', marginTop: 6, lineHeight: 1.5 }}>
          ブラウザ内蔵 (MediaPipe)。初回 ON でカメラ許可。ずれたら「中央リセット」で今の向きを正面として取り直し。
        </div>
      )}
    </div>
  );
}

// ── Furniture / Lighting ──────────────────────────────────────────

function FurnitureContent() {
  const value = useUIStore((s) => s.furniture);
  const setValue = useUIStore((s) => s.setFurniture);
  return <SegmentedToggle value={value} onChange={setValue} options={[{ id: 'on', label: 'あり' }, { id: 'off', label: 'なし' }]} />;
}

function LightingContent() {
  const value = useUIStore((s) => s.lighting);
  const setValue = useUIStore((s) => s.setLighting);
  return <SegmentedToggle value={value} onChange={setValue} options={[{ id: 'day', label: '昼' }, { id: 'night', label: '夜' }]} />;
}

function SegmentedToggle<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 5, background: tokens.glass.surfaceStrong, backdropFilter: tokens.backdrop, WebkitBackdropFilter: tokens.backdrop, borderRadius: tokens.radius.pill, border: `1px solid ${tokens.color.border}`, boxShadow: tokens.shadow.glass }}>
      {options.map((o) => {
        const isA = value === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            style={{
              flex: 1,
              padding: '8px 14px',
              // Long-hand border so re-renders don't leak the previous
              // active borderColor onto the inactive state.
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: isA ? tokens.color.accentBorder : 'transparent',
              borderRadius: tokens.radius.pill,
              background: isA ? tokens.gradient.accent : 'transparent',
              color: tokens.color.text,
              boxShadow: isA ? tokens.shadow.glassAccent : 'none',
              fontWeight: isA ? 700 : 600,
              fontSize: 12.5,
              cursor: 'pointer',
              fontFamily: tokens.font.family,
              transition: `background ${tokens.transition}, color ${tokens.transition}, box-shadow ${tokens.transition}, border-color ${tokens.transition}`,
              whiteSpace: 'nowrap',
              minWidth: 0,
              outline: 'none',
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

// ── Fullscreen ────────────────────────────────────────────────────

/** Speaker icon button in the sidebar title row — toggles ambient audio mute.
 *  Available in both 3DGS and panorama modes (BGM is mode-independent). The
 *  author can still hide the icon via Debug → ツールバー表示 → 環境音アイコン. */
function AmbientAudioToggle() {
  const muted = useUIStore((s) => s.audioMuted);
  const setMuted = useUIStore((s) => s.setAudioMuted);
  const allowed = useSceneStore((s) => s.manifest?.viewerToolbar?.audio) === true;
  if (!allowed) return null;
  return (
    <button
      onClick={() => setMuted(!muted)}
      style={titleIconBtn}
      title={muted ? '環境音を再生' : '環境音をミュート'}
    >
      <span style={titleIconGlyph}>
        {muted ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        )}
      </span>
    </button>
  );
}

/**
 * タグ (3D ピン) の表示 / 非表示を切り替えるアイコン。
 * 制作者が `viewerToolbar.pins === true` で opt-in したときだけ親側で render
 * される。タップで `useUIStore.showPins` をトグル → ScenePinsOverlay の出し分け。
 */
function PinsVisibilityToggle() {
  const showPins = useUIStore((s) => s.showPins);
  const setShowPins = useUIStore((s) => s.setShowPins);
  return (
    <button
      onClick={() => setShowPins(!showPins)}
      style={{ ...titleIconBtn, ...(showPins ? null : { opacity: 0.45 }) }}
      title={showPins ? 'タグを非表示にする' : 'タグを表示する'}
    >
      <span style={titleIconGlyph}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
          <circle cx="12" cy="9" r="2.5" />
        </svg>
      </span>
    </button>
  );
}

function FullscreenButton({ compact = false, iconOnly = false }: { compact?: boolean; iconOnly?: boolean } = {}) {
  const [isFs, setIsFs] = useState<boolean>(typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  const Icon = isFs ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v4a1 1 0 0 1-1 1H3M21 8h-4a1 1 0 0 1-1-1V3M3 16h4a1 1 0 0 1 1 1v4M16 21v-4a1 1 0 0 1 1-1h4"/>
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5"/>
    </svg>
  );
  if (iconOnly) {
    return (
      <button onClick={toggle} title={isFs ? 'フルスクリーン解除' : '拡大 (フルスクリーン)'} style={titleIconBtn}>
        <span style={titleIconGlyph}>{Icon}</span>
      </button>
    );
  }
  return (
    <button
      onClick={toggle}
      title={isFs ? 'フルスクリーン解除' : '拡大 (フルスクリーン)'}
      style={compact ? miniIconBtn : iconBtn}
    >
      <span style={iconGlyph}>{Icon}</span>
      <span style={compact ? miniIconLabel : iconLabel}>拡大</span>
    </button>
  );
}

// ── styles ────────────────────────────────────────────────────────

import type { SidebarSize } from '../core/types';

/**
 * Resolve the sidebar's outer style for the size preset.
 *
 * - `large` — fills the viewport top-to-bottom (`top:0; bottom:0`). Default.
 * - `small` — same 320px width, but shrinks vertically to fit its content
 *   (no `bottom`, `height: auto`). The bottom edge floats with a soft shadow so
 *   the panel reads as a card rather than a full-height bar.
 */
type SidebarPlacement = 'left' | 'right' | 'portrait';

function sidebarSizeStyles(size: SidebarSize, placement: SidebarPlacement = 'left') {
  const isSmall = size === 'small';
  // placement ごとのアンカー / 幅 / 縁取り。
  //  - left      : 従来 (PC) — 左に張り付き。
  //  - right     : スマホ横向き — 右側フル高。
  //  - portrait  : スマホ縦向き — **上端フル幅のトップバー** (`top:0; left:0; right:0`)。
  //                左右に隙間を作らない (ユーザー指定: 右寄せの隙間を消す = 横一杯)。
  //                閉じハンドルだけは別 `collapsedHandleStyle` 側で右下に置く。
  const isRight = placement === 'right';
  const isPortrait = placement === 'portrait';
  const anchors: React.CSSProperties = isPortrait
    ? { top: 0, left: 0, right: 0, ...(isSmall ? { bottom: 'auto' as const, height: 'auto' as const } : { bottom: 0 }) }
    : isRight
      ? { top: 0, left: 'auto', right: 0, ...(isSmall ? { bottom: 'auto' as const, height: 'auto' as const } : { bottom: 0 }) }
      : { top: 0, left: 0, ...(isSmall ? { bottom: 'auto' as const, height: 'auto' as const } : { bottom: 0 }) };
  // 縦向きはトップバーなので `auto` で left/right に吸い付かせる。
  // 横向き / デスクトップは 320 固定。
  const width: React.CSSProperties['width'] = isPortrait ? 'auto' : 320;
  // 縁取り: 区切り線は「キャンバスと接する辺」だけに引く。
  //   left → 右辺、right → 左辺、portrait → 下辺 (トップバー)。
  const borderEdge: React.CSSProperties = isPortrait
    ? { borderBottom: `1px solid ${tokens.color.border}` }
    : isRight
      ? { borderLeft: `1px solid ${tokens.color.border}` }
      : { borderRight: `1px solid ${tokens.color.border}` };
  return {
    sidebar: {
      position: 'absolute',
      // 横向きスマホ等で viewport 高が低い時に下部が見切れないよう、必ず viewport 内に収め
      // 中身は `sidebarScrollArea` 側でスクロールさせる。`100dvh` は iOS Safari のアドレスバー
      // 出入りに追従する viewport 単位 (fallback で 100vh)。
      maxHeight: '100dvh',
      ...anchors,
      width,
      background: tokens.glass.surfaceStrong,
      backdropFilter: tokens.backdrop,
      WebkitBackdropFilter: tokens.backdrop,
      ...borderEdge,
      // `small` は浮いた下端の見切りに `borderBottom` を入れる。
      ...(isSmall ? { borderBottom: `1px solid ${tokens.color.border}` } : {}),
      boxShadow: tokens.shadow.glass,
      display: 'flex',
      flexDirection: 'column',
      zIndex: 6,
      fontFamily: tokens.font.family,
    } as React.CSSProperties,
  };
}

/** タイトルは固定したまま、下のブロック群だけスクロールさせるラッパー。
 *  `minHeight: 0` がないと flex 子要素は内容分まで膨らんで `overflow` が効かない。 */
const sidebarScrollArea: React.CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  WebkitOverflowScrolling: 'touch',
};

const sidebarTitleBlock: React.CSSProperties = {
  padding: '12px 14px 12px 16px',
  borderBottom: `1px solid ${tokens.color.border}`,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const sidebarTitle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 0.3,
  color: tokens.color.text,
};

const titleIconBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: tokens.gradient.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.textMute,
  cursor: 'pointer',
  padding: 0,
  fontFamily: tokens.font.family,
  flexShrink: 0,
  boxShadow: 'inset 0 1px 0.5px rgba(255,255,255,0.85)',
  outline: 'none',
};

const titleIconGlyph: React.CSSProperties = {
  width: 16,
  height: 16,
  display: 'inline-flex',
};

const collapsedHandle: React.CSSProperties = {
  position: 'absolute',
  top: 16, left: 16,
  width: 36, height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: tokens.glass.surfaceStrong,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.text,
  cursor: 'pointer',
  padding: 0,
  fontFamily: tokens.font.family,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  boxShadow: tokens.shadow.glass,
  zIndex: 6,
  outline: 'none',
};

/** placement に応じて閉じハンドルの上下左右を切り替える。
 *  - `portrait` : サイドバー本体は右上だが、閉じハンドルだけは「右下」固定 (ユーザー指定)。
 *  - `right`    : 横向き — 右上。
 *  - `left`     : PC — 左上 (既定)。 */
function collapsedHandleStyle(placement: SidebarPlacement): React.CSSProperties {
  if (placement === 'portrait') {
    return { ...collapsedHandle, top: 'auto', left: 'auto', right: 16, bottom: 16 };
  }
  if (placement === 'right') {
    return { ...collapsedHandle, left: 'auto', right: 16 };
  }
  return collapsedHandle;
}

const sidebarBlock: React.CSSProperties = {
  padding: '10px 16px',
  borderBottom: `1px solid ${tokens.color.border}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  flexShrink: 0,
};

const sidebarMapBlock: React.CSSProperties = {
  padding: '10px 16px',
  borderBottom: `1px solid ${tokens.color.border}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  overflow: 'hidden',
  flexShrink: 0,
};

const blockHeading: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1.2,
  color: tokens.color.text,
  textTransform: 'uppercase',
  fontFamily: tokens.font.mono,
};

const colorInlineToggles: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 6,
  paddingTop: 8,
  borderTop: `1px solid ${tokens.color.border}`,
};

const inlineToggleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const inlineToggleLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.6,
  color: tokens.color.textMute,
  width: 32,
  flexShrink: 0,
};

const miniIconBtn: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  background: 'transparent',
  color: tokens.color.text,
  border: '1px solid transparent',
  borderRadius: tokens.radius.md,
  cursor: 'pointer',
  fontFamily: tokens.font.family,
  transition: `background ${tokens.transition}, color ${tokens.transition}, border-color ${tokens.transition}`,
  textAlign: 'left',
  width: '100%',
  // Each button takes an equal share of the toolbar's flexed height — together
  // they fully cover the toolbar with no leftover blank space.
  flex: 1,
  minHeight: 0,
  outline: 'none',
};

const miniIconLabel: React.CSSProperties = {
  fontSize: 13,
  letterSpacing: 0.3,
  fontWeight: 600,
};


// Legacy iconBtn styles kept for any consumer that still uses the original full-size buttons.
const iconBtn: React.CSSProperties = {
  width: 56,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
  padding: '8px 4px',
  background: 'transparent',
  color: tokens.color.text,
  border: '1px solid transparent',
  borderRadius: tokens.radius.md,
  cursor: 'pointer',
  fontFamily: tokens.font.family,
  transition: `background ${tokens.transition}, color ${tokens.transition}, border-color ${tokens.transition}`,
  outline: 'none',
};

const iconGlyph: React.CSSProperties = {
  width: 22,
  height: 22,
  display: 'inline-flex',
};

const iconLabel: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.3,
  fontWeight: 500,
};

// 3-column grid: thumbnail on top, room name below.
const vpGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 6,
};

const vpGridCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 4,
  padding: 4,
  background: tokens.gradient.surface,
  // Long-hand split (see other components) — shorthand `border` mixed
  // with `borderColor` overlay leaks the active color onto inactive
  // cards after a state change.
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: tokens.color.border,
  borderRadius: tokens.radius.sm,
  cursor: 'pointer',
  fontFamily: tokens.font.family,
  color: tokens.color.text,
  transition: `background ${tokens.transition}, border-color ${tokens.transition}, box-shadow ${tokens.transition}`,
  outline: 'none',
};

const vpGridThumb: React.CSSProperties = {
  width: '100%',
  aspectRatio: '4 / 3',
  borderRadius: tokens.radius.sm,
  overflow: 'hidden',
  background: tokens.color.surfaceSoft,
  border: `1px solid ${tokens.color.border}`,
};

const vpGridLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.2,
  textAlign: 'center',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: tokens.color.text,
};

const vpCardActive: React.CSSProperties = {
  background: tokens.gradient.accent,
  borderColor: tokens.color.accentBorder,
  boxShadow: tokens.shadow.glassAccent,
};

const vpThumbImg: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const vpThumbPh: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: tokens.color.textFaint,
  fontSize: 12,
};

const vpLabelActive: React.CSSProperties = {
  color: tokens.color.text,
  fontWeight: 700,
};

const zoomBadge: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  padding: '3px 8px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  color: tokens.color.text,
  background: 'rgba(255,255,255,0.85)',
  border: `1px solid ${tokens.color.border}`,
  borderRadius: 4,
  fontFamily: tokens.font.mono,
  pointerEvents: 'none',
};

const infoSummary: React.CSSProperties = {
  marginLeft: 10,
  paddingLeft: 10,
  borderLeft: `1px solid ${tokens.color.border}`,
  fontSize: 11,
  fontWeight: 500,
  color: tokens.color.textMute,
  letterSpacing: 0.3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  flexShrink: 1,
};

const infoSummaryEmpty: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textFaint,
};

const overviewWrap: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
};

const overviewBadge: React.CSSProperties = {
  width: 56,
  height: 56,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#a89372',
  color: '#ffffff',
  borderRadius: 4,
  letterSpacing: 0.5,
};

const overviewBadgeChar: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  lineHeight: 1,
  fontFamily: 'Georgia, "Times New Roman", serif',
};

const overviewBadgeLabel: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: 0.6,
  marginTop: 2,
  textTransform: 'lowercase',
  opacity: 0.92,
};

const overviewBody: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const overviewHeading: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 0.3,
  color: tokens.color.text,
  lineHeight: 1.3,
};

const overviewArea: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  gap: 4,
  fontSize: 12,
  color: tokens.color.text,
  lineHeight: 1.4,
};

const overviewAreaLabel: React.CSSProperties = {
  fontWeight: 500,
};

const overviewAreaSep: React.CSSProperties = {
  color: tokens.color.textMute,
};

const overviewAreaValue: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
};

const overviewAreaSub: React.CSSProperties = {
  fontSize: 10.5,
  color: tokens.color.textMute,
  fontWeight: 400,
};

const overviewBullets: React.CSSProperties = {
  margin: 0,
  padding: 0,
  marginTop: 2,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const overviewBullet: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.text,
  lineHeight: 1.5,
};

const overviewHeaderRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const overviewCloseBtn: React.CSSProperties = {
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: tokens.gradient.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.textMute,
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
  fontFamily: tokens.font.family,
  boxShadow: tokens.shadow.glass,
  outline: 'none',
};

const overviewRestoreBtn: React.CSSProperties = {
  background: tokens.gradient.accent,
  border: `1px solid ${tokens.color.accentBorder}`,
  color: tokens.color.text,
  borderRadius: tokens.radius.pill,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.3,
  padding: '3px 10px',
  cursor: 'pointer',
  fontFamily: tokens.font.family,
  boxShadow: tokens.shadow.glassAccent,
  outline: 'none',
};

// Closed (master-off) state — a slim handle that re-opens the block.
const overviewClosedBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 16px',
  borderBottom: `1px solid ${tokens.color.border}`,
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: tokens.color.text,
  flexShrink: 0,
};

const overviewClosedChevron: React.CSSProperties = {
  fontSize: 9,
  color: tokens.color.textMute,
  width: 10,
};

const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const chipBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: tokens.gradient.surface,
  // Long-hand split so the active overlay's `borderColor` doesn't leak
  // back onto the inactive state after a re-render.
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: tokens.color.border,
  borderRadius: tokens.radius.pill,
  color: tokens.color.text,
  fontSize: 12,
  fontFamily: tokens.font.family,
  cursor: 'pointer',
  fontWeight: 600,
  letterSpacing: 0.2,
  boxShadow: tokens.shadow.glass,
  outline: 'none',
  transition: `background ${tokens.transition}, border-color ${tokens.transition}, color ${tokens.transition}, box-shadow ${tokens.transition}`,
};

const chipBtnActive: React.CSSProperties = {
  background: tokens.gradient.accent,
  borderColor: tokens.color.accentBorder,
  color: tokens.color.text,
  fontWeight: 700,
  boxShadow: tokens.shadow.glassAccent,
};

const colorChip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 12px 5px 5px',
  background: tokens.gradient.surface,
  // Long-hand split for the same React shorthand-vs-longhand bug.
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: tokens.color.border,
  borderRadius: tokens.radius.pill,
  color: tokens.color.text,
  fontSize: 12,
  fontFamily: tokens.font.family,
  cursor: 'pointer',
  fontWeight: 600,
  boxShadow: tokens.shadow.glass,
  outline: 'none',
  transition: `background ${tokens.transition}, border-color ${tokens.transition}, color ${tokens.transition}, box-shadow ${tokens.transition}`,
};

const colorChipActive: React.CSSProperties = {
  background: tokens.gradient.accent,
  borderColor: tokens.color.accentBorder,
  color: tokens.color.text,
  fontWeight: 700,
  boxShadow: tokens.shadow.glassAccent,
};

const colorSwatch: React.CSSProperties = {
  display: 'inline-block',
  width: 16,
  height: 16,
  borderRadius: '50%',
  border: '1px solid rgba(0,0,0,0.15)',
};

const emptyHint: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(31,41,55,0.45)',
  lineHeight: 1.5,
  padding: '4px 0',
};

const overviewClosedLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 1.0,
  color: tokens.color.textMute,
  textTransform: 'uppercase',
};

