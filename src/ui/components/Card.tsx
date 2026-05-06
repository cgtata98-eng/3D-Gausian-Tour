import { useState, type ReactNode, type CSSProperties } from 'react';
import { tokens } from '../design-tokens';

/**
 * Soft glass surface card. Used as the framing element for grouped content
 * (project tiles, dialog bodies, panels). Honours the same glass shadow /
 * border / gradient recipe as `<PillButton>` so cards and pills feel like
 * one design family.
 *
 *   tone="surface" — solid white-ish gradient (default)
 *   tone="neutral" — light gray gradient (matches `<PillButton variant="neutral">`)
 */
export function Card({
  tone = 'neutral',
  hoverable = false,
  onClick,
  children,
  style,
}: {
  tone?: 'surface' | 'neutral';
  hoverable?: boolean;
  onClick?: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const bg = tone === 'neutral' ? tokens.gradient.neutral : tokens.gradient.surface;
  const border = tone === 'neutral' ? '#d8d8d8' : tokens.color.border;
  return (
    <div
      onClick={onClick}
      onMouseEnter={hoverable ? () => setHover(true) : undefined}
      onMouseLeave={hoverable ? () => setHover(false) : undefined}
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: tokens.radius.card,
        boxShadow: hover ? tokens.shadow.raised : tokens.shadow.glass,
        overflow: 'hidden',
        transform: hover ? 'translateY(-2px)' : undefined,
        transition: `box-shadow ${tokens.transition}, transform ${tokens.transition}`,
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
