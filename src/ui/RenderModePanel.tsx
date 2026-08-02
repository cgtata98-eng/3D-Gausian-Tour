import { useUIStore } from '../store/ui-store';
import { useSceneStore } from '../store/scene-store';
import { RENDER_PRESETS } from '../engine/render-presets';
import type { RenderMode } from '../engine/gsplat-loader';
import { SegmentedControl } from './components';

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

  // This panel WAS a segmented control re-implemented by hand — a track, three
  // buttons and an accent recipe on the active one. The shared control also
  // slides its indicator instead of hard-swapping the fill, which is the part
  // a re-implementation always loses.
  return (
    <SegmentedControl
      value={renderMode}
      onChange={apply}
      options={MODES}
      onScene
      style={{ position: 'absolute', top: 12, left: 12, zIndex: 5 }}
    />
  );
}
