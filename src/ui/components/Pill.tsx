import { useRef, useState, useLayoutEffect, type ReactNode, type CSSProperties } from 'react';

/**
 * Pill primitives.
 *
 * These emit CLASS NAMES and nothing else — every visual decision lives in
 * `design-system.css`. There is deliberately no style object here: the old
 * arrangement required each call site to spread a style recipe *and* remember
 * a className for the edge ring, and forgetting either failed silently. One
 * class now carries surface, edge, type and motion together.
 *
 * `style` remains available for LAYOUT only (position, width, margin, grid
 * placement). Passing appearance through it forks the design system.
 */

export type PillVariant =
  | 'plain' | 'neutral' | 'accent' | 'success' | 'processing' | 'warn' | 'danger';

/** Classes shared by anything that is a shell surface. */
export function surfaceClass(variant: PillVariant = 'plain', extra?: string): string {
  return ['ds-surface', `ds-v-${variant}`, extra].filter(Boolean).join(' ');
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── PillButton ────────────────────────────────────────────────────

export function PillButton({
  variant = 'plain',
  onClick, disabled, title, children, fullWidth, style, type = 'button', size, onScene, className,
}: {
  variant?: PillVariant;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
  fullWidth?: boolean;
  /** Layout only — see the note at the top of this file. */
  style?: CSSProperties;
  type?: 'button' | 'submit';
  size?: 'compact' | 'default';
  /**
   * Set on surfaces over the 3D viewer: swaps the opaque accent fill for a
   * translucent one and turns on the backdrop blur. The opaque blue reads as
   * a solid board once there is real content behind it.
   */
  onScene?: boolean;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        surfaceClass(variant),
        'ds-pill',
        size === 'compact' && 'ds-pill--sm',
        fullWidth && 'ds-pill--block',
        onScene && 'ds-on-scene',
        className,
      )}
      style={style}
    >
      {children}
    </button>
  );
}

/** Circular icon-only button. */
export function IconButton({
  variant = 'plain', onClick, title, disabled, children, size, style, className,
}: {
  variant?: PillVariant;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  children: ReactNode;
  size?: 'compact' | 'default';
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cx(surfaceClass(variant), 'ds-pill', 'ds-pill--icon', size === 'compact' && 'ds-pill--sm', className)}
      style={style}
    >
      {children}
    </button>
  );
}

// ── Segmented control ─────────────────────────────────────────────

/**
 * Measures the active segment so the accent shell can be a single element
 * that slides between options, rather than a style applied to whichever
 * button happens to be active. Without the slide, switching is an instant
 * swap and the control reads as separate buttons instead of one selection.
 *
 * Re-measures via ResizeObserver: the geometry comes from laid-out text and
 * is not final on first paint (web fonts, locale, container width).
 */
function useSegIndicator(activeKey: string) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const el = track.querySelector<HTMLElement>('[data-active="true"]');
      if (!el) return;
      setRect((prev) =>
        prev && prev.x === el.offsetLeft && prev.w === el.offsetWidth
          ? prev
          : { x: el.offsetLeft, w: el.offsetWidth },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    Array.from(track.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [activeKey]);

  return { trackRef, rect };
}

function SegIndicator({ rect, onScene }: { rect: { x: number; w: number } | null; onScene?: boolean }) {
  if (!rect) return null;
  return (
    <span
      aria-hidden
      className={cx(surfaceClass('accent'), 'ds-seg__ind', onScene && 'ds-on-scene')}
      /* No padding compensation. `left: 0` on an absolutely-positioned child
         resolves against the track's PADDING box, and `offsetLeft` is measured
         from the same origin — subtracting the padding shifted the indicator
         5px left of its button, which reads as the label sitting off-centre
         to the right. */
      style={{ width: rect.w, transform: `translateX(${rect.x}px)` }}
    />
  );
}

/** Label-only segmented control (移動モード / 画質 / ヘッドトラッキング …). */
export function SegmentedControl<T extends string>({ value, onChange, options, onScene, style, className }: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; disabled?: boolean; title?: string }[];
  onScene?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const { trackRef, rect } = useSegIndicator(value);
  return (
    <div ref={trackRef} className={cx(surfaceClass('plain'), 'ds-seg', 'ds-blur', className)} style={style}>
      <SegIndicator rect={rect} onScene={onScene} />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          data-active={o.id === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.id)}
          className="ds-seg__btn"
        >{o.label}</button>
      ))}
    </div>
  );
}

/** Two-line segmented control (title + sub-label). */
export function PillToggle<T extends string>({ value, onChange, options, onScene, style }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; sub?: string; disabled?: boolean; disabledReason?: string }[];
  onScene?: boolean;
  style?: CSSProperties;
}) {
  const { trackRef, rect } = useSegIndicator(value);
  return (
    <div ref={trackRef} className={cx(surfaceClass('plain'), 'ds-seg', 'ds-blur')} style={style}>
      <SegIndicator rect={rect} onScene={onScene} />
      {options.map((o) => {
        const active = o.value === value;
        const disabled = !!o.disabled && !active;
        return (
          <button
            key={o.value}
            type="button"
            data-active={active}
            disabled={disabled}
            title={disabled ? o.disabledReason : undefined}
            onClick={() => { if (!disabled) onChange(o.value); }}
            className="ds-seg__btn ds-seg__btn--stacked"
          >
            <span className="ds-seg__title">{o.title}</span>
            {o.sub && <span className="ds-seg__sub">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ── Tag / badge ───────────────────────────────────────────────────

export type TagVariant = PillVariant;

export function Tag({ variant, children, style, className }: {
  variant: TagVariant;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span className={cx(surfaceClass(variant), 'ds-tag', className)} style={style}>{children}</span>
  );
}

export function Badge({ variant = 'plain', children, size, style, className }: {
  variant?: PillVariant;
  children?: ReactNode;
  size?: 'sm' | 'lg';
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span
      className={cx(surfaceClass(variant), 'ds-badge', size === 'sm' && 'ds-badge--sm', size === 'lg' && 'ds-badge--lg', className)}
      style={style}
    >{children}</span>
  );
}
