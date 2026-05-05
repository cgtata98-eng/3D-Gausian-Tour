import { useUIStore } from '../store/ui-store';
import { useCameraStore } from '../store/camera-store';

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
    <div style={{
      position: 'absolute',
      top: '10px',
      right: '10px',
      padding: '12px',
      background: 'rgba(0, 0, 0, 0.7)',
      borderRadius: '8px',
      color: '#fff',
      fontSize: '12px',
      minWidth: '180px',
      backdropFilter: 'blur(10px)',
    }}>
      <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#fff' }}>
        DEV MODE
      </div>

      <div style={{ marginBottom: '6px' }}>
        Pos: {position.map((v) => v.toFixed(2)).join(', ')}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', cursor: 'pointer' }}>
        <input type="checkbox" checked={showCollision} onChange={toggleCollision} />
        Collision
      </label>

      {showCollision && (
        <div style={{ marginBottom: '6px', paddingLeft: '20px' }}>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={collisionOpacity}
            onChange={(e) => setCollisionOpacity(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
          <span>Opacity: {collisionOpacity.toFixed(2)}</span>
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
        <input type="checkbox" checked={showDebugStats} onChange={toggleDebugStats} />
        Stats
      </label>
    </div>
  );
}
