import { useUIStore } from '../store/ui-store';
import { useCameraStore } from '../store/camera-store';
import { surfaceClass } from './components';

/**
 * Floating dev overlay shown only when dev mode is on. Sits on top of the
 * 3D canvas, so the surface is an on-scene overlay — the underlying scene
 * shows through faintly without losing legibility.
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
    <div className={`${surfaceClass('plain')} ds-overlay`} style={panel}>
      <div className="ds-label">DEV MODE</div>

      <div className="ds-sub" style={row}>
        Pos: <span className="ds-mono">{position.map((v) => v.toFixed(2)).join(', ')}</span>
      </div>

      <label className="ds-check">
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
          />
          <div className="ds-mono ds-hint">Opacity: {collisionOpacity.toFixed(2)}</div>
        </div>
      )}

      <label className="ds-check">
        <input type="checkbox" checked={showDebugStats} onChange={toggleDebugStats} />
        Stats
      </label>
    </div>
  );
}

/** Layout only. */
const panel: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  padding: '12px 14px',
  minWidth: 200,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const row: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'baseline' };
