import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';

interface ViewpointPanelProps {
  onViewpointClick: (id: string) => void;
}

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
    <div style={panel}>
      {viewpoints.map((vp) => {
        const active = activeViewpoint === vp.id;
        // Manual (Plan.thumbnails) wins over the auto capture for this plan.
        const thumb = planThumbs[vp.id] ?? autoThumbs[vp.id];
        return (
          <button
            key={vp.id}
            onClick={() => onViewpointClick(vp.id)}
            style={{ ...card, ...(active ? cardActive : null) }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.55)'; }}
          >
            <div style={thumbWrap}>
              {thumb ? (
                <img src={thumb} alt="" style={thumbImg} />
              ) : (
                <div style={thumbPlaceholder}>…</div>
              )}
            </div>
            <span style={{ ...label, ...(active ? labelActive : null) }}>{vp.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const panel: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 6,
  padding: 8,
  // Translucent white panel — 視点 list with subtle backdrop see-through.
  background: 'rgba(255, 255, 255, 0.78)',
  border: '1px solid rgba(0,0,0,0.06)',
  borderRadius: 14,
  backdropFilter: 'blur(16px)',
  boxShadow: '0 8px 32px rgba(15,23,42,0.1)',
  zIndex: 5,
  maxWidth: 'calc(100vw - 48px)',
  overflowX: 'auto',
};

const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  width: 104,
  padding: 6,
  border: '1px solid rgba(0,0,0,0.06)',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.55)',
  color: 'rgba(31,41,55,0.85)',
  cursor: 'pointer',
  transition: 'background 0.15s, border-color 0.15s',
  fontFamily: 'inherit',
  flex: '0 0 auto',
};

const cardActive: React.CSSProperties = {
  background: 'rgba(59,130,246,0.14)',
  borderColor: 'rgba(59,130,246,0.5)',
};

const thumbWrap: React.CSSProperties = {
  width: '100%',
  aspectRatio: '4 / 3',
  borderRadius: 6,
  overflow: 'hidden',
  background: 'rgba(0,0,0,0.06)',
  border: '1px solid rgba(0,0,0,0.06)',
};

const thumbImg: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const thumbPlaceholder: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(31,41,55,0.35)',
  fontSize: 12,
};

const label: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: 0.3,
  color: 'rgba(31,41,55,0.78)',
};

const labelActive: React.CSSProperties = {
  color: '#1d4ed8',
  fontWeight: 600,
};
