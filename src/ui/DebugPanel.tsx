import { useUIStore } from '../store/ui-store';
import { useCameraStore } from '../store/camera-store';
import { tokens, shellSurface } from './design-tokens';

/**
 * Floating dev overlay shown only when dev mode is on. Sits on top of the
 * 3D canvas, so the surface is a translucent glass pill — the underlying
 * scene shows through faintly without losing legibility.
 */
export function DebugPanel() {
  const {
    showCollision,
    collisionOpacity,
    showDebugStats,
    toggleCollision,
    toggleDebugStats,
    setCollisionOpacity,
  } = useUIStore();
  const position = useCameraStore((s) => s.position);

  return (
    <div className="glass-edge" style={panel}>
      <div style={title}>DEV MODE</div>

      <div style={row}>
        Pos: <span style={mono}>{position.map((v) => v.toFixed(2)).join(', ')}</span>
      </div>

      <label style={check}>
        <input type="checkbox" checked={showCollision} onChange={toggleCollision} />
        Collision
      </label>

      {showCollision && (
        <div style={{ paddingLeft: 22 }}>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={collisionOpacity}
            onChange={(e) => setCollisionOpacity(parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: tokens.color.accent }}
          />
          <div style={{ fontSize: 9.5, color: tokens.color.textMute, fontFamily: tokens.font.mono }}>
            Opacity: {collisionOpacity.toFixed(2)}
          </div>
        </div>
      )}

      <label style={check}>
        <input type="checkbox" checked={showDebugStats} onChange={toggleDebugStats} />
        Stats
      </label>
    </div>
  );
}

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  padding: '12px 14px',
  background: tokens.glass.surfaceStrong,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  ...shellSurface('plain', { radius: tokens.radius.md }),
  fontSize: tokens.font.size.md,
  minWidth: 200,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const title: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: tokens.font.weight.strong,
  letterSpacing: 1.0,
  color: tokens.color.textMute,
  textTransform: 'uppercase',
};
const row: React.CSSProperties = {
  fontSize: 10.5,
  color: tokens.color.textMute,
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
};
const mono: React.CSSProperties = {
  color: tokens.color.text,
  fontFamily: tokens.font.mono,
};
const check: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: tokens.font.weight.strong,
  color: tokens.color.text,
};
