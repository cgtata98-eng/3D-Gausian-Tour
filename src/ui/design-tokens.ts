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
    /** Hairline — neutral, just a touch darker than bg. */
    border: '#dadada',

    /** Steel-deep, used for body text. */
    text: '#2d3142',
    /** Subtitle / secondary metadata. */
    textMute: '#6b7280',
    /** Faint placeholders / disabled. */
    textFaint: '#9ca3af',

    /** Active accent — sky / water blue (水色). Hue pulled further toward
     *  cyan so the pill reads as "water" rather than "navy". */
    accent: '#3d8ec5',
    accentSoft: '#7cbae0',
    /** Borders are deliberately on the saturated side of the pill bg —
     *  they define the lens rim and need a hair more contrast than a
     *  hairline gray would give. */
    accentBorder: '#9bd0ed',

    /** Yellow-green (黄緑) — was a deeper sage; pulled toward lime so the
     *  green tag/pill reads "fresh" rather than "olive". */
    success: '#6a9d4a',
    successBorder: '#b8d088',
    processing: '#6e6ad0',
    processingBorder: '#aea8d3',
    warn: '#a07a3e',
    warnBorder: '#d6b986',
    danger: '#b85454',
    dangerBorder: '#d4a8a8',
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
    innerHighlight: 'inset 0 1px 1px rgba(255,255,255,0.85)',
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
      'inset 0 0 0 1.5px rgba(255,255,255,0.7)',
      'inset 0 2px 2px rgba(255,255,255,0.85)',
      'inset 0 -1px 0.5px rgba(40,48,80,0.07)',
      '0 1px 2px rgba(40,48,80,0.05)',
      '0 4px 14px rgba(40,48,80,0.07)',
      '0 16px 36px rgba(40,48,80,0.05)',
    ].join(', '),

    /** Active accent halo — water-blue glow. Cyan-leaning, pale. */
    glassAccent: [
      'inset 0 0 0 1.5px rgba(255,255,255,0.6)',
      'inset 0 1px 0.5px rgba(255,255,255,0.92)',
      'inset 0 -1px 0.5px rgba(61,142,197,0.12)',
      '0 1px 2px rgba(61,142,197,0.06)',
      '0 4px 12px rgba(130,200,235,0.24)',
      '0 12px 28px rgba(130,200,235,0.14)',
    ].join(', '),
    /** Yellow-green / lime halo — subtle. */
    glassSuccess: [
      'inset 0 0 0 1.5px rgba(255,255,255,0.6)',
      'inset 0 1px 0.5px rgba(255,255,255,0.92)',
      'inset 0 -1px 0.5px rgba(106,157,74,0.12)',
      '0 1px 2px rgba(106,157,74,0.06)',
      '0 4px 12px rgba(180,220,130,0.22)',
      '0 12px 28px rgba(180,220,130,0.14)',
    ].join(', '),
    glassProcessing: [
      'inset 0 0 0 1.5px rgba(255,255,255,0.6)',
      'inset 0 1px 0.5px rgba(255,255,255,0.92)',
      'inset 0 -1px 0.5px rgba(110,106,208,0.18)',
      '0 1px 2px rgba(110,106,208,0.12)',
      '0 6px 16px rgba(170,160,228,0.42)',
      '0 16px 36px rgba(170,160,228,0.26)',
      '0 36px 64px rgba(170,160,228,0.14)',
    ].join(', '),
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
    family: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif",
    mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  },

  /** Standard easing — slightly slow-out so the lift feels weighted. */
  transition: '0.22s cubic-bezier(0.32, 0.72, 0.24, 1)',
} as const;

// ── Composed style fragments ──────────────────────────────────────

/**
 * The base "glass pill" style — apply, then override colour/gradient
 * for state variants. Always pair `border` + `boxShadow` (the
 * `innerHighlight` is what makes the pill feel lit from above).
 */
export const pillSurface: React.CSSProperties = {
  background: tokens.gradient.surface,
  border: `1.5px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.pill,
  boxShadow: `${tokens.shadow.innerHighlight}, ${tokens.shadow.soft}`,
  transition: `box-shadow ${tokens.transition}, transform ${tokens.transition}, background ${tokens.transition}`,
  fontFamily: tokens.font.family,
};

/** Soft card surface — same language at non-pill radii. */
export const softCard: React.CSSProperties = {
  background: tokens.gradient.surface,
  border: `1.5px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.card,
  boxShadow: `${tokens.shadow.innerHighlight}, ${tokens.shadow.soft}`,
  overflow: 'hidden',
  transition: `box-shadow ${tokens.transition}, transform ${tokens.transition}`,
};
