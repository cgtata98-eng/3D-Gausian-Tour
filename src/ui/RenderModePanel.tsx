import { useUIStore } from '../store/ui-store';
import { useSceneStore } from '../store/scene-store';
import { RENDER_PRESETS } from '../engine/render-presets';
import type { RenderMode } from '../engine/gsplat-loader';
import { tokens, shellSurface } from './design-tokens';

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
    <div className="glass-edge" style={panel}>
      {MODES.map((m) => {
        const active = renderMode === m.id;
        return (
          <button
            key={m.id}
            onClick={() => apply(m.id)}
            className={active ? 'glass-edge' : undefined}
            style={{ ...seg, ...(active ? segActive : null) }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  display: 'flex',
  gap: 4,
  padding: 5,
  background: tokens.glass.surfaceStrong,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  ...shellSurface('plain'),
  zIndex: 5,
};

const seg: React.CSSProperties = {
  padding: '7px 15px',
  borderWidth: 0,
  borderStyle: 'solid',
  borderColor: 'transparent',
  borderRadius: tokens.radius.pill,
  backgroundColor: 'transparent',
  backgroundImage: 'none',
  color: tokens.color.textMute,
  cursor: 'pointer',
  fontSize: tokens.font.size.sm,
  fontWeight: tokens.font.weight.strong,
  fontFamily: tokens.font.family,
  outline: 'none',
  transition: `background ${tokens.transition}, color ${tokens.transition}, box-shadow ${tokens.transition}`,
};

const segActive: React.CSSProperties = shellSurface('accent');
