/**
 * Design tokens for the soft / glass-pill UI.
 *
 * The reference aesthetic (see screenshots/refs in the project doc) is a
 * "raised glass" feel: each interactive surface is a white pill with
 *
 *   1. A faint cool-gray hairline border (~1.5 px @ #e6e8ee)
 *   2. A subtle vertical gradient (not a flat fill)
 *   3. A top inner highlight (`inset 0 1px 1px rgba(255,255,255,.85)`)
 *      that simulates light from above
 *   4. A multi-layered drop shadow that spreads far below — gives the
 *      "floating on cloth" quality
 *
 * Active / status states swap the white gradient for a coloured one,
 * pick up a tinted border, and gain a faint outer glow in the same hue.
 *
 * All colours are deliberately desaturated. Pure indigo (#6366f1) is
 * too loud for this language — the active blue here is closer to
 * "steel" (#5670a8) over a pale denim grad.
 */

/**
 * The two inner layers shared by every transmissive-shell surface.
 *
 * This is FLIPPED from the previous recipe, and the flip is the single
 * change that makes the language read as glass rather than as plastic.
 * The old inner stack was:
 *
 *     inset 0  2px 2px rgba(255,255,255,.85)   // white at the TOP
 *     inset 0 -1px .5px rgba(40,48,80,.07)     // dark at the BOTTOM
 *
 * i.e. an *opaque* object lit from above. A transparent shell behaves the
 * other way round — dark at the top (edge-on thickness) and white at the
 * bottom (light refracting out). Adding more edge layers on top of the old
 * orientation could never fix it; the orientation itself was the problem.
 *
 * Declared outside `tokens` because an object literal cannot reference its
 * own earlier keys.
 */
const SHELL_INNER = [
  'inset 0 1.5px 1.5px rgba(118,130,154,0.15)',
  'inset 0 -2px 2px rgba(255,255,255,0.95)',
].join(', ');

