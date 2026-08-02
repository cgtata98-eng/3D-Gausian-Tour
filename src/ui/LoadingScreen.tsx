import { useSceneStore } from '../store/scene-store';
import { tokens } from './design-tokens';

export function LoadingScreen() {
  // splat ダウンロード進捗。null = 進捗不明 (Content-Length 無し、または初期化前)。
  const progress = useSceneStore((s) => s.loadProgress);
  const pct = progress === null ? null : Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div style={wrap}>
      <div style={spinner} />
      <p style={label}>
        Loading scene{pct !== null ? `… ${pct}%` : '…'}
      </p>
      {pct !== null && (
        <div style={barTrack}>
          <div style={{ ...barFill, width: `${pct}%` }} />
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const wrap: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  // Translucent overlay so the canvas underneath shows through faintly —
  // matches the liquid-glass surfaces.
  background: 'rgba(248, 248, 248, 0.94)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  color: tokens.color.text,
  fontFamily: tokens.font.family,
  zIndex: 100,
};

const spinner: React.CSSProperties = {
  width: 36,
  height: 36,
  border: `2px solid ${tokens.color.border}`,
  borderTopColor: tokens.color.accent,
  borderRadius: '50%',
  animation: 'spin 0.9s linear infinite',
};

const label: React.CSSProperties = {
  marginTop: 18,
  fontSize: 11.5,
  fontWeight: tokens.font.weight.strong,
  letterSpacing: 0.5,
  color: tokens.color.textMute,
  fontFamily: tokens.font.family,
  fontVariantNumeric: 'tabular-nums',
};

const barTrack: React.CSSProperties = {
  marginTop: 12,
  width: 200,
  height: 4,
  background: tokens.color.hairline,
  borderRadius: 2,
  overflow: 'hidden',
};

const barFill: React.CSSProperties = {
  height: '100%',
  background: tokens.color.accent,
  transition: 'width 120ms ease-out',
};
