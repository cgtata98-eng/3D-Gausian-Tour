import { type ReactNode, type CSSProperties } from 'react';
import { surfaceClass, type PillVariant } from './Pill';

/**
 * Side-panel building blocks.
 *
 * These exist so the panels stop re-deriving the same three shapes. LeftPanel
 * alone had eight icon-button recipes, two chip recipes and three section
 * containers — near-duplicates that look interchangeable until one of them is
 * edited and the others quietly fall behind.
 *
 * As with the rest of the system these emit class names only; `style` is for
 * layout.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** A titled group inside a side panel. */
export function Block({ title, action, children, filled = true, style, className }: {
  title?: ReactNode;
  /** Trailing control on the heading row — a close or collapse button. */
  action?: ReactNode;
  children?: ReactNode;
  filled?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={cx(surfaceClass('neutral'), 'ds-block', filled && 'ds-fill-neutral', className)} style={style}>
      {(title || action) && (
        <div className="ds-block__head">
          {title && <span className="ds-block__title">{title}</span>}
          <div style={{ flex: 1 }} />
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * A small pill that toggles.
 *
 * Not a `Tag`: a tag reports state, a chip changes it. The distinction
 * matters for hover — a chip is interactive and lifts, a tag does not.
 */
export function Chip({ active, onClick, swatch, children, title, disabled, style }: {
  active?: boolean;
  onClick?: () => void;
  /** Colour dot shown before the label — the colour-preset variant. */
  swatch?: string;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const variant: PillVariant = active ? 'accent' : 'plain';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      data-active={!!active}
      className={cx(surfaceClass(variant), 'ds-chip', !active && 'ds-fill-surface')}
      style={style}
    >
      {swatch && <span className="ds-chip__swatch" style={{ background: swatch }} />}
      {children}
    </button>
  );
}

/** A selectable thumbnail — viewpoints, plans, AI variants. */
export function Tile({ active, onClick, thumb, label, placeholder, title, style }: {
  active?: boolean;
  onClick?: () => void;
  thumb?: string;
  label: ReactNode;
  /** Shown when there is no thumbnail yet. */
  placeholder?: ReactNode;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-active={!!active}
      className={cx(surfaceClass(active ? 'accent' : 'plain'), 'ds-tile', !active && 'ds-fill-surface')}
      style={style}
    >
      <span className="ds-tile__thumb">
        {thumb ? <img src={thumb} alt="" /> : placeholder}
      </span>
      <span className="ds-tile__label">{label}</span>
    </button>
  );
}