export const tokens = {
  color: {
    /** App canvas — bright neutral light gray. Bumped up for luminance
     *  while staying neutral (R=G=B) so it still avoids both blueish
     *  and beige. */
    bg: '#f8f8f8',
    /** Solid white card / pill background — used as the *base* fill;
     *  most interactive pills layer a vertical gradient on top of this. */
    surface: '#ffffff',
    /** Slightly darker than surface, for sunken inputs / progress tracks. */
    surfaceSoft: '#f1f1f1',
    /**
     * Surface outline. Transparent by design.
     *
     * The transmissive shell has no flat border: its edge is the ring drawn
     * by `.glass-edge`, whose colour changes around the perimeter (grey on
     * top, material hue at the sides, white underneath). A uniform 1 px
     * line sitting alongside that ring reads as a second, contradictory
     * edge — which is precisely why surfaces still carrying one looked
     * untouched after the shell landed.
     *
     * Kept as a token (rather than deleted) so the ~16 call sites that
     * write `1px solid ${tokens.color.border}` need no edit and simply stop
     * painting. Border width is preserved, so nothing reflows.
     */
    border: 'transparent',
    /** An actual drawn line — separators, progress tracks. NOT for outlining
     *  surfaces; use the `.glass-edge` ring for that. */
    hairline: '#dadada',

    /* Text is a neutral dark gray, NOT the old blue-purple steel (#2d3142).
     * The transmissive-shell edge is built from neutral gray (top) plus the
     * variant's own material hue (sides); a blue-purple body text would add
     * a third hue family and fight the edge. Mute/faint are neutralised in
     * step with it — shifting only `text` leaves secondary copy reading
     * visibly blue against neutral body text. */
    /** Body text — neutral dark gray. */
    text: '#3a3c40',
    /** Subtitle / secondary metadata. */
    textMute: '#6e7076',
    /** Faint placeholders / disabled. */
    textFaint: '#a1a3a9',

    /** Active accent — sky / water blue (水色). Hue pulled further toward
     *  cyan so the pill reads as "water" rather than "navy". */
    accent: '#3d8ec5',
    accentSoft: '#7cbae0',
    /*
     * The `*Border` values below are the flat, uniform version of what the
     * shell ring does around the sides of a surface. They are pointed at
     * the same rgba as `edge.side.*` so that surfaces which have not been
     * given a `.glass-edge` ring — chiefly the ~40 in DebugViewer — still
     * land in the same colour family instead of keeping the old hard
     * `#9bd0ed`-style hairline. A flat line is a weaker cue than the ring
     * (no variation top-to-bottom), but it is the same material.
     *
     * Anything migrated to `shellSurface()` ignores these entirely.
     */
    accentBorder: 'rgba(112,180,222,0.56)',

    /** Yellow-green (黄緑) — was a deeper sage; pulled toward lime so the
     *  green tag/pill reads "fresh" rather than "olive". */
    success: '#6a9d4a',
    successBorder: 'rgba(150,192,112,0.50)',
    processing: '#6e6ad0',
    processingBorder: 'rgba(148,142,222,0.54)',
    warn: '#a07a3e',
    warnBorder: 'rgba(206,166,100,0.50)',
    danger: '#b85454',
    dangerBorder: 'rgba(212,124,124,0.50)',
  },

  /**
   * Liquid-glass surfaces. Reference (the user-supplied screenshot) is
   * NOT heavy frosted glass — it's mostly opaque white with a faint
   * gradient. The "liquid" comes from the way **active** pills cast a
   * strong coloured outer glow, which combined with the subtle inner
   * highlights and slight translucency makes pills feel like luminous
   * lenses. So our `glass` surfaces stay fairly opaque (≥ 75 %) and
   * the heavy lifting is done by the `glow*` shadow stacks below.
   */
  glass: {
    /** Standard pill surface — mostly white with a hint of canvas
     *  showing through at the edges. */
    surface: 'rgba(255,255,255,0.78)',
    /** Slightly more opaque for content-heavy surfaces (cards, dialog). */
    surfaceStrong: 'rgba(255,255,255,0.88)',
    /** Tinted glass — used for the active / status pill backgrounds.
     *  Layered over the gradient.* fills via rgba so the colour reads
     *  even when subtly desaturated. */
    accent: 'rgba(214,225,243,0.78)',
    success: 'rgba(216,232,212,0.78)',
    processing: 'rgba(220,213,239,0.78)',
    danger: 'rgba(240,222,222,0.78)',
    /** Edge highlight — the bright thin border that catches light. */
    border: 'rgba(255,255,255,0.55)',
    borderTinted: 'rgba(255,255,255,0.45)',
  },

  /** Light backdrop blur — just enough to soften any text peeking
   *  through the translucent surface. Reference doesn't show heavy
   *  frosting, so we keep it subtle. */
  backdrop: 'blur(10px) saturate(120%)',

  /** Stronger blur used only where a translucent surface sits over real
   *  content (the 3D viewer). Saturation is pushed hard so the glass picks
   *  up colour from whatever is behind it. */
  backdropScene: 'blur(14px) saturate(175%)',

  /**
   * Background gradients. Pills aren't flat — they go very-slightly-lighter
   * at the top to slightly-darker at the bottom, simulating top-down light.
   */
  gradient: {
    /** White surface with a wider top-down gradient so the top edge
     *  reads as "lit" — boost from a near-flat #fff→#f8 to #fff→#f0
     *  for visible luminance. */
    surface: 'linear-gradient(180deg, #ffffff 0%, #f0f0f0 100%)',
    /** Active accent — water-blue / sky gradient. Cyan-leaning. */
    accent: 'linear-gradient(180deg, #ecf6fc 0%, #c8e1f1 100%)',
    /** Yellow-green / lime gradient — pale, fresh. */
    success: 'linear-gradient(180deg, #f2f7e2 0%, #dceac0 100%)',
    processing: 'linear-gradient(180deg, #ece9f7 0%, #d2cde9 100%)',
    warn: 'linear-gradient(180deg, #f7ede0 0%, #ecdcc0 100%)',
    danger: 'linear-gradient(180deg, #f5e4e4 0%, #e8c8c8 100%)',
    /** Water-blue as *glass* rather than as paint. The opaque `accent`
     *  above reads as a solid board once it sits on anything other than a
     *  flat light canvas — over the 3D viewer it stops belonging to the
     *  same material family as everything around it. Pair with
     *  `backdrop.accent`. */
    accentGlass: 'linear-gradient(180deg, rgba(226,243,253,0.46) 0%, rgba(150,205,238,0.60) 100%)',
    /** Track for sunken progress bars — neutral light gray. */
    track: 'linear-gradient(180deg, #ededed 0%, #f2f2f2 100%)',
    /** Filled portion of progress bar. */
    progress: 'linear-gradient(90deg, #b6cdf2 0%, #97b6e8 100%)',
    /** Neutral light gray — used by the project cards, header pill,
     *  and per-card action buttons. Both stops dialed up: #fcfcfc top
     *  (just below pure white) and #f1f1f1 bottom — only marginally
     *  darker than the #f8 canvas, so the surface reads as "lit pane"
     *  rather than "darker frame". */
    neutral: 'linear-gradient(180deg, #fcfcfc 0%, #f1f1f1 100%)',
  },

  /**
   * Transmissive-shell edge ("S1").
   * ------------------------------------------------------------------
   * A single 1.2 px ring drawn around each surface, whose colour varies
   * around the perimeter:
   *
   *     top    grey    — looking edge-on through the shell's thickness,
   *                      so it reads as shadow (same as a soap bubble's
   *                      upper rim). NOT a highlight.
   *     sides  hue     — the line of sight travels the longest path
   *                      through the material here, so the material's own
   *                      colour accumulates. Transmission, not reflection.
   *     bottom white   — light entering the top refracts out at the lower
   *                      rim and concentrates there (caustic).
   *
   * A `linear-gradient(180deg)` fed through a ring-shaped mask maps 0% to
   * the top edge, 50% to the left/right caps and 100% to the bottom edge,
   * so the whole three-part structure is one gradient.
   *
   * There is deliberately NO warm/orange fringe anywhere: the reference
   * material has none, and adding one reads as a fake reflection.
   */
  edge: {
    /** Ring thickness in px. Also the border-width each surface carries
     *  (with a transparent border-color) so the ring occupies the border
     *  band rather than eating into the padding box. */
    width: 1.2,
    top: 'rgba(142,151,170,0.46)',
    top2: 'rgba(170,179,196,0.24)',
    bot2: 'rgba(255,255,255,0.70)',
    bot: 'rgba(255,255,255,1)',
    /** Per-variant side colour — the material hue that accumulates on the
     *  left/right caps. */
    side: {
      plain: 'rgba(190,204,224,0.40)',
      neutral: 'rgba(190,204,224,0.34)',
      accent: 'rgba(112,180,222,0.56)',
      success: 'rgba(150,192,112,0.50)',
      processing: 'rgba(148,142,222,0.54)',
      warn: 'rgba(206,166,100,0.50)',
      danger: 'rgba(212,124,124,0.50)',
    },
  },

  /**
   * Shadow scale. Each entry is a *stack* — a tight contact shadow plus a
   * loose far-spread shadow, summed for the "floating on cloth" feel.
   *
   * Tints lean cool (rgba 40,48,80) so the shadow doesn't clash with
   * the cool-bias background.
   */
  shadow: {
    /** Resting elevation for cards and pills. */
    soft: [
      '0 1px 2px rgba(40,48,80,0.04)',
      '0 6px 16px rgba(40,48,80,0.06)',
      '0 20px 48px rgba(40,48,80,0.04)',
    ].join(', '),
    /** Hover / focus — lifts another step. */
    raised: [
      '0 2px 4px rgba(40,48,80,0.05)',
      '0 12px 28px rgba(40,48,80,0.08)',
      '0 32px 72px rgba(40,48,80,0.06)',
    ].join(', '),
    /** Top-side inner highlight — combine with another box-shadow stack
     *  via comma when needed (this one alone simulates the raised lit edge). */
    /** @deprecated Alias of `shellInner`. Was `inset 0 1px 1px white` — a
     *  highlight on the TOP edge, i.e. the opaque-object lighting the shell
     *  model replaces. Re-pointed so surfaces that still reference it pick
     *  up the correct orientation; prefer `shellInner` in new code. */
    innerHighlight: SHELL_INNER,
    /** Inset / sunken — for inputs and progress tracks. */
    inset: 'inset 0 1px 2px rgba(40,48,80,0.07)',
    /** Active / selected pill outer glow (steel-blue tint). */
    glowAccent: [
      'inset 0 1px 1px rgba(255,255,255,0.8)',
      '0 1px 2px rgba(86,112,168,0.10)',
      '0 4px 14px rgba(86,112,168,0.22)',
      '0 12px 32px rgba(86,112,168,0.10)',
    ].join(', '),
    glowSuccess: [
      'inset 0 1px 1px rgba(255,255,255,0.8)',
      '0 1px 2px rgba(93,139,93,0.10)',
      '0 4px 14px rgba(93,139,93,0.18)',
      '0 12px 32px rgba(93,139,93,0.08)',
    ].join(', '),
    glowProcessing: [
      'inset 0 1px 1px rgba(255,255,255,0.8)',
      '0 1px 2px rgba(110,106,208,0.10)',
      '0 4px 14px rgba(110,106,208,0.22)',
      '0 12px 32px rgba(110,106,208,0.10)',
    ].join(', '),
    /** Modal / dialog — deeper drop. */
    dialog: [
      '0 4px 12px rgba(40,48,80,0.08)',
      '0 32px 80px rgba(40,48,80,0.18)',
    ].join(', '),

    /** Liquid-glass elevation for plain (white) pills.
     *  Layer order (outermost → innermost effect):
     *  - outer drop shadows (3 stacked) for the floating cast
     *  - bottom inner refraction shadow
     *  - top inner specular highlight (wider band for stronger lit feel)
     *  - **inner light ring** — `inset 0 0 0 1.5px rgba(white)` — the
     *    "lens rim" that gives liquid-glass its characteristic
     *    double-edge. */
    glass: [
      SHELL_INNER,
      '0 1px 2px rgba(40,48,80,0.05)',
      '0 4px 14px rgba(40,48,80,0.07)',
      '0 16px 36px rgba(40,48,80,0.05)',
    ].join(', '),

    /** Active accent halo — water-blue glow. Cyan-leaning, pale. */
    glassAccent: [
      SHELL_INNER,
      '0 1px 2px rgba(61,142,197,0.06)',
      '0 4px 12px rgba(130,200,235,0.24)',
      '0 12px 28px rgba(130,200,235,0.14)',
    ].join(', '),
    /** Yellow-green / lime halo — subtle. */
    glassSuccess: [
      SHELL_INNER,
      '0 1px 2px rgba(106,157,74,0.06)',
      '0 4px 12px rgba(180,220,130,0.22)',
      '0 12px 28px rgba(180,220,130,0.14)',
    ].join(', '),
    glassProcessing: [
      SHELL_INNER,
      '0 1px 2px rgba(110,106,208,0.08)',
      '0 6px 16px rgba(170,160,228,0.30)',
      '0 16px 36px rgba(170,160,228,0.18)',
    ].join(', '),
    glassWarn: [
      SHELL_INNER,
      '0 1px 2px rgba(160,122,62,0.06)',
      '0 4px 12px rgba(226,196,146,0.26)',
      '0 12px 28px rgba(226,196,146,0.15)',
    ].join(', '),
    glassDanger: [
      SHELL_INNER,
      '0 1px 2px rgba(184,84,84,0.06)',
      '0 4px 12px rgba(226,164,164,0.26)',
      '0 12px 28px rgba(226,164,164,0.15)',
    ].join(', '),

    /** Exposed so surfaces that build their own outer stack (sunken inputs,
     *  progress tracks) can reuse the same shell orientation. */
    shellInner: SHELL_INNER,
  },

  radius: {
    /** Fully rounded. */
    pill: 999,
    /** Soft corner for cards / dialogs. */
    card: 24,
    /** Large surfaces wanting a softer-than-card corner. */
    lg: 28,
    /** Mid-size for sections. */
    md: 16,
    /** Inputs / small buttons. */
    sm: 10,
  },

  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },

  font: {
    family: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'Yu Gothic UI', system-ui, sans-serif",
    mono: 'ui-monospace, "SF Mono", Menlo, monospace',

    /* Four steps replacing the old ad-hoc 10.5 / 11.5 / 12.5 / 13.5 / 15
     * spread. Everything moved down roughly one notch; padding was NOT
     * reduced to match, so the whitespace-to-glyph ratio went up, which is
     * what actually reads as "refined". */
    size: { lg: 13, md: 11.5, sm: 10.5, xs: 9.5 },

    /* 400 across the board, down from a blanket 700.
     * Caveat: Segoe UI and Yu Gothic UI (the Windows fallbacks) ship
     * 300/350/400/600/700 and have NO 500 — CSS weight matching resolves a
     * requested 500 downwards to 400 there, so 500 and 400 render
     * identically on Windows. 400 is stated explicitly to avoid implying a
     * distinction the platform can't honour. */
    weight: { strong: 400, medium: 400 },

    /** Body tracking is tight; only all-caps/mono labels get the wide one. */
    tracking: { base: 0.2, label: 0.8 },
  },

  /** Icon stroke width. Kept in step with `font.weight` — a 1.6 px stroke
   *  next to 400-weight text reads as though the icons are bolder than the
   *  labels. */
  icon: { stroke: 1.35 },

  /** Standard easing — slightly slow-out so the lift feels weighted. */
  transition: '0.22s cubic-bezier(0.32, 0.72, 0.24, 1)',
} as const;

