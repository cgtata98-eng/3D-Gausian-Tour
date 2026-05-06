import { useState } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useCameraStore } from '../store/camera-store';
import { tokens } from './design-tokens';

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
    <div style={panel}>
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
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  boxShadow: tokens.shadow.glass,
  zIndex: 5,
  maxWidth: 'calc(100vw - 48px)',
  overflowX: 'auto',
  fontFamily: tokens.font.family,
};

const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  width: 104,
  padding: 6,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  background: tokens.gradient.surface,
  color: tokens.color.text,
  cursor: 'pointer',
  fontFamily: tokens.font.family,
  flex: '0 0 auto',
  outline: 'none',
  transition: `background ${tokens.transition}, border-color ${tokens.transition}, box-shadow ${tokens.transition}, transform ${tokens.transition}`,
};

const cardHover: React.CSSProperties = {
  transform: 'translateY(-1px)',
  boxShadow: tokens.shadow.glass,
};

const cardActive: React.CSSProperties = {
  background: tokens.gradient.accent,
  borderColor: tokens.color.accentBorder,
  boxShadow: tokens.shadow.glassAccent,
};

const thumbWrap: React.CSSProperties = {
  width: '100%',
  aspectRatio: '4 / 3',
  borderRadius: tokens.radius.sm,
  overflow: 'hidden',
  background: tokens.color.surfaceSoft,
  border: `1px solid ${tokens.color.border}`,
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
  fontSize: 12,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: 0.3,
  color: tokens.color.text,
};

const labelActive: React.CSSProperties = {
  fontWeight: 700,
};
