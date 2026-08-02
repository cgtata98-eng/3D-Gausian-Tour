import { useState } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { tokens, shellSurface } from './design-tokens';

interface ViewpointPanelProps {
  onViewpointClick: (id: string) => void;
}

/**
 * Floating viewpoint thumbnail strip — bottom-center of the viewer canvas.
 * Glass pill panel with mini cards inside; active card uses the accent
 * gradient + glow recipe to match the rest of the design system.
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
    <div className="glass-edge" style={panel}>
      {viewpoints.map((vp) => (
        <ViewpointCard
          key={vp.id}
          label={vp.label}
          thumb={planThumbs[vp.id] ?? autoThumbs[vp.id]}
          active={activeViewpoint === vp.id}
          onClick={() => onViewpointClick(vp.id)}
        />
      ))}
    </div>
  );
}

function ViewpointCard({ label, thumb, active, onClick }: {
  label: string;
  thumb?: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="glass-edge"
      style={{
        ...card,
        ...(active ? cardActive : null),
        ...(hover && !active ? cardHover : null),
      }}
    >
      <div style={thumbWrap}>
        {thumb ? <img src={thumb} alt="" style={thumbImg} /> : <div style={thumbPlaceholder}>…</div>}
      </div>
      <span style={{ ...labelStyle, ...(active ? labelActive : null) }}>{label}</span>
    </button>
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
  background: tokens.glass.surfaceStrong,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  ...shellSurface('plain', { radius: tokens.radius.lg }),
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
  ...shellSurface('plain', { radius: tokens.radius.md, fill: 'surface' }),
  cursor: 'pointer',
  flex: '0 0 auto',
  outline: 'none',
};

const cardHover: React.CSSProperties = {
  transform: 'translateY(-1px)',
  boxShadow: `${tokens.shadow.shellInner}, ${tokens.shadow.raised}`,
};

const cardActive: React.CSSProperties = shellSurface('accent', { radius: tokens.radius.md });

const thumbWrap: React.CSSProperties = {
  width: '100%',
  aspectRatio: '4 / 3',
  borderRadius: tokens.radius.sm,
  overflow: 'hidden',
  background: tokens.color.surfaceSoft,
  boxShadow: tokens.shadow.shellInner,
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
  color: tokens.color.textFaint,
  fontSize: 11.5,
};

const labelStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: tokens.font.weight.strong,
  letterSpacing: 0.3,
  color: tokens.color.text,
};

const labelActive: React.CSSProperties = {
  fontWeight: tokens.font.weight.strong,
};
