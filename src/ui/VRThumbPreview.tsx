import { useEffect, useRef, useState } from 'react';
import type { Viewpoint } from '../core/types';
import { deriveYawFromTarget, targetFromYaw } from '../core/viewpoint';
import { useSceneStore } from '../store/scene-store';
import { resolveBlobRef } from '../utils/idb';
import { surfaceClass, IconClose } from './components';

/**
 * Inline panorama-direction picker shown below an active VR viewpoint row in DebugViewer.
 *
 * The user drags / slides through the panorama to pick the front-facing direction.
 * Pressing 保存 commits that direction as:
 *   - The viewpoint's manual thumbnail (the crop currently rendered on the canvas)
 *   - The viewpoint's `target` (initial entry direction in the production viewer)
 *
 * Live camera, mapYaw, and mapPosition are intentionally untouched — this widget is
 * a self-contained pano browser that writes only the two fields the user opted into.
 */
export function VRThumbPreview({
  vp,
  planId,
  panoramaSrc,
  onClose,
}: {
  vp: Viewpoint;
  planId: string;
  panoramaSrc: string;
  onClose?: () => void;
}) {
  // Preview yaw == camera yaw end-to-end thanks to the 180° skybox rotation in
  // hdri-loader.ts: yaw 0 = panorama center (front), yaw 180 = seam (back).
  const [yawDeg, setYawDeg] = useState<number>(() => deriveYawFromTarget(vp));
  const [imgReady, setImgReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; yaw: number } | null>(null);

  // Reset load state when the panorama source changes — during render (React's
  // "adjust state when props change" pattern) so the effect below only performs
  // the external resolve/Image work.
  const [prevSrc, setPrevSrc] = useState(panoramaSrc);
  if (prevSrc !== panoramaSrc) {
    setPrevSrc(panoramaSrc);
    setImgReady(false);
    setError(null);
  }

  // Resolve panorama source (data:/blob: pass-through, idb: → object URL).
  useEffect(() => {
    let cancelled = false;
    let revokeUrl: string | null = null;
    (async () => {
      try {
        const url = await resolveBlobRef(panoramaSrc);
        if (cancelled) {
          if (url.startsWith('blob:') && url !== panoramaSrc) URL.revokeObjectURL(url);
          return;
        }
        if (url.startsWith('blob:') && url !== panoramaSrc) revokeUrl = url;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { if (!cancelled) { imgRef.current = img; setImgReady(true); } };
        img.onerror = () => { if (!cancelled) setError('画像読み込み失敗'); };
        img.src = url;
      } catch {
        if (!cancelled) setError('パノラマ解決失敗');
      }
    })();
    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [panoramaSrc]);

  // Render the equirect crop centered on yawDeg into the canvas. yawDeg = 0 means the
  // panorama's longitude-0 (image horizontal center). The preview shows the user the
  // panorama directly; the camera-yaw offset (180°) is applied at SAVE time so the
  // production camera ends up sampling the same crop. Wraps around the seam.
  useEffect(() => {
    if (!imgReady) return;
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = img.naturalWidth, H = img.naturalHeight;
    const fovDeg = 80;
    const cropW = (fovDeg / 360) * W;
    const cropH = Math.min(H, cropW * (canvas.height / canvas.width));
    const sourceY = H / 2 - cropH / 2;
    let sourceX = ((-yawDeg / 360) * W + W / 2 - cropW / 2) % W;
    if (sourceX < 0) sourceX += W;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (sourceX + cropW <= W) {
      ctx.drawImage(img, sourceX, sourceY, cropW, cropH, 0, 0, canvas.width, canvas.height);
    } else {
      const firstW = W - sourceX;
      const firstScreenW = (firstW / cropW) * canvas.width;
      ctx.drawImage(img, sourceX, sourceY, firstW, cropH, 0, 0, firstScreenW, canvas.height);
      ctx.drawImage(img, 0, sourceY, cropW - firstW, cropH, firstScreenW, 0, canvas.width - firstScreenW, canvas.height);
    }
  }, [yawDeg, imgReady]);

  // Drag horizontally on the canvas to scrub yaw.
  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragStartRef.current = { x: e.clientX, yaw: yawDeg };
    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current;
      const cv = canvasRef.current;
      if (!start || !cv) return;
      const dx = ev.clientX - start.x;
      // 1 canvas-pixel ≈ (fov / canvas-width) degrees of yaw.
      const degPerPx = 80 / cv.width;
      const next = ((start.yaw - dx * degPerPx) % 360 + 360) % 360;
      setYawDeg(+next.toFixed(1));
    };
    const onUp = () => {
      dragStartRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const thumb = canvas.toDataURL('image/jpeg', 0.9);
    // Skybox is rotated 180° (hdri-loader.ts) so preview yaw == camera yaw 1:1;
    // no offset needed when encoding into the saved target.
    const newTarget = targetFromYaw(vp.position, yawDeg, vp.target[1]);
    // Single store update: write target + thumbnail in one tick so the UI doesn't blink.
    useSceneStore.setState((s) => {
      if (!s.manifest?.plans) return s;
      const plans = s.manifest.plans.map((p) => {
        if (p.id !== planId) return p;
        const nextThumbs = { ...(p.thumbnails ?? {}), [vp.id]: thumb };
        return {
          ...p,
          thumbnails: nextThumbs,
          viewpoints: p.viewpoints.map((v) => v.id === vp.id ? { ...v, target: newTarget } : v),
        };
      });
      return { manifest: { ...s.manifest, plans } };
    });
    onClose?.();
  };

  return (
    <div className={`${surfaceClass('plain')} ds-block ds-fill-surface`} style={styles.wrap}>
      <div style={styles.header}>
        <span className="ds-title" style={{ flex: 1 }}>サムネ / 初期向き設定</span>
        <span className="ds-mono ds-accent">{yawDeg.toFixed(0)}°</span>
        {onClose && (
          <button
            className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-pill--xs ds-fill-surface`}
            onClick={onClose}
            title="閉じる"
          ><IconClose /></button>
        )}
      </div>
      <div style={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          width={400}
          height={250}
          className="ds-plate"
          style={styles.canvas}
          onMouseDown={onMouseDown}
        />
        {!imgReady && !error && <div className="ds-plate__veil">読み込み中…</div>}
        {error && <div className="ds-plate__veil">{error}</div>}
      </div>
      <div style={styles.controls}>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={Math.round(yawDeg)}
          onChange={(e) => setYawDeg(+e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          className={`${surfaceClass('accent')} ds-pill ds-pill--sm`}
          onClick={save}
          disabled={!imgReady}
        >
          この向きで保存 (サムネ + 初期向き)
        </button>
      </div>
      <div className="ds-hint">
        パノラマをドラッグするか下のスライダーで向きを選び、保存を押してください。3D ビューアの live カメラには影響しません。
      </div>
    </div>
  );
}

/** Layout only. The panel, its buttons and its type come from the classes
 *  applied above; what is left here is position and size. */
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    margin: '0 8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  canvasWrap: { position: 'relative', alignSelf: 'center' },
  canvas: {
    width: 400,
    height: 250,
    cursor: 'grab',
    userSelect: 'none',
  },
  controls: { display: 'flex', alignItems: 'center', gap: 10 },
};