// ── Surface variants ──────────────────────────────────────────────

/** Every surface in the language is one of these. */
export type SurfaceVariant = keyof typeof tokens.edge.side;

/**
 * Fill per variant.
 *
 * `plain` and `neutral` are deliberately **undefined — i.e. no fill at
 * all**. In a transmissive-shell model a truly transparent surface takes
 * the colour of whatever is behind it, so the achromatic surfaces are
 * defined purely by the edge ring plus the drop shadow. Only the chromatic
 * variants carry a fill, because there the fill *is* the material colour.
 */
const SHELL_FILL: Record<SurfaceVariant, string | undefined> = {
  plain: undefined,
  neutral: undefined,
  accent: tokens.gradient.accent,
  success: tokens.gradient.success,
  processing: tokens.gradient.processing,
  warn: tokens.gradient.warn,
  danger: tokens.gradient.danger,
};

const SHELL_SHADOW: Record<SurfaceVariant, string> = {
  plain: tokens.shadow.glass,
  neutral: tokens.shadow.glass,
  accent: tokens.shadow.glassAccent,
  success: tokens.shadow.glassSuccess,
  processing: tokens.shadow.glassProcessing,
  warn: tokens.shadow.glassWarn,
  danger: tokens.shadow.glassDanger,
};

/** Hue the engraved text-shadow leans toward, per variant. */
const LETTERPRESS_RGB: Record<SurfaceVariant, string> = {
  plain: '96,104,120',
  neutral: '96,104,120',
  accent: '40,96,140',
  success: '74,110,52',
  processing: '74,68,150',
  warn: '122,90,40',
  danger: '140,60,60',
};

