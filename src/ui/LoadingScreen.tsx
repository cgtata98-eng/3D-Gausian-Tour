import { tokens } from './design-tokens';

export function LoadingScreen() {
  return (
    <div style={wrap}>
      <div style={spinner} />
      <p style={label}>Loading scene…</p>
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
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 0.5,
  color: tokens.color.textMute,
  fontFamily: tokens.font.family,
};
