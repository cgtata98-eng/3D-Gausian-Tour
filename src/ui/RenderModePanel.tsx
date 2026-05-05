import { useUIStore } from '../store/ui-store';
import { useSceneStore } from '../store/scene-store';
import { RENDER_PRESETS } from '../engine/render-presets';
import type { RenderMode } from '../engine/gsplat-loader';

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'sharp', label: 'Sharp' },
  { id: 'highq', label: 'High Quality' },
];

/**
 * Floating overlay panel for one-click render-quality presets. Currently not mounted
 * anywhere by default — kept for ad-hoc inclusion while comparing presets. Click writes
 * the full preset payload into `manifest.settings.render`; an effect in DebugViewer /
 * Viewer reacts to that change and re-applies via SceneManager.
 *
 * MSAA samples within a preset only take effect on the next reload (WebGL2 limitation).
 */
export function RenderModePanel() {
  const { renderMode, setRenderMode } = useUIStore();
  const apply = (id: RenderMode) => {
    setRenderMode(id);
    useSceneStore.getState().updateSettings({ render: { ...RENDER_PRESETS[id] } });
  };

  return (
    <div style={{
      position: 'absolute',
      top: '10px',
      left: '10px',
      display: 'flex',
      gap: '4px',
      padding: '6px 8px',
      background: 'rgba(0, 0, 0, 0.6)',
      borderRadius: '8px',
      backdropFilter: 'blur(10px)',
    }}>
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => apply(m.id)}
          style={{
            padding: '6px 12px',
            border: 'none',
            borderRadius: '6px',
            background: renderMode === m.id
              ? 'rgba(255, 255, 255, 0.3)'
              : 'rgba(255, 255, 255, 0.08)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: renderMode === m.id ? 'bold' : 'normal',
            transition: 'background 0.2s',
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
