import { useSceneStore } from '../store/scene-store';

export function LoadingScreen() {
  // splat ダウンロード進捗。null = 進捗不明 (Content-Length 無し、または初期化前)。
  const progress = useSceneStore((s) => s.loadProgress);
  const pct = progress === null ? null : Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="ds-veil">
      <div className="ds-spinner" />
      <p className="ds-sub" style={{ marginTop: 18, fontVariantNumeric: 'tabular-nums' }}>
        Loading scene{pct !== null ? `… ${pct}%` : '…'}
      </p>
      {pct !== null && (
        <div className="ds-progress" style={{ marginTop: 12 }}>
          <div className="ds-progress__fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
