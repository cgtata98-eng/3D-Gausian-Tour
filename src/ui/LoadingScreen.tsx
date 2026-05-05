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
  background: 'rgba(247, 248, 250, 0.96)',
  color: '#1f2937',
  zIndex: 100,
};

const spinner: React.CSSProperties = {
  width: 36,
  height: 36,
  border: '2px solid rgba(0,0,0,0.1)',
  borderTopColor: '#3b82f6',
  borderRadius: '50%',
  animation: 'spin 0.9s linear infinite',
};

const label: React.CSSProperties = {
  marginTop: 18,
  fontSize: 13,
  letterSpacing: 0.5,
  color: 'rgba(31,41,55,0.6)',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
};