/**
 * Label colour per variant — the text carries the variant's own hue rather
 * than a single neutral. Each is darkened well past the raw accent token
 * so it stays legible on the pale fill (the raw hues sit around 2.6:1,
 * these land near 4:1).
 */
export const surfaceText: Record<SurfaceVariant, string> = {
  plain: tokens.color.text,
  neutral: tokens.color.text,
  accent: '#357fb2',
  success: '#5c8c3e',
  processing: '#6259bd',
  warn: '#966f30',
  danger: '#a94b4b',
};

// ── Composed style fragments ──────────────────────────────────────

/**
 * The ring gradient for a variant. 0% lands on the top edge, 50% on the
 * left/right caps, 100% on the bottom edge once the mask turns it into a
 * ring — see `tokens.edge`.
 */
export function edgeGradient(variant: SurfaceVariant): string {
  const side = tokens.edge.side[variant];
  return [
    `linear-gradient(180deg`,
    `${tokens.edge.top} 0%`,
    `${tokens.edge.top2} 16%`,
    `${side} 42%`,
    `${side} 58%`,
    `${tokens.edge.bot2} 82%`,
    `${tokens.edge.bot} 100%)`,
  ].join(', ');
}

/**
 * Engraved ("letterpress") text shadow.
 *
 * A groove cut into a surface lit from above has its upper wall in shadow
 * and its lower wall catching light — so the shadow goes ABOVE the glyph
 * and the highlight BELOW. That is the same light source as the edge ring
 * (top = shadow, bottom = white), which is why the two never contradict
 * each other.
 */
