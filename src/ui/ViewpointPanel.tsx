import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { surfaceClass, Tile } from './components';

interface ViewpointPanelProps {
  onViewpointClick: (id: string) => void;
}

/**
 * Floating viewpoint thumbnail strip — bottom-center of the viewer canvas.
 *
 * The strip is an on-scene overlay and each entry is a `Tile`; both were
 * previously re-implemented here as local style objects, down to a hand-rolled
 * hover lift that the shell already provides.
 */
export function ViewpointPanel({ onViewpointClick }: ViewpointPanelProps) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const thumbs = useSceneStore((s) => s.viewpointThumbnails);
  const activeViewpoint = useCameraStore((s) => s.activeViewpoint);

  if (!manifest) return null;
  const activePlan = manifest.plans?.find((p) => p.id === activePlanId);
  const viewpoints = activePlan?.viewpoints ?? [];
  if (viewpoints.length === 0) return null;
  const planThumbs = activePlan?.thumbnails ?? {};
  const autoThumbs = (activePlanId && thumbs[activePlanId]) || {};

  return (
    <div className={`${surfaceClass('plain')} ds-overlay ds-overlay--lg`} style={panel}>
      {viewpoints.map((vp) => (
        <Tile
          key={vp.id}
          label={vp.label}
          thumb={planThumbs[vp.id] ?? autoThumbs[vp.id]}
          placeholder={<span className="ds-sub">…</span>}
          active={activeViewpoint === vp.id}
          onClick={() => onViewpointClick(vp.id)}
          style={{ width: 104, flex: '0 0 auto' }}
        />
      ))}
    </div>
  );
}

/** Layout only — see the note at the top of `components/Pill.tsx`. */
const panel: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 6,
  padding: 8,
  zIndex: 5,
  maxWidth: 'calc(100vw - 48px)',
  overflowX: 'auto',
};
