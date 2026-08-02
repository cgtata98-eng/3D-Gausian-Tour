/**
 * The design system's public surface.
 *
 * Screens should import from here and describe WHAT a thing is, never how it
 * looks. Appearance lives entirely in `ui/design-system.css`; these components
 * only emit class names.
 *
 * If a screen needs a surface these primitives don't cover, compose it with
 * `surfaceClass(variant)` plus a layout class — do not hand-roll background /
 * border / boxShadow inline. That is what previously left half the app
 * looking like the old design after the tokens had already moved: a style
 * object built on top of the tokens silently keeps its own appearance.
 */
export { PillButton, IconButton, PillToggle, SegmentedControl, Tag, Badge, surfaceClass } from './Pill';
export type { PillVariant, TagVariant } from './Pill';
export { Card, Panel } from './Card';
export { Block, Chip, Tile } from './Block';
export { IconClose, IconEdit, IconLink, IconCheck, IconTrash, IconPlus, IconSettings } from './Icon';
export { PillInput } from './Input';

/**
 * JS mirror of the token values, for the places that genuinely need them in
 * script (canvas painting, computed inline geometry). Styling should go
 * through the CSS classes instead.
 */
export { tokens } from '../design-tokens';