export function letterpress(variant: SurfaceVariant = 'plain'): string {
  return `0 -0.45px 0.45px rgba(${LETTERPRESS_RGB[variant]},0.19), 0 0.9px 0.5px rgba(255,255,255,0.97)`;
}

/**
 * Custom properties consumed by the `.glass-edge` rule in `index.css`.
 * The ring has to be a pseudo-element (a gradient can't be a border), and
 * pseudo-elements can't be expressed as inline style — so the geometry is
 * handed over as CSS variables and the rule itself lives in the stylesheet.
 */
export function edgeVars(variant: SurfaceVariant): React.CSSProperties {
  return {
    '--edge-grad': edgeGradient(variant),
    '--edge-w': `${tokens.edge.width}px`,
  } as React.CSSProperties;
}

/**
 * Complete surface recipe. Pair with `className="glass-edge"` — without
 * the class the ring is never drawn and the surface loses its outline.
 *
 * `borderColor` is transparent by design: the border band exists purely to
 * give the ring somewhere to sit, so the ring reads as the edge of the
 * object rather than as a second line inside a grey border.
 *
 * Border props stay long-hand. Mixing the `border` shorthand with variant
 * overrides that only set `borderColor` leaves React holding the previous
 * colour on the element across re-renders, which shows up as a stale
 * ring after a click.
 */
