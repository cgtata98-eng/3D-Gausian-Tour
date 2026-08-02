import { type CSSProperties, type InputHTMLAttributes, forwardRef } from 'react';

/**
 * Sunken input.
 *
 * Class-only. Note that `design-system.css` already styles bare `<input>`,
 * `<select>` and `<textarea>` at ELEMENT level — a native form control keeps
 * OS chrome until its appearance is taken over, so an unclassed one is always
 * visibly wrong rather than merely unstyled. This component exists for
 * explicitness at call sites, not because the class is required.
 *
 * The recess keeps the shell's light source (shadow above, light below) but
 * pushes the top shadow harder and casts nothing outward — a groove has no
 * outer rim to catch light.
 */
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> & {
  /** Layout only. */
  style?: CSSProperties;
};

export const PillInput = forwardRef<HTMLInputElement, Props>(function PillInput(
  { style, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      {...rest}
      className={['ds-input', className].filter(Boolean).join(' ')}
      style={style}
    />
  );
});
