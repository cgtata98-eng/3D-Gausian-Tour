import { type ReactNode, type CSSProperties } from 'react';
import { surfaceClass, type PillVariant } from './Pill';

/**
 * Shell card — the framing element for grouped content (project tiles, dialog
 * bodies, panels).
 *
 * Class-only, like the pills: appearance lives in `design-system.css`.
 *
 * Unlike a pill, a card keeps a FILL. Transparency is right for a control on
 * the app canvas, where the surface genuinely takes the colour behind it. A
 * card is a container — routinely a dialog body laid over the project grid or
 * the 3D view — and there transparency puts its own text on top of whatever
 * is underneath. Being a shell does not mean being see-through in front of
 * arbitrary content.
 */
export function Card({
  tone = 'neutral',
  hoverable = false,
  onClick,
  children,
  style,
  className,
}: {
  tone?: 'surface' | 'neutral';
  hoverable?: boolean;
  onClick?: () => void;
  children: ReactNode;
  /** Layout only. */
  style?: CSSProperties;
  className?: string;
}) {
  const variant: PillVariant = tone === 'neutral' ? 'neutral' : 'plain';
  return (
    <div
      onClick={onClick}
      className={[
        surfaceClass(variant),
        'ds-card',
        tone === 'neutral' ? 'ds-fill-neutral' : 'ds-fill-surface',
        (hoverable || onClick) && 'ds-card--hoverable',
        className,
      ].filter(Boolean).join(' ')}
      style={style}
    >
      {children}
    </div>
  );
}

/** Rectangular grouping surface at a tighter radius — side panels, overlays. */
export function Panel({ variant = 'plain', filled = true, blur = false, children, style, className }: {
  variant?: PillVariant;
  /** Panels over the 3D view must stay filled or their text sits on the scene. */
  filled?: boolean;
  blur?: boolean;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={[
        surfaceClass(variant),
        'ds-panel',
        filled && 'ds-fill-surface',
        blur && 'ds-blur',
        className,
      ].filter(Boolean).join(' ')}
      style={style}
    >
      {children}
    </div>
  );
}