export function shellSurface(
  variant: SurfaceVariant = 'plain',
  opts: {
    radius?: number;
    onScene?: boolean;
    /**
     * Achromatic surfaces are transparent by default. Chrome that has to
     * occlude what sits behind it — side panels, overlays on the 3D view,
     * dialogs — passes `fill: 'surface'` to opt back into a solid plate
     * while keeping the same edge and shadow.
     */
    fill?: 'none' | 'surface' | 'neutral';
  } = {},
): React.CSSProperties {
  const { radius = tokens.radius.pill, onScene = false, fill: fillMode } = opts;
  const fill = onScene && variant === 'accent'
    ? tokens.gradient.accentGlass
    : fillMode === 'surface' ? tokens.gradient.surface
    : fillMode === 'neutral' ? tokens.gradient.neutral
    : fillMode === 'none' ? undefined
    : SHELL_FILL[variant];
  return {
    ...edgeVars(variant),
    ...(fill ? { backgroundImage: fill } : null),
    ...(onScene && variant === 'accent'
      ? { backdropFilter: tokens.backdropScene, WebkitBackdropFilter: tokens.backdropScene }
      : null),
    /* Zero width, not `tokens.edge.width`: the ring is drawn as a
     * pseudo-element at `inset: 0`, i.e. inside the padding box. A real
     * border would push it outside, and `Card` clips its children with
     * `overflow: hidden` — which clips to the padding box and would erase
     * the ring entirely. Long-hand is kept so a variant that only sets
     * `borderColor` can't leave a stale shorthand behind on re-render. */
    borderWidth: 0,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radius,
    boxShadow: SHELL_SHADOW[variant],
    color: surfaceText[variant],
    textShadow: letterpress(variant),
    fontFamily: tokens.font.family,
    transition: `box-shadow ${tokens.transition}, transform ${tokens.transition}, filter ${tokens.transition}`,
  };
}

/** Base pill surface. Kept as a const for the many call sites that spread it. */
export const pillSurface: React.CSSProperties = shellSurface('plain');

/**
 * Soft card surface — same language at non-pill radii.
 *
 * Filled, unlike a pill. This is the surface dialogs are built from, and a
 * dialog laid over the project grid with no fill leaves its own text sitting
 * on top of whatever is behind it.
 */
export const softCard: React.CSSProperties = {
  ...shellSurface('neutral', { radius: tokens.radius.card, fill: 'surface' }),
  overflow: 'hidden',
};
