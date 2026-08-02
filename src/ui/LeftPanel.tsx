import React, { useEffect, useRef, useState } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { useUIStore } from '../store/ui-store';
import { useTrackingStore } from '../store/tracking-store';
import { calibrateHeadTracker } from '../utils/head-tracker';
import { resolveScenePath } from '../core/scene-manifest';
import { DEFAULT_SIDEBAR_ORDER, type OrderableSidebarBlock } from '../core/types';
import * as idb from '../utils/idb';
import { getOpenAIKey, getGeminiKey, getSelectedModelId, setSelectedModelId } from '../utils/api-keys';
import { getModelById, PROVIDERS, modelsForProvider, firstModelForProvider, type AiProvider } from '../utils/ai-models';
import { getAuthHeader } from '../utils/auth';
import { useMediaQuery } from '../utils/use-media-query';
import { tokens } from './design-tokens';
import { SegmentedControl, Tile, surfaceClass, IconClose, IconPlus, IconSettings, IconTrash } from './components';
import { fanPath } from './map-fan';

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
  // 「product」(単体 showroom) はさらに視点 / 図面 / 移動モードも丸ごと不要。
  const projectType = useUIStore((s) => s.projectType);
  const isOther = projectType === 'other';
  const isProduct = projectType === 'product';
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
  const showType       = tb.type       === true && !isProduct;
  const showOverview   = tb.overview   === true && !isOther && !isProduct;
  const showViewpoints = tb.viewpoints === true && !isProduct;
  const showColor      = tb.color      === true && !isOther;
  const showMap        = tb.map        === true && !isProduct;
  // 拡大 (fullscreen) はデスクトップ専用。スマホ (touch) は OS 側の全画面 UI と
   // 衝突するうえ、サイドバー幅が限られるのでアイコンを出さない。
  const showFullscreen = tb.fullscreen === true && !isTouchDevice;
  // タグ (ピン) は viewerToolbar.pins で制作者が opt-in したときだけアイコンが出る。
  // タップで `useUIStore.showPins` が反転 → ScenePinsOverlay の出し分けに使う。
  const showPinsToggle = tb.pins === true;
  const showMovement   = tb.movement   === true && viewMode === 'splat' && !isProduct;
  // ヘッドトラッキングは VR モードでも有効 (パノラマ視点回転に使える)。
  const showDemo       = tb.demo       === true;
  const showQuality    = tb.quality    !== false && viewMode === 'splat';
  const showAiGenerate = tb.aiGenerate === true;
  // Mobile-only block: only relevant on touch devices, so we gate by
  // `pointer: coarse` regardless of the toolbar config. The author can still
  // suppress it explicitly with `tb.mobile === false`.
  // `isTouchDevice` は上で placement のために評価済みなので再代入はしない。
  // showroom (product) は移動が無いので「移動スピード」スライダーも出さない。
  const showMobile     = tb.mobile     !== false && viewMode === 'splat' && isTouchDevice && !isProduct;

  // Collapsed: render only a tiny floating button to bring the sidebar back.
  // 折りたたみハンドルの位置はサイドバーと同側に揃える (PC 左上 / スマホ縦 右下 / スマホ横 右上)。
  if (sidebarCollapsed) {
    const handleStyle = collapsedHandleStyle(placement);
    // 左/右上で「>」、右下では「<」のような感じだと意味が逆になるので、向きも合わせて反転。
    const chevronD = placement === 'left' ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6';
    return (
      <button onClick={() => setSidebarCollapsed(false)} className={COLLAPSED_HANDLE} style={handleStyle} title={`${sceneName} を表示`}>
        <svg className="ds-icon" viewBox="0 0 24 24">
          <path d={chevronD} />
        </svg>
      </button>
    );
  }


  return (
    <>
      <div className={sidebarClass(sidebarSize, placement)} style={sStyles.sidebar}>
        {/* タイトル枠 — 右端に音声トグル + 拡大 + サイドバー全閉ボタン */}
        <div className="ds-sidebar__title">
          <span className="ds-title">{sceneName}</span>
          <div style={{ flex: 1 }} />
          {manifest?.audio && <AmbientAudioToggle />}
          {showPinsToggle && <PinsVisibilityToggle />}
          {showFullscreen && <FullscreenButton iconOnly />}
          <button onClick={() => setSidebarCollapsed(true)} className={TITLE_ICON_BTN} title="サイドバーを閉じる (ビューを最大化)">
            <span style={titleIconGlyph}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </span>
          </button>
        </div>

        <div className="ds-sidebar__scroll">
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
              <div className="ds-sidebar__group" style={sidebarBlock}>
                <div style={overviewHeaderRow}>
                  <span className="ds-label">シーン</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setSectionHidden('viewpoints', true)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="シーンを閉じる"><IconClose /></button>
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
              <div className="ds-sidebar__group" style={{ ...sidebarBlock, ...sidebarMapBlock }}>
                <div style={overviewHeaderRow}>
                  <span className="ds-label">{isOther ? 'MAP' : 'FLOOR MAP'}</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setSectionHidden('map', true)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="MAP を閉じる"><IconClose /></button>
                </div>
                {hasMap ? (
                  <MapContent onViewpointClick={onViewpointClick} />
                ) : (
                  <div className="ds-empty">
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
  const activeVp = useCameraStore((s) => s.activeViewpoint);
  const liveYaw = useCameraStore((s) => s.yaw);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  const activePlan = manifest?.plans?.find((p) => p.id === activePlanId);
  const floorPlan = activePlan?.floorPlan;
  const fpImage = floorPlan?.image;
  const isData = !!fpImage && fpImage.startsWith('data:');
  const hasFile = !!fpImage && (isData || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(fpImage));
  const imageUrl = isData ? fpImage : (fpImage && manifest ? resolveScenePath(manifest.id, fpImage) : '');

  // Reset load state the moment the image source changes — during render (React's
  // "adjust state when props change" pattern) so the effect below only talks to the
  // external Image() API. Mirrors FloorPlanMiniMap.
  const imageKey = hasFile ? imageUrl : '';
  const [prevImageKey, setPrevImageKey] = useState(imageKey);
  if (prevImageKey !== imageKey) {
    setPrevImageKey(imageKey);
    setImgFailed(false);
    if (!imageKey) setImgSize(null);
  }
  useEffect(() => {
    if (!hasFile || !imageUrl) return;
    // `cancelled` guards against a slow previous load finishing AFTER the url
    // changed and overwriting the newer image's size with a stale one.
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) setImgSize({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { if (!cancelled) { setImgSize(null); setImgFailed(true); } };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl, hasFile]);

  if (!manifest || !floorPlan) {
    return (
      <div className="ds-empty">
        このプランの図面はまだ設定されていません
      </div>
    );
  }

  const size = 280;
  const worldW = floorPlan.bounds.max[0] - floorPlan.bounds.min[0];
  const worldH = floorPlan.bounds.max[1] - floorPlan.bounds.min[1];
  const aspect = imgSize ? imgSize.w / imgSize.h : worldW / worldH;
  let dW = size, dH = size;
  if (aspect > 1) dH = size / aspect; else dW = size * aspect;

  const toMX = (wx: number) => ((wx - floorPlan.bounds.min[0]) / worldW) * dW;
  const toMY = (wz: number) => ((wz - floorPlan.bounds.min[1]) / worldH) * dH;

  const hasImage = hasFile && !imgFailed;
  const viewpoints = activePlan?.viewpoints ?? [];

  return (
    <div className="ds-mapframe" style={{ width: dW, height: dH }}>
      {hasImage && <img src={imageUrl} alt="" style={{ position: 'absolute', top: 0, left: 0, width: dW, height: dH, objectFit: 'fill', display: 'block' }} />}
      <svg width={dW} height={dH} viewBox={`0 0 ${dW} ${dH}`} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
        {!hasImage && <rect x={0} y={0} width={dW} height={dH} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" strokeWidth={1} rx={4} />}
        {/* Sort: inactive first, active last so the active dot sits on top. */}
        {[...viewpoints].sort((a, b) => (a.id === activeVp ? 1 : 0) - (b.id === activeVp ? 1 : 0)).map((vp) => {
          // Match the editor: un-placed pins show in a visible row near the top (never
          // stacked at the origin), so the map always reflects every viewpoint.
          let mx: number, mz: number;
          if (vp.mapPosition) {
            mx = vp.mapPosition[0]; mz = vp.mapPosition[1];
          } else {
            const oi = viewpoints.findIndex((v) => v.id === vp.id);
            const n = Math.max(1, viewpoints.length);
            mx = floorPlan.bounds.min[0] + ((oi + 0.5) / n) * worldW;
            mz = floorPlan.bounds.min[1] + 0.1 * worldH;
          }
          const cx = toMX(mx), cy = toMY(mz);
          const isA = activeVp === vp.id;
          const fill = isA ? '#4caf50' : 'rgba(15,17,22,0.9)';
          const stroke = '#fff';
          const r = isA ? 6 : 5;
          const sw = isA ? 2 : 1.5;
          // Direction cone for VR (360° panorama) viewpoints ONLY — GS/splat viewpoints don't
          // need a facing radar, so they show just the dot. The ACTIVE viewpoint's cone tracks
          // the LIVE camera yaw so it rotates as you look around the panorama (the moving
          // "radar"); inactive viewpoints show their authored `mapYaw`. Display-only — reading
          // live yaw never writes mapYaw/target (the 不変ルール only constrains the slider).
          const isVR = !!activePlan?.panoramas?.[vp.id];
          const yawDeg = isA ? liveYaw : (typeof vp.mapYaw === 'number' ? vp.mapYaw : 0);
          const yr = (yawDeg + 90) * Math.PI / 180;
          const ccl = Math.min(dW, dH) * 0.09 * (isA ? 0.8 : 0.62);
          const spread = 0.55;
          const coneFill = isA ? 'rgba(76,175,80,0.35)' : 'rgba(15,17,22,0.22)';
          const coneStroke = isA ? 'rgba(76,175,80,0.95)' : 'rgba(15,17,22,0.55)';
          return (
            <g
              key={vp.id}
              style={{ cursor: 'pointer' }}
              onClick={() => onViewpointClick(vp.id)}
              role="button"
              aria-label={`${vp.label} に移動`}
            >
              {isVR && <path d={fanPath(cx, cy, ccl, yr, spread)} fill={coneFill} stroke={coneStroke} strokeWidth={isA ? 1.2 : 0.8} strokeLinejoin="round" />}
              <circle cx={cx} cy={cy} r={Math.max(r + 6, 12)} fill="transparent" />
              <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />
              <text x={cx} y={cy - r - 4} textAnchor="middle" fill={isA ? '#4caf50' : '#f5f7fa'} fontSize={11} fontWeight={isA ? 'bold' : 600} stroke="rgba(0,0,0,0.75)" strokeWidth={3} paintOrder="stroke">{vp.label}</text>
            </g>
          );
        })}
      </svg>
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
  return <span className="ds-sub" style={infoSummary}>{items.join(' · ')}</span>;
}

type VisKey = 'overall' | 'heading' | 'area' | 'floor' | 'location' | 'notes';

/** Tiny sidebar handle for a closed big section (タイプ / カラー / MAP). Click to reopen. */
function ClosedSectionHandle({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="ds-rowbtn" title={`${label} を表示`}>
      <span className="ds-section__chevron">▶</span>
      <span className="ds-label">{label}</span>
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
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">{blockLabel}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('type', true)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title={`${blockLabel}を閉じる`}><IconClose /></button>
      </div>
      {plans.length === 0 ? (
        <div className="ds-sub">プラン未追加 — デバッグ画面のプランタブで追加できます</div>
      ) : plans.length === 1 ? (
        <div style={chipRow}>
          <button className={`${surfaceClass('accent')} ds-chip`} disabled title="単一プラン">{plans[0].label}</button>
        </div>
      ) : (
        <div style={chipRow}>
          {plans.map((p) => {
            const isA = p.id === activePlanId;
            return (
              <button
                key={p.id}
                onClick={() => onPlanSwitch?.(p.id)}
                className={`${surfaceClass(isA ? 'accent' : 'plain')} ds-chip ${isA ? '' : 'ds-fill-surface'}`}
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
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">カラー</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('color', true)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="カラーを閉じる"><IconClose /></button>
      </div>
      {variants.length === 0 ? (
        <div className="ds-sub">素材バリエーション未設定 — デバッグ画面の「カラー」セクションから追加できます</div>
      ) : (
        <div style={chipRow}>
          <button
            onClick={() => setActiveColor(null)}
            className={`${surfaceClass(activeColor === null ? 'accent' : 'plain')} ds-chip ${activeColor === null ? '' : 'ds-fill-surface'}`}
            title="標準カラー"
          >
            <span className="ds-swatch" style={{ background:'#e5e7eb' }} />
            <span>標準</span>
          </button>
          {variants.map((v) => {
            const isA = v.id === activeColor;
            return (
              <button
                key={v.id}
                onClick={() => setActiveColor(v.id)}
                className={`${surfaceClass(isA ? 'accent' : 'plain')} ds-chip ${isA ? '' : 'ds-fill-surface'}`}
                title={v.label}
              >
                <span className="ds-swatch" style={{ background:v.swatch || '#a89372' }} />
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
              <span className="ds-label" style={inlineToggleLabel}>家具</span>
              <FurnitureContent />
            </div>
          )}
          {showLightingTool && (
            <div style={inlineToggleRow}>
              <span className="ds-label" style={inlineToggleLabel}>情景</span>
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
      <button onClick={() => setVis('overall', true)} className="ds-rowbtn" title="間取り概要を表示">
        <span className="ds-section__chevron">▶</span>
        <span className="ds-label">間取り概要</span>
      </button>
    );
  }

  // Are any items currently hidden? If so, expose a "全表示" restore link.
  const anyHidden = vis.heading === false || vis.area === false || vis.floor === false || vis.location === false || vis.notes === false;
  const restoreAll = () => updateInfo({ visibility: { overall: true } });

  return (
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">間取り概要</span>
        {anyHidden && (
          <button onClick={restoreAll} className={`${surfaceClass('accent')} ds-pill ds-pill--xs`} title="非表示にした項目を戻す" aria-label="全表示"><IconPlus /></button>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setVis('overall', false)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="間取り概要を閉じる"><IconClose /></button>
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
    return <span className="ds-sub">—</span>;
  }
  const badgeChar = (info.type || info.roomType || '').charAt(0).toUpperCase() || '·';
  const tsuboLabel = showArea ? formatTsubo(info.area) : null;

  return (
    <div style={overviewWrap}>
      <div className={`${surfaceClass('accent')} ds-badge ds-badge--lg`} style={{ flexDirection: 'column' }}>
        <span className="ds-badge__char">{badgeChar}</span>
        <span className="ds-label">type</span>
      </div>
      <div style={overviewBody}>
        {showHeading && (
          <div className="ds-title">{info.roomType}</div>
        )}
        {showArea && (
          <div className="ds-body" style={overviewArea}>
            <span className="ds-sub">□ 専有面積</span>
            <span className="ds-sub">｜</span>
            <span className="ds-title">{info.area}</span>
            {tsuboLabel && <span className="ds-sub">{tsuboLabel}</span>}
          </div>
        )}
        {showFloor && info.floor && (
          <div className="ds-sub">・{info.floor}</div>
        )}
        {showLocation && info.location && (
          <div className="ds-sub">・{info.location}</div>
        )}
        {showNotes && info.notes && info.notes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length > 0 && (
          <ul style={overviewBullets}>
            {info.notes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line, i) => (
              <li key={i} className="ds-sub">・{line}</li>
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
      <div style={{ padding: '20px 10px', color: tokens.color.textMute, fontSize: 11.5, textAlign: 'center' }}>
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
          <Tile
            key={vp.id}
            active={isA}
            onClick={() => onViewpointClick(vp.id)}
            thumb={thumb}
            placeholder={<span className="ds-sub">…</span>}
            label={vp.label}
          />
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
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">移動モード</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('movement', true)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="移動モードを閉じる"><IconClose /></button>
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

  // Reset the displayed image + zoom when the selected variant changes — during
  // render (React's "adjust state when props change" pattern) so the effect below
  // only performs the external IDB resolve.
  const [prevEntry, setPrevEntry] = useState(entry);
  if (prevEntry !== entry) {
    setPrevEntry(entry);
    setSrc(null);
    setZoom({ scale: 1, panX: 0, panY: 0 });
  }
  useEffect(() => {
    let alive = true;
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
      className="ds-stage"
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
        <button type="button" onClick={onDownload} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-fill-surface ds-blur`} title="ダウンロード" aria-label="ダウンロード">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <button type="button" onClick={() => setActiveAiId(null)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-fill-surface ds-blur`} title="閉じる"><IconClose /></button>
      </div>
      {zoom.scale > 1 && <div className="ds-hud" style={aiOverlayZoomHud}>{zoom.scale.toFixed(1)}×</div>}
    </div>
  );
}

/** The AI result viewer is a stage: the generated image is judged on its own,
 *  so nothing of the app sits behind it. */
const aiOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
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
    <div className="ds-veil" style={aiBusyOverlay}>
      <div className="ds-spinner" />
      <div className="ds-title" style={{ marginTop: 14 }}>AI 画像を生成中…</div>
      <div className="ds-sub">10〜30 秒ほどかかります</div>
    </div>
  );
}

/** Layout only — the veil, spinner and type are design-system classes. */
const aiBusyOverlay: React.CSSProperties = { zIndex: 80, gap: 4, pointerEvents: 'auto' };





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
/** Map a pixel WxH to the nearest aspect-ratio string the image models accept. */
function screenAspectRatio(w: number, h: number): string {
  const r = w / Math.max(1, h);
  const cands: [string, number][] = [
    ['1:1', 1], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['21:9', 21 / 9],
    ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16],
  ];
  let best = cands[0], bestD = Infinity;
  for (const c of cands) { const d = Math.abs(Math.log(r / c[1])); if (d < bestD) { bestD = d; best = c; } }
  return best[0];
}

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
  // Per-generation output options.
  const [imageSize, setImageSize] = useState<'1K' | '2K' | '4K'>('2K');
  const [genCount, setGenCount] = useState<1 | 2>(1);
  const [aspect, setAspect] = useState<'screen' | 'pano'>('screen');
  // Re-render when keys / selected model change (⚙ writes localStorage + fires this).
  const [, bumpCfg] = useState(0);
  useEffect(() => {
    const h = () => bumpCfg((v) => v + 1);
    window.addEventListener('aiconfig-change', h);
    return () => window.removeEventListener('aiconfig-change', h);
  }, []);
  // Server-side (embedded) keys — which providers the proxy can serve WITHOUT a local
  // key (set via wrangler secret, gated by site auth). Lets a shared user generate
  // without ever seeing/entering the key.
  const [serverKeys, setServerKeys] = useState<{ openai: boolean; gemini: boolean }>({ openai: false, gemini: false });
  useEffect(() => {
    let alive = true;
    fetch('/api/ai/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { openai?: boolean; gemini?: boolean } | null) => {
        if (alive && c) setServerKeys({ openai: !!c.openai, gemini: !!c.gemini });
      })
      .catch(() => { /* not available — fall back to local keys */ });
    return () => { alive = false; };
  }, []);

  // Multi-image API call. The first entry is treated by OpenAI as the primary
  // input; subsequent entries are additional references the model may sample
  // style / palette / texture from.
  const callImageGen = async (
    sources: string[],
    p: string,
    opts: { aspectRatio: string; imageSize: string },
  ): Promise<string | null> => {
    // Pick provider + upstream model from the ⚙ selector. Use the locally-entered key
    // if present, else rely on the embedded server key (the proxy decides, gated by auth).
    const model = getModelById(getSelectedModelId());
    const localKey = model.provider === 'gemini' ? getGeminiKey() : getOpenAIKey();
    const serverHas = model.provider === 'gemini' ? serverKeys.gemini : serverKeys.openai;
    if (!localKey && !serverHas) {
      alert(`選択中のモデル「${model.label}」の API キーが未設定です。右上の ⚙ から ${model.provider === 'gemini' ? 'Gemini' : 'OpenAI'} キーを入力してください。`);
      return null;
    }
    // Always send site auth so the proxy may use the embedded server key; send the local
    // key only if the user entered one (then it takes precedence over the server key).
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    };
    if (localKey) headers[model.provider === 'gemini' ? 'X-Gemini-Key' : 'X-OpenAI-Key'] = localKey;
    const r = await fetch('/api/ai/edit', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: model.provider,
        model: model.apiModelId,
        images: sources,
        prompt: p,
        aspectRatio: opts.aspectRatio,
        // 解像度 (1K/2K/4K) は Gemini 3.x の imageConfig 専用。OpenAI (gpt-image) は
        // 固定サイズ 3 種のみでアスペクト比から自動選択されるため送らない
        // (UI 側でもセレクタを無効化している)。
        ...(model.provider === 'gemini' ? { imageSize: opts.imageSize } : {}),
      }),
    });
    // Both providers are normalized by the proxy to { data: [{ b64_json }] } — but only
    // when the proxy itself answered. A dev-server crash / upstream HTML 5xx is NOT
    // JSON, and parsing it unconditionally used to throw and mask the real error.
    const ct = r.headers.get('content-type') ?? '';
    let j: { data?: { b64_json?: string }[]; error?: { message?: string } } = {};
    if (ct.includes('application/json')) {
      try { j = await r.json() as typeof j; } catch { /* malformed body — fall through to status error */ }
    }
    if (!r.ok) {
      alert('生成エラー: ' + (j.error?.message ?? `${r.status} ${r.statusText}`));
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
    // Aspect: match the on-screen canvas, or a 2:1 equirectangular ratio for VR 360.
    const aspectRatio = aspect === 'pano' ? '2:1' : screenAspectRatio(canvas.width, canvas.height);
    const resultDataUrl = await callImageGen(sources, p, { aspectRatio, imageSize });
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
      // 1 or 2 simultaneous variations of the same screen + prompt.
      await Promise.all(Array.from({ length: genCount }, () => generateScreen(p)));
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

  // Provider / model selection — keys gate which providers are pickable. Read fresh
  // each render; `bumpCfg` re-renders on the aiconfig-change event from ⚙.
  const hasKey: Record<AiProvider, boolean> = {
    openai: getOpenAIKey() !== '' || serverKeys.openai,
    gemini: getGeminiKey() !== '' || serverKeys.gemini,
  };
  const selModelId = getSelectedModelId();
  const curProvider = getModelById(selModelId).provider;
  const onPickProvider = (p: AiProvider) => setSelectedModelId(firstModelForProvider(p).id);

  return (
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">AI 画像生成</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('aiGenerate', true)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="AI 画像生成を閉じる"><IconClose /></button>
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
            <button type="button" onClick={() => removeRef(i)} className={`${surfaceClass('danger')} ds-pill ds-pill--icon ds-pill--xs`} style={{ position: 'absolute', top: 0, right: 0 }} title="削除"><IconClose /></button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => refInputRef.current?.click()}
          disabled={aiBusy || refImages.length >= 3}
          className={`${surfaceClass('plain')} ds-pill ds-fill-surface`}
          style={{ height: 40 }}
          title="参照画像を追加 (最大 3 枚)"
        >
          <IconPlus />
          <span>参照画像</span>
        </button>
        <input
          ref={refInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { void onPickRefs(e.target.files); e.target.value = ''; }}
        />
      </div>
      <div style={aiOptRow}>
        <label style={aiOptLabel}><span className="ds-label">プロバイダ</span>
          <select value={curProvider} onChange={(e) => onPickProvider(e.target.value as AiProvider)} disabled={aiBusy} style={aiOptSelect}>
            {PROVIDERS.map((pv) => (
              /* Name only. The "（API未設定）" suffix pushed the label past the
                 column and rendered as "Gemini（AP", and it said nothing the
                 UI was not already saying twice: the option is disabled, and
                 the strip below names the provider and offers the fix. */
              <option key={pv.id} value={pv.id} disabled={!hasKey[pv.id]}>
                {pv.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...aiOptLabel, flex: 1.6 }}><span className="ds-label">モデル</span>
          <select value={selModelId} onChange={(e) => setSelectedModelId(e.target.value)} disabled={aiBusy} style={aiOptSelect}>
            {modelsForProvider(curProvider).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      </div>
      {!hasKey[curProvider] && (
        <div className={AI_KEY_HINT} style={aiKeyHint}>
          <span className="ds-sub">{curProvider === 'gemini' ? 'Gemini' : 'ChatGPT'} の API キーが未設定です。</span>
          <button type="button" onClick={() => window.dispatchEvent(new Event('open-ai-settings'))} className={`${surfaceClass('plain')} ds-pill ds-pill--xs ds-fill-surface`}><IconSettings />API を設定</button>
        </div>
      )}
      <div style={aiOptRow}>
        <label style={aiOptLabel} title={curProvider === 'openai' ? 'OpenAI (gpt-image) は解像度指定に非対応です。サイズは比率から自動選択されます。' : undefined}>
          <span className="ds-label">解像度</span>
          {/* OpenAI (gpt-image) は 1024/1536 の固定 3 サイズのみで 1K/2K/4K の概念が無い —
              誤解を生まないようセレクタごと無効化 (A4)。Gemini 3.x のみ有効。 */}
          <select value={imageSize} onChange={(e) => setImageSize(e.target.value as '1K' | '2K' | '4K')} disabled={aiBusy || curProvider === 'openai'} style={aiOptSelect}>
            <option value="1K">1K</option>
            <option value="2K">2K</option>
            <option value="4K">4K</option>
          </select>
        </label>
        <label style={aiOptLabel}><span className="ds-label">枚数</span>
          <select value={genCount} onChange={(e) => setGenCount(Number(e.target.value) as 1 | 2)} disabled={aiBusy} style={aiOptSelect}>
            <option value={1}>1枚</option>
            <option value={2}>2枚</option>
          </select>
        </label>
        <label style={aiOptLabel}><span className="ds-label">比率</span>
          <select value={aspect} onChange={(e) => setAspect(e.target.value as 'screen' | 'pano')} disabled={aiBusy} style={aiOptSelect}>
            <option value="screen">画面</option>
            <option value="pano">360°(2:1)</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={aiBusy || prompt.trim().length === 0}
        className={AI_GENERATE_BTN(aiBusy || prompt.trim().length === 0)}
        style={aiGenerateBtn}
      >
        {aiBusy ? '生成中…' : '生成'}
      </button>
      <div style={vpGrid}>
        {history.map((e) => {
          const isA = activeAiId === e.id;
          return (
            <div key={e.id} style={{ position: 'relative' }}>
              <Tile
                active={isA}
                onClick={() => setActiveAiId(e.id)}
                thumb={e.thumbnail}
                placeholder={<span className="ds-sub">…</span>}
                label=""
                title={e.prompt}
                style={{ width: '100%' }}
              />
              <div style={aiCardActions}>
                <button
                  type="button"
                  onClick={() => onDelete(e.id)}
                  className={`${surfaceClass('danger')} ds-pill ds-pill--icon ds-pill--xs`}
                  title="削除"
                ><IconTrash /></button>
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
  overflow: 'hidden',
};
const aiRefImg: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

/** Warning strip above the generate button — a warn-variant surface. */
const AI_KEY_HINT = `${surfaceClass('warn')} ds-panel`;
const aiKeyHint: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  marginTop: 6, padding: '6px 10px',
};
const aiOptRow: React.CSSProperties = {
  display: 'flex', gap: 6, marginTop: 8,
};
const aiOptLabel: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', gap: 3,
};
/* The five native selects and the prompt textarea are styled at ELEMENT level
 * in design-system.css — an unclassed `<select>` keeps OS chrome, so taking it
 * over globally is what stops new markup falling out of the language. Nothing
 * is left here but size. */
const aiOptSelect: React.CSSProperties = { padding: '7px 26px 7px 12px' };
const aiPromptStyle: React.CSSProperties = { minHeight: 56 };

const AI_GENERATE_BTN = (disabled: boolean) =>
  `${surfaceClass(disabled ? 'neutral' : 'accent')} ds-pill${disabled ? ' ds-fill-neutral' : ''}`;
const aiGenerateBtn: React.CSSProperties = { marginTop: 6, width: '100%' };

const aiCardActions: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  display: 'flex',
  gap: 1,
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
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">画質</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSectionHidden('quality', true)} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="画質を閉じる"><IconClose /></button>
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
  return useMediaQuery('(pointer: coarse)');
}

/** Portrait (= 縦向き) なら true。回転で値が切り替わるので useMobileSidebarPlacement の
 *  根拠に使う。デスクトップは isTouch=false 経由で無効化される想定なので素直に
 *  `(orientation: portrait)` の真偽だけ拾う。 */
function usePortraitOrientation(): boolean {
  return useMediaQuery('(orientation: portrait)');
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
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">移動スピード</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`} title="閉じる"><IconClose /></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span className="ds-hint">遅</span>
        <input
          type="range"
          min={MOBILE_SPEED_MIN}
          max={MOBILE_SPEED_MAX}
          step={0.5}
          value={speed}
          onChange={(e) => apply(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
        <span className="ds-hint">速</span>
      </div>
      <div className="ds-mono ds-sub" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span>{MOBILE_SPEED_MIN.toFixed(1)} m/s</span>
        <span className="ds-accent">{speed.toFixed(1)} m/s</span>
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
  const statusTone = !enabled ? 'ds-faint' : connected ? 'ds-ok' : 'ds-warn';
  return (
    <div className="ds-sidebar__group" style={sidebarBlock}>
      <div style={overviewHeaderRow}>
        <span className="ds-label">ヘッドトラッキング</span>
        <div style={{ flex: 1 }} />
        <span className={`ds-sub ${statusTone}`}>{status}</span>
        <button onClick={() => setSectionHidden('tracking', true)} className={TITLE_ICON_BTN} style={{ marginLeft: 6 }} title="ヘッドトラッキングを閉じる"><IconClose /></button>
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
          className={`${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface`}
          style={{ marginTop: 6, width: '100%' }}
          title="今の頭の向きを基準にゼロ点を取り直す"
        >
          ↻ 中央リセット
        </button>
      )}
      {enabled && (
        <div className="ds-hint" style={{ marginTop: 6 }}>
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

/**
 * Thin alias over the shared `SegmentedControl`.
 *
 * This used to be a second implementation of the segmented control — its own
 * track, its own active recipe built from `gradient` + `borderColor`, its own
 * weight ternary. That is why it stayed flat and full-width while the design
 * system moved: the tokens changed underneath it, but it rebuilt the surface
 * on top of them. Kept as a named wrapper only so existing call sites and
 * their `{ id, label }` option shape need no edit.
 */
function SegmentedToggle<T extends string>(props: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return <SegmentedControl {...props} />;
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
      className={TITLE_ICON_BTN}
      title={muted ? '環境音を再生' : '環境音をミュート'}
    >
      <span style={titleIconGlyph}>
        {muted ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H2v6h4l5 4z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
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
      className={TITLE_ICON_BTN}
      style={showPins ? undefined : { opacity: 0.45 }}
      title={showPins ? 'タグを非表示にする' : 'タグを表示する'}
    >
      <span style={titleIconGlyph}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v4a1 1 0 0 1-1 1H3M21 8h-4a1 1 0 0 1-1-1V3M3 16h4a1 1 0 0 1 1 1v4M16 21v-4a1 1 0 0 1 1-1h4"/>
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5"/>
    </svg>
  );
  if (iconOnly) {
    return (
      <button onClick={toggle} title={isFs ? 'フルスクリーン解除' : '拡大 (フルスクリーン)'} className={TITLE_ICON_BTN}>
        <span style={titleIconGlyph}>{Icon}</span>
      </button>
    );
  }
  return (
    <button
      onClick={toggle}
      title={isFs ? 'フルスクリーン解除' : '拡大 (フルスクリーン)'}
      className={compact ? 'ds-navitem' : 'ds-navitem ds-navitem--stacked'}
      style={compact ? miniIconBtn : undefined}
    >
      <span style={iconGlyph}>{Icon}</span>
      <span className={compact ? "ds-title" : "ds-label"}>拡大</span>
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

/** Edge classes for the sidebar — the divider goes on the one edge that meets
 *  the canvas; `small` floats clear of the bottom and needs its own. */
function sidebarClass(size: SidebarSize, placement: SidebarPlacement): string {
  const edge = placement === 'portrait' ? 'top' : placement === 'right' ? 'right' : 'left';
  return `ds-sidebar ds-sidebar--${edge}${size === 'small' ? ' ds-sidebar--floating' : ''}`;
}

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
  // 縁取り (キャンバスと接する 1 辺だけの区切り線) は `sidebarClass` 側。
  // スマホはセクションが多いと画面いっぱいになるので、上限を画面の約半分にして
  // 下部 (キャンバス / 操作領域) を必ず見えるようにする。残りはスクロール。
  // PC は従来通り 100dvh まで許容。
  const isMobile = isPortrait || isRight;
  return {
    /** Layout only — material and dividers come from `sidebarClass`. */
    sidebar: {
      // 横向きスマホ等で viewport 高が低い時に下部が見切れないよう、必ず viewport 内に収め
      // 中身は `.ds-sidebar__scroll` 側でスクロールさせる。`100dvh` は iOS Safari の
      // アドレスバー出入りに追従する viewport 単位 (fallback で 100vh)。
      maxHeight: isMobile ? '50dvh' : '100dvh',
      ...anchors,
      width,
      zIndex: 6,
    } as React.CSSProperties,
  };
}

/** Icon button beside the sidebar title. */
const TITLE_ICON_BTN = `${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--sm ds-fill-surface`;
/** The button the collapsed sidebar leaves behind — floats over the canvas. */
const COLLAPSED_HANDLE = `${surfaceClass('plain')} ds-overlay ds-overlay--pill ds-pill ds-pill--icon`;

const titleIconGlyph: React.CSSProperties = {
  width: 16,
  height: 16,
  display: 'inline-flex',
};

/** Layout only. */
const collapsedHandle: React.CSSProperties = {
  position: 'absolute',
  top: 16, left: 16,
  width: 36, height: 36,
  zIndex: 6,
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

/* Layout only. Padding, the divider and the column live in
   `.ds-sidebar__group`; writing any of them here is how the previous version
   ended up with `padding: 0` silently beating the component's own spacing. */
const sidebarBlock: React.CSSProperties = {};

const sidebarMapBlock: React.CSSProperties = { overflow: 'hidden' };


const colorInlineToggles: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 6,
  paddingTop: 8,
  borderTop: `1px solid ${tokens.color.hairline}`,
};

const inlineToggleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const inlineToggleLabel: React.CSSProperties = { width: 32, flexShrink: 0 };

/** Each row takes an equal share of the toolbar's flexed height, so together
 *  they cover it with no leftover blank space. */
const miniIconBtn: React.CSSProperties = { flex: 1, minHeight: 0 };

const iconGlyph: React.CSSProperties = {
  width: 22,
  height: 22,
  display: 'inline-flex',
};


// 3-column grid: thumbnail on top, room name below.
const vpGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 6,
};

/* Eight constants for one selectable thumbnail — card, thumb, label, image,
 * placeholder and three "active" overlays — replaced by `<Tile>`. The active
 * state is now a variant rather than three style objects merged at render. */


const infoSummary: React.CSSProperties = {
  marginLeft: 10,
  paddingLeft: 10,
  borderLeft: `1px solid var(--ds-hairline)`,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  flexShrink: 1,
};


const overviewWrap: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
};


const overviewBody: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const overviewArea: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  gap: 4,
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


const overviewHeaderRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

/* The block's close button, the closed handle bar and its chevron were three
 * style objects here; they are `TITLE_ICON_BTN`, `.ds-rowbtn` and
 * `.ds-section__chevron` now. */

const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

/* `chipBtn` / `chipBtnActive` / `colorChip` / `colorChipActive` lived here —
 * two near-identical pairs whose only real difference was a colour swatch.
 * They are now one `.ds-chip`, with the swatch as a modifier. */




