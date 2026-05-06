import { type CSSProperties, type InputHTMLAttributes, forwardRef } from 'react';
import { tokens } from '../design-tokens';

/**
 * Sunken pill input. The track gradient + inset shadow gives it the
 * "pressed-into-the-surface" feel that matches the design language of
 * cards / pills floating *up* via shadows.
 */
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> & {
  style?: CSSProperties;
};

export const PillInput = forwardRef<HTMLInputElement, Props>(function PillInput(
  { style, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      {...rest}
      style={{
        width: '100%', padding: '12px 16px',
        background: tokens.gradient.track,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.pill,
        color: tokens.color.text, fontSize: 13,
        outline: 'none', fontFamily: tokens.font.family,
        boxSizing: 'border-box',
        boxShadow: tokens.shadow.inset,
        transition: `border-color ${tokens.transition}, box-shadow ${tokens.transition}`,
        ...style,
      }}
    />
  );
});
