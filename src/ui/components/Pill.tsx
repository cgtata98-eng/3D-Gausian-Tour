import { useState, type ReactNode, type CSSProperties } from 'react';
import { tokens } from '../design-tokens';

/**
 * Liquid-glass pill primitives. Re-used across every screen so colour /
 * shape / shadow stays consistent and a one-line tweak in `design-tokens.ts`
 * propagates everywhere.
 *
 * - {@link PillButton}  — variant-driven action pill (plain / accent /
 *   success / processing / danger / neutral).
 * - {@link PillToggle}  — segmented control. Outer translucent gutter,
 *   active inner segment glows.
 * - {@link Tag}         — mini pill for labels / tags.
 */

// ── Variants ──────────────────────────────────────────────────────

export type PillVariant = 'plain' | 'accent' | 'success' | 'processing' | 'danger' | 'neutral';

const VARIANT: Record<PillVariant, { base: CSSProperties; hover: CSSProperties; active: CSSProperties }> = {
  plain: {
    base: {
      background: tokens.gradient.surface,
      borderColor: tokens.color.border,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glass,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.02)' },
    active: { transform: 'translateY(0)', filter: 'brightness(0.98)' },
  },
  // Neutral light gray — the workhorse for secondary / per-card actions.
  // Matches the project card background so the actions feel embedded
  // rather than punched-through.
  neutral: {
    base: {
      background: tokens.gradient.neutral,
      borderColor: '#d8d8d8',
      color: tokens.color.text,
      boxShadow: tokens.shadow.glass,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.02)' },
    active: { transform: 'translateY(0)', filter: 'brightness(0.98)' },
  },
  accent: {
    base: {
      background: tokens.gradient.accent,
      borderColor: tokens.color.accentBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glassAccent,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.03) saturate(1.05)' },
    active: { transform: 'translateY(0)', filter: 'brightness(0.97)' },
  },
  success: {
    base: {
      background: tokens.gradient.success,
      borderColor: tokens.color.successBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glassSuccess,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.03)' },
    active: { transform: 'translateY(0)', filter: 'brightness(0.97)' },
  },
  processing: {
    base: {
      background: tokens.gradient.processing,
      borderColor: tokens.color.processingBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glassProcessing,
    },
    hover: { transform: 'translateY(-1px)' },
    active: { transform: 'translateY(0)' },
  },
  danger: {
    base: {
      background: tokens.gradient.danger,
      borderColor: tokens.color.dangerBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glass,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.03)' },
    active: { transform: 'translateY(0)' },
  },
};

const pillBaseStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  padding: '10px 18px',
  // Long-hand split — see same comment on `seg` above for the shadowing
  // bug that bites when shorthand `border` mixes with variant overlays
  // that only set `borderColor`.
  borderWidth: 1.5,
  borderStyle: 'solid',
  borderColor: 'transparent',
  borderRadius: tokens.radius.pill,
  fontSize: 12.5, fontWeight: 700, letterSpacing: 0.3,
  cursor: 'pointer', fontFamily: tokens.font.family,
  transition: `box-shadow ${tokens.transition}, transform ${tokens.transition}, filter ${tokens.transition}, background ${tokens.transition}`,
  flexShrink: 0,
  outline: 'none',
};

const disabledStyle: CSSProperties = {
  opacity: 0.45,
  cursor: 'not-allowed',
};

// ── PillButton ────────────────────────────────────────────────────

export function PillButton({
  variant = 'plain',
  onClick, disabled, title, children, fullWidth, style, type = 'button', size,
}: {
  variant?: PillVariant;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
  fullWidth?: boolean;
  style?: CSSProperties;
  type?: 'button' | 'submit';
  /** Compact (smaller padding / font) for dense UIs. */
  size?: 'compact' | 'default';
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const compact = size === 'compact'
    ? { padding: '7px 14px', fontSize: 11.5, gap: 6 }
    : null;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        ...pillBaseStyle,
        ...(compact ?? null),
        ...(fullWidth ? { flex: 1, minWidth: 0 } : null),
        ...VARIANT[variant].base,
        ...(hover && !disabled ? VARIANT[variant].hover : null),
        ...(active && !disabled ? VARIANT[variant].active : null),
        ...(disabled ? disabledStyle : null),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ── PillToggle (segmented control) ────────────────────────────────

export function PillToggle<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; sub?: string }[];
}) {
  return (
    <div style={pillToggleStyle.outer}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{ ...pillToggleStyle.seg, ...(active ? pillToggleStyle.segActive : null) }}
          >
            <span style={pillToggleStyle.title}>{o.title}</span>
            {o.sub && <span style={pillToggleStyle.sub}>{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

const pillToggleStyle: Record<string, CSSProperties> = {
  outer: {
    display: 'flex', gap: 4,
    padding: 5,
    background: tokens.glass.surfaceStrong,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
  },
  seg: {
    flex: 1,
    display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: 2,
    padding: '11px 16px',
    background: 'transparent',
    // Long-hand border props so the active overlay's `borderColor`
    // doesn't get shadowed by the shorthand on re-render. (React leaves
    // the previous color on the element when only the long-hand is
    // removed, which manifests as a black/blue ring after click.)
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    color: tokens.color.textMute,
    fontFamily: tokens.font.family,
    textAlign: 'left' as const,
    outline: 'none',
    transition: `background ${tokens.transition}, box-shadow ${tokens.transition}, color ${tokens.transition}, border-color ${tokens.transition}`,
  },
  segActive: {
    background: tokens.gradient.accent,
    borderColor: tokens.color.accentBorder,
    color: tokens.color.text,
    boxShadow: tokens.shadow.glassAccent,
  },
  title: { fontSize: 13.5, fontWeight: 700, letterSpacing: 0.3 },
  sub: { fontSize: 10.5, color: tokens.color.textFaint, fontWeight: 500 },
};

// ── Tag (mini pill) ──────────────────────────────────────────────

export type TagVariant = 'accent' | 'success' | 'processing' | 'warn' | 'danger' | 'neutral';

export function Tag({ variant, children, style }: { variant: TagVariant; children: ReactNode; style?: CSSProperties }) {
  const palette = {
    accent:     { bg: tokens.gradient.accent,     border: tokens.color.accentBorder },
    success:    { bg: tokens.gradient.success,    border: tokens.color.successBorder },
    processing: { bg: tokens.gradient.processing, border: tokens.color.processingBorder },
    warn:       { bg: tokens.gradient.warn,       border: tokens.color.warnBorder },
    danger:     { bg: tokens.gradient.danger,     border: tokens.color.dangerBorder },
    neutral:    { bg: tokens.gradient.neutral,    border: '#d8d8d8' },
  }[variant];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7,
      padding: '3px 11px',
      borderRadius: tokens.radius.pill,
      background: palette.bg,
      border: `1px solid ${palette.border}`,
      color: tokens.color.text,
      fontFamily: tokens.font.mono,
      boxShadow: 'inset 0 1px 0.5px rgba(255,255,255,0.9)',
      ...style,
    }}>{children}</span>
  );
}
